/**
 * Message/tool layer of the derived history index: the FTS5 schema over user/assistant text and tool
 * calls/results, bounded incremental sync from Durable with anchor checks, lag measurement, cursor
 * proofs and query execution. Durable stays the only transcript authority; every row here is
 * rebuildable and bound to the index generation and store identity.
 */
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  SystemEntry,
  ToolResultEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  boundedCanonicalJson as boundedJson,
  isRecord,
  isUserInputKind,
  messageText,
} from "./transcript.js";
import {
  HISTORY_INDEX_LIMITS,
  HISTORY_INDEX_SCHEMA_VERSION,
  SHA256_HEX,
  loadSessions,
  resolveStoreId,
  secureIndexFiles,
  sha256,
  type HistoryIndexOptions,
  type HistorySession,
  type OpenHistoryIndex,
} from "./index-db.js";

export type HistoryScope = "messages" | "tools" | "all";

export type HistoryRole = "user" | "assistant";

/**
 * Opaque continuation state, not authorization.
 *
 * It is bound to the normalized query, index generation, caller-supplied store
 * identity, mapped conversation-ID set, source coverage boundary, and the last
 * indexed document. A continuation is rejected when the query/scope changes, the
 * derived index or store identity is replaced, the session mapping changes, the
 * mapped set no longer contains the source, or the source entry at the boundary
 * no longer matches its fingerprint. Entries appended after the first page have
 * higher entry IDs and are excluded from that continuation; start a fresh query
 * to include them.
 */
export interface HistoryCursor {
  readonly version: 1;
  readonly querySha256: string;
  readonly generation: string;
  /** Hash of the mapped conversation-ID set captured on the first page. */
  readonly mappingSha256: string;
  /** Highest indexed source entry ID that this chain may return. */
  readonly boundaryEntryId: number;
  readonly lastEntryId: number;
  readonly lastDocumentId: number;
  readonly lastEntryFingerprint: string;
}

export interface HistoryQuery {
  /**
   * Token/prefix terms; FTS `unicode61` tokenization applies, and the last term
   * may extend to a longer word beginning with it. This is not literal substring
   * matching. Terms must occur in the same chunk; the 256-unit overlap reduces but
   * does not eliminate chunk-boundary misses. Contiguous CJK runs are one token,
   * so only a full run or a prefix of it matches. Overlapping chunks can yield
   * multiple hits for one part; dedupe with `(entryId, partIndex)` and treat each
   * excerpt as a chunk fragment. Chunks are cut on code-unit boundaries, so a
   * prefix match can be a fragment of a longer word that the cut split. Empty text
   * browses the scope.
   */
  readonly text?: string;
  /** Default `messages`. `tools` is tools only; `all` is messages plus tools. */
  readonly scope?: HistoryScope;
  /**
   * Message roles to include; rejected for `tools`. In `all`, this filters message
   * records only and tool records are always included.
   */
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
  /** Tool call identity, when this hit came from a tool call or its result. */
  readonly toolCallId?: string;
  readonly timestamp?: number;
  /** Entry ID that begins the reset-delimited episode containing this record. */
  readonly episodeStartEntryId: EntryId;
  /** Bounded excerpt from one indexed chunk; matches are wrapped in `[...]`. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  /** Full source body length in UTF-16 code units before chunking. */
  readonly bodyLength: number;
  /** Message/tool part ordinal within the source entry. */
  readonly partIndex: number;
  /** Chunk ordinal within this message/tool part. */
  readonly chunkIndex: number;
  /** UTF-16 code-unit offset of this chunk's start in the full body. */
  readonly charStart: number;
  /** True when indexing omitted part of this message/tool text (chunks or argument cap). */
  readonly bodyTruncated: boolean;
}

export interface HistorySyncReport {
  /** Source entries examined by this search's reconciliation pass. */
  readonly entriesScanned: number;
  /** Source entries newly indexed by this pass (entries, not documents). */
  readonly entriesIndexed: number;
  readonly entryLimit: number;
  /** Approximate UTF-16 bytes prepared for indexed documents. */
  readonly bytesPrepared: number;
  readonly byteLimit: number;
  readonly elapsedMs: number;
  readonly timeLimitMs: number;
  /** False when a bound stopped reconciliation before the source caught up. */
  readonly caughtUp: boolean;
}

