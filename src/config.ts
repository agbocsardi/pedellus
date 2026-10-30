import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONTEXT_LIMITS } from "./context/index.js";
import {
  MemoryContextBoundsError,
  MemoryContextInputError,
  validateMemoryLoadedFiles,
} from "./context/memory.js";
import {
  WorkspaceContextBoundsError,
  WorkspaceContextInputError,
  validateWorkspaceMemoryFiles,
} from "./context/workspace.js";
import {
  SkillsContextBoundsError,
  SkillsContextInputError,
  validateSkillNames,
} from "./context/skills.js";
import { validateMediaDirectory } from "./media/attachments.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import { parseMcpConfig, type McpConfig } from "./mcp/config.js";
import { VISION_HANDOFF_DEFAULTS, VISION_HANDOFF_LIMITS } from "./media/vision.js";

const CREDENTIAL_PROVIDERS = [
  "anthropic",
  "deepseek",
  "minimax_anthropic",
  "moonshot",
  "openai",
  "openrouter",
  "opencode_zen",
  "opencode_go",
  "xiaomi_mimo",
] as const;

export type CredentialProvider = typeof CREDENTIAL_PROVIDERS[number];

/**
 * Largest default shell timeout the native host environment can represent:
 * `2_147_483_647` ms. Config values are integer seconds.
 */
export const TOOL_TIMEOUT_MAX_SECONDS = 2_147_483;

export interface ModelReference {
  provider: string;
  modelId: string;
}

/** One named model choice: provider, native model ID, and an optional thinking level. */
export interface ModelPreset extends ModelReference {
  readonly thinkingLevel?: ModelThinkingLevel;
  /**
   * The preset's model cannot take images. Its requests keep zero raw images:
   * every image is replaced by a describer preset's text description. Presets
   * that share a provider/model pair must agree, so the flag never collapses
   * ambiguously into pair-only matching at request time.
   */
  readonly needsVisionHandoff?: boolean;
}

/**
 * Configured vision handoff. Presence enables it; a preset marked
 * `needsVisionHandoff` is a startup error without it.
 */
