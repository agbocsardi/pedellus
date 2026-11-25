import type { Context } from "@earendil-works/chord";
import type {
  TerminalConversation,
  TerminalSettlement,
  TerminalSnapshot,
  TerminalSubmission,
} from "./conversation.js";
import {
  completePrefix,
  isHighSurrogate,
  isLowSurrogate,
  sanitizePartialText,
  sanitizeTerminalText,
} from "./text.js";

/**
 * Live answer rendering of one attached terminal: committed partials stream as deltas, the final
 * committed answer is reconciled against what was already shown (never retracting or duplicating
 * text), turn ends are reported once per run, and a run admitted by another host path prints its
 * committed answer once when it ends. All state here is in-memory and bounded.
 */

const MAX_RESPONSE_CHARS = 64_000;
const MAX_REMEMBERED_ANSWERS = 256;
/** Shared-turn end reports remembered, so one run reports its end once and distinct runs never collapse. */
const MAX_REMEMBERED_RUN_ENDS = 256;
const MAX_REMEMBERED_LOCAL_INPUTS = 1_024;
const MAX_EXTERNAL_RUNS = 64;
const ASSISTANT_LABEL = "Assistant:";

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

export interface StreamRendererDeps {
  /** Reads one committed assistant answer of the attached conversation. */
  readonly conversation: Pick<TerminalConversation, "answer">;
  /** The terminal's operation context. */
  readonly context: Context;
  /** Ordered, sanitized output; `toError` writes to the error output. */
  write(text: string, toError?: boolean): Promise<void>;
  /** The terminal's render serializer; every watch frame and settlement renders through it. */
  serializeRender<T>(operation: () => Promise<T>): Promise<T>;
  /** Interactive owner terminal: label each visible answer block. */
  readonly labelled: boolean;
  /** Called with each frame's run inputs recorded, before rendering it (activity refresh). */
  onRunObserved?(): void;
}

export interface StreamRenderer {
  /** Remember one admitted local submission, so its run's partials and answer are rendered here. */
  track(id: number, submission: TerminalSubmission): void;
  /** Forget a settled local submission and its run output once no sibling still needs it. */
  release(id: number): void;
  /** Render one committed watch frame; call inside the render serializer. */
  streamView(snapshot: TerminalSnapshot): Promise<void>;
  /** Reconcile one settled local submission's committed answer or turn end. */
  finishSubmission(submissionId: number, settled: TerminalSettlement): Promise<void>;
  /** Close any open streamed line, then write one notice line; call inside the serializer. */
  rawNotice(text: string, toError?: boolean): Promise<void>;
  /** `rawNotice` through the render serializer. */
  notice(text: string, toError?: boolean): Promise<void>;
  /** Unsettled local submissions, oldest first. */
  unsettled(): readonly TerminalSubmission[];
  /** Whether any unsettled local input is pending with no answer text begun yet. */
  awaitingAnswer(): boolean;
  /** Whether an unsettled local input is in the last observed run. */
  working(): boolean;
  /** Whether a local turn ended unanswered for a reason other than an owner abort. */
  readonly unansweredObserved: boolean;
}

export function createStreamRenderer(deps: StreamRendererDeps): StreamRenderer {
  const { conversation, write, serializeRender } = deps;
  const operationContext = deps.context;
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
  let observedRunInputs: readonly number[] = [];
  let unansweredObserved = false;

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

  /** Label each visible answer block, including continuations separated by owner/host text. */
  const labelAssistant = async (state?: GenerationOutput): Promise<void> => {
    if (!deps.labelled) return;
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
    deps.onRunObserved?.();
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

  return {
    track(id, submission) {
      submissions.set(id, { id, submission });
      rememberLocalInput(id);
    },
    release(id) {
      const local = submissions.get(id);
      submissions.delete(id);
      cleanupRun(local?.runTaskId);
    },
    streamView,
    finishSubmission,
    rawNotice,
    notice,
    unsettled() {
      return [...submissions.values()].map((local) => local.submission);
    },
    awaitingAnswer() {
      const pending = [...submissions.values()].filter((local) => !local.finalized);
      if (pending.length === 0) return false;
      // Only a local answer that has actually begun suppresses activity. An external answer must
      // not latch off a still-queued owner's spinner, nor may a finished sibling keep it suppressed.
      return !pending.some((local) => local.runTaskId !== undefined &&
        runOutputs.get(local.runTaskId)?.generation?.labelled);
    },
    working() {
      return [...submissions.values()].some((local) => !local.finalized && observedRunInputs.includes(local.id));
    },
    get unansweredObserved() {
      return unansweredObserved;
    },
  };
}

function limitResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return `${text}\n`;
  return `${completePrefix(text, MAX_RESPONSE_CHARS)}\n[Response truncated by the terminal output limit.]\n`;
}

function safeReason(reason: string): string {
  return completePrefix(sanitizeTerminalText(reason), 120) || "unknown";
}
