/**
 * Public host contract of the gateway composition root (`openGateway`). Types only: every value
 * lives in the runtime submodules, and `src/runtime.ts` re-exports this file unchanged.
 */
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, ConversationId, Cursor, EntryId, EntryRecord, Harness as HarnessType } from "@earendil-works/pi-durable";
import type { ConversationContextSnapshot } from "../context/index.js";
import type { CronDeliveryOutbox } from "../automation/cron-delivery.js";
import type { CronOperator } from "../automation/operator.js";
import type { HistoryPage, HistoryQuery, HistorySummaryPage, HistorySummaryQuery } from "../history/index.js";
import type { HistorySummaryView } from "../history/summary-view.js";
import type { MemoryService } from "../memory/contracts.js";
import type { TelegramActionRegistry } from "../channels/telegram-tool.js";
import type { DiscordHistoryRegistry } from "../channels/discord-history.js";
import type { AppActionRegistry } from "../channels/app-tool.js";
import type { AppConsoleRegistry, AppGateway } from "../channels/app-runtime.js";
import type { AskSurfaceRegistry } from "../questions/index.js";
import type { EpisodeReconcileReport, HistoryEpisode, HistoryEpisodePage, HistoryEpisodeQuery } from "../history/episodes.js";
import type { EpisodeSummaryBackfill, EpisodeSummaryDrain, EpisodeSummaryQueueView, EpisodeSummaryRetry } from "../history/summary-task.js";
import type { EpisodeSummaryRecord } from "../history/summary-queue.js";
import type { StoreIdentity } from "../history/store-identity.js";
import type { ModelReference, PortConfig } from "../config.js";
import type { VisionHandoffStats } from "../media/vision.js";
import type { OwnerInputContent } from "../history/idle-rollover.js";
import type { ModelReloadResult } from "../model-reload.js";
import type { BackgroundActiveWork, BackgroundStatus } from "../background-status.js";
import type { McpAdminListing, McpCallbackResult, McpServerStatus, McpSurfaceRegistry } from "../mcp/index.js";
import type { MemoryDigestStartResult, MemoryDigestStatus, MemoryDigestWriter } from "../history/memory-digest.js";
import type { WebRuntimeOptions } from "../web/index.js";

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

