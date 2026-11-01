/**
 * Read-only normalization of one stored episode summary for discovery and display.
 *
 * Two derived Durable documents describe a summarized episode:
 * - `nanobot.episode` (keyed by start entry ID) records the immutable closed boundary and the
 *   authoritative summarizer version and lifecycle status;
 * - `nanobot.episode-summary` (keyed `<startEntryId>:<summarizerVersion>`) holds the generated
 *   text, coverage and accounting.
 *
 * This module reads both as untrusted JSON. A legacy, imported, hand-edited or corrupt record is
 * classified (`missing`, `not-ready`, `malformed`) instead of thrown: summary discovery is derived
 * navigation, and a bad summary must never block raw transcript search or a transcript read. Only a
 * `ready` record whose boundary, version and text agree with the episode document is exposed.
 *
 * The summary text is model output over untrusted stored conversation. Callers must quote it and
 * treat it as derived navigation; the original entries remain the authority.
 */
import type { EntryId } from "@earendil-works/pi-durable";

export const HISTORY_SUMMARY_READ_LIMITS = Object.freeze({
  /** Stored summary text is bounded by the summary pass; clamp again for a hand-edited record. */
  maxSummaryChars: 20_000,
  /** Stored titles are at most 120 characters; clamp again for a hand-edited record. */
  maxTitleChars: 500,
});

/** A ready summary, already validated against its episode document. */
export interface HistorySummarySnapshot {
  readonly startEntryId: EntryId;
  readonly resetEntryId: EntryId | null;
  readonly endEntryId: EntryId;
  readonly summarizerVersion: number;
  readonly title: string | null;
  readonly summary: string;
  /** The stored text was clamped to {@link HISTORY_SUMMARY_READ_LIMITS.maxSummaryChars}. */
  readonly summaryTruncated: boolean;
  readonly completedAtMs: number | null;
  /** Episode counts as the catalog recorded them. */
  readonly sourceEntries: number;
  readonly sourceMessages: number;
  readonly sourceToolResults: number;
  /** Entries the summary pass shortened per-entry; the range itself was still covered. */
  readonly sourceTruncatedEntries: number;
  /** False when the summary pass did not read the whole recorded episode range. */
  readonly coverageComplete: boolean;
}

/** Catalog lifecycle of an episode that has no readable ready summary. */
export type HistorySummaryStatus = "open" | "pending" | "failed";

export type HistorySummaryView =
  | { readonly state: "ready"; readonly status: "ready"; readonly snapshot: HistorySummarySnapshot }
  | { readonly state: "not-ready"; readonly status: HistorySummaryStatus }
  | { readonly state: "missing" }
  | { readonly state: "malformed" }
  /** The stored document could not be read at all; distinct from a stored shape that is unreadable. */
  | { readonly state: "unreadable" };

const REFUSED = { state: "malformed" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function entryId(value: unknown): EntryId | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value as EntryId
    : undefined;
}

function statusOf(value: unknown): HistorySummaryStatus | "ready" | undefined {
  return value === "open" || value === "pending" || value === "ready" || value === "failed"
    ? value
    : undefined;
}

/** The immutable episode facts a summary record must agree with. */
export interface HistoryEpisodeSummaryBody {
  readonly startEntryId: EntryId;
  readonly resetEntryId: EntryId | null;
  readonly endEntryId: EntryId;
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
}

/**
 * Classify the catalog's episode document without reading any summary record.
 *
 * `ready` names the authoritative summarizer version and the immutable boundary the record must
 * match; every other state is returned as-is so a caller reports it instead of inventing text.
 */
export type HistoryEpisodeDocumentRead =
  | { readonly kind: "ready"; readonly body: HistoryEpisodeSummaryBody; readonly version: number }
  | { readonly kind: "not-ready"; readonly status: HistorySummaryStatus }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" };

