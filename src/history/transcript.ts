/**
 * Canonical projection helpers for committed Durable `EntryRecord`s.
 *
 * The history index, memory-recall history source, digestion, episode-summary source and the
 * model-facing entry view all read the same stored JSON. The shared reading rules live here so
 * they cannot drift: which entry kinds carry user input, how message text is extracted, how tool
 * calls are found, how tool arguments are serialized, and how a long item is previewed.
 *
 * Each consumer keeps its own output contract (FTS documents, recall hashes and ordinals, digestion
 * offsets and call-id pairing, summary segments, display rows); these helpers only extract. Stored
 * entries are untyped JSON, so nothing here trusts a shape or throws on one.
 */
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import { WORKER_INPUT_ENTRY_KIND, WORKER_STEER_ENTRY_KIND } from "../workers/worker-task.js";

/** Plain JSON-object check for stored entry payloads (arrays and null excluded). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Entry kinds whose `user` messages are prompt input in transcript projections: ordinary user
 * entries and scheduled cron input. Worker task/steer inputs live in task-owned conversations and
 * are shown only by the entry view, under their own labels.
 */
export const USER_INPUT_ENTRY_KINDS: ReadonlySet<string> = Object.freeze(
  new Set<string>([UserEntry.kind, CRON_INPUT_ENTRY_KIND]),
);

export function isUserInputKind(kind: unknown): boolean {
  return typeof kind === "string" && USER_INPUT_ENTRY_KINDS.has(kind);
}

/** The transcript role an entry kind contributes, or undefined when it carries no transcript text. */
export type TranscriptEntryRole = "user" | "assistant" | "toolResult";

export function transcriptRoleOf(kind: unknown): TranscriptEntryRole | undefined {
  if (isUserInputKind(kind)) return "user";
  if (kind === AssistantEntry.kind) return "assistant";
  if (kind === ToolResultEntry.kind) return "toolResult";
  return undefined;
}

/** Prompt input kinds that are not `pi.user`; the label names the source, never the raw text. */
const TASK_INPUT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [CRON_INPUT_ENTRY_KIND]: "user (cron)",
  [WORKER_INPUT_ENTRY_KIND]: "user (worker task)",
  [WORKER_STEER_ENTRY_KIND]: "assistant (worker steer)",
});

/** Only own keys count: an entry kind such as "constructor" is not a known task input. */
export function taskInputLabel(kind: string): string | undefined {
  return Object.hasOwn(TASK_INPUT_LABELS, kind) ? TASK_INPUT_LABELS[kind] : undefined;
}

/** The model messages of an entry, whatever the stored shape claims. */
export function modelMessages(model: unknown): readonly unknown[] {
  return Array.isArray(model) ? model : [];
}

/**
 * Message text: a string content as is, otherwise the `text` blocks joined by `\n`, keeping empty
 * text blocks so separators stay in stored offset spaces. Undefined when content is neither a string
 * nor an array, or an array without a text block.
 */
export function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** The `toolCall` blocks of an assistant message's content, in stored order. */
export function toolCallBlocks(content: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "toolCall");
}

/** A non-empty string field, otherwise undefined. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `JSON.stringify` with explicit fallbacks: one for a value with no JSON form (`undefined`, a
 * function) and one for a value that throws (cycles, BigInt).
 */
export function jsonText(value: unknown, fallbacks: { readonly absent: string; readonly unserializable: string }): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : fallbacks.absent;
  } catch {
    return fallbacks.unserializable;
  }
}

export interface BoundedJson {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Canonical (sorted-key), bounded JSON. It stops once the output budget or depth is reached instead
 * of stringifying an arbitrarily large tree in full; `truncated` says so.
 */
export function boundedCanonicalJson(value: unknown, maxChars: number, maxDepth = 64): BoundedJson {
  let output = "";
  let truncated = false;
  const append = (text: string): boolean => {
    if (truncated) return false;
    if (output.length + text.length > maxChars) {
      output += text.slice(0, Math.max(0, maxChars - output.length));
      truncated = true;
      return false;
    }
    output += text;
    return true;
  };
  const walk = (node: unknown, depth: number): boolean => {
    if (truncated) return false;
    if (depth > maxDepth) {
      truncated = true;
      return false;
    }
    if (node === null) return append("null");
    if (typeof node === "string") {
      if (!append('"')) return false;
      let start = 0;
      while (start < node.length) {
        const remaining = Math.max(0, maxChars - output.length - 1);
        if (remaining === 0) {
          truncated = true;
          return false;
        }
        const take = Math.min(node.length - start, remaining);
        const encoded = JSON.stringify(node.slice(start, start + take)).slice(1, -1);
        if (encoded.length > remaining) {
          output += encoded.slice(0, remaining);
          truncated = true;
          return false;
        }
        output += encoded;
        start += take;
      }
      return append('"');
    }
    if (typeof node === "number" || typeof node === "boolean") return append(String(node));
    if (Array.isArray(node)) {
      if (!append("[")) return false;
      for (let index = 0; index < node.length; index++) {
        if (index > 0 && !append(",")) return false;
        if (!walk(node[index], depth + 1)) return false;
      }
      return append("]");
    }
    if (isRecord(node)) {
      if (!append("{")) return false;
      const keys = Object.keys(node).sort();
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        if (index > 0 && !append(",")) return false;
        if (!append(JSON.stringify(key))) return false;
        if (!append(":")) return false;
        if (!walk(node[key], depth + 1)) return false;
      }
      return append("}");
    }
    return append("null");
  };
  walk(value, 0);
  return { text: output, truncated };
}

