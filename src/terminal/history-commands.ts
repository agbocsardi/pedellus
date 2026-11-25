import type { Context } from "@earendil-works/chord";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import type { Cursor, EntryId } from "@earendil-works/pi-durable";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import { conversationCommandUsage } from "../help/commands.js";
import type { HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import {
  HISTORY_INDEX_LIMITS,
  type HistoryCoverage,
  type HistoryCursor,
  type HistoryHit,
  type HistoryPage,
  type HistoryQuery,
  type HistoryRole,
  type HistoryScope,
} from "../history/index.js";
import type {
  TerminalConversation,
  TerminalEntry,
  TerminalEntryPage,
  TerminalEntryQuery,
  TerminalMessage,
} from "./conversation.js";
import { completePrefix, errorName, historySessionToken, safeLabel, sanitizeTerminalText } from "./text.js";

/**
 * The terminal's read-only history commands: `/history`, `/search`, `/episodes`, `/episode` and
 * `/entry`. Every view is bounded, sanitized and derived; none writes the transcript or grants a
 * tool, and a search cursor stays process-local and is never printed.
 */

/**
 * Optional host-owned history read surface. The host supplies authenticated session scope; the
 * terminal never chooses a conversation or session key for search. Search results and episodes
 * are read-only derived views, never transcript writes or tool authority.
 */
export interface TerminalHistoryHost {
  /** Session used when a history command omits --session; normally cli:default. */
  readonly defaultSession: string;
  search(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  listEpisodes(sessionKey: string, query: HistoryEpisodeQuery, context: Context): Promise<HistoryEpisodePage>;
  episode(sessionKey: string, startEntryId: EntryId, context: Context): Promise<HistoryEpisode | undefined>;
  entries(
    sessionKey: string,
    query: TerminalEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<TerminalEntryPage>;
}

const MAX_HISTORY_COUNT = 50;
const DEFAULT_HISTORY_COUNT = 10;
const HISTORY_TEXT_CHARS = 200;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_ENTRY_LIMIT = 2_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_EXCERPT_CHARS = 600;
const ENTRY_TEXT_CHARS = 2_000;
const ENTRY_VIEW_MAX_RADIUS = 5;
const DEFAULT_EPISODE_LIST_LIMIT = 10;
const MAX_EPISODE_LIST_LIMIT = 50;
const DEFAULT_EPISODE_ENTRY_LIMIT = 10;
const MAX_EPISODE_ENTRY_LIMIT = 30;
const EPISODE_ENTRY_PAGE_SIZE = 100;
const MAX_EPISODE_SCAN_ENTRIES = 300;
const HISTORY_VIEW_CHARS = 48_000;

export interface HistoryCommandDeps {
  /** The attached conversation, for `/history` and default-session `/entry`. */
  readonly conversation: Pick<TerminalConversation, "entries">;
  /** The host history surface; absent leaves `/search` and `/episodes` unoffered. */
  readonly history: TerminalHistoryHost | undefined;
  /** The terminal's operation context; an aborted one suppresses failure notices. */
  readonly context: Context;
  /** One serialized notice line (or block); `toError` writes it to the error output. */
  notice(text: string, toError?: boolean): Promise<void>;
}

/** One handler per command, each taking the raw argument text after the command name. */
export interface HistoryCommands {
  history(args: string): Promise<void>;
  search(args: string): Promise<void>;
  episodes(args: string): Promise<void>;
  episode(args: string): Promise<void>;
  entry(args: string): Promise<void>;
}

export function createHistoryCommands(deps: HistoryCommandDeps): HistoryCommands {
  const { conversation, history, notice } = deps;
  const operationContext = deps.context;
  const signal = operationContext.abortSignal;
  /** Last successful search base and cursor; the cursor is opaque and never printed. */
  let pendingSearch: { readonly query: HistoryQuery; readonly cursor: HistoryCursor } | undefined;
  /** The offer set admitted these commands only with a host; fail loudly if the two disagree. */
  const requireHost = (): TerminalHistoryHost => {
    if (history === undefined) throw new Error("offered conversation command has no host");
    return history;
  };

  const showHistory = async (rawCount: string): Promise<void> => {
    let count = DEFAULT_HISTORY_COUNT;
    if (rawCount.trim()) {
      if (!/^\d+$/.test(rawCount.trim())) {
        await notice(conversationCommandUsage("history"), true);
        return;
      }
      count = Math.max(1, Math.min(Number(rawCount.trim()), MAX_HISTORY_COUNT));
    }

    const messages: string[] = [];
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const limit = Math.min(HISTORY_PAGE_SIZE, HISTORY_ENTRY_LIMIT - scanned);
      if (limit <= 0) break;
      const page = await conversation.entries({ order: "descending" }, limit, cursor, operationContext);
      scanned += page.items.length;
      for (const entry of page.items) {
        for (let index = entry.messages.length - 1; index >= 0; index--) {
          const formatted = formatHistoryMessage(entry.messages[index]!);
          if (formatted !== undefined) messages.push(formatted);
          if (messages.length >= count) break;
        }
        if (messages.length >= count) break;
      }
      cursor = page.next;
    } while (cursor !== undefined && messages.length < count && scanned < HISTORY_ENTRY_LIMIT);

    if (messages.length === 0) {
      await notice("No conversation history yet.");
      return;
    }
    messages.reverse();
    const capped = cursor !== undefined && scanned >= HISTORY_ENTRY_LIMIT && messages.length < count;
    await notice(`Last ${messages.length} text message(s):\n${messages.join("\n")}${capped ? "\n[History scan capped.]" : ""}`);
  };

  const showSearch = async (args: string): Promise<void> => {
    const host = requireHost();
    const parsed = parseSearchArguments(args);
    if (parsed.kind === "usage") {
      await notice(SEARCH_USAGE, true);
      return;
    }
    if (parsed.kind === "next" && pendingSearch === undefined) {
      await notice("No search continuation is held. Run /search again; cursors are process-local and are never printed.", true);
      return;
    }

    let base: HistoryQuery;
    let query: HistoryQuery;
    if (parsed.kind === "next") {
      base = pendingSearch!.query;
      query = { ...base, cursor: pendingSearch!.cursor };
    } else {
      base = {
        text: parsed.text,
        scope: parsed.scope,
        limit: parsed.limit,
        ...(parsed.role === undefined ? {} : { roles: [parsed.role] }),
      };
      query = base;
      // A fresh query replaces any older continuation, even if this one fails.
      pendingSearch = undefined;
    }
    if ([...(base.text ?? "")].length > HISTORY_INDEX_LIMITS.maxQueryChars) {
      await notice(`Search query must be at most ${HISTORY_INDEX_LIMITS.maxQueryChars} characters.`, true);
      return;
    }

    let page: HistoryPage;
    try {
      page = await host.search(query, operationContext);
    } catch (error) {
      if (signal?.aborted) return;
      if (parsed.kind === "next") {
        pendingSearch = undefined;
        await notice("Search continuation rejected: the query, index, store or session mapping changed. Run /search again; cursors are process-local and are never printed.", true);
      } else {
        await notice(`History search failed (${errorName(error)}).`, true);
      }
      return;
    }
    pendingSearch = page.next === undefined ? undefined : { query: base, cursor: page.next };

    const scopeLabel = base.scope ?? "messages";
    const rolesLabel = base.roles === undefined ? "user+assistant messages" : `messages from ${base.roles.join(",")}`;
    const target = scopeLabel === "tools"
      ? "tool names, arguments and result text"
      : scopeLabel === "all"
        ? `${rolesLabel} plus tools`
        : rolesLabel;
    const lines = [
      `History search${parsed.kind === "next" ? " (continued)" : ""}: ${base.text ? `text=${safeLabel(base.text, 120)}` : "(browse)"}; scope=${scopeLabel}; ${target}; limit=${base.limit}.`,
    ];
    const coverageComplete = historyCoverageComplete(page.coverage);
    const footer = [
      page.hits.length === 0
        ? "No hits in the indexed records for this query and scope."
        : `${page.hits.length} hit(s), newest first:`,
      ...formatHistoryCoverage(page.coverage),
    ];
    if (page.next !== undefined) {
      footer.push("More results: /search --next (the same query and session mapping; entries appended after this page need a fresh search). Cursors are process-local and are never printed.");
    } else if (!coverageComplete) {
      footer.push("No further hits in this indexed window; the index is incomplete, so retry later for newly indexed entries.");
    }
    await notice(formatBoundedHistory(lines, footer, page.hits.map((hit, index) => formatHistoryHit(hit, index + 1))));
  };

  const showEpisodes = async (args: string): Promise<void> => {
    const host = requireHost();
    const parsed = parseEpisodesArguments(args);
    if (parsed.kind === "usage") {
      await notice(EPISODES_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host.defaultSession;
    const sessionToken = historySessionToken(sessionKey);
    let page: HistoryEpisodePage;
    try {
      page = await host.listEpisodes(sessionKey, parsed.query, operationContext);
    } catch (error) {
      if (!signal?.aborted) await notice(`Episode listing failed (${errorName(error)}).`, true);
      return;
    }
    if (page.episodes.length === 0) {
      await notice(parsed.query.before === undefined
        ? `No non-empty episodes recorded yet for session ${safeLabel(sessionKey, 120)}.`
        : `No more non-empty episodes below that boundary for session ${safeLabel(sessionKey, 120)}.`);
      return;
    }
    const rows = page.episodes.map((episode) => {
      const end = episode.endEntryId === null ? "open" : String(episode.endEntryId);
      return `  #${episode.startEntryId}-${end} ${episode.status}; entries=${episode.entries ?? "uncounted"} messages=${episode.messages ?? "uncounted"} tools=${episode.toolResults ?? "uncounted"}; ${episode.resetEntryId === null ? "pre-reset segment" : `reset=${episode.resetEntryId}`}; summary=${episode.summary.status}; digest=${episode.digestion?.status ?? "unknown"}`;
    });
    const lines = [
      `Episodes for session ${safeLabel(sessionKey, 120)} (newest first), ${page.episodes.length} selected:`,
    ];
    const footer = [
      "Summary text is not generated or shown; only the recorded summary status is reported.",
    ];
    if (page.next !== undefined) {
      footer.push(sessionToken === undefined
        ? "Older episodes exist; the continuation hint is suppressed because this session key is not exactly representable as a CLI token."
        : `Older episodes: /episodes --session ${sessionToken} --before ${page.next.before}`);
    }
    footer.push(sessionToken === undefined
      ? "Drilldown hints are suppressed: this session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units."
      : `Open one with /episode --session ${sessionToken} <startEntryId>, or a bounded window around any entry with /entry --session ${sessionToken} <entryId>.`);
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  const showEpisode = async (args: string): Promise<void> => {
    const host = requireHost();
    const parsed = parseEpisodeArguments(args);
    if (parsed.kind === "usage") {
      await notice(EPISODE_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host.defaultSession;
    const sessionToken = historySessionToken(sessionKey);
    let episode: HistoryEpisode | undefined;
    try {
      episode = await host.episode(sessionKey, parsed.startEntryId, operationContext);
    } catch (error) {
      if (!signal?.aborted) await notice(`Episode read failed (${errorName(error)}).`, true);
      return;
    }
    if (episode === undefined) {
      await notice(`No non-empty episode starts at entry #${parsed.startEntryId} in session ${safeLabel(sessionKey, 120)}. Use /episodes to list episode starts.`, true);
      return;
    }

    const rows: string[] = [];
    let cursor: Cursor | undefined;
    let scanned = 0;
    let exhausted = false;
    try {
      while (rows.length < parsed.limit && scanned < MAX_EPISODE_SCAN_ENTRIES) {
        const take = Math.min(EPISODE_ENTRY_PAGE_SIZE, MAX_EPISODE_SCAN_ENTRIES - scanned);
        const page = await host.entries(sessionKey, {
          order: "ascending",
          minEntryId: episode.startEntryId,
          ...(episode.endEntryId === null ? {} : { maxEntryId: episode.endEntryId }),
        }, take, cursor, operationContext);
        if (page.items.length === 0) {
          exhausted = true;
          break;
        }
        scanned += page.items.length;
        for (const entry of page.items) {
          const display = formatBrowsedEntry(entry, entry.id === parsed.startEntryId);
          if (display !== undefined) rows.push(display);
          if (rows.length >= parsed.limit) break;
        }
        cursor = page.next;
        if (cursor === undefined) {
          exhausted = true;
          break;
        }
      }
    } catch (error) {
      if (!signal?.aborted) await notice(`Could not read episode entries (${errorName(error)}).`, true);
      return;
    }

    const end = episode.endEntryId === null ? "open" : String(episode.endEntryId);
    const lines = [
      `Episode #${episode.startEntryId}-${end} for session ${safeLabel(sessionKey, 120)} (${episode.status}; summary=${episode.summary.status}; digest=${episode.digestion?.status ?? "unknown"}); conversation=${episode.conversationId}; entries=${episode.entries ?? "uncounted"} messages=${episode.messages ?? "uncounted"} tools=${episode.toolResults ?? "uncounted"}.`,
    ];
    if (episode.resetEntryId !== null) lines.push(`Reset boundary: entry #${episode.resetEntryId} (reset handoff text is not shown).`);
    const footer: string[] = [];
    if (rows.length === 0) {
      footer.push(`No displayable message/tool entry in the first ${scanned} scanned entr${scanned === 1 ? "y" : "ies"}.`);
    } else {
      footer.push(`Selected ${rows.length} message/tool entr${rows.length === 1 ? "y" : "ies"}; scanned ${scanned} entr${scanned === 1 ? "y" : "ies"}${episode.entries === null ? "" : ` of ${episode.entries}`}.`);
    }
    if (!exhausted && rows.length >= parsed.limit) {
      footer.push(sessionToken === undefined
        ? `[Episode view limited to ${parsed.limit} displayable entries; the continuation hint is suppressed because this session key is not exactly representable as a CLI token.]`
        : `[Episode view limited to ${parsed.limit} displayable entries; use /entry --session ${sessionToken} <entryId> for another window.]`);
    }
    if (!exhausted && scanned >= MAX_EPISODE_SCAN_ENTRIES) footer.push(`[Episode scan capped at ${MAX_EPISODE_SCAN_ENTRIES} entries.]`);
    if (sessionToken === undefined) footer.push("Drilldown hints are suppressed: this session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units.");
    footer.push("System, reset, compaction and thinking content is not shown; raw stored entries are not modified.");
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  const showEntry = async (args: string): Promise<void> => {
    const host = history;
    const parsed = parseEntryArguments(args);
    if (parsed.kind === "usage") {
      await notice(ENTRY_USAGE, true);
      return;
    }
    const sessionKey = parsed.session ?? host?.defaultSession ?? "cli:default";
    if (parsed.session !== undefined && host === undefined) {
      // `/entry` itself is offered without a history host; only cross-session browsing needs one.
      await notice("Cross-session entry browsing needs the host history surface, which this host does not expose.", true);
      return;
    }
    if (host === undefined && sessionKey !== "cli:default") {
      await notice("Entry browsing is limited to the default session without a history host.", true);
      return;
    }
    const minEntryId = Math.max(1, parsed.entryId - parsed.radius) as EntryId;
    const maxEntryId = Math.min(Number.MAX_SAFE_INTEGER, parsed.entryId + parsed.radius) as EntryId;
    let rows: string[];
    let hidden = 0;
    let selectedSeen = false;
    let conversationId: number;
    try {
      const page: TerminalEntryPage = host === undefined
        ? await conversation.entries({ order: "ascending", minEntryId, maxEntryId }, parsed.radius * 2 + 1, undefined, operationContext)
        : await host.entries(sessionKey, { order: "ascending", minEntryId, maxEntryId }, parsed.radius * 2 + 1, undefined, operationContext);
      conversationId = page.conversationId;
      rows = [];
      for (const entry of page.items) {
        if (entry.id === parsed.entryId) selectedSeen = true;
        const display = formatBrowsedEntry(entry, entry.id === parsed.entryId);
        if (display === undefined) hidden++;
        else rows.push(display);
      }
    } catch (error) {
      if (!signal?.aborted) await notice(`Could not read entries (${errorName(error)}).`, true);
      return;
    }

    const lines = [
      `Entry window #${minEntryId}-${maxEntryId} for session ${safeLabel(sessionKey, 120)} in conversation ${conversationId}; selected=#${parsed.entryId}; radius=${parsed.radius}.`,
    ];
    const footer: string[] = [];
    if (!selectedSeen) footer.push(`Entry #${parsed.entryId} was not found in the visible transcript.`);
    if (rows.length === 0) footer.push("No displayable message/tool entry in this window.");
    if (hidden > 0) footer.push(`${hidden} entr${hidden === 1 ? "y" : "ies"} in the window had no displayable message/tool text and were not shown.`);
    footer.push("System, reset, compaction and thinking content is not shown; raw stored entries are not modified.");
    await notice(formatBoundedHistory(lines, footer, rows));
  };

  return { history: showHistory, search: showSearch, episodes: showEpisodes, episode: showEpisode, entry: showEntry };
}

function formatHistoryMessage(message: TerminalMessage): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const cleaned = sanitizeTerminalText(message.text).trim();
  if (!cleaned) return undefined;
  const characters = Array.from(cleaned);
  const snippet = characters.length > HISTORY_TEXT_CHARS
    ? `${characters.slice(0, HISTORY_TEXT_CHARS).join("")}…`
    : cleaned;
  return `${message.role === "user" ? "You" : "Assistant"}: ${snippet}`;
}

const SEARCH_USAGE = conversationCommandUsage("search");
const EPISODES_USAGE = conversationCommandUsage("episodes");
const EPISODE_USAGE = conversationCommandUsage("episode");
const ENTRY_USAGE = conversationCommandUsage("entry");

type SearchArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "next" }
  | {
    readonly kind: "search";
    readonly text: string;
    readonly scope: HistoryScope;
    readonly role?: HistoryRole;
    readonly limit: number;
  };

type EpisodesArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "list"; readonly query: HistoryEpisodeQuery; readonly session?: string };

type EpisodeArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "open"; readonly startEntryId: EntryId; readonly limit: number; readonly session?: string };

type EntryArguments =
  | { readonly kind: "usage" }
  | { readonly kind: "entry"; readonly entryId: EntryId; readonly radius: number; readonly session?: string };

function parseSearchArguments(input: string): SearchArguments {
  let rest = input.trim();
  if (!rest) return { kind: "usage" };
  let scope: HistoryScope | undefined;
  let role: HistoryRole | undefined;
  let limit = DEFAULT_SEARCH_LIMIT;
  let explicit = false;
  let next = false;
  let sawLimit = false;
  let endOfOptions = false;
  while (rest.startsWith("--")) {
    const token = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (token === null) return { kind: "usage" };
    const flag = token[1]!;
    rest = (token[2] ?? "").trimStart();
    if (flag === "--") {
      endOfOptions = true;
      break;
    }
    if (flag === "--next") {
      if (next) return { kind: "usage" };
      next = true;
      explicit = true;
      continue;
    }
    if (next || (flag !== "--scope" && flag !== "--role" && flag !== "--limit")) return { kind: "usage" };
    const value = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (value === null) return { kind: "usage" };
    const raw = value[1]!;
    rest = (value[2] ?? "").trimStart();
    explicit = true;
    if (flag === "--scope") {
      if (scope !== undefined || (raw !== "messages" && raw !== "tools" && raw !== "all")) return { kind: "usage" };
      scope = raw;
    } else if (flag === "--role") {
      if (role !== undefined || (raw !== "user" && raw !== "assistant")) return { kind: "usage" };
      role = raw;
    } else {
      if (sawLimit || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_SEARCH_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    }
  }
  const text = rest.trim();
  if (endOfOptions && !text) return { kind: "usage" };
  if (next) {
    return endOfOptions || text || scope !== undefined || role !== undefined || sawLimit
      ? { kind: "usage" }
      : { kind: "next" };
  }
  if (scope === "tools" && role !== undefined) return { kind: "usage" };
  if (!text && !explicit) return { kind: "usage" };
  return {
    kind: "search",
    text,
    scope: scope ?? "messages",
    ...(role === undefined ? {} : { role }),
    limit,
  };
}

function parseEpisodesArguments(input: string): EpisodesArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let limit = DEFAULT_EPISODE_LIST_LIMIT;
  let before: EntryId | undefined;
  let session: string | undefined;
  let sawLimit = false;
  let sawBefore = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_EPISODE_LIST_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    } else if (token === "--before") {
      if (sawBefore) return { kind: "usage" };
      const parsed = parsePositiveEntryId(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      before = parsed;
      sawBefore = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else {
      return { kind: "usage" };
    }
  }
  return {
    kind: "list",
    query: { limit, ...(before === undefined ? {} : { before }) },
    ...(session === undefined ? {} : { session }),
  };
}

function parseEpisodeArguments(input: string): EpisodeArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let startEntryId: EntryId | undefined;
  let limit = DEFAULT_EPISODE_ENTRY_LIMIT;
  let session: string | undefined;
  let sawLimit = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--limit") {
      if (sawLimit) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_EPISODE_ENTRY_LIMIT) return { kind: "usage" };
      limit = Number(raw);
      sawLimit = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else if (token.startsWith("--") || startEntryId !== undefined) {
      return { kind: "usage" };
    } else {
      startEntryId = parsePositiveEntryId(token);
      if (startEntryId === undefined) return { kind: "usage" };
    }
  }
  if (startEntryId === undefined) return { kind: "usage" };
  return { kind: "open", startEntryId, limit, ...(session === undefined ? {} : { session }) };
}

function parseEntryArguments(input: string): EntryArguments {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let entryId: EntryId | undefined;
  let radius = 1;
  let session: string | undefined;
  let sawRadius = false;
  let sawSession = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--radius") {
      if (sawRadius) return { kind: "usage" };
      const raw = tokens[++index];
      if (raw === undefined || !/^[0-9]$/.test(raw) || Number(raw) > ENTRY_VIEW_MAX_RADIUS) return { kind: "usage" };
      radius = Number(raw);
      sawRadius = true;
    } else if (token === "--session") {
      if (sawSession) return { kind: "usage" };
      const parsed = parseSessionKey(tokens[++index]);
      if (parsed === undefined) return { kind: "usage" };
      session = parsed;
      sawSession = true;
    } else if (token.startsWith("--") || entryId !== undefined) {
      return { kind: "usage" };
    } else {
      entryId = parsePositiveEntryId(token);
      if (entryId === undefined) return { kind: "usage" };
    }
  }
  if (entryId === undefined) return { kind: "usage" };
  return { kind: "entry", entryId, radius, ...(session === undefined ? {} : { session }) };
}

