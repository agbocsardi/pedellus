/**
 * Bounded rendering of one episode's committed entries into untrusted provider input.
 *
 * The transcript is source data, not instructions: everything this module produces is quoted
 * text for a summarizer prompt, and the summarizer gets no tools. Nothing here reads or writes
 * a grant, appends an entry or calls a provider.
 *
 * What is included, and what is not:
 * - `pi.user` and `nanobot.cron` entries contribute their user text.
 * - `pi.assistant` entries contribute visible text and each tool call with its arguments. Thinking
 *   blocks are omitted: they are not part of the stored conversation the user saw, and replaying
 *   them can exceed the source bound.
 * - `pi.tool-result` entries contribute the tool name and the result.
 * - `pi.reset` entries (including any handoff text in their model payload), `pi.system` and
 *   `pi.compaction` entries contribute nothing: they are synthetic context, and the episode's
 *   own reset marker is its boundary rather than its content. They are still counted.
 * - `entry.edits` are not applied: the summary describes the stored transcript, not the active
 *   edited model context. An entry carrying edits is otherwise rendered like any other entry.
 *
 * Every bound is explicit. One entry keeps at most {@link EPISODE_SUMMARY_SOURCE_LIMITS.entryChars}
 * characters of quoted text; a shortened entry ends with its marker, so its stored text may exceed that
 * bound by that marker and the separator before it. Ordinary message text is cut at its head with a
 * truncation marker, like before. A tool call's arguments or a tool result that does not fit is quoted
 * through the shared memory-recall head-tail preview (`clipPreview`), with its omission marker and the
 * durable reference of the original item; when the entry's remaining bound cannot hold that preview's
 * marker, or an overflowing part comes after it, the rest of the entry takes the counted head cut
 * instead. Anything a shortened entry cannot quote is counted, never dropped silently. A full chunk
 * stops at the chunk bound, and the caller records how many entries were covered and how many were
 * truncated.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { COMPACT_PREVIEW_MARKER, clipPreview } from "./digestion.js";

export const EPISODE_SUMMARY_SOURCE_LIMITS = Object.freeze({
  /** Characters of quoted text kept per entry; a truncation marker may follow that text. */
  entryChars: 2_000,
  /**
   * Target characters per fold chunk. The transcript can cross it by the one entry that closes the
   * chunk, that entry's truncation marker and the fold's `\n\n` separators.
   */
  chunkChars: 24_000,
  /** Entries visited per fold chunk, so a chunk of empty entries still terminates. */
  chunkEntries: 400,
  /** Entries read per transaction while collecting or rendering a chunk. */
  entriesPerPage: 400,
  /** Collect transactions per phase invocation before the task yields. */
  collectsPerPhase: 4,
  /** Provider attempts per chunk before the episode is marked failed. */
  maxAttempts: 4,
  /** Backoff base and ceiling between provider attempts. */
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  /** Output tokens requested for one fold. */
  maxTokens: 1_200,
});

const USER_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.user", "nanobot.cron"]);
const ASSISTANT_ENTRY_KIND = "pi.assistant";
const TOOL_RESULT_ENTRY_KIND = "pi.tool-result";

/** One entry's contribution to the summary source. */
export interface RenderedEntry {
  /** Text quoted to the summarizer; empty when the entry contributes nothing. */
  readonly text: string;
  /** The entry is an ordinary user/assistant message. */
  readonly message: boolean;
  /** The entry is a tool result. */
  readonly toolResult: boolean;
  /** Text was shortened to the per-entry bound, by a head cut or a head-tail preview. */
  readonly truncated: boolean;
}

const SKIPPED_ENTRY: RenderedEntry = Object.freeze({
  text: "",
  message: false,
  toolResult: false,
  truncated: false,
});

/**
 * Stored entries are JSON, not a typed API: a legacy, imported or hand-written entry can hold any
 * shape a store accepts. Rendering therefore normalizes instead of trusting: a value that is not the
 * expected object/array/string is skipped or stringified, and nothing here may throw, because a throw
 * in a task phase faults the task and would strand the durable summary chain.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Model messages of an entry, whatever the stored shape claims. */
function modelMessages(model: unknown): readonly unknown[] {
  return Array.isArray(model) ? model : [];
}

/** Content blocks of a message: a bare string, an array of blocks, or anything else. */
function contentBlocks(content: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(content)) return content.filter(isRecord);
  return [];
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.length === 0 ? [] : [content];
  return contentBlocks(content).flatMap((block) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : []);
}

/**
 * The marker a shortened entry ends with. It names exactly how many characters were not quoted, so a
 * reader can neither mistake a partial entry for the whole one nor guess at what was left out.
 */
function omission(chars: number): string {
  return `[... ${chars} more characters truncated]`;
}

function shorten(text: string, maxChars: number): { text: string; truncated: boolean } {
  const bounded = Math.max(0, maxChars);
  if (text.length <= bounded) return { text, truncated: false };
  return { text: `${text.slice(0, bounded)}\n${omission(text.length - bounded)}`, truncated: true };
}

