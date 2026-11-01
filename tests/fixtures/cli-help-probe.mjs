/**
 * Test-only probe: runs the shared CLI entry point in one process for many help invocations and
 * prints one JSON result per case. The real executable is spawned separately for exit status, and
 * no test reporter shares this process, so a captured stream cannot pick up foreign writes.
 *
 * argv: <repoRoot> <JSON array of argument arrays>
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, cases] = process.argv.slice(2);
const { runCli } = await import(pathToFileURL(join(root, "dist", "cli.js")).href);
const results = [];
for (const args of JSON.parse(cases)) results.push(await capture(args));
// The manifest is written only after every capture has restored the real streams.
process.stdout.write(`${JSON.stringify(results)}\n`);

async function capture(args) {
  const out = [];
  const err = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  process.argv = [argv[0], argv[1], ...args];
  process.exitCode = undefined;
  try {
    await runCli();
    return { args, code: process.exitCode ?? 0, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.argv = argv;
    process.exitCode = exitCode;
  }
}
