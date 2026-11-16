import { defineDoc, AssistantEntry, ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import { Api, GrammyError, HttpError, InputFile } from "grammy";
import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, journalTelemetry, observeOperation } from "../observability.js";
import type { Message } from "grammy/types";
import type { ApiClientOptions } from "grammy";
import type { MessageReactionUpdated, ReactionType, ReactionTypeEmoji, Update } from "grammy/types";
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
import {
  renderMemoryDigestStart,
  renderMemoryDigestStatus,
} from "../history/memory-digest.js";
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
import { isTurnInterruptionNotice } from "../recovery/interruption.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import { MEDIA_LIMITS, MediaRejected, createMediaStore, type MediaRejectionReason, type MediaStore, type StoredMedia } from "../media/attachments.js";
import { createTranscriber, type HexEngine, type Transcriber, type TranscriptionBackend, type TranscriptionFailure, type WhisperCliEngine } from "../media/transcription.js";
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
  TELEGRAM_COALESCE_LIMITS,
  TELEGRAM_TARGET_LIMITS,
  actionFor,
  admitAction,
  coalescedInputText,
  findTarget,
  incomingContextText,
  observeTarget,
  reactionChangeSummary,
  retainReactionNote,
  settleActionRecord,
  takeReactionContextText,
  targetsForChat,
  unresolvedActions,
  validTelegramFilePath,
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
/** Safe reads (getMe/getUpdates) retry through a Telegram outage without a fixed attempt limit. */
const READ_RETRY_BASE_MS = 1_000;
const READ_RETRY_MAX_MS = 60_000;
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
type SubmissionSlot = { readonly prior: Promise<void>; release(): void };
/**
 * A committed answer that identifies the inputs one run consumed: every input that run consumed settles with
 * the same answer entry. Pending membership plus that durable settlement evidence is the whole shared-delivery
 * identity; no text, in-memory set or delivery tombstone is involved.
 *
 * A failed run has no such identity: Durable settles its inputs with a plain `unanswered` reason and exposes no
 * run reference afterwards, so failures are never grouped — each admitted message reports its own fixed notice.
 * Guessing from the reason text would let a held notice become the phantom owner of an unrelated failure.
 */
