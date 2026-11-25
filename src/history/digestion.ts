/**
 * Bounded, source-labeled evidence for memory digestion, plus its one durable cursor.
 *
 * Product digestion uses `readClosed()`: only reset-closed episodes, beginning at the existing
 * frontier. It preserves historical frozen segment bounds and separately identifies the real
 * episode end. Its paged metadata walk reaches a reset/tail without a fixed whole-episode size
 * cap; only the selected closed episode is rendered, one bounded chunk at a time. Open episodes
 * are never offered. The lower-level `read()` completed-turn API remains for historical SDK
 * compatibility and cursor checks; it is not the product's model-execution selector.
 *
 * This module reads only; it calls no model, writes no memory, creates no task and schedules
 * nothing. `read()` returns one bounded chunk of one mapped chat conversation, covering every new
 * completed turn the cursor can reach inside one scan bound rather than stopping at the first turn,
 * whether that chat is still open or already reset. `acknowledge()` moves that conversation's cursor
 * after the caller has successfully consumed the chunk. A read that is never acknowledged advances
 * nothing, so a failure or restart replays the same evidence.
 *
 * Eligibility is a completed-turn high-water, not a closed episode:
 * - A segment ends just before a reset that follows an owner or scheduled turn, just before the
 *   next owner/scheduled input, or at a terminal assistant entry whose tool calls are all paired.
 *   An assistant entry that stopped with an explicit error or abort is not a completed answer and
 *   cannot close a segment by itself.
 * - The scan tracks the furthest such boundary in one pass, so a range spans as many new completed
 *   turns as the cursor's frontier reaches within the scan bound. Three short turns are therefore
 *   one batch, not three, and `readChunk` alone decides whether the range fits or splits.
 * - An in-progress tail (an owner message still awaiting an answer, an assistant tool round, or a
 *   tool result still awaiting its next assistant entry) is never offered and never starts a batch;
 *   a range ends at the last completed turn before it and leaves the open tail queued.
 * - A reset before the first owner input stays inside the segment prefix, so a leading
 *   system/reset block does not need a model-free batch of its own.
 * - One read offers only evidence that was already a completed exchange when the read began; a
 *   later appended entry is a later segment. The bounds of an accepted batch are immutable.
 *
 * Trust contract (the host remains the authorization boundary):
 * - The host passes the same currently mapped chat sessions its provider already authenticated and
 *   classified through `readChatSessions` and `partitionChatScope`; this module does not re-derive
 *   root/fork/task/worker ownership. It only rejects shape errors a host callback should never
 *   produce: an empty or channel-state session key, an invalid conversation ID, a repeated
 *   conversation ID, or more than {@link DIGEST_LIMITS.maxMappedSessions} mappings.
 * - Owner messages and scheduled triggers are `owner` evidence; assistant message text is
 *   `assistant` evidence. Assistant tool calls and their paired tool results are always
 *   `untrusted-tool`: they are machine text, never instructions and never attributed to the owner.
 * - Reset handoff messages, system entries, compaction entries, assistant thinking parts and tool
 *   results with no paired call are consumed as part of the range but contribute no evidence.
 * - A tool result is paired only with a call id that is still open in the same segment. Pairing
 *   state is durable in the cursor, so a result in a later chunk is paired even after a reopen. An
 *   orphan result is consumed with no fragment instead of being presented as if the owner or
 *   assistant said it. A call id longer than the fixed bound fails the segment closed; dropping it
 *   would silently lose the result that cites the same id.
 *
 * Evidence shape and bounds:
 * - Message prose and tool-call arguments are lossless fragments of the original entry (UTF-16
 *   offsets, surrogate-safe). A long item continues in the next chunk from exactly where the last
 *   chunk stopped; nothing is dropped and no tail is discarded.
 * - A tool result is machine output, so a long result is one head-tail preview of at most
 *   {@link DIGEST_PREVIEW_CHARS} characters with an explicit omission marker and a stable
 *   reference to the original entry. A short result is included whole. The preview is not a
 *   fragment of a longer item: it is consumed whole, and a consumer must never claim the omitted
 *   middle was read. Durable remains the transcript authority; no second archive is written.
 * - A batch's evidence never exceeds {@link DIGEST_LIMITS.charsPerBatch}. One completed range is
 *   one batch whenever its evidence fits both bounds; only a larger range splits, into independent
 *   ordered chunks that each carry their own acknowledgement. A chunk never moves the completed
 *   boundary, and there is no carry-over note, running summary or cross-chunk state.
 * - One evidence step is a message, a tool call, a tool result or a silent pairing step. Steps are
 *   addressed by `(entryId, itemIndex)` and their extracted text by a UTF-16 offset, so a consumer
 *   can cite the original transcript and finish a long item across batches.
 *
 * The cursor is one small conversation-scoped document, not a second history archive:
 * - `nextEntryId`/`nextItemIndex`/`nextTextStart` are the position after the last acknowledged step
 *   (`nextEntryId` null before the conversation's first batch).
 * - `episodeStartEntryId`/`episodeEndEntryId` are set only while a completed segment is being
 *   consumed in bounded chunks, naming its immutable bounds so the next batch continues it.
 * - `pendingToolCalls` holds the call ids still open at that position, so pairing survives a chunk
 *   boundary, a new source instance and a reopened process.
 * - `acknowledge()` is the only writer. It is a trusted in-process API: it requires the conversation
 *   to still be mapped with the same session key, and compares the stored cursor position with the
 *   cursor the batch was read against. A fresh segment must start at the cursor's next position
 *   with no skipped entry in the same conversation (entry IDs are global and interleave chats, so a
 *   zero-entry gap within the conversation is normal), and its end is re-proven as a completed
 *   boundary by walking that segment. The claimed chunk is re-derived from the committed transcript
 *   and compared evidence by evidence, so a malformed or forged batch is rejected instead of
 *   corrupting the cursor, and no acknowledgement can advance past evidence the transcript does not
 *   support.
 * - A batch with no evidence (a completed turn of tool-free non-evidence, for example) is still
 *   acknowledged, which counts as processed; the consumer must advance it without a model call.
 *
 * Compatibility with the earlier closed-episode cursor (one document, one reader, no migration
 * project):
 * - A document written by the closed-episode reader is read as the position that reader recorded:
 *   its acknowledged entry and message offset become this reader's next position inside that same
 *   entry, so an already digested range is never processed again and a frozen episode's bounds are
 *   continued so its remainder settles without a later owner turn. No second cursor is written and
 *   nothing is replayed. The offset is validated against the same prose extraction that produced it;
 *   an offset beyond that entry's message text, or one that would split a surrogate pair, fails
 *   closed instead of being guessed.
 * - Open tool calls at that frontier are derived once from the immutable segment prefix, so a result
 *   after the frontier still pairs with a call before it. The prefix is never revisited as evidence;
 *   tool steps in the frontier entry after the acknowledged offset are still read.
 * - The old fields are cleared on the first acknowledgement; a new cursor never writes them.
 *
 * Not here: model calls, memory writes, prompt or skill selection, scheduling, tool surface, and any
 * activation. `readBatch()` only re-derives a chunk a consumer already recorded, so resumable
 * execution does not depend on cross-conversation scan ordering. `cursor()` exposes the frontier for
 * status and tests.
 */
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  defineDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  DIGEST_CHARS_PER_BATCH_MIN,
  DIGEST_ENTRIES_PER_BATCH_MIN,
  DIGEST_RUN_LIMITS_DEFAULT,
  isDigestCharsBound,
  isDigestEntriesBound,
  type DigestBatchLimits,
} from "./digest-limits.js";
import { CRON_INPUT_ENTRY_KIND } from "../automation/cron.js";
import { validateMappedSessions } from "./index-db.js";
import type { HistoryChatSession } from "./scope.js";
import {
  COMPACT_PREVIEW_MARKER,
  PREVIEW_CHARS,
  type TextPreview,
  type TextShape,
  clipPreview,
  cutsSurrogatePair,
  evidenceSlice,
  isRecord,
  isUserInputKind,
  joinedParts,
  jsonText,
  messageText,
} from "./transcript.js";

