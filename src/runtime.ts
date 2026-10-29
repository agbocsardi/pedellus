import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, configure, ConversationBusy, createRegistry, defineDoc, Harness, LiveDoc, type AgentChange, type AgentState, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type Harness as HarnessType, type ModelRef, type Storage, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, createContextExtensionBuilder, type ContextExtensionReplacement, type ConversationContextSnapshot } from "./context/index.js";
import { createSkillTool, SKILL_TOOL_NAME, type SkillTableUpdate } from "./context/skill-tool.js";
import { CRON_RUN_TASK_NAME, createCronFoundation } from "./automation/cron.js";
import { createCronTool, CRON_TOOL_NAME } from "./automation/cron-tool.js";
import {
  HISTORY_INDEX_LIMITS,
  createHistoryIndex,
  historyIndexPath,
  type HistoryIndex,
  type HistoryPage,
  type HistoryQuery,
  type HistorySession,
} from "./history/index.js";
import type { CronOwner } from "./automation/cron.js";
import {
  createEpisodeCatalog,
  type EpisodeCatalog,
  type EpisodeReconcileReport,
  type HistoryEpisode,
  type HistoryEpisodePage,
  type HistoryEpisodeQuery,
} from "./history/episodes.js";
import {
  encodedSessionKey,
  isChatSessionKey,
  readChatSessions,
  readMappedSessions,
  type HistoryChatSession,
} from "./history/scope.js";
import { ensureStoreIdentity, type StoreIdentity } from "./history/store-identity.js";
import { parseToolTimeoutSeconds, type ModelReference, type PortConfig } from "./config.js";
import { hasPersistedNanobotContext, preparedContextReplay, preparedTaskModel } from "./recovery/prepared.js";
import { prepareDataDirectory } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import { createProviderModels, nativeModelReference, resolveModelChoices, type ResolvedModelChoice } from "./providers.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import {
  CODING_TOOL_NAMES,
  ToolGrantDoc,
  ToolGrantOriginDoc,
  activeToolGrants,
  createCodingToolExtension,
  createToolEnvironments,
  normalizeToolGrants,
  pruneToolGrants,
  type CodingToolName,
  type GatewayToolGrant,
  type ToolEnvironments,
} from "./tools/index.js";

const SessionMap = defineDoc<{ sessions: Record<string, number> }>({
  kind: "nanobot.session-map", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});

