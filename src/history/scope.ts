import type { ConversationId } from "@earendil-works/pi-durable";

/**
 * The persisted session map: key encoding, validation and chat-vs-state classification.
 *
 * The host is the authorization boundary: it authenticates a channel message first and
 * then names the session key it maps to. These helpers only read the stored map and
 * separate ordinary chat conversations from bookkeeping ones; they grant nothing.
 *
 * One reader exists so every consumer agrees on what the map contains: the Gateway's
 * restore pass takes all mapped sessions, while episode and search scope take chat only.
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

/** One entry of the stored map after validation; it may or may not be chat. */
export interface MappedSession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

/** A currently mapped chat session: one authenticated discussion and its conversation. */
export interface HistoryChatSession {
  readonly sessionKey: string;
  readonly conversationId: ConversationId;
}

/** Stored key for one session key. */
export function encodedSessionKey(key: string): string {
  if (!key) throw new Error("sessionKey must not be empty");
  return `k:${Buffer.from(key, "utf8").toString("base64url")}`;
}

function decodedSessionKey(key: string): string {
  if (!key.startsWith("k:")) throw new Error("Stored session map contains an invalid session key");
  const decoded = Buffer.from(key.slice(2), "base64url").toString("utf8");
  if (encodedSessionKey(decoded) !== key) throw new Error("Stored session map contains an invalid session key");
  return decoded;
}

/**
 * Every session in a persisted session-map value.
 *
 * A malformed map, an invalid or root conversation ID, or two session keys sharing one
 * conversation is refused rather than repaired, so a damaged map is never half-read.
 * Classification is left to the caller: `readChatSessions` applies the chat rule.
 */
export function readMappedSessions(sessions: unknown, rootId: ConversationId): MappedSession[] {
  if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) {
    throw new Error("Stored session map is malformed");
  }
  const mapped: MappedSession[] = [];
  const conversationIds = new Set<ConversationId>();
  for (const [encodedKey, rawId] of Object.entries(sessions as Record<string, unknown>)) {
    const sessionKey = decodedSessionKey(encodedKey);
    if (!Number.isSafeInteger(rawId) || (rawId as number) < 1 || rawId === rootId) {
      throw new Error("Stored session map contains an invalid conversation ID");
    }
    const conversationId = rawId as ConversationId;
    if (conversationIds.has(conversationId)) {
      throw new Error("Stored session map maps multiple session keys to one conversation");
    }
    conversationIds.add(conversationId);
    mapped.push({ sessionKey, conversationId });
  }
  return mapped;
}

/** The chat subset of a persisted session-map value; state-only keys are dropped. */
export function readChatSessions(sessions: unknown, rootId: ConversationId): HistoryChatSession[] {
  return readMappedSessions(sessions, rootId).filter(({ sessionKey }) => isChatSessionKey(sessionKey));
}
