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
 */
export function createVisionHandoffExtension(options: VisionHandoffHookOptions): Extension {
  return defineExtension({
    name: "nanobot-vision-handoff",
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api: HookApi, context) {
        const target = options.preparedModel(api.taskId)
          ?? await selectedModel(api, context)
          ?? options.defaultModel;
        const messages = await options.handoff.transform(
          request.messages,
          target,
          api.models,
          modelKey,
          context.abortSignal,
        );
        return messages === request.messages ? undefined : { messages };
      },
    })],
  });
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
