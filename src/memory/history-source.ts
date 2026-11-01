import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import type {
  MemoryHit,
  MemoryProvenance,
  MemoryQuery,
  MemoryRef,
  MemoryScope,
  MemorySession,
} from "./contracts.js";
import { decodeRef, encodeRef, hash } from "./validation.js";

export interface HistoryPart {
  readonly index: number;
  readonly kind: "message" | "tool";
  readonly messageIndex: number;
  readonly toolOrdinal?: number;
  readonly role: "user" | "assistant" | "tool";
  readonly toolName?: string;
  readonly toolKind?: "call" | "result";
  readonly timestamp: number | null;
  readonly body: string;
  readonly value: unknown;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageTimestamp(raw: RecordValue): number | null {
  const timestamp = raw.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || !Number.isInteger(timestamp)) return null;
  const date = new Date(timestamp);
  const nextMillisecond = new Date(timestamp + 1);
  return Number.isNaN(date.getTime()) || Number.isNaN(nextMillisecond.getTime()) ? null : timestamp;
}

function textualContent(content: unknown): { value: unknown; text: string; omitted: number } | undefined {
  if (typeof content === "string") return { value: content, text: content, omitted: 0 };
  if (!Array.isArray(content)) return undefined;
  const textBlocks: RecordValue[] = [];
  const strings: string[] = [];
  let omitted = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      textBlocks.push({ type: "text", text: block.text });
      strings.push(block.text);
    } else {
      omitted++;
    }
  }
  return { value: textBlocks, text: strings.join("\n"), omitted };
}

function messageValue(raw: RecordValue, role: "user" | "assistant", content: unknown): unknown {
  const value: Record<string, unknown> = { role, content };
  if (typeof raw.timestamp === "number") value.timestamp = raw.timestamp;
  return value;
}

function jsonText(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? "undefined" : result;
  } catch {
    return "[unserializable]";
  }
}

/** Project only user/assistant text and named tool calls/results, preserving source indexes. */
export function projectEntry(entry: EntryRecord): { parts: HistoryPart[]; malformed: number; omittedNonText: number } {
  const parts: HistoryPart[] = [];
  let malformed = 0;
  let omittedNonText = 0;
  let partIndex = 0;
  let toolOrdinal = 0;
  const userKind = entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND;
  const assistantKind = entry.kind === AssistantEntry.kind;
  const toolResultKind = entry.kind === ToolResultEntry.kind;

  if (entry.kind === ResetEntry.kind || entry.kind === SystemEntry.kind || entry.kind === CompactionEntry.kind) {
    return { parts, malformed, omittedNonText };
  }
  if (!userKind && !assistantKind && !toolResultKind) return { parts, malformed, omittedNonText };
  if (entry.model === undefined) return { parts, malformed, omittedNonText };
  if (!Array.isArray(entry.model)) return { parts, malformed: 1, omittedNonText };

  for (let messageIndex = 0; messageIndex < entry.model.length; messageIndex++) {
    const raw: unknown = entry.model[messageIndex];
    if (!isRecord(raw)) {
      malformed++;
      continue;
    }
    const timestamp = messageTimestamp(raw);
    if (userKind) {
      if (raw.role !== "user") continue;
      const content = textualContent(raw.content);
      if (content === undefined) {
        malformed++;
        continue;
      }
      omittedNonText += content.omitted;
      if (content.text.trim().length === 0) continue;
      parts.push({ index: partIndex++, kind: "message", messageIndex, role: "user", timestamp, body: content.text, value: messageValue(raw, "user", content.value) });
      continue;
    }
    if (assistantKind) {
      if (raw.role !== "assistant") continue;
      if (!Array.isArray(raw.content)) {
        malformed++;
        continue;
      }
      const content = textualContent(raw.content);
      if (content === undefined) {
        malformed++;
        continue;
      }
      omittedNonText += content.omitted;
      if (content.text.trim().length > 0) {
        parts.push({ index: partIndex++, kind: "message", messageIndex, role: "assistant", timestamp, body: content.text, value: messageValue(raw, "assistant", content.value) });
      }
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (typeof block.name !== "string" || block.name.length === 0) {
          malformed++;
          continue;
        }
        const ordinal = toolOrdinal++;
        const argsText = jsonText(block.arguments);
        const failureText = typeof block.argumentsError === "string" && block.argumentsError.length > 0 ? `\nargumentsError: ${block.argumentsError}` : "";
        const value: Record<string, unknown> = { type: "toolCall" };
        for (const key of ["id", "name", "arguments", "argumentsError"] as const) {
          if (block[key] !== undefined) value[key] = block[key];
        }
        parts.push({ index: partIndex++, kind: "tool", messageIndex, toolOrdinal: ordinal, role: "tool", toolName: block.name, toolKind: "call", timestamp, body: `${block.name}\n${argsText}${failureText}`, value });
      }
      continue;
    }
    if (raw.role !== "toolResult") continue;
    const toolName = typeof raw.toolName === "string" && raw.toolName.length > 0 ? raw.toolName : undefined;
    const ordinal = toolOrdinal++;
    const content = textualContent(raw.content);
    if (content === undefined) {
      malformed++;
      continue;
    }
    omittedNonText += content.omitted;
    if (content.text.trim().length === 0 && toolName === undefined) continue;
    const value: Record<string, unknown> = { role: "toolResult", content: content.value };
    for (const [key, item] of Object.entries(raw)) {
      if (key !== "role" && key !== "content") value[key] = item;
    }
    const body = toolName === undefined ? content.text : `${toolName}\n${content.text}`;
    parts.push({ index: partIndex++, kind: "tool", messageIndex, toolOrdinal: ordinal, role: "tool", ...(toolName === undefined ? {} : { toolName }), toolKind: "result", timestamp, body, value });
  }
  return { parts, malformed, omittedNonText };
}

