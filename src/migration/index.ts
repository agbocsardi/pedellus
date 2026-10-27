import { createHash } from "node:crypto";

/** Version of the deterministic inventory document, not an import/checkpoint version. */
export const MIGRATION_REPORT_VERSION = 1 as const;

export const MIGRATION_LIMITS = Object.freeze({
  maxSources: 64,
  maxSourceBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxLinesPerSource: 100_000,
  maxRecords: 50_000,
  maxIssues: 500,
  maxNestedReferences: 256,
});

const HARD_LIMITS = Object.freeze({
  maxSources: 256,
  maxSourceBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxLinesPerSource: 250_000,
  maxRecords: 100_000,
  maxIssues: 2_000,
  maxNestedReferences: 1_024,
});

const USAGE_COUNTERS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_tokens",
  "requests",
] as const;
type UsageCounter = (typeof USAGE_COUNTERS)[number];
type CounterSet = Record<UsageCounter, number | null>;

export type LegacySnapshotFormat = "session-jsonl" | "history-jsonl" | "config-json";

/** Bytes and safe opaque labels are supplied by the host; this module never opens paths. */
export interface LegacySourceSnapshot {
  readonly sourceId: string;
  readonly format: LegacySnapshotFormat;
  readonly provenance: string;
  readonly bytes: Uint8Array;
}

export interface MigrationLimits {
  readonly maxSources: number;
  readonly maxSourceBytes: number;
  readonly maxTotalBytes: number;
  readonly maxLinesPerSource: number;
  readonly maxRecords: number;
  readonly maxIssues: number;
  readonly maxNestedReferences: number;
}

export interface MigrationDryRunOptions {
  readonly limits?: Partial<MigrationLimits>;
}

export interface MigrationIssue {
  readonly code: string;
  readonly sourceId: string;
  readonly line: number | null;
  readonly lineSha256: string | null;
}

export interface SafeIdentifier {
  readonly value: string | null;
  readonly redacted: boolean;
  /** Digest of the original identifier, including when its value is redacted. */
  readonly sha256: string;
}

export interface MigrationRecord {
  readonly sourceId: string;
  readonly sourceSha256: string | null;
  readonly line: number;
  /** Hashes the exact raw line bytes, including a terminating LF when present. */
  readonly lineSha256: string;
  readonly category:
    | "session-header"
    | "session-message"
    | "history-entry"
    | "config-preset"
    | "malformed-line";
  readonly originalId: SafeIdentifier | null;
  readonly sessionKey: SafeIdentifier | null;
  readonly timestamp: string | null;
  readonly role: string | null;
  readonly targetEntryKind: string | null;
  readonly executionDisposition: "historical-only-never-runnable" | "not-applicable" | "review-required";
  readonly duplicateOf: Readonly<{ sourceId: string; line: number }> | null;
  readonly lineage: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<{ status: "known" | "unknown" | "invalid"; counters: CounterSet }> | null;
}

export interface MigrationSourceInventory {
  readonly sourceId: string;
  readonly format: LegacySnapshotFormat;
  readonly provenance: string;
  readonly byteLength: number;
  readonly sha256: string | null;
  readonly status: "complete" | "incomplete" | "not-processed";
  readonly lineCount: number | null;
  readonly recordsEmitted: number;
  readonly unprocessedLines: number;
  readonly finalLineTerminated: boolean | null;
}

export interface MigrationDryRunReport {
  readonly format: "nanobot-legacy-migration-dry-run";
  readonly version: typeof MIGRATION_REPORT_VERSION;
  readonly scope: "session-jsonl+history-jsonl+config-json-only";
  readonly importPerformed: false;
  readonly ambientReadsPerformed: false;
  readonly target: Readonly<{
    product: "Pi Durable";
    pinnedVersion: "1.4.0";
    behavior: "inventory-and-review-only";
  }>;
  readonly complete: boolean;
  readonly reviewRequired: true;
  readonly bounds: Readonly<{
    limits: MigrationLimits;
    inputBytes: number;
    hashedBytes: number;
    linesVisited: number;
    recordsEmitted: number;
    issuesEmitted: number;
    issuesOmitted: number;
  }>;
  readonly counts: Readonly<Record<string, number>>;
  readonly sources: readonly MigrationSourceInventory[];
  readonly records: readonly MigrationRecord[];
  readonly sessions: readonly Readonly<Record<string, unknown>>[];
  readonly configuration: readonly Readonly<Record<string, unknown>>[];
  readonly usageReconciliation: Readonly<Record<string, unknown>>;
  readonly unsupported: readonly Readonly<Record<string, string>>[];
  readonly issues: readonly MigrationIssue[];
}

export class MigrationBoundsError extends RangeError {
  readonly code = "migration_input_bound_exceeded";

  constructor(bound: string) {
    super(`Legacy migration inventory input exceeds the ${bound} bound`);
    this.name = "MigrationBoundsError";
  }
}

interface SourceWork {
  readonly input: LegacySourceSnapshot;
  readonly bytes: Buffer | null;
  readonly sha256: string | null;
  readonly lineCount: number | null;
  status: MigrationSourceInventory["status"];
  recordsEmitted: number;
  unprocessedLines: number;
  finalLineTerminated: boolean | null;
}

interface SessionUsageObservation {
  readonly sessionKey: string | null;
  readonly current: CounterSet | null;
  readonly unknownUsageFieldCount: number;
  readonly watermark: CounterSet | null;
  readonly delta: CounterSet;
  readonly status: "exact-delta" | "unknown" | "regression" | "invalid" | "no-usage";
  readonly unknownFields: readonly string[];
  readonly duplicateSessionKey: boolean;
}

interface ArchiveUsageObservation {
  readonly sessionKey: string | null;
  readonly cursor: number | null;
  readonly counters: CounterSet | null;
  readonly status: "known" | "unknown" | "invalid";
  duplicateCursor: boolean;
}

const UNSUPPORTED = Object.freeze([
  {
    surface: "memory files, Dream history/cursors, HISTORY.md, and sessions/archive/",
    status: "not-inventoried",
    action: "Supply a separately reviewed schema and immutable snapshots; no file discovery occurs here.",
  },
  {
    surface: "action_receipts.json, approvals, and external-effect outcomes",
    status: "not-inventoried",
    action: "Reconcile manually; unknown or started effects must not be replayed automatically.",
  },
  {
    surface: "cron, heartbeat, waiting runs, subagents, standing intents, and job state",
    status: "not-inventoried",
    action: "Reconcile manually; Python checkpoints are never recreated as runnable Durable tasks.",
  },
  {
    surface: "pairing, channel routes, skills, media files, and provider/session-private state",
    status: "not-inventoried",
    action: "Inventory separately with explicit provenance and an approved destination mapping.",
  },
]);

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SECRET_VALUE = /(?:\bbearer\s+\S+|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password|secret|credential)\s*[:=]\s*[^\s,;]+)/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;
const BUILTIN_PROVIDERS = new Set([
  "custom", "anthropic", "openai", "openrouter", "openai_codex", "deepseek", "zhipu",
  "zai", "dashscope", "minimax", "minimax_anthropic", "moonshot", "xiaomi_mimo",
  "umans", "opencode_zen", "opencode_go",
]);
const KNOWN_PRESET_FIELDS = new Set([
  "label", "model", "provider", "max_tokens", "context_window_tokens", "temperature",
  "reasoning_effort", "needs_vision_handoff",
]);
const UNINSPECTED_CONFIG_SECTIONS = ["channels", "tools", "gateway", "api", "transcription"] as const;
const KNOWN_SESSION_METADATA = new Set([
  "usage", "_usage_archived", "goal_state", "thread_goal", "runtime_checkpoint",
  "pending_user_turn", "compaction_checkpoints", "_last_summary", "_nanobot_model_preset",
]);
const KNOWN_MESSAGE_FIELDS = new Set([
  "role", "content", "timestamp", "_entry_id", "tool_calls", "tool_call_id", "name",
  "thinking_blocks", "_command", "media", "cli_apps", "mcp_presets", "_channel_delivery",
  "injected_event", "subagent_task_id", "original_command", "context_report",
]);
const UNSUPPORTED_MESSAGE_FIELDS = new Set(["media", "cli_apps", "mcp_presets"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeIdentifier(value: unknown): SafeIdentifier | null {
  if (typeof value !== "string") return null;
  const digest = sha256(value);
  const redacted = value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE.test(value);
  return { value: redacted ? null : value, redacted, sha256: digest };
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  return value;
}

function blankCounters(): CounterSet {
  return {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cached_tokens: null,
    requests: null,
  };
}

function zeroCounters(): CounterSet {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    requests: 0,
  };
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedLimits(input: Partial<MigrationLimits> | undefined): MigrationLimits {
  const result = { ...MIGRATION_LIMITS, ...(input ?? {}) };
  for (const key of Object.keys(MIGRATION_LIMITS) as (keyof MigrationLimits)[]) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) {
      throw new TypeError(`Invalid migration bound: ${key}`);
    }
  }
  return result;
}

