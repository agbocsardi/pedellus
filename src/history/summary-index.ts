/**
 * Summary layer of the derived history index: ready, boundary-verified episode summaries indexed for
 * discovery only. Summary text is untrusted derived navigation, never evidence. The layer repairs
 * itself from its stored content without touching message/tool tables, keeps a 64 MiB whole-index
 * byte budget, sweeps mapped chats round-robin in bounded passes and proves continuations against a
 * snapshot watermark. Schema shape and FTS5 integrity are verified once per open, and again after a
 * summary query fails, instead of on every page.
 */
import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isRecord } from "./transcript.js";
import { HISTORY_SUMMARY_READ_LIMITS, type HistorySummaryView } from "./summary-view.js";
import {
  HISTORY_INDEX_LIMITS,
  SHA256_HEX,
  loadSessions,
  resolveStoreId,
  secureIndexFiles,
  sha256,
  type HistoryIndexOptions,
  type HistorySession,
  type OpenHistoryIndex,
} from "./index-db.js";
import {
  clampUtf8,
  indexedConversationIds,
  normalizeQueryText,
  queryTerms,
  readProgress,
  reconcileSessions,
} from "./message-index.js";

export const HISTORY_SUMMARY_LIMITS = Object.freeze({
  /** Summary hits per page when the caller omits `limit`. */
  defaultPageSize: 8,
  /** Hard summary page cap. */
  maxPageSize: 20,
  /** Normalized summary query text bound in Unicode code points. */
  maxQueryChars: 500,
  /** Distinct FTS terms considered from one summary query. */
  maxQueryTerms: 16,
  /** Stored summary body bound in UTF-16 code units; the summary pass caps text well below this. */
  maxIndexedSummaryChars: HISTORY_SUMMARY_READ_LIMITS.maxSummaryChars,
  /** Stored summary body bound in UTF-8 bytes; a multibyte body is cut at the smaller bound. */
  maxSummaryBodyBytes: 32 * 1024,
  /** Stored title bound in UTF-16 code units. */
  maxIndexedTitleChars: HISTORY_SUMMARY_READ_LIMITS.maxTitleChars,
  /** Stored title bound in UTF-8 bytes. */
  maxSummaryTitleBytes: 1024,
  /**
   * Total UTF-8 bytes of indexed summary bodies for all mapped conversations. Beyond it a new row
   * is not stored and is counted as omitted, so the derived file cannot grow without a bound.
   */
  maxIndexedSummaryBytes: 64 * 1024 * 1024,
  /** Excerpt size for a browse (empty) summary query. */
  excerptChars: 400,
  /** FTS snippet token window for a matched summary query. */
  snippetTokens: 24,
  /** Newest closed episodes re-checked every summary pass, so a fresh summary appears quickly. */
  newestEpisodesPerSession: 4,
  /** Most episode summaries checked for one conversation in one pass. */
  maxEpisodesPerSession: 8,
  /** Episode summary records read across all mapped chats in one summary search. */
  maxSummaryReadsPerPass: 64,
  /** Wall-clock budget for one bounded summary refresh before the page is returned. */
  maxSummaryPassMs: 1_500,
});

/**
 * Opaque summary-search continuation. It is host state, not authorization, and is bound to the
 * normalized query, index generation, store identity, mapped conversation-ID set, and a snapshot of
 * the indexed summary rows: only rows with `summary_id` at or below the captured watermark are
 * eligible, so rows indexed or replaced after the first page cannot enter that continuation. The
 * boundary row's fingerprint is re-checked before every continuation.
 */
export interface HistorySummaryCursor {
  readonly version: 1;
  readonly querySha256: string;
  readonly generation: string;
  readonly mappingSha256: string;
  readonly snapshotSummaryId: number;
  /** Rows eligible in the captured snapshot; a later deletion or replacement changes this count. */
  readonly snapshotRows: number;
  readonly lastSummaryId: number;
  readonly lastStartEntryId: number;
  readonly lastConversationId: number;
  readonly lastFingerprint: string;
}

export interface HistorySummaryQuery {
  /**
   * Token/prefix terms over readiness-checked summary titles and bodies. Empty browses the newest
   * ready summaries. Same FTS `unicode61` tokenizer and last-term-prefix rule as raw search; this
   * is not substring matching.
   */
  readonly text?: string;
  readonly limit?: number;
  readonly cursor?: HistorySummaryCursor;
}

/** One ready derived episode summary discovered across mapped chat conversations. */
export interface HistorySummaryHit {
  readonly conversationId: ConversationId;
  readonly sessionKey: string;
  readonly startEntryId: EntryId;
  readonly endEntryId: EntryId;
  readonly resetEntryId: EntryId | null;
  readonly summarizerVersion: number;
  readonly title: string | null;
  /** Bounded excerpt from the indexed title/body; matches are wrapped in `[...]`. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  /** Indexed summary body length in UTF-16 code units. */
  readonly summaryLength: number;
  readonly completedAtMs: number | null;
  readonly sourceEntries: number;
  readonly sourceMessages: number;
  readonly sourceToolResults: number;
  readonly sourceTruncatedEntries: number;
  readonly coverageComplete: boolean;
  /** The index stored only the leading text of an oversize summary. */
  readonly summaryTruncated: boolean;
}

export interface HistorySummarySyncReport {
  /** False when the bounded message/episode reconciliation did not catch up before the sweep. */
  readonly caughtUp: boolean;
  /** Closed episodes known to the index for mapped chats (current open episodes excluded). */
  readonly episodesKnown: number;
  /** Episodes whose stored summary state was re-read by this pass. */
  readonly episodesChecked: number;
  readonly summariesReady: number;
  readonly summariesNotReady: number;
  /** No stored episode/summary record: an empty episode or a catalog that has not recorded it yet. */
  readonly summariesMissing: number;
  readonly summariesMalformed: number;
  /** Stored summary documents that could not be read at all; their last good row is kept. */
  readonly summariesUnreadable: number;
  /** Indexed summary rows removed because the authoritative record is no longer ready/readable. */
  readonly summariesRemoved: number;
  /** Summaries whose indexed text was clamped by the index bounds. */
  readonly summariesTruncated: number;
  /** New rows not stored because the whole-index byte budget was reached. */
  readonly summariesOmitted: number;
  readonly sessionsSwept: number;
  /** Sessions whose known closed episodes were not all re-checked in this pass. */
  readonly sessionsPending: number;
  readonly readLimit: number;
  readonly byteLimit: number;
  readonly elapsedMs: number;
  readonly timeLimitMs: number;
  /** False when this host did not wire a summary source; no summary rows are read or written. */
  readonly available: boolean;
  /** False when the summary tables could not be created; message search still works. */
  readonly indexReady: boolean;
}

