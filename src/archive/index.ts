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

export type PreparedArchivePayload = Readonly<Record<string, unknown>>;

const MAX_MESSAGES = 1_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Prepare (but never persist) one archive record. The caller must supply an
 * already-sanitized message snapshot and a projection produced by usage SDK.
 * Rejects incomplete/malformed input; does not truncate, sanitize, assign IDs,
 * read storage, or advance a cursor.
 */
export function prepareArchivePayload(
  snapshot: SanitizedConversationSnapshot,
  projection: UsageArchiveProjection,
): PreparedArchivePayload {
  if (!isRecord(snapshot) || typeof snapshot.timestamp !== "string" || !snapshot.timestamp.trim()) {
    throw new TypeError("Archive snapshot requires a timestamp");
  }
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0 || snapshot.messages.length > MAX_MESSAGES) {
    throw new RangeError(`Archive snapshot must contain 1-${MAX_MESSAGES} sanitized messages`);
  }
  if (snapshot.session_key !== undefined && typeof snapshot.session_key !== "string") {
    throw new TypeError("Archive session_key must be a string");
  }
  if (snapshot.summary !== undefined && typeof snapshot.summary !== "string") {
    throw new TypeError("Archive summary must be a string");
  }
  for (const [index, message] of snapshot.messages.entries()) {
    if (!isRecord(message) || typeof message.role !== "string" || typeof message.content !== "string" ||
        !(typeof message.timestamp === "string" || message.timestamp === null)) {
      throw new TypeError(`Archive message ${index} is incomplete or malformed`);
    }
    if (Object.keys(message).some((key) => !["timestamp", "role", "content", "name", "tools_used"].includes(key))) {
      throw new TypeError(`Archive message ${index} contains fields outside the sanitized schema`);
    }
    if (message.name !== undefined && typeof message.name !== "string") {
      throw new TypeError(`Archive message ${index} has an invalid name`);
    }
    if (message.tools_used !== undefined &&
        (!Array.isArray(message.tools_used) || message.tools_used.some((tool) => typeof tool !== "string"))) {
      throw new TypeError(`Archive message ${index} has invalid tools_used`);
    }
  }
  if (!isRecord(projection) || projection.accounting !== "committed-native-usage-only" ||
      !isRecord(projection.legacy) || !isRecord(projection.source)) {
    throw new TypeError("Archive requires a usage delta projection");
  }
  if (projection.hasDelta && Object.keys(projection.legacy).length === 0 &&
      Object.keys(projection.native?.tools ?? {}).length === 0) {
    throw new TypeError("Usage projection indicates a delta without model or tool data");
  }

  const messages = snapshot.messages.map((message) => ({
    timestamp: message.timestamp,
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tools_used === undefined ? {} : { tools_used: [...message.tools_used] }),
  }));
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
  if (snapshot.summary?.trim()) payload.summary = snapshot.summary;
  if (Object.keys(projection.legacy).length) payload.usage = projection.legacy;
  // Preserve native counters, source scope, unknown-field markers and cursor proposal;
  // Python ignores unknown record fields, while consumers can inspect provenance.
  payload.usage_provenance = projection;
  const result = immutableJsonCopy(payload);
  if (!isRecord(result)) throw new TypeError("Could not prepare archive payload");
  return result as PreparedArchivePayload;
}
