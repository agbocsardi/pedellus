/**
 * Host side of internal scheduling: the cron foundation's per-run preparation and finalization, the
 * owner-scoped cron tool and operator, and the channel-neutral result outbox.
 *
 * A background run is an automation conversation whose authority is prepared per run: it captures
 * the ceiling its authenticated origin currently has, through the one authority policy, and retires
 * that capture in its terminal commit. An origin-mode run answers inside the origin chat, which
 * already holds its configured authority.
 */
import type { Context, Draft } from "@earendil-works/chord";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness as HarnessType,
} from "@earendil-works/pi-durable";
import { createCronFoundation, type CronFoundation } from "../automation/cron.js";
import { automationConversationOf, CronConversationDoc } from "../automation/cron-conversations.js";
import { createCronTool, type CronToolOrigin } from "../automation/cron-tool.js";
import {
  CRON_DELIVERY_MAX_TEXT_CHARS,
  CronDeliveriesDoc,
  CronDeliveryFaultsDoc,
  CronDeliveryOutboxError,
  admitCronDelivery,
  copyCronDelivery,
  cronOutcomeNotice,
  recordCronDeliveryFault,
  type CronDeliveryOutbox,
  type CronDeliveryRecord,
} from "../automation/cron-delivery.js";
import { createCronOperator } from "../automation/operator.js";
import { APP_CHAT_SESSION_KEY } from "../channels/app.js";
import { isAppSideThreadSessionKey } from "../channels/app-runtime.js";
import { hasMemoryDigestTools, type MemoryDigest } from "../history/memory-digest.js";
import { isChatSessionKey, type HistoryChatSession } from "../history/scope.js";
import { extractAssistantText } from "../tasks/background.js";
import { ConfigToolCaptureDoc } from "../tools/config-authority.js";
import type { AuthorityPolicy, CommitEffects } from "./authority.js";
import type { ContextHost } from "./context-host.js";

export interface CronHostOptions {
  readonly now: () => number;
  readonly ownerSteering: boolean;
  readonly timeZone: string | undefined;
  readonly workspace: string;
  readonly toolAllowlist: readonly string[];
  /** Whether a digest model is configured, so a `digest` job can ever start. */
  readonly digestConfigured: boolean;
  /** Origin session prefixes of the channels enabled in this configuration. */
  readonly deliveryPrefixes: readonly string[];
  readonly authority: AuthorityPolicy;
  readonly effects: CommitEffects;
  readonly contextHost: ContextHost;
  readonly harness: () => HarnessType;
  readonly memoryDigest: () => MemoryDigest;
  /**
   * The app channel's Main chat conversation, resolved through the gateway's ordinary mapped-chat
   * admission (which may create and admit it, as a first Main message would). Absent when the app
   * channel is not configured, and then no side-thread key exists either.
   */
  readonly appMainConversation?: (context: Context) => Promise<Conversation | undefined>;
}