/**
 * One quoted part of an entry. The `ref` is the durable reference of a tool call or tool result; it is
 * absent for ordinary message text, which keeps the head-only cut this renderer always used.
 */
interface RenderedSegment {
  readonly text: string;
  readonly ref?: string;
}

/**
 * Durable provenance of one item. The shape matches the memory-recall evidence refs
 * (`entry:<id>/tool-call/<key>` and `entry:<id>/tool-result/<callId>`). Recall pairs a tool result only
 * with a live call id, so an unpaired or id-less result is skipped there; here it must keep a
 * reference, which is why a positional `index-<n>` key exists at all. For a tool call, recall keys an
 * id-less call the same way but skips one whose name is not a string, and this renderer counts it, so
 * the two keys agree unless a stored call has no name.
 */
function itemRef(entryId: EntryRecord["id"], item: "tool-call" | "tool-result", key: string): string {
  return `entry:${entryId}/${item}/${key}`;
}

/**
 * A tool call or result key: the durable call id when there is one, otherwise the item's position in
 * the entry. Recall can skip an unpaired result or a nameless call, so only such a fallback key may
 * differ from its evidence; an archived item must never lose its only reference.
 */
function itemKey(value: unknown, index: number): string {
  return typeof value === "string" && value.length > 0 ? value : `index-${index}`;
}

function toolCallArguments(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}) ?? "null";
  } catch {
    return "[unserializable arguments]";
  }
}

/**
 * Join an entry's segments under the per-entry bound. Ordinary message text over the bound keeps the
 * head cut it always had, so the omitted characters stay counted. A tool call or tool result over the
 * bound becomes the shared head-tail preview, which names the original item.
 *
 * A preview uses whatever bound is left, so nothing after it can be quoted. Those parts are reported
 * with the same counted marker instead of disappearing: a shortened entry never drops text silently,
 * and a preview that cannot carry its own reference falls back to that counted head cut.
 */
function renderSegments(
  segments: readonly RenderedSegment[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const separator = parts.length === 0 ? 0 : 2;
    const remaining = maxChars - used - separator;
    if (segment.text.length <= remaining) {
      parts.push(segment.text);
      used += separator + segment.text.length;
      continue;
    }
    if (segment.ref !== undefined && remaining > 0) {
      const preview = clipPreview([segment.text], segment.text.length, remaining, segment.ref);
      if (preview.preview.marker !== COMPACT_PREVIEW_MARKER) {
        parts.push(preview.text);
        const later = segments.slice(index + 1);
        if (later.length > 0) parts.push(omission(later.map((part) => part.text).join("\n\n").length));
        return { text: parts.join("\n\n"), truncated: true };
      }
    }
    // Message prose, an exhausted bound, or a preview bound too small to name itself: one counted head
    // cut over everything still unquoted, so the omitted characters stay exact.
    const rest = segments.slice(index).map((part) => part.text).join("\n\n");
    if (remaining <= 0) {
      parts.push(omission(rest.length));
    } else {
      parts.push(shorten(rest, remaining).text);
    }
    return { text: parts.join("\n\n"), truncated: true };
  }
  return { text: parts.join("\n\n"), truncated: false };
}

/**
 * Render one entry. `model` payloads are read as stored; an entry without a model message (a
 * bookkeeping or data-only entry) contributes nothing but still counts as visited.
 */
export function renderEntry(entry: EntryRecord, entryChars = EPISODE_SUMMARY_SOURCE_LIMITS.entryChars): RenderedEntry {
  try {
    return renderEntryUnsafe(entry, entryChars);
  } catch {
    // Last-resort safety net: a stored shape this renderer cannot read is skipped, never thrown,
    // because a throw here would fault the task and strand the durable chain.
    return SKIPPED_ENTRY;
  }
}

function renderEntryUnsafe(entry: EntryRecord, entryChars: number): RenderedEntry {
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  const isUser = USER_ENTRY_KINDS.has(kind);
  const isToolResult = kind === TOOL_RESULT_ENTRY_KIND;
  if (!isUser && kind !== ASSISTANT_ENTRY_KIND && !isToolResult) return SKIPPED_ENTRY;
  const messages = modelMessages(entry.model);
  if (isToolResult) {
    const segments: RenderedSegment[] = [];
    let position = 0;
    for (const item of messages) {
      if (!isRecord(item) || item.role !== "toolResult") continue;
      position += 1;
      const body = textParts(item.content).join("\n").trim();
      if (body.length === 0) continue;
      const toolName = typeof item.toolName === "string" && item.toolName.length > 0
        ? item.toolName
        : "unknown-tool";
      segments.push({
        text: `[Tool result ${toolName}]: ${body}`,
        ref: itemRef(entry.id, "tool-result", itemKey(item.toolCallId, position - 1)),
      });
    }
    if (segments.length === 0) return { ...SKIPPED_ENTRY, toolResult: true };
    const rendered = renderSegments(segments, entryChars);
    return { text: rendered.text, message: false, toolResult: true, truncated: rendered.truncated };
  }
  const segments: RenderedSegment[] = [];
  let callPosition = 0;
  for (const item of messages) {
    if (!isRecord(item)) continue;
    if (item.role === "user") {
      const body = textParts(item.content).join("\n").trim();
      if (body.length > 0) segments.push({ text: `[User]: ${body}` });
      continue;
    }
    if (item.role !== "assistant") continue;
    const body = textParts(item.content).join("\n").trim();
    if (body.length > 0) segments.push({ text: `[Assistant]: ${body}` });
    for (const block of contentBlocks(item.content)) {
      if (block.type !== "toolCall") continue;
      const key = itemKey(block.id, callPosition);
      callPosition += 1;
      const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "unknown-tool";
      segments.push({
        text: `[Assistant tool call ${name}]: ${toolCallArguments(block.arguments)}`,
        ref: itemRef(entry.id, "tool-call", key),
      });
    }
  }
  if (segments.length === 0) return { ...SKIPPED_ENTRY, message: true };
  const rendered = renderSegments(segments, entryChars);
  return {
    text: rendered.text,
    message: true,
    toolResult: false,
    truncated: rendered.truncated,
  };
}