function parseSessionKey(value: string | undefined): string | undefined {
  return historySessionToken(value);
}

function parsePositiveEntryId(value: string | undefined): EntryId | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id as EntryId : undefined;
}

function formatHistoryHit(hit: HistoryHit, ordinal: number): string {
  const meta = [
    `entry=${hit.entryId}`,
    `session=${safeLabel(hit.sessionKey, 80)}`,
    `conversation=${hit.conversationId}`,
    `episode=${hit.episodeStartEntryId}`,
    `kind=${safeLabel(hit.entryKind, 40)}`,
  ];
  if (hit.toolName !== undefined) meta.push(`tool=${safeLabel(hit.toolName, 80)}`);
  if (hit.toolCallId !== undefined) meta.push(`call=${safeLabel(hit.toolCallId, 80)}`);
  if (hit.timestamp !== undefined) meta.push(`time=${formatHistoryTimestamp(hit.timestamp)}`);
  if (hit.partIndex > 0) meta.push(`part=${hit.partIndex}`);
  if (hit.chunkIndex > 0) meta.push(`chunk=${hit.chunkIndex}`);
  const excerpt = completePrefix(sanitizeTerminalText(hit.excerpt), SEARCH_EXCERPT_CHARS) || "(empty excerpt)";
  const flags: string[] = [];
  if (hit.excerptTruncated) flags.push("excerpt truncated");
  if (hit.bodyTruncated) flags.push("body truncated in index");
  const sessionToken = historySessionToken(hit.sessionKey);
  const navigation = sessionToken === undefined
    ? "   navigate: drilldown suppressed; the exact session key contains whitespace, control/bidi marks, an unpaired surrogate, or exceeds 200 code units."
    : `   open: /entry --session ${sessionToken} ${hit.entryId} --radius 1; episode: /episode --session ${sessionToken} ${hit.episodeStartEntryId}`;
  return [
    `${ordinal}. [${hit.role}] ${meta.join(" ")}`,
    `   ${excerpt.replace(/\n/g, "\n   ")}`,
    ...(flags.length === 0 ? [] : [`   (${flags.join("; ")})`]),
    navigation,
  ].join("\n");
}

