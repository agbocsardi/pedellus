import { defineDoc, AssistantEntry } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, journalTelemetry, observeOperation } from "../observability.js";
import type { Message } from "grammy/types";
import type { CallbackQuery, MessageReactionUpdated, Update } from "grammy/types";
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
import {
  AskQuestionsDoc,
  claimOutcomeText,
  claimQuestionAnswer,
  claimTypedQuestionAnswer,
  AskDeliveryUnknown,
  parseQuestionCallback,
  questionCallbackData,
  renderQuestionText,
  type AskQuestionView,
} from "../questions/index.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import { MEDIA_LIMITS, MediaRejected, createMediaStore, type MediaRejectionReason, type MediaStore, type StoredMedia } from "../media/attachments.js";
import { WorkGate } from "../media/outbound.js";
import { createTranscriber, TRANSCRIPTION_FAILURE_TEXT, type HexEngine, type Transcriber, type TranscriptionBackend, type WhisperCliEngine } from "../media/transcription.js";
import {
  detectHostCapabilities,
  offeredChannelCommandNames,
  type ChannelGateway,
  type HostCapabilities,
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
  type ChannelMutation,
  type ControlLedger,
  type ControlRecord,
} from "./controls.js";
import { createOutboxDrainer, type OriginAuthorization } from "./outbox-drainer.js";
import {
  SubmissionOrderQueue,
  createPreviewWatcher,
  isLiveGeneratingFor,
  resolveOwnerBusyMode,
  resolveSharedDeliveryGroup,
  sharedDeliveryRole,
  type LiveView,
  type SubmissionSlot,
} from "./turn-runtime.js";
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
  TELEGRAM_COALESCE_LIMITS,
  coalescedInputText,
  findTarget,
  incomingContextText,
  observeTarget,
  reactionChangeSummary,
  retainReactionNote,
  takeReactionContextText,
  type TelegramActionRecord,
  type TelegramObservedTarget,
  type TelegramQuotedContext,
  type TelegramInputPart,
  type TelegramReactionNote,
} from "./telegram-interactions.js";
import { telegramLocationContext, telegramMessageContent } from "./telegram-content.js";
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
import type { TelegramActionRegistry } from "./telegram-tool.js";
import { createTelegramActions } from "./telegram-actions.js";
import {
  NOTICES_UNAVAILABLE_HOST,
  TelegramNoticeDismissals,
  archiveUnknownNotice,
  telegramNoticesCommand
} from "./telegram-notices.js";
import {
  POLL_TIMEOUT_MAX,
  TelegramApiError,
  type TelegramFloodGate,
  backoff,
  createTelegramTransport,
  delay,
  isMessageNotFound,
  isNotModified,
  isProvenRefusal,
  type ApiCallOptions,
  type ReadOutageHooks,
  type TelegramSendTextOptions,
} from "./telegram-transport.js";

export { TelegramApiError, telegramFetch } from "./telegram-transport.js";
export { TelegramNoticeDismissals } from "./telegram-notices.js";

/** The `sendMessage` limit; a rich message uses `RICH_TEXT_LIMIT` and falls back to this. */
const TELEGRAM_LIMIT = PLAIN_TEXT_LIMIT;
const MAX_ADMITTED = 1000;
/** Consecutive delivery failures after which a non-Telegram-rejected failure is held instead of retried forever. */
const MAX_DELIVERY_FAILURES = 10;
/** Consecutive failed admissions of one control update before the failure is fatal; each re-polls it. */
const MAX_CONTROL_ADMISSION_ATTEMPTS = 5;
const COMMAND_NAME_MAX = 32;
const BOT_MENTION_MAX = 64;
/** Chats that may be owed a restart confirmation, which is one message per requesting chat. */
const MAX_RESTART_CONFIRMATIONS = 8;
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
/** Coalescing delay between live preview edits. */
const PREVIEW_DELAY_MS = 700;

