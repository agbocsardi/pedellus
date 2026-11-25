/**
 * Historical compatibility for memory digestion: the completed-turn selector behind
 * `DigestSource.read()` and the mapping of a cursor stored by the earlier closed-episode reader.
 *
 * Product digestion selects reset-closed episodes through `readClosed()` in `./digestion.ts`; this
 * module is not its model-execution selector. Everything here only reads Durable. A mapped legacy
 * frontier is validated against the committed transcript and frozen by the first acknowledgement.
 */
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { DigestBatchLimits } from "./digest-limits.js";
import type { HistoryChatSession } from "./scope.js";
import { cutsSurrogatePair, isRecord, isUserInputKind } from "./transcript.js";
// ./digestion.ts composes this reader into its source. Only functions and frozen constants cross
// back, and neither module calls the other while it evaluates, so the cycle is safe.
import {
  assistantCalls,
  DIGEST_LIMITS,
  entryAt,
  evidenceShapeOf,
  readChunk,
  resultCalls,
  sameCursor,
  validateSessions,
  type DigestCursor,
  type DigestReadResult,
  type DigestSourceOptions,
} from "./digestion.js";

/**
 * True when a stored document still uses the earlier closed-episode shape (no `nextEntryId`). Such
 * a document is mapped to this reader's position once, on read; nothing is re-digested.
 */
export function isLegacyDigestCursor(document: unknown): boolean {
  return isRecord(document) && !("nextEntryId" in document);
}

interface ScanState {
  readonly startEntryId: EntryId;
  readonly sawInput: boolean;
  readonly hasContent: boolean;
  readonly pending: ReadonlySet<string>;
  /** Latest entry that already closed a completed turn inside this range, or null. */
  readonly safeEndEntryId: EntryId | null;
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
 * Walk ascending from the cursor frontier, tracking the latest completed turn, and report the widest
 * completed range one scan may accept. The range can cover several turns, so a read hands a whole
 * run of short completed turns to one batch instead of stopping at the first boundary; `readChunk`
 * then applies the evidence and entry bounds and splits only a range that does not fit.
 *
 * A new owner/scheduled input closes the preceding turn and the walk continues; a terminal assistant
 * entry with no open calls closes the range so far. The tail, a reset that follows an owner turn, or
 * the scan budget ends the walk at the last completed turn, so an unfinished trailing turn (an
 * unanswered owner message, an open tool round) stays queued for a later read rather than entering a
 * cutoff. With no completed turn yet, an in-progress tail is reported open, never as evidence.
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
  let safeEndEntryId = resumed?.safeEndEntryId ?? null;
  let lastEntryId = resumed?.lastEntryId ?? ((fromEntryId - 1) as EntryId);
  let examined = 0;
  let cursor: Cursor | undefined;
  let nextId = fromEntryId;
  const stateOf = (): ScanState => ({
    startEntryId: startEntryId!,
    sawInput,
    hasContent,
    pending,
    safeEndEntryId,
    lastEntryId,
  });
  const completeAt = (endEntryId: EntryId): ScanResult => {
    if (startEntryId === null) throw new Error("Digest scan lost its segment start");
    return { status: "complete", startEntryId, endEntryId, examined };
  };
  const settle = (): ScanResult => {
    if (!hasContent) return { status: "empty", examined };
    if (sawInput && safeEndEntryId !== null) return completeAt(safeEndEntryId);
    if (startEntryId === null) return { status: "empty", examined };
    return { status: "open", examined, reachedTail: true, state: stateOf() };
  };
  while (examined < budget) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: nextId },
      Math.min(DIGEST_LIMITS.entriesPerPage, budget - examined),
      cursor,
      context,
    );
    if (page.items.length === 0) return settle();
    for (const entry of page.items) {
      examined += 1;
      startEntryId ??= entry.id;
      if (entry.kind === ResetEntry.kind) {
        if (sawInput && hasContent) {
          // The reset closes this range at its last completed turn. When no later turn completed, the
          // reset itself closes the opening turn, so the entry before the reset is the range end.
          return completeAt(safeEndEntryId ?? lastEntryId);
        }
        // A reset before the first owner/scheduled input closes no exchange: keep it inside the
        // segment prefix so a leading system/reset block does not need a model-free batch of its own.
        pending = new Set();
        safeEndEntryId = null;
        lastEntryId = entry.id;
        nextId = (entry.id + 1) as EntryId;
        continue;
      }
      if (isUserInputKind(entry.kind)) {
        // A new input closes the preceding turn; the walk keeps going so one range can hold several
        // completed turns instead of stopping at each one.
        if (sawInput && hasContent) safeEndEntryId = lastEntryId;
        sawInput = true;
        hasContent = true;
        pending.clear();
        lastEntryId = entry.id;
        nextId = (entry.id + 1) as EntryId;
        continue;
      }
      hasContent = true;
      if (entry.kind === AssistantEntry.kind) {
        const parsed = assistantCalls(entry);
        for (const callId of parsed.calls) {
          if (!pending.has(callId) && pending.size >= DIGEST_LIMITS.maxPendingToolCalls) {
            throw new Error(
              `Digest segment has more than ${DIGEST_LIMITS.maxPendingToolCalls} open tool calls`,
            );
          }
          pending.add(callId);
        }
        // A terminal answer with every call paired closes the range so far; a later input or tool
        // result leaves that boundary valid, so it is kept as the monotonic range end.
        if (parsed.terminal && pending.size === 0) safeEndEntryId = entry.id;
      } else if (entry.kind === ToolResultEntry.kind) {
        for (const callId of resultCalls(entry)) pending.delete(callId);
      }
      lastEntryId = entry.id;
      nextId = (entry.id + 1) as EntryId;
    }
    cursor = page.next;
    if (cursor === undefined) return settle();
  }
  // The scan budget is spent before the tail: the last completed turn is still a safe range end, and
  // the next read continues from it. Entries examined after it are walked again, never skipped.
  if (sawInput && safeEndEntryId !== null) return completeAt(safeEndEntryId);
  if (startEntryId === null) return { status: "empty", examined };
  return { status: "open", examined, reachedTail: false, state: stateOf() };
}

