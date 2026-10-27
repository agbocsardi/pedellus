/**
 * Pure, bounded preparation of legacy Python session/history archives for a
 * future import transaction. This module never opens paths, never writes, and
 * never produces runnable session state: every record is archival-only.
 */
import { createHash } from "node:crypto";

export const ARCHIVAL_PREPARATION_FORMAT = "nanobot-archival-import-preparation" as const;
export const ARCHIVAL_PREPARATION_VERSION = 1 as const;
export const PREPARED_RECORD_VERSION = 1 as const;

/** Defaults are intentionally small enough for a reviewed dry run. */
export const ARCHIVAL_PREPARATION_LIMITS = Object.freeze({
  maxSources: 32,
  maxSourceBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxLinesPerSource: 100_000,
  maxRecords: 100_000,
  maxSearchUnits: 200_000,
  maxNestedReferences: 2_000,
  maxDiagnostics: 10_000,
});

const HARD_LIMITS = Object.freeze({
  maxSources: 128,
  maxSourceBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxLinesPerSource: 250_000,
  maxRecords: 250_000,
  maxSearchUnits: 500_000,
  maxNestedReferences: 10_000,
  maxDiagnostics: 100_000,
});

export interface ArchivalPreparationLimits {
  readonly maxSources: number;
  readonly maxSourceBytes: number;
  readonly maxTotalBytes: number;
  readonly maxLinesPerSource: number;
  readonly maxRecords: number;
  readonly maxSearchUnits: number;
  readonly maxNestedReferences: number;
  readonly maxDiagnostics: number;
}

export interface ArchivalPreparationOptions {
  readonly limits?: Partial<ArchivalPreparationLimits>;
}

/**
 * Host-supplied immutable-by-convention bytes. The host must compute
 * `sha256` over the exact bytes it intends to prepare; the module verifies the
 * digest, copies the bytes once, and never mutates the caller's buffer.
 */
export interface ArchivalSourceSnapshot {
  /** Opaque bounded label. Do not put paths, account names, or secrets here. */
  readonly sourceId: string;
  /** Lowercase hex SHA-256 of `bytes`, verified before parsing. */
  readonly sha256: string;
  /**
   * One of the supported formats, or any other string to request an explicit
   * unsupported-format classification. Supported values:
   * `session-jsonl`, `history-jsonl`, `session-archive-jsonl`.
   */
  readonly format: string;
  /** Opaque bounded label describing how this snapshot was obtained. */
  readonly provenance: string;
  readonly bytes: Uint8Array;
}

export interface ArchivalImportRequest {
  /**
   * The one legacy store/workspace namespace these snapshots belong to.
   * Session keys and archive cursors are store-local; mixing stores is rejected
   * by documentation and echoed here, not inferred from content.
   */
  readonly storeNamespace: string;
  readonly sources: readonly ArchivalSourceSnapshot[];
}

export type ArchivalRecordCategory =
  | "session-header"
  | "session-message"
  | "provider-state"
  | "archive-header"
  | "archive-message"
  | "history-entry"
  | "blank-line"
  | "quarantined-line";

export type ArchivalQuarantineReason =
  | "invalid-utf8"
  | "invalid-json"
  | "json-not-object"
  | "session-record-type-unknown"
  | "session-message-shape-invalid"
  | "archive-record-type-unknown"
  | "archive-message-shape-invalid"
  | "history-record-type-unknown"
  | "history-record-shape-invalid";

export type ArchivalSearchUnitKind =
  | "session-message"
  | "archive-message"
  | "history-message"
  | "history-content"
  | "history-summary";

export interface PreparedSearchUnit {
  /** Zero-based order within the physical line. */
  readonly unit: number;
  readonly kind: ArchivalSearchUnitKind;
  readonly role: string | null;
  readonly timestamp: string | null;
  readonly name: string | null;
  readonly entryId: string | null;
  /** Text-only projection. Non-text blocks, tool arguments and raw metadata are not indexed. */
  readonly text: string;
}

