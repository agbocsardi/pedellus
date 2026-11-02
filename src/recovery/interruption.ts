import type { Draft } from "@earendil-works/chord";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { CronDeliveryRecord } from "../automation/cron-delivery.js";

/**
 * Automatic startup recovery of one interrupted prepared turn.
 *
 * A prepared dispatch that pins historical Nanobot context cannot be resumed, so the open cancels
 * it through native `abortTask` instead of refusing to serve. This module owns the small durable
 * record that bridges the native abort and the channel notice, and the notice record itself. It
 * grants no authority: delivery still uses the existing bounded channel outbox, which re-checks the
 * live origin admission and keeps an ambiguous external send held.
 *
 * The notice never enters a transcript, starts a turn or calls a model. It says only what the host
 * knows: the turn was cancelled, stored progress survived, and an already-started external action
 * may have completed without a confirmed result.
 */
export const TURN_INTERRUPTION_NOTICE =
  "Previous turn was interrupted. Recorded progress is preserved, but some actions may have completed " +
  "without confirmation. Ask me to continue.";

/** A compaction is background maintenance, not a user turn: say what was interrupted and that nothing is owed. */
export const COMPACTION_INTERRUPTION_NOTICE =
  "Background context compaction was interrupted. Recorded progress is preserved; no action is needed.";

/** A worker or scheduled run is background work, not the owner's previous turn. */
export const BACKGROUND_INTERRUPTION_NOTICE =
  "Background work was interrupted. Recorded progress is preserved, but some actions may have completed " +
  "without confirmation. Ask me to continue if you still need it.";

/** Memory digestion is host maintenance: the unacknowledged batch is offered again, so nothing is owed. */
export const DIGEST_INTERRUPTION_NOTICE =
  "Background memory digestion was interrupted. Recorded progress is preserved; the unacknowledged batch " +
  "is offered again, so no action is needed.";

export type InterruptedPreparedKind = "pi.generation" | "pi.compaction";

/** The owner-visible class of the surface a cancelled prepared dispatch belonged to. */
export type InterruptionSurface = "chat" | "worker" | "digest" | "scheduled";

/**
 * Truthful wording for the interrupted class. Compaction is background maintenance wherever it ran;
 * an owner turn keeps its manual continuation suggestion, and background work never claims a turn.
 */
export function interruptionNoticeText(
  kind: InterruptedPreparedKind,
  surface: InterruptionSurface = "chat",
): string {
  if (kind === "pi.compaction") return COMPACTION_INTERRUPTION_NOTICE;
  if (surface === "worker" || surface === "scheduled") return BACKGROUND_INTERRUPTION_NOTICE;
  if (surface === "digest") return DIGEST_INTERRUPTION_NOTICE;
  return TURN_INTERRUPTION_NOTICE;
}

/** Record ids in the shared bounded delivery outbox that are host interruption notices, not cron results. */
export const TURN_INTERRUPTION_NOTICE_ID_PREFIX = "host:turn-interrupted:";

/**
 * Pending interruption marks are transient: one is cleared in the same commit that admits its
 * notice. The bound keeps a damaged or repeatedly failing store from growing without limit; a full
 * list refuses automatic recovery instead of dropping the notice silently.
 */
export const TURN_INTERRUPTION_MAX_MARKS = 8;

export type TurnInterruptionMark = {
  readonly taskId: number;
  /** Which prepared dispatch was interrupted; the notice wording must stay truthful about a turn vs compaction. */
  readonly kind: InterruptedPreparedKind;
  /** Mapped chat conversation that owns the originating surface, never a worker/digest/automation target. */
  readonly originConversationId: ConversationId;
  readonly sessionKey: string;
  readonly createdAtMs: number;
};

export type TurnInterruptionMarks = {
  marks: TurnInterruptionMark[];
};

/**
 * Session-scoped, so one read finds every pending mark regardless of conversation. A mark is
 * written before the native abort, so a crash in either window still admits the notice on the next
 * open; it is removed only with the notice admission, so no notice is lost or duplicated by a crash.
 */
