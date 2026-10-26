import { defineDoc, AssistantEntry } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { Conversation, SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const API = "https://api.telegram.org";
const TELEGRAM_LIMIT = 4096;
const MAX_ADMITTED = 1000;
const MAX_SEND_ATTEMPTS = 5;
const POLL_TIMEOUT_MAX = 50;

export type TelegramOptions = {
  token: string;
  allowFrom: readonly string[];
  pollTimeoutSeconds?: number;
};

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
    text?: string;
    caption?: string;
    [field: string]: unknown;
  };
};

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
  checkpointWhen: () => false,
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
  const signal = context.abortSignal;
  if (signal?.aborted) return;

  const me = await apiCall<{ id: number; username?: string }>(options.token, "getMe", {}, signal);
  const identity = String(me.id);
  const stateConversation = await gateway.conversationFor(`telegram:${identity}:channel-state`, context);
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(TelegramState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  const delivering = new Set<number>();
  const failedThisPoll = new Set<number>();

  const drain = () => {
    if (signal?.aborted) return;
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
        drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: PendingReply) => {
    if (!options.allowFrom.includes(item.senderId)) {
      if (item.messageId !== undefined) {
        await apiCall(options.token, "deleteMessage", { chat_id: item.chatId, message_id: item.messageId }, signal).catch(() => undefined);
      }
      await forget(item.updateId);
      return;
    }
    const conversation = await gateway.conversationFor(item.sessionKey, context);
    const requestId = requestIdFor(identity, item.updateId);
    const watch = await conversation.watch(context);
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewWork = Promise.resolve();
    let previewFailure: unknown;
    let latestPreview = "";
    let submissionId: SubmissionId | undefined;
    let watchStopped = false;
    const queuePreview = (text: string) => {
      latestPreview = text;
      if (previewTimer !== undefined) return;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        previewWork = previewWork.then(() => publishPreview(latestPreview)).catch((error: unknown) => {
          previewFailure = error;
        });
      }, 700);
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
      const submission = await conversation.submit({ type: "input", content: item.text, requestId }, context);
      submissionId = submission.id;
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        await stopPreviewWatch();
        await flushFinal("Your request could not be completed. Please try again.");
        await forget(item.updateId);
        return;
      }
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
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
      await watch.stop();
      watchStopped = true;
      await previewWork;
      if (previewFailure !== undefined) throw previewFailure;
    }

    async function flushFinal(text: string) {
      const chunks = splitTelegramText(text);
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.messageId !== undefined) {
        if (current.lastText !== chunks[0]) {
          await apiCall(options.token, "editMessageText", {
            chat_id: item.chatId, message_id: current.messageId, text: chunks[0],
          }, signal);
          await rememberText(item.updateId, chunks[0]!);
        }
        for (const chunk of chunks.slice(1)) {
          await apiCall(options.token, "sendMessage", { chat_id: item.chatId, text: chunk }, signal);
        }
      } else {
        for (const chunk of chunks) {
          await apiCall(options.token, "sendMessage", { chat_id: item.chatId, text: chunk }, signal);
        }
      }
    }

    async function publishPreview(text: string) {
      const preview = splitTelegramText(text)[0];
      if (!preview || signal?.aborted) return;
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.lastText === preview) return;
      if (current.messageId === undefined) {
        const sent = await apiCall<{ message_id: number }>(options.token, "sendMessage", {
          chat_id: item.chatId, text: preview,
        }, signal);
        await rememberMessage(item.updateId, sent.message_id, preview);
      } else {
        await apiCall(options.token, "editMessageText", {
          chat_id: item.chatId, message_id: current.messageId, text: preview,
        }, signal);
        await rememberText(item.updateId, preview);
      }
    }
  };

  const mutatePending = async (updateId: number, change: (item: PendingReply) => void) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const item = doc.pending.find((entry) => entry.updateId === updateId);
      if (item) change(item);
      return copyJson(doc) as unknown as ChannelState;
    }, context);
  };
  const rememberMessage = (updateId: number, messageId: number, text: string) =>
    mutatePending(updateId, (item) => { item.messageId = messageId; item.lastText = text; });
  const rememberText = (updateId: number, text: string) =>
    mutatePending(updateId, (item) => { item.lastText = text; });
  const forget = async (updateId: number) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.pending = doc.pending.filter((entry) => entry.updateId !== updateId);
      return copyJson(doc) as unknown as ChannelState;
    }, context);
  };

  // Recover admitted work before polling. Each requestId safely reacquires its existing submission.
  drain();

  try {
    while (!signal?.aborted) {
      failedThisPoll.clear();
      drain();
      const pollSeconds = options.pollTimeoutSeconds ?? 30;
      const updates = await apiCall<Update[]>(options.token, "getUpdates", {
        offset: state.offset,
        timeout: Math.min(options.pollTimeoutSeconds ?? 30, POLL_TIMEOUT_MAX),
        allowed_updates: ["message"],
      }, signal, (pollSeconds + 10) * 1000);
      for (const update of updates) {
        if (signal?.aborted) break;
        const message = update.message;
        if (!isAllowedPrivateMessage(message, options.allowFrom)) {
          await persistOffset(update.update_id + 1);
          continue;
        }
        const sessionKey = `telegram:${identity}:chat:${message!.chat.id}`;
        const conversation = await gateway.conversationFor(sessionKey, context);
        const text = message!.text ?? message!.caption;
        // Text-only adapter: never imply that an unsupported attachment was read.
        const hasAttachment = ["photo", "document", "audio", "voice", "video", "video_note", "animation", "sticker"]
          .some((field) => message![field] !== undefined);
        const notice = "[Unsupported Telegram attachment: this adapter accepts text only.]";
        const input = hasAttachment ? `${notice}${text ? ` Caption: ${text}` : ""}`
          : text ?? "[Unsupported Telegram message: this adapter accepts text only.]";
        const requestId = requestIdFor(identity, update.update_id);
        await conversation.submit({ type: "input", content: input, requestId }, context);
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
        }, context);
        // Admission and recovery metadata are committed before the next getUpdates acknowledges the offset.
        drain();
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    await Promise.allSettled(active);
  }

  async function persistOffset(offset: number) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.offset = Math.max(doc.offset, offset);
      return copyJson(doc) as unknown as ChannelState;
    }, context);
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
): message is NonNullable<Update["message"]> {
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

async function apiCall<T = void>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<T> {
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason;
    let response: Response;
    try {
      response = await fetch(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (attempt === MAX_SEND_ATTEMPTS - 1) throw new Error(`Telegram ${method} transport failed`);
      await delay(backoff(attempt), signal);
      continue;
    }
    lastStatus = response.status;
    let payload: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw new Error(`Telegram ${method} returned an invalid response (${response.status})`);
    }
    if (response.ok && payload.ok) return payload.result as T;
    const code = payload.error_code ?? response.status;
    if (code === 429 || code >= 500) {
      if (attempt < MAX_SEND_ATTEMPTS - 1) {
        const retry = payload.parameters?.retry_after;
        await delay(retry === undefined ? backoff(attempt) : Math.min(30_000, retry * 1000), signal);
        continue;
      }
    }
    throw new Error(`Telegram ${method} failed with status ${code}`);
  }
  throw new Error(`Telegram ${method} failed with status ${lastStatus ?? "unknown"}`);
}

function backoff(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** attempt);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
