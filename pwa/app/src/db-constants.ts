// The app's IndexedDB names, shared with the service worker (which reads two cached keys without
// the `idb` wrapper). Dependency-free so `sw.ts` can import it. The names are durable identifiers:
// renaming any of them orphans every installed device's cache.

export const DB_NAME = "durable-app";
export const DB_VERSION = 3;
export const STORES = {
  events: "events",
  outbox: "outbox",
  files: "files",
  threads: "threads",
  creates: "creates",
  view: "view",
  settings: "settings",
} as const;
/** Cross-window outbox change notices (`BroadcastChannel`). */
export const QUEUE_CHANNEL = "durable-app-queue";
/** Shown until the first `hello` names the agent. */
export const DEFAULT_AGENT_NAME = "Pedellus";
