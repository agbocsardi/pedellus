/**
 * Persistent automation conversations for scheduled runs.
 *
 * A conversation is ongoing activity and an episode is one execution. A recurring job keeps one
 * conversation for its whole life and starts a new reset-delimited episode for each run; one-off
 * jobs share one catch-all conversation per origin chat and each occurrence contributes its own
 * episode. Both are created lazily by the run that first needs them and are recorded twice:
 *
 * - the origin conversation's `nanobot.cron.jobs` document (`CronJobsDoc`) names the conversation
 *   that belongs to each job, and the catch-all one-off conversation, so the record never grows
 *   with the number of runs;
 * - the automation conversation itself carries a `nanobot.cron.conversation` marker naming its
 *   class and origin, so a host can classify it from the conversation rather than by the accident
 *   of it being absent from the session map.
 *
 * Nothing here creates a chat session, captures tool authority, owns a task or schedules work.
 * Automation conversations are ownerless and outlive every run task that uses them; each run
 * prepares its own authority and workspace context and retires it when it terminates, so
 * persistent history never confers persistent permission.
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

export const CRON_CONVERSATION_KIND = "nanobot.cron.conversation";

/**
 * Bound on the catch-all one-off queue: live entries for admitted but not yet finished one-off
 * runs, counting the run that currently holds the catch-all conversation. A full queue refuses the
 * new occurrence with a fixed, visible error instead of growing without limit or running out of
 * order.
 */
export const CRON_ONE_OFF_QUEUE_LIMIT = 16;

/** Why one automation conversation exists. Never a chat, an origin or a scheduling scope. */
export type CronConversationClass = "recurring" | "one-off";

/** Marker document on an automation conversation: its own durable classification. */
export interface CronConversationRecord {
  readonly [key: string]: JsonValue;
  /** `recurring` for one job's own conversation, `one-off` for one origin's catch-all. */
  readonly conversationClass: CronConversationClass;
  /** The chat conversation whose jobs run here; never itself an automation conversation. */
  readonly originConversationId: number;
  /** Owning job for a recurring conversation; absent for a catch-all one-off conversation. */
  readonly jobId: string | null;
}

export const CronConversationDoc = defineDoc<CronConversationRecord>({
  kind: CRON_CONVERSATION_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ conversationClass: "one-off", originConversationId: 0, jobId: null }),
  checkpointWhen: () => true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one stored marker as a classification, or `undefined` when it is absent, malformed, or names
 * something else. A host treats "not classified" as "not an automation conversation", so a damaged
 * record can never grant the class; the owning job recreates its conversation on the next run.
 */
export function automationConversationOf(value: unknown): CronConversationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { conversationClass, originConversationId, jobId } = value;
  if (conversationClass !== "recurring" && conversationClass !== "one-off") return undefined;
  if (!Number.isSafeInteger(originConversationId) || (originConversationId as number) < 1) return undefined;
  if (jobId !== null && (typeof jobId !== "string" || jobId === "")) return undefined;
  if (conversationClass === "recurring" && jobId === null) return undefined;
  return {
    conversationClass,
    originConversationId: originConversationId as number,
    jobId: jobId as string | null,
  };
}

export interface AutomationConversationRequest {
  readonly originConversationId: ConversationId;
  readonly conversationClass: CronConversationClass;
  readonly jobId: string | null;
  /**
   * The ID the owning document currently records together with that conversation's own marker, both
   * read before this commit by a snapshot read (which creates nothing), or `null` when the document
   * records none.
   */
  readonly recorded: { readonly id: number; readonly marker: unknown } | null;
}

/**
 * Classify one conversation as the automation conversation `expected` names, or `undefined` when it
 * may not be adopted.
 *
 * Adoption needs both halves: the conversation itself must still be ownerless and unforked, and its
 * `nanobot.cron.conversation` marker must name this origin, this job and (when the caller already
 * knows it) this class. A damaged or hand-edited pointer to a chat, the root, a fork, a task-owned
 * conversation or another job's conversation therefore costs one classification instead of pulling
 * that conversation into this class.
 *
 * The run's committing transaction and the host's open-time restore decide adoption with this one
 * predicate, so a conversation the host classifies at open is classified by the same rule a run
 * applies to the pointer it is about to reuse.
 */
