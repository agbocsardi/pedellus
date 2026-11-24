/**
 * `pedellus init`: guided first-run setup.
 *
 * It creates one new configuration file (never overwriting an existing one), a private data
 * directory, a starter workspace with curated skills, logs in to one native provider into the
 * private credential store, and optionally runs a short terminal interview that personalizes the
 * workspace files via trusted templates. When the interview is skipped, cancelled or fails, a
 * first-chat onboarding note is written instead. No secret value is written to the configuration
 * or workspace, and no raw exception is printed.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { cp, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Api,
  AssistantMessage,
  AuthInteraction,
  CredentialStore,
  Message,
  Model,
  ModelThinkingLevel,
  Models,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { chooseLogin, interactiveChoices, loginWithChoice, terminalInteraction } from "../auth/cli.js";
import { authStorePath, FileCredentialStore } from "../auth/store.js";
import { defaultConfigPath, parseConfig, type PortConfig } from "../config.js";
import { loadWorkspaceContextSnapshot } from "../context/workspace.js";
import { createAuthModels, resolveModelChoices } from "../providers.js";
import { StartupDiagnosticError } from "../startup-diagnostics.js";
import { prepareDataDirectory } from "../store.js";
import {
  INTERVIEW_OPENING,
  INTERVIEW_WRAP_UP,
  interviewSystemPrompt,
  onboardingMd,
  PREFERENCES_TOPIC_FILE,
  PROFILE_FENCE,
  PROFILE_FILE_MAX_BYTES,
  renderPreferencesMd,
  renderSoulMd,
  renderUserMd,
  starterAgentsMd,
  starterMemoryMd,
  starterSoulMd,
  starterUserMd,
  type StructuredProfile,
  type TemplateBasics,
} from "./templates.js";

/** Starter skills copied from the checkout's `skills/` into a new workspace. */
export const STARTER_SKILLS = Object.freeze(["memory", "cron", "skill-creator"]);

/** Owner replies the terminal interview accepts before it asks for the profile. */
export const INTERVIEW_MAX_TURNS = 8;

