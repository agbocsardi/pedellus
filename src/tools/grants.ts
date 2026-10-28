import {
  ToolTask,
  defineDoc,
  hook,
  type ConversationId,
  type HookRegistration,
  type ToolHookCall,
} from "@earendil-works/pi-durable";

/** One conversation-scoped, expiring grant for a tool name in the host ceiling. */
export interface GatewayToolGrant {
  readonly name: string;
  readonly expiresAt: number;
}

export type ToolGrantDocument = {
  /** Tool name to epoch-millisecond expiry. A name absent from this map is not granted. */
  readonly grants: Record<string, number>;
};

/**
 * Latest-only conversation document. A fork starts empty (`fork: "initial"`), so a forked conversation
 * is default-deny even when the copied agent state still names its parent's tools.
 */
export const ToolGrantDoc = defineDoc<ToolGrantDocument>({
  kind: "nanobot.tool-grants",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ grants: {} }),
  checkpointWhen: () => true,
});

/**
 * The origin conversation whose grants bound a scheduled background run's copied grants.
 *
 * The document is written only by cron `prepare`, in the same commit that copies the grants, so its
 * presence marks a conversation holding a copy rather than authority of its own. A copied grant is a
 * ceiling on what the run was allowed when it was prepared, never a replacement for the origin:
 * the grant hook intersects it with the origin's current grant at call time. `0` (the initial value)
 * is not a conversation and blocks every effectful call, so a malformed link fails closed.
 */
export type ToolGrantOriginDocument = {
  readonly originConversationId: number;
};
export const ToolGrantOriginDoc = defineDoc<ToolGrantOriginDocument>({
  kind: "nanobot.tool-grant-origin",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ originConversationId: 0 }),
  checkpointWhen: () => true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validExpiry(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > now;
}

/**
 * Validate a host-supplied grant request. Every grant must name a tool in the current host ceiling
 * and carry a future integer epoch-millisecond expiry; there is no default or indefinite grant.
 */
export function normalizeToolGrants(
  value: unknown,
  ceiling: readonly string[],
  now: number,
): GatewayToolGrant[] {
  if (!Array.isArray(value)) throw new TypeError("Tool grants must be an array");
  const names = new Set<string>();
  const grants: GatewayToolGrant[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new TypeError(`Tool grant ${index} must be an object`);
    const { name, expiresAt } = entry;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`Tool grant ${index} requires a non-empty tool name`);
    }
    if (!ceiling.includes(name)) {
      throw new Error(`Tool ${name} is outside the host tool ceiling`);
    }
    if (names.has(name)) throw new Error(`Duplicate tool grant for ${name}`);
    if (!validExpiry(expiresAt, now)) {
      throw new TypeError(`Tool grant for ${name} requires a future integer expiresAt (epoch milliseconds)`);
    }
    names.add(name);
    grants.push({ name, expiresAt });
  }
  return grants;
}

/** Active grants in host-ceiling order, without changing the document. */
export function activeToolGrants(
  document: Readonly<ToolGrantDocument>,
  ceiling: readonly string[],
  now: number,
): GatewayToolGrant[] {
  const grants: GatewayToolGrant[] = [];
  for (const name of ceiling) {
    const expiresAt = document.grants[name];
    if (validExpiry(expiresAt, now)) grants.push({ name, expiresAt });
  }
  return grants;
}

/**
 * Remove expired, malformed and out-of-ceiling entries from a draft grant document, returning the
 * active names in host-ceiling order. Removal is persisted by the caller's commit, so a revoked or
 * expired grant cannot come back on a later reopen even if the wall clock moves backwards.
 */
export function pruneToolGrants(
  document: ToolGrantDocument,
  ceiling: readonly string[],
  now: number,
): string[] {
  const allowed = new Set(ceiling);
  const active: string[] = [];
  for (const [name, expiresAt] of Object.entries(document.grants)) {
    if (allowed.has(name) && validExpiry(expiresAt, now)) active.push(name);
    else delete document.grants[name];
  }
  const ordered = new Set(active);
  return ceiling.filter((name) => ordered.has(name));
}

/**
 * Last-line policy check before a call records intent. Native recovery reruns only tools that are
 * still resolved for the conversation, so reopening also rechecks grants by pruning them before
 * `resume()`; this hook catches expiry between reopen and the call.
 *
 * `contextTools` names non-effectful context tools (such as the read-only skill loader). They are
 * exempt from the grant document and the ceiling because they cannot change state; everything else
 * still needs an explicit unexpired grant.
 */
export function createToolGrantHook(
  ceiling: readonly string[],
  now: () => number,
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
      try {
        const document = await api.snapshot(ToolGrantDoc, api.conversationId, context);
        const expiresAt = document?.grants[call.name];
        if (expiresAt === undefined) {
          return { block: `Tool ${call.name} has no grant for this conversation` };
        }
        if (!Number.isSafeInteger(expiresAt)) {
          return { block: `Tool ${call.name} has a malformed grant` };
        }
        const timestamp = now();
        if (expiresAt <= timestamp) {
          return { block: `Tool ${call.name} grant expired at ${new Date(expiresAt).toISOString()}` };
        }
        // A scheduled background run's grant document is a copy. The copy stays capped by its own
        // expiry, and the origin's current grant must still cover the name: revoking or expiring it
        // at the origin takes effect here, and a later origin grant cannot widen this run.
        const link = await api.snapshot(ToolGrantOriginDoc, api.conversationId, context);
        if (link === undefined) return undefined;
        const originId = link.originConversationId;
        if (!Number.isSafeInteger(originId) || originId < 1) {
          return { block: `Tool ${call.name} grant has an invalid origin link; refusing the call` };
        }
        const origin = await api.snapshot(ToolGrantDoc, originId as ConversationId, context);
        const originExpiresAt = origin?.grants[call.name];
        if (originExpiresAt === undefined) {
          return { block: `Tool ${call.name} grant was revoked at its origin conversation` };
        }
        if (!Number.isSafeInteger(originExpiresAt)) {
          return { block: `Tool ${call.name} grant has a malformed origin grant` };
        }
        if (originExpiresAt <= timestamp) {
          return { block: `Tool ${call.name} origin grant expired at ${new Date(originExpiresAt).toISOString()}` };
        }
        return undefined;
      } catch {
        // Durable treats a throwing hook as a block, but a rejected hook must never read as allowed.
        // Keep the model-visible reason generic: storage errors can carry paths or internal detail.
        return { block: `Tool ${call.name} grant state could not be read; refusing the call` };
      }
    },
  });
}
