/** Pure, bounded preparation of one Python-history-compatible conversation payload. */
import type { UsageArchiveProjection } from "../usage/index.js";

export type SanitizedArchiveMessage = Readonly<{
  timestamp: string | null;
  role: string;
  content: string;
  name?: string;
  tools_used?: readonly string[];
}>;

export type SanitizedConversationSnapshot = Readonly<{
  /** Host-provided archive timestamp (Python v3 uses an ISO timestamp). */
  timestamp: string;
  session_key?: string;
  messages: readonly SanitizedArchiveMessage[];
  summary?: string;
}>;

export type ArchiveUsageScope = Readonly<{
  storeNamespace: string;
  conversationId: number;
}>;

export type PreparedArchivePayload = Readonly<Record<string, unknown>>;

const MAX_MESSAGES = 1_000;
const MAX_FIELD_CHARS = 256 * 1024;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_ROWS_PER_BUCKET = 1_000;
const MAX_USAGE_KEY_CHARS = 512;
const TOKEN_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens"] as const;
const NATIVE_TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const OPTIONAL_FIELDS = ["cacheWrite1h", "reasoning"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid archive usage counter: ${label}`);
  }
  return value;
}

function finiteCost(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid archive usage cost: ${label}`);
  }
  return value;
}

function validateScope(value: unknown, expected: ArchiveUsageScope): Record<string, unknown> {
  if (!isRecord(value) || !exactKeys(value, ["kind", "storeNamespace", "conversationId"]) ||
      value.kind !== "pi-durable-conversation" || value.storeNamespace !== expected.storeNamespace ||
      value.conversationId !== expected.conversationId) {
    throw new TypeError("Usage projection source does not match the host-supplied conversation scope");
  }
  if (typeof value.storeNamespace !== "string" || !value.storeNamespace.trim() || value.storeNamespace.length > 512 ||
      typeof value.conversationId !== "number" || !Number.isSafeInteger(value.conversationId) || value.conversationId < 1) {
    throw new TypeError("Invalid usage projection source scope");
  }
  return value;
}

function validateUsageRow(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.cost) ||
      !exactKeys(value, [...NATIVE_TOKEN_FIELDS, "cost"], OPTIONAL_FIELDS) ||
      !exactKeys(value.cost, COST_FIELDS)) {
    throw new TypeError(`Malformed native usage row: ${label}`);
  }
  const row = value;
  for (const field of NATIVE_TOKEN_FIELDS) safeCount(row[field], `${label}.${field}`);
  for (const field of COST_FIELDS) finiteCost(value.cost[field], `${label}.cost.${field}`);
  if (row.reasoning !== undefined) {
    safeCount(row.reasoning, `${label}.reasoning`);
    if ((row.reasoning as number) > (row.output as number)) throw new TypeError(`Invalid reasoning subset: ${label}`);
  }
  if (row.cacheWrite1h !== undefined) {
    safeCount(row.cacheWrite1h, `${label}.cacheWrite1h`);
    if ((row.cacheWrite1h as number) > (row.cacheWrite as number)) throw new TypeError(`Invalid cache-write subset: ${label}`);
  }
  return row;
}

function validateBucket(value: unknown, label: string): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`Malformed usage bucket: ${label}`);
  const keys = Object.keys(value);
  if (keys.length > MAX_USAGE_ROWS_PER_BUCKET) throw new RangeError(`Usage bucket exceeds ${MAX_USAGE_ROWS_PER_BUCKET} rows`);
  const result: Record<string, Record<string, unknown>> = Object.create(null);
  for (const key of keys) {
    if (key.length > MAX_USAGE_KEY_CHARS) throw new RangeError(`Usage key exceeds ${MAX_USAGE_KEY_CHARS} characters`);
    result[key] = validateUsageRow(value[key], `${label}.${key}`);
  }
  return result;
}

function providerModel(key: string): { provider: string; model: string } {
  const separator = key.indexOf("/");
  return separator < 0
    ? { provider: "unknown", model: key }
    : { provider: key.slice(0, separator) || "unknown", model: key.slice(separator + 1) };
}

