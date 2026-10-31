/**
 * Complementary background-memory evidence and its completed-turn cursor.
 *
 * This is the planned single evidence source for `memory-digest`. When the consumer integration
 * lands, it replaces the closed-episode reader in `./digestion.ts` for that command instead of
 * running beside it; until then the closed-episode reader remains the only active consumer. The two
 * sources keep separate durable cursors, so this source never moves the active frontier. It reads
 * only, calls no model, writes no memory and schedules nothing. `read()` returns
 * one bounded chunk of one completed segment from one host-authenticated mapped chat conversation.
 * `acknowledge()` moves that conversation's cursor after the consumer has settled the chunk. A read
 * that is never acknowledged advances nothing, so a failure or restart replays the same evidence.
 *
 * Trust contract (the host remains the authorization boundary):
 * - The host passes the same currently mapped chat sessions its provider already authenticated and
 *   classified. This module validates only shape errors (empty/channel-state key, invalid or repeated
 *   conversation, too many mappings) and never re-derives root, fork, task or worker ownership.
 * - Owner messages and scheduled triggers are `owner` evidence; assistant message text is
 *   `assistant` evidence. Assistant tool calls and their paired tool results are always labeled
 *   `untrusted-tool`: they are machine text, never instructions and never attributed to the owner.
 * - Reset handoff messages, system entries, compaction entries, assistant thinking parts and tool
 *   results with no paired call are consumed as part of the range but contribute no evidence.
 * - A tool result is paired only with a call id that is still open in the same segment. Pairing state
 *   is durable in the cursor, so a result in a later chunk is paired even after a reopen. An orphan
 *   result is consumed with no fragment instead of being presented as if the owner or assistant
 *   said it. A call id longer than the fixed bound fails the segment closed; dropping it would
 *   silently lose the result that cites the same id.
 *
 * Eligibility and high-water:
 * - A segment starts at the cursor's next entry and ends only at a completed exchange boundary:
 *   just before a reset that follows an owner/cron turn, just before the next owner/cron input, or
 *   at a terminal assistant entry whose tool calls are all paired. An assistant entry that stopped
 *   with an explicit error or abort is not a completed answer and cannot close a segment by itself.
 *   A reset before the first owner
 *   input is part of the consumed prefix, so a leading system/reset block does not need a separate
 *   model-free batch. An in-progress tail (an owner message still awaiting an answer, an assistant
 *   tool round, or a tool result still awaiting the next assistant entry) is never offered. One read
 *   increments the high-water only through evidence that was already a completed exchange when the
 *   read began; newly appended entries are a later segment.
 * - A completed exchange may contain several owner/assistant turns. A segment over a bound is split
 *   into ordered lossless chunks with immutable bounds; a chunk continuation is the same evidence at
 *   the same offsets, and the completed boundary itself never moves. There is no carry-over summary,
 *   running state or cross-chunk note.
 *
 * Evidence shape:
 * - Message prose and tool-call arguments are lossless fragments of the original entry (UTF-16
 *   offsets, surrogate-safe). A long item continues in the next chunk from exactly where the last
 *   chunk stopped.
 * - A tool result is bounded machine output. Text that fits the preview bound is included whole; a
 *   longer result is one head-tail preview of at most {@link COMPLEMENTARY_PREVIEW_CHARS} characters
 *   with an explicit omission marker and a stable reference. The preview is not a fragment of a
 *   longer item: it is consumed whole. The original entry stays authoritative in Durable.
 * - Every evidence record names its durable entry, its stable item reference, its trust label, its
 *   total extracted length and, for a fragmented item, its start offset. A preview additionally
 *   names the omitted range. A consumer can cite the original transcript without a second archive.
 *
 * Bounds and failure:
 * - Every read is paged. Discovery is bounded by {@link COMPLEMENTARY_LIMITS.scanEntriesPerRead};
 *   a long still-open segment resumes from a derived in-process scan cache instead of rescanning
 *   from its beginning. Acknowledgement re-derives exactly the claimed chunk from the committed
 *   transcript; a forged, stale or out-of-range batch is rejected instead of moving the cursor.
 * - A fresh segment that starts after the cursor frontier must have no same-conversation entry in
 *   the skipped gap. Entry IDs are global and interleave other chats, so a zero-entry gap within
 *   this conversation is normal; an entry in it is refused rather than silently skipped.
 * - A conversation with an existing closed-episode cursor but no complementary cursor derives its
 *   first complementary position from that cursor on read, and freezes it on the first
 *   acknowledgement. The handoff resumes at that cursor's exact acknowledged entry and message
 *   offset, so a range another reader already digested is never processed twice; tool steps after
 *   that offset in the same entry were never digested and are still read, and a frozen legacy
 *   episode's bounds are continued so its remainder needs no new owner turn. The closed-episode
 *   document is never written or moved.
 * - A pathologically shaped entry (more evidence items, more open calls, or a longer tool call id
 *   than the fixed internal safety caps) fails with a fixed error instead of silently dropping
 *   evidence. This is a bound, not a retry loop.
 *
 * Not here: model calls, prompt rendering, memory writes, scheduling, activation, and any outcome or
 * notification path. A chunk with no evidence is still an acknowledgeable no-op, so a consumer can
 * advance it without a provider call.
 */
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  defineDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import {
  DIGEST_ENTRIES_PER_BATCH_MIN,
  DIGEST_CHARS_PER_BATCH_MIN,
  DIGEST_RUN_LIMITS_DEFAULT,
  isDigestCharsBound,
  isDigestEntriesBound,
  type DigestBatchLimits,
} from "./digest-limits.js";
import {
  DIGEST_LIMITS,
  DigestCursorDoc,
  cutsSurrogatePair,
  digestCursorOf,
  evidenceShapeOf,
  evidenceSlice,
  messageText,
  validateSessions,
  type DigestCursor,
  type EvidenceShape,
  type TextShape,
} from "./digestion.js";
import type { HistoryChatSession } from "./scope.js";

export const COMPLEMENTARY_CURSOR_KIND = "nanobot.complementary-digest-cursor";

/** Maximum characters in one head-tail tool-result preview, including its omission marker. */
export const COMPLEMENTARY_PREVIEW_CHARS = 2_500;

export const COMPLEMENTARY_LIMITS = Object.freeze({
  /** Entries requested per Durable page. */
  entriesPerPage: DIGEST_LIMITS.entriesPerPage,
  /** Entries one read may examine while looking for a completed segment. */
  scanEntriesPerRead: DIGEST_LIMITS.scanEntriesPerRead,
  /** Mapped chat sessions accepted by one read. */
  maxMappedSessions: DIGEST_LIMITS.maxMappedSessions,
  /** Evidence steps (messages, calls, results and silent pairing steps) in one chunk. */
  maxStepsPerBatch: 2_048,
  /** Evidence steps in one entry before the entry fails closed rather than growing without bound. */
  maxStepsPerEntry: 1_024,
  /** Calls that may still be open in one segment before the segment fails closed. */
  maxPendingToolCalls: 256,
  /** Longest accepted tool call id; a longer id fails the segment instead of orphaning its result. */
  maxToolCallIdChars: 200,
  /** Smallest remaining budget that may render a preview instead of ending the chunk first. */
  minPreviewBudget: 8,
});

/** Resume position plus the immutable bounds and pairing state of the segment in progress. */
export interface ComplementaryCursor {
  /** Next unconsumed entry, or null before the conversation's first entry. */
  readonly nextEntryId: EntryId | null;
  /** Next evidence step in that entry; 0 when the entry has not been entered yet. */
  readonly nextItemIndex: number;
  /** Offset inside that step's extracted text; 0 for a whole step. */
  readonly nextTextStart: number;
  /** Start of the completed segment being consumed in chunks, otherwise null. */
  readonly segmentStartEntryId: EntryId | null;
  /** End of that completed segment, otherwise null. */
  readonly segmentEndEntryId: EntryId | null;
  /**
   * Tool call ids still open at this position. Usually empty outside a segment; a settled
   * bounds-free legacy adoption can carry calls at its frontier until the first acknowledgement
   * freezes the new segment.
   */
  readonly pendingToolCalls: readonly string[];
}

export type ComplementaryTrust = "owner" | "assistant" | "untrusted-tool";
export type ComplementaryItemKind = "message" | "tool-call" | "tool-result";

/** Stable, content-independent location of one evidence step. */
export interface ComplementaryPreview {
  readonly headChars: number;
  readonly tailChars: number;
  readonly omittedStart: number;
  readonly omittedEnd: number;
  readonly omittedChars: number;
  readonly marker: string;
}

/** One bounded evidence fragment or preview. */
export interface ComplementaryEvidence {
  readonly entryId: EntryId;
  /** Step index within the entry's evidence plan; stable for this extraction version. */
  readonly itemIndex: number;
  readonly role: "user" | "assistant" | "tool";
  readonly trust: ComplementaryTrust;
  /** Fixed human label; a renderer may use it verbatim. */
  readonly trustLabel: string;
  readonly itemKind: ComplementaryItemKind;
  /** Durable entry kind, for provenance. */
  readonly kind: string;
  /** Stable reference to the original item inside Durable. */
  readonly ref: string;
  /** Tool call id for a tool call and its paired result. */
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  /** Offset of `text` within the item's extracted text. A preview always starts at 0. */
  readonly textStart: number;
  /** Total extracted item length before any bound. */
  readonly chars: number;
  /** Fragment text, or a bounded preview of the whole item. */
  readonly text: string;
  /** Present only when `text` is a head-tail preview with an omitted middle. */
  readonly preview: ComplementaryPreview | null;
}

