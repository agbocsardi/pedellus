#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import type { AuthType } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { runLogin, runLogout } from "./auth/cli.js";
import {
  CronCommandError,
  CronUsageError,
  parseCronInvocation,
  runCronCommand,
  type CronInvocation,
} from "./automation/operator-cli.js";
import { loadConfig, defaultConfigPath } from "./config.js";
import { runModelsCommand, type ModelsInvocation } from "./model-catalog-cli.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
import { COMMANDS, commandUsage, findCommandHelp, renderCommandHelp, renderOverview, renderUsage } from "./help/cli.js";
import { SAFE_COMMAND_NAME } from "./help/commands.js";
import { connectLocalGateway } from "./local/client.js";
import { renderQuestionText, type AskQuestionView } from "./questions/index.js";
import { gatewaySocketPath, serveLocalGateway } from "./local/server.js";
import { LocalGatewayError } from "./local/protocol.js";
import { createMediaStore } from "./media/attachments.js";
import { LOCAL_ATTACHMENT_DIRECTORY } from "./media/local.js";
import { cancelPreparedContextBlock, listPreparedContextBlocks, PreparedContextRecoveryError } from "./recovery/index.js";
import { createRestartCoordinator, replaceProcess, restartPlan, restartSupported, RESTART_FAILURE_DIAGNOSTIC } from "./restart.js";
import { runTerminalConversation } from "./terminal/index.js";
import { ownerDisplay } from "./terminal/display.js";
import { openGateway } from "./runtime.js";
import { prepareDataDirectory } from "./store.js";
import { StartupDiagnosticError, startupDiagnostic } from "./startup-diagnostics.js";
import { reportFailure, type FailureStage } from "./failure-diagnostics.js";
import { journalEvent, observeOperation } from "./observability.js";

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

