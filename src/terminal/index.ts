import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Cursor,
  LiveState,
  UsageState,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

const MAX_PENDING_INPUTS = 64;
const MAX_ACTIVE_COMMANDS = 16;
const MAX_INPUT_CHARS = 32_000;
const MAX_RESPONSE_CHARS = 64_000;
const MAX_HISTORY_COUNT = 50;
const DEFAULT_HISTORY_COUNT = 10;
const HISTORY_TEXT_CHARS = 200;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_ENTRY_LIMIT = 2_000;
const MAX_REMEMBERED_ANSWERS = 256;
const MAX_STATUS_QUEUE_SCAN = 2_000;
const MAX_MESSAGE_BLOCK_SCAN = 2_048;
const LITERAL_SLASH_PREFIX = "//";

export interface TerminalIO {
  /** Each item is one completed input line. */
  readonly input: AsyncIterable<string>;
  readonly output: Writable;
  readonly errorOutput?: Writable;
  /** Called before input and after each line, allowing a readline host to show its prompt. */
  readonly prompt?: () => void;
  /** Close an input source that supports prompt cancellation (for example readline.Interface). */
  readonly closeInput?: () => void;
}

type InboxView = { items?: readonly { mode?: string }[] };
type RunView = { taskId: number; inputs: readonly number[] };
type NativeSubmission = Awaited<ReturnType<Conversation["submit"]>>;
type SettledSubmission = Awaited<ReturnType<NativeSubmission["wait"]>>;
type LocalSubmission = { id: number; submission: NativeSubmission; runTaskId?: number };
type GenerationOutput = {
  attempt: number;
  streamed: string;
  truncated: boolean;
  desynchronized: boolean;
  active: boolean;
  openLine: boolean;
};
type RunOutput = { generation?: GenerationOutput };

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
      return;
    }

    const ownedInputs = run.inputs.filter((id) => submissions.has(id));
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
    const state = responseState(run.taskId);
    const generation = live?.generation;
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
        if (!rememberAnswer(settled.answer)) return;
        const local = submissions.get(submissionId);
        const taskId = local?.runTaskId;
        const generation = taskId === undefined ? undefined : runOutputs.get(taskId)?.generation;

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

  const queueInput = (content: string, whenBusy?: "steer" | "followUp"): Promise<void> => {
    if (reservedInputs >= MAX_PENDING_INPUTS) {
      return notice(`Input limit reached (${MAX_PENDING_INPUTS} unsettled submissions). Wait for a turn or use /abort.`, true);
    }
    reservedInputs++;
    const operation = admissionTail.then(async () => {
      if (signal?.aborted) throw signal.reason;
      const submission = await conversation.submit(
        { type: "input", content, ...(whenBusy === undefined ? {} : { whenBusy }) },
        operationContext,
      );
      submissions.set(submission.id, { id: submission.id, submission });
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

  const showModel = async (mutationRequested: boolean): Promise<void> => {
    const agent = await conversation.agent(operationContext);
    const model = modelLabel(agent.model);
    await notice(mutationRequested
      ? `Model changes are host-controlled and unavailable here. Current model: ${model}.`
      : `Current model: ${model}.`);
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
          "Local commands: /help /status /history [count] /model /compact /abort /steer TEXT /after TEXT",
          "Unknown slash commands are not sent to the model. Prefix a prompt with // to send one literal leading slash.",
          "/abort uses native Durable semantics: it cancels foreground work and withdraws queued inputs.",
          "/model only reports the current host-selected model; it cannot change it.",
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
        await showModel(args.trim().length > 0);
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
      default:
        if (name === "stop") {
          await notice("/stop is unsupported: it is not aliased to native /abort, which withdraws queued inputs.", true);
        } else if (name === "new") {
          await notice("/new is unsupported: native reset does not implement Nanobot archive/usage-reset semantics.", true);
        } else if (name === "restart") {
          await notice("/restart is unsupported: process restart belongs to the deployment owner.", true);
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
      if (line.length > MAX_INPUT_CHARS) {
        await notice(`Input exceeds the ${MAX_INPUT_CHARS}-character CLI limit.`, true);
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
          if (name === "steer" || name === "after") {
            if (!args.trim()) await notice(`Usage: /${name.toUpperCase()} TEXT`, true);
            else await queueInput(args.trim(), name === "steer" ? "steer" : "followUp");
          } else await localCommand(name, args);
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

function sanitizePartialText(text: string): string {
  return replaceUnpairedSurrogates(stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""), true);
}

function sanitizeTerminalText(text: string): string {
  return replaceUnpairedSurrogates(stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""), false);
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
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => { cleanup(); reject(signal?.reason ?? new Error("Output wait cancelled")); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
