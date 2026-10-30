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
 * message; `react` sets one emoji reaction. `targets` lists the ids the model may use.
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
  formatObservedTargets,
  type TelegramObservedTarget,
} from "./telegram-interactions.js";

export const TELEGRAM_TOOL_NAME = "telegram";

export type TelegramActionRequest =
  | { readonly kind: "reply"; readonly messageId: number; readonly text: string }
  | { readonly kind: "react"; readonly messageId: number; readonly emoji: string };

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
}

function textResult(text: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text }], isError: true };
}

export function createTelegramTool(options: TelegramToolOptions): { readonly extension: Extension } {
  const tool = defineTool({
    name: TELEGRAM_TOOL_NAME,
    // An interrupted external send is ambiguous; Durable must not rerun this tool on recovery.
    replay: "unsafe",
    // Only the model may request a channel effect; Code Mode scripts cannot start one.
    callers: ["model"],
    description:
      "Interact with the authenticated Telegram private chat this conversation belongs to. Ordinary answers " +
      "are already delivered automatically and unthreaded; use this tool only when a native reply or a " +
      "reaction is clearly useful. action=targets lists the recent observed message ids in this chat. " +
      "action=reply sends a native reply to one observed message id. action=react sets one emoji reaction " +
      "on one observed message id. Never guess an id: only ids listed by targets, named in the current " +
      "Telegram context, or returned by an earlier action are valid. This tool cannot choose another chat " +
      "and cannot forward messages.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("targets"),
        Type.Literal("reply"),
        Type.Literal("react"),
      ], { description: "targets: list observed ids; reply: native reply; react: emoji reaction." }),
      messageId: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Observed message id in this exact chat. Required for reply and react.",
      })),
      text: Type.Optional(Type.String({
        description: "Native reply text. Required for action=reply.",
      })),
      emoji: Type.Optional(Type.String({
        description: "One emoji to set as the reaction. Required for action=react.",
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

      const action = args.action;
      if (action === "targets") {
        const targets = host.targets(sessionKey);
        if (targets === undefined) {
          return errorResult("This Telegram chat is not currently authorized for actions.");
        }
        return textResult(formatObservedTargets(targets));
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
          const outcome = await host.act(sessionKey, api.callId, { kind: "reply", messageId, text }, context);
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
        const outcome = await host.act(sessionKey, api.callId, { kind: "react", messageId, emoji }, context);
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
