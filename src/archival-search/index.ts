/**
 * Bounded, asynchronous browsing/search over the archival entries persisted by
 * `src/archival-persist/index.ts`. This is a read-only projection over the
 * session-scoped import ledger and each source's ownerless Durable carrier
 * conversation. It never writes storage, opens paths, calls the network, reads
 * model payloads, creates tasks/submissions, advances an archive cursor, or
 * resumes/replays a Python session.
 *
 * Pages are ordered by ledger source order and then by Durable entry ID. Search
 * only matches the prepared text-only `search[]` units. An entry may span many
 * pages; units are validated incrementally and resumed at a unit boundary, so a
 * large history record is never excluded merely because it exceeds one page's
 * unit work bound. Raw lines (including provider state, headers, and quarantine
 * bytes) are never returned.
 *
 * Durable `scanEntries` materializes the whole requested EntryRecord, including
 * raw line data and any model/head/edits/foreign payload. This module ignores
 * those fields but cannot byte-bound them; `scanBatchSize`/`maxScanEntries`
 * bound entry count only. Legitimate carriers are bounded per source by the
 * persistence writer, while a corrupt foreign entry is not.
 *
 * Reconciliation is forward-looking only: an already-scanned record is not
 * re-read, so changing/deleting it later is not detected. The host must keep an
 * exclusive single-writer stable carrier snapshot for the continuation chain.
 * An in-flight entry is re-hashed at every resumed page, so that cost scales
 * with the entry's unit data.
 *
 * The caller must already hold exclusive single-writer ownership of the
 * Session/storage, normally the same Gateway process lock. Continuations are
 * host-trusted, unsigned state: they are not authorization and not tamper-proof.
 */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  EntryId,
  EntryQuery,
  EntryRecord,
  Session,
} from "@earendil-works/pi-durable";
import type {
  ArchivalRecordCategory,
  ArchivalSearchUnitKind,
} from "../archival-import/index.js";
import {
  ARCHIVAL_PERSISTENCE_OWNERSHIP,
  ARCHIVAL_RECORD_ENTRY_KIND,
  ARCHIVAL_RECORD_SCHEMA,
  ARCHIVAL_RECORD_SCHEMA_VERSION,
  ArchivalRecordEntry,
  readArchivalImportLedger,
  type ArchivalLedgerSource,
} from "../archival-persist/index.js";

export const ARCHIVAL_SEARCH_FORMAT = "nanobot-archival-search" as const;
export const ARCHIVAL_SEARCH_VERSION = 1 as const;
export const ARCHIVAL_SEARCH_DISPOSITION = "archive-only-never-resume-or-replay" as const;
/** Scan order: ledger source order, then ascending Durable entry ID within the carrier. */
export const ARCHIVAL_SEARCH_ORDER = "ledger-source-order-then-durable-entry-id-ascending" as const;
/** Continuations are for trusted host state; this module proves no integrity or identity. */
export const ARCHIVAL_SEARCH_CONTINUATION_TRUST = "host-trusted-not-authenticated" as const;

/** Defaults keep one page reviewable and one carrier page bounded. */
export const ARCHIVAL_SEARCH_LIMITS = Object.freeze({
  maxSources: 16,
  maxScanEntries: 500,
  maxScanUnits: 10_000,
  maxHits: 20,
  maxOutputChars: 24_000,
  maxSnippetChars: 240,
  maxQueryChars: 200,
  scanBatchSize: 25,
});

const HARD_LIMITS = Object.freeze({
  maxSources: 128,
  maxScanEntries: 10_000,
  maxScanUnits: 100_000,
  maxHits: 200,
  maxOutputChars: 200_000,
  maxSnippetChars: 2_000,
  maxQueryChars: 1_000,
  scanBatchSize: 200,
});

/** A page envelope (query/coverage/continuation/limitations) must fit before any hit. */
const MIN_OUTPUT_CHARS = 5_120;
/** Matches the persistence hard cap; a larger or tampered ledger is rejected here. */
const MAX_LEDGER_SOURCES = 1_024;
const MAX_SCOPE_SOURCES = 128;
const MAX_SESSION_KEY_CHARS = 1_024;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_ROLE_CHARS = 64;
const MAX_NAME_CHARS = 512;
const MAX_ARCHIVED_ENTRY_ID_CHARS = 512;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ArchivalSearchLimits {
  /** Ledger source rows considered per page. */
  readonly maxSources: number;
  /** Durable entries examined per page (a resumed entry counts once). */
  readonly maxScanEntries: number;
  /** Prepared search units examined per page; an entry is resumed at a unit boundary. */
  readonly maxScanUnits: number;
  /** Hits returned per page. */
  readonly maxHits: number;
  /** `JSON.stringify(page).length` bound in JavaScript UTF-16 code units. */
  readonly maxOutputChars: number;
  /** Snippet bound in JavaScript UTF-16 code units, adjusted not to split a surrogate pair. */
  readonly maxSnippetChars: number;
  readonly maxQueryChars: number;
  /** Maximum entries requested from one Durable scan. Capped by remaining work. */
  readonly scanBatchSize: number;
}

export interface ArchivalSearchQuery {
  /** Literal substring, not a regular expression. Case-insensitive by default. */
  readonly text: string;
  readonly caseSensitive?: boolean;
  /** Optional exact source scope; duplicates are ignored. */
  readonly sourceIds?: readonly string[];
  /** Optional exact role filter on the unit role, falling back to the record role. */
  readonly role?: string;
}

export interface ArchivalSearchOptions {
  readonly limits?: Partial<ArchivalSearchLimits>;
  /** Host-trusted continuation from the previous page; null/undefined starts at the beginning. */
  readonly continuation?: ArchivalSearchContinuation | null;
}

export type ArchivalSearchStopReason =
  | "complete"
  | "no-ledger"
  | "max-sources"
  | "max-entries"
  | "max-units"
  | "max-hits"
  | "max-output-chars";

export interface ArchivalSearchCoverageCounters {
  readonly sourcesConsidered: number;
  readonly sourcesFullyScanned: number;
  readonly sourcesClean: number;
  readonly sourcesWithCaveats: number;
  readonly sourcesUnsupported: number;
  readonly sourcesUnavailable: number;
  readonly sourcesLedgerMismatch: number;
  readonly sourcesDuplicateOrOutOfOrder: number;
  readonly sourcesIdentityMismatch: number;
  readonly entriesScanned: number;
  readonly entriesSearchable: number;
  readonly entriesSearchablePartial: number;
  readonly entriesNoSearchText: number;
  readonly entriesOpaque: number;
  readonly entriesQuarantined: number;
  readonly entriesUnsearchable: number;
  readonly unitsScanned: number;
  readonly unitsInvalid: number;
  readonly hits: number;
}

export interface ArchivalSearchCoverage extends ArchivalSearchCoverageCounters {
  readonly ledgerPresent: boolean;
  readonly ledgerSourceCount: number;
  readonly sourcesInScope: number;
  readonly sourcesScopeExcluded: number;
  readonly sourcesNotYetScanned: number;
  readonly scanComplete: boolean;
  /** Strict: every in-scope carrier was fully scanned and every entry was fully searchable. */
  readonly coverageComplete: boolean;
  /** Unsupported/never-persisted sources have no ledger row and are invisible here. */
  readonly ledgerOnlyCoverage: true;
  readonly unsupportedSourcesOutsideLedger: true;
}

export interface ArchivalSearchSourceObservation {
  /** Archival-kind carrier entries observed, including malformed ones. */
  readonly recordsObserved: number;
  /** Sum of prepared unit slots across valid archival entries. */
  readonly unitsObserved: number;
  /** Sum of prepared physical line byte lengths across valid archival entries. */
  readonly bytesObserved: number;
  /** Non-archival entries observed in the carrier (should be zero). */
  readonly foreignEntriesObserved: number;
  readonly firstEntryIdObserved: number | null;
  readonly lastEntryIdObserved: number | null;
  readonly firstLineObserved: number | null;
  readonly lastLineObserved: number | null;
  readonly previousLineObserved: number | null;
  /** False for duplicate/out-of-order lines or a line that does not start at the ledger first line. */
  readonly lineSequenceValid: boolean;
  readonly malformedArchival: boolean;
  readonly identityMismatch: boolean;
}

export interface ArchivalSearchCurrentEntry {
  readonly line: number;
  readonly durableKey: string;
  readonly unitCount: number;
  /** Digest over the in-flight entry ID, line, key, status, and full unit list. */
  readonly fingerprint: string;
}

export interface ArchivalSearchContinuation {
  readonly format: typeof ARCHIVAL_SEARCH_FORMAT;
  readonly version: typeof ARCHIVAL_SEARCH_VERSION;
  readonly querySha256: string;
  readonly storeNamespace: string;
  /** Digest over every relevant ledger row, including preparation status/counts. */
  readonly ledgerSha256: string;
  readonly ledgerSourceCount: number;
  readonly sourceIndex: number;
  readonly sourceId: string;
  readonly conversationId: number | null;
  /** Next Durable entry ID to read, or null when starting at the source's first entry. */
  readonly nextEntryId: number | null;
  /** Unit index within `nextEntryId`; non-zero means the entry was already classified. */
  readonly nextUnit: number;
  /** Whether the current entry's metadata was already classified and counted. */
  readonly currentEntryClassified: boolean;
  /** Whether this entry has already yielded a valid non-empty searchable unit. */
  readonly currentEntryHasSearchableUnit: boolean;
  /** Whether this entry has already yielded a valid unit, even an empty-text one. */
  readonly currentEntryHasValidUnit: boolean;
  /** In-flight entry identity, or null when no entry is partially scanned. */
  readonly currentEntry: ArchivalSearchCurrentEntry | null;
  /** Bounded per-source observation used to reconcile the carrier with the ledger. */
  readonly sourceObservation: ArchivalSearchSourceObservation;
  readonly currentSourceHasCaveat: boolean;
  readonly coverage: ArchivalSearchCoverageCounters;
}

