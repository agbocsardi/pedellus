import type { JsonValue } from "@earendil-works/chord";
import { Cron } from "croner";

/** The timezone used when a cron request omits one, matching Python's UTC default. */
export const CRON_DEFAULT_TIME_ZONE = "UTC";

/**
 * Schedules this slice accepts. `at` is Python's one-shot schedule; `once` remains an accepted
 * alias so callers written against the first foundation keep working.
 */
export type CronScheduleRequest =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "once"; readonly at: number }
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
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
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
    formatterFor(value).format(0);
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
  throw new CronScheduleError("schedule kind must be 'at', 'every', or 'cron'");
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

function zoneOffsetMinutes(atMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(atMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year ?? Number.NaN;
  const month = values.month ?? Number.NaN;
  const day = values.day ?? Number.NaN;
  const hour = values.hour ?? Number.NaN;
  const minute = values.minute ?? Number.NaN;
  const second = values.second ?? Number.NaN;
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
    || !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)
  ) {
    throw new CronScheduleError("could not resolve the timezone offset");
  }
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const secondStart = Math.floor(atMs / 1000) * 1000;
  return Math.round((local - secondStart) / 60_000);
}

/**
 * Croner intentionally runs a repeated wall-clock time once, at its first occurrence. When a
 * reference falls in the second half of that fold, croner can return the earlier instant. Find
 * the end of the repeated interval so the next slot is always strictly later.
 */
function foldEnd(afterMs: number, timeZone: string): number | null {
  const current = zoneOffsetMinutes(afterMs, timeZone);
  let high = afterMs;
  let low = afterMs - 60 * 60 * 1000;
  while (low > 0 && zoneOffsetMinutes(low, timeZone) === current) {
    high = low;
    low -= 60 * 60 * 1000;
  }
  if (low <= 0) return null;
  const before = zoneOffsetMinutes(low, timeZone);
  if (before <= current) return null;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (zoneOffsetMinutes(middle, timeZone) === current) high = middle;
    else low = middle;
  }
  const end = high + (before - current) * 60_000;
  return Number.isSafeInteger(end) && end > afterMs ? end : null;
}

function nextPastFold(cron: Cron, afterMs: number, timeZone: string): number | null {
  const end = foldEnd(afterMs, timeZone);
  if (end !== null) {
    const atEnd = new Date(end);
    if (cron.match(atEnd)) return end;
    return cron.nextRun(atEnd)?.getTime() ?? null;
  }
  const retry = cron.nextRun(new Date(afterMs + 1000))?.getTime() ?? null;
  if (retry !== null && retry > afterMs) return retry;
  throw new CronScheduleError("cron expression could not advance past the reference time");
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
  const candidate = cron.nextRun(new Date(afterMs));
  if (candidate === null) return null;
  let next = candidate.getTime();
  if (!Number.isSafeInteger(next)) {
    throw new CronScheduleError("the next occurrence exceeds the safe integer range");
  }
  if (next <= afterMs) {
    const folded = nextPastFold(cron, afterMs, zone);
    if (folded === null) return null;
    next = folded;
  }
  if (!Number.isSafeInteger(next)) {
    throw new CronScheduleError("the next occurrence exceeds the safe integer range");
  }
  return next;
}
