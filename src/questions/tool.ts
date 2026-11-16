/**
 * The model-facing `ask_user` tool.
 *
 * It is an owner-surface capability, not a coding tool: it takes no path, runs no shell and grants
 * nothing. The runtime offers it only in an authenticated mapped ordinary chat; a root, channel
 * state, fork, worker, digest or scheduled-run automation conversation never receives it.
 *
 * The tool admits bounded questions durably in this conversation, hands each to the unique live
 * surface for this exact session, and returns. It asks the run to end at this tool round
 * (`control.terminate`), so no provider call is parked and no task waits: the owner's answer is a
 * separate later turn. Nothing here pretends an answer is available now.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import {
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import {
  ASK_USER_LIMITS,
  ASK_USER_TOOL_NAME,
  AskQuestionsDoc,
  admitQuestionRecords,
  buildQuestionRecords,
  markQuestionDelivered,
  markQuestionDeliveryFailed,
  markQuestionDeliveryUnknown,
  normalizeAskInput,
  questionView,
} from "./ask.js";
import { AskDeliveryUnknown, type AskSurfaceRegistry } from "./surface.js";

export interface AskUserToolOptions {
  /** Live owner surfaces: the attached terminal and/or the running Telegram adapter. */
  readonly surfaces: AskSurfaceRegistry;
  /** Host-owned mapping from a mapped conversation to its exact session key. */
  readonly sessionKeyFor: (conversationId: ConversationId) => string | undefined;
  /** True only for authenticated ordinary mapped chats, never a worker, fork or task-owned scope. */
  readonly isAuthorizedChat: (conversationId: ConversationId) => boolean;
}

function textResult(text: string): { output: { type: "text"; text: string }[] } {
  return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text }], isError: true };
}

