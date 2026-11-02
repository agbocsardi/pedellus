import type { JsonValue } from "@earendil-works/chord";
import { Cron } from "croner";

/** The timezone used when a cron request omits one, matching Python's UTC default. */
export const CRON_DEFAULT_TIME_ZONE = "UTC";

/**
 * Schedules this slice accepts. `at` is Python's one-shot schedule; `once` remains an accepted
 * alias so callers written against the first foundation keep working. `after` is a relative
 * one-shot request: it is resolved once, from the controller clock at admission, into the same
 * stored `at` form, so a stored job never carries a relative deadline.
 */
export type CronScheduleRequest =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "after"; readonly afterMs: number }
  | { readonly kind: "every"; readonly everyMs: number }
  | { readonly kind: "cron"; readonly expr: string; readonly timeZone?: string };

export interface CronAtSchedule {
  readonly [key: string]: JsonValue;
  readonly kind: "at";
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

/** A calendar expression evaluated in an IANA time zone. */
export interface CronCalendarSchedule {
  readonly [key: string]: JsonValue;
  readonly kind: "cron";
  readonly expr: string;
  readonly timeZone: string;
}

export type CronSchedule = CronAtSchedule | CronIntervalSchedule | CronCalendarSchedule;

export class CronScheduleError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "CronScheduleError";
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The largest epoch-millisecond value a JavaScript `Date` can represent. */
const MAX_DATE_MS = 8.64e15;

function validAfterMs(afterMs: unknown): number {
  if (!Number.isSafeInteger(afterMs) || (afterMs as number) <= 0) {
    throw new CronScheduleError("after schedule requires a positive integer afterMs");
  }
  return afterMs as number;
}

/** The single instant a relative request resolves to, without ever recalculating it. */
function afterInstant(afterMs: number, now: number): number {
  validAfterMs(afterMs);
  const at = now + afterMs;
  if (!Number.isSafeInteger(at) || at <= now) {
    throw new CronScheduleError("the relative one-shot exceeds the safe integer range");
  }
  if (Math.abs(at) > MAX_DATE_MS) {
    throw new CronScheduleError("the relative one-shot is beyond the representable date range");
  }
  return at;
}

/** Validate an IANA time zone, rejecting fixed UTC offsets masquerading as zone names. */
function validateTimeZone(timeZone: string): string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new CronScheduleError("cron schedules require a non-empty IANA timezone");
  }
  const value = timeZone.trim();
  if (/^[+-]/.test(value)) {
    throw new CronScheduleError("timeZone must be an IANA name, not a UTC offset");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch (error) {
    throw new CronScheduleError(`unknown timezone '${value}': ${errorText(error)}`);
  }
  return value;
}

function compileCron(expr: string, timeZone: string): Cron {
  try {
    return new Cron(expr, { timezone: timeZone, paused: true });
  } catch (error) {
    throw new CronScheduleError(errorText(error));
  }
}

function calendarSchedule(expr: string, timeZone: string): CronCalendarSchedule {
  if (typeof expr !== "string" || expr.trim() === "") {
    throw new CronScheduleError("cron schedule requires a non-empty expression");
  }
  const normalized = expr.trim();
  const zone = validateTimeZone(timeZone);
  compileCron(normalized, zone);
  return { kind: "cron", expr: normalized, timeZone: zone };
}

/**
 * One stored schedule as a fixed human-readable line. It reads no clock, so the same job renders
 * identically everywhere it is shown.
 */
export function cronScheduleText(schedule: CronSchedule): string {
  if (schedule.kind === "at") return `once at ${new Date(schedule.at).toISOString()}`;
  if (schedule.kind === "every") {
    return `every ${schedule.everyMs / 1000}s from ${new Date(schedule.anchorMs).toISOString()}`;
  }
  return `${schedule.expr} in ${schedule.timeZone}`;
}

/**
 * A one-shot instant written as an ISO 8601 timestamp. An explicit UTC offset (or `Z`) is required:
 * interpreting a naive local time would need zone-offset arithmetic the calendar schedule
 * deliberately avoids, and guessing is worse than asking the caller for an unambiguous instant.
 */
export function parseCronInstant(raw: string): number {
  const value = raw.trim();
  if (value === "") {
    throw new CronScheduleError("at must be an ISO 8601 timestamp with a UTC offset, for example 2026-11-01T09:00:00+01:00");
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new CronScheduleError(
      `at must include an explicit UTC offset or Z (got "${value}"); use a cron expression with a time zone for a local wall time`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new CronScheduleError(`at is not a valid ISO 8601 timestamp: ${value}`);
  return parsed;
}

/** Validate a schedule request without comparing it to the clock. */
export function parseCronScheduleRequest(request: CronScheduleRequest): CronScheduleRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new CronScheduleError("schedule must be an object");
  }
  if (request.kind === "at" || request.kind === "once") {
    if ("everyMs" in request || "expr" in request || "timeZone" in request) {
      throw new CronScheduleError("an at schedule must not carry everyMs, expr, or timeZone");
    }
    if (!Number.isSafeInteger(request.at)) {
      throw new CronScheduleError("at schedule requires an integer at (epoch milliseconds)");
    }
    return { kind: "at", at: request.at };
  }
  if (request.kind === "after") {
    if ("at" in request || "everyMs" in request || "expr" in request || "timeZone" in request) {
      throw new CronScheduleError("an after schedule must not carry at, everyMs, expr, or timeZone");
    }
    return { kind: "after", afterMs: validAfterMs(request.afterMs) };
  }
  if (request.kind === "every") {
    if ("at" in request || "expr" in request || "timeZone" in request) {
      throw new CronScheduleError("an every schedule must not carry at, expr, or timeZone");
    }
    if (!Number.isSafeInteger(request.everyMs) || request.everyMs <= 0) {
      throw new CronScheduleError("every schedule requires a positive integer everyMs");
    }
    return { kind: "every", everyMs: request.everyMs };
  }
  if (request.kind === "cron") {
    if ("at" in request || "everyMs" in request) {
      throw new CronScheduleError("a cron schedule must not carry at or everyMs");
    }
    const normalized = calendarSchedule(
      request.expr,
      request.timeZone ?? CRON_DEFAULT_TIME_ZONE,
    );
    return normalized;
  }
  throw new CronScheduleError("schedule kind must be 'at', 'after', 'every', or 'cron'");
}

