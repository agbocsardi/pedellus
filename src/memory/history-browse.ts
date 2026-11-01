import { createHmac, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { ResetEntry, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { MemoryBackend, MemoryCoverage, MemoryHit, MemoryPage, MemoryQuery, MemoryScope, MemorySession, MemoryHost } from "./contracts.js";
import { episodeFilters, matchesEpisode, matchesPart, partHit, projectEntry, queryKey, scopeKey } from "./history-source.js";
import { decodeToken, encodeRef, encodeToken, hash } from "./validation.js";

const TTL = 10 * 60_000;
const MAX_SNAPSHOTS = 32;
const MAX_BYTES = 64 * 1024 * 1024;
const SCAN_BATCH = 200;
const ENTRY_BUDGET = 600;
const TIME_BUDGET_MS = 1_500;
const SUMMARY_BATCH = 20;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;
const MAX_CAPTURE_SESSIONS = 256;
const CAPTURE_ERROR = "History snapshot could not be bounded within the capture budget; narrow the query and retry";

type PartHit = MemoryHit & { sortTime: number | null; tie: string };
type Episode = {
  session: MemorySession; start: number; end: number; hasParts: boolean; state: "open" | "closed";
  count: number; messages: number; tools: number; undated: number; min: number | null; max: number | null;
  queryMatched: boolean; summary?: { status: string; title: string | null; excerpt: string; generation: number | null; complete: boolean; summaryTruncated?: boolean; sourceTruncatedEntries?: number; sourceEntries?: number; sourceMessages?: number; sourceToolResults?: number };
};
type Scan = { session: MemorySession; highwater: number; cursor?: any; done: boolean; blocked?: boolean; current?: Episode; pendingStart?: number };
type Snapshot = {
  id: string; secret: string; key: string; scope: string; query: MemoryQuery; sessions: Scan[];
  parts: PartHit[]; episodes: Episode[]; phase: "scanning" | "summaries" | "ready";
  summaryPosition: number; unreadable: number; readFailures: number; summaryUnavailable: number; summaryUnreadable: number; summaryMalformed: number; malformed: number; undated: number; scanned: number;
  expires: number; bytes: number; result?: MemoryHit[];
};
function fail(message: string): never { throw new Error(message); }
function token(): string { return randomBytes(24).toString("base64url"); }
function bytes(value: unknown): number { try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); } catch { return MAX_BYTES; } }
function timeBounds(min: number | null, max: number | null, undated: number) {
  return { from: min === null ? null : new Date(min).toISOString(), to: max === null ? null : new Date(max + 1).toISOString(), undated };
}
function excerpt(value: string, limit = 280): string { return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`; }
function iso(value: number | null): string | null { if (value === null) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function episodeRef(scope: MemoryScope, session: string, start: number): string {
  return encodeRef({ version: 1, storeId: scope.storeId, kind: "episode", session, episodeStart: start });
}
function coverage(snapshot: Snapshot, complete: boolean, extra: Record<string, unknown> = {}): MemoryCoverage {
  return { complete, unreadable: snapshot.unreadable, summaryUnreadable: snapshot.summaryUnreadable, undated: snapshot.undated, malformed: snapshot.malformed, scannedEntries: snapshot.scanned, ...extra };
}
function episodeHit(ep: Episode, scope: MemoryScope): MemoryHit {
  return {
    ref: episodeRef(scope, ep.session.sessionKey, ep.start), episodeRef: episodeRef(scope, ep.session.sessionKey, ep.start),
    source: { target: "episodes", session: ep.session.sessionKey, channel: ep.session.channel, provenance: "unknown", entryId: ep.start },
    time: timeBounds(ep.min, ep.max, ep.undated), excerpt: ep.summary?.excerpt ?? "Episode summary unavailable; use the original episode reference.",
    preview: true, state: ep.state,
    ...(ep.summary?.title === undefined ? {} : { title: ep.summary.title }),
    ...(ep.summary?.generation === undefined ? {} : { generatedAt: iso(ep.summary.generation) }),
    coverage: { complete: ep.summary?.complete ?? false, unreadable: ep.summary?.status === "unreadable" ? 1 : 0, summaryUnavailable: ep.summary?.status === "missing" || ep.summary?.status === "not-ready" || ep.summary?.status === "open" || ep.summary?.status === "pending" || ep.summary?.status === "failed" ? 1 : 0, summaryMalformed: ep.summary?.status === "malformed" ? 1 : 0, undated: ep.undated, rangePartial: ep.undated > 0 || ep.min === null, sourceParts: ep.count, sourceMessages: ep.summary?.sourceMessages ?? ep.messages, sourceTools: ep.tools, summary: ep.summary?.status ?? "not-read", ...(ep.summary?.status === "ready" ? { sourceTruncatedEntries: ep.summary.sourceTruncatedEntries, shortenedEntries: ep.summary.sourceTruncatedEntries, summaryTruncated: ep.summary.summaryTruncated, coverageComplete: ep.summary.complete, sourceEntries: ep.summary.sourceEntries, sourceToolResults: ep.summary.sourceToolResults } : {}) },
  };
}

export function createHistoryBrowser(host: MemoryHost): { browse: MemoryBackend["browse"]; close(): void } {
  const snapshots = new Map<string, Snapshot>();
  function prune(): void { const now = Date.now(); for (const [id, s] of snapshots) if (s.expires <= now) snapshots.delete(id); }
  function next(s: Snapshot, pos: number): string { return encodeToken({ id: s.id, pos, signature: createHmac("sha256", s.secret).update(String(pos)).digest("hex") }); }
  function getCursor(value: string, key: string, authority: string): { snapshot: Snapshot; pos: number } {
    let decoded: any; try { decoded = decodeToken(value); } catch { return fail("History continuation is invalid"); }
    const s = decoded && typeof decoded.id === "string" ? snapshots.get(decoded.id) : undefined;
    if (!s || s.expires <= Date.now()) return fail("History snapshot expired; start again");
    const pos = decoded.pos;
    if (!Number.isSafeInteger(pos) || pos < 0 || decoded.signature !== createHmac("sha256", s.secret).update(String(pos)).digest("hex") || s.key !== key || s.scope !== authority) return fail("History continuation does not match this query or scope");
    return { snapshot: s, pos };
  }
  function boundSnapshot(s: Snapshot): void {
    s.bytes = bytes({ id: s.id, secret: s.secret, key: s.key, scope: s.scope, query: s.query, sessions: s.sessions, parts: s.parts, episodes: s.episodes, phase: s.phase, summaryPosition: s.summaryPosition, unreadable: s.unreadable, readFailures: s.readFailures, summaryUnavailable: s.summaryUnavailable, summaryUnreadable: s.summaryUnreadable, summaryMalformed: s.summaryMalformed, malformed: s.malformed, undated: s.undated, scanned: s.scanned, expires: s.expires, bytes: s.bytes, result: s.result });
    let total = s.bytes; for (const item of snapshots.values()) if (item !== s) total += item.bytes;
    if (s.bytes > MAX_BYTES || total > MAX_BYTES) { snapshots.delete(s.id); fail("History snapshot metadata exceeds the 64 MiB bound; narrow the query"); }
  }
  async function makeSnapshot(query: MemoryQuery, scope: MemoryScope, context: Context, key: string, authority: string, deadline: number): Promise<Snapshot> {
    if (snapshots.size >= MAX_SNAPSHOTS) fail("History snapshot capacity reached; retry later");
    const f = query.filter;
    const sessions = scope.sessions.filter((x) => (!f?.sessions || f.sessions.includes(x.sessionKey)) && (!f?.channel || (x.channel !== null && f.channel.includes(x.channel))));
    if (sessions.length > MAX_CAPTURE_SESSIONS) fail("History snapshot session limit is 256; narrow the query");
    const scans: Scan[] = []; let initialUnreadable = 0;
    // Capture every tail before any ascending scan, so all boundaries are one frozen enumeration boundary.
    for (const session of sessions) {
      if (Date.now() >= deadline) fail(CAPTURE_ERROR);
      try {
        const tail = await host.entries(session.sessionKey, { order: "descending" }, 1, undefined, context);
        if (Date.now() >= deadline) fail(CAPTURE_ERROR);
        const highwater = tail.items[0]?.id ?? 0;
        scans.push({ session: { ...session }, highwater, done: highwater === 0 });
      } catch (error) { if (error instanceof Error && error.message === CAPTURE_ERROR) throw error; initialUnreadable++; }
    }
    if (Date.now() >= deadline) fail(CAPTURE_ERROR);
    if (initialUnreadable > 0) fail(`${initialUnreadable} source${initialUnreadable === 1 ? "" : "s"} could not be bounded; retry the history query`);
    const s: Snapshot = { id: token(), secret: token(), key, scope: authority, query: structuredClone(query), sessions: scans, parts: [], episodes: [], phase: "scanning", summaryPosition: 0, unreadable: 0, readFailures: 0, summaryUnavailable: 0, summaryUnreadable: 0, summaryMalformed: 0, malformed: 0, undated: 0, scanned: 0, expires: Date.now() + TTL, bytes: 0 };
    boundSnapshot(s);
    snapshots.set(s.id, s); return s;
  }
  function finishEpisode(s: Snapshot, scan: Scan, end: number, closed: boolean): void {
    const ep = scan.current; if (!ep) return;
    ep.end = end; ep.state = closed ? "closed" : "open";
    if (ep.hasParts) s.episodes.push(ep);
    delete scan.current;
  }
  function consume(s: Snapshot, scan: Scan, entry: EntryRecord, scope: MemoryScope): void {
    s.scanned++;
    if (entry.kind === ResetEntry.kind) {
      if (scan.current) finishEpisode(s, scan, scan.current.end, true);
      scan.pendingStart = entry.id;
      return;
    }
    if (scan.current) scan.current.end = entry.id;
    else if (scan.pendingStart === undefined) scan.pendingStart = entry.id;
    const projected = projectEntry(entry);
    s.malformed += projected.malformed;
    if (!projected.parts.length) return; // system-only and other metadata do not fabricate episodes
    const start = scan.current?.start ?? scan.pendingStart ?? entry.id;
    delete scan.pendingStart;
    if (!scan.current) scan.current = { session: scan.session, start, end: entry.id, hasParts: false, state: "open", count: 0, messages: 0, tools: 0, undated: 0, min: null, max: null, queryMatched: false };
    const ep = scan.current;
    ep.end = entry.id;
    for (const part of projected.parts) {
      ep.hasParts = true; ep.count++;
      if (s.query.query === undefined || part.body.toLowerCase().includes(s.query.query.toLowerCase())) ep.queryMatched = true;
      if (part.kind === "message") ep.messages++; else ep.tools++;
      if (part.timestamp === null) { ep.undated++; s.undated++; }
      else { ep.min = ep.min === null ? part.timestamp : Math.min(ep.min, part.timestamp); ep.max = ep.max === null ? part.timestamp : Math.max(ep.max, part.timestamp); }
      if (s.query.target === "episodes") continue;
      const hit = partHit(part, entry, scan.session, ep.start, "open", scope) as PartHit;
      const q = s.query.query;
      if (q !== undefined && !part.body.toLowerCase().includes(q.toLowerCase())) continue;
      const filter = s.query.filter;
      const withoutState = filter?.state === undefined ? s.query : { ...s.query, filter: { ...filter, state: undefined } };
      if (!matchesPart(withoutState as MemoryQuery, hit, "open", scope)) continue;
      hit.sortTime = part.timestamp; hit.tie = `${scan.session.sessionKey}\0${entry.id}\0${part.index}`;
      s.parts.push(hit);
    }
  }
  async function scanSome(s: Snapshot, scope: MemoryScope, context: Context, deadline: number): Promise<void> {
    let count = 0, callbacks = 0;
    for (const scan of s.sessions) {
      if (scan.done) continue;
      while (!scan.done && count < ENTRY_BUDGET && callbacks < SCAN_BATCH && Date.now() < deadline) {
        let page;
        callbacks++;
        if (Date.now() >= deadline) break;
        // Native host I/O cannot be preempted here; enforce the shared deadline immediately after it settles.
        try { page = await host.entries(scan.session.sessionKey, { minEntryId: 1 as EntryId, maxEntryId: scan.highwater as EntryId, order: "ascending" }, SCAN_BATCH, scan.cursor, context); }
        catch (error) {
          if (Date.now() >= deadline) break;
          if (scan.cursor !== undefined && error instanceof Error && /(?:invalid|expired|stale).*cursor|cursor.*(?:invalid|expired|stale)/i.test(error.message)) {
            snapshots.delete(s.id);
            fail("History snapshot cursor was invalidated; start again");
          }
          s.readFailures++;
          if (!scan.blocked) { scan.blocked = true; s.unreadable++; }
          break;
        }
        if (Date.now() >= deadline) break;
        if (scan.blocked) { scan.blocked = false; s.unreadable--; }
        for (const entry of page.items) { consume(s, scan, entry, scope); count++; }
        scan.cursor = page.next;
        if (!page.next || page.items.length === 0) { scan.done = true; finishEpisode(s, scan, scan.highwater, false); }
      }
      if (count >= ENTRY_BUDGET || callbacks >= SCAN_BATCH || Date.now() >= deadline) break;
    }
    if (s.sessions.every((x) => x.done)) s.phase = s.query.target === "episodes" ? "summaries" : "ready";
    boundSnapshot(s);
  }
  async function prepareSummaries(s: Snapshot, context: Context, deadline: number): Promise<void> {
    let reads = 0;
    while (s.summaryPosition < s.episodes.length && reads++ < SUMMARY_BATCH && Date.now() < deadline) {
      const ep = s.episodes[s.summaryPosition++]!;
      try {
        if (Date.now() >= deadline) { s.summaryPosition--; return; }
        const view = await host.summary(ep.session.sessionKey, ep.start as EntryId, context);
        if (Date.now() >= deadline) { s.summaryPosition--; return; }
        if (view.state === "ready") ep.summary = { status: "ready", title: view.snapshot.title, excerpt: excerpt(view.snapshot.summary, 600), generation: view.snapshot.completedAtMs, complete: view.snapshot.coverageComplete, summaryTruncated: view.snapshot.summaryTruncated, sourceTruncatedEntries: view.snapshot.sourceTruncatedEntries, sourceEntries: view.snapshot.sourceEntries, sourceMessages: view.snapshot.sourceMessages, sourceToolResults: view.snapshot.sourceToolResults };
        else {
          const status = view.state === "not-ready" ? view.status : view.state;
          ep.summary = { status, title: null, excerpt: "Episode summary unavailable; use the original episode reference.", generation: null, complete: false };
          if (view.state === "unreadable") s.summaryUnreadable++;
          else if (view.state === "malformed") s.summaryMalformed++;
          else s.summaryUnavailable++;
        }
      } catch {
        if (Date.now() >= deadline) { s.summaryPosition--; return; }
        ep.summary = { status: "unreadable", title: null, excerpt: "Episode summary unavailable; use the original episode reference.", generation: null, complete: false }; s.summaryUnreadable++;
      }
    }
    if (s.summaryPosition >= s.episodes.length) s.phase = "ready";
    boundSnapshot(s);
  }
  function sortHits(hits: MemoryHit[], order: MemoryQuery["order"]): MemoryHit[] {
    const sign = order === "newest" ? -1 : 1;
    return hits.sort((a, b) => {
      const time = (hit: MemoryHit): number | null => {
        const saved = (hit as PartHit).sortTime;
        return saved !== undefined ? saved : hit.time.from === null ? null : Date.parse(hit.time.from);
      };
      const aa = time(a), bb = time(b);
      if (aa === null && bb !== null) return 1;
      if (bb === null && aa !== null) return -1;
      if (aa !== null && bb !== null && aa !== bb) return sign * (aa - bb);
      const tie = (hit: MemoryHit): string => (hit as PartHit).tie ?? `${hit.source.session ?? ""}\\0${hit.source.entryId ?? 0}\\0${hit.ref}`;
      return tie(a).localeCompare(tie(b));
    });
  }
  async function browse(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    prune();
    const deadline = Date.now() + TIME_BUDGET_MS;
    if (query.target !== "episodes" && query.target !== "messages" && query.target !== "tools") fail("History browse target is unsupported");
    for (const requested of query.filter?.sessions ?? []) if (!scope.sessions.some((session) => session.sessionKey === requested)) fail("session filter is outside the current scope");
    episodeFilters(query, scope);
    const key = queryKey(query, scope, "browse"), authority = scopeKey(scope);
    let s: Snapshot, pos = 0;
    if (query.cursor) ({ snapshot: s, pos } = getCursor(query.cursor, key, authority));
    else s = await makeSnapshot(query, scope, context, key, authority, deadline);
    s.expires = Date.now() + TTL;
    if (s.phase === "scanning") await scanSome(s, scope, context, deadline);
    if (s.phase === "summaries" && Date.now() < deadline) await prepareSummaries(s, context, deadline);
    if (s.phase !== "ready") return { hits: [], cursor: next(s, 0), complete: false, phase: "preparing", coverage: coverage(s, false, { readFailures: s.readFailures, blockedSources: s.unreadable, summaryUnavailable: s.summaryUnavailable, summaryMalformed: s.summaryMalformed, highwater: s.sessions.map((x) => ({ session: x.session.sessionKey, entryId: x.highwater })), enumerationComplete: false }), freshness: { source: "authoritative", indexUsed: false, snapshot: "frozen", sourceChanges: "not-revalidated" } };
    if (!s.result) {
      let hits: MemoryHit[];
      if (query.target === "episodes") hits = s.episodes.filter((ep) => ep.queryMatched).map((ep) => episodeHit(ep, scope)).filter((hit) => matchesEpisode(query, hit, scope));
      else {
        const states = new Map(s.episodes.map((ep) => [episodeRef(scope, ep.session.sessionKey, ep.start), ep.state]));
        hits = s.parts.filter((hit) => hit.source.target === query.target).map((item) => {
          const state = states.get(item.episodeRef!) ?? "open";
          const hit = { ...item, state } as PartHit;
          return matchesPart(query, hit, state, scope) ? hit : undefined;
        }).filter((hit): hit is PartHit => hit !== undefined) as unknown as MemoryHit[];
      }
      s.result = sortHits(hits, query.order);
      boundSnapshot(s);
    }
    if (pos > s.result.length) fail("History continuation position is invalid");
    const limit = Math.max(1, Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX));
    const selected = s.result.slice(pos, pos + limit), nextPos = pos + selected.length, complete = nextPos >= s.result.length;
    const hits = selected.map((item) => {
      if (!("sortTime" in item)) return item;
      const { sortTime: _time, tie: _tie, ...hit } = item as PartHit;
      return hit;
    });
    return { hits, ...(complete ? {} : { cursor: next(s, nextPos) }), complete, coverage: coverage(s, s.unreadable === 0 && s.malformed === 0 && s.summaryUnreadable === 0 && s.summaryMalformed === 0 && s.summaryUnavailable === 0, { readFailures: s.readFailures, blockedSources: s.unreadable, summaryUnavailable: s.summaryUnavailable, summaryUnreadable: s.summaryUnreadable, summaryMalformed: s.summaryMalformed, enumerationComplete: true, lowerBound: s.unreadable > 0 || s.malformed > 0, matchedHits: s.result.length, highwater: s.sessions.map((x) => ({ session: x.session.sessionKey, entryId: x.highwater })) }), freshness: { source: "authoritative", indexUsed: false, snapshot: "frozen", sourceChanges: "not-revalidated" } };
  }
  return { browse, close() { snapshots.clear(); } };
}
