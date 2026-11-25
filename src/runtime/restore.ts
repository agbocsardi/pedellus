/**
 * Reopen restoration of the authority registry, before scheduling resumes.
 *
 * Order matters and is fixed: automation conversations are classified from their own durable
 * markers before any mapped key can be admitted as chat (a class applied after admission could never
 * be withdrawn); mapped ordinary chats are then admitted from the scope-checked mapping, always; live
 * run tasks restore their targets' roles and pinned models; and every live background capture is
 * intersected with its role's current ceiling. Only after interruption recovery does
 * {@link applyStartupPolicies} write the resulting policy to every conversation.
 */
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  configure,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import { CRON_RUN_TASK_NAME, CronJobsDoc, cronBackgroundTarget, type CronBackgroundTarget } from "../automation/cron.js";
import { automationConversationOf, classifyAutomationConversation, CronConversationDoc } from "../automation/cron-conversations.js";
import { CONTEXT_LIMITS } from "../context/index.js";
import { MEMORY_DIGEST_TASK_NAME, memoryDigestTaskPolicy, memoryDigestTaskTarget } from "../history/memory-digest.js";
import { encodedSessionKey, readMappedSessions, type ChatScopeExclusion, type HistoryChatSession, type MappedSession } from "../history/scope.js";
import { modelKey, type ModelReference } from "../config.js";
import { preparedContextReplay, preparedTaskModel, type PreparedContextReplay } from "../recovery/prepared.js";
import { boundedCapturedTools, ConfigToolCaptureDoc } from "../tools/index.js";
import { WORKER_TASK_NAME, workerBackgroundTarget, workerChildPolicy } from "../workers/worker-task.js";
import type { AuthorityPolicy, BackgroundRoleKind } from "./authority.js";
import type { ContextHost } from "./context-host.js";
import type { ModelHost } from "./model-host.js";
import { SessionMap } from "./sessions.js";

/** The run task that still targets one background conversation, and the class of that run. */
export interface BackgroundTargetRun {
  readonly originConversationId: ConversationId;
  readonly surface: "worker" | "digest" | "scheduled";
}

export interface RestoreOptions {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly context: Context;
  readonly authority: AuthorityPolicy;
  readonly models: ModelHost;
  readonly contextHost: ContextHost;
  readonly cronEnabled: boolean;
  readonly mappedChatSessions: (context: Context) => Promise<readonly HistoryChatSession[]>;
  readonly workspace: string;
  readonly chatScopeForSession: (tx: Tx, sessionKey: string, id: ConversationId) => Promise<ChatScopeExclusion | undefined>;
  readonly archivedSessionKeys: (tx: Tx) => Promise<Set<string>>;
  /** Live prepared dispatches whose saved request must keep the model it was prepared with. */
  readonly pinPreparedGeneration?: (taskId: number, model: ModelReference) => void;
}

export interface RestoredAuthority {
  readonly preparedContextReplays: readonly PreparedContextReplay[];
  readonly backgroundRun: (id: ConversationId) => BackgroundTargetRun | undefined;
  /** Apply host security, configured tool authority and context selection to every conversation. */
  applyStartupPolicies(): Promise<void>;
}

