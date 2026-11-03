import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ReadAfterWrite, SessionFailed } from "@earendil-works/pi-durable";

const { failureDiagnostic } = await import(new URL("../dist/failure-diagnostics.js", import.meta.url).href);

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repoRoot, "bin", "durable-nanobot.mjs");
const {
  parseConfig,
} = await import(new URL("../dist/config.js", import.meta.url).href);
const { openGateway } = await import(new URL("../dist/runtime.js", import.meta.url).href);
const { workspaceContextGatewayOptions } = await import(new URL("../dist/context/workspace-host.js", import.meta.url).href);
const { prepareDataDirectory } = await import(new URL("../dist/store.js", import.meta.url).href);
const { gatewaySocketPath, serveLocalGateway } = await import(new URL("../dist/local/server.js", import.meta.url).href);
const { connectLocalGateway } = await import(new URL("../dist/local/client.js", import.meta.url).href);

const context = BACKGROUND_CONTEXT;
const timeoutMs = 10_000;
const graceMs = 5_000;
const SYNTHETIC_ENV = "SYNTHETIC-NOT-A-CREDENTIAL";

async function eventually(check, message, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

function isolatedEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    OPENAI_API_KEY: SYNTHETIC_ENV,
  };
}

/** One owner-like config under a temporary HOME; never the owner's real config. */
async function writeDefaultInstance(home, modelId) {
  const configDir = join(home, ".durable-nanobot");
  const workspace = join(configDir, "workspace");
  const dataDir = join(configDir, "state");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "note.txt"), `workspace for ${modelId}\n`);
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    workspace: "./workspace",
    dataDir: "./state",
    model: { provider: "openai", modelId },
    episodeSummary: { enabled: false },
    credentials: { openai: "OPENAI_API_KEY" },
  }));
  return { configDir, workspace, dataDir, socketPath: join(dataDir, "gateway.sock") };
}

function startCli(home, args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: isolatedEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { if (stdout.length < 16_384) stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString(); });
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

async function waitForExit(handle, limit = timeoutMs) {
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
    assert.fail(`child did not exit within ${limit}ms; stderr: ${handle.stderr}`);
  }
  return result;
}

async function stopCli(handle, signal = "SIGTERM") {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill(signal);
  const result = await Promise.race([
    handle.exited,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), graceMs);
      timer.unref();
    }),
  ]);
  if (result.timedOut) {
    handle.child.kill("SIGKILL");
    return handle.exited;
  }
  return result;
}

