/**
 * The app channel's runtime bridge: the gateway methods and scope rules that need the app's own
 * durable thread registry. The gateway composition root reaches the app channel only through this
 * module, so the runtime stays independent of `AppState`, thread naming and the Tasks view.
 */
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import type { CronFoundation, CronOwner } from "../automation/cron.js";
import { automationConversationOf, CronConversationDoc } from "../automation/cron-conversations.js";
import { CONTEXT_LIMITS } from "../context/index.js";
import { encodedSessionKey } from "../history/scope.js";
import { SessionMap } from "../runtime/sessions.js";
import type { WorkerFoundation } from "../workers/worker-task.js";
import {
  APP_CHAT_SESSION_KEY,
  APP_STATE_SESSION_KEY,
  AppState,
  AppThreadCapacityError,
  appForkEntry,
  sessionForThread,
  threadInfo,
  type AppGateway,
} from "./app.js";
import { APP_MAIN_THREAD, parseThreadId } from "./app-protocol.js";
import {
  cronTask,
  cronTaskId,
  selectTasks,
  workerTask,
  workerTaskId,
  type AppTaskCancelResult,
  type AppTaskList,
} from "./app-tasks.js";

export { AppThreadCapacityError, createAppConsoleRegistry, type AppConsoleRegistry, type AppGateway } from "./app.js";

/** An app side thread's chat key (`app:chat:<thread>`), never the main thread or the state key. */
export function isAppSideThreadSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(`${APP_CHAT_SESSION_KEY}:`);
}

/** The snapshot-slot cap refusal the app channel reports as `full` rather than as a failure. */
export function isAppCapacityError(error: unknown): boolean {
  return error instanceof AppThreadCapacityError
    || (error instanceof RangeError && /conversation snapshots are accepted/u.test(error.message));
}

/**
 * The one narrow fork exception (AGENTS.md): an app-channel thread fork is admissible as an
 * ordinary mapped chat only under its own exact registered app session key. Every hop of a
 * fork-of-fork chain must carry a durable enrollment whose recorded app message resolves, in the
 * conversation the native parent names, to a committed user or assistant transcript entry equal
 * to the native fork cutoff; the enrollment is the authority and the thread registry's displayed
 * `origin` is only metadata. The base of the chain must be the exact app mapping of a validated
 * app chat (main or an unenrolled side thread). Anything else stays a denied fork.
 */
export async function appForkAdmissible(
  tx: Tx,
  scope: { readonly rootId: ConversationId; readonly isAutomation: (id: ConversationId) => boolean },
  sessionKey: string,
  conversationId: ConversationId,
): Promise<boolean> {
  const { rootId, isAutomation } = scope;
  if (!isAppSideThreadSessionKey(sessionKey)) return false;
  const callerThread = parseThreadId(sessionKey.slice(APP_CHAT_SESSION_KEY.length + 1));
  if (callerThread === undefined || callerThread === APP_MAIN_THREAD) return false;
  let child = await tx.conversation(conversationId);
  if (child === undefined || child.parent === undefined || child.owner !== undefined) return false;
  const map = await tx.doc(SessionMap, rootId);
  const stateId = map.sessions[encodedSessionKey(APP_STATE_SESSION_KEY)] as ConversationId | undefined;
  if (stateId === undefined || stateId === rootId) return false;
  const stateRecord = await tx.conversation(stateId);
  if (stateRecord === undefined || stateRecord.owner !== undefined || stateRecord.parent !== undefined) return false;
  const state = await tx.doc(AppState, stateId);
  let childThread = callerThread;
  const seen = new Set<ConversationId>();
  while (child.parent !== undefined) {
    if (seen.has(child.id) || child.id === rootId || child.owner !== undefined || isAutomation(child.id)) return false;
    seen.add(child.id);
    const enrollment = state.forks?.[`c${child.id}`];
    if (enrollment === undefined || enrollment.thread !== childThread ||
        map.sessions[encodedSessionKey(sessionForThread(childThread))] !== child.id) return false;
    if (threadInfo(state, childThread) === undefined || typeof enrollment.messageId !== "string") return false;
    if (enrollment.at !== child.parent.at) return false;
    const parentId = child.parent.conversationId;
    // Older enrollments omitted the source key. Recover it from the native parent and its
    // unique app mapping, never from the displayed origin, and apply the same entry check.
    let parentThread = enrollment.parentThread;
    if (parentThread === undefined) {
      const matches = state.threads?.filter(({ id }) => parseThreadId(id) === id &&
        map.sessions[encodedSessionKey(sessionForThread(id))] === parentId);
      if (matches?.length !== 1) return false;
      parentThread = matches[0]!.id;
    }
    if (parseThreadId(parentThread) !== parentThread ||
        map.sessions[encodedSessionKey(sessionForThread(parentThread))] !== parentId) return false;
    const anchor = await appForkEntry(tx, state, parentId, {
      thread: parentThread, messageId: enrollment.messageId,
    });
    if (anchor !== child.parent.at) return false;
    const parent = await tx.conversation(child.parent.conversationId);
    if (parent === undefined) return false;
    child = parent;
    childThread = parentThread;
  }
  if (child.id === rootId || child.id === stateId || child.owner !== undefined || isAutomation(child.id) ||
      automationConversationOf(await tx.doc(CronConversationDoc, child.id)) !== undefined) return false;
  if (childThread === APP_MAIN_THREAD) {
    return state.forks?.[`c${child.id}`] === undefined &&
      map.sessions[encodedSessionKey(APP_CHAT_SESSION_KEY)] === child.id;
  }
  const baseInfo = threadInfo(state, childThread);
  if (baseInfo === undefined || state.forks?.[`c${child.id}`] !== undefined) return false;
  return map.sessions[encodedSessionKey(sessionForThread(childThread))] === child.id;
}

