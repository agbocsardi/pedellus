import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DurableEvent, PreviewEvent, StatusEvent } from "./protocol";

export type ConnState = "offline" | "connecting" | "replaying" | "open";
export type Mode = "boot" | "chat" | "pair" | "update";
export type OutgoingState =
  | "queued"
  | "sent"
  | "admitted"
  | "answered"
  | "failed"
  | "aborted";

export interface Outgoing {
  key: string;
  text: string;
  state: OutgoingState;
  at: number;
}

export interface AgentStatus {
  state: StatusEvent["state"];
  label?: string;
}

interface Db extends DBSchema {
  events: { key: number; value: DurableEvent };
  outbox: { key: string; value: Outgoing };
}

/** Same key alphabet as the protocol's request ids. */
export function newKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * The local store is the render source of truth and a cache, not an archive:
 * losing IndexedDB just means a full replay from the gateway on next hello.
 * All mutations update memory synchronously (so rendering and cursor checks
 * keep event order), then persist.
 */
export class Store {
  events: DurableEvent[] = []; // ascending by cursor
  outbox = new Map<string, Outgoing>();
  preview: PreviewEvent | null = null;
  status: AgentStatus = { state: "idle" };
  connState: ConnState = "offline";
  mode: Mode = "boot";
  device: string | null = null;
  /** Highest durable cursor stored; the hello/replay cursor. */
  cursor: number | null = null;

  private db: IDBPDatabase<Db> | null = null;
  private echoedKeys = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.version;
  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  async init() {
    this.db = await openDB<Db>("durable-app", 1, {
      upgrade(db) {
        db.createObjectStore("events", { keyPath: "cursor" });
        db.createObjectStore("outbox", { keyPath: "key" });
      },
    });
    const events = await this.db.getAll("events");
    events.sort((a, b) => a.cursor - b.cursor);
    this.events = events;
    this.cursor = events.at(-1)?.cursor ?? null;
    for (const ev of events) {
      if (ev.event === "message" && ev.role === "user" && ev.key) {
        this.echoedKeys.add(ev.key);
      }
    }
    for (const m of await this.db.getAll("outbox")) {
      this.outbox.set(m.key, m);
    }
  }

  /**
   * Store a durable event, de-duplicated by cursor. Memory is updated first;
   * the promise resolves only once IndexedDB has the event, so acks sent by
   * the caller never get ahead of what is actually stored.
   */
  async applyDurable(ev: DurableEvent): Promise<{ isNew: boolean; stored: boolean }> {
    if (this.cursor !== null && ev.cursor <= this.cursor) return { isNew: false, stored: true };
    this.events.push(ev);
    this.cursor = ev.cursor;
    this.absorb(ev);
    this.changed();
    const db = this.db;
    if (!db) return { isNew: true, stored: false };
    try {
      await db.put("events", ev);
      return { isNew: true, stored: true };
    } catch (err) {
      console.error("event not persisted; acks stop", err);
      return { isNew: true, stored: false };
    }
  }

  /** Side effects of durable events on the outbox and live preview. */
  private absorb(ev: DurableEvent) {
    if (ev.event === "message") {
      if (ev.role === "user" && ev.key) {
        this.echoedKeys.add(ev.key);
        this.markOutgoing(ev.key, "admitted", ["queued", "sent", "failed"]);
      } else if (ev.role === "assistant" && ev.key && this.preview?.key === ev.key) {
        this.preview = null;
      }
    } else if (ev.event === "settled") {
      const state: OutgoingState = ev.outcome;
      this.markOutgoing(ev.key, state, ["queued", "sent", "admitted"]);
      if (this.preview?.key === ev.key) this.preview = null;
    }
  }

  private markOutgoing(key: string, state: OutgoingState, from: OutgoingState[]) {
    const m = this.outbox.get(key);
    if (!m || !from.includes(m.state)) return;
    m.state = state;
    void this.db?.put("outbox", m);
  }

  hasEcho(key: string): boolean {
    return this.echoedKeys.has(key);
  }

  setPreview(p: PreviewEvent | null) {
    this.preview = p;
    this.changed();
  }

  setStatus(s: AgentStatus) {
    this.status = s;
    this.changed();
  }

  setConn(s: ConnState) {
    if (this.connState !== s) {
      this.connState = s;
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

  async createOutgoing(text: string): Promise<Outgoing> {
    const m: Outgoing = { key: newKey(), text, state: "queued", at: Date.now() };
    this.outbox.set(m.key, m);
    await this.db?.put("outbox", m);
    this.changed();
    return m;
  }

  async setOutgoingState(key: string, state: OutgoingState) {
    const m = this.outbox.get(key);
    if (!m || m.state === state) return;
    m.state = state;
    await this.db?.put("outbox", m);
    this.changed();
  }

  /** Messages that must (re)reach the gateway: never-sent or reply-less. */
  pending(): Outgoing[] {
    return [...this.outbox.values()].filter(
      (m) => m.state === "queued" || m.state === "sent",
    );
  }
}
