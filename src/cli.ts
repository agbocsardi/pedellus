import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { loadConfig } from "./config.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
import { cancelPreparedContextBlock, listPreparedContextBlocks, PreparedContextRecoveryError } from "./recovery/index.js";
import { runTerminalConversation } from "./terminal/index.js";
import { openGateway } from "./runtime.js";
import { StartupDiagnosticError, startupDiagnostic } from "./startup-diagnostics.js";

const RECOVERY_USAGE =
  "Usage: nanobot recovery --config <path> [--cancel <taskId> --fingerprint <sha256>]";

type RecoveryInvocation =
  | { readonly kind: "list"; readonly configPath: string }
  | { readonly kind: "cancel"; readonly configPath: string; readonly taskId: number; readonly fingerprint: string };

function configPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new StartupDiagnosticError("usage");
  return args[1];
}

function recoveryInvocation(args: string[]): RecoveryInvocation | undefined {
  if (args[0] !== "recovery") return undefined;
  const rest = args.slice(1);
  if (rest.length === 2 && rest[0] === "--config" && rest[1]) {
    return { kind: "list", configPath: rest[1] };
  }
  if (rest.length === 6 && rest[0] === "--config" && rest[1] &&
      rest[2] === "--cancel" && rest[3] && rest[4] === "--fingerprint" && rest[5]) {
    const taskId = Number(rest[3]);
    if (!/^[1-9][0-9]*$/.test(rest[3]) || !Number.isSafeInteger(taskId) || !/^[0-9a-f]{64}$/.test(rest[5])) {
      throw new PreparedContextRecoveryError(RECOVERY_USAGE);
    }
    return { kind: "cancel", configPath: rest[1], taskId, fingerprint: rest[5] };
  }
  throw new PreparedContextRecoveryError(RECOVERY_USAGE);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const recovery = recoveryInvocation(args);
  const config = await loadConfig(recovery ? recovery.configPath : configPath(args));
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  let input: ReturnType<typeof createInterface> | undefined;
  const shutdown = () => {
    stop.abort();
    input?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let gateway: Awaited<ReturnType<typeof openGateway>> | undefined;
  try {
    if (recovery?.kind === "list") {
      const blocked = await listPreparedContextBlocks(config, context);
      stdout.write(`${JSON.stringify({ blocked })}\n`);
      return;
    }
    if (recovery?.kind === "cancel") {
      const result = await cancelPreparedContextBlock(config, {
        taskId: recovery.taskId,
        fingerprint: recovery.fingerprint,
      }, context);
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    gateway = await openGateway(config, context, workspaceContextGatewayOptions(config));
    if (config.telegram) {
      const token = process.env[config.telegram.tokenEnv];
      if (!token) throw new StartupDiagnosticError("telegramToken");
      const { runTelegram } = await import("./channels/telegram.js");
      await runTelegram(gateway, {
        token,
        allowFrom: config.telegram.allowFrom,
        ...(config.telegram.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: config.telegram.pollTimeoutSeconds }),
      }, context);
    } else {
      const conversation = await gateway.conversationFor("cli:default", context);
      // Readline's post-line size check bounds admission, not its pre-newline input buffer.
      input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY) });
      input.setPrompt("> ");
      await runTerminalConversation(conversation, context, {
        input,
        output: stdout,
        errorOutput: stderr,
        prompt: () => input?.prompt(),
        closeInput: () => input?.close(),
        modelSelection: {
          list: () => gateway!.listModels("cli:default", context),
          select: (selection) => gateway!.selectModel("cli:default", selection, context),
        },
        toolGrants: {
          ceiling: config.toolAllowlist ?? [],
          list: () => gateway!.listToolGrants("cli:default", context),
          grant: (names, expiresAt) =>
            gateway!.grantTools("cli:default", names.map((name) => ({ name, expiresAt })), context),
          revoke: (names) => gateway!.revokeTools("cli:default", names, context),
        },
        contextRefresh: {
          available: config.workspaceContext !== undefined,
          refresh: () => gateway!.refreshContext("cli:default", context),
        },
        history: {
          search: (query, ctx) => gateway!.historySearch(query, ctx),
          listEpisodes: (query, ctx) => gateway!.listHistoryEpisodes("cli:default", query, ctx),
          episode: (startEntryId, ctx) => gateway!.historyEpisode("cli:default", startEntryId, ctx),
        },
      });
    }
  } finally {
    input?.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await gateway?.close(withoutAbortSignal(context));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof PreparedContextRecoveryError) {
      console.error(`nanobot recovery: ${error.message}`);
    } else {
      // Known startup failures use fixed text; everything else stays suppressed because
      // dependency/config errors may embed credentials or paths.
      console.error(startupDiagnostic(error));
    }
    process.exitCode = 1;
  });
}
