/**
 * Transactional, data-only persistence for bounded legacy Python archive
 * preparation reports.
 *
 * The input boundary is the host's original snapshots: preparation is always
 * recomputed by `prepareArchivalImport`, so a caller cannot supply forged
 * prepared records. Each prepared physical line is stored verbatim as an inert
 * custom Durable entry. No model entry, task, submission, live session-map row,
 * search index, or resumed Python state is created.
 */
import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineEntry,
  type ConversationId,
  type EntryId,
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  prepareArchivalImport,
  type ArchivalImportRequest,
  type ArchivalPreparationOptions,
  type ArchivalPreparationReport,
  type ArchivalSourcePreparation,
  type PreparedArchivalRecord,
} from "../archival-import/index.js";

export const ARCHIVAL_PERSISTENCE_FORMAT = "nanobot-archival-import-persistence" as const;
export const ARCHIVAL_PERSISTENCE_VERSION = 1 as const;
export const ARCHIVAL_LEDGER_FORMAT = "nanobot-archival-import-ledger" as const;
export const ARCHIVAL_LEDGER_VERSION = 1 as const;
export const ARCHIVAL_RECORD_ENTRY_KIND = "nanobot.archival-record.v1" as const;
export const ARCHIVAL_RECORD_SCHEMA = "nanobot.archival-record" as const;

/** Defaults allow any report the preparation defaults can produce. */
export const ARCHIVAL_PERSISTENCE_LIMITS = Object.freeze({
  maxSources: 32,
  maxRecordsPerSource: 100_000,
  maxRecords: 100_000,
  maxRawBytesPerSource: 4 * 1024 * 1024,
  maxRawBytes: 16 * 1024 * 1024,
  maxSearchUnitsPerSource: 200_000,
  maxSearchUnits: 200_000,
  maxLedgerSources: 512,
});

const HARD_LIMITS = Object.freeze({
  maxSources: 128,
  maxRecordsPerSource: 250_000,
  maxRecords: 250_000,
  maxRawBytesPerSource: 16 * 1024 * 1024,
  maxRawBytes: 64 * 1024 * 1024,
  maxSearchUnitsPerSource: 500_000,
  maxSearchUnits: 500_000,
  maxLedgerSources: 1_024,
});

export interface ArchivalPersistenceLimits {
  readonly maxSources: number;
  readonly maxRecordsPerSource: number;
  readonly maxRecords: number;
  readonly maxRawBytesPerSource: number;
  readonly maxRawBytes: number;
  readonly maxSearchUnitsPerSource: number;
  readonly maxSearchUnits: number;
  readonly maxLedgerSources: number;
}

export interface ArchivalPersistenceOptions {
  readonly limits?: Partial<ArchivalPersistenceLimits>;
  /** Forwarded to the pure preparation step; this module always recomputes it. */
  readonly preparation?: ArchivalPreparationOptions;
}

export type ArchivalPersistenceSourceStatus =
  | "persisted"
  | "already-persisted"
  | "unsupported-not-persisted";

export interface ArchivalPersistenceSourceResult {
  readonly sourceId: string;
  readonly format: string;
  readonly provenance: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly status: ArchivalPersistenceSourceStatus;
  readonly preparationStatus: "complete" | "incomplete" | "unsupported";
  readonly conversationId: number | null;
  readonly recordsPersisted: number;
  readonly recordsTotal: number;
  readonly firstOrdinal: number | null;
  readonly lastOrdinal: number | null;
}

