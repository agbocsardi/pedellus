import { DEFAULT_AGENT_NAME, QUEUE_CHANNEL } from "./db-constants";
import {
  loadSnapshot, openAppDb, retireRecords, RETENTION,
  type AppDb, type Identity, type Outgoing, type OutgoingState, type PushState, type StoredFile, type ThreadCreate,
} from "./db";
import {
  MAIN_THREAD, parseDurableEvent,
  type ActivityEvent, type CommandInfo, type DurableEvent, type LoginEvent, type ModelEvent, type PresetInfo,
  type Reaction, type StatusEvent, type ThreadId, type ThreadInfo, type ThreadOrigin,
} from "./protocol";

export type { Outgoing, OutgoingState, PendingFile, PushState, ThreadCreate } from "./db";
export type ConnState = "offline" | "connecting" | "replaying" | "open";
export type Mode = "boot" | "chat" | "pair" | "update";
/** A file picked in the composer, handed to the outbox when its message is sent. */
export type NewAttachment = { id: string; name: string; type: string; size: number; blob: Blob; uploadId?: string };
export type AgentStatus = Pick<StatusEvent, "state" | "label">;
type ChatEvent = Exclude<DurableEvent, { event: "thread" }>;
type LiveStatus = AgentStatus & { turnKey?: string };

const IDLE: AgentStatus = { state: "idle" };
const MAIN: ThreadInfo = { id: MAIN_THREAD, title: "Main", archived: false, createdAt: "", lastAt: "" };

const terminal = (state: OutgoingState) => state === "failed" || state === "answered" || state === "aborted";
const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * The only URLs a login card may open: an `https:` page, or a loopback `http:` one (local testing).
 * A stored or replayed frame is untrusted input; anything else is never handed to `window.open`.
 */
export function openableLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
}

/** Cursors of the questions still open: the latest event for each id, in state `open`. */
function openQuestionCursors(events: readonly ChatEvent[]): Set<number> {
  const latest = new Map<string, Extract<ChatEvent, { event: "question" }>>();
  for (const ev of events) if (ev.event === "question") latest.set(ev.id, ev);
  return new Set([...latest.values()].filter((q) => q.state === "open").map((q) => q.cursor));
}

