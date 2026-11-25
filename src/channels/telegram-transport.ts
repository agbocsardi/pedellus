/**
 * The narrow Telegram Bot API transport the adapter consumes: grammY's typed `Api` behind a native
 * fetch bridge, one bounded call wrapper with the flood gate and the outage retry for safe reads,
 * per-chat send ordering, and the failure classification every caller relies on.
 *
 * The classification is the whole external-send contract: `rejected` is a definite refusal,
 * `not-sent` a proven pre-connect failure, and `unknown` an ambiguous outcome (a send whose request
 * may already have been accepted) that callers hold instead of retrying. Nothing here writes the
 * token, a token-bearing URL or a raw payload into an error message.
 */
import { Api, GrammyError, HttpError, type ApiClientOptions } from "grammy";
import { journalEvent } from "../observability.js";
import { TELEGRAM_SEND_METHODS } from "./telegram-outbound-media.js";

export const TELEGRAM_API_ROOT = "https://api.telegram.org";
export const POLL_TIMEOUT_MAX = 50;
const MAX_API_ATTEMPTS = 5;
/** Safe reads (getMe/getUpdates) retry through a Telegram outage without a fixed attempt limit. */
const READ_RETRY_BASE_MS = 1_000;
const READ_RETRY_MAX_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FLOOD_WAIT_BUDGET_MS = 5 * 60_000;
const FLOOD_WAIT_WITHOUT_HINT_MS = 1_000;

export type GrammySignal = Parameters<Api["getMe"]>[0];

export function toGrammySignal(signal?: AbortSignal): GrammySignal {
  return signal as unknown as GrammySignal;
}

/** One announcement and one recovery notice per read-outage episode, never one per retry. */
export type ReadOutageHooks = {
  entered(method: string): void;
  recovered(): void;
};

export type ApiCallOptions = {
  throttle?: TelegramFloodGate;
  /** A replaceable call (typing, previews, menu) is skipped instead of waiting out a flood gate. */
  replaceable?: boolean;
  /** Present only for idempotent reads that must survive a sustained Telegram outage. */
  retryOutage?: ReadOutageHooks;
};

/**
 * grammY's Node build creates its own `AbortController` per call, and native fetch rejects that foreign
 * `AbortSignal`. Re-express it with a native controller so grammY's timeout and chat cancellation still
 * abort the in-flight request. The listener lives on grammY's per-call signal, so nothing outlives the call.
 */
export async function telegramFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const signal: unknown = init?.signal;
  let nativeSignal = init?.signal ?? null;
  if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) {
    const controller = new AbortController();
    if ((signal as AbortSignal).aborted) controller.abort();
    else (signal as AbortSignal).addEventListener("abort", () => controller.abort(), { once: true });
    nativeSignal = controller.signal;
  }
  const response = await globalThis.fetch(input, { ...init, signal: nativeSignal, redirect: "error" });
  // grammY discards HTTP status before decoding JSON. Preserve safe-read 5xx even when a
  // proxy returns HTML or JSON without Telegram's error_code; outbound decoding is unchanged.
  const method = String(input).split("/").at(-1);
  if ((method === "getMe" || method === "getUpdates") && response.status >= 500 && response.status < 600) {
    await response.body?.cancel().catch(() => undefined);
    throw new TelegramApiError(method, response.status, "rejected");
  }
  return response;
}

/** Bot API methods whose request may already have been accepted when 5xx/transport fails. */
const AMBIGUOUS_SEND_METHODS: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  ...Object.values(TELEGRAM_SEND_METHODS),
]);

function isAmbiguousSendMethod(method: string): boolean {
  return AMBIGUOUS_SEND_METHODS.has(method);
}

/**
 * One bounded Bot API call. A flood wait defers through the shared gate (a replaceable call is
 * skipped and returns `undefined`); a safe read with `retryOutage` survives a sustained outage; a
 * send that may have been accepted is classified `unknown`, never retried.
 */
