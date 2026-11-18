/**
 * The `app` channel adapter: a third opt-in owner surface next to Telegram, Discord and the CLI.
 *
 * It serves an installable web app (PWA) over one loopback HTTP+WebSocket listener that
 * `tailscale serve` publishes on the tailnet, and speaks wire protocol v1 exactly as normative in
 * the sibling `durable-app` repository. One host-derived session key (`app:chat`) is shared by every
 * paired device; the gateway validates it as an ordinary mapped chat, so all existing authority,
 * tool policy, cron and memory rules apply unchanged.
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
 * and `ask_user` owner surfaces in phase 1 because protocol v1 defines no event that could carry a
 * one-time authorization URL or a question without persisting it, and persisting such a URL in
 * channel state is forbidden by the other channels' binding contract. A callback-shaped `send` is
 * consumed before admission and never stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defineDoc, AssistantEntry, ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import type { Context, Draft } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal, withTelemetry } from "@earendil-works/chord/context";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { journalEvent, observeOperation } from "../observability.js";
import type { Conversation, Submission, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
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
  APP_CLOSE,
  APP_LIMITS,
  APP_LATER_COMMANDS,
  APP_PAIR_ALPHABET,
  APP_PROTOCOL_VERSION,
  APP_REQUEST_OPS,
  parseHelloCursor,
  validAppLabel,
  type AppControlRecord,
  type AppDeviceRecord,
  type AppDurableEvent,
  type AppErrorCode,
  type AppPairingRecord,
  type AppPendingInput,
} from "./app-protocol.js";
import { startAppListener, type AppDeviceSession, type AppSessionHooks } from "./app-listener.js";

/** The one mapped ordinary chat every paired device shares. Host-derived, never model input. */
export const APP_CHAT_SESSION_KEY = "app:chat";
const APP_STATE_SESSION_KEY = `app${CHANNEL_STATE_SESSION_SUFFIX}`;

const CONTROL_PENDING_NOTICE_MS = 30_000;
const PREVIEW_COALESCE_MS = 700;
const MAX_DELIVERY_FAILURES = 10;
const MAX_CONTROL_ATTEMPTS = 10;
const SCHEDULED_SCAN_INTERVAL_MS = 2_000;
const MAX_SCHEDULED_ACTIVE = 4;
const MAX_NOTICE_CHARS = 1_500;
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
  /** Durable admission evidence for this channel's one chat, set by the first authenticated input. */
  origin?: { readonly admittedAtMs: number };
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
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /** Host-authenticated durable outbox for completed cron results and interruption notices. */
  cronOutbox?: CronDeliveryOutbox;
  /** Optional host model catalog for the `status` control's model line. */
  listModels?(sessionKey: string, context: Context): Promise<import("../runtime.js").GatewayModelList>;
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

export type AppOptions = {
  /** Explicit loopback port from the strict `app` config block; tests may request an ephemeral 0. */
  readonly port: number;
  /** Absolute directory holding the built PWA, served as static files. */
  readonly staticRoot: string;
  /** Configured owner busy-mode, written onto each admitted input. */
  readonly followUpMode?: FollowUpMode;
  /** Controlled clock for offline checks; absent keeps wall time. */
  readonly now?: () => number;
  /** Optional host/test hook with the bound port, fired once when the listener is serving. */
  readonly onListening?: (port: number) => void;
};

type LiveSocket = {
  readonly session: AppDeviceSession;
  hello: boolean;
  /** Highest durable cursor sent on this socket; live pushes continue from here. */
  lastSent: number;
};

type DeferredControl = { readonly key: string; readonly command: "new" | "abort" };

type ControlOutcome =
  | { readonly kind: "applied"; readonly text?: string }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "deferred" }
  | { readonly kind: "abandoned" };

type SubmissionSlot = { readonly prior: Promise<void>; release(): void };

