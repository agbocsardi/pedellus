import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repoRoot, "bin", "pedellus.mjs");
const probe = join(repoRoot, "tests", "fixtures", "cli-help-probe.mjs");
const SYNTHETIC_UNSAFE = "/SYNTHETIC-SECRET-ARGUMENT";

const home = await mkdtemp(join(tmpdir(), "nanobot-cli-help-"));
const absent = join(home, "absent.json");
const defaultConfigDir = join(home, ".pedellus");
after(async () => { await rm(home, { recursive: true, force: true }); });

const PAGES = [
  ["gateway", /Usage: pedellus gateway \[--config <path>\]/, /one private Unix socket/],
  ["agent", /Usage: pedellus agent \[--config <path>\] \[--conversation <name>\]/, /Never opens a second runtime/],
  ["init", /Usage: pedellus init \[--config <path>\] \[--skip-interview\]/, /Never overwrites an existing configuration/],
  ["login", /Usage: pedellus login \[--config <path>\] \[provider\] \[--auth api_key\|oauth\]/, /Terminal-only/],
  ["logout", /Usage: pedellus logout \[--config <path>\] \[provider\]/, /terminal-only path as login/],
  ["models", /Usage: pedellus models <refresh\|list> \[--config <path>\] \[provider\.\.\.\]/, /only catalog network path/],
  [
    "recovery",
    /Usage: pedellus recovery \[--config <path>\] \[--cancel <taskId> --fingerprint <sha256>\]/,
    /--fingerprint <sha256>/,
  ],
];

const MALFORMED = [["help", "--config", absent], ["--config", absent, "help"]];
const UNSAFE_ARGUMENTS = [SYNTHETIC_UNSAFE, "UPPER", "two words", "--not-a-command"];

/** Every invocation the assertions below read, run once through the shared entry point. */
const CASES = [
  ["-h"],
  ["help"],
  ["--config", absent, "--help"],
  ...PAGES.map(([command]) => [command, "--help"]),
  ...PAGES.map(([command]) => ["help", command]),
  ["gateway", "--config", "--help"],
  ["agent", "--conversation", "work", "--help"],
  ...MALFORMED,
  ["--help", "--config", absent],
  ["bogus-subcommand"],
  ...UNSAFE_ARGUMENTS.map((argument) => [argument]),
  ["--help", SYNTHETIC_UNSAFE],
  ["gateway", "-h", SYNTHETIC_UNSAFE],
  ["help", SYNTHETIC_UNSAFE],
];

const results = new Map();

/** The one child that runs the whole matrix; it proves the shared entry point's text and codes. */
async function matrix() {
  if (results.size > 0) return results;
  const child = spawn(process.execPath, [probe, repoRoot, JSON.stringify(CASES)], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true });
    }, 30_000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exited, { code: 0, signal: null }, stderr);
  for (const result of JSON.parse(stdout)) results.set(JSON.stringify(result.args), result);
  return results;
}

async function captured(args) {
  const result = (await matrix()).get(JSON.stringify(args));
  assert.ok(result !== undefined, `missing probe case ${JSON.stringify(args)}`);
  return result;
}

/** Spawn the real CLI once with an isolated HOME; no owner configuration or environment leaks in. */
async function runCliProcess(args, limit = 30_000) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { if (stdout.length < 32_768) stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { if (stderr.length < 32_768) stderr += chunk.toString(); });
  const result = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), limit);
      timer.unref();
    }),
  ]);
  if (result.timedOut) {
    child.kill("SIGKILL");
    assert.fail(`help invocation did not exit within ${limit}ms: ${args.join(" ")}`);
  }
  return { ...result, stdout, stderr };
}

