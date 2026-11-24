/**
 * `pedellus doctor`: a read-only setup and health check.
 *
 * It never creates a file or directory, never opens SQLite, never makes a network or model call and
 * never prints a secret value, credential content or raw exception text. Credentials are reported by
 * source name only; configuration errors are reduced to `parseConfig`'s field-level message, bounded
 * and with token-like runs redacted. The only socket it touches is a connect-and-close probe of the
 * local gateway socket.
 */
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AuthCheck, Models } from "@earendil-works/pi-ai";
import { authStorePath, FileCredentialStore } from "../auth/store.js";
import { defaultConfigPath, parseConfig, type PortConfig } from "../config.js";
import { socketIsLive } from "../local/server.js";
import { createAuthModels, nativeProviderId } from "../providers.js";
import { startupDiagnostic } from "../startup-diagnostics.js";
import { canonicalFuturePath, inside } from "../store.js";

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
  /** True when some process answers on this Unix socket path. */
  readonly socketProbe?: (path: string) => Promise<boolean>;
}

type Status = "ok" | "warn" | "fail";

const PREFIX: Readonly<Record<Status, string>> = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]" };
const MIN_NODE = [22, 19, 0] as const;
const SOCKET_PATH_LIMIT = 100;
const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md"] as const;
const ONBOARDING_FILE = "memory/system/onboarding.md";

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
    if (loaded.path !== undefined) paths.push(["config", loaded.path]);
    if (loaded.config !== undefined) {
      paths.push(["workspace", await canonicalOrSelf(loaded.config.workspace)]);
      paths.push(["dataDir", await canonicalOrSelf(loaded.config.dataDir)]);
    }
    const drvfs = paths.filter(([, path]) => path === "/mnt" || path.startsWith("/mnt/"));
    for (const [label, path] of drvfs) {
      report.check("warn", label, `${path} is on a Windows drive; DrvFs breaks chmod 0700, Unix sockets, ` +
        "O_NOFOLLOW and SQLite WAL. Use ~/.pedellus on the Linux (ext4) filesystem");
    }
    if (paths.length > 0 && drvfs.length === 0) report.check("ok", "filesystem", "configured paths are on the Linux filesystem");
  }

  const config = loaded.config;
  if (config === undefined) {
    report.section("Remaining checks");
    report.note("Skipped: directories, credentials, channels and gateway need a valid configuration.");
  } else {
    report.section("Directories and workspace");
    const dataDir = await checkDirectories(report, config);
    report.section("Provider credentials");
    await checkCredentials(report, config, dataDir, env);
    report.section("Channels and web");
    await checkChannels(report, config, env);
    report.section("Gateway");
    await checkGateway(report, dataDir, options.socketProbe ?? socketIsLive);
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
 * `parseConfig` messages name fields, never values, but a key or enum choice is still owner text:
 * strip control characters, redact token-like runs and bound the length.
 */
export function safeConfigMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[A-Za-z0-9_\-+/=.:]{24,}/g, (run) => (/\d/.test(run) || run.length > 48 ? "[redacted]" : run))
    .trim();
  if (text === "") return "details suppressed";
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
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
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      report.check("fail", "config file", `not found: ${path}`);
      if (explicit === undefined) report.note("Run `pedellus init` to set up Pedellus.");
    } else {
      report.check("fail", "config file", `cannot read ${path}${code === undefined ? "" : ` (${code})`}`);
    }
    return { path };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse messages quote file content, so only the fact is reported.
    report.check("fail", "config file", `${path} is not valid JSON (details suppressed)`);
    return { path };
  }
  try {
    const config = { ...parseConfig(value, dirname(path)), configFile: path };
    report.check("ok", "config file", path);
    return { path, config };
  } catch (error) {
    report.check("fail", "config file", `${path} is invalid: ${safeConfigMessage(error)}`);
    return { path };
  }
}

