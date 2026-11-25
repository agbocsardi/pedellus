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
import { defineDoc, AssistantEntry } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, observeOperation } from "../observability.js";
import type { Conversation, Submission, SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { FollowUpMode } from "../config.js";
import type { CronDeliveryRecord } from "../automation/cron-delivery.js";
import {
  conversationCommandNames,
  conversationCommandRefusal,
  conversationCommandUsage,
  conversationDetailBlock,
  conversationHelpListing,
  findConversationCommand,
  offeredConversationCommands,
} from "../help/commands.js";
import { renderMcpListing } from "../mcp/admin.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import {
  MEDIA_LIMITS,
  MediaRejected,
  createMediaStore,
  type MediaKind,
  type MediaStore,
} from "../media/attachments.js";
import { WorkGate, boundedResponseBody } from "../media/outbound.js";
import {
  AskDeliveryUnknown,
  AskQuestionsDoc,
  claimTypedQuestionAnswer,
  renderQuestionText,
} from "../questions/index.js";
import {
  detectHostCapabilities,
  offeredChannelCommandNames,
  type ChannelGateway,
  type HostRestartController,
} from "./contracts.js";
import {
  DIGEST_UNAVAILABLE_HOST,
  MCP_UNAVAILABLE_HOST,
  MODEL_LISTING_UNAVAILABLE,
  MODEL_UNAVAILABLE_HOST,
  RESTART_LIVE,
  RESTART_UNAVAILABLE_HOST,
  STATUS_UNAVAILABLE_HOST,
  admitOwedRestartNotices,
  createControlCoordinator,
  createRestartRequester,
  executeChannelControl,
  handleOAuthCallback,
  modelPresetRefusal,
  parseModelArgument,
  pruneControls,
  readModelListing,
  readStatusNotice,
  recoverInterruptedControls,
  renderDigestStatus,
  renderModelListing,
  unconfirmedControlText,
  type ChannelMutation,
  type ControlLedger,
  type ControlRecord,
} from "./controls.js";
import { createOutboxDrainer, outboxFaultMessage } from "./outbox-drainer.js";
import {
  SubmissionOrderQueue,
  createPreviewWatcher,
  isLiveGeneratingFor,
  resolveOwnerBusyMode,
  resolveSharedDeliveryGroup,
  sharedDeliveryRole,
  type SubmissionSlot,
} from "./turn-runtime.js";
import type { DiscordHistoryRead, DiscordHistoryRegistry, DiscordHistoryRequest } from "./discord-history.js";
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
  type DiscordReplyReference,
  type DiscordSendResult,
  type DiscordTransport,
} from "./discord-transport.js";

const MAX_ADMITTED = DISCORD_LIMITS.maxPending;
/** Unresolved commands kept at most; further commands are refused so a hung command cannot grow the log. */
const MAX_UNRESOLVED_CONTROLS = DISCORD_LIMITS.maxControls;
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

/** Host-owned full-process restart for the authenticated-owner `/restart` control. */
export type DiscordRestartHost = HostRestartController;

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

/** The shared channel host surface plus the late-bound read-only Discord history registry. */
export interface DiscordGateway extends ChannelGateway {
  /**
   * Late-bound registry for the read-only Discord history capability. The runtime creates it when
   * Discord is configured and offers the tool only in a mapped Discord chat; this adapter attaches
   * the live, call-time-checked host while it runs.
   */
  discordHistory?: DiscordHistoryRegistry;
}

type ChannelState = DiscordChannelState;

/** One admitted mutating control; its scope is the Discord channel it gates. */
type DiscordControl = ControlRecord<string, string> & {
  readonly channelId: string;
  readonly sessionKey: string;
  readonly senderId: string;
  /** Admission instant of this command's own notice, so earlier inputs are ordered by the same rule. */
  readonly admittedAtMs: number;
};

type TypingLoop = {
  turns: number;
  unavailable: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
};

type Receipt = {
  channelId: string;
  messageId: string;
  emojis: string[];
  workingTimer: ReturnType<typeof setTimeout> | undefined;
};

/** Discord labels strip `[`/`]` and say `(unnamed)` when nothing printable is left. */
const RENDER = { scope: "channel", emptyLabel: "(unnamed)" } as const;

