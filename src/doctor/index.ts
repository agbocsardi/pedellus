/**
 * `pedellus doctor`: a read-only setup and health check.
 *
 * It never creates a file or directory, never opens SQLite, never makes a network or model call and
 * never prints a secret value, credential content or raw exception text. Credentials are reported by
 * source name only; configuration errors are mapped to trusted field-level summaries without
 * echoing arbitrary keys or configured path values. The only socket it touches is a connect-and-close
 * probe of the local gateway socket.
 */
import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthCheck, Credential, CredentialInfo, CredentialStore, Models } from "@earendil-works/pi-ai";
import { authStorePath } from "../auth/store.js";
import { defaultConfigPath, parseConfig, type PortConfig } from "../config.js";
import { loadWorkspaceContextSnapshot, WorkspaceContextFileError, WorkspaceContextInputError, WorkspaceContextPlatformError } from "../context/workspace.js";
import { probeSocket, type SocketProbeState } from "../local/server.js";
import { createAuthModels, nativeProviderId } from "../providers.js";
import { startupDiagnostic } from "../startup-diagnostics.js";
import { canonicalFuturePath, inside, ownerPrivateDirectoryReason } from "../store.js";

export interface DoctorOptions {
  /** Explicit `--config`; absent checks the default primary file. */
  readonly configPath?: string;
  readonly output: { write(text: string): unknown };
  /** Test seams; each defaults to the real process or host. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  readonly isWsl?: boolean;
  readonly systemdActive?: boolean;
  /** Socket probe seam; returns a `SocketProbeState` or boolean (`true` = listening). */
  readonly socketProbe?: (path: string) => Promise<SocketProbeState | boolean>;
}

type Status = "ok" | "warn" | "fail";

const PREFIX: Readonly<Record<Status, string>> = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]" };
const MIN_NODE = [22, 19, 0] as const;
const SOCKET_PATH_LIMIT = 100;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md"] as const;
const ONBOARDING_FILE = "memory/system/onboarding.md";
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-zA-Z](?:\/|$)/;

class Report {
  readonly counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0 };
  #first = true;
  constructor(private readonly output: DoctorOptions["output"]) {}

  section(title: string): void {
    this.output.write(`${this.#first ? "" : "\n"}${title}\n`);
    this.#first = false;
  }

  check(status: Status, label: string, detail: string): void {
    this.counts[status] += 1;
    this.output.write(`${PREFIX[status]} ${label}: ${detail}\n`);
  }

  note(text: string): void {
    this.output.write(`       ${text}\n`);
  }
}

export async function runDoctor(options: DoctorOptions): Promise<{ readonly ok: boolean }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const report = new Report(options.output);

  report.section("Runtime and platform");
  const version = options.nodeVersion ?? process.version;
  report.check(nodeSupported(version) ? "ok" : "fail", "Node.js",
    nodeSupported(version) ? version : `${version}; Pedellus requires >= ${MIN_NODE.join(".")}`);
  if (platform === "linux") {
    report.check("ok", "platform", "linux");
    const fd = await exists("/proc/self/fd");
    report.check(fd ? "ok" : "fail", "/proc/self/fd", fd ? "available" : "unavailable; mount /proc for descriptor checks");
  } else {
    report.check("fail", "platform", `${platform}; Pedellus supports Linux only (on Windows, use WSL2)`);
  }

  report.section("Configuration");
  const loaded = await checkConfig(report, options.configPath);

  const wsl = options.isWsl ?? await detectWsl();
  if (wsl) {
    report.section("WSL2");
    const systemd = options.systemdActive ?? await detectSystemd();
    report.check(systemd ? "ok" : "warn", "systemd", systemd
      ? "PID 1 is systemd"
      : "PID 1 is not systemd; set systemd=true under [boot] in /etc/wsl.conf for background services");
    const paths: [string, string][] = [];
    if (loaded.path !== undefined) paths.push(["config", await canonicalOrSelf(loaded.path)]);
    if (loaded.config !== undefined) {
      paths.push(["workspace", await canonicalOrSelf(loaded.config.workspace)]);
      paths.push(["dataDir", await canonicalOrSelf(loaded.config.dataDir)]);
    }
    const drvfs = paths.filter(([, path]) => WINDOWS_DRIVE_MOUNT.test(path));
    for (const [label] of drvfs) {
      report.check("warn", label, "configured path resolves under a Windows drive (/mnt/<drive>); DrvFs can break " +
        "chmod 0700, Unix sockets, O_NOFOLLOW and SQLite WAL. Use ~/.pedellus on the Linux (ext4) filesystem");
    }
    if (paths.length > 0 && drvfs.length === 0) report.check("ok", "filesystem", "configured paths are on the Linux filesystem");
  }

  const config = loaded.config;
  if (config === undefined) {
    report.section("Remaining checks");
    report.note("Skipped: directories, credentials, channels and gateway need a valid configuration.");
  } else {
    report.section("Directories and workspace");
    const dirs = await checkDirectories(report, config, platform);
    report.section("Provider credentials");
    await checkCredentials(report, config, dirs, env);
    report.section("Channels and web");
    await checkChannels(report, config, env);
    report.section("Gateway");
    await checkGateway(report, dirs.socketDir, options.socketProbe ?? probeSocket);
  }

  const { ok, warn, fail } = report.counts;
  options.output.write(`\n${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${fail} failure${fail === 1 ? "" : "s"}\n`);
  return { ok: fail === 0 };
}

function nodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_NODE.length; index++) {
    if (parts[index]! !== MIN_NODE[index]) return parts[index]! > MIN_NODE[index]!;
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

async function detectWsl(): Promise<boolean> {
  try { return /microsoft|wsl/i.test(await readFile("/proc/version", "utf8")); }
  catch { return false; }
}

async function detectSystemd(): Promise<boolean> {
  try { return (await readFile("/proc/1/comm", "utf8")).trim() === "systemd"; }
  catch { return false; }
}

async function canonicalOrSelf(path: string): Promise<string> {
  try { return await canonicalFuturePath(path); }
  catch { return resolve(path); }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : undefined;
}

/**
 * Nonblocking, strictly bounded regular-file read so a FIFO, device or growing file cannot hang or
 * exceed `maxBytes`.
 */
async function readRegularFileBounded(path: string, options: { noFollow?: boolean; maxBytes?: number } = {}): Promise<string> {
  const flags = constants.O_RDONLY
    | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0)
    | (options.noFollow === true && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error("not a regular file") as NodeJS.ErrnoException;
      error.code = "EINVAL";
      throw error;
    }
    const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
    if (info.size > maxBytes) {
      const error = new Error("file exceeds size bound") as NodeJS.ErrnoException;
      error.code = "EFBIG";
      throw error;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        const error = new Error("file exceeds size bound") as NodeJS.ErrnoException;
        error.code = "EFBIG";
        throw error;
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Strict allowlist of trusted static configuration field names; never echoes dynamic keys. */
const TRUSTED_CONFIG_FIELDS = new Set([
  "workspace", "dataDir", "extraAllowedDirs", "model", "allowedModels", "modelPresets", "modelPreset",
  "classifierModel", "toolAllowlist", "toolSandbox", "bwrapPath", "toolTimeoutSeconds", "followUpMode",
  "restrictToWorkspace", "thinkingLevel",
  "workspaceContext", "workspaceContext.memoryFiles", "workspaceContext.memoryManifest", "workspaceContext.skills",
  "workspaceContext.skills.builtinSkillsRoot", "workspaceContext.skills.disabledSkills",
  "cron", "cron.enabled", "cron.timeZone", "episodeSummary", "episodeSummary.enabled", "episodeSummary.preset",
  "episodeSummary.model", "workers", "workers.enabled", "workers.maxConcurrent", "workers.preset", "workers.toolAllowlist",
  "digest", "digest.preset", "digest.model", "digest.episodesPerRun", "digest.entriesPerBatch", "digest.charsPerBatch",
  "digest.maxToolCalls", "digest.maxRequests", "digest.maxInputTokens", "digest.runTimeoutSeconds",
  "digest.maxChangedFiles", "digest.maxDiffChars", "credentials", "providers",
  "telegram", "telegram.tokenEnv", "telegram.allowFrom", "telegram.pollTimeoutSeconds",
  "discord", "discord.tokenEnv", "discord.allowFrom", "discord.dmAllowFrom", "discord.allowChannels",
  "discord.groupPolicy", "discord.streaming", "discord.receipts", "discord.receipts.read",
  "discord.receipts.working", "discord.receipts.delayMs",
  "app", "app.port", "app.staticRoot", "app.autoArchiveDays", "app.agentName",
  "app.push", "app.push.subject", "app.push.publicKey", "app.push.privateKeyEnv",
  "media", "media.directory", "media.transcription", "media.transcription.enabled", "media.transcription.language",
  "media.transcription.maxDurationSeconds", "media.transcription.timeoutMs", "media.transcription.backend",
  "media.transcription.whisperCli", "media.transcription.hex",
  "web", "web.search", "web.search.keyEnv", "web.fetch",
  "mcp", "mcp.enabled", "mcp.servers", "codemode", "codemode.enabled",
  "idleRollover", "idleRollover.afterMinutes", "visionHandoff", "visionHandoff.describerPreset",
  "visionHandoff.maxRawImages", "visionHandoff.maxDescriptionTokens", "visionHandoff.prompt",
]);

/** Sections that hold dynamic owner-chosen keys (never echoed in diagnostics). */
const DYNAMIC_KEY_SECTIONS = ["providers", "credentials", "modelPresets", "mcp.servers"] as const;

/** Sections that use `rejectUnknownKeys(...)`. */
const STRICT_OPTION_SECTIONS = [
  "app.push", "app", "discord.receipts", "discord", "workspaceContext.skills", "workspaceContext",
  "media.transcription.whisperCli", "media.transcription.hex", "media.transcription", "media",
  "web.search", "web", "mcp", "codemode", "idleRollover", "visionHandoff", "cron", "workers", "digest",
  "episodeSummary", "telegram",
] as const;

/**
 * Trusted field-level configuration diagnostic. Only emits names from `TRUSTED_CONFIG_FIELDS` or
 * `STRICT_OPTION_SECTIONS` / `DYNAMIC_KEY_SECTIONS`; arbitrary user keys (dotted or undotted) and
 * configured values are never echoed.
 */
export function safeConfigMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() : "";
  if (raw === "") return "invalid configuration (details suppressed)";

  // 1. Unknown option in any strict section (handles dotted arbitrary keys too).
  if (raw.endsWith(" is not a recognized option")) {
    for (const section of [...STRICT_OPTION_SECTIONS, ...DYNAMIC_KEY_SECTIONS]) {
      if (raw.startsWith(`${section}.`)) return `${section} contains an unrecognized option`;
    }
    // Top-level (`config.<key>`) and anything else: the key itself is never echoed.
    return "configuration contains an unrecognized option";
  }

  // 2. Dynamic-key sections (`providers.<key>...`, `credentials.<key>...`, etc.): never echo `<key>`.
  for (const section of DYNAMIC_KEY_SECTIONS) {
    if (raw.startsWith(`${section}.`) || raw.startsWith(`${section}[`)) {
      return `${section} contains an invalid entry`;
    }
  }

  // 3. Exact trusted static field followed by a safe static constraint phrase (no quotes or paths).
  const fieldMatch = /^([a-zA-Z][a-zA-Z0-9_.]*) ((?:must be|is required|is invalid|cannot be|requires) [a-zA-Z0-9 ,._():+-]+|is required|is invalid)$/.exec(raw);
  if (fieldMatch !== null && TRUSTED_CONFIG_FIELDS.has(fieldMatch[1]!) && fieldMatch[0].length <= 140) {
    return fieldMatch[0];
  }

  // 4. Known fixed top-level parseConfig sentences.
  if (/^(configuration|config) must be a JSON object$/i.test(raw)) return "configuration must be a JSON object";
  return "invalid configuration; check required fields and documented formats (details suppressed)";
}

interface LoadedConfig {
  readonly path?: string;
  readonly config?: PortConfig;
}

async function checkConfig(report: Report, explicit: string | undefined): Promise<LoadedConfig> {
  let path: string;
  try {
    path = explicit === undefined ? defaultConfigPath() : resolve(explicit);
  } catch {
    report.check("fail", "config file", "cannot resolve the home directory for ~/.pedellus/config.json");
    return {};
  }
  const labelPath = explicit === undefined ? "~/.pedellus/config.json" : "configured file";
  let text: string;
  try {
    text = await readRegularFileBounded(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      report.check("fail", "config file", `not found (${labelPath})`);
      if (explicit === undefined) report.note("Run `pedellus init` to set up Pedellus.");
    } else {
      report.check("fail", "config file", `cannot read ${labelPath}${code === undefined ? "" : ` (${code})`}`);
    }
    return { path };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse messages quote file content, so only the fact is reported.
    report.check("fail", "config file", `${labelPath} is not valid JSON (details suppressed)`);
    return { path };
  }
  try {
    const config = { ...parseConfig(value, dirname(path)), configFile: path };
    report.check("ok", "config file", labelPath);
    return { path, config };
  } catch (error) {
    report.check("fail", "config file", `${labelPath} is invalid: ${safeConfigMessage(error)}`);
    return { path };
  }
}

/** Existing canonical directory, or a fixed failure reason. Never creates anything. */
async function existingDirectory(path: string): Promise<{ readonly path: string } | { readonly reason: string }> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) return { reason: "is not a directory" };
    return { path: canonical };
  } catch (error) {
    return { reason: errorCode(error) === "ENOENT" ? "does not exist" : `cannot be read (${errorCode(error) ?? "error"})` };
  }
}

