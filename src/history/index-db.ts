/**
 * The private derived SQLite file behind the history index: creation, owner-only hardening and
 * rejection of any alias of the Durable source; the caller-owned store identity and the generation
 * that rotates when it changes; validation of the host's mapped chat sessions; and the promise-chain
 * mutex that serializes every index operation. Nothing here reads or writes Durable.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { canonicalFuturePath } from "../store.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "./scope.js";
import type { HistorySummaryView } from "./summary-view.js";

export const HISTORY_INDEX_FORMAT = "nanobot-history-index" as const;

export const HISTORY_INDEX_SCHEMA_VERSION = 5 as const;

export const HISTORY_INDEX_LIMITS = Object.freeze({
  /** Normalized query text bound in Unicode code points. */
  maxQueryChars: 500,
  /** Distinct FTS terms considered from one query. */
  maxQueryTerms: 16,
  /** Longest one FTS term after extraction. */
  maxQueryTermChars: 64,
  defaultPageSize: 20,
  maxPageSize: 50,
  /** Mapped chat sessions accepted by one search. */
  maxMappedSessions: 256,
  /** FTS chunk size in JavaScript UTF-16 code units. */
  chunkChars: 8_000,
  /** Overlap between adjacent chunks, reducing (not eliminating) boundary misses. */
  chunkOverlapChars: 256,
  /** Bounded canonical JSON for tool arguments; larger arguments are visibly truncated. */
  maxToolArgumentChars: 1_000_000,
  /** Bounded canonical content used only for the source-entry fingerprint. */
  maxFingerprintChars: 1_000_000,
  /** Searchable chunks extracted from one entry; later chunks are counted as truncated. */
  maxDocumentsPerEntry: 64,
  /** Entries requested from one Durable scan. */
  entriesPerScan: 5,
  /** Entries examined by one search's reconciliation pass. */
  maxEntriesPerSync: 500,
  /** Approximate UTF-16 bytes prepared for one reconciliation pass. */
  maxPassBytes: 8 * 1024 * 1024,
  /** Wall-clock budget for one reconciliation pass before it yields a lagging result. */
  maxPassMs: 1_500,
  /** Unindexed entries counted for the lag report before reporting a lower bound. */
  maxPendingScanEntries: 100,
  /** Excerpt size for an empty (browse) query. */
  excerptChars: 280,
  /** Opaque cursor token accepted from a host or model-facing caller. */
  maxCursorTokenChars: 4_096,
  /** FTS snippet token window for a matched query. */
  snippetTokens: 24,
});

/** A currently mapped session, already authenticated and classified by the host. */
export interface HistorySession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

export interface HistoryIndexOptions {
  /** Derived SQLite path. `:memory:` is supported for synthetic probes. */
  readonly indexPath: string;
  /**
   * Stable identity of the Durable store, from its committed
   * `nanobot.store-identity` document. Never a path or inode. The index stores it
   * and rebuilds/rotates generations when it changes; a function is re-evaluated
   * before each search so a replaced store is noticed.
   */
  readonly storeId: string | ((context: Context) => Promise<string>);
  /**
   * Canonical Durable SQLite path used only to reject an index path that aliases
   * the source. It is not an identity and is never persisted.
   */
  readonly sourcePath?: string;
  /**
   * Current mapped sessions after host authentication. This callback is trusted
   * host code: it must reject task-owned or forked conversations and channel-state
   * sessions (`readChatSessions` in `scope.ts` is the shared reader). The index also
   * rejects `:channel-state` keys, then applies a positive rule, treating a session
   * as chat history only once it has at least one indexed message or tool record.
   */
  readonly sessions: (context: Context) => Promise<readonly HistorySession[]>;
  /** Read-only Durable transaction surface, normally `root.commit`. */
  readonly scan: <T>(context: Context, read: (tx: Tx) => Promise<T>) => Promise<T>;
  /**
   * Read-only view of one episode's stored summary through the public Durable document surface.
   * Trusted host code; it must classify missing, malformed and unreadable records instead of
   * throwing, and it must never call a model or write Durable. Without it, summary discovery
   * reports `available: false` and raw message/tool search is unchanged.
   */
  readonly readSummary?: (
    context: Context,
    conversationId: ConversationId,
    startEntryId: EntryId,
  ) => Promise<HistorySummaryView>;
  readonly now?: () => number;
}

/** Store-specific derived path, e.g. `<data>/nanobot-history-index.sqlite`. */
export function historyIndexPath(dbPath: string): string {
  if (dbPath === ":memory:") return ":memory:";
  const suffix = ".sqlite";
  const base = dbPath.endsWith(suffix) ? dbPath.slice(0, -suffix.length) : dbPath;
  return `${base}-history-index.sqlite`;
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function resolveStoreId(
  storeId: HistoryIndexOptions["storeId"],
  context: Context,
): Promise<string> {
  const value = typeof storeId === "function" ? await storeId(context) : storeId;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("History store identity is unavailable or invalid");
  }
  return value;
}