export interface HistoryCoverage {
  /** Mapped sessions considered after task-owned/forked exclusions. */
  readonly sessions: number;
  /** Host cap on mapped sessions accepted by one search. */
  readonly sessionLimit: number;
  /** Sessions with at least one indexed message or tool record, i.e. chat history. */
  readonly chatSessions: number;
  /** Sessions with committed index progress. */
  readonly indexedSessions: number;
  /** Source entries represented by the index, summed over mapped sessions. */
  readonly indexedEntries: number;
  /** Message/tool parts with omitted text (chunk cap or bounded tool arguments). */
  readonly truncatedParts: number;
  /** Entries carrying ContextEdit overrides; raw-entry search does not project them. */
  readonly editsUnsupported: number;
  /** Committed reset boundaries recorded for mapped sessions. */
  readonly resetBoundaries: number;
  /** Entries at or below this ID were eligible for this page. */
  readonly boundaryEntryId: number;
  /** Lag count only, bounded by `maxPendingScanEntries`; zero does not imply `complete`. */
  readonly pendingEntries: number;
  /** False when the pending count hit its bound and is a lower bound. */
  readonly pendingComplete: boolean;
  /**
   * The authoritative completeness signal. True only when reconciliation caught
   * up, no lag was observed, no text was omitted and no unsupported edits exist.
   * `pendingEntries === 0` alone is not sufficient (pending may be capped at zero,
   * or omitted text/edits may remain).
   */
  readonly complete: boolean;
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  readonly sync: HistorySyncReport;
}

export interface HistoryPage {
  readonly hits: readonly HistoryHit[];
  readonly next?: HistoryCursor;
  readonly coverage: HistoryCoverage;
}

/**
 * Serialize a continuation as one opaque, copyable token. The token is host state,
 * not authorization: `decodeHistoryCursor` validates its shape and the search
 * re-checks every binding (query, index generation, store identity, mapping,
 * source entry) before using it.
 */
export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Parse an opaque continuation token and reject malformed or unsupported shapes. */
export function decodeHistoryCursor(token: string): HistoryCursor {
  if (typeof token !== "string" || token.length === 0 || token.length > HISTORY_INDEX_LIMITS.maxCursorTokenChars) {
    throw new TypeError("History cursor token is invalid");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError("History cursor token is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("History cursor token is invalid");
  }
  return readCursor(parsed);
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
  readonly truncated_parts: number;
  readonly edits_unsupported: number;
}

interface DocDraft {
  readonly role: HistoryHit["role"];
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly timestamp?: number;
  readonly partIndex: number;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly body: string;
  readonly bodyLength: number;
  readonly truncated: boolean;
}

interface Extraction {
  readonly docs: readonly DocDraft[];
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  readonly truncatedParts: number;
}

interface DocRow {
  readonly doc_id: number;
  readonly conversation_id: number;
  readonly entry_id: number;
  readonly entry_kind: string;
  readonly role: string;
  readonly tool_name: string | null;
  readonly tool_call_id: string | null;
  readonly timestamp: number | null;
  readonly episode_start_entry_id: number;
  readonly part_index: number;
  readonly chunk_index: number;
  readonly char_start: number;
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
  remainingEntries: number;
  remainingBytes: number;
  deadline: number;
  scanned: number;
  indexed: number;
  bytesPrepared: number;
  malformedEntries: number;
  malformedMessages: number;
  truncatedParts: number;
  editsUnsupported: number;
}

const MESSAGE_ROLES: readonly HistoryRole[] = ["assistant", "user"];

const ALL_ROLES: readonly HistoryHit["role"][] = ["assistant", "user", "tool"];

const READABLE_ROLES: ReadonlySet<HistoryHit["role"]> = new Set(ALL_ROLES);

/** NFC + collapsed whitespace; the cursor binds this exact normalized text. */
export function normalizeQueryText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function queryTerms(value: string): string[] {
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
    "version", "querySha256", "generation", "mappingSha256", "boundaryEntryId",
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
  if (typeof value.mappingSha256 !== "string" || !SHA256_HEX.test(value.mappingSha256)) {
    throw new TypeError("History cursor mapping digest is invalid");
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
    mappingSha256: value.mappingSha256,
    boundaryEntryId: value.boundaryEntryId as number,
    lastEntryId: value.lastEntryId as number,
    lastDocumentId: value.lastDocumentId as number,
    lastEntryFingerprint: value.lastEntryFingerprint,
  };
}

/**
 * Content-addressed identity for one immutable Durable entry. Identity fields
 * are hashed exactly; model/data are bounded so a huge entry cannot force a full
 * in-memory JSON copy here. This is a secondary anchor only: two stores whose
 * content differs solely beyond the fingerprint budget can share a fingerprint.
 * Caller-supplied `storeId` remains the primary replacement authority.
 */
function entryFingerprint(entry: EntryRecord): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([
    entry.id,
    entry.conversationId,
    entry.kind,
    entry.head ?? null,
    entry.byTaskId ?? null,
  ]));
  const content = boundedJson(
    [entry.model ?? null, entry.data ?? null, entry.edits ?? null],
    HISTORY_INDEX_LIMITS.maxFingerprintChars,
  );
  hash.update(content.truncated ? "\u0000truncated" : "\u0000full");
  hash.update(content.text);
  return hash.digest("hex");
}