/** Encoded session keys of archived side threads: their snapshots are evictable, not pinned. */
export async function archivedAppSessionKeys(tx: Tx, rootId: ConversationId): Promise<Set<string>> {
  const map = await tx.doc(SessionMap, rootId);
  const stateId = map.sessions[encodedSessionKey(APP_STATE_SESSION_KEY)] as ConversationId | undefined;
  const keys = new Set<string>();
  if (stateId === undefined || stateId === rootId) return keys;
  const state = await tx.doc(AppState, stateId);
  for (const info of state.threads ?? []) {
    if (info.id !== APP_MAIN_THREAD && info.archived) keys.add(encodedSessionKey(sessionForThread(info.id)));
  }
  return keys;
}

/** Mapped conversations that still demand a snapshot slot; archived app threads do not. */
export async function snapshotSlotsUsed(tx: Tx, rootId: ConversationId): Promise<number> {
  const map = await tx.doc(SessionMap, rootId);
  const total = Object.keys(map.sessions).length;
  if (total < CONTEXT_LIMITS.maxConversations) return total;
  let archived = 0;
  for (const key of await archivedAppSessionKeys(tx, rootId)) if (map.sessions[key] !== undefined) archived += 1;
  return total - archived;
}

type AppThreadMethods = Required<Pick<AppGateway,
  "forkAppThread" | "appThreadBusy" | "appSnapshotRoom" | "createAppThread" | "reserveAppThread">>;

export interface AppThreadRuntimeOptions {
  readonly harness: HarnessType;
  readonly root: Conversation;
  /** Whether the host installs prompt snapshots, which makes the snapshot-slot cap apply. */
  readonly snapshots: boolean;
  readonly chatScopeForSession: (tx: Tx, sessionKey: string, id: ConversationId) => Promise<unknown>;
  readonly policyForState: (state: Readonly<AgentState> | undefined) => AgentChange;
  /** The gateway's own mapped-chat admission, which applies ordinary chat policy. */
  readonly conversationFor: (sessionKey: string, context: Context) => Promise<Conversation>;
  readonly initializeSummaries?: (id: ConversationId, context: Context) => Promise<void>;
}