import {
  createLegacyCompletedTurnReader,
  isLegacyDigestCursor,
  mapLegacyFrontier,
} from "./digestion-legacy.js";

// Shared transcript primitives keep their historical digestion export names.
export { COMPACT_PREVIEW_MARKER, clipPreview, cutsSurrogatePair, evidenceSlice, messageText };
export type { TextShape };
export { isLegacyDigestCursor };
export const DIGEST_CURSOR_KIND = "nanobot.digest-cursor";

/** Maximum characters in one head-tail tool-result preview, including its omission marker. */
export const DIGEST_PREVIEW_CHARS = PREVIEW_CHARS;

export const DIGEST_LIMITS = Object.freeze({
  /** Evidence entries examined by one batch; a longer segment continues in the next batch. */
  entriesPerBatch: DIGEST_RUN_LIMITS_DEFAULT.entriesPerBatch,
  /** Extracted evidence characters in one batch, cut but never dropped. */
  charsPerBatch: DIGEST_RUN_LIMITS_DEFAULT.charsPerBatch,
  /** Entries requested per Durable page. */
  entriesPerPage: 200,
  /**
   * Entries one read may examine while *looking* for the furthest completed boundary, across
   * conversations. This bounds discovery only: it does not bound a chunk, a gap check or a
   * segment-end walk. A range may span several completed turns inside this bound; a postponed chat
   * is retried by a later read instead of being skipped.
   */
  scanEntriesPerRead: 4_000,
  /** Mapped chat sessions accepted by one read. */
  maxMappedSessions: 256,
  /** Evidence steps in one chunk. */
  maxStepsPerBatch: 2_048,
  /** Evidence steps in one entry before the entry fails closed rather than growing without bound. */
  maxStepsPerEntry: 1_024,
  /** Calls that may stay open in one segment before the segment fails closed. */
  maxPendingToolCalls: 256,
  /** Longest accepted tool call id; a longer id fails the segment instead of orphaning its result. */
  maxToolCallIdChars: 200,
  /** Smallest remaining budget that may render a preview instead of ending the chunk first. */
  minPreviewBudget: 8,
});

/**
 * Resume position plus the immutable bounds and pairing state of the completed segment in progress.
 * `nextEntryId` null means nothing was acknowledged yet.
 */
export interface DigestCursor {
  readonly nextEntryId: EntryId | null;
  /** Next evidence step in that entry; 0 when the entry has not been entered yet. */
  readonly nextItemIndex: number;
  /** Offset inside that step's extracted text; 0 for a whole step. */
  readonly nextTextStart: number;
  /** Start of the completed segment being consumed in chunks, otherwise null. */
  readonly episodeStartEntryId: EntryId | null;
  /** End of that completed segment, otherwise null. */
  readonly episodeEndEntryId: EntryId | null;
  /** Tool call ids still open at this position. */
  readonly pendingToolCalls: readonly string[];
}

export type DigestTrust = "owner" | "assistant" | "untrusted-tool";

export type DigestItemKind = "message" | "tool-call" | "tool-result";

/** The omitted middle of a head-tail preview; `text` still holds the visible head and tail. */
export type DigestPreview = TextPreview;

/** One bounded evidence fragment or preview. */
export interface DigestEvidence {
  readonly entryId: EntryId;
  /** Step index within the entry's evidence plan; stable for this extraction version. */
  readonly itemIndex: number;
  readonly role: "user" | "assistant" | "tool";
  readonly trust: DigestTrust;
  /** Fixed human label; a renderer may use it verbatim. */
  readonly trustLabel: string;
  readonly itemKind: DigestItemKind;
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
  readonly preview: DigestPreview | null;
}

/** One bounded chunk of one completed segment. */
export interface DigestBatch {
  readonly status: "batch";
  /** Present for closed-episode selection; distinct from a historical frozen segment's end. */
  readonly closedEpisodeEndEntryId?: EntryId;
  /** Remaining rendered evidence size and actual packed chunks, for additional-episode admission. */
  readonly estimatedChars?: number;
  readonly estimatedChunks?: number;
  /** Mapped chat session that owns the conversation; the source label for the batch. */
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  /** Immutable bounds of the completed segment these entries belong to. */
  readonly episodeStartEntryId: EntryId;
  readonly episodeEndEntryId: EntryId;
  /** Lower bound of this chunk; the segment start for a new segment, else the cursor position. */
  readonly firstEntryId: EntryId;
  readonly firstItemIndex: number;
  /** Offset in `firstEntryId`'s item where this chunk starts. */
  readonly firstTextStart: number;
  /** Last entry and step this chunk consumed; `throughItemIndex` -1 means an entry boundary. */
  readonly throughEntryId: EntryId;
  readonly throughItemIndex: number;
  readonly throughChars: number;
  /** True when this chunk reaches the segment end and consumed it completely. */
  readonly complete: boolean;
  /** Position after this chunk; acknowledging writes exactly this into the cursor. */
  readonly nextEntryId: EntryId;
  readonly nextItemIndex: number;
  readonly nextTextStart: number;
  readonly entries: readonly DigestEvidence[];
  /** Frontier this batch was read against; acknowledging rejects if its position has moved. */
  readonly cursor: DigestCursor;
}

/**
 * Nothing to consume in this read, with unambiguous scan coverage.
 *
 * `caughtUp` is false while a chat was postponed by the scan budget, an unfinished scan stopped
 * mid-conversation, or a mapped conversation record is missing. A still-open exchange is not
 * pending work: it simply has no completed boundary yet.
 */