export interface VisionHandoffConfig {
  /** Named preset whose vision-capable model describes images. */
  readonly describerPreset: string;
  /** Newest images kept raw for a vision-capable target. */
  readonly maxRawImages: number;
  /** Output token ceiling for one description. */
  readonly maxDescriptionTokens: number;
  /** Optional describer instruction override. */
  readonly prompt?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface WorkspaceSkillsConfig {
  /** Explicit absolute builtin skills root; absent means workspace skills only. */
  readonly builtinSkillsRoot?: string;
  /** Configured-disabled names; discovered but never enabled. */
  readonly disabledSkills: readonly string[];
}

export interface CronConfig {
  /** Opt-in agent-callable scheduling; false installs no cron tool and registers no cron tasks. */
  readonly enabled: boolean;
  /** IANA zone used by calendar expressions that omit `tz`. Defaults to UTC. */
  readonly timeZone?: string;
}

export interface WorkspaceContextConfig {
  /** Explicit workspace-relative `memory/**\/*.md` files, in output order. Defaults to none. */
  readonly memoryFiles: readonly string[];
  /**
   * Opt-in topic memory manifest. The named `memoryFiles` are marked loaded and
   * the remaining `memory/**\/*.md` topics are listed for on-demand reads.
   * Absent or false leaves the snapshot unchanged.
   */
  readonly memoryManifest?: boolean;
  /** Explicit opt-in for workspace/builtin skill discovery; absent means no skills are read. */
  readonly skills?: WorkspaceSkillsConfig;
}

export interface MediaTranscriptionConfig {
  /** Absent or true enables local faster-whisper transcription of stored audio. */
  readonly enabled?: boolean;
  /** Language hint for the local helper; absent means auto-detect. */
  readonly language?: string;
  /** Audio longer than this is not transcribed; defaults to 120 seconds. */
  readonly maxDurationSeconds?: number;
}

/**
 * Channel-neutral attachment storage. Originals stay under the configured
 * workspace so the ordinary coding-tool policy applies to them; they are never
 * written to `dataDir` or an arbitrary external root.
 */
export interface MediaConfig {
  /** Workspace-relative directory for originals; default `media`. */
  readonly directory: string;
  readonly transcription?: MediaTranscriptionConfig;
}

export interface PortConfig {
  workspace: string;
  dataDir: string;
  /**
   * Explicit opt-in for bounded workspace context. Absent means the gateway
   * installs no context extension; there is no implicit workspace discovery.
   */
  workspaceContext?: WorkspaceContextConfig;
  /**
   * Normalized default selection. In named-preset mode this is the configured preset's
   * provider/model pair; direct configs keep their explicit `model`.
   */
  model: ModelReference;
  /**
   * Explicit finite model choices. Missing means the legacy singleton [model]. Named-preset
   * mode derives this from the catalog, so users never repeat preset entries here.
   */
  allowedModels?: readonly ModelReference[];
  /**
   * Named model catalog. Present only in named-preset mode, together with `modelPreset`.
   * The catalog is the source of both the default and the allowed provider/model pairs.
   */
  modelPresets?: Readonly<Record<string, ModelPreset>>;
  /** Configured default preset name; absent means legacy direct `model` selection. */
  modelPreset?: string;
  /**
   * Image handoff for flagged text-only presets and the raw-image bound for
   * vision-capable ones. Absent leaves model requests untouched.
   */
  visionHandoff?: VisionHandoffConfig;
  /** Host-owned global ceiling; conversations may only narrow it. Empty means tools are disabled. */
  toolAllowlist?: readonly string[];
  /**
   * Config-level default shell timeout in seconds for the host tool environment. `0` disables the
   * timeout. Absent keeps the shared policy default. This is not the per-call cap.
   */
  toolTimeoutSeconds?: number;
  /**
   * Shell backend for the opt-in coding tools. Absent or `host` keeps the guarded native shell;
   * `bwrap` runs shell commands under direct-workspace Bubblewrap and fails closed when unavailable.
   */
  toolSandbox?: "host" | "bwrap";
  /** Internal agent scheduling. Absent or disabled leaves the runtime without cron. */
  cron?: CronConfig;
  /**
   * Explicit MCP servers and the switch that connects them. This is a separate authority from
   * `toolAllowlist`: naming a server connects it, and its tools still reach only authenticated
   * mapped chat conversations. Absent or disabled installs no MCP client and no Code Mode.
   */
  mcp?: McpConfig;
  /**
   * Automatic episode summaries; by default use the conversation's current model.
   * `model` is the legacy direct selector; `preset` names an entry in `modelPresets`.
   */
  episodeSummary?: {
    readonly enabled?: boolean;
    readonly model?: ModelReference;
    readonly preset?: string;
  };
  thinkingLevel?: ModelThinkingLevel;
  extraAllowedDirs?: readonly string[];
  bwrapPath?: string;
  credentials?: Partial<Record<CredentialProvider, string>>;
  /**
   * Opt-in attachment ingress (photos, voice/audio, documents) for channels that
   * can download them. Absent means a channel keeps its attachment-disabled behavior.
   */
  media?: MediaConfig;
  telegram?: { tokenEnv: string; allowFrom: readonly string[]; pollTimeoutSeconds?: number };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must be a plain object`);
  const copy = Object.fromEntries(Object.entries(value));
  Object.setPrototypeOf(copy, null);
  return copy;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}
function envName(value: unknown, name: string): string {
  const result = nonempty(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new Error(`${name} must be an environment variable name`);
  return result;
}

/** Validate the config-level shell default before any provider, storage or tool setup. */
export function parseToolTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > TOOL_TIMEOUT_MAX_SECONDS) {
    throw new Error(`toolTimeoutSeconds must be an integer from 0 to ${TOOL_TIMEOUT_MAX_SECONDS}`);
  }
  return value;
}

function modelReference(value: unknown, name: string): ModelReference {
  const model = object(value, name);
  return {
    provider: nonempty(model.provider, `${name}.provider`),
    modelId: nonempty(model.modelId, `${name}.modelId`),
  };
}

/** Stable identity for a provider/model pair; shared by config validation and provider resolution. */
export function modelKey(model: ModelReference): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function modelThinkingLevel(value: unknown, name: string): ModelThinkingLevel {
  if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ModelThinkingLevel;
}

function modelPresetName(value: unknown, name: string): string {
  const result = nonempty(value, name);
  // `default` is the selection command that returns to the configured preset, not a catalog entry.
  if (result === "default") throw new Error(`${name} must not use the reserved name "default"`);
  if (/[\s\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${name} must not contain whitespace or control characters`);
  }
  return result;
}

