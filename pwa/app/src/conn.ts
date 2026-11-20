import {
  CLOSE,
  LIMITS,
  MAIN_THREAD,
  PROTOCOL_VERSION,
  type CommandInfo,
  type ControlCommand,
  type PresetInfo,
  type PushSubscriptionInfo,
  type QuestionOptionId,
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
  private sending = new Set<string>();
  private creating = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingWatch: ReturnType<typeof setTimeout> | undefined;
  private replaying = false;
  private replayCount = 0;
  private replayCursor: number | null = null;
  private replayHead: number | null = null;
  private replayComplete = false;
  /** 4409: another stream replaced us; stay quiet until the app is visible. */
  private suppressed = false;
  /** 4401/4426: only revive() (pairing success) starts us again. */
  private dead = false;
  private ackFrozen = false;
  private ackCursor: number | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private selectCreated: { thread: ThreadId; from: ThreadId } | undefined;

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
    store.onQueueChange(() => {
      void store.reloadQueue().then(() => this.flushQueue()).catch(console.error);
    });
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
  control(thread: ThreadId, command: ControlCommand, args?: string) {
    if (this.store.connState !== "open" || !this.store.canWrite(thread)) return;
    this.write({ type: "req", id: this.id(), op: "control", thread, command, ...(args ? { args } : {}) });
  }

  /** Switch the thread's model preset; pending until its `model` event arrives. */
  selectPreset(thread: ThreadId, preset: string) {
    if (this.store.connState !== "open" || !this.store.canWrite(thread)) return;
    if (this.request({ type: "req", id: this.id(), op: "control", thread, command: "model", args: preset }, (res) => {
      if (!res?.ok && this.store.pendingModel(thread) === preset) this.store.setPendingModel(thread, undefined);
    })) this.store.setPendingModel(thread, preset);
  }

  rename(thread: ThreadId, title: string) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.rename", thread, title });
  }

  archive(thread: ThreadId, archived: boolean) {
    return this.mutate({ type: "req", id: this.id(), op: "thread.archive", thread, archived });
  }

  /** The VAPID public key to subscribe to; `unsupported` when push is off. */
  pushKey() {
    return this.mutate({ type: "req", id: this.id(), op: "push.key" });
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

  private mutate(frame: Request): Promise<Response | undefined> {
    return new Promise((resolve) => {
      if (this.store.connState !== "open" || !this.request(frame, resolve)) resolve(undefined);
    });
  }

  searchThreads(query: string, onResults: (ids: ReadonlySet<ThreadId>) => void) {
    if (this.store.connState !== "open") return;
    this.request({ type: "req", id: this.id(), op: "threads", query }, async (res) => {
      if (res?.ok && res.threads) {
        await this.store.mergeThreads(res.threads).catch(console.error);
        this.flushOutgoing();
        onResults(new Set(res.threads.map((t) => t.id)));
      }
    });
  }

  sendCreate(c: ThreadCreate, openFrom?: ThreadId) {
    const current = this.store.creates.get(c.key);
    if (this.store.connState !== "open" || this.creating.has(c.key) || !current || current.failed) return;
    if (this.request({ type: "req", id: this.id(), op: "thread.create", key: c.key, title: c.title, from: c.from }, async (res) => {
      this.creating.delete(c.key);
      if (!res) return; // No reply: retry the same key after replay.
      await this.store.finishCreate(c, res.ok, !!c.from && !res.ok && res.error === "bad_request");
      if (res.ok && res.thread && openFrom === this.store.openThread) {
        if (this.store.threads.has(res.thread)) this.store.selectThread(res.thread);
        else this.selectCreated = { thread: res.thread, from: openFrom };
      }
    })) this.creating.add(c.key);
  }

  /**
   * Send an outgoing message. Queued (stays "queued") unless the stream is
   * live; everything queued/sent is flushed after each replay finishes.
   */
  sendOutgoing(m: Outgoing, retriedRace = false) {
    const current = this.store.outgoing(m.thread, m.key);
    if (this.store.connState !== "open" || !this.store.canWrite(m.thread) || this.sending.has(m.key) ||
        (current?.state !== "queued" && current?.state !== "sent")) return;
    const frame = { type: "req", id: this.id(), op: "send", key: m.key, text: m.text, thread: m.thread } as const;
    if (this.request(frame, async (res) => {
      const cur = this.store.outgoing(m.thread, m.key);
      this.sending.delete(m.key);
      if (!res || !cur || (cur.state !== "queued" && cur.state !== "sent")) return;
      if (!res.ok && res.error === "bad_request" && m.thread !== MAIN_THREAD) {
        // Archive may have won the race with this send. The protocol doesn't
        // distinguish that from other bad requests, so check the thread list.
        this.sending.add(m.key);
        await this.store.setOutgoingState(m.key, "queued").catch(console.error);
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
      if (!res) return;
      if (!res.ok || !res.threads) {
        this.store.markThreadUnconfirmed(m.thread);
        return;
      }
      await this.store.mergeThreads(res.threads, true).catch(console.error);
      // An older archive may be absent from the bounded listing. Keep it
      // queued in that case too, until a restore event or reconnect.
      if (!res.threads.some((t) => t.id === m.thread && !t.archived)) return;
      const cur = this.store.outgoing(m.thread, m.key);
      if (cur?.state !== "queued") return;
      if (retriedRace) await this.store.setOutgoingState(m.key, "failed");
      else this.sendOutgoing(cur, true);
    })) return;
    this.sending.delete(m.key);
  }

  private flushOutgoing(thread?: ThreadId) {
    for (const m of this.store.pending()) if (thread === undefined || m.thread === thread) this.sendOutgoing(m);
  }

  private flushQueue() {
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
    this.selectCreated = undefined;
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
      case "question":
      case "thread": {
        if (this.replaying && this.replayHead !== null && f.cursor <= this.replayHead) {
          this.replayCount++;
          this.replayCursor = f.cursor;
        }
        if (!await this.store.applyDurable(f)) this.ackFrozen = true;
        if (this.ws !== ws) break;
        if (f.event === "thread") {
          if (f.thread.id === this.selectCreated?.thread) {
            if (this.store.openThread === this.selectCreated.from) this.store.selectThread(f.thread.id);
            this.selectCreated = undefined;
          }
          if (!f.thread.archived) this.flushOutgoing(f.thread.id);
        }
        this.ack(ws);
        break;
      }
      case "preview":
        this.store.notePreview(f.thread, f.key);
        break;
      case "status":
        this.store.setStatus(f);
        // Main status is guaranteed after each batch, even when all threads
        // are idle. Other status frames are routed normally, in any order.
        if (f.thread === MAIN_THREAD && this.replaying) {
          if (this.replayCount >= LIMITS.replayBatch) this.hello(this.replayCursor);
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
      this.replayHead = res.head ?? null;
      this.store.resetStatuses();
      this.store.resetModels();
      const device = typeof res.device === "string" ? res.device : undefined;
      const name = typeof res.agent === "string" ? res.agent.trim() : "";
      this.store.setIdentity(device, name && [...name].length <= 40 ? name : undefined, commandList(res.commands),
        presetList(res.presets));
      this.store.setMode("chat");
    });
  }

  private refreshThreads(ws: WebSocket) {
    this.request({ type: "req", id: this.id(), op: "threads" }, async (res) => {
      if (!res) return;
      if (res.ok && res.threads) await this.store.mergeThreads(res.threads, true).catch(console.error);
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
  private ack(ws: WebSocket) {
    if (!this.replayComplete || this.ackFrozen || this.store.cursor === null) return;
    // Only called after the triggering event (or the whole replay) commits.
    this.ackCursor = this.store.cursor;
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

const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,22}$/;
/** Keeps only well-formed `hello.commands` entries; undefined if none were sent. */
function commandList(raw: unknown): CommandInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((c): CommandInfo[] => {
    if (!c || typeof c !== "object") return [];
    const { name, args, summary, usage } = c as Record<string, unknown>;
    if (typeof name !== "string" || !COMMAND_NAME.test(name) || typeof summary !== "string"
      || typeof usage !== "string" || (args !== undefined && typeof args !== "string")) return [];
    return [{ name, summary, usage, ...(args ? { args } : {}) }];
  });
}

/** Keeps only well-formed, uniquely named `hello.presets` entries; undefined if none were sent. */
function presetList(raw: unknown): PresetInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const text = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max && !/[\p{Cc}]/u.test(v);
  return raw.flatMap((p): PresetInfo[] => {
    if (!p || typeof p !== "object") return [];
    const { name, label, model, thinking } = p as Record<string, unknown>;
    if (!text(name, 64) || /\s/.test(name as string) || seen.has(name as string) || !text(model, 200)
      || (label !== undefined && !text(label, 40)) || (thinking !== undefined && !text(thinking, 40))) return [];
    seen.add(name as string);
    return [{ name: name as string, model: model as string, ...(label ? { label: label as string } : {}),
      ...(thinking ? { thinking: thinking as string } : {}) }];
  });
}
