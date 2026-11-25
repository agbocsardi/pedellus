import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { ResetEntry, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { HistoryHit, HistorySummaryHit } from "../history/index.js";
import type { MemoryBackend, MemoryHit, MemoryHost, MemoryPage, MemoryQuery, MemoryScope } from "./contracts.js";
import { episodeFilters, matchesEpisode, matchesPart, partHit, projectEntry, queryKey } from "./history-source.js";
import { encodeRef, hash } from "./validation.js";

const MAX_PAGE = 20;
const TTL_MS = 10 * 60_000;
const MAX_SOURCE_PER_CALL = 600;
const MAX_READS_PER_CALL = 200;
const MAX_MILLIS_PER_CALL = 1_500;
const MAX_SEEN = 250_000;
const MAX_CHAINS = 256;
const MAX_CACHED_PAGES = 64;
const MAX_CACHED_REPLIES = 2_048;
/** Widest entry-ID range one batched hit lookup reads; also its page limit (host maximum 200). */
const MAX_LOOKUP_SPAN = 64;
/** Widest gap of intervening non-hit IDs between two adjacent hits in one batched lookup window. */
const MAX_LOOKUP_GAP = 8;
/** Maximum intervening non-hit IDs per covered hit in one batched window (bounds waste <= 2x hits). */
const MAX_LOOKUP_WASTE_PER_HIT = 2;
type Coverage = Record<string, unknown>;
type EpisodeJob = { readonly hit: HistorySummaryHit; readonly sessionKey: string; cursor?: unknown; minTime: number | null; maxTime: number | null; undated: number; malformed: number; omitted: number; unreadable: number; missing: number; sourceEntries: number };
type CachedPage = { readonly page: MemoryPage; readonly nextToken?: string };
type CachedView = { readonly page: MemoryPage; readonly sourceToken: string; readonly offset: number };
type SearchState = {
  readonly id: string; readonly binding: string; readonly mode: "parts" | "episodes"; expires: number;
  indexCursor?: unknown; summaryIndexDone: boolean; indexInitialized: boolean; pendingHits: HistoryHit[]; pendingDone: boolean; complete: boolean; buffer: MemoryHit[]; seen: Set<string>;
  coverage: Coverage; freshness: Coverage; jobs: EpisodeJob[]; activeJob?: EpisodeJob;
  pages: Map<string, CachedPage>; views: Map<string, CachedView>; responses: Map<string, MemoryPage>; currentToken: string;
  resetIds: Map<string, number | null>; resetCursors: Map<string, unknown>; resetDone: Set<string>;
  diagnostics: { malformed: number; unreadable: number; undated: number; omittedNonText: number; summaryMissing: number; unknownProvenance: number };
  diagnosedEntries: Set<string>;
};
function session(scope: MemoryScope, key: string) { return scope.sessions.find((item) => item.sessionKey === key); }
function clean(states: Map<string, SearchState>, byToken: Map<string, SearchState>): void { const now = Date.now(); for (const [key, value] of states) if (value.expires <= now) { states.delete(key); for (const [token, owner] of byToken) if (owner === value) byToken.delete(token); } }
function excerpt(text: string, max = 280): string { return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function summaryHit(hit: HistorySummaryHit, scope: MemoryScope, view: Awaited<ReturnType<MemoryHost["summary"]>>, job: EpisodeJob): MemoryHit | undefined {
  if (view.state !== "ready") return undefined;
  const snap = view.snapshot;
  if (snap.startEntryId !== hit.startEntryId || snap.endEntryId !== hit.endEntryId || snap.summarizerVersion !== hit.summarizerVersion) return undefined;
  const owner = session(scope, hit.sessionKey); if (!owner) return undefined;
  const ref = encodeRef({ version: 1, storeId: scope.storeId, kind: "summary", session: hit.sessionKey, episodeStart: hit.startEntryId, fingerprint: hash(snap) });
  const episodeRef = encodeRef({ version: 1, storeId: scope.storeId, kind: "episode", session: hit.sessionKey, episodeStart: hit.startEntryId });
  const known = job.minTime === null ? [] : [job.minTime, job.maxTime!];
  const undated = job.undated;
  const provenance = "unknown" as const;
  return { ref, episodeRef, source: { target: "episodes", session: owner.sessionKey, channel: owner.channel, provenance }, time: { from: known.length ? new Date(known[0]!).toISOString() : null, to: known.length ? new Date(known[1]! + 1).toISOString() : null, undated }, excerpt: excerpt(snap.summary), preview: true, coverage: { complete: snap.coverageComplete && job.unreadable === 0 && job.sourceEntries === hit.sourceEntries, unreadable: job.unreadable, undated, malformed: job.malformed, missing: job.missing, omittedNonText: job.omitted, truncatedEntries: snap.sourceTruncatedEntries, originalEntriesCovered: job.sourceEntries, sourceRangeComplete: job.sourceEntries === hit.sourceEntries, provenance: "unknown" }, generatedAt: snap.completedAtMs === null ? null : new Date(snap.completedAtMs).toISOString(), title: snap.title, state: "closed" };
}
/**
 * The entry-ID window, at most `maxSpan` wide, that contains `target` and the most other `wanted`
 * IDs without spanning sparse gaps or excessive intervening non-hit IDs; a tie keeps the narrower
 * window. `wanted` must be sorted ascending and unique. One bounded host read replaces one per hit.
 */
function lookupWindow(target: number, wanted: readonly number[], maxSpan: number): { min: number; max: number } {
  let best = { min: target, max: target, count: 1 };
  const targetIndex = wanted.indexOf(target);
  if (targetIndex < 0 || maxSpan <= 1) return best;
  for (let left = targetIndex; left >= 0; left--) {
    if (left < targetIndex && wanted[left + 1]! - wanted[left]! - 1 > MAX_LOOKUP_GAP) break;
    const min = wanted[left]!;
    if (target - min + 1 > maxSpan) break;
    for (let right = targetIndex; right < wanted.length; right++) {
      if (right > targetIndex && wanted[right]! - wanted[right - 1]! - 1 > MAX_LOOKUP_GAP) break;
      const max = wanted[right]!;
      const span = max - min + 1;
      if (span > maxSpan) break;
      const count = right - left + 1;
      if (span - count > count * MAX_LOOKUP_WASTE_PER_HIT) continue;
      if (count > best.count || (count === best.count && max - min < best.max - best.min)) {
        best = { min, max, count };
      }
    }
  }
  return best;
}
function validateFilters(query: MemoryQuery, scope: MemoryScope): void {
  episodeFilters(query, scope);
  for (const requested of query.filter?.sessions ?? []) if (!scope.sessions.some((item) => item.sessionKey === requested)) throw new TypeError("session filter is outside the current scope");
}
function searchQuery(query: MemoryQuery, mode: "parts" | "episodes", cursor?: unknown) {
  const text = query.query;
  return mode === "episodes"
    ? { ...(text === undefined ? {} : { text }), limit: 20, ...(cursor === undefined ? {} : { cursor: cursor as never }) }
    : { ...(text === undefined ? {} : { text }), scope: query.target === "tools" ? "tools" as const : "messages" as const, limit: 20, ...(cursor === undefined ? {} : { cursor: cursor as never }) };
}

export function createHistorySearcher(host: MemoryHost): { search: MemoryBackend["search"]; close(): void } {
  const states = new Map<string, SearchState>();
  const byToken = new Map<string, SearchState>();
  async function search(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    clean(states, byToken); validateFilters(query, scope);
    const episodes = episodeFilters(query, scope);
    const filter = query.filter;
    const limit = Math.min(query.limit ?? MAX_PAGE, MAX_PAGE);
    const binding = queryKey(query, scope, "search");
    let state: SearchState;
    if (query.cursor !== undefined) {
      state = byToken.get(query.cursor)!;
      if (!state || state.expires <= Date.now() || state.binding !== binding) throw new TypeError("search cursor is invalid or expired");
      const cached = state.pages.get(query.cursor);
      const view = state.views.get(query.cursor);
      if (cached || view) {
        const prior = state.responses.get(`${query.cursor}:${limit}`);
        if (prior) return prior;
        if (state.responses.size >= MAX_CACHED_REPLIES) throw new Error("history search retry-cache capacity reached; restart with a narrower query");
        const source = cached?.page ?? state.pages.get(view!.sourceToken)?.page;
        if (!source) throw new TypeError("search cursor has expired");
        const offset = view?.offset ?? 0;
        const hits = source.hits.slice(offset, offset + limit);
        const nextOffset = offset + hits.length;
        const stillInPage = nextOffset < source.hits.length;
        const cursor = stillInPage ? randomUUID() : source.cursor;
        const page: MemoryPage = { ...source, hits, ...(cursor ? { cursor } : {}), complete: cursor === undefined, ...(source.phase && cursor ? { phase: source.phase } : {}) };
        if (stillInPage && cursor) { state.views.set(cursor, { page: source, sourceToken: view?.sourceToken ?? query.cursor, offset: nextOffset }); byToken.set(cursor, state); }
        state.responses.set(`${query.cursor}:${limit}`, page);
        return page;
      }
      if (query.cursor !== state.currentToken) throw new TypeError("search cursor has expired");
      if (state.pages.size >= MAX_CACHED_PAGES) throw new Error("history search cached-page capacity reached; restart with a narrower query");
    } else {
      if (states.size >= MAX_CHAINS) throw new Error("history search continuation capacity is full; retry later");
      const id = randomUUID();
      state = { id, binding, mode: query.target === "episodes" ? "episodes" : "parts", expires: Date.now() + TTL_MS, summaryIndexDone: false, indexInitialized: false, pendingHits: [], pendingDone: false, complete: false, buffer: [], seen: new Set(), coverage: {}, freshness: {}, jobs: [], pages: new Map(), views: new Map(), responses: new Map(), currentToken: randomUUID(), resetIds: new Map(), resetCursors: new Map(), resetDone: new Set(), diagnostics: { malformed: 0, unreadable: 0, undated: 0, omittedNonText: 0, summaryMissing: 0, unknownProvenance: 0 }, diagnosedEntries: new Set() };
      states.set(id, state); byToken.set(state.currentToken, state);
    }
    const started = Date.now(); let reads = 0; let sourceEntries = 0;
    if (state.mode === "parts" && !state.indexInitialized) {
      const first = await host.search(searchQuery(query, "parts"), context); reads++;
      state.pendingHits = [...first.hits]; state.pendingDone = first.next === undefined; state.indexCursor = first.next; state.coverage = { ...first.coverage }; state.freshness = { index: first.coverage }; state.indexInitialized = true;
    }
    const stateFilter = query.filter?.state;
    const needsState = stateFilter !== undefined && stateFilter.length === 1;
    if (stateFilter !== undefined && stateFilter.length === 0) state.complete = true;
    if (state.mode === "parts" && needsState) {
      const requested = query.filter?.sessions ?? scope.sessions.map((item) => item.sessionKey);
      for (const sessionKey of requested) {
        if (state.resetDone.has(sessionKey) || sourceEntries >= MAX_SOURCE_PER_CALL) continue;
        const cursor = state.resetCursors.get(sessionKey);
        const boundary = Number(state.coverage.boundaryEntryId);
        let page: Awaited<ReturnType<MemoryHost["entries"]>>;
        try { page = await host.entries(sessionKey, { order: "descending", ...(Number.isSafeInteger(boundary) && boundary > 0 ? { maxEntryId: boundary as never } : {}) }, Math.min(200, MAX_SOURCE_PER_CALL - sourceEntries), cursor as never, context); }
        catch { state.diagnostics.unreadable++; throw new Error("history episode-state scan failed; retry the search"); }
        reads++; sourceEntries += page.items.length;
        const reset = page.items.find((entry) => entry.kind === ResetEntry.kind);
        if (reset) { state.resetIds.set(sessionKey, Number(reset.id)); state.resetDone.add(sessionKey); }
        else if (page.next === undefined) { state.resetIds.set(sessionKey, null); state.resetDone.add(sessionKey); }
        else state.resetCursors.set(sessionKey, page.next);
        if (!state.resetDone.has(sessionKey) || reads >= MAX_READS_PER_CALL || Date.now() - started >= MAX_MILLIS_PER_CALL) break;
      }
    }
    const resetPrepared = state.mode !== "parts" || !needsState || (query.filter?.sessions ?? scope.sessions.map((item) => item.sessionKey)).every((key) => state.resetDone.has(key));
    while (resetPrepared && state.buffer.length < limit + 1 && !state.complete && reads < MAX_READS_PER_CALL && sourceEntries < MAX_SOURCE_PER_CALL && Date.now() - started < MAX_MILLIS_PER_CALL) {
      if (state.mode === "episodes") {
        if (state.activeJob === undefined) {
          if (state.jobs.length === 0) {
            if (state.summaryIndexDone) { state.complete = true; break; }
            const page = await host.searchSummaries(searchQuery(query, "episodes", state.indexCursor), context); reads++;
            state.indexCursor = page.next; state.coverage = { ...page.coverage }; state.freshness = { summariesCaughtUp: page.coverage.sync.caughtUp, summaryIndex: page.coverage };
            for (const hit of page.hits) { if (session(scope, hit.sessionKey)) state.jobs.push({ hit, sessionKey: hit.sessionKey, minTime: null, maxTime: null, undated: 0, malformed: 0, omitted: 0, unreadable: 0, missing: 0, sourceEntries: 0 }); }
            if (page.next === undefined) state.summaryIndexDone = true;
            if (state.summaryIndexDone && state.jobs.length === 0) state.complete = true;
            continue;
          }
          state.activeJob = state.jobs.shift()!;
        }
        const job = state.activeJob;
        let page: Awaited<ReturnType<MemoryHost["entries"]>>;
        try { page = await host.entries(job.sessionKey, { minEntryId: job.hit.startEntryId as never, maxEntryId: job.hit.endEntryId as never, order: "ascending" }, Math.min(200, MAX_SOURCE_PER_CALL - sourceEntries), job.cursor as never, context); }
        catch { job.unreadable++; delete state.activeJob; state.diagnostics.unreadable++; state.diagnostics.malformed += job.malformed; state.diagnostics.undated += job.undated; state.diagnostics.omittedNonText += job.omitted; continue; }
        reads++; sourceEntries += page.items.length;
        for (const entry of page.items) { job.sourceEntries++; state.diagnostics.unknownProvenance++; const projected = projectEntry(entry); job.malformed += projected.malformed; job.omitted += projected.omittedNonText; for (const part of projected.parts) if (part.timestamp === null) job.undated++; else { job.minTime = job.minTime === null ? part.timestamp : Math.min(job.minTime, part.timestamp); job.maxTime = job.maxTime === null ? part.timestamp : Math.max(job.maxTime, part.timestamp); } }
        job.cursor = page.next;
        if (page.next === undefined) {
          try { const view = await host.summary(job.sessionKey, job.hit.startEntryId, context); reads++; if (view.state === "malformed") job.malformed++; else if (view.state === "unreadable") job.unreadable++; else if (view.state === "missing") job.missing++; const item = summaryHit(job.hit, scope, view, job); if (item && matchesEpisode(query, item, scope)) state.buffer.push(item); }
          catch { job.unreadable++; }
          state.diagnostics.malformed += job.malformed; state.diagnostics.unreadable += job.unreadable; state.diagnostics.undated += job.undated; state.diagnostics.omittedNonText += job.omitted; state.diagnostics.summaryMissing += job.missing;
          delete state.activeJob;
        }
        if (state.summaryIndexDone && state.jobs.length === 0 && state.activeJob === undefined) state.complete = true;
        continue;
      }
      const fromPending = state.pendingHits.length > 0 || state.pendingDone;
      const page = fromPending
        ? { hits: state.pendingHits, coverage: state.coverage, next: state.pendingDone ? undefined : state.indexCursor }
        : await host.search(searchQuery(query, "parts", state.indexCursor), context);
      if (!fromPending) reads++;
      state.pendingHits = []; state.pendingDone = false;
      state.indexCursor = page.next; state.coverage = { ...page.coverage }; state.freshness = { index: page.coverage };
      const eligibleHit = (hit: HistoryHit): boolean => {
        const owner = session(scope, hit.sessionKey);
        if (!owner) return false;
        if (filter?.sessions !== undefined && !filter.sessions.includes(owner.sessionKey)) return false;
        if (filter?.channel !== undefined && (owner.channel === null || !filter.channel.includes(owner.channel))) return false;
        if (filter?.provenance !== undefined && !filter.provenance.includes("unknown")) return false;
        if (episodes !== undefined && !episodes.some((ep) => ep.session === owner.sessionKey && ep.start === Number(hit.episodeStartEntryId))) return false;
        if (needsState) {
          const episodeStart = Number(hit.episodeStartEntryId);
          const currentReset = state.resetIds.get(hit.sessionKey) ?? null;
          const status: "open" | "closed" = currentReset === null || episodeStart >= currentReset ? "open" : "closed";
          if (!stateFilter.includes(status)) return false;
        }
        if (query.target === "messages") {
          if (hit.role === "tool") return false;
          if (filter?.roles !== undefined && !filter.roles.includes(hit.role as "user" | "assistant")) return false;
          if (filter?.toolNames !== undefined || filter?.kinds !== undefined) return false;
        } else if (query.target === "tools") {
          if (filter?.roles !== undefined && !(filter.roles as readonly string[]).includes("tool")) return false;
          if (filter?.toolNames !== undefined && hit.toolName !== undefined && !filter.toolNames.includes(hit.toolName)) return false;
        }
        return true;
      };
      // Entries this page already read, by `session:entryId`: null when the host had no such entry,
      // "failed" when its exact-ID read failed. Each hit keeps its own unreadable accounting.
      const looked = new Map<string, EntryRecord | null | "failed">();
      // Entries whose batched range read failed; read them individually so one bad row cannot drop
      // otherwise readable hits in the same window.
      const directIds = new Set<string>();
      const readExact = async (hit: HistoryHit, key: string): Promise<EntryRecord | null | "failed"> => {
        let exactPage: Awaited<ReturnType<MemoryHost["entries"]>> | undefined;
        try { exactPage = await host.entries(hit.sessionKey, { minEntryId: hit.entryId, maxEntryId: hit.entryId, order: "ascending" }, 1, undefined, context); }
        catch { exactPage = undefined; }
        reads++;
        if (exactPage === undefined) { looked.set(key, "failed"); return "failed"; }
        sourceEntries += exactPage.items.length;
        const found = exactPage.items.find((entry) => Number(entry.id) === Number(hit.entryId)) ?? null;
        looked.set(key, found);
        return found;
      };
      const lookup = async (hitIndex: number, hit: HistoryHit): Promise<EntryRecord | null | "failed"> => {
        const key = `${hit.sessionKey}:${hit.entryId}`;
        const known = looked.get(key);
        if (known !== undefined) return known;
        if (directIds.has(key)) return readExact(hit, key);
        const targetId = Number(hit.entryId);
        const wantedSet = new Set<number>([targetId]);
        for (let i = hitIndex + 1; i < page.hits.length; i++) {
          const candidate = page.hits[i]!;
          if (candidate.sessionKey !== hit.sessionKey) continue;
          const candidateEntryKey = `${candidate.sessionKey}:${candidate.entryId}`;
          if (looked.has(candidateEntryKey) || directIds.has(candidateEntryKey)) continue;
          if (state.seen.has(`${candidateEntryKey}:${candidate.partIndex}`)) continue;
          if (!eligibleHit(candidate)) continue;
          wantedSet.add(Number(candidate.entryId));
        }
        const wanted = [...wantedSet].sort((a, b) => a - b);
        const window = lookupWindow(targetId, wanted, Math.min(MAX_LOOKUP_SPAN, Math.max(1, MAX_SOURCE_PER_CALL - sourceEntries)));
        if (window.min === window.max) return readExact(hit, key);
        const covered = wanted.filter((id) => id >= window.min && id <= window.max);
        const coveredSet = new Set(covered);
        let recordPage: Awaited<ReturnType<MemoryHost["entries"]>> | undefined;
        try { recordPage = await host.entries(hit.sessionKey, { minEntryId: window.min as EntryId, maxEntryId: window.max as EntryId, order: "ascending" }, window.max - window.min + 1, undefined, context); }
        catch { recordPage = undefined; }
        reads++;
        if (recordPage === undefined) {
          for (const id of covered) directIds.add(`${hit.sessionKey}:${id}`);
          return readExact(hit, key);
        }
        sourceEntries += recordPage.items.length;
        if (recordPage.next === undefined) {
          for (const id of covered) looked.set(`${hit.sessionKey}:${id}`, null);
          for (const entry of recordPage.items) if (coveredSet.has(Number(entry.id))) looked.set(`${hit.sessionKey}:${entry.id}`, entry);
          return looked.get(key) ?? null;
        }
        for (const entry of recordPage.items) if (coveredSet.has(Number(entry.id))) looked.set(`${hit.sessionKey}:${entry.id}`, entry);
        const found = looked.get(key);
        if (found !== undefined) return found;
        directIds.add(key);
        return readExact(hit, key);
      };
      for (let hitIndex = 0; hitIndex < page.hits.length; hitIndex++) {
        const hit = page.hits[hitIndex]!;
        if (!eligibleHit(hit)) continue;
        const key = `${hit.sessionKey}:${hit.entryId}:${hit.partIndex}`;
        if (state.seen.has(key)) continue;
        const entryKey = `${hit.sessionKey}:${hit.entryId}`;
        if (!looked.has(entryKey) && (sourceEntries >= MAX_SOURCE_PER_CALL || reads >= MAX_READS_PER_CALL || Date.now() - started >= MAX_MILLIS_PER_CALL)) {
          state.pendingHits = [...page.hits.slice(hitIndex)];
          state.pendingDone = page.next === undefined;
          break;
        }
        state.seen.add(key); if (state.seen.size > MAX_SEEN) throw new Error("history search deduplication bound reached; narrow the query or filters");
        const owner = session(scope, hit.sessionKey)!;
        const entry = await lookup(hitIndex, hit);
        if (entry === "failed" || entry === null) { state.diagnostics.unreadable++; continue; }
        const projected = projectEntry(entry);
        const diagnosticKey = `${hit.sessionKey}:${hit.entryId}`;
        if (!state.diagnosedEntries.has(diagnosticKey)) { state.diagnosedEntries.add(diagnosticKey); state.diagnostics.unknownProvenance++; state.diagnostics.malformed += projected.malformed; state.diagnostics.omittedNonText += projected.omittedNonText; state.diagnostics.undated += projected.parts.filter((candidate) => candidate.timestamp === null).length; }
        const part = projected.parts.find((candidate) => candidate.index === hit.partIndex);
        if (!part || (query.target === "messages" && part.kind !== "message") || (query.target === "tools" && part.kind !== "tool")) continue;
        if (hit.role === "tool" && part.kind !== "tool") continue;
        const episodeStart = Number(hit.episodeStartEntryId);
        const currentReset = state.resetIds.get(hit.sessionKey) ?? null;
        const status: "open" | "closed" = currentReset === null || episodeStart >= currentReset ? "open" : "closed";
        const item = partHit(part, entry, owner, episodeStart, status, scope);
        const { state: _stateFilter, ...filterWithoutState } = query.filter ?? {};
        const filterlessQuery: MemoryQuery = !needsState && query.filter?.state !== undefined ? { ...query, filter: filterWithoutState } : query;
        if (!matchesPart(filterlessQuery, item, status, scope)) continue;
        const { state: _unknownState, ...itemWithoutState } = item;
        const hitState = { ...itemWithoutState, ...(needsState ? { state: status } : {}), excerpt: hit.excerpt, preview: true, coverage: { ...item.coverage, complete: Boolean(page.coverage.complete) && !hit.bodyTruncated, unreadable: 0, malformed: projected.malformed, omittedNonText: projected.omittedNonText, undated: item.time.undated, indexTruncated: hit.bodyTruncated } };
        state.buffer.push(hitState);
      }
      if (page.next === undefined && state.pendingHits.length === 0) state.complete = true;
    }
    const pendingWork = state.mode === "episodes" && (state.activeJob !== undefined || state.jobs.length > 0 || state.indexCursor !== undefined);
    const exhausted = state.complete && !pendingWork;
    const hits = state.buffer.splice(0, limit);
    const hasMore = state.buffer.length > 0 || !exhausted;
    const summarySync = state.coverage.sync;
    const coverage = { ...state.coverage, malformed: state.diagnostics.malformed, unreadable: Number(state.coverage.unreadable ?? 0) + state.diagnostics.unreadable, undated: Number(state.coverage.undated ?? 0) + state.diagnostics.undated, omittedNonText: state.diagnostics.omittedNonText, summarySourceMissing: state.diagnostics.summaryMissing, unknownProvenance: state.diagnostics.unknownProvenance, ...(summarySync && typeof summarySync === "object" ? { summaryMalformed: (summarySync as Record<string, unknown>).summariesMalformed, summaryUnreadable: (summarySync as Record<string, unknown>).summariesUnreadable, summaryMissing: (summarySync as Record<string, unknown>).summariesMissing, summaryTruncated: (summarySync as Record<string, unknown>).summariesTruncated, summaryOmitted: (summarySync as Record<string, unknown>).summariesOmitted, summaryLag: (summarySync as Record<string, unknown>).sessionsPending } : {}), complete: Boolean(state.coverage.complete) && exhausted };
    const page: MemoryPage = { hits, ...(hasMore ? { cursor: randomUUID() } : {}), complete: !hasMore, coverage, freshness: state.freshness, ...(!exhausted ? { phase: "preparing" as const } : {}) };
    const priorToken = query.cursor ?? state.currentToken;
    const nextToken = page.cursor;
    state.pages.set(priorToken, { page, ...(nextToken ? { nextToken } : {}) });
    if (nextToken) { state.currentToken = nextToken; byToken.set(nextToken, state); }
    state.expires = Date.now() + TTL_MS;
    return page;
  }
  return { search, close() { states.clear(); byToken.clear(); } };
}
