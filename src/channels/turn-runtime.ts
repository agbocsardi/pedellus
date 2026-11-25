/**
 * Shared turn-delivery primitives of the owner chat channels: per-scope submission ordering, the
 * owner busy-mode decision, shared-answer grouping, the live-generation predicate and the coalesced
 * preview watcher. Each channel keeps its own durable pending records, request IDs and transport.
 */

import type { Context } from "@earendil-works/chord";
import {
  LiveDoc,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { originOccurrencePending } from "../automation/cron.js";

/** One reserved place in a scope's submission order. */
export interface SubmissionSlot {
  /** Settles when every earlier place of the same scope was released. */
  readonly prior: Promise<void>;
  /** Free this place; idempotent. */
  release(): void;
}

/**
 * Per-scope FIFO of submission places. A delivery reserves its place when it is dispatched, before
 * any asynchronous preparation, so admission order never depends on how long a lookup, attachment
 * download or watch takes: Durable orders the inbox by submission.
 */
export class SubmissionOrderQueue<Scope> {
  readonly #chains = new Map<Scope, Promise<void>>();

  /** Reserve the scope's next place; the caller awaits `prior`, submits, then releases. */
  beginSubmission(scope: Scope): SubmissionSlot {
    const prior = this.#chains.get(scope) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    this.#chains.set(scope, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (this.#chains.get(scope) === tail) this.#chains.delete(scope);
      },
    };
  }

  /** Run `work` in a fresh place of the scope's order, for work that is not itself a dispatched delivery. */
  async submitInOrder<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const slot = this.beginSubmission(scope);
    try {
      await slot.prior;
      return await work();
    } finally {
      slot.release();
    }
  }

  /** Scopes with a reserved, unreleased place. */
  get activeScopes(): number {
    return this.#chains.size;
  }
}

/** The run's first input: it identifies the run across tool rounds, which only ever append inputs. */
export function firstInput(inputs: readonly number[]): number | undefined {
  let first = inputs[0];
  for (const id of inputs) if (first === undefined || id < first) first = id;
  return first;
}

/**
 * Whether the conversation's current run was started by one of this surface's own owner
 * submissions, so an owner input may steer into it. A scheduled origin-mode run, a digest or a
 * worker result starts its own run, and joining it would let two delivery paths carry the same
 * answer. An idle conversation and one with a live origin-mode cron occurrence both answer `false`:
 * an idle one places a follow-up identically, and a queued occurrence must never share a boundary
 * with an owner steer. One read transaction; nothing is written.
 */
export async function ownerRunActive(
  conversation: Pick<Conversation, "id" | "commit">,
  /** Request IDs of this surface's admitted owner inputs in this session, read just before the call. */
  requestIds: Iterable<string>,
  context: Context,
): Promise<boolean> {
  return conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    const inputs = live.run?.inputs;
    if (inputs === undefined || inputs.length === 0) return false;
    if (await originOccurrencePending(tx, conversation.id)) return false;
    const first = firstInput(inputs);
    if (first === undefined) return false;
    for (const requestId of requestIds) {
      const record = await tx.submissionByRequest(conversation.id, requestId);
      if (record?.id === first) return true;
    }
    return false;
  }, context);
}

/**
 * The native busy-mode for one admitted owner input. Only an input whose own admission recorded
 * `steer` may steer, and only into a run this surface owns; everything else takes the conservative
 * follow-up queueing, so no owner answer is dropped and no scheduled answer is delivered twice.
 * Native `submit` has no conditional steering, so this is read immediately before admission.
 */
export async function resolveOwnerBusyMode(
  conversation: Pick<Conversation, "id" | "commit">,
  requested: "steer" | "followUp" | undefined,
  requestIds: Iterable<string>,
  context: Context,
): Promise<"steer" | "followUp"> {
  if (requested !== "steer") return "followUp";
  return (await ownerRunActive(conversation, requestIds, context)) ? "steer" : "followUp";
}

/**
 * Whether this settled submission is one of the inputs the run that committed `answer` consumed.
 * Every input a run consumed settles with the same answer entry. A failed run has no such identity
 * (it settles `unanswered` with a plain reason), so failures are never grouped.
 */
export function answeredTogether(record: SubmissionRecord, answer: number): boolean {
  return record.type === "input" && record.status === "done" && record.answer === answer;
}

/** `owner` sends the one shared reply, `sibling` stays silent behind it, `retired` is already gone. */
export type DeliveryRole = "owner" | "sibling" | "retired";

export interface SharedDeliveryGroup<Key> {
  /** Every candidate settled by the answer, earliest native submission first. */
  readonly keys: readonly Key[];
  /** The candidate that delivers the single shared reply. */
  readonly owner: Key | undefined;
}

/**
 * The pending inputs that one committed answer settled together, read inside the caller's own
 * state transaction so committed pending membership and native settlement are one consistent
 * identity: every observer computes the same owner without a lock, and a reopened process too.
 */
export async function resolveSharedDeliveryGroup<Key>(
  tx: Tx,
  conversationId: ConversationId,
  candidates: Iterable<{ readonly key: Key; readonly requestId: string }>,
  answer: number,
  compareKeys: (left: Key, right: Key) => number = defaultCompare,
): Promise<SharedDeliveryGroup<Key>> {
  const members: { key: Key; submissionId: number }[] = [];
  for (const candidate of candidates) {
    const record = await tx.submissionByRequest(conversationId, candidate.requestId);
    if (record !== undefined && answeredTogether(record, answer)) {
      members.push({ key: candidate.key, submissionId: record.id });
    }
  }
  members.sort((left, right) => left.submissionId - right.submissionId || compareKeys(left.key, right.key));
  return { keys: members.map((member) => member.key), owner: members[0]?.key };
}