function modelPresetsConfig(value: unknown): Readonly<Record<string, ModelPreset>> {
  const raw = object(value, "modelPresets");
  if (Object.keys(raw).length === 0) throw new Error("modelPresets must contain at least one preset");
  const presets: Record<string, ModelPreset> = Object.create(null) as Record<string, ModelPreset>;
  for (const [rawName, entry] of Object.entries(raw)) {
    const name = modelPresetName(rawName, "modelPresets name");
    const preset = object(entry, `modelPresets.${name}`);
    for (const key of Object.keys(preset)) {
      if (key !== "provider" && key !== "modelId" && key !== "thinkingLevel" && key !== "needsVisionHandoff") {
        throw new Error(`Unknown modelPresets.${name} field: ${key}`);
      }
    }
    if (preset.needsVisionHandoff !== undefined && typeof preset.needsVisionHandoff !== "boolean") {
      throw new Error(`modelPresets.${name}.needsVisionHandoff must be a boolean`);
    }
    presets[name] = Object.freeze({
      ...modelReference(preset, `modelPresets.${name}`),
      ...(preset.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: modelThinkingLevel(preset.thinkingLevel, `modelPresets.${name}.thinkingLevel`) }),
      ...(preset.needsVisionHandoff === true ? { needsVisionHandoff: true } : {}),
    });
  }
  // A request is matched to a target preset by its native provider/model pair.
  // Same-pair presets may differ in thinking level, never in whether images fit:
  // otherwise the flag would silently collapse into pair-only matching.
  const flagsByPair = new Map<string, { readonly name: string; readonly flag: boolean }>();
  for (const [name, preset] of Object.entries(presets)) {
    const key = modelKey(preset);
    const flag = preset.needsVisionHandoff === true;
    const previous = flagsByPair.get(key);
    if (previous !== undefined && previous.flag !== flag) {
      throw new Error(
        `modelPresets.${name}.needsVisionHandoff conflicts with modelPresets.${previous.name} ` +
        "for the same provider/model pair",
      );
    }
    flagsByPair.set(key, { name, flag });
  }
  return Object.freeze(presets);
}

function visionHandoffConfig(
  value: unknown,
  modelPresets: Readonly<Record<string, ModelPreset>> | undefined,
): VisionHandoffConfig {
  const raw = object(value, "visionHandoff");
  for (const key of Object.keys(raw)) {
    if (key !== "describerPreset" && key !== "maxRawImages" && key !== "maxDescriptionTokens" && key !== "prompt") {
      throw new Error(`Unknown visionHandoff field: ${key}`);
    }
  }
  if (modelPresets === undefined) {
    throw new Error("visionHandoff requires named modelPresets and a describerPreset");
  }
  const describerPreset = modelPresetName(raw.describerPreset, "visionHandoff.describerPreset");
  const preset = Object.hasOwn(modelPresets, describerPreset) ? modelPresets[describerPreset] : undefined;
  if (preset === undefined) {
    throw new Error("visionHandoff.describerPreset must name an entry in modelPresets");
  }
  if (preset.needsVisionHandoff === true) {
    throw new Error("visionHandoff.describerPreset must not be a preset that itself needs vision handoff");
  }
  let maxRawImages = VISION_HANDOFF_DEFAULTS.maxRawImages;
  if (raw.maxRawImages !== undefined) {
    if (typeof raw.maxRawImages !== "number" || !Number.isSafeInteger(raw.maxRawImages)
      || raw.maxRawImages < 0 || raw.maxRawImages > VISION_HANDOFF_LIMITS.maxRawImages) {
      throw new Error(`visionHandoff.maxRawImages must be an integer from 0 to ${VISION_HANDOFF_LIMITS.maxRawImages}`);
    }
    maxRawImages = raw.maxRawImages;
  }
  let maxDescriptionTokens = VISION_HANDOFF_DEFAULTS.maxDescriptionTokens;
  if (raw.maxDescriptionTokens !== undefined) {
    if (typeof raw.maxDescriptionTokens !== "number" || !Number.isSafeInteger(raw.maxDescriptionTokens)
      || raw.maxDescriptionTokens < 1 || raw.maxDescriptionTokens > VISION_HANDOFF_LIMITS.maxDescriptionTokens) {
      throw new Error(
        `visionHandoff.maxDescriptionTokens must be an integer from 1 to ${VISION_HANDOFF_LIMITS.maxDescriptionTokens}`,
      );
    }
    maxDescriptionTokens = raw.maxDescriptionTokens;
  }
  let prompt: string | undefined;
  if (raw.prompt !== undefined) {
    prompt = nonempty(raw.prompt, "visionHandoff.prompt");
    if (prompt.length > VISION_HANDOFF_LIMITS.maxPromptChars) {
      throw new Error(`visionHandoff.prompt must be at most ${VISION_HANDOFF_LIMITS.maxPromptChars} characters`);
    }
  }
  return Object.freeze({
    describerPreset,
    maxRawImages,
    maxDescriptionTokens,
    ...(prompt === undefined ? {} : { prompt }),
  });
}