function validateSources(sources: readonly LegacySourceSnapshot[], limits: MigrationLimits): LegacySourceSnapshot[] {
  if (!Array.isArray(sources)) throw new TypeError("Legacy source snapshots must be an array");
  if (sources.length > limits.maxSources) throw new MigrationBoundsError("source-count");
  const seen = new Set<string>();
  const copy: LegacySourceSnapshot[] = [];
  for (const source of sources) {
    if (!isObject(source) || typeof source.sourceId !== "string" || !SAFE_LABEL.test(source.sourceId) ||
        typeof source.provenance !== "string" || !SAFE_LABEL.test(source.provenance) ||
        !["session-jsonl", "history-jsonl", "config-json"].includes(String(source.format)) ||
        !(source.bytes instanceof Uint8Array)) {
      throw new TypeError("Each legacy source needs a supported format and safe host-supplied labels/bytes");
    }
    if (seen.has(source.sourceId)) throw new TypeError("Legacy sourceId values must be unique");
    seen.add(source.sourceId);
    copy.push(source as unknown as LegacySourceSnapshot);
  }
  return copy.sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}

interface PhysicalLine {
  readonly number: number;
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

function decodeJson(line: PhysicalLine): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line.jsonBytes);
  return JSON.parse(text) as unknown;
}

function location(sourceId: string, line: number): Readonly<{ sourceId: string; line: number }> {
  return { sourceId, line };
}

function addCounters(target: CounterSet, source: CounterSet): boolean {
  let overflow = false;
  for (const key of USAGE_COUNTERS) {
    const left = target[key];
    const right = source[key];
    if (left === null || right === null) continue;
    const sum = left + right;
    if (!Number.isSafeInteger(sum)) {
      target[key] = null;
      overflow = true;
    } else {
      target[key] = sum;
    }
  }
  return overflow;
}

function parseSparseUsage(value: unknown): {
  status: "known" | "unknown" | "invalid";
  counters: CounterSet;
  unknownFields: number;
} {
  if (!isObject(value)) return { status: "invalid", counters: blankCounters(), unknownFields: 0 };
  const counters = zeroCounters();
  let status: "known" | "invalid" = "known";
  for (const key of USAGE_COUNTERS) {
    const raw = own(value, key);
    if (raw === undefined) continue; // Python usage_delta is deliberately sparse: absence is recorded zero.
    if (!isCounter(raw)) {
      counters[key] = null;
      status = "invalid";
    } else {
      counters[key] = raw;
    }
  }
  let unknownFields = Object.keys(value).filter((key) =>
    !USAGE_COUNTERS.includes(key as UsageCounter) && key !== "by_model",
  ).length;
  const byModel = own(value, "by_model");
  if (byModel !== undefined) {
    if (!isObject(byModel)) {
      status = "invalid";
      unknownFields++;
    } else {
      for (const model of Object.values(byModel)) {
        if (!isObject(model)) {
          status = "invalid";
          continue;
        }
        for (const field of USAGE_COUNTERS) {
          const raw = own(model, field);
          if (raw !== undefined && !isCounter(raw)) status = "invalid";
        }
        if (Object.keys(model).some((key) =>
          !USAGE_COUNTERS.includes(key as UsageCounter) && key !== "provider" && key !== "model",
        )) unknownFields++;
      }
    }
  }
  return { status, counters, unknownFields };
}

function parseCumulativeUsage(value: unknown): { counters: CounterSet | null; invalid: boolean; unknownFields: number } {
  if (!isObject(value)) return { counters: null, invalid: true, unknownFields: 0 };
  const counters = blankCounters();
  let invalid = false;
  let unknownFields = Object.keys(value).filter((key) =>
    !USAGE_COUNTERS.includes(key as UsageCounter) && key !== "by_model",
  ).length;
  for (const key of USAGE_COUNTERS) {
    const raw = own(value, key);
    if (raw === undefined) continue;
    if (!isCounter(raw)) invalid = true;
    else counters[key] = raw;
  }
  const byModel = own(value, "by_model");
  if (byModel !== undefined) {
    if (!isObject(byModel)) {
      invalid = true;
      unknownFields++;
    } else {
      for (const model of Object.values(byModel)) {
        if (!isObject(model)) {
          invalid = true;
          continue;
        }
        for (const field of USAGE_COUNTERS) {
          const raw = own(model, field);
          if (raw !== undefined && !isCounter(raw)) invalid = true;
        }
        if (Object.keys(model).some((key) =>
          !USAGE_COUNTERS.includes(key as UsageCounter) && key !== "provider" && key !== "model",
        )) unknownFields++;
      }
    }
  }
  return { counters, invalid, unknownFields };
}

function activeUsageDelta(
  currentValue: unknown,
  watermarkValue: unknown,
): Pick<SessionUsageObservation, "current" | "watermark" | "delta" | "status" | "unknownFields" | "unknownUsageFieldCount"> {
  const delta = blankCounters();
  if (currentValue === undefined && watermarkValue === undefined) {
    return { current: null, watermark: null, delta, status: "no-usage", unknownFields: [], unknownUsageFieldCount: 0 };
  }
  if (currentValue === undefined || watermarkValue === undefined) {
    return {
      current: null,
      watermark: null,
      delta,
      status: "unknown",
      unknownFields: [...USAGE_COUNTERS],
      unknownUsageFieldCount: 0,
    };
  }
  const current = parseCumulativeUsage(currentValue);
  const watermark = parseCumulativeUsage(watermarkValue);
  const byModelMissingOnOneSide = isObject(currentValue) && isObject(watermarkValue) &&
    (own(currentValue, "by_model") === undefined) !== (own(watermarkValue, "by_model") === undefined);
  if (!current.counters || !watermark.counters || current.invalid || watermark.invalid) {
    return {
      current: current.counters,
      watermark: watermark.counters,
      delta,
      status: "invalid",
      unknownFields: [...USAGE_COUNTERS],
      unknownUsageFieldCount: current.unknownFields + watermark.unknownFields + (byModelMissingOnOneSide ? 1 : 0),
    };
  }
  const unknownFields: string[] = [];
  let regression = false;
  for (const key of USAGE_COUNTERS) {
    const now = current.counters[key];
    const archived = watermark.counters[key];
    if (now === null || archived === null) {
      unknownFields.push(key);
      continue;
    }
    if (now < archived) {
      regression = true;
      unknownFields.push(key);
      continue;
    }
    delta[key] = now - archived;
  }
  return {
    current: current.counters,
    watermark: watermark.counters,
    delta,
    status: regression ? "regression" : unknownFields.length > 0 || current.unknownFields + watermark.unknownFields > 0 || byModelMissingOnOneSide ? "unknown" : "exact-delta",
    unknownFields: byModelMissingOnOneSide ? [...unknownFields, "by_model"] : unknownFields,
    unknownUsageFieldCount: current.unknownFields + watermark.unknownFields + (byModelMissingOnOneSide ? 1 : 0),
  };
}