/** One durable event without its cursor, distributive over the union. */
type AppEventInput =
  | Omit<Extract<AppDurableEvent, { event: "message" }>, "cursor">
  | Omit<Extract<AppDurableEvent, { event: "settled" }>, "cursor">
  | Omit<Extract<AppDurableEvent, { event: "divider" }>, "cursor">;

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
function pruneSendKeys(
  keys: readonly { readonly key: string; readonly atMs: number }[],
  nowMs: number,
): { readonly key: string; readonly atMs: number }[] {
  return keys.filter((entry) => nowMs - entry.atMs < APP_LIMITS.sendKeyTtlMs);
}

/** Trim the durable event log: acknowledged events first, then the hard cap keeps the newest. */
function pruneEvents(doc: Draft<AppChannelState>): void {
  let floor = doc.floor;
  const activeAcks = doc.devices
    .filter((device) => device.revokedAtMs === undefined)
    .map((device) => doc.acks[device.id])
    .filter((ack): ack is number => typeof ack === "number" && Number.isSafeInteger(ack) && ack > 0);
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
  doc.events.push({ ...event, cursor } as AppDurableEvent);
  pruneEvents(doc);
}

/** Message events carry stable ids, so a replayed or crashed append can be recognized exactly. */
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

const CONTROL_ACK: Record<"new" | "abort", string> = {
  new: "Context reset.",
  abort: "Idle. Queue cleared.",
};
const CONTROL_PENDING: Record<"new" | "abort", string> = {
  new: "Reset pending.",
  abort: "Still stopping. New messages are held.",
};
const UNCONFIRMED_CONTROL = "Command interrupted; outcome unknown. Send it again if needed.";
const CALLBACK_REFUSED_TEXT =
  "This looks like an OAuth callback URL. MCP login cannot be initiated from the app channel, so " +
  "it was not stored and was not sent to the assistant.";
const RESET_BUSY = "Reset refused: chat busy. Abort or retry when idle.";
const STATUS_UNAVAILABLE_HOST =
  "Status is unavailable in this host: it exposes no model/status metadata for this chat. Nothing was sent to the assistant.";

/** Replay wording for a command this adapter recorded before a restart; it is never run twice. */
function replayControlText(entry: AppControlRecord): string {
  if (entry.status === "applied") return "That command was already applied before a restart, so it was not run again.";
  if (entry.status === "refused") {
    return "That command was refused before any effect and will not be retried; send it again if it is still needed.";
  }
  if (entry.status === "unconfirmed") {
    return "That command was already reported as interrupted; send it again if you still need it.";
  }
  return UNCONFIRMED_CONTROL;
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
}

// ── The adapter ──────────────────────────────────────────────────────────────