export const TurnInterruptionMarksDoc = defineDoc<TurnInterruptionMarks>({
  kind: "nanobot.turn-interruptions",
  version: 1,
  scope: "session",
  initial: () => ({ marks: [] }),
  checkpointWhen: () => true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict validation: a mark this build does not understand is never overwritten or guessed. */
export function parseTurnInterruptionMarks(doc: unknown): TurnInterruptionMark[] {
  if (!isRecord(doc) || !Array.isArray(doc.marks)) {
    throw new Error("Stored interruption recovery record is malformed");
  }
  const seen = new Set<number>();
  const marks: TurnInterruptionMark[] = [];
  for (const entry of doc.marks) {
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.taskId) || (entry.taskId as number) < 1
      || (entry.kind !== "pi.generation" && entry.kind !== "pi.compaction")
      || !Number.isSafeInteger(entry.originConversationId) || (entry.originConversationId as number) < 1
      || typeof entry.sessionKey !== "string" || entry.sessionKey.length === 0
      || !Number.isSafeInteger(entry.createdAtMs) || (entry.createdAtMs as number) < 0) {
      throw new Error("Stored interruption recovery record is malformed");
    }
    if (seen.has(entry.taskId as number)) {
      throw new Error("Stored interruption recovery record repeats a task");
    }
    seen.add(entry.taskId as number);
    marks.push({
      taskId: entry.taskId as number,
      kind: entry.kind,
      originConversationId: entry.originConversationId as ConversationId,
      sessionKey: entry.sessionKey,
      createdAtMs: entry.createdAtMs as number,
    });
  }
  return marks;
}

export type TurnInterruptionMarkAdmission = "added" | "duplicate" | "full";

/** Add one mark without touching an existing one. The caller supplies the validated persisted list. */
export function addTurnInterruptionMark(
  doc: Draft<TurnInterruptionMarks>,
  mark: TurnInterruptionMark,
  max: number = TURN_INTERRUPTION_MAX_MARKS,
): TurnInterruptionMarkAdmission {
  const marks = parseTurnInterruptionMarks(doc);
  if (marks.some((entry) => entry.taskId === mark.taskId)) return "duplicate";
  if (marks.length >= max) return "full";
  doc.marks = [...marks, mark];
  return "added";
}

/** Remove exactly the named task marks; other marks stay untouched. Returns the number removed. */
export function removeTurnInterruptionMarks(doc: Draft<TurnInterruptionMarks>, taskIds: ReadonlySet<number>): number {
  const marks = parseTurnInterruptionMarks(doc);
  const kept = marks.filter((entry) => !taskIds.has(entry.taskId));
  doc.marks = kept;
  return marks.length - kept.length;
}

export type TurnInterruptionOrigin = {
  readonly conversationId: ConversationId;
  readonly sessionKey: string;
  readonly surface: InterruptionSurface;
};

export type InterruptionOriginSources = {
  /** The mapped chat session key of one conversation, or undefined when it is not mapped chat. */
  readonly chatSessionKey: (conversationId: ConversationId) => string | undefined;
  /** The origin this conversation records as a scheduled run's automation target. */
  readonly automationOrigin: (conversationId: ConversationId) => ConversationId | undefined;
  /** The origin and class of the worker or digest task that owns this target conversation. */
  readonly backgroundOrigin: (conversationId: ConversationId) => {
    readonly originConversationId: ConversationId;
    readonly surface: "worker" | "digest";
  } | undefined;
};

/**
 * The legitimate owning surface of a prepared dispatch, in class order: a mapped chat owns itself,
 * a scheduled-run automation conversation is owned by its origin, and a worker/digest target is
 * owned by the run task that created it. A target with no mapped-chat origin yields none rather than
 * routing a user-facing notice to a task-owned conversation.
 */
export function interruptionOrigin(
  conversationId: ConversationId,
  sources: InterruptionOriginSources,
): TurnInterruptionOrigin | undefined {
  const direct = sources.chatSessionKey(conversationId);
  if (direct !== undefined) return { conversationId, sessionKey: direct, surface: "chat" };
  const automation = sources.automationOrigin(conversationId);
  if (automation !== undefined) {
    const sessionKey = sources.chatSessionKey(automation);
    if (sessionKey !== undefined) return { conversationId: automation, sessionKey, surface: "scheduled" };
  }
  const background = sources.backgroundOrigin(conversationId);
  if (background !== undefined) {
    const sessionKey = sources.chatSessionKey(background.originConversationId);
    if (sessionKey !== undefined) {
      return { conversationId: background.originConversationId, sessionKey, surface: background.surface };
    }
  }
  return undefined;
}

export function turnInterruptionNoticeId(taskId: number): string {
  if (!Number.isSafeInteger(taskId) || taskId < 1) {
    throw new Error("Interruption notice requires a positive integer task id");
  }
  return `${TURN_INTERRUPTION_NOTICE_ID_PREFIX}${taskId}`;
}

/** One pending delivery through the existing bounded channel outbox; keyed by task for idempotent admission. */
export function turnInterruptionDelivery(
  sessionKey: string,
  taskId: number,
  createdAtMs: number,
  kind: InterruptedPreparedKind = "pi.generation",
  surface: InterruptionSurface = "chat",
): CronDeliveryRecord {
  if (sessionKey.length === 0) throw new Error("Interruption notice requires an origin session key");
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error("Interruption notice requires a valid creation time");
  }
  return {
    id: turnInterruptionNoticeId(taskId),
    sessionKey,
    text: interruptionNoticeText(kind, surface),
    createdAtMs,
    status: "pending",
    nextChunkIndex: 0,
  };
}

