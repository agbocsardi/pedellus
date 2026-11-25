import { randomUUID } from "node:crypto";
import { copyJson, type Context, type Draft, type JsonValue } from "@earendil-works/chord";
import { AssistantEntry, ConversationBusy, InboxDoc, LiveDoc, ResetEntry, defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import type {
  ConversationHandle,
  ConversationId,
  Cursor,
  EntryId,
  Extension,
  Harness,
  NextTaskState,
  Submission,
  SubmissionRecord,
  Task,
  TaskId,
  TaskInspection,
  TaskRecord,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import {
  CRON_DEFAULT_TIME_ZONE,
  MAX_DATE_MS,
  materializeCronSchedule,
  nextCronOccurrence,
  parseCronScheduleRequest,
  type CronSchedule,
  type CronScheduleRequest,
} from "./cron-schedule.js";
import {
  CronDeliveryFaultsDoc,
  latestCronDeliveryFault,
  type CronDeliveryFault,
} from "./cron-delivery.js";
import {
  CRON_ONE_OFF_QUEUE_LIMIT,
  CronConversationDoc,
  ensureAutomationConversation,
  readOneOffQueue,
  type CronOneOffQueueEntry,
} from "./cron-conversations.js";
import {
  extractAssistantText,
  terminalAborted,
  terminalCompleted,
  terminalFailed,
  waitForTurnAnswer,
  type ConversationCommitter,
} from "../tasks/background.js";

export const CRON_EXTENSION_NAME = "nanobot.cron";
/** Entry kind for a scheduled input placed by the cron run. */
export const CRON_INPUT_ENTRY_KIND = "nanobot.cron";
export const CRON_TIMER_TASK_NAME = "nanobot.cron.timer";
export const CRON_RUN_TASK_NAME = "nanobot.cron.run";
export const CRON_JOBS_KIND = "nanobot.cron.jobs";
const DOC_VERSION = 1;
/** The timer task is unchanged; the run task gained the claim phase that picks its conversation. */
const TIMER_TASK_VERSION = 1;
const RUN_TASK_VERSION = 2;
/**
 * Fixed failure text for an occurrence whose one-off conversation already has the bound number of
 * admitted runs. It names no message, provider error or path, and the job record keeps it visible.
 */
const ONE_OFF_QUEUE_FULL =
  `one-off run queue is full (${CRON_ONE_OFF_QUEUE_LIMIT} admitted runs); this occurrence was not run`;
/**
 * Fixed failure text for an occurrence whose shared one-off queue cannot be read. The document is
 * never guessed at or rewritten: the occurrence is refused with visible text instead of faulting its
 * run task and blocking the job behind a blocked task.
 */
const ONE_OFF_QUEUE_MALFORMED = "one-off run queue is malformed; this occurrence was not run";
/**
 * How long a cancelled run waits for its automation conversation to go idle. It is a bound, not a
 * guarantee: a provider request that ignores the abort signal can keep running, and the next run
 * then simply queues behind it.
 */
const CRON_TARGET_ABORT_MS = 5_000;
/**
 * How long an origin-mode occurrence waits before re-checking that its chat may take its input. Avoid
 * placing an occurrence in the chat's native inbox beside an owner steer: a final boundary would place
 * the steer and the occurrence into the next run together, and the scheduled outbox and the chat would
 * then deliver that one committed answer twice. It waits here and rejects admission if a run starts.
 */
const CRON_ORIGIN_IDLE_RETRY_MS = 1_000;
const CRON_ORIGIN_IDLE_WAIT_MS = 5 * 60_000;

/** Host-authenticated identity captured when the job is created. */
export interface CronOwner {
  readonly [key: string]: JsonValue;
  readonly ownerId: string;
  readonly sessionKey: string;
}
export type CronMode = "background" | "origin";
/** One occurrence's explicit intent. Absent on historical job records means `message`. */
export type CronIntent = "message" | "digest";

export interface CronOutcome {
  readonly [key: string]: JsonValue;
  readonly scheduledAtMs: number;
  readonly finishedAtMs: number;
  /** `unknown` is an unresolved wait: the admitted input may still be answered after the run ended. */
  readonly status: "ok" | "error" | "unknown";
  readonly error: string | null;
  readonly conversationId: number;
}
export interface CronSkip {
  readonly [key: string]: JsonValue;
  readonly scheduledAtMs: number;
  readonly skippedAtMs: number;
  readonly reason: string;
  readonly executionTaskId: number | null;
}
export interface CronFault {
  readonly [key: string]: JsonValue;
  readonly taskId: number;
  readonly scheduledAtMs: number;
  readonly recordedAtMs: number;
  readonly error: string;
}

/**
 * One job definition plus two live pointers, its newest outcome, and its newest skip.
 *
 * There is no stored next time, occurrence array, or job lifecycle state machine. The timer task's
 * immutable input carries the next slot; the execution task and its record carry the current run.
 */
export interface CronJob {
  readonly [key: string]: JsonValue;
  readonly id: string;
  readonly owner: CronOwner;
  readonly name: string;
  readonly message: string;
  readonly mode: CronMode;
  /**
   * What one occurrence does. `message` (also the historical default when absent) submits the job
   * message as a turn. `digest` calls the host's memory-digestion entry for this origin instead; it
   * never submits the message and never runs in a task-owned background conversation.
   */
  readonly intent?: CronIntent;
  /**
   * Silences this job's successful automatic channel delivery for every occurrence, including one
   * whose answer is empty. A failure still queues its fixed sanitized notice. Optional so a job
   * document written before silent delivery existed keeps working: an absent value means `false`.
   */
  readonly silent?: boolean;
  readonly schedule: CronSchedule;
  readonly idempotencyKey: string;
  readonly createdAtMs: number;
  /** Bumped by cancellation; every timer and run commit checks it. */
  readonly generation: number;
  /** The only timer allowed to arm the next slot, or `null` once cancelled/settled. */
  readonly timerTaskId: number | null;
  /** The newest execution task; a non-terminal one makes the next due slot skip. */
  readonly executionTaskId: number | null;
  readonly cancelledAtMs: number | null;
  readonly lastOutcome: CronOutcome | null;
  readonly lastSkip: CronSkip | null;
  /** Newest execution-task fault seen by a timer before its pointer was replaced. */
  readonly lastFault: CronFault | null;
  /**
   * This job's own automation conversation, once a run has created one. Optional so a job document
   * written before automation conversations existed keeps working: an absent or stale value is
   * simply recreated by the next run. Only a recurring job records one; a one-off job uses the
   * origin's shared catch-all conversation below.
   */
  readonly conversationId?: number | null;
}
export interface CronJobsDocument {
  readonly [key: string]: JsonValue;
  readonly jobs: CronJob[];
  /**
   * The catch-all automation conversation this origin's one-off jobs share. Optional for the same
   * backward-compatibility reason as `CronJob.conversationId`, and created lazily on first use.
   */
  readonly oneOffConversationId?: number | null;
  /**
   * Durable FIFO of admitted one-off runs waiting for that conversation, in admission order. It
   * holds one entry per admitted but unfinished run, so it is bounded by the run queue limit rather
   * than by time or by the number of one-off jobs ever created.
   */
  readonly oneOffQueue?: CronOneOffQueueEntry[];
}

/** One job list per origin conversation. A fork starts empty. */
export const CronJobsDoc = defineDoc<CronJobsDocument>({
  kind: CRON_JOBS_KIND, version: DOC_VERSION, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ jobs: [] }),
  checkpointWhen: () => true,
});

/**
 * Whether this origin conversation has a live origin-mode occurrence that could still answer a turn in
 * it: the job's execution task is not terminal, so it is admitted and waiting for an idle chat, or it is
 * currently running here. A `background` occurrence answers in its own task-owned conversation and a
 * digest occurrence submits no input at all, so neither blocks an owner message from steering. This is a
 * predicate over durable records. Reading an absent job document creates its empty incarnation.
 */
export async function originOccurrencePending(tx: Tx, conversationId: ConversationId): Promise<boolean> {
  const doc = await tx.doc(CronJobsDoc, conversationId);
  for (const job of doc.jobs) {
    if (job.cancelledAtMs !== null || job.mode === "background" || job.intent === "digest") continue;
    if (job.executionTaskId === null) continue;
    const record = await tx.task(job.executionTaskId as TaskId);
    if (record !== undefined && record.state.status !== "terminal") return true;
  }
  return false;
}

/** Immutable input of both finite task kinds. */
export interface CronOccurrenceInput {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
  readonly generation: number;
}
export type CronTimerCheckpoint = { readonly phase: "fire" };
/**
 * Two phases, because a run may have to wait for its shared conversation: `claim` resolves and
 * records the target conversation, chooses this run's place in the durable queue and prepares the
 * run's authority in one commit; `execute` submits the occurrence and records the result. A crash
 * before the claim commit reruns it, and a crash after it resumes at `execute` without preparing a
 * second time.
 */