/** Existing canonical directory, or a fixed failure reason. Never creates anything. */
async function existingDirectory(path: string): Promise<{ readonly path: string } | { readonly reason: string }> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) return { reason: "not a directory" };
    return { path: canonical };
  } catch (error) {
    return { reason: errorCode(error) === "ENOENT" ? "does not exist" : `cannot be read (${errorCode(error) ?? "error"})` };
  }
}

/** Returns the canonical data directory when it exists and is usable for read-only probes. */
async function checkDirectories(report: Report, config: PortConfig): Promise<string | undefined> {
  const workspace = await existingDirectory(config.workspace);
  if ("path" in workspace) report.check("ok", "workspace", workspace.path);
  else report.check("fail", "workspace", `${config.workspace} ${workspace.reason}`);
  const roots = "path" in workspace ? [workspace.path] : [];
  for (const extra of config.extraAllowedDirs ?? []) {
    const root = await existingDirectory(extra);
    if ("path" in root) roots.push(root.path);
    else report.check("fail", "extraAllowedDirs", `${extra} ${root.reason}`);
  }

  let dataDir: string;
  try {
    dataDir = await canonicalFuturePath(config.dataDir);
  } catch (error) {
    report.check("fail", "dataDir", `${config.dataDir} cannot be resolved (${errorCode(error) ?? "error"})`);
    return undefined;
  }
  let usable: string | undefined;
  if (roots.some((root) => inside(dataDir, root) || inside(root, dataDir))) {
    report.check("fail", "dataDir", `${dataDir} must be disjoint from workspace and extraAllowedDirs`);
  } else {
    try {
      const entry = await lstat(dataDir);
      if (entry.isDirectory()) {
        report.check("ok", "dataDir", dataDir);
        usable = dataDir;
      } else {
        report.check("fail", "dataDir", `${dataDir} is not a directory`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") report.check("ok", "dataDir", `${dataDir} (created at first gateway start)`);
      else report.check("fail", "dataDir", `${dataDir} cannot be read (${errorCode(error) ?? "error"})`);
    }
  }
  const socketBytes = Buffer.byteLength(resolve(dataDir, "gateway.sock"), "utf8");
  report.check(socketBytes <= SOCKET_PATH_LIMIT ? "ok" : "fail", "socket path", socketBytes <= SOCKET_PATH_LIMIT
    ? `${socketBytes} bytes`
    : `${socketBytes} bytes exceeds the ${SOCKET_PATH_LIMIT}-byte Unix socket limit; choose a shorter dataDir`);

  if (config.workspaceContext === undefined) {
    report.check("ok", "workspaceContext", "not configured; no workspace files are loaded");
  } else if ("path" in workspace) {
    await checkWorkspaceFiles(report, workspace.path, config.workspaceContext.memoryFiles);
  }
  return socketBytes <= SOCKET_PATH_LIMIT ? usable : undefined;
}

async function regularFile(path: string): Promise<"file" | "missing" | "other"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "other";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "other";
  }
}

async function checkWorkspaceFiles(report: Report, workspace: string, memoryFiles: readonly string[]): Promise<void> {
  for (const name of BOOTSTRAP_FILES) {
    const kind = await regularFile(join(workspace, name));
    if (kind === "file") report.check("ok", name, "present");
    else if (kind === "missing") report.check("warn", name, "missing; it is omitted from context");
    else report.check("fail", name, "not a readable regular file; startup refuses it");
  }
  for (const name of memoryFiles) {
    const kind = await regularFile(join(workspace, name));
    if (kind === "file") report.check("ok", name, "present");
    else if (kind === "missing") report.check("fail", name, "missing; startup fails closed on a configured memoryFiles entry");
    else report.check("fail", name, "not a readable regular file; startup refuses it");
  }
  try {
    const onboarding = join(workspace, ONBOARDING_FILE);
    if ((await lstat(onboarding)).isFile() && (await readFile(onboarding, "utf8")).trim() !== "") {
      report.check("ok", "onboarding", `first-chat onboarding pending (${ONBOARDING_FILE})`);
    }
  } catch {
    // Absent or unreadable: nothing pending to report.
  }
}