/** One bounded chunk of one completed segment. */
export interface ComplementaryBatch {
  readonly status: "batch";
  /** Mapped chat session that owns the conversation; the source label for the batch. */
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  /** Immutable bounds of the completed segment these entries belong to. */
  readonly segmentStartEntryId: EntryId;
  readonly segmentEndEntryId: EntryId;
  /** Lower bound of this chunk. */
  readonly firstEntryId: EntryId;
  readonly firstItemIndex: number;
  readonly firstTextStart: number;
  /** Last step consumed by this chunk; `itemIndex` is -1 when the last entry had no steps. */
  readonly throughEntryId: EntryId;
  readonly throughItemIndex: number;
  readonly throughChars: number;
  /** True when this chunk reaches the segment end and consumed it completely. */
  readonly complete: boolean;
  /** The completed-turn high-water this read was cut against. */
  readonly highWaterEntryId: EntryId;
  readonly entries: readonly ComplementaryEvidence[];
  /** Resume frontier this batch was read against; acknowledging rejects if it has moved. */
  readonly cursor: ComplementaryCursor;
}

/** Nothing to consume, with unambiguous scan coverage. */
export interface ComplementaryIdle {
  readonly status: "idle";
  /** True only when every mapped chat was examined to its current tail. */
  readonly caughtUp: boolean;
  readonly examinedChats: number;
  readonly postponedChats: number;
  readonly unfinishedChats: number;
  readonly missingChats: number;
  /** Chats examined to their tail whose final exchange is still in progress. */
  readonly openChats: number;
}

export type ComplementaryReadResult = ComplementaryBatch | ComplementaryIdle;

/** The durable identity of one chunk, without its evidence text. */
export interface ComplementaryBatchRef {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  readonly segmentStartEntryId: EntryId;
  readonly segmentEndEntryId: EntryId;
  readonly firstEntryId: EntryId;
  readonly firstItemIndex: number;
  readonly firstTextStart: number;
  readonly throughEntryId: EntryId;
  readonly throughItemIndex: number;
  readonly throughChars: number;
  readonly complete: boolean;
  readonly cursor: ComplementaryCursor;
}

export class ComplementaryCursorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplementaryCursorConflictError";
  }
}

export interface ComplementarySourceOptions {
  readonly harness: Harness;
  /** Currently mapped chat sessions, already authenticated and classified by the host. */
  readonly sessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  /** Accepted bounds for new chunks. Absent keeps {@link DIGEST_RUN_LIMITS_DEFAULT}. */
  readonly limits?: DigestBatchLimits;
}

export interface ComplementarySource {
  cursor(conversationId: ConversationId, context: Context): Promise<ComplementaryCursor>;
  read(context: Context, limits?: DigestBatchLimits): Promise<ComplementaryReadResult>;
  readBatch(ref: ComplementaryBatchRef, context: Context, limits?: DigestBatchLimits): Promise<ComplementaryBatch>;
  acknowledge(batch: ComplementaryBatch, context: Context, limits?: DigestBatchLimits): Promise<ComplementaryCursor>;
}

type ComplementaryCursorDocument = {
  nextEntryId: number | null;
  nextItemIndex: number;
  nextTextStart: number;
  segmentStartEntryId: number | null;
  segmentEndEntryId: number | null;
  pendingToolCalls: string[];
};

export const ComplementaryCursorDoc = defineDoc<ComplementaryCursorDocument>({
  kind: COMPLEMENTARY_CURSOR_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    nextEntryId: null,
    nextItemIndex: 0,
    nextTextStart: 0,
    segmentStartEntryId: null,
    segmentEndEntryId: null,
    pendingToolCalls: [],
  }),
  checkpointWhen: () => true,
});

const EMPTY_CURSOR: ComplementaryCursor = Object.freeze({
  nextEntryId: null,
  nextItemIndex: 0,
  nextTextStart: 0,
  segmentStartEntryId: null,
  segmentEndEntryId: null,
  pendingToolCalls: Object.freeze([]) as readonly string[],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown, field: string): EntryId {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive entry ID`);
  }
  return value as EntryId;
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function storedId(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Stored complementary cursor has an invalid ${field}`);
  }
  return value;
}

function storedNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored complementary cursor has an invalid ${field}`);
  }
  return value;
}

function pendingOf(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]) as readonly string[];
  if (!Array.isArray(value)) throw new Error("Stored complementary cursor has invalid pending calls");
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > COMPLEMENTARY_LIMITS.maxToolCallIdChars) {
      throw new Error("Stored complementary cursor has an invalid pending call id");
    }
    if (seen.has(item)) throw new Error("Stored complementary cursor repeats a pending call id");
    seen.add(item);
    pending.push(item);
  }
  if (pending.length > COMPLEMENTARY_LIMITS.maxPendingToolCalls) {
    throw new Error("Stored complementary cursor has too many pending calls");
  }
  return Object.freeze(pending);
}

function cursorOf(document: unknown): ComplementaryCursor {
  if (document === undefined) return EMPTY_CURSOR;
  if (!isRecord(document)) throw new Error("Stored complementary cursor is malformed");
  const nextEntryId = storedId(document.nextEntryId, "next entry");
  const nextItemIndex = storedNonNegative(document.nextItemIndex, "next item");
  const nextTextStart = storedNonNegative(document.nextTextStart, "next offset");
  const segmentStartEntryId = storedId(document.segmentStartEntryId, "segment start");
  const segmentEndEntryId = storedId(document.segmentEndEntryId, "segment end");
  const pendingToolCalls = pendingOf(document.pendingToolCalls);
  if ((segmentStartEntryId === null) !== (segmentEndEntryId === null)) {
    throw new Error("Stored complementary cursor has half a segment boundary");
  }
  if (segmentStartEntryId !== null && segmentEndEntryId !== null) {
    if (segmentStartEntryId > segmentEndEntryId) {
      throw new Error("Stored complementary cursor has an inverted segment boundary");
    }
    if (nextEntryId === null || nextEntryId > segmentEndEntryId) {
      throw new Error("Stored complementary cursor is outside its segment");
    }
  } else if (nextEntryId === null) {
    if (nextItemIndex !== 0 || nextTextStart !== 0) {
      throw new Error("Stored complementary cursor has a position before the first entry");
    }
  } else if (nextItemIndex !== 0 || nextTextStart !== 0) {
    throw new Error("Stored complementary cursor has a position outside a segment");
  }
  return {
    nextEntryId: nextEntryId as EntryId | null,
    nextItemIndex,
    nextTextStart,
    segmentStartEntryId: segmentStartEntryId as EntryId | null,
    segmentEndEntryId: segmentEndEntryId as EntryId | null,
    pendingToolCalls,
  };
}

function sameCursor(left: ComplementaryCursor, right: ComplementaryCursor): boolean {
  return left.nextEntryId === right.nextEntryId
    && left.nextItemIndex === right.nextItemIndex
    && left.nextTextStart === right.nextTextStart
    && left.segmentStartEntryId === right.segmentStartEntryId
    && left.segmentEndEntryId === right.segmentEndEntryId
    && left.pendingToolCalls.length === right.pendingToolCalls.length
    && left.pendingToolCalls.every((id, index) => right.pendingToolCalls[index] === id);
}

function sameLegacyCursor(left: DigestCursor, right: DigestCursor): boolean {
  return left.throughEntryId === right.throughEntryId
    && left.throughChars === right.throughChars
    && left.episodeStartEntryId === right.episodeStartEntryId
    && left.episodeEndEntryId === right.episodeEndEntryId;
}

/**
 * Initial position for a conversation that already has a closed-episode cursor but no
 * complementary cursor yet. The handoff resumes at that cursor's exact acknowledged entry and
 * message offset: the closed-episode reader consumed message text only, which is this source's
 * first evidence step for a user/assistant entry, so already digested text is not processed again.
 * Any tool step of that entry follows the acknowledged message offset and was never digested here,
 * so it is still read; tool evidence before the frontier is not revisited, so no range is digested
 * twice.
 *
 * A tool result at or after the frontier may belong to a call before it. The complementary cursor
 * therefore carries the calls still open at the frontier, derived from the immutable legacy episode
 * prefix (for a settled bounds-free cursor, from the nearest preceding reset). Without that state
 * the result would look unpaired and its text would be dropped permanently, because the prefix is
 * never revisited. The prefix walk is bounded by {@link COMPLEMENTARY_LIMITS.scanEntriesPerRead};
 * a longer prefix fails adoption closed instead of guessing.
 *
 * When the legacy run stopped inside a closed episode, its frozen episode bounds are adopted too, so
 * the unprocessed remainder of that exchange is consumed as this source's current segment without
 * waiting for a new owner turn. The episode was already closed in the transcript, so its bounds are
 * a legitimate segment for this reader as well.
 *
 * This is derived on read and frozen by the first acknowledgement; it never writes or moves the
 * closed-episode cursor.
 */
async function adoptDigestCursor(
  legacy: DigestCursor,
  conversation: Conversation,
  context: Context,
): Promise<ComplementaryCursor> {
  if (legacy.throughEntryId === null || legacy.throughChars === null) return EMPTY_CURSOR;
  const nextEntryId = legacy.throughEntryId;
  const nextTextStart = legacy.throughChars;
  await validateAdoptedFrontier(conversation, nextEntryId, nextTextStart, context);
  const pendingToolCalls = await pendingCallsBefore(conversation, legacy, nextEntryId, context);
  return {
    nextEntryId,
    nextItemIndex: 0,
    nextTextStart,
    segmentStartEntryId: legacy.episodeStartEntryId,
    segmentEndEntryId: legacy.episodeEndEntryId,
    pendingToolCalls,
  };
}

/**
 * Check that the legacy frontier maps onto the same extracted text this reader will slice. The
 * offset was produced by {@link evidenceShapeOf}; an empty text block keeps its separator there, and
 * an offset that is beyond the entry or inside a surrogate pair cannot be mapped safely. Refuse
 * instead of skipping or splitting characters.
 */
async function validateAdoptedFrontier(
  conversation: Conversation,
  throughEntryId: EntryId,
  throughChars: number,
  context: Context,
): Promise<void> {
  const entry = await entryAt(conversation, throughEntryId, context);
  if (entry === undefined) {
    throw new Error(
      `Legacy digest frontier entry ${throughEntryId} is not committed; refusing to adopt its offset`,
    );
  }
  const shape = evidenceShapeOf(entry);
  if (shape === undefined) {
    if (throughChars !== 0) {
      throw new Error(
        `Legacy digest frontier entry ${throughEntryId} has no message evidence, so offset ` +
        `${throughChars} cannot be mapped; refusing to adopt it`,
      );
    }
    return;
  }
  if (throughChars > shape.length) {
    throw new Error(
      `Legacy digest frontier offset ${throughChars} is beyond entry ${throughEntryId}'s ` +
      `${shape.length} extracted characters; refusing to adopt it`,
    );
  }
  if (throughChars > 0 && throughChars < shape.length && cutsSurrogatePair(shape, throughChars - 1, 1)) {
    throw new Error(
      `Legacy digest frontier offset ${throughChars} splits a surrogate pair in entry ` +
      `${throughEntryId}; refusing to adopt it`,
    );
  }
}

