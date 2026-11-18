/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

// Phase 1: precache the app shell only. The gateway serves dist/ statically,
// so offline the shell opens and the connection simply shows Offline.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Phase 2 will add the Web Push handler here: a `push` listener with
// content-free payloads ("New message" / "Task finished" + deep link) and a
// `notificationclick` focus/deep-link handler. Deliberately not in phase 1.

export {};
