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
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
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
  type Tx,
} from "@earendil-works/pi-durable";
import {
  openNodeSqliteDatabase,
  type NodeSqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { canonicalFuturePath } from "../store.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "./scope.js";
import {
  boundedCanonicalJson as boundedJson,
  isRecord,
  isUserInputKind,
  messageText,
} from "./transcript.js";
import {
  HISTORY_SUMMARY_READ_LIMITS,
  type HistorySummaryView,
} from "./summary-view.js";

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

export type HistoryScope = "messages" | "tools" | "all";
export type HistoryRole = "user" | "assistant";

/** A currently mapped session, already authenticated and classified by the host. */
export interface HistorySession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

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
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
function clampUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
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

async function createMessageSchema(db: NodeSqliteDatabase): Promise<void> {
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

async function createSummarySchema(db: NodeSqliteDatabase): Promise<void> {
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

async function dropSummarySchema(db: NodeSqliteDatabase): Promise<void> {
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
 * Verify the summary schema shape and FTS integrity before every summary page. A missing/wrong table,
 * missing trigger or logical FTS drift is repaired from the stored content; if repair fails the
 * summary index is reported unavailable and raw message/tool search continues to work. The integrity
 * check is bounded by the 64 MiB whole-index budget (it is derived data, not the transcript).
 */
async function ensureSummaryIndex(open: OpenHistoryIndex): Promise<boolean> {
  if (!open.summaryReady) return false;
  try {
    const state = await summarySchemaState(open.db);
    if (!state.objectsOk || !state.contentOk || !state.sweepOk) {
      open.summaryReady = await repairSummarySchema(open, state);
      return open.summaryReady;
    }
    try {
      // FTS5 external-content integrity check: compares the index with history_summaries.
      await open.db.run(
        "INSERT INTO history_summary_fts (history_summary_fts, rank) VALUES ('integrity-check', 1)",
      );
    } catch {
      open.summaryReady = await repairSummarySchema(open, state);
    }
    return open.summaryReady;
  } catch {
    open.summaryReady = false;
    return false;
  }
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


async function resolveStoreId(
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

interface OpenHistoryIndex {
  readonly db: NodeSqliteDatabase;
  generation: string;
  storeId: string;
  /** False when the summary tables could not be created or repaired; message search still works. */
  summaryReady: boolean;
}

/** Keep the derived index bound to the caller-owned store identity. */
async function reconcileStoreId(open: OpenHistoryIndex, storeId: string): Promise<void> {
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
async function prepareIndexFile(indexPath: string, sourcePath: string | undefined): Promise<void> {
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
async function secureIndexFiles(indexPath: string): Promise<void> {
  if (indexPath === ":memory:") return;
  for (const target of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    try {
      await chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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

async function readProgress(db: NodeSqliteDatabase, conversationId: ConversationId): Promise<ConversationProgress | undefined> {
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

async function indexedConversationIds(
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

interface LoadedSessions {
  readonly sessions: readonly HistorySession[];
  readonly conversationIds: readonly number[];
  readonly mappingSha256: string;
}

/** Validate the host's mapped chat sessions and hash the mapping a cursor is bound to. */
async function loadSessions(
  options: HistoryIndexOptions,
  context: Context,
): Promise<LoadedSessions> {
  const sessions = await options.sessions(context);
  const seenSessions = new Set<number>();
  for (const session of sessions) {
    if (typeof session.sessionKey !== "string" || session.sessionKey.length === 0) {
      throw new TypeError("History session keys must be non-empty strings");
    }
    if (session.sessionKey.endsWith(CHANNEL_STATE_SESSION_SUFFIX)) {
      throw new TypeError("History search does not accept channel-state sessions");
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
  return {
    sessions,
    conversationIds,
    mappingSha256: sha256(JSON.stringify([...conversationIds].sort((left, right) => left - right))),
  };
}

interface ReconcileResult {
  readonly budget: SyncBudget;
  readonly caughtUp: boolean;
  readonly elapsedMs: number;
}

/** One bounded message/tool reconciliation pass over every mapped chat session. */
async function reconcileSessions(
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
  let tail: Promise<unknown> = Promise.resolve();

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
      });
    },
    searchSummaries(queryInput, context) {
      return serialized(async () => {
        if (closed) throw new Error("History index is closed");
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

        try {
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
        } catch (error) {
          if (context.abortSignal?.aborted) throw new Error("Operation aborted");
          // Cursor/snapshot errors are explicit contract failures, not index unavailability.
          if (error instanceof Error && /cursor|snapshot changed/i.test(error.message)) throw error;
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