export function createAskUserTool(options: AskUserToolOptions): { readonly extension: Extension } {
  const tool = defineTool({
    name: ASK_USER_TOOL_NAME,
    // A second execution would admit a duplicate question; Durable must not rerun it on recovery.
    replay: "unsafe",
    // Only the model asks; a Code Mode script has no business starting an owner interaction.
    callers: ["model"],
    description:
      "Ask the owner of this authenticated chat one or more genuine decisions and end this turn. The question is " +
      "delivered to that owner's live surface with buttons (Telegram) or numbered options (local terminal). The " +
      "owner's answer arrives later as a separate follow-up message; it is never available in this tool result. " +
      "Use only for real decisions that need the owner: never for credentials, secrets, routine confirmations, or " +
      "status you could check yourself. If the owner can reasonably proceed without an answer, do not ask.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({
          minLength: 1,
          maxLength: ASK_USER_LIMITS.questionChars,
          description: "One exact question for the owner.",
        }),
        options: Type.Array(Type.Object({
          label: Type.String({
            minLength: 1,
            maxLength: ASK_USER_LIMITS.labelChars,
            description: "Short option label; unique within this question.",
          }),
          description: Type.Optional(Type.String({
            maxLength: ASK_USER_LIMITS.descriptionChars,
            description: "Optional one-line explanation shown under the label.",
          })),
        }), {
          minItems: ASK_USER_LIMITS.minOptions,
          maxItems: ASK_USER_LIMITS.maxOptions,
          description: `${ASK_USER_LIMITS.minOptions}-${ASK_USER_LIMITS.maxOptions} answer options.`,
        }),
      }), {
        minItems: 1,
        maxItems: ASK_USER_LIMITS.questionsPerRequest,
        description: `1-${ASK_USER_LIMITS.questionsPerRequest} questions, each with ${ASK_USER_LIMITS.minOptions}-` +
          `${ASK_USER_LIMITS.maxOptions} options.`,
      }),
      expiresInSeconds: Type.Optional(Type.Integer({
        minimum: ASK_USER_LIMITS.ttlSecondsMin,
        maximum: ASK_USER_LIMITS.ttlSecondsMax,
        description: `Seconds the question stays answerable (default ${ASK_USER_LIMITS.ttlSecondsDefault}). ` +
          "An expired question is refused; no default option is chosen.",
      })),
    }),
    outputLimits: { maxBytes: 8 * 1024, maxLines: 80, retain: "head" },
    async execute(args, api, context: Context) {
      const sessionKey = options.sessionKeyFor(api.conversationId);
      if (sessionKey === undefined || !options.isAuthorizedChat(api.conversationId)) {
        return errorResult("Questions are available only in an authenticated owner chat, not in this conversation.");
      }
      const normalized = normalizeAskInput(args.questions, args.expiresInSeconds);
      if (!normalized.ok) return errorResult(normalized.reason);
      const surface = options.surfaces.surfaceFor(sessionKey);
      if (surface === undefined) {
        return errorResult(
          "No live owner surface is attached to this chat, so a question cannot be delivered. Nothing is waiting " +
          "for an answer.",
        );
      }
      const now = api.now();
      const records = buildQuestionRecords({
        questions: normalized.questions,
        sessionKey,
        taskId: Number(api.taskId),
        nowMs: now,
        ttlSeconds: normalized.ttlSeconds,
      });
      const admission = await api.commit(async (tx) => {
        const doc = await tx.doc(AskQuestionsDoc, api.conversationId);
        return admitQuestionRecords(doc, records, now);
      }, context);
      if (admission === "pending") {
        return errorResult(
          "A question is already awaiting the owner's answer in this chat. Wait for that answer or its expiry " +
          "before asking another question.",
        );
      }
      if (admission !== "admitted") {
        return errorResult("The pending-question record is not usable, so no question was admitted or delivered.");
      }

      // Deliver each admitted question once. A partial failure closes only the questions the surface did
      // not accept, so an already-rendered question stays answerable and nothing claims a false success.
      const delivered: string[] = [];
      let failure: unknown;
      for (const record of records) {
        try {
          await surface.deliverQuestion(sessionKey, questionView(record), context);
          delivered.push(record.id);
        } catch (error) {
          failure = error;
          break;
        }
      }
      const refused = records.map((record) => record.id).filter((id) => !delivered.includes(id));
      if (failure !== undefined) {
        if (context.abortSignal?.aborted) throw new Error("Operation aborted");
        await api.commit(async (tx) => {
          const doc = await tx.doc(AskQuestionsDoc, api.conversationId);
          markQuestionDelivered(doc, delivered);
          const unknownId = failure instanceof AskDeliveryUnknown ? refused[0] : undefined;
          if (unknownId !== undefined) markQuestionDeliveryUnknown(doc, unknownId);
          markQuestionDeliveryFailed(doc, refused.filter((id) => id !== unknownId));
        }, context).catch(() => undefined);
        if (failure instanceof AskDeliveryUnknown) {
          return { ...errorResult("Question delivery outcome is unknown. It may have reached the owner; it is quarantined and will not be resent. Do not claim delivery or non-delivery."), control: { terminate: true } };
        }
        const result = errorResult(delivered.length === 0
          ? "The owner surface did not accept the question, so it was closed. Nothing is waiting for an answer; do " +
            "not claim it was delivered."
          : `Delivered question ${delivered.join(", ")}; the remaining question(s) were closed because the owner ` +
            "surface did not accept them. Do not claim an answer in this turn.");
        return delivered.length > 0 ? { ...result, control: { terminate: true } } : result;
      }

      const ids = records.map((record) => record.id);
      await api.commit(async (tx) => {
        markQuestionDelivered(await tx.doc(AskQuestionsDoc, api.conversationId), ids);
      }, context);

      const minutes = Math.max(1, Math.round(normalized.ttlSeconds / 60));
      const receipt = records.length === 1
        ? `Question ${ids[0]} delivered to the owner's surface with ${records[0]!.options.length} options. ` +
          `The owner's answer arrives as a separate later message; nothing is answered in this turn. ` +
          `The question can be answered for about ${minutes} minute${minutes === 1 ? "" : "s"}.`
        : `${records.length} questions delivered to the owner's surface: ${ids.join(", ")}. Their answers arrive ` +
          `as separate later messages; nothing is answered in this turn. They can be answered for about ` +
          `${minutes} minute${minutes === 1 ? "" : "s"}.`;
      return {
        output: [{ type: "text" as const, text: receipt }],
        details: { questionIds: ids },
        control: { terminate: true },
      };
    },
  });
  return { extension: defineExtension({
    name: "nanobot-ask-user-tool", tools: [tool],
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, context) {
        if (call.name !== ASK_USER_TOOL_NAME) return undefined;
        // Native terminate requires every result in the round to request it. Refuse mixed rounds
        // before delivery, rather than display a question and let generation continue afterward.
        const page = await api.entries({ order: "descending" }, 200, undefined, context);
        for (const entry of page.items) {
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
            const calls = message.content.filter((part) => part.type === "toolCall");
            if (!calls.some((part) => part.id === call.id)) continue;
            return calls.length === 1 ? undefined
              : { block: "ask_user must be the only tool call in its round. Complete other work first, then ask." };
          }
        }
        return { block: "The question's sole-tool round could not be verified; nothing was delivered." };
      },
    })],
  }) };
}
