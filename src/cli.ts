#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { loadConfig, defaultConfigPath } from "./config.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
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

const USAGE =
  "Usage: durable-nanobot gateway [--config <path>] | durable-nanobot agent [--config <path>] [--conversation <name>] | " +
  "durable-nanobot --config <path> (agent, compatibility) | " +
  "durable-nanobot recovery [--config <path>] [--cancel <taskId> --fingerprint <sha256>]\n" +
  "Without --config, gateway, agent and recovery use ~/.durable-nanobot/config.json.";

const RECOVERY_USAGE = "Usage: durable-nanobot recovery [--config <path>] [--cancel <taskId> --fingerprint <sha256>]";

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

type LaunchInvocation =
  | { readonly kind: "gateway"; readonly config: ConfigSource }
  | { readonly kind: "agent"; readonly config: ConfigSource; readonly conversation?: string };

/** A usage mistake; the CLI prints the fixed usage line, never the supplied arguments. */
class UsageError extends Error {
  override name = "UsageError";
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
      throw new PreparedContextRecoveryError(RECOVERY_USAGE);
    }
  }
  if (cancel === undefined && fingerprint === undefined) return { kind: "list", config };
  if (cancel === undefined || fingerprint === undefined) throw new PreparedContextRecoveryError(RECOVERY_USAGE);
  const taskId = Number(cancel);
  if (!/^[1-9][0-9]*$/.test(cancel) || !Number.isSafeInteger(taskId) || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new PreparedContextRecoveryError(RECOVERY_USAGE);
  }
  return { kind: "cancel", config, taskId, fingerprint };
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
  const recovery = recoveryInvocation(args);
  if (recovery !== undefined) {
    await runRecovery(recovery, await readConfig(recovery.config));
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
      const token = process.env[config.telegram.tokenEnv];
      if (!token) throw new StartupDiagnosticError("telegramToken");
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

// Native entry-point detection also handles npm's symlinked executable (Node >= 22.19).
if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof PreparedContextRecoveryError) {
      console.error(`durable-nanobot recovery: ${error.message}`);
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
