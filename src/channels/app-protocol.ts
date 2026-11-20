/**
 * Wire protocol v2 for the `app` channel: the gateway's frame/field validation, its gateway-only
 * bounds and its persisted records.
 *
 * The wire contract itself — limits, close codes, frame and field shapes — is normative in
 * `pwa/protocol/v2.md` + `pwa/protocol/v2.ts`; the gateway imports the generated copy in
 * `./generated/protocol-v2.js` rather than restating it. Only bounds the app never sees and
 * gateway-side checks live here. Tailscale identity headers are never read: the device token is
 * the only authority.
 */
import {
  CLOSE,
  LIMITS,
  MAIN_THREAD,
  PAIR_ALPHABET,
  PROTOCOL_VERSION,
  type CommandInfo,
  type AttachmentInfo,
  type ErrorCode,
  type PresetInfo,
  type ThreadInfo,
  type ThreadOrigin,
} from "./generated/protocol-v2.js";

export const APP_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const APP_MAIN_THREAD = MAIN_THREAD;
/** `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: no `I`/`O`, case-insensitive input. */
export const APP_PAIR_ALPHABET = PAIR_ALPHABET;

/** The wire bounds, then the gateway-only ones; the app never sees the latter. */
export const APP_LIMITS = Object.freeze({
  ...LIMITS,
  /** More than five pairing failures per minute across all clients refuses the next attempt. */
  pairRateWindowMs: 60_000,
  pairRateMax: 5,
  /** `hello.presets`: at most this many entries, each field bounded in characters. */
  maxPresets: 50,
  presetNameChars: 80,
  presetModelChars: 240,
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

/** Fixed WebSocket close codes; the upgrade is always completed first. */
export const APP_CLOSE = Object.freeze({ ...CLOSE } as const);

/** Fixed reply error codes; no free text ever leaves the gateway on a response. */
export type AppErrorCode = ErrorCode;
/** One `hello.commands` entry, rendered from the shared catalogue's `app` surface. */
export type AppCommandInfo = CommandInfo;
/** One `hello.presets` entry; `model` is `provider/model`. */
export type AppPresetInfo = PresetInfo;
/** Accepted ops; `history`/`tasks` are declared in v2.md as later work. */
export const APP_REQUEST_OPS: readonly string[] = [
  "hello", "send", "ack", "control", "ping", "history", "tasks",
  "threads", "thread.create", "thread.rename", "thread.archive",
  "push.key", "push.subscribe", "push.unsubscribe",
];

export type AppThreadOrigin = ThreadOrigin;
export type AppThreadInfo = ThreadInfo;

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

/** Project configured presets onto the bounded wire shape; entries with unprintable fields are dropped. */
export function appPresetInfos(
  presets: readonly { name: string; provider: string; modelId: string; thinkingLevel?: string }[] | undefined,
): AppPresetInfo[] {
  const printable = (value: unknown, max: number): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\s]/u.test(value);
  const out: AppPresetInfo[] = [];
  for (const preset of presets ?? []) {
    const model = `${preset.provider}/${preset.modelId}`;
    if (!printable(preset.name, APP_LIMITS.presetNameChars) || !printable(model, APP_LIMITS.presetModelChars)) continue;
    out.push({ name: preset.name, model, ...(preset.thinkingLevel === undefined ? {} : { thinking: preset.thinkingLevel }) });
    if (out.length >= APP_LIMITS.maxPresets) break;
  }
  return out;
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

/**
 * One uploaded original, durable before its id is answered. `path` is the shared media store's
 * workspace-relative locator; the bytes are never read here, so the record carries no content.
 * Uploads are device-private and unusable until an admitted `send` references them.
 */
export type AppUploadRecord = {
  readonly id: string;
  /** Only this device sees the upload until an admitted message references it. */
  readonly deviceId: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly kind: AttachmentInfo["kind"];
  readonly path: string;
  readonly createdAtMs: number;
  /** Set once an admitted `send` referenced it; downloads require it. */
  readonly referencedAtMs?: number;
  /** The durable user `message` that referenced it (`send:<key>`). */
  readonly messageId?: string;
};

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
    /** Files sent with this user message, in send order; first part only when split. */
    attachments?: AttachmentInfo[];
    /** Present only on a split message: part `i` (from 0) of `n`; see v2.md, Long messages. */
    part?: { i: number; n: number };
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
  /** Attachments this input was admitted with; already stored, never re-downloaded. */
  readonly attachments?: AppUploadRecord[];
};

/** A command with a native effect on its thread or on this process; a refusal is terminal, never retried. */
export type AppMutation = "new" | "abort" | "model" | "restart" | "digest";

/** One authenticated control command, admitted with its acknowledgement before the effect. */
export type AppControlRecord = {
  readonly key: string;
  readonly thread?: string;
  readonly command: AppMutation;
  /** The `model` preset argument, already validated against the configured catalog. */
  readonly option?: string;
  readonly status: "admitted" | "applied" | "refused" | "unconfirmed";
};

/** One validated Web Push subscription: the browser's `PushSubscription.toJSON()` fields. */
export type AppPushSubscription = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

/** One paired device: the token itself exists only in the device's cookie, never here. */
export type AppDeviceRecord = {
  readonly id: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly revokedAtMs?: number;
  /** Its one Web Push subscription; absent when it never subscribed or unsubscribed. */
  readonly pushSubscription?: AppPushSubscription;
};

/** One outstanding pairing code: hashed, single-use, expiring. */
export type AppPairingRecord = {
  readonly codeHash: string;
  readonly label?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** Dotted local-only zones; a public push service never lives in one. */
const LOCAL_PUSH_SUFFIXES = [".localhost", ".local", ".internal", ".ts.net"] as const;

/**
 * A push endpoint's host: a dotted DNS name, never an IP literal (whatwg normalizes every IPv4
 * notation to a dotted quad) and never a loopback or local-only name. This is what keeps a
 * `push.subscribe` from pointing the gateway's HTTPS client at an internal address.
 */
function validPushHostname(raw: string): boolean {
  // A trailing dot is the DNS root: `localhost.` names the same host, so drop it before checking.
  const hostname = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (hostname.startsWith("[") || hostname.includes(":")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  if (!hostname.includes(".")) return false;
  return !LOCAL_PUSH_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/** VAPID `sub`: an absolute `mailto:` or `https:` URI, bounded and printable. */
export function validVapidSubject(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
  if (value.startsWith("mailto:")) return value.length > "mailto:".length;
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** A base64url-encoded uncompressed P-256 point: 65 bytes, leading `0x04`. */
export function validVapidPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 87 || !BASE64URL.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 65 && bytes[0] === 4;
}

/** A base64url-encoded P-256 private scalar: 32 bytes. */
export function validVapidPrivateKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || !BASE64URL.test(value)) return false;
  return Buffer.from(value, "base64url").length === 32;
}

/**
 * One `push.subscribe` subscription, or `undefined` when any field is out of bounds. The endpoint
 * is an `https:` URL within `pushEndpointChars`, on the default port, with no userinfo and a
 * public dotted hostname (see `validPushHostname`); both keys are non-empty base64url within their
 * bounds. Unknown extra keys are ignored, like the browser's own `toJSON()` output.
 */
export function parsePushSubscription(value: unknown): AppPushSubscription | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const endpoint = raw.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > APP_LIMITS.pushEndpointChars) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  // An explicit port is refused; push services all listen on 443, which the parser normalizes to "".
  if (url.port !== "" || !validPushHostname(url.hostname)) return undefined;
  const keys = raw.keys;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) return undefined;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || p256dh.length === 0 || p256dh.length > APP_LIMITS.pushP256dhChars ||
      !BASE64URL.test(p256dh)) return undefined;
  if (typeof auth !== "string" || auth.length === 0 || auth.length > APP_LIMITS.pushAuthChars ||
      !BASE64URL.test(auth)) return undefined;
  return { endpoint, p256dh, auth };
}

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
