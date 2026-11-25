/**
 * The live host behind the model-callable `telegram` tool: native replies, reactions and workspace
 * file uploads in the exact authorized private chat, against observed targets only.
 *
 * Authority is re-derived for every call: the mapped session key is host-owned, and the chat must
 * still have durable private-chat admission evidence for this bot whose sender is in the CURRENT
 * allowlist. The model never supplies a chat or session selector. Each effect is fenced by a
 * write-ahead action record (see `telegram-interactions.ts`): the intent and `sending` status are
 * durable before the API call, a success records the returned ids, a known rejection fails closed,
 * and any other outcome is held as `unknown`, never resent.
 */
import type { Context, Draft } from "@earendil-works/chord";
import type { ReactionType, ReactionTypeEmoji } from "grammy/types";
import type { Message } from "grammy/types";
import { InputFile } from "grammy";
import {
  TELEGRAM_ACTION_LIMITS,
  TELEGRAM_TARGET_LIMITS,
  actionFor,
  admitAction,
  findTarget,
  settleActionRecord,
  targetsForChat,
  unresolvedActions,
  validTelegramFilePath,
  type TelegramActionAdmission,
  type TelegramActionRecord,
  type TelegramObservedTarget,
} from "./telegram-interactions.js";
import {
  TELEGRAM_SEND_METHODS,
  TelegramOutboundRejected,
  outboundRejectionText,
  readTelegramOutboundFile,
} from "./telegram-outbound-media.js";
import {
  IDLE_TEXT_HOOKS,
  isKnownNotSent,
  type TelegramSendTextOptions,
  type TelegramTransport,
} from "./telegram-transport.js";
import {
  isTelegramSendRequest,
  type TelegramActionHost,
  type TelegramActionOutcome,
  type TelegramActionRequest,
  type TelegramSendRequest,
} from "./telegram-tool.js";

/** The parts of the adapter's durable channel state the action host reads and writes. */
export type TelegramActionState = {
  targets: TelegramObservedTarget[];
  actions: TelegramActionRecord[];
};

export interface TelegramActionHostOptions {
  readonly transport: TelegramTransport;
  /** Outbound uploads resolve against this workspace only; absent refuses every file send. */
  readonly outboundWorkspace: string | undefined;
  /** The current committed state copy. */
  state(): Readonly<TelegramActionState>;
  /** One commit of the adapter's channel state. */
  mutate(change: (doc: Draft<TelegramActionState>) => void): Promise<void>;
  /** The authorized private chat of one mapped session key, or `undefined`. */
  authorizedChat(sessionKey: string): number | undefined;
  /** False once the adapter is stopping. */
  active(): boolean;
  sendText(chatId: number, text: string, options: TelegramSendTextOptions): Promise<number | undefined>;
  splitText(text: string): string[];
  /** Best-effort durable target observation of one accepted outgoing message. */
  rememberOutgoing(chatId: number, messageId: number, text: string): Promise<void>;
}

export interface TelegramActions {
  readonly host: TelegramActionHost;
  /**
   * On open: a model-requested external action may have reached Telegram before a crash. Every
   * unresolved intent/sending record is quarantined as unknown and never resent.
   */
  recover(): Promise<void>;
}

const NOT_OBSERVED = (messageId: number): string =>
  `Message id ${messageId} is not an observed message in this chat, so it cannot be targeted. ` +
  "Use action=targets to see the ids this chat may target.";