/** The app channel's thread lifecycle methods; present on the gateway only when `config.app` is set. */
export function createAppThreadRuntime(options: AppThreadRuntimeOptions): AppThreadMethods {
  const { harness, root } = options;
  const roomLeft = async (tx: Tx): Promise<boolean> =>
    !options.snapshots || await snapshotSlotsUsed(tx, root.id) < CONTEXT_LIMITS.maxConversations;
  return {
    async forkAppThread(stateId, thread, from, register, ctx) {
      if (parseThreadId(thread) !== thread || thread === APP_MAIN_THREAD || parseThreadId(from.thread) !== from.thread) return false;
      const stateKey = encodedSessionKey(APP_STATE_SESSION_KEY);
      const sourceKey = encodedSessionKey(sessionForThread(from.thread));
      const targetKey = encodedSessionKey(sessionForThread(thread));
      const anchor = await root.commit(async (tx) => {
        const map = await tx.doc(SessionMap, root.id);
        const id = map.sessions[sourceKey] as ConversationId | undefined;
        if (map.sessions[stateKey] !== stateId || id === undefined ||
            id === stateId || await options.chatScopeForSession(tx, sessionForThread(from.thread), id) !== undefined ||
            automationConversationOf(await tx.doc(CronConversationDoc, id)) !== undefined) return undefined;
        const state = await tx.doc(AppState, stateId);
        if (threadInfo(state, from.thread)?.archived !== false) return undefined;
        const at = await appForkEntry(tx, state, id, from);
        if (at === undefined) return undefined;
        if (!await roomLeft(tx)) throw new AppThreadCapacityError();
        return { id, at, policy: options.policyForState(await tx.doc(AgentDoc, id)) };
      }, ctx);
      if (anchor === undefined) return false;
      const source = await harness.conversation(anchor.id, ctx);
      if (source === undefined) return false;
      const fork = await source.fork(anchor.at, {
        ownership: { kind: "ownerless" },
        agent: anchor.policy,
        async init(tx, child) {
          const map = await tx.doc(SessionMap, root.id);
          if (map.sessions[stateKey] !== stateId || map.sessions[sourceKey] !== anchor.id ||
              Object.hasOwn(map.sessions, targetKey)) throw new Error("App thread mapping changed");
          if (!await roomLeft(tx)) throw new AppThreadCapacityError();
          const state = await tx.doc(AppState, stateId);
          register(state);
          const origin = threadInfo(state, thread)?.origin;
          if (origin?.thread !== from.thread || origin.messageId !== from.messageId) throw new Error("App fork registration is missing provenance");
          const enrollment = { thread, parentThread: from.thread, at: anchor.at, messageId: from.messageId };
          if (state.forks === undefined) state.forks = { [`c${child}`]: enrollment };
          else state.forks[`c${child}`] = enrollment;
          map.sessions[targetKey] = child;
        },
      }, ctx);
      // Apply ordinary mapped-chat policy; native forks always start with denied tools.
      await options.conversationFor(sessionForThread(thread), ctx);
      await options.initializeSummaries?.(fork.id, ctx).catch(() => undefined);
      return true;
    },
    async appThreadBusy(tx, thread) {
      const map = await tx.doc(SessionMap, root.id);
      const id = map.sessions[encodedSessionKey(sessionForThread(thread))] as ConversationId | undefined;
      if (id === undefined) return false;
      return (await tx.doc(LiveDoc, id)).run !== undefined || (await tx.doc(InboxDoc, id)).items.length > 0;
    },
    async createAppThread(stateId, thread, register, ctx) {
      await root.commit(async (tx) => {
        const map = await tx.doc(SessionMap, root.id);
        const key = encodedSessionKey(sessionForThread(thread));
        if (parseThreadId(thread) !== thread || thread === APP_MAIN_THREAD ||
            map.sessions[encodedSessionKey(APP_STATE_SESSION_KEY)] !== stateId || Object.hasOwn(map.sessions, key)) {
          throw new Error("Invalid app thread mapping");
        }
        if (!await roomLeft(tx)) throw new AppThreadCapacityError();
        register(await tx.doc(AppState, stateId));
        const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
        map.sessions[key] = chat.id;
      }, ctx);
    },
    appSnapshotRoom: (tx) => roomLeft(tx),
    /** Create the thread's mapping and snapshot now; `full` reports the snapshot-slot cap. */
    async reserveAppThread(thread, ctx) {
      try {
        await options.conversationFor(sessionForThread(thread), ctx);
        return "ok" as const;
      } catch (error) {
        if (isAppCapacityError(error)) return "full" as const;
        throw error;
      }
    },
  };
}

