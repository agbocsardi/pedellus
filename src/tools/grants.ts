import {
  ToolTask,
  defineDoc,
  hook,
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
 */
export function createToolGrantHook(
  ceiling: readonly string[],
  now: () => number,
): HookRegistration {
  const allowed = new Set(ceiling);
  return hook(ToolTask, {
    async beforeTool(call: ToolHookCall, api, context) {
      if (!allowed.has(call.name)) {
        return { block: `Tool ${call.name} is outside the host tool ceiling` };
      }
      const document = await api.snapshot(ToolGrantDoc, api.conversationId, context);
      const expiresAt = document?.grants[call.name];
      if (expiresAt === undefined) {
        return { block: `Tool ${call.name} has no grant for this conversation` };
      }
      if (!Number.isSafeInteger(expiresAt)) {
        return { block: `Tool ${call.name} has a malformed grant` };
      }
      if (expiresAt <= now()) {
        return { block: `Tool ${call.name} grant expired at ${new Date(expiresAt).toISOString()}` };
      }
      return undefined;
    },
  });
}
