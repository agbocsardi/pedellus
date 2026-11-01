import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, ResetEntry, ToolResultEntry, UserEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { HistoryCursor, HistorySummaryCursor } from "../history/index.js";
import type { MemoryBackend, MemoryHit, MemoryHost, MemoryPage, MemoryQuery, MemoryReadPage, MemoryRef, MemoryScope, MemorySession } from "./contracts.js";
import { decodeToken, encodeRef, encodeToken, hash, sliceText } from "./validation.js";

const PAGE = 50;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOTS = 32;
const MAX_READ = 32_768;
const RESET = ResetEntry.kind;
const sha = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object";
const timestamp = (entry: any): number | undefined => {
  const value = entry.timestamp ?? entry.createdAt ?? entry.time;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return undefined;
};
// No authoritative importer marker exists in retained Durable entries. Labels and entry age are
// not provenance, so every legacy/unmarked entry is honestly classified as unknown.
const provenance = (_entry: EntryRecord): "unknown" => "unknown";
const json = (v: unknown): string => JSON.stringify(v, null, 2);
const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v.flatMap((b: any) => isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []).join("\n");
};
function matchesCommon(filter: NonNullable<MemoryQuery["filter"]>, session: MemorySession, entry: EntryRecord, episodeStart: number, state: "open" | "closed"): boolean {
  if (filter.sessions && !filter.sessions.includes(session.sessionKey)) return false;
  if (filter.channel && !filter.channel.includes(session.channel ?? "")) return false;
  if (filter.provenance && !filter.provenance.includes(provenance(entry))) return false;
  if (filter.episodes && !filter.episodes.includes(String(episodeStart))) return false;
  if (filter.state && !filter.state.includes(state)) return false;
  if (filter.time) {
    const t = timestamp(entry);
    if (t === undefined || (filter.time.from !== undefined && t < Date.parse(filter.time.from)) || (filter.time.to !== undefined && t >= Date.parse(filter.time.to))) return false;
  }
  return true;
}
function fingerprint(value: unknown): string { return sha(value); }
function ref(scope: MemoryScope, kind: MemoryRef["kind"], fields: Partial<MemoryRef>): string {
  return encodeRef({ version: 1, storeId: scope.storeId, kind, ...fields } as MemoryRef);
}
function pageCursor(snapshot: string, index: number): string { return encodeToken({ v: 1, snapshot, index }); }

