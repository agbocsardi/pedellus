import type { ConversationId } from "@earendil-works/pi-durable";
import { CONTEXT_SECTION_KEYS } from "../context/index.js";

/**
 * Prepared provider dispatches are the only task phases that replay pinned
 * provider state on resume. A generation request/poll pins `cutoff`, and a
 * compaction summarize pins `tail`; every other phase re-renders or only
 * performs local work.
 *
 * A compaction `retry` is deliberately not one of them. Its checkpoint is
 * committed only after the previous attempt's provider response arrived and its
 * error was stored, and it still has to commit the `summarize` checkpoint of the
 * next attempt before that attempt can dispatch. A stored `retry` therefore
 * proves that the attempt it would send was never dispatched, so resuming it
 * repeats no unrecorded request and replays no host context.
 */
export interface PreparedContextReplay {
  readonly id: number;
  readonly kind: "pi.generation" | "pi.compaction";
  readonly conversationId: ConversationId;
  readonly at: number;
  readonly phase: "request" | "poll" | "summarize";
  /** The pinned provider attempt, used to read the live attempt marker. */
  readonly attempt: number;
}

/**
 * What Durable's durable state records about a pinned dispatch's provider response.
 * Nothing is claimed as "never dispatched": see `preparedResponseEvidence()`.
 */
export type PreparedResponseEvidence =
  /** A committed partial of this attempt: the provider stream produced content; its remote outcome is unknown. */
  | "partial-response"
  /** A deferred handle is recorded; any fetch attempt or answer may be uncommitted. */
  | "deferred-response"
  /** Nothing durable records whether a provider request was sent or answered. */
  | "unrecorded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Models selected into checkpoints by Durable's native provider-dispatch tasks. */
export function preparedTaskModel(task: unknown): { provider: string; modelId: string } | undefined {
  if (!isRecord(task) || typeof task.kind !== "string") return undefined;
  const { kind, id } = task;
  if (kind !== "pi.generation" && kind !== "pi.compaction") return undefined;
  if (!isRecord(task.state)) throw new Error(`Cannot safely validate live ${kind} task ${String(id)} state`);
  const { status, checkpoint } = task.state;
  if (status === "terminal" || status === "completing") return undefined;
  if (!["pending", "running", "waiting", "sleeping"].includes(String(status))) {
    throw new Error(`Cannot safely validate live ${kind} task ${String(id)} status ${String(status)}`);
  }
  if (!isRecord(checkpoint) || typeof checkpoint.phase !== "string") {
    throw new Error(`Cannot safely validate live ${kind} task ${String(id)} checkpoint`);
  }
  const phase = checkpoint.phase;
  const hasPreparedRequest = kind === "pi.generation"
    ? phase === "request" || phase === "poll"
    : phase === "summarize" || phase === "retry";
  const hasNoPreparedRequest = kind === "pi.generation"
    ? phase === "prepare" || phase === "retry" || phase === "tools"
    : phase === "select";
  if (hasNoPreparedRequest) return undefined;
  if (!hasPreparedRequest || !isRecord(checkpoint.model) ||
      typeof checkpoint.model.provider !== "string" ||
      typeof checkpoint.model.modelId !== "string") {
    throw new Error(`Cannot safely validate live ${kind} task ${String(id)} checkpoint phase ${phase}`);
  }
  // An abort-marked task runs its abort protocol, never a run phase, so most
  // abort-marked checkpoints do not need the model guard. The exception is a
  // generation poll: its native abort calls models.cancelDeferred, which may be a
  // provider request. Keep that model authoritative even after cancellation.
  if (task.abortRequested === true && !(kind === "pi.generation" && phase === "poll")) return undefined;
  return {
    provider: checkpoint.model.provider,
    modelId: checkpoint.model.modelId,
  };
}

/** The pinned model input of a live generation request/poll or compaction summarize. */
export function preparedContextReplay(task: unknown): PreparedContextReplay | undefined {
  if (!isRecord(task) || (task.kind !== "pi.generation" && task.kind !== "pi.compaction")) return undefined;
  const { id, conversationId, state } = task;
  if (!isRecord(state) || state.status === "terminal" || state.status === "completing" ||
      task.abortRequested === true) return undefined;
  if (!isRecord(state.checkpoint) || typeof state.checkpoint.phase !== "string") {
    throw new Error(`Cannot safely inspect prepared ${task.kind} task ${String(id)} checkpoint`);
  }
  const { phase, attempt } = state.checkpoint;
  // Generation request/poll pin `cutoff`; a compaction summarize pins `tail`.
  const field = task.kind === "pi.generation"
    ? phase === "request" || phase === "poll" ? "cutoff" : undefined
    : phase === "summarize" ? "tail" : undefined;
  if (field === undefined) return undefined;
  const at = state.checkpoint[field];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 ||
      typeof conversationId !== "number" || !Number.isSafeInteger(conversationId) ||
      conversationId < 1 || typeof at !== "number" || !Number.isSafeInteger(at) || at < 1 ||
      typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`Cannot safely inspect prepared ${task.kind} task ${String(id)} checkpoint`);
  }
  return {
    id,
    kind: task.kind,
    conversationId: conversationId as ConversationId,
    at,
    phase: phase as PreparedContextReplay["phase"],
    attempt,
  };
}

/**
 * What Durable's own durable state records about the provider response of a
 * pinned dispatch, from `pi.live` of its conversation.
 *
 * `request` commits `live.generation = { attempt }` before it calls the provider, but
 * Durable stores that commit like streamed progress (`PROGRESS_COMMIT`), so a crash
 * can lose it, and an absent `pi.live` document too. A missing or different attempt
 * marker therefore no longer proves this attempt was never dispatched, so this
 * reports `unrecorded` instead of claiming a proof it does not have. A committed
 * `message` proves the stream produced content. A
 * `poll` checkpoint records a received deferred handle, not whether a fetch was
 * attempted or answered. Compaction records no dispatch marker at all.
 */
export function preparedResponseEvidence(
  replay: PreparedContextReplay,
  live: unknown,
): PreparedResponseEvidence {
  if (replay.kind === "pi.generation" && replay.phase === "poll") return "deferred-response";
  if (replay.kind !== "pi.generation") return "unrecorded";
  if (live === undefined) return "unrecorded";
  if (!isRecord(live)) {
    throw new Error(`Cannot safely inspect live generation state of prepared task ${replay.id}`);
  }
  const generation = live.generation;
  if (generation === undefined) return "unrecorded";
  if (!isRecord(generation) || typeof generation.attempt !== "number") {
    throw new Error(`Cannot safely inspect live generation state of prepared task ${replay.id}`);
  }
  if (generation.attempt !== replay.attempt) return "unrecorded";
  return generation.message === undefined ? "unrecorded" : "partial-response";
}

const NANOBOT_CONTEXT_SECTION_KEYS = new Set<string>(Object.values(CONTEXT_SECTION_KEYS));

/** Whether the pinned model messages still carry a nonempty Nanobot context section. */
export function hasPersistedNanobotContext(messages: readonly unknown[]): boolean {
  const effective = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "system" || !isRecord(message.sections)) continue;
    for (const [key, value] of Object.entries(message.sections)) {
      if (!NANOBOT_CONTEXT_SECTION_KEYS.has(key)) continue;
      if (value === null) effective.delete(key);
      else if (typeof value === "string") effective.set(key, value);
      else throw new Error(`Cannot safely inspect persisted context section ${key}`);
    }
  }
  return [...effective.values()].some((value) => value.length > 0);
}