export type CronRunCheckpoint =
  | {
      readonly phase: "claim";
      /** No target is chosen until this claim commits. */
      readonly targetConversationId: null;
    }
  | {
      readonly phase: "execute";
      /** Chosen once, in the same commit as host preparation, then reused after a crash. */
      readonly targetConversationId: ConversationId;
      /** First deferred origin admission, persisted so a reopen cannot restart the wait bound. */
      readonly originWaitStartedAtMs?: number;
    };
export interface CronTimerResult {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
  readonly outcome: "admitted" | "skipped" | "cancelled" | "superseded" | "missing";
  readonly reason: string | null;
}
export interface CronRunResult {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
  /** `unknown` is an unresolved wait: the admitted input may still be answered after the run ended. */
  readonly outcome: "ok" | "error" | "unknown" | "cancelled" | "superseded" | "missing";
  readonly error: string | null;
}

export interface CronScheduleInput {
  readonly message: string;
  readonly schedule: CronScheduleRequest;
  /** Caller-stable retry key, scoped to the owner and origin conversation. */
  readonly idempotencyKey: string;
  readonly name?: string;
  /** Default `background`: each run gets a fresh, task-owned conversation. */
  readonly mode?: CronMode;
  /** Default `message`; `digest` invokes the host's bounded memory-digestion entry. */
  readonly intent?: CronIntent;
  /**
   * Default `false`. When true, a successful occurrence queues no automatic channel delivery
   * (including an empty answer); a failed occurrence still queues its sanitized notice. It has no
   * effect on a `digest` occurrence, which never queues a delivery either way.
   */
  readonly silent?: boolean;
}
export interface CronActor {
  readonly owner: CronOwner;
}
/**
 * The committing handle cron needs for a conversation's job document. A tool call and a host both
 * commit conversation-scoped documents, so neither needs the full `Conversation` surface.
 */
export type CronConversationWriter = ConversationCommitter;
/**
 * One run's durable preparation or finalization. Preparation runs in the commit that chooses the
 * run's target conversation; finalization runs in the commit that records the run's terminal result
 * or cancellation. A crash before either commit reruns its callback; a crash after it does not.
 * Preparation runs once per run even when the target conversation is the same one an earlier run
 * used, so authority and workspace context are never carried over from a previous episode.
 */
export interface CronPreparation {
  readonly tx: Tx;
  readonly job: CronJob;
  readonly occurrence: CronOccurrenceInput;
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
  readonly background: boolean;
}
/**
 * Optional durable preparation for one run. It runs in the commit that claims this run's
 * conversation and place in the queue, so its writes, the conversation choice and the queue entry
 * are atomic; a crash before that commit reruns it, and a crash after it does not. A background
 * run's authority therefore lives from that commit until the run's terminal commit, never across
 * runs: a job whose captured tools were narrowed by configuration loses them on its next run.
 */
export type CronPrepare = (preparation: CronPreparation, context: Context) => void | Promise<void>;
/**
 * One run's durable settlement in the same commit that records its terminal result or cancellation,
 * whether the target is the origin conversation (origin mode) or an automation conversation. It is
 * called for every terminal path that already prepared a target, so a host can retire that target's
 * captured authority when `background` is true, and can durably admit delivery for either mode. The
 * foundation itself changes no tool state and performs no external send.
 */
export interface CronFinalization {
  readonly tx: Tx;
  readonly job: CronJob | null;
  readonly occurrence: CronOccurrenceInput;
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
  readonly background: boolean;
  /**
   * Present only for a normal run settlement (success or error); `null` for a rejected, fenced,
   * superseded or cancelled terminal path. A host may durably record delivery here, in the same
   * commit as `lastOutcome`, without re-running or re-reading the model.
   */
  readonly delivery: CronRunDelivery | null;
}
/**
 * One normal run settlement. `answerEntryId` identifies the committed final assistant entry in the
 * target conversation, so a channel host can read its text without another model turn.
 */
export interface CronRunDelivery {
  readonly status: "ok" | "error";
  readonly error: string | null;
  readonly answerEntryId: EntryId | null;
}
/**
 * Optional finalization of one run's target in the same commit that records its terminal result or
 * cancellation. A host retires a separate target's authority when `background` is true; an
 * origin-mode target keeps the origin's own policy. Either mode may admit a successful final answer
 * to durable delivery here, without another model turn.
 */
export type CronFinalize = (finalization: CronFinalization, context: Context) => void | Promise<void>;

export interface CronScheduleReceipt {
  readonly jobId: string;
  readonly timerTaskId: number | null;
  readonly nextAtMs: number | null;
  readonly deduplicated: boolean;
}
export type CronWithdrawal = "aborted" | "already_placed" | "settled" | "not_found";
export type CronCancellation =
  | {
      readonly status: "cancelled";
      readonly timer: "marked" | "terminal" | null;
      readonly execution: "marked" | "terminal" | null;
      /** Result of withdrawing this occurrence's origin/target submission, when one was known. */
      readonly withdrawn: CronWithdrawal | null;
      /**
       * Post-commit failure while signalling a task or withdrawing queued work. The cancellation
       * itself is durably recorded; callers must not report the operation as failed.
       */
      readonly abortError: string | null;
      readonly job: CronJob;
    }
  | { readonly status: "already_terminal"; readonly job: CronJob }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

export type CronTaskStatus =
  | "pending" | "running" | "waiting" | "sleeping" | "completing"
  | "completed" | "failed" | "aborted" | "faulted" | "orphaned" | "parked" | "missing";
export interface CronTaskSummary {
  readonly taskId: number;
  readonly status: CronTaskStatus;
  readonly scheduledAtMs: number | null;
  readonly error: string | null;
  readonly reason: string | null;
}
/** The target conversation's current generation run, so a blocked target is not hidden. */
export interface CronTargetSummary {
  readonly conversationId: number;
  readonly taskId: number;
  readonly status: CronTaskStatus;
  readonly error: string | null;
  readonly reason: string | null;
}
export type CronJobStatus = CronTaskStatus | "scheduled" | "queued" | "cancelled" | "stopped";
/** Job plus state derived from its actual timer and execution tasks. */
export interface CronJobView {
  readonly job: CronJob;
  readonly status: CronJobStatus;
  readonly nextAtMs: number | null;
  readonly timer: CronTaskSummary | null;
  readonly execution: CronTaskSummary | null;
  readonly target: CronTargetSummary | null;
  /** Newest durable delivery fault for this job, sanitized; `null` when none is recorded. */
  readonly deliveryFault: CronDeliveryFault | null;
}

/**
 * Place one native reset boundary before an automation run's own input. The foundation calls it for
 * a background run whose input is not placed yet, so the previous episode stays stored and
 * searchable while the new run's model context starts empty. It must use Durable's own reset, never
 * a trim of stored entries; a host without it starts no boundary and every entry stays in context.
 */
export type CronReset = (conversationId: ConversationId, context: Context) => Promise<void>;

export interface CronFoundationOptions {
  /** Optional durable preparation. Without it no context or tool grant is added. */
  readonly prepare?: CronPrepare;
  /**
   * Optional durable finalization in the run's terminal commit. A separate target's authority is
   * retired when `background` is true; a successful final answer of either mode may be admitted to
   * durable delivery here.
   */
  readonly finalize?: CronFinalize;
  /**
   * Optional host entry for a `digest`-intent occurrence. The foundation passes the authenticated
   * origin conversation, never a task-owned target, and records no user/channel delivery for it;
   * only a failed or cancelled digest run reports an internal issue to that origin's agent, and a
   * successful run is silent.
   */
  readonly digest?: CronDigest;
  /**
   * Optional native reset boundary for one background run. Called only for an occurrence whose own
   * input is not placed yet and whose conversation does not already end at a reset entry, never in
   * origin mode and never for a digest occurrence.
   */
  readonly reset?: CronReset;
  /** The Harness clock (`HarnessOptions.now`); default `Date.now`. */
  readonly now?: () => number;
  /**
   * Whether owner messages are submitted with native steering. Only then can an owner steer and a queued
   * origin occurrence be placed into the same run at one final boundary, so only then does an origin
   * occurrence wait for a completely idle chat instead of queueing in it. Default `false` keeps the
   * historical queueing for hosts that never steer.
   */
  readonly ownerSteering?: boolean;
}

/** One `digest` occurrence, handed to the host without any model or channel work here. */
export interface CronDigestInvocation {
  readonly job: CronJob;
  readonly occurrence: CronOccurrenceInput;
  readonly originConversationId: ConversationId;
}
/**
 * Host settlement of one digest occurrence. `ok` means the host accepted (started, already caught
 * up, or one run already live); `error` carries bounded, value-free text shown in `cron list`.
 */
