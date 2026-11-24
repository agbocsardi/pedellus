#!/usr/bin/env node
import { fileURLToPath } from "node:url";
// Avoid leaving a persistent compiler child behind when native restart uses execve.
process.env.ESBUILD_WORKER_THREADS = "0";
// Keep read-only commands strictly disk-free (prevent tsx from creating a temp transform cache).
const firstArg = process.argv[2];
if (
  firstArg === "doctor" ||
  firstArg === "help" ||
  firstArg === "--help" ||
  firstArg === "-h" ||
  (firstArg === "models" && process.argv[3] === "list") ||
  process.argv.includes("--help") ||
  process.argv.includes("-h")
) {
  process.env.TSX_DISABLE_CACHE = "1";
}

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
