import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MemoryContextInputError,
  validateMemoryLoadedFiles,
} from "./context/memory.js";
import { validAppAgentName, validVapidPublicKey, validVapidSubject } from "./channels/app-protocol.js";
import {
  WorkspaceContextInputError,
  validateWorkspaceMemoryFiles,
} from "./context/workspace.js";
import {
  SkillsContextInputError,
  validateSkillNames,
} from "./context/skills.js";
import { validateMediaDirectory } from "./media/attachments.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";
import { parseMcpConfig, type McpConfig } from "./mcp/config.js";
import { VISION_HANDOFF_DEFAULTS, VISION_HANDOFF_LIMITS } from "./media/vision.js";
import { parseWebConfig, type WebConfig } from "./web/config.js";
import { WORKER_LIMITS, WORKER_TOOL_GRANTS } from "./workers/limits.js";
import { CODING_TOOL_NAMES } from "./tools/coding.js";
import { DIGEST_CHARS_PER_BATCH_MIN, DIGEST_ENTRIES_PER_BATCH_MIN } from "./history/digest-limits.js";

/**
 * Provider spelling used by credentials, model references, classifier grants and
 * `providers` keys. It is not a closed list: any native Pi AI provider ID, legacy
 * alias or configured custom provider is valid. Kept as a named alias for SDK
 * compatibility with the earlier whitelist type.
 */
export type CredentialProvider = string;

/** Native Pi AI chat APIs a configured custom provider may use. */
export const CUSTOM_PROVIDER_APIS = Object.freeze([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
] as const);

export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];

/** Operator-supplied metadata for one model on a custom OpenAI/Anthropic-compatible endpoint. */
export interface CustomModelConfig {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** Display/accounting metadata supplied by the operator; it is not provider billing evidence. */
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

/**
 * One custom compatible endpoint, registered through native `createProvider()`.
 * It uses a native Pi AI API implementation; no bespoke request client is added.
 */
export interface CustomProviderConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly api: CustomProviderApi;
  readonly models: readonly CustomModelConfig[];
}

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

/**
 * Where an owner's message goes while that conversation is already running: `followUp` (the default)
 * queues it for the next run, and `steer` places it after the current tool round so it joins the
 * running work. Internal worker, digest and scheduled events never use this setting.
 */
export const FOLLOW_UP_MODES = ["followUp", "steer"] as const;

export type FollowUpMode = typeof FOLLOW_UP_MODES[number];

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

export interface WorkersConfig {
  /** Opt-in model-facing `worker` tool; false registers no worker task and offers no tool. */
  readonly enabled: boolean;
  /**
   * Live background workers allowed per spawning conversation. Defaults to 2; the bound is small because
   * each worker is an ordinary model run holding a conversation of its own.
   */
  readonly maxConcurrent?: number;
  /**
   * Optional named preset for worker model/thinking. Absent uses the spawning conversation's current
   * selection at launch. It is validated against the finite `modelPresets` catalog, not an open registry.
   */
  readonly preset?: string;
  /** Independent worker grants; absent inherits configured chat tools, empty grants no tools. */
  readonly toolAllowlist?: readonly string[];
}

export interface CodeModeConfig {
  /**
   * Explicit native Code Mode switch. Present `true` installs the native bundle even
   * without MCP; absent keeps the legacy rule (installed only when MCP is configured);
   * present `false` disables it even when MCP is configured. This grants no tool that
   * the conversation does not already hold.
   */
  readonly enabled: boolean;
}

export interface IdleRolloverConfig {
  /** Minutes a mapped chat must stay fully idle before its next owner message is classified. */
  readonly afterMinutes: number;
}

export interface ProactiveMemoryConfig {
  readonly timeoutMs?: number;
  readonly maxTopics?: number;
  readonly topicGateThreshold?: number;
  readonly topicMinProbability?: number;
  readonly historyGateThreshold?: number;
}

export const PROACTIVE_MEMORY_DEFAULTS: Required<ProactiveMemoryConfig> = Object.freeze({
  timeoutMs: 2000,
  maxTopics: 5,
  topicGateThreshold: 0.5,
  topicMinProbability: 0.08,
  historyGateThreshold: 0.6,
});

/**
 * Bounds for one explicitly started memory-digestion run. Absent fields keep the shared defaults;
 * the block itself neither enables nor schedules anything, and frequency stays with ordinary cron.
 * A started run captures the accepted values, so a reopen never widens them from current config.
 */
export interface DigestConfig {
  /**
   * Explicit curation model for a background digestion run. It never inherits the foreground
   * conversation's model or thinking level; absent both this and `preset`, starting a run is
   * refused. Mutually exclusive with `preset`.
   */
  readonly model?: ModelReference;
  /** Explicit named preset for a background digestion run; its thinking level applies as configured. */
  readonly preset?: string;
  /** Maximum closed episodes per invocation (default 1). The first is always admitted. */
  readonly episodesPerRun?: number;
  /**
   * Message and tool entries examined by one internal chunk. The minimum is 2: a one-entry chunk cannot
   * always advance past an episode's opening reset marker, so it would refuse its own
   * acknowledgement and wedge the cursor.
   */
  readonly entriesPerBatch?: number;
  /**
   * Extracted evidence characters in one internal chunk, in UTF-16 code units.
   * The minimum is 2 so one surrogate pair always fits.
   */
  readonly charsPerBatch?: number;
  /** Safety limit on tool calls per internal chunk, failed and refused calls included. */
  readonly maxToolCalls?: number;
  /** Soft invocation response target for admitting another episode, never a mid-episode stop. */
  readonly maxRequests?: number;
  /** Soft invocation input target including cached input; governs additional-episode admission only. */
  readonly maxInputTokens?: number;
  /** Internal chunk deadline in seconds. A timeout is a genuine failure, not successful partial work. */
  readonly runTimeoutSeconds?: number;
  /** Safety limit on distinct changed files per internal chunk. */
  readonly maxChangedFiles?: number;
  /** Safety limit on inserted-plus-removed text per internal chunk. */
  readonly maxDiffChars?: number;
}