export async function runDiscord(
  gateway: DiscordGateway,
  transport: DiscordTransport,
  options: DiscordOptions,
  context: Context,
): Promise<void> {
  validateOptions(options);
  const mediaStore = createMediaStoreFor(options.media);
  const mediaWork = new WorkGate(MEDIA_LIMITS.maxConcurrentWork);
  /**
   * Optional host operations this adapter may call, resolved once from the host surface. A narrow SDK
   * host keeps `/new`, `/abort` (and `/stop`) and `/help` only; the rest are neither advertised nor
   * applied, and typing one gets a truthful refusal instead of a half-working control.
   */
  const hostCommands = detectHostCapabilities(gateway, options.restart);
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
  let detachMcpSurface: (() => void) | undefined;
  let detachAskSurface: (() => void) | undefined;
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Ingress that arrives between the Gateway's READY and the end of durable recovery is buffered in
   * memory (bounded, never durable) and replayed in its original order afterwards. The alternative
   * would silently lose a message the owner already saw; the buffer grants no authority, because
   * every replayed event goes through the same admission checks it would have had.
   */
  let ingressReady = false;
  let ingressChain: Promise<void> = Promise.resolve();
  const startupIngress: DiscordInboundMessage[] = [];
  let startupOverflow = 0;
  let unsubscribeMessage: (() => void) | undefined;
  let unsubscribeInteraction: (() => void) | undefined;
  let detachHistory: (() => void) | undefined;
  /** One serial ingress order: a buffered replay and a live event never race for admission. */
  const enqueueIngress = (message: DiscordInboundMessage): void => {
    ingressChain = ingressChain
      .then(() => handleInbound(message))
      .catch(() => {
        if (!signal?.aborted) console.warn("Discord inbound message was not admitted.");
      });
  };
  /** Release every handle this adapter took, in the order a failed setup or a stop needs. */
  const teardownAdapters = async (): Promise<void> => {
    unsubscribeMessage?.();
    unsubscribeInteraction?.();
    detachHistory?.();
    detachMcpSurface?.();
    detachAskSurface?.();
    if (scanTimer !== undefined) clearInterval(scanTimer);
    await transport.stop().catch(() => undefined);
  };
  // Ingress capture is attached before any durable work: the Gateway has already reported READY, so
  // an event arriving now must be buffered (bounded, in memory) rather than silently lost.
  unsubscribeMessage = transport.onMessage((message) => {
    if (!ingressReady) {
      if (startupIngress.length >= DISCORD_LIMITS.maxStartupIngress) {
        startupOverflow += 1;
        return;
      }
      startupIngress.push(message);
      return;
    }
    enqueueIngress(message);
  });
  unsubscribeInteraction = transport.onInteraction((interaction) => {
    if (!ingressReady) {
      // A command cannot be acknowledged with its real outcome while recovery is still running, and
      // the acknowledgement window is three seconds. Answer with one fixed refusal; nothing is
      // admitted, stored or echoed, and the owner may retry once the gateway is serving.
      return Promise.resolve({ text: STARTUP_COMMAND_REFUSED, ephemeral: true });
    }
    return handleInteraction(interaction);
  });

  let stateConversation: Conversation;
  let state: ChannelState;
  try {
    stateConversation = await gateway.conversationFor(
      `discord:${identity}${CHANNEL_STATE_SESSION_SUFFIX}`,
      context,
    );
    state = await stateConversation.commit(async (tx) =>
      copyJson(await tx.doc(DiscordState, stateConversation.id)) as unknown as ChannelState,
    context);
  } catch (error) {
    await teardownAdapters();
    throw error;
  }
  const admittedWhenBusy = options.followUpMode === "steer" ? "steer" as const : undefined;

  const active = new Set<Promise<void>>();
  let activeReplies = 0;
  let activeNotices = 0;
  const delivering = new Set<string>();
  const failedThisCycle = new Set<string>();
  /** Submissions a control flush already placed, so the normal delivery path reuses that exact turn. */
  const earlySubmissions = new Map<string, Submission>();
  /** One submission order per Discord channel, shared by normal deliveries and control flushes. */
  const order = new SubmissionOrderQueue<string>();
  const typingLoops = new Map<string, TypingLoop>();
  const receipts = new Map<string, Receipt>();
  const deliveryFailures = new Map<string, number>();
  /**
   * A rate-limit window from a validated 429 hint. Discord's limits are per bot/token, so one shared
   * deadline gates ordinary sends and scheduled deliveries alike; waiting out the window never counts
   * as a failed attempt.
   */
  let cooldownUntilMs = 0;
  const cooldownOpen = (): boolean => Date.now() >= cooldownUntilMs;
  const noteRateLimit = (classified: { readonly status: number | undefined; readonly retryAfterMs: number | undefined }): void => {
    if (classified.status !== 429) return;
    const wait = Math.min(Math.max(classified.retryAfterMs ?? 1_000, 1_000), DISCORD_LIMITS.maxCooldownMs);
    cooldownUntilMs = Math.max(cooldownUntilMs, Date.now() + wait);
  };
  let fatal: unknown;
  let stopping = false;

  const adapterActive = (): boolean => !stopping && signal?.aborted !== true;
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
      dropReportedControls(doc);
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
      loop = { turns: 0, unavailable: false, stopped: false, timer: undefined };
      typingLoops.set(channelId, loop);
      const created = loop;
      const refresh = () => {
        if (created.stopped || stopping || signal?.aborted) return;
        void transport.typing(channelId).then(() => {
          if (created.stopped || signal?.aborted) return;
          if (created.unavailable) journalEvent("discord.typing.recovered", { "channel.id": channelId });
          created.unavailable = false;
        }).catch((error: unknown) => {
          if (created.stopped || signal?.aborted) return;
          if (!created.unavailable) journalEvent("discord.typing.failed", { "channel.id": channelId }, error);
          created.unavailable = true;
        });
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
      const admin = gateway.mcpAdmin;
      const { text } = await handleOAuthCallback(
        admin === undefined ? undefined : (callback) => admin.submitCallback(sessionKey, callback, adapterContext),
        commandText,
        { authenticated: binding !== undefined && binding.senderId === message.authorId, scope: "channel" },
      );
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
    const { quoted, referenced, stored } = await observeOperation("gateway.discord.ingress.prepare", {
      "message.key": key, "channel.id": channelId, attachments: message.attachments.length,
    }, async () => {
      const quoted = message.quoted ?? await fetchQuoted(message);
      return { quoted, referenced: await storeReferencedAttachments(quoted), stored: await storeAttachments(message) };
    });
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
      await outbox.reportFault(
        origin.evictedSessionKey,
        "origin admission binding evicted at capacity; a fresh admission restores it",
      );
    }
    // The binding this admission just recorded is the authorization evidence: a withheld scheduled
    // result for this channel is released now, and its own re-check still requires the live allowlist.
    await outbox.releaseWithheld(sessionKey);

    const admittedAtMs = Date.now();
    // A typed answer to this exact session's delivered question settles in the same commit that
    // admits it, so the question can neither stay open after its answer nor close without one. A
    // Gateway event is never redelivered, so a failed lookup admits the message without a claim
    // rather than losing it; the question then stays open for the next answer or its expiry.
    const answerConversation = gateway.askSurfaces !== undefined && claimsQuestion(commandText)
      ? await gateway.conversationFor(sessionKey, adapterContext).catch(() => undefined)
      : undefined;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(DiscordState, stateConversation.id);
      if (doc.admitted.includes(key)) return copyJson(doc) as unknown as ChannelState;
      if (doc.pending.length >= MAX_ADMITTED) {
        throw new Error("Discord durable output queue is full");
      }
      if (answerConversation !== undefined) {
        claimTypedQuestionAnswer(await tx.doc(AskQuestionsDoc, answerConversation.id), sessionKey, commandText, admittedAtMs);
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
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    // The exact input and its identity are durable before any model submission, so a crash cannot
    // lose or duplicate it.
    journalEvent("discord.admitted", { "message.key": key, "channel.id": channelId,
      attachments: attachments.length, "queue.depth": state.pending.length });
    markReading(channelId, message.id);
    drain();
  };

  const handleInteraction = async (interaction: DiscordInteraction): Promise<DiscordInteractionResponse> => {
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
    quoted: DiscordReplyReference | undefined,
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
  async function fetchQuoted(message: DiscordInboundMessage): Promise<DiscordReplyReference | undefined> {
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
    quoted: DiscordReplyReference | undefined,
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
    // A known rate-limit window is waited out deliberately: no request is attempted and no failure
    // counter moves until it opens, so a long cooldown cannot exhaust the retry bound.
    if (!cooldownOpen()) return;
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
      if (!notice && controls.gated(item.channelId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.key) || failedThisCycle.has(item.key)) continue;
      delivering.add(item.key);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = order.beginSubmission(item.channelId);
      const task = observeOperation("gateway.discord.delivery", {
        "message.key": item.key, "channel.id": item.channelId, notice,
        "queue.depth": state.pending.length, attempt: (deliveryFailures.get(item.key) ?? 0) + 1,
      }, (trace) => deliver(item, slot, trace)).catch(async (error: unknown) => {
        // The span logs safe failure causes; keep durable state for the next scan.
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

  const deliver = async (item: DiscordPendingDelivery, slot: SubmissionSlot, trace: TelemetrySpan): Promise<void> => {
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
    await observeOperation("gateway.discord.queue", {}, () => slot.prior, trace);
    const content = await observeOperation("gateway.discord.prepare", {}, () => prepareInputContent(item), trace);
    const conversation = await observeOperation("gateway.discord.conversation", {},
      () => gateway.conversationFor(item.sessionKey, adapterContext), trace);
    trace.setAttributes({ "conversation.id": conversation.id });
    const requestId = requestIdFor(identity, item.key);
    const streaming = options.streaming !== false;
    let submissionId: SubmissionId | undefined;
    let stopTyping: (() => void) | undefined;
    // Typing follows the committed live state, not submission: it shows only while this input's run
    // has an active generation attempt, and stops while queued, in a tool round, waiting or answered.
    const syncTyping = (live: Parameters<typeof isLiveGeneratingFor>[0]): void => {
      if (isLiveGeneratingFor(live, submissionId)) {
        stopTyping ??= startTyping(item.channelId);
        return;
      }
      stopTyping?.();
      stopTyping = undefined;
    };
    // One preview per run: the watcher publishes only for the run's first input, so a steered sibling
    // never sends a second preview. Without streaming the watch still drives the typing indicator.
    const watcher = await createPreviewWatcher({
      conversation,
      context: adapterContext,
      delayMs: DISCORD_LIMITS.previewEditMs,
      publish: streaming ? publishPreview : async () => undefined,
      onFrame: (_view, frame) => syncTyping(frame.live),
      ...(signal === undefined ? {} : { signal }),
    });
    const stopPreviewWatch = (): Promise<void> => watcher.stop();
    try {
      const early = earlySubmissions.get(item.key);
      earlySubmissions.delete(item.key);
      if (early === undefined) await gateway.beforeOwnerInput?.(item.sessionKey, conversation.id, content, adapterContext);
      // The admission itself decided the busy-mode, so a later configuration change cannot redefine it.
      const submission = early ?? await conversation.submit({
        type: "input",
        content,
        requestId,
        whenBusy: await submissionMode(conversation, item),
      }, withTelemetry(trace, adapterContext));
      // Ordering is established; free the channel's next submission place while this turn runs.
      slot.release();
      submissionId = submission.id;
      watcher.setSubmission(submission.id);
      // The current watch value may already hold this run's generation; later frames cover the rest.
      syncTyping(watcher.value.docs["pi.live"] as Parameters<typeof isLiveGeneratingFor>[0]);
      trace.setAttributes({ "submission.id": submission.id });
      const settled = await observeOperation("gateway.discord.settlement", { "submission.id": submission.id },
        () => submission.wait(adapterContext), trace);
      trace.setAttributes({ status: settled.status });
      if (settled.status !== "done" || settled.type !== "input") {
        // A native abort or a queued reset deliberately ends the turn: it is not a delivery failure.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        trace.setAttributes({ intentional });
        if (!intentional) trace.setStatus({ status: "error" });
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
      const settlement = settled.answer;
      const group = await sharedDeliveryGroup(conversation.id, item, settlement);
      const role = sharedDeliveryRole(group.group, item.key, group.present);
      trace.setAttributes({ outcome: role });
      await stopPreviewWatch();
      if (role === "owner") {
        await observeOperation("gateway.discord.reply", {}, () => flushFinal(text), trace);
        await retireSharedDelivery(conversation, item, settlement);
      } else if (role === "sibling") {
        await forget(item.key);
      }
    } finally {
      await stopPreviewWatch();
      stopTyping?.();
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
        noteRateLimit(classified);
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
        noteRateLimit(classified);
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
   * The native busy-mode for one admitted message: only a message admitted under `steer` may steer,
   * and only into a run one of this session's own admitted messages started; anything else queues.
   */
  const submissionMode = (conversation: Conversation, current: DiscordPendingDelivery): Promise<"steer" | "followUp"> =>
    resolveOwnerBusyMode(conversation, current.whenBusy, state.pending
      .filter((candidate) => candidate.sessionKey === current.sessionKey)
      .map((candidate) => requestIdFor(identity, candidate.key)), adapterContext);

  /**
   * The admitted messages of this session whose submission settled with this committed answer, read
   * in one state transaction with this delivery's own pending presence.
   */
  const sharedDeliveryGroup = async (
    conversationId: Conversation["id"],
    current: DiscordPendingDelivery,
    answer: number,
  ) => stateConversation.commit(async (tx) => {
    const doc = await tx.doc(DiscordState, stateConversation.id);
    const present = doc.pending.some((candidate) => candidate.key === current.key);
    const group = await resolveSharedDeliveryGroup(tx, conversationId, doc.pending
      .filter((candidate) => candidate.sessionKey === current.sessionKey)
      .map((candidate) => ({ key: candidate.key, requestId: requestIdFor(identity, candidate.key) })), answer);
    return { group, present };
  }, adapterContext);

  /**
   * One commit that retires this delivery owner and every still-pending sibling of the same answer,
   * so a delivered shared answer can never be sent again by a record left behind by a crash.
   */
  const retireSharedDelivery = async (conversation: Conversation, current: DiscordPendingDelivery, answer: number) => {
    const { group } = await sharedDeliveryGroup(conversation.id, current, answer);
    const retired = new Set(group.keys);
    retired.add(current.key);
    for (const key of retired) {
      deliveryFailures.delete(key);
      earlySubmissions.delete(key);
    }
    await mutateState((doc) => {
      doc.pending = doc.pending.filter((entry) => !retired.has(entry.key));
      dropReportedControls(doc);
    }, cleanupContext);
  };

  // ── Owner commands ────────────────────────────────────────────────────────

  type NoticeTarget = { readonly channelId: string; readonly sessionKey: string; readonly senderId: string };

  /** Queue one bounded notice in a state draft; `false` when the durable queue is full. */
  const pushNotice = (
    doc: Draft<ChannelState>,
    key: string,
    target: NoticeTarget,
    text: string,
    limit: number = MAX_NOTICE_CHARS,
    extra: { readonly hold?: true; readonly admittedAtMs?: number } = {},
  ): boolean => {
    if (doc.pending.length >= MAX_ADMITTED) return false;
    doc.pending.push({
      key,
      channelId: target.channelId,
      sessionKey: target.sessionKey,
      senderId: target.senderId,
      text: boundNotice(text, limit),
      admittedAtMs: extra.admittedAtMs ?? Date.now(),
      nextChunkIndex: 0,
      notice: true,
      ...(extra.hold === true ? { hold: true } : {}),
    });
    return true;
  };

  /** Deliver one bounded host notice through the same durable queue every other answer uses. */
  const admitNotice = async (
    key: string,
    target: NoticeTarget,
    text: string,
    limit: number = MAX_NOTICE_CHARS,
    hold = false,
    dedupe = true,
  ): Promise<void> => {
    await mutateState((doc) => {
      if (dedupe && doc.pending.some((entry) => entry.key === key)) return;
      if (!pushNotice(doc, key, target, text, limit, hold ? { hold: true } : {})) {
        throw new Error("Discord durable output queue is full");
      }
    });
    if (!hold) drain();
  };

  /**
   * Whether a queued notice is already being (or was partly) sent. Its text is fixed then: the sender
   * removes the record when it finishes, so an outcome written into it would be dropped unseen.
   */
  const noticeInFlight = (item: Draft<DiscordPendingDelivery>): boolean =>
    delivering.has(item.key) || item.sendIntent !== undefined || item.deliveryStatus !== undefined ||
    item.nextChunkIndex > 0;

  /**
   * Rewrite (when given) and release a still-queued acknowledgement; `false` when it is gone or
   * already in flight, so the caller queues the outcome as a separate notice instead.
   */
  const releaseNotice = (doc: Draft<ChannelState>, key: string, text: string | undefined): boolean => {
    const notice = doc.pending.find((item) => item.notice === true && item.key === key);
    if (notice === undefined || noticeInFlight(notice)) return false;
    delete notice.hold;
    if (text !== undefined) notice.text = boundNotice(text, MAX_NOTICE_CHARS);
    return true;
  };

  /** A command keeps its terminal record only while one of its reports is still queued. */
  const pruneRecords = (
    controls: readonly DiscordControlRecord[],
    pending: readonly DiscordPendingDelivery[],
  ): DiscordControlRecord[] => {
    const reported = reportedControlKeys(pending);
    return pruneControls(controls, (entry) => reported.has(entry.key), MAX_UNRESOLVED_CONTROLS);
  };

  const setControlStatus = (doc: Draft<ChannelState>, key: string, status: DiscordControlRecord["status"]) => {
    const entry = doc.controls.find((item) => item.key === key);
    if (entry !== undefined) entry.status = status;
    return entry;
  };

  const lateKey = (key: string): string => `late:${key}`;

  /** Queue one control's outcome as its own `late:` notice, beside an acknowledgement that is gone or in flight. */
  const queueLate = (doc: Draft<ChannelState>, record: DiscordControl, text: string): boolean =>
    doc.pending.some((entry) => entry.key === lateKey(record.key)) ||
    pushNotice(doc, lateKey(record.key), record, text, MAX_LATE_CONTROL_CHARS);

  /** The durable commits of one mutating control, each against this adapter's channel state. */
  const ledger: ControlLedger<string, string, DiscordControl> = {
    status: (key) => state.controls.find((entry) => entry.key === key)?.status,
    unresolved: () => pruneRecords(state.controls, state.pending)
      .filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length,
    async admit(record, ackText) {
      await mutateState((doc) => {
        if (!doc.controls.some((entry) => entry.key === record.key)) {
          doc.controls = pruneRecords([...doc.controls, {
            key: record.key,
            command: record.command,
            status: "admitted" as const,
            channelId: record.channelId,
            senderId: record.senderId,
          }], doc.pending);
        }
        if (!doc.pending.some((entry) => entry.key === record.key) &&
            !pushNotice(doc, record.key, record, ackText, MAX_NOTICE_CHARS, { hold: true, admittedAtMs: record.admittedAtMs })) {
          throw new Error("Discord durable output queue is full");
        }
      });
    },
    async markApplied(record) {
      await mutateState((doc) => {
        const entry = setControlStatus(doc, record.key, "applied");
        // The host replaces the process only after this commit, so the owed confirmation is durable first.
        if (record.command === "restart" && entry !== undefined) {
          const owed = doc.restart ?? [];
          if (!owed.some((item) => item.channelId === record.channelId)) {
            doc.restart = [...owed, { channelId: record.channelId, senderId: entry.senderId }]
              .slice(-MAX_RESTART_CONFIRMATIONS);
          }
        }
        doc.controls = pruneRecords(doc.controls, doc.pending);
      });
    },
    async release(key, text) {
      await mutateState((doc) => { releaseNotice(doc, key, text); }, cleanupContext);
      drain();
    },
    async markRefused(record, text, late) {
      await mutateState((doc) => {
        setControlStatus(doc, record.key, "refused");
        if (!releaseNotice(doc, record.key, text) && late === true) queueLate(doc, record, text);
        doc.controls = pruneRecords(doc.controls, doc.pending);
      }, cleanupContext);
    },
    async markUnconfirmed(key, text, lateRecord) {
      await mutateState((doc) => {
        setControlStatus(doc, key, "unconfirmed");
        if (!releaseNotice(doc, key, text) && lateRecord !== undefined) queueLate(doc, lateRecord, text);
      }, cleanupContext);
    },
    async publishLate(record, text) {
      await mutateState((doc) => {
        if (!releaseNotice(doc, record.key, text) && !queueLate(doc, record, text)) {
          throw new Error("Discord durable output queue is full");
        }
      }, cleanupContext);
      drain();
    },
    refuse: (record, text) => admitNotice(record.key, record, text),
  };

  /**
   * The one host restart request of this adapter lifetime. A refusal is a known no-effect: it is
   * reported to every channel that asked and never upgraded into a success claim.
   */
  const restartRequester = createRestartRequester(options.restart, {
    label: "Discord",
    onRefused(text) {
      void mutateState((doc) => {
        admitRestartNotices(doc, text);
        delete doc.restart;
      }, adapterContext).then(() => {
        if (adapterActive()) drain();
      }).catch(() => undefined);
    },
  });

  /**
   * Durable admission, per-channel gating, ordered flush of earlier inputs, bounded deferral and
   * truthful outcomes of every mutating control. A channel stays gated while its command is
   * unresolved, so no later message can overtake it.
   */
  const controls = createControlCoordinator<string, string, DiscordControl, DiscordPendingDelivery>({
    ledger,
    flush: {
      inputs: (record) => state.pending.filter((item) =>
        item.notice !== true && item.channelId === record.channelId &&
        admissionBefore(item, record) && options.allowFrom.includes(item.senderId)),
      // An input delivered or withdrawn meanwhile is skipped; attachments are prepared as usual.
      prepareInput: async (input) =>
        state.pending.some((entry) => entry.key === input.key) ? prepareInputContent(input) : undefined,
      async submit(input, content) {
        const conversation = await gateway.conversationFor(input.sessionKey, adapterContext);
        await gateway.beforeOwnerInput?.(input.sessionKey, conversation.id, content, adapterContext);
        const submission = await conversation.submit({
          type: "input",
          content: typeof content === "string" ? content : [...content],
          requestId: requestIdFor(identity, input.key),
          whenBusy: await submissionMode(conversation, input),
        }, adapterContext);
        // The normal delivery path reuses this turn, so a control-forced input is answered once.
        earlySubmissions.set(input.key, submission);
      },
    },
    order,
    execute: (record) => executeChannelControl(gateway, record, adapterContext, RENDER),
    requestRestart: () => restartRequester.request(),
    onFatal(error) {
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("Discord control command failed"));
    },
    drain: () => drain(),
    active: adapterActive,
    maxUnresolved: MAX_UNRESOLVED_CONTROLS,
  });

  /** Apply one authenticated control: a read-only notice, or a durable record plus a native call. */
  async function handleControl(
    target: { readonly key: string; readonly channelId: string; readonly sessionKey: string; readonly senderId: string },
    parsed: Exclude<ParsedDiscordInput, { kind: "input" }>,
    interaction: boolean,
  ): Promise<void> {
    const recorded = state.controls.find((entry) => entry.key === target.key);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of running it twice.
      const text = await controls.replay(recorded);
      if (text !== undefined) await admitNotice(target.key, target, text);
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
      await admitNotice(target.key, target, await readStatusNotice(gateway, target.sessionKey, RENDER.scope, adapterContext));
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
      const listing = await readModelListing(gateway, target.sessionKey, adapterContext);
      if (argument.kind === "list") {
        await admitNotice(target.key, target,
          listing === undefined ? MODEL_LISTING_UNAVAILABLE : renderModelListing(listing, RENDER));
        return;
      }
      const refusal = modelPresetRefusal(listing, argument.name);
      if (refusal !== undefined) {
        await admitNotice(target.key, target, refusal);
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
      const refusal = restartRequester.admissionRefusal();
      if (refusal !== undefined) {
        await admitNotice(target.key, target, refusal);
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
        await admitNotice(target.key, target, await renderDigestStatus(gateway, target.sessionKey, adapterContext));
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

  /** Admit one native mutation: durable record and held acknowledgement before the effect. */
  async function admitControl(
    target: { readonly key: string; readonly channelId: string; readonly sessionKey: string; readonly senderId: string },
    command: ChannelMutation,
    option?: string,
  ): Promise<void> {
    await controls.admit({
      key: target.key,
      scope: target.channelId,
      command,
      channelId: target.channelId,
      sessionKey: target.sessionKey,
      senderId: target.senderId,
      admittedAtMs: Date.now(),
      ...(option === undefined ? {} : { option }),
    });
  }

  function availableCommandNames(): readonly string[] {
    return offeredChannelCommandNames("discord", hostCommands);
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
  function admitRestartNotices(doc: Draft<ChannelState>, text: string): Draft<DiscordRestartRecord>[] {
    return admitOwedRestartNotices(doc.restart ?? [], (record) => {
      const key = `restart:${record.channelId}`;
      if (doc.pending.some((item) => item.key === key)) return false;
      return pushNotice(doc, key, {
        channelId: record.channelId,
        sessionKey: noticeSessionKey(record.channelId),
        senderId: record.senderId,
      }, text);
    }, (record) => options.allowFrom.includes(record.senderId));
  }

  // ── Scheduled results and interruption notices ───────────────────────────

  /**
   * Send one chunk of a scheduled record behind its write-ahead intent. `sent` advances the durable
   * cursor; `kept` leaves the record in the state already committed (pending, unknown or failed).
   */
  const sendScheduledChunk = async (
    sessionKey: string,
    recordId: string,
    channelId: string,
    chunk: string,
    index: number,
  ): Promise<"sent" | "kept"> => {
    const clearIntent = () => outbox.update(sessionKey, recordId, (entry) => {
      if (entry.status === "sending" || entry.sendIntent !== undefined) {
        entry.status = "pending";
        delete entry.sendIntent;
      }
    });
    // The bot-wide rate-limit window gates every chunk, not only the record's dispatch.
    if (!cooldownOpen()) return "kept";
    let requestStarted = false;
    try {
      const intent = await outbox.update(sessionKey, recordId, (entry) => {
        if (entry.status !== "pending") return;
        entry.status = "sending";
        entry.sendIntent = { text: chunk, chunkIndex: index, startedAt: Date.now() };
      }, adapterContext);
      // Only a committed intent on a live pending record may precede the send.
      if (intent?.status !== "sending" || intent.sendIntent?.chunkIndex !== index) return "kept";
      requestStarted = true;
      await transport.send({ channelId, text: chunk });
      const accepted = await outbox.update(sessionKey, recordId, (entry) => {
        entry.status = "pending";
        delete entry.sendIntent;
        delete entry.unknownSince;
        entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
      });
      return accepted === undefined ? "kept" : "sent";
    } catch (error) {
      if (!requestStarted) {
        // A failed/aborted intent commit made no external request. Do not quarantine it as an
        // ambiguous Discord send; keep it retryable.
        await clearIntent().catch(async (clearError: unknown) => {
          await outbox.reportFault(sessionKey, outboxFaultMessage(clearError));
        });
        if (!signal?.aborted) await outbox.reportFault(sessionKey, outboxFaultMessage(error));
        return "kept";
      }
      const classified = classifyDiscordError(error);
      noteRateLimit(classified);
      if (classified.outcome === "unknown") {
        await outbox.markUnknown(sessionKey, recordId);
      } else if (classified.outcome === "not-sent") {
        await clearIntent();
      } else {
        await outbox.markFailed(sessionKey, recordId, "Discord refused this delivery");
      }
      return "kept";
    }
  };

  /**
   * The host's durable outbox for completed cron results and interruption notices. The session key
   * is only a candidate locator: durable admission evidence for this bot and channel authorizes each
   * delivery, re-checked against the live configuration.
   */
  const outbox = createOutboxDrainer<{ readonly channelId: string }>({
    outbox: gateway.cronOutbox,
    context: adapterContext,
    cleanupContext,
    decodeSession: (sessionKey) => {
      const decoded = decodeDiscordSessionKey(sessionKey, identity);
      return decoded === undefined ? undefined : { channelId: decoded.channelId };
    },
    scopeOf: (target) => target.channelId,
    authorizeOrigin: (target) => {
      const binding = originBindingOf(state.origins, target.channelId, identity);
      // Missing evidence is a reversible hold: a later authenticated admission restores it.
      if (binding === undefined) {
        return { status: "withheld", reason: "origin channel has no durable admission evidence" };
      }
      return authorizedOrigin(target.channelId) === undefined ? { status: "unauthorized" } : { status: "deliver" };
    },
    async deliverRecord(sessionKey, target, record: CronDeliveryRecord) {
      const chunks = splitDiscordText(record.text);
      for (let index = record.nextChunkIndex; index < chunks.length; index++) {
        if (await sendScheduledChunk(sessionKey, record.id, target.channelId, chunks[index]!, index) !== "sent") {
          return "kept";
        }
      }
      return "delivered";
    },
    // A known rate-limit window is waited out: nothing is attempted until it opens.
    admitDispatch: () => cooldownOpen(),
    observe: (_sessionKey, target, record, run) => observeOperation("gateway.discord.scheduled_delivery", {
      "channel.id": target.channelId, "delivery.id": record.id,
    }, run),
    maxActive: DISCORD_LIMITS.maxScheduledActive,
    active: adapterActive,
    label: "Discord",
  });

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

  detachMcpSurface = gateway.mcpSurfaces?.attach({
    owns: (sessionKey) => adapterActive() && ownerChannelFor(sessionKey) !== undefined,
    async deliverAuthorization(sessionKey, authorization, _context) {
      if (!adapterActive()) throw new Error("the Discord adapter is stopping");
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

  // ── Owner questions (`ask_user`) ──────────────────────────────────────────

  /**
   * Deliver one already-durable question to the exact authenticated channel that owns its session,
   * as plain text with numbered options; the owner answers with an ordinary message, claimed at
   * admission. An ambiguous send is reported unknown, so the question is quarantined, never resent.
   */
  detachAskSurface = gateway.askSurfaces?.attach({
    owns: (sessionKey) => adapterActive() && ownerChannelFor(sessionKey) !== undefined,
    async deliverQuestion(sessionKey, question) {
      if (!adapterActive()) throw new Error("the Discord adapter is stopping");
      const owner = ownerChannelFor(sessionKey);
      if (owner === undefined) throw new Error("the requesting Discord channel is no longer authorized");
      try {
        await transport.send({ channelId: owner.channelId, text: renderQuestionText(question, "cli", Date.now()) });
      } catch (error) {
        const classified = classifyDiscordError(error);
        noteRateLimit(classified);
        if (classified.outcome === "unknown") throw new AskDeliveryUnknown();
        throw new Error("Discord refused the question message");
      }
    },
  });

  // ── Read-only history host ────────────────────────────────────────────────

  /**
   * The model-facing history tool resolves this at call time. Authorization is recomputed from the
   * durable admission evidence and the *current* configuration on every read, so a channel removed
   * from the allowlist, a sender removed from `allowFrom`/`dmAllowFrom`, or a stopped adapter loses
   * access immediately. The transport then checks this sender's own Discord permissions (never only
   * the bot's) and fails closed when it cannot.
   */
  detachHistory = gateway.discordHistory?.attach({
    async read(sessionKey, request: DiscordHistoryRequest): Promise<DiscordHistoryRead> {
      const decoded = decodeDiscordSessionKey(sessionKey, identity);
      if (decoded === undefined) return { ok: false, refusal: "forbidden" };
      const owner = ownerChannelFor(sessionKey);
      if (owner === undefined) return { ok: false, refusal: "forbidden" };
      if (transport.history === undefined) return { ok: false, refusal: "unsupported" };
      if (decoded.kind !== "dm" && decoded.guildId === undefined) return { ok: false, refusal: "forbidden" };
      // A direct message has no guild to select a channel in: the only readable history is that DM.
      if (decoded.kind === "dm" && (request.channelId !== undefined || request.channelName !== undefined)) {
        return { ok: false, refusal: "forbidden" };
      }
      try {
        return await transport.history({
          ...request,
          viewerId: owner.senderId,
          guildId: decoded.kind === "dm" ? null : decoded.guildId!,
          sessionMode: decoded.kind,
          sessionChannelId: decoded.channelId,
          allowChannels: options.allowChannels ?? [],
        });
      } catch {
        // The capability is live; the read itself failed. Never surface transport text.
        return { ok: false, refusal: "read-failed" };
      }
    },
  });
  if (gateway.discordHistory !== undefined && transport.history === undefined) {
    // A registry with a transport that cannot read history still answers every call with one fixed
    // refusal; the tool is never listed as a capability that silently returns nothing.
    detachHistory ??= gateway.discordHistory.attach({
      async read(): Promise<DiscordHistoryRead> {
        return { ok: false, refusal: "unsupported" };
      },
    });
  }

  // ── Recovery on open ──────────────────────────────────────────────────────

  try {
    // A control recorded but never confirmed may or may not have taken effect: report it once, never replay it.
    if (state.controls.some((entry) => entry.status === "admitted") || state.pending.some((item) => item.hold === true)) {
      let interrupted = 0;
      await mutateState((doc) => {
        for (const entry of doc.controls) {
          if (entry.status !== "admitted") continue;
          const notice = doc.pending.find((item) => item.notice === true && item.key === entry.key);
          if (notice === undefined || notice.hold === true) continue;
          // Its "still pending" wording was released but the outcome never followed: an unsent one
          // becomes the outcome; one whose send is already in flight or ambiguous keeps its record,
          // and the outcome goes out as a separate notice.
          const text = unconfirmedControlText(entry.command);
          if (!noticeInFlight(notice)) notice.text = text;
          else pushNotice(doc, `unconfirmed:${entry.key}`, notice, text);
        }
        interrupted = recoverInterruptedControls(doc.controls, doc.pending, {
          controlKey: (entry) => entry.key,
          noticeKey: (item) => item.key,
          report: (entry, text) => pushNotice(doc, `unconfirmed:${entry.key}`, {
            channelId: entry.channelId,
            sessionKey: `discord:${identity}:notice:${entry.channelId}`,
            senderId: entry.senderId,
          }, text),
        });
      }, adapterContext);
      if (interrupted > 0) {
        console.warn(`Discord ${interrupted} control command(s) were interrupted; their effect is unconfirmed.`);
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
    await outbox.recover();
    recoveryComplete = true;
    journalEvent("discord.serving", { "queue.depth": state.pending.length });
    drain();
    // Cosmetic and best effort: a slow or failed registration must not delay ingress.
    void transport.registerCommands(discordCommandSpecs(availableCommandNames())).catch(() => undefined);
    outbox.requestScan();
    scanTimer = setInterval(() => {
      failedThisCycle.clear();
      controls.resumeDeferred();
      drain();
      outbox.requestScan();
    }, DISCORD_LIMITS.scheduledScanMs);
    scanTimer.unref?.();
  } catch (error) {
    // A failed recovery or service start must not leave a half-open Gateway with buffered ingress.
    await teardownAdapters();
    throw error;
  }

  // Recovery is done: replay the buffered ingress in its original order, then admit live events
  // directly. Both paths use the same serial chain, so ordering never depends on arrival timing.
  ingressReady = true;
  if (startupOverflow > 0) {
    console.warn(
      `Discord startup ingress overflow: ${startupOverflow} event(s) arrived before recovery finished and were not admitted.`,
    );
  }
  for (const buffered of startupIngress.splice(0)) enqueueIngress(buffered);

  try {
    await aborted(signal);
  } finally {
    stopping = true;
    // Stop accepting events, then abort and drain already-admitted ingress
    // before taking the active-task snapshot or closing the transport/store.
    unsubscribeMessage?.();
    unsubscribeInteraction?.();
    detachHistory?.();
    detachMcpSurface?.();
    detachAskSurface?.();
    scope.cancel(new DOMException("Discord adapter stopped", "AbortError"));
    await ingressChain;
    stopAllTyping();
    for (const receipt of [...receipts.values()]) await clearReceipt(receipt).catch(() => undefined);
    await Promise.allSettled([...active, controls.idle(), outbox.idle()]);
    await teardownAdapters();
  }
  if (fatal !== undefined) throw fatal;
}

// ── Module-level types and pure helpers ─────────────────────────────────────

type ParsedDiscordInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: DiscordCommand; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string };

type DiscordCommand = "new" | "abort" | "stop" | "help" | "status" | "model" | "restart" | "digest" | "mcp";

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

/** The control one queued notice reports: its own acknowledgement or an `unconfirmed:`/`late:` follow-up. */
function reportedControlKeys(pending: readonly DiscordPendingDelivery[]): Set<string> {
  const keys = new Set<string>();
  for (const item of pending) {
    if (item.notice !== true) continue;
    const prefix = ["unconfirmed:", "late:"].find((candidate) => item.key.startsWith(candidate));
    keys.add(prefix === undefined ? item.key : item.key.slice(prefix.length));
  }
  return keys;
}

/** Drop refused/unconfirmed records once no report of them is queued; a later report keeps them. */
function dropReportedControls(doc: Draft<DiscordChannelState>): void {
  const reported = reportedControlKeys(doc.pending);
  doc.controls = doc.controls.filter((entry) =>
    !((entry.status === "unconfirmed" || entry.status === "refused") && !reported.has(entry.key)));
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
): { readonly channelId: string; readonly kind: "channel" | "thread" | "dm"; readonly guildId?: string } | undefined {
  const dm = new RegExp(`^discord:${escapeRegExp(botId)}:dm:(\\d{1,20})$`, "u").exec(sessionKey);
  if (dm !== null) return { channelId: dm[1]!, kind: "dm" };
  const guild = new RegExp(
    `^discord:${escapeRegExp(botId)}:guild:(\\d{1,20}):(channel|thread):(\\d{1,20})$`,
    "u",
  ).exec(sessionKey);
  if (guild !== null) {
    return { channelId: guild[3]!, kind: guild[2] as "channel" | "thread", guildId: guild[1]! };
  }
  return undefined;
}

/**
 * Whether a mention-stripped body may answer a pending question: it says something, and it is not a
 * command, even when an attachment routed it to ordinary input instead of control parsing.
 */
function claimsQuestion(body: string): boolean {
  if (body.trim() === "") return false;
  return !looksLikeDiscordCommand(body) || parseDiscordInput(body).kind === "input";
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

function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const DELIVERY_FAILED_TEXT = "Your request could not be completed. Please try again.";
/** One fixed reply for a command that arrived before durable recovery finished. */
const STARTUP_COMMAND_REFUSED =
  "The gateway is still starting, so this command was not accepted and nothing changed. Try again in a moment.";

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