export interface DigestIdle {
  readonly status: "idle";
  readonly caughtUp: boolean;
  readonly examinedChats: number;
  readonly postponedChats: number;
  readonly unfinishedChats: number;
  readonly missingChats: number;
}

export type DigestReadResult = DigestBatch | DigestIdle;

/** The durable identity of one bounded chunk, without its evidence text. */
export interface DigestBatchRef {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  readonly episodeStartEntryId: EntryId;
  readonly episodeEndEntryId: EntryId;
  readonly firstEntryId: EntryId;
  readonly firstItemIndex: number;
  readonly firstTextStart: number;
  readonly throughEntryId: EntryId;
  readonly throughItemIndex: number;
  readonly throughChars: number;
  readonly complete: boolean;
  readonly cursor: DigestCursor;
}

/** Rejects a batch whose conversation frontier changed after the batch was read. */
export class DigestCursorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestCursorConflictError";
  }
}

export interface DigestSourceOptions {
  readonly harness: Harness;
  /**
   * Currently mapped chat sessions, already authenticated and classified by the host's shared
   * chat-scope provider (the same one the history index and episode catalog use).
   */
  readonly sessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  /**
   * Accepted bounds for new batches. Absent keeps {@link DIGEST_LIMITS}. A resumed consumer passes
   * the bounds captured with its batch instead of re-reading them from current configuration.
   */
  readonly limits?: DigestBatchLimits;
}

export interface DigestSource {
  /** Current frontier of one conversation; reads only. */
  cursor(conversationId: ConversationId, context: Context): Promise<DigestCursor>;
  /** The oldest unprocessed completed chunk across the mapped chats. Writes nothing. */
  read(context: Context, limits?: DigestBatchLimits): Promise<DigestReadResult>;
  /**
   * Product digest selection: closed episodes only. Optional conversation pins internal continuation.
   * An unpinned read also packs the whole chosen episode for its admission estimate
   * (`estimatedChars`/`estimatedChunks`); `estimate: false` skips that walk when the caller does not
   * admit by estimate. A pinned read never estimates.
   */
  readClosed(
    context: Context,
    limits?: DigestBatchLimits,
    conversationId?: ConversationId,
    options?: { readonly estimate?: boolean },
  ): Promise<DigestReadResult>;
  /**
   * Re-derive one chunk this source previously returned, from its recorded identity. Reads only.
   * The ref must name a currently mapped chat conversation and a range inside one completed
   * segment; the re-derived chunk must still match every recorded position and fragment.
   */
  readBatch(ref: DigestBatchRef, context: Context, limits?: DigestBatchLimits): Promise<DigestBatch>;
  /**
   * Record that a batch was successfully consumed, including a batch with no evidence. The frontier
   * update is one commit, validated against the committed transcript; a rejection leaves it
   * unchanged. `limits` must be the batch's captured bounds.
   */
  acknowledge(batch: DigestBatch, context: Context, limits?: DigestBatchLimits): Promise<DigestCursor>;
}

type DigestCursorDocument = {
  nextEntryId: number | null;
  nextItemIndex: number;
  nextTextStart: number;
  episodeStartEntryId: number | null;
  episodeEndEntryId: number | null;
  pendingToolCalls: string[];
  // Written only by the earlier closed-episode reader; cleared on the first acknowledgement.
  throughEntryId: number | null;
  throughChars: number | null;
};

export const DigestCursorDoc = defineDoc<DigestCursorDocument>({
  kind: DIGEST_CURSOR_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    nextEntryId: null,
    nextItemIndex: 0,
    nextTextStart: 0,
    episodeStartEntryId: null,
    episodeEndEntryId: null,
    pendingToolCalls: [],
    throughEntryId: null,
    throughChars: null,
  }),
  checkpointWhen: () => true,
});

const EMPTY_CURSOR: DigestCursor = Object.freeze({
  nextEntryId: null,
  nextItemIndex: 0,
  nextTextStart: 0,
  episodeStartEntryId: null,
  episodeEndEntryId: null,
  pendingToolCalls: Object.freeze([]) as readonly string[],
});

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
    throw new Error(`Stored digest cursor has an invalid ${field}`);
  }
  return value;
}

