import { createInterface } from "node:readline";
import { stdin, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { loadConfig } from "./config.js";
import { workspaceContextGatewayOptions } from "./context/workspace-host.js";
import { runTerminalConversation } from "./terminal/index.js";
import { openGateway } from "./runtime.js";

function configPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new Error("Usage: nanobot --config <path>");
  return args[1];
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig(configPath(args));
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
    gateway = await openGateway(config, context, workspaceContextGatewayOptions(config));
    if (config.telegram) {
      const token = process.env[config.telegram.tokenEnv];
      if (!token) throw new Error(`Missing Telegram token environment variable: ${config.telegram.tokenEnv}`);
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
  main().catch(() => {
    // Dependency/config errors may embed credentials or paths; never print arbitrary messages here.
    console.error("nanobot: command failed; diagnostic details suppressed");
    process.exitCode = 1;
  });
}
