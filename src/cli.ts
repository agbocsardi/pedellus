#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import type { AuthType } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { runLogin, runLogout } from "./auth/cli.js";
import { loadConfig, defaultConfigPath } from "./config.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
import { COMMANDS, commandUsage, findCommandHelp, renderCommandHelp, renderOverview, renderUsage } from "./help/cli.js";
import { SAFE_COMMAND_NAME } from "./help/commands.js";
import { connectLocalGateway } from "./local/client.js";
import { gatewaySocketPath, serveLocalGateway } from "./local/server.js";
import { LocalGatewayError } from "./local/protocol.js";
import { createMediaStore } from "./media/attachments.js";
import { LOCAL_ATTACHMENT_DIRECTORY } from "./media/local.js";
import { cancelPreparedContextBlock, listPreparedContextBlocks, PreparedContextRecoveryError } from "./recovery/index.js";
import { replaceProcess, restartPlan, restartSupported, RESTART_FAILURE_DIAGNOSTIC } from "./restart.js";
import { runTerminalConversation } from "./terminal/index.js";
import { openGateway } from "./runtime.js";
import { prepareDataDirectory } from "./store.js";
import { StartupDiagnosticError, startupDiagnostic } from "./startup-diagnostics.js";

/** Every synopsis, the fixed default configuration note and the help hint; never supplied arguments. */
const USAGE = renderUsage();

/** The subcommands this process accepts, excluding the historical bare `--config` attach. */
const SUBCOMMANDS = new Set(COMMANDS.map((command) => command.name));

const CONVERSATION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,30})[a-z0-9]$|^[a-z0-9]$/;

/**
 * Where a launch reads its configuration. `default` resolves the owner's fixed
 * primary file at call time; `path` preserves the explicit `--config` argument
 * and its existing relative-path base exactly.
 */
type ConfigSource =
  | { readonly kind: "default" }
  | { readonly kind: "path"; readonly path: string };

type RecoveryInvocation =
  | { readonly kind: "list"; readonly config: ConfigSource }
  | { readonly kind: "cancel"; readonly config: ConfigSource; readonly taskId: number; readonly fingerprint: string };

type AuthInvocation =
  | {
      readonly kind: "login";
      readonly config: ConfigSource;
      readonly provider?: string;
      readonly auth?: AuthType;
    }
  | { readonly kind: "logout"; readonly config: ConfigSource; readonly provider?: string };

type LaunchInvocation =
  | { readonly kind: "gateway"; readonly config: ConfigSource }
  | { readonly kind: "agent"; readonly config: ConfigSource; readonly conversation?: string };

/** A usage mistake; the CLI prints the fixed usage block, never the supplied arguments. */
class UsageError extends Error {
  override name = "UsageError";
}

/** An unrecognized first argument; the token is echoed only when it is a safe command name. */
class UnknownCommandError extends Error {
  override name = "UnknownCommandError";
  constructor(readonly token: string) {
    super("unknown command");
  }
}

function isHelpFlag(argument: string | undefined): boolean {
  return argument === "--help" || argument === "-h";
}

/**
 * A help request anywhere before dispatch. `--help`/`-h` names the page of the leading subcommand;
 * `help [topic]` names it explicitly. Nothing here reads configuration or runtime state, so a help
 * page prints and exits 0 in a checkout with no setup.
 */
function helpTopic(args: readonly string[]): { readonly topic?: string } | undefined {
  const [first, second] = args;
  if (first === "help") {
    if (args.length === 1) return {};
    if (args.length === 2 && second !== undefined && !isHelpFlag(second)) return { topic: second };
    if (args.some(isHelpFlag)) return {};
    throw new UsageError();
  }
  if (!args.some(isHelpFlag)) return undefined;
  return first !== undefined && SUBCOMMANDS.has(first) ? { topic: first } : {};
}

function writeHelp(topic: string | undefined): void {
  if (topic === undefined) {
    stdout.write(`${renderOverview()}\n`);
    return;
  }
  const command = findCommandHelp(topic);
  if (command === undefined) throw new UnknownCommandError(topic);
  stdout.write(`${renderCommandHelp(command)}\n`);
}