export interface GatewayModelChoice {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export interface GatewayModelSelectionRequest extends ModelReference {
  thinkingLevel?: ModelThinkingLevel;
}

export interface GatewayModelSelection extends ModelReference {
  thinkingLevel: ModelThinkingLevel;
}

export interface GatewayModelList {
  models: readonly GatewayModelChoice[];
  selected: GatewayModelSelection;
}

export type GatewayContextSnapshotProvider = (
  sessionKey: string,
  conversationId: ConversationId,
  context: Context,
) =>
  | Omit<ConversationContextSnapshot, "conversationId">
  | undefined
  | Promise<Omit<ConversationContextSnapshot, "conversationId"> | undefined>;

/** Result of an explicit, per-session context refresh. */
export interface GatewayContextRefresh {
  /** Skills in the refreshed snapshot; 0 removes this conversation's on-demand skill table. */
  readonly skills: number;
}

export interface OpenGatewayOptions {
  readonly models?: Models;
  /** Explicit host-owned context snapshots; absent means no context extension is installed. */
  readonly contextSnapshotProvider?: GatewayContextSnapshotProvider;
}

/** Read-only query for a bounded page of one mapped chat session's raw transcript entries. */
export interface HistoryEntryQuery {
  readonly minEntryId?: EntryId;
  readonly maxEntryId?: EntryId;
  readonly order?: "ascending" | "descending";
}

/** Read-only page of raw entries; the caller is responsible for filtering internal content. */
export interface HistoryEntryPage {
  readonly conversationId: ConversationId;
  readonly sessionKey: string;
  readonly items: readonly EntryRecord[];
  readonly next?: Cursor;
}

export interface Gateway {
  readonly harness: HarnessType;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /** Lists the explicit allowlist and persisted selection for an already-known session key. */
  listModels(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /** Persists a native pi.agent choice; rejects ConversationBusy atomically without changing it. */
  selectModel(sessionKey: string, selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  /** Active, unexpired grants for a known session; empty when tools are disabled. */
  listToolGrants(sessionKey: string, context: Context): Promise<readonly GatewayToolGrant[]>;
  /**
   * Immutable identity of this SQLite store. A derived index persists `storeId` and refuses
   * its own rows when it changes, so a rebuilt or replaced store cannot mix two histories.
   * It carries no access: the host still authenticates the reader.
   */
  historyIdentity(context: Context): Promise<StoreIdentity>;
  /**
   * Episodes of one mapped chat session: discussions bounded by committed reset entries,
   * newest first. Read-only over Durable's transcript; nothing is summarized or indexed and
   * no model runs. A state-only channel conversation is not history and is rejected.
   *
   * `next.before` is a durable entry ID, so a continuation stays stable across appends and
   * reopen. `summary.status` reports `open`, `pending`, `ready`, `failed`, or `unknown` when
   * reconciliation has not reached that boundary yet; the original entries are always the
   * authority and remain readable through the conversation handle. Boundaries and counts are
   * the same before and after reconciliation. Empty episodes are omitted: an episode whose
   * only entry is its own reset marker is not a discussion. A reset handoff is synthetic
   * context, so `messages` counts ordinary user and assistant entries only.
   */
  listHistoryEpisodes(
    sessionKey: string,
    query: HistoryEpisodeQuery,
    context: Context,
  ): Promise<HistoryEpisodePage>;
  /** One episode by its start entry ID, or undefined when it is not a known boundary. */
  historyEpisode(sessionKey: string, startEntryId: number, context: Context): Promise<HistoryEpisode | undefined>;
  /**
   * Bounded read-only page of one existing mapped chat session's raw entries. This never creates
   * a conversation, writes a transcript, starts a model or accepts a conversation ID. State-only
   * channel conversations are rejected. Callers must filter internal kinds themselves before
   * displaying anything; this is a trusted host surface, not an untrusted-channel API.
   */
  historyEntries(
    sessionKey: string,
    query: HistoryEntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<HistoryEntryPage>;
  /**
   * Catch this session's episode catalog up now. Idempotent, bounded, and never schedules a
   * summary; the same work also runs in the background after resets and on reopen.
   */
  reconcileHistoryEpisodes(sessionKey: string, context: Context): Promise<EpisodeReconcileReport>;
  /**
   * Search the rebuildable SQLite index over Durable-retained entries.
   *
   * The index is bound to this store's immutable `nanobot.store-identity` document, minted on the
   * first open and only read afterwards, so a replaced store file never sees another store's rows.
   * Durable is the canonical transcript. This method never mutates it, accepts no conversation ID,
   * and reads only the mapped
   * chat sessions supplied by the host. The host is the authorization boundary:
   * call it only from trusted host code after its own channel authentication, and do not expose the
   * results (which include session keys) directly to an untrusted model or channel.
   *
   * Default scope is user/assistant message text, optionally filtered by role. `tools` searches tool
   * names, arguments and result text only; `all` combines both. Thinking, system prompts, reset
   * handoffs and compaction summaries are never in these scopes. State-only conversations and
   * task-owned background runs are excluded. Tool hits expose records, never execution authority.
   *
   * Each call reconciles a bounded slice of new Durable entries before querying. `coverage` reports
   * index lag rather than silently omitting it: a large backlog is visible and continues on the next
   * call. Long message/tool text is chunked and remains searchable up to the documented per-entry
   * cap; omitted chunks are counted. Pages are ordered newest-first by Durable entry ID and resume
   * with a query-, mapping-, generation- and source-bound cursor; entries appended after the first
   * page stay out of that continuation, and a rebuilt index or changed store identity rejects the
   * cursor. The derived index may be deleted at any time and is rebuilt from Durable.
   */
  historySearch(query: HistoryQuery, context: Context): Promise<HistoryPage>;
  /**
   * Re-runs the configured context snapshot provider for one existing session and applies it to the
   * next turn. Rejects an unknown session, a live run, or a gateway opened without a provider.
   * Prompt content stays metadata-only and no tool grant is added or widened.
   */
  refreshContext(sessionKey: string, context: Context): Promise<GatewayContextRefresh>;
  /**
   * Adds explicit expiring grants for a known session. Every name must be inside the host ceiling and
   * every expiry must be in the future; a conversation never receives an implicit or permanent grant.
   */
  grantTools(sessionKey: string, grants: unknown, context: Context): Promise<readonly GatewayToolGrant[]>;
  /** Revokes grants by name. Revocation is persisted and survives reopen; unknown names are ignored. */
  revokeTools(sessionKey: string, names: readonly string[], context: Context): Promise<readonly GatewayToolGrant[]>;
  close(context: Context): Promise<void>;
}

function bindContextSnapshot(
  value: object | undefined,
  conversationId: ConversationId,
): ConversationContextSnapshot {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (value !== undefined) {
    for (const key of ["identity", "agents", "soul", "user", "memory", "skills", "skillSummary"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) snapshot[key] = descriptor.value;
    }
  }
  snapshot.conversationId = conversationId;
  return snapshot as unknown as ConversationContextSnapshot;
}

function modelKey(model: ModelReference | ModelRef): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A live cron run's background target, recovered from its durable checkpoint. */
interface CronBackgroundTarget {
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
}

/**
 * The target of one non-terminal cron run whose checkpoint already chose it. A background run's
 * target is task-owned and deliberately absent from the SessionMap, so it is restored from the run
 * task itself. An origin-mode run's target is the origin, which the map already restores.
 */
function cronBackgroundTarget(task: unknown): CronBackgroundTarget | undefined {
  if (!isRecord(task) || task.kind !== CRON_RUN_TASK_NAME) return undefined;
  const { conversationId, state } = task;
  if (!Number.isSafeInteger(conversationId) || (conversationId as number) < 1) return undefined;
  if (!isRecord(state) || state.status === "terminal" || state.status === "completing") return undefined;
  if (!isRecord(state.checkpoint)) return undefined;
  const targetConversationId = state.checkpoint.targetConversationId;
  if (!Number.isSafeInteger(targetConversationId) || (targetConversationId as number) < 1) return undefined;
  if (targetConversationId === conversationId) return undefined;
  return {
    originConversationId: conversationId as ConversationId,
    targetConversationId: targetConversationId as ConversationId,
  };
}

function isModelSelection(value: unknown): value is GatewayModelSelectionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (!Object.hasOwn(value, "provider") || !Object.hasOwn(value, "modelId")) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === "string" && candidate.provider.length > 0 &&
    typeof candidate.modelId === "string" && candidate.modelId.length > 0;
}

export async function openGateway(config: PortConfig, context: Context, options: OpenGatewayOptions = {}): Promise<Gateway> {
  // A config name is not a Durable registration identity or an authorization grant. Only the four
  // native coding tools have reviewed registrations; anything else fails closed before setup.
  const toolAllowlist = config.toolAllowlist ?? [];
  const unavailableTools = toolAllowlist.filter(
    (name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name),
  );
  if (unavailableTools.length > 0) {
    throw new StartupDiagnosticError("configInvalid", {
      detail: `toolAllowlist names unsupported tools: ${unavailableTools.join(", ")} ` +
        "(no approved registered tools)",
    });
  }
  const toolsEnabled = toolAllowlist.length > 0;
  // Internal agent scheduling: opt-in, and independent of the coding-tool ceiling so a reminder job
  // needs no filesystem authority.
  const cronConfig = config.cron;
  const cronEnabled = cronConfig?.enabled === true;
  // Fail at startup, not at the first tool call, when the default cannot be represented by the host shell.
  const toolTimeoutSeconds = parseToolTimeoutSeconds(config.toolTimeoutSeconds);
  const allowedModels = config.allowedModels ?? [config.model];
  const prepared = options.models
    ? { models: options.models, model: nativeModelReference(config.model) }
    : createProviderModels(config);
  const { models, model } = prepared;
  const choices = resolveModelChoices(models, allowedModels);
  const choicesByConfigured = new Map(choices.map((choice) => [modelKey(choice.configured), choice]));
  const choicesByNative = new Map(choices.map((choice) => [modelKey(choice.native), choice]));
  const defaultChoice = choicesByConfigured.get(modelKey(config.model));
  if (!defaultChoice) {
    throw new StartupDiagnosticError("model", { detail: "Default model must be included in allowedModels" });
  }
  if (modelKey(model) !== modelKey(defaultChoice.native)) {
    throw new StartupDiagnosticError("model", {
      detail: "Resolved default model does not match its configured choice",
    });
  }
  if (config.thinkingLevel !== undefined && !defaultChoice.thinkingLevels.includes(config.thinkingLevel)) {
    throw new StartupDiagnosticError("model", {
      detail: `Unsupported thinkingLevel ${config.thinkingLevel} for default model ${config.model.provider}/${config.model.modelId}`,
    });
  }
  if (options.contextSnapshotProvider !== undefined && typeof options.contextSnapshotProvider !== "function") {
    throw new TypeError("contextSnapshotProvider must be a function");
  }
  const defaultThinkingLevel = config.thinkingLevel ?? "off";
  let preparedDataDirectory: Awaited<ReturnType<typeof prepareDataDirectory>>;
  try {
    preparedDataDirectory = await prepareDataDirectory(config);
  } catch (cause) {
    throw new StartupDiagnosticError("workspace", { cause });
  }
  const { workspace, extraRoots, dbPath } = preparedDataDirectory;
  const hostPolicy: AgentChange = { cwd: workspace };
  const defaultAgentPolicy: AgentChange = {
    ...hostPolicy,
    model,
    thinkingLevel: defaultThinkingLevel,
    tools: [],
    modelTools: [],
  };
  const now = () => Date.now();
  // Mirrors the shared policy's config-level default so a host-default timeout reports its duration.
  const defaultTimeoutSeconds = toolTimeoutSeconds ?? 60;
  const toolExtension: Extension | undefined = toolsEnabled
    ? createCodingToolExtension({
        tools: toolAllowlist as readonly CodingToolName[],
        ceiling: toolAllowlist,
        contextTools: [
          ...(options.contextSnapshotProvider === undefined ? [] : [SKILL_TOOL_NAME]),
          ...(cronEnabled ? [CRON_TOOL_NAME] : []),
        ],
        defaultTimeoutSeconds,
        now,
      })
    : undefined;
  const toolEnvironments: ToolEnvironments | undefined = toolsEnabled
    ? createToolEnvironments({
        workspaceRoot: workspace,
        allowedRoots: extraRoots,
        sandbox: config.toolSandbox ?? "host",
        ...(config.bwrapPath === undefined ? {} : { bwrapPath: config.bwrapPath }),
        ...(toolTimeoutSeconds === undefined ? {} : { timeoutSeconds: toolTimeoutSeconds }),
      })
    : undefined;
  const fallbackThinkingLevel = (choice: ResolvedModelChoice): ModelThinkingLevel =>
    config.thinkingLevel !== undefined && choice.thinkingLevels.includes(config.thinkingLevel)
      ? config.thinkingLevel
      : "off";
  const choiceFromState = (state: Readonly<AgentState> | undefined): ResolvedModelChoice | undefined =>
    state?.model === undefined ? undefined : choicesByNative.get(modelKey(state.model));
  const policyForState = (state: Readonly<AgentState> | undefined): AgentChange => {
    const existing = choiceFromState(state);
    const choice = existing ?? defaultChoice;
    const modelWasRevoked = existing === undefined;
    const thinkingLevel = !modelWasRevoked && state?.thinkingLevel !== undefined && choice.thinkingLevels.includes(state.thinkingLevel)
      ? state.thinkingLevel
      : fallbackThinkingLevel(choice);
    return { ...hostPolicy, model: choice.native, thinkingLevel };
  };
  let contextExtension: Extension | undefined;
  const contextExtensionBuilder = createContextExtensionBuilder();
  const contextConversations = new Set<ConversationId>();
  // A read-only progressive skill loader: it serves bodies from the host snapshot only, so a
  // builtin skill outside the workspace is reachable without widening the workspace or the shell.
  const skillTool = options.contextSnapshotProvider === undefined ? undefined : createSkillTool();
  const skillToolRegistration = skillTool?.extension.tools?.[0];
  const skillConversations = new Set<ConversationId>();
  // Mapped session keys own their snapshot. A scheduled run's target is tracked separately in
  // insertion order so the cap can drop an idle target instead of failing the run, and never a
  // mapped session's snapshot.
  const sessionConversations = new Set<ConversationId>();
  const backgroundTargets: ConversationId[] = [];
  // Always an explicit selection, never an add/remove edit: Durable's edit form resolves against the
  // extensions installed at read time, so a later dynamic install (a new conversation's context
  // extension) would otherwise be selected by unrelated conversations.
  const extensionsPolicy = (conversationId: ConversationId): AgentChange => {
    const selected: Extension[] = [];
    if (toolExtension) selected.push(toolExtension);
    if (options.contextSnapshotProvider && contextExtension && contextConversations.has(conversationId)) {
      selected.push(contextExtension);
    }
    if (skillTool && contextConversations.has(conversationId) && skillConversations.has(conversationId)) {
      selected.push(skillTool.extension);
    }
    if (cronFoundation && cronTool && cronOwners.has(conversationId)) {
      selected.push(cronFoundation.extension, cronTool.extension);
    }
    return { extensions: selected };
  };
  const toolRegistrations = new Map<string, ToolRegistration>(
    (toolExtension?.tools ?? []).map((tool) => [tool.name, tool]),
  );
  // Origin sessions only: a scheduled run's fresh background conversation is not an origin session,
  // so it cannot schedule further jobs. Owners are keyed by the mapped session key.
  const cronOwners = new Map<ConversationId, CronOwner>();
  const harnessRef: { current?: HarnessType } = {};
  // The snapshot-install path, late-bound because cron's `prepare` can only call it once
  // Harness.open() has run. It reports whether skills were installed for that conversation.
  const contextInstallerRef: {
    current?: (sessionKey: string, conversationId: ConversationId, ctx: Context) => Promise<boolean>;
  } = {};
  const cronFoundation = cronEnabled
    ? createCronFoundation({
        now,
        // A background run is a fresh, task-owned conversation that starts default-deny. Copy the
        // origin conversation's still-valid grants so the run has exactly the authority that
        // scheduled it, bounded by those grants' own expiries, and record the origin beside them so
        // the grant hook can hold the copy to the origin's current grants. An origin-mode run needs
        // nothing: it answers inside the conversation that already holds them.
        prepare: async ({ tx, originConversationId, targetConversationId, background }, ctx) => {
          if (!background) return;
          // Fail closed on a run whose origin cannot be attributed to a known owner: it gets no
          // copied grants and no origin link, so every effectful call stays denied.
          const owner = cronOwners.get(originConversationId);
          const granted: string[] = [];
          if (owner !== undefined) {
            const origin = await tx.doc(ToolGrantDoc, originConversationId);
            const target = await tx.doc(ToolGrantDoc, targetConversationId);
            const link = await tx.doc(ToolGrantOriginDoc, targetConversationId);
            // Replace, never extend, whatever the target held: the copy is exactly the origin's
            // current grants at this instant, and the link is durable in the same commit.
            for (const name of Object.keys(target.grants)) delete target.grants[name];
            link.originConversationId = originConversationId;
            const timestamp = now();
            for (const name of toolAllowlist) {
              const expiresAt = origin.grants[name];
              if (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > timestamp) {
                target.grants[name] = expiresAt;
                granted.push(name);
              }
            }
          }
          // The run's fresh conversation is default-deny, so it also receives the origin's workspace
          // context through the same snapshot path: bootstrap/AGENTS, the memory manifest, the skill
          // summary and the read-only `skill` tool. An origin with no known owner skips this and keeps
          // the run default-deny. The cron tool and foundation are never offered here.
          const skillsInstalled = owner !== undefined && contextInstallerRef.current !== undefined
            ? await contextInstallerRef.current(owner.sessionKey, targetConversationId, ctx)
            : false;
          const tools = [
            ...granted.flatMap((name) => {
              const tool = toolRegistrations.get(name);
              return tool === undefined ? [] : [tool];
            }),
            ...(skillsInstalled && skillToolRegistration !== undefined ? [skillToolRegistration] : []),
          ];
          const extensions: Extension[] = [];
          if (toolExtension !== undefined) extensions.push(toolExtension);
          if (contextConversations.has(targetConversationId) && contextExtension !== undefined) {
            extensions.push(contextExtension);
          }
          if (skillsInstalled && skillTool !== undefined) extensions.push(skillTool.extension);
          await configure(tx, targetConversationId, { tools, modelTools: tools, extensions });
        },
        // The run's copied authority ends with it. Retire the target's copied grants and stop
        // offering its tools in the same commit that records the terminal outcome, so a finished or
        // cancelled run cannot be used for a later admission. The origin link is kept: any
        // re-created grant document for that target still has to satisfy the hook's origin check.
        finalize: async ({ tx, originConversationId, targetConversationId }) => {
          if (targetConversationId === originConversationId) return;
          await tx.retireDoc(ToolGrantDoc, targetConversationId);
          await configure(tx, targetConversationId, { tools: [], modelTools: [] });
        },
      })
    : undefined;
  const cronTool = cronFoundation === undefined
    ? undefined
    : createCronTool({
        foundation: cronFoundation,
        ownerFor: (conversationId) => cronOwners.get(conversationId),
        harness: () => {
          if (harnessRef.current === undefined) throw new Error("The runtime is not open");
          return harnessRef.current;
        },
        ...(cronConfig?.timeZone === undefined ? {} : { timeZone: cronConfig.timeZone }),
      });
  const cronToolRegistration = cronTool?.extension.tools?.[0];
  const toolFilterFromNames = (
    names: readonly string[],
  ): { readonly tools: readonly ToolRegistration[] } => ({
    tools: names.flatMap((name) => {
      const tool = toolRegistrations.get(name);
      return tool === undefined ? [] : [tool];
    }),
  });
  const contextToolsFor = (conversationId: ConversationId): ToolRegistration[] => {
    // The skill loader is context delivery, not an effectful tool: it stays outside the
    // grant document and the host ceiling, and is offered only for captured skill snapshots.
    // The cron tool is an owner-scoped scheduling capability, not filesystem or shell authority,
    // and is offered only in an origin session whose owner is known.
    const skillTools = skillToolRegistration !== undefined && skillConversations.has(conversationId)
      ? [skillToolRegistration]
      : [];
    const cronTools = cronToolRegistration !== undefined && cronOwners.has(conversationId)
      ? [cronToolRegistration]
      : [];
    return [...skillTools, ...cronTools];
  };
  /**
   * The grant-derived tool filter. A scheduled background run passes `copiedGrantBound`, the
   * authority its origin still supports: it replaces the copied document with exactly those names
   * and expiries, so a copied grant never outlives or outgrows its origin. An empty bound is a
   * genuine deny and retires the copy.
   */
  const toolFilterFor = async (
    tx: Tx,
    conversationId: ConversationId,
    copiedGrantBound?: ReadonlyMap<string, number>,
  ): Promise<Pick<AgentChange, "tools" | "modelTools">> => {
    const contextTools = contextToolsFor(conversationId);
    if (!toolExtension) {
      // Retire instead of creating an empty document: a disabled ceiling must durably remove
      // previously granted tools so re-enabling it cannot resurrect them.
      await tx.retireDoc(ToolGrantDoc, conversationId);
      return { tools: contextTools, modelTools: contextTools };
    }
    const document = await tx.doc(ToolGrantDoc, conversationId);
    if (copiedGrantBound !== undefined) {
      for (const name of Object.keys(document.grants)) {
        if (!copiedGrantBound.has(name)) delete document.grants[name];
      }
      for (const [name, expiresAt] of copiedGrantBound) document.grants[name] = expiresAt;
    }
    const tools = [
      ...toolFilterFromNames(pruneToolGrants(document, toolAllowlist, now())).tools,
      ...contextTools,
    ];
    return { tools, modelTools: tools };
  };
  const denyNewConversation = async (
    tx: Tx,
    conversation: { readonly id: ConversationId },
  ): Promise<void> => {
    // Every native creation path, including forks and raw/task-created conversations, starts denied.
    // The grant document is retired so a fork's copied agent state can never inherit authority, and
    // extensions are explicit so a later dynamic install cannot be selected by default.
    await tx.retireDoc(ToolGrantDoc, conversation.id);
    await configure(tx, conversation.id, { tools: [], modelTools: [], extensions: [] });
  };
  const publicChoice = (choice: ResolvedModelChoice): GatewayModelChoice => ({
    ...choice.configured,
    name: choice.model.name,
    thinkingLevels: [...choice.thinkingLevels],
  });
  const publicSelection = (choice: ResolvedModelChoice, thinkingLevel: ModelThinkingLevel): GatewayModelSelection => ({
    ...choice.configured,
    thinkingLevel,
  });
  async function applyConversationPolicy(conversation: Conversation, ctx: Context): Promise<void> {
    await conversation.commit(async (tx) => {
      const state = await tx.doc(AgentDoc, conversation.id);
      const toolFilter = await toolFilterFor(tx, conversation.id);
      await configure(tx, conversation.id, {
        ...policyForState(state),
        ...extensionsPolicy(conversation.id),
        ...toolFilter,
      });
    }, ctx);
  }
  const releaseLock = await processLock(`nanobot:${dbPath}`);
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let episodeCatalog: EpisodeCatalog | undefined;
  let historyIndex: HistoryIndex | undefined;
  let closed = false;
  try {
    const registry = createRegistry();
    if (toolExtension) registry.install(toolExtension);
    if (skillTool) registry.install(skillTool.extension);
    if (cronFoundation) registry.install(cronFoundation.extension);
    if (cronTool) registry.install(cronTool.extension);
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    const harnessOptions = {
      models,
      registry,
      conversationCreated: denyNewConversation,
      ...(toolEnvironments === undefined
        ? {}
        : {
            env: (target: { readonly conversationId: ConversationId }, ctx: Context) =>
              toolEnvironments.forConversation(target.conversationId, ctx),
          }),
    };
    harness = await Harness.open(storage, harnessOptions, context);
    harnessRef.current = harness;
    const root = await harness.root(context, { agent: defaultAgentPolicy });

    // One immutable identity document per store, minted on first open. A derived index binds
    // its rows to this value instead of to a file path, which a replaced store can reuse.
    const storeIdentity = await ensureStoreIdentity(harness!, context, { now });

    // One shared reader validates the stored session map; history scope is the chat subset of it.
    // A channel's own state conversation, an unmapped conversation (a scheduled run's task-owned
    // target) and the root are not chat history. The host has already authenticated the session key
    // before naming it.
    const mappedChatSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> => {
      const mapping = await harness!.snapshot(SessionMap, root.id, ctx);
      return mapping === undefined ? [] : readChatSessions(mapping.sessions, root.id);
    };
    // A mapped chat session is ownerless and unforked. Search and every entry/episode read share
    // this check so a task-owned background transcript or an inherited fork cannot be exposed
    // under a chat session's name.
    const assertMappedChatConversations = async (
      conversationIds: readonly ConversationId[],
      ctx: Context,
    ): Promise<void> => {
      await root.commit(async (tx) => {
        for (const conversationId of conversationIds) {
          const conversation = await tx.conversation(conversationId);
          if (conversation === undefined) throw new Error("Stored session mapping points to a missing conversation");
          if (conversation.owner !== undefined) throw new Error("Stored session mapping points to a task-owned conversation");
          if (conversation.parent !== undefined) throw new Error("Stored session mapping points to a forked conversation");
        }
      }, ctx);
    };
    // Bounded, background-only derived state: reset-delimited episode boundaries and their
    // durable summary status. It reads committed entries only and changes no reset or busy
    // ordering; a closed episode is recorded as pending, and nothing schedules a summary yet.
    episodeCatalog = createEpisodeCatalog({ harness: harness!, sessions: mappedChatSessions, context });

    // Derived, rebuildable search index. Its file is separate from Durable's store, and every Durable
    // read goes through `root.commit` without a write. A missing index is rebuilt from retained entries.
    // It is bound to this store's committed identity, so a replaced store file clears every derived row.
    const historySessions = async (ctx: Context): Promise<readonly HistorySession[]> => {
      const mapping = await harnessRef.current!.snapshot(SessionMap, root.id, ctx);
      if (mapping === undefined) return [];
      const mappedSessions = readChatSessions(mapping.sessions, root.id);
      if (mappedSessions.length > HISTORY_INDEX_LIMITS.maxMappedSessions) {
        throw new Error(
          `History search supports at most ${HISTORY_INDEX_LIMITS.maxMappedSessions} mapped chat sessions; ` +
          `${mappedSessions.length} are present`,
        );
      }
      // A mapped chat session is ownerless and unforked. Fail loudly rather than silently indexing a
      // task-owned background transcript or an inherited fork under a chat session's name.
      await assertMappedChatConversations(mappedSessions.map(({ conversationId }) => conversationId), ctx);
      return mappedSessions;
    };
    historyIndex = createHistoryIndex({
      indexPath: historyIndexPath(dbPath),
      sourcePath: dbPath,
      storeId: storeIdentity.storeId,
      sessions: historySessions,
      scan: (ctx, read) => root.commit(read, ctx),
    });

    // At the snapshot cap, drop the oldest installed background target that is not running and not a
    // mapped session. Without an evictable target the builder's RangeError stays the last resort.
    const makeSnapshotRoom = async (ctx: Context): Promise<void> => {
      if (contextConversations.size < CONTEXT_LIMITS.maxConversations) return;
      for (const candidate of backgroundTargets.slice()) {
        if (sessionConversations.has(candidate) || !contextConversations.has(candidate)) continue;
        const live = await harnessRef.current!.snapshot(LiveDoc, candidate, ctx);
        if (live?.run !== undefined) continue;
        backgroundTargets.splice(backgroundTargets.indexOf(candidate), 1);
        contextConversations.delete(candidate);
        skillConversations.delete(candidate);
        skillTool?.removeConversation(candidate);
        contextExtension = contextExtensionBuilder.remove(candidate);
        registry.install(contextExtension);
        return;
      }
    };
    const contextSnapshotLoads = new Map<ConversationId, Promise<unknown>>();
    const installContextSnapshot = async (
      sessionKey: string,
      conversationId: ConversationId,
      ctx: Context,
      backgroundTarget: boolean,
    ): Promise<boolean> => {
      if (!options.contextSnapshotProvider) return false;
      const loading = contextSnapshotLoads.get(conversationId);
      if (loading !== undefined) {
        await loading;
        return skillConversations.has(conversationId);
      }
      if (contextConversations.has(conversationId)) return skillConversations.has(conversationId);
      if (backgroundTarget && !backgroundTargets.includes(conversationId)) {
        backgroundTargets.push(conversationId);
      }
      const pending = Promise.resolve()
        .then(() => options.contextSnapshotProvider!(sessionKey, conversationId, ctx))
        .then(async (supplied) => {
          if (supplied !== undefined && !isRecord(supplied)) {
            throw new TypeError("Context snapshot provider must return an object or undefined");
          }
          const snapshot = bindContextSnapshot(supplied, conversationId);
          if (backgroundTarget) await makeSnapshotRoom(ctx);
          const extension = contextExtensionBuilder.add(snapshot);
          contextConversations.add(conversationId);
          let skillsPresent = false;
          if (skillTool !== undefined) {
            if (skillTool.setConversation(conversationId, snapshot).skills > 0) {
              skillConversations.add(conversationId);
              skillsPresent = true;
            } else {
              skillConversations.delete(conversationId);
            }
          }
          contextExtension = extension;
          registry.install(extension);
          return skillsPresent;
        })
        .finally(() => {
          if (contextSnapshotLoads.get(conversationId) === pending) contextSnapshotLoads.delete(conversationId);
        });
      contextSnapshotLoads.set(conversationId, pending);
      return pending;
    };
    const ensureContextSnapshot = async (
      sessionKey: string,
      conversationId: ConversationId,
      ctx: Context,
    ): Promise<void> => {
      await installContextSnapshot(sessionKey, conversationId, ctx, false);
    };
    contextInstallerRef.current = (sessionKey, conversationId, ctx) =>
      installContextSnapshot(sessionKey, conversationId, ctx, true);

    // Explicit same-conversation refresh: re-run the host provider and apply the new snapshot to the
    // next turn. It is opt-in, per session key, and refuses a live run. Provider or loader failure
    // leaves the captured snapshot untouched. Refresh changes no grant: it re-renders the skills
    // summary and replaces the on-demand skill table, while the normal policy pass only prunes grants
    // as before. Background cron targets are not reachable here because they have no session key.
    // The refresh registers in contextSnapshotLoads so an install for the same conversation cannot
    // build a competing snapshot; any failed commit restores the prior in-memory extension/table.
    const refreshContextSnapshot = async (
      sessionKey: string,
      conversationId: ConversationId,
      ctx: Context,
    ): Promise<number> => {
      // Serialize with an in-flight install or a previous refresh for this conversation.
      for (;;) {
        const loading = contextSnapshotLoads.get(conversationId);
        if (loading === undefined) break;
        await loading;
      }
      const pending = (async () => {
        const conversation = await harnessRef.current!.conversation(conversationId, ctx);
        if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
        // Refuse an obvious live run before re-reading skill files; the commit below rechecks atomically.
        if ((await harnessRef.current!.snapshot(LiveDoc, conversationId, ctx))?.run !== undefined) {
          throw new ConversationBusy(conversationId);
        }
        const supplied = await options.contextSnapshotProvider!(sessionKey, conversationId, ctx);
        if (supplied !== undefined && !isRecord(supplied)) {
          throw new TypeError("Context snapshot provider must return an object or undefined");
        }
        const snapshot = bindContextSnapshot(supplied, conversationId);
        const hadContext = contextConversations.has(conversationId);
        const hadSkills = skillConversations.has(conversationId);
        const previousExtension = contextExtension;
        let replacement: ContextExtensionReplacement | undefined;
        let table: SkillTableUpdate | undefined;
        try {
          return await conversation.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, conversationId);
            if (live.run !== undefined) throw new ConversationBusy(conversationId);
            replacement ??= contextExtensionBuilder.replace(snapshot);
            table ??= skillTool?.setConversation(conversationId, snapshot);
            const count = table?.skills ?? 0;
            contextExtension = replacement.extension;
            contextConversations.add(conversationId);
            if (count > 0) skillConversations.add(conversationId);
            else skillConversations.delete(conversationId);
            // Publish synchronously inside the commit: a deferred install could race a builder change
            // from another conversation and publish an older superset under the same extension name.
            registry.install(replacement.extension);
            const toolFilter = await toolFilterFor(tx, conversationId);
            await configure(tx, conversationId, { ...extensionsPolicy(conversationId), ...toolFilter });
            return count;
          }, ctx);
        } catch (error) {
          table?.restore();
          if (hadContext) contextConversations.add(conversationId);
          else contextConversations.delete(conversationId);
          if (hadSkills) skillConversations.add(conversationId);
          else skillConversations.delete(conversationId);
          if (replacement !== undefined) {
            const restoredExtension = replacement.restore();
            contextExtension = restoredExtension;
            registry.install(restoredExtension);
          } else {
            contextExtension = previousExtension;
          }
          throw error;
        }
      })();
      contextSnapshotLoads.set(conversationId, pending);
      try {
        return await pending;
      } finally {
        if (contextSnapshotLoads.get(conversationId) === pending) contextSnapshotLoads.delete(conversationId);
      }
    };

