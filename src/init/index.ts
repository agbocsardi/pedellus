/**
 * `pedellus init`: guided first-run setup.
 *
 * It creates one new configuration file (never overwriting an existing one), a private data
 * directory, a starter workspace with curated skills, logs in to one native provider into the
 * private credential store, and optionally runs a short terminal interview that personalizes the
 * workspace files. When the interview is skipped or fails, a first-chat onboarding note is written
 * instead. No secret value is written to the configuration, and no raw exception is printed.
 */
import { constants } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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
import { createAuthModels } from "../providers.js";
import { StartupDiagnosticError } from "../startup-diagnostics.js";
import { prepareDataDirectory } from "../store.js";
import {
  INTERVIEW_OPENING,
  INTERVIEW_WRAP_UP,
  interviewSystemPrompt,
  onboardingMd,
  PROFILE_FENCE,
  PROFILE_FILE_MAX_BYTES,
  starterAgentsMd,
  starterMemoryMd,
  starterSoulMd,
  starterUserMd,
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

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
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
    if (wsl && (configPath === "/mnt" || configPath.startsWith(`/mnt${sep}`))) {
      out(
        "Warning: this path is on a Windows drive under /mnt. DrvFs breaks private permissions, Unix sockets and\n" +
        "SQLite WAL; keep Pedellus inside the Linux filesystem (for example under your home directory).\n",
      );
      if (!await io.confirm("Continue anyway?", false)) return aborted(out, configPath);
    }

    // Directories first: the credential store needs the private data directory.
    const root = dirname(configPath);
    const workspace = join(root, "workspace");
    const dataDir = join(root, "data");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of [workspace, join(workspace, "memory"), join(workspace, "memory", "system"), join(workspace, "skills")]) {
      await mkdir(directory, { recursive: true });
    }
    const prepared = await prepareDataDirectory(bootstrapConfig(workspace, dataDir));
    const copied = await copyStarterSkills(options.repoRoot ?? defaultRepoRoot(), join(workspace, "skills"));
    out(`Created the workspace and private data directory${copied.length === 0 ? "" : ` (skills: ${copied.join(", ")})`}.\n\n`);

    // Step 1: provider login into data/credentials.json.
    out("Step 1 of 2: connect a model provider\n");
    const store = new FileCredentialStore(authStorePath(prepared.canonicalDataDir));
    const models = options.models?.(store) ??
      createAuthModels(bootstrapConfig(workspace, dataDir), options.env ?? process.env, store);
    const choice = await chooseLogin(interactiveChoices(models), io.interaction);
    try {
      await loginWithChoice(models, choice, prepared.canonicalDataDir, io.interaction);
    } catch (cause) {
      if (cause instanceof StartupDiagnosticError) throw cause;
      throw new StartupDiagnosticError(options.signal?.aborted ? "authCanceled" : "authFailed", { cause });
    }
    out(`Logged in to ${choice.provider.id} using ${choice.label}.\n\n`);

    const providerId = choice.provider.id;
    const listed = await availableModels(models, providerId, options.signal);
    const deep = await chooseModel(io, out, listed, "Default (deep) model", listed[0]);
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
    // Validate exactly what will be written, with the same relative-path base the loader uses.
    parseConfig(rawConfig, root);

    // Starter files and the configuration are written before the interview, so an interrupted
    // interview still leaves a startable setup; the onboarding note covers every non-success.
    const created = await writeStarterFiles(workspace, basics);
    if (!await writeNew(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 0o600)) {
      throw new InitError("a configuration file appeared at the target path during setup; it was left untouched");
    }
    out(`\nWrote the configuration (no secrets; credentials stay in the private data directory).\n\n`);

    // Step 2: the optional interview.
    let outcome: InitOutcome = "onboarding";
    let interviewed = false;
    if (!options.skipInterview) {
      out("Step 2 of 2: get acquainted\n");
      interviewed = await io.confirm("Run a quick setup interview with Pedellus now to personalize your profile?", true);
    }
    if (interviewed) {
      let profile: Profile | undefined;
      try {
        profile = await interview(models, deep, basics, io, out, options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          await writeOnboarding(workspace, basics);
          throw error;
        }
        out("\nThe interview could not continue (model or network error; details suppressed).\n");
      }
      if (profile !== undefined) {
        out(`\nProposed files:\n${summary("USER.md", profile.userMd)}${summary("SOUL.md", profile.soulMd)}` +
          `${summary("memory/MEMORY.md", profile.memoryMd)}`);
        if (await io.confirm("Save these personalized files?", true)) {
          const kept = await savePersonalized(workspace, created, profile);
          if (kept.length > 0) out(`Kept your existing ${kept.join(", ")} unchanged.\n`);
          outcome = "personalized";
        }
      }
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
  readonly model?: Model<Api>;
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
  fallback: Model<Api> | undefined,
): Promise<Choice> {
  if (listed.length === 0) {
    out("This provider lists no chat models offline; type an exact model ID (see `pedellus models refresh`).\n");
    for (;;) {
      const id = await io.ask(label);
      if (id !== "") return { id };
    }
  }
  out(`\n${label}:\n`);
  listed.slice(0, MODEL_LIST_LIMIT).forEach((model, index) => {
    out(`  ${index + 1}) ${model.id}${model.name && model.name !== model.id ? ` - ${model.name}` : ""}\n`);
  });
  if (listed.length > MODEL_LIST_LIMIT) {
    out(`  ... and ${listed.length - MODEL_LIST_LIMIT} more; type an exact model ID to pick one of them.\n`);
  }
  for (;;) {
    const answer = await io.ask("Model number or ID", fallback?.id);
    const index = Number(answer);
    const picked = Number.isInteger(index) && index >= 1 && index <= Math.min(listed.length, MODEL_LIST_LIMIT)
      ? listed[index - 1]
      : listed.find((model) => model.id === answer);
    if (picked !== undefined) return { id: picked.id, model: picked };
    out("Choose a listed number or an exact model ID.\n");
  }
}

