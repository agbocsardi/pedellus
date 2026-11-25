/**
 * App thread lifecycle: create (new or forked from a committed message), rename, manual archive
 * and restore, and the idle auto-archive scan.
 *
 * Every change is one commit of the app state document that also appends the durable `thread`
 * event every device replays. Fork admission stays the host's: `forkAppThread` runs the exact
 * cutoff checks and registers the fork under its own key (APP.md, "Fork admission"). An archive
 * fences the thread's submissions, retires its unsubmitted inputs and cancels its open questions
 * in the same commit; nothing here starts a model turn.
 */
import { randomBytes } from "node:crypto";
import type { Draft } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import { AskQuestionsDoc, cancelPendingQuestions } from "../questions/index.js";
import type { AppChannelState, AppCore } from "./app.js";
import { appendEvent, publishQuestionEvents, pruneKeys, requestIdFor, sessionForThread, threadOf } from "./app.js";
import {
  APP_LIMITS,
  APP_MAIN_THREAD,
  parseThreadId,
  validThreadTitle,
  type AppErrorCode,
  type AppThreadInfo,
  type AppThreadOrigin,
} from "./app-protocol.js";

/** A fork or first admission would exceed the host's snapshot-slot cap; nothing was created. */
export class AppThreadCapacityError extends Error {}
class ThreadCreateConflict extends Error {}

export function threadInfo(doc: AppChannelState, thread: string): AppThreadInfo | undefined {
  return doc.threads?.find((entry) => entry.id === thread);
}

export function openThread(doc: AppChannelState, thread: string): boolean {
  return threadInfo(doc, thread)?.archived === false;
}

export function canOpenSideThread(doc: AppChannelState): boolean {
  return (doc.threads?.filter((entry) => entry.id !== APP_MAIN_THREAD && !entry.archived).length ?? 0) <
    APP_LIMITS.maxOpenThreads;
}

export function setArchived(
  doc: Draft<AppChannelState>, info: Draft<AppThreadInfo>, at: string, reason?: "manual" | "idle",
): void {
  info.archived = reason !== undefined;
  if (reason === undefined) delete info.archivedReason;
  else info.archivedReason = reason;
  // Idle archive does not make an inactive thread more recent than an active one.
  if (reason !== "idle" && info.lastAt < at) info.lastAt = at;
  appendEvent(doc, { event: "thread", thread: { ...info } });
}

type Reply = (body?: Record<string, unknown>) => void;
type Refuse = (error: AppErrorCode) => void;

