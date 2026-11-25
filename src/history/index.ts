/**
 * Rebuildable SQLite full-text index over Durable retained entries.
 *
 * Durable remains the only transcript authority. This module reads entries
 * through a caller-supplied, read-only transaction callback and writes a
 * separate, derived SQLite file. The index can be deleted at any time and is
 * reconciled from Durable on the next search. Nothing here mutates Durable's
 * database, resumes a conversation, changes grants, or creates tasks.
 *
 * The message/tool layer indexes user and assistant message text plus tool names,
 * arguments and result text. System prompts, thinking blocks, reset handoffs and
 * compaction summaries are intentionally outside those scopes. Reset entries are
 * recorded as episode boundaries. A separate summary layer indexes only ready,
 * boundary-verified episode summaries for discovery; it is derived navigation and
 * never writes Durable or generates a summary.
 *
 * The host owns authorization. A search never accepts a conversation ID; the
 * caller supplies the currently mapped chat sessions after its own channel
 * authentication. State-only conversations and task-owned background runs are
 * excluded by that mapping. Results include source session/conversation/entry
 * provenance, which is sensitive and stays inside the trusted host/agent boundary;
 * the default model-facing `history` tool quotes it as untrusted data.
 */
import type { Context } from "@earendil-works/chord";
import {
  openNodeSqliteDatabase,
  type NodeSqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createSerializer,
  HISTORY_INDEX_SCHEMA_VERSION,
  prepareIndexFile,
  reconcileStoreId,
  secureIndexFiles,
  type HistoryIndexOptions,
  type OpenHistoryIndex,
} from "./index-db.js";
import { createMessageSchema, searchMessages, type HistoryPage, type HistoryQuery } from "./message-index.js";
import {
  createSummarySchema,
  dropSummarySchema,
  searchSummaryIndex,
  type HistorySummaryPage,
  type HistorySummaryQuery,
} from "./summary-index.js";

// The index is split by layer: the private SQLite file, the message/tool layer and the summary
// layer. This facade keeps the whole public surface in one module.
export {
  HISTORY_INDEX_FORMAT,
  HISTORY_INDEX_LIMITS,
  HISTORY_INDEX_SCHEMA_VERSION,
  historyIndexPath,
  type HistoryIndexOptions,
  type HistorySession,
} from "./index-db.js";
export {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryCoverage,
  type HistoryCursor,
  type HistoryHit,
  type HistoryPage,
  type HistoryQuery,
  type HistoryRole,
  type HistoryScope,
  type HistorySyncReport,
} from "./message-index.js";
export {
  decodeHistorySummaryCursor,
  encodeHistorySummaryCursor,
  HISTORY_SUMMARY_LIMITS,
  type HistorySummaryCoverage,
  type HistorySummaryCursor,
  type HistorySummaryHit,
  type HistorySummaryPage,
  type HistorySummaryQuery,
  type HistorySummarySyncReport,
} from "./summary-index.js";