/** Fingerprint the complete native entry, not a lossy searchable projection. */
export function entryFingerprint(entry: EntryRecord): string {
  return hash(entry);
}

function refToken(ref: MemoryRef): string {
  return encodeRef(ref);
}

function provenanceOf(session: MemorySession): MemoryProvenance {
  return "unknown";
}

function excerpt(text: string, length = 280): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

export function partHit(
  part: HistoryPart,
  entry: EntryRecord,
  session: MemorySession,
  episodeStart: number,
  state: "open" | "closed",
  scope: MemoryScope,
): MemoryHit {
  const fingerprint = entryFingerprint(entry);
  const common = { version: 1 as const, storeId: scope.storeId, session: session.sessionKey, entryId: entry.id, fingerprint };
  const ref = part.kind === "tool"
    ? refToken({ ...common, kind: "tool", blockIndex: part.toolOrdinal! })
    : refToken({ ...common, kind: "message", messageIndex: part.messageIndex });
  const episodeRef = refToken({ version: 1, storeId: scope.storeId, kind: "episode", session: session.sessionKey, episodeStart });
  const from = part.timestamp === null ? null : new Date(part.timestamp).toISOString();
  const to = part.timestamp === null ? null : new Date(part.timestamp + 1).toISOString();
  return {
    ref,
    episodeRef,
    source: {
      target: part.kind === "tool" ? "tools" : "messages",
      session: session.sessionKey,
      channel: session.channel,
      provenance: provenanceOf(session),
      entryId: entry.id,
      role: part.role,
      ...(part.toolName === undefined ? {} : { toolName: part.toolName }),
      ...(part.toolKind === undefined ? {} : { kind: part.toolKind }),
    },
    time: { from, to, undated: part.timestamp === null ? 1 : 0 },
    excerpt: excerpt(part.body),
    preview: true,
    coverage: { complete: true, unreadable: 0, undated: part.timestamp === null ? 1 : 0 },
    state,
  };
}

export function scopeKey(scope: MemoryScope): string {
  return hash({
    storeId: scope.storeId,
    workspaceRoot: scope.workspaceRoot,
    memoryFiles: [...scope.memoryFiles].sort(),
    sessions: scope.sessions.map((session) => ({ sessionKey: session.sessionKey, conversationId: session.conversationId, channel: session.channel })).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)),
  });
}