export interface AppThreads {
  create(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void>;
  rename(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void>;
  archive(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void>;
  /** Archive every open side thread idle past the configured age with nothing pending or running. */
  scanIdle(): Promise<void>;
  /** Whether a manual archive or restore of this thread is in progress. */
  archiving(thread: string): boolean;
}

export function createAppThreads(options: {
  readonly core: AppCore;
  readonly archiveAfterMs: number;
  /** Whether a mutating control holds this thread's inputs. */
  gated(thread: string): boolean;
  /** Run work in the thread's own submission order. */
  submitInOrder<T>(thread: string, work: () => Promise<T>): Promise<T>;
  /** Dispatch pending deliveries again. */
  drain(): void;
  /** Push each thread's current preset to the streaming devices. */
  pushModelEvents(threads: readonly string[]): Promise<void>;
}): AppThreads {
  const { core } = options;
  const { gateway, now } = core;
  const archiving = new Set<string>();

  async function create(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void> {
    const key = frame.key;
    const title = frame.title === undefined ? "New thread" : frame.title;
    if (typeof key !== "string" || !APP_LIMITS.idPattern.test(key) || !validThreadTitle(title)) {
      return sendError("bad_request");
    }
    const raw = frame.from;
    let from: AppThreadOrigin | undefined;
    if (raw !== undefined) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return sendError("bad_request");
      const { thread, messageId } = raw as Record<string, unknown>;
      const source = parseThreadId(thread);
      if (source === undefined || typeof messageId !== "string" || messageId.length === 0 || messageId.length > 256) {
        return sendError("bad_request");
      }
      from = { thread: source, messageId };
    }
    const state = core.state();
    const prior = state.createKeys?.find((entry) => entry.key === key);
    if (prior !== undefined) return sendOk({ thread: prior.thread, duplicate: true });
    if (from !== undefined && (!openThread(state, from.thread) || archiving.has(from.thread))) return sendError("bad_request");
    let thread: string;
    do { thread = `t_${randomBytes(18).toString("base64url")}`; } while (threadInfo(state, thread) !== undefined);
    const register = (doc: Draft<AppChannelState>) => {
      if (doc.createKeys?.some((entry) => entry.key === key) || !canOpenSideThread(doc) ||
          threadInfo(doc, thread) !== undefined ||
          (from !== undefined && (!openThread(doc, from.thread) || archiving.has(from.thread)))) {
        throw new ThreadCreateConflict();
      }
      const atMs = now();
      const at = new Date(atMs).toISOString();
      const info = { id: thread, title, archived: false, createdAt: at, lastAt: at, ...(from === undefined ? {} : { origin: from }) };
      doc.threads!.push(info);
      doc.createKeys = pruneKeys([...(doc.createKeys ?? []), { key, atMs, thread }], atMs);
      appendEvent(doc, { event: "thread", thread: { ...info } });
    };
    try {
      if (from === undefined) {
        if (gateway.createAppThread === undefined) await core.mutateState(register);
        else {
          await gateway.createAppThread(core.stateConversation.id, thread, register, core.context);
          await core.mutateState(() => undefined);
        }
      } else if (!await gateway.forkAppThread?.(core.stateConversation.id, thread, from, register, core.context)) {
        return sendError("bad_request");
      } else {
        await core.mutateState(() => undefined);
      }
    } catch (error) {
      if (error instanceof AppThreadCapacityError) return sendError("not_ready");
      if (!(error instanceof ThreadCreateConflict)) throw error;
      const latest = await core.mutateState(() => undefined);
      const existing = latest.createKeys?.find((entry) => entry.key === key);
      return existing === undefined ? sendError("bad_request") : sendOk({ thread: existing.thread, duplicate: true });
    }
    sendOk({ thread, duplicate: false });
    core.publish();
    await options.pushModelEvents([thread]);
  }

  async function rename(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void> {
    const thread = parseThreadId(frame.thread);
    const title = frame.title;
    if (thread === undefined || thread === APP_MAIN_THREAD || !validThreadTitle(title)) {
      return sendError("bad_request");
    }
    let found = false;
    await core.mutateState((doc) => {
      const info = threadInfo(doc, thread);
      if (info === undefined) return;
      found = true;
      if (info.title === title) return;
      info.title = title;
      info.lastAt = new Date(now()).toISOString();
      appendEvent(doc, { event: "thread", thread: { ...info } });
    });
    if (!found) return sendError("bad_request");
    sendOk();
    core.publish();
  }

  async function archive(frame: Record<string, unknown>, sendOk: Reply, sendError: Refuse): Promise<void> {
    const thread = parseThreadId(frame.thread);
    const archived = frame.archived;
    if (thread === undefined || thread === APP_MAIN_THREAD || typeof archived !== "boolean") {
      return sendError("bad_request");
    }
    const info = threadInfo(core.state(), thread);
    if (info === undefined) return sendError("bad_request");
    if (archiving.has(thread) || options.gated(thread)) return sendError("not_ready");
    if (info.archived === archived) return sendOk();
    archiving.add(thread);
    try {
      // Fence app submissions until the abort and archive commit are both complete. Inputs
      // already submitted settle through the native record; never start a turn just to abort it.
      const applied = await options.submitInOrder(thread, async () => {
        const conversation = archived ? await gateway.conversationFor(sessionForThread(thread), core.context) : undefined;
        if (conversation !== undefined) await conversation.abort(core.context);
        let changed = false;
        await core.mutateState(async (doc, tx) => {
          if (!archived && (!canOpenSideThread(doc) || await gateway.appSnapshotRoom?.(tx) === false)) return;
          if (conversation !== undefined) {
            const retired = new Set<string>();
            for (const item of doc.pending) {
              if (item.notice === true || threadOf(item) !== thread) continue;
              if (await tx.submissionByRequest(conversation.id, requestIdFor(item.key)) !== undefined) continue;
              appendEvent(doc, { event: "settled", thread, key: item.key, outcome: "aborted" });
              retired.add(item.key);
            }
            doc.pending = doc.pending.filter((item) => !retired.has(item.key));
            // An archived thread has no question surface, so its open cards can never be answered and
            // the record would block every later ask. Repair a delivery mark lost in a crash first, in
            // this same commit: a quarantined question whose card is still live must be cancelled with
            // the archive, not reopened by a later repair. Restoring the thread does not reopen them.
            const questions = await tx.doc(AskQuestionsDoc, conversation.id);
            publishQuestionEvents(doc, questions, thread, now());
            cancelPendingQuestions(questions);
            publishQuestionEvents(doc, questions, thread, now());
          }
          const entry = threadInfo(doc, thread)!;
          setArchived(doc, entry, new Date(now()).toISOString(), archived ? "manual" : undefined);
          changed = true;
        });
        return changed;
      });
      if (!applied) return sendError("bad_request");
      if (!archived) await gateway.reserveAppThread?.(thread, core.context);
      sendOk();
      core.publish();
    } finally {
      archiving.delete(thread);
      options.drain();
    }
  }

  async function scanIdle(): Promise<void> {
    if (gateway.appThreadBusy === undefined) return;
    const atMs = now();
    const at = new Date(atMs).toISOString();
    const expired = (info: AppThreadInfo) => info.id !== APP_MAIN_THREAD && !info.archived &&
      atMs - Date.parse(info.lastAt) >= options.archiveAfterMs && !archiving.has(info.id) && !options.gated(info.id);
    const state = core.state();
    if (!state.threads?.some(expired)) return;
    // The idle archive cancels a thread's questions exactly like a manual archive, so it needs the
    // same repair. A question document is addressed by its conversation id, which a session key
    // cannot be resolved to inside the commit: resolve the candidate threads' conversations first,
    // and leave any thread that only became eligible since then to the next scan.
    const conversations = new Map<string, Conversation>();
    for (const info of state.threads ?? []) {
      if (!expired(info) || state.pending.some((item) => threadOf(item) === info.id)) continue;
      conversations.set(info.id, await gateway.conversationFor(sessionForThread(info.id), core.context));
    }
    await core.mutateState(async (doc, tx) => {
      for (const info of doc.threads ?? []) {
        const conversation = conversations.get(info.id);
        if (!expired(info) || conversation === undefined || doc.pending.some((item) => threadOf(item) === info.id) ||
            await gateway.appThreadBusy!(tx, info.id)) continue;
        const questions = await tx.doc(AskQuestionsDoc, conversation.id);
        publishQuestionEvents(doc, questions, info.id, atMs);
        cancelPendingQuestions(questions);
        publishQuestionEvents(doc, questions, info.id, atMs);
        setArchived(doc, info, at, "idle");
      }
    });
    core.publish();
  }

  return { create, rename, archive, scanIdle, archiving: (thread) => archiving.has(thread) };
}
