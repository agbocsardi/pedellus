import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface PortConfig {
  workspace: string;
  dataDir: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  extraAllowedDirs?: readonly string[];
  bwrapPath?: string;
  credentials?: Partial<Record<"openai" | "opencode_zen" | "opencode_go", string>>;
  telegram?: { tokenEnv: string; allowFrom: readonly string[]; pollTimeoutSeconds?: number };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function parseConfig(value: unknown, baseDir = process.cwd()): PortConfig {
  const raw = object(value, "config");
  const model = object(raw.model, "model");
  const config: PortConfig = {
    workspace: resolve(baseDir, nonempty(raw.workspace, "workspace")),
    dataDir: resolve(baseDir, nonempty(raw.dataDir, "dataDir")),
    model: { provider: nonempty(model.provider, "model.provider"), modelId: nonempty(model.modelId, "model.modelId") },
  };
  if (raw.thinkingLevel !== undefined) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(raw.thinkingLevel))) throw new Error("Invalid thinkingLevel");
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
    const normalized: Record<string, string> = {};
    for (const [key, name] of Object.entries(credentials)) {
      if (!["openai", "opencode_zen", "opencode_go"].includes(key)) throw new Error(`Unknown credential provider: ${key}`);
      normalized[key] = nonempty(name, `credentials.${key}`);
    }
    Object.assign(config, { credentials: normalized });
  }
  if (raw.telegram !== undefined) {
    const t = object(raw.telegram, "telegram");
    if (!Array.isArray(t.allowFrom) || t.allowFrom.length === 0 || t.allowFrom.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) throw new Error("telegram.allowFrom must be a non-empty list of decimal user IDs");
    const telegram: NonNullable<PortConfig["telegram"]> = { tokenEnv: nonempty(t.tokenEnv, "telegram.tokenEnv"), allowFrom: t.allowFrom as string[] };
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
