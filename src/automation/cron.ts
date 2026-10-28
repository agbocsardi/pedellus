import { randomUUID } from "node:crypto";
import { copyJson, type Context, type Draft, type JsonValue } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import type {
  Conversation,
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
  materializeCronSchedule,
  nextCronOccurrence,
  parseCronScheduleRequest,
  type CronSchedule,
  type CronScheduleRequest,
} from "./cron-schedule.js";

export const CRON_EXTENSION_NAME = "nanobot.cron";
export const CRON_TASK_NAME = "nanobot.cron.occurrence";
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

/**
 * One job definition plus its live pointer and newest outcome. There is no stored next time,
 * occurrence array, or job lifecycle state machine; the active task carries all of that.
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
  /** The only occurrence that may finish this job, or `null` once settled or cancelled. */
  readonly activeTaskId: number | null;
  readonly cancelledAtMs: number | null;
  readonly lastOutcome: CronOutcome | null;
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

/** Immutable input of one finite occurrence task. */
export interface CronOccurrenceInput {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
}
export type CronCheckpoint =
  | { readonly phase: "wait" }
  | {
      readonly phase: "execute";
      /** Chosen once, in the same commit as host preparation. */
      readonly targetConversationId: ConversationId | null;
      readonly attempt: number;
    };
export interface CronTaskResult {
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
  /** Default `background`: run in a fresh, task-owned conversation. */
  readonly mode?: CronMode;
}
export interface CronActor {
  readonly owner: CronOwner;
}
export interface CronPreparation {
  readonly tx: Tx;
  readonly job: CronJob;
  readonly occurrence: CronOccurrenceInput;
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
  readonly background: boolean;
}
/**
 * Optional durable preparation. It runs once, in the commit that chooses the target conversation;
 * a crash before that commit reruns it, and a crash after it does not. This slice adds no grants.
 */
export type CronPrepare = (preparation: CronPreparation, context: Context) => void | Promise<void>;

export interface CronScheduleReceipt {
  readonly jobId: string;
  readonly taskId: number | null;
  readonly nextAtMs: number | null;
  readonly deduplicated: boolean;
}
export type CronCancellation =
  | { readonly status: "cancelled"; readonly task: "marked" | "terminal"; readonly job: CronJob }
  | { readonly status: "already_terminal"; readonly job: CronJob }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

export type CronTaskStatus =
  | "pending" | "running" | "waiting" | "sleeping" | "completing"
  | "completed" | "failed" | "aborted" | "faulted" | "orphaned" | "parked" | "missing";
export type CronJobStatus = CronTaskStatus | "scheduled" | "cancelled" | "stopped";
/** Job plus state derived from its actual task, never duplicated in the job document. */
export interface CronJobView {
  readonly job: CronJob;
  readonly status: CronJobStatus;
  readonly taskId: number | null;
  readonly nextAtMs: number | null;
  /** Fault or failure text from the live or terminal task, including a parked reason's error. */
  readonly error: string | null;
  readonly reason: string | null;
}

