import { defineDoc, AssistantEntry } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { Api, GrammyError, HttpError } from "grammy";
import type { ApiClientOptions } from "grammy";
import type { Update } from "grammy/types";
import type { Conversation, SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const API = "https://api.telegram.org";
const TELEGRAM_LIMIT = 4096;
const MAX_ADMITTED = 1000;
const MAX_API_ATTEMPTS = 5;
const POLL_TIMEOUT_MAX = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FLOOD_WAIT_BUDGET_MS = 5 * 60_000;
const FLOOD_WAIT_WITHOUT_HINT_MS = 1_000;

export type TelegramOptions = {
  token: string;
  allowFrom: readonly string[];
  pollTimeoutSeconds?: number;
};

type TelegramMessage = NonNullable<Update["message"]>;

type PendingReply = {
  updateId: number;
  chatId: number;
  sessionKey: string;
  senderId: string;
  text: string;
  messageId?: number;
  lastText?: string;
};
type ChannelState = { offset: number; pending: PendingReply[] };

// Stored alongside the adapter's stable channel conversation, not in a plaintext sidecar.
const TelegramState = defineDoc<ChannelState>({
  kind: "nanobot.telegram-state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  initial: () => ({ offset: 0, pending: [] }),
});

export interface TelegramGateway {
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
}

export async function runTelegram(
  gateway: TelegramGateway,
  options: TelegramOptions,
  context: Context,
): Promise<void> {
  validateOptions(options);
  const scope = withCancel(context);
  const adapterContext = scope.context;
  const signal = adapterContext.abortSignal;
  if (signal?.aborted) return;
  const outboundThrottle = new TelegramFloodGate();
  const pollThrottle = new TelegramFloodGate();
  const safeFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, { ...init, redirect: "error" })) as unknown as NonNullable<ApiClientOptions["fetch"]>;
  const api = new Api(options.token, {
    apiRoot: API,
    timeoutSeconds: POLL_TIMEOUT_MAX + 10,
    sensitiveLogs: false,
    fetch: safeFetch,
  });

  const me = await apiCall(api, "getMe", signal, (callSignal) => api.getMe(toGrammySignal(callSignal)), { throttle: pollThrottle });
  if (!me) throw new Error("Telegram getMe returned no result");
  const identity = String(me.id);
  const stateConversation = await gateway.conversationFor(`telegram:${identity}:channel-state`, context);
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(TelegramState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  const delivering = new Set<number>();
  const failedThisPoll = new Set<number>();
  let stopping = false;

  const drain = () => {
    if (stopping || signal?.aborted) return;
    for (const item of state.pending) {
      if (active.size >= 8) break;
      if (delivering.has(item.updateId) || failedThisPoll.has(item.updateId)) continue;
      delivering.add(item.updateId);
      const task = Promise.resolve().then(() => deliver(item)).catch(() => {
        // Keep durable state for the next polling cycle; no exception details or tight retry loop.
        failedThisPoll.add(item.updateId);
      }).finally(() => {
        active.delete(task);
        delivering.delete(item.updateId);
        if (!stopping && !signal?.aborted) drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: PendingReply) => {
    if (!options.allowFrom.includes(item.senderId)) {
      if (item.messageId !== undefined) {
        await apiCall(api, "deleteMessage", signal, (callSignal) => api.deleteMessage(item.chatId, item.messageId!, toGrammySignal(callSignal)), { throttle: outboundThrottle }).catch(() => undefined);
      }
      await forget(item.updateId);
      return;
    }
    const conversation = await gateway.conversationFor(item.sessionKey, adapterContext);
    const requestId = requestIdFor(identity, item.updateId);
    const watch = await conversation.watch(adapterContext);
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewWork: Promise<void> | undefined;
    let previewDirty = false;
    let previewFailure: unknown;
    let latestPreview = "";
    let submissionId: SubmissionId | undefined;
    let watchStopped = false;
    const schedulePreview = () => {
      if (previewTimer !== undefined || watchStopped || signal?.aborted) return;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (previewWork) return;
        previewDirty = false;
        previewWork = publishPreview(latestPreview).catch((error: unknown) => {
          previewFailure = error;
        }).finally(() => {
          previewWork = undefined;
          if (previewDirty && !watchStopped && !signal?.aborted) schedulePreview();
        });
      }, 700);
    };
    const queuePreview = (text: string) => {
      if (watchStopped) return;
      latestPreview = text;
      previewDirty = true;
      schedulePreview();
    };
    try {
      watch.start(async (view) => {
        const live = view.docs["pi.live"] as {
          run?: { inputs?: SubmissionId[] };
          generation?: { message?: { content?: { type: string; text?: string }[] } };
        } | undefined;
        if (submissionId === undefined || !live?.run?.inputs?.includes(submissionId)) return;
        const text = live.generation?.message?.content
          ?.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
        if (text) queuePreview(text);
      });
      const submission = await conversation.submit({ type: "input", content: item.text, requestId }, adapterContext);
      submissionId = submission.id;
      const settled = await submission.wait(adapterContext);
      if (settled.status !== "done" || settled.type !== "input") {
        await stopPreviewWatch();
        await flushFinal("Your request could not be completed. Please try again.");
        await forget(item.updateId);
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), adapterContext);
      const message = answer?.model?.[0] as AssistantMessage | undefined;
      const text = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim()
        || "The assistant returned no text response.";
      await stopPreviewWatch();
      await flushFinal(text);
      await forget(item.updateId);
    } finally {
      await stopPreviewWatch();
    }

    async function stopPreviewWatch() {
      if (watchStopped) return;
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
      }
      watchStopped = true;
      previewDirty = false;
      await watch.stop();
      await previewWork;
      if (previewFailure !== undefined) throw previewFailure;
    }

    async function flushFinal(text: string) {
      const chunks = splitTelegramText(text);
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.messageId !== undefined) {
        if (current.lastText !== chunks[0]) {
          try {
            await apiCall(api, "editMessageText", signal, (callSignal) => api.editMessageText(
              item.chatId, current.messageId!, chunks[0]!, {}, toGrammySignal(callSignal),
            ), { throttle: outboundThrottle });
          } catch (error) {
            if (isNotModified(error)) {
              // The remote edit may have succeeded before its response was lost.
            } else if (isMessageNotFound(error)) {
              await clearPreview(item.updateId);
              const sent = await apiCall(api, "sendMessage", signal, (callSignal) => api.sendMessage(item.chatId, chunks[0]!, {}, toGrammySignal(callSignal)), { throttle: outboundThrottle });
              if (!sent) throw new Error("Telegram sendMessage returned no result");
              await rememberMessage(item.updateId, sent.message_id, chunks[0]!);
            } else throw error;
          }
          await rememberText(item.updateId, chunks[0]!);
        }
        for (const chunk of chunks.slice(1)) {
          await apiCall(api, "sendMessage", signal, (callSignal) => api.sendMessage(item.chatId, chunk, {}, toGrammySignal(callSignal)), { throttle: outboundThrottle });
        }
      } else {
        for (const chunk of chunks) {
          await apiCall(api, "sendMessage", signal, (callSignal) => api.sendMessage(item.chatId, chunk, {}, toGrammySignal(callSignal)), { throttle: outboundThrottle });
        }
      }
    }

    async function publishPreview(text: string) {
      const preview = splitTelegramText(text)[0];
      if (!preview || signal?.aborted) return;
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.lastText === preview) return;
      if (current.messageId === undefined) {
        const sent = await apiCall(api, "sendMessage", signal, (callSignal) => api.sendMessage(item.chatId, preview, {}, toGrammySignal(callSignal)), { throttle: outboundThrottle, replaceable: true });
        if (sent) await rememberMessage(item.updateId, sent.message_id, preview);
      } else {
        try {
          const edited = await apiCall(api, "editMessageText", signal, (callSignal) => api.editMessageText(
            item.chatId, current.messageId!, preview, {}, toGrammySignal(callSignal),
          ), { throttle: outboundThrottle, replaceable: true });
          if (edited !== undefined) await rememberText(item.updateId, preview);
        } catch (error) {
          if (isNotModified(error)) {
            await rememberText(item.updateId, preview);
          } else if (isMessageNotFound(error)) {
            await clearPreview(item.updateId);
            const sent = await apiCall(api, "sendMessage", signal, (callSignal) => api.sendMessage(item.chatId, preview, {}, toGrammySignal(callSignal)), { throttle: outboundThrottle, replaceable: true });
            if (sent) await rememberMessage(item.updateId, sent.message_id, preview);
          } else throw error;
        }
      }
    }
  };

  const mutatePending = async (updateId: number, change: (item: PendingReply) => void) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const item = doc.pending.find((entry) => entry.updateId === updateId);
      if (item) change(item);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  };
  const rememberMessage = (updateId: number, messageId: number, text: string) =>
    mutatePending(updateId, (item) => { item.messageId = messageId; item.lastText = text; });
  const rememberText = (updateId: number, text: string) =>
    mutatePending(updateId, (item) => { item.lastText = text; });
  const clearPreview = (updateId: number) => mutatePending(updateId, (item) => {
    delete item.messageId;
    delete item.lastText;
  });
  const forget = async (updateId: number) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.pending = doc.pending.filter((entry) => entry.updateId !== updateId);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  };

  // Recover admitted work before polling. Each requestId safely reacquires its existing submission.
  drain();

  try {
    while (!signal?.aborted) {
      failedThisPoll.clear();
      drain();
      const updates = await apiCall(api, "getUpdates", signal, (callSignal) => api.getUpdates({
        offset: state.offset,
        timeout: Math.min(options.pollTimeoutSeconds ?? 30, POLL_TIMEOUT_MAX),
        allowed_updates: ["message"],
      }, toGrammySignal(callSignal)), { throttle: pollThrottle, retryNetwork: true });
      if (!updates) throw new Error("Telegram getUpdates returned no result");
      for (const update of updates) {
        if (signal?.aborted) break;
        const message = update.message;
        if (!isAllowedPrivateMessage(message, options.allowFrom)) {
          await persistOffset(update.update_id + 1);
          continue;
        }
        const sessionKey = `telegram:${identity}:chat:${message!.chat.id}`;
        const conversation = await gateway.conversationFor(sessionKey, adapterContext);
        const text = message!.text ?? message!.caption;
        // Text-only adapter: never imply that an unsupported attachment was read.
        const hasAttachment = ["photo", "document", "audio", "voice", "video", "video_note", "animation", "sticker"]
          .some((field) => (message as unknown as Record<string, unknown>)[field] !== undefined);
        const notice = "[Unsupported Telegram attachment: this adapter accepts text only.]";
        const input = hasAttachment ? `${notice}${text ? ` Caption: ${text}` : ""}`
          : text ?? "[Unsupported Telegram message: this adapter accepts text only.]";
        const requestId = requestIdFor(identity, update.update_id);
        await conversation.submit({ type: "input", content: input, requestId }, adapterContext);
        state = await stateConversation.commit(async (tx) => {
          const doc = await tx.doc(TelegramState, stateConversation.id);
          if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
            if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
            doc.pending.push({
              updateId: update.update_id,
              chatId: message!.chat.id,
              sessionKey,
              senderId: String(message!.from!.id),
              text: input,
            });
          }
          doc.offset = Math.max(doc.offset, update.update_id + 1);
          return copyJson(doc) as unknown as ChannelState;
        }, adapterContext);
        // Admission and recovery metadata are committed before the next getUpdates acknowledges the offset.
        drain();
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    stopping = true;
    scope.cancel(new DOMException("Telegram adapter stopped", "AbortError"));
    await Promise.allSettled([...active]);
  }

  async function persistOffset(offset: number) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.offset = Math.max(doc.offset, offset);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }
}

