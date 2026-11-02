/**
 * Durable records of the episode-summary pass: one enumerable work queue and one summary
 * record per summarized episode.
 *
 * Why a queue document exists: episode documents are a document family keyed by start entry
 * ID, and this Durable version has no family enumeration. A summary pass therefore cannot
 * find pending episodes by scanning them. The queue is the enumerable list of work, and it is
 * written in the same commit as the episode document that creates the work, so a crash can
 * neither lose a closed episode nor queue it twice.
 *
 * Bounds and honesty:
 * - The queue keeps at most {@link EPISODE_SUMMARY_QUEUE_LIMITS.maxQueuedJobs} jobs. A new
 *   episode beyond the cap is not queued and the omission is counted in `overflow`; it stays
 *   `pending` in its episode document, so the gap is visible rather than invented.
 * - Finished jobs are removed. Failed jobs are retained only up to
 *   {@link EPISODE_SUMMARY_QUEUE_LIMITS.maxFailedJobs}; the summary record and the episode
 *   document keep the failure after the queue entry is dropped, because the queue is a work
 *   list, not a report.
 * - Every job is identified by `(startEntryId, summarizerVersion)`, which is derived from
 *   immutable episode boundaries. A retry of the same job is the same identity, never a second
 *   entry.
 * - Nothing here calls a provider, appends a transcript entry or changes a grant. These are
 *   derived bookkeeping documents.
 */
import { defineDoc, defineDocFamily, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

export const EPISODE_SUMMARY_QUEUE_KIND = "nanobot.episode-summary-queue";
export const EPISODE_SUMMARY_KIND = "nanobot.episode-summary";

export const EPISODE_SUMMARY_QUEUE_LIMITS = Object.freeze({
  /** Pending/claimed jobs retained per conversation; beyond it the omission is counted. */
  maxQueuedJobs: 256,
  /** Failed jobs retained in the queue for visibility; older ones are dropped. */
  maxFailedJobs: 20,
  /** Runtime faults a single job may absorb before it stops retrying automatically. */
  maxWorkerFaults: 3,
  /** Bounded final summary text stored per episode. */
  maxSummaryChars: 8_000,
  /** Bounded title derived from the summary. */
  maxTitleChars: 120,
  /** Episodes inspected per backfill page (the catalog's maximum page size). */
  backfillPageSize: 50,
  /** Backfill pages per pass before yielding; the durable cursor resumes the rest. */
  backfillPassesPerRun: 4,
  /** Episode-catalog passes at startup before a backfill scan can list recorded boundaries. */
  startupCatalogPasses: 4,
});

/**
 * Fixed, classified failure vocabulary stored in durable state.
 *
 * Nothing derived from a provider exception, request or response is persisted: provider text can
 * carry tokens, cookies, JWTs or request payloads, and a durable document never expires. A host that
 * wants the provider's own words gets them from `HarnessOptions.onReport` (`task_error`), which stays
 * in process. These strings are the durable contract.
 */
export const EPISODE_SUMMARY_FAILURES = Object.freeze({
  /** The configured model disappeared from the provider catalog. */
  modelUnavailable: "model-unavailable",
  /** The configured thinking level is not supported by the selected model. */
  unsupportedThinkingLevel: "unsupported-thinking-level",
  /** The last provider error was transient and the attempt budget is exhausted. */
  providerTransient: "provider-error-transient",
  /** The provider answered with an error that is not worth retrying. */
  providerPermanent: "provider-error-permanent",
  /** The provider stopped at the output limit without a complete summary. */
  outputLimit: "output-limit",
  /** The provider reported an aborted request without this harness aborting it. */
  providerAborted: "provider-aborted",
  /** The provider returned no text at all. */
  emptySummary: "empty-summary",
  /** The episode range holds no summarizable text. */
  emptySource: "empty-source",
  /** The stored source could not be read at all (a malformed or unsupported stored shape). */
  sourceUnrenderable: "source-unrenderable",
  /** The worker task ended in a runtime fault repeatedly; further automatic attempts stop. */
  workerFaulted: "worker-faulted",
  /** The episode boundary document is missing. */
  boundaryMissing: "episode-boundary-missing",
  /** The episode was recorded by a different summarizer version than this job. */
  versionChanged: "episode-summarizer-version-changed",
  /** The episode already has a ready summary. */
  alreadyReady: "episode-already-ready",
  /** The job is no longer in the queue. */
  jobNotQueued: "job-not-queued",
  /** Another live task owns the job. */
  jobClaimedElsewhere: "job-claimed-by-another-task",
  /** The job's conversation is not mapped chat scope (root, task-owned, forked or missing). */
  conversationOutOfScope: "conversation-out-of-scope",
});

export type EpisodeSummaryFailure = (typeof EPISODE_SUMMARY_FAILURES)[keyof typeof EPISODE_SUMMARY_FAILURES];

/** One queued summary job. `status` is a small closed set; unknown stored values read as failed. */
export interface EpisodeSummaryJob {
  readonly [key: string]: JsonValue;
  readonly startEntryId: number;
  readonly summarizerVersion: number;
  status: "queued" | "claimed" | "failed";
  /** The one task allowed to work this job, or null when nothing owns it. */
  claimedByTaskId: number | null;
  /** Provider attempts recorded for this job; a resume retries the same identity. */
  attempts: number;
  /** Durable backoff deadline of the current attempt, for visibility only. */
  retryAtMs: number | null;
  /** Last classified failure of this job, or null. Never provider text. */
  lastError: EpisodeSummaryFailure | null;
  /** Model fixed when this job first starts, retained across retries and restarts. */
  selectedModel?: { readonly [key: string]: JsonValue; readonly provider: string; readonly modelId: string; readonly thinkingLevel: string | null };
  /** Worker tasks that ended in a runtime fault; bounds automatic recovery. */
  faults: number;
  updatedAtMs: number;
}

export interface EpisodeSummaryOverflow {
  readonly [key: string]: JsonValue;
  /** Closed episodes that exceeded the queue cap and were therefore not queued. */
  omittedJobs: number;
  /** Lowest of those omitted episode starts, once one exists. */
  oldestOmittedEntryId: number | null;
}

export interface EpisodeSummaryQueueDocument {
  readonly [key: string]: JsonValue;
  /** Ascending by `startEntryId`, so the worker drains in discussion order. */
  jobs: EpisodeSummaryJob[];
  /** The single live summary task of this conversation, or null. */
  currentTaskId: number | null;
  overflow: EpisodeSummaryOverflow;
  /**
   * Opt-in watermark: episodes starting at or below it predate summaries for this conversation and
   * are never queued automatically, so enabling the pass cannot spend on existing history. `null`
   * means the watermark has not been recorded yet; a batch that finds it null records it and defers
   * itself, and the startup policy pass records it for every mapped conversation.
   */
  sinceEntryId: number | null;
  /** Episode pagination bound of the durable backfill scan; `null` restarts from the newest. */
  backfillBeforeEntryId: number | null;
  /** When the last backfill pass reached the oldest episode; `null` if it has not. */
  backfillCompleteAtMs: number | null;
}

export const EpisodeSummaryQueueDoc = defineDoc<EpisodeSummaryQueueDocument>({
  kind: EPISODE_SUMMARY_QUEUE_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    jobs: [],
    currentTaskId: null,
    overflow: { omittedJobs: 0, oldestOmittedEntryId: null },
    sinceEntryId: null,
    backfillBeforeEntryId: null,
    backfillCompleteAtMs: null,
  }),
  checkpointWhen: () => true,
});