export interface ArchivalSearchHit {
  readonly disposition: typeof ARCHIVAL_SEARCH_DISPOSITION;
  readonly sourceId: string;
  readonly sourceFormat: string;
  readonly sourceProvenance: string;
  readonly sourceSha256: string;
  /** Stable line identity within (storeNamespace, sourceId, line). */
  readonly durableKey: string;
  /** Durable carrier entry ID that holds this line. */
  readonly durableEntryId: number;
  readonly line: number;
  readonly preparationOrdinal: number;
  readonly preparationSourceOrder: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly lineTerminated: boolean;
  readonly lineSha256: string;
  readonly category: ArchivalRecordCategory;
  readonly searchStatus: "complete" | "partial";
  /** True when the prepared projection was partial; not a snippet-truncation flag. */
  readonly textOmitted: boolean;
  readonly sessionKey: string | null;
  readonly role: string | null;
  readonly timestamp: string | null;
  readonly unitIndex: number;
  readonly unitKind: ArchivalSearchUnitKind;
  readonly unitName: string | null;
  readonly archivedEntryId: string | null;
  /** Non-overlapping literal occurrences in the unit text. */
  readonly matchCount: number;
  readonly snippet: string;
  /** JavaScript UTF-16 code-unit offset of `snippet` in the unit text. */
  readonly snippetOffset: number;
  /** JavaScript UTF-16 code-unit offset of the first match in the unit text. */
  readonly matchOffset: number;
  /** Actual matched length in code units; may differ from the query under case folding. */
  readonly matchLength: number;
  readonly matchTruncated: boolean;
  readonly snippetTruncated: boolean;
}

export interface ArchivalSearchPage {
  readonly format: typeof ARCHIVAL_SEARCH_FORMAT;
  readonly version: typeof ARCHIVAL_SEARCH_VERSION;
  readonly disposition: typeof ARCHIVAL_SEARCH_DISPOSITION;
  readonly order: typeof ARCHIVAL_SEARCH_ORDER;
  readonly continuationTrust: typeof ARCHIVAL_SEARCH_CONTINUATION_TRUST;
  readonly ownershipRequirement: typeof ARCHIVAL_PERSISTENCE_OWNERSHIP;
  readonly storeNamespace: string | null;
  readonly query: Readonly<{
    readonly text: string;
    readonly caseSensitive: boolean;
    readonly role: string | null;
    readonly sourceCount: number;
    readonly querySha256: string;
  }>;
  readonly ledger: Readonly<{
    readonly present: boolean;
    readonly sourceCount: number;
  }>;
  readonly limits: ArchivalSearchLimits;
  readonly hits: readonly ArchivalSearchHit[];
  readonly coverage: ArchivalSearchCoverage;
  readonly progress: Readonly<{
    readonly sourcesConsideredThisPage: number;
    readonly entriesScannedThisPage: number;
    readonly unitsScannedThisPage: number;
    readonly hitsThisPage: number;
    readonly nextSourceId: string | null;
    readonly nextEntryId: number | null;
    readonly nextUnit: number | null;
  }>;
  readonly stopReason: ArchivalSearchStopReason;
  readonly scanComplete: boolean;
  readonly continuation: ArchivalSearchContinuation | null;
  readonly limitations: readonly string[];
}

export class ArchivalSearchBoundsError extends RangeError {
  readonly code = "archival_search_bound_exceeded";

  constructor(bound: string) {
    super(`Archival search exceeds the ${bound} bound`);
    this.name = "ArchivalSearchBoundsError";
  }
}

export class ArchivalSearchInputError extends TypeError {
  readonly code: string = "archival_search_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalSearchInputError";
  }
}

export class ArchivalSearchContinuationError extends ArchivalSearchInputError {
  override readonly code: string = "archival_search_continuation_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalSearchContinuationError";
  }
}

export class ArchivalSearchCorruptionError extends Error {
  readonly code = "archival_search_store_corruption";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalSearchCorruptionError";
  }
}

const LIMITATIONS: readonly string[] = Object.freeze([
  "Host owns exclusive single-writer storage; continuations are host-trusted and unsigned, not authorization.",
  "Only ledgered sources are searchable; unsupported or never-persisted sources are invisible.",
  "Sequential bounded scan, not an index; the ledger and coverage limits apply.",
  "Snippets and metadata are private; no redaction, retention, or authorization policy is applied.",
]);

const CATEGORIES = new Set<ArchivalRecordCategory>([
  "session-header",
  "session-message",
  "provider-state",
  "archive-header",
  "archive-message",
  "history-entry",
  "blank-line",
  "quarantined-line",
]);
const SEARCHABLE_CATEGORIES = new Set<ArchivalRecordCategory>([
  "session-message",
  "archive-message",
  "history-entry",
]);
const SEARCH_STATUSES = new Set(["complete", "partial", "none"]);
const UNIT_KINDS = new Set<ArchivalSearchUnitKind>([
  "session-message",
  "archive-message",
  "history-message",
  "history-content",
  "history-summary",
]);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableCoverage = Mutable<ArchivalSearchCoverageCounters>;
type MutableLimits = Mutable<ArchivalSearchLimits>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readInput<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ArchivalSearchBoundsError || error instanceof ArchivalSearchInputError) throw error;
    throw new ArchivalSearchInputError(message);
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nullableString(value: unknown, maxChars: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxChars) return undefined;
  return value;
}

function normalizedLimits(input: unknown): ArchivalSearchLimits {
  const result: MutableLimits = { ...ARCHIVAL_SEARCH_LIMITS };
  if (input === undefined) return result;
  if (!isRecord(input)) throw new ArchivalSearchInputError("Archival search limits must be an object");
  const keys = readInput(() => Object.keys(input), "Archival search limits are unreadable");
  for (const key of keys) {
    if (!Object.hasOwn(ARCHIVAL_SEARCH_LIMITS, key)) {
      throw new ArchivalSearchInputError("Unknown archival search limit property");
    }
  }
  for (const key of Object.keys(ARCHIVAL_SEARCH_LIMITS) as (keyof ArchivalSearchLimits)[]) {
    if (!readInput(() => Object.hasOwn(input, key), "Archival search limits are unreadable")) continue;
    const value = readInput(() => input[key], "Archival search limits are unreadable");
    if (value === undefined) continue;
    if (!isSafePositiveInteger(value) || value > HARD_LIMITS[key]) {
      throw new ArchivalSearchInputError(`Invalid archival search bound: ${key}`);
    }
    result[key] = value;
  }
  if (result.maxOutputChars < MIN_OUTPUT_CHARS) {
    throw new ArchivalSearchInputError("Archival search output bound must be at least 5120 characters");
  }
  return result;
}

interface NormalizedQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly role: string | null;
  readonly sourceIds: readonly string[] | null;
  readonly sourceIdSet: ReadonlySet<string> | null;
  readonly querySha256: string;
}

function normalizedQuery(input: unknown, limits: ArchivalSearchLimits): NormalizedQuery {
  if (!isRecord(input)) throw new ArchivalSearchInputError("Archival search query must be an object");
  const keys = readInput(() => Object.keys(input), "Archival search query is unreadable");
  for (const key of keys) {
    if (key !== "text" && key !== "caseSensitive" && key !== "sourceIds" && key !== "role") {
      throw new ArchivalSearchInputError("Unknown archival search query property");
    }
  }
  if (!readInput(() => Object.hasOwn(input, "text"), "Archival search query is unreadable")) {
    throw new ArchivalSearchInputError("Archival search query needs bounded non-empty text");
  }
  const text = readInput(() => input.text, "Archival search query is unreadable");
  if (typeof text !== "string" || text.length === 0 || text.length > limits.maxQueryChars) {
    throw new ArchivalSearchInputError("Archival search query needs bounded non-empty text");
  }
  const rawCaseSensitive = readInput(() => Object.hasOwn(input, "caseSensitive")
    ? input.caseSensitive
    : undefined, "Archival search query is unreadable");
  if (rawCaseSensitive !== undefined && typeof rawCaseSensitive !== "boolean") {
    throw new ArchivalSearchInputError("Archival search caseSensitive must be a boolean");
  }
  const rawRole = readInput(() => Object.hasOwn(input, "role") ? input.role : undefined,
    "Archival search query is unreadable");
  if (rawRole !== undefined && (typeof rawRole !== "string" || rawRole.length === 0 ||
      rawRole.length > MAX_ROLE_CHARS)) {
    throw new ArchivalSearchInputError("Archival search role must be a bounded non-empty string");
  }
  const rawSourceIds = readInput(() => Object.hasOwn(input, "sourceIds") ? input.sourceIds : undefined,
    "Archival search query is unreadable");
  let sourceIds: readonly string[] | null = null;
  let sourceIdSet: ReadonlySet<string> | null = null;
  if (rawSourceIds !== undefined) {
    if (!Array.isArray(rawSourceIds)) {
      throw new ArchivalSearchInputError("Archival search sourceIds must be an array");
    }
    if (rawSourceIds.length > MAX_SCOPE_SOURCES) throw new ArchivalSearchBoundsError("scope-source-count");
    if (rawSourceIds.length === 0) {
      throw new ArchivalSearchInputError("Archival search sourceIds must not be empty");
    }
    const seen = new Set<string>();
    for (const value of rawSourceIds) {
      if (typeof value !== "string" || !SAFE_LABEL.test(value)) {
        throw new ArchivalSearchInputError("Archival search sourceIds must be safe source labels");
      }
      seen.add(value);
    }
    sourceIds = Object.freeze([...seen].sort());
    sourceIdSet = seen;
  }
  const normalized = {
    text,
    caseSensitive: rawCaseSensitive === true,
    role: rawRole ?? null,
    sourceIds,
    sourceIdSet,
    querySha256: "",
  };
  const querySha256 = sha256(JSON.stringify([
    "nanobot-archival-search-v1",
    normalized.text,
    normalized.caseSensitive,
    normalized.role,
    normalized.sourceIds,
  ]));
  return { ...normalized, querySha256 };
}