interface DirectoryCheckResult {
  /** Validated canonical dataDir if it exists on disk and is disjoint from workspace roots. */
  readonly existingDataDir?: string;
  /** True when dataDir is disjoint and valid (even if not created yet). */
  readonly dataDirValid: boolean;
  /**
   * Canonical dataDir usable for a gateway socket probe. Requires the full read-only validation
   * the CLI's socket lookup performs — configured roots included — so an endpoint a client
   * command would refuse (a bad root, a non-private dataDir) is never probed.
   */
  readonly socketDir?: string;
}

/** Validate workspace, extraAllowedDirs, dataDir and workspaceContext without writing anything. */
async function checkDirectories(
  report: Report,
  config: PortConfig,
  platform: NodeJS.Platform,
): Promise<DirectoryCheckResult> {
  const workspace = await existingDirectory(config.workspace);
  let allRootsValid = true;
  const roots: string[] = [];
  if ("path" in workspace) {
    report.check("ok", "workspace", "exists and is a directory");
    roots.push(workspace.path);
  } else {
    report.check("fail", "workspace", `configured workspace ${workspace.reason}`);
    allRootsValid = false;
    roots.push(await canonicalOrSelf(config.workspace));
  }
  for (let index = 0; index < (config.extraAllowedDirs ?? []).length; index += 1) {
    const rawExtra = config.extraAllowedDirs![index]!;
    const root = await existingDirectory(rawExtra);
    if ("path" in root) {
      roots.push(root.path);
    } else {
      report.check("fail", `extraAllowedDirs[${index}]`, `configured directory ${root.reason}`);
      allRootsValid = false;
      roots.push(await canonicalOrSelf(rawExtra));
    }
  }

  let dataDir: string;
  try {
    dataDir = await canonicalFuturePath(config.dataDir);
  } catch (error) {
    report.check("fail", "dataDir", `configured dataDir cannot be resolved (${errorCode(error) ?? "error"})`);
    return { dataDirValid: false };
  }

  let existingDataDir: string | undefined;
  let dataDirValid = false;
  if (roots.some((root) => inside(dataDir, root) || inside(root, dataDir))) {
    report.check("fail", "dataDir", "configured dataDir must be disjoint from workspace and extraAllowedDirs");
  } else {
    try {
      const entry = await lstat(dataDir);
      if (!entry.isDirectory()) {
        report.check("fail", "dataDir", "configured dataDir is not a directory");
      } else {
        // The same owner-private contract the CLI's read-only socket lookup enforces, so doctor
        // never probes an endpoint a client command would refuse; the gateway itself installs the
        // mode, but an existing shared directory is reported, not used or repaired.
        const privateReason = ownerPrivateDirectoryReason(entry);
        if (privateReason === undefined) {
          report.check("ok", "dataDir", "exists, is owner-private and is disjoint from workspace");
          existingDataDir = dataDir;
          dataDirValid = allRootsValid;
        } else {
          report.check("fail", "dataDir", `configured dataDir ${privateReason}`);
          report.note("Client commands refuse a shared dataDir; fix the mode to 0700 (owner-only) before attaching.");
        }
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        report.check("ok", "dataDir", "valid path (will be created owner-private at first gateway start)");
        dataDirValid = allRootsValid;
      } else {
        report.check("fail", "dataDir", `configured dataDir cannot be read (${errorCode(error) ?? "error"})`);
      }
    }
  }

  const socketBytes = Buffer.byteLength(resolve(dataDir, "gateway.sock"), "utf8");
  report.check(socketBytes <= SOCKET_PATH_LIMIT ? "ok" : "fail", "socket path", socketBytes <= SOCKET_PATH_LIMIT
    ? `${socketBytes} bytes`
    : `${socketBytes} bytes exceeds the ${SOCKET_PATH_LIMIT}-byte Unix socket limit; choose a shorter dataDir`);

  if (config.workspaceContext === undefined) {
    report.check("ok", "workspaceContext", "not configured; no workspace files are loaded");
  } else if ("path" in workspace) {
    await checkWorkspaceFiles(report, config.workspace, workspace.path, config.workspaceContext.memoryFiles, platform);
  }
  return {
    ...(existingDataDir === undefined ? {} : { existingDataDir }),
    dataDirValid,
    ...(existingDataDir !== undefined && dataDirValid && socketBytes <= SOCKET_PATH_LIMIT
      ? { socketDir: existingDataDir }
      : {}),
  };
}