export interface CronFoundationOptions {
  /** Optional durable preparation. Without it no context or tool grant is added. */
  readonly prepare?: CronPrepare;
  /** The Harness clock (`HarnessOptions.now`); default `Date.now`. */
  readonly now?: () => number;
}
export interface CronFoundation {
  /** Install before opening or resuming the Harness; registers one finite occurrence task. */
  readonly extension: Extension;
  schedule(
    actor: CronActor, conversation: Conversation, request: CronScheduleInput, context: Context,
  ): Promise<CronScheduleReceipt>;
  cancel(
    harness: Pick<Harness, "abortTask" | "waitForTask" | "commit">,
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
  if (left.kind === "once" && right.kind === "once") return left.at === right.at;
  if (left.kind === "every" && right.kind === "every") return left.everyMs === right.everyMs;
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
  return { jobId: value.jobId, scheduledAtMs: value.scheduledAtMs as number };
}
const occurrenceKey = (jobId: string, scheduledAtMs: number): string =>
  `cron:${jobId}:${scheduledAtMs}`;
const copyJob = (job: Draft<CronJob> | CronJob): CronJob => copyJson(job) as unknown as CronJob;
const taskResult = (
  input: CronOccurrenceInput, outcome: CronTaskResult["outcome"], error: string | null,
): CronTaskResult => ({
  jobId: input.jobId, scheduledAtMs: input.scheduledAtMs, outcome, error,
});

const terminalCompleted = (result: CronTaskResult): NextTaskState<CronCheckpoint, CronTaskResult> =>
  ({ status: "terminal", outcome: { status: "completed", result } });
const terminalAborted = (
  result: CronTaskResult, reason: string,
): NextTaskState<CronCheckpoint, CronTaskResult> =>
  ({ status: "terminal", outcome: { status: "aborted", reason, result } });
const terminalFailed = (
  result: CronTaskResult, message: string,
): NextTaskState<CronCheckpoint, CronTaskResult> =>
  ({ status: "terminal", outcome: { status: "failed", error: { message }, result } });

interface WaitSettlement {
  readonly status: "ok" | "error";
  readonly error: string | null;
}
interface SettlementRecord {
  readonly status: string;
  readonly answer?: unknown;
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
 * run left to answer it: withdraw it, record the error, and let the schedule continue.
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
  return { status: "error", error: `run ended before answering the occurrence (submission is ${record.status})` };
}

function taskStatusOf(
  task: TaskInspection | undefined, record: Awaited<ReturnType<Harness["getTask"]>>,
): CronTaskStatus {
  if (record === undefined) return "missing";
  if (record.state.status === "terminal") return record.state.outcome.status;
  const blocked = task?.state.kind === "blocked" ? task.state : undefined;
  if (blocked === undefined) return record.state.status;
  return blocked.reason === "restart_limit" ? "parked" : "missing";
}

function taskFaultOf(
  task: TaskInspection | undefined, record: Awaited<ReturnType<Harness["getTask"]>>,
): { error: string | null; reason: string | null } {
  const blocked = task?.state.kind === "blocked" ? task.state : undefined;
  const outcome = record?.state.status === "terminal" ? record.state.outcome : undefined;
  return {
    error: blocked?.error !== undefined
      ? errorText(blocked.error)
      : outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : null,
    reason: blocked?.reason
      ?? (outcome?.status === "aborted" || outcome?.status === "orphaned" ? outcome.reason ?? null : null),
  };
}

function waitingForSlot(record: Awaited<ReturnType<Harness["getTask"]>>): boolean {
  const state = record?.state;
  const checkpoint = state !== undefined && "checkpoint" in state ? state.checkpoint : undefined;
  return isRecord(checkpoint) && checkpoint.phase === "wait";
}

function jobStatusOf(job: CronJob, task: CronTaskStatus | null, waiting: boolean): CronJobStatus {
  if (job.cancelledAtMs !== null) return "cancelled";
  if (job.activeTaskId === null) {
    return job.schedule.kind === "once" && job.lastOutcome !== null ? "completed" : "stopped";
  }
  if (task === null) return "missing";
  if (task === "sleeping" || (waiting && (task === "pending" || task === "running"))) {
    return "scheduled";
  }
  return task;
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
    if (job.activeTaskId === null) {
      return {
        job: copyJob(job), status: jobStatusOf(job, null, false), taskId: null,
        nextAtMs: null, error: null, reason: null,
      };
    }
    const taskId = job.activeTaskId;
    const record = await harness.getTask(taskId as TaskId<CronTaskResult>, context);
    const status = taskStatusOf(live.get(taskId), record);
    return {
      job: copyJob(job), status: jobStatusOf(job, status, waitingForSlot(record)), taskId,
      nextAtMs: record === undefined ? null : parseOccurrenceInput(record.input)?.scheduledAtMs ?? null,
      ...taskFaultOf(live.get(taskId), record),
    };
  }));
}

