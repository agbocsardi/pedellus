import type { ConversationId } from "@earendil-works/pi-durable";
import { CONTEXT_SECTION_KEYS } from "../context/index.js";

/**
 * Prepared provider dispatches are the only task phases that resend a pinned
 * model context on resume. A generation request/poll pins `cutoff`, and a
 * compaction summarize/retry pins `tail`; every other phase re-renders or only
 * performs local work.
 */
export interface PreparedContextReplay {
  readonly id: number;
  readonly kind: "pi.generation" | "pi.compaction";
  readonly conversationId: ConversationId;
  readonly at: number;
  readonly phase: "request" | "poll" | "summarize" | "retry";
}

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

/** The pinned context cutoff of a live generation request/poll or compaction summarize/retry. */
export function preparedContextReplay(task: unknown): PreparedContextReplay | undefined {
  if (!isRecord(task) || (task.kind !== "pi.generation" && task.kind !== "pi.compaction")) return undefined;
  const { id, conversationId, state } = task;
  if (!isRecord(state) || state.status === "terminal" || state.status === "completing" ||
      task.abortRequested === true) return undefined;
  if (!isRecord(state.checkpoint) || typeof state.checkpoint.phase !== "string") {
    throw new Error(`Cannot safely inspect prepared ${task.kind} task ${String(id)} checkpoint`);
  }
  const { phase } = state.checkpoint;
  // Generation request/poll pin `cutoff`; compaction summarize/retry pin `tail`.
  const field = task.kind === "pi.generation"
    ? phase === "request" || phase === "poll" ? "cutoff" : undefined
    : phase === "summarize" || phase === "retry" ? "tail" : undefined;
  if (field === undefined) return undefined;
  const at = state.checkpoint[field];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 ||
      typeof conversationId !== "number" || !Number.isSafeInteger(conversationId) ||
      conversationId < 1 || typeof at !== "number" || !Number.isSafeInteger(at) || at < 1) {
    throw new Error(`Cannot safely inspect prepared ${task.kind} task ${String(id)} checkpoint`);
  }
  return {
    id,
    kind: task.kind,
    conversationId: conversationId as ConversationId,
    at,
    phase: phase as PreparedContextReplay["phase"],
  };
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
