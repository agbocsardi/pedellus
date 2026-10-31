/**
 * Canonical default bounds for one memory-digestion invocation.
 *
 * Configuration may narrow or widen them, but a started run captures the values it accepted in its
 * task input and uses those for every later attempt. These are the only defaults; nothing here
 * schedules, enables or activates digestion.
 */

/** Bounds on the one completed-turn chunk a digest run may consume. */
export interface DigestBatchLimits {
  /**
   * Entries examined by one batch; a longer range or entry continues in the next batch.
   *
   * This is a flood guard, not the real size limit: an ordinary long range of completed turns is
   * expected to fit one batch and is bounded by {@link charsPerBatch}. The entry cap only stops a
   * range made of thousands of tiny (or evidence-free) entries from being walked in one unbounded
   * pass.
   *
   * The minimum is 2: a one-entry chunk cannot always advance, because a range that opens on a
   * `pi.reset` marker (or any other entry carrying no message text) would hand back the same
   * zero-offset entry, refuse its own acknowledgement as a non-advancing chunk and re-offer it
   * forever. Two entries always let a chunk clear one non-evidence entry and progress.
   */
  readonly entriesPerBatch: number;
  /**
   * Extracted evidence characters in one batch, counted in UTF-16 code units. A fragment is cut at
   * this bound, never dropped; the minimum is 2 so one surrogate pair always fits. This is the
   * effective limit on one pass, so a completed-turn range that fits both defaults is digested whole.
   */
  readonly charsPerBatch: number;
}

/** Every bound one digest run accepts at start: its batch, tool budget, deadline and write budget. */
export interface DigestRunLimits extends DigestBatchLimits {
  /** Individual model-issued tool calls allowed in the run, failed and refused calls included. */
  readonly maxToolCalls: number;
  /**
   * Successful provider responses allowed in the run, including tool-call responses. Native failed
   * attempts/retries are reported but do not consume this owner-approved limit. The committed
   * transcript supplies the count; this is not a cap on network requests or financial cost.
   */
  readonly maxRequests: number;
  /**
   * Cumulative input tokens allowed in the run, counted from actual reported usage: `input` plus the
   * `cacheRead` and `cacheWrite` counters (pi-ai reports those separately, so this is not doubled).
   * A response that reports no usage is charged the whole bound instead of a fresh allowance.
   */
  readonly maxInputTokens: number;
  /** Whole-run deadline from preparation; an expired run fails without acknowledging its batch. */
  readonly runTimeoutMs: number;
  /** Distinct workspace files the run may successfully change. */
  readonly maxChangedFiles: number;
  /** Inserted plus removed text units the run may successfully write, summed across calls. */
  readonly maxDiffChars: number;
}

export const DIGEST_RUN_LIMITS_DEFAULT: DigestRunLimits = Object.freeze({
  // 200,000 UTF-16 units is roughly 50k tokens of extracted message text: one ordinary closed
  // episode (a session, a day of chat) fits it, and a digest run reads that episode in one pass
  // rather than dribbling it out 24,000 characters at a time. 2,000 entries is deliberately far
  // above any ordinary episode: the character bound is what actually sizes a batch, and the entry
  // cap exists only so an episode of thousands of tiny (or evidence-free) entries cannot be walked
  // without a bound. Both are configurable per `digest`.
  entriesPerBatch: 2_000,
  charsPerBatch: 200_000,
  maxToolCalls: 24,
  maxRequests: 12,
  maxInputTokens: 500_000,
  runTimeoutMs: 600_000,
  maxChangedFiles: 8,
  maxDiffChars: 32_000,
});

/** The smallest evidence bound that can hold one UTF-16 surrogate pair. */
export const DIGEST_CHARS_PER_BATCH_MIN = 2;

/**
 * The smallest entry bound that always makes progress: one non-evidence entry must be clearable.
 *
 * At 1, an episode opening on a `pi.reset` marker (or a system entry, or a chunk position inside an
 * already-consumed entry) would return a chunk of that single zero-offset entry, which
 * acknowledgement rightly refuses as non-advancing; the deterministic reader would then re-offer it
 * forever. Config, a captured task, the in-process bound check and every direct source override all
 * require at least this value.
 */
export const DIGEST_ENTRIES_PER_BATCH_MIN = 2;

/** True for a positive safe integer, the only shape a digest bound may have. */
export function isDigestBound(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A character bound must also fit one surrogate pair; a bound of 1 would wedge the first chunk. */
export function isDigestCharsBound(value: unknown): value is number {
  return isDigestBound(value) && value >= DIGEST_CHARS_PER_BATCH_MIN;
}

/** An entry bound must also always advance; a bound of 1 would wedge a non-evidence entry. */
export function isDigestEntriesBound(value: unknown): value is number {
  return isDigestBound(value) && value >= DIGEST_ENTRIES_PER_BATCH_MIN;
}

/**
 * Parse a captured bound object from a durable task input. Every field is required and must be a
 * positive safe integer, with the batch minimums applied; a malformed record is rejected instead of
 * silently falling back.
 */
export function digestRunLimitsFrom(value: unknown): DigestRunLimits | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = [
    "entriesPerBatch",
    "charsPerBatch",
    "maxToolCalls",
    "maxRequests",
    "maxInputTokens",
    "runTimeoutMs",
    "maxChangedFiles",
    "maxDiffChars",
  ] as const;
  const parsed: Partial<Record<(typeof fields)[number], number>> = {};
  for (const field of fields) {
    const bound = record[field];
    if (!isDigestBoundOf(field, bound)) return undefined;
    parsed[field] = bound as number;
  }
  return {
    entriesPerBatch: parsed.entriesPerBatch!,
    charsPerBatch: parsed.charsPerBatch!,
    maxToolCalls: parsed.maxToolCalls!,
    maxRequests: parsed.maxRequests!,
    maxInputTokens: parsed.maxInputTokens!,
    runTimeoutMs: parsed.runTimeoutMs!,
    maxChangedFiles: parsed.maxChangedFiles!,
    maxDiffChars: parsed.maxDiffChars!,
  };
}

/** True for the bound of one named digest field, including the batch minimums. */
function isDigestBoundOf(name: string, value: unknown): value is number {
  if (name === "charsPerBatch") return isDigestCharsBound(value);
  if (name === "entriesPerBatch") return isDigestEntriesBound(value);
  return isDigestBound(value);
}

/** Reject an invalid in-process bound set before any task, provider call or cursor move. */
export function validateDigestRunLimits(limits: DigestRunLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (isDigestBoundOf(name, value)) continue;
    if (name === "charsPerBatch") {
      throw new TypeError(
        `memory digest charsPerBatch must be an integer of at least ${DIGEST_CHARS_PER_BATCH_MIN}`,
      );
    }
    if (name === "entriesPerBatch") {
      throw new TypeError(
        `memory digest entriesPerBatch must be an integer of at least ${DIGEST_ENTRIES_PER_BATCH_MIN}`,
      );
    }
    throw new TypeError(`memory digest ${name} must be a positive safe integer`);
  }
}