function validateOptions(options: TelegramOptions): void {
  if (!options.token || /[\r\n]/.test(options.token)) throw new Error("Telegram token is required");
  if (options.allowFrom.length === 0 || options.allowFrom.some((id) => !/^\d+$/.test(id))) {
    throw new Error("Telegram requires a non-empty allowFrom list of decimal user IDs");
  }
  if (options.pollTimeoutSeconds !== undefined &&
      (!Number.isInteger(options.pollTimeoutSeconds) || options.pollTimeoutSeconds < 0 || options.pollTimeoutSeconds > POLL_TIMEOUT_MAX)) {
    throw new Error(`pollTimeoutSeconds must be an integer from 0 to ${POLL_TIMEOUT_MAX}`);
  }
}

function isAllowedPrivateMessage(
  message: Update["message"],
  allowFrom: readonly string[],
): message is TelegramMessage {
  return message !== undefined && message.chat.type === "private" && message.from !== undefined &&
    !message.from.is_bot && allowFrom.includes(String(message.from.id));
}

function requestIdFor(botId: string, updateId: number): string {
  return `telegram:${botId}:${updateId}`;
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT / 2) cut = remaining.lastIndexOf(" ", TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT / 2) cut = TELEGRAM_LIMIT;
    if (cut > 0 && cut < remaining.length && /[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut--;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

type ApiCallOptions = {
  throttle?: TelegramFloodGate;
  replaceable?: boolean;
  retryNetwork?: boolean;
};

type GrammySignal = Parameters<Api["getMe"]>[0];

function toGrammySignal(signal?: AbortSignal): GrammySignal {
  return signal as unknown as GrammySignal;
}

async function apiCall<T>(
  api: Api,
  method: string,
  signal: AbortSignal | undefined,
  request: (signal?: AbortSignal) => Promise<T>,
  options: ApiCallOptions = {},
): Promise<T | undefined> {
  let waitedMs = 0;
  for (let attempt = 0; attempt < MAX_API_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (options.throttle) {
      for (;;) {
        if (options.replaceable && options.throttle.remainingMs() > 0) return undefined;
        waitedMs += await options.throttle.wait(signal, FLOOD_WAIT_BUDGET_MS - waitedMs);
        if (options.throttle.remainingMs() === 0) break;
      }
    }
    try {
      return await request(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof GrammyError) {
        if (method === "editMessageText" && error.error_code === 400 &&
            (isNotModifiedDescription(error.description) || error.description === "Bad Request: message to edit not found")) {
          throw new TelegramApiError(method, error.error_code, error.description);
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after;
          if (retryAfter !== undefined && (!Number.isFinite(retryAfter) || retryAfter <= 0)) {
            throw new Error(`Telegram ${method} failed with status 429`);
          }
          const deadline = Date.now() + (retryAfter === undefined ? FLOOD_WAIT_WITHOUT_HINT_MS : retryAfter * 1000);
          if (!Number.isFinite(deadline)) throw new Error(`Telegram ${method} failed with status 429`);
          options.throttle?.defer(deadline);
          if (options.replaceable) return undefined;
          if (attempt < MAX_API_ATTEMPTS - 1) continue;
          throw new Error(`Telegram ${method} failed with status 429`);
        }
        if (options.retryNetwork && error.error_code >= 500 && attempt < MAX_API_ATTEMPTS - 1) {
          await delay(backoff(attempt), signal);
          continue;
        }
        throw new Error(`Telegram ${method} failed with status ${error.error_code}`);
      }
      if (error instanceof HttpError && options.retryNetwork && attempt < MAX_API_ATTEMPTS - 1) {
        await delay(backoff(attempt), signal);
        continue;
      }
      throw new Error(`Telegram ${method} transport failed`);
    }
  }
  throw new Error(`Telegram ${method} request attempts exhausted`);
}

class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly description: string;

  constructor(method: string, status: number, description: string) {
    super(`Telegram ${method} failed with status ${status}`);
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

function isNotModifiedDescription(description: string | undefined): boolean {
  const prefix = "Bad Request: message is not modified";
  return description === prefix || (description !== undefined && description.length <= 512 &&
    description.startsWith(`${prefix}: `));
}

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    isNotModifiedDescription(error.description);
}

function isMessageNotFound(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    error.description === "Bad Request: message to edit not found";
}

function backoff(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** attempt);
}

class TelegramFloodGate {
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

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