/** Start of the legacy episode prefix that ends just before the adopted frontier entry. */
async function legacyPrefixStart(
  conversation: Conversation,
  legacy: DigestCursor,
  throughEntryId: EntryId,
  context: Context,
): Promise<EntryId> {
  if (legacy.episodeStartEntryId !== null) return legacy.episodeStartEntryId;
  // A settled legacy cursor clears its episode bounds. The reset that closed that episode is still
  // in the immutable transcript, and open calls cannot survive a reset, so none is needed from
  // before it.
  const page = await conversation.entries(
    { order: "descending", maxEntryId: throughEntryId },
    COMPLEMENTARY_LIMITS.scanEntriesPerRead,
    undefined,
    context,
  );
  const reset = page.items.find((entry) => entry.kind === ResetEntry.kind);
  if (reset !== undefined) return reset.id;
  if (page.next !== undefined) {
    throw new Error(
      `Legacy digest frontier at entry ${throughEntryId} is more than ` +
      `${COMPLEMENTARY_LIMITS.scanEntriesPerRead} entries from a reset; refusing to adopt it ` +
      `without its open tool calls`,
    );
  }
  return 1 as EntryId;
}

/**
 * Open tool calls at the legacy frontier, derived by replaying pairing effects over the prefix that
 * the closed-episode reader already consumed. The frontier entry itself is excluded: its tool steps
 * follow the acknowledged message offset and are still this reader's evidence. A prefix longer than
 * the scan bound fails closed rather than silently orphaning a later result.
 */
async function pendingCallsBefore(
  conversation: Conversation,
  legacy: DigestCursor,
  throughEntryId: EntryId,
  context: Context,
): Promise<readonly string[]> {
  const start = await legacyPrefixStart(conversation, legacy, throughEntryId, context);
  if (start >= throughEntryId) return Object.freeze([]) as readonly string[];
  const pending = new Set<string>();
  let remaining = COMPLEMENTARY_LIMITS.scanEntriesPerRead;
  let cursor: Cursor | undefined;
  const maxEntryId = (throughEntryId - 1) as EntryId;
  while (remaining > 0) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: start, maxEntryId },
      Math.min(COMPLEMENTARY_LIMITS.entriesPerPage, remaining),
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      const plan = planOf(entry, pending);
      for (const step of plan.steps) {
        if (step.effect === undefined) continue;
        if (step.effect.add) pending.add(step.effect.callId);
        else pending.delete(step.effect.callId);
      }
    }
    remaining -= page.items.length;
    cursor = page.next;
    if (cursor === undefined) break;
  }
  if (remaining <= 0) {
    throw new Error(
      `Legacy digest frontier at entry ${throughEntryId} is more than ` +
      `${COMPLEMENTARY_LIMITS.scanEntriesPerRead} entries after its episode start; refusing to ` +
      `adopt it without its open tool calls`,
    );
  }
  return Object.freeze([...pending].sort());
}

interface RawItem {
  readonly ref: string;
  readonly role: "user" | "assistant" | "tool";
  readonly trust: ComplementaryTrust;
  readonly trustLabel: string;
  readonly itemKind: ComplementaryItemKind;
  readonly kind: string;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly parts: readonly string[];
  readonly length: number;
  readonly preview: boolean;
}

interface PlanStep {
  /** Absent for a silent pairing step, such as a paired tool result with no text. */
  readonly item?: RawItem;
  readonly effect?: { readonly callId: string; readonly add: boolean };
}

interface EvidencePlan {
  readonly steps: readonly PlanStep[];
}

function textParts(content: unknown): readonly string[] | undefined {
  if (typeof content === "string") return content.length === 0 ? undefined : [content];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.length === 0 ? undefined : parts;
}

function joinedParts(parts: readonly string[]): TextShape {
  let length = parts.length === 0 ? 0 : parts.length - 1;
  for (const part of parts) length += part.length;
  return { parts, length };
}

function canonicalArguments(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    return typeof text === "string" ? text : "null";
  } catch {
    return "[unserializable arguments]";
  }
}

/**
 * Pairing id of one tool call. An absent or non-string id cannot be paired and stays unpaired. An id
 * longer than {@link COMPLEMENTARY_LIMITS.maxToolCallIdChars} fails closed: truncating or dropping
 * it would silently orphan the result that carries the same id, so the segment is refused instead.
 */
function callIdOf(value: unknown, entryId: EntryId): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > COMPLEMENTARY_LIMITS.maxToolCallIdChars) {
    throw new Error(
      `Complementary digest entry ${entryId} has a tool call id longer than ` +
      `${COMPLEMENTARY_LIMITS.maxToolCallIdChars} characters`,
    );
  }
  return value;
}

/**
 * Evidence plan of one entry. Tool results are paired against the durable open-call set; a silent
 * step consumes a paired result that has no text without emitting a fragment.
 */
