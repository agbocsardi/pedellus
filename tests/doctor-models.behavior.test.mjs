import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    socketProbe: async () => "closed",
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

async function runCli(args, home, isolatedTmp) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      ...(isolatedTmp === undefined ? {} : { TMPDIR: isolatedTmp }),
    },
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

test("models list works with no configuration and creates nothing (including in TMPDIR)", { timeout: 60_000 }, async () => {
  const home = await fresh();
  const isolatedTmp = await fresh();
  const summary = await runCli(["models", "list"], home, isolatedTmp);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /^openai +\d+ chat models$/m);
  assert.match(summary.stdout, /Run `pedellus models list <provider>` to see models for one provider\./);
  const ids = summary.stdout.split("\n").filter((line) => / chat models$/.test(line)).map((line) => line.split(" ")[0]);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));

  const one = await runCli(["models", "list", "openai"], home, isolatedTmp);
  assert.equal(one.code, 0, one.stderr);
  assert.ok(one.stdout.includes(`openai/${OPENAI}  chat  bundled\n`));
  assert.doesNotMatch(one.stdout, /allowed|^(?!openai\/)./m);
  await assert.rejects(stat(join(home, ".pedellus")), /ENOENT/);
  assert.deepEqual(await readdir(isolatedTmp), [], "read-only models list writes nothing to TMPDIR");

  // An explicit missing --config still fails closed.
  const explicit = await runCli(["models", "list", "--config", join(home, "absent.json")], home, isolatedTmp);
  assert.equal(explicit.code, 1);
  assert.equal(explicit.stdout, "");
});

test("doctor without a default configuration fails with the init hint and creates nothing", { timeout: 60_000 }, async () => {
  const home = await fresh();
  const isolatedTmp = await fresh();
  const result = await runCli(["doctor"], home, isolatedTmp);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^\[FAIL\] config file: not found \(~\/\.pedellus\/config\.json\)$/m);
  assert.match(result.stdout, /Run `pedellus init` to set up Pedellus\./);
  await assert.rejects(stat(join(home, ".pedellus")), /ENOENT/);
  assert.deepEqual(await readdir(isolatedTmp), [], "read-only doctor writes nothing to TMPDIR");
});