function workspaceSkillsConfig(value: unknown): WorkspaceSkillsConfig {
  const raw = object(value, "workspaceContext.skills");
  for (const key of Object.keys(raw)) {
    if (key !== "builtinSkillsRoot" && key !== "disabledSkills") {
      throw new Error(`Unknown workspaceContext.skills field: ${key}`);
    }
  }
  let builtinSkillsRoot: string | undefined;
  if (raw.builtinSkillsRoot !== undefined) {
    const path = nonempty(raw.builtinSkillsRoot, "workspaceContext.skills.builtinSkillsRoot");
    if (!isAbsolute(path)) {
      throw new Error("workspaceContext.skills.builtinSkillsRoot must be an absolute path");
    }
    builtinSkillsRoot = resolve(path);
  }
  return Object.freeze({
    ...(builtinSkillsRoot === undefined ? {} : { builtinSkillsRoot }),
    disabledSkills: skillNames(raw.disabledSkills, "workspaceContext.skills.disabledSkills"),
  });
}

function skillNames(value: unknown, label: string): readonly string[] {
  try {
    return validateSkillNames(value, label);
  } catch (error) {
    if (error instanceof SkillsContextInputError || error instanceof SkillsContextBoundsError) {
      throw new Error(`${label} is invalid: ${error.message}`);
    }
    throw error;
  }
}

function workspaceContextConfig(value: unknown): WorkspaceContextConfig {
  const raw = object(value, "workspaceContext");
  for (const key of Object.keys(raw)) {
    if (key !== "memoryFiles" && key !== "memoryManifest" && key !== "skills") {
      throw new Error(`Unknown workspaceContext field: ${key}`);
    }
  }
  if (raw.memoryManifest !== undefined && typeof raw.memoryManifest !== "boolean") {
    throw new Error("workspaceContext.memoryManifest must be a boolean");
  }
  const memoryManifest = raw.memoryManifest === true;
  let memoryFiles: readonly string[] = Object.freeze([]);
  if (raw.memoryFiles !== undefined) {
    try {
      memoryFiles = validateWorkspaceMemoryFiles(raw.memoryFiles);
    } catch (error) {
      if (error instanceof WorkspaceContextInputError || error instanceof WorkspaceContextBoundsError) {
        throw new Error(`workspaceContext.memoryFiles is invalid: ${error.message}`);
      }
      throw error;
    }
  }
  if (memoryManifest) {
    // The manifest is appended as one more memory source, so the configured
    // files must leave a source slot for it and use names the loader accepts.
    if (memoryFiles.length >= CONTEXT_LIMITS.maxMemorySources) {
      throw new Error(
        `workspaceContext.memoryFiles must name at most ${CONTEXT_LIMITS.maxMemorySources - 1} files ` +
        "when workspaceContext.memoryManifest is enabled",
      );
    }
    try {
      validateMemoryLoadedFiles(memoryFiles);
    } catch (error) {
      if (error instanceof MemoryContextInputError || error instanceof MemoryContextBoundsError) {
        throw new Error(`workspaceContext.memoryFiles is invalid for the memory manifest: ${error.message}`);
      }
      throw error;
    }
  }
  return Object.freeze({
    memoryFiles,
    ...(memoryManifest ? { memoryManifest: true } : {}),
    ...(raw.skills === undefined ? {} : { skills: workspaceSkillsConfig(raw.skills) }),
  });
}

