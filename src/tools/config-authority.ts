import {
  defineDoc,
  hook,
  ToolTask,
  type ConversationId,
  type HookRegistration,
  type ToolHookCall,
} from "@earendil-works/pi-durable";

/**
 * Captured coding-tool authority for one scheduled isolated run.
 *
 * `toolAllowlist` directly authorizes authenticated mapped chat conversations, but a scheduled
 * run's target is a fresh task-owned conversation and has no session key. In the same commit that
 * creates it, cron captures the ceiling that its authenticated origin currently has, plus that
 * origin's conversation ID. The capture is a snapshot of names, never an expiry: the call-time hook
 * still requires each name to be in the current host ceiling and the recorded origin to still be an
 * authenticated mapped chat. A finished or cancelled run's capture is retired, and a capture whose
 * origin is unknown or no longer chat-authorized authorizes nothing.
 */
export type ConfigToolCaptureDocument = {
  readonly originConversationId: number;
  /** Captured tool names; mutable because Durable document values are JSON arrays. */
  readonly tools: string[];
};

export const ConfigToolCaptureDoc = defineDoc<ConfigToolCaptureDocument>({
  kind: "nanobot.config-tool-capture",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ originConversationId: 0, tools: [] }),
  checkpointWhen: () => true,
});

/**
 * Names a scheduled run may hold right now: captured names the host still configures, in host
 * ceiling order. The origin check is supplied by the host because only it knows which
 * conversations are authenticated chat sessions.
 */
export function boundedCapturedTools(
  captured: readonly string[],
  ceiling: readonly string[],
  originAuthorized: boolean,
): string[] {
  if (!originAuthorized || !Array.isArray(captured)) return [];
  const capturedNames = new Set<string>(captured.filter((name): name is string => typeof name === "string"));
  return ceiling.filter((name) => capturedNames.has(name));
}

/**
 * Last-line call check. An authenticated mapped chat conversation may use the ceiling, and a
 * scheduled run's target may use only its captured names while its recorded origin is still an
 * authenticated mapped chat. Anything else (the root, a channel-state conversation, a fork, a raw
 * or task-owned conversation without a valid capture) is denied, so agent state that still names a
 * removed tool can never call it. `contextTools` (skill, cron, history) are exempt because they
 * carry no filesystem or shell authority.
 */
export function createConfigToolHook(
  ceiling: readonly string[],
  isAuthenticatedChat: (conversationId: ConversationId) => boolean,
  contextTools: readonly string[] = [],
): HookRegistration {
  const allowed = new Set(ceiling);
  const ungated = new Set(contextTools);
  return hook(ToolTask, {
    async beforeTool(call: ToolHookCall, api, context) {
      if (ungated.has(call.name)) return undefined;
      if (!allowed.has(call.name)) {
        return { block: `Tool ${call.name} is outside the host tool ceiling` };
      }
      if (isAuthenticatedChat(api.conversationId)) return undefined;
      try {
        const capture = await api.snapshot(ConfigToolCaptureDoc, api.conversationId, context);
        if (capture === undefined) {
          return { block: `Tool ${call.name} is not enabled for this conversation` };
        }
        const originId = capture.originConversationId;
        if (!Number.isSafeInteger(originId) || originId < 1) {
          return { block: `Tool ${call.name} capture has an invalid origin; refusing the call` };
        }
        if (!isAuthenticatedChat(originId as ConversationId)) {
          return { block: `Tool ${call.name} capture origin is not an authenticated chat; refusing the call` };
        }
        if (!Array.isArray(capture.tools) || !capture.tools.includes(call.name)) {
          return { block: `Tool ${call.name} is not in this run's captured config authority` };
        }
        return undefined;
      } catch {
        // Durable treats a throwing hook as a block, but a rejected hook must never read as allowed.
        return { block: `Tool ${call.name} authority could not be read; refusing the call` };
      }
    },
  });
}