/** Read-only conversation backend. Indexes discover; committed Durable entries remain authoritative. */
export function createHistoryBackend(host: MemoryHost): MemoryBackend {
  const snapshots = new Map<string, Snapshot>();
  const epoch = randomUUID();
  function keep(snapshot: Snapshot): void {
    snapshots.set(snapshot.id, snapshot);
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  }
  function readSnapshot(token: string, scope: MemoryScope): { snapshot: Snapshot; index: number } {
    const value = decodeToken(token) as any;
    if (!isObj(value) || value.v !== 1 || value.epoch !== epoch || typeof value.snapshot !== "string" || !Number.isSafeInteger(value.index)) throw new TypeError("History cursor expired on gateway reopen; start a new query");
    const snapshot = snapshots.get(value.snapshot);
    if (!snapshot || snapshot.storeId !== scope.storeId || snapshot.scopeHash !== scopeHash(scope)) throw new TypeError("History cursor expired or scope changed; start a new query");
    return { snapshot, index: value.index };
  }
  async function entriesFor(session: MemorySession, scope: MemoryScope, ctx: Context): Promise<EntryRecord[]> {
    const high = (await host.entries(session.sessionKey, { order: "descending" }, 1, undefined, ctx)).items[0]?.id;
    const out: EntryRecord[] = [];
    let cursor: any;
    do {
      const page = await host.entries(session.sessionKey, { order: "ascending", ...(high === undefined ? {} : { maxEntryId: high }) }, 500, cursor, ctx);
      out.push(...page.items);
      if (out.length > MAX_SNAPSHOT_ENTRIES) throw new Error(`Authoritative history snapshot exceeds ${MAX_SNAPSHOT_ENTRIES} entries; narrow sessions or retry after retention`);
      cursor = page.next;
    } while (cursor !== undefined);
    return out;
  }
  async function snapshot(scope: MemoryScope, context: Context): Promise<Snapshot> {
    const data: SessionData[] = [];
    let totalEntries = 0;
    for (const session of scope.sessions) {
      const entries = await entriesFor(session, scope, context);
      totalEntries += entries.length;
      if (totalEntries > MAX_SNAPSHOT_ENTRIES) throw new Error(`Authoritative history snapshot exceeds ${MAX_SNAPSHOT_ENTRIES} total entries; narrow sessions or retry after retention`);
      data.push({ session, entries, highwater: entries.at(-1)?.id ?? 0 });
    }
    const result: Snapshot = { id: randomUUID(), epoch, storeId: scope.storeId, scopeHash: scopeHash(scope), sessions: data };
    keep(result);
    return result;
  }
  async function browse(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    const token = query.cursor;
    const { snapshot: snap, index } = token ? readSnapshot(token, scope) : { snapshot: await snapshot(scope, context), index: 0 };
    const all = query.target === "episodes" ? episodeCandidates(snap, scope) : messageCandidates(snap, scope, query.target === "tools" ? "tools" : "messages");
    const selected = all.filter((x) => applies(query, x));
    const ordered = orderHits(selected, query.order ?? "newest");
    const limit = query.limit ?? 20;
    const hits = ordered.slice(index, index + limit);
    const nextIndex = index + hits.length;
    const complete = nextIndex >= ordered.length;
    return { hits, ...(complete ? {} : { cursor: cursorFor(snap, nextIndex) }), complete, coverage: coverage(), freshness: { source: "authoritative Durable entries", highwaterCaptured: true, entries: snap.sessions.reduce((n, s) => n + s.entries.length, 0), indexUsed: false } };
  }
  async function search(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    if (query.target === "episodes") return searchEpisodes(query, scope, context);
    const limit = query.limit ?? 20;
    const token = query.cursor;
    let cursor: HistoryCursor | undefined;
    let examined = 0;
    let hits: MemoryHit[] = [];
    let pending: MemoryHit[] = [];
    let initialCoverage: any;
    let exhausted = false;
    if (token) {
      const state = decodeToken(token) as any;
      if (state?.v !== 1 || state.epoch !== epoch || state.scope !== scopeHash(scope)) throw new TypeError("Search cursor expired or scope changed; start a new query");
      cursor = state.cursor as HistoryCursor | undefined;
      pending = Array.isArray(state.pending) ? state.pending : [];
      exhausted = state.exhausted === true;
      hits.push(...pending.splice(0, limit));
    }
    while (!exhausted && hits.length < limit && examined < 500) {
      const result = await host.search({ ...(query.query === undefined ? {} : { text: query.query }), scope: query.target === "tools" ? "tools" : "messages", ...(query.filter?.roles ? { roles: query.filter.roles } : {}), limit: PAGE, ...(cursor ? { cursor } : {}) }, context);
      initialCoverage = result.coverage;
      for (const hit of result.hits) {
        examined++;
        if (query.filter?.sessions && !query.filter.sessions.includes(hit.sessionKey)) continue;
        const session = scope.sessions.find((s) => s.sessionKey === hit.sessionKey);
        if (!session) continue;
        const entry = (await host.entries(session.sessionKey, { minEntryId: hit.entryId, maxEntryId: hit.entryId, order: "ascending" }, 1, undefined, context)).items[0];
        if (!entry) continue;
        const sourceEntries = await entriesFor(session, scope, context);
        const epi = episodeStartAt(sourceEntries, hit.entryId);
        const state: "open" | "closed" = sourceEntries.some((e) => e.id > hit.entryId && e.kind === RESET) ? "closed" : "open";
        const hydrated = hydrateIndexHit(hit, entry, session, scope, epi, state);
        if (!hydrated || !applies(query, hydrated)) continue;
        hits.push(hydrated.hit);
      }
      cursor = result.next;
      if (!cursor) { exhausted = true; break; }
    }
    const pageHits = hits.slice(0, limit);
    pending.push(...hits.slice(limit));
    const complete = exhausted && pending.length === 0;
    return { hits: pageHits, ...(complete ? {} : { cursor: encodeToken({ v: 1, epoch, scope: scopeHash(scope), ...(cursor ? { cursor } : {}), exhausted, pending }) }), complete, coverage: { ...coverage(), index: initialCoverage, scannedCandidates: examined }, freshness: { index: "derived; authoritative hydration", lag: initialCoverage?.pendingEntries ?? null, truncationPossible: initialCoverage?.truncatedParts !== 0, exhaustion: complete ? "index cursor exhausted" : "continued" } };
  }
  async function searchEpisodes(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    const limit = query.limit ?? 20;
    let cursor: HistorySummaryCursor | undefined;
    let state: any;
    let pending: MemoryHit[] = [];
    let exhausted = false;
    if (query.cursor) {
      state = decodeToken(query.cursor) as any;
      if (state?.v !== 1 || state.epoch !== epoch || state.scope !== scopeHash(scope)) throw new TypeError("Search cursor expired or scope changed; start a new query");
      cursor = state.cursor;
      pending = Array.isArray(state.pending) ? state.pending : [];
      exhausted = state.exhausted === true;
    }
    const hits: MemoryHit[] = pending.splice(0, limit);
    let result: Awaited<ReturnType<MemoryHost["searchSummaries"]>> | undefined;
    while (hits.length < limit && !exhausted) {
      result = await host.searchSummaries({ ...(query.query === undefined ? {} : { text: query.query }), limit: 20, ...(cursor ? { cursor } : {}) }, context);
      for (const h of result.hits) {
      const session = scope.sessions.find((s) => s.sessionKey === h.sessionKey);
      if (!session) continue;
      const sourceEntries = await entriesFor(session, scope, context);
      const range = sourceEntries.filter((e) => e.id >= h.startEntryId && e.id <= h.endEntryId);
      const times = range.map(timestamp).filter((n): n is number => n !== undefined);
      const from = times.length ? Math.min(...times) : undefined;
      const to = times.length ? Math.max(...times) + 1 : undefined;
      const state: "open" | "closed" = sourceEntries.some((e) => e.id > h.endEntryId && e.kind === RESET) ? "closed" : "open";
      const episodeRef = ref(scope, "episode", { session: session.sessionKey, episodeStart: h.startEntryId });
      const candidate: Candidate = { hit: { ref: "", episodeRef, source: { target: "episodes", session: h.sessionKey, channel: session.channel, provenance: "unknown" }, time: { from: from === undefined ? null : new Date(from).toISOString(), to: to === undefined ? null : new Date(to).toISOString(), undated: range.length - times.length }, excerpt: h.excerpt, preview: true, coverage: { complete: h.coverageComplete, unreadable: 0, undated: range.length - times.length }, generatedAt: h.completedAtMs === null ? null : new Date(h.completedAtMs).toISOString(), title: h.title, state }, session, entry: (range[0] ?? { id: h.startEntryId, kind: "episode" }) as EntryRecord, episodeStart: h.startEntryId, state, messageIndex: 0, blockIndex: 0 };
      if (!applies(query, candidate)) continue;
      const summary = { start: h.startEntryId, end: h.endEntryId, reset: h.resetEntryId, version: h.summarizerVersion, title: h.title, generatedAt: h.completedAtMs, sourceEntries: h.sourceEntries, sourceMessages: h.sourceMessages, sourceToolResults: h.sourceToolResults, shortenedEntries: h.sourceTruncatedEntries, coverageComplete: h.coverageComplete, summaryTruncated: h.summaryTruncated };
      hits.push({ ref: ref(scope, "summary", { session: session.sessionKey, episodeStart: h.startEntryId, fingerprint: fingerprint(summary) }), episodeRef, source: { target: "episodes", session: session.sessionKey, channel: session.channel, provenance: "unknown", entryId: h.startEntryId }, time: candidate.hit.time, excerpt: h.excerpt, preview: true, coverage: { complete: h.coverageComplete && !h.summaryTruncated, unreadable: 0, undated: range.length - times.length, shortenedEntries: h.sourceTruncatedEntries, summaryTruncated: h.summaryTruncated }, generatedAt: h.completedAtMs === null ? null : new Date(h.completedAtMs).toISOString(), title: h.title, state });
      }
      cursor = result.next;
      exhausted = cursor === undefined;
    }
    pending.push(...hits.slice(limit));
    const complete = exhausted && pending.length === 0;
    return { hits: hits.slice(0, limit), ...(complete ? {} : { cursor: encodeToken({ v: 1, epoch, scope: scopeHash(scope), ...(cursor ? { cursor } : {}), exhausted, pending }) }), complete, coverage: { ...coverage(), ...(result ? { summaryIndex: result.coverage } : {}) }, freshness: { source: "summary index; authoritative summary reads required", stalePossible: true } };
  }
  async function read(query: { ref: string; view?: "summary" | "transcript"; cursor?: string; limit?: number }, parsed: MemoryRef, scope: MemoryScope, context: Context): Promise<MemoryReadPage> {
    const session = scope.sessions.find((s) => s.sessionKey === parsed.session);
    if (!session) throw new TypeError("Reference session is no longer mapped");
    if (parsed.kind === "episode" || parsed.kind === "summary") {
      const start = parsed.episodeStart!;
      if (parsed.kind === "summary" || query.view === "summary") {
        const view = await host.summary(session.sessionKey, start, context);
        if (view.state !== "ready") return { ref: query.ref, view: "summary", content: `Summary unavailable (${view.state}).`, complete: true, coverage: { complete: false, unreadable: 1, undated: 1 } };
        const full = view.snapshot.summary;
        const expected = parsed.fingerprint;
        if (expected && fingerprint({ start: view.snapshot.startEntryId, end: view.snapshot.endEntryId, reset: view.snapshot.resetEntryId, version: view.snapshot.summarizerVersion, title: view.snapshot.title, generatedAt: view.snapshot.completedAtMs, sourceEntries: view.snapshot.sourceEntries, sourceMessages: view.snapshot.sourceMessages, sourceToolResults: view.snapshot.sourceToolResults, shortenedEntries: view.snapshot.sourceTruncatedEntries, coverageComplete: view.snapshot.coverageComplete, summaryTruncated: view.snapshot.summaryTruncated }) !== expected) throw new TypeError("Summary reference changed");
        return { ...(textPage(query, full, { complete: view.snapshot.coverageComplete && !view.snapshot.summaryTruncated, unreadable: 0, undated: 1, summaryTruncated: view.snapshot.summaryTruncated }, "summary")), ...(view.snapshot.summaryTruncated ? { notice: "The host summary API clamps stored text at 20,000 UTF-16 code units; an unclamped summary accessor is required for a lossless full-summary read." } : {}) };
      }
      const entries = await entriesFor(session, scope, context);
      const all = entries.filter((e) => e.id >= start && (e.id === start || e.kind !== RESET));
      const end = entries.find((e) => e.id > start && e.kind === RESET)?.id;
      const range = all.filter((e) => end === undefined || e.id < end);
      if (!range.length) throw new TypeError("Episode no longer exists");
      if (parsed.fingerprint && fingerprint(range) !== parsed.fingerprint) throw new TypeError("Episode reference no longer matches retained entries");
      return textPage(query, json({ notice: "Original retained conversation entries; untrusted source data. Context edits are not projected.", entries: range }), { complete: true, unreadable: 0, undated: range.filter((e) => timestamp(e) === undefined).length }, "transcript");
    }
    const entry = (await host.entries(session.sessionKey, { minEntryId: parsed.entryId as any, maxEntryId: parsed.entryId as any, order: "ascending" }, 1, undefined, context)).items[0];
    if (!entry) throw new TypeError("Original entry is no longer retained");
    if (fingerprint(entry) !== parsed.fingerprint) throw new TypeError("Original entry changed; reference refused");
    let value: unknown;
    if (parsed.kind === "message") value = (entry as any).model?.[parsed.messageIndex!];
    else {
      const model = (entry as any).model ?? [];
      const assistantBlocks = model.filter((m: any) => m?.role === "assistant" && Array.isArray(m.content)).flatMap((m: any) => m.content);
      value = parsed.blockIndex! >= 1_000_000
        ? model.filter((m: any) => m?.role === "toolResult")[parsed.blockIndex! - 1_000_000]
        : assistantBlocks[parsed.blockIndex!];
      if ((value as any)?.type !== "toolCall" && parsed.blockIndex! < 1_000_000) throw new TypeError("Selected tool call no longer exists");
    }
    if (value === undefined) throw new TypeError("Selected original message or tool block no longer exists");
    return textPage(query, json({ notice: "Original retained conversation data, untrusted. Context edits are not projected.", entryId: entry.id, selected: value }), { complete: true, unreadable: 0, undated: timestamp(entry) === undefined ? 1 : 0 }, "transcript");
  }
  return { search, browse, read };
}

