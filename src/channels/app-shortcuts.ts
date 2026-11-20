/**
 * Shortcut credentials and `POST /v1/ask` for the app channel (protocol v2, "Shortcuts").
 *
 * A shortcut token is a separate credential class, not a device: it can admit one ordinary owner
 * message and wait briefly for its answer, and it can never authenticate the stream, upload,
 * download, pair, subscribe to push or run a control. Only its SHA-256 hash joins the app channel
 * state, next to the device hashes; the token itself is printed once by `app shortcut add`, is
 * compared in constant time, and revocation is immediate (the state is read on every ask).
 *
 * Everything transport-shaped stays in `app-listener.ts`; everything authority-shaped stays in
 * `app.ts`. This module is the small shared vocabulary between them: the record and console types,
 * the token and rate-limit primitives, request parsing and the settled wait.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { APP_LIMITS, parseThreadId, type AppDurableEvent, type AppErrorCode } from "./app-protocol.js";

/** Gateway-only shortcut bounds; the wire bounds stay in the generated protocol mirror. */
export const APP_SHORTCUT_LIMITS = Object.freeze({
  /** Distinct shortcut credentials retained; further `app shortcut add` is refused. */
  maxShortcuts: 8,
  /** The rolling per-token window for `asksPerMinute`; in-memory, like the pairing window. */
  askRateWindowMs: 60_000,
  /** A presented bearer token is at most this long; a real one is 43 base64url characters. */
  maxTokenChars: 128,
} as const);

/**
 * One shortcut credential as it is stored: a printable label (the same rules as a device label),
 * the token's SHA-256 hash, its creation time and its revocation time. No token, no plaintext.
 */
export type AppShortcutRecord = {
  readonly label: string;
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
};

/** One created token, answered once to the console command that asked for it. */
export type AppShortcutCreated = {
  readonly label: string;
  readonly token: string;
  readonly createdAtMs: number;
};

/** One console row; the token is never part of a listing. */
export type AppShortcutListing = {
  readonly label: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
};

export type AppShortcutRefusal = "invalid-label" | "label-in-use" | "shortcut-limit";

/** 32 random bytes, base64url: 43 characters and never derivable from anything else. */
export function newShortcutToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The only form a shortcut credential takes at rest. */
export function hashShortcutToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of one presented token against a stored hex digest. */
export function sameShortcutToken(token: string, storedHash: string): boolean {
  const known = Buffer.from(storedHash, "hex");
  const candidate = createHash("sha256").update(token, "utf8").digest();
  return known.length === candidate.length && timingSafeEqual(known, candidate);
}

/** The active shortcut a presented token belongs to, or `undefined` when unknown or revoked. */
export function activeShortcut(
  records: readonly AppShortcutRecord[] | undefined,
  token: string,
): AppShortcutRecord | undefined {
  if (token.length === 0 || token.length > APP_SHORTCUT_LIMITS.maxTokenChars) return undefined;
  return records?.find((entry) =>
    entry.revokedAtMs === undefined && sameShortcutToken(token, entry.tokenHash));
}

/**
 * The rolling per-token ask window: more than `LIMITS.asksPerMinute` asks inside one minute refuse
 * the next one. In-memory, so a gateway restart clears it exactly like the pairing window.
 */
export interface ShortcutRateLimiter {
  /** Count one authorized ask; `false` means this token is already at its per-minute limit. */
  allow(tokenHash: string): boolean;
}

export function createShortcutRateLimiter(now: () => number): ShortcutRateLimiter {
  const windows = new Map<string, number[]>();
  return {
    allow(tokenHash) {
      const nowMs = now();
      const recent = (windows.get(tokenHash) ?? [])
        .filter((stamp) => nowMs - stamp < APP_SHORTCUT_LIMITS.askRateWindowMs);
      if (recent.length >= APP_LIMITS.asksPerMinute) {
        windows.set(tokenHash, recent);
        return false;
      }
      recent.push(nowMs);
      windows.set(tokenHash, recent);
      return true;
    },
  };
}

