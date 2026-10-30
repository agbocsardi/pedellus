import { isChordError } from "@earendil-works/chord";
import { processLock } from "@earendil-works/chord/node";
import type { Context, Draft } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, AssistantEntry, configure, ConversationBusy, createRegistry, defineDoc, Harness, LiveDoc, type AgentChange, type AgentState, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type Harness as HarnessType, type Storage, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, createContextExtensionBuilder, type ContextExtensionReplacement, type ConversationContextSnapshot } from "./context/index.js";
import { createSkillTool, SKILL_TOOL_NAME, type SkillTableUpdate } from "./context/skill-tool.js";
import { CRON_RUN_TASK_NAME, createCronFoundation } from "./automation/cron.js";
import { createCronTool, CRON_TOOL_NAME } from "./automation/cron-tool.js";
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
} from "./automation/cron-delivery.js";
import {
  HISTORY_INDEX_LIMITS,
  createHistoryIndex,
  historyIndexPath,
  type HistoryIndex,
  type HistoryPage,
  type HistoryQuery,
  type HistorySession,
  type HistorySummaryPage,
  type HistorySummaryQuery,
} from "./history/index.js";
import {
  normalizeReadySummary,
  readEpisodeDocument,
  type HistorySummaryView,
} from "./history/summary-view.js";
import { createHistoryTool, HISTORY_TOOL_NAME, type HistoryToolHost } from "./history/tool.js";
import {
  TELEGRAM_TOOL_NAME,
  createTelegramActionRegistry,
  createTelegramTool,
  type TelegramActionRegistry,
} from "./channels/telegram-tool.js";
import type { CronOwner } from "./automation/cron.js";
import {
  EpisodeDoc,
  createEpisodeCatalog,
  type EpisodeCatalog,
  type EpisodeReconcileReport,
  type HistoryEpisode,
  type HistoryEpisodePage,
  type HistoryEpisodeQuery,
} from "./history/episodes.js";
import {
  createEpisodeSummaries,
  type EpisodeSummaries,
  type EpisodeSummaryBackfill,
  type EpisodeSummaryDrain,
  type EpisodeSummaryQueueView,
  type EpisodeSummaryRetry,
} from "./history/summary-task.js";
import {
  EPISODE_SUMMARY_QUEUE_LIMITS,
  EpisodeSummaryDoc,
  episodeSummaryKey,
} from "./history/summary-queue.js";
import type { EpisodeSummaryRecord } from "./history/summary-queue.js";
import {
  chatScopeMessage,
  encodedSessionKey,
  isChatSessionKey,
  partitionChatScope,
  readChatScope,
  readChatSessions,
  readMappedSessions,
  type ChatScopeExclusion,
  type HistoryChatSession,
} from "./history/scope.js";
import { ensureStoreIdentity, type StoreIdentity } from "./history/store-identity.js";
import { modelKey, parseToolTimeoutSeconds, type ModelReference, type PortConfig } from "./config.js";
import { createVisionHandoffExtension } from "./media/vision-hook.js";
import { VisionHandoff, type VisionHandoffStats } from "./media/vision.js";
import { hasPersistedNanobotContext, preparedContextReplay, preparedTaskModel } from "./recovery/prepared.js";
import { prepareDataDirectory } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import { createProviderModels, nativeModelReference, resolveModelChoices, type ResolvedModelChoice } from "./providers.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import {
  boundedCapturedTools,
  CODING_TOOL_NAMES,
  ConfigToolCaptureDoc,
  createCodingToolExtension,
  createToolEnvironments,
  type CodingToolName,
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

/** Configured vision handoff and its process-lifetime, bounded accounting. */
export interface GatewayVisionHandoffState {
  readonly enabled: boolean;
  readonly describer?: ModelReference;
  readonly stats: VisionHandoffStats;
}

/** One named preset from config, using the provider spelling accepted by Gateway selection. */
export interface GatewayModelPreset {
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: ModelThinkingLevel;
}

