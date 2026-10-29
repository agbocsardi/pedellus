import type { ConversationId } from "@earendil-works/pi-durable";

/**
 * Which mapped conversations are chat history.
 *
 * The host is the authorization boundary: it authenticates a channel message first and
 * then names the session key it maps to. These helpers only separate ordinary chat
 * conversations from bookkeeping ones; they grant nothing.
 */

/**
 * Suffix of a channel adapter's state-only session key. A channel keeps its own
 * delivery/offset record in such a conversation, so it carries no discussion and is
 * never episode or search history. Chat conversations keep their own keys.
 */
export const CHANNEL_STATE_SESSION_SUFFIX = ":channel-state";

/** False for a channel's state-only conversation, true for a discussion. */
export function isChatSessionKey(sessionKey: string): boolean {
  return sessionKey.length > 0 && !sessionKey.endsWith(CHANNEL_STATE_SESSION_SUFFIX);
}

/** A currently mapped chat session: one authenticated discussion and its conversation. */
export interface HistoryChatSession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}