function emptyCoverage(): MutableCoverage {
  return {
    sourcesConsidered: 0,
    sourcesFullyScanned: 0,
    sourcesClean: 0,
    sourcesWithCaveats: 0,
    sourcesUnsupported: 0,
    sourcesUnavailable: 0,
    sourcesLedgerMismatch: 0,
    sourcesDuplicateOrOutOfOrder: 0,
    sourcesIdentityMismatch: 0,
    entriesScanned: 0,
    entriesSearchable: 0,
    entriesSearchablePartial: 0,
    entriesNoSearchText: 0,
    entriesOpaque: 0,
    entriesQuarantined: 0,
    entriesUnsearchable: 0,
    unitsScanned: 0,
    unitsInvalid: 0,
    hits: 0,
  };
}

type MutableSourceObservation = Mutable<ArchivalSearchSourceObservation>;

function emptySourceObservation(): MutableSourceObservation {
  return {
    recordsObserved: 0,
    unitsObserved: 0,
    bytesObserved: 0,
    foreignEntriesObserved: 0,
    firstEntryIdObserved: null,
    lastEntryIdObserved: null,
    firstLineObserved: null,
    lastLineObserved: null,
    previousLineObserved: null,
    lineSequenceValid: true,
    malformedArchival: false,
    identityMismatch: false,
  };
}

const SOURCE_OBSERVATION_KEYS = new Set([
  "recordsObserved",
  "unitsObserved",
  "bytesObserved",
  "foreignEntriesObserved",
  "firstEntryIdObserved",
  "lastEntryIdObserved",
  "firstLineObserved",
  "lastLineObserved",
  "previousLineObserved",
  "lineSequenceValid",
  "malformedArchival",
  "identityMismatch",
]);

function readSourceObservation(value: unknown, label: string): MutableSourceObservation {
  if (!isRecord(value)) throw new ArchivalSearchContinuationError(`${label} source observation is invalid`);
  const keys = readInput(() => Object.keys(value), `${label} source observation is unreadable`);
  if (keys.length !== SOURCE_OBSERVATION_KEYS.size || keys.some((key) => !SOURCE_OBSERVATION_KEYS.has(key))) {
    throw new ArchivalSearchContinuationError(`${label} source observation is invalid`);
  }
  const numberFields = ["recordsObserved", "unitsObserved", "bytesObserved", "foreignEntriesObserved"] as const;
  const numeric = new Map<string, number>();
  for (const key of numberFields) {
    const number = readInput(() => value[key], `${label} source observation is unreadable`);
    if (!isSafeNonNegativeInteger(number)) {
      throw new ArchivalSearchContinuationError(`${label} source observation is invalid`);
    }
    numeric.set(key, number);
  }
  const optionalPositive = (key: string): number | null => {
    const number = readInput(() => value[key], `${label} source observation is unreadable`);
    if (number === null) return null;
    if (!isSafePositiveInteger(number)) {
      throw new ArchivalSearchContinuationError(`${label} source observation is invalid`);
    }
    return number;
  };
  const firstEntryIdObserved = optionalPositive("firstEntryIdObserved");
  const lastEntryIdObserved = optionalPositive("lastEntryIdObserved");
  const firstLineObserved = optionalPositive("firstLineObserved");
  const lastLineObserved = optionalPositive("lastLineObserved");
  const previousLineObserved = optionalPositive("previousLineObserved");
  const lineSequenceValid = readInput(() => value.lineSequenceValid, `${label} source observation is unreadable`);
  const malformedArchival = readInput(() => value.malformedArchival, `${label} source observation is unreadable`);
  const identityMismatch = readInput(() => value.identityMismatch, `${label} source observation is unreadable`);
  if (typeof lineSequenceValid !== "boolean" || typeof malformedArchival !== "boolean" ||
      typeof identityMismatch !== "boolean") {
    throw new ArchivalSearchContinuationError(`${label} source observation is invalid`);
  }
  const recordsObserved = numeric.get("recordsObserved") as number;
  if (recordsObserved === 0 &&
      (firstEntryIdObserved !== null || lastEntryIdObserved !== null ||
        firstLineObserved !== null || lastLineObserved !== null || previousLineObserved !== null ||
        (numeric.get("unitsObserved") as number) !== 0 || (numeric.get("bytesObserved") as number) !== 0)) {
    throw new ArchivalSearchContinuationError(`${label} source observation is inconsistent`);
  }
  if (lastEntryIdObserved !== null && firstEntryIdObserved === null) {
    throw new ArchivalSearchContinuationError(`${label} source observation is inconsistent`);
  }
  if (lastLineObserved !== null && firstLineObserved === null) {
    throw new ArchivalSearchContinuationError(`${label} source observation is inconsistent`);
  }
  return {
    recordsObserved,
    unitsObserved: numeric.get("unitsObserved") as number,
    bytesObserved: numeric.get("bytesObserved") as number,
    foreignEntriesObserved: numeric.get("foreignEntriesObserved") as number,
    firstEntryIdObserved,
    lastEntryIdObserved,
    firstLineObserved,
    lastLineObserved,
    previousLineObserved,
    lineSequenceValid,
    malformedArchival,
    identityMismatch,
  };
}

function ledgerDigest(storeNamespace: string, sources: readonly ArchivalLedgerSource[]): string {
  const rows = sources.map((source) => [
    source.sourceId,
    source.format,
    source.provenance,
    source.sha256,
    source.byteLength,
    source.lineCount,
    source.preparationStatus,
    source.preparationFormat,
    source.preparationVersion,
    source.recordSchemaVersion,
    source.recordCount,
    source.searchUnitCount,
    source.conversationId,
    source.firstEntryId,
    source.lastEntryId,
    source.firstLine,
    source.lastLine,
    source.firstPreparationOrdinal,
    source.lastPreparationOrdinal,
  ]);
  return sha256(JSON.stringify(["nanobot-archival-search-ledger-v1", storeNamespace, rows]));
}

function durableKeyFor(storeNamespace: string, sourceId: string, line: number): string {
  return sha256(JSON.stringify(["nanobot-archival-line-v1", storeNamespace, sourceId, line]));
}

const COVERAGE_KEYS = new Set<keyof ArchivalSearchCoverageCounters>([
  "sourcesConsidered",
  "sourcesFullyScanned",
  "sourcesClean",
  "sourcesWithCaveats",
  "sourcesUnsupported",
  "sourcesUnavailable",
  "sourcesLedgerMismatch",
  "sourcesDuplicateOrOutOfOrder",
  "sourcesIdentityMismatch",
  "entriesScanned",
  "entriesSearchable",
  "entriesSearchablePartial",
  "entriesNoSearchText",
  "entriesOpaque",
  "entriesQuarantined",
  "entriesUnsearchable",
  "unitsScanned",
  "unitsInvalid",
  "hits",
]);
const CONTINUATION_KEYS = new Set([
  "format",
  "version",
  "querySha256",
  "storeNamespace",
  "ledgerSha256",
  "ledgerSourceCount",
  "sourceIndex",
  "sourceId",
  "conversationId",
  "nextEntryId",
  "nextUnit",
  "currentEntryClassified",
  "currentEntryHasSearchableUnit",
  "currentEntryHasValidUnit",
  "currentEntry",
  "sourceObservation",
  "currentSourceHasCaveat",
  "coverage",
]);

function readCoverage(value: unknown, label: string): MutableCoverage {
  if (!isRecord(value)) throw new ArchivalSearchContinuationError(`${label} coverage is invalid`);
  const keys = readInput(() => Object.keys(value), `${label} coverage is unreadable`);
  if (keys.length !== COVERAGE_KEYS.size || keys.some((key) => !COVERAGE_KEYS.has(key as keyof ArchivalSearchCoverageCounters))) {
    throw new ArchivalSearchContinuationError(`${label} coverage is invalid`);
  }
  const result = emptyCoverage();
  for (const key of COVERAGE_KEYS) {
    const number = readInput(() => value[key], `${label} coverage is unreadable`);
    if (!isSafeNonNegativeInteger(number)) {
      throw new ArchivalSearchContinuationError(`${label} coverage is invalid`);
    }
    result[key] = number;
  }
  if (result.sourcesClean + result.sourcesWithCaveats !== result.sourcesFullyScanned ||
      result.sourcesFullyScanned + result.sourcesUnsupported + result.sourcesUnavailable !==
        result.sourcesConsidered ||
      result.entriesSearchable + result.entriesSearchablePartial + result.entriesNoSearchText +
        result.entriesOpaque + result.entriesQuarantined + result.entriesUnsearchable !==
        result.entriesScanned ||
      result.hits > result.unitsScanned) {
    throw new ArchivalSearchContinuationError(`${label} coverage is inconsistent`);
  }
  return result;
}