export interface ArchivalPersistenceReport {
  readonly format: typeof ARCHIVAL_PERSISTENCE_FORMAT;
  readonly version: typeof ARCHIVAL_PERSISTENCE_VERSION;
  readonly storeNamespace: string;
  readonly disposition: "archive-only-never-resume-or-replay";
  readonly preparation: Readonly<{
    readonly format: string;
    readonly version: number;
    readonly complete: boolean;
    readonly recordsPrepared: number;
    readonly quarantinedRecords: number;
    readonly diagnostics: number;
  }>;
  readonly persistencePerformed: boolean;
  readonly newSourcesPersisted: number;
  readonly alreadyPersistedSources: number;
  readonly unsupportedSourcesNotPersisted: number;
  readonly counts: Readonly<{
    readonly sources: number;
    readonly recordsPersisted: number;
    readonly recordsAlreadyPresent: number;
    readonly searchUnitsPersisted: number;
  }>;
  readonly sources: readonly ArchivalPersistenceSourceResult[];
  /** Explicit non-claims for this slice; a future search/import layer is separate. */
  readonly searchIndexed: false;
  readonly runnableStateCreated: false;
  readonly sessionMapUpdated: false;
  readonly cursorAdvanced: false;
  readonly modelEntriesCreated: false;
  readonly tasksCreated: false;
  readonly submissionsCreated: false;
  readonly reviewRequired: true;
  readonly limitations: readonly string[];
}

export interface ArchivalLedgerSource {
  readonly [key: string]: JsonValue;
  readonly sourceId: string;
  readonly format: string;
  readonly provenance: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly lineCount: number | null;
  readonly preparationStatus: "complete" | "incomplete" | "unsupported";
  readonly preparationFormat: string;
  readonly preparationVersion: number;
  readonly recordCount: number;
  readonly searchUnitCount: number;
  readonly conversationId: number | null;
  readonly firstEntryId: number | null;
  readonly lastEntryId: number | null;
  readonly firstOrdinal: number | null;
  readonly lastOrdinal: number | null;
}

export interface ArchivalLedgerState {
  readonly [key: string]: JsonValue;
  readonly format: typeof ARCHIVAL_LEDGER_FORMAT;
  readonly version: typeof ARCHIVAL_LEDGER_VERSION;
  /** One legacy store namespace per database; a second, different value is rejected. */
  readonly storeNamespace: string | null;
  readonly sources: ArchivalLedgerSource[];
}

export interface ArchivalPersistedSearchUnit {
  readonly [key: string]: JsonValue;
  readonly unit: number;
  readonly kind: string;
  readonly role: string | null;
  readonly timestamp: string | null;
  readonly name: string | null;
  readonly entryId: string | null;
  readonly text: string;
}

/** Exact prepared line plus its source provenance, stored as inert custom entry data. */
export interface ArchivalRecordEntryData {
  readonly [key: string]: JsonValue;
  readonly schema: typeof ARCHIVAL_RECORD_SCHEMA;
  readonly schemaVersion: 1;
  readonly storeNamespace: string;
  readonly sourceId: string;
  readonly sourceFormat: string;
  readonly sourceProvenance: string;
  readonly sourceSha256: string;
  readonly recordVersion: number;
  readonly ordinal: number;
  readonly sourceOrder: number;
  readonly line: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly lineTerminated: boolean;
  readonly lineSha256: string;
  readonly category: string;
  readonly status: "prepared" | "quarantined";
  readonly quarantineReason: string | null;
  readonly opaque: boolean;
  readonly searchStatus: "complete" | "partial" | "none";
  readonly disposition: "archive-only-never-resume-or-replay";
  readonly sessionKey: string | null;
  readonly timestamp: string | null;
  readonly role: string | null;
  readonly archiveCursor: number | null;
  readonly search: ArchivalPersistedSearchUnit[];
  readonly rawLineBase64: string;
  readonly rawLineEncoding: "base64";
}

export const ArchivalImportLedgerDoc = defineDoc<ArchivalLedgerState>({
  kind: ARCHIVAL_LEDGER_FORMAT,
  version: ARCHIVAL_LEDGER_VERSION,
  scope: "session",
  initial: () => ({
    format: ARCHIVAL_LEDGER_FORMAT,
    version: ARCHIVAL_LEDGER_VERSION,
    storeNamespace: null,
    sources: [],
  }),
  checkpointWhen: () => true,
});

/** Custom entry kind with no `model` payload, so Durable never sends it to a model. */
export const ArchivalRecordEntry = defineEntry<ArchivalRecordEntryData>(ARCHIVAL_RECORD_ENTRY_KIND);