function preset(provider: string, choice: Choice, wanted: ModelThinkingLevel): Record<string, string> {
  if (choice.model === undefined) return { provider, modelId: choice.id };
  const level = clampThinkingLevel(choice.model, wanted);
  return getSupportedThinkingLevels(choice.model).includes(level)
    ? { provider, modelId: choice.id, thinkingLevel: level }
    : { provider, modelId: choice.id };
}

/** Write every starter file whose path is free; returns the relative paths created now. */
async function writeStarterFiles(workspace: string, basics: TemplateBasics): Promise<Set<string>> {
  const created = new Set<string>();
  const files: Array<[string, string]> = [
    ["AGENTS.md", starterAgentsMd(basics)],
    ["SOUL.md", starterSoulMd(basics)],
    ["USER.md", starterUserMd(basics)],
    ["memory/MEMORY.md", starterMemoryMd()],
  ];
  for (const [relative, body] of files) {
    if (await writeNew(join(workspace, relative), body)) created.add(relative);
  }
  return created;
}

async function writeOnboarding(workspace: string, basics: TemplateBasics): Promise<void> {
  await writeNew(join(workspace, ONBOARDING_FILE), onboardingMd(basics));
}

/** Replace only the starter files this run created; an owner's pre-existing file is kept. */
async function savePersonalized(workspace: string, created: ReadonlySet<string>, profile: Profile): Promise<string[]> {
  const kept: string[] = [];
  for (const [relative, body] of [
    ["USER.md", profile.userMd],
    ["SOUL.md", profile.soulMd],
    ["memory/MEMORY.md", profile.memoryMd],
  ] as const) {
    if (!created.has(relative)) {
      kept.push(relative);
      continue;
    }
    const path = join(workspace, relative);
    await rm(path, { force: true });
    await writeNew(path, body.endsWith("\n") ? body : `${body}\n`);
  }
  return kept;
}

function summary(name: string, body: string): string {
  const preview = body.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
    .slice(0, 3)
    .map((line) => `      ${line.length > 96 ? `${line.slice(0, 95)}…` : line}`);
  return `  ${name} (${body.length} chars)\n${preview.join("\n")}${preview.length > 0 ? "\n" : ""}`;
}

export interface Profile {
  readonly userMd: string;
  readonly soulMd: string;
  readonly memoryMd: string;
}

const PROFILE_BLOCK = new RegExp("```" + PROFILE_FENCE + "[^\\n]*\\n([\\s\\S]*?)```");

/** The fenced profile in a model reply, or undefined when absent or malformed. */
export function parseProfile(text: string): Profile | undefined {
  const match = PROFILE_BLOCK.exec(text);
  if (match === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const fields = [record.userMd, record.soulMd, record.memoryMd];
  if (!fields.every((value): value is string =>
    typeof value === "string" && value.trim() !== "" && Buffer.byteLength(value, "utf8") <= PROFILE_FILE_MAX_BYTES)) {
    return undefined;
  }
  return { userMd: fields[0] as string, soulMd: fields[1] as string, memoryMd: fields[2] as string };
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * The bounded terminal interview. Returns the profile, or undefined when the owner skipped or the
 * model never produced a usable block. Model or network failures reject; the caller falls back.
 */
async function interview(
  models: Models,
  model: Choice,
  basics: TemplateBasics,
  io: Asker,
  out: (text: string) => void,
  signal: AbortSignal | undefined,
): Promise<Profile | undefined> {
  if (model.model === undefined) throw new Error("the selected model is not in the offline catalog");
  const selected = model.model;
  const systemPrompt = interviewSystemPrompt(basics, INTERVIEW_MAX_TURNS);
  const messages: Message[] = [{ role: "user", content: INTERVIEW_OPENING, timestamp: Date.now() }];
  out("Type /done to wrap up or /skip to finish later in your first chat.\n\n");
  for (let replies = 0; ; replies += 1) {
    const response = await models.completeSimple(selected, { systemPrompt, messages }, {
      maxTokens: Math.min(16_384, selected.maxTokens),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("interview model request failed");
    }
    messages.push(response);
    const text = replyText(response);
    const profile = parseProfile(text);
    const visible = text.replace(PROFILE_BLOCK, "").trim();
    if (visible !== "") out(`${basics.name}: ${visible}\n\n`);
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
