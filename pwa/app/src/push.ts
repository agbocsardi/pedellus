import type { Connection } from "./conn";
import { LIMITS, type PushSubscriptionInfo } from "./protocol";
import type { Store } from "./store";

/**
 * Web Push enrolment for this device. Nothing here runs on its own: the app
 * calls into it only from the owner's tap in the thread menu (protocol v2,
 * "Notifications (Web Push)").
 */

/** The Badging API is not in the DOM lib yet. */
type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export type PushPermission = NotificationPermission | "unsupported";

export type PushAttempt =
  | { kind: "subscribed"; subscription: PushSubscriptionInfo }
  | { kind: "denied" }
  | { kind: "unsupported" }
  | { kind: "failed" };

/**
 * Web Push needs a service worker, PushManager and Notification. On iOS only
 * an installed home-screen app has all three; a Safari tab has no Notification
 * API at all, so it lands here as unsupported.
 */
export function pushSupported(): boolean {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export function pushPermission(): PushPermission {
  return pushSupported() ? Notification.permission : "unsupported";
}

export function clearAppBadge(): void {
  void (navigator as BadgeNavigator).clearAppBadge?.().catch(() => {});
}

/** The gateway's VAPID key is base64url; `applicationServerKey` wants bytes. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The app's registration, or undefined. `serviceWorker.ready` is avoided: with
 * no registration (the dev server has no service worker) it never settles.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

/** The gateway's own bounds (v2.md); a subscription it would reject is not sent. */
function wellFormed(sub: PushSubscriptionInfo): boolean {
  return sub.endpoint.startsWith("https:") && sub.endpoint.length <= LIMITS.pushEndpointChars
    && sub.keys.p256dh.length <= LIMITS.pushP256dhChars && B64URL.test(sub.keys.p256dh)
    && sub.keys.auth.length <= LIMITS.pushAuthChars && B64URL.test(sub.keys.auth);
}

/**
 * Ask for permission. Called only from the tap, before anything slower, so the
 * prompt stays inside the gesture.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

/**
 * Subscribe this browser with the gateway's key. Permission must already be
 * granted (`requestPushPermission`); nothing here prompts.
 */
export async function enablePush(key: string): Promise<PushAttempt> {
  if (!pushSupported()) return { kind: "unsupported" };
  if (Notification.permission !== "granted") return { kind: "denied" };
  try {
    const reg = await activeRegistration();
    if (!reg) return { kind: "failed" };
    const existing = await reg.pushManager.getSubscription();
    // `subscribe()` refuses a second, differently keyed subscription, so a
    // rotated gateway key drops the stale one first.
    if (existing && toBase64Url(existing.options.applicationServerKey ?? null) !== key) await existing.unsubscribe();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(key),
    });
    const json = sub.toJSON();
    const subscription: PushSubscriptionInfo = {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    };
    return wellFormed(subscription) ? { kind: "subscribed", subscription } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** Drop the browser's subscription. Best-effort: nothing to undo is not an error. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await activeRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    /* the browser side is already gone */
  }
}

/** Whether this browser still holds a subscription; a wiped store must not claim "on". */
export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await activeRegistration();
    return (await reg?.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}

