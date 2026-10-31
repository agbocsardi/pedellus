/**
 * Canonical default bounds for one memory-digestion invocation.
 *
 * Configuration may narrow or widen them, but a started run captures the values it accepted in its
 * task input and uses those for every later attempt. These are the only defaults; nothing here
 * schedules, enables or activates digestion.
 */

/** Bounds on the one closed-episode chunk a digest run may consume. */
export interface DigestBatchLimits {
  /** Entries examined by one batch; a long entry continues in the next batch. */
  readonly entriesPerBatch: number;
  /** Extracted evidence characters in one batch. A fragment is cut at this bound, never dropped. */
  readonly charsPerBatch: number;
}

/** Every bound one digest run accepts at start: its batch, tool budget, deadline and write budget. */
export interface DigestRunLimits extends DigestBatchLimits {
  /** Individual model-issued tool calls allowed in the run, failed and refused calls included. */
  readonly maxToolCalls: number;
  /** Whole-run deadline from preparation; an expired run fails without acknowledging its batch. */
  readonly runTimeoutMs: number;
  /** Distinct workspace files the run may successfully change. */
  readonly maxChangedFiles: number;
  /** Inserted plus removed text units the run may successfully write, summed across calls. */
  readonly maxDiffChars: number;
}

export const DIGEST_RUN_LIMITS_DEFAULT: DigestRunLimits = Object.freeze({
  entriesPerBatch: 80,
  charsPerBatch: 24_000,
  maxToolCalls: 10,
  runTimeoutMs: 300_000,
  maxChangedFiles: 8,
  maxDiffChars: 32_000,
});

/** True for a positive safe integer, the only shape a digest bound may have. */
export function isDigestBound(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Parse a captured bound object from a durable task input. Every field is required and must be a
 * positive safe integer; a malformed record is rejected instead of silently falling back.
 */
export function digestRunLimitsFrom(value: unknown): DigestRunLimits | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = [
    "entriesPerBatch",
    "charsPerBatch",
    "maxToolCalls",
    "runTimeoutMs",
    "maxChangedFiles",
    "maxDiffChars",
  ] as const;
  const parsed: Partial<Record<(typeof fields)[number], number>> = {};
  for (const field of fields) {
    if (!isDigestBound(record[field])) return undefined;
    parsed[field] = record[field] as number;
  }
  return {
    entriesPerBatch: parsed.entriesPerBatch!,
    charsPerBatch: parsed.charsPerBatch!,
    maxToolCalls: parsed.maxToolCalls!,
    runTimeoutMs: parsed.runTimeoutMs!,
    maxChangedFiles: parsed.maxChangedFiles!,
    maxDiffChars: parsed.maxDiffChars!,
  };
}

/** Reject an invalid in-process bound set before any task, provider call or cursor move. */
export function validateDigestRunLimits(limits: DigestRunLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!isDigestBound(value)) throw new TypeError(`memory digest ${name} must be a positive safe integer`);
  }
}
