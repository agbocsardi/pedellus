/**
 * Startup interruption recovery: the one automatic repair startup performs before scheduling resumes.
 *
 * A prepared provider dispatch whose pinned context still contains Nanobot sections cannot replay
 * safely, so it is cancelled through the native abort. A mark is written first for every dispatch with
 * a mapped origin, so a crash between that write, the abort and the owner notice is reconciled on the
 * next open; each notice goes only to the mapped chat that owned the interrupted work, through its
 * existing bounded outbox. An unreadable recovery record is retired, never repaired in place, and a
 * damaged outbox never blocks the gateway. Nothing here is retried blindly or evicted silently.
 */
import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, EntryId, Harness as HarnessType, TaskId, Tx } from "@earendil-works/pi-durable";
import { CRON_RUN_TASK_NAME } from "../automation/cron.js";
import {
  admitCronDelivery,
  CronDeliveriesDoc,
  CronDeliveryFaultsDoc,
  recordCronDeliveryFault,
} from "../automation/cron-delivery.js";
import { MEMORY_DIGEST_TASK_NAME } from "../history/memory-digest.js";
import type { HistoryChatSession } from "../history/scope.js";
import { StartupDiagnosticError } from "../startup-diagnostics.js";
import { WORKER_TASK_NAME } from "../workers/worker-task.js";
import {
  addInterruptedRunReport,
  addTurnInterruptionMark,
  INTERRUPTED_RUN_REPORT_MAX,
  INTERRUPTION_RECORD_DAMAGED_FAULT,
  InterruptedRunReportsDoc,
  interruptionOrigin,
  parseInterruptedRunReports,
  parseTurnInterruptionMarks,
  removeTurnInterruptionMarks,
  TurnInterruptionMarksDoc,
  TURN_INTERRUPTION_MAX_MARKS,
  turnInterruptionDelivery,
  type InterruptedPreparedKind,
  type InterruptionSurface,
  type TurnInterruptionMark,
  type TurnInterruptionOrigin,
} from "./interruption.js";
import { hasPersistedNanobotContext, type PreparedContextReplay } from "./prepared.js";

export interface StartupRecoveryOptions {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly context: Context;
  readonly now: () => number;
  /** The validated mapped ordinary chats: the only owners a notice can reach. */
  readonly mappedChatSessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  /** The origin this open restored for a classified automation conversation. */
  readonly automationOrigin: (id: ConversationId) => ConversationId | undefined;
  /** The run task that still targets a background conversation, resolved by the restore scan. */
  readonly backgroundRun: (id: ConversationId) =>
    { readonly originConversationId: ConversationId; readonly surface: "worker" | "digest" | "scheduled" } | undefined;
}

/**
 * Inspect every prepared dispatch's pinned context, then cancel and report the ones that cannot
 * replay safely. Throws a `preparedContext` startup diagnostic when that cannot be done automatically.
 */
