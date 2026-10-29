/**
 * Bounded rendering of one episode's committed entries into untrusted provider input.
 *
 * The transcript is source data, not instructions: everything this module produces is quoted
 * text for a summarizer prompt, and the summarizer gets no tools. Nothing here reads or writes
 * a grant, appends an entry or calls a provider.
 *
 * What is included, and what is not:
 * - `pi.user` and `nanobot.cron` entries contribute their user text.
 * - `pi.assistant` entries contribute visible text and a compact list of the tool calls they
 *   made. Thinking blocks are omitted: they are not part of the stored conversation the user
 *   saw, and replaying them can exceed the source bound.
 * - `pi.tool-result` entries contribute the tool name and a shortened result.
 * - `pi.reset` entries (including any handoff text in their model payload), `pi.system` and
 *   `pi.compaction` entries contribute nothing: they are synthetic context, and the episode's
 *   own reset marker is its boundary rather than its content. They are still counted.
 * - `entry.edits` are not applied: the summary describes the stored transcript, not the active
 *   edited model context. An entry carrying edits is otherwise rendered like any other entry.
 *
 * Every bound is explicit. A long entry is shortened with a visible marker, a full chunk stops
 * at the chunk bound, and the caller records how many entries were covered and how many were
 * truncated. Silent truncation is not a permitted outcome.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

export const EPISODE_SUMMARY_SOURCE_LIMITS = Object.freeze({
  /** Characters of rendered text kept per entry. */
  entryChars: 2_000,
  /** Target characters per fold chunk; one entry may cross it by at most `entryChars`. */
  chunkChars: 24_000,
  /** Entries visited per fold chunk, so a chunk of empty entries still terminates. */
  chunkEntries: 400,
  /** Chunks (provider folds) per episode; entries beyond it are uncovered and reported. */
  maxChunks: 12,
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
  /** Text was shortened to the per-entry bound. */
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

function shorten(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n[... ${omitted} more characters truncated]`,
    truncated: true,
  };
}

function callText(call: Record<string, unknown>): string {
  let argumentsText: string;
  try {
    argumentsText = JSON.stringify(call.arguments ?? {}) ?? "null";
  } catch {
    argumentsText = "[unserializable arguments]";
  }
  const name = typeof call.name === "string" && call.name.length > 0 ? call.name : "unknown-tool";
  if (argumentsText.length > 200) argumentsText = `${argumentsText.slice(0, 200)}…`;
  return `${name}(${argumentsText})`;
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
    const lines: string[] = [];
    for (const item of messages) {
      if (!isRecord(item) || item.role !== "toolResult") continue;
      const body = textParts(item.content).join("\n").trim();
      if (body.length === 0) continue;
      const toolName = typeof item.toolName === "string" && item.toolName.length > 0
        ? item.toolName
        : "unknown-tool";
      lines.push(`[Tool result ${toolName}]: ${body}`);
    }
    if (lines.length === 0) return { ...SKIPPED_ENTRY, toolResult: true };
    const shortened = shorten(lines.join("\n\n"), entryChars);
    return { text: shortened.text, message: false, toolResult: true, truncated: shortened.truncated };
  }
  const lines: string[] = [];
  for (const item of messages) {
    if (!isRecord(item)) continue;
    if (item.role === "user") {
      const body = textParts(item.content).join("\n").trim();
      if (body.length > 0) lines.push(`[User]: ${body}`);
      continue;
    }
    if (item.role !== "assistant") continue;
    const body = textParts(item.content).join("\n").trim();
    if (body.length > 0) lines.push(`[Assistant]: ${body}`);
    const calls = contentBlocks(item.content)
      .filter((block) => block.type === "toolCall")
      .map((block) => callText(block));
    if (calls.length > 0) lines.push(`[Assistant tool calls]: ${calls.join("; ")}`);
  }
  if (lines.length === 0) return { ...SKIPPED_ENTRY, message: true };
  const shortened = shorten(lines.join("\n\n"), entryChars);
  return {
    text: shortened.text,
    message: true,
    toolResult: false,
    truncated: shortened.truncated,
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