function timestampOf(message: Record<string, unknown>): number | undefined {
  const timestamp = message.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function clampCodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
}

/** Clamp to a UTF-8 byte budget without splitting a code point or surrogate pair. */
export function clampUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { text: value, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

interface TextChunk {
  readonly body: string;
  readonly charStart: number;
}

interface ChunkResult {
  readonly chunks: readonly TextChunk[];
  readonly truncated: boolean;
}

function codePointTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let start = value.length - maxChars;
  const code = value.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  return value.slice(start);
}

/**
 * Split at code-point boundaries with a small overlap so a token or short phrase
 * crossing a boundary usually appears in both chunks. Generation stops at
 * `maxChunks`; `truncated` says more text remained. This bounds memory for large
 * tool arguments/results without silently pretending the text was complete.
 */
function textChunks(text: string, maxChars: number, maxChunks: number, overlapChars: number): ChunkResult {
  if (text.length === 0) return { chunks: [], truncated: false };
  if (maxChunks <= 0) return { chunks: [], truncated: true };
  const chunks: TextChunk[] = [];
  let body = "";
  let charStart = 0;
  let offset = 0;
  let hasNewContent = false;
  for (const character of text) {
    if (body.length > 0 && body.length + character.length > maxChars) {
      if (chunks.length >= maxChunks) return { chunks, truncated: true };
      chunks.push({ body, charStart });
      const carry = codePointTail(body, overlapChars);
      body = carry;
      charStart = offset - carry.length;
      hasNewContent = false;
    }
    body += character;
    offset += character.length;
    hasNewContent = true;
  }
  if (hasNewContent && body.length > 0) {
    if (chunks.length >= maxChunks) return { chunks, truncated: true };
    chunks.push({ body, charStart });
  }
  return { chunks, truncated: false };
}

/**
 * Extract only the searchable projections of one entry. Reset/system/compaction
 * entries yield no documents; reset boundaries are handled by the caller. Long
 * message and tool text is chunked with bounded generation; a part with omitted
 * chunks increments `truncatedParts` and marks its stored chunks `truncated`.
 */