function configPath(args: readonly string[], start: number): ConfigSource {
  if (args.length !== start + 2 || args[start] !== "--config" || !args[start + 1]) throw new UsageError();
  return { kind: "path", path: args[start + 1]! };
}

/**
 * `durable-nanobot --config <path>` remains the historical terminal launch. It now attaches
 * to the running gateway instead of opening a second runtime; no gateway is started
 * implicitly. A subcommand without `--config` uses the fixed primary default; the
 * bare historical form still requires an explicit path.
 */
function launchInvocation(args: readonly string[]): LaunchInvocation {
  if (args[0] === "gateway") {
    return { kind: "gateway", config: args.length === 1 ? { kind: "default" } : configPath(args, 1) };
  }
  if (args[0] === "agent") return agentInvocation(args.slice(1));
  return { kind: "agent", config: configPath(args, 0) };
}

function agentInvocation(args: readonly string[]): LaunchInvocation {
  let config: ConfigSource = { kind: "default" };
  let configSeen = false;
  let conversation: string | undefined;
  for (let index = 0; index < args.length;) {
    const argument = args[index];
    if (argument === "--config" && !configSeen && args[index + 1]) {
      config = { kind: "path", path: args[index + 1]! };
      configSeen = true;
      index += 2;
    } else if (argument === "--conversation" && conversation === undefined && args[index + 1] &&
        CONVERSATION_NAME.test(args[index + 1]!)) {
      conversation = args[index + 1];
      index += 2;
    } else {
      throw new UsageError();
    }
  }
  return { kind: "agent", config, ...(conversation === undefined ? {} : { conversation }) };
}

function recoveryInvocation(args: readonly string[]): RecoveryInvocation | undefined {
  if (args[0] !== "recovery") return undefined;
  let config: ConfigSource = { kind: "default" };
  let configSeen = false;
  let cancel: string | undefined;
  let fingerprint: string | undefined;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length;) {
    const argument = rest[index];
    if (argument === "--config" && !configSeen && rest[index + 1]) {
      config = { kind: "path", path: rest[index + 1]! };
      configSeen = true;
      index += 2;
    } else if (argument === "--cancel" && cancel === undefined && rest[index + 1]) {
      cancel = rest[index + 1];
      index += 2;
    } else if (argument === "--fingerprint" && fingerprint === undefined && rest[index + 1]) {
      fingerprint = rest[index + 1];
      index += 2;
    } else {
      throw new PreparedContextRecoveryError(commandUsage("recovery"));
    }
  }
  if (cancel === undefined && fingerprint === undefined) return { kind: "list", config };
  if (cancel === undefined || fingerprint === undefined) throw new PreparedContextRecoveryError(commandUsage("recovery"));
  const taskId = Number(cancel);
  if (!/^[1-9][0-9]*$/.test(cancel) || !Number.isSafeInteger(taskId) || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new PreparedContextRecoveryError(commandUsage("recovery"));
  }
  return { kind: "cancel", config, taskId, fingerprint };
}

const PROVIDER_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function authInvocation(args: readonly string[]): AuthInvocation | undefined {
  const kind = args[0];
  if (kind !== "login" && kind !== "logout") return undefined;
  let config: ConfigSource = { kind: "default" };
  let configSeen = false;
  let provider: string | undefined;
  let auth: AuthType | undefined;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length;) {
    const argument = rest[index];
    if (argument === "--config" && !configSeen && rest[index + 1]) {
      config = { kind: "path", path: rest[index + 1]! };
      configSeen = true;
      index += 2;
    } else if (kind === "login" && argument === "--auth" && auth === undefined && rest[index + 1]) {
      if (rest[index + 1] !== "api_key" && rest[index + 1] !== "oauth") throw new UsageError();
      auth = rest[index + 1] as AuthType;
      index += 2;
    } else if (provider === undefined && argument !== undefined && PROVIDER_ARGUMENT.test(argument)) {
      provider = argument;
      index += 1;
    } else {
      throw new UsageError();
    }
  }
  return kind === "login"
    ? {
        kind,
        config,
        ...(provider === undefined ? {} : { provider }),
        ...(auth === undefined ? {} : { auth }),
      }
    : { kind, config, ...(provider === undefined ? {} : { provider }) };
}