function validateLegacy(value: unknown, models: Record<string, Record<string, unknown>>): void {
  if (!isRecord(value) || !exactKeys(value, [], [...TOKEN_FIELDS, "by_model"])) {
    throw new TypeError("Malformed legacy usage projection");
  }
  let sums = [0, 0, 0, 0];
  const keys = Object.keys(models);
  if (keys.length === 0) {
    if (Object.keys(value).length !== 0) throw new TypeError("Legacy usage exists without model deltas");
    return;
  }
  if (!exactKeys(value, [...TOKEN_FIELDS, "by_model"]) || !isRecord(value.by_model)) {
    throw new TypeError("Legacy model usage is incomplete");
  }
  const byModel = value.by_model;
  if (Object.keys(byModel).length !== keys.length) throw new TypeError("Legacy/native model rows disagree");
  for (const key of keys) {
    const native = models[key];
    if (native === undefined) throw new TypeError(`Missing native model row: ${key}`);
    const prompt = (native.input as number) + (native.cacheRead as number) + (native.cacheWrite as number);
    safeCount(prompt, `legacy.by_model.${key}.prompt_tokens`);
    const attribution = providerModel(key);
    const row = byModel[key];
    if (!isRecord(row) || !exactKeys(row, ["provider", "model", "provider_model", ...TOKEN_FIELDS]) ||
        row.provider !== attribution.provider || row.model !== attribution.model || row.provider_model !== key ||
        row.prompt_tokens !== prompt || row.completion_tokens !== native.output ||
        row.total_tokens !== native.totalTokens || row.cached_tokens !== native.cacheRead) {
      throw new TypeError(`Legacy/native usage mismatch: ${key}`);
    }
    const fields = [prompt, native.output as number, native.totalTokens as number, native.cacheRead as number];
    sums = sums.map((sum, i) => safeCount(sum + (fields[i] ?? 0), `legacy aggregate ${TOKEN_FIELDS[i]}`));
  }
  TOKEN_FIELDS.forEach((field, index) => {
    if (value[field] !== sums[index]) throw new TypeError(`Legacy usage aggregate mismatch: ${field}`);
  });
}

function validateProjection(value: unknown, expected: ArchiveUsageScope): Record<string, unknown> {
  const topRequired = ["source", "accounting", "hasDelta", "legacy", "native", "requestCount", "unknownFields", "nextCursor"];
  if (!isRecord(value) || !exactKeys(value, topRequired) ||
      value.accounting !== "committed-native-usage-only" || typeof value.hasDelta !== "boolean") {
    throw new TypeError("Malformed usage delta projection");
  }
  const source = validateScope(value.source, expected);
  if (!isRecord(value.native) || !exactKeys(value.native, ["models", "tools"])) {
    throw new TypeError("Malformed native usage projection");
  }
  const models = validateBucket(value.native.models, "native.models");
  const tools = validateBucket(value.native.tools, "native.tools");
  validateLegacy(value.legacy, models);
  if (!isRecord(value.requestCount) || !exactKeys(value.requestCount, ["status"]) || value.requestCount.status !== "unknown") {
    throw new TypeError("Request count must remain explicitly unknown");
  }
  if (!Array.isArray(value.unknownFields) || value.unknownFields.length > MAX_USAGE_ROWS_PER_BUCKET * 4) {
    throw new TypeError("Malformed or oversized unknown usage fields");
  }
  const unknownKeys = new Set<string>();
  for (const item of value.unknownFields) {
    if (!isRecord(item) || !exactKeys(item, ["bucket", "key", "field"]) ||
        (item.bucket !== "models" && item.bucket !== "tools") || typeof item.key !== "string" ||
        (item.field !== "cacheWrite1h" && item.field !== "reasoning")) {
      throw new TypeError("Malformed optional usage provenance");
    }
    const bucket = item.bucket === "models" ? models : tools;
    if (!Object.hasOwn(bucket, item.key)) throw new TypeError("Unknown usage field references a missing native row");
    const markedRow = bucket[item.key];
    if (markedRow === undefined) throw new TypeError("Unknown usage field references a missing native row");
    if (Object.hasOwn(markedRow, item.field)) throw new TypeError("Unknown usage marker conflicts with a known delta");
    const marker = `${item.bucket}\0${item.key}\0${item.field}`;
    if (unknownKeys.has(marker)) throw new TypeError("Duplicate unknown usage field marker");
    unknownKeys.add(marker);
  }
  const cursor = value.nextCursor;
  if (!isRecord(cursor) || !exactKeys(cursor, ["version", "source", "cumulative"]) || cursor.version !== 1) {
    throw new TypeError("Malformed usage cursor proposal");
  }
  validateScope(cursor.source, expected);
  if (!isRecord(cursor.cumulative) || !exactKeys(cursor.cumulative, ["source", "status", "accounting", "models", "tools"]) ||
      cursor.cumulative.status !== "available" || cursor.cumulative.accounting !== "committed-native-usage-only") {
    throw new TypeError("Malformed cumulative cursor snapshot");
  }
  validateScope(cursor.cumulative.source, expected);
  const cumulativeModels = validateBucket(cursor.cumulative.models, "cursor.models");
  const cumulativeTools = validateBucket(cursor.cumulative.tools, "cursor.tools");
  if (Object.keys(models).some((key) => !Object.hasOwn(cumulativeModels, key)) ||
      Object.keys(tools).some((key) => !Object.hasOwn(cumulativeTools, key))) {
    throw new TypeError("Usage delta row is absent from its cumulative cursor");
  }
  for (const [delta, cumulative, label] of [
    [models, cumulativeModels, "models"], [tools, cumulativeTools, "tools"],
  ] as const) {
    for (const key of Object.keys(delta)) {
      const deltaRow = delta[key];
      const cumulativeRow = cumulative[key];
      if (deltaRow === undefined || cumulativeRow === undefined) throw new TypeError(`Missing usage row: ${label}.${key}`);
      for (const field of NATIVE_TOKEN_FIELDS) {
        if ((deltaRow[field] as number) > (cumulativeRow[field] as number)) {
          throw new TypeError(`Usage delta exceeds cumulative value: ${label}.${key}.${field}`);
        }
      }
      for (const field of COST_FIELDS) {
        if (((deltaRow.cost as Record<string, number>)[field] ?? 0) >
            ((cumulativeRow.cost as Record<string, number>)[field] ?? 0)) {
          throw new TypeError(`Usage cost delta exceeds cumulative value: ${label}.${key}.${field}`);
        }
      }
    }
  }
  if (value.hasDelta !== (Object.keys(models).length > 0 || Object.keys(tools).length > 0 || unknownKeys.size > 0)) {
    throw new TypeError("Usage delta flag disagrees with projected rows");
  }
  return value;
}