export interface PreparedArchivalRecord {
  readonly recordVersion: typeof PREPARED_RECORD_VERSION;
  /** Zero-based order across the whole preparation, in caller-supplied source order. */
  readonly ordinal: number;
  readonly sourceId: string;
  /** Zero-based caller-supplied source position. */
  readonly sourceOrder: number;
  readonly sourceSha256: string;
  /** One-based physical line number within the source. */
  readonly line: number;
  readonly byteOffset: number;
  /** Exact physical line length in bytes, including a trailing LF/CRLF when present. */
  readonly byteLength: number;
  readonly lineTerminated: boolean;
  /** SHA-256 over the exact physical line bytes, including a trailing LF/CRLF when present. */
  readonly lineSha256: string;
  readonly category: ArchivalRecordCategory;
  readonly status: "prepared" | "quarantined";
  readonly quarantineReason: ArchivalQuarantineReason | null;
  /** True when the payload is deliberately not interpreted beyond safe structural fields. */
  readonly opaque: boolean;
  readonly searchStatus: "complete" | "partial" | "none";
  readonly disposition: "archive-only-never-resume-or-replay";
  /** Allowlisted structural identity, copied without normalization. */
  readonly sessionKey: string | null;
  /** Raw timestamp string copied without normalization; null when absent or not a string. */
  readonly timestamp: string | null;
  readonly role: string | null;
  /** Python history cursor when present and a non-negative safe integer. */
  readonly archiveCursor: number | null;
  readonly search: readonly PreparedSearchUnit[];
  /** Exact physical line bytes, including any trailing LF/CRLF, base64 encoded. */
  readonly rawLineBase64: string;
  readonly rawLineEncoding: "base64";
}

export interface ArchivalSourcePreparation {
  readonly sourceId: string;
  readonly format: string;
  readonly provenance: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly status: "complete" | "unsupported";
  readonly lineCount: number | null;
  readonly recordsEmitted: number;
  readonly searchUnitsEmitted: number;
}

export interface ArchivalDiagnostic {
  /** Stable code only; never message content or parser error text. */
  readonly code: string;
  readonly sourceId: string;
  readonly line: number | null;
  readonly lineSha256: string | null;
}

export interface UnsupportedArchivalSource {
  readonly sourceId: string;
  readonly format: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly classification: "unsupported-source-format";
}

export interface UnsupportedArchivalSurface {
  readonly surface: string;
  readonly status: "not-read" | "not-inferred";
  readonly action: string;
}

export interface ArchivalPreparationReport {
  readonly format: typeof ARCHIVAL_PREPARATION_FORMAT;
  readonly version: typeof ARCHIVAL_PREPARATION_VERSION;
  readonly storeNamespace: string;
  readonly scope: "session-jsonl+history-jsonl+session-archive-jsonl";
  readonly importPerformed: false;
  readonly persistencePerformed: false;
  readonly ambientReadsPerformed: false;
  readonly replayPerformed: false;
  readonly runtimeActionsPrepared: 0;
  readonly complete: boolean;
  readonly reviewRequired: true;
  readonly disposition: "archive-only-never-resume-or-replay";
  readonly bounds: Readonly<{
    limits: ArchivalPreparationLimits;
    inputBytes: number;
    acceptedBytes: number;
    hashedBytes: number;
    linesVisited: number;
    recordsEmitted: number;
    searchUnitsEmitted: number;
  }>;
  readonly counts: Readonly<Record<string, number>>;
  readonly sources: readonly ArchivalSourcePreparation[];
  readonly records: readonly PreparedArchivalRecord[];
  readonly unsupportedSources: readonly UnsupportedArchivalSource[];
  readonly unsupportedSurfaces: readonly UnsupportedArchivalSurface[];
  readonly diagnostics: readonly ArchivalDiagnostic[];
}

