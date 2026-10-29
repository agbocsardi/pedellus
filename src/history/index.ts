/**
 * Rebuildable SQLite full-text index over Durable retained entries.
 *
 * Durable remains the only transcript authority. This module reads entries
 * through a caller-supplied, read-only transaction callback and writes a
 * separate, derived SQLite file. The index can be deleted at any time and is
 * reconciled from Durable on the next search. Nothing here mutates Durable's
 * database, resumes a conversation, changes grants, or creates tasks.
 *
 * The first slice indexes user and assistant message text plus tool names,
 * arguments and result text. System prompts, thinking blocks, reset handoffs,
 * and compaction summaries are intentionally outside the search scopes. Reset
 * entries are recorded as episode boundaries, but episode summaries and summary
 * search are later work.
 *
 * The host owns authorization. A search never accepts a conversation ID; the
 * caller supplies the currently mapped chat sessions after its own channel
 * authentication. State-only conversations and task-owned background runs are
 * excluded by that mapping. Results include source session/conversation/entry
 * provenance, which is sensitive and must not be exposed to an untrusted model.
 */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  openNodeSqliteDatabase,
  type NodeSqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";

export const HISTORY_INDEX_FORMAT = "nanobot-history-index" as const;
export const HISTORY_INDEX_SCHEMA_VERSION = 1 as const;

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
  /** Indexed body cap in Unicode code points; larger text is visibly truncated. */
  maxIndexedChars: 8_000,
  /** Tool argument JSON cap before it is folded into the body cap. */
  maxToolArgumentChars: 4_000,
  /** Searchable records extracted from one entry; later records are counted as omitted. */
  maxDocumentsPerEntry: 64,
  /** Entries requested from one Durable scan. */
  entriesPerScan: 100,
  /** Entries examined by one search's reconciliation pass. */
  maxEntriesPerSync: 2_000,
  /** Unindexed entries counted for the lag report before reporting a lower bound. */
  maxPendingScanEntries: 500,
  /** Excerpt size for an empty (browse) query. */
  excerptChars: 280,
  /** FTS snippet token window for a matched query. */
  snippetTokens: 24,
});

export type HistoryScope = "messages" | "tools" | "all";
export type HistoryRole = "user" | "assistant";

/** A currently mapped chat session, already authenticated and classified by the host. */
export interface HistorySession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

/**
 * Opaque continuation state, not authorization.
 *
 * It is bound to the normalized query, index generation, source coverage
 * boundary, and the last indexed document. A continuation is rejected when the
 * query/scope changes, the derived index is rebuilt, the mapped session set no
 * longer contains the source, or the source entry at the continuation boundary
 * no longer matches its fingerprint (for example after a store replacement at
 * the same path). Entries appended after the first page have higher entry IDs
 * and are excluded from that continuation; start a fresh query to include them.
 */
export interface HistoryCursor {
  readonly version: 1;
  readonly querySha256: string;
  readonly generation: string;
  /** Highest indexed source entry ID that this chain may return. */
  readonly boundaryEntryId: number;
  readonly lastEntryId: number;
  readonly lastDocumentId: number;
  readonly lastEntryFingerprint: string;
}

export interface HistoryQuery {
  /** Literal terms; FTS tokenization applies. Empty text browses the selected scope. */
  readonly text?: string;
  /** Default `messages`. `tools` is tools only; `all` is messages plus tools. */
  readonly scope?: HistoryScope;
  /** Message roles to include; meaningful for `messages` and `all`, rejected for `tools`. */
  readonly roles?: readonly HistoryRole[];
  readonly limit?: number;
  readonly cursor?: HistoryCursor;
}

export interface HistoryHit {
  readonly conversationId: ConversationId;
  readonly sessionKey: string;
  readonly entryId: EntryId;
  readonly entryKind: string;
  readonly role: HistoryRole | "tool";
  readonly toolName?: string;
  readonly timestamp?: number;
  /** Entry ID that begins the reset-delimited episode containing this record. */
  readonly episodeStartEntryId: EntryId;
  /** Bounded excerpt; matches are wrapped in `[...]` for a text query. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  /** Full indexed body length before snippet selection. */
  readonly bodyLength: number;
  /** True when indexing capped this body at `maxIndexedChars`. */
  readonly bodyTruncated: boolean;
}

export interface HistorySyncReport {
  /** Source entries examined by this search's reconciliation pass. */
  readonly entriesScanned: number;
  /** Source entries newly indexed by this pass (entries, not documents). */
  readonly entriesIndexed: number;
  readonly entryLimit: number;
  /** False when the entry limit stopped reconciliation before the source caught up. */
  readonly caughtUp: boolean;
}

export interface HistoryCoverage {
  /** Mapped chat sessions considered. */
  readonly sessions: number;
  /** Sessions with committed index progress. */
  readonly indexedSessions: number;
  /** Source entries represented by the index, summed over mapped sessions. */
  readonly indexedEntries: number;
  /** Committed reset boundaries recorded for mapped sessions. */
  readonly resetBoundaries: number;
  /** Entries at or below this ID were eligible for this page. */
  readonly boundaryEntryId: number;
  /** Source entries newer than index progress, bounded by `maxPendingScanEntries`. */
  readonly pendingEntries: number;
  /** False when the pending count hit its bound and is a lower bound. */
  readonly pendingComplete: boolean;
  /** True when reconciliation caught up and no unindexed entries were observed. */
  readonly complete: boolean;
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  /** Records omitted by the per-entry document cap, across mapped sessions. */
  readonly omittedDocuments: number;
  readonly sync: HistorySyncReport;
}

export interface HistoryPage {
  readonly hits: readonly HistoryHit[];
  readonly next?: HistoryCursor;
  readonly coverage: HistoryCoverage;
}