function extractDocuments(entry: EntryRecord): Extraction {
  const docs: DocDraft[] = [];
  let malformedEntries = 0;
  let malformedMessages = 0;
  let truncatedParts = 0;
  let partIndex = 0;
  const pushDoc = (
    role: HistoryHit["role"],
    text: string,
    timestamp: number | undefined,
    toolName?: string,
    toolCallId?: string,
    sourceTruncated = false,
  ): void => {
    if (text.trim().length === 0) return;
    const available = Math.max(0, HISTORY_INDEX_LIMITS.maxDocumentsPerEntry - docs.length);
    const result = textChunks(
      text,
      HISTORY_INDEX_LIMITS.chunkChars,
      available,
      HISTORY_INDEX_LIMITS.chunkOverlapChars,
    );
    const truncated = result.truncated || sourceTruncated;
    if (truncated) truncatedParts++;
    for (let index = 0; index < result.chunks.length; index++) {
      const chunk = result.chunks[index]!;
      docs.push({
        role,
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(timestamp === undefined ? {} : { timestamp }),
        partIndex,
        chunkIndex: index,
        charStart: chunk.charStart,
        body: chunk.body,
        bodyLength: text.length,
        truncated,
      });
    }
    partIndex++;
  };
  if (entry.kind === ResetEntry.kind || entry.kind === SystemEntry.kind || entry.kind === CompactionEntry.kind) {
    return { docs, malformedEntries, malformedMessages, truncatedParts };
  }
  const userKind = isUserInputKind(entry.kind);
  const assistantKind = entry.kind === AssistantEntry.kind;
  const toolKind = entry.kind === ToolResultEntry.kind;
  if (!userKind && !assistantKind && !toolKind) return { docs, malformedEntries, malformedMessages, truncatedParts };
  if (entry.model === undefined) return { docs, malformedEntries, malformedMessages, truncatedParts };
  if (!Array.isArray(entry.model)) {
    return { docs, malformedEntries: 1, malformedMessages, truncatedParts };
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
        const args = boundedJson(block.arguments, HISTORY_INDEX_LIMITS.maxToolArgumentChars);
        const failureText = typeof block.argumentsError === "string" && block.argumentsError.length > 0
          ? block.argumentsError
          : undefined;
        const failure = failureText === undefined
          ? { text: "", truncated: false }
          : boundedJson(failureText, HISTORY_INDEX_LIMITS.maxToolArgumentChars);
        const failureSuffix = failureText === undefined ? "" : `\nargumentsError: ${failure.text}`;
        const toolCallId = typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
        pushDoc(
          "tool",
          `${block.name}\n${args.text}${failureSuffix}`,
          timestamp,
          block.name,
          toolCallId,
          args.truncated || failure.truncated,
        );
      }
      continue;
    }
    if (raw.role !== "toolResult") continue;
    const toolName = typeof raw.toolName === "string" && raw.toolName.length > 0 ? raw.toolName : undefined;
    const toolCallId = typeof raw.toolCallId === "string" && raw.toolCallId.length > 0 ? raw.toolCallId : undefined;
    if (typeof raw.content !== "string" && !Array.isArray(raw.content)) {
      malformedMessages++;
      continue;
    }
    const text = messageText(raw.content);
    if (text === undefined) {
      if (toolName !== undefined) pushDoc("tool", toolName, timestamp, toolName, toolCallId);
      continue;
    }
    const body = toolName === undefined ? text : `${toolName}\n${text}`;
    pushDoc("tool", body, timestamp, toolName, toolCallId);
  }
  return { docs, malformedEntries, malformedMessages, truncatedParts };
}