type SharedAnswer = { readonly answer: number };
/** `owner` sends the one shared reply, `sibling` stays silent behind it, `retired` is already gone. */
type DeliveryRole = "owner" | "sibling" | "retired";

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
export function telegramTypingActive(
  live: {
    readonly run?: { readonly inputs?: readonly number[] };
    readonly generation?: unknown;
  } | undefined,
  submissionId: number | undefined,
): boolean {
  if (submissionId === undefined || live?.run?.inputs === undefined) return false;
  return live.run.inputs.includes(submissionId) && live.generation !== undefined;
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
   * Optional MCP host surface. Present only when the gateway loaded an on-disk configuration file.
   * `/mcp` is read-only status; callback-shaped ingress is consumed before model admission and the
   * initiating chat receives its own login link and fixed completion notice.
   */
  mcpAdmin?: GatewayMcpAdmin;
  /** Live MCP login delivery and callback surfaces, attached by this adapter while it runs. */
  mcpSurfaces?: import("../mcp/surface.js").McpSurfaceRegistry;
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
    mcp: typeof gateway.mcpAdmin?.list === "function" && typeof gateway.mcpAdmin?.submitCallback === "function",
    notices: typeof gateway.cronOutbox?.list === "function" && typeof gateway.cronOutbox?.update === "function",
  };
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
  const outboundThrottle = new TelegramFloodGate();
  const pollThrottle = new TelegramFloodGate();
  const api = new Api(options.token, {
    apiRoot: API,
    timeoutSeconds: POLL_TIMEOUT_MAX + 10,
    sensitiveLogs: false,
    fetch: telegramFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
  });

  let me: Awaited<ReturnType<Api["getMe"]>> | undefined;
  try {
    me = await apiCall(api, "getMe", signal, (callSignal) => api.getMe(toGrammySignal(callSignal)), {
      throttle: pollThrottle,
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
      richBody?: string;
      throttle?: TelegramFloodGate;
      replaceable?: boolean;
    },
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
    try {
      const sent = await apiCall(api, "sendChatAction", signal,
        (callSignal) => api.sendChatAction(chatId, "typing", {}, toGrammySignal(callSignal)),
        { throttle: outboundThrottle, replaceable: true });
      if (!loop.stopped && !signal?.aborted) {
        if (sent === undefined && !loop.unavailable) {
          journalEvent("telegram.typing.skipped", { "chat.id": chatId, "cooldown.ms": outboundThrottle.remainingMs() });
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
    await apiCall(api, "sendMessage", signal, (callSignal) => withChatSendOrder(chatId, () =>
      api.sendMessage(chatId, text, {}, toGrammySignal(callSignal))), { throttle: outboundThrottle });
  }

  let detachTelegramActions: (() => void) | undefined;
  let detachMcpSurface: (() => void) | undefined;

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
          .then(() => observeOperation("gateway.telegram.scheduled_delivery", {
            "chat.id": chatId, "delivery.id": record.id,
          }, () => deliverScheduled(sessionKey, chatId, record)))
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
      if (!notice && controlPending.has(item.chatId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.updateId) || failedThisPoll.has(item.updateId)) continue;
      delivering.add(item.updateId);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = beginSubmission(item.chatId);
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
    let stopTyping: (() => void) | undefined;
    // Typing follows the committed live state, not submission: it starts when this input's run has
    // an active generation attempt, and stops at every other boundary (queued, tool round, waiting
    // for another task, parked, answered). A run waiting on background work therefore never keeps it
    // alive, and a tool round never pretends the model is typing.
    const syncTyping = (live: Parameters<typeof telegramTypingActive>[0]) => {
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
    try {
      watch.start(async (call) => {
        // Durable's watches never send Chord's recoverable `failed` call; it ends instead.
        if (call.kind !== "value") return;
        const view = call.value;
        const live = view.docs["pi.live"] as {
          run?: { inputs?: SubmissionId[] };
          generation?: { message?: { content?: { type: string; text?: string }[] } };
        } | undefined;
        syncTyping(live);
        const inputs = live?.run?.inputs;
        if (submissionId === undefined || inputs === undefined || !inputs.includes(submissionId)) return;
        // One preview per run: the run's first input owns the single live preview message, so a steered
        // sibling keeps the chat's typing indicator but never publishes a second one.
        if (submissionId !== firstInput(inputs)) return;
        const text = live?.generation?.message?.content
          ?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
        if (text) queuePreview(text);
      });
      const early = earlySubmissions.get(item.updateId);
      earlySubmissions.delete(item.updateId);
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
      // The acquisition/current watch value may already hold this run's generation; the next frame
      // covers the case where it starts later.
      syncTyping(watch.value.docs["pi.live"] as Parameters<typeof telegramTypingActive>[0]);
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
        await stopPreviewWatch();
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
      const settlement = { answer: settled.answer } as const;
      const group = await sharedDeliveryGroup(conversation.id, item, settlement);
      const role: DeliveryRole = !group.present ? "retired" :
        group.owner === undefined || group.owner === item.updateId ? "owner" : "sibling";
      trace.setAttributes({ outcome: role });
      await stopPreviewWatch();
      if (role === "owner") {
        await observeOperation("gateway.telegram.reply", {}, () => flushFinal(answerText), trace);
        await retireSharedDelivery(conversation, item, settlement);
      } else if (role === "sibling") {
        await forget(item.updateId);
      }
    } finally {
      stopTyping?.();
      await stopPreviewWatch();
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
      if (text.trim() === "" && current.messageId !== undefined) {
        // An empty final must remove a streamed preview. Keep its durable id until deletion is
        // confirmed: on an ambiguous result recovery retries deletion, where not-found is success.
        try {
          await apiCall(api, "deleteMessage", signal, (callSignal) => withChatSendOrder(item.chatId, () =>
            api.deleteMessage(item.chatId, current.messageId!, toGrammySignal(callSignal))), { throttle: outboundThrottle });
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
      richBody?: string,
    ): Promise<number | undefined> {
      try {
        return await sendOutboundText(item.chatId, text, {
          mode,
          ...(richBody === undefined ? {} : { richBody }),
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

  /**
   * Whether this conversation's current run may take a steer from this chat. Only an owner surface steers,
   * so a run whose first input is one of these submissions was started by an owner message; a scheduled
   * origin-mode run, a digest result or a worker result starts its own run, and joining it would let the
   * scheduled outbox and this chat deliver the same answer. An idle conversation and one with a live
   * origin-mode occurrence both queue instead: an idle one places a follow-up identically, and a queued
   * occurrence must never be placed into the same boundary as an owner steer.
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
        const record = await tx.submissionByRequest(conversation.id, requestIdFor(identity, candidate.updateId));
        if (record?.id === first) return true;
      }
      return false;
    }, adapterContext);

  /**
   * The native busy-mode to submit one admitted message with. Its own durable admission decided whether the
   * owner asked to steer; a run that another path owns always takes the conservative follow-up queueing, so no
   * owner answer is dropped and no scheduled answer is delivered twice. Native `submit` has no conditional
   * steering, so this state is read immediately before admission.
   */
  const submissionMode = async (conversation: Conversation, current: PendingReply): Promise<"steer" | "followUp"> => {
    if (current.whenBusy !== "steer") return "followUp";
    return (await ownerRun(conversation, current.sessionKey)) ? "steer" : "followUp";
  };

  /**
   * The admitted messages of this chat whose native submission settled with `settlement`'s committed answer,
   * with the earliest native submission as the one that delivers their single shared reply. Durable settlement
   * evidence plus committed pending membership decide it, so every observer computes the same owner without a
   * lock and a reopened process reaches the same answer.
   */
  const sharedDeliveryGroup = async (
    conversationId: Conversation["id"],
    current: PendingReply,
    settlement: SharedAnswer,
  ): Promise<{ readonly updateIds: number[]; readonly owner: number | undefined; readonly present: boolean }> => {
    const members: { updateId: number; submissionId: number }[] = [];
    let present = false;
    // A read-only commit: committed pending membership and submissions are the whole identity.
    await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      members.length = 0;
      present = false;
      for (const candidate of doc.pending) {
        if (candidate.updateId === current.updateId) present = true;
        if (candidate.sessionKey !== current.sessionKey) continue;
        const record = await tx.submissionByRequest(conversationId, requestIdFor(identity, candidate.updateId));
        if (record !== undefined && answeredTogether(record, settlement)) {
          members.push({ updateId: candidate.updateId, submissionId: record.id });
        }
      }
      return undefined;
    }, adapterContext);
    members.sort((left, right) => left.submissionId - right.submissionId || left.updateId - right.updateId);
    return { updateIds: members.map((member) => member.updateId), owner: members[0]?.updateId, present };
  };

  /**
   * One commit that retires this delivery owner and every still-pending sibling of the same answer, so a
   * delivered shared answer can never be sent again by a record left behind by a crash or a slow observer.
   * An unknown or held sibling keeps its own evidence: only pending membership is retired here.
   */
  const retireSharedDelivery = async (
    conversation: Conversation,
    current: PendingReply,
    settlement: SharedAnswer,
  ) => {
    const group = await sharedDeliveryGroup(conversation.id, current, settlement);
    const retired = new Set(group.updateIds);
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
      file = await observeOperation("gateway.telegram.file.lookup", {}, () => apiCall(api, "getFile", signal,
        (callSignal) => api.getFile(current.fileId, toGrammySignal(callSignal)), { throttle: pollThrottle }), telemetry);
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
  /**
   * Queue one ordinary notice per recorded restart chat: the live confirmation in a replacement process, or
   * the host-refusal report in the process that stayed up. A chat whose sender the live allowlist no longer
   * admits is dropped like any other notice; records that do not fit the admitted bound are returned as still
   * owed instead of being claimed as delivered.
   */
  const admitRestartNotices = (doc: ChannelState, text: string): TelegramRestartRecord[] => {
    const remaining: TelegramRestartRecord[] = [];
    const used = new Set(doc.pending.map((item) => item.updateId));
    let next = RESTART_LIVE_UPDATE_ID;
    for (const record of doc.restart ?? []) {
      if (!options.allowFrom.includes(record.senderId)) continue;
      if (doc.pending.length >= MAX_ADMITTED) {
        remaining.push(record);
        continue;
      }
      while (used.has(next)) next -= 1;
      used.add(next);
      doc.pending.push({
        updateId: next,
        nextChunkIndex: 0,
        chatId: record.chatId,
        sessionKey: `telegram:${identity}:chat:${record.chatId}`,
        senderId: record.senderId,
        text,
        notice: true,
      });
    }
    return remaining;
  };

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
  journalEvent("telegram.polling", { "queue.depth": state.pending.length });
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
      }, toGrammySignal(callSignal)), { throttle: pollThrottle, retryOutage: readOutageHooks });
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
          // An OAuth callback is consumed before any transcript or model admission. Only the exact
          // authenticated sender bound to this chat may submit it; the text itself is never stored.
          if (message.text !== undefined && looksLikeOAuthCallback(message.text)) {
            const senderId = String(message.from!.id);
            const binding = originBindingOf(state.origins, message.chat.id, identity);
            if (binding === undefined || binding.senderId !== senderId) {
              await admitNotice(update, message, sessionKey,
                "This OAuth callback did not come from the authenticated sender that owns this chat. It was not sent " +
                "to the assistant and was not stored.");
            } else if (gateway.mcpAdmin === undefined) {
              await admitNotice(update, message, sessionKey,
                "No MCP login is available in this host; the callback was not stored or sent to the assistant.");
            } else {
              const result = await gateway.mcpAdmin.submitCallback(sessionKey, message.text, adapterContext);
              await admitNotice(update, message, sessionKey,
                result.handled
                  ? result.text
                  : "This OAuth callback was not accepted. It was not sent to the assistant and was not stored.");
            }
            drain();
            continue;
          }
          // Control parsing happens only after allowlist authentication and never for attachments.
          const parsed = parseTelegramInput(message.text ?? "", me.username);
          if (parsed.kind !== "input") {
            await handleControl(update, message, parsed);
            continue;
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
          state = await stateConversation.commit(async (tx) => {
            const doc = await tx.doc(TelegramState, stateConversation.id);
            if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
              if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
              // Reactions already retained for this chat become passive context for this input and are
              // consumed in the same commit, so a crash cannot attach them twice.
              const reactions = takeReactionContextText(doc.reactionContext, message.chat.id, observedAtMs);
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
    stopAllTyping();
    if (scheduledTimer !== undefined) clearInterval(scheduledTimer);
    // Release any delivery waiting on a coalescing window, so shutdown never waits for an idle timer.
    for (const chatId of [...coalesceWaiters.keys()]) finishCoalesceWindow(chatId);
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
      // The same catalogue reason `/help <name>` gives, so the two refusals cannot drift.
      await admitNotice(update, message, sessionKey,
        `${conversationCommandRefusal("telegram", parsed.command, availableCommandNames())} ` +
        "Any other message is sent to the assistant; prefix // to send a leading slash literally.");
      drain();
      return;
    }
    if (parsed.command === "help") {
      const requested = parsed.args.trim().toLowerCase();
      if (!requested) {
        await admitNotice(update, message, sessionKey, controlHelpText());
        drain();
        return;
      }
      const offered = availableCommandNames();
      const command = offered.includes(requested) ? findConversationCommand(requested) : undefined;
      await admitNotice(update, message, sessionKey, command === undefined
        ? `${conversationCommandRefusal("telegram", requested, offered)} Nothing was sent to the assistant.`
        : conversationDetailBlock(command, "telegram"));
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
        await admitNotice(update, message, sessionKey, usageNotice("status"));
        drain();
        return;
      }
      // Read-only: one bounded notice from the native conversation projection, no effect intent, no model call.
      await admitNotice(update, message, sessionKey, await statusNotice(sessionKey), MAX_NOTICE_CHARS, "status");
      drain();
      return;
    }
    if (parsed.command === "notices") {
      if (!hostCommands.notices) {
        await admitNotice(update, message, sessionKey, NOTICES_UNAVAILABLE_HOST);
        drain();
        return;
      }
      const argument = parsed.args.trim();
      if (argument === "") {
        await admitNotice(update, message, sessionKey, await staleHostNoticesNotice(sessionKey));
        drain();
        return;
      }
      const dismiss = /^dismiss\s+(\S+)$/u.exec(argument);
      if (dismiss === null || dismiss[1]!.length > 200) {
        await admitNotice(update, message, sessionKey, usageNotice("notices"));
        drain();
        return;
      }
      await admitNotice(update, message, sessionKey, await dismissStaleHostNotice(sessionKey, dismiss[1]!));
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
        await admitNotice(update, message, sessionKey, usageNotice("model"));
        drain();
        return;
      }
      const listing = await readModelListing(sessionKey);
      if (argument.kind === "list") {
        await admitNotice(update, message, sessionKey,
          listing === undefined ? MODEL_LISTING_UNAVAILABLE : modelListingText(listing), MAX_NOTICE_CHARS, "model");
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
        await admitNotice(update, message, sessionKey, usageNotice("restart"));
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
        await admitNotice(update, message, sessionKey, usageNotice("digest"));
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
      if (parsed.args.trim() !== "") {
        await admitNotice(update, message, sessionKey, usageNotice("mcp"));
        drain();
        return;
      }
      // Read-only status; management itself is the model tool acting for this authenticated chat.
      await admitNotice(update, message, sessionKey,
        renderMcpListing(await admin.list(adapterContext), MAX_NOTICE_CHARS));
      drain();
      return;
    }
    // The remaining controls are native mutations of this same chat. `/stop` is an alias of `/abort`:
    // it normalizes to the same control kind before admission, so the durable record, gating and
    // recovery path are shared and there is no second cancellation semantics.
    if (parsed.args) {
      await admitNotice(update, message, sessionKey, usageNotice(parsed.command));
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
        "Previous command pending. This command wasn't started; retry later.");
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
        // still belongs to this command: deliver it as a follow-up, so a slow command cannot lose its
        // only answer.
        if (outcome.text !== undefined) {
          await publishLateControlNotice(
            update.update_id, chatId, sessionKey, String(message.from!.id), outcome.text,
          ).catch(() => undefined);
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
   * Ask the host to replace this process, at most once per adapter lifetime. The host performs it after its
   * own graceful teardown; a refusal is a known no-effect, so it is reported to the chats that asked and
   * never retried or upgraded into a success claim.
   */
  function requestRestart(): void {
    if (restartHostRequested) return;
    const host = options.restart;
    if (host === undefined || !host.supported) return;
    restartHostRequested = true;
    void host.request().catch((error: unknown) => {
      // A busy refusal is a known no-effect before any acknowledgement or teardown: the owner may finish
      // or abort the live work and ask again, so this adapter does not latch the refusal as final.
      const busy = error instanceof RestartBusyError;
      restartHostRequestFailed = !busy;
      if (busy) restartHostRequested = false;
      console.warn(busy
        ? "Telegram /restart was refused while live work is active; the gateway keeps running."
        : "Telegram /restart request was refused by the host; the gateway keeps running.");
      // The acknowledgement promised a follow-up, so the refusal is reported now instead of leaving that
      // promise open until some later process starts.
      void stateConversation.commit(async (tx) => {
        const doc = await tx.doc(TelegramState, stateConversation.id);
        admitRestartNotices(doc, busy ? RESTART_BUSY_MESSAGE : RESTART_FAILED);
        delete doc.restart;
        return copyJson(doc) as unknown as ChannelState;
      }, adapterContext).then((next) => {
        state = next;
        if (!stopping && !signal?.aborted) drain();
      }).catch(() => undefined);
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
          const submission = await earlierConversation.submit({
            type: "input",
            content,
            requestId: requestIdFor(identity, earlier.updateId),
            // The mode its own admission recorded, exactly as the normal delivery path submits it. A run that
            // a scheduled, digest or worker path owns always queues instead of joining.
            whenBusy: await submissionMode(earlierConversation, earlier),
          }, adapterContext);
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
      // The host replaces the process only after this commit, so the record of who is owed a live
      // confirmation is durable first. Every requesting chat is recorded, not just one: chats admitted in
      // the same poll batch each keep the answer their acknowledgement promised.
      if (record.command === "restart" && entry !== undefined) {
        const owed = doc.restart ?? [];
        if (!owed.some((item) => item.chatId === record.chatId)) {
          doc.restart = [...owed, { chatId: record.chatId, senderId: entry.senderId }]
            .slice(-MAX_RESTART_CONFIRMATIONS);
        }
      }
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
    return { kind: "applied" };
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
      await selectPreset.call(gateway, sessionKey, record.target, adapterContext);
      return { kind: "applied", text: `Model: ${boundedLabel(record.target, 80)}.` };
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

  /**
   * This chat's own non-answer host notices whose delivery outcome is unknown. Only exact host
   * notice ids are projected: a model answer or a scheduled result is never listed here, and its
   * text is never copied. Read only; nothing is retried or changed.
   */
  async function staleHostNoticesNotice(sessionKey: string): Promise<string> {
    if (outbox === undefined) return NOTICES_UNAVAILABLE_HOST;
    let records: readonly CronDeliveryRecord[];
    try {
      records = await outbox.list(sessionKey, adapterContext);
    } catch {
      return "Stale host notices are unavailable right now: this chat's delivery outbox could not be read. " +
        "Nothing was changed and nothing was resent.";
    }
    const stale = records
      .filter((record) => record.status === "unknown" && isTurnInterruptionNotice(record))
      .sort((left, right) => unknownSinceMs(left) - unknownSinceMs(right));
    if (stale.length === 0) {
      return "No stale host notices in this chat. Model answers and scheduled results are never listed here.";
    }
    const rows = stale.slice(0, STALE_HOST_NOTICE_ROWS).map((record) =>
      `  ${boundedLabel(record.id, 80)} — outcome unknown since ${unknownSinceText(record)}`);
    return [
      `Stale host notices in this chat: ${stale.length}. Their delivery outcome is unknown, so none was resent.`,
      ...rows,
      ...(stale.length > rows.length ? [`  … ${stale.length - rows.length} more not shown`] : []),
      "Use /notices dismiss <id> for exactly one whose unknown outcome you accept.",
    ].join("\n").slice(0, MAX_NOTICE_CHARS);
  }

  /**
   * Retire exactly one stale host notice of this chat. The record keeps its text and unknown
   * provenance; only its status settles as a fixed, owner-initiated dismissal. An ambiguous send
   * is never retried and a model answer or scheduled result is never touched.
   */
  async function dismissStaleHostNotice(sessionKey: string, id: string): Promise<string> {
    if (outbox === undefined) return NOTICES_UNAVAILABLE_HOST;
    if (!isTurnInterruptionNotice({ id })) {
      return "Only host notices can be dismissed here. Model answers and scheduled results are never " +
        "dismissed or resent.";
    }
    let records: readonly CronDeliveryRecord[];
    try {
      records = await outbox.list(sessionKey, adapterContext);
    } catch {
      return "That stale notice could not be read right now. Nothing was changed and nothing was resent.";
    }
    const current = records.find((record) => record.id === id);
    if (current === undefined) {
      return "No stale host notice with that exact id exists in this chat. Nothing was changed and " +
        "nothing was resent.";
    }
    if (!isTurnInterruptionNotice(current)) {
      return "Only host notices can be dismissed here. Model answers and scheduled results are never " +
        "dismissed or resent.";
    }
    if (current.status !== "unknown") {
      return "That host notice is not in an unknown state, so it was not dismissed. Nothing was changed " +
        "and nothing was resent.";
    }
    let dismissed = false;
    try {
      const updated = await outbox.update(sessionKey, id, (entry) => {
        // Rechecked inside the commit: a concurrent scan or reopen may have settled it already.
        if (!isTurnInterruptionNotice(entry) || entry.status !== "unknown") return;
        dismissed = true;
        entry.status = "failed";
        entry.settledAt = Date.now();
        entry.error = STALE_HOST_NOTICE_DISMISSED;
      }, adapterContext);
      if (updated === undefined) {
        return "No stale host notice with that exact id exists in this chat. Nothing was changed and " +
          "nothing was resent.";
      }
    } catch {
      return "That stale notice could not be changed right now. Nothing was resent; try again later.";
    }
    if (!dismissed) {
      return "That host notice is not in an unknown state, so it was not dismissed. Nothing was changed " +
        "and nothing was resent.";
    }
    return `Dismissed stale host notice ${boundedLabel(id, 80)}. Its original outcome stays unknown; ` +
      "it was not resent.";
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
      "Named model presets (see /help model to select one):",
      ...rows,
      "A selection applies to this chat only and lasts while the gateway stays open; a restart restores the " +
        "configured default and prepared requests keep their model.",
    ].join("\n");
  }

  /** The catalogued Telegram commands this host actually supports, in menu order. */
  function availableCommandNames(): readonly string[] {
    return offeredTelegramCommandNames(hostCommands);
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

  async function admitNotice(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    text: string,
    limit: number = MAX_NOTICE_CHARS,
    noticeFormat?: "status" | "model",
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
          ...(noticeFormat === undefined ? {} : { noticeFormat }),
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
  host: TelegramCommandHost,
): readonly { readonly command: string; readonly description: string }[] {
  return offeredConversationCommands("telegram", offeredTelegramCommandNames(host)).map((command) => ({
    command: command.name,
    description: command.summary.slice(0, TELEGRAM_MENU_DESCRIPTION_MAX),
  }));
}

/** The catalogued Telegram controls this host really implements, in catalogue order. */
function offeredTelegramCommandNames(host: TelegramCommandHost): readonly string[] {
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
    notices: host.notices,
  };
  return conversationCommandNames("telegram").filter((name) => offered[name] === true);
}

/** Which optional host operations this adapter may advertise and apply. */
type TelegramCommandHost = {
  readonly status: boolean;
  readonly model: boolean;
  readonly restart: boolean;
  readonly digest: boolean;
  readonly mcp: boolean;
  readonly notices: boolean;
};

type ParsedTelegramInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: TelegramControl; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string }
  | { readonly kind: "foreign"; readonly command: string; readonly mention: string };

type TelegramControl = "new" | "abort" | "stop" | "help" | "status" | "model" | "restart" | "digest" | "mcp" | "notices";

/**
 * A command with a native effect on this chat or this process; a refusal is terminal, never retried.
 * `/stop` normalizes to `abort` here, so one control kind covers both spellings.
 */
type TelegramMutation = "new" | "abort" | "model" | "restart" | "digest";

type ControlOutcome =
  | {
      readonly kind: "applied";
      readonly text?: string;
      readonly requestRestart?: true;
    }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

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

const CONTROL_ACK: Record<TelegramMutation, string> = {
  new: "Context reset.",
  abort: "Idle. Queue cleared.",
  model: "Model selected.",
  restart: "Restart requested; checking active work.",
  digest: "Digest requested.",
};

const CONTROL_PENDING: Record<TelegramMutation, string> = {
  new: "Reset pending.",
  abort: "Still stopping. New messages are held.",
  model: "Model change pending.",
  restart: "Restart pending.",
  digest: "Digest pending; not started yet.",
};

const UNCONFIRMED_CONTROL =
  "Command interrupted; outcome unknown. Send it again if needed.";

/** An interrupted restart is never repeated automatically, and resending it is the caller's decision. */
const UNCONFIRMED_RESTART =
  "Restart interrupted; outcome unknown. Not retried.";

/**
 * The confirmation the replacement process owes the chat that asked for `/restart`. It is reserved here because it
 * proves only that this process opened and loaded its configuration; it says nothing about later model calls.
 */
const RESTART_LIVE = "Restarted.";
/** The other half of that promise: the host refused the replacement, so this process is still the one serving. */
const RESTART_FAILED = "Restart refused. Gateway still running.";
/**
 * Starting point for the durable queue id of that confirmation. Telegram update ids are never negative, so these
 * ids cannot collide with an admitted update, an acknowledgement or a control record.
 */
const RESTART_LIVE_UPDATE_ID = -1;

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
/** A fixed Telegram usage notice: the catalogue's line, a no-argument note, and the surface's tail. */
function usageNotice(name: string): string {
  const argumentsNote = findConversationCommand(name)?.args === undefined ? " (no arguments)." : "";
  return `${conversationCommandUsage(name, "telegram")}${argumentsNote} Nothing was sent to the assistant.`;
}

const MCP_UNAVAILABLE_HOST =
  "MCP management is unavailable in this host: the gateway was opened without an on-disk configuration file, " +
  "so there is nothing to write. Nothing was sent to the assistant.";
const NOTICES_UNAVAILABLE_HOST =
  "Host notices are unavailable in this host: it exposes no delivery outbox. Nothing was changed and " +
  "nothing was resent.";
/** Bound of stale host notice rows in one listing; the count is still stated above the cut. */
const STALE_HOST_NOTICE_ROWS = 4;
const STALE_HOST_NOTICE_DISMISSED =
  "stale host notice dismissed by the owner; the outcome stays unknown and it was not resent";

/** Unknown-outcome provenance; a record without one falls back to its creation time. */
function unknownSinceMs(record: CronDeliveryRecord): number {
  const since = record.unknownSince;
  return typeof since === "number" && Number.isSafeInteger(since) && since >= 0 ? since : record.createdAtMs;
}

function unknownSinceText(record: CronDeliveryRecord): string {
  const at = unknownSinceMs(record);
  return Number.isSafeInteger(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : "an unrecorded time";
}

/** One pending owner control command. Opaque, fixed-width and content-bound at creation. */
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
      command === "mcp" || command === "notices") {
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

type ReadOutageHooks = {
  entered(method: string): void;
  recovered(): void;
};

type ApiCallOptions = {
  throttle?: TelegramFloodGate;
  replaceable?: boolean;
  /** Present only for idempotent reads that must survive a sustained Telegram outage. */
  retryOutage?: ReadOutageHooks;
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
export async function telegramFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const signal: unknown = init?.signal;
  let nativeSignal = init?.signal ?? null;
  if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) {
    const controller = new AbortController();
    if ((signal as AbortSignal).aborted) controller.abort();
    else (signal as AbortSignal).addEventListener("abort", () => controller.abort(), { once: true });
    nativeSignal = controller.signal;
  }
  const response = await globalThis.fetch(input, { ...init, signal: nativeSignal, redirect: "error" });
  // grammY discards HTTP status before decoding JSON. Preserve safe-read 5xx even when a
  // proxy returns HTML or JSON without Telegram's error_code; outbound decoding is unchanged.
  const method = String(input).split("/").at(-1);
  if ((method === "getMe" || method === "getUpdates") && response.status >= 500 && response.status < 600) {
    await response.body?.cancel().catch(() => undefined);
    throw new TelegramApiError(method, response.status, "rejected");
  }
  return response;
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
  for (let attempt = 0; ; attempt++) {
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
      const result = await request(signal);
      options.retryOutage?.recovered();
      return result;
    } catch (error) {
      if (error instanceof GrammyError) {
        if (method === "editMessageText" && error.error_code === 400 &&
            (isNotModifiedDescription(error.description) || error.description === "Bad Request: message to edit not found")) {
          throw new TelegramApiError(method, error.error_code, "rejected", error.description, { cause: error });
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after;
          if (retryAfter !== undefined && (!Number.isFinite(retryAfter) || retryAfter <= 0)) {
            throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
          }
          const deadline = Date.now() + (retryAfter === undefined ? FLOOD_WAIT_WITHOUT_HINT_MS : retryAfter * 1000);
          if (!Number.isFinite(deadline)) throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
          journalEvent("telegram.rate_limited", { type: method, "cooldown.ms": Math.max(0, deadline - Date.now()) });
          options.throttle?.defer(deadline);
          if (options.replaceable) return undefined;
          if (attempt < MAX_API_ATTEMPTS - 1) continue;
          throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
        }
        if (options.retryOutage !== undefined && error.error_code >= 500) {
          options.retryOutage.entered(method);
          await delay(readRetryBackoff(attempt), signal);
          continue;
        }
        throw new TelegramApiError(method, error.error_code,
          isAmbiguousSendMethod(method) && error.error_code >= 500 ? "unknown" : "rejected", error.description, { cause: error });
      }
      if (error instanceof HttpError) {
        if (isAmbiguousSendMethod(method)) {
          if (isProvenPreConnectFailure(error.error)) {
            if (attempt < MAX_API_ATTEMPTS - 1 && !signal?.aborted) {
              await delay(backoff(attempt), signal);
              continue;
            }
            throw new TelegramApiError(method, 0, "not-sent", undefined, { cause: error });
          }
          throw new TelegramApiError(method, 0, "unknown", undefined, { cause: error });
        }
        if (signal?.aborted) throw signal.reason;
        if (options.retryOutage !== undefined && isTransientTransportError(error.error)) {
          options.retryOutage.entered(method);
          await delay(readRetryBackoff(attempt), signal);
          continue;
        }
      }
      if (signal?.aborted) throw signal.reason;
      if (isAmbiguousSendMethod(method)) throw new TelegramApiError(method, 0, "unknown", undefined, { cause: error });
      throw new Error(`Telegram ${method} transport failed`, { cause: error });
    }
  }
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly outcome: "unknown" | "rejected" | "not-sent";
  readonly description: string | undefined;

  constructor(method: string, status: number, outcome: "unknown" | "rejected" | "not-sent", description?: string, options?: ErrorOptions) {
    super(`Telegram ${method} failed with status ${status}`, options);
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

const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH",
  "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED",
]);

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

/** Capped exponential outage delay with bounded jitter; a successful read starts the next episode at 1s. */
function readRetryBackoff(attempt: number): number {
  const exponential = Math.min(READ_RETRY_MAX_MS / 1.2, READ_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(exponential * (1 + Math.random() * 0.2));
}

/** Network failures, grammY timeouts and safe-read HTTP 5xx are transient; malformed/local failures are not. */
function isTransientTransportError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof TelegramApiError && current.status >= 500 && current.status < 600) return true;
    const candidate = current as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown;
      cause?: unknown; error?: unknown; errors?: unknown };
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
    const code = candidate.code ?? candidate.errno;
    if (typeof code === "string" && TRANSIENT_TRANSPORT_CODES.has(code)) return true;
    if (candidate.message === "fetch failed") return true;
    if (typeof candidate.message === "string" && /^Request to '.+' timed out after .+ seconds$/.test(candidate.message)) {
      return true;
    }
    if (candidate.cause !== undefined) pending.push(candidate.cause);
    if (candidate.error instanceof Error) pending.push(candidate.error);
    if (current instanceof AggregateError && Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return false;
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
