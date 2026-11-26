/**
 * Gateway composition root: `openGateway` validates configuration, builds every capability, opens
 * the Durable harness, restores the authority registry and recovers interrupted work before
 * scheduling resumes. Each subsystem lives in its own module; this file only wires them:
 *
 * - `runtime/authority.ts`: the conversation registry and the single extension/tool policy.
 * - `runtime/model-host.ts`: model validation, the live catalog snapshot, selection and reload.
 * - `runtime/context-host.ts`: host prompt snapshots and the skill loader.
 * - `runtime/sessions.ts`: the session map and the shared mapped-chat scope.
 * - `runtime/restore.ts`: reopen restoration of roles, pins and capture bounds.
 * - `runtime/cron-host.ts`: scheduled-run preparation, finalization and the result outbox.
 * - `recovery/startup.ts`, `history/host.ts`, `channels/app-runtime.ts`, `background-status.ts`.
 */
import { resolve } from "node:path";
import { isChordError } from "@earendil-works/chord";
import { processLock } from "@earendil-works/chord/node";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  createRegistry,
  Harness,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Extension,
  type Harness as HarnessType,
  type Report,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS } from "./context/index.js";
import { createProactiveMemoryExtension } from "./context/proactive-memory.js";
import { SKILL_TOOL_NAME } from "./context/skill-tool.js";
import { CRON_TOOL_NAME } from "./automation/cron-tool.js";
import { createMemoryTools } from "./memory/tools.js";
import { MEMORY_TOOL_NAMES, type MemoryService } from "./memory/contracts.js";
import { TELEGRAM_TOOL_NAME, createTelegramActionRegistry, createTelegramTool } from "./channels/telegram-tool.js";
import { DISCORD_HISTORY_TOOL_NAME, createDiscordHistoryRegistry, createDiscordHistoryTool } from "./channels/discord-history.js";
import { APP_TOOL_NAME, createAppActionRegistry, createAppTool } from "./channels/app-tool.js";
import { APP_CHAT_SESSION_KEY } from "./channels/app.js";
import {
  AppThreadCapacityError,
  appForkAdmissible,
  archivedAppSessionKeys,
  createAppConsoleRegistry,
  createAppTaskRuntime,
  createAppThreadRuntime,
  snapshotSlotsUsed,
} from "./channels/app-runtime.js";
import { ASK_USER_TOOL_NAME, createAskSurfaceRegistry, createAskUserTool } from "./questions/index.js";
import { encodedSessionKey, chatScopeMessage, isChatSessionKey } from "./history/scope.js";
import { parseToolTimeoutSeconds, type PortConfig } from "./config.js";
import { createVisionHandoffExtension } from "./media/vision-hook.js";
import type { ModelReference } from "./config.js";
import { startGatewayIdleRollover, appendIdleRolloverReset, type IdleRollover } from "./history/idle-rollover.js";
import { recoverStartupInterruptions } from "./recovery/startup.js";
import { prepareDataDirectory, inside } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import { reportFailure } from "./failure-diagnostics.js";
import { journalTelemetry } from "./observability.js";
import { emptyBackgroundStatus, readActiveWork, readBackgroundStatus } from "./background-status.js";
import {
  createMcpAdmin,
  createMcpIntegration,
  createMcpSurfaceRegistry,
  mcpHasEnabledServers,
  MCP_ADMIN_TOOL_NAME,
  type McpAdmin,
  type McpConfig,
  type McpIntegration,
} from "./mcp/index.js";
import {
  CLASSIFIER_MODEL_TOOL_NAME,
  CODEMODE_TOOL_NAME,
  createCodeModeIntegration,
  TOOL_SEARCH_TOOL_NAME,
  type CodeModeIntegration,
} from "./extensions/codemode.js";
import { WORKER_TASK_NAME, createWorkerFoundation, type WorkerFoundation } from "./workers/worker-task.js";
import { createWorkerTool, WORKER_TOOL_NAME } from "./workers/tool.js";
import { WORKER_LIMITS } from "./workers/limits.js";
import { createWorkerWorkspace, type WorkerWorkspace } from "./workers/workspace.js";
import type { DigestSource } from "./history/digestion.js";
import { DIGEST_RUN_LIMITS_DEFAULT, type DigestRunLimits } from "./history/digest-limits.js";
import { createMemoryDigest, createMemoryDigestScopeExtension, memoryDigestCurationTools, type MemoryDigest } from "./history/memory-digest.js";
import { createEpisodeSummaryPass, openHistoryHost, type HistoryHost, type HistoryHostParts } from "./history/host.js";
import { extractAssistantText } from "./tasks/background.js";
import {
  CODING_TOOL_NAMES,
  ConfigToolCaptureDoc,
  createCodingToolExtension,
  createToolEnvironments,
  type CodingToolName,
  type ToolEnvironments,
} from "./tools/index.js";
import { BraveSearchClient, PublicWebFetcher, WEB_TOOL_NAMES, createWebToolExtension } from "./web/index.js";
import { ConversationRegistry, createAuthorityPolicy, createCommitEffects } from "./runtime/authority.js";
import { createContextHost } from "./runtime/context-host.js";
import { createCronHost, createCronOutbox } from "./runtime/cron-host.js";
import { createModelHost, resolveBackgroundModels, resolveStartupModels } from "./runtime/model-host.js";
import { restoreAuthority } from "./runtime/restore.js";
import { createSessionScope, SessionMap } from "./runtime/sessions.js";
import { createWorkerEnvironmentPool } from "./runtime/worker-environments.js";
import type { Gateway, OpenGatewayOptions } from "./runtime/types.js";

export type * from "./runtime/types.js";