/* ------------------------------------------------------------------------ */
/* Text shapes and head-tail previews                                        */
/* ------------------------------------------------------------------------ */

/** Maximum characters in one head-tail preview, including its omission marker. */
export const PREVIEW_CHARS = 2_500;

/**
 * The preview a bound too small for the reference marker degrades to. It carries neither the omitted
 * length nor the original reference, so a consumer that needs both (the episode-summary source) checks
 * for it and falls back to its own counted marker instead of quoting an unlabelled cut.
 */
export const COMPACT_PREVIEW_MARKER = "…";

export interface TextShape {
  readonly parts: readonly string[];
  /** Length of `parts.join("\n")`. */
  readonly length: number;
}

export interface TextPreview {
  readonly headChars: number;
  readonly tailChars: number;
  readonly omittedStart: number;
  readonly omittedEnd: number;
  readonly omittedChars: number;
  readonly marker: string;
}

export function joinedParts(parts: readonly string[]): TextShape {
  let length = parts.length === 0 ? 0 : parts.length - 1;
  for (const part of parts) length += part.length;
  return { parts, length };
}

/** Slice `parts.join("\n")` without materializing the join. Offsets are UTF-16 code units. */
export function evidenceSlice(shape: TextShape, from: number, to: number): string {
  let output = "";
  let offset = 0;
  for (let index = 0; index < shape.parts.length; index += 1) {
    const part = shape.parts[index]!;
    if (index > 0) {
      if (offset >= from && offset < to) output += "\n";
      offset += 1;
    }
    const partStart = offset;
    const partEnd = partStart + part.length;
    offset = partEnd;
    if (partEnd <= from || partStart >= to) continue;
    output += part.slice(Math.max(from, partStart) - partStart, Math.min(to, partEnd) - partStart);
  }
  return output;
}

/**
 * True when a fragment ending at `from + take` would split a UTF-16 surrogate pair. The boundary is
 * moved instead, so encoding the fragment as UTF-8 cannot produce a replacement character. Offsets
 * stay in UTF-16 code units, never bytes.
 */
export function cutsSurrogatePair(shape: TextShape, from: number, take: number): boolean {
  if (take <= 0) return false;
  const tail = evidenceSlice(shape, from + take - 1, from + take).charCodeAt(0);
  if (!(tail >= 0xd800 && tail <= 0xdbff)) return false;
  const next = evidenceSlice(shape, from + take, from + take + 1).charCodeAt(0);
  return next >= 0xdc00 && next <= 0xdfff;
}

/**
 * One head-tail preview of a long machine result. Both cuts are surrogate-safe: a head ending on a
 * high surrogate or a tail starting on a low surrogate is moved inward by one unit, so the preview
 * never contains half a pair. The marker names the omitted length and the original reference, so a
 * consumer can neither mistake the preview for the whole result nor claim it read the middle.
 *
 * Digestion evidence and the episode-summary source quote tool calls and results through this same
 * function, so both bounded readers show one truncation format with the same provenance.
 */
export function clipPreview(parts: readonly string[], total: number, limit: number, ref: string): {
  readonly text: string;
  readonly preview: TextPreview;
} {
  const shape = joinedParts(parts);
  const target = Math.max(1, Math.min(PREVIEW_CHARS, limit));
  const markerOf = (omitted: number): string => `\n… [${omitted} characters omitted; original at ${ref}] …\n`;
  const headTextOf = (count: number): string => {
    let end = Math.max(0, Math.min(count, total));
    if (end > 0 && end < total && cutsSurrogatePair(shape, 0, end)) end -= 1;
    return evidenceSlice(shape, 0, end);
  };
  const tailTextOf = (count: number): string => {
    let start = Math.max(0, total - Math.max(0, Math.min(count, total)));
    if (start > 0 && start < total && cutsSurrogatePair(shape, start - 1, 1)) start += 1;
    return evidenceSlice(shape, start, total);
  };
  let head = Math.max(0, Math.floor((target - 80) / 2));
  let tail = Math.max(0, target - 80 - head);
  let headText = headTextOf(head);
  let tailText = tailTextOf(tail);
  let omitted = Math.max(0, total - headText.length - tailText.length);
  let marker = markerOf(omitted);
  let size = headText.length + marker.length + tailText.length;
  // Reserve room for the marker, then give any leftover back to the head and tail. A pathological
  // bound smaller than the marker keeps a tiny visible marker rather than an empty preview.
  while (size > target && (headText.length > 0 || tailText.length > 0)) {
    const excess = size - target;
    if (tailText.length >= headText.length && tailText.length > 0) {
      tail = Math.max(0, tailText.length - excess);
      tailText = tailTextOf(tail);
    } else {
      head = Math.max(0, headText.length - excess);
      headText = headTextOf(head);
    }
    omitted = Math.max(0, total - headText.length - tailText.length);
    marker = markerOf(omitted);
    size = headText.length + marker.length + tailText.length;
  }
  if (size > target) {
    // The bound cannot hold the reference marker; keep the head bounded and say so compactly.
    const compact = COMPACT_PREVIEW_MARKER;
    headText = headTextOf(Math.max(0, target - compact.length));
    tailText = "";
    omitted = Math.max(0, total - headText.length);
    marker = compact;
  }
  return {
    text: `${headText}${marker}${tailText}`,
    preview: {
      headChars: headText.length,
      tailChars: tailText.length,
      omittedStart: headText.length,
      omittedEnd: total - tailText.length,
      omittedChars: omitted,
      marker,
    },
  };
}