export function createCronHost(options: CronHostOptions) {
  const { authority, contextHost, effects, now } = options;
  const { registry } = authority;
  const foundation: CronFoundation = createCronFoundation({
    now,
    // Only a host that steers owner messages needs the idle-only origin admission, because only
    // then can an owner steer share a final boundary with a queued occurrence.
    ownerSteering: options.ownerSteering,
    // A `digest` occurrence is the same bounded native entry a manual command uses. It is invoked
    // with the authenticated origin conversation (the job's own document conversation), never a
    // task-owned target; `start` re-checks that origin and the current curation allowlist, so a
    // narrowed config refuses instead of widening. The digest task reports its own completion
    // internally, so no cron outbox delivery is queued for this intent.
    digest: async ({ originConversationId }, ctx) => {
      let harness: HarnessType;
      try { harness = options.harness(); } catch { return { status: "error", error: "the runtime is not open" }; }
      const conversation = await harness.conversation(originConversationId, ctx);
      if (conversation === undefined) return { status: "error", error: "the digest origin conversation is missing" };
      try {
        const result = await options.memoryDigest().start({
          id: conversation.id,
          commit: (change, inner) => conversation.commit(change, inner),
        }, ctx);
        if (result.status === "started") return { status: "ok", error: null };
        if (result.status === "busy") return { status: "ok", error: `run ${result.taskId} is still active; nothing new was started` };
        if (result.status === "idle") {
          return {
            status: "ok",
            error: result.idle.caughtUp ? null : "no bounded batch was ready; completed history remains for a later run",
          };
        }
        return { status: "error", error: result.reason };
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
    // Each run starts a new episode in its automation conversation: the same native reset `/new`
    // places, so earlier entries stay stored and searchable while this run's model context starts
    // empty. It is admitted before the run's own input, and no stored entry is ever trimmed.
    reset: async (targetConversationId, ctx) => {
      let harness: HarnessType;
      try { harness = options.harness(); } catch { return; }
      const conversation = await harness.conversation(targetConversationId, ctx);
      if (conversation === undefined) return;
      await conversation.reset(undefined, ctx);
    },
    prepare: async ({ tx, originConversationId, targetConversationId: target, background }, ctx) => {
      const owner = registry.cronOwner(originConversationId);
      if (!background) {
        // An origin-mode run answers in the origin chat; an app side thread may not hold its
        // snapshot yet (archived and evicted), so it is installed with the chat's own policy.
        if (owner !== undefined && isAppSideThreadSessionKey(owner.sessionKey) && !contextHost.has(originConversationId)) {
          const contextState = await contextHost.install(owner.sessionKey, originConversationId, ctx, false, tx);
          await configure(tx, originConversationId, {
            ...authority.extensionsPolicy(originConversationId, undefined, contextState),
            ...await authority.toolFilterFor(tx, originConversationId, undefined, undefined, contextState),
          });
        }
        return;
      }
      // Classify from the durable marker the foundation wrote in this same commit: a forged or stale
      // mapping can never be mistaken for chat via this host. Defer classification before any
      // fallible preparation step because cron.ts commits the marker even if prepare throws.
      const marker = automationConversationOf(await tx.doc(CronConversationDoc, target));
      const automation = marker === undefined
        ? registry.automation(target)
        : { originConversationId, conversationClass: marker.conversationClass, jobId: marker.jobId };
      if (automation !== undefined) {
        await effects.defer(tx, () => registry.classifyAutomation(target, automation));
      }
      // Fail closed on a run whose origin cannot be attributed to a known owner: it gets no captured
      // authority, so every effectful call stays denied. Otherwise the capture is the origin's
      // current coding ceiling plus the read-only recall and exact MCP tools it holds right now.
      let captured: string[] | undefined;
      if (owner !== undefined) {
        captured = await authority.writeCapture(tx, target, originConversationId, authority.captureFor("scheduledRun", originConversationId));
      } else {
        await tx.retireDoc(ConfigToolCaptureDoc, target);
      }
      // The automation conversation is default-deny between runs, so it receives the origin's
      // workspace context through the same snapshot path, rebuilt in this same preparation so a later
      // episode renders the workspace as it is now. The cron tool and foundation are never offered.
      const contextState = owner === undefined
        ? undefined
        : await contextHost.install(owner.sessionKey, target, ctx, true, tx);
      // An automation conversation is ownerless, so Durable copies no agent state into it: the
      // workspace, model and thinking level this run uses are prepared here, per run.
      const originAgent = await tx.doc(AgentDoc, originConversationId);
      await authority.configureCaptured(tx, target, { kind: "scheduledRun", automation }, {
        cwd: options.workspace,
        ...(originAgent.model === undefined ? {} : { model: { ...originAgent.model } }),
        ...(originAgent.thinkingLevel === undefined ? {} : { thinkingLevel: originAgent.thinkingLevel }),
      }, captured, contextState);
      await effects.defer(tx, () => {
        registry.beginScheduledRun(target);
      });
    },
    // A separate run target's captured authority ends with the run, in the same commit that records
    // the terminal outcome, so a finished or cancelled run cannot be used for a later admission. The
    // automation conversation itself stays: its history is the job's ongoing activity. An origin-mode
    // run answered in the origin conversation itself, which keeps its configured authority.
    finalize: async ({ tx, job, occurrence, originConversationId, targetConversationId, background, delivery }) => {
      if (background) {
        await authority.retireCaptured(tx, targetConversationId);
        await effects.defer(tx, () => registry.endScheduledRun(targetConversationId));
      }
      // Queue one record for the occurrence in the same commit as the terminal run outcome. A
      // cancelled, superseded, fenced or missing-job run passes `delivery: null` and stays silent. A
      // settled run with an error, or with no usable answer text, queues fixed sanitized notice text
      // naming the job and occurrence only: raw provider errors, the job's message and model text never
      // leave the store. A successful answer is queued from the committed entry the scheduled
      // submission settled with. Suppression is the job's own persistent `silent` setting and nothing
      // else. The origin session key is also the channel locator: a key outside an enabled delivery
      // prefix is never queued.
      if (delivery === null) return;
      if (job === null || !isChatSessionKey(job.owner.sessionKey)) return;
      if (!options.deliveryPrefixes.some((prefix) => job.owner.sessionKey.startsWith(prefix))) return;
      let text: string;
      let appAnswerEntry: EntryId | undefined;
      if (delivery.status === "error") {
        text = cronOutcomeNotice("failed", job.id, occurrence.scheduledAtMs);
      } else {
        const answer = delivery.answerEntryId === null ? undefined : await tx.entry(AssistantEntry, delivery.answerEntryId);
        const body = extractAssistantText(answer).trim();
        if (job.silent === true) return;
        if (job.owner.sessionKey.startsWith("app:") && answer?.conversationId === originConversationId &&
            body !== "" && body !== "[SILENT]") appAnswerEntry = answer.id;
        text = body === "" || body === "[SILENT]"
          ? cronOutcomeNotice("empty", job.id, occurrence.scheduledAtMs)
          : body.length > CRON_DELIVERY_MAX_TEXT_CHARS
            ? `${body.slice(0, CRON_DELIVERY_MAX_TEXT_CHARS - 16)}\n\n[truncated]`
            : body;
      }
      // A corrupt outbox must never fault the run's terminal commit. Invalid data is left as stored;
      // a full outbox records an actionable fault rather than implying lossless delivery.
      let admission: "admitted" | "duplicate" | "full" | "invalid" = "invalid";
      try {
        admission = admitCronDelivery(await tx.doc(CronDeliveriesDoc, originConversationId), {
          id: `cron:${job.id}:${occurrence.scheduledAtMs}`,
          sessionKey: job.owner.sessionKey,
          text,
          createdAtMs: now(),
          status: "pending",
          nextChunkIndex: 0,
          ...(appAnswerEntry === undefined ? {} : { appAnswerEntry }),
        });
      } catch {
        admission = "invalid";
      }
      if (admission === "full" || admission === "invalid") {
        try {
          recordCronDeliveryFault(await tx.doc(CronDeliveryFaultsDoc, originConversationId), {
            jobId: job.id,
            scheduledAtMs: occurrence.scheduledAtMs,
            recordedAtMs: now(),
            message: admission === "full"
              ? "delivery outbox is full; result was not queued"
              : "delivery outbox is malformed; result was not queued",
          });
        } catch {
          // This diagnostic is derived state; it must not fault the cron run itself.
        }
      }
    },
  });
  const tool = createCronTool({
    foundation,
    // An app side thread is short-lived; its scheduled work belongs to the app's Main chat, so the
    // job document, the captured authority, every origin-mode answer and every delivery resolve
    // there. The redirect is one narrow hop inside the same channel and the same chat policy, and it
    // never happens for a conversation the registry does not name as an authenticated mapped chat.
    originFor: async (conversationId, ctx): Promise<CronToolOrigin | undefined> => {
      const owner = registry.cronOwner(conversationId);
      if (owner === undefined) return undefined;
      if (!isAppSideThreadSessionKey(owner.sessionKey)) return { conversationId, owner };
      if (options.appMainConversation === undefined) {
        throw new Error("the app Main chat is not available");
      }
      const main = await options.appMainConversation(ctx);
      const mainOwner = main === undefined ? undefined : registry.cronOwner(main.id);
      // Fail closed unless the resolved conversation is this app channel's Main chat: a different
      // conversation whose owner carries exactly `app:chat`. A stored map that points Main at this
      // very side thread is refused by the admission itself, before it can register the side thread
      // under Main's key; anything else that resolves to another key is refused here.
      if (main === undefined || mainOwner === undefined || main.id === conversationId
          || mainOwner.sessionKey !== APP_CHAT_SESSION_KEY) {
        throw new Error("the app Main chat could not be prepared");
      }
      return { conversationId: main.id, owner: mainOwner, label: "Main", callerOwner: owner };
    },
    harness: options.harness,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    digestAvailable: (conversationId) => options.digestConfigured
      && registry.isChat(conversationId)
      && hasMemoryDigestTools(options.toolAllowlist),
  });
  return {
    foundation,
    tool,
    /**
     * Owner scheduling controls. Every origin is resolved through the host's current mapped ordinary
     * chat sessions, so a state-only, automation, task-owned, forked or root conversation is never a
     * scheduling origin.
     */
    operator: (origins: (context: Context) => Promise<readonly HistoryChatSession[]>) =>
      createCronOperator({ foundation, harness: options.harness, origins }),
  };
}

export type CronHost = ReturnType<typeof createCronHost>;

/**
 * Host/channel view of the durable cron result outbox. Every access resolves an existing mapped chat
 * session; no conversation is created and no transcript is exposed.
 */
export function createCronOutbox(options: {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly now: () => number;
  readonly sessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  readonly chatConversationIdFor: (sessionKey: string, context: Context) => Promise<ConversationId>;
}): CronDeliveryOutbox {
  const { harness, root, chatConversationIdFor } = options;
  return {
    sessions: (ctx) => options.sessions(ctx),
    async list(sessionKey, ctx) {
      const conversationId = await chatConversationIdFor(sessionKey, ctx);
      const doc = await harness.snapshot(CronDeliveriesDoc, conversationId, ctx);
      if (doc === undefined) return [];
      const value: unknown = doc.deliveries;
      if (!Array.isArray(value)) throw new CronDeliveryOutboxError("delivery outbox is malformed");
      return value as readonly CronDeliveryRecord[];
    },
    async update(sessionKey, id, change, ctx) {
      const conversationId = await chatConversationIdFor(sessionKey, ctx);
      return root.commit(async (tx) => {
        const doc = await tx.doc(CronDeliveriesDoc, conversationId);
        const value: unknown = doc.deliveries;
        if (!Array.isArray(value)) throw new CronDeliveryOutboxError("delivery outbox is malformed");
        const record = value.find((entry) =>
          entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === id);
        if (record === undefined) return undefined;
        await change(record as Draft<CronDeliveryRecord>, tx);
        return copyCronDelivery(record as Draft<CronDeliveryRecord>);
      }, ctx);
    },
    async recordFault(sessionKey, message, ctx) {
      const conversationId = await chatConversationIdFor(sessionKey, ctx);
      try {
        await root.commit(async (tx) => {
          recordCronDeliveryFault(await tx.doc(CronDeliveryFaultsDoc, conversationId), {
            jobId: null,
            scheduledAtMs: null,
            recordedAtMs: options.now(),
            message,
          });
        }, ctx);
      } catch {
        // A best-effort diagnostic must not make the channel scan fail repeatedly.
      }
    },
  };
}
