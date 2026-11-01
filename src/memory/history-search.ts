import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { HistorySummaryHit } from "../history/index.js";
import type { MemoryBackend, MemoryHit, MemoryHost, MemoryPage, MemoryQuery, MemoryScope } from "./contracts.js";
import { entryFingerprint, matchesEpisode, matchesPart, partHit, projectEntry, queryKey } from "./history-source.js";
import { decodeRef, encodeRef, hash } from "./validation.js";

const MAX_PAGE = 20;
const TTL_MS = 10 * 60_000;
const MAX_STATES = 256;
const MAX_PASSES = 128;
const MAX_SCAN = 2_000;
type SearchState = { expires: number; binding: string; mode: "parts" | "episodes"; indexCursor?: unknown; buffer: MemoryHit[]; seen: Set<string>; coverage: Record<string, unknown>; freshness: Record<string, unknown>; complete: boolean };
function session(scope: MemoryScope, key: string) { return scope.sessions.find((item) => item.sessionKey === key); }
function clean(states: Map<string, SearchState>): void { const now = Date.now(); for (const [key, value] of states) if (value.expires <= now) states.delete(key); }
function excerpt(text: string, max = 280): string { return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function rangeHit(hit: HistorySummaryHit, scope: MemoryScope, view: NonNullable<Awaited<ReturnType<MemoryHost["summary"]>>>, times: (number | null)[], rangeComplete: boolean): MemoryHit | undefined {
  if (view.state !== "ready") return undefined;
  const snap = view.snapshot;
  if (snap.startEntryId !== hit.startEntryId || snap.endEntryId !== hit.endEntryId || snap.summarizerVersion !== hit.summarizerVersion) return undefined;
  const owner = session(scope, hit.sessionKey); if (!owner) return undefined;
  const ref = encodeRef({ version: 1, storeId: scope.storeId, kind: "summary", session: hit.sessionKey, episodeStart: hit.startEntryId, fingerprint: hash(snap) });
  const episodeRef = encodeRef({ version: 1, storeId: scope.storeId, kind: "episode", session: hit.sessionKey, episodeStart: hit.startEntryId });
  const known = times.filter((time): time is number => time !== null);
  return { ref, episodeRef, source: { target: "episodes", session: owner.sessionKey, channel: owner.channel, provenance: "unknown" }, time: { from: known.length ? new Date(Math.min(...known)).toISOString() : null, to: known.length ? new Date(Math.max(...known) + 1).toISOString() : null, undated: times.length - known.length }, excerpt: excerpt(snap.summary), preview: true, coverage: { complete: snap.coverageComplete && rangeComplete, unreadable: rangeComplete ? 0 : 1, undated: times.length - known.length, shortenedEntries: snap.sourceTruncatedEntries }, generatedAt: snap.completedAtMs === null ? null : new Date(snap.completedAtMs).toISOString(), title: snap.title, state: "closed" };
}

export function createHistorySearcher(host: MemoryHost): { search: MemoryBackend["search"]; close(): void } {
  const states = new Map<string, SearchState>();
  async function search(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage> {
    clean(states);
    const binding = queryKey(query, scope, "search");
    const target = query.target;
    const limit = Math.min(query.limit ?? MAX_PAGE, MAX_PAGE);
    let id: string | undefined;
    let state: SearchState;
    if (query.cursor) {
      id = query.cursor;
      state = states.get(id)!;
      if (!state || state.expires <= Date.now() || state.binding !== binding) throw new TypeError("search cursor is invalid or expired");
    } else {
      if (states.size >= MAX_STATES) throw new Error("search continuation capacity is full; retry a fresh search later");
      id = randomUUID();
      state = { expires: Date.now() + TTL_MS, binding, mode: target === "episodes" ? "episodes" : "parts", buffer: [], seen: new Set(), coverage: {}, freshness: {}, complete: false };
      states.set(id, state);
    }
    if (target === "episodes") {
      let passes = 0;
      while (state.buffer.length <= limit && !state.complete && passes++ < MAX_PASSES) {
        const page = await host.searchSummaries({ ...(query.query === undefined ? {} : { text: query.query }), limit: 20, ...(state.indexCursor === undefined ? {} : { cursor: state.indexCursor as never }) }, context);
        state.indexCursor = page.next;
        state.coverage = { ...(page.coverage as object), ...(state.coverage as object) };
        state.freshness = { summariesCaughtUp: page.coverage.sync.caughtUp, summaryIndex: page.coverage };
        for (const hit of page.hits) {
          const owner = session(scope, hit.sessionKey); if (!owner) continue;
          const view = await host.summary(hit.sessionKey, hit.startEntryId, context);
          const timestamps: (number | null)[] = [];
          let cursor: unknown;
          let scanned = 0;
          do {
            const entries = await host.entries(hit.sessionKey, { minEntryId: hit.startEntryId as never, maxEntryId: hit.endEntryId as never, order: "ascending" }, Math.min(200, MAX_SCAN - scanned), cursor as never, context);
            for (const entry of entries.items) {
              scanned++;
              for (const part of projectEntry(entry).parts) timestamps.push(part.timestamp);
            }
            cursor = entries.next;
          } while (cursor !== undefined && scanned < MAX_SCAN);
          const item = rangeHit(hit, scope, view, timestamps, cursor === undefined);
          if (item && matchesEpisode(query, item, scope)) state.buffer.push(item);
        }
        state.complete = page.next === undefined;
      }
      if (!state.complete && passes >= MAX_PASSES) state.freshness = { ...state.freshness, searchPassLimit: true };
    } else {
      let passes = 0;
      while (state.buffer.length <= limit && !state.complete && passes++ < MAX_PASSES) {
        const page = await host.search({ ...(query.query === undefined ? {} : { text: query.query }), scope: target === "tools" ? "tools" : "all", limit: 20, ...(state.indexCursor === undefined ? {} : { cursor: state.indexCursor as never }) }, context);
        state.indexCursor = page.next;
        state.coverage = { ...(page.coverage as object) };
        state.freshness = { index: page.coverage };
        for (const hit of page.hits) {
          const key = `${hit.sessionKey}:${hit.entryId}:${hit.partIndex}`;
          if (state.seen.has(key)) continue;
          state.seen.add(key);
          if (state.seen.size > MAX_SCAN) throw new Error("history search deduplication bound reached; narrow the query or filters");
          const owner = session(scope, hit.sessionKey); if (!owner) continue;
          const recordPage = await host.entries(hit.sessionKey, { minEntryId: hit.entryId, maxEntryId: hit.entryId }, 1, undefined, context);
          const entry = recordPage.items[0]; if (!entry || entryFingerprint(entry) === "") continue;
          const projected = projectEntry(entry);
          const part = projected.parts.find((candidate) => candidate.index === hit.partIndex);
          if (!part || (target === "messages" && part.kind !== "message") || (target === "tools" && part.kind !== "tool")) continue;
          if (hit.role === "tool" && entry.kind !== AssistantEntry.kind) continue;
          const knownState = query.filter?.state === undefined ? "closed" : undefined;
          if (knownState === undefined) continue;
          const item = partHit(part, entry, owner, hit.episodeStartEntryId, knownState, scope);
          if (!matchesPart(query, item, knownState, scope)) continue;
          const { state: _unknownState, ...withoutState } = item;
          state.buffer.push({ ...withoutState, excerpt: hit.excerpt, preview: true, coverage: { ...item.coverage, complete: page.coverage.complete && !hit.bodyTruncated, unreadable: 0, undated: item.time.undated, indexTruncated: hit.bodyTruncated } });
        }
        state.complete = state.complete || page.next === undefined;
      }
      if (!state.complete && passes >= MAX_PASSES) state.freshness = { ...state.freshness, searchPassLimit: true };
    }
    const hits = state.buffer.splice(0, limit);
    const hasMore = state.buffer.length > 0 || !state.complete;
    if (!hasMore) states.delete(id);
    else state.expires = Date.now() + TTL_MS;
    const coverage = { ...state.coverage, unreadable: Number(state.coverage.unreadable ?? 0), undated: Number(state.coverage.undated ?? 0), complete: Boolean(state.coverage.complete) && state.complete && !state.freshness.searchPassLimit };
    return { hits, ...(hasMore ? { cursor: id } : {}), complete: !hasMore, coverage, freshness: state.freshness };
  }
  return { search, close() { states.clear(); } };
}