function cronConfig(value: unknown): CronConfig {
  const raw = object(value, "cron");
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "timeZone") throw new Error(`Unknown cron field: ${key}`);
  }
  if (typeof raw.enabled !== "boolean") throw new Error("cron.enabled must be a boolean");
  if (!raw.enabled) return { enabled: false };
  if (raw.timeZone === undefined) return { enabled: true };
  const timeZone = nonempty(raw.timeZone, "cron.timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error("cron.timeZone must be an IANA time zone name");
  }
  return { enabled: true, timeZone };
}

function mediaTranscriptionConfig(value: unknown): MediaTranscriptionConfig {
  const raw = object(value, "media.transcription");
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "language" && key !== "maxDurationSeconds") {
      throw new Error(`Unknown media.transcription field: ${key}`);
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("media.transcription.enabled must be a boolean");
  }
  let language: string | undefined;
  if (raw.language !== undefined) {
    if (typeof raw.language !== "string" || !/^[A-Za-z0-9_-]{1,35}$/.test(raw.language)) {
      throw new Error("media.transcription.language must be a short language code");
    }
    language = raw.language;
  }
  let maxDurationSeconds: number | undefined;
  if (raw.maxDurationSeconds !== undefined) {
    if (typeof raw.maxDurationSeconds !== "number" || !Number.isInteger(raw.maxDurationSeconds) ||
        raw.maxDurationSeconds < 1 || raw.maxDurationSeconds > 3_600) {
      throw new Error("media.transcription.maxDurationSeconds must be an integer from 1 to 3600");
    }
    maxDurationSeconds = raw.maxDurationSeconds;
  }
  return Object.freeze({
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
    ...(language === undefined ? {} : { language }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
  });
}

function mediaConfig(value: unknown): MediaConfig {
  const raw = object(value, "media");
  for (const key of Object.keys(raw)) {
    if (key !== "directory" && key !== "transcription") throw new Error(`Unknown media field: ${key}`);
  }
  const directory = validateMediaDirectory(raw.directory);
  return Object.freeze({
    directory,
    ...(raw.transcription === undefined ? {} : { transcription: mediaTranscriptionConfig(raw.transcription) }),
  });
}