export interface HistoryIndex {
  /**
   * Reconcile a bounded slice of Durable into the derived index, then return a
   * stable page. Search never throws for a large backlog; it reports lag in
   * `coverage` and continues on the next call.
   */
  search(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  /** Close the derived index connection. Idempotent; never touches Durable. */
  close(): Promise<void>;
}

export interface HistoryIndexOptions {
  /** Derived SQLite path. `:memory:` is supported for synthetic probes. */
  readonly indexPath: string;
  /**
   * Canonical Durable SQLite path. Its device/inode identity is persisted so a
   * replaced store at the same path rebuilds the index and invalidates cursors.
   * Omit for synthetic probes that do not use the filesystem.
   */
  readonly sourcePath?: string;
  /**
   * Current mapped chat sessions after host authentication. This callback is
   * trusted host code: it must exclude state-only pseudo-sessions and reject
   * task-owned or forked conversations.
   */
  readonly sessions: (context: Context) => Promise<readonly HistorySession[]>;
  /** Read-only Durable transaction surface, normally `root.commit`. */
  readonly scan: <T>(context: Context, read: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

/** `<data>/nanobot.sqlite` -> `<data>/nanobot-history.sqlite`. */
export function historyIndexPath(dbPath: string): string {
  if (dbPath === ":memory:") return ":memory:";
  const suffix = ".sqlite";
  return dbPath.endsWith(suffix)
    ? `${dbPath.slice(0, -suffix.length)}-history.sqlite`
    : `${dbPath}.history.sqlite`;
}

interface ParsedQuery {
  readonly normalizedText: string;
  readonly terms: readonly string[];
  readonly browsing: boolean;
  readonly scope: HistoryScope;
  readonly roles: readonly HistoryRole[];
  readonly limit: number;
  readonly querySha256: string;
  readonly cursor?: HistoryCursor;
}

interface ConversationProgress {
  readonly conversation_id: number;
  readonly first_entry_id: number;
  readonly first_fingerprint: string;
  readonly indexed_entry_id: number;
  readonly indexed_fingerprint: string;
  readonly episode_start_entry_id: number;
  readonly indexed_entry_count: number;
  readonly malformed_entries: number;
  readonly malformed_messages: number;
  readonly omitted_documents: number;
}

interface DocDraft {
  readonly role: HistoryHit["role"];
  readonly toolName?: string;
  readonly timestamp?: number;
  readonly body: string;
  readonly bodyLength: number;
  readonly truncated: boolean;
}

interface Extraction {
  readonly docs: readonly DocDraft[];
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  readonly omittedDocuments: number;
}

interface DocRow {
  readonly doc_id: number;
  readonly conversation_id: number;
  readonly entry_id: number;
  readonly entry_kind: string;
  readonly role: string;
  readonly tool_name: string | null;
  readonly timestamp: number | null;
  readonly episode_start_entry_id: number;
  readonly body_length: number;
  readonly truncated: number;
  readonly entry_fingerprint: string;
  readonly excerpt: string;
}

interface CursorProofRow {
  readonly conversation_id: number;
  readonly entry_id: number;
  readonly entry_fingerprint: string;
}

interface SyncBudget {
  remaining: number;
  scanned: number;
  indexed: number;
  malformedEntries: number;
  malformedMessages: number;
}

const MESSAGE_ROLES: readonly HistoryRole[] = ["assistant", "user"];
const ALL_ROLES: readonly HistoryHit["role"][] = ["assistant", "user", "tool"];
const READABLE_ROLES: ReadonlySet<HistoryHit["role"]> = new Set(ALL_ROLES);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** NFC + collapsed whitespace; the cursor binds this exact normalized text. */
function normalizeQueryText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function queryTerms(value: string): string[] {
  const matches = value.normalize("NFC").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const term = clampCodeUnits(match, HISTORY_INDEX_LIMITS.maxQueryTermChars);
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= HISTORY_INDEX_LIMITS.maxQueryTerms) break;
  }
  return terms;
}

function roleSet(scope: HistoryScope, roles: readonly HistoryRole[]): readonly HistoryHit["role"][] {
  if (scope === "tools") return ["tool"];
  if (scope === "messages") return roles;
  return [...roles, "tool"];
}

function readQuery(query: unknown): ParsedQuery {
  if (!isRecord(query)) throw new TypeError("History query must be an object");
  const allowed = new Set(["text", "scope", "roles", "limit", "cursor"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new TypeError(`History query has an unsupported field: ${key}`);
  }

  const rawText = query.text;
  if (rawText !== undefined && typeof rawText !== "string") {
    throw new TypeError("History text must be a string");
  }
  const normalizedText = rawText === undefined ? "" : normalizeQueryText(rawText);
  if ([...normalizedText].length > HISTORY_INDEX_LIMITS.maxQueryChars) {
    throw new TypeError(`History text must be at most ${HISTORY_INDEX_LIMITS.maxQueryChars} characters`);
  }
  const terms = queryTerms(normalizedText);

  const rawScope = query.scope;
  if (rawScope !== undefined && rawScope !== "messages" && rawScope !== "tools" && rawScope !== "all") {
    throw new TypeError("History scope must be messages, tools or all");
  }
  const scope: HistoryScope = rawScope ?? "messages";

  const rawRoles = query.roles;
  let roles: HistoryRole[] = [...MESSAGE_ROLES];
  if (rawRoles !== undefined) {
    if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
      throw new TypeError("History roles must be a non-empty array");
    }
    if (scope === "tools") throw new TypeError("History roles are not accepted for the tools scope");
    const unique = new Set<HistoryRole>();
    for (const role of rawRoles) {
      if (role !== "user" && role !== "assistant") {
        throw new TypeError("History roles accept only user and assistant");
      }
      unique.add(role);
    }
    roles = [...unique].sort();
  }

  const rawLimit = query.limit;
  if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1)) {
    throw new TypeError("History limit must be a positive safe integer");
  }
  const limit = Math.min(
    (rawLimit as number | undefined) ?? HISTORY_INDEX_LIMITS.defaultPageSize,
    HISTORY_INDEX_LIMITS.maxPageSize,
  );

  const cursor = query.cursor === undefined ? undefined : readCursor(query.cursor);
  const querySha256 = sha256(JSON.stringify([normalizedText, scope, roles]));
  return {
    normalizedText,
    terms,
    browsing: normalizedText.length === 0,
    scope,
    roles,
    limit,
    querySha256,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function readCursor(value: unknown): HistoryCursor {
  if (!isRecord(value)) throw new TypeError("History cursor must be an object");
  const allowed = new Set([
    "version", "querySha256", "generation", "boundaryEntryId",
    "lastEntryId", "lastDocumentId", "lastEntryFingerprint",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`History cursor has an unsupported field: ${key}`);
  }
  if (value.version !== 1) throw new TypeError("History cursor version is not supported");
  if (typeof value.querySha256 !== "string" || !SHA256_HEX.test(value.querySha256)) {
    throw new TypeError("History cursor query digest is invalid");
  }
  if (typeof value.generation !== "string" || value.generation.length === 0 || value.generation.length > 128) {
    throw new TypeError("History cursor generation is invalid");
  }
  for (const key of ["boundaryEntryId", "lastEntryId", "lastDocumentId"] as const) {
    const number = value[key];
    if (!Number.isSafeInteger(number) || (number as number) < 1) {
      throw new TypeError(`History cursor ${key} is invalid`);
    }
  }
  if (typeof value.lastEntryFingerprint !== "string" || !SHA256_HEX.test(value.lastEntryFingerprint)) {
    throw new TypeError("History cursor entry fingerprint is invalid");
  }
  return {
    version: 1,
    querySha256: value.querySha256,
    generation: value.generation,
    boundaryEntryId: value.boundaryEntryId as number,
    lastEntryId: value.lastEntryId as number,
    lastDocumentId: value.lastDocumentId as number,
    lastEntryFingerprint: value.lastEntryFingerprint,
  };
}

/** Content-addressed identity for one immutable Durable entry. */
function entryFingerprint(entry: EntryRecord): string {
  return sha256(JSON.stringify([
    entry.id,
    entry.conversationId,
    entry.kind,
    entry.model ?? null,
    entry.data ?? null,
    entry.head ?? null,
    entry.edits ?? null,
    entry.byTaskId ?? null,
  ]));
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function timestampOf(message: Record<string, unknown>): number | undefined {
  const timestamp = message.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function clampCodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
}

/** Truncate by Unicode code points without splitting a surrogate pair. */
function clampBody(value: string, max: number): { body: string; bodyLength: number; truncated: boolean } {
  const bodyLength = value.length;
  if (bodyLength <= max) return { body: value, bodyLength, truncated: false };
  let body = "";
  let count = 0;
  let truncated = false;
  for (const character of value) {
    if (count >= max) {
      truncated = true;
      break;
    }
    body += character;
    count++;
  }
  return { body, bodyLength, truncated };
}

function addDoc(
  docs: DocDraft[],
  role: HistoryHit["role"],
  text: string,
  timestamp: number | undefined,
  toolName?: string,
): boolean {
  if (text.trim().length === 0) return false;
  const clamped = clampBody(text, HISTORY_INDEX_LIMITS.maxIndexedChars);
  docs.push({
    role,
    ...(toolName === undefined ? {} : { toolName }),
    ...(timestamp === undefined ? {} : { timestamp }),
    body: clamped.body,
    bodyLength: clamped.bodyLength,
    truncated: clamped.truncated,
  });
  return true;
}

/**
 * Extract only the searchable projections of one entry. Reset/system/compaction
 * entries yield no documents; reset boundaries are handled by the caller.
 */
function extractDocuments(entry: EntryRecord): Extraction {
  const docs: DocDraft[] = [];
  let malformedEntries = 0;
  let malformedMessages = 0;
  let omittedDocuments = 0;
  const pushDoc = (
    role: HistoryHit["role"],
    text: string,
    timestamp: number | undefined,
    toolName?: string,
  ): void => {
    if (text.trim().length === 0) return;
    if (docs.length >= HISTORY_INDEX_LIMITS.maxDocumentsPerEntry) {
      omittedDocuments++;
      return;
    }
    addDoc(docs, role, text, timestamp, toolName);
  };
  if (entry.kind === ResetEntry.kind || entry.kind === SystemEntry.kind || entry.kind === CompactionEntry.kind) {
    return { docs, malformedEntries, malformedMessages, omittedDocuments };
  }
  const userKind = entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND;
  const assistantKind = entry.kind === AssistantEntry.kind;
  const toolKind = entry.kind === ToolResultEntry.kind;
  if (!userKind && !assistantKind && !toolKind) return { docs, malformedEntries, malformedMessages, omittedDocuments };
  if (entry.model === undefined) return { docs, malformedEntries, malformedMessages, omittedDocuments };
  if (!Array.isArray(entry.model)) {
    return { docs, malformedEntries: 1, malformedMessages, omittedDocuments };
  }

  for (const raw of entry.model) {
    if (!isRecord(raw)) {
      malformedMessages++;
      continue;
    }
    const timestamp = timestampOf(raw);
    if (userKind) {
      if (raw.role !== "user") continue;
      if (typeof raw.content !== "string" && !Array.isArray(raw.content)) {
        malformedMessages++;
        continue;
      }
      const text = messageText(raw.content);
      if (text !== undefined) pushDoc("user", text, timestamp);
      continue;
    }
    if (assistantKind) {
      if (raw.role !== "assistant") continue;
      if (!Array.isArray(raw.content)) {
        malformedMessages++;
        continue;
      }
      const text = messageText(raw.content);
      if (text !== undefined) pushDoc("assistant", text, timestamp);
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string" || block.name.length === 0) {
          continue;
        }
        const args = clampCodeUnits(safeJson(block.arguments), HISTORY_INDEX_LIMITS.maxToolArgumentChars);
        const failure = typeof block.argumentsError === "string" && block.argumentsError.length > 0
          ? `\nargumentsError: ${clampCodeUnits(block.argumentsError, 1_000)}`
          : "";
        pushDoc("tool", `${block.name}\n${args}${failure}`, timestamp, block.name);
      }
      continue;
    }
    if (raw.role !== "toolResult") continue;
    const toolName = typeof raw.toolName === "string" && raw.toolName.length > 0 ? raw.toolName : undefined;
    if (typeof raw.content !== "string" && !Array.isArray(raw.content)) {
      malformedMessages++;
      continue;
    }
    const text = messageText(raw.content);
    if (text === undefined) {
      if (toolName !== undefined) pushDoc("tool", toolName, timestamp, toolName);
      continue;
    }
    const body = toolName === undefined ? text : `${toolName}\n${text}`;
    pushDoc("tool", body, timestamp, toolName);
  }
  return { docs, malformedEntries, malformedMessages, omittedDocuments };
}

