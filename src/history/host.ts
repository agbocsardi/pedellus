/**
 * History host wiring of one gateway open: the store identity, the episode catalog and its optional
 * summary pass, the derived search index, the memory-recall host and every read-only history method
 * of the Gateway.
 *
 * Every read resolves a host-supplied session key through the shared mapped-chat scope; nothing here
 * accepts a conversation ID from a caller, writes a transcript or calls a model (the summary pass's
 * own task is the one exception, and it is opt-in). Durable stays the canonical transcript; the
 * catalog, summaries and index are derived and rebuildable.
 */
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  type AgentState,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import { createDigestSource, type DigestSource } from "./digestion.js";
import type { DigestRunLimits } from "./digest-limits.js";
import { EpisodeDoc, createEpisodeCatalog, type EpisodeCatalog, type HistoryEpisode } from "./episodes.js";
import { createHistoryIndex, HISTORY_INDEX_LIMITS, historyIndexPath, type HistoryIndex, type HistorySession } from "./index.js";
import { EPISODE_SUMMARY_QUEUE_LIMITS, EpisodeSummaryDoc, episodeSummaryKey } from "./summary-queue.js";
import { createEpisodeSummaries, type EpisodeSummaries } from "./summary-task.js";
import { normalizeReadySummary, readEpisodeDocument, type HistorySummaryView } from "./summary-view.js";
import { readChatSessions, type ChatScopeExclusion, type HistoryChatSession } from "./scope.js";
import { ensureStoreIdentity, type StoreIdentity } from "./store-identity.js";
import { createHistoryBackend } from "../memory/history.js";
import { createNotesBackend } from "../memory/notes.js";
import { createMemoryService } from "../memory/service.js";
import { MEMORY_TOOL_NAMES, type MemoryHost, type MemoryService } from "../memory/contracts.js";
import { ConfigToolCaptureDoc, verifyCapturedTool } from "../tools/config-authority.js";
import type { ModelReference } from "../config.js";
import type { ConversationRegistry } from "../runtime/authority.js";
import { SessionMap, type SessionScope } from "../runtime/sessions.js";
import type { Gateway, HistoryEntryQuery, OpenGatewayOptions } from "../runtime/types.js";

export interface EpisodeSummaryPassOptions {
  /** The validated effective summary model; `undefined` disables the pass. */
  readonly model: OpenGatewayOptions["episodeSummary"];
  /** No override and no configured model: each job captures the conversation's current model. */
  readonly useConversationModel: boolean;
  /** True when the host supplied no override, so open episodes are included at activation. */
  readonly includeOpenAtActivation: boolean;
  readonly now: () => number;
  /** The conversation's current selection as the live catalog resolves it. */
  readonly conversationModel: (agent: Readonly<AgentState> | undefined) => ModelReference;
  readonly allowModel: (model: ModelReference) => boolean;
  /** Backstop scope: a job whose conversation is not chat never reaches a provider call. */
  readonly scope: (tx: Tx, id: ConversationId) => Promise<ChatScopeExclusion | undefined>;
  /** Resolved lazily: the catalog is created after the pass so its extension is in the registry. */
  readonly catalog: () => EpisodeCatalog;
}

/**
 * The durable episode-summary pass. Constructed before the Harness opens so its extension is in the
 * initial registry; the object holds no harness, and every operation receives Durable's own
 * transaction or task surface.
 */
export function createEpisodeSummaryPass(options: EpisodeSummaryPassOptions): EpisodeSummaries | undefined {
  const model = options.model;
  if (model === undefined) return undefined;
  return createEpisodeSummaries({
    model: {
      provider: model.provider,
      modelId: model.modelId,
      ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
    },
    ...(model.backfill === undefined ? {} : { backfill: model.backfill }),
    ...(options.useConversationModel ? {
      resolveModel: async (tx: Tx, conversationId: ConversationId) => ({
        ...options.conversationModel(await tx.doc(AgentDoc, conversationId)),
        thinkingLevel: null,
      }),
    } : {}),
    allowModel: (provider: string, modelId: string) => options.allowModel({ provider, modelId }),
    includeOpenAtActivation: options.includeOpenAtActivation,
    scope: (tx, conversationId) => options.scope(tx, conversationId),
    listEpisodes: (conversationId, query, ctx) =>
      options.catalog().list(
        conversationId,
        query.before === undefined ? { limit: query.limit } : { limit: query.limit, before: query.before as EntryId },
        ctx,
      ),
    now: options.now,
  });
}