    // Restore the persisted session mapping before resume can schedule work. Cron owners come from
    // the same mapping and are restored even without a context snapshot provider: the policy pass
    // below would otherwise strip the cron tool from every persisted origin session on reopen.
    const mappedSessionKeys = new Map<ConversationId, string>();
    if (options.contextSnapshotProvider || cronEnabled) {
      await root.commit(async (tx) => { await tx.doc(SessionMap, root.id); }, context);
      const mapping = await harness.snapshot(SessionMap, root.id, context);
      const sessions = mapping?.sessions;
      const mappedSessions = readMappedSessions(sessions, root.id);
      if (options.contextSnapshotProvider && mappedSessions.length > CONTEXT_LIMITS.maxConversations) {
        throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
      }
      for (const { sessionKey, conversationId } of mappedSessions) {
        if (options.contextSnapshotProvider) {
          if (!(await harness.conversation(conversationId, context))) {
            throw new Error("Stored session mapping points to a missing conversation");
          }
          await ensureContextSnapshot(sessionKey, conversationId, context);
        }
        cronOwners.set(conversationId, { ownerId: sessionKey, sessionKey });
        sessionConversations.add(conversationId);
        mappedSessionKeys.set(conversationId, sessionKey);
      }
    }

    // Refuse unsafe prepared replays before resume; checkpoints pin historical context cutoffs.
    const preparedContextReplays: NonNullable<ReturnType<typeof preparedContextReplay>>[] = [];
    const backgroundRunTargets: CronBackgroundTarget[] = [];
    const runTasksById = new Map<number, { readonly originConversationId: ConversationId; readonly targetConversationId: ConversationId | null }>();
    await root.commit(async (tx) => {
      let taskCursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks({}, 1000, taskCursor);
        for (const task of page.items) {
          const backgroundTarget = cronBackgroundTarget(task);
          if (task.kind === CRON_RUN_TASK_NAME) {
            runTasksById.set(Number(task.id), {
              originConversationId: task.conversationId as ConversationId,
              targetConversationId: backgroundTarget?.targetConversationId ?? null,
            });
          }
          if (backgroundTarget !== undefined) {
            // The target must still be the conversation this run task owns on behalf of its origin;
            // a mismatched record is not a run target and gets no bound or snapshot restore.
            const target = await tx.conversation(backgroundTarget.targetConversationId);
            if (target?.owner?.taskId === Number(task.id)
              && target.owner.conversationId === backgroundTarget.originConversationId) {
              backgroundRunTargets.push(backgroundTarget);
            }
          }
          const preparedModel = preparedTaskModel(task);
          if (preparedModel !== undefined && !choicesByNative.has(modelKey(preparedModel))) {
            throw new Error(`Cannot resume ${task.kind} task ${task.id}: prepared model ${modelKey(preparedModel)} is outside allowedModels`);
          }
          const contextReplay = preparedContextReplay(task);
          if (contextReplay !== undefined) preparedContextReplays.push(contextReplay);
        }
        taskCursor = page.next;
      } while (taskCursor !== undefined);
    }, context);

