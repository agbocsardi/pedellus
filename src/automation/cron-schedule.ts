import type { JsonValue } from "@earendil-works/chord";

/** Schedules this slice can keep. Calendar expressions and time zones are out of scope. */
export type CronScheduleRequest =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "every"; readonly everyMs: number };

export interface CronOnceSchedule {
  readonly [key: string]: JsonValue;
  readonly kind: "once";
  readonly at: number;
}

/**
 * Stored interval schedule. `anchorMs` is the first occurrence; every later occurrence is
 * `anchorMs + k * everyMs`, so the grid survives restarts and a clock that moves backwards.
 */
export interface CronIntervalSchedule {
  readonly [key: string]: JsonValue;
  readonly kind: "every";
  readonly everyMs: number;
  readonly anchorMs: number;
}

export type CronSchedule = CronOnceSchedule | CronIntervalSchedule;

export class CronScheduleError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "CronScheduleError";
  }
}

/** Validate a schedule request without comparing it to the clock. */
export function parseCronScheduleRequest(request: CronScheduleRequest): CronScheduleRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new CronScheduleError("schedule must be an object");
  }
  if (request.kind === "once") {
    if ("everyMs" in request) {
      throw new CronScheduleError("a once schedule must not carry everyMs");
    }
    if (!Number.isSafeInteger(request.at)) {
      throw new CronScheduleError("once schedule requires an integer at (epoch milliseconds)");
    }
    return { kind: "once", at: request.at };
  }
  if (request.kind === "every") {
    if ("at" in request) {
      throw new CronScheduleError("an every schedule must not carry at");
    }
    if (!Number.isSafeInteger(request.everyMs) || request.everyMs <= 0) {
      throw new CronScheduleError("every schedule requires a positive integer everyMs");
    }
    return { kind: "every", everyMs: request.everyMs };
  }
  throw new CronScheduleError("schedule kind must be 'once' or 'every'");
}

/** Freeze a request into its stored form; a one-shot must still be in the future. */
export function materializeCronSchedule(
  request: CronScheduleRequest,
  now: number,
): CronSchedule {
  if (!Number.isSafeInteger(now)) {
    throw new CronScheduleError("the controller clock must return an integer epoch-millisecond time");
  }
  if (request.kind === "once") {
    if (request.at <= now) {
      throw new CronScheduleError("a one-shot schedule must be in the future");
    }
    return { kind: "once", at: request.at };
  }
  return { kind: "every", everyMs: request.everyMs, anchorMs: now + request.everyMs };
}

/** First slot strictly after `afterMs` on the fixed grid. Passed slots are skipped, not replayed. */
export function nextCronOccurrence(schedule: CronIntervalSchedule, afterMs: number): number {
  if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0) {
    throw new CronScheduleError("stored interval is not a positive integer");
  }
  if (!Number.isSafeInteger(schedule.anchorMs) || schedule.anchorMs < 0) {
    throw new CronScheduleError("stored anchor is not a nonnegative integer");
  }
  if (!Number.isSafeInteger(afterMs)) {
    throw new CronScheduleError("afterMs must be an integer");
  }
  const periods = afterMs < schedule.anchorMs
    ? 0
    : Math.floor((afterMs - schedule.anchorMs) / schedule.everyMs) + 1;
  const next = schedule.anchorMs + periods * schedule.everyMs;
  if (!Number.isSafeInteger(next)) {
    throw new CronScheduleError("the next occurrence exceeds the safe integer range");
  }
  return next;
}
