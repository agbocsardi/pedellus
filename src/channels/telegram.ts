import { defineDoc, AssistantEntry } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import { Api, GrammyError, HttpError } from "grammy";
import type { ApiClientOptions } from "grammy";
import type { Update } from "grammy/types";
import type { Conversation, SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CHANNEL_STATE_SESSION_SUFFIX } from "../history/scope.js";

const API = "https://api.telegram.org";
const TELEGRAM_LIMIT = 4096;
const MAX_ADMITTED = 1000;
const MAX_API_ATTEMPTS = 5;
const POLL_TIMEOUT_MAX = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FLOOD_WAIT_BUDGET_MS = 5 * 60_000;
/** How long a command acknowledgement waits for its native call before reporting that it is still pending. */
const CONTROL_PENDING_NOTICE_MS = 30_000;
/** Consecutive delivery failures after which a non-Telegram-rejected failure is held instead of retried forever. */
const MAX_DELIVERY_FAILURES = 10;
const FLOOD_WAIT_WITHOUT_HINT_MS = 1_000;
const COMMAND_NAME_MAX = 32;
const BOT_MENTION_MAX = 64;
const MAX_CONTROL_RECORDS = 64;
/** Unresolved commands kept at most; further commands are refused so a hung or flooded chat cannot grow the log. */
const MAX_UNRESOLVED_CONTROLS = 64;
const MAX_NOTICE_CHARS = 1_500;

export type TelegramOptions = {
  token: string;
  allowFrom: readonly string[];
  pollTimeoutSeconds?: number;
};

type TelegramMessage = NonNullable<Update["message"]>;

export type TelegramPendingDelivery = {
  updateId: number;
  chatId: number;
  sessionKey: string;
  senderId: string;
  text: string;
  messageId?: number;
  lastText?: string;
  nextChunkIndex: number;
  /** `unknown`: an ambiguous external outcome. `failed`: a known-rejected or repeatedly failing delivery, held. */
  deliveryStatus?: "sending" | "unknown" | "failed";
  sendIntent?: { text: string; stage: "preview" | "final"; chunkIndex?: number; startedAt: number };
  unknownStage?: "preview" | "final";
  unknownChunkIndex?: number;
  unknownSince?: number;
  /** A command acknowledgement: delivered as fixed text, never submitted to the model. */
  notice?: boolean;
  /** The acknowledgement is withheld until the command's native call returns (or reports that it is still pending). */
  hold?: boolean;
};
/**
 * One authenticated control command. `admitted` is committed with the acknowledgement and the polling offset before
 * the native call; `applied` after it returns; `unconfirmed` when a reopen found it interrupted.
 */
export type TelegramControlRecord = {
  updateId: number;
  command: string;
  status: "admitted" | "applied" | "unconfirmed";
  /** Chat and sender, so a reopen can report an interrupted command without its acknowledgement record. */
  chatId: number;
  senderId: string;
};
export type TelegramChannelState = {
  offset: number;
  pending: TelegramPendingDelivery[];
  controls: TelegramControlRecord[];
};
type PendingReply = TelegramPendingDelivery;
type SubmissionSlot = { readonly prior: Promise<void>; release(): void };
type ChannelState = TelegramChannelState;