export function parseConfig(value: unknown, baseDir = process.cwd()): PortConfig {
  const raw = object(value, "config");
  const presetMode = raw.modelPreset !== undefined || raw.modelPresets !== undefined;
  let model: ModelReference;
  let allowedModels: ModelReference[];
  let modelPresets: Readonly<Record<string, ModelPreset>> | undefined;
  let modelPreset: string | undefined;
  if (presetMode) {
    // One clear alternative to the legacy direct fields: the catalog names everything, so a
    // parallel default/allowed list would only create an ambiguous second source of truth.
    if (raw.modelPresets === undefined) throw new Error("modelPreset requires modelPresets");
    if (raw.modelPreset === undefined) throw new Error("modelPresets requires modelPreset to select the default");
    for (const key of ["model", "allowedModels", "thinkingLevel"]) {
      if (raw[key] !== undefined) {
        throw new Error(`modelPresets mode does not accept ${key}; configure it inside modelPresets instead`);
      }
    }
    modelPresets = modelPresetsConfig(raw.modelPresets);
    modelPreset = modelPresetName(raw.modelPreset, "modelPreset");
    const selected = Object.hasOwn(modelPresets, modelPreset) ? modelPresets[modelPreset] : undefined;
    if (selected === undefined) throw new Error("modelPreset must name an entry in modelPresets");
    model = { provider: selected.provider, modelId: selected.modelId };
    // The catalog is the allowlist: one pair per provider/model even when two presets differ only
    // by thinking level, because native selection is keyed by the model pair.
    const seen = new Set<string>();
    allowedModels = [];
    for (const preset of Object.values(modelPresets)) {
      const reference = { provider: preset.provider, modelId: preset.modelId };
      const key = modelKey(reference);
      if (seen.has(key)) continue;
      seen.add(key);
      allowedModels.push(reference);
    }
  } else {
    model = modelReference(raw.model, "model");
    if (raw.allowedModels === undefined) {
      allowedModels = [model];
    } else {
      if (!Array.isArray(raw.allowedModels) || raw.allowedModels.length === 0) {
        throw new Error("allowedModels must be a non-empty array");
      }
      allowedModels = raw.allowedModels.map((entry, index) => modelReference(entry, `allowedModels[${index}]`));
      const keys = allowedModels.map(modelKey);
      if (new Set(keys).size !== keys.length) throw new Error("allowedModels must not contain duplicate models");
      if (!keys.includes(modelKey(model))) throw new Error("model must be included in allowedModels");
    }
  }
  const config: PortConfig = {
    workspace: resolve(baseDir, nonempty(raw.workspace, "workspace")),
    dataDir: resolve(baseDir, nonempty(raw.dataDir, "dataDir")),
    model,
    allowedModels,
    ...(modelPresets === undefined ? {} : { modelPresets }),
    ...(modelPreset === undefined ? {} : { modelPreset }),
  };
  let toolAllowlist: string[] = [];
  if (raw.toolAllowlist !== undefined) {
    if (!Array.isArray(raw.toolAllowlist)) throw new Error("toolAllowlist must be an array");
    toolAllowlist = raw.toolAllowlist.map((name, index) => {
      if (typeof name !== "string" || name.length === 0 || name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error(`toolAllowlist[${index}] must be an exact non-empty tool name`);
      }
      return name;
    });
    const foldedNames = toolAllowlist.map((name) => name.toLocaleLowerCase("en-US"));
    if (new Set(foldedNames).size !== foldedNames.length) {
      throw new Error("toolAllowlist must not contain duplicate or case-ambiguous names");
    }
  }
  config.toolAllowlist = toolAllowlist;
  const toolTimeoutSeconds = parseToolTimeoutSeconds(raw.toolTimeoutSeconds);
  if (toolTimeoutSeconds !== undefined) Object.assign(config, { toolTimeoutSeconds });
  if (raw.toolSandbox !== undefined) {
    if (raw.toolSandbox !== "host" && raw.toolSandbox !== "bwrap") {
      throw new Error('toolSandbox must be "host" or "bwrap"');
    }
    Object.assign(config, { toolSandbox: raw.toolSandbox });
  }
  if (raw.workspaceContext !== undefined) {
    Object.assign(config, { workspaceContext: workspaceContextConfig(raw.workspaceContext) });
  }
  // Parsed after the workspace is resolved: a stdio server's cwd is confined to it.
  if (raw.mcp !== undefined) {
    Object.assign(config, { mcp: parseMcpConfig(raw.mcp, config.workspace) });
  }
  if (raw.cron !== undefined) {
    Object.assign(config, { cron: cronConfig(raw.cron) });
  }
  if (raw.media !== undefined) {
    Object.assign(config, { media: mediaConfig(raw.media) });
  }
  if (raw.episodeSummary !== undefined) {
    const summary = object(raw.episodeSummary, "episodeSummary");
    for (const key of Object.keys(summary)) {
      if (key !== "enabled" && key !== "model" && key !== "preset") {
        throw new Error(`Unknown episodeSummary field: ${key}`);
      }
    }
    if (summary.enabled !== undefined && typeof summary.enabled !== "boolean") {
      throw new Error("episodeSummary.enabled must be a boolean");
    }
    if (summary.model !== undefined && summary.preset !== undefined) {
      throw new Error("episodeSummary.model and episodeSummary.preset are mutually exclusive");
    }
    const summaryModel = summary.model === undefined ? undefined : modelReference(summary.model, "episodeSummary.model");
    if (summaryModel !== undefined && !allowedModels.some((choice) => modelKey(choice) === modelKey(summaryModel))) {
      throw new Error("episodeSummary.model must be included in allowedModels");
    }
    let summaryPreset: string | undefined;
    if (summary.preset !== undefined) {
      if (modelPresets === undefined) throw new Error("episodeSummary.preset requires named modelPresets");
      summaryPreset = modelPresetName(summary.preset, "episodeSummary.preset");
      if (!Object.hasOwn(modelPresets, summaryPreset)) {
        throw new Error("episodeSummary.preset must name an entry in modelPresets");
      }
    }
    config.episodeSummary = {
      ...(summary.enabled === undefined ? {} : { enabled: summary.enabled }),
      ...(summaryModel === undefined ? {} : { model: summaryModel }),
      ...(summaryPreset === undefined ? {} : { preset: summaryPreset }),
    };
  }
  if (raw.visionHandoff !== undefined) {
    Object.assign(config, { visionHandoff: visionHandoffConfig(raw.visionHandoff, modelPresets) });
  }
  if (modelPresets !== undefined) {
    const flagged = Object.entries(modelPresets)
      .filter(([, preset]) => preset.needsVisionHandoff === true)
      .map(([name]) => name);
    if (flagged.length > 0 && config.visionHandoff === undefined) {
      throw new Error(
        `modelPresets.${flagged[0]}.needsVisionHandoff requires visionHandoff with a vision-capable describerPreset`,
      );
    }
  }
  if (raw.thinkingLevel !== undefined) {
    config.thinkingLevel = modelThinkingLevel(raw.thinkingLevel, "thinkingLevel");
  }
  if (raw.extraAllowedDirs !== undefined) {
    if (!Array.isArray(raw.extraAllowedDirs)) throw new Error("extraAllowedDirs must be an array");
    Object.assign(config, { extraAllowedDirs: raw.extraAllowedDirs.map((v, i) => resolve(baseDir, nonempty(v, `extraAllowedDirs[${i}]`))) });
  }
  if (raw.bwrapPath !== undefined) {
    const path = nonempty(raw.bwrapPath, "bwrapPath");
    if (!isAbsolute(path)) throw new Error("bwrapPath must be absolute");
    Object.assign(config, { bwrapPath: path });
  }
  if (raw.credentials !== undefined) {
    const credentials = object(raw.credentials, "credentials");
    const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, name] of Object.entries(credentials)) {
      if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(key)) throw new Error("Unknown credentials provider");
      normalized[key] = envName(name, `credentials.${key}`);
    }
    Object.assign(config, { credentials: normalized });
  }
  if (raw.telegram !== undefined) {
    const t = object(raw.telegram, "telegram");
    if (!Array.isArray(t.allowFrom) || t.allowFrom.length === 0 || t.allowFrom.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) throw new Error("telegram.allowFrom must be a non-empty list of decimal user IDs");
    const telegram: NonNullable<PortConfig["telegram"]> = { tokenEnv: envName(t.tokenEnv, "telegram.tokenEnv"), allowFrom: t.allowFrom as string[] };
    if (t.pollTimeoutSeconds !== undefined) {
      if (typeof t.pollTimeoutSeconds !== "number" || !Number.isInteger(t.pollTimeoutSeconds) || t.pollTimeoutSeconds < 1 || t.pollTimeoutSeconds > 50) throw new Error("telegram.pollTimeoutSeconds must be an integer from 1 to 50");
      telegram.pollTimeoutSeconds = t.pollTimeoutSeconds;
    }
    Object.assign(config, { telegram });
  }
  return config;
}

export async function loadConfig(path: string): Promise<PortConfig> {
  const absolute = resolve(path);
  let value: unknown;
  try { value = JSON.parse(await readFile(absolute, "utf8")); }
  catch (cause) { throw new StartupDiagnosticError("configFile", { cause }); }
  try { return parseConfig(value, dirname(absolute)); }
  catch (cause) { throw new StartupDiagnosticError("configInvalid", { cause }); }
}