test("doctor reports safe field-level config errors and never echoes secret keys or paths", async () => {
  const { path } = await setup((config) => ({ ...config, telegram: { tokenEnv: SECRET, allowFrom: ["1"] } }));
  const invalid = await doctor(path);
  assert.equal(invalid.ok, false);
  assert.match(invalid.text, /\[FAIL\] config file: .*telegram\.tokenEnv must be an environment variable name/);
  assert.ok(!invalid.text.includes("AAFsynthetic"), invalid.text);

  // An unknown key (including dotted keys) or invalid dynamic provider key must NOT be echoed back.
  await writeFile(path, JSON.stringify({
    workspace: "ws",
    dataDir: "data",
    model: { provider: "openai", modelId: OPENAI },
    app: { port: 43190, staticRoot: "/tmp", "foo.sk-synthetic-key-42": true },
  }));
  const unknownKey = await doctor(path);
  assert.equal(unknownKey.ok, false);
  assert.match(unknownKey.text, /app contains an unrecognized option/);
  assert.ok(!unknownKey.text.includes("sk-synthetic-key-42"), unknownKey.text);

  // Top-level and `telegram` blocks are strict too; a pasted secret used as a key stays private.
  for (const [extra, expected] of [
    [{ [SECRET]: true }, /configuration contains an unrecognized option/],
    [{ telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN", allowFrom: ["1"], [SECRET]: true } }, /telegram contains an unrecognized option/],
  ]) {
    await writeFile(path, JSON.stringify({
      workspace: "ws",
      dataDir: "data",
      model: { provider: "openai", modelId: OPENAI },
      ...extra,
    }));
    const strict = await doctor(path);
    assert.equal(strict.ok, false);
    assert.match(strict.text, expected);
    assert.ok(!strict.text.includes("AAFsynthetic"), strict.text);
  }

  // Cross-field checks now fail in config itself, with a trusted field-level message.
  await writeFile(path, JSON.stringify({
    workspace: "ws",
    dataDir: "data",
    model: { provider: "openai", modelId: OPENAI },
    idleRollover: { afterMinutes: 30 },
  }));
  assert.match((await doctor(path)).text, /idleRollover requires classifierModel/);

  await writeFile(path, JSON.stringify({
    workspace: "ws",
    dataDir: "data",
    model: { provider: "openai", modelId: OPENAI },
    providers: { "sk-synthetic-key-42": "not-an-object" },
  }));
  const badProviderKey = await doctor(path);
  assert.equal(badProviderKey.ok, false);
  assert.match(badProviderKey.text, /providers contains an invalid entry/);
  assert.ok(!badProviderKey.text.includes("sk-synthetic-key-42"), badProviderKey.text);

  // A secret pasted into workspace path must NOT be echoed back when missing.
  await writeFile(path, JSON.stringify({
    workspace: `./${SECRET}`,
    dataDir: "data",
    model: { provider: "openai", modelId: OPENAI },
  }));
  const badPath = await doctor(path);
  assert.equal(badPath.ok, false);
  assert.match(badPath.text, /\[FAIL\] workspace: configured workspace does not exist/);
  assert.ok(!badPath.text.includes("AAFsynthetic"), badPath.text);

  await writeFile(path, `{"workspace": "${SECRET}", `);
  const broken = await doctor(path);
  assert.match(broken.text, /is not valid JSON \(details suppressed\)/);
  assert.ok(!broken.text.includes("AAFsynthetic"), broken.text);
});

test("doctor warns about WSL2 Windows drives (/mnt/<drive>) without flagging /mnt/wslg", async () => {
  const drive = await doctor("/mnt/c/Users/owner/.pedellus/config.json", { isWsl: true, systemdActive: false });
  assert.match(drive.text, /^\[WARN\] systemd: PID 1 is not systemd; set systemd=true .*\/etc\/wsl\.conf/m);
  assert.match(drive.text, /^\[WARN\] config: configured path resolves under a Windows drive \(\/mnt\/<drive>\)/m);
  assert.match(drive.text, /~\/\.pedellus on the Linux \(ext4\) filesystem/);

  const wslg = await doctor("/mnt/wslg/pedellus/config.json", { isWsl: true, systemdActive: true });
  assert.doesNotMatch(wslg.text, /Windows drive/);
});

test("a healthy setup passes, detects env credentials and gateway probe states, and creates nothing", async () => {
  const { path, dataDir } = await setup();
  const idle = await doctor(path, { env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" } });
  assert.equal(idle.ok, true, idle.text);
  // No raw auth source (not even an environment-variable name) is echoed.
  assert.match(idle.text, /^\[OK\] {3}openai: available \(environment credential\)$/m);
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
    assert.match(live.text, /^\[OK\] {3}gateway: listening on local socket$/m);

    const timedOut = await doctor(path, { env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" }, socketProbe: async () => "timeout" });
    assert.match(timedOut.text, /^\[WARN\] gateway: local socket timed out/m);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  // A shared dataDir is the same refusal the CLI's read-only socket lookup makes, and the
  // gateway endpoint inside it is never probed; nothing is chmodded back by the doctor.
  await chmod(dataDir, 0o755);
  let probed = 0;
  const shared = await doctor(path, {
    env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" },
    socketProbe: async () => { probed += 1; return "listening"; },
  });
  assert.equal(shared.ok, false);
  assert.match(shared.text, /\[FAIL\] dataDir: configured dataDir is not owner-private/);
  assert.match(shared.text, /\[WARN\] gateway: not running/);
  assert.equal(probed, 0, "an endpoint inside a shared dataDir is never probed");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o755, "the doctor never repairs the mode");
});

test("doctor catches missing memory files, symlinked memory dirs, unknown providers, and missing app builds", async () => {
  const { path, workspace } = await setup();
  await rm(join(workspace, "memory", "MEMORY.md"));
  const missing = await doctor(path, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /^\[FAIL\] memory\/MEMORY\.md: missing; startup fails closed/m);

  // Symlinked memory directory must fail just like loadWorkspaceContextSnapshot.
  const { path: linkedCfg, workspace: linkedWs, root: linkedRoot } = await setup();
  const externalMem = join(linkedRoot, "ext-memory");
  await mkdir(externalMem);
  await writeFile(join(externalMem, "MEMORY.md"), "x\n");
  await rm(join(linkedWs, "memory"), { recursive: true, force: true });
  await symlink(externalMem, join(linkedWs, "memory"));
  const symRes = await doctor(linkedCfg, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(symRes.ok, false);
  assert.match(symRes.text, /\[FAIL\] .*: refused by context loader \(symlink\)/);

  // Unknown provider (in model OR in credentials) must fail rather than silently pass.
  const { path: typoCfg } = await setup((config) => ({ ...config, model: { provider: "bogus-provider", modelId: "m1" } }));
  const typoRes = await doctor(typoCfg);
  assert.equal(typoRes.ok, false);
  // Config-derived spellings never print, not even short printable ones: only native Pi AI
  // identifiers are echoed verbatim; everything else gets a stable ordinal.
  assert.match(typoRes.text, /\[FAIL\] provider 1: unknown provider/);
  assert.doesNotMatch(typoRes.text, /bogus-provider/);

  const { path: credTypoCfg } = await setup((config) => ({ ...config, credentials: { "openaai": "OPENAI_API_KEY" } }));
  const credTypoRes = await doctor(credTypoCfg, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(credTypoRes.ok, false);
  assert.match(credTypoRes.text, /\[FAIL\] provider 1: unknown provider/);
  assert.doesNotMatch(credTypoRes.text, /openaai/);
  assert.match(credTypoRes.text, /never echoed/);

  // Missing app build index.html fails with build hint.
  const { path: appCfg } = await setup((config, root) => ({
    ...config,
    app: { port: 8787, staticRoot: join(root, "pwa"), avatarDir: join(root, "missing-avatars") },
  }));
  const appRes = await doctor(appCfg, { env: { OPENAI_API_KEY: "x" } });
  assert.equal(appRes.ok, false);
  assert.match(appRes.text, /^\[FAIL\] app: configured app\.staticRoot is missing index\.html$/m);
  assert.match(appRes.text, /^\[FAIL\] app avatar: configured app\.avatarDir could not be resolved as a directory$/m);
  assert.match(appRes.text, /npm run install:pwa && npm run build:pwa/);
});

test("a bad configured root disables gateway probing even while a listener is live", async () => {
  // The CLI's read-only socket lookup refuses this configuration (a root that is a regular
  // file), so the doctor must not probe its endpoint either; the listener stays live throughout.
  const { path } = await setup((config, root) => ({
    ...config,
    extraAllowedDirs: ["not-a-dir.txt"],
  }));
  await writeFile(join(path, "..", "not-a-dir.txt"), "x\n");
  const dataDir = join(path, "..", "data");
  await mkdir(dataDir, { mode: 0o700 });
  const server = createServer();
  await new Promise((resolveListen) => server.listen(join(dataDir, "gateway.sock"), resolveListen));
  let probed = 0;
  try {
    const result = await doctor(path, {
      env: { OPENAI_API_KEY: "sk-SYNTHETIC-ENV" },
      socketProbe: async () => { probed += 1; return "listening"; },
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /\[FAIL\] extraAllowedDirs\[0\]: configured directory is not a directory/);
    assert.match(result.text, /\[WARN\] gateway: not running/, "no probe result for a refused endpoint");
    assert.equal(probed, 0, "an endpoint the CLI would refuse is never probed");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("stored credentials, configured env references and missing credentials are named, never shown", async () => {
  const { path, dataDir } = await setup((config) => ({
    ...config,
    model: { provider: "openai", modelId: OPENAI },
    allowedModels: [
      { provider: "openai", modelId: OPENAI },
      { provider: "anthropic", modelId: ANTHROPIC },
      { provider: "google", modelId: firstChat("google") },
      { provider: "my-endpoint", modelId: "custom-1" },
    ],
    providers: {
      "my-endpoint": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "custom-1", name: "Custom one", contextWindow: 8192, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
    credentials: { anthropic: "MY_ANTHROPIC_KEY", "my-endpoint": "MY_ENDPOINT_KEY" },
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
  // A custom providers ID is configuration text, so it never prints verbatim, even though it is
  // short and syntax-valid: only its stable ordinal does, and the login hint points at the
  // configuration instead of echoing the configured ID.
  assert.match(unset.text, /^\[FAIL\] provider 1: missing — MY_ENDPOINT_KEY is not set; set it or run `pedellus login` with the provider spelling from the configuration$/m);
  assert.doesNotMatch(unset.text, /my-endpoint/);

  const set = await doctor(path, { env: { MY_ANTHROPIC_KEY: "sk-SYNTHETIC-ENV", GEMINI_API_KEY: "g-SYNTHETIC", MY_ENDPOINT_KEY: "e-SYNTHETIC" } });
  assert.match(set.text, /^\[OK\] {3}anthropic: env \(MY_ANTHROPIC_KEY\)$/m);
  // Google resolved its native ambient variable; the source name itself is never echoed.
  assert.match(set.text, /^\[OK\] {3}google: available \(environment credential\)$/m);
  assert.doesNotMatch(set.text, /GEMINI_API_KEY/);
  // The custom provider is still ordinal-labeled and never echoed once its key is set.
  assert.match(set.text, /^\[OK\] {3}provider 1: env \(MY_ENDPOINT_KEY\)$/m);
  assert.doesNotMatch(set.text, /my-endpoint/);
  assert.equal(set.ok, true, set.text);
  for (const text of [unset.text, set.text]) assert.ok(!/SYNTHETIC/.test(text), text);
});
