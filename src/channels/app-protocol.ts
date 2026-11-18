/**
 * Wire protocol v2 for the `app` channel: limits, close codes, fixed error texts and the pure
 * frame/field validation both the listener and the adapter share.
 *
 * The contract is normative in the sibling `durable-app` repository (`protocol/v2.md` and `v2.ts`). Tailscale identity headers are never read:
 * the device token is the only authority.
 */

export const APP_PROTOCOL_VERSION = 2;
export const APP_MAIN_THREAD = "main";

/** Every bound the gateway enforces; the app enforces the same values before sending. */
export const APP_LIMITS = Object.freeze({
  /** One WebSocket frame, either direction, and one HTTP request body. */
  frameBytes: 262_144,
  sendTextChars: 16_000,
  /** Request ids and `send` keys. */
  idPattern: /^[A-Za-z0-9_-]{1,64}$/,
  replayBatch: 500,
  threadTitleChars: 80,
  maxOpenThreads: 50,
  /** Maximum archived threads in a `threads` reply, not a storage cap. */
  maxListedArchivedThreads: 200,
  threadIdPattern: /^(main|t_[A-Za-z0-9_-]{1,40})$/,
  /** One-time pairing code: single use, ten minutes. */
  pairCodeChars: 8,
  pairTtlMs: 10 * 60_000,
  /** More than five pairing failures per minute across all clients refuses the next attempt. */
  pairRateWindowMs: 60_000,
  pairRateMax: 5,
  labelMinChars: 1,
  labelMaxChars: 40,
  /** Agent display name in the hello reply: at most 40 printable characters. */
  agentNameMaxChars: 40,
  cookieName: "durable_device",
  /** Distinct paired devices retained; further pairing is refused until one is revoked. */
  maxDevices: 16,
  /** Outstanding (unexpired, unused) pairing codes. */
  maxPairings: 8,
  /** Durable events retained for replay; acks trim below this first. */
  maxEvents: 2_000,
  /** Inputs admitted but not yet settled; further input is refused, like the other channels. */
  maxPending: 500,
  /** `send` keys are remembered for idempotency; pruning is by age only (keys are tiny). */
  sendKeyTtlMs: 7 * 24 * 60 * 60_000,
  maxUnresolvedControls: 64,
} as const);

/** `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: 8 characters, no `I`/`O`, case-insensitive input. */
export const APP_PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Fixed WebSocket close codes; the upgrade is always completed first. */
export const APP_CLOSE = Object.freeze({
  unauthorized: 4401,
  protocol: 4400,
  version: 4426,
  replaced: 4409,
} as const);

/** Fixed reply error codes; no free text ever leaves the gateway on a response. */
export type AppErrorCode = "bad_request" | "too_large" | "unsupported" | "not_ready" | "internal";
export type AppControlCommand = "new" | "abort" | "status";
/** Catalogued commands this phase does not implement; a typed one is refused, not a violation. */
export const APP_LATER_COMMANDS: readonly string[] = ["model", "digest", "restart", "mcp"];
export const APP_REQUEST_OPS: readonly string[] = [
  "hello", "send", "ack", "control", "ping", "history", "tasks",
  "threads", "thread.create", "thread.rename", "thread.archive",
];

export type AppThreadOrigin = { thread: string; messageId: string };
export type AppThreadInfo = {
  id: string; title: string; archived: boolean; archivedReason?: "manual" | "idle";
  origin?: AppThreadOrigin; createdAt: string; lastAt: string;
};

export function validThreadTitle(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= APP_LIMITS.threadTitleChars &&
    value.trim() !== "" && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

export function parseThreadId(value: unknown): string | undefined {
  return typeof value === "string" && APP_LIMITS.threadIdPattern.test(value) ? value : undefined;
}

/** A printable device label: 1–40 characters, no control or format characters. */
export function validAppLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < APP_LIMITS.labelMinChars || value.length > APP_LIMITS.labelMaxChars) return false;
  return /^[\x21-\x7e\u00a0-\uffff]+$/u.test(value) && !/[\u202a-\u202e\u2066-\u2069]/u.test(value);
}

/** The hello reply's agent display name: 1–40 printable characters (spaces allowed). */
export function validAppAgentName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > APP_LIMITS.agentNameMaxChars || value.trim() === "") return false;
  return /^[\x20-\x7e\u00a0-\uffff]+$/u.test(value) && !/[\u202a-\u202e\u2066-\u2069]/u.test(value);
}

/**
 * One validated `hello` cursor: `null` (nothing stored yet) or a positive integer. The replay then
 * sends durable events with `cursor > hello.cursor`, oldest first.
 */
export function parseHelloCursor(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return undefined;
}

/** Durable, cursor-numbered events; stored without the `type` wrapper and wrapped on the wire. */
export type AppDurableEvent =
  | {
    event: "message";
    cursor: number;
    /** Missing only on legacy v1 records; they belong to main. */
    thread?: string;
    id: string;
    role: "user" | "assistant" | "notice";
    text: string;
    at: string;
    key?: string;
  }
  | { event: "settled"; cursor: number; thread?: string; key: string; outcome: "answered" | "failed" | "aborted" }
  | { event: "divider"; cursor: number; thread?: string; at: string; reason: "new" }
  | { event: "thread"; cursor: number; thread: AppThreadInfo };

/** One pending model input (an admitted `send`) or held host notice. */
export type AppPendingInput = {
  readonly key: string;
  readonly thread?: string;
  readonly text: string;
  readonly admittedAtMs: number;
  /** A host notice: delivered as `message{role:"notice"}`, never submitted to the model. */
  readonly notice?: boolean;
  /** Durable sequence stamp making each notice admission's event id unique. */
  readonly noticeSeq?: number;
  /** The notice is withheld until the command's native call returns (or reports still-pending). */
  readonly hold?: boolean;
  /** The busy-mode this input was admitted under; absent keeps follow-up queueing. */
  readonly whenBusy?: "steer";
  /** Held after repeated delivery failures; never resent automatically, like the other channels. */
  readonly held?: boolean;
};

/** One authenticated control command, admitted with its acknowledgement before the effect. */
export type AppControlRecord = {
  readonly key: string;
  readonly thread?: string;
  readonly command: "new" | "abort";
  readonly status: "admitted" | "applied" | "refused" | "unconfirmed";
};

/** One paired device: the token itself exists only in the device's cookie, never here. */
export type AppDeviceRecord = {
  readonly id: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
};

/** One outstanding pairing code: hashed, single-use, expiring. */
export type AppPairingRecord = {
  readonly codeHash: string;
  readonly label?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

export const APP_STATIC_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

/**
 * Resolve one request path inside the static root, or `undefined` when the path can never name a
 * file: absolute, traversing, NUL-bearing or non-decodable paths are refused before any filesystem
 * call. `""` is the root, which serves `index.html`. Segments are split before decoding, so an
 * encoded separator cannot smuggle structure into the resolved path.
 */
export function resolveStaticPath(rawPath: string): { readonly segments: readonly string[] } | undefined {
  if (rawPath.length === 0 || rawPath.length > 2_048) return undefined;
  const withoutQuery = rawPath.split("?", 1)[0]!.split("#", 1)[0]!;
  if (withoutQuery.includes("\u0000")) return undefined;
  if (withoutQuery === "/" || withoutQuery === "") return { segments: [] };
  if (!withoutQuery.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const rawSegment of withoutQuery.slice(1).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\u0000")) {
      return undefined;
    }
    segments.push(decoded);
  }
  return { segments };
}

/** The file extension's MIME type, or a safe generic octet stream. */
export function staticMimeType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return APP_STATIC_TYPES[name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}
