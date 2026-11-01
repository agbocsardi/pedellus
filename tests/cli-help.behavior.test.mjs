import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repoRoot, "bin", "durable-nanobot.mjs");
const SYNTHETIC_UNSAFE = "/SYNTHETIC-SECRET-ARGUMENT";

/** Spawn the real CLI with an isolated HOME; no owner configuration or environment leaks in. */
function startCli(home, args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { if (stdout.length < 32_768) stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { if (stderr.length < 32_768) stderr += chunk.toString(); });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exited,
  };
}

async function runCli(home, args, limit = 15_000) {
  const handle = startCli(home, args);
  const result = await Promise.race([
    handle.exited,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), limit);
      timer.unref();
    }),
  ]);
  if (result.timedOut) {
    handle.child.kill("SIGKILL");
    await handle.exited;
    assert.fail(`help invocation did not exit within ${limit}ms: ${args.join(" ")}`);
  }
  return { ...result, stdout: handle.stdout, stderr: handle.stderr };
}

async function emptyHome(t) {
  const home = await mkdtemp(join(tmpdir(), "nanobot-cli-help-"));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  return home;
}

test("process help prints the overview on stdout and reads no configuration", { timeout: 30_000 }, async (t) => {
  const home = await emptyHome(t);
  for (const flag of ["--help", "-h", "help"]) {
    const result = await runCli(home, [flag]);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr);
    assert.equal(result.stderr, "", "help is not a diagnostic");
    assert.match(result.stdout, /Usage:\n {2}durable-nanobot <command> \[options\]/);
    assert.match(result.stdout, /durable-nanobot gateway \[--config <path>\]/);
    assert.match(result.stdout, /durable-nanobot recovery \[--config <path>\] \[--cancel <taskId> --fingerprint <sha256>\]/);
    assert.match(result.stdout, /~\/\.durable-nanobot\/config\.json/);
    // The generated slash-command catalogue is part of the overview, with its availability caveat.
    assert.match(result.stdout, /availability depends on the gateway/);
    assert.match(result.stdout, /\/help \[command\] — Show these controls, or one command's detail/);
    // Help text stays short: the overview is about one screen and no line is a paragraph.
    const overviewLines = result.stdout.trimEnd().split("\n");
    assert.ok(overviewLines.length <= 60, `the overview is ${overviewLines.length} lines`);
    assert.ok(overviewLines.every((line) => line.length <= 120), "no overview line exceeds 120 characters");
  }
  await assert.rejects(stat(join(home, ".durable-nanobot")), /ENOENT/,
    "printing help must not create or read the default configuration directory");

  // An explicit --config does not distract a help request from printing and exiting 0.
  const explicit = await runCli(home, ["--config", join(home, "absent.json"), "--help"]);
  assert.deepEqual({ code: explicit.code, signal: explicit.signal }, { code: 0, signal: null }, explicit.stderr);
  assert.equal(explicit.stderr, "");
});

test("per-subcommand help pages print only fixed text and exit 0", { timeout: 30_000 }, async (t) => {
  const home = await emptyHome(t);
  const cases = [
    ["gateway", /Usage: durable-nanobot gateway \[--config <path>\]/, /one private Unix socket/],
    ["agent", /Usage: durable-nanobot agent \[--config <path>\] \[--conversation <name>\]/, /Never opens a second runtime/],
    ["login", /Usage: durable-nanobot login \[--config <path>\] \[provider\] \[--auth api_key\|oauth\]/, /Terminal-only/],
    ["logout", /Usage: durable-nanobot logout \[--config <path>\] \[provider\]/, /terminal-only path as login/],
    [
      "recovery",
      /Usage: durable-nanobot recovery \[--config <path>\] \[--cancel <taskId> --fingerprint <sha256>\]/,
      /--fingerprint <sha256>/,
    ],
  ];
  for (const [command, usage, detail] of cases) {
    const result = await runCli(home, [command, "--help"]);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, usage, `${command} page carries its exact usage line`);
    assert.match(result.stdout, detail);
    assert.match(result.stdout, /~\/\.durable-nanobot\/config\.json/);
    assert.ok(result.stdout.trimEnd().split("\n").length <= 24, `${command} page stays short`);
  }
  await assert.rejects(stat(join(home, ".durable-nanobot")), /ENOENT/);
});

