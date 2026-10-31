/**
 * The model-facing `telegram` action tool.
 *
 * It is a separate channel capability, not a `toolAllowlist` coding-tool name. The runtime offers
 * it only in a mapped Telegram private-chat conversation; the live adapter must also be attached
 * and must re-authenticate the exact chat and target at call time. The model supplies no chat or
 * session selector: the chat comes from the mapped session key, and `messageId` must be one of the
 * bounded observed targets in that chat.
 *
 * Ordinary assistant answers stay unthreaded. `reply` sends one native reply to an observed
 * message; `react` sets one emoji reaction. `send` uploads one existing workspace file as a native
 * document, photo, audio, video or voice message. The file path is workspace-relative and the
 * host resolves it: there is no remote URL, Telegram file id, credential or arbitrary recipient.
 * `send` is offered only when the host enables outbound files (configured `media` plus the `read`
 * coding tool), so the tool adds no filesystem read grant of its own. `targets` lists the ids the
 * model may use.
 *
 * The tool is not replay-safe: an interrupted execution is never rerun by Durable. The adapter's
 * write-ahead action record additionally refuses to resend an action whose outcome is unknown.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import {
  TELEGRAM_ACTION_LIMITS,
  TELEGRAM_FILE_KINDS,
  formatObservedTargets,
  validTelegramFilePath,
  type TelegramFileKind,
  type TelegramObservedTarget,
} from "./telegram-interactions.js";

export const TELEGRAM_TOOL_NAME = "telegram";

export type TelegramReplyRequest = { readonly kind: "reply"; readonly messageId: number; readonly text: string };
export type TelegramReactRequest = { readonly kind: "react"; readonly messageId: number; readonly emoji: string };
export type TelegramSendRequest = {
  readonly kind: TelegramFileKind;
  /** Workspace-relative path of one existing regular file. */
  readonly path: string;
  readonly caption?: string;
  /** Optional observed message to reply to; absent sends an ordinary unthreaded message. */
  readonly messageId?: number;
};
export type TelegramActionRequest = TelegramReplyRequest | TelegramReactRequest | TelegramSendRequest;

/** True only for a native media send; reply and react are the observed-target actions. */
export function isTelegramSendRequest(request: TelegramActionRequest): request is TelegramSendRequest {
  return request.kind !== "reply" && request.kind !== "react";
}

export type TelegramActionOutcome = {
  readonly ok: boolean;
  /** Model-facing result text. Fixed wording; never raw Telegram/provider error text. */
  readonly text: string;
  readonly messageIds?: readonly number[];
};

/**
 * Live adapter surface. `undefined` from `targets` means the chat is not currently authorized
 * (no durable private-chat admission evidence, or its sender is no longer in the live allowlist).
 */
export interface TelegramActionHost {
  targets(sessionKey: string): readonly TelegramObservedTarget[] | undefined;
  act(
    sessionKey: string,
    callId: string,
    request: TelegramActionRequest,
    context: Context,
  ): Promise<TelegramActionOutcome>;
}

/** One host per process, attached by the running Telegram adapter and detached when it stops. */
export interface TelegramActionRegistry {
  attach(host: TelegramActionHost): () => void;
  current(): TelegramActionHost | undefined;
}

export function createTelegramActionRegistry(): TelegramActionRegistry {
  let host: TelegramActionHost | undefined;
  return {
    attach(next) {
      const previous = host;
      host = next;
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        if (host === next) host = previous;
      };
    },
    current() {
      return host;
    },
  };
}

export interface TelegramToolOptions {
  readonly registry: TelegramActionRegistry;
  /** Host-owned mapping from a mapped conversation to its exact session key. */
  readonly sessionKeyFor: (conversationId: ConversationId) => string | undefined;
  /**
   * Host-owned outbound-file authority. True only when the host configured the workspace media
   * opt-in and the same conversation already holds the configured `read` coding tool, so a file
   * send adds no read grant the agent did not already have.
   */
  readonly fileSend?: boolean;
}

function textResult(text: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text }], isError: true };
}

