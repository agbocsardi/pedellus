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
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";

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