function sourceInScope(sourceId: string, query: NormalizedQuery): boolean {
  return query.sourceIdSet === null || query.sourceIdSet.has(sourceId);
}

function assertKnownScope(
  ledgerSources: readonly ArchivalLedgerSource[],
  query: NormalizedQuery,
): void {
  if (query.sourceIds === null) return;
  const known = new Set(ledgerSources.map((source) => source.sourceId));
  for (const sourceId of query.sourceIds) {
    if (!known.has(sourceId)) {
      throw new ArchivalSearchInputError("Archival search sourceIds names a source outside the current ledger");
    }
  }
}

function countInScope(ledgerSources: readonly ArchivalLedgerSource[], query: NormalizedQuery, from = 0): number {
  let count = 0;
  for (let index = from; index < ledgerSources.length; index++) {
    if (sourceInScope(ledgerSources[index]!.sourceId, query)) count++;
  }
  return count;
}

interface ContinuationState {
  readonly sourceIndex: number;
  readonly nextEntryId: number | null;
  readonly nextUnit: number;
  readonly currentEntryClassified: boolean;
  readonly currentEntryHasSearchableUnit: boolean;
  readonly currentEntryHasValidUnit: boolean;
  readonly currentEntry: ArchivalSearchCurrentEntry | null;
  readonly sourceObservation: MutableSourceObservation;
  readonly currentSourceHasCaveat: boolean;
  readonly coverage: MutableCoverage;
}

function readContinuation(
  value: unknown,
  ledgerSources: readonly ArchivalLedgerSource[],
  storeNamespace: string,
  ledgerSha256: string,
  query: NormalizedQuery,
): ContinuationState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ArchivalSearchContinuationError("Archival search continuation is invalid");
  const keys = readInput(() => Object.keys(value), "Archival search continuation is unreadable");
  if (keys.length !== CONTINUATION_KEYS.size || keys.some((key) => !CONTINUATION_KEYS.has(key))) {
    throw new ArchivalSearchContinuationError("Archival search continuation is invalid");
  }
  if (value.format !== ARCHIVAL_SEARCH_FORMAT || value.version !== ARCHIVAL_SEARCH_VERSION) {
    throw new ArchivalSearchContinuationError("Archival search continuation has an unexpected format or version");
  }
  const querySha256 = readInput(() => value.querySha256, "Archival search continuation is unreadable");
  const continuationNamespace = readInput(() => value.storeNamespace, "Archival search continuation is unreadable");
  if (typeof querySha256 !== "string" || !SHA256_HEX.test(querySha256) ||
      querySha256 !== query.querySha256) {
    throw new ArchivalSearchContinuationError("Archival search continuation does not match this query");
  }
  if (typeof continuationNamespace !== "string" || continuationNamespace !== storeNamespace) {
    throw new ArchivalSearchContinuationError("Archival search continuation belongs to another store namespace");
  }
  const continuationLedgerSha256 = readInput(() => value.ledgerSha256,
    "Archival search continuation is unreadable");
  if (typeof continuationLedgerSha256 !== "string" || !SHA256_HEX.test(continuationLedgerSha256) ||
      continuationLedgerSha256 !== ledgerSha256) {
    throw new ArchivalSearchContinuationError("Archival search continuation does not match the current ledger digest");
  }
  const ledgerSourceCount = readInput(() => value.ledgerSourceCount, "Archival search continuation is unreadable");
  if (!isSafePositiveInteger(ledgerSourceCount) || ledgerSourceCount !== ledgerSources.length) {
    throw new ArchivalSearchContinuationError("Archival search continuation does not match the current ledger");
  }
  const sourceIndex = readInput(() => value.sourceIndex, "Archival search continuation is unreadable");
  if (!isSafeNonNegativeInteger(sourceIndex) || sourceIndex >= ledgerSources.length) {
    throw new ArchivalSearchContinuationError("Archival search continuation source position is invalid");
  }
  const sourceId = readInput(() => value.sourceId, "Archival search continuation is unreadable");
  const conversationId = readInput(() => value.conversationId, "Archival search continuation is unreadable");
  const nextEntryId = readInput(() => value.nextEntryId, "Archival search continuation is unreadable");
  const nextUnit = readInput(() => value.nextUnit, "Archival search continuation is unreadable");
  const currentEntryClassified = readInput(() => value.currentEntryClassified,
    "Archival search continuation is unreadable");
  const currentEntryHasSearchableUnit = readInput(() => value.currentEntryHasSearchableUnit,
    "Archival search continuation is unreadable");
  const currentEntryHasValidUnit = readInput(() => value.currentEntryHasValidUnit,
    "Archival search continuation is unreadable");
  const rawCurrentEntry = readInput(() => value.currentEntry, "Archival search continuation is unreadable");
  let currentEntry: ArchivalSearchCurrentEntry | null = null;
  if (rawCurrentEntry !== null) {
    if (!isRecord(rawCurrentEntry) ||
        Object.keys(rawCurrentEntry).length !== 4 ||
        !Object.hasOwn(rawCurrentEntry, "line") ||
        !Object.hasOwn(rawCurrentEntry, "durableKey") ||
        !Object.hasOwn(rawCurrentEntry, "unitCount") ||
        !Object.hasOwn(rawCurrentEntry, "fingerprint")) {
      throw new ArchivalSearchContinuationError("Archival search continuation in-flight entry is invalid");
    }
    const line = readInput(() => rawCurrentEntry.line, "Archival search continuation is unreadable");
    const durableKey = readInput(() => rawCurrentEntry.durableKey, "Archival search continuation is unreadable");
    const unitCount = readInput(() => rawCurrentEntry.unitCount, "Archival search continuation is unreadable");
    const fingerprint = readInput(() => rawCurrentEntry.fingerprint, "Archival search continuation is unreadable");
    if (!isSafePositiveInteger(line) || typeof durableKey !== "string" || !SHA256_HEX.test(durableKey) ||
        !isSafePositiveInteger(unitCount) || typeof fingerprint !== "string" || !SHA256_HEX.test(fingerprint)) {
      throw new ArchivalSearchContinuationError("Archival search continuation in-flight entry is invalid");
    }
    currentEntry = { line, durableKey, unitCount, fingerprint };
  }
  const sourceObservation = readSourceObservation(
    readInput(() => value.sourceObservation, "Archival search continuation is unreadable"),
    "Archival search continuation",
  );
  const currentSourceHasCaveat = readInput(() => value.currentSourceHasCaveat,
    "Archival search continuation is unreadable");
  if (typeof sourceId !== "string" || (conversationId !== null && !isSafePositiveInteger(conversationId)) ||
      (nextEntryId !== null && !isSafePositiveInteger(nextEntryId)) ||
      !isSafeNonNegativeInteger(nextUnit) ||
      (nextEntryId === null && nextUnit !== 0) ||
      typeof currentEntryClassified !== "boolean" ||
      typeof currentEntryHasSearchableUnit !== "boolean" ||
      typeof currentEntryHasValidUnit !== "boolean" ||
      (nextEntryId === null && currentEntryClassified) ||
      (nextUnit > 0 && !currentEntryClassified) ||
      (currentEntryClassified && currentEntry === null) ||
      (nextUnit > 0 && currentEntry === null) ||
      (currentEntry !== null && !currentEntryClassified) ||
      (currentEntry !== null && nextUnit > currentEntry.unitCount) ||
      (nextUnit === 0 && (currentEntryHasSearchableUnit || currentEntryHasValidUnit)) ||
      (!currentEntryHasValidUnit && currentEntryHasSearchableUnit) ||
      typeof currentSourceHasCaveat !== "boolean") {
    throw new ArchivalSearchContinuationError("Archival search continuation position is invalid");
  }
  const row = ledgerSources[sourceIndex]!;
  if (row.sourceId !== sourceId || row.conversationId !== conversationId ||
      !sourceInScope(sourceId, query)) {
    throw new ArchivalSearchContinuationError("Archival search continuation does not match the current ledger source");
  }
  if (conversationId === null && (nextEntryId !== null || nextUnit !== 0)) {
    throw new ArchivalSearchContinuationError("Archival search continuation cannot resume an unavailable source");
  }
  const coverage = readCoverage(readInput(() => value.coverage, "Archival search continuation is unreadable"), "Archival search continuation");
  if (coverage.sourcesConsidered > ledgerSources.length ||
      coverage.sourcesFullyScanned > coverage.sourcesConsidered) {
    throw new ArchivalSearchContinuationError("Archival search continuation coverage exceeds the ledger");
  }
  return {
    sourceIndex,
    nextEntryId,
    nextUnit,
    currentEntryClassified,
    currentEntryHasSearchableUnit,
    currentEntryHasValidUnit,
    currentEntry,
    sourceObservation,
    currentSourceHasCaveat,
    coverage,
  };
}

interface NormalizedRecord {
  readonly durableKey: string;
  readonly sourceId: string;
  readonly line: number;
  readonly preparationOrdinal: number;
  readonly preparationSourceOrder: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly lineTerminated: boolean;
  readonly lineSha256: string;
  readonly category: ArchivalRecordCategory;
  readonly status: "prepared" | "quarantined";
  readonly opaque: boolean;
  readonly searchStatus: "complete" | "partial" | "none";
  readonly sessionKey: string | null;
  readonly timestamp: string | null;
  readonly role: string | null;
  readonly quarantineReason: string | null;
  readonly search: readonly unknown[];
}