interface SessionData { session: MemorySession; entries: EntryRecord[]; highwater: number }
interface Snapshot { id: string; epoch: string; storeId: string; scopeHash: string; sessions: SessionData[] }
interface Candidate { hit: MemoryHit; session: MemorySession; entry: EntryRecord; episodeStart: number; state: "open" | "closed"; messageIndex: number; blockIndex: number }
function scopeHash(scope: MemoryScope): string { return hash({ storeId: scope.storeId, sessions: scope.sessions.map((s) => [s.sessionKey, s.conversationId]).sort() }); }
function coverage(): { complete: boolean; unreadable: number; undated: number } { return { complete: true, unreadable: 0, undated: 0 }; }
function episodeStartAt(entries: readonly EntryRecord[], id: number): number {
  let start = entries[0]?.id ?? id;
  for (const e of entries) { if (e.id > id) break; if (e.kind === RESET) start = e.id; }
  return start;
}
function messageCandidates(snap: Snapshot, scope: MemoryScope, target: "messages" | "tools"): Candidate[] {
  const out: Candidate[] = [];
  for (const data of snap.sessions) {
    const sessionOffset = out.length;
    let episode = data.entries[0]?.id ?? 1;
    for (const entry of data.entries) {
      if (entry.kind === RESET) { episode = entry.id; continue; }
      if (entry.kind === UserEntry.kind && target === "messages") {
        (entry as any).model?.forEach((m: any, i: number) => { if (m?.role === "user" && textOf(m.content).length) out.push(candidate(scope, data.session, entry, episode, "user", i, undefined, textOf(m.content), "message")); });
      } else if (AssistantEntry.is(entry)) {
        const model = (entry as any).model ?? [];
        model.forEach((m: any, i: number) => {
          if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
          m.content.forEach((b: any, j: number) => {
            if (b?.type === "text" && target === "messages" && typeof b.text === "string" && b.text.length) out.push(candidate(scope, data.session, entry, episode, "assistant", i, j, b.text, "message"));
            if (b?.type === "toolCall" && target === "tools") out.push(candidate(scope, data.session, entry, episode, "assistant", i, model.slice(0, i).filter((x: any) => x?.role === "assistant" && Array.isArray(x.content)).reduce((n: number, x: any) => n + x.content.length, 0) + j, json(b.arguments), "call", b.name));
          });
        });
      } else if (ToolResultEntry.is(entry) && target === "tools") {
        (entry as any).model?.forEach((m: any, i: number) => { if (m?.role === "toolResult") out.push(candidate(scope, data.session, entry, episode, "tool", i, 1_000_000 + (entry as any).model.slice(0, i).filter((x: any) => x?.role === "toolResult").length, textOf(m.content), "result", m.toolName)); });
      }
    }
    for (const item of out.slice(sessionOffset)) {
      item.state = data.entries.some((e) => e.id > item.entry.id && e.kind === RESET) ? "closed" : "open";
      item.hit = { ...item.hit, state: item.state };
    }
  }
  return out;
}
function candidate(scope: MemoryScope, session: MemorySession, entry: EntryRecord, episode: number, role: string, messageIndex: number, blockIndex: number | undefined, body: string, kind: string, toolName?: string): Candidate {
  const t = (entry as any).timestamp;
  const ms = typeof t === "number" && Number.isFinite(t) ? t : undefined;
  const base = { version: 1 as const, storeId: scope.storeId, session: session.sessionKey, entryId: entry.id, fingerprint: fingerprint(entry) };
  const isTool = kind === "call" || kind === "result";
  const refToken = encodeRef({ ...base, kind: isTool ? "tool" : "message", ...(isTool ? { blockIndex: blockIndex ?? messageIndex } : { messageIndex }) } as MemoryRef);
  return { hit: { ref: refToken, ...(isTool ? {} : { episodeRef: encodeRef({ version: 1, storeId: scope.storeId, kind: "episode", session: session.sessionKey, episodeStart: episode }) }), source: { target: isTool ? "tools" : "messages", session: session.sessionKey, channel: session.channel, provenance: "unknown", entryId: entry.id, role, ...(toolName ? { toolName } : {}), ...(isTool ? { kind } : {}) }, time: { from: ms === undefined ? null : new Date(ms).toISOString(), to: ms === undefined ? null : new Date(ms + 1).toISOString(), undated: ms === undefined ? 1 : 0 }, excerpt: body.slice(0, 280), preview: body.length > 280, coverage: { complete: true, unreadable: 0, undated: ms === undefined ? 1 : 0 } }, session, entry, episodeStart: episode, state: "open", messageIndex, blockIndex: blockIndex ?? messageIndex };
}
function episodeCandidates(snap: Snapshot, scope: MemoryScope): Candidate[] {
  const out: Candidate[] = [];
  for (const data of snap.sessions) {
    const groups: EntryRecord[][] = [];
    let group: EntryRecord[] = [];
    for (const entry of data.entries) {
      if (entry.kind === RESET && group.length) { groups.push(group); group = []; }
      group.push(entry);
    }
    if (group.length) groups.push(group);
    for (const g of groups) {
      const start = g[0]!.id;
      if (g.length === 1 && g[0]!.kind === RESET) continue;
      const timeEntries = g.map((e) => timestamp(e)).filter((n): n is number => n !== undefined);
      const hit: MemoryHit = { ref: ref(scope, "episode", { session: data.session.sessionKey, episodeStart: start, fingerprint: fingerprint(g) }), source: { target: "episodes", session: data.session.sessionKey, channel: data.session.channel, provenance: "unknown" }, time: { from: timeEntries.length ? new Date(Math.min(...timeEntries)).toISOString() : null, to: timeEntries.length ? new Date(Math.max(...timeEntries) + 1).toISOString() : null, undated: g.length - timeEntries.length }, excerpt: `Episode ${start}–${g.at(-1)!.id}`, preview: true, coverage: { complete: true, unreadable: 0, undated: g.filter((e) => timestamp(e) === undefined).length }, state: groups.indexOf(g) === groups.length - 1 ? "open" : "closed" };
      const synthetic = g.find((e) => e.kind !== RESET)!;
      out.push({ hit, session: data.session, entry: synthetic, episodeStart: start, state: hit.state!, messageIndex: 0, blockIndex: 0 });
    }
  }
  return out;
}
function applies(query: MemoryQuery, c: Candidate): boolean {
  const f = query.filter ?? {};
  if (query.target !== "episodes" && !matchesCommon(f, c.session, c.entry, c.episodeStart, c.state)) return false;
  if (query.target === "episodes") {
    if (f.sessions && !f.sessions.includes(c.session.sessionKey)) return false;
    if (f.channel && !f.channel.includes(c.session.channel ?? "")) return false;
    if (f.provenance && !f.provenance.includes("unknown")) return false;
    if (f.episodes && !f.episodes.includes(String(c.episodeStart)) && !f.episodes.includes(c.hit.episodeRef ?? "")) return false;
    if (f.state && !f.state.includes(c.state)) return false;
    if (f.time) {
      const from = c.hit.time.from === null ? undefined : Date.parse(c.hit.time.from);
      const to = c.hit.time.to === null ? undefined : Date.parse(c.hit.time.to);
      if (from === undefined && to === undefined) return false;
      if (f.time.from && (to === undefined || to <= Date.parse(f.time.from))) return false;
      if (f.time.to && (from === undefined || from >= Date.parse(f.time.to))) return false;
    }
  }
  const source = c.hit.source;
  if (f.roles && (!source.role || !f.roles.includes(source.role as any))) return false;
  if (f.toolNames && (!source.toolName || !f.toolNames.includes(source.toolName))) return false;
  if (f.kinds && (!source.kind || !f.kinds.includes(source.kind as any))) return false;
    return true;
}
function orderHits(items: Candidate[], order: "oldest" | "newest"): MemoryHit[] {
  items.sort((a, b) => (a.hit.time.from ?? "").localeCompare(b.hit.time.from ?? "") || a.session.sessionKey.localeCompare(b.session.sessionKey) || a.entry.id - b.entry.id);
  if (order === "newest") items.reverse();
  return items.map((c) => c.hit);
}
function hydrateIndexHit(hit: any, entry: EntryRecord, session: MemorySession, scope: MemoryScope, episode: number, state: "open" | "closed"): Candidate | undefined {
  const model = (entry as any).model;
  let n = 0;
  if (hit.role === "user") {
    for (let i = 0; i < (model?.length ?? 0); i++) if (model[i]?.role === "user") { if (n++ === hit.partIndex) return candidate(scope, session, entry, episode, "user", i, undefined, textOf(model[i].content), "message"); }
  } else if (hit.role === "assistant") {
    for (let i = 0; i < (model?.length ?? 0); i++) if (model[i]?.role === "assistant" && Array.isArray(model[i].content)) for (let j = 0; j < model[i].content.length; j++) { const b = model[i].content[j]; if (b?.type === "text" || b?.type === "toolCall") { if (n++ === hit.partIndex) return candidate(scope, session, entry, episode, "assistant", i, j, b.type === "text" ? b.text : json(b.arguments), b.type === "text" ? "message" : "call", b.name); } }
  } else if (hit.role === "tool") {
    for (let i = 0; i < (model?.length ?? 0); i++) if (model[i]?.role === "toolResult") { if (n++ === hit.partIndex) return candidate(scope, session, entry, episode, "tool", i, 1_000_000 + n - 1, textOf(model[i].content), "result", model[i].toolName); }
  }
  return undefined;
}
function cursorFor(snap: Snapshot, index: number): string { return encodeToken({ v: 1, epoch: snap.epoch, snapshot: snap.id, index }); }
function textPage(query: { ref: string; cursor?: string; limit?: number }, content: string, cov: any, view: "summary" | "transcript"): MemoryReadPage {
  const state = query.cursor ? decodeToken(query.cursor) as any : { offset: 0 };
  if (!isObj(state) || !Number.isSafeInteger(state.offset) || state.offset < 0 || (state.fingerprint && state.fingerprint !== fingerprint(content))) throw new TypeError("Read cursor invalid or resource changed");
  const part = sliceText(content, state.offset, Math.min(query.limit ?? MAX_READ, MAX_READ));
  const complete = part.nextOffset === undefined;
  return { ref: query.ref, view, content: part.content, ...(complete ? {} : { cursor: encodeToken({ offset: part.nextOffset, fingerprint: fingerprint(content) }) }), complete, coverage: cov };
}