async function waitForSocket(handle, socketPath, message) {
  await eventually(async () => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      assert.fail(`${message}; child exited early (stderr: ${handle.stderr})`);
    }
    try {
      return (await stat(socketPath)).isSocket();
    } catch {
      return false;
    }
  }, message);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("failure records keep Durable causes and code locations without serializing sensitive values", () => {
  const parse = (line) => JSON.parse(line.slice('durable-nanobot diagnostic: '.length));
  const durable = new SessionFailed(new ReadAfterWrite('Tx.scanTasks()'));
  // These are real Durable error classes; supply a controlled library throw location because
  // constructing them directly here otherwise points at this test, not a Durable call site.
  for (const error of [durable, durable.cause]) {
    error.stack = `${error.name}: ${error.message}\n    at nativeFailure (${join(repoRoot, 'node_modules/@earendil-works/pi-durable/dist/errors.js')}:20:5)`;
  }
  const record = parse(failureDiagnostic(durable, 'durable.storage_failed'));
  assert.equal(record.errors[0].name, 'SessionFailed');
  assert.equal(record.errors[0].message, 'Session failed after a storage error; close and reopen it');
  assert.equal(record.errors[1].name, 'ReadAfterWrite');
  assert.equal(record.errors[1].message, 'Tx.scanTasks() cannot read tables after the first table write');
  assert.ok(record.errors[1].locations.some((location) => location.startsWith('node_modules/@earendil-works/pi-durable/')));
  assert.equal(failureDiagnostic(durable, 'durable.storage_failed'), failureDiagnostic(durable, 'durable.storage_failed'));
  durable.cause.stack = `ReadAfterWrite\n    at nativeFailure (${join(repoRoot, 'node_modules/@earendil-works/pi-durable/src/errors.ts')}:20:5)`;
  assert.equal(parse(failureDiagnostic(durable, 'durable.storage_failed')).errors[1].message,
    'Tx.scanTasks() cannot read tables after the first table write', 'source-mapped SDK frames survive the source launcher');

  const secret = 'SENSITIVE-VALUE-DO-NOT-LOG-6617';
  const cause = Object.assign(new Error(secret), { code: 'ECONNRESET' });
  const error = Object.assign(new Error(secret, { cause: new AggregateError([cause], secret) }), {
    name: secret, reason: secret, method: secret, request: { token: secret },
  });
  let codeReads = 0;
  Object.defineProperty(error, 'code', { get: () => ++codeReads === 1 ? 'ECONNREFUSED' : secret });
  error.stack = `${secret}\n    at ${secret} (${join(repoRoot, 'src/cli.ts')}:20:5)\n    at ${secret} (/private/${secret}.js:1:1)`;
  cause.cause = error; // Cyclic and aggregate causes must remain bounded.
  const line = failureDiagnostic(error, 'gateway.telegram');
  const safe = parse(line);
  assert.equal(codeReads, 1);
  assert.equal(safe.errors[0].code, 'ECONNREFUSED');
  assert.ok(safe.errors.some((entry) => entry.code === 'ECONNRESET'));
  assert.deepEqual(safe.errors[0].locations, ['src/cli.ts:20:5']);
  assert.ok(safe.errors.length <= 4 && line.length < 10_000);
  assert.doesNotMatch(line, new RegExp(secret));
  assert.ok(!line.includes(repoRoot));
  assert.ok(!failureDiagnostic(secret, 'command').includes(secret));
  const hostile = new Error();
  Object.defineProperty(hostile, 'stack', { get() { throw new Error(secret); } });
  assert.deepEqual(parse(failureDiagnostic(hostile, 'command')).errors, [{ name: 'UninspectableError' }]);
});

test("unexpected CLI startup failures emit a safe staged cause record", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nanobot-failure-log-'));
  try {
    const instance = await writeDefaultInstance(home, 'gpt-6-luna');
    await mkdir(instance.dataDir);
    await writeFile(join(instance.dataDir, 'nanobot.sqlite'), 'synthetic-not-a-database');
    const gateway = startCli(home, ['gateway'], home);
    const exit = await waitForExit(gateway);
    assert.equal(exit.code, 1);
    const records = gateway.stderr.split('\n').filter((line) => line.startsWith('durable-nanobot diagnostic: '))
      .map((line) => JSON.parse(line.slice('durable-nanobot diagnostic: '.length)));
    assert.ok(records.some((record) => record.stage === 'gateway.open'), gateway.stderr);
    assert.ok(records.some((record) => record.errors.some((error) => error.code === 'ERR_SQLITE_ERROR')));
    assert.ok(records.some((record) => record.errors.some((error) => error.locations.length > 0)));
    assert.ok(!gateway.stderr.includes(home));
    assert.ok(!gateway.stderr.includes(SYNTHETIC_ENV));
    assert.ok(!gateway.stderr.includes('synthetic-not-a-database'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native Durable listener reports reach the journal without failing the gateway", { timeout: 30_000 }, async () => {
  const instance = await makeSyntheticInstance('reports', 'SYNTHETIC');
  const original = console.error;
  const logs = [];
  let observation;
  let timer;
  try {
    let reported;
    const received = new Promise((resolve) => { reported = resolve; });
    console.error = (line) => {
      logs.push(String(line));
      if (String(line).includes('durable.listener_error')) reported();
    };
    observation = instance.gateway.harness.observeCommits({
      advance() { throw new Error('PRIVATE-LISTENER-PAYLOAD-7719'); }, end() {},
    });
    const chat = await instance.gateway.conversationFor('cli:diagnostics', instance.instanceContext);
    await Promise.race([received, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('missing Durable report')), timeoutMs);
    })]);
    assert.ok(logs.some((line) => line.includes('durable.listener_error')));
    assert.ok(logs.every((line) => !line.includes('PRIVATE-LISTENER-PAYLOAD-7719') && !line.includes(instance.directory)));
    await chat.commit((tx) => tx.appendEntry(chat.id, { kind: 'pi.user', model: [{ role: 'user', content: 'still usable', timestamp: 1 }] }), instance.instanceContext);
  } finally {
    clearTimeout(timer);
    observation?.detach();
    console.error = original;
    await instance.close();
  }
});