export async function apiCall<T>(
  method: string,
  signal: AbortSignal | undefined,
  request: (signal?: AbortSignal) => Promise<T>,
  options: ApiCallOptions = {},
): Promise<T | undefined> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (options.throttle) {
      for (;;) {
        if (options.replaceable && options.throttle.remainingMs() > 0) return undefined;
        waitedMs += await options.throttle.wait(signal, FLOOD_WAIT_BUDGET_MS - waitedMs);
        if (options.throttle.remainingMs() === 0) break;
      }
    }
    if (signal?.aborted) throw signal.reason;
    try {
      const result = await request(signal);
      options.retryOutage?.recovered();
      return result;
    } catch (error) {
      if (error instanceof GrammyError) {
        if (method === "editMessageText" && error.error_code === 400 &&
            (isNotModifiedDescription(error.description) || error.description === "Bad Request: message to edit not found")) {
          throw new TelegramApiError(method, error.error_code, "rejected", error.description, { cause: error });
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after;
          if (retryAfter !== undefined && (!Number.isFinite(retryAfter) || retryAfter <= 0)) {
            throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
          }
          const deadline = Date.now() + (retryAfter === undefined ? FLOOD_WAIT_WITHOUT_HINT_MS : retryAfter * 1000);
          if (!Number.isFinite(deadline)) throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
          journalEvent("telegram.rate_limited", { type: method, "cooldown.ms": Math.max(0, deadline - Date.now()) });
          options.throttle?.defer(deadline);
          if (options.replaceable) return undefined;
          if (attempt < MAX_API_ATTEMPTS - 1) continue;
          throw new TelegramApiError(method, 429, "rejected", undefined, { cause: error });
        }
        if (options.retryOutage !== undefined && error.error_code >= 500) {
          options.retryOutage.entered(method);
          await delay(readRetryBackoff(attempt), signal);
          continue;
        }
        throw new TelegramApiError(method, error.error_code,
          isAmbiguousSendMethod(method) && error.error_code >= 500 ? "unknown" : "rejected", error.description, { cause: error });
      }
      if (error instanceof HttpError) {
        if (isAmbiguousSendMethod(method)) {
          if (isProvenPreConnectFailure(error.error)) {
            if (attempt < MAX_API_ATTEMPTS - 1 && !signal?.aborted) {
              await delay(backoff(attempt), signal);
              continue;
            }
            throw new TelegramApiError(method, 0, "not-sent", undefined, { cause: error });
          }
          throw new TelegramApiError(method, 0, "unknown", undefined, { cause: error });
        }
        if (signal?.aborted) throw signal.reason;
        if (options.retryOutage !== undefined && isTransientTransportError(error.error)) {
          options.retryOutage.entered(method);
          await delay(readRetryBackoff(attempt), signal);
          continue;
        }
      }
      if (signal?.aborted) throw signal.reason;
      if (isAmbiguousSendMethod(method)) throw new TelegramApiError(method, 0, "unknown", undefined, { cause: error });
      throw new Error(`Telegram ${method} transport failed`, { cause: error });
    }
  }
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly outcome: "unknown" | "rejected" | "not-sent";
  readonly description: string | undefined;

  constructor(method: string, status: number, outcome: "unknown" | "rejected" | "not-sent", description?: string, options?: ErrorOptions) {
    super(`Telegram ${method} failed with status ${status}`, options);
    this.method = method;
    this.status = status;
    this.outcome = outcome;
    this.description = description;
  }
}

function isNotModifiedDescription(description: string | undefined): boolean {
  const prefix = "Bad Request: message is not modified";
  return description === prefix || (description !== undefined && description.length <= 512 &&
    description.startsWith(`${prefix}: `));
}

export function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    isNotModifiedDescription(error.description);
}

export function isMessageNotFound(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    error.description === "Bad Request: message to edit not found";
}

/** A response that provably never produced a message: a sub-5xx refusal or a pre-connect transport failure. */
export function isProvenRefusal(error: unknown): boolean {
  return (error instanceof GrammyError && error.error_code < 500) ||
    (error instanceof HttpError && isProvenPreConnectFailure(error.error));
}

/** A definite non-send: a proven pre-connect failure or a sub-5xx rejection; 5xx stays ambiguous. */
export function isKnownNotSent(error: unknown): boolean {
  return error instanceof TelegramApiError &&
    (error.outcome === "not-sent" || (error.outcome === "rejected" && error.status > 0 && error.status < 500));
}

const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH",
  "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED",
]);

export function isProvenPreConnectFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    const code = candidate.code ?? candidate.errno;
    if (code === "ENETDOWN" || code === "EHOSTUNREACH") return true;
    if (candidate.cause !== undefined) pending.push(candidate.cause);
  }
  return false;
}

export function backoff(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** attempt);
}

