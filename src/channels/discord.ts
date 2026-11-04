/**
 * The Discord channel adapter.
 *
 * It is an owner chat surface over the one running gateway, next to Telegram and the local CLI. It
 * owns Discord ingress admission, the durable channel outbox for admitted inputs and host notices,
 * the shared owner commands, scheduled-result and interruption-notice delivery, typing/receipt
 * feedback and the MCP owner surface for a mapped Discord chat. It never opens a second runtime,
 * never grants a tool and never widens another channel's authority.
 *
 * Authority is the host's, not this file's:
 * - ingress is admitted only for an explicitly allowlisted sender, in an allowlisted channel (or
 *   its parent thread channel) or an allowed direct message, and — in a guild — only when this bot
 *   is mentioned or the message replies to this bot, unless the guild policy is `open`;
 * - the session key is derived here from that authenticated evidence, never from model or user
 *   input, and the gateway re-validates it as an ordinary mapped chat;
 * - scheduled results and interruption notices are delivered only for a channel that has durable
 *   admission evidence for this bot and whose original sender is still allowlisted;
 * - model-facing coding tools and every other channel capability are unchanged: this adapter
 *   offers no tool.
 *
 * Delivery is at-most-once with an honest unknown: a write-ahead intent is committed before every
 * external send, a proven refusal is retried or held, and an ambiguous outcome is quarantined and
 * never resent. Durable input dedupe uses the message/​interaction snowflake as a request ID, so a
 * repeated Gateway event cannot become a second turn.
 */
import { defineDoc, AssistantEntry, ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, Submission, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { FollowUpMode } from "../config.js";
import type { CronDeliveryOutbox, CronDeliveryRecord } from "../automation/cron-delivery.js";
import { CronDeliveryOutboxError } from "../automation/cron-delivery.js";
import { originOccurrencePending } from "../automation/cron.js";
import {
  conversationCommandNames,
  conversationCommandRefusal,
  conversationCommandUsage,
  conversationDetailBlock,
  conversationHelpListing,
  findConversationCommand,
  offeredConversationCommands,
} from "../help/commands.js";
import { renderMemoryDigestStart, renderMemoryDigestStatus } from "../history/memory-digest.js";
import { renderMcpListing } from "../mcp/admin.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import type {
  GatewayMcpAdmin,
  GatewayMemoryDigest,
  GatewayModelList,
  GatewayModelSelection,
  GatewaySessionReset,
} from "../runtime.js";
import { inProcessTerminalConversation } from "../terminal/conversation.js";
import { renderBackgroundStatus, type BackgroundStatus } from "../background-status.js";
import { RESTART_BUSY_MESSAGE, RestartBusyError } from "../restart.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import {
  MEDIA_LIMITS,
  MediaRejected,
  createMediaStore,
  type MediaKind,
  type MediaStore,
} from "../media/attachments.js";
import {
  DISCORD_LIMITS,
  boundedDiscordLabel,
  classifyDiscordError,
  discordAttachmentText,
  discordQuotedContext,
  discordSpeakerLabel,
  isGoneError,
  isSnowflake,
  looksLikeDiscordCommand,
  resolveDiscordMentions,
  splitDiscordText,
  type DiscordCommandSpec,
  type DiscordInboundAttachment,
  type DiscordInboundMessage,
  type DiscordInteraction,
  type DiscordInteractionResponse,
  type DiscordSendResult,
  type DiscordTransport,
} from "./discord-transport.js";

const MAX_ADMITTED = DISCORD_LIMITS.maxPending;
/** How long a command acknowledgement waits for its native call before reporting that it is still pending. */
const CONTROL_PENDING_NOTICE_MS = 30_000;
/** Unresolved commands kept at most; further commands are refused so a hung command cannot grow the log. */
const MAX_UNRESOLVED_CONTROLS = DISCORD_LIMITS.maxControls;
/** Bounded retries for a command whose earlier ordered inputs keep failing transiently. */
const MAX_CONTROL_ATTEMPTS = 10;
const MAX_NOTICE_CHARS = 1_500;
const MAX_LATE_CONTROL_CHARS = 4_000;
/** Chats that may be owed a restart confirmation, one message per requesting chat. */
const MAX_RESTART_CONFIRMATIONS = 8;
/** Diagnostic text bound for one host notice; no user or model text is copied. */
const MAX_RECEIPT_EMOJI_CHARS = 32;

/**
 * Attachment ingress for this adapter. Originals live under the configured workspace and stay
 * readable through the ordinary coding-tool policy; nothing is written to `dataDir` or an external
 * root. Discord's CDN URL is used once, at admission, and never persisted.
 */
export type DiscordMediaOptions = {
  readonly workspace: string;
  /** Workspace-relative directory; default `media`. */
  readonly directory?: string;
};

/**
 * Host-owned full-process restart for the authenticated-owner `/restart` control. The host performs
 * the replacement only after its own graceful teardown; the adapter confirms the request, never the
 * restart, and never retries it.
 */
export type DiscordRestartHost = {
  readonly supported: boolean;
  /** Fixed host-owned refusal used when `supported` is false; never user, model or provider input. */
  readonly unavailable?: string;
  /** Called at most once, only after this command's acknowledgement is durable. */
  request(): Promise<void>;
};

/** Best-effort read/working reactions painted on the admitted message and removed after the answer. */
export type DiscordReceiptOptions = {
  /** Default `👀`; `false` disables the receipt. */
  readonly read?: string | false;
  /** Default `🔧`; `false` disables the delayed working indicator. */
  readonly working?: string | false;
  /** Delay before the working indicator; default 2,000 ms. */
  readonly delayMs?: number;
};

export type DiscordOptions = {
  /** Explicit user snowflakes; a message from anyone else is ignored. A wildcard is refused. */
  readonly allowFrom: readonly string[];
  /**
   * Direct messages are governed by `allowFrom` alone unless this is set. When set, it is the sole
   * authority for DMs and can only narrow: the sender must pass both lists.
   */
  readonly dmAllowFrom?: readonly string[];
  /** Channel or thread IDs this bot may answer in; empty means every channel the bot can read. */
  readonly allowChannels?: readonly string[];
  /** `mention` (default) requires a mention or a reply to this bot; `open` answers every message. */
  readonly groupPolicy?: "mention" | "open";
  /**
   * Configured owner busy-mode, persisted on each admitted message so recovery and a later config
   * change cannot alter an already admitted message's semantics. Absent keeps follow-up queueing.
   */
  readonly followUpMode?: FollowUpMode;
  /** Absent keeps the attachment-disabled behavior for SDK callers. */
  readonly media?: DiscordMediaOptions;
  /** Absent means `/restart` is neither advertised nor applied in this host. */
  readonly restart?: DiscordRestartHost;
  /** Read/working feedback; absent keeps the defaults, `false` disables one. */
  readonly receipts?: DiscordReceiptOptions;
  /** Progressive single-message edits while a turn runs; default true. */
  readonly streaming?: boolean;
};

export type DiscordPendingAttachment = {
  readonly attachmentId: string;
  readonly kind: MediaKind;
  readonly originalName: string;
  readonly contentType?: string;
  readonly status: "stored" | "failed";
  readonly relativePath?: string;
  readonly bytes?: number;
  /** Fixed reason for a failed store; never transport or filesystem text. */
  readonly note?: string;
};

/**
 * One durably admitted item: an owner input, a host notice, or a command acknowledgement. `key` is
 * `m:<messageId>` for a message, `i:<interactionId>` for an application command, or a host-owned
 * `restart:`/`unconfirmed:` key for a notice this adapter generates.
 */
export type DiscordPendingDelivery = {
  key: string;
  channelId: string;
  sessionKey: string;
  senderId: string;
  text: string;
  admittedAtMs: number;
  nextChunkIndex: number;
  lastText?: string;
  /** The one message this turn owns: a preview that the final answer edits, or the first chunk. */
  sentMessageId?: string;
  /** `unknown`: an ambiguous external outcome. `failed`: a known rejection, held for inspection. */
  deliveryStatus?: "sending" | "unknown" | "failed";
  /**
   * Written before one external request leaves and cleared only with its result. An intent left by a
   * crash is ambiguous: a reopen quarantines the record and never resends it.
   */
  sendIntent?: {
    text: string;
    stage: "preview" | "final";
    /** Final chunk this request would deliver; absent for a preview edit. */
    chunkIndex?: number;
    startedAt: number;
  };
  unknownSince?: number;
  /** A command acknowledgement: delivered as fixed text, never submitted to the model. */
  notice?: boolean;
  /** The acknowledgement is withheld until the command's native call returns or reports that it is still pending. */
  hold?: boolean;
  /** The busy-mode this message was admitted under; absent is the historical follow-up queueing. */
  whenBusy?: "steer";
  /** Admitted attachments, stored before the model saw anything. */
  attachments?: DiscordPendingAttachment[];
  /** The inbound message this answer references once, without pinging its author. */
  replyToMessageId?: string;
};

/**
 * One authenticated control command. `admitted` is committed with its acknowledgement before the
 * native call; `applied` and `refused` after it returns; `unconfirmed` when a reopen found it
 * interrupted and reported that instead of replaying it.
 */
export type DiscordControlRecord = {
  key: string;
  command: string;
  status: "admitted" | "applied" | "refused" | "unconfirmed";
  channelId: string;
  senderId: string;
};

export type DiscordRestartRecord = { channelId: string; senderId: string };

/** Durable authenticated sender-to-channel evidence, re-checked before every later delivery. */
export type DiscordOriginBinding = {
  botId: string;
  senderId: string;
  kind: "channel" | "thread" | "dm";
  parentChannelId?: string;
  admittedAtMs: number;
};

export type DiscordChannelState = {
  /** Bounded recent admitted identities, so a repeated Gateway event is not a second turn. */
  admitted: string[];
  pending: DiscordPendingDelivery[];
  controls: DiscordControlRecord[];
  restart?: DiscordRestartRecord[];
  origins: Record<string, DiscordOriginBinding>;
};

// Stored alongside the adapter's stable channel conversation, not in a plaintext sidecar.
export const DiscordState = defineDoc<DiscordChannelState>({
  kind: "nanobot.discord-state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  initial: () => ({ admitted: [], pending: [], controls: [], origins: {} }),
});

export interface DiscordGateway {
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /**
   * Host-authenticated durable outbox for completed background cron results and host interruption
   * notices. Optional so a host that only does inbound replies stays usable; absent means neither
   * is delivered.
   */
  cronOutbox?: CronDeliveryOutbox;
  /** Late-bound live owner surface for MCP login delivery; attached while this adapter runs. */
  mcpSurfaces?: import("../mcp/surface.js").McpSurfaceRegistry;
  /** MCP status/callback host surface; present only when the gateway loaded an on-disk configuration. */
  mcpAdmin?: GatewayMcpAdmin;
  /** Manual memory-digestion entry for `/digest` and `/digest status`. */
  memoryDigest?: GatewayMemoryDigest;
  listModels?(sessionKey: string, context: Context): Promise<GatewayModelList>;
  selectModelPreset?(sessionKey: string, name: string, context: Context): Promise<GatewayModelSelection>;
  resetSession?(sessionKey: string, context: Context): Promise<GatewaySessionReset>;
  backgroundStatus?(sessionKey: string, context: Context): Promise<BackgroundStatus>;
}

type SubmissionSlot = { readonly prior: Promise<void>; release(): void };
/** A committed answer that identifies the inputs one run consumed. */
type SharedAnswer = { readonly answer: number };
/** `owner` sends the one shared reply, `sibling` stays silent behind it, `retired` is already gone. */
type DeliveryRole = "owner" | "sibling" | "retired";
type ChannelState = DiscordChannelState;

type TypingLoop = {
  turns: number;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
};

type Receipt = {
  channelId: string;
  messageId: string;
  emojis: string[];
  workingTimer: ReturnType<typeof setTimeout> | undefined;
};

/** The run's first input: it identifies the run across tool rounds, which only ever append inputs. */
function firstInput(inputs: readonly SubmissionId[]): SubmissionId | undefined {
  let first = inputs[0];
  for (const id of inputs) if (first === undefined || id < first) first = id;
  return first;
}

/** Whether this settled submission is one of the inputs the run with this committed answer consumed. */
function answeredTogether(record: SubmissionRecord, settlement: SharedAnswer): boolean {
  return record.type === "input" && record.status === "done" && record.answer === settlement.answer;
}