/**
 * Fixed, credential-free fault text for a store whose interruption record could not be read. Retiring
 * it keeps startup available; the notices it held are gone, so this is the only remaining evidence.
 */
export const INTERRUPTION_RECORD_DAMAGED_FAULT =
  "an unreadable interruption record was retired so startup could continue; a pending interruption " +
  "notice may have been lost";

/** True for a host interruption notice record, including a settled or held one. */
export function isTurnInterruptionNotice(record: { readonly id?: unknown }): boolean {
  return typeof record.id === "string" && record.id.startsWith(TURN_INTERRUPTION_NOTICE_ID_PREFIX);
}

/**
 * One background run whose internal model-facing terminal report the host suppressed.
 *
 * Startup recovery cancels a prepared dispatch inside a worker or digest target conversation; the
 * owning run then fails and would normally admit its internal result event into the origin chat,
 * which starts a model turn. The owner's policy is one host notice and manual continuation, so the
 * exact run is recorded here before the native abort and consumed by its own terminal commit. That
 * commit and the suppression are atomic, so a reopen, an abort, or a crash between the abort and the
 * notice admission cannot resurrect the report.
 */
export type InterruptedRunReport = {
  readonly runTaskId: number;
  readonly targetConversationId: ConversationId;
  readonly recordedAtMs: number;
};

export type InterruptedRunReports = {
  runs: InterruptedRunReport[];
};

/** Bounded like the marks: one entry per live background run that startup recovery interrupted. */
export const INTERRUPTED_RUN_REPORT_MAX = 8;

export const InterruptedRunReportsDoc = defineDoc<InterruptedRunReports>({
  kind: "nanobot.interrupted-run-reports",
  version: 1,
  scope: "session",
  initial: () => ({ runs: [] }),
  checkpointWhen: () => true,
});

/** Strict validation: an entry this build does not understand is never overwritten or guessed. */
export function parseInterruptedRunReports(doc: unknown): InterruptedRunReport[] {
  if (!isRecord(doc) || !Array.isArray(doc.runs)) {
    throw new Error("Stored interrupted-run report record is malformed");
  }
  const seen = new Set<number>();
  const runs: InterruptedRunReport[] = [];
  for (const entry of doc.runs) {
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.runTaskId) || (entry.runTaskId as number) < 1
      || !Number.isSafeInteger(entry.targetConversationId) || (entry.targetConversationId as number) < 1
      || !Number.isSafeInteger(entry.recordedAtMs) || (entry.recordedAtMs as number) < 0) {
      throw new Error("Stored interrupted-run report record is malformed");
    }
    if (seen.has(entry.runTaskId as number)) {
      throw new Error("Stored interrupted-run report record repeats a run");
    }
    seen.add(entry.runTaskId as number);
    runs.push({
      runTaskId: entry.runTaskId as number,
      targetConversationId: entry.targetConversationId as ConversationId,
      recordedAtMs: entry.recordedAtMs as number,
    });
  }
  return runs;
}

export type InterruptedRunReportAdmission = "added" | "duplicate" | "full";

export function addInterruptedRunReport(
  doc: Draft<InterruptedRunReports>,
  run: InterruptedRunReport,
  max: number = INTERRUPTED_RUN_REPORT_MAX,
): InterruptedRunReportAdmission {
  const runs = parseInterruptedRunReports(doc);
  if (runs.some((entry) => entry.runTaskId === run.runTaskId)) return "duplicate";
  if (runs.length >= max) return "full";
  doc.runs = [...runs, run];
  return "added";
}

/** True when exactly this run's report is recorded as suppressed. */
export function interruptedRunReportPending(
  doc: InterruptedRunReports | undefined,
  runTaskId: number,
  targetConversationId: ConversationId,
): boolean {
  if (doc === undefined) return false;
  try {
    return parseInterruptedRunReports(doc)
      .some((entry) => entry.runTaskId === runTaskId && entry.targetConversationId === targetConversationId);
  } catch {
    return false;
  }
}

/** Remove exactly this run's entry after its terminal commit suppressed the report. */
export function consumeInterruptedRunReport(
  doc: Draft<InterruptedRunReports>,
  runTaskId: number,
  targetConversationId: ConversationId,
): boolean {
  const runs = parseInterruptedRunReports(doc);
  const kept = runs.filter((entry) =>
    entry.runTaskId !== runTaskId || entry.targetConversationId !== targetConversationId);
  doc.runs = kept;
  return kept.length !== runs.length;
}
