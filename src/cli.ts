import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { loadConfig } from "./config.js";
import { openGateway } from "./runtime.js";

function configPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new Error("Usage: nanobot --config <path>");
  return args[1];
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig(configPath(args));
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let gateway: Awaited<ReturnType<typeof openGateway>> | undefined;
  try {
    gateway = await openGateway(config, context);
    if (config.telegram) {
      const token = process.env[config.telegram.tokenEnv];
      if (!token) throw new Error(`Missing Telegram token environment variable: ${config.telegram.tokenEnv}`);
      const { runTelegram } = await import("./channels/telegram.js");
      await runTelegram(gateway, { token, allowFrom: config.telegram.allowFrom, ...(config.telegram.pollTimeoutSeconds === undefined ? {} : { pollTimeoutSeconds: config.telegram.pollTimeoutSeconds }) }, context);
    } else {
      const conversation = await gateway.conversationFor("cli:default", context);
      const input = createInterface({ input: stdin, output: stdout });
      try {
        while (!stop.signal.aborted) {
          const prompt = await input.question("> ", { signal: stop.signal }).catch(() => "");
          if (!prompt) break;
          const result = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(context);
          if (result.status === "done" && result.type === "input") process.stdout.write(`${result.answer}\n`);
          else process.stderr.write(`Turn ended: ${result.status}\n`);
        }
      } finally { input.close(); }
    }
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await gateway?.close(withoutAbortSignal(context));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