export class ArchivalPreparationBoundsError extends RangeError {
  readonly code = "archival_import_bound_exceeded";

  constructor(bound: string) {
    super(`Archival import preparation exceeds the ${bound} bound`);
    this.name = "ArchivalPreparationBoundsError";
  }
}

export class ArchivalPreparationInputError extends TypeError {
  readonly code = "archival_import_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ArchivalPreparationInputError";
  }
}

const SUPPORTED_FORMATS = new Set(["session-jsonl", "history-jsonl", "session-archive-jsonl"]);
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KNOWN_ROLES = new Set(["user", "assistant", "tool", "system"]);

const UNSUPPORTED_SURFACES: readonly UnsupportedArchivalSurface[] = Object.freeze([
  {
    surface: "archive-batch container formats (tar, zip, multi-file manifests, or directory discovery)",
    status: "not-read",
    action: "Supply one JSONL transcript archive at a time as session-archive-jsonl; this module never opens directories.",
  },
  {
    surface: "Python sessions/archive/<key>/<fingerprint>.jsonl transcript batches",
    status: "not-inferred",
    action: "Supported only when supplied explicitly as session-archive-jsonl; content-addressed filenames and cross-batch duplicate text are not deduplicated.",
  },
  {
    surface: "memory files, Dream history/cursors, HISTORY.md, action receipts, approvals, goals, cron, pairing, skills, and media",
    status: "not-read",
    action: "Prepare separately with explicit provenance; never derive runnable actions from archived records.",
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedLimits(input: Partial<ArchivalPreparationLimits> | undefined): ArchivalPreparationLimits {
  const result = { ...ARCHIVAL_PREPARATION_LIMITS, ...(input ?? {}) };
  for (const key of Object.keys(ARCHIVAL_PREPARATION_LIMITS) as (keyof ArchivalPreparationLimits)[]) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
      throw new ArchivalPreparationInputError(`Invalid archival preparation bound: ${key}`);
    }
  }
  return result;
}

interface PhysicalLine {
  readonly number: number;
  readonly byteOffset: number;
  readonly bytes: Buffer;
  readonly jsonBytes: Buffer;
  readonly terminated: boolean;
}

function *physicalLines(bytes: Buffer): Generator<PhysicalLine> {
  let start = 0;
  let number = 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    const end = i + 1;
    let jsonEnd = i;
    if (jsonEnd > start && bytes[jsonEnd - 1] === 0x0d) jsonEnd--;
    yield {
      number,
      byteOffset: start,
      bytes: bytes.subarray(start, end),
      jsonBytes: bytes.subarray(start, jsonEnd),
      terminated: true,
    };
    start = end;
    number++;
  }
  if (start < bytes.length) {
    yield {
      number,
      byteOffset: start,
      bytes: bytes.subarray(start),
      jsonBytes: bytes.subarray(start),
      terminated: false,
    };
  }
}

function countPhysicalLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return bytes[bytes.length - 1] === 0x0a ? count : count + 1;
}

function lineIsBlank(line: PhysicalLine): boolean {
  for (const byte of line.jsonBytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
  }
  return true;
}

function decodeLine(line: PhysicalLine): { status: "ok"; value: unknown } | { status: "quarantined"; reason: ArchivalQuarantineReason } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line.jsonBytes);
  } catch {
    return { status: "quarantined", reason: "invalid-utf8" };
  }
  try {
    return { status: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "quarantined", reason: "invalid-json" };
  }
}