export interface CronDigestSettlement {
  readonly status: "ok" | "error";
  readonly error: string | null;
}
export type CronDigest = (
  invocation: CronDigestInvocation,
  context: Context,
) => CronDigestSettlement | Promise<CronDigestSettlement>;
export interface CronFoundation {
  /** Install before opening or resuming the Harness; registers the timer and run tasks. */
  readonly extension: Extension;
  schedule(
    actor: CronActor, conversation: CronConversationWriter, request: CronScheduleInput,
    context: Context,
  ): Promise<CronScheduleReceipt>;
  cancel(
    harness: Pick<Harness, "abortTask" | "waitForTask" | "commit" | "abortSubmission">,
    conversationId: ConversationId, jobId: string, actor: CronActor, context: Context,
  ): Promise<CronCancellation>;
  inspect(
    harness: Pick<Harness, "snapshot" | "getTask" | "inspect">,
    conversationId: ConversationId, jobId: string, actor: CronActor, context: Context,
  ): Promise<CronJobView | undefined>;
  list(
    harness: Pick<Harness, "snapshot" | "getTask" | "inspect">,
    conversationId: ConversationId, actor: CronActor, context: Context,
  ): Promise<CronJobView[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const sameOwner = (left: CronOwner, right: CronOwner): boolean =>
  left.ownerId === right.ownerId && left.sessionKey === right.sessionKey;

function ownerOf(actor: CronActor): CronOwner {
  const owner = actor?.owner;
  if (
    !isRecord(owner)
    || typeof owner.ownerId !== "string" || owner.ownerId === ""
    || typeof owner.sessionKey !== "string" || owner.sessionKey === ""
  ) {
    throw new TypeError("owner must carry non-empty ownerId and sessionKey");
  }
  return { ownerId: owner.ownerId, sessionKey: owner.sessionKey };
}

interface NormalizedRequest {
  readonly owner: CronOwner;
  readonly message: string;
  readonly name: string;
  readonly mode: CronMode;
  readonly intent: CronIntent;
  readonly silent: boolean;
  readonly schedule: CronScheduleRequest;
  readonly idempotencyKey: string;
}

const intentOf = (job: CronJob): CronIntent => job.intent === "digest" ? "digest" : "message";
const silentOf = (job: CronJob): boolean => job.silent === true;

function normalizeRequest(actor: CronActor, request: CronScheduleInput): NormalizedRequest {
  const owner = ownerOf(actor);
  if (!isRecord(request)) throw new TypeError("schedule request must be an object");
  const intent = request.intent === undefined ? "message" : request.intent;
  if (intent !== "message" && intent !== "digest") {
    throw new TypeError("intent must be 'message' or 'digest'");
  }
  if (typeof request.message !== "string" || (intent === "message" && request.message.trim() === "")) {
    throw new TypeError("message must be a non-empty string");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey === "") {
    throw new TypeError("idempotencyKey must be a non-empty string");
  }
  if (request.name !== undefined && typeof request.name !== "string") {
    throw new TypeError("name must be a string when provided");
  }
  if (request.silent !== undefined && typeof request.silent !== "boolean") {
    throw new TypeError("silent must be a boolean when provided");
  }
  const requestedMode = request.mode === undefined ? "background" : request.mode;
  if (requestedMode !== "background" && requestedMode !== "origin") {
    throw new TypeError("mode must be 'background' or 'origin'");
  }
  // A digest occurrence runs from the authenticated origin itself: it has no model turn and must
  // never create or borrow a task-owned background conversation's authority.
  const mode: CronMode = intent === "digest" ? "origin" : requestedMode;
  let schedule: CronScheduleRequest;
  try {
    schedule = parseCronScheduleRequest(request.schedule);
  } catch (error) {
    throw new TypeError(errorText(error));
  }
  // A digest occurrence never queues a channel delivery, so its delivery setting is normalized off
  // instead of being stored as a meaningless difference in the dedupe identity.
  const silent = intent === "digest" ? false : request.silent === true;
  return {
    owner,
    message: request.message.trim() === "" ? "Memory digestion run" : request.message,
    name: request.name?.trim() || (intent === "digest" ? "Memory digestion" : request.message.slice(0, 30)),
    mode,
    intent,
    silent,
    schedule,
    idempotencyKey: request.idempotencyKey,
  };
}

function sameScheduleRequest(job: CronJob, right: CronScheduleRequest): boolean {
  const left = job.schedule;
  if (right.kind === "after") {
    // The relative request was resolved once, at admission, so a replay names the original stored
    // deadline: createdAtMs is that admission and the stored at is already frozen. Comparing it
    // this way keeps a retry deduplicated after the deadline passes, and after a reopen, without
    // recalculating the deadline from the current clock.
    const replayAt = job.createdAtMs + right.afterMs;
    return left.kind === "at" && Number.isSafeInteger(replayAt) && left.at === replayAt;
  }
  if (left.kind === "at" && (right.kind === "at" || right.kind === "once")) {
    return left.at === right.at;
  }
  if (left.kind === "every" && right.kind === "every") return left.everyMs === right.everyMs;
  if (left.kind === "cron" && right.kind === "cron") {
    return left.expr === right.expr
      && left.timeZone === (right.timeZone ?? CRON_DEFAULT_TIME_ZONE);
  }
  return false;
}
function sameNormalizedRequest(job: CronJob, request: NormalizedRequest): boolean {
  return job.message === request.message
    && job.name === request.name
    && job.mode === request.mode
    && intentOf(job) === request.intent
    && silentOf(job) === request.silent
    && sameScheduleRequest(job, request.schedule);
}
function parseOccurrenceInput(value: unknown): CronOccurrenceInput | undefined {
  if (!isRecord(value) || typeof value.jobId !== "string" || value.jobId === "") return undefined;
  if (!Number.isSafeInteger(value.scheduledAtMs)) return undefined;
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) return undefined;
  return {
    jobId: value.jobId,
    scheduledAtMs: value.scheduledAtMs as number,
    generation: value.generation as number,
  };
}
const occurrenceKey = (jobId: string, scheduledAtMs: number): string =>
  `cron:${jobId}:${scheduledAtMs}`;
const copyJob = (job: Draft<CronJob> | CronJob): CronJob => copyJson(job) as unknown as CronJob;
const timerResult = (
  input: CronOccurrenceInput, outcome: CronTimerResult["outcome"], reason: string | null,
): CronTimerResult => ({
  jobId: input.jobId, scheduledAtMs: input.scheduledAtMs, outcome, reason,
});
const runResult = (
  input: CronOccurrenceInput, outcome: CronRunResult["outcome"], error: string | null,
): CronRunResult => ({
  jobId: input.jobId, scheduledAtMs: input.scheduledAtMs, outcome, error,
});
const zeroInput: CronOccurrenceInput = { jobId: "", scheduledAtMs: 0, generation: 0 };

interface WaitSettlement {
  readonly status: "ok" | "error" | "unknown";
  readonly error: string | null;
  readonly answerEntryId: EntryId | null;
}
/** An answer whose first line is exactly this marker reports that the occurrence failed. */
const CRON_FAILURE_MARKER = "[FAILED]";
function reportsFailure(entry: { readonly model?: readonly unknown[] } | undefined): boolean {
  return extractAssistantText(entry).trimStart().split(/\r?\n/, 1)[0]!.trim() === CRON_FAILURE_MARKER;
}
function outcomeOf(record: SubmissionRecord): WaitSettlement {
  if (record.status === "done" && record.type === "input") {
    return { status: "ok", error: null, answerEntryId: record.answer };
  }
  if (record.status === "unanswered" && typeof record.reason === "string") {
    const detail = record.detail === undefined ? "" : `: ${JSON.stringify(record.detail)}`;
    return { status: "error", error: `${record.reason}${detail}`, answerEntryId: null };
  }
  return { status: "error", error: "submission settled without an answer", answerEntryId: null };
}

/**
 * Whether an origin-mode occurrence may admit now. A live run means the occurrence would have to queue, so
 * it waits. A queued steer is the one remaining way an occurrence could share a final boundary, because
 * that boundary places one steer and one follow-up into the same next run; while an origin occurrence is
 * live an owner surface never admits a new steer, and the occurrence waits for a pre-existing one to drain.
 * Leftover queued follow-ups do not block it: only one follow-up is placed per boundary, so they can never
 * share a run with it.
 */
async function chatIdleForOccurrence(
  runtime: TaskRuntime<CronOccurrenceInput, CronRunCheckpoint, CronRunResult, object>,
  conversationId: ConversationId,
  context: Context,
): Promise<boolean> {
  let ready = false;
  await runtime.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversationId);
    const inbox = await tx.doc(InboxDoc, conversationId);
    ready = live.run === undefined && !inbox.items.some((item) => item.mode === "steer");
    return undefined;
  }, context);
  return ready;
}

/**
 * Wait for the native submission, but also notice a run that ended without answering it.
 * Durable's default `afterFailedRun: "keep"` leaves the input queued, so waiting only on
 * `submission.wait()` would never finish. Once the target is idle, a still-queued input has no
 * run left to answer it: withdraw it, record the error, and let the next timer continue. An
 * unresolved wait is neither: the admitted input may still be answered later, so the occurrence
 * records `unknown`, withdraws nothing and never retries the same input.
 */
async function waitForAnswer(
  submission: Submission, conversation: ConversationHandle, context: Context,
): Promise<WaitSettlement> {
  const wait = await waitForTurnAnswer(submission, conversation, context);
  if (wait.kind === "settled") return outcomeOf(wait.record);
  if (wait.kind === "unresolved") {
    return {
      status: "unknown",
      error: `run outcome unknown: the admitted input can still be answered (submission is ${wait.record?.status ?? "unreadable"}); withdrawal was not confirmed and nothing was retried`,
      answerEntryId: null,
    };
  }
  return {
    status: "error",
    error: `run ended before answering (submission is ${wait.record.status})`,
    answerEntryId: null,
  };
}