test("process help prints the overview on stdout and reads no configuration", { timeout: 30_000 }, async () => {
  // One real child proves the launcher exits 0 with nothing on stderr and creates no default
  // configuration directory; the other spellings of the same request are asserted below.
  const spawned = await runCliProcess(["--help"]);
  assert.deepEqual({ code: spawned.code, signal: spawned.signal }, { code: 0, signal: null }, spawned.stderr);
  assert.equal(spawned.stderr, "", "help is not a diagnostic");
  await assert.rejects(stat(defaultConfigDir), /ENOENT/,
    "printing help must not create or read the default configuration directory");

  // An explicit --config does not distract a help request from printing and exiting 0.
  const overviews = [spawned.stdout];
  for (const args of [["-h"], ["help"], ["--config", absent, "--help"]]) {
    const result = await captured(args);
    assert.deepEqual({ code: result.code }, { code: 0 }, result.stderr);
    assert.equal(result.stderr, "");
    overviews.push(result.stdout);
  }
  assert.ok(overviews.every((text) => text === overviews[0]), "every overview spelling prints the same page");

  const overview = overviews[0];
  assert.match(overview, /Usage:\n {2}pedellus <command> \[options\]/);
  assert.match(overview, /pedellus gateway \[--config <path>\]/);
  assert.match(overview, /pedellus recovery \[--config <path>\] \[--cancel <taskId> --fingerprint <sha256>\]/);
  assert.match(overview, /~\/\.pedellus\/config\.json/);
  // The generated slash-command catalogue is part of the overview, with its availability caveat.
  assert.match(overview, /availability depends on the gateway/);
  assert.match(overview, /\/help \[command\] — Show these controls, or one command's detail/);
  assert.match(overview, /\/reload — Reload model presets and credentials from the configuration file/);
  // Help text stays short: the overview is about one screen and no line is a paragraph.
  const overviewLines = overview.trimEnd().split("\n");
  assert.ok(overviewLines.length <= 60, `the overview is ${overviewLines.length} lines`);
  assert.ok(overviewLines.every((line) => line.length <= 120), "no overview line exceeds 120 characters");
  // The configuration default is stated once: in the --config option line only.
  assert.equal(overviewLines.filter((line) => line.includes("~/.pedellus/config.json")).length, 1);
});

test("per-subcommand help pages print only fixed text and exit 0", { timeout: 30_000 }, async () => {
  for (const [command, usage, detail] of PAGES) {
    const result = await captured([command, "--help"]);
    assert.deepEqual({ code: result.code }, { code: 0 }, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, usage, `${command} page carries its exact usage line`);
    assert.match(result.stdout, detail);
    assert.match(result.stdout, /~\/\.pedellus\/config\.json/);
    // The same page reached through the explicit `help <command>` form.
    assert.equal((await captured(["help", command])).stdout, result.stdout);
    const lines = result.stdout.trimEnd().split("\n");
    assert.ok(lines.length <= 24, `${command} page stays short`);
    assert.equal(lines.filter((line) => line.includes("~/.pedellus/config.json")).length, 1,
      `${command} states the configuration default once`);
  }
});

test("a help flag is honoured before dispatch while `help` as an argument is not a help request", { timeout: 30_000 }, async () => {
  // A help flag anywhere on a known subcommand line names that subcommand's page and exits 0.
  const pages = [
    [["gateway", "--config", "--help"], /Usage: pedellus gateway \[--config <path>\]/],
    [["agent", "--conversation", "work", "--help"], /Usage: pedellus agent \[--config <path>\] \[--conversation <name>\]/],
  ];
  for (const [args, usage] of pages) {
    const result = await captured(args);
    assert.deepEqual({ code: result.code }, { code: 0 }, result.stderr);
    assert.equal(result.stderr, "", "a help page is not a diagnostic");
    assert.match(result.stdout, usage);
    assert.doesNotMatch(result.stdout, /^Usage:\n/m, "a page is not the overview");
  }
  // `help` given as an option value or after `--config x` is an argument, not a help request: the
  // dispatch parser rejects the form and the fixed usage block exits 1 without printing a page.
  // The first order is also run as a real child, so the failure path really exits 1.
  const real = await runCliProcess(MALFORMED[0]);
  const refusals = [{ ...real, signal: real.signal ?? null, stdout: real.stdout }];
  for (const args of MALFORMED) refusals.push(await captured(args));
  for (const refused of refusals) {
    assert.deepEqual({ code: refused.code, signal: refused.signal ?? null }, { code: 1, signal: null });
    assert.equal(refused.stdout, "", "a malformed form prints no help page");
    assert.match(refused.stderr, /^Usage: pedellus gateway \[--config <path>\]/);
    assert.match(refused.stderr, /pedellus <command> --help/);
  }
  // The overview form of a help flag does exit 0, even with an unused --config on the line.
  const overview = await captured(["--help", "--config", absent]);
  assert.deepEqual({ code: overview.code }, { code: 0 }, overview.stderr);
  assert.match(overview.stdout, /^pedellus — local assistant gateway/);
  await assert.rejects(stat(defaultConfigDir), /ENOENT/);
});

test("an unknown subcommand is one fixed diagnostic with usage and a help hint", { timeout: 30_000 }, async () => {
  const result = await captured(["bogus-subcommand"]);
  assert.deepEqual({ code: result.code }, { code: 1 });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^pedellus: unknown command: bogus-subcommand/m);
  assert.match(result.stderr, /Usage: pedellus gateway \[--config <path>\]/);
  assert.match(result.stderr, /pedellus <command> --help/);

  // A name that is not a safe command shape is never echoed back.
  for (const argument of UNSAFE_ARGUMENTS) {
    const refused = await captured([argument]);
    assert.deepEqual({ code: refused.code }, { code: 1 });
    assert.match(refused.stderr, /unknown command/);
    assert.doesNotMatch(refused.stderr, /SYNTHETIC-SECRET-ARGUMENT|UPPER|two words|not-a-command/,
      `the diagnostic must not echo ${JSON.stringify(argument)}`);
  }
});

test("help output never echoes an unsafe argument", { timeout: 30_000 }, async () => {
  const overview = await captured(["--help", SYNTHETIC_UNSAFE]);
  assert.equal(overview.code, 0);
  assert.equal(overview.stderr, "");
  assert.doesNotMatch(overview.stdout, /SYNTHETIC-SECRET-ARGUMENT/);

  const page = await captured(["gateway", "-h", SYNTHETIC_UNSAFE]);
  assert.equal(page.code, 0);
  assert.doesNotMatch(page.stdout + page.stderr, /SYNTHETIC-SECRET-ARGUMENT/);

  const unknownTopic = await captured(["help", SYNTHETIC_UNSAFE]);
  assert.deepEqual({ code: unknownTopic.code }, { code: 1 });
  assert.match(unknownTopic.stderr, /unknown command/);
  assert.doesNotMatch(unknownTopic.stderr, /SYNTHETIC-SECRET-ARGUMENT/);
});
