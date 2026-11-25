/**
 * Shared contracts of every owner chat channel (Telegram, Discord, the app) and the terminal.
 *
 * This module holds what is identical across channels: the host surface a channel may probe, the
 * restart controller, the single-host late-binding registry and the read-only status projection.
 * Channel-specific authentication, external-send fencing and wire formats stay in each channel.
 */

import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type UsageState,
} from "@earendil-works/pi-durable";
import { copyJson } from "@earendil-works/chord";
import type { CronDeliveryOutbox } from "../automation/cron-delivery.js";
import type { BackgroundStatus } from "../background-status.js";
import { conversationCommandNames, type ConversationSurface } from "../help/commands.js";
import type { OwnerInputContent } from "../history/idle-rollover.js";
import type { McpSurfaceRegistry } from "../mcp/surface.js";
import type { AskSurfaceRegistry } from "../questions/surface.js";
import type {
  GatewayMcpAdmin,
  GatewayMemoryDigest,
  GatewayModelList,
  GatewayModelSelection,
  GatewaySessionReset,
} from "../runtime.js";

/** What one channel calls the place an owner talks in, for host-generated notice wording. */
export type ChannelScopeNoun = "chat" | "channel" | "thread";

/**
 * The host surface every owner channel shares. Only `conversationFor` is required: a narrow SDK host
 * omits the rest, and a channel probes each optional operation once (see
 * {@link detectHostCapabilities}) so it neither advertises nor applies what the host cannot do.
 * Channel-specific registries (Telegram actions, Discord history, the app console) extend this.
 */
export interface ChannelGateway {
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /** Decides a prepared idle rollover just before an owner input is submitted; absent means none. */
  beforeOwnerInput?(
    sessionKey: string,
    conversationId: ConversationId,
    content: OwnerInputContent,
    context: Context,
  ): Promise<void>;
  /** Host-authenticated durable outbox for completed cron results and host interruption notices. */
  cronOutbox?: CronDeliveryOutbox;
  /** Host model catalog of one mapped session; creates nothing and changes nothing. */
  listModels?(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /** One configured preset name or `default`; rejects atomically (including `ConversationBusy`). */
  selectModelPreset?(sessionKey: string, name: string, context: Context): Promise<GatewayModelSelection>;
  /** Paired native reset and prompt-snapshot rebuild; `busy` means nothing changed. */
  resetSession?(sessionKey: string, context: Context): Promise<GatewaySessionReset>;
  /** Bounded background snapshot of one session; a failed read makes no claim about work. */
  backgroundStatus?(sessionKey: string, context: Context): Promise<BackgroundStatus>;
  /** Manual memory-digestion entry for `digest` and `digest status`. */
  memoryDigest?: GatewayMemoryDigest;
  /** MCP status and callback host surface; present only with an on-disk configuration. */
  mcpAdmin?: GatewayMcpAdmin;
  /** Live owner surfaces for MCP login delivery; the running adapter attaches here. */
  mcpSurfaces?: McpSurfaceRegistry;
  /** Live owner-question surfaces for `ask_user`; the running adapter attaches here. */
  askSurfaces?: AskSurfaceRegistry;
}

/**
 * Host-owned full-process restart for the authenticated-owner `restart` control. The host performs
 * the replacement only after its own graceful teardown; a channel confirms the request, never the
 * restart, and never retries it.
 */
export interface HostRestartController {
  /** Whether this host can actually replace its own process and configuration. */
  readonly supported: boolean;
  /** Fixed host-owned refusal used when `supported` is false; never user, model or provider input. */
  readonly unavailable?: string;
  /** Called at most once per accepted request, only after its acknowledgement is durable. */
  request(): Promise<void>;
}

/** Which optional host operations a channel may advertise and apply, resolved once at start. */
export interface HostCapabilities {
  /** `status` names the selected model, so it needs the host catalog. */
  readonly status: boolean;
  /** `model` needs the catalog and preset selection. */
  readonly model: boolean;
  readonly restart: boolean;
  readonly digest: boolean;
  readonly mcp: boolean;
  /** Stale host notices need the outbox's list and update. */
  readonly notices: boolean;
  /** A paired reset is available; without it `new` is the plain native reset. */
  readonly resetSession: boolean;
  readonly backgroundStatus: boolean;
}

/** Probe the optional host surface once, so every channel decides availability identically. */
export function detectHostCapabilities(
  gateway: ChannelGateway,
  restart?: Pick<HostRestartController, "supported">,
): HostCapabilities {
  const listModels = typeof gateway.listModels === "function";
  return {
    status: listModels,
    model: listModels && typeof gateway.selectModelPreset === "function",
    restart: restart?.supported === true,
    digest: typeof gateway.memoryDigest?.start === "function" && typeof gateway.memoryDigest?.status === "function",
    mcp: typeof gateway.mcpAdmin?.list === "function" && typeof gateway.mcpAdmin?.submitCallback === "function",
    notices: typeof gateway.cronOutbox?.list === "function" && typeof gateway.cronOutbox?.update === "function",
    resetSession: typeof gateway.resetSession === "function",
    backgroundStatus: typeof gateway.backgroundStatus === "function",
  };
}

/**
 * The catalogued commands of one chat surface this host really implements, in catalogue order.
 * `new`, `abort`, `stop` and `help` need no optional host operation; the catalogue itself decides
 * which names a surface has at all (for example only Telegram has `notices`).
 */
export function offeredChannelCommandNames(
  surface: Exclude<ConversationSurface, "cli">,
  capabilities: HostCapabilities,
): readonly string[] {
  const offered: Readonly<Record<string, boolean>> = {
    new: true,
    abort: true,
    stop: true,
    help: true,
    status: capabilities.status,
    model: capabilities.model,
    restart: capabilities.restart,
    digest: capabilities.digest,
    mcp: capabilities.mcp,
    notices: capabilities.notices,
  };
  return conversationCommandNames(surface).filter((name) => offered[name] === true);
}

/**
 * One live host per process, attached by the running adapter and detached when it stops. Each
 * attachment is independent: detaching is idempotent and removes exactly that attachment, so a
 * stale detach can never remove or resurrect another adapter's host.
 */
export interface SingleHostRegistry<T> {
  /** Make `host` current; the returned function detaches exactly this attachment. */
  attach(host: T): () => void;
  /** The most recently attached host that is still attached, or `undefined`. */
  current(): T | undefined;
}

export function createSingleHostRegistry<T>(): SingleHostRegistry<T> {
  // Attachment tokens, oldest first: the same host attached twice is two entries.
  const attached: { readonly host: T }[] = [];
  return {
    attach(host) {
      const entry = { host };
      attached.push(entry);
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const index = attached.indexOf(entry);
        if (index >= 0) attached.splice(index, 1);
      };
    },
    current() {
      return attached.at(-1)?.host;
    },
  };
}

