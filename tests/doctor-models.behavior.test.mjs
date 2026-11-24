import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const pkg = resolve(import.meta.dirname, "..");
const cli = join(pkg, "bin", "pedellus.mjs");
const { runDoctor } = await import(pathToFileURL(`${pkg}/dist/doctor/index.js`).href);
const { builtinProviders } = await import(
  pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`).href
);

const firstChat = (id) => builtinProviders().find((provider) => provider.id === id).getModels()[0].id;
const OPENAI = firstChat("openai");
const ANTHROPIC = firstChat("anthropic");
const SECRET = "123456789:AAFsyntheticSECRETtokenValue0042";

const temp = await mkdtemp(join(tmpdir(), "pd-doctor-"));
after(async () => { await rm(temp, { recursive: true, force: true }); });

let serial = 0;
async function fresh() {
  const dir = join(temp, String(++serial));
  await mkdir(dir);
  return dir;
}

function capture() {
  let text = "";
  return { output: { write: (chunk) => { text += chunk; } }, text: () => text };
}

/** Deterministic host seams: Linux, a supported Node, no WSL and no running gateway. */
async function doctor(configPath, overrides = {}) {
  const sink = capture();
  const result = await runDoctor({
    configPath,
    output: sink.output,
    env: {},
    platform: "linux",
    nodeVersion: "v22.19.0",
    isWsl: false,
    socketProbe: async () => false,
    ...overrides,
  });
  return { ...result, text: sink.text() };
}

/** A complete workspace and config; `patch(config, root)` edits the config object before it is written. */
async function setup(patch = (config) => config) {
  const root = await fresh();
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "memory"), { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "memory/MEMORY.md"]) await writeFile(join(workspace, name), "x\n");
  const config = patch({
    workspace: "ws",
    dataDir: "data",
    model: { provider: "openai", modelId: OPENAI },
    workspaceContext: { memoryFiles: ["memory/MEMORY.md"] },
  }, root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config));
  return { root, workspace, dataDir: join(root, "data"), path };
}

async function runCli(args, home) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out: ${args.join(" ")}`)); }, 30_000);
    child.once("close", (exit) => { clearTimeout(timer); resolveExit(exit); });
  });
  return { code, stdout, stderr };
}

test("models list works with no configuration and creates nothing", { timeout: 60_000 }, async () => {
  const home = await fresh();
  const summary = await runCli(["models", "list"], home);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /^openai +\d+ chat models$/m);
  assert.match(summary.stdout, /Run `pedellus models list <provider>` to see models for one provider\./);
  const ids = summary.stdout.split("\n").filter((line) => / chat models$/.test(line)).map((line) => line.split(" ")[0]);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));

  const one = await runCli(["models", "list", "openai"], home);
  assert.equal(one.code, 0, one.stderr);
  assert.ok(one.stdout.includes(`openai/${OPENAI}  chat  bundled\n`));
  assert.doesNotMatch(one.stdout, /allowed|^(?!openai\/)./m);
  await assert.rejects(stat(join(home, ".pedellus")), /ENOENT/);

  // An explicit missing --config still fails closed.
  const explicit = await runCli(["models", "list", "--config", join(home, "absent.json")], home);
  assert.equal(explicit.code, 1);
  assert.equal(explicit.stdout, "");
});

test("doctor without a default configuration fails with the init hint and creates nothing", { timeout: 60_000 }, async () => {
  const home = await fresh();
  const result = await runCli(["doctor"], home);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^\[FAIL\] config file: not found: .*\.pedellus\/config\.json$/m);
  assert.match(result.stdout, /Run `pedellus init` to set up Pedellus\./);
  await assert.rejects(stat(join(home, ".pedellus")), /ENOENT/);
});

test("doctor reports a field-level config error and never the secret value", async () => {
  const { path } = await setup((config) => ({ ...config, telegram: { tokenEnv: SECRET, allowFrom: ["1"] } }));
  const invalid = await doctor(path);
  assert.equal(invalid.ok, false);
  assert.match(invalid.text, /\[FAIL\] config file: .* is invalid: telegram\.tokenEnv must be an environment variable name/);
  assert.ok(!invalid.text.includes("AAFsynthetic"), invalid.text);

  await writeFile(path, `{"workspace": "${SECRET}", `);
  const broken = await doctor(path);
  assert.match(broken.text, /is not valid JSON \(details suppressed\)/);
  assert.ok(!broken.text.includes("AAFsynthetic"), broken.text);
});

