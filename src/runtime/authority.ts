/**
 * The gateway's one authority registry and the single policy built from it.
 *
 * Every conversation the host has classified has one entry, keyed by `ConversationId`: an optional
 * mapped session key, whether that mapping owns a snapshot slot and cron ownership, and at most one
 * role. A role is the only source of non-default authority:
 *
 * - `chat`: an authenticated mapped ordinary chat (scope-checked mapping). The only foreground role.
 * - `worker`: a live worker's task-owned target, with its own checkout root in worktree mode.
 * - `scheduledRun`: a live background cron run's target, until its terminal commit.
 * - `digest`: a live memory-digestion target, with the bounds it accepted at start.
 * - `automation`: an idle cron automation conversation; it denies every capability.
 *
 * Background roles hold captured, narrowing-only grants: a capture is written from the origin's
 * current ceiling (`captureFor`), every policy pass intersects it with that ceiling again
 * (`toolFilterFor`), and every call is rechecked by `verifyCapturedTool`. Removal prunes the durable
 * capture permanently, so a later re-enable never restores it.
 *
 * In-memory role changes that a foundation's commit decides are applied only after that commit is
 * stored ({@link createCommitEffects}), so a rolled-back commit never leaves the registry claiming a
 * role the store does not have.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  defineExtension,
  hook,
  ToolTask,
  type AgentChange,
  type CommitObservation,
  type CommitPublication,
  type ConversationId,
  type Extension,
  type Harness as HarnessType,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { CronOwner } from "../automation/cron.js";
import type { CronConversationClass } from "../automation/cron-conversations.js";
import { SKILL_TOOL_NAME } from "../context/skill-tool.js";
import { CLASSIFIER_MODEL_TOOL_NAME, CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, type CodeModeIntegration } from "../extensions/codemode.js";
import type { DigestRunLimits } from "../history/digest-limits.js";
import { memoryDigestCurationTools } from "../history/memory-digest.js";
import { isChatSessionKey } from "../history/scope.js";
import type { McpAdmin, McpIntegration } from "../mcp/index.js";
import { MEMORY_TOOL_NAMES } from "../memory/contracts.js";
import { modelKey } from "../config.js";
import { ConfigToolCaptureDoc, verifyCapturedTool } from "../tools/config-authority.js";

/** The durable class of one cron automation conversation, as this host recorded it. */
export interface AutomationClass {
  readonly originConversationId: ConversationId;
  readonly conversationClass: CronConversationClass;
  readonly jobId: string | null;
}

export type ConversationRole =
  | { readonly kind: "chat" }
  | { readonly kind: "worker"; readonly workspaceRoot: string | undefined }
  | { readonly kind: "scheduledRun"; readonly automation: AutomationClass | undefined }
  | { readonly kind: "digest"; readonly limits: DigestRunLimits }
  | ({ readonly kind: "automation" } & AutomationClass);

export type BackgroundRoleKind = "worker" | "scheduledRun" | "digest";

interface RegistryEntry {
  sessionKey?: string;
  /** A scope-checked mapped session: it owns a snapshot slot and is its own cron owner. */
  mapped: boolean;
  role?: ConversationRole;
}

/** One cohesive registry for every classified conversation, with derived queries. */
export class ConversationRegistry {
  readonly #entries = new Map<ConversationId, RegistryEntry>();

