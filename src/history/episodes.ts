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
 *   episode (two consecutive resets) is never recorded, so a reset never creates a
 *   phantom discussion.
 * - Catch-up runs in committed background batches and resumes from persisted progress
 *   after a crash. It never blocks gateway open or a model turn, and it changes no
 *   native reset/busy ordering: it only reads entries that are already committed.
 *
 * Deliberately not here: summary generation, retries, summary search, and message/tool
 * indexes. A closed episode is recorded as `summary.status = "pending"`; nothing claims
 * it yet, and no schedule is implied.
 */
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
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

/** One episode: a discussion bounded by committed resets inside a conversation. */
export interface HistoryEpisode {
  readonly conversationId: ConversationId;
  /** First entry of the episode: the reset entry, or the conversation's first entry. */
  readonly startEntryId: EntryId;
  /** Last entry of the episode; null while the episode is open (it continues at the tail). */
  readonly endEntryId: EntryId | null;
  readonly status: "open" | "closed";
  /** Reset entry that starts the episode; null for a conversation's pre-reset segment. */
  readonly resetEntryId: EntryId | null;
  /** Entries in the inclusive boundary range; null when this read did not derive them. */
  readonly entries: number | null;
  readonly messages: number | null;
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

type EpisodeDocument = {
  /** 0 marks a freshly created document; a real boundary is always a positive entry ID. */
  readonly startEntryId: number;
  readonly resetEntryId: number | null;
  readonly endEntryId: number;
  readonly entries: number;
  readonly messages: number;
  readonly toolResults: number;
  summary: EpisodeSummaryDocument;
};

const EpisodeCatalogDoc = defineDoc<EpisodeCatalogDocument>({
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

const EpisodeDoc = defineDocFamily<EpisodeDocument, string>({
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
    // (two consecutive resets) and is not an episode at all.
    const content = state.openResetEntryId === null ? state.entries : state.entries - 1;
    if (content <= 0) return;
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

export function createEpisodeCatalog(options: EpisodeCatalogOptions): EpisodeCatalog {
  const { harness, sessions, context } = options;
  let closed = false;
  const inFlight = new Map<ConversationId, Promise<EpisodeReconcileReport>>();
  const queued = new Map<ConversationId, { timer: ReturnType<typeof setTimeout> | undefined; attempts: number }>();

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
        }
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

  const drain = async (
    conversationId: ConversationId,
    work: { timer: ReturnType<typeof setTimeout> | undefined; attempts: number },
  ): Promise<void> => {
    if (closed) {
      queued.delete(conversationId);
      return;
    }
    try {
      if (!(await inScope(conversationId))) {
        queued.delete(conversationId);
        return;
      }
      const report = await reconcile(conversationId, context);
      work.attempts = 0;
      if (!report.caughtUp) {
        schedule(conversationId, 1);
      } else if (work.timer === undefined) {
        queued.delete(conversationId);
      }
    } catch {
      // A pass is derived, idempotent work: a failure only delays it. The explicit
      // reconcile() call surfaces the error, and a later reset or reopen retries even
      // after this process gives up.
      work.attempts += 1;
      if (closed || context.abortSignal?.aborted || work.attempts >= EPISODE_LIMITS.maxRetries) {
        queued.delete(conversationId);
        return;
      }
      schedule(conversationId, EPISODE_LIMITS.retryDelayMs);
    }
  };

  const schedule = (conversationId: ConversationId, delayMs: number): void => {
    if (closed) return;
    const work = queued.get(conversationId) ?? { timer: undefined, attempts: 0 };
    queued.set(conversationId, work);
    if (work.timer !== undefined) return;
    const timer = setTimeout(() => {
      work.timer = undefined;
      void drain(conversationId, work);
    }, delayMs);
    // Cataloguing must never keep a host process alive on its own.
    timer.unref?.();
    work.timer = timer;
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
      summary: open
        ? { status: "open", summarizerVersion: null, attempts: 0, title: null }
        : { status: "unknown", summarizerVersion: null, attempts: 0, title: null },
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
        // so serving the open episode costs no scan. A reset placed since the last pass
        // leaves progress behind the tail, and the scan below derives boundaries instead.
        const tail = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
        const caughtUp =
          tail === undefined ||
          (progress.scannedThroughEntryId !== null && tail.id <= progress.scannedThroughEntryId);
        if (caughtUp) {
          episodes.push(
            await derivedEpisode(
              conversationId,
              progress.openStartEntryId,
              null,
              true,
              progress.openResetEntryId,
              undefined,
              ctx,
            ),
          );
          if (episodes.length >= limit) {
            return progress.openStartEntryId > 1
              ? { episodes, next: { before: progress.openStartEntryId } }
              : { episodes };
          }
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
            // This reset starts the episode above it: inclusive [reset, newest above].
            if (newest !== null) {
              const open = !sawReset;
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
              sawReset = true;
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
      const recorded = await recordedEpisode(conversationId, startEntryId, ctx);
      if (recorded !== undefined) return recorded;
      const conversation = await harness.conversation(conversationId, ctx);
      if (conversation === undefined) return undefined;
      const progress = progressOf(await harness.snapshot(EpisodeCatalogDoc, conversationId, ctx));
      if (progress.openStartEntryId !== startEntryId) return undefined;
      // The open episode is only claimed while progress reaches the tail: a reset placed since
      // the last pass would otherwise be reported as still open. list() derives that case.
      const tail = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
      if (
        tail !== undefined &&
        (progress.scannedThroughEntryId === null || tail.id > progress.scannedThroughEntryId)
      ) {
        return undefined;
      }
      return derivedEpisode(
        conversationId,
        startEntryId,
        null,
        true,
        progress.openResetEntryId,
        undefined,
        ctx,
      );
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
