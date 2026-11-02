import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { ResetEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { MemoryBackend, MemoryHost, MemoryReadPage, MemoryRef, MemoryScope } from "./contracts.js";
import { projectEntry, entryFingerprint, scopeKey } from "./history-source.js";
import { decodeToken, encodeToken, hash, sliceText } from "./validation.js";

const MAX_PAGE = 8_000;
const SOURCE_LIMIT = 1;
const SCAN_LIMIT = 200;
const ERROR = "memory history reference is unavailable or has changed";
type Mode = "part" | "episode" | "summary";
type EpisodePhase = "open" | "items" | "close" | "done";
interface CursorState {
  readonly v: 1;
  readonly mode: Mode;
  readonly binding: string;
  readonly scope: string;
  readonly session: string;
  readonly start: number;
  readonly high: number;
  readonly anchor: string;
  readonly entry: number;
  readonly part: number;
  readonly offset: number;
  readonly emitted: boolean;
  readonly phase?: EpisodePhase;
  readonly currentFingerprint?: string;
  readonly unreadable?: number;
  readonly undated?: number;
  readonly omittedNonText?: number;
  readonly diagnosedEntryID?: number;
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(ERROR);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonicalJSON(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(object[key])}`).join(",")}}`;
  }
  throw new TypeError(ERROR);
}
function isReset(entry: EntryRecord): boolean { return entry.kind === ResetEntry.kind; }
function int(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sign(payload: string, key: Buffer): string { return createHmac("sha256", key).update(payload).digest("base64url"); }
function makeCursor(state: CursorState, key: Buffer): string {
  const payload = encodeToken(state);
  return encodeToken({ payload, signature: sign(payload, key) });
}
function parseCursor(token: string, key: Buffer): CursorState {
  const envelope = decodeToken(token) as { payload?: unknown; signature?: unknown };
  if (typeof envelope?.payload !== "string" || typeof envelope.signature !== "string") throw new TypeError(ERROR);
  const expected = Buffer.from(sign(envelope.payload, key));
  const supplied = Buffer.from(envelope.signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new TypeError(ERROR);
  const value = decodeToken(envelope.payload) as Partial<CursorState>;
  if (value.v !== 1 || !["part", "episode", "summary"].includes(value.mode as string)
    || typeof value.binding !== "string" || typeof value.scope !== "string" || typeof value.session !== "string"
    || !int(value.start) || !int(value.high) || typeof value.anchor !== "string" || !int(value.entry)
    || !int(value.part) || !int(value.offset) || typeof value.emitted !== "boolean"
    || (value.phase !== undefined && !["open", "items", "close", "done"].includes(value.phase))
    || (value.mode === "episode" && (value.phase === undefined || value.phase === "done"))
    || (value.unreadable !== undefined && !int(value.unreadable))
    || (value.undated !== undefined && !int(value.undated))
    || (value.omittedNonText !== undefined && !int(value.omittedNonText))
    || (value.diagnosedEntryID !== undefined && !int(value.diagnosedEntryID))) throw new TypeError(ERROR);
  return value as CursorState;
}
async function exact(host: MemoryHost, session: string, id: number, context: Context): Promise<EntryRecord> {
  const page = await host.entries(session, { minEntryId: id as never, maxEntryId: id as never, order: "ascending" }, SOURCE_LIMIT, undefined, context);
  const found = page.items.find((entry) => entry.id === id);
  if (!found || page.items.length > SOURCE_LIMIT) throw new TypeError(ERROR);
  return found;
}
async function first(host: MemoryHost, session: string, context: Context): Promise<EntryRecord | undefined> {
  const page = await host.entries(session, { order: "ascending" }, 1, undefined, context);
  if (page.items.length > 1) throw new TypeError(ERROR);
  return page.items[0];
}
async function tail(host: MemoryHost, session: string, context: Context): Promise<EntryRecord | undefined> {
  const page = await host.entries(session, { order: "descending" }, 1, undefined, context);
  if (page.items.length > 1) throw new TypeError(ERROR);
  return page.items[0];
}
function selectedPart(entry: EntryRecord, ref: MemoryRef) {
  const projection = projectEntry(entry);
  const part = ref.kind === "message"
    ? projection.parts.find((candidate) => candidate.kind === "message" && candidate.messageIndex === ref.messageIndex)
    : projection.parts.find((candidate) => candidate.kind === "tool" && candidate.toolOrdinal === ref.blockIndex);
  if (!part || (ref.kind === "message" && part.kind !== "message") || (ref.kind === "tool" && part.kind !== "tool")) throw new TypeError(ERROR);
  return { part, projection };
}
function pageSize(limit: number | undefined): number { return limit === undefined ? MAX_PAGE : Math.min(MAX_PAGE, limit); }
function binding(ref: MemoryRef, view: "summary" | "transcript"): string { return hash({ ref, view }); }
function scopeSession(scope: MemoryScope, key: string) {
  const session = scope.sessions.find((item) => item.sessionKey === key);
  if (!session) throw new TypeError(ERROR);
  return session;
}
function boundedSlice(text: string, offset: number, limit: number): { content: string; nextOffset?: number } {
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && end > offset && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  if (end === offset) return { content: "", nextOffset: offset };
  return end < text.length ? { content: text.slice(offset, end), nextOffset: end } : { content: text.slice(offset, end) };
}

export function createHistoryReader(host: MemoryHost): { read: MemoryBackend["read"]; close(): void } {
  const key = randomBytes(32);
  let closed = false;
  const read: MemoryBackend["read"] = async (query, ref, scope, context): Promise<MemoryReadPage> => {
    try {
      if (closed || ref.kind === "note") throw new TypeError(ERROR);
      const view = query.view ?? (ref.kind === "summary" ? "summary" : "transcript");
      const sessionKey = ref.session;
      if (!sessionKey) throw new TypeError(ERROR);
      scopeSession(scope, sessionKey);
      const maxChars = pageSize(query.limit);
      const refBinding = binding(ref, view);

      if (ref.kind === "message" || ref.kind === "tool") {
        if (view !== "transcript" || ref.entryId === undefined) throw new TypeError(ERROR);
        const entry = await exact(host, sessionKey, ref.entryId, context);
        if (ref.fingerprint !== undefined && entryFingerprint(entry) !== ref.fingerprint) throw new TypeError(ERROR);
        const { part, projection } = selectedPart(entry, ref);
        const serialized = canonicalJSON(part.value);
        const state = query.cursor === undefined ? undefined : parseCursor(query.cursor, key);
        const offset = state?.offset ?? 0;
        if (state && (state.mode !== "part" || state.binding !== refBinding || state.scope !== scopeKey(scope)
          || state.session !== sessionKey || state.start !== ref.entryId || state.high !== ref.entryId
          || state.anchor !== entryFingerprint(entry) || state.entry !== ref.entryId || state.part !== 0)) throw new TypeError(ERROR);
        const sliced = sliceText(serialized, offset, maxChars);
        const complete = sliced.nextOffset === undefined;
        const next = complete ? undefined : makeCursor({ v: 1, mode: "part", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
          start: ref.entryId, high: ref.entryId, anchor: entryFingerprint(entry), entry: ref.entryId, part: 0, offset: sliced.nextOffset!, emitted: true }, key);
        return { ref: query.ref, view, content: sliced.content, ...(next ? { cursor: next } : {}), complete,
          coverage: { complete: true, pageComplete: complete, unreadable: projection.malformed, undated: part.timestamp === null ? 1 : 0,
            omittedNonText: projection.omittedNonText, projection: "selected message/tool text only" } };
      }

      const start = ref.episodeStart;
      if (start === undefined) throw new TypeError(ERROR);
      const startEntry = await exact(host, sessionKey, start, context);
      const firstEntry = await first(host, sessionKey, context);
      if (!isReset(startEntry) && firstEntry?.id !== start) throw new TypeError(ERROR);
      const anchor = entryFingerprint(startEntry);
      if (ref.kind !== "summary" && ref.fingerprint !== undefined && ref.fingerprint !== anchor) throw new TypeError(ERROR);
      if (view === "summary") {
        const summary = await host.summary(sessionKey, start, context);
        if (summary.state !== "ready" || summary.snapshot.summaryTruncated) throw new TypeError(ERROR);
        const snap = summary.snapshot;
        const generation = hash(snap);
        const resource = canonicalJSON({ title: snap.title, body: snap.summary, coverage: {
          startEntryId: snap.startEntryId, resetEntryId: snap.resetEntryId, endEntryId: snap.endEntryId,
          sourceEntries: snap.sourceEntries, sourceMessages: snap.sourceMessages, sourceToolResults: snap.sourceToolResults,
          sourceTruncatedEntries: snap.sourceTruncatedEntries, complete: snap.coverageComplete,
        }, accounting: { completedAtMs: snap.completedAtMs }, version: snap.summarizerVersion, generation });
        const fingerprint = generation;
        if (ref.kind === "summary" && ref.fingerprint !== undefined && ref.fingerprint !== fingerprint) throw new TypeError(ERROR);
        const state = query.cursor === undefined ? undefined : parseCursor(query.cursor, key);
        const offset = state?.offset ?? 0;
        const summaryBinding = hash({ original: refBinding, fingerprint });
        if (state && (state.mode !== "summary" || state.binding !== summaryBinding || state.scope !== scopeKey(scope)
          || state.session !== sessionKey || state.start !== start || state.anchor !== anchor || state.high !== snap.endEntryId
          || state.entry !== start || state.part !== 0)) throw new TypeError(ERROR);
        const sliced = sliceText(resource, offset, maxChars);
        const pageComplete = sliced.nextOffset === undefined;
        const next = pageComplete ? undefined : makeCursor({ v: 1, mode: "summary", binding: summaryBinding, scope: scopeKey(scope), session: sessionKey,
          start, high: snap.endEntryId, anchor, entry: start, part: 0, offset: sliced.nextOffset!, emitted: true }, key);
        return { ref: query.ref, view, content: sliced.content, ...(next ? { cursor: next } : {}), complete: pageComplete,
          coverage: { complete: snap.coverageComplete, pageComplete, unreadable: 0, undated: 0,
            sourceEntries: snap.sourceEntries, sourceMessages: snap.sourceMessages, sourceToolResults: snap.sourceToolResults,
            sourceTruncatedEntries: snap.sourceTruncatedEntries, sourceTruncated: snap.sourceTruncatedEntries > 0,
            summaryTruncated: snap.summaryTruncated } };
      }

      const state = query.cursor === undefined ? undefined : parseCursor(query.cursor, key);
      const highEntry = state ? undefined : await tail(host, sessionKey, context);
      const high = state?.high ?? highEntry?.id ?? start;
      if (state && (state.mode !== "episode" || state.binding !== refBinding || state.scope !== scopeKey(scope)
        || state.session !== sessionKey || state.start !== start || state.anchor !== anchor || state.entry > high + 1)) throw new TypeError(ERROR);
      let phase: EpisodePhase = state?.phase ?? "open";
      let entryId = state?.entry ?? (isReset(startEntry) ? start + 1 : start);
      let partIndex = state?.part ?? 0;
      let offset = state?.offset ?? 0;
      let emitted = state?.emitted ?? false;
      let currentFingerprint = state?.currentFingerprint;
      let unreadable = state?.unreadable ?? 0;
      let undated = state?.undated ?? 0;
      let omittedNonText = state?.omittedNonText ?? 0;
      let diagnosedEntryID = state?.diagnosedEntryID;
      let content = "";
      let sourceReadCount = 0;
      while (content.length < maxChars && sourceReadCount < SCAN_LIMIT && phase !== "done") {
        if (phase === "open") {
          content += "[";
          phase = "items";
          continue;
        }
        if (phase === "items") {
          if (entryId > high) { phase = "close"; continue; }
          const result = await host.entries(sessionKey, { minEntryId: entryId as never, maxEntryId: high as never, order: "ascending" }, SOURCE_LIMIT, undefined, context);
          sourceReadCount++;
          const entry = result.items.find((item) => item.id >= entryId && item.id <= high);
          if (!entry) {
            if (state?.currentFingerprint && entryId === state.entry) throw new TypeError(ERROR);
            phase = "close";
            continue;
          }
          if (state?.currentFingerprint && entryId === state.entry && entry.id !== state.entry) throw new TypeError(ERROR);
          if (isReset(entry)) { phase = "close"; continue; }
          const fp = entryFingerprint(entry);
          if (entry.id === state?.entry && state.currentFingerprint && fp !== state.currentFingerprint) throw new TypeError(ERROR);
          const projection = projectEntry(entry);
          if (diagnosedEntryID !== entry.id) {
            unreadable += projection.malformed;
            omittedNonText += projection.omittedNonText;
            diagnosedEntryID = entry.id;
          }
          currentFingerprint = fp;
          const part = projection.parts[partIndex];
          if (!part) {
            entryId = entry.id + 1; partIndex = 0; offset = 0; currentFingerprint = undefined;
            continue;
          }
          const segment = `${emitted ? "," : ""}${canonicalJSON(part.value)}`;
          const remaining = maxChars - content.length;
          const sliced = boundedSlice(segment, offset, remaining);
          if (sliced.content.length === 0) break;
          if (offset === 0 && part.timestamp === null) undated++;
          content += sliced.content;
          offset += sliced.content.length;
          if (sliced.nextOffset !== undefined) break;
          emitted = true; partIndex++; offset = 0;
          if (partIndex >= projection.parts.length) {
            entryId = entry.id + 1; partIndex = 0; currentFingerprint = undefined;
          }
          continue;
        }
        if (phase === "close") {
          content += "]";
          phase = "done";
        }
      }
      const complete = phase === "done";
      const next = complete ? undefined : makeCursor({ v: 1, mode: "episode", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
        start, high, anchor, entry: entryId, part: partIndex, offset, emitted, phase, ...(currentFingerprint ? { currentFingerprint } : {}),
        unreadable, undated, omittedNonText, ...(diagnosedEntryID === undefined ? {} : { diagnosedEntryID }) }, key);
      return { ref: query.ref, view, content, ...(next ? { cursor: next } : {}), complete,
        coverage: { complete, pageComplete: complete, unreadable, undated, omittedNonText,
          projection: "user/assistant/tool text only; non-text blocks and other entry kinds omitted" } };
    } catch {
      throw new TypeError(ERROR);
    }
  };
  return { read, close: () => { closed = true; key.fill(0); } };
}
