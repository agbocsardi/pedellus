/**
 * Reset-delimited episode catalog over Durable-retained entries.
 *
 * Durable is the transcript authority: this module never writes, edits, or reorders an
 * entry, never creates a task, never calls a model, and never schedules anything. It
 * records derived boundaries and durable summary state in its own documents, so an
 * episode is identified by the committed reset entry that starts it rather than by the
 * time a host command arrived. A reset queued while the conversation is busy is
 * therefore catalogued only once it is actually placed.
 *
 * Bounds:
 * - The per-conversation progress document is a fixed set of counters and cannot grow
 *   with history length.
 * - One small document per closed, non-empty episode holds its summary state. An empty
 *   episode is never recorded and never listed, so a reset never creates a phantom
 *   discussion. An episode is empty when it holds no entry other than its own reset
 *   marker; a reset carrying only handoff text is empty, because that text is part of
 *   the reset entry, not an ordinary message.
 * - Catch-up runs in committed background batches and resumes from persisted progress
 *   after a crash. It never blocks gateway open or a model turn, and it changes no
 *   native reset/busy ordering: it only reads entries that are already committed.
 *
 * Contract of the derived records:
 * - Boundaries are entry IDs, so they are stable for the life of the store.
 * - `entries` counts every entry in the inclusive range, including the episode's reset
 *   entry. `messages` counts only ordinary user and assistant entries and never a reset
 *   handoff; `toolResults` counts tool result entries. System and compaction entries are
 *   entries but not messages.
 * - A reset's `model` user message is synthetic handoff context, so it is not a message
 *   and not episode content. It may later be exposed as separate episode metadata.
 * - Reads are bounded by pages, not by a hard cap: listing reads entries until it has
 *   filled a page of episodes (for a conversation without resets that is the whole
 *   conversation), and reading one episode reads only that episode's entries. The
 *   fast paths cost one entry read plus one document read per episode when the catalog
 *   has caught up. Nothing here writes on a read.
 *
 * Deliberately not here: summary generation, retries, summary search, and message/tool
 * indexes. A closed episode is recorded as `summary.status = "pending"`; nothing claims
 * it yet, and no schedule is implied. There is also no durable enumeration of pending
 * episodes yet: a future summary pass needs its own work queue or an index over those
 * documents rather than a document scan per pass.
 */
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { HistoryChatSession } from "./scope.js";
import { ensureStoreIdentity, type StoreIdentity } from "./store-identity.js";

export const EPISODE_CATALOG_KIND = "nanobot.episode-catalog";
export const EPISODE_KIND = "nanobot.episode";
/** Identity of the summary format/summarizer that will write an episode summary. */
export const EPISODE_SUMMARIZER_VERSION = 1;

export const EPISODE_LIMITS = Object.freeze({
  /** Entries read and committed per reconciliation batch. */
  entriesPerScan: 200,
  /** Batches committed before a pass yields to the event loop and is rescheduled. */
  batchesPerPass: 4,
  /** Entries read per page while listing derived boundaries. */
  entriesPerPage: 200,
  defaultPageSize: 20,
  maxPageSize: 50,
  /** Background retry delay for a failed pass, and the attempt cap per process. */
  retryDelayMs: 2_000,
  maxRetries: 5,
});

const RESET_ENTRY_KIND = "pi.reset";
const USER_ENTRY_KIND = "pi.user";
const ASSISTANT_ENTRY_KIND = "pi.assistant";
const TOOL_RESULT_ENTRY_KIND = "pi.tool-result";

/** Durable summary lifecycle of one episode. */
export interface HistoryEpisodeSummary {
  /**
   * `open` while the episode continues, `pending` once closed and awaiting a summary,
   * `ready`/`failed` after a summary attempt, and `unknown` when the boundary has not
   * been recorded yet because reconciliation has not reached it.
   */
  readonly status: "open" | "pending" | "ready" | "failed" | "unknown";
  readonly summarizerVersion: number | null;
  readonly attempts: number;
  readonly title: string | null;
}

/**
 * One episode: a discussion bounded by committed resets inside a conversation.
 *
 * Only non-empty episodes exist: an episode whose only entry is its own reset marker
 * (two consecutive resets, or a reset carrying only handoff text) is omitted.
 */
