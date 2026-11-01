import { defineDoc, AssistantEntry, ConversationBusy } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import { Api, GrammyError, HttpError, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { ApiClientOptions } from "grammy";
import type { MessageReactionUpdated, ReactionType, ReactionTypeEmoji, Update } from "grammy/types";
import type { Conversation, Submission, SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CronDeliveryOutbox, CronDeliveryRecord } from "../automation/cron-delivery.js";
import { CronDeliveryOutboxError } from "../automation/cron-delivery.js";
import {
  renderMemoryDigestStart,
  renderMemoryDigestStatus,
} from "../history/memory-digest.js";
import { MCP_ADMIN_LIMITS, renderMcpApproval, renderMcpListing } from "../mcp/admin.js";
import type {
  GatewayMcpAdmin,
  GatewayMemoryDigest,
  GatewayModelList,
  GatewayModelSelection,
  GatewaySessionReset,
} from "../runtime.js";
import { inProcessTerminalConversation } from "../terminal/conversation.js";
import { renderBackgroundStatus, type BackgroundStatus } from "../background-status.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import { MEDIA_LIMITS, MediaRejected, createMediaStore, type MediaRejectionReason, type MediaStore, type StoredMedia } from "../media/attachments.js";
import { createTranscriber, type Transcriber, type TranscriptionBackend, type TranscriptionFailure, type WhisperCliEngine } from "../media/transcription.js";
import {
  TELEGRAM_FILE_ORIGIN,
  TELEGRAM_MEDIA_LIMITS,
  attachmentContextText,
  boundedFileBody,
  disabledAttachmentText,
  planTelegramMedia,
  telegramFilePath,
  telegramFileUrl,
  unsupportedAttachmentText,
  type AttachmentSpeech,
  type TelegramPendingAttachment,
} from "./telegram-media.js";
import {
  TELEGRAM_ACTION_LIMITS,
  TELEGRAM_TARGET_LIMITS,
  actionFor,
  admitAction,
  findTarget,
  incomingContextText,
  observeTarget,
  reactionChangeText,
  settleActionRecord,
  targetsForChat,
  unresolvedActions,
  validTelegramFilePath,
  type TelegramActionRecord,
  type TelegramObservedTarget,
  type TelegramQuotedContext,
} from "./telegram-interactions.js";
import {
  PLAIN_TEXT_LIMIT,
  RICH_TEXT_LIMIT,
  disableRichMessages,
  escapeTelegramLiteral,
  isRichCapabilityRejection,
  isRichFormatRejection,
  richMessagesEnabled,
  splitRichText,
} from "./telegram-rich.js";
import {
  TELEGRAM_SEND_METHODS,
  TelegramOutboundRejected,
  outboundRejectionText,
  readTelegramOutboundFile,
} from "./telegram-outbound-media.js";
import type {
  TelegramActionHost,
  TelegramActionOutcome,
  TelegramActionRegistry,
  TelegramActionRequest,
  TelegramSendRequest,
} from "./telegram-tool.js";
import { isTelegramSendRequest } from "./telegram-tool.js";

const API = "https://api.telegram.org";
/** The `sendMessage` limit; a rich message uses `RICH_TEXT_LIMIT` and falls back to this. */
const TELEGRAM_LIMIT = PLAIN_TEXT_LIMIT;
const MAX_ADMITTED = 1000;
const MAX_API_ATTEMPTS = 5;
const POLL_TIMEOUT_MAX = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FLOOD_WAIT_BUDGET_MS = 5 * 60_000;
/** How long a command acknowledgement waits for its native call before reporting that it is still pending. */
const CONTROL_PENDING_NOTICE_MS = 30_000;
/** Consecutive delivery failures after which a non-Telegram-rejected failure is held instead of retried forever. */
const MAX_DELIVERY_FAILURES = 10;
/** Bounded poll-cadence retries for a command whose earlier ordered inputs keep failing transiently. */
const MAX_CONTROL_ATTEMPTS = 10;
const FLOOD_WAIT_WITHOUT_HINT_MS = 1_000;
const COMMAND_NAME_MAX = 32;
const BOT_MENTION_MAX = 64;
const MAX_CONTROL_RECORDS = 64;
/** Unresolved commands kept at most; further commands are refused so a hung or flooded chat cannot grow the log. */
const MAX_UNRESOLVED_CONTROLS = 64;
const MAX_NOTICE_CHARS = 1_500;
/** A final control outcome published after its "still pending" notice; may carry one authorization URL. */
const MAX_LATE_CONTROL_CHARS = 4_000;
const SCHEDULED_SCAN_INTERVAL_MS = 2_000;
const MAX_SCHEDULED_ACTIVE = 4;
const MAX_ORIGINS = 1_000;
/** Recognized speech is bounded untrusted input, like any other message text. */
const MAX_TRANSCRIPT_CHARS = 8_000;
/** Telegram typing actions expire after about five seconds; refresh before that while a turn is active. */
const TYPING_REFRESH_MS = 4_000;

export type TelegramMediaTranscriptionOptions = {
  readonly enabled?: boolean;
  readonly language?: string;
  readonly maxDurationSeconds?: number;
  /** Absent keeps the existing uv/faster-whisper helper. */
  readonly backend?: TranscriptionBackend;
  /** Required exactly when `backend` is `whisper-cli`. */
  readonly whisperCli?: WhisperCliEngine;
  /** Advanced: override the uv executable or the helper script path (offline checks). */
  readonly uvPath?: string;
  readonly helperPath?: string;
  readonly timeoutMs?: number;
};

/**
 * Attachment ingress for this adapter. Originals live under the configured
 * workspace and stay readable through the ordinary coding-tool policy; nothing
 * is written to `dataDir` or an arbitrary external root.
 */
export type TelegramMediaOptions = {
  readonly workspace: string;
  /** Workspace-relative directory; default `media`. */
  readonly directory?: string;
  readonly transcription?: TelegramMediaTranscriptionOptions;
};

/**
 * Host-owned full-process restart for the authenticated-owner `/restart` control. The host performs
 * the replacement only after its own graceful teardown; the adapter confirms the request, never the
 * restart, and never retries it.
 */
export type TelegramRestartHost = {
  /** Whether this host can actually replace its own process and configuration. */
  readonly supported: boolean;
  /** Fixed host-owned refusal used when `supported` is false; never user, model or provider input. */
  readonly unavailable?: string;
  /** Called at most once, only after this command's acknowledgement and offset are durable. */
  request(): Promise<void>;
};

export type TelegramOptions = {
  token: string;
  allowFrom: readonly string[];
  pollTimeoutSeconds?: number;
  /** Absent keeps the previous attachment-disabled behavior for SDK callers. */
  media?: TelegramMediaOptions;
  /** Absent means `/restart` is neither advertised nor applied in this host. */
  restart?: TelegramRestartHost;
};

type TelegramMediaIngress = {
  readonly store: MediaStore;
  readonly transcriber: Transcriber;
};

type TelegramMessage = NonNullable<Update["message"]>;

export type TelegramPendingDelivery = {
  updateId: number;
  chatId: number;
  sessionKey: string;
  senderId: string;
  text: string;
  messageId?: number;
  lastText?: string;
  nextChunkIndex: number;
  /** Persisted before final delivery; absent with progress uses the pre-rich chunk plan. */
  chunkPlan?: "rich-v1" | "preview-v1" | "legacy";
  /** `unknown`: an ambiguous external outcome. `failed`: a known-rejected or repeatedly failing delivery, held. */
  deliveryStatus?: "sending" | "unknown" | "failed";
  sendIntent?: { text: string; stage: "preview" | "final"; chunkIndex?: number; startedAt: number };
  unknownStage?: "preview" | "final";
  unknownChunkIndex?: number;
  unknownSince?: number;
  /** Admitted original media that must be stored before this input is submitted. */
  attachments?: TelegramPendingAttachment[];
  /** Recognized speech for a stored audio attachment: untrusted user content. */
  transcript?: string;
  /** Why automatic transcription produced no text; never implies the speech was understood. */
  transcriptionFailure?: string;
  /** A command acknowledgement: delivered as fixed text, never submitted to the model. */
  notice?: boolean;
  /** The acknowledgement is withheld until the command's native call returns (or reports that it is still pending). */
  hold?: boolean;
};
/**
 * One authenticated control command. `admitted` is committed with the acknowledgement and the polling offset before
 * the native call; `applied` after it returns; `refused` when the native call proved that nothing changed;
 * `unconfirmed` when a reopen found it interrupted.
 */
export type TelegramControlRecord = {
  updateId: number;
  command: string;
  status: "admitted" | "applied" | "refused" | "unconfirmed";
  /** Chat and sender, so a reopen can report an interrupted command without its acknowledgement record. */
  chatId: number;
  senderId: string;
};

/** One admitted command whose ordered flush is retried on the polling cadence. */
type DeferredControl = {
  readonly updateId: number;
  readonly command: TelegramMutation;
  readonly chatId: number;
  /**
   * The `/model` preset argument (already validated against the configured catalog, never a
   * provider/model selector) or the `/mcp` request ID being decided.
   */
  readonly target?: string;
};
export type TelegramChannelState = {
  offset: number;
  pending: TelegramPendingDelivery[];
  controls: TelegramControlRecord[];
  /** Durable authenticated sender-to-chat evidence keyed by decimal chat ID. */
  origins: Record<string, TelegramOriginBinding>;
  /** Bounded observed message identities that a model action may target. */
  targets: TelegramObservedTarget[];
  /** Bounded write-ahead records of model-requested native replies and reactions. */
  actions: TelegramActionRecord[];
};
export type TelegramOriginBinding = {
  /** Adapter identity that admitted this private chat. */
  botId: string;
  chatType: "private";
  /** Original authenticated Telegram sender, not the chat ID. */
  senderId: string;
  admittedAtMs: number;
};
type PendingReply = TelegramPendingDelivery;
type SubmissionSlot = { readonly prior: Promise<void>; release(): void };
type TypingLoop = {
  /** Overlapping queued turns in one chat share this loop; the indicator stays until the last one settles. */
  turns: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};
type ChannelState = TelegramChannelState;

// Stored alongside the adapter's stable channel conversation, not in a plaintext sidecar.
export const TelegramState = defineDoc<ChannelState>({
  kind: "nanobot.telegram-state",
  version: 7,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  migrate: (value, fromVersion) => {
    if (fromVersion < 1 || fromVersion > 6) {
      throw new Error(`Unsupported Telegram state version ${fromVersion}`);
    }
    if (!Array.isArray(value.pending) || value.pending.some((item) =>
      item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("Stored Telegram state contains invalid pending deliveries");
    }
    // Controls and origin bindings arrived with version 3; earlier states migrate to empty maps.
    const hasControls = fromVersion >= 3;
    if (hasControls && value.controls !== undefined && !Array.isArray(value.controls)) {
      throw new Error("Stored Telegram state contains invalid controls");
    }
    if (hasControls && value.origins !== undefined &&
      (value.origins === null || typeof value.origins !== "object" || Array.isArray(value.origins))) {
      throw new Error("Stored Telegram state contains invalid origin bindings");
    }
    if (value.targets !== undefined && !Array.isArray(value.targets)) {
      throw new Error("Stored Telegram state contains invalid observed targets");
    }
    if (value.actions !== undefined && !Array.isArray(value.actions)) {
      throw new Error("Stored Telegram state contains invalid action records");
    }
    for (const item of value.pending as unknown as Record<string, unknown>[]) {
      if (item.attachments !== undefined && (!Array.isArray(item.attachments) ||
        item.attachments.some((entry: unknown) => entry === null || typeof entry !== "object" ||
          Array.isArray(entry) || typeof (entry as Record<string, unknown>).fileId !== "string" ||
          typeof (entry as Record<string, unknown>).identity !== "string"))) {
        throw new Error("Stored Telegram state contains invalid attachments");
      }
    }
    return {
      offset: Number(value.offset ?? 0),
      pending: (value.pending as unknown as PendingReply[]).map((item) => ({
        ...item,
        nextChunkIndex: fromVersion === 1 ? 0 : Number(item.nextChunkIndex ?? 0),
      })),
      controls: hasControls && Array.isArray(value.controls)
        ? value.controls as unknown as TelegramControlRecord[] : [],
      origins: hasControls && value.origins !== null && typeof value.origins === "object" && !Array.isArray(value.origins)
        ? value.origins as unknown as Record<string, TelegramOriginBinding> : {},
      targets: Array.isArray(value.targets) ? value.targets as unknown as TelegramObservedTarget[] : [],
      actions: Array.isArray(value.actions) ? value.actions as unknown as TelegramActionRecord[] : [],
    };
  },
  initial: () => ({ offset: 0, pending: [], controls: [], origins: {}, targets: [], actions: [] }),
});

export interface TelegramGateway {
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /**
   * Host-authenticated durable outbox for completed background cron results. Optional so a host that
   * only does inbound replies stays usable; absent means no scheduled delivery is attempted.
   */
  cronOutbox?: CronDeliveryOutbox;
  /**
   * Late-bound model-action host. The runtime creates it when `config.telegram` exists and offers the
   * `telegram` tool only in mapped Telegram chat conversations; the running adapter attaches here.
   */
  telegramActions?: TelegramActionRegistry;
  /**
   * Optional host model catalog: the current selection, the configured direct choices and (in
   * named-preset mode) the finite configured presets. Absent on a narrow SDK host, which then gets no
   * `/status` or `/model` menu entry and a truthful refusal when the command is typed. It creates no
   * conversation of its own and changes nothing.
   */
  listModels?(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /**
   * Optional bounded background snapshot for this authenticated chat: its own live workers and
   * scheduled jobs, plus whether the one shared workspace digestion run is live and whose it is.
   * Absent, or a failed read, leaves `/status` with its core lines and makes no claim about work.
   */
  backgroundStatus?(sessionKey: string, context: Context): Promise<BackgroundStatus>;
  /**
   * Optional host preset selection: one configured preset name, or `default` for the configured one.
   * It rejects atomically (including `ConversationBusy`) instead of queueing behind a running turn.
   */
  selectModelPreset?(sessionKey: string, name: string, context: Context): Promise<GatewayModelSelection>;
  /**
   * Optional paired reset for `new`: start a new context AND rebuild the host prompt snapshot from the
   * current workspace files in one operation. Absent hosts keep the plain native reset; a host that has
   * a prompt snapshot reports `busy` instead of resetting without rebuilding it.
   */
  resetSession?(sessionKey: string, context: Context): Promise<GatewaySessionReset>;
  /**
   * Optional host manual memory-digestion entry. Present means the authenticated owner may start one
   * bounded batch with `/digest` and read bounded status with `/digest status`; absent means neither
   * is advertised. It starts no schedule and calls no model from the command itself.
   */
  memoryDigest?: GatewayMemoryDigest;
  /**
   * Optional owner-only MCP management. Present only when the gateway loaded an on-disk
   * configuration file. `approve` writes configuration or starts one owner-approved OAuth login and
   * is reachable only from this authenticated owner chat and the local terminal, never from a model
   * tool; `show` and `list` are read-only and bounded.
   */
  mcpAdmin?: GatewayMcpAdmin;
}

export async function runTelegram(
  gateway: TelegramGateway,
  options: TelegramOptions,
  context: Context,
): Promise<void> {
  validateOptions(options);
  // Attachment-disabled SDK callers keep the previous behavior: no store, no download, no transcription.
  const mediaIngress = createMediaIngress(options.media);
  const mediaWork = new MediaWorkGate(MEDIA_LIMITS.maxConcurrentWork);
  /**
   * Optional host operations this adapter may call, resolved once from the host surface. A narrow SDK
   * host keeps `/new`, `/abort` (and `/stop`), `/help` only; `/status`, `/model`, `/digest` and
   * `/restart` are then neither advertised nor applied, and typing one gets a truthful refusal
   * instead of a half-working control. `/status` reports the selected model, so it needs the host
   * catalog; `/model` needs the catalog and preset selection; `/digest` needs the manual digestion
   * entry.
   */
  const hostCommands: TelegramCommandHost = {
    model: typeof gateway.listModels === "function" && typeof gateway.selectModelPreset === "function",
    status: typeof gateway.listModels === "function",
    restart: options.restart !== undefined && options.restart.supported,
    digest: typeof gateway.memoryDigest?.start === "function" && typeof gateway.memoryDigest?.status === "function",
    mcp: typeof gateway.mcpAdmin?.list === "function" && typeof gateway.mcpAdmin?.approve === "function"
      && typeof gateway.mcpAdmin?.deny === "function" && typeof gateway.mcpAdmin?.show === "function",
  };
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const cleanupContext = withoutAbortSignal(adapterContext);
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;
  // Outbound uploads resolve against the configured workspace only; the media opt-in is the
  // operator switch. Absent means every file send is refused before any external call.
  const outboundWorkspace = options.media?.workspace;
  const outboundThrottle = new TelegramFloodGate();
  const pollThrottle = new TelegramFloodGate();
  const api = new Api(options.token, {
    apiRoot: API,
    timeoutSeconds: POLL_TIMEOUT_MAX + 10,
    sensitiveLogs: false,
    fetch: telegramFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
  });

  const me = await apiCall(api, "getMe", signal, (callSignal) => api.getMe(toGrammySignal(callSignal)), { throttle: pollThrottle });
  if (!me) throw new Error("Telegram getMe returned no result");
  const identity = String(me.id);
  const stateConversation = await gateway.conversationFor(
    `telegram:${identity}${CHANNEL_STATE_SESSION_SUFFIX}`,
    context,
  );
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(TelegramState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  /** Input replies and acknowledgements have separate concurrency bounds, so a full reply queue cannot hide an ack. */
  let activeReplies = 0;
  let activeNotices = 0;
  const delivering = new Set<number>();
  const failedThisPoll = new Set<number>();
  /** Chats whose control command is still being applied: nothing for them is submitted or delivered. */
  const controlPending = new Set<number>();
  /** Commands whose earlier ordered inputs hit a transient failure; retried on the poll cadence. */
  const deferredControls = new Map<number, DeferredControl>();
  const controlFailures = new Map<number, number>();
  /**
   * Submissions a control flush already placed for earlier inputs, so the normal delivery
   * path reuses that exact turn instead of submitting the same input a second time.
   */
  const earlySubmissions = new Map<number, Submission>();
  const controlChains = new Map<number, Promise<void>>();
  const submissionChains = new Map<number, Promise<void>>();
  const pendingControls = new Set<Promise<void>>();
  /** Set once this adapter asked the host to replace the process; a second `/restart` is refused. */
  let restartHostRequested = false;
  /** Set when that one host request was refused, so a later refusal does not claim a restart is in progress. */
  let restartHostRequestFailed = false;
  /** Consecutive delivery failures per pending record, so a permanent failure is held instead of retried forever. */
  const deliveryFailures = new Map<number, number>();
  let fatal: unknown;
  let stopping = false;

  /**
   * Reserve one chat's next submission place when the delivery is dispatched, before any asynchronous preparation, so
   * admission order never depends on how long `conversationFor`/`watch` take. Durable orders the inbox by submission.
   */
  const beginSubmission = (chatId: number): SubmissionSlot => {
    const prior = submissionChains.get(chatId) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    submissionChains.set(chatId, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (submissionChains.get(chatId) === tail) submissionChains.delete(chatId);
      },
    };
  };

  /** Submit through a fresh place in a chat's order, for work that is not itself a dispatched delivery. */
  const submitInOrder = async <T>(chatId: number, work: () => Promise<T>): Promise<T> => {
    const slot = beginSubmission(chatId);
    try {
      await slot.prior;
      return await work();
    } finally {
      slot.release();
    }
  };

  const outbox = gateway.cronOutbox;
  const scheduledActive = new Set<string>();
  const scheduledChatActive = new Set<number>();
  const scheduledTasks = new Set<Promise<void>>();
  let scheduledScanning = false;
  let scheduledTimer: ReturnType<typeof setInterval> | undefined;

  // Message sends/edits for one chat are ordered; chunks from separate messages may interleave.
  // Disposable typing actions bypass this ordering but share the bot-token flood gate.
  const chatSendTails = new Map<number, Promise<void>>();
  const withChatSendOrder = <T>(chatId: number, work: () => Promise<T>): Promise<T> => {
    const previous = chatSendTails.get(chatId) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.then(() => undefined, () => undefined);
    chatSendTails.set(chatId, tail);
    void tail.finally(() => {
      if (chatSendTails.get(chatId) === tail) chatSendTails.delete(chatId);
    });
    return next;
  };

  /**
   * Durable bookkeeping a caller supplies so a text send stays truthful about its own record: the
   * intent precedes the request, a proven refusal drops it, and an accepted message id is persisted.
   */
  type TelegramTextHooks = {
    /** Persist the write-ahead intent for this exact attempt, before the request leaves. */
    before(text: string): Promise<void>;
    /** The request provably did not deliver anything; drop the intent. */
    abandoned(): Promise<void>;
    /** Record each accepted message without advancing the whole-chunk cursor. */
    partAccepted?(messageId: number, text: string): Promise<void>;
    /** All parts were accepted; advance the whole-chunk cursor. */
    accepted(messageId: number, text: string): Promise<void>;
  };

  /** A send with no durable record of its own: nothing to write before, abandon or accept. */
  const idleTextHooks: TelegramTextHooks = {
    before: async () => undefined,
    abandoned: async () => undefined,
    accepted: async () => undefined,
  };

  /** Chunk boundaries are independent of the process-local rich capability latch. */
  const splitOutboundText = (text: string, plan: "rich-v1" | "preview-v1" | "legacy" = "rich-v1"): string[] =>
    plan === "legacy" ? splitTelegramText(text) :
      splitRichText(text, plan === "preview-v1" ? PLAIN_TEXT_LIMIT : RICH_TEXT_LIMIT);

  /**
   * Send one outbound text, preferring a rich markdown message.
   *
   * The body is sent as markdown so the visible text is what the model produced. Two rejections fall
   * back to plain text because both are proven non-sends: the server has no rich method at all (then
   * latched off for the process) and the body could not be parsed or was too long. Every other
   * rejection and every ambiguous outcome propagates unchanged, so no caller resends blindly.
   *
   * `literal` escapes host-generated text (`/status`, help, control acknowledgements) so rich
   * markdown renders paths, ids and placeholders exactly as written.
   */
  const sendOutboundText = async (
    chatId: number,
    text: string,
    sendOptions: {
      hooks: TelegramTextHooks;
      replyTo?: number;
      mode?: "markdown" | "literal";
      throttle?: TelegramFloodGate;
      replaceable?: boolean;
    },
  ): Promise<number | undefined> => {
    const body = sendOptions.mode === "literal" ? escapeTelegramLiteral(text) : text;
    const reply: { reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } } =
      sendOptions.replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: sendOptions.replyTo, allow_sending_without_reply: false } };
    const callOptions: ApiCallOptions = {
      ...(sendOptions.throttle === undefined ? {} : { throttle: sendOptions.throttle }),
      ...(sendOptions.replaceable === undefined ? {} : { replaceable: sendOptions.replaceable }),
    };
    if (richMessagesEnabled()) {
      let richAccepted = false;
      try {
        const sent = await apiCall<Message.RichMessageMessage>(api, "sendRichMessage", signal, async (callSignal) => {
          await sendOptions.hooks.before(text);
          if (signal?.aborted) {
            await sendOptions.hooks.abandoned();
            throw new TelegramApiError("sendRichMessage", 0, "not-sent");
          }
          try {
            return await withChatSendOrder(chatId, () => api.sendRichMessage(
              chatId, { markdown: body }, reply, toGrammySignal(callSignal),
            ));
          } catch (error) {
            if (isProvenRefusal(error)) await sendOptions.hooks.abandoned();
            throw error;
          }
        }, callOptions);
        if (sent === undefined) return undefined;
        richAccepted = true;
        await sendOptions.hooks.partAccepted?.(sent.message_id, text);
        await rememberOutgoingTarget(chatId, sent.message_id, text);
        await sendOptions.hooks.accepted(sent.message_id, text);
        return sent.message_id;
      } catch (error) {
        if (richAccepted || !(error instanceof TelegramApiError) || error.outcome !== "rejected") throw error;
        if (isRichCapabilityRejection(error)) {
          disableRichMessages();
          console.warn("Telegram rich messages are unavailable here; this process now sends plain text.");
        } else if (!isRichFormatRejection(error)) {
          throw error;
        }
      }
    }
    // Plain fallback: the rich body was refused before anything was shown, so the same text is safe
    // to send, split inside the sendMessage limit. All parts share one recorded intent, so a crash
    // leaves the whole chunk ambiguous instead of a later replay sending part of it twice.
    const parts = splitPlainTextLossless(text);
    let first: number | undefined;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      try {
        const sent = await apiCall<Message.TextMessage>(api, "sendMessage", signal, async (callSignal) => {
          await sendOptions.hooks.before(part);
          if (signal?.aborted) {
            if (index === 0) await sendOptions.hooks.abandoned();
            throw new TelegramApiError("sendMessage", 0, "not-sent");
          }
          try {
            return await withChatSendOrder(chatId, () => api.sendMessage(
              chatId, part, index === 0 ? reply : {}, toGrammySignal(callSignal),
            ));
          } catch (error) {
            if (index === 0 && isProvenRefusal(error)) await sendOptions.hooks.abandoned();
            throw error;
          }
        }, callOptions);
        if (sent === undefined) {
          if (first !== undefined) throw new TelegramApiError("sendMessage", 0, "unknown");
          return undefined;
        }
        first = first ?? sent.message_id;
        await sendOptions.hooks.partAccepted?.(sent.message_id, part);
        await rememberOutgoingTarget(chatId, sent.message_id, part);
      } catch (error) {
        if (first !== undefined || index > 0) {
          // Earlier parts were accepted, so this chunk as a whole is no longer a definite non-send.
          throw new TelegramApiError("sendMessage", 0, "unknown", "plain fallback lost part of the chunk");
        }
        throw error;
      }
    }
    if (first === undefined) return undefined;
    await sendOptions.hooks.accepted(first, text);
    return first;
  };

  /**
   * Edit an existing message in place, preferring rich markdown for the same reasons the send path
   * does. A body Telegram refuses to parse falls back to the plain edit, which is a proven non-edit.
   * "Not modified" and "not found" stay the caller's concern: they arrive unchanged as rejections.
   * Returns false only when a replaceable edit was skipped by the flood gate.
   */
  const editOutboundText = async (
    chatId: number,
    messageId: number,
    text: string,
    editOptions: {
      mode?: "markdown" | "literal";
      throttle?: TelegramFloodGate;
      replaceable?: boolean;
    } = {},
  ): Promise<boolean> => {
    const body = editOptions.mode === "literal" ? escapeTelegramLiteral(text) : text;
    const callOptions: ApiCallOptions = {
      ...(editOptions.throttle === undefined ? {} : { throttle: editOptions.throttle }),
      ...(editOptions.replaceable === undefined ? {} : { replaceable: editOptions.replaceable }),
    };
    if (richMessagesEnabled()) {
      try {
        const edited = await apiCall(api, "editMessageText", signal, (callSignal) => withChatSendOrder(chatId, () =>
          api.editMessageText(chatId, messageId, { markdown: body }, {}, toGrammySignal(callSignal))),
        callOptions);
        return edited !== undefined;
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.outcome !== "rejected") throw error;
        if (isRichCapabilityRejection(error)) {
          disableRichMessages();
          console.warn("Telegram rich messages are unavailable here; this process now sends plain text.");
        } else if (!isRichFormatRejection(error)) {
          throw error;
        }
      }
    }
    const edited = await apiCall(api, "editMessageText", signal, (callSignal) => withChatSendOrder(chatId, () =>
      api.editMessageText(chatId, messageId, text, {}, toGrammySignal(callSignal))),
    callOptions);
    return edited !== undefined;
  };

  /**
   * Best-effort presence for live inbound turns only. One refresh loop per chat is shared by queued turns, so a
   * second turn cannot duplicate it. There is no durable typing state and no retry: the shared flood gate lets a
   * refresh yield, and any failure is ignored because the indicator is replaceable feedback.
   */
  const typingLoops = new Map<number, TypingLoop>();
  const refreshTyping = async (chatId: number, loop: TypingLoop): Promise<void> => {
    if (loop.stopped || stopping || signal?.aborted) return;
    await apiCall(api, "sendChatAction", signal,
      (callSignal) => api.sendChatAction(chatId, "typing", {}, toGrammySignal(callSignal)),
      { throttle: outboundThrottle, replaceable: true }).catch(() => undefined);
    if (loop.stopped) return;
    loop.timer = setTimeout(() => {
      loop.timer = undefined;
      void refreshTyping(chatId, loop);
    }, TYPING_REFRESH_MS);
  };
  const stopTypingLoop = (chatId: number, loop: TypingLoop): void => {
    loop.stopped = true;
    if (loop.timer !== undefined) {
      clearTimeout(loop.timer);
      loop.timer = undefined;
    }
    if (typingLoops.get(chatId) === loop) typingLoops.delete(chatId);
  };
  const startTyping = (chatId: number): (() => void) => {
    if (stopping || signal?.aborted) return () => undefined;
    let loop = typingLoops.get(chatId);
    if (loop === undefined) {
      const created: TypingLoop = { turns: 0, stopped: false, timer: undefined };
      typingLoops.set(chatId, created);
      loop = created;
      void refreshTyping(chatId, created);
    }
    loop.turns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      loop!.turns -= 1;
      if (loop!.turns === 0) stopTypingLoop(chatId, loop!);
    };
  };
  const stopAllTyping = (): void => {
    for (const [chatId, loop] of typingLoops) stopTypingLoop(chatId, loop);
  };

  // A durable origin binding is written before a message's conversation is mapped or submitted, so
  // a cron job (and its later outbox record) can never predate the admission evidence it relies on.
  const rememberOrigin = async (
    chatId: number,
    senderId: string,
  ): Promise<{ trusted: boolean; evictedChatId: string | null }> => {
    let trusted = false;
    let evictedChatId: string | null = null;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const key = String(chatId);
      const existing = doc.origins[key];
      if (existing !== undefined) {
        if (existing.botId === identity && existing.chatType === "private" && existing.senderId === senderId) {
          // Refresh recency so an active private chat is not the first eviction candidate.
          existing.admittedAtMs = Date.now();
          trusted = true;
        } else {
          // Conflicting evidence for one private chat is not trustworthy: withhold it until a fresh
          // admission writes a consistent binding.
          delete doc.origins[key];
        }
        return copyJson(doc) as unknown as ChannelState;
      }
      if (Object.keys(doc.origins).length >= MAX_ORIGINS) {
        const oldest = Object.entries(doc.origins)
          .sort((left, right) => left[1].admittedAtMs - right[1].admittedAtMs)[0];
        if (oldest !== undefined) {
          evictedChatId = oldest[0];
          delete doc.origins[oldest[0]];
        }
      }
      doc.origins[key] = {
        botId: identity,
        chatType: "private",
        senderId,
        admittedAtMs: Date.now(),
      };
      trusted = true;
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    return { trusted, evictedChatId };
  };

  const mutateState = async (
    change: (doc: Draft<ChannelState>) => void,
    ctx: Context = cleanupContext,
  ): Promise<ChannelState> => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      change(doc);
      return copyJson(doc) as unknown as ChannelState;
    }, ctx);
    return state;
  };

  // An outbound message the bot actually sent becomes a durable, bounded action target. Its text is
  // only an excerpt for the model; the identity is what a later reply/reaction is checked against.
  // Observation is derived bookkeeping: a failed commit leaves the id unobserved (fail closed) and
  // must never turn an already accepted external send into an ambiguous delivery.
  const rememberOutgoingTarget = async (chatId: number, messageId: number, text: string): Promise<void> => {
    if (!Number.isSafeInteger(messageId) || messageId < 1) return;
    try {
      await mutateState((doc) => {
        observeTarget(doc, {
          chatId,
          messageId,
          direction: "outgoing",
          senderId: identity,
          text,
          observedAtMs: Date.now(),
        });
      });
    } catch {
      // Best effort: the send result and its durable delivery record stay authoritative.
    }
  };

  /**
   * The live authority for one action: the mapped session key is host-owned, and the chat must still
   * have durable private-chat admission evidence for this bot whose sender is in the CURRENT
   * allowlist. The model never supplies a chat or session selector.
   */
  const authorizedActionChat = (sessionKey: string): number | undefined => {
    const chatId = chatIdForSession(sessionKey, identity);
    if (chatId === undefined) return undefined;
    const binding = originBindingOf(state.origins, chatId, identity);
    if (binding === undefined || !options.allowFrom.includes(binding.senderId)) return undefined;
    return chatId;
  };

  const settleAction = async (
    callId: string,
    status: "sent" | "unknown" | "failed" | "denied",
    error?: string,
  ): Promise<void> => {
    await mutateState((doc) => {
      settleActionRecord(doc.actions, callId, status, error === undefined ? {} : { error });
    });
  };

  const actionOutcome = (record: TelegramActionRecord): TelegramActionOutcome => {
    if (record.status === "sent") {
      const ids = record.resultMessageIds ?? [];
      return {
        ok: true,
        text: ids.length === 0
          ? "This Telegram action was already applied."
          : `This Telegram action was already applied (message id ${ids.join(", ")}).`,
        ...(ids.length === 0 ? {} : { messageIds: ids }),
      };
    }
    if (record.status === "unknown" || record.status === "sending") {
      return { ok: false, text: "The outcome of this Telegram action is unknown; it will not be retried automatically." };
    }
    if (record.status === "failed") {
      return { ok: false, text: "This Telegram action previously failed and will not be retried automatically." };
    }
    if (record.status === "denied") {
      return { ok: false, text: "This Telegram action was previously denied and will not be retried automatically." };
    }
    return { ok: false, text: "This Telegram action was interrupted before sending and will not be retried automatically." };
  };

  const priorActionOutcome = (
    record: TelegramActionRecord,
    chatId: number,
    request: TelegramActionRequest,
  ): TelegramActionOutcome => {
    const targetMessageId = isTelegramSendRequest(request)
      ? request.messageId ?? 0
      : request.messageId;
    const samePayload = isTelegramSendRequest(request)
      ? record.path === request.path && (record.caption ?? "") === (request.caption ?? "")
      : request.kind === "reply"
        ? record.text === request.text
        : record.emoji === request.emoji;
    if (record.chatId !== chatId || record.targetMessageId !== targetMessageId ||
        record.kind !== request.kind || !samePayload) {
      return { ok: false, text: "This action identity belongs to a different request; no action was taken." };
    }
    return actionOutcome(record);
  };

  /**
   * One native media upload. The workspace file is read into bounded memory before the API call so
   * the bytes cannot change mid-upload, and every refusal happens before any external request. The
   * `sending` record was already written by `act`, so an abort or transport ambiguity here stays
   * `unknown` and is never resent.
   */
  const performFileSend = async (
    chatId: number,
    callId: string,
    request: TelegramSendRequest,
  ): Promise<TelegramActionOutcome> => {
    const kind = request.kind;
    const caption = request.caption === undefined || request.caption === "" ? undefined : request.caption;
    const targetMessageId = request.messageId ?? 0;
    if (outboundWorkspace === undefined) {
      await settleAction(callId, "failed", "outbound files are not configured");
      return { ok: false, text: "Outbound files are not enabled in this host." };
    }
    let file;
    try {
      file = await readTelegramOutboundFile({
        workspace: outboundWorkspace,
        path: request.path,
        kind,
      });
    } catch (error) {
      const reason = error instanceof TelegramOutboundRejected ? error.reason : "unreadable";
      // Nothing left the host, so this is a known non-send rather than an ambiguous outcome.
      await settleAction(callId, "failed", `outbound file refused: ${reason}`);
      return { ok: false, text: `The file was not sent: ${outboundRejectionText(kind, reason)}.` };
    }
    const method = TELEGRAM_SEND_METHODS[kind];
    try {
      const sent = await apiCall<Message>(api, method, signal, (callSignal) => withChatSendOrder<Message>(chatId, () => {
        const outbound = new InputFile(file!.bytes, file!.filename);
        const other = {
          ...(caption === undefined ? {} : { caption }),
          ...(targetMessageId > 0
            ? { reply_parameters: { message_id: targetMessageId, allow_sending_without_reply: false } }
            : {}),
        };
        const callSignalOrUndefined = toGrammySignal(callSignal);
        switch (kind) {
          case "document": return api.sendDocument(chatId, outbound, other, callSignalOrUndefined);
          case "photo": return api.sendPhoto(chatId, outbound, other, callSignalOrUndefined);
          case "audio": return api.sendAudio(chatId, outbound, other, callSignalOrUndefined);
          case "video":
            return api.sendVideo(chatId, outbound, { ...other, supports_streaming: true }, callSignalOrUndefined);
          case "voice": return api.sendVoice(chatId, outbound, other, callSignalOrUndefined);
        }
      }), { throttle: outboundThrottle });
      if (sent === undefined) throw new Error(`Telegram ${method} returned no result`);
      const messageIds = [sent.message_id];
      await mutateState((doc) => {
        const entry = doc.actions.find((candidate) => candidate.callId === callId);
        if (entry === undefined) return;
        entry.resultMessageIds = [...(entry.resultMessageIds ?? []), sent.message_id];
      });
      await rememberOutgoingTarget(
        chatId,
        sent.message_id,
        caption ?? `[${kind}: ${file.filename}]`,
      );
      await settleAction(callId, "sent");
      return {
        ok: true,
        text: `Sent one ${kind} (${file.filename})` +
          `${targetMessageId > 0 ? ` as a native reply to message ${targetMessageId}` : ""} ` +
          `(message id ${sent.message_id}).`,
        messageIds,
      };
    } catch (error) {
      const knownNotSent = error instanceof TelegramApiError &&
        (error.outcome === "not-sent" ||
          (error.outcome === "rejected" && error.status > 0 && error.status < 500));
      if (knownNotSent) {
        await settleAction(callId, "failed", "Telegram rejected the upload");
        return {
          ok: false,
          text: "Telegram rejected the file; it was not accepted and will not be retried automatically.",
        };
      }
      await settleAction(callId, "unknown");
      console.warn(`Telegram ${kind} upload outcome unknown; it will not be retried automatically.`);
      return {
        ok: false,
        text: "The file may or may not have been delivered; it will not be retried automatically.",
      };
    }
  };

  /**
   * Perform one already-admitted action. A `sending` record precedes the API call; a success records
   * the returned ids, a known rejection fails closed, and any other outcome is quarantined as
   * `unknown` so a later replay or reopen never resends it blindly.
   */
  const performAction = async (
    chatId: number,
    callId: string,
    request: TelegramActionRequest,
  ): Promise<TelegramActionOutcome> => {
    if (isTelegramSendRequest(request)) return performFileSend(chatId, callId, request);
    try {
      if (request.kind === "react") {
        const reaction: ReactionType[] = [{
          type: "emoji",
          // The adapter does not hardcode Telegram's reaction allowlist; an unsupported emoji is a
          // known rejection and fails closed without retry.
          emoji: request.emoji as ReactionTypeEmoji["emoji"],
        }];
        await apiCall(api, "setMessageReaction", signal, (callSignal) => withChatSendOrder(chatId, () =>
          api.setMessageReaction(chatId, request.messageId, reaction, {}, toGrammySignal(callSignal))),
        { throttle: outboundThrottle });
        await settleAction(callId, "sent");
        return { ok: true, text: `Set the ${request.emoji} reaction on message ${request.messageId}.` };
      }
      const chunks = splitOutboundText(request.text);
      const ids: number[] = [];
      for (let index = actionFor(state.actions, callId)?.nextChunkIndex ?? 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        const sent = await sendOutboundText(chatId, chunk, {
          ...(index === 0 ? { replyTo: request.messageId } : {}),
          throttle: outboundThrottle,
          hooks: {
            ...idleTextHooks,
            partAccepted: async (sentId) => {
              ids.push(sentId);
              await mutateState((doc) => {
                const entry = doc.actions.find((candidate) => candidate.callId === callId);
                if (entry !== undefined) entry.resultMessageIds = [...(entry.resultMessageIds ?? []), sentId];
              });
            },
            accepted: async () => {
              await mutateState((doc) => {
                const entry = doc.actions.find((candidate) => candidate.callId === callId);
                if (entry !== undefined) entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
              });
            },
          },
        });
        if (sent === undefined) throw new Error("Telegram send returned no result");
      }
      await settleAction(callId, "sent");
      return {
        ok: true,
        text: `Sent as a native reply to message ${request.messageId}` +
          `${ids.length > 1 ? ` in ${ids.length} parts` : ""} (message id ${ids.join(", ")}).`,
        messageIds: ids,
      };
    } catch (error) {
      // `sendMessage` 5xx is already `unknown`. A reaction 5xx is likewise ambiguous, so only a
      // proven pre-connect failure or a non-5xx rejection may be called a known non-send.
      const knownNotSent = error instanceof TelegramApiError &&
        (error.outcome === "not-sent" ||
          (error.outcome === "rejected" && error.status > 0 && error.status < 500));
      if (knownNotSent) {
        await settleAction(callId, "failed", "Telegram rejected the action");
        return {
          ok: false,
          text: "Telegram rejected the action; it was not applied and will not be retried automatically.",
        };
      }
      await settleAction(callId, "unknown");
      console.warn(`Telegram ${request.kind} action outcome unknown; it will not be retried automatically.`);
      return {
        ok: false,
        text: "The Telegram action may or may not have been applied; it will not be retried automatically.",
      };
    }
  };

  const actionHost: TelegramActionHost = {
    targets(sessionKey) {
      if (stopping || signal?.aborted) return undefined;
      const chatId = authorizedActionChat(sessionKey);
      if (chatId === undefined) return undefined;
      return targetsForChat(state.targets, chatId, TELEGRAM_TARGET_LIMITS.listing);
    },
    async act(sessionKey, callId, request, ctx) {
      if (stopping || signal?.aborted || ctx.abortSignal?.aborted) {
        return { ok: false, text: "The Telegram adapter is stopping, so no action was taken." };
      }
      if (typeof callId !== "string" || callId === "" || callId.length > TELEGRAM_ACTION_LIMITS.callIdChars) {
        return { ok: false, text: "This Telegram action has no usable call identity and was not taken." };
      }
      const chatId = authorizedActionChat(sessionKey);
      if (chatId === undefined) {
        return { ok: false, text: "This chat is not currently authorized for Telegram actions." };
      }
      let targetMessageId: number;
      if (isTelegramSendRequest(request)) {
        // A host caller may bypass the model schema; an unknown kind is refused before admission.
        if (!Object.hasOwn(TELEGRAM_SEND_METHODS, request.kind)) {
          return { ok: false, text: "Unknown Telegram file kind; no file was sent." };
        }
        // Outbound files need the configured workspace media opt-in. The tool is also withheld
        // unless the same conversation holds the configured `read` tool, so this adds no read grant.
        if (options.media === undefined) {
          return { ok: false, text: "Outbound files are not enabled in this host." };
        }
        if (!validTelegramFilePath(request.path)) {
          return { ok: false, text: "The file path must be workspace-relative and inside the configured workspace." };
        }
        if (request.caption !== undefined &&
            (typeof request.caption !== "string" || request.caption.length > TELEGRAM_ACTION_LIMITS.captionChars)) {
          return { ok: false, text: `A caption is limited to ${TELEGRAM_ACTION_LIMITS.captionChars} characters.` };
        }
        if (request.messageId !== undefined &&
            (!Number.isSafeInteger(request.messageId) || request.messageId < 1)) {
          return { ok: false, text: "messageId, when given for a file send, must be a positive observed message id." };
        }
        targetMessageId = request.messageId ?? 0;
        // A file send without a reply target is ordinary; a named target must be observed here.
        if (targetMessageId > 0 && findTarget(state.targets, chatId, targetMessageId) === undefined) {
          return {
            ok: false,
            text: `Message id ${targetMessageId} is not an observed message in this chat, so it cannot be ` +
              "targeted. Use action=targets to see the ids this chat may target.",
          };
        }
      } else {
        if (!Number.isSafeInteger(request.messageId) || request.messageId < 1) {
          return { ok: false, text: "messageId must be a positive observed message id from this chat." };
        }
        if (findTarget(state.targets, chatId, request.messageId) === undefined) {
          return {
            ok: false,
            text: `Message id ${request.messageId} is not an observed message in this chat, so it cannot be ` +
              "targeted. Use action=targets to see the ids this chat may target.",
          };
        }
        targetMessageId = request.messageId;
      }
      const existing = actionFor(state.actions, callId);
      if (existing !== undefined) return priorActionOutcome(existing, chatId, request);

      const record: TelegramActionRecord = {
        callId,
        kind: request.kind,
        chatId,
        targetMessageId,
        ...(isTelegramSendRequest(request)
          ? {
              path: request.path,
              ...(request.caption === undefined ? {} : { caption: request.caption }),
            }
          : request.kind === "reply"
            ? { text: request.text }
            : { emoji: request.emoji }),
        status: "intent",
        nextChunkIndex: 0,
        startedAtMs: Date.now(),
      };
      let admission: "admitted" | "duplicate" | "full" = "full";
      await mutateState((doc) => {
        admission = admitAction(doc.actions, record);
      });
      if (admission === "full") {
        return { ok: false, text: "Too many Telegram actions are awaiting outcome; this action was not taken." };
      }
      if (admission === "duplicate") {
        const duplicate = actionFor(state.actions, callId);
        return duplicate === undefined
          ? { ok: false, text: "This Telegram action is already recorded and will not be resent." }
          : priorActionOutcome(duplicate, chatId, request);
      }
      // Preflight recheck after the durable intent: never send if the adapter stopped, the admission
      // evidence changed, or the target was evicted between validation and the effect.
      if (stopping || signal?.aborted || ctx.abortSignal?.aborted) {
        await settleAction(callId, "denied", "adapter stopped before sending");
        return { ok: false, text: "The adapter stopped before sending; no action was taken." };
      }
      if (authorizedActionChat(sessionKey) === undefined ||
          (targetMessageId > 0 && findTarget(state.targets, chatId, targetMessageId) === undefined)) {
        await settleAction(callId, "denied", "scope or target recheck failed");
        return { ok: false, text: "The chat or target is no longer authorized; no action was taken." };
      }
      await mutateState((doc) => {
        const entry = doc.actions.find((candidate) => candidate.callId === callId);
        if (entry !== undefined) entry.status = "sending";
      });
      return performAction(chatId, callId, request);
    },
  };
  let detachTelegramActions: (() => void) | undefined;

  // A completed background result is sent as stored text: no submission, no preview, no model turn.
  const scheduledSessions = async (): Promise<{ sessionKey: string; chatId: number }[]> => {
    if (outbox === undefined) return [];
    const prefix = `telegram:${identity}:chat:`;
    const sessions: { sessionKey: string; chatId: number }[] = [];
    for (const { sessionKey } of await outbox.sessions(adapterContext)) {
      if (!sessionKey.startsWith(prefix)) continue;
      const raw = sessionKey.slice(prefix.length);
      if (!/^[1-9][0-9]*$/.test(raw)) continue;
      const chatId = Number(raw);
      if (!Number.isSafeInteger(chatId)) continue;
      sessions.push({ sessionKey, chatId });
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

  // A write-ahead intent may have reached Telegram before a crash. Quarantine it on open: an
  // ambiguous external send is never auto-resent.
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
        console.warn(`Telegram scheduled delivery outcome unknown for ${record.id}; inspect the Durable cron outbox record.`);
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
    chatId: number,
    chunk: string,
    index: number,
  ): Promise<"sent" | "retry" | "stop"> => {
    try {
      const sent = await sendOutboundText(chatId, chunk, {
        throttle: outboundThrottle,
        hooks: {
          before: async (text) => { await updateScheduled(sessionKey, recordId, (entry) => {
            entry.status = "sending";
            entry.sendIntent = { text, chunkIndex: index, startedAt: Date.now() };
          }); },
          abandoned: async () => { await clearScheduledIntent(sessionKey, recordId); },
          accepted: async (messageId, shown) => {
            await updateScheduled(sessionKey, recordId, (entry) => {
              entry.status = "pending";
              delete entry.sendIntent;
              delete entry.unknownSince;
              entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
              if (index === 0) entry.messageId = messageId;
            }, cleanupContext);
          },
        },
      });
      return sent === undefined ? "retry" : "sent";
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.outcome === "unknown") {
          await updateScheduled(sessionKey, recordId, (entry) => {
            entry.status = "unknown";
            entry.unknownSince = Date.now();
            delete entry.sendIntent;
          }, cleanupContext);
          console.warn(`Telegram scheduled delivery outcome unknown for ${recordId}; inspect the Durable cron outbox record.`);
          return "stop";
        }
        if (error.outcome === "not-sent") {
          await clearScheduledIntent(sessionKey, recordId);
          return signal?.aborted ? "stop" : "retry";
        }
        if (error.status === 429) {
          await clearScheduledIntent(sessionKey, recordId);
          return "retry";
        }
        await updateScheduled(sessionKey, recordId, (entry) => {
          entry.status = "failed";
          entry.settledAt = Date.now();
          delete entry.sendIntent;
          entry.error = error.message;
        }, cleanupContext);
        return "stop";
      }
      if (signal?.aborted) {
        // An in-flight request was abandoned; the write-ahead intent stays ambiguous.
        await updateScheduled(sessionKey, recordId, (entry) => {
          entry.status = "unknown";
          entry.unknownSince = Date.now();
          delete entry.sendIntent;
        }, cleanupContext);
        console.warn(`Telegram scheduled delivery outcome unknown for ${recordId}; inspect the Durable cron outbox record.`);
        return "stop";
      }
      await updateScheduled(sessionKey, recordId, (entry) => {
        entry.status = "failed";
        entry.settledAt = Date.now();
        delete entry.sendIntent;
        entry.error = "Telegram delivery failed";
      }, cleanupContext);
      return "stop";
    }
  };

  const deliverScheduled = async (sessionKey: string, chatId: number, record: CronDeliveryRecord) => {
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
    // evidence for this bot and private chat, not from parsing the key or equating chat with sender.
    const binding = originBindingOf(state.origins, chatId, identity);
    if (binding === undefined) {
      // Missing evidence is a reversible hold, not a failed delivery: a later authenticated
      // admission for this private chat restores the binding and releases this record.
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "withheld";
        entry.withheldSince = Date.now();
        entry.error = "origin chat has no durable admission evidence";
      }, cleanupContext);
      console.warn(`Telegram scheduled delivery withheld for ${record.id}: no durable origin admission evidence.`);
      return;
    }
    // The original admitted sender is rechecked against the live allowlist for every send.
    if (!options.allowFrom.includes(binding.senderId)) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "unauthorized";
        entry.settledAt = Date.now();
        entry.error = "origin sender is no longer authorized";
      }, cleanupContext);
      return;
    }
    const plan = record.telegramChunkPlan ?? (record.nextChunkIndex > 0 ? "legacy" : "rich-v1");
    if (record.telegramChunkPlan === undefined) {
      await updateScheduled(sessionKey, record.id, (entry) => { entry.telegramChunkPlan = plan; });
    }
    const chunks = splitOutboundText(record.text, plan);
    let current = record;
    for (let index = current.nextChunkIndex; index < chunks.length; index++) {
      const result = await sendScheduledChunk(sessionKey, record.id, chatId, chunks[index]!, index);
      if (result !== "sent") return;
      const next = (await outbox.list(sessionKey, adapterContext))
        .find((entry) => entry.id === record.id);
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
    for (const { sessionKey, chatId } of await scheduledSessions()) {
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
          // A record with a usable ID is quarantined durably; one without an ID can only be
          // surfaced through the separate fault document.
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
        if (scheduledChatActive.has(chatId)) continue;
        if (scheduledActive.size >= MAX_SCHEDULED_ACTIVE) return;
        scheduledActive.add(record.id);
        scheduledChatActive.add(chatId);
        const task = Promise.resolve()
          .then(() => deliverScheduled(sessionKey, chatId, record))
          .catch(() => {
            // Keep the durable record pending; the next scan retries or quarantines it.
          })
          .finally(() => {
            scheduledActive.delete(record.id);
            scheduledChatActive.delete(chatId);
            scheduledTasks.delete(task);
          });
        scheduledTasks.add(task);
      }
    }
  };

  const requestScheduledScan = () => {
    if (scheduledScanning || stopping || signal?.aborted) return;
    scheduledScanning = true;
    void scanScheduled().catch(() => {}).finally(() => { scheduledScanning = false; });
  };

  // A fresh authenticated admission restores a missing/evicted binding, then releases that chat's
  // nonterminal withheld results. It does not release anything before the binding exists.
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
        // The scan will retry or quarantine it; admission itself must still succeed.
      }
    }
    if (released) requestScheduledScan();
  };

  const drain = () => {
    if (stopping || signal?.aborted) return;
    const heldChats = new Set<number>();
    for (const item of state.pending) {
      const notice = item.notice === true;
      if (item.hold === true) {
        heldChats.add(item.chatId);
        continue;
      }
      // A chat's notices keep admission order behind an acknowledgement that is still held.
      if (notice && heldChats.has(item.chatId)) continue;
      if (notice ? activeNotices >= 8 : activeReplies >= 8) continue;
      // A gated chat holds its inputs; an acknowledgement is never a model submission, so it can still be delivered.
      if (!notice && controlPending.has(item.chatId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.updateId) || failedThisPoll.has(item.updateId)) continue;
      delivering.add(item.updateId);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = beginSubmission(item.chatId);
      const task = Promise.resolve().then(() => deliver(item, slot)).catch(async (error: unknown) => {
        // Keep durable state for the next polling cycle; no exception details or tight retry loop in the log.
        failedThisPoll.add(item.updateId);
        await holdFailedDelivery(item.updateId, error).catch(() => undefined);
      }).finally(() => {
        slot.release();
        if (notice) activeNotices -= 1;
        else activeReplies -= 1;
        active.delete(task);
        delivering.delete(item.updateId);
        if (!stopping && !signal?.aborted) drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: PendingReply, slot: SubmissionSlot) => {
    if (!options.allowFrom.includes(item.senderId)) {
      if (item.messageId !== undefined) {
        await apiCall(api, "deleteMessage", signal, (callSignal) => withChatSendOrder(item.chatId, () => api.deleteMessage(item.chatId, item.messageId!, toGrammySignal(callSignal))), { throttle: outboundThrottle }).catch(() => undefined);
      }
      await forget(item.updateId);
      return;
    }
    if (item.notice === true) {
      await deliverNotice(item);
      return;
    }
    // Enter this chat's submission order before any asynchronous preparation, so a slow first lookup cannot let a
    // later message submit ahead of an earlier one.
    await slot.prior;
    // Attachment storage and local transcription happen inside this chat's admission order, before the model sees
    // anything. A failure keeps the durable record and the ordinary retry path; other chats keep polling.
    const content = await prepareInputContent(item);
    const conversation = await gateway.conversationFor(item.sessionKey, adapterContext);
    const requestId = requestIdFor(identity, item.updateId);
    const watch = await conversation.watch(adapterContext);
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewWork: Promise<void> | undefined;
    let previewDirty = false;
    let previewFailure: unknown;
    let latestPreview = "";
    let submissionId: SubmissionId | undefined;
    let watchStopped = false;
    const schedulePreview = () => {
      if (previewTimer !== undefined || watchStopped || signal?.aborted) return;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (previewWork) return;
        previewDirty = false;
        previewWork = publishPreview(latestPreview).catch((error: unknown) => {
          previewFailure = error;
        }).finally(() => {
          previewWork = undefined;
          if (previewDirty && !watchStopped && !signal?.aborted) schedulePreview();
        });
      }, 700);
    };
    const queuePreview = (text: string) => {
      if (watchStopped) return;
      latestPreview = text;
      previewDirty = true;
      schedulePreview();
    };
    const stopTyping = startTyping(item.chatId);
    try {
      watch.start(async (view) => {
        const live = view.docs["pi.live"] as {
          run?: { inputs?: SubmissionId[] };
          generation?: { message?: { content?: { type: string; text?: string }[] } };
        } | undefined;
        if (submissionId === undefined || !live?.run?.inputs?.includes(submissionId)) return;
        const text = live.generation?.message?.content
          ?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
        if (text) queuePreview(text);
      });
      const early = earlySubmissions.get(item.updateId);
      earlySubmissions.delete(item.updateId);
      const submission = early ?? await conversation.submit({ type: "input", content, requestId }, adapterContext);
      // Ordering is established; free the chat's next submission place while this turn runs.
      slot.release();
      submissionId = submission.id;
      const settled = await submission.wait(adapterContext);
      if (settled.status !== "done" || settled.type !== "input") {
        await stopPreviewWatch();
        // A native abort or a queued reset deliberately ends a turn; that is not a delivery failure to report.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        if (!intentional) await flushFinal("Your request could not be completed. Please try again.");
        await forget(item.updateId);
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const answerText = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      const text = answerText.trim() === "" ? "The assistant returned no text response." : answerText;
      await stopPreviewWatch();
      await flushFinal(text);
      await forget(item.updateId);
    } finally {
      stopTyping();
      await stopPreviewWatch();
    }

    async function deliverNotice(current: PendingReply) {
      // One bounded host-generated notice: `literal` keeps paths, ids and placeholders exactly as written.
      if (current.nextChunkIndex > 0) {
        await forget(current.updateId);
        return;
      }
      const sent = await sendTelegramMessage(current.text, "final", 0, false, "literal");
      if (sent === undefined) throw new Error("Telegram send returned no result");
      await forget(current.updateId);
    }

    async function stopPreviewWatch() {
      if (watchStopped) return;
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      watchStopped = true;
      previewDirty = false;
      await watch.stop();
      await previewWork;
      if (previewFailure !== undefined) throw previewFailure;
    }

    async function flushFinal(text: string) {
      let current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.chunkPlan !== undefined && current.chunkPlan !== "legacy" &&
          current.chunkPlan !== "rich-v1" && current.chunkPlan !== "preview-v1") {
        throw new Error("Telegram delivery has an invalid chunk plan");
      }
      // Old in-flight cursors refer to the original 4096-character split. A preview's first
      // final chunk must also fit a plain edit if Telegram rejects rich formatting.
      const plan = current.chunkPlan ?? (current.nextChunkIndex > 0 ? "legacy" :
        current.messageId === undefined ? "rich-v1" : "preview-v1");
      if (current.chunkPlan === undefined) {
        await mutatePending(item.updateId, (entry) => { entry.chunkPlan = plan; });
        current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
      }
      // Before rich messages, foreground answers were trimmed before legacy chunking. Preserve
      // that exact input for an already-progressed legacy cursor during upgrade recovery.
      const chunks = splitOutboundText(plan === "legacy" ? text.trim() : text, plan);
      for (let index = current.nextChunkIndex; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        if (index === 0 && current.messageId !== undefined) {
          if (current.lastText !== chunk) {
            try {
              await editOutboundText(item.chatId, current.messageId!, chunk, { throttle: outboundThrottle });
            } catch (error) {
              if (isNotModified(error)) {
                // The remote edit may have succeeded before its response was lost.
              } else if (isMessageNotFound(error)) {
                await clearPreview(item.updateId);
                const sent = await sendTelegramMessage(chunk, "final", index);
                if (sent === undefined) throw new Error("Telegram send returned no result");
                await markChunkDelivered(item.updateId, index, chunk, sent);
                current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
                continue;
              } else throw error;
            }
            await markChunkDelivered(item.updateId, index, chunk);
          } else {
            await markChunkDelivered(item.updateId, index, chunk);
          }
        } else {
          const sent = await sendTelegramMessage(chunk, "final", index);
          if (sent === undefined) throw new Error("Telegram send returned no result");
          await markChunkDelivered(item.updateId, index, chunk, index === 0 ? sent : undefined);
        }
        current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
      }
    }

    async function sendTelegramMessage(
      text: string,
      stage: "preview" | "final",
      chunkIndex?: number,
      replaceable = false,
      mode: "markdown" | "literal" = "markdown",
    ): Promise<number | undefined> {
      try {
        return await sendOutboundText(item.chatId, text, {
          mode,
          replaceable,
          throttle: outboundThrottle,
          hooks: {
            before: (attempt) => mutatePending(item.updateId, (entry) => {
              entry.deliveryStatus = "sending";
              entry.sendIntent = { text: attempt, stage, startedAt: Date.now(), ...(chunkIndex === undefined ? {} : { chunkIndex }) };
            }),
            abandoned: () => clearSendIntent(item.updateId),
            accepted: async (messageId, shown) => {
              await mutatePending(item.updateId, (entry) => {
                delete entry.deliveryStatus;
                delete entry.sendIntent;
                delete entry.unknownStage;
                delete entry.unknownChunkIndex;
                delete entry.unknownSince;
                if (stage === "final" && chunkIndex !== undefined) entry.nextChunkIndex = chunkIndex + 1;
                if (stage === "preview" || chunkIndex === 0) {
                  entry.messageId = messageId;
                  entry.lastText = shown;
                }
              }, cleanupContext);
            },
          },
        });
      } catch (error) {
        if (error instanceof TelegramApiError && error.outcome === "unknown") {
          await markUnknown(item.updateId, stage, chunkIndex);
          console.warn(`Telegram delivery outcome unknown for update ${item.updateId} (${stage}); inspect the Durable channel-state record.`);
        } else if (!(state.pending.find((entry) => entry.updateId === item.updateId)?.deliveryStatus === "sending")) {
          await clearSendIntent(item.updateId);
        } else {
          await markUnknown(item.updateId, stage, chunkIndex);
        }
        throw error;
      }
    }

    async function publishPreview(text: string) {
      // Previews stay inside one plain-sized message: they are replaced repeatedly while a turn runs.
      const preview = splitTelegramText(text)[0];
      if (!preview || signal?.aborted) return;
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.deliveryStatus === "unknown" || current.lastText === preview) return;
      if (current.messageId === undefined) {
        const sent = await sendTelegramMessage(preview, "preview", undefined, true);
        if (sent !== undefined) await rememberMessage(item.updateId, sent, preview);
      } else {
        try {
          const edited = await editOutboundText(item.chatId, current.messageId!, preview, {
            throttle: outboundThrottle,
            replaceable: true,
          });
          if (edited) await rememberText(item.updateId, preview);
        } catch (error) {
          if (isNotModified(error)) {
            await rememberText(item.updateId, preview);
          } else if (isMessageNotFound(error)) {
            await clearPreview(item.updateId);
            const sent = await sendTelegramMessage(preview, "preview", undefined, true);
            if (sent !== undefined) await rememberMessage(item.updateId, sent, preview);
          } else throw error;
        }
      }
    }
  };

  const mutatePending = async (
    updateId: number,
    change: (item: PendingReply) => void,
    commitContext: Context = adapterContext,
  ) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const item = doc.pending.find((entry) => entry.updateId === updateId);
      if (item) change(item);
      return copyJson(doc) as unknown as ChannelState;
    }, commitContext);
  };
  const clearSendIntent = (updateId: number) => mutatePending(updateId, (entry) => {
    delete entry.deliveryStatus;
    delete entry.sendIntent;
  }, cleanupContext);
  const rememberMessage = (updateId: number, messageId: number, text: string) =>
    mutatePending(updateId, (item) => { item.messageId = messageId; item.lastText = text; }, cleanupContext);
  const rememberText = (updateId: number, text: string) =>
    mutatePending(updateId, (item) => { item.lastText = text; }, cleanupContext);
  const clearPreview = (updateId: number) => mutatePending(updateId, (item) => {
    delete item.messageId;
    delete item.lastText;
  }, cleanupContext);
  const markChunkDelivered = (updateId: number, index: number, text: string, messageId?: number) =>
    mutatePending(updateId, (item) => {
      item.nextChunkIndex = Math.max(item.nextChunkIndex, index + 1);
      if (index === 0) {
        item.lastText = text;
        if (messageId !== undefined) item.messageId = messageId;
      }
    }, cleanupContext);
  const markUnknown = (updateId: number, stage: "preview" | "final", chunkIndex?: number) =>
    mutatePending(updateId, (item) => {
      item.deliveryStatus = "unknown";
      item.unknownStage = stage;
      item.unknownSince = Date.now();
      if (chunkIndex === undefined) delete item.unknownChunkIndex;
      else item.unknownChunkIndex = chunkIndex;
    }, cleanupContext);
  const forget = async (updateId: number) => {
    deliveryFailures.delete(updateId);
    earlySubmissions.delete(updateId);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.pending = doc.pending.filter((entry) => entry.updateId !== updateId);
      // Its terminal report (interrupted or refused) is now durably delivered, so the record has served its purpose.
      doc.controls = doc.controls.filter((entry) =>
        !(entry.updateId === updateId && (entry.status === "unconfirmed" || entry.status === "refused")));
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  };

  // ── Attachments ───────────────────────────────────────────────────────────
  // Originals are admitted with the input and stored before the model sees them.
  // A reopen resumes from the durable attachment record instead of re-downloading,
  // and a stored transcript is never recomputed.

  const attachmentRecord = (updateId: number, identity: string): TelegramPendingAttachment | undefined =>
    state.pending.find((entry) => entry.updateId === updateId)
      ?.attachments?.find((candidate) => candidate.identity === identity);

  const downloadAttachment = async (
    ingress: TelegramMediaIngress,
    current: TelegramPendingAttachment,
  ): Promise<StoredMedia> => {
    if (current.declaredBytes !== undefined && current.declaredBytes > ingress.store.maxFileBytes) {
      throw new MediaRejected("too-large");
    }
    // The same underlying file (Telegram's content-stable unique id) may arrive in a later
    // update: an already stored original is reused instead of downloading it again.
    const already = await ingress.store.existing(
      ingress.store.locator(current.identity, current.kind, current.mimeType),
    );
    if (already !== undefined) {
      return {
        ...already,
        kind: current.kind,
        identity: current.identity,
        ...(current.mimeType === undefined ? {} : { mimeType: current.mimeType }),
        ...(current.originalName === undefined ? {} : { originalName: current.originalName }),
      };
    }
    let file;
    try {
      file = await apiCall(api, "getFile", signal,
        (callSignal) => api.getFile(current.fileId, toGrammySignal(callSignal)), { throttle: pollThrottle });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // A definitive request rejection (unknown id, expired file, Bot API size limit)
      // cannot improve on retry; anything else stays on the delivery retry path.
      if (error instanceof TelegramApiError && error.outcome === "rejected" && error.status < 500) {
        throw new MediaRejected("unavailable");
      }
      throw error;
    }
    if (!file) throw new Error("Telegram getFile returned no result");
    const path = telegramFilePath(file.file_path);
    if (path === undefined) throw new MediaRejected("unsafe-path");
    const announced = safeAnnouncedSize(file.file_size);
    if (announced !== undefined && announced > ingress.store.maxFileBytes) throw new MediaRejected("too-large");

    const url = telegramFileUrl(options.token, path);
    if (new URL(url).origin !== TELEGRAM_FILE_ORIGIN) throw new MediaRejected("unsafe-path");
    const timeout = AbortSignal.timeout(TELEGRAM_MEDIA_LIMITS.downloadTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await globalThis.fetch(url, { method: "GET", redirect: "error", signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // The URL carries the bot token: never let it reach an error message or log.
      throw new Error("Telegram file download failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400 && response.status < 500) throw new MediaRejected("unavailable");
      throw new Error("Telegram file download failed");
    }
    return ingress.store.save({
      kind: current.kind,
      identity: current.identity,
      ...(current.mimeType === undefined ? {} : { mimeType: current.mimeType }),
      ...(current.originalName === undefined ? {} : { originalName: current.originalName }),
      ...(announced === undefined ? {} : { declaredBytes: announced }),
      body: boundedFileBody(response, ingress.store.maxFileBytes, combined),
      ...(signal === undefined ? {} : { signal }),
    });
  };

  const storeAttachment = async (
    ingress: TelegramMediaIngress,
    item: PendingReply,
    admitted: TelegramPendingAttachment,
  ): Promise<TelegramPendingAttachment> => {
    const current = attachmentRecord(item.updateId, admitted.identity) ?? admitted;
    if (current.status === "failed") return current;
    if (current.status === "stored") {
      // A stored original that is still present and regular is reused; one that was
      // removed is fetched again, because the admitted attachment is not lost.
      let present = false;
      if (current.relativePath !== undefined) {
        try {
          present = (await ingress.store.existing(current.relativePath)) !== undefined;
        } catch (error) {
          if (!(error instanceof MediaRejected)) throw error;
        }
      }
      if (present) return current;
    }
    try {
      const stored = await mediaWork.run(() => downloadAttachment(ingress, current), signal);
      const next: TelegramPendingAttachment = {
        ...current,
        status: "stored",
        relativePath: stored.relativePath,
        bytes: stored.bytes,
      };
      await mutatePending(item.updateId, (entry) => {
        const target = entry.attachments?.find((candidate) => candidate.identity === next.identity);
        if (target !== undefined) {
          target.status = next.status;
          target.relativePath = next.relativePath!;
          target.bytes = next.bytes!;
        }
      }, cleanupContext);
      return next;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (!(error instanceof MediaRejected)) throw error;
      const next: TelegramPendingAttachment = {
        ...current,
        status: "failed",
        note: MEDIA_REJECTION_TEXT[error.reason],
      };
      await mutatePending(item.updateId, (entry) => {
        const target = entry.attachments?.find((candidate) => candidate.identity === next.identity);
        if (target !== undefined) {
          target.status = "failed";
          target.note = next.note!;
        }
      }, cleanupContext);
      console.warn(`Telegram attachment ${next.kind} for update ${item.updateId} could not be stored: ${next.note}.`);
      return next;
    }
  };

  const transcribeAttachment = async (
    ingress: TelegramMediaIngress,
    item: PendingReply,
    attachment: TelegramPendingAttachment,
  ): Promise<AttachmentSpeech> => {
    const fresh = state.pending.find((entry) => entry.updateId === item.updateId);
    if (fresh?.transcript !== undefined) return { transcript: fresh.transcript };
    // A failed attempt is cached too: a retried turn never re-runs local recognition.
    if (fresh?.transcriptionFailure !== undefined) return { failure: fresh.transcriptionFailure };
    if (!ingress.transcriber.enabled) return { disabled: true };
    if (attachment.relativePath === undefined) return { failure: "the stored file is missing" };
    const outcome = await mediaWork.run(
      async () => ingress.transcriber.transcribe(
        await ingress.store.absolute(attachment.relativePath!),
        { ...(signal === undefined ? {} : { signal }) },
      ),
      signal,
    );
    if (outcome.ok) {
      const transcript = outcome.text.slice(0, MAX_TRANSCRIPT_CHARS);
      await mutatePending(item.updateId, (entry) => { entry.transcript = transcript; }, cleanupContext);
      return { transcript };
    }
    if (outcome.reason === "cancelled") throw signal?.reason ?? new Error("Telegram transcription cancelled");
    const failure = TRANSCRIPTION_FAILURE_TEXT[outcome.reason];
    await mutatePending(item.updateId, (entry) => { entry.transcriptionFailure = failure; }, cleanupContext);
    return { failure };
  };

  const prepareInputContent = async (
    item: PendingReply,
  ): Promise<string | (TextContent | ImageContent)[]> => {
    const ingress = mediaIngress;
    if (ingress === undefined || item.attachments === undefined || item.attachments.length === 0) return item.text;
    const images: ImageContent[] = [];
    const blocks: string[] = [];
    for (const admitted of item.attachments) {
      const stored = await storeAttachment(ingress, item, admitted);
      let speech: AttachmentSpeech = {};
      if (stored.status === "stored" && stored.kind === "audio") {
        speech = await transcribeAttachment(ingress, item, stored);
      }
      blocks.push(attachmentContextText(stored, speech));
      if (stored.kind === "photo" && stored.status === "stored" && stored.relativePath !== undefined) {
        const bytes = await ingress.store.read(stored.relativePath);
        images.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: stored.mimeType ?? "image/jpeg",
        });
      }
    }
    const text = [item.text, ...blocks].filter((part) => part.trim() !== "").join("\n\n");
    if (images.length === 0) return text;
    const parts: (TextContent | ImageContent)[] = [];
    if (text !== "") parts.push({ type: "text", text });
    parts.push(...images);
    return parts;
  };

  /**
   * A known Telegram rejection will not improve on retry, and a repeated failure should stay visible instead of
   * retrying on every poll. Hold the record for reconciliation; it is never resent automatically.
   */
  async function holdFailedDelivery(updateId: number, error: unknown): Promise<void> {
    if (error instanceof TelegramApiError) {
      // An ambiguous send was already quarantined with its write-ahead intent; never downgrade or recount it.
      if (error.outcome === "unknown") return;
      // A flood wait is a cooldown instruction, not a permanent rejection: the shared gate already deferred the retry.
      if (error.status === 429) return;
    }
    const attempts = (deliveryFailures.get(updateId) ?? 0) + 1;
    deliveryFailures.set(updateId, attempts);
    const rejected = error instanceof TelegramApiError && error.outcome === "rejected";
    if (!rejected && attempts < MAX_DELIVERY_FAILURES) return;
    deliveryFailures.delete(updateId);
    await mutatePending(updateId, (item) => {
      if (item.deliveryStatus === "unknown") return;
      item.deliveryStatus = "failed";
      delete item.sendIntent;
    }, cleanupContext);
    console.warn(`Telegram delivery for update ${updateId} is held after ${attempts} failure(s); inspect the Durable channel-state record.`);
  }

  // A control recorded but never confirmed may or may not have taken effect: report it once, never replay it.
  const unresolved = state.controls.filter((entry) => entry.status === "admitted");
  const heldNotices = state.pending.some((item) => item.hold === true);
  if (unresolved.length > 0 || heldNotices) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      for (const entry of doc.controls) {
        if (entry.status !== "admitted") continue;
        const notice = doc.pending.find((item) => item.notice === true && item.updateId === entry.updateId);
        // A restart is never re-requested by recovery: only its interrupted outcome is reported.
        const interrupted = entry.command === "restart" ? UNCONFIRMED_RESTART : UNCONFIRMED_CONTROL;
        if (notice !== undefined) {
          // In flight at a crash: correct the held acknowledgement (one message) and release it.
          if (notice.hold === true) notice.text = interrupted;
          delete notice.hold;
          entry.status = "unconfirmed";
          continue;
        }
        // Nothing left to correct: report the unconfirmed effect for the recorded chat, once.
        if (doc.pending.length >= MAX_ADMITTED) continue;
        doc.pending.push({
          updateId: entry.updateId,
          nextChunkIndex: 0,
          chatId: entry.chatId,
          sessionKey: `telegram:${identity}:chat:${entry.chatId}`,
          senderId: entry.senderId,
          text: interrupted,
          notice: true,
        });
        entry.status = "unconfirmed";
      }
      for (const notice of doc.pending) {
        if (notice.hold !== true) continue;
        const record = doc.controls.find((entry) => entry.updateId === notice.updateId);
        if (record === undefined) {
          notice.text = UNCONFIRMED_CONTROL;
          delete notice.hold;
        } else if (record.status === "applied") {
          delete notice.hold;
        }
      }
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    if (unresolved.length > 0) {
      console.warn(`Telegram ${unresolved.length} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }
  // An unresolved write-ahead intent may have reached Telegram before a crash.
  for (const item of state.pending.filter((entry) => entry.sendIntent !== undefined || entry.deliveryStatus === "sending")) {
    await markUnknown(item.updateId, item.sendIntent?.stage ?? "final", item.sendIntent?.chunkIndex);
    console.warn(`Telegram delivery outcome unknown for update ${item.updateId}; inspect the Durable channel-state record.`);
  }
  // A model-requested external action may have reached Telegram before a crash. Quarantine every
  // unresolved intent/sending record as unknown: a replay or reopen must never resend it blindly.
  for (const action of unresolvedActions(state.actions)) {
    await settleAction(action.callId, "unknown");
    console.warn(`Telegram ${action.kind} action was interrupted before its outcome was recorded; ` +
      "it will not be retried automatically.");
  }
  // Recover admitted work before polling. Each requestId safely reacquires its existing submission.
  await recoverScheduled();
  // Cosmetic and best effort: a slow or flooded menu registration must not delay polling.
  void registerCommandMenu();
  requestScheduledScan();
  scheduledTimer = setInterval(requestScheduledScan, SCHEDULED_SCAN_INTERVAL_MS);
  detachTelegramActions = gateway.telegramActions?.attach(actionHost);
  drain();

  try {
    while (!signal?.aborted) {
      failedThisPoll.clear();
      drain();
      resumeDeferredControls();
      requestScheduledScan();
      const updates = await apiCall(api, "getUpdates", signal, (callSignal) => api.getUpdates({
        offset: state.offset,
        timeout: Math.min(options.pollTimeoutSeconds ?? 30, POLL_TIMEOUT_MAX),
        allowed_updates: ["message", "message_reaction"],
      }, toGrammySignal(callSignal)), { throttle: pollThrottle, retryNetwork: true });
      if (!updates) throw new Error("Telegram getUpdates returned no result");
      for (const update of updates) {
        if (signal?.aborted) break;
        // The durable offset is the admission boundary: a replayed update below it is already
        // admitted (message or reaction) and must not create a second turn.
        if (update.update_id < state.offset) continue;
        const message = update.message;
        if (message !== undefined) {
          if (!isAllowedPrivateMessage(message, options.allowFrom)) {
            await persistOffset(update.update_id + 1);
            continue;
          }
          const sessionKey = `telegram:${identity}:chat:${message.chat.id}`;
          // Persist authenticated admission evidence before any control or conversation action.
          const origin = await rememberOrigin(message.chat.id, String(message.from!.id));
          if (origin.evictedChatId !== null) {
            await reportOutboxFault(
              `telegram:${identity}:chat:${origin.evictedChatId}`,
              "origin admission binding evicted at capacity; a fresh admission restores it",
            );
            console.warn("Telegram origin admission binding evicted at capacity; a fresh admission restores it.");
          }
          if (origin.trusted) await releaseWithheld(sessionKey);
          // Control parsing happens only after allowlist authentication and never for attachments.
          const parsed = parseTelegramInput(message.text ?? "", me.username);
          if (parsed.kind !== "input") {
            await handleControl(update, message, parsed);
            continue;
          }
          const caption = message.text !== undefined ? parsed.text : message.caption;
          // With media configured, supported originals are admitted with the input and stored in the
          // delivery path; without it, the previous text-only behavior is unchanged.
          const plan = mediaIngress === undefined
            ? undefined
            : planTelegramMedia(message, identity, update.update_id);
          let body: string;
          let attachments: TelegramPendingAttachment[] | undefined;
          if (mediaIngress === undefined) {
            const hasAttachment = ["photo", "document", "audio", "voice", "video", "video_note", "animation", "sticker"]
              .some((field) => (message as unknown as Record<string, unknown>)[field] !== undefined);
            body = hasAttachment
              ? disabledAttachmentText(caption)
              : caption ?? "[Unsupported Telegram message: this adapter accepts text only.]";
          } else if (plan?.kind === "attachment") {
            // The caption stays ordinary input; the attachment block is added after storage.
            body = caption ?? "";
            attachments = [plan.attachment];
          } else if (plan?.kind === "unsupported") {
            // Video and similar kinds are never downloaded, stored or implied to have been read.
            body = unsupportedAttachmentText(plan.label, caption);
          } else {
            body = caption ?? "[Empty Telegram message: no text, caption or supported attachment.]";
          }
          const quoted = quotedMessageContext(message, identity);
          // A quoted/replied-to message contributes bounded, labeled reference context and its
          // message identity. An ordinary message keeps its exact original input; its own identity
          // is still durably observed and reachable through the `telegram` tool's `targets` action.
          const input = quoted === undefined
            ? body
            : `${incomingContextText({ messageId: message.message_id, replyTo: quoted.context })}\n${body}`;
          const observedAtMs = Date.now();
          state = await stateConversation.commit(async (tx) => {
            const doc = await tx.doc(TelegramState, stateConversation.id);
            if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
              if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
              doc.pending.push({
                updateId: update.update_id,
                nextChunkIndex: 0,
                chatId: message.chat.id,
                sessionKey,
                senderId: String(message.from!.id),
                text: input,
                ...(attachments === undefined ? {} : { attachments }),
              });
            }
            observeTarget(doc, {
              chatId: message.chat.id,
              messageId: message.message_id,
              direction: "incoming",
              senderId: String(message.from!.id),
              text: message.text ?? message.caption ?? "",
              observedAtMs,
            });
            if (quoted?.target !== undefined) observeTarget(doc, quoted.target);
            doc.offset = Math.max(doc.offset, update.update_id + 1);
            return copyJson(doc) as unknown as ChannelState;
          }, adapterContext);
          // The exact input and the offset commit before any model submission, so a crash cannot lose or duplicate it.
          drain();
          continue;
        }
        const reaction = update.message_reaction;
        if (reaction !== undefined) {
          await handleReaction(update, reaction);
          continue;
        }
        // An unhandled update type (for example an anonymous reaction count) advances the offset
        // without a model call.
        await persistOffset(update.update_id + 1);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    stopping = true;
    detachTelegramActions?.();
    detachTelegramActions = undefined;
    stopAllTyping();
    if (scheduledTimer !== undefined) clearInterval(scheduledTimer);
    scope.cancel(new DOMException("Telegram adapter stopped", "AbortError"));
    await Promise.allSettled([...active, ...pendingControls, ...scheduledTasks]);
  }
  if (fatal !== undefined) throw fatal;

  /**
   * Best-effort native command menu for exactly the controls this adapter implements. A failure or a
   * flood wait leaves typed commands working and never blocks polling; no dead menu entry is added.
   */
  async function registerCommandMenu(): Promise<void> {
    try {
      await apiCall(api, "setMyCommands", signal, (callSignal) => api.setMyCommands(
        telegramCommands(hostCommands),
        { scope: { type: "all_private_chats" } },
        toGrammySignal(callSignal),
      ), { throttle: outboundThrottle, replaceable: true });
    } catch {
      if (!signal?.aborted) {
        console.warn("Telegram command menu registration failed; the implemented commands still work when typed.");
      }
    }
  }

  /**
   * One authenticated reaction change becomes an ordinary durable input. The sender is the update's
   * `user` (never `actor_chat`), the chat must have matching private-chat admission evidence for this
   * bot, and the reacted message must be an observed target in that exact chat; otherwise the update
   * only advances the offset. Pending input and offset commit together, so a replay cannot admit it
   * twice and a crash before submission is recovered by the normal delivery path.
   */
  async function handleReaction(update: Update, reaction: MessageReactionUpdated): Promise<void> {
    if (!isAllowedPrivateReaction(reaction, options.allowFrom)) {
      await persistOffset(update.update_id + 1);
      return;
    }
    const user = reaction.user;
    const chatId = reaction.chat.id;
    const senderId = String(user.id);
    const binding = originBindingOf(state.origins, chatId, identity);
    const target = findTarget(state.targets, chatId, reaction.message_id);
    if (binding === undefined || binding.senderId !== senderId ||
        !options.allowFrom.includes(binding.senderId) || target === undefined) {
      await persistOffset(update.update_id + 1);
      return;
    }
    const text = reactionChangeText({
      messageId: reaction.message_id,
      target,
      oldReaction: reaction.old_reaction,
      newReaction: reaction.new_reaction,
    });
    const sessionKey = `telegram:${identity}:chat:${chatId}`;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId,
          sessionKey,
          senderId,
          text,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    drain();
  }

  async function handleControl(
    update: Update,
    message: TelegramMessage,
    parsed: Exclude<ParsedTelegramInput, { kind: "input" }>,
  ): Promise<void> {
    const chatId = message.chat.id;
    const sessionKey = `telegram:${identity}:chat:${chatId}`;
    const recorded = state.controls.find((entry) => entry.updateId === update.update_id);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of running it twice.
      if (recorded.status === "admitted") await markControlUnconfirmed(recorded.updateId);
      await admitNotice(update, message, sessionKey, replayControlText(recorded));
      drain();
      return;
    }
    if (parsed.kind === "foreign") {
      await admitNotice(update, message, sessionKey,
        `/${parsed.command}@${parsed.mention} did not run here and was not sent to the assistant: this bot only ` +
        `accepts an exact mention of its own username. Use /${parsed.command} without a mention.`);
      drain();
      return;
    }
    if (parsed.kind === "unsupported") {
      await admitNotice(update, message, sessionKey,
        `Unsupported command /${parsed.command}. Available: ${availableCommandList()}. ` +
        "Any other message is sent to the assistant; prefix // to send a leading slash literally.");
      drain();
      return;
    }
    if (parsed.command === "help") {
      if (parsed.args) {
        await admitNotice(update, message, sessionKey, "Usage: /help (no arguments). Nothing was sent to the assistant.");
        drain();
        return;
      }
      await admitNotice(update, message, sessionKey, controlHelpText());
      drain();
      return;
    }
    if (parsed.command === "status") {
      if (!hostCommands.status) {
        await admitNotice(update, message, sessionKey, STATUS_UNAVAILABLE_HOST);
        drain();
        return;
      }
      if (parsed.args) {
        await admitNotice(update, message, sessionKey, "Usage: /status (no arguments). Nothing was sent to the assistant.");
        drain();
        return;
      }
      // Read-only: one bounded notice from the native conversation projection, no effect intent, no model call.
      await admitNotice(update, message, sessionKey, await statusNotice(sessionKey));
      drain();
      return;
    }
    if (parsed.command === "model") {
      if (!hostCommands.model) {
        await admitNotice(update, message, sessionKey, MODEL_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const argument = parseModelArgument(parsed.args);
      if (argument.kind === "usage") {
        await admitNotice(update, message, sessionKey, MODEL_USAGE);
        drain();
        return;
      }
      const listing = await readModelListing(sessionKey);
      if (argument.kind === "list") {
        await admitNotice(update, message, sessionKey,
          listing === undefined ? MODEL_LISTING_UNAVAILABLE : modelListingText(listing));
        drain();
        return;
      }
      // Only the finite configured catalog may be selected; this chat command never rewrites configuration and
      // never accepts an arbitrary provider/model/thinking triple.
      if (listing === undefined) {
        await admitNotice(update, message, sessionKey, MODEL_LISTING_UNAVAILABLE);
        drain();
        return;
      }
      if (listing.presets === undefined) {
        await admitNotice(update, message, sessionKey, MODEL_PRESETS_UNAVAILABLE);
        drain();
        return;
      }
      if (argument.name !== "default" && !listing.presets.some((preset) => preset.name === argument.name)) {
        await admitNotice(update, message, sessionKey,
          `Unknown model preset ${boundedLabel(argument.name, 80)}: nothing was changed. ` +
          "Use /model to list the configured presets.");
        drain();
        return;
      }
      await admitControl(update, message, sessionKey, "model", argument.name);
      return;
    }
    if (parsed.command === "restart") {
      if (!hostCommands.restart) {
        const unavailable = options.restart?.unavailable;
        await admitNotice(update, message, sessionKey,
          typeof unavailable === "string" && unavailable.trim() !== ""
            ? unavailable.slice(0, MAX_NOTICE_CHARS)
            : RESTART_UNAVAILABLE_HOST);
        drain();
        return;
      }
      if (parsed.args) {
        await admitNotice(update, message, sessionKey, "Usage: /restart (no arguments). Nothing was sent to the assistant.");
        drain();
        return;
      }
      if (restartHostRequested) {
        await admitNotice(update, message, sessionKey,
          restartHostRequestFailed ? RESTART_REQUEST_FAILED : RESTART_ALREADY_REQUESTED);
        drain();
        return;
      }
      await admitControl(update, message, sessionKey, "restart");
      return;
    }
    if (parsed.command === "digest") {
      if (!hostCommands.digest) {
        await admitNotice(update, message, sessionKey, DIGEST_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const argument = parsed.args.trim().toLowerCase();
      if (argument === "status") {
        // Read-only bounded status: no scan, no model call and no cursor change.
        await admitNotice(update, message, sessionKey, await digestStatusNotice(sessionKey));
        drain();
        return;
      }
      if (argument !== "") {
        await admitNotice(update, message, sessionKey, DIGEST_USAGE);
        drain();
        return;
      }
      // Starting one bounded batch is an effect, so it uses the same durable control record and
      // ordered acknowledgement as the other owner commands.
      await admitControl(update, message, sessionKey, "digest");
      return;
    }
    if (parsed.command === "mcp") {
      const admin = gateway.mcpAdmin;
      if (!hostCommands.mcp || admin === undefined) {
        await admitNotice(update, message, sessionKey, MCP_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const parts = parsed.args.trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length === 0) {
        // Read-only: bounded listing of configured servers and waiting proposals. No effect.
        await admitNotice(update, message, sessionKey,
          renderMcpListing(await admin.list(adapterContext), MAX_NOTICE_CHARS));
        drain();
        return;
      }
      const [sub, id, ...extra] = parts;
      if ((sub === "show" || sub === "approve" || sub === "deny") && id !== undefined
        && extra.length === 0 && MCP_REQUEST_ID.test(id)) {
        if (sub === "show") {
          const shown = await admin.show(id, adapterContext);
          await admitNotice(update, message, sessionKey, shown.text, MCP_ADMIN_LIMITS.maxShowChars);
          drain();
          return;
        }
        // An approval writes configuration or starts an OAuth login: it uses the same durable
        // control record, ordered acknowledgement and chat gating as the other owner commands.
        await admitControl(update, message, sessionKey, sub === "approve" ? "mcp-approve" : "mcp-deny", id);
        return;
      }
      await admitNotice(update, message, sessionKey, MCP_USAGE);
      drain();
      return;
    }
    // The remaining controls are native mutations of this same chat. `/stop` is an alias of `/abort`:
    // it normalizes to the same control kind before admission, so the durable record, gating and
    // recovery path are shared and there is no second cancellation semantics.
    if (parsed.args) {
      await admitNotice(update, message, sessionKey, `Usage: /${parsed.command} (no arguments). Nothing was sent to the assistant.`);
      drain();
      return;
    }
    const mutation: TelegramMutation = parsed.command === "stop" ? "abort" : parsed.command;
    await admitControl(update, message, sessionKey, mutation);
  }

  /**
   * Admit one native mutation: durable record, held acknowledgement and offset commit before the
   * effect. The chat stays gated so its later inputs cannot overtake this command, and a refused
   * effect is reported instead of being recorded as applied.
   */
  async function admitControl(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    command: TelegramMutation,
    target?: string,
  ): Promise<void> {
    const chatId = message.chat.id;
    // An earlier command still owns this chat's order while it is applying or deferred. Refuse a
    // newer one instead of letting it apply first; there is no queue for it.
    if (controlPending.has(chatId) ||
        [...deferredControls.values()].some((entry) => entry.chatId === chatId)) {
      await admitNotice(update, message, sessionKey,
        "An earlier control command in this chat is still being applied or is still pending; this command was not " +
        "started and was not sent to the assistant. Wait for it to finish or restart the adapter.");
      drain();
      return;
    }
    // Refuse, never evict: a hung provider plus repeated commands must not grow the log without bound.
    if (state.controls.filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length >=
        MAX_UNRESOLVED_CONTROLS) {
      await admitNotice(update, message, sessionKey,
        `Too many control commands are still unconfirmed (limit ${MAX_UNRESOLVED_CONTROLS}); this /${command} was not ` +
        "started and was not sent to the assistant. Wait for them to finish or restart the adapter.");
      drain();
      return;
    }
    controlPending.add(chatId);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (!doc.controls.some((entry) => entry.updateId === update.update_id)) {
        doc.controls = pruneControls([
          ...doc.controls,
          {
            updateId: update.update_id,
            command,
            status: "admitted" as const,
            chatId,
            senderId: String(message.from!.id),
          },
        ], doc.pending);
      }
      if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId,
          sessionKey,
          senderId: String(message.from!.id),
          text: CONTROL_ACK[command],
          notice: true,
          hold: true,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    // Apply it off the polling loop, serialized per chat: other chats keep polling, and this chat's later inputs and
    // deliveries wait here so the command cannot land before a message admitted earlier.
    const record: DeferredControl = {
      updateId: update.update_id,
      command,
      chatId,
      ...(target === undefined ? {} : { target }),
    };
    const prior = controlChains.get(chatId) ?? Promise.resolve();
    const run = prior.then(() => applyControl(record));
    // The acknowledgement is published once: as the applied or refused wording when the native call returns, or as the
    // explicit still-pending wording when it does not. A provider that ignores cancellation keeps the chat gated, so no
    // later message can be withdrawn, and it is told plainly instead of being left silent.
    let ack: "waiting" | "pending" | "applied" | "refused" = "waiting";
    const pendingTimer = setTimeout(() => {
      if (ack !== "waiting") return;
      ack = "pending";
      void releaseControlNotice(update.update_id, CONTROL_PENDING[command]).catch(() => undefined);
    }, CONTROL_PENDING_NOTICE_MS);
    const chain = run.then(() => undefined, () => undefined);
    controlChains.set(chatId, chain);
    const task = run.then(async (outcome) => {
      if (outcome.kind === "refused") {
        // A known no-effect is recorded and reported as refused, never as applied: a later replay of this update
        // must not claim a change that did not happen.
        const wasWaiting = ack === "waiting";
        ack = "refused";
        await markControlRefused(update.update_id, outcome.text).catch(() => undefined);
        if (!wasWaiting) {
          // The still-pending wording was already published. Publish the final refusal as a
          // follow-up instead of losing it, still without any authorization URL (refusals never carry one).
          await publishLateControlNotice(
            update.update_id, chatId, sessionKey, String(message.from!.id), outcome.text,
          ).catch(() => undefined);
        }
        return;
      }
      if (outcome.kind !== "applied") {
        // Deferred: say plainly that the command is still pending; the chat keeps waiting and
        // the poll cadence retries the same ordered flush. Abandoned: the unconfirmed wording
        // was already released by the terminal report.
        if (ack !== "waiting") return;
        ack = "pending";
        if (outcome.kind === "deferred") {
          await releaseControlNotice(update.update_id, CONTROL_PENDING[command]).catch(() => undefined);
        }
        return;
      }
      if (ack !== "waiting") {
        // The acknowledgement was already published with the still-pending wording. The final outcome
        // still belongs to this command: deliver it as a follow-up, so a slow approval cannot lose its
        // only answer (the authorization URL is sent separately and is never stored).
        if (outcome.text !== undefined) {
          await publishLateControlNotice(
            update.update_id, chatId, sessionKey, String(message.from!.id), outcome.text,
          ).catch(() => undefined);
        }
        if (outcome.authorization !== undefined) {
          await deliverMcpAuthorization(
            target, outcome.authorization, update.update_id, chatId, sessionKey, String(message.from!.id),
          );
        }
        if (outcome.requestRestart === true) requestRestart();
        return;
      }
      ack = "applied";
      try {
        await releaseControlNotice(update.update_id, outcome.text);
      } finally {
        // The record, offset and acknowledgement are durable; the host owns the process replacement and is
        // still asked when the acknowledgement commit itself failed (its notice is then reported after the
        // restart by the recovery pass).
        if (outcome.requestRestart === true) requestRestart();
      }
      if (outcome.authorization !== undefined) {
        await deliverMcpAuthorization(
          target, outcome.authorization, update.update_id, chatId, sessionKey, String(message.from!.id),
        );
      }
    }, (error: unknown) => {
      // The record stays `admitted` and the acknowledgement stays held: a reopen reports it as unconfirmed.
      if (signal?.aborted) return;
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("Telegram control command failed"));
    }).catch(() => {
      // A failed acknowledgement release leaves the held notice for the next open to report; the command itself is done.
    }).finally(() => {
      clearTimeout(pendingTimer);
      pendingControls.delete(task);
      if (controlChains.get(chatId) === chain) {
        controlChains.delete(chatId);
        if (!stopping && !signal?.aborted) {
          // A deferred command keeps the chat gated, but notices (including its honest
          // still-pending acknowledgement) and other chats must still be dispatched.
          if (!deferredControls.has(update.update_id)) controlPending.delete(chatId);
          drain();
        }
      }
    });
    pendingControls.add(task);
    drain();
  }

  /**
   * Ask the host to replace this process, at most once per adapter lifetime. The acknowledgement
   * already told the chat that only the request is confirmed; a host refusal is logged and never
   * retried or upgraded into a success claim.
   */
  function requestRestart(): void {
    if (restartHostRequested) return;
    const host = options.restart;
    if (host === undefined || !host.supported) return;
    restartHostRequested = true;
    void host.request().catch(() => {
      restartHostRequestFailed = true;
      console.warn("Telegram /restart request was refused by the host; the gateway keeps running.");
    });
  }

  /**
   * `/digest`: start one bounded digestion batch for this chat's own conversation. The host returns
   * as soon as one native task is admitted; the digest turn runs in the background and reports to
   * this conversation's agent internally. Nothing waits for it and nothing is sent to a user.
   */
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

  /**
   * `/mcp approve <id>` and `/mcp deny <id>`: one owner decision on one agent proposal. The request is
   * consumed by the decision, so a replay finds nothing and a refusal is reported as refused. The
   * approval text is fixed and bounded; an authorization URL is appended for the owner only, never to
   * a model turn or transcript.
   */
  async function applyMcp(record: DeferredControl): Promise<ControlOutcome> {
    const admin = gateway.mcpAdmin;
    if (admin === undefined) return { kind: "refused", text: MCP_UNAVAILABLE_HOST };
    const id = record.target;
    if (id === undefined || !MCP_REQUEST_ID.test(id)) return { kind: "refused", text: MCP_USAGE };
    const result = record.command === "mcp-approve"
      ? await admin.approve(id, adapterContext)
      : await admin.deny(id, adapterContext);
    // The authorization URL is delivered by the command completion, after the acknowledgement and
    // directly to this chat. It is deliberately absent from `text`, so channel state never persists it.
    const text = result.authorization === undefined ? renderMcpApproval(result, MAX_NOTICE_CHARS) : result.text;
    return result.status === "refused"
      ? { kind: "refused", text }
      : { kind: "applied", text, ...(result.authorization === undefined ? {} : { authorization: result.authorization }) };
  }

  /**
   * Deliver one authorization URL as an ordinary plain message. Not stored: a rich or queued notice
   * would persist the value and its state in channel state, which this delivery deliberately avoids.
   * If it cannot be delivered, the just-started login is canceled instead of leaving an attempt that
   * nobody can finish.
   */
  async function deliverMcpAuthorization(
    requestId: string | undefined,
    authorization: { readonly url: string; readonly expiresAtMs: number },
    updateId: number,
    chatId: number,
    sessionKey: string,
    senderId: string,
  ): Promise<void> {
    try {
      await sendAuthorizationUrl(chatId, senderId, authorization);
    } catch {
      if (requestId !== undefined) {
        await gateway.mcpAdmin?.deny(requestId, adapterContext).catch(() => undefined);
      }
      await publishLateControlNotice(updateId, chatId, sessionKey, senderId,
        "The MCP login was canceled because its one-time authorization URL could not be confirmed as delivered " +
        "to this chat. Approve a new login request to get a fresh URL.").catch(() => undefined);
    }
  }

  /** Send one authorization URL as an ordinary plain message; it is never put in the durable outbox. */
  async function sendAuthorizationUrl(
    chatId: number,
    senderId: string,
    authorization: { readonly url: string; readonly expiresAtMs: number },
  ): Promise<void> {
    // The same live allowlist check every durable notice performs: a removed sender gets no URL.
    if (!options.allowFrom.includes(senderId)) throw new Error("the approving sender is no longer authorized");
    if (authorization.expiresAtMs <= Date.now()) {
      throw new Error("authorization URL expired before it could be delivered");
    }
    const text = [
      "MCP OAuth authorization URL (owner only):",
      authorization.url,
      `Valid until ${new Date(authorization.expiresAtMs).toISOString()}.`,
      "Open it as the owner in a browser that can reach this host. This gateway does not store this URL or its state.",
    ].join("\n");
    if (text.length > PLAIN_TEXT_LIMIT) throw new Error("authorization URL is too long for one message");
    await apiCall(api, "sendMessage", signal, (callSignal) => withChatSendOrder(chatId, () =>
      api.sendMessage(chatId, text, {}, toGrammySignal(callSignal))), { throttle: outboundThrottle });
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

  /**
   * Submit every input admitted before this command, then apply the native call and record
   * it. A transient failure while flushing earlier inputs is not fatal: the command stays
   * admitted, the chat stays gated, and the poll cadence retries the same ordered flush.
   * Repeated failures end in an explicit unconfirmed report rather than a silent takeover.
   */
  async function applyControl(record: DeferredControl): Promise<ControlOutcome> {
    try {
      for (const earlier of state.pending.filter((item) =>
        item.notice !== true && item.chatId === record.chatId && item.updateId < record.updateId &&
        options.allowFrom.includes(item.senderId))) {
        const earlierConversation = await gateway.conversationFor(earlier.sessionKey, adapterContext);
        // Prepare attachment content in the same chat order as a normal delivery: a media
        // message forced ahead of a control must not be submitted as text only.
        await submitInOrder(record.chatId, async () => {
          const content = await prepareInputContent(earlier);
          const submission = await earlierConversation.submit(
            { type: "input", content, requestId: requestIdFor(identity, earlier.updateId) },
            adapterContext,
          );
          // The normal delivery path reuses this turn, so a control-forced input is answered
          // exactly once even when it settles before the chat's gate is released.
          earlySubmissions.set(earlier.updateId, submission);
          return submission;
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const attempts = (controlFailures.get(record.updateId) ?? 0) + 1;
      if (attempts < MAX_CONTROL_ATTEMPTS) {
        controlFailures.set(record.updateId, attempts);
        deferredControls.set(record.updateId, record);
        return { kind: "deferred" };
      }
      // A permanently failing earlier input cannot be overtaken. Report the command
      // honestly and release the gate instead of leaving the chat unusable forever.
      controlFailures.delete(record.updateId);
      deferredControls.delete(record.updateId);
      await markControlUnconfirmed(record.updateId);
      return { kind: "abandoned" };
    }
    const sessionKey = `telegram:${identity}:chat:${record.chatId}`;
    let outcome: ControlOutcome;
    if (record.command === "new") {
      outcome = await applyNewSession(sessionKey);
    } else if (record.command === "abort") {
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      await conversation.abort(adapterContext);
      outcome = { kind: "applied" };
    } else if (record.command === "digest") {
      outcome = await applyDigest(sessionKey);
    } else if (record.command === "mcp-approve" || record.command === "mcp-deny") {
      outcome = await applyMcp(record);
    } else if (record.command === "restart") {
      // No conversation effect: the record and its acknowledgement are durable first, and the host
      // replacement is requested by the caller only after that acknowledgement was released.
      outcome = { kind: "applied", text: CONTROL_ACK.restart, requestRestart: true };
    } else {
      outcome = await applyModelPreset(record, sessionKey);
    }
    if (outcome.kind !== "applied") return outcome;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const entry = doc.controls.find((item) => item.updateId === record.updateId);
      if (entry !== undefined) entry.status = "applied";
      // Bound the log here too: only applied, refused and already-reported records are pruned.
      doc.controls = pruneControls(doc.controls, doc.pending);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    controlFailures.delete(record.updateId);
    deferredControls.delete(record.updateId);
    return outcome;
  }

  /**
   * `/new`: a native reset plus, when the host offers it, a rebuild of this session's assembled
   * workspace prompt from the current on-disk files. The host refuses while a run is live, so a
   * half-effect (reset without rebuild, or a new snapshot leaking into a running turn) is never
   * reported as applied.
   */
  async function applyNewSession(sessionKey: string): Promise<ControlOutcome> {
    const resetSession = gateway.resetSession;
    if (resetSession === undefined) {
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      await conversation.reset(undefined, adapterContext);
      return { kind: "applied" };
    }
    const result: GatewaySessionReset = await resetSession.call(gateway, sessionKey, adapterContext);
    if (result.status === "busy") return { kind: "refused", text: RESET_BUSY };
    if (!result.promptRebuilt) return { kind: "applied" };
    return {
      kind: "applied",
      text: [
        CONTROL_ACK.new,
        `This session's assembled workspace prompt was rebuilt from the current files: ${result.skills} ` +
          "skill(s) are listed for on-demand loading. The new session's next request uses that snapshot; requests " +
          "already prepared, other chats and the configuration are unchanged.",
      ].join("\n"),
    };
  }

  /**
   * The only model effect a chat command may have: select one configured preset, or `default` for the
   * configured default. The host selection rejects atomically (including a busy conversation), so a
   * refusal is a known no-effect on this chat's selection and is never retried or reported as applied.
   */
  async function applyModelPreset(record: DeferredControl, sessionKey: string): Promise<ControlOutcome> {
    const selectPreset = gateway.selectModelPreset;
    if (selectPreset === undefined || record.target === undefined) {
      return { kind: "refused", text: MODEL_UNAVAILABLE_HOST };
    }
    try {
      const selected: GatewayModelSelection = await selectPreset.call(gateway, sessionKey, record.target, adapterContext);
      return {
        kind: "applied",
        text: [
          `Selected preset ${boundedLabel(record.target, 80)} for this chat: ` +
            `${boundedLabel(selected.provider, 80)}/${boundedLabel(selected.modelId, 160)} ` +
            `(thinking: ${boundedLabel(selected.thinkingLevel, 32)}).`,
          "Only this chat's selection changed; other chats keep theirs and the configuration was not rewritten.",
          "The selection lasts while this gateway stays open: a restart restores the configured default preset, and " +
            "requests already prepared keep the model they were prepared with.",
        ].join("\n"),
      };
    } catch (error) {
      if (isConversationBusy(error)) {
        return {
          kind: "refused",
          text: "Model preset selection rejected: this chat is busy, so nothing changed. " +
            "Retry /model when this chat is idle. It was not queued and no other chat was affected.",
        };
      }
      return {
        kind: "refused",
        text: "Model preset selection was refused, so this chat's selection is unchanged. " +
          "Use /model to list the configured presets.",
      };
    }
  }

  /**
   * Retry deferred commands once per poll response. The chat stays gated meanwhile, so no
   * input admitted after the command can overtake the earlier durable inputs. This reuses
   * the durable control record and the existing poll cadence; there is no separate queue.
   */
  function resumeDeferredControls(): void {
    if (stopping || signal?.aborted) return;
    for (const record of [...deferredControls.values()]) {
      if (controlChains.has(record.chatId)) continue;
      const prior = controlChains.get(record.chatId) ?? Promise.resolve();
      const run = prior.then(() => applyControl(record));
      const chain = run.then(() => undefined, () => undefined);
      controlChains.set(record.chatId, chain);
      const task = run.then(() => undefined, (error: unknown) => {
        // A native reset/abort or storage failure is still a real adapter failure.
        if (signal?.aborted) return;
        fatal ??= error;
        scope.cancel(error instanceof Error ? error : new Error("Telegram control command failed"));
      }).catch(() => undefined).finally(() => {
        pendingControls.delete(task);
        if (controlChains.get(record.chatId) === chain) {
          controlChains.delete(record.chatId);
          if (!stopping && !signal?.aborted) {
            if (!deferredControls.has(record.updateId)) controlPending.delete(record.chatId);
            drain();
          }
        }
      });
      pendingControls.add(task);
    }
  }

  /**
   * Publish a final control outcome whose "still pending" notice was already sent. When that notice is
   * still queued it is replaced; once it was delivered (and forgotten) a fresh notice is admitted under
   * the same update ID, which no longer collides with any pending record.
   */
  async function publishLateControlNotice(
    updateId: number,
    chatId: number,
    sessionKey: string,
    senderId: string,
    text: string,
  ): Promise<void> {
    const body = text.slice(0, MAX_LATE_CONTROL_CHARS);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice !== undefined) {
        notice.text = body;
        delete notice.hold;
        return copyJson(doc) as unknown as ChannelState;
      }
      if (doc.pending.length >= MAX_ADMITTED) return copyJson(doc) as unknown as ChannelState;
      doc.pending.push({
        updateId,
        nextChunkIndex: 0,
        chatId,
        sessionKey,
        senderId,
        text: body,
        notice: true,
      });
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
    drain();
  }

  /** Publish the held acknowledgement, optionally as the still-pending wording. */
  async function releaseControlNotice(updateId: number, text?: string): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice === undefined) return copyJson(doc) as unknown as ChannelState;
      if (text !== undefined) notice.text = text;
      delete notice.hold;
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  }

  /** Report that an admitted command never confirmed its effect, and release its held acknowledgement. */
  async function markControlUnconfirmed(updateId: number): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const entry = doc.controls.find((item) => item.updateId === updateId);
      if (entry !== undefined) entry.status = "unconfirmed";
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice !== undefined) {
        notice.text = entry?.command === "restart" ? UNCONFIRMED_RESTART : UNCONFIRMED_CONTROL;
        delete notice.hold;
      }
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }

  /**
   * Record a proven no-effect outcome and publish its refusal wording instead of an applied
   * acknowledgement. A later replay of the same update reports the refusal; the command is never retried.
   */
  async function markControlRefused(updateId: number, text: string): Promise<void> {
    const bounded = text.slice(0, MAX_NOTICE_CHARS);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const entry = doc.controls.find((item) => item.updateId === updateId);
      if (entry !== undefined) entry.status = "refused";
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice !== undefined) {
        notice.text = bounded;
        delete notice.hold;
      }
      doc.controls = pruneControls(doc.controls, doc.pending);
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  }

  /**
   * The host model catalog is per-session, so this chat's mapped conversation must exist first. That
   * mapping is the adapter's own bound for the CURRENT authenticated chat: it creates no other
   * conversation, grants no root authority, and holds no model call.
   */
  async function readModelListing(sessionKey: string): Promise<GatewayModelList | undefined> {
    if (gateway.listModels === undefined) return undefined;
    try {
      await gateway.conversationFor(sessionKey, adapterContext);
      return await gateway.listModels(sessionKey, adapterContext);
    } catch {
      return undefined;
    }
  }

  /**
   * Bounded point-in-time metadata of this authenticated chat through the same native conversation
   * projection the terminal uses. Read only: no model call, no watch, no transcript, prompt, tool
   * argument or other chat, and no configuration change.
   */
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
      // Additive, bounded and read-only: this chat's own workers and cron jobs, plus whether the one
      // shared workspace digestion run is live. A read failure adds nothing; the core status stands.
      let background: string[] = [];
      try {
        if (typeof gateway.backgroundStatus === "function") {
          background = renderBackgroundStatus(await gateway.backgroundStatus(sessionKey, adapterContext));
        }
      } catch {
        background = [];
      }
      return [
        "Status for this chat (no model call, no configuration change):",
        `Model: ${boundedLabel(model, 240)}${preset === undefined ? "" : ` — preset ${boundedLabel(preset, 80)}`}`,
        status.run === undefined
          ? "Run: idle"
          : `Run: running (turn ${status.run.taskId}, ${status.run.inputs} input(s)` +
            `${status.run.attempt === undefined ? "" : `, generation attempt ${status.run.attempt}`})`,
        `Queued native inputs: ${status.inbox.total}`,
        ...background,
        "Only this chat's own records were read; no other chat's transcript, prompt or tool argument is included.",
      ].join("\n");
    } catch {
      return "Status is unavailable right now: this chat's conversation metadata could not be read. " +
        "No model call was made and nothing changed.";
    }
  }

  /** One bounded listing of the current selection and the finite configured choices. */
  function modelListingText(listing: GatewayModelList): string {
    const maxChoices = 50;
    const selectedLine = `Current model: ${boundedLabel(listing.selected.provider, 80)}/` +
      `${boundedLabel(listing.selected.modelId, 160)} (thinking: ${boundedLabel(listing.selected.thinkingLevel, 32)}).`;
    const presets = listing.presets ?? [];
    if (presets.length === 0) {
      // Legacy direct-model configuration: the selection and its allowed choices are shown read only.
      const rows = listing.models.slice(0, maxChoices).map((choice) => {
        const current = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
        const levels = choice.thinkingLevels.map((level) => boundedLabel(level, 32)).join(", ");
        return `  ${current ? "* " : "  "}${boundedLabel(choice.provider, 80)} ${boundedLabel(choice.modelId, 160)} ` +
          `— ${boundedLabel(choice.name, 160)} [thinking: ${levels === "" ? "off" : levels}]`;
      });
      if (listing.models.length > maxChoices) {
        rows.push(`  … ${listing.models.length - maxChoices} more allowed models omitted`);
      }
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
      return `  ${preset.name === selectedPreset ? "* " : "  "}${boundedLabel(preset.name, 80)} — ` +
        `${boundedLabel(preset.provider, 80)} ${boundedLabel(preset.modelId, 160)} ` +
        `[thinking: ${boundedLabel(preset.thinkingLevel ?? "off", 32)}]${isDefault ? " (default)" : ""}`;
    });
    if (presets.length > maxChoices) rows.push(`  … ${presets.length - maxChoices} more named presets omitted`);
    return [
      selectedLine,
      ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${boundedLabel(listing.defaultPreset, 80)}.`]),
      "Named model presets (use /model <name>, or /model default for the configured preset):",
      ...rows,
      "A selection applies to this chat only and lasts while the gateway stays open; a restart restores the " +
        "configured default and prepared requests keep their model.",
    ].join("\n");
  }

  /** The commands this host actually supports, in menu order. */
  function availableCommandList(): string {
    return ["/new", "/abort", "/stop", ...(hostCommands.status ? ["/status"] : []),
      ...(hostCommands.model ? ["/model"] : []), ...(hostCommands.restart ? ["/restart"] : []),
      ...(hostCommands.digest ? ["/digest"] : []), ...(hostCommands.mcp ? ["/mcp"] : []), "/help"].join(", ");
  }

  /** Help lists exactly the controls this host implements; nothing is advertised that would be refused. */
  function controlHelpText(): string {
    const lines = [
      "Controls for this chat (other messages go to the assistant):",
      "/new - native context reset for this conversation: fresh model context, no summary or handoff; stored history and tool authority unchanged; queued messages are kept.",
      "/abort - withdraw queued messages and stop the current turn here; other chats, cron jobs and background work are unaffected.",
      "/stop - alias of /abort with exactly the same effect.",
    ];
    if (hostCommands.status) {
      lines.push("/status - bounded read-only status of this chat: selected model, run state and queued input count; no model call.");
    }
    if (hostCommands.model) {
      lines.push("/model - list the configured model presets and this chat's selection; /model <preset> or /model default " +
        "selects one for this chat only. A busy chat is refused, and a restart restores the configured default.");
    }
    if (hostCommands.restart) {
      lines.push("/restart - stop this gateway and replace the process with the same program and configuration, so new " +
        "code and configuration are loaded. It affects every chat and background work; the acknowledgement confirms " +
        "the request, not the completed restart.");
    }
    if (hostCommands.digest) {
      lines.push("/digest - start one bounded completed-turn memory-digestion run from the shared workspace; the run is " +
        "background, and only a failure or cancellation reports an internal issue to this chat's agent, never a direct " +
        "user or channel message. /digest status is a bounded read-only view; both cost no model call by themselves.");
    }
    if (hostCommands.mcp) {
      lines.push("/mcp - list the MCP servers this gateway opened and the assistant's owner-approval requests; " +
        "/mcp show <id> prints the exact proposed entry; /mcp approve <id> writes it to the configuration file or " +
        "starts an owner-approved OAuth login and returns its one-time authorization URL; /mcp deny <id> discards " +
        "the request. Nothing connects or is authorized before an approval, and a written entry connects at the " +
        "next gateway start. These are owner actions, never model tools.");
    }
    lines.push("/help - this list.");
    lines.push(mediaIngress === undefined
      ? "Limits: text only (attachments are not read); no tool-authority, history, restart or media commands. " +
        "Other slash commands are refused; prefix // to send a leading slash literally."
      : "Attachments: photos are attached as image content, voice/audio is transcribed locally when the backend is " +
        "provisioned, and documents are stored unread on disk under the configured media directory. Video and stickers " +
        "are not downloaded. Other slash commands are refused; prefix // to send a leading slash literally.");
    return lines.join("\n");
  }

  async function admitNotice(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    text: string,
    limit: number = MAX_NOTICE_CHARS,
  ): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId: message.chat.id,
          sessionKey,
          senderId: String(message.from!.id),
          text: text.slice(0, limit),
          notice: true,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }

  async function persistOffset(offset: number) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.offset = Math.max(doc.offset, offset);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }
}

const DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "pending", "sending", "unknown", "withheld", "delivered", "failed", "unauthorized",
]);

function pendingRecordProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "delivery outbox contains an unusable record";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") {
    return "delivery outbox contains an unusable record";
  }
  if (typeof record.status !== "string" || !DELIVERY_STATUSES.has(record.status)) {
    return "delivery record has an invalid status";
  }
  if (record.status !== "pending") return undefined;
  if (typeof record.sessionKey !== "string" || record.sessionKey === "") {
    return "delivery record has no origin session";
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return "delivery record has no text";
  }
  if (!Number.isSafeInteger(record.nextChunkIndex) || (record.nextChunkIndex as number) < 0) {
    return "delivery record has an invalid chunk cursor";
  }
  if (record.telegramChunkPlan !== undefined && record.telegramChunkPlan !== "legacy" &&
      record.telegramChunkPlan !== "rich-v1") return "delivery record has an invalid chunk plan";
  return undefined;
}

function outboxFaultMessage(error: unknown): string {
  return error instanceof CronDeliveryOutboxError
    ? "delivery outbox is malformed"
    : "delivery outbox could not be read";
}

function originBindingOf(
  origins: Readonly<Record<string, TelegramOriginBinding>> | undefined,
  chatId: number,
  botId: string,
): TelegramOriginBinding | undefined {
  if (origins === undefined) return undefined;
  const binding = origins[String(chatId)];
  if (binding === undefined || binding.botId !== botId || binding.chatType !== "private") return undefined;
  if (typeof binding.senderId !== "string" || !/^\d+$/.test(binding.senderId)) return undefined;
  if (!Number.isSafeInteger(binding.admittedAtMs)) return undefined;
  return binding;
}

function validateOptions(options: TelegramOptions): void {
  if (!options.token || /[\r\n]/.test(options.token)) throw new Error("Telegram token is required");
  if (options.allowFrom.length === 0 || options.allowFrom.some((id) => !/^\d+$/.test(id))) {
    throw new Error("Telegram requires a non-empty allowFrom list of decimal user IDs");
  }
  if (options.pollTimeoutSeconds !== undefined &&
      (!Number.isInteger(options.pollTimeoutSeconds) || options.pollTimeoutSeconds < 0 || options.pollTimeoutSeconds > POLL_TIMEOUT_MAX)) {
    throw new Error(`pollTimeoutSeconds must be an integer from 0 to ${POLL_TIMEOUT_MAX}`);
  }
  if (options.media !== undefined) {
    if (typeof options.media.workspace !== "string" || options.media.workspace.trim() === "") {
      throw new Error("telegram media requires a configured workspace");
    }
    const transcription = options.media.transcription;
    if (transcription !== undefined) {
      if (transcription.enabled !== undefined && typeof transcription.enabled !== "boolean") {
        throw new Error("media.transcription.enabled must be a boolean");
      }
      if (transcription.language !== undefined && !/^[A-Za-z0-9_-]{1,35}$/.test(transcription.language)) {
        throw new Error("media.transcription.language must be a short language code");
      }
      if (transcription.maxDurationSeconds !== undefined &&
          (!Number.isInteger(transcription.maxDurationSeconds) ||
            transcription.maxDurationSeconds < 1 || transcription.maxDurationSeconds > 3_600)) {
        throw new Error("media.transcription.maxDurationSeconds must be an integer from 1 to 3600");
      }
      if (transcription.timeoutMs !== undefined &&
          (!Number.isInteger(transcription.timeoutMs) || transcription.timeoutMs < 1 || transcription.timeoutMs > 900_000)) {
        throw new Error("media.transcription.timeoutMs must be an integer from 1 to 900000");
      }
      if (transcription.backend === "whisper-cli") {
        const engine = transcription.whisperCli;
        if (engine === undefined) {
          throw new Error("media.transcription.backend \"whisper-cli\" requires media.transcription.whisperCli");
        }
        for (const key of ["binary", "model", "vadModel", "ffmpeg", "ffprobe"] as const) {
          const value = engine[key];
          if (typeof value !== "string" || !value.startsWith("/")) {
            throw new Error(`media.transcription.whisperCli.${key} must be an absolute path`);
          }
        }
      } else if (transcription.backend !== undefined && transcription.backend !== "faster-whisper") {
        throw new Error("media.transcription.backend must be faster-whisper or whisper-cli");
      } else if (transcription.whisperCli !== undefined) {
        throw new Error("media.transcription.whisperCli is required exactly when backend is whisper-cli");
      }
    }
  }
}

function createMediaIngress(options: TelegramMediaOptions | undefined): TelegramMediaIngress | undefined {
  if (options === undefined) return undefined;
  const store = createMediaStore({
    workspace: options.workspace,
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    maxFileBytes: TELEGRAM_MEDIA_LIMITS.maxFileBytes,
  });
  const transcriber = createTranscriber({ ...(options.transcription ?? {}) });
  return { store, transcriber };
}

function safeAnnouncedSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Permanent attachment refusals keep their meaning in the model-facing failure note. */
const MEDIA_REJECTION_TEXT: Record<MediaRejectionReason, string> = {
  "too-large": "the file exceeds the configured size limit",
  "unsafe-path": "the file locator was rejected as unsafe",
  "unsafe-directory": "the attachment directory is not a plain directory inside the workspace",
  empty: "the file was empty",
  unavailable: "Telegram did not provide the file",
};

const TRANSCRIPTION_FAILURE_TEXT: Record<TranscriptionFailure, string> = {
  unavailable: "the local speech backend or model is not provisioned",
  timeout: "local transcription timed out",
  cancelled: "local transcription was cancelled",
  "too-large": "the audio exceeds the duration limit",
  failed: "local transcription failed",
  empty: "no speech was recognized",
};

/**
 * Bound concurrent attachment work across chats so downloads and local
 * transcription never starve polling. Waiters release immediately on abort.
 */
class MediaWorkGate {
  readonly #max: number;
  #active = 0;
  readonly #waiters: {
    resolve(): void;
    reject(error: unknown): void;
    readonly signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }[] = [];

  constructor(max: number) {
    this.#max = Math.max(1, Math.trunc(max));
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#active -= 1;
      return;
    }
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    // The released slot passes straight to the next waiter.
    waiter.resolve();
  }
}

function isAllowedPrivateMessage(
  message: Update["message"],
  allowFrom: readonly string[],
): message is TelegramMessage {
  return message !== undefined && message.chat.type === "private" && message.from !== undefined &&
    !message.from.is_bot && allowFrom.includes(String(message.from.id));
}

/**
 * A reaction change is a user action, not an anonymous/group one. `actor_chat` marks an anonymous
 * actor, which this adapter never admits; a bot's reaction is never a user turn.
 */
function isAllowedPrivateReaction(
  reaction: MessageReactionUpdated | undefined,
  allowFrom: readonly string[],
): reaction is MessageReactionUpdated & { user: NonNullable<MessageReactionUpdated["user"]> } {
  return reaction !== undefined && reaction.chat.type === "private" && reaction.user !== undefined &&
    !reaction.user.is_bot && allowFrom.includes(String(reaction.user.id)) &&
    reaction.actor_chat === undefined;
}

/** The chat id encoded by this adapter's own mapped session key, never a model-supplied value. */
function chatIdForSession(sessionKey: string, botId: string): number | undefined {
  const prefix = `telegram:${botId}:chat:`;
  if (!sessionKey.startsWith(prefix)) return undefined;
  const raw = sessionKey.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
  const chatId = Number(raw);
  return Number.isSafeInteger(chatId) ? chatId : undefined;
}

/**
 * Bounded reference context for a quoted/replied-to message in the same private chat. The text is
 * untrusted reference, never authorization; an observed target is recorded only as an identity.
 */
function quotedMessageContext(
  message: TelegramMessage,
  botId: string,
): { readonly context: TelegramQuotedContext; readonly target?: TelegramObservedTarget } | undefined {
  const quoted = message.reply_to_message;
  if (quoted === undefined || quoted.chat.id !== message.chat.id) return undefined;
  const text = quoted.text ?? quoted.caption ?? "";
  const from = quoted.from;
  const author: TelegramQuotedContext["author"] = from === undefined
    ? "unknown"
    : from.is_bot
      ? (String(from.id) === botId ? "the assistant" : "another bot")
      : "the user";
  const context: TelegramQuotedContext = { messageId: quoted.message_id, author, text };
  if (!Number.isSafeInteger(quoted.message_id) || quoted.message_id < 1) return { context };
  return {
    context,
    target: {
      chatId: quoted.chat.id,
      messageId: quoted.message_id,
      direction: author === "the assistant" ? "outgoing" : "incoming",
      senderId: from === undefined ? "unknown" : String(from.id),
      text,
      observedAtMs: Date.now(),
    },
  };
}

/**
 * Only commands this adapter actually implements for this host belong in the native menu. `/status`,
 * `/model`, `/digest` and `/restart` are omitted for a host that exposes no such operation.
 */
function telegramCommands(
  host: TelegramCommandHost,
): readonly { readonly command: string; readonly description: string }[] {
  return [
    { command: "new", description: "Reset this conversation's context" },
    { command: "abort", description: "Stop this turn and withdraw queued messages" },
    { command: "stop", description: "Alias of /abort: stop this turn here" },
    ...(host.status ? [{ command: "status", description: "Show this chat's model and run status" }] : []),
    ...(host.model ? [{ command: "model", description: "List or select a configured model preset" }] : []),
    ...(host.restart ? [{ command: "restart", description: "Restart the gateway process" }] : []),
    ...(host.digest ? [{ command: "digest", description: "Run one bounded memory-digestion batch" }] : []),
    ...(host.mcp ? [{ command: "mcp", description: "Review and approve MCP server proposals" }] : []),
    { command: "help", description: "Show the available commands" },
  ];
}

/** Which optional host operations this adapter may advertise and apply. */
type TelegramCommandHost = {
  readonly status: boolean;
  readonly model: boolean;
  readonly restart: boolean;
  readonly digest: boolean;
  readonly mcp: boolean;
};

type ParsedTelegramInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: TelegramControl; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string }
  | { readonly kind: "foreign"; readonly command: string; readonly mention: string };

type TelegramControl = "new" | "abort" | "stop" | "help" | "status" | "model" | "restart" | "digest" | "mcp";

/**
 * A command with a native effect on this chat or this process; a refusal is terminal, never retried.
 * `/stop` normalizes to `abort` here, so one control kind covers both spellings.
 */
type TelegramMutation = "new" | "abort" | "model" | "restart" | "digest" | "mcp-approve" | "mcp-deny";

type ControlOutcome =
  | {
      readonly kind: "applied";
      readonly text?: string;
      readonly requestRestart?: true;
      /** One-time owner URL, delivered directly and never stored in channel state. */
      readonly authorization?: { readonly url: string; readonly expiresAtMs: number };
    }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

const CONTROL_ACK: Record<TelegramMutation, string> = {
  new:
    "Context reset applied for this chat (native Durable reset, no handoff text, no summary). " +
    "Stored entries and tool authority are unchanged; queued messages are kept and run in the new context.",
  abort:
    "Abort applied for this chat: it is idle now. Queued messages were withdrawn and any running turn was stopped; " +
    "other chats, cron jobs and background work are unaffected.",
  model:
    "Model preset selection is being applied to this chat only. Nothing was sent to the assistant.",
  restart:
    "Restart requested for this gateway: it is stopping so the same process can reload its code and configuration. " +
    "This acknowledgement confirms the request only; it does not confirm that the restart completed.",
  digest:
    "Memory digestion request applied for this chat; the bounded run follows separately and reports only a failure or cancellation to this chat's agent.",
  "mcp-approve": "The MCP approval was applied; its result follows in this message.",
  "mcp-deny": "The MCP request was denied; nothing was configured, connected or authorized.",
};

const CONTROL_PENDING: Record<TelegramMutation, string> = {
  new:
    "Context reset is still pending for this chat: Durable has not admitted it yet. Stored entries, tool authority and " +
    "queued messages are unchanged, and this chat keeps waiting instead of losing the request.",
  abort:
    "Abort is still pending for this chat: Durable has not finished stopping the current turn, so the provider may be " +
    "ignoring cancellation. Queued messages stay withdrawn and new messages are held, never answered and never " +
    "dropped, until the turn ends. Other chats, cron jobs and background work are unaffected.",
  model:
    "Model preset selection is still pending for this chat: messages admitted earlier are being submitted first. " +
    "This chat keeps waiting; nothing was applied yet and nothing was sent to the assistant.",
  restart:
    "Restart is still pending for this gateway: messages admitted earlier in this chat are being submitted first. " +
    "Nothing has been restarted yet and nothing was sent to the assistant.",
  digest:
    "Memory digestion is still pending for this chat: messages admitted earlier are being submitted first. " +
    "Nothing has been started yet and nothing was sent to the assistant.",
  "mcp-approve":
    "The MCP approval is still pending: messages admitted earlier in this chat are being submitted first. " +
    "Nothing has been written, connected or authorized yet.",
  "mcp-deny":
    "The MCP denial is still pending: messages admitted earlier in this chat are being submitted first. " +
    "The request is still waiting and nothing was applied.",
};

const UNCONFIRMED_CONTROL =
  "That earlier command was interrupted before it was confirmed, so it may not have taken effect. " +
  "Send it again if you still need it.";

/** An interrupted restart is never repeated automatically, and resending it is the caller's decision. */
const UNCONFIRMED_RESTART =
  "That earlier /restart was interrupted before it was confirmed: it may or may not have restarted the gateway, " +
  "and it is not requested again.";

/** Fixed, sanitized refusals: a narrow host advertises nothing it cannot do. */
const STATUS_UNAVAILABLE_HOST =
  "Status is unavailable in this host: it exposes no model/status metadata for this chat. Nothing was sent to the assistant.";
const MODEL_UNAVAILABLE_HOST =
  "Model commands are unavailable in this host: it exposes no preset catalog or preset selection. Nothing was sent to the assistant.";
const MODEL_LISTING_UNAVAILABLE =
  "Model choices are unavailable right now: this chat's host model catalog could not be read. Nothing changed.";
const MODEL_PRESETS_UNAVAILABLE =
  "Named model presets are not configured in this deployment, so /model <name> and /model default are unavailable. " +
  "Nothing was changed; /model lists the current selection read only, and this chat command never rewrites the configuration.";
const MODEL_USAGE =
  "Usage: /model (list the configured presets) or /model <preset> (or /model default). Nothing was sent to the assistant.";
const MCP_UNAVAILABLE_HOST =
  "MCP management is unavailable in this host: the gateway was opened without an on-disk configuration file, " +
  "so there is nothing to write. Nothing was sent to the assistant.";
/** One pending owner approval request. Opaque, fixed-width and content-bound at creation. */
const MCP_REQUEST_ID = /^[0-9a-f]{16}$/;
const MCP_USAGE =
  "Usage: /mcp (servers and waiting requests) | /mcp show <id> | /mcp approve <id> | /mcp deny <id>. " +
  "Nothing was sent to the assistant.";
const RESTART_UNAVAILABLE_HOST =
  "Restart is unavailable in this host: it cannot replace its own process with the same program and configuration. " +
  "Nothing was sent to the assistant.";
const RESTART_ALREADY_REQUESTED =
  "A restart was already requested in this gateway and is still stopping it; this /restart was not requested again.";
const RESTART_REQUEST_FAILED =
  "A restart was already requested in this gateway and the host refused it, so the gateway is still running. " +
  "This /restart was not requested again; fix the host and start the gateway yourself.";
const RESET_BUSY =
  "Context reset rejected: this chat has a running turn, so nothing was reset and the assembled workspace prompt was " +
  "not rebuilt. It was not queued; /abort this chat or retry /new when it is idle. Other chats are unaffected.";
const DIGEST_UNAVAILABLE_HOST =
  "Memory digestion is unavailable in this host: it exposes no manual digestion entry. Nothing was started and " +
  "nothing was sent to the assistant.";
const DIGEST_USAGE =
  "Usage: /digest (start one bounded batch) or /digest status (bounded read-only status). Nothing was sent to the assistant.";

/** Replay wording for a command this adapter recorded before a restart; it is never run twice. */
function replayControlText(entry: TelegramControlRecord): string {
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
  // Config preset names carry no whitespace or control characters; bidi/format characters would reorder the notice.
  if (name.length > 80 || !/^[^\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u.test(name)) return { kind: "usage" };
  return { kind: "preset", name };
}

/** Plain-text notice labels: no parse mode is used, and control/bidi characters never reach the chat. */
function boundedLabel(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return "(empty)";
  let bounded = cleaned.slice(0, max);
  // Never cut a surrogate pair.
  if (bounded.length > 0 && /[\uD800-\uDBFF]/u.test(bounded[bounded.length - 1]!)) bounded = bounded.slice(0, -1);
  return bounded;
}

/** The configured preset this chat currently uses, matched by provider/model/thinking. */
function matchingPresetName(listing: GatewayModelList): string | undefined {
  const selected = listing.selected;
  return listing.presets?.find((preset) => preset.provider === selected.provider &&
    preset.modelId === selected.modelId && (preset.thinkingLevel ?? "off") === selected.thinkingLevel)?.name;
}

function isConversationBusy(error: unknown): boolean {
  return error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
}


const TELEGRAM_COMMAND = new RegExp(
  "^/([A-Za-z0-9_]{1," + COMMAND_NAME_MAX + "})(?:@([A-Za-z0-9_]{1," + BOT_MENTION_MAX + "}))?(?=\\s|$)",
);

/**
 * Classify one authenticated private-chat message. Only a leading exact command token counts; a bot mention must name
 * this bot, and everything else (including `//text`) stays ordinary assistant input.
 */
function parseTelegramInput(raw: string, botUsername: string | undefined): ParsedTelegramInput {
  if (!raw.startsWith("/")) return { kind: "input", text: raw };
  if (raw.startsWith("//")) return { kind: "input", text: raw.slice(1) };
  const match = TELEGRAM_COMMAND.exec(raw);
  if (!match) {
    // A malformed mention (`/new@`, `/new@@x`) is a command attempt, not assistant text.
    const malformed = /^\/([A-Za-z0-9_]{1,32})@/.exec(raw);
    return malformed === null
      ? { kind: "input", text: raw }
      : { kind: "unsupported", command: malformed[1]!.toLowerCase() };
  }
  const name = match[1]!;
  const mention = match[2];
  const command = name.toLowerCase();
  if (mention !== undefined && (botUsername === undefined || mention.toLowerCase() !== botUsername.toLowerCase())) {
    // Never execute or forward another bot's command; the caller answers with a bounded notice.
    return { kind: "foreign", command, mention: mention.toLowerCase() };
  }
  if (command === "new" || command === "abort" || command === "stop" || command === "help" ||
      command === "status" || command === "model" || command === "restart" || command === "digest" ||
      command === "mcp") {
    return { kind: "control", command, args: raw.slice(match[0].length).trim() };
  }
  return { kind: "unsupported", command };
}

/**
 * Keep every unresolved record, only the most recent applied ones, and a reported terminal record only while its
 * report is still queued. A hung provider plus repeated commands therefore cannot grow the log: unresolved records are
 * bounded by the admission limit and reported ones are pruned once delivered.
 */
function pruneControls(
  controls: readonly TelegramControlRecord[],
  pending: readonly TelegramPendingDelivery[],
): TelegramControlRecord[] {
  const totalApplied = controls.filter((entry) => entry.status === "applied").length;
  let drop = Math.max(0, totalApplied - MAX_CONTROL_RECORDS);
  const reported = new Set(pending.filter((item) => item.notice === true).map((item) => item.updateId));
  return controls.filter((entry) => {
    if ((entry.status === "unconfirmed" || entry.status === "refused") && !reported.has(entry.updateId)) return false;
    if (entry.status !== "applied" || drop === 0) return true;
    drop -= 1;
    return false;
  });
}

function requestIdFor(botId: string, updateId: number): string {
  return `telegram:${botId}:${updateId}`;
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT / 2) cut = remaining.lastIndexOf(" ", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT / 2) cut = TELEGRAM_LIMIT;
    if (cut > 0 && cut < remaining.length && /[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut--;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Plain fallback must preserve all whitespace and stay inside Telegram's per-message limit. */
function splitPlainTextLossless(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + TELEGRAM_LIMIT, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      const space = text.lastIndexOf(" ", end - 1);
      const boundary = newline >= offset + TELEGRAM_LIMIT / 2 ? newline + 1 :
        space >= offset + TELEGRAM_LIMIT / 2 ? space + 1 : end;
      end = boundary;
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

type ApiCallOptions = {
  throttle?: TelegramFloodGate;
  replaceable?: boolean;
  retryNetwork?: boolean;
};

type GrammySignal = Parameters<Api["getMe"]>[0];

function toGrammySignal(signal?: AbortSignal): GrammySignal {
  return signal as unknown as GrammySignal;
}

/**
 * grammY's Node build creates its own `AbortController` per call, and native fetch rejects that foreign
 * `AbortSignal`. Re-express it with a native controller so grammY's timeout and chat cancellation still
 * abort the in-flight request. The listener lives on grammY's per-call signal, so nothing outlives the call.
 */
export function telegramFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const signal: unknown = init?.signal;
  if (signal === undefined || signal === null || signal instanceof AbortSignal) {
    return globalThis.fetch(input, { ...init, redirect: "error" });
  }
  const controller = new AbortController();
  if ((signal as AbortSignal).aborted) controller.abort();
  else (signal as AbortSignal).addEventListener("abort", () => controller.abort(), { once: true });
  return globalThis.fetch(input, { ...init, signal: controller.signal, redirect: "error" });
}

/** Bot API methods whose request may already have been accepted when 5xx/transport fails. */
const AMBIGUOUS_SEND_METHODS: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  ...Object.values(TELEGRAM_SEND_METHODS),
]);

function isAmbiguousSendMethod(method: string): boolean {
  return AMBIGUOUS_SEND_METHODS.has(method);
}

async function apiCall<T>(
  api: Api,
  method: string,
  signal: AbortSignal | undefined,
  request: (signal?: AbortSignal) => Promise<T>,
  options: ApiCallOptions = {},
): Promise<T | undefined> {
  let waitedMs = 0;
  for (let attempt = 0; attempt < MAX_API_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (options.throttle) {
      for (;;) {
        if (options.replaceable && options.throttle.remainingMs() > 0) return undefined;
        waitedMs += await options.throttle.wait(signal, FLOOD_WAIT_BUDGET_MS - waitedMs);
        if (options.throttle.remainingMs() === 0) break;
      }
    }
    if (signal?.aborted) throw signal.reason;
    try {
      return await request(signal);
    } catch (error) {
      if (error instanceof GrammyError) {
        if (method === "editMessageText" && error.error_code === 400 &&
            (isNotModifiedDescription(error.description) || error.description === "Bad Request: message to edit not found")) {
          throw new TelegramApiError(method, error.error_code, "rejected", error.description);
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after;
          if (retryAfter !== undefined && (!Number.isFinite(retryAfter) || retryAfter <= 0)) {
            throw new TelegramApiError(method, 429, "rejected");
          }
          const deadline = Date.now() + (retryAfter === undefined ? FLOOD_WAIT_WITHOUT_HINT_MS : retryAfter * 1000);
          if (!Number.isFinite(deadline)) throw new TelegramApiError(method, 429, "rejected");
          options.throttle?.defer(deadline);
          if (options.replaceable) return undefined;
          if (attempt < MAX_API_ATTEMPTS - 1) continue;
          throw new TelegramApiError(method, 429, "rejected");
        }
        if (options.retryNetwork && error.error_code >= 500 && attempt < MAX_API_ATTEMPTS - 1) {
          await delay(backoff(attempt), signal);
          continue;
        }
        throw new TelegramApiError(method, error.error_code,
          isAmbiguousSendMethod(method) && error.error_code >= 500 ? "unknown" : "rejected", error.description);
      }
      if (error instanceof HttpError) {
        if (isAmbiguousSendMethod(method)) {
          if (isProvenPreConnectFailure(error.error)) {
            if (attempt < MAX_API_ATTEMPTS - 1 && !signal?.aborted) {
              await delay(backoff(attempt), signal);
              continue;
            }
            throw new TelegramApiError(method, 0, "not-sent");
          }
          throw new TelegramApiError(method, 0, "unknown");
        }
        if (signal?.aborted) throw signal.reason;
        if (options.retryNetwork && attempt < MAX_API_ATTEMPTS - 1) {
          await delay(backoff(attempt), signal);
          continue;
        }
      }
      if (signal?.aborted) throw signal.reason;
      if (isAmbiguousSendMethod(method)) throw new TelegramApiError(method, 0, "unknown");
      throw new Error(`Telegram ${method} transport failed`);
    }
  }
  throw new Error(`Telegram ${method} request attempts exhausted`);
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly outcome: "unknown" | "rejected" | "not-sent";
  readonly description: string | undefined;

  constructor(method: string, status: number, outcome: "unknown" | "rejected" | "not-sent", description?: string) {
    super(`Telegram ${method} failed with status ${status}`);
    this.method = method;
    this.status = status;
    this.outcome = outcome;
    this.description = description;
  }
}

function isNotModifiedDescription(description: string | undefined): boolean {
  const prefix = "Bad Request: message is not modified";
  return description === prefix || (description !== undefined && description.length <= 512 &&
    description.startsWith(`${prefix}: `));
}

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    isNotModifiedDescription(error.description);
}