function planOf(entry: EntryRecord, pending: ReadonlySet<string>): EvidencePlan {
  const kind = entry.kind;
  const steps: PlanStep[] = [];
  const open = new Set(pending);
  const add = (step: PlanStep): void => {
    if (steps.length >= COMPLEMENTARY_LIMITS.maxStepsPerEntry) {
      throw new Error(
        `Complementary digest entry ${entry.id} has more than ${COMPLEMENTARY_LIMITS.maxStepsPerEntry} evidence steps`,
      );
    }
    steps.push(step);
    if (step.effect !== undefined) {
      if (step.effect.add) {
        if (!open.has(step.effect.callId) && open.size >= COMPLEMENTARY_LIMITS.maxPendingToolCalls) {
          throw new Error(
            `Complementary digest segment has more than ${COMPLEMENTARY_LIMITS.maxPendingToolCalls} open tool calls`,
          );
        }
        open.add(step.effect.callId);
      } else {
        open.delete(step.effect.callId);
      }
    }
  };
  const messageItem = (role: "user" | "assistant", parts: readonly string[]): RawItem => ({
    ref: `entry:${entry.id}/${role === "user" ? "message" : "reply"}`,
    role,
    trust: role === "user" ? "owner" : "assistant",
    trustLabel: role === "user"
      ? (kind === CRON_INPUT_ENTRY_KIND ? "scheduled trigger (untrusted data)" : "owner message")
      : "assistant reply",
    itemKind: "message",
    kind,
    toolCallId: null,
    toolName: null,
    parts,
    length: joinedParts(parts).length,
    preview: false,
  });

  if (kind === UserEntry.kind || kind === CRON_INPUT_ENTRY_KIND) {
    const parts: string[] = [];
    for (const raw of (entry.model ?? []) as readonly unknown[]) {
      if (!isRecord(raw) || raw.role !== "user") continue;
      const text = messageText(raw.content);
      if (text === undefined || text.trim().length === 0) continue;
      parts.push(text);
    }
    if (parts.length > 0) {
      add({ item: messageItem("user", parts) });
    }
    return { steps };
  }

  if (kind === AssistantEntry.kind) {
    const parts: string[] = [];
    const calls: { id: string | null; name: string; args: unknown; index: number }[] = [];
    for (const raw of (entry.model ?? []) as readonly unknown[]) {
      if (!isRecord(raw) || raw.role !== "assistant") continue;
      const text = messageText(raw.content);
      if (text !== undefined && text.trim().length > 0) parts.push(text);
      if (!Array.isArray(raw.content)) continue;
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
        if (calls.length >= COMPLEMENTARY_LIMITS.maxStepsPerEntry) {
          throw new Error(
            `Complementary digest entry ${entry.id} has more than ` +
            `${COMPLEMENTARY_LIMITS.maxStepsPerEntry} tool calls`,
          );
        }
        calls.push({
          id: callIdOf(block.id, entry.id),
          name: block.name,
          args: block.arguments,
          index: calls.length,
        });
      }
    }
    if (parts.length > 0) {
      add({ item: messageItem("assistant", parts) });
    }
    for (const call of calls) {
      const args = [canonicalArguments(call.args)];
      const key = call.id ?? `index-${call.index}`;
      add({
        item: {
          ref: `entry:${entry.id}/tool-call/${key}`,
          role: "tool",
          trust: "untrusted-tool",
          trustLabel: "untrusted tool call arguments",
          itemKind: "tool-call",
          kind,
          toolCallId: call.id,
          toolName: call.name,
          parts: args,
          length: args[0]!.length,
          preview: false,
        },
        ...(call.id === null ? {} : { effect: { callId: call.id, add: true } }),
      });
    }
    return { steps };
  }

  if (kind === ToolResultEntry.kind) {
    for (const raw of (entry.model ?? []) as readonly unknown[]) {
      if (!isRecord(raw) || raw.role !== "toolResult") continue;
      // Every result message is one step, paired or not, so a re-plan from a later resume
      // position keeps the same step indices. An unpaired result, or one with no usable call id,
      // is a silent no-op, never evidence.
      const id = callIdOf(raw.toolCallId, entry.id);
      if (id === null || !open.has(id)) {
        add({});
        continue;
      }
      const text = textParts(raw.content);
      const joined = text === undefined ? undefined : text.join("\n");
      if (joined === undefined || joined.trim().length === 0) {
        add({ effect: { callId: id, add: false } });
        continue;
      }
      add({
        item: {
          ref: `entry:${entry.id}/tool-result/${id}`,
          role: "tool",
          trust: "untrusted-tool",
          trustLabel: "untrusted tool result",
          itemKind: "tool-result",
          kind,
          toolCallId: id,
          toolName: typeof raw.toolName === "string" ? raw.toolName : null,
          parts: [joined],
          length: joined.length,
          preview: true,
        },
        effect: { callId: id, add: false },
      });
    }
    return { steps };
  }

  // Reset, system, compaction and unknown entries are consumed with no evidence.
  return { steps };
}

/** True when the assistant entry ends without an outstanding tool round. */
function assistantCalls(entry: EntryRecord): { readonly calls: readonly string[]; readonly terminal: boolean } {
  const calls: string[] = [];
  let sawAssistant = false;
  let terminal = false;
  for (const raw of (entry.model ?? []) as readonly unknown[]) {
    if (!isRecord(raw) || raw.role !== "assistant") continue;
    sawAssistant = true;
    if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (isRecord(block) && block.type === "toolCall") {
          const id = callIdOf(block.id, entry.id);
          if (id !== null) {
            if (calls.length >= COMPLEMENTARY_LIMITS.maxStepsPerEntry) {
              throw new Error(
                `Complementary digest entry ${entry.id} has more than ` +
                `${COMPLEMENTARY_LIMITS.maxStepsPerEntry} tool calls`,
              );
            }
            calls.push(id);
          }
        }
      }
    }
    const stop = raw.stopReason;
    // A legacy entry without a stop reason is still terminal when it asked for no tool round. An
    // explicit error or abort is not a completed answer, so it cannot close a segment by itself;
    // a later owner input can still close the preceding range.
    const terminalStop = typeof stop !== "string"
      || (stop !== "pending" && stop !== "toolUse" && stop !== "deferred"
        && stop !== "aborted" && stop !== "error");
    terminal = calls.length === 0 && terminalStop;
  }
  return { calls: Object.freeze(calls), terminal: sawAssistant && terminal };
}

/** Tool call ids completed by one tool-result entry, paired or not. */
function resultCalls(entry: EntryRecord): readonly string[] {
  const ids: string[] = [];
  for (const raw of (entry.model ?? []) as readonly unknown[]) {
    if (isRecord(raw) && raw.role === "toolResult") {
      const id = callIdOf(raw.toolCallId, entry.id);
      if (id !== null) {
        if (ids.length >= COMPLEMENTARY_LIMITS.maxStepsPerEntry) {
          throw new Error(
            `Complementary digest entry ${entry.id} has more than ` +
            `${COMPLEMENTARY_LIMITS.maxStepsPerEntry} tool results`,
          );
        }
        ids.push(id);
      }
    }
  }
  return ids;
}

function clipPreview(parts: readonly string[], total: number, limit: number, ref: string): {
  readonly text: string;
  readonly preview: ComplementaryPreview;
} {
  const shape = joinedParts(parts);
  const target = Math.max(1, Math.min(COMPLEMENTARY_PREVIEW_CHARS, limit));
  const markerOf = (omitted: number): string => `\n… [${omitted} characters omitted; original at ${ref}] …\n`;
  // Both cuts are surrogate-safe: a head ending on a high surrogate or a tail starting on a low
  // surrogate is moved inward by one unit, so the preview never contains half a pair.
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
    const compact = "…";
    headText = headTextOf(Math.max(0, target - compact.length));
    tailText = "";
    omitted = Math.max(0, total - headText.length);
    marker = compact;
    size = headText.length + marker.length;
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

function evidenceOfItem(item: RawItem, entryId: EntryId, itemIndex: number, textStart: number, text: string): ComplementaryEvidence {
  return {
    entryId,
    itemIndex,
    role: item.role,
    trust: item.trust,
    trustLabel: item.trustLabel,
    itemKind: item.itemKind,
    kind: item.kind,
    ref: item.ref,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    textStart,
    chars: item.length,
    text,
    preview: null,
  };
}

interface Chunk {
  readonly entries: readonly ComplementaryEvidence[];
  readonly throughEntryId: EntryId;
  readonly throughItemIndex: number;
  readonly throughChars: number;
  readonly complete: boolean;
  readonly nextEntryId: EntryId;
  readonly nextItemIndex: number;
  readonly nextTextStart: number;
  readonly pendingToolCalls: readonly string[];
}

/**
 * Read one bounded chunk from an exact resume position. The chunk always consumes at least one
 * entry or evidence step, and a partially consumed item is always its last item.
 */
async function readChunk(
  conversation: Conversation,
  firstEntryId: EntryId,
  firstItemIndex: number,
  firstTextStart: number,
  segmentEndEntryId: EntryId,
  pendingStart: readonly string[],
  limits: DigestBatchLimits,
  context: Context,
): Promise<Chunk> {
  const entries: ComplementaryEvidence[] = [];
  const pending = new Set(pendingStart);
  let used = 0;
  let entryCount = 0;
  let stepCount = 0;
  let cursor: Cursor | undefined;
  let entryId = firstEntryId;
  let itemIndex = firstItemIndex;
  let textStart = firstTextStart;
  let lastEntryId: EntryId | null = null;
  let lastItemIndex = -1;
  let lastChars = 0;
  let done = false;

  while (!done && entryId <= segmentEndEntryId && entryCount < limits.entriesPerBatch) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: entryId, maxEntryId: segmentEndEntryId },
      Math.min(COMPLEMENTARY_LIMITS.entriesPerPage, limits.entriesPerBatch - entryCount),
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      entryCount += 1;
      const plan = planOf(entry, pending);
      let start = 0;
      let startOffset = 0;
      if (entry.id === entryId) {
        start = Math.min(itemIndex, plan.steps.length);
        startOffset = textStart;
      }
      if (start >= plan.steps.length) {
        // The entry was already consumed (or carries no steps): move to the next entry.
        lastEntryId = entry.id;
        lastItemIndex = -1;
        lastChars = 0;
        itemIndex = 0;
        textStart = 0;
        entryId = (entry.id + 1) as EntryId;
        continue;
      }
      for (let index = start; index < plan.steps.length; index += 1) {
        if (stepCount >= COMPLEMENTARY_LIMITS.maxStepsPerBatch) {
          done = true;
          break;
        }
        const step = plan.steps[index]!;
        const item = step.item;
        const from = index === start ? startOffset : 0;
        if (item === undefined) {
          stepCount += 1;
          if (step.effect !== undefined) {
            if (step.effect.add) pending.add(step.effect.callId);
            else pending.delete(step.effect.callId);
          }
          lastEntryId = entry.id;
          lastItemIndex = index;
          lastChars = 0;
          itemIndex = index + 1;
          textStart = 0;
          continue;
        }
        if (from >= item.length) {
          // This step was already consumed; its effect is already durable in the cursor.
          itemIndex = index + 1;
          textStart = 0;
          continue;
        }
        if (used >= limits.charsPerBatch) {
          done = true;
          break;
        }
        const remaining = limits.charsPerBatch - used;
        let emitted: ComplementaryEvidence;
        let consumedThrough: number;
        let whole: boolean;
        if (item.preview) {
          const shape = joinedParts(item.parts);
          if (item.length <= COMPLEMENTARY_PREVIEW_CHARS && item.length <= remaining) {
            emitted = evidenceOfItem(
              item,
              entry.id,
              index,
              0,
              evidenceSlice(shape, 0, item.length),
            );
          } else {
            if (used > 0 && remaining < COMPLEMENTARY_LIMITS.minPreviewBudget) {
              done = true;
              break;
            }
            const preview = clipPreview(item.parts, shape.length, remaining, item.ref);
            emitted = {
              ...evidenceOfItem(item, entry.id, index, 0, preview.text),
              preview: preview.preview,
            };
          }
          consumedThrough = item.length;
          whole = true;
        } else {
          const shape = joinedParts(item.parts);
          let take = Math.min(item.length - from, remaining);
          if (from + take < item.length && cutsSurrogatePair(shape, from, take)) {
            if (take <= 1) {
              done = true;
              break;
            }
            take -= 1;
          }
          emitted = evidenceOfItem(item, entry.id, index, from, evidenceSlice(shape, from, from + take));
          consumedThrough = from + take;
          whole = consumedThrough === item.length;
        }
        entries.push(emitted);
        used += emitted.text.length;
        stepCount += 1;
        lastEntryId = entry.id;
        lastItemIndex = index;
        lastChars = consumedThrough;
        if (step.effect !== undefined) {
          if (step.effect.add) pending.add(step.effect.callId);
          else pending.delete(step.effect.callId);
        }
        if (!whole) {
          itemIndex = index;
          textStart = consumedThrough;
          done = true;
          break;
        }
        itemIndex = index + 1;
        textStart = 0;
      }
      if (done) break;
      if (itemIndex >= plan.steps.length) {
        itemIndex = 0;
        textStart = 0;
        entryId = (entry.id + 1) as EntryId;
      } else {
        entryId = entry.id;
      }
      if (entry.id === segmentEndEntryId && entryId > segmentEndEntryId) {
        done = true;
        break;
      }
    }
    if (done) break;
    cursor = page.next;
    if (cursor === undefined) break;
  }

  if (lastEntryId === null) {
    throw new Error("Complementary digest segment has no entries at the requested position");
  }
  if (entryId > segmentEndEntryId) {
    entryId = segmentEndEntryId + 1 as EntryId;
    itemIndex = 0;
    textStart = 0;
  }
  const complete = entryId > segmentEndEntryId;
  return {
    entries,
    throughEntryId: lastEntryId,
    throughItemIndex: lastItemIndex,
    throughChars: lastChars,
    complete,
    nextEntryId: entryId,
    nextItemIndex: itemIndex,
    nextTextStart: textStart,
    pendingToolCalls: Object.freeze([...pending].sort()),
  };
}