function readRecordEntry(
  entry: EntryRecord,
  source: ArchivalLedgerSource,
  storeNamespace: string,
): NormalizedRecord | null {
  try {
    if (!ArchivalRecordEntry.is(entry) || entry.kind !== ARCHIVAL_RECORD_ENTRY_KIND ||
        entry.model !== undefined || entry.head !== undefined || entry.edits !== undefined) {
      return null;
    }
    const data: unknown = entry.data;
    if (!isRecord(data)) return null;
    if (data.schema !== ARCHIVAL_RECORD_SCHEMA ||
        data.schemaVersion !== ARCHIVAL_RECORD_SCHEMA_VERSION ||
        data.storeNamespace !== storeNamespace ||
        data.sourceId !== source.sourceId ||
        data.sourceFormat !== source.format ||
        data.sourceProvenance !== source.provenance ||
        data.sourceSha256 !== source.sha256 ||
        data.disposition !== ARCHIVAL_SEARCH_DISPOSITION) {
      return null;
    }
    const durableKey = data.durableKey;
    const line = data.line;
    const preparationOrdinal = data.preparationOrdinal;
    const preparationSourceOrder = data.preparationSourceOrder;
    const byteOffset = data.byteOffset;
    const byteLength = data.byteLength;
    const lineTerminated = data.lineTerminated;
    const lineSha256 = data.lineSha256;
    const category = data.category;
    const status = data.status;
    const opaque = data.opaque;
    const searchStatus = data.searchStatus;
    const quarantineReason = data.quarantineReason;
    const search = data.search;
    if (typeof durableKey !== "string" || !SHA256_HEX.test(durableKey) ||
        !isSafePositiveInteger(line) ||
        !isSafeNonNegativeInteger(preparationOrdinal) ||
        !isSafeNonNegativeInteger(preparationSourceOrder) ||
        !isSafeNonNegativeInteger(byteOffset) ||
        !isSafeNonNegativeInteger(byteLength) ||
        typeof lineTerminated !== "boolean" ||
        typeof lineSha256 !== "string" || !SHA256_HEX.test(lineSha256) ||
        typeof category !== "string" || !CATEGORIES.has(category as ArchivalRecordCategory) ||
        (status !== "prepared" && status !== "quarantined") ||
        typeof opaque !== "boolean" ||
        typeof searchStatus !== "string" || !SEARCH_STATUSES.has(searchStatus) ||
        !Array.isArray(search)) {
      return null;
    }
    if (status === "quarantined") {
      if (typeof quarantineReason !== "string") return null;
    } else if (quarantineReason !== null) {
      return null;
    }
    const sessionKey = nullableString(data.sessionKey, MAX_SESSION_KEY_CHARS);
    const timestamp = nullableString(data.timestamp, MAX_TIMESTAMP_CHARS);
    const role = nullableString(data.role, MAX_ROLE_CHARS);
    if (sessionKey === undefined || timestamp === undefined || role === undefined) return null;
    const normalizedCategory = category as ArchivalRecordCategory;
    if ((searchStatus === "complete" && search.length === 0) ||
        (searchStatus === "none" && search.length > 0) ||
        (!SEARCHABLE_CATEGORIES.has(normalizedCategory) && search.length > 0) ||
        (status === "quarantined" && search.length > 0) ||
        (opaque && search.length > 0)) {
      return null;
    }
    return {
      durableKey,
      sourceId: source.sourceId,
      line,
      preparationOrdinal,
      preparationSourceOrder,
      byteOffset,
      byteLength,
      lineTerminated,
      lineSha256,
      category: normalizedCategory,
      status,
      opaque,
      searchStatus: searchStatus as "complete" | "partial" | "none",
      sessionKey,
      timestamp,
      role,
      quarantineReason,
      search,
    };
  } catch {
    return null;
  }
}

function observeArchivalEntry(
  observation: MutableSourceObservation,
  source: ArchivalLedgerSource,
  entryId: number,
  record: NormalizedRecord | null,
  storeNamespace: string,
): void {
  observation.recordsObserved++;
  if (observation.firstEntryIdObserved === null) observation.firstEntryIdObserved = entryId;
  observation.lastEntryIdObserved = entryId;
  if (record === null) {
    observation.malformedArchival = true;
    observation.lineSequenceValid = false;
    return;
  }
  observation.unitsObserved += record.search.length;
  observation.bytesObserved += record.byteLength;
  if (observation.previousLineObserved === null) {
    observation.firstLineObserved = record.line;
    if (source.firstLine !== null && record.line !== source.firstLine) {
      observation.lineSequenceValid = false;
    }
  } else if (record.line !== observation.previousLineObserved + 1) {
    observation.lineSequenceValid = false;
  }
  observation.lastLineObserved = record.line;
  observation.previousLineObserved = record.line;
  if (record.durableKey !== durableKeyFor(storeNamespace, source.sourceId, record.line)) {
    observation.identityMismatch = true;
  }
}

function entryFingerprint(entryId: number, record: NormalizedRecord): string {
  return sha256(JSON.stringify([
    "nanobot-archival-search-entry-v1",
    entryId,
    record.sourceId,
    record.line,
    record.durableKey,
    record.searchStatus,
    record.search,
  ]));
}

interface NormalizedUnit {
  readonly index: number;
  readonly kind: ArchivalSearchUnitKind;
  readonly role: string | null;
  readonly timestamp: string | null;
  readonly name: string | null;
  readonly entryId: string | null;
  readonly text: string;
}

function readUnit(value: unknown, expectedIndex: number): NormalizedUnit | null {
  try {
    if (!isRecord(value)) return null;
    const unit = value.unit;
    const kind = value.kind;
    const text = value.text;
    if (unit !== expectedIndex ||
        typeof kind !== "string" || !UNIT_KINDS.has(kind as ArchivalSearchUnitKind) ||
        typeof text !== "string") {
      return null;
    }
    const role = nullableString(value.role, MAX_ROLE_CHARS);
    const timestamp = nullableString(value.timestamp, MAX_TIMESTAMP_CHARS);
    const name = nullableString(value.name, MAX_NAME_CHARS);
    const entryId = nullableString(value.entryId, MAX_ARCHIVED_ENTRY_ID_CHARS);
    if (role === undefined || timestamp === undefined || name === undefined || entryId === undefined) return null;
    return {
      index: expectedIndex,
      kind: kind as ArchivalSearchUnitKind,
      role,
      timestamp,
      name,
      entryId,
      text,
    };
  } catch {
    return null;
  }
}

function isSearchableRecord(record: NormalizedRecord): boolean {
  return record.status === "prepared" && !record.opaque &&
    SEARCHABLE_CATEGORIES.has(record.category) &&
    record.searchStatus !== "none" &&
    record.search.length > 0;
}

interface Classification {
  readonly caveat: boolean;
  readonly resumable: boolean;
}

/**
 * Classify the entry from its allowlisted metadata only. Its unit list is
 * validated lazily and incrementally during the bounded unit loop, so a record
 * with more units than one page's `maxScanUnits` remains reachable across
 * pages. If no valid searchable unit is ever found, the entry is reclassified
 * at its end (see `finishCurrentEntry`).
 */
function classifyRecord(record: NormalizedRecord, coverage: MutableCoverage): Classification {
  if (record.status === "quarantined") {
    coverage.entriesQuarantined++;
    return { caveat: true, resumable: false };
  }
  if (record.opaque || !SEARCHABLE_CATEGORIES.has(record.category)) {
    coverage.entriesOpaque++;
    return { caveat: true, resumable: false };
  }
  if (record.search.length === 0) {
    coverage.entriesNoSearchText++;
    return { caveat: true, resumable: false };
  }
  // readRecordEntry() permits a non-empty unit list only for a complete or
  // partial search projection.
  if (record.searchStatus === "partial") coverage.entriesSearchablePartial++;
  else coverage.entriesSearchable++;
  return { caveat: record.searchStatus === "partial", resumable: true };
}

function escapedLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface LiteralMatch {
  readonly index: number;
  readonly length: number;
  readonly count: number;
}

function makeMatcher(query: NormalizedQuery): (text: string) => LiteralMatch | null {
  const pattern = readInput(
    () => new RegExp(escapedLiteral(query.text), query.caseSensitive ? "gu" : "giu"),
    "Archival search query is not valid Unicode text",
  );
  return (text: string): LiteralMatch | null => {
    pattern.lastIndex = 0;
    const first = pattern.exec(text);
    if (first === null) return null;
    let count = 1;
    while (pattern.exec(text) !== null) count++;
    return { index: first.index, length: first[0].length, count };
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

interface Snippet {
  readonly text: string;
  readonly offset: number;
  readonly matchOffset: number;
  readonly matchLength: number;
  readonly matchTruncated: boolean;
  readonly truncated: boolean;
}

function buildSnippet(text: string, match: LiteralMatch, maxChars: number): Snippet {
  let start: number;
  let end: number;
  if (match.length >= maxChars) {
    start = match.index;
    end = Math.min(text.length, start + maxChars);
  } else {
    start = Math.max(0, match.index - Math.floor((maxChars - match.length) / 2));
    end = Math.min(text.length, start + maxChars);
    if (end - start < maxChars) start = Math.max(0, end - maxChars);
  }
  // Never cut a surrogate pair at either edge. This is code-unit safety, not
  // grapheme-cluster segmentation.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start--;
  }
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end--;
  }
  if (end < start) end = start;
  const matchEnd = match.index + match.length;
  return {
    text: text.slice(start, end),
    offset: start,
    matchOffset: match.index,
    matchLength: match.length,
    matchTruncated: start > match.index || end < matchEnd,
    truncated: start > 0 || end < text.length,
  };
}