const TERMINAL_TASK: ReadonlySet<CronTaskStatus> = new Set([
  "completed", "failed", "aborted", "orphaned", "faulted", "missing",
]);
const UNHEALTHY_TASK: ReadonlySet<CronTaskStatus> = new Set([
  "parked", "failed", "aborted", "orphaned", "faulted", "missing",
]);

/**
 * Sanitize one stored instant before it is projected: a legacy or damaged record can carry a time
 * no renderer, receipt or operator wire bound can print. It projects as `null` — no renderable
 * time — instead of throwing, so such jobs stay inspectable and cancellable; admission and timer
 * arming refuse out-of-range times outright, so nothing new is written in that state.
 */
function renderableInstant(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS
    ? value
    : null;
}

function taskSummaryOf(
  taskId: number, task: TaskInspection | undefined,
  record: Awaited<ReturnType<Harness["getTask"]>>,
): CronTaskSummary {
  const state = record?.state;
  const blocked = task?.state.kind === "blocked" ? task.state : undefined;
  const status: CronTaskStatus = record === undefined
    ? "missing"
    : state?.status === "terminal"
      ? state.outcome.status
      : blocked !== undefined
        ? "parked"
        : state!.status;
  const outcome = state?.status === "terminal" ? state.outcome : undefined;
  return {
    taskId,
    status,
    scheduledAtMs: renderableInstant(
      record === undefined ? null : parseOccurrenceInput(record.input)?.scheduledAtMs ?? null,
    ),
    error: blocked?.error !== undefined
      ? errorText(blocked.error)
      : outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : null,
    reason: blocked?.reason
      ?? (outcome?.status === "aborted" || outcome?.status === "orphaned" ? outcome.reason ?? null : null),
  };
}

function jobStatusOf(
  job: CronJob, timer: CronTaskSummary | null,
  execution: CronTaskSummary | null, target: CronTargetSummary | null,
): CronJobStatus {
  if (job.cancelledAtMs !== null) return "cancelled";
  // An unhealthy timer or target must not be hidden by a still-running execution.
  if (timer !== null && UNHEALTHY_TASK.has(timer.status)) return timer.status;
  if (execution !== null && UNHEALTHY_TASK.has(execution.status)) return execution.status;
  if (target !== null && UNHEALTHY_TASK.has(target.status)) return target.status;
  // An admitted one-off run waiting for its shared conversation is queued, not running.
  if (execution !== null && execution.status === "waiting") return "queued";
  if (execution !== null && execution.status !== "completed" && execution.status !== "aborted") {
    return "running";
  }
  if (timer !== null) return TERMINAL_TASK.has(timer.status) ? "stopped" : "scheduled";
  if (execution !== null) return execution.status === "completed" ? "completed" : execution.status;
  return job.schedule.kind === "at" && job.lastOutcome !== null ? "completed" : "stopped";
}

function runTargetOf(record: Awaited<ReturnType<Harness["getTask"]>>): ConversationId | null {
  const state = record?.state;
  const checkpoint = state !== undefined && "checkpoint" in state ? state.checkpoint : undefined;
  if (isRecord(checkpoint) && typeof checkpoint.targetConversationId === "number") {
    return checkpoint.targetConversationId as ConversationId;
  }
  return null;
}

/** A live background cron run's task-owned target, recovered from its durable checkpoint. */
export interface CronBackgroundTarget {
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
}

/**
 * The target of one non-terminal cron run whose checkpoint already chose it. A background run's
 * target is task-owned and deliberately absent from the SessionMap, so it is restored from the run
 * task itself. An origin-mode run's target is the origin, which the map already restores.
 */
export function cronBackgroundTarget(task: unknown): CronBackgroundTarget | undefined {
  if (!isRecord(task) || task.kind !== CRON_RUN_TASK_NAME) return undefined;
  const { conversationId, state } = task;
  if (!Number.isSafeInteger(conversationId) || (conversationId as number) < 1) return undefined;
  if (!isRecord(state) || state.status === "terminal" || state.status === "completing") return undefined;
  if (!isRecord(state.checkpoint)) return undefined;
  const targetConversationId = state.checkpoint.targetConversationId;
  if (!Number.isSafeInteger(targetConversationId) || (targetConversationId as number) < 1) return undefined;
  if (targetConversationId === conversationId) return undefined;
  return {
    originConversationId: conversationId as ConversationId,
    targetConversationId: targetConversationId as ConversationId,
  };
}

async function viewsOf(
  harness: Pick<Harness, "snapshot" | "getTask" | "inspect">,
  conversationId: ConversationId, actor: CronActor, context: Context,
): Promise<CronJobView[]> {
  const caller = ownerOf(actor);
  const doc = await harness.snapshot(CronJobsDoc, conversationId, context);
  if (doc === undefined) return [];
  const jobs = doc.jobs.filter((job) => sameOwner(job.owner, caller));
  if (jobs.length === 0) return [];
  const live = new Map((await harness.inspect(context)).tasks.map((task) => [Number(task.record.id), task]));
  // Delivery faults are derived diagnostics; a corrupt fault document must not hide the job list.
  let deliveryFaults: unknown;
  try {
    deliveryFaults = await harness.snapshot(CronDeliveryFaultsDoc, conversationId, context);
  } catch {
    deliveryFaults = undefined;
  }
  return Promise.all(jobs.map(async (job) => {
    const timerRecord = job.timerTaskId === null
      ? undefined
      : await harness.getTask(job.timerTaskId as TaskId<CronTimerResult>, context);
    const timer = job.timerTaskId === null
      ? null
      : taskSummaryOf(job.timerTaskId, live.get(job.timerTaskId), timerRecord);
    const executionRecord = job.executionTaskId === null
      ? undefined
      : await harness.getTask(job.executionTaskId as TaskId<CronRunResult>, context);
    const execution = job.executionTaskId === null
      ? null
      : taskSummaryOf(job.executionTaskId, live.get(job.executionTaskId), executionRecord);
    const targetConversationId = runTargetOf(executionRecord);
    let target: CronTargetSummary | null = null;
    if (targetConversationId !== null) {
      const targetLive = await harness.snapshot(LiveDoc, targetConversationId, context);
      const targetTaskId = targetLive?.run?.taskId;
      if (targetTaskId !== undefined) {
        const summary = taskSummaryOf(
          Number(targetTaskId), live.get(Number(targetTaskId)),
          await harness.getTask(targetTaskId, context),
        );
        target = {
          conversationId: targetConversationId,
          taskId: Number(targetTaskId),
          status: summary.status,
          error: summary.error,
          reason: summary.reason,
        };
      }
    }
    return {
      job: copyJob(job),
      status: jobStatusOf(job, timer, execution, target),
      nextAtMs: timer !== null && !TERMINAL_TASK.has(timer.status) ? timer.scheduledAtMs : null,
      // `timer.scheduledAtMs` above is already `renderableInstant`-sanitized by taskSummaryOf.
      timer,
      execution,
      target,
      deliveryFault: latestCronDeliveryFault(deliveryFaults, job.id),
    };
  }));
}

interface RunFence {
  readonly job?: CronJob;
  readonly rejected?: NextTaskState<CronRunCheckpoint, CronRunResult>;
}

/**
 * Fence one run against the job record it was admitted for. A missing record, a generation change,
 * a cancellation, or a newer execution pointer means this task must neither run nor prepare
 * anything for that job; the caller retires an already-prepared target in the same commit.
 */
function runFence(
  found: CronJob | undefined, input: CronOccurrenceInput, taskId: TaskId<CronRunResult>,
): RunFence {
  if (found === undefined) {
    return {
      rejected: terminalFailed<CronRunCheckpoint, CronRunResult>(
        runResult(input, "missing", "cron job record is missing"), "cron job record is missing",
      ),
    };
  }
  if (found.generation !== input.generation) {
    return {
      rejected: terminalAborted<CronRunCheckpoint, CronRunResult>(
        runResult(input, "superseded", "job generation changed"), "superseded",
      ),
    };
  }
  if (found.cancelledAtMs !== null) {
    return {
      rejected: terminalAborted<CronRunCheckpoint, CronRunResult>(
        runResult(input, "cancelled", "cancelled before execution"), "cancelled",
      ),
    };
  }
  if (found.executionTaskId !== taskId) {
    return {
      rejected: terminalAborted<CronRunCheckpoint, CronRunResult>(
        runResult(input, "superseded", "job is owned by another execution"), "superseded",
      ),
    };
  }
  return { job: copyJob(found) };
}

/**
 * Remove one run's catch-all queue entry. It is written in the same commit as the run's terminal
 * outcome or cancellation, so an admitted run that will never execute leaves the queue with it.
 */