function boundedString(value: unknown, max = 1_024): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Text-only search projection; raw bytes remain authoritative. */
function textProjection(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (isRecord(block)) {
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.content === "string") parts.push(block.content);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function searchUnit(
  unit: number,
  kind: ArchivalSearchUnitKind,
  role: string | null,
  timestamp: string | null,
  name: string | null,
  entryId: string | null,
  text: string,
): PreparedSearchUnit {
  return { unit, kind, role, timestamp, name, entryId, text };
}

interface ClassifiedLine {
  readonly category: ArchivalRecordCategory;
  readonly status: "prepared" | "quarantined";
  readonly quarantineReason: ArchivalQuarantineReason | null;
  readonly opaque: boolean;
  readonly searchStatus: "complete" | "partial" | "none";
  readonly sessionKey: string | null;
  readonly timestamp: string | null;
  readonly role: string | null;
  readonly archiveCursor: number | null;
  readonly units: readonly PreparedSearchUnit[];
  readonly diagnostics: readonly string[];
}

function blankLine(): ClassifiedLine {
  return {
    category: "blank-line",
    status: "prepared",
    quarantineReason: null,
    opaque: true,
    searchStatus: "none",
    sessionKey: null,
    timestamp: null,
    role: null,
    archiveCursor: null,
    units: [],
    diagnostics: [],
  };
}

function quarantined(reason: ArchivalQuarantineReason, diagnostics: readonly string[] = []): ClassifiedLine {
  return {
    category: "quarantined-line",
    status: "quarantined",
    quarantineReason: reason,
    opaque: true,
    searchStatus: "none",
    sessionKey: null,
    timestamp: null,
    role: null,
    archiveCursor: null,
    units: [],
    diagnostics,
  };
}

function sessionHeader(parsed: Record<string, unknown>): ClassifiedLine {
  const key = boundedString(parsed.key);
  const metadataIsObject = isRecord(parsed.metadata);
  return {
    category: "session-header",
    status: "prepared",
    quarantineReason: null,
    opaque: true,
    searchStatus: "none",
    sessionKey: key,
    timestamp: boundedString(parsed.updated_at, 64),
    role: null,
    archiveCursor: null,
    units: [],
    diagnostics: [
      ...(key === null ? ["session-header-key-invalid"] : []),
      ...(metadataIsObject ? [] : ["session-header-metadata-not-object"]),
    ],
  };
}

function providerState(): ClassifiedLine {
  return {
    category: "provider-state",
    status: "prepared",
    quarantineReason: null,
    opaque: true,
    searchStatus: "none",
    sessionKey: null,
    timestamp: null,
    role: null,
    archiveCursor: null,
    units: [],
    diagnostics: [],
  };
}

function archiveHeader(parsed: Record<string, unknown>): ClassifiedLine {
  const key = boundedString(parsed.key);
  return {
    category: "archive-header",
    status: "prepared",
    quarantineReason: null,
    opaque: true,
    searchStatus: "none",
    sessionKey: key,
    timestamp: null,
    role: null,
    archiveCursor: null,
    units: [],
    diagnostics: key === null ? ["archive-header-key-invalid"] : [],
  };
}

function messageLine(
  parsed: Record<string, unknown>,
  category: "session-message" | "archive-message",
  unitKind: "session-message" | "archive-message",
  sessionKey: string | null,
  nestedLimit: number,
): ClassifiedLine {
  const rawRole = parsed.role;
  const rawContent = parsed.content;
  const rawCalls = parsed.tool_calls;
  const rawMedia = parsed.media;
  const shapeInvalidReason: ArchivalQuarantineReason = category === "session-message"
    ? "session-message-shape-invalid"
    : "archive-message-shape-invalid";

  if (typeof rawRole !== "string" || rawRole.length === 0) return quarantined(shapeInvalidReason);
  if (!KNOWN_ROLES.has(rawRole)) return quarantined(shapeInvalidReason);
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) return quarantined(shapeInvalidReason);
  if (parsed.tool_call_id !== undefined && (typeof parsed.tool_call_id !== "string" || parsed.tool_call_id.length === 0)) {
    return quarantined(shapeInvalidReason);
  }
  if (rawMedia !== undefined && !Array.isArray(rawMedia)) return quarantined(shapeInvalidReason);
  if (Array.isArray(rawCalls) && rawCalls.length > nestedLimit) {
    throw new ArchivalPreparationBoundsError("nested-reference");
  }
  const nullContentAllowed = rawContent === null && (
    (rawRole === "assistant" && Array.isArray(rawCalls) && rawCalls.length > 0) ||
    (rawRole === "user" && Array.isArray(rawMedia) && rawMedia.length > 0)
  );
  if (typeof rawContent !== "string" && !Array.isArray(rawContent) && !nullContentAllowed) {
    return quarantined(shapeInvalidReason);
  }

  const timestamp = boundedString(parsed.timestamp, 64);
  const entryId = boundedString(parsed._entry_id, 512);
  const name = boundedString(parsed.name, 512);
  const text = textProjection(rawContent);
  const diagnostics: string[] = [];
  if (parsed.timestamp !== undefined && timestamp === null) diagnostics.push("message-timestamp-invalid");
  if (parsed._entry_id !== undefined && entryId === null) diagnostics.push("message-entry-id-invalid");
  if (parsed.name !== undefined && name === null) diagnostics.push("message-name-invalid");
  const units = text === null ? [] : [searchUnit(0, unitKind, rawRole, timestamp, name, entryId, text)];
  return {
    category,
    status: "prepared",
    quarantineReason: null,
    opaque: false,
    searchStatus: text === null ? "partial" : "complete",
    sessionKey,
    timestamp,
    role: rawRole,
    archiveCursor: null,
    units,
    diagnostics,
  };
}

