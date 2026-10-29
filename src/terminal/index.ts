import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { AssistantEntry, ConversationBusy } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryRecord,
  LiveState,
  UsageState,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, ModelThinkingLevel } from "@earendil-works/pi-ai";

const MAX_PENDING_INPUTS = 64;
const MAX_ACTIVE_COMMANDS = 16;
const MAX_ADMITTED_LINE_CODE_UNITS = 32_000;
const MAX_RESPONSE_CHARS = 64_000;
const MAX_HISTORY_COUNT = 50;
const DEFAULT_HISTORY_COUNT = 10;
const HISTORY_TEXT_CHARS = 200;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_ENTRY_LIMIT = 2_000;
const MAX_REMEMBERED_ANSWERS = 256;
const MAX_REMEMBERED_LOCAL_INPUTS = 1_024;
const MAX_EXTERNAL_RUNS = 64;
const MAX_STATUS_QUEUE_SCAN = 2_000;
const MAX_MESSAGE_BLOCK_SCAN = 2_048;
const LITERAL_SLASH_PREFIX = "//";

export interface TerminalModelChoice {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export interface TerminalModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

export interface TerminalModelSelectionHost {
  list(): Promise<{ models: readonly TerminalModelChoice[]; selected: TerminalModelSelection }>;
  select(selection: { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel }): Promise<TerminalModelSelection>;
}

export interface TerminalToolGrant {
  readonly name: string;
  readonly expiresAt: number;
}

/**
 * Optional host-owned coding-tool policy. The ceiling is the fixed host allowlist; grants are always
 * explicit, finite and conversation-scoped. Without this host the local tool commands stay read-only.
 */
export interface TerminalToolGrantsHost {
  readonly ceiling: readonly string[];
  list(): Promise<readonly TerminalToolGrant[]>;
  grant(names: readonly string[], expiresAt: number): Promise<readonly TerminalToolGrant[]>;
  revoke(names: readonly string[]): Promise<readonly TerminalToolGrant[]>;
}

/** Optional host-owned workspace-context refresh for the current conversation. */
export interface TerminalContextRefreshHost {
  /** False when the gateway has no configured context snapshot provider. */
  readonly available: boolean;
  /** Re-capture this conversation's host snapshot; resolves with its skill count. */
  refresh(): Promise<{ readonly skills: number }>;
}

export interface TerminalIO {
  /** Each item is a completed line; the source owns any memory bound before yielding it. */
  readonly input: AsyncIterable<string>;
  readonly output: Writable;
  readonly errorOutput?: Writable;
  /** Called before input and after each line, allowing a readline host to show its prompt. */
  readonly prompt?: () => void;
  /** Close an input source that supports prompt cancellation (for example readline.Interface). */
  readonly closeInput?: () => void;
  /** Optional host-owned model policy; standalone terminal callers remain read-only without it. */
  readonly modelSelection?: TerminalModelSelectionHost;
  /** Optional host-owned coding-tool grants; standalone terminal callers remain read-only without it. */
  readonly toolGrants?: TerminalToolGrantsHost;
  /** Optional host-owned workspace-context refresh; standalone callers leave /refresh unavailable. */
  readonly contextRefresh?: TerminalContextRefreshHost;
}

type InboxView = { items?: readonly { mode?: string }[] };
type RunView = { taskId: number; inputs: readonly number[] };
type NativeSubmission = Awaited<ReturnType<Conversation["submit"]>>;
type SettledSubmission = Awaited<ReturnType<NativeSubmission["wait"]>>;
type LocalSubmission = { id: number; submission: NativeSubmission; runTaskId?: number; finalized?: boolean };
type GenerationOutput = {
  attempt: number;
  streamed: string;
  truncated: boolean;
  desynchronized: boolean;
  active: boolean;
  openLine: boolean;
  /** Final entry reconciled; suppress older committed snapshots still queued behind output backpressure. */
  finalized: boolean;
};
type RunOutput = { generation?: GenerationOutput };
type ExternalRun = {
  /** First input of one logical run; it survives post-tool and onYield generation handovers. */
  readonly rootInput: number;
  /** Current generation task that owns the run and will write its final answer. */
  taskId: number;
};

/** Observe one existing Durable conversation and present its committed model text in a local terminal. */
export async function runTerminalConversation(
  conversation: Conversation,
  context: Context,
  io: TerminalIO,
): Promise<void> {
  const operationController = new AbortController();
  const operationContext = withAbortSignal(operationController.signal, context);
  const observerController = new AbortController();
  const observerContext = withAbortSignal(observerController.signal, operationContext);
  const signal = operationContext.abortSignal;
  const observerSignal = observerContext.abortSignal;
  const watch = await conversation.watch(observerContext);
  const submissions = new Map<number, LocalSubmission>();
  const runOutputs = new Map<number, RunOutput>();
  const answerIds = new Set<number>();
  const answerOrder: number[] = [];
  /** Every input this terminal admitted, so a run with no local input is classified as external. */
  const localInputIds = new Set<number>();
  const localInputOrder: number[] = [];
  /** Runs admitted by another host path, with no local Submission to wait on. */
  const externalRuns = new Map<number, ExternalRun>();
  const watchCallbacks = new Set<Promise<void>>();
  const waits = new Set<Promise<void>>();
  const commands = new Set<Promise<void>>();
  let reservedInputs = 0;
  let activeCommands = 0;
  let unansweredObserved = false;
  let admissionTail: Promise<void> = Promise.resolve();
  let outputTail: Promise<void> = Promise.resolve();
  let renderTail: Promise<void> = Promise.resolve();
  let outputFailure: unknown;

  const serializeRender = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = renderTail.then(operation);
    renderTail = task.then(() => undefined, () => undefined);
    return task;
  };

