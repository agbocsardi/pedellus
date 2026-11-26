/**
 * The `app` channel adapter: a third opt-in owner surface next to Telegram, Discord and the CLI.
 *
 * It serves an installable web app (PWA) over one loopback HTTP+WebSocket listener that
 * `tailscale serve` publishes on the tailnet, speaking the sibling repository's wire protocol v2.
 * Every paired device shares the same threads, each a host-derived ordinary mapped chat with
 * unchanged tool policy, cron and memory rules.
 *
 * Delivery semantics follow the Telegram adapter, the battle-tested reference:
 * - ingress admission is one durable commit (echo event, pending record, idempotency key) before
 *   any model submission; a re-sent key answers `duplicate` and admits nothing;
 * - egress is the adapter's own durable event log: cursor-numbered `message`/`settled`/`divider`
 *   events, at-least-once per device, replayed after `hello` and trimmed by per-device `ack`s.
 *   Because replay is idempotent by cursor there is no external send to fence: the log append is
 *   the delivery, so Telegram's held-unknown boundary cannot arise here. APP.md documents this
 *   reconciliation of the two channels' delivery models;
 * - a mutating control (`new`, `abort`, `model`, `digest`, `restart`) runs on the shared control
 *   coordinator (`controls.ts`): a held acknowledgement and a durable record before its native call,
 *   the thread's earlier inputs placed first with their attachments, and an applied, refused or
 *   unconfirmed report, exactly like the Telegram and Discord controls;
 * - scheduled cron results and interruption notices arrive through the same channel-neutral
 *   durable outbox, authorized by this channel's own admission evidence and deduplicated by the
 *   outbox record id.
 *
 * No new tool authority exists: the adapter grants nothing. The app chat is the MCP login owner
 * surface for its own open threads: the one-time authorization URL leaves as a non-durable `login`
 * frame to the devices streaming right now (never durable state, a push or a log line), and a
 * callback-shaped `send` is offered to the login lifecycle before admission, with its text never
 * stored. The completion is one fixed notice in that thread. It also owns an `ask_user` surface: a
 * durable `question` event is the channel's delivery path, so the append is a definite delivery.
 */
import { randomBytes } from "node:crypto";
import { defineDoc, AssistantEntry, InboxDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, observeOperation } from "../observability.js";
import type { Conversation, ConversationId, EntryId, Harness, Submission, Tx } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FollowUpMode } from "../config.js";
import type { CronDeliveryRecord } from "../automation/cron-delivery.js";
import { renderMcpListing } from "../mcp/admin.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { createAppLoginSurface } from "./app-login.js";
import { isTurnInterruptionNotice } from "../recovery/interruption.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
import {
  conversationCommandRefusal,
  conversationCommandUsage,
  conversationDetailBlock,
  conversationHelpListing,
  findConversationCommand,
  offeredConversationCommands,
} from "../help/commands.js";
import { AskQuestionsDoc, cancelPendingQuestions, claimOutcomeText, claimQuestionAnswer, claimTypedQuestionAnswer, type AskQuestionsDocument } from "../questions/index.js";
import {
  openQuestionEvent,
  questionMarkOf,
  reconcileQuestionEvents,
  type AppQuestionMarksByThread,
} from "./app-questions.js";
import type { GatewayModelPresets, GatewayModelSelection } from "../runtime.js";
import {
  createSingleHostRegistry,
  detectHostCapabilities,
  offeredChannelCommandNames,
  type ChannelGateway,
  type HostRestartController,
  type StatusDocumentReader,
} from "./contracts.js";
import {
  admitOwedRestartNotices,
  createControlCoordinator,
  createRestartRequester,
  executeChannelControl,
  executeNewSession,
  handleOAuthCallback,
  matchingPresetName,
  MCP_UNAVAILABLE_HOST,
  MODEL_LISTING_UNAVAILABLE,
  modelPresetRefusal,
  parseModelArgument,
  pruneControls,
  readModelListing,
  readStatusNotice,
  recoverInterruptedControls,
  renderDigestStatus,
  renderModelListing,
  RESTART_LIVE,
  type ControlLedger,
  type ControlOutcome,
  type ControlRecord,
} from "./controls.js";
import { createOutboxDrainer } from "./outbox-drainer.js";
import {
  createPreviewWatcher,
  isLiveGenerating,
  resolveOwnerBusyMode,
  resolveSharedDeliveryGroup,
  SubmissionOrderQueue,
  type SubmissionSlot,
} from "./turn-runtime.js";
import { taskCancelReceipt, type AppTaskCancelResult, type AppTaskList } from "./app-tasks.js";
import {
  APP_CLOSE,
  APP_LIMITS,
  APP_MAIN_THREAD,
  APP_PROTOCOL_VERSION,
  APP_QUESTION_OPTION_IDS,
  APP_REQUEST_OPS,
  parseHelloCursor,
  parseQuestionId,
  validAppAgentName,
  validVapidPrivateKey,
  validVapidPublicKey,
  validVapidSubject,
  appPresetInfos,
  parseThreadId,
  parsePushSubscription,
  validAppPresetName,
  type AppCommandInfo,
  type AppControlRecord,
  type AppDeviceRecord,
  type AppDurableEvent,
  type AppErrorCode,
  type AppPairingRecord,
  type AppPendingInput,
  type AppThreadBadge,
  type AppThreadInfo,
  type AppThreadOrigin,
  type AppActivityStep,
  type AppUploadRecord,
} from "./app-protocol.js";
import { createAppPushDispatcher, pushPayload, type AppPushDispatcher, type AppPushOptions } from "./app-push.js";
import { absorbActivity, activityForWire, emptyActivity, type ActivityTally } from "./app-activity.js";
import { startAppListener, type AppDeviceSession, type AppSessionHooks } from "./app-listener.js";
import type { AppShortcutRecord } from "./app-shortcuts.js";
import {
  AppFileRejected,
  createAppFiles,
  type AppMediaOptions,
} from "./app-files.js";
import { createAppActionHost } from "./app-actions.js";
import type { ThreadBadgeRequest } from "./app-badge.js";
import { createAppDevices, type AppConsole } from "./app-devices.js";
import { canOpenSideThread, createAppThreads, openThread, setArchived, threadInfo } from "./app-threads.js";
import type { AppActionRegistry } from "./app-tool.js";
import {
  isReaction,
  reactionChangeSummary,
  retainReactionNote,
  takeReactionContextText,
  type AppReactionNote,
} from "./app-reactions.js";

export type {
  AppConsole,
  AppDeviceListing,
  AppPairingCreated,
  AppPairingRefusal,
} from "./app-devices.js";
export { AppThreadCapacityError, threadInfo } from "./app-threads.js";

/** Preserve the original mapped chat and its history. */
export const APP_CHAT_SESSION_KEY = "app:chat";
export const APP_STATE_SESSION_KEY = `app${CHANNEL_STATE_SESSION_SUFFIX}`;
export function sessionForThread(thread: string): string {
  return thread === APP_MAIN_THREAD ? APP_CHAT_SESSION_KEY : `${APP_CHAT_SESSION_KEY}:${thread}`;
}
export function threadOf(record: { readonly thread?: string }): string {
  return record.thread ?? APP_MAIN_THREAD;
}

const PREVIEW_COALESCE_MS = 700;
/** Tool steps are coalesced like previews; the first change of a turn goes out at once. */
const ACTIVITY_COALESCE_MS = 400;
/** Entries read per transcript page while deriving a turn's activity steps. */
const ACTIVITY_SCAN_PAGE = 200;
const MAX_DELIVERY_FAILURES = 10;
const SCHEDULED_SCAN_INTERVAL_MS = 2_000;
const MAX_SCHEDULED_ACTIVE = 4;
const MAX_NOTICE_CHARS = 1_500;
const DAY_MS = 86_400_000;
const MAX_LATE_CONTROL_CHARS = 4_000;
const QUEUE_FULL = "app durable output queue is full";

export type AppChannelState = {
  /** Next durable cursor; positive, strictly increasing, never reused. */
  nextCursor: number;
  /** Events at or below this cursor were pruned; a lower `hello.cursor` replays from here. */
  floor: number;
  events: AppDurableEvent[];
  pending: AppPendingInput[];
  controls: AppControlRecord[];
  devices: AppDeviceRecord[];
  pairings: AppPairingRecord[];
  /** Shortcut credentials: a label and a token hash, never a device and never a token. */
  shortcuts?: AppShortcutRecord[];
  /** Highest acknowledged durable cursor per device id. */
  acks: Record<string, number>;
  /** Monotonic admission stamp for notice event ids; time alone can repeat within a millisecond. */
  nextNoticeSeq: number;
  /** Bounded recent `send` keys, kept for at least seven days. */
  sendKeys: { readonly key: string; readonly atMs: number }[];
  // These fields are optional on stores written by v1. Existing records belong to main.
  threads?: AppThreadInfo[];
  /** Enrollment (authority) for each registered fork, keyed by its native conversation id. */
  forks?: Record<string, { thread: string; parentThread?: string; at: number; messageId: string }>;
  /** Committed app-visible assistant messages, independent of cursor retention. */
  answerAnchors?: Record<string, { thread: string; at: number }>;
  createKeys?: { readonly key: string; readonly atMs: number; readonly thread: string }[];
  /** Durable admission evidence, set by authenticated input to that exact thread. */
  origin?: { readonly admittedAtMs: number };
  sideOrigins?: Record<string, { readonly admittedAtMs: number }>;
  /** Threads owed a confirmation once the process that recorded an applied `restart` is replaced. */
  restart?: string[];
  /**
   * Passive reaction notes per thread: bounded, replaced per message, and consumed by that
   * thread's next ordinary owner message in the same commit that admits it.
   */
  reactions?: Record<string, AppReactionNote[]>;
  /**
   * The last `question` state published per thread and question id. The durable log is trimmed by
   * retention, so this is what keeps a terminal state from being re-published after its event was
   * pruned. Bounded by the question records of each thread: an entry goes away with the record that
   * owns it, and a thread's map is rebuilt only by that thread's own reconcile.
   */
  questionMarks?: AppQuestionMarksByThread;
  /**
   * Terminal (`unconfirmed`/`refused`) control keys whose report was already delivered. Their
   * records are kept, bounded, so a replayed request id is answered from the record instead of
   * looking new and running the command again.
   */
  reportedControls?: string[];
};

export const AppState = defineDoc<AppChannelState>({
  kind: "nanobot.app-state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  initial: () => ({
    nextCursor: 1,
    floor: 0,
    events: [],
    pending: [],
    controls: [],
    devices: [],
    pairings: [],
    acks: {},
    nextNoticeSeq: 1,
    sendKeys: [],
  }),
});

/**
 * The app channel's host surface: the shared channel gateway plus the thread, task, preset and
 * registry operations only this channel uses.
 */
export interface AppGateway extends Omit<ChannelGateway, "harness"> {
  /**
   * Submission lookup for a recovered input and, when present, the read-only snapshot reader
   * `status` uses; a host without `snapshot` gets the read-only watch projection instead.
   */
  readonly harness?: Pick<Harness, "submission"> & Partial<StatusDocumentReader>;
  forkAppThread?(
    stateId: ConversationId, thread: string, from: AppThreadOrigin,
    init: (doc: Draft<AppChannelState>) => void, context: Context,
  ): Promise<boolean>;
  /** Check native work in the same transaction as idle archive without creating a chat. */
  appThreadBusy?(tx: Tx, thread: string): Promise<boolean>;
  createAppThread?(stateId: ConversationId, thread: string, init: (doc: Draft<AppChannelState>) => void, context: Context): Promise<void>;
  /** Whether one more open mapping fits, checked in the restore transaction. */
  appSnapshotRoom?(tx: Tx): Promise<boolean>;
  /** Create the thread's mapping and snapshot now; `full` reports the snapshot-slot cap. */
  reserveAppThread?(thread: string, context: Context): Promise<"ok" | "full">;
  /**
   * One off-request-path classification of an app side thread: a fixed-list badge emoji and verb
   * from its title and, when at hand, its first owner message. Absent leaves badges off.
   */
  classifyThreadBadge?(request: ThreadBadgeRequest, context: Context): Promise<AppThreadBadge | undefined>;
  /** Read-only host preset catalog (no conversation involved); `undefined` without named presets. */
  modelPresets?(): GatewayModelPresets | undefined;
  /** Read-only selected model of a mapped key; `undefined` when unmapped, rejects when unreadable. */
  selectedModel?(sessionKey: string, context: Context): Promise<GatewayModelSelection | undefined>;
  /**
   * The Tasks view (`tasks`): that thread's own workers and scheduled jobs, newest first and
   * bounded. Read-only; an unmapped thread lists nothing and creates nothing.
   */
  appTasks?(sessionKey: string, context: Context): Promise<AppTaskList>;
  /**
   * Cancel one task of that thread (`task.cancel`). A worker is aborted and a job removed through
   * the existing durable paths; a task that is not this thread's own reports `unknown` untouched.
   */
  appTaskCancel?(sessionKey: string, task: string, context: Context): Promise<AppTaskCancelResult>;
  /** Live operator console registry; the running adapter attaches its pairing host here. */
  appConsole?: AppConsoleRegistry;
  /**
   * Model-tool host registry for agent file delivery (`send`/`artifact`). The running adapter
   * attaches here; without a live host a mapped app chat still sees the tool but every call is
   * refused, because no channel can deliver it.
   */
  appActions?: AppActionRegistry;
}

export interface AppConsoleRegistry {
  /** The running adapter attaches its live console; the returned function detaches it. */
  attach(console: AppConsole): () => void;
  console(): AppConsole | undefined;
}

export function createAppConsoleRegistry(): AppConsoleRegistry {
  const registry = createSingleHostRegistry<AppConsole>();
  return { attach: (host) => registry.attach(host), console: () => registry.current() };
}

/** Host process replacement for the `restart` control: the shared host restart controller. */
export type AppRestartHost = HostRestartController;

