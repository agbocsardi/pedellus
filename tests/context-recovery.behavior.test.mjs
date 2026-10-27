import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { listPreparedContextBlocks, cancelPreparedContextBlock } = await import(
  pathToFileURL(`${pkg}/dist/recovery/index.js`).href
);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { getCurrentSystemPrompt } = await import(pathToFileURL(`${ai}/utils/transcript.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;

const runtimeUrl = JSON.stringify(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const configModuleUrl = JSON.stringify(pathToFileURL(`${pkg}/dist/config.js`).href);
const aiUrl = JSON.stringify(pathToFileURL(`${ai}/index.js`).href);
const chordContextUrl = JSON.stringify(pathToFileURL(`${chord}/context/index.js`).href);

function gatewayConfig(workspace, dataDir, provider) {
  const model = { provider, modelId: "synthetic" };
  return parseConfig({ workspace, dataDir, model, allowedModels: [model] }, resolve(workspace, ".."));
}

function offlineModels(providerId) {
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic" }] });
  provider.setResponses([]);
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider };
}

function childError(stderr) {
  return new Error(`child failed: ${stderr}`);
}

async function waitForMarkers(child, marker, count, getStderr, timeoutMs = 10_000) {
  let stdout = "";
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`timed out waiting for ${count} ${marker}: ${getStderr()}`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    const onData = (chunk) => {
      stdout += chunk;
      if (stdout.split(marker).length - 1 >= count) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolveReady();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => { clearTimeout(timeout); rejectReady(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`child exited before ${marker} (${code}, ${signal}): ${getStderr()}`));
    });
  });
}

function startChild(script) {
  let stderr = "";
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

async function killAndWait(child) {
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  assert.equal(child.kill("SIGKILL"), true);
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
}

function generationCrashScript({ workspace, dataDir, temp, providerId, sessions, secretPrefix }) {
  return `
    const { openGateway } = await import(${runtimeUrl});
    const { parseConfig } = await import(${configModuleUrl});
    const { createModels, fauxProvider } = await import(${aiUrl});
    const { BACKGROUND_CONTEXT } = await import(${chordContextUrl});
    const context = BACKGROUND_CONTEXT;
    const sessions = ${JSON.stringify(sessions)};
    const provider = fauxProvider({ provider: ${JSON.stringify(providerId)}, models: [{ id: "synthetic" }] });
    provider.setResponses(sessions.map(() => () => {
      process.stdout.write("DISPATCHED\\n");
      return new Promise(() => {});
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const model = { provider: ${JSON.stringify(providerId)}, modelId: "synthetic" };
    const config = parseConfig({ workspace: ${JSON.stringify(workspace)}, dataDir: ${JSON.stringify(dataDir)}, model, allowedModels: [model] }, ${JSON.stringify(temp)});
    const gateway = await openGateway(config, context, {
      models,
      contextSnapshotProvider: (sessionKey) => ({
        identity: { source: "synthetic", content: ${JSON.stringify(secretPrefix)} + sessionKey },
      }),
    });
    for (const key of sessions) {
      const conversation = await gateway.conversationFor(key, context);
      await conversation.submit({ type: "input", content: "request " + key, requestId: "req-" + key }, context);
    }
    setInterval(() => {}, 1000);
  `;
}

function compactionCrashScript({ workspace, dataDir, temp, providerId, secretPrefix }) {
  return `
    const { openGateway } = await import(${runtimeUrl});
    const { parseConfig } = await import(${configModuleUrl});
    const { createModels, fauxAssistantMessage, fauxProvider } = await import(${aiUrl});
    const { BACKGROUND_CONTEXT } = await import(${chordContextUrl});
    const context = BACKGROUND_CONTEXT;
    const provider = fauxProvider({ provider: ${JSON.stringify(providerId)}, models: [{ id: "synthetic" }] });
    provider.setResponses([
      () => fauxAssistantMessage("ok-1"),
      () => fauxAssistantMessage("ok-2"),
      () => fauxAssistantMessage("ok-3"),
      () => {
        process.stdout.write("COMPACTION_DISPATCHED\\n");
        return new Promise(() => {});
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const model = { provider: ${JSON.stringify(providerId)}, modelId: "synthetic" };
    const config = parseConfig({ workspace: ${JSON.stringify(workspace)}, dataDir: ${JSON.stringify(dataDir)}, model, allowedModels: [model] }, ${JSON.stringify(temp)});
    const gateway = await openGateway(config, context, {
      models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: ${JSON.stringify(secretPrefix)} } }),
    });
    const conversation = await gateway.conversationFor("compaction-session", context);
    for (const [index, text] of ["early turn", "x".repeat(90_000), "recent turn"].entries()) {
      const submission = await conversation.submit({ type: "input", content: text, requestId: "turn-" + index }, context);
      const settled = await submission.wait(context);
      if (settled.status !== "done") throw new Error("turn did not settle");
    }
    await conversation.compact(undefined, context);
    setInterval(() => {}, 1000);
  `;
}

async function writeConfig(temp, workspace, dataDir, providerId) {
  const path = resolve(temp, "config.json");
  await writeFile(path, JSON.stringify({
    workspace,
    dataDir,
    model: { provider: providerId, modelId: "synthetic" },
    allowedModels: [{ provider: providerId, modelId: "synthetic" }],
  }));
  return path;
}

async function runRecoveryCli(configFile, args = []) {
  const cli = spawn(process.execPath, [resolve(pkg, "dist/cli.js"), "recovery", "--config", configFile, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolveExit) => cli.once("exit", (code, signal) => resolveExit({ code, signal })));
  return { ...exit, stdout, stderr };
}

test("owner recovery cancels a SIGKILLed prepared request without replay or transcript loss", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-request-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-request";
  await mkdir(workspace);
  let child;
  let gateway;
  try {
    const started = startChild(generationCrashScript({
      workspace, dataDir, temp, providerId,
      sessions: ["session-a"],
      secretPrefix: "old-secret-",
    }));
    child = started.child;
    await waitForMarkers(child, "DISPATCHED", 1, started.stderr);
    await killAndWait(child);
    child = undefined;

    const config = gatewayConfig(workspace, dataDir, providerId);
    const configFile = await writeConfig(temp, workspace, dataDir, providerId);
    const cli = await runRecoveryCli(configFile);
    assert.deepEqual({ code: cli.code, signal: cli.signal }, { code: 0, signal: null }, cli.stderr);
    const listed = JSON.parse(cli.stdout);
    assert.equal(listed.blocked.length, 1);
    const block = listed.blocked[0];
    assert.equal(block.kind, "pi.generation");
    assert.equal(block.phase, "request");
    assert.ok(Number.isSafeInteger(block.conversationId) && block.conversationId > 0);
    assert.match(block.fingerprint, /^[0-9a-f]{64}$/);

    const changed = offlineModels(providerId);
    await assert.rejects(
      openGateway(config, context, {
        models: changed.models,
        contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "changed-secret" } }),
      }),
      /prepared request includes persisted Nanobot context/,
    );
    const unchanged = offlineModels(providerId);
    await assert.rejects(
      openGateway(config, context, {
        models: unchanged.models,
        contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "old-secret-session-a" } }),
      }),
      /prepared request includes persisted Nanobot context/,
    );
    const optedOut = offlineModels(providerId);
    await assert.rejects(
      openGateway(config, context, { models: optedOut.models }),
      /prepared request includes persisted Nanobot context/,
    );
    assert.equal(changed.provider.state.callCount, 0);
    assert.equal(unchanged.provider.state.callCount, 0);
    assert.equal(optedOut.provider.state.callCount, 0);

    await assert.rejects(
      cancelPreparedContextBlock(config, { taskId: block.taskId, fingerprint: "0".repeat(64) }, context),
      /changed since inspection/,
    );
    assert.equal((await listPreparedContextBlocks(config, context)).length, 1, "rejected cancel must not mark or lock");
    const cancelled = await cancelPreparedContextBlock(
      config,
      { taskId: block.taskId, fingerprint: block.fingerprint },
      context,
    );
    assert.deepEqual(cancelled, { status: "abort-marked", taskId: block.taskId });
    assert.deepEqual(await listPreparedContextBlocks(config, context), []);
    await assert.rejects(
      cancelPreparedContextBlock(config, { taskId: block.taskId, fingerprint: block.fingerprint }, context),
      /not a live prepared dispatch/,
    );

    const reopened = offlineModels(providerId);
    const captured = [];
    gateway = await openGateway(config, context, {
      models: reopened.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "fresh-secret" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.provider.state.callCount, 0, "the cancelled prepared request must not be resent");
    const task = await gateway.harness.getTask(block.taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "aborted");

    const conversation = await gateway.conversationFor("session-a", context);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const userTexts = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    assert.ok(userTexts.includes("request session-a"), "original transcript must remain stored");

    reopened.provider.setResponses([(request) => {
      captured.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("fresh reply");
    }]);
    const submission = await conversation.submit({ type: "input", content: "after recovery", requestId: "after" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(captured.length, 1);
    assert.match(captured[0], /fresh-secret/);
    assert.doesNotMatch(captured[0], /old-secret/);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("concurrent prepared requests are cancelled one at a time and the lock is released", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-concurrent-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-concurrent";
  await mkdir(workspace);
  let child;
  let gateway;
  try {
    const started = startChild(generationCrashScript({
      workspace, dataDir, temp, providerId,
      sessions: ["one", "two"],
      secretPrefix: "old-secret-",
    }));
    child = started.child;
    await waitForMarkers(child, "DISPATCHED", 2, started.stderr);
    await killAndWait(child);
    child = undefined;

    const config = gatewayConfig(workspace, dataDir, providerId);
    const configFile = await writeConfig(temp, workspace, dataDir, providerId);
    const blocks = await listPreparedContextBlocks(config, context);
    assert.equal(blocks.length, 2);
    const [first, second] = blocks;
    assert.ok(first && second);

    const cliCancel = await runRecoveryCli(configFile, [
      "--cancel", String(first.taskId), "--fingerprint", first.fingerprint,
    ]);
    assert.deepEqual({ code: cliCancel.code, signal: cliCancel.signal }, { code: 0, signal: null }, cliCancel.stderr);
    assert.deepEqual(JSON.parse(cliCancel.stdout), { status: "abort-marked", taskId: first.taskId });
    const remaining = await listPreparedContextBlocks(config, context);
    assert.deepEqual(remaining.map((block) => block.taskId), [second.taskId]);

    const blockedOpen = offlineModels(providerId);
    await assert.rejects(
      openGateway(config, context, {
        models: blockedOpen.models,
        contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "current context" } }),
      }),
      /prepared request includes persisted Nanobot context/,
    );
    assert.equal(blockedOpen.provider.state.callCount, 0);

    assert.deepEqual(
      await cancelPreparedContextBlock(config, { taskId: second.taskId, fingerprint: second.fingerprint }, context),
      { status: "abort-marked", taskId: second.taskId },
    );
    assert.deepEqual(await listPreparedContextBlocks(config, context), []);

    const reopened = offlineModels(providerId);
    gateway = await openGateway(config, context, { models: reopened.models });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.provider.state.callCount, 0);
    for (const block of [first, second]) {
      const task = await gateway.harness.getTask(block.taskId, context);
      assert.ok(task);
      assert.equal(task.state.status, "terminal");
      assert.equal(task.state.outcome.status, "aborted");
    }
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("owner recovery cancels a prepared compaction without resummarizing stale context", { timeout: 40_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-compaction-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-compaction";
  await mkdir(workspace);
  let child;
  let gateway;
  try {
    const started = startChild(compactionCrashScript({
      workspace, dataDir, temp, providerId,
      secretPrefix: "old-compaction-secret",
    }));
    child = started.child;
    await waitForMarkers(child, "COMPACTION_DISPATCHED", 1, started.stderr, 20_000);
    await killAndWait(child);
    child = undefined;

    const config = gatewayConfig(workspace, dataDir, providerId);
    const blocks = await listPreparedContextBlocks(config, context);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.kind, "pi.compaction");
    assert.equal(block.phase, "summarize");
    assert.ok(block.at > 0);

    const blockedOpen = offlineModels(providerId);
    await assert.rejects(
      openGateway(config, context, {
        models: blockedOpen.models,
        contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "old-compaction-secret" } }),
      }),
      /prepared request includes persisted Nanobot context/,
    );
    assert.equal(blockedOpen.provider.state.callCount, 0);

    assert.deepEqual(
      await cancelPreparedContextBlock(config, { taskId: block.taskId, fingerprint: block.fingerprint }, context),
      { status: "abort-marked", taskId: block.taskId },
    );

    const reopened = offlineModels(providerId);
    gateway = await openGateway(config, context, { models: reopened.models });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.provider.state.callCount, 0, "the cancelled compaction must not be sent again");
    const task = await gateway.harness.getTask(block.taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "aborted");

    const conversation = await gateway.conversationFor("compaction-session", context);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const hasLargeTurn = entries.items.some((entry) =>
      (entry.model ?? []).some((message) => message.role === "user" &&
        (typeof message.content === "string" ? message.content.length > 80_000 : false)));
    assert.equal(hasLargeTurn, true, "original transcript must remain stored");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});