/** This delivery's role in its group; `present` is whether its own pending record still exists. */
export function sharedDeliveryRole<Key>(group: SharedDeliveryGroup<Key>, current: Key, present: boolean): DeliveryRole {
  if (!present) return "retired";
  return group.owner === undefined || group.owner === current ? "owner" : "sibling";
}

function defaultCompare<Key>(left: Key, right: Key): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The parts of `pi.live` a channel reads from a watch frame. */
export type LiveView = {
  readonly run?: { readonly inputs?: readonly number[]; readonly first?: number };
  readonly generation?: unknown;
} | undefined;

/**
 * Whether the conversation has an active generation attempt: a generation is present and is
 * neither in a durable retry backoff nor polling a deferred provider response. A queued input, a
 * tool round, a run waiting for another task, a parked run and an answered run are not generating,
 * so typing and "thinking" indicators stop there instead of being an endless keepalive.
 */
export function isLiveGenerating(live: LiveView): boolean {
  if (live?.run === undefined) return false;
  const generation = live.generation;
  if (generation === null || typeof generation !== "object") return false;
  const fields = generation as { readonly deferred?: unknown; readonly retry?: unknown };
  return fields.deferred === undefined && fields.retry === undefined;
}

/** Whether the run containing this admitted submission is actively generating. */
export function isLiveGeneratingFor(live: LiveView, submissionId: number | undefined): boolean {
  if (submissionId === undefined || live?.run?.inputs === undefined) return false;
  return live.run.inputs.includes(submissionId) && isLiveGenerating(live);
}

/** The committed partial text of the current generation, or `""`. */
export function liveGenerationText(live: LiveView): string {
  const generation = live?.generation as
    | { readonly message?: { readonly content?: readonly { readonly type: string; readonly text?: string }[] } }
    | undefined;
  const content = generation?.message?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) if (part.type === "text" && typeof part.text === "string") text += part.text;
  return text;
}

/** One-shot timer hooks, so checks can drive channel debounces and notices deterministically. */
export interface ChannelTimers {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

/** Unref'd `setTimeout`: a pending debounce or notice never keeps the process alive. */
export const DEFAULT_CHANNEL_TIMERS: ChannelTimers = {
  set(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** One committed frame as the watcher classified it. */
export interface PreviewFrame {
  readonly live: LiveView;
  /** The watched submission is one of the current run's inputs. */
  readonly inRun: boolean;
  /** The watched submission is the run's first input, which owns the single live preview. */
  readonly ownsRun: boolean;
}

export interface PreviewWatcherOptions {
  readonly conversation: Pick<Conversation, "watch">;
  readonly context: Context;
  /** Coalescing delay between preview publications. */
  readonly delayMs: number;
  /** Publish the newest partial; never called concurrently with itself. */
  publish(text: string): Promise<void>;
  /** Every committed frame, before preview extraction (typing, status, activity). */
  onFrame?(view: ConversationView, frame: PreviewFrame): void;
  /** `rethrow` makes `stop()` reject with the first failed publication; default `ignore`. */
  readonly publishFailure?: "rethrow" | "ignore";
  readonly signal?: AbortSignal;
  readonly timers?: ChannelTimers;
}

export interface PreviewWatcher {
  /** The watch's current committed view. */
  readonly value: ConversationView;
  /** Bind the admitted submission; frames before this only reach `onFrame`. */
  setSubmission(id: SubmissionId): void;
  /**
   * Idempotently stop: clear a scheduled publication, release the watch and await an in-flight
   * one. No publication starts after `stop()` was called.
   */
  stop(): Promise<void>;
}

/**
 * Open one watch on the conversation and publish its live generation text as coalesced previews.
 * One preview per run: only the run's first input publishes, so a steered sibling never sends a
 * second one. A newer partial arriving while one publishes is coalesced into the next.
 */
export async function createPreviewWatcher(options: PreviewWatcherOptions): Promise<PreviewWatcher> {
  const timers = options.timers ?? DEFAULT_CHANNEL_TIMERS;
  const watch = await options.conversation.watch(options.context);
  let submissionId: number | undefined;
  let stopped = false;
  let timer: unknown;
  let work: Promise<void> | undefined;
  let dirty = false;
  let latest = "";
  let failure: { readonly error: unknown } | undefined;

  const closed = (): boolean => stopped || options.signal?.aborted === true;
  const schedule = (): void => {
    if (timer !== undefined || closed()) return;
    timer = timers.set(() => {
      timer = undefined;
      if (work !== undefined || closed()) return;
      dirty = false;
      work = options.publish(latest).catch((error: unknown) => {
        failure ??= { error };
      }).finally(() => {
        work = undefined;
        if (dirty && !closed()) schedule();
      });
    }, options.delayMs);
  };

  watch.start(async (call) => {
    // Durable's watches never send Chord's recoverable `failed` call; they end instead.
    if (call.kind !== "value" || stopped) return;
    const view = call.value;
    const live = view.docs["pi.live"] as LiveView;
    const inputs = live?.run?.inputs;
    const inRun = submissionId !== undefined && inputs !== undefined && inputs.includes(submissionId);
    const ownsRun = inRun && submissionId === firstInput(inputs!);
    options.onFrame?.(view, { live, inRun, ownsRun });
    if (!ownsRun) return;
    const text = liveGenerationText(live);
    if (text === "") return;
    latest = text;
    dirty = true;
    schedule();
  });

  return {
    get value() {
      return watch.value;
    },
    setSubmission(id) {
      submissionId = id;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      dirty = false;
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      await watch.stop();
      await work;
      if (failure !== undefined && options.publishFailure === "rethrow") throw failure.error;
    },
  };
}