export interface HistoryEpisode {
  readonly conversationId: ConversationId;
  /** First entry of the episode: the reset entry, or the conversation's first entry. */
  readonly startEntryId: EntryId;
  /** Last entry of the episode; null while the episode is open (it continues at the tail). */
  readonly endEntryId: EntryId | null;
  readonly status: "open" | "closed";
  /** Reset entry that starts the episode; null for a conversation's pre-reset segment. */
  readonly resetEntryId: EntryId | null;
  /** Entries in the inclusive boundary range, including the reset marker; null when uncounted. */
  readonly entries: number | null;
  /** Ordinary user and assistant entries only: a reset handoff is not a message. */
  readonly messages: number | null;
  /** Tool result entries in the range; null when uncounted. */
  readonly toolResults: number | null;
  readonly summary: HistoryEpisodeSummary;
}

export interface HistoryEpisodeQuery {
  /** Page size after clamping; default {@link EPISODE_LIMITS.defaultPageSize}. */
  readonly limit?: number;
  /** Exclusive upper bound: an episode start returned as `next.before` by the previous page. */
  readonly before?: EntryId;
}

export interface HistoryEpisodePage {
  /** Newest first. */
  readonly episodes: readonly HistoryEpisode[];
  /**
   * Query-bound continuation: the next page lists episodes starting below this durable
   * entry ID. Entry IDs never change and later appends get higher IDs, so a continuation
   * stays stable across appends and reopen.
   */
  readonly next?: { readonly before: EntryId };
}

export interface EpisodeReconcileReport {
  /** Source entries examined by this pass. */
  readonly scanned: number;
  /** Non-empty episodes recorded by this pass. */
  readonly closed: number;
  /** False when the pass hit its bound before catching up; the next pass continues. */
  readonly caughtUp: boolean;
}

/** Fixed-size reconciliation progress for one conversation. */
type EpisodeCatalogDocument = {
  readonly scannedThroughEntryId: number | null;
  readonly openStartEntryId: number | null;
  readonly openResetEntryId: number | null;
  readonly openEndEntryId: number | null;
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
};

type EpisodeSummaryDocument = {
  status: string;
  summarizerVersion: number;
  attempts: number;
  title: string | null;
};

export type EpisodeDocument = {
  /** 0 marks a freshly created document; a real boundary is always a positive entry ID. */
  readonly startEntryId: number;
  readonly resetEntryId: number | null;
  readonly endEntryId: number;
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
  summary: EpisodeSummaryDocument;
};

export const EpisodeCatalogDoc = defineDoc<EpisodeCatalogDocument>({
  kind: EPISODE_CATALOG_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    scannedThroughEntryId: null,
    openStartEntryId: null,
    openResetEntryId: null,
    openEndEntryId: null,
    entries: 0,
    messages: 0,
    toolResults: 0,
  }),
  checkpointWhen: () => true,
});

export const EpisodeDoc = defineDocFamily<EpisodeDocument, string>({
  kind: EPISODE_KIND,
  version: 1,
  scope: "conversation",
  family: true,
  history: "latest",
  fork: "initial",
  initial: () => ({
    startEntryId: 0,
    resetEntryId: null,
    endEntryId: 0,
    entries: 0,
    messages: 0,
    toolResults: 0,
    summary: { status: "pending", summarizerVersion: EPISODE_SUMMARIZER_VERSION, attempts: 0, title: null },
  }),
  checkpointWhen: () => true,
});

interface CatalogProgress {
  readonly scannedThroughEntryId: EntryId | null;
  readonly openStartEntryId: EntryId | null;
  readonly openResetEntryId: EntryId | null;
  readonly openEndEntryId: EntryId | null;
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
}

interface EntryTotals {
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
}

interface ClosedEpisodeBoundary extends EntryTotals {
  readonly startEntryId: EntryId;
  readonly resetEntryId: EntryId | null;
  readonly endEntryId: EntryId;
}

const EMPTY_TOTALS: EntryTotals = { entries: 0, messages: 0, toolResults: 0 };

const OPEN_SUMMARY: HistoryEpisodeSummary = Object.freeze({
  status: "open",
  summarizerVersion: null,
  attempts: 0,
  title: null,
});

const UNRECORDED_SUMMARY: HistoryEpisodeSummary = Object.freeze({
  status: "unknown",
  summarizerVersion: null,
  attempts: 0,
  title: null,
});