interface SegmentBounds {
  readonly segmentStartEntryId: EntryId;
  readonly segmentEndEntryId: EntryId;
}

interface ScanCacheEntry extends ScanState {
  readonly cursor: DigestCursor;
}

interface Candidate {
  readonly session: HistoryChatSession;
  readonly conversation: Conversation;
  readonly cursor: DigestCursor;
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

/**
 * Check that a frontier mapped from the earlier closed-episode cursor still points at the extracted
 * message text this reader slices. An offset beyond that entry, or one inside a surrogate pair,
 * cannot be mapped safely; refusing is better than skipping or splitting a character.
 */
async function validateLegacyFrontier(
  conversation: Conversation,
  entryId: EntryId,
  textStart: number,
  context: Context,
): Promise<void> {
  const entry = await entryAt(conversation, entryId, context);
  if (entry === undefined) {
    throw new Error(`Digest frontier entry ${entryId} is not committed; refusing its stored offset`);
  }
  const shape = evidenceShapeOf(entry);
  if (shape === undefined) {
    if (textStart !== 0) {
      throw new Error(
        `Digest frontier entry ${entryId} has no message evidence, so offset ${textStart} cannot be ` +
        `mapped; refusing it`,
      );
    }
    return;
  }
  if (textStart > shape.length) {
    throw new Error(
      `Digest frontier offset ${textStart} is beyond entry ${entryId}'s ${shape.length} extracted ` +
      `characters; refusing it`,
    );
  }
  if (textStart > 0 && textStart < shape.length && cutsSurrogatePair(shape, textStart - 1, 1)) {
    throw new Error(
      `Digest frontier offset ${textStart} splits a surrogate pair in entry ${entryId}; refusing it`,
    );
  }
}

/** Start of the already-consumed prefix whose open calls must be restored at a mapped frontier. */
async function legacyPrefixStart(
  conversation: Conversation,
  cursor: DigestCursor,
  entryId: EntryId,
  context: Context,
): Promise<EntryId> {
  if (cursor.episodeStartEntryId !== null) return cursor.episodeStartEntryId;
  // A settled closed-episode cursor clears its bounds. Its closing reset is still in the immutable
  // transcript and no call survives a reset, so the nearest preceding reset is a safe prefix start.
  const page = await conversation.entries(
    { order: "descending", maxEntryId: entryId },
    DIGEST_LIMITS.scanEntriesPerRead,
    undefined,
    context,
  );
  const reset = page.items.find((entry) => entry.kind === ResetEntry.kind);
  if (reset !== undefined) return reset.id;
  if (page.next !== undefined) {
    throw new Error(
      `Digest frontier at entry ${entryId} is more than ${DIGEST_LIMITS.scanEntriesPerRead} entries ` +
      `from a reset; refusing to derive its open tool calls`,
    );
  }
  return 1 as EntryId;
}

/**
 * Open tool calls at a mapped legacy frontier, derived by replaying pairing over the prefix that the
 * closed-episode reader already consumed. The frontier entry itself is excluded: its tool steps
 * follow the acknowledged message offset and are still this reader's evidence. A prefix longer than
 * the scan bound fails closed rather than silently orphaning a later result.
 */
async function pendingCallsBefore(
  conversation: Conversation,
  cursor: DigestCursor,
  entryId: EntryId,
  context: Context,
): Promise<readonly string[]> {
  const start = await legacyPrefixStart(conversation, cursor, entryId, context);
  if (start >= entryId) return Object.freeze([]) as readonly string[];
  const pending = new Set<string>();
  let remaining = DIGEST_LIMITS.scanEntriesPerRead;
  let pageCursor: Cursor | undefined;
  const maxEntryId = (entryId - 1) as EntryId;
  while (remaining > 0) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: start, maxEntryId },
      Math.min(DIGEST_LIMITS.entriesPerPage, remaining),
      pageCursor,
      context,
    );
    for (const entry of page.items) {
      remaining -= 1;
      if (entry.kind === AssistantEntry.kind) {
        for (const id of assistantCalls(entry).calls) pending.add(id);
      } else if (entry.kind === ToolResultEntry.kind) {
        for (const id of resultCalls(entry)) pending.delete(id);
      } else if (entry.kind === ResetEntry.kind) {
        pending.clear();
      }
    }
    pageCursor = page.next;
    if (pageCursor === undefined) break;
  }
  if (pageCursor !== undefined || remaining < 0) {
    throw new Error(
      `Digest frontier prefix at entry ${entryId} is longer than ` +
      `${DIGEST_LIMITS.scanEntriesPerRead} entries; refusing to derive its open tool calls`,
    );
  }
  return Object.freeze([...pending].sort());
}

