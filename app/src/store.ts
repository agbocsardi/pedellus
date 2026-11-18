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

const terminal = (state: OutgoingState) => state === "failed" || state === "answered" || state === "aborted";
const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

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
  replayReady = false;
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
  private searchText = new Map<number, { text: string; lower: string }>();
  private searchCache?: { query: string; results: { thread: ThreadInfo; snippet?: string }[] };
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
    const db = await openDB<Db>("durable-app", 2, {
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
    let closed = false;
    db.onversionchange = () => {
      closed = true;
      db.close();
      this.db = null;
    };
    this.storageBlocked = false;
    // Load the replay checkpoint and everything it covers from one snapshot.
    const tx = db.transaction(["events", "outbox", "threads", "creates", "view", "settings"], "readonly");
    const [events, outbox, threads, creates, viewed, open, resume] = await Promise.all([
      tx.objectStore("events").getAll(), tx.objectStore("outbox").getAll(),
      tx.objectStore("threads").getAll(), tx.objectStore("creates").getAll(), tx.objectStore("view").getAll(),
      tx.objectStore("settings").get("openThread"), tx.objectStore("settings").get("resumeCursor"), tx.done,
    ]).catch((err) => { db.close(); throw err; });
    if (!closed) this.db = db;
    const cachedThreads = new Set(threads.map((t) => t.id));
    for (const t of threads) this.cacheThread(t);
    for (const m of outbox) {
      const thread = m.thread ?? MAIN_THREAD;
      this.ensureThread(thread);
      this.outbox.set(m.key, { ...m, thread });
    }
    // IndexedDB returns events in primary-key (cursor) order. Normalize old
    // records on read; the upgrade never rewrites or drops the v1 log/outbox.
    for (const ev of events) {
      this.cursor = ev.cursor;
      this.seenCursors.add(ev.cursor);
      if (ev.event === "thread") {
        this.threadCursors.set(ev.thread.id, ev.cursor);
        if (!cachedThreads.has(ev.thread.id)) this.cacheThread(ev.thread);
      } else {
        // Existing v2 caches have no checkpoint. Replay from the last v1
        // cursor (or the beginning) rather than trusting their high-water mark.
        if (ev.thread === undefined) this.resumeCursor = ev.cursor;
        this.absorbChat({ ...ev, thread: ev.thread ?? MAIN_THREAD });
      }
    }
    for (const c of creates) this.creates.set(c.key, c);
    for (const v of viewed) this.viewed.set(v.thread, v.cursor);
    if (typeof open === "string") {
      this.ensureThread(open);
      this.openThread = open;
    }
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
        this.cacheThread(info);
      }
    } else {
      outgoing = this.absorbChat(ev);
      const prev = this.threads.get(ev.thread);
      if (prev && "at" in ev && Date.parse(ev.at) > (Date.parse(prev.lastAt) || 0)) {
        info = { ...prev, lastAt: ev.at };
        this.cacheThread(info);
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
    this.ensureThread(ev.thread);
    if (ev.event === "message") {
      const text = normalize(ev.text);
      this.searchText.set(ev.cursor, { text, lower: text.toLowerCase() });
      this.searchCache = undefined;
    }
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
      if (m && (m.state === "queued" || m.state === "sent")) {
        return this.updateOutgoing(m, "admitted");
      }
    } else if (ev.event === "settled" || (ev.event === "message" && ev.role === "assistant")) {
      if (ev.key && this.previews.get(ev.thread)?.key === ev.key) this.previews.delete(ev.thread);
      const m = ev.event === "settled" ? this.outgoing(ev.thread, ev.key) : undefined;
      if (m && ev.event === "settled" && !terminal(m.state)) return this.updateOutgoing(m, ev.outcome);
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
    for (const t of list) this.cacheThread(t);
    this.changed();
    if (!this.db) return;
    const tx = this.db.transaction("threads", "readwrite");
    await Promise.all([...list.map((t) => tx.store.put(t)), tx.done]);
  }

  private cacheThread(info: ThreadInfo) {
    const old = this.threads.get(info.id);
    if (old && old.title === info.title && old.archived === info.archived && old.archivedReason === info.archivedReason &&
        old.createdAt === info.createdAt && old.lastAt === info.lastAt && old.origin?.thread === info.origin?.thread &&
        old.origin?.messageId === info.origin?.messageId) return;
    this.threads.set(info.id, info);
    this.searchCache = undefined;
    if (info.origin) this.ensureThread(info.origin.thread);
  }

  private ensureThread(id: ThreadId) {
    if (!this.threads.has(id)) this.cacheThread({ ...MAIN, id, title: "Thread" });
  }

  searchThreads(input: string) {
    const query = normalize(input).toLowerCase();
    if (this.searchCache?.query === query) return this.searchCache.results;
    const results: { thread: ThreadInfo; snippet?: string }[] = [];
    for (const t of this.threads.values()) {
      let snippet: string | undefined;
      const events = this.events.get(t.id) ?? [];
      for (let i = events.length - 1; i >= 0; i--) {
        const entry = this.searchText.get(events[i].cursor);
        if (!entry) continue;
        const at = entry.lower.indexOf(query);
        if (at < 0) continue;
        const start = Math.max(0, at - 24);
        const end = Math.min(entry.text.length, at + query.length + 44);
        snippet = (start ? "…" : "") + entry.text.slice(start, end) + (end < entry.text.length ? "…" : "");
        break;
      }
      const title = t.id === MAIN_THREAD ? `Main Durable ${t.title}` : t.title;
      if (snippet !== undefined || title.toLowerCase().includes(query)) results.push({ thread: t, snippet });
    }
    results.sort((a, b) => Number(b.thread.id === MAIN_THREAD) - Number(a.thread.id === MAIN_THREAD) ||
      b.thread.lastAt.localeCompare(a.thread.lastAt));
    this.searchCache = { query, results };
    return results;
  }

  selectThread(thread: ThreadId) {
    if (thread === this.openThread) return;
    this.ensureThread(thread);
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
    if (!this.replayReady || cursor <= (this.viewed.get(thread) ?? 0)) return;
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
      if (s === "connecting" || s === "replaying") this.replayReady = false;
      if (s === "open") this.replayReady = true;
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

  async createOutgoing(thread: ThreadId, text: string, retryKey?: string): Promise<Outgoing> {
    if (!this.db) throw new Error("IndexedDB unavailable");
    const m: Outgoing = { key: newKey(), thread, text, state: "queued", at: Date.now() };
    const tx = this.db.transaction("outbox", "readwrite");
    await Promise.all([tx.store.put(m), retryKey && tx.store.delete(retryKey), tx.done]);
    if (retryKey) this.outbox.delete(retryKey);
    this.outbox.set(m.key, m);
    this.changed();
    return m;
  }

  async setOutgoingState(key: string, state: "queued" | "sent" | "admitted" | "failed") {
    const m = this.outbox.get(key);
    if (!m || m.state === state || m.state === "admitted" || terminal(m.state)) return;
    const next = this.updateOutgoing(m, state);
    this.changed();
    await this.db?.put("outbox", next);
  }

  async queueCreate(title?: string, from?: ThreadOrigin): Promise<ThreadCreate> {
    if (!this.db) throw new Error("IndexedDB unavailable");
    const c = { key: newKey(), title, from };
    await this.db.put("creates", c);
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