interface ScanState {
  readonly startEntryId: EntryId;
  readonly sawInput: boolean;
  readonly hasContent: boolean;
  readonly pending: ReadonlySet<string>;
  readonly terminalEntryId: EntryId | null;
  readonly lastEntryId: EntryId;
}

type ScanResult =
  | {
    readonly status: "complete";
    readonly startEntryId: EntryId;
    readonly endEntryId: EntryId;
    readonly examined: number;
  }
  | { readonly status: "open"; readonly examined: number; readonly reachedTail: boolean; readonly state: ScanState | null }
  | { readonly status: "empty"; readonly examined: number };

/**
 * Walk ascending from the cursor frontier until a completed exchange boundary is found, the tail
 * is reached, or the scan budget is spent. A reset closes the preceding non-empty segment; a new
 * owner/cron input closes the preceding turn; a terminal assistant entry with no open calls closes
 * the tail. An in-progress tail is returned as open, never as evidence.
 */
async function scanForCompletedSegment(
  conversation: Conversation,
  fromEntryId: EntryId,
  resumed: ScanState | null,
  budget: number,
  context: Context,
): Promise<ScanResult> {
  let startEntryId: EntryId | null = resumed?.startEntryId ?? null;
  let sawInput = resumed?.sawInput ?? false;
  let hasContent = resumed?.hasContent ?? false;
  let pending = new Set(resumed?.pending ?? []);
  let terminalEntryId = resumed?.terminalEntryId ?? null;
  let lastEntryId = resumed?.lastEntryId ?? ((fromEntryId - 1) as EntryId);
  let examined = 0;
  let cursor: Cursor | undefined;
  let nextId = fromEntryId;
  while (examined < budget) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: nextId },
      Math.min(COMPLEMENTARY_LIMITS.entriesPerPage, budget - examined),
      cursor,
      context,
    );
    if (page.items.length === 0) {
      if (!hasContent) return { status: "empty", examined };
      if (sawInput && terminalEntryId !== null && pending.size === 0 && startEntryId !== null) {
        return { status: "complete", startEntryId, endEntryId: terminalEntryId, examined };
      }
      if (startEntryId === null) return { status: "empty", examined };
      return {
        status: "open",
        examined,
        reachedTail: true,
        state: { startEntryId, sawInput, hasContent, pending, terminalEntryId, lastEntryId },
      };
    }
    for (const entry of page.items) {
      examined += 1;
      startEntryId ??= entry.id;
      if (entry.kind === ResetEntry.kind) {
        if (sawInput && hasContent) {
          if (startEntryId === null) throw new Error("Complementary scan lost its segment start");
          return { status: "complete", startEntryId, endEntryId: lastEntryId, examined };
        }
        // A reset before the first owner/cron input closes no exchange: keep it inside the
        // segment prefix so a leading system/reset block does not need a model-free batch of
        // its own. Once an input was seen, a reset closes that exchange above.
        pending = new Set();
        terminalEntryId = null;
        lastEntryId = entry.id;
        nextId = (entry.id + 1) as EntryId;
        continue;
      }
      if (entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND) {
        if (sawInput && hasContent) {
          if (startEntryId === null) throw new Error("Complementary scan lost its segment start");
          return { status: "complete", startEntryId, endEntryId: lastEntryId, examined };
        }
        sawInput = true;
        hasContent = true;
        pending.clear();
        terminalEntryId = null;
        lastEntryId = entry.id;
        nextId = (entry.id + 1) as EntryId;
        continue;
      }
      hasContent = true;
      if (entry.kind === AssistantEntry.kind) {
        const parsed = assistantCalls(entry);
        for (const callId of parsed.calls) {
          if (!pending.has(callId) && pending.size >= COMPLEMENTARY_LIMITS.maxPendingToolCalls) {
            throw new Error(
              `Complementary digest segment has more than ${COMPLEMENTARY_LIMITS.maxPendingToolCalls} open tool calls`,
            );
          }
          pending.add(callId);
        }
        terminalEntryId = parsed.terminal && pending.size === 0 ? entry.id : null;
      } else if (entry.kind === ToolResultEntry.kind) {
        for (const callId of resultCalls(entry)) pending.delete(callId);
        terminalEntryId = null;
      }
      lastEntryId = entry.id;
      nextId = (entry.id + 1) as EntryId;
    }
    cursor = page.next;
    if (cursor === undefined) {
      if (!hasContent) return { status: "empty", examined };
      if (sawInput && terminalEntryId !== null && pending.size === 0 && startEntryId !== null) {
        return { status: "complete", startEntryId, endEntryId: terminalEntryId, examined };
      }
      if (startEntryId === null) return { status: "empty", examined };
      return {
        status: "open",
        examined,
        reachedTail: true,
        state: { startEntryId, sawInput, hasContent, pending, terminalEntryId, lastEntryId },
      };
    }
  }
  if (startEntryId === null) return { status: "empty", examined };
  return {
    status: "open",
    examined,
    reachedTail: false,
    state: {
      startEntryId,
      sawInput,
      hasContent,
      pending,
      terminalEntryId,
      lastEntryId,
    },
  };
}

interface SegmentBounds {
  readonly segmentStartEntryId: EntryId;
  readonly segmentEndEntryId: EntryId;
}

interface ScanCacheEntry extends ScanState {
  readonly cursor: ComplementaryCursor;
}

interface Candidate {
  readonly session: HistoryChatSession;
  readonly conversation: Conversation;
  readonly cursor: ComplementaryCursor;
  readonly segment?: SegmentBounds;
}

function nextPositionOf(candidate: Candidate): { readonly entryId: number; readonly item: number; readonly chars: number } {
  if (candidate.segment !== undefined) {
    return { entryId: candidate.segment.segmentStartEntryId, item: 0, chars: 0 };
  }
  return {
    entryId: candidate.cursor.nextEntryId ?? 1,
    item: candidate.cursor.nextItemIndex,
    chars: candidate.cursor.nextTextStart,
  };
}