// Stored alongside the adapter's stable channel conversation, not in a plaintext sidecar.
export const TelegramState = defineDoc<ChannelState>({
  kind: "nanobot.telegram-state",
  version: 3,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
  migrate: (value, fromVersion) => {
    if (fromVersion === 1) {
      return {
        offset: Number(value.offset ?? 0),
        pending: (value.pending as unknown as PendingReply[]).map((item) => ({
          ...item,
          nextChunkIndex: 0,
        })),
        controls: [],
      };
    }
    if (fromVersion === 2) {
      return { offset: Number(value.offset ?? 0), pending: value.pending as unknown as PendingReply[], controls: [] };
    }
    throw new Error(`Unsupported Telegram state version ${fromVersion}`);
  },
  initial: () => ({ offset: 0, pending: [], controls: [] }),
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
  const cleanupContext = withoutAbortSignal(adapterContext);
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
  const stateConversation = await gateway.conversationFor(
    `telegram:${identity}${CHANNEL_STATE_SESSION_SUFFIX}`,
    context,
  );
  let state = await stateConversation.commit(async (tx) =>
    copyJson(await tx.doc(TelegramState, stateConversation.id)) as unknown as ChannelState,
  context);

  const active = new Set<Promise<void>>();
  /** Input replies and acknowledgements have separate concurrency bounds, so a full reply queue cannot hide an ack. */
  let activeReplies = 0;
  let activeNotices = 0;
  const delivering = new Set<number>();
  const failedThisPoll = new Set<number>();
  /** Chats whose control command is still being applied: nothing for them is submitted or delivered. */
  const controlPending = new Set<number>();
  const controlChains = new Map<number, Promise<void>>();
  const submissionChains = new Map<number, Promise<void>>();
  const pendingControls = new Set<Promise<void>>();
  /** Consecutive delivery failures per pending record, so a permanent failure is held instead of retried forever. */
  const deliveryFailures = new Map<number, number>();
  let fatal: unknown;
  let stopping = false;

  /**
   * Reserve one chat's next submission place when the delivery is dispatched, before any asynchronous preparation, so
   * admission order never depends on how long `conversationFor`/`watch` take. Durable orders the inbox by submission.
   */
  const beginSubmission = (chatId: number): SubmissionSlot => {
    const prior = submissionChains.get(chatId) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const tail = prior.then(() => held);
    submissionChains.set(chatId, tail);
    let released = false;
    return {
      prior,
      release: () => {
        if (released) return;
        released = true;
        open();
        if (submissionChains.get(chatId) === tail) submissionChains.delete(chatId);
      },
    };
  };

  /** Submit through a fresh place in a chat's order, for work that is not itself a dispatched delivery. */
  const submitInOrder = async <T>(chatId: number, work: () => Promise<T>): Promise<T> => {
    const slot = beginSubmission(chatId);
    try {
      await slot.prior;
      return await work();
    } finally {
      slot.release();
    }
  };

  const drain = () => {
    if (stopping || signal?.aborted) return;
    const heldChats = new Set<number>();
    for (const item of state.pending) {
      const notice = item.notice === true;
      if (item.hold === true) {
        heldChats.add(item.chatId);
        continue;
      }
      // A chat's notices keep admission order behind an acknowledgement that is still held.
      if (notice && heldChats.has(item.chatId)) continue;
      if (notice ? activeNotices >= 8 : activeReplies >= 8) continue;
      // A gated chat holds its inputs; an acknowledgement is never a model submission, so it can still be delivered.
      if (!notice && controlPending.has(item.chatId)) continue;
      if (item.deliveryStatus !== undefined && options.allowFrom.includes(item.senderId)) continue;
      if (delivering.has(item.updateId) || failedThisPoll.has(item.updateId)) continue;
      delivering.add(item.updateId);
      if (notice) activeNotices += 1;
      else activeReplies += 1;
      const slot = beginSubmission(item.chatId);
      const task = Promise.resolve().then(() => deliver(item, slot)).catch(async (error: unknown) => {
        // Keep durable state for the next polling cycle; no exception details or tight retry loop in the log.
        failedThisPoll.add(item.updateId);
        await holdFailedDelivery(item.updateId, error).catch(() => undefined);
      }).finally(() => {
        slot.release();
        if (notice) activeNotices -= 1;
        else activeReplies -= 1;
        active.delete(task);
        delivering.delete(item.updateId);
        if (!stopping && !signal?.aborted) drain();
      });
      active.add(task);
    }
  };

  const deliver = async (item: PendingReply, slot: SubmissionSlot) => {
    if (!options.allowFrom.includes(item.senderId)) {
      if (item.messageId !== undefined) {
        await apiCall(api, "deleteMessage", signal, (callSignal) => api.deleteMessage(item.chatId, item.messageId!, toGrammySignal(callSignal)), { throttle: outboundThrottle }).catch(() => undefined);
      }
      await forget(item.updateId);
      return;
    }
    if (item.notice === true) {
      await deliverNotice(item);
      return;
    }
    // Enter this chat's submission order before any asynchronous preparation, so a slow first lookup cannot let a
    // later message submit ahead of an earlier one.
    await slot.prior;
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
      // Ordering is established; free the chat's next submission place while this turn runs.
      slot.release();
      submissionId = submission.id;
      const settled = await submission.wait(adapterContext);
      if (settled.status !== "done" || settled.type !== "input") {
        await stopPreviewWatch();
        // A native abort or a queued reset deliberately ends a turn; that is not a delivery failure to report.
        const intentional = settled.status === "unanswered" &&
          (settled.reason === "aborted" || settled.reason === "reset");
        if (!intentional) await flushFinal("Your request could not be completed. Please try again.");
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

    async function deliverNotice(current: PendingReply) {
      // One bounded message; a committed chunk cursor means the acknowledgement was already accepted.
      if (current.nextChunkIndex > 0) {
        await forget(current.updateId);
        return;
      }
      const sent = await sendTelegramMessage(current.text, "final", 0);
      if (sent === undefined) throw new Error("Telegram sendMessage returned no result");
      await forget(current.updateId);
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
      let current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      for (let index = current.nextChunkIndex; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        if (index === 0 && current.messageId !== undefined) {
          if (current.lastText !== chunk) {
            try {
              await apiCall(api, "editMessageText", signal, (callSignal) => api.editMessageText(
                item.chatId, current.messageId!, chunk, {}, toGrammySignal(callSignal),
              ), { throttle: outboundThrottle });
            } catch (error) {
              if (isNotModified(error)) {
                // The remote edit may have succeeded before its response was lost.
              } else if (isMessageNotFound(error)) {
                await clearPreview(item.updateId);
                const sent = await sendTelegramMessage(chunk, "final", index);
                if (!sent) throw new Error("Telegram sendMessage returned no result");
                await markChunkDelivered(item.updateId, index, chunk, sent.message_id);
                current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
                continue;
              } else throw error;
            }
            await markChunkDelivered(item.updateId, index, chunk);
          } else {
            await markChunkDelivered(item.updateId, index, chunk);
          }
        } else {
          const sent = await sendTelegramMessage(chunk, "final", index);
          if (!sent) throw new Error("Telegram sendMessage returned no result");
          await markChunkDelivered(item.updateId, index, chunk, index === 0 ? sent.message_id : undefined);
        }
        current = state.pending.find((entry) => entry.updateId === item.updateId) ?? current;
      }
    }

    async function sendTelegramMessage(
      text: string,
      stage: "preview" | "final",
      chunkIndex?: number,
      replaceable = false,
    ) {
      try {
        return await apiCall(api, "sendMessage", signal,
          async (callSignal) => {
            await mutatePending(item.updateId, (entry) => {
              entry.deliveryStatus = "sending";
              entry.sendIntent = { text, stage, startedAt: Date.now(), ...(chunkIndex === undefined ? {} : { chunkIndex }) };
            });
            if (signal?.aborted) {
              await clearSendIntent(item.updateId);
              throw new TelegramApiError("sendMessage", 0, "not-sent");
            }
            let sent;
            try {
              sent = await api.sendMessage(item.chatId, text, {}, toGrammySignal(callSignal));
            } catch (error) {
              if ((error instanceof GrammyError && error.error_code < 500) ||
                  (error instanceof HttpError && isProvenPreConnectFailure(error.error))) {
                await clearSendIntent(item.updateId);
              }
              throw error;
            }
            await mutatePending(item.updateId, (entry) => {
              delete entry.deliveryStatus;
              delete entry.sendIntent;
              delete entry.unknownStage;
              delete entry.unknownChunkIndex;
              delete entry.unknownSince;
              if (stage === "final" && chunkIndex !== undefined) entry.nextChunkIndex = chunkIndex + 1;
              if (stage === "preview" || chunkIndex === 0) {
                entry.messageId = sent.message_id;
                entry.lastText = text;
              }
            }, cleanupContext);
            return sent;
          },
          { throttle: outboundThrottle, replaceable });
      } catch (error) {
        if (error instanceof TelegramApiError && error.outcome === "unknown") {
          await markUnknown(item.updateId, stage, chunkIndex);
          console.warn(`Telegram delivery outcome unknown for update ${item.updateId} (${stage}); inspect the Durable channel-state record.`);
        } else if (!(state.pending.find((entry) => entry.updateId === item.updateId)?.deliveryStatus === "sending")) {
          await clearSendIntent(item.updateId);
        } else {
          await markUnknown(item.updateId, stage, chunkIndex);
        }
        throw error;
      }
    }

    async function publishPreview(text: string) {
      const preview = splitTelegramText(text)[0];
      if (!preview || signal?.aborted) return;
      const current = state.pending.find((entry) => entry.updateId === item.updateId) ?? item;
      if (current.deliveryStatus === "unknown" || current.lastText === preview) return;
      if (current.messageId === undefined) {
        const sent = await sendTelegramMessage(preview, "preview", undefined, true);
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
            const sent = await sendTelegramMessage(preview, "preview", undefined, true);
            if (sent) await rememberMessage(item.updateId, sent.message_id, preview);
          } else throw error;
        }
      }
    }
  };

  const mutatePending = async (
    updateId: number,
    change: (item: PendingReply) => void,
    commitContext: Context = adapterContext,
  ) => {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const item = doc.pending.find((entry) => entry.updateId === updateId);
      if (item) change(item);
      return copyJson(doc) as unknown as ChannelState;
    }, commitContext);
  };
  const clearSendIntent = (updateId: number) => mutatePending(updateId, (entry) => {
    delete entry.deliveryStatus;
    delete entry.sendIntent;
  }, cleanupContext);
  const rememberMessage = (updateId: number, messageId: number, text: string) =>
    mutatePending(updateId, (item) => { item.messageId = messageId; item.lastText = text; }, cleanupContext);
  const rememberText = (updateId: number, text: string) =>
    mutatePending(updateId, (item) => { item.lastText = text; }, cleanupContext);
  const clearPreview = (updateId: number) => mutatePending(updateId, (item) => {
    delete item.messageId;
    delete item.lastText;
  }, cleanupContext);
  const markChunkDelivered = (updateId: number, index: number, text: string, messageId?: number) =>
    mutatePending(updateId, (item) => {
      item.nextChunkIndex = Math.max(item.nextChunkIndex, index + 1);
      if (index === 0) {
        item.lastText = text;
        if (messageId !== undefined) item.messageId = messageId;
      }
    }, cleanupContext);
  const markUnknown = (updateId: number, stage: "preview" | "final", chunkIndex?: number) =>
    mutatePending(updateId, (item) => {
      item.deliveryStatus = "unknown";
      item.unknownStage = stage;
      item.unknownSince = Date.now();
      if (chunkIndex === undefined) delete item.unknownChunkIndex;
      else item.unknownChunkIndex = chunkIndex;
    }, cleanupContext);
  const forget = async (updateId: number) => {
    deliveryFailures.delete(updateId);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      doc.pending = doc.pending.filter((entry) => entry.updateId !== updateId);
      // Its "interrupted" report is now durably delivered, so the terminal record has served its purpose.
      doc.controls = doc.controls.filter((entry) =>
        !(entry.updateId === updateId && entry.status === "unconfirmed"));
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  };

  /**
   * A known Telegram rejection will not improve on retry, and a repeated failure should stay visible instead of
   * retrying on every poll. Hold the record for reconciliation; it is never resent automatically.
   */
  async function holdFailedDelivery(updateId: number, error: unknown): Promise<void> {
    if (error instanceof TelegramApiError) {
      // An ambiguous send was already quarantined with its write-ahead intent; never downgrade or recount it.
      if (error.outcome === "unknown") return;
      // A flood wait is a cooldown instruction, not a permanent rejection: the shared gate already deferred the retry.
      if (error.status === 429) return;
    }
    const attempts = (deliveryFailures.get(updateId) ?? 0) + 1;
    deliveryFailures.set(updateId, attempts);
    const rejected = error instanceof TelegramApiError && error.outcome === "rejected";
    if (!rejected && attempts < MAX_DELIVERY_FAILURES) return;
    deliveryFailures.delete(updateId);
    await mutatePending(updateId, (item) => {
      if (item.deliveryStatus === "unknown") return;
      item.deliveryStatus = "failed";
      delete item.sendIntent;
    }, cleanupContext);
    console.warn(`Telegram delivery for update ${updateId} is held after ${attempts} failure(s); inspect the Durable channel-state record.`);
  }

  // A control recorded but never confirmed may or may not have taken effect: report it once, never replay it.
  const unresolved = state.controls.filter((entry) => entry.status === "admitted");
  const heldNotices = state.pending.some((item) => item.hold === true);
  if (unresolved.length > 0 || heldNotices) {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      for (const entry of doc.controls) {
        if (entry.status !== "admitted") continue;
        const notice = doc.pending.find((item) => item.notice === true && item.updateId === entry.updateId);
        if (notice !== undefined) {
          // In flight at a crash: correct the held acknowledgement (one message) and release it.
          if (notice.hold === true) notice.text = UNCONFIRMED_CONTROL;
          delete notice.hold;
          entry.status = "unconfirmed";
          continue;
        }
        // Nothing left to correct: report the unconfirmed effect for the recorded chat, once.
        if (doc.pending.length >= MAX_ADMITTED) continue;
        doc.pending.push({
          updateId: entry.updateId,
          nextChunkIndex: 0,
          chatId: entry.chatId,
          sessionKey: `telegram:${identity}:chat:${entry.chatId}`,
          senderId: entry.senderId,
          text: UNCONFIRMED_CONTROL,
          notice: true,
        });
        entry.status = "unconfirmed";
      }
      for (const notice of doc.pending) {
        if (notice.hold !== true) continue;
        const record = doc.controls.find((entry) => entry.updateId === notice.updateId);
        if (record === undefined) {
          notice.text = UNCONFIRMED_CONTROL;
          delete notice.hold;
        } else if (record.status === "applied") {
          delete notice.hold;
        }
      }
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    if (unresolved.length > 0) {
      console.warn(`Telegram ${unresolved.length} control command(s) were interrupted; their effect is unconfirmed.`);
    }
  }
  // An unresolved write-ahead intent may have reached Telegram before a crash.
  for (const item of state.pending.filter((entry) => entry.sendIntent !== undefined || entry.deliveryStatus === "sending")) {
    await markUnknown(item.updateId, item.sendIntent?.stage ?? "final", item.sendIntent?.chunkIndex);
    console.warn(`Telegram delivery outcome unknown for update ${item.updateId}; inspect the Durable channel-state record.`);
  }
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
        // Control parsing happens only after allowlist authentication and never for attachments.
        const parsed = parseTelegramInput(message.text ?? "", me.username);
        if (parsed.kind !== "input") {
          await handleControl(update, message, parsed);
          continue;
        }
        const sessionKey = `telegram:${identity}:chat:${message.chat.id}`;
        const text = message.text !== undefined ? parsed.text : message.caption;
        // Text-only adapter: never imply that an unsupported attachment was read.
        const hasAttachment = ["photo", "document", "audio", "voice", "video", "video_note", "animation", "sticker"]
          .some((field) => (message as unknown as Record<string, unknown>)[field] !== undefined);
        const notice = "[Unsupported Telegram attachment: this adapter accepts text only.]";
        const input = hasAttachment ? `${notice}${text ? ` Caption: ${text}` : ""}`
          : text ?? "[Unsupported Telegram message: this adapter accepts text only.]";
        state = await stateConversation.commit(async (tx) => {
          const doc = await tx.doc(TelegramState, stateConversation.id);
          if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
            if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
            doc.pending.push({
              updateId: update.update_id,
              nextChunkIndex: 0,
              chatId: message!.chat.id,
              sessionKey,
              senderId: String(message!.from!.id),
              text: input,
            });
          }
          doc.offset = Math.max(doc.offset, update.update_id + 1);
          return copyJson(doc) as unknown as ChannelState;
        }, adapterContext);
        // The exact input and the offset commit before any model submission, so a crash cannot lose or duplicate it.
        drain();
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    stopping = true;
    scope.cancel(new DOMException("Telegram adapter stopped", "AbortError"));
    await Promise.allSettled([...active, ...pendingControls]);
  }
  if (fatal !== undefined) throw fatal;

  async function handleControl(
    update: Update,
    message: TelegramMessage,
    parsed: Exclude<ParsedTelegramInput, { kind: "input" }>,
  ): Promise<void> {
    const chatId = message.chat.id;
    const sessionKey = `telegram:${identity}:chat:${chatId}`;
    const recorded = state.controls.find((entry) => entry.updateId === update.update_id);
    if (recorded !== undefined) {
      // The command was durably admitted before its effect, so a replay reports it instead of running it twice.
      if (recorded.status === "admitted") await markControlUnconfirmed(recorded.updateId);
      await admitNotice(update, message, sessionKey, recorded.status === "applied"
        ? "That command was already applied before a restart, so it was not run again."
        : recorded.status === "unconfirmed"
          ? "That command was already reported as interrupted; send it again if you still need it."
          : UNCONFIRMED_CONTROL);
      drain();
      return;
    }
    if (parsed.kind === "foreign") {
      await admitNotice(update, message, sessionKey,
        `/${parsed.command}@${parsed.mention} did not run here and was not sent to the assistant: this bot only ` +
        `accepts an exact mention of its own username. Use /${parsed.command} without a mention.`);
      drain();
      return;
    }
    if (parsed.kind === "unsupported") {
      await admitNotice(update, message, sessionKey,
        `Unsupported command /${parsed.command}. Available: /new, /abort, /help. ` +
        "Any other message is sent to the assistant; prefix // to send a leading slash literally.");
      drain();
      return;
    }
    if (parsed.args) {
      await admitNotice(update, message, sessionKey, `Usage: /${parsed.command} (no arguments). Nothing was sent to the assistant.`);
      drain();
      return;
    }
    if (parsed.command === "help") {
      await admitNotice(update, message, sessionKey, CONTROL_HELP);
      drain();
      return;
    }
    // Captured before the callbacks below: the remaining commands are exactly these two.
    const command: "new" | "abort" = parsed.command === "new" ? "new" : "abort";
    // Refuse, never evict: a hung provider plus repeated commands must not grow the log without bound.
    if (state.controls.filter((entry) => entry.status !== "applied").length >= MAX_UNRESOLVED_CONTROLS) {
      await admitNotice(update, message, sessionKey,
        `Too many control commands are still unconfirmed (limit ${MAX_UNRESOLVED_CONTROLS}); this /${command} was not ` +
        "started and was not sent to the assistant. Wait for them to finish or restart the adapter.");
      drain();
      return;
    }
    // Durable intent first: command record, acknowledgement and offset commit before the native call. The chat stays
    // gated until the command finishes, so its acknowledgement is never delivered early.
    controlPending.add(chatId);
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (!doc.controls.some((entry) => entry.updateId === update.update_id)) {
        doc.controls = pruneControls([
          ...doc.controls,
          {
            updateId: update.update_id,
            command,
            status: "admitted" as const,
            chatId,
            senderId: String(message.from!.id),
          },
        ], doc.pending);
      }
      if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId,
          sessionKey,
          senderId: String(message.from!.id),
          text: CONTROL_ACK[command],
          notice: true,
          hold: true,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
    // Apply it off the polling loop, serialized per chat: other chats keep polling, and this chat's later inputs and
    // deliveries wait here so the abort cannot withdraw a message admitted after the command.
    const prior = controlChains.get(chatId) ?? Promise.resolve();
    const run = prior.then(async () => {
      // Every message admitted before the command is submitted first, including one still parked behind the delivery
      // cap, so the native reset/abort orders correctly and an abort cannot land between admission and submission.
      for (const earlier of state.pending.filter((item) =>
        item.notice !== true && item.chatId === chatId && item.updateId < update.update_id &&
        options.allowFrom.includes(item.senderId))) {
        const earlierConversation = await gateway.conversationFor(earlier.sessionKey, adapterContext);
        await submitInOrder(chatId, () => earlierConversation.submit(
          { type: "input", content: earlier.text, requestId: requestIdFor(identity, earlier.updateId) },
          adapterContext,
        ));
      }
      const conversation = await gateway.conversationFor(sessionKey, adapterContext);
      if (command === "new") await conversation.reset(undefined, adapterContext);
      else await conversation.abort(adapterContext);
      state = await stateConversation.commit(async (tx) => {
        const doc = await tx.doc(TelegramState, stateConversation.id);
        const entry = doc.controls.find((item) => item.updateId === update.update_id);
        if (entry !== undefined) entry.status = "applied";
        // Bound the log here too: only applied and already-reported records are pruned, never an unresolved one.
        doc.controls = pruneControls(doc.controls, doc.pending);
        return copyJson(doc) as unknown as ChannelState;
      }, adapterContext);
    });
    // The acknowledgement is published once: as the applied wording when the native call returns, or as the explicit
    // still-pending wording when it does not. A provider that ignores cancellation keeps the chat gated, so no later
    // message can be withdrawn, and it is told plainly instead of being left silent.
    let ack: "waiting" | "pending" | "applied" = "waiting";
    const pendingTimer = setTimeout(() => {
      if (ack !== "waiting") return;
      ack = "pending";
      void releaseControlNotice(update.update_id, CONTROL_PENDING[command]).catch(() => undefined);
    }, CONTROL_PENDING_NOTICE_MS);
    const chain = run.then(() => undefined, () => undefined);
    controlChains.set(chatId, chain);
    const task = run.then(async () => {
      if (ack !== "waiting") return;
      ack = "applied";
      await releaseControlNotice(update.update_id);
    }, (error: unknown) => {
      // The record stays `admitted` and the acknowledgement stays held: a reopen reports it as unconfirmed.
      if (signal?.aborted) return;
      fatal ??= error;
      scope.cancel(error instanceof Error ? error : new Error("Telegram control command failed"));
    }).catch(() => {
      // A failed acknowledgement release leaves the held notice for the next open to report; the command itself is done.
    }).finally(() => {
      clearTimeout(pendingTimer);
      pendingControls.delete(task);
      if (controlChains.get(chatId) === chain) {
        controlChains.delete(chatId);
        if (!stopping && !signal?.aborted) {
          controlPending.delete(chatId);
          drain();
        }
      }
    });
    pendingControls.add(task);
    drain();
  }

  /** Publish the held acknowledgement, optionally as the still-pending wording. */
  async function releaseControlNotice(updateId: number, text?: string): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice === undefined) return copyJson(doc) as unknown as ChannelState;
      if (text !== undefined) notice.text = text;
      delete notice.hold;
      return copyJson(doc) as unknown as ChannelState;
    }, cleanupContext);
  }

  /** Report that an admitted command never confirmed its effect, and release its held acknowledgement. */
  async function markControlUnconfirmed(updateId: number): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      const entry = doc.controls.find((item) => item.updateId === updateId);
      if (entry !== undefined) entry.status = "unconfirmed";
      const notice = doc.pending.find((item) => item.notice === true && item.updateId === updateId);
      if (notice !== undefined) {
        notice.text = UNCONFIRMED_CONTROL;
        delete notice.hold;
      }
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
  }

  async function admitNotice(
    update: Update,
    message: TelegramMessage,
    sessionKey: string,
    text: string,
  ): Promise<void> {
    state = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      if (!doc.pending.some((entry) => entry.updateId === update.update_id)) {
        if (doc.pending.length >= MAX_ADMITTED) throw new Error("Telegram durable output queue is full");
        doc.pending.push({
          updateId: update.update_id,
          nextChunkIndex: 0,
          chatId: message.chat.id,
          sessionKey,
          senderId: String(message.from!.id),
          text: text.slice(0, MAX_NOTICE_CHARS),
          notice: true,
        });
      }
      doc.offset = Math.max(doc.offset, update.update_id + 1);
      return copyJson(doc) as unknown as ChannelState;
    }, adapterContext);
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