export interface GatewayModelList {
  models: readonly GatewayModelChoice[];
  selected: GatewayModelSelection;
  /** Named presets; absent in legacy direct-model mode. Omitting thinking means `off` when selected. */
  presets?: readonly GatewayModelPreset[];
  /** Configured default preset in named-preset mode. */
  defaultPreset?: string;
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
  /**
   * Host switch for the read-only model-facing `history` tool. It is on by default for
   * mapped chat conversations; pass `false` for a bare gateway that should expose no
   * extra tool. The tool reads only already-mapped chat conversations under the host's
   * single-tenant policy, creates no conversation, writes no transcript and grants no
   * filesystem or shell authority.
   */
  readonly agentHistory?: boolean;
  /**
   * Optional host override for the durable episode-summary pass. Without an override, summaries
   * use the current conversation model; `episodeSummary.enabled: false` in config disables them.
   */
  readonly episodeSummary?: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel?: ModelThinkingLevel;
    /**
     * How episodes that closed before opt-in enter the queue. Default `"none"`: a durable watermark
     * records the newest entry at opt-in and nothing older is queued automatically, so enabling the
     * pass cannot spend on existing history. `"pending"` is the deliberate opt-in to summarize every
     * closed episode without a ready summary, through a bounded resumable scan.
     */
    readonly backfill?: "none" | "pending";
  };
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
  /**
   * Channel-neutral durable outbox of completed background cron results. Host/channel code uses it
   * after its own authentication; it creates no conversation, starts no run and adds no authority.
   */
  readonly cronOutbox: CronDeliveryOutbox;
  /**
   * Model-action host registry for the configured Telegram channel. The running adapter attaches
   * here; when absent, a mapped Telegram chat still sees the tool but every call is denied because
   * no live channel can send. Present only when `config.telegram` is configured.
   */
  readonly telegramActions?: TelegramActionRegistry;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /** Lists the explicit allowlist and persisted selection for an already-known session key. */
  listModels(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /** Persists a native pi.agent choice; rejects ConversationBusy atomically without changing it. */
  selectModel(sessionKey: string, selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  /**
   * Temporarily selects a configured named preset in this conversation, using its provider/model
   * and its thinking level (or `off`). `default` returns to the configured preset. Named-preset
   * conversations also reset to the configured preset on the next gateway open. Rejects with
   * ConversationBusy atomically and fails for unknown names or in legacy direct-model mode.
   */
  selectModelPreset(sessionKey: string, name: string, context: Context): Promise<GatewayModelSelection>;
  /**
   * Configured vision handoff and bounded counters for auxiliary describer calls. The counters are
   * process lifetime, not per conversation; they expose spend that the main model request hides.
   */
  visionHandoffStats(): GatewayVisionHandoffState;
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
   * One closed episode's derived summary record (status, coverage, usage, text), or undefined when
   * no pass finished for it. Requires summaries to be enabled; when disabled this fails
   * closed. The record is derived data: the original entries stay the authority, and the text is
   * model output over untrusted transcript content.
   */
  historyEpisodeSummary(sessionKey: string, startEntryId: number, context: Context): Promise<EpisodeSummaryRecord | undefined>;
  /** Durable summary queue counters and the configured summary model; fails closed without one. */
  historySummaryQueue(sessionKey: string, context: Context): Promise<EpisodeSummaryQueueView>;
  /**
   * Start a summary worker for queued work when none is live. Idempotent; it never creates a queue
   * entry by itself. Reports the live worker and, when Durable has parked the chain at its restart
   * limit, the task ID to revive with `Harness.retryTask()`.
   */
  drainEpisodeSummaries(sessionKey: string, context: Context): Promise<EpisodeSummaryDrain>;
  /**
   * Bounded, resumable scan that queues already-closed episodes without a ready summary. This is the
   * explicit opt-in to historical spend, whether those episodes were catalogued before summaries were
   * enabled or were omitted by the queue cap.
   */
  backfillEpisodeSummaries(sessionKey: string, context: Context): Promise<EpisodeSummaryBackfill>;
  /**
   * Queue one episode by start entry ID, recreating its job from the closed episode document when the
   * queue entry is gone (failed retention, cap omission, or the opt-in watermark). Reports
   * `queued`, `already_queued`, `already_ready`, `queue_full`, `missing`, or `version_incompatible`
   * when the episode record names a newer summarizer version than this build can produce.
   */
  retryEpisodeSummary(
    sessionKey: string,
    startEntryId: number,
    context: Context,
  ): Promise<EpisodeSummaryRetry>;
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
   * Discover ready derived episode summaries across mapped chat conversations.
   *
   * This is navigation over already-generated summaries: it never plans, queues, retries or backfills
   * a summary, never calls a model, and never writes Durable. The same bounded episode reconciliation
   * as `historySearch` runs first, then a bounded slice of stored summary records is re-read. Only a
   * `ready` record whose episode boundary, summarizer version and text agree is searchable; a missing,
   * failed or corrupt summary removes at most its own derived row and cannot block raw search.
   *
   * Summary text is model output over untrusted stored conversation. Treat it as derived, quoted
   * navigation; original Durable entries remain the authority and are reached with `historyEpisode`
   * or `historyEntries`. Pages are newest-first by episode start entry ID with a query-, mapping-,
   * generation- and snapshot-bound cursor; summaries written after a page are excluded from that
   * continuation.
   */
  historySummarySearch(query: HistorySummaryQuery, context: Context): Promise<HistorySummaryPage>;
  /**
   * Read one episode's stored summary by its exact start entry ID through the same validated mapped-chat
   * session scope as every other history read.
   *
   * Unlike `historyEpisodeSummary`, this read does not require the summary pass to be enabled for this
   * open: it reads the derived catalog/summary documents directly and never calls a model. It returns a
   * classified view (`ready`, `not-ready`, `missing`, `malformed`, `unreadable`) instead of throwing for
   * stored state, so a corrupt summary never blocks transcript retrieval. Ready text is model output over
   * untrusted stored conversation: quote it and treat the original entries as the authority.
   */
  historySummary(sessionKey: string, startEntryId: number, context: Context): Promise<HistorySummaryView>;
  /**
   * Re-runs the configured context snapshot provider for one existing session and applies it to the
   * next turn. Rejects an unknown session, a live run, or a gateway opened without a provider.
   * Prompt content stays metadata-only and no tool authority is added or widened.
   */
  refreshContext(sessionKey: string, context: Context): Promise<GatewayContextRefresh>;
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
  // A completed background result is queued only for an origin session that belongs to a channel
  // enabled in this configuration. A disabled channel creates no record, so no later enable can
  // deliver a stale result through a channel the host had switched off.
  const cronDeliveryPrefixes: readonly string[] = config.telegram === undefined ? [] : ["telegram:"];
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
  // Named presets are a config-level catalog over the same finite model choices. Validate every
  // reference and thinking level before storage or dispatch, so a bad preset fails at startup.
  const configuredPresetName = config.modelPreset;
  const presetCatalog = new Map<string, { readonly choice: ResolvedModelChoice; readonly thinkingLevel?: ModelThinkingLevel }>();
  if (configuredPresetName !== undefined) {
    if (config.modelPresets === undefined || Object.keys(config.modelPresets).length === 0) {
      throw new StartupDiagnosticError("model", { detail: "modelPreset requires a non-empty modelPresets catalog" });
    }
    for (const [name, preset] of Object.entries(config.modelPresets)) {
      const choice = choicesByConfigured.get(modelKey(preset));
      if (choice === undefined) {
        throw new StartupDiagnosticError("model", {
          detail: `Model preset ${name} is outside the configured model catalog`,
        });
      }
      if (preset.thinkingLevel !== undefined && !choice.thinkingLevels.includes(preset.thinkingLevel)) {
        throw new StartupDiagnosticError("model", {
          detail: `Unsupported thinkingLevel ${preset.thinkingLevel} for model preset ${name}`,
        });
      }
      presetCatalog.set(name, {
        choice,
        ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
      });
    }
    if (!presetCatalog.has(configuredPresetName)) {
      throw new StartupDiagnosticError("model", { detail: "modelPreset must name a configured model preset" });
    }
  }
  const defaultPreset = configuredPresetName === undefined ? undefined : presetCatalog.get(configuredPresetName);
  const defaultChoice = defaultPreset?.choice ?? choicesByConfigured.get(modelKey(config.model));
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
  if (options.agentHistory !== undefined && typeof options.agentHistory !== "boolean") {
    throw new TypeError("agentHistory must be a boolean");
  }
  const defaultThinkingLevel = defaultPreset?.thinkingLevel ?? config.thinkingLevel ?? "off";
  // Vision handoff: one configured describer preset replaces or bounds image attachments in the
  // model-bound request. It is a native generation hook, never a second agent loop, and it leaves
  // the persisted transcript and prepared checkpoints untouched. The map records the model pinned
  // by a live prepared dispatch so recovery cannot silently apply the reset configured preset.
  const preparedGenerationModels = new Map<number, ModelReference>();
  let visionHandoff: VisionHandoff | undefined;
  let visionExtension: Extension | undefined;
  if (config.visionHandoff !== undefined) {
    const describerPreset = presetCatalog.get(config.visionHandoff.describerPreset);
    if (describerPreset === undefined) {
      throw new StartupDiagnosticError("model", {
        detail: "visionHandoff.describerPreset must name a configured model preset",
      });
    }
    if (!describerPreset.choice.model.input.includes("image")) {
      throw new StartupDiagnosticError("model", {
        detail: "visionHandoff.describerPreset must name a model that accepts image input",
      });
    }
    const flaggedModels = new Set<string>();
    const flagsByNativePair = new Map<string, { readonly name: string; readonly flag: boolean }>();
    for (const [name, preset] of Object.entries(config.modelPresets ?? {})) {
      const choice = presetCatalog.get(name);
      if (choice === undefined) {
        throw new StartupDiagnosticError("model", {
          detail: `Model preset ${name} is outside the configured model catalog`,
        });
      }
      const flag = preset.needsVisionHandoff === true;
      // Requests carry the native provider/model pair, never the config alias. Compare and key
      // flags by that native pair, so aliasing cannot silently disable a text-only flag.
      const key = modelKey(choice.choice.native);
      const previous = flagsByNativePair.get(key);
      if (previous !== undefined && previous.flag !== flag) {
        throw new StartupDiagnosticError("model", {
          detail: `Model presets ${previous.name} and ${name} disagree on needsVisionHandoff for the same native model`,
        });
      }
      flagsByNativePair.set(key, { name, flag });
      if (!flag) continue;
      if (name === config.visionHandoff.describerPreset) {
        throw new StartupDiagnosticError("model", {
          detail: "visionHandoff.describerPreset must not itself need vision handoff",
        });
      }
      flaggedModels.add(key);
    }
    visionHandoff = new VisionHandoff({
      describer: describerPreset.choice.native,
      flaggedModels,
      maxRawImages: config.visionHandoff.maxRawImages,
      maxDescriptionTokens: config.visionHandoff.maxDescriptionTokens,
      ...(config.visionHandoff.prompt === undefined ? {} : { prompt: config.visionHandoff.prompt }),
    });
    visionExtension = createVisionHandoffExtension({
      handoff: visionHandoff,
      defaultModel: defaultChoice.native,
      preparedModel: (taskId) => preparedGenerationModels.get(Number(taskId)),
    });
  }
  // A configured summary override must be allowed. `preset` resolves through the named catalog and
  // supplies its thinking level to real summary jobs; `model` keeps the legacy direct form.
  // Otherwise each job captures the conversation's current model when it starts; old history is not
  // backfilled automatically.
  let configuredSummary: { readonly model: ModelReference; readonly thinkingLevel?: ModelThinkingLevel } | undefined;
  if (config.episodeSummary?.preset !== undefined) {
    const summaryPreset = presetCatalog.get(config.episodeSummary.preset);
    if (summaryPreset === undefined) {
      throw new StartupDiagnosticError("model", {
        detail: "episodeSummary.preset must name a configured model preset",
      });
    }
    configuredSummary = {
      model: summaryPreset.choice.native,
      ...(summaryPreset.thinkingLevel === undefined ? {} : { thinkingLevel: summaryPreset.thinkingLevel }),
    };
  } else if (config.episodeSummary?.model !== undefined) {
    const summaryChoice = choicesByConfigured.get(modelKey(config.episodeSummary.model));
    if (summaryChoice === undefined) {
      throw new StartupDiagnosticError("model", { detail: "episodeSummary.model must be included in allowedModels" });
    }
    configuredSummary = { model: summaryChoice.native };
  }
  if (options.episodeSummary === null) throw new StartupDiagnosticError("model", { detail: "episodeSummary must be an object" });
  const episodeSummaryModel: OpenGatewayOptions["episodeSummary"] = options.episodeSummary ?? (config.episodeSummary?.enabled === false
    ? undefined
    : configuredSummary === undefined
      ? defaultChoice.native
      : {
          ...configuredSummary.model,
          ...(configuredSummary.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: configuredSummary.thinkingLevel }),
        });
  const useConversationSummaryModel = options.episodeSummary === undefined && configuredSummary === undefined;
  if (episodeSummaryModel !== undefined) {
    if (episodeSummaryModel === null || typeof episodeSummaryModel !== "object"
      || Array.isArray(episodeSummaryModel)) {
      throw new StartupDiagnosticError("model", { detail: "episodeSummary must be an object" });
    }
    if (typeof episodeSummaryModel.provider !== "string" || episodeSummaryModel.provider.length === 0
      || typeof episodeSummaryModel.modelId !== "string" || episodeSummaryModel.modelId.length === 0) {
      throw new StartupDiagnosticError("model", {
        detail: "episodeSummary requires a provider and modelId",
      });
    }
    const approved = choices.some((choice) =>
      choice.native.provider === episodeSummaryModel.provider
      && choice.native.modelId === episodeSummaryModel.modelId);
    if (!approved) {
      throw new StartupDiagnosticError("model", {
        detail: "episodeSummary provider/model must be included in allowedModels",
      });
    }
    if (models.getModel(episodeSummaryModel.provider, episodeSummaryModel.modelId) === undefined) {
      throw new StartupDiagnosticError("model", {
        detail: "episodeSummary model is not in the provider catalog",
      });
    }
    if (episodeSummaryModel.backfill !== undefined
      && episodeSummaryModel.backfill !== "none" && episodeSummaryModel.backfill !== "pending") {
      throw new StartupDiagnosticError("model", {
        detail: 'episodeSummary backfill must be "none" or "pending"',
      });
    }
    if (episodeSummaryModel.thinkingLevel !== undefined) {
      // The level must be supported by the selected summary model, not merely a known string: a
      // provider rejects an unsupported level at request time, which would burn an episode attempt.
      const choice = choices.find((candidate) =>
        candidate.native.provider === episodeSummaryModel.provider
        && candidate.native.modelId === episodeSummaryModel.modelId);
      if (choice === undefined || !choice.thinkingLevels.includes(episodeSummaryModel.thinkingLevel)) {
        throw new StartupDiagnosticError("model", {
          detail: "episodeSummary thinkingLevel is not supported by the summary model",
        });
      }
    }
  }
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
  // The read-only history tool is on by default; its name is fixed before the tool extension exists so
  // the coding hook can exempt it from the ceiling like the skill loader.
  const historyEnabled = options.agentHistory !== false;
  // Telegram interaction is a separate channel capability, not a coding-tool name. It exists only
  // when the channel is configured; the running adapter attaches its host, and the runtime offers
  // the tool only in a mapped Telegram chat conversation. Root, channel-state, fork, raw and
  // task-owned cron targets are never in that set.
  const telegramActions: TelegramActionRegistry | undefined =
    config.telegram === undefined ? undefined : createTelegramActionRegistry();
  const sessionKeyForConversation = new Map<ConversationId, string>();
  const telegramChatConversations = new Set<ConversationId>();
  const telegramTool = telegramActions === undefined
    ? undefined
    : createTelegramTool({
        registry: telegramActions,
        sessionKeyFor: (conversationId) => sessionKeyForConversation.get(conversationId),
      });
  const telegramToolRegistration = telegramTool?.extension.tools?.[0];
  // Config authorization names only mapped ordinary chat conversations (loaded map + scope checked).
  // The call-time hook consults this set; the policy filter reads the same rule from committed state.
  const authorizedChatConversations = new Set<ConversationId>();
  const toolExtension: Extension | undefined = toolsEnabled
    ? createCodingToolExtension({
        tools: toolAllowlist as readonly CodingToolName[],
        ceiling: toolAllowlist,
        contextTools: [
          ...(options.contextSnapshotProvider === undefined ? [] : [SKILL_TOOL_NAME]),
          ...(cronEnabled ? [CRON_TOOL_NAME] : []),
          ...(telegramTool === undefined ? [] : [TELEGRAM_TOOL_NAME]),
          // History retrieval is read-only over mapped chats and has its own scope checks, so the
          // ceiling must not suppress it when coding tools are enabled.
          ...(historyEnabled ? [HISTORY_TOOL_NAME] : []),
        ],
        defaultTimeoutSeconds,
        authenticatedChat: (conversationId: ConversationId) => authorizedChatConversations.has(conversationId),
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
    choice.thinkingLevels.includes(defaultThinkingLevel) ? defaultThinkingLevel : "off";
  const choiceFromState = (state: Readonly<AgentState> | undefined): ResolvedModelChoice | undefined =>
    state?.model === undefined ? undefined : choicesByNative.get(modelKey(state.model));
  /**
   * Reapply host policy to a persisted conversation. Named-preset mode additionally resets a
   * selection left by a previous run to the configured preset on startup, so a temporary CLI
   * switch never survives a restart or a configuration reload.
   */
  const policyForState = (
    state: Readonly<AgentState> | undefined,
    resetToConfiguredPreset = false,
  ): AgentChange => {
    const existing = resetToConfiguredPreset ? undefined : choiceFromState(state);
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
  // Read-only prior-conversation retrieval for the assistant. It is not a coding tool: no path, no
  // shell, no transcript write and no conversation creation. The host surface is late-bound so the
  // extension can be registered before Harness.open() while the index itself is created afterwards.
  const historyToolHostRef: { current: HistoryToolHost | undefined } = { current: undefined };
  const historyTool = historyEnabled ? createHistoryTool({ host: () => historyToolHostRef.current }) : undefined;
  const historyToolRegistration = historyTool?.extension.tools?.[0];
  const historyConversations = new Set<ConversationId>();
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
    // The vision hook carries no tool or workspace authority; selecting it everywhere keeps
    // image bounding independent of tool allowlists and channel scope.
    if (visionExtension) selected.push(visionExtension);
    if (toolExtension) selected.push(toolExtension);
    if (options.contextSnapshotProvider && contextExtension && contextConversations.has(conversationId)) {
      selected.push(contextExtension);
    }
    if (skillTool && contextConversations.has(conversationId) && skillConversations.has(conversationId)) {
      selected.push(skillTool.extension);
    }
    if (historyTool && historyConversations.has(conversationId)) selected.push(historyTool.extension);
    if (telegramTool && telegramChatConversations.has(conversationId)) selected.push(telegramTool.extension);
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
        // A background run is a fresh, task-owned conversation that starts default-deny. It captures
        // the ceiling its authenticated origin currently has; the call-time hook still requires that
        // origin and the current config, so the capture is a subset, never new authority. An
        // origin-mode run answers inside the conversation that already has the configured authority,
        // so it needs no capture.
        prepare: async ({ tx, originConversationId, targetConversationId, background }, ctx) => {
          if (!background) return;
          // Fail closed on a run whose origin cannot be attributed to a known owner: it gets no
          // captured authority, so every effectful call stays denied.
          const owner = cronOwners.get(originConversationId);
          const captured: string[] = [];
          if (owner !== undefined) {
            const capture = await tx.doc(ConfigToolCaptureDoc, targetConversationId);
            capture.originConversationId = originConversationId;
            capture.tools = authorizedChatConversations.has(originConversationId) ? [...toolAllowlist] : [];
            captured.push(...capture.tools);
          } else {
            await tx.retireDoc(ConfigToolCaptureDoc, targetConversationId);
          }
          // The run's fresh conversation is default-deny, so it also receives the origin's workspace
          // context through the same snapshot path: bootstrap/AGENTS, the memory manifest, the skill
          // summary and the read-only `skill` tool. An origin with no known owner skips this and keeps
          // the run default-deny. The cron tool and foundation are never offered here.
          const skillsInstalled = owner !== undefined && contextInstallerRef.current !== undefined
            ? await contextInstallerRef.current(owner.sessionKey, targetConversationId, ctx)
            : false;
          const tools = [
            ...captured.flatMap((name) => {
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
        // A separate run target's captured authority ends with the run: retire its capture document
        // and stop offering its tools in the same commit that records the terminal outcome, so a
        // finished or cancelled run cannot be used for a later admission. An origin-mode run answers
        // in the origin conversation itself, so that conversation keeps its configured tools, cron
        // ownership and context, and none of its documents are retired.
        finalize: async ({ tx, job, occurrence, originConversationId, targetConversationId, background, delivery }) => {
          if (background) {
            await tx.retireDoc(ConfigToolCaptureDoc, targetConversationId);
            await configure(tx, targetConversationId, { tools: [], modelTools: [] });
          }
          // Queue one record for the occurrence in the same commit as the terminal run outcome, for
          // a separate target and for an origin-mode answer alike. A cancelled, superseded, fenced or
          // missing-job run passes `delivery: null` and stays silent, so abandoned work never sends.
          // A settled run with an error, or with no committed answer text, queues fixed sanitized
          // notice text naming the job and occurrence only: raw provider errors, the job's message and
          // model text never leave the store. A successful answer is queued from the committed entry
          // the scheduled submission settled with, so no model turn is rerun and no nearby user
          // answer is substituted for it. The origin session key is also the channel locator: a key
          // outside an enabled delivery prefix is never queued.
          if (delivery === null) return;
          if (job === null || !isChatSessionKey(job.owner.sessionKey)) return;
          if (!cronDeliveryPrefixes.some((prefix) => job.owner.sessionKey.startsWith(prefix))) return;
          let text: string;
          if (delivery.status === "error") {
            text = cronOutcomeNotice("failed", job.id, occurrence.scheduledAtMs);
          } else {
            const answer = delivery.answerEntryId === null
              ? undefined
              : await tx.entry(AssistantEntry, delivery.answerEntryId);
            const message = answer?.model?.[0] as AssistantMessage | undefined;
            const body = (message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "").trim();
            text = body === ""
              ? cronOutcomeNotice("empty", job.id, occurrence.scheduledAtMs)
              : body.length > CRON_DELIVERY_MAX_TEXT_CHARS
                ? `${body.slice(0, CRON_DELIVERY_MAX_TEXT_CHARS - 16)}\n\n[truncated]`
                : body;
          }
          // A corrupt outbox must never fault the run's terminal commit. Invalid data is left as
          // stored; a full outbox records an actionable fault rather than implying lossless delivery.
          let admission: "admitted" | "duplicate" | "full" | "invalid" = "invalid";
          try {
            const records = await tx.doc(CronDeliveriesDoc, originConversationId);
            admission = admitCronDelivery(records, {
              id: `cron:${job.id}:${occurrence.scheduledAtMs}`,
              sessionKey: job.owner.sessionKey,
              text,
              createdAtMs: now(),
              status: "pending",
              nextChunkIndex: 0,
            });
          } catch {
            admission = "invalid";
          }
          if (admission === "full" || admission === "invalid") {
            try {
              const faults = await tx.doc(CronDeliveryFaultsDoc, originConversationId);
              recordCronDeliveryFault(faults, {
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
    // The skill loader is context delivery, not an effectful tool: it stays outside the host
    // ceiling, and is offered only for captured skill snapshots.
    // The cron tool is an owner-scoped scheduling capability, not filesystem or shell authority,
    // and is offered only in an origin session whose owner is known.
    const skillTools = skillToolRegistration !== undefined && skillConversations.has(conversationId)
      ? [skillToolRegistration]
      : [];
    const cronTools = cronToolRegistration !== undefined && cronOwners.has(conversationId)
      ? [cronToolRegistration]
      : [];
    // History retrieval is enabled by default, read-only, and limited to mapped chat conversations.
    const historyTools = historyToolRegistration !== undefined && historyConversations.has(conversationId)
      ? [historyToolRegistration]
      : [];
    // Telegram interaction is a scoped channel capability for one mapped private chat, not a coding
    // tool. The live adapter rechecks the current allowlist and observed target at call time.
    const telegramTools = telegramToolRegistration !== undefined && telegramChatConversations.has(conversationId)
      ? [telegramToolRegistration]
      : [];
    return [...skillTools, ...cronTools, ...historyTools, ...telegramTools];
  };
  /**
   * The authority-derived tool filter. The host ceiling directly authorizes authenticated mapped
   * ordinary chats; a scheduled background run must pass its restored capture bound, or it keeps no
   * coding tool. An empty bound is a genuine deny and retires the capture.
   */
  const toolFilterFor = async (
    tx: Tx,
    conversationId: ConversationId,
    backgroundTools?: ReadonlySet<string>,
  ): Promise<Pick<AgentChange, "tools" | "modelTools">> => {
    const contextTools = contextToolsFor(conversationId);
    const withContext = (names: readonly string[]): Pick<AgentChange, "tools" | "modelTools"> => {
      const tools = [...toolFilterFromNames(names).tools, ...contextTools];
      return { tools, modelTools: tools };
    };
    if (!toolExtension) {
      // Retire instead of creating an empty document: a disabled ceiling must durably remove
      // previously captured tools so re-enabling it cannot resurrect them.
      await tx.retireDoc(ConfigToolCaptureDoc, conversationId);
      return withContext([]);
    }
    // Only the host's validated mapped-chat set carries configured authority. The root, a
    // channel-state conversation, a fork, a raw conversation and any other task-owned target
    // are denied even when agent state still names a tool.
    if (authorizedChatConversations.has(conversationId)) return withContext(toolAllowlist);
    if (backgroundTools !== undefined) {
      const capture = await tx.doc(ConfigToolCaptureDoc, conversationId);
      const names = toolAllowlist.filter((name) =>
        backgroundTools.has(name) && capture.tools.includes(name));
      // Persist the prune so a later call-time check cannot revive a name the origin lost.
      capture.tools = names;
      return withContext(names);
    }
    await tx.retireDoc(ConfigToolCaptureDoc, conversationId);
    return withContext([]);
  };
  const denyNewConversation = async (
    tx: Tx,
    conversation: { readonly id: ConversationId },
  ): Promise<void> => {
    // Every native creation path, including forks and raw/task-created conversations, starts denied.
    // Any capture document is retired so a fork's copied agent state can never inherit authority,
    // and extensions are explicit so a later dynamic install cannot be selected by default.
    await tx.retireDoc(ConfigToolCaptureDoc, conversation.id);
    await configure(tx, conversation.id, {
      tools: [],
      modelTools: [],
      // Denied conversations still get the non-authoritative vision hook so a raw, forked or
      // task-created request cannot send unbounded raw images to a flagged text-only model.
      extensions: visionExtension === undefined ? [] : [visionExtension],
    });
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
  const publicPresets: readonly GatewayModelPreset[] = [...presetCatalog].map(([name, preset]) => ({
    name,
    ...preset.choice.configured,
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
  }));
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
  let releaseLock: Awaited<ReturnType<typeof processLock>>;
  try {
    releaseLock = await processLock(`nanobot:${dbPath}`);
  } catch (cause) {
    // A known live owner is actionable and its raw lock name contains the database path.
    if (isChordError(cause) && cause.reason === "locked") {
      throw new StartupDiagnosticError("storeLocked", { cause });
    }
    throw cause;
  }
  let harness: HarnessType | undefined;
  let storage: Storage | undefined;
  let episodeCatalog: EpisodeCatalog | undefined;
  let historyIndex: HistoryIndex | undefined;
  let episodeSummaries: EpisodeSummaries | undefined;
  let closed = false;
  try {
    // Constructed before the Harness opens so its extension is in the initial registry. The
    // object holds no harness: every operation receives Durable's own transaction or task surface.
    episodeSummaries = episodeSummaryModel === undefined
      ? undefined
      : createEpisodeSummaries({
          model: {
            provider: episodeSummaryModel.provider,
            modelId: episodeSummaryModel.modelId,
            ...(episodeSummaryModel.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: episodeSummaryModel.thinkingLevel }),
          },
          ...(episodeSummaryModel.backfill === undefined ? {} : { backfill: episodeSummaryModel.backfill }),
          ...(useConversationSummaryModel ? {
            resolveModel: async (tx: Tx, conversationId: ConversationId) => {
              const state = await tx.doc(AgentDoc, conversationId);
              const selected = choiceFromState(state) ?? defaultChoice;
              return { ...selected.native, thinkingLevel: null };
            },
          } : {}),
          allowModel: (provider: string, modelId: string) => choicesByNative.has(modelKey({ provider, modelId })),
          includeOpenAtActivation: options.episodeSummary === undefined,
          // Backstop: a job whose conversation is not chat scope never reaches a provider call.
          scope: (tx: Tx, conversationId: ConversationId): Promise<ChatScopeExclusion | undefined> =>
            readChatScope((id) => tx.conversation(id), conversationId, root.id),
          // Resolved lazily: the catalog is created after this object so its extension can be
          // installed in the initial registry.
          listEpisodes: (conversationId, query, ctx) =>
            episodeCatalog!.list(
              conversationId,
              query.before === undefined
                ? { limit: query.limit }
                : { limit: query.limit, before: query.before as EntryId },
              ctx,
            ),
          now,
        });
    const registry = createRegistry();
    if (episodeSummaries !== undefined) registry.install(episodeSummaries.extension);
    if (visionExtension) registry.install(visionExtension);
    if (toolExtension) registry.install(toolExtension);
    if (skillTool) registry.install(skillTool.extension);
    if (historyTool) registry.install(historyTool.extension);
    if (telegramTool) registry.install(telegramTool.extension);
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

    // History scope: mapped chat sessions only. A channel's own state conversation, an unmapped
    // conversation (a scheduled run's task-owned target) and the root are not chat history, and the
    // host has already authenticated the session key before naming it. A mapped chat session is also
    // ownerless and unforked: search, every entry/episode read and the background episode/summary work
    // share that check, so a forged or stale map entry cannot expose or summarize a task-owned
    // transcript, an inherited fork or the root.
    const assertMappedChatConversations = async (
      conversationIds: readonly ConversationId[],
      ctx: Context,
    ): Promise<void> => {
      await root.commit(async (tx) => {
        for (const conversationId of conversationIds) {
          const reason = await readChatScope((id) => tx.conversation(id), conversationId, root.id);
          if (reason !== undefined) throw new Error(chatScopeMessage(reason));
        }
      }, ctx);
    };
    // Background scope is decided by the conversation record, never by the session key alone. An
    // out-of-scope mapping is skipped instead of failing the whole pass, so one forged entry cannot
    // stop cataloguing or summarizing the conversations that really are chat history. The per-session
    // history surface still rejects such a mapping loudly.
    const mappedChatSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> => {
      const mapping = await harness!.snapshot(SessionMap, root.id, ctx);
      if (mapping === undefined) return [];
      const candidates = readChatSessions(mapping.sessions, root.id);
      return root.commit(async (tx) => {
        const { chat } = await partitionChatScope((id) => tx.conversation(id), candidates, root.id);
        return chat;
      }, ctx);
    };
    // Bounded, background-only derived state: reset-delimited episode boundaries and their
    // durable summary status. It reads committed entries only and changes no reset or busy
    // ordering. A closed episode is recorded as pending; with summaries opted in, the same
    // commit queues its summary job, and without them nothing schedules or calls a provider.
    episodeCatalog = createEpisodeCatalog({
      harness: harness!,
      sessions: mappedChatSessions,
      context,
      ...(episodeSummaries === undefined ? {} : { summaryJobs: { enqueue: episodeSummaries.enqueue } }),
    });

    // Read-only view of one derived episode summary. The catalog's episode document is the authority
    // for the closed boundary and the authoritative summarizer version; the version-keyed summary
    // record supplies the text. Both are read as untrusted JSON through public document snapshots,
    // and a missing, malformed or unreadable record is classified instead of thrown, so summary
    // discovery can never block raw transcript search. This reads derived docs only: no model call,
    // no summary job, no Durable write.
    async function readEpisodeSummary(
      conversationId: ConversationId,
      startEntryId: EntryId,
      ctx: Context,
    ): Promise<HistorySummaryView> {
      let episode: unknown;
      try {
        episode = await harness!.snapshot(EpisodeDoc, conversationId, String(startEntryId), ctx);
      } catch {
        return { state: "unreadable" };
      }
      const classified = readEpisodeDocument(episode, startEntryId);
      if (classified.kind !== "ready") {
        return classified.kind === "not-ready"
          ? { state: "not-ready", status: classified.status }
          : { state: classified.kind };
      }
      let record: unknown;
      try {
        record = await harness!.snapshot(
          EpisodeSummaryDoc,
          conversationId,
          episodeSummaryKey(startEntryId, classified.version),
          ctx,
        );
      } catch {
        return { state: "unreadable" };
      }
      return normalizeReadySummary(classified.body, record, classified.version);
    }

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
      // Fail loudly rather than silently indexing a task-owned transcript or inherited fork.
      await assertMappedChatConversations(mappedSessions.map(({ conversationId }) => conversationId), ctx);
      return mappedSessions;
    };
    historyIndex = createHistoryIndex({
      indexPath: historyIndexPath(dbPath),
      sourcePath: dbPath,
      storeId: storeIdentity.storeId,
      sessions: historySessions,
      scan: (ctx, read) => root.commit(read, ctx),
      readSummary: (ctx, conversationId, startEntryId) =>
        readEpisodeSummary(conversationId, startEntryId, ctx),
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
    // leaves the captured snapshot untouched. Refresh changes no tool authority: it re-renders the
    // skills summary and replaces the on-demand skill table, while the normal policy pass reapplies
    // the configured tool filter. Background cron targets are not reachable here because they have no
    // session key.
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
    // History retrieval is independent of the context snapshot opt-in: every mapped chat
    // conversation can read history, while state-only bookkeeping conversations cannot. Config tool
    // authority is derived from the same validated mapping, so it is loaded whenever either needs it.
    const initialMapping = historyTool === undefined && !toolsEnabled && telegramTool === undefined
      ? undefined
      : await harness.snapshot(SessionMap, root.id, context);
    if (initialMapping !== undefined) {
      for (const { sessionKey, conversationId } of await mappedChatSessions(context)) {
        if (historyTool !== undefined) historyConversations.add(conversationId);
        authorizedChatConversations.add(conversationId);
        sessionKeyForConversation.set(conversationId, sessionKey);
        if (telegramTool !== undefined && sessionKey.startsWith("telegram:")) {
          telegramChatConversations.add(conversationId);
        }
      }
    }
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
          if (preparedModel !== undefined && task.kind === "pi.generation") {
            // The checkpoint model, not the configured preset the startup policy pass will
            // restore, decides whether this prepared request keeps any raw images.
            preparedGenerationModels.set(Number(task.id), preparedModel);
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

    // A background run's captured authority is only as good as the current host config and its
    // origin. Durable's tool hooks run in the call phase only, so a committed execute intent
    // resolves without them and a resumed turn could otherwise admit a call the config or origin no
    // longer supports. Intersect every live run's capture with the current ceiling and its
    // authenticated origin before resume; a mismatched origin, an unknown origin owner, an already
    // finished run or a missing capture is a deny rather than authority.
    const backgroundToolBounds = new Map<ConversationId, ReadonlySet<string>>();
    for (const { conversationId: targetConversationId, originConversationId, live } of runTargetCandidates) {
      const tools = new Set<string>();
      const capture = live ? await harness.snapshot(ConfigToolCaptureDoc, targetConversationId, context) : undefined;
      if (capture !== undefined && capture.originConversationId === originConversationId
        && authorizedChatConversations.has(originConversationId)) {
        for (const name of boundedCapturedTools(capture.tools, toolAllowlist, true)) tools.add(name);
      }
      backgroundToolBounds.set(targetConversationId, tools);
    }

    for (const replay of preparedContextReplays) {
      const conversation = await harness.conversation(replay.conversationId, context);
      if (!conversation) throw new Error(`Cannot safely resume ${replay.kind} task ${replay.id}: conversation is missing`);
      const view = await conversation.context(context, { at: replay.at as EntryId });
      if (hasPersistedNanobotContext(view.messages)) {
        throw new StartupDiagnosticError("preparedContext", {
          detail: `Cannot safely resume ${replay.kind} task ${replay.id} (${replay.phase}): its prepared request includes ` +
            "persisted Nanobot context; cancel that prepared dispatch with the context recovery interface before gateway recovery",
        });
      }
    }

    // Apply host security, configured tool authority and context selection only after every prepared
    // dispatch passes the replay guard. A narrowed configuration is what keeps a removed tool from replaying.
    await root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 1000, cursor);
        for (const conversation of page.items) {
          const state = await tx.doc(AgentDoc, conversation.id);
          const toolFilter = await toolFilterFor(tx, conversation.id, backgroundToolBounds.get(conversation.id));
          await configure(tx, conversation.id, {
            // Named-preset mode owns the startup default; direct mode preserves its persisted choice.
            ...policyForState(state, configuredPresetName !== undefined),
            ...extensionsPolicy(conversation.id),
            ...toolFilter,
          });
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }, context);

    // Host/channel view of the durable cron result outbox. Every access resolves an existing
    // mapped chat session; no conversation is created and no transcript is exposed.
    const cronOutbox: CronDeliveryOutbox = {
      sessions: (ctx) => mappedChatSessions(ctx),
      async list(sessionKey, ctx) {
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        const doc = await harness!.snapshot(CronDeliveriesDoc, conversationId, ctx);
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
          change(record as Draft<CronDeliveryRecord>);
          return copyCronDelivery(record as Draft<CronDeliveryRecord>);
        }, ctx);
      },
      async recordFault(sessionKey, message, ctx) {
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        try {
          await root.commit(async (tx) => {
            const doc = await tx.doc(CronDeliveryFaultsDoc, conversationId);
            recordCronDeliveryFault(doc, {
              jobId: null,
              scheduledAtMs: null,
              recordedAtMs: now(),
              message,
            });
          }, ctx);
        } catch {
          // A best-effort diagnostic must not make the channel scan fail repeatedly.
        }
      },
    };
    /** Shared atomic selection path for direct choices and named presets. */
    const selectConversationModel = async (
      sessionKey: string,
      selection: GatewayModelSelectionRequest,
      ctx: Context,
    ): Promise<GatewayModelSelection> => {
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
    };
    const gateway: Gateway = {
      harness,
      cronOutbox,
      ...(telegramActions === undefined ? {} : { telegramActions }),
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
          if (options.contextSnapshotProvider && Object.keys(map.sessions).length >= CONTEXT_LIMITS.maxConversations) {
            throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
          }
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          createdNow = created.id as ConversationId;
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
        let mappedChat = false;
        if (isChatSessionKey(sessionKey)) {
          const reason = await root.commit((tx) => readChatScope((id) => tx.conversation(id), conversationId!, root.id), ctx);
          if (reason === undefined) {
            historyConversations.add(conversationId!);
            authorizedChatConversations.add(conversationId!);
            mappedChat = true;
          } else {
            historyConversations.delete(conversationId!);
            authorizedChatConversations.delete(conversationId!);
          }
        }
        // The exact host-owned session key for this conversation is what a channel action host
        // revalidates; it is never supplied by the model. Only a scope-checked mapped Telegram chat
        // conversation is offered the Telegram action tool.
        sessionKeyForConversation.set(conversationId!, sessionKey);
        if (mappedChat && sessionKey.startsWith("telegram:")) {
          telegramChatConversations.add(conversationId!);
        } else {
          telegramChatConversations.delete(conversationId!);
        }
        if (createdNow !== undefined && episodeSummaries !== undefined) {
          try {
            await episodeSummaries.initialize(harness!, createdNow, ctx);
          } catch {
            // The startup policy pass and the defensive enqueue path both record a missing watermark.
          }
        }
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
        return {
          models: choices.map(publicChoice),
          selected: publicSelection(choice, level),
          ...(configuredPresetName === undefined
            ? {}
            : { presets: publicPresets, defaultPreset: configuredPresetName }),
        };
      },
      async selectModel(sessionKey, selection, ctx) {
        return selectConversationModel(sessionKey, selection, ctx);
      },
      async selectModelPreset(sessionKey, name, ctx) {
        if (configuredPresetName === undefined) {
          throw new Error("Named model presets are not configured; use the direct model selection");
        }
        if (typeof name !== "string" || name.length === 0) {
          throw new Error("Model preset name must be a non-empty string");
        }
        const resolvedName = name === "default" ? configuredPresetName : name;
        const preset = presetCatalog.get(resolvedName);
        if (preset === undefined) throw new Error("Unknown model preset");
        // A preset always supplies a concrete thinking level, so selecting it is deterministic even
        // when two names share the same provider/model pair.
        return selectConversationModel(sessionKey, {
          ...preset.choice.configured,
          thinkingLevel: preset.thinkingLevel ?? "off",
        }, ctx);
      },
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
      async historyEpisodeSummary(sessionKey, startEntryId, ctx) {
        if (episodeSummaries === undefined) {
          throw new Error("Episode summaries require an explicit provider/model choice");
        }
        if (!Number.isSafeInteger(startEntryId) || startEntryId < 1) {
          throw new TypeError("Episode start must be a positive entry ID");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeSummaries.record(harness!, conversationId, startEntryId, ctx);
      },
      async historySummaryQueue(sessionKey, ctx) {
        if (episodeSummaries === undefined) {
          throw new Error("Episode summaries require an explicit provider/model choice");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeSummaries.queue(harness!, conversationId, ctx);
      },
      async drainEpisodeSummaries(sessionKey, ctx) {
        if (episodeSummaries === undefined) {
          throw new Error("Episode summaries require an explicit provider/model choice");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeSummaries.drain(harness!, conversationId, ctx);
      },
      async backfillEpisodeSummaries(sessionKey, ctx) {
        if (episodeSummaries === undefined) {
          throw new Error("Episode summaries require an explicit provider/model choice");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeSummaries.backfill(harness!, conversationId, ctx);
      },
      async retryEpisodeSummary(sessionKey, startEntryId, ctx) {
        if (episodeSummaries === undefined) {
          throw new Error("Episode summaries require an explicit provider/model choice");
        }
        if (!Number.isSafeInteger(startEntryId) || startEntryId < 1) {
          throw new TypeError("Episode start must be a positive entry ID");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return episodeSummaries.retry(harness!, conversationId, startEntryId, ctx);
      },
      async historySearch(query, ctx) {
        return historyIndex!.search(query, ctx);
      },
      async historySummarySearch(query, ctx) {
        return historyIndex!.searchSummaries(query, ctx);
      },
      async historySummary(sessionKey, startEntryId, ctx) {
        if (!Number.isSafeInteger(startEntryId) || startEntryId < 1) {
          throw new TypeError("Episode start must be a positive entry ID");
        }
        const conversationId = await chatConversationIdFor(sessionKey, ctx);
        return readEpisodeSummary(conversationId, startEntryId as EntryId, ctx);
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
    // Summary policy and cut-chain repair. The opt-in watermark is recorded before any catalog pass
    // can enqueue history, so enabling summaries never spends on episodes that already existed. A
    // queue with no live task means the chain was cut by an abort, a fault or a crash before the
    // terminal commit; repairing it is deterministic, at most one task per mapped session.
    if (episodeSummaries !== undefined) {
      const backfillEnabled = episodeSummaryModel?.backfill === "pending";
      // A backfill scan lists episode documents, so the catalog must record those boundaries first:
      // an unrecorded boundary is not work and must not be skipped or called complete.
      const settleCatalog = async (conversationId: ConversationId, passes: number): Promise<boolean> => {
        for (let pass = 0; pass < passes; pass += 1) {
          const report = await episodeCatalog!.reconcile(conversationId, context);
          if (report.caughtUp) return true;
        }
        return false;
      };
      for (const session of await mappedChatSessions(context)) {
        try {
          await episodeSummaries.initialize(harness, session.conversationId, context);
          await settleCatalog(session.conversationId, EPISODE_SUMMARY_QUEUE_LIMITS.startupCatalogPasses);
          if (backfillEnabled) {
            for (let pass = 0; pass < EPISODE_SUMMARY_QUEUE_LIMITS.backfillPassesPerRun; pass += 1) {
              const report = await episodeSummaries.backfill(harness, session.conversationId, context);
              if (report.complete) break;
              if (report.reason !== "catalog-behind") break;
              // More history to record before its boundaries can be queued; one bounded round.
              await settleCatalog(session.conversationId, 2);
            }
          }
          await episodeSummaries.drain(harness, session.conversationId, context);
        } catch {
          // A policy/repair failure is derived work; the durable queue keeps the jobs for a later drain.
        }
      }
    }
    // Scheduling begins only after registry and all persisted conversation policies are ready.
    historyToolHostRef.current = historyTool === undefined ? undefined : {
      search: (query, ctx) => gateway.historySearch(query, ctx),
      summaries: (query, ctx) => gateway.historySummarySearch(query, ctx),
      summary: (sessionKey, startEntryId, ctx) => gateway.historySummary(sessionKey, startEntryId, ctx),
      entries: (sessionKey, query, limit, cursor, ctx) => gateway.historyEntries(sessionKey, query, limit, cursor, ctx),
      listEpisodes: (sessionKey, query, ctx) => gateway.listHistoryEpisodes(sessionKey, query, ctx),
      episode: (sessionKey, startEntryId, ctx) => gateway.historyEpisode(sessionKey, startEntryId, ctx),
    };
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