export class ArchivalPersistenceBoundsError extends RangeError {
  readonly code = "archival_import_persistence_bound_exceeded";

  constructor(bound: string) {
    super(`Archival import persistence exceeds the ${bound} bound`);
    this.name = "ArchivalPersistenceBoundsError";
  }
}

export class ArchivalPersistenceInputError extends TypeError {
  readonly code = "archival_import_persistence_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalPersistenceInputError";
  }
}

export class ArchivalPersistenceConflictError extends Error {
  readonly code = "archival_import_persistence_conflict";
  readonly sourceId: string;

  constructor(sourceId: string, message: string) {
    super(message);
    this.name = "ArchivalPersistenceConflictError";
    this.sourceId = sourceId;
  }
}

export class ArchivalPersistenceCorruptionError extends Error {
  readonly code = "archival_import_persistence_corruption";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalPersistenceCorruptionError";
  }
}

const LIMITATIONS: readonly string[] = Object.freeze([
  "Raw transcript, metadata, provider-state, and quarantined line bytes are stored unredacted as base64; base64 is encoding, not encryption.",
  "No search index is built and no search API is exposed by this slice; inert custom entries remain to be indexed by a separate reviewed layer.",
  "Each supported source is stored in its own ownerless Durable conversation. That carrier is archival-only: it is not the runtime session map and is never resumed or replayed.",
  "One legacy store namespace is allowed per database. A later import with a different namespace is rejected instead of mixing store-local session keys.",
  "Unsupported source formats are recorded in the ledger with zero records; this slice does not persist their raw bytes.",
  "Persisted timestamps, session keys, entry IDs, and archive cursor values are historical data. No archive cursor is advanced and no Python session is continued.",
  "Line identity is provenance, never a deduplication key. Identical lines at different physical positions are stored as separate entries.",
]);

