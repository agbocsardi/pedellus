/**
 * Idle episode rollover: once a mapped chat has stayed fully idle for the configured time, the owner's
 * next message is classified by the configured classifier against the newest owner/assistant text of
 * the chat. A continuation changes nothing; a new topic (or an unusable/failed classification) commits a
 * plain native `pi.reset`, exactly like `/new`, just before that message, so the message opens the new
 * episode.
 *
 * The reset closes the episode, so digest, episode summaries and recall see an ordinary closed
 * episode. Idle clocks are in memory: a restart drops them, which only means the next message continues
 * the old episode until the chat goes idle again. Nothing here grants a tool, starts a turn or sends a
 * channel message.
 */
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  ConversationBusy,
  LiveDoc,
  ResetEntry,
  type ConversationId,
  type EntryId,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ModelReference } from "../config.js";
import { journalEvent } from "../observability.js";
import { AskQuestionsDoc, pendingQuestionViews } from "../questions/index.js";

export const IDLE_ROLLOVER_LIMITS = Object.freeze({
  /** How often mapped chats are checked. */
  sweepMs: 60_000,
  /** Newest transcript characters given to the classifier. */
  sourceChars: 24_000,
  /** Characters kept from one owner or assistant message. */
  partChars: 1_500,
  /** Characters of the owner's new message given to the classifier. */
  messageChars: 4_000,
  /** Deadline for the continuation classifier; a slower answer counts as a new topic. */
  classifyTimeoutMs: 10_000,
});

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)} […]`;

/** Owner and assistant text of the current context, newest `sourceChars`; tool calls, results and images are left out. */
export function renderRolloverSource(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text.trim().length > 0) lines.push(`Owner: ${clip(text, IDLE_ROLLOVER_LIMITS.partChars)}`);
    } else if (message.role === "assistant") {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text.trim().length > 0) lines.push(`Assistant: ${clip(text, IDLE_ROLLOVER_LIMITS.partChars)}`);
    }
  }
  const joined = lines.join("\n\n");
  return joined.length <= IDLE_ROLLOVER_LIMITS.sourceChars
    ? joined
    : `[earlier part omitted]\n\n${joined.slice(joined.length - IDLE_ROLLOVER_LIMITS.sourceChars)}`;
}

/** Owner input as channels submit it: text, or text and image parts. */
export type OwnerInputContent = string | readonly (TextContent | ImageContent)[];

/** The text of an owner input, clipped for the classifier; images are left out. */
export function ownerInputText(content: OwnerInputContent): string {
  const text = typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return clip(text, IDLE_ROLLOVER_LIMITS.messageChars);
}

export interface IdleRolloverSession {
  readonly conversationId: ConversationId;
  readonly sessionKey: string;
}

export interface IdleRolloverOptions {
  readonly afterMs: number;
  readonly now: () => number;
  /** Current authenticated mapped ordinary chats. */
  readonly sessions: (context: Context) => Promise<readonly IdleRolloverSession[]>;
  /** False while any gateway work is running; clocks keep counting but no chat is marked idle. */
  readonly quiet: (context: Context) => Promise<boolean>;
  /** Newest entry of an idle chat that has something to roll over; undefined when busy or nothing new. */
  readonly probe: (conversationId: ConversationId, context: Context) => Promise<EntryId | undefined>;
  /**
   * True when `message` continues the chat's current context; undefined when there is nothing to
   * compare or the classifier gave no usable answer.
   */
  readonly continues: (conversationId: ConversationId, message: string, idleMs: number, signal: AbortSignal) => Promise<boolean | undefined>;
  /** Commit the reset only if `expectLatest` is still the newest entry and the chat is still idle. */
  readonly rollover: (session: IdleRolloverSession, expectLatest: EntryId, context: Context) => Promise<void>;
  readonly report: (error: unknown) => void;
  readonly context: Context;
}

export interface IdleRollover {
  /**
   * Called just before an owner's input is submitted to a mapped chat. When that exact chat went idle
   * and nothing was appended since, it classifies the input and commits the reset unless the input
   * continues the conversation. It never throws and never blocks longer than the classifier deadline
   * plus the reset commit; a concurrent input for the same chat waits for the same decision.
   */
  beforeOwnerInput(sessionKey: string, conversationId: ConversationId, content: OwnerInputContent, context: Context): Promise<void>;
  close(): Promise<void>;
}

interface Idle {
  readonly session: IdleRolloverSession;
  readonly latest: EntryId;
  readonly since: number;
}

export function startIdleRollover(options: IdleRolloverOptions): IdleRollover {
  const clocks = new Map<ConversationId, { latest: EntryId; since: number }>();
  const idle = new Map<ConversationId, Idle>();
  const deciding = new Map<ConversationId, Promise<void>>();
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let closed = false;

  const sweep = async (): Promise<void> => {
    const ctx = options.context;
    const sessions = await options.sessions(ctx);
    const seen = new Set<ConversationId>();
    let quiet: boolean | undefined;
    for (const session of sessions) {
      if (closed) return;
      seen.add(session.conversationId);
      try {
        const latest = await options.probe(session.conversationId, ctx);
        if (latest === undefined) {
          clocks.delete(session.conversationId);
          idle.delete(session.conversationId);
          continue;
        }
        const clock = clocks.get(session.conversationId);
        if (clock === undefined || clock.latest !== latest) {
          clocks.set(session.conversationId, { latest, since: options.now() });
          idle.delete(session.conversationId);
          continue;
        }
        if (idle.get(session.conversationId)?.latest === latest) continue;
        if (options.now() - clock.since < options.afterMs) continue;
        quiet ??= await options.quiet(ctx);
        if (!quiet) continue;
        idle.set(session.conversationId, { session, latest, since: clock.since });
      } catch (error) {
        if (!closed) options.report(error);
      }
    }
    for (const id of clocks.keys()) if (!seen.has(id)) clocks.delete(id);
    for (const id of idle.keys()) if (!seen.has(id)) idle.delete(id);
  };

  const decide = async (state: Idle, content: OwnerInputContent, ctx: Context): Promise<void> => {
    // Something else ran since the chat went idle (a scheduled turn, a reply): its clock starts again.
    if (await options.probe(state.session.conversationId, ctx) !== state.latest) return;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(IDLE_ROLLOVER_LIMITS.classifyTimeoutMs)]);
    let continues: boolean | undefined;
    try {
      const text = ownerInputText(content);
      continues = text.trim().length === 0
        ? undefined
        : await options.continues(state.session.conversationId, text, options.now() - state.since, signal);
    } catch (error) {
      if (!closed) options.report(error);
    }
    if (closed || continues === true) return;
    // A new topic, or no usable answer: start a new episode, as `/new` would.
    await options.rollover(state.session, state.latest, ctx);
  };

  const timer = setInterval(() => {
    if (running !== undefined || closed) return;
    running = sweep().catch(options.report).finally(() => { running = undefined; });
  }, IDLE_ROLLOVER_LIMITS.sweepMs);
  timer.unref();

  return {
    async beforeOwnerInput(sessionKey, conversationId, content, ctx) {
      const inFlight = deciding.get(conversationId);
      if (inFlight !== undefined) return inFlight;
      const state = idle.get(conversationId);
      if (closed || state === undefined || state.session.sessionKey !== sessionKey) return;
      idle.delete(conversationId);
      clocks.delete(conversationId);
      const decision = decide(state, content, ctx)
        .catch((error: unknown) => { if (!closed) options.report(error); })
        .finally(() => { deciding.delete(conversationId); });
      deciding.set(conversationId, decision);
      return decision;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      controller.abort();
      await running;
      await Promise.all(deciding.values());
    },
  };
}

/** An idle rollover's guarded reset: the newest entry when the chat went idle. */
export interface IdleRolloverReset {
  readonly expectLatest: EntryId;
}

/** New activity, a run or a waiting question appeared after the chat went idle. */
export class IdleRolloverStale extends Error {}

/**
 * Append the rollover's native reset, only while nothing was appended since the chat went idle, no
 * run is live and no question still waits for an answer; otherwise the chat is not idle.
 */
export async function appendIdleRolloverReset(
  tx: Tx, conversationId: ConversationId, reset: IdleRolloverReset, nowMs: number,
): Promise<void> {
  if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) throw new IdleRolloverStale();
  if (await tx.latestEntryId(conversationId) !== reset.expectLatest) throw new IdleRolloverStale();
  if (pendingQuestionViews(await tx.doc(AskQuestionsDoc, conversationId), nowMs).views.length > 0) {
    throw new IdleRolloverStale();
  }
  await tx.appendEntry(conversationId, { kind: ResetEntry.kind, head: "self" });
}

export interface GatewayIdleRolloverOptions {
  readonly afterMs: number;
  readonly now: () => number;
  readonly context: Context;
  readonly harness: HarnessType;
  /** The live provider registry; read at each classification so a host reload applies. */
  readonly models: () => Models;
  /** The one configured classifier model. */
  readonly classifier: ModelReference;
  readonly sessions: IdleRolloverOptions["sessions"];
  readonly quiet: IdleRolloverOptions["quiet"];
  /** Commit the guarded reset, with the host's prompt rebuild when it has one. */
  readonly reset: (session: IdleRolloverSession, reset: IdleRolloverReset, context: Context) => Promise<void>;
  readonly report: (error: unknown) => void;
}

/** The gateway's idle rollover: native transcript probes and the one continuation classifier. */
export function startGatewayIdleRollover(options: GatewayIdleRolloverOptions): IdleRollover {
  const { harness, context } = options;
  return startIdleRollover({
    afterMs: options.afterMs,
    now: options.now,
    context,
    sessions: options.sessions,
    quiet: options.quiet,
    probe: async (conversationId, ctx) => {
      if ((await harness.snapshot(LiveDoc, conversationId, ctx))?.run !== undefined) return undefined;
      const conversation = await harness.conversation(conversationId, ctx);
      if (conversation === undefined) return undefined;
      const [latest] = (await conversation.entries({ order: "descending" }, 1, undefined, ctx)).items;
      // Nothing since the last reset (a rollover or `/new`): nothing to roll over.
      if (latest === undefined || latest.kind === ResetEntry.kind) return undefined;
      return latest.id;
    },
    continues: async (conversationId, message, idleMs, signal) => {
      const models = options.models();
      const classifier = models.getModelOfType("classifier", options.classifier.provider, options.classifier.modelId);
      const conversation = await harness.conversation(conversationId, context);
      if (classifier === undefined || conversation === undefined) return undefined;
      const previous = renderRolloverSource((await conversation.context(context)).messages);
      if (previous.trim().length === 0) return undefined;
      const result = await models.classify(classifier, {
        state: { previousConversation: previous, idleMinutes: Math.round(idleMs / 60_000), newMessage: message },
        questions: {
          continues: {
            type: "bool",
            instructions: "previousConversation is the newest part of an owner's conversation with their assistant, which then went idle."
              + " Decide whether newMessage, the owner's first message after the pause, continues that conversation.",
            criteria: {
              true: "newMessage follows up on, answers, or refers back to the previous conversation, or makes sense only with it.",
              false: "newMessage starts a different topic that does not need the previous conversation.",
            },
          },
        },
      }, { signal, telemetry: context.telemetry });
      const answer = result.answers.continues;
      if (result.stopReason !== "stop" || answer?.type !== "bool") {
        journalEvent("gateway.idleRollover.unclassified", { stop: String(result.stopReason) });
        return undefined;
      }
      const continues = answer.probability >= 0.5;
      journalEvent("gateway.idleRollover.classified", { probability: Math.round(answer.probability * 100) / 100, continues });
      return continues;
    },
    rollover: async (session, expectLatest, ctx) => {
      try {
        await options.reset(session, { expectLatest }, ctx);
      } catch (error) {
        // New activity won the race; the next idle period starts a fresh clock.
        if (error instanceof IdleRolloverStale || error instanceof ConversationBusy) return;
        throw error;
      }
    },
    report: options.report,
  });
}