type ParsedTelegramInput =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "control"; readonly command: TelegramControl; readonly args: string }
  | { readonly kind: "unsupported"; readonly command: string }
  | { readonly kind: "foreign"; readonly command: string; readonly mention: string };

type TelegramControl = "new" | "abort" | "help";

const CONTROL_ACK: Record<"new" | "abort", string> = {
  new:
    "Context reset applied for this chat (native Durable reset, no handoff text, no summary). " +
    "Stored entries and tool grants are unchanged; queued messages are kept and run in the new context.",
  abort:
    "Abort applied for this chat: it is idle now. Queued messages were withdrawn and any running turn was stopped; " +
    "other chats, cron jobs and background work are unaffected.",
};

const CONTROL_PENDING: Record<"new" | "abort", string> = {
  new:
    "Context reset is still pending for this chat: Durable has not admitted it yet. Stored entries, tool grants and " +
    "queued messages are unchanged, and this chat keeps waiting instead of losing the request.",
  abort:
    "Abort is still pending for this chat: Durable has not finished stopping the current turn, so the provider may be " +
    "ignoring cancellation. Queued messages stay withdrawn and new messages are held, never answered and never " +
    "dropped, until the turn ends. Other chats, cron jobs and background work are unaffected.",
};

const UNCONFIRMED_CONTROL =
  "That earlier /new or /abort was interrupted before it was confirmed, so it may not have taken effect. " +
  "Send it again if you still need it.";