async function resetDerivedIndex(
  db: NodeSqliteDatabase,
  storeId: string,
  summaryReady: boolean,
): Promise<string> {
  const generation = randomUUID();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM history_documents");
    if (summaryReady) {
      await tx.run("DELETE FROM history_summaries");
      await tx.run("DELETE FROM history_summary_sweep");
      await tx.run(
        "INSERT INTO history_meta (key, value) VALUES ('summary_bytes', '0') "
        + "ON CONFLICT(key) DO UPDATE SET value = '0'",
      );
      await tx.run(
        "INSERT INTO history_meta (key, value) VALUES ('summary_session_cursor', '0') "
        + "ON CONFLICT(key) DO UPDATE SET value = '0'",
      );
    }
    await tx.run("DELETE FROM history_episodes");
    await tx.run("DELETE FROM history_conversations");
    await tx.run("UPDATE history_meta SET value = ? WHERE key = 'generation'", generation);
    await tx.run(
      `INSERT INTO history_meta (key, value) VALUES ('store_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      storeId,
    );
  });
  return generation;
}

export interface OpenHistoryIndex {
  readonly db: NodeSqliteDatabase;
  generation: string;
  storeId: string;
  /** False when the summary tables could not be created or repaired; message search still works. */
  summaryReady: boolean;
  /**
   * True once this open verified the summary schema shape and FTS5 integrity. A summary query that
   * fails clears it, so the next check re-verifies and repairs instead of trusting the open-time pass.
   */
  summaryVerified: boolean;
}

/** Keep the derived index bound to the caller-owned store identity. */
export async function reconcileStoreId(open: OpenHistoryIndex, storeId: string): Promise<void> {
  if (open.storeId === storeId) return;
  if (open.storeId === "") {
    await open.db.run("UPDATE history_meta SET value = ? WHERE key = 'store_id'", storeId);
    open.storeId = storeId;
    return;
  }
  // A different store now owns the source. Discard derived rows and rotate the
  // generation so every cursor from the old store is rejected.
  open.generation = await resetDerivedIndex(open.db, storeId, open.summaryReady);
  open.storeId = storeId;
}

/** Create or claim the private index file before SQLite opens it, and reject aliases of the source. */
export async function prepareIndexFile(indexPath: string, sourcePath: string | undefined): Promise<void> {
  if (indexPath === ":memory:") return;
  if (sourcePath !== undefined && sourcePath !== ":memory:") {
    const [indexCanonical, sourceCanonical] = await Promise.all([
      canonicalFuturePath(indexPath),
      canonicalFuturePath(sourcePath),
    ]);
    if (indexCanonical === sourceCanonical) {
      throw new Error("History index path must not alias the Durable source path");
    }
  }
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  if (sourcePath !== undefined && sourcePath !== ":memory:") {
    try {
      const [source, existingIndex] = await Promise.all([stat(sourcePath), stat(indexPath)]);
      if (source.dev === existingIndex.dev && source.ino === existingIndex.ino) {
        throw new Error("History index path must not hard-link the Durable source file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const existing = await lstat(indexPath);
    if (!existing.isFile()) throw new Error("History index path must be a regular file, not a symlink or special file");
    await chmod(indexPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const handle = await open(indexPath, "wx", 0o600);
      await handle.close();
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      await chmod(indexPath, 0o600);
    }
  }
}

/** The index contains private transcript text. Keep the file and SQLite sidecars owner-only. */
export async function secureIndexFiles(indexPath: string): Promise<void> {
  if (indexPath === ":memory:") return;
  for (const target of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    try {
      await chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface LoadedSessions {
  readonly sessions: readonly HistorySession[];
  readonly conversationIds: readonly number[];
  readonly mappingSha256: string;
}

/**
 * Validate host-mapped chat sessions: non-empty keys that are not channel-state bookkeeping, positive
 * conversation IDs mapped at most once, and at most `maxSessions`. Shared by history search and
 * digestion; `subject`/`surface` keep each caller's existing wording ("History"/"search",
 * "Digest"/"input").
 */
export function validateMappedSessions(
  sessions: readonly HistorySession[],
  subject: string,
  surface: string,
  maxSessions: number,
): void {
  const seenSessions = new Set<number>();
  for (const session of sessions) {
    if (typeof session.sessionKey !== "string" || session.sessionKey.length === 0) {
      throw new TypeError(`${subject} session keys must be non-empty strings`);
    }
    if (session.sessionKey.endsWith(CHANNEL_STATE_SESSION_SUFFIX)) {
      throw new TypeError(`${subject} ${surface} does not accept channel-state sessions`);
    }
    const conversationId = session.conversationId as number;
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      throw new TypeError(`${subject} session conversation IDs must be positive safe integers`);
    }
    if (seenSessions.has(conversationId)) {
      throw new TypeError(`${subject} sessions must map each conversation at most once`);
    }
    seenSessions.add(conversationId);
  }
  if (sessions.length > maxSessions) {
    throw new Error(
      `${subject} ${surface} supports at most ${maxSessions} mapped chat sessions; ` +
      `${sessions.length} are present`,
    );
  }
}

/** Validate the host's mapped chat sessions and hash the mapping a cursor is bound to. */
export async function loadSessions(
  options: HistoryIndexOptions,
  context: Context,
): Promise<LoadedSessions> {
  const sessions = await options.sessions(context);
  validateMappedSessions(sessions, "History", "search", HISTORY_INDEX_LIMITS.maxMappedSessions);
  const conversationIds = sessions.map((session) => session.conversationId as number);
  return {
    sessions,
    conversationIds,
    mappingSha256: sha256(JSON.stringify([...conversationIds].sort((left, right) => left - right))),
  };
}

/** Run operations one at a time in call order; a failed operation never blocks the next one. */
export function createSerializer(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