  const closeInput = () => {
    try { io.closeInput?.(); } catch { /* the owning CLI still closes the gateway */ }
  };
  const onOutputError = (error: Error): void => {
    outputFailure ??= error;
    operationController.abort(error);
    closeInput();
  };
  const outputStreams = new Set([io.output, ...(io.errorOutput === undefined ? [] : [io.errorOutput])]);
  for (const stream of outputStreams) stream.on("error", onOutputError);

  const write = (text: string, toError = false): Promise<void> => {
    const cleaned = sanitizeTerminalText(text);
    if (!cleaned) return Promise.resolve();
    const target = toError ? (io.errorOutput ?? io.output) : io.output;
    const operation = outputTail.then(async () => {
      if (outputFailure !== undefined) throw outputFailure;
      if (!target.write(cleaned)) await waitForDrain(target, signal);
    });
    outputTail = operation.catch((error: unknown) => {
      if (!signal?.aborted) outputFailure ??= error;
      if (!operationController.signal.aborted) operationController.abort(error);
      closeInput();
    });
    return operation;
  };

  const endOpenLines = async (): Promise<void> => {
    for (const state of runOutputs.values()) {
      if (state.generation?.openLine) {
        state.generation.openLine = false;
        await write("\n");
      }
    }
  };

  const rawNotice = async (text: string, toError = false): Promise<void> => {
    await endOpenLines();
    await write(`${text}\n`, toError);
  };
  const notice = (text: string, toError = false): Promise<void> =>
    serializeRender(() => rawNotice(text, toError));

  const rememberAnswer = (id: number): boolean => {
    if (answerIds.has(id)) return false;
    answerIds.add(id);
    answerOrder.push(id);
    while (answerOrder.length > MAX_REMEMBERED_ANSWERS) {
      const oldest = answerOrder.shift();
      if (oldest !== undefined) answerIds.delete(oldest);
    }
    return true;
  };

  const rememberLocalInput = (id: number): void => {
    localInputIds.add(id);
    localInputOrder.push(id);
    while (localInputOrder.length > MAX_REMEMBERED_LOCAL_INPUTS) {
      const oldest = localInputOrder.shift();
      if (oldest !== undefined) localInputIds.delete(oldest);
    }
  };