const CONTROL_HELP = [
  "Controls for this chat (other messages go to the assistant):",
  "/new - native context reset for this conversation: fresh model context, no summary or handoff; stored history and tool grants unchanged; queued messages are kept.",
  "/abort - withdraw queued messages and stop the current turn here; other chats, cron jobs and background work are unaffected.",
  "/help - this list.",
  "Limits: text only (attachments are not read); no tool-grant, history, restart or media commands. Other slash commands are refused; prefix // to send a leading slash literally.",
].join("\n");

const TELEGRAM_COMMAND = new RegExp(
  "^/([A-Za-z0-9_]{1," + COMMAND_NAME_MAX + "})(?:@([A-Za-z0-9_]{1," + BOT_MENTION_MAX + "}))?(?=\\s|$)",
);

/**
 * Classify one authenticated private-chat message. Only a leading exact command token counts; a bot mention must name
 * this bot, and everything else (including `//text`) stays ordinary assistant input.
 */
function parseTelegramInput(raw: string, botUsername: string | undefined): ParsedTelegramInput {
  if (!raw.startsWith("/")) return { kind: "input", text: raw };
  if (raw.startsWith("//")) return { kind: "input", text: raw.slice(1) };
  const match = TELEGRAM_COMMAND.exec(raw);
  if (!match) {
    // A malformed mention (`/new@`, `/new@@x`) is a command attempt, not assistant text.
    const malformed = /^\/([A-Za-z0-9_]{1,32})@/.exec(raw);
    return malformed === null
      ? { kind: "input", text: raw }
      : { kind: "unsupported", command: malformed[1]!.toLowerCase() };
  }
  const name = match[1]!;
  const mention = match[2];
  const command = name.toLowerCase();
  if (mention !== undefined && (botUsername === undefined || mention.toLowerCase() !== botUsername.toLowerCase())) {
    // Never execute or forward another bot's command; the caller answers with a bounded notice.
    return { kind: "foreign", command, mention: mention.toLowerCase() };
  }
  if (command === "new" || command === "abort" || command === "help") {
    return { kind: "control", command, args: raw.slice(match[0].length).trim() };
  }
  return { kind: "unsupported", command };
}