/**
 * Load the selected configuration. A missing default file gets its own fixed
 * diagnostic; an explicit path keeps the existing unreadable/invalid text and
 * relative-path semantics. No discovery, merge or file creation happens here.
 */
async function readConfig(source: ConfigSource): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  if (source.kind === "path") return loadConfig(source.path);
  try {
    return await loadConfig(defaultConfigPath());
  } catch (cause) {
    if (cause instanceof StartupDiagnosticError && cause.code === "configFile" && missingFile(cause.cause)) {
      throw new StartupDiagnosticError("defaultConfigFile", { cause });
    }
    throw cause;
  }
}

function missingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const help = helpTopic(args);
  if (help !== undefined) {
    writeHelp(help.topic);
    return;
  }
  const leading = args[0];
  if (leading !== undefined && leading !== "--config" && !SUBCOMMANDS.has(leading)) {
    throw new UnknownCommandError(leading);
  }
  const recovery = recoveryInvocation(args);
  if (recovery !== undefined) {
    await runRecovery(recovery, await readConfig(recovery.config));
    return;
  }
  const auth = authInvocation(args);
  if (auth !== undefined) {
    await runAuthCommand(auth, await readConfig(auth.config));
    return;
  }
  const invocation = launchInvocation(args);
  const config = await readConfig(invocation.config);
  if (invocation.kind === "gateway") {
    await runGateway(config);
  } else {
    await runAgent(config, invocation.conversation);
  }
}