const SUPPORTED_SEARCH_UNIT_KINDS = new Set([
  "session-message",
  "archive-message",
  "history-message",
  "history-content",
  "history-summary",
]);
const RECORD_STATUSES = new Set(["prepared", "quarantined"]);
const SEARCH_STATUSES = new Set(["complete", "partial", "none"]);
const KNOWN_CATEGORIES = new Set([
  "session-header",
  "session-message",
  "provider-state",
  "archive-header",
  "archive-message",
  "history-entry",
  "blank-line",
  "quarantined-line",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

type MutableLimits = { -readonly [K in keyof ArchivalPersistenceLimits]: ArchivalPersistenceLimits[K] };

function normalizedLimits(input: unknown): ArchivalPersistenceLimits {
  try {
    return normalizedLimitsValue(input);
  } catch (error) {
    if (error instanceof ArchivalPersistenceInputError || error instanceof ArchivalPersistenceBoundsError) {
      throw error;
    }
    throw new ArchivalPersistenceInputError("Archival persistence limits are unreadable");
  }
}

function normalizedLimitsValue(input: unknown): ArchivalPersistenceLimits {
  const result: MutableLimits = { ...ARCHIVAL_PERSISTENCE_LIMITS };
  if (input === undefined) return result;
  if (!isRecord(input)) {
    throw new ArchivalPersistenceInputError("Archival persistence limits must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ARCHIVAL_PERSISTENCE_LIMITS, key)) {
      throw new ArchivalPersistenceInputError("Unknown archival persistence limit property");
    }
  }
  for (const key of Object.keys(ARCHIVAL_PERSISTENCE_LIMITS) as (keyof ArchivalPersistenceLimits)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isSafePositiveInteger(value) || value > HARD_LIMITS[key]) {
      throw new ArchivalPersistenceInputError(`Invalid archival persistence bound: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

interface ValidatedSource {
  readonly source: ArchivalSourcePreparation;
  readonly records: readonly PreparedArchivalRecord[];
}

function expectedSourceStatus(source: ArchivalSourcePreparation): "complete" | "incomplete" | "unsupported" {
  if (source.status === "unsupported") return "unsupported";
  return source.status;
}

/**
 * Re-validate the internally recomputed preparation report before writing:
 * ordinal order, exact raw-line reconstruction, hashes, and every bound.
 */
function validatePreparedReport(
  report: ArchivalPreparationReport,
  limits: ArchivalPersistenceLimits,
): readonly ValidatedSource[] {
  if (report.format !== "nanobot-archival-import-preparation" || report.version !== 1) {
    throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation has an unexpected format or version");
  }
  if (!Array.isArray(report.sources) || !Array.isArray(report.records)) {
    throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation is malformed");
  }
  if (report.sources.length > limits.maxSources) {
    throw new ArchivalPersistenceBoundsError("source-count");
  }
  if (report.records.length > limits.maxRecords) {
    throw new ArchivalPersistenceBoundsError("record-count");
  }

  const sourceIndex = new Map<string, number>();
  report.sources.forEach((source, index) => {
    if (sourceIndex.has(source.sourceId)) {
      throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation repeats a sourceId");
    }
    sourceIndex.set(source.sourceId, index);
  });

  const grouped = new Map<string, PreparedArchivalRecord[]>();
  report.records.forEach((record, index) => {
    if (record.ordinal !== index) {
      throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation ordinals are not contiguous");
    }
    const order = sourceIndex.get(record.sourceId);
    if (order === undefined) {
      throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation has a record for an unknown source");
    }
    if (record.sourceOrder !== order) {
      throw new ArchivalPersistenceCorruptionError("Recomputed archival preparation has an inconsistent sourceOrder");
    }
    const list = grouped.get(record.sourceId);
    if (list) list.push(record);
    else grouped.set(record.sourceId, [record]);
  });

  const validated: ValidatedSource[] = [];
  let totalRawBytes = 0;
  let totalSearchUnits = 0;
  for (const [index, source] of report.sources.entries()) {
    const records = grouped.get(source.sourceId) ?? [];
    if (source.status === "unsupported") {
      if (records.length !== 0 || source.lineCount !== null || source.recordsEmitted !== 0) {
        throw new ArchivalPersistenceCorruptionError(`Unsupported source ${source.sourceId} unexpectedly produced records`);
      }
    } else if (records.length !== source.recordsEmitted || source.lineCount !== records.length) {
      throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} record count does not match its physical line count`);
    }
    if (records.length > limits.maxRecordsPerSource) {
      throw new ArchivalPersistenceBoundsError("record-count-per-source");
    }

    let expectedLine = 1;
    let expectedOffset = 0;
    let searchUnits = 0;
    for (const record of records) {
      validateRecord(record, source, index, expectedLine, expectedOffset, limits);
      const raw = decodeExactBase64(record.rawLineBase64, record.byteLength);
      if (sha256(raw) !== record.lineSha256) {
        throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} line ${record.line} failed raw-byte verification`);
      }
      if (record.lineTerminated) {
        if (raw[raw.length - 1] !== 0x0a) {
          throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} line ${record.line} is not LF-terminated`);
        }
      } else if (record.line + 1 <= records.length) {
        throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} has an unterminated non-final line`);
      }
      searchUnits += record.search.length;
      if (searchUnits > limits.maxSearchUnitsPerSource) {
        throw new ArchivalPersistenceBoundsError("search-unit-per-source");
      }
      expectedLine += 1;
      expectedOffset += record.byteLength;
    }
    if (source.status !== "unsupported" && expectedOffset !== source.byteLength) {
      throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} raw records do not reconstruct the source length`);
    }
    totalRawBytes += source.byteLength;
    if (source.byteLength > limits.maxRawBytesPerSource) {
      throw new ArchivalPersistenceBoundsError("raw-byte-per-source");
    }
    if (totalRawBytes > limits.maxRawBytes) {
      throw new ArchivalPersistenceBoundsError("raw-byte");
    }
    totalSearchUnits += searchUnits;
    if (searchUnits !== source.searchUnitsEmitted) {
      throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} search-unit count is inconsistent`);
    }
    if (totalSearchUnits > limits.maxSearchUnits) {
      throw new ArchivalPersistenceBoundsError("search-unit");
    }
    validated.push({ source, records });
  }
  return validated;
}

function validateRecord(
  record: PreparedArchivalRecord,
  source: ArchivalSourcePreparation,
  sourceOrder: number,
  expectedLine: number,
  expectedOffset: number,
  limits: ArchivalPersistenceLimits,
): void {
  if (record.recordVersion !== 1) {
    throw new ArchivalPersistenceCorruptionError("Prepared record has an unexpected recordVersion");
  }
  if (record.sourceId !== source.sourceId || record.sourceSha256 !== source.sha256) {
    throw new ArchivalPersistenceCorruptionError("Prepared record source identity does not match its source");
  }
  if (record.sourceOrder !== sourceOrder || record.line !== expectedLine || record.byteOffset !== expectedOffset) {
    throw new ArchivalPersistenceCorruptionError("Prepared record physical position is inconsistent");
  }
  if (!isSafePositiveInteger(record.line) || !isSafeNonNegativeInteger(record.byteOffset) ||
      !isSafeNonNegativeInteger(record.byteLength)) {
    throw new ArchivalPersistenceCorruptionError("Prepared record has invalid physical bounds");
  }
  if (record.byteOffset + record.byteLength > source.byteLength) {
    throw new ArchivalPersistenceCorruptionError("Prepared record exceeds its source bytes");
  }
  if (typeof record.lineTerminated !== "boolean" || record.rawLineEncoding !== "base64" ||
      typeof record.rawLineBase64 !== "string" ||
      record.disposition !== "archive-only-never-resume-or-replay") {
    throw new ArchivalPersistenceCorruptionError("Prepared record has invalid archival disposition or encoding");
  }
  if (!KNOWN_CATEGORIES.has(record.category) || !RECORD_STATUSES.has(record.status) ||
      !SEARCH_STATUSES.has(record.searchStatus) || typeof record.opaque !== "boolean") {
    throw new ArchivalPersistenceCorruptionError("Prepared record has invalid classification fields");
  }
  if (record.status === "quarantined" && record.quarantineReason === null) {
    throw new ArchivalPersistenceCorruptionError("Quarantined record has no reason");
  }
  if (!Array.isArray(record.search) || record.search.length > limits.maxSearchUnits) {
    throw new ArchivalPersistenceCorruptionError("Prepared record has malformed search units");
  }
  record.search.forEach((unit, index) => {
    if (unit.unit !== index || !SUPPORTED_SEARCH_UNIT_KINDS.has(unit.kind) || typeof unit.text !== "string") {
      throw new ArchivalPersistenceCorruptionError("Prepared record has a malformed search unit");
    }
  });
}

/** Strict canonical base64 decode; rejects whitespace, padding tricks, and length drift. */
function decodeExactBase64(value: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ArchivalPersistenceCorruptionError("Prepared raw line is not canonical base64");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.length !== expectedLength || raw.toString("base64") !== value) {
    throw new ArchivalPersistenceCorruptionError("Prepared raw line bytes do not match their declared length");
  }
  return raw;
}

function toEntryData(report: ArchivalPreparationReport, source: ArchivalSourcePreparation, record: PreparedArchivalRecord): ArchivalRecordEntryData {
  return {
    schema: ARCHIVAL_RECORD_SCHEMA,
    schemaVersion: 1,
    storeNamespace: report.storeNamespace,
    sourceId: source.sourceId,
    sourceFormat: source.format,
    sourceProvenance: source.provenance,
    sourceSha256: source.sha256,
    recordVersion: record.recordVersion,
    ordinal: record.ordinal,
    sourceOrder: record.sourceOrder,
    line: record.line,
    byteOffset: record.byteOffset,
    byteLength: record.byteLength,
    lineTerminated: record.lineTerminated,
    lineSha256: record.lineSha256,
    category: record.category,
    status: record.status,
    quarantineReason: record.quarantineReason,
    opaque: record.opaque,
    searchStatus: record.searchStatus,
    disposition: record.disposition,
    sessionKey: record.sessionKey,
    timestamp: record.timestamp,
    role: record.role,
    archiveCursor: record.archiveCursor,
    search: record.search.map((unit) => ({
      unit: unit.unit,
      kind: unit.kind,
      role: unit.role,
      timestamp: unit.timestamp,
      name: unit.name,
      entryId: unit.entryId,
      text: unit.text,
    })),
    rawLineBase64: record.rawLineBase64,
    rawLineEncoding: "base64",
  };
}

function validConversationId(value: unknown): value is number {
  return isSafePositiveInteger(value);
}

function validEntryId(value: unknown): value is number {
  return isSafePositiveInteger(value);
}

/** Read the durable ledger without creating it. Returns `undefined` before the first import. */
export async function readArchivalImportLedger(
  session: Session,
  context: Context,
): Promise<ArchivalLedgerState | undefined> {
  return session.snapshot(ArchivalImportLedgerDoc, context);
}

/**
 * Verify one existing source against its ledger row. The commit that created
 * the conversation also created the ledger, so a missing carrier is corruption,
 * not a cue to re-append records.
 */
async function verifyExistingSource(
  tx: Tx,
  source: ArchivalSourcePreparation,
  existing: ArchivalLedgerSource,
): Promise<ConversationId | null> {
  if (source.status === "unsupported") {
    if (existing.conversationId !== null || existing.recordCount !== 0) {
      throw new ArchivalPersistenceCorruptionError(`Unsupported source ${source.sourceId} has persisted records`);
    }
    return null;
  }
  if (!validConversationId(existing.conversationId)) {
    throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} has no valid archival conversation`);
  }
  const conversationId = existing.conversationId as ConversationId;
  if ((await tx.conversation(conversationId)) === undefined) {
    throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} archival conversation is missing`);
  }
  if (existing.recordCount > 0) {
    if (!validEntryId(existing.firstEntryId) || !validEntryId(existing.lastEntryId)) {
      throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} has no valid first/last entry`);
    }
    for (const [entryId, expectedLine] of [
      [existing.firstEntryId, existing.firstOrdinal],
      [existing.lastEntryId, existing.lastOrdinal],
    ] as const) {
      const entry = await tx.entry(ArchivalRecordEntry, entryId as EntryId);
      if (!entry || entry.conversationId !== conversationId) {
        throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} archival entry is missing`);
      }
      if (entry.data.sourceId !== source.sourceId || entry.data.sourceSha256 !== source.sha256) {
        throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} archival entry provenance does not match its ledger`);
      }
      if (expectedLine !== null && entry.data.ordinal !== expectedLine) {
        throw new ArchivalPersistenceCorruptionError(`Source ${source.sourceId} archival entry ordinal does not match its ledger`);
      }
    }
  }
  return conversationId;
}