export function queryKey(query: MemoryQuery, scope: MemoryScope, mode: "search" | "browse"): string {
  const { cursor: _cursor, limit: _limit, ...enumeration } = query;
  return hash({ mode, query: enumeration, scope: scopeKey(scope) });
}

export function episodeFilters(query: MemoryQuery, scope: MemoryScope): readonly { session: string; start: number }[] | undefined {
  const tokens = query.filter?.episodes;
  if (tokens === undefined) return undefined;
  return tokens.map((token) => {
    const ref = decodeRef(token, scope.storeId);
    if (ref.kind !== "episode" || ref.session === undefined || ref.episodeStart === undefined) throw new TypeError("episode filter reference is invalid");
    if (!scope.sessions.some((session) => session.sessionKey === ref.session)) throw new TypeError("episode filter is outside the current scope");
    return { session: ref.session, start: ref.episodeStart };
  });
}

function validateSessions(query: MemoryQuery, scope: MemoryScope): void {
  for (const requested of query.filter?.sessions ?? []) {
    if (!scope.sessions.some((session) => session.sessionKey === requested)) throw new TypeError("session filter is outside the current scope");
  }
}

function inList<T>(values: readonly T[] | undefined, value: T | undefined): boolean {
  return values === undefined || (value !== undefined && values.includes(value));
}

function timeMatches(time: MemoryHit["time"], filter: MemoryQuery["filter"] extends infer _ ? { readonly from?: string; readonly to?: string } | undefined : never): boolean {
  if (filter === undefined) return true;
  if (time.from === null) return false;
  const instant = Date.parse(time.from);
  if (filter.from !== undefined && instant < Date.parse(filter.from)) return false;
  if (filter.to !== undefined && instant >= Date.parse(filter.to)) return false;
  return true;
}

export function matchesPart(query: MemoryQuery, hit: MemoryHit, state: "open" | "closed", scope: MemoryScope): boolean {
  validateSessions(query, scope);
  const filter = query.filter;
  const session = hit.source.session;
  if (!inList(filter?.sessions, session)) return false;
  if (!inList(filter?.channel, hit.source.channel ?? undefined)) return false;
  if (!inList(filter?.provenance, hit.source.provenance ?? "unknown")) return false;
  if (!inList(filter?.state, state)) return false;
  if (!inList(filter?.roles, hit.source.role as "user" | "assistant" | undefined)) return false;
  if (!inList(filter?.toolNames, hit.source.toolName)) return false;
  if (!inList(filter?.kinds, hit.source.kind as "call" | "result" | undefined)) return false;
  if (!timeMatches(hit.time, filter?.time)) return false;
  const episodes = episodeFilters(query, scope);
  if (episodes !== undefined) {
    if (hit.episodeRef === undefined) return false;
    const ref = decodeRef(hit.episodeRef, scope.storeId);
    if (ref.kind !== "episode" || !episodes.some((episode) => episode.session === ref.session && episode.start === ref.episodeStart)) return false;
  }
  return true;
}

export function matchesEpisode(query: MemoryQuery, hit: MemoryHit, scope: MemoryScope): boolean {
  validateSessions(query, scope);
  const filter = query.filter;
  if (!inList(filter?.sessions, hit.source.session)) return false;
  if (!inList(filter?.channel, hit.source.channel ?? undefined)) return false;
  if (!inList(filter?.provenance, hit.source.provenance ?? "unknown")) return false;
  if (!inList(filter?.state, hit.state)) return false;
  const episodes = episodeFilters(query, scope);
  if (episodes !== undefined) {
    if (hit.episodeRef === undefined) return false;
    const ref = decodeRef(hit.episodeRef, scope.storeId);
    if (ref.kind !== "episode" || !episodes.some((episode) => episode.session === ref.session && episode.start === ref.episodeStart)) return false;
  }
  const filterTime = filter?.time;
  if (filterTime !== undefined) {
    if (hit.time.from === null || hit.time.to === null) return false;
    const episodeFrom = Date.parse(hit.time.from);
    const episodeTo = Date.parse(hit.time.to);
    if (filterTime.from !== undefined && episodeTo <= Date.parse(filterTime.from)) return false;
    if (filterTime.to !== undefined && episodeFrom >= Date.parse(filterTime.to)) return false;
  }
  return true;
}