function historyCoverageComplete(coverage: HistoryCoverage): boolean {
  return coverage.complete && coverage.malformedEntries === 0 && coverage.malformedMessages === 0;
}

function formatHistoryCoverage(coverage: HistoryCoverage): string[] {
  const lines = [
    `Index: ${countLabel(coverage.indexedEntries, "indexed entry", "indexed entries")} across ${countLabel(coverage.chatSessions, "chat session")}; ${countLabel(coverage.resetBoundaries, "reset boundary", "reset boundaries")}; boundary entry ${coverage.boundaryEntryId}.`,
  ];
  if (coverage.pendingEntries > 0 || !coverage.pendingComplete) {
    const pending = `${coverage.pendingEntries}${coverage.pendingComplete ? "" : "+"}`;
    lines.push(`Lag: ${pending} pending entr${coverage.pendingEntries === 1 && coverage.pendingComplete ? "y" : "ies"} (${coverage.pendingComplete ? "counted" : "lower bound"}).`);
  }
  if (!coverage.sync.caughtUp) {
    lines.push(`Reconciliation stopped at ${coverage.sync.entriesScanned}/${coverage.sync.entryLimit} entries in this pass; the next search continues.`);
  }
  if (coverage.truncatedParts > 0) lines.push(`Text omitted in the index: ${countLabel(coverage.truncatedParts, "truncated part")}.`);
  if (coverage.editsUnsupported > 0) {
    lines.push(`Context edits are not projected: ${countLabel(coverage.editsUnsupported, "entry", "entries")} search as raw stored text.`);
  }
  if (coverage.malformedEntries > 0 || coverage.malformedMessages > 0) {
    lines.push(`Malformed stored records: ${coverage.malformedEntries} entr${coverage.malformedEntries === 1 ? "y" : "ies"}, ${coverage.malformedMessages} message${coverage.malformedMessages === 1 ? "" : "s"}.`);
  }
  lines.push(historyCoverageComplete(coverage)
    ? "Index: complete for this store snapshot and captured boundary; a later entry needs a fresh search."
    : "Index: INCOMPLETE — results are a bounded partial view and a no-hit answer does not prove absence.");
  return lines;
}