function historyLine(parsed: Record<string, unknown>, nestedLimit: number): ClassifiedLine {
  if (parsed._type !== undefined) return quarantined("history-record-type-unknown");

  const rawTimestamp = parsed.timestamp;
  if (typeof rawTimestamp !== "string" || rawTimestamp.length > 64) {
    return quarantined("history-record-shape-invalid");
  }
  const rawSessionKey = parsed.session_key;
  if (rawSessionKey !== undefined && rawSessionKey !== null && typeof rawSessionKey !== "string") {
    return quarantined("history-record-shape-invalid");
  }
  const sessionKey = boundedString(rawSessionKey);
  const messages = parsed.messages;
  const hasMessages = Array.isArray(messages);
  if (messages !== undefined && !hasMessages) return quarantined("history-record-shape-invalid");
  const hasContent = typeof parsed.content === "string";
  const hasSummary = typeof parsed.summary === "string";
  if (!hasContent && !hasSummary && !hasMessages) return quarantined("history-record-shape-invalid");
  if (Array.isArray(messages) && messages.length > nestedLimit) {
    throw new ArchivalPreparationBoundsError("nested-reference");
  }

  const units: PreparedSearchUnit[] = [];
  const diagnostics: string[] = [];
  let partial = false;
  if (hasContent) units.push(searchUnit(units.length, "history-content", null, rawTimestamp, null, null, parsed.content as string));
  if (hasMessages) {
    for (const message of messages as unknown[]) {
      if (!isRecord(message)) {
        diagnostics.push("history-message-not-indexed");
        partial = true;
        continue;
      }
      const rawRole = message.role;
      const content = message.content;
      if (typeof rawRole !== "string" || rawRole.length === 0) {
        diagnostics.push("history-message-not-indexed");
        partial = true;
        continue;
      }
      const text = textProjection(content);
      if (text === null) {
        diagnostics.push("history-message-text-not-indexed");
        partial = true;
        continue;
      }
      units.push(searchUnit(
        units.length,
        "history-message",
        rawRole,
        boundedString(message.timestamp, 64),
        boundedString(message.name, 512),
        boundedString(message._entry_id, 512),
        text,
      ));
    }
  }
  if (hasSummary) {
    units.push(searchUnit(units.length, "history-summary", null, rawTimestamp, null, null, parsed.summary as string));
  }

  const rawCursor = parsed.cursor;
  const archiveCursor = nonNegativeInt(rawCursor);
  if (rawCursor !== undefined && archiveCursor === null) diagnostics.push("history-cursor-invalid");
  if (parsed.schema_version !== undefined && nonNegativeInt(parsed.schema_version) === null) {
    diagnostics.push("history-schema-version-invalid");
  }
  if (parsed.kind !== undefined && parsed.kind !== "conversation") diagnostics.push("history-kind-unrecognized");

  return {
    category: "history-entry",
    status: "prepared",
    quarantineReason: null,
    opaque: false,
    searchStatus: units.length === 0 ? "partial" : partial ? "partial" : "complete",
    sessionKey,
    timestamp: rawTimestamp,
    role: null,
    archiveCursor,
    units,
    diagnostics,
  };
}

