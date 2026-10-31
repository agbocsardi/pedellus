import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { loadConfig } from "./config.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
import { connectLocalGateway } from "./local/client.js";
import { gatewaySocketPath, serveLocalGateway } from "./local/server.js";
import { LocalGatewayError } from "./local/protocol.js";
import { createMediaStore } from "./media/attachments.js";
import { cancelPreparedContextBlock, listPreparedContextBlocks, PreparedContextRecoveryError } from "./recovery/index.js";
import { replaceProcess, restartPlan, restartSupported, RESTART_FAILURE_DIAGNOSTIC } from "./restart.js";
import { runTerminalConversation } from "./terminal/index.js";
import { openGateway } from "./runtime.js";
import { prepareDataDirectory } from "./store.js";
import { StartupDiagnosticError, startupDiagnostic } from "./startup-diagnostics.js";

const USAGE =
  "Usage: nanobot gateway --config <path> | nanobot agent --config <path> [--conversation <name>] | " +
  "nanobot --config <path> (agent, compatibility) | nanobot recovery --config <path> [--cancel <taskId> --fingerprint <sha256>]";

const CONVERSATION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,30})[a-z0-9]$|^[a-z0-9]$/;

type RecoveryInvocation =
  | { readonly kind: "list"; readonly configPath: string }
  | { readonly kind: "cancel"; readonly configPath: string; readonly taskId: number; readonly fingerprint: string };

type LaunchInvocation =
  | { readonly kind: "gateway"; readonly configPath: string }
  | { readonly kind: "agent"; readonly configPath: string; readonly conversation?: string };

/** A usage mistake; the CLI prints the fixed usage line, never the supplied arguments. */
class UsageError extends Error {
  override name = "UsageError";
}

function configArgument(args: readonly string[], start: number): string {
  if (args.length !== start + 2 || args[start] !== "--config" || !args[start + 1]) throw new UsageError();
  return args[start + 1]!;
}

/**
 * `nanobot --config <path>` remains the historical terminal launch. It now attaches
 * to the running gateway instead of opening a second runtime; no gateway is started
 * implicitly.
 */
function launchInvocation(args: readonly string[]): LaunchInvocation {
  if (args[0] === "gateway") return { kind: "gateway", configPath: configArgument(args, 1) };
  if (args[0] === "agent") {
    if (args[1] !== "--config" || !args[2]) throw new UsageError();
    if (args.length === 3) return { kind: "agent", configPath: args[2] };
    if (args.length === 5 && args[3] === "--conversation" && args[4] && CONVERSATION_NAME.test(args[4])) {
      return { kind: "agent", configPath: args[2], conversation: args[4] };
    }
    throw new UsageError();
  }
  return { kind: "agent", configPath: configArgument(args, 0) };
}

function recoveryInvocation(args: readonly string[]): RecoveryInvocation | undefined {
  if (args[0] !== "recovery") return undefined;
  const rest = args.slice(1);
  if (rest.length === 2 && rest[0] === "--config" && rest[1]) {
    return { kind: "list", configPath: rest[1] };
  }
  if (rest.length === 6 && rest[0] === "--config" && rest[1] &&
      rest[2] === "--cancel" && rest[3] && rest[4] === "--fingerprint" && rest[5]) {
    const taskId = Number(rest[3]);
    if (!/^[1-9][0-9]*$/.test(rest[3]) || !Number.isSafeInteger(taskId) || !/^[0-9a-f]{64}$/.test(rest[5])) {
      throw new PreparedContextRecoveryError(
        "Usage: nanobot recovery --config <path> [--cancel <taskId> --fingerprint <sha256>]",
      );
    }
    return { kind: "cancel", configPath: rest[1], taskId, fingerprint: rest[5] };
  }
  throw new PreparedContextRecoveryError(
    "Usage: nanobot recovery --config <path> [--cancel <taskId> --fingerprint <sha256>]",
  );
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const recovery = recoveryInvocation(args);
  if (recovery !== undefined) {
    await runRecovery(recovery, await loadConfig(recovery.configPath));
    return;
  }
  const invocation = launchInvocation(args);
  const config = await loadConfig(invocation.configPath);
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
  try {
    const socketPath = await localSocketPath(config);
    gateway = await openGateway(config, context, workspaceContextGatewayOptions(config));
    // The gateway owns local attachments too: the CLI only names an operator path, and
    // the configured workspace media directory is the same one Telegram ingress uses.
    const attachments = config.media === undefined
      ? undefined
      : {
          store: createMediaStore({
            workspace: config.workspace,
            ...(config.media.directory === undefined ? {} : { directory: config.media.directory }),
          }),
        };
    server = await serveLocalGateway({
      socketPath,
      gateway,
      context,
      tools: config.toolAllowlist ?? [],
      contextRefresh: config.workspaceContext !== undefined,
      presets: config.modelPreset !== undefined,
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
          request: async () => {
            restartRequested = true;
            shutdown();
          },
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
    ? "nanobot: no running gateway answers on this configuration's local endpoint; start " +
      "`nanobot gateway --config <path>` with the same configuration first (diagnostic details suppressed)"
    : "nanobot: the configured local gateway endpoint is unavailable or owned by another process; " +
      "stop the other gateway before starting another (diagnostic details suppressed)";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof PreparedContextRecoveryError) {
      console.error(`nanobot recovery: ${error.message}`);
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
