import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  WorkspaceContextBoundsError,
  WorkspaceContextInputError,
  validateWorkspaceMemoryFiles,
} from "./context/workspace.js";

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

export interface WorkspaceContextConfig {
  /** Explicit workspace-relative `memory/**\/*.md` files, in output order. Defaults to none. */
  readonly memoryFiles: readonly string[];
}

export interface PortConfig {
  workspace: string;
  dataDir: string;
  /**
   * Explicit opt-in for bounded workspace context. Absent means the gateway
   * installs no context extension; there is no implicit workspace discovery.
   */
  workspaceContext?: WorkspaceContextConfig;
  /** Default selection; retained for backward compatibility with single-model configs. */
  model: ModelReference;
  /** Explicit finite model choices. Missing means the legacy singleton [model]. */
  allowedModels?: readonly ModelReference[];
  /** Host-owned global ceiling; conversations may only narrow it. Empty means tools are disabled. */
  toolAllowlist?: readonly string[];
  /**
   * Config-level default shell timeout in seconds for the host tool environment. `0` disables the
   * timeout. Absent keeps the shared policy default. This is not the per-call cap.
   */
  toolTimeoutSeconds?: number;
  thinkingLevel?: ModelThinkingLevel;
  extraAllowedDirs?: readonly string[];
  bwrapPath?: string;
  credentials?: Partial<Record<CredentialProvider, string>>;
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

function modelKey(model: ModelReference): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function workspaceContextConfig(value: unknown): WorkspaceContextConfig {
  const raw = object(value, "workspaceContext");
  for (const key of Object.keys(raw)) {
    if (key !== "memoryFiles") throw new Error(`Unknown workspaceContext field: ${key}`);
  }
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
  return Object.freeze({ memoryFiles });
}

export function parseConfig(value: unknown, baseDir = process.cwd()): PortConfig {
  const raw = object(value, "config");
  const model = modelReference(raw.model, "model");
  let allowedModels: ModelReference[];
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
  const config: PortConfig = {
    workspace: resolve(baseDir, nonempty(raw.workspace, "workspace")),
    dataDir: resolve(baseDir, nonempty(raw.dataDir, "dataDir")),
    model,
    allowedModels,
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
  if (raw.workspaceContext !== undefined) {
    Object.assign(config, { workspaceContext: workspaceContextConfig(raw.workspaceContext) });
  }
  if (raw.thinkingLevel !== undefined) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(raw.thinkingLevel))) throw new Error("Invalid thinkingLevel");
    Object.assign(config, { thinkingLevel: raw.thinkingLevel });
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
  catch (error) { throw new Error(`Cannot load config ${absolute}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseConfig(value, dirname(absolute));
}