export interface AppTaskRuntimeOptions {
  readonly harness: HarnessType;
  readonly mappedConversationId: (sessionKey: string, context: Context) => Promise<ConversationId | undefined>;
  /** Only an authenticated mapped chat has tasks to show or cancel. */
  readonly isChat: (id: ConversationId) => boolean;
  readonly isWorkerSpawner: (id: ConversationId) => boolean;
  readonly cronOwner: (id: ConversationId) => CronOwner | undefined;
  readonly workerFoundation: WorkerFoundation | undefined;
  readonly cronFoundation: CronFoundation | undefined;
}

/** The app channel's bounded Tasks view and its owner-scoped cancel for one mapped thread. */
export function createAppTaskRuntime(options: AppTaskRuntimeOptions) {
  const { harness, workerFoundation, cronFoundation } = options;
  return {
    /**
     * The Tasks view of one mapped thread. The owner-scoped list functions decide what exists; this
     * function only reads them, once each, and never creates, retries or changes anything. An
     * unmapped session key has no conversation to read, so it answers an empty list rather than
     * mapping (and thereby creating) one.
     */
    async appTasks(sessionKey: string, ctx: Context): Promise<AppTaskList> {
      const conversationId = await options.mappedConversationId(sessionKey, ctx);
      if (conversationId === undefined || !options.isChat(conversationId)) return { tasks: [] };
      const workers = workerFoundation !== undefined && options.isWorkerSpawner(conversationId)
        ? await workerFoundation.list(harness, conversationId, ctx)
        : [];
      const cronOwner = options.cronOwner(conversationId);
      const jobs = cronFoundation !== undefined && cronOwner !== undefined
        ? await cronFoundation.list(harness, conversationId, { owner: cronOwner }, ctx)
        : [];
      return { tasks: selectTasks(workers, jobs) };
    },
    /**
     * Cancels one task of one mapped thread. The task is resolved through this thread's own owner-
     * scoped list first, so an id from another conversation is never passed to either foundation:
     * it reports `unknown` and nothing is touched. A worker uses the ordinary durable cancel; a job
     * uses the cron cancel, where a recorded cancellation whose cleanup threw is still `cancelled`,
     * exactly as the model-facing tool reports it.
     */
    async appTaskCancel(sessionKey: string, task: string, ctx: Context): Promise<AppTaskCancelResult> {
      const conversationId = await options.mappedConversationId(sessionKey, ctx);
      if (conversationId === undefined || !options.isChat(conversationId)) return { outcome: "unknown" };
      if (workerFoundation !== undefined && options.isWorkerSpawner(conversationId)) {
        const worker = (await workerFoundation.list(harness, conversationId, ctx))
          .find((view) => workerTaskId(view.taskId) === task);
        if (worker !== undefined) {
          const title = workerTask(worker).title;
          // A thrown cancel is reported as a failure, like the worker tool: the abort either
          // committed or it did not, and claiming an outcome here would be a guess.
          const result = await workerFoundation.cancel(harness, conversationId, worker.taskId, ctx);
          const outcome = result === "marked" ? "cancelled" : result === "terminal" ? "finished" : "unknown";
          return { outcome, title };
        }
      }
      const cronOwner = options.cronOwner(conversationId);
      if (cronFoundation !== undefined && cronOwner !== undefined) {
        const job = (await cronFoundation.list(harness, conversationId, { owner: cronOwner }, ctx))
          .find((view) => cronTaskId(view.job.id) === task);
        if (job !== undefined) {
          const title = cronTask(job).title;
          let result: Awaited<ReturnType<CronFoundation["cancel"]>>;
          try {
            result = await cronFoundation.cancel(harness, conversationId, job.job.id, { owner: cronOwner }, ctx);
          } catch (error) {
            // A throw may still have committed the cancellation before cleanup failed; re-read the
            // job and report the recorded truth instead of inviting a retry.
            let after: Awaited<ReturnType<CronFoundation["inspect"]>>;
            try {
              after = await cronFoundation.inspect(harness, conversationId, job.job.id, { owner: cronOwner }, ctx);
            } catch {
              after = undefined;
            }
            if (after === undefined || after.job.cancelledAtMs === null) throw error;
            return { outcome: "cancelled", title };
          }
          if (result.status === "cancelled") return { outcome: "cancelled", title };
          if (result.status === "already_terminal") return { outcome: "finished", title };
          return { outcome: "unknown" };
        }
      }
      return { outcome: "unknown" };
    },
  };
}
