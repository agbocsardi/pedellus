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

/**
 * Suffix of the channel segment on a session key imported from the retired Python harness.
 * The importer renamed each source channel (`telegram` -> `telegram-legacy`), so the marker is
 * carried by the key's channel part and not by the conversation's contents.
 */
export const LEGACY_CHANNEL_SUFFIX = "-legacy";

/**
 * True for a session imported from the legacy harness, whose transcript was already processed
 * into memory before the migration.
 *
 * Imported history stays recallable and searchable as chat history. It is not new evidence, so a
 * consumer that derives new durable memory from conversation must skip it rather than re-read a
 * transcript that was consumed once already.
 */
export function isLegacySessionKey(sessionKey: string): boolean {
  const separator = sessionKey.indexOf(":");
  const channel = separator === -1 ? sessionKey : sessionKey.slice(0, separator);
  return channel.endsWith(LEGACY_CHANNEL_SUFFIX);
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

/**
 * Why a mapped conversation is not chat history even though its session key looks like one.
 *
 * A session key is a host string: it can be forged, imported or left behind by an older layout, so
 * the key alone never decides scope. A chat conversation is ownerless, unforked and not the root; a
 * scheduled run's automation conversation, a history fork and the root are never a discussion a
 * channel named. Automation conversations are ownerless by design — they outlive the run task that
 * created them — so their class is carried by the host, not inferred from `owner`.
 */
export type ChatScopeExclusion = "missing" | "root" | "automation" | "task-owned" | "forked";

/**
 * Classify one conversation record for chat scope, or `undefined` when it is ordinary chat.
 *
 * This is the single scope rule shared by every derived history consumer (search indexing, the
 * episode catalog, the summary scheduler and the per-session history reads). Keeping it structural
 * and side-effect free lets a host validate inside its own transaction.
 */
export interface ChatScopeRecord {
  readonly id: ConversationId;
  readonly owner?: unknown;
  readonly parent?: unknown;
  /**
   * The host's durable classification of this conversation as a scheduled run's automation
   * conversation. It is stated explicitly because such a conversation is ownerless and unforked,
   * exactly like a chat; the conversation's own class marker says which it is, and the host's cron
   * documents only enumerate candidates for a reopen.
   */
  readonly automation?: boolean;
}

export function chatScopeExclusion(
  conversation: ChatScopeRecord | undefined,
  rootId: ConversationId,
): ChatScopeExclusion | undefined {
  if (conversation === undefined) return "missing";
  if (conversation.id === rootId) return "root";
  if (conversation.automation === true) return "automation";
  if (conversation.owner !== undefined) return "task-owned";
  if (conversation.parent !== undefined) return "forked";
  return undefined;
}

/** Reads one conversation record; a host passes its own transactional reader. */
export type ChatScopeReader = (conversationId: ConversationId) => Promise<ChatScopeRecord | undefined>;

/** Scope of one conversation, read through `reader`. */
export async function readChatScope(
  reader: ChatScopeReader,
  conversationId: ConversationId,
  rootId: ConversationId,
): Promise<ChatScopeExclusion | undefined> {
  return chatScopeExclusion(await reader(conversationId), rootId);
}

export interface ChatScopePartition {
  /** Mappings that really are chat history. */
  readonly chat: readonly HistoryChatSession[];
  /** Mappings skipped because their conversation is not chat history. */
  readonly excluded: readonly {
    readonly sessionKey: string;
    readonly conversationId: ConversationId;
    readonly reason: ChatScopeExclusion;
  }[];
}

/**
 * Split mapped sessions into chat history and exclusions in one pass, so every consumer applies the
 * same rule to the same records. `reader` is the host's transactional record reader.
 */
export async function partitionChatScope(
  reader: ChatScopeReader,
  sessions: readonly HistoryChatSession[],
  rootId: ConversationId,
): Promise<ChatScopePartition> {
  const chat: HistoryChatSession[] = [];
  const excluded: {
    sessionKey: string;
    conversationId: ConversationId;
    reason: ChatScopeExclusion;
  }[] = [];
  for (const session of sessions) {
    const reason = await readChatScope(reader, session.conversationId, rootId);
    if (reason === undefined) chat.push(session);
    else excluded.push({ ...session, reason });
  }
  return { chat, excluded };
}

/** Fixed message for a rejected mapping, so every surface reports the same reason. */
export function chatScopeMessage(reason: ChatScopeExclusion): string {
  switch (reason) {
    case "missing": return "Stored session mapping points to a missing conversation";
    case "automation": return "Stored session mapping points to a scheduled run's automation conversation";
    case "task-owned": return "Stored session mapping points to a task-owned conversation";
    case "forked": return "Stored session mapping points to a forked conversation";
    case "root": return "Stored session mapping points to the root conversation";
  }
}