/** A missing `key` gets a fresh one that already matches `LIMITS.idPattern`. */
export function newAskKey(): string {
  return randomBytes(16).toString("base64url");
}

/** One accepted `POST /v1/ask` body: exactly `text`, and optionally `thread` and `key`. */
export type AppAskRequest = {
  readonly text: string;
  readonly thread?: string;
  readonly key?: string;
};

export type AppAskParse =
  | { readonly kind: "ok"; readonly request: AppAskRequest }
  | { readonly kind: "bad-request" | "too-large" };

const ASK_FIELDS = new Set(["text", "thread", "key"]);

/**
 * Validate one ask body against the same bounds as `send`: a non-empty text of at most
 * `sendTextChars`, an optional thread id in the protocol's shape, an optional `send` key matching
 * `idPattern`. Unknown fields are refused rather than ignored, and lengths over the bounds are
 * `too_large` exactly like an oversize `send.text`.
 */
export function parseAskRequest(value: unknown): AppAskParse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "bad-request" };
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!ASK_FIELDS.has(field)) return { kind: "bad-request" };
  }
  const { text, thread, key } = record;
  if (typeof text !== "string" || text.length === 0) return { kind: "bad-request" };
  if (text.length > APP_LIMITS.sendTextChars) return { kind: "too-large" };
  let parsedThread: string | undefined;
  if (thread !== undefined) {
    parsedThread = parseThreadId(thread);
    if (parsedThread === undefined) return { kind: "bad-request" };
  }
  let parsedKey: string | undefined;
  if (key !== undefined) {
    if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key)) return { kind: "bad-request" };
    parsedKey = key;
  }
  return {
    kind: "ok",
    request: {
      text,
      ...(parsedThread === undefined ? {} : { thread: parsedThread }),
      ...(parsedKey === undefined ? {} : { key: parsedKey }),
    },
  };
}

/** One settled wait's result; `timeout` is the protocol's `pending` with the admitted key. */
export type AskWaitOutcome =
  | { readonly outcome: "answered"; readonly text: string }
  | { readonly outcome: "failed" | "aborted" }
  | { readonly outcome: "timeout" };

