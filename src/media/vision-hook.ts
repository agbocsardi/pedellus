import {
  AgentDoc,
  GenerationTask,
  defineExtension,
  hook,
  type Extension,
  type HookApi,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelReference } from "../config.js";
import { modelKey } from "../config.js";
import type { VisionHandoff } from "./vision.js";

export interface VisionHandoffHookOptions {
  readonly handoff: VisionHandoff;
  /** Host default when a conversation has no stored model selection. */
  readonly defaultModel: ModelReference;
  /**
   * Model pinned by a live prepared generation dispatch, keyed by task ID.
   * Startup recovery resets conversation state to the configured preset, but a
   * prepared request must keep the model it was admitted with.
   */
  readonly preparedModel: (taskId: TaskId) => ModelReference | undefined;
}

/**
 * Native generation hook: transform the model-bound copy of a request only.
 * Persisted entries, prepared checkpoints and provider retries keep their
 * original messages; a describer call never enters Durable's agent loop.
 *
 * Durable reports a thrown generation hook as `extension_error` and then sends
 * the original messages, so a non-cancellation failure must not escape: for a
 * flagged target this hook falls back to stripping every image with explicit
 * unavailable text instead of letting raw bytes reach a model that cannot use
 * them.
 */
export function createVisionHandoffExtension(options: VisionHandoffHookOptions): Extension {
  return defineExtension({
    name: "nanobot-vision-handoff",
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api: HookApi, context) {
        let target: ModelReference | undefined;
        try {
          target = options.preparedModel(api.taskId)
            ?? await selectedModel(api, context)
            ?? options.defaultModel;
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          return replaced(options.handoff.failClosed(request.messages));
        }
        try {
          const messages = await options.handoff.transform(
            request.messages,
            target,
            api.models,
            modelKey,
            context.abortSignal,
          );
          return messages === request.messages ? undefined : replaced(messages);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          // A capable target keeps its intended raw images; a flagged or
          // unresolved target must not fall back to the untransformed request.
          if (options.handoff.rawImageCap(target, modelKey) === 0) {
            return replaced(options.handoff.failClosed(request.messages));
          }
          return undefined;
        }
      },
    })],
  });
}

function replaced(messages: readonly Message[]): { readonly messages: readonly Message[] } {
  return { messages };
}

async function selectedModel(api: HookApi, context: Context): Promise<ModelReference | undefined> {
  const state = await api.snapshot(AgentDoc, api.conversationId, context);
  const model = state?.model;
  if (model === undefined) return undefined;
  if (typeof model.provider !== "string" || typeof model.modelId !== "string"
    || model.provider.length === 0 || model.modelId.length === 0) {
    throw new Error("Stored conversation model is not a provider/model pair");
  }
  return { provider: model.provider, modelId: model.modelId };
}