function stripThink(input: string): string {
  const tag = "(?:think|thinking|thought)";
  const prefix = "(?:thinking|thinkin|thinki|think|though|thoug|thou|thin|thi|tho|th|t)";
  let text = input.replace(new RegExp(`<(${tag})>[\\s\\S]*?</\\1>`, "g"), "");
  text = text.replace(new RegExp(`^\\s*<${tag}>[\\s\\S]*$`), "");
  text = text.replace(/^\s*<thinking\/>\s*/, "").replace(/\s*<thinking\/>\s*$/, "");
  text = text.replace(new RegExp(`<${tag}(?![A-Za-z0-9_\\-:>/])`, "g"), "");
  text = text.replace(new RegExp(`^\\s*</${tag}>\\s*`), "");
  text = text.replace(new RegExp(`\\s*</${tag}>\\s*$`), "");
  text = text.replace(/^\s*<\|?channel\|?>\s*/, "");
  const partial = `(?:</?(?:${prefix})>?|<\\|?(?:c|ch|cha|chan|chann|channe|channel)(?:\\|?>?)?)$`;
  text = text.replace(new RegExp(partial), "").replace(/^\s*<\|?$/, "");
  return text.trim();
}

function immutableJsonCopy(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Archive input is not JSON-serializable");
  if (new TextEncoder().encode(encoded).byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError("Archive payload exceeds 4 MiB limit");
  }
  const copied: unknown = JSON.parse(encoded);
  const freeze = (node: unknown): void => {
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
  };
  freeze(copied);
  return copied;
}

/**
 * Prepare, but never persist, one archive record. The host must provide a
 * mapping for the conversation-scoped usage source; this function verifies
 * source identity, not transcript completeness or provenance authenticity.
 */