function ledgerSourceFromReport(
  report: ArchivalPreparationReport,
  source: ArchivalSourcePreparation,
  records: readonly PreparedArchivalRecord[],
  conversationId: number | null,
  firstEntryId: number | null,
  lastEntryId: number | null,
): ArchivalLedgerSource {
  return {
    sourceId: source.sourceId,
    format: source.format,
    provenance: source.provenance,
    sha256: source.sha256,
    byteLength: source.byteLength,
    lineCount: source.lineCount,
    preparationStatus: expectedSourceStatus(source),
    preparationFormat: report.format,
    preparationVersion: report.version,
    recordCount: records.length,
    searchUnitCount: source.searchUnitsEmitted,
    conversationId,
    firstEntryId,
    lastEntryId,
    firstOrdinal: records.length > 0 ? records[0]!.ordinal : null,
    lastOrdinal: records.length > 0 ? records[records.length - 1]!.ordinal : null,
  };
}

function assertLedgerShape(ledger: ArchivalLedgerState): void {
  if (ledger.format !== ARCHIVAL_LEDGER_FORMAT || ledger.version !== ARCHIVAL_LEDGER_VERSION ||
      !Array.isArray(ledger.sources) ||
      (ledger.storeNamespace !== null && typeof ledger.storeNamespace !== "string")) {
    throw new ArchivalPersistenceCorruptionError("Archival import ledger is malformed");
  }
  const seen = new Set<string>();
  for (const source of ledger.sources) {
    if (typeof source.sourceId !== "string" || seen.has(source.sourceId) ||
        typeof source.sha256 !== "string" || typeof source.format !== "string" ||
        typeof source.provenance !== "string" || typeof source.byteLength !== "number" ||
        !isSafeNonNegativeInteger(source.recordCount)) {
      throw new ArchivalPersistenceCorruptionError("Archival import ledger has a malformed source row");
    }
    seen.add(source.sourceId);
  }
}