export async function recoverStartupInterruptions(
  options: StartupRecoveryOptions,
  preparedContextReplays: readonly PreparedContextReplay[],
): Promise<void> {
  const { harness, root, context, now } = options;
  /**
   * Retire a record this build cannot read. Native `retireDoc` preserves the unreadable incarnation
   * in the store's document history without materializing, repairing or overwriting its value, so
   * availability does not depend on a manual repair step for optional notice bookkeeping.
   */
  const retireUnreadableRecord = async (retire: (tx: Tx) => Promise<void>): Promise<void> => {
    try {
      await harness.commit(retire, context);
    } catch (cause) {
      throw new StartupDiagnosticError("preparedContext", {
        cause,
        detail: "Cannot retire an unreadable interruption recovery record; run the context recovery interface " +
          "before gateway recovery",
      });
    }
  };

  /**
   * Read the pending interruption facts. A record this build cannot read is retired rather than
   * repaired: the notices it held are lost (the one thing those transient marks were for), a fixed
   * delivery fault is recorded where an origin is known, and the authoritative task scan below still
   * cancels the startup-blocking prepared dispatch.
   */
  const readInterruptionMarks = async (): Promise<{ marks: TurnInterruptionMark[]; damaged: boolean }> => {
    let stored;
    try {
      stored = await harness.snapshot(TurnInterruptionMarksDoc, context);
    } catch {
      await retireUnreadableRecord((tx) => tx.retireDoc(TurnInterruptionMarksDoc));
      return { marks: [], damaged: true };
    }
    if (stored === undefined) return { marks: [], damaged: false };
    try {
      return { marks: parseTurnInterruptionMarks(stored), damaged: false };
    } catch {
      await retireUnreadableRecord((tx) => tx.retireDoc(TurnInterruptionMarksDoc));
      return { marks: [], damaged: true };
    }
  };

  /** The same availability rule for the interrupted-run record: retire, never repair in place. */
  const ensureInterruptedRunReportsReadable = async (): Promise<void> => {
    let stored;
    try {
      stored = await harness.snapshot(InterruptedRunReportsDoc, context);
    } catch {
      await retireUnreadableRecord((tx) => tx.retireDoc(InterruptedRunReportsDoc));
      return;
    }
    if (stored === undefined) return;
    try {
      parseInterruptedRunReports(stored);
    } catch {
      await retireUnreadableRecord((tx) => tx.retireDoc(InterruptedRunReportsDoc));
    }
  };

  // The origin of a prepared dispatch is the mapped chat that owns it, never the worker, digest or
  // scheduled-run target conversation. A target is resolved through the class the open restored or
  // the run task that still owns it; no session key is inferred from a conversation id.
  const interruptionOriginFor = (
    conversationId: ConversationId,
    sessions: ReadonlyMap<ConversationId, string>,
  ) => interruptionOrigin(conversationId, {
    chatSessionKey: (id) => sessions.get(id),
    automationOrigin: (id) => options.automationOrigin(id),
    backgroundOrigin: (id) => {
      const run = options.backgroundRun(id);
      if (run === undefined || run.surface === "scheduled") return undefined;
      return { originConversationId: run.originConversationId, surface: run.surface };
    },
  });

  /**
   * The class a cancelled prepared dispatch belonged to, for wording that stays true. A target
   * conversation's owning run task names its class even after that run is terminal, so a notice
   * admitted after a crash window still says what was interrupted.
   */
  const interruptionSurfaceIn = async (tx: Tx, conversationId: ConversationId): Promise<InterruptionSurface> => {
    const ownerTaskId = (await tx.conversation(conversationId))?.owner?.taskId;
    if (ownerTaskId === undefined) return options.automationOrigin(conversationId) !== undefined ? "scheduled" : "chat";
    const owner = await tx.task(ownerTaskId as TaskId);
    if (owner?.kind === WORKER_TASK_NAME) return "worker";
    if (owner?.kind === MEMORY_DIGEST_TASK_NAME) return "digest";
    if (owner?.kind === CRON_RUN_TASK_NAME) return "scheduled";
    return "chat";
  };

  /**
   * Admit one notice per marked task into its origin's existing bounded channel outbox, then clear
   * the mark in the same commit. A settled non-abort outcome (or a completed turn that won the race)
   * is not reported as an interruption; a mark whose origin is no longer this mapped chat is dropped
   * instead of rerouted. An unreadable/full outbox keeps gateway availability and records a bounded
   * delivery fault; the notice is not retried and no unknown-outcome record is evicted.
   */
  const admitInterruptionNotices = async (
    sessions: ReadonlyMap<ConversationId, string>,
    marks: readonly TurnInterruptionMark[],
    damaged: boolean,
    origins: ReadonlyMap<number, TurnInterruptionOrigin>,
  ): Promise<void> => {
    if (marks.length === 0 && !damaged) return;
    const deliverable: TurnInterruptionMark[] = [];
    const clear = new Set<number>();
    for (const mark of marks) {
      const task = await harness.getTask(mark.taskId as TaskId, context);
      if (task === undefined) {
        clear.add(mark.taskId);
        continue;
      }
      const interrupted = task.state.status === "terminal"
        ? task.state.outcome.status !== "completed"
        : task.abortRequested === true;
      if (!interrupted) {
        clear.add(mark.taskId);
        continue;
      }
      if (sessions.get(mark.originConversationId) !== mark.sessionKey) {
        clear.add(mark.taskId);
        continue;
      }
      deliverable.push(mark);
    }
    if (deliverable.length === 0 && clear.size === 0 && !damaged) return;
    await root.commit(async (tx) => {
      const markDoc = await tx.doc(TurnInterruptionMarksDoc);
      // Fail closed on damaged state instead of overwriting a mark this build does not understand.
      parseTurnInterruptionMarks(markDoc);
      for (const mark of deliverable) {
        if ((await tx.conversation(mark.originConversationId)) === undefined) {
          clear.add(mark.taskId);
          continue;
        }
        let admission: "admitted" | "duplicate" | "full" | "invalid" = "invalid";
        try {
          const deliveries = await tx.doc(CronDeliveriesDoc, mark.originConversationId);
          const interrupted = await tx.task(mark.taskId as TaskId);
          admission = admitCronDelivery(
            deliveries,
            turnInterruptionDelivery(
              mark.sessionKey,
              mark.taskId,
              now(),
              mark.kind,
              await interruptionSurfaceIn(tx, interrupted?.conversationId ?? mark.originConversationId),
            ),
          );
        } catch {
          admission = "invalid";
        }
        if (admission === "full" || admission === "invalid") {
          try {
            const faults = await tx.doc(CronDeliveryFaultsDoc, mark.originConversationId);
            recordCronDeliveryFault(faults, {
              jobId: null,
              scheduledAtMs: null,
              recordedAtMs: now(),
              message: admission === "full"
                ? "interruption notice was not queued: delivery outbox is full"
                : "interruption notice was not queued: delivery outbox is malformed",
            });
          } catch {
            // This diagnostic is derived state; it must not stop the gateway from recovering.
          }
        }
        clear.add(mark.taskId);
      }
      if (damaged) {
        // The retired record's own notices are gone; record the fixed loss once per origin this open
        // can still name. The fault list is bounded and this text is value-free.
        for (const originConversationId of new Set([...origins.values()].map((origin) => origin.conversationId))) {
          try {
            const faults = await tx.doc(CronDeliveryFaultsDoc, originConversationId);
            recordCronDeliveryFault(faults, {
              jobId: null,
              scheduledAtMs: null,
              recordedAtMs: now(),
              message: INTERRUPTION_RECORD_DAMAGED_FAULT,
            });
          } catch {
            // Same bounded diagnostic rule: never stop the gateway for derived state.
          }
        }
      }
      if (clear.size > 0) removeTurnInterruptionMarks(markDoc, clear);
    }, context);
  };

  /**
   * Cancel every prepared dispatch whose pinned context still contains Nanobot sections. The
   * detailed error is for SDK callers; the CLI prints one fixed recovery diagnostic. A mark is
   * written first for every dispatch with a mapped origin, so a crash between that write, the
   * native abort and the notice admission is reconciled on the next open. A dispatch whose
   * prepared model left `allowedModels` never reaches here: the scan above fails closed first.
   */
  const recoverInterruptedPreparedTurns = async (blocked: readonly PreparedContextReplay[]): Promise<void> => {
    const stored = await readInterruptionMarks();
    if (blocked.length === 0 && stored.marks.length === 0) return;
    const sessions = new Map((await options.mappedChatSessions(context))
      .map(({ conversationId, sessionKey }) => [conversationId, sessionKey] as const));
    const origins = new Map<number, TurnInterruptionOrigin>();
    for (const replay of blocked) {
      const origin = interruptionOriginFor(replay.conversationId, sessions);
      if (origin !== undefined) origins.set(replay.id, origin);
    }
    // Admit notices already pending from an earlier open first, so a bounded mark list is drained
    // of settled entries before it can refuse a new one and force a manual recovery.
    try {
      await admitInterruptionNotices(sessions, stored.marks, stored.damaged, origins);
    } catch {
      // The marks stay durable; the next open retries. Notice admission is bookkeeping, not startup
      // authority, so it must not turn a damaged outbox into a dead end.
    }
    if (blocked.length === 0) return;
    const additions: TurnInterruptionMark[] = [];
    // Only a dispatch whose cancellation fails the owning run can leave an internal report to
    // suppress: the conversation's own generation, or a blocking compaction a generation waits on.
    // A background or manual compaction is cancelled without failing the run, so it records nothing.
    const candidates: {
      readonly replayId: number;
      readonly kind: InterruptedPreparedKind;
      readonly targetConversationId: ConversationId;
    }[] = [];
    for (const replay of blocked) {
      if (!stored.marks.some((mark) => mark.taskId === replay.id)) {
        const origin = origins.get(replay.id);
        if (origin !== undefined) {
          additions.push({
            taskId: replay.id,
            kind: replay.kind,
            originConversationId: origin.conversationId,
            sessionKey: origin.sessionKey,
            createdAtMs: now(),
          });
        }
      }
      candidates.push({ replayId: replay.id, kind: replay.kind, targetConversationId: replay.conversationId });
    }
    if (additions.length > 0 || candidates.length > 0) {
      if (candidates.length > 0) await ensureInterruptedRunReportsReadable();
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnInterruptionMarksDoc);
        for (const mark of additions) {
          const result = addTurnInterruptionMark(doc, mark);
          if (result === "full") {
            throw new StartupDiagnosticError("preparedContext", {
              detail: `Cannot automatically recover interrupted turns: the bounded interruption record holds ` +
                `${TURN_INTERRUPTION_MAX_MARKS} pending notices; cancel the blocked prepared dispatch with the ` +
                "context recovery interface before gateway recovery",
            });
          }
        }
        if (candidates.length === 0) return;
        const reportDoc = await tx.doc(InterruptedRunReportsDoc);
        // Reuse slots a crashed earlier open left behind: only a live run can consume one.
        const live: typeof reportDoc.runs = [];
        for (const entry of parseInterruptedRunReports(reportDoc)) {
          const task = await tx.task(entry.runTaskId as TaskId);
          if (task === undefined || task.state.status === "terminal") continue;
          live.push(entry);
        }
        reportDoc.runs = live;
        const runByTarget = new Map<ConversationId, number | undefined>();
        for (const candidate of candidates) {
          if (candidate.kind === "pi.compaction") {
            const compaction = await tx.task(candidate.replayId as TaskId);
            if (compaction?.owner === undefined) continue;
          }
          if (!runByTarget.has(candidate.targetConversationId)) {
            // The target's owning run task is the one whose internal report must stay silent. It is
            // read here, so a failed or finished run is never guessed from a target id.
            const ownerTaskId = (await tx.conversation(candidate.targetConversationId))?.owner?.taskId;
            const run = ownerTaskId === undefined ? undefined : await tx.task(ownerTaskId as TaskId);
            runByTarget.set(candidate.targetConversationId,
              run === undefined || run.state.status === "terminal"
                || (run.kind !== WORKER_TASK_NAME && run.kind !== MEMORY_DIGEST_TASK_NAME)
                ? undefined
                : ownerTaskId);
          }
          const runTaskId = runByTarget.get(candidate.targetConversationId);
          if (runTaskId === undefined) continue;
          const result = addInterruptedRunReport(reportDoc, {
            runTaskId,
            targetConversationId: candidate.targetConversationId,
            recordedAtMs: now(),
          });
          if (result === "full") {
            throw new StartupDiagnosticError("preparedContext", {
              detail: `Cannot automatically recover interrupted turns: the bounded interrupted-run record holds ` +
                `${INTERRUPTED_RUN_REPORT_MAX} live runs; cancel the blocked prepared dispatch with the context ` +
                "recovery interface before gateway recovery",
            });
          }
        }
      }, context);
    }
    for (const replay of blocked) {
      // A cascade from an earlier abort can already have settled this task; never abort a terminal
      // task or repeat an existing mark.
      const current = await harness.getTask(replay.id as TaskId, context);
      if (current === undefined || current.state.status === "terminal" || current.abortRequested === true) continue;
      try {
        await harness.abortTask(replay.id as TaskId, context);
      } catch (cause) {
        throw new StartupDiagnosticError("preparedContext", {
          cause,
          detail: `Cannot automatically cancel ${replay.kind} task ${replay.id} (${replay.phase}): the native ` +
            "abort failed; cancel that prepared dispatch with the context recovery interface before gateway recovery",
        });
      }
    }
    for (const replay of blocked) {
      const task = await harness.getTask(replay.id as TaskId, context);
      if (task === undefined || task.state.status === "terminal" || task.abortRequested === true) continue;
      throw new StartupDiagnosticError("preparedContext", {
        detail: `Cannot safely recover ${replay.kind} task ${replay.id} (${replay.phase}): the native abort mark ` +
          "did not persist; cancel that prepared dispatch with the context recovery interface before gateway recovery",
      });
    }
    const admitted = await readInterruptionMarks();
    try {
      await admitInterruptionNotices(sessions, admitted.marks, admitted.damaged, origins);
    } catch {
      // The marks stay durable; the next open retries and the gateway stays available.
    }
  };

  const blockedPreparedTurns: PreparedContextReplay[] = [];
  for (const replay of preparedContextReplays) {
    try {
      const conversation = await harness.conversation(replay.conversationId, context);
      if (!conversation) throw new Error("conversation is missing");
      const view = await conversation.context(context, { at: replay.at as EntryId });
      if (hasPersistedNanobotContext(view.messages)) blockedPreparedTurns.push(replay);
    } catch (cause) {
      throw new StartupDiagnosticError("preparedContext", {
        cause,
        detail: `Cannot inspect the pinned context of ${replay.kind} task ${replay.id} (${replay.phase}); ` +
          "cancel that prepared dispatch with the context recovery interface before gateway recovery",
      });
    }
  }
  await recoverInterruptedPreparedTurns(blockedPreparedTurns);
}