async function leaveOneOffQueue(
  doc: { oneOffQueue?: CronOneOffQueueEntry[] }, taskId: number,
): Promise<void> {
  try {
    const queue = readOneOffQueue(doc.oneOffQueue);
    const remaining = queue.filter((entry) => entry.taskId !== taskId);
    if (remaining.length === queue.length) return;
    doc.oneOffQueue = remaining;
  } catch {
    // This runs in a terminal commit: a damaged queue must not fault a run's recorded outcome.
    // A malformed queue then keeps its entries and stays visible to the claim phase that reads it.
  }
}

type CronRunRuntime = TaskRuntime<CronOccurrenceInput, CronRunCheckpoint, CronRunResult, object>;

/**
 * Read one recorded automation conversation and its own class marker before the claim commit. It is
 * a plain snapshot read, so an unadoptable pointer never even gets a document written onto it;
 * `ensureAutomationConversation` then decides adoption from this exact pair.
 */
async function recordedAutomationConversation(
  runtime: Pick<CronRunRuntime, "snapshot">,
  context: Context,
  recordedId: number | null | undefined,
): Promise<{ readonly id: number; readonly marker: unknown } | null> {
  if (recordedId === null || recordedId === undefined
    || !Number.isSafeInteger(recordedId) || recordedId < 1) return null;
  try {
    return {
      id: recordedId,
      marker: await runtime.snapshot(CronConversationDoc, recordedId as ConversationId, context),
    };
  } catch {
    return null;
  }
}