export interface HistoryIndex {
  /**
   * Reconcile a bounded slice of Durable into the derived index, then return a
   * stable page. Search never throws for a large backlog; it reports lag in
   * `coverage` and continues on the next call.
   */
  search(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  /**
   * Discover ready episode summaries across mapped chats. It reconciles episode boundaries as `search`
   * does, then re-reads a bounded slice of stored summary records. It never generates or backfills a
   * summary, and a missing/failed/corrupt summary removes at most its own derived row.
   */
  searchSummaries(query: HistorySummaryQuery, context: Context): Promise<HistorySummaryPage>;
  /** Close the derived index connection. Idempotent; never touches Durable. */
  close(): Promise<void>;
}

async function dropSchema(db: NodeSqliteDatabase): Promise<void> {
  await db.exec(`
    DROP TRIGGER IF EXISTS history_documents_ai;
    DROP TRIGGER IF EXISTS history_documents_ad;
    DROP TRIGGER IF EXISTS history_documents_au;
    DROP TABLE IF EXISTS history_fts;
    DROP TABLE IF EXISTS history_documents;
    DROP TABLE IF EXISTS history_episodes;
    DROP TABLE IF EXISTS history_conversations;
    DROP TABLE IF EXISTS history_meta;
  `);
  await dropSummarySchema(db);
}

async function migrate(db: NodeSqliteDatabase): Promise<{
  generation: string;
  storeId: string;
  summaryReady: boolean;
}> {
  const existing = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_meta'",
  );
  if (existing !== undefined) {
    const version = await db.get<{ value: string }>(
      "SELECT value FROM history_meta WHERE key = 'schema_version'",
    );
    if (version?.value !== String(HISTORY_INDEX_SCHEMA_VERSION)) await dropSchema(db);
  }
  // Message/tool tables are required. Summary tables are derived navigation: if their creation
  // fails, mark them unavailable for this open and keep raw search usable. The next open retries.
  await createMessageSchema(db);
  let summaryReady = true;
  try {
    await createSummarySchema(db);
  } catch {
    summaryReady = false;
    await dropSummarySchema(db).catch(() => undefined);
  }
  const generation = await db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'generation'",
  );
  if (generation === undefined || generation.value.length === 0) {
    throw new Error("History index generation is missing");
  }
  const storeId = await db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'store_id'",
  );
  return { generation: generation.value, storeId: storeId?.value ?? "", summaryReady };
}

export function createHistoryIndex(options: HistoryIndexOptions): HistoryIndex {
  if (typeof options.indexPath !== "string" || options.indexPath.length === 0) {
    throw new TypeError("History index path must be a non-empty string");
  }
  if (typeof options.sessions !== "function" || typeof options.scan !== "function") {
    throw new TypeError("History index requires sessions and scan callbacks");
  }
  if (typeof options.storeId !== "string" && typeof options.storeId !== "function") {
    throw new TypeError("History index requires a caller-supplied storeId");
  }
  if (options.sourcePath !== undefined && typeof options.sourcePath !== "string") {
    throw new TypeError("History sourcePath must be a string when provided");
  }
  if (options.readSummary !== undefined && typeof options.readSummary !== "function") {
    throw new TypeError("History readSummary must be a function when provided");
  }

  let openPromise: Promise<OpenHistoryIndex> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const serialized = createSerializer();

  const ensureOpen = async (storeId: string): Promise<OpenHistoryIndex> => {
    if (closed) throw new Error("History index is closed");
    openPromise ??= (async () => {
      await prepareIndexFile(options.indexPath, options.sourcePath);
      const db = await openNodeSqliteDatabase(options.indexPath);
      try {
        // The derived index is rebuildable: WAL with normal sync is enough. A lost
        // commit loses progress and documents together, so the next search replays it.
        const migrated = await migrate(db);
        await secureIndexFiles(options.indexPath);
        return {
          db,
          generation: migrated.generation,
          storeId: migrated.storeId,
          summaryReady: migrated.summaryReady,
          summaryVerified: false,
        };
      } catch (error) {
        await db.close().catch(() => undefined);
        throw error;
      }
    })();
    const open = await openPromise;
    await reconcileStoreId(open, storeId);
    return open;
  };

  return {
    search(query: HistoryQuery, context: Context): Promise<HistoryPage> {
      return serialized(async () => {
        if (closed) throw new Error("History index is closed");
        return searchMessages(query, options, ensureOpen, context);
      });
    },
    searchSummaries(query: HistorySummaryQuery, context: Context): Promise<HistorySummaryPage> {
      return serialized(async () => {
        if (closed) throw new Error("History index is closed");
        return searchSummaryIndex(query, options, ensureOpen, context);
      });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        await serialized(async () => undefined);
        const pending = openPromise;
        if (pending === undefined) return;
        try {
          const open = await pending;
          await open.db.close();
        } catch {
          // A failed open already closed its connection; a close failure leaves a
          // derived file that the next process can reconcile instead of hiding it.
        }
      })();
      return closePromise;
    },
  };
}
