/**
 * Shared Durable task-runtime primitives for background work (cron runs, workers, memory digestion
 * and episode summaries).
 *
 * These are the mechanical pieces every background task repeats: a terminal outcome, waiting for a
 * submitted turn without hanging on a run that ended unanswered, reading the assistant's answer,
 * stopping a task-owned target conversation, the startup-interruption disposition, and proving that
 * an internal result was really admitted before a record is marked delivered. Authority, outcome
 * policy and record shapes stay in each task module.
 */
import type { Context } from "@earendil-works/chord";
import {
  InboxDoc,
  type ConversationHandle,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type NextTaskState,
  type Submission,
  type SubmissionRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  consumeInterruptedRunReport,
  InterruptedRunReportsDoc,
  interruptedRunReportPending,
} from "../recovery/interruption.js";

/** A committing handle: a Harness, a Session conversation or a host's session line. */
export interface Committer {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}

/**
 * The committing handle a background start needs for one conversation's documents. A tool call and
 * a host both commit conversation-scoped documents, so neither needs the full `Conversation` surface.
 */
export interface ConversationCommitter extends Committer {
  readonly id: ConversationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------------ */
/* Terminal outcomes                                                         */
/* ------------------------------------------------------------------------ */

export const terminalCompleted = <S, R>(result: R): NextTaskState<S, R> =>
  ({ status: "terminal", outcome: { status: "completed", result } });

export const terminalAborted = <S, R>(result: R, reason: string): NextTaskState<S, R> =>
  ({ status: "terminal", outcome: { status: "aborted", reason, result } });

export const terminalFailed = <S, R>(result: R, message: string): NextTaskState<S, R> =>
  ({ status: "terminal", outcome: { status: "failed", error: { message }, result } });

/* ------------------------------------------------------------------------ */
/* Turn waits and answers                                                    */
/* ------------------------------------------------------------------------ */

/**
 * `settled`: the submission reached `done` or `unanswered`. `ended`: the target went idle while the
 * submission was still `queued` or `placed`; a queued input has been withdrawn so a later turn
 * cannot answer it after the caller records a failure.
 */
export type TurnWait =
  | { readonly kind: "settled"; readonly record: SubmissionRecord }
  | { readonly kind: "ended"; readonly record: SubmissionRecord };

/**
 * Wait for a submitted turn, but also notice a run that ended without answering it. Durable's
 * default `afterFailedRun: "keep"` leaves the input queued, so waiting only on `submission.wait()`
 * would never finish. Once the target is idle, a still-queued input has no run left to answer it.
 */
export async function waitForTurnAnswer(
  submission: Submission,
  conversation: Pick<ConversationHandle, "waitForIdle">,
  context: Context,
): Promise<TurnWait> {
  const settled = submission.wait(context).then(
    (record) => ({ kind: "settled" as const, record: record as SubmissionRecord }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const idle = conversation.waitForIdle(context).then(
    () => ({ kind: "idle" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  // A losing side may reject later; it must not become an unhandled rejection.
  void settled.catch(() => undefined);
  void idle.catch(() => undefined);
  const first = await Promise.race([settled, idle]);
  if (first.kind === "failed") throw first.error;
  if (first.kind === "settled") return first;
  const record = await submission.status(context);
  if (record.status === "done" || record.status === "unanswered") return { kind: "settled", record };
  // `abort()` withdraws only a queued input; a placed one reports `already_placed`.
  try { await submission.abort(context); } catch { /* already placed or settled */ }
  return { kind: "ended", record };
}

/** The visible text of an entry's first model message (an assistant answer), joined without separators. */
export function extractAssistantText(entry: { readonly model?: readonly unknown[] } | undefined): string {
  const message = entry?.model?.[0];
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

/* ------------------------------------------------------------------------ */
/* Task-owned target conversations                                           */
/* ------------------------------------------------------------------------ */

/**
 * Stop a task-owned target conversation's pending work with the native conversation abort (withdraw
 * queued inputs, abort its live non-background tasks). Best effort and scoped to that target only:
 * the caller's terminal commit still retires captured authority, so a target that somehow runs
 * again has none.
 */
export async function withdrawTargetWork(
  runtime: { conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<unknown> } | undefined> },
  target: ConversationId,
  context: Context,
): Promise<void> {
  try {
    const conversation = await runtime.conversation(target, context);
    if (conversation !== undefined) await conversation.abort(context);
  } catch {
    // A retired capture is the durable guarantee; this only stops extra work sooner.
  }
}

/**
 * Whether an automatic startup interruption is recorded for this run's target, which suppresses the
 * run's own internal report (manual continuation only). An unreadable record never blocks the
 * caller's terminal commit: it reads as "not suppressed" and the run reports as usual.
 */
export async function interruptedRunSuppressed(
  reader: { snapshot(doc: typeof InterruptedRunReportsDoc, context: Context): Promise<unknown> },
  taskId: number,
  target: ConversationId,
  context: Context,
): Promise<boolean> {
  try {
    return interruptedRunReportPending(
      await reader.snapshot(InterruptedRunReportsDoc, context) as Parameters<typeof interruptedRunReportPending>[0],
      taskId,
      target,
    );
  } catch {
    return false;
  }
}

/** Consume the interruption disposition inside the terminal commit, so a reopen cannot resurrect it. */
export async function consumeInterruptedRun(tx: Tx, taskId: number, target: ConversationId): Promise<void> {
  consumeInterruptedRunReport(await tx.doc(InterruptedRunReportsDoc), taskId, target);
}

/* ------------------------------------------------------------------------ */
/* Verified internal-result delivery                                         */
/* ------------------------------------------------------------------------ */

/** The entry kind and task id an internal result event is admitted as. */
export interface InternalResultIdentity {
  readonly kind: string;
  readonly taskId: number;
}

/** The entry one submission has actually placed, if any. A queued input has none yet. */
export function placedEntryOf(record: SubmissionRecord): EntryId | undefined {
  if (record.type !== "input") return undefined;
  if (record.status === "placed" || record.status === "done") return record.entry;
  return record.status === "unanswered" ? record.entry : undefined;
}

/** True only for this task's internal result entry in exactly this conversation. */
export function isInternalResultEntry(
  entry: EntryRecord | undefined,
  conversationId: ConversationId,
  expected: InternalResultIdentity,
): boolean {
  return entry !== undefined
    && entry.conversationId === conversationId
    && entry.kind === expected.kind
    && isRecord(entry.data)
    && entry.data.taskId === expected.taskId;
}

/**
 * Durable dedupes an input by request ID alone, not by entry kind. Before treating a request ID as a
 * result's admission, the placed entry must be this task's internal result in this exact
 * conversation. A missing or foreign entry is not proof; an unreadable one reads as no proof.
 */
export async function resultEntryMatches(
  committer: Committer,
  conversationId: ConversationId,
  expected: InternalResultIdentity,
  entryId: EntryId | undefined,
  context: Context,
): Promise<boolean> {
  if (entryId === undefined) return false;
  try {
    const entry = await committer.commit((tx) => tx.entry(entryId), context);
    return isInternalResultEntry(entry, conversationId, expected);
  } catch {
    return false;
  }
}

/**
 * Inside one commit: whether the submission under `requestId` carries this task's internal result,
 * either placed as its entry or, when `acceptQueued`, still waiting in the conversation's inbox with
 * exactly that entry. A foreign input under the same request ID never matches.
 */
export async function submissionCarriesResult(
  tx: Tx,
  conversationId: ConversationId,
  requestId: string,
  expected: InternalResultIdentity,
  options: { readonly acceptQueued: boolean },
): Promise<boolean> {
  const record = await tx.submissionByRequest(conversationId, requestId);
  if (record === undefined || record.type !== "input") return false;
  if (record.status === "queued") {
    if (!options.acceptQueued) return false;
    const inbox = await tx.doc(InboxDoc, conversationId);
    const item = inbox.items.find((candidate) => candidate.id === record.id);
    if (item === undefined || item.mode === "write") return false;
    const entry = item.entry as unknown;
    return isRecord(entry) && entry.kind === expected.kind && isRecord(entry.data) && entry.data.taskId === expected.taskId;
  }
  const entryId = placedEntryOf(record);
  return entryId !== undefined && isInternalResultEntry(await tx.entry(entryId), conversationId, expected);
}