/**
 * Keep every unresolved record, only the most recent applied ones, and a reported terminal record only while its
 * report is still queued. A hung provider plus repeated commands therefore cannot grow the log: unresolved records are
 * bounded by the admission limit and reported ones are pruned once delivered.
 */
function pruneControls(
  controls: readonly TelegramControlRecord[],
  pending: readonly TelegramPendingDelivery[],
): TelegramControlRecord[] {
  const totalApplied = controls.filter((entry) => entry.status === "applied").length;
  let drop = Math.max(0, totalApplied - MAX_CONTROL_RECORDS);
  const reported = new Set(pending.filter((item) => item.notice === true).map((item) => item.updateId));
  return controls.filter((entry) => {
    if (entry.status === "unconfirmed" && !reported.has(entry.updateId)) return false;
    if (entry.status !== "applied" || drop === 0) return true;
    drop -= 1;
    return false;
  });
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
    if (signal?.aborted) throw signal.reason;
    try {
      return await request(signal);
    } catch (error) {
      if (error instanceof GrammyError) {
        if (method === "editMessageText" && error.error_code === 400 &&
            (isNotModifiedDescription(error.description) || error.description === "Bad Request: message to edit not found")) {
          throw new TelegramApiError(method, error.error_code, "rejected", error.description);
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after;
          if (retryAfter !== undefined && (!Number.isFinite(retryAfter) || retryAfter <= 0)) {
            throw new TelegramApiError(method, 429, "rejected");
          }
          const deadline = Date.now() + (retryAfter === undefined ? FLOOD_WAIT_WITHOUT_HINT_MS : retryAfter * 1000);
          if (!Number.isFinite(deadline)) throw new TelegramApiError(method, 429, "rejected");
          options.throttle?.defer(deadline);
          if (options.replaceable) return undefined;
          if (attempt < MAX_API_ATTEMPTS - 1) continue;
          throw new TelegramApiError(method, 429, "rejected");
        }
        if (options.retryNetwork && error.error_code >= 500 && attempt < MAX_API_ATTEMPTS - 1) {
          await delay(backoff(attempt), signal);
          continue;
        }
        throw new TelegramApiError(method, error.error_code,
          method === "sendMessage" && error.error_code >= 500 ? "unknown" : "rejected");
      }
      if (error instanceof HttpError) {
        if (method === "sendMessage") {
          if (isProvenPreConnectFailure(error.error)) {
            if (attempt < MAX_API_ATTEMPTS - 1 && !signal?.aborted) {
              await delay(backoff(attempt), signal);
              continue;
            }
            throw new TelegramApiError(method, 0, "not-sent");
          }
          throw new TelegramApiError(method, 0, "unknown");
        }
        if (signal?.aborted) throw signal.reason;
        if (options.retryNetwork && attempt < MAX_API_ATTEMPTS - 1) {
          await delay(backoff(attempt), signal);
          continue;
        }
      }
      if (signal?.aborted) throw signal.reason;
      if (method === "sendMessage") throw new TelegramApiError(method, 0, "unknown");
      throw new Error(`Telegram ${method} transport failed`);
    }
  }
  throw new Error(`Telegram ${method} request attempts exhausted`);
}

class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly outcome: "unknown" | "rejected" | "not-sent";
  readonly description: string | undefined;

  constructor(method: string, status: number, outcome: "unknown" | "rejected" | "not-sent", description?: string) {
    super(`Telegram ${method} failed with status ${status}`);
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

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    isNotModifiedDescription(error.description);
}

function isMessageNotFound(error: unknown): boolean {
  return error instanceof TelegramApiError && error.method === "editMessageText" && error.status === 400 &&
    error.description === "Bad Request: message to edit not found";
}

function isProvenPreConnectFailure(error: unknown): boolean {
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
