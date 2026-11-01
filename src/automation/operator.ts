/**
 * Owner-visible scheduling controls: create, list, show and cancel.
 *
 * This is a thin projection over the existing cron foundation, never a second scheduler. It
 * exposes exactly `schedule`, `list`, `inspect` and `cancel` over host-validated scheduling
 * origins; it cannot edit a schedule, re-arm a cancelled job, run one now, or reach a conversation
 * the host has not already mapped as an ordinary chat.
 *
 * The host is the authority boundary. The wire names a chat by its host-owned session key, and
 * this module resolves that key to a conversation and to the owner the host itself recorded for
 * it, so a caller can neither supply a conversation ID nor claim someone else's owner record.
 * Every read re-derives the origin set, which means jobs are visible only while their chat is a
 * current mapped chat: an orphaned conversation is not a scheduling surface.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { CronScheduleError, cronScheduleText, parseCronScheduleRequest, type CronScheduleRequest } from "./cron-schedule.js";
import type {
  CronActor,
  CronFoundation,
  CronIntent,
  CronJobStatus,
  CronJobView,
  CronMode,
  CronScheduleInput,
  CronTargetSummary,
  CronTaskSummary,
  CronWithdrawal,
} from "./cron.js";

/** Bounds every value this surface renders, so one store-wide listing stays readable. */
export const CRON_OPERATOR_LIMITS = Object.freeze({
  maxJobIdChars: 64,
  maxListRows: 100,
  maxSessionKeyChars: 200,
  maxRequestKeyChars: 200,
  maxMessageChars: 4_000,
  maxNameChars: 200,
  /** One projected message line; the stored job keeps the whole text. */
  maxMessageLineChars: 300,
  /** One projected error or reason from a task, skip or delivery fault. */
  maxErrorLineChars: 400,
} as const);

/** A request this surface refuses before it reaches the foundation. */
export class CronOperatorInputError extends Error {
  override name = "CronOperatorInputError";
}