async function regularFile(path: string): Promise<"file" | "missing" | "other"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "other";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "other";
  }
}

async function checkWorkspaceFiles(
  report: Report,
  configuredWorkspace: string,
  canonicalWorkspace: string,
  memoryFiles: readonly string[],
  platform: NodeJS.Platform,
): Promise<void> {
  // Run the actual read-only workspace context loader on Linux so doctor matches gateway startup
  // (catches symlinked workspace roots, symlinked memory/ dirs, hardlinks, unreadable files).
  if (platform === "linux" && process.platform === "linux") {
    try {
      await loadWorkspaceContextSnapshot({
        workspaceRoot: resolve(configuredWorkspace),
        memoryFiles,
      });
      report.check("ok", "workspaceContext", "snapshot loader verified bootstrap and memory files");
    } catch (error) {
      if (error instanceof WorkspaceContextFileError) {
        const label = error.source.replace(/^workspace:/, "");
        const reason = error.kind === "missing"
          ? "missing; startup fails closed on a configured memoryFiles entry"
          : `refused by context loader (${error.kind}); startup fails closed`;
        report.check("fail", label, reason);
      } else if (error instanceof WorkspaceContextInputError || error instanceof WorkspaceContextPlatformError) {
        report.check("fail", "workspaceContext", error.message);
      } else {
        report.check("fail", "workspaceContext", "context snapshot check failed; startup fails closed");
      }
      return;
    }
  } else {
    for (const name of memoryFiles) {
      const kind = await regularFile(join(canonicalWorkspace, name));
      if (kind === "file") report.check("ok", name, "present");
      else if (kind === "missing") report.check("fail", name, "missing; startup fails closed on a configured memoryFiles entry");
      else report.check("fail", name, "not a readable regular file; startup refuses it");
    }
  }

  for (const name of BOOTSTRAP_FILES) {
    const kind = await regularFile(join(canonicalWorkspace, name));
    if (kind === "file") report.check("ok", name, "present");
    else if (kind === "missing") report.check("warn", name, "missing; it is omitted from context");
    else report.check("fail", name, "not a readable regular file; startup refuses it");
  }
  for (const name of memoryFiles) {
    report.check("ok", name, "present");
  }
  try {
    const text = await readRegularFileBounded(join(canonicalWorkspace, ONBOARDING_FILE), { noFollow: true, maxBytes: 64 * 1024 });
    if (text.trim() !== "") {
      report.check("ok", "onboarding", `first-chat onboarding pending (${ONBOARDING_FILE})`);
    }
  } catch {
    // Absent or unreadable: nothing pending to report.
  }
}