export async function openGateway(config: PortConfig, context: Context, options: OpenGatewayOptions = {}): Promise<Gateway> {
  // A config name is not a Durable registration identity or an authorization grant. Only the four
  // native coding tools have reviewed registrations; anything else fails closed before setup.
  const toolAllowlist = config.toolAllowlist ?? [];
  const unavailableTools = toolAllowlist.filter((name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name));
  if (unavailableTools.length > 0) {
    throw new StartupDiagnosticError("configInvalid", {
      detail: `toolAllowlist names unsupported tools: ${unavailableTools.join(", ")} (no approved registered tools)`,
    });
  }
  const workersConfig = config.workers;
  const workersEnabled = workersConfig?.enabled === true;
  const workerCodingTools = workersEnabled
    ? (workersConfig.toolAllowlist ?? toolAllowlist).filter((name) => (CODING_TOOL_NAMES as readonly string[]).includes(name))
    : [];
  const registeredCodingTools = [...new Set([...toolAllowlist, ...workerCodingTools])];
  const toolsEnabled = registeredCodingTools.length > 0;
  // MCP is a separate, explicit connection authority. Connecting starts external clients, so the
  // config switch must be on and at least one server enabled; otherwise no client is created.
  const mcpConfig = config.mcp;
  let liveMcpConfig: McpConfig | undefined = mcpConfig;
  const mcpConfigured = mcpHasEnabledServers(mcpConfig);
  const mcpSurfaces = config.configFile === undefined ? undefined : createMcpSurfaceRegistry();
  // Owner-question delivery is a channel-neutral capability, not a coding tool: mapped chats are
  // offered `ask_user`, and a live terminal or channel surface attaches the exact session it owns.
  const askSurfaces = createAskSurfaceRegistry();
  // Native Code Mode composes whatever tools the current conversation already holds. It is
  // independently enableable with `codemode.enabled`; when that block is absent the legacy rule
  // still ties it to configured MCP, and an explicit `false` disables it either way.
  const codeModeConfig = config.codemode;
  const codeModeEnabled = codeModeConfig === undefined ? mcpConfigured : codeModeConfig.enabled;
  // Late-bound integrations: the policy delegates to hooks installed later or replaced live, and an
  // absent integration means its names are blocked instead.
  const mcpRef: { current: McpIntegration | undefined } = { current: undefined };
  const codeModeRef: { current: CodeModeIntegration | undefined } = { current: undefined };
  // Direct MCP management needs an on-disk configuration file to write; an SDK host that supplies
  // an object keeps the read-only `gateway.mcp` status and no write surface.
  const mcpAdminRef: { current: McpAdmin | undefined } = { current: undefined };
  const mcpActivationRef: { current: ((next: McpConfig) => Promise<void>) | undefined } = { current: undefined };
  // Internal scheduling is opt-in and independent of the coding-tool ceiling.
  const cronEnabled = config.cron?.enabled === true;
  // A completed background result is queued only for an origin session of a channel enabled in this
  // configuration, so no later enable can deliver a stale result through a channel switched off.
  const cronDeliveryPrefixes: readonly string[] = [
    ...(config.telegram === undefined ? [] : ["telegram:"]),
    ...(config.discord === undefined ? [] : ["discord:"]),
    ...(config.app === undefined ? [] : ["app:"]),
  ];
  // Fail at startup, not at the first tool call, when the default cannot be represented by the host shell.
  const toolTimeoutSeconds = parseToolTimeoutSeconds(config.toolTimeoutSeconds);
  const startupModels = await resolveStartupModels(config, options, context);
  const classifierGrant = startupModels.classifierGrant;
  const classifierGrantKey = classifierGrant === undefined ? undefined : JSON.stringify([classifierGrant.provider, classifierGrant.modelId]);
  if (options.contextSnapshotProvider !== undefined && typeof options.contextSnapshotProvider !== "function") {
    throw new TypeError("contextSnapshotProvider must be a function");
  }
  if (options.agentHistory !== undefined && typeof options.agentHistory !== "boolean") {
    throw new TypeError("agentHistory must be a boolean");
  }
  const background = resolveBackgroundModels(config, options, startupModels);
  const { digestChoice, workerPreset, visionHandoff, configuredSummary, episodeSummaryModel } = background;
  let preparedDataDirectory: Awaited<ReturnType<typeof prepareDataDirectory>>;
  try {
    preparedDataDirectory = await prepareDataDirectory(config);
  } catch (cause) {
    throw new StartupDiagnosticError("workspace", { cause });
  }
  const { workspace, extraRoots, canonicalDataDir, dbPath } = preparedDataDirectory;
  if (startupModels.credentialStoreDir !== undefined && startupModels.credentialStoreDir !== canonicalDataDir) {
    // The configured dataDir changed between credential resolution and validation (for example a
    // symlink appeared). Refuse instead of reading a different store file.
    throw new StartupDiagnosticError("credential", {
      detail: "The configured dataDir changed while startup prepared the credential store",
    });
  }
  // Worker worktrees live beside the store, outside the configured workspace: the owner's checkout is
  // never the parent of a tool root, and only the leaf task checkout is granted to that task.
  let workerWorkspace: WorkerWorkspace | undefined;
  if (workersEnabled) {
    const worktreesRoot = resolve(canonicalDataDir, "worker-worktrees");
    if (inside(worktreesRoot, dbPath) || inside(dbPath, worktreesRoot)) {
      throw new StartupDiagnosticError("workspace", { detail: "worker worktrees must not overlap the SQLite store" });
    }
    try {
      workerWorkspace = createWorkerWorkspace({ repositoryRoot: workspace, worktreesRoot });
    } catch (cause) {
      throw new StartupDiagnosticError("workspace", { cause });
    }
  }
  const hostPolicy: AgentChange = { cwd: workspace };
  const now = () => Date.now();
  // Mirrors the shared policy's config-level default so a host-default timeout reports its duration.
  const defaultTimeoutSeconds = toolTimeoutSeconds ?? 60;
  // Recall is enabled by default for mapped chats and shares the existing explicit history opt-out.
  const historyEnabled = options.agentHistory !== false;
  const modelHost = createModelHost({
    config, startup: startupModels, options, hostPolicy,
    // Models resolved at open for work the configuration file cannot rebuild.
    pinned: () => [
      ...(digestChoice === undefined ? [] : [digestChoice.model]),
      ...(workerPreset === undefined ? [] : [workerPreset.model]),
      ...(configuredSummary === undefined ? [] : [configuredSummary.model]),
      ...(options.episodeSummary === undefined ? [] : [options.episodeSummary]),
    ],
  });
  // Vision handoff is a native generation hook, never a second agent loop; it leaves the transcript
  // and prepared checkpoints untouched. The map pins the model of a live prepared dispatch so
  // recovery cannot silently apply the reset configured preset.
  const preparedGenerationModels = new Map<number, ModelReference>();
  const visionExtension: Extension | undefined = visionHandoff === undefined ? undefined : createVisionHandoffExtension({
    handoff: visionHandoff,
    // Read at each request so a host model reload updates the fallback without rebuilding the hook.
    defaultModel: () => modelHost.state().resolved.defaultChoice.native,
    preparedModel: (taskId) => {
      // Consume the pin for exactly the saved dispatch startup found: a later retry re-prepares from
      // the reset AgentDoc model, so a stale task-lifetime pin would apply the old image policy.
      const key = Number(taskId);
      const model = preparedGenerationModels.get(key);
      if (model !== undefined) preparedGenerationModels.delete(key);
      return model;
    },
  });

  // One registry for every classified conversation; role changes a foundation commit decides are
  // applied only once that commit is stored.
  const registry = new ConversationRegistry();
  const proactiveMemoryExtension = config.workspaceContext?.memory === "proactive" && classifierGrant !== undefined
    ? createProactiveMemoryExtension({
      harness: () => harness!,
      isChat: (id) => registry.isChat(id),
      classifier: classifierGrant,
      workspaceRoot: workspace,
      loadedFiles: config.workspaceContext.memoryFiles,
      historyEnabled,
      ...(config.proactiveMemory === undefined ? {} : { config: config.proactiveMemory }),
    })
    : undefined;
  const effects = createCommitEffects((error) => reportFailure(error, "gateway.observe"));
  const harnessRef: { current?: HarnessType } = {};
  const openHarness = (): HarnessType => {
    if (harnessRef.current === undefined) throw new Error("The runtime is not open");
    return harnessRef.current;
  };
  const sessionKeyFor = (id: ConversationId) => registry.sessionKeyFor(id);

  // Channel capabilities exist only while their channel is configured; each running adapter attaches
  // its live host, and the policy offers each tool only in a mapped chat of that channel.
  const telegramActions = config.telegram === undefined ? undefined : createTelegramActionRegistry();
  const discordHistory = config.discord === undefined ? undefined : createDiscordHistoryRegistry();
  const appConsole = config.app === undefined ? undefined : createAppConsoleRegistry();
  const appActions = config.app === undefined ? undefined : createAppActionRegistry();
  const telegramTool = telegramActions === undefined ? undefined : createTelegramTool({
    registry: telegramActions,
    sessionKeyFor,
    // Outbound workspace files need two explicit operator decisions: the `media` opt-in and the
    // configured `read` coding tool. Neither is implied by configuring Telegram alone.
    fileSend: config.media !== undefined && toolAllowlist.includes("read"),
  });
  const appTool = appActions === undefined || config.media === undefined
    ? undefined : createAppTool({ registry: appActions, sessionKeyFor });
  const discordHistoryTool = discordHistory === undefined
    ? undefined : createDiscordHistoryTool({ registry: discordHistory, sessionKeyFor });
  const askUserTool = createAskUserTool({
    surfaces: askSurfaces, sessionKeyFor, isAuthorizedChat: (id) => registry.isChat(id),
  });
  // Native public web tools carry network authority only: never named by `toolAllowlist`, offered
  // solely in mapped chats (and captured by workers). An absent search key fails startup.
  let webTool: { readonly extension: Extension } | undefined;
  const webConfig = config.web;
  if (webConfig !== undefined && (webConfig.search !== undefined || webConfig.fetch === true)) {
    let search: BraveSearchClient | undefined;
    if (webConfig.search !== undefined) {
      const env = options.web?.env ?? process.env;
      const key = Object.hasOwn(env, webConfig.search.keyEnv) ? env[webConfig.search.keyEnv] : undefined;
      if (typeof key !== "string" || key.trim() === "") {
        throw new StartupDiagnosticError("webCredential", {
          detail: "Missing credential: set the environment variable named by web.search.keyEnv",
        });
      }
      search = new BraveSearchClient({
        apiKey: key.trim(),
        ...(options.web?.searchTransport === undefined ? {} : { transport: options.web.searchTransport }),
      });
    }
    const fetcher = webConfig.fetch === true
      ? new PublicWebFetcher({
          ...(options.web?.resolver === undefined ? {} : { resolver: options.web.resolver }),
          ...(options.web?.fetchTransport === undefined ? {} : { transport: options.web.fetchTransport }),
          ...(options.web?.now === undefined ? {} : { now: options.web.now }),
        })
      : undefined;
    webTool = createWebToolExtension({
      ...(search === undefined ? {} : { search }),
      ...(fetcher === undefined ? {} : { fetcher }),
      isAuthorizedChat: (id) => registry.isChat(id) || registry.isWorker(id),
    });
  }
  const contextHost = createContextHost({
    provider: options.contextSnapshotProvider, now, isMapped: (id) => registry.isMapped(id), effects,
  });
  const skillTool = contextHost.skillTool;
  const toolExtension: Extension | undefined = toolsEnabled
    ? createCodingToolExtension({
        tools: registeredCodingTools as readonly CodingToolName[],
        ceiling: toolAllowlist,
        capturedCeiling: (id) =>
          registry.isWorker(id) ? workerCodingTools
            : registry.isScheduledRun(id) ? toolAllowlist
              : registry.isDigest(id) ? memoryDigestCurationTools(toolAllowlist)
                : [],
        // Capabilities with their own call-time scope hooks are exempt from the coding ceiling, each
        // only while its gated extension is actually installed.
        contextTools: [
          ...(skillTool === undefined ? [] : [SKILL_TOOL_NAME]),
          ...(cronEnabled ? [CRON_TOOL_NAME] : []),
          ...(workersEnabled ? [WORKER_TOOL_NAME] : []),
          ...(telegramTool === undefined ? [] : [TELEGRAM_TOOL_NAME]),
          ...(appTool === undefined ? [] : [APP_TOOL_NAME]),
          ...(discordHistoryTool === undefined ? [] : [DISCORD_HISTORY_TOOL_NAME]),
          ...(config.configFile === undefined ? [] : [MCP_ADMIN_TOOL_NAME]),
          ASK_USER_TOOL_NAME,
          ...(historyEnabled ? [...MEMORY_TOOL_NAMES] : []),
          ...(webTool === undefined ? [] : WEB_TOOL_NAMES),
        ],
        defaultTimeoutSeconds,
        authenticatedChat: (id: ConversationId) => registry.isChat(id),
        // Code Mode/tool-search and MCP names are delegated to their own installed hooks; each
        // predicate is false unless that hook is installed, so a stale selection is no authority.
        delegatedTools: (name: string) =>
          (codeModeRef.current !== undefined
            && (name === CODEMODE_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME || name === CLASSIFIER_MODEL_TOOL_NAME))
          || (mcpRef.current !== undefined && mcpRef.current.ownsTool(name)),
      })
    : undefined;
  const environmentOptions = {
    sandbox: config.toolSandbox ?? "host",
    ...(config.bwrapPath === undefined ? {} : { bwrapPath: config.bwrapPath }),
    ...(toolTimeoutSeconds === undefined ? {} : { timeoutSeconds: toolTimeoutSeconds }),
  } as const;
  const toolEnvironments: ToolEnvironments | undefined = toolsEnabled
    ? createToolEnvironments({
        workspaceRoot: workspace,
        allowedRoots: extraRoots,
        restrictToWorkspace: config.restrictToWorkspace !== false,
        protectedRoots: [canonicalDataDir],
        ...environmentOptions,
      })
    : undefined;
  // A worktree worker's declared cwd and filesystem guard are its own checkout; that root is never
  // added to the configured roots, so the two workspaces cannot read through each other.
  const cleanupContext = withoutAbortSignal(context);
  const workerEnvironments = createWorkerEnvironmentPool((root) => createToolEnvironments({
    workspaceRoot: root,
    allowedRoots: [],
    // Shared workers inherit host access; explicit worktree workers remain checkout-scoped.
    restrictToWorkspace: root !== workspace || config.restrictToWorkspace !== false,
    // Worktrees are already confined to their own checkout; do not deny that checkout itself.
    protectedRoots: root === workspace ? [canonicalDataDir] : [],
    ...environmentOptions,
  }), (error) => reportFailure(error, "gateway.close.runtime"));
  const environmentFor = (id: ConversationId, ctx: Context) => {
    const root = registry.workerRoot(id);
    return root === undefined ? toolEnvironments!.forConversation(id, ctx) : workerEnvironments.forConversation(root, id, ctx);
  };
  const digestLimits: DigestRunLimits = Object.freeze({
    ...DIGEST_RUN_LIMITS_DEFAULT,
    ...(config.digest?.entriesPerBatch === undefined ? {} : { entriesPerBatch: config.digest.entriesPerBatch }),
    ...(config.digest?.charsPerBatch === undefined ? {} : { charsPerBatch: config.digest.charsPerBatch }),
    ...(config.digest?.maxToolCalls === undefined ? {} : { maxToolCalls: config.digest.maxToolCalls }),
    ...(config.digest?.maxRequests === undefined ? {} : { maxRequests: config.digest.maxRequests }),
    ...(config.digest?.maxInputTokens === undefined ? {} : { maxInputTokens: config.digest.maxInputTokens }),
    ...(config.digest?.maxChangedFiles === undefined ? {} : { maxChangedFiles: config.digest.maxChangedFiles }),
    ...(config.digest?.maxDiffChars === undefined ? {} : { maxDiffChars: config.digest.maxDiffChars }),
    // A product-configured run deadline wins over the host test seam.
    runTimeoutMs: config.digest?.runTimeoutSeconds !== undefined
      ? config.digest.runTimeoutSeconds * 1000
      : options.memoryDigest?.turnTimeoutMs ?? DIGEST_RUN_LIMITS_DEFAULT.runTimeoutMs,
  });
  // The digest scope hook reads each live target's accepted bounds at call time, so a later open's
  // config cannot widen an already-started run.
  const digestScopeExtension = createMemoryDigestScopeExtension(workspace, {
    harness: openHarness,
    limitsFor: (id) => registry.digestLimits(id),
  });
  const digestSourceRef: { current: DigestSource | undefined } = { current: undefined };
  // Approved recall tools are registered before open and late-bind to the gateway-owned service.
  const memoryServiceRef: { current: MemoryService | undefined } = { current: undefined };
  const memoryTools = historyEnabled ? createMemoryTools({
    service: () => memoryServiceRef.current,
    caller: (id) => registry.isChat(id) || registry.isWorker(id) || registry.isScheduledRun(id),
  }) : undefined;
  const toolRegistrations = new Map<string, ToolRegistration>(
    [...(toolExtension?.tools ?? []), ...(webTool?.extension.tools ?? []), ...(memoryTools?.extension.tools ?? []),
      ...(skillTool?.extension.tools ?? [])].map((tool) => [tool.name, tool]),
  );
  const authority = createAuthorityPolicy({
    registry,
    toolAllowlist,
    workersEnabled,
    workerCodingTools,
    workerToolAllowlist: workersConfig?.toolAllowlist,
    historyEnabled,
    classifierGrantKey,
    toolRegistrations,
    capabilities: {
      ...(visionExtension === undefined ? {} : { vision: visionExtension }),
      ...(proactiveMemoryExtension === undefined ? {} : { proactiveMemory: proactiveMemoryExtension }),
      ...(toolExtension === undefined ? {} : { coding: toolExtension }),
      askUser: askUserTool,
      ...(webTool === undefined ? {} : { web: webTool }),
      ...(memoryTools === undefined ? {} : { memory: memoryTools }),
      ...(telegramTool === undefined ? {} : { telegram: telegramTool }),
      ...(appTool === undefined ? {} : { app: appTool }),
      ...(discordHistoryTool === undefined ? {} : { discordHistory: discordHistoryTool }),
      ...(skillTool === undefined ? {} : { skill: skillTool }),
      digestScope: digestScopeExtension,
      live: {
        mcp: () => mcpRef.current,
        codeMode: () => codeModeRef.current,
        mcpAdmin: () => mcpAdminRef.current,
        cron: () => cronHost === undefined ? undefined : { foundation: cronHost.foundation.extension, tool: cronHost.tool },
        worker: () => workerTool,
      },
    },
    context: {
      extension: contextHost.extension,
      extensionRef: contextHost.extensionRef,
      has: contextHost.has,
      hasSkills: contextHost.hasSkills,
    },
  });
  const { extensionsPolicy, toolFilterFor } = authority;
  const memoryDigestRef: { current?: MemoryDigest } = {};
  // The gateway object is built after this host, so the app Main resolver is late-bound: a scheduled
  // job created in an app side thread re-homes to Main, whose conversation only the gateway's own
  // mapped-chat admission can resolve.
  const appMainRef: { current?: (context: Context) => Promise<Conversation | undefined> } = {};
  const cronHost = cronEnabled ? createCronHost({
    now,
    ownerSteering: config.followUpMode === "steer",
    timeZone: config.cron?.timeZone,
    workspace,
    toolAllowlist,
    digestConfigured: digestChoice !== undefined,
    deliveryPrefixes: cronDeliveryPrefixes,
    authority,
    effects,
    contextHost,
    harness: openHarness,
    memoryDigest: () => memoryDigestRef.current!,
    // A scheduled job created from an app side thread re-homes to Main: side threads are short-lived
    // and scheduled results belong in the chat that outlives them.
    ...(config.app === undefined ? {} : {
      appMainConversation: (ctx: Context) => appMainRef.current?.(ctx) ?? Promise.resolve(undefined),
    }),
  }) : undefined;
  // Bounded ordinary background workers. The foundation owns the Durable task, its child conversation
  // and the internal result event; the host supplies capture, model, workspace and retirement. A
  // worker is never an origin: its target is task-owned and carries captured tools only.
  const workerFoundation: WorkerFoundation | undefined = workersEnabled && workerWorkspace !== undefined
    ? createWorkerFoundation({
        now,
        maxConcurrent: workersConfig?.maxConcurrent ?? WORKER_LIMITS.defaultConcurrent,
        allowModel: modelHost.allowModel,
        spawnModel: async (tx, conversationId) => {
          const { choice, level } = modelHost.selectionOf(await tx.doc(AgentDoc, conversationId));
          return { model: choice.native, thinkingLevel: level };
        },
        ...(workerPreset === undefined ? {} : { preset: workerPreset }),
        workspace: workerWorkspace,
        prepare: async ({ tx, spawnerConversationId, targetConversationId: target, input, workspace: targetWorkspace, ctx }) => {
          // The worker starts default-deny. Its capture is the independent worker ceiling of an
          // authorized spawning chat, plus the snapshot path a scheduled run uses; snapshot delivery
          // cannot add a skill tool the worker configuration withheld.
          const spawnerKey = registry.sessionKeyFor(spawnerConversationId);
          const contextState = spawnerKey === undefined
            ? undefined
            : await contextHost.install(spawnerKey, target, ctx, true, tx);
          const skillsInstalled = contextState?.hasSkills === true;
          const captured = await authority.writeCapture(tx, target, spawnerConversationId,
            authority.captureFor("worker", spawnerConversationId).filter((name) => skillsInstalled || name !== SKILL_TOOL_NAME));
          await authority.configureCaptured(tx, target, {
            kind: "worker", workspaceRoot: targetWorkspace.mode === "worktree" ? targetWorkspace.path : undefined,
          }, {
            cwd: targetWorkspace.path,
            model: input.model,
            // The captured level may predate a provider catalog change; the current catalog wins.
            thinkingLevel: modelHost.pinnedThinkingLevel(input.model, input.thinkingLevel, "default"),
          }, captured, contextState);
        },
        finalize: async ({ tx, targetConversationId: target, settlement }) => {
          // A worker's captured authority, Code Mode selection included, ends in the same terminal
          // commit that records its outcome. Once stored, its checkout's tool environments close
          // when no other live worker still uses that checkout.
          await authority.retireCaptured(tx, target);
          await effects.defer(tx, () => {
            const root = registry.releaseWorker(target);
            if (root !== undefined && !registry.workerRootInUse(root)) workerEnvironments.release(root, cleanupContext);
          });
          if (settlement.status !== "ok" || settlement.answerEntryId === null) return { result: null, error: settlement.error };
          const body = extractAssistantText(await tx.entry(AssistantEntry, settlement.answerEntryId as EntryId)).trim();
          return { result: body === "" ? null : body, error: null };
        },
        // Called by the foundation only after the prepared target is durable.
        trackWorkspace: (id, info) => registry.trackWorker(id, info.mode === "worktree" ? info.path : undefined),
        commit: (change, ctx) => openHarness().commit(change, ctx),
      })
    : undefined;
  const workerTool = workerFoundation === undefined ? undefined : createWorkerTool({
    foundation: workerFoundation,
    spawnerFor: (id) => registry.isWorkerSpawner(id),
    harness: openHarness,
    precheckWorktree: () => workerWorkspace!.precheck(),
  });
  /**
   * Bounded conversation-to-memory digestion. Registered even when no host will start it so a task
   * persisted by an earlier open can resume, but otherwise inert: `start` is the only entry. Its
   * target holds only the origin's curated Markdown subset and the curation-scope hook.
   */
  const memoryDigest: MemoryDigest = createMemoryDigest({
    harness: openHarness,
    source: () => {
      if (digestSourceRef.current === undefined) throw new Error("The digest source is not open");
      return digestSourceRef.current;
    },
    workspaceRoot: workspace,
    now,
    scopeExtension: digestScopeExtension,
    limits: digestLimits,
    episodesPerRun: config.digest?.episodesPerRun ?? 1,
    // Explicit background selection only: never the origin conversation's current model or thinking.
    model: async () => digestChoice,
    allowModel: modelHost.allowModel,
    modelContext: (candidate) => modelHost.state().resolved.choicesByNative.get(JSON.stringify([candidate.provider, candidate.modelId]))?.model,
    curationTools: (id) => authority.captureFor("digest", id),
    prepare: async ({ tx, originConversationId, targetConversationId: target, input }) => {
      const captured = await authority.writeCapture(tx, target, originConversationId, authority.captureFor("digest", originConversationId));
      await authority.configureCaptured(tx, target, { kind: "digest", limits: input.limits }, {
        cwd: workspace,
        model: input.model,
        thinkingLevel: modelHost.pinnedThinkingLevel(input.model, input.thinkingLevel as ModelThinkingLevel, "lowest"),
      }, captured);
      await effects.defer(tx, () => registry.beginDigest(target, input.limits));
    },
    finalize: async ({ tx, targetConversationId: target }) => {
      // The curation hook and the capture end in the same terminal commit that records the outcome.
      await authority.retireCaptured(tx, target);
      await effects.defer(tx, () => registry.endDigest(target));
    },
  });
  memoryDigestRef.current = memoryDigest;

  async function applyConversationPolicy(conversation: Conversation, ctx: Context): Promise<void> {
    await conversation.commit(async (tx) => {
      const toolFilter = await toolFilterFor(tx, conversation.id);
      await configure(tx, conversation.id, {
        ...modelHost.policyForState(await tx.doc(AgentDoc, conversation.id)),
        ...extensionsPolicy(conversation.id),
        ...toolFilter,
      });
    }, ctx);
  }
  /**
   * Reapply tool and extension policy after a live MCP change. Authenticated chats may gain the new
   * registration; existing workers and scheduled runs keep their pinned model and are pruned against
   * their durable captures, never widened by it.
   */
  async function refreshMcpConversationPolicy(): Promise<void> {
    const open = harnessRef.current;
    if (open === undefined) return;
    let failure: unknown;
    for (const id of new Set([...registry.chats(), ...registry.workers(), ...registry.scheduledRuns()])) {
      try {
        const conversation = await open.conversation(id, context);
        if (conversation === undefined) continue;
        if (registry.isChat(id)) {
          await applyConversationPolicy(conversation, context);
          continue;
        }
        await conversation.commit(async (tx) => {
          // Read the durable capture first to fence against finalization on this conversation,
          // then verify the capture is still live and the background role has not retired.
          const capture = await tx.doc(ConfigToolCaptureDoc, id);
          if (capture.originConversationId === null || (!registry.isWorker(id) && !registry.isScheduledRun(id))) return;
          const toolFilter = await toolFilterFor(tx, id, new Set(capture.tools));
          await configure(tx, id, { ...extensionsPolicy(id), ...toolFilter });
        }, context);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  let releaseLock: Awaited<ReturnType<typeof processLock>>;
  try {
    releaseLock = await processLock(`nanobot:${dbPath}`);
  } catch (cause) {
    // A known live owner is actionable and its raw lock name contains the database path.
    if (isChordError(cause) && cause.reason === "locked") throw new StartupDiagnosticError("storeLocked", { cause });
    reportFailure(cause, "gateway.lock");
    throw cause;
  }
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let idleRollover: IdleRollover | undefined;
  const historyParts: HistoryHostParts = {};
  let closed = false;
  try {
    const sessionScopeRef: { current?: ReturnType<typeof createSessionScope> } = {};
    const episodeSummaries = createEpisodeSummaryPass({
      model: episodeSummaryModel,
      useConversationModel: background.useConversationSummaryModel,
      includeOpenAtActivation: options.episodeSummary === undefined,
      now,
      conversationModel: (agent) => modelHost.selectionOf(agent).choice.native,
      allowModel: modelHost.allowModel,
      // Backstop: a job whose conversation is not chat scope never reaches a provider call.
      scope: (tx, id) => sessionScopeRef.current!.chatScopeById(tx, id),
      catalog: () => historyParts.episodeCatalog!,
    });
    // MCP connects before the registry is built so every discovered tool is in the initial registry.
    // A failed server contributes nothing and is reported through `gateway.mcp`. OAuth grants live
    // under the canonical data directory beside the private credential store (see MCP.md).
    const mcpDataDir = startupModels.credentialStoreDir ?? config.dataDir;
    const mcpIntegration = (next: McpConfig) => createMcpIntegration({
      config: next,
      workspace,
      dataDir: mcpDataDir,
      // A live scheduled run's captured MCP tools stay callable for that run; the exact per-tool
      // grant is checked against its durable capture by the run-capability hook.
      isAuthorizedChat: (id: ConversationId) => registry.isChat(id) || registry.isWorker(id) || registry.isScheduledRun(id),
      delegatedToolNames: [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME],
    });
    const codeModeIntegration = (namespaces: McpIntegration["namespaces"]) => createCodeModeIntegration({
      namespaces,
      // Native `models.*`: only the one configured classifier model plus read-only catalog helpers.
      models: true,
      ...(classifierGrant === undefined ? {} : { classifierModel: classifierGrant }),
      // A live worker child may compose its captured tools; every nested call still passes that
      // tool's own call-time hook, so retirement or a narrowed ceiling denies stale composition.
      isAuthorizedChat: (id: ConversationId) => registry.isChat(id) || registry.isWorker(id),
    });
    let registeredMcpToolNames = new Set<string>();
    const replaceMcpRegistrations = (integration: McpIntegration): void => {
      for (const name of registeredMcpToolNames) toolRegistrations.delete(name);
      registeredMcpToolNames = new Set(integration.toolNames);
      for (const tool of integration.extension.tools ?? []) {
        if (registeredMcpToolNames.has(tool.name)) toolRegistrations.set(tool.name, tool);
      }
    };
    if (mcpConfigured && mcpConfig !== undefined) {
      mcpRef.current = await mcpIntegration(mcpConfig);
      replaceMcpRegistrations(mcpRef.current);
    }
    // Direct MCP management is performed by the model tool for authenticated mapped chats; this host
    // object only exposes bounded status and consumes callback-shaped ingress before model admission.
    if (config.configFile !== undefined && mcpSurfaces !== undefined) {
      mcpAdminRef.current = createMcpAdmin({
        edit: { configFile: config.configFile, workspace },
        dataDir: mcpDataDir,
        context,
        config: () => liveMcpConfig,
        applyConfig: (next) => {
          const activate = mcpActivationRef.current;
          if (activate === undefined) throw new Error("MCP live activation is not ready");
          return activate(next);
        },
        reconnect: async (name) => {
          const integration = mcpRef.current;
          if (integration === undefined) return;
          await integration.reconnect(name);
          replaceMcpRegistrations(integration);
          registry_.install(integration.extension);
          codeModeRef.current?.updateNamespaces(integration.namespaces);
          await refreshMcpConversationPolicy();
        },
        servers: () => mcpRef.current?.status ?? [],
        sessionKeyFor,
        surfaces: mcpSurfaces,
        isAuthorizedChat: (id: ConversationId) => registry.isChat(id),
      } as Parameters<typeof createMcpAdmin>[0]);
      for (const tool of mcpAdminRef.current.extension.tools ?? []) toolRegistrations.set(tool.name, tool);
    }
    // Code Mode is an independent compositor, not an MCP wrapper: it gets MCP namespaces only from a
    // connected integration, and without MCP it composes the conversation's other tools.
    if (codeModeEnabled) {
      codeModeRef.current = codeModeIntegration(mcpRef.current?.namespaces ?? []);
      for (const extension of codeModeRef.current.extensions) {
        for (const tool of extension.tools ?? []) toolRegistrations.set(tool.name, tool);
      }
    }
    const registry_ = createRegistry();
    for (const extension of [
      episodeSummaries?.extension, proactiveMemoryExtension, visionExtension, toolExtension, mcpRef.current?.extension,
      mcpAdminRef.current?.extension, ...(codeModeRef.current?.extensions ?? []), skillTool?.extension,
      memoryTools?.extension, telegramTool?.extension, appTool?.extension, askUserTool.extension,
      discordHistoryTool?.extension, webTool?.extension, cronHost?.foundation.extension, cronHost?.tool.extension,
      workerFoundation?.extension, workerTool?.extension, authority.workerCapabilityExtension,
      authority.scheduledRunCapabilityExtension, memoryDigest.extension, digestScopeExtension,
    ]) {
      if (extension !== undefined) registry_.install(extension);
    }
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    harness = await Harness.open(storage, {
      // Consume the whole pending steering burst at each native boundary, including worker steers.
      settings: { steeringMode: "all" as const },
      // A host reload swaps this catalog without reopening the Harness; every generation,
      // compaction, hook and tool resolves the current one at each use.
      models: () => modelHost.state().models,
      registry: registry_,
      telemetry: journalTelemetry,
      // Durable reports asynchronous storage, scheduler, hook and listener failures here even when no
      // public operation throws. Record the original cause before it is otherwise lost.
      onReport: (report: Report) => reportFailure(report.error, `durable.${report.kind}`,
        "task" in report && report.task !== undefined ? Number(report.task.id) : undefined, {
          reason: "reason" in report ? report.reason : undefined,
          restarts: "restarts" in report ? report.restarts : undefined,
        }),
      conversationCreated: authority.denyNewConversation,
      ...(toolEnvironments === undefined ? {} : {
        env: (target: { readonly conversationId: ConversationId }, ctx: Context) => environmentFor(target.conversationId, ctx),
      }),
    }, context);
    harnessRef.current = harness;
    const openedHarness = harness;
    // Deferred registry effects are applied from stored commits; nothing defers before resume.
    effects.observe(openedHarness);
    mcpActivationRef.current = async (next) => {
      let integration = mcpRef.current;
      if (integration === undefined) {
        if (!mcpHasEnabledServers(next)) {
          liveMcpConfig = next;
          return;
        }
        integration = await mcpIntegration(next);
        mcpRef.current = integration;
      } else {
        await integration.applyConfig(next);
      }
      registry_.install(integration.extension);
      replaceMcpRegistrations(integration);
      liveMcpConfig = next;
      // Legacy Code Mode follows MCP when its own block is absent. A live first server therefore
      // installs it without a restart; an explicit `codemode.enabled: false` stays the owner's choice.
      if (codeModeRef.current === undefined && codeModeConfig === undefined && mcpHasEnabledServers(next)) {
        codeModeRef.current = codeModeIntegration(integration.namespaces);
        for (const extension of codeModeRef.current.extensions) {
          registry_.install(extension);
          for (const tool of extension.tools ?? []) toolRegistrations.set(tool.name, tool);
        }
      } else if (codeModeConfig === undefined && !mcpHasEnabledServers(next) && codeModeRef.current !== undefined) {
        const retired = codeModeRef.current;
        codeModeRef.current = undefined;
        retired.stopAdmission();
        for (const extension of retired.extensions) {
          registry_.uninstall(extension);
          for (const tool of extension.tools ?? []) toolRegistrations.delete(tool.name);
        }
        // Management may itself be nested in this sandbox. Do not wait for our own execution to
        // exit; admission is closed synchronously and close joins it later.
        void retired.close().catch(() => undefined);
      } else {
        codeModeRef.current?.updateNamespaces(integration.namespaces);
      }
      await refreshMcpConversationPolicy();
    };
    const root = await openedHarness.root(context, { agent: modelHost.state().defaultAgentPolicy });
    const isAutomation = (id: ConversationId) => registry.isAutomation(id);
    const sessions = createSessionScope({
      harness: openedHarness,
      root,
      isAutomation,
      forkAdmissible: (tx, sessionKey, id) => appForkAdmissible(tx, { rootId: root.id, isAutomation }, sessionKey, id),
    });
    sessionScopeRef.current = sessions;
    const { mappedChatSessions, existingConversationFor, mappedConversationId, chatConversationIdFor } = sessions;
    contextHost.bind({
      harness: openedHarness,
      root,
      install: (extension) => registry_.install(extension),
      archivedSessionKeys: (tx) => archivedAppSessionKeys(tx, root.id),
      applyPolicy: async (tx, id, contextOverride) => {
        const toolFilter = await toolFilterFor(tx, id, undefined, undefined, contextOverride);
        await configure(tx, id, { ...extensionsPolicy(id, undefined, contextOverride), ...toolFilter });
      },
    });
    modelHost.bind({
      harness: openedHarness,
      root,
      existingConversationFor,
      mappedConversationId,
      applyConversationPolicy,
      toolFilterFor: (tx, id) => toolFilterFor(tx, id),
      chats: () => registry.chats(),
      liveMcpConfig: () => liveMcpConfig,
    });
    const history: HistoryHost = await openHistoryHost({
      harness: openedHarness,
      root,
      context,
      now,
      dbPath,
      workspace,
      memoryFiles: config.workspaceContext?.memoryFiles ?? [],
      historyEnabled,
      sessions,
      automationSessions: () => registry.automations()
        .map((id) => ({ sessionKey: `cron-automation:${id}`, conversationId: id })),
      digestLimits,
      summaries: episodeSummaries,
      summaryBackfill: episodeSummaryModel?.backfill === "pending",
      authority,
    }, historyParts);
    digestSourceRef.current = history.digestSource;

    // Restore the registry from the store, refuse unsafe prepared replays, recover interrupted
    // turns, and only then apply host policy to every conversation before scheduling resumes.
    const restored = await restoreAuthority({
      harness: openedHarness,
      root,
      context,
      authority,
      models: modelHost,
      contextHost,
      cronEnabled,
      workspace,
      mappedChatSessions,
      chatScopeForSession: sessions.chatScopeForSession,
      archivedSessionKeys: (tx) => archivedAppSessionKeys(tx, root.id),
      ...(visionHandoff === undefined ? {} : {
        pinPreparedGeneration: (taskId: number, model: ModelReference) => preparedGenerationModels.set(taskId, model),
      }),
    });
    await recoverStartupInterruptions({
      harness: openedHarness,
      root,
      context,
      now,
      mappedChatSessions,
      automationOrigin: (id) => registry.automation(id)?.originConversationId,
      backgroundRun: restored.backgroundRun,
    }, restored.preparedContextReplays);
    await restored.applyStartupPolicies();

    const appTasks = createAppTaskRuntime({
      harness: openedHarness,
      mappedConversationId,
      isChat: (id) => registry.isChat(id),
      isWorkerSpawner: (id) => registry.isWorkerSpawner(id),
      cronOwner: (id) => registry.cronOwner(id),
      workerFoundation,
      cronFoundation: cronHost?.foundation,
    });
    const recall = (): MemoryService => {
      const service = memoryServiceRef.current;
      if (!service) throw new Error("Memory recall is unavailable");
      return service;
    };
    const gateway: Gateway = {
      harness: openedHarness,
      ...(config.app === undefined ? {} : createAppThreadRuntime({
        harness: openedHarness,
        root,
        snapshots: contextHost.enabled,
        chatScopeForSession: sessions.chatScopeForSession,
        policyForState: (agent) => modelHost.policyForState(agent),
        conversationFor: (sessionKey, ctx) => gateway.conversationFor(sessionKey, ctx),
        ...(episodeSummaries === undefined ? {} : {
          initializeSummaries: (id: ConversationId, ctx: Context) => episodeSummaries.initialize(openedHarness, id, ctx),
        }),
      })),
      memorySearch: (caller, query, ctx) => recall().search(caller, query, ctx),
      memoryBrowse: (caller, query, ctx) => recall().browse(caller, query, ctx),
      memoryRead: (caller, query, ctx) => recall().read(caller, query, ctx),
      memoryDigest: {
        start: (writer, ctx) => memoryDigest.start(writer, ctx),
        status: (writer, ctx) => memoryDigest.status(writer, ctx),
      },
      cronOutbox: createCronOutbox({ harness: openedHarness, root, now, sessions: mappedChatSessions, chatConversationIdFor }),
      ...(cronHost === undefined ? {} : { cronOperator: cronHost.operator(mappedChatSessions) }),
      ...(telegramActions === undefined ? {} : { telegramActions }),
      ...(discordHistory === undefined ? {} : { discordHistory }),
      ...(appConsole === undefined ? {} : { appConsole }),
      ...(appActions === undefined ? {} : { appActions }),
      // The rollover starts after resume; until then (and without config) there is nothing to decide.
      beforeOwnerInput: async (sessionKey, conversationId, content, ctx) =>
        idleRollover?.beforeOwnerInput(sessionKey, conversationId, content, ctx),
      askSurfaces,
      get mcp() {
        return mcpRef.current === undefined ? undefined : { servers: mcpRef.current.status };
      },
      ...(mcpAdminRef.current === undefined ? {} : {
        mcpAdmin: {
          list: (ctx: Context) => mcpAdminRef.current!.list(ctx),
          submitCallback: (sessionKey: string, text: string, ctx: Context) => mcpAdminRef.current!.submitCallback(sessionKey, text, ctx),
        },
      }),
      ...(mcpSurfaces === undefined ? {} : { mcpSurfaces }),
      async conversationFor(sessionKey, ctx) {
        const key = encodedSessionKey(sessionKey);
        let conversationId: ConversationId | undefined;
        let createdNow: ConversationId | undefined;
        await root.commit(async (tx) => {
          const map = await tx.doc(SessionMap, root.id);
          if (Object.hasOwn(map.sessions, key)) {
            conversationId = map.sessions[key] as ConversationId;
            return;
          }
          if (contextHost.enabled && await snapshotSlotsUsed(tx, root.id) >= CONTEXT_LIMITS.maxConversations) {
            throw new AppThreadCapacityError(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
          }
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          createdNow = created.id;
          const toolFilter = await toolFilterFor(tx, created.id);
          await configure(tx, created.id, {
            ...modelHost.state().defaultAgentPolicy, ...extensionsPolicy(created.id), ...toolFilter,
          });
          map.sessions[key] = created.id as number;
          conversationId = created.id;
        }, ctx);
        if (!Number.isSafeInteger(conversationId)) throw new Error("Stored conversation mapping has an invalid ID");
        const id = conversationId!;
        // The stored map is host data, not authority: a mapped key may name only an ordinary chat
        // conversation — or, under its own exact key, a registered app thread fork — before it can
        // become a cron owner or receive chat policy.
        const scopeReason = await root.commit((tx) => sessions.chatScopeForSession(tx, sessionKey, id), ctx);
        if (scopeReason !== undefined) throw new Error(chatScopeMessage(scopeReason));
        // The exact host-owned session key is what a channel action host revalidates; it is never
        // supplied by the model. Only a chat key becomes a chat; a state key carries no authority.
        if (isChatSessionKey(sessionKey)) registry.admitChat(id, sessionKey);
        else registry.recordSessionKey(id, sessionKey);
        if (createdNow !== undefined && episodeSummaries !== undefined) {
          try {
            await episodeSummaries.initialize(openedHarness, createdNow, ctx);
          } catch {
            // The startup policy pass and the defensive enqueue path both record a missing watermark.
          }
        }
        registry.recordMapped(id, sessionKey);
        const conversation = await openedHarness.conversation(id, ctx);
        if (!conversation) throw new Error("Stored conversation mapping points to a missing conversation");
        await contextHost.ensure(sessionKey, id, ctx);
        // Read and reapply host policy atomically so concurrent selection cannot be overwritten.
        await applyConversationPolicy(conversation, ctx);
        return conversation;
      },
      async backgroundStatus(sessionKey, ctx) {
        const conversation = await existingConversationFor(sessionKey, ctx);
        const id = conversation.id;
        // A conversation that is not an authenticated mapped chat learns nothing and causes no read.
        if (!registry.isChat(id)) return emptyBackgroundStatus();
        const cronOwner = registry.cronOwner(id);
        return readBackgroundStatus({
          harness: openedHarness,
          conversationId: id,
          ...(workerFoundation === undefined || !registry.isWorkerSpawner(id) ? {} : {
            workers: { list: () => workerFoundation.list(openedHarness, id, ctx), taskKind: WORKER_TASK_NAME },
          }),
          ...(cronHost === undefined || cronOwner === undefined ? {} : {
            cron: { list: () => cronHost.foundation.list(openedHarness, id, { owner: cronOwner }, ctx) },
          }),
          digest: {
            status: () => memoryDigest.status({ id, commit: (change, inner) => conversation.commit(change, inner) }, ctx),
          },
        }, ctx);
      },
      activeWork: (ctx) => readActiveWork(openedHarness, ctx),
      appTasks: appTasks.appTasks,
      appTaskCancel: appTasks.appTaskCancel,
      listModels: modelHost.listModels,
      modelPresets: modelHost.modelPresets,
      selectedModel: modelHost.selectedModel,
      selectModel: modelHost.selectModel,
      selectModelPreset: modelHost.selectModelPreset,
      ...(modelHost.reloadModels === undefined ? {} : { reloadModels: modelHost.reloadModels }),
      visionHandoffStats() {
        return visionHandoff === undefined
          ? {
              enabled: false,
              stats: {
                requests: 0, rawImages: 0, describedImages: 0, unavailableImages: 0,
                describerCalls: 0, describerFailures: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0,
              },
            }
          : { enabled: true, describer: visionHandoff.describer, stats: visionHandoff.stats() };
      },
      ...history.methods,
      async refreshContext(sessionKey, ctx) {
        if (!contextHost.enabled) throw new Error("Context refresh requires a configured contextSnapshotProvider");
        const conversation = await existingConversationFor(sessionKey, ctx);
        return { skills: await contextHost.refresh(sessionKey, conversation.id, ctx) };
      },
      async resetSession(sessionKey, ctx) {
        // `/new` may be the first message in a chat, so its own mapped conversation is resolved the
        // same way `conversationFor` resolves it (creating only that host-supplied key).
        return contextHost.resetSession(sessionKey, await gateway.conversationFor(sessionKey, ctx), ctx);
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        const cleanup = withoutAbortSignal(ctx);
        let failure: { error: unknown } | undefined;
        const close = async (operation: () => unknown): Promise<void> => {
          try { await operation(); }
          catch (error) {
            failure ??= { error };
            reportFailure(error, "gateway.close.runtime");
          }
        };
        // An MCP login waiting for its browser callback is stopped first: it must not reach a closed
        // Harness, and it must not store a grant while this process is tearing down.
        await close(() => mcpAdminRef.current?.close());
        await close(() => idleRollover?.close());
        // Stop derived background work before the session stops accepting commits.
        await close(() => historyParts.episodeCatalog?.close());
        await close(() => openedHarness.close(cleanup));
        // Code Mode first: it owns sandbox workers that may be calling MCP tools. Then the MCP
        // clients, whose native transports tear down their server process groups.
        await close(() => codeModeRef.current?.close());
        await close(() => mcpRef.current?.close());
        await close(() => memoryServiceRef.current?.close());
        await close(() => historyParts.historyIndex?.close());
        await workerEnvironments.closeAll(close, cleanup);
        await close(() => toolEnvironments?.close(cleanup));
        await close(() => releaseLock());
        if (failure !== undefined) throw failure.error;
      },
    };
    // A later tool call in a side thread can now resolve Main through the ordinary mapped-chat
    // admission, exactly as a Main message would.
    appMainRef.current = (ctx: Context) => gateway.conversationFor(APP_CHAT_SESSION_KEY, ctx);
    await history.settleSummaries(context);
    // Scheduling begins only after the registry and all persisted conversation policies are ready.
    memoryServiceRef.current = history.memoryService;
    openedHarness.resume();
    if (config.idleRollover !== undefined) {
      idleRollover = startGatewayIdleRollover({
        afterMs: config.idleRollover.afterMinutes * 60_000,
        now,
        context,
        harness: openedHarness,
        models: () => modelHost.state().models,
        classifier: classifierGrant!,
        sessions: async (ctx) => (await mappedChatSessions(ctx)).filter((session) => registry.isChat(session.conversationId)),
        quiet: async (ctx) => (await readActiveWork(openedHarness, ctx)).interrupting === 0,
        reset: async (session, reset, ctx) => {
          if (contextHost.enabled) {
            await contextHost.refresh(session.sessionKey, session.conversationId, ctx, reset);
            return;
          }
          const conversation = await openedHarness.conversation(session.conversationId, ctx);
          if (conversation === undefined) return;
          await conversation.commit((tx) => appendIdleRolloverReset(tx, session.conversationId, reset, now()), ctx);
        },
        report: (error) => reportFailure(error, "gateway.idleRollover"),
      });
    }
    // A worker that finished while the process was gone already committed its outcome and retired its
    // authority, but may not have admitted the internal result event. Re-admitting is idempotent by
    // the conversation-scoped request ID, so a crash cannot lose a result or duplicate the turn.
    if (workerFoundation !== undefined) {
      try {
        await workerFoundation.recover(openedHarness, (id) => registry.isWorkerSpawner(id), context);
      } catch {
        // The records stay unnotified; the next open retries the same admission.
      }
    }
    // The same admission guarantee for a terminal failed or cancelled digest run; only currently
    // mapped chat origins are notified, and a successful run is never admitted at all.
    try {
      await memoryDigest.recover(openedHarness, (id) => registry.isChat(id), context);
    } catch {
      // Notices stay open; the next open retries.
    }
    return gateway;
  } catch (error) {
    // Keep the primary Durable/open failure even if cleanup itself throws afterwards.
    reportFailure(error, "gateway.open");
    const cleanup = withoutAbortSignal(context);
    // A failed open must not leave a login, deferred cataloguing or a derived index handle behind.
    const close = async (operation: () => unknown): Promise<void> => {
      try { await operation(); }
      catch (cleanupError) { reportFailure(cleanupError, "gateway.close.runtime"); }
    };
    await close(() => mcpAdminRef.current?.close());
    await close(() => idleRollover?.close());
    await close(() => historyParts.episodeCatalog?.close());
    await close(() => historyParts.memoryService?.close());
    memoryServiceRef.current = undefined;
    await close(() => harness ? harness.close(cleanup) : storage?.close(cleanup));
    await close(() => codeModeRef.current?.close());
    await close(() => mcpRef.current?.close());
    await close(() => historyParts.historyIndex?.close());
    await workerEnvironments.closeAll(close, cleanup);
    await close(() => toolEnvironments?.close(cleanup));
    await close(() => releaseLock());
    throw error;
  }
}
