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
  /** Text-only projection. Role/name/IDs are separate unit fields; tool arguments and raw metadata are not indexed. */
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
  /** Whether all text-scoped content was projected; partial when anything content-bearing was omitted. */
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
  readonly status: "complete" | "incomplete" | "unsupported";
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
  /** Failures make the source/report incomplete; notices do not. */
  readonly severity: "failure" | "notice";
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
const KNOWN_TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
const INDEXED_SESSION_MESSAGE_FIELDS = new Set(["role", "content", "timestamp", "_entry_id", "name"]);
const INDEXED_HISTORY_MESSAGE_FIELDS = new Set(["role", "content", "timestamp", "name", "_entry_id"]);
const INDEXED_HISTORY_TOP_FIELDS = new Set(["timestamp", "session_key", "content", "summary", "messages", "cursor"]);
// Known operational/accounting fields intentionally outside the text-search scope.
const NON_SEARCH_HISTORY_TOP_FIELDS = new Set([
  "schema_version", "kind", "start_time", "end_time", "message_count", "usage", "_idempotency_key",
]);

/**
 * Structural classification failures. All other diagnostics are notices:
 * invalid optional message metadata, unindexed search content, or invalid cursors.
 */
const FAILURE_DIAGNOSTICS = new Set([
  "session-header-key-invalid",
  "session-header-metadata-not-object",
  "session-header-missing",
  "session-header-duplicate",
  "session-header-out-of-order",
  "header-key-inconsistent",
  "archive-header-key-invalid",
  "archive-header-missing",
  "archive-header-duplicate",
  "archive-header-out-of-order",
  "history-kind-unrecognized",
  "history-schema-version-invalid",
]);

function diagnosticSeverity(code: string): "failure" | "notice" {
  return FAILURE_DIAGNOSTICS.has(code) ? "failure" : "notice";
}

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

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;

function typedArrayIntrinsic<T>(name: "buffer" | "byteLength" | "byteOffset"): (this: Uint8Array) => T {
  const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, name)?.get as
    | ((this: Uint8Array) => T)
    | undefined;
  if (typeof getter !== "function") throw new Error(`Missing intrinsic typed-array ${name} getter`);
  return getter;
}

const typedArrayBuffer = typedArrayIntrinsic<ArrayBufferLike>("buffer");
const typedArrayByteLength = typedArrayIntrinsic<number>("byteLength");
const typedArrayByteOffset = typedArrayIntrinsic<number>("byteOffset");
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
  | ((this: ArrayBuffer) => boolean)
  | undefined;

function isSharedArrayBuffer(buffer: ArrayBufferLike): boolean {
  const probe = (ArrayBuffer as unknown as { isSharedArrayBuffer?: (value: unknown) => boolean })
    .isSharedArrayBuffer;
  if (typeof probe === "function") return probe(buffer);
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}