function classifyLine(
  format: "session-jsonl" | "history-jsonl" | "session-archive-jsonl",
  parsed: unknown,
  currentSessionKey: string | null,
  nestedLimit: number,
): ClassifiedLine {
  if (!isRecord(parsed)) return quarantined("json-not-object");
  const recordType = parsed._type;
  if (format === "history-jsonl") return historyLine(parsed, nestedLimit);
  if (recordType === "metadata") {
    return format === "session-jsonl" ? sessionHeader(parsed) : quarantined("archive-record-type-unknown");
  }
  if (recordType === "provider_state") {
    return format === "session-jsonl" ? providerState() : quarantined("archive-record-type-unknown");
  }
  if (recordType === "transcript_archive") {
    return format === "session-archive-jsonl" ? archiveHeader(parsed) : quarantined("session-record-type-unknown");
  }
  if (recordType !== undefined) {
    return quarantined(format === "session-jsonl" ? "session-record-type-unknown" : "archive-record-type-unknown");
  }
  if (format === "session-jsonl") {
    return messageLine(parsed, "session-message", "session-message", currentSessionKey, nestedLimit);
  }
  return messageLine(parsed, "archive-message", "archive-message", currentSessionKey, nestedLimit);
}

interface WorkSource {
  readonly input: ArchivalSourceSnapshot;
  readonly sourceOrder: number;
  readonly bytes: Buffer | null;
  readonly sha256: string;
  readonly lineCount: number | null;
  readonly status: ArchivalSourcePreparation["status"];
  recordsEmitted: number;
  searchUnitsEmitted: number;
  sessionKey: string | null;
}

function validatedSource(value: unknown): ArchivalSourceSnapshot {
  if (!isRecord(value) || typeof value.sourceId !== "string" || !SAFE_LABEL.test(value.sourceId) ||
      typeof value.provenance !== "string" || !SAFE_LABEL.test(value.provenance) ||
      typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256) ||
      typeof value.format !== "string" || value.format.length > 160 ||
      !(value.bytes instanceof Uint8Array)) {
    throw new ArchivalPreparationInputError("Each archival source needs safe labels, a declared SHA-256, and bytes");
  }
  return {
    sourceId: value.sourceId,
    sha256: value.sha256,
    format: value.format,
    provenance: value.provenance,
    bytes: value.bytes,
  };
}