  const latestExternalAnswer = (
    entries: readonly EntryRecord[],
    taskId: number,
  ): EntryRecord | undefined => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (AssistantEntry.is(entry) && entry.byTaskId === taskId) return entry;
    }
    return undefined;
  };

  /**
   * A run admitted by another host path (for example a scheduled origin-mode cron turn) has no local
   * Submission to wait on. Print its committed final answer once when the run ends, and never replay
   * an already-completed run at startup. Attribution uses the generation task that wrote the answer,
   * so an immediate successor run in the same commit cannot steal or suppress the previous answer.
   * Live partials stay local-submission-only so this terminal never renders a revision it cannot
   * reconcile against a settlement.
   */
  const finalizeExternalRun = async (
    view: ConversationView,
    external: ExternalRun,
  ): Promise<void> => {
    const answer = latestExternalAnswer(view.entries, external.taskId);
    if (answer === undefined) {
      await rawNotice(
        "A turn admitted before or outside this terminal ended without an attributable assistant reply; use /history to inspect the conversation.",
        true,
      );
      return;
    }
    if (!rememberAnswer(answer.id)) return;
    const message = answer.model?.[0];
    const stopReason = message?.role === "assistant" ? message.stopReason : undefined;
    const finalText = sanitizeTerminalText(assistantText(message as AssistantMessage));
    if (stopReason === "error" || stopReason === "aborted") {
      await rawNotice(
        `A turn admitted before or outside this terminal ended ${stopReason === "error" ? "with a model error" : "after being aborted"}; use /history to inspect it.`,
        true,
      );
    } else if (stopReason === "toolUse") {
      await rawNotice(
        "A turn admitted before or outside this terminal ended without a final text answer; use /history to inspect it.",
        true,
      );
    } else if (finalText.length === 0) {
      await rawNotice(
        "A turn admitted before or outside this terminal ended with no text; use /history to inspect it.",
        true,
      );
    } else {
      await rawNotice(limitResponse(finalText));
    }
  };

  const dropExternalRunFor = (inputs: readonly number[]): void => {
    for (const [key, external] of [...externalRuns]) {
      if (inputs.includes(external.rootInput)) externalRuns.delete(key);
    }
  };

  /**
   * Track external runs by their first input and current generation task, not by `live.run.taskId`
   * alone. That task changes during tool rounds and onYield handovers, and Durable can end one run
   * and start its queued successor in one commit, so waiting for an idle frame would merge or lose
   * adjacent answers. A frame showing different input IDs finalizes the previous run before the new
   * one is classified.
   */
  const reconcileExternalRuns = async (
    view: ConversationView,
    run: RunView | undefined,
  ): Promise<void> => {
    const currentInputs = run?.inputs ?? [];
    for (const [key, external] of [...externalRuns]) {
      const stillCurrent = currentInputs.includes(external.rootInput);
      if (run === undefined || !stillCurrent) {
        externalRuns.delete(key);
        await finalizeExternalRun(view, external);
        continue;
      }
      // A local input joined this run (or a local admission was observed late): local settlement
      // owns the answer and partial rendering for the whole run.
      if (currentInputs.some((id) => localInputIds.has(id))) {
        externalRuns.delete(key);
        continue;
      }
      external.taskId = run.taskId;
    }
    if (run === undefined || currentInputs.length === 0) return;
    if (currentInputs.some((id) => localInputIds.has(id))) return;
    if ([...externalRuns.values()].some((external) => currentInputs.includes(external.rootInput))) return;
    if (externalRuns.size >= MAX_EXTERNAL_RUNS) {
      const oldest = externalRuns.keys().next().value;
      if (oldest !== undefined) externalRuns.delete(oldest);
      await rawNotice("External run tracking limit reached; use /history to inspect earlier turns.", true);
    }
    externalRuns.set(currentInputs[0]!, {
      rootInput: currentInputs[0]!,
      taskId: run.taskId,
    });
  };

  const responseState = (taskId: number): GenerationOutput => {
    const run = runOutputs.get(taskId) ?? {};
    if (run.generation === undefined) {
      run.generation = {
        attempt: -1,
        streamed: "",
        truncated: false,
        desynchronized: false,
        active: false,
        openLine: false,
        finalized: false,
      };
      runOutputs.set(taskId, run);
    }
    return run.generation;
  };

  const streamView = async (view: ConversationView): Promise<void> => {
    const live = view.docs["pi.live"] as unknown as LiveState | undefined;
    const run = live?.run as RunView | undefined;
    if (run === undefined) {
      // Keep the final streamed line open until the submission receipt is reconciled below.
      for (const state of runOutputs.values()) if (state.generation?.active) state.generation.active = false;
      await reconcileExternalRuns(view, undefined);
      return;
    }
    await reconcileExternalRuns(view, run);
    // Delayed watch snapshots may predate the settled assistant entry reconciled below.
    if (runOutputs.get(run.taskId)?.generation?.finalized) return;

    const ownedInputs = run.inputs.filter((id) => {
      const submission = submissions.get(id);
      return submission !== undefined && !submission.finalized;
    });
    if (ownedInputs.length === 0) {
      for (const state of runOutputs.values()) {
        if (state.generation?.active) {
          state.generation.active = false;
          if (state.generation.openLine) {
            state.generation.openLine = false;
            await write("\n");
          }
        }
      }
      return;
    }

    for (const [taskId, previous] of runOutputs) {
      if (taskId !== run.taskId && previous.generation?.active) {
        previous.generation.active = false;
        const pendingForRun = [...submissions.values()].some((submission) => submission.runTaskId === taskId);
        if (previous.generation.openLine && !pendingForRun) {
          previous.generation.openLine = false;
          await write("\n");
        }
      }
    }
    for (const id of ownedInputs) submissions.get(id)!.runTaskId = run.taskId;
    // A watch frame can arrive before the local admission promise records its ID. If this run turns
    // out to own a local input after all, local settlement owns its answer and partial rendering.
    dropExternalRunFor(run.inputs);
    const state = responseState(run.taskId);
    const generation = live?.generation;
    if (state.finalized && (generation === undefined || state.attempt === generation.attempt)) return;
    if (generation === undefined) {
      if (state.active) {
        state.active = false;
        if (state.openLine) {
          state.openLine = false;
          await write("\n");
        }
      }
      return;
    }

    if (!state.active || state.attempt !== generation.attempt) {
      if (state.openLine) {
        state.openLine = false;
        await write("\n");
      }
      state.attempt = generation.attempt;
      state.streamed = "";
      state.truncated = false;
      state.desynchronized = false;
      state.finalized = false;
      state.active = true;
    }

    const partial = generation.message as AssistantMessage | undefined;
    const current = sanitizePartialText(assistantText(partial));
    if (!current || state.desynchronized || state.truncated || current === state.streamed) return;
    if (!current.startsWith(state.streamed)) {
      // A committed partial can be revised by a provider. Never duplicate or leak a replacement over prior output.
      state.desynchronized = true;
      return;
    }

    const delta = current.slice(state.streamed.length);
    const remaining = Math.max(0, MAX_RESPONSE_CHARS - state.streamed.length);
    const limitExceeded = delta.length > remaining;
    const shown = completePrefix(delta, remaining);
    if (shown) {
      if (!state.openLine) state.openLine = true;
      await write(shown);
      state.streamed += shown;
      state.openLine = !shown.endsWith("\n");
    }
    if (limitExceeded) {
      state.truncated = true;
      await rawNotice("[Live response output limit reached.]", true);
    }
  };

  watch.start(async (view) => {
    const callback = serializeRender(() => streamView(view));
    watchCallbacks.add(callback);
    try {
      await callback;
    } finally {
      watchCallbacks.delete(callback);
    }
  });

  const cleanupRun = (taskId: number | undefined): void => {
    if (taskId === undefined) return;
    if (![...submissions.values()].some((submission) => submission.runTaskId === taskId)) runOutputs.delete(taskId);
  };

  const finishSubmission = async (submissionId: number, settled: SettledSubmission): Promise<void> => {
    if (settled.status === "done" && settled.type === "input") {
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), operationContext);
      const message = entry?.model?.[0] as AssistantMessage | undefined;
      const finalText = sanitizeTerminalText(assistantText(message));
      await serializeRender(async () => {
        const local = submissions.get(submissionId);
        const taskId = local?.runTaskId;
        const generation = taskId === undefined ? undefined : runOutputs.get(taskId)?.generation;
        if (local) local.finalized = true;
        if (taskId !== undefined) {
          for (const pending of submissions.values()) {
            if (pending.runTaskId === taskId) pending.finalized = true;
          }
        }
        if (generation) {
          generation.finalized = true;
          generation.active = false;
        }
        if (!rememberAnswer(settled.answer)) return;

        if (finalText.length === 0) {
          if (generation?.streamed.length === 0) await rawNotice("The assistant returned no text response.");
          else await rawNotice("[The committed assistant entry had no text; the streamed partial was not a final answer.]", true);
        } else if (generation === undefined || generation.streamed.length === 0) {
          await rawNotice(limitResponse(finalText));
        } else if (finalText.startsWith(generation.streamed)) {
          const suffix = finalText.slice(generation.streamed.length);
          const remaining = Math.max(0, MAX_RESPONSE_CHARS - generation.streamed.length);
          const shown = completePrefix(suffix, remaining);
          if (shown) {
            if (!generation.openLine && !generation.streamed.endsWith("\n")) await write("\n");
            await write(shown);
            generation.streamed += shown;
            generation.openLine = !shown.endsWith("\n");
          }
          if (suffix.length > shown.length || generation.truncated) {
            await rawNotice("[Final response truncated by the terminal output limit.]", true);
          } else if (generation.openLine) {
            generation.openLine = false;
            await write("\n");
          }
        } else if (generation.streamed.startsWith(finalText)) {
          if (generation.openLine) {
            generation.openLine = false;
            await write("\n");
          }
          await rawNotice(`[Committed answer was shorter than the streamed text${generation.truncated ? "; output limit reached" : ""}; use /history to inspect it.]`, true);
        } else {
          // The terminal cannot retract committed partial text. Flush only the changed suffix, not the shared prefix.
          let shared = 0;
          while (shared < finalText.length && shared < generation.streamed.length && finalText[shared] === generation.streamed[shared]) shared++;
          if (shared > 0 && shared < finalText.length && isHighSurrogate(finalText.charCodeAt(shared - 1)) && isLowSurrogate(finalText.charCodeAt(shared))) shared--;
          const remaining = Math.max(0, MAX_RESPONSE_CHARS - generation.streamed.length);
          const remainder = completePrefix(finalText.slice(shared), remaining);
          const truncated = shared + remainder.length < finalText.length;
          await rawNotice(`[Committed answer differed after ${shared} shared characters; final remainder: ${remainder || "(empty)"}${truncated ? "; output limit reached, use /history for the full entry" : ""}.]`, true);
        }
      });
    } else if (settled.status === "unanswered") {
      if (settled.reason !== "aborted") unansweredObserved = true;
      await notice(`Turn ended: ${safeReason(settled.reason)}`, true);
    }
  };

  const waitForSubmission = (id: number, submission: Awaited<ReturnType<Conversation["submit"]>>): void => {
    let task!: Promise<void>;
    task = submission.wait(observerContext)
      .then((settled) => finishSubmission(id, settled))
      .catch(async (error: unknown) => {
        if (!signal?.aborted && !observerSignal?.aborted) {
          await notice(`Could not observe turn completion (${errorName(error)}).`, true);
        }
      })
      .finally(async () => {
        await serializeRender(async () => {
          const local = submissions.get(id);
          submissions.delete(id);
          reservedInputs = Math.max(0, reservedInputs - 1);
          cleanupRun(local?.runTaskId);
        });
        waits.delete(task);
      });
    waits.add(task);
  };

  const queueInput = (content: string): Promise<void> => {
    if (reservedInputs >= MAX_PENDING_INPUTS) {
      return notice(`Input limit reached (${MAX_PENDING_INPUTS} unsettled submissions). Wait for a turn or use /abort.`, true);
    }
    reservedInputs++;
    const operation = admissionTail.then(async () => {
      if (signal?.aborted) throw signal.reason;
      const submission = await conversation.submit(
        { type: "input", content },
        operationContext,
      );
      submissions.set(submission.id, { id: submission.id, submission });
      rememberLocalInput(submission.id);
      waitForSubmission(submission.id, submission);
    });
    admissionTail = operation.catch(async (error: unknown) => {
      reservedInputs = Math.max(0, reservedInputs - 1);
      if (!signal?.aborted) await notice(`Input was not admitted (${errorName(error)}).`, true);
    });
    return Promise.resolve();
  };

  const showHistory = async (rawCount: string): Promise<void> => {
    let count = DEFAULT_HISTORY_COUNT;
    if (rawCount.trim()) {
      if (!/^\d+$/.test(rawCount.trim())) {
        await notice("Usage: /history [count] — choose a number from 1 to 50.", true);
        return;
      }
      count = Math.max(1, Math.min(Number(rawCount.trim()), MAX_HISTORY_COUNT));
    }

    const messages: string[] = [];
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const limit = Math.min(HISTORY_PAGE_SIZE, HISTORY_ENTRY_LIMIT - scanned);
      if (limit <= 0) break;
      const page = await conversation.entries({ order: "descending" }, limit, cursor, operationContext);
      scanned += page.items.length;
      for (const entry of page.items) {
        for (let index = (entry.model?.length ?? 0) - 1; index >= 0; index--) {
          const message = entry.model![index]!;
          const formatted = formatHistoryMessage(message);
          if (formatted !== undefined) messages.push(formatted);
          if (messages.length >= count) break;
        }
        if (messages.length >= count) break;
      }
      cursor = page.next;
    } while (cursor !== undefined && messages.length < count && scanned < HISTORY_ENTRY_LIMIT);

    if (messages.length === 0) {
      await notice("No conversation history yet.");
      return;
    }
    messages.reverse();
    const capped = cursor !== undefined && scanned >= HISTORY_ENTRY_LIMIT && messages.length < count;
    await notice(`Last ${messages.length} text message(s):\n${messages.join("\n")}${capped ? "\n[History scan capped.]" : ""}`);
  };

  const showModel = async (args: string): Promise<void> => {
    const host = io.modelSelection;
    if (!host) {
      const agent = await conversation.agent(operationContext);
      const model = modelLabel(agent.model);
      await notice(args.trim()
        ? `Model changes are host-controlled and unavailable here. Current model: ${model}.`
        : `Current model: ${model}.`);
      return;
    }

    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length === 0) {
      const listing = await host.list();
      const maxChoices = 50;
      const rows = listing.models.slice(0, maxChoices).map((choice) => {
        const selected = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
        const levels = choice.thinkingLevels.map((level) => safeLabel(level, 32)).join(", ");
        return `  ${selected ? "* " : "  "}${safeLabel(choice.provider, 80)} ${safeLabel(choice.modelId, 160)} — ${safeLabel(choice.name, 160)} [thinking: ${levels || "off"}]`;
      });
      if (listing.models.length > maxChoices) rows.push(`  … ${listing.models.length - maxChoices} more allowed models omitted`);
      await notice([
        `Current model: ${modelLabel(listing.selected)} (thinking: ${safeLabel(listing.selected.thinkingLevel, 32)}).`,
        "Allowed models (use /model <provider> <modelId> [thinkingLevel]):",
        ...rows,
      ].join("\n"));
      return;
    }
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) {
      await notice("Usage: /model <provider> <modelId> [thinkingLevel]. Use /model to list allowed choices.", true);
      return;
    }
    const selection = { provider: parts[0]!, modelId: parts[1]!, ...(parts[2] === undefined ? {} : { thinkingLevel: parts[2]! as ModelThinkingLevel }) };
    try {
      const selected = await host.select(selection);
      await notice(`Selected model: ${modelLabel(selected)} (thinking: ${safeLabel(selected.thinkingLevel, 32)}).`);
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Model selection rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Model selection rejected: choice is invalid or unavailable. Use /model to list allowed choices.", true);
      }
    }
  };

  const refreshContext = async (args: string): Promise<void> => {
    if (args.trim()) { await notice("Usage: /refresh", true); return; }
    const host = io.contextRefresh;
    if (!host || !host.available) {
      await notice("Workspace context is not configured; /refresh is unavailable. Set workspaceContext in the config and restart.", true);
      return;
    }
    let skills: number;
    try {
      ({ skills } = await host.refresh());
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Context refresh rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Context refresh failed; the previous snapshot is still in effect.", true);
      }
      return;
    }
    await notice([
      `Workspace context refreshed for this conversation: ${skills} skill(s) in the on-demand table.`,
      "The refreshed summary and skill table apply to the next model request; skill bodies remain on demand.",
    ].join("\n"));
  };

  const showTools = async (args: string): Promise<void> => {
    if (args.trim()) { await notice("Usage: /tools", true); return; }
    const host = io.toolGrants;
    if (!host) {
      await notice("Coding-tool grants are host-controlled and unavailable here.", true);
      return;
    }
    if (host.ceiling.length === 0) {
      await notice([
        "Coding tools: disabled. The host ceiling (config toolAllowlist) is empty, so no grant is accepted.",
        "Add the intended names to toolAllowlist and restart; the ceiling still grants nothing by itself.",
      ].join("\n"));
      return;
    }
    let grants: readonly TerminalToolGrant[];
    try {
      grants = await host.list();
    } catch { await notice("Could not read coding-tool grants.", true); return; }
    const granted = new Map(grants.map((grant) => [grant.name, grant.expiresAt]));
    const rows: string[] = [];
    let grantedCount = 0;
    for (const name of host.ceiling) {
      const expiresAt = granted.get(name);
      const label = safeLabel(name, 40);
      if (expiresAt === undefined) {
        rows.push(`  ${label} — not granted`);
      } else {
        grantedCount++;
        rows.push(`  ${label} — expires ${formatGrantExpiry(expiresAt, Date.now())}`);
      }
    }
    await notice([
      `Coding tools for this conversation: ${grantedCount} of ${host.ceiling.length} granted.`,
      ...rows,
      "Grants are per conversation, explicit and finite. Use /grant <tool[,tool]> <duration> or /revoke <tool[,tool]|all>.",
    ].join("\n"));
  };

  const grantTools = async (args: string): Promise<void> => {
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length !== 2) {
      await notice("Usage: /grant <tool[,tool]> <duration> — duration is required, for example /grant read,bash 30m.", true);
      return;
    }
    const names = splitToolNames(parts[0]!);
    if (names === undefined) {
      await notice("Grant names must be a comma-separated list of tool names.", true);
      return;
    }
    const durationMs = parseGrantDuration(parts[1]!);
    if (durationMs === undefined) {
      await notice("Grant duration must be a finite value with a unit, for example 30s, 15m or 2h.", true);
      return;
    }
    const host = io.toolGrants;
    if (!host) {
      await notice("Coding-tool grants are host-controlled and unavailable here.", true);
      return;
    }
    if (host.ceiling.length === 0) {
      await notice("Coding tools are disabled: set config toolAllowlist to the intended tools and restart.", true);
      return;
    }
    const outside = names.filter((name) => !host.ceiling.includes(name));
    if (outside.length > 0) {
      await notice(`Outside the host tool ceiling: ${outside.join(", ")}. Ceiling: ${host.ceiling.join(", ")}.`, true);
      return;
    }
    const expiresAt = Date.now() + durationMs;
    let active: readonly TerminalToolGrant[];
    try {
      active = await host.grant(names, expiresAt);
    } catch { await notice("Grant failed; check /tools before retrying.", true); return; }
    const granted = new Set(active.map((grant) => grant.name));
    const applied = names.filter((name) => granted.has(name));
    await notice([
      applied.length === 0
        ? "No grant was applied."
        : `Granted for this conversation until ${formatGrantExpiry(expiresAt, Date.now())}: ${applied.join(", ")}.`,
      "The next model request may offer these tools; a request already in progress keeps its current tool list.",
    ].join("\n"));
  };

  const revokeTools = async (args: string): Promise<void> => {
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length !== 1) {
      await notice("Usage: /revoke <tool[,tool]|all>", true);
      return;
    }
    const host = io.toolGrants;
    if (!host) {
      await notice("Coding-tool grants are host-controlled and unavailable here.", true);
      return;
    }
    if (host.ceiling.length === 0) {
      await notice("Coding tools are disabled; this conversation holds no grants.", true);
      return;
    }
    let names: readonly string[];
    if (parts[0] === "all") {
      let active: readonly TerminalToolGrant[];
      try {
        active = await host.list();
      } catch { await notice("Could not read coding-tool grants.", true); return; }
      names = active.map((grant) => grant.name);
      if (names.length === 0) { await notice("No active grants to revoke."); return; }
    } else {
      const parsed = splitToolNames(parts[0]!);
      if (parsed === undefined) {
        await notice("Revoke names must be a comma-separated list of tool names, or all.", true);
        return;
      }
      const outside = parsed.filter((name) => !host.ceiling.includes(name));
      if (outside.length > 0) {
        await notice(`Outside the host tool ceiling: ${outside.join(", ")}. Nothing was revoked.`, true);
        return;
      }
      names = parsed;
    }
    try {
      await host.revoke(names);
    } catch { await notice("Revocation failed; check /tools for the current grants.", true); return; }
    await notice(`Revoked for this conversation: ${names.join(", ")}.`);
  };

  const showStatus = async (): Promise<void> => {
    const agent = await conversation.agent(operationContext);
    const viewState = await conversation.viewState(operationContext);
    let lines: string[];
    try {
      const view = viewState.value;
      const live = view.docs["pi.live"] as unknown as LiveState | undefined;
      const inbox = view.docs["pi.inbox"] as unknown as InboxView | undefined;
      const usage = view.docs["pi.usage"] as unknown as UsageState | undefined;
      const queued = inbox?.items ?? [];
      const modeCounts = { steer: 0, followUp: 0, write: 0 };
      const scanned = Math.min(queued.length, MAX_STATUS_QUEUE_SCAN);
      for (let index = 0; index < scanned; index++) {
        const mode = queued[index]!.mode;
        if (mode === "steer" || mode === "followUp" || mode === "write") modeCounts[mode]++;
      }
      const queueSummary = `steer=${modeCounts.steer} followUp=${modeCounts.followUp} write=${modeCounts.write}`;
      const queueNote = queued.length > scanned ? ` (mode counts first ${scanned})` : "";
      const run = live?.run;
      const taskSummary = run === undefined
        ? "idle"
        : `busy (run task ${run.taskId}, ${run.inputs.length} input(s)${live?.generation ? `, generation attempt ${live.generation.attempt}` : ""})`;
      const tools = live?.tools ?? [];
      const toolsScanned = Math.min(tools.length, MAX_STATUS_QUEUE_SCAN);
      let runningTools = 0;
      let pendingTools = 0;
      for (let index = 0; index < toolsScanned; index++) {
        if (tools[index]!.status === "running") runningTools++;
        else if (tools[index]!.status === "pending") pendingTools++;
      }
      const toolsNote = tools.length > toolsScanned ? ` (first ${toolsScanned})` : "";
      const compactions = live?.compactions?.length ?? 0;
      lines = [
        `Model: ${modelLabel(agent.model)}`,
        `Run: ${taskSummary}`,
        `Native inbox: ${queued.length} queued (${queueSummary}${queueNote}); model tools running=${runningTools} pending=${pendingTools}${toolsNote}; compactions=${compactions}`,
        ...formatUsage(usage),
        "Provider-side charges or usage not recorded by Durable: unknown (not inferred as zero).",
      ];
    } finally { viewState.dispose(); }
    await notice(lines.join("\n"));
  };

  const runCommand = async (name: string, args: string): Promise<void> => {
    switch (name) {
      case "help":
        await notice([
          "Local commands: /help /status /history [count] /model [provider modelId [thinkingLevel]] /tools /grant <tool[,tool]> <duration> /revoke <tool[,tool]|all> /refresh /compact /abort /new",
          "Unknown slash commands are not sent to the model. Prefix a prompt with // to send one literal leading slash.",
          "/abort uses native Durable semantics: it cancels foreground work and withdraws queued inputs.",
          io.modelSelection ? "/model lists the host allowlist; select with /model <provider> <modelId> [thinkingLevel]." : "/model is read-only without a host model-selection callback.",
          io.toolGrants ? "/grant needs an explicit finite duration (for example /grant read,bash 30m); /tools lists ceiling and grants." : "Coding-tool grants are host-controlled and unavailable here.",
          io.contextRefresh?.available ? "/refresh re-reads workspace context and skills for this conversation when it is idle." : "/refresh is unavailable without configured workspace context.",
        ].join("\n"));
        return;
      case "status":
        if (args.trim()) { await notice("Usage: /status", true); return; }
        await showStatus();
        return;
      case "history":
        await showHistory(args);
        return;
      case "model":
        await showModel(args);
        return;
      case "tools":
        await showTools(args);
        return;
      case "refresh":
        await refreshContext(args);
        return;
      case "grant":
        await grantTools(args);
        return;
      case "revoke":
        await revokeTools(args);
        return;
      case "compact": {
        if (args.trim()) { await notice("Usage: /compact", true); return; }
        const taskId = await conversation.compact(undefined, operationContext);
        await notice(`Native compaction task ${taskId} admitted. Summary placement follows Durable conversation boundaries.`);
        return;
      }
      case "abort":
        if (args.trim()) { await notice("Usage: /abort", true); return; }
        await conversation.abort(operationContext);
        await notice("Native Durable conversation abort completed; queued inputs were withdrawn. This does not implement Python sustained-goal abort.");
        return;
      case "new":
        if (args.trim()) { await notice("Usage: /new", true); return; }
        await conversation.reset(undefined, operationContext);
        await notice("Native Durable context reset admitted for this same conversation: no handoff, summary or extra model call, earlier entries stay stored and listed by /history, and tool grants are unchanged. While busy it lands at the next safe boundary; queued inputs placed with it run in the new context.");
        return;
      default:
        if (name === "stop") {
          await notice("/stop is unsupported: it is not aliased to native /abort, which withdraws queued inputs.", true);
        } else if (name === "restart") {
          await notice("/restart is unsupported: process restart belongs to the deployment owner.", true);
        } else if (name === "steer" || name === "after") {
          await notice(`/${name} was removed from this CLI; the line was not sent to the model.`, true);
        } else if (["goal", "interrupt", "btw", "skill", "policy", "receipt", "tasks", "task", "dream", "dream-log", "dream-restore", "remember", "pairing"].includes(name)) {
          await notice(`/${name} is not implemented in this CLI; it was not sent to the model.`, true);
        } else {
          const safeName = completePrefix(name, 80);
          await notice(`Unsupported slash command /${safeName}; it was not sent. Use //${safeName} to send it literally.`, true);
        }
    }
  };

  const localCommand = (name: string, args: string): Promise<void> => {
    if (activeCommands >= MAX_ACTIVE_COMMANDS) {
      return notice(`Local command limit reached (${MAX_ACTIVE_COMMANDS} active controls).`, true);
    }
    activeCommands++;
    let task!: Promise<void>;
    task = admissionTail.then(() => runCommand(name, args))
      .catch(async (error: unknown) => {
        if (!signal?.aborted) await notice(`/${completePrefix(name, 80)} failed (${errorName(error)}).`, true);
      })
      .finally(() => {
        activeCommands--;
        commands.delete(task);
      });
    commands.add(task);
    admissionTail = task.catch(() => undefined);
    return Promise.resolve();
  };

  const onAbort = (): void => closeInput();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) closeInput();
  let inputEnded = false;

  try {
    io.prompt?.();
    for await (const line of io.input) {
      if (signal?.aborted) break;
      // This bounds admitted content after the source yields a complete line, not its ingress buffer.
      if (line.length > MAX_ADMITTED_LINE_CODE_UNITS) {
        await notice(`Input exceeds the ${MAX_ADMITTED_LINE_CODE_UNITS}-code-unit CLI limit.`, true);
        io.prompt?.();
        continue;
      }
      const leading = line.trimStart();
      if (!leading) {
        io.prompt?.();
        continue;
      }
      if (leading.startsWith(LITERAL_SLASH_PREFIX)) {
        const prefix = line.indexOf(LITERAL_SLASH_PREFIX);
        await queueInput(`${line.slice(0, prefix)}/${line.slice(prefix + LITERAL_SLASH_PREFIX.length)}`);
      } else if (leading.startsWith("/")) {
        const parsed = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(line);
        if (!parsed) await notice("Malformed slash command; it was not sent to the model.", true);
        else {
          const name = parsed[1]!.toLowerCase();
          const args = parsed[2] ?? "";
          await localCommand(name, args);
        }
      } else {
        await queueInput(line);
      }
      io.prompt?.();
    }
    inputEnded = !signal?.aborted;

    await admissionTail;
    await Promise.allSettled([...commands]);
    while (waits.size > 0 && !signal?.aborted) {
      await Promise.race([...waits]);
      if (!inputEnded || !unansweredObserved || signal?.aborted || waits.size === 0) continue;
      const state = await conversation.viewState(operationContext);
      let idle = false;
      try {
        const live = state.value.docs["pi.live"] as unknown as LiveState | undefined;
        idle = live?.run === undefined;
      } finally { state.dispose(); }
      if (idle) {
        const queued: NativeSubmission[] = [];
        for (const local of submissions.values()) {
          if ((await local.submission.status(operationContext)).status === "queued") queued.push(local.submission);
        }
        if (queued.length > 0) {
          await notice(`EOF reached after a failed/ended run; preserving ${queued.length} Durable-queued CLI input(s). Closing local observers; reopen to reconcile them or use explicit /abort to withdraw.`, true);
          observerController.abort(new Error("CLI EOF; preserve queued Durable submissions"));
          break;
        }
      }
    }
    await Promise.allSettled([...waits]);
    await outputTail;
    if (outputFailure !== undefined && !signal?.aborted) throw outputFailure;
  } catch (error) {
    if (!signal?.aborted) {
      operationController.abort(error);
      closeInput();
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) closeInput();
    for (const stream of outputStreams) stream.off("error", onOutputError);
    await watch.stop();
    await Promise.allSettled([...watchCallbacks, ...waits, ...commands]);
    await admissionTail;
    await outputTail;
    await renderTail;
  }
  if (outputFailure !== undefined) throw outputFailure;
}