export async function createMessageSchema(db: NodeSqliteDatabase): Promise<void> {
  // Message/tool schema is created first and independently, so a summary-index problem can never
  // prevent raw transcript retrieval from opening the derived file.
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
      truncated_parts INTEGER NOT NULL,
      edits_unsupported INTEGER NOT NULL,
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
      tool_call_id TEXT,
      timestamp REAL,
      episode_start_entry_id INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      char_start INTEGER NOT NULL,
      body TEXT NOT NULL,
      body_length INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      entry_fingerprint TEXT NOT NULL,
      UNIQUE(conversation_id, entry_id, part_index, chunk_index)
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
    INSERT INTO history_meta (key, value) VALUES ('store_id', '')
      ON CONFLICT(key) DO NOTHING;
  `);
}

export async function readProgress(db: NodeSqliteDatabase, conversationId: ConversationId): Promise<ConversationProgress | undefined> {
  return db.get<ConversationProgress>(
    `SELECT conversation_id, first_entry_id, first_fingerprint, indexed_entry_id,
            indexed_fingerprint, episode_start_entry_id, indexed_entry_count,
            malformed_entries, malformed_messages, truncated_parts, edits_unsupported
       FROM history_conversations WHERE conversation_id = ?`,
    conversationId,
  );
}

async function clearConversation(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  summaryReady: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM history_documents WHERE conversation_id = ?", conversationId);
    if (summaryReady) {
      await tx.run("DELETE FROM history_summaries WHERE conversation_id = ?", conversationId);
      await tx.run("DELETE FROM history_summary_sweep WHERE conversation_id = ?", conversationId);
      await tx.run(
        "UPDATE history_meta SET value = CAST(COALESCE("
        + "(SELECT SUM(body_bytes) FROM history_summaries), 0) AS TEXT) WHERE key = 'summary_bytes'",
      );
    }
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
  readonly entry: {
    readonly entry: EntryRecord;
    readonly fingerprint: string;
  };
  readonly episodes: readonly {
    readonly startEntryId: number;
    readonly resetEntryId: number | null;
  }[];
  readonly firstEntryId: number;
  readonly firstFingerprint: string;
  readonly episodeStartEntryId: number;
  readonly malformedEntries: number;
  readonly malformedMessages: number;
  readonly truncatedParts: number;
  readonly editsUnsupported: number;
}

async function writePage(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  page: PageWrite,
  indexedAt: number,
): Promise<void> {
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
           (conversation_id, entry_id, entry_kind, role, tool_name, tool_call_id, timestamp,
            episode_start_entry_id, part_index, chunk_index, char_start,
            body, body_length, truncated, entry_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        conversationId,
        doc.entryId,
        doc.entryKind,
        doc.role,
        doc.toolName ?? null,
        doc.toolCallId ?? null,
        doc.timestamp ?? null,
        doc.episodeStartEntryId,
        doc.partIndex,
        doc.chunkIndex,
        doc.charStart,
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
          malformed_entries, malformed_messages, truncated_parts, edits_unsupported, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         indexed_entry_id = excluded.indexed_entry_id,
         indexed_fingerprint = excluded.indexed_fingerprint,
         episode_start_entry_id = excluded.episode_start_entry_id,
         indexed_entry_count = history_conversations.indexed_entry_count + excluded.indexed_entry_count,
         malformed_entries = history_conversations.malformed_entries + excluded.malformed_entries,
         malformed_messages = history_conversations.malformed_messages + excluded.malformed_messages,
         truncated_parts = history_conversations.truncated_parts + excluded.truncated_parts,
         edits_unsupported = history_conversations.edits_unsupported + excluded.edits_unsupported,
         indexed_at = excluded.indexed_at`,
      conversationId,
      page.firstEntryId,
      page.firstFingerprint,
      page.entry.entry.id,
      page.entry.fingerprint,
      page.episodeStartEntryId,
      1,
      page.malformedEntries,
      page.malformedMessages,
      page.truncatedParts,
      page.editsUnsupported,
      indexedAt,
    );
  });
}

