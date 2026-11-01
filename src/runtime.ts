import { resolve } from "node:path";
import { isChordError } from "@earendil-works/chord";
import { processLock } from "@earendil-works/chord/node";
import type { Context, Draft } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, AssistantEntry, ResetEntry, ToolTask, configure, ConversationBusy, createRegistry, defineDoc, defineExtension, hook, Harness, LiveDoc, type AgentChange, type AgentState, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type Harness as HarnessType, type Storage, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { CONTEXT_LIMITS, createContextExtensionBuilder, type ContextExtensionReplacement, type ConversationContextSnapshot } from "./context/index.js";
import { createSkillTool, SKILL_TOOL_NAME, type SkillTableUpdate } from "./context/skill-tool.js";
import { CRON_RUN_TASK_NAME, CronJobsDoc, createCronFoundation } from "./automation/cron.js";
import {
  automationConversationOf,
  classifyAutomationConversation,
  CronConversationDoc,
  type CronConversationClass,
} from "./automation/cron-conversations.js";
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
  type MappedSession,
} from "./history/scope.js";
import { ensureStoreIdentity, type StoreIdentity } from "./history/store-identity.js";
import { modelKey, parseToolTimeoutSeconds, type ModelReference, type PortConfig } from "./config.js";
import { createVisionHandoffExtension } from "./media/vision-hook.js";
import { VisionHandoff, type VisionHandoffStats } from "./media/vision.js";
import { hasPersistedNanobotContext, preparedContextReplay, preparedTaskModel } from "./recovery/prepared.js";
import { canonicalFuturePath, prepareDataDirectory, inside } from "./store.js";
import { openFullSyncNodeSqliteStorage } from "./storage/sqlite.js";
import {
  assertConfiguredModelAuth,
  createProviderModels,
  nativeModelReference,
  resolveClassifierModel,
  resolveModelChoices,
  type ResolvedModelChoice,
} from "./providers.js";
import { authStorePath, FileCredentialStore } from "./auth/store.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import {
  BACKGROUND_STATUS_LIMITS,
  backgroundLabel,
  emptyBackgroundStatus,
  type BackgroundCronRun,
  type BackgroundDigest,
  type BackgroundStatus,
  type BackgroundTaskState,
  type BackgroundWorker,
} from "./background-status.js";
import {
  createMcpAdmin,
  createMcpIntegration,
  createMcpSurfaceRegistry,
  mcpHasEnabledServers,
  MCP_ADMIN_TOOL_NAME,
  type McpAdmin,
  type McpAdminListing,
  type McpConfig,
  type McpIntegration,
  type McpServerStatus,
  type McpSurfaceRegistry,
} from "./mcp/index.js";
import {
  CLASSIFIER_MODEL_TOOL_NAME,
  CODEMODE_TOOL_NAME,
  createCodeModeIntegration,
  TOOL_SEARCH_TOOL_NAME,
  type CodeModeIntegration,
} from "./extensions/codemode.js";
import {
  WORKER_TASK_NAME,
  createWorkerFoundation,
  workerBackgroundTarget,
  workerChildPolicy,
  type WorkerFoundation,
} from "./workers/worker-task.js";
import { createWorkerTool, WORKER_TOOL_NAME } from "./workers/tool.js";
import { WORKER_LIMITS } from "./workers/limits.js";
import { createWorkerWorkspace, type WorkerWorkspace } from "./workers/workspace.js";
import { createDigestSource, type DigestSource } from "./history/digestion.js";
import { DIGEST_RUN_LIMITS_DEFAULT, type DigestRunLimits } from "./history/digest-limits.js";
import {
  MEMORY_DIGEST_TASK_NAME,
  createMemoryDigest,
  createMemoryDigestScopeExtension,
  hasMemoryDigestTools,
  memoryDigestCurationTools,
  memoryDigestTaskPolicy,
  memoryDigestTaskTarget,
  type MemoryDigest,
  type MemoryDigestStartResult,
  type MemoryDigestStatus,
  type MemoryDigestWriter,
} from "./history/memory-digest.js";
import {
  boundedCapturedTools,
  CODING_TOOL_NAMES,
  ConfigToolCaptureDoc,
  createCodingToolExtension,
  createToolEnvironments,
  type CodingToolName,
  type ToolEnvironments,
} from "./tools/index.js";
import {
  BraveSearchClient,
  PublicWebFetcher,
  WEB_TOOL_NAMES,
  createWebToolExtension,
  type WebRuntimeOptions,
} from "./web/index.js";

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
  /**
   * Native web-tool seams for tests: environment snapshot, controlled resolver and
   * transports, and a fixed clock. No config field selects these, and an absent
   * value uses Node DNS and HTTPS. The ordinary runtime makes no external call at
   * startup, so these cannot silently widen shipped behavior.
   */
  readonly web?: WebRuntimeOptions;
  /**
   * Host seam for bounded memory digestion: the one-turn deadline used only when `digest` config
   * leaves `runTimeoutSeconds` absent. A configured product deadline always wins over this seam; a
   * digest run that exceeds its deadline is cancelled and fails without advancing the cursor. No
   * config field selects this seam, and starting a run stays an explicit host call.
   */
  readonly memoryDigest?: {
    readonly turnTimeoutMs?: number;
  };
}

/** MCP servers configured for this open, with their connection state at the last read. */
export interface GatewayMcpStatus {
  readonly servers: readonly McpServerStatus[];
}

/**
 * Authenticated host surface for MCP management. The model tool performs configuration and login
 * actions directly; this interface lets each foreground adapter consume a callback-shaped line
 * before it becomes model input.
 */
export interface GatewayMcpAdmin {
  list(context: Context): Promise<McpAdminListing>;
  submitCallback(sessionKey: string, text: string, context: Context): Promise<import("./mcp/index.js").McpCallbackResult>;
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
   * Bounded conversation-to-memory digestion. `start` reads one bounded completed-turn batch from the
   * mapped chat sessions and creates one native Durable task, or reports `idle`, `busy` or `refused`
   * without starting anything. It is inert until a host calls it: no command, tool, schedule or
   * provider call exists here, and nothing is sent to a user or channel. A run's cursor advance is
   * durable and only happens after a settled, answered turn. The owner command (`/digest`, also
   * offered to the authenticated Telegram owner) and an explicit ordinary cron job with
   * `intent: "digest"` are the only callers; a failed or cancelled terminal run admits one bounded
   * internal issue report to the origin agent's own conversation, and a successful run is silent.
   */
  readonly memoryDigest: GatewayMemoryDigest;
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
  /**
   * MCP server connection state; absent when MCP is not configured and enabled. A failed server has
   * no tools; its status carries a fixed failure code, never a transport message or configured value.
   */
  readonly mcp: GatewayMcpStatus | undefined;
  /**
   * MCP management host surface. Present only when this gateway loaded an on-disk configuration
   * file. The model tool performs direct management for authenticated mapped chats; this object
   * only lists bounded status and consumes callback-shaped ingress before model admission.
   */
  readonly mcpAdmin?: GatewayMcpAdmin;
  /**
   * Live owner surfaces for direct MCP login delivery. Each foreground adapter attaches the exact
   * session it authenticated; a URL or completion notice never goes to another chat or attachment.
   */
  readonly mcpSurfaces?: McpSurfaceRegistry;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /**
   * Bounded, read-only background activity for one already-mapped conversation: its own live
   * workers and scheduled jobs, plus whether the single workspace-global memory-digestion run is
   * live and whether it belongs to this conversation. It starts, retries and cancels nothing, calls
   * no model, reads no transcript, prompt, tool argument, host path or other chat, and reports no
   * other conversation ID. A conversation that is not an authenticated mapped chat reads nothing.
   */
  backgroundStatus(sessionKey: string, context: Context): Promise<BackgroundStatus>;
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
  /**
   * Start a new context for one mapped chat session and rebuild its host prompt snapshot from
   * the current workspace files, so the next request of the new session sees them. Both halves are one
   * operation: a live run is reported as `busy` before either happens, because a rebuilt snapshot
   * installed mid-run would change the running turn's later provider request, while a reset alone would
   * leave the new context with the old prompt. Requests already prepared are untouched.
   */
  resetSession(sessionKey: string, context: Context): Promise<GatewaySessionReset>;
  close(context: Context): Promise<void>;
}

/**
 * The host entry point for memory digestion. `start` is the whole interface: the caller supplies the
 * authenticated origin conversation and decides when to run; nothing is scheduled, exposed or sent.
 * Call it outside a Session commit: it performs its own commits (a live-task check, the batch read and
 * the task creation) and a nested commit would wait on the line the caller already holds.
 */
export interface GatewayMemoryDigest {
  start(writer: MemoryDigestWriter, context: Context): Promise<MemoryDigestStartResult>;
  /** Bounded read-only status: the live run and this conversation's newest run. No scan, no model. */
  status(writer: MemoryDigestWriter, context: Context): Promise<MemoryDigestStatus>;
}

/** Outcome of {@link Gateway.resetSession}; `busy` means nothing was reset and nothing was rebuilt. */
export type GatewaySessionReset =
  | { readonly status: "reset"; readonly skills: number; readonly promptRebuilt: boolean }
  | { readonly status: "busy" };

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

/** A native task state that is executing work right now; pending, waiting and sleeping are not. */
function executingState(value: string | undefined): BackgroundTaskState | undefined {
  return value === "running" || value === "completing" ? value : undefined;
}

/** A live background target (scheduled run or worker), recovered from its durable checkpoint. */
interface BackgroundRunTarget {
  readonly originConversationId: ConversationId;
  readonly targetConversationId: ConversationId;
}

/**
 * The target of one non-terminal cron run whose checkpoint already chose it. A background run's
 * target is task-owned and deliberately absent from the SessionMap, so it is restored from the run
 * task itself. An origin-mode run's target is the origin, which the map already restores.
 */