function assistantText(message: AssistantMessage | undefined, maxChars = MAX_RESPONSE_CHARS + 1): string {
  if (message?.role !== "assistant") return "";
  let text = "";
  for (let index = 0; index < message.content.length && index < MAX_MESSAGE_BLOCK_SCAN; index++) {
    if (text.length >= maxChars) break;
    const part = message.content[index]!;
    if (part.type === "text") text += part.text.slice(0, maxChars - text.length);
  }
  return text;
}

function formatHistoryMessage(message: Message): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const rawLimit = HISTORY_TEXT_CHARS * 4 + 33;
  let text: string;
  if (message.role === "assistant") text = assistantText(message as AssistantMessage, rawLimit);
  else if (typeof message.content === "string") text = message.content.slice(0, rawLimit);
  else {
    text = "";
    for (let index = 0; index < message.content.length && index < MAX_MESSAGE_BLOCK_SCAN; index++) {
      if (text.length >= rawLimit) break;
      const part = message.content[index]!;
      if (part.type === "text") text += part.text.slice(0, rawLimit - text.length);
    }
  }
  const cleaned = sanitizeTerminalText(text).trim();
  if (!cleaned) return undefined;
  const characters = Array.from(cleaned);
  const snippet = characters.length > HISTORY_TEXT_CHARS
    ? `${characters.slice(0, HISTORY_TEXT_CHARS).join("")}…`
    : cleaned;
  return `${message.role === "user" ? "You" : "Assistant"}: ${snippet}`;
}

