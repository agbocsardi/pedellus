/**
 * Shared bounded entry rendering for the model-facing `history` and `worker` tools.
 *
 * Both tools read native committed Durable entries and show a bounded, quoted view of them. The
 * display rules live here so the two surfaces agree on sanitization, truncation markers and the
 * overall byte budget instead of drifting apart. Entry text is hostile-capable data: it is
 * control/bidi sanitized, JSON-string quoted, and cut at a character bound with an explicit
 * `[truncated]` marker.
 *
 * The formatter knows the built-in user-facing input kinds (`pi.user`, cron and worker task
 * prompts); everything else that carries no displayable message/tool text is omitted by the caller.
 */
import { Buffer } from "node:buffer";
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import { WORKER_INPUT_ENTRY_KIND } from "../workers/worker-task.js";

export type EntryScope = "messages" | "tools" | "all";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Strip controls that can hide or spoof text; keep newline/tab for quoting. */
export function sanitizeHistoryText(value: string): string {
  const cleaned = value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g,
    "",
  );
  let result = "";
  for (let index = 0; index < cleaned.length; index++) {
    const code = cleaned.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(cleaned.charCodeAt(index + 1))) result += cleaned[index]! + cleaned[++index]!;
      else result += "\ufffd";
    } else if (isLowSurrogate(code)) result += "\ufffd";
    else result += cleaned[index]!;
  }
  return result;
}

export function clampCodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end--;
  return value.slice(0, end);
}

/** Clamp to a UTF-8 byte budget without splitting a surrogate pair. */
export function clampUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** A bounded, quoted field. JSON escaping keeps newlines and quotes inside the value. */
export function quoted(value: string, max: number): string {
  const clean = sanitizeHistoryText(value);
  const bounded = clampCodeUnits(clean, max);
  const encoded = JSON.stringify(bounded)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `${encoded}${bounded.length < clean.length ? " [truncated]" : ""}`;
}

/** One-line label text: controls removed and all whitespace collapsed, never quoted. */
export function plainLabel(value: string): string {
  return sanitizeHistoryText(value).replace(/\s+/gu, " ").trim();
}

export function label(value: string, max = 160): string {
  return quoted(plainLabel(value), max);
}

export function boundedJson(value: unknown, max: number): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "undefined" : quoted(json, max);
  } catch {
    return "\"(unserializable)\"";
  }
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const part = block as { readonly type?: unknown; readonly text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/** User-facing input kinds that are ordinary task prompts, not `pi.user`. */
const TASK_INPUT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [CRON_INPUT_ENTRY_KIND]: "user (cron)",
  [WORKER_INPUT_ENTRY_KIND]: "user (worker task)",
});

/** Only own keys count: an entry kind such as "constructor" is not a known task input. */
function taskInputLabel(kind: string): string | undefined {
  return Object.hasOwn(TASK_INPUT_KINDS, kind) ? TASK_INPUT_KINDS[kind] : undefined;
}

export interface BoundedRenderLimits {
  /** Hard output byte budget, below the tool's own output limiter. */
  readonly outputBytes: number;
  /** Bytes reserved so a row-omission note always fits after the mandatory footer. */
  readonly reserveBytes: number;
  /** Bytes reserved for the caller's actual displayed/omitted row count line. */
  readonly countReserveBytes: number;
  /** Appended to a header that had to be cut by the byte bound. */
  readonly headerMarker: string;
}

export interface BoundedRender {
  readonly text: string;
  readonly shownRows: number;
  readonly omittedRows: number;
}

export function renderBoundedInfo(
  header: readonly string[],
  footer: readonly string[],
  rows: readonly string[],
  limits: BoundedRenderLimits,
  counts?: (shown: number, omitted: number) => string,
): BoundedRender {
  const max = limits.outputBytes;
  const reserve = limits.reserveBytes;
  const countReserve = counts === undefined ? 0 : limits.countReserveBytes;
  // The footer carries coverage, the continuation cursor and mandatory notices. It is
  // never dropped or truncated: fit the header and rows around its exact UTF-8 size.
  // A caller-supplied count line is reserved separately so it can describe the rows that
  // survived byte culling instead of claiming every selected row was displayed.
  const footerText = footer.join("\n");
  const footerBytes = Buffer.byteLength(footerText, "utf8");
  if (footerBytes + countReserve > max) {
    return { text: footerText, shownRows: 0, omittedRows: rows.length };
  }
  const headerBudget = Math.max(0, max - footerBytes - countReserve - reserve - 2);
  const headerMarker = limits.headerMarker;
  const headerMarkerBytes = Buffer.byteLength(headerMarker, "utf8");
  let headerText = header.join("\n");
  if (Buffer.byteLength(headerText, "utf8") > headerBudget) {
    headerText = headerBudget <= headerMarkerBytes
      ? ""
      : `${clampUtf8(headerText, headerBudget - headerMarkerBytes)}${headerMarker}`;
  }
  let used = Buffer.byteLength(headerText, "utf8") + 1 + footerBytes + countReserve;
  const visible: string[] = [];
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row, "utf8") + (visible.length === 0 ? 2 : 1);
    if (used + rowBytes > max - reserve) break;
    visible.push(row);
    used += rowBytes;
  }
  const lines = headerText.length === 0 ? [footerText] : [headerText, footerText];
  const omitted = rows.length - visible.length;
  if (counts !== undefined) {
    const countText = clampUtf8(counts(visible.length, omitted), Math.max(0, countReserve - 2));
    if (countText.length > 0) lines.push(countText);
  }
  if (visible.length > 0) lines.push("", ...visible);
  if (omitted > 0) {
    lines.push(`[${omitted} additional record(s) omitted by the tool output bound; lower the limit or narrow the scope.]`);
  }
  return { text: lines.join("\n"), shownRows: visible.length, omittedRows: omitted };
}