/** The id of a split message part; `undefined` for anything else. */
const splitId = (ev: ChatEvent) => ev.event === "message" && ev.part !== undefined ? ev.id : undefined;

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
  /** Persisted push enrolment; the service worker reads its own copies. */
  push: PushState = {};
  openThread: ThreadId = MAIN_THREAD;
  connState: ConnState = "offline";
  mode: Mode = "boot";
  private identity?: Identity;
  storageBlocked = false;
  replayReady = false;
  /** Max seen can be ahead of a replay gap; only resumeCursor is safe for hello. */
  cursor: number | null = null;
  /** Highest cursor the gateway was sent in an `ack`; null until the first one. */
  ackedCursor: number | null = null;
  resumeCursor: number | null = null;

  // Status is live; hello resends it rather than replaying it from storage.
  private statuses = new Map<ThreadId, LiveStatus>();
  // Model presets are live too: hello resends each thread's selection.
  private models = new Map<ThreadId, string | null>();
  // A running turn's tool steps are live as well: `activity` replaces them per thread and
  // `settled` (or the answer that carries the same list) ends them.
  private activities = new Map<ThreadId, ActivityEvent>();
  /**
   * Live MCP login offers per thread. Memory only and never persisted: a reload drops the one-time
   * URL, and so does its expiry or the next durable notice in that thread.
   */
  private logins = new Map<ThreadId, LoginEvent>();
  private loginTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private pendingModels = new Map<ThreadId, string>();
  private unfinished = new Map<ThreadId, Set<string>>();
  private viewed = new Map<ThreadId, number>();
  /** Split messages by `${thread}\u0000${id}`: the parts received so far, keyed by `i`. */
  private splitMessages = new Map<string, { n: number; texts: Map<number, string> }>();
  private db: AppDb | null = null;
  private queueChanges: BroadcastChannel | undefined;
  private opening: Promise<void> | undefined;
  /** The cache has been read into memory once; a reopen after `dispose()` only reattaches. */
  private loaded = false;
  private disposed = false;
  /** A created thread to open once it is known, if the owner is still where they created it. */
  private follow: { thread: ThreadId; from: ThreadId } | undefined;
  /** Stored `thread` events superseded by a newer one for the same thread; retired with the rest. */
  private staleThreadEvents: number[] = [];
  private durableWriteFailed = false;
  private seenCursors = new Set<number>();
  private threadCursors = new Map<ThreadId, number>();
  private echoedKeys = new Map<ThreadId, Set<string>>();
  /**
   * The latest durable reaction per (thread, message), by cursor, so a badge is one lookup per
   * render instead of a scan of the thread's whole event log.
   */
  private reactions = new Map<ThreadId, Map<string, { emoji: Reaction | null; cursor: number }>>();
  private searchText = new Map<number, { text: string; lower: string }>();
  private searchCache?: { query: string; remote: ReadonlySet<string> | undefined; results: { thread: ThreadInfo; snippet?: string }[] };
  private listeners = new Set<() => void>();
  private version = 0;
  /** Version of the last change that may affect every thread. */
  private broadVersion = 0;
  /** Version of the last change scoped to one thread (or to one of its side threads). */
  private threadVersions = new Map<ThreadId, number>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  /** Changes with every update. */
  getSnapshot = () => this.version;
  /**
   * Changes only when something shown in `thread` may have: its events, outbox rows, status,
   * activity, login, metadata or a side thread forked from it, or a change not scoped to a thread.
   */
  threadSnapshot = (thread: ThreadId) => Math.max(this.broadVersion, this.threadVersions.get(thread) ?? 0);

  /** `undefined`: may affect anything; a thread id: only that thread (and its parent); `null`: no thread view. */
  private changed(scope?: ThreadId | null) {
    this.version++;
    if (scope === undefined) this.broadVersion = this.version;
    else if (scope !== null) {
      this.threadVersions.set(scope, this.version);
      // A side thread's title and signals show as a fork chip in its parent.
      const parent = this.threads.get(scope)?.origin?.thread;
      if (parent !== undefined) this.threadVersions.set(parent, this.version);
    }
    for (const fn of this.listeners) fn();
  }

  get agentName() { return this.identity?.agent ?? DEFAULT_AGENT_NAME; }
  /** The gateway's last advertised commands; undefined until a hello listed them. */
  get commands() { return this.identity?.commands; }
  /** The gateway's last advertised model presets; undefined until a hello listed them. */
  get presets() { return this.identity?.presets; }
  /** `hello.uploads`: whether this gateway accepts files (protocol v2, Files). */
  get uploads() { return this.identity?.uploads === true; }

  /**
   * Open the cache and load it. Safe to call again after `dispose()` (React StrictMode mounts
   * twice): a second call while opening joins the first, and a reopen only reattaches storage.
   */
  init(): Promise<void> {
    this.disposed = false;
    // Already open: never a second handle over the first.
    if (this.db && this.loaded) return Promise.resolve();
    return this.opening ??= this.open().finally(() => { this.opening = undefined; });
  }

  /** Release storage, the cross-window channel and every timer. `init()` may follow. */
  dispose() {
    this.disposed = true;
    for (const timer of this.loginTimers.values()) clearTimeout(timer);
    this.loginTimers.clear();
    this.logins.clear();
    this.queueChanges?.close();
    this.queueChanges = undefined;
    this.db?.close();
    this.db = null;
  }

  private async open() {
    const db = await openAppDb(() => {
      this.storageBlocked = true;
      this.changed();
    });
    if (this.disposed) {
      db.close();
      return;
    }
    let closed = false;
    db.onversionchange = () => {
      closed = true;
      db.close();
      if (this.db === db) this.db = null;
    };
    this.storageBlocked = false;
    this.queueChanges ??= typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(QUEUE_CHANNEL);
    if (this.loaded) {
      if (this.db && this.db !== db) this.db.close();
      this.db = db;
      this.changed();
      return;
    }
    // Load the replay checkpoint and everything it covers from one snapshot.
    const snap = await loadSnapshot(db).catch((err) => { db.close(); throw err; });
    if (this.disposed) {
      db.close();
      return;
    }
    if (!closed) this.db = db;
    const cachedThreads = new Set(snap.threads.map((t) => t.id));
    for (const t of snap.threads) this.cacheThread(t);
    for (const m of snap.outbox) {
      const thread = m.thread ?? MAIN_THREAD;
      this.ensureThread(thread);
      this.outbox.set(m.key, { ...m, thread });
    }
    // IndexedDB returns events in primary-key (cursor) order. Normalize old records on read; the
    // upgrade never rewrites or drops the v1 log/outbox. A record that is not a well-formed event
    // (a corrupt or foreign write) is skipped rather than taking the UI down.
    for (const raw of snap.events) {
      const stored = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const legacy = stored.thread === undefined;
      const ev = parseDurableEvent({ ...stored, type: "event", thread: stored.thread ?? MAIN_THREAD });
      if (!ev) continue;
      this.cursor = ev.cursor;
      this.seenCursors.add(ev.cursor);
      if (ev.event === "thread") {
        const previous = this.threadCursors.get(ev.thread.id);
        if (previous !== undefined) this.staleThreadEvents.push(previous);
        this.threadCursors.set(ev.thread.id, ev.cursor);
        if (!cachedThreads.has(ev.thread.id)) this.cacheThread(ev.thread);
      } else {
        // Existing v2 caches have no checkpoint. Replay from the last v1
        // cursor (or the beginning) rather than trusting their high-water mark.
        if (legacy) this.resumeCursor = ev.cursor;
        this.absorbChat(ev);
      }
    }
    for (const c of snap.creates) this.creates.set(c.key, c);
    for (const v of snap.view) this.viewed.set(v.thread, v.cursor);
    if (typeof snap.openThread === "string") {
      this.ensureThread(snap.openThread);
      this.openThread = snap.openThread;
    }
    if (typeof snap.resumeCursor === "number") this.resumeCursor = snap.resumeCursor;
    if (typeof snap.identity === "object" && snap.identity) this.identity = snap.identity as Identity;
    if (typeof snap.push === "object" && snap.push) this.push = snap.push as PushState;
    this.loaded = true;
    this.changed();
    void this.retire().catch(console.error);
  }

  /** Another window changed the outbox or the create queue. Returns the unsubscribe. */
  onQueueChange(listener: () => void): () => void {
    const channel = this.queueChanges;
    channel?.addEventListener("message", listener);
    return () => channel?.removeEventListener("message", listener);
  }

  async reloadQueue() {
    if (!this.db) return;
    const tx = this.db.transaction(["outbox", "creates"], "readonly");
    const [outbox, creates] = await Promise.all([
      tx.objectStore("outbox").getAll(), tx.objectStore("creates").getAll(), tx.done,
    ]);
    // The committed snapshot also accounts for deletions (retry/discard)
    // made in another window. Normalize legacy entries as at startup.
    this.outbox = new Map(outbox.map((m) => {
      const thread = m.thread ?? MAIN_THREAD;
      this.ensureThread(thread);
      return [m.key, { ...m, thread }];
    }));
    this.creates = new Map(creates.map((c) => [c.key, c]));
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
      const previous = this.threadCursors.get(ev.thread.id);
      if (ev.cursor > (previous ?? 0)) {
        if (previous !== undefined) this.staleThreadEvents.push(previous);
        this.threadCursors.set(ev.thread.id, ev.cursor);
        const lastAt = prev && Date.parse(prev.lastAt) > Date.parse(ev.thread.lastAt) ? prev.lastAt : ev.thread.lastAt;
        info = { ...ev.thread, lastAt };
        this.cacheThread(info);
      } else {
        this.staleThreadEvents.push(ev.cursor);
      }
      if (ev.thread.id === this.follow?.thread) {
        if (this.openThread === this.follow.from) this.selectThread(ev.thread.id);
        this.follow = undefined;
      }
    } else {
      outgoing = this.absorbChat(ev);
      const prev = this.threads.get(ev.thread);
      if (prev && "at" in ev && Date.parse(ev.at) > (Date.parse(prev.lastAt) || 0)) {
        info = { ...prev, lastAt: ev.at };
        this.cacheThread(info);
      }
    }
    this.changed(ev.event === "thread" ? ev.thread.id : ev.thread);
    if (!this.db || this.durableWriteFailed) return false;
    try {
      const tx = this.db.transaction(["events", "outbox", "threads"], "readwrite");
      await Promise.all([
        tx.objectStore("events").put(ev),
        outgoing && this.persistReceipt(tx.objectStore("outbox"), outgoing, ev.event === "settled"),
        info && tx.objectStore("threads").put(info),
        tx.done,
      ]);
      // The turn is over: the cached bytes are no longer needed for a retry.
      // A `failed` entry keeps them so Retry can upload a fresh copy.
      if (outgoing?.fileIds?.length && (outgoing.state === "answered" || outgoing.state === "aborted")) {
        void this.deleteFiles(outgoing.fileIds).catch(console.error);
      }
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
      void this.retire().catch(console.error);
    }
    return true;
  }

  /**
   * Keep local history bounded (`RETENTION`): drop the oldest events at or below the replay
   * checkpoint, which the gateway never resends, from memory and from IndexedDB. What the UI still
   * acts on stays: an open question's card, and a long message unless all its parts go. A user
   * message's outbox row goes with its echo, so an admitted send can never come back as "Not
   * sent" once the echo that hid it is gone. Superseded `thread` snapshots go too.
   */
  private async retire() {
    const floor = this.resumeCursor ?? 0;
    if (!this.db || this.durableWriteFailed || floor === 0) return;
    const dropped: number[] = [];
    /** User echoes being retired, with the thread that must match their outbox row. */
    const echoes: { key: string; thread: ThreadId }[] = [];
    const fileIds: string[] = [];
    /** Retire `thread`'s oldest retirable events, in cursor order, while `take` accepts them. */
    const cut = (thread: ThreadId, take: (ev: ChatEvent, taken: number) => boolean) => {
      const events = this.events.get(thread);
      if (!events) return;
      const open = openQuestionCursors(events);
      const out = new Set<number>();
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev.cursor > floor || !take(ev, out.size)) break;
        if (!open.has(ev.cursor)) out.add(i);
      }
      // Never split a long message: all its parts go when every one is at or below the
      // checkpoint, otherwise none does.
      const parts = new Map<string, number[]>();
      events.forEach((ev, i) => {
        const id = splitId(ev);
        if (id !== undefined) parts.set(id, [...parts.get(id) ?? [], i]);
      });
      for (const [, indices] of parts) {
        if (!indices.some((i) => out.has(i))) continue;
        const whole = indices.every((i) => events[i].cursor <= floor);
        for (const i of indices) {
          if (whole) out.add(i);
          else out.delete(i);
        }
      }
      if (!out.size) return;
      const removed = events.filter((_, i) => out.has(i));
      this.events.set(thread, events.filter((_, i) => !out.has(i)));
      dropped.push(...this.forget(thread, removed, echoes, fileIds));
    };
    for (const thread of [...this.events.keys()]) {
      const excess = (this.events.get(thread)?.length ?? 0) - RETENTION.perThread;
      if (excess > 0) cut(thread, (_ev, taken) => taken < excess);
    }
    let total = 0;
    for (const events of this.events.values()) total += events.length;
    if (total > RETENTION.total) {
      const old: number[] = [];
      for (const events of this.events.values()) {
        const open = openQuestionCursors(events);
        for (const ev of events) if (ev.cursor <= floor && !open.has(ev.cursor)) old.push(ev.cursor);
      }
      old.sort((a, b) => a - b);
      const threshold = old[Math.min(total - RETENTION.total, old.length) - 1];
      if (threshold !== undefined) for (const thread of [...this.events.keys()]) cut(thread, (ev) => ev.cursor <= threshold);
    }
    const stale = this.staleThreadEvents.filter((cursor) => cursor <= floor);
    this.staleThreadEvents = this.staleThreadEvents.filter((cursor) => cursor > floor);
    for (const cursor of stale) this.seenCursors.delete(cursor);
    dropped.push(...stale);
    if (!dropped.length) return;
    if (dropped.length > stale.length) this.changed();
    // The outbox rows go by durable echo key in the same transaction, whatever this store's
    // in-memory copy says: another window may hold the row this one never saw.
    const pruned = await retireRecords(this.db, dropped, echoes).catch((err) => {
      console.error("retention did not finish", err);
      return [];
    });
    if (echoes.length) this.queueChanges?.postMessage(null);
    const ids = [...fileIds, ...pruned];
    if (ids.length) await this.deleteFiles(ids);
  }

  /**
   * Forget the derived state of retired events; returns their cursors. A user echo also names its
   * outbox row by key for `retireRecords` to delete — by thread identity, straight from the
   * transaction, never by this store's possibly stale in-memory copy.
   */
  private forget(
    thread: ThreadId, removed: ChatEvent[], echoes: { key: string; thread: ThreadId }[], fileIds: string[],
  ): number[] {
    this.searchCache = undefined;
    for (const ev of removed) {
      this.seenCursors.delete(ev.cursor);
      this.searchText.delete(ev.cursor);
      if (ev.event === "message" && ev.part) this.splitMessages.delete(`${thread}\u0000${ev.id}`);
      if (ev.event === "message" && ev.role === "user" && ev.key !== undefined) {
        echoes.push({ key: ev.key, thread });
        const m = this.outbox.get(ev.key);
        if (m && m.thread === thread) {
          fileIds.push(...m.fileIds ?? []);
          this.outbox.delete(ev.key);
        }
      }
      if (ev.event === "reaction" && this.reactions.get(thread)?.get(ev.message)?.cursor === ev.cursor) {
        this.reactions.get(thread)!.delete(ev.message);
      }
    }
    if (!this.events.get(thread)?.length) this.events.delete(thread);
    return removed.map((ev) => ev.cursor);
  }

  private absorbChat(ev: ChatEvent): Outgoing | undefined {
    this.ensureThread(ev.thread);
    if (ev.event === "reaction") {
      // Latest by cursor wins, so a clear is never shadowed by an earlier reaction, and a replay
      // that arrives out of order cannot move a badge backwards.
      let seen = this.reactions.get(ev.thread);
      if (!seen) this.reactions.set(ev.thread, seen = new Map());
      const previous = seen.get(ev.message);
      if (previous === undefined || ev.cursor > previous.cursor) seen.set(ev.message, { emoji: ev.emoji, cursor: ev.cursor });
    }
    if (ev.event === "message") {
      const text = normalize(ev.text);
      this.searchText.set(ev.cursor, { text, lower: text.toLowerCase() });
      this.searchCache = undefined;
      if (ev.part) this.absorbPart(ev.thread, ev.id, ev.part.n, ev.part.i, ev.text);
    }
    let events = this.events.get(ev.thread);
    if (!events) this.events.set(ev.thread, events = []);
    let i = events.length;
    while (i > 0 && events[i - 1].cursor > ev.cursor) i--;
    events.splice(i, 0, ev);
    if (ev.event === "message" && ev.role === "notice") this.clearLogin(ev.thread);
    if (ev.event === "message" && ev.role === "user" && ev.key) {
      let keys = this.echoedKeys.get(ev.thread);
      if (!keys) this.echoedKeys.set(ev.thread, keys = new Set());
      keys.add(ev.key);
      let unfinished = this.unfinished.get(ev.thread);
      if (!unfinished) this.unfinished.set(ev.thread, unfinished = new Set());
      unfinished.add(ev.key);
      const m = this.outgoing(ev.thread, ev.key);
      if (m && (m.state === "queued" || m.state === "sent")) {
        return this.updateOutgoing(m, "admitted");
      }
    } else if (ev.event === "settled" || (ev.event === "message" && ev.role === "assistant" && this.answerEnded(ev))) {
      this.activities.delete(ev.thread);
      const unfinished = this.unfinished.get(ev.thread);
      if (ev.key && unfinished?.delete(ev.key) && !unfinished.size) this.unfinished.delete(ev.thread);
      if (ev.key && this.statuses.get(ev.thread)?.turnKey === ev.key) this.statuses.delete(ev.thread);
      if (ev.event === "settled") {
        const m = this.outgoing(ev.thread, ev.key);
        if (m && !terminal(m.state)) return this.updateOutgoing(m, ev.outcome);
      }
    }
  }

  /**
   * Whether this assistant message is the end of its turn: a message that fits one frame, or a
   * split one with every part received (protocol v2, "Long messages"). Every part carries the
   * same `key`, so ending the turn on an earlier one would report the thread idle, and drop its
   * status and activity, while the rest of the answer is still on the wire. A split whose parts
   * are not all here stays open; the `settled` that follows the last part closes it regardless.
   */
  private answerEnded(ev: Extract<ChatEvent, { event: "message" }>): boolean {
    if (ev.part === undefined) return true;
    return this.splitMessage(ev.thread, ev.id)?.complete === true;
  }

  /** Record one part of a split message (protocol v2, "Long messages"); a replay may repeat one. */
  private absorbPart(thread: ThreadId, id: string, n: number, index: number, text: string) {
    const key = `${thread}\u0000${id}`;
    let split = this.splitMessages.get(key);
    if (!split) this.splitMessages.set(key, split = { n, texts: new Map() });
    split.n = Math.max(split.n, n);
    split.texts.set(index, text);
  }

  /**
   * A split message's text as received so far, joined in part order, and whether every one of its
   * `n` parts arrived. `undefined` for a message that was never split.
   */
  splitMessage(thread: ThreadId, id: string): { text: string; complete: boolean } | undefined {
    const split = this.splitMessages.get(`${thread}\u0000${id}`);
    if (!split) return undefined;
    const texts = [...split.texts].sort((left, right) => left[0] - right[0]).map(([, text]) => text);
    return { text: texts.join(""), complete: texts.length === split.n };
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
    this.changed(null);
  }

  async mergeThreads(list: ThreadInfo[], refresh = false) {
    if (refresh) this.threadListUnavailable = false;
    // The gateway omits older archives from the default listing. Keep known
    // metadata so cached messages and origin links stay navigable.
    for (const t of list) this.cacheThread(t);
    const updates = [...list];
    if (refresh) {
      const listed = new Set(list.map((t) => t.id));
      for (const t of this.threads.values()) {
        if (!listed.has(t.id)) {
          const unconfirmed = this.markThreadUnconfirmed(t.id);
          if (unconfirmed) updates.push(unconfirmed);
        }
      }
    }
    this.changed();
    if (!this.db) return;
    const tx = this.db.transaction("threads", "readwrite");
    await Promise.all([...updates.map((t) => tx.store.put(t)), tx.done]);
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

  canWrite(thread: ThreadId) {
    const t = this.threads.get(thread);
    return thread === MAIN_THREAD || !!t?.createdAt && !t.archived;
  }

  // A full list includes all open threads. If omitted, cached open metadata
  // is no longer enough to write to that thread.
  markThreadUnconfirmed(id: ThreadId) {
    const t = this.threads.get(id);
    if (id === MAIN_THREAD || !t?.createdAt || t.archived) return;
    const unconfirmed = { ...t, createdAt: "" };
    this.cacheThread(unconfirmed);
    this.changed(id);
    return unconfirmed;
  }

  searchThreads(input: string, remote?: ReadonlySet<string>) {
    const titleQuery = input.toLowerCase();
    const query = normalize(input).toLowerCase();
    if (this.searchCache?.query === titleQuery && this.searchCache.remote === remote) return this.searchCache.results;
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
      const title = t.id === MAIN_THREAD ? `Main ${this.agentName} ${t.title}` : t.title;
      if (snippet !== undefined || title.toLowerCase().includes(titleQuery) || remote?.has(t.id)) {
        results.push({ thread: t, snippet });
      }
    }
    results.sort((a, b) => Number(b.thread.id === MAIN_THREAD) - Number(a.thread.id === MAIN_THREAD) ||
      b.thread.lastAt.localeCompare(a.thread.lastAt));
    this.searchCache = { query: titleQuery, remote, results };
    return results;
  }

  /**
   * A `thread.create` made from `from` succeeded: open the new thread, now or once its `thread`
   * event arrives, but only while the owner is still in the thread they created it from.
   */
  followCreated(thread: ThreadId, from: ThreadId) {
    if (from !== this.openThread) return;
    if (this.threads.has(thread)) this.selectThread(thread);
    else this.follow = { thread, from };
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
      // A reaction or a settlement changes a message's state, not the thread's read state.
      if (events[i].event !== "settled" && events[i].event !== "reaction") return events[i].cursor;
    }
    return 0;
  }

  isUnread(thread: ThreadId): boolean {
    return this.latestViewable(thread) > (this.viewed.get(thread) ?? 0);
  }

  markViewed(thread: ThreadId, cursor: number) {
    if (!this.replayReady || cursor <= (this.viewed.get(thread) ?? 0)) return;
    this.viewed.set(thread, cursor);
    this.changed(thread);
    void this.db?.put("view", { thread, cursor }).catch(console.error);
  }

  status(thread: ThreadId): AgentStatus { return this.statuses.get(thread) ?? IDLE; }

  /**
   * The owner's durable reaction on one message: an emoji, `null` when it was cleared, or
   * `undefined` when this device has seen no reaction event for it. Only the latest event per
   * (`message`, `by`) counts, so a clear is not shadowed by an earlier reaction.
   */
  reaction(thread: ThreadId, messageId: string): Reaction | null | undefined {
    return this.reactions.get(thread)?.get(messageId)?.emoji;
  }

  resetStatuses() {
    this.statuses.clear();
    this.changed();
  }

  /** Confirmed preset: a name, null (custom model), or undefined (not reported yet). */
  model(thread: ThreadId): string | null | undefined { return this.models.get(thread); }
  pendingModel(thread: ThreadId): string | undefined { return this.pendingModels.get(thread); }

  resetModels() {
    this.models.clear();
    this.pendingModels.clear();
    this.changed();
  }

  /** The live tool steps of this thread's running turn; `settled` clears them. */
  activity(thread: ThreadId): ActivityEvent | undefined { return this.activities.get(thread); }

  /** The thread's offered MCP login, if one is live and unexpired. Never read from storage. */
  login(thread: ThreadId): LoginEvent | undefined {
    // A pure read: renders call this. The expiry timer set in `setLogin` removes the offer; until
    // it fires (a throttled background timer can be late) an expired offer is just not shown.
    const login = this.logins.get(thread);
    return login !== undefined && Date.parse(login.expiresAt) > Date.now() ? login : undefined;
  }

  setLogin(ev: LoginEvent) {
    const expiresAtMs = Date.parse(ev.expiresAt);
    if (!openableLoginUrl(ev.url) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
    this.clearLogin(ev.thread);
    this.logins.set(ev.thread, ev);
    const timer = setTimeout(() => {
      this.loginTimers.delete(ev.thread);
      if (this.logins.get(ev.thread) === ev) {
        this.logins.delete(ev.thread);
        this.changed(ev.thread);
      }
    }, Math.max(0, Math.min(expiresAtMs - Date.now(), 2_147_483_647)));
    this.loginTimers.set(ev.thread, timer);
    this.changed(ev.thread);
  }

  private clearLogin(thread: ThreadId) {
    const timer = this.loginTimers.get(thread);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.loginTimers.delete(thread);
    }
    if (this.logins.delete(thread)) this.changed(thread);
  }

  resetActivities() {
    this.activities.clear();
    this.changed();
  }

  setActivity(ev: ActivityEvent) {
    this.activities.set(ev.thread, ev);
    this.changed(ev.thread);
  }

  setModel(ev: Pick<ModelEvent, "thread" | "preset">) {
    this.models.set(ev.thread, ev.preset);
    this.pendingModels.delete(ev.thread);
    this.changed(null);
  }

  setPendingModel(thread: ThreadId, preset: string | undefined) {
    if (preset === undefined) this.pendingModels.delete(thread);
    else this.pendingModels.set(thread, preset);
    this.changed(null);
  }

  setStatus(s: StatusEvent) {
    // Status has no key. In each thread the oldest unfinished admission runs
    // first; hold onto its key as new messages are admitted behind it.
    const running = s.state === "queued" || s.state === "thinking" || s.state === "tool";
    const turnKey = running ? this.statuses.get(s.thread)?.turnKey ??
      this.unfinished.get(s.thread)?.values().next().value : undefined;
    this.statuses.set(s.thread, { state: s.state, label: s.label, turnKey });
    this.changed(s.thread);
  }

  notePreview(thread: ThreadId, key: string) {
    // If available, the preview identifies the turn directly. Never use its text.
    const status = this.statuses.get(thread);
    if (status && status.state !== "idle" && status.state !== "error" && this.unfinished.get(thread)?.has(key)) {
      status.turnKey = key;
    }
  }

  setConn(s: ConnState) {
    if (this.connState !== s) {
      this.connState = s;
      if (s === "connecting" || s === "replaying") this.replayReady = false;
      if (s === "open") this.replayReady = true;
      if (s === "offline") {
        this.statuses.clear();
        // A create reply that is still owed is lost with the stream; don't jump later.
        this.follow = undefined;
      }
      this.changed();
    }
  }

  /** The gateway holds an `ack` for this cursor; drives "acked everything" UI. */
  setAcked(cursor: number) {
    if (this.ackedCursor !== null && cursor <= this.ackedCursor) return;
    this.ackedCursor = cursor;
    this.changed(null);
  }

  setMode(m: Mode) {
    if (this.mode !== m) {
      this.mode = m;
      this.changed();
    }
  }

  setIdentity(device: string | undefined, agent: string | undefined, commands: CommandInfo[] | undefined,
    presets: PresetInfo[] | undefined, uploads: boolean | undefined) {
    device ??= this.identity?.device;
    commands ??= this.identity?.commands;
    presets ??= this.identity?.presets;
    uploads ??= this.identity?.uploads;
    if (this.identity?.device === device && this.identity?.agent === agent
      && JSON.stringify(this.identity?.commands) === JSON.stringify(commands)
      && JSON.stringify(this.identity?.presets) === JSON.stringify(presets)
      && this.identity?.uploads === uploads) return;
    this.identity = { device, agent, commands, presets, uploads };
    this.searchCache = undefined;
    this.changed();
    void this.db?.put("settings", this.identity, "identity").catch(console.error);
  }

  /** Merge a push state change; unchanged values do not re-render. */
  async setPush(patch: PushState) {
    const next: PushState = { ...this.push, ...patch };
    if (next.endpoint === this.push.endpoint && next.key === this.push.key
      && next.gatewayUnsupported === this.push.gatewayUnsupported) return;
    this.push = next;
    this.changed(null);
    await this.db?.put("settings", next, "push").catch(console.error);
  }

  /** Queue a message with its files; the blob cache and the outbox commit together. */
  async createOutgoing(thread: ThreadId, text: string, retryKey?: string,
    picked: NewAttachment[] = []): Promise<Outgoing> {
    if (!this.db) throw new Error("IndexedDB unavailable");
    const tx = this.db.transaction(["outbox", "files"], "readwrite");
    const old = retryKey ? await tx.objectStore("outbox").get(retryKey) : undefined;
    const m: Outgoing = { key: newKey(), thread, text, state: "queued", at: Date.now() };
    const cache: StoredFile[] = [];
    if (picked.length) {
      m.pending = picked.map(({ id, name, type, size, uploadId }) =>
        ({ id, name, type, size, ...(uploadId ? { uploadId } : {}) }));
      m.fileIds = picked.map((f) => f.id);
      for (const f of picked) {
        if (!f.uploadId) cache.push({ id: f.id, name: f.name, type: f.type, size: f.size, blob: f.blob });
      }
    } else if (old?.pending?.length) {
      // Retry: upload a fresh copy whenever the bytes are still cached, because
      // an admitted send has already consumed its upload ids (v2.md, Files).
      m.fileIds = old.fileIds;
      m.pending = [];
      for (const f of old.pending) {
        const kept = await tx.objectStore("files").get(f.id);
        if (kept) {
          cache.push(kept);
          m.pending.push({ id: f.id, name: f.name, type: f.type, size: f.size });
        } else {
          m.pending.push({ ...f });
        }
      }
    } else if (old?.attachments?.length) {
      // No cached bytes to upload again: keep the original ids rather than
      // silently sending the text without its files.
      m.attachments = old.attachments;
      m.fileIds = old.fileIds;
    }
    await Promise.all([
      tx.objectStore("outbox").put(m),
      ...cache.map((f) => tx.objectStore("files").put(f)),
      retryKey && tx.objectStore("outbox").delete(retryKey),
      tx.done,
    ]);
    if (retryKey) this.outbox.delete(retryKey);
    this.outbox.set(m.key, m);
    this.queueChanges?.postMessage(null);
    this.changed(thread);
    return m;
  }

  async discardOutgoing(key: string) {
    if (!this.db) throw new Error("IndexedDB unavailable");
    const m = this.outbox.get(key);
    await this.db.delete("outbox", key);
    if (m?.fileIds?.length) void this.deleteFiles(m.fileIds).catch(console.error);
    this.outbox.delete(key);
    this.queueChanges?.postMessage(null);
    this.changed(m?.thread ?? null);
  }

  async setOutgoingState(key: string, state: "queued" | "sent" | "admitted" | "failed", note?: string) {
    const m = this.outbox.get(key);
    if (!m || m.state === state || m.state === "admitted" || terminal(m.state)) return;
    const next = this.updateOutgoing(m, state);
    if (note) next.note = note;
    this.changed(m.thread);
    if (!this.db) return;
    const tx = this.db.transaction("outbox", "readwrite");
    await Promise.all([this.persistReceipt(tx.store, next), tx.done]);
  }

  /** The cached bytes for a queued file, if this device still has them. */
  async fileBlob(id: string): Promise<Blob | undefined> {
    return (await this.db?.get("files", id))?.blob;
  }

  /** Record one accepted upload id on a queued send; never changes an existing set. */
  async setPendingUploadId(key: string, fileId: string, uploadId: string): Promise<Outgoing | undefined> {
    if (!this.db) return undefined;
    const tx = this.db.transaction("outbox", "readwrite");
    const saved = await tx.store.get(key);
    if (!saved?.pending?.length || saved.attachments?.length) {
      await tx.done;
      return undefined;
    }
    const next = { ...saved, pending: saved.pending.map((p) => p.id === fileId ? { ...p, uploadId } : p) };
    await Promise.all([tx.store.put(next), tx.done]);
    this.outbox.set(key, next);
    this.changed(next.thread);
    this.queueChanges?.postMessage(null);
    return next;
  }

  /**
   * Once every queued file has an upload id, freeze them onto the entry in send
   * order. A later resend of the same key sends exactly these ids.
   */
  async promotePending(key: string): Promise<Outgoing | undefined> {
    if (!this.db) return undefined;
    const tx = this.db.transaction("outbox", "readwrite");
    const saved = await tx.store.get(key);
    if (!saved?.pending?.length || saved.attachments?.length || saved.pending.some((p) => !p.uploadId)) {
      await tx.done;
      return undefined;
    }
    const next = { ...saved, attachments: saved.pending.map((p) => p.uploadId!) };
    await Promise.all([tx.store.put(next), tx.done]);
    this.outbox.set(key, next);
    this.changed(next.thread);
    this.queueChanges?.postMessage(null);
    return next;
  }

  async deleteFiles(ids: string[]) {
    if (!this.db || !ids.length) return;
    const tx = this.db.transaction("files", "readwrite");
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }

  private async persistReceipt(store: {
    get(key: string): Promise<Outgoing | undefined>;
    put(value: Outgoing): Promise<string>;
  }, next: Outgoing, settled = false) {
    const saved = await store.get(next.key);
    // Another window may already have advanced or discarded this entry.
    if (saved && !terminal(saved.state) &&
        (saved.state !== "admitted" || settled)) await store.put(next);
  }

  async queueCreate(title?: string, from?: ThreadOrigin): Promise<ThreadCreate> {
    if (!this.db) throw new Error("IndexedDB unavailable");
    const c = { key: newKey(), title, from };
    await this.db.put("creates", c);
    this.creates.set(c.key, c);
    this.queueChanges?.postMessage(null);
    this.changed(null);
    return c;
  }

  clearForkRejection() {
    if (!this.forkRejected) return;
    this.forkRejected = false;
    this.changed(null);
  }

  async finishCreate(c: ThreadCreate, ok: boolean, rejectedFork = false) {
    if (ok || rejectedFork) {
      await this.db?.delete("creates", c.key);
      this.creates.delete(c.key);
      if (rejectedFork) this.forkRejected = true;
      this.queueChanges?.postMessage(null);
    } else {
      const failed = { ...c, failed: true };
      await this.db?.put("creates", failed);
      this.creates.set(c.key, failed);
    }
    this.changed(null);
  }

  /** Messages that must (re)reach the gateway: never-sent or reply-less. */
  pending(): Outgoing[] {
    return [...this.outbox.values()].filter((m) => m.state === "queued" || m.state === "sent");
  }
}