export interface WorkspaceContextConfig {
  /** Additional memory files in output order; system Markdown is always discovered by the loader. Defaults to []. */
  readonly memoryFiles: readonly string[];
  /** Topic discovery in the system prompt or as per-turn hints; absent defaults to off. */
  readonly memory?: "off" | "manifest" | "proactive";
  /**
   * Legacy opt-in topic memory manifest; mutually exclusive with memory. Actually injected explicit and system files are marked loaded and
   * the remaining `memory/**\/*.md` topics are listed for on-demand reads.
   * Absent or false leaves the snapshot unchanged.
   */
  readonly memoryManifest?: boolean;
  /** Explicit opt-in for workspace/builtin skill discovery; absent means no skills are read. */
  readonly skills?: WorkspaceSkillsConfig;
}

/**
 * Operator-provisioned whisper.cpp engine. Every path is explicit and absolute;
 * nothing is discovered, built or downloaded at runtime.
 */
export interface WhisperCliEngineConfig {
  /** `whisper-cli` executable. */
  readonly binary: string;
  /** `ggml` Whisper model file. */
  readonly model: string;
  /** Silero VAD `ggml` model; required, VAD is mandatory on this route. */
  readonly vadModel: string;
  /** `ffmpeg` executable, used only to decode the local input. */
  readonly ffmpeg: string;
  /** `ffprobe` executable, used for the early duration refusal. */
  readonly ffprobe: string;
}

/**
 * Operator-installed Hex (`https://github.com/anomalyco/hex`) used only as a
 * local speech engine through its `model transcribe` file command. Every path is
 * explicit and absolute; nothing is discovered, downloaded or started at runtime.
 */
export interface HexEngineConfig {
  /** Hex executable; its own data directory (models, settings) is left untouched. */
  readonly binary: string;
  /** `ffmpeg` executable, used only to decode the local input into 16 kHz mono WAV. */
  readonly ffmpeg: string;
  /** `ffprobe` executable, used for the early duration refusal. */
  readonly ffprobe: string;
  /** Hex model id (for example `parakeet_unified_en`); absent uses Hex's own selection. */
  readonly model?: string;
}

export interface MediaTranscriptionConfig {
  /** Absent or true enables local transcription of stored audio. */
  readonly enabled?: boolean;
  /** Language hint for the local helper; absent means auto-detect. */
  readonly language?: string;
  /** Audio longer than this is not transcribed; defaults to 120 seconds. */
  readonly maxDurationSeconds?: number;
  /**
   * Wall-clock budget for the whole transcription, including decode and model
   * load; defaults to 180000 ms. Raise it for long recordings.
   */
  readonly timeoutMs?: number;
  /**
   * Explicit engine. Absent keeps the existing uv/faster-whisper helper exactly
   * as configured today; `whisper-cli` opts in to the Python-free route and `hex`
   * to the operator-installed Hex engine.
   */
  readonly backend?: "faster-whisper" | "whisper-cli" | "hex";
  /** Required with `backend: "whisper-cli"`, rejected otherwise. */
  readonly whisperCli?: WhisperCliEngineConfig;
  /** Required with `backend: "hex"`, rejected otherwise. */
  readonly hex?: HexEngineConfig;
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
   * The file this configuration was loaded from. Set only by `loadConfig`, never by `parseConfig`, so
   * an SDK host that supplies an object has no file and no managed-write surface. It is not an
   * authority: an owner approval still decides every write.
   */
  configFile?: string;
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
   * The one classifier model native Code Mode `models.classify` and host features may use. Absent means
   * classifiers are unavailable: registering a provider, or naming one of its chat models,
   * never makes a classifier reachable. The pair must be a classifier-type model in the
   * registered native/custom catalog; there is no substitution or fallback.
   */
  classifierModel?: ModelReference;
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
  /**
   * Idle episode rollover; absent is off. A mapped chat idle this long gets a short handoff from the
   * named preset and starts a new episode, so digest and summaries see a closed episode.
   */
  idleRollover?: IdleRolloverConfig;
  /** Classifier bounds and thresholds, only for workspaceContext.memory: proactive. */
  proactiveMemory?: ProactiveMemoryConfig;
  /**
   * How an owner message is placed when its CLI or Telegram conversation is busy. Optional so a host
   * that builds `PortConfig` by hand stays source-compatible; `parseConfig` always normalizes it to
   * the default `followUp` (historical queueing), and `steer` joins the current run after its tool round.
   */
  followUpMode?: FollowUpMode;
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
  /** Default true. False grants host-wide file/shell paths as the service user, except managed data. */
  restrictToWorkspace?: boolean;
  /** Internal agent scheduling. Absent or disabled leaves the runtime without cron. */
  cron?: CronConfig;
  /**
   * Ordinary bounded background workers. Absent or disabled leaves the runtime without the `worker` tool
   * and without the worker task kind. Workers are native Durable tasks, never a second agent loop.
   */
  workers?: WorkersConfig;
  /**
   * Explicit MCP servers and the switch that connects them. This is a separate authority from
   * `toolAllowlist`: naming a server connects it, and its tools still reach only authenticated
   * mapped chat conversations. Absent or disabled installs no MCP client; Code Mode
   * still follows its own `codemode` switch.
   */
  mcp?: McpConfig;
  /** Native Code Mode composition; absent follows MCP auto-enablement. */
  codemode?: CodeModeConfig;
  /** Explicit memory-digestion bounds; absent keeps the defaults and starts nothing by itself. */
  digest?: DigestConfig;
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
  credentials?: Readonly<Record<CredentialProvider, string>>;
  /**
   * Explicit custom compatible providers. Each key is the provider spelling used by
   * `model`, `allowedModels`, `modelPresets` and `credentials`. Native provider IDs
   * and the documented legacy aliases cannot be redefined here.
   */
  providers?: Readonly<Record<string, CustomProviderConfig>>;
  /**
   * Native public web capabilities. Absent installs no web tool; `search` and
   * `fetch` enable independently. This is separate authority from `toolAllowlist`
   * and never grants filesystem or shell access.
   */
  web?: WebConfig;
  /**
   * Opt-in attachment ingress (photos, voice/audio, documents) for channels that
   * can download them. Absent means a channel keeps its attachment-disabled behavior.
   */
  media?: MediaConfig;
  telegram?: { tokenEnv: string; allowFrom: readonly string[]; pollTimeoutSeconds?: number };
  /**
   * Opt-in Discord channel. Absent keeps every Discord code path unloaded. The bot token is read
   * from `tokenEnv`; senders, channels and direct messages are explicitly allowlisted (there is no
   * wildcard), and a guild message is admitted only when this bot is mentioned or replied to unless
   * `groupPolicy` is `open`.
   */
  discord?: {
    readonly tokenEnv: string;
    readonly allowFrom: readonly string[];
    readonly dmAllowFrom?: readonly string[];
    readonly allowChannels?: readonly string[];
    readonly groupPolicy?: "mention" | "open";
    readonly streaming?: boolean;
    readonly receipts?: { readonly read?: string | false; readonly working?: string | false; readonly delayMs?: number };
  };
  /**
   * Opt-in installable web app channel. Absent keeps every `app` code path unloaded. The listener
   * binds 127.0.0.1 only (no other bind is configurable); `tailscale serve` publishes it on the
   * tailnet, and devices authenticate with one-time pairing codes from the owner's terminal.
   */
  app?: {
    readonly port: number;
    readonly staticRoot: string;
    readonly autoArchiveDays?: number;
    /** Agent display name in every hello reply; 1–40 printable characters. */
    readonly agentName?: string;
    /**
     * Optional Web Push: off unless this block exists and its private key variable is set at
     * gateway start. The private key itself is named here, never stored in config.
     */
    readonly push?: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKeyEnv: string;
    };
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must be a plain object`);
  const copy = Object.fromEntries(Object.entries(value));
  Object.setPrototypeOf(copy, null);
  return copy;
}
/**
 * The one unknown-key refusal for every strict config block. Its `<section>.<key> is not a recognized
 * option` shape is what `doctor` maps to a key-free "<section> contains an unrecognized option", so the
 * owner-chosen key itself never reaches a diagnostic.
 */
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name}.${key} is not a recognized option`);
  }
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
  return Object.freeze({
    provider: providerKey(model.provider, `${name}.provider`),
    modelId: nonempty(model.modelId, `${name}.modelId`),
  });
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