function storedOffset(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored digest cursor has an invalid ${field}`);
  }
  return value;
}

function pendingOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Stored digest cursor has invalid open tool calls");
  const pending = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("Stored digest cursor has an invalid open tool call id");
    }
    pending.add(item);
  }
  return Object.freeze([...pending].sort());
}

/**
 * Parse one stored cursor.
 *
 * A document written by the closed-episode reader is mapped exactly: its acknowledged entry and
 * message offset become the next position inside that same entry, and its frozen episode bounds are
 * continued. Tool calls still open at that position are derived by the source, because they need the
 * transcript.
 */
export function digestCursorOf(document: unknown): DigestCursor {
  if (document === undefined) return EMPTY_CURSOR;
  if (!isRecord(document)) throw new Error("Stored digest cursor is malformed");
  const episodeStartEntryId = storedId(document.episodeStartEntryId, "episode start");
  const episodeEndEntryId = storedId(document.episodeEndEntryId, "episode end");
  if ((episodeStartEntryId === null) !== (episodeEndEntryId === null)) {
    throw new Error("Stored digest cursor has half a segment boundary");
  }
  if (isLegacyDigestCursor(document)) {
    const throughEntryId = storedId(document.throughEntryId, "through entry");
    const throughChars = storedOffset(document.throughChars, "through offset");
    if ((throughEntryId === null) !== (throughChars === null)) {
      throw new Error("Stored digest cursor has half a through position");
    }
    if (episodeStartEntryId !== null && episodeEndEntryId !== null) {
      if (throughEntryId === null || episodeStartEntryId > throughEntryId || throughEntryId > episodeEndEntryId) {
        throw new Error("Stored digest cursor has an inconsistent episode position");
      }
    }
    if (throughEntryId === null || throughChars === null) {
      return {
        ...EMPTY_CURSOR,
        episodeStartEntryId: episodeStartEntryId as EntryId | null,
        episodeEndEntryId: episodeEndEntryId as EntryId | null,
      };
    }
    return {
      nextEntryId: throughEntryId as EntryId,
      nextItemIndex: 0,
      nextTextStart: throughChars,
      episodeStartEntryId: episodeStartEntryId as EntryId | null,
      episodeEndEntryId: episodeEndEntryId as EntryId | null,
      pendingToolCalls: Object.freeze([]) as readonly string[],
    };
  }
  const nextEntryId = storedId(document.nextEntryId, "next entry");
  const nextItemIndex = storedOffset(document.nextItemIndex, "next item");
  const nextTextStart = storedOffset(document.nextTextStart, "next offset");
  const pendingToolCalls = pendingOf(document.pendingToolCalls ?? []);
  if (nextEntryId === null && (episodeStartEntryId !== null || (nextItemIndex ?? 0) !== 0 || (nextTextStart ?? 0) !== 0 || pendingToolCalls.length !== 0)) {
    throw new Error("Stored digest cursor has a segment or offset without a next position");
  }
  return {
    nextEntryId: nextEntryId as EntryId | null,
    nextItemIndex: nextItemIndex ?? 0,
    nextTextStart: nextTextStart ?? 0,
    episodeStartEntryId: episodeStartEntryId as EntryId | null,
    episodeEndEntryId: episodeEndEntryId as EntryId | null,
    pendingToolCalls,
  };
}

/** Full equality, including pairing state. */
export function sameCursor(left: DigestCursor, right: DigestCursor): boolean {
  return sameCursorPosition(left, right)
    && left.pendingToolCalls.length === right.pendingToolCalls.length
    && left.pendingToolCalls.every((id, index) => right.pendingToolCalls[index] === id);
}

/**
 * Position equality only. Open calls are written in the same commit as the position, so a matching
 * position already proves the frontier did not move; comparing them too would reject a legacy
 * frontier whose open calls are derived rather than stored.
 */
function sameCursorPosition(left: DigestCursor, right: DigestCursor): boolean {
  return left.nextEntryId === right.nextEntryId
    && left.nextItemIndex === right.nextItemIndex
    && left.nextTextStart === right.nextTextStart
    && left.episodeStartEntryId === right.episodeStartEntryId
    && left.episodeEndEntryId === right.episodeEndEntryId;
}

export interface EvidenceShape extends TextShape {
  readonly role: "user" | "assistant";
  readonly kind: string;
}

/**
 * Message-only evidence shape of one entry, or undefined when it carries none. Used to validate a
 * legacy frontier offset against the exact extraction that produced it; reading uses
 * {@link planOf}, whose message item is this same text.
 */
export function evidenceShapeOf(entry: EntryRecord): EvidenceShape | undefined {
  const kind = entry.kind;
  const user = isUserInputKind(kind);
  const assistant = kind === AssistantEntry.kind;
  if (!user && !assistant) return undefined;
  if (!Array.isArray(entry.model)) return undefined;
  const parts: string[] = [];
  for (const raw of entry.model) {
    if (!isRecord(raw) || raw.role !== (user ? "user" : "assistant")) continue;
    const text = messageText(raw.content);
    if (text !== undefined && text.trim().length > 0) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  let length = parts.length - 1;
  for (const part of parts) length += part.length;
  return { role: user ? "user" : "assistant", kind, parts, length };
}

interface RawItem {
  readonly ref: string;
  readonly role: "user" | "assistant" | "tool";
  readonly trust: DigestTrust;
  readonly trustLabel: string;
  readonly itemKind: DigestItemKind;
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

function canonicalArguments(args: unknown): string {
  return jsonText(args, { absent: "null", unserializable: "[unserializable arguments]" });
}

/**
 * Pairing id of one tool call. An absent or non-string id cannot be paired and stays unpaired. An id
 * longer than {@link DIGEST_LIMITS.maxToolCallIdChars} fails closed: truncating or dropping it would
 * silently orphan the result that carries the same id, so the segment is refused instead.
 */
function callIdOf(value: unknown, entryId: EntryId): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > DIGEST_LIMITS.maxToolCallIdChars) {
    throw new Error(
      `Digest entry ${entryId} has a tool call id longer than ` +
      `${DIGEST_LIMITS.maxToolCallIdChars} characters`,
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
    if (steps.length >= DIGEST_LIMITS.maxStepsPerEntry) {
      throw new Error(
        `Digest entry ${entry.id} has more than ${DIGEST_LIMITS.maxStepsPerEntry} evidence steps`,
      );
    }
    steps.push(step);
    if (step.effect !== undefined) {
      if (step.effect.add) {
        if (!open.has(step.effect.callId) && open.size >= DIGEST_LIMITS.maxPendingToolCalls) {
          throw new Error(
            `Digest segment has more than ${DIGEST_LIMITS.maxPendingToolCalls} open tool calls`,
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

  if (isUserInputKind(kind)) {
    const parts: string[] = [];
    for (const raw of (entry.model ?? []) as readonly unknown[]) {
      if (!isRecord(raw) || raw.role !== "user") continue;
      const text = messageText(raw.content);
      if (text === undefined || text.trim().length === 0) continue;
      parts.push(text);
    }
    if (parts.length > 0) add({ item: messageItem("user", parts) });
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
        if (calls.length >= DIGEST_LIMITS.maxStepsPerEntry) {
          throw new Error(
            `Digest entry ${entry.id} has more than ${DIGEST_LIMITS.maxStepsPerEntry} tool calls`,
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
    if (parts.length > 0) add({ item: messageItem("assistant", parts) });
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
      const text = messageText(raw.content);
      const joined = text === undefined ? undefined : text;
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
export function assistantCalls(entry: EntryRecord): { readonly calls: readonly string[]; readonly terminal: boolean } {
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
            if (calls.length >= DIGEST_LIMITS.maxStepsPerEntry) {
              throw new Error(
                `Digest entry ${entry.id} has more than ${DIGEST_LIMITS.maxStepsPerEntry} tool calls`,
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
export function resultCalls(entry: EntryRecord): readonly string[] {
  const ids: string[] = [];
  for (const raw of (entry.model ?? []) as readonly unknown[]) {
    if (isRecord(raw) && raw.role === "toolResult") {
      const id = callIdOf(raw.toolCallId, entry.id);
      if (id !== null) {
        if (ids.length >= DIGEST_LIMITS.maxStepsPerEntry) {
          throw new Error(
            `Digest entry ${entry.id} has more than ${DIGEST_LIMITS.maxStepsPerEntry} tool results`,
          );
        }
        ids.push(id);
      }
    }
  }
  return ids;
}

function evidenceOfItem(
  item: RawItem,
  entryId: EntryId,
  itemIndex: number,
  textStart: number,
  text: string,
): DigestEvidence {
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
  readonly entries: readonly DigestEvidence[];
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
export async function readChunk(
  conversation: Conversation,
  firstEntryId: EntryId,
  firstItemIndex: number,
  firstTextStart: number,
  segmentEndEntryId: EntryId,
  pendingStart: readonly string[],
  limits: DigestBatchLimits,
  context: Context,
): Promise<Chunk> {
  const entries: DigestEvidence[] = [];
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
      Math.min(DIGEST_LIMITS.entriesPerPage, limits.entriesPerBatch - entryCount),
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
      // IDs are global: a zero-entry gap may precede this actual entry. A mid-item cut must
      // checkpoint THIS ID, not the nominal lower bound, or the next read would replay its head.
      entryId = entry.id;
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
        if (stepCount >= DIGEST_LIMITS.maxStepsPerBatch) {
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
        let emitted: DigestEvidence;
        let consumedThrough: number;
        let whole: boolean;
        if (item.preview) {
          const shape = joinedParts(item.parts);
          if (item.length <= DIGEST_PREVIEW_CHARS && item.length <= remaining) {
            emitted = evidenceOfItem(item, entry.id, index, 0, evidenceSlice(shape, 0, item.length));
          } else {
            if (used > 0 && remaining < DIGEST_LIMITS.minPreviewBudget) {
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
    throw new Error("Digest segment has no entries at the requested position");
  }
  if (entryId > segmentEndEntryId) {
    entryId = (segmentEndEntryId + 1) as EntryId;
    itemIndex = 0;
    textStart = 0;
  }
  return {
    entries,
    throughEntryId: lastEntryId,
    throughItemIndex: lastItemIndex,
    throughChars: lastChars,
    complete: entryId > segmentEndEntryId,
    nextEntryId: entryId,
    nextItemIndex: itemIndex,
    nextTextStart: textStart,
    pendingToolCalls: Object.freeze([...pending].sort()),
  };
}

/**
 * Validate the host's mapped chat sessions; they name authorization, not content.
 */
export function validateSessions(sessions: readonly HistoryChatSession[]): void {
  validateMappedSessions(sessions, "Digest", "input", DIGEST_LIMITS.maxMappedSessions);
}

function validateCursor(cursor: unknown): DigestCursor {
  if (!isRecord(cursor)) throw new TypeError("Digest cursor must be an object");
  const nextEntryId = cursor.nextEntryId === null
    ? null
    : positiveId(cursor.nextEntryId, "Digest cursor next entry");
  const nextItemIndex = nonNegative(cursor.nextItemIndex, "Digest cursor next item");
  const nextTextStart = nonNegative(cursor.nextTextStart, "Digest cursor next offset");
  const episodeStartEntryId = cursor.episodeStartEntryId === null
    ? null
    : positiveId(cursor.episodeStartEntryId, "Digest cursor segment start");
  const episodeEndEntryId = cursor.episodeEndEntryId === null
    ? null
    : positiveId(cursor.episodeEndEntryId, "Digest cursor segment end");
  const pendingToolCalls = pendingOf(cursor.pendingToolCalls ?? []);
  if ((episodeStartEntryId === null) !== (episodeEndEntryId === null)) {
    throw new TypeError("Digest cursor must name both segment bounds or neither");
  }
  if (episodeStartEntryId !== null && episodeEndEntryId !== null) {
    if (episodeStartEntryId > episodeEndEntryId) {
      throw new TypeError("Digest cursor segment bounds are inverted");
    }
    if (nextEntryId === null || nextEntryId > episodeEndEntryId) {
      throw new TypeError("Digest cursor position is outside its segment");
    }
  } else if (nextEntryId === null && (nextItemIndex !== 0 || nextTextStart !== 0)) {
    throw new TypeError("Digest cursor has a position before the first entry");
  }
  return {
    nextEntryId,
    nextItemIndex,
    nextTextStart,
    episodeStartEntryId,
    episodeEndEntryId,
    pendingToolCalls,
  };
}

function validateBatchRef(ref: DigestBatchRef): void {
  if (ref === null || typeof ref !== "object") throw new TypeError("Digest batch ref must be an object");
  if (typeof ref.sessionKey !== "string" || ref.sessionKey.length === 0) {
    throw new TypeError("Digest batch ref session key must be a non-empty string");
  }
  const conversationId = ref.conversationId as number;
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new TypeError("Digest batch ref conversation ID must be a positive safe integer");
  }
  const start = positiveId(ref.episodeStartEntryId, "Digest batch ref segment start");
  const end = positiveId(ref.episodeEndEntryId, "Digest batch ref segment end");
  const first = positiveId(ref.firstEntryId, "Digest batch ref first entry");
  const through = positiveId(ref.throughEntryId, "Digest batch ref through entry");
  const firstItem = nonNegative(ref.firstItemIndex, "Digest batch ref first item");
  const throughItem = ref.throughItemIndex;
  if (typeof throughItem !== "number" || !Number.isSafeInteger(throughItem) || throughItem < -1) {
    throw new TypeError("Digest batch ref through item must be an integer of at least -1");
  }
  const firstTextStart = nonNegative(ref.firstTextStart, "Digest batch ref first offset");
  nonNegative(ref.throughChars, "Digest batch ref through offset");
  if (!(start <= first && first <= through && through <= end)) {
    throw new TypeError("Digest batch ref entry range is inconsistent");
  }
  if (first === through && throughItem !== -1 && throughItem < firstItem) {
    throw new TypeError("Digest batch ref item range is inconsistent");
  }
  if (typeof ref.complete !== "boolean") throw new TypeError("Digest batch ref completeness must be a boolean");
  if (ref.complete && through !== end) {
    throw new TypeError("Digest batch ref cannot complete before its segment end");
  }
  const cursor = validateCursor(ref.cursor);
  if (cursor.episodeStartEntryId !== null) {
    if (start !== cursor.episodeStartEntryId || end !== cursor.episodeEndEntryId) {
      throw new TypeError("Digest batch ref does not continue its cursor's segment");
    }
    if (first !== cursor.nextEntryId || firstItem !== cursor.nextItemIndex
      || firstTextStart !== cursor.nextTextStart) {
      throw new TypeError("Digest batch ref does not continue at its cursor position");
    }
  } else {
    if (first !== start) throw new TypeError("Digest batch ref must start its segment at its start");
    // A fresh segment starts at the cursor's position. Only a frontier mapped from the earlier
    // closed-episode cursor holds a non-zero item or offset here; a settled frontier is 0/0.
    if (firstItem !== cursor.nextItemIndex || firstTextStart !== cursor.nextTextStart) {
      throw new TypeError("Digest batch ref must start a fresh segment at its cursor position");
    }
    if (cursor.nextEntryId !== null && cursor.nextEntryId > first) {
      throw new TypeError("Digest batch ref starts before its cursor frontier");
    }
  }
}

function validateBatchShape(batch: DigestBatch): void {
  if (batch === null || typeof batch !== "object") throw new TypeError("Digest batch must be an object");
  if (batch.status !== "batch") throw new TypeError("Digest batch status is invalid");
  validateBatchRef(batch as unknown as DigestBatchRef);
  const first = batch.firstEntryId;
  const through = batch.throughEntryId;
  if (through < first) throw new TypeError("Digest batch ends before it starts");
  if (batch.complete && through !== batch.episodeEndEntryId) {
    throw new TypeError("Digest batch cannot complete before its segment end");
  }
  if (!Array.isArray(batch.entries)) throw new TypeError("Digest batch entries must be an array");
  let previousEntry = 0;
  let previousItem = -1;
  for (const entry of batch.entries as readonly unknown[]) {
    if (!isRecord(entry)) throw new TypeError("Digest evidence must be an object");
    const entryId = positiveId(entry.entryId, "Digest evidence entry ID");
    const itemIndex = nonNegative(entry.itemIndex, "Digest evidence item index");
    if (entryId < first || entryId > through || entryId < previousEntry
      || (entryId === previousEntry && itemIndex <= previousItem)) {
      throw new TypeError("Digest evidence is outside or out of order in its chunk");
    }
    previousEntry = entryId;
    previousItem = itemIndex;
    if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") {
      throw new TypeError("Digest evidence role is invalid");
    }
    if (entry.trust !== "owner" && entry.trust !== "assistant" && entry.trust !== "untrusted-tool") {
      throw new TypeError("Digest evidence trust label is invalid");
    }
    if (entry.itemKind !== "message" && entry.itemKind !== "tool-call" && entry.itemKind !== "tool-result") {
      throw new TypeError("Digest evidence item kind is invalid");
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new TypeError("Digest evidence durable kind must be a non-empty string");
    }
    if (typeof entry.ref !== "string" || entry.ref.length === 0) {
      throw new TypeError("Digest evidence reference must be a non-empty string");
    }
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      throw new TypeError("Digest evidence text must be non-empty");
    }
    const textStart = nonNegative(entry.textStart, "Digest evidence text offset");
    const chars = positiveId(entry.chars, "Digest evidence length");
    if (textStart >= chars) throw new TypeError("Digest evidence starts beyond its item");
    if (entry.preview === null) {
      if (textStart + entry.text.length > chars) {
        throw new TypeError("Digest evidence fragment is outside its item text");
      }
    } else {
      if (textStart !== 0) throw new TypeError("Digest preview must start at its item start");
      if (!isRecord(entry.preview)) throw new TypeError("Digest preview is malformed");
      const preview = entry.preview;
      nonNegative(preview.headChars, "Digest preview head");
      nonNegative(preview.tailChars, "Digest preview tail");
      nonNegative(preview.omittedStart, "Digest preview omitted start");
      nonNegative(preview.omittedEnd, "Digest preview omitted end");
      nonNegative(preview.omittedChars, "Digest preview omitted length");
      if (typeof preview.marker !== "string" || preview.marker.length === 0) {
        throw new TypeError("Digest preview marker must be non-empty");
      }
    }
  }
  const advanced = batch.complete
    || through > first
    || (through === first && batch.throughItemIndex >= batch.firstItemIndex);
  if (!advanced) throw new TypeError("Digest acknowledgement does not advance the cursor");
}

export async function entryAt(
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
 * transcript. A reset or the next owner/scheduled input after the end closes it; otherwise the end
 * must be a terminal assistant entry with no open calls. The walk is paged and reads only the
 * segment.
 */
async function validateCompletedSegment(
  conversation: Conversation,
  startEntryId: EntryId,
  endEntryId: EntryId,
  context: Context,
): Promise<void> {
  const start = await entryAt(conversation, startEntryId, context);
  if (start === undefined) throw new TypeError("Digest segment start is not a committed entry");
  let sawInput = false;
  let hasContent = false;
  const pending = new Set<string>();
  let terminalEntryId: EntryId | null = null;
  let cursor: Cursor | undefined;
  let entryId = startEntryId;
  while (entryId <= endEntryId) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: entryId, maxEntryId: endEntryId },
      DIGEST_LIMITS.entriesPerPage,
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      if (entry.kind === ResetEntry.kind) {
        if (sawInput) throw new TypeError("Digest segment spans a reset after its owner turn");
        continue;
      }
      hasContent = true;
      if (isUserInputKind(entry.kind)) {
        sawInput = true;
        pending.clear();
        terminalEntryId = null;
      } else if (entry.kind === AssistantEntry.kind) {
        const parsed = assistantCalls(entry);
        for (const callId of parsed.calls) {
          if (!pending.has(callId) && pending.size >= DIGEST_LIMITS.maxPendingToolCalls) {
            throw new TypeError("Digest segment has too many open tool calls");
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
  if (!hasContent) throw new TypeError("Digest segment holds no content");
  const closing = (await conversation.entries(
    { order: "ascending", minEntryId: (endEntryId + 1) as EntryId },
    1,
    undefined,
    context,
  )).items[0];
  if (closing?.kind === ResetEntry.kind) return;
  if (!sawInput) throw new TypeError("Digest segment does not open an owner or scheduled turn");
  if (closing !== undefined && (isUserInputKind(closing.kind))) return;
  if (terminalEntryId !== endEntryId || pending.size > 0) {
    throw new TypeError("Digest segment end is not a completed exchange boundary");
  }
}

/**
 * Prove that a fresh segment's start did not hop over an unconsumed entry in the same conversation.
 * Entry IDs are global and interleave other chats, so a zero-entry gap within this conversation is
 * normal; any entry in it is refused rather than silently skipped. The gap is bounded by one read's
 * scan budget; a longer one is refused rather than assumed.
 */
async function validateFreshSegmentGap(
  conversation: Conversation,
  batch: Pick<DigestBatch, "firstEntryId" | "cursor">,
  context: Context,
): Promise<void> {
  const gapFrom = batch.cursor.nextEntryId ?? (1 as EntryId);
  const gapTo = (batch.firstEntryId - 1) as EntryId;
  if (gapTo < gapFrom) return;
  const gap = await conversation.entries(
    { order: "ascending", minEntryId: gapFrom, maxEntryId: gapTo },
    DIGEST_LIMITS.scanEntriesPerRead + 1,
    undefined,
    context,
  );
  if (gap.items.length > DIGEST_LIMITS.scanEntriesPerRead || gap.next !== undefined) {
    throw new TypeError("Digest segment start is too far from its cursor to verify");
  }
  if (gap.items.length > 0) {
    throw new TypeError("Digest segment start would skip an earlier entry with content");
  }
}

/**
 * Reject batch bounds that could not progress, at every direct entry point. Two entries per chunk is
 * the minimum because a one-entry chunk stuck on a non-evidence entry would be refused as
 * non-advancing and re-offered forever; two characters is the minimum that can hold a surrogate pair.
 */
function requireBatchLimits(limits: DigestBatchLimits): DigestBatchLimits {
  if (!isDigestEntriesBound(limits.entriesPerBatch) || !isDigestCharsBound(limits.charsPerBatch)) {
    throw new TypeError(
      `digest batch bounds must be positive safe integers, with entriesPerBatch at least ` +
      `${DIGEST_ENTRIES_PER_BATCH_MIN} and charsPerBatch at least ${DIGEST_CHARS_PER_BATCH_MIN}`,
    );
  }
  return limits;
}

function sameEvidence(left: DigestEvidence, right: DigestEvidence): boolean {
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

function samePreview(left: DigestPreview | null, right: DigestPreview | null): boolean {
  if (left === null || right === null) return left === right;
  return left.headChars === right.headChars
    && left.tailChars === right.tailChars
    && left.omittedStart === right.omittedStart
    && left.omittedEnd === right.omittedEnd
    && left.omittedChars === right.omittedChars
    && left.marker === right.marker;
}

function cloneEvidence(entry: DigestEvidence): DigestEvidence {
  return {
    ...entry,
    preview: entry.preview === null ? null : { ...entry.preview },
  };
}

function freezeChunk(chunk: Chunk): Chunk {
  return Object.freeze({
    ...chunk,
    entries: Object.freeze(chunk.entries.map((entry) => Object.freeze({
      ...entry,
      preview: entry.preview === null ? null : Object.freeze({ ...entry.preview }),
    }))),
  });
}

function cloneEntries(entries: readonly DigestEvidence[]): DigestEvidence[] {
  return entries.map(cloneEvidence);
}

/** Find the real episode opening even when an older cursor already consumed its prefix. */
async function episodeStartAt(conversation: Conversation, at: EntryId, context: Context): Promise<EntryId> {
  let pageCursor: Cursor | undefined;
  let first = at;
  do {
    const page = await conversation.entries({ order: "descending", maxEntryId: at },
      DIGEST_LIMITS.entriesPerPage, pageCursor, context);
    for (const entry of page.items) {
      if (entry.kind === ResetEntry.kind) return entry.id;
      first = entry.id;
    }
    pageCursor = page.next;
  } while (pageCursor !== undefined);
  return first;
}

export function createDigestSource(options: DigestSourceOptions): DigestSource {
  const configured = requireBatchLimits(options.limits ?? DIGEST_LIMITS);

  /**
   * The stored cursor, plus the open tool calls of a frontier mapped from the earlier closed-episode
   * cursor (`mapLegacyFrontier`).
   */
  const cursorFor = async (conversationId: ConversationId, context: Context): Promise<DigestCursor> => {
    const document = await options.harness.snapshot(DigestCursorDoc, conversationId, context);
    const cursor = digestCursorOf(document);
    if (!isLegacyDigestCursor(document)) {
      if (cursor.nextEntryId !== null && (cursor.nextItemIndex > 0 || cursor.nextTextStart > 0)) {
        const conversation = await options.harness.conversation(conversationId, context);
        if (conversation === undefined || await entryAt(conversation, cursor.nextEntryId, context) === undefined) {
          throw new Error("Stored digest item offset has no committed entry; refusing to replay evidence");
        }
      }
      return cursor;
    }
    return mapLegacyFrontier(options, conversationId, cursor, context);
  };

  const legacy = createLegacyCompletedTurnReader(options, cursorFor);

  // The chunk `readClosed()` last returned, so the `readBatch()` that re-derives that accepted batch
  // does not walk the same entries again. A chunk reads only committed entries up to its segment
  // end, which are immutable, so it is a pure function of its position, pairing state and bounds.
  // Acknowledgement still re-derives from Durable on its own.
  let selected: { readonly key: string; readonly chunk: Chunk } | undefined;
  const chunkKey = (
    conversationId: ConversationId, first: EntryId, itemIndex: number, textStart: number,
    end: EntryId, pending: readonly string[], limits: DigestBatchLimits,
  ): string => JSON.stringify([conversationId, first, itemIndex, textStart, end, pending, limits]);

  return {
    cursor(conversationId, context) {
      positiveId(conversationId as number, "Digest conversation ID");
      return cursorFor(conversationId, context);
    },

    async read(context, limits) {
      return legacy.read(context, requireBatchLimits(limits ?? configured));
    },

    async readClosed(context, limits, onlyConversationId, readOptions) {
      const batchLimits = requireBatchLimits(limits ?? configured);
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const candidates: { session: HistoryChatSession; conversation: Conversation; cursor: DigestCursor;
        start: EntryId; orderStart: EntryId; end: EntryId }[] = [];
      let missingChats = 0;
      let examinedChats = 0;
      for (const session of sessions) {
        if (onlyConversationId !== undefined && session.conversationId !== onlyConversationId) continue;
        const conversation = await options.harness.conversation(session.conversationId, context);
        if (conversation === undefined) { missingChats += 1; continue; }
        examinedChats += 1;
        const cursor = await cursorFor(session.conversationId, context);
        // Walk pages, never accumulate an episode's transcript. A reset, not an assistant answer,
        // closes eligibility. Start at the existing frontier, never replay its consumed prefix.
        let pageCursor: Cursor | undefined;
        let start: EntryId | undefined;
        let end: EntryId | undefined;
        let orderStart: EntryId | undefined;
        let content = false;
        let closed = false;
        do {
          const page = await conversation.entries(
            { order: "ascending", minEntryId: cursor.nextEntryId ?? (1 as EntryId) },
            DIGEST_LIMITS.entriesPerPage, pageCursor, context,
          );
          for (const entry of page.items) {
            start ??= entry.id;
            if (entry.kind === ResetEntry.kind && content) { closed = true; break; }
            if (entry.kind === ResetEntry.kind) orderStart = entry.id;
            else content = true;
            end = entry.id;
          }
          if (closed) break;
          pageCursor = page.next;
        } while (pageCursor !== undefined);
        if (closed && start !== undefined && end !== undefined) {
          // Consumption still starts at the frontier: empty resets must not be skipped by an
          // acknowledgement. Ordering uses the real non-empty episode's latest opening reset.
          orderStart ??= await episodeStartAt(conversation, start, context);
          candidates.push({ session, conversation, cursor, start, orderStart, end });
        }
      }
      candidates.sort((a, b) => a.orderStart - b.orderStart || a.session.conversationId - b.session.conversationId);
      const chosen = candidates[0];
      if (chosen === undefined) return {
        status: "idle", caughtUp: missingChats === 0, examinedChats, postponedChats: 0,
        unfinishedChats: 0, missingChats,
      };
      // An upgrade may resume a frozen completed-turn segment inside this closed episode. Finish
      // that immutable segment first; the caller continues through the real closing boundary.
      const start = chosen.cursor.episodeStartEntryId ?? chosen.start;
      const end = chosen.cursor.episodeEndEntryId ?? chosen.end;
      const first = chosen.cursor.episodeStartEntryId === null ? chosen.start : chosen.cursor.nextEntryId!;
      const chunk = await readChunk(chosen.conversation, first, chosen.cursor.nextItemIndex,
        chosen.cursor.nextTextStart, end, chosen.cursor.pendingToolCalls, batchLimits, context);
      selected = {
        key: chunkKey(chosen.session.conversationId, first, chosen.cursor.nextItemIndex,
          chosen.cursor.nextTextStart, end, chosen.cursor.pendingToolCalls, batchLimits),
        chunk: freezeChunk(chunk),
      };
      let estimatedChars: number | undefined;
      let estimatedChunks: number | undefined;
      if (onlyConversationId === undefined && readOptions?.estimate !== false) {
        // Use the actual chunk reader, not ratios of total characters/entries/steps: those limits
        // interact, and previews, UTF-16 cuts and resumed entries also change packing. Retain only
        // the first bounded chunk. Pinned internal continuation needs no admission estimate.
        let packed = chunk;
        let packedEnd = end;
        estimatedChunks = 1;
        estimatedChars = packed.entries.reduce((total, entry) => total + entry.text.length, 0);
        while (packed.nextEntryId <= chosen.end) {
          if (packed.complete) packedEnd = chosen.end;
          packed = await readChunk(chosen.conversation, packed.nextEntryId, packed.nextItemIndex,
            packed.nextTextStart, packedEnd, packed.complete ? [] : packed.pendingToolCalls, batchLimits, context);
          estimatedChunks += 1;
          estimatedChars += packed.entries.reduce((total, entry) => total + entry.text.length, 0);
        }
      }
      return {
        status: "batch", sessionKey: chosen.session.sessionKey, conversationId: chosen.session.conversationId,
        closedEpisodeEndEntryId: chosen.end,
        ...(estimatedChunks === undefined ? {} : { estimatedChars: estimatedChars!, estimatedChunks }),
        episodeStartEntryId: start, episodeEndEntryId: end, firstEntryId: first,
        firstItemIndex: chosen.cursor.nextItemIndex, firstTextStart: chosen.cursor.nextTextStart,
        throughEntryId: chunk.throughEntryId, throughItemIndex: chunk.throughItemIndex,
        throughChars: chunk.throughChars, complete: chunk.complete, nextEntryId: chunk.nextEntryId,
        nextItemIndex: chunk.nextItemIndex, nextTextStart: chunk.nextTextStart,
        entries: chunk.entries, cursor: chosen.cursor,
      };
    },

    async readBatch(ref, context, limits) {
      validateBatchRef(ref);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = ref.conversationId;
      const conversation = await options.harness.conversation(conversationId, context);
      if (conversation === undefined) throw new TypeError("Digest batch ref conversation is not committed");
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (session === undefined || session.sessionKey !== ref.sessionKey) {
        throw new TypeError("Digest batch ref is not a currently mapped chat session");
      }
      const start = await entryAt(conversation, ref.episodeStartEntryId, context);
      if (start === undefined) throw new TypeError("Digest batch ref segment start is not committed");
      if (ref.cursor.episodeStartEntryId === null) {
        await validateFreshSegmentGap(conversation, ref, context);
        await validateCompletedSegment(
          conversation,
          ref.episodeStartEntryId,
          ref.episodeEndEntryId,
          context,
        );
      }
      const key = chunkKey(conversationId, ref.firstEntryId, ref.firstItemIndex, ref.firstTextStart,
        ref.episodeEndEntryId, ref.cursor.pendingToolCalls, batchLimits);
      const cached = selected?.key === key;
      const chunk = cached ? selected!.chunk : await readChunk(
        conversation,
        ref.firstEntryId,
        ref.firstItemIndex,
        ref.firstTextStart,
        ref.episodeEndEntryId,
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
        throw new TypeError("Digest batch ref no longer matches the committed transcript");
      }
      return {
        status: "batch",
        sessionKey: ref.sessionKey,
        conversationId,
        episodeStartEntryId: ref.episodeStartEntryId,
        episodeEndEntryId: ref.episodeEndEntryId,
        firstEntryId: ref.firstEntryId,
        firstItemIndex: ref.firstItemIndex,
        firstTextStart: ref.firstTextStart,
        throughEntryId: chunk.throughEntryId,
        throughItemIndex: chunk.throughItemIndex,
        throughChars: chunk.throughChars,
        complete: chunk.complete,
        nextEntryId: chunk.nextEntryId,
        nextItemIndex: chunk.nextItemIndex,
        nextTextStart: chunk.nextTextStart,
        entries: cached ? cloneEntries(chunk.entries) : chunk.entries,
        cursor: ref.cursor,
      };
    },

    async acknowledge(batch, context, limits) {
      validateBatchShape(batch);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = batch.conversationId;
      const conversation = await options.harness.conversation(conversationId, context);
      if (conversation === undefined) {
        throw new TypeError("Digest batch conversation is not a committed conversation");
      }
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (session === undefined || session.sessionKey !== batch.sessionKey) {
        throw new TypeError("Digest batch is not a currently mapped chat session");
      }
      if (batch.cursor.episodeStartEntryId === null) {
        await validateFreshSegmentGap(conversation, batch, context);
        await validateCompletedSegment(
          conversation,
          batch.episodeStartEntryId,
          batch.episodeEndEntryId,
          context,
        );
      } else if (
        batch.episodeStartEntryId !== batch.cursor.episodeStartEntryId
        || batch.episodeEndEntryId !== batch.cursor.episodeEndEntryId
      ) {
        throw new TypeError("Digest batch does not continue its cursor's segment");
      }
      const rederived = await readChunk(
        conversation,
        batch.firstEntryId,
        batch.firstItemIndex,
        batch.firstTextStart,
        batch.episodeEndEntryId,
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
        throw new TypeError("Digest batch does not match the committed transcript");
      }
      for (let index = 0; index < rederived.entries.length; index += 1) {
        if (!sameEvidence(rederived.entries[index]!, batch.entries[index]!)) {
          throw new TypeError("Digest evidence does not match the committed transcript");
        }
      }
      const next: DigestCursor = rederived.complete
        ? {
          nextEntryId: rederived.nextEntryId,
          nextItemIndex: 0,
          nextTextStart: 0,
          episodeStartEntryId: null,
          episodeEndEntryId: null,
          pendingToolCalls: Object.freeze([]) as readonly string[],
        }
        : {
          nextEntryId: rederived.nextEntryId,
          nextItemIndex: rederived.nextItemIndex,
          nextTextStart: rederived.nextTextStart,
          episodeStartEntryId: batch.episodeStartEntryId,
          episodeEndEntryId: batch.episodeEndEntryId,
          pendingToolCalls: rederived.pendingToolCalls,
        };
      await options.harness.commit(async (tx) => {
        const document = await tx.doc(DigestCursorDoc, conversationId);
        // Position only: open calls are written in the same commit and a mapped legacy frontier
        // derives them from the immutable transcript, so comparing them would reject a valid batch.
        if (!sameCursorPosition(digestCursorOf(document), batch.cursor)) {
          throw new DigestCursorConflictError(
            "Digest cursor moved after this batch was read; re-read before acknowledging",
          );
        }
        document.nextEntryId = next.nextEntryId;
        document.nextItemIndex = next.nextItemIndex;
        document.nextTextStart = next.nextTextStart;
        document.episodeStartEntryId = next.episodeStartEntryId;
        document.episodeEndEntryId = next.episodeEndEntryId;
        document.pendingToolCalls = [...next.pendingToolCalls];
        document.throughEntryId = null;
        document.throughChars = null;
      }, context);
      legacy.forget(conversationId);
      return next;
    },
  };
}