/** Authority the recall scope needs: each caller's role and its captured grant. */
export interface HistoryRecallAuthority {
  readonly registry: ConversationRegistry;
  readonly workerToolNames: () => readonly string[];
  readonly scheduledRunCapabilityNames: (origin: ConversationId) => readonly string[];
}

export interface HistoryHostOptions {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly context: Context;
  readonly now: () => number;
  readonly dbPath: string;
  readonly workspace: string;
  readonly memoryFiles: readonly string[];
  readonly historyEnabled: boolean;
  readonly sessions: SessionScope;
  /** Automation conversations in episode-catalog shape; never chat, so no session key is implied. */
  readonly automationSessions: () => readonly HistoryChatSession[];
  readonly digestLimits: Pick<DigestRunLimits, "entriesPerBatch" | "charsPerBatch">;
  readonly summaries: EpisodeSummaries | undefined;
  /** The deliberate opt-in to queue every closed episode without a ready summary. */
  readonly summaryBackfill: boolean;
  readonly authority: HistoryRecallAuthority;
}

type HistoryGatewayMethods = Pick<Gateway,
  | "historyIdentity" | "listHistoryEpisodes" | "historyEpisode" | "reconcileHistoryEpisodes"
  | "historyEpisodeSummary" | "historySummaryQueue" | "drainEpisodeSummaries" | "backfillEpisodeSummaries"
  | "retryEpisodeSummary" | "historySearch" | "historySummarySearch" | "historySummary" | "historyEntries">;

export interface HistoryHost {
  readonly storeIdentity: StoreIdentity;
  readonly digestSource: DigestSource;
  readonly episodeCatalog: EpisodeCatalog;
  readonly historyIndex: HistoryIndex;
  /** Approved recall; `undefined` when the host disabled agent history. */
  readonly memoryService: MemoryService | undefined;
  readonly methods: HistoryGatewayMethods;
  /** Summary policy and cut-chain repair for every mapped chat; derived work, never fatal. */
  settleSummaries(context: Context): Promise<void>;
}

const summariesRequired = () => new Error("Episode summaries require an explicit provider/model choice");

function assertEpisodeStart(startEntryId: number): void {
  if (!Number.isSafeInteger(startEntryId) || startEntryId < 1) {
    throw new TypeError("Episode start must be a positive entry ID");
  }
}

/** The closable parts of a history host, recorded as each starts so a failed open can close them. */
export interface HistoryHostParts {
  episodeCatalog?: EpisodeCatalog;
  historyIndex?: HistoryIndex;
  memoryService?: MemoryService;
}

/**
 * Open the derived history of one gateway. A part may start background work as soon as it exists,
 * so each is recorded in `parts` immediately: the caller closes them on a failed open, in order.
 */