function splitToolNames(value: string): readonly string[] | undefined {
  const names = value.split(",");
  if (names.length === 0 || names.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name))) return undefined;
  return [...new Set(names)];
}

/** Only an explicit duration with a unit; there is no implicit or indefinite grant. */
function parseGrantDuration(value: string): number | undefined {
  const match = /^(\d{1,9})([smh])$/.exec(value);
  if (match === null) return undefined;
  const unit = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const duration = Number(match[1]) * unit;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
}

function formatGrantExpiry(expiresAt: number, now: number): string {
  const remainingMs = expiresAt - now;
  const remaining = remainingMs <= 0
    ? "expired"
    : remainingMs < 60_000
      ? `in ${Math.ceil(remainingMs / 1_000)}s`
      : remainingMs < 3_600_000
        ? `in ${Math.ceil(remainingMs / 60_000)}m`
        : `in ${Math.ceil(remainingMs / 3_600_000)}h`;
  return `${new Date(expiresAt).toISOString()} (${remaining})`;
}

function safeLabel(value: string, max: number): string {
  return completePrefix(sanitizeTerminalText(value), max) || "(empty)";
}

function modelLabel(model: { provider: string; modelId: string } | undefined): string {
  return model === undefined
    ? "unknown (no model configured)"
    : completePrefix(sanitizeTerminalText(`${model.provider}/${model.modelId}`), 240);
}