export type TelegramMediaTranscriptionOptions = {
  readonly enabled?: boolean;
  readonly language?: string;
  readonly maxDurationSeconds?: number;
  /** Absent keeps the existing uv/faster-whisper helper. */
  readonly backend?: TranscriptionBackend;
  /** Required exactly when `backend` is `whisper-cli`. */
  readonly whisperCli?: WhisperCliEngine;
  /** Required exactly when `backend` is `hex`. */
  readonly hex?: HexEngine;
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
 * Host-owned full-process restart for the authenticated-owner `/restart` control (the shared
 * {@link HostRestartController}). The adapter confirms the request, never the restart, and never
 * retries it.
 */
export type TelegramRestartHost = HostRestartController;

export type TelegramOptions = {
  token: string;
  allowFrom: readonly string[];
  pollTimeoutSeconds?: number;
  /**
   * Configured owner busy-mode, persisted on each admitted message so recovery and a later config
   * change cannot alter an already admitted message's semantics. Absent keeps follow-up queueing.
   */
  followUpMode?: FollowUpMode;
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
  /**
   * The busy-mode this message was admitted under. Absent is the historical follow-up queueing; a
   * stored `steer` keeps steering even when the configuration changes before its delivery.
   */
  whenBusy?: "steer";
  /** Host-generated layout for a read-only notice; its underlying text remains plain. */
  noticeFormat?: "status" | "model";
  /** The acknowledgement is withheld until the command's native call returns (or reports that it is still pending). */
  hold?: boolean;
  /**
   * When this ordinary input was durably admitted. Absent on a legacy record; such a record is never
   * merged with another one, because its arrival window is unknown.
   */
  admittedAtMs?: number;
  /** The inbound Telegram message id this input was admitted from, for coalesced-input labels. */
  inputMessageId?: number;
  /**
   * Messages this record already carries after one durable coalescing merge (the first is 1). Absent
   * means never merged; a merged record is never merged again, so a retry cannot exceed the bound.
   */
  coalescedParts?: number;
  /**
   * The control update whose final outcome this separate notice reports. It is used once that
   * control's own acknowledgement was already released (and may be sending, sent or quarantined), so
   * that record and its write-ahead provenance stay untouched; this one has its own host-allocated
   * negative update id.
   */
  lateFor?: number;
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

export type TelegramChannelState = {
  offset: number;
  pending: TelegramPendingDelivery[];
  controls: TelegramControlRecord[];
  /**
   * The chats that asked this process to replace itself, committed with their applied control records. The
   * replacement reports once that it is live and clears them, so a finished restart is confirmed instead of
   * leaving the owner with an unconfirmed request.
   */
  restart?: TelegramRestartRecord[];
  /** Durable authenticated sender-to-chat evidence keyed by decimal chat ID. */
  origins: Record<string, TelegramOriginBinding>;
  /** Bounded observed message identities that a model action may target. */
  targets: TelegramObservedTarget[];
  /** Bounded write-ahead records of model-requested native replies and reactions. */
  actions: TelegramActionRecord[];
  /** Bounded authenticated reaction changes kept as passive context for the next owner input. */
  reactionContext: TelegramReactionNote[];
};
export type TelegramRestartRecord = {
  chatId: number;
  senderId: string;
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
type TypingLoop = {
  /** Overlapping queued turns in one chat share this loop; the indicator stays until the last one settles. */
  turns: number;
  unavailable: boolean;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Whether the typing indicator truthfully represents live work of one admitted input: an active
 * generation attempt of that input's run. A queued input, a tool round, a run natively waiting for
 * another task, a parked run and an answered run are not generating, so they do not type. Typing is
 * therefore presence, never a promise of progress and never an endless keepalive for background work.
 */
export function telegramTypingActive(live: LiveView, submissionId: number | undefined): boolean {
  return isLiveGeneratingFor(live, submissionId);
}
type ChannelState = TelegramChannelState;

// Stored alongside the adapter's stable channel conversation, not in a plaintext sidecar.
export const TelegramState = defineDoc<ChannelState>({
  kind: "nanobot.telegram-state",
  version: 9,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  migrate: (value, fromVersion) => {
    if (fromVersion < 1 || fromVersion > 8) {
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
    // Pending restart confirmations arrived with version 8; earlier states migrate without any.
    const storedRestart = value.restart;
    if (storedRestart !== undefined && (!Array.isArray(storedRestart) || storedRestart.some((entry: unknown) =>
      entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      !Number.isSafeInteger((entry as Record<string, unknown>).chatId) ||
      typeof (entry as Record<string, unknown>).senderId !== "string"))) {
      throw new Error("Stored Telegram state contains invalid restart records");
    }
    // Passive reaction context arrived with version 9; earlier states migrate without any.
    if (value.reactionContext !== undefined && !Array.isArray(value.reactionContext)) {
      throw new Error("Stored Telegram state contains invalid reaction context");
    }
    for (const item of value.pending as unknown as Record<string, unknown>[]) {
      if (item.attachments !== undefined && (!Array.isArray(item.attachments) ||
        item.attachments.some((entry: unknown) => entry === null || typeof entry !== "object" ||
          Array.isArray(entry) || typeof (entry as Record<string, unknown>).fileId !== "string" ||
          typeof (entry as Record<string, unknown>).identity !== "string"))) {
        throw new Error("Stored Telegram state contains invalid attachments");
      }
      // Coalescing bookkeeping is optional; a malformed value must not silently widen an input.
      for (const key of ["admittedAtMs", "inputMessageId", "coalescedParts"] as const) {
        const stored = item[key];
        if (stored !== undefined && (!Number.isSafeInteger(stored) || (stored as number) < 1)) {
          throw new Error("Stored Telegram state contains invalid pending coalescing metadata");
        }
      }
      if (item.lateFor !== undefined && (!Number.isSafeInteger(item.lateFor) || (item.lateFor as number) < 0)) {
        throw new Error("Stored Telegram state contains an invalid late control notice");
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
      ...(storedRestart === undefined ? {} : { restart: storedRestart as unknown as TelegramRestartRecord[] }),
      origins: hasControls && value.origins !== null && typeof value.origins === "object" && !Array.isArray(value.origins)
        ? value.origins as unknown as Record<string, TelegramOriginBinding> : {},
      targets: Array.isArray(value.targets) ? value.targets as unknown as TelegramObservedTarget[] : [],
      actions: Array.isArray(value.actions) ? value.actions as unknown as TelegramActionRecord[] : [],
      reactionContext: Array.isArray(value.reactionContext)
        ? value.reactionContext as unknown as TelegramReactionNote[] : [],
    };
  },
  initial: () => ({
    offset: 0, pending: [], controls: [], origins: {}, targets: [], actions: [], reactionContext: [],
  }),
});

/**
 * The host surface this adapter uses: the shared {@link ChannelGateway} plus the late-bound
 * model-action registry. The runtime creates that registry when `config.telegram` exists and offers
 * the `telegram` tool only in mapped Telegram chat conversations; the running adapter attaches here.
 */
export interface TelegramGateway extends ChannelGateway {
  telegramActions?: TelegramActionRegistry;
}

/** One admitted owner control of this adapter: keyed by update id, gated per chat. */
type TelegramControlRequest = ControlRecord<number, number> & {
  readonly senderId: string;
  readonly sessionKey: string;
};

export async function runTelegram(
  gateway: TelegramGateway,
  options: TelegramOptions,
  context: Context,
): Promise<void> {
  validateOptions(options);
  // Attachment-disabled SDK callers keep the previous behavior: no store, no download, no transcription.
  const mediaIngress = createMediaIngress(options.media);
  const mediaWork = new WorkGate(MEDIA_LIMITS.maxConcurrentWork);
  /**
   * Optional host operations this adapter may call, resolved once from the host surface. A narrow SDK
   * host keeps `/new`, `/abort` (and `/stop`), `/help` only; `/status`, `/model`, `/digest` and
   * `/restart` are then neither advertised nor applied, and typing one gets a truthful refusal
   * instead of a half-working control.
   */
  const hostCommands = detectHostCapabilities(gateway, options.restart);
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const cleanupContext = withoutAbortSignal(adapterContext);
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;
  /** One announcement and one recovery notice per read-outage episode, never one per retry. */
  let readOutage: { readonly method: string } | undefined;
  const readOutageHooks: ReadOutageHooks = {
    entered(method) {
      if (readOutage !== undefined) return;
      readOutage = { method };
      console.warn(`Telegram ${method} is retrying through a service outage.`);
    },
    recovered() {
      if (readOutage === undefined) return;
      const method = readOutage.method;
      readOutage = undefined;
      console.info(`Telegram ${method} read recovered after the service outage.`);
    },
  };
  // Outbound uploads resolve against the configured workspace only; the media opt-in is the
  // operator switch. Absent means every file send is refused before any external call.
  const outboundWorkspace = options.media?.workspace;
  const transport = createTelegramTransport(options.token, signal);
  const { api } = transport;

  let me: Awaited<ReturnType<typeof api.getMe>> | undefined;
  try {
    me = await transport.call("getMe", (callSignal) => api.getMe(callSignal), {
      throttle: transport.poll,
      retryOutage: readOutageHooks,
    });
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }
  if (!me) throw new Error("Telegram getMe returned no result");
  const identity = String(me.id);
  const stateConversation = await gateway.conversationFor(
    `telegram:${identity}${CHANNEL_STATE_SESSION_SUFFIX}`,
    context,
  );
  /**
   * The busy-mode each admitted message *asked* for, written onto it so a later configuration change or a
   * recovery never re-reads it. Delivery may still fall back to follow-up when another path owns the run.
   */
  const admittedWhenBusy = options.followUpMode === "steer" ? "steer" as const : undefined;
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(TelegramState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  /** Input replies and acknowledgements have separate concurrency bounds, so a full reply queue cannot hide an ack. */
  let activeReplies = 0;
  let activeNotices = 0;
  const delivering = new Set<number>();
  const failedThisPoll = new Set<number>();
  /**
   * Submissions a control flush already placed for earlier inputs, so the normal delivery
   * path reuses that exact turn instead of submitting the same input a second time.
   */
  const earlySubmissions = new Map<number, Submission>();
  /**
   * Each chat's submission order: a delivery reserves its place when it is dispatched, before any
   * asynchronous preparation, so admission order never depends on how long a lookup takes.
   */
  const order = new SubmissionOrderQueue<number>();
  /** Consecutive delivery failures per pending record, so a permanent failure is held instead of retried forever. */
  const deliveryFailures = new Map<number, number>();
  let fatal: unknown;
  let stopping = false;
  /** Consecutive failed admissions of the control update being polled again. */
  let controlRetry: { readonly updateId: number; readonly attempts: number } | undefined;

  const isActive = (): boolean => !stopping && !signal?.aborted;

  /**
   * Per-chat coalescing gate for the delivery that currently holds this chat's submission place.
   * Each newly admitted ordinary message resets a short idle timer (up to a fixed extension cap);
   * then the waiting delivery merges the records that arrived. Nothing here is durable: every
   * admitted message already has its pending record and polling offset committed, so a restart either
   * merges the surviving records again or delivers them separately — never both and never neither.
   */
  const coalesceWaiters = new Map<number, () => void>();
  const coalesceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const coalesceExtensions = new Map<number, number>();

  const finishCoalesceWindow = (chatId: number): void => {
    const timer = coalesceTimers.get(chatId);
    if (timer !== undefined) clearTimeout(timer);
    coalesceTimers.delete(chatId);
    coalesceExtensions.delete(chatId);
    const waiter = coalesceWaiters.get(chatId);
    coalesceWaiters.delete(chatId);
    waiter?.();
  };

  /** Open this chat's idle window; `undefined` when the chat already has one or is stopping. */
  const openCoalesceWindow = (chatId: number): Promise<void> | undefined => {
    if (stopping || signal?.aborted || coalesceWaiters.has(chatId)) return undefined;
    return new Promise<void>((resolve) => {
      coalesceWaiters.set(chatId, resolve);
      coalesceTimers.set(chatId,
        setTimeout(() => finishCoalesceWindow(chatId), TELEGRAM_COALESCE_LIMITS.idleMs));
    });
  };

  /** Let one newly admitted ordinary message extend a waiting delivery's idle window, within the cap. */
  const extendCoalesceWindow = (chatId: number): void => {
    const timer = coalesceTimers.get(chatId);
    if (timer === undefined || !coalesceWaiters.has(chatId)) return;
    const extensions = coalesceExtensions.get(chatId) ?? 0;
    if (extensions >= TELEGRAM_COALESCE_LIMITS.maxExtensions) return;
    clearTimeout(timer);
    coalesceExtensions.set(chatId, extensions + 1);
    coalesceTimers.set(chatId, setTimeout(() => finishCoalesceWindow(chatId), TELEGRAM_COALESCE_LIMITS.idleMs));
  };

  const outbox = gateway.cronOutbox;
  let scheduledTimer: ReturnType<typeof setInterval> | undefined;

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
    sendOptions: TelegramSendTextOptions,
  ): Promise<number | undefined> => {
    const body = sendOptions.richBody ?? (sendOptions.mode === "literal" ? escapeTelegramLiteral(text) : text);
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
        const sent = await transport.call<Message.RichMessageMessage>("sendRichMessage", async (callSignal) => {
          await sendOptions.hooks.before(text);
          if (signal?.aborted) {
            await sendOptions.hooks.abandoned();
            throw new TelegramApiError("sendRichMessage", 0, "not-sent");
          }
          try {
            return await transport.inChatOrder(chatId, () => api.sendRichMessage(
              chatId, { markdown: body }, reply, callSignal,
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
        const sent = await transport.call<Message.TextMessage>("sendMessage", async (callSignal) => {
          await sendOptions.hooks.before(part);
          if (signal?.aborted) {
            if (index === 0) await sendOptions.hooks.abandoned();
            throw new TelegramApiError("sendMessage", 0, "not-sent");
          }
          try {
            return await transport.inChatOrder(chatId, () => api.sendMessage(
              chatId, part, index === 0 ? reply : {}, callSignal,
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
        const edited = await transport.call("editMessageText", (callSignal) => transport.inChatOrder(chatId, () =>
          api.editMessageText(chatId, messageId, { markdown: body }, {}, callSignal)),
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
    const edited = await transport.call("editMessageText", (callSignal) => transport.inChatOrder(chatId, () =>
      api.editMessageText(chatId, messageId, text, {}, callSignal)),
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
    try {
      const sent = await transport.call("sendChatAction",
        (callSignal) => api.sendChatAction(chatId, "typing", {}, callSignal),
        { throttle: transport.outbound, replaceable: true });
      if (!loop.stopped && !signal?.aborted) {
        if (sent === undefined && !loop.unavailable) {
          journalEvent("telegram.typing.skipped", { "chat.id": chatId, "cooldown.ms": transport.outbound.remainingMs() });
        } else if (sent !== undefined && loop.unavailable) {
          journalEvent("telegram.typing.recovered", { "chat.id": chatId });
        }
        loop.unavailable = sent === undefined;
      }
    } catch (error) {
      if (!loop.stopped && !signal?.aborted) {
        if (!loop.unavailable) journalEvent("telegram.typing.failed", { "chat.id": chatId }, error);
        loop.unavailable = true;
      }
    }
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
      const created: TypingLoop = { turns: 0, unavailable: false, stopped: false, timer: undefined };
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

  const telegramActions = createTelegramActions({
    transport,
    outboundWorkspace,
    state: () => state,
    mutate: async (change) => { await mutateState(change); },
    authorizedChat: authorizedActionChat,
    active: isActive,
    sendText: (chatId, text, sendOptions) => sendOutboundText(chatId, text, sendOptions),
    splitText: (text) => splitOutboundText(text),
    rememberOutgoing: rememberOutgoingTarget,
  });

  /** The exact private chat and durable sender binding for one Telegram session key. */
  function ownerChatFor(sessionKey: string): { readonly chatId: number; readonly senderId: string } | undefined {
    const prefix = `telegram:${identity}:chat:`;
    if (!sessionKey.startsWith(prefix)) return undefined;
    const raw = sessionKey.slice(prefix.length);
    if (!/^\d+$/.test(raw)) return undefined;
    const chatId = Number(raw);
    if (!Number.isSafeInteger(chatId)) return undefined;
    const binding = originBindingOf(state.origins, chatId, identity);
    if (binding === undefined || !options.allowFrom.includes(binding.senderId)) return undefined;
    return { chatId, senderId: binding.senderId };
  }

  /** One direct plain owner message; never a durable outbox record or transcript entry. */
  async function sendOwnerPlainText(chatId: number, senderId: string, text: string): Promise<void> {
    if (!options.allowFrom.includes(senderId)) throw new Error("the owner sender is no longer authorized");
    if (text.length > PLAIN_TEXT_LIMIT) throw new Error("owner message is too long for one message");
    await transport.call("sendMessage", (callSignal) => transport.inChatOrder(chatId, () =>
      api.sendMessage(chatId, text, {}, callSignal)), { throttle: transport.outbound });
  }

  let detachTelegramActions: (() => void) | undefined;
  let detachMcpSurface: (() => void) | undefined;
  let detachAskSurface: (() => void) | undefined;

  // A completed background result is sent as stored text: no submission, no preview, no model turn.
  // The shared drainer owns quarantine, validation, the origin hold and revocation; this adapter
  // owns the chunked write-ahead send of each record.
  const drainer = createOutboxDrainer<number>({
    outbox,
    context: adapterContext,
    cleanupContext,
    decodeSession: (sessionKey) => chatIdForSession(sessionKey, identity),
    scopeOf: (chatId) => chatId,
    // The session key is only a candidate locator. Authorization comes from durable admission
    // evidence for this bot and private chat, rechecked against the live allowlist for every send.
    authorizeOrigin: (chatId): OriginAuthorization => {
      const binding = originBindingOf(state.origins, chatId, identity);
      if (binding === undefined) return { status: "withheld", reason: "origin chat has no durable admission evidence" };
      if (!options.allowFrom.includes(binding.senderId)) return { status: "unauthorized" };
      return { status: "deliver" };
    },
    deliverRecord: (sessionKey, chatId, record) => deliverScheduled(sessionKey, chatId, record),
    validateRecord: scheduledRecordProblem,
    observe: (_sessionKey, chatId, record, run) => observeOperation("gateway.telegram.scheduled_delivery", {
      "chat.id": chatId, "delivery.id": record.id,
    }, () => run()),
    maxActive: MAX_SCHEDULED_ACTIVE,
    active: isActive,
    label: "Telegram",
  });

  const clearScheduledIntent = (sessionKey: string, id: string) =>
    drainer.update(sessionKey, id, (entry) => {
      if (entry.status === "sending" || entry.sendIntent !== undefined) {
        entry.status = "pending";
        delete entry.sendIntent;
      }
    });

  const sendScheduledChunk = async (
    sessionKey: string,
    recordId: string,
    chatId: number,
    chunk: string,
    index: number,
  ): Promise<"sent" | "retry" | "stop"> => {
    try {
      const sent = await sendOutboundText(chatId, chunk, {
        throttle: transport.outbound,
        hooks: {
          before: async (text) => { await drainer.update(sessionKey, recordId, (entry) => {
            entry.status = "sending";
            entry.sendIntent = { text, chunkIndex: index, startedAt: Date.now() };
          }, adapterContext); },
          abandoned: async () => { await clearScheduledIntent(sessionKey, recordId); },
          accepted: async (messageId) => {
            await drainer.update(sessionKey, recordId, (entry) => {
              entry.status = "pending";
              delete entry.sendIntent;
              delete entry.unknownSince;
              entry.nextChunkIndex = Math.max(entry.nextChunkIndex, index + 1);
              if (index === 0) entry.messageId = messageId;
            });
          },
        },
      });
      return sent === undefined ? "retry" : "sent";
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.outcome === "unknown") {
          await drainer.markUnknown(sessionKey, recordId);
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
        await drainer.markFailed(sessionKey, recordId, error.message);
        return "stop";
      }
      if (signal?.aborted) {
        // An in-flight request was abandoned; the write-ahead intent stays ambiguous.
        await drainer.markUnknown(sessionKey, recordId);
        return "stop";
      }
      await drainer.markFailed(sessionKey, recordId, "Telegram delivery failed");
      return "stop";
    }
  };

  /** Send one validated, authorized record chunk by chunk; every chunk has its own write-ahead intent. */
  const deliverScheduled = async (
    sessionKey: string,
    chatId: number,
    record: CronDeliveryRecord,
  ): Promise<"delivered" | "kept"> => {
    const plan = record.telegramChunkPlan ?? (record.nextChunkIndex > 0 ? "legacy" : "rich-v1");
    if (record.telegramChunkPlan === undefined) {
      await drainer.update(sessionKey, record.id, (entry) => { entry.telegramChunkPlan = plan; }, adapterContext);
    }
    const chunks = splitOutboundText(record.text, plan);
    for (let index = record.nextChunkIndex; index < chunks.length; index++) {
      const result = await sendScheduledChunk(sessionKey, record.id, chatId, chunks[index]!, index);
      if (result !== "sent") return "kept";
      const next = (await outbox!.list(sessionKey, adapterContext)).find((entry) => entry.id === record.id);
      if (next === undefined) return "kept";
    }
    return "delivered";
  };

  // ── Owner controls ────────────────────────────────────────────────────────
  // The shared coordinator owns ordering, the per-chat gate, deferred retries and outcome
  // wording; this adapter's ledger commits each step against its own channel state.

  const sessionKeyFor = (chatId: number): string => `telegram:${identity}:chat:${chatId}`;

  const controlNotice = (record: TelegramControlRequest, text: string): PendingReply => ({
    updateId: record.key,
    nextChunkIndex: 0,
    chatId: record.scope,
    sessionKey: record.sessionKey,
    senderId: record.senderId,
    text,
    notice: true,
  });

  /**
   * Inside one state commit: rewrite (when `text` is given) and release this control's acknowledgement
   * while it is still held. A held notice is never dispatched, so rewriting it cannot race a send. Once
   * released it may be sending, sent or quarantined as unknown, so it is never touched again: a `late`
   * outcome then goes on its own record instead of being dropped or overwriting that provenance.
   */
  const settleControlNotice = (
    doc: Draft<ChannelState>,
    key: number,
    text: string | undefined,
    late?: TelegramControlRequest,
  ): void => {
    const notice = doc.pending.find((item) => item.notice === true && item.updateId === key);
    if (notice?.hold === true) {
      if (text !== undefined) notice.text = text;
      delete notice.hold;
      return;
    }
    if (late === undefined || text === undefined || doc.pending.length >= MAX_ADMITTED) return;
    const used = new Set(doc.pending.map((item) => item.updateId));
    let updateId = RESTART_LIVE_UPDATE_ID;
    while (used.has(updateId)) updateId -= 1;
    doc.pending.push({ ...controlNotice(late, text), updateId, lateFor: late.key });
  };

  const controlLedger: ControlLedger<number, number, TelegramControlRequest> = {
    status: (key) => state.controls.find((entry) => entry.updateId === key)?.status,
    unresolved: () => state.controls.filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length,
    async admit(record, ackText) {
      await mutateState((doc) => {
        if (!doc.controls.some((entry) => entry.updateId === record.key)) {
          doc.controls = pruneTelegramControls([
            ...doc.controls,
            { updateId: record.key, command: record.command, status: "admitted", chatId: record.scope, senderId: record.senderId },
          ], doc.pending);
        }
        if (!doc.pending.some((entry) => entry.updateId === record.key)) {
          if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
          doc.pending.push({ ...controlNotice(record, ackText), hold: true });
        }
        doc.offset = Math.max(doc.offset, record.key + 1);
      }, adapterContext);
    },
    async markApplied(record) {
      await mutateState((doc) => {
        const entry = doc.controls.find((item) => item.updateId === record.key);
        if (entry !== undefined) entry.status = "applied";
        // The host replaces the process only after this commit, so the record of who is owed a live
        // confirmation is durable first. Every requesting chat is recorded, not just one: chats admitted
        // in the same poll batch each keep the answer their acknowledgement promised.
        if (record.command === "restart" && entry !== undefined) {
          const owed = doc.restart ?? [];
          if (!owed.some((item) => item.chatId === record.scope)) {
            doc.restart = [...owed, { chatId: record.scope, senderId: entry.senderId }].slice(-MAX_RESTART_CONFIRMATIONS);
          }
        }
        // Bound the log here too: only applied, refused and already-reported records are pruned.
        doc.controls = pruneTelegramControls(doc.controls, doc.pending);
      }, adapterContext);
    },
    async release(key, text) {
      await mutateState((doc) => settleControlNotice(doc, key, text));
    },
    async markRefused(record, text, late) {
      const bounded = text.slice(0, MAX_NOTICE_CHARS);
      await mutateState((doc) => {
        const entry = doc.controls.find((item) => item.updateId === record.key);
        if (entry !== undefined) entry.status = "refused";
        settleControlNotice(doc, record.key, bounded, late === true ? record : undefined);
        doc.controls = pruneTelegramControls(doc.controls, doc.pending);
      });
    },
    async markUnconfirmed(key, text, lateRecord) {
      await mutateState((doc) => {
        const entry = doc.controls.find((item) => item.updateId === key);
        if (entry !== undefined) entry.status = "unconfirmed";
        settleControlNotice(doc, key, text, lateRecord);
      });
    },
    async publishLate(record, text) {
      const body = text.slice(0, MAX_LATE_CONTROL_CHARS);
      await mutateState((doc) => settleControlNotice(doc, record.key, body, record));
    },
    async refuse(record, text) {
      await admitNotice(record.key, record.scope, record.senderId, record.sessionKey, text);
    },
  };

  /**
   * Ask the host to replace this process at most once per adapter lifetime. A refusal is a known
   * no-effect, so it is reported to the chats that asked and never retried or upgraded into a success.
   */
  const restartRequester = createRestartRequester(options.restart, {
    label: "Telegram",
    onRefused(text) {
      // The acknowledgement promised a follow-up, so the refusal is reported now instead of leaving
      // that promise open until some later process starts.
      void stateConversation.commit(async (tx) => {
        const doc = await tx.doc(TelegramState, stateConversation.id);
        admitRestartNotices(doc, text);
        delete doc.restart;
        return copyJson(doc) as unknown as ChannelState;
      }, adapterContext).then((next) => {
        state = next;
        if (isActive()) drain();
      }).catch(() => undefined);
    },
  });

  const controls = createControlCoordinator<number, number, TelegramControlRequest, PendingReply>({
    ledger: controlLedger,
    order,
    flush: {
      // Every input admitted before this command in its chat, from current committed state.
      inputs: (record) => state.pending.filter((item) =>
        item.notice !== true && item.chatId === record.scope && item.updateId < record.key &&
        options.allowFrom.includes(item.senderId)),
      // Attachment content is prepared in the same chat order as a normal delivery, so a media
      // message forced ahead of a control is never submitted as text only. An input delivered,
      // merged or already placed meanwhile is skipped.
      async prepareInput(input) {
        const current = state.pending.find((entry) => entry.updateId === input.updateId);
        if (current === undefined || earlySubmissions.has(input.updateId)) return undefined;
        return prepareInputContent(current);
      },
      async submit(input, content) {
        const conversation = await gateway.conversationFor(input.sessionKey, adapterContext);
        await gateway.beforeOwnerInput?.(input.sessionKey, conversation.id, content, adapterContext);
        const submission = await conversation.submit({
          type: "input",
          content: content as string | (TextContent | ImageContent)[],
          requestId: requestIdFor(identity, input.updateId),
          // The mode its own admission recorded, exactly as the normal delivery path submits it.
          whenBusy: await submissionMode(conversation, input),
        }, adapterContext);
        // The normal delivery path reuses this turn, so a control-forced input is answered exactly
        // once even when it settles before the chat's gate is released.
        earlySubmissions.set(input.updateId, submission);
      },
    },
    execute: (record) => executeChannelControl(gateway, {
      command: record.command,
      sessionKey: record.sessionKey,
      ...(record.option === undefined ? {} : { option: record.option }),
    }, adapterContext, { scope: "chat" }),
    requestRestart: () => restartRequester.request(),
    onFatal(error) {
      // The record stays admitted and the acknowledgement held: a reopen reports it as unconfirmed.
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("Telegram control command failed"));
    },
    drain: () => drain(),
    active: isActive,
  });

  /**
   * An ordinary owner input a short idle window may hold open for the next one. Notices, steers,
   * legacy records, and records already claimed by a send are excluded; a steer keeps its own native
   * placement, so coalescing never changes busy-mode behavior.
   */
  const coalescableRecord = (record: PendingReply): boolean =>
    record.notice !== true && record.hold !== true && record.whenBusy === undefined &&
    record.deliveryStatus === undefined && record.sendIntent === undefined &&
    record.admittedAtMs !== undefined && record.inputMessageId !== undefined &&
    record.coalescedParts === undefined && record.nextChunkIndex === 0 && record.messageId === undefined;

  /** Whether `candidate` is a later ordinary message from this same sender and chat that may join. */
  const coalescableWith = (owner: PendingReply, candidate: PendingReply): boolean =>
    candidate.updateId !== owner.updateId && candidate.updateId > owner.updateId &&
    candidate.chatId === owner.chatId && candidate.sessionKey === owner.sessionKey &&
    candidate.senderId === owner.senderId && coalescableRecord(candidate);

  /**
   * Give consecutive ordinary owner messages (and the separate updates of one media album) a bounded
   * chance to join this turn. The wait is a short in-memory idle window; the merge itself is one
   * commit that appends each later record's already-admitted text and attachments to this record in
   * arrival order and removes those records. That keeps the earlier record's stable request id and
   * its one reply, and a restart after the merge delivers the merged input once.
   *
   * Returns `absent` when this record is gone (already merged into an earlier delivery): the caller
   * then stops without submitting anything, so the same input cannot run twice.
   */
  const coalesceAdmittedDelivery = async (item: PendingReply): Promise<"ready" | "absent"> => {
    if (!coalescableRecord(item) || earlySubmissions.has(item.updateId)) return "ready";
    // Already merged into an earlier delivery: submit nothing, so the same input cannot run twice.
    if (!state.pending.some((entry) => entry.updateId === item.updateId)) return "absent";
    const wait = openCoalesceWindow(item.chatId);
    if (wait !== undefined) await wait;
    if (signal?.aborted) return "ready";
    let absent = false;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const owner = doc.pending.find((entry) => entry.updateId === item.updateId);
      if (owner === undefined) {
        absent = true;
        return copyJson(doc) as unknown as ChannelState;
      }
      if (!coalescableRecord(owner)) return copyJson(doc) as unknown as ChannelState;
      const parts: TelegramInputPart[] = [owner.inputMessageId === undefined
        ? { text: owner.text }
        : { messageId: owner.inputMessageId, text: owner.text }];
      const attachments = [...(owner.attachments ?? [])];
      const absorbed = new Set<number>();
      let chars = owner.text.length;
      for (const candidate of doc.pending) {
        if (candidate.chatId !== owner.chatId || candidate.updateId <= owner.updateId) continue;
        // Only consecutive same-chat inputs may join: another sender, a notice or control is a
        // barrier, never something to skip in search of a later matching message.
        if (!coalescableWith(owner, candidate) || doc.controls.some((control) =>
          control.chatId === owner.chatId && control.updateId > owner.updateId
          && control.updateId < candidate.updateId)) break;
        const nextChars = chars + candidate.text.length;
        if (parts.length >= TELEGRAM_COALESCE_LIMITS.maxParts ||
            nextChars > TELEGRAM_COALESCE_LIMITS.maxChars) break;
        parts.push(candidate.inputMessageId === undefined
          ? { text: candidate.text }
          : { messageId: candidate.inputMessageId, text: candidate.text });
        attachments.push(...(candidate.attachments ?? []));
        absorbed.add(candidate.updateId);
        chars = nextChars;
      }
      if (absorbed.size === 0) return copyJson(doc) as unknown as ChannelState;
      owner.text = coalescedInputText(parts);
      owner.coalescedParts = parts.length;
      if (attachments.length > 0) owner.attachments = attachments;
      doc.pending = doc.pending.filter((entry) => !absorbed.has(entry.updateId));
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    if (absent) return "absent";
    const merged = state.pending.find((entry) => entry.updateId === item.updateId);
    if (merged === undefined) return "absent";
    item.text = merged.text;
    if (merged.coalescedParts === undefined) delete item.coalescedParts;
    else item.coalescedParts = merged.coalescedParts;
    if (merged.attachments !== undefined) item.attachments = merged.attachments;
    return "ready";
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
      if (!notice && controls.gated(item.chatId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.updateId) || failedThisPoll.has(item.updateId)) continue;
      delivering.add(item.updateId);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = order.beginSubmission(item.chatId);
      const task = observeOperation("gateway.telegram.delivery", {
        "update.id": item.updateId, "chat.id": item.chatId, notice,
        "queue.depth": state.pending.length, attempt: (deliveryFailures.get(item.updateId) ?? 0) + 1,
      }, (trace) => deliver(item, slot, trace)).catch(async (error: unknown) => {
        // The span logs safe failure causes; keep durable state for the next polling cycle.
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

  const deliver = async (item: PendingReply, slot: SubmissionSlot, trace: TelemetrySpan) => {
    if (!options.allowFrom.includes(item.senderId)) {
      if (item.messageId !== undefined) {
        await transport.call("deleteMessage", (callSignal) => transport.inChatOrder(item.chatId, () => api.deleteMessage(item.chatId, item.messageId!, callSignal)), { throttle: transport.outbound }).catch(() => undefined);
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
    await observeOperation("gateway.telegram.queue", {}, () => slot.prior, trace);
    // A short, bounded idle window lets consecutive ordinary owner messages join this turn. The wait
    // holds this chat's submission place, so a later message's own delivery cannot submit first.
    const coalesced = await observeOperation("gateway.telegram.coalesce", {},
      () => coalesceAdmittedDelivery(item), trace);
    if (coalesced === "absent") return;
    // Attachment storage and local transcription happen inside this chat's admission order, before the model sees
    // anything. A failure keeps the durable record and the ordinary retry path; other chats keep polling.
    const content = await observeOperation("gateway.telegram.prepare", {},
      (span) => prepareInputContent(item, span), trace);
    const conversation = await observeOperation("gateway.telegram.conversation", {},
      () => gateway.conversationFor(item.sessionKey, adapterContext), trace);
    trace.setAttributes({ "conversation.id": conversation.id });
    const requestId = requestIdFor(identity, item.updateId);
    let submissionId: SubmissionId | undefined;
    let stopTyping: (() => void) | undefined;
    // Typing follows the committed live state, not submission: it starts when this input's run has
    // an active generation attempt, and stops at every other boundary (queued, tool round, waiting
    // for another task, parked, answered). A run waiting on background work therefore never keeps it
    // alive, and a tool round never pretends the model is typing.
    const syncTyping = (live: LiveView) => {
      if (telegramTypingActive(live, submissionId)) {
        if (stopTyping !== undefined) return;
        // One shared loop per chat: only a new loop is a request worth recording.
        if (!typingLoops.has(item.chatId)) {
          journalEvent("telegram.typing.requested", { "update.id": item.updateId, "chat.id": item.chatId });
        }
        stopTyping = startTyping(item.chatId);
        return;
      }
      stopTyping?.();
      stopTyping = undefined;
    };
    // One preview per run: only the run's first input publishes, so a steered sibling keeps the
    // chat's typing indicator but never publishes a second preview message.
    const watcher = await createPreviewWatcher({
      conversation,
      context: adapterContext,
      delayMs: PREVIEW_DELAY_MS,
      publish: publishPreview,
      onFrame: (_view, frame) => syncTyping(frame.live),
      publishFailure: "rethrow",
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      const early = earlySubmissions.get(item.updateId);
      earlySubmissions.delete(item.updateId);
      if (early === undefined) await gateway.beforeOwnerInput?.(item.sessionKey, conversation.id, content, adapterContext);
      // The admission itself decided the busy-mode, so a later configuration change cannot redefine this message.
      const submission = early ?? await conversation.submit({
        type: "input",
        content,
        requestId,
        whenBusy: await submissionMode(conversation, item),
      }, withTelemetry(trace, adapterContext));
      // Ordering is established; free the chat's next submission place while this turn runs.
      slot.release();
      submissionId = submission.id;
      watcher.setSubmission(submission.id);
      // The acquisition/current watch value may already hold this run's generation; the next frame
      // covers the case where it starts later.
      syncTyping(watcher.value.docs["pi.live"] as LiveView);
      trace.setAttributes({ "submission.id": submission.id });
      const settled = await observeOperation("gateway.telegram.settlement", { "submission.id": submission.id },
        () => submission.wait(adapterContext), trace);
      trace.setAttributes({ status: settled.status });
      if (settled.status !== "done" || settled.type !== "input") {
        // A native abort or a queued reset deliberately ends the turn: it is not a delivery failure to report.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        trace.setAttributes({ intentional });
        if (!intentional) trace.setStatus({ status: "error" });
        await watcher.stop();
        // A failed run has no committed answer and Durable exposes no run identity at settlement, so each
        // admitted message reports its own fixed notice. Grouping by the identical reason text would let a
        // held notice silently own an unrelated later failure.
        if (!intentional) await flushFinal("Your request could not be completed. Please try again.");
        await forget(item.updateId);
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const answerText = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      // Inputs the run consumed settle with this same committed answer, so one of them owns its single reply.
      const group = await sharedDeliveryGroup(conversation.id, item, settled.answer);
      const role = sharedDeliveryRole(group, item.updateId, group.present);
      trace.setAttributes({ outcome: role });
      await watcher.stop();
      if (role === "owner") {
        await observeOperation("gateway.telegram.reply", {}, () => flushFinal(answerText), trace);
        await retireSharedDelivery(conversation, item, settled.answer);
      } else if (role === "sibling") {
        await forget(item.updateId);
      }
    } finally {
      stopTyping?.();
      await watcher.stop();
    }

    async function deliverNotice(current: PendingReply) {
      // One bounded host-generated notice: `literal` keeps paths, ids and placeholders exactly as written.
      if (current.nextChunkIndex > 0) {
        await forget(current.updateId);
        return;
      }
      const sent = await sendTelegramMessage(current.text, "final", 0, false, "literal",
        current.noticeFormat === "status" || current.noticeFormat === "model"
          ? formatReadOnlyNotice(current.text, current.noticeFormat) : undefined);
      if (sent === undefined) throw new Error("Telegram send returned no result");
      await forget(current.updateId);
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
      if (text.trim() === "" && current.messageId !== undefined) {
        // An empty final must remove a streamed preview. Keep its durable id until deletion is
        // confirmed: on an ambiguous result recovery retries deletion, where not-found is success.
        try {
          await transport.call("deleteMessage", (callSignal) => transport.inChatOrder(item.chatId, () =>
            api.deleteMessage(item.chatId, current.messageId!, callSignal)), { throttle: transport.outbound });
        } catch (error) {
          if (error instanceof TelegramApiError && error.method === "deleteMessage" && error.status === 400 &&
              error.description === "Bad Request: message to delete not found") {
            // Deletion is already achieved.
          } else {
            if (error instanceof TelegramApiError && error.outcome === "unknown") {
              await markUnknown(item.updateId, "final");
              console.warn(`Telegram preview deletion outcome unknown for update ${item.updateId}; inspect the Durable channel-state record.`);
            }
            throw error;
          }
        }
        await clearPreview(item.updateId);
        current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
      }
      if (text.trim() === "") return;
      const chunks = splitOutboundText(plan === "legacy" ? text.trim() : text, plan);
      for (let index = current.nextChunkIndex; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        if (index === 0 && current.messageId !== undefined) {
          if (current.lastText !== chunk) {
            try {
              await editOutboundText(item.chatId, current.messageId!, chunk, { throttle: transport.outbound });
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
      richBody?: string,
    ): Promise<number | undefined> {
      try {
        return await sendOutboundText(item.chatId, text, {
          mode,
          ...(richBody === undefined ? {} : { richBody }),
          replaceable,
          throttle: transport.outbound,
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
            throttle: transport.outbound,
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
      const lateFor = doc.pending.find((entry) => entry.updateId === updateId)?.lateFor;
      doc.pending = doc.pending.filter((entry) => entry.updateId !== updateId);
      // Its terminal report (interrupted or refused) is now durably delivered, so the record has served
      // its purpose, unless another queued notice (its own acknowledgement or a late one) still reports it.
      const reported = reportedControls(doc.pending);
      doc.controls = doc.controls.filter((entry) =>
        !((entry.updateId === updateId || entry.updateId === lateFor) && !reported.has(entry.updateId) &&
          (entry.status === "unconfirmed" || entry.status === "refused")));
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  };

  /**
   * The native busy-mode to submit one admitted message with. Its own durable admission decided whether the
   * owner asked to steer; a run that another path owns always takes the conservative follow-up queueing, so no
   * owner answer is dropped and no scheduled answer is delivered twice. This chat's own admitted request IDs
   * are read lazily inside the read, immediately before admission.
   */
  const submissionMode = (conversation: Conversation, current: PendingReply): Promise<"steer" | "followUp"> => {
    function* ownerRequestIds(): Iterable<string> {
      for (const candidate of state.pending) {
        if (candidate.sessionKey === current.sessionKey) yield requestIdFor(identity, candidate.updateId);
      }
    }
    return resolveOwnerBusyMode(conversation, current.whenBusy, ownerRequestIds(), adapterContext);
  };

  /**
   * The admitted messages of this chat whose native submission settled with `answer`, with the earliest
   * native submission as the one that delivers their single shared reply. Durable settlement evidence plus
   * committed pending membership decide it, so every observer computes the same owner without a lock and a
   * reopened process reaches the same answer. A failed run has no committed answer and is never grouped.
   */
  const sharedDeliveryGroup = (conversationId: Conversation["id"], current: PendingReply, answer: number) =>
    // A read-only commit: committed pending membership and submissions are the whole identity.
    stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const candidates = doc.pending
        .filter((candidate) => candidate.sessionKey === current.sessionKey)
        .map((candidate) => ({ key: candidate.updateId, requestId: requestIdFor(identity, candidate.updateId) }));
      const group = await resolveSharedDeliveryGroup(tx, conversationId, candidates, answer);
      return { ...group, present: doc.pending.some((candidate) => candidate.updateId === current.updateId) };
    }, adapterContext);

  /**
   * One commit that retires this delivery owner and every still-pending sibling of the same answer, so a
   * delivered shared answer can never be sent again by a record left behind by a crash or a slow observer.
   * An unknown or held sibling keeps its own evidence: only pending membership is retired here.
   */
  const retireSharedDelivery = async (conversation: Conversation, current: PendingReply, answer: number) => {
    const group = await sharedDeliveryGroup(conversation.id, current, answer);
    const retired = new Set(group.keys);
    retired.add(current.updateId);
    for (const updateId of retired) {
      deliveryFailures.delete(updateId);
      earlySubmissions.delete(updateId);
    }
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.pending = doc.pending.filter((entry) => !retired.has(entry.updateId));
      doc.controls = doc.controls.filter((entry) => !(retired.has(entry.updateId) &&
        (entry.status === "unconfirmed" || entry.status === "refused")));
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
    telemetry: TelemetryContext,
  ): Promise<StoredMedia> => {
    if (current.declaredBytes !== undefined && current.declaredBytes > ingress.store.maxFileBytes) {
      throw new MediaRejected("too-large");
    }
    // The same underlying file (Telegram's content-stable unique id) may arrive in a later
    // update: an already stored original is reused instead of downloading it again.
    const already = await ingress.store.existingFor(
      current.identity, current.kind, current.mimeType, current.originalName,
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
      file = await observeOperation("gateway.telegram.file.lookup", {}, () => transport.call("getFile",
        (callSignal) => api.getFile(current.fileId, callSignal), { throttle: transport.poll }), telemetry);
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
      response = await observeOperation("gateway.telegram.file.headers", {},
        () => globalThis.fetch(url, { method: "GET", redirect: "error", signal: combined }), telemetry);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // Preserve the cause for the value-free diagnostic formatter only; never print this URL/error raw.
      throw new Error("Telegram file download failed", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400 && response.status < 500) throw new MediaRejected("unavailable");
      throw Object.assign(new Error("Telegram file download failed"), { status: response.status });
    }
    return observeOperation("gateway.telegram.file.store", {}, () => ingress.store.save({
      kind: current.kind,
      identity: current.identity,
      ...(current.mimeType === undefined ? {} : { mimeType: current.mimeType }),
      ...(current.originalName === undefined ? {} : { originalName: current.originalName }),
      ...(announced === undefined ? {} : { declaredBytes: announced }),
      body: boundedFileBody(response, ingress.store.maxFileBytes, combined),
      ...(signal === undefined ? {} : { signal }),
    }), telemetry);
  };

  const storeAttachment = async (
    ingress: TelegramMediaIngress,
    item: PendingReply,
    admitted: TelegramPendingAttachment,
    telemetry: TelemetryContext,
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
      const stored = await observeOperation("gateway.telegram.media", {},
        (span) => mediaWork.run(() => downloadAttachment(ingress, current, span), signal), telemetry);
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
    telemetry: TelemetryContext = journalTelemetry,
  ): Promise<string | (TextContent | ImageContent)[]> => {
    const ingress = mediaIngress;
    if (ingress === undefined || item.attachments === undefined || item.attachments.length === 0) return item.text;
    const images: ImageContent[] = [];
    const blocks: string[] = [];
    for (const admitted of item.attachments) {
      const stored = await storeAttachment(ingress, item, admitted, telemetry);
      let speech: AttachmentSpeech = {};
      if (stored.status === "stored" && stored.kind === "audio") {
        speech = await observeOperation("gateway.telegram.transcribe", {},
          () => transcribeAttachment(ingress, item, stored), telemetry);
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

  // A control recorded but never confirmed may or may not have taken effect: report it once, never
  // replay it. A restart is never re-requested by recovery: only its interrupted outcome is reported.
  if (state.controls.some((entry) => entry.status === "admitted") || state.pending.some((item) => item.hold === true)) {
    let interrupted = 0;
    await mutateState((doc) => {
      interrupted = recoverInterruptedControls(doc.controls, doc.pending, {
        controlKey: (entry) => entry.updateId,
        noticeKey: (item) => item.updateId,
        report(entry, text) {
          if (doc.pending.length >= MAX_ADMITTED) return false;
          doc.pending.push({
            updateId: entry.updateId,
            nextChunkIndex: 0,
            chatId: entry.chatId,
            sessionKey: sessionKeyFor(entry.chatId),
            senderId: entry.senderId,
            text,
            notice: true,
          });
          return true;
        },
      });
    }, adapterContext);
    if (interrupted > 0) {
      console.warn(`Telegram ${interrupted} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }
  /**
   * Queue one ordinary notice per recorded restart chat: the live confirmation in a replacement process, or
   * the host-refusal report in the process that stayed up. A chat whose sender the live allowlist no longer
   * admits is dropped like any other notice; records that do not fit the admitted bound are returned as still
   * owed instead of being claimed as delivered.
   */
  function admitRestartNotices(doc: Draft<ChannelState>, text: string): Draft<TelegramRestartRecord>[] {
    const used = new Set(doc.pending.map((item) => item.updateId));
    let next = RESTART_LIVE_UPDATE_ID;
    return admitOwedRestartNotices(doc.restart ?? [], (record) => {
      if (doc.pending.length >= MAX_ADMITTED) return false;
      while (used.has(next)) next -= 1;
      used.add(next);
      doc.pending.push({
        updateId: next,
        nextChunkIndex: 0,
        chatId: record.chatId,
        sessionKey: sessionKeyFor(record.chatId),
        senderId: record.senderId,
        text,
        notice: true,
      });
      return true;
    }, (record) => options.allowFrom.includes(record.senderId));
  }

  // A restart this store recorded was requested by the process this one replaced: confirm it is live in every
  // chat that asked, through the same durable notice queue every other host notice uses, then forget them. A
  // sender the live allowlist no longer admits is dropped like any other notice; records that do not fit the
  // admitted bound stay recorded for a later open rather than being reported as delivered.
  if (state.restart !== undefined && state.restart.length > 0) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const remaining = admitRestartNotices(doc, RESTART_LIVE);
      if (remaining.length > 0) doc.restart = remaining;
      else delete doc.restart;
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }
  // An unresolved write-ahead intent may have reached Telegram before a crash.
  for (const item of state.pending.filter((entry) => entry.sendIntent !== undefined || entry.deliveryStatus === "sending")) {
    await markUnknown(item.updateId, item.sendIntent?.stage ?? "final", item.sendIntent?.chunkIndex);
    console.warn(`Telegram delivery outcome unknown for update ${item.updateId}; inspect the Durable channel-state record.`);
  }
  // A model-requested external action may have reached Telegram before a crash: quarantine it.
  await telegramActions.recover();
  // Recover admitted work before polling. Each requestId safely reacquires its existing submission.
  await drainer.recover();
  // Cosmetic and best effort: a slow or flooded menu registration must not delay polling.
  void registerCommandMenu();
  drainer.requestScan();
  scheduledTimer = setInterval(() => drainer.requestScan(), SCHEDULED_SCAN_INTERVAL_MS);
  detachTelegramActions = gateway.telegramActions?.attach(telegramActions.host);
  detachMcpSurface = gateway.mcpSurfaces?.attach({
    owns: (sessionKey) => sessionKey.startsWith(`telegram:${identity}:chat:`),
    async deliverAuthorization(sessionKey, authorization) {
      const owner = ownerChatFor(sessionKey);
      if (owner === undefined) throw new Error("the requesting Telegram owner chat is no longer authorized");
      if (authorization.expiresAtMs <= Date.now()) throw new Error("authorization URL expired before delivery");
      await sendOwnerPlainText(owner.chatId, owner.senderId, [
        "MCP OAuth authorization URL (owner only):",
        authorization.url,
        `Valid until ${new Date(authorization.expiresAtMs).toISOString()}.`,
        "Open it as the owner. If the browser cannot reach this host, paste the callback URL back into this chat.",
        "This gateway does not store this URL or its state in channel state.",
      ].join("\n"));
    },
    async deliverNotice(sessionKey, text) {
      const owner = ownerChatFor(sessionKey);
      if (owner === undefined) return;
      await sendOwnerPlainText(owner.chatId, owner.senderId, text);
    },
  });
  detachAskSurface = gateway.askSurfaces?.attach({
    owns: (sessionKey) => ownerChatFor(sessionKey) !== undefined,
    async deliverQuestion(sessionKey, question) {
      const owner = ownerChatFor(sessionKey);
      if (owner === undefined) throw new Error("the requesting Telegram owner chat is no longer authorized");
      try {
        await sendAskQuestion(owner.chatId, question);
      } catch (error) {
        if (error instanceof TelegramApiError && error.outcome === "unknown") throw new AskDeliveryUnknown();
        throw error;
      }
    },
  });
  journalEvent("telegram.polling", { "queue.depth": state.pending.length });
  drain();

  try {
    while (!signal?.aborted) {
      failedThisPoll.clear();
      drain();
      controls.resumeDeferred();
      drainer.requestScan();
      const updates = await transport.call("getUpdates", (callSignal) => api.getUpdates({
        offset: state.offset,
        timeout: Math.min(options.pollTimeoutSeconds ?? 30, POLL_TIMEOUT_MAX),
        allowed_updates: ["message", "message_reaction", "callback_query"],
      }, callSignal), { throttle: transport.poll, retryOutage: readOutageHooks });
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
            await drainer.reportFault(
              `telegram:${identity}:chat:${origin.evictedChatId}`,
              "origin admission binding evicted at capacity; a fresh admission restores it",
            );
            console.warn("Telegram origin admission binding evicted at capacity; a fresh admission restores it.");
          }
          if (origin.trusted) await drainer.releaseWithheld(sessionKey);
          // An OAuth callback is consumed before any transcript or model admission. Only the exact
          // authenticated sender bound to this chat may submit it; the text itself is never stored.
          if (message.text !== undefined && looksLikeOAuthCallback(message.text)) {
            const senderId = String(message.from!.id);
            const binding = originBindingOf(state.origins, message.chat.id, identity);
            const admin = gateway.mcpAdmin;
            const result = await handleOAuthCallback(
              admin === undefined ? undefined : (text) => admin.submitCallback(sessionKey, text, adapterContext),
              message.text,
              { authenticated: binding !== undefined && binding.senderId === senderId, scope: "chat" },
            );
            await admitMessageNotice(update, message, sessionKey, result.text);
            drain();
            continue;
          }
          // Control parsing happens only after allowlist authentication and never for attachments.
          const parsed = parseTelegramInput(message.text ?? "", me.username);
          if (parsed.kind !== "input") {
            // A failed admission committed nothing (not even the offset): re-poll the same update.
            if (await admitControlUpdate(update, message, parsed)) continue;
            break;
          }
          const caption = message.text !== undefined ? parsed.text : message.caption;
          // A shared location or venue is readable message content, not an attachment: it is
          // rendered from the update's own numbers and venue text, and nothing is looked up. A
          // caption on the same message stays ordinary input ahead of the labeled block.
          const located = telegramLocationContext(message);
          const captionOrLocation = caption === undefined || caption.trim() === ""
            ? located
            : located === undefined ? caption : `${caption}\n\n${located}`;
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
              : captionOrLocation ?? "[Unsupported Telegram message: this adapter accepts text only.]";
          } else if (plan?.kind === "attachment") {
            // The caption stays ordinary input; the attachment block is added after storage.
            body = caption ?? "";
            attachments = [plan.attachment];
          } else if (plan?.kind === "unsupported") {
            // Video and similar kinds are never downloaded, stored or implied to have been read.
            body = unsupportedAttachmentText(plan.label, caption);
          } else {
            body = captionOrLocation ?? "[Empty Telegram message: no text, caption or supported attachment.]";
          }
          const quoted = quotedMessageContext(message, identity);
          // A quoted/replied-to message contributes bounded, labeled reference context and its
          // message identity. An ordinary message keeps its exact original input; its own identity
          // is still durably observed and reachable through the `telegram` tool's `targets` action.
          // A plain-body read is bounded the same way for the target excerpt only; it never becomes
          // a host command, because control parsing above reads `message.text` alone.
          const ownContent = telegramMessageContent(message);
          const input = quoted === undefined
            ? body
            : `${incomingContextText({ messageId: message.message_id, replyTo: quoted.context })}\n${body}`;
          const observedAtMs = Date.now();
          const answerConversation = message.text?.trim() ? await gateway.conversationFor(sessionKey, adapterContext) : undefined;
          state = await stateConversation.commit(async (tx) => {
            const doc = await tx.doc(TelegramState, stateConversation.id);
            if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
              if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
              // Reactions and a typed question answer settle with this exact durable admission.
              const reactions = takeReactionContextText(doc.reactionContext, message.chat.id, observedAtMs);
              if (answerConversation !== undefined) {
                claimTypedQuestionAnswer(await tx.doc(AskQuestionsDoc, answerConversation.id), sessionKey, message.text!, observedAtMs);
              }
              doc.pending.push({
                updateId: update.update_id,
                nextChunkIndex: 0,
                chatId: message.chat.id,
                sessionKey,
                senderId: String(message.from!.id),
                text: reactions === undefined ? input : `${reactions}\n${input}`,
                admittedAtMs: observedAtMs,
                inputMessageId: message.message_id,
                ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
                ...(attachments === undefined ? {} : { attachments }),
              });
            }
            observeTarget(doc, {
              chatId: message.chat.id,
              messageId: message.message_id,
              direction: "incoming",
              senderId: String(message.from!.id),
              text: ownContent.text,
              textSource: ownContent.source,
              observedAtMs,
            });
            if (quoted?.target !== undefined) observeTarget(doc, quoted.target);
            doc.offset = Math.max(doc.offset, update.update_id + 1);
            return copyJson(doc) as unknown as ChannelState;
          }, adapterContext);
          // The exact input and the offset commit before any model submission, so a crash cannot lose or duplicate it.
          journalEvent("telegram.admitted", {
            "update.id": update.update_id, "message.id": message.message_id, "chat.id": message.chat.id,
            "attachments": attachments?.length ?? 0, "queue.depth": state.pending.length,
            "source.age_ms": Math.max(0, observedAtMs - message.date * 1000),
          });
          // A delivery already holding this chat's place gets a short chance to take this message
          // into the same turn; it was durably admitted above, so nothing is lost if it is not.
          if (admittedWhenBusy === undefined) extendCoalesceWindow(message.chat.id);
          drain();
          continue;
        }
        const reaction = update.message_reaction;
        if (reaction !== undefined) {
          await handleReaction(update, reaction);
          continue;
        }
        const callback = update.callback_query;
        if (callback !== undefined) {
          await handleAskCallback(update, callback);
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
    detachMcpSurface?.();
    detachMcpSurface = undefined;
    detachAskSurface?.();
    detachAskSurface = undefined;
    stopAllTyping();
    if (scheduledTimer !== undefined) clearInterval(scheduledTimer);
    // Release any delivery waiting on a coalescing window, so shutdown never waits for an idle timer.
    for (const chatId of [...coalesceWaiters.keys()]) finishCoalesceWindow(chatId);
    scope.cancel(new DOMException("Telegram adapter stopped", "AbortError"));
    await Promise.allSettled([...active, controls.idle(), drainer.idle()]);
  }
  if (fatal !== undefined) throw fatal;

  /**
   * Best-effort native command menu for exactly the controls this adapter implements. A failure or a
   * flood wait leaves typed commands working and never blocks polling; no dead menu entry is added.
   */
  async function registerCommandMenu(): Promise<void> {
    try {
      await transport.call("setMyCommands", (callSignal) => api.setMyCommands(
        telegramCommands(hostCommands),
        { scope: { type: "all_private_chats" } },
        callSignal,
      ), { throttle: transport.outbound, replaceable: true });
    } catch {
      if (!signal?.aborted) {
        console.warn("Telegram command menu registration failed; the implemented commands still work when typed.");
      }
    }
  }

  /**
   * Render one durable question with native inline buttons. Buttons carry opaque question and option
   * ids only; the visible label is model text and the press is re-authenticated before it counts.
   */
  async function sendAskQuestion(chatId: number, question: AskQuestionView): Promise<void> {
    const text = renderQuestionText(question, "telegram", Date.now());
    const inline_keyboard = question.options.map((option) => [{
      text: option.label,
      callback_data: questionCallbackData(question.id, option.id),
    }]);
    const sent = await transport.call<Message.TextMessage>("sendMessage", (callSignal) => transport.inChatOrder(chatId, () =>
      api.sendMessage(chatId, text, { reply_markup: { inline_keyboard } }, callSignal)),
    { throttle: transport.outbound });
    // A throttled or otherwise skipped call would leave an admitted question undelivered while the
    // tool reported success; any non-result is a delivery failure here.
    if (sent === undefined) throw new Error("the question message was not sent");
  }

  /** Cosmetic acknowledgement; an expired query id or a flood wait changes no durable answer state. */
  async function acknowledgeCallback(query: CallbackQuery, text: string): Promise<void> {
    try {
      await transport.call("answerCallbackQuery", (callSignal) =>
        api.answerCallbackQuery(query.id, { text }, callSignal), { throttle: transport.outbound });
    } catch {
      // The popup is best effort; an unacknowledged press still has its durable outcome.
    }
  }

  /** Best effort: the durable record already refuses a later tap with fixed text. */
  async function removeQuestionKeyboard(chatId: number, messageId: number): Promise<void> {
    try {
      await transport.call("editMessageReplyMarkup", (callSignal) => transport.inChatOrder(chatId, () =>
        api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } },
          callSignal)), { throttle: transport.outbound });
    } catch {
      // A keyboard that stays visible is harmless: the next tap is answered by the durable record.
    }
  }

  /**
   * One button press becomes one ordinary durable input only after the exact private chat, the bound
   * sender and the durable question record all accept it. The claim and the follow-up admission share
   * one commit, so a duplicate, stale, expired or replayed tap can never admit a second turn.
   */
  async function handleAskCallback(update: Update, query: CallbackQuery): Promise<void> {
    const message = query.message;
    const senderId = String(query.from.id);
    const chatId = message?.chat.id;
    const binding = chatId === undefined ? undefined : originBindingOf(state.origins, chatId, identity);
    const parsed = parseQuestionCallback(query.data);
    const authorized = message !== undefined && chatId !== undefined && message.chat.type === "private"
      && options.allowFrom.includes(senderId) && binding !== undefined && binding.senderId === senderId;
    if (!authorized || parsed === undefined) {
      await acknowledgeCallback(query, "This button is not available here.");
      await persistOffset(update.update_id + 1);
      return;
    }
    if (gateway.askSurfaces === undefined) {
      await acknowledgeCallback(query, "Questions are not supported in this host.");
      await persistOffset(update.update_id + 1);
      return;
    }
    const sessionKey = `telegram:${identity}:chat:${chatId}`;
    const conversation = await gateway.conversationFor(sessionKey, adapterContext);
    const committed = await stateConversation.commit(async (tx) => {
      const questions = await tx.doc(AskQuestionsDoc, conversation.id);
      const claim = claimQuestionAnswer(questions, {
        questionId: parsed.questionId,
        optionId: parsed.optionId,
        sessionKey,
        nowMs: Date.now(),
      }).result;
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (claim.status === "accepted" && !doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId,
          sessionKey,
          senderId,
          text: claim.text,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return { claim, state: copyJson(doc) as unknown as ChannelState };
    }, adapterContext);
    state = committed.state;
    await acknowledgeCallback(query, claimOutcomeText(committed.claim));
    if (committed.claim.status !== "invalid" && committed.claim.status !== "stale") {
      await removeQuestionKeyboard(chatId, message.message_id);
    }
    drain();
  }

  /**
   * One authenticated reaction change is retained as bounded passive context for the next ordinary
   * owner input in this chat; it never starts a model turn by itself. The sender is the update's
   * `user` (never `actor_chat`), the chat must have matching private-chat admission evidence for
   * this bot, and the reacted message must be an observed target in that exact chat; otherwise the
   * update only advances the offset. The note and offset commit together, so a replay cannot retain
   * it twice and a crash cannot lose it. A later change to the same message replaces its note.
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
    const text = reactionChangeSummary({
      messageId: reaction.message_id,
      target,
      oldReaction: reaction.old_reaction,
      newReaction: reaction.new_reaction,
    });
    const observedAtMs = Date.now();
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      retainReactionNote(doc.reactionContext, {
        updateId: update.update_id,
        chatId,
        messageId: reaction.message_id,
        senderId,
        text,
        observedAtMs,
      });
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }

  async function handleControl(
    update: Update,
    message: TelegramMessage,
    parsed: Exclude<ParsedTelegramInput, { kind: "input" }>,
  ): Promise<void> {
    const chatId = message.chat.id;
    const sessionKey = `telegram:${identity}:chat:${chatId}`;
    // Persistently seal earlier inputs before a control can complete and its notice disappear.
    // Otherwise a later input could be merged across that already-applied context boundary.
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      for (const entry of doc.pending) {
        if (entry.chatId === chatId && coalescableRecord(entry)) entry.coalescedParts = 1;
      }
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    finishCoalesceWindow(chatId);
    const recorded = state.controls.find((entry) => entry.updateId === update.update_id);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of running
      // it twice; one still applying here is answered by its own acknowledgement.
      const replay = await controls.replay({ key: recorded.updateId, command: recorded.command, status: recorded.status });
      if (replay === undefined) await persistOffset(update.update_id + 1);
      else await admitMessageNotice(update, message, sessionKey, replay);
      drain();
      return;
    }
    if (parsed.kind === "foreign") {
      await admitMessageNotice(update, message, sessionKey,
        `/${parsed.command}@${parsed.mention} did not run here and was not sent to the assistant: this bot only ` +
        `accepts an exact mention of its own username. Use /${parsed.command} without a mention.`);
      drain();
      return;
    }
    if (parsed.kind === "unsupported") {
      // The same catalogue reason `/help <name>` gives, so the two refusals cannot drift.
      await admitMessageNotice(update, message, sessionKey,
        `${conversationCommandRefusal("telegram", parsed.command, availableCommandNames())} ` +
        "Any other message is sent to the assistant; prefix // to send a leading slash literally.");
      drain();
      return;
    }
    if (parsed.command === "help") {
      const requested = parsed.args.trim().toLowerCase();
      if (!requested) {
        await admitMessageNotice(update, message, sessionKey, controlHelpText());
        drain();
        return;
      }
      const offered = availableCommandNames();
      const command = offered.includes(requested) ? findConversationCommand(requested) : undefined;
      await admitMessageNotice(update, message, sessionKey, command === undefined
        ? `${conversationCommandRefusal("telegram", requested, offered)} Nothing was sent to the assistant.`
        : conversationDetailBlock(command, "telegram"));
      drain();
      return;
    }
    if (parsed.command === "status") {
      if (!hostCommands.status) {
        await admitMessageNotice(update, message, sessionKey, STATUS_UNAVAILABLE_HOST);
        drain();
        return;
      }
      if (parsed.args) {
        await admitMessageNotice(update, message, sessionKey, usageNotice("status"));
        drain();
        return;
      }
      // Read-only: one bounded notice from the native conversation projection, no effect intent, no model call.
      await admitMessageNotice(update, message, sessionKey,
        await readStatusNotice(gateway, sessionKey, "chat", adapterContext), MAX_NOTICE_CHARS, "status");
      drain();
      return;
    }
    if (parsed.command === "notices") {
      if (!hostCommands.notices) {
        await admitMessageNotice(update, message, sessionKey, NOTICES_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const notices = await noticesCommand(update, message, sessionKey, parsed.args);
      if (notices !== undefined) await admitMessageNotice(update, message, sessionKey, notices);
      drain();
      return;
    }
    if (parsed.command === "model") {
      if (!hostCommands.model) {
        await admitMessageNotice(update, message, sessionKey, MODEL_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const argument = parseModelArgument(parsed.args);
      if (argument.kind === "usage") {
        await admitMessageNotice(update, message, sessionKey, usageNotice("model"));
        drain();
        return;
      }
      const listing = await readModelListing(gateway, sessionKey, adapterContext);
      if (argument.kind === "list") {
        await admitMessageNotice(update, message, sessionKey,
          listing === undefined ? MODEL_LISTING_UNAVAILABLE : renderModelListing(listing, { scope: "chat" }),
          MAX_NOTICE_CHARS, "model");
        drain();
        return;
      }
      // Only the finite configured catalog may be selected; this chat command never rewrites configuration and
      // never accepts an arbitrary provider/model/thinking triple.
      const refusal = modelPresetRefusal(listing, argument.name);
      if (refusal !== undefined) {
        await admitMessageNotice(update, message, sessionKey, refusal);
        drain();
        return;
      }
      await admitControl(update, message, sessionKey, "model", argument.name);
      return;
    }
    if (parsed.command === "restart") {
      if (!hostCommands.restart) {
        const unavailable = options.restart?.unavailable;
        await admitMessageNotice(update, message, sessionKey,
          typeof unavailable === "string" && unavailable.trim() !== ""
            ? unavailable.slice(0, MAX_NOTICE_CHARS)
            : RESTART_UNAVAILABLE_HOST);
        drain();
        return;
      }
      if (parsed.args) {
        await admitMessageNotice(update, message, sessionKey, usageNotice("restart"));
        drain();
        return;
      }
      const already = restartRequester.admissionRefusal();
      if (already !== undefined) {
        await admitMessageNotice(update, message, sessionKey, already);
        drain();
        return;
      }
      await admitControl(update, message, sessionKey, "restart");
      return;
    }
    if (parsed.command === "digest") {
      if (!hostCommands.digest) {
        await admitMessageNotice(update, message, sessionKey, DIGEST_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const argument = parsed.args.trim().toLowerCase();
      if (argument === "status") {
        // Read-only bounded status: no scan, no model call and no cursor change.
        await admitMessageNotice(update, message, sessionKey, await renderDigestStatus(gateway, sessionKey, adapterContext));
        drain();
        return;
      }
      if (argument !== "") {
        await admitMessageNotice(update, message, sessionKey, usageNotice("digest"));
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
        await admitMessageNotice(update, message, sessionKey, MCP_UNAVAILABLE_HOST);
        drain();
        return;
      }
      if (parsed.args.trim() !== "") {
        await admitMessageNotice(update, message, sessionKey, usageNotice("mcp"));
        drain();
        return;
      }
      // Read-only status; management itself is the model tool acting for this authenticated chat.
      await admitMessageNotice(update, message, sessionKey,
        renderMcpListing(await admin.list(adapterContext), MAX_NOTICE_CHARS));
      drain();
      return;
    }
    // The remaining controls are native mutations of this same chat. `/stop` is an alias of `/abort`:
    // it normalizes to the same control kind before admission, so the durable record, gating and
    // recovery path are shared and there is no second cancellation semantics.
    if (parsed.args) {
      await admitMessageNotice(update, message, sessionKey, usageNotice(parsed.command));
      drain();
      return;
    }
    const mutation: ChannelMutation = parsed.command === "stop" ? "abort" : parsed.command;
    await admitControl(update, message, sessionKey, mutation);
  }

  /**
   * Admit one native mutation through the shared coordinator: durable record, held acknowledgement
   * and offset commit before the effect. The chat stays gated so its later inputs cannot overtake
   * this command; a busy chat or the unresolved bound gets a fixed refusal notice instead.
   */
  async function admitControl(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    command: ChannelMutation,
    option?: string,
  ): Promise<void> {
    await controls.admit({
      key: update.update_id,
      scope: message.chat.id,
      command,
      senderId: String(message.from!.id),
      sessionKey,
      ...(option === undefined ? {} : { option }),
    });
    drain();
  }

  /**
   * Handle one control update. Handling commits nothing before its final admission (record,
   * notice and offset in one commit), so a failure leaves the update to be polled again; repeated
   * failures of the same update are fatal as before.
   */
  async function admitControlUpdate(
    update: Update,
    message: TelegramMessage,
    parsed: Exclude<ParsedTelegramInput, { kind: "input" }>,
  ): Promise<boolean> {
    try {
      await handleControl(update, message, parsed);
      controlRetry = undefined;
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      const attempts = controlRetry?.updateId === update.update_id ? controlRetry.attempts + 1 : 1;
      if (attempts >= MAX_CONTROL_ADMISSION_ATTEMPTS) throw error;
      controlRetry = { updateId: update.update_id, attempts };
      console.warn("Telegram control command could not be admitted; it is polled again.");
      await delay(backoff(attempts - 1), signal);
      return false;
    }
  }

  /**
   * This chat's `/notices`, against the outbox and this adapter's own pending notices. Dismissing one
   * of this adapter's pending notices commits the archive, the removal, this command's receipt and
   * its offset together: a failed commit changes nothing, and a re-polled update repeats it once.
   */
  function noticesCommand(update: Update, message: TelegramMessage, sessionKey: string, args: string): Promise<string | undefined> {
    return telegramNoticesCommand({
      outbox,
      context: adapterContext,
      pending: () => state.pending,
      usage: usageNotice("notices"),
      maxChars: MAX_NOTICE_CHARS,
      async dismissPending(dismissKey, updateId, id, receiptFor) {
        state = await stateConversation.commit(async (tx) => {
          const doc = await tx.doc(TelegramState, stateConversation.id);
          if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
            const archive = await tx.doc(TelegramNoticeDismissals, stateConversation.id);
            const outcome = archiveUnknownNotice(doc.pending, archive, { sessionKey: dismissKey, updateId, id, now: Date.now() });
            // Dismissal frees only the delivery queue slot and never claims external delivery.
            if (outcome === "dismissed") {
              doc.pending = doc.pending.filter((entry) => !(entry.updateId === updateId && entry.sessionKey === dismissKey));
            }
            if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
            doc.pending.push({
              updateId: update.update_id,
              nextChunkIndex: 0,
              chatId: message.chat.id,
              sessionKey,
              senderId: String(message.from!.id),
              text: receiptFor(outcome).slice(0, MAX_NOTICE_CHARS),
              notice: true,
            });
          }
          doc.offset = Math.max(doc.offset, update.update_id + 1);
          return copyJson(doc) as unknown as ChannelState;
        }, adapterContext);
      },
    }, sessionKey, args);
  }

  /** The catalogued Telegram commands this host actually supports, in menu order. */
  function availableCommandNames(): readonly string[] {
    return offeredChannelCommandNames("telegram", hostCommands);
  }

  /** Help lists exactly the controls this host implements, one line each; detail stays in `/help <command>`. */
  function controlHelpText(): string {
    const offered = availableCommandNames();
    const absent = conversationCommandNames("telegram").filter((name) => !offered.includes(name));
    return [
      conversationHelpListing("telegram", offered),
      ...(absent.length === 0 ? [] : [`Not offered by this host: ${absent.map((name) => `/${name}`).join(", ")}.`]),
      mediaIngress === undefined
        ? "Text only: attachments are not read and /attach is not available; other slash commands are refused, " +
          "and // sends a leading slash literally."
        : "Photos are images, voice and audio transcribe locally, documents stay unread; video and stickers are " +
          "skipped. // sends a slash literally.",
    ].join("\n\n");
  }

  /** Admit one fixed notice for an update and advance the offset past it, in one commit. */
  async function admitNotice(
    updateId: number,
    chatId: number,
    senderId: string,
    sessionKey: string,
    text: string,
    limit: number = MAX_NOTICE_CHARS,
    noticeFormat?: "status" | "model",
  ): Promise<void> {
    await mutateState((doc) => {
      if (!doc.pending.some((entry) => entry.updateId === updateId)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId,
          nextChunkIndex: 0,
          chatId,
          sessionKey,
          senderId,
          text: text.slice(0, limit),
          notice: true,
          ...(noticeFormat === undefined ? {} : { noticeFormat }),
        });
      }
      doc.offset = Math.max(doc.offset, updateId + 1);
    }, adapterContext);
  }

  function admitMessageNotice(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    text: string,
    limit?: number,
    noticeFormat?: "status" | "model",
  ): Promise<void> {
    return admitNotice(update.update_id, message.chat.id, String(message.from!.id), sessionKey, text, limit, noticeFormat);
  }

  async function persistOffset(offset: number) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.offset = Math.max(doc.offset, offset);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }
}

/** Telegram's own checks of a pending outbox record: a present chunk cursor and a known chunk plan. */
function scheduledRecordProblem(record: Readonly<Record<string, unknown>>): string | undefined {
  if (!Number.isSafeInteger(record.nextChunkIndex) || (record.nextChunkIndex as number) < 0) {
    return "delivery record has an invalid chunk cursor";
  }
  if (record.telegramChunkPlan !== undefined && record.telegramChunkPlan !== "legacy" &&
      record.telegramChunkPlan !== "rich-v1") return "delivery record has an invalid chunk plan";
  return undefined;
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
          (!Number.isInteger(transcription.timeoutMs) || transcription.timeoutMs < 1 || transcription.timeoutMs > 3_600_000)) {
        throw new Error("media.transcription.timeoutMs must be an integer from 1 to 3600000");
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
      } else if (transcription.backend === "hex") {
        const engine = transcription.hex;
        if (engine === undefined) {
          throw new Error("media.transcription.backend \"hex\" requires media.transcription.hex");
        }
        for (const key of ["binary", "ffmpeg", "ffprobe"] as const) {
          const value = engine[key];
          if (typeof value !== "string" || !value.startsWith("/")) {
            throw new Error(`media.transcription.hex.${key} must be an absolute path`);
          }
        }
        if (engine.model !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(engine.model)) {
          throw new Error("media.transcription.hex.model must be a Hex model id");
        }
      } else if (transcription.backend !== undefined && transcription.backend !== "faster-whisper") {
        throw new Error("media.transcription.backend must be faster-whisper, whisper-cli or hex");
      } else if (transcription.whisperCli !== undefined || transcription.hex !== undefined) {
        throw new Error(
          "media.transcription.whisperCli and media.transcription.hex are required exactly by their own backend",
        );
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
 * Reference context for one replied-to message in the same private chat.
 *
 * The excerpt comes from the admitted update itself: an explicit partial quote first (it is the
 * exact fragment the sender referenced), otherwise the replied-to message's own readable text,
 * caption or rich blocks. A body that cannot be read becomes a bounded host label; it is never
 * filled from a transcript, a recent-target cache or another chat. A cross-chat or external reply
 * yields no context and no observed target, so it can never become same-chat target authority.
 */
function quotedMessageContext(
  message: TelegramMessage,
  botId: string,
): { readonly context: TelegramQuotedContext; readonly target?: TelegramObservedTarget } | undefined {
  const quoted = message.reply_to_message;
  if (quoted === undefined || quoted.chat.id !== message.chat.id) return undefined;
  const content = telegramMessageContent(quoted);
  const partialQuote = message.quote;
  const usePartialQuote = partialQuote !== undefined && partialQuote.text.trim() !== "";
  const text = usePartialQuote ? partialQuote.text : content.text;
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
      // The selected fragment belongs only to this turn; observe the complete received body.
      text: content.text,
      textSource: content.source,
      observedAtMs: Date.now(),
    },
  };
}

/** Bot API caps a menu description at 256 characters; a longer summary would be truncated here. */
const TELEGRAM_MENU_DESCRIPTION_MAX = 256;

/**
 * The native command menu is the shared catalogue filtered to the controls this host implements, so
 * its names and one-line descriptions cannot drift from `/help`.
 */
function telegramCommands(
  host: HostCapabilities,
): readonly { readonly command: string; readonly description: string }[] {
  return offeredConversationCommands("telegram", offeredChannelCommandNames("telegram", host)).map((command) => ({
    command: command.name,
    description: command.summary.slice(0, TELEGRAM_MENU_DESCRIPTION_MAX),
  }));
}

type ParsedTelegramInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: TelegramControl; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string }
  | { readonly kind: "foreign"; readonly command: string; readonly mention: string };

type TelegramControl = "new" | "abort" | "stop" | "help" | "status" | "model" | "restart" | "digest" | "mcp" | "notices";

/** Escape all data first; only these host-owned labels and list markers become rich formatting. */
function formatReadOnlyNotice(text: string, kind: "status" | "model"): string {
  let inList = false;
  return text.split("\n").map((line) => {
    const escaped = escapeTelegramLiteral(line);
    if (kind === "status") {
      return escaped.replace(/^(Model|Run|Queued native inputs|Background):/u, "**$1:**");
    }
    const selected = /^\s+\\\* (.+)$/u.exec(escaped);
    const choice = /^\s{4}(.+)$/u.exec(escaped);
    if (selected !== null || choice !== null) {
      inList = true;
      return selected !== null ? `- **Selected:** ${selected[1]}` : `- ${choice![1]}`;
    }
    const separator = inList ? "\n" : "";
    inList = false;
    return separator + escaped.replace(/^(Current model|Configured default preset):/u, "**$1:**");
  }).join("\n");
}

/**
 * Starting point for the durable queue id of that confirmation. Telegram update ids are never negative, so these
 * ids cannot collide with an admitted update, an acknowledgement or a control record.
 */
const RESTART_LIVE_UPDATE_ID = -1;

/** A fixed Telegram usage notice: the catalogue's line, a no-argument note, and the surface's tail. */
function usageNotice(name: string): string {
  const argumentsNote = findConversationCommand(name)?.args === undefined ? " (no arguments)." : "";
  return `${conversationCommandUsage(name, "telegram")}${argumentsNote} Nothing was sent to the assistant.`;
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
      command === "mcp" || command === "notices") {
    return { kind: "control", command, args: raw.slice(match[0].length).trim() };
  }
  return { kind: "unsupported", command };
}

/**
 * The shared control-log bound: a reported terminal record is kept only while its notice is still
 * queued, so a hung provider plus repeated commands cannot grow the log.
 */
function pruneTelegramControls<R extends TelegramControlRecord>(
  controls: readonly R[],
  pending: readonly TelegramPendingDelivery[],
): R[] {
  const reported = reportedControls(pending);
  return pruneControls(controls, (entry) => reported.has(entry.updateId));
}

/** Control update ids a queued notice still reports: its own acknowledgement or a late outcome. */
function reportedControls(pending: readonly TelegramPendingDelivery[]): Set<number> {
  const reported = new Set<number>();
  for (const item of pending) {
    if (item.notice !== true) continue;
    reported.add(item.lateFor ?? item.updateId);
  }
  return reported;
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