/**
 * Map a frontier stored by the earlier closed-episode reader to this reader's position: check its
 * offset still points at extracted message text, then derive the tool calls open there. That needs
 * the transcript, which the acknowledgement transaction cannot walk, so it happens on read and is
 * frozen by the first acknowledgement.
 */
export async function mapLegacyFrontier(
  options: DigestSourceOptions,
  conversationId: ConversationId,
  cursor: DigestCursor,
  context: Context,
): Promise<DigestCursor> {
  if (cursor.nextEntryId === null) return cursor;
  const conversation = await options.harness.conversation(conversationId, context);
  if (conversation === undefined) {
    throw new Error(
      `Digest frontier for conversation ${conversationId} has no committed conversation; ` +
      `refusing to map it`,
    );
  }
  await validateLegacyFrontier(conversation, cursor.nextEntryId, cursor.nextTextStart, context);
  return {
    ...cursor,
    pendingToolCalls: await pendingCallsBefore(conversation, cursor, cursor.nextEntryId, context),
  };
}

/** The historical completed-turn selector behind `DigestSource.read()`. */
export interface LegacyCompletedTurnReader {
  read(context: Context, batchLimits: DigestBatchLimits): Promise<DigestReadResult>;
  /** Drop a conversation's derived scan position once its cursor moved. */
  forget(conversationId: ConversationId): void;
}

/**
 * Completed-turn selection for historical SDK compatibility: the oldest unprocessed completed chunk
 * across mapped chats, open or reset-closed. Product digestion uses `readClosed()` instead.
 */
export function createLegacyCompletedTurnReader(
  options: DigestSourceOptions,
  cursorFor: (conversationId: ConversationId, context: Context) => Promise<DigestCursor>,
): LegacyCompletedTurnReader {
  // Derived scan positions only: losing them costs a repeated bounded scan, never evidence.
  const scanCache = new Map<ConversationId, ScanCacheEntry>();
  // Discovery order rotates so one busy chat cannot spend every read's budget before the others.
  let rotation = 0;
  return {
    async read(context, batchLimits) {
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
      const conversation = await options.harness.conversation(conversationId, context);
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
        // A cached scan already examined this tail and found no completed boundary.
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
      segmentStartEntryId: chosen.cursor.episodeStartEntryId!,
      segmentEndEntryId: chosen.cursor.episodeEndEntryId!,
    };
    const firstEntryId = (chosen.segment !== undefined
      ? segment.segmentStartEntryId
      : chosen.cursor.nextEntryId!) as EntryId;
    // The cursor position is this chunk's start when the chunk begins at the cursor frontier: a
    // fresh segment starts there, and a frontier mapped from the closed-episode cursor resumes
    // inside that entry at the already-digested message offset instead of re-emitting it.
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
    return {
      status: "batch",
      sessionKey: chosen.session.sessionKey,
      conversationId: chosen.session.conversationId,
      episodeStartEntryId: segment.segmentStartEntryId,
      episodeEndEntryId: segment.segmentEndEntryId,
      firstEntryId,
      firstItemIndex,
      firstTextStart,
      throughEntryId: chunk.throughEntryId,
      throughItemIndex: chunk.throughItemIndex,
      throughChars: chunk.throughChars,
      complete: chunk.complete,
      nextEntryId: chunk.nextEntryId,
      nextItemIndex: chunk.nextItemIndex,
      nextTextStart: chunk.nextTextStart,
      entries: chunk.entries,
      cursor: chosen.cursor,
    };
    },
    forget(conversationId) {
      scanCache.delete(conversationId);
    },
  };
}