function formatUsage(usage: UsageState | undefined): string[] {
  if (usage === undefined) return ["Recorded usage: unavailable (pi.usage is absent from the current view)."];
  const lines = ["Recorded usage (native Durable records):"];
  const rows: string[] = [];
  const maxRows = 40;
  for (const model in usage.models ?? {}) {
    if (!Object.hasOwn(usage.models, model)) continue;
    const totals = usage.models[model]!;
    rows.push(`  model ${completePrefix(sanitizeTerminalText(model), 120)}: input=${totals.input} output=${totals.output} total=${totals.totalTokens} cost=${formatCost(totals.cost?.total)}`);
    if (rows.length >= maxRows) break;
  }
  if (rows.length < maxRows) {
    for (const tool in usage.tools ?? {}) {
      if (!Object.hasOwn(usage.tools, tool)) continue;
      const totals = usage.tools[tool]!;
      rows.push(`  tool ${completePrefix(sanitizeTerminalText(tool), 120)}: input=${totals.input} output=${totals.output} total=${totals.totalTokens} cost=${formatCost(totals.cost?.total)}`);
      if (rows.length >= maxRows) break;
    }
  }
  if (rows.length === 0) lines.push("  no usage recorded yet");
  else lines.push(...rows);
  if (rows.length === maxRows) lines.push("  additional usage rows omitted");
  return lines;
}