test("doctor warns about WSL2 Windows drives and a missing systemd", async () => {
  const result = await doctor("/mnt/c/Users/owner/.pedellus/config.json", { isWsl: true, systemdActive: false });
  assert.match(result.text, /^\[WARN\] systemd: PID 1 is not systemd; set systemd=true .*\/etc\/wsl\.conf/m);
  assert.match(result.text, /^\[WARN\] config: \/mnt\/c\/Users\/owner\/\.pedellus\/config\.json is on a Windows drive; .*SQLite WAL/m);
  assert.match(result.text, /~\/\.pedellus on the Linux \(ext4\) filesystem/);
});

test("a healthy setup passes, detects env credentials and a running gateway, and creates nothing", async () => {
  const { path, dataDir } = await setup();
  const idle = await doctor(path, { env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" } });
  assert.equal(idle.ok, true, idle.text);
  assert.match(idle.text, /^\[OK\] {3}openai: env \(OPENAI_API_KEY\)$/m);
  assert.match(idle.text, /^\[OK\] {3}memory\/MEMORY\.md: present$/m);
  assert.match(idle.text, /^\[WARN\] gateway: not running \(start with `pedellus gateway`\)$/m);
  assert.match(idle.text, /, 0 failures\n$/);
  assert.ok(!idle.text.includes("sk-SYNTHETIC"));
  await assert.rejects(stat(dataDir), /ENOENT/, "doctor must not create the data directory");

  await mkdir(dataDir, { mode: 0o700 });
  const server = createServer();
  await new Promise((resolveListen) => server.listen(join(dataDir, "gateway.sock"), resolveListen));
  try {
    const live = await doctor(path, { env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" }, socketProbe: undefined });
    assert.equal(live.ok, true, live.text);
    assert.match(live.text, /^\[OK\] {3}gateway: running$/m);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("a missing configured memory file is a blocking failure", async () => {
  const { path, workspace } = await setup();
  await rm(join(workspace, "memory", "MEMORY.md"));
  const result = await doctor(path, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(result.ok, false);
  assert.match(result.text, /^\[FAIL\] memory\/MEMORY\.md: missing; startup fails closed/m);
});

test("an app static root without index.html fails with the build hint", async () => {
  const { path } = await setup((config, root) => ({ ...config, app: { port: 8787, staticRoot: join(root, "pwa") } }));
  const result = await doctor(path, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(result.ok, false);
  assert.match(result.text, /^\[FAIL\] app: .*\/pwa\/index\.html is missing$/m);
  assert.match(result.text, /npm run install:pwa && npm run build:pwa/);
});

test("stored credentials, configured env references and missing credentials are named, never shown", async () => {
  const { path, dataDir } = await setup((config) => ({
    ...config,
    model: { provider: "openai", modelId: OPENAI },
    allowedModels: [
      { provider: "openai", modelId: OPENAI },
      { provider: "anthropic", modelId: ANTHROPIC },
      { provider: "google", modelId: firstChat("google") },
    ],
    credentials: { anthropic: "MY_ANTHROPIC_KEY" },
  }));
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(join(dataDir, "credentials.json"), JSON.stringify({
    version: 1,
    credentials: { openai: { type: "api_key", key: "sk-SYNTHETIC-STORED" } },
  }), { mode: 0o600 });

  const unset = await doctor(path);
  assert.equal(unset.ok, false);
  assert.match(unset.text, /^\[OK\] {3}openai: stored credential$/m);
  assert.match(unset.text, /^\[FAIL\] anthropic: missing — MY_ANTHROPIC_KEY is not set; .*pedellus login anthropic/m);
  assert.match(unset.text, /^\[FAIL\] google: missing — run `pedellus login google`$/m);

  const set = await doctor(path, { env: { MY_ANTHROPIC_KEY: "sk-SYNTHETIC-ENV", GEMINI_API_KEY: "g-SYNTHETIC" } });
  assert.match(set.text, /^\[OK\] {3}anthropic: env \(MY_ANTHROPIC_KEY\)$/m);
  assert.match(set.text, /^\[OK\] {3}google: env \(GEMINI_API_KEY\)$/m);
  assert.equal(set.ok, true, set.text);
  for (const text of [unset.text, set.text]) assert.ok(!/SYNTHETIC/.test(text), text);
});
