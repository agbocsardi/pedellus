/**
 * The host's session mapping and the one mapped-chat scope rule every reader shares.
 *
 * The stored map is host data, not authority: it can be forged, imported or left behind by an older
 * layout. A mapped session key names an ordinary chat only while its conversation passes the shared
 * scope rule (`history/scope.ts`) with this host's automation classification applied, or — under its
 * own exact key — while it is a registered app thread fork (`forkAdmissible`).
 */
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Conversation, type ConversationId, type Harness as HarnessType, type Tx } from "@earendil-works/pi-durable";
import {
  chatScopeMessage,
  encodedSessionKey,
  isChatSessionKey,
  partitionChatScope,
  readChatScope,
  readChatSessions,
  readMappedSessions,
  type ChatScopeExclusion,
  type HistoryChatSession,
} from "../history/scope.js";

export const SessionMap = defineDoc<{ sessions: Record<string, number> }>({
  kind: "nanobot.session-map", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});

export interface SessionScopeOptions {
  readonly harness: HarnessType;
  readonly root: Conversation;
  /** This host's durable automation classification; never inferred from absence. */
  readonly isAutomation: (id: ConversationId) => boolean;
  /** The narrow app fork exception, bound to the exact session key that names the fork. */
  readonly forkAdmissible: (tx: Tx, sessionKey: string, id: ConversationId) => Promise<boolean>;
}

export type SessionScope = ReturnType<typeof createSessionScope>;

export function createSessionScope(options: SessionScopeOptions) {
  const { harness, root } = options;

  /** This host's scope record for one conversation: its class, never inferred from absence. */
  const scopeRecordFor = async (tx: Tx, id: ConversationId) => {
    const record = await tx.conversation(id);
    if (record === undefined) return undefined;
    return options.isAutomation(id) ? { ...record, automation: true } : record;
  };

  /** Structural scope of one session's conversation, with the app fork exception bound to that key. */
  const chatScopeForSession = async (
    tx: Tx, sessionKey: string, id: ConversationId,
  ): Promise<ChatScopeExclusion | undefined> => {
    const reason = await readChatScope((candidate) => scopeRecordFor(tx, candidate), id, root.id);
    if (reason !== "forked") return reason;
    return await options.forkAdmissible(tx, sessionKey, id) ? undefined : reason;
  };

  /** Conversation-id-only scope for background summary work: the exact mapped key decides forks. */
  const chatScopeById = async (tx: Tx, id: ConversationId): Promise<ChatScopeExclusion | undefined> => {
    const reason = await readChatScope((candidate) => scopeRecordFor(tx, candidate), id, root.id);
    if (reason !== "forked") return reason;
    const map = await tx.doc(SessionMap, root.id);
    const session = readMappedSessions(map.sessions, root.id).find((candidate) => candidate.conversationId === id);
    if (session === undefined) return reason;
    return await options.forkAdmissible(tx, session.sessionKey, id) ? undefined : reason;
  };

  /**
   * History scope: mapped chat sessions only. A channel's own state conversation, a scheduled run's
   * automation conversation and the root are not chat history, and the host has already
   * authenticated the session key before naming it.
   */
  const assertMappedChatConversations = async (
    sessions: readonly { readonly sessionKey: string; readonly conversationId: ConversationId }[],
    ctx: Context,
  ): Promise<void> => {
    await root.commit(async (tx) => {
      for (const { sessionKey, conversationId } of sessions) {
        const reason = await chatScopeForSession(tx, sessionKey, conversationId);
        if (reason !== undefined) throw new Error(chatScopeMessage(reason));
      }
    }, ctx);
  };

  /**
   * Background scope is decided by the conversation record and this host's automation
   * classification, never by the session key alone. An out-of-scope mapping is skipped instead of
   * failing the whole pass, so one forged entry cannot stop cataloguing or summarizing the
   * conversations that really are chat history. The per-session history surface still rejects such
   * a mapping loudly.
   */
  const mappedChatSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> => {
    const mapping = await harness.snapshot(SessionMap, root.id, ctx);
    if (mapping === undefined) return [];
    const candidates = readChatSessions(mapping.sessions, root.id);
    return root.commit(async (tx) => {
      const { chat, excluded } = await partitionChatScope((id) => scopeRecordFor(tx, id), candidates, root.id);
      const chats = [...chat];
      for (const entry of excluded) {
        if (entry.reason !== "forked") continue;
        if (await options.forkAdmissible(tx, entry.sessionKey, entry.conversationId)) chats.push(entry);
      }
      return chats;
    }, ctx);
  };

  const mappedConversationId = async (sessionKey: string, ctx: Context): Promise<ConversationId | undefined> => {
    const key = encodedSessionKey(sessionKey);
    const map = await harness.snapshot(SessionMap, root.id, ctx);
    const id = map && Object.hasOwn(map.sessions, key) ? map.sessions[key] : undefined;
    return Number.isSafeInteger(id) ? id as ConversationId : undefined;
  };

  const existingConversationFor = async (sessionKey: string, ctx: Context): Promise<Conversation> => {
    const id = await mappedConversationId(sessionKey, ctx);
    if (id === undefined) throw new Error("Unknown session key");
    const conversation = await harness.conversation(id, ctx);
    if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
    return conversation;
  };

  const mappedChatConversationFor = async (sessionKey: string, ctx: Context): Promise<Conversation> => {
    // State-only conversations hold channel bookkeeping, not discussion: they are not history.
    if (!isChatSessionKey(sessionKey)) throw new Error("State-only conversations are not chat history");
    const conversation = await existingConversationFor(sessionKey, ctx);
    await assertMappedChatConversations([{ sessionKey, conversationId: conversation.id }], ctx);
    return conversation;
  };

  const chatConversationIdFor = async (sessionKey: string, ctx: Context): Promise<ConversationId> =>
    (await mappedChatConversationFor(sessionKey, ctx)).id;

  return {
    scopeRecordFor,
    chatScopeForSession,
    chatScopeById,
    assertMappedChatConversations,
    mappedChatSessions,
    mappedConversationId,
    existingConversationFor,
    mappedChatConversationFor,
    chatConversationIdFor,
  };
}
