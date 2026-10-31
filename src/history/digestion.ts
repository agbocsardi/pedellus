/**
 * Bounded, lossless, source-labeled input for later conversation digestion, plus its cursor.
 *
 * This module reads only; it calls no model, writes no memory, creates no task and
 * schedules nothing. `read()` returns one bounded chunk of one *closed* episode from
 * one mapped chat conversation. `acknowledge()` moves that conversation's cursor after
 * the caller has successfully consumed the chunk. A read that is never acknowledged
 * advances nothing, so a failure or restart replays the same evidence.
 *
 * Trust contract (no parallel scope framework):
 * - The host is the authorization boundary. It must pass the same mapped chat sessions
 *   its own provider already authenticated and classified through `readChatSessions`
 *   and `partitionChatScope`; this module does not re-derive root/fork/task ownership.
 *   It only rejects shape errors a host callback should never produce: an empty or
 *   channel-state session key, an invalid conversation ID, a repeated conversation ID,
 *   or more than {@link DIGEST_LIMITS.maxMappedSessions} mappings. A session provider
 *   that has not applied the shared chat-scope rule is a host bug, not something this
 *   module tries to repair.
 * - Every batch names its session key, conversation and episode entry IDs. Each evidence
 *   fragment names the entry it came from and its UTF-16 code-unit range in that entry's
 *   extracted text, so a consumer can cite the original transcript and finish a long entry
 *   across batches. A fragment never ends between the halves of a surrogate pair, so UTF-8
 *   encoding cannot introduce a replacement character. Durable remains the only transcript
 *   authority: nothing here copies the transcript into a second archive.
 * - Only closed episodes are evidence. An episode closes when a `pi.reset` entry is
 *   committed after it; the current, still-open segment is never returned. Empty
 *   segments (a reset with no following entry) are skipped and are not evidence.
 * - A reset entry's handoff message is synthetic context, not owner speech, so it is
 *   never returned as evidence. System, compaction and unknown entries are consumed as
 *   part of the episode range but contribute no evidence item.
 * - The episode range includes its reset marker, exactly as the episode catalog records
 *   it. Evidence is *message* text only: a user entry's text (owner speech, or a
 *   `nanobot.cron` trigger) and an assistant entry's text. A `pi.tool-result` entry, an
 *   assistant tool-call part and any tool output are never evidence — digestion folds what
 *   was said, not what a tool did, and tool output is untrusted machine text that would
 *   dominate the batch. Such entries are still consumed as part of the episode range and
 *   advance the cursor with no fragment, so nothing is skipped and a long episode's backend
 *   traffic cannot inflate its evidence.
 *   `nanobot.cron` entries are kept with that exact `kind`, so a consumer can treat a
 *   scheduled trigger as provenance rather than owner speech. Worker child transcripts
 *   are task-owned conversations and are never in scope; worker result events are not
 *   evidence either, and nothing here reads them.
 *
 * Evidence is lossless, not excerpted:
 * - One evidence item is a fragment `[textStart, textStart + text.length)` of its entry's
 *   extracted text, with the entry's full `chars` length. A fragment is bounded by the
 *   remaining batch budget, so a long entry continues in the next batch from exactly
 *   where this one stopped. Nothing is dropped and no `truncated` flag can be used to
 *   discard a tail.
 * - A batch's evidence never exceeds {@link DIGEST_LIMITS.charsPerBatch}; the fragment
 *   that reaches the budget is cut, and the rest of that entry is the next batch.
 * - One batch is one whole closed episode whenever that episode's selected evidence fits
 *   both bounds ({@link DIGEST_LIMITS.charsPerBatch} and
 *   {@link DIGEST_LIMITS.entriesPerBatch}), however many entries the episode holds: it is
 *   read in one pass, delivered with `complete: true` and acknowledged once. Only an episode
 *   over a bound splits, and then into independent ordered chunks that each carry their own
 *   acknowledgement. There is no carry-over note, running summary or cross-chunk state: a
 *   chunk is judged only against its capture and the committed transcript.
 *
 * The cursor is one small conversation-scoped document, not a second history archive:
 *
 * - `throughEntryId`/`throughChars` are the last entry and the number of extracted-text
 *   characters of that entry whose evidence has been acknowledged. Entries below it are
 *   consumed or non-evidence (an empty segment, or a reset marker whose handoff is not
 *   evidence).
 * - `episodeStartEntryId`/`episodeEndEntryId` are set only while a closed episode is
 *   being consumed in bounded chunks. They name the immutable episode bounds so the next
 *   batch continues the same episode instead of inventing a new boundary.
 * - `acknowledge()` is the only writer. It is a trusted in-process API: it does not re-check
 *   the mapped chat set (the host owns that) and instead compares the stored cursor with the
 *   cursor the batch was read against and re-derives the episode bounds and claimed chunk
 *   from the committed transcript before advancing. A fresh chunk must start at its claimed
 *   episode start, the entries between the previous frontier (or the transcript beginning)
 *   and that start may hold no content, the claimed end must be a committed non-reset entry
 *   whose successor is the `pi.reset` that closes the episode, every entry in the claimed
 *   range must be covered (with the exact text at the claimed offsets), and a continued
 *   chunk must resume at the stored position. New episode bounds are additionally proven by
 *   walking that episode to its first closing reset (paged, bounded memory, once per new
 *   episode), so a claimed end cannot span an earlier reset. A malformed or forged batch is
 *   rejected instead of corrupting the cursor, so no acknowledgement can advance the
 *   frontier past evidence the transcript does not support.
 * - A batch with no evidence (a "nothing worth remembering" episode, or an episode of
 *   non-evidence entries) is still acknowledged, which counts as processed.
 *
 * Ordering and bounds:
 * - Within one conversation, episodes are consumed oldest first by entry ID. Across
 *   conversations the oldest discovered next position is served first, but a bounded read
 *   budget can postpone discovery in a conversation that has not been scanned recently;
 *   that only delays evidence, never skips it, and each conversation's cursor stays
 *   monotonic. The scan budget rotates its starting conversation, so one busy chat cannot
 *   postpone the others indefinitely.
 * - Entry IDs are immutable and unique across one store, so there is no timestamp tie to
 *   break and a restart resumes exactly at the acknowledged frontier.
 * - A read that finds no pending chunk reports how much of the mapped set it examined:
 *   `caughtUp` is true only when every mapped chat was examined to its tail. A specific
 *   chat can be postponed by the scan budget, and a mapped conversation whose record is
 *   missing is counted separately instead of being reported as caught up.
 * - The scan that looks for the next closed episode is bounded per read and resumes from an
 *   in-process position cache, so a long still-open conversation is not rescanned from its
 *   start on every pass. The cache is derived, is dropped whenever that conversation's
 *   cursor moves, and is lost on restart; losing it costs a repeated bounded scan and never
 *   changes the frontier.
 *
 * Not here: model calls, memory writes, prompt or skill selection, scheduling, tool
 * surface, and any activation. `readBatch()` only re-derives a chunk a consumer already
 * recorded, so resumable execution does not depend on cross-conversation scan ordering.
 * `cursor()` exposes the frontier for status and tests.
 */