/**
 * Render a whole page for one fold chunk. Total: unsupported shapes are skipped and counted, so the
 * chunk boundaries computed during `collect` and the text sent during `fold` stay identical.
 */
export function renderEntries(
  entries: readonly EntryRecord[],
  entryChars = EPISODE_SUMMARY_SOURCE_LIMITS.entryChars,
): { readonly text: string; readonly rendered: readonly RenderedEntry[] } {
  const rendered = entries.map((entry) => renderEntry(entry, entryChars));
  return {
    text: rendered.flatMap((part) => (part.text.length === 0 ? [] : [part.text])).join("\n\n"),
    rendered,
  };
}

/** The text a provider returned as a summary; undefined for an error, abort, tool call or empty answer. */
export function providerSummaryText(message: AssistantMessage): string | undefined {
  try {
    if (!isRecord(message) || message.stopReason !== "stop") return undefined;
    const blocks = contentBlocks(message.content);
    if (blocks.some((block) => block.type === "toolCall")) return undefined;
    const text = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join("\n")
      .trim();
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Fence characters of the untrusted source and summary blocks. The prompt states these fences; the
 * source cannot contain them because every occurrence is neutralized first, so stored text cannot
 * close a block, open a new one, or speak as the prompt around it.
 */
const FENCE_OPEN = "\u00ab";
const FENCE_CLOSE = "\u00bb";
const FENCE_ESCAPE_OPEN = "\u2039";
const FENCE_ESCAPE_CLOSE = "\u203a";

/**
 * Neutralize the fence characters in untrusted text before it enters a prompt. Only the two fence
 * characters are rewritten, so code, shell commands, URLs and paths stay byte-exact for the model.
 */
export function escapeUntrusted(text: string): string {
  return text.split(FENCE_OPEN).join(FENCE_ESCAPE_OPEN).split(FENCE_CLOSE).join(FENCE_ESCAPE_CLOSE);
}

/** Wrap untrusted text in a fence that the text itself cannot close. */
export function fenced(kind: "transcript" | "summary", text: string): string {
  return `${FENCE_OPEN}${kind}${FENCE_CLOSE}\n${escapeUntrusted(text)}\n${FENCE_OPEN}/${kind}${FENCE_CLOSE}`;
}

/**
 * A short title for listing: the model is asked for a `Title:` line; without one the first
 * non-empty line is used with markdown markers removed.
 */
export function summaryTitle(summary: string, maxChars = 120): string | null {
  const lines = summary.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const explicit = lines.find((line) => /^title\s*:/i.test(line));
  const candidate = (explicit === undefined ? lines[0] : explicit.replace(/^title\s*:\s*/i, "")) ?? "";
  const cleaned = candidate.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}

/** One accumulating fold chunk: entries are kept whole, so a chunk can exceed the target by one entry. */
export interface OpenChunk {
  readonly [key: string]: JsonValue;
  readonly firstEntryId: number;
  readonly lastEntryId: number;
  readonly entries: number;
  readonly chars: number;
  readonly truncatedEntries: number;
}

export function openChunk(entryId: number): OpenChunk {
  return {
    firstEntryId: entryId,
    lastEntryId: entryId,
    entries: 0,
    chars: 0,
    truncatedEntries: 0,
  };
}

/** Fold one rendered entry into an open chunk. Skipped entries advance the range and count. */
export function appendToChunk(chunk: OpenChunk, entryId: number, rendered: RenderedEntry): OpenChunk {
  return {
    firstEntryId: chunk.firstEntryId,
    lastEntryId: entryId,
    entries: chunk.entries + 1,
    chars: chunk.chars + rendered.text.length,
    truncatedEntries: chunk.truncatedEntries + (rendered.truncated ? 1 : 0),
  };
}

export function chunkFull(
  chunk: OpenChunk,
  limits = EPISODE_SUMMARY_SOURCE_LIMITS,
): boolean {
  return chunk.chars >= limits.chunkChars || chunk.entries >= limits.chunkEntries;
}