function buildHit(
  record: NormalizedRecord,
  source: ArchivalLedgerSource,
  unit: NormalizedUnit,
  match: LiteralMatch,
  limits: ArchivalSearchLimits,
  durableEntryId: number,
): ArchivalSearchHit {
  const excerpt = buildSnippet(unit.text, match, limits.maxSnippetChars);
  return {
    disposition: ARCHIVAL_SEARCH_DISPOSITION,
    sourceId: record.sourceId,
    sourceFormat: source.format,
    sourceProvenance: source.provenance,
    sourceSha256: source.sha256,
    durableKey: record.durableKey,
    durableEntryId,
    line: record.line,
    preparationOrdinal: record.preparationOrdinal,
    preparationSourceOrder: record.preparationSourceOrder,
    byteOffset: record.byteOffset,
    byteLength: record.byteLength,
    lineTerminated: record.lineTerminated,
    lineSha256: record.lineSha256,
    category: record.category,
    searchStatus: record.searchStatus === "partial" ? "partial" : "complete",
    textOmitted: record.searchStatus === "partial",
    sessionKey: record.sessionKey,
    role: unit.role ?? record.role,
    timestamp: unit.timestamp ?? record.timestamp,
    unitIndex: unit.index,
    unitKind: unit.kind,
    unitName: unit.name,
    archivedEntryId: unit.entryId,
    matchCount: match.count,
    snippet: excerpt.text,
    snippetOffset: excerpt.offset,
    matchOffset: excerpt.matchOffset,
    matchLength: excerpt.matchLength,
    matchTruncated: excerpt.matchTruncated,
    snippetTruncated: excerpt.truncated,
  };
}

interface HitCheckpoint {
  readonly entryId: number;
  readonly sourceIndex: number;
  readonly nextUnit: number;
  readonly entryClassified: boolean;
  readonly hasSearchableUnit: boolean;
  readonly hasValidUnit: boolean;
  readonly currentEntry: ArchivalSearchCurrentEntry | null;
  readonly sourceObservation: ArchivalSearchSourceObservation;
  readonly coverage: MutableCoverage;
  readonly currentSourceHasCaveat: boolean;
  readonly hitsBefore: number;
}

interface ScanState {
  sourceIndex: number;
  nextEntryId: number | null;
  nextUnit: number;
  currentEntryClassified: boolean;
  currentEntryHasSearchableUnit: boolean;
  currentEntryHasValidUnit: boolean;
  currentEntry: ArchivalSearchCurrentEntry | null;
  sourceObservation: MutableSourceObservation;
  currentSourceHasCaveat: boolean;
  coverage: MutableCoverage;
  readonly hits: ArchivalSearchHit[];
  readonly hitCheckpoints: HitCheckpoint[];
  stopReason: ArchivalSearchStopReason;
}

interface BuildPageArgs {
  readonly ledgerPresent: boolean;
  readonly ledgerSources: readonly ArchivalLedgerSource[];
  readonly storeNamespace: string | null;
  readonly ledgerSha256: string;
  readonly query: NormalizedQuery;
  readonly limits: ArchivalSearchLimits;
  readonly state: ScanState;
  readonly startCoverage: ArchivalSearchCoverageCounters;
}

function buildContinuation(args: BuildPageArgs): ArchivalSearchContinuation | null {
  const { state, ledgerSources, storeNamespace, query } = args;
  if (state.sourceIndex >= ledgerSources.length || storeNamespace === null) return null;
  const source = ledgerSources[state.sourceIndex]!;
  return {
    format: ARCHIVAL_SEARCH_FORMAT,
    version: ARCHIVAL_SEARCH_VERSION,
    querySha256: query.querySha256,
    storeNamespace,
    ledgerSha256: args.ledgerSha256,
    ledgerSourceCount: ledgerSources.length,
    sourceIndex: state.sourceIndex,
    sourceId: source.sourceId,
    conversationId: source.conversationId,
    nextEntryId: state.nextEntryId,
    nextUnit: state.nextUnit,
    currentEntryClassified: state.currentEntryClassified,
    currentEntryHasSearchableUnit: state.currentEntryHasSearchableUnit,
    currentEntryHasValidUnit: state.currentEntryHasValidUnit,
    currentEntry: state.currentEntry,
    sourceObservation: { ...state.sourceObservation },
    currentSourceHasCaveat: state.currentSourceHasCaveat,
    coverage: { ...state.coverage },
  };
}