export interface HistorySummaryCoverage {
  readonly sessions: number;
  readonly sessionLimit: number;
  readonly chatSessions: number;
  /** Ready summary rows indexed for mapped chat conversations. */
  readonly summariesIndexed: number;
  /** Closed episodes known to the index, excluding each conversation's current open episode. */
  readonly episodesKnown: number;
  /**
   * True only when this pass re-checked every known closed episode, no indexed summary text was
   * clamped or omitted, no stored summary was unreadable or malformed and episode reconciliation
   * caught up. A bounded sweep never claims completeness; `episodesChecked` reports its coverage.
   */
  readonly complete: boolean;
  readonly available: boolean;
  /** False when summary tables could not be created; raw message/tool search is unaffected. */
  readonly indexReady: boolean;
  /** True when no summary row was indexed or replaced after this page's snapshot. */
  readonly snapshotCurrent: boolean;
  /** Rows written after this snapshot and therefore excluded from this page/continuation. */
  readonly summariesAfterSnapshot: number;
  /** UTF-8 bytes of indexed summary bodies. */
  readonly indexBytes: number;
  /** True when the whole-index budget is reached, so new summaries cannot be added until a rebuild. */
  readonly indexFull: boolean;
  readonly sync: HistorySummarySyncReport;
}

export interface HistorySummaryPage {
  /** Newest episode first by start entry ID, then conversation ID. */
  readonly hits: readonly HistorySummaryHit[];
  readonly next?: HistorySummaryCursor;
  readonly coverage: HistorySummaryCoverage;
}

