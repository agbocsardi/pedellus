import {
  CLOSE,
  LIMITS,
  type ControlCommand,
  type Event,
  type Response,
  type ServerFrame,
} from "./protocol";
import type { Outgoing, Store } from "./store";

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
  private pending = new Map<string, (res: Response) => void>();
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
      }
    });
    addEventListener("online", () => this.kick());
    this.connect();
  }

  /** After a successful pairing (or manual retry) connect again. */
  revive() {
    this.dead = false;
    this.suppressed = false;
    this.connect();
  }

  /** Typed owner control request; the visible result arrives as an event. */
  control(command: ControlCommand) {
    this.write({ type: "req", id: this.id(), op: "control", command });
  }

  /**
   * Send an outgoing message. Queued (stays "queued") unless the stream is
   * live; everything queued/sent is flushed after each replay finishes.
   */
  sendOutgoing(m: Outgoing) {
    if (this.store.connState !== "open") return;
    const id = this.id();
    this.pending.set(id, (res) => {
      const cur = this.store.outbox.get(m.key);
      if (!cur) return;
      if (res.ok && (cur.state === "queued" || cur.state === "sent")) {
        void this.store.setOutgoingState(m.key, "admitted");
      } else if (!res.ok) {
        console.warn("send rejected:", res.error);
        void this.store.setOutgoingState(m.key, "failed");
      }
    });
    if (this.write({ type: "req", id, op: "send", key: m.key, text: m.text })) {
      void this.store.setOutgoingState(m.key, "sent");
    }
  }

  // -- lifecycle ---------------------------------------------------------

  private kick() {
    if (this.dead || this.suppressed) return;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) this.connect();
  }

  connect() {
    if (this.dead) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.store.setConn("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/v1/stream`);
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (e) => void this.frame(String(e.data));
    ws.onclose = (e) => this.closed(e.code);
    ws.onerror = () => {};
  }

  private closed(code: number) {
    this.ws = null;
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

  private write(frame: object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private async frame(data: string) {
    if (data.length > LIMITS.frameBytes) {
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
        handler(f);
      }
      return;
    }
    await this.event(f as Event);
  }

  /** hello (also mid-stream re-hello when a 500-event replay batch is full). */
  private hello() {
    this.replaying = true;
    this.replayCount = 0;
    this.store.setConn("replaying");
    const id = this.id();
    this.pending.set(id, (res) => {
      if (!res.ok) {
        console.warn("hello rejected:", res.error);
        this.ws?.close();
        return;
      }
      if (typeof res.device === "string") this.store.setDevice(res.device);
      this.attempt = 0;
      this.store.setMode("chat");
    });
    this.write({ type: "req", id, op: "hello", v: 1, cursor: this.store.cursor });
  }

  private async event(ev: Event) {
    switch (ev.event) {
      case "message":
      case "settled":
      case "divider": {
        const isNew = await this.store.applyDurable(ev);
        if (isNew) {
          this.replayCount++;
          this.ack(ev.cursor);
        }
        break;
      }
      case "preview":
        this.store.setPreview(ev);
        break;
      case "status":
        this.store.setStatus({ state: ev.state, label: ev.label });
        // The status event after hello ends the replay batch. A full batch
        // (500) may have more behind it: re-hello with the new cursor.
        if (this.replaying) {
          if (this.replayCount >= LIMITS.replayBatch) {
            this.hello();
          } else {
            this.replaying = false;
            this.store.setConn("open");
            for (const m of this.store.pending()) this.sendOutgoing(m);
          }
        }
        break;
      default:
        break;
    }
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