function validateCursor(cursor: unknown): ComplementaryCursor {
  if (!isRecord(cursor)) throw new TypeError("Complementary cursor must be an object");
  const nextEntryId = cursor.nextEntryId === null
    ? null
    : positiveId(cursor.nextEntryId, "Complementary cursor next entry");
  const nextItemIndex = nonNegative(cursor.nextItemIndex, "Complementary cursor next item");
  const nextTextStart = nonNegative(cursor.nextTextStart, "Complementary cursor next offset");
  const segmentStartEntryId = cursor.segmentStartEntryId === null
    ? null
    : positiveId(cursor.segmentStartEntryId, "Complementary cursor segment start");
  const segmentEndEntryId = cursor.segmentEndEntryId === null
    ? null
    : positiveId(cursor.segmentEndEntryId, "Complementary cursor segment end");
  if (!Array.isArray(cursor.pendingToolCalls)) {
    throw new TypeError("Complementary cursor pending calls must be an array");
  }
  const pendingToolCalls = pendingOf(cursor.pendingToolCalls);
  if ((segmentStartEntryId === null) !== (segmentEndEntryId === null)) {
    throw new TypeError("Complementary cursor must name both segment bounds or neither");
  }
  if (segmentStartEntryId !== null && segmentEndEntryId !== null) {
    if (segmentStartEntryId > segmentEndEntryId) {
      throw new TypeError("Complementary cursor segment bounds are inverted");
    }
    if (nextEntryId === null || nextEntryId > segmentEndEntryId) {
      throw new TypeError("Complementary cursor position is outside its segment");
    }
  } else if (nextEntryId === null && (nextItemIndex !== 0 || nextTextStart !== 0)) {
    throw new TypeError("Complementary cursor has a position before the first entry");
  }
  return {
    nextEntryId: nextEntryId as EntryId | null,
    nextItemIndex,
    nextTextStart,
    segmentStartEntryId: segmentStartEntryId as EntryId | null,
    segmentEndEntryId: segmentEndEntryId as EntryId | null,
    pendingToolCalls,
  };
}

function validateBatchRef(ref: ComplementaryBatchRef): void {
  if (ref === null || typeof ref !== "object") throw new TypeError("Complementary batch ref must be an object");
  if (typeof ref.sessionKey !== "string" || ref.sessionKey.length === 0) {
    throw new TypeError("Complementary batch ref session key must be a non-empty string");
  }
  const conversationId = ref.conversationId as number;
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new TypeError("Complementary batch ref conversation ID must be a positive safe integer");
  }
  const start = positiveId(ref.segmentStartEntryId, "Complementary batch ref segment start");
  const end = positiveId(ref.segmentEndEntryId, "Complementary batch ref segment end");
  const first = positiveId(ref.firstEntryId, "Complementary batch ref first entry");
  const through = positiveId(ref.throughEntryId, "Complementary batch ref through entry");
  const firstItem = nonNegative(ref.firstItemIndex, "Complementary batch ref first item");
  const throughItem = ref.throughItemIndex;
  if (typeof throughItem !== "number" || !Number.isSafeInteger(throughItem) || throughItem < -1) {
    throw new TypeError("Complementary batch ref through item must be an integer of at least -1");
  }
  const firstTextStart = nonNegative(ref.firstTextStart, "Complementary batch ref first offset");
  const throughChars = nonNegative(ref.throughChars, "Complementary batch ref through offset");
  if (!(start <= first && first <= through && through <= end)) {
    throw new TypeError("Complementary batch ref entry range is inconsistent");
  }
  if (first === through && throughItem !== -1 && throughItem < firstItem) {
    throw new TypeError("Complementary batch ref item range is inconsistent");
  }
  if (typeof ref.complete !== "boolean") throw new TypeError("Complementary batch ref completeness must be a boolean");
  if (ref.complete && through !== end) {
    throw new TypeError("Complementary batch ref cannot complete before its segment end");
  }
  const cursor = validateCursor(ref.cursor);
  if (cursor.segmentStartEntryId !== null) {
    if (start !== cursor.segmentStartEntryId || end !== cursor.segmentEndEntryId) {
      throw new TypeError("Complementary batch ref does not continue its cursor's segment");
    }
    if (first !== cursor.nextEntryId || firstItem !== cursor.nextItemIndex
      || firstTextStart !== cursor.nextTextStart) {
      throw new TypeError("Complementary batch ref does not continue at its cursor position");
    }
  } else {
    if (first !== start) throw new TypeError("Complementary batch ref must start its segment at its start");
    // A fresh segment starts at the cursor's position. Only a migrated closed-episode frontier
    // holds a non-zero position here; a settled frontier is item 0 offset 0.
    if (firstItem !== cursor.nextItemIndex || firstTextStart !== cursor.nextTextStart) {
      throw new TypeError("Complementary batch ref must start a fresh segment at its cursor position");
    }
    if (cursor.nextEntryId !== null && cursor.nextEntryId > first) {
      throw new TypeError("Complementary batch ref starts before its cursor frontier");
    }
  }
  void throughChars;
}

function validateBatchShape(batch: ComplementaryBatch): void {
  if (batch === null || typeof batch !== "object") throw new TypeError("Complementary batch must be an object");
  if (batch.status !== "batch") throw new TypeError("Complementary batch status is invalid");
  validateBatchRef(batch as unknown as ComplementaryBatchRef);
  const first = batch.firstEntryId;
  const through = batch.throughEntryId;
  if (through < first) throw new TypeError("Complementary batch ends before it starts");
  if (batch.complete && through !== batch.segmentEndEntryId) {
    throw new TypeError("Complementary batch cannot complete before its segment end");
  }
  if (batch.highWaterEntryId !== batch.segmentEndEntryId) {
    throw new TypeError("Complementary batch high-water must be its segment end");
  }
  if (!Array.isArray(batch.entries)) throw new TypeError("Complementary batch entries must be an array");
  let previousEntry = 0;
  let previousItem = -1;
  for (const entry of batch.entries as readonly unknown[]) {
    if (!isRecord(entry)) throw new TypeError("Complementary evidence must be an object");
    const entryId = positiveId(entry.entryId, "Complementary evidence entry ID");
    const itemIndex = nonNegative(entry.itemIndex, "Complementary evidence item index");
    if (entryId < first || entryId > through || entryId < previousEntry
      || (entryId === previousEntry && itemIndex <= previousItem)) {
      throw new TypeError("Complementary evidence is outside or out of order in its chunk");
    }
    previousEntry = entryId;
    previousItem = itemIndex;
    if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") {
      throw new TypeError("Complementary evidence role is invalid");
    }
    if (entry.trust !== "owner" && entry.trust !== "assistant" && entry.trust !== "untrusted-tool") {
      throw new TypeError("Complementary evidence trust label is invalid");
    }
    if (entry.itemKind !== "message" && entry.itemKind !== "tool-call" && entry.itemKind !== "tool-result") {
      throw new TypeError("Complementary evidence item kind is invalid");
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new TypeError("Complementary evidence durable kind must be a non-empty string");
    }
    if (typeof entry.ref !== "string" || entry.ref.length === 0) {
      throw new TypeError("Complementary evidence reference must be a non-empty string");
    }
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      throw new TypeError("Complementary evidence text must be non-empty");
    }
    const textStart = nonNegative(entry.textStart, "Complementary evidence text offset");
    const chars = positiveId(entry.chars, "Complementary evidence length");
    if (textStart >= chars) throw new TypeError("Complementary evidence starts beyond its item");
    if (entry.preview === null) {
      if (textStart + entry.text.length > chars) {
        throw new TypeError("Complementary evidence fragment is outside its item text");
      }
    } else {
      if (textStart !== 0) throw new TypeError("Complementary preview must start at its item start");
      const preview = entry.preview as Record<string, unknown>;
      nonNegative(preview.headChars, "Complementary preview head");
      nonNegative(preview.tailChars, "Complementary preview tail");
      nonNegative(preview.omittedStart, "Complementary preview omitted start");
      nonNegative(preview.omittedEnd, "Complementary preview omitted end");
      nonNegative(preview.omittedChars, "Complementary preview omitted length");
      if (typeof preview.marker !== "string" || preview.marker.length === 0) {
        throw new TypeError("Complementary preview marker must be non-empty");
      }
    }
  }
  const advanced = batch.complete
    || through > first
    || (through === first && batch.throughItemIndex >= batch.firstItemIndex);
  if (!advanced) throw new TypeError("Complementary acknowledgement does not advance the cursor");
}

async function entryAt(
  conversation: Conversation,
  entryId: EntryId,
  context: Context,
): Promise<EntryRecord | undefined> {
  return (await conversation.entries(
    { order: "ascending", minEntryId: entryId, maxEntryId: entryId },
    1,
    undefined,
    context,
  )).items[0];
}

/**
 * Prove that a newly claimed segment end is a completed exchange boundary in the committed
 * transcript. A reset or the next owner/cron input after the end closes it; otherwise the end must
 * be a terminal assistant entry with no open calls. The walk is paged and reads only the segment.
 */