export type AppOptions = {
  /** Explicit loopback port from the strict `app` config block; tests may request an ephemeral 0. */
  readonly port: number;
  /** Absolute directory holding the built PWA, served as static files. */
  readonly staticRoot: string;
  readonly autoArchiveDays?: number;
  /** Agent display name sent in every hello reply; 1–40 printable characters. */
  readonly agentName?: string;
  /** Optional absolute directory holding custom avatar sprites and app icons. */
  readonly avatarDir?: string;
  /** Resolved Web Push configuration; absent leaves every push op `unsupported` and sends nothing. */
  readonly push?: AppPushOptions;
  /** Configured owner busy-mode, written onto each admitted input. */
  readonly followUpMode?: FollowUpMode;
  /** Host process replacement for the `restart` control; absent leaves it unoffered. */
  readonly restart?: AppRestartHost;
  /** Attachment opt-in, exactly the other channels' `media` block; absent means no uploads. */
  readonly media?: AppMediaOptions;
  /** Controlled clock for offline checks; absent keeps wall time. */
  readonly now?: () => number;
  /** Adapter scan cadence; tests may shorten it. Default 2s, bounds 50ms–60s. */
  readonly scanIntervalMs?: number;
  /** How long `POST /v1/ask` waits for its answer; tests may shorten it. Bounds 50ms–120s. */
  readonly askWaitMs?: number;
  /** Optional host/test hook with the bound port, fired once when the listener is serving. */
  readonly onListening?: (port: number) => void;
};

type LiveSocket = {
  readonly session: AppDeviceSession;
  hello: boolean;
  /** Highest durable cursor sent on this socket; live pushes continue from here. */
  lastSent: number;
};

/** One durable event without its cursor, distributive over the union. */
type WithoutCursor<T> = T extends { cursor: number } ? Omit<T, "cursor"> : never;
type AppEventInput = WithoutCursor<AppDurableEvent> & { thread: string | AppThreadInfo };
/** A durable `message` as callers hand it over, before `appendMessage` sizes its frame. */
type AppMessageInput = Omit<Extract<AppEventInput, { event: "message" }>, "part">;

/** One `send` admission's result, whether it came from a device socket or a shortcut request. */
export type SendAdmission =
  | { readonly kind: "admitted"; readonly duplicate: boolean }
  | { readonly kind: "error"; readonly error: AppErrorCode }
  | { readonly kind: "stopped" };

/**
 * What the extracted app modules (devices, threads, actions) share with the running adapter: the
 * state document, its commits and the fan-out after a commit appended durable events.
 */
export interface AppCore {
  readonly gateway: AppGateway;
  readonly now: () => number;
  /** The adapter's live context. */
  readonly context: Context;
  readonly stateConversation: Conversation;
  /** The last committed copy of the app state document. */
  state(): AppChannelState;
  /** One commit of the app state document; the returned copy becomes `state()`. */
  mutateState(
    change: (doc: Draft<AppChannelState>, tx: Tx) => void | Promise<void>,
    commitContext?: Context,
  ): Promise<AppChannelState>;
  /** Push newly appended durable events to every streaming device and wake shortcut asks. */
  publish(): void;
  /** Content-free Web Push to subscribed devices without an open stream. */
  notifyPush(thread: string): void;
  /** True once the adapter is stopping or its context aborted. */
  stopped(): boolean;
}

/** One admitted app control: the shared record plus the inputs that were queued before it. */
type AppControl = ControlRecord<string, string> & { readonly earlierKeys: Set<string> };

/** Resolve an app message, not an arbitrary entry ID, to a typed committed transcript entry. */
export async function appForkEntry(
  tx: Tx, state: AppChannelState, source: ConversationId, from: AppThreadOrigin,
): Promise<EntryId | undefined> {
  const { thread, messageId } = from;
  const userKey = messageId.startsWith("send:") ? messageId.slice(5) : undefined;
  let at: number | undefined;
  if (userKey !== undefined && APP_LIMITS.idPattern.test(userKey)) {
    const submission = await tx.submissionByRequest(source, requestIdFor(userKey));
    if (submission?.type === "input") at = submission.entry;
  } else {
    const anchor = state.answerAnchors?.[messageId];
    if (anchor?.thread === thread) at = anchor.at;
    else {
      const legacy = state.events.find((event) => event.event === "message" && event.role === "assistant" &&
        threadOf(event) === thread && event.id === messageId);
      if (legacy?.event === "message" && legacy.key !== undefined) {
        const submission = await tx.submissionByRequest(source, requestIdFor(legacy.key));
        if (submission?.type === "input" && submission.status === "done") at = submission.answer;
      }
    }
  }
  if (at === undefined || !Number.isSafeInteger(at) || at <= 0) return undefined;
  const raw = await tx.entry(at as EntryId);
  // Only a committed app user or assistant message can anchor a fork: bookkeeping entries and
  // display-only records never name model context.
  if (raw === undefined || raw.conversationId !== source) return undefined;
  const token = userKey === undefined ? AssistantEntry : UserEntry;
  if (!(await tx.entry(token, at as EntryId))?.model?.some((message) =>
    message.role === (userKey === undefined ? "assistant" : "user"))) return undefined;
  return raw.id;
}

// ── The durable event log ────────────────────────────────────────────────────

export function requestIdFor(key: string): string {
  return `app:send:${key}`;
}

/** `send` key idempotency window: entries are pruned by age only, so the window is really seven days. */
export function pruneKeys<T extends { readonly atMs: number }>(keys: readonly T[], nowMs: number): T[] {
  return keys.filter((entry) => nowMs - entry.atMs < APP_LIMITS.sendKeyTtlMs);
}

/** Trim the durable event log: acknowledged events first, then the hard cap keeps the newest. */
function pruneEvents(doc: Draft<AppChannelState>): void {
  let floor = doc.floor;
  const activeAcks = doc.devices
    .filter((device) => device.revokedAtMs === undefined)
    .map((device) => doc.acks[device.id] ?? 0);
  if (activeAcks.length > 0) floor = Math.max(floor, Math.min(...activeAcks));
  if (doc.events.length > APP_LIMITS.maxEvents) {
    const cut = doc.events[doc.events.length - APP_LIMITS.maxEvents]!;
    floor = Math.max(floor, cut.cursor - 1);
  }
  if (floor > doc.floor) {
    doc.floor = floor;
    doc.events = doc.events.filter((event) => event.cursor > floor);
  }
}

export function appendEvent(doc: Draft<AppChannelState>, event: AppEventInput): void {
  const cursor = doc.nextCursor;
  doc.nextCursor = cursor + 1;
  // An idle rollover is not activity: it must not delay the idle auto-archive.
  if (event.event === "message" || (event.event === "divider" && event.reason !== "idle")) {
    const info = doc.threads?.find((entry) => entry.id === event.thread);
    if (info !== undefined && info.lastAt < event.at) info.lastAt = event.at;
  }
  doc.events.push({ ...event, cursor });
  pruneEvents(doc);
}

/**
 * Bytes of one code point as `JSON.stringify` writes it inside a string literal: `"` and `\\` take
 * two, most control characters six, and a lone surrogate is escaped as `\uXXXX`. Counting the
 * escaped size is what keeps a split part's whole frame inside `frameBytes`.
 */
function escapedCodePointBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) {
    return codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c ||
      codePoint === 0x0d ? 2 : 6;
  }
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Escaped bytes of a whole string, as the wire's JSON writes it. */
function escapedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** The longest prefix of `text`, in whole code points, whose escaped bytes fit `budget`. */
function fittingPrefix(text: string, budget: number): number {
  let used = 0;
  let end = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end)!;
    used += escapedCodePointBytes(codePoint);
    if (used > budget) break;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

/** `[truncated]` ends a message that needed more parts than the protocol allows. */
const MESSAGE_TRUNCATED = "\n\n[truncated]";
/** The widest `{i, n}` value the splitter can emit, as all nines of `maxMessageParts`'s width. */
const PART_MARKER_BOUND = Number("9".repeat(String(APP_LIMITS.maxMessageParts).length));

/** One message frame's exact size in bytes, in the shape `wireEvent` emits. */
function messageFrameBytes(
  event: AppMessageInput, cursor: number, part?: { i: number; n: number },
): number {
  return Buffer.byteLength(JSON.stringify({
    type: "event", ...event, thread: event.thread ?? APP_MAIN_THREAD, cursor,
    ...(part === undefined ? {} : { part }),
  }));
}

/**
 * Append one durable `message`, split into wire-sized parts when its frame would exceed the frame
 * limit (protocol v2, "Long messages"): same id, thread, role, at and key, one cursor per part,
 * `part: {i, n}`, and every part's frame inside the limit. Parts never cut a UTF-16 surrogate pair;
 * a text needing more than `maxMessageParts` keeps its leading parts and truncates the last, which
 * is marked and reported (APP.md, known bounds). Callers keep their `settled` after this call.
 */