async function createSchema(db: NodeSqliteDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS history_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS history_conversations (
      conversation_id INTEGER PRIMARY KEY,
      first_entry_id INTEGER NOT NULL,
      first_fingerprint TEXT NOT NULL,
      indexed_entry_id INTEGER NOT NULL,
      indexed_fingerprint TEXT NOT NULL,
      episode_start_entry_id INTEGER NOT NULL,
      indexed_entry_count INTEGER NOT NULL,
      malformed_entries INTEGER NOT NULL,
      malformed_messages INTEGER NOT NULL,
      omitted_documents INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS history_episodes (
      conversation_id INTEGER NOT NULL,
      start_entry_id INTEGER NOT NULL,
      reset_entry_id INTEGER,
      PRIMARY KEY (conversation_id, start_entry_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS history_documents (
      doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      entry_id INTEGER NOT NULL,
      entry_kind TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      tool_name TEXT,
      timestamp REAL,
      episode_start_entry_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      body_length INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      entry_fingerprint TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS history_documents_by_entry
      ON history_documents (conversation_id, entry_id, doc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      body,
      content='history_documents',
      content_rowid='doc_id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS history_documents_ai AFTER INSERT ON history_documents BEGIN
      INSERT INTO history_fts (rowid, body) VALUES (new.doc_id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS history_documents_ad AFTER DELETE ON history_documents BEGIN
      INSERT INTO history_fts (history_fts, rowid, body) VALUES ('delete', old.doc_id, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS history_documents_au AFTER UPDATE ON history_documents BEGIN
      INSERT INTO history_fts (history_fts, rowid, body) VALUES ('delete', old.doc_id, old.body);
      INSERT INTO history_fts (rowid, body) VALUES (new.doc_id, new.body);
    END;
    INSERT INTO history_meta (key, value) VALUES ('schema_version', '${HISTORY_INDEX_SCHEMA_VERSION}')
      ON CONFLICT(key) DO NOTHING;
    INSERT INTO history_meta (key, value) VALUES ('generation', '${randomUUID()}')
      ON CONFLICT(key) DO NOTHING;
    INSERT INTO history_meta (key, value) VALUES ('source_identity', '')
      ON CONFLICT(key) DO NOTHING;
  `);
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
}


async function sourceIdentity(sourcePath: string | undefined): Promise<string | undefined> {
  if (sourcePath === undefined || sourcePath === ":memory:") return undefined;
  try {
    const info = await stat(sourcePath);
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resetDerivedIndex(db: NodeSqliteDatabase, identity: string): Promise<string> {
  const generation = randomUUID();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM history_documents");
    await tx.run("DELETE FROM history_episodes");
    await tx.run("DELETE FROM history_conversations");
    await tx.run("UPDATE history_meta SET value = ? WHERE key = 'generation'", generation);
    await tx.run(
      `INSERT INTO history_meta (key, value) VALUES ('source_identity', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      identity,
    );
  });
  return generation;
}

interface OpenHistoryIndex {
  readonly db: NodeSqliteDatabase;
  generation: string;
}

/** Re-check the source file identity on every search, not only at first open. */
async function reconcileSourceIdentity(open: OpenHistoryIndex, sourcePath: string | undefined): Promise<void> {
  const identity = await sourceIdentity(sourcePath);
  if (identity === undefined) return;
  const stored = await open.db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'source_identity'",
  );
  if (stored === undefined || stored.value.length === 0) {
    await open.db.run(
      `INSERT INTO history_meta (key, value) VALUES ('source_identity', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      identity,
    );
    return;
  }
  if (stored.value !== identity) open.generation = await resetDerivedIndex(open.db, identity);
}

async function migrate(db: NodeSqliteDatabase): Promise<string> {
  const existing = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_meta'",
  );
  if (existing !== undefined) {
    const version = await db.get<{ value: string }>(
      "SELECT value FROM history_meta WHERE key = 'schema_version'",
    );
    if (version?.value !== String(HISTORY_INDEX_SCHEMA_VERSION)) await dropSchema(db);
  }
  await createSchema(db);
  const generation = await db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'generation'",
  );
  if (generation === undefined || generation.value.length === 0) {
    throw new Error("History index generation is missing");
  }
  return generation.value;
}

async function readProgress(db: NodeSqliteDatabase, conversationId: ConversationId): Promise<ConversationProgress | undefined> {
  return db.get<ConversationProgress>(
    `SELECT conversation_id, first_entry_id, first_fingerprint, indexed_entry_id,
            indexed_fingerprint, episode_start_entry_id, indexed_entry_count,
            malformed_entries, malformed_messages, omitted_documents
       FROM history_conversations WHERE conversation_id = ?`,
    conversationId,
  );
}

async function clearConversation(db: NodeSqliteDatabase, conversationId: ConversationId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM history_documents WHERE conversation_id = ?", conversationId);
    await tx.run("DELETE FROM history_episodes WHERE conversation_id = ?", conversationId);
    await tx.run("DELETE FROM history_conversations WHERE conversation_id = ?", conversationId);
  });
}

/** A path-only cursor identity would cross a replaced store at the same path. */
async function verifyAnchors(
  options: HistoryIndexOptions,
  progress: ConversationProgress,
  conversationId: ConversationId,
  context: Context,
): Promise<boolean> {
  return options.scan(context, async (tx) => {
    const first = await tx.entry(progress.first_entry_id as EntryId);
    if (first === undefined || first.conversationId !== conversationId) return false;
    if (entryFingerprint(first) !== progress.first_fingerprint) return false;
    const last = await tx.entry(progress.indexed_entry_id as EntryId);
    if (last === undefined || last.conversationId !== conversationId) return false;
    return entryFingerprint(last) === progress.indexed_fingerprint;
  });
}

async function scanFirstEntry(
  options: HistoryIndexOptions,
  conversationId: ConversationId,
  context: Context,
): Promise<EntryRecord | undefined> {
  const page = await options.scan(context, (tx) =>
    tx.scanEntries({ conversationId, order: "ascending" }, 1));
  return page.items[0];
}

async function scanNewestEntry(
  options: HistoryIndexOptions,
  conversationId: ConversationId,
  context: Context,
): Promise<EntryRecord | undefined> {
  const page = await options.scan(context, (tx) =>
    tx.scanEntries({ conversationId, order: "descending" }, 1));
  return page.items[0];
}

interface GroupedDoc extends DocDraft {
  readonly entryId: number;
  readonly entryKind: string;
  readonly entryFingerprint: string;
  readonly episodeStartEntryId: number;
}

interface PageWrite {
  readonly docs: readonly GroupedDoc[];
  readonly entries: readonly {
    readonly entry: EntryRecord;
    readonly fingerprint: string;
  }[];
  readonly episodes: readonly {
    readonly startEntryId: number;
    readonly resetEntryId: number | null;
  }[];
  readonly firstEntryId: number;
  readonly firstFingerprint: string;
  readonly episodeStartEntryId: number;
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  readonly omittedDocuments: number;
}

async function writePage(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  page: PageWrite,
  indexedAt: number,
): Promise<void> {
  const last = page.entries[page.entries.length - 1]!;
  await db.transaction(async (tx) => {
    for (const episode of page.episodes) {
      await tx.run(
        `INSERT INTO history_episodes (conversation_id, start_entry_id, reset_entry_id)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id, start_entry_id) DO UPDATE SET
           reset_entry_id = COALESCE(excluded.reset_entry_id, history_episodes.reset_entry_id)`,
        conversationId, episode.startEntryId, episode.resetEntryId,
      );
    }
    for (const doc of page.docs) {
      await tx.run(
        `INSERT INTO history_documents
           (conversation_id, entry_id, entry_kind, role, tool_name, timestamp,
            episode_start_entry_id, body, body_length, truncated, entry_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        conversationId,
        doc.entryId,
        doc.entryKind,
        doc.role,
        doc.toolName ?? null,
        doc.timestamp ?? null,
        doc.episodeStartEntryId,
        doc.body,
        doc.bodyLength,
        doc.truncated ? 1 : 0,
        doc.entryFingerprint,
      );
    }
    await tx.run(
      `INSERT INTO history_conversations
         (conversation_id, first_entry_id, first_fingerprint, indexed_entry_id,
          indexed_fingerprint, episode_start_entry_id, indexed_entry_count,
          malformed_entries, malformed_messages, omitted_documents, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         indexed_entry_id = excluded.indexed_entry_id,
         indexed_fingerprint = excluded.indexed_fingerprint,
         episode_start_entry_id = excluded.episode_start_entry_id,
         indexed_entry_count = history_conversations.indexed_entry_count + excluded.indexed_entry_count,
         malformed_entries = history_conversations.malformed_entries + excluded.malformed_entries,
         malformed_messages = history_conversations.malformed_messages + excluded.malformed_messages,
         omitted_documents = history_conversations.omitted_documents + excluded.omitted_documents,
         indexed_at = excluded.indexed_at`,
      conversationId,
      page.firstEntryId,
      page.firstFingerprint,
      last.entry.id,
      last.fingerprint,
      page.episodeStartEntryId,
      page.entries.length,
      page.malformedEntries,
      page.malformedMessages,
      page.omittedDocuments,
      indexedAt,
    );
  });
}

async function syncConversation(
  open: { readonly db: NodeSqliteDatabase },
  options: HistoryIndexOptions,
  session: HistorySession,
  budget: SyncBudget,
  context: Context,
): Promise<boolean> {
  const conversationId = session.conversationId;
  let progress = await readProgress(open.db, conversationId);
  if (progress !== undefined && !(await verifyAnchors(options, progress, conversationId, context))) {
    await clearConversation(open.db, conversationId);
    progress = undefined;
  }

  let minEntryId: number;
  let firstEntryId = progress?.first_entry_id;
  let firstFingerprint = progress?.first_fingerprint;
  let currentEpisode = progress?.episode_start_entry_id;
  if (progress === undefined) {
    const first = await scanFirstEntry(options, conversationId, context);
    if (first === undefined) return true;
    minEntryId = first.id;
  } else {
    minEntryId = progress.indexed_entry_id + 1;
  }

  let caughtUp = true;
  while (budget.remaining > 0) {
    const limit = Math.min(HISTORY_INDEX_LIMITS.entriesPerScan, budget.remaining);
    const scan = await options.scan(context, (tx) =>
      tx.scanEntries({ conversationId, minEntryId: minEntryId as EntryId, order: "ascending" }, limit));
    const own = scan.items.filter((entry) => entry.conversationId === conversationId);
    if (own.length === 0) {
      caughtUp = true;
      break;
    }

    const grouped: GroupedDoc[] = [];
    const episodes: { startEntryId: number; resetEntryId: number | null }[] = [];
    const entries: { entry: EntryRecord; fingerprint: string }[] = [];
    let malformedEntries = 0;
    let malformedMessages = 0;
    let omittedDocuments = 0;
    for (const entry of own) {
      const fingerprint = entryFingerprint(entry);
      entries.push({ entry, fingerprint });
      if (firstEntryId === undefined) {
        firstEntryId = entry.id;
        firstFingerprint = fingerprint;
      }
      if (entry.kind === ResetEntry.kind) {
        currentEpisode = entry.id;
        episodes.push({ startEntryId: entry.id, resetEntryId: entry.id });
        continue;
      }
      if (currentEpisode === undefined) {
        currentEpisode = entry.id;
        episodes.push({ startEntryId: entry.id, resetEntryId: null });
      }
      const extraction = extractDocuments(entry);
      malformedEntries += extraction.malformedEntries;
      malformedMessages += extraction.malformedMessages;
      omittedDocuments += extraction.omittedDocuments;
      for (const doc of extraction.docs) {
        grouped.push({
          ...doc,
          entryId: entry.id,
          entryKind: entry.kind,
          entryFingerprint: fingerprint,
          episodeStartEntryId: currentEpisode,
        });
      }
    }

    budget.remaining -= own.length;
    budget.scanned += own.length;
    budget.indexed += own.length;
    budget.malformedEntries += malformedEntries;
    budget.malformedMessages += malformedMessages;
    if (firstEntryId === undefined || firstFingerprint === undefined || currentEpisode === undefined) {
      // No own entry supplied an identity; the conversation has no searchable history yet.
      caughtUp = true;
      break;
    }
    await writePage(open.db, conversationId, {
      docs: grouped,
      entries,
      episodes,
      firstEntryId,
      firstFingerprint,
      episodeStartEntryId: currentEpisode,
      malformedEntries,
      malformedMessages,
      omittedDocuments,
    }, (options.now ?? Date.now)());

    const last = own[own.length - 1]!;
    minEntryId = last.id + 1;
    if (scan.items.length < limit) {
      caughtUp = true;
      break;
    }
    if (budget.remaining === 0) {
      caughtUp = false;
      break;
    }
  }

  // A page boundary can land exactly on the source end; confirm rather than assume.
  if (caughtUp) {
    const newest = await scanNewestEntry(options, conversationId, context);
    if (newest !== undefined) {
      const after = await readProgress(open.db, conversationId);
      caughtUp = after !== undefined && newest.id <= after.indexed_entry_id;
    }
  }
  return caughtUp;
}

async function measureLag(
  open: { readonly db: NodeSqliteDatabase },
  options: HistoryIndexOptions,
  sessions: readonly HistorySession[],
  context: Context,
): Promise<{ entries: number; complete: boolean }> {
  let remaining = HISTORY_INDEX_LIMITS.maxPendingScanEntries;
  let entries = 0;
  let complete = true;
  for (const session of sessions) {
    const newest = await scanNewestEntry(options, session.conversationId, context);
    if (newest === undefined) continue;
    const progress = await readProgress(open.db, session.conversationId);
    if (progress !== undefined && newest.id <= progress.indexed_entry_id) continue;
    if (remaining <= 0) {
      complete = false;
      break;
    }
    let minEntryId = progress === undefined ? 1 : progress.indexed_entry_id + 1;
    while (remaining > 0) {
      const limit = Math.min(HISTORY_INDEX_LIMITS.entriesPerScan, remaining);
      const page = await options.scan(context, (tx) =>
        tx.scanEntries({ conversationId: session.conversationId, minEntryId: minEntryId as EntryId, order: "ascending" }, limit));
      if (page.items.length === 0) break;
      const own = page.items.filter((entry) => entry.conversationId === session.conversationId);
      entries += own.length;
      remaining -= own.length;
      const last = own[own.length - 1];
      if (last === undefined || last.id >= newest.id) break;
      minEntryId = last.id + 1;
      if (page.items.length < limit) break;
    }
    if (remaining <= 0) complete = false;
  }
  return { entries, complete };
}

async function indexedBoundary(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = await db.get<{ boundary: number | null }>(
    `SELECT MAX(indexed_entry_id) AS boundary FROM history_conversations
      WHERE conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  return row?.boundary ?? 0;
}

async function coverageCounts(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
): Promise<{
  indexedSessions: number;
  indexedEntries: number;
  resetBoundaries: number;
  malformedEntries: number;
  malformedMessages: number;
  omittedDocuments: number;
}> {
  if (conversationIds.length === 0) {
    return {
      indexedSessions: 0, indexedEntries: 0, resetBoundaries: 0,
      malformedEntries: 0, malformedMessages: 0, omittedDocuments: 0,
    };
  }
  const placeholders = conversationIds.map(() => "?").join(",");
  const progress = await db.get<{
    sessions: number;
    entries: number | null;
    malformed_entries: number | null;
    malformed_messages: number | null;
    omitted_documents: number | null;
  }>(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(indexed_entry_count), 0) AS entries,
            COALESCE(SUM(malformed_entries), 0) AS malformed_entries,
            COALESCE(SUM(malformed_messages), 0) AS malformed_messages,
            COALESCE(SUM(omitted_documents), 0) AS omitted_documents
       FROM history_conversations WHERE conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  const episodes = await db.get<{ resets: number }>(
    `SELECT COUNT(*) AS resets FROM history_episodes
      WHERE reset_entry_id IS NOT NULL AND conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  return {
    indexedSessions: progress?.sessions ?? 0,
    indexedEntries: progress?.entries ?? 0,
    resetBoundaries: episodes?.resets ?? 0,
    malformedEntries: progress?.malformed_entries ?? 0,
    malformedMessages: progress?.malformed_messages ?? 0,
    omittedDocuments: progress?.omitted_documents ?? 0,
  };
}

async function verifyCursor(
  open: { readonly db: NodeSqliteDatabase },
  options: HistoryIndexOptions,
  cursor: HistoryCursor,
  conversationIds: readonly number[],
  context: Context,
): Promise<void> {
  if (conversationIds.length === 0) throw new Error("History cursor does not belong to the current mapped sessions");
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = await open.db.get<CursorProofRow>(
    `SELECT conversation_id, entry_id, entry_fingerprint FROM history_documents
      WHERE doc_id = ? AND conversation_id IN (${placeholders}) LIMIT 1`,
    cursor.lastDocumentId,
    ...conversationIds,
  );
  if (row === undefined
    || row.entry_id !== cursor.lastEntryId
    || row.entry_fingerprint !== cursor.lastEntryFingerprint
    || !conversationIds.includes(row.conversation_id)) {
    throw new Error("History cursor no longer matches the derived index");
  }
  const source = await options.scan(context, (tx) => tx.entry(cursor.lastEntryId as EntryId));
  if (source === undefined
    || source.conversationId !== row.conversation_id
    || entryFingerprint(source) !== cursor.lastEntryFingerprint) {
    throw new Error("History cursor no longer matches the Durable source");
  }
}

async function queryDocuments(
  db: NodeSqliteDatabase,
  query: ParsedQuery,
  conversationIds: readonly number[],
  boundaryEntryId: number,
  cursor: HistoryCursor | undefined,
): Promise<DocRow[]> {
  const conversationPlaceholders = conversationIds.map(() => "?").join(",");
  const roles = roleSet(query.scope, query.roles);
  const rolePlaceholders = roles.map(() => "?").join(",");
  const keyset = cursor === undefined
    ? ""
    : "AND (d.entry_id < ? OR (d.entry_id = ? AND d.doc_id < ?))";
  const filter = `
      AND d.conversation_id IN (${conversationPlaceholders})
      AND d.entry_id <= ?
      AND d.role IN (${rolePlaceholders})
      ${keyset}`;
  const tail = cursor === undefined
    ? [boundaryEntryId, ...roles, query.limit + 1]
    : [boundaryEntryId, ...roles, cursor.lastEntryId, cursor.lastEntryId, cursor.lastDocumentId, query.limit + 1];

  if (!query.browsing && query.terms.length === 0) return [];
  if (query.terms.length === 0) {
    return db.all<DocRow>(
      `SELECT d.doc_id, d.conversation_id, d.entry_id, d.entry_kind, d.role,
              d.tool_name, d.timestamp, d.episode_start_entry_id, d.body_length,
              d.truncated, d.entry_fingerprint,
              substr(d.body, 1, ?) AS excerpt
         FROM history_documents d
        WHERE 1 = 1${filter}
        ORDER BY d.entry_id DESC, d.doc_id DESC
        LIMIT ?`,
      HISTORY_INDEX_LIMITS.excerptChars,
      ...conversationIds,
      ...tail,
    );
  }
  const match = query.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
  return db.all<DocRow>(
    `SELECT d.doc_id, d.conversation_id, d.entry_id, d.entry_kind, d.role,
            d.tool_name, d.timestamp, d.episode_start_entry_id, d.body_length,
            d.truncated, d.entry_fingerprint,
            snippet(history_fts, 0, '[', ']', '…', ?) AS excerpt
       FROM history_fts
       JOIN history_documents d ON d.doc_id = history_fts.rowid
      WHERE history_fts MATCH ?${filter}
      ORDER BY d.entry_id DESC, d.doc_id DESC
      LIMIT ?`,
    HISTORY_INDEX_LIMITS.snippetTokens,
    match,
    ...conversationIds,
    ...tail,
  );
}

export function createHistoryIndex(options: HistoryIndexOptions): HistoryIndex {
  if (typeof options.indexPath !== "string" || options.indexPath.length === 0) {
    throw new TypeError("History index path must be a non-empty string");
  }
  if (typeof options.sessions !== "function" || typeof options.scan !== "function") {
    throw new TypeError("History index requires sessions and scan callbacks");
  }
  if (options.sourcePath !== undefined
    && options.sourcePath !== ":memory:"
    && options.indexPath === options.sourcePath) {
    throw new TypeError("History index path must differ from the Durable source path");
  }

  let openPromise: Promise<OpenHistoryIndex> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  const ensureOpen = async (): Promise<OpenHistoryIndex> => {
    if (closed) throw new Error("History index is closed");
    openPromise ??= (async () => {
      const db = await openNodeSqliteDatabase(options.indexPath);
      try {
        // The derived index is rebuildable: WAL with normal sync is enough. A lost
        // commit loses progress and documents together, so the next search replays it.
        let generation = await migrate(db);
        const identity = await sourceIdentity(options.sourcePath);
        if (identity !== undefined) {
          const stored = await db.get<{ value: string }>(
            "SELECT value FROM history_meta WHERE key = 'source_identity'",
          );
          if (stored === undefined || stored.value.length === 0) {
            await db.run(
              `INSERT INTO history_meta (key, value) VALUES ('source_identity', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              identity,
            );
          } else if (stored.value !== identity) {
            // The path now names a different store. Discard derived rows and rotate
            // the generation so every cursor from the old store is rejected.
            generation = await resetDerivedIndex(db, identity);
          }
        }
        return { db, generation };
      } catch (error) {
        await db.close().catch(() => undefined);
        throw error;
      }
    })();
    return openPromise;
  };

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    search(queryInput, context) {
      return serialized(async () => {
        if (closed) throw new Error("History index is closed");
        const query = readQuery(queryInput);
        const sessions = await options.sessions(context);
        const seenSessions = new Set<number>();
        for (const session of sessions) {
          if (typeof session.sessionKey !== "string" || session.sessionKey.length === 0) {
            throw new TypeError("History session keys must be non-empty strings");
          }
          const conversationId = session.conversationId as number;
          if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
            throw new TypeError("History session conversation IDs must be positive safe integers");
          }
          if (seenSessions.has(conversationId)) {
            throw new TypeError("History sessions must map each conversation at most once");
          }
          seenSessions.add(conversationId);
        }
        if (sessions.length > HISTORY_INDEX_LIMITS.maxMappedSessions) {
          throw new Error(
            `History search supports at most ${HISTORY_INDEX_LIMITS.maxMappedSessions} mapped chat sessions; ` +
            `${sessions.length} are present`,
          );
        }
        const conversationIds = sessions.map((session) => session.conversationId as number);
        if (sessions.length === 0) {
          if (query.cursor !== undefined) throw new Error("History cursor does not belong to the current mapped sessions");
          return {
            hits: [],
            coverage: {
              sessions: 0,
              indexedSessions: 0,
              indexedEntries: 0,
              resetBoundaries: 0,
              boundaryEntryId: 0,
              pendingEntries: 0,
              pendingComplete: true,
              complete: true,
              malformedEntries: 0,
              malformedMessages: 0,
              omittedDocuments: 0,
              sync: {
                entriesScanned: 0,
                entriesIndexed: 0,
                entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
                caughtUp: true,
              },
            },
          };
        }

        const open = await ensureOpen();
        await reconcileSourceIdentity(open, options.sourcePath);
        if (query.cursor !== undefined) {
          if (query.cursor.generation !== open.generation) {
            throw new Error("History cursor belongs to a replaced derived index");
          }
          if (query.cursor.querySha256 !== query.querySha256) {
            throw new Error("History cursor does not match the requested query");
          }
          await verifyCursor(open, options, query.cursor, conversationIds, context);
        }

        const budget: SyncBudget = {
          remaining: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
          scanned: 0,
          indexed: 0,
          malformedEntries: 0,
          malformedMessages: 0,
        };
        let caughtUp = true;
        for (const session of sessions) {
          if (budget.remaining <= 0) {
            caughtUp = false;
            break;
          }
          const conversationCaughtUp = await syncConversation(open, options, session, budget, context);
          if (!conversationCaughtUp) caughtUp = false;
        }

        if (query.cursor !== undefined) {
          // Reconciliation may have rebuilt a conversation and reassigned document IDs.
          await verifyCursor(open, options, query.cursor, conversationIds, context);
        }
        const boundaryEntryId = query.cursor?.boundaryEntryId ?? await indexedBoundary(open.db, conversationIds);
        if (query.cursor !== undefined) {
          const currentBoundary = await indexedBoundary(open.db, conversationIds);
          if (query.cursor.boundaryEntryId > currentBoundary) {
            throw new Error("History cursor boundary is no longer covered by the derived index");
          }
        }
        if (boundaryEntryId === 0) {
          const counts = await coverageCounts(open.db, conversationIds);
          const lag = await measureLag(open, options, sessions, context);
          return {
            hits: [],
            coverage: {
              sessions: sessions.length,
              ...counts,
              boundaryEntryId: 0,
              pendingEntries: lag.entries,
              pendingComplete: lag.complete,
              complete: lag.entries === 0 && lag.complete && caughtUp,
              sync: {
                entriesScanned: budget.scanned,
                entriesIndexed: budget.indexed,
                entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
                caughtUp,
              },
            },
          };
        }

        const rows = await queryDocuments(open.db, query, conversationIds, boundaryEntryId, query.cursor);
        const hasMore = rows.length > query.limit;
        const visible = hasMore ? rows.slice(0, query.limit) : rows;
        const counts = await coverageCounts(open.db, conversationIds);
        const lag = await measureLag(open, options, sessions, context);
        const sessionsById = new Map(sessions.map((session) => [session.conversationId as number, session.sessionKey]));
        const hits: HistoryHit[] = visible.map((row) => {
          const role = row.role as HistoryHit["role"];
          if (!READABLE_ROLES.has(role)) throw new Error("History index contains an unsupported role");
          const sessionKey = sessionsById.get(row.conversation_id);
          if (sessionKey === undefined) throw new Error("History index returned an unmapped conversation");
          const excerptLength = [...row.excerpt].length;
          return {
            conversationId: row.conversation_id as ConversationId,
            sessionKey,
            entryId: row.entry_id as EntryId,
            entryKind: row.entry_kind,
            role,
            ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
            ...(row.timestamp === null ? {} : { timestamp: row.timestamp }),
            episodeStartEntryId: row.episode_start_entry_id as EntryId,
            excerpt: row.excerpt,
            excerptTruncated: row.body_length > excerptLength,
            bodyLength: row.body_length,
            bodyTruncated: row.truncated === 1,
          };
        });

        let next: HistoryCursor | undefined;
        if (hasMore) {
          const lastRow = visible[visible.length - 1];
          if (lastRow === undefined) throw new Error("History page lost its last row");
          next = {
            version: 1,
            querySha256: query.querySha256,
            generation: open.generation,
            boundaryEntryId,
            lastEntryId: lastRow.entry_id,
            lastDocumentId: lastRow.doc_id,
            lastEntryFingerprint: lastRow.entry_fingerprint,
          };
        }
        return {
          hits,
          ...(next === undefined ? {} : { next }),
          coverage: {
            sessions: sessions.length,
            ...counts,
            boundaryEntryId,
            pendingEntries: lag.entries,
            pendingComplete: lag.complete,
            complete: lag.entries === 0 && lag.complete && caughtUp,
            sync: {
              entriesScanned: budget.scanned,
              entriesIndexed: budget.indexed,
              entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
              caughtUp,
            },
          },
        };
      });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        await tail.catch(() => undefined);
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