async function validateCompletedSegment(
  conversation: Conversation,
  startEntryId: EntryId,
  endEntryId: EntryId,
  context: Context,
): Promise<void> {
  const start = await entryAt(conversation, startEntryId, context);
  if (start === undefined) throw new TypeError("Complementary segment start is not a committed entry");
  let sawInput = false;
  let hasContent = false;
  const pending = new Set<string>();
  let terminalEntryId: EntryId | null = null;
  let cursor: Cursor | undefined;
  let entryId = startEntryId;
  while (entryId <= endEntryId) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: entryId, maxEntryId: endEntryId },
      COMPLEMENTARY_LIMITS.entriesPerPage,
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      if (entry.kind === ResetEntry.kind) {
        if (sawInput) throw new TypeError("Complementary segment spans a reset after its owner turn");
        continue;
      }
      hasContent = true;
      if (entry.kind === UserEntry.kind || entry.kind === CRON_INPUT_ENTRY_KIND) {
        sawInput = true;
        pending.clear();
        terminalEntryId = null;
      } else if (entry.kind === AssistantEntry.kind) {
        const parsed = assistantCalls(entry);
        for (const callId of parsed.calls) {
          if (!pending.has(callId) && pending.size >= COMPLEMENTARY_LIMITS.maxPendingToolCalls) {
            throw new TypeError("Complementary segment has too many open tool calls");
          }
          pending.add(callId);
        }
        terminalEntryId = parsed.terminal && pending.size === 0 ? entry.id : null;
      } else if (entry.kind === ToolResultEntry.kind) {
        for (const callId of resultCalls(entry)) pending.delete(callId);
        terminalEntryId = null;
      }
    }
    cursor = page.next;
    if (cursor === undefined) break;
    entryId = (page.items[page.items.length - 1]!.id + 1) as EntryId;
  }
  if (!hasContent) throw new TypeError("Complementary segment holds no content");
  if (!sawInput) throw new TypeError("Complementary segment does not open an owner or scheduled turn");
  const closing = (await conversation.entries(
    { order: "ascending", minEntryId: (endEntryId + 1) as EntryId },
    1,
    undefined,
    context,
  )).items[0];
  if (closing !== undefined && (closing.kind === ResetEntry.kind
    || closing.kind === UserEntry.kind || closing.kind === CRON_INPUT_ENTRY_KIND)) {
    return;
  }
  if (terminalEntryId !== endEntryId || pending.size > 0) {
    throw new TypeError("Complementary segment end is not a completed exchange boundary");
  }
}

/**
 * Prove that a fresh segment's start did not hop over an unconsumed entry in the same conversation.
 * Entry IDs are global and may interleave other conversations, so the cursor frontier can be below
 * the segment start; only the skipped range within this conversation must be empty. The gap is
 * bounded by one read's scan budget and a longer one is refused rather than assumed, so a forged
 * start cannot skip an earlier exchange whose evidence would then be lost forever.
 */
async function validateFreshSegmentGap(
  conversation: Conversation,
  batch: ComplementaryBatch,
  context: Context,
): Promise<void> {
  const gapFrom = batch.cursor.nextEntryId ?? (1 as EntryId);
  const gapTo = batch.firstEntryId - 1;
  if (gapTo < gapFrom) return;
  const gap = await conversation.entries(
    { order: "ascending", minEntryId: gapFrom, maxEntryId: gapTo as EntryId },
    COMPLEMENTARY_LIMITS.scanEntriesPerRead + 1,
    undefined,
    context,
  );
  if (gap.items.length > COMPLEMENTARY_LIMITS.scanEntriesPerRead || gap.next !== undefined) {
    throw new TypeError("Complementary segment start is too far from its cursor to verify");
  }
  if (gap.items.length > 0) {
    throw new TypeError("Complementary segment start would skip an earlier entry with content");
  }
}

function requireBatchLimits(limits: DigestBatchLimits): DigestBatchLimits {
  if (!isDigestEntriesBound(limits.entriesPerBatch) || !isDigestCharsBound(limits.charsPerBatch)) {
    throw new TypeError(
      `complementary digest batch bounds must be positive safe integers, with entriesPerBatch at least ` +
      `${DIGEST_ENTRIES_PER_BATCH_MIN} and charsPerBatch at least ${DIGEST_CHARS_PER_BATCH_MIN}`,
    );
  }
  return limits;
}