/** Serialize a summary-search continuation as one opaque, copyable token. */
export function encodeHistorySummaryCursor(cursor: HistorySummaryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Parse an opaque summary continuation and reject malformed or unsupported shapes. */
export function decodeHistorySummaryCursor(token: string): HistorySummaryCursor {
  if (typeof token !== "string" || token.length === 0 || token.length > HISTORY_INDEX_LIMITS.maxCursorTokenChars) {
    throw new TypeError("History summary cursor token is invalid");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError("History summary cursor token is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("History summary cursor token is invalid");
  }
  return readSummaryCursor(parsed);
}

interface SummaryRow {
  readonly summary_id: number;
  readonly conversation_id: number;
  readonly start_entry_id: number;
  readonly end_entry_id: number;
  readonly reset_entry_id: number | null;
  readonly summarizer_version: number;
  readonly title: string;
  readonly body_length: number;
  readonly excerpt: string;
  readonly truncated: number;
  readonly completed_at_ms: number | null;
  readonly source_entries: number;
  readonly source_messages: number;
  readonly source_tool_results: number;
  readonly source_truncated_entries: number;
  readonly coverage_complete: number;
  readonly fingerprint: string;
}

interface SummaryWrite {
  readonly startEntryId: number;
  readonly endEntryId: number;
  readonly resetEntryId: number | null;
  readonly summarizerVersion: number;
  readonly title: string;
  readonly body: string;
  readonly bodyBytes: number;
  readonly truncated: boolean;
  readonly completedAtMs: number | null;
  readonly sourceEntries: number;
  readonly sourceMessages: number;
  readonly sourceToolResults: number;
  readonly sourceTruncatedEntries: number;
  readonly coverageComplete: boolean;
  readonly fingerprint: string;
}

interface SummaryCursorProofRow {
  readonly summary_id: number;
  readonly conversation_id: number;
  readonly start_entry_id: number;
  readonly fingerprint: string;
}

interface SummarySweepState {
  readonly sweep_before_entry_id: number | null;
}

interface ParsedSummaryQuery {
  readonly normalizedText: string;
  readonly terms: readonly string[];
  readonly browsing: boolean;
  readonly limit: number;
  readonly querySha256: string;
  readonly cursor?: HistorySummaryCursor;
}

function readSummaryQuery(query: unknown): ParsedSummaryQuery {
  if (!isRecord(query)) throw new TypeError("History summary query must be an object");
  const allowed = new Set(["text", "limit", "cursor"]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new TypeError(`History summary query has an unsupported field: ${key}`);
  }
  const rawText = query.text;
  if (rawText !== undefined && typeof rawText !== "string") {
    throw new TypeError("History summary text must be a string");
  }
  const normalizedText = rawText === undefined ? "" : normalizeQueryText(rawText);
  if ([...normalizedText].length > HISTORY_SUMMARY_LIMITS.maxQueryChars) {
    throw new TypeError(`History summary text must be at most ${HISTORY_SUMMARY_LIMITS.maxQueryChars} characters`);
  }
  const rawLimit = query.limit;
  if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1)) {
    throw new TypeError("History summary limit must be a positive safe integer");
  }
  const limit = Math.min(
    (rawLimit as number | undefined) ?? HISTORY_SUMMARY_LIMITS.defaultPageSize,
    HISTORY_SUMMARY_LIMITS.maxPageSize,
  );
  const cursor = query.cursor === undefined ? undefined : readSummaryCursor(query.cursor);
  const terms = queryTerms(normalizedText).slice(0, HISTORY_SUMMARY_LIMITS.maxQueryTerms);
  return {
    normalizedText,
    terms,
    browsing: normalizedText.length === 0,
    limit,
    // The action is part of the digest, so a raw-search cursor cannot be replayed as a summary cursor.
    querySha256: sha256(JSON.stringify(["summaries", normalizedText])),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function readSummaryCursor(value: unknown): HistorySummaryCursor {
  if (!isRecord(value)) throw new TypeError("History summary cursor must be an object");
  const allowed = new Set([
    "version", "querySha256", "generation", "mappingSha256", "snapshotSummaryId", "snapshotRows",
    "lastSummaryId", "lastStartEntryId", "lastConversationId", "lastFingerprint",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`History summary cursor has an unsupported field: ${key}`);
  }
  if (value.version !== 1) throw new TypeError("History summary cursor version is not supported");
  if (typeof value.querySha256 !== "string" || !SHA256_HEX.test(value.querySha256)) {
    throw new TypeError("History summary cursor query digest is invalid");
  }
  if (typeof value.generation !== "string" || value.generation.length === 0 || value.generation.length > 128) {
    throw new TypeError("History summary cursor generation is invalid");
  }
  if (typeof value.mappingSha256 !== "string" || !SHA256_HEX.test(value.mappingSha256)) {
    throw new TypeError("History summary cursor mapping digest is invalid");
  }
  for (const key of ["snapshotSummaryId", "snapshotRows", "lastSummaryId", "lastStartEntryId", "lastConversationId"] as const) {
    const number = value[key];
    if (!Number.isSafeInteger(number) || (number as number) < 1) {
      throw new TypeError(`History summary cursor ${key} is invalid`);
    }
  }
  if (typeof value.lastFingerprint !== "string" || !SHA256_HEX.test(value.lastFingerprint)) {
    throw new TypeError("History summary cursor fingerprint is invalid");
  }
  return {
    version: 1,
    querySha256: value.querySha256,
    generation: value.generation,
    mappingSha256: value.mappingSha256,
    snapshotSummaryId: value.snapshotSummaryId as number,
    snapshotRows: value.snapshotRows as number,
    lastSummaryId: value.lastSummaryId as number,
    lastStartEntryId: value.lastStartEntryId as number,
    lastConversationId: value.lastConversationId as number,
    lastFingerprint: value.lastFingerprint,
  };
}

export async function createSummarySchema(db: NodeSqliteDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS history_summaries (
      summary_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      start_entry_id INTEGER NOT NULL,
      end_entry_id INTEGER NOT NULL,
      reset_entry_id INTEGER,
      summarizer_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      body_length INTEGER NOT NULL,
      body_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      completed_at_ms INTEGER,
      source_entries INTEGER NOT NULL,
      source_messages INTEGER NOT NULL,
      source_tool_results INTEGER NOT NULL,
      source_truncated_entries INTEGER NOT NULL,
      coverage_complete INTEGER NOT NULL CHECK (coverage_complete IN (0, 1)),
      fingerprint TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(conversation_id, start_entry_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS history_summaries_by_start
      ON history_summaries (start_entry_id, conversation_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS history_summary_fts USING fts5(
      title,
      body,
      content='history_summaries',
      content_rowid='summary_id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS history_summaries_ai AFTER INSERT ON history_summaries BEGIN
      INSERT INTO history_summary_fts (rowid, title, body) VALUES (new.summary_id, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS history_summaries_ad AFTER DELETE ON history_summaries BEGIN
      INSERT INTO history_summary_fts (history_summary_fts, rowid, title, body)
        VALUES ('delete', old.summary_id, old.title, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS history_summaries_au AFTER UPDATE ON history_summaries BEGIN
      INSERT INTO history_summary_fts (history_summary_fts, rowid, title, body)
        VALUES ('delete', old.summary_id, old.title, old.body);
      INSERT INTO history_summary_fts (rowid, title, body) VALUES (new.summary_id, new.title, new.body);
    END;
    CREATE TABLE IF NOT EXISTS history_summary_sweep (
      conversation_id INTEGER PRIMARY KEY,
      sweep_before_entry_id INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO history_meta (key, value) VALUES ('summary_bytes', '0')
      ON CONFLICT(key) DO NOTHING;
    INSERT INTO history_meta (key, value) VALUES ('summary_session_cursor', '0')
      ON CONFLICT(key) DO NOTHING;
    UPDATE history_meta SET value = CAST(COALESCE(
      (SELECT SUM(body_bytes) FROM history_summaries), 0) AS TEXT)
      WHERE key = 'summary_bytes';
  `);
}

export async function dropSummarySchema(db: NodeSqliteDatabase): Promise<void> {
  await db.exec(`
    DROP TRIGGER IF EXISTS history_summaries_ai;
    DROP TRIGGER IF EXISTS history_summaries_ad;
    DROP TRIGGER IF EXISTS history_summaries_au;
    DROP TABLE IF EXISTS history_summary_fts;
    DROP TABLE IF EXISTS history_summaries;
    DROP TABLE IF EXISTS history_summary_sweep;
  `);
}

const SUMMARY_SCHEMA_TABLES = [
  "history_summaries",
  "history_summary_fts",
  "history_summary_sweep",
] as const;

const SUMMARY_SCHEMA_TRIGGERS = [
  "history_summaries_ai",
  "history_summaries_ad",
  "history_summaries_au",
] as const;

const SUMMARY_CONTENT_COLUMNS = [
  "summary_id", "conversation_id", "start_entry_id", "end_entry_id", "reset_entry_id",
  "summarizer_version", "title", "body", "body_length", "body_bytes", "truncated",
  "completed_at_ms", "source_entries", "source_messages", "source_tool_results",
  "source_truncated_entries", "coverage_complete", "fingerprint", "indexed_at",
] as const;

const SUMMARY_SWEEP_COLUMNS = ["conversation_id", "sweep_before_entry_id", "updated_at"] as const;

interface SummarySchemaState {
  readonly objectsOk: boolean;
  readonly contentOk: boolean;
  readonly sweepOk: boolean;
}

async function columnNames(db: NodeSqliteDatabase, table: string): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

/**
 * Classify the summary schema. A name with the wrong object type or shape is not "present": the
 * repair path can then recreate it instead of letting a later SQL error escape as a summary-search
 * failure. Raw message/tool tables are never touched by this check.
 */
async function summarySchemaState(db: NodeSqliteDatabase): Promise<SummarySchemaState> {
  try {
    const names = [...SUMMARY_SCHEMA_TABLES, ...SUMMARY_SCHEMA_TRIGGERS];
    const placeholders = names.map(() => "?").join(",");
    const rows = await db.all<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master WHERE name IN (${placeholders})`,
      ...names,
    );
    const byName = new Map(rows.map((row) => [row.name, row.type]));
    const objectsOk = SUMMARY_SCHEMA_TABLES.every((name) => byName.get(name) === "table")
      && SUMMARY_SCHEMA_TRIGGERS.every((name) => byName.get(name) === "trigger");
    const contentColumns = await columnNames(db, "history_summaries");
    const sweepColumns = await columnNames(db, "history_summary_sweep");
    return {
      objectsOk,
      contentOk: SUMMARY_CONTENT_COLUMNS.every((name) => contentColumns.has(name)),
      sweepOk: SUMMARY_SWEEP_COLUMNS.every((name) => sweepColumns.has(name)),
    };
  } catch {
    return { objectsOk: false, contentOk: false, sweepOk: false };
  }
}

/**
 * Repair the summary layer without touching message/tool tables. Content rows are preserved when the
 * content shape is valid; a wrongly shaped or missing content table is dropped and recreated empty, so
 * later bounded sweeps repopulate it from Durable. The FTS table and triggers are recreated and the
 * index is rebuilt from content; the summary byte counter is recomputed from the surviving rows.
 * Failure marks the summary index unavailable for this open; raw message/tool search is unaffected.
 */
async function repairSummarySchema(
  open: OpenHistoryIndex,
  state: SummarySchemaState,
): Promise<boolean> {
  try {
    await open.db.exec(`
      DROP TRIGGER IF EXISTS history_summaries_ai;
      DROP TRIGGER IF EXISTS history_summaries_ad;
      DROP TRIGGER IF EXISTS history_summaries_au;
      DROP TABLE IF EXISTS history_summary_fts;
      DROP VIEW IF EXISTS history_summary_fts;
      DROP TABLE IF EXISTS history_summary_sweep;
      DROP VIEW IF EXISTS history_summary_sweep;
    `);
    if (!state.sweepOk) {
      await open.db.exec("DROP TABLE IF EXISTS history_summary_sweep; DROP VIEW IF EXISTS history_summary_sweep");
    }
    if (!state.contentOk) {
      await open.db.exec("DROP TABLE IF EXISTS history_summaries; DROP VIEW IF EXISTS history_summaries");
    }
    await createSummarySchema(open.db);
    await open.db.run("INSERT INTO history_summary_fts (history_summary_fts) VALUES ('rebuild')");
    await open.db.run(
      "UPDATE history_meta SET value = CAST(COALESCE("
      + "(SELECT SUM(body_bytes) FROM history_summaries), 0) AS TEXT) WHERE key = 'summary_bytes'",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify the summary schema shape and FTS integrity once per open. A missing/wrong table, missing
 * trigger or logical FTS drift is repaired from the stored content; if repair fails the summary index
 * is reported unavailable and raw message/tool search continues to work. Later pages trust that
 * check: a summary query that then fails clears `summaryVerified`, so the next call re-verifies and
 * repairs. Logical drift that raises no SQL error is therefore caught at the next open, not on every
 * page. The integrity check is bounded by the 64 MiB whole-index budget (derived data, not the
 * transcript).
 */
export async function ensureSummaryIndex(open: OpenHistoryIndex): Promise<boolean> {
  if (!open.summaryReady) return false;
  if (open.summaryVerified) return true;
  try {
    const state = await summarySchemaState(open.db);
    if (!state.objectsOk || !state.contentOk || !state.sweepOk) {
      open.summaryReady = await repairSummarySchema(open, state);
    } else {
      try {
        // FTS5 external-content integrity check: compares the index with history_summaries.
        await open.db.run(
          "INSERT INTO history_summary_fts (history_summary_fts, rank) VALUES ('integrity-check', 1)",
        );
      } catch {
        open.summaryReady = await repairSummarySchema(open, state);
      }
    }
  } catch {
    open.summaryReady = false;
  }
  open.summaryVerified = open.summaryReady;
  return open.summaryReady;
}

/** Content identity of one indexed summary row; a change replaces the row (and its id). */
function summaryFingerprint(write: Omit<SummaryWrite, "fingerprint" | "title" | "body"> & {
  readonly title: string;
  readonly body: string;
}): string {
  return sha256(JSON.stringify([
    write.startEntryId,
    write.endEntryId,
    write.resetEntryId,
    write.summarizerVersion,
    write.title,
    write.body,
    write.truncated,
    write.completedAtMs,
    write.sourceEntries,
    write.sourceMessages,
    write.sourceToolResults,
    write.sourceTruncatedEntries,
    write.coverageComplete,
  ]));
}

/**
 * Upsert one ready summary. A content change deletes and reinserts the row so its `summary_id`
 * advances; that is what makes a page-1 snapshot watermark exclude summaries replaced or indexed
 * after it. An unchanged row is left untouched.
 */
async function readSummaryBytes(db: NodeSqliteDatabase): Promise<number> {
  const row = await db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'summary_bytes'",
  );
  const counted = row === undefined ? Number.NaN : Number.parseInt(row.value, 10);
  if (Number.isSafeInteger(counted) && counted >= 0) return counted;
  // A hand-edited or legacy derived file may lack the counter; recompute it once and persist it.
  const total = await db.get<{ total: number | null }>(
    "SELECT COALESCE(SUM(body_bytes), 0) AS total FROM history_summaries",
  );
  const value = total?.total ?? 0;
  await db.run(
    "INSERT INTO history_meta (key, value) VALUES ('summary_bytes', ?) "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(value),
  );
  return value;
}

/**
 * Upsert one ready summary. A content change deletes and reinserts the row so its `summary_id`
 * advances; that is what makes a page-1 snapshot watermark exclude summaries replaced or indexed
 * after it. An unchanged row is left untouched. A new or growing row is not stored once the
 * whole-index byte budget is reached; the omission is durable and reported instead of silent.
 */
async function writeSummary(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  write: SummaryWrite,
  indexedAt: number,
): Promise<"inserted" | "replaced" | "unchanged" | "omitted" | "omitted-removed"> {
  const existing = await db.get<{ summary_id: number; fingerprint: string; body_bytes: number }>(
    "SELECT summary_id, fingerprint, body_bytes FROM history_summaries "
    + "WHERE conversation_id = ? AND start_entry_id = ?",
    conversationId,
    write.startEntryId,
  );
  if (existing !== undefined && existing.fingerprint === write.fingerprint) return "unchanged";
  const used = await readSummaryBytes(db);
  const nextBytes = used - (existing?.body_bytes ?? 0) + write.bodyBytes;
  if (nextBytes > HISTORY_SUMMARY_LIMITS.maxIndexedSummaryBytes) {
    if (existing === undefined) return "omitted";
    // A replacement that no longer fits must not leave the previous text in place: that would be
    // stale summary content presented as current. Remove it and report the omission.
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM history_summaries WHERE summary_id = ?", existing.summary_id);
      await tx.run(
        "INSERT INTO history_meta (key, value) VALUES ('summary_bytes', ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(Math.max(0, used - existing.body_bytes)),
      );
    });
    return "omitted-removed";
  }
  await db.transaction(async (tx) => {
    if (existing !== undefined) {
      await tx.run("DELETE FROM history_summaries WHERE summary_id = ?", existing.summary_id);
    }
    await tx.run(
      `INSERT INTO history_summaries
         (conversation_id, start_entry_id, end_entry_id, reset_entry_id, summarizer_version,
          title, body, body_length, body_bytes, truncated, completed_at_ms, source_entries,
          source_messages, source_tool_results, source_truncated_entries, coverage_complete,
          fingerprint, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      write.startEntryId,
      write.endEntryId,
      write.resetEntryId,
      write.summarizerVersion,
      write.title,
      write.body,
      write.body.length,
      write.bodyBytes,
      write.truncated ? 1 : 0,
      write.completedAtMs,
      write.sourceEntries,
      write.sourceMessages,
      write.sourceToolResults,
      write.sourceTruncatedEntries,
      write.coverageComplete ? 1 : 0,
      write.fingerprint,
      indexedAt,
    );
    await tx.run(
      "INSERT INTO history_meta (key, value) VALUES ('summary_bytes', ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(nextBytes),
    );
  });
  return existing === undefined ? "inserted" : "replaced";
}

/** Remove a summary row whose authoritative record is no longer a readable ready summary. */
async function removeSummary(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  startEntryId: number,
): Promise<boolean> {
  const existing = await db.get<{ summary_id: number; body_bytes: number }>(
    "SELECT summary_id, body_bytes FROM history_summaries WHERE conversation_id = ? AND start_entry_id = ?",
    conversationId,
    startEntryId,
  );
  if (existing === undefined) return false;
  const used = await readSummaryBytes(db);
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM history_summaries WHERE summary_id = ?", existing.summary_id);
    await tx.run(
      "INSERT INTO history_meta (key, value) VALUES ('summary_bytes', ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(Math.max(0, used - existing.body_bytes)),
    );
  });
  return true;
}

async function readSummarySweep(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
): Promise<SummarySweepState | undefined> {
  return db.get<SummarySweepState>(
    "SELECT sweep_before_entry_id FROM history_summary_sweep WHERE conversation_id = ?",
    conversationId,
  );
}

async function writeSummarySweep(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  nextBefore: number | null,
  updatedAt: number,
): Promise<void> {
  await db.run(
    `INSERT INTO history_summary_sweep (conversation_id, sweep_before_entry_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       sweep_before_entry_id = excluded.sweep_before_entry_id,
       updated_at = excluded.updated_at`,
    conversationId,
    nextBefore,
    updatedAt,
  );
}

async function readSummarySessionCursor(db: NodeSqliteDatabase): Promise<number> {
  const row = await db.get<{ value: string }>(
    "SELECT value FROM history_meta WHERE key = 'summary_session_cursor'",
  );
  const value = row === undefined ? 0 : Number.parseInt(row.value, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function writeSummarySessionCursor(db: NodeSqliteDatabase, conversationId: number): Promise<void> {
  await db.run(
    "INSERT INTO history_meta (key, value) VALUES ('summary_session_cursor', ?) "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(conversationId),
  );
}

/**
 * Pick the episodes one conversation re-checks in this pass: the newest few (so a freshly written
 * summary appears on the next search) plus a continuation of the durable older round-robin cursor.
 * `nextBefore` advances only when the whole selected page was processed; a page that hits the read
 * budget leaves the cursor unchanged so unchecked episodes are not skipped.
 */
async function summarySweepCandidates(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  quota: number,
  newestLimit: number,
  openStartEntryId: number | null,
): Promise<{ starts: readonly number[]; nextBefore: number | null }> {
  const newest = newestLimit <= 0
    ? []
    : await db.all<{ start_entry_id: number }>(
      `SELECT start_entry_id FROM history_episodes
        WHERE conversation_id = ? AND start_entry_id <> ?
        ORDER BY start_entry_id DESC LIMIT ?`,
      conversationId,
      openStartEntryId ?? 0,
      newestLimit,
    );
  const starts = newest.map((row) => row.start_entry_id);
  if (starts.length === 0 && newestLimit > 0) return { starts, nextBefore: null };
  const olderQuota = quota - starts.length;
  if (olderQuota <= 0) return { starts, nextBefore: starts[starts.length - 1]! };
  const state = await readSummarySweep(db, conversationId);
  // A single-read older pass with no saved cursor starts at the top of the conversation, so it still
  // sees the newest episodes. A pass with a newest page scans below that page.
  const bound = state?.sweep_before_entry_id
    ?? (starts.length > 0 ? starts[starts.length - 1]! : Number.MAX_SAFE_INTEGER);
  const older = await db.all<{ start_entry_id: number }>(
    `SELECT start_entry_id FROM history_episodes
      WHERE conversation_id = ? AND start_entry_id <> ? AND start_entry_id < ?
      ORDER BY start_entry_id DESC LIMIT ?`,
    conversationId,
    openStartEntryId ?? 0,
    bound,
    olderQuota + 1,
  );
  const hasMore = older.length > olderQuota;
  const included = hasMore ? older.slice(0, olderQuota) : older;
  starts.push(...included.map((row) => row.start_entry_id));
  return {
    starts,
    nextBefore: hasMore ? included[included.length - 1]!.start_entry_id : null,
  };
}

/** Closed episodes the index knows for one conversation; the current open episode cannot be summarized. */
async function closedEpisodeCount(
  db: NodeSqliteDatabase,
  conversationId: ConversationId,
  openStartEntryId: number | null,
): Promise<number> {
  const row = await db.get<{ episodes: number }>(
    `SELECT COUNT(*) AS episodes FROM history_episodes
      WHERE conversation_id = ? AND start_entry_id <> ?`,
    conversationId,
    openStartEntryId ?? 0,
  );
  return row?.episodes ?? 0;
}

async function summaryCounts(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
): Promise<{ summaries: number; truncated: number; bytes: number }> {
  if (conversationIds.length === 0) return { summaries: 0, truncated: 0, bytes: 0 };
  const placeholders = conversationIds.map(() => "?").join(",");
  const summaries = await db.get<{ summaries: number; truncated: number | null }>(
    `SELECT COUNT(*) AS summaries, COALESCE(SUM(truncated), 0) AS truncated
       FROM history_summaries WHERE conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  return {
    summaries: summaries?.summaries ?? 0,
    truncated: summaries?.truncated ?? 0,
    bytes: await readSummaryBytes(db),
  };
}

/**
 * Re-read a bounded slice of stored summaries and reconcile the derived summary rows. Raw message
 * reconciliation already ran, so episode boundaries are current. A per-episode read failure removes
 * no row and never fails the summary search; missing/not-ready/malformed records remove their own row.
 * `episodesChecked` counts distinct closed episodes re-read in this pass, so it can never claim more
 * coverage than the page actually had.
 */
async function sweepSummaries(
  open: OpenHistoryIndex,
  options: HistoryIndexOptions,
  sessions: readonly HistorySession[],
  context: Context,
): Promise<HistorySummarySyncReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + HISTORY_SUMMARY_LIMITS.maxSummaryPassMs;
  const read = options.readSummary;
  const base = {
    caughtUp: true,
    episodesKnown: 0,
    episodesChecked: 0,
    summariesReady: 0,
    summariesNotReady: 0,
    summariesMissing: 0,
    summariesMalformed: 0,
    summariesUnreadable: 0,
    summariesRemoved: 0,
    summariesTruncated: 0,
    summariesOmitted: 0,
    sessionsSwept: 0,
    sessionsPending: sessions.length,
    readLimit: HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass,
    byteLimit: HISTORY_SUMMARY_LIMITS.maxIndexedSummaryBytes,
    elapsedMs: 0,
    timeLimitMs: HISTORY_SUMMARY_LIMITS.maxSummaryPassMs,
    available: read !== undefined,
    indexReady: open.summaryReady,
  };
  if (read === undefined || !open.summaryReady) {
    return { ...base, elapsedMs: Math.max(0, now() - startedAt) };
  }
  const perSession = Math.max(
    1,
    Math.min(
      HISTORY_SUMMARY_LIMITS.maxEpisodesPerSession,
      Math.floor(HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass / Math.max(1, sessions.length)),
    ),
  );
  // Fair cross-session rotation: sort by conversation ID and start after the last session that got a
  // turn in the previous pass. With more sessions than the read budget, later sessions are reached on
  // the next pass instead of being starved forever.
  const ordered = [...sessions].sort(
    (left, right) => (left.conversationId as number) - (right.conversationId as number),
  );
  const rotation = await readSummarySessionCursor(open.db);
  let start = ordered.findIndex((session) => (session.conversationId as number) > rotation);
  if (start < 0) start = 0;
  let episodesKnown = 0;
  let episodesChecked = 0;
  let sessionsSwept = 0;
  let sessionsPending = 0;
  let lastProcessed: number | null = null;
  for (let step = 0; step < ordered.length; step++) {
    const session = ordered[(start + step) % ordered.length]!;
    const progress = await readProgress(open.db, session.conversationId);
    const openStart = progress?.episode_start_entry_id ?? null;
    const known = await closedEpisodeCount(open.db, session.conversationId, openStart);
    episodesKnown += known;
    if (episodesChecked >= HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass || now() >= deadline) {
      if (known > 0) sessionsPending++;
      continue;
    }
    const quota = Math.min(perSession, HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass - episodesChecked);
    // Reserve part of every multi-read quota for the older round-robin, so a session with many
    // episodes can never consume its whole budget on the newest few and leave older ones unreachable.
    // With a one-read quota, alternate per conversation between the newest page and the older cursor:
    // a fresh conversation reads its newest episode first, then older pages, so every episode is
    // eventually indexed instead of re-reading the newest forever.
    const sweepState = quota <= 1 ? await readSummarySweep(open.db, session.conversationId) : undefined;
    const newestLimit = quota <= 1
      ? (sweepState?.sweep_before_entry_id === null || sweepState?.sweep_before_entry_id === undefined ? 1 : 0)
      : Math.min(HISTORY_SUMMARY_LIMITS.newestEpisodesPerSession, Math.max(1, Math.ceil(quota / 2)));
    const candidates = await summarySweepCandidates(
      open.db,
      session.conversationId,
      quota,
      newestLimit,
      openStart,
    );
    let processedAll = true;
    let checkedHere = 0;
    if (candidates.starts.length > 0) sessionsSwept++;
    for (const episodeStart of candidates.starts) {
      if (episodesChecked >= HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass || now() >= deadline) {
        processedAll = false;
        break;
      }
      episodesChecked++;
      checkedHere++;
      let view: HistorySummaryView;
      try {
        view = await read(context, session.conversationId, episodeStart as EntryId);
      } catch {
        view = { state: "unreadable" };
      }
      if (view.state === "ready") {
        const snapshot = view.snapshot;
        const charBounded = snapshot.summary.length > HISTORY_SUMMARY_LIMITS.maxIndexedSummaryChars
          ? snapshot.summary.slice(0, HISTORY_SUMMARY_LIMITS.maxIndexedSummaryChars)
          : snapshot.summary;
        const bodyBounded = clampUtf8(charBounded, HISTORY_SUMMARY_LIMITS.maxSummaryBodyBytes);
        const titleSource = snapshot.title === null
          ? ""
          : snapshot.title.slice(0, HISTORY_SUMMARY_LIMITS.maxIndexedTitleChars);
        const titleBounded = clampUtf8(titleSource, HISTORY_SUMMARY_LIMITS.maxSummaryTitleBytes);
        const body = bodyBounded.text;
        const title = titleBounded.text;
        const truncated = snapshot.summaryTruncated
          || charBounded.length < snapshot.summary.length
          || bodyBounded.truncated
          || titleBounded.truncated;
        const bodyBytes = Buffer.byteLength(body, "utf8");
        const fingerprint = summaryFingerprint({
          startEntryId: snapshot.startEntryId,
          endEntryId: snapshot.endEntryId,
          resetEntryId: snapshot.resetEntryId,
          summarizerVersion: snapshot.summarizerVersion,
          title,
          body,
          bodyBytes,
          truncated,
          completedAtMs: snapshot.completedAtMs,
          sourceEntries: snapshot.sourceEntries,
          sourceMessages: snapshot.sourceMessages,
          sourceToolResults: snapshot.sourceToolResults,
          sourceTruncatedEntries: snapshot.sourceTruncatedEntries,
          coverageComplete: snapshot.coverageComplete,
        });
        const written = await writeSummary(open.db, session.conversationId, {
          startEntryId: snapshot.startEntryId,
          endEntryId: snapshot.endEntryId,
          resetEntryId: snapshot.resetEntryId,
          summarizerVersion: snapshot.summarizerVersion,
          title,
          body,
          bodyBytes,
          truncated,
          completedAtMs: snapshot.completedAtMs,
          sourceEntries: snapshot.sourceEntries,
          sourceMessages: snapshot.sourceMessages,
          sourceToolResults: snapshot.sourceToolResults,
          sourceTruncatedEntries: snapshot.sourceTruncatedEntries,
          coverageComplete: snapshot.coverageComplete,
          fingerprint,
        }, now());
        if (written === "omitted") base.summariesOmitted++;
        else if (written === "omitted-removed") {
          base.summariesOmitted++;
          base.summariesRemoved++;
        } else base.summariesReady++;
        if (truncated) base.summariesTruncated++;
      } else {
        // Any non-ready state, including a read failure, removes the derived row. A retained row
        // would be stale evidence presented as current; the next successful pass re-adds it.
        if (await removeSummary(open.db, session.conversationId, episodeStart)) base.summariesRemoved++;
        if (view.state === "not-ready") base.summariesNotReady++;
        else if (view.state === "missing") base.summariesMissing++;
        else if (view.state === "unreadable") base.summariesUnreadable++;
        else base.summariesMalformed++;
      }
    }
    // Advance the round-robin cursor only when the whole selected page was checked, even when more
    // older episodes remain. A pass that stopped at its budget leaves the cursor where it was.
    if (processedAll) {
      await writeSummarySweep(open.db, session.conversationId, candidates.nextBefore, now());
    }
    if (checkedHere < known) sessionsPending++;
    lastProcessed = session.conversationId as number;
  }
  if (lastProcessed !== null) await writeSummarySessionCursor(open.db, lastProcessed);
  return {
    ...base,
    episodesKnown,
    episodesChecked,
    sessionsSwept,
    sessionsPending,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

async function summarySnapshotId(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = await db.get<{ snapshot: number | null }>(
    `SELECT MAX(summary_id) AS snapshot FROM history_summaries
      WHERE conversation_id IN (${placeholders})`,
    ...conversationIds,
  );
  return row?.snapshot ?? 0;
}

/**
 * Snapshot membership proof for pagination. Every content change deletes and reinserts the row, so
 * `summary_id` only grows: a row at or below the watermark can never be updated in place. The count
 * of rows at or below the watermark therefore changes on any deletion or replacement, and rows above
 * it are newer summaries that this snapshot deliberately excludes (reported, never implied absent).
 */
async function summarySnapshotCounts(
  db: NodeSqliteDatabase,
  conversationIds: readonly number[],
  snapshotSummaryId: number,
): Promise<{ rows: number; newer: number }> {
  if (conversationIds.length === 0) return { rows: 0, newer: 0 };
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = await db.get<{ rows: number; newer: number }>(
    `SELECT COALESCE(SUM(CASE WHEN summary_id <= ? THEN 1 ELSE 0 END), 0) AS rows,
            COALESCE(SUM(CASE WHEN summary_id > ? THEN 1 ELSE 0 END), 0) AS newer
       FROM history_summaries WHERE conversation_id IN (${placeholders})`,
    snapshotSummaryId,
    snapshotSummaryId,
    ...conversationIds,
  );
  return { rows: row?.rows ?? 0, newer: row?.newer ?? 0 };
}

async function verifySummaryCursor(
  db: NodeSqliteDatabase,
  cursor: HistorySummaryCursor,
  conversationIds: readonly number[],
): Promise<void> {
  if (conversationIds.length === 0) {
    throw new Error("History summary cursor does not belong to the current mapped sessions");
  }
  const placeholders = conversationIds.map(() => "?").join(",");
  const row = await db.get<SummaryCursorProofRow>(
    `SELECT summary_id, conversation_id, start_entry_id, fingerprint FROM history_summaries
      WHERE summary_id = ? AND conversation_id IN (${placeholders}) LIMIT 1`,
    cursor.lastSummaryId,
    ...conversationIds,
  );
  if (row === undefined
    || row.summary_id !== cursor.lastSummaryId
    || row.start_entry_id !== cursor.lastStartEntryId
    || row.conversation_id !== cursor.lastConversationId
    || row.fingerprint !== cursor.lastFingerprint) {
    throw new Error("History summary cursor no longer matches the derived index; start a fresh summary search");
  }
  const stats = await summarySnapshotCounts(db, conversationIds, cursor.snapshotSummaryId);
  if (stats.rows !== cursor.snapshotRows) {
    throw new Error(
      "History summary cursor snapshot changed: a summary was replaced or removed after this page's "
      + "first page. Start a fresh summary search instead of continuing.",
    );
  }
}

async function querySummaries(
  db: NodeSqliteDatabase,
  query: ParsedSummaryQuery,
  conversationIds: readonly number[],
  snapshotSummaryId: number,
  cursor: HistorySummaryCursor | undefined,
): Promise<SummaryRow[]> {
  const conversationPlaceholders = conversationIds.map(() => "?").join(",");
  const keyset = cursor === undefined
    ? ""
    : "AND (s.start_entry_id < ? OR (s.start_entry_id = ? AND s.conversation_id < ?))";
  const filter = `
      AND s.conversation_id IN (${conversationPlaceholders})
      AND s.summary_id <= ?
      ${keyset}`;
  // Placeholder order follows the SQL: conversation IDs, then the snapshot watermark, then the keyset.
  const seat = [
    ...conversationIds,
    snapshotSummaryId,
    ...(cursor === undefined
      ? []
      : [cursor.lastStartEntryId, cursor.lastStartEntryId, cursor.lastConversationId]),
    query.limit + 1,
  ];
  const columns = `
    s.summary_id, s.conversation_id, s.start_entry_id, s.end_entry_id, s.reset_entry_id,
    s.summarizer_version, s.title, s.body_length, s.truncated, s.completed_at_ms,
    s.source_entries, s.source_messages, s.source_tool_results, s.source_truncated_entries,
    s.coverage_complete, s.fingerprint`;
  if (query.browsing) {
    return db.all<SummaryRow>(
      `SELECT ${columns}, substr(s.body, 1, ?) AS excerpt
         FROM history_summaries s
        WHERE 1 = 1${filter}
        ORDER BY s.start_entry_id DESC, s.conversation_id DESC
        LIMIT ?`,
      HISTORY_SUMMARY_LIMITS.excerptChars,
      ...seat,
    );
  }
  const lastTerm = query.terms.length - 1;
  const match = query.terms.map((term, index) => {
    const quoted = `"${term.replaceAll('"', '""')}"`;
    return index === lastTerm ? `${quoted}*` : quoted;
  }).join(" ");
  return db.all<SummaryRow>(
    `SELECT ${columns}, snippet(history_summary_fts, 1, '[', ']', '…', ?) AS excerpt
       FROM history_summary_fts
       JOIN history_summaries s ON s.summary_id = history_summary_fts.rowid
      WHERE history_summary_fts MATCH ?${filter}
      ORDER BY s.start_entry_id DESC, s.conversation_id DESC
      LIMIT ?`,
    HISTORY_SUMMARY_LIMITS.snippetTokens,
    match,
    ...seat,
  );
}

/**
 * One summary discovery page. Schema shape and FTS5 integrity are verified once per open (see
 * `ensureSummaryIndex`), not on every page. A summary SQL failure re-verifies and repairs the layer
 * once and retries the page; only a failed repair or a second failure reports it unavailable, and
 * raw message/tool search is never affected.
 */
export async function searchSummaryIndex(
  queryInput: unknown,
  options: HistoryIndexOptions,
  ensureOpen: (storeId: string) => Promise<OpenHistoryIndex>,
  context: Context,
): Promise<HistorySummaryPage> {
  const query = readSummaryQuery(queryInput);
  const { sessions, conversationIds, mappingSha256 } = await loadSessions(options, context);
  const sourceWired = options.readSummary !== undefined;
  if (sessions.length === 0) {
    if (query.cursor !== undefined) {
      throw new Error("History summary cursor does not belong to the current mapped sessions");
    }
    const emptySync: HistorySummarySyncReport = {
      caughtUp: true,
      episodesKnown: 0,
      episodesChecked: 0,
      summariesReady: 0,
      summariesNotReady: 0,
      summariesMissing: 0,
      summariesMalformed: 0,
      summariesUnreadable: 0,
      summariesRemoved: 0,
      summariesTruncated: 0,
      summariesOmitted: 0,
      sessionsSwept: 0,
      sessionsPending: 0,
      readLimit: HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass,
      byteLimit: HISTORY_SUMMARY_LIMITS.maxIndexedSummaryBytes,
      elapsedMs: 0,
      timeLimitMs: HISTORY_SUMMARY_LIMITS.maxSummaryPassMs,
      available: sourceWired,
      indexReady: true,
    };
    return {
      hits: [],
      coverage: {
        sessions: 0,
        sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
        chatSessions: 0,
        summariesIndexed: 0,
        episodesKnown: 0,
        complete: sourceWired,
        available: sourceWired,
        indexReady: true,
        snapshotCurrent: true,
        summariesAfterSnapshot: 0,
        indexBytes: 0,
        indexFull: false,
        sync: emptySync,
      },
    };
  }

  const storeId = await resolveStoreId(options.storeId, context);
  const open = await ensureOpen(storeId);
  const indexReady = sourceWired ? await ensureSummaryIndex(open) : open.summaryReady;
  const available = sourceWired && indexReady;
  if (query.cursor !== undefined && !available) {
    throw new Error(
      "History summary cursor is unavailable because the summary index is not usable in this open; "
      + "start a fresh summary search",
    );
  }
  if (query.cursor !== undefined) {
    if (query.cursor.generation !== open.generation) {
      throw new Error("History summary cursor belongs to a replaced derived index");
    }
    if (query.cursor.querySha256 !== query.querySha256) {
      throw new Error("History summary cursor does not match the requested query");
    }
    if (query.cursor.mappingSha256 !== mappingSha256) {
      throw new Error("History summary cursor does not match the current session mapping");
    }
    await verifySummaryCursor(open.db, query.cursor, conversationIds);
  }

  // Episode boundaries come from the same bounded message reconciliation raw search uses, so
  // summary discovery never invents a boundary and a large message backlog stays bounded.
  const reconciliation = await reconcileSessions(open, options, sessions, context);
  await secureIndexFiles(options.indexPath);
  const activeConversationIds = await indexedConversationIds(open.db, conversationIds);
  const activeSet = new Set(activeConversationIds);
  const activeSessions = sessions.filter((session) => activeSet.has(session.conversationId as number));
  if (activeConversationIds.length === 0 && query.cursor !== undefined) {
    throw new Error("History summary cursor does not belong to the current indexed chat sessions");
  }

  const summaryPage = async (): Promise<HistorySummaryPage> => {
    const sweep = await sweepSummaries(open, options, activeSessions, context);
    const counts = available
      ? await summaryCounts(open.db, activeConversationIds)
      : { summaries: 0, truncated: 0, bytes: 0 };
    // Completeness is per-pass and conservative: every known closed episode was re-read in this
    // pass, no session was left partially checked, and no stored or indexed text is degraded.
    // A bounded sweep therefore never claims complete coverage or complete absence.
    const complete = available
      && reconciliation.caughtUp
      && sweep.episodesChecked >= sweep.episodesKnown
      && sweep.sessionsPending === 0
      && sweep.summariesUnreadable === 0
      && sweep.summariesMalformed === 0
      && sweep.summariesTruncated === 0
      && sweep.summariesOmitted === 0
      && counts.truncated === 0;

    const snapshotSummaryId = !available
      ? 0
      : query.cursor?.snapshotSummaryId ?? await summarySnapshotId(open.db, activeConversationIds);
    let snapshotStats = { rows: 0, newer: 0 };
    if (snapshotSummaryId > 0) {
      snapshotStats = await summarySnapshotCounts(open.db, activeConversationIds, snapshotSummaryId);
    }
    if (query.cursor !== undefined && snapshotStats.rows !== query.cursor.snapshotRows) {
      throw new Error(
        "History summary cursor snapshot changed: a summary was replaced or removed after this page's "
        + "first page. Start a fresh summary search instead of continuing; the continuation cannot "
        + "silently omit older matching summaries.",
      );
    }
    const coverage: HistorySummaryCoverage = {
      sessions: sessions.length,
      sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
      chatSessions: activeSessions.length,
      summariesIndexed: counts.summaries,
      episodesKnown: sweep.episodesKnown,
      complete,
      available,
      indexReady,
      snapshotCurrent: snapshotStats.newer === 0,
      summariesAfterSnapshot: snapshotStats.newer,
      indexBytes: counts.bytes,
      indexFull: counts.bytes >= HISTORY_SUMMARY_LIMITS.maxIndexedSummaryBytes,
      sync: {
        ...sweep,
        caughtUp: reconciliation.caughtUp,
        episodesKnown: sweep.episodesKnown,
        elapsedMs: sweep.elapsedMs + reconciliation.elapsedMs,
      },
    };
    if (!available || snapshotSummaryId === 0) return { hits: [], coverage };

    const rows = await querySummaries(open.db, query, activeConversationIds, snapshotSummaryId, query.cursor);
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const sessionsById = new Map(activeSessions.map((session) => [session.conversationId as number, session.sessionKey]));
    const hits: HistorySummaryHit[] = visible.map((row) => {
      const sessionKey = sessionsById.get(row.conversation_id);
      if (sessionKey === undefined) throw new Error("History summary index returned an unmapped conversation");
      return {
        conversationId: row.conversation_id as ConversationId,
        sessionKey,
        startEntryId: row.start_entry_id as EntryId,
        endEntryId: row.end_entry_id as EntryId,
        resetEntryId: row.reset_entry_id === null ? null : row.reset_entry_id as EntryId,
        summarizerVersion: row.summarizer_version,
        title: row.title.length === 0 ? null : row.title,
        excerpt: row.excerpt,
        excerptTruncated: row.body_length > row.excerpt.length,
        summaryLength: row.body_length,
        completedAtMs: row.completed_at_ms,
        sourceEntries: row.source_entries,
        sourceMessages: row.source_messages,
        sourceToolResults: row.source_tool_results,
        sourceTruncatedEntries: row.source_truncated_entries,
        coverageComplete: row.coverage_complete === 1,
        summaryTruncated: row.truncated === 1,
      };
    });
    let next: HistorySummaryCursor | undefined;
    if (hasMore) {
      const lastRow = visible[visible.length - 1];
      if (lastRow === undefined) throw new Error("History summary page lost its last row");
      next = {
        version: 1,
        querySha256: query.querySha256,
        generation: open.generation,
        mappingSha256,
        snapshotSummaryId,
        snapshotRows: snapshotStats.rows,
        lastSummaryId: lastRow.summary_id,
        lastStartEntryId: lastRow.start_entry_id,
        lastConversationId: lastRow.conversation_id,
        lastFingerprint: lastRow.fingerprint,
      };
    }
    return {
      hits,
      ...(next === undefined ? {} : { next }),
      coverage,
    };
  };
  const contractFailure = (error: unknown): Error | undefined => {
    if (context.abortSignal?.aborted) return new Error("Operation aborted");
    // Cursor/snapshot errors are explicit contract failures, not index unavailability.
    if (error instanceof Error && /cursor|snapshot changed/i.test(error.message)) return error;
    return undefined;
  };

  try {
    return await summaryPage();
  } catch (error) {
    const failure = contractFailure(error);
    if (failure !== undefined) throw failure;
  }
  // A summary SQL failure may be corruption the open-time check could not see. Re-verify and repair
  // the summary layer once, then retry this page.
  if (available) {
    open.summaryVerified = false;
    if (await ensureSummaryIndex(open)) {
      try {
        return await summaryPage();
      } catch (error) {
        const failure = contractFailure(error);
        if (failure !== undefined) throw failure;
      }
    }
  }
  // A summary-specific SQL failure must never turn into a raw-search failure. Mark this open's
  // summary layer unavailable; the next open retries schema verification and repair.
  open.summaryReady = false;
  const unavailableSync: HistorySummarySyncReport = {
    caughtUp: reconciliation.caughtUp,
    episodesKnown: 0,
    episodesChecked: 0,
    summariesReady: 0,
    summariesNotReady: 0,
    summariesMissing: 0,
    summariesMalformed: 0,
    summariesUnreadable: 0,
    summariesRemoved: 0,
    summariesTruncated: 0,
    summariesOmitted: 0,
    sessionsSwept: 0,
    sessionsPending: activeSessions.length,
    readLimit: HISTORY_SUMMARY_LIMITS.maxSummaryReadsPerPass,
    byteLimit: HISTORY_SUMMARY_LIMITS.maxIndexedSummaryBytes,
    elapsedMs: 0,
    timeLimitMs: HISTORY_SUMMARY_LIMITS.maxSummaryPassMs,
    available: false,
    indexReady: false,
  };
  return {
    hits: [],
    coverage: {
      sessions: sessions.length,
      sessionLimit: HISTORY_INDEX_LIMITS.maxMappedSessions,
      chatSessions: activeSessions.length,
      summariesIndexed: 0,
      episodesKnown: 0,
      complete: false,
      available: false,
      indexReady: false,
      snapshotCurrent: true,
      summariesAfterSnapshot: 0,
      indexBytes: 0,
      indexFull: false,
      sync: unavailableSync,
    },
  };
}
