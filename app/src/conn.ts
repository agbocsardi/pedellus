import {
  CLOSE,
  LIMITS,
  MAIN_THREAD,
  PROTOCOL_VERSION,
  type ControlCommand,
  type Request,
  type Response,
  type ServerFrame,
  type ThreadId,
} from "./protocol";
import type { Outgoing, Store, ThreadCreate } from "./store";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/**
 * One WebSocket to same-origin /v1/stream. Owns hello/replay/ack, pings,
 * backoff reconnects and the close-code reactions (4401 pairing, 4426 update,
 * 4409 replaced). The store is the state; this class only moves it.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<string, (res?: Response) => void | Promise<void>>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingWatch: ReturnType<typeof setTimeout> | undefined;
  private replaying = false;
  private replayCount = 0;
  /** 4409: another stream replaced us; stay quiet until the app is visible. */
  private suppressed = false;
  /** 4401/4426: only revive() (pairing success) starts us again. */
  private dead = false;
  private ackCursor: number | null = null;
  private ackFrozen = false;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private store: Store) {
    this.pingTimer = setInterval(
      () => this.pingTick(),
      LIMITS.pingIntervalMs,
    );
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        this.suppressed = false;
        this.kick();
        // iOS kills sockets in standby without a close frame: probe now
        // instead of waiting for the next 25 s tick.
        this.pingTick();
      }
    });
    addEventListener("online", () => this.kick());
    this.connect();
  }

  /** After a successful pairing (or manual retry) connect again. */
  revive() {
    this.dead = false;
    this.suppressed = false;
    this.attempt = 0;
    this.connect();
  }

  /** Typed owner control request; the visible result arrives as an event. */
  control(thread: ThreadId, command: ControlCommand) {
    if (this.store.connState !== "open" || this.store.threads.get(thread)?.archived) return;
    this.write({ type: "req", id: this.id(), op: "control", thread, command });
  }

  rename(thread: ThreadId, title: string) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.rename", thread, title });
  }

  archive(thread: ThreadId, archived: boolean) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.archive", thread, archived });
  }

  private mutate(frame: Request): Promise<Response | undefined> {
    return new Promise((resolve) => {
      if (this.store.connState !== "open" || !this.request(frame, resolve)) resolve(undefined);
    });
  }

  sendCreate(c: ThreadCreate, from?: ThreadId) {
    if (this.store.connState !== "open") return;
    this.request({ type: "req", id: this.id(), op: "thread.create", key: c.key, title: c.title }, async (res) => {
      if (!res) return; // No reply: retry the same key after replay.
      await this.store.finishCreate(c, res.ok);
      if (res.ok && res.thread && from === this.store.openThread) this.store.selectThread(res.thread);
    });
  }

  /**
   * Send an outgoing message. Queued (stays "queued") unless the stream is
   * live; everything queued/sent is flushed after each replay finishes.
   */
  sendOutgoing(m: Outgoing) {
    if (this.store.connState !== "open") return;
    const frame = { type: "req", id: this.id(), op: "send", key: m.key, text: m.text, thread: m.thread } as const;
    if (this.request(frame, (res) => {
      const cur = this.store.outbox.get(m.key);
      if (!res || !cur || (cur.state !== "queued" && cur.state !== "sent")) return;
      if (!res.ok) console.warn("send rejected:", res.error);
      return this.store.setOutgoingState(m.key, res.ok ? "admitted" : "failed");
    })) {
      void this.store.setOutgoingState(m.key, "sent").catch(console.error);
    }
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
    ws.onopen = () => this.hello();
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
    this.flushAck();
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
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private request(frame: Request, handler: (res?: Response) => void | Promise<void>): boolean {
    if (!this.write(frame)) return false;
    this.pending.set(frame.id, handler);
    return true;
  }

  private async frame(ws: WebSocket, data: string) {
    if (this.ws !== ws) return;
    if (new TextEncoder().encode(data).length > LIMITS.frameBytes) {
      this.ws?.close(CLOSE.protocol);
      return;
    }
    let f: ServerFrame;
    try {
      f = JSON.parse(data) as ServerFrame;
    } catch {
      this.ws?.close(CLOSE.protocol);
      return;
    }
    if (f.type === "res") {
      const handler = this.pending.get(f.id);
      if (handler) {
        this.pending.delete(f.id);
        await handler(f);
      }
      return;
    }
    switch (f.event) {
      case "message":
      case "settled":
      case "divider":
      case "thread": {
        this.replayCount++;
        const stored = await this.store.applyDurable(f);
        // Ack drives gateway retention: only what IndexedDB really holds.
        if (!stored) this.ackFrozen = true;
        if (this.ws === ws && stored && !this.ackFrozen) this.ack(f.cursor);
        break;
      }
      case "preview":
        this.store.setPreview(f);
        break;
      case "status":
        this.store.setStatus(f);
        // Main status is guaranteed after each batch, even when all threads
        // are idle. Other status frames are routed normally, in any order.
        if (f.thread === MAIN_THREAD && this.replaying) {
          if (this.replayCount >= LIMITS.replayBatch) this.hello();
          else {
            this.replaying = false;
            this.refreshThreads(ws);
          }
        }
        break;
    }
  }

  /** hello (also mid-stream re-hello when a 500-event replay batch is full). */
  private hello() {
    // Live frames from before a re-hello can still be in flight. Only the
    // hello reply arms the new replay boundary.
    this.replaying = false;
    this.store.setConn("replaying");
    this.request({ type: "req", id: this.id(), op: "hello", v: PROTOCOL_VERSION, cursor: this.store.cursor }, (res) => {
      if (!res) return;
      if (!res.ok) {
        console.warn("hello rejected:", res.error);
        this.ws?.close();
        return;
      }
      this.replaying = true;
      this.replayCount = 0;
      this.store.resetStatuses();
      if (typeof res.device === "string") this.store.setDevice(res.device);
      this.store.setMode("chat");
    });
  }

  private refreshThreads(ws: WebSocket) {
    this.request({ type: "req", id: this.id(), op: "threads" }, async (res) => {
      if (!res) return;
      if (res.ok && res.threads) await this.store.replaceThreads(res.threads).catch(console.error);
      else this.store.setThreadListUnavailable();
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.store.setConn("open");
      for (const m of this.store.pending()) this.sendOutgoing(m);
      for (const c of this.store.creates.values()) if (!c.failed) this.sendCreate(c);
    });
  }

  // -- liveness ----------------------------------------------------------

  private pingTick() {
    if (document.hidden) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = this.id();
    this.pending.set(id, () => {
      clearTimeout(this.pingWatch);
      this.pingWatch = undefined;
    });
    if (!this.write({ type: "req", id, op: "ping" })) return;
    this.pingWatch = setTimeout(() => {
      // No reply within the timeout: the stream is dead even though the
      // socket looks open. Drop it; the close handler reconnects.
      this.pingWatch = undefined;
      this.ws?.close();
    }, LIMITS.pingTimeoutMs);
  }

  /** Coalesce acks so a big replay does not become one frame per event. */
  private ack(cursor: number) {
    this.ackCursor = Math.max(this.ackCursor ?? 0, cursor);
    if (this.ackTimer === undefined) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = undefined;
        this.flushAck();
      }, 250);
    }
  }

  private flushAck() {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
    if (this.ackCursor === null) return;
    this.write({ type: "req", id: this.id(), op: "ack", cursor: this.ackCursor });
  }
}