/** Usage and coverage of one summary record, all counters explicit. */
export interface EpisodeSummaryUsage {
  readonly [key: string]: JsonValue;
  /** Provider requests that returned a usable provider message (success or failure). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costTotal: number;
}

/**
 * Which source entries an episode summary actually saw.
 *
 * `complete` means the whole episode range was read: every entry in `[sourceStart, sourceEnd]`
 * was visited. Per-entry text can still be shortened by the source bound; that is counted in
 * `truncatedEntries` and does not flip `complete`, because it is a detail limit, not a missing
 * range. A short range is folded in one chunk and a long one in as many chunks as it needs.
 */
export interface EpisodeSummaryCoverage {
  readonly [key: string]: JsonValue;
  sourceStartEntryId: number;
  sourceEndEntryId: number;
  /** Counts as the immutable episode document recorded them. */
  sourceEntries: number;
  sourceMessages: number;
  sourceToolResults: number;
  entriesRead: number;
  /** Entries whose text was included; reset, system and compaction entries are skipped. */
  includedEntries: number;
  includedMessages: number;
  includedToolResults: number;
  skippedEntries: number;
  truncatedEntries: number;
  characters: number;
  chunks: number;
  /** Entries in the episode range that the pass did not read, and the last entry it did read. */
  uncoveredEntries: number;
  uncoveredAfterEntryId: number | null;
  complete: boolean;
}

/**
 * One derived episode summary. The document key is `<startEntryId>:<summarizerVersion>`, so a
 * version bump writes a distinct record instead of overwriting another version's history.
 *
 * Accumulators are durable before a provider request and after every response, so a crash, an abort or
 * a retry cannot erase spend that already happened:
 * - `attempts` counts provider requests that were started;
 * - `interruptedCalls` counts attempts whose response never landed (billable, unknown outcome);
 * - `pendingAttempt` is true while exactly one attempt was started and has not been settled, which
 *   covers a crash, an abort or a fault in the middle of the request;
 * - `usage` sums only responses that arrived, so
 *   `attempts === usage.calls + interruptedCalls + (pendingAttempt ? 1 : 0)`.
 */
export interface EpisodeSummaryRecord {
  readonly [key: string]: JsonValue;
  readonly startEntryId: number;
  readonly resetEntryId: number | null;
  readonly endEntryId: number;
  readonly summarizerVersion: number;
  status: "running" | "ready" | "failed";
  provider: string;
  modelId: string;
  title: string | null;
  summary: string | null;
  attempts: number;
  interruptedCalls: number;
  /** One attempt is outstanding: settle it as interrupted before starting another or ending the job. */
  pendingAttempt: boolean;
  /**
   * Provider attempts spent on the chunk currently being folded. Durable, so an abort, a fault or a
   * crash cannot refill the retry budget; reset when a chunk completes.
   */
  chunkAttempts: number;
  /** Durable backoff deadline after an abort or a retryable error; a resumed worker sleeps until it. */
  retryAtMs: number | null;
  coverage: EpisodeSummaryCoverage;
  usage: EpisodeSummaryUsage;
  completedAtMs: number;
  /** Classified failure when the pass failed; null otherwise. Never provider text. */
  error: EpisodeSummaryFailure | null;
}

export const EpisodeSummaryDoc = defineDocFamily<EpisodeSummaryRecord, string>({
  kind: EPISODE_SUMMARY_KIND,
  version: 1,
  scope: "conversation",
  family: true,
  history: "latest",
  fork: "initial",
  initial: (key) => ({
    startEntryId: Number(key.split(":")[0]),
    resetEntryId: null,
    endEntryId: 0,
    summarizerVersion: 0,
    status: "running",
    provider: "",
    modelId: "",
    title: null,
    summary: null,
    attempts: 0,
    interruptedCalls: 0,
    pendingAttempt: false,
    chunkAttempts: 0,
    retryAtMs: null,
    coverage: emptyCoverage(Number(key.split(":")[0])),
    usage: emptyUsage(),
    completedAtMs: 0,
    error: null,
  }),
  checkpointWhen: () => true,
});

/** Document key of one episode summary; the version keeps two summarizer formats apart. */
export function episodeSummaryKey(startEntryId: number, summarizerVersion: number): string {
  return `${startEntryId}:${summarizerVersion}`;
}

export function emptyUsage(): EpisodeSummaryUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costTotal: 0,
  };
}