export function readEpisodeDocument(document: unknown, startEntryId: number): HistoryEpisodeDocumentRead {
  if (document === undefined || document === null) return { kind: "missing" };
  if (!isRecord(document) || !isRecord(document.summary)) return { kind: "malformed" };
  const storedStart = entryId(document.startEntryId);
  const end = entryId(document.endEntryId);
  const reset = document.resetEntryId === null ? null : entryId(document.resetEntryId);
  if (storedStart === undefined || storedStart !== startEntryId || end === undefined || end < storedStart) {
    return { kind: "malformed" };
  }
  if (document.resetEntryId !== null && reset === undefined) return { kind: "malformed" };
  const status = statusOf(document.summary.status);
  if (status === undefined) return { kind: "malformed" };
  if (status !== "ready") return { kind: "not-ready", status };
  const version = document.summary.summarizerVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return { kind: "malformed" };
  }
  return {
    kind: "ready",
    version,
    body: {
      startEntryId: storedStart,
      resetEntryId: reset as EntryId | null,
      endEntryId: end,
      entries: count(document.entries),
      messages: count(document.messages),
      toolResults: count(document.toolResults),
    },
  };
}

/**
 * Normalize the stored summary record against its episode document.
 *
 * A record whose status is not `ready`, whose boundary/version disagrees with the episode document,
 * or whose text is empty is not exposed. Counts are normalized rather than trusted; a missing
 * coverage object degrades to `coverageComplete: false` instead of a claim of complete coverage.
 */
export function normalizeReadySummary(
  body: HistoryEpisodeSummaryBody,
  record: unknown,
  version: number,
  options: { readonly fullText?: boolean } = {},
): HistorySummaryView {
  if (record === undefined || record === null) return { state: "missing" };
  if (!isRecord(record)) return REFUSED;
  const storedStart = entryId(record.startEntryId);
  const storedEnd = entryId(record.endEntryId);
  if (storedStart !== body.startEntryId || storedEnd !== body.endEntryId) return REFUSED;
  if (record.summarizerVersion !== version) return REFUSED;
  const storedReset = record.resetEntryId === null ? null : entryId(record.resetEntryId);
  if (record.resetEntryId !== null && storedReset === undefined) return REFUSED;
  if (storedReset !== body.resetEntryId) return REFUSED;
  if (record.status !== "ready") {
    // A catalog that already says ready with a record that has not landed (or was reset to
    // running) is not readable text yet; it is not an error, it is simply not ready.
    return record.status === "running" ? { state: "not-ready", status: "pending" } : REFUSED;
  }
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) return REFUSED;
  const rawTitle = record.title;
  if (rawTitle !== null && typeof rawTitle !== "string") return REFUSED;
  const coverage = isRecord(record.coverage) ? record.coverage : undefined;
  const text = record.summary;
  const bounded = options.fullText === true || text.length <= HISTORY_SUMMARY_READ_LIMITS.maxSummaryChars
    ? text
    : text.slice(0, HISTORY_SUMMARY_READ_LIMITS.maxSummaryChars);
  const title = rawTitle === null || rawTitle.length === 0
    ? null
    : rawTitle.length > HISTORY_SUMMARY_READ_LIMITS.maxTitleChars
      ? rawTitle.slice(0, HISTORY_SUMMARY_READ_LIMITS.maxTitleChars)
      : rawTitle;
  const completedAtMs = typeof record.completedAtMs === "number"
    && Number.isFinite(record.completedAtMs) && record.completedAtMs >= 0
    ? record.completedAtMs
    : null;
  return {
    state: "ready",
    status: "ready",
    snapshot: {
      startEntryId: body.startEntryId,
      resetEntryId: body.resetEntryId,
      endEntryId: body.endEntryId,
      summarizerVersion: version,
      title,
      summary: bounded,
      summaryTruncated: bounded.length < text.length,
      completedAtMs,
      sourceEntries: coverage === undefined ? body.entries : count(coverage.sourceEntries),
      sourceMessages: coverage === undefined ? body.messages : count(coverage.sourceMessages),
      sourceToolResults: coverage === undefined ? body.toolResults : count(coverage.sourceToolResults),
      sourceTruncatedEntries: coverage === undefined ? 0 : count(coverage.truncatedEntries),
      coverageComplete: coverage !== undefined && coverage.complete === true,
    },
  };
}

/** One-line human status for a non-ready or unreadable summary view. */
export function summaryViewNote(view: HistorySummaryView): string {
  switch (view.state) {
    case "ready":
      return "ready";
    case "not-ready":
      return view.status === "open"
        ? "the episode is still open"
        : view.status === "failed"
          ? "summary generation failed"
          : "summary generation has not finished";
    case "missing":
      return "no episode or summary record is stored for that episode start";
    case "malformed":
      return "the stored episode or summary record is unreadable";
    case "unreadable":
      return "the stored episode or summary record could not be read";
  }
}