const EMPTY_PROGRESS: CatalogProgress = {
  scannedThroughEntryId: null,
  openStartEntryId: null,
  openResetEntryId: null,
  openEndEntryId: null,
  ...EMPTY_TOTALS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryId(value: unknown, field: string): EntryId | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored episode catalog has an invalid ${field}`);
  }
  return value as EntryId;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored episode catalog has an invalid ${field}`);
  }
  return value;
}

function progressOf(document: unknown): CatalogProgress {
  if (document === undefined) return EMPTY_PROGRESS;
  if (!isRecord(document)) throw new Error("Stored episode catalog is malformed");
  return {
    scannedThroughEntryId: entryId(document.scannedThroughEntryId, "scan cursor"),
    openStartEntryId: entryId(document.openStartEntryId, "open episode start"),
    openResetEntryId: entryId(document.openResetEntryId, "open episode reset"),
    openEndEntryId: entryId(document.openEndEntryId, "open episode end"),
    entries: count(document.entries, "open episode entry count"),
    messages: count(document.messages, "open episode message count"),
    toolResults: count(document.toolResults, "open episode tool result count"),
  };
}

function summaryStatus(value: unknown): HistoryEpisodeSummary["status"] {
  return value === "pending" || value === "ready" || value === "failed" ? value : "unknown";
}

function episodeOf(document: unknown, conversationId: ConversationId): HistoryEpisode | undefined {
  if (document === undefined) return undefined;
  if (!isRecord(document) || !isRecord(document.summary)) throw new Error("Stored episode document is malformed");
  const startEntryId = entryId(document.startEntryId, "episode start");
  const resetEntryId = entryId(document.resetEntryId, "episode reset");
  const endEntryId = entryId(document.endEntryId, "episode end");
  // A 0 start marks a fresh document rather than a recorded episode.
  if (startEntryId === null || startEntryId === 0 || endEntryId === null) return undefined;
  return {
    conversationId,
    startEntryId,
    endEntryId,
    status: "closed",
    resetEntryId,
    entries: count(document.entries, "episode entry count"),
    messages: count(document.messages, "episode message count"),
    toolResults: count(document.toolResults, "episode tool result count"),
    summary: {
      status: summaryStatus(document.summary.status),
      summarizerVersion:
        typeof document.summary.summarizerVersion === "number" ? document.summary.summarizerVersion : null,
      attempts: count(document.summary.attempts, "episode summary attempts"),
      title: typeof document.summary.title === "string" ? document.summary.title : null,
    },
  };
}

function pageSize(requested: number | undefined): number {
  if (requested === undefined) return EPISODE_LIMITS.defaultPageSize;
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError("Episode page size must be a positive integer");
  }
  return Math.min(requested, EPISODE_LIMITS.maxPageSize);
}

function isMessageEntry(entry: EntryRecord): boolean {
  return entry.kind === USER_ENTRY_KIND || entry.kind === ASSISTANT_ENTRY_KIND;
}

/**
 * Entries other than the episode's own reset marker. A reset's handoff message is part of
 * the reset entry, so a reset carrying only handoff text is an empty episode.
 */
function contentEntries(entries: number, resetEntryId: EntryId | null): number {
  return resetEntryId === null ? entries : entries - 1;
}

function isToolResultEntry(entry: EntryRecord): boolean {
  return entry.kind === TOOL_RESULT_ENTRY_KIND;
}

/**
 * Fold one ascending batch into the progress counters. Pure: the caller commits the
 * returned progress together with the returned closed boundaries, so a crash leaves
 * either both or neither and the next pass rescans the same range.
 */