function targetForRole(role: unknown, hasToolCalls: boolean): {
  role: string | null;
  targetEntryKind: string | null;
  executionDisposition: MigrationRecord["executionDisposition"];
} {
  if (typeof role !== "string") return { role: null, targetEntryKind: null, executionDisposition: "review-required" };
  if (role === "user") return { role, targetEntryKind: "pi.user", executionDisposition: "not-applicable" };
  if (role === "assistant") {
    return {
      role,
      targetEntryKind: hasToolCalls ? "nanobot.legacy.history" : "pi.assistant",
      executionDisposition: hasToolCalls ? "historical-only-never-runnable" : "not-applicable",
    };
  }
  if (role === "tool") return { role, targetEntryKind: "nanobot.legacy.history", executionDisposition: "historical-only-never-runnable" };
  return { role: "unknown", targetEntryKind: "nanobot.legacy.message", executionDisposition: "review-required" };
}

/** Build a bounded, deterministic report from explicit immutable-by-convention byte snapshots. */
export function inventoryLegacySnapshots(
  inputSources: readonly LegacySourceSnapshot[],
  options: MigrationDryRunOptions = {},
): MigrationDryRunReport {
  const limits = normalizedLimits(options.limits);
  const inputs = validateSources(inputSources, limits);
  const records: MigrationRecord[] = [];
  const issues: MigrationIssue[] = [];
  const sourceWorks: SourceWork[] = [];
  const sessionRows: Record<string, unknown>[] = [];
  const configuration: Record<string, unknown>[] = [];
  const sessionUsages: SessionUsageObservation[] = [];
  const archiveUsages: ArchiveUsageObservation[] = [];
  const seenSessionKeys = new Map<string, Readonly<{ sourceId: string; line: number }>>();
  const duplicateSessionKeys = new Set<string>();
  const seenMessageIds = new Map<string, Readonly<{ sourceId: string; line: number }>>();
  const seenGlobalMessageIds = new Map<string, Readonly<{ sourceId: string; line: number; sessionKey: string | null }>>();
  const seenArchiveCursors = new Map<number, Readonly<{ sourceId: string; line: number }>>();
  const archiveCursorCollisions = new Set<number>();
  let complete = true;
  let inputBytes = 0;
  let hashedBytes = 0;
  let linesVisited = 0;
  let issuesOmitted = 0;
  let sessionCount = 0;
  let sessionMessageCount = 0;
  let historyEntryCount = 0;
  let configPresetCount = 0;
  let malformedLineCount = 0;
  let duplicateMessageIdCount = 0;
  let crossSessionEntryIdCollisionCount = 0;
  let duplicateSessionKeyCount = 0;
  let duplicateArchiveCursorCount = 0;
  let manualActionCount = 0;
  let recordLimitReached = false;
  let acceptedBytes = 0;

  const markIncomplete = () => { complete = false; };
  const issue = (code: string, sourceId: string, line: number | null, lineHash: string | null) => {
    markIncomplete();
    if (issues.length < limits.maxIssues) issues.push({ code, sourceId, line, lineSha256: lineHash });
    else issuesOmitted++;
  };
  const emit = (record: MigrationRecord, work: SourceWork): boolean => {
    if (records.length >= limits.maxRecords) {
      work.status = "incomplete";
      markIncomplete();
      if (!recordLimitReached) {
        recordLimitReached = true;
        issue("record_limit_exceeded", work.input.sourceId, record.line, record.lineSha256);
      }
      return false;
    }
    records.push(record);
    work.recordsEmitted++;
    return true;
  };

  for (const input of inputs) {
    inputBytes += input.bytes.byteLength;
    let bytes: Buffer | null = null;
    let digest: string | null = null;
    let lineCount: number | null = null;
    let status: SourceWork["status"] = "complete";
    let finalLineTerminated: boolean | null = null;
    if (input.bytes.byteLength > limits.maxSourceBytes) {
      status = "incomplete";
      issue("source_byte_limit_exceeded", input.sourceId, null, null);
    } else if (acceptedBytes + input.bytes.byteLength > limits.maxTotalBytes) {
      status = "not-processed";
      issue("total_byte_limit_exceeded", input.sourceId, null, null);
    } else {
      // Copy once so hash and parsing use a stable snapshot; never mutate caller bytes.
      bytes = Buffer.from(input.bytes);
      acceptedBytes += bytes.length;
      hashedBytes += bytes.length;
      digest = sha256(bytes);
      if (input.format !== "config-json") {
        lineCount = countPhysicalLines(bytes);
        finalLineTerminated = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
      }
    }
    const work: SourceWork = {
      input,
      bytes,
      sha256: digest,
      lineCount,
      status,
      recordsEmitted: 0,
      unprocessedLines: 0,
      finalLineTerminated,
    };
    sourceWorks.push(work);
    if (!bytes) continue;
    if (input.format === "session-jsonl") {
      inventorySessionSource(work, emit, issue, {
        limits,
        seenSessionKeys,
        duplicateSessionKeys,
        seenMessageIds,
        seenGlobalMessageIds,
        sessionUsages,
        onSession: (row) => {
          sessionRows.push(row);
          sessionCount++;
          if (typeof row.manualActionCount === "number") manualActionCount += row.manualActionCount;
        },
        onMessage: () => { sessionMessageCount++; },
        onMalformed: () => { malformedLineCount++; },
        onDuplicateSessionKey: () => { duplicateSessionKeyCount++; },
        onDuplicateMessageId: () => { duplicateMessageIdCount++; },
        onCrossSessionIdCollision: () => { crossSessionEntryIdCollisionCount++; },
        onLine: () => { linesVisited++; },
        getRecordLimitReached: () => recordLimitReached,
      });
    } else if (input.format === "history-jsonl") {
      inventoryHistorySource(work, emit, issue, {
        limits,
        seenArchiveCursors,
        archiveCursorCollisions,
        archiveUsages,
        onEntry: () => { historyEntryCount++; },
        onDuplicateCursor: () => { duplicateArchiveCursorCount++; },
        onMalformed: () => { malformedLineCount++; },
        onLine: () => { linesVisited++; },
        getRecordLimitReached: () => recordLimitReached,
      });
    } else {
      linesVisited++;
      const result = inventoryConfigSource(work, emit, issue, limits);
      configPresetCount += result.presetCount;
      configuration.push(result.summary);
    }
  }

  for (const archive of archiveUsages) {
    if (archive.cursor !== null && archiveCursorCollisions.has(archive.cursor)) archive.duplicateCursor = true;
  }
  const duplicateSessionKeyHashes = new Set([...duplicateSessionKeys].map((key) => sha256(key)));
  for (const row of sessionRows) {
    const identifier = row.sessionKey;
    if (isObject(identifier) && typeof identifier.sha256 === "string" &&
        duplicateSessionKeyHashes.has(identifier.sha256)) row.duplicateSessionKey = true;
  }
  for (let i = 0; i < sessionUsages.length; i++) {
    const usage = sessionUsages[i];
    if (usage?.sessionKey !== null && usage?.sessionKey !== undefined && duplicateSessionKeys.has(usage.sessionKey)) {
      sessionUsages[i] = { ...usage, duplicateSessionKey: true };
    }
  }
  const usageReconciliation = reconcileUsage(archiveUsages, sessionUsages, issue);
  const sourceInventories: MigrationSourceInventory[] = sourceWorks.map((work) => ({
    sourceId: work.input.sourceId,
    format: work.input.format,
    provenance: work.input.provenance,
    byteLength: work.input.bytes.byteLength,
    sha256: work.sha256,
    status: work.status,
    lineCount: work.lineCount,
    recordsEmitted: work.recordsEmitted,
    unprocessedLines: work.unprocessedLines,
    finalLineTerminated: work.finalLineTerminated,
  }));
  const counts = {
    sources: sourceWorks.length,
    inputBytes,
    linesVisited,
    emittedRecords: records.length,
    sessions: sessionCount,
    sessionMessages: sessionMessageCount,
    historyEntries: historyEntryCount,
    configPresets: configPresetCount,
    malformedLines: malformedLineCount,
    duplicateMessageIds: duplicateMessageIdCount,
    crossSessionEntryIdCollisions: crossSessionEntryIdCollisionCount,
    duplicateSessionKeys: duplicateSessionKeyCount,
    duplicateArchiveCursors: duplicateArchiveCursorCount,
    manualReconciliationActions: manualActionCount,
    issues: issues.length + issuesOmitted,
  };

  return {
    format: "nanobot-legacy-migration-dry-run",
    version: MIGRATION_REPORT_VERSION,
    scope: "session-jsonl+history-jsonl+config-json-only",
    importPerformed: false,
    ambientReadsPerformed: false,
    target: { product: "Pi Durable", pinnedVersion: "1.4.0", behavior: "inventory-and-review-only" },
    complete,
    reviewRequired: true,
    bounds: {
      limits,
      inputBytes,
      hashedBytes,
      linesVisited,
      recordsEmitted: records.length,
      issuesEmitted: issues.length,
      issuesOmitted,
    },
    counts,
    sources: sourceInventories,
    records,
    sessions: sessionRows,
    configuration,
    usageReconciliation,
    unsupported: UNSUPPORTED,
    issues,
  };
}