import {
  AssistantEntry,
  ResetEntry,
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
  DIGEST_CHARS_PER_BATCH_MIN,
  DIGEST_ENTRIES_PER_BATCH_MIN,
  DIGEST_RUN_LIMITS_DEFAULT,
  isDigestCharsBound,
  isDigestEntriesBound,
  type DigestBatchLimits,
} from "./digest-limits.js";
import { CHANNEL_STATE_SESSION_SUFFIX, type HistoryChatSession } from "./scope.js";

export const DIGEST_CURSOR_KIND = "nanobot.digest-cursor";

export const DIGEST_LIMITS = Object.freeze({
  /** Entries examined by one batch; a longer episode or entry continues in the next batch. */
  entriesPerBatch: DIGEST_RUN_LIMITS_DEFAULT.entriesPerBatch,
  /**
   * Extracted message characters in one batch. A fragment is cut at this bound, never dropped, so
   * this is the effective size limit of one pass; the entry cap only stops a flood of tiny entries.
   */
  charsPerBatch: DIGEST_RUN_LIMITS_DEFAULT.charsPerBatch,
  /** Entries requested per Durable page while scanning for a closed episode or reading a chunk. */
  entriesPerPage: 200,
  /**
   * Entries a single read may examine while *looking* for closed episodes, across conversations.
   *
   * This bounds discovery only, never consumption: it does not bound a chunk (that is
   * `entriesPerBatch`/`charsPerBatch`), the gap check below a fresh episode start, or the walk that
   * proves a new episode's closing reset. Worst case per read is this many entry records plus one
   * chunk's entries, and a postponed chat is retried by a later read instead of being skipped.
   */
  scanEntriesPerRead: 4_000,
  /** Mapped chat sessions accepted by one read. */
  maxMappedSessions: 256,
});

/** Durable consumption frontier of one conversation. */
export interface DigestCursor {
  /** Highest acknowledged entry; null before the conversation's first batch. */
  readonly throughEntryId: EntryId | null;
  /** Extracted-text characters of that entry already acknowledged; null before the first batch. */
  readonly throughChars: number | null;
  /** Start of the closed episode being consumed in chunks, otherwise null. */
  readonly episodeStartEntryId: EntryId | null;
  /** End of that closed episode, otherwise null. */
  readonly episodeEndEntryId: EntryId | null;
}

/** One fragment of one evidence entry. */
export interface DigestEvidence {
  readonly entryId: EntryId;
  /** Message author. Tool results and tool calls are never evidence, so no tool role exists. */
  readonly role: "user" | "assistant";
  /** Durable entry kind, for provenance. */
  readonly kind: string;
  /** Offset of `text` within the entry's extracted evidence text. */
  readonly textStart: number;
  /** Total extracted evidence length of the entry before any batch bound. */
  readonly chars: number;
  /** Fragment text; `chars` and `textStart` place it in the full entry. */
  readonly text: string;
}

/** One bounded chunk of one closed episode. */
export interface DigestBatch {
  readonly status: "batch";
  /** Mapped chat session that owns the conversation; the source label for the batch. */
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  /** Immutable bounds of the closed episode these entries belong to. */
  readonly episodeStartEntryId: EntryId;
  readonly episodeEndEntryId: EntryId;
  /** Lower bound of this chunk; the episode start for a new episode, else the previous position. */
  readonly firstEntryId: EntryId;
  /** Offset in `firstEntryId`'s extracted text where this chunk starts. */
  readonly firstTextStart: number;
  /** Last entry in this chunk; acknowledging moves the cursor here. */
  readonly throughEntryId: EntryId;
  /** Extracted-text characters of `throughEntryId` consumed through this chunk. */
  readonly throughChars: number;
  /** True when this chunk reaches the episode end and consumed that entry completely. */
  readonly complete: boolean;
  readonly entries: readonly DigestEvidence[];
  /** Frontier this batch was read against; acknowledging rejects if it has moved. */
  readonly cursor: DigestCursor;
}

/**
 * Nothing to consume in this read, with unambiguous scan coverage.
 *
 * `caughtUp` is true only when every mapped chat was examined to its tail and the read
 * found no pending closed episode. Otherwise a later read may find more evidence or
 * complete the scan; this is not a claim that the store has no pending work.
 */
export interface DigestIdle {
  readonly status: "idle";
  /** True only when no chat was postponed, unfinished or missing. */
  readonly caughtUp: boolean;
  /** Mapped chats examined, or skipped from a complete in-process scan position. */
  readonly examinedChats: number;
  /** Mapped chats after the scan budget ran out; a later read examines them. */
  readonly postponedChats: number;
  /** Mapped chats whose scan stopped at the entry budget mid-conversation. */
  readonly unfinishedChats: number;
  /** Mapped chats whose conversation record was missing; never treated as evidence. */
  readonly missingChats: number;
}

export type DigestReadResult = DigestBatch | DigestIdle;

/**
 * The durable identity of one bounded chunk, without its evidence text.
 *
 * This is what a caller records when it accepts a batch and later resumes it: the same
 * conversation, immutable episode bounds, chunk position, expected end and the frontier
 * the batch was read against. {@link DigestSource.readBatch} re-derives the evidence from
 * the committed transcript, so a resumed consumer never depends on cross-conversation
 * scan ordering and never stores a second copy of the transcript.
 */
export interface DigestBatchRef {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
  readonly episodeStartEntryId: EntryId;
  readonly episodeEndEntryId: EntryId;
  readonly firstEntryId: EntryId;
  readonly firstTextStart: number;
  readonly throughEntryId: EntryId;
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
   * Currently mapped chat sessions, already authenticated and classified by the host's
   * shared chat-scope provider (the same one the history index and episode catalog use).
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
  /**
   * The oldest unprocessed closed-episode chunk across the mapped chats. Writes nothing
   * to Durable; only an acknowledgement moves a cursor. `limits` overrides the source's
   * configured batch bounds for this read only.
   */
  read(context: Context, limits?: DigestBatchLimits): Promise<DigestReadResult>;
  /**
   * Re-derive one chunk this source previously returned, from its recorded identity.
   *
   * This reads only: it writes no cursor and advances nothing. Whether the batch is still
   * pending is the caller's check (`cursor()`). The ref must name a currently mapped chat
   * conversation and an entry range inside one closed segment (its end is followed by a
   * `pi.reset`), and the re-derived chunk must still end at `throughEntryId`/
   * `throughChars`/`complete`; a forged, stale or out-of-range ref is otherwise rejected
   * instead of returning different evidence. It does not re-prove that the start is the
   * episode's first entry, because only `acknowledge()` may move the frontier. Cross-conversation
   * scan ordering cannot change the answer, so a resumed consumer replays exactly the chunk it accepted.
   * `limits` must be the bounds captured with the batch; a different bound set re-derives a
   * different chunk and is rejected instead of silently accepting a wider one.
   */
  readBatch(ref: DigestBatchRef, context: Context, limits?: DigestBatchLimits): Promise<DigestBatch>;
  /**
   * Record that a batch was successfully consumed, including a batch with no evidence.
   * The frontier update is one commit and is validated against the committed transcript;
   * a rejection leaves the frontier unchanged. `limits` must be the batch's captured bounds.
   */
  acknowledge(batch: DigestBatch, context: Context, limits?: DigestBatchLimits): Promise<DigestCursor>;
}

