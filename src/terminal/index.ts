import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { AssistantEntry, ConversationBusy, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import type { Cursor, EntryId, UsageState } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import {
  conversationCommandNames,
  conversationCommandRefusal,
  conversationCommandUsage,
  conversationDetailBlock,
  conversationHelpListing,
  findConversationCommand,
  SAFE_COMMAND_NAME,
} from "../help/commands.js";
import { renderMcpListing, type McpAdminListing, type McpCallbackResult } from "../mcp/admin.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { renderBackgroundStatus } from "../background-status.js";
import type { HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import {
  renderMemoryDigestStart,
  renderMemoryDigestStatus,
  type MemoryDigestStartResult,
  type MemoryDigestStatusView,
} from "../history/memory-digest.js";
import {
  HISTORY_INDEX_LIMITS,
  type HistoryCoverage,
  type HistoryCursor,
  type HistoryHit,
  type HistoryPage,
  type HistoryQuery,
  type HistoryRole,
  type HistoryScope,
} from "../history/index.js";
import type {
  GatewayModelList,
  GatewayModelSelection,
  GatewayModelSelectionRequest,
} from "../runtime.js";
import type {
  TerminalAttachmentSubmission,
  TerminalConversation,
  TerminalEntry,
  TerminalEntryPage,
  TerminalEntryQuery,
  TerminalMessage,
  TerminalSettlement,
  TerminalSnapshot,
  TerminalStatus,
  TerminalSubmission,
} from "./conversation.js";

const MAX_PENDING_INPUTS = 64;
const MAX_ACTIVE_COMMANDS = 16;
const MAX_ADMITTED_LINE_CODE_UNITS = 32_000;
const MAX_RESPONSE_CHARS = 64_000;
const MAX_HISTORY_COUNT = 50;
const DEFAULT_HISTORY_COUNT = 10;
const HISTORY_TEXT_CHARS = 200;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_ENTRY_LIMIT = 2_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_EXCERPT_CHARS = 600;
const ENTRY_TEXT_CHARS = 2_000;
const ENTRY_VIEW_MAX_RADIUS = 5;
const DEFAULT_EPISODE_LIST_LIMIT = 10;
const MAX_EPISODE_LIST_LIMIT = 50;
const DEFAULT_EPISODE_ENTRY_LIMIT = 10;
const MAX_EPISODE_ENTRY_LIMIT = 30;
const EPISODE_ENTRY_PAGE_SIZE = 100;
const MAX_EPISODE_SCAN_ENTRIES = 300;
const HISTORY_VIEW_CHARS = 48_000;
const MAX_REMEMBERED_ANSWERS = 256;
/** Shared-turn end reports remembered, so one run reports its end once and distinct runs never collapse. */
const MAX_REMEMBERED_RUN_ENDS = 256;
const MAX_REMEMBERED_LOCAL_INPUTS = 1_024;
const MAX_EXTERNAL_RUNS = 64;
const LITERAL_SLASH_PREFIX = "//";
/**
 * Interactive-only receipts and display. A slow reply must look pending rather than broken, and a
 * closed terminal must not look like a lost answer. Neither receipt claims a model turn is running:
 * native admission only establishes that the input is durable, so `/status` stays the authority on
 * whether it is queued or running.
 */
const INTERACTIVE_ATTACH_NOTICE =
  "Attached. Earlier replies are not replayed; /history prints them. Closing this terminal does not cancel admitted work.";
const INTERACTIVE_PENDING_NOTICE = "Reply pending; it may be queued behind a running turn. /status shows progress.";
const ASSISTANT_LABEL = "Assistant:";
const ACTIVITY_FRAMES = ["|", "/", "-", "\\"] as const;
const ACTIVITY_INTERVAL_MS = 250;
/**
 * The activity line reports only what committed state establishes: an admitted input is pending, and
 * a run containing it has been observed. "Waiting" is also what a queued input shows, so neither
 * label claims that the model is generating.
 */
const ACTIVITY_WAITING = "Waiting for the assistant...";
const ACTIVITY_WORKING = "Assistant working...";

const DEFAULT_ACTIVITY_TIMER: TerminalActivityTimer = {
  set(callback, milliseconds) {
    const handle = setInterval(callback, milliseconds);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};
/**
 * Only a busy refusal guarantees no effect. Other failures may follow acceptance or a lost
 * acknowledgement, so report uncertainty without echoing an internal message.
 */
const RESTART_REFUSED =
  "Gateway restart was not confirmed; the gateway may already be restarting. Check its status before retrying.";

export interface TerminalModelSelectionHost {
  list(): Promise<GatewayModelList>;
  select(selection: GatewayModelSelectionRequest): Promise<GatewayModelSelection>;
  /** Optional named-preset selection; absent for direct-model hosts. */
  selectPreset?(name: string): Promise<GatewayModelSelection>;
}

/**
 * Read-only view of a host whose coding-tool authority comes from configuration. There is no grant
 * or expiry here: the configured names are what authenticated chats may use, and changing them is a
 * host configuration change, not a chat command.
 */
export interface TerminalToolPolicyHost {
  readonly tools: readonly string[];
}

/** Optional host-owned workspace-context refresh for the current conversation. */
export interface TerminalContextRefreshHost {
  /** False when the gateway has no configured context snapshot provider. */
  readonly available: boolean;
  /** Re-capture this conversation's host snapshot; resolves with its skill count. */
  refresh(): Promise<{ readonly skills: number }>;
}

/**
 * Optional host-owned manual memory-digestion entry. Starting returns once one bounded task is
 * admitted (or reports idle/busy/refused); status is a bounded read-only read. Neither waits for
 * the digest model turn, and neither is a model tool or an automatic schedule.
 */
export interface TerminalDigestHost {
  start(): Promise<MemoryDigestStartResult>;
  /** One host-projected status view: this attachment never receives another chat's origin. */
  status(): Promise<MemoryDigestStatusView>;
}

/**
 * MCP host surface over the already-authenticated local attach. `/mcp` is bounded read-only status.
 * A callback-shaped input line is offered here before model admission; the host validates it against
 * the login that originated in this exact session.
 */
export interface TerminalMcpHost {
  list(): Promise<McpAdminListing>;
  submitCallback(text: string): Promise<McpCallbackResult>;
}

/**
 * Optional host-owned history read surface. The host supplies authenticated session scope; the
 * terminal never chooses a conversation or session key for search. Search results and episodes
 * are read-only derived views, never transcript writes or tool authority.
 */
export interface TerminalHistoryHost {
  /** Session used when a history command omits --session; normally cli:default. */
  readonly defaultSession: string;
  search(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  listEpisodes(sessionKey: string, query: HistoryEpisodeQuery, context: Context): Promise<HistoryEpisodePage>;
  episode(sessionKey: string, startEntryId: EntryId, context: Context): Promise<HistoryEpisode | undefined>;
  entries(
    sessionKey: string,
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage>;
}

/**
 * Optional host-owned local attachment submission. The host resolves and reads the
 * operator-named file, stores the original in the gateway's CLI attachment
 * directory, and composes ordinary path-only text; the terminal only names the path.
 */
export interface TerminalAttachmentHost {
  submit(path: string, prompt: string, context: Context): Promise<TerminalAttachmentSubmission>;
}

/**
 * Optional owner-terminal display. Absent keeps plain line-oriented output, which is what a piped
 * run and an SDK caller rely on. Prompt/status hooks preserve the host's typed input buffer;
 * an optional streaming writer lets readline keep that buffer editable during assistant output.
 */
export interface TerminalDisplay {
  /** True only for a real owner terminal; interactive receipts and activity exist only then. */
  readonly interactive: boolean;
  /** Draw the host's prompt. */
  prompt(): void;
  /** Erase the displayed prompt block; the typed buffer stays in the host input source. */
  erasePrompt(): void;
  /** Optional readline-aware streaming output, preserving a partially typed next message. */
  write?(text: string, target: Writable): boolean;
  /** Release the display, leaving any unfinished assistant text visible. */
  close?(): void;
  /** Replace the transient status line above the prompt, or clear it with `undefined`. */
  status(text: string | undefined): void;
}

/** Timer hooks for the transient status line, so checks can drive frames deterministically. */
export interface TerminalActivityTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface TerminalIO {
  /** Each item is a completed line; the source owns any memory bound before yielding it. */
  readonly input: AsyncIterable<string>;
  readonly output: Writable;
  readonly errorOutput?: Writable;
  /** Optional interactive prompt, activity line and receipts; absent keeps answer-only output. */
  readonly display?: TerminalDisplay;
  /** Plain prompt fallback for a TTY without cursor-control support. */
  readonly prompt?: () => void;
  /** Optional timer source for the activity line; defaults to an unref'd interval. */
  readonly activityTimer?: TerminalActivityTimer;
  /** Close an input source that supports prompt cancellation (for example readline.Interface). */
  readonly closeInput?: () => void;
  /** Optional host-owned model policy; standalone terminal callers remain read-only without it. */
  readonly modelSelection?: TerminalModelSelectionHost;
  /** Optional read-only configured tool authority; absent leaves the local tool commands unavailable. */
  readonly toolPolicy?: TerminalToolPolicyHost;
  /** Optional host-owned workspace-context refresh; standalone callers leave /refresh unavailable. */
  readonly contextRefresh?: TerminalContextRefreshHost;
  /** Optional host-owned memory-digestion entry; absent leaves /digest unavailable. */
  readonly digest?: TerminalDigestHost;
  /** Optional owner-only MCP management; absent leaves /mcp unavailable. */
  readonly mcp?: TerminalMcpHost;
  /** Optional host-owned history search/episode reads; standalone callers leave /search and /episodes unavailable. */
  readonly history?: TerminalHistoryHost;
  /** Optional host-owned local attachment submission; absent leaves /attach unavailable. */
  readonly attachments?: TerminalAttachmentHost;
  /** Host-owned whole-gateway restart, never a model tool or a terminal-only reconnect. */
  readonly restart?: () => Promise<void>;
}

type LocalSubmission = {
  id: number;
  submission: TerminalSubmission;
  runTaskId?: number;
  /** First input of the native run this submission joined, observed in a committed snapshot. */
  runFirst?: number;
  finalized?: boolean;
};
type GenerationOutput = {
  attempt: number;
  streamed: string;
  truncated: boolean;
  desynchronized: boolean;
  active: boolean;
  openLine: boolean;
  /** Final entry reconciled; suppress older committed snapshots still queued behind output backpressure. */
  finalized: boolean;
  /** Interactive answer header already printed for this generation's text. */
  labelled: boolean;
  /** A host notice or another input interrupted this answer's visible text block. */
  interrupted?: boolean;
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
  conversation: TerminalConversation,
  context: Context,
  io: TerminalIO,
): Promise<void> {
  const operationController = new AbortController();
  const operationContext = withAbortSignal(operationController.signal, context);
  const observerController = new AbortController();
  const observerContext = withAbortSignal(observerController.signal, operationContext);
  const signal = operationContext.abortSignal;
  const observerSignal = observerContext.abortSignal;
  // Prime the input source before any awaited remote setup. Readline and similar
  // async iterables only attach their line listener on the first next(), so an
  // immediate piped line or EOF would otherwise be lost while the watch attaches.
  // Only one item is pulled early; later lines stay in the source's own buffer
  // until the loop consumes them.
  const input = primedInput(io.input);
  const watch = await conversation.watch(observerContext);
  const submissions = new Map<number, LocalSubmission>();
  const runOutputs = new Map<number, RunOutput>();
  const answerIds = new Set<number>();
  const answerOrder: number[] = [];
  const endedRuns = new Set<number>();
  const endedRunOrder: number[] = [];
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
  // Owner-terminal display state. A host may keep the editable prompt visible during streaming;
  // otherwise it is erased before written text. Activity never owns assistant or owner text.
  const display = io.display;
  const interactive = display?.interactive === true;
  let promptVisible = false;
  let activityHandle: unknown;
  let activityFrame = 0;
  let observedRunInputs: readonly number[] = [];
  let inputEnded = false;
  /** Last successful search base and cursor; the cursor is opaque and never printed. */
  let pendingSearch: { readonly query: HistoryQuery; readonly cursor: HistoryCursor } | undefined;

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
      // A status line or prompt display never survives text: the line belongs to the output.
      stopActivity();
      if (display?.write !== undefined) {
        const ready = display.write(cleaned, target);
        promptVisible = !inputEnded && !signal?.aborted;
        if (!ready) await waitForDrain(target, signal);
      } else {
        erasePrompt();
        if (!target.write(cleaned)) await waitForDrain(target, signal);
      }
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
      if (state.generation?.active && state.generation.labelled) state.generation.interrupted = true;
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

  const activityTimer = io.activityTimer ?? DEFAULT_ACTIVITY_TIMER;
  const stopActivity = (): void => {
    if (activityHandle !== undefined) {
      activityTimer.clear(activityHandle);
      activityHandle = undefined;
    }
    display?.status(undefined);
  };
  const renderActivity = (): void => {
    if (display === undefined || !promptVisible) return;
    const glyph = ACTIVITY_FRAMES[activityFrame % ACTIVITY_FRAMES.length]!;
    activityFrame++;
    const working = [...submissions.values()].some((local) => !local.finalized && observedRunInputs.includes(local.id));
    display.status(`${glyph} ${working ? ACTIVITY_WORKING : ACTIVITY_WAITING}`);
  };
  /** The activity line exists only beside a drawn prompt and only for admitted, unsettled local input. */
  const startActivityIfPending = (): void => {
    if (display === undefined || !interactive || !promptVisible) return;
    const pending = [...submissions.values()].filter((local) => !local.finalized);
    if (pending.length === 0 || signal?.aborted) return;
    // Only a local answer that has actually begun suppresses activity. An external answer must
    // not latch off a still-queued owner's spinner, nor may a finished sibling keep it suppressed.
    if (pending.some((local) => local.runTaskId !== undefined &&
      runOutputs.get(local.runTaskId)?.generation?.labelled)) return;
    if (activityHandle !== undefined) return;
    activityFrame = 0;
    renderActivity();
    activityHandle = activityTimer.set(renderActivity, ACTIVITY_INTERVAL_MS);
  };
  const erasePrompt = (): void => {
    if (display === undefined || !promptVisible) return;
    promptVisible = false;
    display.erasePrompt();
  };
  /** Restore the prompt, and the activity line, when no answer text is being written. */
  const showPrompt = (): void => {
    if (signal?.aborted || inputEnded) return;
    if (display === undefined) { io.prompt?.(); return; }
    if (!interactive) return;
    stopActivity();
    if (!promptVisible) {
      display.prompt();
      promptVisible = true;
    }
    startActivityIfPending();
  };
  /** Label each visible answer block, including continuations separated by owner/host text. */
  const labelAssistant = async (state?: GenerationOutput): Promise<void> => {
    if (display === undefined || !interactive) return;
    const continued = state?.labelled === true;
    if (state !== undefined) {
      if (state.labelled && !state.interrupted) return;
      state.labelled = true;
      state.interrupted = false;
    }
    await write(`${continued ? "Assistant (continued):" : ASSISTANT_LABEL}\n`);
  };

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

  /**
   * Remember one native run whose end was reported, keyed by its first input. That input identifies the run
   * across tool rounds and handovers (Durable only appends later inputs to the same run) and belongs to exactly
   * one run, so it can never collapse two distinct turns — unlike their settlement reason text.
   */
  const reportRunEnd = (runFirst: number): boolean => {
    if (endedRuns.has(runFirst)) return false;
    endedRuns.add(runFirst);
    endedRunOrder.push(runFirst);
    while (endedRunOrder.length > MAX_REMEMBERED_RUN_ENDS) {
      const oldest = endedRunOrder.shift();
      if (oldest !== undefined) endedRuns.delete(oldest);
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
    snapshot: TerminalSnapshot,
    taskId: number,
  ) => snapshot.answers.find((answer) => answer.taskId === taskId);

  /**
   * A run admitted by another host path (for example a scheduled origin-mode cron turn) has no local
   * Submission to wait on. Print its committed final answer once when the run ends, and never replay
   * an already-completed run at startup. Attribution uses the generation task that wrote the answer,
   * so an immediate successor run in the same commit cannot steal or suppress the previous answer.
   * Live partials stay local-submission-only so this terminal never renders a revision it cannot
   * reconcile against a settlement.
   */
  const finalizeExternalRun = async (
    snapshot: TerminalSnapshot,
    external: ExternalRun,
  ): Promise<void> => {
    const answer = latestExternalAnswer(snapshot, external.taskId);
    if (answer === undefined) {
      await rawNotice(
        "A turn admitted before or outside this terminal ended without an attributable assistant reply; use /history to inspect the conversation.",
        true,
      );
      return;
    }
    if (!rememberAnswer(answer.entryId)) return;
    const stopReason = answer.stopReason;
    const finalText = sanitizeTerminalText(answer.text);
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
      await labelAssistant();
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
    snapshot: TerminalSnapshot,
    run: TerminalSnapshot["run"],
  ): Promise<void> => {
    const currentInputs = run?.inputs ?? [];
    for (const [key, external] of [...externalRuns]) {
      const stillCurrent = currentInputs.includes(external.rootInput);
      if (run === undefined || snapshot.run === undefined || !stillCurrent) {
        externalRuns.delete(key);
        await finalizeExternalRun(snapshot, external);
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
        labelled: false,
      };
      runOutputs.set(taskId, run);
    }
    return run.generation;
  };

  const streamView = async (snapshot: TerminalSnapshot): Promise<void> => {
    const run = snapshot.run;
    observedRunInputs = run?.inputs ?? [];
    if (activityHandle !== undefined) renderActivity();
    if (run === undefined) {
      // Keep the final streamed line open until the submission receipt is reconciled below.
      for (const state of runOutputs.values()) if (state.generation?.active) state.generation.active = false;
      await reconcileExternalRuns(snapshot, undefined);
      return;
    }
    await reconcileExternalRuns(snapshot, run);
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
    const runFirst = run.inputs[0];
    if (runFirst !== undefined) {
      for (const id of ownedInputs) {
        const local = submissions.get(id)!;
        local.runFirst ??= runFirst;
      }
    }
    // A watch frame can arrive before the local admission promise records its ID. If this run turns
    // out to own a local input after all, local settlement owns its answer and partial rendering.
    dropExternalRunFor(run.inputs);
    const state = responseState(run.taskId);
    const generation = run.generation;
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

    const partial = generation.text;
    const current = sanitizePartialText(partial);
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
      if (!state.openLine) await labelAssistant(state);
      state.openLine = true;
      await write(shown);
      state.streamed += shown;
      state.openLine = !shown.endsWith("\n");
    }
    if (limitExceeded) {
      state.truncated = true;
      await rawNotice("[Live response output limit reached.]", true);
    }
  };

  watch.start(async (snapshot) => {
    const callback = serializeRender(async () => {
      await streamView(snapshot);
      startActivityIfPending();
    });
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

  const finishSubmission = async (submissionId: number, settled: TerminalSettlement): Promise<void> => {
    if (settled.status === "done" && settled.type === "input" && settled.answer !== undefined) {
      const answerId = settled.answer;
      const answer = await conversation.answer(answerId, operationContext);
      const finalText = sanitizeTerminalText(answer.text);
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
        if (!rememberAnswer(answerId)) return;

        if (finalText.length === 0) {
          if (generation?.streamed.length === 0) await rawNotice("The assistant returned no text response.");
          else await rawNotice("[The committed assistant entry had no text; the streamed partial was not a final answer.]", true);
        } else if (generation === undefined || generation.streamed.length === 0) {
          await labelAssistant(generation);
          await rawNotice(limitResponse(finalText));
        } else if (finalText.startsWith(generation.streamed)) {
          const suffix = finalText.slice(generation.streamed.length);
          const remaining = Math.max(0, MAX_RESPONSE_CHARS - generation.streamed.length);
          const shown = completePrefix(suffix, remaining);
          if (shown) {
            if (!generation.openLine) await labelAssistant(generation);
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
      // Inputs one run consumed settle together. Its end is reported once per run, identified by the run's
      // first input observed in a committed snapshot; a settlement whose membership in a run was never
      // observed (a withdrawn queued input, or a turn that ended before this terminal saw it) reports its
      // own end.
      const runFirst = submissions.get(submissionId)?.runFirst;
      if (runFirst !== undefined && !reportRunEnd(runFirst)) return;
      await notice(`Turn ended: ${safeReason(settled.reason ?? "unknown")}`, true);
    }
  };

  const waitForSubmission = (id: number, submission: TerminalSubmission): void => {
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
        showPrompt();
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
      const submission = await conversation.submit(content, operationContext);
      submissions.set(submission.id, { id: submission.id, submission });
      rememberLocalInput(submission.id);
      waitForSubmission(submission.id, submission);
      // Only after native admission: a rejected input has its own refusal notice instead.
      if (interactive) {
        await notice(INTERACTIVE_PENDING_NOTICE);
        showPrompt();
      }
    });
    admissionTail = operation.catch(async (error: unknown) => {
      reservedInputs = Math.max(0, reservedInputs - 1);
      if (!signal?.aborted) await notice(`Input was not admitted (${errorName(error)}).`, true);
    });
    return Promise.resolve();
  };

  /** The catalogued CLI commands this host actually offers, in catalogue order. */
  const offeredCommands = (): readonly string[] => {
    const offered = new Set(["help", "new", "abort", "stop", "status", "history", "entry", "compact"]);
    if (io.history) {
      offered.add("search");
      offered.add("episodes");
      offered.add("episode");
    }
    if (io.modelSelection) offered.add("model");
    if (io.toolPolicy) offered.add("tools");
    if (io.contextRefresh?.available) offered.add("refresh");
    if (io.digest) offered.add("digest");
    if (io.mcp) offered.add("mcp");
    if (io.attachments) offered.add("attach");
    if (io.restart) offered.add("restart");
    return conversationCommandNames("cli").filter((name) => offered.has(name));
  };

  /**
   * A capability host the offer set already admitted. Availability is decided once, in
   * `offeredCommands`; this narrows the optional field for the handler and fails loudly instead of
   * repeating the refusal whenever the two disagree.
   */
  const offeredHost = <T>(host: T | undefined): T => {
    if (host === undefined) throw new Error("offered conversation command has no host");
    return host;
  };

  /**
   * One refusal for a typed slash command this host does not run: the same catalogue reason
   * `/help <command>` gives, the guarantee that it never reaches the model, and the `//` literal
   * escape for a name the catalogue does not know.
   */
  const refuseTypedCommand = async (name: string): Promise<void> => {
    const literal = findConversationCommand(name) === undefined && SAFE_COMMAND_NAME.test(name)
      ? ` Use //${name} to send it literally.`
      : "";
    // A host without model selection cannot change the model, but `/status` can still name it.
    const currentModel = name === "model" && io.modelSelection === undefined
      ? ` Current model: ${modelLabel((await conversation.status(operationContext)).model)}.`
      : "";
    await notice(`${conversationCommandRefusal("cli", name, offeredCommands())} It was not sent to the model.${currentModel}${literal}`, true);
  };

  const showHistory = async (rawCount: string): Promise<void> => {
    let count = DEFAULT_HISTORY_COUNT;
    if (rawCount.trim()) {
      if (!/^\d+$/.test(rawCount.trim())) {
        await notice(conversationCommandUsage("history"), true);
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
        for (let index = entry.messages.length - 1; index >= 0; index--) {
          const formatted = formatHistoryMessage(entry.messages[index]!);
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

  const showSearch = async (args: string): Promise<void> => {
    const host = offeredHost(io.history);
    const parsed = parseSearchArguments(args);
    if (parsed.kind === "usage") {
      await notice(SEARCH_USAGE, true);
      return;
    }
    if (parsed.kind === "next" && pendingSearch === undefined) {
      await notice("No search continuation is held. Run /search again; cursors are process-local and are never printed.", true);
      return;
    }

    let base: HistoryQuery;
    let query: HistoryQuery;
    if (parsed.kind === "next") {
      base = pendingSearch!.query;
      query = { ...base, cursor: pendingSearch!.cursor };
    } else {
      base = {
        text: parsed.text,
        scope: parsed.scope,
        limit: parsed.limit,
        ...(parsed.role === undefined ? {} : { roles: [parsed.role] }),
      };
      query = base;
      // A fresh query replaces any older continuation, even if this one fails.
      pendingSearch = undefined;
    }
    if ([...(base.text ?? "")].length > HISTORY_INDEX_LIMITS.maxQueryChars) {
      await notice(`Search query must be at most ${HISTORY_INDEX_LIMITS.maxQueryChars} characters.`, true);
      return;
    }

    let page: HistoryPage;
    try {
      page = await host.search(query, operationContext);
    } catch (error) {
      if (signal?.aborted) return;
      if (parsed.kind === "next") {
        pendingSearch = undefined;
        await notice("Search continuation rejected: the query, index, store or session mapping changed. Run /search again; cursors are process-local and are never printed.", true);
      } else {
        await notice(`History search failed (${errorName(error)}).`, true);
      }
      return;
    }
    pendingSearch = page.next === undefined ? undefined : { query: base, cursor: page.next };

    const scopeLabel = base.scope ?? "messages";
    const rolesLabel = base.roles === undefined ? "user+assistant messages" : `messages from ${base.roles.join(",")}`;
    const target = scopeLabel === "tools"
      ? "tool names, arguments and result text"
      : scopeLabel === "all"
        ? `${rolesLabel} plus tools`
        : rolesLabel;
    const lines = [
      `History search${parsed.kind === "next" ? " (continued)" : ""}: ${base.text ? `text=${safeLabel(base.text, 120)}` : "(browse)"}; scope=${scopeLabel}; ${target}; limit=${base.limit}.`,
    ];
    const coverageComplete = historyCoverageComplete(page.coverage);
    const footer = [
      page.hits.length === 0
        ? "No hits in the indexed records for this query and scope."
        : `${page.hits.length} hit(s), newest first:`,
      ...formatHistoryCoverage(page.coverage),
    ];
    if (page.next !== undefined) {
      footer.push("More results: /search --next (the same query and session mapping; entries appended after this page need a fresh search). Cursors are process-local and are never printed.");
    } else if (!coverageComplete) {
      footer.push("No further hits in this indexed window; the index is incomplete, so retry later for newly indexed entries.");
    }
    await notice(formatBoundedHistory(lines, footer, page.hits.map((hit, index) => formatHistoryHit(hit, index + 1))));
  };

  const showEpisodes = async (args: string): Promise<void> => {
    const host = offeredHost(io.history);
    const parsed = parseEpisodesArguments(args);
    if (parsed.kind === "usage") {
      await notice(EPISODES_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host.defaultSession;
    const sessionToken = historySessionToken(sessionKey);
    let page: HistoryEpisodePage;
    try {
      page = await host.listEpisodes(sessionKey, parsed.query, operationContext);
    } catch (error) {
      if (!signal?.aborted) await notice(`Episode listing failed (${errorName(error)}).`, true);
      return;
    }
    if (page.episodes.length === 0) {
      await notice(parsed.query.before === undefined
        ? `No non-empty episodes recorded yet for session ${safeLabel(sessionKey, 120)}.`
        : `No more non-empty episodes below that boundary for session ${safeLabel(sessionKey, 120)}.`);
      return;
    }
    const rows = page.episodes.map((episode) => {
      const end = episode.endEntryId === null ? "open" : String(episode.endEntryId);
      return `  #${episode.startEntryId}-${end} ${episode.status}; entries=${episode.entries ?? "uncounted"} messages=${episode.messages ?? "uncounted"} tools=${episode.toolResults ?? "uncounted"}; ${episode.resetEntryId === null ? "pre-reset segment" : `reset=${episode.resetEntryId}`}; summary=${episode.summary.status}; digest=${episode.digestion?.status ?? "unknown"}`;
    });
    const lines = [
      `Episodes for session ${safeLabel(sessionKey, 120)} (newest first), ${page.episodes.length} selected:`,
    ];
    const footer = [
      "Summary text is not generated or shown; only the recorded summary status is reported.",
    ];
    if (page.next !== undefined) {
      footer.push(sessionToken === undefined
        ? "Older episodes exist; the continuation hint is suppressed because this session key is not exactly representable as a CLI token."
        : `Older episodes: /episodes --session ${sessionToken} --before ${page.next.before}`);
    }
    footer.push(sessionToken === undefined
      ? "Drilldown hints are suppressed: this session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units."
      : `Open one with /episode --session ${sessionToken} <startEntryId>, or a bounded window around any entry with /entry --session ${sessionToken} <entryId>.`);
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  const showEpisode = async (args: string): Promise<void> => {
    const host = offeredHost(io.history);
    const parsed = parseEpisodeArguments(args);
    if (parsed.kind === "usage") {
      await notice(EPISODE_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host.defaultSession;
    const sessionToken = historySessionToken(sessionKey);
    let episode: HistoryEpisode | undefined;
    try {
      episode = await host.episode(sessionKey, parsed.startEntryId, operationContext);
    } catch (error) {
      if (!signal?.aborted) await notice(`Episode read failed (${errorName(error)}).`, true);
      return;
    }
    if (episode === undefined) {
      await notice(`No non-empty episode starts at entry #${parsed.startEntryId} in session ${safeLabel(sessionKey, 120)}. Use /episodes to list episode starts.`, true);
      return;
    }

    const rows: string[] = [];
    let cursor: Cursor | undefined;
    let scanned = 0;
    let exhausted = false;
    try {
      while (rows.length < parsed.limit && scanned < MAX_EPISODE_SCAN_ENTRIES) {
        const take = Math.min(EPISODE_ENTRY_PAGE_SIZE, MAX_EPISODE_SCAN_ENTRIES - scanned);
        const page = await host.entries(sessionKey, {
          order: "ascending",
          minEntryId: episode.startEntryId,
          ...(episode.endEntryId === null ? {} : { maxEntryId: episode.endEntryId }),
        }, take, cursor, operationContext);
        if (page.items.length === 0) {
          exhausted = true;
          break;
        }
        scanned += page.items.length;
        for (const entry of page.items) {
          const display = formatBrowsedEntry(entry, entry.id === parsed.startEntryId);
          if (display !== undefined) rows.push(display);
          if (rows.length >= parsed.limit) break;
        }
        cursor = page.next;
        if (cursor === undefined) {
          exhausted = true;
          break;
        }
      }
    } catch (error) {
      if (!signal?.aborted) await notice(`Could not read episode entries (${errorName(error)}).`, true);
      return;
    }

    const end = episode.endEntryId === null ? "open" : String(episode.endEntryId);
    const lines = [
      `Episode #${episode.startEntryId}-${end} for session ${safeLabel(sessionKey, 120)} (${episode.status}; summary=${episode.summary.status}; digest=${episode.digestion?.status ?? "unknown"}); conversation=${episode.conversationId}; entries=${episode.entries ?? "uncounted"} messages=${episode.messages ?? "uncounted"} tools=${episode.toolResults ?? "uncounted"}.`,
    ];
    if (episode.resetEntryId !== null) lines.push(`Reset boundary: entry #${episode.resetEntryId} (reset handoff text is not shown).`);
    const footer: string[] = [];
    if (rows.length === 0) {
      footer.push(`No displayable message/tool entry in the first ${scanned} scanned entr${scanned === 1 ? "y" : "ies"}.`);
    } else {
      footer.push(`Selected ${rows.length} message/tool entr${rows.length === 1 ? "y" : "ies"}; scanned ${scanned} entr${scanned === 1 ? "y" : "ies"}${episode.entries === null ? "" : ` of ${episode.entries}`}.`);
    }
    if (!exhausted && rows.length >= parsed.limit) {
      footer.push(sessionToken === undefined
        ? `[Episode view limited to ${parsed.limit} displayable entries; the continuation hint is suppressed because this session key is not exactly representable as a CLI token.]`
        : `[Episode view limited to ${parsed.limit} displayable entries; use /entry --session ${sessionToken} <entryId> for another window.]`);
    }
    if (!exhausted && scanned >= MAX_EPISODE_SCAN_ENTRIES) footer.push(`[Episode scan capped at ${MAX_EPISODE_SCAN_ENTRIES} entries.]`);
    if (sessionToken === undefined) footer.push("Drilldown hints are suppressed: this session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units.");
    footer.push("System, reset, compaction and thinking content is not shown; raw stored entries are not modified.");
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  const showEntry = async (args: string): Promise<void> => {
    const host = io.history;
    const parsed = parseEntryArguments(args);
    if (parsed.kind === "usage") {
      await notice(ENTRY_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host?.defaultSession ?? "cli:default";
    if (parsed.session !== undefined && host === undefined) {
      // `/entry` itself is offered without a history host; only cross-session browsing needs one.
      await notice("Cross-session entry browsing needs the host history surface, which this host does not expose.", true);
      return;
    }
    if (host === undefined && sessionKey !== "cli:default") {
      await notice("Entry browsing is limited to the default session without a history host.", true);
      return;
    }
    const minEntryId = Math.max(1, parsed.entryId - parsed.radius) as EntryId;
    const maxEntryId = Math.min(Number.MAX_SAFE_INTEGER, parsed.entryId + parsed.radius) as EntryId;
    let rows: string[];
    let hidden = 0;
    let selectedSeen = false;
    let conversationId: number;
    try {
      const page: TerminalEntryPage = host === undefined
        ? await conversation.entries({ order: "ascending", minEntryId, maxEntryId }, parsed.radius * 2 + 1, undefined, operationContext)
        : await host.entries(sessionKey, { order: "ascending", minEntryId, maxEntryId }, parsed.radius * 2 + 1, undefined, operationContext);
      conversationId = page.conversationId;
      rows = [];
      for (const entry of page.items) {
        if (entry.id === parsed.entryId) selectedSeen = true;
        const display = formatBrowsedEntry(entry, entry.id === parsed.entryId);
        if (display === undefined) hidden++;
        else rows.push(display);
      }
    } catch (error) {
      if (!signal?.aborted) await notice(`Could not read entries (${errorName(error)}).`, true);
      return;
    }

    const lines = [
      `Entry window #${minEntryId}-${maxEntryId} for session ${safeLabel(sessionKey, 120)} in conversation ${conversationId}; selected=#${parsed.entryId}; radius=${parsed.radius}.`,
    ];
    const footer: string[] = [];
    if (!selectedSeen) footer.push(`Entry #${parsed.entryId} was not found in the visible transcript.`);
    if (rows.length === 0) footer.push("No displayable message/tool entry in this window.");
    if (hidden > 0) footer.push(`${hidden} entr${hidden === 1 ? "y" : "ies"} in the window had no displayable message/tool text and were not shown.`);
    footer.push("System, reset, compaction and thinking content is not shown; raw stored entries are not modified.");
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  const showModel = async (args: string): Promise<void> => {
    const host = offeredHost(io.modelSelection);

    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length === 0) {
      const listing = await host.list();
      const maxChoices = 50;
      const presets = listing.presets ?? [];
      if (presets.length > 0) {
        const rows = presets.slice(0, maxChoices).map((preset) => {
          const selected = preset.provider === listing.selected.provider
            && preset.modelId === listing.selected.modelId
            && (preset.thinkingLevel ?? "off") === listing.selected.thinkingLevel;
          const isDefault = preset.name === listing.defaultPreset;
          const level = safeLabel(preset.thinkingLevel ?? "off", 32);
          return `  ${selected ? "* " : "  "}${safeLabel(preset.name, 80)} — ${safeLabel(preset.provider, 80)} ${safeLabel(preset.modelId, 160)} [thinking: ${level}]${isDefault ? " (default)" : ""}`;
        });
        if (presets.length > maxChoices) rows.push(`  … ${presets.length - maxChoices} more named presets omitted`);
        await notice([
          `Current model: ${modelLabel(listing.selected)} (thinking: ${safeLabel(listing.selected.thinkingLevel, 32)}).`,
          ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${safeLabel(listing.defaultPreset, 80)}.`]),
          "Named model presets (see /help model to select one):",
          ...rows,
        ].join("\n"));
        return;
      }
      const rows = listing.models.slice(0, maxChoices).map((choice) => {
        const selected = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
        const levels = choice.thinkingLevels.map((level) => safeLabel(level, 32)).join(", ");
        return `  ${selected ? "* " : "  "}${safeLabel(choice.provider, 80)} ${safeLabel(choice.modelId, 160)} — ${safeLabel(choice.name, 160)} [thinking: ${levels || "off"}]`;
      });
      if (listing.models.length > maxChoices) rows.push(`  … ${listing.models.length - maxChoices} more allowed models omitted`);
      await notice([
        `Current model: ${modelLabel(listing.selected)} (thinking: ${safeLabel(listing.selected.thinkingLevel, 32)}).`,
        "Allowed models (see /help model to select one):",
        ...rows,
      ].join("\n"));
      return;
    }
    if (parts.length === 1) {
      if (host.selectPreset) {
        try {
          await host.selectPreset(parts[0]!);
          await notice(`Model: ${safeLabel(parts[0]!, 80)}.`);
        } catch (error) {
          if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
            await notice("Model preset selection rejected: this conversation is busy. Retry when it is idle.", true);
          } else {
            await notice("Model preset selection rejected: unknown name, unsupported thinking, or presets are not configured. Use /model to list named presets.", true);
          }
        }
        return;
      }
      await notice(conversationCommandUsage("model"), true);
      return;
    }
    if (parts.length > 3 || parts.some((part) => !part)) {
      await notice(conversationCommandUsage("model"), true);
      return;
    }
    const selection = { provider: parts[0]!, modelId: parts[1]!, ...(parts[2] === undefined ? {} : { thinkingLevel: parts[2]! as ModelThinkingLevel }) };
    try {
      const selected = await host.select(selection);
      await notice(`Model: ${modelLabel(selected)} (thinking: ${safeLabel(selected.thinkingLevel, 32)}).`);
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Model selection rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Model unchanged: choice unavailable. Use /model to list choices.", true);
      }
    }
  };

  const refreshContext = async (args: string): Promise<void> => {
    if (args.trim()) { await notice(conversationCommandUsage("refresh"), true); return; }
    const host = offeredHost(io.contextRefresh);
    try {
      await host.refresh();
    } catch (error) {
      if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
        await notice("Context refresh rejected: this conversation is busy. Retry when it is idle.", true);
      } else {
        await notice("Context refresh failed; the previous snapshot is still in effect.", true);
      }
      return;
    }
    await notice("Context refreshed.");
  };

  const showTools = async (args: string): Promise<void> => {
    if (args.trim()) { await notice(conversationCommandUsage("tools"), true); return; }
    const policy = offeredHost(io.toolPolicy);
    if (policy.tools.length === 0) {
      await notice("Coding tools disabled. Set toolAllowlist and restart to enable.");
      return;
    }
    await notice(`Coding tools: ${policy.tools.join(", ")}. Change toolAllowlist and restart to update.`);
  };

  const showStatus = async (): Promise<void> => {
    const status: TerminalStatus = await conversation.status(operationContext);
    const queueSummary = `steer=${status.inbox.steer} followUp=${status.inbox.followUp} write=${status.inbox.write}`;
    const queueNote = status.inbox.total > status.inbox.scanned ? ` (mode counts first ${status.inbox.scanned})` : "";
    const taskSummary = status.run === undefined
      ? "idle"
      : `busy (run task ${status.run.taskId}, ${status.run.inputs} input(s)${status.run.attempt === undefined ? "" : `, generation attempt ${status.run.attempt}`})`;
    const toolsNote = status.tools.total > status.tools.scanned ? ` (first ${status.tools.scanned})` : "";
    const lines = [
      `Model: ${modelLabel(status.model)}`,
      `Run: ${taskSummary}`,
      `Native inbox: ${status.inbox.total} queued (${queueSummary}${queueNote}); model tools running=${status.tools.running} pending=${status.tools.pending}${toolsNote}; compactions=${status.compactions}`,
      // Additive: an idle background is one line; an older host without the field adds nothing.
      ...renderBackgroundStatus(status.background),
      ...formatUsage(status.usage),
      "Unrecorded provider usage/charges: unknown.",
    ];
    await notice(lines.join("\n"));
  };

  /**
   * Store one operator-named file through the host and admit its path-only turn. The
   * path is local operator input; the stored locator and composed text come from the
   * host. A refusal is reported with fixed host text and never echoed as file bytes.
   */
  const attachFile = async (args: string): Promise<void> => {
    const host = offeredHost(io.attachments);
    const parsed = parseAttachArguments(args);
    if (parsed.kind === "usage") {
      await notice(ATTACH_USAGE, true);
      return;
    }
    if (reservedInputs >= MAX_PENDING_INPUTS) {
      await notice(`Input limit reached (${MAX_PENDING_INPUTS} unsettled submissions). Wait for a turn or use /abort.`, true);
      return;
    }
    reservedInputs++;
    let admitted: TerminalAttachmentSubmission;
    try {
      admitted = await host.submit(parsed.path, parsed.prompt, operationContext);
    } catch (error) {
      reservedInputs = Math.max(0, reservedInputs - 1);
      if (!signal?.aborted) {
        await notice(`Attachment was not submitted (${fixedErrorText(error)}).`, true);
      }
      return;
    }
    const submission = admitted.submission;
    submissions.set(submission.id, { id: submission.id, submission });
    rememberLocalInput(submission.id);
    waitForSubmission(submission.id, submission);
    await notice(
      `Stored attachment at ${safeLabel(admitted.attachment.relativePath, 200)} ` +
      `(${admitted.attachment.bytes} bytes) and admitted its turn.`,
    );
    if (interactive) {
      await notice(INTERACTIVE_PENDING_NOTICE);
      showPrompt();
    }
  };

  /**
   * One screen of controls: the generated listing, then one line for a command this host lacks and
   * one for the // escape. Per-command usage and detail stay in `/help <command>`.
   */
  const offerHelp = async (args: string): Promise<void> => {
    const available = offeredCommands();
    const requested = args.trim().toLowerCase();
    if (!requested) {
      const unavailable = conversationCommandNames("cli").filter((name) => !available.includes(name));
      await notice([
        conversationHelpListing("cli", available),
        ...(unavailable.length === 0
          ? []
          : [`Not offered by this host: ${unavailable.map((name) => `/${name}`).join(", ")}.`]),
        "Unknown slash commands are not sent to the model; prefix // to send one literally.",
      ].join("\n\n"));
      return;
    }
    const command = available.includes(requested) ? findConversationCommand(requested) : undefined;
    if (command === undefined) { await refuseTypedCommand(requested); return; }
    await notice(conversationDetailBlock(command));
  };

  const runCommand = async (name: string, args: string): Promise<void> => {
    // One catalogue refusal covers every name this host does not offer, before any handler runs.
    if (!offeredCommands().includes(name)) {
      await refuseTypedCommand(name);
      return;
    }
    switch (name) {
      case "help":
        await offerHelp(args);
        return;
      case "status":
        if (args.trim()) { await notice(conversationCommandUsage("status"), true); return; }
        await showStatus();
        return;
      case "history":
        await showHistory(args);
        return;
      case "search":
        await showSearch(args);
        return;
      case "episodes":
        await showEpisodes(args);
        return;
      case "episode":
        await showEpisode(args);
        return;
      case "entry":
        await showEntry(args);
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
      case "digest": {
        const host = offeredHost(io.digest);
        const argument = args.trim().toLowerCase();
        if (argument === "") {
          await notice(renderMemoryDigestStart(await host.start()));
          return;
        }
        if (argument === "status") {
          await notice(renderMemoryDigestStatus(await host.status()));
          return;
        }
        await notice(conversationCommandUsage("digest"), true);
        return;
      }
      case "mcp": {
        const host = offeredHost(io.mcp);
        if (args.trim() !== "") {
          await notice(conversationCommandUsage("mcp"), true);
          return;
        }
        await notice(renderMcpListing(await host.list()));
        return;
      }
      case "attach":
        await attachFile(args);
        return;
      case "compact": {
        if (args.trim()) { await notice(conversationCommandUsage("compact"), true); return; }
        const taskId = await conversation.compact(operationContext);
        await notice(`Compaction queued (${taskId}).`);
        return;
      }
      case "stop":
      case "abort":
        if (args.trim()) { await notice(conversationCommandUsage(name), true); return; }
        await conversation.abort(operationContext);
        await notice("Idle. Queue cleared.");
        return;
      case "new":
        if (args.trim()) { await notice(conversationCommandUsage("new"), true); return; }
        try {
          await conversation.reset(operationContext);
        } catch (error) {
          if (error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy")) {
            await notice("Reset refused: chat busy. /abort or retry /new when idle.", true);
            return;
          }
          throw error;
        }
        await notice(io.contextRefresh?.available ? "Context reset." : "Context reset queued.");
        return;
      case "restart": {
        if (args.trim()) { await notice(conversationCommandUsage("restart"), true); return; }
        try {
          await offeredHost(io.restart)();
        } catch (error) {
          // Only a busy refusal is a known no-effect. A lost acknowledgement can follow acceptance.
          const busy = error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
          await notice(busy && error instanceof Error ? error.message : RESTART_REFUSED, true);
          return;
        }
        await notice("Restarting; disconnecting.");
        io.closeInput?.();
        operationController.abort(new Error("gateway restart requested"));
        return;
      }
    }
  };

  const localCommand = (name: string, args: string): Promise<void> => {
    if (activeCommands >= MAX_ACTIVE_COMMANDS) {
      return notice(`Local command limit reached (${MAX_ACTIVE_COMMANDS} active controls).`, true);
    }
    activeCommands++;
    let task!: Promise<void>;
    task = admissionTail.then(() => {
      if (!signal?.aborted) return runCommand(name, args);
    })
      .catch(async (error: unknown) => {
        if (!signal?.aborted) await notice(`/${completePrefix(name, 80)} failed (${errorName(error)}).`, true);
      })
      .finally(() => {
        activeCommands--;
        commands.delete(task);
        showPrompt();
      });
    commands.add(task);
    admissionTail = task.catch(() => undefined);
    return Promise.resolve();
  };

  const onAbort = (): void => closeInput();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) closeInput();

  try {
    if (interactive) await notice(INTERACTIVE_ATTACH_NOTICE);
    showPrompt();
    for await (const line of input) {
      if (signal?.aborted) break;
      // This bounds admitted content after the source yields a complete line, not its ingress buffer.
      if (line.length > MAX_ADMITTED_LINE_CODE_UNITS) {
        await notice(`Input exceeds the ${MAX_ADMITTED_LINE_CODE_UNITS}-code-unit CLI limit.`, true);
        showPrompt();
        continue;
      }
      const leading = line.trimStart();
      if (!leading) {
        showPrompt();
        continue;
      }
      if (looksLikeOAuthCallback(line)) {
        // Even hosts without management must not admit an expired/foreign credential as input.
        const result = io.mcp === undefined
          ? { accepted: false, text: "No MCP login is available in this host; the callback was not stored or sent to the assistant." }
          : await io.mcp.submitCallback(line);
        await notice(result.text, !result.accepted);
      } else if (leading.startsWith(LITERAL_SLASH_PREFIX)) {
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
      showPrompt();
    }
    inputEnded = !signal?.aborted;

    await admissionTail;
    await Promise.allSettled([...commands]);
    while (waits.size > 0 && !signal?.aborted) {
      await Promise.race([...waits]);
      if (!inputEnded || !unansweredObserved || signal?.aborted || waits.size === 0) continue;
      const status = await conversation.status(operationContext);
      const idle = status.run === undefined;
      if (idle) {
        const queued: TerminalSubmission[] = [];
        for (const local of submissions.values()) {
          if ((await local.submission.status(operationContext)).status === "queued") queued.push(local.submission);
        }
        if (queued.length > 0) {
          await notice(`Disconnected; ${queued.length} input(s) remain queued. Reopen or /abort to withdraw.`, true);
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
    // A disconnect or abort never leaves an activity interval behind.
    inputEnded = true;
    stopActivity();
    for (const stream of outputStreams) stream.off("error", onOutputError);
    await watch.stop();
    await Promise.allSettled([...watchCallbacks, ...waits, ...commands]);
    await admissionTail;
    await outputTail;
    await renderTail;
    display?.close?.();
  }
  if (outputFailure !== undefined) throw outputFailure;
}

/**
 * Start one source read immediately, then yield it before iterating normally.
 *
 * The early read is kept awaitable for the terminal loop and marked handled so a
 * failure before the loop starts cannot surface as an unhandled rejection. The
 * generator's finally releases the source iterator if the loop is abandoned.
 */
function primedInput(source: AsyncIterable<string>): AsyncIterable<string> {
  const iterator = source[Symbol.asyncIterator]();
  const first = iterator.next();
  first.catch(() => undefined);
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        try {
          const initial = await first;
          if (initial.done === true) return;
          yield initial.value;
          while (true) {
            const next = await iterator.next();
            if (next.done === true) return;
            yield next.value;
          }
        } finally {
          if (iterator.return !== undefined) {
            try {
              await iterator.return();
            } catch {
              // Closing an input source is best effort; read failures propagate through next().
            }
          }
        }
      })();
    },
  };
}

function formatHistoryMessage(message: TerminalMessage): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const cleaned = sanitizeTerminalText(message.text).trim();
  if (!cleaned) return undefined;
  const characters = Array.from(cleaned);
  const snippet = characters.length > HISTORY_TEXT_CHARS
    ? `${characters.slice(0, HISTORY_TEXT_CHARS).join("")}…`
    : cleaned;
  return `${message.role === "user" ? "You" : "Assistant"}: ${snippet}`;
}

const SEARCH_USAGE = conversationCommandUsage("search");
const EPISODES_USAGE = conversationCommandUsage("episodes");
const EPISODE_USAGE = conversationCommandUsage("episode");
const ENTRY_USAGE = conversationCommandUsage("entry");
const ATTACH_USAGE = conversationCommandUsage("attach");

type AttachArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "attach"; readonly path: string; readonly prompt: string };

type SearchArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "next" }
  | {
    readonly kind: "search";
    readonly text: string;
    readonly scope: HistoryScope;
    readonly role?: HistoryRole;
    readonly limit: number;
  };

type EpisodesArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "list"; readonly query: HistoryEpisodeQuery; readonly session?: string };

type EpisodeArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "open"; readonly startEntryId: EntryId; readonly limit: number; readonly session?: string };

type EntryArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "entry"; readonly entryId: EntryId; readonly radius: number; readonly session?: string };

function parseSearchArguments(input: string): SearchArguments {
  let rest = input.trim();
  if (!rest) return { kind: "usage" };
  let scope: HistoryScope | undefined;
  let role: HistoryRole | undefined;
  let limit = DEFAULT_SEARCH_LIMIT;
  let explicit = false;
  let next = false;
  let sawLimit = false;
  let endOfOptions = false;
  while (rest.startsWith("--")) {
    const token = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (token === null) return { kind: "usage" };
    const flag = token[1]!;
    rest = (token[2] ?? "").trimStart();
    if (flag === "--") {
      endOfOptions = true;
      break;
    }
    if (flag === "--next") {
      if (next) return { kind: "usage" };
      next = true;
      explicit = true;
      continue;
    }
    if (next || (flag !== "--scope" && flag !== "--role" && flag !== "--limit")) return { kind: "usage" };
    const value = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (value === null) return { kind: "usage" };
    const raw = value[1]!;
    rest = (value[2] ?? "").trimStart();
    explicit = true;
    if (flag === "--scope") {
      if (scope !== undefined || (raw !== "messages" && raw !== "tools" && raw !== "all")) return { kind: "usage" };
      scope = raw;
    } else if (flag === "--role") {
      if (role !== undefined || (raw !== "user" && raw !== "assistant")) return { kind: "usage" };
      role = raw;
    } else {
      if (sawLimit || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_SEARCH_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    }
  }
  const text = rest.trim();
  if (endOfOptions && !text) return { kind: "usage" };
  if (next) {
    return endOfOptions || text || scope !== undefined || role !== undefined || sawLimit
      ? { kind: "usage" }
      : { kind: "next" };
  }
  if (scope === "tools" && role !== undefined) return { kind: "usage" };
  if (!text && !explicit) return { kind: "usage" };
  return {
    kind: "search",
    text,
    scope: scope ?? "messages",
    ...(role === undefined ? {} : { role }),
    limit,
  };
}

function parseEpisodesArguments(input: string): EpisodesArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let limit = DEFAULT_EPISODE_LIST_LIMIT;
  let before: EntryId | undefined;
  let session: string | undefined;
  let sawLimit = false;
  let sawBefore = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_EPISODE_LIST_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    } else if (token === "--before") {
      if (sawBefore) return { kind: "usage" };
      const parsed = parsePositiveEntryId(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      before = parsed;
      sawBefore = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else {
      return { kind: "usage" };
    }
  }
  return {
    kind: "list",
    query: { limit, ...(before === undefined ? {} : { before }) },
    ...(session === undefined ? {} : { session }),
  };
}

function parseEpisodeArguments(input: string): EpisodeArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let startEntryId: EntryId | undefined;
  let limit = DEFAULT_EPISODE_ENTRY_LIMIT;
  let session: string | undefined;
  let sawLimit = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_EPISODE_ENTRY_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else if (token.startsWith("--") || startEntryId !== undefined) {
      return { kind: "usage" };
    } else {
      startEntryId = parsePositiveEntryId(token);
      if (startEntryId === undefined) return { kind: "usage" };
    }
  }
  if (startEntryId === undefined) return { kind: "usage" };
  return { kind: "open", startEntryId, limit, ...(session === undefined ? {} : { session }) };
}

function parseEntryArguments(input: string): EntryArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let entryId: EntryId | undefined;
  let radius = 1;
  let session: string | undefined;
  let sawRadius = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--radius") {
      if (sawRadius) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[0-9]$/.test(raw) || Number(raw) > ENTRY_VIEW_MAX_RADIUS) return { kind: "usage" };
      radius = Number(raw);
      sawRadius = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else if (token.startsWith("--") || entryId !== undefined) {
      return { kind: "usage" };
    } else {
      entryId = parsePositiveEntryId(token);
      if (entryId === undefined) return { kind: "usage" };
    }
  }
  if (entryId === undefined) return { kind: "usage" };
  return { kind: "entry", entryId, radius, ...(session === undefined ? {} : { session }) };
}

function parseSessionKey(value: string | undefined): string | undefined {
  return historySessionToken(value);
}

/** The first ` -- ` separates the path from the optional prompt; paths may contain spaces. */
function parseAttachArguments(input: string): AttachArguments {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "usage" };
  const marker = " -- ";
  const index = trimmed.indexOf(marker);
  const path = (index < 0 ? trimmed : trimmed.slice(0, index)).trim();
  const prompt = index < 0 ? "" : trimmed.slice(index + marker.length).trim();
  if (path === "" || path.startsWith("--")) return { kind: "usage" };
  return { kind: "attach", path, prompt };
}

function parsePositiveEntryId(value: string | undefined): EntryId | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id as EntryId : undefined;
}

function formatHistoryHit(hit: HistoryHit, ordinal: number): string {
  const meta = [
    `entry=${hit.entryId}`,
    `session=${safeLabel(hit.sessionKey, 80)}`,
    `conversation=${hit.conversationId}`,
    `episode=${hit.episodeStartEntryId}`,
    `kind=${safeLabel(hit.entryKind, 40)}`,
  ];
  if (hit.toolName !== undefined) meta.push(`tool=${safeLabel(hit.toolName, 80)}`);
  if (hit.toolCallId !== undefined) meta.push(`call=${safeLabel(hit.toolCallId, 80)}`);
  if (hit.timestamp !== undefined) meta.push(`time=${formatHistoryTimestamp(hit.timestamp)}`);
  if (hit.partIndex > 0) meta.push(`part=${hit.partIndex}`);
  if (hit.chunkIndex > 0) meta.push(`chunk=${hit.chunkIndex}`);
  const excerpt = completePrefix(sanitizeTerminalText(hit.excerpt), SEARCH_EXCERPT_CHARS) || "(empty excerpt)";
  const flags: string[] = [];
  if (hit.excerptTruncated) flags.push("excerpt truncated");
  if (hit.bodyTruncated) flags.push("body truncated in index");
  const sessionToken = historySessionToken(hit.sessionKey);
  const navigation = sessionToken === undefined
    ? "   navigate: drilldown suppressed; the exact session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units."
    : `   open: /entry --session ${sessionToken} ${hit.entryId} --radius 1; episode: /episode --session ${sessionToken} ${hit.episodeStartEntryId}`;
  return [
    `${ordinal}. [${hit.role}] ${meta.join(" ")}`,
    `   ${excerpt.replace(/\n/g, "\n   ")}`,
    ...(flags.length === 0 ? [] : [`   (${flags.join("; ")})`]),
    navigation,
  ].join("\n");
}

function historyCoverageComplete(coverage: HistoryCoverage): boolean {
  return coverage.complete && coverage.malformedEntries === 0 && coverage.malformedMessages === 0;
}

function formatHistoryCoverage(coverage: HistoryCoverage): string[] {
  const lines = [
    `Index: ${countLabel(coverage.indexedEntries, "indexed entry", "indexed entries")} across ${countLabel(coverage.chatSessions, "chat session")}; ${countLabel(coverage.resetBoundaries, "reset boundary", "reset boundaries")}; boundary entry ${coverage.boundaryEntryId}.`,
  ];
  if (coverage.pendingEntries > 0 || !coverage.pendingComplete) {
    const pending = `${coverage.pendingEntries}${coverage.pendingComplete ? "" : "+"}`;
    lines.push(`Lag: ${pending} pending entr${coverage.pendingEntries === 1 && coverage.pendingComplete ? "y" : "ies"} (${coverage.pendingComplete ? "counted" : "lower bound"}).`);
  }
  if (!coverage.sync.caughtUp) {
    lines.push(`Reconciliation stopped at ${coverage.sync.entriesScanned}/${coverage.sync.entryLimit} entries in this pass; the next search continues.`);
  }
  if (coverage.truncatedParts > 0) lines.push(`Text omitted in the index: ${countLabel(coverage.truncatedParts, "truncated part")}.`);
  if (coverage.editsUnsupported > 0) {
    lines.push(`Context edits are not projected: ${countLabel(coverage.editsUnsupported, "entry", "entries")} search as raw stored text.`);
  }
  if (coverage.malformedEntries > 0 || coverage.malformedMessages > 0) {
    lines.push(`Malformed stored records: ${coverage.malformedEntries} entr${coverage.malformedEntries === 1 ? "y" : "ies"}, ${coverage.malformedMessages} message${coverage.malformedMessages === 1 ? "" : "s"}.`);
  }
  lines.push(historyCoverageComplete(coverage)
    ? "Index: complete for this store snapshot and captured boundary; a later entry needs a fresh search."
    : "Index: INCOMPLETE — results are a bounded partial view and a no-hit answer does not prove absence.");
  return lines;
}

function formatBrowsedEntry(entry: TerminalEntry, selected: boolean): string | undefined {
  const body = browsedEntryBody(entry);
  if (body === undefined) return undefined;
  const text = completePrefix(sanitizeTerminalText(body.text), ENTRY_TEXT_CHARS).trim();
  if (!text) return undefined;
  const flags: string[] = [];
  if (selected) flags.push("selected");
  if (entry.edited === true) flags.push("raw entry; context edits not applied");
  return [
    `#${entry.id} [${body.label}] kind=${safeLabel(entry.kind, 40)}${flags.length === 0 ? "" : ` (${flags.join("; ")})`}`,
    `  ${text.replace(/\n/g, "\n  ")}`,
  ].join("\n");
}

function browsedEntryBody(entry: TerminalEntry): { readonly label: string; readonly text: string } | undefined {
  const message = entry.messages[0];
  if (message === undefined) return undefined;
  if (entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND) {
    if (message.role !== "user") return undefined;
    return message.text.trim() ? { label: entry.kind === CRON_INPUT_ENTRY_KIND ? "user (cron)" : "user", text: message.text } : undefined;
  }
  if (entry.kind === AssistantEntry.kind) {
    if (message.role !== "assistant") return undefined;
    let text = message.text;
    for (const call of message.toolCalls ?? []) {
      text += `\n[tool call ${safeLabel(call.name, 80)}${call.argumentsText === undefined ? "" : ` ${sanitizeTerminalText(call.argumentsText)}`}]`;
    }
    return text.trim() ? { label: "assistant", text } : undefined;
  }
  if (entry.kind === ToolResultEntry.kind) {
    if (message.role !== "toolResult") return undefined;
    return { label: `tool ${safeLabel(message.toolName ?? "unknown", 80)}`, text: message.text.trim() ? message.text : "(no text content)" };
  }
  return undefined;
}

function formatHistoryTimestamp(value: number): string {
  if (!Number.isFinite(value)) return "invalid";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBoundedHistory(
  header: readonly string[],
  footer: readonly string[],
  rows: readonly string[],
): string {
  const reserve = 160;
  const metadata = [...header, ...footer].join("\n");
  if (metadata.length > HISTORY_VIEW_CHARS - reserve) {
    return `${completePrefix(metadata, HISTORY_VIEW_CHARS - reserve)}\n[History metadata truncated by the terminal output bound; view limits were still applied.]`;
  }
  const visible: string[] = [];
  let used = metadata.length;
  for (const row of rows) {
    if (used + row.length + 2 > HISTORY_VIEW_CHARS - reserve) break;
    visible.push(row);
    used += row.length + 1;
  }
  const lines = [...header, ...footer];
  if (visible.length > 0) lines.push("", ...visible);
  const omitted = rows.length - visible.length;
  if (omitted > 0) {
    lines.push(`[${omitted} additional row(s) omitted by the terminal output bound; narrow the view or lower the limit.]`);
  }
  return lines.join("\n");
}

function safeLabel(value: string, max: number): string {
  return completePrefix(sanitizeTerminalText(value).replace(/\s+/gu, " ").trim(), max) || "(empty)";
}

function historySessionToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 200) return undefined;
  if (/\s/u.test(value)) return undefined;
  // The exact key must survive terminal sanitization unchanged: LRM/RLM/ALM, bidi
  // isolates, C0/C1 controls and unpaired surrogates would otherwise change it.
  return sanitizeTerminalText(value) === value ? value : undefined;
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

/**
 * Bounded host text for an attachment refusal. The local gateway rejects with
 * fixed, value-free messages; anything else the host throws is sanitized and cut
 * to a short line so a raw stack, dependency dump or long path is never printed.
 */
function fixedErrorText(error: unknown): string {
  if (error instanceof Error) {
    const text = completePrefix(sanitizeTerminalText(error.message), 200).trim();
    if (text) return text;
  }
  return "unknown error";
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