/** Freeze a request into its stored form; a one-shot must still be in the future. */
export function materializeCronSchedule(
  request: CronScheduleRequest,
  now: number,
): CronSchedule {
  if (!Number.isSafeInteger(now)) {
    throw new CronScheduleError("the controller clock must return an integer epoch-millisecond time");
  }
  if (request.kind === "at" || request.kind === "once") {
    if (!Number.isSafeInteger(request.at)) {
      throw new CronScheduleError("at schedule requires an integer at (epoch milliseconds)");
    }
    if (request.at <= now) {
      throw new CronScheduleError("a one-shot schedule must be in the future");
    }
    return { kind: "at", at: request.at };
  }
  if (request.kind === "after") {
    // A relative request is resolved exactly once, here, from the controller clock. Callers must
    // dedupe a replay against the stored instant instead of re-deriving a new one.
    return { kind: "at", at: afterInstant(request.afterMs, now) };
  }
  if (request.kind === "every") {
    if (!Number.isSafeInteger(request.everyMs) || request.everyMs <= 0) {
      throw new CronScheduleError("every schedule requires a positive integer everyMs");
    }
    const anchorMs = now + request.everyMs;
    if (!Number.isSafeInteger(anchorMs)) {
      throw new CronScheduleError("the first interval occurrence exceeds the safe integer range");
    }
    return { kind: "every", everyMs: request.everyMs, anchorMs };
  }
  const schedule = calendarSchedule(
    request.expr,
    request.timeZone ?? CRON_DEFAULT_TIME_ZONE,
  );
  if (nextCronOccurrence(schedule, now) === null) {
    throw new CronScheduleError("cron expression has no future occurrence");
  }
  return schedule;
}

/**
 * Croner intentionally runs a repeated wall-clock time once, at its first occurrence, but a
 * reference in the second repeated half can make it return the earlier instant. Advance the
 * reference in bounded one-minute steps until croner returns a strictly future candidate. The
 * candidate's previous occurrence recovers the first valid slot after the fold so it is not
 * skipped. The bound covers the largest wall-clock fold in tzdb; it is not a schedule horizon.
 */
const CALENDAR_ADVANCE_MS = 60_000;
const MAX_CALENDAR_ADVANCES = 24 * 60 + 1;

function guardedCron<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new CronScheduleError(errorText(error));
  }
}

/**
 * Croner's backward search can fail on valid expressions such as leap-day or W/LW month lists.
 * Its previous occurrence is only an optional fold repair, so a failure must not reject the
 * schedule; the strictly future forward result is always sufficient.
 */
function previousCronOccurrence(cron: Cron, candidate: Date): number | null {
  try {
    const previous = cron.previousRuns(1, candidate)[0];
    if (previous === undefined) return null;
    const value = previous.getTime();
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * First slot strictly after `afterMs`. Passed slots are skipped, not replayed. A calendar
 * expression is evaluated in its IANA time zone; `at` returns its one instant, or `null` once
 * that instant has passed.
 */
export function nextCronOccurrence(schedule: CronSchedule, afterMs: number): number | null {
  if (!Number.isSafeInteger(afterMs)) {
    throw new CronScheduleError("afterMs must be an integer");
  }
  if (schedule.kind === "at") {
    if (!Number.isSafeInteger(schedule.at)) {
      throw new CronScheduleError("stored at time is not an integer");
    }
    return schedule.at > afterMs ? schedule.at : null;
  }
  if (schedule.kind === "every") {
    if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new CronScheduleError("stored interval is not a positive integer");
    }
    if (!Number.isSafeInteger(schedule.anchorMs) || schedule.anchorMs < 0) {
      throw new CronScheduleError("stored anchor is not a nonnegative integer");
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

  const zone = validateTimeZone(schedule.timeZone);
  if (typeof schedule.expr !== "string" || schedule.expr.trim() === "") {
    throw new CronScheduleError("stored cron expression is empty");
  }
  const cron = compileCron(schedule.expr.trim(), zone);
  let reference = afterMs;
  let advanced = false;
  for (let attempt = 0; attempt < MAX_CALENDAR_ADVANCES; attempt++) {
    const candidate = guardedCron(() => cron.nextRun(new Date(reference)));
    if (candidate === null) return null;
    const next = candidate.getTime();
    if (!Number.isSafeInteger(next)) {
      throw new CronScheduleError("the next occurrence exceeds the safe integer range");
    }
    if (next > afterMs) {
      if (advanced) {
        const prior = previousCronOccurrence(cron, candidate);
        if (prior !== null && prior > afterMs && prior < next) return prior;
      }
      return next;
    }
    advanced = true;
    reference = Math.floor(reference / CALENDAR_ADVANCE_MS) * CALENDAR_ADVANCE_MS
      + CALENDAR_ADVANCE_MS;
  }
  throw new CronScheduleError("cron expression could not advance past the reference time");
}
