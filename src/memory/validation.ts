import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { MemoryFilter, MemoryQuery, MemoryReadQuery, MemoryRef, MemoryTarget } from "./contracts.js";

const MAX_TOKEN_CHARS = 16_384;
const MAX_CURSOR_CHARS = 4_096;
const MAX_QUERY_CHARS = 2_000;
const MAX_FILTER_VALUES = 256;
const MAX_STRING_CHARS = 4_096;
export const MEMORY_MAX_HITS = 100;
export const MEMORY_MAX_READ_CHARS = 8_000;
const targets = ["notes", "episodes", "messages", "tools"] as const;
const provenances = ["native", "imported", "unknown"] as const;
const states = ["open", "closed"] as const;
const roles = ["user", "assistant"] as const;
const kinds = ["call", "result"] as const;
const refKinds = ["note", "episode", "summary", "message", "tool"] as const;

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unsupported key: ${key}`);
}
function string(value: unknown, label: string, max = MAX_STRING_CHARS, nonempty = true): string {
  if (typeof value !== "string" || value.length > max || (nonempty && value.trim().length === 0)) throw new TypeError(`${label} must be a${nonempty ? " non-empty" : ""} string of at most ${max} characters`);
  return value;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}
function safeInteger(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new TypeError(`${label} must be a safe integer >= ${min}`);
  return value;
}
function stringList<T extends string = string>(value: unknown, label: string, allowed?: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_VALUES) throw new TypeError(`${label} must be a non-empty array of at most ${MAX_FILTER_VALUES} values`);
  const seen = new Set<string>();
  return value.map((item) => {
    const parsed = allowed ? enumValue(item, allowed, label) : string(item, label);
    if (seen.has(parsed)) throw new TypeError(`${label} must not contain duplicates`);
    seen.add(parsed);
    return parsed as T;
  });
}
function safePath(value: unknown, label: string): string {
  const path = string(value, label, 1_024);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) throw new TypeError(`${label} must be a safe relative path`);
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`${label} must be a safe relative path`);
  return path;
}
function validTimestamp(value: unknown, label: string): string {
  const timestamp = string(value, label, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) throw new TypeError(`${label} must be an ISO timestamp with an explicit timezone`);
  const [, y, mo, d, h, mi, s, , zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) throw new TypeError(`${label} is not a valid calendar timestamp`);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]!) throw new TypeError(`${label} is not a valid calendar timestamp`);
  if (zone !== "Z") {
    const zh = Number(zone!.slice(1, 3)), zm = Number(zone!.slice(4, 6));
    if (zh > 23 || zm > 59) throw new TypeError(`${label} has an invalid timezone offset`);
  }
  return timestamp;
}
function validateFilter(value: unknown, target: MemoryTarget): MemoryFilter {
  if (value === undefined) return {};
  const input = record(value, "filter");
  const allowed = target === "notes"
    ? ["pathPrefix", "description"]
    : target === "episodes"
      ? ["sessions", "channel", "provenance", "time", "episodes", "state"]
      : target === "messages"
        ? ["sessions", "channel", "provenance", "time", "episodes", "state", "roles"]
        : ["sessions", "channel", "provenance", "time", "episodes", "state", "toolNames", "kinds"];
  keys(input, allowed, "filter");
  const output: RecordValue = {};
  for (const key of ["sessions", "channel", "episodes", "description", "toolNames"] as const) {
    if (input[key] !== undefined) output[key] = stringList(input[key], `filter.${key}`);
  }
  if (input.provenance !== undefined) output.provenance = stringList(input.provenance, "filter.provenance", provenances);
  if (input.state !== undefined) output.state = stringList(input.state, "filter.state", states);
  if (input.roles !== undefined) output.roles = stringList(input.roles, "filter.roles", roles);
  if (input.kinds !== undefined) output.kinds = stringList(input.kinds, "filter.kinds", kinds);
  if (input.pathPrefix !== undefined) {
    const prefix = string(input.pathPrefix, "filter.pathPrefix", 1_024);
    safePath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, "filter.pathPrefix");
    output.pathPrefix = prefix;
  }
  if (input.time !== undefined) {
    const time = record(input.time, "filter.time");
    keys(time, ["from", "to"], "filter.time");
    const from = time.from === undefined ? undefined : validTimestamp(time.from, "filter.time.from");
    const to = time.to === undefined ? undefined : validTimestamp(time.to, "filter.time.to");
    if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) throw new TypeError("filter.time.from must be earlier than filter.time.to");
    output.time = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
  }
  return output as MemoryFilter;
}

export function validateQuery(value: unknown, mode: "search" | "browse"): MemoryQuery {
  if (mode !== "search" && mode !== "browse") throw new TypeError("mode is invalid");
  const input = record(value, "query");
  keys(input, ["target", "query", "filter", "order", "limit", "cursor"], "query");
  const target = enumValue(input.target, targets, "target");
  const output: RecordValue = { target };
  if (mode === "search") {
    if (typeof input.query !== "string" || input.query.trim().length === 0 || input.query.length > MAX_QUERY_CHARS) throw new TypeError(`search query must be non-empty and at most ${MAX_QUERY_CHARS} characters`);
    output.query = input.query;
    if (input.order !== undefined) throw new TypeError("order is not supported for search");
  } else {
    if (input.query !== undefined) throw new TypeError("query is not supported for browse");
    if (input.order !== undefined) output.order = enumValue(input.order, ["oldest", "newest"] as const, "order");
  }
  if (input.filter !== undefined) output.filter = validateFilter(input.filter, target);
  if (input.limit !== undefined) {
    output.limit = safeInteger(input.limit, "limit", 1);
    if ((output.limit as number) > MEMORY_MAX_HITS) throw new TypeError(`limit must not exceed ${MEMORY_MAX_HITS} hits`);
  }
  if (input.cursor !== undefined) output.cursor = string(input.cursor, "cursor", MAX_CURSOR_CHARS);
  return output as unknown as MemoryQuery;
}

export function validateRead(value: unknown): MemoryReadQuery {
  const input = record(value, "read query");
  keys(input, ["ref", "view", "cursor", "limit"], "read query");
  const ref = string(input.ref, "ref", MAX_TOKEN_CHARS);
  const output: RecordValue = { ref };
  if (input.view !== undefined) output.view = enumValue(input.view, ["summary", "transcript"] as const, "view");
  if (input.cursor !== undefined) output.cursor = string(input.cursor, "cursor", MAX_CURSOR_CHARS);
  if (input.limit !== undefined) {
    output.limit = safeInteger(input.limit, "limit", 1);
    if ((output.limit as number) > MEMORY_MAX_READ_CHARS) throw new TypeError(`limit must not exceed ${MEMORY_MAX_READ_CHARS} characters`);
  }
  return output as unknown as MemoryReadQuery;
}

function validateRef(value: unknown, expectedStore?: string): MemoryRef {
  const input = record(value, "memory ref");
  keys(input, ["version", "storeId", "kind", "session", "episodeStart", "entryId", "messageIndex", "blockIndex", "path", "fingerprint"], "memory ref");
  if (input.version !== 1) throw new TypeError("memory ref version is invalid");
  const storeId = string(input.storeId, "memory ref storeId", 512);
  if (expectedStore !== undefined && storeId !== expectedStore) throw new TypeError("memory ref belongs to a different store");
  const kind = enumValue(input.kind, refKinds, "memory ref kind");
  const fields: Record<string, readonly string[]> = {
    note: ["path", "fingerprint"],
    episode: ["session", "episodeStart", "fingerprint"],
    summary: ["session", "episodeStart", "fingerprint"],
    message: ["session", "entryId", "messageIndex", "fingerprint"],
    tool: ["session", "entryId", "blockIndex", "fingerprint"],
  };
  for (const key of ["session", "episodeStart", "entryId", "messageIndex", "blockIndex", "path", "fingerprint"]) {
    if (input[key] !== undefined && !fields[kind]!.includes(key)) throw new TypeError(`memory ref ${key} is not valid for ${kind}`);
  }
  const output: RecordValue = { version: 1, storeId, kind };
  if (input.session !== undefined) output.session = string(input.session, "memory ref session", 1_024);
  if (input.episodeStart !== undefined) output.episodeStart = safeInteger(input.episodeStart, "memory ref episodeStart", 1);
  if (input.entryId !== undefined) output.entryId = safeInteger(input.entryId, "memory ref entryId", 1);
  if (input.messageIndex !== undefined) output.messageIndex = safeInteger(input.messageIndex, "memory ref messageIndex");
  if (input.blockIndex !== undefined) output.blockIndex = safeInteger(input.blockIndex, "memory ref blockIndex");
  if (input.path !== undefined) output.path = safePath(input.path, "memory ref path");
  if (input.fingerprint !== undefined) output.fingerprint = string(input.fingerprint, "memory ref fingerprint", 256);
  const required: Record<string, readonly string[]> = {
    note: ["path"], episode: ["session", "episodeStart"], summary: ["session", "episodeStart"],
    message: ["session", "entryId", "messageIndex"], tool: ["session", "entryId", "blockIndex"],
  };
  for (const key of required[kind]!) if (output[key] === undefined) throw new TypeError(`memory ref ${kind} requires ${key}`);
  return output as unknown as MemoryRef;
}

export function encodeToken(value: unknown): string {
  let json: string | undefined;
  try { json = JSON.stringify(value); }
  catch { throw new TypeError("token value is not JSON-serializable"); }
  if (json === undefined) throw new TypeError("token value is not JSON-serializable");
  const token = Buffer.from(json, "utf8").toString("base64url");
  if (token.length > MAX_TOKEN_CHARS) throw new TypeError("token exceeds size limit");
  return token;
}
export function decodeToken(token: string): unknown {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError("token is invalid or too large");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) throw new TypeError("token is not canonical base64url");
  const json = bytes.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(bytes)) throw new TypeError("token is not valid UTF-8");
  try { return JSON.parse(json) as unknown; }
  catch { throw new TypeError("token does not contain valid JSON"); }
}
export function encodeRef(ref: MemoryRef): string {
  return encodeToken(validateRef(ref));
}
export function decodeRef(token: string, storeId: string): MemoryRef {
  string(storeId, "storeId", 512);
  return validateRef(decodeToken(token), storeId);
}

function canonical(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("hash input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("hash input is cyclic");
    seen.add(value);
    const result = `[${Array.from(value, (item) => item === undefined ? "null" : canonical(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new TypeError("hash input is cyclic");
    seen.add(object);
    const result = `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], seen)}`).join(",")}}`;
    seen.delete(object);
    return result;
  }
  throw new TypeError("hash input is not JSON-compatible");
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value, new Set()), "utf8").digest("hex");
}
export function sliceText(text: string, offset: number, limit: number): { content: string; nextOffset?: number } {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  safeInteger(offset, "offset");
  safeInteger(limit, "limit", 1);
  let start = Math.min(offset, text.length);
  if (start > 0 && start < text.length && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start++;
  let end = Math.min(text.length, start + limit);
  if (end < text.length && end > start && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) {
    if (end === start + 1) end++;
    else end--;
  }
  return end < text.length ? { content: text.slice(start, end), nextOffset: end } : { content: text.slice(start, end) };
}
function isHigh(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