    // A background run's target deliberately has no SessionMap entry. Restore its snapshot from the
    // run task's checkpoint before the pre-resume policy pass, so the pass keeps the context and
    // `skill` selections instead of stripping them. Unknown origins and missing conversations skip.
    if (options.contextSnapshotProvider) {
      for (const { originConversationId, targetConversationId } of backgroundRunTargets) {
        const sessionKey = mappedSessionKeys.get(originConversationId);
        if (sessionKey === undefined) continue;
        if (!(await harness.conversation(targetConversationId, context))) continue;
        await installContextSnapshot(sessionKey, targetConversationId, context, true);
      }
    }

    // Every conversation owned by a cron run task is that run's target. A live run's copy is
    // reauthorized below; a target whose run already ended keeps no prepared authority.
    const runTargetCandidates: { conversationId: ConversationId; originConversationId: ConversationId; live: boolean }[] = [];
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) {
          const owner = conversation.owner;
          if (owner?.taskId === undefined) continue;
          const task = runTasksById.get(Number(owner.taskId));
          if (task === undefined || task.originConversationId !== owner.conversationId) continue;
          runTargetCandidates.push({
            conversationId: conversation.id,
            originConversationId: task.originConversationId,
            live: task.targetConversationId === conversation.id,
          });
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }, context);

    // A copied background-run grant is only as good as its origin's current grant. Durable's tool
    // hooks run in the call phase only, so a committed execute intent resolves without them and a
    // resumed turn could otherwise admit a call the origin already revoked. Intersect every live
    // run's copy with the origin's current grants before resume, and treat a missing/mismatched
    // link, an unknown origin owner, a missing origin document or an already finished run as a deny
    // rather than a copy.
    const copiedGrantBounds = new Map<ConversationId, ReadonlyMap<string, number>>();
    for (const { conversationId: targetConversationId, originConversationId, live } of runTargetCandidates) {
      const bounded = new Map<string, number>();
      const link = live ? await harness.snapshot(ToolGrantOriginDoc, targetConversationId, context) : undefined;
      const origin = live && cronOwners.has(originConversationId)
        ? await harness.snapshot(ToolGrantDoc, originConversationId, context)
        : undefined;
      const copy = live ? await harness.snapshot(ToolGrantDoc, targetConversationId, context) : undefined;
      if (link?.originConversationId === originConversationId && origin !== undefined) {
        const timestamp = now();
        for (const name of toolAllowlist) {
          const copied = copy?.grants[name];
          const originExpiry = origin.grants[name];
          if (typeof copied === "number" && Number.isSafeInteger(copied) && copied > timestamp
            && typeof originExpiry === "number" && Number.isSafeInteger(originExpiry) && originExpiry > timestamp) {
            bounded.set(name, Math.min(copied, originExpiry));
          }
        }
      }
      copiedGrantBounds.set(targetConversationId, bounded);
    }

    for (const replay of preparedContextReplays) {
      const conversation = await harness.conversation(replay.conversationId, context);
      if (!conversation) throw new Error(`Cannot safely resume ${replay.kind} task ${replay.id}: conversation is missing`);
      const view = await conversation.context(context, { at: replay.at as EntryId });
      if (hasPersistedNanobotContext(view.messages)) {
        throw new Error(
          `Cannot safely resume ${replay.kind} task ${replay.id} (${replay.phase}): its prepared request includes ` +
          "persisted Nanobot context; cancel that prepared dispatch with the context recovery interface before gateway recovery",
        );
      }
    }

    // Apply host security, grants and context selection only after every prepared dispatch passes the replay guard.
    // Pruning expired/revoked grants before resume is what keeps a revoked tool from replaying.
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) {
          const state = await tx.doc(AgentDoc, conversation.id);
          const toolFilter = await toolFilterFor(tx, conversation.id, copiedGrantBounds.get(conversation.id));
          await configure(tx, conversation.id, {
            ...policyForState(state),
            ...extensionsPolicy(conversation.id),
            ...toolFilter,
          });
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }, context);

    const gateway: Gateway = {
      harness,
      async conversationFor(sessionKey, ctx) {
        const key = encodedSessionKey(sessionKey);
        let conversationId: ConversationId | undefined;
        await root.commit(async (tx) => {
          const map = await tx.doc(SessionMap, root.id);
          if (Object.hasOwn(map.sessions, key)) {
            conversationId = map.sessions[key] as ConversationId;
            return;
          }
          if (options.contextSnapshotProvider && Object.keys(map.sessions).length >= CONTEXT_LIMITS.maxConversations) {
            throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
          }
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          const toolFilter = await toolFilterFor(tx, created.id);
          await configure(tx, created.id, {
            ...defaultAgentPolicy,
            ...extensionsPolicy(created.id),
            ...toolFilter,
          });
          map.sessions[key] = created.id as number;
          conversationId = created.id;
        }, ctx);
        if (!Number.isSafeInteger(conversationId)) throw new Error("Stored conversation mapping has an invalid ID");
        // A mapped session key is the cron owner; unmapped conversations (such as a scheduled run's
        // own background conversation) have no owner and therefore never receive the cron tool.
        cronOwners.set(conversationId!, { ownerId: sessionKey, sessionKey });
        sessionConversations.add(conversationId!);
        const conversation = await harness!.conversation(conversationId!, ctx);
        if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
        await ensureContextSnapshot(sessionKey, conversationId!, ctx);
        // Read and reapply host policy atomically so concurrent selection cannot be overwritten.
        await applyConversationPolicy(conversation, ctx);
        return conversation;
      },
      async listModels(sessionKey, ctx) {
        const conversation = await existingConversationFor(sessionKey, ctx);
        await applyConversationPolicy(conversation, ctx);
        const state = await harness!.snapshot(AgentDoc, conversation.id, ctx);
        const choice = choiceFromState(state) ?? defaultChoice;
        const level = state?.thinkingLevel !== undefined && choice.thinkingLevels.includes(state.thinkingLevel)
          ? state.thinkingLevel
          : fallbackThinkingLevel(choice);
        return { models: choices.map(publicChoice), selected: publicSelection(choice, level) };
      },
      async selectModel(sessionKey, selection, ctx) {
        if (!isModelSelection(selection)) throw new Error("Model selection requires provider and modelId strings");
        const target = choicesByConfigured.get(modelKey(selection));
        if (!target) throw new Error("Model is not in the configured allowlist");
        const requestedLevel = Object.hasOwn(selection, "thinkingLevel") ? selection.thinkingLevel : undefined;
        if (requestedLevel !== undefined && !target.thinkingLevels.includes(requestedLevel)) {
          throw new Error(`Unsupported thinkingLevel ${requestedLevel} for ${selection.provider}/${selection.modelId}`);
        }
        const conversation = await existingConversationFor(sessionKey, ctx);
        const level = await conversation.commit(async (tx) => {
          const state = await tx.doc(AgentDoc, conversation.id);
          const current = choiceFromState(state);
          const live = await tx.doc(LiveDoc, conversation.id);
          if (live.run !== undefined) throw new ConversationBusy(conversation.id);
          const changed = current === undefined || modelKey(current.native) !== modelKey(target.native);
          const currentLevel = current !== undefined && state.thinkingLevel !== undefined && current.thinkingLevels.includes(state.thinkingLevel)
            ? state.thinkingLevel
            : fallbackThinkingLevel(current ?? defaultChoice);
          const nextLevel = requestedLevel ?? (changed
            ? fallbackThinkingLevel(target)
            : target.thinkingLevels.includes(currentLevel) ? currentLevel : fallbackThinkingLevel(target));
          const toolFilter = await toolFilterFor(tx, conversation.id);
          await configure(tx, conversation.id, {
            ...hostPolicy,
            model: target.native,
            thinkingLevel: nextLevel,
            ...toolFilter,
          });
          return nextLevel;
        }, ctx);
        return publicSelection(target, level);
      },
      async listToolGrants(sessionKey, ctx) {
        if (!toolExtension) return [];
        const conversation = await existingConversationFor(sessionKey, ctx);
        const document = await harness!.snapshot(ToolGrantDoc, conversation.id, ctx);
        return document === undefined ? [] : activeToolGrants(document, toolAllowlist, now());
      },
      historyIdentity() {
        return Promise.resolve(storeIdentity);
      },
      async listHistoryEpisodes(sessionKey, query, ctx) {
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeCatalog!.list(conversationId, query, ctx);
      },
      async historyEpisode(sessionKey, startEntryId, ctx) {
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeCatalog!.episode(conversationId, startEntryId as EntryId, ctx);
      },
      async reconcileHistoryEpisodes(sessionKey, ctx) {
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeCatalog!.reconcile(conversationId, ctx);
      },
      async historySearch(query, ctx) {
        return historyIndex!.search(query, ctx);
      },
      async historyEntries(sessionKey, query, limit, cursor, ctx) {
        if (typeof sessionKey !== "string" || sessionKey.length === 0) {
          throw new TypeError("History entry session key must be a non-empty string");
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw new TypeError("History entry page limit must be an integer from 1 to 200");
        }
        if (query === null || typeof query !== "object" || Array.isArray(query)) {
          throw new TypeError("History entry query must be an object");
        }
        const allowed = new Set(["minEntryId", "maxEntryId", "order"]);
        for (const key of Object.keys(query)) {
          if (!allowed.has(key)) throw new TypeError(`History entry query has an unsupported field: ${key}`);
        }
        const minEntryId = query.minEntryId;
        const maxEntryId = query.maxEntryId;
        for (const [name, value] of [["minEntryId", minEntryId], ["maxEntryId", maxEntryId]] as const) {
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
            throw new TypeError(`History entry ${name} must be a positive entry ID`);
          }
        }
        const order = query.order;
        if (order !== undefined && order !== "ascending" && order !== "descending") {
          throw new TypeError("History entry order must be ascending or descending");
        }
        const conversation = await mappedChatConversationFor(sessionKey, ctx);
        const page = await conversation.entries({
          ...(minEntryId === undefined ? {} : { minEntryId }),
          ...(maxEntryId === undefined ? {} : { maxEntryId }),
          ...(order === undefined ? {} : { order }),
        }, limit, cursor, ctx);
        return {
          conversationId: conversation.id,
          sessionKey,
          items: page.items,
          ...(page.next === undefined ? {} : { next: page.next }),
        };
      },
      async refreshContext(sessionKey, ctx) {
        if (!options.contextSnapshotProvider) {
          throw new Error("Context refresh requires a configured contextSnapshotProvider");
        }
        const conversation = await existingConversationFor(sessionKey, ctx);
        return { skills: await refreshContextSnapshot(sessionKey, conversation.id, ctx) };
      },
      async grantTools(sessionKey, grants, ctx) {
        if (!toolExtension) throw new Error("Tools are disabled: toolAllowlist is empty");
        const normalized = normalizeToolGrants(grants, toolAllowlist, now());
        const conversation = await existingConversationFor(sessionKey, ctx);
        return conversation.commit(async (tx) => {
          const document = await tx.doc(ToolGrantDoc, conversation.id);
          for (const grant of normalized) document.grants[grant.name] = grant.expiresAt;
          const timestamp = now();
          await configure(tx, conversation.id, await toolFilterFor(tx, conversation.id));
          return activeToolGrants(document, toolAllowlist, timestamp);
        }, ctx);
      },
      async revokeTools(sessionKey, names, ctx) {
        if (!toolExtension) throw new Error("Tools are disabled: toolAllowlist is empty");
        if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
          throw new TypeError("Tool revocations must be an array of non-empty tool names");
        }
        const conversation = await existingConversationFor(sessionKey, ctx);
        return conversation.commit(async (tx) => {
          const document = await tx.doc(ToolGrantDoc, conversation.id);
          for (const name of new Set(names)) delete document.grants[name];
          const timestamp = now();
          await configure(tx, conversation.id, await toolFilterFor(tx, conversation.id));
          return activeToolGrants(document, toolAllowlist, timestamp);
        }, ctx);
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        const cleanup = withoutAbortSignal(ctx);
        // Stop derived background work before the session stops accepting commits.
        episodeCatalog?.close();
        try { await harness!.close(cleanup); }
        finally {
          try { await historyIndex?.close(); }
          finally {
            try { await toolEnvironments?.close(cleanup); }
            finally { await releaseLock(); }
          }
        }
      },
    };
    async function chatConversationIdFor(sessionKey: string, ctx: Context): Promise<ConversationId> {
      return (await mappedChatConversationFor(sessionKey, ctx)).id;
    }
    async function mappedChatConversationFor(sessionKey: string, ctx: Context): Promise<Conversation> {
      // State-only conversations hold channel bookkeeping, not discussion: they are not history.
      if (!isChatSessionKey(sessionKey)) throw new Error("State-only conversations are not chat history");
      const conversation = await existingConversationFor(sessionKey, ctx);
      await assertMappedChatConversations([conversation.id], ctx);
      return conversation;
    }
    async function existingConversationFor(sessionKey: string, ctx: Context): Promise<Conversation> {
      const key = encodedSessionKey(sessionKey);
      const map = await harness!.snapshot(SessionMap, root.id, ctx);
      const id = map && Object.hasOwn(map.sessions, key) ? map.sessions[key] : undefined;
      if (!Number.isSafeInteger(id)) throw new Error("Unknown session key");
      const conversation = await harness!.conversation(id as ConversationId, ctx);
      if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
      return conversation;
    }
    // Scheduling begins only after registry and all persisted conversation policies are ready.
    harness.resume();
    return gateway;
  } catch (error) {
    const cleanup = withoutAbortSignal(context);
    // A failed open must not leave deferred cataloguing attached to a closed session, nor a
    // derived index handle open behind a failed gateway.
    episodeCatalog?.close();
    try {
      if (harness) await harness.close(cleanup);
      else await storage?.close(cleanup);
    } finally {
      try { await historyIndex?.close(); }
      catch { /* a derived index close failure leaves a rebuildable file, not source data */ }
      finally { await toolEnvironments?.close(cleanup).catch(() => undefined); }
      await releaseLock();
    }
    throw error;
  }
}
