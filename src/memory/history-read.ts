import { ResetEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { MemoryBackend, MemoryHost, MemoryReadPage, MemoryRef, MemoryScope } from "./contracts.js";
import { projectEntry, entryFingerprint, scopeKey } from "./history-source.js";
import { decodeToken, encodeToken, hash, sliceText } from "./validation.js";

const MAX_PAGE = 8_000;
const SOURCE_LIMIT = 200;
const SCAN_LIMIT = 200;
const ERROR = "memory history reference is unavailable or has changed";
type Mode = "part" | "episode" | "summary";
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
  readonly currentFingerprint?: string;
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
function makeCursor(state: CursorState): string {
  const payload = encodeToken(state);
  return encodeToken({ payload, checksum: hash(payload) });
}
function parseCursor(token: string): CursorState {
  const envelope = decodeToken(token) as { payload?: unknown; checksum?: unknown };
  if (typeof envelope?.payload !== "string" || typeof envelope.checksum !== "string" || hash(envelope.payload) !== envelope.checksum) throw new TypeError(ERROR);
  const value = decodeToken(envelope.payload) as Partial<CursorState>;
  if (value.v !== 1 || !["part", "episode", "summary"].includes(value.mode as string)
    || typeof value.binding !== "string" || typeof value.scope !== "string" || typeof value.session !== "string"
    || !int(value.start) || !int(value.high) || typeof value.anchor !== "string" || !int(value.entry)
    || !int(value.part) || !int(value.offset) || typeof value.emitted !== "boolean") throw new TypeError(ERROR);
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
function selectedPart(entry: EntryRecord, ref: MemoryRef): unknown {
  const projection = projectEntry(entry);
  const part = ref.kind === "message"
    ? projection.parts.find((candidate) => candidate.kind === "message" && candidate.messageIndex === ref.messageIndex)
    : projection.parts.find((candidate) => candidate.kind === "tool" && candidate.toolOrdinal === ref.blockIndex);
  if (!part || (ref.kind === "message" && part.kind !== "message") || (ref.kind === "tool" && part.kind !== "tool")) throw new TypeError(ERROR);
  return part.value;
}
function pageSize(limit: number | undefined): number {
  return limit === undefined ? MAX_PAGE : Math.min(MAX_PAGE, limit);
}
function binding(ref: MemoryRef, view: "summary" | "transcript"): string { return hash({ ref, view }); }
function scopeSession(scope: MemoryScope, key: string) {
  const session = scope.sessions.find((item) => item.sessionKey === key);
  if (!session) throw new TypeError(ERROR);
  return session;
}

export function createHistoryReader(host: MemoryHost): { read: MemoryBackend["read"]; close(): void } {
  const read: MemoryBackend["read"] = async (query, ref, scope, context): Promise<MemoryReadPage> => {
    try {
      if (ref.kind === "note") throw new TypeError(ERROR);
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
        const projection = projectEntry(entry);
        const serialized = canonicalJSON(selectedPart(entry, ref));
        const state = query.cursor === undefined ? undefined : parseCursor(query.cursor);
        const offset = state?.offset ?? 0;
        if (state && (state.mode !== "part" || state.binding !== refBinding || state.scope !== scopeKey(scope)
          || state.session !== sessionKey || state.start !== ref.entryId || state.high !== ref.entryId
          || state.anchor !== entryFingerprint(entry) || state.entry !== ref.entryId || state.part !== 0)) throw new TypeError(ERROR);
        const sliced = sliceText(serialized, offset, maxChars);
        const complete = sliced.nextOffset === undefined;
        const next = complete ? undefined : makeCursor({ v: 1, mode: "part", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
          start: ref.entryId, high: ref.entryId, anchor: entryFingerprint(entry), entry: ref.entryId, part: 0, offset: sliced.nextOffset!, emitted: true });
        return { ref: query.ref, view, content: sliced.content, ...(next ? { cursor: next } : {}), complete, coverage: { complete, unreadable: projection.malformed, undated: 0, omittedNonText: projection.omittedNonText, projection: "user/assistant/tool text only; non-text blocks and other entry kinds omitted" } };
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
        const state = query.cursor === undefined ? undefined : parseCursor(query.cursor);
        const offset = state?.offset ?? 0;
        const summaryBinding = hash({ original: refBinding, fingerprint });
        if (state && (state.mode !== "summary" || state.binding !== summaryBinding || state.scope !== scopeKey(scope)
          || state.session !== sessionKey || state.start !== start || state.anchor !== anchor || state.high !== snap.endEntryId
          || state.entry !== start || state.part !== 0)) throw new TypeError(ERROR);
        const sliced = sliceText(resource, offset, maxChars);
        const complete = sliced.nextOffset === undefined;
        const next = complete ? undefined : makeCursor({ v: 1, mode: "summary", binding: summaryBinding, scope: scopeKey(scope), session: sessionKey,
          start, high: snap.endEntryId, anchor, entry: start, part: 0, offset: sliced.nextOffset!, emitted: true });
        return { ref: query.ref, view, content: sliced.content, ...(next ? { cursor: next } : {}), complete, coverage: { complete, unreadable: 0, undated: 0 } };
      }

      const state = query.cursor === undefined ? undefined : parseCursor(query.cursor);
      const highEntry = state ? undefined : await tail(host, sessionKey, context);
      const high = state?.high ?? highEntry?.id ?? start;
      const initialEntry = state?.currentFingerprint ? await exact(host, sessionKey, state.entry, context) : startEntry;
      if (state && (state.mode !== "episode" || state.binding !== refBinding || state.scope !== scopeKey(scope)
        || state.session !== sessionKey || state.start !== start || state.anchor !== anchor || state.entry > high)) throw new TypeError(ERROR);
      const initialFp = state?.currentFingerprint ? entryFingerprint(initialEntry) : "";
      if (state?.currentFingerprint && initialFp !== state.currentFingerprint) throw new TypeError(ERROR);

      let content = state ? "" : "[";
      const pageBudget = maxChars - 1;
      let unreadable = 0;
      let omittedNonText = 0;
      let entryId = state?.entry ?? (isReset(startEntry) ? start + 1 : start);
      let partIndex = state?.part ?? 0;
      let offset = state?.offset ?? 0;
      let emitted = state?.emitted ?? false;
      let scanned = 0;
      let lastScanned: EntryRecord | undefined;
      let done = high < entryId;
      let nextState: CursorState | undefined;
      while (!done && content.length < pageBudget && scanned < SCAN_LIMIT) {
        const batch = await host.entries(sessionKey, { minEntryId: entryId as never, maxEntryId: high as never, order: "ascending" }, SOURCE_LIMIT, undefined, context);
        if (batch.items.length === 0) { done = true; break; }
        let advanced = false;
        for (const entry of batch.items) {
          if (entry.id < entryId || entry.id > high) continue;
          scanned++;
          lastScanned = entry;
          if (isReset(entry)) { done = true; break; }
          const fp = entryFingerprint(entry);
          if (state && entry.id === state.entry && fp !== state.currentFingerprint) throw new TypeError(ERROR);
          const projection = projectEntry(entry);
          unreadable += projection.malformed;
          omittedNonText += projection.omittedNonText;
          for (let index = entry.id === entryId ? partIndex : 0; index < projection.parts.length; index++) {
            const item = canonicalJSON(projection.parts[index]!.value);
            const prefix = emitted && offset === 0 ? "," : "";
            if (prefix.length && content.length < maxChars) content += prefix;
            const available = pageBudget - content.length;
            if (available <= 0) { nextState = { v: 1, mode: "episode", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
              start, high, anchor, entry: entry.id, part: index, offset, emitted, currentFingerprint: fp } as CursorState; break; }
            const sliced = sliceText(item, offset, available);
            content += sliced.content;
            if (sliced.nextOffset !== undefined) {
              nextState = { v: 1, mode: "episode", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
                start, high, anchor, entry: entry.id, part: index, offset: offset + sliced.content.length, emitted, currentFingerprint: fp } as CursorState;
              break;
            }
            emitted = true; offset = 0;
          }
          if (nextState) break;
          entryId = entry.id + 1; partIndex = 0; offset = 0; advanced = true;
          if (content.length >= pageBudget) break;
        }
        if (nextState || done || content.length >= pageBudget) break;
        if (!advanced) { done = true; break; }
        if (batch.items.length < SOURCE_LIMIT) done = true;
      }
      if (!done && !nextState && (scanned >= SCAN_LIMIT || content.length >= pageBudget)) {
        if (lastScanned) nextState = { v: 1, mode: "episode", binding: refBinding, scope: scopeKey(scope), session: sessionKey,
          start, high, anchor, entry: lastScanned.id, part: Number.MAX_SAFE_INTEGER, offset: 0, emitted, currentFingerprint: entryFingerprint(lastScanned) };
      }
      if (!nextState && done) content += "]";
      const complete = !nextState && done;
      const next = nextState ? makeCursor(nextState) : undefined;
      return { ref: query.ref, view, content, ...(next ? { cursor: next } : {}), complete,
        coverage: { complete, unreadable, undated: 0, omittedNonText, projection: "user/assistant/tool text only; non-text blocks and other entry kinds omitted" } };
    } catch {
      throw new TypeError(ERROR);
    }
  };
  return { read, close: () => undefined };
}