function scanBatch(
  progress: CatalogProgress,
  items: readonly EntryRecord[],
): { readonly progress: CatalogProgress; readonly closed: readonly ClosedEpisodeBoundary[] } {
  let state = progress;
  const closed: ClosedEpisodeBoundary[] = [];
  const closeOpenEpisode = (): void => {
    if (state.openStartEntryId === null || state.openEndEntryId === null) return;
    // A reset-started episode also holds its reset entry; with nothing else it is empty
    // (two consecutive resets, or a reset carrying only handoff text) and is no episode.
    if (contentEntries(state.entries, state.openResetEntryId) <= 0) return;
    closed.push({
      startEntryId: state.openStartEntryId,
      resetEntryId: state.openResetEntryId,
      endEntryId: state.openEndEntryId,
      entries: state.entries,
      messages: state.messages,
      toolResults: state.toolResults,
    });
  };
  for (const entry of items) {
    if (entry.kind === RESET_ENTRY_KIND) {
      closeOpenEpisode();
      state = {
        ...state,
        openStartEntryId: entry.id,
        openResetEntryId: entry.id,
        openEndEntryId: null,
        entries: 1,
        messages: 0,
        toolResults: 0,
      };
    } else if (state.openStartEntryId === null) {
      state = {
        ...state,
        openStartEntryId: entry.id,
        openResetEntryId: null,
        openEndEntryId: entry.id,
        entries: 1,
        messages: isMessageEntry(entry) ? 1 : 0,
        toolResults: isToolResultEntry(entry) ? 1 : 0,
      };
    } else {
      state = {
        ...state,
        openEndEntryId: entry.id,
        entries: state.entries + 1,
        messages: state.messages + (isMessageEntry(entry) ? 1 : 0),
        toolResults: state.toolResults + (isToolResultEntry(entry) ? 1 : 0),
      };
    }
  }
  state = { ...state, scannedThroughEntryId: items[items.length - 1]!.id };
  return { progress: state, closed };
}

export interface EpisodeCatalogOptions {
  readonly harness: Harness;
  /** Mapped chat sessions, already authenticated and classified by the host. */
  readonly sessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  /** Background work lifetime; cancelling it stops pending passes. */
  readonly context: Context;
  readonly now?: () => number;
  /**
   * Optional summary queue. It is called inside the commit that records a closed episode, so the
   * episode document and its summary job can never be separated by a crash. Without it episodes
   * close as `pending` and nothing queues or summarizes them.
   */
  readonly summaryJobs?: {
    /**
     * Episode starts closed by one commit. All of them arrive in one call so the callee can order
     * its task reads before its task writes, which Durable requires, and create at most one worker.
     */
    enqueue(tx: Tx, conversationId: ConversationId, startEntryIds: readonly number[]): Promise<void>;
  };
}

export interface EpisodeCatalog {
  /** Durable identity of this store; a derived index binds its rows to it. */
  identity(context: Context): Promise<StoreIdentity>;
  /** Recorded episodes of one conversation, newest first, without writing anything. */
  list(conversationId: ConversationId, query: HistoryEpisodeQuery, context: Context): Promise<HistoryEpisodePage>;
  /** One episode by its start entry ID, or undefined when it is not known. */
  episode(
    conversationId: ConversationId,
    startEntryId: EntryId,
    context: Context,
  ): Promise<HistoryEpisode | undefined>;
  /** Catch up this conversation now; idempotent and bounded, and never schedules a summary. */
  reconcile(conversationId: ConversationId, context: Context): Promise<EpisodeReconcileReport>;
  /** Stop background work and unsubscribe from commits. In-flight passes fail or finish harmlessly. */
  close(): void;
}

/**
 * What one finished background pass should do next.
 *
 * The `requested` input is the fix for a reset that commits while a pass is running: the pass has
 * already read its cursor, so a schedule request that arrives mid-pass must arm another pass instead
 * of being dropped as "caught up". `delayMs` is the pass's own need to continue (a bound was hit, or a
 * retry is due); `requested` is new work seen during the pass.
 */
export function catalogWorkAction(
  state: { readonly requested: boolean; readonly delayMs: number | undefined; readonly timerArmed: boolean },
): "arm-delay" | "arm-now" | "drop" | "keep" {
  if (state.delayMs !== undefined) return "arm-delay";
  if (state.requested) return "arm-now";
  return state.timerArmed ? "keep" : "drop";
}