/** Prepare bounded archival records only; no import, persistence, or runtime state is created. */
export function prepareArchivalImport(
  request: ArchivalImportRequest,
  options: ArchivalPreparationOptions = {},
): ArchivalPreparationReport {
  const limits = normalizedLimits(options.limits);
  if (!isRecord(request) || typeof request.storeNamespace !== "string" || !SAFE_LABEL.test(request.storeNamespace)) {
    throw new ArchivalPreparationInputError("Archival import request needs one safe storeNamespace label");
  }
  if (!Array.isArray(request.sources)) throw new ArchivalPreparationInputError("Archival sources must be an array");
  if (request.sources.length > limits.maxSources) throw new ArchivalPreparationBoundsError("source-count");

  const seenSourceIds = new Set<string>();
  const works: WorkSource[] = [];
  const unsupportedSources: UnsupportedArchivalSource[] = [];
  let inputBytes = 0;
  let acceptedBytes = 0;

  for (const [sourceOrder, input] of request.sources.entries()) {
    const source = validatedSource(input);
    if (seenSourceIds.has(source.sourceId)) {
      throw new ArchivalPreparationInputError("Archival sourceId values must be unique within one store namespace");
    }
    seenSourceIds.add(source.sourceId);
    inputBytes += source.bytes.byteLength;
    if (source.bytes.byteLength > limits.maxSourceBytes) {
      throw new ArchivalPreparationBoundsError("source-byte");
    }
    if (acceptedBytes + source.bytes.byteLength > limits.maxTotalBytes) {
      throw new ArchivalPreparationBoundsError("total-byte");
    }
    // Copy once so hashing, parsing, and raw-record emission all share stable bytes.
    const bytes = Buffer.from(source.bytes);
    const digest = sha256(bytes);
    if (digest !== source.sha256) {
      throw new ArchivalPreparationInputError(`Declared SHA-256 does not match source bytes: ${source.sourceId}`);
    }
    acceptedBytes += bytes.length;
    const supported = SUPPORTED_FORMATS.has(source.format);
    const lineCount = supported ? countPhysicalLines(bytes) : null;
    if (lineCount !== null && lineCount > limits.maxLinesPerSource) {
      throw new ArchivalPreparationBoundsError("line-count");
    }
    const work: WorkSource = {
      input: source,
      sourceOrder,
      bytes: supported ? bytes : null,
      sha256: digest,
      lineCount,
      status: supported ? "complete" : "unsupported",
      recordsEmitted: 0,
      searchUnitsEmitted: 0,
      sessionKey: null,
    };
    works.push(work);
    if (!supported) {
      unsupportedSources.push({
        sourceId: source.sourceId,
        format: source.format,
        byteLength: bytes.length,
        sha256: digest,
        classification: "unsupported-source-format",
      });
    }
  }

  const records: PreparedArchivalRecord[] = [];
  const diagnostics: ArchivalDiagnostic[] = [];
  let linesVisited = 0;
  let searchUnitsEmitted = 0;

  const addDiagnostic = (code: string, work: WorkSource, line: number | null, lineHash: string | null): void => {
    if (diagnostics.length >= limits.maxDiagnostics) throw new ArchivalPreparationBoundsError("diagnostic-count");
    diagnostics.push({ code, sourceId: work.input.sourceId, line, lineSha256: lineHash });
  };

  for (const work of works) {
    const bytes = work.bytes;
    if (!bytes) continue;
    const format = work.input.format as "session-jsonl" | "history-jsonl" | "session-archive-jsonl";
    for (const line of physicalLines(bytes)) {
      if (records.length >= limits.maxRecords) throw new ArchivalPreparationBoundsError("record-count");
      linesVisited++;
      const lineHash = sha256(line.bytes);
      let classified: ClassifiedLine;
      if (lineIsBlank(line)) {
        classified = blankLine();
      } else {
        const decoded = decodeLine(line);
        classified = decoded.status === "quarantined"
          ? quarantined(decoded.reason)
          : classifyLine(format, decoded.value, work.sessionKey, limits.maxNestedReferences);
      }

      if (classified.category === "session-header" || classified.category === "archive-header") {
        if (classified.sessionKey !== null) {
          if (work.sessionKey === null) work.sessionKey = classified.sessionKey;
          else if (work.sessionKey !== classified.sessionKey) addDiagnostic("session-key-inconsistent", work, line.number, lineHash);
        }
      }

      if (classified.sessionKey === null && classified.category !== "session-header" &&
          classified.category !== "archive-header" && work.sessionKey !== null) {
        classified = { ...classified, sessionKey: work.sessionKey };
      }
      if (classified.units.length > 0) {
        const pendingUnits = searchUnitsEmitted + classified.units.length;
        if (pendingUnits > limits.maxSearchUnits) throw new ArchivalPreparationBoundsError("search-unit");
        searchUnitsEmitted = pendingUnits;
      }
      for (const code of classified.diagnostics) addDiagnostic(code, work, line.number, lineHash);

      const record: PreparedArchivalRecord = {
        recordVersion: PREPARED_RECORD_VERSION,
        ordinal: records.length,
        sourceId: work.input.sourceId,
        sourceOrder: work.sourceOrder,
        sourceSha256: work.sha256,
        line: line.number,
        byteOffset: line.byteOffset,
        byteLength: line.bytes.length,
        lineTerminated: line.terminated,
        lineSha256: lineHash,
        category: classified.category,
        status: classified.status,
        quarantineReason: classified.quarantineReason,
        opaque: classified.opaque,
        searchStatus: classified.searchStatus,
        disposition: "archive-only-never-resume-or-replay",
        sessionKey: classified.sessionKey,
        timestamp: classified.timestamp,
        role: classified.role,
        archiveCursor: classified.archiveCursor,
        search: classified.units,
        rawLineBase64: Buffer.from(line.bytes).toString("base64"),
        rawLineEncoding: "base64",
      };
      records.push(record);
      work.recordsEmitted++;
      work.searchUnitsEmitted += classified.units.length;
    }
    if (format === "session-jsonl" && work.sessionKey === null) {
      addDiagnostic("session-header-missing", work, null, null);
    }
  }

  const quarantinedRecords = records.filter((record) => record.status === "quarantined").length;
  const report: ArchivalPreparationReport = {
    format: ARCHIVAL_PREPARATION_FORMAT,
    version: ARCHIVAL_PREPARATION_VERSION,
    storeNamespace: request.storeNamespace,
    scope: "session-jsonl+history-jsonl+session-archive-jsonl",
    importPerformed: false,
    persistencePerformed: false,
    ambientReadsPerformed: false,
    replayPerformed: false,
    runtimeActionsPrepared: 0,
    complete: works.every((work) => work.status === "complete") && quarantinedRecords === 0,
    reviewRequired: true,
    disposition: "archive-only-never-resume-or-replay",
    bounds: {
      limits,
      inputBytes,
      acceptedBytes,
      hashedBytes: acceptedBytes,
      linesVisited,
      recordsEmitted: records.length,
      searchUnitsEmitted,
    },
    counts: {
      sources: works.length,
      supportedSources: works.filter((work) => work.status === "complete").length,
      unsupportedSources: unsupportedSources.length,
      inputBytes,
      linesVisited,
      recordsEmitted: records.length,
      preparedRecords: records.filter((record) => record.status === "prepared").length,
      quarantinedRecords,
      opaqueRecords: records.filter((record) => record.opaque).length,
      blankLines: records.filter((record) => record.category === "blank-line").length,
      sessionHeaders: records.filter((record) => record.category === "session-header").length,
      sessionMessages: records.filter((record) => record.category === "session-message").length,
      providerStateRecords: records.filter((record) => record.category === "provider-state").length,
      archiveHeaders: records.filter((record) => record.category === "archive-header").length,
      archiveMessages: records.filter((record) => record.category === "archive-message").length,
      historyEntries: records.filter((record) => record.category === "history-entry").length,
      quarantinedLines: quarantinedRecords,
      searchUnits: searchUnitsEmitted,
      diagnostics: diagnostics.length,
    },
    sources: works.map((work) => ({
      sourceId: work.input.sourceId,
      format: work.input.format,
      provenance: work.input.provenance,
      byteLength: work.input.bytes.byteLength,
      sha256: work.sha256,
      status: work.status,
      lineCount: work.lineCount,
      recordsEmitted: work.recordsEmitted,
      searchUnitsEmitted: work.searchUnitsEmitted,
    })),
    records,
    unsupportedSources,
    unsupportedSurfaces: UNSUPPORTED_SURFACES,
    diagnostics,
  };
  return deepFreeze(report);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