function toBase64Url(bytes: ArrayBuffer | null): string | undefined {
  if (!bytes) return undefined;
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The VAPID key this browser's subscription was made with, base64url. A gateway
 * that rotated its key must not keep pushing to a subscription it cannot
 * address, so the app compares this with `push.key`.
 */
export async function subscribedServerKey(): Promise<string | undefined> {
  if (!pushSupported()) return undefined;
  try {
    const reg = await activeRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return toBase64Url(sub?.options.applicationServerKey ?? null);
  } catch {
    return undefined;
  }
}

// -- Enrolment with the gateway ------------------------------------------------------------------

type PushConn = Pick<Connection, "pushKey" | "pushSubscribe" | "pushUnsubscribe">;
type PushStore = Pick<Store, "push" | "setPush">;
/** What the Notifications row shows next: the browser permission it learned, and a receipt. */
export type PushOutcome = { permission?: PushPermission; note?: string };

/** One form for comparing keys: base64url alphabet, no padding (a gateway may send plain base64). */
export function normalizeServerKey(key: string): string {
  return key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Browser subscribe with the gateway's key, then `push.subscribe`. Permission must be granted
 * already; nothing here prompts. On failure nothing stays half on: the browser subscription is
 * dropped and `push.subscribe` is never sent.
 */
async function subscribeDevice(store: PushStore, conn: PushConn, key: string): Promise<{
  permission: PushPermission; note?: string;
}> {
  const attempt = await enablePush(key);
  const permission = pushPermission();
  if (attempt.kind !== "subscribed") {
    return { permission, note: attempt.kind === "denied"
      ? "Notifications are blocked for this app. Allow them in browser settings, then try again."
      : "Could not subscribe this device. Try again." };
  }
  const saved = await conn.pushSubscribe(attempt.subscription);
  if (!saved?.ok) {
    await disablePush();
    if (saved?.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
    return { permission, note: saved
      ? "The gateway did not accept this device. Try again."
      : "Reconnect to finish turning notifications on, then try again." };
  }
  await store.setPush({ endpoint: attempt.subscription.endpoint, key });
  return { permission };
}

/**
 * Learn the gateway's push answer when the menu opens (never asking for permission), and rebuild
 * the subscription when the gateway rotated its VAPID key under a device the owner turned
 * notifications on for. `renewing` is called just before such a rebuild. `undefined`: nothing to say.
 */
export async function refreshPush(store: PushStore, conn: PushConn, renewing: () => void): Promise<PushOutcome | undefined> {
  if (!pushSupported()) return undefined;
  // A cleared store must not claim "on" when the browser dropped it.
  if (store.push.endpoint && !(await hasPushSubscription())) {
    await store.setPush({ endpoint: undefined, key: undefined });
  }
  const res = await conn.pushKey();
  if (!res) return undefined; // offline: nothing to compare against yet
  if (!res.ok) {
    if (res.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
    return undefined;
  }
  if (typeof res.key !== "string" || res.key === "") return undefined;
  const gatewayKey = normalizeServerKey(res.key);
  // Compare against the key the store last saw before overwriting it.
  const rotated = store.push.key !== undefined && store.push.key !== gatewayKey;
  await store.setPush({ gatewayUnsupported: false, key: gatewayKey });
  if (!store.push.endpoint) return undefined;
  if (!rotated && await subscribedServerKey() === gatewayKey) return undefined;
  // The gateway's key changed under a live subscription: rebuild it on the new key rather than
  // leaving pushes the gateway cannot address.
  renewing();
  const renewed = await subscribeDevice(store, conn, gatewayKey);
  if (!renewed.note) return { permission: renewed.permission, note: "Notifications renewed for this device." };
  // The old subscription is gone; say so instead of claiming "on".
  await store.setPush({ endpoint: undefined });
  return renewed;
}

/** The owner's tap on the Notifications row: turn this device's notifications off, or on. */
export async function togglePush(store: PushStore, conn: PushConn, online: boolean): Promise<PushOutcome> {
  if (store.push.endpoint) {
    // Offline the gateway cannot drop the subscription, so nothing here is "off" until it says
    // so; the browser side is kept in step after.
    if (!online) return { note: "Reconnect to turn notifications off." };
    const off = await conn.pushUnsubscribe();
    if (!off?.ok) {
      return { note: off
        ? "The gateway did not confirm that notifications are off. Try again."
        : "Reconnect to turn notifications off." };
    }
    await disablePush();
    await store.setPush({ endpoint: undefined, key: undefined });
    return { note: "Notifications are off." };
  }
  if (!online) return { note: "Reconnect to turn notifications on." };
  // Permission first: the prompt must come straight off the tap.
  const granted = await requestPushPermission();
  if (granted !== "granted") {
    return { permission: granted, note: granted === "denied"
      ? "Notifications are blocked for this app. Allow them in browser settings, then try again."
      : granted === "unsupported"
        ? "This browser cannot receive notifications. On iPhone, open the installed home-screen app."
        : "Notifications were not allowed. Tap again to ask." };
  }
  const key = await conn.pushKey();
  if (!key) return { permission: granted, note: "Reconnect to turn notifications on." };
  if (!key.ok) {
    if (key.error === "unsupported") await store.setPush({ gatewayUnsupported: true });
    return { permission: granted, note: key.error === "unsupported" ? undefined : "Could not reach notifications on this gateway. Try again." };
  }
  if (!key.key) return { permission: granted, note: "The gateway did not send a notification key. Try again." };
  const result = await subscribeDevice(store, conn, key.key);
  return { permission: result.permission, note: result.note ?? "Notifications are on for this device." };
}