/** Explicit terminal authentication. It never opens the gateway or starts a model turn. */
async function runAuthCommand(
  invocation: AuthInvocation,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const stop = new AbortController();
  const shutdown = () => stop.abort(new Error("login cancelled"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (invocation.kind === "login") {
      await runLogin(config, {
        ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
        ...(invocation.auth === undefined ? {} : { auth: invocation.auth }),
      }, { input: stdin, output: stdout, signal: stop.signal });
    } else {
      await runLogout(config, invocation.provider, { input: stdin, output: stdout, signal: stop.signal });
    }
  } catch (error) {
    // Known selection/configuration failures keep their fixed specific text. Anything else
    // is suppressed behind one safe authentication diagnostic: provider and store errors may
    // embed credentials, URLs or paths.
    if (error instanceof StartupDiagnosticError || error instanceof UsageError) throw error;
    throw new StartupDiagnosticError(stop.signal.aborted ? "authCanceled" : "authFailed", { cause: error });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

async function runRecovery(recovery: RecoveryInvocation, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    if (recovery.kind === "list") {
      const blocked = await listPreparedContextBlocks(config, context);
      stdout.write(`${JSON.stringify({ blocked })}\n`);
      return;
    }
    const result = await cancelPreparedContextBlock(config, {
      taskId: recovery.taskId,
      fingerprint: recovery.fingerprint,
    }, context);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

/**
 * The gateway is the sole Durable/storage/runtime owner. It serves the local CLI
 * endpoint and, when configured, Telegram, until SIGINT/SIGTERM.
 */
async function runGateway(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let gateway: Awaited<ReturnType<typeof openGateway>> | undefined;
  let server: Awaited<ReturnType<typeof serveLocalGateway>> | undefined;
  /** Set only by the authenticated owner `/restart` command; acted on after graceful teardown. */
  let restartRequested = false;
  const requestRestart = async (acknowledge?: () => Promise<void>): Promise<void> => {
    if (restartRequested) throw new Error("gateway restart is already in progress");
    restartRequested = true;
    try { await acknowledge?.(); }
    finally { shutdown(); }
  };
  try {
    const socketPath = await localSocketPath(config);
    gateway = await openGateway(config, context, workspaceContextGatewayOptions(config));
    // The gateway owns local attachments too: the CLI only names an operator path. CLI
    // originals live in a code-owned child of the validated operator media root, so a
    // CLI locator never shares names with a Telegram original and a long-but-valid
    // operator directory is not re-checked against its own length cap. No bytes enter
    // the model as native image content and no vision or transcription call is made here.
    const attachments = config.media === undefined
      ? undefined
      : {
          store: createMediaStore({
            workspace: config.workspace,
            directory: config.media.directory,
            childDirectory: LOCAL_ATTACHMENT_DIRECTORY,
          }),
        };
    server = await serveLocalGateway({
      socketPath,
      gateway,
      context,
      tools: config.toolAllowlist ?? [],
      contextRefresh: config.workspaceContext !== undefined,
      presets: config.modelPreset !== undefined,
      restart: { supported: restartSupported(), request: requestRestart },
      ...(attachments === undefined ? {} : { attachments }),
    });
    if (config.telegram) {
      const token = Object.hasOwn(process.env, config.telegram.tokenEnv)
        ? process.env[config.telegram.tokenEnv]
        : undefined;
      if (typeof token !== "string" || token.trim() === "") throw new StartupDiagnosticError("telegramToken");
      const { runTelegram } = await import("./channels/telegram.js");
      await runTelegram(gateway, {
        token,
        allowFrom: config.telegram.allowFrom,
        ...(config.telegram.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: config.telegram.pollTimeoutSeconds }),
        ...(config.media === undefined
          ? {}
          : {
              media: {
                workspace: config.workspace,
                directory: config.media.directory,
                ...(config.media.transcription === undefined
                  ? {}
                  : { transcription: config.media.transcription }),
              },
            }),
        // The host owns the process: a restart stops every surface through the same graceful
        // shutdown, and the replacement happens here after the teardown below.
        restart: {
          supported: restartSupported(),
          request: () => requestRestart(),
        },
      }, context);
    } else {
      await aborted(stop.signal);
    }
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await server?.close();
    await gateway?.close(withoutAbortSignal(context));
  }
  if (restartRequested) replaceGatewayProcess();
}

/**
 * Replace this gateway process with the same Node executable, argv and environment, so the new
 * process loads current code and re-reads the same explicit configuration. A platform that cannot
 * replace the process image leaves a fixed diagnostic and a non-zero exit: the gateway is stopped,
 * never quietly still running under a false success claim.
 */
function replaceGatewayProcess(): void {
  try {
    replaceProcess(restartPlan());
  } catch {
    process.stderr.write(`${RESTART_FAILURE_DIAGNOSTIC}\n`);
    process.exitCode = 1;
  }
}

/**
 * A CLI is a conversation surface over the running gateway. Disconnecting closes
 * only this attachment and its local watchers; durably admitted turns keep running
 * and the same `cli` conversation is resumed on the next attach.
 */
async function runAgent(
  config: Awaited<ReturnType<typeof loadConfig>>,
  conversation: string | undefined,
): Promise<void> {
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  let input: ReturnType<typeof createInterface> | undefined;
  let inputClosed = false;
  const shutdown = () => {
    stop.abort();
    input?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let client: Awaited<ReturnType<typeof connectLocalGateway>> | undefined;
  try {
    const socketPath = await localSocketPath(config);
    client = await connectLocalGateway({
      socketPath,
      ...(conversation === undefined ? {} : { conversation }),
      context,
    });
    // Direct owner delivery from a live MCP login. This is not a transcript entry and not a
    // durable channel record; the URL exists only on this attached terminal.
    client.onMcpAuthorization = (authorization) => {
      stdout.write([
        "",
        "MCP OAuth authorization URL (owner only):",
        authorization.url,
        `Valid until ${new Date(authorization.expiresAtMs).toISOString()}. Open it as the owner, or paste the ` +
          "callback URL back into this terminal.",
        "",
      ].join("\n"));
    };
    client.onMcpNotice = (text) => { stdout.write(`\n${text}\n`); };
    // Readline's post-line size check bounds admission, not its pre-newline input buffer.
    input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
    input.once("close", () => { inputClosed = true; });
    input.setPrompt("> ");
    await runTerminalConversation(client, context, {
      input,
      output: stdout,
      errorOutput: stderr,
      // A piped stdin can already be closed before the remote watch attaches;
      // prompting then throws ERR_USE_AFTER_CLOSE. Prompts are interactive-only.
      prompt: () => {
        if (inputClosed || input?.terminal !== true) return;
        try {
          input.prompt();
        } catch {
          inputClosed = true;
        }
      },
      closeInput: () => input?.close(),
      modelSelection: {
        list: () => client!.listModels(context),
        select: (selection) => client!.selectModel(selection, context),
        ...(client.presets
          ? { selectPreset: (name: string) => client!.selectModelPreset(name, context) }
          : {}),
      },
      ...(client.restartSupported ? { restart: () => client!.restart(context) } : {}),
      toolPolicy: { tools: client.tools },
      contextRefresh: {
        available: client.contextRefresh,
        refresh: () => client!.refreshContext(context),
      },
      ...(client.digest
        ? {
            digest: {
              start: () => client!.digestStart(context),
              status: () => client!.digestStatus(context),
            },
          }
        : {}),
      // MCP status over the same authenticated attach. Callback-shaped lines are offered to the
      // gateway before model admission in the terminal loop.
      ...(client.mcp
        ? {
            mcp: {
              list: () => client!.mcpList(context),
              submitCallback: (text: string) => client!.mcpSubmitCallback(text, context),
            },
          }
        : {}),
      history: {
        defaultSession: client.sessionKey,
        search: (query, ctx) => client!.historySearch(query, ctx),
        listEpisodes: (sessionKey, query, ctx) => client!.listEpisodes(sessionKey, query, ctx),
        episode: (sessionKey, startEntryId, ctx) => client!.episode(sessionKey, startEntryId, ctx),
        entries: (sessionKey, query, limit, cursor, ctx) =>
          client!.historyEntries(sessionKey, query, limit, cursor, ctx),
      },
      ...(client.attachments
        ? {
            attachments: {
              submit: (path, prompt, attachContext) =>
                client!.submitAttachment(resolve(path), prompt, attachContext),
            },
          }
        : {}),
    });
  } finally {
    input?.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await client?.close();
  }
}

/** Canonicalize the configured private data directory and derive the socket path. */
async function localSocketPath(config: Awaited<ReturnType<typeof loadConfig>>): Promise<string> {
  let prepared: Awaited<ReturnType<typeof prepareDataDirectory>>;
  try {
    prepared = await prepareDataDirectory(config);
  } catch (cause) {
    throw new StartupDiagnosticError("workspace", { cause });
  }
  return gatewaySocketPath(prepared.canonicalDataDir);
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolveAborted) => {
    if (signal.aborted) {
      resolveAborted();
      return;
    }
    signal.addEventListener("abort", () => resolveAborted(), { once: true });
  });
}

function localGatewayDiagnostic(error: LocalGatewayError): string {
  return error.reason === "unavailable"
    ? "durable-nanobot: no running gateway answers on this configuration's local endpoint; start " +
      "`durable-nanobot gateway --config <path>` with the same configuration first; omit `--config` for the default " +
      "primary configuration (diagnostic details suppressed)"
    : "durable-nanobot: the configured local gateway endpoint is unavailable or owned by another process; " +
      "stop the other gateway before starting another (diagnostic details suppressed)";
}

/** Shared executable runner for the source launcher and optional compiled entry point. */
export function runCli(): Promise<void> {
  return main().catch((error) => {
    if (error instanceof PreparedContextRecoveryError) {
      console.error(`durable-nanobot recovery: ${error.message}`);
    } else if (error instanceof UnknownCommandError) {
      // Only a safe command-shaped token is echoed; any other supplied argument stays private.
      const echo = SAFE_COMMAND_NAME.test(error.token) ? `: ${error.token}` : "";
      console.error(`durable-nanobot: unknown command${echo}\n${USAGE}`);
    } else if (error instanceof UsageError) {
      console.error(USAGE);
    } else if (error instanceof LocalGatewayError) {
      console.error(localGatewayDiagnostic(error));
    } else {
      // Known startup failures use fixed text; everything else stays suppressed because
      // dependency/config errors may embed credentials or paths.
      console.error(startupDiagnostic(error));
    }
    process.exitCode = 1;
  });
}

if (import.meta.main) await runCli();
