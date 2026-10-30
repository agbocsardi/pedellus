/**
 * Minimal private protocol between the local gateway owner and a CLI/terminal surface.
 *
 * The transport is a filesystem-protected Unix socket inside the configured data
 * directory and a newline-delimited JSON request/response/event stream. It is not a
 * public listener, a general RPC framework or a second runtime: the gateway keeps
 * every Durable handle, root/state/fork conversation and model credential.
 */

export const LOCAL_PROTOCOL_VERSION = 1;

export const LOCAL_PROTOCOL_LIMITS = Object.freeze({
  /** One request line; inputs are capped well below this by the CLI itself. */
  maxRequestLineBytes: 256 * 1024,
  /** One response line; entry pages are already projected and bounded. */
  maxResponseLineBytes: 4 * 1024 * 1024,
  /** Outstanding client requests before the client refuses more. */
  maxPendingRequests: 64,
  /** Buffered server snapshots before the oldest is dropped. */
  maxPendingSnapshots: 64,
  /** Bytes queued on one connection socket before a slow client is disconnected. */
  maxOutboundBytes: 8 * 1024 * 1024,
  /** Admitted prompt length, matching the terminal's own line bound. */
  maxInputChars: 32_000,
  maxEntryPage: 200,
  maxHistoryLimit: 50,
  maxConversationTokenChars: 32,
  maxLabelChars: 200,
  maxEntryId: Number.MAX_SAFE_INTEGER,
} as const);

/** Fixed error codes; the message never carries dependency or path text. */
export type LocalErrorCode = "invalid" | "busy" | "unavailable" | "failed";

export class LocalRequestError extends Error {
  override name = "LocalRequestError";
  readonly code: LocalErrorCode;
  constructor(code: LocalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The local endpoint cannot be used: another live owner holds it, the path cannot
 * be represented, or the gateway process cannot bind it. The CLI prints fixed text.
 */
export class LocalGatewayError extends Error {
  override name = "LocalGatewayError";
  constructor(readonly reason: "address" | "unavailable", message: string) {
    super(message);
  }
}

export interface LocalRequestEnvelope {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface LocalErrorBody {
  readonly code: LocalErrorCode;
  readonly message: string;
}

export type LocalServerMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: LocalErrorBody }
  | { readonly event: "snapshot"; readonly snapshot: unknown }
  | { readonly event: "settled"; readonly id: number; readonly settlement: unknown };

/** Parse one request line into a bounded envelope; reject everything else. */
export function parseRequestLine(line: string): LocalRequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LocalRequestError("invalid", "request is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRequestError("invalid", "request must be an object");
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new LocalRequestError("invalid", "request id must be a positive integer");
  }
  const method = record.method;
  if (typeof method !== "string" || !/^[a-z][a-zA-Z]{0,31}$/.test(method)) {
    throw new LocalRequestError("invalid", "request method is not accepted");
  }
  return { id, method, params: record.params };
}

/** Parse one server line; unknown shapes are refused by the client. */
export function parseServerLine(line: string): LocalServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LocalGatewayError("unavailable", "local gateway sent malformed JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalGatewayError("unavailable", "local gateway sent an unexpected message");
  }
  const record = value as Record<string, unknown>;
  if (record.event === "snapshot" && Object.hasOwn(record, "snapshot")) {
    return { event: "snapshot", snapshot: record.snapshot };
  }
  if (record.event === "settled" && typeof record.id === "number" && Number.isSafeInteger(record.id) && Object.hasOwn(record, "settlement")) {
    return { event: "settled", id: record.id, settlement: record.settlement };
  }
  if (typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id >= 1) {
    if (Object.hasOwn(record, "error")) {
      const error = asObject(record.error);
      const code = error?.code;
      const message = error?.message;
      if (code !== "invalid" && code !== "busy" && code !== "unavailable" && code !== "failed") {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected error");
      }
      if (typeof message !== "string") {
        throw new LocalGatewayError("unavailable", "local gateway sent an unexpected error");
      }
      return { id: record.id, error: { code, message } };
    }
    if (Object.hasOwn(record, "result")) return { id: record.id, result: record.result };
  }
  throw new LocalGatewayError("unavailable", "local gateway sent an unexpected message");
}

/** An absent name is the historical `cli:default` conversation. */
export function conversationToken(value: unknown): string {
  if (value === undefined) return "default";
  if (typeof value !== "string" || value.length > LOCAL_PROTOCOL_LIMITS.maxConversationTokenChars
    || !/^[a-z0-9](?:[a-z0-9_-]{0,30})[a-z0-9]$|^[a-z0-9]$/.test(value)) {
    throw new LocalRequestError("invalid", "conversation name is not accepted");
  }
  return value;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function requireObject(value: unknown): Record<string, unknown> {
  const record = asObject(value);
  if (record === undefined) throw new LocalRequestError("invalid", "request parameters must be an object");
  return record;
}

export function requireString(record: Record<string, unknown>, key: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string, maxChars: number): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function requireInteger(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LocalRequestError("invalid", `${key} is not accepted`);
  }
  return value;
}

export function optionalCursor(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const cursor = asObject(value);
  if (cursor === undefined) throw new LocalRequestError("invalid", `${key} is not accepted`);
  return cursor;
}

export function errorBody(error: unknown): LocalErrorBody {
  if (error instanceof LocalRequestError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "ConversationBusy") {
    return { code: "busy", message: "conversation is busy" };
  }
  return { code: "failed", message: "operation failed" };
}