/** Native providers referenced by model selection; custom providers have their own keyless/env auth. */
function referencedNativeProviders(config: PortConfig): readonly string[] {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  const spellings = [
    ...(config.allowedModels ?? [config.model]).map((model) => model.provider),
    ...Object.values(config.modelPresets ?? {}).map((preset) => preset.provider),
    ...(config.classifierModel === undefined ? [] : [config.classifierModel.provider]),
  ];
  return [...new Set(spellings.map(nativeProviderId))].filter((id) => builtin.has(id)).sort();
}

function configuredEnvName(config: PortConfig, providerId: string): string | undefined {
  return Object.entries(config.credentials ?? {}).find(([spelling]) => nativeProviderId(spelling) === providerId)?.[1];
}

function describeAuth(auth: AuthCheck, configuredEnv: string | undefined): string {
  if (auth.type === "oauth") return "stored credential (OAuth)";
  const source = auth.source ?? "";
  if (source === "stored credential") return source;
  if (source.startsWith("credentials.") && configuredEnv !== undefined) return `env (${configuredEnv})`;
  if (/^[A-Z][A-Z0-9_]*$/.test(source)) return `env (${source})`;
  return source === "" ? "available" : source;
}

async function checkCredentials(
  report: Report,
  config: PortConfig,
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const providers = referencedNativeProviders(config);
  if (providers.length === 0) {
    report.check("ok", "providers", "no native providers referenced");
    return;
  }
  // Read-only: list() and read() only open the file; they never create the directory or a lock.
  let store: FileCredentialStore | undefined = new FileCredentialStore(authStorePath(dataDir ?? resolve(config.dataDir)));
  try {
    await store.list();
  } catch {
    report.check("fail", "credential store", "unreadable or invalid; run `pedellus login <provider>` to replace it");
    store = undefined;
  }
  let models: Models;
  try {
    models = createAuthModels(config, env, store);
  } catch (error) {
    report.check("fail", "provider configuration", startupDiagnostic(error).replace(/^pedellus: /, ""));
    return;
  }
  for (const id of providers) {
    const configuredEnv = configuredEnvName(config, id);
    let auth: AuthCheck | undefined;
    try {
      auth = await models.checkAuth(id);
    } catch {
      report.check("fail", id, configuredEnv === undefined
        ? `credential check failed (details suppressed); run \`pedellus login ${id}\``
        : `missing — ${configuredEnv} is not set; set it or run \`pedellus login ${id}\``);
      continue;
    }
    if (auth === undefined) report.check("fail", id, `missing — run \`pedellus login ${id}\``);
    else report.check("ok", id, describeAuth(auth, configuredEnv));
  }
}

async function checkChannels(report: Report, config: PortConfig, env: NodeJS.ProcessEnv): Promise<void> {
  const secretsFile = config.configFile === undefined ? false : await exists(join(dirname(config.configFile), "secrets.env"));
  const envCheck = (label: string, name: string, missing: Status, effect: string): void => {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof value === "string" && value.trim() !== "") {
      report.check("ok", label, `env (${name}) is set`);
    } else if (secretsFile) {
      report.check("warn", label, `${name} is not set in this shell; secrets.env beside the config may supply it to the service`);
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
    const index = join(config.app.staticRoot, "index.html");
    if (await regularFile(index) === "file") {
      report.check("ok", "app", `static root ${config.app.staticRoot}`);
    } else {
      report.check("fail", "app", `${index} is missing`);
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
  dataDir: string | undefined,
  probe: (path: string) => Promise<boolean>,
): Promise<void> {
  const notRunning = "not running (start with `pedellus gateway`)";
  if (dataDir === undefined) {
    report.check("warn", "gateway", notRunning);
    return;
  }
  const socket = resolve(dataDir, "gateway.sock");
  let running = false;
  try {
    running = (await lstat(socket)).isSocket() && await probe(socket);
  } catch {
    running = false;
  }
  report.check(running ? "ok" : "warn", "gateway", running ? "running" : notRunning);
}