/** Capped exponential outage delay with bounded jitter; a successful read starts the next episode at 1s. */
function readRetryBackoff(attempt: number): number {
  const exponential = Math.min(READ_RETRY_MAX_MS / 1.2, READ_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(exponential * (1 + Math.random() * 0.2));
}

/** Network failures, grammY timeouts and safe-read HTTP 5xx are transient; malformed/local failures are not. */
export function isTransientTransportError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof TelegramApiError && current.status >= 500 && current.status < 600) return true;
    const candidate = current as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown;
      cause?: unknown; error?: unknown; errors?: unknown };
    if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
    const code = candidate.code ?? candidate.errno;
    if (typeof code === "string" && TRANSIENT_TRANSPORT_CODES.has(code)) return true;
    if (candidate.message === "fetch failed") return true;
    if (typeof candidate.message === "string" && /^Request to '.+' timed out after .+ seconds$/.test(candidate.message)) {
      return true;
    }
    if (candidate.cause !== undefined) pending.push(candidate.cause);
    if (candidate.error instanceof Error) pending.push(candidate.error);
    if (current instanceof AggregateError && Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return false;
}

/** The bot token's shared flood cooldown: a 429 defers every later call through the same gate. */
export class TelegramFloodGate {
  #retryAt = 0;

  remainingMs(): number {
    return Math.max(0, this.#retryAt - Date.now());
  }

  defer(deadline: number): void {
    this.#retryAt = Math.max(this.#retryAt, deadline);
  }

  async wait(signal: AbortSignal | undefined, budgetMs: number): Promise<number> {
    let waited = 0;
    while (this.remainingMs() > 0) {
      const remaining = this.remainingMs();
      if (remaining > budgetMs - waited) throw new Error("Telegram flood wait exceeds delivery budget");
      await delay(remaining, signal);
      waited += remaining;
    }
    return waited;
  }
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ms;
  if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(deadline)) throw new Error("Invalid delay");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const chunk = Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, chunk);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * The adapter's whole view of the Bot API: the typed client, one bounded call bound to the
 * adapter's signal, the two flood gates (outbound sends and polling/file reads share the bot token
 * but not a cooldown) and per-chat send ordering.
 */
export interface TelegramTransport {
  readonly api: Api;
  /** Shared by message sends, edits, reactions, uploads and replaceable typing/menu calls. */
  readonly outbound: TelegramFloodGate;
  /** Shared by `getMe`, `getUpdates` and `getFile`. */
  readonly poll: TelegramFloodGate;
  /** {@link apiCall} under the adapter's signal; the request receives grammY's signal type. */
  call<T>(method: string, request: (signal: GrammySignal) => Promise<T>, options?: ApiCallOptions): Promise<T | undefined>;
  /**
   * Message sends/edits for one chat are ordered; chunks from separate messages may interleave.
   * Disposable typing actions bypass this ordering but share the bot-token flood gate.
   */
  inChatOrder<T>(chatId: number, work: () => Promise<T>): Promise<T>;
}

export function createTelegramTransport(token: string, signal: AbortSignal | undefined): TelegramTransport {
  const api = new Api(token, {
    apiRoot: TELEGRAM_API_ROOT,
    timeoutSeconds: POLL_TIMEOUT_MAX + 10,
    sensitiveLogs: false,
    fetch: telegramFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
  });
  const chatSendTails = new Map<number, Promise<void>>();
  return {
    api,
    outbound: new TelegramFloodGate(),
    poll: new TelegramFloodGate(),
    call: (method, request, options) =>
      apiCall(method, signal, (callSignal) => request(toGrammySignal(callSignal)), options),
    inChatOrder(chatId, work) {
      const previous = chatSendTails.get(chatId) ?? Promise.resolve();
      const next = previous.then(work);
      const tail = next.then(() => undefined, () => undefined);
      chatSendTails.set(chatId, tail);
      void tail.finally(() => {
        if (chatSendTails.get(chatId) === tail) chatSendTails.delete(chatId);
      });
      return next;
    },
  };
}

/**
 * Durable bookkeeping a caller supplies so a text send stays truthful about its own record: the
 * intent precedes the request, a proven refusal drops it, and an accepted message id is persisted.
 */
export type TelegramTextHooks = {
  /** Persist the write-ahead intent for this exact attempt, before the request leaves. */
  before(text: string): Promise<void>;
  /** The request provably did not deliver anything; drop the intent. */
  abandoned(): Promise<void>;
  /** Record each accepted message without advancing the whole-chunk cursor. */
  partAccepted?(messageId: number, text: string): Promise<void>;
  /** All parts were accepted; advance the whole-chunk cursor. */
  accepted(messageId: number, text: string): Promise<void>;
};

/** A send with no durable record of its own: nothing to write before, abandon or accept. */
export const IDLE_TEXT_HOOKS: TelegramTextHooks = {
  before: async () => undefined,
  abandoned: async () => undefined,
  accepted: async () => undefined,
};

export type TelegramSendTextOptions = {
  hooks: TelegramTextHooks;
  replyTo?: number;
  mode?: "markdown" | "literal";
  richBody?: string;
  throttle?: TelegramFloodGate;
  replaceable?: boolean;
};