export async function openHistoryHost(options: HistoryHostOptions, parts: HistoryHostParts): Promise<HistoryHost> {
  const { harness, root, context, sessions, summaries } = options;
  const rootId = root.id;
  const { mappedChatSessions, chatConversationIdFor, mappedChatConversationFor } = sessions;
  // One immutable identity document per store, minted on first open. A derived index binds its rows
  // to this value instead of to a file path, which a replaced store can reuse.
  const storeIdentity = await ensureStoreIdentity(harness, context, { now: options.now });

  // Episode cataloguing covers chat and automation conversations alike: a scheduled run's episodes
  // are exactly the executions a recurring job accumulates, and a one-off job's are its occurrence
  // in the shared catch-all conversation. Summary queueing is conversation-scoped, so it needs no
  // session key; the read-only history tool still resolves sources through the mapped-chat rule and
  // therefore never presents these conversations as chats.
  const episodeSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> =>
    [...(await mappedChatSessions(ctx)), ...options.automationSessions()];
  // The imported prefix is already consumed by its atomically seeded cursor. Do not exclude entire
  // legacy channels: that would also suppress future closed episodes. Automation conversations
  // remain excluded by the shared mapped ordinary-chat scope.
  const digestSource = createDigestSource({ harness, sessions: mappedChatSessions, limits: options.digestLimits });
  // Bounded, background-only derived state: reset-delimited episode boundaries and their durable
  // summary status. It reads committed entries only and changes no reset or busy ordering. A closed
  // episode is recorded as pending; with summaries opted in, the same commit queues its summary job,
  // and without them nothing schedules or calls a provider.
  const episodeCatalog = createEpisodeCatalog({
    harness,
    sessions: episodeSessions,
    context,
    ...(summaries === undefined ? {} : { summaryJobs: { enqueue: summaries.enqueue } }),
  });
  parts.episodeCatalog = episodeCatalog;

  /**
   * Read-only view of one derived episode summary. The catalog's episode document is the authority
   * for the closed boundary and the authoritative summarizer version; the version-keyed summary
   * record supplies the text. Both are read as untrusted JSON through public document snapshots, and
   * a missing, malformed or unreadable record is classified instead of thrown, so summary discovery
   * can never block raw transcript search. No model call, no summary job, no Durable write.
   */
  async function readEpisodeSummary(
    conversationId: ConversationId, startEntryId: EntryId, ctx: Context, fullText = false,
  ): Promise<HistorySummaryView> {
    let episode: unknown;
    try {
      episode = await harness.snapshot(EpisodeDoc, conversationId, String(startEntryId), ctx);
    } catch {
      return { state: "unreadable" };
    }
    const classified = readEpisodeDocument(episode, startEntryId);
    if (classified.kind !== "ready") {
      return classified.kind === "not-ready" ? { state: "not-ready", status: classified.status } : { state: classified.kind };
    }
    let record: unknown;
    try {
      record = await harness.snapshot(EpisodeSummaryDoc, conversationId, episodeSummaryKey(startEntryId, classified.version), ctx);
    } catch {
      return { state: "unreadable" };
    }
    return normalizeReadySummary(classified.body, record, classified.version, { fullText });
  }

  // Derived, rebuildable search index. Its file is separate from Durable's store, and every Durable
  // read goes through the root commit without a write. A missing index is rebuilt from retained
  // entries, and it is bound to this store's committed identity.
  const historySessions = async (ctx: Context): Promise<readonly HistorySession[]> => {
    const mapping = await harness.snapshot(SessionMap, rootId, ctx);
    if (mapping === undefined) return [];
    const mappedSessions = readChatSessions(mapping.sessions, rootId);
    if (mappedSessions.length > HISTORY_INDEX_LIMITS.maxMappedSessions) {
      throw new Error(
        `History search supports at most ${HISTORY_INDEX_LIMITS.maxMappedSessions} mapped chat sessions; ` +
        `${mappedSessions.length} are present`,
      );
    }
    // Fail loudly rather than silently indexing a task-owned transcript or inherited fork.
    await sessions.assertMappedChatConversations(mappedSessions, ctx);
    return mappedSessions;
  };
  const historyIndex = createHistoryIndex({
    indexPath: historyIndexPath(options.dbPath),
    sourcePath: options.dbPath,
    storeId: storeIdentity.storeId,
    sessions: historySessions,
    scan: (ctx, read) => root.commit(read, ctx),
    readSummary: (ctx, conversationId, startEntryId) => readEpisodeSummary(conversationId, startEntryId, ctx),
  });
  parts.historyIndex = historyIndex;

  async function digestEpisodeView(episode: HistoryEpisode, ctx: Context): Promise<HistoryEpisode> {
    let status: NonNullable<HistoryEpisode["digestion"]>["status"] = "unknown";
    let nextEntryId: number | null = null;
    let nextItemIndex: number | null = null;
    let nextTextStart: number | null = null;
    try {
      const cursor = await digestSource.cursor(episode.conversationId, ctx);
      nextEntryId = cursor.nextEntryId;
      nextItemIndex = cursor.nextItemIndex;
      nextTextStart = cursor.nextTextStart;
      if (episode.endEntryId !== null) {
        if (nextEntryId !== null && nextEntryId > episode.endEntryId) {
          status = "digested";
          // The importer's reset provenance identifies the baseline, not a name suffix or a fake
          // successful digest task. Future episodes in the same chat are not legacy units.
          const conversation = await harness.conversation(episode.conversationId, ctx);
          const first = (await conversation?.entries({ order: "ascending", minEntryId: episode.startEntryId,
            maxEntryId: episode.startEntryId }, 1, undefined, ctx))?.items[0];
          if (first?.data && typeof first.data === "object" && "legacy" in first.data) status = "imported-baseline";
        } else status = nextEntryId !== null && (nextEntryId > episode.startEntryId
          || (nextEntryId === episode.startEntryId && (cursor.nextItemIndex > 0 || cursor.nextTextStart > 0)))
          ? "partial" : "not-started";
      }
    } catch { /* An unreadable frontier is unknown, never guessed as pending or consumed. */ }
    if (episode.status === "open") status = "open-ineligible";
    return { ...episode, digestion: { status, nextEntryId, nextItemIndex, nextTextStart } };
  }

  const methods: HistoryGatewayMethods = {
    historyIdentity: () => Promise.resolve(storeIdentity),
    async listHistoryEpisodes(sessionKey, query, ctx) {
      const conversationId = await chatConversationIdFor(sessionKey, ctx);
      const page = await episodeCatalog.list(conversationId, query, ctx);
      return { ...page, episodes: await Promise.all(page.episodes.map((episode) => digestEpisodeView(episode, ctx))) };
    },
    async historyEpisode(sessionKey, startEntryId, ctx) {
      const conversationId = await chatConversationIdFor(sessionKey, ctx);
      const episode = await episodeCatalog.episode(conversationId, startEntryId as EntryId, ctx);
      return episode === undefined ? undefined : digestEpisodeView(episode, ctx);
    },
    async reconcileHistoryEpisodes(sessionKey, ctx) {
      return episodeCatalog.reconcile(await chatConversationIdFor(sessionKey, ctx), ctx);
    },
    async historyEpisodeSummary(sessionKey, startEntryId, ctx) {
      if (summaries === undefined) throw summariesRequired();
      assertEpisodeStart(startEntryId);
      return summaries.record(harness, await chatConversationIdFor(sessionKey, ctx), startEntryId, ctx);
    },
    async historySummaryQueue(sessionKey, ctx) {
      if (summaries === undefined) throw summariesRequired();
      return summaries.queue(harness, await chatConversationIdFor(sessionKey, ctx), ctx);
    },
    async drainEpisodeSummaries(sessionKey, ctx) {
      if (summaries === undefined) throw summariesRequired();
      return summaries.drain(harness, await chatConversationIdFor(sessionKey, ctx), ctx);
    },
    async backfillEpisodeSummaries(sessionKey, ctx) {
      if (summaries === undefined) throw summariesRequired();
      return summaries.backfill(harness, await chatConversationIdFor(sessionKey, ctx), ctx);
    },
    async retryEpisodeSummary(sessionKey, startEntryId, ctx) {
      if (summaries === undefined) throw summariesRequired();
      assertEpisodeStart(startEntryId);
      return summaries.retry(harness, await chatConversationIdFor(sessionKey, ctx), startEntryId, ctx);
    },
    historySearch: (query, ctx) => historyIndex.search(query, ctx),
    historySummarySearch: (query, ctx) => historyIndex.searchSummaries(query, ctx),
    async historySummary(sessionKey, startEntryId, ctx) {
      assertEpisodeStart(startEntryId);
      return readEpisodeSummary(await chatConversationIdFor(sessionKey, ctx), startEntryId as EntryId, ctx);
    },
    async historyEntries(sessionKey, query, limit, cursor, ctx) {
      if (typeof sessionKey !== "string" || sessionKey.length === 0) {
        throw new TypeError("History entry session key must be a non-empty string");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new TypeError("History entry page limit must be an integer from 1 to 200");
      }
      if (query === null || typeof query !== "object" || Array.isArray(query)) {
        throw new TypeError("History entry query must be an object");
      }
      const allowed = new Set(["minEntryId", "maxEntryId", "order"]);
      for (const key of Object.keys(query)) {
        if (!allowed.has(key)) throw new TypeError(`History entry query has an unsupported field: ${key}`);
      }
      const { minEntryId, maxEntryId, order } = query;
      for (const [name, value] of [["minEntryId", minEntryId], ["maxEntryId", maxEntryId]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new TypeError(`History entry ${name} must be a positive entry ID`);
        }
      }
      if (order !== undefined && order !== "ascending" && order !== "descending") {
        throw new TypeError("History entry order must be ascending or descending");
      }
      const conversation = await mappedChatConversationFor(sessionKey, ctx);
      const page = await conversation.entries({
        ...(minEntryId === undefined ? {} : { minEntryId }),
        ...(maxEntryId === undefined ? {} : { maxEntryId }),
        ...(order === undefined ? {} : { order }),
      }, limit, cursor, ctx);
      return {
        conversationId: conversation.id,
        sessionKey,
        items: page.items,
        ...(page.next === undefined ? {} : { next: page.next }),
      };
    },
  };

  const { registry } = options.authority;
  /**
   * Recall scope for one caller. A mapped chat reads its own approved notes and mapped history; a
   * live worker or scheduled run reads only what its durable capture names while its origin is still
   * an authenticated mapped chat that holds recall now, so a narrowed config denies instead of
   * widening. A worker reads notes from its own checkout.
   */
  const memoryHost: MemoryHost = {
    async scope(caller, ctx, operation: typeof MEMORY_TOOL_NAMES[number]) {
      const worker = registry.isWorker(caller);
      const scheduledRun = registry.isScheduledRun(caller);
      if (!registry.isChat(caller) && !worker && !scheduledRun) {
        throw new Error("Memory recall is unavailable in this conversation");
      }
      const mapped = await mappedChatSessions(ctx);
      let workspaceRoot = options.workspace;
      if (worker || scheduledRun) {
        const verdict = await verifyCapturedTool(
          () => harness.snapshot(ConfigToolCaptureDoc, caller, ctx), operation, (id) => registry.isChat(id),
        );
        const grants = worker
          ? options.authority.workerToolNames()
          : verdict.ok ? options.authority.scheduledRunCapabilityNames(verdict.origin) : [];
        if (!verdict.ok
          || (verdict.capture.classifierModel !== null && typeof verdict.capture.classifierModel !== "string")
          || !mapped.some((session) => session.conversationId === verdict.origin)
          || !grants.includes(operation)) {
          throw new Error(worker
            ? "Worker memory recall is outside its live captured authority"
            : "Scheduled-run memory recall is outside its live captured authority");
        }
        if (worker) {
          const workerRoot = registry.workerRoot(caller);
          if (workerRoot === undefined) throw new Error("Worker workspace is unavailable; refusing memory access");
          workspaceRoot = workerRoot;
        }
      } else if (!mapped.some((session) => session.conversationId === caller)) {
        throw new Error("Memory recall is unavailable in this conversation");
      }
      return {
        storeId: storeIdentity.storeId,
        workspaceRoot,
        memoryFiles: options.memoryFiles,
        sessions: mapped.map((session) => ({
          sessionKey: session.sessionKey,
          conversationId: session.conversationId,
          channel: session.sessionKey.split(":", 1)[0] ?? null,
        })),
      };
    },
    async entries(session: string, query: HistoryEntryQuery, limit: number, cursor: Cursor | undefined, ctx: Context) {
      await mappedChatConversationFor(session, ctx);
      return methods.historyEntries(session, query, limit, cursor, ctx);
    },
    async summary(session, episodeStart, ctx) {
      const conversation = await mappedChatConversationFor(session, ctx);
      return readEpisodeSummary(conversation.id, episodeStart as EntryId, ctx, true);
    },
    search: (query, ctx) => methods.historySearch(query, ctx),
    searchSummaries: (query, ctx) => methods.historySummarySearch(query, ctx),
  };
  const memoryService = options.historyEnabled
    ? createMemoryService(memoryHost, { notes: createNotesBackend(), history: createHistoryBackend(memoryHost) })
    : undefined;
  if (memoryService !== undefined) parts.memoryService = memoryService;

  /**
   * Summary policy and cut-chain repair. The opt-in watermark is recorded before any catalog pass can
   * enqueue history, so enabling summaries never spends on episodes that already existed. A queue
   * with no live task means the chain was cut by an abort, a fault or a crash before the terminal
   * commit; repairing it is deterministic, at most one task per mapped session.
   */
  async function settleSummaries(ctx: Context): Promise<void> {
    if (summaries === undefined) return;
    const backfillEnabled = options.summaryBackfill;
    // A backfill scan lists episode documents, so the catalog must record those boundaries first: an
    // unrecorded boundary is not work and must not be skipped or called complete.
    const settleCatalog = async (conversationId: ConversationId, passes: number): Promise<boolean> => {
      for (let pass = 0; pass < passes; pass += 1) {
        if ((await episodeCatalog.reconcile(conversationId, ctx)).caughtUp) return true;
      }
      return false;
    };
    // Summary policy stays chat-only: an automation conversation's episodes are catalogued, but a
    // summary of one has no reader (the history tool is mapped-chat scoped), so it is not initialized
    // here and the catalog's enqueue defers instead of spending on it.
    for (const session of await mappedChatSessions(ctx)) {
      try {
        await summaries.initialize(harness, session.conversationId, ctx);
        await settleCatalog(session.conversationId, EPISODE_SUMMARY_QUEUE_LIMITS.startupCatalogPasses);
        if (backfillEnabled) {
          for (let pass = 0; pass < EPISODE_SUMMARY_QUEUE_LIMITS.backfillPassesPerRun; pass += 1) {
            const report = await summaries.backfill(harness, session.conversationId, ctx);
            if (report.complete) break;
            if (report.reason !== "catalog-behind") break;
            // More history to record before its boundaries can be queued; one bounded round.
            await settleCatalog(session.conversationId, 2);
          }
        }
        await summaries.drain(harness, session.conversationId, ctx);
      } catch {
        // A policy/repair failure is derived work; the durable queue keeps the jobs for a later drain.
      }
    }
  }

  return { storeIdentity, digestSource, episodeCatalog, historyIndex, memoryService, methods, settleSummaries };
}