/** Build the deterministic timer plus execution controller. Gateway and delivery stay outside. */
export function createCronFoundation(options: CronFoundationOptions): CronFoundation {
  const prepare = options.prepare;
  const finalize = options.finalize;
  const digest = options.digest;
  const reset = options.reset;
  const clock = options.now ?? (() => Date.now());
  const originWaitsForIdle = options.ownerSteering === true;

  /**
   * Finish one already-prepared target inside the commit that ends its run. The target is the run
   * task's own conversation, chosen once in its checkpoint, so it cannot belong to a newer run.
   * `background` tells the host whether that target is a separate, task-owned conversation whose
   * captured authority is retired; an origin-mode target is the origin conversation itself and the
   * host leaves its policy alone. Delivery admission is offered for either mode.
   */
  const retireTarget = async (
    tx: Tx,
    originConversationId: ConversationId,
    targetConversationId: ConversationId,
    job: CronJob | null,
    occurrence: CronOccurrenceInput,
    delivery: CronRunDelivery | null,
    context: Context,
  ): Promise<void> => {
    if (finalize === undefined) return;
    await finalize({
      tx, job, occurrence, originConversationId, targetConversationId,
      background: targetConversationId !== originConversationId,
      delivery,
    }, context);
  };

  const runTask: Task<CronOccurrenceInput, CronRunCheckpoint, CronRunResult, object> =
    defineTask<CronOccurrenceInput, CronRunCheckpoint, CronRunResult>({
      name: CRON_RUN_TASK_NAME,
      version: RUN_TASK_VERSION,
      initial: () => ({ phase: "claim", targetConversationId: null }),
      // Stored version 1 chose its target and executed in one `run` phase. Mapping it to `execute`
      // lets an in-flight occurrence finish in the conversation it already prepared, whoever owns
      // it; one that crashed before choosing a target claims one under the conversation model.
      migrate: (input, checkpoint) => {
        const stored = isRecord(checkpoint) ? checkpoint : {};
        const target = stored.targetConversationId;
        const chosen = Number.isSafeInteger(target) && (target as number) > 0
          ? target as ConversationId
          : null;
        return {
          input: input as CronOccurrenceInput,
          checkpoint: (chosen === null
            ? { phase: "claim", targetConversationId: null }
            : { phase: "execute", targetConversationId: chosen }) as CronRunCheckpoint,
        };
      },
      phases: {
        /**
         * Resolve this run's conversation and its place in the shared queue, then prepare this run's
         * authority and workspace context — all in one commit. A run that has to wait behind another
         * one commits only its waiting state, so nothing is prepared and no authority exists while
         * it is queued.
         */
        claim: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          if (input === undefined) {
            await runtime.commit(
              () => terminalFailed<CronRunCheckpoint, CronRunResult>(
                runResult(zeroInput, "missing", "task input is invalid"), "task input is invalid",
              ),
              context,
            );
            return;
          }
          let refused: string | null = null;
          let waitFor: TaskId | null = null;
          let fenced = false;
          let prepareError: string | null = null;
          let target: ConversationId | null = null;
          // Read the recorded conversation pointers and their own class markers before the claim
          // commit. A snapshot read creates nothing, so a damaged or hand-edited pointer cannot even
          // have a marker written onto the chat it names; a pointer that changed before the commit
          // is simply not adopted and costs one new conversation. `Tx` has no non-creating
          // conversation-document read, so this pre-read is the only correct way to avoid
          // materializing a marker on an unrelated conversation. The marker is stale evidence by
          // commit time and `ensureAutomationConversation` re-reads owner, parent and marker there,
          // so owner/parent/root safety is decided in the transaction that also records the pointer:
          // no chat, root, fork or task-owned conversation can be pulled into the automation class.
          const before = await runtime.snapshot(CronJobsDoc, running.conversationId, context);
          const beforeJob = before?.jobs.find((candidate) => candidate.id === input.jobId);
          const jobPointer = await recordedAutomationConversation(
            runtime, context, beforeJob?.conversationId,
          );
          const oneOffPointer = await recordedAutomationConversation(
            runtime, context, before?.oneOffConversationId,
          );

          await runtime.commit(async (tx) => {
            const doc = await tx.doc(CronJobsDoc, running.conversationId);
            const fence = runFence(
              doc.jobs.find((candidate) => candidate.id === input.jobId), input, running.id,
            );
            if (fence.rejected !== undefined) {
              // A fenced run leaves the catch-all queue too: a one-off cancelled while the gateway
              // was down is claimed again on reopen and terminates here.
              await leaveOneOffQueue(doc, running.id);
              fenced = true;
              return fence.rejected;
            }
            const stored = doc.jobs.find((candidate) => candidate.id === input.jobId)!;
            const job = fence.job!;
            const background = job.mode === "background" && intentOf(job) !== "digest";
            if (!background) {
              // Origin mode keeps its semantics: the occurrence runs in the origin chat itself, and
              // the owner's own reset is that conversation's boundary.
              target = running.conversationId;
            } else if (job.schedule.kind !== "at") {
              // A recurring job keeps one conversation for its whole life; each run is an episode.
              target = await ensureAutomationConversation(tx, {
                originConversationId: running.conversationId,
                conversationClass: "recurring",
                jobId: job.id,
                recorded: jobPointer?.id === stored.conversationId ? jobPointer : null,
              });
              stored.conversationId = target;
            } else {
              // One-off jobs share one catch-all conversation per origin and queue on it.
              let queue: CronOneOffQueueEntry[] | null;
              try {
                queue = readOneOffQueue(doc.oneOffQueue);
              } catch {
                queue = null;
              }
              if (queue === null) {
                // A malformed queue is never guessed at or rewritten: the occurrence is refused with
                // visible text instead of faulting its run task and blocking the job behind it.
                refused = ONE_OFF_QUEUE_MALFORMED;
              } else {
                // An entry whose run task already ended can never execute, so it must not hold the
                // queue in front of a live occurrence after a crash or a lost pointer.
                const live: CronOneOffQueueEntry[] = [];
                for (const entry of queue) {
                  const record = await tx.task(entry.taskId as TaskId);
                  if (record !== undefined && record.state.status !== "terminal") live.push(entry);
                }
                if (!live.some((entry) => entry.taskId === running.id)) {
                  if (live.length >= CRON_ONE_OFF_QUEUE_LIMIT) refused = ONE_OFF_QUEUE_FULL;
                  else {
                    live.push({
                      jobId: job.id,
                      scheduledAtMs: input.scheduledAtMs,
                      taskId: running.id,
                    });
                  }
                }
                doc.oneOffQueue = live;
                // A refused occurrence leaves the conversation untouched: nothing is created or
                // classified for it, so a full queue never leaves a new catch-all behind.
                if (refused === null) {
                  const head = live[0];
                  if (head !== undefined && head.taskId !== running.id) {
                    // Waiting commits only this waiting state: a queued run needs no target yet, so
                    // it neither creates nor records a catch-all conversation. It re-reads the
                    // document when it wakes, so the one-catch-all-per-origin identity cannot be
                    // split by two runs claiming in the same tick.
                    waitFor = head.taskId as TaskId;
                  } else {
                    target = await ensureAutomationConversation(tx, {
                      originConversationId: running.conversationId,
                      conversationClass: "one-off",
                      jobId: null,
                      recorded: oneOffPointer?.id === doc.oneOffConversationId ? oneOffPointer : null,
                    });
                    doc.oneOffConversationId = target;
                  }
                }
              }
            }
            if (refused !== null) {
              // A full or unreadable queue: this occurrence is refused with fixed text the job record
              // keeps for `list`, the conversation is not touched, and no channel notice is invented.
              stored.lastOutcome = {
                scheduledAtMs: input.scheduledAtMs,
                finishedAtMs: runtime.now(),
                status: "error",
                error: refused,
                conversationId: target ?? running.conversationId,
              };
              return terminalCompleted<CronRunCheckpoint, CronRunResult>(
                runResult(input, "error", refused),
              );
            }
            if (waitFor !== null) {
              // Wait for the run ahead in the durable queue, then claim again: the order is the
              // document's order, so it survives a restart and is never decided in memory.
              return {
                status: "waiting",
                on: [waitFor],
                policy: "allSettled",
                checkpoint: { phase: "claim", targetConversationId: null },
              };
            }
            try {
              if (background && prepare !== undefined) {
                await prepare({
                  tx,
                  job: copyJob(stored),
                  occurrence: input,
                  originConversationId: running.conversationId,
                  targetConversationId: target!,
                  background: true,
                }, context);
              }
            } catch (error) {
              // Returning nothing leaves the task's state unchanged, but the staged document writes
              // still commit: this run's conversation, its marker, the job's or the origin's pointer
              // and the queue entry all stay, and nothing was prepared that could be retired.
              prepareError = `preparation failed: ${errorText(error)}`;
              return undefined;
            }
            return {
              status: "running",
              checkpoint: { phase: "execute", targetConversationId: target! },
            };
          }, context);

          // A run whose claim committed a terminal fence has already settled: there is nothing left
          // to finish, and finishing again would rely on the framework refusing a terminal task.
          if (fenced) return;
          if (runtime.signal.aborted || refused !== null) return;
          if (prepareError !== null || target === null) {
            await finishRun(
              runtime, running.conversationId, running.id, input,
              {
                status: "error",
                error: prepareError ?? "execution could not be prepared",
                answerEntryId: null,
              },
              target ?? running.conversationId, context,
            );
          }
        },

        /**
         * Submit this run's occurrence into its chosen conversation and record the settlement. The
         * job is fenced once more here, so a run cancelled after its claim neither places an input
         * nor keeps the authority its claim prepared.
         */
        execute: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          const targetConversationId = running.state.checkpoint.targetConversationId;
          if (input === undefined || targetConversationId === null) {
            await runtime.commit(
              () => terminalFailed<CronRunCheckpoint, CronRunResult>(
                runResult(input ?? zeroInput, "missing", "run checkpoint is invalid"),
                "run checkpoint is invalid",
              ),
              context,
            );
            return;
          }
          let job: CronJob | undefined;
          let wasRejected = false;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(CronJobsDoc, running.conversationId);
            const fence = runFence(
              doc.jobs.find((candidate) => candidate.id === input.jobId), input, running.id,
            );
            if (fence.rejected === undefined) {
              job = fence.job;
              return undefined;
            }
            wasRejected = true;
            await retireTarget(
              tx, running.conversationId, targetConversationId, null, input, null, context,
            );
            await leaveOneOffQueue(doc, running.id);
            return fence.rejected;
          }, context);
          if (wasRejected || job === undefined) return;

          const conversation = await runtime.conversation(targetConversationId, context);
          if (conversation === undefined) {
            await finishRun(
              runtime, running.conversationId, running.id, input,
              { status: "error", error: "target conversation is missing", answerEntryId: null },
              targetConversationId, context,
            );
            return;
          }

          const deferOrigin = async (): Promise<void> => {
            const checkpoint = running.state.checkpoint;
            const startedAt = checkpoint.phase === "execute"
              ? checkpoint.originWaitStartedAtMs ?? runtime.now()
              : runtime.now();
            if (runtime.now() - startedAt >= CRON_ORIGIN_IDLE_WAIT_MS) {
              await finishRun(
                runtime, running.conversationId, running.id, input,
                {
                  status: "error",
                  error: "scheduled run could not start within five minutes; chat work or queued steering is blocking it",
                  answerEntryId: null,
                },
                targetConversationId, context,
              );
              return;
            }
            await runtime.sleepUntil(runtime.now() + CRON_ORIGIN_IDLE_RETRY_MS, {
              phase: "execute", targetConversationId, originWaitStartedAtMs: startedAt,
            }, context);
          };

          let settlement: WaitSettlement;
          if (job.intent === "digest") {
            // A digest occurrence is a host entry, not a model turn: it asks for the same bounded
            // native execution a manual command uses, with this authenticated origin's current
            // authority. The message is never submitted and no target conversation is involved.
            try {
              settlement = digest === undefined
                ? { status: "error", error: "memory digestion is not available in this host", answerEntryId: null }
                : { ...(await digest({ job, occurrence: input, originConversationId: running.conversationId }, context)), answerEntryId: null };
            } catch (error) {
              if (runtime.signal.aborted) return;
              settlement = { status: "error", error: errorText(error), answerEntryId: null };
            }
            if (runtime.signal.aborted) return;
            await finishRun(
              runtime, running.conversationId, running.id, input, settlement,
              targetConversationId, context,
            );
            return;
          }
          try {
            const requestId = occurrenceKey(input.jobId, input.scheduledAtMs);
            // Keep an origin occurrence away from a queued owner steer: the native final boundary
            // would otherwise place both into one run and both delivery paths would send its answer.
            // Defer while a run or steer is present, then reject admission if a run starts meanwhile.
            // Other queued follow-ups may still precede it. A non-steering host keeps historical queueing.
            const origin = targetConversationId === running.conversationId && originWaitsForIdle;
            let settled: unknown;
            let boundaryPlaced = false;
            await runtime.commit(async (tx) => {
              settled = await tx.submissionByRequest(targetConversationId, requestId);
              if (settled !== undefined) return undefined;
              // The boundary is itself a durable entry: a retry after a crash between `reset(...)` and
              // `submit(...)` finds it as the newest entry and places no second one. A boundary that
              // is already the end of the conversation means the run's context is already empty.
              const newest = await tx.scanEntries({ conversationId: targetConversationId, order: "descending" }, 1);
              boundaryPlaced = newest.items[0]?.kind === ResetEntry.kind;
              return undefined;
            }, context);
            if (origin && settled === undefined && !(await chatIdleForOccurrence(runtime, targetConversationId, context))) {
              await deferOrigin();
              return;
            }
            // Each run is a new episode: a native reset boundary keeps every earlier entry stored
            // and searchable while this run's model context starts empty. It is the same native
            // reset `/new` places, admitted before this run's own input, so an ordered inbox keeps
            // the boundary ahead of the input even if another run is still finishing.
            if (settled === undefined && !boundaryPlaced && targetConversationId !== running.conversationId
              && reset !== undefined) {
              await reset(targetConversationId, context);
            }
            const submission = await conversation.submit({
              type: "input",
              // The job's own message is the whole input: the host appends no delivery instruction,
              // because delivery is the job's `silent` setting, never the run's own choice.
              content: job.message,
              requestId,
              entry: {
                kind: CRON_INPUT_ENTRY_KIND,
                data: {
                  jobId: input.jobId,
                  scheduledAtMs: input.scheduledAtMs,
                  generation: input.generation,
                  requestId,
                },
              },
              // Atomic re-check: an input that arrived after the idle read makes this throw instead of
              // queueing, so the occurrence sleeps and retries rather than joining that turn.
              ...(origin ? { whenBusy: "reject" as const } : {}),
            }, context);
            settlement = await waitForAnswer(submission, conversation, context);
          } catch (error) {
            if (runtime.signal.aborted) return;
            if (originWaitsForIdle && targetConversationId === running.conversationId && error instanceof ConversationBusy) {
              await deferOrigin();
              return;
            }
            settlement = { status: "error", error: errorText(error), answerEntryId: null };
          }
          if (runtime.signal.aborted) return;
          await finishRun(
            runtime, running.conversationId, running.id, input, settlement,
            targetConversationId, context,
          );
        },
      },

      abort: async (running, runtime, context) => {
        const parsed = parseOccurrenceInput(running.input);
        const input = parsed ?? zeroInput;
        const targetConversationId = running.state.checkpoint.targetConversationId;
        // Stop the shared conversation's own live work first: a cancelled occurrence must not keep a
        // model turn running in a conversation the next run will reuse, and a later abort would
        // withdraw that next run's own queued input. History is untouched, and a provider request
        // that ignores the signal only delays this bound, never the queue.
        if (targetConversationId !== null && targetConversationId !== running.conversationId) {
          const conversation = await runtime.conversation(targetConversationId, context);
          if (conversation !== undefined) {
            await new Promise<void>((resolve) => {
              const disarm = runtime.setTimer(resolve, CRON_TARGET_ABORT_MS);
              conversation.abort(context).then(
                () => { disarm(); resolve(); },
                () => { disarm(); resolve(); },
              );
            });
          }
        }
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(CronJobsDoc, running.conversationId);
          // A cancelled run leaves its queue, and gives up its target's authority, in this same
          // commit: an abort is not a reason to leave a prepared copy or a queued occurrence alive.
          await leaveOneOffQueue(doc, running.id);
          if (finalize !== undefined && targetConversationId !== null) {
            const job = doc.jobs.find((candidate) => candidate.id === parsed?.jobId);
            await retireTarget(
              tx, running.conversationId, targetConversationId,
              job === undefined ? null : copyJob(job), parsed ?? zeroInput, null, context,
            );
          }
          return terminalAborted<CronRunCheckpoint, CronRunResult>(
            runResult(input, "cancelled", "cancelled"), "cancelled",
          );
        }, context);
      },
    });

  const timerTask: Task<CronOccurrenceInput, CronTimerCheckpoint, CronTimerResult, object> =
    defineTask<CronOccurrenceInput, CronTimerCheckpoint, CronTimerResult>({
      name: CRON_TIMER_TASK_NAME,
      version: TIMER_TASK_VERSION,
      initial: () => ({ phase: "fire" }),
      phases: {
        // One phase: sleep, then rerun from the top when due and commit the atomic handoff.
        fire: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          if (input === undefined) {
            await runtime.commit(
              () => terminalFailed<CronTimerCheckpoint, CronTimerResult>(
                timerResult(zeroInput, "missing", "task input is invalid"),
                "task input is invalid",
              ),
              context,
            );
            return;
          }
          // A legacy persisted input can name a deadline no `Date` can represent. Durable recovery
          // re-runs this phase for a pending, interrupted or restored timer, so such a deadline
          // must never reach `sleepUntil` — the task would park on a sleep that is never due and
          // never settle — and must never arm or run an occurrence. The timer settles as failed
          // with fixed text and without touching the job record, which stays inspectable and
          // cancellable through the same paths as any other failed timer; a sleeping deadline
          // beyond the bound written by an older build can never become due, so it is equally
          // inert and remains cancellable through the abort path.
          if (input.scheduledAtMs < 0 || input.scheduledAtMs > MAX_DATE_MS) {
            const reason = "the persisted timer deadline is not a representable time";
            await runtime.commit(
              () => terminalFailed<CronTimerCheckpoint, CronTimerResult>(
                timerResult(input, "missing", reason),
                reason,
              ),
              context,
            );
            return;
          }
          const now = runtime.now();
          if (input.scheduledAtMs > now) {
            await runtime.sleepUntil(input.scheduledAtMs, { phase: "fire" }, context);
            return;
          }
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(CronJobsDoc, running.conversationId);
            const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
            if (job === undefined) {
              return terminalFailed<CronTimerCheckpoint, CronTimerResult>(
                timerResult(input, "missing", "cron job record is missing"),
                "cron job record is missing",
              );
            }
            if (job.generation !== input.generation) {
              return terminalAborted<CronTimerCheckpoint, CronTimerResult>(
                timerResult(input, "superseded", "job generation changed"), "superseded",
              );
            }
            if (job.cancelledAtMs !== null) {
              return terminalAborted<CronTimerCheckpoint, CronTimerResult>(
                timerResult(input, "cancelled", "cancelled before the slot fired"), "cancelled",
              );
            }
            if (job.timerTaskId !== running.id) {
              return terminalAborted<CronTimerCheckpoint, CronTimerResult>(
                timerResult(input, "superseded", "job is owned by another timer"), "superseded",
              );
            }

            const prior = job.executionTaskId === null
              ? undefined
              : await tx.task(job.executionTaskId as TaskId<CronRunResult>);
            const busy = prior !== undefined && prior.state.status !== "terminal";
            const nextAtMs = job.schedule.kind === "at"
              ? null
              : nextCronOccurrence(job.schedule, Math.max(now, input.scheduledAtMs));
            let executionTaskId: number | null = null;

            if (busy) {
              job.lastSkip = {
                scheduledAtMs: input.scheduledAtMs,
                skippedAtMs: now,
                reason: "previous occurrence is still active",
                executionTaskId: job.executionTaskId,
              };
            } else {
              if (prior?.state.status === "terminal") {
                const outcome = prior.state.outcome;
                if (outcome.status === "failed" || outcome.status === "faulted" || outcome.status === "orphaned") {
                  job.lastFault = {
                    taskId: Number(prior.id),
                    scheduledAtMs: parseOccurrenceInput(prior.input)?.scheduledAtMs ?? 0,
                    recordedAtMs: now,
                    error: outcome.status === "failed" || outcome.status === "faulted"
                      ? outcome.error.message
                      : outcome.reason,
                  };
                }
              }
              executionTaskId = await tx.createTask(
                runTask,
                { jobId: job.id, scheduledAtMs: input.scheduledAtMs, generation: job.generation },
                { ownership: { kind: "conversation" }, conversationId: running.conversationId, background: true },
              );
              job.executionTaskId = executionTaskId;
            }

            job.timerTaskId = nextAtMs === null
              ? null
              : await tx.createTask(
                  timerTask,
                  { jobId: job.id, scheduledAtMs: nextAtMs, generation: job.generation },
                  { ownership: { kind: "conversation" }, conversationId: running.conversationId, background: true },
                );

            const reason = busy ? "previous occurrence is still active" : null;
            return terminalCompleted<CronTimerCheckpoint, CronTimerResult>(
              timerResult(input, busy ? "skipped" : "admitted", reason),
            );
          }, context);
        },
      },

      abort: async (running, runtime, context) => {
        const input = parseOccurrenceInput(running.input) ?? zeroInput;
        await runtime.commit(
          () => terminalAborted<CronTimerCheckpoint, CronTimerResult>(
            timerResult(input, "cancelled", "cancelled"), "cancelled",
          ),
          context,
        );
      },
    });

  async function finishRun(
    runtime: TaskRuntime<CronOccurrenceInput, CronRunCheckpoint, CronRunResult, object>,
    conversationId: ConversationId, taskId: TaskId<CronRunResult>, input: CronOccurrenceInput,
    settlement: WaitSettlement, targetConversationId: ConversationId, context: Context,
  ): Promise<void> {
    const now = runtime.now();
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, conversationId);
      // A one-off run leaves the catch-all queue in the same commit as its outcome, whatever the
      // outcome is; a recurring or origin-mode run was never queued, so this changes nothing.
      await leaveOneOffQueue(doc, taskId);
      const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
      if (job === undefined) {
        await retireTarget(tx, conversationId, targetConversationId, null, input, null, context);
        return terminalFailed<CronRunCheckpoint, CronRunResult>(
          runResult(input, "missing", "cron job record is missing"), "cron job record is missing",
        );
      }
      // The run records only its result. It never computes or creates a schedule. A fenced-out run
      // still retires its already-prepared target in this same commit.
      if (job.generation !== input.generation) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, null, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "superseded", "job generation changed"), "superseded",
        );
      }
      if (job.cancelledAtMs !== null) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, null, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "cancelled", "cancelled before the run finished"), "cancelled",
        );
      }
      if (job.executionTaskId !== taskId) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, null, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "superseded", "job is owned by another execution"), "superseded",
        );
      }
      // A run that answered may still report that its own work failed. The marker can only turn an
      // answered occurrence into a failure, never suppress or alter a delivery, so it reaches the same
      // sanitized failure path as an unanswered run, `silent` or not. No model text is copied.
      if (settlement.status === "ok" && settlement.answerEntryId !== null
        && reportsFailure(await tx.entry(AssistantEntry, settlement.answerEntryId))) {
        settlement = { status: "error", error: "run reported failure", answerEntryId: null };
      }
      job.lastOutcome = {
        scheduledAtMs: input.scheduledAtMs,
        finishedAtMs: now,
        status: settlement.status,
        error: settlement.error,
        conversationId: targetConversationId,
      };
      // The run's authority ends with the run, in this same terminal commit. A separate target is
      // retired; the origin-mode target is the origin conversation itself and keeps its policy.
      // A digest occurrence queues no user/channel delivery: only a failed or cancelled digest run's
      // internal issue report reaches the origin agent, a successful run is silent, and the job
      // record keeps this bounded status for `cron list`. An unresolved wait delivers nothing: the
      // admitted input may still be answered, and a delivered failure receipt would misreport it.
      await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, intentOf(job) === "digest" || settlement.status === "unknown" ? null : {
        status: settlement.status,
        error: settlement.error,
        answerEntryId: settlement.answerEntryId,
      }, context);
      return terminalCompleted<CronRunCheckpoint, CronRunResult>(
        runResult(
          input,
          settlement.status === "ok" ? "ok" : settlement.status === "unknown" ? "unknown" : "error",
          settlement.error,
        ),
      );
    }, context);
  }

  async function abortOne(
    harness: Pick<Harness, "abortTask" | "waitForTask">,
    taskId: TaskId, context: Context,
  ): Promise<"marked" | "terminal"> {
    const result = await harness.abortTask(taskId, context);
    if (result === "marked") await harness.waitForTask(taskId, context);
    return result;
  }

  return {
    extension: defineExtension({ name: CRON_EXTENSION_NAME, tasks: [timerTask, runTask] }),

    async schedule(actor, conversation, request, context) {
      const now = clock();
      if (!Number.isSafeInteger(now)) {
        throw new TypeError("the cron clock must return an integer epoch-millisecond time");
      }
      const value = normalizeRequest(actor, request);
      return conversation.commit(async (tx) => {
        const doc = await tx.doc(CronJobsDoc, conversation.id);
        const existing = doc.jobs.find(
          (job) => job.idempotencyKey === value.idempotencyKey && sameOwner(job.owner, value.owner),
        );
        if (existing !== undefined) {
          if (!sameNormalizedRequest(existing, value)) {
            throw new TypeError("idempotencyKey already names a different cron job");
          }
          const timer = existing.timerTaskId === null
            ? undefined
            : await tx.task(existing.timerTaskId as TaskId<CronTimerResult>);
          return {
            jobId: existing.id,
            timerTaskId: existing.timerTaskId,
            nextAtMs: renderableInstant(
              timer === undefined ? null : parseOccurrenceInput(timer.input)?.scheduledAtMs ?? null,
            ),
            deduplicated: true,
          };
        }
        let schedule: CronSchedule;
        try {
          schedule = materializeCronSchedule(value.schedule, now);
        } catch (error) {
          throw new TypeError(errorText(error));
        }
        const firstAtMs = schedule.kind === "at"
          ? schedule.at
          : schedule.kind === "every"
            ? schedule.anchorMs
            : nextCronOccurrence(schedule, now);
        if (firstAtMs === null) throw new TypeError("schedule has no future occurrence");
        // The shared renderable bound, enforced before the job record or its timer is written: a
        // commit beyond it would arm an unrenderable instant no receipt or renderer can print.
        if (firstAtMs > MAX_DATE_MS) {
          throw new TypeError("the first occurrence is beyond the representable date range");
        }
        const jobId = `cron-${randomUUID()}`;
        const generation = 1;
        const timerTaskId = await tx.createTask(
          timerTask,
          { jobId, scheduledAtMs: firstAtMs, generation },
          { ownership: { kind: "conversation" }, conversationId: conversation.id, background: true },
        );
        doc.jobs.push({
          id: jobId,
          owner: value.owner,
          name: value.name,
          message: value.message,
          mode: value.mode,
          intent: value.intent,
          silent: value.silent,
          schedule,
          idempotencyKey: value.idempotencyKey,
          createdAtMs: now,
          generation,
          timerTaskId,
          executionTaskId: null,
          cancelledAtMs: null,
          lastOutcome: null,
          lastSkip: null,
          lastFault: null,
        });
        return { jobId, timerTaskId, nextAtMs: firstAtMs, deduplicated: false };
      }, context);
    },

    async cancel(harness, conversationId, jobId, actor, context) {
      const caller = ownerOf(actor);
      const now = clock();
      let timerTaskId: TaskId<CronTimerResult> | undefined;
      let executionTaskId: TaskId<CronRunResult> | undefined;
      let withdrawal: { conversationId: ConversationId; requestId: string } | undefined;

      const decision = await harness.commit(async (tx) => {
        const doc = await tx.doc(CronJobsDoc, conversationId);
        const job = doc.jobs.find((candidate) => candidate.id === jobId);
        if (job === undefined) return { status: "not_found" } as const;
        if (!sameOwner(job.owner, caller)) return { status: "forbidden" } as const;
        if (job.cancelledAtMs !== null) {
          return { status: "already_terminal", job: copyJob(job) } as const;
        }
        const timerRecord = job.timerTaskId === null
          ? undefined
          : await tx.task(job.timerTaskId as TaskId<CronTimerResult>);
        const executionRecord = job.executionTaskId === null
          ? undefined
          : await tx.task(job.executionTaskId as TaskId<CronRunResult>);
        const live = [timerRecord, executionRecord]
          .some((record) => record !== undefined && record.state.status !== "terminal");
        const settledOnce = job.schedule.kind === "at"
          && job.lastOutcome !== null
          && job.timerTaskId === null
          && executionRecord?.state.status === "terminal";
        if (settledOnce) return { status: "already_terminal", job: copyJob(job) } as const;
        if (!live && job.timerTaskId === null && job.executionTaskId === null) {
          return { status: "already_terminal", job: copyJob(job) } as const;
        }
        timerTaskId = job.timerTaskId === null
          ? undefined : job.timerTaskId as TaskId<CronTimerResult>;
        executionTaskId = job.executionTaskId === null
          ? undefined : job.executionTaskId as TaskId<CronRunResult>;
        const executionInput = executionRecord === undefined
          ? undefined : parseOccurrenceInput(executionRecord.input);
        const target = runTargetOf(executionRecord)
          ?? (job.mode === "origin" ? conversationId : null);
        // A digest run submits no occurrence message, so there is no queued submission to withdraw;
        // cancelling the job only stops this occurrence and every later one.
        if (executionInput !== undefined && target !== null && intentOf(job) !== "digest") {
          withdrawal = {
            conversationId: target,
            requestId: occurrenceKey(job.id, executionInput.scheduledAtMs),
          };
        }
        job.cancelledAtMs = now;
        job.generation += 1;
        job.timerTaskId = null;
        job.executionTaskId = null;
        return { status: "to_cancel", job: copyJob(job) } as const;
      }, context);

      if (decision.status !== "to_cancel") return decision;
      let timer: "marked" | "terminal" | null = null;
      let execution: "marked" | "terminal" | null = null;
      const failures: unknown[] = [];
      await Promise.all([
        timerTaskId === undefined
          ? undefined
          : abortOne(harness, timerTaskId, context)
            .then((result) => { timer = result; }, (error: unknown) => { failures.push(error); }),
        executionTaskId === undefined
          ? undefined
          : abortOne(harness, executionTaskId, context)
            .then((result) => { execution = result; }, (error: unknown) => { failures.push(error); }),
      ]);
      let withdrawn: CronWithdrawal | null = null;
      const pending = withdrawal;
      try {
        if (pending !== undefined) {
          const record = await harness.commit(
            (tx) => tx.submissionByRequest(pending.conversationId, pending.requestId),
            context,
          );
          withdrawn = record === undefined
            ? "not_found"
            : await harness.abortSubmission(record.id, context, pending.conversationId);
        }
      } catch (error) {
        failures.push(error);
      }
      // The cancellation commit above is final, and every timer/run commit checks the generation,
      // so a post-commit signalling failure cannot resurrect the job. Report it in the result; a
      // thrown error here would tell the caller the removal failed and invite a retry.
      return {
        status: "cancelled",
        timer,
        execution,
        withdrawn,
        abortError: failures.length === 0 ? null : errorText(failures[0]),
        job: decision.job,
      };
    },

    async inspect(harness, conversationId, jobId, actor, context) {
      return (await viewsOf(harness, conversationId, actor, context))
        .find((view) => view.job.id === jobId);
    },

    list(harness, conversationId, actor, context) {
      return viewsOf(harness, conversationId, actor, context);
    },
  };
}