function formatCost(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "unknown";
}

function limitResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return `${text}\n`;
  return `${completePrefix(text, MAX_RESPONSE_CHARS)}\n[Response truncated by the terminal output limit.]\n`;
}

function safeReason(reason: string): string {
  return completePrefix(sanitizeTerminalText(reason), 120) || "unknown";
}

function errorName(error: unknown): string {
  return error instanceof Error ? completePrefix(sanitizeTerminalText(error.name), 80) || "Error" : "unknown error";
}

function stripTerminalControls(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g, "");
}

function sanitizePartialText(text: string): string {
  return replaceUnpairedSurrogates(stripTerminalControls(text), true);
}

function sanitizeTerminalText(text: string): string {
  return replaceUnpairedSurrogates(stripTerminalControls(text), false);
}

function replaceUnpairedSurrogates(text: string, preserveTrailingHigh: boolean): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) result += text[index]! + text[++index]!;
      else if (preserveTrailingHigh && index === text.length - 1) result += text[index]!;
      else result += "�";
    } else if (isLowSurrogate(code)) result += "�";
    else result += text[index]!;
  }
  return result;
}

function completePrefix(text: string, maxCodeUnits: number): string {
  let length = Math.min(text.length, Math.max(0, maxCodeUnits));
  if (length > 0 && isHighSurrogate(text.charCodeAt(length - 1))) length--;
  return text.slice(0, length);
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

async function waitForDrain(stream: Writable, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.off("finish", onFinish);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("Output stream closed before drain")); };
    const onFinish = (): void => { cleanup(); reject(new Error("Output stream finished before drain")); };
    const onAbort = (): void => { cleanup(); reject(signal?.reason ?? new Error("Output wait cancelled")); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    stream.once("finish", onFinish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (stream.destroyed || stream.writableFinished) onClose();
    else if (signal?.aborted) onAbort();
  });
}
