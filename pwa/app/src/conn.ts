import {
  CLOSE,
  LIMITS,
  MAIN_THREAD,
  PROTOCOL_VERSION,
  parseActivitySteps,
  parseDurableEvent,
  parsePresets,
  parseThreadInfo,
  validAgentName,
  type CommandInfo,
  type ControlCommand,
  type Event as ServerEvent,
  type PushSubscriptionInfo,
  type Reaction,
  type QuestionOptionId,
  type Request,
  type ResponseMap,
  type ThreadId,
  type ThreadInfo,
} from "./protocol";
import type { Outgoing, Store, ThreadCreate } from "./store";
import { releaseUpload, uploadLocal } from "./uploads";

type Op = Request["op"];
type RequestOf<O extends Op> = Extract<Request, { op: O }>;
/** A reply handler; `undefined` means the stream closed before the reply arrived. */
type Handler<O extends Op> = (res?: ResponseMap[O]) => void | Promise<void>;
type AnyReply = ResponseMap[Op];

/** What the connection tells the layer above it; it never navigates on its own. */
export type ConnectionEvents = {
  /** A `thread.create` sent from `from` was accepted as `thread`. */
  onThreadCreated?: (thread: ThreadId, from: ThreadId) => void;
};

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/**
 * Defensive cap on one incoming frame, in UTF-16 units. Far above `LIMITS.frameBytes` on purpose:
 * records stored before the gateway split long messages replay unchanged and may be larger, and
 * closing on them would trap the device in a reconnect loop. `frameBytes` still bounds what the
 * app sends and what the gateway produces today.
 */
const SERVER_FRAME_MAX_CHARS = 16 * 1024 * 1024;