function previousDigestDiffers(existing: ArchivalLedgerSource, source: ArchivalSourcePreparation): boolean {
  return existing.sha256 !== source.sha256;
}

export async function persistArchivalImport(
  session: Session,
  request: ArchivalImportRequest,
  context: Context,
  options: ArchivalPersistenceOptions = {},
): Promise<ArchivalPersistenceReport> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ArchivalPersistenceInputError("Archival persistence options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "limits" && key !== "preparation") {
      throw new ArchivalPersistenceInputError("Unknown archival persistence option property");
    }
  }
  const limits = normalizedLimits(options.limits);
  // Always recompute from the original host snapshots; no caller-prepared report is accepted.
  const report = prepareArchivalImport(request, options.preparation);
  const validated = validatePreparedReport(report, limits);

  const result = await session.commit(async (tx) => {
    const ledger = await tx.doc(ArchivalImportLedgerDoc);
    assertLedgerShape(ledger);
    if (ledger.storeNamespace !== null && ledger.storeNamespace !== report.storeNamespace) {
      throw new ArchivalPersistenceConflictError(
        report.storeNamespace,
        "Archival import database already holds a different store namespace",
      );
    }

    const sourceResults: ArchivalPersistenceSourceResult[] = [];
    const pending: ValidatedSource[] = [];
    const existingById = new Map(ledger.sources.map((entry) => [entry.sourceId, entry]));

    // Preflight every source before staging a conversation or entry write.
    for (const item of validated) {
      const { source, records } = item;
      const existing = existingById.get(source.sourceId);
      if (existing) {
        if (previousDigestDiffers(existing, source)) {
          throw new ArchivalPersistenceConflictError(
            source.sourceId,
            `Archival source ${source.sourceId} is already persisted with a different digest`,
          );
        }
        if (existing.format !== source.format || existing.provenance !== source.provenance ||
            existing.byteLength !== source.byteLength || existing.lineCount !== source.lineCount ||
            existing.preparationStatus !== expectedSourceStatus(source) ||
            existing.preparationFormat !== report.format || existing.preparationVersion !== report.version) {
          throw new ArchivalPersistenceConflictError(
            source.sourceId,
            `Archival source ${source.sourceId} metadata does not match its existing identity`,
          );
        }
        const conversationId = await verifyExistingSource(tx, source, existing);
        sourceResults.push({
          sourceId: source.sourceId,
          format: source.format,
          provenance: source.provenance,
          sha256: source.sha256,
          byteLength: source.byteLength,
          status: "already-persisted",
          preparationStatus: expectedSourceStatus(source),
          conversationId: conversationId === null ? null : (conversationId as number),
          recordsPersisted: 0,
          recordsTotal: existing.recordCount,
          firstOrdinal: existing.firstOrdinal,
          lastOrdinal: existing.lastOrdinal,
        });
        continue;
      }
      if (ledger.sources.length + pending.length >= limits.maxLedgerSources) {
        throw new ArchivalPersistenceBoundsError("ledger-source-count");
      }
      pending.push(item);
    }

    // Stage all new sources after the preflight passes.
    for (const { source, records } of pending) {
      if (source.status === "unsupported") {
        ledger.sources.push(ledgerSourceFromReport(report, source, records, null, null, null));
        sourceResults.push({
          sourceId: source.sourceId,
          format: source.format,
          provenance: source.provenance,
          sha256: source.sha256,
          byteLength: source.byteLength,
          status: "unsupported-not-persisted",
          preparationStatus: "unsupported",
          conversationId: null,
          recordsPersisted: 0,
          recordsTotal: 0,
          firstOrdinal: null,
          lastOrdinal: null,
        });
        continue;
      }

      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      let firstEntryId: number | null = null;
      let lastEntryId: number | null = null;
      for (const record of records) {
        const entry = await tx.appendEntry(ArchivalRecordEntry, created.id, {
          data: toEntryData(report, source, record),
        });
        firstEntryId ??= entry.id as number;
        lastEntryId = entry.id as number;
      }
      ledger.sources.push(ledgerSourceFromReport(
        report,
        source,
        records,
        created.id as number,
        firstEntryId,
        lastEntryId,
      ));
      sourceResults.push({
        sourceId: source.sourceId,
        format: source.format,
        provenance: source.provenance,
        sha256: source.sha256,
        byteLength: source.byteLength,
        status: "persisted",
        preparationStatus: expectedSourceStatus(source),
        conversationId: created.id as number,
        recordsPersisted: records.length,
        recordsTotal: records.length,
        firstOrdinal: records.length > 0 ? records[0]!.ordinal : null,
        lastOrdinal: records.length > 0 ? records[records.length - 1]!.ordinal : null,
      });
    }

    if (ledger.storeNamespace === null) ledger.storeNamespace = report.storeNamespace;
    // Keep source order stable and the ledger deterministic for the same request.
    const requestOrder = new Map<string, number>();
    report.sources.forEach((source, index) => requestOrder.set(source.sourceId, index));
    sourceResults.sort((a, b) => (requestOrder.get(a.sourceId) ?? 0) - (requestOrder.get(b.sourceId) ?? 0));
    return sourceResults;
  }, context);

  const newSourcesPersisted = result.filter((source) => source.status === "persisted").length;
  const alreadyPersistedSources = result.filter((source) => source.status === "already-persisted").length;
  const unsupportedSourcesNotPersisted = result.filter((source) => source.status === "unsupported-not-persisted").length;
  const persistenceReport: ArchivalPersistenceReport = {
    format: ARCHIVAL_PERSISTENCE_FORMAT,
    version: ARCHIVAL_PERSISTENCE_VERSION,
    storeNamespace: report.storeNamespace,
    disposition: "archive-only-never-resume-or-replay",
    preparation: {
      format: report.format,
      version: report.version,
      complete: report.complete,
      recordsPrepared: report.records.length,
      quarantinedRecords: report.counts.quarantinedRecords ?? 0,
      diagnostics: report.diagnostics.length,
    },
    persistencePerformed: newSourcesPersisted > 0,
    newSourcesPersisted,
    alreadyPersistedSources,
    unsupportedSourcesNotPersisted,
    counts: {
      sources: result.length,
      recordsPersisted: result.reduce((sum, source) => sum + source.recordsPersisted, 0),
      recordsAlreadyPresent: result.reduce((sum, source) => sum + (source.status === "already-persisted" ? source.recordsTotal : 0), 0),
      searchUnitsPersisted: report.sources.reduce(
        (sum, source, index) => sum + (result[index]?.status === "persisted" ? source.searchUnitsEmitted : 0),
        0,
      ),
    },
    sources: result,
    searchIndexed: false,
    runnableStateCreated: false,
    sessionMapUpdated: false,
    cursorAdvanced: false,
    modelEntriesCreated: false,
    tasksCreated: false,
    submissionsCreated: false,
    reviewRequired: true,
    limitations: LIMITATIONS,
  };
  return deepFreeze(persistenceReport);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