export function prepareArchivePayload(
  snapshot: SanitizedConversationSnapshot,
  projection: UsageArchiveProjection,
  expectedUsageScope: ArchiveUsageScope,
): PreparedArchivePayload {
  if (!isRecord(snapshot) || typeof snapshot.timestamp !== "string" || !snapshot.timestamp.trim()) {
    throw new TypeError("Archive snapshot requires a timestamp");
  }
  if (snapshot.timestamp.length > MAX_FIELD_CHARS) throw new RangeError("Archive timestamp exceeds field limit");
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0 || snapshot.messages.length > MAX_MESSAGES) {
    throw new RangeError(`Archive snapshot must contain 1-${MAX_MESSAGES} sanitized messages`);
  }
  if (snapshot.session_key !== undefined && typeof snapshot.session_key !== "string") {
    throw new TypeError("Archive session_key must be a string");
  }
  if (snapshot.session_key && snapshot.session_key.length > MAX_FIELD_CHARS) throw new RangeError("Archive session key exceeds field limit");
  if (snapshot.summary !== undefined && typeof snapshot.summary !== "string") {
    throw new TypeError("Archive summary must be a string");
  }
  if (snapshot.summary && snapshot.summary.length > MAX_FIELD_CHARS) throw new RangeError("Archive summary exceeds field limit");
  let estimatedChars = 0;
  const accountText = (text: string, label: string): void => {
    const size = JSON.stringify(text).length;
    estimatedChars += size;
    if (estimatedChars > MAX_PAYLOAD_BYTES / 2) throw new RangeError(`Archive payload exceeds preflight size limit at ${label}`);
  };
  accountText(snapshot.timestamp, "timestamp");
  accountText(snapshot.session_key ?? "", "session_key");
  accountText(snapshot.summary ?? "", "summary");
  const messages = [] as Array<{ timestamp: string | null; role: string; content: string; name?: string; tools_used?: string[] }>;
  for (const [index, message] of snapshot.messages.entries()) {
    if (!isRecord(message) || typeof message.role !== "string" || typeof message.content !== "string" ||
        !(typeof message.timestamp === "string" || message.timestamp === null)) {
      throw new TypeError(`Archive message ${index} is incomplete or malformed`);
    }
    if (Object.keys(message).some((key) => !["timestamp", "role", "content", "name", "tools_used"].includes(key))) {
      throw new TypeError(`Archive message ${index} contains fields outside the sanitized schema`);
    }
    if (message.name !== undefined && typeof message.name !== "string") throw new TypeError(`Archive message ${index} has an invalid name`);
    if (message.tools_used !== undefined &&
        (!Array.isArray(message.tools_used) || message.tools_used.some((tool) => typeof tool !== "string"))) {
      throw new TypeError(`Archive message ${index} has invalid tools_used`);
    }
    for (const text of [message.timestamp ?? "", message.role, message.content, message.name ?? "", ...(message.tools_used ?? [])]) {
      if (text.length > MAX_FIELD_CHARS) throw new RangeError(`Archive message ${index} exceeds field limit`);
      accountText(text, `message ${index}`);
    }
    messages.push({
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.tools_used === undefined ? {} : { tools_used: [...message.tools_used] }),
    });
  }
  const validatedProjection = validateProjection(projection, expectedUsageScope);
  const projectedChars = JSON.stringify(validatedProjection).length;
  if (projectedChars > MAX_PAYLOAD_BYTES / 2 || estimatedChars + projectedChars > MAX_PAYLOAD_BYTES / 2) {
    throw new RangeError("Archive usage provenance exceeds preflight size limit");
  }
  const cleanedSummary = snapshot.summary?.trim() ? stripThink(snapshot.summary.trim()) : "";
  const summary = cleanedSummary.length > MAX_SUMMARY_CHARS
    ? `${Array.from(cleanedSummary).slice(0, MAX_SUMMARY_CHARS).join("")}\n... (truncated)`
    : cleanedSummary;
  const timestamps = messages.map((message) => message.timestamp).filter((value): value is string => !!value);
  const payload: Record<string, unknown> = {
    schema_version: 3,
    kind: "conversation",
    timestamp: snapshot.timestamp,
    start_time: timestamps.length ? timestamps.reduce((a, b) => a < b ? a : b) : null,
    end_time: timestamps.length ? timestamps.reduce((a, b) => a > b ? a : b) : null,
    session_key: snapshot.session_key || "unknown",
    message_count: messages.length,
    messages,
  };
  if (summary) payload.summary = summary;
  if (Object.keys(validatedProjection.legacy as object).length) payload.usage = validatedProjection.legacy;
  payload.usage_provenance = validatedProjection;
  const result = immutableJsonCopy(payload);
  if (!isRecord(result)) throw new TypeError("Could not prepare archive payload");
  return result as PreparedArchivePayload;
}
