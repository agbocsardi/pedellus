import { LIMITS, type PushSubscriptionInfo } from "./protocol";

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