interface CapturedSourceBytes {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** Inspect intrinsic view bounds without trusting subclass/own-property getters. */
function inspectSourceBytes(value: unknown): CapturedSourceBytes {
  if (!(value instanceof Uint8Array)) {
    throw new ArchivalPreparationInputError("Archival source bytes must be a Uint8Array");
  }
  let buffer: ArrayBufferLike;
  let byteOffset: number;
  let byteLength: number;
  try {
    buffer = typedArrayBuffer.call(value);
    byteOffset = typedArrayByteOffset.call(value);
    byteLength = typedArrayByteLength.call(value);
  } catch {
    throw new ArchivalPreparationInputError("Archival source bytes are not a readable Uint8Array view");
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 ||
      !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new ArchivalPreparationInputError("Archival source bytes have invalid view bounds");
  }
  if (isSharedArrayBuffer(buffer)) {
    throw new ArchivalPreparationInputError("Archival source bytes must not use a SharedArrayBuffer");
  }
  try {
    if (arrayBufferResizable?.call(buffer as ArrayBuffer) === true) {
      throw new ArchivalPreparationInputError("Archival source bytes must not use a resizable ArrayBuffer");
    }
  } catch (error) {
    if (error instanceof ArchivalPreparationInputError) throw error;
    throw new ArchivalPreparationInputError("Archival source bytes have an unsupported buffer backing");
  }
  return { buffer, byteOffset, byteLength };
}

/** Copy only the intrinsic view once; never allocate before the caller's byte bound is checked. */
function copySourceBytes(captured: CapturedSourceBytes): Buffer {
  try {
    const view = new Uint8Array(captured.buffer, captured.byteOffset, captured.byteLength);
    const copy = Buffer.from(view);
    if (copy.length !== captured.byteLength) {
      throw new ArchivalPreparationInputError("Archival source byte count changed during capture");
    }
    return copy;
  } catch (error) {
    if (error instanceof ArchivalPreparationInputError) throw error;
    throw new ArchivalPreparationInputError("Archival source bytes are detached or unreadable");
  }
}

type MutableLimits = { -readonly [K in keyof ArchivalPreparationLimits]: ArchivalPreparationLimits[K] };

function normalizedLimits(input: unknown): ArchivalPreparationLimits {
  const result: MutableLimits = { ...ARCHIVAL_PREPARATION_LIMITS };
  if (input === undefined) return result;
  if (!isRecord(input)) {
    throw new ArchivalPreparationInputError("Archival preparation limits must be an object");
  }
  let keys: string[];
  try {
    keys = Object.keys(input);
  } catch {
    throw new ArchivalPreparationInputError("Archival preparation limits are unreadable");
  }
  for (const key of keys) {
    if (!Object.hasOwn(ARCHIVAL_PREPARATION_LIMITS, key)) {
      throw new ArchivalPreparationInputError("Unknown archival preparation limit property");
    }
  }
  for (const key of Object.keys(ARCHIVAL_PREPARATION_LIMITS) as (keyof ArchivalPreparationLimits)[]) {
    let value: unknown;
    try {
      value = input[key];
    } catch {
      throw new ArchivalPreparationInputError(`Invalid archival preparation bound: ${key}`);
    }
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HARD_LIMITS[key]) {
      throw new ArchivalPreparationInputError(`Invalid archival preparation bound: ${key}`);
    }
    result[key] = value as number;
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

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function hasUnindexedContent(
  value: Record<string, unknown>,
  indexed: ReadonlySet<string>,
  knownNonSearch: ReadonlySet<string> = new Set(),
): boolean {
  return Object.keys(value).some((key) =>
    !indexed.has(key) && !knownNonSearch.has(key) && hasValue(value[key]));
}

/** Text-only search projection plus whether any content-bearing part was omitted. */
function textProjection(content: unknown): { text: string | null; omitted: boolean } {
  if (typeof content === "string") return { text: content, omitted: false };
  if (content === null || content === undefined) return { text: null, omitted: false };
  if (!Array.isArray(content)) return { text: null, omitted: true };
  const parts: string[] = [];
  let omitted = false;
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      omitted = true;
      continue;
    }
    const keys = Object.keys(block);
    const knownType = block.type === undefined ||
      (typeof block.type === "string" && KNOWN_TEXT_BLOCK_TYPES.has(block.type));
    if (!knownType) omitted = true;
    if (typeof block.text === "string") {
      parts.push(block.text);
      if (keys.some((key) => key !== "type" && key !== "text")) omitted = true;
      if (typeof block.content === "string") omitted = true;
    } else if (typeof block.content === "string") {
      parts.push(block.content);
      if (keys.some((key) => key !== "type" && key !== "content")) omitted = true;
    } else {
      omitted = true;
    }
  }
  return { text: parts.length > 0 ? parts.join("\n") : null, omitted };
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
  /** Whether all text-scoped content was projected; partial when anything content-bearing was omitted. */
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
  const projection = textProjection(rawContent);
  const diagnostics: string[] = [];
  if (parsed.timestamp !== undefined && timestamp === null) diagnostics.push("message-timestamp-invalid");
  if (parsed._entry_id !== undefined && entryId === null) diagnostics.push("message-entry-id-invalid");
  if (parsed.name !== undefined && name === null) diagnostics.push("message-name-invalid");
  const omitted = projection.omitted ||
    hasUnindexedContent(parsed, INDEXED_SESSION_MESSAGE_FIELDS) ||
    (parsed.timestamp !== undefined && timestamp === null) ||
    (parsed._entry_id !== undefined && entryId === null) ||
    (parsed.name !== undefined && name === null);
  const units = projection.text === null || projection.text === ""
    ? []
    : [searchUnit(0, unitKind, rawRole, timestamp, name, entryId, projection.text)];
  return {
    category,
    status: "prepared",
    quarantineReason: null,
    opaque: false,
    searchStatus: units.length === 0 ? (omitted ? "partial" : "none") : omitted ? "partial" : "complete",
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
  let partial = hasUnindexedContent(parsed, INDEXED_HISTORY_TOP_FIELDS, NON_SEARCH_HISTORY_TOP_FIELDS);
  if (rawSessionKey !== undefined && rawSessionKey !== null && sessionKey === null) partial = true;
  if (parsed.content !== undefined && typeof parsed.content !== "string") partial = true;
  if (parsed.summary !== undefined && typeof parsed.summary !== "string") partial = true;
  if (hasContent) {
    const projection = textProjection(parsed.content);
    if (projection.text !== null && projection.text !== "") {
      units.push(searchUnit(units.length, "history-content", null, rawTimestamp, null, null, projection.text));
    }
    if (projection.omitted) partial = true;
  }
  if (hasMessages) {
    for (const message of messages as unknown[]) {
      if (!isRecord(message)) {
        diagnostics.push("history-message-not-indexed");
        partial = true;
        continue;
      }
      const rawRole = message.role;
      if (typeof rawRole !== "string" || rawRole.length === 0) {
        diagnostics.push("history-message-not-indexed");
        partial = true;
        continue;
      }
      const messageTimestamp = boundedString(message.timestamp, 64);
      const messageName = boundedString(message.name, 512);
      const messageEntryId = boundedString(message._entry_id, 512);
      const projection = textProjection(message.content);
      const messageOmitted = projection.omitted ||
        hasUnindexedContent(message, INDEXED_HISTORY_MESSAGE_FIELDS) ||
        (message.timestamp !== undefined && messageTimestamp === null) ||
        (message.name !== undefined && messageName === null) ||
        (message._entry_id !== undefined && messageEntryId === null);
      if (projection.text !== null && projection.text !== "") {
        units.push(searchUnit(
          units.length,
          "history-message",
          rawRole,
          messageTimestamp,
          messageName,
          messageEntryId,
          projection.text,
        ));
      } else if (projection.omitted) {
        diagnostics.push("history-message-text-not-indexed");
      }
      if (messageOmitted) partial = true;
    }
  }
  if (hasSummary) {
    const projection = textProjection(parsed.summary);
    if (projection.text !== null && projection.text !== "") {
      units.push(searchUnit(units.length, "history-summary", null, rawTimestamp, null, null, projection.text));
    }
    if (projection.omitted) partial = true;
  }

  const rawCursor = parsed.cursor;
  const archiveCursor = nonNegativeInt(rawCursor);
  if (rawCursor !== undefined && archiveCursor === null) {
    diagnostics.push("history-cursor-invalid");
    partial = true;
  }
  if (parsed.schema_version !== undefined && nonNegativeInt(parsed.schema_version) === null) {
    diagnostics.push("history-schema-version-invalid");
  }
  if (parsed.kind !== undefined && parsed.kind !== "conversation") diagnostics.push("history-kind-unrecognized");

  return {
    category: "history-entry",
    status: "prepared",
    quarantineReason: null,
    opaque: false,
    searchStatus: units.length === 0 ? (partial ? "partial" : "none") : partial ? "partial" : "complete",
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
  readonly byteLength: number;
  readonly bytes: Buffer | null;
  readonly sha256: string;
  readonly lineCount: number | null;
  status: ArchivalSourcePreparation["status"];
  recordsEmitted: number;
  searchUnitsEmitted: number;
  sessionKey: string | null;
  headerSeen: boolean;
  sawNonBlankRecord: boolean;
}

function validatedSource(value: unknown): ArchivalSourceSnapshot {
  if (!isRecord(value)) {
    throw new ArchivalPreparationInputError(
      "Each archival source needs safe sourceId/provenance/format labels, a declared SHA-256, and bytes",
    );
  }
  const sourceId = value.sourceId;
  const provenance = value.provenance;
  const sha256 = value.sha256;
  const format = value.format;
  const bytes = value.bytes;
  if (typeof sourceId !== "string" || !SAFE_LABEL.test(sourceId) ||
      typeof provenance !== "string" || !SAFE_LABEL.test(provenance) ||
      typeof sha256 !== "string" || !SHA256_HEX.test(sha256) ||
      typeof format !== "string" || !SAFE_LABEL.test(format) ||
      !(bytes instanceof Uint8Array)) {
    throw new ArchivalPreparationInputError(
      "Each archival source needs safe sourceId/provenance/format labels, a declared SHA-256, and bytes",
    );
  }
  return { sourceId, sha256, format, provenance, bytes };
}

/** Prepare bounded archival records only; no import, persistence, or runtime state is created. */
export function prepareArchivalImport(
  request: ArchivalImportRequest,
  options: ArchivalPreparationOptions = {},
): ArchivalPreparationReport {
  if (!isRecord(options)) {
    throw new ArchivalPreparationInputError("Archival preparation options must be an object");
  }
  const limits = normalizedLimits(options.limits);
  if (!isRecord(request)) {
    throw new ArchivalPreparationInputError("Archival import request needs one safe storeNamespace label");
  }
  const storeNamespace = request.storeNamespace;
  if (typeof storeNamespace !== "string" || !SAFE_LABEL.test(storeNamespace)) {
    throw new ArchivalPreparationInputError("Archival import request needs one safe storeNamespace label");
  }
  const sourceList = request.sources;
  if (!Array.isArray(sourceList)) throw new ArchivalPreparationInputError("Archival sources must be an array");
  const sourceCount = sourceList.length;
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
    throw new ArchivalPreparationInputError("Archival source count is not a safe non-negative integer");
  }
  if (sourceCount === 0) {
    throw new ArchivalPreparationInputError("Archival import request must include at least one source");
  }
  if (sourceCount > limits.maxSources) throw new ArchivalPreparationBoundsError("source-count");

  const seenSourceIds = new Set<string>();
  const works: WorkSource[] = [];
  const unsupportedSources: UnsupportedArchivalSource[] = [];
  let inputBytes = 0;
  let acceptedBytes = 0;

  for (let sourceOrder = 0; sourceOrder < sourceCount; sourceOrder++) {
    if (sourceOrder >= limits.maxSources) throw new ArchivalPreparationBoundsError("source-count");
    const source = validatedSource(sourceList[sourceOrder]);
    if (seenSourceIds.has(source.sourceId)) {
      throw new ArchivalPreparationInputError("Archival sourceId values must be unique within one store namespace");
    }
    seenSourceIds.add(source.sourceId);
    const captured = inspectSourceBytes(source.bytes);
    inputBytes += captured.byteLength;
    if (captured.byteLength > limits.maxSourceBytes) {
      throw new ArchivalPreparationBoundsError("source-byte");
    }
    if (acceptedBytes + captured.byteLength > limits.maxTotalBytes) {
      throw new ArchivalPreparationBoundsError("total-byte");
    }
    // Copy once, after bounds, so hashing/parsing/records share stable intrinsic bytes.
    const bytes = copySourceBytes(captured);
    if (bytes.length !== captured.byteLength) {
      throw new ArchivalPreparationInputError("Archival source byte count changed during capture");
    }
    const digest = sha256(bytes);
    if (digest !== source.sha256) {
      throw new ArchivalPreparationInputError(`Declared SHA-256 does not match source bytes: ${source.sourceId}`);
    }
    acceptedBytes += captured.byteLength;
    const supported = SUPPORTED_FORMATS.has(source.format);
    const lineCount = supported ? countPhysicalLines(bytes) : null;
    if (lineCount !== null && lineCount > limits.maxLinesPerSource) {
      throw new ArchivalPreparationBoundsError("line-count");
    }
    const work: WorkSource = {
      input: source,
      sourceOrder,
      byteLength: captured.byteLength,
      bytes: supported ? bytes : null,
      sha256: digest,
      lineCount,
      status: supported ? "complete" : "unsupported",
      recordsEmitted: 0,
      searchUnitsEmitted: 0,
      sessionKey: null,
      headerSeen: false,
      sawNonBlankRecord: false,
    };
    works.push(work);
    if (!supported) {
      unsupportedSources.push({
        sourceId: source.sourceId,
        format: source.format,
        byteLength: captured.byteLength,
        sha256: digest,
        classification: "unsupported-source-format",
      });
    }
  }
  try {
    if (sourceList[sourceCount] !== undefined) {
      throw new ArchivalPreparationInputError("Archival source array length is inconsistent");
    }
  } catch (error) {
    if (error instanceof ArchivalPreparationInputError) throw error;
    throw new ArchivalPreparationInputError("Archival source array is unreadable");
  }

  const records: PreparedArchivalRecord[] = [];
  const diagnostics: ArchivalDiagnostic[] = [];
  let linesVisited = 0;
  let searchUnitsEmitted = 0;

  const addDiagnostic = (code: string, work: WorkSource, line: number | null, lineHash: string | null): void => {
    if (diagnostics.length >= limits.maxDiagnostics) throw new ArchivalPreparationBoundsError("diagnostic-count");
    const severity = diagnosticSeverity(code);
    if (severity === "failure" && work.status === "complete") work.status = "incomplete";
    diagnostics.push({ code, sourceId: work.input.sourceId, line, lineSha256: lineHash, severity });
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

      if (classified.status === "quarantined" && work.status === "complete") work.status = "incomplete";

      if (classified.category === "session-header" || classified.category === "archive-header") {
        const header = classified.category === "session-header" ? "session" : "archive";
        if (work.headerSeen) {
          addDiagnostic(`${header}-header-duplicate`, work, line.number, lineHash);
        } else if (work.sawNonBlankRecord) {
          addDiagnostic(`${header}-header-out-of-order`, work, line.number, lineHash);
        }
        work.headerSeen = true;
        if (classified.sessionKey !== null) {
          if (work.sessionKey === null) work.sessionKey = classified.sessionKey;
          else if (work.sessionKey !== classified.sessionKey) addDiagnostic("header-key-inconsistent", work, line.number, lineHash);
        }
      }
      if (classified.category !== "blank-line") work.sawNonBlankRecord = true;

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
    if (format === "session-jsonl" && !work.headerSeen) {
      addDiagnostic("session-header-missing", work, null, null);
    }
    if (format === "session-archive-jsonl" && !work.headerSeen) {
      addDiagnostic("archive-header-missing", work, null, null);
    }
  }

  const quarantinedRecords = records.filter((record) => record.status === "quarantined").length;
  const report: ArchivalPreparationReport = {
    format: ARCHIVAL_PREPARATION_FORMAT,
    version: ARCHIVAL_PREPARATION_VERSION,
    storeNamespace,
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
      supportedSources: works.filter((work) => work.status !== "unsupported").length,
      completeSources: works.filter((work) => work.status === "complete").length,
      incompleteSources: works.filter((work) => work.status === "incomplete").length,
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
      byteLength: work.byteLength,
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