export function createComplementarySource(options: ComplementarySourceOptions): ComplementarySource {
  const configured = requireBatchLimits(options.limits ?? DIGEST_RUN_LIMITS_DEFAULT);
  const scanCache = new Map<ConversationId, ScanCacheEntry>();
  let rotation = 0;

  const cursorStateFor = async (
    conversationId: ConversationId,
    context: Context,
    knownConversation?: Conversation,
  ): Promise<{ readonly cursor: ComplementaryCursor; readonly stored: ComplementaryCursor | undefined }> => {
    const document = await options.harness.snapshot(ComplementaryCursorDoc, conversationId, context);
    const stored = document === undefined ? undefined : cursorOf(document);
    if (stored !== undefined && !sameCursor(stored, EMPTY_CURSOR)) return { cursor: stored, stored };
    // No complementary cursor yet (or only an untouched initial one): derive the starting frontier
    // from an existing closed-episode cursor instead of replaying work that digest already did.
    const legacy = digestCursorOf(
      await options.harness.snapshot(DigestCursorDoc, conversationId, context),
    );
    if (legacy.throughEntryId === null || legacy.throughChars === null) {
      return { cursor: EMPTY_CURSOR, stored };
    }
    const conversation = knownConversation
      ?? await options.harness.conversation(conversationId, context);
    if (conversation === undefined) {
      throw new Error(
        `Legacy digest frontier for conversation ${conversationId} has no committed conversation; ` +
        `refusing to adopt it`,
      );
    }
    return { cursor: await adoptDigestCursor(legacy, conversation, context), stored };
  };

  const cursorFor = async (conversationId: ConversationId, context: Context): Promise<ComplementaryCursor> =>
    (await cursorStateFor(conversationId, context)).cursor;

  const batchOf = (
    session: HistoryChatSession,
    segment: SegmentBounds,
    firstEntryId: EntryId,
    firstItemIndex: number,
    firstTextStart: number,
    chunk: Chunk,
    cursor: ComplementaryCursor,
  ): ComplementaryBatch => ({
    status: "batch",
    sessionKey: session.sessionKey,
    conversationId: session.conversationId,
    segmentStartEntryId: segment.segmentStartEntryId,
    segmentEndEntryId: segment.segmentEndEntryId,
    firstEntryId,
    firstItemIndex,
    firstTextStart,
    throughEntryId: chunk.throughEntryId,
    throughItemIndex: chunk.throughItemIndex,
    throughChars: chunk.throughChars,
    complete: chunk.complete,
    highWaterEntryId: segment.segmentEndEntryId,
    entries: chunk.entries,
    cursor,
  });

  return {
    cursor(conversationId, context) {
      positiveId(conversationId as number, "Complementary conversation ID");
      return cursorFor(conversationId, context);
    },

    async read(context, limits) {
      const batchLimits = requireBatchLimits(limits ?? configured);
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const mapped = new Set<ConversationId>(sessions.map((session) => session.conversationId));
      for (const known of scanCache.keys()) {
        if (!mapped.has(known)) scanCache.delete(known);
      }
      let budget = COMPLEMENTARY_LIMITS.scanEntriesPerRead;
      let examinedChats = 0;
      let postponedChats = 0;
      let unfinishedChats = 0;
      let missingChats = 0;
      let openChats = 0;
      const candidates: Candidate[] = [];
      const startAt = sessions.length <= 1 ? 0 : rotation % sessions.length;
      if (sessions.length > 1) rotation = (startAt + 1) % sessions.length;
      const ordered = startAt === 0 ? sessions : [...sessions.slice(startAt), ...sessions.slice(0, startAt)];
      for (const session of ordered) {
        const conversationId = session.conversationId;
        const conversation = await options.harness.conversation(conversationId, context);
        if (conversation === undefined) {
          missingChats += 1;
          continue;
        }
        const cursor = (await cursorStateFor(conversationId, context, conversation)).cursor;
        if (cursor.segmentStartEntryId !== null) {
          examinedChats += 1;
          candidates.push({ session, conversation, cursor });
          continue;
        }
        if (budget <= 0) {
          postponedChats += 1;
          continue;
        }
        const cached = scanCache.get(conversationId);
        const usable = cached !== undefined && sameCursor(cached.cursor, cursor);
        if (!usable) scanCache.delete(conversationId);
        const fromEntryId = (usable
          ? cached!.lastEntryId + 1
          : cursor.nextEntryId ?? 1) as EntryId;
        const tail = (await conversation.entries({ order: "descending" }, 1, undefined, context)).items[0];
        if (tail === undefined) {
          examinedChats += 1;
          continue;
        }
        if (fromEntryId > tail.id) {
          // A cached scan already examined this tail and found no completed boundary. It is
          // still an open chat, not a new empty one, so keep the idle report stable.
          if (usable) openChats += 1;
          examinedChats += 1;
          continue;
        }
        const scanned = await scanForCompletedSegment(
          conversation,
          fromEntryId,
          usable ? cached! : null,
          budget,
          context,
        );
        budget -= scanned.examined;
        examinedChats += 1;
        if (scanned.status === "complete") {
          scanCache.delete(conversationId);
          candidates.push({
            session,
            conversation,
            cursor,
            segment: {
              segmentStartEntryId: scanned.startEntryId,
              segmentEndEntryId: scanned.endEntryId,
            },
          });
        } else if (scanned.status === "open") {
          if (!scanned.reachedTail) unfinishedChats += 1;
          else openChats += 1;
          if (scanned.state !== null) {
            scanCache.set(conversationId, { ...scanned.state, cursor });
          }
        }
      }
      if (candidates.length === 0) {
        return {
          status: "idle",
          caughtUp: postponedChats === 0 && unfinishedChats === 0 && missingChats === 0,
          examinedChats,
          postponedChats,
          unfinishedChats,
          missingChats,
          openChats,
        };
      }
      candidates.sort((left, right) => {
        const a = nextPositionOf(left);
        const b = nextPositionOf(right);
        return a.entryId - b.entryId
          || a.item - b.item
          || a.chars - b.chars
          || (left.session.conversationId as number) - (right.session.conversationId as number);
      });
      const chosen = candidates[0]!;
      const segment = chosen.segment ?? {
        segmentStartEntryId: chosen.cursor.segmentStartEntryId!,
        segmentEndEntryId: chosen.cursor.segmentEndEntryId!,
      };
      const firstEntryId = (chosen.segment !== undefined
        ? segment.segmentStartEntryId
        : chosen.cursor.nextEntryId!) as EntryId;
      // The cursor position is this chunk's start when the chunk begins at the cursor frontier: a
      // fresh segment starts there, and a migrated closed-episode frontier resumes inside that entry
      // at the already-digested message offset instead of re-emitting text another reader processed.
      const atFrontier = chosen.segment === undefined
        || segment.segmentStartEntryId === chosen.cursor.nextEntryId;
      const firstItemIndex = atFrontier ? chosen.cursor.nextItemIndex : 0;
      const firstTextStart = atFrontier ? chosen.cursor.nextTextStart : 0;
      const chunk = await readChunk(
        chosen.conversation,
        firstEntryId,
        firstItemIndex,
        firstTextStart,
        segment.segmentEndEntryId,
        chosen.cursor.pendingToolCalls,
        batchLimits,
        context,
      );
      return batchOf(
        chosen.session,
        segment,
        firstEntryId,
        firstItemIndex,
        firstTextStart,
        chunk,
        chosen.cursor,
      );
    },

    async readBatch(ref, context, limits) {
      validateBatchRef(ref);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = ref.conversationId;
      const conversation = await options.harness.conversation(conversationId, context);
      if (conversation === undefined) throw new TypeError("Complementary batch ref conversation is not committed");
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (session === undefined || session.sessionKey !== ref.sessionKey) {
        throw new TypeError("Complementary batch ref is not a currently mapped chat session");
      }
      const start = await entryAt(conversation, ref.segmentStartEntryId, context);
      if (start === undefined) throw new TypeError("Complementary batch ref segment start is not committed");
      const chunk = await readChunk(
        conversation,
        ref.firstEntryId,
        ref.firstItemIndex,
        ref.firstTextStart,
        ref.segmentEndEntryId,
        ref.cursor.pendingToolCalls,
        batchLimits,
        context,
      );
      if (
        chunk.throughEntryId !== ref.throughEntryId
        || chunk.throughItemIndex !== ref.throughItemIndex
        || chunk.throughChars !== ref.throughChars
        || chunk.complete !== ref.complete
      ) {
        throw new TypeError("Complementary batch ref no longer matches the committed transcript");
      }
      return {
        status: "batch",
        sessionKey: ref.sessionKey,
        conversationId,
        segmentStartEntryId: ref.segmentStartEntryId,
        segmentEndEntryId: ref.segmentEndEntryId,
        firstEntryId: ref.firstEntryId,
        firstItemIndex: ref.firstItemIndex,
        firstTextStart: ref.firstTextStart,
        throughEntryId: chunk.throughEntryId,
        throughItemIndex: chunk.throughItemIndex,
        throughChars: chunk.throughChars,
        complete: chunk.complete,
        highWaterEntryId: ref.segmentEndEntryId,
        entries: chunk.entries,
        cursor: ref.cursor,
      };
    },

    async acknowledge(batch, context, limits) {
      validateBatchShape(batch);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = batch.conversationId;
      const conversation = await options.harness.conversation(conversationId, context);
      if (conversation === undefined) {
        throw new TypeError("Complementary batch conversation is not a committed conversation");
      }
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (session === undefined || session.sessionKey !== batch.sessionKey) {
        throw new TypeError("Complementary batch is not a currently mapped chat session");
      }
      if (batch.cursor.segmentStartEntryId === null) {
        await validateFreshSegmentGap(conversation, batch, context);
        await validateCompletedSegment(
          conversation,
          batch.segmentStartEntryId,
          batch.segmentEndEntryId,
          context,
        );
      } else if (
        batch.segmentStartEntryId !== batch.cursor.segmentStartEntryId
        || batch.segmentEndEntryId !== batch.cursor.segmentEndEntryId
      ) {
        throw new TypeError("Complementary batch does not continue its cursor's segment");
      }
      const rederived = await readChunk(
        conversation,
        batch.firstEntryId,
        batch.firstItemIndex,
        batch.firstTextStart,
        batch.segmentEndEntryId,
        batch.cursor.pendingToolCalls,
        batchLimits,
        context,
      );
      if (
        rederived.throughEntryId !== batch.throughEntryId
        || rederived.throughItemIndex !== batch.throughItemIndex
        || rederived.throughChars !== batch.throughChars
        || rederived.complete !== batch.complete
        || rederived.entries.length !== batch.entries.length
      ) {
        throw new TypeError("Complementary batch does not match the committed transcript");
      }
      for (let index = 0; index < rederived.entries.length; index += 1) {
        if (!sameEvidence(rederived.entries[index]!, batch.entries[index]!)) {
          throw new TypeError("Complementary evidence does not match the committed transcript");
        }
      }
      const next: ComplementaryCursor = rederived.complete
        ? {
          nextEntryId: rederived.nextEntryId,
          nextItemIndex: 0,
          nextTextStart: 0,
          segmentStartEntryId: null,
          segmentEndEntryId: null,
          pendingToolCalls: Object.freeze([]) as readonly string[],
        }
        : {
          nextEntryId: rederived.nextEntryId,
          nextItemIndex: rederived.nextItemIndex,
          nextTextStart: rederived.nextTextStart,
          segmentStartEntryId: batch.segmentStartEntryId,
          segmentEndEntryId: batch.segmentEndEntryId,
          pendingToolCalls: rederived.pendingToolCalls,
        };
      // An absent or untouched complementary document adopts the closed-episode frontier at the
      // first acknowledgement. Deriving it needs the legacy prefix, which the transaction cannot
      // walk, so derive it first and repeat the legacy-cursor comparison inside the transaction: a
      // closed-episode cursor that moved since the read is a conflict.
      const storedBefore = cursorOf(
        await options.harness.snapshot(ComplementaryCursorDoc, conversationId, context),
      );
      let legacyBefore: DigestCursor | undefined;
      let adoptedBefore: ComplementaryCursor | undefined;
      if (sameCursor(storedBefore, EMPTY_CURSOR)) {
        legacyBefore = digestCursorOf(
          await options.harness.snapshot(DigestCursorDoc, conversationId, context),
        );
        adoptedBefore = await adoptDigestCursor(legacyBefore, conversation, context);
      }
      await options.harness.commit(async (tx) => {
        const document = await tx.doc(ComplementaryCursorDoc, conversationId);
        const stored = cursorOf(document);
        let expected = stored;
        if (sameCursor(stored, EMPTY_CURSOR)) {
          if (legacyBefore === undefined || adoptedBefore === undefined) {
            throw new ComplementaryCursorConflictError(
              "Complementary cursor moved after this batch was read; re-read before acknowledging",
            );
          }
          const legacyNow = digestCursorOf(await tx.doc(DigestCursorDoc, conversationId));
          if (!sameLegacyCursor(legacyNow, legacyBefore)) {
            throw new ComplementaryCursorConflictError(
              "Closed-episode cursor moved after this batch was read; re-read before acknowledging",
            );
          }
          expected = adoptedBefore;
        }
        if (!sameCursor(expected, batch.cursor)) {
          throw new ComplementaryCursorConflictError(
            "Complementary cursor moved after this batch was read; re-read before acknowledging",
          );
        }
        document.nextEntryId = next.nextEntryId;
        document.nextItemIndex = next.nextItemIndex;
        document.nextTextStart = next.nextTextStart;
        document.segmentStartEntryId = next.segmentStartEntryId;
        document.segmentEndEntryId = next.segmentEndEntryId;
        document.pendingToolCalls = [...next.pendingToolCalls];
      }, context);
      scanCache.delete(conversationId);
      return next;
    },
  };
}

function sameEvidence(left: ComplementaryEvidence, right: ComplementaryEvidence): boolean {
  return left.entryId === right.entryId
    && left.itemIndex === right.itemIndex
    && left.role === right.role
    && left.trust === right.trust
    && left.trustLabel === right.trustLabel
    && left.itemKind === right.itemKind
    && left.kind === right.kind
    && left.ref === right.ref
    && left.toolCallId === right.toolCallId
    && left.toolName === right.toolName
    && left.textStart === right.textStart
    && left.chars === right.chars
    && left.text === right.text
    && samePreview(left.preview, right.preview);
}

function samePreview(left: ComplementaryPreview | null, right: ComplementaryPreview | null): boolean {
  if (left === null || right === null) return left === right;
  return left.headChars === right.headChars
    && left.tailChars === right.tailChars
    && left.omittedStart === right.omittedStart
    && left.omittedEnd === right.omittedEnd
    && left.omittedChars === right.omittedChars
    && left.marker === right.marker;
}