/** Parse an already-read bounded credentials.json snapshot into a read-only in-memory store. */
function parseReadOnlyCredentialStore(text: string): CredentialStore {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid store");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.credentials !== "object" || record.credentials === null || Array.isArray(record.credentials)) {
    throw new Error("invalid store");
  }
  const entries = new Map<string, Credential>();
  for (const [providerId, value] of Object.entries(record.credentials as Record<string, unknown>)) {
    if (providerId.length === 0 || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid entry");
    const entry = value as Record<string, unknown>;
    if (entry.type !== "api_key" && entry.type !== "oauth") throw new Error("invalid entry");
    entries.set(providerId, value as Credential);
  }
  return {
    async read(providerId) { return entries.get(providerId); },
    async modify() { throw new Error("read-only credential store"); },
    async delete() { throw new Error("read-only credential store"); },
    async list(): Promise<readonly CredentialInfo[]> {
      return [...entries.entries()].map(([providerId, cred]) => ({ providerId, type: cred.type }));
    },
  };
}

/** Every provider spelling referenced by model selection, presets, classifier or credentials. */
function referencedProviders(config: PortConfig): readonly { readonly spelling: string; readonly id: string; readonly kind: "native" | "custom" | "unknown"; readonly authRequired: boolean }[] {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  const custom = new Set(Object.keys(config.providers ?? {}));
  const modelSpellings = new Set([
    ...(config.allowedModels ?? [config.model]).map((model) => model.provider),
    ...Object.values(config.modelPresets ?? {}).map((preset) => preset.provider),
    ...(config.classifierModel === undefined ? [] : [config.classifierModel.provider]),
  ]);
  const allSpellings = [...modelSpellings, ...Object.keys(config.credentials ?? {})];
  const seen = new Map<string, { readonly spelling: string; readonly id: string; readonly kind: "native" | "custom" | "unknown"; readonly authRequired: boolean }>();
  for (const spelling of allSpellings) {
    const id = nativeProviderId(spelling);
    const kind = builtin.has(id) ? "native" : custom.has(spelling) ? "custom" : "unknown";
    const key = kind === "custom" ? spelling : id;
    const authRequired = modelSpellings.has(spelling);
    const existing = seen.get(key);
    if (existing !== undefined) {
      if (!existing.authRequired && authRequired) seen.set(key, { ...existing, authRequired: true });
      continue;
    }
    seen.set(key, { spelling, id: key, kind, authRequired });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function configuredEnvName(config: PortConfig, providerId: string): string | undefined {
  return Object.entries(config.credentials ?? {}).find(([spelling]) => nativeProviderId(spelling) === providerId || spelling === providerId)?.[1];
}

/**
 * An environment variable name safe to echo; a configured but unprintable reference stays unnamed.
 * Env names are syntax-validated by `parseConfig` and name a shell variable, not a provider key.
 */
function echoableEnvName(name: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

function describeAuth(auth: AuthCheck, configuredEnv: string | undefined): string {
  if (auth.type === "oauth") return "stored credential (OAuth)";
  const source = auth.source ?? "";
  if (source === "stored credential" || source === "keyless") return source;
  if (source.startsWith("credentials.")) {
    // A credential-store reference is echoed only through its already-validated env mapping.
    return configuredEnv !== undefined ? `env (${configuredEnv})` : "stored credential reference";
  }
  // No raw auth source is ever echoed, even an environment-variable name: it may be derived from
  // an owner-chosen spelling, and the check has already succeeded, so the safe summary is that a
  // credential resolved without naming where it came from.
  return "available (environment credential)";
}

async function checkCredentials(
  report: Report,
  config: PortConfig,
  dirs: DirectoryCheckResult,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const providers = referencedProviders(config);
  // Only native Pi AI provider IDs are independently trusted identifiers and may print verbatim.
  // Every config-derived spelling — a custom providers ID or an unknown credentials/model key —
  // is replaced by a stable ordinal (sorted reference order), even when it is short, printable
  // and syntax-valid, so no configuration text reaches the report as an identifier.
  let untrustedOrdinal = 0;
  const labeled = providers.map((entry) => ({
    entry,
    trusted: entry.kind === "native",
    label: entry.kind === "native" ? entry.id : `provider ${++untrustedOrdinal}`,
  }));
  const unknown = labeled.filter((item) => item.entry.kind === "unknown");
  for (const item of unknown) {
    report.check("fail", item.label, "unknown provider (not a native Pi AI provider or custom providers entry)");
  }
  if (unknown.length > 0) {
    report.note("Provider ordinals follow the sorted references in the configuration; the spellings themselves are never echoed.");
  }
  const known = labeled.filter((item) => item.entry.kind !== "unknown" && item.entry.authRequired);
  if (known.length === 0) {
    if (unknown.length === 0) report.check("ok", "providers", "no providers referenced");
    return;
  }

  let store: CredentialStore | undefined;
  if (!dirs.dataDirValid) {
    report.check("warn", "credential store", "skipped because workspace or dataDir is invalid");
  } else if (dirs.existingDataDir !== undefined) {
    const credPath = authStorePath(dirs.existingDataDir);
    try {
      const text = await readRegularFileBounded(credPath, { noFollow: true, maxBytes: 1024 * 1024 });
      store = parseReadOnlyCredentialStore(text);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        report.check("fail", "credential store", "unreadable or invalid credential store; run `pedellus login <provider>` to replace it");
      }
    }
  }

  let models: Models;
  try {
    models = createAuthModels(config, env, store);
  } catch (error) {
    report.check("fail", "provider configuration", startupDiagnostic(error).replace(/^pedellus: /, ""));
    return;
  }
  for (const item of known) {
    const { entry, trusted, label } = item;
    const id = entry.id;
    const configuredEnv = echoableEnvName(configuredEnvName(config, id) ?? "");
    // A trusted id names itself in the login hint; an untrusted spelling never does, so the
    // hint points at the configuration instead of echoing the configured key or ID.
    const loginHint = trusted ? `run \`pedellus login ${label}\`` : "run `pedellus login` with the provider spelling from the configuration";
    let auth: AuthCheck | undefined;
    try {
      auth = await models.checkAuth(id);
    } catch {
      report.check("fail", label, configuredEnv === undefined
        ? `credential check failed (details suppressed); ${loginHint}`
        : `missing — ${configuredEnv} is not set; set it or ${loginHint}`);
      continue;
    }
    if (auth === undefined) report.check("fail", label, `missing — ${loginHint}`);
    else report.check("ok", label, describeAuth(auth, configuredEnv));
  }
}

async function checkAppIndex(staticRoot: string): Promise<boolean> {
  try {
    const rootReal = await realpath(staticRoot);
    const indexReal = await realpath(join(staticRoot, "index.html"));
    if (indexReal !== rootReal && !indexReal.startsWith(`${rootReal}${sep}`)) return false;
    return (await stat(indexReal)).isFile();
  } catch {
    return false;
  }
}

async function checkChannels(report: Report, config: PortConfig, env: NodeJS.ProcessEnv): Promise<void> {
  const secretsFile = config.configFile === undefined
    ? false
    : await regularFile(join(dirname(config.configFile), "secrets.env")) === "file";
  const envCheck = (label: string, name: string, missing: Status, effect: string): void => {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof value === "string" && value.trim() !== "") {
      report.check("ok", label, `env (${name}) is set`);
    } else if (secretsFile) {
      report.check("warn", label, `${name} is not set in this shell; the service EnvironmentFile beside the config may supply it`);
    } else {
      report.check(missing, label, `${name} is not set; ${effect}`);
    }
  };
  let any = false;
  if (config.telegram !== undefined) {
    any = true;
    envCheck("telegram", config.telegram.tokenEnv, "fail", "the Telegram channel cannot start");
  }
  if (config.discord !== undefined) {
    any = true;
    envCheck("discord", config.discord.tokenEnv, "fail", "the Discord channel cannot start");
  }
  if (config.app !== undefined) {
    any = true;
    if (await checkAppIndex(config.app.staticRoot)) {
      report.check("ok", "app", "static root contains index.html");
    } else {
      report.check("fail", "app", "configured app.staticRoot is missing index.html");
      report.note("Build the app with `npm run install:pwa && npm run build:pwa`.");
    }
    if (config.app.push !== undefined) envCheck("app push", config.app.push.privateKeyEnv, "warn", "Web Push stays off");
  }
  if (config.web?.search !== undefined) {
    any = true;
    envCheck("web search", config.web.search.keyEnv, "fail", "web search cannot authenticate");
  }
  if (!any) report.check("ok", "channels", "no optional channels or web search configured");
}

async function checkGateway(
  report: Report,
  socketDir: string | undefined,
  probe: (path: string) => Promise<SocketProbeState | boolean>,
): Promise<void> {
  const notRunning = "not running (start with `pedellus gateway`)";
  if (socketDir === undefined) {
    report.check("warn", "gateway", notRunning);
    return;
  }
  const socket = resolve(socketDir, "gateway.sock");
  let state: SocketProbeState = "closed";
  try {
    if ((await lstat(socket)).isSocket()) {
      const result = await probe(socket);
      state = typeof result === "boolean" ? (result ? "listening" : "closed") : result;
    }
  } catch {
    state = "closed";
  }
  if (state === "listening") {
    report.check("ok", "gateway", "listening on local socket");
  } else if (state === "timeout") {
    report.check("warn", "gateway", "local socket timed out (unresponsive listener)");
  } else {
    report.check("warn", "gateway", notRunning);
  }
}
