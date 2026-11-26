/**
 * Foreground model policy of one gateway open: startup validation of every configured model choice,
 * the live catalog as one immutable snapshot, per-conversation selection, and the explicit host
 * reload that swaps that snapshot.
 *
 * The live catalog, its presets and the default agent policy are one {@link LiveModelState}. A
 * reload computes a complete candidate first and replaces the snapshot in one assignment, only when
 * `observeCommits()` reports the commit carrying its {@link ModelPolicyRevisionDoc} revision as
 * stored, so a reader never sees a half-applied catalog and a refused commit publishes nothing.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  ConversationBusy,
  configure,
  defineDoc,
  InboxDoc,
  LiveDoc,
  type AgentChange,
  type AgentState,
  type CommitObservation,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Harness as HarnessType,
  type Tx,
} from "@earendil-works/pi-durable";
import { CRON_TIMER_TASK_NAME } from "../automation/cron.js";
import { modelKey, type ModelReference, type PortConfig } from "../config.js";
import { authStorePath, FileCredentialStore } from "../auth/store.js";
import { loadModelCatalog } from "../model-catalog.js";
import { resolveModelConfiguration, type ResolvedModelConfiguration } from "../model-config.js";
import { modelReloadCompatibility, type ModelReloadResult } from "../model-reload.js";
import { journalEvent } from "../observability.js";
import {
  assertConfiguredModelAuth,
  createProviderModels,
  resolveClassifierModel,
  type ResolvedModelChoice,
} from "../providers.js";
import { StartupDiagnosticError } from "../startup-diagnostics.js";
import { canonicalFuturePath } from "../store.js";
import { VisionHandoff } from "../media/vision.js";
import type { McpConfig } from "../mcp/index.js";
import type {
  GatewayModelChoice,
  GatewayModelList,
  GatewayModelPreset,
  GatewayModelPresets,
  GatewayModelSelection,
  GatewayModelSelectionRequest,
  OpenGatewayOptions,
} from "./types.js";

/**
 * Durable identity of the last committed foreground policy revision.
 *
 * A live model reload writes one random revision here in the same commit as every conversation
 * policy it updates. The in-memory provider registry is published only when `observeCommits()`
 * reports that exact revision in a stored commit, so a candidate is never visible before its commit
 * is durable, and a failed or refused commit never publishes one.
 */
const ModelPolicyRevisionDoc = defineDoc<{ revision: string }>({
  kind: "nanobot.model-policy-revision", version: 1, scope: "session",
  initial: () => ({ revision: "" }), checkpointWhen: () => true,
});