export function isToolOmittedEntry(entry: EntryRecord, scope: EntryScope): boolean {
  if (scope !== "messages") return false;
  if (ToolResultEntry.is(entry)) return true;
  if (!AssistantEntry.is(entry) || !Array.isArray(entry.model)) return false;
  return entry.model.some((message) =>
    message !== null && typeof message === "object" && Array.isArray((message as { readonly content?: unknown }).content) &&
    ((message as { readonly content: readonly unknown[] }).content).some((block) =>
      block !== null && typeof block === "object" && (block as { readonly type?: unknown }).type === "toolCall"));
}

export interface BrowsedEntry {
  readonly id: EntryRecord["id"];
  readonly label: string;
  readonly text: string;
  readonly edits: boolean;
}

/** Extract only displayable message/tool text; system, reset, compaction and images are omitted. */
export function browsedEntry(
  entry: EntryRecord,
  scope: EntryScope,
  toolArgumentChars: number,
): BrowsedEntry | undefined {
  let labelText: string | undefined;
  const parts: string[] = [];
  const messages = Array.isArray(entry.model) ? entry.model : [];
  const taskLabel = taskInputLabel(entry.kind);
  if ((entry.kind === UserEntry.kind || taskLabel !== undefined) && scope !== "tools") {
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object" || (raw as { readonly role?: unknown }).role !== "user") continue;
      const text = messageText((raw as { readonly content?: unknown }).content);
      if (text.trim().length > 0) parts.push(text);
    }
    labelText = taskLabel ?? "user";
  } else if (AssistantEntry.is(entry)) {
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object" || (raw as { readonly role?: unknown }).role !== "assistant") continue;
      const content = (raw as { readonly content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const part = block as { readonly type?: unknown; readonly text?: unknown; readonly name?: unknown; readonly arguments?: unknown };
        if (part.type === "text" && typeof part.text === "string" && (scope === "messages" || scope === "all")) {
          parts.push(part.text);
        } else if (part.type === "toolCall" && typeof part.name === "string" && (scope === "tools" || scope === "all")) {
          parts.push(`[tool call ${sanitizeHistoryText(part.name)} ${boundedJson(part.arguments, toolArgumentChars)}]`);
        }
      }
    }
    labelText = "assistant";
  } else if (ToolResultEntry.is(entry) && (scope === "tools" || scope === "all")) {
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object" || (raw as { readonly role?: unknown }).role !== "toolResult") continue;
      const content = (raw as { readonly content?: unknown }).content;
      const text = messageText(content);
      if (text.trim().length > 0) parts.push(text);
    }
    const first = messages.find((raw) =>
      raw !== null && typeof raw === "object" && (raw as { readonly role?: unknown }).role === "toolResult");
    const toolName = first !== null && typeof first === "object" && typeof (first as { readonly toolName?: unknown }).toolName === "string"
      ? (first as { readonly toolName: string }).toolName
      : "tool";
    labelText = `tool ${clampCodeUnits(plainLabel(toolName), 80)}`;
  }
  if (labelText === undefined) return undefined;
  const text = parts.join("\n").trim();
  if (text.length === 0) return undefined;
  return {
    id: entry.id,
    label: labelText,
    text,
    edits: entry.edits !== undefined,
  };
}

export interface EntryRowOptions {
  readonly selected?: boolean;
  readonly kind?: string;
  readonly entryChars: number;
}

/** One entry row: bounded label/kind metadata and a quoted, explicitly truncated body. */
export function entryRow(entry: BrowsedEntry, options: EntryRowOptions): string {
  const flags: string[] = [];
  if (options.selected === true) flags.push("selected");
  if (entry.edits) flags.push("raw stored entry; context edits not applied");
  const kind = options.kind === undefined ? "" : ` kind=${clampCodeUnits(plainLabel(options.kind), 60)}`;
  return [
    `#${entry.id} [${clampCodeUnits(plainLabel(entry.label), 100)}]${kind}` +
      `${flags.length === 0 ? "" : ` (${flags.join("; ")})`}`,
    `  text=${quoted(entry.text, options.entryChars)}`,
  ].join("\n");
}