async function syncConversation(
  open: { readonly db: NodeSqliteDatabase; readonly summaryReady?: boolean },
  options: HistoryIndexOptions,
  session: HistorySession,
  budget: SyncBudget,
  context: Context,
): Promise<boolean> {
  const conversationId = session.conversationId;
  const now = options.now ?? Date.now;
  let progress = await readProgress(open.db, conversationId);
  if (progress !== undefined && !(await verifyAnchors(options, progress, conversationId, context))) {
    await clearConversation(open.db, conversationId, open.summaryReady !== false);
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

  let stoppedByBudget = false;
  while (budget.remainingEntries > 0) {
    if (now() >= budget.deadline) {
      stoppedByBudget = true;
      break;
    }
    const limit = Math.min(HISTORY_INDEX_LIMITS.entriesPerScan, budget.remainingEntries);
    const scan = await options.scan(context, (tx) =>
      tx.scanEntries({ conversationId, minEntryId: minEntryId as EntryId, order: "ascending" }, limit));
    const own = scan.items.filter((entry) => entry.conversationId === conversationId);
    if (own.length === 0) break;

    for (const entry of own) {
      if (budget.remainingEntries <= 0 || now() >= budget.deadline) {
        stoppedByBudget = true;
        break;
      }
      const fingerprint = entryFingerprint(entry);
      if (firstEntryId === undefined) {
        firstEntryId = entry.id;
        firstFingerprint = fingerprint;
      }
      const episodes: { startEntryId: number; resetEntryId: number | null }[] = [];
      if (entry.kind === ResetEntry.kind) {
        currentEpisode = entry.id;
        episodes.push({ startEntryId: entry.id, resetEntryId: entry.id });
      } else if (currentEpisode === undefined) {
        currentEpisode = entry.id;
        episodes.push({ startEntryId: entry.id, resetEntryId: null });
      }
      const extraction = extractDocuments(entry);
      const docs: GroupedDoc[] = extraction.docs.map((doc) => ({
        ...doc,
        entryId: entry.id,
        entryKind: entry.kind,
        entryFingerprint: fingerprint,
        episodeStartEntryId: currentEpisode as number,
      }));
      const bytes = docs.reduce((total, doc) => total + doc.body.length * 2 + 512, 0);
      if (bytes > budget.remainingBytes) {
        // Do not write the entry without its bytes; the next pass retries it from
        // the unchanged watermark with a fresh byte budget.
        stoppedByBudget = true;
        break;
      }
      if (firstEntryId === undefined || firstFingerprint === undefined || currentEpisode === undefined) {
        break;
      }
      const editsUnsupported = entry.edits !== undefined && entry.edits.length > 0 ? 1 : 0;
      await writePage(open.db, conversationId, {
        docs,
        entry: { entry, fingerprint },
        episodes,
        firstEntryId,
        firstFingerprint,
        episodeStartEntryId: currentEpisode,
        malformedEntries: extraction.malformedEntries,
        malformedMessages: extraction.malformedMessages,
        truncatedParts: extraction.truncatedParts,
        editsUnsupported,
      }, now());
      budget.remainingEntries--;
      budget.remainingBytes -= bytes;
      budget.scanned++;
      budget.indexed++;
      budget.bytesPrepared += bytes;
      budget.malformedEntries += extraction.malformedEntries;
      budget.malformedMessages += extraction.malformedMessages;
      budget.truncatedParts += extraction.truncatedParts;
      budget.editsUnsupported += editsUnsupported;
      minEntryId = entry.id + 1;
    }
    if (stoppedByBudget) break;
    if (scan.items.length < limit) break;
  }
  if (stoppedByBudget) return false;

  // A page boundary can land exactly on the source end; confirm rather than assume.
  const newest = await scanNewestEntry(options, conversationId, context);
  if (newest !== undefined) {
    const after = await readProgress(open.db, conversationId);
    return after !== undefined && newest.id <= after.indexed_entry_id;
  }
  return true;
}

async function measureLag(
  open: { readonly db: NodeSqliteDatabase },
  options: HistoryIndexOptions,
  sessions: readonly HistorySession[],
  context: Context,
  deadline: number,
): Promise<{ entries: number; complete: boolean }> {
  const now = options.now ?? Date.now;
  let remaining = HISTORY_INDEX_LIMITS.maxPendingScanEntries;
  let entries = 0;
  let complete = true;
  for (const session of sessions) {
    if (now() >= deadline) {
      complete = false;
      break;
    }
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
      if (now() >= deadline) {
        complete = false;
        break;
      }
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

export async function indexedConversationIds(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
): Promise<number[]> {
  if (conversationIds.length === 0) return [];
  const placeholders = conversationIds.map(() => "?").join(",");
  const rows = await db.all<{ conversation_id: number }>(
    `SELECT DISTINCT conversation_id FROM history_documents
      WHERE conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  return rows.map((row) => row.conversation_id);
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
  truncatedParts: number;
  editsUnsupported: number;
}> {
  if (conversationIds.length === 0) {
    return {
      indexedSessions: 0, indexedEntries: 0, resetBoundaries: 0,
      malformedEntries: 0, malformedMessages: 0, truncatedParts: 0, editsUnsupported: 0,
    };
  }
  const placeholders = conversationIds.map(() => "?").join(",");
  const progress = await db.get<{
    sessions: number;
    entries: number | null;
    malformed_entries: number | null;
    malformed_messages: number | null;
    truncated_parts: number | null;
    edits_unsupported: number | null;
  }>(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(indexed_entry_count), 0) AS entries,
            COALESCE(SUM(malformed_entries), 0) AS malformed_entries,
            COALESCE(SUM(malformed_messages), 0) AS malformed_messages,
            COALESCE(SUM(truncated_parts), 0) AS truncated_parts,
            COALESCE(SUM(edits_unsupported), 0) AS edits_unsupported
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
    truncatedParts: progress?.truncated_parts ?? 0,
    editsUnsupported: progress?.edits_unsupported ?? 0,
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
              d.tool_name, d.tool_call_id, d.timestamp, d.episode_start_entry_id,
              d.part_index, d.chunk_index,
              d.char_start, d.body_length, d.truncated, d.entry_fingerprint,
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
  // Token/prefix semantics, never literal substring: each term is quoted, and
  // the final term may extend to a longer word beginning with it.
  const lastTerm = query.terms.length - 1;
  const match = query.terms.map((term, index) => {
    const quoted = `"${term.replaceAll('"', '""')}"`;
    return index === lastTerm ? `${quoted}*` : quoted;
  }).join(" ");
  return db.all<DocRow>(
    `SELECT d.doc_id, d.conversation_id, d.entry_id, d.entry_kind, d.role,
            d.tool_name, d.tool_call_id, d.timestamp, d.episode_start_entry_id,
            d.part_index, d.chunk_index,
            d.char_start, d.body_length, d.truncated, d.entry_fingerprint,
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

interface ReconcileResult {
  readonly budget: SyncBudget;
  readonly caughtUp: boolean;
  readonly elapsedMs: number;
}

/** One bounded message/tool reconciliation pass over every mapped chat session. */
export async function reconcileSessions(
  open: { readonly db: NodeSqliteDatabase; readonly summaryReady?: boolean },
  options: HistoryIndexOptions,
  sessions: readonly HistorySession[],
  context: Context,
): Promise<ReconcileResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget: SyncBudget = {
    remainingEntries: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
    remainingBytes: HISTORY_INDEX_LIMITS.maxPassBytes,
    deadline: startedAt + HISTORY_INDEX_LIMITS.maxPassMs,
    scanned: 0,
    indexed: 0,
    bytesPrepared: 0,
    malformedEntries: 0,
    malformedMessages: 0,
    truncatedParts: 0,
    editsUnsupported: 0,
  };
  let caughtUp = true;
  for (const session of sessions) {
    if (budget.remainingEntries <= 0 || now() >= budget.deadline) {
      caughtUp = false;
      break;
    }
    const conversationCaughtUp = await syncConversation(open, options, session, budget, context);
    if (!conversationCaughtUp) caughtUp = false;
  }
  return { budget, caughtUp, elapsedMs: Math.max(0, now() - startedAt) };
}

/**
 * One message/tool search page: validate the query and mapping, check a continuation against the
 * current derived index, run one bounded reconciliation pass and return a stable page.
 */
export async function searchMessages(
  queryInput: unknown,
  options: HistoryIndexOptions,
  ensureOpen: (storeId: string) => Promise<OpenHistoryIndex>,
  context: Context,
): Promise<HistoryPage> {
  const query = readQuery(queryInput);
  const { sessions, conversationIds, mappingSha256 } = await loadSessions(options, context);
  if (sessions.length === 0) {
    if (query.cursor !== undefined) throw new Error("History cursor does not belong to the current mapped sessions");
    return {
      hits: [],
      coverage: {
        sessions: 0,
        sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
        chatSessions: 0,
        indexedSessions: 0,
        indexedEntries: 0,
        resetBoundaries: 0,
        boundaryEntryId: 0,
        pendingEntries: 0,
        pendingComplete: true,
        complete: true,
        malformedEntries: 0,
        malformedMessages: 0,
        truncatedParts: 0,
        editsUnsupported: 0,
        sync: {
          entriesScanned: 0,
          entriesIndexed: 0,
          entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
          bytesPrepared: 0,
          byteLimit: HISTORY_INDEX_LIMITS.maxPassBytes,
          elapsedMs: 0,
          timeLimitMs: HISTORY_INDEX_LIMITS.maxPassMs,
          caughtUp: true,
        },
      },
    };
  }

  const storeId = await resolveStoreId(options.storeId, context);
  const open = await ensureOpen(storeId);
  if (query.cursor !== undefined) {
    if (query.cursor.generation !== open.generation) {
      throw new Error("History cursor belongs to a replaced derived index");
    }
    if (query.cursor.querySha256 !== query.querySha256) {
      throw new Error("History cursor does not match the requested query");
    }
    if (query.cursor.mappingSha256 !== mappingSha256) {
      throw new Error("History cursor does not match the current session mapping");
    }
    await verifyCursor(open, options, query.cursor, conversationIds, context);
  }

  const reconciliation = await reconcileSessions(open, options, sessions, context);
  const { budget, caughtUp } = reconciliation;

  await secureIndexFiles(options.indexPath);
  // Positive chat-history rule: a mapped conversation contributes only after at least one
  // searchable message/tool record exists. This excludes channel-state bookkeeping without
  // reserving a session-key suffix and survives new adapters.
  const activeConversationIds = await indexedConversationIds(open.db, conversationIds);
  const activeSet = new Set(activeConversationIds);
  const activeSessions = sessions.filter((session) => activeSet.has(session.conversationId as number));
  if (activeConversationIds.length === 0 && query.cursor !== undefined) {
    throw new Error("History cursor does not belong to the current indexed chat sessions");
  }
  if (query.cursor !== undefined) {
    // Reconciliation may have rebuilt a conversation and reassigned document IDs.
    await verifyCursor(open, options, query.cursor, activeConversationIds, context);
  }
  const boundaryEntryId = query.cursor?.boundaryEntryId ?? await indexedBoundary(open.db, activeConversationIds);
  if (query.cursor !== undefined) {
    const currentBoundary = await indexedBoundary(open.db, activeConversationIds);
    if (query.cursor.boundaryEntryId > currentBoundary) {
      throw new Error("History cursor boundary is no longer covered by the derived index");
    }
  }
  if (boundaryEntryId === 0) {
    const counts = await coverageCounts(open.db, activeConversationIds);
    const lag = await measureLag(open, options, sessions, context, budget.deadline);
    return {
      hits: [],
      coverage: {
        sessions: sessions.length,
        sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
        chatSessions: activeSessions.length,
        ...counts,
        boundaryEntryId: 0,
        pendingEntries: lag.entries,
        pendingComplete: lag.complete,
        complete: lag.entries === 0 && lag.complete && caughtUp
          && counts.truncatedParts === 0 && counts.editsUnsupported === 0,
        sync: {
          entriesScanned: budget.scanned,
          entriesIndexed: budget.indexed,
          entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
          bytesPrepared: budget.bytesPrepared,
          byteLimit: HISTORY_INDEX_LIMITS.maxPassBytes,
          elapsedMs: reconciliation.elapsedMs,
          timeLimitMs: HISTORY_INDEX_LIMITS.maxPassMs,
          caughtUp,
        },
      },
    };
  }

  const rows = await queryDocuments(open.db, query, activeConversationIds, boundaryEntryId, query.cursor);
  const hasMore = rows.length > query.limit;
  const visible = hasMore ? rows.slice(0, query.limit) : rows;
  const counts = await coverageCounts(open.db, activeConversationIds);
  const lag = await measureLag(open, options, sessions, context, budget.deadline);
  const sessionsById = new Map(activeSessions.map((session) => [session.conversationId as number, session.sessionKey]));
  const hits: HistoryHit[] = visible.map((row) => {
    const role = row.role as HistoryHit["role"];
    if (!READABLE_ROLES.has(role)) throw new Error("History index contains an unsupported role");
    const sessionKey = sessionsById.get(row.conversation_id);
    if (sessionKey === undefined) throw new Error("History index returned an unmapped conversation");
    const excerptLength = row.excerpt.length;
    return {
      conversationId: row.conversation_id as ConversationId,
      sessionKey,
      entryId: row.entry_id as EntryId,
      entryKind: row.entry_kind,
      role,
      ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
      ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
      ...(row.timestamp === null ? {} : { timestamp: row.timestamp }),
      episodeStartEntryId: row.episode_start_entry_id as EntryId,
      excerpt: row.excerpt,
      excerptTruncated: row.body_length > excerptLength,
      bodyLength: row.body_length,
      partIndex: row.part_index,
      chunkIndex: row.chunk_index,
      charStart: row.char_start,
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
      mappingSha256,
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
      sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
      chatSessions: activeSessions.length,
      ...counts,
      boundaryEntryId,
      pendingEntries: lag.entries,
      pendingComplete: lag.complete,
      complete: lag.entries === 0 && lag.complete && caughtUp
        && counts.truncatedParts === 0 && counts.editsUnsupported === 0,
      sync: {
        entriesScanned: budget.scanned,
        entriesIndexed: budget.indexed,
        entryLimit: HISTORY_INDEX_LIMITS.maxEntriesPerSync,
        bytesPrepared: budget.bytesPrepared,
        byteLimit: HISTORY_INDEX_LIMITS.maxPassBytes,
        elapsedMs: reconciliation.elapsedMs,
        timeLimitMs: HISTORY_INDEX_LIMITS.maxPassMs,
        caughtUp,
      },
    },
  };
}