/** Provider ID syntax shared by config keys and CLI provider arguments. */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Provider spelling accepted by config and native Pi AI. This is a syntax bound,
 * not a provider whitelist; existence is checked against native/custom providers
 * during startup.
 */
function providerKey(value: unknown, name: string): string {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a provider ID using letters, digits, dot, underscore or hyphen`);
  }
  return value;
}

/** Owner busy-mode spelling; absent keeps the default follow-up queueing. */
function followUpModeConfig(value: unknown): FollowUpMode {
  if (value === undefined) return "followUp";
  if (typeof value !== "string" || !(FOLLOW_UP_MODES as readonly string[]).includes(value)) {
    throw new Error(`followUpMode must be one of ${FOLLOW_UP_MODES.join(", ")}`);
  }
  return value as FollowUpMode;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function customModelConfig(value: unknown, name: string): CustomModelConfig {
  const raw = object(value, name);
  rejectUnknownKeys(raw, ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"], name);
  const id = nonempty(raw.id, `${name}.id`);
  const displayName = raw.name === undefined ? id : nonempty(raw.name, `${name}.name`);
  let reasoning = false;
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "boolean") throw new Error(`${name}.reasoning must be a boolean`);
    reasoning = raw.reasoning;
  }
  let input: ("text" | "image")[] = ["text"];
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input) || raw.input.length === 0
      || raw.input.some((entry) => entry !== "text" && entry !== "image")) {
      throw new Error(`${name}.input must be a non-empty list of "text" and/or "image"`);
    }
    const values = raw.input as ("text" | "image")[];
    if (new Set(values).size !== values.length) throw new Error(`${name}.input must not contain duplicates`);
    if (!values.includes("text")) throw new Error(`${name}.input must include "text"`);
    input = [...values];
  }
  const costRaw = object(raw.cost, `${name}.cost`);
  rejectUnknownKeys(costRaw, ["input", "output", "cacheRead", "cacheWrite"], `${name}.cost`);
  return Object.freeze({
    id,
    name: displayName,
    reasoning,
    input: Object.freeze(input),
    contextWindow: positiveInteger(raw.contextWindow, `${name}.contextWindow`),
    maxTokens: positiveInteger(raw.maxTokens, `${name}.maxTokens`),
    cost: Object.freeze({
      input: nonnegativeNumber(costRaw.input, `${name}.cost.input`),
      output: nonnegativeNumber(costRaw.output, `${name}.cost.output`),
      cacheRead: nonnegativeNumber(costRaw.cacheRead, `${name}.cost.cacheRead`),
      cacheWrite: nonnegativeNumber(costRaw.cacheWrite, `${name}.cost.cacheWrite`),
    }),
  });
}

function customProvidersConfig(value: unknown): Readonly<Record<string, CustomProviderConfig>> {
  const raw = object(value, "providers");
  if (Object.keys(raw).length === 0) throw new Error("providers must contain at least one custom provider");
  const providers: Record<string, CustomProviderConfig> = Object.create(null) as Record<string, CustomProviderConfig>;
  for (const [rawKey, entry] of Object.entries(raw)) {
    const key = providerKey(rawKey, "providers key");
    const provider = object(entry, `providers.${key}`);
    rejectUnknownKeys(provider, ["name", "baseUrl", "api", "models"], `providers.${key}`);
    if (typeof provider.api !== "string" || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(provider.api)) {
      throw new Error(`providers.${key}.api must be one of ${CUSTOM_PROVIDER_APIS.join(", ")}`);
    }
    const baseUrl = nonempty(provider.baseUrl, `providers.${key}.baseUrl`);
    let url: URL;
    try { url = new URL(baseUrl); }
    catch { throw new Error(`providers.${key}.baseUrl must be an absolute http(s) URL`); }
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new Error(`providers.${key}.baseUrl must be an absolute http(s) URL without credentials or a fragment`);
    }
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      throw new Error(`providers.${key}.models must be a non-empty array`);
    }
    const models = provider.models.map((model, index) =>
      customModelConfig(model, `providers.${key}.models[${index}]`));
    const ids = models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`providers.${key}.models must not contain duplicate model IDs`);
    }
    providers[key] = Object.freeze({
      name: provider.name === undefined ? key : nonempty(provider.name, `providers.${key}.name`),
      baseUrl,
      api: provider.api as CustomProviderApi,
      models: Object.freeze(models),
    });
  }
  return Object.freeze(providers);
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
    rejectUnknownKeys(preset, ["provider", "modelId", "thinkingLevel", "needsVisionHandoff"], `modelPresets.${name}`);
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

function idleRolloverConfig(value: unknown): IdleRolloverConfig {
  const raw = object(value, "idleRollover");
  rejectUnknownKeys(raw, ["afterMinutes"], "idleRollover");
  const after = raw.afterMinutes;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 1 || after > 7 * 24 * 60) {
    throw new Error("idleRollover.afterMinutes must be an integer from 1 to 10080");
  }
  return Object.freeze({ afterMinutes: after });
}

function proactiveMemoryConfig(value: unknown): Required<ProactiveMemoryConfig> {
  const raw = object(value, "proactiveMemory");
  rejectUnknownKeys(raw, Object.keys(PROACTIVE_MEMORY_DEFAULTS), "proactiveMemory");
  const bounded = (key: keyof ProactiveMemoryConfig, min: number, max: number, integer = false): number => {
    const selected = raw[key];
    if (selected === undefined) return PROACTIVE_MEMORY_DEFAULTS[key];
    if (typeof selected !== "number" || !Number.isFinite(selected)
      || (integer && !Number.isInteger(selected)) || selected < min || selected > max) {
      throw new Error(`proactiveMemory.${key} must be ${integer ? "an integer" : "a finite number"} from ${min} to ${max}`);
    }
    return selected;
  };
  return Object.freeze({
    timeoutMs: bounded("timeoutMs", 100, 15000, true),
    maxTopics: bounded("maxTopics", 1, 20, true),
    topicGateThreshold: bounded("topicGateThreshold", 0, 1),
    topicMinProbability: bounded("topicMinProbability", 0, 1),
    historyGateThreshold: bounded("historyGateThreshold", 0, 1),
  });
}

function visionHandoffConfig(
  value: unknown,
  modelPresets: Readonly<Record<string, ModelPreset>> | undefined,
): VisionHandoffConfig {
  const raw = object(value, "visionHandoff");
  rejectUnknownKeys(raw, ["describerPreset", "maxRawImages", "maxDescriptionTokens", "prompt"], "visionHandoff");
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
  rejectUnknownKeys(raw, ["builtinSkillsRoot", "disabledSkills"], "workspaceContext.skills");
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
    if (error instanceof SkillsContextInputError) {
      throw new Error(`${label} is invalid: ${error.message}`);
    }
    throw error;
  }
}

function workspaceContextConfig(value: unknown): WorkspaceContextConfig {
  const raw = object(value, "workspaceContext");
  rejectUnknownKeys(raw, ["memoryFiles", "memory", "memoryManifest", "skills"], "workspaceContext");
  const memory = raw.memory;
  if (Object.hasOwn(raw, "memory") && Object.hasOwn(raw, "memoryManifest")) {
    throw new Error("workspaceContext.memory cannot be combined with workspaceContext.memoryManifest");
  }
  if (memory !== undefined && memory !== "off" && memory !== "manifest" && memory !== "proactive") {
    throw new Error("workspaceContext.memory must be off, manifest or proactive");
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
      if (error instanceof WorkspaceContextInputError) {
        throw new Error(`workspaceContext.memoryFiles is invalid: ${error.message}`);
      }
      throw error;
    }
  }
  if (memoryManifest || memory === "manifest" || memory === "proactive") {
    try {
      validateMemoryLoadedFiles(memoryFiles);
    } catch (error) {
      if (error instanceof MemoryContextInputError) {
        const use = memory === "proactive" ? "proactive memory" : "the memory manifest";
        throw new Error(`workspaceContext.memoryFiles is invalid for ${use}: ${error.message}`);
      }
      throw error;
    }
  }
  return Object.freeze({
    memoryFiles,
    ...(memory === undefined ? {} : { memory }),
    ...(memoryManifest ? { memoryManifest: true } : {}),
    ...(raw.skills === undefined ? {} : { skills: workspaceSkillsConfig(raw.skills) }),
  });
}

function cronConfig(value: unknown): CronConfig {
  const raw = object(value, "cron");
  rejectUnknownKeys(raw, ["enabled", "timeZone"], "cron");
  if (typeof raw.enabled !== "boolean") throw new Error("cron.enabled must be a boolean");
  if (!raw.enabled) return Object.freeze({ enabled: false });
  if (raw.timeZone === undefined) return Object.freeze({ enabled: true });
  const timeZone = nonempty(raw.timeZone, "cron.timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error("cron.timeZone must be an IANA time zone name");
  }
  return Object.freeze({ enabled: true, timeZone });
}

function workersConfig(value: unknown): WorkersConfig {
  const raw = object(value, "workers");
  rejectUnknownKeys(raw, ["enabled", "maxConcurrent", "preset", "toolAllowlist"], "workers");
  if (typeof raw.enabled !== "boolean") throw new Error("workers.enabled must be a boolean");
  if (!raw.enabled) return Object.freeze({ enabled: false });
  const workers: { enabled: boolean; maxConcurrent?: number; preset?: string; toolAllowlist?: readonly string[] } = { enabled: true };
  if (raw.maxConcurrent !== undefined) {
    if (typeof raw.maxConcurrent !== "number" || !Number.isSafeInteger(raw.maxConcurrent)
      || raw.maxConcurrent < 1 || raw.maxConcurrent > WORKER_LIMITS.maxConcurrent) {
      throw new Error(`workers.maxConcurrent must be an integer from 1 to ${WORKER_LIMITS.maxConcurrent}`);
    }
    workers.maxConcurrent = raw.maxConcurrent;
  }
  if (raw.preset !== undefined) workers.preset = modelPresetName(raw.preset, "workers.preset");
  if (raw.toolAllowlist !== undefined) {
    if (!Array.isArray(raw.toolAllowlist)) throw new Error("workers.toolAllowlist must be an array");
    const names = raw.toolAllowlist.map((name) => {
      if (typeof name !== "string" || !((WORKER_TOOL_GRANTS as readonly string[]).includes(name)
        || (name.length <= 64 && /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(name)))) {
        throw new Error("workers.toolAllowlist must name supported worker tools; Telegram, cron and worker are forbidden");
      }
      return name;
    });
    if (new Set(names.map((name) => name.toLocaleLowerCase("en-US"))).size !== names.length) {
      throw new Error("workers.toolAllowlist must not contain duplicate or case-ambiguous names");
    }
    workers.toolAllowlist = Object.freeze(names);
  }
  return Object.freeze(workers);
}

function whisperCliEngineConfig(value: unknown): WhisperCliEngineConfig {
  const raw = object(value, "media.transcription.whisperCli");
  const keys = ["binary", "model", "vadModel", "ffmpeg", "ffprobe"] as const;
  rejectUnknownKeys(raw, keys, "media.transcription.whisperCli");
  const parsed: Record<string, string> = {};
  for (const key of keys) {
    const entry = raw[key];
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`media.transcription.whisperCli.${key} must be a non-empty path`);
    }
    if (!isAbsolute(entry)) {
      throw new Error(`media.transcription.whisperCli.${key} must be an absolute path`);
    }
    parsed[key] = entry;
  }
  return Object.freeze(parsed as unknown as WhisperCliEngineConfig);
}

/**
 * Hex's own data directory (models and the selected model) is not configured
 * here: the engine resolves it from the operator's home like any other Hex
 * install, so a hand-run `hex model install` and this route see one model store.
 */
function hexEngineConfig(value: unknown): HexEngineConfig {
  const raw = object(value, "media.transcription.hex");
  rejectUnknownKeys(raw, ["binary", "ffmpeg", "ffprobe", "model"], "media.transcription.hex");
  const parsed: Record<string, string> = {};
  for (const key of ["binary", "ffmpeg", "ffprobe"] as const) {
    const entry = raw[key];
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`media.transcription.hex.${key} must be a non-empty path`);
    }
    if (!isAbsolute(entry)) {
      throw new Error(`media.transcription.hex.${key} must be an absolute path`);
    }
    parsed[key] = entry;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(raw.model)) {
      throw new Error("media.transcription.hex.model must be a Hex model id");
    }
    parsed.model = raw.model;
  }
  return Object.freeze(parsed as unknown as HexEngineConfig);
}

function mediaTranscriptionConfig(value: unknown): MediaTranscriptionConfig {
  const raw = object(value, "media.transcription");
  rejectUnknownKeys(
    raw,
    ["enabled", "language", "maxDurationSeconds", "timeoutMs", "backend", "whisperCli", "hex"],
    "media.transcription",
  );
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("media.transcription.enabled must be a boolean");
  }
  let backend: "faster-whisper" | "whisper-cli" | "hex" | undefined;
  if (raw.backend !== undefined) {
    if (raw.backend !== "faster-whisper" && raw.backend !== "whisper-cli" && raw.backend !== "hex") {
      throw new Error("media.transcription.backend must be faster-whisper, whisper-cli or hex");
    }
    backend = raw.backend;
  }
  const whisperCli = raw.whisperCli === undefined ? undefined : whisperCliEngineConfig(raw.whisperCli);
  if ((backend === "whisper-cli") !== (whisperCli !== undefined)) {
    throw new Error(
      "media.transcription.whisperCli is required exactly when backend is whisper-cli",
    );
  }
  const hex = raw.hex === undefined ? undefined : hexEngineConfig(raw.hex);
  if ((backend === "hex") !== (hex !== undefined)) {
    throw new Error("media.transcription.hex is required exactly when backend is hex");
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
  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) ||
        raw.timeoutMs < 1 || raw.timeoutMs > 3_600_000) {
      throw new Error("media.transcription.timeoutMs must be an integer from 1 to 3600000");
    }
    timeoutMs = raw.timeoutMs;
  }
  return Object.freeze({
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
    ...(backend === undefined ? {} : { backend }),
    ...(whisperCli === undefined ? {} : { whisperCli }),
    ...(hex === undefined ? {} : { hex }),
    ...(language === undefined ? {} : { language }),
    ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function codeModeConfig(value: unknown): CodeModeConfig {
  const raw = object(value, "codemode");
  rejectUnknownKeys(raw, ["enabled"], "codemode");
  if (typeof raw.enabled !== "boolean") throw new Error("codemode.enabled must be a boolean");
  return Object.freeze({ enabled: raw.enabled });
}

const DIGEST_CONFIG_FIELDS = [
  "episodesPerRun",
  "entriesPerBatch",
  "charsPerBatch",
  "maxToolCalls",
  "maxRequests",
  "maxInputTokens",
  "runTimeoutSeconds",
  "maxChangedFiles",
  "maxDiffChars",
] as const;

type DigestNumericField = (typeof DIGEST_CONFIG_FIELDS)[number];

function digestConfig(
  value: unknown,
  allowedModels: readonly ModelReference[],
  modelPresets: Readonly<Record<string, ModelPreset>> | undefined,
): DigestConfig {
  const raw = object(value, "digest");
  rejectUnknownKeys(raw, ["model", "preset", ...DIGEST_CONFIG_FIELDS], "digest");
  const parsed: Partial<Record<DigestNumericField, number>> = {};
  for (const field of DIGEST_CONFIG_FIELDS) {
    const bound = raw[field];
    if (bound === undefined) continue;
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 1) {
      throw new Error(`digest.${field} must be a positive integer`);
    }
    if (field === "charsPerBatch" && bound < DIGEST_CHARS_PER_BATCH_MIN) {
      throw new Error(`digest.${field} must be an integer of at least ${DIGEST_CHARS_PER_BATCH_MIN}`);
    }
    if (field === "entriesPerBatch" && bound < DIGEST_ENTRIES_PER_BATCH_MIN) {
      throw new Error(`digest.${field} must be an integer of at least ${DIGEST_ENTRIES_PER_BATCH_MIN}`);
    }
    // Converted to milliseconds in the runtime; keep the product inside the safe integer range.
    if (field === "runTimeoutSeconds" && bound > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      throw new Error(`digest.${field} is too large`);
    }
    parsed[field] = bound;
  }
  if (raw.model !== undefined && raw.preset !== undefined) {
    throw new Error("digest.model and digest.preset are mutually exclusive");
  }
  const model = raw.model === undefined ? undefined : modelReference(raw.model, "digest.model");
  if (model !== undefined && !allowedModels.some((choice) => modelKey(choice) === modelKey(model))) {
    throw new Error("digest.model must be included in allowedModels");
  }
  let preset: string | undefined;
  if (raw.preset !== undefined) {
    if (modelPresets === undefined) throw new Error("digest.preset requires named modelPresets");
    preset = modelPresetName(raw.preset, "digest.preset");
    if (!Object.hasOwn(modelPresets, preset)) {
      throw new Error("digest.preset must name an entry in modelPresets");
    }
  }
  return Object.freeze({
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(preset === undefined ? {} : { preset }),
  });
}

function mediaConfig(value: unknown): MediaConfig {
  const raw = object(value, "media");
  rejectUnknownKeys(raw, ["directory", "transcription"], "media");
  const directory = validateMediaDirectory(raw.directory);
  return Object.freeze({
    directory,
    ...(raw.transcription === undefined ? {} : { transcription: mediaTranscriptionConfig(raw.transcription) }),
  });
}

/**
 * Exactly the accepted top-level keys. An unknown key is a typo (or a stale option) that must fail
 * closed instead of silently leaving an intended restriction unapplied.
 */
const TOP_LEVEL_KEYS = [
  "workspace", "dataDir", "followUpMode",
  "model", "allowedModels", "thinkingLevel", "classifierModel", "modelPresets", "modelPreset", "visionHandoff",
  "toolAllowlist", "toolTimeoutSeconds", "toolSandbox", "restrictToWorkspace", "extraAllowedDirs", "bwrapPath",
  "workspaceContext", "mcp", "cron", "workers", "codemode", "digest", "media", "episodeSummary", "idleRollover", "proactiveMemory",
  "credentials", "providers", "web", "telegram", "discord", "app",
] as const;

/** Exactly the accepted `telegram` keys; an unknown key must not silently widen or skip a restriction. */
const TELEGRAM_KEYS = ["tokenEnv", "allowFrom", "pollTimeoutSeconds"] as const;

/** Mutable view used only while `parseConfig` assembles the result it then freezes. */
type ConfigDraft = { -readonly [K in keyof PortConfig]: PortConfig[K] };

export function parseConfig(value: unknown, baseDir = process.cwd()): PortConfig {
  const raw = object(value, "config");
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "config");
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
    model = Object.freeze({ provider: selected.provider, modelId: selected.modelId });
    // The catalog is the allowlist: one pair per provider/model even when two presets differ only
    // by thinking level, because native selection is keyed by the model pair.
    const seen = new Set<string>();
    allowedModels = [];
    for (const preset of Object.values(modelPresets)) {
      const reference = Object.freeze({ provider: preset.provider, modelId: preset.modelId });
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
  Object.freeze(allowedModels);
  // One classifier model is a separate authority from chat selection. Absent means no
  // classifier is reachable, however many providers are registered.
  const classifierModel = raw.classifierModel === undefined
    ? undefined
    : modelReference(raw.classifierModel, "classifierModel");
  const config: ConfigDraft = {
    workspace: resolve(baseDir, nonempty(raw.workspace, "workspace")),
    dataDir: resolve(baseDir, nonempty(raw.dataDir, "dataDir")),
    followUpMode: followUpModeConfig(raw.followUpMode),
    model,
    allowedModels,
    ...(classifierModel === undefined ? {} : { classifierModel }),
    ...(modelPresets === undefined ? {} : { modelPresets }),
    ...(modelPreset === undefined ? {} : { modelPreset }),
  };
  config.toolAllowlist = toolAllowlistConfig(raw.toolAllowlist);
  const toolTimeoutSeconds = parseToolTimeoutSeconds(raw.toolTimeoutSeconds);
  if (toolTimeoutSeconds !== undefined) config.toolTimeoutSeconds = toolTimeoutSeconds;
  if (raw.toolSandbox !== undefined) {
    if (raw.toolSandbox !== "host" && raw.toolSandbox !== "bwrap") {
      throw new Error('toolSandbox must be "host" or "bwrap"');
    }
    config.toolSandbox = raw.toolSandbox;
  }
  if (raw.restrictToWorkspace !== undefined) {
    if (typeof raw.restrictToWorkspace !== "boolean") throw new Error("restrictToWorkspace must be a boolean");
    if (raw.restrictToWorkspace === false && raw.toolSandbox === "bwrap") {
      throw new Error("restrictToWorkspace: false requires the host shell, not bwrap");
    }
    config.restrictToWorkspace = raw.restrictToWorkspace;
  }
  if (raw.workspaceContext !== undefined) {
    config.workspaceContext = workspaceContextConfig(raw.workspaceContext);
  }
  const proactiveMemoryEnabled = config.workspaceContext?.memory === "proactive";
  if (proactiveMemoryEnabled && classifierModel === undefined) {
    throw new Error("workspaceContext.memory requires classifierModel in proactive mode");
  }
  if (raw.proactiveMemory !== undefined) {
    if (!proactiveMemoryEnabled) throw new Error("proactiveMemory requires workspaceContext.memory in proactive mode");
    config.proactiveMemory = proactiveMemoryConfig(raw.proactiveMemory);
  }
  // Parsed after the workspace is resolved: a stdio server's cwd is confined to it.
  if (raw.mcp !== undefined) {
    config.mcp = parseMcpConfig(raw.mcp, config.workspace);
  }
  if (raw.cron !== undefined) {
    config.cron = cronConfig(raw.cron);
  }
  if (raw.workers !== undefined) {
    const workers = workersConfig(raw.workers);
    if (workers.preset !== undefined) {
      if (modelPresets === undefined) throw new Error("workers.preset requires named modelPresets");
      if (!Object.hasOwn(modelPresets, workers.preset)) {
        throw new Error("workers.preset must name an entry in modelPresets");
      }
    }
    config.workers = workers;
  }
  if (raw.codemode !== undefined) {
    config.codemode = codeModeConfig(raw.codemode);
  }
  if (raw.digest !== undefined) {
    config.digest = digestConfig(raw.digest, allowedModels, modelPresets);
  }
  if (raw.media !== undefined) {
    config.media = mediaConfig(raw.media);
  }
  if (raw.episodeSummary !== undefined) {
    config.episodeSummary = episodeSummaryConfig(raw.episodeSummary, allowedModels, modelPresets);
  }
  if (raw.idleRollover !== undefined) {
    // Rollover classifies the owner's next message with the one configured classifier; there is
    // no fallback model, so the pair is a pure config cross-check.
    if (classifierModel === undefined) throw new Error("idleRollover requires classifierModel");
    config.idleRollover = idleRolloverConfig(raw.idleRollover);
  }
  if (raw.visionHandoff !== undefined) {
    config.visionHandoff = visionHandoffConfig(raw.visionHandoff, modelPresets);
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
    config.extraAllowedDirs = Object.freeze(
      raw.extraAllowedDirs.map((v, i) => resolve(baseDir, nonempty(v, `extraAllowedDirs[${i}]`))),
    );
  }
  if (raw.bwrapPath !== undefined) {
    const path = nonempty(raw.bwrapPath, "bwrapPath");
    if (!isAbsolute(path)) throw new Error("bwrapPath must be absolute");
    config.bwrapPath = path;
  }
  if (raw.credentials !== undefined) {
    const credentials = object(raw.credentials, "credentials");
    const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [rawKey, name] of Object.entries(credentials)) {
      const key = providerKey(rawKey, "credentials key");
      normalized[key] = envName(name, `credentials.${key}`);
    }
    config.credentials = Object.freeze(normalized);
  }
  if (raw.providers !== undefined) {
    config.providers = customProvidersConfig(raw.providers);
  }
  if (raw.telegram !== undefined) {
    config.telegram = telegramConfig(raw.telegram);
  }
  if (raw.discord !== undefined) {
    config.discord = discordConfig(raw.discord);
  }
  if (raw.app !== undefined) {
    config.app = appConfig(raw.app);
  }
  if (raw.web !== undefined) {
    config.web = parseWebConfig(raw.web);
  }
  return Object.freeze(config);
}

/**
 * Foreground coding-tool ceiling. Only the reviewed native coding tools have registrations; any
 * other name (including a separately configured capability such as `web_search`) is refused here
 * rather than at gateway open, so `doctor` and `init` see the same failure.
 */
function toolAllowlistConfig(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("toolAllowlist must be an array");
  const names = value.map((name, index) => {
    if (typeof name !== "string" || name.length === 0 || name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`toolAllowlist[${index}] must be an exact non-empty tool name`);
    }
    return name;
  });
  const foldedNames = names.map((name) => name.toLocaleLowerCase("en-US"));
  if (new Set(foldedNames).size !== foldedNames.length) {
    throw new Error("toolAllowlist must not contain duplicate or case-ambiguous names");
  }
  if (names.some((name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name))) {
    throw new Error(`toolAllowlist must name only coding tools (${CODING_TOOL_NAMES.join(", ")})`);
  }
  return Object.freeze(names);
}

function episodeSummaryConfig(
  value: unknown,
  allowedModels: readonly ModelReference[],
  modelPresets: Readonly<Record<string, ModelPreset>> | undefined,
): NonNullable<PortConfig["episodeSummary"]> {
  const summary = object(value, "episodeSummary");
  rejectUnknownKeys(summary, ["enabled", "model", "preset"], "episodeSummary");
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
  return Object.freeze({
    ...(summary.enabled === undefined ? {} : { enabled: summary.enabled }),
    ...(summaryModel === undefined ? {} : { model: summaryModel }),
    ...(summaryPreset === undefined ? {} : { preset: summaryPreset }),
  });
}

/** `telegram`: opt-in, with an explicit decimal sender allowlist and the token named by variable. */
function telegramConfig(value: unknown): NonNullable<PortConfig["telegram"]> {
  const t = object(value, "telegram");
  rejectUnknownKeys(t, TELEGRAM_KEYS, "telegram");
  if (!Array.isArray(t.allowFrom) || t.allowFrom.length === 0
    || t.allowFrom.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) {
    throw new Error("telegram.allowFrom must be a non-empty list of decimal user IDs");
  }
  let pollTimeoutSeconds: number | undefined;
  if (t.pollTimeoutSeconds !== undefined) {
    if (typeof t.pollTimeoutSeconds !== "number" || !Number.isInteger(t.pollTimeoutSeconds)
      || t.pollTimeoutSeconds < 1 || t.pollTimeoutSeconds > 50) {
      throw new Error("telegram.pollTimeoutSeconds must be an integer from 1 to 50");
    }
    pollTimeoutSeconds = t.pollTimeoutSeconds;
  }
  return Object.freeze({
    tokenEnv: envName(t.tokenEnv, "telegram.tokenEnv"),
    allowFrom: Object.freeze([...t.allowFrom as string[]]),
    ...(pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds }),
  });
}

/**
 * One explicit snowflake allowlist. An empty list is only accepted where empty has a documented
 * meaning ("no narrowing"); an empty sender list is refused, because it would leave every sender
 * refused and the channel unusable while looking configured.
 */
function snowflakeList(value: unknown, name: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id))) {
    throw new Error(`${name} must be a list of decimal Discord snowflakes`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  if (new Set(value).size !== value.length) throw new Error(`${name} must not repeat an ID`);
  return Object.freeze([...value as string[]]);
}

/** Exactly the accepted `discord` keys; an unknown key is a typo that must not silently widen access. */
const DISCORD_KEYS = ["tokenEnv", "allowFrom", "dmAllowFrom", "allowChannels", "groupPolicy", "streaming", "receipts"] as const;
const DISCORD_RECEIPT_KEYS = ["read", "working", "delayMs"] as const;

/** `discord`: opt-in, default-deny, and no wildcard spelling in any list. */
function discordConfig(value: unknown): NonNullable<PortConfig["discord"]> {
  const d = object(value, "discord");
  rejectUnknownKeys(d, DISCORD_KEYS, "discord");
  const discord: { -readonly [K in keyof NonNullable<PortConfig["discord"]>]: NonNullable<PortConfig["discord"]>[K] } = {
    tokenEnv: envName(d.tokenEnv, "discord.tokenEnv"),
    allowFrom: snowflakeList(d.allowFrom, "discord.allowFrom", false),
  };
  if (d.dmAllowFrom !== undefined) {
    discord.dmAllowFrom = snowflakeList(d.dmAllowFrom, "discord.dmAllowFrom", true);
  }
  if (d.allowChannels !== undefined) {
    discord.allowChannels = snowflakeList(d.allowChannels, "discord.allowChannels", true);
  }
  if (d.groupPolicy !== undefined) {
    if (d.groupPolicy !== "mention" && d.groupPolicy !== "open") {
      throw new Error("discord.groupPolicy must be mention or open");
    }
    discord.groupPolicy = d.groupPolicy;
  }
  if (d.streaming !== undefined) {
    if (typeof d.streaming !== "boolean") throw new Error("discord.streaming must be a boolean");
    discord.streaming = d.streaming;
  }
  if (d.receipts !== undefined) {
    const r = object(d.receipts, "discord.receipts");
    rejectUnknownKeys(r, DISCORD_RECEIPT_KEYS, "discord.receipts");
    const receipts: { read?: string | false; working?: string | false; delayMs?: number } = {};
    for (const key of ["read", "working"] as const) {
      const emoji = r[key];
      if (emoji === undefined) continue;
      if (emoji === false) {
        receipts[key] = false;
        continue;
      }
      if (typeof emoji !== "string" || emoji.trim() === "" || emoji.length > 32 || /[\r\n]/.test(emoji)) {
        throw new Error(`discord.receipts.${key} must be false or a short single-line emoji`);
      }
      receipts[key] = emoji;
    }
    if (r.delayMs !== undefined) {
      if (typeof r.delayMs !== "number" || !Number.isFinite(r.delayMs) || r.delayMs < 0 || r.delayMs > 10_000) {
        throw new Error("discord.receipts.delayMs must be from 0 to 10000");
      }
      receipts.delayMs = r.delayMs;
    }
    discord.receipts = Object.freeze(receipts);
  }
  return Object.freeze(discord);
}

/** Exactly the accepted `app` keys; an unknown key is a typo that must not silently widen access. */
const APP_KEYS = ["port", "staticRoot", "autoArchiveDays", "agentName", "push"] as const;
/** Exactly the accepted `app.push` keys; the private key is an environment variable name. */
const APP_PUSH_KEYS = ["subject", "publicKey", "privateKeyEnv"] as const;

function appPushConfig(value: unknown): NonNullable<NonNullable<PortConfig["app"]>["push"]> {
  const p = object(value, "app.push");
  rejectUnknownKeys(p, APP_PUSH_KEYS, "app.push");
  if (!validVapidSubject(p.subject)) {
    throw new Error("app.push.subject must be a mailto: or https: URI");
  }
  if (!validVapidPublicKey(p.publicKey)) {
    throw new Error("app.push.publicKey must be a base64url uncompressed P-256 public key");
  }
  return Object.freeze({
    subject: p.subject,
    publicKey: p.publicKey,
    privateKeyEnv: envName(p.privateKeyEnv, "app.push.privateKeyEnv"),
  });
}

/** `app`: opt-in, loopback-only, with an explicit port and an absolute static root. */
function appConfig(value: unknown): NonNullable<PortConfig["app"]> {
  const a = object(value, "app");
  rejectUnknownKeys(a, APP_KEYS, "app");
  if (typeof a.port !== "number" || !Number.isSafeInteger(a.port) || a.port < 1 || a.port > 65_535) {
    throw new Error("app.port must be an integer from 1 to 65535");
  }
  if (typeof a.staticRoot !== "string" || a.staticRoot.trim() === "" || !isAbsolute(a.staticRoot)) {
    throw new Error("app.staticRoot must be an absolute directory path");
  }
  const staticRoot = resolve(a.staticRoot);
  const autoArchiveDays = a.autoArchiveDays === undefined ? 14 : a.autoArchiveDays;
  if (typeof autoArchiveDays !== "number" || !Number.isSafeInteger(autoArchiveDays) || autoArchiveDays < 1) {
    throw new Error("app.autoArchiveDays must be an integer of at least 1");
  }
  const agentName = a.agentName === undefined ? "Pedellus" : a.agentName;
  if (!validAppAgentName(agentName)) {
    throw new Error("app.agentName must be 1 to 40 printable characters");
  }
  const push = a.push === undefined ? undefined : appPushConfig(a.push);
  return Object.freeze({ port: a.port, staticRoot, autoArchiveDays, agentName, ...(push === undefined ? {} : { push }) });
}

/**
 * The primary configuration used when a launch has no `--config` override. It is
 * resolved from the runtime user home, never the process working directory, so a
 * service start is independent of where systemd happens to place it. This locates
 * exactly one file; it never searches, merges or creates configuration.
 */
export function defaultConfigPath(): string {
  return join(userHome(), ".pedellus", "config.json");
}

function userHome(): string {
  let home: string;
  try { home = homedir(); }
  catch (cause) { throw new StartupDiagnosticError("configHome", { cause }); }
  if (home.length === 0 || !isAbsolute(home)) throw new StartupDiagnosticError("configHome");
  return home;
}

export async function loadConfig(path: string): Promise<PortConfig> {
  const absolute = resolve(path);
  let value: unknown;
  try { value = JSON.parse(await readFile(absolute, "utf8")); }
  catch (cause) { throw new StartupDiagnosticError("configFile", { cause }); }
  try { return Object.freeze({ ...parseConfig(value, dirname(absolute)), configFile: absolute }); }
  catch (cause) { throw new StartupDiagnosticError("configInvalid", { cause }); }
}
