#!/usr/bin/env node
import { fileURLToPath } from "node:url";
// Avoid leaving a persistent compiler child behind when native restart uses execve.
process.env.ESBUILD_WORKER_THREADS = "0";

try {
  const { tsImport } = await import("tsx/esm/api");
  const { runCli } = await tsImport("../src/cli.ts", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  });
  await runCli();
} catch {
  console.error("pedellus: cannot load the TypeScript entry point; check the checkout, dependencies and typecheck (diagnostic details suppressed)");
  process.exitCode = 1;
}
