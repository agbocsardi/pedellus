import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { ResetEntry } from "@earendil-works/pi-durable";
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
      const page = state.pendingHits.length > 0 || state.pendingDone
        ? { hits: state.pendingHits, coverage: state.coverage, next: state.pendingDone ? undefined : state.indexCursor }
        : await host.search(searchQuery(query, "parts", state.indexCursor), context);
      if (page !== undefined && state.pendingHits.length === 0 && !state.pendingDone) reads++;
      state.pendingHits = []; state.pendingDone = false;
      state.indexCursor = page.next; state.coverage = { ...page.coverage }; state.freshness = { index: page.coverage };
      for (let hitIndex = 0; hitIndex < page.hits.length; hitIndex++) {
        if (sourceEntries >= MAX_SOURCE_PER_CALL) { state.pendingHits = [...page.hits.slice(hitIndex)]; state.pendingDone = page.next === undefined; break; }
        const hit = page.hits[hitIndex]!;
        const key = `${hit.sessionKey}:${hit.entryId}:${hit.partIndex}`;
        if (state.seen.has(key)) continue;
        state.seen.add(key); if (state.seen.size > MAX_SEEN) throw new Error("history search deduplication bound reached; narrow the query or filters");
        const owner = session(scope, hit.sessionKey); if (!owner) continue;
        let recordPage: Awaited<ReturnType<MemoryHost["entries"]>>;
        try { recordPage = await host.entries(hit.sessionKey, { minEntryId: hit.entryId, maxEntryId: hit.entryId }, 1, undefined, context); }
        catch { state.diagnostics.unreadable++; continue; }
        reads++; sourceEntries += recordPage.items.length;
        const entry = recordPage.items[0]; if (!entry) { state.diagnostics.unreadable++; continue; }
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