function cronBackgroundTarget(task: unknown): BackgroundRunTarget | undefined {
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
  const workerCodingTools = config.workers?.enabled === true
    ? (config.workers.toolAllowlist ?? toolAllowlist).filter((name) =>
        (CODING_TOOL_NAMES as readonly string[]).includes(name)) : [];
  const registeredCodingTools = [...new Set([...toolAllowlist, ...workerCodingTools])];
  const toolsEnabled = registeredCodingTools.length > 0;
  // MCP is a separate, explicit connection authority. Connecting starts external clients, so the
  // config switch must be on and at least one server enabled; otherwise no client is created.
  const mcpConfig = config.mcp;
  let liveMcpConfig: McpConfig | undefined = mcpConfig;
  const mcpConfigured = mcpHasEnabledServers(mcpConfig);
  const mcpSurfaces = config.configFile === undefined ? undefined : createMcpSurfaceRegistry();
  // Native Code Mode composes whatever tools the current conversation already holds. It is
  // independently enableable with `codemode.enabled`; when that block is absent the legacy rule
  // still ties it to configured MCP, and an explicit `false` disables it either way.
  const codeModeConfig = config.codemode;
  const codeModeEnabled = codeModeConfig === undefined ? mcpConfigured : codeModeConfig.enabled;
  // Late-bound so the coding ceiling hook can delegate MCP/Code Mode names to the hook installed
  // later. Absent integrations mean the ceiling blocks those names instead.
  const mcpRef: { current: McpIntegration | undefined } = { current: undefined };
  const codeModeRef: { current: CodeModeIntegration | undefined } = { current: undefined };
  // Direct MCP management: the `mcp` model tool acts for an authenticated mapped chat and needs an
  // on-disk configuration file to write. An SDK host that supplies an object keeps the read-only
  // `gateway.mcp` status and no write surface.
  const mcpAdminRef: { current: McpAdmin | undefined } = { current: undefined };
  // Late-bound live activation: the registry and conversation policy exist only after the harness opens.
  const mcpActivationRef: { current: ((next: McpConfig) => Promise<void>) | undefined } = { current: undefined };
  // Internal agent scheduling: opt-in, and independent of the coding-tool ceiling so a reminder job
  // needs no filesystem authority.
  const cronConfig = config.cron;
  const cronEnabled = cronConfig?.enabled === true;
  // Bounded ordinary background workers: opt-in, native Durable tasks, and independent of the coding
  // tool ceiling so a research worker with no filesystem authority is still possible.
  const workersConfig = config.workers;
  const workersEnabled = workersConfig?.enabled === true;
  // A completed background result is queued only for an origin session that belongs to a channel
  // enabled in this configuration. A disabled channel creates no record, so no later enable can
  // deliver a stale result through a channel the host had switched off.
  const cronDeliveryPrefixes: readonly string[] = config.telegram === undefined ? [] : ["telegram:"];
  // Fail at startup, not at the first tool call, when the default cannot be represented by the host shell.
  const toolTimeoutSeconds = parseToolTimeoutSeconds(config.toolTimeoutSeconds);
  const allowedModels = config.allowedModels ?? [config.model];
  // The gateway and the terminal login/logout command must resolve one private store
  // file. Resolve the future canonical data directory without creating it: a failed
  // startup keeps its existing side-effect-free behavior, and startup below re-checks
  // that the validated, chmodded canonical directory is exactly this one.
  let credentialStoreDir: string | undefined;
  let prepared: { models: Models; model: ModelReference; classifier: ModelReference | undefined };
  if (options.models !== undefined) {
    prepared = { models: options.models, model: nativeModelReference(config.model), classifier: undefined };
  } else {
    try {
      credentialStoreDir = await canonicalFuturePath(config.dataDir);
    } catch (cause) {
      throw new StartupDiagnosticError("workspace", { cause });
    }
    prepared = createProviderModels(config, process.env, new FileCredentialStore(authStorePath(credentialStoreDir)));
  }
  const { models, model } = prepared;
  const choices = resolveModelChoices(models, allowedModels);
  // The one configured classifier model, resolved against the very catalog Code Mode uses.
  const classifierGrant = options.models === undefined
    ? prepared.classifier
    : resolveClassifierModel(models, config.classifierModel);
  const classifierGrantKey = classifierGrant === undefined ? undefined : modelKey(classifierGrant);
  if (options.models === undefined) {
    // Fail before storage opens when a configured chat provider has no usable
    // native credential. Stored OAuth is checked for presence, not refreshed.
    await assertConfiguredModelAuth(models, choices, context.abortSignal);
  }
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
  /**
   * Explicit background model for memory digestion. It is resolved from `digest.preset` or
   * `digest.model` only: the origin conversation's current model and thinking level are never
   * inherited, and absent both, a start is refused. A preset keeps its configured thinking level;
   * a direct model runs at the lowest level it supports (never the foreground default).
   */
  let digestChoice: { readonly model: { readonly provider: string; readonly modelId: string }; readonly thinkingLevel: ModelThinkingLevel } | undefined;
  if (config.digest?.preset !== undefined) {
    const preset = presetCatalog.get(config.digest.preset);
    if (preset === undefined) {
      throw new StartupDiagnosticError("configInvalid", { detail: "digest.preset must name a configured model preset" });
    }
    const level = preset.thinkingLevel ?? "off";
    digestChoice = {
      model: { provider: preset.choice.native.provider, modelId: preset.choice.native.modelId },
      thinkingLevel: preset.choice.thinkingLevels.includes(level) ? level : preset.choice.thinkingLevels[0]!,
    };
  } else if (config.digest?.model !== undefined) {
    const choice = choicesByConfigured.get(modelKey(config.digest.model));
    if (choice === undefined) {
      throw new StartupDiagnosticError("configInvalid", { detail: "digest.model must be included in allowedModels" });
    }
    digestChoice = {
      model: { provider: choice.native.provider, modelId: choice.native.modelId },
      thinkingLevel: choice.thinkingLevels.includes("off") ? "off" : choice.thinkingLevels[0]!,
    };
  }
  // A worker's model comes from the spawning conversation's current selection at launch, unless config
  // names one finite preset. Either way it is a native pair inside the configured model catalog.
  let workerPreset: { readonly model: ModelReference; readonly thinkingLevel: ModelThinkingLevel } | undefined;
  if (workersConfig?.preset !== undefined) {
    const selected = presetCatalog.get(workersConfig.preset);
    if (selected === undefined) {
      throw new StartupDiagnosticError("model", { detail: "workers.preset must name a configured model preset" });
    }
    workerPreset = { model: selected.choice.native, thinkingLevel: selected.thinkingLevel ?? "off" };
  }
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
      preparedModel: (taskId) => {
        // Consume the pin for exactly the saved dispatch that startup found. A later retry
        // re-prepares from the reset AgentDoc model, so a stale task-lifetime pin would apply
        // the old image policy to a different model.
        const key = Number(taskId);
        const model = preparedGenerationModels.get(key);
        if (model !== undefined) preparedGenerationModels.delete(key);
        return model;
      },
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
  const { workspace, extraRoots, canonicalDataDir, dbPath } = preparedDataDirectory;
  if (credentialStoreDir !== undefined && credentialStoreDir !== canonicalDataDir) {
    // The configured dataDir changed between credential resolution and validation (for
    // example a symlink appeared). Refuse instead of reading a different store file.
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
      throw new StartupDiagnosticError("workspace", {
        detail: "worker worktrees must not overlap the SQLite store",
      });
    }
    try {
      workerWorkspace = createWorkerWorkspace({ repositoryRoot: workspace, worktreesRoot });
    } catch (cause) {
      throw new StartupDiagnosticError("workspace", { cause });
    }
  }
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
        // Outbound workspace files need two explicit operator decisions: the `media` opt-in (which
        // also supplies the channel's workspace) and the configured `read` coding tool, so the agent
        // can already open what it sends. Neither is implied by configuring Telegram alone.
        fileSend: config.media !== undefined && toolAllowlist.includes("read"),
      });
  const telegramToolRegistration = telegramTool?.extension.tools?.[0];
  // Config authorization names only mapped ordinary chat conversations (loaded map + scope checked).
  // The call-time hook consults this set; the policy filter reads the same rule from committed state.
  const authorizedChatConversations = new Set<ConversationId>();
  // Native public web tools carry network authority only: they are not coding tools, are never named by
  // `toolAllowlist`, and are offered solely in mapped ordinary chat conversations whose scope this host
  // validated. The search key is resolved once here; an absent value fails startup instead of quietly
  // answering with zero results.
  let webTool: { readonly extension: Extension } | undefined;
  const webConfig = config.web;
  if (webConfig !== undefined && (webConfig.search !== undefined || webConfig.fetch === true)) {
    const searchConfig = webConfig.search;
    let search: BraveSearchClient | undefined;
    if (searchConfig !== undefined) {
      const env = options.web?.env ?? process.env;
      const key = Object.hasOwn(env, searchConfig.keyEnv) ? env[searchConfig.keyEnv] : undefined;
      if (typeof key !== "string" || key.trim() === "") {
        throw new StartupDiagnosticError("webCredential", {
          detail: "Missing credential: set the environment variable named by web.search.keyEnv",
        });
      }
      search = new BraveSearchClient({
        apiKey: key.trim(),
        ...(options.web?.searchTransport === undefined
          ? {}
          : { transport: options.web.searchTransport }),
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
      isAuthorizedChat: (conversationId) => authorizedChatConversations.has(conversationId)
        || workerChildConversations.has(conversationId),
    });
  }
  const webToolRegistrations = webTool?.extension.tools ?? [];
  const webConversations = new Set<ConversationId>();
  const toolExtension: Extension | undefined = toolsEnabled
    ? createCodingToolExtension({
        tools: registeredCodingTools as readonly CodingToolName[],
        ceiling: toolAllowlist,
        capturedCeiling: (conversationId) => workerChildConversations.has(conversationId)
          ? workerCodingTools : toolAllowlist,
        contextTools: [
          ...(options.contextSnapshotProvider === undefined ? [] : [SKILL_TOOL_NAME]),
          ...(cronEnabled ? [CRON_TOOL_NAME] : []),
          ...(workersEnabled ? [WORKER_TOOL_NAME] : []),
          ...(telegramTool === undefined ? [] : [TELEGRAM_TOOL_NAME]),
          // MCP management is a bounded host capability: it carries no filesystem or shell authority
          // of its own, so the coding ceiling must not suppress it. Its own hook limits it to
          // authenticated mapped chats with a live owner surface, and it exists only when the host can
          // write configuration.
          ...(config.configFile === undefined ? [] : [MCP_ADMIN_TOOL_NAME]),
          // History retrieval is read-only over mapped chats and has its own scope checks, so the
          // ceiling must not suppress it when coding tools are enabled.
          ...(historyEnabled ? [HISTORY_TOOL_NAME] : []),
          // Web tools are a separate config capability with their own call-time scope hook. They are
          // exempt from the coding ceiling only while that gated extension is actually installed.
          ...(webTool === undefined ? [] : WEB_TOOL_NAMES),
        ],
        defaultTimeoutSeconds,
        authenticatedChat: (conversationId: ConversationId) => authorizedChatConversations.has(conversationId),
        // Code Mode/tool-search authority comes from their own installed scope hook, independent of
        // MCP connection state. MCP registrations remain gated by the MCP hook. Each predicate is
        // false unless that hook is actually installed, so a stale persisted selection cannot turn
        // this exemption into authority.
        delegatedTools: (name: string) =>
          (codeModeRef.current !== undefined
            && (name === CODEMODE_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME
              || name === CLASSIFIER_MODEL_TOOL_NAME))
          || (mcpRef.current !== undefined && mcpRef.current.ownsTool(name)),
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
  // A worker in worktree mode is an ordinary conversation whose declared cwd and filesystem guard are
  // its own checkout instead of the configured workspace. The root is per task and is never added to
  // the configured roots, so the two workspaces cannot read through each other.
  const workerWorkspaceRoots = new Map<ConversationId, string>();
  // Workers are not mapped chats. Separate scope plus a durable per-tool capture grants research
  // capabilities without Telegram, scheduling or recursive delegation.
  const workerChildConversations = new Set<ConversationId>();
  const workerToolNames = (): string[] => {
    if (config.workers?.enabled !== true) return [];
    const configured = config.workers?.toolAllowlist;
    // Classifier authority is part of the Code Mode grant, never a separately named
    // worker tool. Removing Code Mode from worker config removes it permanently.
    const codeModeGranted = codeModeRef.current !== undefined
      && (configured === undefined || configured.includes(CODEMODE_TOOL_NAME));
    // The classifier nested tool exists only with an explicit configured model grant.
    const classifierGranted = codeModeGranted && classifierGrantKey !== undefined;
    return [
      ...workerCodingTools,
      ...(skillToolRegistration === undefined ? [] : [SKILL_TOOL_NAME]),
      ...webToolRegistrations.map((tool) => tool.name),
      ...(historyEnabled ? [HISTORY_TOOL_NAME] : []),
      ...(codeModeGranted
        ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME]
        : []),
      ...(classifierGranted ? [CLASSIFIER_MODEL_TOOL_NAME] : []),
      ...(mcpRef.current?.toolNames ?? []),
    ].filter((name) => name === CLASSIFIER_MODEL_TOOL_NAME || configured === undefined || configured.includes(name)
      || (configured.includes("mcp") && mcpRef.current?.ownsTool(name)));
  };
  const workerCapabilityExtension = defineExtension({
    name: "nanobot-worker-capabilities",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        if (!workerToolNames().includes(call.name)) {
          return { block: `Tool ${call.name} is outside the configured worker grants` };
        }
        if (!workerChildConversations.has(api.conversationId)) {
          return { block: "Worker capability is no longer active" };
        }
        const capture = await api.snapshot(ConfigToolCaptureDoc, api.conversationId, ctx);
        if (capture === undefined || !authorizedChatConversations.has(capture.originConversationId as ConversationId)
          || !capture.tools.includes(call.name)) {
          return { block: `Tool ${call.name} is outside this worker's captured authority` };
        }
        if (call.name === CLASSIFIER_MODEL_TOOL_NAME) {
          // The durable capture, not the current config, decides which classifier model this
          // worker may still call. A pruned or retired identity never returns.
          const model = call.arguments.model;
          const provider = typeof model === "object" && model !== null ? (model as Record<string, unknown>).provider : undefined;
          const id = typeof model === "object" && model !== null ? (model as Record<string, unknown>).id : undefined;
          if (typeof provider !== "string" || typeof id !== "string"
            || capture.classifierModel !== modelKey({ provider, modelId: id })) {
            return { block: "Classifier model is outside this worker's captured authority" };
          }
        }
        return undefined;
      },
    })],
  });
  // Live memory-digestion targets. They are task-owned like a worker child, but deliberately get
  // no Code Mode, no MCP/web/channel/history tool and no shell: only the curation-scope hook and the
  // captured Markdown tools. The set is rebuilt from live digest tasks on reopen.
  const digestTargetConversations = new Set<ConversationId>();
  // Accepted bounds of each live target, restored from its task input on reopen. The scope hook reads
  // them at call time, so config changes in a later open cannot widen an already-started run.
  const digestTargetLimits = new Map<ConversationId, DigestRunLimits>();
  const digestLimits: DigestRunLimits = Object.freeze({
    ...DIGEST_RUN_LIMITS_DEFAULT,
    ...(config.digest?.entriesPerBatch === undefined ? {} : { entriesPerBatch: config.digest.entriesPerBatch }),
    ...(config.digest?.charsPerBatch === undefined ? {} : { charsPerBatch: config.digest.charsPerBatch }),
    ...(config.digest?.maxToolCalls === undefined ? {} : { maxToolCalls: config.digest.maxToolCalls }),
    ...(config.digest?.maxRequests === undefined ? {} : { maxRequests: config.digest.maxRequests }),
    ...(config.digest?.maxInputTokens === undefined ? {} : { maxInputTokens: config.digest.maxInputTokens }),
    ...(config.digest?.maxChangedFiles === undefined ? {} : { maxChangedFiles: config.digest.maxChangedFiles }),
    ...(config.digest?.maxDiffChars === undefined ? {} : { maxDiffChars: config.digest.maxDiffChars }),
    // A product-configured run deadline wins over the host test seam; the seam only fills the gap
    // when config leaves `runTimeoutSeconds` absent.
    runTimeoutMs: config.digest?.runTimeoutSeconds !== undefined
      ? config.digest.runTimeoutSeconds * 1000
      : options.memoryDigest?.turnTimeoutMs ?? DIGEST_RUN_LIMITS_DEFAULT.runTimeoutMs,
  });
  const digestScopeExtension = createMemoryDigestScopeExtension(workspace, {
    harness: () => {
      if (harnessRef.current === undefined) throw new Error("The runtime is not open");
      return harnessRef.current;
    },
    limitsFor: (conversationId) => digestTargetLimits.get(conversationId),
  });
  const digestSourceRef: { current: DigestSource | undefined } = { current: undefined };
  const workerEnvironments = new Map<string, ToolEnvironments>();
  const environmentFor = (conversationId: ConversationId, ctx: Context) => {
    const root = workerWorkspaceRoots.get(conversationId);
    if (root === undefined) return toolEnvironments!.forConversation(conversationId, ctx);
    let environments = workerEnvironments.get(root);
    if (environments === undefined) {
      environments = createToolEnvironments({
        workspaceRoot: root,
        allowedRoots: [],
        sandbox: config.toolSandbox ?? "host",
        ...(config.bwrapPath === undefined ? {} : { bwrapPath: config.bwrapPath }),
        ...(toolTimeoutSeconds === undefined ? {} : { timeoutSeconds: toolTimeoutSeconds }),
      });
      workerEnvironments.set(root, environments);
    }
    return environments.forConversation(conversationId, ctx);
  };
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
    // MCP tools and Code Mode/tool-search exist only in an authenticated mapped chat conversation.
    // Code Mode is selected independently of MCP connection state; each bundle is selected only
    // while it is live for this open.
    if (authorizedChatConversations.has(conversationId)) {
      if (mcpRef.current !== undefined) selected.push(mcpRef.current.extension);
      if (codeModeRef.current !== undefined) selected.push(...codeModeRef.current.extensions);
      // MCP management is a mapped-chat capability only: a worker, fork, root or scheduled run
      // never proposes configuration or account authority.
      if (mcpAdminRef.current !== undefined) selected.push(mcpAdminRef.current.extension);
    } else if (workerChildConversations.has(conversationId)) {
      selected.push(workerCapabilityExtension);
      if (mcpRef.current !== undefined) selected.push(mcpRef.current.extension);
      if (codeModeRef.current !== undefined) selected.push(...codeModeRef.current.extensions);
      if (historyTool !== undefined) selected.push(historyTool.extension);
      if (webTool !== undefined) selected.push(webTool.extension);
    }
    // A live digest target keeps its narrowing path hook across a reopen. The hook grants nothing;
    // it only refuses paths outside the curation scope and makes write create-only.
    if (digestTargetConversations.has(conversationId)) selected.push(digestScopeExtension);
    if (options.contextSnapshotProvider && contextExtension && contextConversations.has(conversationId)) {
      selected.push(contextExtension);
    }
    if (skillTool && contextConversations.has(conversationId) && skillConversations.has(conversationId)) {
      selected.push(skillTool.extension);
    }
    if (historyTool && historyConversations.has(conversationId)) selected.push(historyTool.extension);
    if (webTool && webConversations.has(conversationId)) selected.push(webTool.extension);
    if (telegramTool && telegramChatConversations.has(conversationId)) selected.push(telegramTool.extension);
    if (cronFoundation && cronTool && cronOwners.has(conversationId)) {
      selected.push(cronFoundation.extension, cronTool.extension);
    }
    if (workerTool && workerSpawners.has(conversationId)) selected.push(workerTool.extension);
    return { extensions: selected };
  };
  const toolRegistrations = new Map<string, ToolRegistration>(
    [...(toolExtension?.tools ?? []), ...webToolRegistrations,
      ...(historyToolRegistration === undefined ? [] : [historyToolRegistration]),
      ...(skillToolRegistration === undefined ? [] : [skillToolRegistration])]
      .map((tool) => [tool.name, tool]),
  );
  // Origin sessions only: a scheduled run's automation conversation is not an origin session, so it
  // cannot schedule further jobs. Owners are keyed by the mapped session key.
  const cronOwners = new Map<ConversationId, CronOwner>();
  // Scheduled runs' automation conversations, by the durable class this host recorded for them. They
  // are ownerless so they outlive every run task, which means the class has to be carried explicitly:
  // it keeps them out of chat scope, it denies them every capability set below, and it is how a
  // reopened gateway finds a live run's target. Rebuilt from committed cron documents at open and
  // extended by `prepare`, so a conversation created by this process is classified too.
  const automationConversations = new Map<ConversationId, {
    readonly originConversationId: ConversationId;
    readonly conversationClass: CronConversationClass;
    readonly jobId: string | null;
  }>();
  /** This host's scope record for one conversation: its class, never inferred from absence. */
  const scopeRecordFor = async (tx: Tx, conversationId: ConversationId) => {
    const record = await tx.conversation(conversationId);
    if (record === undefined) return undefined;
    return automationConversations.has(conversationId) ? { ...record, automation: true } : record;
  };
  /** Automation conversations in episode-catalog shape; never chat, so no session key is implied. */
  const automationSessions = (): HistoryChatSession[] => [...automationConversations.keys()]
    .map((conversationId) => ({ sessionKey: `cron-automation:${conversationId}`, conversationId }));
  // Worker spawning is the same rule, and deliberately not inherited: only a validated mapped chat
  // conversation may start a worker, so a worker's own task-owned conversation can never recurse.
  const workerSpawners = new Set<ConversationId>();
  const harnessRef: { current?: HarnessType } = {};
  // The snapshot-install path, late-bound because cron's `prepare` can only call it once
  // Harness.open() has run. It reports whether skills were installed for that conversation, and it
  // rebuilds a background target's snapshot instead of reusing the one an earlier run installed.
  const contextInstallerRef: {
    current?: (sessionKey: string, conversationId: ConversationId, ctx: Context) => Promise<boolean>;
  } = {};
  const cronFoundation = cronEnabled
    ? createCronFoundation({
        now,
        // A `digest` occurrence is the same bounded native entry a manual command uses. It is
        // invoked with the authenticated origin conversation (the job's own document conversation),
        // never a task-owned target; `start` re-checks that origin and the current curation
        // allowlist, so a narrowed config refuses instead of widening. The digest task reports its
        // own completion internally, so no cron outbox delivery is queued for this intent.
        digest: async ({ originConversationId }, ctx) => {
          const harness = harnessRef.current;
          if (harness === undefined) return { status: "error", error: "the runtime is not open" };
          const conversation = await harness.conversation(originConversationId, ctx);
          if (conversation === undefined) {
            return { status: "error", error: "the digest origin conversation is missing" };
          }
          try {
            const result = await memoryDigest.start({
              id: conversation.id,
              commit: (change, inner) => conversation.commit(change, inner),
            }, ctx);
            if (result.status === "started") return { status: "ok", error: null };
            if (result.status === "busy") {
              return { status: "ok", error: `run ${result.taskId} is still active; nothing new was started` };
            }
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
        // Each run starts a new episode in its automation conversation: the foundation asks for the
        // same native reset `/new` places, so earlier entries stay stored and searchable while this
        // run's model context starts empty. It is admitted before the run's own input, and no stored
        // entry is ever trimmed or rewritten.
        reset: async (targetConversationId, ctx) => {
          const harness = harnessRef.current;
          if (harness === undefined) return;
          const conversation = await harness.conversation(targetConversationId, ctx);
          if (conversation === undefined) return;
          await conversation.reset(undefined, ctx);
        },
        // A background run is an automation conversation whose authority is prepared per run. It
        // captures the ceiling its authenticated origin currently has; the call-time hook still
        // requires that origin and the current config, so the capture is a subset, never new
        // authority. An origin-mode run answers inside the conversation that already has the
        // configured authority, so it needs no capture.
        prepare: async ({ tx, originConversationId, targetConversationId, background }, ctx) => {
          if (!background) return;
          // Classify the conversation first, from the durable marker the foundation wrote in the same
          // commit: a forged or stale mapping can never be mistaken for chat via this host, and a
          // failure later in this preparation cannot leave the conversation chat-like in memory.
          const classified = automationConversationOf(
            await tx.doc(CronConversationDoc, targetConversationId),
          );
          if (classified !== undefined) {
            automationConversations.set(targetConversationId, {
              originConversationId,
              conversationClass: classified.conversationClass,
              jobId: classified.jobId,
            });
          }
          // Fail closed on a run whose origin cannot be attributed to a known owner: it gets no
          // captured authority, so every effectful call stays denied.
          const owner = cronOwners.get(originConversationId);
          const captured: string[] = [];
          if (owner !== undefined) {
            const capture = await tx.doc(ConfigToolCaptureDoc, targetConversationId);
            capture.originConversationId = originConversationId;
            capture.tools = authorizedChatConversations.has(originConversationId) ? [...toolAllowlist] : [];
            // A scheduled run never holds Code Mode or classifier authority.
            capture.classifierModel = null;
            captured.push(...capture.tools);
          } else {
            await tx.retireDoc(ConfigToolCaptureDoc, targetConversationId);
          }
          // The automation conversation is default-deny between runs, so it also receives the
          // origin's workspace context through the same snapshot path: bootstrap/AGENTS, the memory
          // manifest, the skill summary and the read-only `skill` tool. That snapshot is rebuilt in
          // this same preparation, so a later episode renders the workspace as it is now. An origin
          // with no known owner skips this and keeps the run default-deny. The cron tool and
          // foundation are never offered here.
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
          // The vision hook carries no tool authority. A scheduled background run is an automation
          // conversation with only captured tools, so it needs this non-authoritative extension
          // explicitly; otherwise a read-tool image would bypass the flagged-preset handoff.
          if (visionExtension !== undefined) extensions.push(visionExtension);
          if (toolExtension !== undefined) extensions.push(toolExtension);
          if (contextConversations.has(targetConversationId) && contextExtension !== undefined) {
            extensions.push(contextExtension);
          }
          if (skillsInstalled && skillTool !== undefined) extensions.push(skillTool.extension);
          // An automation conversation is ownerless, so Durable copies no agent state into it: the
          // workspace, model and thinking level this run uses are prepared here, per run, instead of
          // being inherited once at creation. History keeps no authority either way.
          const originAgent = await tx.doc(AgentDoc, originConversationId);
          await configure(tx, targetConversationId, {
            tools,
            modelTools: tools,
            extensions,
            cwd: workspace,
            ...(originAgent.model === undefined ? {} : { model: { ...originAgent.model } }),
            ...(originAgent.thinkingLevel === undefined ? {} : { thinkingLevel: originAgent.thinkingLevel }),
          });
        },
        // A separate run target's captured authority ends with the run: retire its capture document
        // and stop offering its tools in the same commit that records the terminal outcome, so a
        // finished or cancelled run cannot be used for a later admission. The automation
        // conversation itself stays: its history is the job's ongoing activity, and the next run
        // prepares its own authority again. An origin-mode run answers in the origin conversation
        // itself, so that conversation keeps its configured tools, cron ownership and context, and
        // none of its documents are retired.
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
          // answer is substituted for it. A job's `silent` setting, or an exact trimmed `[SILENT]`
          // answer, suppresses the automatic delivery instead; a failed occurrence still queues its
          // notice. The origin session key is also the channel locator: a key
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
            // Suppression stops only this automatic channel delivery: the answer stays in the run's
            // conversation, and `[SILENT]` has no special meaning in an ordinary chat reply. A
            // `silent` job suppresses every successful occurrence, including an empty answer; the
            // marker suppresses just its own occurrence in either mode. A failed run never reaches
            // this branch and keeps its sanitized notice.
            if (job.silent === true || body === "[SILENT]") return;
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
        digestAvailable: (conversationId) => digestChoice !== undefined
          && authorizedChatConversations.has(conversationId)
          && hasMemoryDigestTools(toolAllowlist),
      });
  const cronToolRegistration = cronTool?.extension.tools?.[0];
  // Bounded ordinary background workers. The foundation owns the Durable task, its child conversation
  // and the internal result event; the runtime supplies only capture, model, workspace and retirement,
  // exactly as it does for a scheduled run. A worker is never an origin: its target is task-owned and
  // carries captured tools only.
  const workerFoundation: WorkerFoundation | undefined = workersEnabled && workerWorkspace !== undefined
    ? createWorkerFoundation({
        now,
        maxConcurrent: workersConfig?.maxConcurrent ?? WORKER_LIMITS.defaultConcurrent,
        allowModel: (candidate) => choicesByNative.has(modelKey(candidate)),
        spawnModel: async (tx, conversationId) => {
          const state = await tx.doc(AgentDoc, conversationId);
          const choice = choiceFromState(state) ?? defaultChoice;
          const level = state?.thinkingLevel !== undefined && choice.thinkingLevels.includes(state.thinkingLevel)
            ? state.thinkingLevel
            : fallbackThinkingLevel(choice);
          return { model: choice.native, thinkingLevel: level };
        },
        ...(workerPreset === undefined ? {} : { preset: workerPreset }),
        workspace: workerWorkspace!,
        prepare: async ({ tx, spawnerConversationId, targetConversationId: target, input, workspace: targetWorkspace, ctx }) => {
          // The worker starts default-deny. Its capture comes from the independent worker config
          // (or inherited defaults), and call-time hooks still require an authorized spawning chat.
          // A worker-only coding grant never widens the foreground or other task targets.
          const authorized = authorizedChatConversations.has(spawnerConversationId);
          const capture = await tx.doc(ConfigToolCaptureDoc, target);
          capture.originConversationId = spawnerConversationId;
          capture.tools = authorized ? workerToolNames() : [];
          // Classifier model authority is captured with the tool name, so a config
          // change narrows it durably instead of re-admitting a stale model later.
          capture.classifierModel = capture.tools.includes(CLASSIFIER_MODEL_TOOL_NAME)
            ? classifierGrantKey ?? null
            : null;
          // The same snapshot path a scheduled run uses: bootstrap/AGENTS, the memory manifest, the
          // skill summary and the read-only `skill` tool, only when the host configured a provider and
          // the spawning session is mapped.
          const spawnerKey = sessionKeyForConversation.get(spawnerConversationId);
          const skillsInstalled = spawnerKey !== undefined && contextInstallerRef.current !== undefined
            ? await contextInstallerRef.current(spawnerKey, target, ctx)
            : false;
          // Explicit worker grants are independent of the foreground coding ceiling. Snapshot
          // delivery cannot add a skill tool the worker configuration withheld.
          if (!skillsInstalled) capture.tools = capture.tools.filter((name) => name !== SKILL_TOOL_NAME);
          const tools = capture.tools.flatMap((name) => {
            const tool = toolRegistrations.get(name);
            return tool === undefined ? [] : [tool];
          });
          const extensions: Extension[] = [];
          // The vision hook carries no tool authority; a fresh captured-tool conversation needs it
          // explicitly or a read-tool image would bypass the flagged-preset handoff.
          if (visionExtension !== undefined) extensions.push(visionExtension);
          if (toolExtension !== undefined) extensions.push(toolExtension);
          if (contextConversations.has(target) && contextExtension !== undefined) extensions.push(contextExtension);
          if (skillsInstalled && skillTool !== undefined) extensions.push(skillTool.extension);
          if (codeModeRef.current !== undefined) extensions.push(...codeModeRef.current.extensions);
          if (mcpRef.current !== undefined) extensions.push(mcpRef.current.extension);
          if (webTool !== undefined) extensions.push(webTool.extension);
          if (historyTool !== undefined) extensions.push(historyTool.extension);
          extensions.push(workerCapabilityExtension);
          const workerChoice = choicesByNative.get(modelKey(input.model));
          await configure(tx, target, {
            cwd: targetWorkspace.path,
            model: input.model,
            // The captured level may predate a provider catalog change; the current catalog wins.
            thinkingLevel: workerChoice !== undefined && workerChoice.thinkingLevels.includes(input.thinkingLevel)
              ? input.thinkingLevel
              : workerChoice === undefined ? "off" : fallbackThinkingLevel(workerChoice),
            tools,
            // The classifier nested tool is script-reachable only, never a direct model tool.
            modelTools: tools.filter((tool) =>
              !mcpRef.current?.ownsTool(tool.name) && tool.name !== CLASSIFIER_MODEL_TOOL_NAME),
            extensions,
          });
        },
        finalize: async ({ tx, targetConversationId: target, settlement }) => {
          // A worker's captured authority ends in the same terminal commit that records its outcome.
          // Code Mode selection goes with it: a terminal or cancelled child has nothing left to
          // compose, and the retired capture denies any stale nested call at call time.
          await tx.retireDoc(ConfigToolCaptureDoc, target);
          await configure(tx, target, {
            tools: [],
            modelTools: [],
            extensions: visionExtension === undefined ? [] : [visionExtension],
          });
          workerWorkspaceRoots.delete(target);
          workerChildConversations.delete(target);
          if (settlement.status !== "ok" || settlement.answerEntryId === null) {
            return { result: null, error: settlement.error };
          }
          const answer = await tx.entry(AssistantEntry, settlement.answerEntryId as EntryId);
          const message = answer?.model?.[0] as AssistantMessage | undefined;
          const body = (message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "").trim();
          return { result: body === "" ? null : body, error: null };
        },
        trackWorkspace: (conversationId, workspaceInfo) => {
          workerChildConversations.add(conversationId);
          if (workspaceInfo.mode === "worktree") workerWorkspaceRoots.set(conversationId, workspaceInfo.path);
          else workerWorkspaceRoots.delete(conversationId);
        },
        commit: (change, ctx) => {
          if (harnessRef.current === undefined) throw new Error("The runtime is not open");
          return harnessRef.current.commit(change, ctx);
        },
      })
    : undefined;
  const workerTool = workerFoundation === undefined
    ? undefined
    : createWorkerTool({
        foundation: workerFoundation,
        spawnerFor: (conversationId) => workerSpawners.has(conversationId),
        harness: () => {
          if (harnessRef.current === undefined) throw new Error("The runtime is not open");
          return harnessRef.current;
        },
        precheckWorktree: () => workerWorkspace!.precheck(),
      });
  const workerToolRegistration = workerTool?.extension.tools?.[0];
  /**
   * Bounded conversation-to-memory digestion. It is registered even when no host will start it so a
   * task persisted by an earlier open can resume, but it is otherwise inert: `start` is the only
   * entry and nothing schedules, notifies or creates a conversation by itself. Its target is a
   * task-owned conversation holding only the origin's curated Markdown subset (read/write/edit) and
   * the curation-scope hook, so it never inherits shell, network, channel, history or worker authority.
   */
  const memoryDigest: MemoryDigest = createMemoryDigest({
    harness: () => {
      if (harnessRef.current === undefined) throw new Error("The runtime is not open");
      return harnessRef.current;
    },
    source: () => {
      if (digestSourceRef.current === undefined) throw new Error("The digest source is not open");
      return digestSourceRef.current;
    },
    workspaceRoot: workspace,
    now,
    scopeExtension: digestScopeExtension,
    limits: digestLimits,
    // Explicit background selection only: never the origin conversation's current model or thinking.
    model: async () => digestChoice,
    allowModel: (candidate) => choicesByNative.has(modelKey(candidate)),
    modelContext: (candidate) => choicesByNative.get(modelKey(candidate))?.model,
    curationTools: (conversationId) => authorizedChatConversations.has(conversationId)
      ? memoryDigestCurationTools(toolAllowlist)
      : [],
    prepare: async ({ tx, originConversationId, targetConversationId: target, input }) => {
      // The fresh task-owned target starts default-deny. This capture is the origin's current
      // curated subset, and the coding-tool hook still requires that origin and the current
      // allowlist at call time, so a capture is never wider than configured authority.
      const capture = await tx.doc(ConfigToolCaptureDoc, target);
      capture.originConversationId = originConversationId;
      capture.tools = authorizedChatConversations.has(originConversationId)
        ? memoryDigestCurationTools(toolAllowlist)
        : [];
      // A digest run never holds Code Mode or classifier authority.
      capture.classifierModel = null;
      const tools = capture.tools.flatMap((name) => {
        const tool = toolRegistrations.get(name);
        return tool === undefined ? [] : [tool];
      });
      const extensions: Extension[] = [];
      // The vision hook carries no tool or memory authority; it is selected so a digest target can
      // never send an unbounded raw image to a flagged text-only model. The curation hook narrows.
      if (visionExtension !== undefined) extensions.push(visionExtension);
      if (toolExtension !== undefined) extensions.push(toolExtension);
      extensions.push(digestScopeExtension);
      const choice = choicesByNative.get(modelKey(input.model));
      await configure(tx, target, {
        cwd: workspace,
        model: input.model,
        // A pinned level that left the provider catalog falls back inside the pinned model only.
        thinkingLevel: choice !== undefined && choice.thinkingLevels.includes(input.thinkingLevel as ModelThinkingLevel)
          ? input.thinkingLevel as ModelThinkingLevel
          : choice === undefined ? "off" : choice.thinkingLevels.includes("off")
            ? "off"
            : choice.thinkingLevels[0]!,
        tools,
        modelTools: tools,
        extensions,
      });
      digestTargetConversations.add(target);
      digestTargetLimits.set(target, { ...input.limits });
    },
    finalize: async ({ tx, targetConversationId: target }) => {
      // A digest target's captured authority ends in the same terminal commit that records the
      // outcome. The curation hook goes with it: a terminal conversation keeps nothing to write.
      await tx.retireDoc(ConfigToolCaptureDoc, target);
      await configure(tx, target, {
        tools: [],
        modelTools: [],
        extensions: visionExtension === undefined ? [] : [visionExtension],
      });
      digestTargetConversations.delete(target);
      digestTargetLimits.delete(target);
    },
  });
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
    // History is read-only over mapped chats; ordinary workers may capture the retrieval tool too.
    const historyTools = historyToolRegistration !== undefined
      && (historyConversations.has(conversationId) || workerChildConversations.has(conversationId))
      ? [historyToolRegistration]
      : [];
    // Telegram interaction is a scoped channel capability for one mapped private chat, not a coding
    // tool. The live adapter rechecks the current allowlist and observed target at call time.
    const telegramTools = telegramToolRegistration !== undefined && telegramChatConversations.has(conversationId)
      ? [telegramToolRegistration]
      : [];
    const webTools = webConversations.has(conversationId) || workerChildConversations.has(conversationId)
      ? [...webToolRegistrations] : [];
    // Worker management is a spawning-conversation capability, not filesystem or shell authority. The
    // worker's own task-owned conversation is never in this set, so it cannot start another worker.
    const workerTools = workerToolRegistration !== undefined && workerSpawners.has(conversationId)
      ? [workerToolRegistration]
      : [];
    // MCP management is exempt from the coding ceiling and offered to authenticated mapped chats
    // alone (never a worker or task-owned scope); its model tool acts directly.
    const mcpAdminTools = mcpAdminRef.current !== undefined && authorizedChatConversations.has(conversationId)
      ? [...(mcpAdminRef.current.extension.tools ?? [])]
      : [];
    return [...skillTools, ...cronTools, ...historyTools, ...telegramTools, ...webTools, ...workerTools, ...mcpAdminTools];
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
    const worker = workerChildConversations.has(conversationId);
    const captured = worker ? backgroundTools ?? new Set<string>() : undefined;
    const contextTools = contextToolsFor(conversationId).filter((tool) =>
      !worker || captured!.has(tool.name));
    // MCP stays deferred in both mapped chats and captured workers.
    const authorized = authorizedChatConversations.has(conversationId);
    const codeModeOfferedBase = codeModeRef.current !== undefined
      && (authorized || captured?.has(CODEMODE_TOOL_NAME));
    let offered = codeModeOfferedBase ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME] : [];
    // Classifier calls are native nested ToolTasks of Code Mode. They stay out of
    // `modelTools`, so the model cannot call them directly, and no other scope
    // receives them without the Code Mode grant and an explicit configured model.
    const classifierOffered = (): string[] => classifierGrantKey === undefined
      ? []
      : [CLASSIFIER_MODEL_TOOL_NAME];
    let classifierTools = codeModeOfferedBase ? classifierOffered() : [];
    const deferred = [...(mcpRef.current?.toolNames ?? [])].filter((name) => authorized || captured?.has(name));
    const withContext = (names: readonly string[]): Pick<AgentChange, "tools" | "modelTools"> => {
      const tools = [
        ...toolFilterFromNames(names).tools,
        ...toolFilterFromNames(offered).tools,
        ...toolFilterFromNames(classifierTools).tools,
        ...toolFilterFromNames(deferred).tools,
        ...contextTools,
      ];
      const modelTools = [
        ...toolFilterFromNames(names).tools,
        ...toolFilterFromNames(offered).tools,
        ...contextTools,
      ];
      return { tools, modelTools };
    };
    if (worker) {
      const capture = await tx.doc(ConfigToolCaptureDoc, conversationId);
      capture.tools = workerToolNames().filter((name) =>
        captured!.has(name) && capture.tools.includes(name));
      // Use the pruned durable capture, not the launch input, so removing Code Mode
      // from worker config or a reopen cannot resurrect classifiers from a stale grant.
      const capturedCodeMode = codeModeRef.current !== undefined
        && workerToolNames().includes(CODEMODE_TOOL_NAME)
        && capture.tools.includes(CODEMODE_TOOL_NAME);
      // Classifier authority is captured by model identity, not only by tool name: a
      // removed or changed configuration is pruned in this same commit, so a later
      // re-enable cannot resurrect it for an existing worker.
      capture.classifierModel = capturedCodeMode
        && capture.tools.includes(CLASSIFIER_MODEL_TOOL_NAME)
        && classifierGrantKey !== undefined
        && capture.classifierModel === classifierGrantKey
        ? classifierGrantKey
        : null;
      offered = capturedCodeMode ? [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME] : [];
      classifierTools = capturedCodeMode && capture.classifierModel !== null
        ? [CLASSIFIER_MODEL_TOOL_NAME]
        : [];
      return withContext(capture.tools.filter((name) => workerCodingTools.includes(name)));
    }
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
  /**
   * Reapply tool and extension policy after a live MCP change. Authenticated chats may gain the new
   * registration; existing workers are pruned against their durable capture, never widened by it.
   */
  async function refreshMcpConversationPolicy(): Promise<void> {
    const open = harnessRef.current;
    if (open === undefined) return;
    let failure: unknown;
    for (const conversationId of new Set([...authorizedChatConversations, ...workerChildConversations])) {
      try {
        const conversation = await open.conversation(conversationId, context);
        if (conversation === undefined) continue;
        if (!workerChildConversations.has(conversationId)) {
          await applyConversationPolicy(conversation, context);
          continue;
        }
        // A worker keeps its pinned model, cwd and thinking level. Reapply only its extension
        // selection and the capture intersection: a newly added MCP tool is never added to an
        // existing capture, while a removed one is pruned in this same commit.
        await conversation.commit(async (tx) => {
          const capture = await tx.doc(ConfigToolCaptureDoc, conversationId);
          const alreadyCaptured = new Set(capture.tools);
          const toolFilter = await toolFilterFor(tx, conversationId, alreadyCaptured);
          await configure(tx, conversationId, {
            ...extensionsPolicy(conversationId),
            ...toolFilter,
          });
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
          // Backstop: a job whose conversation is not chat scope never reaches a provider call. An
          // automation conversation and a summary task's own target are equally out of scope.
          scope: (tx: Tx, conversationId: ConversationId): Promise<ChatScopeExclusion | undefined> =>
            readChatScope((id) => scopeRecordFor(tx, id), conversationId, root.id),
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
    // MCP connects before the registry is built so every discovered tool is in the initial
    // registry. A failed server contributes nothing and is reported through `gateway.mcp`; the
    // whole open fails only for an internal error, and the catch below tears down whatever started.
    // OAuth grants live under the same canonical data directory as the private credential store: a
    // private `0600` file like the provider credential store, on the same trust boundary. Any process
    // running as this user can read it — including the model's own shell and an MCP stdio server — and
    // that is the accepted posture; no model-facing surface returns its content (see MCP.md).
    const mcpDataDir = credentialStoreDir ?? config.dataDir;
    let registeredMcpToolNames = new Set<string>();
    const replaceMcpRegistrations = (integration: McpIntegration): void => {
      for (const name of registeredMcpToolNames) toolRegistrations.delete(name);
      registeredMcpToolNames = new Set(integration.toolNames);
      for (const tool of integration.extension.tools ?? []) {
        if (registeredMcpToolNames.has(tool.name)) toolRegistrations.set(tool.name, tool);
      }
    };
    if (mcpConfigured && mcpConfig !== undefined) {
      mcpRef.current = await createMcpIntegration({
        config: mcpConfig,
        workspace,
        dataDir: mcpDataDir,
        isAuthorizedChat: (conversationId: ConversationId) => authorizedChatConversations.has(conversationId)
          || workerChildConversations.has(conversationId),
        delegatedToolNames: [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME],
      });
      replaceMcpRegistrations(mcpRef.current);
    }
    // Direct MCP management is performed by the model tool for authenticated mapped chats. This host
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
          registry.install(integration.extension);
          codeModeRef.current?.updateNamespaces(integration.namespaces);
          await refreshMcpConversationPolicy();
        },
        servers: () => mcpRef.current?.status ?? [],
        sessionKeyFor: (conversationId) => sessionKeyForConversation.get(conversationId),
        surfaces: mcpSurfaces,
        isAuthorizedChat: (conversationId: ConversationId) => authorizedChatConversations.has(conversationId),
      } as Parameters<typeof createMcpAdmin>[0]);
      for (const tool of mcpAdminRef.current.extension.tools ?? []) toolRegistrations.set(tool.name, tool);
    }
    // Code Mode is an independent compositor, not an MCP wrapper. It gets MCP namespaces only from
    // an actually connected integration; without MCP it composes the conversation's other tools.
    if (codeModeEnabled) {
      codeModeRef.current = createCodeModeIntegration({
        namespaces: mcpRef.current?.namespaces ?? [],
        // Native `models.*`: only the one configured classifier model plus read-only
        // catalog helpers. Image generation is not registered by this integration.
        models: true,
        ...(classifierGrant === undefined ? {} : { classifierModel: classifierGrant }),
        // A live worker child may compose its captured tools; every nested call still passes that
        // tool's own call-time hook, so retirement or a narrowed ceiling denies stale composition.
        isAuthorizedChat: (conversationId: ConversationId) =>
          authorizedChatConversations.has(conversationId) || workerChildConversations.has(conversationId),
      });
      for (const extension of codeModeRef.current.extensions) {
        for (const tool of extension.tools ?? []) toolRegistrations.set(tool.name, tool);
      }
    }
    const registry = createRegistry();
    if (episodeSummaries !== undefined) registry.install(episodeSummaries.extension);
    if (visionExtension) registry.install(visionExtension);
    if (toolExtension) registry.install(toolExtension);
    if (mcpRef.current !== undefined) registry.install(mcpRef.current.extension);
    if (mcpAdminRef.current !== undefined) registry.install(mcpAdminRef.current.extension);
    if (codeModeRef.current !== undefined) {
      for (const extension of codeModeRef.current.extensions) registry.install(extension);
    }
    if (skillTool) registry.install(skillTool.extension);
    if (historyTool) registry.install(historyTool.extension);
    if (telegramTool) registry.install(telegramTool.extension);
    if (webTool) registry.install(webTool.extension);
    if (cronFoundation) registry.install(cronFoundation.extension);
    if (cronTool) registry.install(cronTool.extension);
    if (workerFoundation) registry.install(workerFoundation.extension);
    if (workerTool) registry.install(workerTool.extension);
    registry.install(workerCapabilityExtension);
    registry.install(memoryDigest.extension);
    registry.install(digestScopeExtension);
    storage = await openFullSyncNodeSqliteStorage(dbPath, context);
    const harnessOptions = {
      models,
      registry,
      conversationCreated: denyNewConversation,
      ...(toolEnvironments === undefined
        ? {}
        : {
            env: (target: { readonly conversationId: ConversationId }, ctx: Context) =>
              environmentFor(target.conversationId, ctx),
          }),
    };
    harness = await Harness.open(storage, harnessOptions, context);
    harnessRef.current = harness;
    mcpActivationRef.current = async (next) => {
      let integration = mcpRef.current;
      if (integration === undefined) {
        if (!mcpHasEnabledServers(next)) {
          liveMcpConfig = next;
          return;
        }
        integration = await createMcpIntegration({
          config: next,
          workspace,
          dataDir: mcpDataDir,
          isAuthorizedChat: (conversationId: ConversationId) => authorizedChatConversations.has(conversationId)
            || workerChildConversations.has(conversationId),
          delegatedToolNames: [CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME],
        });
        mcpRef.current = integration;
        registry.install(integration.extension);
        replaceMcpRegistrations(integration);
      } else {
        await integration.applyConfig(next);
        registry.install(integration.extension);
        replaceMcpRegistrations(integration);
      }
      liveMcpConfig = next;
      // Legacy Code Mode follows MCP when its own block is absent. A live first server therefore
      // installs it without a restart; an explicit `codemode.enabled: false` stays the owner's choice.
      if (codeModeRef.current === undefined && codeModeConfig === undefined && mcpHasEnabledServers(next)) {
        codeModeRef.current = createCodeModeIntegration({
          namespaces: integration.namespaces,
          models: true,
          ...(classifierGrant === undefined ? {} : { classifierModel: classifierGrant }),
          isAuthorizedChat: (conversationId: ConversationId) =>
            authorizedChatConversations.has(conversationId) || workerChildConversations.has(conversationId),
        });
        for (const extension of codeModeRef.current.extensions) {
          registry.install(extension);
          for (const tool of extension.tools ?? []) toolRegistrations.set(tool.name, tool);
        }
      } else if (codeModeConfig === undefined && !mcpHasEnabledServers(next) && codeModeRef.current !== undefined) {
        const retired = codeModeRef.current;
        codeModeRef.current = undefined;
        retired.stopAdmission();
        for (const extension of retired.extensions) {
          registry.uninstall(extension);
          for (const tool of extension.tools ?? []) toolRegistrations.delete(tool.name);
        }
        // Management may itself be nested in this sandbox. Do not wait for our own
        // execution to exit; admission is closed synchronously and close joins it later.
        void retired.close().catch(() => undefined);
      } else {
        codeModeRef.current?.updateNamespaces(integration.namespaces);
      }
      await refreshMcpConversationPolicy();
    };
    const root = await harness.root(context, { agent: defaultAgentPolicy });

    // One immutable identity document per store, minted on first open. A derived index binds
    // its rows to this value instead of to a file path, which a replaced store can reuse.
    const storeIdentity = await ensureStoreIdentity(harness!, context, { now });

    // History scope: mapped chat sessions only. A channel's own state conversation, a scheduled run's
    // automation conversation and the root are not chat history, and the host has already
    // authenticated the session key before naming it. A mapped chat session is also unforked: search,
    // every entry/episode read and the background episode/summary work share that check, so a forged
    // or stale map entry cannot expose or summarize an automation, task-owned or inherited
    // transcript, a fork, or the root.
    const assertMappedChatConversations = async (
      conversationIds: readonly ConversationId[],
      ctx: Context,
    ): Promise<void> => {
      await root.commit(async (tx) => {
        for (const conversationId of conversationIds) {
          const reason = await readChatScope((id) => scopeRecordFor(tx, id), conversationId, root.id);
          if (reason !== undefined) throw new Error(chatScopeMessage(reason));
        }
      }, ctx);
    };
    // Background scope is decided by the conversation record and this host's automation
    // classification, never by the session key alone. An out-of-scope mapping is skipped instead of
    // failing the whole pass, so one forged entry cannot stop cataloguing or summarizing the
    // conversations that really are chat history. The per-session history surface still rejects such
    // a mapping loudly.
    const mappedChatSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> => {
      const mapping = await harness!.snapshot(SessionMap, root.id, ctx);
      if (mapping === undefined) return [];
      const candidates = readChatSessions(mapping.sessions, root.id);
      return root.commit(async (tx) => {
        const { chat } = await partitionChatScope((id) => scopeRecordFor(tx, id), candidates, root.id);
        return chat;
      }, ctx);
    };
    // Episode cataloguing covers chat and automation conversations alike: a scheduled run's episodes
    // are exactly the executions a recurring job accumulates, and a one-off job's are its occurrence
    // in the shared catch-all conversation. Summary queueing is conversation-scoped, so it needs no
    // session key; the read-only history tool still resolves sources through the mapped-chat rule and
    // therefore never presents these conversations as chats.
    const episodeSessions = async (ctx: Context): Promise<readonly HistoryChatSession[]> =>
      [...(await mappedChatSessions(ctx)), ...automationSessions()];
    // The digest source shares the host-validated mapped chat sessions of the history index. It never
    // includes automation conversations: a scheduled run is not a digest origin.
    digestSourceRef.current = createDigestSource({
      harness: harness!,
      sessions: mappedChatSessions,
      limits: { entriesPerBatch: digestLimits.entriesPerBatch, charsPerBatch: digestLimits.charsPerBatch },
    });
    // Bounded, background-only derived state: reset-delimited episode boundaries and their
    // durable summary status. It reads committed entries only and changes no reset or busy
    // ordering. A closed episode is recorded as pending; with summaries opted in, the same
    // commit queues its summary job, and without them nothing schedules or calls a provider.
    episodeCatalog = createEpisodeCatalog({
      harness: harness!,
      sessions: episodeSessions,
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
    /**
     * Install one conversation's workspace snapshot. A mapped chat is installed once per process; a
     * background target is rebuilt on every call, because each scheduled run is a new episode that
     * must render the workspace as it is now rather than as the first run of this process found it.
     * Both paths reuse the one `nanobot-context` extension name, so a rebuild replaces this
     * conversation's sections instead of adding a second extension.
     */
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
      const installed = contextConversations.has(conversationId);
      if (installed && !backgroundTarget) return skillConversations.has(conversationId);
      if (backgroundTarget && !installed && !backgroundTargets.includes(conversationId)) {
        backgroundTargets.push(conversationId);
      }
      const pending = Promise.resolve()
        .then(() => options.contextSnapshotProvider!(sessionKey, conversationId, ctx))
        .then(async (supplied) => {
          if (supplied !== undefined && !isRecord(supplied)) {
            throw new TypeError("Context snapshot provider must return an object or undefined");
          }
          const snapshot = bindContextSnapshot(supplied, conversationId);
          if (backgroundTarget && !installed) await makeSnapshotRoom(ctx);
          const replacement = installed
            ? contextExtensionBuilder.replace(snapshot)
            : { extension: contextExtensionBuilder.add(snapshot) };
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
          contextExtension = replacement.extension;
          registry.install(replacement.extension);
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
      reset = false,
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
            // Idle-only reset and prompt replacement share one commit, including across multiple
            // CLI attachments. No submission can begin between the two effects.
            if (reset) await tx.appendEntry(conversationId, { kind: ResetEntry.kind, head: "self" });
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
    // The stored mapping is read once here, before any scope decision: a scheduled run's automation
    // conversation has to be classified before a mapped key naming it can be admitted as chat, and a
    // class applied after that admission could never be withdrawn again.
    let storedMappedSessions: readonly MappedSession[] | undefined;
    if (options.contextSnapshotProvider || cronEnabled) {
      await root.commit(async (tx) => { await tx.doc(SessionMap, root.id); }, context);
      const mapping = await harness.snapshot(SessionMap, root.id, context);
      storedMappedSessions = readMappedSessions(mapping?.sessions, root.id);
      if (options.contextSnapshotProvider && storedMappedSessions.length > CONTEXT_LIMITS.maxConversations) {
        throw new Error(`Context snapshots support at most ${CONTEXT_LIMITS.maxConversations} mapped conversations`);
      }
    }
    // Restore the class of every automation conversation this store names, before the mapped-chat
    // authority pass below can see a key that names one. Origins are the stored mapping itself, not
    // the owner sets that pass builds: a guard drawn from those sets would veto the classification of
    // exactly the mapping it has to refuse. The conversation's own durable marker decides, and it
    // names its own origin and job, so a mapped conversation is classified whether or not its
    // origin's document still records it — including one whose pointer was damaged away — for the
    // price of one snapshot per mapped conversation. Committed cron documents are read as an index as
    // well, because a live run's target is ownerless and unmapped: nothing else names it for the task
    // scan below. Documents never decide the class, so a damaged pointer can only fail to enumerate a
    // conversation, never promote a chat or hide an automation conversation a key names. Only a
    // conversation that is still ownerless and unforked and whose marker names another conversation
    // is classified (`classifyAutomationConversation`, the same rule a run applies to a recorded
    // pointer). This host writes that marker only on an automation conversation, so a store this host
    // wrote never loses a chat to it; a marker written onto a chat by hand buys denial of that chat's
    // surfaces and of store-wide history search, never authority. A missing, foreign or damaged marker
    // leaves the ID unclassified and the job's next run records a fresh conversation in its place.
    // This is a read: it creates no document and starts nothing.
    if (cronEnabled && storedMappedSessions !== undefined) {
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
        const classified = classifyAutomationConversation(
          record, marker, { originConversationId, jobId: own.jobId },
        );
        if (classified === undefined) continue;
        automationConversations.set(conversationId, {
          originConversationId,
          conversationClass: classified.conversationClass,
          jobId: classified.jobId,
        });
      }
    }
    // History retrieval is independent of the context snapshot opt-in: every mapped chat
    // conversation can read history, while state-only bookkeeping conversations cannot. Config tool
    // authority is derived from the same validated mapping, so it is loaded whenever either needs it.
    const initialMapping = historyTool === undefined && !toolsEnabled && telegramTool === undefined && !workersEnabled
      && webTool === undefined && !mcpConfigured && !codeModeEnabled && mcpAdminRef.current === undefined
      ? undefined
      : await harness.snapshot(SessionMap, root.id, context);
    if (initialMapping !== undefined) {
      for (const { sessionKey, conversationId } of await mappedChatSessions(context)) {
        if (historyTool !== undefined) historyConversations.add(conversationId);
        authorizedChatConversations.add(conversationId);
        if (webTool !== undefined) webConversations.add(conversationId);
        sessionKeyForConversation.set(conversationId, sessionKey);
        // A worker may be spawned only from this scope-checked set; a task-owned target, the root,
        // a fork or a channel-state conversation is never in it.
        if (workersEnabled) workerSpawners.add(conversationId);
        if (telegramTool !== undefined && sessionKey.startsWith("telegram:")) {
          telegramChatConversations.add(conversationId);
        }
      }
    }
    if (storedMappedSessions !== undefined) {
      const sessions = storedMappedSessions;
      // A stored key names a mapped session only while its conversation is still ordinary chat: the
      // class pass above removed this host's automation conversations, and the shared scope rule
      // removes the root, a task-owned conversation and a fork, exactly as the channel ingress refuses
      // that same key. Such a key therefore gains no cron owner, no unevictable snapshot slot and no
      // resume target here, and a forked id leaves this set so its snapshot stays evictable. A missing
      // conversation keeps its explicit failure below.
      const outOfScope = new Set<ConversationId>();
      await root.commit(async (tx) => {
        for (const { conversationId } of sessions) {
          const reason = await readChatScope((id) => scopeRecordFor(tx, id), conversationId, root.id);
          if (reason === "automation" || reason === "root" || reason === "task-owned" || reason === "forked") {
            outOfScope.add(conversationId);
          }
        }
      }, context);
      for (const { sessionKey, conversationId } of sessions) {
        if (outOfScope.has(conversationId)) continue;
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
    const backgroundRunTargets: BackgroundRunTarget[] = [];
    // Live worker targets keep the model, thinking level and workspace chosen at launch. A reopen must
    // not silently replace them with the configured default, and a worktree child keeps its own root.
    const workerChildPolicies = new Map<ConversationId, NonNullable<ReturnType<typeof workerChildPolicy>>>();
    // Live digest targets keep the model pinned at start too. They are not run targets with a host
    // context snapshot: a digest turn's prompt is its own bounded input, identical before and after
    // a reopen, so only its pinned model and curation hook are restored.
    const digestTargetPolicies = new Map<ConversationId, NonNullable<ReturnType<typeof memoryDigestTaskPolicy>>>();
    // Live children whose captured model left the current catalog. They are denied before
    // scheduling resumes, never silently moved to the configured default.
    const pinnedModelRemoved = new Set<ConversationId>();
    const runTasksById = new Map<number, { readonly originConversationId: ConversationId; readonly targetConversationId: ConversationId | null }>();
    await root.commit(async (tx) => {
      let taskCursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks({}, 1000, taskCursor);
        for (const task of page.items) {
          const snapshotTarget = cronBackgroundTarget(task) ?? workerBackgroundTarget(task);
          const digestTarget = memoryDigestTaskTarget(task);
          const backgroundTarget = snapshotTarget ?? digestTarget;
          if (task.kind === CRON_RUN_TASK_NAME || task.kind === WORKER_TASK_NAME
            || task.kind === MEMORY_DIGEST_TASK_NAME) {
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
              && automationConversations.get(target.id)?.originConversationId
                === backgroundTarget.originConversationId;
            if (ownsTarget || automationTarget) {
              // A digest target deliberately gets no origin context snapshot: its model input is
              // its own bounded batch, so a reopened attempt renders the same framing again.
              if (snapshotTarget !== undefined) backgroundRunTargets.push(snapshotTarget);
              const policy = workerChildPolicy(task);
              if (policy !== undefined && policy.targetConversationId === target.id) {
                workerChildPolicies.set(target.id, policy);
                // A live child keeps the compositor across a reopen; its enabled tools are restored
                // from the capture, so a narrowed ceiling also narrows what a script can compose.
                workerChildConversations.add(target.id);
                if (!choicesByNative.has(modelKey(policy.model))) pinnedModelRemoved.add(target.id);
                if (policy.workspace.mode === "worktree") {
                  workerWorkspaceRoots.set(target.id, policy.workspace.path);
                }
              }
              const digestPolicy = memoryDigestTaskPolicy(task);
              if (digestPolicy !== undefined && digestPolicy.targetConversationId === target.id) {
                digestTargetPolicies.set(target.id, digestPolicy);
                // A live digest target keeps its curation hook and pinned model; its captured
                // Markdown tools are restored and narrowed from the capture below.
                digestTargetConversations.add(target.id);
                digestTargetLimits.set(target.id, { ...digestPolicy.limits });
                if (!choicesByNative.has(modelKey(digestPolicy.model))) pinnedModelRemoved.add(target.id);
              }
            }
          }
          const preparedModel = preparedTaskModel(task);
          if (preparedModel !== undefined && !choicesByNative.has(modelKey(preparedModel))) {
            throw new Error(`Cannot resume ${task.kind} task ${task.id}: prepared model ${modelKey(preparedModel)} is outside allowedModels`);
          }
          const contextReplay = preparedContextReplay(task);
          if (visionHandoff !== undefined && preparedModel !== undefined
            && contextReplay?.kind === "pi.generation" && contextReplay.phase === "request") {
            // Only a saved request still owes its model-bound dispatch. A poll resumes an
            // already-sent request without beforeRequest, and a later retry re-prepares from
            // the reset AgentDoc, so pinning those would apply a stale image policy.
            preparedGenerationModels.set(Number(task.id), preparedModel);
          }
          if (contextReplay !== undefined) preparedContextReplays.push(contextReplay);
        }
        taskCursor = page.next;
      } while (taskCursor !== undefined);
    }, context);

    // A pinned child (worker or digest target) whose captured model was removed must not reach a
    // provider with it, or with a silently substituted default. Before scheduling resumes, stop its
    // own conversation's pending work through native ownership: queued inputs, and live tasks that
    // hold no saved provider dispatch.
    // A saved dispatch is deliberately left alone; the inherited prepared-model guard refuses to open
    // the gateway in that case instead of cancelling it to "repair" startup.
    if (pinnedModelRemoved.size > 0) {
      let inspection: Awaited<ReturnType<HarnessType["inspect"]>> | undefined;
      try {
        inspection = await harness.inspect(context);
      } catch {
        inspection = undefined;
      }
      if (inspection !== undefined) {
        for (const submission of inspection.submissions) {
          if (submission.status !== "queued" || !pinnedModelRemoved.has(submission.conversationId)) continue;
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
          if (!pinnedModelRemoved.has(record.conversationId)) continue;
          if (preparedTaskModel(record) !== undefined) continue;
          try {
            await harness.abortTask(record.id, context);
          } catch {
            // Same bounded fallback: capture and tools are retired below.
          }
        }
      }
    }

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

    // Every conversation a live run task currently targets is that run's target. A scheduled run's
    // automation conversation is ownerless, so it is found through the class this open restored;
    // a worker or digest target is found through the task that still owns it. A target whose run
    // already ended keeps no prepared authority and is left out.
    const runTargetCandidates: { conversationId: ConversationId; originConversationId: ConversationId }[] = [];
    await root.commit(async (tx) => {
      for (const [taskId, task] of runTasksById) {
        const targetConversationId = task.targetConversationId;
        if (targetConversationId === null) continue;
        const conversation = await tx.conversation(targetConversationId);
        if (conversation === undefined) continue;
        const automation = automationConversations.get(conversation.id);
        const owned = conversation.owner?.taskId === taskId
          && conversation.owner.conversationId === task.originConversationId;
        if (automation === undefined || automation.originConversationId !== task.originConversationId) {
          if (!owned) continue;
        }
        runTargetCandidates.push({
          conversationId: conversation.id,
          originConversationId: task.originConversationId,
        });
      }
    }, context);

    // A background run's captured authority is only as good as the current host config and its
    // origin. Durable's tool hooks run in the call phase only, so a committed execute intent
    // resolves without them and a resumed turn could otherwise admit a call the config or origin no
    // longer supports. Intersect every live run's capture with the current ceiling and its
    // authenticated origin before resume; a mismatched origin, an unknown origin owner, an already
    // finished run or a missing capture is a deny rather than authority.
    const backgroundToolBounds = new Map<ConversationId, ReadonlySet<string>>();
    for (const { conversationId: targetConversationId, originConversationId } of runTargetCandidates) {
      const tools = new Set<string>();
      const capture = await harness.snapshot(ConfigToolCaptureDoc, targetConversationId, context);
      if (capture !== undefined && capture.originConversationId === originConversationId
        && authorizedChatConversations.has(originConversationId)) {
        const ceiling = workerChildPolicies.has(targetConversationId)
          ? workerToolNames() : toolAllowlist;
        for (const name of boundedCapturedTools(capture.tools, ceiling, true)) tools.add(name);
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
          const workerPolicy = workerChildPolicies.get(conversation.id);
          const digestPolicy = digestTargetPolicies.get(conversation.id);
          // A live worker keeps the model, thinking level and workspace chosen at launch, even when
          // that model has since left the catalog: the pin stays honest instead of silently becoming
          // the configured default. The worker task then fails closed in its own terminal commit.
          const workerChoice = workerPolicy === undefined ? undefined : choicesByNative.get(modelKey(workerPolicy.model));
          const digestChoice = digestPolicy === undefined ? undefined : choicesByNative.get(modelKey(digestPolicy.model));
          await configure(tx, conversation.id, {
            ...(workerPolicy !== undefined
              ? {
                  cwd: workerPolicy.workspace.path,
                  model: workerPolicy.model,
                  thinkingLevel: workerChoice !== undefined && workerChoice.thinkingLevels.includes(workerPolicy.thinkingLevel)
                    ? workerPolicy.thinkingLevel
                    : workerChoice !== undefined ? fallbackThinkingLevel(workerChoice) : workerPolicy.thinkingLevel,
                }
              : digestPolicy !== undefined
                ? {
                    cwd: workspace,
                    model: digestPolicy.model,
                    // Deterministic lowest supported level if the pinned one left the catalog: the
                    // foreground thinking level is never inherited by a background digest run.
                    thinkingLevel: digestChoice !== undefined && digestChoice.thinkingLevels.includes(digestPolicy.thinkingLevel)
                      ? digestPolicy.thinkingLevel
                      : digestChoice !== undefined
                        ? digestChoice.thinkingLevels.includes("off") ? "off" : digestChoice.thinkingLevels[0]!
                        : digestPolicy.thinkingLevel,
                  }
                // Named-preset mode owns the startup default; direct mode preserves its persisted choice.
                : policyForState(state, configuredPresetName !== undefined)),
            ...extensionsPolicy(conversation.id),
            ...toolFilter,
          });
          if ((workerPolicy !== undefined && workerChoice === undefined)
            || (digestPolicy !== undefined && digestChoice === undefined)) {
            // Removed model: no fallback dispatch and no captured authority. The target's own pending
            // work was withdrawn above; the task commits the terminal error on resume. Code Mode
            // selection goes too, so no stale script can compose a retired worker capture.
            await tx.retireDoc(ConfigToolCaptureDoc, conversation.id);
            await configure(tx, conversation.id, {
              tools: [],
              modelTools: [],
              extensions: visionExtension === undefined ? [] : [visionExtension],
            });
          }
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
      memoryDigest: {
        start: (writer, ctx) => memoryDigest.start(writer, ctx),
        status: (writer, ctx) => memoryDigest.status(writer, ctx),
      },
      cronOutbox,
      ...(telegramActions === undefined ? {} : { telegramActions }),
      get mcp() {
        return mcpRef.current === undefined ? undefined : { servers: mcpRef.current.status };
      },
      ...(mcpAdminRef.current === undefined ? {} : {
        mcpAdmin: {
          list: (ctx: Context): Promise<McpAdminListing> => mcpAdminRef.current!.list(ctx),
          submitCallback: (sessionKey: string, text: string, ctx: Context) =>
            mcpAdminRef.current!.submitCallback(sessionKey, text, ctx),
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
        // The stored map is host data, not authority: it can be forged, imported or left behind by an
        // older layout. A mapped session key may therefore name only an ordinary chat conversation;
        // anything else is refused here, before it can become a cron owner or receive chat policy.
        const scopeReason = await root.commit(
          (tx) => readChatScope((id) => scopeRecordFor(tx, id), conversationId!, root.id), ctx,
        );
        if (scopeReason !== undefined) throw new Error(chatScopeMessage(scopeReason));
        // A mapped session key is the cron owner; unmapped conversations (such as a scheduled run's
        // own background conversation) have no owner and therefore never receive the cron tool.
        let mappedChat = false;
        if (isChatSessionKey(sessionKey)) {
          historyConversations.add(conversationId!);
          authorizedChatConversations.add(conversationId!);
          if (webTool !== undefined) webConversations.add(conversationId!);
          mappedChat = true;
        }
        // The exact host-owned session key for this conversation is what a channel action host
        // revalidates; it is never supplied by the model. Only a scope-checked mapped Telegram chat
        // conversation is offered the Telegram action tool.
        sessionKeyForConversation.set(conversationId!, sessionKey);
        if (workersEnabled) {
          // Only a scope-checked mapped chat may spawn workers; the task-owned worker conversation is
          // never mapped, so a worker can never start another worker.
          if (mappedChat) workerSpawners.add(conversationId!);
          else workerSpawners.delete(conversationId!);
        }
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
      backgroundStatus: (sessionKey, ctx) => backgroundStatusFor(sessionKey, ctx),
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
      async resetSession(sessionKey, ctx) {
        // `/new` may be the first message in a chat, so its own mapped conversation is resolved the
        // same way `conversationFor` resolves it (creating only that host-supplied key). No other
        // session selector exists here.
        const conversation = await gateway.conversationFor(sessionKey, ctx);
        // Without a host prompt snapshot there is nothing to rebuild: the native reset is the whole effect.
        if (!options.contextSnapshotProvider) {
          await conversation.reset(undefined, ctx);
          return { status: "reset", skills: 0, promptRebuilt: false };
        }
        let skills: number;
        try {
          // Rebuild and reset atomically: a live run refuses before either effect is published.
          skills = await refreshContextSnapshot(sessionKey, conversation.id, ctx, true);
        } catch (error) {
          if (error instanceof ConversationBusy) return { status: "busy" };
          throw error;
        }
        return { status: "reset", skills, promptRebuilt: true };
      },
      async close(ctx) {
        if (closed) return;
        closed = true;
        const cleanup = withoutAbortSignal(ctx);
        // An MCP login waiting for its browser callback is stopped first: it must not reach a closed
        // Harness, and it must not store a grant while this process is tearing down.
        try { await mcpAdminRef.current?.close(); } catch { /* best effort; teardown continues */ }
        // Stop derived background work before the session stops accepting commits.
        episodeCatalog?.close();
        try { await harness!.close(cleanup); }
        finally {
          // Code Mode first: it owns sandbox workers that may be calling MCP tools. Then the MCP
          // clients, whose native transports tear down their server process groups.
          try { await codeModeRef.current?.close(); }
          finally {
            try { await mcpRef.current?.close(); }
            finally {
              try { await historyIndex?.close(); }
              finally {
                try {
                  for (const environments of workerEnvironments.values()) {
                    await environments.close(cleanup).catch(() => undefined);
                  }
                  workerEnvironments.clear();
                  await toolEnvironments?.close(cleanup);
                } finally { await releaseLock(); }
              }
            }
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
    /**
     * One bounded snapshot per read, never a claim of atomicity across the parts: each foundation is
     * read once, in order, and nothing is written. `emptyBackgroundStatus()` is returned for a
     * conversation that is not an authenticated mapped chat, so a root, state, fork or task-owned
     * conversation learns nothing and causes no read at all.
     */
    async function backgroundStatusFor(sessionKey: string, ctx: Context): Promise<BackgroundStatus> {
      const conversation = await existingConversationFor(sessionKey, ctx);
      const conversationId = conversation.id;
      if (!authorizedChatConversations.has(conversationId)) return emptyBackgroundStatus();
      // A native task record keeps its last state when Durable parks it, so "unfinished" is not the
      // same as "will run": only the live-work inspection reports blocked tasks. It is read lazily,
      // once, and only when something unfinished actually needs classifying.
      let blockedTasks: Map<number, string> | undefined;
      const blockedNow = async (): Promise<Map<number, string>> => {
        if (blockedTasks !== undefined) return blockedTasks;
        const blocked = new Map<number, string>();
        for (const task of (await harness!.inspect(ctx)).tasks) {
          // The reason decides whether a native retry can ever run the task again.
          if (task.state.kind === "blocked") blocked.set(Number(task.record.id), task.state.reason);
        }
        blockedTasks = blocked;
        return blocked;
      };
      // Workers: this conversation's retained records, re-checked against the native task record so a
      // stale pointer or a record naming someone else's task is never reported as live work.
      const workerItems: BackgroundWorker[] = [];
      let liveWorkers = 0;
      let parkedWorkers = 0;
      if (workerFoundation !== undefined && workerSpawners.has(conversationId)) {
        for (const view of await workerFoundation.list(harness!, conversationId, ctx)) {
          if (view.status !== "queued" && view.status !== "running") continue;
          const task = await harness!.getTask(view.taskId as TaskId, ctx);
          if (task === undefined || task.kind !== WORKER_TASK_NAME || task.conversationId !== conversationId) continue;
          const state = task.state.status;
          if (state === "terminal") continue;
          const blockReason = (await blockedNow()).get(view.taskId);
          if (blockReason === undefined) liveWorkers += 1;
          else parkedWorkers += 1;
          if (workerItems.length >= BACKGROUND_STATUS_LIMITS.rows) continue;
          workerItems.push({
            taskId: view.taskId,
            status: blockReason === undefined ? state : "parked",
            // Only a restart limit is cleared by a native retry; a missing or stale definition is not.
            ...(blockReason === undefined ? {} : { retryable: blockReason === "restart_limit" }),
            task: backgroundLabel(view.prompt),
            workspace: view.workspaceMode,
          });
        }
      }
      // Cron: this conversation's own jobs, read through the same derived view the cron tool uses, so
      // the native timer/run/target states decide what is executing, queued, parked or merely armed.
      const cronOwner = cronOwners.get(conversationId);
      const runningItems: BackgroundCronRun[] = [];
      let runningTotal = 0;
      let scheduled = 0;
      let nextAtMs: number | null = null;
      let pendingCron = 0;
      let parked = 0;
      if (cronFoundation !== undefined && cronOwner !== undefined) {
        for (const view of await cronFoundation.list(harness!, conversationId, { owner: cronOwner }, ctx)) {
          // `parked` is a native restart-limit block; `missing` is the same block for another reason.
          // Either way the job cannot execute, so it is never folded into the healthy count.
          if (view.status === "parked" || view.status === "missing") parked += 1;
          if (view.nextAtMs !== null) {
            scheduled += 1;
            nextAtMs = nextAtMs === null ? view.nextAtMs : Math.min(nextAtMs, view.nextAtMs);
          }
          const execution = view.execution?.status;
          const executing = executingState(execution) ?? executingState(view.target?.status);
          if (executing !== undefined) {
            runningTotal += 1;
            if (runningItems.length < BACKGROUND_STATUS_LIMITS.rows) {
              runningItems.push({ name: backgroundLabel(view.job.name), status: executing });
            }
            continue;
          }
          if (execution === "pending" || execution === "waiting" || execution === "sleeping") pendingCron += 1;
        }
      }
      // One workspace-global digest run at a time: its origin decides whether this chat owns it.
      const digestStatus = await memoryDigest.status({
        id: conversationId,
        commit: (change, inner) => conversation.commit(change, inner),
      }, ctx);
      const digestLive: BackgroundDigest["live"] = digestStatus.liveTaskId === null
        ? "none"
        : digestStatus.liveConversationId === conversationId ? "own" : "shared";
      const digestParked = digestStatus.liveTaskId !== null
        && (await blockedNow()).has(digestStatus.liveTaskId);
      return {
        workers: { live: liveWorkers, parked: parkedWorkers, items: workerItems },
        cron: {
          scheduled,
          nextAtMs,
          running: { total: runningTotal, items: runningItems },
          pending: pendingCron,
          parked,
        },
        digest: { live: digestLive, parked: digestParked },
      };
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
      // Summary policy stays chat-only: an automation conversation's episodes are catalogued, but a
      // summary of one has no reader (the history tool is mapped-chat scoped), so it is not
      // initialized here and the catalog's enqueue defers instead of spending on it.
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
    // A worker that finished while the process was gone already committed its outcome and retired its
    // authority, but may not have admitted the internal result event. Re-admitting is idempotent by the
    // conversation-scoped request ID, so a crash cannot lose a result or duplicate the parent's turn.
    if (workerFoundation !== undefined) {
      try {
        await workerFoundation.recover(harness, (conversationId) => workerSpawners.has(conversationId), context);
      } catch {
        // The records stay unnotified; the next open retries the same admission.
      }
    }
    // The same admission guarantee for a terminal failed or cancelled digest run: its internal issue
    // report may have been lost between the terminal commit and the submit. Only currently mapped
    // chat origins are notified, and the request ID keeps a retry from duplicating the origin
    // agent's turn. A successful run is never admitted at all.
    try {
      await memoryDigest.recover(
        harness,
        (conversationId) => authorizedChatConversations.has(conversationId),
        context,
      );
    } catch {
      // Notices stay open; the next open retries.
    }
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
      try { await codeModeRef.current?.close(); }
      catch { /* a sandbox close failure must not mask the startup error */ }
      try { await mcpRef.current?.close(); }
      catch { /* a failed server connection is already closed; never mask the startup error */ }
      try { await historyIndex?.close(); }
      catch { /* a derived index close failure leaves a rebuildable file, not source data */ }
      finally {
        try {
          for (const environments of workerEnvironments.values()) {
            await environments.close(cleanup).catch(() => undefined);
          }
          await toolEnvironments?.close(cleanup).catch(() => undefined);
        } finally { await releaseLock(); }
      }
    }
    throw error;
  }
}