/** One host-validated mapped ordinary chat that may own scheduled work. */
export interface CronOperatorOrigin {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

export interface CronOperatorOptions {
  readonly foundation: CronFoundation;
  /** The open Harness; the operator is reachable only after the runtime opened. */
  readonly harness: () => Harness;
  /** The host's current mapped ordinary chat sessions. Nothing else is a scheduling origin. */
  readonly origins: (context: Context) => Promise<readonly CronOperatorOrigin[]>;
}

/** One job as this surface renders it: bounded, JSON-safe and free of conversation IDs. */
export interface CronOperatorJob {
  readonly id: string;
  /** The mapped chat session key that owns this job. */
  readonly origin: string;
  readonly name: string;
  readonly mode: CronMode;
  readonly intent: CronIntent;
  readonly schedule: string;
  readonly status: CronJobStatus;
  readonly nextAtMs: number | null;
  /** One bounded line of the scheduled instruction. */
  readonly message: string;
  readonly lastOutcome: {
    readonly status: "ok" | "error";
    readonly finishedAtMs: number;
    readonly error: string | null;
  } | null;
  readonly lastSkip: { readonly skippedAtMs: number; readonly reason: string } | null;
  readonly lastFault: { readonly recordedAtMs: number; readonly error: string } | null;
  readonly deliveryFault: { readonly recordedAtMs: number; readonly message: string } | null;
  readonly timer: CronTaskSummary | null;
  readonly execution: CronTaskSummary | null;
  readonly target: {
    readonly taskId: number;
    readonly status: CronTaskSummary["status"];
    readonly error: string | null;
    readonly reason: string | null;
  } | null;
}

export type CronOperatorCreateOutcome =
  | {
      readonly status: "scheduled";
      /** The re-read view; `null` when the job was created but its view could not be read back. */
      readonly job: CronOperatorJob | null;
      readonly jobId: string;
      readonly nextAtMs: number | null;
      /** True when this exact request already existed; nothing was created or re-armed. */
      readonly deduplicated: boolean;
    }
  /** The named session key is not a current mapped ordinary chat. */
  | { readonly status: "unknown_origin" };

export type CronOperatorCancelOutcome =
  | {
      readonly status: "cancelled";
      /** The re-read view after the cancellation, when it could be read back. */
      readonly job: CronOperatorJob | null;
      readonly withdrawn: CronWithdrawal | null;
      /** Post-commit cleanup failure; the cancellation itself is durably recorded. */
      readonly abortError: string | null;
    }
  | { readonly status: "already_terminal"; readonly job: CronOperatorJob }
  | { readonly status: "not_found" }
  /** A forged or duplicated record under more than one origin is never cancelled by guesswork. */
  | { readonly status: "ambiguous" }
  | { readonly status: "forbidden" };

export type CronOperatorRow = Pick<CronOperatorJob, "id" | "origin" | "name" | "schedule" | "status" | "nextAtMs">;

/** One bounded page of mapped-chat jobs, plus the chats themselves so one can be named. */
export interface CronOperatorListing {
  readonly origins: readonly string[];
  readonly jobs: CronOperatorRow[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface CronOperator {
  list(context: Context, offset?: number): Promise<CronOperatorListing>;
  show(jobId: string, context: Context): Promise<CronOperatorJob[]>;
  create(origin: string, request: unknown, context: Context): Promise<CronOperatorCreateOutcome>;
  cancel(jobId: string, context: Context): Promise<CronOperatorCancelOutcome>;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CronOperatorInputError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new CronOperatorInputError(`request has an unsupported field: ${key}`);
  }
}

/** One line from possibly multi-line text, bounded by code points so no surrogate pair is split. */
function projectedLine(text: string, maxChars: number): string {
  const single = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  const points = [...single];
  return points.length <= maxChars ? single : `${points.slice(0, maxChars - 1).join("")}…`;
}

const projectedError = (value: string | null): string | null =>
  value === null ? null : projectedLine(value, CRON_OPERATOR_LIMITS.maxErrorLineChars);

/** The host's own owner spelling for one validated mapped chat: no wire value is trusted. */
export const cronOwnerFor = (sessionKey: string): CronActor => ({
  owner: { ownerId: sessionKey, sessionKey },
});

function parseSchedule(value: unknown): CronScheduleRequest {
  const record = asRecord(value, "schedule");
  const kind = record.kind;
  let request: CronScheduleRequest;
  if (kind === "at" || kind === "once") {
    onlyFields(record, ["kind", "at"]);
    request = { kind: "at", at: record.at as number };
  } else if (kind === "after") {
    onlyFields(record, ["kind", "afterMs"]);
    request = { kind: "after", afterMs: record.afterMs as number };
  } else if (kind === "every") {
    onlyFields(record, ["kind", "everyMs"]);
    request = { kind: "every", everyMs: record.everyMs as number };
  } else if (kind === "cron") {
    onlyFields(record, ["kind", "expr", "timeZone"]);
    request = {
      kind: "cron",
      expr: record.expr as string,
      ...(record.timeZone === undefined ? {} : { timeZone: record.timeZone as string }),
    };
  } else {
    throw new CronOperatorInputError("schedule kind must be 'at', 'after', 'every', or 'cron'");
  }
  try {
    return parseCronScheduleRequest(request);
  } catch (error) {
    throw new CronOperatorInputError(errorText(error));
  }
}

/**
 * Validate one create request exactly as the foundation accepts it. The same function gates the
 * local CLI's own flags, so an operator sees a refusal before a request is sent.
 */
export function parseCronOperatorRequest(value: unknown): CronScheduleInput {
  const record = asRecord(value, "request");
  onlyFields(record, ["message", "name", "mode", "schedule", "idempotencyKey"]);
  const message = record.message;
  if (typeof message !== "string" || message.trim() === "" || message.length > CRON_OPERATOR_LIMITS.maxMessageChars) {
    throw new CronOperatorInputError(
      `message must be a non-empty string of at most ${CRON_OPERATOR_LIMITS.maxMessageChars} characters`,
    );
  }
  const idempotencyKey = record.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
    throw new CronOperatorInputError("key must be 1-200 printable characters without spaces");
  }
  let name: string | undefined;
  if (record.name !== undefined) {
    if (typeof record.name !== "string" || record.name.length > CRON_OPERATOR_LIMITS.maxNameChars) {
      throw new CronOperatorInputError(`name must be a string of at most ${CRON_OPERATOR_LIMITS.maxNameChars} characters`);
    }
    name = record.name;
  }
  let mode: CronMode | undefined;
  if (record.mode !== undefined) {
    if (record.mode !== "background" && record.mode !== "origin") {
      throw new CronOperatorInputError("mode must be 'background' or 'origin'");
    }
    mode = record.mode;
  }
  return {
    message,
    ...(name === undefined ? {} : { name }),
    ...(mode === undefined ? {} : { mode }),
    schedule: parseSchedule(record.schedule),
    idempotencyKey,
  };
}

function projectJob(origin: string, view: CronJobView): CronOperatorJob {
  const { job } = view;
  const target: CronTargetSummary | null = view.target;
  return {
    id: job.id,
    origin,
    // Names and expressions come from model or operator text, so they carry the same line bound.
    name: projectedLine(job.name, CRON_OPERATOR_LIMITS.maxNameChars),
    mode: job.mode,
    intent: job.intent === "digest" ? "digest" : "message",
    schedule: projectedLine(cronScheduleText(job.schedule), CRON_OPERATOR_LIMITS.maxMessageLineChars),
    status: view.status,
    nextAtMs: view.nextAtMs,
    message: projectedLine(job.message, CRON_OPERATOR_LIMITS.maxMessageLineChars),
    lastOutcome: job.lastOutcome === null ? null : {
      status: job.lastOutcome.status,
      finishedAtMs: job.lastOutcome.finishedAtMs,
      error: projectedError(job.lastOutcome.error),
    },
    lastSkip: job.lastSkip === null ? null : {
      skippedAtMs: job.lastSkip.skippedAtMs,
      reason: projectedLine(job.lastSkip.reason, CRON_OPERATOR_LIMITS.maxErrorLineChars),
    },
    lastFault: job.lastFault === null ? null : {
      recordedAtMs: job.lastFault.recordedAtMs,
      error: projectedLine(job.lastFault.error, CRON_OPERATOR_LIMITS.maxErrorLineChars),
    },
    deliveryFault: view.deliveryFault === null ? null : {
      recordedAtMs: view.deliveryFault.recordedAtMs,
      message: projectedLine(view.deliveryFault.message, CRON_OPERATOR_LIMITS.maxErrorLineChars),
    },
    timer: view.timer === null ? null : {
      ...view.timer,
      error: projectedError(view.timer.error),
      reason: projectedError(view.timer.reason),
    },
    execution: view.execution === null ? null : {
      ...view.execution,
      error: projectedError(view.execution.error),
      reason: projectedError(view.execution.reason),
    },
    target: target === null ? null : {
      taskId: target.taskId,
      status: target.status,
      error: projectedError(target.error),
      reason: projectedError(target.reason),
    },
  };
}

/** Armed work first, then the next due time, then the stable ID. Nothing is truncated. */
function ordered(jobs: CronOperatorJob[]): CronOperatorJob[] {
  const rank = (job: CronOperatorJob): number => job.nextAtMs ?? Number.MAX_SAFE_INTEGER;
  return jobs.sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
}

export function createCronOperator(options: CronOperatorOptions): CronOperator {
  /** Every job every current mapped chat owns. This is the one read every other operation uses. */
  const allJobs = async (
    context: Context,
    known?: readonly CronOperatorOrigin[],
  ): Promise<CronOperatorJob[]> => {
    const harness = options.harness();
    const jobs: CronOperatorJob[] = [];
    for (const origin of known ?? await options.origins(context)) {
      const views = await options.foundation.list(
        harness,
        origin.conversationId,
        cronOwnerFor(origin.sessionKey),
        context,
      );
      for (const view of views) jobs.push(projectJob(origin.sessionKey, view));
    }
    return ordered(jobs);
  };

  const inspectJob = async (jobId: string, context: Context): Promise<CronOperatorJob | undefined> =>
    (await allJobs(context)).find((job) => job.id === jobId);

  return {
    async list(context, offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CronOperatorInputError("offset must be a non-negative integer");
      const origins = await options.origins(context);
      const jobs = await allJobs(context, origins);
      const end = offset + CRON_OPERATOR_LIMITS.maxListRows;
      return {
        origins: origins.map((origin) => origin.sessionKey),
        jobs: jobs.slice(offset, end).map(({ id, origin, name, schedule, status, nextAtMs }) =>
          ({ id, origin, name, schedule, status, nextAtMs })),
        total: jobs.length,
        nextOffset: end < jobs.length ? end : null,
      };
    },

    async show(jobId, context) {
      return (await allJobs(context)).filter((job) => job.id === jobId);
    },

    async create(originSessionKey, request, context) {
      const value = parseCronOperatorRequest(request);
      const origin = (await options.origins(context))
        .find((candidate) => candidate.sessionKey === originSessionKey);
      if (origin === undefined) return { status: "unknown_origin" };
      const harness = options.harness();
      const conversation = await harness.conversation(origin.conversationId, context);
      if (conversation === undefined) {
        throw new CronOperatorInputError("the selected chat's conversation is missing");
      }
      let receipt;
      try {
        // The foundation owns the durable request key and its idempotency: an identical retry
        // returns the same job without re-arming it, a conflicting payload is refused, and a
        // cancelled original is never re-created.
        receipt = await options.foundation.schedule(
          cronOwnerFor(origin.sessionKey),
          { id: conversation.id, commit: (change, inner) => conversation.commit(change, inner) },
          value,
          context,
        );
      } catch (error) {
        // A rolled-back commit admits no job, and the foundation's own validation is definitive: a
        // bad schedule, a conflicting request key or a malformed owner. Any other failure stays a
        // generic failed operation, so its internal text never reaches the terminal.
        if (error instanceof TypeError || error instanceof CronScheduleError) {
          throw new CronOperatorInputError(errorText(error));
        }
        throw error;
      }
      const job = await inspectJob(receipt.jobId, context).catch(() => undefined);
      return {
        status: "scheduled",
        job: job ?? null,
        jobId: receipt.jobId,
        nextAtMs: receipt.nextAtMs,
        deduplicated: receipt.deduplicated,
      };
    },

    async cancel(jobId, context) {
      // Resolve the exact ID across every current origin. Ambiguity is a damaged store, and a
      // cancellation there would be a guess about which record was meant.
      const matches = (await allJobs(context)).filter((job) => job.id === jobId);
      const [match, ...rest] = matches;
      if (match === undefined) return { status: "not_found" };
      if (rest.length > 0) return { status: "ambiguous" };
      const origin = (await options.origins(context))
        .find((candidate) => candidate.sessionKey === match.origin);
      if (origin === undefined) return { status: "not_found" };
      const result = await options.foundation.cancel(
        options.harness(),
        origin.conversationId,
        jobId,
        cronOwnerFor(origin.sessionKey),
        context,
      );
      if (result.status === "not_found") return { status: "not_found" };
      if (result.status === "forbidden") return { status: "forbidden" };
      if (result.status === "already_terminal") {
        return {
          status: "already_terminal",
          job: await inspectJob(jobId, context).catch(() => undefined) ?? match,
        };
      }
      return {
        status: "cancelled",
        job: await inspectJob(jobId, context).catch(() => undefined) ?? null,
        withdrawn: result.withdrawn,
        abortError: projectedError(result.abortError),
      };
    },
  };
}