export function classifyAutomationConversation(
  conversation: { readonly owner?: unknown; readonly parent?: unknown } | undefined,
  marker: unknown,
  expected: {
    readonly originConversationId: ConversationId;
    readonly jobId: string | null;
    /** Compared only when the caller knows it; the open-time restore reads it from the marker. */
    readonly conversationClass?: CronConversationClass;
  },
): CronConversationRecord | undefined {
  if (conversation === undefined || conversation.owner !== undefined || conversation.parent !== undefined) {
    return undefined;
  }
  const classified = automationConversationOf(marker);
  if (classified === undefined
    || classified.originConversationId !== expected.originConversationId
    || classified.jobId !== expected.jobId
    || (expected.conversationClass !== undefined
      && classified.conversationClass !== expected.conversationClass)) {
    return undefined;
  }
  return classified;
}

/**
 * Resolve this run's automation conversation inside the committing transaction: reuse the recorded
 * one while its own marker still names this origin and this job/class, otherwise create a new
 * ownerless conversation and record it. The marker is (re)written either way, so a conversation the
 * owning document points at is always classified as this job's automation conversation and nothing
 * else's.
 *
 * `request.recorded` is a pre-commit snapshot because `Tx` has no non-creating conversation-document
 * read: materializing a marker document only to look at it would write one onto the chat a damaged
 * pointer names. That pair is therefore stale evidence by the time this commit runs, which is
 * harmless but worth stating: the conversation record and the marker are re-read here, the adoption
 * decision is made here with `classifyAutomationConversation`, and the owner/parent checks are part
 * of it. A chat, the root, a fork or a task-owned conversation can therefore never be pulled into
 * this class by a pointer that changed in between.
 */
export async function ensureAutomationConversation(
  tx: Tx,
  request: AutomationConversationRequest,
): Promise<ConversationId> {
  const candidate = request.recorded === null
    || !Number.isSafeInteger(request.recorded.id)
    || request.recorded.id === request.originConversationId
    ? undefined
    : await tx.conversation(request.recorded.id as ConversationId);
  const recorded = classifyAutomationConversation(candidate, request.recorded?.marker, request) === undefined
    ? undefined
    : candidate;
  const conversationId = recorded === undefined
    ? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id
    : recorded.id;
  const markerDoc = await tx.doc(CronConversationDoc, conversationId);
  markerDoc.conversationClass = request.conversationClass;
  markerDoc.originConversationId = request.originConversationId;
  markerDoc.jobId = request.jobId;
  return conversationId;
}

/** One admitted one-off occurrence waiting its turn on the catch-all conversation. */
export interface CronOneOffQueueEntry {
  readonly [key: string]: JsonValue;
  readonly jobId: string;
  readonly scheduledAtMs: number;
  /** The run task that admitted it; it is the queue's durable identity and its waiter. */
  readonly taskId: number;
}

/** Strictly read the stored catch-all queue; a damaged value fails loudly instead of guessing. */
export function readOneOffQueue(value: unknown): CronOneOffQueueEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Stored cron one-off queue is malformed");
  const queue: CronOneOffQueueEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("Stored cron one-off queue is malformed");
    const { jobId, scheduledAtMs, taskId } = entry;
    if (typeof jobId !== "string" || jobId === "") throw new Error("Stored cron one-off queue is malformed");
    if (!Number.isSafeInteger(scheduledAtMs)) throw new Error("Stored cron one-off queue is malformed");
    if (!Number.isSafeInteger(taskId) || (taskId as number) < 1) throw new Error("Stored cron one-off queue is malformed");
    queue.push({ jobId, scheduledAtMs: scheduledAtMs as number, taskId: taskId as number });
  }
  return queue;
}
