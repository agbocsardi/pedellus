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
 * - a mutating control (`new`, `abort`) is admitted with a held acknowledgement and a durable
 *   record before its native call, gates the chat's inputs, and reports applied/refused/unconfirmed
 *   exactly like the Telegram controls;
 * - scheduled cron results and interruption notices arrive through the same channel-neutral
 *   durable outbox, authorized by this channel's own admission evidence and deduplicated by the
 *   outbox record id.
 *
 * No new tool authority exists: the adapter grants nothing. The app chat is denied the MCP login
 * and `ask_user` owner surfaces in phase 1 because protocol v2 defines no event that could carry a
 * one-time authorization URL or a question without persisting it, and persisting such a URL in
 * channel state is forbidden by the other channels' binding contract. A callback-shaped `send` is
 * consumed before admission and never stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defineDoc, AssistantEntry, ConversationBusy, InboxDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, observeOperation } from "../observability.js";
import type { Conversation, ConversationId, EntryId, Harness, Submission, SubmissionId, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FollowUpMode } from "../config.js";
import type { CronDeliveryOutbox, CronDeliveryRecord } from "../automation/cron-delivery.js";
import { CronDeliveryOutboxError } from "../automation/cron-delivery.js";
import { originOccurrencePending } from "../automation/cron.js";
import { looksLikeOAuthCallback } from "../mcp/surface.js";
import { isTurnInterruptionNotice } from "../recovery/interruption.js";
import { inProcessTerminalConversation } from "../terminal/conversation.js";
import { renderBackgroundStatus, type BackgroundStatus } from "../background-status.js";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";
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
import { RESTART_BUSY_MESSAGE, RestartBusyError } from "../restart.js";
import type { GatewayMemoryDigest, GatewayModelList, GatewayModelSelection } from "../runtime.js";
import {
  APP_CLOSE,
  APP_LIMITS,
  APP_MAIN_THREAD,
  APP_PAIR_ALPHABET,
  APP_PROTOCOL_VERSION,
  APP_REQUEST_OPS,
  parseHelloCursor,
  validAppAgentName,
  appPresetInfos,
  validAppLabel,
  validThreadTitle,
  parseThreadId,
  type AppCommandInfo,
  type AppControlRecord,
  type AppMutation,
  type AppDeviceRecord,
  type AppDurableEvent,
  type AppErrorCode,
  type AppPairingRecord,
  type AppPendingInput,
  type AppThreadInfo,
  type AppThreadOrigin,
} from "./app-protocol.js";
import { startAppListener, type AppDeviceSession, type AppSessionHooks } from "./app-listener.js";

/** Preserve the original mapped chat and its history. */
export const APP_CHAT_SESSION_KEY = "app:chat";
export const APP_STATE_SESSION_KEY = `app${CHANNEL_STATE_SESSION_SUFFIX}`;
export const sessionForThread = (thread: string): string =>
  thread === APP_MAIN_THREAD ? APP_CHAT_SESSION_KEY : `${APP_CHAT_SESSION_KEY}:${thread}`;
const threadOf = (record: { readonly thread?: string }): string => record.thread ?? APP_MAIN_THREAD;

const CONTROL_PENDING_NOTICE_MS = 30_000;
const PREVIEW_COALESCE_MS = 700;
const MAX_DELIVERY_FAILURES = 10;
const MAX_CONTROL_ATTEMPTS = 10;
const SCHEDULED_SCAN_INTERVAL_MS = 2_000;
const MAX_SCHEDULED_ACTIVE = 4;
const MAX_NOTICE_CHARS = 1_500;
const DAY_MS = 86_400_000;
/** A fork or first admission would exceed the host's snapshot-slot cap; nothing was created. */
export class AppThreadCapacityError extends Error {}
class ThreadCreateConflict extends Error {}
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

export interface AppGateway {
  readonly harness?: Pick<Harness, "submission">;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
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
  /** Host-authenticated durable outbox for completed cron results and interruption notices. */
  cronOutbox?: CronDeliveryOutbox;
  /** Optional host model catalog for the `status` and `model` controls. */
  listModels?(sessionKey: string, context: Context): Promise<GatewayModelList>;
  selectModelPreset?(sessionKey: string, name: string, context: Context): Promise<GatewayModelSelection>;
  /** Manual memory-digestion entry for `digest` and `digest status`. */
  memoryDigest?: GatewayMemoryDigest;
  /** Optional bounded background snapshot for the `status` control. */
  backgroundStatus?(sessionKey: string, context: Context): Promise<BackgroundStatus>;
  /**
   * Paired reset for `new`: a native reset plus the host's prompt-snapshot rebuild in one
   * operation, refused atomically while a run is live. Absent keeps the plain native reset.
   */
  resetSession?(
    sessionKey: string,
    context: Context,
  ): Promise<import("../runtime.js").GatewaySessionReset>;
  /** Live operator console registry; the running adapter attaches its pairing host here. */
  appConsole?: AppConsoleRegistry;
}

/** Terminal pairing console results, rendered by `src/channels/app-operator-cli.ts`. */
export type AppPairingCreated = { readonly code: string; readonly expiresAtMs: number };
export type AppDeviceListing = {
  readonly label: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
};
export type AppPairingRefusal = "label-in-use" | "device-limit" | "pairing-limit" | "invalid-label";

/** The operator console this adapter serves over the gateway's private local socket. */
export interface AppConsole {
  pair(label?: string): Promise<AppPairingCreated | { readonly refused: AppPairingRefusal }>;
  devices(): Promise<readonly AppDeviceListing[]>;
  revoke(label: string): Promise<"revoked" | "missing" | "invalid-label">;
}

export interface AppConsoleRegistry {
  /** The running adapter attaches its live console; the returned function detaches it. */
  attach(console: AppConsole): () => void;
  console(): AppConsole | undefined;
}

export function createAppConsoleRegistry(): AppConsoleRegistry {
  let live: AppConsole | undefined;
  return {
    attach(host: AppConsole) {
      live = host;
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        if (live === host) live = undefined;
      };
    },
    console: () => live,
  };
}

export type AppRestartHost = {
  readonly supported: boolean;
  /** Called at most once, only after the command's acknowledgement is durable. */
  request(): Promise<void>;
};

export type AppOptions = {
  /** Explicit loopback port from the strict `app` config block; tests may request an ephemeral 0. */
  readonly port: number;
  /** Absolute directory holding the built PWA, served as static files. */
  readonly staticRoot: string;
  readonly autoArchiveDays?: number;
  /** Agent display name sent in every hello reply; 1–40 printable characters. */
  readonly agentName?: string;
  /** Configured owner busy-mode, written onto each admitted input. */
  readonly followUpMode?: FollowUpMode;
  /** Host process replacement for the `restart` control; absent leaves it unoffered. */
  readonly restart?: AppRestartHost;
  /** Controlled clock for offline checks; absent keeps wall time. */
  readonly now?: () => number;
  /** Adapter scan cadence; tests may shorten it. Default 2s, bounds 50ms–60s. */
  readonly scanIntervalMs?: number;
  /** Optional host/test hook with the bound port, fired once when the listener is serving. */
  readonly onListening?: (port: number) => void;
};

type LiveSocket = {
  readonly session: AppDeviceSession;
  hello: boolean;
  /** Highest durable cursor sent on this socket; live pushes continue from here. */
  lastSent: number;
};

type DeferredControl = {
  readonly key: string;
  readonly thread: string;
  readonly command: AppMutation;
  readonly option?: string;
  readonly earlierKeys: ReadonlySet<string>;
};

type ControlOutcome =
  | { readonly kind: "applied"; readonly text?: string; readonly requestRestart?: true }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

type SubmissionSlot = { readonly prior: Promise<void>; release(): void };

/** One durable event without its cursor, distributive over the union. */
type WithoutCursor<T> = T extends { cursor: number } ? Omit<T, "cursor"> : never;
type AppEventInput = WithoutCursor<AppDurableEvent> & { thread: string | AppThreadInfo };

export function threadInfo(doc: AppChannelState, thread: string): AppThreadInfo | undefined {
  return doc.threads?.find((entry) => entry.id === thread);
}

function openThread(doc: AppChannelState, thread: string): boolean {
  return threadInfo(doc, thread)?.archived === false;
}

function canOpenSideThread(doc: AppChannelState): boolean {
  return (doc.threads?.filter((entry) => entry.id !== APP_MAIN_THREAD && !entry.archived).length ?? 0) <
    APP_LIMITS.maxOpenThreads;
}

function setArchived(doc: Draft<AppChannelState>, info: Draft<AppThreadInfo>, at: string, reason?: "manual" | "idle"): void {
  info.archived = reason !== undefined;
  if (reason === undefined) delete info.archivedReason;
  else info.archivedReason = reason;
  // Idle archive does not make an inactive thread more recent than an active one.
  if (reason !== "idle" && info.lastAt < at) info.lastAt = at;
  appendEvent(doc, { event: "thread", thread: { ...info } });
}

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

// ── Pure helpers ─────────────────────────────────────────────────────────────

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time comparison of one presented value against a stored hex digest. */
function sameDigest(presented: string, storedHash: string): boolean {
  const known = Buffer.from(storedHash, "hex");
  const candidate = createHash("sha256").update(presented, "utf8").digest();
  return known.length === candidate.length && timingSafeEqual(known, candidate);
}

function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

function newPairingCode(): string {
  let code = "";
  const bytes = randomBytes(APP_LIMITS.pairCodeChars);
  for (let index = 0; index < APP_LIMITS.pairCodeChars; index += 1) {
    code += APP_PAIR_ALPHABET[bytes[index]! % APP_PAIR_ALPHABET.length]!;
  }
  return code;
}