export function createEpisodeCatalog(options: EpisodeCatalogOptions): EpisodeCatalog {
  const { harness, sessions, context } = options;
  let closed = false;
  const inFlight = new Map<ConversationId, Promise<EpisodeReconcileReport>>();
  interface CatalogWork {
    timer: ReturnType<typeof setTimeout> | undefined;
    attempts: number;
    /** A schedule request arrived while a pass was running. */
    requested: boolean;
    running: boolean;
  }

  const queued = new Map<ConversationId, CatalogWork>();

  const reconcilePass = async (
    conversationId: ConversationId,
    ctx: Context,
  ): Promise<EpisodeReconcileReport> => {
    const conversation = await harness.conversation(conversationId, ctx);
    if (conversation === undefined) return { scanned: 0, closed: 0, caughtUp: true };
    let scanned = 0;
    let closedEpisodes = 0;
    for (let batch = 0; batch < EPISODE_LIMITS.batchesPerPass; batch += 1) {
      const progress = progressOf(await harness.snapshot(EpisodeCatalogDoc, conversationId, ctx));
      const page = await conversation.entries(
        {
          order: "ascending",
          ...(progress.scannedThroughEntryId === null
            ? {}
            : { minEntryId: (progress.scannedThroughEntryId + 1) as EntryId }),
        },
        EPISODE_LIMITS.entriesPerScan,
        undefined,
        ctx,
      );
      if (page.items.length === 0) return { scanned, closed: closedEpisodes, caughtUp: true };
      const { progress: next, closed: boundaries } = scanBatch(progress, page.items);
      scanned += page.items.length;
      await conversation.commit(async (tx) => {
        // Episode documents and the progress cursor land in one commit: a crash between
        // them can neither lose a closed episode nor record one twice.
        const closedStarts: number[] = [];
        for (const boundary of boundaries) {
          const key = String(boundary.startEntryId);
          const document = await tx.doc(EpisodeDoc, conversationId, key, key);
          // Closed episodes are immutable: the sentinel start marks a fresh document, and
          // an existing one keeps whatever a later summary pass has written into it.
          if (document.startEntryId !== 0) continue;
          document.startEntryId = boundary.startEntryId as number;
          document.resetEntryId = boundary.resetEntryId === null ? null : (boundary.resetEntryId as number);
          document.endEntryId = boundary.endEntryId as number;
          document.entries = boundary.entries;
          document.messages = boundary.messages;
          document.toolResults = boundary.toolResults;
          document.summary.status = "pending";
          document.summary.summarizerVersion = EPISODE_SUMMARIZER_VERSION;
          document.summary.attempts = 0;
          document.summary.title = null;
          closedStarts.push(boundary.startEntryId as number);
        }
        // The summary jobs and their worker task land in this same commit, so a crash can
        // neither lose a closed episode's summary nor queue one twice.
        if (closedStarts.length > 0) await options.summaryJobs?.enqueue(tx, conversationId, closedStarts);
        const catalog = await tx.doc(EpisodeCatalogDoc, conversationId);
        catalog.scannedThroughEntryId =
          next.scannedThroughEntryId === null ? null : (next.scannedThroughEntryId as number);
        catalog.openStartEntryId = next.openStartEntryId === null ? null : (next.openStartEntryId as number);
        catalog.openResetEntryId = next.openResetEntryId === null ? null : (next.openResetEntryId as number);
        catalog.openEndEntryId = next.openEndEntryId === null ? null : (next.openEndEntryId as number);
        catalog.entries = next.entries;
        catalog.messages = next.messages;
        catalog.toolResults = next.toolResults;
      }, ctx);
      closedEpisodes += boundaries.length;
      if (page.next === undefined) return { scanned, closed: closedEpisodes, caughtUp: true };
    }
    return { scanned, closed: closedEpisodes, caughtUp: false };
  };

  const reconcile = (conversationId: ConversationId, ctx: Context): Promise<EpisodeReconcileReport> => {
    const running = inFlight.get(conversationId);
    if (running !== undefined) return running;
    const pass = reconcilePass(conversationId, ctx).finally(() => {
      if (inFlight.get(conversationId) === pass) inFlight.delete(conversationId);
    });
    inFlight.set(conversationId, pass);
    return pass;
  };

  const inScope = async (conversationId: ConversationId): Promise<boolean> => {
    const mapped = await sessions(context);
    return mapped.some((session) => session.conversationId === conversationId);
  };

  /** Arm one timer. A running pass is never armed twice; `requested` carries the next need. */
  const arm = (
    conversationId: ConversationId,
    work: CatalogWork,
    delayMs: number,
  ): void => {
    if (closed || work.running || work.timer !== undefined) return;
    const timer = setTimeout(() => {
      work.timer = undefined;
      void drain(conversationId, work);
    }, delayMs);
    // Cataloguing must never keep a host process alive on its own.
    timer.unref?.();
    work.timer = timer;
  };

  const schedule = (conversationId: ConversationId, delayMs: number): void => {
    if (closed) return;
    const work = queued.get(conversationId) ?? { timer: undefined, attempts: 0, requested: false, running: false };
    queued.set(conversationId, work);
    // A reset committed while a pass is in flight must schedule another pass, not be swallowed by
    // the pass that already read its cursor. Without this flag the queue is dropped as "caught up"
    // and the reset waits for the next reset or reopen.
    work.requested = true;
    arm(conversationId, work, delayMs);
  };

  const drain = async (conversationId: ConversationId, work: CatalogWork): Promise<void> => {
    if (closed) {
      queued.delete(conversationId);
      return;
    }
    work.running = true;
    work.requested = false;
    let delayMs: number | undefined;
    try {
      if (!(await inScope(conversationId))) {
        // Not mapped chat history: drop the entry unless a request arrives during this pass.
      } else {
        const report = await reconcile(conversationId, context);
        work.attempts = 0;
        if (!report.caughtUp) delayMs = 1;
      }
    } catch {
      // A pass is derived, idempotent work: a failure only delays it. The explicit reconcile()
      // call surfaces the error, and a later reset or reopen retries even after this process
      // gives up on the pass.
      work.attempts += 1;
      if (!(closed || context.abortSignal?.aborted || work.attempts >= EPISODE_LIMITS.maxRetries)) {
        delayMs = EPISODE_LIMITS.retryDelayMs;
      }
    } finally {
      work.running = false;
    }
    if (closed) {
      queued.delete(conversationId);
      return;
    }
    switch (catalogWorkAction({
      requested: work.requested,
      delayMs,
      timerArmed: work.timer !== undefined,
    })) {
      case "arm-delay":
        schedule(conversationId, delayMs!);
        return;
      case "arm-now":
        // A reset that committed while this pass was running gets its own pass; otherwise the entry
        // above its cursor stays uncatalogued until the next reset or reopen.
        schedule(conversationId, 0);
        return;
      case "drop":
        queued.delete(conversationId);
        return;
      case "keep":
        return;
    }
  };

  const unsubscribe = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== "entry" || change.value.kind !== RESET_ENTRY_KIND) continue;
      schedule(change.value.conversationId, 0);
    }
  });

  // Catch-up after reopen is deferred past gateway open and batched, so a long history
  // never blocks startup or a turn. A conversation outside the mapped chat scope is
  // dropped by the pass itself.
  const initial = setTimeout(() => {
    void (async () => {
      if (closed) return;
      try {
        for (const session of await sessions(context)) schedule(session.conversationId, 0);
      } catch {
        // Leave catch-up to the next reset or an explicit reconcile().
      }
    })();
  }, 0);
  initial.unref?.();

  const recordedEpisode = async (
    conversationId: ConversationId,
    startEntryId: EntryId,
    ctx: Context,
  ): Promise<HistoryEpisode | undefined> =>
    episodeOf(await harness.snapshot(EpisodeDoc, conversationId, String(startEntryId), ctx), conversationId);

  const derivedEpisode = async (
    conversationId: ConversationId,
    startEntryId: EntryId,
    endEntryId: EntryId | null,
    open: boolean,
    resetEntryId: EntryId | null,
    totals: EntryTotals | undefined,
    ctx: Context,
  ): Promise<HistoryEpisode> => {
    if (!open) {
      const recorded = await recordedEpisode(conversationId, startEntryId, ctx);
      if (recorded !== undefined) return recorded;
    }
    return {
      conversationId,
      startEntryId,
      endEntryId,
      status: open ? "open" : "closed",
      resetEntryId,
      entries: totals?.entries ?? null,
      messages: totals?.messages ?? null,
      toolResults: totals?.toolResults ?? null,
      summary: open ? OPEN_SUMMARY : UNRECORDED_SUMMARY,
    };
  };

  /** The open episode as the reconciled catalog recorded it, omitted while it is empty. */
  const openEpisodeFromProgress = (
    conversationId: ConversationId,
    progress: CatalogProgress,
  ): HistoryEpisode | undefined => {
    if (progress.openStartEntryId === null) return undefined;
    if (contentEntries(progress.entries, progress.openResetEntryId) <= 0) return undefined;
    return {
      conversationId,
      startEntryId: progress.openStartEntryId,
      endEntryId: null,
      status: "open",
      resetEntryId: progress.openResetEntryId,
      entries: progress.entries,
      messages: progress.messages,
      toolResults: progress.toolResults,
      summary: OPEN_SUMMARY,
    };
  };

  return {
    identity(ctx) {
      return ensureStoreIdentity(harness, ctx, options.now === undefined ? {} : { now: options.now });
    },

    async list(conversationId, query, ctx) {
      const limit = pageSize(query.limit);
      const conversation = await harness.conversation(conversationId, ctx);
      if (conversation === undefined) return { episodes: [] };
      const progress = progressOf(await harness.snapshot(EpisodeCatalogDoc, conversationId, ctx));
      const episodes: HistoryEpisode[] = [];
      const before = query.before;
      if (before !== undefined && (typeof before !== "number" || !Number.isSafeInteger(before) || before < 1)) {
        throw new TypeError("Episode page bound must be a positive entry ID");
      }
      // A page bound is an episode start from the previous page. Below it every segment
      // ends at a reset, so a segment found there is closed. An arbitrary bound could
      // truncate a segment, so anything else is rejected instead of mislabelled.
      let sawReset = false;
      let scanBelow: EntryId | undefined;
      if (before !== undefined) {
        const marker = (
          await conversation.entries({ order: "ascending", minEntryId: before, maxEntryId: before }, 1, undefined, ctx)
        ).items[0];
        if (marker?.kind !== RESET_ENTRY_KIND) {
          const below = (
            await conversation.entries(
              { order: "descending", ...(before > 1 ? { maxEntryId: (before - 1) as EntryId } : {}) },
              1,
              undefined,
              ctx,
            )
          ).items[0];
          if (below !== undefined) throw new Error("Episode page bound must be an episode start");
          return { episodes: [] };
        }
        sawReset = true;
        scanBelow = (before - 1) as EntryId;
        if (scanBelow < 1) return { episodes: [] };
      } else if (progress.openStartEntryId !== null) {
        // Fast path: when progress reaches the tail, its open start is the current episode,
        // so serving the open episode costs one entry read. A reset placed since the last
        // pass leaves progress behind the tail, and the scan below derives boundaries.
        const tail = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
        const caughtUp =
          tail === undefined ||
          (progress.scannedThroughEntryId !== null && tail.id <= progress.scannedThroughEntryId);
        if (caughtUp) {
          const current = openEpisodeFromProgress(conversationId, progress);
          if (current !== undefined) {
            episodes.push(current);
            if (episodes.length >= limit) {
              return progress.openStartEntryId > 1
                ? { episodes, next: { before: progress.openStartEntryId } }
                : { episodes };
            }
          }
          // An empty current episode (a reset with no content yet) is omitted, but the
          // reset still closed the segment below it.
          sawReset = true;
          scanBelow = (progress.openStartEntryId - 1) as EntryId;
          if (scanBelow < 1) return { episodes };
        }
      }

      // Boundaries and counts come from one descending entry scan, so a listed episode
      // that reconciliation has not recorded yet still shows exact bounds and an
      // `unknown` summary state rather than a missing episode.
      let cursor: Cursor | undefined;
      let exhausted = false;
      let newest: EntryId | null = null;
      let totals: EntryTotals = EMPTY_TOTALS;
      let oldest: EntryId | null = null;
      while (episodes.length < limit) {
        const page = await conversation.entries(
          { order: "descending", ...(scanBelow === undefined ? {} : { maxEntryId: scanBelow }) },
          EPISODE_LIMITS.entriesPerPage,
          cursor,
          ctx,
        );
        if (page.items.length === 0) {
          exhausted = true;
          break;
        }
        let full = false;
        for (const entry of page.items) {
          oldest = entry.id;
          if (entry.kind === RESET_ENTRY_KIND) {
            // This reset starts the episode above it: inclusive [reset, newest above]. The
            // scan reaches resets newest first, so only the first one leaves that episode
            // open; every later reset closed the segment above it, including when that
            // segment is empty and therefore omitted.
            const open = !sawReset;
            sawReset = true;
            if (newest !== null) {
              episodes.push(
                await derivedEpisode(
                  conversationId,
                  entry.id,
                  open ? null : newest,
                  open,
                  entry.id,
                  { ...totals, entries: totals.entries + 1 },
                  ctx,
                ),
              );
              if (episodes.length >= limit) {
                full = true;
                break;
              }
            }
            newest = null;
            totals = EMPTY_TOTALS;
            continue;
          }
          newest ??= entry.id;
          totals = {
            entries: totals.entries + 1,
            messages: totals.messages + (isMessageEntry(entry) ? 1 : 0),
            toolResults: totals.toolResults + (isToolResultEntry(entry) ? 1 : 0),
          };
        }
        if (full) break;
        cursor = page.next;
        if (cursor === undefined) {
          exhausted = true;
          break;
        }
      }
      // The oldest segment has no reset below it. It is the whole conversation when there
      // is no reset at all (open), and otherwise the segment the oldest reset closed.
      if (exhausted && newest !== null && oldest !== null && episodes.length < limit) {
        episodes.push(
          await derivedEpisode(conversationId, oldest, sawReset ? newest : null, !sawReset, null, totals, ctx),
        );
      }
      const last = episodes[episodes.length - 1];
      if (!exhausted && last !== undefined && last.startEntryId > 1) {
        return { episodes, next: { before: last.startEntryId } };
      }
      return { episodes };
    },

    async episode(conversationId, startEntryId, ctx) {
      if (typeof startEntryId !== "number" || !Number.isSafeInteger(startEntryId) || startEntryId < 1) {
        throw new TypeError("Episode start must be a positive entry ID");
      }
      // A recorded closed episode is immutable, so it is the same answer before and after
      // reconciliation.
      const recorded = await recordedEpisode(conversationId, startEntryId, ctx);
      if (recorded !== undefined) return recorded;
      const conversation = await harness.conversation(conversationId, ctx);
      if (conversation === undefined) return undefined;
      const progress = progressOf(await harness.snapshot(EpisodeCatalogDoc, conversationId, ctx));

      // Derive exactly like list() does, so an unreconciled boundary is not reported as
      // unknown: a start is a reset entry, or the conversation's oldest entry.
      const marker = (
        await conversation.entries(
          { order: "ascending", minEntryId: startEntryId, maxEntryId: startEntryId },
          1,
          undefined,
          ctx,
        )
      ).items[0];
      if (marker === undefined) return undefined;
      const resetEntryId = marker.kind === RESET_ENTRY_KIND ? startEntryId : null;
      if (resetEntryId === null) {
        const below = (
          await conversation.entries(
            { order: "descending", ...(startEntryId > 1 ? { maxEntryId: (startEntryId - 1) as EntryId } : {}) },
            1,
            undefined,
            ctx,
          )
        ).items[0];
        // A non-reset entry starts an episode only when nothing precedes it.
        if (below !== undefined) return undefined;
      }

      // While the catalog reaches the tail, its open episode is exact and costs one read.
      const tail = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
      if (tail === undefined) return undefined;
      if (
        progress.scannedThroughEntryId !== null &&
        tail.id <= progress.scannedThroughEntryId &&
        progress.openStartEntryId === startEntryId
      ) {
        return openEpisodeFromProgress(conversationId, progress);
      }

      // Otherwise walk this episode only: from its start to the next reset or the tail.
      let totals: EntryTotals = EMPTY_TOTALS;
      let lastEntryId: EntryId | null = null;
      let open = true;
      let from: EntryId = startEntryId;
      while (true) {
        const page = await conversation.entries(
          { order: "ascending", minEntryId: from },
          EPISODE_LIMITS.entriesPerPage,
          undefined,
          ctx,
        );
        if (page.items.length === 0) break;
        let closed = false;
        for (const entry of page.items) {
          if (entry.id !== startEntryId && entry.kind === RESET_ENTRY_KIND) {
            open = false;
            closed = true;
            break;
          }
          lastEntryId = entry.id;
          totals = {
            entries: totals.entries + 1,
            messages: totals.messages + (isMessageEntry(entry) ? 1 : 0),
            toolResults: totals.toolResults + (isToolResultEntry(entry) ? 1 : 0),
          };
        }
        if (closed || page.next === undefined) break;
        from = (page.items[page.items.length - 1]!.id + 1) as EntryId;
      }
      if (lastEntryId === null || contentEntries(totals.entries, resetEntryId) <= 0) return undefined;
      return {
        conversationId,
        startEntryId,
        endEntryId: open ? null : lastEntryId,
        status: open ? "open" : "closed",
        resetEntryId,
        entries: totals.entries,
        messages: totals.messages,
        toolResults: totals.toolResults,
        summary: open ? OPEN_SUMMARY : UNRECORDED_SUMMARY,
      };
    },

    reconcile,

    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearTimeout(initial);
      for (const work of queued.values()) {
        if (work.timer !== undefined) clearTimeout(work.timer);
      }
      queued.clear();
    },
  };
}