export function emptyCoverage(startEntryId: number): EpisodeSummaryCoverage {
  return {
    sourceStartEntryId: startEntryId,
    sourceEndEntryId: 0,
    sourceEntries: 0,
    sourceMessages: 0,
    sourceToolResults: 0,
    entriesRead: 0,
    includedEntries: 0,
    includedMessages: 0,
    includedToolResults: 0,
    skippedEntries: 0,
    truncatedEntries: 0,
    characters: 0,
    chunks: 0,
    uncoveredEntries: 0,
    uncoveredAfterEntryId: null,
    complete: false,
  };
}

/** Add one provider response's usage to the episode's totals. */
export function addUsage(
  total: EpisodeSummaryUsage,
  usage: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly totalTokens?: number;
    readonly cost?: { readonly total?: number };
  },
): void {
  total.calls += 1;
  total.inputTokens += usage.input ?? 0;
  total.outputTokens += usage.output ?? 0;
  total.cacheReadTokens += usage.cacheRead ?? 0;
  total.cacheWriteTokens += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.costTotal += usage.cost?.total ?? 0;
}

export function findJob(
  document: EpisodeSummaryQueueDocument,
  startEntryId: number,
  summarizerVersion: number,
): EpisodeSummaryJob | undefined {
  return document.jobs.find(
    (job) => job.startEntryId === startEntryId && job.summarizerVersion === summarizerVersion,
  );
}

/**
 * Which candidates of one backfill page fit in the queue right now.
 *
 * Capacity must delay candidates, not drop them: the caller enqueues `queueable` only, keeps its
 * durable page cursor where it was when `truncated` is true, and retries the same page later
 * (dedupe makes the already-queued ones free). This is why the close path's `overflow` counter stays
 * reserved for jobs genuinely omitted at the cap.
 */
export function planBackfillPage(
  document: EpisodeSummaryQueueDocument,
  starts: readonly number[],
  summarizerVersion: number,
): { readonly queueable: readonly number[]; readonly truncated: boolean; readonly free: number } {
  const fresh = starts.filter(
    (startEntryId) => findJob(document, startEntryId, summarizerVersion) === undefined,
  );
  const free = Math.max(0, EPISODE_SUMMARY_QUEUE_LIMITS.maxQueuedJobs - document.jobs.length);
  return {
    queueable: fresh.slice(0, free),
    truncated: fresh.length > free,
    free,
  };
}