export async function restoreAuthority(options: RestoreOptions): Promise<RestoredAuthority> {
  const { harness, root, context, authority, models, contextHost } = options;
  const { registry } = authority;
  const allowed = (model: ModelReference) => models.allowModel(model);

  // The stored mapping is read unconditionally before any scope decision: a scheduled run's
  // automation conversation has to be classified before a mapped key naming it can be admitted as
  // chat, even when cron is disabled on this open.
  if (contextHost.enabled || options.cronEnabled) {
    await root.commit(async (tx) => { await tx.doc(SessionMap, root.id); }, context);
  }
  const mapping = await harness.snapshot(SessionMap, root.id, context);
  const storedMappedSessions: readonly MappedSession[] = mapping === undefined
    ? []
    : readMappedSessions(mapping.sessions, root.id);
  if (contextHost.enabled) {
    // Archived app threads hold no snapshot, so they do not count against the slot cap here.
    const active = await root.commit(async (tx) => {
      const archived = await options.archivedSessionKeys(tx);
      return storedMappedSessions.filter(({ sessionKey }) => !archived.has(encodedSessionKey(sessionKey))).length;
    }, context);
    if (active > CONTEXT_LIMITS.maxConversations) {
      throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
    }
  }

  // Restore the class of every automation conversation this store names, before the mapped-chat
  // authority pass below can see a key that names one — regardless of whether cron is enabled on
  // this open. The conversation's own durable marker decides, and it names its own origin and job,
  // so a mapped conversation is classified whether or not its origin's document still records it.
  // Committed cron documents are read as an index as well, because a live run's target is ownerless
  // and unmapped: nothing else names it for the task scan below. Documents never decide the class,
  // so a damaged pointer can only fail to enumerate a conversation, never promote a chat or hide an
  // automation conversation a key names. Only a conversation that is still ownerless and unforked
  // and whose marker names another conversation is classified (`classifyAutomationConversation`). A
  // marker written onto a chat by hand buys denial of that chat's surfaces, never authority. This is
  // a read: it creates no document and starts nothing.
  if (storedMappedSessions.length > 0) {
    const candidates = new Set<ConversationId>();
    for (const { conversationId } of storedMappedSessions) candidates.add(conversationId);
    for (const { conversationId: originConversationId } of storedMappedSessions) {
      let doc: { readonly jobs: readonly { readonly conversationId?: number | null }[]; readonly oneOffConversationId?: number | null } | undefined;
      try {
        doc = await harness.snapshot(CronJobsDoc, originConversationId, context);
      } catch {
        continue;
      }
      if (doc === undefined) continue;
      for (const job of doc.jobs) {
        if (Number.isSafeInteger(job.conversationId) && (job.conversationId as number) > 0) {
          candidates.add(job.conversationId as ConversationId);
        }
      }
      if (Number.isSafeInteger(doc.oneOffConversationId) && (doc.oneOffConversationId as number) > 0) {
        candidates.add(doc.oneOffConversationId as ConversationId);
      }
    }
    for (const conversationId of candidates) {
      // The root is never an automation conversation, whatever a marker or a document says.
      if (conversationId === root.id) continue;
      let record: { readonly owner?: unknown; readonly parent?: unknown } | undefined;
      let marker: unknown;
      try {
        record = await root.commit((tx) => tx.conversation(conversationId), context);
      } catch {
        record = undefined;
      }
      try {
        marker = await harness.snapshot(CronConversationDoc, conversationId, context);
      } catch {
        marker = undefined;
      }
      const own = automationConversationOf(marker);
      // A marker that names its own conversation is damaged: a run records its origin as the
      // origin, never as the target, so it may not take that conversation out of chat scope.
      if (own === undefined) continue;
      const originConversationId = own.originConversationId as ConversationId;
      if (originConversationId === conversationId) continue;
      const classified = classifyAutomationConversation(record, marker, { originConversationId, jobId: own.jobId });
      if (classified === undefined) continue;
      registry.classifyAutomation(conversationId, {
        originConversationId,
        conversationClass: classified.conversationClass,
        jobId: classified.jobId,
      });
    }
  }

  // Every scope-checked mapped ordinary chat is restored as chat, whatever else this open enables:
  // channel-neutral capabilities such as `ask_user` exist in every configuration, so an open with
  // no history, coding tool, channel or integration must still recognise its chats.
  for (const { sessionKey, conversationId } of await options.mappedChatSessions(context)) {
    registry.admitChat(conversationId, sessionKey);
  }

  if ((contextHost.enabled || options.cronEnabled) && storedMappedSessions.length > 0) {
    const sessions = storedMappedSessions;
    // A stored key names a mapped session only while its conversation is still ordinary chat: the
    // class pass above removed this host's automation conversations, and the shared scope rule
    // removes the root, task-owned conversations and unregistered forks, as channel ingress refuses
    // that same key. Such a key therefore gains no cron owner, no unevictable snapshot slot and no
    // resume target here. A missing conversation keeps its explicit failure below.
    const outOfScope = new Set<ConversationId>();
    let archivedAppKeys = new Set<string>();
    await root.commit(async (tx) => {
      archivedAppKeys = await options.archivedSessionKeys(tx);
      for (const { sessionKey, conversationId } of sessions) {
        const reason = await options.chatScopeForSession(tx, sessionKey, conversationId);
        if (reason === "automation" || reason === "root" || reason === "task-owned" || reason === "forked") {
          outOfScope.add(conversationId);
        }
      }
    }, context);
    for (const { sessionKey, conversationId } of sessions) {
      if (outOfScope.has(conversationId)) continue;
      if (contextHost.enabled) {
        if (!(await harness.conversation(conversationId, context))) {
          throw new Error("Stored session mapping points to a missing conversation");
        }
        // An archived app thread stays a mapped chat (cron owner, resume target), but its snapshot
        // is evictable and is rebuilt by the restore that makes it usable again.
        if (!archivedAppKeys.has(encodedSessionKey(sessionKey))) {
          await contextHost.ensure(sessionKey, conversationId, context);
        }
      }
      registry.recordMapped(conversationId, sessionKey);
    }
  }

  // Refuse unsafe prepared replays before resume; checkpoints pin historical context cutoffs.
  const preparedContextReplays: PreparedContextReplay[] = [];
  const backgroundRunTargets: CronBackgroundTarget[] = [];
  // Live worker targets keep the model, thinking level and workspace chosen at launch, and a worktree
  // child keeps its own root. Live digest targets keep the model pinned at start and their accepted
  // bounds: a digest turn's prompt is its own bounded input, so it gets no host context snapshot.
  const workerChildPolicies = new Map<ConversationId, NonNullable<ReturnType<typeof workerChildPolicy>>>();
  const digestTargetPolicies = new Map<ConversationId, NonNullable<ReturnType<typeof memoryDigestTaskPolicy>>>();
  // Live children whose captured model left the current catalog, or whose task policy is damaged
  // and cannot be reconstructed. Both are denied before scheduling resumes, never silently given
  // the configured default model, foreground coding ceiling or main workspace.
  const pinnedModelRemoved = new Set<ConversationId>();
  const damagedBackgroundTargets = new Set<ConversationId>();
  const runTasksById = new Map<number, { readonly originConversationId: ConversationId; readonly targetConversationId: ConversationId | null }>();
  // A background run's target conversation is task-owned, never a chat. Interruption recovery
  // resolves its legitimate owning surface and class back through the run task that created it.
  const backgroundTargetRuns = new Map<ConversationId, BackgroundTargetRun>();
  await root.commit(async (tx) => {
    let taskCursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({}, 1000, taskCursor);
      for (const task of page.items) {
        const snapshotTarget = cronBackgroundTarget(task) ?? workerBackgroundTarget(task);
        const digestTarget = memoryDigestTaskTarget(task);
        const backgroundTarget = snapshotTarget ?? digestTarget;
        if (task.kind === CRON_RUN_TASK_NAME || task.kind === WORKER_TASK_NAME || task.kind === MEMORY_DIGEST_TASK_NAME) {
          runTasksById.set(Number(task.id), {
            originConversationId: task.conversationId as ConversationId,
            targetConversationId: backgroundTarget?.targetConversationId ?? null,
          });
        }
        if (backgroundTarget !== undefined) {
          // A scheduled run's target is an automation conversation that this origin's committed cron
          // documents record; a worker or digest target is still the conversation its task owns. A
          // mismatched record is not a run target and gets no bound or snapshot restore.
          const target = await tx.conversation(backgroundTarget.targetConversationId);
          const ownsTarget = target?.owner?.taskId === Number(task.id)
            && target.owner.conversationId === backgroundTarget.originConversationId;
          const automationTarget = target !== undefined
            && registry.automation(target.id)?.originConversationId === backgroundTarget.originConversationId;
          if (ownsTarget || automationTarget) {
            backgroundTargetRuns.set(backgroundTarget.targetConversationId, {
              originConversationId: task.conversationId as ConversationId,
              surface: task.kind === WORKER_TASK_NAME ? "worker" : task.kind === MEMORY_DIGEST_TASK_NAME ? "digest" : "scheduled",
            });
            if (task.kind === WORKER_TASK_NAME) {
              const policy = workerChildPolicy(task);
              if (policy !== undefined && policy.targetConversationId === target.id) {
                workerChildPolicies.set(target.id, policy);
                if (!allowed(policy.model)) pinnedModelRemoved.add(target.id);
                if (snapshotTarget !== undefined) backgroundRunTargets.push(snapshotTarget);
              } else {
                damagedBackgroundTargets.add(target.id);
              }
            } else if (task.kind === MEMORY_DIGEST_TASK_NAME) {
              const digestPolicy = memoryDigestTaskPolicy(task);
              if (digestPolicy !== undefined && digestPolicy.targetConversationId === target.id) {
                digestTargetPolicies.set(target.id, digestPolicy);
                if (!allowed(digestPolicy.model)) pinnedModelRemoved.add(target.id);
              } else {
                damagedBackgroundTargets.add(target.id);
              }
            } else if (snapshotTarget !== undefined) {
              backgroundRunTargets.push(snapshotTarget);
            }
          }
        }
        const preparedModel = preparedTaskModel(task);
        if (preparedModel !== undefined && !allowed(preparedModel)) {
          throw new Error(`Cannot resume ${task.kind} task ${task.id}: prepared model ${modelKey(preparedModel)} is outside allowedModels`);
        }
        const contextReplay = preparedContextReplay(task);
        if (preparedModel !== undefined && contextReplay?.kind === "pi.generation" && contextReplay.phase === "request") {
          // Only a saved request still owes its model-bound dispatch. A poll resumes an already-sent
          // request without beforeRequest, and a later retry re-prepares from the reset AgentDoc.
          options.pinPreparedGeneration?.(Number(task.id), preparedModel);
        }
        if (contextReplay !== undefined) preparedContextReplays.push(contextReplay);
      }
      taskCursor = page.next;
    } while (taskCursor !== undefined);
  }, context);
  // A live child keeps the compositor and its checkout across a reopen, and a live digest target its
  // curation hook and bounds; their tools are restored and narrowed from the capture below.
  for (const [id, policy] of workerChildPolicies) {
    registry.trackWorker(id, policy.workspace.mode === "worktree" ? policy.workspace.path : undefined);
  }
  for (const [id, policy] of digestTargetPolicies) registry.beginDigest(id, policy.limits);

  // A pinned child (worker or digest target) whose captured model was removed — or whose task
  // policy is damaged and cannot be reconstructed — must not reach a provider or tool with it, or
  // with a silently substituted default. Before scheduling resumes, stop its own conversation's
  // pending work through native ownership: queued inputs, and live tasks that hold no saved
  // provider dispatch. A saved dispatch is deliberately left alone; the prepared-model guard above
  // refuses to open the gateway in that case instead of cancelling it.
  const deniedBackgroundTargets = new Set([...pinnedModelRemoved, ...damagedBackgroundTargets]);
  if (deniedBackgroundTargets.size > 0) {
    let inspection: Awaited<ReturnType<HarnessType["inspect"]>> | undefined;
    try {
      inspection = await harness.inspect(context);
    } catch {
      inspection = undefined;
    }
    if (inspection !== undefined) {
      for (const submission of inspection.submissions) {
        if (submission.status !== "queued" || !deniedBackgroundTargets.has(submission.conversationId)) continue;
        try {
          await harness.abortSubmission(submission.id, context, submission.conversationId);
        } catch {
          // The task's terminal commit still retires authority; a re-run child has none.
        }
      }
      for (const inspectionTask of inspection.tasks) {
        const record = inspectionTask.record;
        if (record.state.status === "terminal" || record.state.status === "completing") continue;
        if (record.kind === WORKER_TASK_NAME || record.kind === MEMORY_DIGEST_TASK_NAME) continue;
        if (!deniedBackgroundTargets.has(record.conversationId)) continue;
        if (preparedTaskModel(record) !== undefined) continue;
        try {
          await harness.abortTask(record.id, context);
        } catch {
          // Same bounded fallback: capture and tools are retired below.
        }
      }
    }
  }

  // A background run's target deliberately has no SessionMap entry. Restore its snapshot from the run
  // task's checkpoint before the pre-resume policy pass, so the pass keeps the context and `skill`
  // selections instead of stripping them. Unknown origins and missing conversations skip.
  if (contextHost.enabled) {
    for (const { originConversationId, targetConversationId } of backgroundRunTargets) {
      const sessionKey = registry.cronOwner(originConversationId)?.sessionKey;
      if (sessionKey === undefined) continue;
      if (!(await harness.conversation(targetConversationId, context))) continue;
      await contextHost.install(sessionKey, targetConversationId, context, true);
    }
  }

  // Every conversation a live run task currently targets is that run's target. A scheduled run's
  // automation conversation is ownerless, so it is found through the class this open restored; a
  // worker or digest target is found through the task that still owns it. A target whose run already
  // ended keeps no prepared authority and is left out.
  const runTargetCandidates: { conversationId: ConversationId; originConversationId: ConversationId }[] = [];
  await root.commit(async (tx) => {
    for (const [taskId, task] of runTasksById) {
      if (task.targetConversationId === null) continue;
      const conversation = await tx.conversation(task.targetConversationId);
      if (conversation === undefined) continue;
      const automation = registry.automation(conversation.id);
      const owned = conversation.owner?.taskId === taskId && conversation.owner.conversationId === task.originConversationId;
      if ((automation === undefined || automation.originConversationId !== task.originConversationId) && !owned) continue;
      runTargetCandidates.push({ conversationId: conversation.id, originConversationId: task.originConversationId });
    }
  }, context);

  // A background run's captured authority is only as good as the current host config and its
  // origin. Durable's tool hooks run in the call phase only, so a committed execute intent resolves
  // without them and a resumed turn could otherwise admit a call the config or origin no longer
  // supports. Intersect every live run's capture with its role's current ceiling and its
  // authenticated origin before resume; a mismatched origin, an unknown origin owner, an already
  // finished run or a missing capture is a deny rather than authority.
  const backgroundToolBounds = new Map<ConversationId, ReadonlySet<string>>();
  for (const { conversationId: target, originConversationId } of runTargetCandidates) {
    if (damagedBackgroundTargets.has(target)) continue;
    // A live scheduled run's target is classified from the run task that still targets it, never
    // from its capture: losing the capture makes it deny, not stop being a run target.
    const scheduledRun = options.cronEnabled && backgroundTargetRuns.get(target)?.surface === "scheduled";
    if (scheduledRun) registry.beginScheduledRun(target);
    const kind: BackgroundRoleKind | undefined = workerChildPolicies.has(target) ? "worker"
      : scheduledRun ? "scheduledRun"
        : digestTargetPolicies.has(target) ? "digest" : undefined;
    if (kind === undefined) continue;
    const tools = new Set<string>();
    const capture = await harness.snapshot(ConfigToolCaptureDoc, target, context);
    if (capture !== undefined && capture.originConversationId === originConversationId && registry.isChat(originConversationId)) {
      for (const name of boundedCapturedTools(capture.tools, authority.ceilingFor(kind, originConversationId), true)) tools.add(name);
    }
    backgroundToolBounds.set(target, tools);
  }

  return {
    preparedContextReplays,
    backgroundRun: (id) => backgroundTargetRuns.get(id),
    async applyStartupPolicies() {
      const namedPresets = models.state().resolved.configuredPresetName !== undefined;
      await root.commit(async (tx) => {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 1000, cursor);
          for (const conversation of page.items) {
            const agent = await tx.doc(AgentDoc, conversation.id);
            const toolFilter = await authority.toolFilterFor(tx, conversation.id, backgroundToolBounds.get(conversation.id));
            const workerPolicy = workerChildPolicies.get(conversation.id);
            const digestPolicy = digestTargetPolicies.get(conversation.id);
            // A live worker or digest target keeps the model, thinking level and workspace chosen at
            // launch, even when that model has since left the catalog: the pin stays honest instead
            // of silently becoming the configured default, and the task fails closed on resume.
            await configure(tx, conversation.id, {
              ...(workerPolicy !== undefined
                ? {
                    cwd: workerPolicy.workspace.path,
                    model: workerPolicy.model,
                    thinkingLevel: models.pinnedThinkingLevel(workerPolicy.model, workerPolicy.thinkingLevel, "default"),
                  }
                : digestPolicy !== undefined
                  ? {
                      cwd: options.workspace,
                      model: digestPolicy.model,
                      // The foreground thinking level is never inherited by a background digest run.
                      thinkingLevel: models.pinnedThinkingLevel(digestPolicy.model, digestPolicy.thinkingLevel, "lowest"),
                    }
                  // Named-preset mode owns the startup default; direct mode preserves its persisted choice.
                  : models.policyForState(agent, namedPresets)),
              ...authority.extensionsPolicy(conversation.id),
              ...toolFilter,
            });
            if ((workerPolicy !== undefined && !allowed(workerPolicy.model))
              || (digestPolicy !== undefined && !allowed(digestPolicy.model))
              || damagedBackgroundTargets.has(conversation.id)) {
              // Removed model or damaged policy: no fallback dispatch and no captured authority.
              // The target's own pending work was withdrawn above; the task commits the terminal
              // error on resume. Code Mode selection goes too, so no stale script can compose a
              // retired capture.
              await authority.retireCaptured(tx, conversation.id);
            }
          }
          cursor = page.next;
        } while (cursor !== undefined);
      }, context);
    },
  };
}