test("default config is read from HOME, SIGTERM stops cleanly, the lock releases, and recovery uses the same default", { timeout: 45_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "nanobot-default-home-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "nanobot-default-cwd-"));
  const instance = await writeDefaultInstance(home, "gpt-6-luna");
  let gateway;
  try {
    // The process working directory is deliberately unrelated to HOME: the
    // default must come from the runtime user home, never from CWD.
    gateway = startCli(home, ["gateway"], elsewhere);
    await waitForSocket(gateway, instance.socketPath, "default-config gateway did not open its socket");
    assert.equal((await stat(join(instance.dataDir, "nanobot.sqlite"))).isFile(), true);

    // `agent` with no --config selects the same default and attaches to the
    // running gateway; EOF on its stdin ends this attachment without stopping
    // the gateway.
    const agent = startCli(home, ["agent"], elsewhere);
    const agentExit = await waitForExit(agent);
    assert.equal(agentExit.code, 0, agent.stderr);
    assert.equal(await pathExists(instance.socketPath), true, "agent exit stopped the gateway");

    // The same store is a native live-owner refusal, with fixed text and no
    // path or credential disclosure.
    const duplicate = startCli(home, ["gateway"], elsewhere);
    const duplicateExit = await waitForExit(duplicate);
    assert.equal(duplicateExit.code, 1);
    assert.match(duplicate.stderr, /another process already owns the configured data store/);
    assert.match(duplicate.stderr, /diagnostic details suppressed/);
    assert.doesNotMatch(duplicate.stderr + duplicate.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(duplicate.stderr + duplicate.stdout, new RegExp(SYNTHETIC_ENV));

    const stopped = await stopCli(gateway);
    gateway = undefined;
    assert.equal(stopped.code, 0, `SIGTERM exit was not clean: ${stopped.signal}`);
    assert.equal(stopped.signal, null);
    await eventually(async () => !(await pathExists(instance.socketPath)), "socket was not removed on SIGTERM");

    // The lock is gone: the same default config opens again.
    const reopened = startCli(home, ["gateway"], elsewhere);
    gateway = reopened;
    await waitForSocket(reopened, instance.socketPath, "reopened gateway did not acquire the released store");
    const reopenedStop = await stopCli(reopened, "SIGINT");
    gateway = undefined;
    assert.equal(reopenedStop.code, 0);

    // Recovery also resolves the default configuration; it works with the
    // stopped store and lists no blocked prepared context.
    const recovery = startCli(home, ["recovery"], elsewhere);
    const recoveryExit = await waitForExit(recovery);
    assert.equal(recoveryExit.code, 0, recovery.stderr);
    assert.match(recovery.stdout, /"blocked":\[\]/);
  } finally {
    if (gateway) await stopCli(gateway).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("a missing default config and explicit config keep separate fixed diagnostics", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "nanobot-missing-home-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "nanobot-missing-cwd-"));
  try {
    // A decoy `config.json` in the working directory must be ignored: the
    // default is resolved from HOME, not CWD.
    await writeFile(join(elsewhere, "config.json"), JSON.stringify({ DECOY: "CWD-DECOY-CONFIG" }));
    const missing = startCli(home, ["gateway"], elsewhere);
    const missingExit = await waitForExit(missing);
    assert.equal(missingExit.code, 1);
    assert.match(missing.stderr, /no default configuration found/);
    assert.match(missing.stderr, /~\/\.durable-nanobot\/config\.json/);
    assert.match(missing.stderr, /diagnostic details suppressed/);
    assert.doesNotMatch(missing.stderr + missing.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(missing.stderr + missing.stdout, new RegExp(SYNTHETIC_ENV));
    assert.equal(await pathExists(join(home, ".durable-nanobot")), false, "missing default must not create the default home");
    assert.equal(await pathExists(join(elsewhere, "decoy-state")), false, "the CWD decoy config was used");
    assert.equal(await pathExists(join(elsewhere, "config.json")), true, "the decoy config disappeared");

    // An explicit path keeps the existing unreadable-config diagnostic; it is
    // not reported as a missing default.
    const explicit = startCli(home, ["--config", join(home, "absent-config.json")], elsewhere);
    const explicitExit = await waitForExit(explicit);
    assert.equal(explicitExit.code, 1);
    assert.match(explicit.stderr, /cannot read or parse the configuration file/);
    assert.doesNotMatch(explicit.stderr, /no default configuration found/);
    assert.doesNotMatch(explicit.stderr + explicit.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The bare historical form still requires --config and remains an agent
    // form; no gateway is started implicitly.
    const bare = startCli(home, [], elsewhere);
    const bareExit = await waitForExit(bare);
    assert.equal(bareExit.code, 1);
    assert.match(bare.stderr, /Usage: durable-nanobot gateway \[--config <path>\]/);
    assert.match(bare.stderr, /durable-nanobot agent \[--config <path>\] \[--conversation <name>\]/);
    assert.match(bare.stderr, /durable-nanobot recovery \[--config <path>\] \[--cancel/);
    assert.match(bare.stderr, /~\/\.durable-nanobot\/config\.json/);

    const instance = await writeDefaultInstance(home, "gpt-6-luna");
    const legacy = startCli(home, ["--config", join(instance.configDir, "config.json")], elsewhere);
    const legacyExit = await waitForExit(legacy);
    assert.equal(legacyExit.code, 1);
    assert.match(legacy.stderr, /no running gateway answers on this configuration's local endpoint/);
    assert.equal(await pathExists(instance.socketPath), false, "legacy launch opened a gateway/socket");

    // An explicit relative --config keeps its existing base: the process working
    // directory, not the default config home.
    const relative = startCli(home, ["--config", "./config.json"], instance.configDir);
    const relativeExit = await waitForExit(relative);
    assert.equal(relativeExit.code, 1);
    assert.match(relative.stderr, /no running gateway answers on this configuration's local endpoint/);
    assert.doesNotMatch(relative.stderr, /cannot read or parse the configuration file/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("two default-config instances keep distinct sockets, stores and attached configuration", { timeout: 45_000 }, async () => {
  const homeA = await mkdtemp(join(tmpdir(), "nanobot-instance-a-"));
  const homeB = await mkdtemp(join(tmpdir(), "nanobot-instance-b-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "nanobot-instance-cwd-"));
  const a = await writeDefaultInstance(homeA, "gpt-6-luna");
  const b = await writeDefaultInstance(homeB, "gpt-6-sol");
  await writeFile(join(a.workspace, "only-a.txt"), "instance A workspace\n");
  await writeFile(join(b.workspace, "only-b.txt"), "instance B workspace\n");
  let gatewayA;
  let gatewayB;
  let clientA;
  let clientB;
  try {
    gatewayA = startCli(homeA, ["gateway"], elsewhere);
    gatewayB = startCli(homeB, ["gateway"], elsewhere);
    await waitForSocket(gatewayA, a.socketPath, "instance A did not open its socket");
    await waitForSocket(gatewayB, b.socketPath, "instance B did not open its socket");
    assert.notEqual(a.socketPath, b.socketPath);
    assert.notEqual(a.dataDir, b.dataDir);
    assert.equal((await stat(join(a.dataDir, "nanobot.sqlite"))).isFile(), true);
    assert.equal((await stat(join(b.dataDir, "nanobot.sqlite"))).isFile(), true);

    clientA = await connectLocalGateway({ socketPath: a.socketPath, context });
    clientB = await connectLocalGateway({ socketPath: b.socketPath, context });
    assert.equal(clientA.sessionKey, "cli:default");
    assert.equal(clientB.sessionKey, "cli:default");
    const modelsA = await clientA.listModels(context);
    const modelsB = await clientB.listModels(context);
    assert.equal(modelsA.selected.modelId, "gpt-6-luna");
    assert.equal(modelsB.selected.modelId, "gpt-6-sol");
    assert.deepEqual((await clientA.historySearch({ text: "shared-marker", scope: "messages", limit: 5 }, context)).hits, []);
    assert.deepEqual((await clientB.historySearch({ text: "shared-marker", scope: "messages", limit: 5 }, context)).hits, []);
    const digestA = await clientA.digestStatus(context);
    const digestB = await clientB.digestStatus(context);
    assert.equal(digestA.liveTaskId, null);
    assert.equal(digestB.liveTaskId, null);
    assert.deepEqual(await readFile(join(a.workspace, "note.txt"), "utf8"), "workspace for gpt-6-luna\n");
    assert.deepEqual(await readFile(join(b.workspace, "note.txt"), "utf8"), "workspace for gpt-6-sol\n");

    await clientA.close();
    clientA = undefined;
    const stoppedA = await stopCli(gatewayA);
    gatewayA = undefined;
    assert.equal(stoppedA.code, 0);
    await eventually(async () => !(await pathExists(a.socketPath)), "instance A socket was not removed");

    // Instance B is independent and still owns its own store and endpoint.
    const afterA = await clientB.listModels(context);
    assert.equal(afterA.selected.modelId, "gpt-6-sol");
    assert.equal((await clientB.historySearch({ text: "shared-marker", scope: "messages", limit: 5 }, context)).hits.length, 0);
  } finally {
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    if (gatewayA) await stopCli(gatewayA).catch(() => undefined);
    if (gatewayB) await stopCli(gatewayB).catch(() => undefined);
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

/** One in-process synthetic store; no live provider, network or Telegram. */
async function makeSyntheticInstance(label, marker) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-parallel-${label}-`));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "memory", "MEMORY.md"), `# Memory\n\n${marker} memory\n`);
  await writeFile(join(workspace, "note.txt"), `${marker} file\n`);
  const values = {
    workspace: "workspace",
    dataDir: "state",
    model: { provider: `fixture-${label}`, modelId: "alpha" },
    episodeSummary: { enabled: false },
    workspaceContext: { memoryFiles: ["memory/MEMORY.md"] },
  };
  const config = parseConfig(values, directory);
  const faux = fauxProvider({ provider: `fixture-${label}`, models: [
    { id: "alpha", name: `Alpha ${label}`, reasoning: true },
  ] });
  const models = createModels();
  models.setProvider(faux.provider);
  const stop = new AbortController();
  const instanceContext = withAbortSignal(stop.signal, context);
  const gateway = await openGateway(config, instanceContext, {
    models,
    ...workspaceContextGatewayOptions(config),
  });
  const prepared = await prepareDataDirectory(config);
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context: instanceContext,
    tools: [],
    contextRefresh: true,
    presets: false,
  });
  return {
    directory,
    workspace,
    dataDir,
    config,
    faux,
    models,
    stop,
    instanceContext,
    gateway,
    server,
    socketPath,
    async close() {
      await server.close();
      await gateway.close(withoutAbortSignal(instanceContext));
      stop.abort();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("parallel synthetic instances have independent transcripts, files and memory, and one store has one owner", { timeout: 45_000 }, async () => {
  const a = await makeSyntheticInstance("a", "PARALLEL-ALPHA");
  const b = await makeSyntheticInstance("b", "PARALLEL-BETA");
  let clientA;
  let clientB;
  let second;
  try {
    a.faux.setResponses([fauxAssistantMessage("PARALLEL-ALPHA-ANSWER")]);
    b.faux.setResponses([fauxAssistantMessage("PARALLEL-BETA-ANSWER")]);
    clientA = await connectLocalGateway({ socketPath: a.socketPath, context: a.instanceContext });
    clientB = await connectLocalGateway({ socketPath: b.socketPath, context: b.instanceContext });
    const firstA = await clientA.submit("PARALLEL-ALPHA-QUESTION", a.instanceContext);
    const firstB = await clientB.submit("PARALLEL-BETA-QUESTION", b.instanceContext);
    assert.equal((await firstA.wait(a.instanceContext)).status, "done");
    assert.equal((await firstB.wait(b.instanceContext)).status, "done");

    const hitsA = await clientA.historySearch({ text: "PARALLEL-ALPHA-ANSWER", scope: "messages", limit: 5 }, a.instanceContext);
    const hitsB = await clientB.historySearch({ text: "PARALLEL-BETA-ANSWER", scope: "messages", limit: 5 }, b.instanceContext);
    assert.ok(hitsA.hits.length > 0, "instance A transcript is not in its own store");
    assert.ok(hitsB.hits.length > 0, "instance B transcript is not in its own store");
    const crossA = await clientA.historySearch({ text: "PARALLEL-BETA-ANSWER", scope: "messages", limit: 5 }, a.instanceContext);
    const crossB = await clientB.historySearch({ text: "PARALLEL-ALPHA-ANSWER", scope: "messages", limit: 5 }, b.instanceContext);
    assert.deepEqual(crossA.hits, []);
    assert.deepEqual(crossB.hits, []);
    assert.equal(await readFile(join(a.workspace, "note.txt"), "utf8"), "PARALLEL-ALPHA file\n");
    assert.equal(await readFile(join(b.workspace, "note.txt"), "utf8"), "PARALLEL-BETA file\n");
    assert.equal(await readFile(join(a.workspace, "memory", "MEMORY.md"), "utf8"), "# Memory\n\nPARALLEL-ALPHA memory\n");
    assert.equal(await readFile(join(b.workspace, "memory", "MEMORY.md"), "utf8"), "# Memory\n\nPARALLEL-BETA memory\n");

    // A second gateway on instance A's store is refused even inside one process.
    try {
      second = await openGateway(a.config, a.instanceContext, {
        models: a.models,
        ...workspaceContextGatewayOptions(a.config),
      });
    } catch (error) {
      assert.match(error.message, /another process already owns the configured data store/);
    }
    if (second) {
      await second.close(withoutAbortSignal(a.instanceContext));
      second = undefined;
      assert.fail("a second gateway opened the same store");
    }

    // Stopping A leaves B serving its own transcript.
    await clientA.close();
    clientA = undefined;
    await a.server.close();
    await a.gateway.close(withoutAbortSignal(a.instanceContext));
    const stillB = await clientB.historySearch({ text: "PARALLEL-BETA-ANSWER", scope: "messages", limit: 5 }, b.instanceContext);
    assert.ok(stillB.hits.length > 0, "stopping instance A affected instance B");
  } finally {
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    await second?.close(withoutAbortSignal(a.instanceContext)).catch(() => undefined);
    // `a.close` is safe after the explicit stop above only through its own
    // idempotent server/gateway close; remove its directory here.
    await a.server.close().catch(() => undefined);
    await a.gateway.close(withoutAbortSignal(a.instanceContext)).catch(() => undefined);
    a.stop.abort();
    await rm(a.directory, { recursive: true, force: true });
    await b.close();
  }
});

test("bounded teardown of an attached client and an active synthetic run keeps admitted input and releases the store", { timeout: 45_000 }, async () => {
  const instance = await makeSyntheticInstance("teardown", "TEARDOWN");
  let client;
  let reopened;
  const releaseGate = { current: undefined };
  try {
    const gate = new Promise((resolve) => { releaseGate.current = resolve; });
    let entered = false;
    instance.faux.setResponses([
      () => {
        entered = true;
        return gate.then(() => fauxAssistantMessage("TEARDOWN-GATED-ANSWER"));
      },
      fauxAssistantMessage("TEARDOWN-QUEUED-ANSWER"),
    ]);
    client = await connectLocalGateway({ socketPath: instance.socketPath, context: instance.instanceContext });
    const active = await client.submit("TEARDOWN-ACTIVE", instance.instanceContext);
    await eventually(() => entered, "the synthetic run did not reach the provider");
    const queued = await client.submit("TEARDOWN-QUEUED", instance.instanceContext);
    assert.ok(Number.isSafeInteger(queued.id));

    // This is the gateway's SIGTERM path: abort the owner context, close the
    // local endpoint and connected CLIs, then close the store without the
    // aborted context. Release the synthetic gate so teardown is deterministic.
    instance.stop.abort();
    releaseGate.current();
    await client.close();
    client = undefined;
    await instance.server.close();
    await instance.gateway.close(withoutAbortSignal(instance.instanceContext));
    assert.equal(await pathExists(instance.socketPath), false);
    void active;

    // The lock was released and the admitted queued input is still somewhere in
    // the durable store: either still queued or already run by Durable's close.
    const models = createModels();
    models.setProvider(instance.faux.provider);
    reopened = await openGateway(instance.config, context, {
      models,
      ...workspaceContextGatewayOptions(instance.config),
    });
    const conversation = await reopened.conversationFor("cli:default", context);
    const page = await conversation.entries({}, 100, undefined, context);
    const watch = await conversation.watch(context);
    const inbox = JSON.stringify(watch.value.docs["pi.inbox"]?.items ?? []);
    await watch.stop();
    const transcript = JSON.stringify(page.items.map((entry) => entry.model ?? entry));
    assert.match(`${transcript}\n${inbox}`, /TEARDOWN-QUEUED/, "admitted queued input was lost by teardown");
  } finally {
    await client?.close().catch(() => undefined);
    if (reopened) await reopened.close(context).catch(() => undefined);
    await instance.server.close().catch(() => undefined);
    await instance.gateway.close(withoutAbortSignal(instance.instanceContext)).catch(() => undefined);
    instance.stop.abort();
    await rm(instance.directory, { recursive: true, force: true });
  }
});

test("shipped user units are static user-service examples and verify with the real launch paths", { timeout: 30_000 }, async (t) => {
  const primaryPath = join(repoRoot, "systemd", "durable-nanobot.service");
  const templatePath = join(repoRoot, "systemd", "durable-nanobot@.service");
  const primary = await readFile(primaryPath, "utf8");
  const template = await readFile(templatePath, "utf8");
  for (const text of [primary, template]) {
    assert.match(text, /^\[Unit\]/m);
    assert.match(text, /^\[Service\]/m);
    assert.match(text, /^Type=exec$/m);
    assert.match(text, /^Restart=on-failure$/m);
    assert.match(text, /^RestartSec=5s$/m);
    assert.match(text, /^StartLimitIntervalSec=300$/m);
    assert.match(text, /^StartLimitBurst=5$/m);
    assert.match(text, /^KillSignal=SIGTERM$/m);
    assert.match(text, /^KillMode=mixed$/m);
    assert.match(text, /^TimeoutStopSec=45$/m);
    assert.match(text, /^StandardOutput=journal$/m);
    assert.match(text, /^StandardError=journal$/m);
    assert.match(text, /^EnvironmentFile=-%h\//m);
    assert.match(text, /bin\/durable-nanobot\.mjs gateway --config /);
    assert.match(text, /^WantedBy=default.target$/m);
    assert.doesNotMatch(text, /npm start|durable-nanobot\.service\b.*ExecStart|OPENAI|ANTHROPIC|DEEPSEEK_API_KEY|API_KEY=/);
  }
  assert.match(primary, /--config %h\/\.durable-nanobot\/config\.json/);
  assert.match(template, /--config %h\/\.durable-nanobot\/instances\/i-%i\/config\.json/);
  assert.match(template, /EnvironmentFile=-%h\/\.durable-nanobot\/instances\/i-%i\/secrets\.env/);
  // The instance specifier is used only inside the one fixed instances
  // directory (plus the unit description), never as a standalone arbitrary path.
  for (const line of template.split("\n")) {
    if (!/%i/.test(line) || line.startsWith("Description=")) continue;
    assert.match(line, /instances\/i-%i/);
  }

  const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error && probe.error.code === "ENOENT") {
    t.diagnostic("systemd-analyze verify skipped: systemd-analyze is not installed; static unit assertions ran");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  const directory = await mkdtemp(join(tmpdir(), "nanobot-systemd-verify-"));
  try {
    await mkdir(join(directory, "units"));
    const substitute = (text) => text
      .replaceAll("/usr/bin/node", process.execPath)
      .replaceAll("/opt/durable-nanobot", repoRoot);
    await writeFile(join(directory, "units", "durable-nanobot.service"), substitute(primary));
    await writeFile(join(directory, "units", "durable-nanobot@demo.service"), substitute(template));
    const verified = spawnSync("systemd-analyze", [
      "verify",
      "--man=no",
      join(directory, "units", "durable-nanobot.service"),
      join(directory, "units", "durable-nanobot@demo.service"),
    ], { encoding: "utf8", timeout: 20_000 });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