/** The oldest job nobody owns, which is the next unit of work. */
export function nextQueuedJob(document: EpisodeSummaryQueueDocument): EpisodeSummaryJob | undefined {
  let next: EpisodeSummaryJob | undefined;
  for (const job of document.jobs) {
    if (job.status !== "queued") continue;
    if (next === undefined || job.startEntryId < next.startEntryId) next = job;
  }
  return next;
}

/**
 * What became of the task that once claimed a job: still live, ended in a runtime fault, or gone
 * without a fault (an abort, an eviction or a normal terminal hand-off).
 */
export type ClaimOutcome = "live" | "faulted" | "gone";

/**
 * A stored counter read back as a safe non-negative integer.
 *
 * Job and record fields can come from an older layout, a hand-edited document or a forged queue — any
 * JSON a store accepts. Counting with a raw `+= 1` would turn a missing `faults` into `NaN`, and every
 * `NaN >= cap` comparison is false, which would silently disable the cap. Normalizing here keeps every
 * durable counter an exact integer that serializes cleanly.
 */
export function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Settle claims whose task is no longer live: a faulted task's job counts one fault and is retried
 * only while the durable fault budget lasts, then fails permanently with `worker-faulted`. A job whose
 * task vanished without a fault simply returns to the queue. This bounds any future unknown fault to
 * a fixed number of automatic attempts instead of an endless fault/retry loop.
 */
export function reviveOrphanedClaims(
  document: EpisodeSummaryQueueDocument,
  claimOutcome: (taskId: number) => ClaimOutcome,
  now: number,
  maxFaults = EPISODE_SUMMARY_QUEUE_LIMITS.maxWorkerFaults,
): { readonly revived: number; readonly failed: number } {
  let revived = 0;
  let failed = 0;
  for (const job of document.jobs) {
    if (job.status !== "claimed") continue;
    const taskId = job.claimedByTaskId;
    if (taskId !== null && claimOutcome(taskId) === "live") continue;
    const outcome = taskId === null ? "gone" : claimOutcome(taskId);
    job.claimedByTaskId = null;
    job.retryAtMs = null;
    job.updatedAtMs = now;
    if (outcome !== "faulted") {
      job.status = "queued";
      revived += 1;
      continue;
    }
    // A legacy, forged or partially written job may have no usable counter; normalize before counting.
    const cap = Math.max(1, safeCount(maxFaults) || EPISODE_SUMMARY_QUEUE_LIMITS.maxWorkerFaults);
    job.faults = safeCount(job.faults) + 1;
    if (job.faults >= cap) {
      // Clamp so the durable counter stays a small, meaningful number even for a forged value.
      job.faults = cap;
      job.status = "failed";
      job.lastError = EPISODE_SUMMARY_FAILURES.workerFaulted;
      failed += 1;
    } else {
      job.status = "queued";
      revived += 1;
    }
  }
  return { revived, failed };
}

export function dropFailedOverflow(document: EpisodeSummaryQueueDocument): void {
  const failed = document.jobs.filter((job) => job.status === "failed");
  if (failed.length <= EPISODE_SUMMARY_QUEUE_LIMITS.maxFailedJobs) return;
  const drop = new Set(
    failed
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs)
      .slice(0, failed.length - EPISODE_SUMMARY_QUEUE_LIMITS.maxFailedJobs)
      .map((job) => job),
  );
  document.jobs = document.jobs.filter((job) => !drop.has(job));
}

/** Remove exactly one job identity. Another summarizer version's job for the same episode stays. */
export function removeJob(
  document: EpisodeSummaryQueueDocument,
  startEntryId: number,
  summarizerVersion: number,
): void {
  document.jobs = document.jobs.filter(
    (job) => !(job.startEntryId === startEntryId && job.summarizerVersion === summarizerVersion),
  );
}

/** Keep `jobs` ordered by start entry ID after inserting or re-queueing. */
export function sortJobs(document: EpisodeSummaryQueueDocument): void {
  document.jobs.sort((left, right) => left.startEntryId - right.startEntryId);
}

/**
 * Status of the summary task a queue once pointed at, read inside the caller's commit so the
 * decision and the task creation are one atomic write.
 */
export async function liveTask(tx: Tx, taskId: number | null): Promise<boolean> {
  if (taskId === null) return false;
  const record = await tx.task(taskId as TaskId);
  return record !== undefined && record.state.status !== "terminal";
}