/** `cron` reads its configuration like every other process command and attaches to the gateway. */
function cronInvocation(args: readonly string[]): { readonly invocation: CronInvocation; readonly config: ConfigSource } | undefined {
  if (args[0] !== "cron") return undefined;
  const invocation = parseCronInvocation(args.slice(1));
  return {
    invocation,
    config: invocation.configPath === undefined
      ? { kind: "default" }
      : { kind: "path", path: invocation.configPath },
  };
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

function modelsInvocation(args: readonly string[]): { readonly invocation: ModelsInvocation; readonly config: ConfigSource } | undefined {
  if (args[0] !== "models") return undefined;
  const action = args[1];
  if (action !== "refresh" && action !== "list") throw new UsageError();
  let config: ConfigSource = { kind: "default" };
  let configSeen = false;
  const providers: string[] = [];
  const rest = args.slice(2);
  for (let index = 0; index < rest.length;) {
    const argument = rest[index];
    if (argument === "--config" && !configSeen && rest[index + 1]) {
      config = { kind: "path", path: rest[index + 1]! };
      configSeen = true;
      index += 2;
    } else if (argument !== undefined && PROVIDER_ARGUMENT.test(argument) && providers.length < 64) {
      providers.push(argument);
      index += 1;
    } else {
      throw new UsageError();
    }
  }
  return { invocation: { action, providers }, config };
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
  const cron = cronInvocation(args);
  if (cron !== undefined) {
    await runCron(cron.invocation, await readConfig(cron.config));
    return;
  }
  const models = modelsInvocation(args);
  if (models !== undefined) {
    await runModels(models.invocation, await readConfig(models.config));
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

/** Explicit terminal catalog command. It never opens the gateway, reads credentials or edits config. */
async function runModels(
  invocation: ModelsInvocation,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const stop = new AbortController();
  const shutdown = () => stop.abort(new Error("models command cancelled"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    let result;
    try {
      result = await runModelsCommand(config, invocation, { output: stdout, signal: stop.signal });
    } catch (cause) {
      if (cause instanceof StartupDiagnosticError) throw cause;
      throw new StartupDiagnosticError(stop.signal.aborted ? "unexpected" : "workspace", { cause });
    }
    if (!result.ok) process.exitCode = 1;
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
 * Owner scheduling controls: one connection to the running gateway, no chat attachment.
 * Nothing is scheduled or cancelled in this process; the gateway owns every runtime decision.
 */
async function runCron(invocation: CronInvocation, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let client: Awaited<ReturnType<typeof connectLocalGateway>> | undefined;
  try {
    client = await connectLocalGateway({ socketPath: await localSocketPath(config), operatorOnly: true, context });
    await runCronCommand({ client, command: invocation.command, output: stdout, context });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await client?.close();
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
  /** Every channel that started, so a setup failure and a running failure take the same teardown. */
  let channels: ChannelSupervisor | undefined;
  let stage: FailureStage = "gateway.open";
  let failure: { error: unknown } | undefined;
  /** The one host gate for both owner `/restart` surfaces: it refuses while live work would be interrupted. */
  const restart = createRestartCoordinator({
    activeWork: async (ctx) => {
      if (gateway === undefined) throw new Error("gateway is not open");
      return gateway.activeWork(ctx);
    },
    context: withoutAbortSignal(context),
    teardown: shutdown,
  });
  try {
    const socketPath = await localSocketPath(config);
    journalEvent("gateway.starting");
    gateway = await observeOperation("gateway.open", {},
      () => openGateway(config, context, {
        ...workspaceContextGatewayOptions(config),
        // The candidate loader is host-owned and fixed to the file this gateway opened from. No
        // model, chat message or tool can name a path for a reload.
        ...(config.configFile === undefined ? {} : { reloadConfig: () => loadConfig(config.configFile!) }),
      }));
    stage = "gateway.local";
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
      followUpMode: config.followUpMode ?? "followUp",
      restart: { supported: restartSupported(), request: (acknowledge) => restart.request(acknowledge) },
      ...(attachments === undefined ? {} : { attachments }),
    });
    // Every configured channel starts concurrently and none waits for another to end. The supervisor
    // records each started channel, so both a later channel's setup failure and a running failure
    // abort the shared context and wait for every started channel before the gateway closes.
    channels = superviseChannels(shutdown);
    // The host owns the process: a restart stops every surface through the same graceful shutdown,
    // and the replacement happens here after the teardown below.
    const restartHost = { supported: restartSupported(), request: () => restart.request() };
    if (config.telegram) {
      // A channel's own startup failure keeps its specific stage in the journal diagnostic.
      stage = "gateway.telegram";
      const token = Object.hasOwn(process.env, config.telegram.tokenEnv)
        ? process.env[config.telegram.tokenEnv]
        : undefined;
      if (typeof token !== "string" || token.trim() === "") throw new StartupDiagnosticError("telegramToken");
      const { runTelegram } = await import("./channels/telegram.js");
      channels.start("gateway.telegram", runTelegram(gateway, {
        token,
        allowFrom: config.telegram.allowFrom,
        ...(config.telegram.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: config.telegram.pollTimeoutSeconds }),
        followUpMode: config.followUpMode ?? "followUp",
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
        restart: restartHost,
      }, context));
    }
    if (config.discord) {
      stage = "gateway.discord";
      const token = Object.hasOwn(process.env, config.discord.tokenEnv)
        ? process.env[config.discord.tokenEnv]
        : undefined;
      if (typeof token !== "string" || token.trim() === "") throw new StartupDiagnosticError("discordToken");
      const [{ runDiscord }, { createDiscordJsTransport }] = await Promise.all([
        import("./channels/discord.js"),
        import("./channels/discord-js.js"),
      ]);
      channels.start("gateway.discord", runDiscord(gateway, createDiscordJsTransport({ token }), {
        allowFrom: config.discord.allowFrom,
        ...(config.discord.dmAllowFrom === undefined ? {} : { dmAllowFrom: config.discord.dmAllowFrom }),
        ...(config.discord.allowChannels === undefined ? {} : { allowChannels: config.discord.allowChannels }),
        ...(config.discord.groupPolicy === undefined ? {} : { groupPolicy: config.discord.groupPolicy }),
        ...(config.discord.streaming === undefined ? {} : { streaming: config.discord.streaming }),
        ...(config.discord.receipts === undefined ? {} : { receipts: config.discord.receipts }),
        followUpMode: config.followUpMode ?? "followUp",
        ...(config.media === undefined
          ? {}
          : { media: { workspace: config.workspace, directory: config.media.directory } }),
        restart: restartHost,
      }, context));
    }
    journalEvent("gateway.surfaces.started");
    if (!channels.started()) {
      stage = "gateway.wait";
      await aborted(stop.signal);
    } else {
      // A channel that fails while running reports its own stage from the supervisor.
      const failed = await channels.settle();
      if (failed !== undefined) {
        stage = failed.stage;
        throw failed.error;
      }
    }
  } catch (error) {
    // A failure during setup (for example a missing token for the second channel) must stop the
    // channels that already started and wait for them, so the gateway is never closed under a live
    // adapter. A channel failure wins over the setup failure and keeps its own stage.
    if (channels !== undefined && channels.started()) {
      shutdown();
      const failed = await channels.settle();
      if (failed !== undefined) {
        stage = failed.stage;
        failure = { error: failed.error };
        reportFailure(failed.error, stage);
      } else {
        failure ??= { error };
        reportFailure(error, stage);
      }
    } else {
      failure = { error };
      reportFailure(error, stage);
    }
  } finally {
    journalEvent("gateway.stopping");
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try {
      await server?.close();
    } catch (error) {
      reportFailure(error, "gateway.close.local");
      failure ??= { error };
    } finally {
      try {
        await gateway?.close(withoutAbortSignal(context));
      } catch (error) {
        reportFailure(error, "gateway.close.runtime");
        failure ??= { error };
      }
    }
  }
  journalEvent("gateway.stopped", { isError: failure !== undefined });
  if (failure !== undefined) throw failure.error;
  if (restart.accepted()) replaceGatewayProcess();
}

/**
 * Channels started by this gateway, in start order, with the first running failure and its own stage.
 *
 * Every channel is created before any is awaited, so one channel can never delay another's start.
 * A failure asks the host to shut the shared context down first; `settle` then waits for every
 * started channel to finish its own cleanup. The same object is what lets a later channel's *setup*
 * failure stop and await the channels that already started.
 */
export interface ChannelSupervisor {
  /** Register one already-started channel; its failure requests the shared shutdown. */
  start(stage: FailureStage, run: Promise<void>): void;
  /** Whether any channel started. */
  started(): boolean;
  /** Abort nothing, wait for every started channel, and report the first running failure. */
  settle(): Promise<{ readonly stage: FailureStage; readonly error: unknown } | undefined>;
}

export function superviseChannels(shutdown: () => void): ChannelSupervisor {
  const runs: Promise<void>[] = [];
  let failure: { readonly stage: FailureStage; readonly error: unknown } | undefined;
  return {
    start(stage, run) {
      runs.push(run.catch((error: unknown) => {
        failure ??= { stage, error };
        shutdown();
        // The failure is retained above and returned by settle(). Do not
        // rethrow into a promise that setup has not started awaiting yet.
      }));
    },
    started() {
      return runs.length > 0;
    },
    async settle() {
      await Promise.allSettled(runs);
      return failure;
    },
  };
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
  } catch (error) {
    reportFailure(error, "gateway.restart");
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
    // A model question is delivered here while this terminal is attached. The owner answers with an
    // ordinary next message; no button protocol or second prompt exists in a text terminal.
    const printQuestion = (question: AskQuestionView): void => {
      stdout.write(`\n${renderQuestionText(question, "cli", Date.now())}\n`);
    };
    client.onAskQuestion = printQuestion;
    for (const question of client.askQuestions) printQuestion(question);
    // A host interruption notice recorded before this attachment was live. It is ordinary host text,
    // not a transcript entry and not a model turn; acknowledge only after writing it, so a crash
    // repeats the notice on the next attach instead of losing it.
    if (client.pendingNotices.length > 0) {
      for (const notice of client.pendingNotices) {
        await new Promise<void>((resolveWritten, rejectWritten) => {
          stdout.write(`\n${notice.text}\n`, (error) => error ? rejectWritten(error) : resolveWritten());
        });
      }
      try {
        await client.ackNotices(client.pendingNotices.map((notice) => notice.id), context);
      } catch {
        // The record stays pending; the next attach shows it again.
      }
    }
    // Readline's post-line size check bounds admission, not its pre-newline input buffer.
    const terminalInput = Boolean(stdin.isTTY && stdout.isTTY);
    const displayed = terminalInput && process.env.TERM !== "dumb";
    input = createInterface({ input: stdin, output: stdout, terminal: terminalInput });
    input.once("close", () => { inputClosed = true; });
    input.setPrompt(displayed ? "You: " : "> ");
    await runTerminalConversation(client, context, {
      input,
      output: stdout,
      errorOutput: stderr,
      // A display exists only for a real owner terminal; a piped run stays answer-only.
      ...(displayed ? { display: ownerDisplay(input, stdout) } : terminalInput ? {
        prompt: () => { if (!inputClosed) input?.prompt(); },
      } : {}),
      closeInput: () => input?.close(),
      modelSelection: {
        list: () => client!.listModels(context),
        select: (selection) => client!.selectModel(selection, context),
        ...(client.presets
          ? { selectPreset: (name: string) => client!.selectModelPreset(name, context) }
          : {}),
      },
      ...(client.restartSupported ? { restart: () => client!.restart(context) } : {}),
      ...(client.reloadSupported ? { reload: { reload: () => client!.reloadModels(context) } } : {}),
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
    } else if (error instanceof CronUsageError) {
      console.error(error.message);
    } else if (error instanceof CronCommandError) {
      console.error(`durable-nanobot cron: ${error.message}`);
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
      reportFailure(error, "command");
    }
    process.exitCode = 1;
  });
}

if (import.meta.main) await runCli();