export function createTelegramTool(options: TelegramToolOptions): { readonly extension: Extension } {
  const fileSend = options.fileSend === true;
  const tool = defineTool({
    name: TELEGRAM_TOOL_NAME,
    // An interrupted external send is ambiguous; Durable must not rerun this tool on recovery.
    replay: "unsafe",
    // The model and nested Code Mode calls may request a channel effect. The host's live
    // adapter, current private-chat admission, observed-target check, write-ahead action record
    // and task-id binding remain the authority; Code Mode adds no grant.
    callers: ["model", "tools"],
    description:
      "Interact with the authenticated Telegram private chat this conversation belongs to. Ordinary answers " +
      "are already delivered automatically and unthreaded; use this tool only when a native reply, a " +
      "reaction or a file delivery is clearly useful. action=targets lists the recent observed message ids " +
      "in this chat. action=reply sends an additional short native reply, not a replacement for the " +
      "ordinary answer; the substantive answer must still be ordinary turn text. action=react sets one " +
      "standard reaction emoji on one observed message id. " +
      (fileSend
        ? "action=send uploads one existing file from the configured workspace as a native document, " +
          "photo, audio, video or voice message, with an optional bounded caption and optional observed " +
          "reply target; the file must already exist under the workspace and its kind must match the " +
          "file, because no conversion or extraction is performed. "
        : "Outbound files are not enabled in this host. ") +
      "Never guess an id: only ids listed by targets, named in the current Telegram context, or returned " +
      "by an earlier action are valid. This tool cannot choose another chat, cannot fetch a remote URL, " +
      "cannot reuse a Telegram file id and cannot forward messages.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("targets"),
        Type.Literal("reply"),
        Type.Literal("react"),
        ...(fileSend ? [Type.Literal("send")] : []),
      ], { description: "targets: list observed ids; reply: native reply; react: emoji reaction; send: upload one workspace file." }),
      messageId: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Observed message id in this exact chat. Required for reply and react; optional reply target for send.",
      })),
      text: Type.Optional(Type.String({
        description: "Native reply text. Required for action=reply.",
      })),
      emoji: Type.Optional(Type.String({
        description: "One emoji to set as the reaction. Required for action=react.",
      })),
      kind: Type.Optional(Type.Union([
        ...TELEGRAM_FILE_KINDS.map((kind) => Type.Literal(kind)),
      ], { description: "File kind for action=send: document, photo, audio, video or voice." })),
      path: Type.Optional(Type.String({
        description: "Workspace-relative path of an existing regular file. Required for action=send.",
      })),
      caption: Type.Optional(Type.String({
        description: `Optional bounded caption for action=send (at most ${TELEGRAM_ACTION_LIMITS.captionChars} characters).`,
      })),
    }),
    outputLimits: { maxBytes: 16 * 1024, maxLines: 200, retain: "head" },
    async execute(args, api, context) {
      const sessionKey = options.sessionKeyFor(api.conversationId);
      if (sessionKey === undefined) {
        return errorResult("Telegram actions are not available in this conversation.");
      }
      const host = options.registry.current();
      if (host === undefined) {
        return errorResult("The Telegram adapter is not running, so no message can be sent or reacted to.");
      }
      if (context.abortSignal?.aborted) throw new Error("Operation aborted");
      // Provider call ids may repeat across turns or chats; Durable task ids identify executions.
      const actionId = `tool:${api.taskId}`;

      const action: string = args.action;
      if (action === "targets") {
        const targets = host.targets(sessionKey);
        if (targets === undefined) {
          return errorResult("This Telegram chat is not currently authorized for actions.");
        }
        return textResult(formatObservedTargets(targets));
      }

      if (action === "send") {
        // Defence in depth: the schema omits this action when the host has no outbound-file
        // authority, so a decline here means the caller bypassed the declared surface.
        if (!fileSend) return errorResult("Outbound files are not enabled in this host.");
        const kind = args.kind;
        if (kind === undefined || !TELEGRAM_FILE_KINDS.includes(kind)) {
          return errorResult("kind must be document, photo, audio, video or voice for action=send.");
        }
        const path = args.path;
        if (!validTelegramFilePath(path)) {
          return errorResult("path must be a workspace-relative path inside the configured workspace, " +
            "for example notes/report.pdf; absolute paths, `..` segments and Windows separators are refused.");
        }
        const caption = typeof args.caption === "string" ? args.caption.trim() : undefined;
        if (caption !== undefined && caption.length > TELEGRAM_ACTION_LIMITS.captionChars) {
          return errorResult(`A caption is limited to ${TELEGRAM_ACTION_LIMITS.captionChars} characters.`);
        }
        if (args.messageId !== undefined &&
            (typeof args.messageId !== "number" || !Number.isSafeInteger(args.messageId) || args.messageId < 1)) {
          return errorResult("messageId, when given for action=send, must be a positive observed message id.");
        }
        const outcome = await host.act(sessionKey, actionId, {
          kind,
          path,
          ...(caption === undefined || caption === "" ? {} : { caption }),
          ...(args.messageId === undefined ? {} : { messageId: args.messageId }),
        }, context);
        return outcome.ok
          ? {
              output: [{ type: "text" as const, text: outcome.text }],
              details: { action, kind, messageIds: [...(outcome.messageIds ?? [])] },
            }
          : errorResult(outcome.text);
      }

      const messageId = args.messageId;
      if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId < 1) {
        return errorResult("messageId must be a positive observed message id from this chat.");
      }

      try {
        if (action === "reply") {
          const text = typeof args.text === "string" ? args.text : "";
          if (text.trim().length === 0) {
            return errorResult("A native reply needs non-empty text.");
          }
          if (text.length > TELEGRAM_ACTION_LIMITS.textChars) {
            return errorResult(`Native reply text is limited to ${TELEGRAM_ACTION_LIMITS.textChars} characters.`);
          }
          const outcome = await host.act(sessionKey, actionId, { kind: "reply", messageId, text }, context);
          return outcome.ok
            ? {
                output: [{ type: "text" as const, text: outcome.text }],
                details: { action, messageId, messageIds: [...(outcome.messageIds ?? [])] },
              }
            : errorResult(outcome.text);
        }

        const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
        if (emoji.length === 0 || emoji.length > TELEGRAM_ACTION_LIMITS.emojiChars || /\s/.test(emoji)) {
          return errorResult("emoji must be one non-empty emoji without spaces.");
        }
        const outcome = await host.act(sessionKey, actionId, { kind: "react", messageId, emoji }, context);
        return outcome.ok
          ? {
              output: [{ type: "text" as const, text: outcome.text }],
              details: { action, messageId, emoji },
            }
          : errorResult(outcome.text);
      } catch (error) {
        if (context.abortSignal?.aborted) throw new Error("Operation aborted");
        throw error;
      }
    },
  });
  return { extension: defineExtension({ name: "nanobot-telegram-tool", tools: [tool] }) };
}