type DigestCursorDocument = {
  throughEntryId: number | null;
  throughChars: number | null;
  episodeStartEntryId: number | null;
  episodeEndEntryId: number | null;
};

export const DigestCursorDoc = defineDoc<DigestCursorDocument>({
  kind: DIGEST_CURSOR_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    throughEntryId: null,
    throughChars: null,
    episodeStartEntryId: null,
    episodeEndEntryId: null,
  }),
  checkpointWhen: () => true,
});

const EMPTY_CURSOR: DigestCursor = Object.freeze({
  throughEntryId: null,
  throughChars: null,
  episodeStartEntryId: null,
  episodeEndEntryId: null,
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

function offset(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer offset`);
  }
  return value;
}

function storedId(value: unknown, field: string): EntryId | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Stored digest cursor has an invalid ${field}`);
  }
  return value as EntryId;
}

function storedOffset(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored digest cursor has an invalid ${field}`);
  }
  return value;
}

function cursorOf(document: unknown): DigestCursor {
  if (document === undefined) return EMPTY_CURSOR;
  if (!isRecord(document)) throw new Error("Stored digest cursor is malformed");
  const throughEntryId = storedId(document.throughEntryId, "through entry");
  const throughChars = storedOffset(document.throughChars, "through offset");
  const episodeStartEntryId = storedId(document.episodeStartEntryId, "episode start");
  const episodeEndEntryId = storedId(document.episodeEndEntryId, "episode end");
  if ((throughEntryId === null) !== (throughChars === null)) {
    throw new Error("Stored digest cursor has half a through position");
  }
  if ((episodeStartEntryId === null) !== (episodeEndEntryId === null)) {
    throw new Error("Stored digest cursor has half an episode boundary");
  }
  if (episodeStartEntryId !== null && episodeEndEntryId !== null) {
    if (throughEntryId === null || episodeStartEntryId > throughEntryId || throughEntryId > episodeEndEntryId) {
      throw new Error("Stored digest cursor has an inconsistent episode position");
    }
  }
  return { throughEntryId, throughChars, episodeStartEntryId, episodeEndEntryId };
}

function sameCursor(left: DigestCursor, right: DigestCursor): boolean {
  return left.throughEntryId === right.throughEntryId
    && left.throughChars === right.throughChars
    && left.episodeStartEntryId === right.episodeStartEntryId
    && left.episodeEndEntryId === right.episodeEndEntryId;
}

/**
 * Extracted evidence text of one entry, as text parts joined by a newline. Parts are kept
 * unjoined so a fragment can be sliced without materializing a very long entry in full.
 */
interface EvidenceShape {
  readonly role: "user" | "assistant";
  readonly kind: string;
  readonly parts: readonly string[];
  /** Length of `parts.join("\n")`. */
  readonly length: number;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * Evidence shape of one entry, or undefined when it carries none. Reset, system, compaction and
 * tool-result entries contribute nothing, and assistant tool calls stay out of assistant evidence:
 * only user and assistant message text is evidence. The same selection is used for reading and for
 * acknowledgement validation, so a replay or a forged batch is judged against the same rule.
 */
function evidenceShapeOf(entry: EntryRecord): EvidenceShape | undefined {
  const kind = entry.kind;
  const user = kind === UserEntry.kind || kind === CRON_INPUT_ENTRY_KIND;
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

/**
 * True when a fragment ending at `from + take` would split a UTF-16 surrogate pair. The
 * batch boundary is moved instead, so encoding the fragment as UTF-8 cannot produce a
 * replacement character. Offsets stay in UTF-16 code units, never bytes.
 */
function cutsSurrogatePair(shape: EvidenceShape, from: number, take: number): boolean {
  if (take <= 0) return false;
  const tail = evidenceSlice(shape, from + take - 1, from + take).charCodeAt(0);
  if (!(tail >= 0xd800 && tail <= 0xdbff)) return false;
  const next = evidenceSlice(shape, from + take, from + take + 1).charCodeAt(0);
  return next >= 0xdc00 && next <= 0xdfff;
}

function evidenceSlice(shape: EvidenceShape, from: number, to: number): string {
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

interface ClosedEpisodeBounds {
  readonly episodeStartEntryId: EntryId;
  readonly episodeEndEntryId: EntryId;
}

type ScanResult =
  | ({ readonly status: "closed"; readonly examined: number } & ClosedEpisodeBounds)
  | {
    readonly status: "open";
    readonly examined: number;
    /** True when the scan reached the conversation tail instead of stopping at its budget. */
    readonly reachedTail: boolean;
    /** Last entry examined, or null when the scan examined none. */
    readonly scannedThroughEntryId: EntryId | null;
    /** Start of the segment the scan is inside, or null when none was reached. */
    readonly segmentStartEntryId: EntryId | null;
    /** Last entry of that segment that is not its own reset marker, or null when it is empty so far. */
    readonly segmentLastContentEntryId: EntryId | null;
  };

/**
 * Walk entries ascending from `fromEntryId`, tracking the current reset-delimited segment,
 * until a reset closes a non-empty segment or the scan reaches the tail or its entry
 * budget. A segment is non-empty when it holds any entry besides its own reset marker,
 * matching the episode catalog. The closing reset is not consumed by this scan, so a
 * discovered episode keeps an immutable end just before it.
 */
async function scanForClosedEpisode(
  conversation: Conversation,
  fromEntryId: EntryId,
  segmentStartEntryId: EntryId | null,
  segmentLastContentEntryId: EntryId | null,
  budget: number,
  context: Context,
): Promise<ScanResult> {
  let segmentStart = segmentStartEntryId;
  let scannedThrough: EntryId | null = fromEntryId > 1 ? (fromEntryId - 1) as EntryId : null;
  // Resume from the last content entry, never from the last examined entry: a scan that
  // paused on a reset marker must not turn that marker into segment content.
  let lastSegmentEntryId: EntryId | null = segmentLastContentEntryId;
  let examined = 0;
  let cursor: Cursor | undefined;
  while (examined < budget) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: fromEntryId },
      Math.min(DIGEST_LIMITS.entriesPerPage, budget - examined),
      cursor,
      context,
    );
    if (page.items.length === 0) {
      return openResult(examined, true, scannedThrough, segmentStart, lastSegmentEntryId);
    }
    for (const entry of page.items) {
      examined += 1;
      scannedThrough = entry.id;
      if (entry.kind === ResetEntry.kind) {
        if (segmentStart !== null && lastSegmentEntryId !== null) {
          return {
            status: "closed",
            examined,
            episodeStartEntryId: segmentStart,
            episodeEndEntryId: lastSegmentEntryId,
          };
        }
        segmentStart = entry.id;
        lastSegmentEntryId = null;
      } else {
        segmentStart ??= entry.id;
        lastSegmentEntryId = entry.id;
      }
    }
    cursor = page.next;
    if (cursor === undefined) {
      return openResult(examined, true, scannedThrough, segmentStart, lastSegmentEntryId);
    }
  }
  return openResult(examined, false, scannedThrough, segmentStart, lastSegmentEntryId);
}

function openResult(
  examined: number,
  reachedTail: boolean,
  scannedThroughEntryId: EntryId | null,
  segmentStartEntryId: EntryId | null,
  segmentLastContentEntryId: EntryId | null,
): ScanResult {
  return {
    status: "open",
    examined,
    reachedTail,
    scannedThroughEntryId,
    segmentStartEntryId,
    segmentLastContentEntryId,
  };
}

interface Chunk {
  readonly throughEntryId: EntryId;
  readonly throughChars: number;
  readonly complete: boolean;
  readonly entries: readonly DigestEvidence[];
}

/**
 * Read one bounded chunk of the inclusive episode range `[firstEntryId..episodeEndEntryId]`
 * starting at `firstTextStart` inside the first entry. The chunk always includes at least
 * one character or entry, so progress through a long entry or a large episode is strictly
 * monotonic and no text is dropped.
 *
 * The character budget closes a chunk only where it has to: at an entry that still carries
 * evidence. Entries after the budget is spent that carry none (reset markers, system or
 * compaction entries, `pi.tool-result` entries, tool-call-only assistant entries) are consumed
 * by the same chunk with a zero offset, so an episode whose evidence fits the bound is one
 * batch even when it ends in backend traffic — including when the evidence fills the bound
 * exactly. The entry cap still bounds that scan.
 *
 * The one exception is an entry the budget cuts short: a partially consumed entry must be the
 * chunk's last entry (a fragment may never lose its tail before the last entry, or
 * acknowledgement would refuse the chunk forever), so a cut ends the chunk immediately, however
 * many evidence-free entries follow it. Those entries then ride with the next chunk.
 */
async function readChunk(
  conversation: Conversation,
  firstEntryId: EntryId,
  firstTextStart: number,
  episodeEndEntryId: EntryId,
  limits: DigestBatchLimits,
  context: Context,
): Promise<Chunk> {
  const entries: DigestEvidence[] = [];
  let used = 0;
  let through: EntryId | null = null;
  let throughChars = 0;
  let lastTotal = 0;
  let read = 0;
  let cursor: Cursor | undefined;
  let done = false;
  while (!done && read < limits.entriesPerBatch) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: firstEntryId, maxEntryId: episodeEndEntryId },
      Math.min(DIGEST_LIMITS.entriesPerPage, limits.entriesPerBatch - read),
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      const from = entry.id === firstEntryId ? firstTextStart : 0;
      const shape = evidenceShapeOf(entry);
      const total = shape?.length ?? 0;
      if (shape !== undefined && total > from && used >= limits.charsPerBatch) {
        // The budget is spent and this entry still has evidence: it belongs to the next chunk.
        // `used` is positive here, so this chunk always consumed something.
        done = true;
        break;
      }
      let fragment: DigestEvidence | undefined;
      let nextThroughChars: number;
      if (shape !== undefined && total > from) {
        let take = Math.min(total - from, limits.charsPerBatch - used);
        if (from + take < total && cutsSurrogatePair(shape, from, take)) {
          // The budget cannot hold the whole character: end this batch before the entry.
          // A first entry always has the full budget, so `take <= 1` implies earlier entries.
          if (take <= 1) {
            done = true;
            break;
          }
          take -= 1;
        }
        fragment = {
          entryId: entry.id,
          role: shape.role,
          kind: shape.kind,
          textStart: from,
          chars: total,
          text: evidenceSlice(shape, from, from + take),
        };
        nextThroughChars = from + take;
      } else {
        nextThroughChars = total === 0 ? 0 : Math.min(total, from);
      }
      // Commit this entry only once its fragment (or its no-evidence decision) is settled.
      read += 1;
      through = entry.id;
      throughChars = nextThroughChars;
      lastTotal = total;
      if (fragment !== undefined) {
        entries.push(fragment);
        used += fragment.text.length;
      }
      if (entry.id === episodeEndEntryId) {
        done = true;
        break;
      }
      if (nextThroughChars < total) {
        // This entry still has a tail (the character budget cut it, or a surrogate pair moved the
        // boundary): the chunk must end here so the tail continues next batch. Consuming further
        // entries would put a partially consumed entry before the chunk's last entry, which
        // acknowledgement validation refuses as a lost tail — and the reader would then re-offer
        // the same chunk forever.
        done = true;
        break;
      }
    }
    if (done) break;
    cursor = page.next;
    if (cursor === undefined) break;
  }
  if (through === null) {
    throw new Error("Digest episode has no entries at the requested position");
  }
  return {
    throughEntryId: through,
    throughChars,
    complete: through === episodeEndEntryId && throughChars === lastTotal,
    entries,
  };
}

interface ScanCacheEntry {
  /** Frontier the scan was taken against; a moved frontier discards the entry. */
  readonly throughEntryId: EntryId | null;
  readonly throughChars: number | null;
  readonly scannedThroughEntryId: EntryId | null;
  readonly segmentStartEntryId: EntryId | null;
  readonly segmentLastContentEntryId: EntryId | null;
}

interface Candidate {
  readonly session: HistoryChatSession;
  readonly conversation: Conversation;
  readonly cursor: DigestCursor;
  /** Set when the scan discovered a closed episode; absent for a resumed chunk. */
  readonly episode?: ClosedEpisodeBounds;
}

function nextPositionOf(candidate: Candidate): { readonly entryId: number; readonly chars: number } {
  return candidate.episode === undefined
    ? { entryId: candidate.cursor.throughEntryId!, chars: candidate.cursor.throughChars! }
    : { entryId: candidate.episode.episodeStartEntryId, chars: 0 };
}

/** Validate the host's mapped chat sessions; they name authorization, not content. */
function validateSessions(sessions: readonly HistoryChatSession[]): void {
  const seen = new Set<number>();
  for (const session of sessions) {
    if (typeof session.sessionKey !== "string" || session.sessionKey.length === 0) {
      throw new TypeError("Digest session keys must be non-empty strings");
    }
    if (session.sessionKey.endsWith(CHANNEL_STATE_SESSION_SUFFIX)) {
      throw new TypeError("Digest input does not accept channel-state sessions");
    }
    const conversationId = session.conversationId as number;
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      throw new TypeError("Digest session conversation IDs must be positive safe integers");
    }
    if (seen.has(conversationId)) {
      throw new TypeError("Digest sessions must map each conversation at most once");
    }
    seen.add(conversationId);
  }
  if (sessions.length > DIGEST_LIMITS.maxMappedSessions) {
    throw new Error(
      `Digest input supports at most ${DIGEST_LIMITS.maxMappedSessions} mapped chat sessions; ` +
      `${sessions.length} are present`,
    );
  }
}

function validateCursor(cursor: unknown): DigestCursor {
  if (!isRecord(cursor)) throw new TypeError("Digest cursor must be an object");
  const throughEntryId = cursor.throughEntryId === null
    ? null
    : positiveId(cursor.throughEntryId, "Digest cursor through entry");
  const throughChars = cursor.throughChars === null
    ? null
    : offset(cursor.throughChars, "Digest cursor through offset");
  const episodeStartEntryId = cursor.episodeStartEntryId === null
    ? null
    : positiveId(cursor.episodeStartEntryId, "Digest cursor episode start");
  const episodeEndEntryId = cursor.episodeEndEntryId === null
    ? null
    : positiveId(cursor.episodeEndEntryId, "Digest cursor episode end");
  if ((throughEntryId === null) !== (throughChars === null)) {
    throw new TypeError("Digest cursor must name both through fields or neither");
  }
  if ((episodeStartEntryId === null) !== (episodeEndEntryId === null)) {
    throw new TypeError("Digest cursor must name both episode bounds or neither");
  }
  if (episodeStartEntryId !== null && episodeEndEntryId !== null) {
    if (throughEntryId === null || episodeStartEntryId > throughEntryId || throughEntryId > episodeEndEntryId) {
      throw new TypeError("Digest cursor episode position is inconsistent");
    }
  }
  return { throughEntryId, throughChars, episodeStartEntryId, episodeEndEntryId };
}

/**
 * A batch is consumer-supplied: validate its shape and that it advances the cursor before
 * any transcript check or write. Transcript agreement is checked separately.
 */
function validateBatchShape(batch: DigestBatch): void {
  if (batch === null || typeof batch !== "object") throw new TypeError("Digest batch must be an object");
  if (batch.status !== "batch") throw new TypeError("Digest batch status is invalid");
  if (typeof batch.sessionKey !== "string" || batch.sessionKey.length === 0) {
    throw new TypeError("Digest batch session key must be a non-empty string");
  }
  const conversationId = batch.conversationId as number;
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new TypeError("Digest batch conversation ID must be a positive safe integer");
  }
  const start = positiveId(batch.episodeStartEntryId, "Digest batch episode start");
  const end = positiveId(batch.episodeEndEntryId, "Digest batch episode end");
  const first = positiveId(batch.firstEntryId, "Digest batch first entry");
  const through = positiveId(batch.throughEntryId, "Digest batch through entry");
  const firstTextStart = offset(batch.firstTextStart, "Digest batch first offset");
  const throughChars = offset(batch.throughChars, "Digest batch through offset");
  if (!(start <= first && first <= through && through <= end)) {
    throw new TypeError("Digest batch entry range is inconsistent");
  }
  if (batch.complete && through !== end) {
    throw new TypeError("Digest batch cannot complete before its episode end");
  }
  const cursor = validateCursor(batch.cursor);
  if (cursor.throughEntryId === null) {
    if (first !== start) throw new TypeError("Digest batch must start its episode at the episode start");
    if (firstTextStart !== 0) throw new TypeError("Digest batch must start a new episode at offset 0");
  } else if (cursor.episodeStartEntryId === null) {
    if (first <= cursor.throughEntryId) {
      throw new TypeError("Digest batch starts at or before its cursor");
    }
    if (first !== start) throw new TypeError("Digest batch must start its episode at the episode start");
    if (firstTextStart !== 0) throw new TypeError("Digest batch must start a new episode at offset 0");
  } else {
    if (start !== cursor.episodeStartEntryId || end !== cursor.episodeEndEntryId) {
      throw new TypeError("Digest batch does not continue its cursor's episode");
    }
    if (first !== cursor.throughEntryId || firstTextStart !== cursor.throughChars) {
      throw new TypeError("Digest batch does not continue at its cursor position");
    }
  }
  const advanced = cursor.throughEntryId === null
    ? through > 0
    : through > cursor.throughEntryId
      || (through === cursor.throughEntryId && throughChars > (cursor.throughChars ?? 0));
  if (!advanced) throw new TypeError("Digest acknowledgement does not advance the cursor");
  if (!Array.isArray(batch.entries)) throw new TypeError("Digest batch entries must be an array");
  let previous = 0;
  for (const entry of batch.entries as readonly unknown[]) {
    if (!isRecord(entry)) throw new TypeError("Digest batch evidence must be an object");
    const entryId = positiveId(entry.entryId, "Digest evidence entry ID");
    if (entryId < first || entryId > through || entryId <= previous) {
      throw new TypeError("Digest evidence entry is outside or out of order in its chunk");
    }
    previous = entryId;
    if (entry.role !== "user" && entry.role !== "assistant") {
      throw new TypeError("Digest evidence role is invalid");
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new TypeError("Digest evidence kind must be a non-empty string");
    }
    if (typeof entry.text !== "string" || typeof entry.textStart !== "number") {
      throw new TypeError("Digest evidence text is invalid");
    }
    const textStart = offset(entry.textStart, "Digest evidence text offset");
    const chars = offset(entry.chars, "Digest evidence length");
    if (entry.text.length === 0 || textStart + entry.text.length > chars) {
      throw new TypeError("Digest evidence fragment is outside its entry text");
    }
  }
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
 * A fresh episode start is a reset entry or the conversation's first entry, and the gap
 * between the previous frontier (or the beginning of the conversation) and that start may
 * hold only reset markers: those belong to empty segments and are not evidence. The gap is
 * bounded to one read's scan budget; a longer one is refused rather than assumed, so a
 * forged start cannot hop over a closed episode. Returns the start entry for the bounds
 * check.
 */
async function validateFreshEpisodeStart(
  conversation: Conversation,
  batch: DigestBatch,
  context: Context,
): Promise<EntryRecord> {
  const marker = await entryAt(conversation, batch.episodeStartEntryId, context);
  if (marker === undefined) throw new TypeError("Digest episode start is not a committed entry");
  if (marker.kind !== ResetEntry.kind) {
    const below = (await conversation.entries(
      { order: "descending", ...(batch.episodeStartEntryId > 1 ? { maxEntryId: (batch.episodeStartEntryId - 1) as EntryId } : {}) },
      1,
      undefined,
      context,
    )).items[0];
    if (below !== undefined) throw new TypeError("Digest episode start is neither a reset nor the first entry");
  }
  const through = batch.cursor.throughEntryId;
  const gapFrom = through === null ? 1 : through + 1;
  const gapTo = batch.episodeStartEntryId - 1;
  if (gapTo >= gapFrom) {
    const gap = await conversation.entries(
      { order: "ascending", minEntryId: gapFrom as EntryId, maxEntryId: gapTo as EntryId },
      DIGEST_LIMITS.scanEntriesPerRead + 1,
      undefined,
      context,
    );
    if (gap.items.length > DIGEST_LIMITS.scanEntriesPerRead || gap.next !== undefined) {
      throw new TypeError("Digest episode start is too far from its cursor to verify");
    }
    for (const entry of gap.items) {
      if (entry.kind !== ResetEntry.kind) {
        throw new TypeError("Digest episode start would skip an earlier segment with content");
      }
    }
  }
  return marker;
}

/**
 * Establish that a newly claimed episode really is the segment its start opens: walking the
 * episode from its start, the first reset that closes a non-empty segment must be the one
 * just after the claimed end. Paged reads keep memory bounded, but the walk is not
 * interruptible mid-walk (SQLite reads ignore the context); an aborted context only stops
 * the acknowledgement's commit, so no cursor advances. The walk runs only when new episode
 * bounds are established, not for every continuation chunk, so its total cost is one
 * bounded-memory pass over that episode: its length is the episode's own entry count, the same
 * episode the acknowledging chunk came from. A whole-episode batch therefore walks exactly that
 * episode, and a chunked episode walks it once, on its first chunk. Without it, a forged
 * partial batch could persist an end that spans an earlier reset; later chunks would then
 * contain that internal reset and be un-acknowledgeable forever, and the poisoned position
 * would keep winning cross-chat priority.
 */
async function validateFreshEpisodeClosedRange(
  conversation: Conversation,
  batch: DigestBatch,
  startEntry: EntryRecord,
  context: Context,
): Promise<void> {
  if (batch.episodeEndEntryId === batch.episodeStartEntryId) {
    // A single-entry episode is already covered by the bounds check: the next entry is its reset.
    return;
  }
  const startsWithReset = startEntry.kind === ResetEntry.kind;
  const scan = await scanForClosedEpisode(
    conversation,
    (batch.episodeStartEntryId + 1) as EntryId,
    batch.episodeStartEntryId,
    startsWithReset ? null : batch.episodeStartEntryId,
    Number.POSITIVE_INFINITY,
    context,
  );
  if (
    scan.status !== "closed"
    || scan.episodeStartEntryId !== batch.episodeStartEntryId
    || scan.episodeEndEntryId !== batch.episodeEndEntryId
  ) {
    throw new TypeError("Digest episode end is not the first reset that closes its start");
  }
}

/**
 * Validate the immutable episode bounds on every acknowledgement, not only a complete one.
 * The end must be a committed non-reset entry just before the `pi.reset` that actually
 * closes the episode; a reset-started episode must contain something besides its marker.
 * Without this, a forged partial batch could persist an inflated end and make later
 * batches cross resets or the open tail.
 */
async function validateEpisodeBounds(
  conversation: Conversation,
  batch: Pick<DigestBatch, "episodeStartEntryId" | "episodeEndEntryId">,
  startEntry: EntryRecord,
  context: Context,
): Promise<void> {
  const endEntry = await entryAt(conversation, batch.episodeEndEntryId, context);
  if (endEntry === undefined) throw new TypeError("Digest episode end is not a committed entry");
  if (endEntry.kind === ResetEntry.kind) throw new TypeError("Digest episode end is a reset marker");
  if (startEntry.kind === ResetEntry.kind && batch.episodeEndEntryId === batch.episodeStartEntryId) {
    throw new TypeError("Digest episode has no content after its reset marker");
  }
  const closing = (await conversation.entries(
    { order: "ascending", minEntryId: (batch.episodeEndEntryId + 1) as EntryId },
    1,
    undefined,
    context,
  )).items[0];
  if (closing === undefined || closing.kind !== ResetEntry.kind) {
    throw new TypeError("Digest episode is not closed by a reset in the transcript");
  }
}

/**
 * Re-derive the batch's claimed chunk from the committed transcript. This is what makes a
 * cursor advance trustworthy: every entry the batch claims to cover must exist, every
 * evidence entry in that range must be covered by exactly the claimed fragment at the
 * claimed offset, no entry before the last may lose its tail, and a complete chunk must
 * end just before its closing reset.
 *
 * Bound: one transcript read of the claimed range, bounded by *entry count* at
 * `limits.entriesPerBatch + 1` records (2,001 with the shipped defaults), never by bytes. The
 * character bound does not cover every record: a chunk may end in evidence-free entries (reset
 * markers, system or compaction entries, `pi.tool-result` entries, tool-call-only assistant
 * entries) whose bytes contribute no evidence characters, and one individual entry may itself be
 * larger than `limits.charsPerBatch`. So the honest statement is: this re-reads exactly the chunk
 * being acknowledged (no scan, no second pass over the episode), with work proportional to that
 * chunk's entry count, and per-entry size is not bounded by the character bound. A range that does
 * not fit the captured entry bound is refused loudly instead of being truncated.
 */
async function validateChunkAgainstTranscript(
  conversation: Conversation,
  batch: DigestBatch,
  limits: DigestBatchLimits,
  context: Context,
): Promise<void> {
  const page = await conversation.entries(
    { order: "ascending", minEntryId: batch.firstEntryId, maxEntryId: batch.throughEntryId },
    limits.entriesPerBatch + 1,
    undefined,
    context,
  );
  const items = page.items;
  const last = items[items.length - 1];
  if (last === undefined || last.id !== batch.throughEntryId) {
    throw new TypeError("Digest batch does not cover its claimed entry range");
  }
  if (items.length > limits.entriesPerBatch) {
    throw new TypeError(`Digest batch covers more than ${limits.entriesPerBatch} entries`);
  }
  if (items[0]!.id !== batch.firstEntryId) {
    throw new TypeError("Digest batch does not start at a committed entry");
  }
  const inRange = new Set<number>(items.map((entry) => entry.id as number));
  for (const evidence of batch.entries) {
    if (!inRange.has(evidence.entryId as number)) {
      throw new TypeError("Digest batch has evidence outside its claimed entry range");
    }
  }
  const byId = new Map<number, DigestEvidence>(batch.entries.map((entry) => [entry.entryId as number, entry]));
  let lastTotal = 0;
  let lastFragment: DigestEvidence | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    // A closed episode contains at most its own reset marker; a later one would mean the
    // claimed range spans an episode boundary this acknowledgement never consumed.
    if (index > 0 && item.kind === ResetEntry.kind) {
      throw new TypeError("Digest batch spans a reset boundary inside one episode");
    }
    const shape = evidenceShapeOf(item);
    const total = shape?.length ?? 0;
    const from = index === 0 ? batch.firstTextStart : 0;
    const fragment = byId.get(item.id as number);
    if (from > total) throw new TypeError("Digest batch starts beyond its first entry's evidence");
    let end = from;
    if (total > from) {
      if (fragment === undefined) throw new TypeError("Digest batch omits evidence from its covered range");
      if (fragment.textStart !== from) throw new TypeError("Digest evidence fragment does not start at its position");
      if (fragment.chars !== total) throw new TypeError("Digest evidence length does not match the transcript entry");
      if (fragment.kind !== shape!.kind || fragment.role !== shape!.role) {
        throw new TypeError("Digest evidence does not match the transcript entry");
      }
      end = fragment.textStart + fragment.text.length;
      if (end > total) throw new TypeError("Digest evidence fragment is outside its entry text");
      if (evidenceSlice(shape!, fragment.textStart, end) !== fragment.text) {
        throw new TypeError("Digest evidence text does not match the transcript entry");
      }
    } else if (fragment !== undefined) {
      throw new TypeError("Digest batch claims evidence for an already consumed entry");
    }
    if (index < items.length - 1 && end !== total) {
      throw new TypeError("Digest batch loses the tail of an entry before its last entry");
    }
    lastTotal = total;
    lastFragment = fragment;
  }
  const expected = lastFragment === undefined ? lastTotal : lastFragment.textStart + lastFragment.text.length;
  if (batch.throughChars !== expected) {
    throw new TypeError("Digest batch through offset does not match its last entry");
  }
  const consumedEpisode = batch.throughEntryId === batch.episodeEndEntryId
    && batch.throughChars === lastTotal;
  if (batch.complete !== consumedEpisode) {
    throw new TypeError("Digest batch completeness does not match its last entry");
  }
}

/**
 * A batch ref is consumer-supplied: validate its shape before any transcript read. The
 * claimed end is also checked against the committed transcript, so a forged ref can only
 * read a closed segment of a mapped chat conversation, never the open tail.
 */
function validateBatchRef(ref: DigestBatchRef): void {
  if (ref === null || typeof ref !== "object") throw new TypeError("Digest batch ref must be an object");
  if (typeof ref.sessionKey !== "string" || ref.sessionKey.length === 0) {
    throw new TypeError("Digest batch ref session key must be a non-empty string");
  }
  const conversationId = ref.conversationId as number;
  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    throw new TypeError("Digest batch ref conversation ID must be a positive safe integer");
  }
  const start = positiveId(ref.episodeStartEntryId, "Digest batch ref episode start");
  const end = positiveId(ref.episodeEndEntryId, "Digest batch ref episode end");
  const first = positiveId(ref.firstEntryId, "Digest batch ref first entry");
  const through = positiveId(ref.throughEntryId, "Digest batch ref through entry");
  const firstTextStart = offset(ref.firstTextStart, "Digest batch ref first offset");
  offset(ref.throughChars, "Digest batch ref through offset");
  if (typeof ref.complete !== "boolean") throw new TypeError("Digest batch ref completeness must be a boolean");
  if (!(start <= first && first <= through && through <= end)) {
    throw new TypeError("Digest batch ref entry range is inconsistent");
  }
  if (ref.complete && through !== end) {
    throw new TypeError("Digest batch ref cannot complete before its episode end");
  }
  const cursor = validateCursor(ref.cursor);
  const continues = cursor.episodeStartEntryId !== null;
  if (continues) {
    if (start !== cursor.episodeStartEntryId || end !== cursor.episodeEndEntryId) {
      throw new TypeError("Digest batch ref does not continue its cursor's episode");
    }
    if (first !== cursor.throughEntryId || firstTextStart !== cursor.throughChars) {
      throw new TypeError("Digest batch ref does not continue at its cursor position");
    }
  } else {
    if (first !== start || firstTextStart !== 0) {
      throw new TypeError("Digest batch ref must start its episode at the episode start");
    }
    if (cursor.throughEntryId !== null && first <= cursor.throughEntryId) {
      throw new TypeError("Digest batch ref starts at or before its cursor");
    }
  }
}

/**
 * Reject batch bounds that could not progress, at every direct entry point: construction, each
 * `read`, `readBatch` and `acknowledge` override. Two entries per chunk is the minimum because a
 * one-entry chunk stuck on a non-evidence entry (an episode's opening reset marker, typically) would
 * be refused as non-advancing and re-offered forever; two characters is the minimum that can hold a
 * surrogate pair.
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

export function createDigestSource(options: DigestSourceOptions): DigestSource {
  const { harness } = options;
  const configured = requireBatchLimits(options.limits ?? DIGEST_LIMITS);
  // Derived scan positions only: losing them costs a repeated bounded scan, never evidence.
  const scanCache = new Map<ConversationId, ScanCacheEntry>();
  // Scan budget rotates its starting conversation, so a chat with continuous activity cannot
  // spend every read's budget before the others are examined. It changes discovery order only.
  let rotation = 0;

  const cursorFor = async (conversationId: ConversationId, context: Context): Promise<DigestCursor> =>
    cursorOf(await harness.snapshot(DigestCursorDoc, conversationId, context));

  return {
    cursor(conversationId, context) {
      positiveId(conversationId as number, "Digest conversation ID");
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
      let budget = DIGEST_LIMITS.scanEntriesPerRead;
      let examinedChats = 0;
      let postponedChats = 0;
      let unfinishedChats = 0;
      let missingChats = 0;
      const candidates: Candidate[] = [];
      const startAt = sessions.length <= 1 ? 0 : rotation % sessions.length;
      if (sessions.length > 1) rotation = (startAt + 1) % sessions.length;
      const ordered = startAt === 0 ? sessions : [...sessions.slice(startAt), ...sessions.slice(0, startAt)];
      for (const session of ordered) {
        const conversationId = session.conversationId;
        const conversation = await harness.conversation(conversationId, context);
        if (conversation === undefined) {
          missingChats += 1;
          continue;
        }
        const cursor = await cursorFor(conversationId, context);
        if (cursor.episodeStartEntryId !== null) {
          examinedChats += 1;
          candidates.push({ session, conversation, cursor });
          continue;
        }
        if (budget <= 0) {
          postponedChats += 1;
          continue;
        }
        const cached = scanCache.get(conversationId);
        const usable = cached !== undefined && cached.throughEntryId === cursor.throughEntryId
          && cached.throughChars === cursor.throughChars;
        const tail = (await conversation.entries({ order: "descending" }, 1, undefined, context)).items[0];
        if (tail === undefined) {
          examinedChats += 1;
          continue;
        }
        if (usable && cached.scannedThroughEntryId !== null && tail.id <= cached.scannedThroughEntryId) {
          // Everything after this frontier was already examined and held no closed episode.
          examinedChats += 1;
          continue;
        }
        const fromEntryId = (
          usable && cached.scannedThroughEntryId !== null
            ? cached.scannedThroughEntryId + 1
            : (cursor.throughEntryId ?? 0) + 1
        ) as EntryId;
        const segmentStartEntryId = usable ? cached.segmentStartEntryId : null;
        const segmentLastContentEntryId = usable ? cached.segmentLastContentEntryId : null;
        const scanned = await scanForClosedEpisode(
          conversation,
          fromEntryId,
          segmentStartEntryId,
          segmentLastContentEntryId,
          budget,
          context,
        );
        budget -= scanned.examined;
        examinedChats += 1;
        if (scanned.status === "closed") {
          scanCache.delete(conversationId);
          candidates.push({
            session,
            conversation,
            cursor,
            episode: {
              episodeStartEntryId: scanned.episodeStartEntryId,
              episodeEndEntryId: scanned.episodeEndEntryId,
            },
          });
        } else {
          if (!scanned.reachedTail) unfinishedChats += 1;
          scanCache.set(conversationId, {
            throughEntryId: cursor.throughEntryId,
            throughChars: cursor.throughChars,
            scannedThroughEntryId: scanned.scannedThroughEntryId,
            segmentStartEntryId: scanned.segmentStartEntryId,
            segmentLastContentEntryId: scanned.segmentLastContentEntryId,
          });
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
        };
      }
      candidates.sort((left, right) => {
        const a = nextPositionOf(left);
        const b = nextPositionOf(right);
        return a.entryId - b.entryId
          || a.chars - b.chars
          || (left.session.conversationId as number) - (right.session.conversationId as number);
      });
      const chosen = candidates[0]!;
      const episode = chosen.episode ?? {
        episodeStartEntryId: chosen.cursor.episodeStartEntryId!,
        episodeEndEntryId: chosen.cursor.episodeEndEntryId!,
      };
      const firstEntryId = chosen.episode === undefined ? chosen.cursor.throughEntryId! : episode.episodeStartEntryId;
      const firstTextStart = chosen.episode === undefined ? chosen.cursor.throughChars! : 0;
      const chunk = await readChunk(
        chosen.conversation,
        firstEntryId,
        firstTextStart,
        episode.episodeEndEntryId,
        batchLimits,
        context,
      );
      return {
        status: "batch",
        sessionKey: chosen.session.sessionKey,
        conversationId: chosen.session.conversationId,
        episodeStartEntryId: episode.episodeStartEntryId,
        episodeEndEntryId: episode.episodeEndEntryId,
        firstEntryId,
        firstTextStart,
        throughEntryId: chunk.throughEntryId,
        throughChars: chunk.throughChars,
        complete: chunk.complete,
        entries: chunk.entries,
        cursor: chosen.cursor,
      };
    },

    async readBatch(ref, context, limits) {
      validateBatchRef(ref);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = ref.conversationId;
      const conversation = await harness.conversation(conversationId, context);
      if (conversation === undefined) throw new TypeError("Digest batch ref conversation is not committed");
      const sessions = await options.sessions(context);
      validateSessions(sessions);
      const session = sessions.find((candidate) => candidate.conversationId === conversationId);
      if (session === undefined || session.sessionKey !== ref.sessionKey) {
        throw new TypeError("Digest batch ref is not a currently mapped chat session");
      }
      const startEntry = await entryAt(conversation, ref.episodeStartEntryId, context);
      if (startEntry === undefined) throw new TypeError("Digest batch ref episode start is not committed");
      await validateEpisodeBounds(conversation, ref, startEntry, context);
      const chunk = await readChunk(
        conversation,
        ref.firstEntryId,
        ref.firstTextStart,
        ref.episodeEndEntryId,
        batchLimits,
        context,
      );
      if (
        chunk.throughEntryId !== ref.throughEntryId
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
        firstTextStart: ref.firstTextStart,
        throughEntryId: chunk.throughEntryId,
        throughChars: chunk.throughChars,
        complete: chunk.complete,
        entries: chunk.entries,
        cursor: ref.cursor,
      };
    },

    async acknowledge(batch, context, limits) {
      validateBatchShape(batch);
      const batchLimits = requireBatchLimits(limits ?? configured);
      const conversationId = batch.conversationId;
      const conversation = await harness.conversation(conversationId, context);
      if (conversation === undefined) throw new TypeError("Digest batch conversation is not a committed conversation");
      const startEntry = batch.cursor.episodeStartEntryId === null
        ? await validateFreshEpisodeStart(conversation, batch, context)
        : await entryAt(conversation, batch.episodeStartEntryId, context);
      if (startEntry === undefined) throw new TypeError("Digest episode start is not a committed entry");
      await validateEpisodeBounds(conversation, batch, startEntry, context);
      if (batch.cursor.episodeStartEntryId === null) {
        // New bounds are proven complete here; continuation chunks reuse them.
        await validateFreshEpisodeClosedRange(conversation, batch, startEntry, context);
      }
      await validateChunkAgainstTranscript(conversation, batch, batchLimits, context);
      const next: DigestCursor = {
        throughEntryId: batch.throughEntryId,
        throughChars: batch.throughChars,
        episodeStartEntryId: batch.complete ? null : batch.episodeStartEntryId,
        episodeEndEntryId: batch.complete ? null : batch.episodeEndEntryId,
      };
      await harness.commit(async (tx) => {
        const document = await tx.doc(DigestCursorDoc, conversationId);
        const stored = cursorOf(document);
        if (!sameCursor(stored, batch.cursor)) {
          throw new DigestCursorConflictError(
            "Digest cursor moved after this batch was read; re-read before acknowledging",
          );
        }
        document.throughEntryId = next.throughEntryId;
        document.throughChars = next.throughChars;
        document.episodeStartEntryId = next.episodeStartEntryId;
        document.episodeEndEntryId = next.episodeEndEntryId;
      }, context);
      scanCache.delete(conversationId);
      return next;
    },
  };
}