/** Build the finite-occurrence cron controller. Gateway, tools, config and delivery stay outside. */
export function createCronFoundation(options: CronFoundationOptions): CronFoundation {
  const prepare = options.prepare;
  const clock = options.now ?? (() => Date.now());

  const task: Task<CronOccurrenceInput, CronCheckpoint, CronTaskResult, object> =
    defineTask<CronOccurrenceInput, CronCheckpoint, CronTaskResult>({
      name: CRON_TASK_NAME,
      version: TASK_VERSION,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          if (input === undefined) {
            await runtime.commit(
              () => terminalFailed(taskResult({ jobId: "", scheduledAtMs: 0 }, "missing", "task input is invalid"), "task input is invalid"),
              context,
            );
            return;
          }
          const now = runtime.now();
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(CronJobsDoc, running.conversationId);
            const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
            if (job === undefined) {
              return terminalFailed(taskResult(input, "missing", "cron job record is missing"), "cron job record is missing");
            }
            if (job.cancelledAtMs !== null) {
              return terminalAborted(taskResult(input, "cancelled", "cancelled before the occurrence was due"), "cancelled");
            }
            if (job.activeTaskId !== running.id) {
              return terminalAborted(taskResult(input, "superseded", "job is owned by another occurrence"), "superseded");
            }
            const checkpoint: CronCheckpoint = {
              phase: "execute", targetConversationId: null, attempt: 0,
            };
            return input.scheduledAtMs > now
              ? { status: "sleeping", until: input.scheduledAtMs, checkpoint }
              : { status: "running", checkpoint };
          }, context);
        },

        execute: async (running, runtime, context) => {
          const input = parseOccurrenceInput(running.input);
          if (input === undefined) {
            await runtime.commit(
              () => terminalFailed(taskResult({ jobId: "", scheduledAtMs: 0 }, "missing", "task input is invalid"), "task input is invalid"),
              context,
            );
            return;
          }
          const checkpoint = running.state.checkpoint;
          const now = runtime.now();
          let targetConversationId: ConversationId | null = checkpoint.targetConversationId;
          let job: CronJob | undefined;
          let prepareError: string | null = null;
          let terminal = false;

          try {
            await runtime.commit(async (tx) => {
              const doc = await tx.doc(CronJobsDoc, running.conversationId);
              const found = doc.jobs.find((candidate) => candidate.id === input.jobId);
              if (found === undefined) {
                terminal = true;
                return terminalFailed(taskResult(input, "missing", "cron job record is missing"), "cron job record is missing");
              }
              if (found.cancelledAtMs !== null) {
                terminal = true;
                return terminalAborted(taskResult(input, "cancelled", "cancelled before execution"), "cancelled");
              }
              if (found.activeTaskId !== running.id) {
                terminal = true;
                return terminalAborted(taskResult(input, "superseded", "job is owned by another occurrence"), "superseded");
              }
              job = copyJob(found);
              if (targetConversationId === null) {
                targetConversationId = found.mode === "background"
                  ? (await tx.scanConversations({ ownerTaskId: running.id }, 1)).items[0]?.id
                    ?? (await tx.createConversation({ ownership: { kind: "task", taskId: running.id } })).id
                  : running.conversationId;
                if (prepare !== undefined) {
                  await prepare({
                    tx,
                    job: copyJob(found),
                    occurrence: { jobId: input.jobId, scheduledAtMs: input.scheduledAtMs },
                    originConversationId: running.conversationId,
                    targetConversationId,
                    background: found.mode === "background",
                  }, context);
                }
              }
              return {
                status: "running",
                checkpoint: { phase: "execute", targetConversationId, attempt: checkpoint.attempt + 1 },
              };
            }, context);
          } catch (error) {
            if (runtime.signal.aborted) return;
            // The preparation commit rolled back, including any conversation it created.
            targetConversationId = checkpoint.targetConversationId;
            prepareError = `preparation failed: ${errorText(error)}`;
          }

          if (terminal) return;
          if (prepareError !== null || job === undefined || targetConversationId === null) {
            await finishOccurrence(
              runtime, running.conversationId, running.id, input,
              { status: "error", error: prepareError ?? "occurrence could not be prepared" },
              targetConversationId ?? running.conversationId, context,
            );
            return;
          }

          const conversation = await runtime.conversation(targetConversationId, context);
          if (conversation === undefined) {
            await finishOccurrence(
              runtime, running.conversationId, running.id, input,
              { status: "error", error: "target conversation is missing" },
              targetConversationId, context,
            );
            return;
          }

          let settlement: WaitSettlement;
          try {
            const submission = await conversation.submit({
              type: "input",
              content: job.message,
              requestId: occurrenceKey(input.jobId, input.scheduledAtMs),
            }, context);
            settlement = await waitForAnswer(submission, conversation, context);
          } catch (error) {
            if (runtime.signal.aborted) return;
            settlement = { status: "error", error: errorText(error) };
          }
          if (runtime.signal.aborted) return;
          await finishOccurrence(
            runtime, running.conversationId, running.id, input, settlement,
            targetConversationId, context,
          );
        },
      },

      abort: async (running, runtime, context) => {
        const input = parseOccurrenceInput(running.input);
        if (input === undefined) {
          await runtime.commit(
            () => terminalAborted(taskResult({ jobId: "", scheduledAtMs: 0 }, "missing", "task input is invalid"), "cancelled"),
            context,
          );
          return;
        }
        const now = runtime.now();
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(CronJobsDoc, running.conversationId);
          const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
          if (job !== undefined && job.activeTaskId === running.id && job.cancelledAtMs === null) {
            // An explicit abort of the active occurrence stops the job; never create a successor.
            job.cancelledAtMs = now;
            job.activeTaskId = null;
          }
          return terminalAborted(taskResult(input, "cancelled", "cancelled"), "cancelled");
        }, context);
      },
    });

  async function finishOccurrence(
    runtime: TaskRuntime<CronOccurrenceInput, CronCheckpoint, CronTaskResult, object>,
    conversationId: ConversationId, taskId: TaskId<CronTaskResult>, input: CronOccurrenceInput,
    settlement: WaitSettlement, targetConversationId: ConversationId,
    context: Context,
  ): Promise<void> {
    const now = runtime.now();
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(CronJobsDoc, conversationId);
      const job = doc.jobs.find((candidate) => candidate.id === input.jobId);
      if (job === undefined) {
        return terminalFailed(taskResult(input, "missing", "cron job record is missing"), "cron job record is missing");
      }
      // The cancellation fence: a cancelled job or a replaced pointer never gets a successor.
      if (job.cancelledAtMs !== null) {
        return terminalAborted(taskResult(input, "cancelled", "cancelled before the occurrence finished"), "cancelled");
      }
      if (job.activeTaskId !== taskId) {
        return terminalAborted(taskResult(input, "superseded", "job is owned by another occurrence"), "superseded");
      }
      job.lastOutcome = {
        scheduledAtMs: input.scheduledAtMs,
        finishedAtMs: now,
        status: settlement.status,
        error: settlement.error,
        conversationId: targetConversationId,
      };
      const result = taskResult(input, settlement.status === "ok" ? "ok" : "error", settlement.error);
      if (job.schedule.kind === "once") {
        job.activeTaskId = null;
        return terminalCompleted(result);
      }
      // Never schedule the slot that just finished again, even if the host clock moved backwards.
      const nextAtMs = nextCronOccurrence(job.schedule, Math.max(now, input.scheduledAtMs));
      job.activeTaskId = await tx.createTask(
        task,
        { jobId: job.id, scheduledAtMs: nextAtMs },
        { ownership: { kind: "conversation" }, conversationId, background: true },
      );
      return terminalCompleted(result);
    }, context);
  }

  return {
    extension: defineExtension({ name: CRON_EXTENSION_NAME, tasks: [task] }),

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
          const active = existing.activeTaskId === null
            ? undefined
            : await tx.task(existing.activeTaskId as TaskId<CronTaskResult>);
          return {
            jobId: existing.id,
            taskId: existing.activeTaskId,
            nextAtMs: active === undefined ? null : parseOccurrenceInput(active.input)?.scheduledAtMs ?? null,
            deduplicated: true,
          };
        }
        let schedule: CronSchedule;
        try {
          schedule = materializeCronSchedule(value.schedule, now);
        } catch (error) {
          throw new TypeError(errorText(error));
        }
        const firstAtMs = schedule.kind === "once" ? schedule.at : schedule.anchorMs;
        const jobId = `cron-${randomUUID()}`;
        const taskId = await tx.createTask(
          task,
          { jobId, scheduledAtMs: firstAtMs },
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
          activeTaskId: taskId,
          cancelledAtMs: null,
          lastOutcome: null,
        });
        return { jobId, taskId, nextAtMs: firstAtMs, deduplicated: false };
      }, context);
    },

    async cancel(harness, conversationId, jobId, actor, context) {
      const caller = ownerOf(actor);
      const now = clock();
      let taskId: TaskId<CronTaskResult> | undefined;
      const decision = await harness.commit(async (tx) => {
        const doc = await tx.doc(CronJobsDoc, conversationId);
        const job = doc.jobs.find((candidate) => candidate.id === jobId);
        if (job === undefined) return { status: "not_found" } as const;
        if (!sameOwner(job.owner, caller)) return { status: "forbidden" } as const;
        if (job.cancelledAtMs !== null || job.activeTaskId === null) {
          return { status: "already_terminal", job: copyJob(job) } as const;
        }
        taskId = job.activeTaskId as TaskId<CronTaskResult>;
        // Fence first: a finish commit after this sees no active task and creates no successor.
        job.cancelledAtMs = now;
        job.activeTaskId = null;
        return { status: "to_cancel", job: copyJob(job) } as const;
      }, context);

      if (decision.status !== "to_cancel") return decision;
      if (taskId === undefined) throw new Error("cron job has no task to cancel");
      const abort = await harness.abortTask(taskId, context);
      if (abort === "marked") await harness.waitForTask(taskId, context);
      return { status: "cancelled", task: abort, job: decision.job };
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