interface SessionOptions {
  readonly limits: MigrationLimits;
  readonly seenSessionKeys: Map<string, Readonly<{ sourceId: string; line: number }>>;
  readonly duplicateSessionKeys: Set<string>;
  readonly seenMessageIds: Map<string, Readonly<{ sourceId: string; line: number }>>;
  readonly seenGlobalMessageIds: Map<string, Readonly<{ sourceId: string; line: number; sessionKey: string | null }>>;
  readonly sessionUsages: SessionUsageObservation[];
  readonly onSession: (row: Record<string, unknown>) => void;
  readonly onMessage: () => void;
  readonly onMalformed: () => void;
  readonly onDuplicateSessionKey: () => void;
  readonly onDuplicateMessageId: () => void;
  readonly onCrossSessionIdCollision: () => void;
  readonly onLine: () => void;
  readonly getRecordLimitReached: () => boolean;
}

function inventorySessionSource(
  work: SourceWork,
  emit: (record: MigrationRecord, work: SourceWork) => boolean,
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
  options: SessionOptions,
): void {
  const bytes = work.bytes;
  if (!bytes) return;
  const allLines = physicalLines(bytes);
  let header: Record<string, unknown> | null = null;
  let metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let sessionKeyRaw: string | null = null;
  let headerLocation: Readonly<{ sourceId: string; line: number }> | null = null;
  let messageCount = 0;
  let historicalToolCallCount = 0;
  let unknownRoleCount = 0;
  let unknownMessageFieldCount = 0;
  let unsupportedMessageFieldCount = 0;
  let linesProcessed = 0;
  const lineLimitExceeded = (work.lineCount ?? 0) > options.limits.maxLinesPerSource;
  if (lineLimitExceeded) {
    work.status = "incomplete";
    issue("line_limit_exceeded", work.input.sourceId, null, work.sha256);
  }

  for (const line of allLines) {
    if (linesProcessed >= options.limits.maxLinesPerSource) {
      work.unprocessedLines = Math.max(0, (work.lineCount ?? line.number) - line.number + 1);
      work.status = "incomplete";
      break;
    }
    linesProcessed++;
    options.onLine();
    const lineHash = sha256(line.bytes);
    if (lineIsBlank(line)) continue;
    if (options.getRecordLimitReached()) {
      work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
      work.status = "incomplete";
      break;
    }

    let parsed: unknown;
    try {
      parsed = decodeJson(line);
    } catch {
      options.onMalformed();
      issue(line.number === work.lineCount && !line.terminated ? "malformed_or_truncated_final_line" : "malformed_json_line", work.input.sourceId, line.number, lineHash);
      if (!emit(malformedRecord(work, line.number, lineHash), work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }
    if (!isObject(parsed)) {
      options.onMalformed();
      issue("session_line_not_object", work.input.sourceId, line.number, lineHash);
      if (!emit(malformedRecord(work, line.number, lineHash), work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }

    if (line.number === 1 && own(parsed, "_type") === "metadata") {
      header = parsed;
      headerLocation = location(work.input.sourceId, line.number);
      const rawKey = own(parsed, "key");
      if (typeof rawKey === "string" && rawKey.length > 0) {
        sessionKeyRaw = rawKey;
        const prior = options.seenSessionKeys.get(rawKey);
        if (prior) {
          options.duplicateSessionKeys.add(rawKey);
          options.onDuplicateSessionKey();
          issue("duplicate_session_key_collision", work.input.sourceId, line.number, lineHash);
        } else {
          options.seenSessionKeys.set(rawKey, location(work.input.sourceId, line.number));
        }
      } else {
        issue("missing_session_key", work.input.sourceId, line.number, lineHash);
      }
      const rawMetadata = own(parsed, "metadata");
      if (isObject(rawMetadata)) metadata = rawMetadata;
      else issue("session_metadata_not_object", work.input.sourceId, line.number, lineHash);
      if (own(parsed, "created_at") !== undefined && !safeTimestamp(own(parsed, "created_at"))) {
        issue("invalid_session_created_at", work.input.sourceId, line.number, lineHash);
      }
      if (own(parsed, "updated_at") !== undefined && !safeTimestamp(own(parsed, "updated_at"))) {
        issue("invalid_session_updated_at", work.input.sourceId, line.number, lineHash);
      }
      if (!Number.isSafeInteger(own(parsed, "last_consolidated")) || Number(own(parsed, "last_consolidated")) < 0) {
        issue("invalid_last_consolidated", work.input.sourceId, line.number, lineHash);
      }
      if (!emit({
        ...recordBase(work, line.number, lineHash, "session-header"),
        originalId: null,
        sessionKey: safeIdentifier(sessionKeyRaw),
        timestamp: safeTimestamp(own(parsed, "updated_at")),
        role: null,
        targetEntryKind: null,
        executionDisposition: "not-applicable",
        duplicateOf: sessionKeyRaw ? options.seenSessionKeys.get(sessionKeyRaw) === undefined ? null :
          (options.seenSessionKeys.get(sessionKeyRaw)?.sourceId !== work.input.sourceId ||
           options.seenSessionKeys.get(sessionKeyRaw)?.line !== line.number ? options.seenSessionKeys.get(sessionKeyRaw)! : null) : null,
        lineage: { createdAt: safeTimestamp(own(parsed, "created_at")), lastConsolidated: safeNonNegativeInt(own(parsed, "last_consolidated")) },
        usage: null,
      }, work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }
    if (own(parsed, "_type") === "metadata") {
      issue("duplicate_or_late_session_header", work.input.sourceId, line.number, lineHash);
      if (!emit({
        ...recordBase(work, line.number, lineHash, "session-header"),
        originalId: null,
        sessionKey: safeIdentifier(own(parsed, "key")),
        timestamp: safeTimestamp(own(parsed, "updated_at")),
        role: null,
        targetEntryKind: null,
        executionDisposition: "review-required",
        duplicateOf: headerLocation,
        lineage: { headerPosition: "late-or-duplicate" },
        usage: null,
      }, work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }

    messageCount++;
    options.onMessage();
    const rawRole = own(parsed, "role");
    const rawCalls = own(parsed, "tool_calls");
    const rolePlan = targetForRole(rawRole, Array.isArray(rawCalls));
    if (rolePlan.targetEntryKind === "nanobot.legacy.message") {
      unknownRoleCount++;
      issue("unknown_session_message_role", work.input.sourceId, line.number, lineHash);
    }
    const rawTimestamp = own(parsed, "timestamp");
    const timestamp = safeTimestamp(rawTimestamp);
    if (rawTimestamp !== undefined && timestamp === null) issue("invalid_session_message_timestamp", work.input.sourceId, line.number, lineHash);
    if (rawCalls !== undefined && !Array.isArray(rawCalls)) issue("tool_calls_not_array", work.input.sourceId, line.number, lineHash);
    const messageKeys = Object.keys(parsed);
    const unknownFields = messageKeys.filter((key) => !KNOWN_MESSAGE_FIELDS.has(key));
    const unsupportedFields = messageKeys.filter((key) => UNSUPPORTED_MESSAGE_FIELDS.has(key));
    unknownMessageFieldCount += unknownFields.length;
    unsupportedMessageFieldCount += unsupportedFields.length;
    if (unknownFields.length > 0) issue("unknown_session_message_fields", work.input.sourceId, line.number, lineHash);
    const rawId = own(parsed, "_entry_id");
    if (rawId === undefined) issue("missing_message_entry_id", work.input.sourceId, line.number, lineHash);
    else if (typeof rawId !== "string" || rawId.length === 0) issue("invalid_message_entry_id", work.input.sourceId, line.number, lineHash);
    const idText = typeof rawId === "string" ? rawId : null;
    let duplicateOf: Readonly<{ sourceId: string; line: number }> | null = null;
    if (idText !== null) {
      const globalPrior = options.seenGlobalMessageIds.get(idText);
      if (!globalPrior) {
        options.seenGlobalMessageIds.set(idText, { ...location(work.input.sourceId, line.number), sessionKey: sessionKeyRaw });
      } else if (globalPrior.sessionKey !== sessionKeyRaw || globalPrior.sourceId !== work.input.sourceId) {
        options.onCrossSessionIdCollision();
        issue("cross_session_entry_id_collision", work.input.sourceId, line.number, lineHash);
      }
      if (sessionKeyRaw !== null) {
        const identityKey = `${sessionKeyRaw}\u0000${idText}`;
        duplicateOf = options.seenMessageIds.get(identityKey) ?? null;
        if (duplicateOf) {
          options.onDuplicateMessageId();
          issue("duplicate_message_id", work.input.sourceId, line.number, lineHash);
        } else {
          options.seenMessageIds.set(identityKey, location(work.input.sourceId, line.number));
        }
      }
    }
    const calls = Array.isArray(rawCalls) ? rawCalls : [];
    historicalToolCallCount += calls.length;
    if (calls.length > options.limits.maxNestedReferences) {
      issue("nested_tool_reference_limit_exceeded", work.input.sourceId, line.number, lineHash);
    }
    const callIds: SafeIdentifier[] = [];
    for (const call of calls.slice(0, options.limits.maxNestedReferences)) {
      if (!isObject(call)) {
        issue("tool_call_record_not_object", work.input.sourceId, line.number, lineHash);
        continue;
      }
      const id = safeIdentifier(own(call, "id"));
      if (id) callIds.push(id);
      else issue("tool_call_missing_id", work.input.sourceId, line.number, lineHash);
    }
    const toolCallId = safeIdentifier(own(parsed, "tool_call_id"));
    const toolName = safeIdentifier(own(parsed, "name"));
    const lineage: Record<string, unknown> = {};
    if (calls.length > 0) {
      lineage.historicalToolCallCount = calls.length;
      lineage.historicalToolCallIds = callIds;
      lineage.omittedToolCallReferences = Math.max(0, calls.length - Math.min(calls.length, options.limits.maxNestedReferences));
    }
    if (toolCallId) lineage.historicalToolCallId = toolCallId;
    if (toolName) lineage.toolName = toolName;
    if (!emit({
      ...recordBase(work, line.number, lineHash, "session-message"),
      originalId: safeIdentifier(rawId),
      sessionKey: safeIdentifier(sessionKeyRaw),
      timestamp,
      role: rolePlan.role,
      targetEntryKind: rolePlan.targetEntryKind,
      executionDisposition: rolePlan.executionDisposition,
      duplicateOf,
      lineage,
      usage: null,
    }, work)) {
      work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
      break;
    }
  }

  if (!header) issue("missing_session_header", work.input.sourceId, null, work.sha256);
  const lastConsolidated = safeNonNegativeInt(own(header ?? {}, "last_consolidated"));
  if (lastConsolidated !== null && lastConsolidated > messageCount) {
    issue("last_consolidated_exceeds_message_count", work.input.sourceId, headerLocation?.line ?? null, work.sha256);
  }
  const checkpointRows = inventoryCheckpoints(metadata, work, headerLocation, options.limits, issue);
  const goal = inventoryGoal(metadata);
  const runtime = inventoryRuntimeCheckpoint(metadata, options.limits, work, issue);
  const pendingUserTurn = own(metadata, "pending_user_turn");
  const pendingStatus = pendingUserTurn === true ? "active" : pendingUserTurn === undefined ? "not-present" :
    pendingUserTurn === false ? "inactive" : "unknown";
  const actions = [
    { kind: "runtime-checkpoint", status: runtime.status, requiresManualReconciliation: runtime.status === "active" || runtime.status === "unknown", ...runtime.details },
    { kind: "pending-user-turn", status: pendingStatus, requiresManualReconciliation: pendingStatus === "active" || pendingStatus === "unknown" },
    { kind: "sustained-goal", status: goal.status, requiresManualReconciliation: goal.status === "active" || goal.status === "unknown" },
  ];
  const actionCount = actions.filter((action) => action.requiresManualReconciliation).length;
  const preset = safeIdentifier(own(metadata, "_nanobot_model_preset"));
  const usageValue = own(metadata, "usage");
  const watermarkValue = own(metadata, "_usage_archived");
  const usage = activeUsageDelta(usageValue, watermarkValue);
  if (usage.status === "invalid") issue("invalid_active_usage_snapshot", work.input.sourceId, headerLocation?.line ?? null, work.sha256);
  if (usage.status === "regression") issue("active_usage_watermark_regression", work.input.sourceId, headerLocation?.line ?? null, work.sha256);
  const duplicateKey = sessionKeyRaw !== null && options.duplicateSessionKeys.has(sessionKeyRaw);
  options.sessionUsages.push({
    sessionKey: sessionKeyRaw,
    current: usage.current,
    watermark: usage.watermark,
    delta: usage.delta,
    status: usage.status,
    unknownFields: usage.unknownFields,
    unknownUsageFieldCount: usage.unknownUsageFieldCount,
    duplicateSessionKey: duplicateKey,
  });
  options.onSession({
    sourceId: work.input.sourceId,
    sourceSha256: work.sha256,
    headerLine: headerLocation?.line ?? null,
    headerLineSha256: headerLocation ? findLineHash(bytes, headerLocation.line) : null,
    sessionKey: safeIdentifier(sessionKeyRaw),
    createdAt: safeTimestamp(own(header ?? {}, "created_at")),
    updatedAt: safeTimestamp(own(header ?? {}, "updated_at")),
    lastConsolidated,
    messageCount,
    historicalToolCallCount,
    unknownRoleCount,
    unknownMessageFieldCount,
    unsupportedMessageFieldCount,
    duplicateSessionKey: duplicateKey,
    modelPreset: preset,
    compactionCheckpoints: checkpointRows,
    legacySummaryPresent: own(metadata, "_last_summary") !== undefined,
    usage: { status: usage.status, current: usage.current, archivedWatermark: usage.watermark, activeDelta: usage.delta, unknownFields: usage.unknownFields, unknownUsageFieldCount: usage.unknownUsageFieldCount },
    actions,
    unknownMetadataKeyCount: Object.keys(metadata).filter((key) => !KNOWN_SESSION_METADATA.has(key)).length,
    manualActionCount: actionCount,
  });
}

function findLineHash(bytes: Buffer, lineNumber: number): string | null {
  for (const line of physicalLines(bytes)) if (line.number === lineNumber) return sha256(line.bytes);
  return null;
}

function inventoryCheckpoints(
  metadata: Record<string, unknown>,
  work: SourceWork,
  header: Readonly<{ sourceId: string; line: number }> | null,
  limits: MigrationLimits,
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
): Readonly<Record<string, unknown>>[] {
  const raw = own(metadata, "compaction_checkpoints");
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issue("compaction_checkpoints_not_array", work.input.sourceId, header?.line ?? null, work.sha256);
    return [];
  }
  if (raw.length > limits.maxNestedReferences) {
    issue("compaction_checkpoint_limit_exceeded", work.input.sourceId, header?.line ?? null, work.sha256);
  }
  return raw.slice(0, limits.maxNestedReferences).map((checkpoint) => {
    if (!isObject(checkpoint)) {
      issue("compaction_checkpoint_not_object", work.input.sourceId, header?.line ?? null, work.sha256);
      return { status: "unknown" };
    }
    const id = safeIdentifier(own(checkpoint, "id"));
    const version = safeNonNegativeInt(own(checkpoint, "version"));
    const type = own(checkpoint, "type") === "compaction" ? "compaction" : "unknown";
    const firstKeptEntryId = safeIdentifier(own(checkpoint, "first_kept_entry_id"));
    const sourceEndId = safeIdentifier(own(checkpoint, "source_end_id"));
    if (!id || version !== 1 || type !== "compaction" || !firstKeptEntryId || !sourceEndId) {
      issue("incomplete_compaction_checkpoint_lineage", work.input.sourceId, header?.line ?? null, work.sha256);
    }
    return {
      id,
      version,
      type,
      firstKeptEntryId,
      sourceEndId,
      summaryOmitted: own(checkpoint, "summary") !== undefined,
    };
  });
}

function inventoryGoal(metadata: Record<string, unknown>): { status: "active" | "inactive" | "unknown" | "not-present" } {
  const hasCurrent = Object.hasOwn(metadata, "goal_state");
  const hasLegacy = Object.hasOwn(metadata, "thread_goal");
  if (!hasCurrent && !hasLegacy) return { status: "not-present" };
  const raw = hasCurrent ? own(metadata, "goal_state") : own(metadata, "thread_goal");
  let goal = raw;
  if (typeof raw === "string") {
    try { goal = JSON.parse(raw) as unknown; } catch { return { status: "unknown" }; }
  }
  if (!isObject(goal)) return { status: "unknown" };
  const status = own(goal, "status");
  if (status === "active") return { status: "active" };
  if (["completed", "stopped", "failed", "cancelled"].includes(String(status))) return { status: "inactive" };
  return { status: "unknown" };
}

function inventoryRuntimeCheckpoint(
  metadata: Record<string, unknown>,
  limits: MigrationLimits,
  work: SourceWork,
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
): { status: "active" | "unknown" | "not-present"; details: Record<string, unknown> } {
  const raw = own(metadata, "runtime_checkpoint");
  if (raw === undefined) return { status: "not-present", details: {} };
  if (!isObject(raw)) return { status: "unknown", details: { checkpointPresent: true } };
  const pending = own(raw, "pending_tool_calls");
  const completed = own(raw, "completed_tool_results");
  const pendingCalls = Array.isArray(pending) ? pending : null;
  const results = Array.isArray(completed) ? completed : null;
  if (pendingCalls && pendingCalls.length > limits.maxNestedReferences) {
    issue("runtime_checkpoint_reference_limit_exceeded", work.input.sourceId, null, work.sha256);
  }
  const pendingIds: SafeIdentifier[] = [];
  for (const call of (pendingCalls ?? []).slice(0, limits.maxNestedReferences)) {
    if (!isObject(call)) continue;
    const id = safeIdentifier(own(call, "id"));
    if (id) pendingIds.push(id);
  }
  const valid = (pending === undefined || pendingCalls !== null) && (completed === undefined || results !== null);
  return {
    status: valid ? "active" : "unknown",
    details: {
      checkpointPresent: true,
      pendingToolCallCount: pendingCalls?.length ?? null,
      completedToolResultCount: results?.length ?? null,
      pendingToolCallIds: pendingIds,
      assistantMessagePresent: isObject(own(raw, "assistant_message")),
      executionDisposition: "manual-reconciliation-never-resume",
    },
  };
}

function safeNonNegativeInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 ? value : null;
}

function recordBase(
  work: SourceWork,
  line: number,
  lineHash: string,
  category: MigrationRecord["category"],
): Pick<MigrationRecord, "sourceId" | "sourceSha256" | "line" | "lineSha256" | "category"> {
  return {
    sourceId: work.input.sourceId,
    sourceSha256: work.sha256,
    line,
    lineSha256: lineHash,
    category,
  };
}

function malformedRecord(work: SourceWork, line: number, lineHash: string): MigrationRecord {
  return {
    ...recordBase(work, line, lineHash, "malformed-line"),
    originalId: null,
    sessionKey: null,
    timestamp: null,
    role: null,
    targetEntryKind: null,
    executionDisposition: "review-required",
    duplicateOf: null,
    lineage: {},
    usage: null,
  };
}

interface HistoryOptions {
  readonly limits: MigrationLimits;
  readonly seenArchiveCursors: Map<number, Readonly<{ sourceId: string; line: number }>>;
  readonly archiveCursorCollisions: Set<number>;
  readonly archiveUsages: ArchiveUsageObservation[];
  readonly onEntry: () => void;
  readonly onDuplicateCursor: () => void;
  readonly onMalformed: () => void;
  readonly onLine: () => void;
  readonly getRecordLimitReached: () => boolean;
}

function inventoryHistorySource(
  work: SourceWork,
  emit: (record: MigrationRecord, work: SourceWork) => boolean,
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
  options: HistoryOptions,
): void {
  const bytes = work.bytes;
  if (!bytes) return;
  if ((work.lineCount ?? 0) > options.limits.maxLinesPerSource) {
    work.status = "incomplete";
    issue("line_limit_exceeded", work.input.sourceId, null, work.sha256);
  }
  let linesProcessed = 0;
  for (const line of physicalLines(bytes)) {
    if (linesProcessed >= options.limits.maxLinesPerSource) {
      work.unprocessedLines = Math.max(0, (work.lineCount ?? line.number) - line.number + 1);
      work.status = "incomplete";
      break;
    }
    linesProcessed++;
    options.onLine();
    const lineHash = sha256(line.bytes);
    if (lineIsBlank(line)) continue;
    if (options.getRecordLimitReached()) {
      work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
      work.status = "incomplete";
      break;
    }
    let parsed: unknown;
    try {
      parsed = decodeJson(line);
    } catch {
      options.onMalformed();
      issue(line.number === work.lineCount && !line.terminated ? "malformed_or_truncated_final_line" : "malformed_json_line", work.input.sourceId, line.number, lineHash);
      if (!emit(malformedRecord(work, line.number, lineHash), work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }
    if (!isObject(parsed)) {
      options.onMalformed();
      issue("history_line_not_object", work.input.sourceId, line.number, lineHash);
      if (!emit(malformedRecord(work, line.number, lineHash), work)) {
        work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
        break;
      }
      continue;
    }
    options.onEntry();
    const rawCursor = own(parsed, "cursor");
    const cursor = safeNonNegativeInt(rawCursor);
    if (rawCursor === undefined) issue("missing_history_cursor", work.input.sourceId, line.number, lineHash);
    else if (cursor === null) issue("invalid_history_cursor", work.input.sourceId, line.number, lineHash);
    let duplicateOf: Readonly<{ sourceId: string; line: number }> | null = null;
    if (cursor !== null) {
      duplicateOf = options.seenArchiveCursors.get(cursor) ?? null;
      if (duplicateOf) {
        options.archiveCursorCollisions.add(cursor);
        options.onDuplicateCursor();
        issue("duplicate_history_cursor", work.input.sourceId, line.number, lineHash);
      } else {
        options.seenArchiveCursors.set(cursor, location(work.input.sourceId, line.number));
      }
    }
    const rawSessionKey = own(parsed, "session_key");
    const sessionKeyRaw = typeof rawSessionKey === "string" ? rawSessionKey : null;
    if (rawSessionKey !== undefined && sessionKeyRaw === null) issue("invalid_history_session_key", work.input.sourceId, line.number, lineHash);
    const messages = own(parsed, "messages");
    const rawSchemaVersion = own(parsed, "schema_version");
    const schemaVersion = safeNonNegativeInt(rawSchemaVersion);
    const rawMessageCount = own(parsed, "message_count");
    const declaredMessages = safeNonNegativeInt(rawMessageCount);
    const hasStructuredMessages = Array.isArray(messages);
    if (messages !== undefined && !hasStructuredMessages) issue("history_messages_not_array", work.input.sourceId, line.number, lineHash);
    if (rawMessageCount !== undefined && declaredMessages === null) issue("invalid_archive_message_count", work.input.sourceId, line.number, lineHash);
    if (schemaVersion !== null && ![1, 2, 3].includes(schemaVersion)) issue("unknown_history_schema_version", work.input.sourceId, line.number, lineHash);
    if (hasStructuredMessages && declaredMessages !== null && declaredMessages !== messages.length) {
      issue("archive_message_count_mismatch", work.input.sourceId, line.number, lineHash);
    }
    let kind: string;
    let targetEntryKind: string;
    if (own(parsed, "kind") === "conversation" || (own(parsed, "kind") === undefined && hasStructuredMessages)) {
      kind = own(parsed, "kind") === "conversation" ? "conversation" : "legacy-structured";
      targetEntryKind = "nanobot.legacy.history";
    } else if (typeof own(parsed, "content") === "string") {
      kind = "legacy-text";
      targetEntryKind = "nanobot.legacy.history";
    } else {
      kind = "unknown";
      targetEntryKind = "nanobot.legacy.unknown";
      issue("unknown_history_record_shape", work.input.sourceId, line.number, lineHash);
    }
    const rawUsage = own(parsed, "usage");
    const usage = rawUsage === undefined ? null : parseSparseUsage(rawUsage);
    if (usage?.status === "invalid") issue("invalid_archived_usage", work.input.sourceId, line.number, lineHash);
    if (usage && usage.unknownFields > 0) issue("unknown_archived_usage_fields", work.input.sourceId, line.number, lineHash);
    const idempotencyKey = own(parsed, "_idempotency_key");
    const idempotencyDigest = typeof idempotencyKey === "string" ? sha256(idempotencyKey) : null;
    const rawStart = own(parsed, "start_time");
    const rawEnd = own(parsed, "end_time");
    const startTime = safeTimestamp(rawStart);
    const endTime = safeTimestamp(rawEnd);
    if (rawStart !== undefined && startTime === null) issue("invalid_history_start_time", work.input.sourceId, line.number, lineHash);
    if (rawEnd !== undefined && endTime === null) issue("invalid_history_end_time", work.input.sourceId, line.number, lineHash);
    const rawTimestamp = own(parsed, "timestamp");
    const timestamp = safeTimestamp(rawTimestamp);
    if (rawTimestamp !== undefined && timestamp === null) issue("invalid_history_timestamp", work.input.sourceId, line.number, lineHash);
    const messageCount = hasStructuredMessages ? messages.length : declaredMessages;
    const lineage: Record<string, unknown> = {
      cursor,
      schemaVersion,
      messageCount,
      declaredMessageCount: declaredMessages,
      startTime,
      endTime,
      idempotencyKeySha256: idempotencyDigest,
      embeddedMessageIds: "not-present-in-history-v3-cleaning-schema",
    };
    const usageReport = usage ? { status: usage.status, counters: usage.counters } : null;
    if (schemaVersion === null && rawSchemaVersion !== undefined) {
      issue("invalid_history_schema_version", work.input.sourceId, line.number, lineHash);
    }
    const record: MigrationRecord = {
      ...recordBase(work, line.number, lineHash, "history-entry"),
      originalId: cursor === null ? null : safeIdentifier(String(cursor)),
      sessionKey: safeIdentifier(sessionKeyRaw),
      timestamp,
      role: kind,
      targetEntryKind,
      executionDisposition: "historical-only-never-runnable",
      duplicateOf,
      lineage,
      usage: usageReport,
    };
    if (!emit(record, work)) {
      work.unprocessedLines = Math.max(1, (work.lineCount ?? line.number) - line.number + 1);
      break;
    }
    options.archiveUsages.push({
      sessionKey: sessionKeyRaw,
      cursor,
      counters: usage?.counters ?? null,
      status: rawUsage === undefined || cursor === null ? "unknown" : usage?.status ?? "invalid",
      duplicateCursor: duplicateOf !== null,
    });
  }
}

interface ConfigResult {
  readonly presetCount: number;
  readonly summary: Record<string, unknown>;
}

function inventoryConfigSource(
  work: SourceWork,
  emit: (record: MigrationRecord, work: SourceWork) => boolean,
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
  limits: MigrationLimits,
): ConfigResult {
  const bytes = work.bytes;
  if (!bytes) return { presetCount: 0, summary: { sourceId: work.input.sourceId, status: "not-processed" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch {
    issue("malformed_or_truncated_config_json", work.input.sourceId, 1, work.sha256);
    work.status = "incomplete";
    emit(malformedRecord(work, 1, work.sha256 ?? sha256(bytes)), work);
    return { presetCount: 0, summary: { sourceId: work.input.sourceId, status: "invalid-json" } };
  }
  if (!isObject(parsed)) {
    issue("config_root_not_object", work.input.sourceId, 1, work.sha256);
    work.status = "incomplete";
    return { presetCount: 0, summary: { sourceId: work.input.sourceId, status: "invalid-root" } };
  }
  const lineHash = work.sha256 ?? sha256(bytes);
  const presetsCamel = own(parsed, "modelPresets");
  const presetsSnake = own(parsed, "model_presets");
  if (presetsCamel !== undefined && presetsSnake !== undefined) {
    issue("ambiguous_model_preset_aliases", work.input.sourceId, 1, lineHash);
  }
  const rawPresets = presetsCamel !== undefined ? presetsCamel : presetsSnake;
  const presets = isObject(rawPresets) ? rawPresets : Object.create(null) as Record<string, unknown>;
  if (rawPresets !== undefined && !isObject(rawPresets)) issue("model_presets_not_object", work.input.sourceId, 1, lineHash);
  const defaults = isObject(own(isObject(own(parsed, "agents")) ? own(parsed, "agents") as Record<string, unknown> : {}, "defaults"))
    ? own(own(parsed, "agents") as Record<string, unknown>, "defaults") as Record<string, unknown>
    : Object.create(null) as Record<string, unknown>;
  const agentModel = safeIdentifier(own(defaults, "model"));
  const agentProvider = safeIdentifier(own(defaults, "provider"));
  const activeRaw = own(defaults, "model_preset");
  const activePreset = safeIdentifier(activeRaw === undefined ? "default" : activeRaw);
  const providerObject = isObject(own(parsed, "providers")) ? own(parsed, "providers") as Record<string, unknown> : {};
  const configuredBuiltinProviders = Object.keys(providerObject).filter((key) => BUILTIN_PROVIDERS.has(key)).length;
  const dynamicProviderCount = Object.keys(providerObject).filter((key) => !BUILTIN_PROVIDERS.has(key)).length;
  const presetNames = Object.keys(presets).sort();
  const hasImplicitDefault = own(defaults, "model") !== undefined || own(defaults, "provider") !== undefined;
  const presetCount = presetNames.length + (hasImplicitDefault ? 1 : 0);
  let presetRecordsEmitted = 0;
  const runPresetsRaw = own(defaults, "run_presets") ?? own(defaults, "runPresets");
  const runPresetCount = isObject(runPresetsRaw) ? Object.keys(runPresetsRaw).length : 0;
  if (runPresetsRaw !== undefined && !isObject(runPresetsRaw)) issue("run_presets_not_object", work.input.sourceId, 1, lineHash);
  for (const name of presetNames) {
    const rawPreset = presets[name];
    const preset = isObject(rawPreset) ? rawPreset : null;
    if (!preset) issue("model_preset_not_object", work.input.sourceId, 1, lineHash);
    const display = preset ? presetSummary(name, preset, false) : { name: safeIdentifier(name), status: "invalid-shape" };
    const record: MigrationRecord = {
      ...recordBase(work, 1, lineHash, "config-preset"),
      originalId: safeIdentifier(name),
      sessionKey: null,
      timestamp: null,
      role: "model-preset",
      targetEntryKind: "host-configuration-review",
      executionDisposition: "review-required",
      duplicateOf: null,
      lineage: display,
      usage: null,
    };
    if (!emit(record, work)) break;
    presetRecordsEmitted++;
  }
  const defaultPreset = presetSummary("default", defaults, true);
  if (hasImplicitDefault) {
    if (emit({
      ...recordBase(work, 1, lineHash, "config-preset"),
      originalId: safeIdentifier("default"),
      sessionKey: null,
      timestamp: null,
      role: "implicit-default-preset",
      targetEntryKind: "host-configuration-review",
      executionDisposition: "review-required",
      duplicateOf: null,
      lineage: defaultPreset,
      usage: null,
    }, work)) presetRecordsEmitted++;
  }
  const knownRootKeys = new Set(["agents", "providers", "model_presets", "modelPresets", "channels", "tools", "gateway", "api", "transcription"]);
  const unknownRootKeyCount = Object.keys(parsed).filter((key) => !knownRootKeys.has(key)).length;
  const summary = {
    sourceId: work.input.sourceId,
    status: "parsed",
    presetCount,
    presetRecordsEmitted,
    unprocessedPresetCount: presetCount - presetRecordsEmitted,
    activePreset,
    runPresetCount,
    configuredBuiltinProviders,
    dynamicProviderCount,
    unknownRootKeyCount,
    uninspectedSections: UNINSPECTED_CONFIG_SECTIONS.filter((key) => own(parsed, key) !== undefined),
    defaultModel: agentModel,
    defaultProvider: agentProvider,
    credentialsAndProviderValues: "omitted",
    validation: "not-run; no Python config loader or environment resolution",
    boundsApplied: limits.maxRecords,
  };
  return { presetCount, summary };
}

function presetSummary(name: string, preset: Record<string, unknown>, implicit: boolean): Record<string, unknown> {
  return {
    name: safeIdentifier(name),
    implicit,
    model: safeIdentifier(own(preset, "model")),
    provider: safeIdentifier(own(preset, "provider")),
    maxTokens: safeNonNegativeInt(own(preset, "max_tokens")),
    contextWindowTokens: safeNonNegativeInt(own(preset, "context_window_tokens")),
    temperature: finiteNumber(own(preset, "temperature")),
    reasoningEffort: safeIdentifier(own(preset, "reasoning_effort")),
    needsVisionHandoff: typeof own(preset, "needs_vision_handoff") === "boolean" ? own(preset, "needs_vision_handoff") : null,
    unrecognizedFieldCount: implicit ? null : Object.keys(preset).filter((key) => !KNOWN_PRESET_FIELDS.has(key)).length,
    secretBearingProviderFields: "omitted",
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reconcileUsage(
  archives: ArchiveUsageObservation[],
  sessions: SessionUsageObservation[],
  issue: (code: string, sourceId: string, line: number | null, lineHash: string | null) => void,
): Record<string, unknown> {
  const archivedReported = zeroCounters();
  const activeReported = zeroCounters();
  let archivedKnownRecords = 0;
  let archivedUnknownRecords = 0;
  let archivedInvalidRecords = 0;
  let excludedCursorCollisions = 0;
  let activeExactSessions = 0;
  let activeUnknownSessions = 0;
  let activeInvalidSessions = 0;
  let activeRegressions = 0;
  let archiveOverflow = false;
  let activeOverflow = false;

  for (const archive of archives) {
    if (archive.duplicateCursor) {
      excludedCursorCollisions++;
      continue;
    }
    if (archive.status === "unknown" || archive.counters === null) {
      archivedUnknownRecords++;
      continue;
    }
    if (archive.status === "invalid") {
      archivedInvalidRecords++;
      continue;
    }
    archivedKnownRecords++;
    archiveOverflow = addCounters(archivedReported, archive.counters) || archiveOverflow;
  }
  if (archiveOverflow) {
    issue("archived_usage_aggregate_overflow", "usage-reconciliation", null, null);
  }

  const activeRows = sessions.map((session) => {
    if (session.status === "exact-delta") {
      activeExactSessions++;
      if (!session.duplicateSessionKey) activeOverflow = addCounters(activeReported, session.delta) || activeOverflow;
    } else if (session.status === "invalid") activeInvalidSessions++;
    else if (session.status === "regression") activeRegressions++;
    else if (session.status === "unknown") activeUnknownSessions++;
    return {
      sessionKey: safeIdentifier(session.sessionKey),
      status: session.status,
      current: session.current,
      archivedWatermark: session.watermark,
      activeDelta: session.delta,
      unknownFields: session.unknownFields,
      unknownUsageFieldCount: session.unknownUsageFieldCount,
      excludedFromAggregate: session.duplicateSessionKey,
    };
  });
  if (activeOverflow) issue("active_usage_aggregate_overflow", "usage-reconciliation", null, null);
  const combined = combinedCounters(archivedReported, activeReported);
  const combinedOverflow = USAGE_COUNTERS.some((key) =>
    archivedReported[key] !== null && activeReported[key] !== null && combined[key] === null,
  );
  if (combinedOverflow) issue("combined_usage_aggregate_overflow", "usage-reconciliation", null, null);
  return {
    source: "legacy history.jsonl usage deltas plus session metadata usage/_usage_archived snapshots",
    archived: {
      knownReportedSubtotal: archivedReported,
      recordsWithKnownUsage: archivedKnownRecords,
      recordsWithoutUsage: archivedUnknownRecords,
      invalidUsageRecords: archivedInvalidRecords,
      duplicateCursorRecordsExcluded: excludedCursorCollisions,
      aggregateOverflow: archiveOverflow,
    },
    active: {
      knownReportedSubtotal: activeReported,
      sessions: activeRows,
      exactDeltaSessions: activeExactSessions,
      unknownSessions: activeUnknownSessions,
      invalidSessions: activeInvalidSessions,
      watermarkRegressions: activeRegressions,
      duplicateSessionKeyRowsExcluded: sessions.filter((session) => session.duplicateSessionKey).length,
      aggregateOverflow: activeOverflow,
    },
    combinedObservedSubtotal: combined,
    combinedAggregateOverflow: combinedOverflow,
    providerModelBreakdown: "not-reconciled; native attribution is not assigned",
    conservation: "Observed archive deltas and exact active deltas are kept separate; key reuse and /new reset boundaries are not encoded well enough to prove a lifetime total.",
    nativePiUsage: "not assigned; requires a reviewed import transaction and separate Durable accounting reconciliation",
    requestCounts: "legacy reported deltas only; absent/invalid counters remain unknown",
  };
}

function combinedCounters(left: CounterSet, right: CounterSet): CounterSet {
  const result = blankCounters();
  for (const key of USAGE_COUNTERS) {
    const a = left[key];
    const b = right[key];
    const sum = a === null || b === null ? null : a + b;
    result[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
  return result;
}