export interface AskWaiters {
  /** Wait for the durable `settled` of one admitted key; the current log is checked first. */
  wait(thread: string, key: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<AskWaitOutcome>;
  /** Resolve every waiter whose key now has a settled event; call after each state commit. */
  wake(): void;
}

type SettledEvent = Extract<AppDurableEvent, { event: "settled" }>;
type MessageEvent = Extract<AppDurableEvent, { event: "message" }>;

const waiterId = (thread: string, key: string): string => `${thread}\u0000${key}`;

/**
 * The final answer text of one answered turn. The answer message and its `settled` events commit
 * together, message first, so the last assistant message before the settled cursor is exactly that
 * turn's answer (possibly one shared by several admitted keys); a split answer is joined by part.
 */
function answerText(events: readonly AppDurableEvent[], settled: SettledEvent): string {
  let answer: MessageEvent | undefined;
  for (const event of events) {
    if (event.cursor >= settled.cursor) break;
    if (event.event === "message" && event.thread === settled.thread && event.role === "assistant") answer = event;
  }
  if (answer === undefined) return "";
  const parts: MessageEvent[] = [];
  for (const event of events) {
    if (event.event === "message" && event.thread === settled.thread && event.id === answer.id) parts.push(event);
  }
  parts.sort((left, right) => (left.part?.i ?? 0) - (right.part?.i ?? 0));
  return parts.map((part) => part.text).join("");
}

function settledOutcome(events: readonly AppDurableEvent[], settled: SettledEvent): AskWaitOutcome {
  return settled.outcome === "answered"
    ? { outcome: "answered", text: answerText(events, settled) }
    : { outcome: settled.outcome };
}

/**
 * Event-driven wait for one key's `settled` event in the adapter's own durable log. There is no
 * polling: `wake` is called after every state commit, scans only the registered keys, and resolves
 * them from the log. A missing resolution within the wait bound is `timeout`, and an aborted
 * request (client hung up) ends the same way so the waiter never outlives its request.
 */
export function createAskWaiters(events: () => readonly AppDurableEvent[]): AskWaiters {
  type Resolve = (outcome: AskWaitOutcome) => void;
  const waiters = new Map<string, Set<Resolve>>();

  const settledFor = (thread: string, key: string): SettledEvent | undefined => {
    let found: SettledEvent | undefined;
    for (const event of events()) {
      if (event.event === "settled" && event.thread === thread && event.key === key) found = event;
    }
    return found;
  };

  return {
    wait(thread, key, timeoutMs, signal) {
      return new Promise<AskWaitOutcome>((resolve) => {
        const id = waiterId(thread, key);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let members: Set<Resolve> | undefined;
        const finish = (outcome: AskWaitOutcome): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener("abort", onAbort);
          if (members !== undefined) {
            members.delete(finish);
            if (members.size === 0 && waiters.get(id) === members) waiters.delete(id);
          }
          resolve(outcome);
        };
        const onAbort = (): void => finish({ outcome: "timeout" });
        const settled = settledFor(thread, key);
        if (settled !== undefined) {
          resolve(settledOutcome(events(), settled));
          return;
        }
        if (signal?.aborted === true) {
          resolve({ outcome: "timeout" });
          return;
        }
        members = waiters.get(id) ?? new Set<Resolve>();
        waiters.set(id, members);
        members.add(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
        timer.unref?.();
      });
    },
    wake() {
      for (const [id, members] of [...waiters]) {
        const separator = id.indexOf("\u0000");
        const settled = settledFor(id.slice(0, separator), id.slice(separator + 1));
        if (settled === undefined) continue;
        waiters.delete(id);
        const outcome = settledOutcome(events(), settled);
        for (const finish of [...members]) finish(outcome);
      }
    },
  };
}

/**
 * What the adapter answers `POST /v1/ask` with. The listener only maps this to a wire status; no
 * other status, header or body detail exists (protocol v2, "Shortcuts").
 */
export type AppAskOutcome =
  | { readonly status: "answered"; readonly text: string }
  | { readonly status: "failed" | "aborted" }
  | { readonly status: "pending"; readonly key: string }
  | { readonly status: "bad-request" | "too-large" | "unauthorized" | "rate-limited" | "internal" };

/** An admission error keeps only the protocol's bounded vocabulary: 400, 413 or internal. */
export function askOutcomeForAdmissionError(error: AppErrorCode): AppAskOutcome {
  if (error === "too_large") return { status: "too-large" };
  if (error === "internal") return { status: "internal" };
  // `not_ready` (busy queue or archiving) is a refusal, not a fifth error code on this endpoint.
  return { status: "bad-request" };
}

/** The exact HTTP status and JSON body for one outcome; nothing else is ever sent. */
export function askHttpResponse(outcome: AppAskOutcome): { readonly status: number; readonly body: string } {
  switch (outcome.status) {
    case "answered":
      return { status: 200, body: JSON.stringify({ outcome: "answered", text: outcome.text }) };
    case "failed":
    case "aborted":
      return { status: 200, body: JSON.stringify({ outcome: outcome.status }) };
    case "pending":
      return { status: 202, body: JSON.stringify({ outcome: "pending", key: outcome.key }) };
    case "bad-request":
      return { status: 400, body: JSON.stringify({ error: "bad_request" }) };
    case "too-large":
      return { status: 413, body: JSON.stringify({ error: "too_large" }) };
    case "unauthorized":
      return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    case "rate-limited":
      return { status: 429, body: JSON.stringify({ error: "rate_limited" }) };
    default:
      return { status: 500, body: JSON.stringify({ error: "internal" }) };
  }
}