  #entry(id: ConversationId): RegistryEntry {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = { mapped: false };
      this.#entries.set(id, entry);
    }
    return entry;
  }

  #prune(id: ConversationId): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined && entry.sessionKey === undefined && !entry.mapped && entry.role === undefined) {
      this.#entries.delete(id);
    }
  }

  #ids(kind: ConversationRole["kind"]): ConversationId[] {
    return [...this.#entries].flatMap(([id, entry]) => entry.role?.kind === kind ? [id] : []);
  }

  role(id: ConversationId): ConversationRole | undefined { return this.#entries.get(id)?.role; }
  /** The exact host-owned session key last resolved for this conversation; never model input. */
  sessionKeyFor(id: ConversationId): string | undefined { return this.#entries.get(id)?.sessionKey; }
  isChat(id: ConversationId): boolean { return this.role(id)?.kind === "chat"; }
  /** A chat whose current mapped key is an ordinary chat key of one channel (`telegram:`, `app:`, ...). */
  isChatOn(id: ConversationId, prefix: string): boolean {
    const key = this.sessionKeyFor(id);
    return this.isChat(id) && key !== undefined && isChatSessionKey(key) && key.startsWith(prefix);
  }
  /** Only a scope-checked mapped chat may start a worker; a worker's own target never can. */
  isWorkerSpawner(id: ConversationId): boolean {
    const key = this.sessionKeyFor(id);
    return this.isChat(id) && key !== undefined && isChatSessionKey(key);
  }
  isMapped(id: ConversationId): boolean { return this.#entries.get(id)?.mapped === true; }
  /** Origin sessions only, keyed by the mapped session key; a run target is never an owner. */
  cronOwner(id: ConversationId): CronOwner | undefined {
    const entry = this.#entries.get(id);
    return entry?.mapped === true && entry.sessionKey !== undefined
      ? { ownerId: entry.sessionKey, sessionKey: entry.sessionKey }
      : undefined;
  }
  isWorker(id: ConversationId): boolean { return this.role(id)?.kind === "worker"; }
  workerRoot(id: ConversationId): string | undefined {
    const role = this.role(id);
    return role?.kind === "worker" ? role.workspaceRoot : undefined;
  }
  isScheduledRun(id: ConversationId): boolean { return this.role(id)?.kind === "scheduledRun"; }
  isDigest(id: ConversationId): boolean { return this.role(id)?.kind === "digest"; }
  digestLimits(id: ConversationId): DigestRunLimits | undefined {
    const role = this.role(id);
    return role?.kind === "digest" ? role.limits : undefined;
  }
  /** The automation class of an idle automation conversation or of a live scheduled run's target. */
  automation(id: ConversationId): AutomationClass | undefined {
    const role = this.role(id);
    if (role?.kind === "automation") {
      return { originConversationId: role.originConversationId, conversationClass: role.conversationClass, jobId: role.jobId };
    }
    return role?.kind === "scheduledRun" ? role.automation : undefined;
  }
  isAutomation(id: ConversationId): boolean { return this.automation(id) !== undefined; }
  chats(): ConversationId[] { return this.#ids("chat"); }
  workers(): ConversationId[] { return this.#ids("worker"); }
  scheduledRuns(): ConversationId[] { return this.#ids("scheduledRun"); }
  automations(): ConversationId[] {
    return [...this.#entries.keys()].filter((id) => this.isAutomation(id));
  }
  /** Whether another live worker still executes in this checkout root. */
  workerRootInUse(root: string): boolean {
    return [...this.#entries.values()].some((entry) => entry.role?.kind === "worker" && entry.role.workspaceRoot === root);
  }

  /** A scope-checked mapped ordinary chat. A narrower role (task-owned, automation) is never promoted. */
  admitChat(id: ConversationId, sessionKey: string): void {
    const entry = this.#entry(id);
    entry.sessionKey = sessionKey;
    if (entry.role === undefined || entry.role.kind === "chat") entry.role = { kind: "chat" };
  }
  /** A mapped key that is not chat (a channel's state conversation): the key only, no authority. */
  recordSessionKey(id: ConversationId, sessionKey: string): void { this.#entry(id).sessionKey = sessionKey; }
  recordMapped(id: ConversationId, sessionKey: string): void {
    const entry = this.#entry(id);
    entry.sessionKey = sessionKey;
    entry.mapped = true;
  }
  /** The durable automation class. It narrows: a classified conversation is never chat. */
  classifyAutomation(id: ConversationId, automation: AutomationClass): void {
    const entry = this.#entry(id);
    entry.role = entry.role?.kind === "scheduledRun"
      ? { kind: "scheduledRun", automation }
      : { kind: "automation", ...automation };
  }
  beginScheduledRun(id: ConversationId): void {
    const entry = this.#entry(id);
    entry.role = { kind: "scheduledRun", automation: this.automation(id) };
  }
  endScheduledRun(id: ConversationId): void {
    const entry = this.#entries.get(id);
    if (entry?.role?.kind !== "scheduledRun") return;
    const automation = entry.role.automation;
    if (automation === undefined) delete entry.role;
    else entry.role = { kind: "automation", ...automation };
    this.#prune(id);
  }
  trackWorker(id: ConversationId, workspaceRoot: string | undefined): void {
    this.#entry(id).role = { kind: "worker", workspaceRoot };
  }
  /** Ends a worker role; returns its checkout root, if it had one. */
  releaseWorker(id: ConversationId): string | undefined {
    const entry = this.#entries.get(id);
    if (entry?.role?.kind !== "worker") return undefined;
    const root = entry.role.workspaceRoot;
    delete entry.role;
    this.#prune(id);
    return root;
  }
  beginDigest(id: ConversationId, limits: DigestRunLimits): void {
    this.#entry(id).role = { kind: "digest", limits: { ...limits } };
  }
  endDigest(id: ConversationId): void {
    const entry = this.#entries.get(id);
    if (entry?.role?.kind !== "digest") return;
    delete entry.role;
    this.#prune(id);
  }
}

/**
 * Token of the newest commit that carried deferred registry effects. Written only inside a
 * foundation commit that also changes durable authority; the observer below applies that commit's
 * effects exactly when Storage reports it stored. Session scoped, so it is one latest value.
 */
const RegistryCommitDoc = defineDoc<{ token: string }>({
  kind: "nanobot.registry-commit", version: 1, scope: "session",
  initial: () => ({ token: "" }), checkpointWhen: () => true,
});

/** Rolled-back commits never publish their token; this bounds what they can leave behind. */
const MAX_PENDING_COMMIT_EFFECTS = 256;

export interface CommitEffects {
  /** Run `effect` once the commit of `tx` is stored; a rolled-back commit never runs it. */
  defer(tx: Tx, effect: () => void): Promise<void>;
  /** Attach the stored-commit observer; effects deferred before this never run. */
  observe(harness: HarnessType): CommitObservation;
}

/**
 * Post-commit application of in-memory registry changes. Durable has no commit hook, so each commit
 * that defers an effect writes one random token to {@link RegistryCommitDoc}; `observeCommits()`
 * publishes a stored commit before that commit's wait resolves, and the observer runs exactly the
 * effects of the token it carries. Effects are synchronous and must not throw. This assumes the
 * deferring commits are not held in memory (`CommitPersistence`); none of the foundations do so.
 */
export function createCommitEffects(report: (error: unknown) => void): CommitEffects {
  const byTx = new WeakMap<Tx, { readonly token: string; readonly effects: (() => void)[] }>();
  const byToken = new Map<string, { readonly token: string; readonly effects: (() => void)[] }>();
  return {
    async defer(tx, effect) {
      let pending = byTx.get(tx);
      if (pending === undefined) {
        pending = { token: randomUUID(), effects: [] };
        byTx.set(tx, pending);
        byToken.set(pending.token, pending);
        if (byToken.size > MAX_PENDING_COMMIT_EFFECTS) byToken.delete(byToken.keys().next().value!);
        (await tx.doc(RegistryCommitDoc)).token = pending.token;
      }
      pending.effects.push(effect);
    },
    observe(harness) {
      return harness.observeCommits({
        advance: (publication: CommitPublication) => {
          for (const change of publication.changes) {
            if (change.type !== "document" || change.kind !== "change" || change.record.scope.kind !== "session"
              || change.record.kind !== RegistryCommitDoc.definition.kind) continue;
            const token = (change.value as { readonly token?: unknown }).token;
            const pending = typeof token === "string" ? byToken.get(token) : undefined;
            if (pending === undefined) continue;
            byToken.delete(token as string);
            for (const effect of pending.effects) {
              try { effect(); } catch (error) { report(error); }
            }
          }
        },
        end: () => {},
      });
    },
  };
}

/** Extensions and tools this open may offer, each `undefined` when its capability is off. */
export interface AuthorityCapabilities {
  readonly vision?: Extension;
  readonly coding?: Extension;
  readonly askUser: { readonly extension: Extension };
  readonly web?: { readonly extension: Extension };
  readonly memory?: { readonly extension: Extension };
  readonly telegram?: { readonly extension: Extension };
  readonly app?: { readonly extension: Extension };
  readonly discordHistory?: { readonly extension: Extension };
  readonly skill?: { readonly extension: Extension };
  readonly digestScope: Extension;
  /** Late-bound: created after this policy, or replaced by a live MCP change. */
  readonly live: {
    readonly mcp: () => McpIntegration | undefined;
    readonly codeMode: () => CodeModeIntegration | undefined;
    readonly mcpAdmin: () => McpAdmin | undefined;
    readonly cron: () => { readonly foundation: Extension; readonly tool: { readonly extension: Extension } } | undefined;
    readonly worker: () => { readonly extension: Extension } | undefined;
  };
}

export interface AuthorityOptions {
  readonly registry: ConversationRegistry;
  readonly toolAllowlist: readonly string[];
  readonly workersEnabled: boolean;
  /** Coding tools a worker may capture (`workers.toolAllowlist` or the foreground ceiling). */
  readonly workerCodingTools: readonly string[];
  /** The configured `workers.toolAllowlist`, if any. */
  readonly workerToolAllowlist: readonly string[] | undefined;
  readonly historyEnabled: boolean;
  readonly classifierGrantKey: string | undefined;
  /** Every registration a policy may name; MCP and Code Mode entries are replaced live. */
  readonly toolRegistrations: Map<string, ToolRegistration>;
  readonly capabilities: AuthorityCapabilities;
  /** The conversation's own host prompt snapshot: its extension, and whether skills were delivered. */
  readonly context: {
    readonly extension: () => Extension | undefined;
    readonly has: (id: ConversationId) => boolean;
    readonly hasSkills: (id: ConversationId) => boolean;
  };
}

export type AuthorityPolicy = ReturnType<typeof createAuthorityPolicy>;

/** The single source of extension selection, tool filters and capture ceilings. */
export function createAuthorityPolicy(options: AuthorityOptions) {
  const { registry, toolAllowlist, toolRegistrations, capabilities: caps } = options;
  const { live } = caps;
  const registrationOf = (extension: { readonly extension: Extension } | undefined) => extension?.extension.tools?.[0];
  const skillRegistration = caps.skill?.extension.tools?.[0];
  const webRegistrations = caps.web?.extension.tools ?? [];
  const memoryRegistrations = caps.memory?.extension.tools ?? [];
  const registrations = (names: readonly string[]): ToolRegistration[] => names.flatMap((name) => {
    const tool = toolRegistrations.get(name);
    return tool === undefined ? [] : [tool];
  });

  /** Everything a worker may capture under the current worker configuration. */
  const workerToolNames = (): string[] => {
    if (!options.workersEnabled) return [];
    const configured = options.workerToolAllowlist;
    const mcp = live.mcp();
    // Classifier authority is part of the Code Mode grant, never a separately named
    // worker tool. Removing Code Mode from worker config removes it permanently.
    const codeModeGranted = live.codeMode() !== undefined
      && (configured === undefined || configured.includes(CODEMODE_TOOL_NAME));
    // The classifier nested tool exists only with an explicit configured model grant.
    const classifierGranted = codeModeGranted && options.classifierGrantKey !== undefined;
    return [
      ...options.workerCodingTools,
      ...(skillRegistration === undefined ? [] : [SKILL_TOOL_NAME]),
      ...webRegistrations.map((tool) => tool.name),
      ...(options.historyEnabled ? [...MEMORY_TOOL_NAMES] : []),
      ...(codeModeGranted ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME] : []),
      ...(classifierGranted ? [CLASSIFIER_MODEL_TOOL_NAME] : []),
      ...(mcp?.toolNames ?? []),
    ].filter((name) => name === CLASSIFIER_MODEL_TOOL_NAME || configured === undefined || configured.includes(name)
      || (configured.includes("mcp") && mcp?.ownsTool(name)));
  };

  /**
   * The non-coding capabilities a scheduled run may capture from its authenticated origin right now:
   * the read-only memory recall that origin holds and the exact tools of its connected MCP servers.
   * Scheduling, worker delegation, MCP management/login, channel actions, classifiers and Code Mode
   * are deliberately absent, as is anything the origin does not currently hold. Every call is
   * rechecked against the durable capture and this function, so a narrowed config denies.
   */
  const scheduledRunCapabilityNames = (origin: ConversationId): string[] => [
    ...(options.historyEnabled && registry.isChat(origin) ? [...MEMORY_TOOL_NAMES] : []),
    ...(live.mcp()?.toolNames ?? []),
  ];

  /** The ceiling one background role captures from, and is re-bounded against, for `origin`. */
  const ceilingFor = (kind: BackgroundRoleKind | undefined, origin: ConversationId): string[] =>
    kind === "worker" ? workerToolNames()
      : kind === "scheduledRun" ? [...toolAllowlist, ...scheduledRunCapabilityNames(origin)]
        : kind === "digest" ? memoryDigestCurationTools(toolAllowlist)
          : [...toolAllowlist];

  /** Names a new capture may hold: the current ceiling of an authenticated origin, otherwise nothing. */
  const captureFor = (kind: BackgroundRoleKind, origin: ConversationId): string[] =>
    registry.isChat(origin) ? ceilingFor(kind, origin) : [];

  const workerCapabilityExtension = defineExtension({
    name: "nanobot-worker-capabilities",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        if (!workerToolNames().includes(call.name)) {
          return { block: `Tool ${call.name} is outside the configured worker grants` };
        }
        if (!registry.isWorker(api.conversationId)) {
          return { block: "Worker capability is no longer active" };
        }
        const verdict = await verifyCapturedTool(
          () => api.snapshot(ConfigToolCaptureDoc, api.conversationId, ctx), call.name, (id) => registry.isChat(id),
        );
        if (!verdict.ok) return { block: `Tool ${call.name} is outside this worker's captured authority` };
        if (call.name === CLASSIFIER_MODEL_TOOL_NAME) {
          // The durable capture, not the current config, decides which classifier model this
          // worker may still call. A pruned or retired identity never returns.
          const model = call.arguments.model;
          const provider = typeof model === "object" && model !== null ? (model as Record<string, unknown>).provider : undefined;
          const id = typeof model === "object" && model !== null ? (model as Record<string, unknown>).id : undefined;
          if (typeof provider !== "string" || typeof id !== "string"
            || verdict.capture.classifierModel !== modelKey({ provider, modelId: id })) {
            return { block: "Classifier model is outside this worker's captured authority" };
          }
        }
        return undefined;
      },
    })],
  });

  /**
   * Call-time authority for a live scheduled run's non-coding capture. The coding-tool hook exempts
   * memory recall (a context tool) and MCP names (delegated to their own hook), so their exact grants
   * are rechecked here: the durable capture must name the tool, its recorded origin must still be an
   * authenticated mapped chat holding that capability now, and the conversation must still be a live
   * run target. A revoked name, a narrowed config, a closed server or a retired capture fails closed.
   */
  const scheduledRunCapabilityExtension = defineExtension({
    name: "nanobot-scheduled-run-capabilities",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const recall = (MEMORY_TOOL_NAMES as readonly string[]).includes(call.name);
        const mcp = live.mcp()?.ownsTool(call.name) === true;
        if (!recall && !mcp) return undefined;
        if (!registry.isScheduledRun(api.conversationId)) {
          return { block: "Scheduled run capability is no longer active" };
        }
        const verdict = await verifyCapturedTool(
          () => api.snapshot(ConfigToolCaptureDoc, api.conversationId, ctx), call.name, (id) => registry.isChat(id),
        );
        if (!verdict.ok) return { block: `Tool ${call.name} is outside this scheduled run's captured authority` };
        if (!scheduledRunCapabilityNames(verdict.origin).includes(call.name)) {
          return { block: `Tool ${call.name} is outside the current scheduled-run grants` };
        }
        return undefined;
      },
    })],
  });

  /**
   * Always an explicit selection, never an add/remove edit: Durable's edit form resolves against the
   * extensions installed at read time, so a later dynamic install (a new conversation's context
   * extension) would otherwise be selected by unrelated conversations. `role` defaults to the
   * registry's; a foundation preparing a target in its own commit passes the role that commit
   * creates, because the registry learns it only once that commit is stored.
   */
  const extensionsPolicy = (
    id: ConversationId,
    role: ConversationRole | undefined = registry.role(id),
  ): Pick<AgentChange, "extensions"> => {
    const selected: Extension[] = [];
    const chat = role?.kind === "chat";
    const mcp = live.mcp();
    const codeMode = live.codeMode();
    // The vision hook carries no tool or workspace authority; selecting it everywhere keeps
    // image bounding independent of tool allowlists and channel scope.
    if (caps.vision) selected.push(caps.vision);
    if (caps.coding) selected.push(caps.coding);
    if (chat) {
      // Owner questions, MCP, Code Mode and MCP management exist only in an authenticated mapped
      // chat: never a worker, fork, root or scheduled/digest target.
      selected.push(caps.askUser.extension);
      if (mcp !== undefined) selected.push(mcp.extension);
      if (codeMode !== undefined) selected.push(...codeMode.extensions);
      const admin = live.mcpAdmin();
      if (admin !== undefined) selected.push(admin.extension);
    } else if (role?.kind === "worker") {
      selected.push(workerCapabilityExtension);
      if (mcp !== undefined) selected.push(mcp.extension);
      if (codeMode !== undefined) selected.push(...codeMode.extensions);
      if (caps.memory !== undefined) selected.push(caps.memory.extension);
      if (caps.web !== undefined) selected.push(caps.web.extension);
    } else if (role?.kind === "scheduledRun") {
      // These extensions are the capture's call-time checks, not authority: the hook rechecks the
      // durable capture and the current grants, and the MCP hook rechecks the server's live state on
      // every call. Code Mode, tool search and MCP management are deliberately absent.
      selected.push(scheduledRunCapabilityExtension);
      if (mcp !== undefined) selected.push(mcp.extension);
      if (caps.memory !== undefined) selected.push(caps.memory.extension);
    } else if (role?.kind === "digest") {
      // The curation hook grants nothing; it only refuses paths outside the curation scope and
      // makes write create-only.
      selected.push(caps.digestScope);
    }
    const contextExtension = options.context.extension();
    if (contextExtension !== undefined && options.context.has(id)) selected.push(contextExtension);
    if (caps.skill && options.context.has(id) && options.context.hasSkills(id)) selected.push(caps.skill.extension);
    if (chat && caps.memory) selected.push(caps.memory.extension);
    if (chat && caps.web) selected.push(caps.web.extension);
    if (caps.telegram && chat && registry.isChatOn(id, "telegram:")) selected.push(caps.telegram.extension);
    if (caps.app && chat && registry.isChatOn(id, "app:")) selected.push(caps.app.extension);
    if (caps.discordHistory && chat && registry.isChatOn(id, "discord:")) selected.push(caps.discordHistory.extension);
    const cron = live.cron();
    if (cron !== undefined && registry.isMapped(id)) selected.push(cron.foundation, cron.tool.extension);
    const worker = live.worker();
    if (worker !== undefined && chat && registry.isWorkerSpawner(id)) selected.push(worker.extension);
    return { extensions: selected };
  };

  /** Non-coding tools offered outside the coding ceiling, each by its own scope rule. */
  const contextToolsFor = (id: ConversationId, role: ConversationRole | undefined): ToolRegistration[] => {
    const chat = role?.kind === "chat";
    const worker = role?.kind === "worker";
    const one = (registration: ToolRegistration | undefined, offered: boolean) =>
      registration !== undefined && offered ? [registration] : [];
    const cron = live.cron();
    const admin = live.mcpAdmin();
    return [
      // The skill loader is context delivery, not an effectful tool, offered for captured skills.
      ...one(skillRegistration, options.context.hasSkills(id)),
      // The cron tool is owner-scoped scheduling, offered only in an origin session.
      ...one(registrationOf(cron?.tool), registry.isMapped(id)),
      // Recall is read-only over mapped chats; workers and a live scheduled run hold it by capture.
      ...(options.historyEnabled && (chat || worker || role?.kind === "scheduledRun") ? memoryRegistrations : []),
      // Channel capabilities are offered only in a mapped chat of that channel; each live adapter
      // rechecks the exact session at call time.
      ...one(registrationOf(caps.telegram), chat && registry.isChatOn(id, "telegram:")),
      ...one(registrationOf(caps.app), chat && registry.isChatOn(id, "app:")),
      ...one(registrationOf(caps.discordHistory), chat && registry.isChatOn(id, "discord:")),
      ...(chat || worker ? webRegistrations : []),
      // Worker management is a spawning-chat capability; a worker's own target never holds it.
      ...one(registrationOf(live.worker()), chat && registry.isWorkerSpawner(id)),
      // MCP management and owner questions are offered to authenticated mapped chats alone.
      ...(admin !== undefined && chat ? admin.extension.tools ?? [] : []),
      ...(chat ? caps.askUser.extension.tools ?? [] : []),
    ];
  };

  /**
   * The authority-derived tool filter. The host ceiling directly authorizes authenticated mapped
   * ordinary chats; a background role must pass its restored capture bound (`backgroundTools`), or it
   * keeps no coding tool. Every pass persists the prune into the capture, and an empty bound is a
   * genuine deny that retires it.
   */
  const toolFilterFor = async (
    tx: Tx,
    id: ConversationId,
    backgroundTools?: ReadonlySet<string>,
    role: ConversationRole | undefined = registry.role(id),
  ): Promise<Pick<AgentChange, "tools" | "modelTools">> => {
    const worker = role?.kind === "worker";
    const scheduledRun = role?.kind === "scheduledRun";
    const authorized = role?.kind === "chat";
    const captured = worker || scheduledRun ? backgroundTools ?? new Set<string>() : undefined;
    const contextTools = contextToolsFor(id, role).filter((tool) =>
      captured === undefined || captured.has(tool.name)
        // A scheduled run's `skill` loader is context delivery for the snapshot installed for that
        // run, not a captured tool, so its restored snapshot decides and it is never filtered here.
        || (scheduledRun && tool.name === SKILL_TOOL_NAME));
    const codeMode = live.codeMode();
    // MCP stays deferred in mapped chats and captured workers.
    const codeModeOfferedBase = codeMode !== undefined && (authorized || captured?.has(CODEMODE_TOOL_NAME));
    let offered = codeModeOfferedBase ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME] : [];
    // Classifier calls are native nested ToolTasks of Code Mode. They stay out of `modelTools`, so
    // the model cannot call them directly, and no other scope receives them without the Code Mode
    // grant and an explicit configured model.
    let classifierTools = codeModeOfferedBase && options.classifierGrantKey !== undefined
      ? [CLASSIFIER_MODEL_TOOL_NAME] : [];
    const deferred = [...(live.mcp()?.toolNames ?? [])].filter((name) => authorized || captured?.has(name));
    const withContext = (names: readonly string[]): Pick<AgentChange, "tools" | "modelTools"> => ({
      tools: [
        ...registrations(names), ...registrations(offered), ...registrations(classifierTools),
        ...registrations(deferred), ...contextTools,
      ],
      modelTools: [
        ...registrations(names), ...registrations(offered),
        // A scheduled run has no Code Mode or tool search to load a deferred tool, so the MCP tools
        // its capture names are offered directly: the capture is the explicit grant.
        ...(scheduledRun ? registrations(deferred) : []),
        ...contextTools,
      ],
    });
    if (worker) {
      const capture = await tx.doc(ConfigToolCaptureDoc, id);
      const grants = workerToolNames();
      capture.tools = grants.filter((name) => captured!.has(name) && capture.tools.includes(name));
      // Use the pruned durable capture, not the launch input, so removing Code Mode from worker
      // config or a reopen cannot resurrect classifiers from a stale grant.
      const capturedCodeMode = codeMode !== undefined
        && grants.includes(CODEMODE_TOOL_NAME) && capture.tools.includes(CODEMODE_TOOL_NAME);
      // Classifier authority is captured by model identity, not only by tool name: a removed or
      // changed configuration is pruned in this same commit, so a later re-enable cannot resurrect
      // it for an existing worker.
      capture.classifierModel = capturedCodeMode
        && capture.tools.includes(CLASSIFIER_MODEL_TOOL_NAME)
        && options.classifierGrantKey !== undefined
        && capture.classifierModel === options.classifierGrantKey
        ? options.classifierGrantKey
        : null;
      offered = capturedCodeMode ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME] : [];
      classifierTools = capturedCodeMode && capture.classifierModel !== null ? [CLASSIFIER_MODEL_TOOL_NAME] : [];
      return withContext(capture.tools.filter((name) => options.workerCodingTools.includes(name)));
    }
    if (!caps.coding && !scheduledRun) {
      // Retire instead of creating an empty document: a disabled ceiling must durably remove
      // previously captured tools so re-enabling it cannot resurrect them.
      await tx.retireDoc(ConfigToolCaptureDoc, id);
      return withContext([]);
    }
    // Only the registry's validated mapped-chat role carries configured authority. The root, a
    // channel-state conversation, a fork, a raw conversation and any other task-owned target are
    // denied even when agent state still names a tool.
    if (authorized) return withContext(toolAllowlist);
    if (backgroundTools !== undefined) {
      const capture = await tx.doc(ConfigToolCaptureDoc, id);
      const ceiling = role?.kind === "digest" ? memoryDigestCurationTools(toolAllowlist) : toolAllowlist;
      const names = ceiling.filter((name) => backgroundTools.has(name) && capture.tools.includes(name));
      // A scheduled run's captured recall and MCP names are re-bounded the same way, so a revoke, a
      // narrowed config or a closed server is pruned from the durable document here and cannot
      // return when that capability is enabled again later.
      const origin = capture.originConversationId;
      const originAuthorized = Number.isSafeInteger(origin) && origin > 0 && registry.isChat(origin as ConversationId);
      const capabilities = scheduledRun && originAuthorized
        ? scheduledRunCapabilityNames(origin as ConversationId).filter((name) =>
          backgroundTools.has(name) && capture.tools.includes(name))
        : [];
      // Persist the prune so a later call-time check cannot revive a name the origin lost.
      capture.tools = [...names, ...capabilities];
      return withContext(names);
    }
    await tx.retireDoc(ConfigToolCaptureDoc, id);
    return withContext([]);
  };

  /** No tool, no capture and only the non-authoritative vision hook. */
  const deniedPolicy = (): Pick<AgentChange, "tools" | "modelTools" | "extensions"> => ({
    tools: [],
    modelTools: [],
    extensions: caps.vision === undefined ? [] : [caps.vision],
  });

  /** Retire a capture and deny the conversation in the same commit; used for every terminal path. */
  const retireCaptured = async (tx: Tx, id: ConversationId): Promise<void> => {
    await tx.retireDoc(ConfigToolCaptureDoc, id);
    await configure(tx, id, deniedPolicy());
  };

  /**
   * Write a fresh capture for a background target. The names are the origin's current ceiling for
   * that role (`captureFor`), never the target's own state; classifier authority only with the tool.
   */
  const writeCapture = async (
    tx: Tx, target: ConversationId, origin: ConversationId, tools: readonly string[],
  ): Promise<string[]> => {
    const capture = await tx.doc(ConfigToolCaptureDoc, target);
    capture.originConversationId = origin;
    capture.tools = [...tools];
    capture.classifierModel = capture.tools.includes(CLASSIFIER_MODEL_TOOL_NAME) ? options.classifierGrantKey ?? null : null;
    return capture.tools;
  };

  /**
   * Configure a freshly captured background target through the same policy every later pass uses:
   * its role's extensions and the capture (`captured`, as just written) intersected with the role's
   * ceiling. `undefined` means no capture: the target keeps no tool and any capture is retired.
   */
  const configureCaptured = async (
    tx: Tx, target: ConversationId, role: ConversationRole, agent: AgentChange, captured: readonly string[] | undefined,
  ): Promise<void> => {
    await configure(tx, target, {
      ...agent,
      ...extensionsPolicy(target, role),
      ...await toolFilterFor(tx, target, captured === undefined ? undefined : new Set(captured), role),
    });
  };

  /**
   * Every native creation path, including forks and raw/task-created conversations, starts denied.
   * Any capture document is retired so a fork's copied agent state can never inherit authority, and
   * extensions are explicit so a later dynamic install cannot be selected by default.
   */
  const denyNewConversation = (tx: Tx, conversation: { readonly id: ConversationId }) =>
    retireCaptured(tx, conversation.id);

  return {
    registry,
    workerToolNames,
    scheduledRunCapabilityNames,
    ceilingFor,
    captureFor,
    extensionsPolicy,
    toolFilterFor,
    deniedPolicy,
    retireCaptured,
    writeCapture,
    configureCaptured,
    denyNewConversation,
    workerCapabilityExtension,
    scheduledRunCapabilityExtension,
  };
}