function formatBrowsedEntry(entry: TerminalEntry, selected: boolean): string | undefined {
  const body = browsedEntryBody(entry);
  if (body === undefined) return undefined;
  const text = completePrefix(sanitizeTerminalText(body.text), ENTRY_TEXT_CHARS).trim();
  if (!text) return undefined;
  const flags: string[] = [];
  if (selected) flags.push("selected");
  if (entry.edited === true) flags.push("raw entry; context edits not applied");
  return [
    `#${entry.id} [${body.label}] kind=${safeLabel(entry.kind, 40)}${flags.length === 0 ? "" : ` (${flags.join("; ")})`}`,
    `  ${text.replace(/\n/g, "\n  ")}`,
  ].join("\n");
}

function browsedEntryBody(entry: TerminalEntry): { readonly label: string; readonly text: string } | undefined {
  const message = entry.messages[0];
  if (message === undefined) return undefined;
  if (entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND) {
    if (message.role !== "user") return undefined;
    return message.text.trim() ? { label: entry.kind === CRON_INPUT_ENTRY_KIND ? "user (cron)" : "user", text: message.text } : undefined;
  }
  if (entry.kind === AssistantEntry.kind) {
    if (message.role !== "assistant") return undefined;
    let text = message.text;
    for (const call of message.toolCalls ?? []) {
      text += `\n[tool call ${safeLabel(call.name, 80)}${call.argumentsText === undefined ? "" : ` ${sanitizeTerminalText(call.argumentsText)}`}]`;
    }
    return text.trim() ? { label: "assistant", text } : undefined;
  }
  if (entry.kind === ToolResultEntry.kind) {
    if (message.role !== "toolResult") return undefined;
    return { label: `tool ${safeLabel(message.toolName ?? "unknown", 80)}`, text: message.text.trim() ? message.text : "(no text content)" };
  }
  return undefined;
}

function formatHistoryTimestamp(value: number): string {
  if (!Number.isFinite(value)) return "invalid";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBoundedHistory(
  header: readonly string[],
  footer: readonly string[],
  rows: readonly string[],
): string {
  const reserve = 160;
  const metadata = [...header, ...footer].join("\n");
  if (metadata.length > HISTORY_VIEW_CHARS - reserve) {
    return `${completePrefix(metadata, HISTORY_VIEW_CHARS - reserve)}\n[History metadata truncated by the terminal output bound; view limits were still applied.]`;
  }
  const visible: string[] = [];
  let used = metadata.length;
  for (const row of rows) {
    if (used + row.length + 2 > HISTORY_VIEW_CHARS - reserve) break;
    visible.push(row);
    used += row.length + 1;
  }
  const lines = [...header, ...footer];
  if (visible.length > 0) lines.push("", ...visible);
  const omitted = rows.length - visible.length;
  if (omitted > 0) {
    lines.push(`[${omitted} additional row(s) omitted by the terminal output bound; narrow the view or lower the limit.]`);
  }
  return lines.join("\n");
}