/**
 * Recovery sweep for legacy damage, run once by the host that owns the process before it serves
 * anything: a timer task persisted by an older build can sleep on a deadline beyond the shared
 * renderable bound. Durable restores such a sleep at open and, because the deadline can never come
 * due, nothing would ever run the phase that settles it. The sweep commits an abort mark on exactly
 * those timers through the supported `abortTask` path. Durable's public task contract is that an
 * abort mark does not wait for a sleep's `until`, so the committed mark itself ends the sleep: the
 * task leaves the wake computation and becomes runnable, and the timer's own abort handler later
 * settles it "cancelled" through the ordinary scheduler without arming an occurrence. The sweep
 * therefore does not wait for that settlement (an unbounded wait, which as `waitForTask` would also
 * resume scheduling early). Valid timers are untouched (the filter is exact), already-marked timers
 * are skipped, and job records are not mutated.
 *
 * Nothing here is best-effort: a scan, commit or abort failure (for example a storage failure that
 * fails the Durable session) and a cancelled `context` reject, so the caller can refuse to serve. A
 * timer that settled after the scan is the one benign race, and `abortTask` reports it as
 * `"terminal"` rather than throwing.
 *
 * Known limitation: Durable restores the sleep at open and arms its clamped native wakeup
 * reference once scheduling is enabled (`harness.resume()` inside `openGateway()`), so between
 * `openGateway()` returning and this sweep that reference still exists. That window is inert (the
 * due check holds forever for an out-of-range deadline, and the fire-phase guard settles the task
 * if it is ever run).
 */
export async function disarmInvalidSleepingCronTimers(
  harness: Pick<Harness, "commit" | "abortTask">,
  context: Context,
): Promise<number> {
  const invalid: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
  let cursor: Cursor | undefined;
  do {
    context.abortSignal?.throwIfAborted();
    const page = await harness.commit(
      (tx) => tx.scanTasks({ kind: CRON_TIMER_TASK_NAME, status: "sleeping" }, 1_000, cursor),
      context,
    );
    for (const record of page.items) {
      if (record.abortRequested) continue;
      const input = parseOccurrenceInput(record.input);
      if (input !== undefined && (input.scheduledAtMs < 0 || input.scheduledAtMs > MAX_DATE_MS)) {
        invalid.push(record);
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  let disarmed = 0;
  for (const record of invalid) {
    context.abortSignal?.throwIfAborted();
    if (await harness.abortTask(record.id as TaskId<CronTimerResult>, context) === "marked") disarmed += 1;
  }
  context.abortSignal?.throwIfAborted();
  return disarmed;
}