export function createTelegramActions(options: TelegramActionHostOptions): TelegramActions {
  const { transport } = options;
  const { api } = transport;

  const settleAction = async (
    callId: string,
    status: "sent" | "unknown" | "failed" | "denied",
    error?: string,
  ): Promise<void> => {
    await options.mutate((doc) => {
      settleActionRecord(doc.actions, callId, status, error === undefined ? {} : { error });
    });
  };

  const recordResultId = (callId: string, messageId: number): Promise<void> => options.mutate((doc) => {
    const entry = doc.actions.find((candidate) => candidate.callId === callId);
    if (entry !== undefined) entry.resultMessageIds = [...(entry.resultMessageIds ?? []), messageId];
  });

  const actionOutcome = (record: TelegramActionRecord): TelegramActionOutcome => {
    if (record.status === "sent") {
      const ids = record.resultMessageIds ?? [];
      return {
        ok: true,
        text: ids.length === 0
          ? "This Telegram action was already applied."
          : `This Telegram action was already applied (message id ${ids.join(", ")}).`,
        ...(ids.length === 0 ? {} : { messageIds: ids }),
      };
    }
    if (record.status === "unknown" || record.status === "sending") {
      return { ok: false, text: "The outcome of this Telegram action is unknown; it will not be retried automatically." };
    }
    if (record.status === "failed") {
      return { ok: false, text: "This Telegram action previously failed and will not be retried automatically." };
    }
    if (record.status === "denied") {
      return { ok: false, text: "This Telegram action was previously denied and will not be retried automatically." };
    }
    return { ok: false, text: "This Telegram action was interrupted before sending and will not be retried automatically." };
  };

  const priorActionOutcome = (
    record: TelegramActionRecord,
    chatId: number,
    request: TelegramActionRequest,
  ): TelegramActionOutcome => {
    const targetMessageId = isTelegramSendRequest(request)
      ? request.messageId ?? 0
      : request.messageId;
    const samePayload = isTelegramSendRequest(request)
      ? record.path === request.path && (record.caption ?? "") === (request.caption ?? "")
      : request.kind === "reply"
        ? record.text === request.text
        : record.emoji === request.emoji;
    if (record.chatId !== chatId || record.targetMessageId !== targetMessageId ||
        record.kind !== request.kind || !samePayload) {
      return { ok: false, text: "This action identity belongs to a different request; no action was taken." };
    }
    return actionOutcome(record);
  };

  /**
   * Fixed refusal for a fresh call that would repeat an effect whose earlier attempt in this chat has
   * no definite outcome. It states the uncertainty, that nothing new left the host, and what not to do:
   * a reworded or re-identified retry would duplicate the effect rather than resolve it.
   */
  const repeatedEffectOutcome = (): TelegramActionOutcome => ({
    ok: false,
    text: "No new Telegram message was sent. An earlier action in this chat with the same kind, target and " +
      "content has no definite outcome yet, so it may already have been applied, possibly in part. Do not " +
      "work around this by rewording the text, changing the target or using a new call id: if the earlier " +
      "attempt was delivered, that would deliver the effect twice. Tell the owner the earlier delivery's " +
      "outcome is unknown.",
  });

  /**
   * One native media upload. The workspace file is read into bounded memory before the API call so
   * the bytes cannot change mid-upload, and every refusal happens before any external request. The
   * `sending` record was already written by `act`, so an abort or transport ambiguity here stays
   * `unknown` and is never resent.
   */
  const performFileSend = async (
    chatId: number,
    callId: string,
    request: TelegramSendRequest,
  ): Promise<TelegramActionOutcome> => {
    const kind = request.kind;
    const caption = request.caption === undefined || request.caption === "" ? undefined : request.caption;
    const targetMessageId = request.messageId ?? 0;
    if (options.outboundWorkspace === undefined) {
      await settleAction(callId, "failed", "outbound files are not configured");
      return { ok: false, text: "Outbound files are not enabled in this host." };
    }
    let file;
    try {
      file = await readTelegramOutboundFile({ workspace: options.outboundWorkspace, path: request.path, kind });
    } catch (error) {
      const reason = error instanceof TelegramOutboundRejected ? error.reason : "unreadable";
      // Nothing left the host, so this is a known non-send rather than an ambiguous outcome.
      await settleAction(callId, "failed", `outbound file refused: ${reason}`);
      return { ok: false, text: `The file was not sent: ${outboundRejectionText(kind, reason)}.` };
    }
    const method = TELEGRAM_SEND_METHODS[kind];
    try {
      const sent = await transport.call<Message>(method, (signal) => transport.inChatOrder<Message>(chatId, () => {
        const outbound = new InputFile(file!.bytes, file!.filename);
        const other = {
          ...(caption === undefined ? {} : { caption }),
          ...(targetMessageId > 0
            ? { reply_parameters: { message_id: targetMessageId, allow_sending_without_reply: false } }
            : {}),
        };
        switch (kind) {
          case "document": return api.sendDocument(chatId, outbound, other, signal);
          case "photo": return api.sendPhoto(chatId, outbound, other, signal);
          case "audio": return api.sendAudio(chatId, outbound, other, signal);
          case "video": return api.sendVideo(chatId, outbound, { ...other, supports_streaming: true }, signal);
          case "voice": return api.sendVoice(chatId, outbound, other, signal);
        }
      }), { throttle: transport.outbound });
      if (sent === undefined) throw new Error(`Telegram ${method} returned no result`);
      await recordResultId(callId, sent.message_id);
      await options.rememberOutgoing(chatId, sent.message_id, caption ?? `[${kind}: ${file.filename}]`);
      await settleAction(callId, "sent");
      return {
        ok: true,
        text: `Sent one ${kind} (${file.filename})` +
          `${targetMessageId > 0 ? ` as a native reply to message ${targetMessageId}` : ""} ` +
          `(message id ${sent.message_id}).`,
        messageIds: [sent.message_id],
      };
    } catch (error) {
      if (isKnownNotSent(error)) {
        await settleAction(callId, "failed", "Telegram rejected the upload");
        return {
          ok: false,
          text: "Telegram rejected the file; it was not accepted and will not be retried automatically.",
        };
      }
      await settleAction(callId, "unknown");
      console.warn(`Telegram ${kind} upload outcome unknown; it will not be retried automatically.`);
      return { ok: false, text: "The file may or may not have been delivered; it will not be retried automatically." };
    }
  };

  /**
   * Perform one already-admitted action. A `sending` record precedes the API call; a success records
   * the returned ids, a known rejection fails closed, and any other outcome is quarantined as
   * `unknown` so a later replay or reopen never resends it blindly.
   */
  const performAction = async (
    chatId: number,
    callId: string,
    request: TelegramActionRequest,
  ): Promise<TelegramActionOutcome> => {
    if (isTelegramSendRequest(request)) return performFileSend(chatId, callId, request);
    try {
      if (request.kind === "react") {
        const reaction: ReactionType[] = [{
          type: "emoji",
          // The adapter does not hardcode Telegram's reaction allowlist; an unsupported emoji is a
          // known rejection and fails closed without retry.
          emoji: request.emoji as ReactionTypeEmoji["emoji"],
        }];
        await transport.call("setMessageReaction", (signal) => transport.inChatOrder(chatId, () =>
          api.setMessageReaction(chatId, request.messageId, reaction, {}, signal)),
        { throttle: transport.outbound });
        await settleAction(callId, "sent");
        return { ok: true, text: `Set the ${request.emoji} reaction on message ${request.messageId}.` };
      }
      const chunks = options.splitText(request.text);
      const ids: number[] = [];
      for (let index = actionFor(options.state().actions, callId)?.nextChunkIndex ?? 0; index < chunks.length; index++) {
        const sent = await options.sendText(chatId, chunks[index]!, {
          ...(index === 0 ? { replyTo: request.messageId } : {}),
          throttle: transport.outbound,
          hooks: {
            ...IDLE_TEXT_HOOKS,
            partAccepted: async (sentId) => {
              ids.push(sentId);
              await recordResultId(callId, sentId);
            },
            accepted: async () => {
              await options.mutate((doc) => {
                const entry = doc.actions.find((candidate) => candidate.callId === callId);
                if (entry !== undefined) entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
              });
            },
          },
        });
        if (sent === undefined) throw new Error("Telegram send returned no result");
      }
      await settleAction(callId, "sent");
      return {
        ok: true,
        text: `Sent as a native reply to message ${request.messageId}` +
          `${ids.length > 1 ? ` in ${ids.length} parts` : ""} (message id ${ids.join(", ")}).`,
        messageIds: ids,
      };
    } catch (error) {
      // `sendMessage` 5xx is already `unknown`. A reaction 5xx is likewise ambiguous, so only a
      // proven pre-connect failure or a non-5xx rejection may be called a known non-send.
      if (isKnownNotSent(error)) {
        await settleAction(callId, "failed", "Telegram rejected the action");
        return {
          ok: false,
          text: "Telegram rejected the action; it was not applied and will not be retried automatically.",
        };
      }
      await settleAction(callId, "unknown");
      console.warn(`Telegram ${request.kind} action outcome unknown; it will not be retried automatically.`);
      return {
        ok: false,
        text: "The Telegram action may or may not have been applied; it will not be retried automatically.",
      };
    }
  };

  /** Validate one request against the observed targets of this chat; a refusal text or the target id. */
  const validateRequest = (chatId: number, request: TelegramActionRequest): string | number => {
    const targets = options.state().targets;
    if (isTelegramSendRequest(request)) {
      // A host caller may bypass the model schema; an unknown kind is refused before admission.
      if (!Object.hasOwn(TELEGRAM_SEND_METHODS, request.kind)) return "Unknown Telegram file kind; no file was sent.";
      // Outbound files need the configured workspace media opt-in. The tool is also withheld unless
      // the same conversation holds the configured `read` tool, so this adds no read grant.
      if (options.outboundWorkspace === undefined) return "Outbound files are not enabled in this host.";
      if (!validTelegramFilePath(request.path)) {
        return "The file path must be workspace-relative and inside the configured workspace.";
      }
      if (request.caption !== undefined &&
          (typeof request.caption !== "string" || request.caption.length > TELEGRAM_ACTION_LIMITS.captionChars)) {
        return `A caption is limited to ${TELEGRAM_ACTION_LIMITS.captionChars} characters.`;
      }
      if (request.messageId !== undefined && (!Number.isSafeInteger(request.messageId) || request.messageId < 1)) {
        return "messageId, when given for a file send, must be a positive observed message id.";
      }
      const target = request.messageId ?? 0;
      // A file send without a reply target is ordinary; a named target must be observed here.
      if (target > 0 && findTarget(targets, chatId, target) === undefined) return NOT_OBSERVED(target);
      return target;
    }
    if (!Number.isSafeInteger(request.messageId) || request.messageId < 1) {
      return "messageId must be a positive observed message id from this chat.";
    }
    if (findTarget(targets, chatId, request.messageId) === undefined) return NOT_OBSERVED(request.messageId);
    return request.messageId;
  };

  const host: TelegramActionHost = {
    targets(sessionKey) {
      if (!options.active()) return undefined;
      const chatId = options.authorizedChat(sessionKey);
      if (chatId === undefined) return undefined;
      return targetsForChat(options.state().targets, chatId, TELEGRAM_TARGET_LIMITS.listing);
    },
    async act(sessionKey, callId, request, ctx: Context) {
      if (!options.active() || ctx.abortSignal?.aborted) {
        return { ok: false, text: "The Telegram adapter is stopping, so no action was taken." };
      }
      if (typeof callId !== "string" || callId === "" || callId.length > TELEGRAM_ACTION_LIMITS.callIdChars) {
        return { ok: false, text: "This Telegram action has no usable call identity and was not taken." };
      }
      const chatId = options.authorizedChat(sessionKey);
      if (chatId === undefined) return { ok: false, text: "This chat is not currently authorized for Telegram actions." };
      const validated = validateRequest(chatId, request);
      if (typeof validated === "string") return { ok: false, text: validated };
      const targetMessageId = validated;
      const existing = actionFor(options.state().actions, callId);
      if (existing !== undefined) return priorActionOutcome(existing, chatId, request);

      const record: TelegramActionRecord = {
        callId,
        kind: request.kind,
        chatId,
        targetMessageId,
        ...(isTelegramSendRequest(request)
          ? { path: request.path, ...(request.caption === undefined ? {} : { caption: request.caption }) }
          : request.kind === "reply"
            ? { text: request.text }
            : { emoji: request.emoji }),
        status: "intent",
        nextChunkIndex: 0,
        startedAtMs: Date.now(),
      };
      let admission: TelegramActionAdmission = "full";
      await options.mutate((doc) => {
        admission = admitAction(doc.actions, record);
      });
      if (admission === "full") {
        return { ok: false, text: "Too many Telegram actions are awaiting outcome; this action was not taken." };
      }
      if (admission === "conflict") {
        // The fence refused inside the intent transaction: no record, no preflight and no API call
        // was made for this call id, and the earlier record is left exactly as it was.
        return repeatedEffectOutcome();
      }
      if (admission === "duplicate") {
        const duplicate = actionFor(options.state().actions, callId);
        return duplicate === undefined
          ? { ok: false, text: "This Telegram action is already recorded and will not be resent." }
          : priorActionOutcome(duplicate, chatId, request);
      }
      // Preflight recheck after the durable intent: never send if the adapter stopped, the admission
      // evidence changed, or the target was evicted between validation and the effect.
      if (!options.active() || ctx.abortSignal?.aborted) {
        await settleAction(callId, "denied", "adapter stopped before sending");
        return { ok: false, text: "The adapter stopped before sending; no action was taken." };
      }
      if (options.authorizedChat(sessionKey) === undefined ||
          (targetMessageId > 0 && findTarget(options.state().targets, chatId, targetMessageId) === undefined)) {
        await settleAction(callId, "denied", "scope or target recheck failed");
        return { ok: false, text: "The chat or target is no longer authorized; no action was taken." };
      }
      await options.mutate((doc) => {
        const entry = doc.actions.find((candidate) => candidate.callId === callId);
        if (entry !== undefined) entry.status = "sending";
      });
      return performAction(chatId, callId, request);
    },
  };

  return {
    host,
    async recover() {
      for (const action of unresolvedActions(options.state().actions)) {
        await settleAction(action.callId, "unknown");
        console.warn(`Telegram ${action.kind} action was interrupted before its outcome was recorded; ` +
          "it will not be retried automatically.");
      }
    },
  };
}