/** Point-in-time status of one conversation, already bounded for presentation. */
export interface ConversationStatus {
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly run?: { readonly taskId: number; readonly inputs: number; readonly attempt?: number };
  readonly inbox: {
    readonly total: number;
    readonly steer: number;
    readonly followUp: number;
    readonly write: number;
    readonly scanned: number;
  };
  readonly tools: {
    readonly total: number;
    readonly running: number;
    readonly pending: number;
    readonly scanned: number;
  };
  readonly compactions: number;
  /** The conversation's own recorded spend; an empty ledger means nothing was recorded yet. */
  readonly usage?: UsageState;
  /**
   * Host-read, bounded background activity. Absent leaves the core status unchanged: an older host
   * adds no field and a failing read omits it rather than claiming idle.
   */
  readonly background?: BackgroundStatus;
}

export const CONVERSATION_STATUS_LIMITS = Object.freeze({
  /** Queue and tool entries whose mode/status is counted; the totals stay exact. */
  statusQueueScan: 2_000,
});

/**
 * Project one conversation's status from a single read transaction over its native documents
 * (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`). No watch is opened, no model is called and
 * nothing is written; the projection is copied out of the transaction, so no draft escapes.
 */
export async function projectConversationStatus(
  conversation: Pick<Conversation, "id" | "commit">,
  context: Context,
): Promise<ConversationStatus> {
  return conversation.commit(async (tx) => {
    const agent = await tx.doc(AgentDoc, conversation.id);
    const live = await tx.doc(LiveDoc, conversation.id);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const usage = await tx.doc(UsageDoc, conversation.id);
    const limit = CONVERSATION_STATUS_LIMITS.statusQueueScan;
    const queued = inbox.items;
    const modeCounts = { steer: 0, followUp: 0, write: 0 };
    const scanned = Math.min(queued.length, limit);
    for (let index = 0; index < scanned; index++) {
      const mode = queued[index]!.mode;
      if (mode === "steer" || mode === "followUp" || mode === "write") modeCounts[mode]++;
    }
    const tools = live.tools ?? [];
    const toolsScanned = Math.min(tools.length, limit);
    let running = 0;
    let pending = 0;
    for (let index = 0; index < toolsScanned; index++) {
      const status = tools[index]!.status;
      if (status === "running") running++;
      else if (status === "pending") pending++;
    }
    const model = agent.model;
    const run = live.run;
    const attempt = live.generation?.attempt;
    return {
      ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
      ...(run === undefined
        ? {}
        : { run: { taskId: run.taskId, inputs: run.inputs.length, ...(attempt === undefined ? {} : { attempt }) } }),
      inbox: { total: queued.length, scanned, ...modeCounts },
      tools: { total: tools.length, scanned: toolsScanned, running, pending },
      compactions: live.compactions?.length ?? 0,
      usage: copyJson(usage) as unknown as UsageState,
    };
  }, context);
}
