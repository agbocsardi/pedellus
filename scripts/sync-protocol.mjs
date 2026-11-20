#!/usr/bin/env node
// Mirror the normative wire contract (pwa/protocol/v2.ts) into src/channels/generated/.
//
// `rootDir: src` cannot compile a file under pwa/, and moving the emitted tree to dist/src/ would
// rewrite every test import, so the gateway imports a byte-identical copy with a generated header.
// `npm run build` writes it; `npm run typecheck` runs `--check`, which fails on a stale copy.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "pwa", "protocol", "v2.ts");
const target = join(root, "src", "channels", "generated", "protocol-v2.ts");
const HEADER = [
  "// Generated from pwa/protocol/v2.ts by scripts/sync-protocol.mjs: do not edit.",
  "// The normative contract lives there and in pwa/protocol/v2.md; run `npm run sync:protocol`.",
  "",
].join("\n");

const expected = HEADER + await readFile(source, "utf8");
const current = await readFile(target, "utf8").catch(() => undefined);

if (process.argv.includes("--check")) {
  if (current !== expected) {
    console.error("src/channels/generated/protocol-v2.ts is stale: run `npm run sync:protocol`");
    process.exitCode = 1;
  }
} else if (current !== expected) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, expected);
}
