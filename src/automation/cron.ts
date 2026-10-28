import { randomUUID } from "node:crypto";
import { copyJson, type Context, type Draft, type JsonValue } from "@earendil-works/chord";
import { LiveDoc, defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import type {
  ConversationHandle,
  ConversationId,
  Extension,
  Harness,
  NextTaskState,
  Submission,
  Task,
  TaskId,
  TaskInspection,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import {
  CRON_DEFAULT_TIME_ZONE,
  materializeCronSchedule,
  nextCronOccurrence,
  parseCronScheduleRequest,
  type CronSchedule,
  type CronScheduleRequest,
} from "./cron-schedule.js";

export const CRON_EXTENSION_NAME = "nanobot.cron";
export const CRON_TIMER_TASK_NAME = "nanobot.cron.timer";
export const CRON_RUN_TASK_NAME = "nanobot.cron.run";
export const CRON_JOBS_KIND = "nanobot.cron.jobs";
const DOC_VERSION = 1;
const TASK_VERSION = 1;

/** Host-authenticated identity captured when the job is created. */
export interface CronOwner {
  readonly [key: string]: JsonValue;
  readonly ownerId: string;
  readonly sessionKey: string;
}
export type CronMode = "background" | "origin";

export interface CronOutcome {
  readonly [key: string]: JsonValue;
  readonly scheduledAtMs: number;
  readonly finishedAtMs: number;
  readonly status: "ok" | "error";
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
}
export interface CronJobsDocument {
  readonly [key: string]: JsonValue;
  readonly jobs: CronJob[];
}

/** One job list per origin conversation. A fork starts empty. */
export const CronJobsDoc = defineDoc<CronJobsDocument>({
  kind: CRON_JOBS_KIND, version: DOC_VERSION, scope: "conversation",
  history: "latest", fork: "initial", initial: () => ({ jobs: [] }),
  checkpointWhen: () => true,
});

/** Immutable input of both finite task kinds. */
export interface CronOccurrenceInput {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
  readonly generation: number;
}
export type CronTimerCheckpoint = { readonly phase: "fire" };
export type CronRunCheckpoint = {
  readonly phase: "run";
  /** Chosen once, in the same commit as host preparation, then reused after a crash. */
  readonly targetConversationId: ConversationId | null;
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
  readonly outcome: "ok" | "error" | "cancelled" | "superseded" | "missing";
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
}
export interface CronActor {
  readonly owner: CronOwner;
}
/**
 * The committing handle cron needs for a conversation's job document. A tool call and a host both
 * commit conversation-scoped documents, so neither needs the full `Conversation` surface.
 */
export interface CronConversationWriter {
  readonly id: ConversationId;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}
/**
 * One run's durable preparation or finalization. Preparation runs in the commit that chooses the
 * run's target; finalization runs in the commit that records the run's terminal result or
 * cancellation. A crash before either commit reruns its callback; a crash after it does not.
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
 * Optional durable preparation for one run. It runs once, in the commit that chooses the run's
 * target conversation; a crash before that commit reruns it, and a crash after it does not.
 * This slice adds no context or tool grants of its own.
 */
export type CronPrepare = (preparation: CronPreparation, context: Context) => void | Promise<void>;
/**
 * One run's durable retirement of an already-prepared target, in the same commit that records the
 * run's terminal result or cancellation. Retirement is target-scoped: `job` may be `null` when
 * the record is missing or the terminal path does not supply it (and `occurrence` may be a synthetic
 * zero input); a host that gave the target authority must retire it anyway. `background` is true
 * when the target is a separate conversation, so an origin-mode run's own conversation is never
 * finalized.
 */
export interface CronFinalization {
  readonly tx: Tx;
  readonly job: CronJob | null;
  readonly occurrence: CronOccurrenceInput;
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
  readonly background: boolean;
}
/**
 * Optional durable finalization of one run's target, in the same commit that records the run's
 * terminal result or cancellation. A host that gave the target authority should retire it here; the
 * foundation itself changes no tool state. Every terminal path of a run that already prepared a
 * separate target calls this, so a finished, failed, superseded or cancelled run keeps no copy.
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
export type CronJobStatus = CronTaskStatus | "scheduled" | "cancelled" | "stopped";
/** Job plus state derived from its actual timer and execution tasks. */
export interface CronJobView {
  readonly job: CronJob;
  readonly status: CronJobStatus;
  readonly nextAtMs: number | null;
  readonly timer: CronTaskSummary | null;
  readonly execution: CronTaskSummary | null;
  readonly target: CronTargetSummary | null;
}

export interface CronFoundationOptions {
  /** Optional durable preparation. Without it no context or tool grant is added. */
  readonly prepare?: CronPrepare;
  /** Optional durable finalization in the run's terminal commit; called only for a separate target. */
  readonly finalize?: CronFinalize;
  /** The Harness clock (`HarnessOptions.now`); default `Date.now`. */
  readonly now?: () => number;
}
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
  readonly schedule: CronScheduleRequest;
  readonly idempotencyKey: string;
}

function normalizeRequest(actor: CronActor, request: CronScheduleInput): NormalizedRequest {
  const owner = ownerOf(actor);
  if (!isRecord(request)) throw new TypeError("schedule request must be an object");
  if (typeof request.message !== "string" || request.message.trim() === "") {
    throw new TypeError("message must be a non-empty string");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey === "") {
    throw new TypeError("idempotencyKey must be a non-empty string");
  }
  if (request.name !== undefined && typeof request.name !== "string") {
    throw new TypeError("name must be a string when provided");
  }
  const mode = request.mode === undefined ? "background" : request.mode;
  if (mode !== "background" && mode !== "origin") throw new TypeError("mode must be 'background' or 'origin'");
  let schedule: CronScheduleRequest;
  try {
    schedule = parseCronScheduleRequest(request.schedule);
  } catch (error) {
    throw new TypeError(errorText(error));
  }
  return {
    owner,
    message: request.message,
    name: request.name?.trim() || request.message.slice(0, 30),
    mode,
    schedule,
    idempotencyKey: request.idempotencyKey,
  };
}

function sameScheduleRequest(left: CronSchedule, right: CronScheduleRequest): boolean {
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
    && sameScheduleRequest(job.schedule, request.schedule);
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
const terminalCompleted = <S extends { phase: string }, R>(result: R): NextTaskState<S, R> =>
  ({ status: "terminal", outcome: { status: "completed", result } });
const terminalAborted = <S extends { phase: string }, R>(
  result: R, reason: string,
): NextTaskState<S, R> => ({ status: "terminal", outcome: { status: "aborted", reason, result } });
const terminalFailed = <S extends { phase: string }, R>(
  result: R, message: string,
): NextTaskState<S, R> =>
  ({ status: "terminal", outcome: { status: "failed", error: { message }, result } });

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
  readonly status: "ok" | "error";
  readonly error: string | null;
}
interface SettlementRecord {
  readonly status: string;
  readonly reason?: unknown;
  readonly detail?: unknown;
}
function outcomeOf(record: SettlementRecord): WaitSettlement {
  if (record.status === "done") return { status: "ok", error: null };
  if (record.status === "unanswered" && typeof record.reason === "string") {
    const detail = record.detail === undefined ? "" : `: ${JSON.stringify(record.detail)}`;
    return { status: "error", error: `${record.reason}${detail}` };
  }
  return { status: "error", error: "submission settled without an answer" };
}

/**
 * Wait for the native submission, but also notice a run that ended without answering it.
 * Durable's default `afterFailedRun: "keep"` leaves the input queued, so waiting only on
 * `submission.wait()` would never finish. Once the target is idle, a still-queued input has no
 * run left to answer it: withdraw it, record the error, and let the next timer continue.
 */
async function waitForAnswer(
  submission: Submission, conversation: ConversationHandle, context: Context,
): Promise<WaitSettlement> {
  const settled = submission.wait(context).then(
    (record) => ({ kind: "settled" as const, record }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const idle = conversation.waitForIdle(context).then(
    () => ({ kind: "idle" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  // A losing side may reject later; it must not become an unhandled rejection.
  void settled.catch(() => {});
  void idle.catch(() => {});
  const first = await Promise.race([settled, idle]);
  if (first.kind === "failed") throw first.error;
  if (first.kind === "settled") return outcomeOf(first.record);
  const record = await submission.status(context);
  if (record.status === "done" || record.status === "unanswered") return outcomeOf(record);
  if (record.status === "queued") {
    // A later unrelated input must not place and run this occurrence after it was recorded failed.
    try { await submission.abort(context); } catch { /* it may have been placed first */ }
  }
  return { status: "error", error: `run ended before answering (submission is ${record.status})` };
}

const TERMINAL_TASK: ReadonlySet<CronTaskStatus> = new Set([
  "completed", "failed", "aborted", "orphaned", "faulted", "missing",
]);
const UNHEALTHY_TASK: ReadonlySet<CronTaskStatus> = new Set([
  "parked", "failed", "aborted", "orphaned", "faulted", "missing",
]);

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
        ? blocked.reason === "restart_limit" ? "parked" : "missing"
        : state!.status;
  const outcome = state?.status === "terminal" ? state.outcome : undefined;
  return {
    taskId,
    status,
    scheduledAtMs: record === undefined ? null : parseOccurrenceInput(record.input)?.scheduledAtMs ?? null,
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
      timer,
      execution,
      target,
    };
  }));
}

/** Build the deterministic timer plus execution controller. Gateway and delivery stay outside. */
export function createCronFoundation(options: CronFoundationOptions): CronFoundation {
  const prepare = options.prepare;
  const finalize = options.finalize;
  const clock = options.now ?? (() => Date.now());

  /**
   * Retire one already-prepared target inside the commit that ends its run. The target is the run
   * task's own conversation, chosen once in its checkpoint, so it cannot belong to a newer run; an
   * origin-mode target is the origin conversation itself and is deliberately left alone.
   */
  const retireTarget = async (
    tx: Tx,
    originConversationId: ConversationId,
    targetConversationId: ConversationId,
    job: CronJob | null,
    occurrence: CronOccurrenceInput,
    context: Context,
  ): Promise<void> => {
    if (finalize === undefined || targetConversationId === originConversationId) return;
    await finalize({
      tx, job, occurrence, originConversationId, targetConversationId, background: true,
    }, context);
  };

  const runTask: Task<CronOccurrenceInput, CronRunCheckpoint, CronRunResult, object> =
    defineTask<CronOccurrenceInput, CronRunCheckpoint, CronRunResult>({
      name: CRON_RUN_TASK_NAME,
      version: TASK_VERSION,
      initial: () => ({ phase: "run", targetConversationId: null }),
      phases: {
        run: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          if (input === undefined) {
            await runtime.commit(async (tx) => {
              // A checkpoint only advances together with a parsed input, so a prepared target here
              // means a damaged record; retire it rather than leave its copy alive.
              const preparedTarget = running.state.checkpoint.targetConversationId;
              if (preparedTarget !== null) {
                await retireTarget(
                  tx, running.conversationId, preparedTarget, null, zeroInput, context,
                );
              }
              return terminalFailed<CronRunCheckpoint, CronRunResult>(
                runResult(zeroInput, "missing", "task input is invalid"), "task input is invalid",
              );
            }, context);
            return;
          }
          const checkpoint = running.state.checkpoint;
          let targetConversationId = checkpoint.targetConversationId;
          let job: CronJob | undefined;
          let prepareError: string | null = null;
          let terminal = false;

          const inspectJob = (found: CronJob | undefined): NextTaskState<CronRunCheckpoint, CronRunResult> | undefined => {
            if (found === undefined) {
              terminal = true;
              return terminalFailed<CronRunCheckpoint, CronRunResult>(
                runResult(input, "missing", "cron job record is missing"), "cron job record is missing",
              );
            }
            if (found.generation !== input.generation) {
              terminal = true;
              return terminalAborted<CronRunCheckpoint, CronRunResult>(
                runResult(input, "superseded", "job generation changed"), "superseded",
              );
            }
            if (found.cancelledAtMs !== null) {
              terminal = true;
              return terminalAborted<CronRunCheckpoint, CronRunResult>(
                runResult(input, "cancelled", "cancelled before execution"), "cancelled",
              );
            }
            if (found.executionTaskId !== running.id) {
              terminal = true;
              return terminalAborted<CronRunCheckpoint, CronRunResult>(
                runResult(input, "superseded", "job is owned by another execution"), "superseded",
              );
            }
            job = copyJob(found);
            return undefined;
          };

          if (targetConversationId === null) {
            // Real progress: choose and remember the target once, together with host preparation.
            try {
              await runtime.commit(async (tx) => {
                const doc = await tx.doc(CronJobsDoc, running.conversationId);
                const rejected = inspectJob(doc.jobs.find((candidate) => candidate.id === input.jobId));
                if (rejected !== undefined) return rejected;
                const found = doc.jobs.find((candidate) => candidate.id === input.jobId)!;
                targetConversationId = found.mode === "background"
                  ? (await tx.scanConversations({ ownerTaskId: running.id }, 1)).items[0]?.id
                    ?? (await tx.createConversation({ ownership: { kind: "task", taskId: running.id } })).id
                  : running.conversationId;
                if (prepare !== undefined) {
                  await prepare({
                    tx,
                    job: copyJob(found),
                    occurrence: input,
                    originConversationId: running.conversationId,
                    targetConversationId,
                    background: found.mode === "background",
                  }, context);
                }
                return {
                  status: "running",
                  checkpoint: { phase: "run", targetConversationId },
                };
              }, context);
            } catch (error) {
              if (runtime.signal.aborted) return;
              // The preparation commit rolled back, including any conversation it created.
              targetConversationId = checkpoint.targetConversationId;
              prepareError = `preparation failed: ${errorText(error)}`;
            }
          } else {
            // A resume after the target commit must not fabricate progress: Durable's restart
            // counter only advances while this task fails to change its checkpoint.
            const snapshot = await runtime.snapshot(CronJobsDoc, running.conversationId, context);
            const rejected = inspectJob(snapshot?.jobs.find((candidate) => candidate.id === input.jobId));
            if (rejected !== undefined) {
              // This run is fenced out, but its target was already prepared: retire it in the same
              // commit that records the rejection.
              const preparedTarget = targetConversationId;
              await runtime.commit(async (tx) => {
                await retireTarget(
                  tx, running.conversationId, preparedTarget, null, input, context,
                );
                return rejected;
              }, context);
            }
          }

          if (terminal) return;
          if (prepareError !== null || job === undefined || targetConversationId === null) {
            await finishRun(
              runtime, running.conversationId, running.id, input,
              { status: "error", error: prepareError ?? "execution could not be prepared" },
              targetConversationId ?? running.conversationId, context,
            );
            return;
          }

          const conversation = await runtime.conversation(targetConversationId, context);
          if (conversation === undefined) {
            await finishRun(
              runtime, running.conversationId, running.id, input,
              { status: "error", error: "target conversation is missing" },
              targetConversationId, context,
            );
            return;
          }

          let settlement: WaitSettlement;
          try {
            const requestId = occurrenceKey(input.jobId, input.scheduledAtMs);
            const submission = await conversation.submit({
              type: "input",
              content: job.message,
              requestId,
              entry: {
                kind: "nanobot.cron",
                data: {
                  jobId: input.jobId,
                  scheduledAtMs: input.scheduledAtMs,
                  generation: input.generation,
                  requestId,
                },
              },
            }, context);
            settlement = await waitForAnswer(submission, conversation, context);
          } catch (error) {
            if (runtime.signal.aborted) return;
            settlement = { status: "error", error: errorText(error) };
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
        await runtime.commit(async (tx) => {
          // A cancelled run gives up its target's authority in this same commit: an abort is not a
          // reason to leave a prepared copy alive for a later admission.
          if (finalize !== undefined && targetConversationId !== null
            && targetConversationId !== running.conversationId) {
            const doc = await tx.doc(CronJobsDoc, running.conversationId);
            const job = doc.jobs.find((candidate) => candidate.id === parsed?.jobId);
            await retireTarget(
              tx, running.conversationId, targetConversationId,
              job === undefined ? null : copyJob(job), parsed ?? zeroInput, context,
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
      version: TASK_VERSION,
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
      const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
      if (job === undefined) {
        await retireTarget(tx, conversationId, targetConversationId, null, input, context);
        return terminalFailed<CronRunCheckpoint, CronRunResult>(
          runResult(input, "missing", "cron job record is missing"), "cron job record is missing",
        );
      }
      // The run records only its result. It never computes or creates a schedule. A fenced-out run
      // still retires its already-prepared target in this same commit.
      if (job.generation !== input.generation) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "superseded", "job generation changed"), "superseded",
        );
      }
      if (job.cancelledAtMs !== null) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "cancelled", "cancelled before the run finished"), "cancelled",
        );
      }
      if (job.executionTaskId !== taskId) {
        await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, context);
        return terminalAborted<CronRunCheckpoint, CronRunResult>(
          runResult(input, "superseded", "job is owned by another execution"), "superseded",
        );
      }
      job.lastOutcome = {
        scheduledAtMs: input.scheduledAtMs,
        finishedAtMs: now,
        status: settlement.status,
        error: settlement.error,
        conversationId: targetConversationId,
      };
      // The run's authority ends with the run, in this same terminal commit. The origin-mode target
      // is the origin conversation itself and is deliberately left alone.
      await retireTarget(tx, conversationId, targetConversationId, copyJob(job), input, context);
      return terminalCompleted<CronRunCheckpoint, CronRunResult>(
        runResult(input, settlement.status === "ok" ? "ok" : "error", settlement.error),
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
            nextAtMs: timer === undefined ? null : parseOccurrenceInput(timer.input)?.scheduledAtMs ?? null,
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
        if (executionInput !== undefined && target !== null) {
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
