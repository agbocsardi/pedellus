/**
 * Web Push for the app channel: VAPID configuration, one-time key generation and the bounded
 * sender.
 *
 * The private key is referenced by environment variable name in config and read once at gateway
 * start; it never leaves this process, is never stored in the app channel state, and is never
 * logged. The push payload is content-free (`{v:2, thread, unread}`), so message text never
 * reaches a push service, a service worker or a notification body.
 *
 * Sends are bounded: a request timeout, one send in flight per device, and a coalesced follow-up
 * carrying the latest unread count. A 404/410 answer means the subscription is gone and is
 * removed; any other failure is not retried, because the next message tries again.
 */
import { createHash } from "node:crypto";

import { APP_LIMITS, validVapidPrivateKey, type AppPushSubscription } from "./app-protocol.js";

/** The strict `app.push` config block: a subject, the public key, and the env var naming the private key. */
export type AppPushConfig = {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKeyEnv: string;
};

/** Resolved push options: the private key itself, read from the named environment variable. */
export type AppPushOptions = {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
  /** Test seam: a transport that speaks to a synthetic endpoint instead of `web-push`. */
  readonly transport?: AppPushTransport;
};

/** One outgoing push, before encryption; `web-push` fills in RFC 8291/8292. */
export type AppPushRequest = {
  readonly subscription: AppPushSubscription;
  readonly payload: string;
  readonly topic: string;
  readonly ttlSeconds: number;
  readonly urgency: "normal";
  readonly timeoutMs: number;
};

export type AppPushTransport = (request: AppPushRequest) => Promise<{ readonly statusCode: number }>;

export type PushKeyPair = { readonly publicKey: string; readonly privateKey: string };

export const PUSH_TTL_SECONDS = 24 * 60 * 60;
export const PUSH_TIMEOUT_MS = 10_000;

/** The content-free payload; `unread` is capped rather than trusted. */
export function pushPayload(thread: string, unread: number): string {
  const capped = Math.max(0, Math.min(APP_LIMITS.pushUnreadCap, Math.trunc(unread)));
  return JSON.stringify({ v: 2, thread, unread: capped });
}

/** A `Topic` header ≤32 URL-safe base64 characters, stable per thread, so a newer push replaces an older one. */
export function pushTopic(thread: string): string {
  return createHash("sha256").update(thread, "utf8").digest("base64url").slice(0, 22);
}

/** Generate one VAPID key pair locally; writes nothing and calls no network. */
export async function generatePushKeys(): Promise<PushKeyPair> {
  const webpush = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/**
 * Resolve the configured push block against the process environment at gateway start. A missing or
 * malformed private key disables push with one terse diagnostic naming only the variable, never a
 * value; nothing else about the gateway changes.
 */
export function resolvePushOptions(
  config: AppPushConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppPushOptions | undefined {
  const privateKey = env[config.privateKeyEnv];
  if (privateKey === undefined || privateKey.trim() === "") {
    console.warn(`App push disabled: environment variable ${config.privateKeyEnv} is not set.`);
    return undefined;
  }
  if (!validVapidPrivateKey(privateKey)) {
    console.warn(`App push disabled: environment variable ${config.privateKeyEnv} is not a base64url P-256 private key.`);
    return undefined;
  }
  return { subject: config.subject, publicKey: config.publicKey, privateKey };
}

/** `web-push` is imported lazily, exactly like `ws` from the listener, so an unconfigured gateway never loads it. */
async function webPushTransport(options: AppPushOptions): Promise<AppPushTransport> {
  const webpush = await import("web-push");
  webpush.setVapidDetails(options.subject, options.publicKey, options.privateKey);
  return async (request) => {
    const result = await webpush.sendNotification(
      { endpoint: request.subscription.endpoint, keys: { p256dh: request.subscription.p256dh, auth: request.subscription.auth } },
      request.payload,
      { ttl: request.ttlSeconds, urgency: request.urgency, topic: request.topic, timeout: request.timeoutMs },
    );
    return { statusCode: result.statusCode };
  };
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

export type AppPushSnapshot = { readonly subscription: AppPushSubscription; readonly payload: string };

export interface AppPushDispatcher {
  /** Ask for one push to this device for this thread; repeated calls coalesce into one follow-up. */
  notify(deviceId: string, thread: string): void;
  /** Stop after the sends already in flight settle; never rejects. */
  close(): Promise<void>;
}

/**
 * At most one send in flight per device. A notification arriving while a send is running replaces
 * the queued follow-up, so at most one more send runs afterwards and it carries the latest unread
 * count. `snapshot` re-reads the device's current subscription and unread count; `gone` removes a
 * subscription the push service reports as dead.
 */
export function createAppPushDispatcher(sources: {
  readonly options: AppPushOptions;
  snapshot(deviceId: string, thread: string): AppPushSnapshot | undefined;
  gone(deviceId: string, endpoint: string): void;
}): AppPushDispatcher {
  let transport: Promise<AppPushTransport> | undefined;
  const threads = new Map<string, string>();
  /** A notification arrived while this device had a send in flight: one follow-up will run. */
  const queued = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  let closed = false;

  async function sendOnce(deviceId: string): Promise<void> {
    const thread = threads.get(deviceId);
    if (thread === undefined) return;
    const snapshot = sources.snapshot(deviceId, thread);
    if (snapshot === undefined) return;
    transport ??= webPushTransport(sources.options);
    const deliver = sources.options.transport ?? await transport;
    let status: number | undefined;
    try {
      status = (await deliver({
        subscription: snapshot.subscription,
        payload: snapshot.payload,
        topic: pushTopic(thread),
        ttlSeconds: PUSH_TTL_SECONDS,
        urgency: "normal",
        timeoutMs: PUSH_TIMEOUT_MS,
      })).statusCode;
    } catch (error) {
      status = errorStatus(error);
    }
    if (status === 404 || status === 410) {
      sources.gone(deviceId, snapshot.subscription.endpoint);
      queued.delete(deviceId);
    }
    // Anything else (including a network error) is not retried; the next message tries again.
  }

  function start(deviceId: string): void {
    if (inFlight.has(deviceId)) return;
    const task = (async () => {
      while (!closed) {
        queued.delete(deviceId);
        await sendOnce(deviceId);
        // Only one coalesced follow-up per run; it re-reads the latest unread count.
        if (!queued.has(deviceId)) return;
      }
    })().catch(() => undefined).finally(() => {
      inFlight.delete(deviceId);
      // A notification that landed just as the drain exited still gets its send.
      if (!closed && queued.has(deviceId)) start(deviceId);
    });
    inFlight.set(deviceId, task);
  }

  return {
    notify(deviceId, thread) {
      if (closed) return;
      threads.set(deviceId, thread);
      if (inFlight.has(deviceId)) {
        queued.add(deviceId);
        return;
      }
      start(deviceId);
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
