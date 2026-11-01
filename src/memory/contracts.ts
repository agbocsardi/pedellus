import type { Context } from "@earendil-works/chord";
import type { ConversationId, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { HistoryPage, HistoryQuery, HistorySummaryPage, HistorySummaryQuery } from "../history/index.js";
import type { HistorySummaryView } from "../history/summary-view.js";

export const MEMORY_TOOL_NAMES = ["memory_search", "memory_browse", "memory_read"] as const;
export type MemoryTarget = "notes" | "episodes" | "messages" | "tools";
export type MemoryProvenance = "native" | "imported" | "unknown";
export interface MemoryTimeFilter { readonly from?: string; readonly to?: string }
/** Fields combine with AND; values within a nonempty list combine with OR. */
export interface MemoryFilter {
  readonly sessions?: readonly string[];
  readonly channel?: readonly string[];
  readonly provenance?: readonly MemoryProvenance[];
  readonly time?: MemoryTimeFilter;
  readonly episodes?: readonly string[];
  readonly state?: readonly ("open" | "closed")[];
  readonly roles?: readonly ("user" | "assistant")[];
  readonly toolNames?: readonly string[];
  readonly kinds?: readonly ("call" | "result")[];
  readonly pathPrefix?: string;
  readonly description?: readonly string[];
}
export interface MemoryQuery {
  readonly target: MemoryTarget;
  readonly query?: string;
  readonly filter?: MemoryFilter;
  readonly order?: "oldest" | "newest";
  readonly limit?: number;
  readonly cursor?: string;
}
export interface MemoryReadQuery {
  readonly ref: string;
  readonly view?: "summary" | "transcript";
  readonly cursor?: string;
  readonly limit?: number;
}
/** Opaque encoded identifiers, never capabilities. Selectors are backend-validated. */
export interface MemoryRef {
  readonly version: 1;
  readonly storeId: string;
  readonly kind: "note" | "episode" | "summary" | "message" | "tool";
  readonly session?: string;
  readonly episodeStart?: number;
  readonly entryId?: number;
  readonly messageIndex?: number;
  readonly blockIndex?: number;
  readonly path?: string;
  readonly fingerprint?: string;
}
export interface MemoryTime {
  readonly from: string | null;
  readonly to: string | null;
  readonly undated: number;
}
export interface MemoryCoverage {
  readonly complete: boolean;
  readonly unreadable: number;
  readonly undated: number;
  readonly [key: string]: unknown;
}
export interface MemoryHit {
  readonly ref: string;
  readonly episodeRef?: string;
  readonly source: { readonly target: MemoryTarget; readonly session?: string; readonly channel?: string | null; readonly provenance?: MemoryProvenance; readonly path?: string; readonly entryId?: number; readonly role?: string; readonly toolName?: string; readonly kind?: string };
  readonly time: MemoryTime;
  readonly excerpt: string;
  readonly preview: boolean;
  readonly coverage: MemoryCoverage;
  readonly generatedAt?: string | null;
  readonly title?: string | null;
  readonly state?: "open" | "closed";
}
export interface MemoryPage {
  readonly hits: readonly MemoryHit[];
  readonly cursor?: string;
  /** Exhaustion of the frozen enumeration/query, not index freshness. */
  readonly complete: boolean;
  readonly coverage: MemoryCoverage;
  readonly freshness: Readonly<Record<string, unknown>>;
  readonly phase?: "preparing" | "reading";
}
export interface MemoryReadPage {
  readonly ref: string;
  readonly view?: "summary" | "transcript";
  /** Lossless fragment of the selected textual resource or canonical JSON transcript. */
  readonly content: string;
  readonly cursor?: string;
  readonly complete: boolean;
  readonly coverage: MemoryCoverage;
  readonly notice?: string;
}
export interface MemorySession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  readonly channel: string | null;
}
export interface MemoryScope {
  readonly storeId: string;
  readonly workspaceRoot: string;
  readonly memoryFiles: readonly string[];
  readonly sessions: readonly MemorySession[];
}
/** All callbacks are read-only and revalidate mapped-chat scope at the gateway boundary. */
export interface MemoryHost {
  scope(caller: ConversationId, context: Context, operation: typeof MEMORY_TOOL_NAMES[number]): Promise<MemoryScope>;
  entries(session: string, query: { readonly minEntryId?: EntryId; readonly maxEntryId?: EntryId; readonly order?: "ascending" | "descending" }, limit: number, cursor: Cursor | undefined, context: Context): Promise<{ readonly items: readonly EntryRecord[]; readonly next?: Cursor }>;
  summary(session: string, episodeStart: number, context: Context): Promise<HistorySummaryView>;
  search(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  searchSummaries(query: HistorySummaryQuery, context: Context): Promise<HistorySummaryPage>;
}
export interface MemoryBackend {
  search(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage>;
  browse(query: MemoryQuery, scope: MemoryScope, context: Context): Promise<MemoryPage>;
  read(query: MemoryReadQuery, ref: MemoryRef, scope: MemoryScope, context: Context): Promise<MemoryReadPage>;
  close?(): void;
}
export interface MemoryService {
  search(caller: ConversationId, query: unknown, context: Context): Promise<MemoryPage>;
  browse(caller: ConversationId, query: unknown, context: Context): Promise<MemoryPage>;
  read(caller: ConversationId, query: unknown, context: Context): Promise<MemoryReadPage>;
  close(): void;
}