/**
 * One WebSocket to same-origin /v1/stream. Owns hello/replay/ack, pings,
 * backoff reconnects and the close-code reactions (4401 pairing, 4426 update,
 * 4409 replaced). The store is the state; this class only moves it.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<string, (res?: AnyReply) => void | Promise<void>>();
  private attempt = 0;
  private sending = new Set<string>();
  private creating = new Set<string>();
  /** Send keys whose files are uploading; one upload pass per key at a time. */
  private uploading = new Set<string>();
  private uploadRetryAt = new Map<string, number>();
  private uploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingWatch: ReturnType<typeof setTimeout> | undefined;
  private replaying = false;
  private replayCount = 0;
  private replayCursor: number | null = null;
  /** The cursor the current replay batch was requested from; a re-hello must move past it. */
  private helloCursor: number | null = null;
  private replayHead: number | null = null;
  private replayComplete = false;
  /** 4409: another stream replaced us; stay quiet until the app is visible. */
  private suppressed = false;
  /** 4401/4426: only revive() (pairing success) starts us again. */
  private dead = false;
  private ackFrozen = false;
  /**
   * Acks never pass a durable event this device refused (malformed, unknown to this build, or
   * oversized): the gateway keeps it for replay instead of retiring it as stored. `null` while
   * nothing was refused. Fencing lives and dies with one socket: a reconnect replays everything
   * above the checkpoint — refused events included — and re-refuses (or accepts, once repaired)
   * them there, so a stale ceiling never outlives the stream that set it.
   */
  private ackCeiling: number | null = null;
  private ackCursor: number | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly offQueueChange: () => void;
  private readonly onVisible = () => {
    if (!document.hidden) {
      this.suppressed = false;
      this.kick();
      // iOS kills sockets in standby without a close frame: probe now
      // instead of waiting for the next 25 s tick.
      this.pingTick();
    }
  };
  private readonly onOnline = () => this.kick();

  constructor(private store: Store, private events: ConnectionEvents = {}) {
    this.pingTimer = setInterval(
      () => this.pingTick(),
      LIMITS.pingIntervalMs,
    );
    document.addEventListener("visibilitychange", this.onVisible);
    addEventListener("online", this.onOnline);
    this.offQueueChange = store.onQueueChange(() => {
      void store.reloadQueue().then(() => this.flushQueue()).catch(console.error);
    });
    this.connect();
  }

  /**
   * Stop for good: close the stream without reconnecting, answer every pending reply with
   * `undefined`, and release every timer and listener. A new `Connection` may follow.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dead = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.pingWatch);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.ackTimer);
    for (const timer of this.uploadTimers.values()) clearTimeout(timer);
    this.uploadTimers.clear();
    document.removeEventListener("visibilitychange", this.onVisible);
    removeEventListener("online", this.onOnline);
    this.offQueueChange();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    for (const handler of this.pending.values()) void handler();
    this.pending.clear();
  }

  /** After a successful pairing (or manual retry) connect again. */
  revive() {
    if (this.disposed) return;
    this.dead = false;
    this.suppressed = false;
    this.attempt = 0;
    this.connect();
  }

  /** Typed owner control request; the visible result arrives as an event. */
  control(thread: ThreadId, command: ControlCommand, args?: string) {
    if (this.store.connState !== "open" || !this.store.canWrite(thread)) return;
    this.write({ type: "req", id: this.id(), op: "control", thread, command, ...(args ? { args } : {}) });
  }

  /** Switch the thread's model preset; pending until its `model` event arrives. */
  selectPreset(thread: ThreadId, preset: string) {
    if (this.store.connState !== "open" || !this.store.canWrite(thread)) return;
    if (this.request({ type: "req", id: this.id(), op: "control", thread, command: "model", args: preset }, (res) => {
      if (this.disposed) return;
      if (!res?.ok && this.store.pendingModel(thread) === preset) this.store.setPendingModel(thread, undefined);
    })) this.store.setPendingModel(thread, preset);
  }

  rename(thread: ThreadId, title: string) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.rename", thread, title });
  }

  archive(thread: ThreadId, archived: boolean) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.archive", thread, archived });
  }

  /**
   * One owner reaction on a message (protocol v2, Reactions): an emoji, or `null` to clear it.
   * Fire and forget — the badge follows the durable `reaction` event, never this call.
   */
  react(thread: ThreadId, message: string, emoji: Reaction | null) {
    if (this.store.connState !== "open" || !this.store.canWrite(thread)) return;
    this.request({ type: "req", id: this.id(), op: "react", thread, message, emoji }, () => undefined);
  }

  /** The VAPID public key to subscribe to; `unsupported` when push is off. */
  pushKey() {
    return this.mutate({ type: "req", id: this.id(), op: "push.key" });
  }

  /** One thread's own background work; the reply carries `tasks` (protocol v2, Tasks). */
  tasks(thread: ThreadId) {
    return this.mutate({ type: "req", id: this.id(), op: "tasks", thread });
  }

  /**
   * Cancel one task of this thread. The gateway never asks first, so the sheet confirms before
   * calling this; the outcome (`cancelled`/`finished`/`unknown`) is reported as it comes back.
   */
  cancelTask(thread: ThreadId, task: string) {
    return this.mutate({ type: "req", id: this.id(), op: "task.cancel", thread, task });
  }

  pushSubscribe(subscription: PushSubscriptionInfo) {
    return this.mutate({ type: "req", id: this.id(), op: "push.subscribe", subscription });
  }

  pushUnsubscribe() {
    return this.mutate({ type: "req", id: this.id(), op: "push.unsubscribe" });
  }

  /**
   * Answer one open owner question. Resolves `true` only when the gateway claimed it; the card is
   * answered by the durable `question` event that follows, never by this reply.
   */
  answer(thread: ThreadId, question: string, option: QuestionOptionId): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.store.connState !== "open" || !this.store.canWrite(thread)) {
        resolve(false);
        return;
      }
      const frame = { type: "req", id: this.id(), op: "answer", thread, question, option } as const;
      if (!this.request(frame, (res) => resolve(res?.ok === true && res.accepted === true))) resolve(false);
    });
  }

  private mutate<O extends Op>(frame: RequestOf<O>): Promise<ResponseMap[O] | undefined> {
    return new Promise((resolve) => {
      if (this.store.connState !== "open" || !this.request(frame, resolve)) resolve(undefined);
    });
  }

  searchThreads(query: string, onResults: (ids: ReadonlySet<ThreadId>) => void) {
    if (this.store.connState !== "open") return;
    this.request({ type: "req", id: this.id(), op: "threads", query }, async (res) => {
      const threads = res?.ok ? threadList(res.threads) : undefined;
      if (threads && !this.disposed) {
        await this.store.mergeThreads(threads).catch(console.error);
        if (this.disposed) return;
        this.flushOutgoing();
        onResults(new Set(threads.map((t) => t.id)));
      }
    });
  }

  sendCreate(c: ThreadCreate, openFrom?: ThreadId) {
    const current = this.store.creates.get(c.key);
    if (this.disposed || this.store.connState !== "open" || this.creating.has(c.key) || !current || current.failed) return;
    if (this.request({ type: "req", id: this.id(), op: "thread.create", key: c.key, title: c.title, from: c.from }, async (res) => {
      this.creating.delete(c.key);
      if (!res || this.disposed) return; // No reply: retry the same key after replay.
      await this.store.finishCreate(c, res.ok, !!c.from && !res.ok && res.error === "bad_request");
      // A disposed connection never navigates: the app may have remounted on a new one.
      if (this.disposed) return;
      if (res.ok && typeof res.thread === "string" && openFrom !== undefined) this.events.onThreadCreated?.(res.thread, openFrom);
    })) this.creating.add(c.key);
  }

  /**
   * Send an outgoing message. Queued (stays "queued") unless the stream is
   * live; everything queued/sent is flushed after each replay finishes.
   */
  sendOutgoing(entry: Outgoing, retriedRace = false) {
    const current = this.store.outgoing(entry.thread, entry.key);
    if (this.disposed || this.store.connState !== "open" || !this.store.canWrite(entry.thread) || this.sending.has(entry.key) ||
        (current?.state !== "queued" && current?.state !== "sent")) return;
    // Files upload over HTTP first, and a key's attachments never change, so a
    // send waits until every queued file has an upload id (v2.md, Files).
    if (!current.attachments?.length && current.pending?.length) {
      void this.uploadPending(current);
      return;
    }
    const m = current;
    const frame = {
      type: "req", id: this.id(), op: "send", key: m.key, text: m.text, thread: m.thread,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    } as const;
    if (this.request(frame, async (res) => {
      const cur = this.store.outgoing(m.thread, m.key);
      this.sending.delete(m.key);
      if (!res || this.disposed || !cur || (cur.state !== "queued" && cur.state !== "sent")) return;
      if (!res.ok && res.error === "bad_request" && m.thread !== MAIN_THREAD) {
        // Archive may have won the race with this send. The protocol doesn't
        // distinguish that from other bad requests, so check the thread list.
        this.sending.add(m.key);
        await this.store.setOutgoingState(m.key, "queued").catch(console.error);
        if (this.disposed) return;
        this.checkRejectedSend(m, retriedRace);
        return;
      }
      if (!res.ok) console.warn("send rejected:", res.error);
      await this.store.setOutgoingState(m.key, res.ok ? "admitted" : "failed");
    })) {
      this.sending.add(m.key);
      void this.store.setOutgoingState(m.key, "sent").catch(console.error);
    }
  }

  private checkRejectedSend(m: Outgoing, retriedRace: boolean) {
    if (this.request({ type: "req", id: this.id(), op: "threads" }, async (res) => {
      this.sending.delete(m.key);
      if (!res || this.disposed) return;
      const threads = res.ok ? threadList(res.threads) : undefined;
      if (!threads) {
        this.store.markThreadUnconfirmed(m.thread);
        return;
      }
      await this.store.mergeThreads(threads, true).catch(console.error);
      if (this.disposed) return;
      // An older archive may be absent from the bounded listing. Keep it
      // queued in that case too, until a restore event or reconnect.
      if (!threads.some((t) => t.id === m.thread && !t.archived)) return;
      const cur = this.store.outgoing(m.thread, m.key);
      if (cur?.state !== "queued") return;
      if (retriedRace) await this.store.setOutgoingState(m.key, "failed");
      else this.sendOutgoing(cur, true);
    })) return;
    this.sending.delete(m.key);
  }

  /** Upload a queued send's files, freeze their ids on the entry, then send it. */
  private async uploadPending(m: Outgoing) {
    if (this.disposed || this.store.connState !== "open" || this.uploading.has(m.key)) return;
    const due = this.uploadRetryAt.get(m.key) ?? 0;
    if (Date.now() < due) {
      this.scheduleUpload(m, due - Date.now());
      return;
    }
    this.uploading.add(m.key);
    try {
      for (const file of m.pending ?? []) {
        if (file.uploadId) continue;
        const blob = await this.store.fileBlob(file.id);
        if (this.disposed) return;
        if (!blob) {
          await this.store.setOutgoingState(m.key, "failed", "The file is no longer on this device.");
          return;
        }
        const step = await uploadLocal(file.id, blob, file.name, file.type);
        if (this.disposed) return;
        if (step.kind === "retry") {
          this.uploadRetryAt.set(m.key, Date.now() + step.delayMs);
          this.scheduleUpload(m, step.delayMs);
          return;
        }
        if (step.kind === "failed") {
          await this.store.setOutgoingState(m.key, "failed", step.note);
          return;
        }
        if (!await this.store.setPendingUploadId(m.key, file.id, step.id) || this.disposed) return;
      }
      const promoted = await this.store.promotePending(m.key);
      if (promoted) {
        // These ids are frozen on the entry now; the uploader must not hand them out again.
        for (const file of promoted.pending ?? []) releaseUpload(file.id);
        if (!this.disposed) this.sendOutgoing(promoted);
      }
    } catch (err) {
      console.error("a file upload did not finish", err);
    } finally {
      this.uploading.delete(m.key);
    }
  }

  private scheduleUpload(m: Outgoing, delay: number) {
    if (this.uploadTimers.has(m.key)) return;
    this.uploadTimers.set(m.key, setTimeout(() => {
      this.uploadTimers.delete(m.key);
      this.uploadRetryAt.delete(m.key);
      const again = this.store.outgoing(m.thread, m.key);
      if (again) void this.uploadPending(again);
    }, Math.max(delay, 250)));
  }

  private flushOutgoing(thread?: ThreadId) {
    for (const m of this.store.pending()) if (thread === undefined || m.thread === thread) this.sendOutgoing(m);
  }

  private flushQueue() {
    if (this.disposed) return;
    this.flushOutgoing();
    for (const c of this.store.creates.values()) if (!c.failed) this.sendCreate(c);
  }

  // -- lifecycle ---------------------------------------------------------

  private kick() {
    if (this.dead || this.suppressed) return;
    if (!this.ws) this.connect();
  }

  connect() {
    if (this.dead) return;
    if (this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.store.setConn("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/v1/stream`);
    this.ws = ws;
    ws.onopen = () => this.hello(this.store.resumeCursor);
    // Keep replay, writes to IndexedDB, and thread snapshots in wire order.
    let frames = Promise.resolve();
    ws.onmessage = (e) => {
      frames = frames.then(() => this.frame(ws, String(e.data))).catch(console.error);
    };
    ws.onclose = (e) => this.closed(e.code);
    ws.onerror = () => {};
  }

  private closed(code: number) {
    this.ws = null;
    for (const handler of this.pending.values()) void handler();
    this.pending.clear();
    clearTimeout(this.pingWatch);
    this.pingWatch = undefined;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    this.ackCursor = null;
    this.replayComplete = false;
    // Refusal fencing is scoped to the socket: the next replay resends everything above the
    // checkpoint — the refused event included — and re-fences it there if it is still bad, so a
    // repaired replay can advance acks instead of staying frozen at the old stream's ceiling.
    this.ackFrozen = false;
    this.ackCeiling = null;
    this.store.setConn("offline");
    switch (code) {
      case CLOSE.unauthorized:
        this.dead = true;
        this.store.setMode("pair");
        return;
      case CLOSE.version:
        this.dead = true;
        this.store.setMode("update");
        return;
      case CLOSE.replaced:
        // A newer stream for this device exists. While hidden, stay off it;
        // when we become visible again, reconnect.
        if (document.hidden) {
          this.suppressed = true;
          return;
        }
        break;
      case CLOSE.protocol:
        console.warn("gateway closed the stream: protocol violation (4400)");
        break;
      default:
        // network drop or gateway restart: normal reconnect below
        break;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.dead || this.suppressed) return;
    const delay =
      Math.min(BASE_DELAY_MS * 2 ** this.attempt, MAX_DELAY_MS) *
      (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // -- frames ------------------------------------------------------------

  private id(): string {
    return `r${++this.nextId}`;
  }

  private write(frame: Request): boolean {
    if (this.disposed) return false;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  /** Send one request; `handler` gets exactly that op's reply (or `undefined` on close). */
  private request<O extends Op>(frame: RequestOf<O>, handler: Handler<O>): boolean {
    if (!this.write(frame)) return false;
    // Replies are matched by id, so this handler only ever sees the reply to this op.
    this.pending.set(frame.id, handler as (res?: AnyReply) => void | Promise<void>);
    return true;
  }

  private async frame(ws: WebSocket, data: string) {
    if (this.ws !== ws) return;
    if (data.length > SERVER_FRAME_MAX_CHARS) {
      // Not parsed and not stored, but never a reason to drop the stream: reconnecting would only
      // replay it again. It may have been a durable event, so acks stop where they are.
      console.error("oversized server frame skipped; acks stop");
      this.ackFrozen = true;
      if (this.replaying) this.replayCount++;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.ws?.close(CLOSE.protocol);
      return;
    }
    if (raw === null || typeof raw !== "object") return;
    const frame = raw as { type?: unknown; id?: unknown; event?: unknown };
    if (frame.type === "res") {
      const handler = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
      if (!handler) return;
      this.pending.delete(frame.id as string);
      const reply = raw as { ok?: unknown; error?: unknown };
      // A reply without a boolean `ok` (or a failure without a string code) is a failure the
      // gateway did not explain; the handler sees it as `internal`, never as success.
      const wellFormed = reply.ok === true || (reply.ok === false && typeof reply.error === "string");
      await handler(wellFormed ? raw as AnyReply : { type: "res", id: frame.id as string, ok: false, error: "internal" });
      return;
    }
    if (frame.type !== "event") return;
    const f = raw as ServerEvent;
    switch (f.event) {
      case "message":
      case "settled":
      case "divider":
      case "reaction":
      case "question":
      case "thread": {
        // Only a well-formed durable event is stored; a malformed one from a broken gateway is
        // dropped (and never acked as stored) instead of corrupting the cache or the UI.
        const ev = parseDurableEvent(raw);
        const known = durableCursor(raw);
        // Replay accounting counts every durable frame the gateway sent, refused or not, so a full
        // batch with a bad event in it is still recognised as full.
        if (this.replaying && this.replayHead !== null && (known === undefined || known <= this.replayHead)) {
          this.replayCount++;
          if (known !== undefined) this.replayCursor = Math.max(this.replayCursor ?? 0, known);
        }
        if (!ev) {
          // Never acked as stored: the checkpoint stays below it, so the gateway keeps it.
          if (known === undefined) this.ackFrozen = true;
          else this.ackCeiling = Math.min(this.ackCeiling ?? known, known - 1);
          console.error("malformed durable event refused; acks stay below it", f.event);
          break;
        }
        if (!await this.store.applyDurable(ev)) this.ackFrozen = true;
        if (this.ws !== ws) break;
        if (ev.event === "thread" && !ev.thread.archived) this.flushOutgoing(ev.thread.id);
        this.ack(ws);
        break;
      }
      case "preview":
        if (typeof f.thread === "string" && typeof f.key === "string") this.store.notePreview(f.thread, f.key);
        break;
      case "status":
        if (typeof f.thread !== "string" ||
            !["idle", "queued", "thinking", "tool", "error"].includes(f.state)) break;
        this.store.setStatus({ ...f, label: typeof f.label === "string" ? f.label : undefined });
        // Main status is guaranteed after each batch, even when all threads
        // are idle. Other status frames are routed normally, in any order.
        if (f.thread === MAIN_THREAD && this.replaying) {
          // A full batch asks for the next one, but only from a cursor past this batch's start, so
          // a batch of events without usable cursors can never loop.
          if (this.replayCount >= LIMITS.replayBatch && this.replayCursor !== this.helloCursor) this.hello(this.replayCursor);
          else {
            this.replaying = false;
            this.replayComplete = true;
            this.ack(ws);
            this.refreshThreads(ws);
          }
        }
        break;
      case "model":
        if (typeof f.thread === "string" && (f.preset === null || typeof f.preset === "string")) {
          this.store.setModel(f);
        }
        break;
      case "login":
        // A live-only one-time URL: validated against the openable schemes in the store, kept in
        // memory, and never written to IndexedDB or the durable event log.
        if (typeof f.thread === "string" && typeof f.server === "string" && typeof f.url === "string" &&
            typeof f.expiresAt === "string") {
          this.store.setLogin(f);
        }
        break;
      case "activity": {
        // Tool steps are display-only: keep well-formed steps, never renderer input.
        const steps = parseActivitySteps(f.steps);
        const omitted = typeof f.omitted === "number" && Number.isSafeInteger(f.omitted) && f.omitted > 0
          ? f.omitted : undefined;
        if (typeof f.thread === "string" && typeof f.key === "string" && steps.length > 0) {
          this.store.setActivity({ ...f, steps, ...(omitted === undefined ? {} : { omitted }) });
        }
        break;
      }
      default: {
        // An event name this build does not know. With a durable cursor it is a newer gateway's
        // event type: refused exactly like a malformed one — counted toward the batch, never
        // stored, never acked past — so the gateway keeps it until an upgraded client. Without a
        // cursor it is ephemeral, like `status` or `preview`, and safe to ignore.
        const known = durableCursor(raw);
        if (known === undefined) break;
        if (this.replaying && this.replayHead !== null && known <= this.replayHead) {
          this.replayCount++;
          this.replayCursor = Math.max(this.replayCursor ?? 0, known);
        }
        this.ackCeiling = Math.min(this.ackCeiling ?? known, known - 1);
        console.warn("unknown durable event refused; acks stay below it", String((raw as { event?: unknown }).event));
        break;
      }
    }
  }

  /** hello (also mid-stream re-hello when a 500-event replay batch is full). */
  private hello(cursor: number | null) {
    // Live frames from before a re-hello can still be in flight. Only the
    // hello reply arms the new replay boundary.
    this.replaying = false;
    this.store.setConn("replaying");
    this.request({ type: "req", id: this.id(), op: "hello", v: PROTOCOL_VERSION, cursor }, (res) => {
      if (!res) return;
      if (!res.ok) {
        console.warn("hello rejected:", res.error);
        this.ws?.close();
        return;
      }
      this.replaying = true;
      this.replayCount = 0;
      this.replayCursor = cursor;
      this.helloCursor = cursor;
      this.replayHead = typeof res.head === "number" ? res.head : null;
      this.store.resetStatuses();
      this.store.resetModels();
      this.store.resetActivities();
      const device = typeof res.device === "string" ? res.device : undefined;
      const name = typeof res.agent === "string" ? res.agent.trim() : "";
      this.store.setIdentity(device, validAgentName(name) ? name : undefined, commandList(res.commands),
        parsePresets(res.presets), typeof res.uploads === "boolean" ? res.uploads : false);
      this.store.setMode("chat");
    });
  }

  private refreshThreads(ws: WebSocket) {
    this.request({ type: "req", id: this.id(), op: "threads" }, async (res) => {
      if (!res) return;
      const threads = res.ok ? threadList(res.threads) : undefined;
      if (threads) await this.store.mergeThreads(threads, true).catch(console.error);
      else this.store.setThreadListUnavailable();
      if (this.ws !== ws) return;
      await this.store.reloadQueue().catch(console.error);
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.store.setConn("open");
      this.flushQueue();
    });
  }

  // -- liveness ----------------------------------------------------------

  private pingTick() {
    if (document.hidden) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // One probe at a time: a visibility probe and the interval tick must not stack watchdogs, or
    // the earlier one would be orphaned and close a healthy stream later.
    if (this.pingWatch !== undefined) return;
    const ok = this.request({ type: "req", id: this.id(), op: "ping" }, () => {
      clearTimeout(this.pingWatch);
      this.pingWatch = undefined;
    });
    if (!ok) return;
    this.pingWatch = setTimeout(() => {
      // No reply within the timeout: the stream is dead even though the
      // socket looks open. Drop it; the close handler reconnects.
      this.pingWatch = undefined;
      this.ws?.close();
    }, LIMITS.pingTimeoutMs);
  }

  /** Coalesce acks so a big replay does not become one frame per event. */
  private ack(ws: WebSocket) {
    if (!this.replayComplete || this.ackFrozen || this.store.cursor === null) return;
    // Only called after the triggering event (or the whole replay) commits, and never past an
    // event this device refused.
    const cursor = Math.min(this.store.cursor, this.ackCeiling ?? Infinity);
    if (cursor < 1) return;
    this.ackCursor = cursor;
    if (this.ackTimer !== undefined) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      const cursor = this.ackCursor;
      this.ackCursor = null;
      if (cursor !== null) void this.flushAck(ws, cursor);
    }, 250);
  }

  private async flushAck(ws: WebSocket, cursor: number) {
    if (this.ws !== ws || !this.replayComplete || this.ackFrozen) return;
    try {
      if (await this.store.checkpoint(cursor) && this.ws === ws && !this.ackFrozen) {
        if (this.write({ type: "req", id: this.id(), op: "ack", cursor })) this.store.setAcked(cursor);
      }
    } catch (err) {
      this.ackFrozen = true;
      console.error("replay checkpoint not persisted; acks stop", err);
    }
  }
}

/** A durable event's replay cursor, if the frame carries a usable one. */
function durableCursor(raw: unknown): number | undefined {
  const cursor = (raw as { cursor?: unknown }).cursor;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor > 0 ? cursor : undefined;
}

/** A `threads` reply's well-formed entries; `undefined` when the field is not a list. */
function threadList(raw: unknown): ThreadInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((t) => parseThreadInfo(t) ?? []);
}

/** Keeps only well-formed `hello.commands` entries; undefined if none were sent. */
function commandList(raw: unknown): CommandInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((c): CommandInfo[] => {
    if (!c || typeof c !== "object") return [];
    const { name, args, summary, usage } = c as Record<string, unknown>;
    if (typeof name !== "string" || !LIMITS.commandNamePattern.test(name) || typeof summary !== "string"
      || typeof usage !== "string" || (args !== undefined && typeof args !== "string")) return [];
    return [{ name, summary, usage, ...(args ? { args } : {}) }];
  });
}