export function appendMessage(doc: Draft<AppChannelState>, event: AppMessageInput): void {
  const first = doc.nextCursor;
  if (messageFrameBytes(event, first) <= APP_LIMITS.frameBytes) {
    appendEvent(doc, event);
    return;
  }
  // `n` is unknown until the text is split, so every budget assumes the widest `{i, n}`; the
  // cursor is exact per part because each append takes the next one.
  const budget = (index: number): number => APP_LIMITS.frameBytes - messageFrameBytes(
    { ...event, text: "" }, first + index, { i: PART_MARKER_BOUND, n: PART_MARKER_BOUND });
  const texts: string[] = [];
  let rest = event.text;
  while (rest !== "" && texts.length < APP_LIMITS.maxMessageParts) {
    // A budget below one code point is unreachable at the protocol's limits; still never cut a pair.
    const take = fittingPrefix(rest, budget(texts.length)) || (rest.codePointAt(0)! > 0xffff ? 2 : 1);
    texts.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  if (rest !== "") {
    const last = texts.length - 1;
    const room = Math.max(1, budget(last) - escapedTextBytes(MESSAGE_TRUNCATED));
    texts[last] = texts[last]!.slice(0, fittingPrefix(texts[last]! + rest, room)) + MESSAGE_TRUNCATED;
    console.warn(`App message ${event.id} exceeds ${APP_LIMITS.maxMessageParts} parts and was truncated.`);
  }
  texts.forEach((text, i) => {
    // A split message carries its attachments and its tool steps on the first part only
    // (protocol v2, Files and Activity).
    const { attachments, steps, omitted, ...rest } = event;
    appendEvent(doc, i === 0
      ? { ...event, text, part: { i, n: texts.length } }
      : { ...rest, text, part: { i, n: texts.length } });
  });
}

/** Message events carry stable ids, so a replayed or crashed append can be recognized exactly. */
function rememberAnswer(doc: Draft<AppChannelState>, id: string, thread: string, at: number): void {
  if (doc.answerAnchors === undefined) doc.answerAnchors = { [id]: { thread, at } };
  else doc.answerAnchors[id] = { thread, at };
}

export function hasEventId(doc: Draft<AppChannelState>, id: string): boolean {
  return doc.events.some((event) => event.event === "message" && event.id === id);
}

type DurableMessageEvent = Extract<AppDurableEvent, { event: "message" }>;
type DurableReactionEvent = Extract<AppDurableEvent, { event: "reaction" }>;

/** The durable `message` a reaction may target: in this thread, and its first part when split. */
function findDurableMessage(
  doc: AppChannelState, thread: string, id: string,
): DurableMessageEvent | undefined {
  return doc.events.find((event): event is DurableMessageEvent => event.event === "message" &&
    threadOf(event) === thread && event.id === id && (event.part === undefined || event.part.i === 0));
}

/** The thread's latest reaction event for one message; the log is ascending, so the last wins. */
function latestReaction(
  doc: AppChannelState, thread: string, message: string,
): DurableReactionEvent | undefined {
  let found: DurableReactionEvent | undefined;
  for (const event of doc.events) {
    if (event.event === "reaction" && threadOf(event) === thread && event.message === message) found = event;
  }
  return found;
}

/**
 * Append this thread's missing `question` events and keep the marks they leave, in the caller's own
 * commit. Returns true when the app has new question state to replay.
 */
export function publishQuestionEvents(
  doc: Draft<AppChannelState>,
  questions: Draft<AskQuestionsDocument>,
  thread: string,
  nowMs: number,
): boolean {
  const byThread = doc.questionMarks ?? {};
  const reconciled = reconcileQuestionEvents(questions, doc.events, byThread[thread], thread, nowMs);
  // Only this thread's map is rebuilt: another thread's marks belong to its own question document.
  doc.questionMarks = { ...byThread, [thread]: reconciled.marks };
  for (const event of reconciled.events) appendEvent(doc, event);
  return reconciled.events.length > 0;
}

/** Keep the control log bounded: a terminal record stays only while its report is still queued. */
function pruneAppControls(doc: Draft<AppChannelState>): void {
  const max = APP_LIMITS.maxUnresolvedControls;
  const queued = new Set(doc.pending.filter((item) => item.notice === true).map((item) => item.key));
  const reported = new Set(doc.reportedControls ?? []);
  let controls = pruneControls(doc.controls, (entry) => queued.has(entry.key) || reported.has(entry.key), max);
  // Keep at most `max` reported replay records total (oldest evicted first when not actively queued).
  const reportedEntries = controls.filter((entry) => (entry.status === "unconfirmed" || entry.status === "refused") &&
    reported.has(entry.key));
  if (reportedEntries.length > max) {
    let excess = reportedEntries.length - max;
    const dropped = new Set<string>();
    for (const entry of reportedEntries) {
      if (excess <= 0) break;
      if (queued.has(entry.key)) continue;
      dropped.add(entry.key);
      excess -= 1;
    }
    if (dropped.size > 0) controls = controls.filter((entry) => !dropped.has(entry.key));
  }
  doc.controls = controls;
  const present = new Set(controls.map((entry) => entry.key));
  const kept = [...reported].filter((key) => present.has(key));
  if (kept.length > max) kept.splice(0, kept.length - max);
  if (kept.length > 0) doc.reportedControls = kept;
  else delete doc.reportedControls;
}

/** Whether this thread has a control acknowledgement still pending append; later notices wait behind it. */
function heldAcknowledgement(doc: AppChannelState, thread: string): boolean {
  const controlKeys = new Set(doc.controls.map((entry) => entry.key));
  return doc.pending.some((item) => item.notice === true && threadOf(item) === thread &&
    (item.hold === true || controlKeys.has(item.key)));
}

/** Queue one host notice in the caller's commit; the sequence stamp makes its event id unique. */
function queueNotice(
  doc: Draft<AppChannelState>, key: string, thread: string, text: string, nowMs: number, hold?: true,
): void {
  const noticeSeq = doc.nextNoticeSeq;
  doc.nextNoticeSeq = noticeSeq + 1;
  doc.pending.push({ key, thread, text, admittedAtMs: nowMs, notice: true, noticeSeq, ...(hold ? { hold } : {}) });
}

/**
 * Commit one control's `applied` status. Only the transition records its effects: a `restart` owes
 * the asking thread a live confirmation, and a `new` appends the one durable `divider` context
 * boundary. A record already applied changes nothing, so a repeated commit never adds a second
 * divider (a divider has no event id to recognise it by).
 */
export function commitControlApplied(
  doc: Draft<AppChannelState>,
  control: { readonly key: string; readonly thread: string; readonly command: string },
  at: string,
): void {
  const entry = doc.controls.find((item) => item.key === control.key);
  if (entry?.status === "applied") return;
  if (entry !== undefined) entry.status = "applied";
  // The host replaces the process only after this commit, so the owed confirmation is durable first.
  if (control.command === "restart" && entry !== undefined) {
    const owed = doc.restart ?? [];
    if (!owed.includes(control.thread)) doc.restart = [...owed, control.thread].slice(-APP_LIMITS.maxOpenThreads - 1);
  }
  pruneAppControls(doc);
  if (control.command === "new") appendEvent(doc, { event: "divider", thread: control.thread, at, reason: "new" });
}

const RESET_BUSY = "Reset refused: thread busy. /abort or retry /new when idle.";
const RESET_UNREPAIRED = "Reset refused: open questions could not be checked. Nothing changed; try again.";
const ARCHIVED_CONTROL_TEXT =
  "That command was not applied: its thread is archived. Restore the thread first.";

/** Bound one host notice; a shortened notice says so instead of dropping its tail silently. */
function boundNotice(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n… (truncated)";
  let end = Math.max(0, limit - marker.length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

/** A fixed usage notice: the catalogue's app line, a no-argument note, and the no-effect tail. */
function usageNotice(name: string): string {
  const argumentsNote = findConversationCommand(name)?.args === undefined ? " (no arguments)." : "";
  return `${conversationCommandUsage(name, "app")}${argumentsNote} Nothing was sent to the assistant.`;
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

/** Validate the adapter options before any listener, conversation or network call. */
export function validateOptions(options: AppOptions): void {
  if (typeof options.port !== "number" || !Number.isSafeInteger(options.port) ||
      options.port < 0 || options.port > 65_535) {
    throw new Error("App requires an explicit loopback port");
  }
  if (typeof options.staticRoot !== "string" || options.staticRoot.trim() === "") {
    throw new Error("App requires a staticRoot directory");
  }
  if (!options.staticRoot.startsWith("/")) {
    throw new Error("App staticRoot must be an absolute path");
  }
  if (options.autoArchiveDays !== undefined && (!Number.isSafeInteger(options.autoArchiveDays) || options.autoArchiveDays < 1)) {
    throw new Error("App autoArchiveDays must be an integer of at least 1");
  }
  if (options.scanIntervalMs !== undefined && (!Number.isSafeInteger(options.scanIntervalMs) ||
      options.scanIntervalMs < 50 || options.scanIntervalMs > 60_000)) {
    throw new Error("App scanIntervalMs must be an integer from 50 to 60000");
  }
  if (options.askWaitMs !== undefined && (!Number.isSafeInteger(options.askWaitMs) ||
      options.askWaitMs < 50 || options.askWaitMs > 120_000)) {
    throw new Error("App askWaitMs must be an integer from 50 to 120000");
  }
  if (options.agentName !== undefined && !validAppAgentName(options.agentName)) {
    throw new Error("App agentName must be 1 to 40 printable characters");
  }
  if (options.avatarDir !== undefined &&
      (typeof options.avatarDir !== "string" || options.avatarDir.trim() === "" || !options.avatarDir.startsWith("/"))) {
    throw new Error("App avatarDir must be an absolute path");
  }
  if (options.push !== undefined &&
      (!validVapidSubject(options.push.subject) || !validVapidPublicKey(options.push.publicKey) ||
       !validVapidPrivateKey(options.push.privateKey))) {
    throw new Error("App push configuration is not a valid VAPID key pair");
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

/**
 * The tool steps of a run, read from its committed transcript entries (protocol v2, "Activity").
 * `from` is the run's first entry and `to` its answer; the walk is one bounded page at a time and
 * keeps only tool names, states and times, never arguments, results, paths or error text.
 */
async function readRunActivity(
  conversation: Conversation,
  conversationId: ConversationId,
  from: EntryId,
  to: EntryId | undefined,
  context: Context,
): Promise<ActivityTally> {
  const tally = emptyActivity();
  let minEntryId: number | undefined = from;
  while (minEntryId !== undefined) {
    const page = await conversation.commit((tx) => tx.scanEntries({
      conversationId,
      minEntryId: minEntryId as EntryId,
      order: "ascending",
      ...(to === undefined ? {} : { maxEntryId: to }),
    }, ACTIVITY_SCAN_PAGE), context);
    absorbActivity(tally, page.items.filter((entry) => entry.conversationId === conversationId),
      APP_LIMITS.activityToolChars);
    const last = page.items.at(-1)?.id;
    minEntryId = page.items.length < ACTIVITY_SCAN_PAGE || last === undefined ? undefined : last + 1;
  }
  return tally;
}

export async function runApp(gateway: AppGateway, options: AppOptions, context: Context): Promise<void> {
  validateOptions(options);
  const now = options.now ?? (() => Date.now());
  const agentName = options.agentName ?? "Pedellus";
  const scanIntervalMs = options.scanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS;
  /** How long a shortcut waits for its turn before the endpoint answers `pending`. */
  const askWaitMs = options.askWaitMs ?? APP_LIMITS.askWaitMs;
  const archiveAfterMs = (options.autoArchiveDays ?? 14) * DAY_MS;
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const cleanupContext = withoutAbortSignal(adapterContext);
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;

  const stateConversation = await gateway.conversationFor(APP_STATE_SESSION_KEY, context);
  let state = await stateConversation.commit(async (tx) => {
    const doc = await tx.doc(AppState, stateConversation.id);
    if (doc.threads === undefined) {
      const activity = doc.events.flatMap((event) => "at" in event ? [event.at] : []).sort();
      const createdAt = activity[0] ?? new Date(doc.origin?.admittedAtMs ?? now()).toISOString();
      doc.threads = [{
        id: APP_MAIN_THREAD, title: "Main", archived: false, createdAt, lastAt: activity.at(-1) ?? createdAt,
      }];
    }
    return copyJson(doc) as unknown as AppChannelState;
  }, context);
  // Files share the state conversation's storage: an upload is durable before its id is answered,
  // and an admitted attachment reference commits in the same transaction as the echo and pending
  // input, so a refused id admits nothing. Without `media` the host reports itself unavailable.
  const files = createAppFiles({
    ...(options.media === undefined ? {} : { media: options.media }),
    conversation: stateConversation,
    context: adapterContext,
    now,
  });
  /**
   * The busy-mode each admitted input asked for, written onto it so a later configuration change or
   * a recovery never re-reads it. Delivery may still fall back to follow-up queueing when another
   * path owns the run, exactly as the Telegram adapter decides.
   */
  const admittedWhenBusy = options.followUpMode === "steer" ? "steer" as const : undefined;

  const sockets = new Map<string, LiveSocket>();
  const delivering = new Set<string>();
  const failedThisCycle = new Set<string>();
  const deliveryFailures = new Map<string, number>();
  /** Per-thread submission order, shared by deliveries, control flushes and archive fences. */
  const order = new SubmissionOrderQueue<string>();
  const earlySubmissions = new Map<string, Submission>();
  const active = new Set<Promise<void>>();
  const activeReplies = new Map<string, number>();
  let activeNotices = 0;
  let fatal: unknown;
  let stopping = false;
  const stopped = (): boolean => stopping || signal?.aborted === true;
  /**
   * Optional host operations, resolved once. A narrow SDK host keeps new, abort/stop and help only;
   * the rest are neither listed in `hello.commands` nor applied.
   */
  const capabilities = detectHostCapabilities(gateway as Omit<AppGateway, "harness">, options.restart);
  /** The `status` host: the snapshot reader only when this host really has one. */
  const snapshotReader = typeof gateway.harness?.snapshot === "function"
    ? gateway.harness as StatusDocumentReader
    : undefined;
  const statusHost: Parameters<typeof readStatusNotice>[0] = {
    conversationFor: (sessionKey, ctx) => gateway.conversationFor(sessionKey, ctx),
    ...(snapshotReader === undefined ? {} : { harness: snapshotReader }),
    ...(gateway.listModels === undefined ? {} : { listModels: (sessionKey, ctx) => gateway.listModels!(sessionKey, ctx) }),
    ...(gateway.backgroundStatus === undefined
      ? {}
      : { backgroundStatus: (sessionKey, ctx) => gateway.backgroundStatus!(sessionKey, ctx) }),
  };
  /** The catalogued app commands this host really implements, in catalogue order. */
  const offeredCommands = offeredChannelCommandNames("app", capabilities);
  const commandInfos: AppCommandInfo[] = offeredConversationCommands("app", offeredCommands).map((command) => ({
    name: command.name,
    ...(command.args === undefined ? {} : { args: command.args }),
    summary: command.summary,
    usage: conversationCommandUsage(command.name, "app"),
  }));
  let recoveryComplete = false;
  let scheduledScanning = false;
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  const statuses = new Map<string, string>();

  const mutateState = async (
    change: (doc: Draft<AppChannelState>, tx: Tx) => void | Promise<void>,
    commitContext: Context = adapterContext,
  ): Promise<AppChannelState> => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(AppState, stateConversation.id);
      await change(doc, tx);
      return copyJson(doc) as unknown as AppChannelState;
    }, commitContext);
    return state;
  };

  // ── Web Push: content-free notifications to devices with no open stream ──

  const push: AppPushDispatcher | undefined = options.push === undefined ? undefined : createAppPushDispatcher({
    options: options.push,
    // Read at send time, so a coalesced follow-up carries the latest unread count.
    snapshot(deviceId, thread) {
      const device = state.devices.find((entry) => entry.id === deviceId && entry.revokedAtMs === undefined);
      const subscription = device?.pushSubscription;
      if (subscription === undefined) return undefined;
      const acked = state.acks[deviceId] ?? 0;
      let unread = 0;
      for (const event of state.events) {
        // A split message counts once (its first part), as v2.md's "first part only" says.
        if (event.event === "message" && event.role !== "user" && event.cursor > acked && !(event.part?.i)) unread += 1;
      }
      return { subscription, payload: pushPayload(thread, unread) };
    },
    gone(deviceId, endpoint) {
      void mutateState((doc) => {
        const device = doc.devices.find((entry) => entry.id === deviceId);
        // A replacement subscription is not this dead one; only the failed endpoint is dropped.
        if (device?.pushSubscription?.endpoint === endpoint) delete device.pushSubscription;
      }).catch(() => undefined);
    },
  });

  /** One push per subscribed device without an open, hello'd stream; never message text. */
  const notifyPush = (thread: string): void => {
    if (push === undefined) return;
    for (const device of state.devices) {
      if (device.revokedAtMs !== undefined || device.pushSubscription === undefined) continue;
      const live = sockets.get(device.id);
      if (live !== undefined && live.hello && live.session.isOpen()) continue;
      push.notify(device.id, thread);
    }
  };

  // ── Egress: the durable cursor log, replayed and pushed ──────────────────

  const wireEvent = (event: AppDurableEvent): string =>
    JSON.stringify({ type: "event", ...event, thread: event.thread ?? APP_MAIN_THREAD });

  /** Push every durable event after one socket's position, in order; only hello'd sockets receive live events. */
  const pushEvents = (socket: LiveSocket): void => {
    if (!socket.hello || !socket.session.isOpen()) return;
    for (const event of state.events) {
      if (event.cursor <= socket.lastSent) continue;
      socket.session.send(wireEvent(event));
      socket.lastSent = event.cursor;
    }
  };

  const pushEventsToSockets = (): void => {
    // Every commit that appends events funnels through here; a settled shortcut ask resolves from
    // the log before the sockets are pushed, so an ask never polls.
    devices.wake();
    for (const socket of sockets.values()) pushEvents(socket);
  };

  const headCursor = (): number | null => state.nextCursor > 1 ? state.nextCursor - 1 : null;
  const statusFrame = (thread: string, stateValue: string): string =>
    JSON.stringify({ type: "event", event: "status", thread, state: stateValue });

  const broadcastStatus = (thread: string, stateValue: string): void => {
    if ((statuses.get(thread) ?? "idle") === stateValue) return;
    if (stateValue === "idle") statuses.delete(thread);
    else statuses.set(thread, stateValue);
    const frame = statusFrame(thread, stateValue);
    for (const socket of sockets.values()) {
      if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
    }
  };

  /**
   * Non-durable `model` events: each thread's current preset name (`null` outside the presets) to one
   * socket or every hello'd one. Never stored in the outbox and never consumes a cursor.
   */
  // Pushes run one after another so a slow read can never send an older selection after a newer one.
  let modelPushes: Promise<void> = Promise.resolve();
  function pushModelEvents(threads: readonly string[], only?: LiveSocket): Promise<void> {
    const next = modelPushes.then(() => sendModelEvents(threads, only));
    modelPushes = next.catch(() => undefined);
    return next;
  }

  async function sendModelEvents(threads: readonly string[], only?: LiveSocket): Promise<void> {
    for (const thread of threads) {
      const host = gateway.modelPresets?.();
      if (host === undefined || gateway.selectedModel === undefined || !openThread(state, thread)) continue;
      // Name only presets hello.presets can list; anything dropped by the wire bounds reads as null.
      const listed = new Set(appPresetInfos(host.presets).map((info) => info.name));
      if (listed.size === 0) continue;
      let selected: GatewayModelSelection | undefined;
      try {
        selected = await gateway.selectedModel(sessionForThread(thread), adapterContext);
      } catch {
        // An unreadable selection is unknown, never reported as the default.
        continue;
      }
      // A thread without a mapped conversation yet runs the configured default preset.
      const name = selected === undefined
        ? host.defaultPreset
        : matchingPresetName({ models: [], selected, presets: host.presets });
      const preset = name !== undefined && listed.has(name) ? name : null;
      if (!openThread(state, thread)) continue;
      const frame = JSON.stringify({ type: "event", event: "model", thread, preset });
      for (const socket of only === undefined ? sockets.values() : [only]) {
        if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
      }
    }
  }

  // ── Extracted modules: devices, threads and the model tool's file delivery ──

  const core: AppCore = {
    gateway,
    now,
    context: adapterContext,
    stateConversation,
    state: () => state,
    mutateState,
    publish: () => pushEventsToSockets(),
    notifyPush: (thread) => notifyPush(thread),
    stopped,
  };
  const devices = createAppDevices({
    core,
    askWaitMs,
    admitSend: (deviceId, frame) => admitSend(deviceId, frame),
    closeDevice(deviceId) {
      sockets.get(deviceId)?.session.close(APP_CLOSE.unauthorized, "revoked");
    },
  });
  const threads = createAppThreads({
    core,
    archiveAfterMs,
    gated: (thread) => controls.gated(thread),
    submitInOrder: (thread, work) => order.submitInOrder(thread, work),
    drain: () => drain(),
    pushModelEvents: (list) => pushModelEvents(list),
  });

  // ── Sockets ───────────────────────────────────────────────────────────────

  const onSocket = (session: AppDeviceSession, hooks: AppSessionHooks): void => {
    if (stopping || signal?.aborted) {
      session.close(1001, "stopping");
      return;
    }
    const previous = sockets.get(session.deviceId);
    if (previous !== undefined) {
      // The newer stream wins; the older one learns it was replaced, not unauthorized.
      sockets.delete(session.deviceId);
      previous.session.close(APP_CLOSE.replaced, "replaced");
    }
    const live: LiveSocket = { session, hello: false, lastSent: state.floor };
    sockets.set(session.deviceId, live);
    hooks.onFrame((frame) => {
      if (stopping || signal?.aborted) return;
      const task = handleFrame(live, frame).catch(() => undefined).finally(() => active.delete(task));
      active.add(task);
    });
    hooks.onClosed(() => {
      if (sockets.get(session.deviceId) === live) sockets.delete(session.deviceId);
    });
  };

  async function handleFrame(socket: LiveSocket, text: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      socket.session.close(APP_CLOSE.protocol, "bad json");
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame) ||
        frame.type !== "req" || typeof frame.id !== "string" || !APP_LIMITS.idPattern.test(frame.id) ||
        typeof frame.op !== "string" || !APP_REQUEST_OPS.includes(frame.op)) {
      socket.session.close(APP_CLOSE.protocol, "bad request");
      return;
    }
    const id = frame.id;
    if (frame.op !== "hello" && !socket.hello) {
      socket.session.close(APP_CLOSE.protocol, "hello first");
      return;
    }
    // Exactly one reply per request, even on an unexpected failure: the helpers mark the request
    // answered, so the catch below never leaves a request silent and never double-replies.
    let answered = false;
    const sendOk = (body: Record<string, unknown> = {}): void => {
      answered = true;
      if (socket.session.isOpen()) {
        socket.session.send(JSON.stringify({ type: "res", id, ok: true, ...body }));
      }
    };
    const sendError = (error: AppErrorCode): void => {
      answered = true;
      if (socket.session.isOpen()) {
        socket.session.send(JSON.stringify({ type: "res", id, ok: false, error }));
      }
    };
    try {
      switch (frame.op) {
        case "hello":
          await handleHello(socket, frame, sendOk, sendError);
          return;
        case "send":
          await handleSendFrame(socket.session.deviceId, frame, sendOk, sendError);
          return;
        case "ack":
          await handleAck(socket, frame, sendOk, sendError);
          return;
        case "control":
          await handleControlFrame(frame, sendOk, sendError);
          return;
        case "answer":
          await handleAnswerFrame(frame, sendOk, sendError);
          return;
        case "threads": {
          const query = frame.query;
          if (query !== undefined && (typeof query !== "string" || query.length === 0 ||
              Array.from(query).length > APP_LIMITS.threadTitleChars)) return sendError("bad_request");
          const sorted = [...(state.threads ?? [])].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
          let archived = 0;
          const needle = query?.toLowerCase();
          const threads = needle === undefined
            ? sorted.filter((thread) => !thread.archived || archived++ < APP_LIMITS.maxListedArchivedThreads)
            : sorted.filter((thread) => thread.title.toLowerCase().includes(needle)).slice(0, APP_LIMITS.maxListedArchivedThreads);
          sendOk({ threads });
          return;
        }
        case "thread.create":
          await threads.create(frame, sendOk, sendError);
          return;
        case "thread.rename":
          await threads.rename(frame, sendOk, sendError);
          return;
        case "thread.archive":
          await threads.archive(frame, sendOk, sendError);
          return;
        case "push.key":
          if (options.push === undefined) return sendError("unsupported");
          sendOk({ key: options.push.publicKey });
          return;
        case "push.subscribe":
          return await handlePushSubscribe(socket, frame, sendOk, sendError);
        case "push.unsubscribe":
          return await handlePushUnsubscribe(socket, sendOk, sendError);
        case "react":
          await handleReactFrame(frame, sendOk, sendError);
          return;
        case "ping":
          sendOk();
          return;
        case "history":
          sendError("unsupported");
          return;
        case "tasks": {
          const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
          if (thread === undefined) return sendError("bad_request");
          if (gateway.appTasks === undefined) return sendError("unsupported");
          // Read-only expansion: listing never maps a thread, so an unknown thread lists nothing.
          const listed = await gateway.appTasks(sessionForThread(thread), adapterContext);
          sendOk({ tasks: [...listed.tasks] });
          return;
        }
        case "task.cancel": {
          const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
          const task = frame.task;
          if (thread === undefined || typeof task !== "string" || !APP_LIMITS.taskIdPattern.test(task)) {
            return sendError("bad_request");
          }
          if (gateway.appTaskCancel === undefined) return sendError("unsupported");
          // An archived thread is read-only here as it is for `send` and `control`.
          if (!openThread(state, thread)) return sendError("bad_request");
          const result = await gateway.appTaskCancel(sessionForThread(thread), task, adapterContext);
          sendOk({ outcome: result.outcome });
          // The visible receipt is a durable `notice`; a full queue must not turn a recorded
          // cancellation into a failure reply, so only the notice is lost and it is journaled.
          try {
            await admitNotice(thread, `task.cancel:${id}`, taskCancelReceipt(result));
          } catch (error) {
            journalEvent("app.task.cancel.receipt-failed", { op: "task.cancel" }, error);
          }
          return;
        }
        default:
          socket.session.close(APP_CLOSE.protocol, "unknown op");
      }
    } catch (error) {
      if (stopping || signal?.aborted) return;
      // A request is never left unanswered: an unexpected failure is one fixed `internal` reply.
      journalEvent("app.request.failed", { op: String(frame.op) }, error);
      if (!answered) sendError("internal");
    }
  }

  async function handleHello(
    socket: LiveSocket,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    if (frame.v !== APP_PROTOCOL_VERSION) {
      socket.session.close(APP_CLOSE.version, "unsupported version");
      return;
    }
    const cursor = parseHelloCursor(frame.cursor);
    if (cursor === undefined) {
      sendError("bad_request");
      return;
    }
    // Synchronous host read: no await between here and `hello = true`, so no frame slips in first.
    const presets = appPresetInfos(gateway.modelPresets?.()?.presets);
    socket.hello = true;
    sendOk({
      v: APP_PROTOCOL_VERSION, device: socket.session.label, head: headCursor(), agent: agentName, commands: commandInfos,
      presets, uploads: files.available,
    });
    // Replay from the acknowledged position (or the retention floor), oldest first, bounded.
    const head = headCursor();
    socket.lastSent = head === null ? state.floor : Math.min(Math.max(cursor ?? 0, state.floor), head);
    let sent = 0;
    for (const event of state.events) {
      if (event.cursor <= socket.lastSent) continue;
      if (sent >= APP_LIMITS.replayBatch) break;
      if (!socket.session.isOpen()) return;
      socket.session.send(wireEvent(event));
      socket.lastSent = event.cursor;
      sent += 1;
    }
    // After the replay the socket always learns the current presence state; unknown means idle.
    if (socket.session.isOpen()) {
      socket.session.send(statusFrame(APP_MAIN_THREAD, statuses.get(APP_MAIN_THREAD) ?? "idle"));
      for (const [thread, status] of statuses) {
        if (thread !== APP_MAIN_THREAD) socket.session.send(statusFrame(thread, status));
      }
      if (presets.length > 0) {
        const open = (state.threads ?? []).filter((entry) => entry.id !== APP_MAIN_THREAD && !entry.archived);
        await pushModelEvents([APP_MAIN_THREAD, ...open.map((entry) => entry.id)], socket);
      }
    }
  }

  async function handleAck(
    socket: LiveSocket,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const cursor = parseHelloCursor(frame.cursor);
    if (cursor === null || cursor === undefined) {
      sendError("bad_request");
      return;
    }
    const deviceId = socket.session.deviceId;
    await mutateState((doc) => {
      // An ack never advances past what exists: clamping keeps the retention cursor honest.
      const head = doc.events.length === 0 ? doc.floor : doc.events.at(-1)!.cursor;
      const clamped = Math.min(cursor, head);
      const previous = doc.acks[deviceId];
      if (previous !== undefined && Number.isSafeInteger(previous) && previous >= clamped) return;
      doc.acks[deviceId] = clamped;
      pruneEvents(doc);
    });
    sendOk();
  }

  async function handlePushSubscribe(
    socket: LiveSocket,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    if (options.push === undefined) {
      sendError("unsupported");
      return;
    }
    const subscription = parsePushSubscription(frame.subscription);
    if (subscription === undefined) {
      sendError("bad_request");
      return;
    }
    const deviceId = socket.session.deviceId;
    await mutateState((doc) => {
      const device = doc.devices.find((entry) => entry.id === deviceId && entry.revokedAtMs === undefined);
      // One subscription per device: a new one replaces the old, endpoints and keys included.
      if (device !== undefined) device.pushSubscription = subscription;
    });
    sendOk();
  }

  async function handlePushUnsubscribe(
    socket: LiveSocket,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    if (options.push === undefined) {
      sendError("unsupported");
      return;
    }
    const deviceId = socket.session.deviceId;
    await mutateState((doc) => {
      const device = doc.devices.find((entry) => entry.id === deviceId);
      if (device !== undefined) delete device.pushSubscription;
    });
    // Idempotent: a device that never subscribed is simply already unsubscribed.
    sendOk();
  }

  // ── Ingress ───────────────────────────────────────────────────────────────

  /**
   * One tapped option becomes one ordinary follow-up turn only after the durable record accepts it.
   * The claim and the admission share one commit, so a duplicate, stale, expired, cancelled or
   * replayed tap can never admit a second turn; the gateway replies and then publishes the change.
   */
  async function handleAnswerFrame(
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    if (thread === undefined || !openThread(state, thread)) return sendError("bad_request");
    if (threads.archiving(thread)) return sendError("not_ready");
    const questionId = parseQuestionId(frame.question);
    const option = frame.option;
    if (questionId === undefined || typeof option !== "string" || !APP_QUESTION_OPTION_IDS.includes(option)) {
      return sendError("bad_request");
    }
    const sessionKey = sessionForThread(thread);
    let accepted = false;
    let blocked: AppErrorCode | undefined;
    try {
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      await mutateState(async (doc, tx) => {
        if (!openThread(doc, thread)) { blocked = "bad_request"; return; }
        if (threads.archiving(thread)) { blocked = "not_ready"; return; }
        const questions = await tx.doc(AskQuestionsDoc, conversation.id);
        // Repair a delivery mark lost in a crash before the claim reads the record, so a live open
        // card is answerable even when a read already quarantined it.
        publishQuestionEvents(doc, questions, thread, now());
        const claim = claimQuestionAnswer(questions, {
          questionId, optionId: option, sessionKey, nowMs: now(),
        });
        // Expiry, and every other settled record, becomes durable before this reply leaves.
        publishQuestionEvents(doc, questions, thread, now());
        if (claim.result.status !== "accepted") {
          // Nothing is admitted. A retried request id explains once; a fresh tap explains again.
          const noticeId = `notice:answer:${questionId}:${frame.id as string}`;
          if (!hasEventId(doc, noticeId)) {
            appendMessage(doc, {
              event: "message", thread, id: noticeId, role: "notice",
              text: claimOutcomeText(claim.result), at: new Date(now()).toISOString(),
            });
          }
          return;
        }
        if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
        // Only the stored record's own label is admitted, never a client-supplied payload.
        doc.pending.push({
          key: `answer:${questionId}`,
          thread,
          text: claim.result.text,
          admittedAtMs: now(),
          ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
        });
        accepted = true;
      });
    } catch (error) {
      if (stopping || signal?.aborted) return;
      if (error instanceof Error && error.message === QUEUE_FULL) return sendError("not_ready");
      journalEvent("app.answer.failed", {}, error);
      sendError("internal");
      return;
    }
    if (blocked !== undefined) return sendError(blocked);
    // The reply precedes the state event; the app still treats the card as answered only once the
    // `question` event arrives (protocol v2, "Owner questions").
    sendOk({ accepted });
    pushEventsToSockets();
    if (accepted) {
      journalEvent("app.answered", { "send.key": `answer:${questionId}` });
      drain();
    }
  }

  /**
   * A `send`'s attachment ids: `undefined` for none, `"bad"` for a list that refuses the request.
   * Upload ids are the only attachment authority: this device's, unexpired, unused, bounded. An
   * empty list is indistinguishable from no attachments at all, and without media storage no
   * upload can exist, so every id is unknown. A shortcut request has no attachments field at all.
   */
  const attachmentIdsFor = (raw: unknown): string[] | "bad" | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > APP_LIMITS.maxAttachments ||
        raw.some((id) => typeof id !== "string" || !APP_LIMITS.uploadIdPattern.test(id))) return "bad";
    if (raw.length > 0 && !files.available) return "bad";
    return raw.length === 0 ? undefined : raw as string[];
  };

  /**
   * One callback-shaped `send`: consumed before admission and offered to the MCP login lifecycle.
   *
   * The callback text never enters channel state, a push, a log or the model. Only the lifecycle's
   * fixed notice is appended, and the attempt is bound to this thread's exact session, so a
   * callback pasted into another thread is refused. The send key keeps its idempotency: it is
   * claimed in a durable commit before the lifecycle sees the text, so a re-sent key answers
   * `duplicate` and cannot start a second exchange.
   */
  async function handleCallbackSend(
    thread: string, key: string, text: string,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const noticeKey = `callback:${key}`;
    let duplicate = true;
    let blocked: AppErrorCode | undefined;
    try {
      await mutateState((doc) => {
        if (!openThread(doc, thread)) { blocked = "bad_request"; return; }
        if (threads.archiving(thread)) { blocked = "not_ready"; return; }
        // A key whose echo or notice is still in the log is a duplicate even if its window entry
        // was pruned.
        if (doc.sendKeys.some((entry) => entry.key === key) || hasEventId(doc, `send:${key}`) ||
            hasEventId(doc, `notice:${noticeKey}`) || doc.pending.some((entry) => entry.key === noticeKey) ||
            doc.events.some((event) => event.event === "message" && event.id.startsWith(`notice:${noticeKey}#`))) return;
        if (doc.pending.length >= APP_LIMITS.maxPending) { blocked = "not_ready"; return; }
        duplicate = false;
        doc.sendKeys = pruneKeys([...doc.sendKeys, { key, atMs: now() }], now());
        // Reserve the notice slot before offering the callback so a full queue never consumes an
        // OAuth callback without delivering its receipt.
        queueNotice(doc, noticeKey, thread, "", now(), true);
      });
    } catch (error) {
      if (stopping || signal?.aborted) return;
      journalEvent("app.send.failed", {}, error);
      sendError("internal");
      return;
    }
    if (blocked !== undefined) return sendError(blocked);
    if (duplicate) return sendOk({ duplicate: true });

    // A failure to offer the callback still must not echo, store or model the text: the shared
    // handler answers only fixed wording or the lifecycle's own credential-free text.
    const admin = gateway.mcpAdmin;
    const reply = (await handleOAuthCallback(
      admin === undefined
        ? undefined
        : (callback) => admin.submitCallback(sessionForThread(thread), callback, adapterContext),
      text,
      { scope: "thread" },
    )).text;
    try {
      // Release the reserved notice slot with the receipt text; still ordered behind any held ack.
      await mutateState((doc) => {
        const reserved = doc.pending.find((entry) => entry.notice === true && entry.key === noticeKey);
        if (reserved !== undefined) {
          reserved.text = boundNotice(reply, MAX_NOTICE_CHARS);
          delete reserved.hold;
        } else if (doc.pending.length < APP_LIMITS.maxPending) {
          queueNotice(doc, noticeKey, thread, boundNotice(reply, MAX_NOTICE_CHARS), now());
        } else {
          throw new Error(QUEUE_FULL);
        }
      });
      drain();
    } catch (error) {
      if (stopping || signal?.aborted) return;
      journalEvent("app.send.failed", {}, error);
      sendError(error instanceof Error && error.message === QUEUE_FULL ? "not_ready" : "internal");
      return;
    }
    sendOk({ duplicate: false });
  }

  /**
   * The one owner-message admission path: `send` frames and `POST /v1/ask` both come through here,
   * so a shortcut gets exactly a device send's bounds, idempotency by key, echo event, pending
   * record and question settlement. `deviceId` is absent only for a shortcut, which can never name
   * an upload (its request has no attachments field).
   */
  async function admitSend(deviceId: string | undefined, frame: Record<string, unknown>): Promise<SendAdmission> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    if (thread === undefined || !openThread(state, thread)) return { kind: "error", error: "bad_request" };
    if (threads.archiving(thread)) return { kind: "error", error: "not_ready" };
    const key = frame.key;
    const text = frame.text;
    const attachmentIds = attachmentIdsFor(frame.attachments);
    if (attachmentIds === "bad") return { kind: "error", error: "bad_request" };
    if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key) || typeof text !== "string" ||
        (text.length === 0 && (attachmentIds === undefined || attachmentIds.length === 0))) {
      return { kind: "error", error: "bad_request" };
    }
    if (text.length > APP_LIMITS.sendTextChars) {
      return { kind: "error", error: "too_large" };
    }
    // The first send into a thread creates its mapping and snapshot: reserve that before the
    // admission is acked, so nothing is admitted that the host cannot hold.
    if (state.sendKeys.some((item) => item.key === key) || hasEventId(state, `send:${key}`)) {
      return { kind: "admitted", duplicate: true };
    }
    if (gateway.reserveAppThread !== undefined) {
      // Rechecked here, immediately before the reservation, so an archived thread is refused
      // before its snapshot can be reinstalled, whatever awaits are added above this point.
      if (!openThread(state, thread)) return { kind: "error", error: "bad_request" };
      let reserved: "ok" | "full";
      try {
        reserved = await gateway.reserveAppThread(thread, adapterContext);
      } catch (error) {
        if (stopping || signal?.aborted) return { kind: "stopped" };
        journalEvent("app.reserve.failed", {}, error);
        return { kind: "error", error: "internal" };
      }
      if (reserved === "full") {
        journalEvent("app.send.refused", { reason: "capacity" });
        return { kind: "error", error: "not_ready" };
      }
    }
    // A typed ordinary message settles the oldest delivered question in this thread in the same
    // commit as its admission, as Telegram and the terminal do; commands never count (callback text
    // never reaches here), and an attachment-only send has no text to count with.
    const answerConversation = gateway.askSurfaces === undefined
      ? undefined
      : await gateway.conversationFor(sessionForThread(thread), adapterContext).catch((error: unknown) => {
          if (!stopping && !signal?.aborted) journalEvent("app.send.failed", {}, error);
          return undefined;
        });
    let duplicate = true;
    let blocked: AppErrorCode | undefined;
    try {
      await mutateState(async (doc, tx) => {
        if (!openThread(doc, thread)) { blocked = "bad_request"; return; }
        if (threads.archiving(thread)) { blocked = "not_ready"; return; }
        if (doc.sendKeys.some((entry) => entry.key === key)) return;
        if (doc.pending.some((entry) => entry.key === key && entry.notice !== true)) return;
        // A key whose echo is still in the log is a duplicate even if its window entry was pruned.
        const eventId = `send:${key}`;
        if (hasEventId(doc, eventId)) return;
        if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
        duplicate = false;
        const atMs = now();
        const at = new Date(atMs).toISOString();
        // Claimed inside this transaction: an unknown, foreign, expired or reused id refuses the
        // whole send and the commit admits nothing, not even the idempotency key.
        let claimed: AppUploadRecord[] | undefined;
        if (attachmentIds !== undefined) {
          // Only a paired device owns uploads; a shortcut caller has no device to claim with.
          if (deviceId === undefined) { blocked = "bad_request"; return; }
          try {
            claimed = await files.claim(tx, { deviceId, ids: attachmentIds, atMs, messageId: eventId });
          } catch (error) {
            if (!(error instanceof AppFileRejected)) throw error;
            blocked = "bad_request";
            return;
          }
        }
        doc.sendKeys = pruneKeys([...doc.sendKeys, { key, atMs }], atMs);
        appendMessage(doc, {
          event: "message", thread, id: eventId, role: "user", text, at, key,
          ...(claimed === undefined || claimed.length === 0 ? {} : { attachments: files.infos(claimed) }),
        });
        // This thread's retained reaction notes are passive context for the model-facing input only:
        // the echo above keeps the owner's exact text, and the notes are cleared in this same commit
        // so a replay cannot attach them twice.
        const retained = doc.reactions?.[thread];
        let notes: string | undefined;
        if (retained !== undefined) {
          notes = takeReactionContextText(retained, atMs);
          // Written back even when empty: the consumption is the commit's own record of it.
          doc.reactions![thread] = retained;
        }
        doc.pending.push({
          key, thread, text: notes === undefined ? text : `${notes}\n${text}`, admittedAtMs: atMs,
          ...(claimed === undefined ? {} : { attachments: claimed }),
          ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
        });
        if (thread === APP_MAIN_THREAD) doc.origin = { admittedAtMs: atMs };
        else if (doc.sideOrigins === undefined) doc.sideOrigins = { [thread]: { admittedAtMs: atMs } };
        else doc.sideOrigins[thread] = { admittedAtMs: atMs };
        if (answerConversation !== undefined) {
          const questions = await tx.doc(AskQuestionsDoc, answerConversation.id);
          // The read repairs a delivery mark lost in a crash before the claim, so a live open card
          // can be answered by typing as well as by tapping.
          publishQuestionEvents(doc, questions, thread, atMs);
          claimTypedQuestionAnswer(questions, sessionForThread(thread), text, atMs);
          publishQuestionEvents(doc, questions, thread, atMs);
        }
      });
    } catch (error) {
      if (stopping || signal?.aborted) return { kind: "stopped" };
      if (error instanceof Error && error.message === QUEUE_FULL) {
        journalEvent("app.send.refused", { reason: "queue-full" });
        return { kind: "error", error: "not_ready" };
      }
      journalEvent("app.send.failed", {}, error);
      return { kind: "error", error: "internal" };
    }
    if (blocked !== undefined) return { kind: "error", error: blocked };
    pushEventsToSockets();
    if (!duplicate) {
      journalEvent("app.admitted", { "send.key": key, "queue.depth": state.pending.length });
      void releaseWithheld(thread);
      drain();
      // The thread's first admitted owner message is the badge trigger; it never delays this send.
      threads.badge(thread);
    }
    return { kind: "admitted", duplicate };
  }

  async function handleSendFrame(
    deviceId: string,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    // A callback-shaped line is consumed before admission and offered to the MCP login lifecycle: it
    // never becomes a turn, so there is nothing to admit. Its send key keeps its own idempotency.
    // Only the frame's own preconditions are checked here; everything else takes `admitSend`.
    const callback = frame.text;
    if (typeof callback === "string" && looksLikeOAuthCallback(callback)) {
      const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
      if (thread === undefined || !openThread(state, thread)) return sendError("bad_request");
      if (threads.archiving(thread)) return sendError("not_ready");
      if (attachmentIdsFor(frame.attachments) === "bad") return sendError("bad_request");
      const key = frame.key;
      if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key)) return sendError("bad_request");
      if (callback.length > APP_LIMITS.sendTextChars) return sendError("too_large");
      await handleCallbackSend(thread, key, callback, sendOk, sendError);
      return;
    }
    const admission = await admitSend(deviceId, frame);
    if (admission.kind === "stopped") return;
    if (admission.kind === "error") return sendError(admission.error);
    sendOk({ duplicate: admission.duplicate });
  }

  // ── Reactions ──────────────────────────────────────────────────────────

  /**
   * `react`: one owner reaction (or its clear) on a durable message of an open thread. It appends
   * the durable `reaction` event every device renders and retains a bounded passive note for the
   * thread's next ordinary owner message; it never admits input and never starts a turn.
   */
  async function handleReactFrame(
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    const message = frame.message;
    const emoji = frame.emoji;
    if (thread === undefined || !openThread(state, thread) || threads.archiving(thread)) return sendError("bad_request");
    if (typeof message !== "string" || message.length === 0 || message.length > 256) return sendError("bad_request");
    if (emoji !== null && !isReaction(emoji)) return sendError("bad_request");
    let blocked: AppErrorCode | undefined;
    try {
      await mutateState((doc) => {
        // Rechecked inside the commit exactly as a send does: an archive may have landed, or be in
        // flight, while this request waited for its own commit.
        if (!openThread(doc, thread) || threads.archiving(thread)) { blocked = "bad_request"; return; }
        const target = findDurableMessage(doc, thread, message);
        // A gateway `notice` is neither the owner's nor the agent's message. Summarising it would
        // attribute the gateway's own text to the owner, so it is not a target at all.
        if (target === undefined || target.role === "notice") { blocked = "bad_request"; return; }
        const previous = latestReaction(doc, thread, message)?.emoji ?? null;
        const atMs = now();
        if (doc.reactions === undefined) doc.reactions = {};
        // Build the next list before assigning it: a draft stores the assigned value, so an array
        // created by a property write is not the one the commit keeps.
        const notes = [...(doc.reactions[thread] ?? [])];
        retainReactionNote(notes, {
          messageId: message,
          emoji,
          text: reactionChangeSummary({ messageId: message, role: target.role, text: target.text, previous, emoji }),
          observedAtMs: atMs,
        });
        doc.reactions[thread] = notes;
        appendEvent(doc, { event: "reaction", thread, message, by: "owner", emoji });
      });
    } catch (error) {
      if (stopping || signal?.aborted) return;
      journalEvent("app.react.failed", {}, error);
      sendError("internal");
      return;
    }
    if (blocked !== undefined) return sendError(blocked);
    sendOk();
    pushEventsToSockets();
  }

  // ── Delivery of admitted work ─────────────────────────────────────────────

  const drain = (): void => {
    if (stopped() || !recoveryComplete) return;
    // A thread's notices keep admission order behind an acknowledgement that is still held, so a
    // later notice can never overtake a control's outcome in the same thread.
    const heldThreads = new Set<string>();
    for (const item of [...state.pending]) {
      const notice = item.notice === true;
      const thread = threadOf(item);
      if (item.hold === true) {
        heldThreads.add(thread);
        continue;
      }
      if (item.held === true) continue;
      if (notice && heldThreads.has(thread)) continue;
      if (notice ? activeNotices >= 8 : (activeReplies.get(thread) ?? 0) >= 8) continue;
      // A gated thread holds its inputs; a notice is never a model submission, so it still goes out.
      if (!notice && (controls.gated(thread) || threads.archiving(thread))) continue;
      if (delivering.has(item.key) || failedThisCycle.has(item.key)) continue;
      delivering.add(item.key);
      if (notice) activeNotices += 1;
      else activeReplies.set(thread, (activeReplies.get(thread) ?? 0) + 1);
      const slot = order.beginSubmission(thread);
      const task = observeOperation("gateway.app.delivery", {
        "send.key": item.key, notice, "queue.depth": state.pending.length,
        attempt: (deliveryFailures.get(item.key) ?? 0) + 1,
      }, (trace) => deliver(item, slot, trace)).catch(async (error: unknown) => {
        failedThisCycle.add(item.key);
        await holdFailedDelivery(item.key, error).catch(() => undefined);
      }).finally(() => {
        slot.release();
        if (notice) activeNotices -= 1;
        else {
          const remaining = (activeReplies.get(thread) ?? 1) - 1;
          if (remaining === 0) activeReplies.delete(thread);
          else activeReplies.set(thread, remaining);
        }
        active.delete(task);
        delivering.delete(item.key);
        if (!stopped()) drain();
      });
      active.add(task);
    }
  };

  /** The request IDs of this thread's admitted owner inputs, read just before a busy-mode decision. */
  const ownerRequestIds = (thread: string): string[] => state.pending
    .filter((candidate) => candidate.notice !== true && threadOf(candidate) === thread)
    .map((candidate) => requestIdFor(candidate.key));

  const submissionMode = (conversation: Conversation, current: AppPendingInput): Promise<"steer" | "followUp"> =>
    resolveOwnerBusyMode(conversation, current.whenBusy, ownerRequestIds(threadOf(current)), adapterContext);

  const deliver = async (item: AppPendingInput, slot: SubmissionSlot, trace: TelemetrySpan): Promise<void> => {
    const thread = threadOf(item);
    if (item.notice === true) {
      // Idempotent by the notice's own admission stamp: a redelivery after a crash appends nothing.
      const id = `notice:${item.key}#${item.noticeSeq ?? item.admittedAtMs}`;
      let appended = false;
      await mutateState((doc) => {
        if (hasEventId(doc, id)) return;
        appendMessage(doc, {
          event: "message",
          thread,
          id,
          role: "notice",
          text: item.text,
          at: new Date(now()).toISOString(),
        });
        appended = true;
      });
      pushEventsToSockets();
      if (appended) notifyPush(thread);
      await forget(item.key);
      return;
    }
    await observeOperation("gateway.app.queue", {}, () => slot.prior, trace);
    if (!state.pending.some((entry) => entry.key === item.key)) return;
    const conversation = await observeOperation("gateway.app.conversation", {},
      () => gateway.conversationFor(sessionForThread(thread), adapterContext), trace);
    trace.setAttributes({ "conversation.id": conversation.id });
    const requestId = requestIdFor(item.key);
    let submissionId: number | undefined;
    let watchStopped = false;
    // Live activity: the run's tool steps, derived from its committed transcript entries and sent
    // as non-durable events whenever they change (protocol v2, "Activity").
    let activityFrom: EntryId | undefined;
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    let activityWork: Promise<void> | undefined;
    let activityDirty = false;
    let activitySent: string | undefined;
    const publishPreview = async (text: string): Promise<void> => {
      if (text.trim() === "" || signal?.aborted) return;
      // A preview must fit one frame; the final message carries the whole answer, so a cut is honest.
      let shown = text;
      let frame = JSON.stringify({ type: "event", event: "preview", thread, key: item.key, text: shown });
      for (let bytes = Buffer.byteLength(frame); bytes > APP_LIMITS.frameBytes && shown.length > 0;
        bytes = Buffer.byteLength(frame)) {
        // Estimate the cut in code units, then recheck the serialized UTF-8 byte count.
        const excessUnits = Math.ceil((bytes - APP_LIMITS.frameBytes) * shown.length / bytes);
        shown = shown.slice(0, Math.max(0, shown.length - Math.max(64, excessUnits)));
        if (shown.length > 0 && /[\uD800-\uDBFF]/u.test(shown.at(-1) ?? "")) shown = shown.slice(0, -1);
        frame = JSON.stringify({ type: "event", event: "preview", thread, key: item.key, text: shown });
      }
      for (const socket of sockets.values()) {
        if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
      }
    };
    const sendActivity = (wire: { steps: AppActivityStep[]; omitted?: number }): void => {
      const signature = JSON.stringify(wire);
      if (signature === activitySent) return;
      activitySent = signature;
      const frame = JSON.stringify({ type: "event", event: "activity", thread, key: item.key, ...wire });
      for (const socket of sockets.values()) {
        if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
      }
    };
    const publishActivity = async (): Promise<void> => {
      const from = activityFrom;
      if (from === undefined || watchStopped || signal?.aborted) return;
      const tally = await readRunActivity(conversation, conversation.id, from, undefined, adapterContext);
      if (watchStopped || signal?.aborted) return;
      const wire = activityForWire(tally, APP_LIMITS.maxActivitySteps);
      if (wire.steps.length > 0) sendActivity(wire);
    };
    const queueActivity = (): void => {
      if (watchStopped || signal?.aborted || activityFrom === undefined) return;
      activityDirty = true;
      if (activityTimer !== undefined || activityWork !== undefined) return;
      activityTimer = setTimeout(() => {
        activityTimer = undefined;
        activityDirty = false;
        activityWork = publishActivity().catch(() => undefined).finally(() => {
          activityWork = undefined;
          if (activityDirty && !watchStopped && !signal?.aborted) queueActivity();
        });
      }, activitySent === undefined ? 0 : ACTIVITY_COALESCE_MS);
      activityTimer.unref?.();
    };
    const stopActivity = async (): Promise<void> => {
      if (activityTimer !== undefined) {
        clearTimeout(activityTimer);
        activityTimer = undefined;
      }
      activityDirty = false;
      await activityWork;
    };
    /**
     * The run's whole step list for the final message: one fresh scan of the run's entries, so a
     * coalesced publish can never leave the answer with fewer steps than the run took.
     */
    const finalActivity = async (
      answer: EntryId,
    ): Promise<{ steps: AppActivityStep[]; omitted?: number } | undefined> => {
      let from = activityFrom;
      if (from === undefined) {
        const record = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), adapterContext);
        from = record?.type === "input" ? record.entry : undefined;
      }
      if (from === undefined) return undefined;
      const tally = await readRunActivity(conversation, conversation.id, from, answer, adapterContext);
      const wire = activityForWire(tally, APP_LIMITS.maxActivitySteps);
      return wire.steps.length === 0 ? undefined : wire;
    };
    const syncStatus = (view: { docs: Record<string, unknown> }, queued = false): void => {
      const live = view.docs["pi.live"] as Parameters<typeof isLiveGenerating>[0];
      const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
      if (live?.run === undefined) {
        broadcastStatus(thread, queued || (inbox?.items?.length ?? 0) > 0 ? "queued" : "idle");
        return;
      }
      broadcastStatus(thread, isLiveGenerating(live) ? "thinking" : "tool");
    };
    const refreshStatus = () => conversation.commit(async (tx) => {
      syncStatus({ docs: {
        "pi.live": await tx.doc(LiveDoc, conversation.id),
        "pi.inbox": await tx.doc(InboxDoc, conversation.id),
      } });
    }, adapterContext);
    // One preview per run: the run's first input owns the single live preview and activity stream.
    const watcher = await createPreviewWatcher({
      conversation,
      context: adapterContext,
      delayMs: PREVIEW_COALESCE_MS,
      publish: publishPreview,
      onFrame(view, frame) {
        syncStatus(view, submissionId === undefined);
        if (!frame.inRun) return;
        // The run's first entry bounds its activity scan; it is kept for the final answer's steps.
        if (frame.live?.run?.first !== undefined) activityFrom = frame.live.run.first as EntryId;
        if (frame.ownsRun) queueActivity();
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const stopPreviewWatch = async (): Promise<void> => {
      if (watchStopped) return;
      watchStopped = true;
      try {
        await watcher.stop();
      } finally {
        await stopActivity();
      }
    };
    try {
      let submission = earlySubmissions.get(item.key);
      earlySubmissions.delete(item.key);
      if (submission === undefined) {
        const whenBusy = await submissionMode(conversation, item);
        // Recheck after the last await before submitting. Archive retires unsubmitted input;
        // a native submission may still settle after archive and must not be submitted again.
        if (threads.archiving(thread) || !openThread(state, thread)) {
          const existing = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), adapterContext);
          if (existing === undefined) return;
          submission = await gateway.harness?.submission(existing.id, adapterContext);
          if (submission === undefined) return;
        } else {
          // The same content shape Telegram submits: text plus labeled metadata, images natively.
          const content = await observeOperation("gateway.app.attachments", {},
            () => files.prepare(item.attachments, item.text, signal), trace);
          await gateway.beforeOwnerInput?.(sessionForThread(thread), conversation.id, content, adapterContext);
          submission = await conversation.submit({
            type: "input", content, requestId, whenBusy,
          }, withTelemetry(trace, adapterContext));
        }
      }
      slot.release();
      submissionId = submission.id;
      watcher.setSubmission(submission.id);
      syncStatus(watcher.value);
      trace.setAttributes({ "submission.id": submission.id });
      const settled = await observeOperation("gateway.app.settlement", { "submission.id": submission.id },
        () => submission.wait(adapterContext), trace);
      trace.setAttributes({ status: settled.status });
      await stopPreviewWatch();
      if (settled.status !== "done" || settled.type !== "input") {
        // A native abort or a queued reset deliberately ends the turn; it is not a failure to report.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        if (!intentional) {
          trace.setStatus({ status: "error" });
          broadcastStatus(thread, "error");
        }
        await settleOne(item, intentional ? "aborted" : "failed");
        await refreshStatus();
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const answerText = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      const text = answerText.trim() === "" ? "The assistant returned no text response." : answerText;
      // The final complete step list goes out before the answer, which carries it too.
      const steps = await finalActivity(settled.answer);
      if (steps !== undefined) sendActivity(steps);
      await settleShared(thread, conversation, settled.answer, text, steps);
      await refreshStatus();
    } finally {
      await stopPreviewWatch();
    }
  };

  /** A failed or aborted settlement settles exactly this key; failures are never grouped by text. */
  const settleOne = async (item: AppPendingInput, outcome: "failed" | "aborted"): Promise<void> => {
    await mutateState((doc) => {
      if (!doc.pending.some((entry) => entry.key === item.key && entry.notice !== true)) return;
      appendEvent(doc, { event: "settled", thread: threadOf(item), key: item.key, outcome });
      doc.pending = doc.pending.filter((entry) => entry.key !== item.key);
    }, cleanupContext);
    deliveryFailures.delete(item.key);
    pushEventsToSockets();
  };

  /**
   * The shared-answer commit: inside one transaction, re-derive every pending input this committed
   * answer settled, append the assistant message once (attributed to the earliest submission's
   * key) and one `settled{answered}` per key, then retire them all. Serialized by the state commit,
   * it is idempotent: a sibling that settles later finds its record already retired and stays
   * silent, and a crash before the commit replays it exactly once.
   */
  const settleShared = async (
    thread: string,
    conversation: Conversation,
    answerEntry: number,
    answerText: string,
    steps?: { steps: AppActivityStep[]; omitted?: number },
  ): Promise<void> => {
    let appended = false;
    await mutateState(async (doc, tx) => {
      const group = await resolveSharedDeliveryGroup(tx, conversation.id, doc.pending
        .filter((candidate) => candidate.notice !== true && threadOf(candidate) === thread)
        .map((candidate) => ({ key: candidate.key, requestId: requestIdFor(candidate.key) })), answerEntry);
      const retired = new Set(group.keys);
      const answerId = thread === APP_MAIN_THREAD ? `answer:${answerEntry}` : `answer:${thread}:${answerEntry}`;
      if (group.keys.length > 0 && !hasEventId(doc, answerId)) {
        rememberAnswer(doc, answerId, thread, answerEntry);
        appendMessage(doc, {
          event: "message",
          thread,
          id: answerId,
          role: "assistant",
          text: answerText,
          at: new Date(now()).toISOString(),
          ...(group.owner === undefined ? {} : { key: group.owner }),
          ...(steps === undefined ? {} : { steps: steps.steps, ...(steps.omitted === undefined ? {} : { omitted: steps.omitted }) }),
        });
        for (const key of group.keys) {
          appendEvent(doc, { event: "settled", thread, key, outcome: "answered" });
        }
        appended = true;
      }
      doc.pending = doc.pending.filter((entry) => !retired.has(entry.key));
      pruneAppControls(doc);
    }, cleanupContext);
    pushEventsToSockets();
    if (appended) notifyPush(thread);
  };

  /** A repeatedly failing delivery is held for inspection, exactly like the other channels. */
  async function holdFailedDelivery(key: string, _error: unknown): Promise<void> {
    const attempts = (deliveryFailures.get(key) ?? 0) + 1;
    deliveryFailures.set(key, attempts);
    if (attempts < MAX_DELIVERY_FAILURES) return;
    deliveryFailures.delete(key);
    await mutateState((doc) => {
      const item = doc.pending.find((entry) => entry.key === key);
      if (item !== undefined) item.held = true;
    }, cleanupContext).catch(() => undefined);
    console.warn(`App delivery for ${key} is held after ${attempts} failure(s); inspect the app channel state.`);
  }

  const forget = async (key: string): Promise<void> => {
    deliveryFailures.delete(key);
    earlySubmissions.delete(key);
    await mutateState((doc) => {
      doc.pending = doc.pending.filter((entry) => entry.key !== key);
      // A delivered terminal report keeps its record (bounded) so a replayed request id is answered
      // from it and never runs the command again.
      const entry = doc.controls.find((item) => item.key === key);
      if (entry !== undefined && (entry.status === "unconfirmed" || entry.status === "refused")) {
        doc.reportedControls = [...(doc.reportedControls ?? []).filter((item) => item !== key), key];
      }
      pruneAppControls(doc);
    }, cleanupContext);
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  async function handleControlFrame(
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    if (thread === undefined || !openThread(state, thread)) return sendError("bad_request");
    if (threads.archiving(thread)) return sendError("not_ready");
    const command = frame.command;
    // Only an absent `args` means none; `null` or any other non-string is malformed.
    const rawArgs = frame.args === undefined ? "" : frame.args;
    if (typeof command !== "string" || typeof rawArgs !== "string" ||
        rawArgs.length > APP_LIMITS.controlArgsChars) {
      sendError("bad_request");
      return;
    }
    if (!offeredCommands.includes(command)) {
      sendError("unsupported");
      return;
    }
    const args = rawArgs.trim();
    const key = thread === APP_MAIN_THREAD ? `c:${frame.id as string}` : `c:${thread}:${frame.id as string}`;
    const sessionKey = sessionForThread(thread);
    const recorded = state.controls.find((entry) => entry.key === key);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of
      // rerunning. While it is still applying here, its own held acknowledgement is the answer.
      const text = await controls.replay(recorded);
      if (text !== undefined) await admitNotice(thread, key, text);
      sendOk();
      drain();
      return;
    }
    // Read-only commands answer with one notice; a refused or malformed one has no effect.
    const notice = async (text: string, limit?: number): Promise<void> => {
      await admitNotice(thread, key, text, limit);
      sendOk();
      drain();
    };
    let mutation: AppControl["command"];
    let option: string | undefined;
    switch (command) {
      case "help": {
        if (args === "") return notice(conversationHelpListing("app", offeredCommands), MAX_LATE_CONTROL_CHARS);
        const requested = args.toLowerCase();
        const found = offeredCommands.includes(requested) ? findConversationCommand(requested) : undefined;
        return notice(found === undefined
          ? `${conversationCommandRefusal("app", requested, offeredCommands)} Nothing was sent to the assistant.`
          : conversationDetailBlock(found, "app"), MAX_LATE_CONTROL_CHARS);
      }
      case "status":
        if (args !== "") return notice(usageNotice("status"));
        return notice(await readStatusNotice(statusHost, sessionKey, "thread", adapterContext));
      case "mcp": {
        const admin = gateway.mcpAdmin;
        if (!capabilities.mcp || admin === undefined) return notice(MCP_UNAVAILABLE_HOST);
        if (args !== "") return notice(usageNotice("mcp"));
        // Read-only status; management itself is the model tool acting for this authenticated thread.
        return notice(renderMcpListing(await admin.list(adapterContext), MAX_NOTICE_CHARS));
      }
      case "model": {
        const argument = parseModelArgument(args);
        // The shared preset-token validator: whatever the hello projection would drop, the control
        // refuses too, instead of accepting names the advertised presets can never include.
        if (argument.kind === "usage" || (argument.kind === "preset" && !validAppPresetName(argument.name))) {
          return notice(usageNotice("model"));
        }
        const listing = await readModelListing(gateway, sessionKey, adapterContext);
        if (argument.kind === "list") {
          return notice(listing === undefined
            ? MODEL_LISTING_UNAVAILABLE
            : renderModelListing(listing, { scope: "thread" }), MAX_LATE_CONTROL_CHARS);
        }
        const refusal = modelPresetRefusal(listing, argument.name);
        if (refusal !== undefined) return notice(refusal);
        mutation = "model";
        option = argument.name;
        break;
      }
      case "digest":
        // Read-only bounded status: no scan, no model call and no cursor change.
        if (args.toLowerCase() === "status") return notice(await renderDigestStatus(gateway, sessionKey, adapterContext));
        if (args !== "") return notice(usageNotice("digest"));
        mutation = "digest";
        break;
      case "restart": {
        if (args !== "") return notice(usageNotice("restart"));
        const refusal = restartRequester.admissionRefusal();
        if (refusal !== undefined) return notice(refusal);
        mutation = "restart";
        break;
      }
      case "new":
      case "abort":
      case "stop":
        if (args !== "") return notice(usageNotice(command));
        // `stop` is an alias of `abort`: the same durable record and effect.
        mutation = command === "stop" ? "abort" : command;
        break;
      default:
        sendError("unsupported");
        return;
    }
    // A mutating control: the visible result arrives later as `message{role:"notice"}`.
    try {
      await controls.admit({
        key, scope: thread, command: mutation, ...(option === undefined ? {} : { option }), earlierKeys: new Set(),
      });
    } catch (error) {
      if (stopped()) return;
      if (error instanceof Error && error.message === QUEUE_FULL) {
        sendError("not_ready");
        return;
      }
      journalEvent("app.control.failed", {}, error);
      sendError("internal");
      return;
    }
    sendOk();
  }

  /** Queue one bounded host notice through the same durable pending queue every reply uses. */
  const admitNotice = async (thread: string, key: string, text: string, limit = MAX_NOTICE_CHARS): Promise<void> => {
    await mutateState((doc) => {
      if (doc.pending.some((entry) => entry.key === key)) return;
      if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
      queueNotice(doc, key, thread, boundNotice(text, limit), now());
    });
    drain();
  };

  /** Rewrite (bounded) and release a still-queued acknowledgement; `undefined` when it is gone. */
  const releaseAck = (doc: Draft<AppChannelState>, key: string, text: string | undefined, limit: number): boolean => {
    const notice = doc.pending.find((item) => item.notice === true && item.key === key);
    if (notice === undefined) return false;
    if (text !== undefined) notice.text = boundNotice(text, limit);
    delete notice.hold;
    return true;
  };

  /** A final outcome after its acknowledgement was already delivered: one fresh notice, if it fits. */
  const queueLate = (doc: Draft<AppChannelState>, record: AppControl, text: string): void => {
    if (doc.pending.some((item) => item.key === record.key)) return;
    if (doc.pending.length >= APP_LIMITS.maxPending) {
      // Even if the late notice cannot fit in the queue, retain the control in reportedControls
      // so pruning cannot delete an unconfirmed /restart record and allow replay to re-run it.
      const existing = doc.reportedControls ?? [];
      if (!existing.includes(record.key)) doc.reportedControls = [...existing, record.key];
      return;
    }
    queueNotice(doc, record.key, record.scope, boundNotice(text, MAX_LATE_CONTROL_CHARS), now());
  };

  const setControlStatus = (doc: Draft<AppChannelState>, key: string, status: AppControlRecord["status"]): void => {
    const entry = doc.controls.find((item) => item.key === key);
    if (entry !== undefined) entry.status = status;
  };

  /** The shared coordinator's durable commits, each one commit of the app state document. */
  const ledger: ControlLedger<string, string, AppControl> = {
    status: (key) => state.controls.find((entry) => entry.key === key)?.status,
    unresolved: () => {
      // A delivered interruption report resolved its record for the owner; it is kept only for replay.
      const reported = new Set(state.reportedControls ?? []);
      return state.controls.filter((entry) => entry.status === "admitted" ||
        (entry.status === "unconfirmed" && !reported.has(entry.key))).length;
    },
    async admit(record, ackText) {
      await mutateState((doc) => {
        // The owner inputs already queued in this thread are placed before the control's effect.
        for (const item of doc.pending) {
          if (item.notice !== true && threadOf(item) === record.scope) record.earlierKeys.add(item.key);
        }
        if (!doc.controls.some((entry) => entry.key === record.key)) {
          doc.controls = [...doc.controls, {
            key: record.key, thread: record.scope, command: record.command,
            ...(record.option === undefined ? {} : { option: record.option }), status: "admitted" as const,
          }];
          pruneAppControls(doc);
        }
        if (!doc.pending.some((entry) => entry.key === record.key)) {
          if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
          queueNotice(doc, record.key, record.scope, ackText, now(), true);
        }
      });
    },
    async markApplied(record) {
      await mutateState((doc) => {
        commitControlApplied(doc, { key: record.key, thread: record.scope, command: record.command },
          new Date(now()).toISOString());
      });
      pushEventsToSockets();
    },
    async release(key, text) {
      await mutateState((doc) => { releaseAck(doc, key, text, MAX_NOTICE_CHARS); }, cleanupContext);
      drain();
    },
    async markRefused(record, text, late) {
      await mutateState((doc) => {
        setControlStatus(doc, record.key, "refused");
        if (!releaseAck(doc, record.key, text, MAX_LATE_CONTROL_CHARS) && late === true) queueLate(doc, record, text);
        pruneAppControls(doc);
      }, cleanupContext);
      drain();
    },
    async markUnconfirmed(key, text, lateRecord) {
      await mutateState((doc) => {
        setControlStatus(doc, key, "unconfirmed");
        if (!releaseAck(doc, key, text, MAX_NOTICE_CHARS) && lateRecord !== undefined) queueLate(doc, lateRecord, text);
      }, cleanupContext);
      drain();
    },
    async publishLate(record, text) {
      await mutateState((doc) => {
        if (!releaseAck(doc, record.key, text, MAX_LATE_CONTROL_CHARS)) queueLate(doc, record, text);
      }, cleanupContext);
      drain();
    },
    async refuse(record, text) {
      await admitNotice(record.scope, record.key, text);
    },
  };

  /**
   * Queue one ordinary notice per recorded restart thread: the live confirmation in a replacement
   * process, or the host-refusal report in the process that stayed up. Threads that do not fit stay owed.
   */
  const admitRestartNotices = (doc: Draft<AppChannelState>, text: string): void => {
    const remaining = admitOwedRestartNotices(doc.restart ?? [], (thread) => {
      if (doc.pending.length >= APP_LIMITS.maxPending) return false;
      queueNotice(doc, `restart:${doc.nextNoticeSeq}`, thread, text, now());
      return true;
    }, (thread) => openThread(doc, thread));
    if (remaining.length > 0) doc.restart = remaining;
    else delete doc.restart;
  };

  /** The one host restart request of this adapter lifetime; a refusal is reported, never retried. */
  const restartRequester = createRestartRequester(options.restart, {
    label: "App",
    onRefused(text) {
      void mutateState((doc) => admitRestartNotices(doc, text), cleanupContext).then(() => {
        if (!stopped()) drain();
      }).catch(() => undefined);
    },
  });

  const controls = createControlCoordinator<string, string, AppControl, AppPendingInput>({
    ledger,
    order,
    flush: {
      inputs: (record) => state.pending.filter((item) => record.earlierKeys.has(item.key)),
      async prepareInput(earlier, record) {
        // Withdrawn or delivered meanwhile, or the thread is closing: nothing to place.
        if (!state.pending.some((item) => item.key === earlier.key) ||
            threads.archiving(record.scope) || !openThread(state, record.scope)) return undefined;
        // Already admitted natively (a live turn stays pending until it settles): it is placed, so it
        // is neither prepared again (no second download or transcription) nor resubmitted.
        const conversation = await gateway.conversationFor(sessionForThread(record.scope), adapterContext);
        const placed = await conversation.commit((tx) =>
          tx.submissionByRequest(conversation.id, requestIdFor(earlier.key)), adapterContext);
        if (placed !== undefined) return undefined;
        // The same full content a normal delivery submits: text plus every stored attachment.
        return files.prepare(earlier.attachments, earlier.text, signal);
      },
      async submit(earlier, content, record) {
        const sessionKey = sessionForThread(record.scope);
        const conversation = await gateway.conversationFor(sessionKey, adapterContext);
        const whenBusy = await submissionMode(conversation, earlier);
        await gateway.beforeOwnerInput?.(sessionKey, conversation.id, content, adapterContext);
        const submission = await conversation.submit({
          type: "input", content: typeof content === "string" ? content : [...content],
          requestId: requestIdFor(earlier.key), whenBusy,
        }, adapterContext);
        // The normal delivery path reuses this turn, so a control-forced input is answered once.
        earlySubmissions.set(earlier.key, submission);
      },
    },
    async execute(record) {
      // An archived or archiving thread never receives a control effect, even one admitted while it
      // was open: manual archive is refused while a control is pending, so this fails closed.
      if (threads.archiving(record.scope) || !openThread(state, record.scope)) {
        return { kind: "refused", text: ARCHIVED_CONTROL_TEXT };
      }
      if (record.command === "new") return applyNewSession(record.scope);
      const outcome = await executeChannelControl(gateway, {
        command: record.command,
        sessionKey: sessionForThread(record.scope),
        ...(record.option === undefined ? {} : { option: record.option }),
      }, adapterContext, { scope: "thread" });
      if (outcome.kind === "applied" && record.command === "model") await pushModelEvents([record.scope]);
      return outcome;
    },
    requestRestart: () => restartRequester.request(),
    onFatal(error) {
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("App control command failed"));
    },
    drain: () => drain(),
    active: () => !stopped(),
    maxUnresolved: APP_LIMITS.maxUnresolvedControls,
  });

  /**
   * `new`: the shared native (or host-paired) reset, plus this channel's question repair. A context
   * boundary retires questions the new context can no longer answer, so a delivery mark lost in a
   * crash is repaired in the right order: before a host reset (which cancels pending questions in
   * its own commit; a failed repair refuses the reset), or in the cancel commit after a plain one.
   */
  async function applyNewSession(thread: string): Promise<ControlOutcome> {
    const sessionKey = sessionForThread(thread);
    const paired = gateway.resetSession !== undefined;
    if (paired && gateway.askSurfaces !== undefined) {
      const repaired = await reconcileThreadQuestions(thread).then(() => true, (error: unknown) => {
        if (!signal?.aborted) journalEvent("app.question.reconcile_failed", {}, error);
        return false;
      });
      if (!repaired) return { kind: "refused", text: RESET_UNREPAIRED };
    }
    const outcome = await executeNewSession(gateway, sessionKey, adapterContext, { busyText: RESET_BUSY });
    if (outcome.kind !== "applied" || gateway.askSurfaces === undefined) return outcome;
    if (paired) {
      // Publishing the host-cancelled questions' final state is not part of the reset's contract,
      // so it never turns an applied reset into a failure.
      await reconcileThreadQuestions(thread).catch((error: unknown) => {
        if (!signal?.aborted) journalEvent("app.question.reconcile_failed", {}, error);
      });
      return outcome;
    }
    const conversation = await gateway.conversationFor(sessionKey, adapterContext);
    let changed = false;
    await mutateState(async (doc, tx) => {
      const questions = await tx.doc(AskQuestionsDoc, conversation.id);
      changed = publishQuestionEvents(doc, questions, thread, now());
      cancelPendingQuestions(questions);
      changed = publishQuestionEvents(doc, questions, thread, now()) || changed;
    });
    if (changed) pushEventsToSockets();
    return outcome;
  }

  // ── Scheduled results and interruption notices ────────────────────────────

  const threadForSession = (sessionKey: string): string | undefined => {
    if (sessionKey === APP_CHAT_SESSION_KEY) return APP_MAIN_THREAD;
    const prefix = `${APP_CHAT_SESSION_KEY}:`;
    if (!sessionKey.startsWith(prefix)) return undefined;
    const thread = sessionKey.slice(prefix.length);
    return thread !== APP_MAIN_THREAD && threadInfo(state, thread) !== undefined ? thread : undefined;
  };
  const hasOrigin = (thread: string): boolean =>
    (thread === APP_MAIN_THREAD ? state.origin : state.sideOrigins?.[thread]) !== undefined;

  /**
   * Publish this thread's question changes the app has not seen yet. The read is where expiry and a
   * crashed delivery settle, so nothing here runs on a timer; the append and the record change share
   * one commit and the durable log (not a live socket) is what the app replays.
   */
  const reconcileThreadQuestions = async (thread: string): Promise<void> => {
    const conversation = await gateway.conversationFor(sessionForThread(thread), adapterContext);
    let changed = false;
    await mutateState(async (doc, tx) => {
      changed = publishQuestionEvents(
        doc, await tx.doc(AskQuestionsDoc, conversation.id), thread, now());
    });
    if (changed) pushEventsToSockets();
  };

  /**
   * The archived-origin room check, read at most once per scan this adapter requests and only when
   * an archived origin has a result waiting: `undefined` means not read yet.
   */
  let snapshotBlocked: boolean | undefined;

  /**
   * The host's durable outbox, drained with the shared bookkeeping (validation, quarantine, the
   * origin hold and bounded concurrency). The app's own send is the event-log append: restoring an
   * archived origin, appending the message and settling the record share one outbox commit, so a
   * stale scan can never append again, even after the original event was trimmed. There is no
   * write-ahead send intent, so nothing here can be left `sending` or `unknown`.
   */
  const outboxDrainer = createOutboxDrainer<string>({
    outbox: gateway.cronOutbox,
    context: adapterContext,
    cleanupContext,
    label: "App",
    maxActive: MAX_SCHEDULED_ACTIVE,
    now,
    active: () => !stopped(),
    decodeSession: threadForSession,
    // Authorization is this channel's own durable admission evidence, never the session string alone.
    authorizeOrigin: (thread) => hasOrigin(thread)
      ? { status: "deliver" }
      : { status: "withheld", reason: "app chat has no durable admission evidence" },
    async admitDispatch(_sessionKey, thread, record) {
      // A capacity-blocked archived origin consumes no dispatch slot — neither for the open-thread
      // cap nor for the snapshot cap: its result waits in the outbox until room exists, and every
      // other thread (main included) keeps flowing.
      // A host interruption notice waits behind a held control acknowledgement in its thread.
      if (isTurnInterruptionNotice(record)) return !heldAcknowledgement(state, thread);
      if (threadInfo(state, thread)?.archived !== true) return true;
      if (!canOpenSideThread(state)) return false;
      if (snapshotBlocked === undefined) {
        const room = gateway.appSnapshotRoom;
        snapshotBlocked = room === undefined ? false
          : !(await stateConversation.commit((tx) => room(tx), adapterContext).catch(() => true));
      }
      return !snapshotBlocked;
    },
    observe: (_sessionKey, _thread, record, run) =>
      observeOperation("gateway.app.scheduled_delivery", { "delivery.id": record.id }, run),
    deliverRecord: (sessionKey, thread, record) => deliverScheduled(sessionKey, thread, record),
  });

  async function deliverScheduled(sessionKey: string, thread: string, record: CronDeliveryRecord): Promise<"kept"> {
    const outbox = gateway.cronOutbox!;
    const id = thread === APP_MAIN_THREAD ? `outbox:${record.id}` : `outbox:${thread}:${record.id}`;
    let restored = false;
    let appended = false;
    await outbox.update(sessionKey, record.id, async (entry, tx) => {
      // Still pending and still this origin; an archive in flight keeps it for the next scan.
      if (entry.status !== "pending" || entry.sessionKey !== sessionKey || threads.archiving(thread)) return;
      const doc = await tx.doc(AppState, stateConversation.id);
      const info = threadInfo(doc, thread);
      if (info === undefined) return;
      const interruption = isTurnInterruptionNotice(entry);
      // Rechecked in the commit: the notice is left pending for the next scan while a held
      // acknowledgement in this thread is still waiting for its control.
      if (interruption && heldAcknowledgement(doc, thread)) return;
      if (!hasEventId(doc, id)) {
        if (!interruption && info.archived) {
          if (!canOpenSideThread(doc) || await gateway.appSnapshotRoom?.(tx) === false) return;
          setArchived(doc, info, new Date(now()).toISOString());
          restored = true;
        }
        if (entry.appAnswerEntry !== undefined) rememberAnswer(doc, id, thread, entry.appAnswerEntry);
        appendMessage(doc, {
          event: "message", id, thread, role: interruption ? "notice" : "assistant",
          text: entry.text, at: new Date(now()).toISOString(),
        });
        appended = true;
      }
      entry.status = "delivered";
      entry.settledAt = now();
      delete entry.error;
    }, cleanupContext);
    await mutateState(() => undefined);
    pushEventsToSockets();
    if (appended) notifyPush(thread);
    if (restored) await gateway.reserveAppThread?.(thread, adapterContext);
    // The record was settled (or left pending) in the commit above.
    return "kept";
  }

  /** Discard unreferenced uploads past their TTL; a failed pass is retried by the next scan. */
  const pruneUploads = async (): Promise<void> => {
    if (!files.available) return;
    await files.prune(now());
  };

  const requestScheduledScan = (): void => {
    if (scheduledScanning || stopped()) return;
    scheduledScanning = true;
    snapshotBlocked = undefined;
    const task = threads.scanIdle().catch((error: unknown) => {
      if (!signal?.aborted) journalEvent("app.auto_archive.failed", {}, error);
    }).then(() => outboxDrainer.scan()).catch(() => undefined).finally(() => {
      scheduledScanning = false;
      active.delete(task);
    });
    active.add(task);
  };

  /** A fresh authenticated admission restores the origin evidence, releasing withheld results. */
  const releaseWithheld = async (thread: string): Promise<void> => {
    if (stopped() || !hasOrigin(thread)) return;
    await outboxDrainer.releaseWithheld(sessionForThread(thread));
  };

  // ── Recovery on open ───────────────────────────────────────────────────────

  // A control recorded but never confirmed may or may not have taken effect: report once, never replay.
  if (state.controls.some((entry) => entry.status === "admitted") || state.pending.some((item) => item.hold === true)) {
    let interrupted = 0;
    await mutateState((doc) => {
      interrupted = recoverInterruptedControls(doc.controls, doc.pending, {
        controlKey: (entry) => entry.key,
        noticeKey: (item) => item.key,
        report(entry, text) {
          if (doc.pending.length >= APP_LIMITS.maxPending) return false;
          queueNotice(doc, entry.key, threadOf(entry), text, now());
          return true;
        },
      });
    }, adapterContext);
    if (interrupted > 0) {
      console.warn(`App ${interrupted} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }

  // A restart this store recorded was requested by the process this one replaced: confirm it is live
  // in every thread that asked, through the same durable notice queue every other notice uses.
  if (state.restart !== undefined && state.restart.length > 0) {
    await mutateState((doc) => admitRestartNotices(doc, RESTART_LIVE), adapterContext);
  }

  const actionHost = createAppActionHost({
    core, files, workspace: options.media?.workspace, threadForSession,
  });

  // The listener opens only after recovery, so no socket can observe pre-recovery state.
  const listener = await startAppListener({
    port: options.port,
    staticRoot: options.staticRoot,
    ...(options.avatarDir === undefined ? {} : { avatarDir: options.avatarDir }),
    host: {
      pairRedeem: (code, label) => devices.pairRedeem(code, label),
      authenticate: (token) => devices.authenticate(token),
      onSocket: (session, hooks) => onSocket(session, hooks),
      upload: (device, request) => files.upload({ deviceId: device.deviceId, ...request }),
      // A shortcut token is its own credential class: only `POST /v1/ask` resolves it.
      ask: (token, request, requestSignal) => devices.ask(token, request, requestSignal),
      // Any paired device may fetch a file once a durable message references it; nothing else.
      download: async (_device, id) => {
        const file = await files.download(id);
        return file === undefined
          ? undefined
          : {
              absolutePath: file.absolutePath, bytes: file.bytes, mimeType: file.mimeType,
              name: file.name, kind: file.kind,
            };
      },
    },
    // A listener that dies takes the channel with it: the supervisor reports gateway.app and the
    // host shuts down, instead of a half-open listener nobody is serving.
    onError: (error) => {
      if (stopping || signal?.aborted) return;
      fatal ??= error instanceof Error ? error : new Error("App listener failed", { cause: error });
      scope.cancel(fatal as Error);
    },
  });
  // Questions admitted before this process started, or whose delivery mark did not survive a
  // crash, are projected once here. Only a thread with durable admission evidence can have asked.
  if (gateway.askSurfaces !== undefined) {
    for (const thread of [APP_MAIN_THREAD, ...(state.threads ?? [])
      .filter((entry) => entry.id !== APP_MAIN_THREAD && !entry.archived).map((entry) => entry.id)]) {
      if (!hasOrigin(thread)) continue;
      // A question projection must never keep the channel from serving other work.
      await reconcileThreadQuestions(thread).catch((error: unknown) => {
        if (!signal?.aborted) journalEvent("app.question.reconcile_failed", {}, error);
      });
    }
  }
  const detachConsole = gateway.appConsole?.attach(devices.console);
  const detachActions = gateway.appActions?.attach(actionHost);
  // A question is delivered by appending its `open` event: this log is the channel's delivery path,
  // so the append is definite and needs none of Telegram's external-send fencing. Only a mapped,
  // open thread is owned; an archived thread has no surface, and the tool then admits nothing.
  const detachAskSurface = gateway.askSurfaces?.attach({
    owns(sessionKey) {
      const target = threadForSession(sessionKey);
      return target !== undefined && openThread(state, target);
    },
    async deliverQuestion(sessionKey, question) {
      const target = threadForSession(sessionKey);
      if (target === undefined || !openThread(state, target)) {
        throw new Error("the app thread is not open");
      }
      await mutateState((doc) => {
        if (!openThread(doc, target)) throw new Error("the app thread is not open");
        const event = openQuestionEvent(target, question);
        appendEvent(doc, event);
        // Recorded now so the append stays known even after retention trims this event.
        const byThread = doc.questionMarks ?? {};
        doc.questionMarks = {
          ...byThread,
          [target]: { ...(byThread[target] ?? {}), [event.id]: questionMarkOf(event) },
        };
      });
      // The commit above is the delivery. A failing live push must not report it as failed: every
      // device replays the same durable event after `hello`.
      try {
        pushEventsToSockets();
      } catch {
        // A closed socket is replaced by its own reconnect and replay.
      }
    },
  });
  // The MCP login owner surface for this adapter's open app threads. The one-time URL leaves as a
  // non-durable `login` frame to the devices streaming right now; a completion is one durable
  // notice. Both are pinned to this attachment, so a restarted adapter's replacement never
  // receives an earlier attempt's URL or outcome.
  const appLoginSurface = gateway.mcpSurfaces === undefined ? undefined : createAppLoginSurface({
    threadFor(sessionKey) {
      if (sessionKey === APP_CHAT_SESSION_KEY) {
        return openThread(state, APP_MAIN_THREAD) ? APP_MAIN_THREAD : undefined;
      }
      const prefix = `${APP_CHAT_SESSION_KEY}:`;
      if (!sessionKey.startsWith(prefix)) return undefined;
      const thread = sessionKey.slice(prefix.length);
      if (parseThreadId(thread) === undefined || thread === APP_MAIN_THREAD) return undefined;
      return openThread(state, thread) ? thread : undefined;
    },
    broadcast(_thread, frame) {
      let delivered = 0;
      for (const socket of sockets.values()) {
        if (!socket.hello || !socket.session.isOpen()) continue;
        socket.session.send(frame);
        delivered += 1;
      }
      return delivered;
    },
    async notice(thread, text) {
      await admitNotice(thread, `mcp-login:${randomBytes(8).toString("hex")}`, text);
    },
  });
  const detachMcpSurface = appLoginSurface === undefined ? undefined : gateway.mcpSurfaces!.attach(appLoginSurface);
  recoveryComplete = true;
  journalEvent("app.serving", { port: listener.port, "queue.depth": state.pending.length });
  options.onListening?.(listener.port);
  drain();
  requestScheduledScan();
  await pruneUploads();
  scanTimer = setInterval(() => {
    failedThisCycle.clear();
    controls.resumeDeferred();
    drain();
    requestScheduledScan();
    void pruneUploads();
  }, scanIntervalMs);
  scanTimer.unref?.();

  try {
    await aborted(signal);
  } finally {
    stopping = true;
    if (scanTimer !== undefined) clearInterval(scanTimer);
    detachConsole?.();
    detachActions?.();
    detachAskSurface?.();
    detachMcpSurface?.();
    for (const socket of sockets.values()) socket.session.close(1001, "stopping");
    sockets.clear();
    scope.cancel(new DOMException("App adapter stopped", "AbortError"));
    await Promise.allSettled([...active, controls.idle(), outboxDrainer.idle()]);
    await push?.close();
    await listener.close().catch(() => undefined);
  }
  if (fatal !== undefined) throw fatal;
}
