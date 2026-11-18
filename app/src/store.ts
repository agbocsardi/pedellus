import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { MAIN_THREAD, type DurableEvent, type PreviewEvent, type StatusEvent, type ThreadId, type ThreadInfo, type ThreadOrigin } from "./protocol";

export type ConnState = "offline" | "connecting" | "replaying" | "open";
export type Mode = "boot" | "chat" | "pair" | "update";
export type OutgoingState = "queued" | "sent" | "admitted" | "answered" | "failed" | "aborted";
export type Outgoing = { key: string; thread: ThreadId; text: string; state: OutgoingState; at: number };
export type ThreadCreate = { key: string; title?: string; from?: ThreadOrigin; failed?: boolean };
export type AgentStatus = Pick<StatusEvent, "state" | "label">;
type ChatEvent = Exclude<DurableEvent, { event: "thread" }>;

interface Db extends DBSchema {
  events: { key: number; value: DurableEvent };
  outbox: { key: string; value: Outgoing };
  threads: { key: string; value: ThreadInfo };
  creates: { key: string; value: ThreadCreate };
  view: { key: string; value: { thread: ThreadId; cursor: number } };
  settings: { key: "openThread" | "resumeCursor"; value: ThreadId | number };
}

const IDLE: AgentStatus = { state: "idle" };
const MAIN: ThreadInfo = { id: MAIN_THREAD, title: "Main", archived: false, createdAt: "", lastAt: "" };