/** The protocol alphabet without `I`/`O`, matched case-insensitively. */
function validPairingCode(code: string): boolean {
  if (code.length !== APP_LIMITS.pairCodeChars) return false;
  for (const character of code.toUpperCase()) {
    if (!APP_PAIR_ALPHABET.includes(character)) return false;
  }
  return true;
}

function requestIdFor(key: string): string {
  return `app:send:${key}`;
}

/** The run's first input: it identifies the run across tool rounds, which only ever append inputs. */
function firstInput(inputs: readonly SubmissionId[]): SubmissionId | undefined {
  let first = inputs[0];
  for (const id of inputs) if (first === undefined || id < first) first = id;
  return first;
}

function answeredTogether(record: SubmissionRecord, answer: number): boolean {
  return record.type === "input" && record.status === "done" && record.answer === answer;
}

function isConversationBusy(error: unknown): boolean {
  return error instanceof ConversationBusy || (error instanceof Error && error.name === "ConversationBusy");
}

/** `send` key idempotency window: entries are pruned by age only, so the window is really seven days. */
function pruneKeys<T extends { readonly atMs: number }>(keys: readonly T[], nowMs: number): T[] {
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

function appendEvent(doc: Draft<AppChannelState>, event: AppEventInput): void {
  const cursor = doc.nextCursor;
  doc.nextCursor = cursor + 1;
  if (event.event === "message" || event.event === "divider") {
    const info = doc.threads?.find((entry) => entry.id === event.thread);
    if (info !== undefined && info.lastAt < event.at) info.lastAt = event.at;
  }
  doc.events.push({ ...event, cursor });
  pruneEvents(doc);
}

/** Message events carry stable ids, so a replayed or crashed append can be recognized exactly. */
function rememberAnswer(doc: Draft<AppChannelState>, id: string, thread: string, at: number): void {
  if (doc.answerAnchors === undefined) doc.answerAnchors = { [id]: { thread, at } };
  else doc.answerAnchors[id] = { thread, at };
}

function hasEventId(doc: Draft<AppChannelState>, id: string): boolean {
  return doc.events.some((event) => event.event === "message" && event.id === id);
}

/**
 * Keep every unresolved control record, only the most recent applied ones, and a reported terminal
 * record only while its report is still queued — the same bounds the Telegram controls log keeps.
 */
function pruneControls(controls: readonly AppControlRecord[], pending: readonly AppPendingInput[]): AppControlRecord[] {
  const totalApplied = controls.filter((entry) => entry.status === "applied").length;
  let drop = Math.max(0, totalApplied - APP_LIMITS.maxUnresolvedControls);
  const reported = new Set(pending.filter((item) => item.notice === true).map((item) => item.key));
  return controls.filter((entry) => {
    if ((entry.status === "unconfirmed" || entry.status === "refused") && !reported.has(entry.key)) return false;
    if (entry.status !== "applied" || drop === 0) return true;
    drop -= 1;
    return false;
  });
}

const CONTROL_ACK: Record<AppMutation, string> = {
  new: "Context reset.",
  abort: "Idle. Queue cleared.",
  model: "Model selected.",
  restart: "Restart requested; checking active work.",
  digest: "Digest requested.",
};
const CONTROL_PENDING: Record<AppMutation, string> = {
  new: "Reset pending.",
  abort: "Still stopping. New messages are held.",
  model: "Model change pending.",
  restart: "Restart pending.",
  digest: "Digest pending; not started yet.",
};
const UNCONFIRMED_CONTROL = "Command interrupted; outcome unknown. Send it again if needed.";
/** An interrupted restart is never repeated automatically, and resending it is the caller's decision. */
const UNCONFIRMED_RESTART = "Restart interrupted; outcome unknown. Not retried.";
/** The confirmation the replacement process owes the thread that asked for `restart`. */
const RESTART_LIVE = "Restarted.";
/** The host refused the replacement, so this process is still serving. */
const RESTART_FAILED = "Restart refused. Gateway still running.";
const RESTART_ALREADY_REQUESTED =
  "A restart was already requested in this gateway and is still stopping it; this restart was not requested again.";
const RESTART_REQUEST_FAILED =
  "A restart was already requested in this gateway and the host refused it, so the gateway is still running. " +
  "This restart was not requested again; fix the host and start the gateway yourself.";
const MODEL_LISTING_UNAVAILABLE =
  "Model choices are unavailable right now: this chat's host model catalog could not be read. Nothing changed.";
const MODEL_PRESETS_UNAVAILABLE =
  "Named model presets are not configured in this deployment, so /model <name> and /model default are unavailable. " +
  "Nothing was changed; /model lists the current selection read only, and this command never rewrites the configuration.";
/** At most this many configured presets or models in one listing notice. */
const MAX_MODEL_CHOICES = 50;
const CALLBACK_REFUSED_TEXT =
  "This looks like an OAuth callback URL. MCP login cannot be initiated from the app channel, so " +
  "it was not stored and was not sent to the assistant.";
const RESET_BUSY = "Reset refused: chat busy. Abort or retry when idle.";
const ARCHIVED_CONTROL_TEXT =
  "That command was not applied: its thread is archived. Restore the thread first.";

/** Replay wording for a command this adapter recorded before a restart; it is never run twice. */
function replayControlText(entry: AppControlRecord): string {
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

/** Bound one host notice; a shortened notice says so instead of dropping its tail silently. */
function boundNotice(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n… (truncated)";
  let end = Math.max(0, limit - marker.length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

/** One printable, single-line label for host-generated notice text. */
function boundedLabel(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned === "") return "(unnamed)";
  let bounded = cleaned.slice(0, max);
  if (bounded.length > 0 && /[\uD800-\uDBFF]/u.test(bounded[bounded.length - 1]!)) bounded = bounded.slice(0, -1);
  return bounded;
}

/** A fixed usage notice: the catalogue's app line, a no-argument note, and the no-effect tail. */
function usageNotice(name: string): string {
  const argumentsNote = findConversationCommand(name)?.args === undefined ? " (no arguments)." : "";
  return `${conversationCommandUsage(name, "app")}${argumentsNote} Nothing was sent to the assistant.`;
}

type ModelArgument =
  | { readonly kind: "list" }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "usage" };

/** Bound a `model` argument to the shape the config itself accepts: one name, never a selector triple. */
function parseModelArgument(args: string): ModelArgument {
  if (args === "") return { kind: "list" };
  const parts = args.split(/\s+/u);
  if (parts.length !== 1) return { kind: "usage" };
  const name = parts[0]!;
  if (name.length > 80 || !/^[^\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u.test(name)) return { kind: "usage" };
  return { kind: "preset", name };
}

/** The configured preset this thread currently uses, matched by provider/model/thinking. */
function matchingPresetName(listing: GatewayModelList): string | undefined {
  const selected = listing.selected;
  return listing.presets?.find((preset) => preset.provider === selected.provider &&
    preset.modelId === selected.modelId && (preset.thinkingLevel ?? "off") === selected.thinkingLevel)?.name;
}

/** The read-only `model` listing, the same projection Telegram and Discord render. */
function modelListingText(listing: GatewayModelList): string {
  const selectedLine = `Current model: ${boundedLabel(listing.selected.provider, 80)}/` +
    `${boundedLabel(listing.selected.modelId, 160)} (thinking: ${boundedLabel(listing.selected.thinkingLevel, 32)}).`;
  const presets = listing.presets ?? [];
  if (presets.length === 0) {
    const rows = listing.models.slice(0, MAX_MODEL_CHOICES).map((choice) => {
      const current = choice.provider === listing.selected.provider && choice.modelId === listing.selected.modelId;
      const levels = choice.thinkingLevels.map((level) => boundedLabel(level, 32)).join(", ");
      return `  ${current ? "* " : "  "}${boundedLabel(choice.provider, 80)} ${boundedLabel(choice.modelId, 160)} ` +
        `— ${boundedLabel(choice.name, 160)} [thinking: ${levels === "" ? "off" : levels}]`;
    });
    if (listing.models.length > MAX_MODEL_CHOICES) rows.push(`  … ${listing.models.length - MAX_MODEL_CHOICES} more allowed models omitted`);
    return [
      selectedLine,
      "Named model presets are not configured in this deployment, so /model <name> and /model default are " +
        "unavailable here; this command never rewrites the configuration.",
      "Configured direct choices (read only; the direct selection belongs to the local CLI):",
      ...rows,
    ].join("\n");
  }
  const selectedPreset = matchingPresetName(listing);
  const rows = presets.slice(0, MAX_MODEL_CHOICES).map((preset) => {
    const isDefault = preset.name === listing.defaultPreset;
    return `  ${preset.name === selectedPreset ? "* " : "  "}${boundedLabel(preset.name, 80)} — ` +
      `${boundedLabel(preset.provider, 80)} ${boundedLabel(preset.modelId, 160)} ` +
      `[thinking: ${boundedLabel(preset.thinkingLevel ?? "off", 32)}]${isDefault ? " (default)" : ""}`;
  });
  if (presets.length > MAX_MODEL_CHOICES) rows.push(`  … ${presets.length - MAX_MODEL_CHOICES} more named presets omitted`);
  return [
    selectedLine,
    ...(listing.defaultPreset === undefined ? [] : [`Configured default preset: ${boundedLabel(listing.defaultPreset, 80)}.`]),
    "Named model presets (see /help model to select one):",
    ...rows,
    "A selection applies to this thread only and lasts while the gateway stays open; a restart restores the " +
      "configured default and prepared requests keep their model.",
  ].join("\n");
}

/** Why one stored outbox record cannot be delivered as-is, or `undefined` when it is usable. */
function pendingRecordProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "delivery outbox contains an unusable record";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") {
    return "delivery outbox contains an unusable record";
  }
  if (typeof record.status !== "string" || !["pending", "sending", "unknown", "withheld", "delivered", "failed", "unauthorized"].includes(record.status)) {
    return "delivery record has an invalid status";
  }
  if (record.status !== "pending") return undefined;
  if (typeof record.sessionKey !== "string" || record.sessionKey === "") {
    return "delivery record has no origin session";
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return "delivery record has no text";
  }
  return undefined;
}

function outboxFaultMessage(error: unknown): string {
  return error instanceof CronDeliveryOutboxError
    ? "delivery outbox is malformed"
    : "delivery outbox could not be read";
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
  if (options.agentName !== undefined && !validAppAgentName(options.agentName)) {
    throw new Error("App agentName must be 1 to 40 printable characters");
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────

export async function runApp(gateway: AppGateway, options: AppOptions, context: Context): Promise<void> {
  validateOptions(options);
  const now = options.now ?? (() => Date.now());
  const agentName = options.agentName ?? "Durable";
  const scanIntervalMs = options.scanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS;
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
  const submissionChains = new Map<string, Promise<void>>();
  const earlySubmissions = new Map<string, Submission>();
  /** Gate only the chat whose control or archive is in progress. */
  const controlPendingSet = new Set<string>();
  const archiving = new Set<string>();
  const deferredControls = new Map<string, DeferredControl>();
  const controlFailures = new Map<string, number>();
  const runningControls = new Set<string>();
  const pendingControls = new Set<Promise<void>>();
  /** Pairing failures inside the rolling one-minute window; in-memory, so a restart clears it. */
  const pairingFailures: number[] = [];
  const active = new Set<Promise<void>>();
  const activeReplies = new Map<string, number>();
  let activeNotices = 0;
  let fatal: unknown;
  let stopping = false;
  /**
   * Optional host operations, resolved once. A narrow SDK host keeps new, abort/stop and help only;
   * the rest are neither listed in `hello.commands` nor applied.
   */
  const hostCommands: Record<string, boolean> = {
    new: true,
    abort: true,
    stop: true,
    help: true,
    status: typeof gateway.listModels === "function",
    model: typeof gateway.listModels === "function" && typeof gateway.selectModelPreset === "function",
    restart: options.restart?.supported === true,
    digest: typeof gateway.memoryDigest?.start === "function" && typeof gateway.memoryDigest?.status === "function",
  };
  /** The catalogued app commands this host really implements, in catalogue order. */
  const offeredCommands = conversationCommandNames("app").filter((name) => hostCommands[name] === true);
  const commandInfos: AppCommandInfo[] = offeredConversationCommands("app", offeredCommands).map((command) => ({
    name: command.name,
    ...(command.args === undefined ? {} : { args: command.args }),
    summary: command.summary,
    usage: conversationCommandUsage(command.name, "app"),
  }));
  let restartHostRequested = false;
  let restartHostRequestFailed = false;
  let recoveryComplete = false;
  const scheduledActive = new Set<string>();
  const scheduledTasks = new Set<Promise<void>>();
  let scheduledScanning = false;
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  const statuses = new Map<string, string>();

  const mutateState = async (
    change: (doc: Draft<AppChannelState>) => void | Promise<void>,
    commitContext: Context = adapterContext,
  ): Promise<AppChannelState> => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(AppState, stateConversation.id);
      await change(doc);
      return copyJson(doc) as unknown as AppChannelState;
    }, commitContext);
    return state;
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
  async function pushModelEvents(threads: readonly string[], only?: LiveSocket): Promise<void> {
    for (const thread of threads) {
      const listing = await peekModelListing(thread);
      // A thread without a mapped conversation yet runs the configured default preset.
      const preset = listing === undefined ? catalog?.defaultPreset : matchingPresetName(listing);
      if (listing === undefined && catalog === undefined) continue;
      const frame = JSON.stringify({ type: "event", event: "model", thread, preset: preset ?? null });
      for (const socket of only === undefined ? sockets.values() : [only]) {
        if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
      }
    }
  }

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
          await handleSendFrame(frame, sendOk, sendError);
          return;
        case "ack":
          await handleAck(socket, frame, sendOk, sendError);
          return;
        case "control":
          await handleControlFrame(frame, sendOk, sendError);
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
          await createThread(frame, sendOk, sendError);
          return;
        case "thread.rename":
          await renameThread(frame, sendOk, sendError);
          return;
        case "thread.archive":
          await archiveThread(frame, sendOk, sendError);
          return;
        case "ping":
          sendOk();
          return;
        case "history":
        case "tasks":
          sendError("unsupported");
          return;
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
    for (const entry of [APP_MAIN_THREAD, ...(state.threads ?? []).filter((item) => !item.archived).map((item) => item.id)]) {
      if (catalog !== undefined || await peekModelListing(entry) !== undefined) break;
    }
    const presets = appPresetInfos(catalog?.presets);
    if (!socket.session.isOpen()) return;
    socket.hello = true;
    sendOk({
      v: APP_PROTOCOL_VERSION, device: socket.session.label, head: headCursor(), agent: agentName, commands: commandInfos,
      presets,
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

  // ── Thread lifecycle ──────────────────────────────────────────────────────

  async function createThread(
    frame: Record<string, unknown>,
    sendOk: (body: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const key = frame.key;
    const title = frame.title === undefined ? "New thread" : frame.title;
    if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key) || !validThreadTitle(title)) {
      return sendError("bad_request");
    }
    const raw = frame.from;
    let from: AppThreadOrigin | undefined;
    if (raw !== undefined) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return sendError("bad_request");
      const { thread, messageId } = raw as Record<string, unknown>;
      const source = parseThreadId(thread);
      if (source === undefined || typeof messageId !== "string" || messageId.length === 0 || messageId.length > 256) {
        return sendError("bad_request");
      }
      from = { thread: source, messageId };
    }
    const prior = state.createKeys?.find((entry) => entry.key === key);
    if (prior !== undefined) return sendOk({ thread: prior.thread, duplicate: true });
    if (from !== undefined && (!openThread(state, from.thread) || archiving.has(from.thread))) return sendError("bad_request");
    let thread: string;
    do { thread = `t_${randomBytes(18).toString("base64url")}`; } while (threadInfo(state, thread) !== undefined);
    const register = (doc: Draft<AppChannelState>) => {
      if (doc.createKeys?.some((entry) => entry.key === key) || !canOpenSideThread(doc) ||
          threadInfo(doc, thread) !== undefined ||
          (from !== undefined && (!openThread(doc, from.thread) || archiving.has(from.thread)))) {
        throw new ThreadCreateConflict();
      }
      const atMs = now();
      const at = new Date(atMs).toISOString();
      const info = { id: thread, title, archived: false, createdAt: at, lastAt: at, ...(from === undefined ? {} : { origin: from }) };
      doc.threads!.push(info);
      doc.createKeys = pruneKeys([...(doc.createKeys ?? []), { key, atMs, thread }], atMs);
      appendEvent(doc, { event: "thread", thread: { ...info } });
    };
    try {
      if (from === undefined) {
        if (gateway.createAppThread === undefined) await mutateState(register);
        else {
          await gateway.createAppThread(stateConversation.id, thread, register, adapterContext);
          await mutateState(() => undefined);
        }
      } else if (!await gateway.forkAppThread?.(stateConversation.id, thread, from, register, adapterContext)) {
        return sendError("bad_request");
      } else {
        await mutateState(() => undefined);
      }
    } catch (error) {
      if (error instanceof AppThreadCapacityError) return sendError("not_ready");
      if (!(error instanceof ThreadCreateConflict)) throw error;
      const latest = await mutateState(() => undefined);
      const existing = latest.createKeys?.find((entry) => entry.key === key);
      return existing === undefined ? sendError("bad_request") : sendOk({ thread: existing.thread, duplicate: true });
    }
    sendOk({ thread, duplicate: false });
    pushEventsToSockets();
    await pushModelEvents([thread]);
  }

  async function renameThread(
    frame: Record<string, unknown>,
    sendOk: () => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread);
    const title = frame.title;
    if (thread === undefined || thread === APP_MAIN_THREAD || !validThreadTitle(title)) {
      return sendError("bad_request");
    }
    let found = false;
    await mutateState((doc) => {
      const info = threadInfo(doc, thread);
      if (info === undefined) return;
      found = true;
      if (info.title === title) return;
      info.title = title;
      info.lastAt = new Date(now()).toISOString();
      appendEvent(doc, { event: "thread", thread: { ...info } });
    });
    if (!found) return sendError("bad_request");
    sendOk();
    pushEventsToSockets();
  }

  async function archiveThread(
    frame: Record<string, unknown>,
    sendOk: () => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread);
    const archived = frame.archived;
    if (thread === undefined || thread === APP_MAIN_THREAD || typeof archived !== "boolean") {
      return sendError("bad_request");
    }
    const info = threadInfo(state, thread);
    if (info === undefined) return sendError("bad_request");
    if (archiving.has(thread) || controlPendingSet.has(thread)) return sendError("not_ready");
    if (info.archived === archived) return sendOk();
    archiving.add(thread);
    try {
      // Fence app submissions until the abort and archive commit are both complete. Inputs
      // already submitted settle through the native record; never start a turn just to abort it.
      const applied = await submitInOrder(thread, async () => {
        const conversation = archived ? await gateway.conversationFor(sessionForThread(thread), adapterContext) : undefined;
        if (conversation !== undefined) await conversation.abort(adapterContext);
        let changed = false;
        state = await stateConversation.commit(async (tx) => {
          const doc = await tx.doc(AppState, stateConversation.id);
          if (!archived && (!canOpenSideThread(doc) || await gateway.appSnapshotRoom?.(tx) === false)) {
            return copyJson(doc) as unknown as AppChannelState;
          }
          if (conversation !== undefined) {
            const retired = new Set<string>();
            for (const item of doc.pending) {
              if (item.notice === true || threadOf(item) !== thread) continue;
              if (await tx.submissionByRequest(conversation.id, requestIdFor(item.key)) !== undefined) continue;
              appendEvent(doc, { event: "settled", thread, key: item.key, outcome: "aborted" });
              retired.add(item.key);
            }
            doc.pending = doc.pending.filter((item) => !retired.has(item.key));
          }
          const entry = threadInfo(doc, thread)!;
          setArchived(doc, entry, new Date(now()).toISOString(), archived ? "manual" : undefined);
          changed = true;
          return copyJson(doc) as unknown as AppChannelState;
        }, adapterContext);
        return changed;
      });
      if (!applied) return sendError("bad_request");
      if (!archived) await gateway.reserveAppThread?.(thread, adapterContext);
      sendOk();
      pushEventsToSockets();
    } finally {
      archiving.delete(thread);
      drain();
    }
  }

  async function scanIdleThreads(): Promise<void> {
    if (gateway.appThreadBusy === undefined) return;
    const atMs = now();
    const at = new Date(atMs).toISOString();
    const expired = (info: AppThreadInfo) => info.id !== APP_MAIN_THREAD && !info.archived &&
      atMs - Date.parse(info.lastAt) >= archiveAfterMs && !archiving.has(info.id) && !controlPendingSet.has(info.id);
    if (!state.threads?.some(expired)) return;
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(AppState, stateConversation.id);
      for (const info of doc.threads ?? []) {
        if (!expired(info) || doc.pending.some((item) => threadOf(item) === info.id) ||
            await gateway.appThreadBusy!(tx, info.id)) continue;
        setArchived(doc, info, at, "idle");
      }
      return copyJson(doc) as unknown as AppChannelState;
    }, adapterContext);
    pushEventsToSockets();
  }

  // ── Ingress ───────────────────────────────────────────────────────────────

  async function handleSendFrame(
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    if (thread === undefined || !openThread(state, thread)) return sendError("bad_request");
    if (archiving.has(thread)) return sendError("not_ready");
    const key = frame.key;
    const text = frame.text;
    if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key) ||
        typeof text !== "string" || text.length === 0) {
      sendError("bad_request");
      return;
    }
    if (text.length > APP_LIMITS.sendTextChars) {
      sendError("too_large");
      return;
    }
    if (frame.attachments !== undefined) {
      sendError("unsupported");
      return;
    }
    // The first send into a thread creates its mapping and snapshot: reserve that before the
    // admission is acked, so nothing is admitted that the host cannot hold.
    if (state.sendKeys.some((item) => item.key === key) || hasEventId(state, `send:${key}`)) {
      return sendOk({ duplicate: true });
    }
    if (!looksLikeOAuthCallback(text) && gateway.reserveAppThread !== undefined) {
      // Rechecked here, immediately before the reservation, so an archived thread is refused
      // before its snapshot can be reinstalled, whatever awaits are added above this point.
      if (!openThread(state, thread)) return sendError("bad_request");
      let reserved: "ok" | "full";
      try {
        reserved = await gateway.reserveAppThread(thread, adapterContext);
      } catch (error) {
        if (stopping || signal?.aborted) return;
        journalEvent("app.reserve.failed", {}, error);
        sendError("internal");
        return;
      }
      if (reserved === "full") {
        journalEvent("app.send.refused", { reason: "capacity" });
        sendError("not_ready");
        return;
      }
    }
    // Never store callback text. A refused callback still has an idempotent key.
    const callback = looksLikeOAuthCallback(text);
    let duplicate = true;
    let blocked: AppErrorCode | undefined;
    try {
      await mutateState((doc) => {
        if (!openThread(doc, thread)) { blocked = "bad_request"; return; }
        if (archiving.has(thread)) { blocked = "not_ready"; return; }
        if (doc.sendKeys.some((entry) => entry.key === key)) return;
        if (doc.pending.some((entry) => entry.key === key && entry.notice !== true)) return;
        // A key whose echo is still in the log is a duplicate even if its window entry was pruned.
        const eventId = `send:${key}`;
        const callbackId = `notice:callback:${key}`;
        if (hasEventId(doc, eventId) || hasEventId(doc, callbackId)) return;
        if (!callback && doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
        duplicate = false;
        const atMs = now();
        const at = new Date(atMs).toISOString();
        doc.sendKeys = pruneKeys([...doc.sendKeys, { key, atMs }], atMs);
        if (callback) {
          appendEvent(doc, { event: "message", thread, id: callbackId, role: "notice", text: CALLBACK_REFUSED_TEXT, at });
          return;
        }
        appendEvent(doc, { event: "message", thread, id: eventId, role: "user", text, at, key });
        doc.pending.push({
          key, thread, text, admittedAtMs: atMs,
          ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
        });
        if (thread === APP_MAIN_THREAD) doc.origin = { admittedAtMs: atMs };
        else if (doc.sideOrigins === undefined) doc.sideOrigins = { [thread]: { admittedAtMs: atMs } };
        else doc.sideOrigins[thread] = { admittedAtMs: atMs };
      });
    } catch (error) {
      if (stopping || signal?.aborted) return;
      if (error instanceof Error && error.message === QUEUE_FULL) {
        journalEvent("app.send.refused", { reason: "queue-full" });
        sendError("not_ready");
        return;
      }
      journalEvent("app.send.failed", {}, error);
      sendError("internal");
      return;
    }
    if (blocked !== undefined) return sendError(blocked);
    pushEventsToSockets();
    sendOk({ duplicate });
    if (!duplicate && !callback) {
      journalEvent("app.admitted", { "send.key": key, "queue.depth": state.pending.length });
      void releaseWithheld(thread);
      drain();
    }
  }

  // ── Delivery of admitted work ─────────────────────────────────────────────

  const beginSubmission = (thread: string): SubmissionSlot => {
    const prior = submissionChains.get(thread) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    submissionChains.set(thread, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (submissionChains.get(thread) === tail) submissionChains.delete(thread);
      },
    };
  };

  const drain = (): void => {
    if (stopping || signal?.aborted || !recoveryComplete) return;
    for (const item of [...state.pending]) {
      const notice = item.notice === true;
      if (item.hold === true || item.held === true) continue;
      const thread = threadOf(item);
      if (notice ? activeNotices >= 8 : (activeReplies.get(thread) ?? 0) >= 8) continue;
      if (!notice && (controlPendingSet.has(thread) || archiving.has(thread))) continue;
      if (delivering.has(item.key) || failedThisCycle.has(item.key)) continue;
      delivering.add(item.key);
      if (notice) activeNotices += 1;
      else activeReplies.set(thread, (activeReplies.get(thread) ?? 0) + 1);
      const slot = beginSubmission(thread);
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
        if (!stopping && !signal?.aborted) drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: AppPendingInput, slot: SubmissionSlot, trace: TelemetrySpan): Promise<void> => {
    const thread = threadOf(item);
    if (item.notice === true) {
      // Idempotent by the notice's own admission stamp: a redelivery after a crash appends nothing.
      const id = `notice:${item.key}#${item.noticeSeq ?? item.admittedAtMs}`;
      await mutateState((doc) => {
        if (hasEventId(doc, id)) return;
        appendEvent(doc, {
          event: "message",
          thread,
          id,
          role: "notice",
          text: item.text,
          at: new Date(now()).toISOString(),
        });
      });
      pushEventsToSockets();
      await forget(item.key);
      return;
    }
    await observeOperation("gateway.app.queue", {}, () => slot.prior, trace);
    if (!state.pending.some((entry) => entry.key === item.key)) return;
    const conversation = await observeOperation("gateway.app.conversation", {},
      () => gateway.conversationFor(sessionForThread(thread), adapterContext), trace);
    trace.setAttributes({ "conversation.id": conversation.id });
    const requestId = requestIdFor(item.key);
    const watch = await conversation.watch(adapterContext);
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
      }, PREVIEW_COALESCE_MS);
      previewTimer.unref?.();
    };
    const queuePreview = (text: string) => {
      if (watchStopped) return;
      latestPreview = text;
      previewDirty = true;
      schedulePreview();
    };
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
    type LiveView = {
      run?: { inputs?: SubmissionId[] };
      generation?: unknown;
    };
    const syncStatus = (view: { docs: Record<string, unknown> }, queued = false): void => {
      const live = view.docs["pi.live"] as LiveView | undefined;
      const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
      if (live?.run === undefined) {
        broadcastStatus(thread, queued || (inbox?.items?.length ?? 0) > 0 ? "queued" : "idle");
        return;
      }
      const generation = live.generation;
      const generating = generation !== null && typeof generation === "object" &&
        (!("deferred" in (generation as object)) || (generation as { deferred?: unknown }).deferred === undefined) &&
        (!("retry" in (generation as object)) || (generation as { retry?: unknown }).retry === undefined);
      broadcastStatus(thread, generating ? "thinking" : "tool");
    };
    const refreshStatus = () => conversation.commit(async (tx) => {
      syncStatus({ docs: {
        "pi.live": await tx.doc(LiveDoc, conversation.id),
        "pi.inbox": await tx.doc(InboxDoc, conversation.id),
      } });
    }, adapterContext);
    try {
      watch.start(async (call) => {
        // Durable's watches never send Chord's recoverable `failed` call; it ends instead.
        if (call.kind !== "value") return;
        const live = call.value.docs["pi.live"] as LiveView | undefined;
        syncStatus(call.value, submissionId === undefined);
        const inputs = live?.run?.inputs;
        if (submissionId === undefined || inputs === undefined || !inputs.includes(submissionId)) return;
        // One preview per run: the run's first input owns the single live preview.
        if (submissionId !== firstInput(inputs)) return;
        const text = (live as {
          generation?: { message?: { content?: { type: string; text?: string }[] } };
        } | undefined)?.generation?.message?.content
          ?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
        if (text) queuePreview(text);
      });
      let submission = earlySubmissions.get(item.key);
      earlySubmissions.delete(item.key);
      if (submission === undefined) {
        const whenBusy = await submissionMode(conversation, item);
        // Recheck after the last await before submitting. Archive retires unsubmitted input;
        // a native submission may still settle after archive and must not be submitted again.
        if (archiving.has(thread) || !openThread(state, thread)) {
          const existing = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), adapterContext);
          if (existing === undefined) return;
          submission = await gateway.harness?.submission(existing.id, adapterContext);
          if (submission === undefined) return;
        } else {
          submission = await conversation.submit({
            type: "input", content: item.text, requestId, whenBusy,
          }, withTelemetry(trace, adapterContext));
        }
      }
      slot.release();
      submissionId = submission.id;
      syncStatus(watch.value);
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
      await settleShared(thread, conversation, settled.answer, text);
      await refreshStatus();
    } finally {
      await stopPreviewWatch();
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
  ): Promise<void> => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(AppState, stateConversation.id);
      const members: { key: string; submissionId: number }[] = [];
      for (const candidate of doc.pending) {
        if (candidate.notice === true || threadOf(candidate) !== thread) continue;
        const record = await tx.submissionByRequest(conversation.id, requestIdFor(candidate.key));
        if (record !== undefined && answeredTogether(record, answerEntry)) {
          members.push({ key: candidate.key, submissionId: record.id });
        }
      }
      members.sort((left, right) => left.submissionId - right.submissionId || (left.key < right.key ? -1 : 1));
      const retired = new Set(members.map((member) => member.key));
      const answerId = thread === APP_MAIN_THREAD ? `answer:${answerEntry}` : `answer:${thread}:${answerEntry}`;
      if (members.length > 0 && !hasEventId(doc, answerId)) {
        rememberAnswer(doc, answerId, thread, answerEntry);
        appendEvent(doc, {
          event: "message",
          thread,
          id: answerId,
          role: "assistant",
          text: answerText,
          at: new Date(now()).toISOString(),
          ...(members[0] === undefined ? {} : { key: members[0].key }),
        });
        for (const member of members) {
          appendEvent(doc, { event: "settled", thread, key: member.key, outcome: "answered" });
        }
      }
      doc.pending = doc.pending.filter((entry) => !retired.has(entry.key));
      doc.controls = pruneControls(doc.controls, doc.pending);
      return copyJson(doc) as unknown as AppChannelState;
    }, cleanupContext);
    pushEventsToSockets();
  };

  /** A repeatedly failing delivery is held for inspection, exactly like the other channels. */
  async function holdFailedDelivery(key: string, error: unknown): Promise<void> {
    const attempts = (deliveryFailures.get(key) ?? 0) + 1;
    deliveryFailures.set(key, attempts);
    if (attempts < MAX_DELIVERY_FAILURES) return;
    deliveryFailures.delete(key);
    await mutateState((doc) => {
      const item = doc.pending.find((entry) => entry.key === key);
      if (item !== undefined) item.held = true;
    }, cleanupContext).catch(() => undefined);
    console.warn(`App delivery for ${key} is held after ${attempts} failure(s); inspect the app channel state.`);
    void error;
  }

  const forget = async (key: string): Promise<void> => {
    deliveryFailures.delete(key);
    earlySubmissions.delete(key);
    await mutateState((doc) => {
      doc.pending = doc.pending.filter((entry) => entry.key !== key);
      doc.controls = doc.controls.filter((entry) =>
        !(entry.key === key && (entry.status === "unconfirmed" || entry.status === "refused")));
    }, cleanupContext);
  };

  // ── Owner busy-mode ────────────────────────────────────────────────────────

  /** Whether this conversation's current run may take a steer from this channel. */
  const ownerRun = async (conversation: Conversation, thread: string): Promise<boolean> =>
    conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inputs = live.run?.inputs;
      if (inputs === undefined || inputs.length === 0) return false;
      if (await originOccurrencePending(tx, conversation.id)) return false;
      const first = firstInput(inputs);
      for (const candidate of state.pending) {
        if (candidate.notice === true || threadOf(candidate) !== thread) continue;
        const record = await tx.submissionByRequest(conversation.id, requestIdFor(candidate.key));
        if (record?.id === first) return true;
      }
      return false;
    }, adapterContext);

  const submissionMode = async (
    conversation: Conversation,
    current: AppPendingInput,
  ): Promise<"steer" | "followUp"> => {
    if (current.whenBusy !== "steer") return "followUp";
    return (await ownerRun(conversation, threadOf(current))) ? "steer" : "followUp";
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  async function handleControlFrame(
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const thread = parseThreadId(frame.thread === undefined ? APP_MAIN_THREAD : frame.thread);
    if (thread === undefined || !openThread(state, thread)) return sendError("bad_request");
    if (archiving.has(thread)) return sendError("not_ready");
    const command = frame.command;
    const rawArgs = frame.args ?? "";
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
    const recorded = state.controls.find((entry) => entry.key === key);
    if (recorded !== undefined) {
      // While the command is still applying its acknowledgement is still held: a reused request id
      // is simply answered, and the notice the command itself releases remains the visible result.
      // Marking it unconfirmed or releasing the ack here would misreport a live command.
      if (state.pending.some((entry) => entry.key === key && entry.hold === true) || deferredControls.has(key)) {
        sendOk();
        return;
      }
      // The command was durably admitted before its effect, so a replay reports it instead of rerunning.
      if (recorded.status === "admitted") await markControlUnconfirmed(key);
      await admitNotice(thread, key, replayControlText(recorded));
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
    let mutation: AppMutation;
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
        return notice(await statusNotice(thread));
      case "model": {
        const argument = parseModelArgument(args);
        if (argument.kind === "usage") return notice(usageNotice("model"));
        const listing = await readModelListing(thread);
        if (argument.kind === "list") {
          return notice(listing === undefined ? MODEL_LISTING_UNAVAILABLE : modelListingText(listing), MAX_LATE_CONTROL_CHARS);
        }
        if (listing === undefined) return notice(MODEL_LISTING_UNAVAILABLE);
        if (listing.presets === undefined) return notice(MODEL_PRESETS_UNAVAILABLE);
        if (argument.name !== "default" && !listing.presets.some((preset) => preset.name === argument.name)) {
          return notice(`Unknown model preset ${boundedLabel(argument.name, 80)}: nothing was changed. ` +
            "Use /model to list the configured presets.");
        }
        mutation = "model";
        option = argument.name;
        break;
      }
      case "digest":
        // Read-only bounded status: no scan, no model call and no cursor change.
        if (args.toLowerCase() === "status") return notice(await digestStatusNotice(thread));
        if (args !== "") return notice(usageNotice("digest"));
        mutation = "digest";
        break;
      case "restart":
        if (args !== "") return notice(usageNotice("restart"));
        if (restartHostRequested) return notice(restartHostRequestFailed ? RESTART_REQUEST_FAILED : RESTART_ALREADY_REQUESTED);
        mutation = "restart";
        break;
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
      await admitControl(thread, key, mutation, option);
    } catch (error) {
      if (stopping || signal?.aborted) return;
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
      const noticeSeq = doc.nextNoticeSeq;
      doc.nextNoticeSeq = noticeSeq + 1;
      doc.pending.push({
        key,
        thread,
        text: boundNotice(text, limit),
        admittedAtMs: now(),
        notice: true,
        noticeSeq,
      });
    });
    drain();
  };

  async function admitControl(thread: string, key: string, command: AppMutation, option?: string): Promise<void> {
    if (controlPendingSet.has(thread)) {
      await admitNotice(thread, key, "Previous command pending. This command wasn't started; retry later.");
      return;
    }
    if (state.controls.filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length >=
        APP_LIMITS.maxUnresolvedControls) {
      await admitNotice(thread, key,
        `Too many control commands are still unconfirmed (limit ${APP_LIMITS.maxUnresolvedControls}); this ${command} ` +
        "was not started and was not sent to the assistant. Wait for them to finish or restart the gateway.");
      return;
    }
    controlPendingSet.add(thread);
    const earlierKeys = new Set<string>();
    try {
      await mutateState((doc) => {
        for (const item of doc.pending) {
          if (item.notice !== true && threadOf(item) === thread) earlierKeys.add(item.key);
        }
        if (!doc.controls.some((entry) => entry.key === key)) {
          doc.controls = pruneControls([...doc.controls, {
            key, thread, command, ...(option === undefined ? {} : { option }), status: "admitted" as const,
          }], doc.pending);
        }
        if (!doc.pending.some((entry) => entry.key === key)) {
          if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
          const noticeSeq = doc.nextNoticeSeq;
          doc.nextNoticeSeq = noticeSeq + 1;
          doc.pending.push({
            key,
            thread,
            text: CONTROL_ACK[command],
            admittedAtMs: now(),
            notice: true,
            noticeSeq,
            hold: true,
          });
        }
      });
    } catch (error) {
      controlPendingSet.delete(thread);
      throw error;
    }
    const record: DeferredControl = { key, thread, command, ...(option === undefined ? {} : { option }), earlierKeys };
    runningControls.add(thread);
    const run = applyControl(record);
    let ack: "waiting" | "pending" | "applied" | "refused" = "waiting";
    const pendingTimer = setTimeout(() => {
      if (ack !== "waiting") return;
      ack = "pending";
      void releaseControlNotice(key, CONTROL_PENDING[command]).catch(() => undefined);
    }, CONTROL_PENDING_NOTICE_MS);
    pendingTimer.unref?.();
    const task = run.then(async (outcome) => {
      if (outcome.kind === "refused") {
        const wasWaiting = ack === "waiting";
        ack = "refused";
        await markControlRefused(key, outcome.text).catch(() => undefined);
        if (!wasWaiting) await publishLateControlNotice(record.thread, key, outcome.text).catch(() => undefined);
        return;
      }
      if (outcome.kind !== "applied") {
        if (ack !== "waiting") return;
        ack = "pending";
        if (outcome.kind === "deferred") {
          await releaseControlNotice(key, CONTROL_PENDING[command]).catch(() => undefined);
        }
        return;
      }
      if (ack !== "waiting") {
        if (outcome.text !== undefined) {
          await publishLateControlNotice(record.thread, key, outcome.text).catch(() => undefined);
        }
        if (outcome.requestRestart === true) requestRestart();
        return;
      }
      ack = "applied";
      try {
        await releaseControlNotice(key, outcome.text ?? CONTROL_ACK[command]);
      } catch {
        // A failed release leaves the held notice for the next open to report; the command is done.
      }
      if (outcome.requestRestart === true) requestRestart();
    }, (error: unknown) => {
      // The record stays `admitted` and the acknowledgement stays held: a reopen reports unconfirmed.
      if (signal?.aborted) return;
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("App control command failed"));
    }).catch(() => undefined).finally(() => {
      clearTimeout(pendingTimer);
      pendingControls.delete(task);
      runningControls.delete(thread);
      if (!stopping && !signal?.aborted) {
        if (!deferredControls.has(key)) controlPendingSet.delete(thread);
        drain();
      }
    });
    pendingControls.add(task);
    drain();
  }

  /** Apply one recorded control after its earlier inputs were placed, recording the truthful outcome. */
  async function applyControl(record: DeferredControl): Promise<ControlOutcome> {
    // An archived or archiving thread never receives a control effect, even one admitted while it
    // was open: manual archive is refused while a control is pending, so this fails closed.
    if (archiving.has(record.thread) || !openThread(state, record.thread)) {
      return { kind: "refused", text: ARCHIVED_CONTROL_TEXT };
    }
    try {
      for (const earlier of state.pending.filter((item) => record.earlierKeys.has(item.key))) {
        const conversation = await gateway.conversationFor(sessionForThread(record.thread), adapterContext);
        await submitInOrder(record.thread, async () => {
          const whenBusy = await submissionMode(conversation, earlier);
          if (!state.pending.some((item) => item.key === earlier.key) ||
              archiving.has(record.thread) || !openThread(state, record.thread)) return;
          const submission = await conversation.submit({
            type: "input", content: earlier.text, requestId: requestIdFor(earlier.key), whenBusy,
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
      await markControlUnconfirmed(record.key).catch(() => undefined);
      return { kind: "abandoned" };
    }
    let outcome: ControlOutcome;
    if (record.command === "new") {
      outcome = await applyNewSession(record.thread);
    } else if (record.command === "abort") {
      const conversation = await gateway.conversationFor(sessionForThread(record.thread), adapterContext);
      await conversation.abort(adapterContext);
      outcome = { kind: "applied" };
    } else if (record.command === "digest") {
      outcome = await applyDigest(record.thread);
    } else if (record.command === "restart") {
      // No conversation effect: the record and its acknowledgement are durable first, and the host
      // replacement is requested only after that acknowledgement was released.
      outcome = { kind: "applied", text: CONTROL_ACK.restart, requestRestart: true };
    } else {
      outcome = await applyModelPreset(record);
    }
    if (outcome.kind !== "applied") return outcome;
    if (record.command === "model") await pushModelEvents([record.thread]);
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === record.key);
      if (entry !== undefined) entry.status = "applied";
      // The host replaces the process only after this commit, so the owed confirmation is durable first.
      if (record.command === "restart" && entry !== undefined) {
        const owed = doc.restart ?? [];
        if (!owed.includes(record.thread)) doc.restart = [...owed, record.thread].slice(-APP_LIMITS.maxOpenThreads - 1);
      }
      doc.controls = pruneControls(doc.controls, doc.pending);
      // The context boundary the app renders as a durable divider event.
      if (record.command === "new" && !hasEventId(doc, `divider:${record.key}`)) {
        appendEvent(doc, { event: "divider", thread: record.thread, at: new Date(now()).toISOString(), reason: "new" });
      }
    }, adapterContext);
    controlFailures.delete(record.key);
    deferredControls.delete(record.key);
    return outcome;
  }

  /** `new`: a native reset plus, when the host offers it, the prompt-snapshot rebuild. */
  async function applyNewSession(thread: string): Promise<ControlOutcome> {
    const resetSession = gateway.resetSession;
    if (resetSession === undefined) {
      const conversation = await gateway.conversationFor(sessionForThread(thread), adapterContext);
      await conversation.reset(undefined, adapterContext);
      return { kind: "applied" };
    }
    try {
      const result = await resetSession(sessionForThread(thread), adapterContext);
      if (result.status === "busy") return { kind: "refused", text: RESET_BUSY };
      return { kind: "applied" };
    } catch (error) {
      if (isConversationBusy(error)) return { kind: "refused", text: RESET_BUSY };
      throw error;
    }
  }

  /** Retry deferred commands on the adapter's own scan cadence, like the Telegram poll cadence. */
  const resumeDeferredControls = (): void => {
    if (stopping || signal?.aborted) return;
    for (const [key, record] of deferredControls) {
      if (runningControls.has(record.thread)) continue;
      const durable = state.controls.find((entry) => entry.key === key);
      if (durable === undefined || durable.status !== "admitted") {
        deferredControls.delete(key);
        controlFailures.delete(key);
        controlPendingSet.delete(record.thread);
        continue;
      }
      runningControls.add(record.thread);
      const task = applyControl(record).then(async (outcome) => {
        if (outcome.kind === "deferred") return;
        deferredControls.delete(key);
        controlFailures.delete(key);
        if (outcome.kind === "applied") {
          const text = outcome.text ?? CONTROL_ACK[record.command];
          if (state.pending.some((entry) => entry.key === key && entry.hold === true)) {
            await releaseControlNotice(key, text).catch(() => undefined);
          } else {
            await publishLateControlNotice(record.thread, key, text).catch(() => undefined);
          }
          if (outcome.requestRestart === true) requestRestart();
        } else if (outcome.kind === "refused") {
          if (state.pending.some((entry) => entry.key === key && entry.hold === true)) {
            await markControlRefused(key, outcome.text).catch(() => undefined);
          } else {
            await publishLateControlNotice(record.thread, key, outcome.text).catch(() => undefined);
          }
        } else if (outcome.kind === "abandoned") {
          await markControlUnconfirmed(key).catch(() => undefined);
        }
        controlPendingSet.delete(record.thread);
      }, (error: unknown) => {
        if (signal?.aborted) return;
        fatal ??= error;
        scope.cancel(error instanceof Error ? error : new Error("App deferred control failed"));
      }).catch(() => undefined).finally(() => {
        pendingControls.delete(task);
        runningControls.delete(record.thread);
        if (!stopping && !signal?.aborted) drain();
      });
      pendingControls.add(task);
    }
  };

  /** Publish the held acknowledgement, optionally as the still-pending wording. */
  const releaseControlNotice = async (key: string, text?: string): Promise<void> => {
    await mutateState((doc) => {
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice === undefined) return;
      if (text !== undefined) notice.text = text.slice(0, MAX_NOTICE_CHARS);
      delete notice.hold;
    }, cleanupContext);
    drain();
  };

  const markControlUnconfirmed = async (key: string): Promise<void> => {
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === key);
      if (entry !== undefined) entry.status = "unconfirmed";
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice !== undefined) {
        notice.text = UNCONFIRMED_CONTROL;
        delete notice.hold;
      }
    }, adapterContext);
    drain();
  };

  const markControlRefused = async (key: string, text: string): Promise<void> => {
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === key);
      if (entry !== undefined) entry.status = "refused";
      const notice = doc.pending.find((item) => item.notice === true && item.key === key);
      if (notice !== undefined) {
        notice.text = text.slice(0, MAX_NOTICE_CHARS);
        delete notice.hold;
      }
      doc.controls = pruneControls(doc.controls, doc.pending);
    }, cleanupContext);
    drain();
  };

  /** A final outcome published after its "still pending" wording; never loses the only answer. */
  const publishLateControlNotice = async (thread: string, key: string, text: string): Promise<void> => {
    await mutateState((doc) => {
      const notice = doc.pending.find((item) => item.key === key);
      if (notice !== undefined) {
        if (notice.notice === true) {
          notice.text = text.slice(0, MAX_LATE_CONTROL_CHARS);
          delete notice.hold;
        }
        return;
      }
      if (doc.pending.length >= APP_LIMITS.maxPending) return;
      const noticeSeq = doc.nextNoticeSeq;
      doc.nextNoticeSeq = noticeSeq + 1;
      doc.pending.push({
        key,
        thread,
        text: text.slice(0, MAX_LATE_CONTROL_CHARS),
        admittedAtMs: now(),
        notice: true,
        noticeSeq,
      });
    }, cleanupContext);
    drain();
  };

  /** `model <preset>`: the host's per-session preset selection, exactly as Telegram and Discord apply it. */
  async function applyModelPreset(record: DeferredControl): Promise<ControlOutcome> {
    const select = gateway.selectModelPreset;
    if (select === undefined) return { kind: "refused", text: "Model selection is unavailable in this host; nothing was changed." };
    try {
      const selection = await select.call(gateway, sessionForThread(record.thread), record.option ?? "default", adapterContext);
      return {
        kind: "applied",
        text: `Model set to ${boundedLabel(selection.provider, 80)}/${boundedLabel(selection.modelId, 160)} ` +
          `(thinking: ${boundedLabel(selection.thinkingLevel, 32)}) for this thread.`,
      };
    } catch (error) {
      if (isConversationBusy(error)) {
        return { kind: "refused", text: "Model selection refused: thread busy. Abort or retry when idle." };
      }
      return { kind: "refused", text: "Model selection was refused; nothing was changed." };
    }
  }

  /** `digest`: start one bounded digestion batch for this thread's own conversation. */
  async function applyDigest(thread: string): Promise<ControlOutcome> {
    const host = gateway.memoryDigest;
    if (host === undefined) return { kind: "refused", text: "Memory digestion is unavailable in this host. Nothing was started." };
    const conversation = await gateway.conversationFor(sessionForThread(thread), adapterContext);
    const result = await host.start({
      id: conversation.id,
      commit: (change, context) => conversation.commit(change, context),
    }, adapterContext);
    return result.status === "refused"
      ? { kind: "refused", text: renderMemoryDigestStart(result) }
      : { kind: "applied", text: renderMemoryDigestStart(result) };
  }

  /** Bounded read-only `digest status`; it creates no task and reads no chat transcript. */
  async function digestStatusNotice(thread: string): Promise<string> {
    const host = gateway.memoryDigest!;
    const conversation = await gateway.conversationFor(sessionForThread(thread), adapterContext);
    return renderMemoryDigestStatus(await host.status({
      id: conversation.id,
      commit: (change, context) => conversation.commit(change, context),
    }, adapterContext));
  }

  /** Last model catalog seen on a mapped thread; presets are config, so it holds for unmapped threads. */
  let catalog: GatewayModelList | undefined;
  /** Read-only listing: unlike `readModelListing` it never creates a mapping or takes a snapshot slot. */
  async function peekModelListing(thread: string): Promise<GatewayModelList | undefined> {
    if (gateway.listModels === undefined) return undefined;
    try {
      const listing = await gateway.listModels(sessionForThread(thread), adapterContext);
      if (listing.presets !== undefined && listing.presets.length > 0) catalog = listing;
      return listing.presets === undefined || listing.presets.length === 0 ? undefined : listing;
    } catch {
      return undefined;
    }
  }

  /** The host model catalog is per-session, so this thread's mapped conversation must exist first. */
  async function readModelListing(thread: string): Promise<GatewayModelList | undefined> {
    if (gateway.listModels === undefined) return undefined;
    try {
      await gateway.conversationFor(sessionForThread(thread), adapterContext);
      return await gateway.listModels(sessionForThread(thread), adapterContext);
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the host to replace this process, at most once per adapter lifetime. A refusal is a known
   * no-effect, so it is reported to the threads that asked and never upgraded into a success claim.
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
        ? "App /restart was refused while live work is active; the gateway keeps running."
        : "App /restart request was refused by the host; the gateway keeps running.");
      void mutateState((doc) => {
        admitRestartNotices(doc, busy ? RESTART_BUSY_MESSAGE : RESTART_FAILED);
      }, cleanupContext).then(() => {
        if (!stopping && !signal?.aborted) drain();
      }).catch(() => undefined);
    });
  }

  /**
   * Queue one ordinary notice per recorded restart thread: the live confirmation in a replacement
   * process, or the host-refusal report in the process that stayed up. Threads that do not fit stay owed.
   */
  function admitRestartNotices(doc: Draft<AppChannelState>, text: string): void {
    const remaining: string[] = [];
    for (const thread of doc.restart ?? []) {
      if (!openThread(doc, thread)) continue;
      if (doc.pending.length >= APP_LIMITS.maxPending) {
        remaining.push(thread);
        continue;
      }
      const noticeSeq = doc.nextNoticeSeq;
      doc.nextNoticeSeq = noticeSeq + 1;
      doc.pending.push({ key: `restart:${noticeSeq}`, thread, text, admittedAtMs: now(), notice: true, noticeSeq });
    }
    if (remaining.length > 0) doc.restart = remaining;
    else delete doc.restart;
  }

  /** Bounded point-in-time metadata of this chat, exactly the Telegram `/status` projection. */
  async function statusNotice(thread: string): Promise<string> {
    try {
      let listing: import("../runtime.js").GatewayModelList | undefined;
      try {
        await gateway.conversationFor(sessionForThread(thread), adapterContext);
        listing = await gateway.listModels!(sessionForThread(thread), adapterContext);
      } catch {
        listing = undefined;
      }
      const conversation = await gateway.conversationFor(sessionForThread(thread), adapterContext);
      const status = await inProcessTerminalConversation(conversation).status(adapterContext);
      const selection = listing?.selected;
      const model = selection === undefined
        ? (status.model === undefined ? "unknown" : `${status.model.provider}/${status.model.modelId}`)
        : `${selection.provider}/${selection.modelId} (thinking: ${selection.thinkingLevel})`;
      let background: string[] = [];
      try {
        if (typeof gateway.backgroundStatus === "function") {
          background = renderBackgroundStatus(await gateway.backgroundStatus(sessionForThread(thread), adapterContext));
        }
      } catch {
        background = [];
      }
      return [
        "Status for this chat (no model call, no configuration change):",
        `Model: ${model.slice(0, 240)}`,
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

  const submitInOrder = async <T>(thread: string, work: () => Promise<T>): Promise<T> => {
    const slot = beginSubmission(thread);
    try {
      await slot.prior;
      return await work();
    } finally {
      slot.release();
    }
  };

  // ── Pairing, devices and the operator console ─────────────────────────────

  const prunePairings = (doc: Draft<AppChannelState>): void => {
    const nowMs = now();
    doc.pairings = doc.pairings.filter((pairing) => pairing.expiresAtMs > nowMs);
  };

  const labelInUse = (doc: Draft<AppChannelState>, label: string): boolean =>
    doc.devices.some((device) => device.revokedAtMs === undefined && device.label === label) ||
    doc.pairings.some((pairing) => pairing.label === label);

  const consoleHost: AppConsole = {
    async pair(label) {
      const trimmed = label === undefined ? undefined : label.trim();
      if (trimmed !== undefined && !validAppLabel(trimmed)) return { refused: "invalid-label" };
      let created: AppPairingCreated | undefined;
      let refused: AppPairingRefusal | undefined;
      let chosenLabel = "";
      await mutateState((doc) => {
        prunePairings(doc);
        if (doc.devices.filter((device) => device.revokedAtMs === undefined).length >= APP_LIMITS.maxDevices) {
          refused = "device-limit";
          return;
        }
        if (doc.pairings.length >= APP_LIMITS.maxPairings) {
          refused = "pairing-limit";
          return;
        }
        let chosen = trimmed;
        if (chosen === undefined) {
          let index = 1;
          while (labelInUse(doc, `device-${index}`)) index += 1;
          chosen = `device-${index}`;
        } else if (labelInUse(doc, chosen)) {
          refused = "label-in-use";
          return;
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const code = newPairingCode();
          const hash = sha256(code);
          if (doc.pairings.some((pairing) => pairing.codeHash === hash)) continue;
          doc.pairings.push({
            codeHash: hash,
            label: chosen,
            createdAtMs: now(),
            expiresAtMs: now() + APP_LIMITS.pairTtlMs,
          });
          chosenLabel = chosen;
          created = { code, expiresAtMs: now() + APP_LIMITS.pairTtlMs };
          return;
        }
        refused = "pairing-limit";
      });
      if (refused !== undefined) return { refused };
      journalEvent("app.pairing.created", { "pairing.label": chosenLabel });
      return created!;
    },
    async devices() {
      return state.devices
        .map((device) => ({
          label: device.label,
          createdAtMs: device.createdAtMs,
          ...(device.revokedAtMs === undefined ? {} : { revokedAtMs: device.revokedAtMs }),
        }))
        .sort((left, right) => left.createdAtMs - right.createdAtMs);
    },
    async revoke(label) {
      if (!validAppLabel(label)) return "invalid-label";
      let revokedId: string | undefined;
      await mutateState((doc) => {
        const entry = doc.devices.find((device) => device.revokedAtMs === undefined && device.label === label);
        if (entry === undefined) return;
        entry.revokedAtMs = now();
        revokedId = entry.id;
      });
      if (revokedId === undefined) return "missing";
      const socket = sockets.get(revokedId);
      if (socket !== undefined) socket.session.close(APP_CLOSE.unauthorized, "revoked");
      journalEvent("app.device.revoked", { "device.label": label });
      return "revoked";
    },
  };

  /** Rolling failure window for `POST /v1/pair`; in-memory, so a restart clears it. */
  const countPairingFailure = (): void => {
    const nowMs = now();
    while (pairingFailures.length > 0 && nowMs - pairingFailures[0]! >= APP_LIMITS.pairRateWindowMs) {
      pairingFailures.shift();
    }
    pairingFailures.push(nowMs);
  };

  const pairingRateLimited = (): boolean => {
    const nowMs = now();
    while (pairingFailures.length > 0 && nowMs - pairingFailures[0]! >= APP_LIMITS.pairRateWindowMs) {
      pairingFailures.shift();
    }
    return pairingFailures.length > APP_LIMITS.pairRateMax;
  };

  async function pairRedeem(code: string, label: string): Promise<
    | { readonly status: "created"; readonly token: string }
    | { readonly status: "bad-request" }
    | { readonly status: "invalid" }
    | { readonly status: "rate-limited" }
  > {
    if (pairingRateLimited()) return { status: "rate-limited" };
    if (!validPairingCode(code) || !validAppLabel(label)) {
      countPairingFailure();
      return { status: "bad-request" };
    }
    let token: string | undefined;
    await mutateState((doc) => {
      prunePairings(doc);
      const pairing = doc.pairings.find((entry) => sameDigest(code.toUpperCase(), entry.codeHash));
      if (pairing === undefined) return;
      if (pairing.label !== undefined && pairing.label !== label) return;
      if (doc.devices.some((device) => device.revokedAtMs === undefined && device.label === label)) return;
      if (doc.devices.filter((device) => device.revokedAtMs === undefined).length >= APP_LIMITS.maxDevices) return;
      // Single use: the code is consumed exactly when the device record is created.
      doc.pairings = doc.pairings.filter((entry) => !sameDigest(code.toUpperCase(), entry.codeHash));
      token = newDeviceToken();
      doc.devices.push({
        id: randomBytes(16).toString("hex"),
        label,
        tokenHash: sha256(token),
        createdAtMs: now(),
      });
    });
    if (token === undefined) {
      countPairingFailure();
      return { status: "invalid" };
    }
    journalEvent("app.device.paired", { "device.label": label });
    return { status: "created", token };
  }

  const authenticate = async (token: string): Promise<{ deviceId: string; label: string } | undefined> => {
    if (token.length === 0 || token.length > 256) return undefined;
    const device = state.devices.find((entry) =>
      entry.revokedAtMs === undefined && sameDigest(token, entry.tokenHash));
    return device === undefined ? undefined : { deviceId: device.id, label: device.label };
  };

  // ── Scheduled results and interruption notices ────────────────────────────

  const outbox = gateway.cronOutbox;
  const threadForSession = (sessionKey: string): string | undefined => {
    if (sessionKey === APP_CHAT_SESSION_KEY) return APP_MAIN_THREAD;
    const prefix = `${APP_CHAT_SESSION_KEY}:`;
    if (!sessionKey.startsWith(prefix)) return undefined;
    const thread = sessionKey.slice(prefix.length);
    return thread !== APP_MAIN_THREAD && threadInfo(state, thread) !== undefined ? thread : undefined;
  };
  const hasOrigin = (thread: string): boolean =>
    (thread === APP_MAIN_THREAD ? state.origin : state.sideOrigins?.[thread]) !== undefined;

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

  const deliverScheduled = async (sessionKey: string, record: CronDeliveryRecord): Promise<void> => {
    if (outbox === undefined) return;
    const thread = threadForSession(sessionKey);
    if (record.sessionKey !== sessionKey || thread === undefined) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "failed";
        entry.settledAt = now();
        entry.error = "outbox session does not match its origin";
      }, cleanupContext);
      return;
    }
    if (record.text.trim() === "") {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "failed";
        entry.settledAt = now();
        entry.error = "delivery text is empty";
      }, cleanupContext);
      return;
    }
    // Authorization is this channel's own durable admission evidence, never the session string alone.
    if (!hasOrigin(thread)) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "withheld";
        entry.withheldSince = now();
        entry.error = "app chat has no durable admission evidence";
      }, cleanupContext);
      console.warn(`App scheduled delivery withheld for ${record.id}: no durable origin admission evidence.`);
      return;
    }
    const id = thread === APP_MAIN_THREAD ? `outbox:${record.id}` : `outbox:${thread}:${record.id}`;
    // The restore, event append and settlement share a commit. Replaying a stale scan cannot
    // append again, even after the original event has been trimmed.
    let restored = false;
    await outbox.update(sessionKey, record.id, async (entry, tx) => {
      if (entry.status !== "pending" || entry.sessionKey !== sessionKey || archiving.has(thread)) return;
      const doc = await tx.doc(AppState, stateConversation.id);
      const info = threadInfo(doc, thread);
      if (info === undefined) return;
      if (!hasEventId(doc, id)) {
        const interruption = isTurnInterruptionNotice(entry);
        if (!interruption && info.archived) {
          if (!canOpenSideThread(doc) || await gateway.appSnapshotRoom?.(tx) === false) return;
          setArchived(doc, info, new Date(now()).toISOString());
          restored = true;
        }
        if (entry.appAnswerEntry !== undefined) rememberAnswer(doc, id, thread, entry.appAnswerEntry);
        appendEvent(doc, {
          event: "message", id, thread, role: interruption ? "notice" : "assistant",
          text: entry.text, at: new Date(now()).toISOString(),
        });
      }
      entry.status = "delivered";
      entry.settledAt = now();
      delete entry.error;
    }, cleanupContext);
    await mutateState(() => undefined);
    pushEventsToSockets();
    if (restored) await gateway.reserveAppThread?.(thread, adapterContext);
  };

  const scanScheduled = async (): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted) return;
    // Snapshot room is read once per scan, lazily and only when an archived origin needs it.
    let snapshotBlocked: boolean | undefined;
    for (const { sessionKey } of await outbox.sessions(adapterContext)) {
      if (stopping || signal?.aborted) return;
      if (threadForSession(sessionKey) === undefined) continue;
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
                entry.settledAt = now();
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
        // A capacity-blocked archived origin consumes no dispatch slot — neither for the
        // open-thread cap nor for the snapshot cap: its result waits in the outbox until
        // room exists, and every other thread (main included) keeps flowing.
        const originThread = threadForSession(sessionKey);
        if (!isTurnInterruptionNotice(record) && originThread !== undefined &&
            threadInfo(state, originThread)?.archived === true) {
          if (!canOpenSideThread(state)) continue;
          if (snapshotBlocked === undefined) {
            snapshotBlocked = gateway.appSnapshotRoom === undefined ? false
              : !(await stateConversation.commit((tx) => gateway.appSnapshotRoom!(tx), adapterContext)
                .catch(() => true));
          }
          if (snapshotBlocked) continue;
        }
        const deliveryKey = JSON.stringify([sessionKey, record.id]);
        if (record.status !== "pending" || scheduledActive.has(deliveryKey)) continue;
        if (scheduledActive.size >= MAX_SCHEDULED_ACTIVE) return;
        scheduledActive.add(deliveryKey);
        const task = Promise.resolve()
          .then(() => observeOperation("gateway.app.scheduled_delivery", { "delivery.id": record.id },
            () => deliverScheduled(sessionKey, record)))
          .catch(() => {
            // Keep the durable record pending; the next scan retries it.
          })
          .finally(() => {
            scheduledActive.delete(deliveryKey);
            scheduledTasks.delete(task);
          });
        scheduledTasks.add(task);
      }
    }
  };

  const requestScheduledScan = (): void => {
    if (scheduledScanning || stopping || signal?.aborted) return;
    scheduledScanning = true;
    const task = scanIdleThreads().catch((error: unknown) => {
      if (!signal?.aborted) journalEvent("app.auto_archive.failed", {}, error);
    }).then(scanScheduled).catch(() => undefined).finally(() => {
      scheduledScanning = false;
      active.delete(task);
    });
    active.add(task);
  };

  /** A fresh authenticated admission restores the origin evidence, releasing withheld results. */
  const releaseWithheld = async (thread: string): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted || !hasOrigin(thread)) return;
    const sessionKey = sessionForThread(thread);
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

  // ── Recovery on open ───────────────────────────────────────────────────────

  // A control recorded but never confirmed may or may not have taken effect: report once, never replay.
  const unresolved = state.controls.filter((entry) => entry.status === "admitted");
  const heldNotices = state.pending.some((item) => item.hold === true);
  if (unresolved.length > 0 || heldNotices) {
    await mutateState((doc) => {
      for (const entry of doc.controls) {
        if (entry.status !== "admitted") continue;
        const interrupted = entry.command === "restart" ? UNCONFIRMED_RESTART : UNCONFIRMED_CONTROL;
        const notice = doc.pending.find((item) => item.notice === true && item.key === entry.key);
        if (notice !== undefined) {
          if (notice.hold === true) notice.text = interrupted;
          delete notice.hold;
          entry.status = "unconfirmed";
          continue;
        }
        if (doc.pending.length >= APP_LIMITS.maxPending) continue;
        const noticeSeq = doc.nextNoticeSeq;
        doc.nextNoticeSeq = noticeSeq + 1;
        doc.pending.push({
          key: entry.key,
          thread: threadOf(entry),
          text: interrupted,
          admittedAtMs: now(),
          notice: true,
          noticeSeq,
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
      console.warn(`App ${unresolved.length} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }

  // A restart this store recorded was requested by the process this one replaced: confirm it is live
  // in every thread that asked, through the same durable notice queue every other notice uses.
  if (state.restart !== undefined && state.restart.length > 0) {
    await mutateState((doc) => admitRestartNotices(doc, RESTART_LIVE), adapterContext);
  }

  // The listener opens only after recovery, so no socket can observe pre-recovery state.
  const listener = await startAppListener({
    port: options.port,
    staticRoot: options.staticRoot,
    host: {
      pairRedeem: (code, label) => pairRedeem(code, label),
      authenticate: (token) => authenticate(token),
      onSocket: (session, hooks) => onSocket(session, hooks),
    },
    // A listener that dies takes the channel with it: the supervisor reports gateway.app and the
    // host shuts down, instead of a half-open listener nobody is serving.
    onError: (error) => {
      if (stopping || signal?.aborted) return;
      fatal ??= error instanceof Error ? error : new Error("App listener failed", { cause: error });
      scope.cancel(fatal as Error);
    },
  });
  const detachConsole = gateway.appConsole?.attach(consoleHost);
  recoveryComplete = true;
  journalEvent("app.serving", { port: listener.port, "queue.depth": state.pending.length });
  options.onListening?.(listener.port);
  drain();
  requestScheduledScan();
  scanTimer = setInterval(() => {
    failedThisCycle.clear();
    resumeDeferredControls();
    drain();
    requestScheduledScan();
  }, scanIntervalMs);
  scanTimer.unref?.();

  try {
    await aborted(signal);
  } finally {
    stopping = true;
    if (scanTimer !== undefined) clearInterval(scanTimer);
    detachConsole?.();
    for (const socket of sockets.values()) socket.session.close(1001, "stopping");
    sockets.clear();
    scope.cancel(new DOMException("App adapter stopped", "AbortError"));
    await Promise.allSettled([...active, ...pendingControls, ...scheduledTasks]);
    await listener.close().catch(() => undefined);
  }
  if (fatal !== undefined) throw fatal;
}
