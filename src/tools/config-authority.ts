import {
  defineDoc,
  hook,
  ToolTask,
  type ConversationId,
  type HookRegistration,
  type ToolHookCall,
} from "@earendil-works/pi-durable";

/**
 * Captured tool authority for one task-owned target. Cron/digest capture only their coding subset;
 * ordinary workers can additionally capture separately configured research and coding grants, plus
 * the one configured classifier model identity when Code Mode is part of their grant.
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
  /**
   * Captured classifier model identity (`JSON.stringify([provider, modelId])`), pruned with
   * `tools`. `null` denies classifiers for that run; a capture written before this field
   * existed also denies rather than re-admitting a stale configuration.
   */
  readonly classifierModel: string | null;
};

export const ConfigToolCaptureDoc = defineDoc<ConfigToolCaptureDocument>({
  kind: "nanobot.config-tool-capture",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ originConversationId: 0, tools: [], classifierModel: null }),
  checkpointWhen: () => true,
});

/** Strict read of a capture's tool list: every entry must be a string; mixed-type arrays are invalid. */
export function validCapturedToolNames(tools: unknown): readonly string[] | undefined {
  if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string")) return undefined;
  return tools as readonly string[];
}

/**
 * Names a scheduled run may hold right now: captured names the host still configures, in host
 * ceiling order. The origin check is supplied by the host because only it knows which
 * conversations are authenticated chat sessions. A malformed or mixed-type array fails closed.
 */
export function boundedCapturedTools(
  captured: readonly string[],
  ceiling: readonly string[],
  originAuthorized: boolean,
): string[] {
  if (!originAuthorized) return [];
  const valid = validCapturedToolNames(captured);
  if (valid === undefined) return [];
  const capturedNames = new Set<string>(valid);
  return ceiling.filter((name) => capturedNames.has(name));
}

/** Why a durable capture does not authorize one tool call; each caller words its own refusal. */
export type CapturedToolRefusal = "unreadable" | "missing" | "origin" | "unauthorized" | "tool";

export type CapturedToolVerdict =
  | { readonly ok: true; readonly capture: ConfigToolCaptureDocument; readonly origin: ConversationId }
  | { readonly ok: false; readonly reason: CapturedToolRefusal };

/**
 * The one call-time reading of a {@link ConfigToolCaptureDoc}, shared by every hook and host that
 * honours a captured grant (coding tools, worker and scheduled-run capabilities, memory recall). The
 * stored value is untrusted JSON: a capture authorizes `tool` only when it is readable, names a
 * positive origin conversation that `originAuthorized` still accepts, and lists `tool` among string
 * names. Anything else is a refusal, never a widened default; a read that throws is `unreadable`.
 */
export async function verifyCapturedTool(
  read: () => Promise<unknown>,
  tool: string,
  originAuthorized: (origin: ConversationId) => boolean,
): Promise<CapturedToolVerdict> {
  let value: unknown;
  try {
    value = await read();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "missing" };
  const capture = value as Partial<Record<keyof ConfigToolCaptureDocument, unknown>>;
  const origin = capture.originConversationId;
  if (typeof origin !== "number" || !Number.isSafeInteger(origin) || origin < 1) return { ok: false, reason: "origin" };
  if (!originAuthorized(origin as ConversationId)) return { ok: false, reason: "unauthorized" };
  const tools = validCapturedToolNames(capture.tools);
  if (tools === undefined || !tools.includes(tool)) {
    return { ok: false, reason: "tool" };
  }
  return { ok: true, capture: value as ConfigToolCaptureDocument, origin: origin as ConversationId };
}

/**
 * Last-line call check. An authenticated mapped chat conversation may use the ceiling, and a
 * scheduled run's target may use only its captured names while its recorded origin is still an
 * authenticated mapped chat. Anything else (the root, a channel-state conversation, a fork, a raw
 * or task-owned conversation without a valid capture) is denied, so agent state that still names a
 * removed tool can never call it. `contextTools` (skill, cron, memory recall) are exempt because they
 * carry no filesystem or shell authority. `delegatedTools` names a separate authority whose own
 * call-time hook is selected in the same conversations (MCP server tools and the Code Mode/tool
 * search tools that reach them); they are exempt here but never unguarded: the delegating
 * predicate must be false unless that hook is installed. `capturedCeiling` permits an independent
 * coding ceiling for ordinary workers only; their additional hook checks every captured tool.
 */
export function createConfigToolHook(
  ceiling: readonly string[],
  isAuthenticatedChat: (conversationId: ConversationId) => boolean,
  contextTools: readonly string[] = [],
  delegatedTools?: (name: string) => boolean,
  capturedCeiling?: (conversationId: ConversationId) => readonly string[],
): HookRegistration {
  const allowed = new Set(ceiling);
  const ungated = new Set(contextTools);
  const refusals: Record<CapturedToolRefusal, (name: string) => string> = {
    // Durable treats a throwing hook as a block, but a rejected read must never read as allowed.
    unreadable: (name) => `Tool ${name} authority could not be read; refusing the call`,
    missing: (name) => `Tool ${name} is not enabled for this conversation`,
    origin: (name) => `Tool ${name} capture has an invalid origin; refusing the call`,
    unauthorized: (name) => `Tool ${name} capture origin is not an authenticated chat; refusing the call`,
    tool: (name) => `Tool ${name} is not in this run's captured config authority`,
  };
  return hook(ToolTask, {
    async beforeTool(call: ToolHookCall, api, context) {
      if (ungated.has(call.name)) return undefined;
      if (delegatedTools?.(call.name) === true) return undefined;
      const chat = isAuthenticatedChat(api.conversationId);
      if (chat) {
        if (!allowed.has(call.name)) return { block: `Tool ${call.name} is outside the host tool ceiling` };
        return undefined;
      }
      if (capturedCeiling === undefined) {
        return { block: `Tool ${call.name} is not enabled for this conversation` };
      }
      const targetCeiling = capturedCeiling(api.conversationId);
      if (targetCeiling.length === 0) return { block: `Tool ${call.name} is not enabled for this conversation` };
      if (!targetCeiling.includes(call.name)) return { block: `Tool ${call.name} is outside the host tool ceiling` };
      const verdict = await verifyCapturedTool(
        () => api.snapshot(ConfigToolCaptureDoc, api.conversationId, context), call.name, isAuthenticatedChat,
      );
      return verdict.ok ? undefined : { block: refusals[verdict.reason](call.name) };
    },
  });
}