function isMessageNotFound(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    error.description === "Bad Request: message to edit not found";
}

/** A response that provably never produced a message: a sub-5xx refusal or a pre-connect transport failure. */
function isProvenRefusal(error: unknown): boolean {
  return (error instanceof GrammyError && error.error_code < 500) ||
    (error instanceof HttpError && isProvenPreConnectFailure(error.error));
}

function isProvenPreConnectFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    const code = candidate.code ?? candidate.errno;
    if (code === "ENETDOWN" || code === "EHOSTUNREACH") return true;
    if (candidate.cause !== undefined) pending.push(candidate.cause);
  }
  return false;
}

function backoff(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** attempt);
}

class TelegramFloodGate {
  #retryAt = 0;

  remainingMs(): number {
    return Math.max(0, this.#retryAt - Date.now());
  }

  defer(deadline: number): void {
    this.#retryAt = Math.max(this.#retryAt, deadline);
  }

  async wait(signal: AbortSignal | undefined, budgetMs: number): Promise<number> {
    let waited = 0;
    while (this.remainingMs() > 0) {
      const remaining = this.remainingMs();
      if (remaining > budgetMs - waited) throw new Error("Telegram flood wait exceeds delivery budget");
      await delay(remaining, signal);
      waited += remaining;
    }
    return waited;
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ms;
  if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(deadline)) throw new Error("Invalid delay");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const chunk = Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, chunk);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