const ONBOARDING_FILE = "memory/system/onboarding.md";
const MODEL_LIST_LIMIT = 40;
const FAST_MODEL_HINT = /(mini|flash|haiku|lite|nano|small|fast|luna)/i;
const ASSISTANT_NAME = /^[^\p{Cc}\p{Cf}]{1,40}$/u;
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-zA-Z](?:\/|$)/;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const SECRET_LIKE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|[0-9]{8,}:[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** A fixed, owner-facing init failure: safe to print verbatim, never carrying a path or payload. */
export class InitError extends Error {
  override name = "InitError";
}

export interface InitOptions {
  /** Target configuration file; it must not exist yet. */
  readonly configPath: string;
  readonly skipInterview?: boolean;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
  /** Checkout whose `skills/` holds the starter skills; default: this source tree's root. */
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
  /** Build the provider collection over the private credential store; default: every native provider. */
  readonly models?: (credentials: CredentialStore) => Models;
  readonly env?: NodeJS.ProcessEnv;
}

export type InitOutcome = "personalized" | "onboarding" | "aborted";

export interface InitResult {
  readonly outcome: InitOutcome;
  readonly configPath: string;
}

interface Asker {
  readonly interaction: AuthInteraction;
  ask(message: string, fallback?: string): Promise<string>;
  confirm(message: string, fallback: boolean): Promise<boolean>;
}

function asker(interaction: AuthInteraction): Asker {
  const ask = async (message: string, fallback?: string): Promise<string> => {
    const answer = (await interaction.prompt({
      type: "text",
      message,
      ...(fallback === undefined || fallback === "" ? {} : { placeholder: fallback }),
    })).trim();
    return answer === "" ? fallback ?? "" : answer;
  };
  const confirm = async (message: string, fallback: boolean): Promise<boolean> => {
    for (;;) {
      const answer = (await interaction.prompt({ type: "text", message: `${message} ${fallback ? "[Y/n]" : "[y/N]"}` }))
        .trim()
        .toLowerCase();
      if (answer === "") return fallback;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  };
  return { interaction, ask, confirm };
}

function defaultRepoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

async function detectWsl(): Promise<boolean> {
  if (process.env.WSL_DISTRO_NAME !== undefined) return true;
  try {
    return /microsoft/i.test(await readFile("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reject symlinked existing ancestors or workspace/data directories before any write. */
async function assertSafeTargetLayout(configPath: string): Promise<void> {
  const root = dirname(configPath);
  let probe = root;
  for (;;) {
    try {
      const info = await lstat(probe);
      if (!info.isDirectory()) {
        throw new InitError("the target configuration directory or one of its ancestors is a symlink or not a real directory");
      }
      if (await realpath(probe) !== probe) {
        throw new InitError(
          "the target configuration path crosses a symlink; use a canonical path so workspace context checks succeed",
        );
      }
      break;
    } catch (error) {
      if (error instanceof InitError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  for (const dir of [
    workspace,
    dataDir,
    join(workspace, "memory"),
    join(workspace, "memory", "system"),
    join(workspace, "memory", "preferences"),
    join(workspace, "skills"),
  ]) {
    try {
      const info = await lstat(dir);
      if (!info.isDirectory()) {
        throw new InitError("a target workspace or data path already exists as a symlink or non-directory");
      }
    } catch (error) {
      if (error instanceof InitError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Refuse to share an existing installation's store or credentials under a second config filename.
  if (await exists(join(dataDir, "nanobot.sqlite")) || await exists(authStorePath(dataDir))) {
    throw new InitError(
      "the target directory already holds a Pedellus data store or credentials; use its existing config or choose a new directory",
    );
  }
}

/** Create a file only when the path is free; an existing owner file is never replaced. */
async function writeNew(path: string, body: string, mode = 0o644): Promise<boolean> {
  try {
    await writeFile(path, body, { encoding: "utf8", mode, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Publish a new file atomically without ever overwriting an existing path. */
async function publishExclusive(path: string, body: string, mode: number): Promise<boolean> {
  const temp = join(dirname(path), `.init-tmp-${randomBytes(8).toString("hex")}`);
  await writeFile(temp, body, { encoding: "utf8", mode, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function defaultTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && validTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** Match cron's strict IANA rule: reject fixed numeric offsets like `+02:00`. */
function validTimeZone(zone: string): boolean {
  const value = zone.trim();
  if (value === "" || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Strip ANSI escape sequences and unsafe control/bidi characters before terminal output. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(DISALLOWED_CONTROLS, "");
}

function containsKnownSecret(text: string, secretValues: readonly string[]): boolean {
  if (SECRET_LIKE.test(text)) return true;
  for (const secret of secretValues) {
    if (secret.length >= 6 && text.includes(secret)) return true;
  }
  return false;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const configPath = resolve(options.configPath);
  const out = (text: string) => options.output.write(text);
  if (await exists(configPath)) {
    throw new InitError(
      "a configuration file already exists at the target path and is never overwritten; " +
      "check it with `pedellus doctor`, add a provider with `pedellus login`, or pass a new --config <path>",
    );
  }
  await assertSafeTargetLayout(configPath);

  const terminal = terminalInteraction({
    input: options.input,
    output: options.output,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const io = asker(terminal.interaction);
    out("Pedellus setup\n\n");

    const platform = options.platform ?? process.platform;
    if (platform !== "linux") {
      out("Warning: Pedellus is built and tested on Linux; workspace context and its safety checks are Linux-only.\n");
      if (!await io.confirm("Continue anyway?", false)) return aborted(out, configPath);
    }
    const wsl = options.isWsl ?? (platform === "linux" && await detectWsl());
    if (wsl && WINDOWS_DRIVE_MOUNT.test(configPath)) {
      out(
        "Warning: this path is on a Windows drive under /mnt. DrvFs can break private permissions, Unix sockets and\n" +
        "SQLite WAL; keep Pedellus inside the Linux filesystem (for example under your home directory).\n",
      );
      if (!await io.confirm("Continue anyway?", false)) return aborted(out, configPath);
    }

    // Directories first: the credential store needs the private data directory.
    const root = dirname(configPath);
    const workspace = join(root, "workspace");
    const dataDir = join(root, "data");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of [
      workspace,
      join(workspace, "memory"),
      join(workspace, "memory", "system"),
      join(workspace, "memory", "preferences"),
      join(workspace, "skills"),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    const prepared = await prepareDataDirectory(bootstrapConfig(workspace, dataDir));
    const copied = await copyStarterSkills(options.repoRoot ?? defaultRepoRoot(), join(workspace, "skills"));
    out(`Created the workspace and private data directory${copied.length === 0 ? "" : ` (skills: ${copied.join(", ")})`}.\n\n`);

    // Step 1: provider login into data/credentials.json (only chat-capable providers).
    out("Step 1 of 2: connect a model provider\n");
    const store = new FileCredentialStore(authStorePath(prepared.canonicalDataDir));
    const models = options.models?.(store) ??
      createAuthModels(bootstrapConfig(workspace, dataDir), options.env ?? process.env, store);
    const chatChoices = interactiveChoices(models).filter((candidate) => candidate.provider.getModels().length > 0);
    if (chatChoices.length === 0) {
      throw new InitError("no chat-capable providers with interactive login are available");
    }
    const choice = await chooseLogin(chatChoices, io.interaction);
    try {
      await loginWithChoice(models, choice, prepared.canonicalDataDir, io.interaction);
    } catch (cause) {
      if (cause instanceof StartupDiagnosticError) throw cause;
      throw new StartupDiagnosticError(options.signal?.aborted ? "authCanceled" : "authFailed", { cause });
    }
    out(`Logged in to ${choice.provider.id} using ${choice.label}.\n\n`);

    const providerId = choice.provider.id;
    const storedSecrets = await collectStoredSecretStrings(store, providerId);
    const listed = await availableModels(models, providerId, options.signal);
    if (listed.length === 0) {
      throw new InitError(`provider ${providerId} exposes no chat models in the current catalog`);
    }
    const deep = await chooseModel(io, out, listed, "Default (deep) model", listed[0]!);
    const fastDefault = listed.find((model) => model.id !== deep.id && FAST_MODEL_HINT.test(model.id)) ?? deep.model;
    const fast = await chooseModel(io, out, listed, "Fast model (quick replies, digests)", fastDefault);

    // Quick basics.
    out("\nA few basics (press Enter to accept the default):\n");
    let timeZone = await io.ask("Time zone (IANA)", defaultTimeZone());
    while (!validTimeZone(timeZone)) {
      out("That is not an IANA time zone name, for example Europe/Budapest or UTC.\n");
      timeZone = await io.ask("Time zone (IANA)", defaultTimeZone());
    }
    let name = await io.ask("Assistant name", "Pedellus");
    while (!ASSISTANT_NAME.test(name)) {
      out("Use 1-40 printable characters.\n");
      name = await io.ask("Assistant name", "Pedellus");
    }
    const fileTools = await io.confirm("Let the assistant read and edit workspace files (read, write, edit)?", true);
    out(
      "The shell tool (bash) runs commands as your user; restrictToWorkspace narrows its working directory\n" +
      "but it is not a sandbox. Enable it only if you trust the model with your account.\n",
    );
    const shell = await io.confirm("Enable the bash shell tool?", false);

    const basics: TemplateBasics = { name, timeZone, fileTools };
    const rawConfig = {
      workspace: "./workspace",
      dataDir: "./data",
      modelPresets: {
        fast: preset(providerId, fast, "off"),
        deep: preset(providerId, deep, "high"),
      },
      modelPreset: "deep",
      workspaceContext: { memoryFiles: ["memory/MEMORY.md"], memoryManifest: true, skills: {} },
      toolAllowlist: [...(fileTools ? ["read", "write", "edit"] : []), ...(shell ? ["bash"] : [])],
      followUpMode: "followUp",
      cron: { enabled: true, timeZone },
      episodeSummary: { enabled: true },
      digest: { preset: "fast" },
    };
    // Validate the parsed config, resolved chat models, and (on Linux) the actual workspace snapshot
    // before publishing config.json so a success receipt implies a startable configuration.
    const parsedConfig = parseConfig(rawConfig, root);
    resolveModelChoices(models, parsedConfig.allowedModels ?? [parsedConfig.model]);
    const created = await writeStarterFiles(workspace, basics);
    if (platform === "linux" && process.platform === "linux") {
      await loadWorkspaceContextSnapshot({
        workspaceRoot: workspace,
        memoryFiles: parsedConfig.workspaceContext?.memoryFiles ?? [],
      });
    }
    if (!await publishExclusive(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 0o600)) {
      throw new InitError("a configuration file appeared at the target path during setup; it was left untouched");
    }
    out("\nWrote the configuration (no secrets; credentials stay in the private data directory).\n\n");

    // Step 2: the optional interview. Every cancellation, refusal or failure after config creation
    // falls back to the first-chat onboarding note so the setup is always complete.
    let outcome: InitOutcome = "onboarding";
    try {
      let interviewed = false;
      if (!options.skipInterview) {
        out("Step 2 of 2: get acquainted\n");
        interviewed = await io.confirm("Run a quick setup interview with Pedellus now to personalize your profile?", true);
      }
      if (interviewed) {
        let profile: StructuredProfile | undefined;
        try {
          profile = await interview(models, deep.model, basics, io, out, storedSecrets, options.signal);
        } catch (error) {
          if (isCancellation(error, options.signal)) throw error;
          out("\nThe interview could not continue (model or network error; details suppressed).\n");
        }
        if (profile !== undefined) {
          const rendered = renderProfileFiles(basics, profile);
          out("\nProposed files (full preview):\n");
          for (const [relative, body] of rendered) {
            out(`\n--- ${relative} ---\n${body}`);
          }
          out("\n");
          if (await io.confirm("Save these personalized files?", true)) {
            const { written, kept } = await savePersonalized(workspace, created, rendered);
            if (kept.length > 0) out(`Kept your existing or modified ${kept.join(", ")} unchanged.\n`);
            if (written.length > 0) outcome = "personalized";
          }
        }
      }
    } catch (error) {
      await writeOnboarding(workspace, basics);
      throw error;
    }

    if (outcome !== "personalized") {
      await writeOnboarding(workspace, basics);
      out(`${name} will introduce itself and finish getting to know you in your first chat.\n`);
    }

    out(
      "\nNext steps:\n" +
      "  pedellus doctor    check the setup\n" +
      "  pedellus gateway   start the assistant (keep it running)\n" +
      "  pedellus agent     chat from another terminal\n",
    );
    if (!isDefaultConfigPath(configPath)) {
      out("Pass --config <path> to each command, since this is not the default configuration path.\n");
    }
    return { outcome, configPath };
  } finally {
    terminal.close();
  }
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === "input closed");
}

async function collectStoredSecretStrings(store: FileCredentialStore, providerId: string): Promise<readonly string[]> {
  try {
    const credential = await store.read(providerId);
    if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim() !== "") {
      return [credential.key.trim()];
    }
  } catch {
    // Best-effort guard only.
  }
  return [];
}

function isDefaultConfigPath(path: string): boolean {
  try {
    return path === resolve(defaultConfigPath());
  } catch {
    return false;
  }
}

function aborted(out: (text: string) => void, configPath: string): InitResult {
  out("Setup cancelled; nothing was written.\n");
  return { outcome: "aborted", configPath };
}

/** A minimal configuration for directory preparation and login: no model is selected or called. */
function bootstrapConfig(workspace: string, dataDir: string): PortConfig {
  return { workspace, dataDir, model: { provider: "init", modelId: "init" } };
}

async function copyStarterSkills(repoRoot: string, target: string): Promise<string[]> {
  const copied: string[] = [];
  for (const skill of STARTER_SKILLS) {
    const source = join(repoRoot, "skills", skill);
    const destination = join(target, skill);
    if (!await exists(join(source, "SKILL.md")) || await exists(destination)) continue;
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    copied.push(skill);
  }
  return copied;
}

interface Choice {
  readonly id: string;
  readonly model: Model<Api>;
}

async function availableModels(models: Models, providerId: string, signal: AbortSignal | undefined): Promise<Model<Api>[]> {
  let listed: readonly Model<Api>[] = [];
  try {
    listed = await models.getAvailable(providerId, signal === undefined ? {} : { signal });
  } catch {
    listed = [];
  }
  if (listed.length === 0) listed = models.getProvider(providerId)?.getModels() ?? [];
  return [...listed];
}

async function chooseModel(
  io: Asker,
  out: (text: string) => void,
  listed: readonly Model<Api>[],
  label: string,
  fallback: Model<Api>,
): Promise<Choice> {
  out(`\n${label}:\n`);
  listed.slice(0, MODEL_LIST_LIMIT).forEach((model, index) => {
    out(`  ${index + 1}) ${model.id}${model.name && model.name !== model.id ? ` - ${model.name}` : ""}\n`);
  });
  if (listed.length > MODEL_LIST_LIMIT) {
    out(`  ... and ${listed.length - MODEL_LIST_LIMIT} more; type an exact model ID to pick one of them.\n`);
  }
  for (;;) {
    const answer = await io.ask("Model number or ID", fallback.id);
    const index = Number(answer);
    const picked = Number.isInteger(index) && index >= 1 && index <= Math.min(listed.length, MODEL_LIST_LIMIT)
      ? listed[index - 1]
      : listed.find((model) => model.id === answer);
    if (picked !== undefined) return { id: picked.id, model: picked };
    out("Choose a listed number or an exact model ID.\n");
  }
}

function preset(provider: string, choice: Choice, wanted: ModelThinkingLevel): Record<string, string> {
  const level = clampThinkingLevel(choice.model, wanted);
  return getSupportedThinkingLevels(choice.model).includes(level)
    ? { provider, modelId: choice.id, thinkingLevel: level }
    : { provider, modelId: choice.id };
}

/** Write every starter file whose path is free; returns a map of relative path -> exact content written. */
async function writeStarterFiles(workspace: string, basics: TemplateBasics): Promise<Map<string, string>> {
  const created = new Map<string, string>();
  const files: Array<[string, string]> = [
    ["AGENTS.md", starterAgentsMd(basics)],
    ["SOUL.md", starterSoulMd(basics)],
    ["USER.md", starterUserMd(basics)],
    ["memory/MEMORY.md", starterMemoryMd()],
  ];
  for (const [relative, body] of files) {
    if (await writeNew(join(workspace, relative), body)) created.set(relative, body);
  }
  return created;
}

async function writeOnboarding(workspace: string, basics: TemplateBasics): Promise<void> {
  await writeNew(join(workspace, ONBOARDING_FILE), onboardingMd(basics));
}

function renderProfileFiles(basics: TemplateBasics, profile: StructuredProfile): Array<readonly [string, string]> {
  return [
    ["USER.md", renderUserMd(basics, profile)],
    ["SOUL.md", renderSoulMd(basics, profile)],
    [PREFERENCES_TOPIC_FILE, renderPreferencesMd(profile)],
  ];
}

/**
 * Atomically update only starter files that this run created AND that remain unchanged on disk,
 * plus write the new preferences topic file exclusively if absent. An owner's pre-existing or
 * intervening edit is never overwritten.
 */
async function savePersonalized(
  workspace: string,
  created: ReadonlyMap<string, string>,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<{ readonly written: string[]; readonly kept: string[] }> {
  const written: string[] = [];
  const kept: string[] = [];
  for (const [relative, body] of files) {
    const path = join(workspace, relative);
    const original = created.get(relative);
    if (original === undefined) {
      // New topic file (e.g. memory/preferences/standing.md): create only if free.
      if (relative === PREFERENCES_TOPIC_FILE && await publishExclusive(path, body, 0o644)) {
        written.push(relative);
      } else {
        kept.push(relative);
      }
      continue;
    }
    try {
      const info = await lstat(path);
      if (!info.isFile()) {
        kept.push(relative);
        continue;
      }
      const current = await readFile(path, "utf8");
      if (current !== original) {
        kept.push(relative);
        continue;
      }
    } catch {
      kept.push(relative);
      continue;
    }
    const temp = join(dirname(path), `.init-tmp-${randomBytes(8).toString("hex")}`);
    await writeFile(temp, body, { encoding: "utf8", mode: 0o644, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
    try {
      await rename(temp, path);
      written.push(relative);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return { written, kept };
}

const PROFILE_BLOCK = new RegExp("```" + PROFILE_FENCE + "[^\\n]*\\n([\\s\\S]*?)```");
const PROFILE_BLOCKS_ALL = new RegExp("```" + PROFILE_FENCE + "[^\\n]*\\n[\\s\\S]*?```", "g");

function cleanLine(value: unknown, maxChars: number, secretValues: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  if (ANSI_ESCAPE.test(value) || DISALLOWED_CONTROLS.test(value)) return undefined;
  const trimmed = value.replace(/\r?\n/g, " ").trim();
  if (trimmed === "" || trimmed.length > maxChars) return undefined;
  if (containsKnownSecret(trimmed, secretValues)) return undefined;
  return trimmed;
}

function cleanStringList(
  value: unknown,
  minItems: number,
  maxItems: number,
  maxChars: number,
  secretValues: readonly string[],
): string[] | undefined {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanLine(item, maxChars, secretValues);
    if (cleaned === undefined) return undefined;
    result.push(cleaned);
  }
  return result;
}

/**
 * Parse and strictly validate the structured profile block in a model reply. Rejects missing keys,
 * control/escape characters, secret-shaped strings, or out-of-bounds payloads.
 */
export function parseProfile(text: string, secretValues: readonly string[] = []): StructuredProfile | undefined {
  const match = PROFILE_BLOCK.exec(text);
  if (match === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const ownerName = cleanLine(record.ownerName, 80, secretValues);
  const preferredLanguage = cleanLine(record.preferredLanguage, 60, secretValues);
  const mainUses = cleanStringList(record.mainUses, 1, 8, 160, secretValues);
  const toneAndDetail = cleanLine(record.toneAndDetail, 240, secretValues);
  const soulBullets = cleanStringList(record.soulBullets, 1, 8, 200, secretValues);
  const standingPreferences = cleanStringList(record.standingPreferences ?? [], 0, 12, 200, secretValues);
  if (
    ownerName === undefined ||
    preferredLanguage === undefined ||
    mainUses === undefined ||
    toneAndDetail === undefined ||
    soulBullets === undefined ||
    standingPreferences === undefined
  ) {
    return undefined;
  }
  const profile: StructuredProfile = {
    ownerName,
    preferredLanguage,
    mainUses,
    toneAndDetail,
    soulBullets,
    standingPreferences,
  };
  const totalBytes = Buffer.byteLength(JSON.stringify(profile), "utf8");
  if (totalBytes > PROFILE_FILE_MAX_BYTES) return undefined;
  return profile;
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * The bounded terminal interview. Returns the validated structured profile, or undefined when
 * skipped or when the model never produced a usable block. Model/network errors reject so the
 * caller falls back to first-chat onboarding.
 */
async function interview(
  models: Models,
  selected: Model<Api>,
  basics: TemplateBasics,
  io: Asker,
  out: (text: string) => void,
  secretValues: readonly string[],
  signal: AbortSignal | undefined,
): Promise<StructuredProfile | undefined> {
  const systemPrompt = interviewSystemPrompt(basics, INTERVIEW_MAX_TURNS);
  const messages: Message[] = [{ role: "user", content: INTERVIEW_OPENING, timestamp: Date.now() }];
  out("Type /done to wrap up or /skip to finish later in your first chat.\n\n");
  for (let replies = 0; ; replies += 1) {
    const response = await models.completeSimple(selected, { systemPrompt, messages }, {
      maxTokens: Math.min(4_096, selected.maxTokens),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("interview model request failed");
    }
    messages.push(response);
    const text = replyText(response);
    const profile = parseProfile(text, secretValues);
    // Strip all fenced profile blocks (even malformed or duplicate) and control sequences before display.
    const visible = sanitizeTerminalText(text.replace(PROFILE_BLOCKS_ALL, "")).trim();
    if (visible !== "" && !containsKnownSecret(visible, secretValues)) {
      out(`${basics.name}: ${visible}\n\n`);
    }
    if (profile !== undefined) return profile;
    const wrapping = messages.at(-2)?.role === "user" && messages.at(-2)?.content === INTERVIEW_WRAP_UP;
    if (wrapping) return undefined;
    let answer = "";
    if (replies < INTERVIEW_MAX_TURNS) {
      while (answer === "") answer = await io.ask("You");
      if (answer === "/skip") return undefined;
    }
    messages.push({
      role: "user",
      content: replies >= INTERVIEW_MAX_TURNS || answer === "/done" ? INTERVIEW_WRAP_UP : answer,
      timestamp: Date.now(),
    });
  }
}
