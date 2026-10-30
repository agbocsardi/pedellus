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
 *   fragment names the entry it came from and its byte-range in that entry's extracted
 *   text, so a consumer can cite the original transcript and finish a long entry across
 *   batches. Durable remains the only transcript authority: nothing here copies the
 *   transcript into a second archive.
 * - Only closed episodes are evidence. An episode closes when a `pi.reset` entry is
 *   committed after it; the current, still-open segment is never returned. Empty
 *   segments (a reset with no following entry) are skipped and are not evidence.
 * - A reset entry's handoff message is synthetic context, not owner speech, so it is
 *   never returned as evidence. System, compaction and unknown entries are consumed as
 *   part of the episode range but contribute no evidence item.
 * - The episode range includes its reset marker, exactly as the episode catalog records
 *   it. Evidence is user text, assistant text and tool-result text; assistant tool calls
 *   are not evidence, because the corresponding result entry carries the outcome.
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
 * - `acknowledge()` is the only writer. It compares the stored cursor with the cursor the
 *   batch was read against, then re-derives the batch's claimed chunk from the committed
 *   transcript before advancing: a fresh chunk must start at its claimed episode start,
 *   the entries between the previous frontier and that start may hold no content, every
 *   entry in the claimed range must be covered (with the exact text at the claimed
 *   offsets), a complete chunk must end just before the `pi.reset` that closed it, and a
 *   continued chunk must resume at the stored position. A malformed or forged batch is
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
 * surface, and any activation. `cursor()` exposes the frontier for status and tests.
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
import { CHANNEL_STATE_SESSION_SUFFIX, type HistoryChatSession } from "./scope.js";

export const DIGEST_CURSOR_KIND = "nanobot.digest-cursor";

export const DIGEST_LIMITS = Object.freeze({
  /** Entries examined by one batch; a long entry continues in the next batch. */
  entriesPerBatch: 80,
  /** Extracted evidence characters in one batch. A fragment is cut at this bound, never dropped. */
  charsPerBatch: 24_000,
  /** Entries requested per Durable page while scanning for a closed episode. */
  entriesPerPage: 200,
  /** Entries a single read may examine while looking for closed episodes, across conversations. */
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
  readonly role: "user" | "assistant" | "tool";
  /** Durable entry kind, for provenance. */
  readonly kind: string;
  /** Tool name for a tool result; absent for user and assistant text. */
  readonly toolName?: string;
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
}

export interface DigestSource {
  /** Current frontier of one conversation; reads only. */
  cursor(conversationId: ConversationId, context: Context): Promise<DigestCursor>;
  /**
   * The oldest unprocessed closed-episode chunk across the mapped chats. Writes nothing
   * to Durable; only an acknowledgement moves a cursor.
   */
  read(context: Context): Promise<DigestReadResult>;
  /**
   * Record that a batch was successfully consumed, including a batch with no evidence.
   * The frontier update is one commit and is validated against the committed transcript;
   * a rejection leaves the frontier unchanged.
   */
  acknowledge(batch: DigestBatch, context: Context): Promise<DigestCursor>;
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
  readonly role: "user" | "assistant" | "tool";
  readonly kind: string;
  readonly toolName?: string;
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
 * Evidence shape of one entry, or undefined when it carries none. Reset, system and
 * compaction entries contribute nothing; tool calls stay out of assistant evidence
 * because their result entry carries the outcome.
 */
function evidenceShapeOf(entry: EntryRecord): EvidenceShape | undefined {
  const kind = entry.kind;
  const user = kind === UserEntry.kind || kind === CRON_INPUT_ENTRY_KIND;
  const assistant = kind === AssistantEntry.kind;
  const tool = kind === ToolResultEntry.kind;
  if (!user && !assistant && !tool) return undefined;
  if (!Array.isArray(entry.model)) return undefined;
  const parts: string[] = [];
  let toolName: string | undefined;
  for (const raw of entry.model) {
    if (!isRecord(raw)) continue;
    if (user) {
      if (raw.role !== "user") continue;
      const text = messageText(raw.content);
      if (text !== undefined && text.trim().length > 0) parts.push(text);
      continue;
    }
    if (assistant) {
      if (raw.role !== "assistant") continue;
      const text = messageText(raw.content);
      if (text !== undefined && text.trim().length > 0) parts.push(text);
      continue;
    }
    if (raw.role !== "toolResult") continue;
    if (toolName === undefined && typeof raw.toolName === "string" && raw.toolName.length > 0) {
      toolName = raw.toolName;
    }
    const text = messageText(raw.content);
    if (text !== undefined && text.trim().length > 0) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  let length = parts.length - 1;
  for (const part of parts) length += part.length;
  const role = user ? "user" : assistant ? "assistant" : "tool";
  return {
    role,
    kind,
    ...(toolName === undefined ? {} : { toolName }),
    parts,
    length,
  };
}

/** Slice `[from, to)` of `shape.parts.join("\n")` without joining the whole text. */
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
  budget: number,
  context: Context,
): Promise<ScanResult> {
  let segmentStart = segmentStartEntryId;
  let scannedThrough: EntryId | null = fromEntryId > 1 ? (fromEntryId - 1) as EntryId : null;
  // Resuming inside a segment: the last entry examined so far is that segment's last one.
  let lastSegmentEntryId: EntryId | null = segmentStart === null ? null : scannedThrough;
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
      return openResult(examined, true, scannedThrough, segmentStart);
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
      return openResult(examined, true, scannedThrough, segmentStart);
    }
  }
  return openResult(examined, false, scannedThrough, segmentStart);
}