function buildPage(args: BuildPageArgs): ArchivalSearchPage {
  const { state, ledgerSources, query, limits, startCoverage } = args;
  const inScope = countInScope(ledgerSources, query);
  const continuation = buildContinuation(args);
  const scanComplete = continuation === null;
  const sourcesNotYetScanned = countInScope(ledgerSources, query, state.sourceIndex);
  const coverageComplete = args.ledgerPresent && scanComplete &&
    state.coverage.sourcesConsidered === inScope &&
    state.coverage.sourcesWithCaveats === 0 &&
    state.coverage.sourcesUnsupported === 0 &&
    state.coverage.sourcesUnavailable === 0 &&
    state.coverage.sourcesLedgerMismatch === 0 &&
    state.coverage.sourcesDuplicateOrOutOfOrder === 0 &&
    state.coverage.sourcesIdentityMismatch === 0 &&
    state.coverage.entriesUnsearchable === 0;
  const stopReason = !args.ledgerPresent
    ? "no-ledger"
    : scanComplete
      ? "complete"
      : state.stopReason === "complete"
        ? "max-sources"
        : state.stopReason;
  const coverage: ArchivalSearchCoverage = {
    ...state.coverage,
    ledgerPresent: args.ledgerPresent,
    ledgerSourceCount: ledgerSources.length,
    sourcesInScope: inScope,
    sourcesScopeExcluded: ledgerSources.length - inScope,
    sourcesNotYetScanned,
    scanComplete,
    coverageComplete,
    ledgerOnlyCoverage: true,
    unsupportedSourcesOutsideLedger: true,
  };
  return {
    format: ARCHIVAL_SEARCH_FORMAT,
    version: ARCHIVAL_SEARCH_VERSION,
    disposition: ARCHIVAL_SEARCH_DISPOSITION,
    order: ARCHIVAL_SEARCH_ORDER,
    continuationTrust: ARCHIVAL_SEARCH_CONTINUATION_TRUST,
    ownershipRequirement: ARCHIVAL_PERSISTENCE_OWNERSHIP,
    storeNamespace: args.storeNamespace,
    query: {
      text: query.text,
      caseSensitive: query.caseSensitive,
      role: query.role,
      sourceCount: query.sourceIds?.length ?? 0,
      querySha256: query.querySha256,
    },
    ledger: {
      present: args.ledgerPresent,
      sourceCount: ledgerSources.length,
    },
    limits,
    hits: [...state.hits],
    coverage,
    progress: {
      sourcesConsideredThisPage: state.coverage.sourcesConsidered - startCoverage.sourcesConsidered,
      entriesScannedThisPage: state.coverage.entriesScanned - startCoverage.entriesScanned,
      unitsScannedThisPage: state.coverage.unitsScanned - startCoverage.unitsScanned,
      hitsThisPage: state.hits.length,
      nextSourceId: continuation?.sourceId ?? null,
      nextEntryId: continuation?.nextEntryId ?? null,
      nextUnit: continuation?.nextUnit ?? null,
    },
    stopReason,
    scanComplete,
    continuation,
    limitations: LIMITATIONS,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function emptyPage(
  ledgerPresent: boolean,
  storeNamespace: string | null,
  query: NormalizedQuery,
  limits: ArchivalSearchLimits,
): ArchivalSearchPage {
  const state: ScanState = {
    sourceIndex: 0,
    nextEntryId: null,
    nextUnit: 0,
    currentEntryClassified: false,
    currentEntryHasSearchableUnit: false,
    currentEntryHasValidUnit: false,
    currentEntry: null,
    sourceObservation: emptySourceObservation(),
    currentSourceHasCaveat: false,
    coverage: emptyCoverage(),
    hits: [],
    hitCheckpoints: [],
    stopReason: ledgerPresent ? "complete" : "no-ledger",
  };
  const page = buildPage({
    ledgerPresent,
    ledgerSources: [],
    storeNamespace,
    ledgerSha256: "",
    query,
    limits,
    state,
    startCoverage: emptyCoverage(),
  });
  const json = JSON.stringify(page);
  if (json.length > limits.maxOutputChars) throw new ArchivalSearchBoundsError("output-chars");
  return deepFreeze(page);
}

interface ScannedPage {
  readonly kind: "page";
  readonly items: readonly EntryRecord[];
}

interface MissingConversation {
  readonly kind: "missing";
}

async function readCarrierPage(
  session: Session,
  conversationId: ConversationId,
  minEntryId: number,
  limit: number,
  context: Context,
): Promise<ScannedPage | MissingConversation> {
  const query: EntryQuery = {
    conversationId,
    order: "ascending",
    ...(minEntryId > 0 ? { minEntryId: minEntryId as EntryId } : {}),
  };
  return session.commit(async (tx) => {
    if ((await tx.conversation(conversationId)) === undefined) return { kind: "missing" as const };
    const page = await tx.scanEntries(query, limit);
    return { kind: "page" as const, items: page.items };
  }, context);
}

/**
 * Read one bounded page of persisted archival entries. The caller owns the
 * Session/storage exclusively. No write, network, ambient file read, model
 * payload read, task, submission, session-map, or Python resume is performed.
 */
export async function searchPersistedArchivalImport(
  session: Session,
  queryInput: ArchivalSearchQuery,
  context: Context,
  options: ArchivalSearchOptions = {},
): Promise<ArchivalSearchPage> {
  if (!isRecord(options)) throw new ArchivalSearchInputError("Archival search options must be an object");
  const optionKeys = readInput(() => Object.keys(options), "Archival search options are unreadable");
  for (const key of optionKeys) {
    if (key !== "limits" && key !== "continuation") {
      throw new ArchivalSearchInputError("Unknown archival search option property");
    }
  }
  const limits = normalizedLimits(readInput(() =>
    Object.hasOwn(options, "limits") ? options.limits : undefined, "Archival search options are unreadable"));
  const query = normalizedQuery(queryInput, limits);
  const matcher = makeMatcher(query);

  const ledger = await readArchivalImportLedger(session, context);
  if (ledger === undefined) {
    assertKnownScope([], query);
    const rawContinuation = readInput(() => Object.hasOwn(options, "continuation") ? options.continuation : undefined,
      "Archival search options are unreadable");
    if (rawContinuation !== undefined && rawContinuation !== null) {
      throw new ArchivalSearchContinuationError("Archival search continuation cannot resume without a ledger");
    }
    return emptyPage(false, null, query, limits);
  }
  const ledgerSources = ledger.sources;
  const ledgerPresent = true;
  assertKnownScope(ledgerSources, query);
  if (ledgerSources.length > MAX_LEDGER_SOURCES) {
    throw new ArchivalSearchBoundsError("ledger-source-count");
  }
  if (ledgerSources.length === 0) {
    const rawContinuation = readInput(() => Object.hasOwn(options, "continuation") ? options.continuation : undefined,
      "Archival search options are unreadable");
    if (rawContinuation !== undefined && rawContinuation !== null) {
      throw new ArchivalSearchContinuationError("Archival search continuation cannot resume an empty ledger");
    }
    return emptyPage(true, ledger.storeNamespace, query, limits);
  }
  const storeNamespace = ledger.storeNamespace;
  if (storeNamespace === null) {
    throw new ArchivalSearchCorruptionError("Archival import ledger has sources but no store namespace");
  }
  const ledgerSha256 = ledgerDigest(storeNamespace, ledgerSources);

  const rawContinuation = readInput(() => Object.hasOwn(options, "continuation") ? options.continuation : undefined,
    "Archival search options are unreadable");
  const continuation = readContinuation(rawContinuation, ledgerSources, storeNamespace, ledgerSha256, query);
  const startCoverage: MutableCoverage = continuation ? { ...continuation.coverage } : emptyCoverage();
  const state: ScanState = {
    sourceIndex: continuation?.sourceIndex ?? 0,
    nextEntryId: continuation?.nextEntryId ?? null,
    nextUnit: continuation?.nextUnit ?? 0,
    currentEntryClassified: continuation?.currentEntryClassified ?? false,
    currentEntryHasSearchableUnit: continuation?.currentEntryHasSearchableUnit ?? false,
    currentEntryHasValidUnit: continuation?.currentEntryHasValidUnit ?? false,
    currentEntry: continuation?.currentEntry ?? null,
    sourceObservation: continuation ? { ...continuation.sourceObservation } : emptySourceObservation(),
    currentSourceHasCaveat: continuation?.currentSourceHasCaveat ?? false,
    coverage: continuation ? { ...continuation.coverage } : emptyCoverage(),
    hits: [],
    hitCheckpoints: [],
    stopReason: "complete",
  };
  let sourcesConsideredThisCall = 0;
  let entriesTouchedThisCall = 0;
  let unitsScannedThisCall = 0;

  const finishSource = (source: ArchivalLedgerSource): void => {
    const observation = state.sourceObservation;
    const lineInvalid = !observation.lineSequenceValid;
    const ledgerMismatch =
      observation.recordsObserved !== source.recordCount ||
      (source.lineCount !== null && observation.recordsObserved !== source.lineCount) ||
      observation.unitsObserved !== source.searchUnitCount ||
      observation.bytesObserved !== source.byteLength ||
      observation.foreignEntriesObserved !== 0 ||
      observation.firstEntryIdObserved !== source.firstEntryId ||
      observation.lastEntryIdObserved !== source.lastEntryId ||
      observation.firstLineObserved !== source.firstLine ||
      observation.lastLineObserved !== source.lastLine ||
      observation.malformedArchival ||
      observation.identityMismatch ||
      lineInvalid;
    if (lineInvalid) state.coverage.sourcesDuplicateOrOutOfOrder++;
    if (observation.identityMismatch) state.coverage.sourcesIdentityMismatch++;
    if (ledgerMismatch) {
      state.coverage.sourcesLedgerMismatch++;
      state.currentSourceHasCaveat = true;
    }
    state.coverage.sourcesConsidered++;
    state.coverage.sourcesFullyScanned++;
    if (state.currentSourceHasCaveat) state.coverage.sourcesWithCaveats++;
    else state.coverage.sourcesClean++;
    sourcesConsideredThisCall++;
    state.sourceIndex++;
    state.nextEntryId = null;
    state.nextUnit = 0;
    state.currentEntryClassified = false;
    state.currentEntryHasSearchableUnit = false;
    state.currentEntryHasValidUnit = false;
    state.currentEntry = null;
    state.sourceObservation = emptySourceObservation();
    state.currentSourceHasCaveat = false;
  };

  const skipSource = (reason: "unsupported" | "unavailable"): void => {
    state.coverage.sourcesConsidered++;
    if (reason === "unsupported") state.coverage.sourcesUnsupported++;
    else state.coverage.sourcesUnavailable++;
    sourcesConsideredThisCall++;
    state.sourceIndex++;
    state.nextEntryId = null;
    state.nextUnit = 0;
    state.currentEntryClassified = false;
    state.currentEntryHasSearchableUnit = false;
    state.currentEntryHasValidUnit = false;
    state.currentEntry = null;
    state.sourceObservation = emptySourceObservation();
    state.currentSourceHasCaveat = false;
  };

  while (state.sourceIndex < ledgerSources.length) {
    context.abortSignal?.throwIfAborted();
    const source = ledgerSources[state.sourceIndex]!;
    if (!sourceInScope(source.sourceId, query)) {
      state.sourceIndex++;
      state.nextEntryId = null;
      state.nextUnit = 0;
      state.currentEntryClassified = false;
      state.currentEntryHasSearchableUnit = false;
      state.currentEntryHasValidUnit = false;
      state.currentEntry = null;
      state.sourceObservation = emptySourceObservation();
      state.currentSourceHasCaveat = false;
      continue;
    }
    const resumedEntry = state.nextEntryId !== null;
    if (!resumedEntry && sourcesConsideredThisCall >= limits.maxSources) {
      state.stopReason = "max-sources";
      break;
    }
    if (source.preparationStatus === "unsupported") {
      skipSource("unsupported");
      continue;
    }
    if (source.conversationId === null) {
      skipSource("unavailable");
      continue;
    }
    if (!resumedEntry) {
      state.currentSourceHasCaveat = source.preparationStatus === "incomplete";
      state.nextEntryId = 1;
      state.nextUnit = 0;
      state.currentEntryClassified = false;
      state.currentEntryHasSearchableUnit = false;
      state.currentEntryHasValidUnit = false;
      state.currentEntry = null;
      state.sourceObservation = emptySourceObservation();
    }
    if (entriesTouchedThisCall >= limits.maxScanEntries) {
      state.stopReason = "max-entries";
      break;
    }
    if (unitsScannedThisCall >= limits.maxScanUnits) {
      state.stopReason = "max-units";
      break;
    }
    const remainingEntries = limits.maxScanEntries - entriesTouchedThisCall;
    const pageLimit = Math.min(limits.scanBatchSize, Math.max(1, remainingEntries));
    const minEntryId = state.nextEntryId as number;
    const result = await readCarrierPage(
      session,
      source.conversationId as ConversationId,
      minEntryId,
      pageLimit,
      context,
    );
    if (result.kind === "missing") {
      skipSource("unavailable");
      continue;
    }
    if (state.currentEntry !== null) {
      const firstItem = result.items[0];
      if (firstItem === undefined || firstItem.id !== state.nextEntryId) {
        throw new ArchivalSearchContinuationError("Archival search continuation in-flight entry is missing");
      }
    }
    if (result.items.length === 0) {
      finishSource(source);
      continue;
    }

    let lastEntryId = minEntryId - 1;
    let stopped = false;
    for (const entry of result.items) {
      context.abortSignal?.throwIfAborted();
      const entryId = entry.id as number;
      if (!isSafePositiveInteger(entryId) || entryId <= lastEntryId) {
        throw new ArchivalSearchCorruptionError("Archival carrier entries are not in ascending Durable entry-ID order");
      }
      lastEntryId = entryId;
      const resumingEntry = state.nextEntryId === entryId &&
        (state.nextUnit > 0 || state.currentEntryClassified);
      let record: NormalizedRecord | null = null;
      let unitCount = 0;
      let searchableEntry = false;

      // Called only after every unit was traversed (or a resumed entry was
      // already at its end). Mid-entry stops keep the pre-counted category and
      // the flags plus unit position in the continuation.
      const finishCurrentEntry = (current: NormalizedRecord): void => {
        if (!state.currentEntryHasSearchableUnit) {
          if (current.searchStatus === "partial") state.coverage.entriesSearchablePartial--;
          else state.coverage.entriesSearchable--;
          if (state.currentEntryHasValidUnit) state.coverage.entriesNoSearchText++;
          else state.coverage.entriesUnsearchable++;
          state.currentSourceHasCaveat = true;
        }
        state.currentEntryClassified = false;
        state.currentEntryHasSearchableUnit = false;
        state.currentEntryHasValidUnit = false;
        state.currentEntry = null;
      };

      if (!resumingEntry) {
        state.nextUnit = 0;
        state.currentEntry = null;
        state.coverage.entriesScanned++;
        entriesTouchedThisCall++;
        record = readRecordEntry(entry, source, storeNamespace);
        if (ArchivalRecordEntry.is(entry)) {
          observeArchivalEntry(state.sourceObservation, source, entryId, record, storeNamespace);
        } else {
          state.sourceObservation.foreignEntriesObserved++;
        }
        if (record === null) {
          state.coverage.entriesUnsearchable++;
          state.currentSourceHasCaveat = true;
          state.currentEntryClassified = false;
          state.currentEntryHasSearchableUnit = false;
          state.currentEntryHasValidUnit = false;
          state.nextEntryId = entryId + 1;
          state.nextUnit = 0;
          if (!Number.isSafeInteger(state.nextEntryId)) {
            throw new ArchivalSearchBoundsError("entry-id");
          }
          if (entriesTouchedThisCall >= limits.maxScanEntries) {
            state.stopReason = "max-entries";
            stopped = true;
            break;
          }
          continue;
        }
        state.currentEntryClassified = false;
        state.currentEntryHasSearchableUnit = false;
        state.currentEntryHasValidUnit = false;
        const classification = classifyRecord(record, state.coverage);
        if (classification.caveat) state.currentSourceHasCaveat = true;
        if (!classification.resumable) {
          state.nextEntryId = entryId + 1;
          state.nextUnit = 0;
          if (!Number.isSafeInteger(state.nextEntryId)) {
            throw new ArchivalSearchBoundsError("entry-id");
          }
          if (entriesTouchedThisCall >= limits.maxScanEntries) {
            state.stopReason = "max-entries";
            stopped = true;
            break;
          }
          continue;
        }
        state.currentEntryClassified = true;
        state.currentEntry = {
          line: record.line,
          durableKey: record.durableKey,
          unitCount: record.search.length,
          fingerprint: entryFingerprint(entryId, record),
        };
        searchableEntry = true;
        unitCount = record.search.length;
      } else {
        entriesTouchedThisCall++;
        record = readRecordEntry(entry, source, storeNamespace);
        if (record === null || !isSearchableRecord(record)) {
          throw new ArchivalSearchContinuationError("Archival search continuation no longer names a searchable archival entry");
        }
        const expectedEntry = state.currentEntry;
        if (expectedEntry === null ||
            record.line !== expectedEntry.line ||
            record.durableKey !== expectedEntry.durableKey ||
            record.search.length !== expectedEntry.unitCount ||
            entryFingerprint(entryId, record) !== expectedEntry.fingerprint) {
          throw new ArchivalSearchContinuationError("Archival search continuation in-flight entry changed");
        }
        if (record.durableKey !== durableKeyFor(storeNamespace, source.sourceId, record.line)) {
          state.sourceObservation.identityMismatch = true;
          state.currentSourceHasCaveat = true;
        }
        unitCount = record.search.length;
        if (state.nextUnit > unitCount) {
          throw new ArchivalSearchContinuationError("Archival search continuation unit position is invalid");
        }
        if (state.nextUnit === unitCount) {
          finishCurrentEntry(record);
          state.nextEntryId = entryId + 1;
          state.nextUnit = 0;
          if (!Number.isSafeInteger(state.nextEntryId)) {
            throw new ArchivalSearchBoundsError("entry-id");
          }
          if (entriesTouchedThisCall >= limits.maxScanEntries) {
            state.stopReason = "max-entries";
            stopped = true;
            break;
          }
          continue;
        }
        searchableEntry = true;
      }

      if (!searchableEntry || record === null) {
        throw new ArchivalSearchCorruptionError("Archival carrier entry classification was lost");
      }
      let entryStopped = false;
      for (let unitIndex = state.nextUnit; unitIndex < unitCount; unitIndex++) {
        if (state.hits.length >= limits.maxHits) {
          state.nextEntryId = entryId;
          state.nextUnit = unitIndex;
          state.stopReason = "max-hits";
          entryStopped = true;
          break;
        }
        if (unitsScannedThisCall >= limits.maxScanUnits) {
          state.nextEntryId = entryId;
          state.nextUnit = unitIndex;
          state.stopReason = "max-units";
          entryStopped = true;
          break;
        }
        const coverageBeforeUnit = { ...state.coverage };
        const hasSearchableUnitBeforeUnit = state.currentEntryHasSearchableUnit;
        const hasValidUnitBeforeUnit = state.currentEntryHasValidUnit;
        const caveatBeforeUnit = state.currentSourceHasCaveat;
        const hitsBeforeUnit = state.hits.length;
        state.coverage.unitsScanned++;
        unitsScannedThisCall++;
        const unit = readUnit(record.search[unitIndex], unitIndex);
        if (unit === null) {
          state.coverage.unitsInvalid++;
          state.currentSourceHasCaveat = true;
          continue;
        }
        state.currentEntryHasValidUnit = true;
        if (unit.text.length === 0) continue;
        state.currentEntryHasSearchableUnit = true;
        if (query.role !== null && (unit.role ?? record.role) !== query.role) continue;
        const match = matcher(unit.text);
        if (match === null) continue;
        const hit = buildHit(
          record,
          source,
          unit,
          match,
          limits,
          entryId,
        );
        state.coverage.hits++;
        state.hits.push(hit);
        // A hit-level checkpoint lets output trimming keep earlier hits and
        // resume exactly at this unit, even when this is the first unit of a
        // large entry (entryClassified remains true, so it is not recounted).
        state.hitCheckpoints.push({
          entryId,
          sourceIndex: state.sourceIndex,
          nextUnit: unitIndex,
          entryClassified: true,
          hasSearchableUnit: hasSearchableUnitBeforeUnit,
          hasValidUnit: hasValidUnitBeforeUnit,
          currentEntry: state.currentEntry,
          sourceObservation: { ...state.sourceObservation },
          coverage: coverageBeforeUnit,
          currentSourceHasCaveat: caveatBeforeUnit,
          hitsBefore: hitsBeforeUnit,
        });
      }
      if (entryStopped) {
        stopped = true;
        break;
      }
      finishCurrentEntry(record);
      state.nextEntryId = entryId + 1;
      state.nextUnit = 0;
      if (!Number.isSafeInteger(state.nextEntryId)) {
        throw new ArchivalSearchBoundsError("entry-id");
      }
      if (state.hits.length >= limits.maxHits) {
        state.stopReason = "max-hits";
        stopped = true;
        break;
      }
      if (entriesTouchedThisCall >= limits.maxScanEntries) {
        state.stopReason = "max-entries";
        stopped = true;
        break;
      }
      if (unitsScannedThisCall >= limits.maxScanUnits) {
        state.stopReason = "max-units";
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    // The page is exhausted; keep the same source and fetch its next entry-ID page.
  }

  let page = buildPage({
    ledgerPresent,
    ledgerSources,
    storeNamespace,
    ledgerSha256,
    query,
    limits,
    state,
    startCoverage,
  });
  let json = JSON.stringify(page);
  while (json.length > limits.maxOutputChars) {
    const checkpoint = state.hitCheckpoints.pop();
    if (checkpoint === undefined) throw new ArchivalSearchBoundsError("output-chars");
    state.coverage = { ...checkpoint.coverage };
    state.sourceIndex = checkpoint.sourceIndex;
    state.nextEntryId = checkpoint.entryId;
    state.nextUnit = checkpoint.nextUnit;
    state.currentEntryClassified = checkpoint.entryClassified;
    state.currentEntryHasSearchableUnit = checkpoint.hasSearchableUnit;
    state.currentEntryHasValidUnit = checkpoint.hasValidUnit;
    state.currentEntry = checkpoint.currentEntry;
    state.sourceObservation = { ...checkpoint.sourceObservation };
    state.currentSourceHasCaveat = checkpoint.currentSourceHasCaveat;
    state.hits.length = checkpoint.hitsBefore;
    state.stopReason = "max-output-chars";
    const progressed = checkpoint.coverage.sourcesConsidered > startCoverage.sourcesConsidered ||
      checkpoint.coverage.entriesScanned > startCoverage.entriesScanned ||
      checkpoint.coverage.unitsScanned > startCoverage.unitsScanned ||
      checkpoint.coverage.hits > startCoverage.hits;
    if (state.hits.length === 0 && !progressed) {
      throw new ArchivalSearchBoundsError("output-chars");
    }
    page = buildPage({
      ledgerPresent,
      ledgerSources,
      storeNamespace,
      ledgerSha256,
      query,
      limits,
      state,
      startCoverage,
    });
    json = JSON.stringify(page);
  }
  if (json.length > limits.maxOutputChars) throw new ArchivalSearchBoundsError("output-chars");
  return deepFreeze(page);
}