export async function runApp(gateway: AppGateway, options: AppOptions, context: Context): Promise<void> {
  validateOptions(options);
  const now = options.now ?? (() => Date.now());
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const cleanupContext = withoutAbortSignal(adapterContext);
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;

  const stateConversation = await gateway.conversationFor(APP_STATE_SESSION_KEY, context);
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(AppState, stateConversation.id)) as unknown as AppChannelState,
  context);
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
  /** This chat is gated while one of its control commands is applying or deferred. */
  const controlPendingSet = new Set<string>();
  const deferredControls = new Map<string, DeferredControl>();
  const controlFailures = new Map<string, number>();
  const controlChains: Promise<void>[] = [];
  const pendingControls = new Set<Promise<void>>();
  /** Pairing failures inside the rolling one-minute window; in-memory, so a restart clears it. */
  const pairingFailures: number[] = [];
  const active = new Set<Promise<void>>();
  let activeReplies = 0;
  let activeNotices = 0;
  let fatal: unknown;
  let stopping = false;
  let recoveryComplete = false;
  const scheduledActive = new Set<string>();
  const scheduledTasks = new Set<Promise<void>>();
  let scheduledScanning = false;
  let scanTimer: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;

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
    JSON.stringify({ type: "event", ...event } as Record<string, unknown>);

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

  const headCursor = (): number | null => (state.events.length === 0 ? null : state.events.at(-1)!.cursor);

  const broadcastStatus = (stateValue: string): void => {
    if (lastStatus === stateValue) return;
    lastStatus = stateValue;
    const frame = JSON.stringify({ type: "event", event: "status", state: stateValue });
    for (const socket of sockets.values()) {
      if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
    }
  };

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
      void handleFrame(live, frame).catch(() => undefined);
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
          await handleSendFrame(socket, frame, sendOk, sendError);
          return;
        case "ack":
          await handleAck(socket, frame, sendOk, sendError);
          return;
        case "control":
          await handleControlFrame(socket, frame, sendOk, sendError);
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
    socket.hello = true;
    sendOk({ v: APP_PROTOCOL_VERSION, device: socket.session.label, head: headCursor() });
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
      socket.session.send(JSON.stringify({ type: "event", event: "status", state: lastStatus ?? "idle" }));
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

  // ── Ingress ───────────────────────────────────────────────────────────────

  async function handleSendFrame(
    socket: LiveSocket,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
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
    // A callback-shaped body is consumed before admission; neither its text nor its values are stored.
    if (looksLikeOAuthCallback(text)) {
      const eventId = `notice:callback:${key}`;
      await mutateState((doc) => {
        if (hasEventId(doc, eventId)) return;
        appendEvent(doc, {
          event: "message",
          id: eventId,
          role: "notice",
          text: CALLBACK_REFUSED_TEXT,
          at: new Date(now()).toISOString(),
        });
      });
      pushEventsToSockets();
      sendOk({ duplicate: false });
      return;
    }
    let duplicate = true;
    try {
      await mutateState((doc) => {
        if (doc.sendKeys.some((entry) => entry.key === key)) return;
        if (doc.pending.some((entry) => entry.key === key && entry.notice !== true)) return;
        // A key whose echo is still in the log is a duplicate even if its window entry was pruned.
        if (hasEventId(doc, `send:${key}`)) return;
        if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
        duplicate = false;
        appendEvent(doc, {
          event: "message",
          id: `send:${key}`,
          role: "user",
          text,
          at: new Date(now()).toISOString(),
          key,
        });
        doc.pending.push({
          key,
          text,
          admittedAtMs: now(),
          ...(admittedWhenBusy === undefined ? {} : { whenBusy: admittedWhenBusy }),
        });
        doc.sendKeys = pruneSendKeys([...doc.sendKeys, { key, atMs: now() }], now());
        doc.origin = { admittedAtMs: now() };
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
    pushEventsToSockets();
    sendOk({ duplicate });
    if (!duplicate) {
      journalEvent("app.admitted", { "send.key": key, "queue.depth": state.pending.length });
      void releaseWithheld();
      drain();
    }
  }

  // ── Delivery of admitted work ─────────────────────────────────────────────

  const beginSubmission = (): SubmissionSlot => {
    const prior = submissionChains.get(APP_CHAT_SESSION_KEY) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    submissionChains.set(APP_CHAT_SESSION_KEY, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (submissionChains.get(APP_CHAT_SESSION_KEY) === tail) submissionChains.delete(APP_CHAT_SESSION_KEY);
      },
    };
  };

  const drain = (): void => {
    if (stopping || signal?.aborted || !recoveryComplete) return;
    for (const item of [...state.pending]) {
      const notice = item.notice === true;
      if (item.hold === true || item.held === true) continue;
      if (notice ? activeNotices >= 8 : activeReplies >= 8) continue;
      if (!notice && controlPendingSet.has(APP_CHAT_SESSION_KEY)) continue;
      if (delivering.has(item.key) || failedThisCycle.has(item.key)) continue;
      delivering.add(item.key);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = beginSubmission();
      const task = observeOperation("gateway.app.delivery", {
        "send.key": item.key, notice, "queue.depth": state.pending.length,
        attempt: (deliveryFailures.get(item.key) ?? 0) + 1,
      }, (trace) => deliver(item, slot, trace)).catch(async (error: unknown) => {
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

  const deliver = async (item: AppPendingInput, slot: SubmissionSlot, trace: TelemetrySpan): Promise<void> => {
    if (item.notice === true) {
      // Idempotent by the notice's own admission stamp: a redelivery after a crash appends nothing.
      const id = `notice:${item.key}#${item.noticeSeq ?? item.admittedAtMs}`;
      await mutateState((doc) => {
        if (hasEventId(doc, id)) return;
        appendEvent(doc, {
          event: "message",
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
    const conversation = await observeOperation("gateway.app.conversation", {},
      () => gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext), trace);
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
      // Shrinking by the escaped-JSON overshoot keeps the tail-safe prefix inside the frame bound.
      let shown = text;
      let frame = JSON.stringify({ type: "event", event: "preview", key: item.key, text: shown });
      while (frame.length > APP_LIMITS.frameBytes && shown.length > 0) {
        const overshoot = frame.length - APP_LIMITS.frameBytes;
        shown = shown.slice(0, Math.max(0, shown.length - Math.max(64, Math.ceil(overshoot * 1.2))));
        if (shown.length > 0 && /[\uD800-\uDBFF]/u.test(shown.at(-1) ?? "")) shown = shown.slice(0, -1);
        frame = JSON.stringify({ type: "event", event: "preview", key: item.key, text: shown });
      }
      for (const socket of sockets.values()) {
        if (socket.hello && socket.session.isOpen()) socket.session.send(frame);
      }
    };
    type LiveView = {
      run?: { inputs?: SubmissionId[] };
      generation?: unknown;
    };
    const syncStatus = (live: LiveView | undefined): void => {
      if (submissionId === undefined) {
        broadcastStatus("queued");
        return;
      }
      const inputs = live?.run?.inputs;
      if (live === undefined || inputs === undefined || !inputs.includes(submissionId)) {
        broadcastStatus("queued");
        return;
      }
      const generation = live.generation;
      const generating = generation !== null && typeof generation === "object" &&
        (!("deferred" in (generation as object)) || (generation as { deferred?: unknown }).deferred === undefined) &&
        (!("retry" in (generation as object)) || (generation as { retry?: unknown }).retry === undefined);
      broadcastStatus(generating ? "thinking" : "tool");
    };
    try {
      watch.start(async (call) => {
        // Durable's watches never send Chord's recoverable `failed` call; it ends instead.
        if (call.kind !== "value") return;
        const live = call.value.docs["pi.live"] as LiveView | undefined;
        syncStatus(live);
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
      const early = earlySubmissions.get(item.key);
      earlySubmissions.delete(item.key);
      const submission = early ?? await conversation.submit({
        type: "input",
        content: item.text,
        requestId,
        whenBusy: await submissionMode(conversation, item),
      }, withTelemetry(trace, adapterContext));
      slot.release();
      submissionId = submission.id;
      syncStatus(watch.value.docs["pi.live"] as LiveView | undefined);
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
          broadcastStatus("error");
          await appendSettled(item.key, "failed");
        } else {
          await appendSettled(item.key, "aborted");
        }
        await forget(item.key);
        broadcastStatus("idle");
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const answerText = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      const text = answerText.trim() === "" ? "The assistant returned no text response." : answerText;
      await settleShared(conversation, settled.answer, text);
      broadcastStatus("idle");
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
  const appendSettled = async (key: string, outcome: "failed" | "aborted"): Promise<void> => {
    await mutateState((doc) => {
      if (!doc.pending.some((entry) => entry.key === key && entry.notice !== true)) return;
      appendEvent(doc, { event: "settled", key, outcome });
    });
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
    conversation: Conversation,
    answerEntry: number,
    answerText: string,
  ): Promise<void> => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(AppState, stateConversation.id);
      const members: { key: string; submissionId: number }[] = [];
      for (const candidate of doc.pending) {
        if (candidate.notice === true) continue;
        const record = await tx.submissionByRequest(conversation.id, requestIdFor(candidate.key));
        if (record !== undefined && answeredTogether(record, answerEntry)) {
          members.push({ key: candidate.key, submissionId: record.id });
        }
      }
      members.sort((left, right) => left.submissionId - right.submissionId || (left.key < right.key ? -1 : 1));
      const retired = new Set(members.map((member) => member.key));
      const group = doc.pending.filter((entry) => retired.has(entry.key));
      if (group.length > 0 && !hasEventId(doc, `answer:${answerEntry}`)) {
        appendEvent(doc, {
          event: "message",
          id: `answer:${answerEntry}`,
          role: "assistant",
          text: answerText,
          at: new Date(now()).toISOString(),
          ...(members[0] === undefined ? {} : { key: members[0].key }),
        });
        for (const member of members) {
          appendEvent(doc, { event: "settled", key: member.key, outcome: "answered" });
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
  const ownerRun = async (conversation: Conversation): Promise<boolean> =>
    conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inputs = live.run?.inputs;
      if (inputs === undefined || inputs.length === 0) return false;
      if (await originOccurrencePending(tx, conversation.id)) return false;
      const first = firstInput(inputs);
      for (const candidate of state.pending) {
        if (candidate.notice === true) continue;
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
    return (await ownerRun(conversation)) ? "steer" : "followUp";
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  async function handleControlFrame(
    socket: LiveSocket,
    frame: Record<string, unknown>,
    sendOk: (body?: Record<string, unknown>) => void,
    sendError: (error: AppErrorCode) => void,
  ): Promise<void> {
    const command = frame.command;
    if (typeof command !== "string") {
      sendError("bad_request");
      return;
    }
    if (APP_LATER_COMMANDS.includes(command)) {
      sendError("unsupported");
      return;
    }
    if (command !== "new" && command !== "abort" && command !== "status") {
      sendError("bad_request");
      return;
    }
    const key = `c:${frame.id as string}`;
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
      await admitNotice(key, replayControlText(recorded));
      sendOk();
      drain();
      return;
    }
    if (command === "status") {
      if (typeof gateway.listModels !== "function") {
        await admitNotice(key, STATUS_UNAVAILABLE_HOST);
      } else {
        await admitNotice(key, await statusNotice());
      }
      sendOk();
      drain();
      return;
    }
    // A mutating control: the visible result arrives later as `message{role:"notice"}`.
    try {
      await admitControl(key, command);
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
  const admitNotice = async (key: string, text: string, hold = false): Promise<void> => {
    await mutateState((doc) => {
      if (doc.pending.some((entry) => entry.key === key)) return;
      if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
      const noticeSeq = doc.nextNoticeSeq;
      doc.nextNoticeSeq = noticeSeq + 1;
      doc.pending.push({
        key,
        text: text.slice(0, MAX_NOTICE_CHARS),
        admittedAtMs: now(),
        notice: true,
        noticeSeq,
        ...(hold ? { hold: true } : {}),
      });
    });
    if (!hold) drain();
  };

  async function admitControl(key: string, command: "new" | "abort"): Promise<void> {
    if (controlPendingSet.has(APP_CHAT_SESSION_KEY) || deferredControls.size > 0) {
      await admitNotice(key, "Previous command pending. This command wasn't started; retry later.");
      return;
    }
    if (state.controls.filter((entry) => entry.status === "admitted" || entry.status === "unconfirmed").length >=
        APP_LIMITS.maxUnresolvedControls) {
      await admitNotice(key,
        `Too many control commands are still unconfirmed (limit ${APP_LIMITS.maxUnresolvedControls}); this ${command} ` +
        "was not started and was not sent to the assistant. Wait for them to finish or restart the gateway.");
      return;
    }
    controlPendingSet.add(APP_CHAT_SESSION_KEY);
    try {
      await mutateState((doc) => {
        if (!doc.controls.some((entry) => entry.key === key)) {
          doc.controls = pruneControls([...doc.controls, { key, command, status: "admitted" as const }], doc.pending);
        }
        if (!doc.pending.some((entry) => entry.key === key)) {
          if (doc.pending.length >= APP_LIMITS.maxPending) throw new Error(QUEUE_FULL);
          const noticeSeq = doc.nextNoticeSeq;
          doc.nextNoticeSeq = noticeSeq + 1;
          doc.pending.push({
            key,
            text: CONTROL_ACK[command],
            admittedAtMs: now(),
            notice: true,
            noticeSeq,
            hold: true,
          });
        }
      });
    } catch (error) {
      controlPendingSet.delete(APP_CHAT_SESSION_KEY);
      throw error;
    }
    const record: DeferredControl = { key, command };
    const prior = controlChains.at(-1) ?? Promise.resolve();
    const run = prior.then(() => applyControl(record));
    let ack: "waiting" | "pending" | "applied" | "refused" = "waiting";
    const pendingTimer = setTimeout(() => {
      if (ack !== "waiting") return;
      ack = "pending";
      void releaseControlNotice(key, CONTROL_PENDING[command]).catch(() => undefined);
    }, CONTROL_PENDING_NOTICE_MS);
    pendingTimer.unref?.();
    const chain = run.then(() => undefined, () => undefined);
    controlChains.push(chain);
    const task = run.then(async (outcome) => {
      if (outcome.kind === "refused") {
        const wasWaiting = ack === "waiting";
        ack = "refused";
        await markControlRefused(key, outcome.text).catch(() => undefined);
        if (!wasWaiting) await publishLateControlNotice(key, outcome.text).catch(() => undefined);
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
          await publishLateControlNotice(key, outcome.text).catch(() => undefined);
        }
        return;
      }
      ack = "applied";
      try {
        await releaseControlNotice(key, outcome.text ?? CONTROL_ACK[command]);
      } catch {
        // A failed release leaves the held notice for the next open to report; the command is done.
      }
    }, (error: unknown) => {
      // The record stays `admitted` and the acknowledgement stays held: a reopen reports unconfirmed.
      if (signal?.aborted) return;
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("App control command failed"));
    }).catch(() => undefined).finally(() => {
      clearTimeout(pendingTimer);
      pendingControls.delete(task);
      const index = controlChains.indexOf(chain);
      if (index >= 0) controlChains.splice(index, 1);
      if (!stopping && !signal?.aborted) {
        if (!deferredControls.has(key)) controlPendingSet.delete(APP_CHAT_SESSION_KEY);
        drain();
      }
    });
    pendingControls.add(task);
    drain();
  }

  /** Apply one recorded control after its earlier inputs were placed, recording the truthful outcome. */
  async function applyControl(record: DeferredControl): Promise<ControlOutcome> {
    try {
      // While the command is gated every non-notice record predates it, so all of them are flushed.
      for (const earlier of state.pending.filter((item) => item.notice !== true)) {
        const conversation = await gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext);
        await submitInOrder(async () => {
          const submission = await conversation.submit({
            type: "input",
            content: earlier.text,
            requestId: requestIdFor(earlier.key),
            whenBusy: await submissionMode(conversation, earlier),
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
      outcome = await applyNewSession();
    } else {
      const conversation = await gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext);
      await conversation.abort(adapterContext);
      outcome = { kind: "applied" };
    }
    if (outcome.kind !== "applied") return outcome;
    await mutateState((doc) => {
      const entry = doc.controls.find((item) => item.key === record.key);
      if (entry !== undefined) entry.status = "applied";
      doc.controls = pruneControls(doc.controls, doc.pending);
      // The context boundary the app renders as a durable divider event.
      if (record.command === "new" && !hasEventId(doc, `divider:${record.key}`)) {
        appendEvent(doc, { event: "divider", at: new Date(now()).toISOString(), reason: "new" });
      }
    }, adapterContext);
    controlFailures.delete(record.key);
    deferredControls.delete(record.key);
    return outcome;
  }

  /** `new`: a native reset plus, when the host offers it, the prompt-snapshot rebuild. */
  async function applyNewSession(): Promise<ControlOutcome> {
    const resetSession = gateway.resetSession;
    if (resetSession === undefined) {
      const conversation = await gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext);
      await conversation.reset(undefined, adapterContext);
      return { kind: "applied" };
    }
    try {
      const result = await resetSession(APP_CHAT_SESSION_KEY, adapterContext);
      if (result.status === "busy") return { kind: "refused", text: RESET_BUSY };
      return { kind: "applied" };
    } catch (error) {
      if (isConversationBusy(error)) return { kind: "refused", text: RESET_BUSY };
      throw error;
    }
  }

  /** Retry deferred commands on the adapter's own scan cadence, like the Telegram poll cadence. */
  const resumeDeferredControls = (): void => {
    if (stopping || signal?.aborted || controlChains.length > 0) return;
    for (const [key, record] of [...deferredControls]) {
      const durable = state.controls.find((entry) => entry.key === key);
      if (durable === undefined || durable.status !== "admitted") {
        deferredControls.delete(key);
        controlFailures.delete(key);
        controlPendingSet.delete(APP_CHAT_SESSION_KEY);
        continue;
      }
      const run = Promise.resolve().then(() => applyControl(record));
      const chain = run.then(() => undefined, () => undefined);
      controlChains.push(chain);
      const task = run.then(async (outcome) => {
        deferredControls.delete(key);
        controlFailures.delete(key);
        if (outcome.kind === "applied") {
          const text = outcome.text ?? CONTROL_ACK[record.command];
          if (state.pending.some((entry) => entry.key === key && entry.hold === true)) {
            await releaseControlNotice(key, text).catch(() => undefined);
          } else {
            await publishLateControlNotice(key, text).catch(() => undefined);
          }
        } else if (outcome.kind === "refused") {
          if (state.pending.some((entry) => entry.key === key && entry.hold === true)) {
            await markControlRefused(key, outcome.text).catch(() => undefined);
          } else {
            await publishLateControlNotice(key, outcome.text).catch(() => undefined);
          }
        } else if (outcome.kind === "abandoned") {
          await markControlUnconfirmed(key).catch(() => undefined);
        }
        controlPendingSet.delete(APP_CHAT_SESSION_KEY);
      }, (error: unknown) => {
        if (signal?.aborted) return;
        fatal ??= error;
        scope.cancel(error instanceof Error ? error : new Error("App deferred control failed"));
      }).catch(() => undefined).finally(() => {
        pendingControls.delete(task);
        const index = controlChains.indexOf(chain);
        if (index >= 0) controlChains.splice(index, 1);
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
  const publishLateControlNotice = async (key: string, text: string): Promise<void> => {
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
        text: text.slice(0, MAX_LATE_CONTROL_CHARS),
        admittedAtMs: now(),
        notice: true,
        noticeSeq,
      });
    }, cleanupContext);
    drain();
  };

  /** Bounded point-in-time metadata of this chat, exactly the Telegram `/status` projection. */
  async function statusNotice(): Promise<string> {
    try {
      let listing: import("../runtime.js").GatewayModelList | undefined;
      try {
        await gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext);
        listing = await gateway.listModels!(APP_CHAT_SESSION_KEY, adapterContext);
      } catch {
        listing = undefined;
      }
      const conversation = await gateway.conversationFor(APP_CHAT_SESSION_KEY, adapterContext);
      const status = await inProcessTerminalConversation(conversation).status(adapterContext);
      const selection = listing?.selected;
      const model = selection === undefined
        ? (status.model === undefined ? "unknown" : `${status.model.provider}/${status.model.modelId}`)
        : `${selection.provider}/${selection.modelId} (thinking: ${selection.thinkingLevel})`;
      let background: string[] = [];
      try {
        if (typeof gateway.backgroundStatus === "function") {
          background = renderBackgroundStatus(await gateway.backgroundStatus(APP_CHAT_SESSION_KEY, adapterContext));
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

  const submitInOrder = async <T>(work: () => Promise<T>): Promise<T> => {
    const slot = beginSubmission();
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
    if (record.sessionKey !== sessionKey || sessionKey !== APP_CHAT_SESSION_KEY) {
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
    if (state.origin === undefined) {
      await updateScheduled(sessionKey, record.id, (entry) => {
        entry.status = "withheld";
        entry.withheldSince = now();
        entry.error = "app chat has no durable admission evidence";
      }, cleanupContext);
      console.warn(`App scheduled delivery withheld for ${record.id}: no durable origin admission evidence.`);
      return;
    }
    const id = `outbox:${record.id}`;
    // The dedupe and the append share one commit, like the notice path: a crash between them can
    // never duplicate the event, and a concurrent scan finds the id already in the log.
    await mutateState((doc) => {
      if (hasEventId(doc, id)) return;
      appendEvent(doc, {
        event: "message",
        id,
        role: isTurnInterruptionNotice(record) ? "notice" : "assistant",
        text: record.text,
        at: new Date(now()).toISOString(),
      });
    });
    pushEventsToSockets();
    await updateScheduled(sessionKey, record.id, (entry) => {
      entry.status = "delivered";
      entry.settledAt = now();
      delete entry.error;
    }, cleanupContext);
  };

  const scanScheduled = async (): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted) return;
    for (const { sessionKey } of await outbox.sessions(adapterContext)) {
      if (stopping || signal?.aborted) return;
      if (sessionKey !== APP_CHAT_SESSION_KEY) continue;
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
        if (record.status !== "pending" || scheduledActive.has(record.id)) continue;
        if (scheduledActive.size >= MAX_SCHEDULED_ACTIVE) return;
        scheduledActive.add(record.id);
        const task = Promise.resolve()
          .then(() => observeOperation("gateway.app.scheduled_delivery", { "delivery.id": record.id },
            () => deliverScheduled(sessionKey, record)))
          .catch(() => {
            // Keep the durable record pending; the next scan retries it.
          })
          .finally(() => {
            scheduledActive.delete(record.id);
            scheduledTasks.delete(task);
          });
        scheduledTasks.add(task);
      }
    }
  };

  const requestScheduledScan = (): void => {
    if (scheduledScanning || stopping || signal?.aborted) return;
    scheduledScanning = true;
    void scanScheduled().catch(() => undefined).finally(() => { scheduledScanning = false; });
  };

  /** A fresh authenticated admission restores the origin evidence, releasing withheld results. */
  const releaseWithheld = async (): Promise<void> => {
    if (outbox === undefined || stopping || signal?.aborted || state.origin === undefined) return;
    let records: readonly unknown[];
    try {
      records = await outbox.list(APP_CHAT_SESSION_KEY, adapterContext);
    } catch {
      return;
    }
    let released = false;
    for (const value of records) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as { id?: unknown; status?: unknown };
      if (record.status !== "withheld" || typeof record.id !== "string" || record.id === "") continue;
      try {
        await updateScheduled(APP_CHAT_SESSION_KEY, record.id, (entry) => {
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
        const notice = doc.pending.find((item) => item.notice === true && item.key === entry.key);
        if (notice !== undefined) {
          if (notice.hold === true) notice.text = UNCONFIRMED_CONTROL;
          delete notice.hold;
          entry.status = "unconfirmed";
          continue;
        }
        if (doc.pending.length >= APP_LIMITS.maxPending) continue;
        const noticeSeq = doc.nextNoticeSeq;
        doc.nextNoticeSeq = noticeSeq + 1;
        doc.pending.push({
          key: entry.key,
          text: UNCONFIRMED_CONTROL,
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
  }, SCHEDULED_SCAN_INTERVAL_MS);
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