function openResult(
  examined: number,
  reachedTail: boolean,
  scannedThroughEntryId: EntryId | null,
  segmentStartEntryId: EntryId | null,
): ScanResult {
  return { status: "open", examined, reachedTail, scannedThroughEntryId, segmentStartEntryId };
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
 */
async function readChunk(
  conversation: Conversation,
  firstEntryId: EntryId,
  firstTextStart: number,
  episodeEndEntryId: EntryId,
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
  while (!done && read < DIGEST_LIMITS.entriesPerBatch) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: firstEntryId, maxEntryId: episodeEndEntryId },
      Math.min(DIGEST_LIMITS.entriesPerPage, DIGEST_LIMITS.entriesPerBatch - read),
      cursor,
      context,
    );
    if (page.items.length === 0) break;
    for (const entry of page.items) {
      read += 1;
      through = entry.id;
      const from = entry.id === firstEntryId ? firstTextStart : 0;
      const shape = evidenceShapeOf(entry);
      const total = shape?.length ?? 0;
      lastTotal = total;
      if (shape !== undefined && total > from && used < DIGEST_LIMITS.charsPerBatch) {
        const take = Math.min(total - from, DIGEST_LIMITS.charsPerBatch - used);
        entries.push({
          entryId: entry.id,
          role: shape.role,
          kind: shape.kind,
          ...(shape.toolName === undefined ? {} : { toolName: shape.toolName }),
          textStart: from,
          chars: total,
          text: evidenceSlice(shape, from, from + take),
        });
        used += take;
        throughChars = from + take;
      } else {
        throughChars = total === 0 ? 0 : Math.min(total, from);
      }
      if (entry.id === episodeEndEntryId || used >= DIGEST_LIMITS.charsPerBatch) {
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
    if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") {
      throw new TypeError("Digest evidence role is invalid");
    }
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new TypeError("Digest evidence kind must be a non-empty string");
    }
    if (entry.toolName !== undefined && (typeof entry.toolName !== "string" || entry.toolName.length === 0)) {
      throw new TypeError("Digest evidence tool name must be a non-empty string");
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
 * between the previous frontier and that start may hold only reset markers: those belong
 * to empty segments and are not evidence. A gap larger than one read's scan budget is
 * refused rather than assumed, so a forged start cannot hop over a closed episode.
 */
async function validateFreshEpisodeStart(
  conversation: Conversation,
  batch: DigestBatch,
  context: Context,
): Promise<void> {
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
  if (through === null) return;
  const gap = await conversation.entries(
    { order: "ascending", minEntryId: (through + 1) as EntryId, maxEntryId: (batch.episodeStartEntryId - 1) as EntryId },
    DIGEST_LIMITS.scanEntriesPerRead,
    undefined,
    context,
  );
  if (gap.next !== undefined) {
    throw new TypeError("Digest episode start is too far from its cursor to verify");
  }
  for (const entry of gap.items) {
    if (entry.kind !== ResetEntry.kind) {
      throw new TypeError("Digest episode start would skip an earlier segment with content");
    }
  }
}

/**
 * Re-derive the batch's claimed chunk from the committed transcript. This is what makes a
 * cursor advance trustworthy: every entry the batch claims to cover must exist, every
 * evidence entry in that range must be covered by exactly the claimed fragment at the
 * claimed offset, no entry before the last may lose its tail, and a complete chunk must
 * end just before its closing reset.
 */
async function validateChunkAgainstTranscript(
  conversation: Conversation,
  batch: DigestBatch,
  context: Context,
): Promise<void> {
  const page = await conversation.entries(
    { order: "ascending", minEntryId: batch.firstEntryId, maxEntryId: batch.throughEntryId },
    DIGEST_LIMITS.entriesPerBatch + 1,
    undefined,
    context,
  );
  const items = page.items;
  const last = items[items.length - 1];
  if (last === undefined || last.id !== batch.throughEntryId) {
    throw new TypeError("Digest batch does not cover its claimed entry range");
  }
  if (items.length > DIGEST_LIMITS.entriesPerBatch) {
    throw new TypeError(`Digest batch covers more than ${DIGEST_LIMITS.entriesPerBatch} entries`);
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
      if (fragment.kind !== shape!.kind || fragment.role !== shape!.role
        || (fragment.toolName ?? undefined) !== shape!.toolName) {
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
  if (batch.complete) {
    const closing = (await conversation.entries(
      { order: "ascending", minEntryId: (batch.throughEntryId + 1) as EntryId },
      1,
      undefined,
      context,
    )).items[0];
    if (closing === undefined || closing.kind !== ResetEntry.kind) {
      throw new TypeError("Digest batch claims a closed episode that is not closed in the transcript");
    }
  }
}

export function createDigestSource(options: DigestSourceOptions): DigestSource {
  const { harness } = options;
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

    async read(context) {
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
        const scanned = await scanForClosedEpisode(conversation, fromEntryId, segmentStartEntryId, budget, context);
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

    async acknowledge(batch, context) {
      validateBatchShape(batch);
      const conversationId = batch.conversationId;
      const conversation = await harness.conversation(conversationId, context);
      if (conversation === undefined) throw new TypeError("Digest batch conversation is not a committed conversation");
      if (batch.cursor.episodeStartEntryId === null) {
        await validateFreshEpisodeStart(conversation, batch, context);
      }
      await validateChunkAgainstTranscript(conversation, batch, context);
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