test("a help flag is honoured before dispatch while `help` as an argument is not a help request", { timeout: 30_000 }, async (t) => {
  const home = await emptyHome(t);
  // A help flag anywhere on a known subcommand line names that subcommand's page and exits 0.
  const pages = [
    [["gateway", "--config", "--help"], /Usage: durable-nanobot gateway \[--config <path>\]/],
    [["agent", "--conversation", "work", "--help"], /Usage: durable-nanobot agent \[--config <path>\] \[--conversation <name>\]/],
  ];
  for (const [args, usage] of pages) {
    const result = await runCli(home, args);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr);
    assert.equal(result.stderr, "", "a help page is not a diagnostic");
    assert.match(result.stdout, usage);
    assert.doesNotMatch(result.stdout, /^Usage:\n/m, "a page is not the overview");
  }
  // `help` given as an option value or after `--config x` is an argument, not a help request: the
  // dispatch parser rejects the form and the fixed usage block exits 1 without printing a page.
  const malformed = [
    ["help", "--config", join(home, "absent.json")],
    ["--config", join(home, "absent.json"), "help"],
  ];
  for (const args of malformed) {
    const refused = await runCli(home, args);
    assert.deepEqual({ code: refused.code, signal: refused.signal }, { code: 1, signal: null });
    assert.equal(refused.stdout, "", "a malformed form prints no help page");
    assert.match(refused.stderr, /^Usage: durable-nanobot gateway \[--config <path>\]/);
    assert.match(refused.stderr, /durable-nanobot <command> --help/);
  }
  // The overview form of a help flag does exit 0, even with an unused --config on the line.
  const overview = await runCli(home, ["--help", "--config", join(home, "absent.json")]);
  assert.deepEqual({ code: overview.code, signal: overview.signal }, { code: 0, signal: null }, overview.stderr);
  assert.match(overview.stdout, /^durable-nanobot — local assistant gateway/);
  await assert.rejects(stat(join(home, ".durable-nanobot")), /ENOENT/);
});

test("an unknown subcommand is one fixed diagnostic with usage and a help hint", { timeout: 30_000 }, async (t) => {
  const home = await emptyHome(t);
  const result = await runCli(home, ["bogus-subcommand"]);
  assert.deepEqual({ code: result.code, signal: null }, { code: 1, signal: null });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^durable-nanobot: unknown command: bogus-subcommand/m);
  assert.match(result.stderr, /Usage: durable-nanobot gateway \[--config <path>\]/);
  assert.match(result.stderr, /durable-nanobot <command> --help/);

  // A name that is not a safe command shape is never echoed back.
  for (const argument of [SYNTHETIC_UNSAFE, "UPPER", "two words", "--not-a-command"]) {
    const refused = await runCli(home, [argument]);
    assert.deepEqual({ code: refused.code, signal: null }, { code: 1, signal: null });
    assert.match(refused.stderr, /unknown command/);
    assert.doesNotMatch(refused.stderr, /SYNTHETIC-SECRET-ARGUMENT|UPPER|two words|not-a-command/,
      `the diagnostic must not echo ${JSON.stringify(argument)}`);
  }
  await assert.rejects(stat(join(home, ".durable-nanobot")), /ENOENT/);
});

test("help output never echoes an unsafe argument", { timeout: 30_000 }, async (t) => {
  const home = await emptyHome(t);
  const overview = await runCli(home, ["--help", SYNTHETIC_UNSAFE]);
  assert.equal(overview.code, 0);
  assert.equal(overview.stderr, "");
  assert.doesNotMatch(overview.stdout, /SYNTHETIC-SECRET-ARGUMENT/);

  const page = await runCli(home, ["gateway", "-h", SYNTHETIC_UNSAFE]);
  assert.equal(page.code, 0);
  assert.doesNotMatch(page.stdout + page.stderr, /SYNTHETIC-SECRET-ARGUMENT/);

  const unknownTopic = await runCli(home, ["help", SYNTHETIC_UNSAFE]);
  assert.deepEqual({ code: unknownTopic.code, signal: null }, { code: 1, signal: null });
  assert.match(unknownTopic.stderr, /unknown command/);
  assert.doesNotMatch(unknownTopic.stderr, /SYNTHETIC-SECRET-ARGUMENT/);
  await assert.rejects(stat(join(home, ".durable-nanobot")), /ENOENT/);
});