/** Whether one stored commit carried a specific model-policy revision document. */
function publicationCarriesRevision(publication: CommitPublication, revision: string): boolean {
  return publication.changes.some((change) => change.type === "document" && change.kind === "change"
    && change.record.scope.kind === "session"
    && change.record.kind === ModelPolicyRevisionDoc.definition.kind
    && (change.value as { readonly revision?: unknown }).revision === revision);
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

/** A background model choice pinned at open: a native pair and the level it runs at. */
export interface PinnedModelChoice {
  readonly model: ModelReference;
  readonly thinkingLevel: ModelThinkingLevel;
}

/** The provider registry and its resolved catalog, as startup prepared them. */
export interface StartupModels {
  readonly models: Models;
  readonly resolved: ResolvedModelConfiguration;
  /** The one configured classifier model, resolved against the very catalog Code Mode uses. */
  readonly classifierGrant: ModelReference | undefined;
  /** Canonical future data directory of the credential store; absent with host-supplied models. */
  readonly credentialStoreDir: string | undefined;
}

/**
 * Resolve the provider registry and catalog. Fails before storage opens when a configured chat
 * provider has no usable native credential; stored OAuth is checked for presence, not refreshed.
 */
export async function resolveStartupModels(
  config: PortConfig, options: OpenGatewayOptions, context: Context,
): Promise<StartupModels> {
  if (options.models !== undefined) {
    const models = options.models;
    return {
      models,
      resolved: resolveModelConfiguration(config, models),
      classifierGrant: resolveClassifierModel(models, config.classifierModel),
      credentialStoreDir: undefined,
    };
  }
  // The gateway and the terminal login/logout command must resolve one private store file. Resolve
  // the future canonical data directory without creating it: a failed startup keeps its existing
  // side-effect-free behavior, and startup later re-checks that the validated, chmodded canonical
  // directory is exactly this one.
  let credentialStoreDir: string;
  try {
    credentialStoreDir = await canonicalFuturePath(config.dataDir);
  } catch (cause) {
    throw new StartupDiagnosticError("workspace", { cause });
  }
  // Offline last-good catalog from an explicit `models refresh`; an unusable file is the bundled catalog.
  const catalog = await loadModelCatalog(credentialStoreDir);
  if (catalog.issue !== undefined) journalEvent("model_catalog.ignored", { reason: catalog.issue });
  const prepared = createProviderModels(
    config, process.env, new FileCredentialStore(authStorePath(credentialStoreDir)), catalog.overlay,
  );
  const resolved = resolveModelConfiguration(config, prepared.models);
  await assertConfiguredModelAuth(prepared.models, resolved.choices, context.abortSignal);
  return { models: prepared.models, resolved, classifierGrant: prepared.classifier, credentialStoreDir };
}

/** Every background and auxiliary model choice the configuration pins, validated against the catalog. */
export interface BackgroundModels {
  /** Memory digestion: `digest.preset` or `digest.model` only, never the origin's current model. */
  readonly digestChoice: PinnedModelChoice | undefined;
  /** `workers.preset`; absent, a worker uses the spawning conversation's current selection. */
  readonly workerPreset: PinnedModelChoice | undefined;
  /** The configured vision describer and its flagged native models. */
  readonly visionHandoff: VisionHandoff | undefined;
  /** `episodeSummary.preset` or `.model`; the conversation model is used when both are absent. */
  readonly configuredSummary: { readonly model: ModelReference; readonly thinkingLevel?: ModelThinkingLevel } | undefined;
  /** The effective episode-summary model, or `undefined` when summaries are disabled. */
  readonly episodeSummaryModel: OpenGatewayOptions["episodeSummary"];
  readonly useConversationSummaryModel: boolean;
}

/** A model or preset that names something outside the configured catalog. */
const modelError = (detail: string) => new StartupDiagnosticError("model", { detail });

/**
 * Validate every background model choice before storage opens. A preset or model that is not in the
 * finite configured catalog is one `model` startup diagnostic, whichever feature names it.
 */
export function resolveBackgroundModels(
  config: PortConfig,
  options: OpenGatewayOptions,
  startup: Pick<StartupModels, "models" | "resolved" | "classifierGrant">,
): BackgroundModels {
  const { models } = startup;
  const { choices, choicesByConfigured, presetCatalog, defaultChoice } = startup.resolved;
  let digestChoice: PinnedModelChoice | undefined;
  if (config.digest?.preset !== undefined) {
    const preset = presetCatalog.get(config.digest.preset);
    if (preset === undefined) throw modelError("digest.preset must name a configured model preset");
    // A preset keeps its configured thinking level; a direct model runs at the lowest level it supports.
    const level = preset.thinkingLevel ?? "off";
    digestChoice = {
      model: { provider: preset.choice.native.provider, modelId: preset.choice.native.modelId },
      thinkingLevel: preset.choice.thinkingLevels.includes(level) ? level : preset.choice.thinkingLevels[0]!,
    };
  } else if (config.digest?.model !== undefined) {
    const choice = choicesByConfigured.get(modelKey(config.digest.model));
    if (choice === undefined) throw modelError("digest.model must be included in allowedModels");
    digestChoice = {
      model: { provider: choice.native.provider, modelId: choice.native.modelId },
      thinkingLevel: choice.thinkingLevels.includes("off") ? "off" : choice.thinkingLevels[0]!,
    };
  }
  // Idle rollover classifies the owner's next message with the one configured classifier. This is a
  // structural requirement of the configuration, not an unavailable model.
  if (config.idleRollover !== undefined && startup.classifierGrant === undefined) {
    throw new StartupDiagnosticError("configInvalid", { detail: "idleRollover requires classifierModel" });
  }
  // App thread badges are a second opt-in that classifies through the same one model.
  if (config.app?.threadBadges === true && startup.classifierGrant === undefined) {
    throw new StartupDiagnosticError("configInvalid", { detail: "app.threadBadges requires classifierModel" });
  }
  if (config.workspaceContext?.memory === "proactive" && startup.classifierGrant === undefined) {
    throw new StartupDiagnosticError("configInvalid", { detail: "workspaceContext.memory requires classifierModel in proactive mode" });
  }
  let workerPreset: PinnedModelChoice | undefined;
  if (config.workers?.preset !== undefined) {
    const selected = presetCatalog.get(config.workers.preset);
    if (selected === undefined) throw modelError("workers.preset must name a configured model preset");
    workerPreset = { model: selected.choice.native, thinkingLevel: selected.thinkingLevel ?? "off" };
  }
  let visionHandoff: VisionHandoff | undefined;
  if (config.visionHandoff !== undefined) {
    const describerPreset = presetCatalog.get(config.visionHandoff.describerPreset);
    if (describerPreset === undefined) throw modelError("visionHandoff.describerPreset must name a configured model preset");
    if (!describerPreset.choice.model.input.includes("image")) {
      throw modelError("visionHandoff.describerPreset must name a model that accepts image input");
    }
    const flaggedModels = new Set<string>();
    const flagsByNativePair = new Map<string, { readonly name: string; readonly flag: boolean }>();
    for (const [name, preset] of Object.entries(config.modelPresets ?? {})) {
      const choice = presetCatalog.get(name);
      if (choice === undefined) throw modelError(`Model preset ${name} is outside the configured model catalog`);
      const flag = preset.needsVisionHandoff === true;
      // Requests carry the native provider/model pair, never the config alias. Compare and key
      // flags by that native pair, so aliasing cannot silently disable a text-only flag.
      const key = modelKey(choice.choice.native);
      const previous = flagsByNativePair.get(key);
      if (previous !== undefined && previous.flag !== flag) {
        throw modelError(`Model presets ${previous.name} and ${name} disagree on needsVisionHandoff for the same native model`);
      }
      flagsByNativePair.set(key, { name, flag });
      if (!flag) continue;
      if (name === config.visionHandoff.describerPreset) {
        throw modelError("visionHandoff.describerPreset must not itself need vision handoff");
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
  }
  // A configured summary override must be allowed. `preset` resolves through the named catalog and
  // supplies its thinking level to real summary jobs; `model` keeps the legacy direct form.
  // Otherwise each job captures the conversation's current model when it starts; old history is not
  // backfilled automatically.
  let configuredSummary: BackgroundModels["configuredSummary"];
  if (config.episodeSummary?.preset !== undefined) {
    const summaryPreset = presetCatalog.get(config.episodeSummary.preset);
    if (summaryPreset === undefined) throw modelError("episodeSummary.preset must name a configured model preset");
    configuredSummary = {
      model: summaryPreset.choice.native,
      ...(summaryPreset.thinkingLevel === undefined ? {} : { thinkingLevel: summaryPreset.thinkingLevel }),
    };
  } else if (config.episodeSummary?.model !== undefined) {
    const summaryChoice = choicesByConfigured.get(modelKey(config.episodeSummary.model));
    if (summaryChoice === undefined) throw modelError("episodeSummary.model must be included in allowedModels");
    configuredSummary = { model: summaryChoice.native };
  }
  if (options.episodeSummary === null) throw modelError("episodeSummary must be an object");
  const episodeSummaryModel: OpenGatewayOptions["episodeSummary"] = options.episodeSummary ?? (config.episodeSummary?.enabled === false
    ? undefined
    : configuredSummary === undefined
      ? defaultChoice.native
      : {
          ...configuredSummary.model,
          ...(configuredSummary.thinkingLevel === undefined ? {} : { thinkingLevel: configuredSummary.thinkingLevel }),
        });
  if (episodeSummaryModel !== undefined) {
    if (episodeSummaryModel === null || typeof episodeSummaryModel !== "object" || Array.isArray(episodeSummaryModel)) {
      throw modelError("episodeSummary must be an object");
    }
    if (typeof episodeSummaryModel.provider !== "string" || episodeSummaryModel.provider.length === 0
      || typeof episodeSummaryModel.modelId !== "string" || episodeSummaryModel.modelId.length === 0) {
      throw modelError("episodeSummary requires a provider and modelId");
    }
    const choice = choices.find((candidate) =>
      candidate.native.provider === episodeSummaryModel.provider
      && candidate.native.modelId === episodeSummaryModel.modelId);
    if (choice === undefined) throw modelError("episodeSummary provider/model must be included in allowedModels");
    if (models.getModel(episodeSummaryModel.provider, episodeSummaryModel.modelId) === undefined) {
      throw modelError("episodeSummary model is not in the provider catalog");
    }
    if (episodeSummaryModel.backfill !== undefined
      && episodeSummaryModel.backfill !== "none" && episodeSummaryModel.backfill !== "pending") {
      throw modelError('episodeSummary backfill must be "none" or "pending"');
    }
    // The level must be supported by the selected summary model, not merely a known string: a
    // provider rejects an unsupported level at request time, which would burn an episode attempt.
    if (episodeSummaryModel.thinkingLevel !== undefined && !choice.thinkingLevels.includes(episodeSummaryModel.thinkingLevel)) {
      throw modelError("episodeSummary thinkingLevel is not supported by the summary model");
    }
  }
  return {
    digestChoice,
    workerPreset,
    visionHandoff,
    configuredSummary,
    episodeSummaryModel,
    useConversationSummaryModel: options.episodeSummary === undefined && configuredSummary === undefined,
  };
}

/** The live foreground catalog, replaced only as a whole by a published reload. */
export interface LiveModelState {
  readonly models: Models;
  readonly resolved: ResolvedModelConfiguration;
  readonly publicPresets: readonly GatewayModelPreset[];
  readonly defaultAgentPolicy: AgentChange;
  /** The configuration these models were resolved from; the reload compatibility baseline. */
  readonly config: PortConfig;
}

const publicChoice = (choice: ResolvedModelChoice): GatewayModelChoice => ({
  ...choice.configured,
  name: choice.model.name,
  thinkingLevels: [...choice.thinkingLevels],
});

const publicSelection = (choice: ResolvedModelChoice, thinkingLevel: ModelThinkingLevel): GatewayModelSelection => ({
  ...choice.configured,
  thinkingLevel,
});

const publicPresetsFor = (resolved: ResolvedModelConfiguration): readonly GatewayModelPreset[] =>
  [...resolved.presetCatalog].map(([name, preset]) => ({
    name,
    ...preset.choice.configured,
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
  }));

export interface ModelHostOptions {
  readonly config: PortConfig;
  readonly startup: StartupModels;
  readonly options: OpenGatewayOptions;
  /** Host policy every conversation keeps (its declared cwd). */
  readonly hostPolicy: AgentChange;
  /** Background models the configuration file cannot rebuild; a reload may not drop one. */
  readonly pinned: () => readonly ModelReference[];
}

/** What selection and reload need from the open gateway, bound once the harness is open. */
export interface ModelHostBinding {
  readonly harness: HarnessType;
  readonly root: Conversation;
  readonly existingConversationFor: (sessionKey: string, context: Context) => Promise<Conversation>;
  readonly mappedConversationId: (sessionKey: string, context: Context) => Promise<ConversationId | undefined>;
  readonly applyConversationPolicy: (conversation: Conversation, context: Context) => Promise<void>;
  readonly toolFilterFor: (tx: Tx, id: ConversationId) => Promise<Pick<AgentChange, "tools" | "modelTools">>;
  /** Foreground mapped chats: the only conversations a reload repolicies. */
  readonly chats: () => readonly ConversationId[];
  /** The live configuration a candidate is classified against, including a managed MCP edit. */
  readonly liveMcpConfig: () => McpConfig | undefined;
}

export type ModelHost = ReturnType<typeof createModelHost>;

export function createModelHost(host: ModelHostOptions) {
  const { hostPolicy, options } = host;
  const defaultAgentPolicyFor = (resolved: ResolvedModelConfiguration): AgentChange => ({
    ...hostPolicy,
    model: resolved.defaultChoice.native,
    thinkingLevel: resolved.defaultThinkingLevel,
    tools: [],
    modelTools: [],
  });
  let state: LiveModelState = {
    models: host.startup.models,
    resolved: host.startup.resolved,
    publicPresets: publicPresetsFor(host.startup.resolved),
    defaultAgentPolicy: defaultAgentPolicyFor(host.startup.resolved),
    config: host.config,
  };
  let binding: ModelHostBinding | undefined;
  const bound = (): ModelHostBinding => {
    if (binding === undefined) throw new Error("The runtime is not open");
    return binding;
  };

  /** A level the choice supports: the preferred one, otherwise `off`. */
  const fallbackThinkingLevel = (
    choice: ResolvedModelChoice,
    preferred: ModelThinkingLevel = state.resolved.defaultThinkingLevel,
  ): ModelThinkingLevel => choice.thinkingLevels.includes(preferred) ? preferred : "off";

  const choiceFromState = (agent: Readonly<AgentState> | undefined): ResolvedModelChoice | undefined =>
    agent?.model === undefined ? undefined : state.resolved.choicesByNative.get(modelKey(agent.model));

  /** The persisted selection as the live catalog resolves it, with a supported thinking level. */
  const selectionOf = (agent: Readonly<AgentState> | undefined): { choice: ResolvedModelChoice; level: ModelThinkingLevel } => {
    const choice = choiceFromState(agent) ?? state.resolved.defaultChoice;
    const level = agent?.thinkingLevel !== undefined && choice.thinkingLevels.includes(agent.thinkingLevel)
      ? agent.thinkingLevel
      : fallbackThinkingLevel(choice);
    return { choice, level };
  };

  /**
   * Reapply host policy to a persisted conversation, computed only from one resolved catalog so a
   * reload can evaluate a candidate without touching the live snapshot first. Named-preset mode
   * additionally resets a selection left by a previous run to the configured preset on startup, so
   * a temporary CLI switch never survives a restart or a configuration reload.
   */
  const policyAgainst = (
    resolved: ResolvedModelConfiguration,
    agent: Readonly<AgentState> | undefined,
    resetToConfiguredPreset = false,
  ): AgentChange => {
    const existing = resetToConfiguredPreset
      ? undefined
      : agent?.model === undefined ? undefined : resolved.choicesByNative.get(modelKey(agent.model));
    const choice = existing ?? resolved.defaultChoice;
    const thinkingLevel = existing !== undefined && agent?.thinkingLevel !== undefined && choice.thinkingLevels.includes(agent.thinkingLevel)
      ? agent.thinkingLevel
      : fallbackThinkingLevel(choice, resolved.defaultThinkingLevel);
    return { ...hostPolicy, model: choice.native, thinkingLevel };
  };

  const policyForState = (agent: Readonly<AgentState> | undefined, resetToConfiguredPreset = false): AgentChange =>
    policyAgainst(state.resolved, agent, resetToConfiguredPreset);

  /**
   * The level a background target pinned at launch runs at. While its model is still in the catalog
   * an unsupported level falls back inside that model (`lowest` for digestion, which never inherits
   * the foreground default); a model that left the catalog keeps its pin, and that target fails
   * closed instead of being moved to a default.
   */
  const pinnedThinkingLevel = (
    model: ModelReference, level: ModelThinkingLevel, fallback: "default" | "lowest",
  ): ModelThinkingLevel => {
    const choice = state.resolved.choicesByNative.get(modelKey(model));
    if (choice === undefined) return level;
    if (choice.thinkingLevels.includes(level)) return level;
    if (fallback === "default") return fallbackThinkingLevel(choice);
    return choice.thinkingLevels.includes("off") ? "off" : choice.thinkingLevels[0]!;
  };

  const allowModel = (candidate: ModelReference): boolean => state.resolved.choicesByNative.has(modelKey(candidate));

  /** Shared atomic selection path for direct choices and named presets. */
  const selectConversationModel = async (
    sessionKey: string, selection: GatewayModelSelectionRequest, ctx: Context,
  ): Promise<GatewayModelSelection> => {
    if (!isModelSelection(selection)) throw new Error("Model selection requires provider and modelId strings");
    const target = state.resolved.choicesByConfigured.get(modelKey(selection));
    if (!target) throw new Error("Model is not in the configured allowlist");
    const requestedLevel = Object.hasOwn(selection, "thinkingLevel") ? selection.thinkingLevel : undefined;
    if (requestedLevel !== undefined && !target.thinkingLevels.includes(requestedLevel)) {
      throw new Error(`Unsupported thinkingLevel ${requestedLevel} for ${selection.provider}/${selection.modelId}`);
    }
    const { existingConversationFor, toolFilterFor } = bound();
    const conversation = await existingConversationFor(sessionKey, ctx);
    const level = await conversation.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, conversation.id);
      const current = choiceFromState(agent);
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run !== undefined) throw new ConversationBusy(conversation.id);
      const changed = current === undefined || modelKey(current.native) !== modelKey(target.native);
      const currentLevel = current !== undefined && agent.thinkingLevel !== undefined && current.thinkingLevels.includes(agent.thinkingLevel)
        ? agent.thinkingLevel
        : fallbackThinkingLevel(current ?? state.resolved.defaultChoice);
      const nextLevel = requestedLevel ?? (changed
        ? fallbackThinkingLevel(target)
        : target.thinkingLevels.includes(currentLevel) ? currentLevel : fallbackThinkingLevel(target));
      const toolFilter = await toolFilterFor(tx, conversation.id);
      await configure(tx, conversation.id, { ...hostPolicy, model: target.native, thinkingLevel: nextLevel, ...toolFilter });
      return nextLevel;
    }, ctx);
    return publicSelection(target, level);
  };

  const modelPresets = (): GatewayModelPresets | undefined => state.resolved.configuredPresetName === undefined
    ? undefined
    : { presets: state.publicPresets, defaultPreset: state.resolved.configuredPresetName };

  async function listModels(sessionKey: string, ctx: Context): Promise<GatewayModelList> {
    const { existingConversationFor, applyConversationPolicy, harness } = bound();
    const conversation = await existingConversationFor(sessionKey, ctx);
    await applyConversationPolicy(conversation, ctx);
    const { choice, level } = selectionOf(await harness.snapshot(AgentDoc, conversation.id, ctx));
    const presets = modelPresets();
    return {
      models: state.resolved.choices.map(publicChoice),
      selected: publicSelection(choice, level),
      ...(presets === undefined ? {} : presets),
    };
  }

  async function selectedModel(sessionKey: string, ctx: Context): Promise<GatewayModelSelection | undefined> {
    const { mappedConversationId, harness } = bound();
    const id = await mappedConversationId(sessionKey, ctx);
    if (id === undefined) return undefined;
    const agent = await harness.snapshot(AgentDoc, id, ctx);
    // Mapped but unreadable is unknown, never the default.
    if (agent === undefined) throw new Error("missing conversation state");
    const { choice, level } = selectionOf(agent);
    return publicSelection(choice, level);
  }

  async function selectModelPreset(sessionKey: string, name: string, ctx: Context): Promise<GatewayModelSelection> {
    const configuredPresetName = state.resolved.configuredPresetName;
    if (configuredPresetName === undefined) {
      throw new Error("Named model presets are not configured; use the direct model selection");
    }
    if (typeof name !== "string" || name.length === 0) throw new Error("Model preset name must be a non-empty string");
    const preset = state.resolved.presetCatalog.get(name === "default" ? configuredPresetName : name);
    if (preset === undefined) throw new Error("Unknown model preset");
    // A preset always supplies a concrete thinking level, so selecting it is deterministic even
    // when two names share the same provider/model pair.
    return selectConversationModel(sessionKey, { ...preset.choice.configured, thinkingLevel: preset.thinkingLevel ?? "off" }, ctx);
  }

  /**
   * Explicit host reload of the foreground model catalog and credential references.
   *
   * The contract is deliberately narrow. Everything is validated before the first in-memory
   * change, the candidate may differ from the live file only in foreground model fields, and the
   * snapshot is published only with the exact commit Storage stored (a revision document in that
   * commit identifies it). Any live work other than an armed native cron timer refuses the reload:
   * a sleeping or blocked capture can resume later, and rotating a credential or catalog under it
   * would silently change the authority of work admitted under the previous policy. Work admitted
   * after the commit uses the newly published registry and credentials.
   */
  let reloadInProgress = false;
  const effectiveLiveConfig = (): PortConfig => {
    const liveMcp = bound().liveMcpConfig();
    if (liveMcp === state.config.mcp) return state.config;
    const { mcp: _startupMcp, ...rest } = state.config;
    return liveMcp === undefined ? rest : { ...rest, mcp: liveMcp };
  };
  /** An armed native cron timer sleeps until its slot and holds no model capture. */
  const armedCronTimer = (kind: string, status: string): boolean => kind === CRON_TIMER_TASK_NAME && status === "sleeping";
  // A queued owner input is work even before its native task exists, so it blocks a reload just as
  // an executing task does. Every live task blocks except an armed native cron timer, including a
  // sleeping or blocked task whose captured model and credential would otherwise change.
  const reloadBlocked = async (ctx: Context): Promise<boolean> => {
    const inspection = await bound().harness.inspect(ctx);
    return inspection.submissions.length > 0
      || inspection.tasks.some((task) => !armedCronTimer(task.record.kind, task.state.kind));
  };
  const credentialStoreDir = host.startup.credentialStoreDir;
  const reloadAvailable = options.reloadConfig !== undefined && options.models === undefined;

  const reloadModels = async (ctx: Context): Promise<ModelReloadResult> => {
    if (options.reloadConfig === undefined || options.models !== undefined || credentialStoreDir === undefined) {
      return { status: "refused", reason: "unavailable" };
    }
    if (reloadInProgress) return { status: "busy" };
    reloadInProgress = true;
    const { harness, root, chats } = bound();
    let observation: CommitObservation | undefined;
    let pending: { readonly revision: string; readonly publish: () => void } | undefined;
    try {
      if (await reloadBlocked(ctx)) return { status: "busy" };
      let candidate: PortConfig;
      try {
        candidate = await options.reloadConfig();
      } catch {
        return { status: "refused", reason: "invalid" };
      }
      const compatibility = modelReloadCompatibility(effectiveLiveConfig(), candidate);
      if (compatibility === "unrelated") return { status: "refused", reason: "unrelated" };
      if (compatibility === "mode") return { status: "refused", reason: "mode" };
      if (compatibility === "pinned") return { status: "refused", reason: "pinned" };
      const counts = (value: PortConfig) => ({
        models: (value.allowedModels ?? [value.model]).length,
        presets: value.modelPresets === undefined ? 0 : Object.keys(value.modelPresets).length,
        ...(value.modelPreset === undefined ? {} : { defaultPreset: value.modelPreset }),
      });
      if (compatibility === "unchanged") return { status: "unchanged", ...counts(effectiveLiveConfig()) };

      let nextModels: Models;
      let nextResolved: ResolvedModelConfiguration;
      try {
        nextModels = createProviderModels(
          candidate,
          process.env,
          new FileCredentialStore(authStorePath(credentialStoreDir)),
          (await loadModelCatalog(credentialStoreDir)).overlay,
        ).models;
        nextResolved = resolveModelConfiguration(candidate, nextModels);
        await assertConfiguredModelAuth(nextModels, nextResolved.choices, ctx.abortSignal);
      } catch {
        // Parse, provider, catalog and credential failures are all a candidate this host refuses.
        // Nothing above this point changed the live catalog or a conversation.
        return { status: "refused", reason: "invalid" };
      }
      // Validation may have awaited environment or credential reads; do not apply over work that
      // started meanwhile.
      if (await reloadBlocked(ctx)) return { status: "busy" };
      for (const model of host.pinned()) {
        if (!nextResolved.choicesByNative.has(modelKey(model))) return { status: "refused", reason: "pinned" };
      }

      // The candidate snapshot is complete before anything is published: one assignment swaps it,
      // so no concurrent read can observe a partly replaced catalog while an await is pending.
      const next: LiveModelState = {
        models: nextModels,
        resolved: nextResolved,
        publicPresets: publicPresetsFor(nextResolved),
        defaultAgentPolicy: defaultAgentPolicyFor(nextResolved),
        config: candidate,
      };
      const revision = randomUUID();
      let published = false;
      const publish = (): void => {
        if (published) return;
        published = true;
        state = next;
      };
      pending = { revision, publish };
      observation = harness.observeCommits({
        // Synchronous assignment only: publishes the candidate exactly when Storage stored the
        // commit carrying this revision document. It never awaits, throws or calls the Session.
        advance: (publication: CommitPublication) => {
          const awaiting = pending;
          if (awaiting === undefined || !publicationCarriesRevision(publication, awaiting.revision)) return;
          pending = undefined;
          awaiting.publish();
        },
        end: () => {},
      });
      const outcome = await (async () => {
        try {
          return await root.commit(async (tx) => {
            // Definitive gate on the Session line: no submission, task creation or configuration
            // commit can interleave with these reads and writes. Native nonterminal states are
            // scanned one status at a time so a long terminal history costs no full scan.
            for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
              let taskCursor: Cursor | undefined;
              do {
                const page = await tx.scanTasks({ status }, 1000, taskCursor);
                for (const record of page.items) {
                  if (!armedCronTimer(record.kind, record.state.status)) return { kind: "busy" } as const;
                }
                taskCursor = page.next;
              } while (taskCursor !== undefined);
            }
            // A managed MCP edit rewrites the same file and updates the live block; any other MCP
            // change that landed while the candidate was validated stays a startup-only refusal.
            if (modelReloadCompatibility(effectiveLiveConfig(), candidate) !== "reloadable") {
              return { kind: "unrelated" } as const;
            }
            for (const model of host.pinned()) {
              if (!nextResolved.choicesByNative.has(modelKey(model))) return { kind: "pinned" } as const;
            }
            // A queued or placed owner input is refused in the same commit that would repolicy the
            // conversation, so no admitted turn can begin under a policy this reload replaced.
            const foreground = chats();
            for (const conversationId of foreground) {
              const live = await tx.doc(LiveDoc, conversationId);
              if (live.run !== undefined) return { kind: "busy" } as const;
              const inbox = await tx.doc(InboxDoc, conversationId);
              if (inbox.items.length > 0) return { kind: "busy" } as const;
            }
            // Auth validation and the preceding reads may have awaited while an outside editor
            // changed the file. Compare a fresh parsed snapshot before the first policy write;
            // checking only effectiveLiveConfig would miss unapplied edits on disk.
            let latest: PortConfig;
            try { latest = await options.reloadConfig!(); }
            catch { return { kind: "invalid" } as const; }
            if (modelReloadCompatibility(candidate, latest) !== "unchanged") return { kind: "unrelated" } as const;
            // Only foreground mapped chats are repolicied. An automation, worker or digest target
            // keeps the exact model, thinking level and per-run authority prepared for its run, and
            // the registry gives each conversation exactly one role.
            for (const conversationId of foreground) {
              const agent = await tx.doc(AgentDoc, conversationId);
              const change = policyAgainst(nextResolved, agent, nextResolved.configuredPresetName !== undefined);
              await configure(tx, conversationId, {
                model: change.model ?? null,
                thinkingLevel: change.thinkingLevel ?? null,
              });
            }
            const doc = await tx.doc(ModelPolicyRevisionDoc);
            doc.revision = revision;
            return { kind: "applied" } as const;
          }, ctx);
        } finally {
          // The commit either published (the observer runs before its wait resolves) or stored
          // nothing; the pending candidate is dropped either way.
          observation?.detach();
          observation = undefined;
          pending = undefined;
        }
      })();
      if (outcome.kind === "busy") return { status: "busy" };
      if (outcome.kind === "unrelated") return { status: "refused", reason: "unrelated" };
      if (outcome.kind === "invalid") return { status: "refused", reason: "invalid" };
      if (outcome.kind === "pinned") return { status: "refused", reason: "pinned" };
      // Durable publishes a stored commit to `observeCommits()` observers before the commit's wait
      // resolves. This fallback is a no-op unless that ever changed, and keeps the in-memory
      // catalog consistent with the commit that really landed.
      publish();
      return { status: "reloaded", ...counts(candidate) };
    } finally {
      observation?.detach();
      pending = undefined;
      reloadInProgress = false;
    }
  };

  return {
    /** The current immutable snapshot; never cache it across an await that may reload. */
    state: (): LiveModelState => state,
    bind(next: ModelHostBinding): void { binding = next; },
    fallbackThinkingLevel,
    choiceFromState,
    selectionOf,
    policyAgainst,
    policyForState,
    pinnedThinkingLevel,
    allowModel,
    listModels,
    modelPresets,
    selectedModel,
    selectModel: selectConversationModel,
    selectModelPreset,
    reloadModels: reloadAvailable ? reloadModels : undefined,
  };
}