/** Same key alphabet as the protocol's request ids. */
function newKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export class Store {
  events = new Map<ThreadId, ChatEvent[]>(); // ascending by cursor within each thread
  outbox = new Map<string, Outgoing>();
  threads = new Map<ThreadId, ThreadInfo>([[MAIN_THREAD, MAIN]]);
  creates = new Map<string, ThreadCreate>();
  threadListUnavailable = false;
  forkRejected = false;
  openThread: ThreadId = MAIN_THREAD;
  connState: ConnState = "offline";
  mode: Mode = "boot";
  device: string | null = null;
  storageBlocked = false;
  /** Max seen can be ahead of a replay gap; only resumeCursor is safe for hello. */
  cursor: number | null = null;
  resumeCursor: number | null = null;

  // Live frames are not durable; hello resends current statuses, not previews.
  private previews = new Map<ThreadId, PreviewEvent>();
  private statuses = new Map<ThreadId, AgentStatus>();
  private viewed = new Map<ThreadId, number>();
  private db: IDBPDatabase<Db> | null = null;
  private durableWriteFailed = false;
  private seenCursors = new Set<number>();
  private threadCursors = new Map<ThreadId, number>();
  private echoedKeys = new Map<ThreadId, Set<string>>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = () => this.version;
  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  async init() {
    const db = this.db = await openDB<Db>("durable-app", 2, {
      blocked: () => {
        this.storageBlocked = true;
        this.changed();
      },
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("events", { keyPath: "cursor" });
          db.createObjectStore("outbox", { keyPath: "key" });
        }
        db.createObjectStore("threads", { keyPath: "id" });
        db.createObjectStore("creates", { keyPath: "key" });
        db.createObjectStore("view", { keyPath: "thread" });
        db.createObjectStore("settings");
      },
    });
    db.onversionchange = () => {
      db.close();
      this.db = null;
    };
    this.storageBlocked = false;
    for (const m of await db.getAll("outbox")) this.outbox.set(m.key, { ...m, thread: m.thread ?? MAIN_THREAD });
    // IndexedDB returns events in primary-key (cursor) order. Normalize old
    // records on read; the upgrade never rewrites or drops the v1 log/outbox.
    for (const ev of await db.getAll("events")) {
      this.cursor = ev.cursor;
      this.seenCursors.add(ev.cursor);
      if (ev.event === "thread") this.threadCursors.set(ev.thread.id, ev.cursor);
      else {
        // Existing v2 caches have no checkpoint. Replay from the last v1
        // cursor (or the beginning) rather than trusting their high-water mark.
        if (ev.thread === undefined) this.resumeCursor = ev.cursor;
        this.absorbChat({ ...ev, thread: ev.thread ?? MAIN_THREAD });
      }
    }
    // This cache includes the last authoritative listing, which can be newer
    // than any retained thread event, so don't overwrite it with old history.
    for (const t of await db.getAll("threads")) this.threads.set(t.id, t);
    for (const c of await db.getAll("creates")) this.creates.set(c.key, c);
    for (const v of await db.getAll("view")) this.viewed.set(v.thread, v.cursor);
    const open = await db.get("settings", "openThread");
    if (typeof open === "string") this.openThread = open;
    const resume = await db.get("settings", "resumeCursor");
    if (typeof resume === "number") this.resumeCursor = resume;
    this.changed();
  }

  /** Commit each durable event and its derived state before acking it. */
  async applyDurable(ev: DurableEvent): Promise<boolean> {
    if (this.seenCursors.has(ev.cursor)) return !!this.db && !this.durableWriteFailed;
    this.seenCursors.add(ev.cursor);
    this.cursor = Math.max(this.cursor ?? 0, ev.cursor);
    let outgoing: Outgoing | undefined;
    let info: ThreadInfo | undefined;
    if (ev.event === "thread") {
      const prev = this.threads.get(ev.thread.id);
      if (ev.cursor > (this.threadCursors.get(ev.thread.id) ?? 0)) {
        this.threadCursors.set(ev.thread.id, ev.cursor);
        const lastAt = prev && Date.parse(prev.lastAt) > Date.parse(ev.thread.lastAt) ? prev.lastAt : ev.thread.lastAt;
        info = { ...ev.thread, lastAt };
        this.threads.set(info.id, info);
      }
    } else {
      outgoing = this.absorbChat(ev);
      const prev = this.threads.get(ev.thread);
      if (prev && "at" in ev && Date.parse(ev.at) > (Date.parse(prev.lastAt) || 0)) {
        info = { ...prev, lastAt: ev.at };
        this.threads.set(info.id, info);
      }
    }
    this.changed();
    if (!this.db || this.durableWriteFailed) return false;
    try {
      const tx = this.db.transaction(["events", "outbox", "threads"], "readwrite");
      await Promise.all([
        tx.objectStore("events").put(ev),
        outgoing && tx.objectStore("outbox").put(outgoing),
        info && tx.objectStore("threads").put(info),
        tx.done,
      ]);
      return true;
    } catch (err) {
      // Don't persist later cursors over a hole in the cache.
      this.durableWriteFailed = true;
      console.error("event not persisted; acks stop", err);
      return false;
    }
  }

  /** Save the replay-safe cursor before the gateway can retire those events. */
  async checkpoint(cursor: number) {
    if (!this.db || this.durableWriteFailed) return false;
    if (cursor > (this.resumeCursor ?? 0)) {
      await this.db.put("settings", cursor, "resumeCursor");
      this.resumeCursor = Math.max(this.resumeCursor ?? 0, cursor);
    }
    return true;
  }

  private absorbChat(ev: ChatEvent): Outgoing | undefined {
    let events = this.events.get(ev.thread);
    if (!events) this.events.set(ev.thread, events = []);
    let i = events.length;
    while (i > 0 && events[i - 1].cursor > ev.cursor) i--;
    events.splice(i, 0, ev);
    if (ev.event === "message" && ev.role === "user" && ev.key) {
      let keys = this.echoedKeys.get(ev.thread);
      if (!keys) this.echoedKeys.set(ev.thread, keys = new Set());
      keys.add(ev.key);
      const m = this.outgoing(ev.thread, ev.key);
      if (m && (m.state === "queued" || m.state === "sent" || m.state === "failed")) {
        return this.updateOutgoing(m, "admitted");
      }
    } else if (ev.event === "settled" || (ev.event === "message" && ev.role === "assistant")) {
      if (ev.key && this.previews.get(ev.thread)?.key === ev.key) this.previews.delete(ev.thread);
      const m = ev.event === "settled" ? this.outgoing(ev.thread, ev.key) : undefined;
      if (m && ev.event === "settled") return this.updateOutgoing(m, ev.outcome);
    }
  }

  private updateOutgoing(m: Outgoing, state: OutgoingState): Outgoing {
    const next = { ...m, state };
    this.outbox.set(m.key, next);
    return next;
  }

  outgoing(thread: ThreadId, key: string) {
    const m = this.outbox.get(key);
    return m?.thread === thread ? m : undefined;
  }

  hasEcho(thread: ThreadId, key: string): boolean {
    return this.echoedKeys.get(thread)?.has(key) ?? false;
  }

  setThreadListUnavailable() {
    this.threadListUnavailable = true;
    this.changed();
  }

  async mergeThreads(list: ThreadInfo[], refresh = false) {
    if (refresh) this.threadListUnavailable = false;
    // The gateway omits older archives from the default listing. Keep known
    // metadata so cached messages and origin links stay navigable.
    for (const t of list) this.threads.set(t.id, t);
    this.changed();
    if (!this.db) return;
    const tx = this.db.transaction("threads", "readwrite");
    await Promise.all([...list.map((t) => tx.store.put(t)), tx.done]);
  }

  messageMatches(query: string): Map<ThreadId, string> {
    const matches = new Map<ThreadId, string>();
    // Search the in-memory projection of the durable IndexedDB message log.
    for (const [thread, events] of this.events) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.event !== "message") continue;
        const text = ev.text.replace(/\s+/g, " ");
        const at = text.toLowerCase().indexOf(query);
        if (at < 0) continue;
        const start = Math.max(0, at - 24);
        const end = Math.min(text.length, at + query.length + 44);
        matches.set(thread, (start ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : ""));
        break;
      }
    }
    return matches;
  }

  selectThread(thread: ThreadId) {
    if (thread === this.openThread || !this.threads.has(thread)) return;
    this.openThread = thread;
    this.changed();
    void this.db?.put("settings", thread, "openThread").catch(console.error);
  }

  latestViewable(thread: ThreadId): number {
    const events = this.events.get(thread) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event !== "settled") return events[i].cursor;
    }
    return 0;
  }

  isUnread(thread: ThreadId): boolean {
    return this.latestViewable(thread) > (this.viewed.get(thread) ?? 0);
  }

  markViewed(thread: ThreadId, cursor: number) {
    if (cursor <= (this.viewed.get(thread) ?? 0)) return;
    this.viewed.set(thread, cursor);
    this.changed();
    void this.db?.put("view", { thread, cursor }).catch(console.error);
  }

  preview(thread: ThreadId) { return this.previews.get(thread); }
  status(thread: ThreadId) { return this.statuses.get(thread) ?? IDLE; }

  setPreview(p: PreviewEvent) {
    this.previews.set(p.thread, p);
    this.changed();
  }

  resetStatuses() {
    this.statuses.clear();
    this.changed();
  }

  setStatus(s: StatusEvent) {
    this.statuses.set(s.thread, s);
    this.changed();
  }

  setConn(s: ConnState) {
    if (this.connState !== s) {
      this.connState = s;
      if (s === "offline") {
        this.previews.clear();
        this.statuses.clear();
      }
      this.changed();
    }
  }

  setMode(m: Mode) {
    if (this.mode !== m) {
      this.mode = m;
      this.changed();
    }
  }

  setDevice(d: string) {
    if (this.device !== d) {
      this.device = d;
      this.changed();
    }
  }

  async createOutgoing(thread: ThreadId, text: string): Promise<Outgoing> {
    const m: Outgoing = { key: newKey(), thread, text, state: "queued", at: Date.now() };
    await this.db?.put("outbox", m);
    this.outbox.set(m.key, m);
    this.changed();
    return m;
  }

  async setOutgoingState(key: string, state: OutgoingState) {
    const m = this.outbox.get(key);
    if (!m || m.state === state) return;
    const next = this.updateOutgoing(m, state);
    this.changed();
    await this.db?.put("outbox", next);
  }

  async queueCreate(title?: string, from?: ThreadOrigin): Promise<ThreadCreate> {
    const c = { key: newKey(), title, from };
    await this.db?.put("creates", c);
    this.creates.set(c.key, c);
    this.changed();
    return c;
  }

  clearForkRejection() {
    if (!this.forkRejected) return;
    this.forkRejected = false;
    this.changed();
  }

  async finishCreate(c: ThreadCreate, ok: boolean, rejectedFork = false) {
    if (ok || rejectedFork) {
      await this.db?.delete("creates", c.key);
      this.creates.delete(c.key);
      if (rejectedFork) this.forkRejected = true;
    } else {
      const failed = { ...c, failed: true };
      await this.db?.put("creates", failed);
      this.creates.set(c.key, failed);
    }
    this.changed();
  }

  /** Messages that must (re)reach the gateway: never-sent or reply-less. */
  pending(): Outgoing[] {
    return [...this.outbox.values()].filter((m) => m.state === "queued" || m.state === "sent");
  }
}
