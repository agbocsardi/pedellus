/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

// Phase 1: precache the app shell only. The gateway serves dist/ statically,
// so offline the shell opens and the connection simply shows Offline.
// A new app version takes over at once (registerType "autoUpdate"), so a
// reload after a 4426 never lands on the old precached shell again.
self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// -- Web Push ---------------------------------------------------------------
// Payloads are content-free (protocol v2, "Notifications (Web Push)"):
// {"v":2,"thread":"<id>","unread":<n>}. The title is the agent name the app
// cached from `hello`, the body only says that a message arrived in a thread
// whose title the app has cached. No payload text ever reaches the screen.

/** Must match the app's store (src/store.ts). */
const DB_NAME = "durable-app";
const DEFAULT_AGENT = "Durable";
const UNREAD_CAP = 99;
const THREAD_ID = /^(main|t_[A-Za-z0-9_-]{1,40})$/;

type PushPayload = { v: 2; thread: string; unread: number };

/** One IndexedDB read. The cache may be absent, empty or blocked; never throw. */
function read<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB_NAME);
    } catch {
      resolve(undefined);
      return;
    }
    open.onerror = () => resolve(undefined);
    open.onblocked = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const get = db.transaction(store, "readonly").objectStore(store).get(key);
        get.onsuccess = () => resolve(get.result as T | undefined);
        get.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined); // no such store yet
      }
      db.close();
    };
  });
}

/** The push is a hint; anything unexpected falls back to a plain notification. */
function parse(data: PushMessageData | null): PushPayload | null {
  if (!data) return null;
  try {
    const raw: unknown = data.json();
    if (!raw || typeof raw !== "object") return null;
    const { v, thread, unread } = raw as Record<string, unknown>;
    if (v !== 2 || typeof thread !== "string" || !THREAD_ID.test(thread)) return null;
    const count = Number.isInteger(unread) ? Math.min(Math.max(unread as number, 0), UNREAD_CAP) : 0;
    return { v: 2, thread, unread: count };
  } catch {
    return null;
  }
}

type BadgeScope = { setAppBadge?: (contents?: number) => Promise<void> };

async function showPush(event: PushEvent) {
  const payload = parse(event.data);
  const thread = payload?.thread ?? "main";
  const [identity, info] = await Promise.all([
    read<{ agent?: string }>("settings", "identity"),
    read<{ title?: string }>("threads", thread),
  ]);
  const agent = identity?.agent?.trim() || DEFAULT_AGENT;
  const title = thread === "main" ? "" : info?.title?.trim() ?? "";
  await self.registration.showNotification(agent, {
    body: title ? `New message in ${title}` : "New message",
    icon: "/icons/icon-192.png",
    // One notification per thread: a newer push replaces the older one, like
    // the gateway's Topic header.
    tag: thread,
    data: { thread, url: `/?thread=${encodeURIComponent(thread)}` },
  });
  const badge = self.navigator as unknown as BadgeScope;
  if (payload && payload.unread > 0) {
    await badge.setAppBadge?.(payload.unread).catch(() => {}); // best-effort
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

// Focus an open window and tell it which thread to show; otherwise open the
// app at that thread (the app reads `?thread=` on load).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { thread?: string; url?: string } | undefined;
  const thread = typeof data?.thread === "string" && THREAD_ID.test(data.thread) ? data.thread : "main";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((c) => {
      try {
        return new URL(c.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (client) {
      await client.focus();
      client.postMessage({ type: "open-thread", thread });
      return;
    }
    await self.clients.openWindow(data?.url ?? `/?thread=${encodeURIComponent(thread)}`);
  })());
});

export {};
