import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { DB_NAME, DB_VERSION, STORES } from "./db-constants";
import type { CommandInfo, DurableEvent, PresetInfo, ThreadId, ThreadInfo, ThreadOrigin } from "./protocol";

export type OutgoingState = "queued" | "sent" | "admitted" | "answered" | "failed" | "aborted";
/** A file in a queued send that the gateway has not accepted yet (no upload id). */
export type PendingFile = { id: string; name: string; type: string; size: number; uploadId?: string };
export type Outgoing = {
  key: string; thread: ThreadId; text: string; state: OutgoingState; at: number;
  /** Upload ids in send order; set once, never changed for this key. */
  attachments?: string[];
  /** Local files still waiting for an upload id, kept so a reconnect can finish them. */
  pending?: PendingFile[];
  /** IndexedDB blob ids for cleanup; the bytes stay until the turn is over. */
  fileIds?: string[];
  /** Short delivery explanation, e.g. why an upload stopped. */
  note?: string;
};
export type ThreadCreate = { key: string; title?: string; from?: ThreadOrigin; failed?: boolean };
export type Identity = { device?: string; agent?: string; commands?: CommandInfo[]; presets?: PresetInfo[]; uploads?: boolean };
/**
 * Web Push opt-in. `endpoint` is set only once the gateway accepted it; `key`
 * is the gateway VAPID key that subscription was made with.
 */
export type PushState = { endpoint?: string; key?: string; gatewayUnsupported?: boolean };
export type StoredFile = { id: string; name: string; type: string; size: number; blob: Blob };

export interface Db extends DBSchema {
  events: { key: number; value: DurableEvent };
  outbox: { key: string; value: Outgoing };
  files: { key: string; value: StoredFile };
  threads: { key: string; value: ThreadInfo };
  creates: { key: string; value: ThreadCreate };
  view: { key: string; value: { thread: ThreadId; cursor: number } };
  settings: {
    key: "openThread" | "resumeCursor" | "identity" | "push";
    value: ThreadId | number | Identity | PushState;
  };
}
export type AppDb = IDBPDatabase<Db>;

/**
 * Bounded local history. Only events at or below the replay checkpoint are ever dropped (the
 * gateway never resends those), oldest first: each thread keeps its newest `perThread`, and the
 * whole cache its newest `total`. The gateway's own replay window is far smaller (2 000 events).
 */
export const RETENTION = { perThread: 2_000, total: 10_000 } as const;

/** Open (and migrate) the cache. v1 → v2 → v3 never rewrites or drops older records. */
export function openAppDb(blocked: () => void): Promise<AppDb> {
  return openDB<Db>(DB_NAME, DB_VERSION, {
    blocked,
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(STORES.events, { keyPath: "cursor" });
        db.createObjectStore(STORES.outbox, { keyPath: "key" });
      }
      if (oldVersion < 2) {
        db.createObjectStore(STORES.threads, { keyPath: "id" });
        db.createObjectStore(STORES.creates, { keyPath: "key" });
        db.createObjectStore(STORES.view, { keyPath: "thread" });
        db.createObjectStore(STORES.settings);
      }
      // Uploaded/failed file bytes for queued sends (protocol v2, Files).
      if (oldVersion < 3) db.createObjectStore(STORES.files, { keyPath: "id" });
    },
  });
}

/** Everything the store loads at start, read from one snapshot so the checkpoint matches it. */
export async function loadSnapshot(db: AppDb) {
  const tx = db.transaction(["events", "outbox", "threads", "creates", "view", "settings"], "readonly");
  const settings = tx.objectStore("settings");
  const [events, outbox, threads, creates, view, openThread, resumeCursor, identity, push] = await Promise.all([
    // Raw records: the store validates each one, and v1 records may lack fields.
    tx.objectStore("events").getAll() as Promise<unknown[]>, tx.objectStore("outbox").getAll(),
    tx.objectStore("threads").getAll(), tx.objectStore("creates").getAll(), tx.objectStore("view").getAll(),
    settings.get("openThread"), settings.get("resumeCursor"), settings.get("identity"), settings.get("push"), tx.done,
  ]);
  return { events, outbox, threads, creates, view, openThread, resumeCursor, identity, push };
}

/** Drop retired event records; a failure only leaves them for the next pass. */
export async function deleteEvents(db: AppDb, cursors: readonly number[]) {
  if (!cursors.length) return;
  const tx = db.transaction("events", "readwrite");
  await Promise.all([...cursors.map((cursor) => tx.store.delete(cursor)), tx.done]);
}