export interface GatewayModelPresets {
  readonly presets: readonly GatewayModelPreset[];
  readonly defaultPreset: string;
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
  /**
   * Host-owned candidate loader for an explicit live model/credential reload. It must re-read the
   * same configuration file the gateway opened from and return a fully parsed result; the runtime
   * never accepts a path from a model, chat or tool. Absent, no `/reload` host method is exposed.
   */
  readonly reloadConfig?: () => Promise<PortConfig>;
  /** Explicit host-owned context snapshots; absent means no context extension is installed. */
  readonly contextSnapshotProvider?: GatewayContextSnapshotProvider;
  /**
   * Host switch for model-facing approved memory recall. It is on by default for mapped
   * chats; pass `false` to disable recall too. It reads only approved workspace notes and
   * already-mapped chat history, creates no conversation, writes no transcript and grants
   * no filesystem or shell authority.
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
  submitCallback(sessionKey: string, text: string, context: Context): Promise<McpCallbackResult>;
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
  /** Approved read-only recall over notes and mapped chat history. */
  memorySearch(caller: ConversationId, query: unknown, context: Context): ReturnType<MemoryService["search"]>;
  memoryBrowse(caller: ConversationId, query: unknown, context: Context): ReturnType<MemoryService["browse"]>;
  memoryRead(caller: ConversationId, query: unknown, context: Context): ReturnType<MemoryService["read"]>;
  /**
   * Whole-episode conversation-to-memory digestion. `start` selects a closed episode from the
   * mapped chat sessions and creates one continuing Durable task, or reports `idle`, `busy` or `refused`
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
   * Owner scheduling controls: create, list, show and cancel over the existing cron foundation.
   * Present only when cron is enabled. Every origin is resolved through the host's current mapped
   * ordinary chat sessions, and the owner is derived from that validated key, so a caller can name
   * a chat but never supply a conversation ID or an owner record. It exposes no schedule editing,
   * re-arm, bulk operation or run-now path, and it is not a model tool.
   */
  readonly cronOperator?: CronOperator;
  /**
   * Model-action host registry for the configured Telegram channel. The running adapter attaches
   * here; when absent, a mapped Telegram chat still sees the tool but every call is denied because
   * no live channel can send. Present only when `config.telegram` is configured.
   */
  readonly telegramActions?: TelegramActionRegistry;
  /**
   * Live host registry for the read-only Discord history capability. Present only when `config.discord`
   * is configured; the running adapter attaches its call-time-checked host, and the runtime offers the
   * tool only in a scope-checked mapped Discord chat conversation.
   */
  readonly discordHistory?: DiscordHistoryRegistry;
  /**
   * Live host registry for the app channel's operator console. Present only when `config.app` is
   * configured; the running adapter attaches its pairing host, and the local terminal's
   * `app pair|devices|revoke` commands reach it over the private socket.
   */
  readonly appConsole?: AppConsoleRegistry;
  /**
   * Called by every owner-input path just before it submits to a mapped chat: decides a prepared idle
   * rollover for that chat (see `src/history/idle-rollover.ts`). Never throws; a no-op without one.
   */
  beforeOwnerInput(sessionKey: string, conversationId: ConversationId, content: OwnerInputContent, context: Context): Promise<void>;
  /**
   * Model-action host registry for the app channel's `app` file capability (`send`/`artifact`).
   * Present only when `config.app` is configured; the running adapter attaches here, and the
   * runtime offers the tool only in a scope-checked mapped app chat conversation.
   */
  readonly appActions?: AppActionRegistry;
  readonly forkAppThread?: NonNullable<AppGateway["forkAppThread"]>;
  readonly appThreadBusy?: NonNullable<AppGateway["appThreadBusy"]>;
  /** Present only when `config.app` is configured: snapshot-slot room and eager thread reservation. */
  readonly appSnapshotRoom?: NonNullable<AppGateway["appSnapshotRoom"]>;
  readonly createAppThread?: NonNullable<AppGateway["createAppThread"]>;
  readonly reserveAppThread?: NonNullable<AppGateway["reserveAppThread"]>;
  /**
   * The app channel's bounded Tasks view for one already-mapped thread. Read-only: it lists that
   * thread's own workers and scheduled jobs through the same owner-scoped readers the model tools
   * use, bounds the result to `LIMITS.maxListedTasks`, and maps it display-only. Nothing else is
   * read, started, retried or cancelled; an unmapped session key reads nothing.
   */
  readonly appTasks?: NonNullable<AppGateway["appTasks"]>;
  /**
   * Cancels or removes one task of that thread, and only one it owns: an id from another thread
   * reports `unknown` and changes nothing. A worker uses the existing durable worker cancel; a
   * scheduled job uses the existing owner-scoped cron cancel, including its already-terminal case.
   */
  readonly appTaskCancel?: NonNullable<AppGateway["appTaskCancel"]>;
  /**
   * The app channel's one off-path classifier call: a fixed-list badge emoji and verb for a side
   * thread, from its title and (when at hand) its first owner message. Present only with
   * `app.threadBadges` and a configured `classifierModel`; it classifies and answers, and never
   * writes, renames or starts a turn itself.
   */
  readonly classifyThreadBadge?: NonNullable<AppGateway["classifyThreadBadge"]>;
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
  /**
   * Live owner surfaces for model-requested questions. A foreground terminal or channel attaches the
   * exact session it authenticated; `ask_user` delivers only to the unique surface that owns it, and
   * never to another chat or a sibling attachment.
   */
  readonly askSurfaces?: AskSurfaceRegistry;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  /**
   * Bounded, read-only background activity for one already-mapped conversation: its own live
   * workers and scheduled jobs, plus whether the single workspace-global memory-digestion run is
   * live and whether it belongs to this conversation, plus an anonymous gateway-wide active-work
   * count for restart safety. It starts, retries and cancels nothing, calls
   * no model, reads no transcript, prompt, tool argument, host path or other chat, and reports no
   * other conversation ID. A conversation that is not an authenticated mapped chat reads nothing.
   */
  backgroundStatus(sessionKey: string, context: Context): Promise<BackgroundStatus>;
  /**
   * Bounded, read-only count of live work a whole-gateway restart would interrupt: executing tasks,
   * work queued to execute, work waiting for it, and work still finishing. A sleeping native timer is
   * an armed schedule and a blocked task cannot run, so neither counts, and an armed cron schedule
   * never keeps the gateway permanently busy. It starts, changes, cancels and calls nothing, and
   * reports no task, conversation or transcript detail.
   */
  activeWork(context: Context): Promise<BackgroundActiveWork>;
  /** Lists the explicit allowlist and persisted selection for an already-known session key. */
  listModels(sessionKey: string, context: Context): Promise<GatewayModelList>;
  /**
   * Read-only host catalog of named presets and the configured default: no conversation, mapping or
   * commit is involved. `undefined` in legacy direct-model mode. Reflects the last `/reload`.
   */
  modelPresets(): GatewayModelPresets | undefined;
  /**
   * Read-only selected model of an already-mapped session key, resolved like `listModels` but
   * without creating, committing or applying policy. `undefined` when the key has no mapping yet;
   * it rejects when the stored state cannot be read.
   */
  selectedModel(sessionKey: string, context: Context): Promise<GatewayModelSelection | undefined>;
  /** Persists a native pi.agent choice; rejects ConversationBusy atomically without changing it. */
  selectModel(sessionKey: string, selection: GatewayModelSelectionRequest, context: Context): Promise<GatewayModelSelection>;
  /**
   * Explicit host-only reload of foreground model presets, model selection and credential
   * references. It re-reads and fully validates the host-owned configuration file, then applies
   * only those fields; tools, channels, workspace context, MCP and background model captures need
   * `/restart`. Present only when the host supplied a configuration-file loader.
   */
  readonly reloadModels?: (context: Context) => Promise<ModelReloadResult>;
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
   * entry by itself. Reports the live worker and, when Durable blocks the chain's task because no
   * installed definition can take it, that task and reason. Nothing revives a blocked chain.
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