export async function runDiscord(
  gateway: DiscordGateway,
  transport: DiscordTransport,
  options: DiscordOptions,
  context: Context,
): Promise<void> {
  validateOptions(options);
  const mediaStore = createMediaStoreFor(options.media);
  const mediaWork = new MediaWorkGate(MEDIA_LIMITS.maxConcurrentWork);
  /**
   * Optional host operations this adapter may call, resolved once from the host surface. A narrow SDK
   * host keeps `/new`, `/abort` (and `/stop`) and `/help` only; the rest are neither advertised nor
   * applied, and typing one gets a truthful refusal instead of a half-working control.
   */
  const hostCommands = {
    status: typeof gateway.listModels === "function",
    model: typeof gateway.listModels === "function" && typeof gateway.selectModelPreset === "function",
    restart: options.restart !== undefined && options.restart.supported,
    digest: typeof gateway.memoryDigest?.start === "function" && typeof gateway.memoryDigest?.status === "function",
    mcp: typeof gateway.mcpAdmin?.list === "function" && typeof gateway.mcpAdmin?.submitCallback === "function",
  };
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const cleanupContext = withoutAbortSignal(adapterContext);
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;

  await transport.start(adapterContext);
  const identity = transport.botId;
  if (!isSnowflake(identity)) {
    await transport.stop().catch(() => undefined);
    throw new Error("Discord transport connected without a valid bot identity");
  }
  const stateConversation = await gateway.conversationFor(
    `discord:${identity}${CHANNEL_STATE_SESSION_SUFFIX}`,
    context,
  );
  const admittedWhenBusy = options.followUpMode === "steer" ? "steer" as const : undefined;
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(DiscordState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  let activeReplies = 0;
  let activeNotices = 0;
  const delivering = new Set<string>();
  const failedThisCycle = new Set<string>();
  /** Channels whose control command is still being applied: their later inputs are held. */
  const controlPending = new Set<string>();
  const deferredControls = new Map<string, DeferredControl>();
  const controlFailures = new Map<string, number>();
  /** Submissions a control flush already placed, so the normal delivery path reuses that exact turn. */
  const earlySubmissions = new Map<string, Submission>();
  const controlChains = new Map<string, Promise<void>>();
  const submissionChains = new Map<string, Promise<void>>();
  const pendingControls = new Set<Promise<void>>();
  const typingLoops = new Map<string, TypingLoop>();
  const receipts = new Map<string, Receipt>();
  const deliveryFailures = new Map<string, number>();
  let restartHostRequested = false;
  let restartHostRequestFailed = false;
  let fatal: unknown;
  let stopping = false;
  /** Ingress handlers wait for recovery so an early Gateway event is neither lost nor reordered. */
  const ready = deferred<void>();

  /**
   * Reserve one channel's next submission place when the delivery is dispatched, before any
   * asynchronous preparation, so admission order never depends on how long a lookup takes.
   */
  const beginSubmission = (channelId: string): SubmissionSlot => {
    const prior = submissionChains.get(channelId) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    submissionChains.set(channelId, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (submissionChains.get(channelId) === tail) submissionChains.delete(channelId);
      },
    };
  };

  const submitInOrder = async <T>(channelId: string, work: () => Promise<T>): Promise<T> => {
    const slot = beginSubmission(channelId);
    try {
      await slot.prior;
      return await work();
    } finally {
      slot.release();
    }
  };

  const outbox = gateway.cronOutbox;
  const scheduledActive = new Set<string>();
  const scheduledChannelActive = new Set<string>();
  const scheduledTasks = new Set<Promise<void>>();
  let scheduledScanning = false;
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryComplete = false;

  // ── State helpers ─────────────────────────────────────────────────────────

  const mutateState = async (
    change: (doc: Draft<ChannelState>) => void,
    commitContext: Context = adapterContext,
  ): Promise<ChannelState> => {
    const next = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(DiscordState, stateConversation.id);
      change(doc);
      return copyJson(doc) as unknown as ChannelState;
    }, commitContext);
    state = next;
    return next;
  };

  const rememberOrigin = async (
    channelId: string,
    senderId: string,
    kind: DiscordOriginBinding["kind"],
    parentChannelId: string | undefined,
  ): Promise<{ readonly trusted: boolean; readonly evictedSessionKey: string | null }> => {
    let trusted = false;
    let evictedSessionKey: string | null = null;
    await mutateState((doc) => {
      const existing = doc.origins[channelId];
      trusted = existing !== undefined && existing.botId === identity && existing.senderId === senderId;
      const next: DiscordOriginBinding = {
        botId: identity,
        senderId,
        kind,
        admittedAtMs: Date.now(),
        ...(parentChannelId === undefined ? {} : { parentChannelId }),
      };
      doc.origins[channelId] = next;
      const keys = Object.keys(doc.origins);
      if (keys.length <= DISCORD_LIMITS.maxOrigins) return;
      const removable = keys
        .filter((key) => key !== channelId)
        .sort((left, right) => (doc.origins[left]?.admittedAtMs ?? 0) - (doc.origins[right]?.admittedAtMs ?? 0));
      const drop = removable.slice(0, keys.length - DISCORD_LIMITS.maxOrigins);
      const first = drop[0];
      evictedSessionKey = first === undefined ? null : sessionKeyForBinding(doc.origins[first], first);
      for (const key of drop) delete doc.origins[key];
    });
    return { trusted, evictedSessionKey };
  };

  const mutatePending = async (key: string, change: (item: Draft<DiscordPendingDelivery>) => void) => {
    await mutateState((doc) => {
      const item = doc.pending.find((entry) => entry.key === key);
      if (item !== undefined) change(item);
    }, cleanupContext);
  };

  const forget = async (key: string) => {
    deliveryFailures.delete(key);
    earlySubmissions.delete(key);
    await mutateState((doc) => {
      doc.pending = doc.pending.filter((entry) => entry.key !== key);
      doc.controls = doc.controls.filter((entry) =>
        !((entry.key === key || `unconfirmed:${entry.key}` === key) &&
          (entry.status === "unconfirmed" || entry.status === "refused")));
    }, cleanupContext);
  };

  // ── Feedback (typing, read receipt, working indicator) ────────────────────

  const readEmoji = options.receipts?.read === undefined
    ? "👀"
    : options.receipts.read === false ? undefined : boundedEmoji(options.receipts.read);
  const workingEmoji = options.receipts?.working === undefined
    ? "🔧"
    : options.receipts.working === false ? undefined : boundedEmoji(options.receipts.working);
  const workingDelayMs = Math.max(0, Math.min(10_000, options.receipts?.delayMs ?? 2_000));

  /**
   * Start or join one channel's typing loop. The returned release belongs to this one turn and is
   * idempotent, so overlapping queued turns keep the indicator alive until the last of them settles.
   */
  const startTyping = (channelId: string): (() => void) => {
    let loop = typingLoops.get(channelId);
    if (loop === undefined) {
      loop = { turns: 0, stopped: false, timer: undefined };
      typingLoops.set(channelId, loop);
      const created = loop;
      const refresh = () => {
        if (created.stopped || stopping || signal?.aborted) return;
        void transport.typing(channelId).catch(() => undefined);
      };
      refresh();
      created.timer = setInterval(refresh, DISCORD_LIMITS.typingRefreshMs);
      created.timer.unref?.();
    }
    const owned = loop;
    owned.turns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      owned.turns -= 1;
      if (owned.turns > 0) return;
      owned.stopped = true;
      if (owned.timer !== undefined) clearInterval(owned.timer);
      if (typingLoops.get(channelId) === owned) typingLoops.delete(channelId);
    };
  };

  const stopAllTyping = (): void => {
    for (const [channelId, loop] of typingLoops) {
      loop.stopped = true;
      if (loop.timer !== undefined) clearInterval(loop.timer);
      typingLoops.delete(channelId);
    }
  };

  /** Best effort: a rejected receipt is cosmetic and never fails an admission or an answer. */
  const markReading = (channelId: string, messageId: string): void => {
    if (readEmoji === undefined && workingEmoji === undefined) return;
    const previous = receipts.get(channelId);
    if (previous !== undefined && previous.messageId !== messageId) void clearReceipt(previous);
    const receipt: Receipt = {
      channelId,
      messageId,
      emojis: readEmoji === undefined ? [] : [readEmoji],
      workingTimer: undefined,
    };
    if (readEmoji !== undefined) {
      void transport.addReaction(channelId, messageId, readEmoji).catch(() => undefined);
    }
    if (workingEmoji !== undefined) {
      receipt.emojis.push(workingEmoji);
      receipt.workingTimer = setTimeout(() => {
        receipt.workingTimer = undefined;
        if (receipts.get(channelId) !== receipt || stopping || signal?.aborted) return;
        void transport.addReaction(channelId, messageId, workingEmoji).catch(() => undefined);
      }, workingDelayMs);
      receipt.workingTimer.unref?.();
    }
    receipts.set(channelId, receipt);
  };

  const clearReceipt = async (receipt: Receipt): Promise<void> => {
    if (receipt.workingTimer !== undefined) clearTimeout(receipt.workingTimer);
    receipt.workingTimer = undefined;
    if (receipts.get(receipt.channelId) === receipt) receipts.delete(receipt.channelId);
    for (const emoji of receipt.emojis) {
      await transport.removeReaction(receipt.channelId, receipt.messageId, emoji).catch(() => undefined);
    }
  };

  /**
   * Clear the receipt this delivery painted. A newer admitted message in the same channel owns its
   * own receipt, so an earlier turn's completion must not remove the indicator that later one shows.
   */
  const settleFeedback = async (channelId: string, admittedMessageId: string | undefined): Promise<void> => {
    const receipt = receipts.get(channelId);
    if (receipt === undefined) return;
    if (admittedMessageId !== undefined && receipt.messageId !== admittedMessageId) return;
    if (receipt.workingTimer !== undefined) {
      // A working indicator that has not fired yet must not fire after the answer.
      clearTimeout(receipt.workingTimer);
      receipt.workingTimer = undefined;
    }
    await clearReceipt(receipt);
  };

  // ── Ingress admission ─────────────────────────────────────────────────────

  const senderAllowed = (message: { readonly authorId: string }): boolean =>
    options.allowFrom.includes(message.authorId);

  const channelAllowed = (channelId: string, parentChannelId: string | undefined): boolean => {
    const allow = options.allowChannels ?? [];
    if (allow.length === 0) return true;
    return allow.includes(channelId) || (parentChannelId !== undefined && allow.includes(parentChannelId));
  };

  /** The bot is addressed by a mention, a raw mention token, or a reply to one of its own messages. */
  const mentionsBot = (message: DiscordInboundMessage): boolean =>
    message.mentions.some((mention) => mention.id === identity) ||
    message.content.includes(`<@${identity}>`) ||
    message.content.includes(`<@!${identity}>`) ||
    (message.reply?.authorIsBot === true && message.reply.authorId === identity);

  const admitted = (message: DiscordInboundMessage): boolean => {
    // Only an explicitly allowlisted sender is admitted, bot or human. This bot's own account is
    // refused before this check, so a bot cannot answer itself and an unlisted bot can never enter.
    if (!senderAllowed(message)) return false;
    if (message.channelKind === "dm") {
      const dm = options.dmAllowFrom;
      // Direct messages are governed by `allowFrom` alone unless a DM list is configured.
      return dm === undefined || dm.length === 0 || dm.includes(message.authorId);
    }
    if (!channelAllowed(message.channelId, message.parentChannelId)) return false;
    return (options.groupPolicy ?? "mention") === "open" || mentionsBot(message);
  };

  const sessionKeyFor = (message: {
    readonly channelId: string;
    readonly channelKind: "channel" | "thread" | "dm";
    readonly guildId?: string;
  }): string => {
    if (message.channelKind === "dm") return `discord:${identity}:dm:${message.channelId}`;
    const guild = message.guildId === undefined ? "unknown" : message.guildId;
    return message.channelKind === "thread"
      ? `discord:${identity}:guild:${guild}:thread:${message.channelId}`
      : `discord:${identity}:guild:${guild}:channel:${message.channelId}`;
  };

  const messageKey = (messageId: string): string => `m:${messageId}`;
  const interactionKey = (interactionId: string): string => `i:${interactionId}`;

  const handleInbound = async (message: DiscordInboundMessage): Promise<void> => {
    await ready.promise;
    if (stopping || signal?.aborted) return;
    // Only this bot's own account is always refused; another bot needs an explicit allowlist entry.
    if (message.authorId === identity) return;
    if (message.system) return;
    if (!admitted(message)) return;
    const key = messageKey(message.id);
    const sessionKey = sessionKeyFor(message);
    const channelId = message.channelId;
    const parentChannelId = message.parentChannelId;

    // One leading self-mention is dropped before anything else reads the body: in a mention-gated
    // guild the user's text follows the mention (`@bot /status`, `@bot <callback URL>`), and the
    // mention must not be able to smuggle a callback past interception.
    const commandText = stripLeadingSelfMention(message.content, identity);

    // A callback-shaped message is consumed before any transcript or model admission, including a
    // malformed, stale, foreign or replayed one. Only the authenticated sender this channel recorded
    // may submit it, and neither its code nor its state is ever stored or logged.
    if (looksLikeOAuthCallback(commandText)) {
      const binding = originBindingOf(state.origins, channelId, identity);
      const text = binding === undefined || binding.senderId !== message.authorId
        ? "This OAuth callback did not come from the authenticated sender that owns this channel. It was not sent " +
          "to the assistant and was not stored."
        : gateway.mcpAdmin === undefined
          ? "No MCP login is available in this host; the callback was not stored or sent to the assistant."
          : await (async () => {
              const result = await gateway.mcpAdmin!.submitCallback(sessionKey, commandText, adapterContext);
              return result.handled
                ? result.text
                : "This OAuth callback was not accepted. It was not sent to the assistant and was not stored.";
            })();
      await admitNotice(key, { channelId, sessionKey, senderId: message.authorId }, text, undefined, undefined, true);
      return;
    }

    // Control parsing happens only after allowlist authentication and never for attachments.
    if (message.attachments.length === 0 && looksLikeDiscordCommand(commandText)) {
      const parsed = parseDiscordInput(commandText);
      if (parsed.kind !== "input") {
        await handleControl({ key, channelId, sessionKey, senderId: message.authorId }, parsed, false);
        return;
      }
    }

    // A reply does not carry the quoted message's attachments, so they are pulled in from that
    // message with the same store, size bound and concurrency gate as this message's own files.
    const quoted = message.quoted ?? await fetchQuoted(message);
    const referenced = await storeReferencedAttachments(quoted);
    const stored = await storeAttachments(message);
    const attachments = [...referenced.attachments, ...stored.attachments];
    const composed = [
      composeInboundText(message, stored.attachments.length > 0, quoted, referenced.attachments.length > 0),
      referenced.text,
      stored.text,
    ].filter((part) => part !== "").join("\n");
    const body = boundInput(composed, message.authorId);
    if (body.trim() === "") return;
    const origin = await rememberOrigin(channelId, message.authorId, message.channelKind, parentChannelId);
    if (origin.evictedSessionKey !== null) {
      await reportOutboxFault(
        origin.evictedSessionKey,
        "origin admission binding evicted at capacity; a fresh admission restores it",
      );
    }
    // The binding this admission just recorded is the authorization evidence: a withheld scheduled
    // result for this channel is released now, and its own re-check still requires the live allowlist.
    await releaseWithheld(sessionKey);

    const admittedAtMs = Date.now();
    await mutateState((doc) => {
      if (doc.admitted.includes(key)) return;
      if (doc.pending.length >= MAX_ADMITTED) {
        throw new Error("Discord durable output queue is full");
      }
      doc.pending.push({
        key,
        channelId,
        sessionKey,
        senderId: message.authorId,
        text: body,
        admittedAtMs,
        nextChunkIndex: 0,
        ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
        ...(attachments.length === 0 ? {} : { attachments }),
        replyToMessageId: message.id,
      });
      pushAdmitted(doc, key);
    });
    // The exact input and its identity are durable before any model submission, so a crash cannot
    // lose or duplicate it.
    markReading(channelId, message.id);
    drain();
  };

  const handleInteraction = async (interaction: DiscordInteraction): Promise<DiscordInteractionResponse> => {
    await ready.promise;
    if (stopping || signal?.aborted) {
      return { text: "The gateway is stopping; nothing was accepted.", ephemeral: true };
    }
    const shape = {
      channelId: interaction.channelId,
      channelKind: interaction.channelKind,
      ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId }),
    };
    if (interaction.userIsBot || !options.allowFrom.includes(interaction.userId)) {
      return { text: "You are not allowed to use this bot.", ephemeral: true };
    }
    if (interaction.channelKind === "dm") {
      const dm = options.dmAllowFrom;
      if (dm !== undefined && dm.length > 0 && !dm.includes(interaction.userId)) {
        return { text: "You are not allowed to use this bot here.", ephemeral: true };
      }
    } else if (!channelAllowed(interaction.channelId, interaction.parentChannelId)) {
      return { text: "This channel is not allowed for this bot.", ephemeral: true };
    }
    const key = interactionKey(interaction.id);
    const raw = interaction.option === undefined
      ? `/${interaction.commandName}`
      : `/${interaction.commandName} ${interaction.option}`;
    const parsed = parseDiscordInput(raw);
    if (parsed.kind === "input") {
      return { text: "That command is not available here.", ephemeral: true };
    }
    // Admit the durable command record in the background: the three-second acknowledgement must
    // not wait for a read-only status query, and the durable notice carries the real answer.
    void handleControl({
      key,
      channelId: interaction.channelId,
      sessionKey: sessionKeyFor(shape),
      senderId: interaction.userId,
    }, parsed, true).catch(() => {
      console.warn("Discord application command could not be admitted.");
    });
    return { text: `Processing ${raw.trim()}…`, ephemeral: true };
  };

  /**
   * Combine the attributed body with a thread placement line and bounded quoted context. The quoted
   * message is read at most once, only for an already admitted message, and only when it was not
   * this bot's own message: answering our own text needs no copy of it.
   */
  function composeInboundText(
    message: DiscordInboundMessage,
    hasAttachments: boolean,
    quoted: import("./discord-transport.js").DiscordReplyReference | undefined,
    includedReferencedAttachments: boolean,
  ): string {
    const speaker = discordSpeakerLabel(message.authorName, message.authorId);
    const resolved = resolveDiscordMentions(message.content, message.mentions).trim();
    const attributed = resolved !== ""
      ? `[${speaker}]: ${resolved}`
      : hasAttachments ? `[${speaker}]:` : `[${speaker}]: [empty message]`;
    const lines: string[] = [];
    if (message.channelKind === "thread" && message.parentChannelId !== undefined) {
      lines.push(`[Discord thread; parent channel id ${message.parentChannelId}]`);
    }
    const context = discordQuotedContext(quoted, includedReferencedAttachments);
    if (context !== undefined) lines.push(context);
    lines.push(attributed);
    return lines.join("\n");
  }

  /** Bounded best-effort read of the replied-to message's text; never a second model turn. */
  async function fetchQuoted(message: DiscordInboundMessage): Promise<import("./discord-transport.js").DiscordReplyReference | undefined> {
    const target = message.reply;
    if (target?.messageId === undefined) return undefined;
    if (target.authorIsBot && target.authorId === identity) return undefined;
    return transport.fetchMessage(message.channelId, target.messageId).catch(() => undefined);
  }

  /**
   * Store every supported original before the model sees it. The stored records go into the durable
   * pending record in the same commit that admits the input, so a reopen resumes from the stored
   * locators instead of downloading the (expired) CDN URL again.
   */
  async function storeAttachments(
    message: DiscordInboundMessage,
  ): Promise<{ readonly text: string; readonly attachments: DiscordPendingAttachment[] }> {
    const store = mediaStore;
    if (store === undefined) {
      return {
        text: message.attachments.length === 0
          ? ""
          : `[${message.attachments.length} attachment(s) ignored: attachment storage is not configured.]`,
        attachments: [],
      };
    }
    const bounded = message.attachments.slice(0, DISCORD_LIMITS.maxAttachments);
    const ignored = message.attachments.length - bounded.length;
    const lines: string[] = [];
    const admitted: DiscordPendingAttachment[] = [];
    for (const attachment of bounded) {
      const stored = await storeOneAttachment(store, attachment, message.authorId);
      admitted.push(stored);
      lines.push(discordAttachmentText(stored, stored.status === "failed" ? stored.note : undefined));
    }
    if (ignored > 0) {
      lines.push(`[${ignored} further attachment(s) were not read: only ${DISCORD_LIMITS.maxAttachments} per message are supported.]`);
    }
    return { text: lines.join("\n"), attachments: admitted };
  }

  /**
   * Store the replied-to message's attachments, bounded and labeled with their author, so "reply and
   * tag" can see the picture that was quoted. A message from this bot needs no copy of its own files.
   */
  async function storeReferencedAttachments(
    quoted: import("./discord-transport.js").DiscordReplyReference | undefined,
  ): Promise<{ readonly text: string; readonly attachments: DiscordPendingAttachment[] }> {
    const store = mediaStore;
    if (store === undefined || quoted === undefined || quoted.attachments.length === 0) {
      return { text: "", attachments: [] };
    }
    const author = boundedDiscordLabel(quoted.authorName, DISCORD_LIMITS.maxSenderNameChars);
    const bounded = quoted.attachments.slice(0, DISCORD_LIMITS.maxReferencedAttachments);
    const ignored = quoted.attachments.length - bounded.length;
    const lines: string[] = [];
    const admitted: DiscordPendingAttachment[] = [];
    for (const attachment of bounded) {
      const stored = await storeOneAttachment(store, attachment, quoted.authorId);
      admitted.push(stored);
      lines.push(`[from replied message by ${author}] ${discordAttachmentText(stored, stored.status === "failed" ? stored.note : undefined)}`);
    }
    if (ignored > 0) {
      lines.push(`[${ignored} further attachment(s) from the replied message were not read: only ${DISCORD_LIMITS.maxReferencedAttachments} are supported.]`);
    }
    return { text: lines.join("\n"), attachments: admitted };
  }

  /** Bound one admitted input; a truncated body says so instead of silently dropping its tail. */
  function boundInput(text: string, senderId: string): string {
    if (text.length <= DISCORD_LIMITS.maxInputChars) return text;
    let end = DISCORD_LIMITS.maxInputChars;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    console.warn(`Discord input from ${senderId} exceeded ${DISCORD_LIMITS.maxInputChars} characters and was truncated.`);
    return `${text.slice(0, end)}\n… (truncated: message exceeded this host's input bound)`;
  }

  async function storeOneAttachment(
    store: MediaStore,
    attachment: DiscordInboundAttachment,
    senderId: string,
  ): Promise<DiscordPendingAttachment> {
    const name = boundedDiscordLabel(attachment.filename, 120);
    const kind = attachmentKind(attachment.contentType, name);
    const base: DiscordPendingAttachment = {
      attachmentId: attachment.id,
      kind,
      originalName: name,
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType.slice(0, 120) }),
      status: "failed",
    };
    if (attachment.sizeBytes > store.maxFileBytes) {
      return { ...base, note: `too large for this host's ${formatBytes(store.maxFileBytes)} attachment limit` };
    }
    try {
      const stored = await mediaWork.run(async () => {
        const timeout = AbortSignal.timeout(DISCORD_LIMITS.downloadTimeoutMs);
        const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
          // The CDN URL is signed and short-lived; it is used once here and never stored.
          response = await globalThis.fetch(attachment.url, { method: "GET", redirect: "error", signal: combined });
        } catch {
          if (signal?.aborted) throw signal.reason;
          throw new Error("Discord attachment download failed");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Discord attachment download failed");
        }
        return store.save({
          kind,
          identity: attachment.id,
          ...(attachment.contentType === undefined ? {} : { mimeType: attachment.contentType }),
          originalName: name,
          declaredBytes: attachment.sizeBytes,
          body: boundedResponseBody(response, store.maxFileBytes, combined),
          ...(signal === undefined ? {} : { signal }),
        });
      }, signal);
      return {
        ...base,
        status: "stored",
        relativePath: stored.relativePath,
        bytes: stored.bytes,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const reason = error instanceof MediaRejected ? MEDIA_REJECTION_TEXT[error.reason] : "download failed";
      console.warn(`Discord attachment from ${senderId} could not be stored: ${reason}.`);
      return { ...base, note: reason };
    }
  }

  // ── Durable delivery of admitted work ─────────────────────────────────────

  const drain = (): void => {
    if (stopping || signal?.aborted || !recoveryComplete) return;
    const heldChannels = new Set<string>();
    for (const item of state.pending) {
      const notice = item.notice === true;
      if (item.hold === true) {
        heldChannels.add(item.channelId);
        continue;
      }
      // A channel's notices keep admission order behind an acknowledgement that is still held.
      if (notice && heldChannels.has(item.channelId)) continue;
      if (notice ? activeNotices >= 8 : activeReplies >= 8) continue;
      // A gated channel holds its inputs; an acknowledgement is never a model submission, so it can still be delivered.
      if (!notice && controlPending.has(item.channelId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.key) || failedThisCycle.has(item.key)) continue;
      delivering.add(item.key);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = beginSubmission(item.channelId);
      const task = Promise.resolve().then(() => deliver(item, slot)).catch(async (error: unknown) => {
        // Keep durable state for the next scan; no exception details or tight retry loop in the log.
        failedThisCycle.add(item.key);
        await holdFailedDelivery(item.key, error).catch(() => undefined);
      }).finally(() => {
        slot.release();
        if (notice) activeNotices -= 1;
        else activeReplies -= 1;
        active.delete(task);
        delivering.delete(item.key);
        if (!stopping && !signal?.aborted) drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: DiscordPendingDelivery, slot: SubmissionSlot): Promise<void> => {
    if (!options.allowFrom.includes(item.senderId)) {
      // The sender was removed from the live allowlist after admission: nothing is submitted or sent.
      await forget(item.key);
      return;
    }
    if (item.notice === true) {
      await deliverNotice(item);
      return;
    }
    // Enter this channel's submission order before any asynchronous preparation.
    await slot.prior;
    const content = await prepareInputContent(item);
    const conversation = await gateway.conversationFor(item.sessionKey, adapterContext);
    const requestId = requestIdFor(identity, item.key);
    const streaming = options.streaming !== false;
    const watch = streaming ? await conversation.watch(adapterContext) : undefined;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewWork: Promise<void> | undefined;
    let previewDirty = false;
    let latestPreview = "";
    let submissionId: SubmissionId | undefined;
    let watchStopped = false;
    const schedulePreview = () => {
      if (previewTimer !== undefined || watchStopped || signal?.aborted) return;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (previewWork !== undefined) return;
        previewDirty = false;
        previewWork = publishPreview(latestPreview).catch(() => undefined).finally(() => {
          previewWork = undefined;
          if (previewDirty && !watchStopped && !signal?.aborted) schedulePreview();
        });
      }, DISCORD_LIMITS.previewEditMs);
      previewTimer.unref?.();
    };
    const queuePreview = (text: string) => {
      if (watchStopped) return;
      latestPreview = text;
      previewDirty = true;
      schedulePreview();
    };
    const releaseTyping = startTyping(item.channelId);
    try {
      watch?.start(async (call) => {
        // Durable's watches never send Chord's recoverable `failed` call; it ends instead.
        if (call.kind !== "value") return;
        const view = call.value;
        const live = view.docs["pi.live"] as {
          run?: { inputs?: SubmissionId[] };
          generation?: { message?: { content?: { type: string; text?: string }[] } };
        } | undefined;
        const inputs = live?.run?.inputs;
        if (submissionId === undefined || inputs === undefined || !inputs.includes(submissionId)) return;
        // One preview per run: the run's first input owns the single live message, so a steered
        // sibling keeps the channel's typing indicator but never publishes a second preview.
        if (submissionId !== firstInput(inputs)) return;
        const text = live?.generation?.message?.content
          ?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
        if (text) queuePreview(text);
      });
      const early = earlySubmissions.get(item.key);
      earlySubmissions.delete(item.key);
      // The admission itself decided the busy-mode, so a later configuration change cannot redefine it.
      const submission = early ?? await conversation.submit({
        type: "input",
        content,
        requestId,
        whenBusy: await submissionMode(conversation, item),
      }, adapterContext);
      // Ordering is established; free the channel's next submission place while this turn runs.
      slot.release();
      submissionId = submission.id;
      const settled = await submission.wait(adapterContext);
      if (settled.status !== "done" || settled.type !== "input") {
        // A native abort or a queued reset deliberately ends the turn: it is not a delivery failure.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        await stopPreviewWatch();
        // A failed run has no committed answer and Durable exposes no run identity at settlement, so
        // each admitted message reports its own fixed notice.
        if (!intentional) await flushFinal(DELIVERY_FAILED_TEXT);
        await forget(item.key);
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const answerText = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      const text = answerText.trim() === "" ? "The assistant returned no text response." : answerText;
      // Inputs the run consumed settle with this same committed answer, so one of them owns its single reply.
      const settlement = { answer: settled.answer } as const;
      const role = await sharedDeliveryRole(conversation, item, settlement);
      await stopPreviewWatch();
      if (role === "owner") {
        await flushFinal(text);
        await retireSharedDelivery(conversation, item, settlement);
      } else if (role === "sibling") {
        await forget(item.key);
      }
    } finally {
      await stopPreviewWatch();
      releaseTyping();
      await settleFeedback(item.channelId, item.replyToMessageId);
    }

    async function deliverNotice(current: DiscordPendingDelivery): Promise<void> {
      // A host notice is ordinary text to Discord, so it obeys the same chunk bound and cursor.
      const chunks = splitDiscordText(current.text);
      let latest = state.pending.find((entry) => entry.key === item.key) ?? current;
      for (let index = latest.nextChunkIndex; index < chunks.length; index++) {
        await sendDiscordMessage(latest, chunks[index]!, "final", index);
        latest = state.pending.find((entry) => entry.key === item.key) ?? latest;
      }
      await forget(item.key);
    }

    async function stopPreviewWatch() {
      if (watchStopped) return;
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      watchStopped = true;
      previewDirty = false;
      await watch?.stop();
      await previewWork;
    }

    async function flushFinal(text: string): Promise<void> {
      let current = state.pending.find((entry) => entry.key === item.key) ?? item;
      const chunks = splitDiscordText(text);
      for (let index = current.nextChunkIndex; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        if (index === 0 && current.sentMessageId !== undefined) {
          if (current.lastText !== chunk) {
            try {
              await editDiscordMessage(current.sentMessageId, chunk, index);
            } catch (error) {
              if (!isGoneError(error)) throw error;
              // The preview is gone; the final answer must still be sent, so it is a fresh message.
              await mutatePending(item.key, (entry) => {
                delete entry.sentMessageId;
                delete entry.lastText;
              });
              current = state.pending.find((entry) => entry.key === item.key) ?? current;
              const sent = await sendDiscordMessage(item, chunk, "final", index);
              await markChunkDelivered(item.key, index, chunk, sent.messageId);
              current = state.pending.find((entry) => entry.key === item.key) ?? current;
              continue;
            }
          }
          await markChunkDelivered(item.key, index, chunk);
        } else {
          const sent = await sendDiscordMessage(item, chunk, "final", index);
          await markChunkDelivered(item.key, index, chunk, current.sentMessageId === undefined ? sent.messageId : undefined);
        }
        current = state.pending.find((entry) => entry.key === item.key) ?? current;
      }
    }

    /**
     * Record the write-ahead intent for one external request. It is committed before the request
     * leaves, so a crash between an accepted send and its bookkeeping is observable as ambiguous and
     * can never be mistaken for a request that never happened.
     */
    async function beginExternal(key: string, text: string, stage: "preview" | "final", chunkIndex: number | undefined): Promise<void> {
      await mutatePending(key, (entry) => {
        entry.deliveryStatus = "sending";
        entry.sendIntent = {
          text,
          stage,
          ...(chunkIndex === undefined ? {} : { chunkIndex }),
          startedAt: Date.now(),
        };
      });
    }

    /** The request provably did not deliver anything: drop its intent and let the caller retry. */
    async function abandonExternal(key: string): Promise<void> {
      await mutatePending(key, (entry) => {
        if (entry.deliveryStatus === "unknown") return;
        delete entry.deliveryStatus;
        delete entry.sendIntent;
      });
    }

    /** The request was accepted: clear the intent and advance the durable cursor in one commit. */
    async function acceptExternal(
      key: string,
      accepted: { readonly messageId?: string; readonly text: string },
      stage: "preview" | "final",
      chunkIndex: number | undefined,
    ): Promise<void> {
      await mutatePending(key, (entry) => {
        delete entry.deliveryStatus;
        delete entry.sendIntent;
        delete entry.unknownSince;
        if (stage === "final" && chunkIndex !== undefined) {
          entry.nextChunkIndex = Math.max(entry.nextChunkIndex, chunkIndex + 1);
        }
        if (stage === "preview" || chunkIndex === 0) {
          entry.lastText = accepted.text;
          if (accepted.messageId !== undefined) entry.sentMessageId = accepted.messageId;
        }
      });
    }

    async function sendDiscordMessage(
      current: DiscordPendingDelivery,
      text: string,
      stage: "preview" | "final",
      chunkIndex: number,
    ): Promise<DiscordSendResult> {
      const fresh = state.pending.find((entry) => entry.key === item.key) ?? current;
      const replyTo = fresh.sentMessageId === undefined ? fresh.replyToMessageId : undefined;
      await beginExternal(item.key, text, stage, chunkIndex);
      try {
        const sent = await transport.send({
          channelId: item.channelId,
          text,
          ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
        });
        await acceptExternal(item.key, sent, stage, chunkIndex);
        return sent;
      } catch (error) {
        const classified = classifyDiscordError(error);
        if (classified.outcome === "unknown") {
          // Keep the intent: the record is ambiguous until a human inspects it, and is never resent.
          await markUnknown(item.key);
          console.warn(`Discord delivery outcome unknown for ${item.key}; inspect the Durable channel-state record.`);
        } else {
          await abandonExternal(item.key);
        }
        throw error;
      }
    }

    /**
     * Edit the message this turn owns. `chunkIndex` advances the final cursor; a preview omits it.
     * An edit is an external mutation too, so it keeps the same write-ahead intent as a send.
     */
    async function editDiscordMessage(
      messageId: string,
      text: string,
      chunkIndex: number | undefined,
    ): Promise<void> {
      const stage = chunkIndex === undefined ? "preview" : "final";
      await beginExternal(item.key, text, stage, chunkIndex);
      try {
        await transport.edit(item.channelId, messageId, text);
        await acceptExternal(item.key, { text }, stage, chunkIndex);
      } catch (error) {
        const classified = classifyDiscordError(error);
        if (classified.outcome === "unknown") {
          await markUnknown(item.key);
          console.warn(`Discord edit outcome unknown for ${item.key}; inspect the Durable channel-state record.`);
        } else {
          await abandonExternal(item.key);
        }
        throw error;
      }
    }

    async function publishPreview(text: string) {
      // Previews stay inside one plain-sized message: they are replaced repeatedly while a turn runs.
      const preview = splitDiscordText(text)[0];
      if (!preview || signal?.aborted) return;
      const current = state.pending.find((entry) => entry.key === item.key) ?? item;
      if (current.deliveryStatus === "unknown" || current.lastText === preview) return;
      if (current.sentMessageId === undefined) {
        await sendDiscordMessage(current, preview, "preview", 0);
        return;
      }
      try {
        await editDiscordMessage(current.sentMessageId, preview, undefined);
      } catch (error) {
        if (!isGoneError(error)) throw error;
        await mutatePending(item.key, (entry) => {
          delete entry.sentMessageId;
          delete entry.lastText;
        });
        const fresh = state.pending.find((entry) => entry.key === item.key) ?? current;
        await sendDiscordMessage(fresh, preview, "preview", fresh.nextChunkIndex);
      }
    }
  };

  const markChunkDelivered = (key: string, index: number, text: string, messageId?: string) =>
    mutatePending(key, (item) => {
      item.nextChunkIndex = Math.max(item.nextChunkIndex, index + 1);
      if (index === 0) {
        item.lastText = text;
        if (messageId !== undefined) item.sentMessageId = messageId;
      }
    });

  const markUnknown = (key: string) =>
    mutatePending(key, (item) => {
      item.deliveryStatus = "unknown";
      item.unknownSince = Date.now();
    });

  /**
   * A proven rejection (or a repeated failure) is held for inspection instead of retried forever; an
   * ambiguous send was already quarantined with its write-ahead intent and is never downgraded.
   */
  async function holdFailedDelivery(key: string, error: unknown): Promise<void> {
    // Classify the thrown value itself: a client error may carry only a numeric status, so relying on
    // this module's own wrapper would treat a proven refusal as an ordinary retryable failure.
    const classified = classifyDiscordError(error);
    if (classified.outcome === "unknown") return;
    const attempts = (deliveryFailures.get(key) ?? 0) + 1;
    deliveryFailures.set(key, attempts);
    if (classified.outcome !== "rejected" && attempts < DISCORD_LIMITS.maxDeliveryFailures) return;
    deliveryFailures.delete(key);
    await mutatePending(key, (item) => {
      if (item.deliveryStatus === "unknown") return;
      item.deliveryStatus = "failed";
      delete item.sendIntent;
    });
    console.warn(`Discord delivery for ${key} is held after ${attempts} failure(s); inspect the Durable channel-state record.`);
  }

  /** Build the model-facing content: plain text, or text plus native image content for photos. */
  const prepareInputContent = async (
    item: DiscordPendingDelivery,
  ): Promise<string | (TextContent | ImageContent)[]> => {
    if (item.attachments === undefined || item.attachments.length === 0) return item.text;
    const store = mediaStore;
    if (store === undefined) return item.text;
    const images: ImageContent[] = [];
    for (const attachment of item.attachments) {
      if (attachment.status !== "stored" || attachment.kind !== "photo" || attachment.relativePath === undefined) continue;
      try {
        const bytes = await store.read(attachment.relativePath);
        images.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: attachment.contentType ?? "image/png",
        });
      } catch {
        // The locator still names the stored original; a removed file is not re-fetched.
      }
    }
    if (images.length === 0) return item.text;
    const parts: (TextContent | ImageContent)[] = [];
    if (item.text.trim() !== "") parts.push({ type: "text", text: item.text });
    parts.push(...images);
    return parts;
  };

  // ── Shared-run identity and busy-mode ────────────────────────────────────

  /**
   * Whether this conversation's current run may take a steer from this channel. Only an owner
   * surface steers, so a run whose first input is one of these submissions was started by an owner
   * message; a scheduled origin-mode run, a digest result or a worker result starts its own run, and
   * joining it would let the scheduled outbox and this channel deliver the same answer.
   */
  const ownerRun = async (conversation: Conversation, sessionKey: string): Promise<boolean> =>
    conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inputs = live.run?.inputs;
      if (inputs === undefined || inputs.length === 0) return false;
      if (await originOccurrencePending(tx, conversation.id)) return false;
      const first = firstInput(inputs);
      for (const candidate of state.pending) {
        if (candidate.sessionKey !== sessionKey) continue;
        const record = await tx.submissionByRequest(conversation.id, requestIdFor(identity, candidate.key));
        if (record?.id === first) return true;
      }
      return false;
    }, adapterContext);

  /** The native busy-mode for one admitted message; a run another path owns always queues. */
  const submissionMode = async (
    conversation: Conversation,
    current: DiscordPendingDelivery,
  ): Promise<"steer" | "followUp"> => {
    if (current.whenBusy !== "steer") return "followUp";
    return (await ownerRun(conversation, current.sessionKey)) ? "steer" : "followUp";
  };

  /** The admitted messages of this channel whose submission settled with this committed answer. */
  const sharedDeliveryGroup = async (
    conversationId: Conversation["id"],
    current: DiscordPendingDelivery,
    settlement: SharedAnswer,
  ): Promise<{ readonly keys: string[]; readonly owner: string | undefined; readonly present: boolean }> => {
    const members: { key: string; submissionId: number }[] = [];
    let present = false;
    await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(DiscordState, stateConversation.id);
      members.length = 0;
      present = false;
      for (const candidate of doc.pending) {
        if (candidate.key === current.key) present = true;
        if (candidate.sessionKey !== current.sessionKey) continue;
        const record = await tx.submissionByRequest(conversationId, requestIdFor(identity, candidate.key));
        if (record !== undefined && answeredTogether(record, settlement)) {
          members.push({ key: candidate.key, submissionId: record.id });
        }
      }
      return undefined;
    }, adapterContext);
    members.sort((left, right) => left.submissionId - right.submissionId || left.key.localeCompare(right.key));
    return { keys: members.map((member) => member.key), owner: members[0]?.key, present };
  };

  const sharedDeliveryRole = async (
    conversation: Conversation,
    current: DiscordPendingDelivery,
    settlement: SharedAnswer,
  ): Promise<DeliveryRole> => {
    const group = await sharedDeliveryGroup(conversation.id, current, settlement);
    if (!group.present) return "retired";
    if (group.owner === undefined || group.owner === current.key) return "owner";
    return "sibling";
  };

  /**
   * One commit that retires this delivery owner and every still-pending sibling of the same answer,
   * so a delivered shared answer can never be sent again by a record left behind by a crash.
   */
  const retireSharedDelivery = async (
    conversation: Conversation,
    current: DiscordPendingDelivery,
    settlement: SharedAnswer,
  ) => {
    const group = await sharedDeliveryGroup(conversation.id, current, settlement);
    const retired = new Set(group.keys);
    retired.add(current.key);
    for (const key of retired) {
      deliveryFailures.delete(key);
      earlySubmissions.delete(key);
    }
    await mutateState((doc) => {
      doc.pending = doc.pending.filter((entry) => !retired.has(entry.key));
      doc.controls = doc.controls.filter((entry) => !(retired.has(entry.key) &&
        (entry.status === "unconfirmed" || entry.status === "refused")));
    }, cleanupContext);
  };

  // ── Owner commands ────────────────────────────────────────────────────────

  /** Deliver one bounded host notice through the same durable queue every other answer uses. */
  const admitNotice = async (
    key: string,
    target: { readonly channelId: string; readonly sessionKey: string; readonly senderId: string },
    text: string,
    limit: number = MAX_NOTICE_CHARS,
    hold = false,
    dedupe = true,
  ): Promise<void> => {
    await mutateState((doc) => {
      if (dedupe && doc.pending.some((entry) => entry.key === key)) return;
      if (doc.pending.length >= MAX_ADMITTED) throw new Error("Discord durable output queue is full");
      doc.pending.push({
        key,
        channelId: target.channelId,
        sessionKey: target.sessionKey,
        senderId: target.senderId,
        text: boundNotice(text, limit),
        admittedAtMs: Date.now(),
        nextChunkIndex: 0,
        notice: true,
        ...(hold ? { hold: true } : {}),
      });
    });
    if (!hold) drain();
  };

  /** Apply one authenticated control: a read-only notice, or a durable record plus a native call. */
  async function handleControl(
    target: { readonly key: string; readonly channelId: string; readonly sessionKey: string; readonly senderId: string },
    parsed: Exclude<ParsedDiscordInput, { kind: "input" }>,
    interaction: boolean,
  ): Promise<void> {
    const recorded = state.controls.find((entry) => entry.key === target.key);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of running it twice.
      if (recorded.status === "admitted") await markControlUnconfirmed(recorded.key);
      await admitNotice(target.key, target, replayControlText(recorded));
      return;
    }
    if (parsed.kind === "unsupported") {
      await admitNotice(target.key, target,
        `${conversationCommandRefusal("discord", parsed.command, availableCommandNames())} ` +
        // `//text` keeps the leading slash in ordinary input instead of becoming a command.
        (interaction ? "Nothing was sent to the assistant." : "Any other message is sent to the assistant; prefix // to send a leading slash literally."));
      return;
    }
    if (parsed.command === "help") {
      const requested = parsed.args.trim().toLowerCase();
      if (requested === "") {
        await admitNotice(target.key, target, controlHelpText());
        return;
      }
      const offered = availableCommandNames();
      const command = offered.includes(requested) ? findConversationCommand(requested) : undefined;
      await admitNotice(target.key, target, command === undefined
        ? `${conversationCommandRefusal("discord", requested, offered)} Nothing was sent to the assistant.`
        : conversationDetailBlock(command, "discord"));
      return;
    }
    if (parsed.command === "status") {
      if (!hostCommands.status) {
        await admitNotice(target.key, target, STATUS_UNAVAILABLE_HOST);
        return;
      }
      if (parsed.args !== "") {
        await admitNotice(target.key, target, usageNotice("status"));
        return;
      }
      // Read-only: one bounded notice from the native conversation projection, no effect intent, no model call.
      await admitNotice(target.key, target, await statusNotice(target.sessionKey));
      return;
    }
    if (parsed.command === "model") {
      if (!hostCommands.model) {
        await admitNotice(target.key, target, MODEL_UNAVAILABLE_HOST);
        return;
      }
      const argument = parseModelArgument(parsed.args);
      if (argument.kind === "usage") {
        await admitNotice(target.key, target, usageNotice("model"));
        return;
      }
      const listing = await readModelListing(target.sessionKey);
      if (argument.kind === "list") {
        await admitNotice(target.key, target,
          listing === undefined ? MODEL_LISTING_UNAVAILABLE : modelListingText(listing), MAX_NOTICE_CHARS);
        return;
      }
      if (listing === undefined) {
        await admitNotice(target.key, target, MODEL_LISTING_UNAVAILABLE);
        return;
      }
      if (listing.presets === undefined) {
        await admitNotice(target.key, target, MODEL_PRESETS_UNAVAILABLE);
        return;
      }
      if (argument.name !== "default" && !listing.presets.some((preset) => preset.name === argument.name)) {
        await admitNotice(target.key, target,
          `Unknown model preset ${boundedDiscordLabel(argument.name, 80)}: nothing was changed. ` +
          "Use /model to list the configured presets.");
        return;
      }
      await admitControl(target, "model", argument.name);
      return;
    }
    if (parsed.command === "restart") {
      if (!hostCommands.restart) {
        const unavailable = options.restart?.unavailable;
        await admitNotice(target.key, target,
          typeof unavailable === "string" && unavailable.trim() !== ""
            ? unavailable.slice(0, MAX_NOTICE_CHARS)
            : RESTART_UNAVAILABLE_HOST);
        return;
      }
      if (parsed.args !== "") {
        await admitNotice(target.key, target, usageNotice("restart"));
        return;
      }
      if (restartHostRequested) {
        await admitNotice(target.key, target,
          restartHostRequestFailed ? RESTART_REQUEST_FAILED : RESTART_ALREADY_REQUESTED);
        return;
      }
      await admitControl(target, "restart");
      return;
    }
    if (parsed.command === "digest") {
      if (!hostCommands.digest) {
        await admitNotice(target.key, target, DIGEST_UNAVAILABLE_HOST);
        return;
      }
      const argument = parsed.args.trim().toLowerCase();
      if (argument === "status") {
        // Read-only bounded status: no scan, no model call and no cursor change.
        await admitNotice(target.key, target, await digestStatusNotice(target.sessionKey));
        return;
      }
      if (argument !== "") {
        await admitNotice(target.key, target, usageNotice("digest"));
        return;
      }
      await admitControl(target, "digest");
      return;
    }
    if (parsed.command === "mcp") {
      const admin = gateway.mcpAdmin;
      if (!hostCommands.mcp || admin === undefined) {
        await admitNotice(target.key, target, MCP_UNAVAILABLE_HOST);
        return;
      }
      if (parsed.args.trim() !== "") {
        await admitNotice(target.key, target, usageNotice("mcp"));
        return;
      }
      // Read-only status; management itself is the model tool acting for this authenticated chat.
      await admitNotice(target.key, target, renderMcpListing(await admin.list(adapterContext), MAX_NOTICE_CHARS));
      return;
    }
    // The remaining controls are native mutations of this same chat. `/stop` is an alias of
    // `/abort`: it normalizes to the same control kind before admission.
    if (parsed.args !== "") {
      await admitNotice(target.key, target, usageNotice(parsed.command));
      return;
    }
    await admitControl(target, parsed.command === "stop" ? "abort" : parsed.command);
  }

  /**
   * Admit one native mutation: durable record and held acknowledgement before the effect. The
   * channel stays gated so its later inputs cannot overtake this command, and a refused effect is
   * reported instead of being recorded as applied.
   */
  async function admitControl(
    target: { readonly key: string; readonly channelId: string; readonly sessionKey: string; readonly senderId: string },
    command: DiscordMutation,
    option?: string,
  ): Promise<void> {
    const channelId = target.channelId;
    if (controlPending.has(channelId) ||
        [...deferredControls.values()].some((entry) => entry.channelId === channelId)) {
      await admitNotice(target.key, target,
        "Previous command pending. This command wasn't started; retry later.");
      return;
    }
    if (pruneControls(state.controls, state.pending)
      .filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length >= MAX_UNRESOLVED_CONTROLS) {
      await admitNotice(target.key, target,
        `Too many control commands are still unconfirmed (limit ${MAX_UNRESOLVED_CONTROLS}); this /${command} was not ` +
        "started and was not sent to the assistant. Wait for them to finish or restart the adapter.");
      return;
    }
    controlPending.add(channelId);
    try {
      await mutateState((doc) => {
        if (!doc.controls.some((entry) => entry.key === target.key)) {
          doc.controls = pruneControls([
            ...doc.controls,
            {
              key: target.key,
              command,
              status: "admitted" as const,
              channelId,
              senderId: target.senderId,
            },
          ], doc.pending);
        }
        if (!doc.pending.some((entry) => entry.key === target.key)) {
          if (doc.pending.length >= MAX_ADMITTED) throw new Error("Discord durable output queue is full");
          doc.pending.push({
            key: target.key,
            channelId,
            sessionKey: target.sessionKey,
            senderId: target.senderId,
            text: CONTROL_ACK[command],
            admittedAtMs: Date.now(),
            nextChunkIndex: 0,
            notice: true,
            hold: true,
          });
        }
      });
    } catch (error) {
      // No control task exists to release this gate when admission itself fails.
      controlPending.delete(channelId);
      throw error;
    }
    const admittedAtMs = state.pending.find((entry) => entry.key === target.key)?.admittedAtMs ?? Date.now();
    const record: DeferredControl = {
      key: target.key,
      command,
      channelId,
      sessionKey: target.sessionKey,
      senderId: target.senderId,
      admittedAtMs,
      ...(option === undefined ? {} : { option }),
    };
    const prior = controlChains.get(channelId) ?? Promise.resolve();
    const run = prior.then(() => applyControl(record));
    let ack: "waiting" | "pending" | "applied" | "refused" = "waiting";
    const pendingTimer = setTimeout(() => {
      if (ack !== "waiting") return;
      ack = "pending";
      void releaseControlNotice(target.key, CONTROL_PENDING[command]).catch(() => undefined);
    }, CONTROL_PENDING_NOTICE_MS);
    pendingTimer.unref?.();
    const chain = run.then(() => undefined, () => undefined);
    controlChains.set(channelId, chain);
    const task = run.then(async (outcome) => {
      if (outcome.kind === "refused") {
        const wasWaiting = ack === "waiting";
        ack = "refused";
        await markControlRefused(target.key, outcome.text).catch(() => undefined);
        if (!wasWaiting) {
          await publishLateControlNotice(record, outcome.text).catch(() => undefined);
        }
        return;
      }
      if (outcome.kind !== "applied") {
        if (ack !== "waiting") return;
        ack = "pending";
        if (outcome.kind === "deferred") {
          await releaseControlNotice(target.key, CONTROL_PENDING[command]).catch(() => undefined);
        }
        return;
      }
      if (ack !== "waiting") {
        if (outcome.text !== undefined) {
          await publishLateControlNotice(record, outcome.text).catch(() => undefined);
        }
        if (outcome.requestRestart === true) requestRestart();
        return;
      }
      ack = "applied";
      try {
        await releaseControlNotice(target.key, outcome.text);
      } finally {
        // The record and acknowledgement are durable; the host owns the process replacement and is
        // still asked when the acknowledgement commit itself failed.
        if (outcome.requestRestart === true) requestRestart();
      }
    }, (error: unknown) => {
      // The record stays `admitted` and the acknowledgement stays held: a reopen reports it as unconfirmed.
      if (signal?.aborted) return;
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("Discord control command failed"));
    }).catch(() => undefined).finally(() => {
      clearTimeout(pendingTimer);
      pendingControls.delete(task);
      if (controlChains.get(channelId) === chain) {
        controlChains.delete(channelId);
        if (!stopping && !signal?.aborted) {
          if (!deferredControls.has(target.key)) controlPending.delete(channelId);
          drain();
        }
      }
    });
    pendingControls.add(task);
    drain();
  }

  /** Apply one recorded control after its earlier inputs were placed, recording the truthful outcome. */
  async function applyControl(record: DeferredControl): Promise<ControlOutcome> {
    try {
      for (const earlier of state.pending.filter((item) =>
        item.notice !== true && item.channelId === record.channelId &&
        admissionBefore(item, record) && options.allowFrom.includes(item.senderId))) {
        const earlierConversation = await gateway.conversationFor(earlier.sessionKey, adapterContext);
        await submitInOrder(record.channelId, async () => {
          const content = await prepareInputContent(earlier);
          const submission = await earlierConversation.submit({
            type: "input",
            content,
            requestId: requestIdFor(identity, earlier.key),
            whenBusy: await submissionMode(earlierConversation, earlier),
          }, adapterContext);
          // The normal delivery path reuses this turn, so a control-forced input is answered once.
          earlySubmissions.set(earlier.key, submission);
          return submission;
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const attempts = (controlFailures.get(record.key) ?? 0) + 1;
      if (attempts < MAX_CONTROL_ATTEMPTS) {
        controlFailures.set(record.key, attempts);
        deferredControls.set(record.key, record);
        return { kind: "deferred" };
      }
      controlFailures.delete(record.key);
      deferredControls.delete(record.key);
      await markControlUnconfirmed(record.key);
      return { kind: "abandoned" };
    }
    let outcome: ControlOutcome;
    if (record.command === "new") {
      outcome = await applyNewSession(record.sessionKey);
    } else if (record.command === "abort") {
      const conversation = await gateway.conversationFor(record.sessionKey, adapterContext);
      await conversation.abort(adapterContext);
      outcome = { kind: "applied" };
    } else if (record.command === "digest") {
      outcome = await applyDigest(record.sessionKey);
    } else if (record.command === "restart") {
      // No conversation effect: the record and its acknowledgement are durable first, and the host
      // replacement is requested by the caller only after that acknowledgement was released.
      outcome = { kind: "applied", text: CONTROL_ACK.restart, requestRestart: true };
    } else {
      outcome = await applyModelPreset(record);
    }
    if (outcome.kind !== "applied") return outcome;
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === record.key);
      if (entry !== undefined) entry.status = "applied";
      // The host replaces the process only after this commit, so the owed confirmation is durable first.
      if (record.command === "restart" && entry !== undefined) {
        const owed = doc.restart ?? [];
        if (!owed.some((item) => item.channelId === record.channelId)) {
          doc.restart = [...owed, { channelId: record.channelId, senderId: entry.senderId }]
            .slice(-MAX_RESTART_CONFIRMATIONS);
        }
      }
      doc.controls = pruneControls(doc.controls, doc.pending);
    });
    controlFailures.delete(record.key);
    deferredControls.delete(record.key);
    return outcome;
  }

  /** Whether one recorded command still has an undelivered notice queued in this adapter. */
  const noticeQueued = (key: string): boolean =>
    state.pending.some((entry) => entry.notice === true && entry.key === key);

  /**
   * Retry every deferred command on the adapter's own scan cadence. A transient failure while
   * placing the inputs admitted before the command is retried, never treated as final: the channel
   * stays gated for as long as the command is unresolved, so no later message can overtake it. On a
   * terminal outcome the gate is released and the owner gets one fixed report, because its earlier
   * acknowledgement already said the command was still pending. An applied mutation is never
   * re-entered: only a record still `admitted` in durable state is retried.
   */
  const resumeDeferredControls = (): void => {
    if (stopping || signal?.aborted) return;
    for (const [key, record] of [...deferredControls]) {
      if (controlChains.has(record.channelId)) continue;
      const durable = state.controls.find((entry) => entry.key === key);
      if (durable === undefined || durable.status !== "admitted") {
        // Another observer settled it (or a reopen reported it): release the gate without repeating it.
        deferredControls.delete(key);
        controlFailures.delete(key);
        controlPending.delete(record.channelId);
        continue;
      }
      const prior = controlChains.get(record.channelId) ?? Promise.resolve();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const chain = prior.then(() => held);
      controlChains.set(record.channelId, chain);
      const task = prior
        .then(() => applyDeferred(record))
        .catch((error: unknown) => {
          if (signal?.aborted) return;
          fatal ??= error;
          scope.cancel(error instanceof Error ? error : new Error("Discord deferred control failed"));
        })
        .finally(() => {
          finish();
          if (controlChains.get(record.channelId) === chain) controlChains.delete(record.channelId);
          pendingControls.delete(task);
          if (!stopping && !signal?.aborted) drain();
        });
      pendingControls.add(task);
    }
  };

  /** Finish one deferred command after its earlier inputs were placed. */
  async function applyDeferred(record: DeferredControl): Promise<void> {
    const outcome = await applyControl(record);
    if (outcome.kind === "deferred") return;
    deferredControls.delete(record.key);
    controlFailures.delete(record.key);
    if (outcome.kind === "applied") {
      // A published "still pending" wording already promised the outcome, so the fixed completion
      // receipt is delivered even when the command itself produced no text of its own.
      const text = outcome.text ?? CONTROL_ACK[record.command];
      if (noticeQueued(record.key)) await releaseControlNotice(record.key, text).catch(() => undefined);
      else await publishLateControlNotice(record, text).catch(() => undefined);
      if (outcome.requestRestart === true) requestRestart();
    } else if (outcome.kind === "refused") {
      if (noticeQueued(record.key)) await markControlRefused(record.key, outcome.text).catch(() => undefined);
      else await publishLateControlNotice(record, outcome.text).catch(() => undefined);
    } else {
      // Attempts are exhausted: the command may or may not have taken effect, so it is reported once
      // and never applied again.
      if (noticeQueued(record.key)) await markControlUnconfirmed(record.key).catch(() => undefined);
      else await publishLateControlNotice(record, UNCONFIRMED_CONTROL).catch(() => undefined);
    }
    controlPending.delete(record.channelId);
  }

  /** `/new`: a native reset plus, when the host offers it, a rebuild of this session's prompt snapshot. */
  async function applyNewSession(sessionKey: string): Promise<ControlOutcome> {
    const resetSession = gateway.resetSession;
    if (resetSession === undefined) {
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      await conversation.reset(undefined, adapterContext);
      return { kind: "applied" };
    }
    try {
      const result: GatewaySessionReset = await resetSession.call(gateway, sessionKey, adapterContext);
      if (result.status === "busy") return { kind: "refused", text: RESET_BUSY };
      return { kind: "applied" };
    } catch (error) {
      if (isConversationBusy(error)) return { kind: "refused", text: RESET_BUSY };
      throw error;
    }
  }

  /** `/model <preset>`: one configured preset name, applied atomically or refused with its reason. */
  async function applyModelPreset(record: DeferredControl): Promise<ControlOutcome> {
    const select = gateway.selectModelPreset;
    if (select === undefined) return { kind: "refused", text: MODEL_UNAVAILABLE_HOST };
    try {
      const selection = await select.call(gateway, record.sessionKey, record.option ?? "default", adapterContext);
      return {
        kind: "applied",
        text: `Model set to ${boundedDiscordLabel(selection.provider, 80)}/${boundedDiscordLabel(selection.modelId, 160)} ` +
          `(thinking: ${boundedDiscordLabel(selection.thinkingLevel, 32)}) for this chat.`,
      };
    } catch (error) {
      if (isConversationBusy(error)) {
        return { kind: "refused", text: "Model selection refused: chat busy. /abort or retry when idle." };
      }
      return { kind: "refused", text: "Model selection was refused; nothing was changed." };
    }
  }

  /** `/digest`: start one bounded digestion batch for this channel's own conversation. */
  async function applyDigest(sessionKey: string): Promise<ControlOutcome> {
    const host = gateway.memoryDigest;
    if (host === undefined) return { kind: "refused", text: DIGEST_UNAVAILABLE_HOST };
    const conversation = await gateway.conversationFor(sessionKey, adapterContext);
    const result = await host.start({
      id: conversation.id,
      commit: (change, context) => conversation.commit(change, context),
    }, adapterContext);
    return result.status === "refused"
      ? { kind: "refused", text: renderMemoryDigestStart(result) }
      : { kind: "applied", text: renderMemoryDigestStart(result) };
  }

  /** Bounded read-only `/digest status`; it creates no task and reads no chat transcript. */
  async function digestStatusNotice(sessionKey: string): Promise<string> {
    const host = gateway.memoryDigest;
    if (host === undefined) return DIGEST_UNAVAILABLE_HOST;
    const conversation = await gateway.conversationFor(sessionKey, adapterContext);
    return renderMemoryDigestStatus(await host.status({
      id: conversation.id,
      commit: (change, context) => conversation.commit(change, context),
    }, adapterContext));
  }

  /** One bounded status from the native conversation projection: read only, no model call. */
  async function statusNotice(sessionKey: string): Promise<string> {
    try {
      const listing = await readModelListing(sessionKey);
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      const status = await inProcessTerminalConversation(conversation).status(adapterContext);
      const selection = listing?.selected;
      const model = selection === undefined
        ? (status.model === undefined ? "unknown" : `${status.model.provider}/${status.model.modelId}`)
        : `${selection.provider}/${selection.modelId} (thinking: ${selection.thinkingLevel})`;
      const preset = listing === undefined ? undefined : matchingPresetName(listing);
      let background: string[] = [];
      try {
        if (typeof gateway.backgroundStatus === "function") {
          background = renderBackgroundStatus(await gateway.backgroundStatus(sessionKey, adapterContext));
        }
      } catch {
        background = [];
      }
      return [
        "Status for this channel (no model call, no configuration change):",
        `Model: ${boundedDiscordLabel(model, 240)}${preset === undefined ? "" : ` — preset ${boundedDiscordLabel(preset, 80)}`}`,
        status.run === undefined
          ? "Run: idle"
          : `Run: running (turn ${status.run.taskId}, ${status.run.inputs} input(s)` +
            `${status.run.attempt === undefined ? "" : `, generation attempt ${status.run.attempt}`})`,
        `Queued native inputs: ${status.inbox.total}`,
        ...background,
        "Only this channel's own records were read; no other chat's transcript, prompt or tool argument is included.",
      ].join("\n");
    } catch {
      return "Status is unavailable right now: this channel's conversation metadata could not be read. " +
        "No model call was made and nothing changed.";
    }
  }

  /** The host model catalog is per-session, so this channel's mapped conversation must exist first. */
  async function readModelListing(sessionKey: string): Promise<GatewayModelList | undefined> {
    if (gateway.listModels === undefined) return undefined;
    try {
      await gateway.conversationFor(sessionKey, adapterContext);
      return await gateway.listModels(sessionKey, adapterContext);
    } catch {
      return undefined;
    }
  }

  function modelListingText(listing: GatewayModelList): string {
    const maxChoices = 50;
    const selectedLine = `Current model: ${boundedDiscordLabel(listing.selected.provider, 80)}/` +
      `${boundedDiscordLabel(listing.selected.modelId, 160)} (thinking: ${boundedDiscordLabel(listing.selected.thinkingLevel, 32)}).`;
    const presets = listing.presets ?? [];
    if (presets.length === 0) {
      const rows = listing.models.slice(0, maxChoices).map((choice) => {
        const current = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
        const levels = choice.thinkingLevels.map((level) => boundedDiscordLabel(level, 32)).join(", ");
        return `  ${current ? "* " : "  "}${boundedDiscordLabel(choice.provider, 80)} ${boundedDiscordLabel(choice.modelId, 160)} ` +
          `— ${boundedDiscordLabel(choice.name, 160)} [thinking: ${levels === "" ? "off" : levels}]`;
      });
      if (listing.models.length > maxChoices) rows.push(`  … ${listing.models.length - maxChoices} more allowed models omitted`);
      return [
        selectedLine,
        "Named model presets are not configured in this deployment, so /model <name> and /model default are " +
          "unavailable here; this chat command never rewrites the configuration.",
        "Configured direct choices (read only; the direct selection belongs to the local CLI):",
        ...rows,
      ].join("\n");
    }
    const selectedPreset = matchingPresetName(listing);
    const rows = presets.slice(0, maxChoices).map((preset) => {
      const isDefault = preset.name === listing.defaultPreset;
      return `  ${preset.name === selectedPreset ? "* " : "  "}${boundedDiscordLabel(preset.name, 80)} — ` +
        `${boundedDiscordLabel(preset.provider, 80)} ${boundedDiscordLabel(preset.modelId, 160)} ` +
        `[thinking: ${boundedDiscordLabel(preset.thinkingLevel ?? "off", 32)}]${isDefault ? " (default)" : ""}`;
    });
    if (presets.length > maxChoices) rows.push(`  … ${presets.length - maxChoices} more named presets omitted`);
    return [
      selectedLine,
      ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${boundedDiscordLabel(listing.defaultPreset, 80)}.`]),
      "Named model presets (see /help model to select one):",
      ...rows,
      "A selection applies to this channel only and lasts while the gateway stays open; a restart restores the " +
        "configured default and prepared requests keep their model.",
    ].join("\n");
  }

  function availableCommandNames(): readonly string[] {
    return offeredDiscordCommandNames(hostCommands);
  }

  function controlHelpText(): string {
    const offered = availableCommandNames();
    const absent = conversationCommandNames("discord").filter((name) => !offered.includes(name));
    return [
      conversationHelpListing("discord", offered),
      ...(absent.length === 0 ? [] : [`Not offered by this host: ${absent.map((name) => `/${name}`).join(", ")}.`]),
      mediaStore === undefined
        ? "Text only: attachments are not read, other slash commands are refused, and // sends a leading slash literally."
        : "Images are read natively, other attachments are stored unread, and up to " +
          `${DISCORD_LIMITS.maxAttachments} attachments per message are kept. // sends a slash literally.`,
    ].join("\n\n");
  }

  const releaseControlNotice = async (key: string, text?: string): Promise<void> => {
    await mutateState((doc) => {
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice === undefined) return;
      delete notice.hold;
      if (text !== undefined) notice.text = boundNotice(text, MAX_NOTICE_CHARS);
    }, cleanupContext);
    drain();
  };

  const markControlUnconfirmed = async (key: string): Promise<void> => {
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === key);
      if (entry !== undefined) entry.status = "unconfirmed";
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice === undefined) return;
      notice.text = UNCONFIRMED_CONTROL;
      delete notice.hold;
    }, cleanupContext);
  };

  const markControlRefused = async (key: string, text: string): Promise<void> => {
    const bounded = boundNotice(text, MAX_NOTICE_CHARS);
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === key);
      if (entry !== undefined) entry.status = "refused";
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice !== undefined) {
        notice.text = bounded;
        delete notice.hold;
      }
      doc.controls = pruneControls(doc.controls, doc.pending);
    }, cleanupContext);
  };

  /** A final outcome published after its "still pending" wording; never loses the only answer. */
  const publishLateControlNotice = async (record: DeferredControl, text: string): Promise<void> => {
    await admitNotice(`late:${record.key}`, {
      channelId: record.channelId,
      sessionKey: record.sessionKey,
      senderId: record.senderId,
    }, text, MAX_LATE_CONTROL_CHARS);
  };

  /**
   * Ask the host to replace this process, at most once per adapter lifetime. A refusal is a known
   * no-effect, so it is reported to the channel that asked and never upgraded into a success claim.
   */
  function requestRestart(): void {
    if (restartHostRequested) return;
    const host = options.restart;
    if (host === undefined || !host.supported) return;
    restartHostRequested = true;
    void host.request().catch((error: unknown) => {
      const busy = error instanceof RestartBusyError;
      restartHostRequestFailed = !busy;
      if (busy) restartHostRequested = false;
      console.warn(busy
        ? "Discord /restart was refused while live work is active; the gateway keeps running."
        : "Discord /restart request was refused by the host; the gateway keeps running.");
      void mutateState((doc) => {
        admitRestartNotices(doc, busy ? RESTART_BUSY_MESSAGE : RESTART_FAILED);
        delete doc.restart;
      }, adapterContext).then(() => {
        if (!stopping && !signal?.aborted) drain();
      }).catch(() => undefined);
    });
  }

  /**
   * The session key stored on a host-generated notice. It is never used to resolve a conversation,
   * so it falls back to a non-chat key only when no admission evidence names the real chat.
   */
  function noticeSessionKey(channelId: string): string {
    const binding = originBindingOf(state.origins, channelId, identity);
    return binding === undefined
      ? `discord:${identity}:notice:${channelId}`
      : sessionKeyForBinding(binding, channelId);
  }

  /**
   * Queue one ordinary notice per recorded restart channel: the live confirmation in a replacement
   * process, or the host-refusal report in the process that stayed up. A sender the live allowlist
   * no longer admits is dropped like any other notice; records that do not fit stay owed.
   */
  function admitRestartNotices(doc: Draft<ChannelState>, text: string): DiscordRestartRecord[] {
    const remaining: DiscordRestartRecord[] = [];
    for (const record of doc.restart ?? []) {
      if (!options.allowFrom.includes(record.senderId)) continue;
      const key = `restart:${record.channelId}`;
      if (doc.pending.some((item) => item.key === key)) {
        remaining.push(record);
        continue;
      }
      if (doc.pending.length >= MAX_ADMITTED) {
        remaining.push(record);
        continue;
      }
      doc.pending.push({
        key,
        channelId: record.channelId,
        sessionKey: noticeSessionKey(record.channelId),
        senderId: record.senderId,
        text,
        admittedAtMs: Date.now(),
        nextChunkIndex: 0,
        notice: true,
      });
    }
    return remaining;
  }

  // ── Scheduled results and interruption notices ───────────────────────────

  /** Mapped chat sessions this adapter's bot owns, with the channel ID decoded from the key. */
  const scheduledSessions = async (): Promise<{ sessionKey: string; channelId: string }[]> => {
    if (outbox === undefined) return [];
    const sessions: { sessionKey: string; channelId: string }[] = [];
    for (const { sessionKey } of await outbox.sessions(adapterContext)) {
      const decoded = decodeDiscordSessionKey(sessionKey, identity);
      if (decoded !== undefined) sessions.push({ sessionKey, channelId: decoded.channelId });
    }
    return sessions;
  };

  const updateScheduled = async (
    sessionKey: string,
    id: string,
    change: (entry: Draft<CronDeliveryRecord>) => void,
    commitContext: Context = adapterContext,
  ): Promise<CronDeliveryRecord | undefined> => {
    if (outbox === undefined) return undefined;
    return outbox.update(sessionKey, id, change, commitContext);
  };

  const reportOutboxFault = async (sessionKey: string, message: string): Promise<void> => {
    if (outbox === undefined) return;
    await outbox.recordFault(sessionKey, message, cleanupContext).catch(() => undefined);
  };

  /** A write-ahead intent may have reached Discord before a crash: quarantine it, never resend it. */
  const recoverScheduled = async (): Promise<void> => {
    if (outbox === undefined) return;
    for (const { sessionKey } of await scheduledSessions()) {
      let records: readonly unknown[];
      try {
        records = await outbox.list(sessionKey, cleanupContext);
      } catch (error) {
        await reportOutboxFault(sessionKey, outboxFaultMessage(error));
        continue;
      }
      for (const value of records) {
        const record = value as { id?: unknown; status?: unknown; sendIntent?: unknown };
        if (record === null || typeof record !== "object") {
          await reportOutboxFault(sessionKey, "delivery outbox contains an unusable record");
          continue;
        }
        if (record.status !== "sending" && record.sendIntent === undefined) continue;
        if (typeof record.id !== "string" || record.id === "") {
          await reportOutboxFault(sessionKey, "delivery outbox contains an unusable record");
          continue;
        }
        try {
          await updateScheduled(sessionKey, record.id, (entry) => {
            entry.status = "unknown";
            entry.unknownSince = Date.now();
            delete entry.sendIntent;
          }, cleanupContext);
        } catch (error) {
          await reportOutboxFault(sessionKey, outboxFaultMessage(error));
          continue;
        }
        console.warn(`Discord scheduled delivery outcome unknown for ${record.id}; inspect the Durable cron outbox record.`);
      }
    }
  };

  const clearScheduledIntent = (sessionKey: string, id: string) =>
    updateScheduled(sessionKey, id, (entry) => {
      if (entry.status === "sending" || entry.sendIntent !== undefined) {
        entry.status = "pending";
        delete entry.sendIntent;
      }
    }, cleanupContext);

  const sendScheduledChunk = async (
    sessionKey: string,
    recordId: string,
    channelId: string,
    chunk: string,
    index: number,
  ): Promise<"sent" | "retry" | "stop"> => {
    let requestStarted = false;
    try {
      await updateScheduled(sessionKey, recordId, (entry) => {
        entry.status = "sending";
        entry.sendIntent = { text: chunk, chunkIndex: index, startedAt: Date.now() };
      });
      requestStarted = true;
      await transport.send({ channelId, text: chunk });
      await updateScheduled(sessionKey, recordId, (entry) => {
        entry.status = "pending";
        delete entry.sendIntent;
        delete entry.unknownSince;
        entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
      }, cleanupContext);
      return "sent";
    } catch (error) {
      if (!requestStarted) {
        // A failed/aborted intent commit made no external request. Do not
        // quarantine it as an ambiguous Discord send; keep it retryable.
        await clearScheduledIntent(sessionKey, recordId).catch(async (clearError: unknown) => {
          await reportOutboxFault(sessionKey, outboxFaultMessage(clearError));
        });
        if (!signal?.aborted) await reportOutboxFault(sessionKey, outboxFaultMessage(error));
        return "stop";
      }
      const classified = classifyDiscordError(error);
      if (classified.outcome === "unknown") {
        await updateScheduled(sessionKey, recordId, (entry) => {
          entry.status = "unknown";
          entry.unknownSince = Date.now();
          delete entry.sendIntent;
        }, cleanupContext);
        console.warn(`Discord scheduled delivery outcome unknown for ${recordId}; inspect the Durable cron outbox record.`);
        return "stop";
      }
      if (classified.outcome === "not-sent") {
        await clearScheduledIntent(sessionKey, recordId);
        return signal?.aborted ? "stop" : "retry";
      }
      await updateScheduled(sessionKey, recordId, (entry) => {
        entry.status = "failed";
        entry.settledAt = Date.now();
        delete entry.sendIntent;
        entry.error = "Discord refused this delivery";
      }, cleanupContext);
      return "stop";
    }
  };

  const deliverScheduled = async (sessionKey: string, channelId: string, record: CronDeliveryRecord) => {
    if (outbox === undefined) return;
    if (record.sessionKey !== sessionKey) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "failed";
        entry.settledAt = Date.now();
        entry.error = "outbox session does not match its origin";
      }, cleanupContext);
      return;
    }
    if (record.text.trim() === "") {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "failed";
        entry.settledAt = Date.now();
        entry.error = "delivery text is empty";
      }, cleanupContext);
      return;
    }
    // The session key is only a candidate locator. Authorization comes from durable admission
    // evidence for this bot and channel, never from parsing the key.
    const binding = originBindingOf(state.origins, channelId, identity);
    if (binding === undefined) {
      // Missing evidence is a reversible hold: a later authenticated admission restores it.
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "withheld";
        entry.withheldSince = Date.now();
        entry.error = "origin channel has no durable admission evidence";
      }, cleanupContext);
      console.warn(`Discord scheduled delivery withheld for ${record.id}: no durable origin admission evidence.`);
      return;
    }
    if (!options.allowFrom.includes(binding.senderId) ||
        (binding.kind === "dm"
          ? (options.dmAllowFrom !== undefined && options.dmAllowFrom.length > 0 &&
             !options.dmAllowFrom.includes(binding.senderId))
          : !channelAllowed(channelId, binding.parentChannelId))) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "unauthorized";
        entry.settledAt = Date.now();
        entry.error = "origin sender is no longer authorized";
      }, cleanupContext);
      return;
    }
    const chunks = splitDiscordText(record.text);
    let current = record;
    for (let index = current.nextChunkIndex; index < chunks.length; index++) {
      const result = await sendScheduledChunk(sessionKey, record.id, channelId, chunks[index]!, index);
      if (result !== "sent") return;
      const next = (await outbox.list(sessionKey, adapterContext)).find((entry) => entry.id === record.id);
      if (next === undefined) return;
      current = next;
    }
    await updateScheduled(sessionKey, record.id, (entry) => {
      entry.status = "delivered";
      entry.settledAt = Date.now();
      delete entry.error;
    }, cleanupContext);
  };

  const scanScheduled = async (): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted) return;
    for (const { sessionKey, channelId } of await scheduledSessions()) {
      if (stopping || signal?.aborted) return;
      let records: readonly unknown[];
      try {
        records = await outbox.list(sessionKey, adapterContext);
      } catch (error) {
        await reportOutboxFault(sessionKey, outboxFaultMessage(error));
        continue;
      }
      for (const value of records) {
        if (stopping || signal?.aborted) return;
        const problem = pendingRecordProblem(value);
        if (problem !== undefined) {
          const candidate = value as { id?: unknown };
          if (typeof candidate.id === "string" && candidate.id !== "") {
            try {
              await updateScheduled(sessionKey, candidate.id, (entry) => {
                entry.status = "failed";
                entry.settledAt = Date.now();
                entry.error = problem;
              }, cleanupContext);
            } catch (error) {
              await reportOutboxFault(sessionKey, outboxFaultMessage(error));
            }
          } else {
            await reportOutboxFault(sessionKey, problem);
          }
          continue;
        }
        const record = value as CronDeliveryRecord;
        if (record.status !== "pending" || scheduledActive.has(record.id)) continue;
        if (scheduledChannelActive.has(channelId)) continue;
        if (scheduledActive.size >= DISCORD_LIMITS.maxScheduledActive) return;
        scheduledActive.add(record.id);
        scheduledChannelActive.add(channelId);
        const task = Promise.resolve()
          .then(() => deliverScheduled(sessionKey, channelId, record))
          .catch(() => {
            // Keep the durable record pending; the next scan retries or quarantines it.
          })
          .finally(() => {
            scheduledActive.delete(record.id);
            scheduledChannelActive.delete(channelId);
            scheduledTasks.delete(task);
          });
        scheduledTasks.add(task);
      }
    }
  };

  const requestScheduledScan = () => {
    if (scheduledScanning || stopping || signal?.aborted) return;
    scheduledScanning = true;
    void scanScheduled().catch(() => undefined).finally(() => { scheduledScanning = false; });
  };

  /** A fresh authenticated admission restores a missing binding, then releases withheld results. */
  const releaseWithheld = async (sessionKey: string): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted) return;
    let records: readonly unknown[];
    try {
      records = await outbox.list(sessionKey, adapterContext);
    } catch {
      return;
    }
    let released = false;
    for (const value of records) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as { id?: unknown; status?: unknown };
      if (record.status !== "withheld" || typeof record.id !== "string" || record.id === "") continue;
      try {
        await updateScheduled(sessionKey, record.id, (entry) => {
          entry.status = "pending";
          delete entry.withheldSince;
          delete entry.error;
        }, adapterContext);
        released = true;
      } catch {
        // The scan retries or quarantines it; admission itself must still succeed.
      }
    }
    if (released) requestScheduledScan();
  };

  // ── MCP owner surface ─────────────────────────────────────────────────────

  /** The exact channel and durable sender binding for one Discord session key, or `undefined`. */
  /**
   * One channel's durable admission evidence, re-checked against the live configuration the same way
   * ingress is. Reply destinations, scheduled results and MCP notices all come through here, so a
   * channel removed from `allowChannels`, a DM sender removed from `dmAllowFrom` or a sender removed
   * from `allowFrom` stops receiving anything without waiting for a restart.
   */
  const authorizedOrigin = (channelId: string): { readonly channelId: string; readonly senderId: string } | undefined => {
    const binding = originBindingOf(state.origins, channelId, identity);
    if (binding === undefined) return undefined;
    if (!options.allowFrom.includes(binding.senderId)) return undefined;
    if (binding.kind === "dm") {
      const dm = options.dmAllowFrom;
      if (dm !== undefined && dm.length > 0 && !dm.includes(binding.senderId)) return undefined;
    } else if (!channelAllowed(channelId, binding.parentChannelId)) {
      return undefined;
    }
    return { channelId, senderId: binding.senderId };
  };

  const ownerChannelFor = (sessionKey: string): { readonly channelId: string; readonly senderId: string } | undefined => {
    const decoded = decodeDiscordSessionKey(sessionKey, identity);
    if (decoded === undefined) return undefined;
    const owner = authorizedOrigin(decoded.channelId);
    // The session key also names the placement; a channel whose key kind changed is not the owner.
    if (owner === undefined) return undefined;
    const binding = originBindingOf(state.origins, decoded.channelId, identity);
    return binding === undefined || binding.kind !== decoded.kind ? undefined : owner;
  };

  const detachMcpSurface = gateway.mcpSurfaces?.attach({
    owns: (sessionKey) => ownerChannelFor(sessionKey) !== undefined,
    async deliverAuthorization(sessionKey, authorization, _context) {
      const owner = ownerChannelFor(sessionKey);
      if (owner === undefined) throw new Error("the requesting Discord channel is no longer authorized");
      if (authorization.expiresAtMs <= Date.now()) throw new Error("authorization URL expired before delivery");
      // No model turn and no durable record: this one-time URL exists only in this channel.
      await transport.send({
        channelId: owner.channelId,
        text: [
          "MCP OAuth authorization URL (owner only):",
          authorization.url,
          `Valid until ${new Date(authorization.expiresAtMs).toISOString()}.`,
          "Open it as the owner. If the browser cannot reach this host, paste the callback URL back into this channel.",
          "This gateway does not store this URL or its state in channel state.",
        ].join("\n"),
      });
    },
    async deliverNotice(sessionKey, text, _context) {
      const owner = ownerChannelFor(sessionKey);
      if (owner === undefined) return;
      await transport.send({ channelId: owner.channelId, text });
    },
  });

  // ── Recovery on open ──────────────────────────────────────────────────────

  // A control recorded but never confirmed may or may not have taken effect: report it once, never replay it.
  const unresolved = state.controls.filter((entry) => entry.status === "admitted");
  const heldNotices = state.pending.some((item) => item.hold === true);
  if (unresolved.length > 0 || heldNotices) {
    await mutateState((doc) => {
      for (const entry of doc.controls) {
        if (entry.status !== "admitted") continue;
        const notice = doc.pending.find((item) => item.notice === true && item.key === entry.key);
        // A restart is never re-requested by recovery: only its interrupted outcome is reported.
        const interrupted = entry.command === "restart" ? UNCONFIRMED_RESTART : UNCONFIRMED_CONTROL;
        if (notice !== undefined) {
          notice.text = interrupted;
          delete notice.hold;
          entry.status = "unconfirmed";
          continue;
        }
        if (doc.pending.length >= MAX_ADMITTED) continue;
        doc.pending.push({
          key: `unconfirmed:${entry.key}`,
          channelId: entry.channelId,
          sessionKey: `discord:${identity}:notice:${entry.channelId}`,
          senderId: entry.senderId,
          text: interrupted,
          admittedAtMs: Date.now(),
          nextChunkIndex: 0,
          notice: true,
        });
        entry.status = "unconfirmed";
      }
      for (const notice of doc.pending) {
        if (notice.hold !== true) continue;
        const record = doc.controls.find((entry) => entry.key === notice.key);
        if (record === undefined) {
          notice.text = UNCONFIRMED_CONTROL;
          delete notice.hold;
        } else if (record.status === "applied") {
          delete notice.hold;
        }
      }
    }, adapterContext);
    if (unresolved.length > 0) {
      console.warn(`Discord ${unresolved.length} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }
  // A restart this store recorded was requested by the process this one replaced: confirm it is live
  // in every channel that asked, through the same durable notice queue every other notice uses.
  if (state.restart !== undefined && state.restart.length > 0) {
    await mutateState((doc) => {
      const remaining = admitRestartNotices(doc, RESTART_LIVE);
      if (remaining.length > 0) doc.restart = remaining;
      else delete doc.restart;
    }, adapterContext);
  }
  // An unresolved write-ahead intent may have reached Discord before a crash.
  for (const item of state.pending.filter((entry) => entry.sendIntent !== undefined || entry.deliveryStatus === "sending")) {
    await markUnknown(item.key);
    console.warn(`Discord delivery outcome unknown for ${item.key}; inspect the Durable channel-state record.`);
  }
  await recoverScheduled();
  recoveryComplete = true;
  drain();

  // Cosmetic and best effort: a slow or failed registration must not delay ingress.
  void transport.registerCommands(discordCommandSpecs(availableCommandNames())).catch(() => undefined);
  requestScheduledScan();
  scanTimer = setInterval(() => {
    failedThisCycle.clear();
    resumeDeferredControls();
    drain();
    requestScheduledScan();
  }, DISCORD_LIMITS.scheduledScanMs);
  scanTimer.unref?.();

  const unsubscribeMessage = transport.onMessage((message) => {
    void handleInbound(message).catch((error: unknown) => {
      if (!signal?.aborted) {
        // A refused admission (for example a full durable queue) is reported without any message text.
        console.warn("Discord inbound message was not admitted.");
        void error;
      }
    });
  });
  const unsubscribeInteraction = transport.onInteraction((interaction) => handleInteraction(interaction));
  ready.resolve();

  try {
    await aborted(signal);
  } finally {
    stopping = true;
    unsubscribeMessage();
    unsubscribeInteraction();
    detachMcpSurface?.();
    if (scanTimer !== undefined) clearInterval(scanTimer);
    stopAllTyping();
    for (const receipt of [...receipts.values()]) await clearReceipt(receipt).catch(() => undefined);
    scope.cancel(new DOMException("Discord adapter stopped", "AbortError"));
    await Promise.allSettled([...active, ...pendingControls, ...scheduledTasks]);
    await transport.stop().catch(() => undefined);
  }
  if (fatal !== undefined) throw fatal;
}

// ── Module-level types and pure helpers ─────────────────────────────────────

type DeferredControl = {
  readonly key: string;
  readonly command: DiscordMutation;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly senderId: string;
  /** Admission instant of this command's own notice, so earlier inputs are ordered by the same rule. */
  readonly admittedAtMs: number;
  /** The `/model` preset argument, already validated against the configured catalog. */
  readonly option?: string;
};

/** A command with a native effect on this channel or this process; a refusal is terminal, never retried. */
type DiscordMutation = "new" | "abort" | "model" | "restart" | "digest";

type ControlOutcome =
  | { readonly kind: "applied"; readonly text?: string; readonly requestRestart?: true }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

type ParsedDiscordInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: DiscordControl; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string };

type DiscordControl = "new" | "abort" | "stop" | "help" | "status" | "model" | "restart" | "digest" | "mcp";

const DISCORD_COMMAND = /^\/([A-Za-z0-9_]{1,32})(?=\s|$)/u;

/** Classify one authenticated message body. Only a leading exact command token counts. */
function parseDiscordInput(raw: string): ParsedDiscordInput {
  if (!looksLikeDiscordCommand(raw)) return { kind: "input", text: raw };
  if (raw.startsWith("//")) return { kind: "input", text: raw.slice(1) };
  const match = DISCORD_COMMAND.exec(raw);
  if (match === null) return { kind: "input", text: raw };
  const command = match[1]!.toLowerCase();
  const args = raw.slice(match[0].length).trim();
  if (command === "new" || command === "abort" || command === "stop" || command === "help" ||
      command === "status" || command === "model" || command === "restart" || command === "digest" ||
      command === "mcp") {
    return { kind: "control", command, args };
  }
  return { kind: "unsupported", command };
}

/** The catalogued Discord controls this host really implements, in catalogue order. */
function offeredDiscordCommandNames(host: {
  readonly status: boolean;
  readonly model: boolean;
  readonly restart: boolean;
  readonly digest: boolean;
  readonly mcp: boolean;
}): readonly string[] {
  const offered: Record<string, boolean> = {
    new: true,
    abort: true,
    stop: true,
    help: true,
    status: host.status,
    model: host.model,
    restart: host.restart,
    digest: host.digest,
    mcp: host.mcp,
  };
  return conversationCommandNames("discord").filter((name) => offered[name] === true);
}

/**
 * The application commands to register: exactly the offered catalogue, with `/model`'s one optional
 * preset argument. Discord describes each command in at most 100 characters.
 */
function discordCommandSpecs(names: readonly string[]): DiscordCommandSpec[] {
  return offeredConversationCommands("discord", names).map((command) => ({
    name: command.name,
    description: command.summary.slice(0, 100),
    ...(command.name === "model"
      ? { option: { name: "preset", description: "Optional configured model preset name." } }
      : {}),
  }));
}

/**
 * Keep every unresolved record, only the most recent applied ones, and a reported terminal record
 * only while its report is still queued.
 */
function pruneControls(
  controls: readonly DiscordControlRecord[],
  pending: readonly DiscordPendingDelivery[],
): DiscordControlRecord[] {
  const totalApplied = controls.filter((entry) => entry.status === "applied").length;
  let drop = Math.max(0, totalApplied - MAX_UNRESOLVED_CONTROLS);
  const reported = new Set(pending.filter((item) => item.notice === true).flatMap((item) =>
    item.key.startsWith("unconfirmed:") ? [item.key, item.key.slice("unconfirmed:".length)] : [item.key]));
  return controls.filter((entry) => {
    if ((entry.status === "unconfirmed" || entry.status === "refused") && !reported.has(entry.key)) return false;
    if (entry.status !== "applied" || drop === 0) return true;
    drop -= 1;
    return false;
  });
}

function pushAdmitted(doc: Draft<DiscordChannelState>, key: string): void {
  doc.admitted = [...doc.admitted.filter((entry) => entry !== key), key]
    .slice(-DISCORD_LIMITS.maxAdmittedKeys);
}

/** Admission order within one channel: the timestamp first, then the identity as a stable tiebreak. */
function admissionBefore(left: { admittedAtMs: number; key: string }, right: { admittedAtMs: number; key: string }): boolean {
  if (left.admittedAtMs !== right.admittedAtMs) return left.admittedAtMs < right.admittedAtMs;
  return left.key < right.key;
}

function requestIdFor(botId: string, key: string): string {
  return `discord:${botId}:${key}`;
}

/**
 * Decode one Discord session key this adapter owns back to its channel and kind. Only keys this
 * adapter itself writes are decodable; anything else yields `undefined`.
 */
export function decodeDiscordSessionKey(
  sessionKey: string,
  botId: string,
): { readonly channelId: string; readonly kind: "channel" | "thread" | "dm" } | undefined {
  const dm = new RegExp(`^discord:${escapeRegExp(botId)}:dm:(\\d{1,20})$`, "u").exec(sessionKey);
  if (dm !== null) return { channelId: dm[1]!, kind: "dm" };
  const guild = new RegExp(
    `^discord:${escapeRegExp(botId)}:guild:(\\d{1,20}):(channel|thread):(\\d{1,20})$`,
    "u",
  ).exec(sessionKey);
  if (guild !== null) return { channelId: guild[3]!, kind: guild[2] as "channel" | "thread" };
  return undefined;
}

/** Drop one leading `<@id>`/`<@!id>` token for the bot itself; the rest of the text is unchanged. */
function stripLeadingSelfMention(content: string, botId: string): string {
  const trimmed = content.replace(/^\s+/u, "");
  for (const token of [`<@${botId}>`, `<@!${botId}>`]) {
    if (!trimmed.startsWith(token)) continue;
    const rest = trimmed.slice(token.length);
    // Only a standalone mention is a command prefix: `<@id>suffix` is ordinary text.
    if (rest !== "" && !/^\s/u.test(rest)) continue;
    return rest.replace(/^\s+/u, "");
  }
  return content;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function originBindingOf(
  origins: Readonly<Record<string, DiscordOriginBinding>> | undefined,
  channelId: string,
  botId: string,
): DiscordOriginBinding | undefined {
  if (origins === undefined) return undefined;
  const binding = origins[channelId];
  if (binding === undefined || binding.botId !== botId) return undefined;
  if (typeof binding.senderId !== "string" || !/^\d+$/u.test(binding.senderId)) return undefined;
  if (binding.kind !== "channel" && binding.kind !== "thread" && binding.kind !== "dm") return undefined;
  if (!Number.isSafeInteger(binding.admittedAtMs)) return undefined;
  return binding;
}

/** The canonical session key for one stored origin binding; only used for a bounded diagnostic. */
function sessionKeyForBinding(binding: DiscordOriginBinding | undefined, channelId: string): string {
  const kind = binding?.kind ?? "channel";
  if (kind === "dm") return `discord:${binding?.botId ?? "unknown"}:dm:${channelId}`;
  return `discord:${binding?.botId ?? "unknown"}:guild:unknown:${kind}:${channelId}`;
}

function outboxFaultMessage(error: unknown): string {
  return error instanceof CronDeliveryOutboxError
    ? error.message.slice(0, 200)
    : "delivery outbox could not be read";
}

const DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "pending", "sending", "unknown", "withheld", "delivered", "failed", "unauthorized",
]);

/** Why one stored outbox record cannot be delivered as-is, or `undefined` when it is usable. */
function pendingRecordProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "delivery outbox contains a record that is not an object";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return "delivery outbox contains a record without an ID";
  if (typeof record.sessionKey !== "string" || record.sessionKey === "") {
    return "delivery outbox contains a record without a session";
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return "delivery outbox contains a record without text";
  }
  if (typeof record.status !== "string" || !DELIVERY_STATUSES.has(record.status)) {
    return "delivery outbox contains a record with an unknown status";
  }
  if (record.nextChunkIndex !== undefined &&
      (!Number.isSafeInteger(record.nextChunkIndex) || (record.nextChunkIndex as number) < 0)) {
    return "delivery outbox contains a record with an invalid chunk cursor";
  }
  return undefined;
}

/** Validate the adapter options before any transport, conversation or network call. */
export function validateOptions(options: DiscordOptions): void {
  if (!Array.isArray(options.allowFrom) || options.allowFrom.length === 0) {
    throw new Error("Discord requires a non-empty allowFrom list of user snowflakes");
  }
  if (options.allowFrom.some((id) => !isSnowflake(id)) || new Set(options.allowFrom).size !== options.allowFrom.length) {
    throw new Error("Discord allowFrom must contain unique decimal user snowflakes");
  }
  for (const list of [options.dmAllowFrom, options.allowChannels]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((id) => !isSnowflake(id))) {
      throw new Error("Discord allowlists must contain decimal snowflakes");
    }
  }
  if (options.groupPolicy !== undefined && options.groupPolicy !== "mention" && options.groupPolicy !== "open") {
    throw new Error("Discord groupPolicy must be mention or open");
  }
  if (options.media !== undefined) {
    if (typeof options.media.workspace !== "string" || options.media.workspace.trim() === "") {
      throw new Error("Discord media.workspace must be a non-empty string");
    }
  }
  if (options.receipts !== undefined) {
    for (const emoji of [options.receipts.read, options.receipts.working]) {
      if (emoji === undefined || emoji === false) continue;
      if (typeof emoji !== "string" || emoji.trim() === "" || emoji.length > MAX_RECEIPT_EMOJI_CHARS) {
        throw new Error(`Discord receipts must be false or a short emoji (at most ${MAX_RECEIPT_EMOJI_CHARS} characters)`);
      }
    }
    if (options.receipts.delayMs !== undefined &&
        (!Number.isFinite(options.receipts.delayMs) || options.receipts.delayMs < 0 || options.receipts.delayMs > 10_000)) {
      throw new Error("Discord receipts.delayMs must be from 0 to 10000");
    }
  }
}

function boundedEmoji(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, MAX_RECEIPT_EMOJI_CHARS);
}

function createMediaStoreFor(options: DiscordMediaOptions | undefined): MediaStore | undefined {
  if (options === undefined) return undefined;
  return createMediaStore({
    workspace: options.workspace,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    // Discord originals live in their own child directory, so a locator never shares names with
    // another channel's stored original.
    childDirectory: "discord",
  });
}

/** Classify one Discord attachment by its declared content type, then by its extension. */
function attachmentKind(contentType: string | undefined, filename: string): MediaKind {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/")) return "photo";
  if (type.startsWith("audio/")) return "audio";
  if (type === "") {
    if (/\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(filename)) return "photo";
    if (/\.(?:mp3|ogg|wav|m4a|flac)$/iu.test(filename)) return "audio";
  }
  return "document";
}

const MEDIA_REJECTION_TEXT: Record<MediaRejected["reason"], string> = {
  "too-large": "too large for this host's attachment limit",
  "unsafe-path": "the original name could not be stored safely",
  "unsafe-directory": "the configured media directory is not usable",
  "empty": "the file was empty",
  "unavailable": "the download was refused",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Bound one response body by its advertised and actual size; the URL itself is never logged. */
async function* boundedResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(advertised) && advertised > maxBytes) throw new MediaRejected("too-large");
  if (response.body === null) throw new Error("Discord attachment response has no body");
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new MediaRejected("too-large");
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Bounded concurrency for attachment downloads, so a burst of media never blocks admission order. */
class MediaWorkGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason ?? new Error("media work cancelled"));
        };
        const resume = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiting.push(resume);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isConversationBusy(error: unknown): boolean {
  return error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
}

const CONTROL_ACK: Record<DiscordMutation, string> = {
  new: "Context reset.",
  abort: "Idle. Queue cleared.",
  model: "Model selected.",
  restart: "Restart requested; checking active work.",
  digest: "Digest requested.",
};

const CONTROL_PENDING: Record<DiscordMutation, string> = {
  new: "Reset pending.",
  abort: "Still stopping. New messages are held.",
  model: "Model change pending.",
  restart: "Restart pending.",
  digest: "Digest pending; not started yet.",
};

const UNCONFIRMED_CONTROL = "Command interrupted; outcome unknown. Send it again if needed.";
/** An interrupted restart is never repeated automatically, and resending it is the caller's decision. */
const UNCONFIRMED_RESTART = "Restart interrupted; outcome unknown. Not retried.";
/** The confirmation the replacement process owes the channel that asked for `/restart`. */
const RESTART_LIVE = "Restarted.";
/** The other half of that promise: the host refused the replacement, so this process is still serving. */
const RESTART_FAILED = "Restart refused. Gateway still running.";

const STATUS_UNAVAILABLE_HOST =
  "Status is unavailable in this host: it exposes no model/status metadata for this channel. Nothing was sent to the assistant.";
const MODEL_UNAVAILABLE_HOST =
  "Model commands are unavailable in this host: it exposes no preset catalog or preset selection. Nothing was sent to the assistant.";
const MODEL_LISTING_UNAVAILABLE =
  "Model choices are unavailable right now: this channel's host model catalog could not be read. Nothing changed.";
const MODEL_PRESETS_UNAVAILABLE =
  "Named model presets are not configured in this deployment, so /model <name> and /model default are unavailable. " +
  "Nothing was changed; /model lists the current selection read only, and this chat command never rewrites the configuration.";
const MCP_UNAVAILABLE_HOST =
  "MCP management is unavailable in this host: the gateway was opened without an on-disk configuration file, " +
  "so there is nothing to write. Nothing was sent to the assistant.";
const RESTART_UNAVAILABLE_HOST =
  "Restart is unavailable in this host: it cannot replace its own process with the same program and configuration. " +
  "Nothing was sent to the assistant.";
const RESTART_ALREADY_REQUESTED =
  "A restart was already requested in this gateway and is still stopping it; this /restart was not requested again.";
const RESTART_REQUEST_FAILED =
  "A restart was already requested in this gateway and the host refused it, so the gateway is still running. " +
  "This /restart was not requested again; fix the host and start the gateway yourself.";
const RESET_BUSY = "Reset refused: chat busy. /abort or retry /new when idle.";
const DIGEST_UNAVAILABLE_HOST =
  "Memory digestion is unavailable in this host: it exposes no manual digestion entry. Nothing was started and " +
  "nothing was sent to the assistant.";
const DELIVERY_FAILED_TEXT = "Your request could not be completed. Please try again.";

/** Bound one host notice; a shortened notice says so instead of dropping its tail silently. */
function boundNotice(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n… (truncated)";
  let end = Math.max(0, limit - marker.length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

/** A fixed Discord usage notice: the catalogue's line, a no-argument note, and the surface's tail. */
function usageNotice(name: string): string {
  const argumentsNote = findConversationCommand(name)?.args === undefined ? " (no arguments)." : "";
  return `${conversationCommandUsage(name, "discord")}${argumentsNote} Nothing was sent to the assistant.`;
}

/** Replay wording for a command this adapter recorded before a restart; it is never run twice. */
function replayControlText(entry: DiscordControlRecord): string {
  if (entry.command === "restart") {
    return entry.status === "applied"
      ? "That /restart was already requested before this process restarted, so it is not requested again."
      : "That /restart was interrupted before it was confirmed: it may or may not have restarted the gateway, and it " +
        "is not requested again.";
  }
  if (entry.status === "applied") return "That command was already applied before a restart, so it was not run again.";
  if (entry.status === "refused") {
    return "That command was refused before any effect and will not be retried; send it again if it is still needed.";
  }
  if (entry.status === "unconfirmed") {
    return "That command was already reported as interrupted; send it again if you still need it.";
  }
  return UNCONFIRMED_CONTROL;
}

type ModelArgument =
  | { readonly kind: "list" }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "usage" };

/** Bound a `/model` argument to the shape the config itself accepts: one name, never a selector triple. */
function parseModelArgument(args: string): ModelArgument {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "list" };
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 1) return { kind: "usage" };
  const name = parts[0]!;
  if (name.length > 80 || !/^[^\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u.test(name)) return { kind: "usage" };
  return { kind: "preset", name };
}

/** The configured preset this channel currently uses, matched by provider/model/thinking. */
function matchingPresetName(listing: GatewayModelList): string | undefined {
  const selected = listing.selected;
  return listing.presets?.find((preset) => preset.provider === selected.provider &&
    preset.modelId === selected.modelId && (preset.thinkingLevel ?? "off") === selected.thinkingLevel)?.name;
}
