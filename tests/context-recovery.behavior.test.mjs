import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { cp, copyFile, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const durable = `${pkg}/node_modules/@earendil-works/pi-durable/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { listPreparedContextBlocks, cancelPreparedContextBlock } = await import(
  pathToFileURL(`${pkg}/dist/recovery/index.js`).href
);
const { preparedResponseEvidence } = await import(pathToFileURL(`${pkg}/dist/recovery/prepared.js`).href);
const { CronDeliveriesDoc } = await import(pathToFileURL(`${pkg}/dist/automation/cron-delivery.js`).href);
const { TurnInterruptionMarksDoc, TURN_INTERRUPTION_NOTICE } = await import(
  pathToFileURL(`${pkg}/dist/recovery/interruption.js`).href
);
const { serveLocalGateway, gatewaySocketPath } = await import(
  pathToFileURL(`${pkg}/dist/local/server.js`).href
);
const { connectLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { getCurrentSystemPrompt } = await import(pathToFileURL(`${ai}/utils/transcript.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const { createRegistry, defineTask, Harness, LiveDoc } = await import(pathToFileURL(`${durable}/index.js`).href);
const { openFullSyncNodeSqliteStorage } = await import(pathToFileURL(`${pkg}/dist/storage/sqlite.js`).href);
const { workspaceContextGatewayOptions } = await import(
  pathToFileURL(`${pkg}/dist/context/workspace-host.js`).href
);
const context = BACKGROUND_CONTEXT;

const runtimeUrl = JSON.stringify(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const configModuleUrl = JSON.stringify(pathToFileURL(`${pkg}/dist/config.js`).href);
const aiUrl = JSON.stringify(pathToFileURL(`${ai}/index.js`).href);
const chordContextUrl = JSON.stringify(pathToFileURL(`${chord}/context/index.js`).href);

function gatewayConfig(workspace, dataDir, provider, defaultModelId = "synthetic", allowedModelIds = [defaultModelId], extra = {}) {
  const model = { provider, modelId: defaultModelId };
  const allowedModels = allowedModelIds.map((modelId) => ({ provider, modelId }));
  return parseConfig({ workspace, dataDir, model, allowedModels, ...extra }, resolve(workspace, ".."));
}

function offlineModels(providerId) {
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic" }] });
  provider.setResponses([]);
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider };
}

function syntheticGenerationTask(version, phase) {
  return defineTask({
    name: "pi.generation",
    version,
    initial: (input) => input.checkpoint,
    phases: {
      [phase]: async () => { throw new Error("synthetic task must never run"); },
    },
    abort: async () => { throw new Error("synthetic task must never take its own abort path"); },
  });
}

async function withRawHarness(config, models, run) {
  const storage = await openFullSyncNodeSqliteStorage(resolve(config.dataDir, "nanobot.sqlite"), context);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    return await run(harness);
  } finally {
    await harness.close(context);
  }
}

async function createSyntheticTask(config, models, conversationId, task, checkpoint) {
  return withRawHarness(config, models, (harness) => harness.commit(
    (tx) => tx.createTask(task, { checkpoint }, {
      ownership: { kind: "conversation" },
      conversationId,
    }),
    context,
  ));
}

async function seedContextStore({ workspace, dataDir, providerId, secret, modelIds = ["synthetic"], defaultModelId }) {
  const provider = fauxProvider({
    provider: providerId,
    models: modelIds.map((id) => ({ id })),
  });
  provider.setResponses([() => fauxAssistantMessage("seeded reply")]);
  const models = createModels();
  models.setProvider(provider.provider);
  const config = gatewayConfig(
    workspace,
    dataDir,
    providerId,
    defaultModelId ?? modelIds[0],
    modelIds,
  );
  const gateway = await openGateway(config, context, {
    models,
    contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: secret } }),
  });
  try {
    const conversation = await gateway.conversationFor("synthetic-task", context);
    const submission = await conversation.submit({ type: "input", content: "seed turn", requestId: "seed" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const latest = await conversation.entries({ order: "descending" }, 1, undefined, context);
    const cutoff = latest.items[0]?.id;
    assert.ok(cutoff);
    return { config, models, provider, conversationId: conversation.id, cutoff };
  } finally {
    await gateway.close(context);
  }
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

function generationCrashScript({ workspace, dataDir, temp, providerId, modelId = "synthetic", sessions, secretPrefix }) {
  return `
    const { openGateway } = await import(${runtimeUrl});
    const { parseConfig } = await import(${configModuleUrl});
    const { createModels, fauxProvider } = await import(${aiUrl});
    const { BACKGROUND_CONTEXT } = await import(${chordContextUrl});
    const context = BACKGROUND_CONTEXT;
    const sessions = ${JSON.stringify(sessions)};
    const provider = fauxProvider({ provider: ${JSON.stringify(providerId)}, models: [{ id: ${JSON.stringify(modelId)} }] });
    provider.setResponses(sessions.map(() => () => {
      process.stdout.write("DISPATCHED\\n");
      return new Promise(() => {});
    }));
    const models = createModels();
    models.setProvider(provider.provider);
    const model = { provider: ${JSON.stringify(providerId)}, modelId: ${JSON.stringify(modelId)} };
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

async function writeConfig(temp, workspace, dataDir, providerId, modelId = "synthetic", credentials) {
  const path = resolve(temp, "config.json");
  await writeFile(path, JSON.stringify({
    workspace,
    dataDir,
    model: { provider: providerId, modelId },
    allowedModels: [{ provider: providerId, modelId }],
    ...(credentials === undefined ? {} : { credentials }),
  }));
  return path;
}

async function runStartupCli(configFile, options = {}) {
  const cli = spawn(process.execPath, [resolve(pkg, "dist/cli.js"), "gateway", "--config", configFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", (chunk) => { stdout += chunk; });
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => cli.kill("SIGKILL"), options.timeoutMs ?? 10_000);
  try {
    const exit = await new Promise((resolveExit) => cli.once("exit", (code, signal) => resolveExit({ code, signal })));
    return { ...exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
  }
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
    assert.equal(block.response, "unrecorded",
      "a dispatched request without a committed partial records no response");
    assert.match(block.fingerprint, /^[0-9a-f]{64}$/);

    // The explicit owner path stays available even though normal startup would auto-recover; this
    // test keeps the task blocked until the recovery command marks it.
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
    assert.equal(await gateway.harness.snapshot(CronDeliveriesDoc, block.conversationId, context), undefined,
      "an owner cancellation must not acquire an interruption notice");

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

test("automatic startup recovery cancels a blocked prepared turn and records one durable notice", { timeout: 40_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-startup-prepared-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-startup";
  await mkdir(workspace);
  let child;
  let gateway;
  let server;
  let client;
  try {
    const started = startChild(generationCrashScript({
      workspace, dataDir, temp, providerId,
      sessions: ["cli:default"],
      secretPrefix: "old-startup-secret-",
    }));
    child = started.child;
    await waitForMarkers(child, "DISPATCHED", 1, started.stderr);
    await killAndWait(child);
    child = undefined;

    const config = gatewayConfig(workspace, dataDir, providerId);
    const blocks = await listPreparedContextBlocks(config, context);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.phase, "request");

    const first = offlineModels(providerId);
    gateway = await openGateway(config, context, {
      models: first.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "fresh-startup-secret" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(first.provider.state.callCount, 0, "automatic recovery must not dispatch or replay a model request");
    const task = await gateway.harness.getTask(block.taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "aborted");

    let conversation = await gateway.conversationFor("cli:default", context);
    assert.equal(conversation.id, block.conversationId);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.ok(entries.items.some((entry) => (entry.model ?? []).some((message) =>
      message.role === "user" && message.content === "request cli:default")),
    "the interrupted turn's stored input must remain");

    const noticeId = `host:turn-interrupted:${block.taskId}`;
    const outbox = await gateway.harness.snapshot(CronDeliveriesDoc, block.conversationId, context);
    const notices = outbox.deliveries.filter((record) => record.id === noticeId);
    assert.equal(notices.length, 1, "one notice for the interrupted turn");
    assert.equal(notices[0].status, "pending");
    assert.equal(notices[0].text, TURN_INTERRUPTION_NOTICE);
    assert.equal(notices[0].sessionKey, "cli:default");

    // Reopen: the same one notice remains, no mark is left, and no model request is made.
    await gateway.close(context);
    gateway = undefined;
    const second = offlineModels(providerId);
    gateway = await openGateway(config, context, {
      models: second.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "fresh-startup-secret" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(second.provider.state.callCount, 0);
    const reopenedOutbox = await gateway.harness.snapshot(CronDeliveriesDoc, block.conversationId, context);
    assert.equal(reopenedOutbox.deliveries.filter((record) => record.id === noticeId).length, 1,
      "a reopen must not duplicate the notice");
    const marks = await gateway.harness.snapshot(TurnInterruptionMarksDoc, context);
    assert.deepEqual(marks?.marks ?? [], []);

    // A reattached CLI sees the notice once, then acknowledges it without a model turn.
    const socketPath = gatewaySocketPath(config.dataDir);
    server = await serveLocalGateway({
      socketPath, gateway, context, tools: [], contextRefresh: false, presets: false,
    });
    client = await connectLocalGateway({ socketPath, conversation: undefined, context });
    assert.deepEqual(client.pendingNotices.map((notice) => notice.text), [TURN_INTERRUPTION_NOTICE]);
    await client.ackNotices(client.pendingNotices.map((notice) => notice.id), context);
    await client.close();
    client = undefined;
    const delivered = await gateway.harness.snapshot(CronDeliveriesDoc, block.conversationId, context);
    assert.equal(delivered.deliveries.find((record) => record.id === noticeId).status, "delivered");

    client = await connectLocalGateway({ socketPath, conversation: undefined, context });
    assert.equal(client.pendingNotices.length, 0, "a delivered notice is not repeated on reattach");
    await client.close();
    client = undefined;
    client = await connectLocalGateway({ socketPath, conversation: "other", context });
    assert.equal(client.pendingNotices.length, 0, "a notice is never shown to another CLI chat");
    await client.close();
    client = undefined;

    // Continuation is the owner's explicit next input; it renders the fresh context exactly once.
    conversation = await gateway.conversationFor("cli:default", context);
    const captured = [];
    second.provider.setResponses([(request) => {
      captured.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("fresh reply");
    }]);
    const submission = await conversation.submit({ type: "input", content: "after recovery", requestId: "after-auto" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(captured.length, 1);
    assert.match(captured[0], /fresh-startup-secret/);
    assert.doesNotMatch(captured[0], /old-startup-secret/);
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (server) await server.close().catch(() => undefined);
    if (gateway) await gateway.close(context);
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(temp, { recursive: true, force: true });
  }
});

test("a crash after the durable abort mark still delivers one notice on reopen", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-abort-window-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-abort-window";
  await mkdir(workspace);
  let child;
  let gateway;
  try {
    const started = startChild(generationCrashScript({
      workspace, dataDir, temp, providerId,
      sessions: ["cli:default"],
      secretPrefix: "old-window-secret-",
    }));
    child = started.child;
    await waitForMarkers(child, "DISPATCHED", 1, started.stderr);
    await killAndWait(child);
    child = undefined;

    const config = gatewayConfig(workspace, dataDir, providerId);
    const blocks = await listPreparedContextBlocks(config, context);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    // Recreate the crash window: the native abort mark and its pending interruption mark are durable,
    // but the notice admission and the abort protocol have not run.
    await withRawHarness(config, offlineModels(providerId).models, async (harness) => {
      await harness.abortTask(block.taskId, context);
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnInterruptionMarksDoc);
        doc.marks = [{
          taskId: block.taskId,
          kind: block.kind,
          originConversationId: block.conversationId,
          sessionKey: "cli:default",
          createdAtMs: 1,
        }];
      }, context);
      const marked = await harness.getTask(block.taskId, context);
      assert.ok(marked);
      assert.equal(marked.state.status, "pending");
      assert.equal(marked.abortRequested, true);
    });

    const reopened = offlineModels(providerId);
    gateway = await openGateway(config, context, {
      models: reopened.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "fresh-window-secret" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.provider.state.callCount, 0, "the interrupted request must not be resent");
    const task = await gateway.harness.getTask(block.taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "aborted");
    const noticeId = `host:turn-interrupted:${block.taskId}`;
    const outbox = await gateway.harness.snapshot(CronDeliveriesDoc, block.conversationId, context);
    assert.equal(outbox.deliveries.filter((record) => record.id === noticeId).length, 1);
    assert.equal(outbox.deliveries.find((record) => record.id === noticeId).status, "pending");
    const marks = await gateway.harness.snapshot(TurnInterruptionMarksDoc, context);
    assert.deepEqual(marks?.marks ?? [], [], "the crash window must clear its mark in the notice commit");
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

    // The remaining dispatch is still blocked for an owner decision; automatic recovery is
    // exercised separately and would cancel it if the gateway were opened here.

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
    assert.equal(block.response, "unrecorded", "compaction records no dispatch marker");

    // The explicit owner path stays available; automatic startup recovery is covered separately.

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

test("unreadable live state is not evidence that a request was never dispatched", () => {
  const replay = { id: 1, kind: "pi.generation", phase: "request", attempt: 1 };
  for (const live of [null, [], "unreadable", 1]) {
    assert.throws(() => preparedResponseEvidence(replay, live), /Cannot safely inspect/);
  }
});

test("a prepared compaction retry replays no host context and resumes its own next attempt", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-compaction-retry-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-compaction-retry";
  await mkdir(workspace);
  let gateway;
  try {
    const seeded = await seedContextStore({
      workspace, dataDir, providerId, secret: "retry-pinned-context", modelIds: ["synthetic"],
    });
    await withRawHarness(seeded.config, seeded.models, async (harness) => {
      const conversation = await harness.conversation(seeded.conversationId, context);
      const view = await conversation.context(context, { at: seeded.cutoff });
      assert.match(JSON.stringify(view.messages), /retry-pinned-context/,
        "the pinned range contains host context that the old guard would reject");
    });
    // A compaction `retry` checkpoint is committed only after the previous attempt's response
    // arrived and its retryable error was stored; the attempt it schedules still has to commit its
    // own `summarize` checkpoint, so this record proves that attempt was never dispatched.
    const checkpoint = {
      phase: "retry",
      attempt: 1,
      model: { provider: providerId, modelId: "synthetic" },
      thinkingLevel: "off",
      streamOptions: {},
      maxTokens: 1000,
      tail: seeded.cutoff,
      firstKept: seeded.cutoff,
      until: Date.now() - 1,
    };
    const taskId = await withRawHarness(seeded.config, seeded.models, (harness) => harness.commit(
      (tx) => tx.createTask(
        defineTask({
          name: "pi.compaction",
          version: 1,
          initial: () => checkpoint,
          phases: {
            summarize: async () => { throw new Error("synthetic compaction must never summarize"); },
            retry: async () => { throw new Error("synthetic compaction must never retry"); },
          },
        }),
        { reason: "manual" },
        { ownership: { kind: "conversation" }, conversationId: seeded.conversationId },
      ),
      context,
    ));

    assert.deepEqual(await listPreparedContextBlocks(seeded.config, context), [],
      "a retry checkpoint replays neither host context nor an unrecorded request");

    const callsBefore = seeded.provider.state.callCount;
    const summarizeMessages = [];
    seeded.provider.setResponses([(request) => {
      summarizeMessages.push(request.messages);
      return fauxAssistantMessage("summary of the earlier turn");
    }]);
    gateway = await openGateway(seeded.config, context, {
      models: seeded.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "retry-fresh-context" } }),
    });
    await gateway.harness.waitForIdle(context);

    assert.equal(seeded.provider.state.callCount, callsBefore + 1, "resume sends exactly the next summarize attempt");
    assert.equal(summarizeMessages.length, 1);
    const summarizeText = JSON.stringify(summarizeMessages[0]);
    assert.match(summarizeText, /seed turn/, "the immutable entry range is still summarized");
    assert.doesNotMatch(summarizeText, /retry-pinned-context/,
      "the summarization request omits every persisted Nanobot system section");
    assert.doesNotMatch(summarizeText, /retry-fresh-context/,
      "the summarization request carries no freshly rendered host context either");

    const task = await gateway.harness.getTask(taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "completed");
    const conversation = await gateway.conversationFor("synthetic-task", context);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const summary = entries.items.find((entry) => entry.kind === "pi.compaction");
    assert.ok(summary, "the resumed summary is placed");
    assert.equal(summary.head, seeded.cutoff, "the summary keeps the pinned first entry");
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("cancellation reports immediate orphaned settlement instead of a bare abort marker", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-orphan-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-orphan";
  await mkdir(workspace);
  let gateway;
  try {
    const seeded = await seedContextStore({
      workspace, dataDir, providerId, secret: "orphan-context", modelIds: ["synthetic"],
    });
    const taskId = await createSyntheticTask(
      seeded.config,
      seeded.models,
      seeded.conversationId,
      syntheticGenerationTask(999, "request"),
      {
        phase: "request",
        attempt: 1,
        model: { provider: providerId, modelId: "synthetic" },
        thinkingLevel: "off",
        streamOptions: {},
        cutoff: seeded.cutoff,
      },
    );
    const blocks = await listPreparedContextBlocks(seeded.config, context);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].taskId, taskId);
    assert.equal(blocks[0].response, "not-dispatched",
      "no live attempt marker proves the request phase never began");
    assert.deepEqual(
      await cancelPreparedContextBlock(
        seeded.config,
        { taskId, fingerprint: blocks[0].fingerprint },
        context,
      ),
      { status: "orphaned", taskId },
    );
    assert.deepEqual(await listPreparedContextBlocks(seeded.config, context), []);

    gateway = await openGateway(seeded.config, context, { models: offlineModels(providerId).models });
    await gateway.harness.waitForIdle(context);
    const task = await gateway.harness.getTask(taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "orphaned");
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("a committed partial response is reported before recovery cancels the dispatch", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-partial-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-partial";
  await mkdir(workspace);
  let gateway;
  try {
    const seeded = await seedContextStore({
      workspace, dataDir, providerId, secret: "partial-context", modelIds: ["synthetic"],
    });
    // The request phase commits its attempt marker and then a throttled partial of the streaming
    // response before it can classify anything; recreate exactly that durable state.
    const taskId = await withRawHarness(seeded.config, seeded.models, (harness) => harness.commit(
      async (tx) => {
        (await tx.doc(LiveDoc, seeded.conversationId)).generation = {
          attempt: 1,
          message: fauxAssistantMessage("partial text"),
        };
        return tx.createTask(syntheticGenerationTask(999, "request"), {
          checkpoint: {
            phase: "request",
            attempt: 1,
            model: { provider: providerId, modelId: "synthetic" },
            thinkingLevel: "off",
            streamOptions: {},
            cutoff: seeded.cutoff,
          },
        }, {
          ownership: { kind: "conversation" },
          conversationId: seeded.conversationId,
        });
      },
      context,
    ));

    const blocks = await listPreparedContextBlocks(seeded.config, context);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].taskId, taskId);
    assert.equal(blocks[0].response, "partial-response",
      "a committed partial proves the provider stream produced content");

    assert.deepEqual(
      await cancelPreparedContextBlock(
        seeded.config,
        { taskId, fingerprint: blocks[0].fingerprint },
        context,
      ),
      { status: "orphaned", taskId },
    );
    const opened = offlineModels(providerId);
    gateway = await openGateway(seeded.config, context, { models: opened.models });
    await gateway.harness.waitForIdle(context);
    assert.equal(opened.provider.state.callCount, 0, "the partial dispatch must not be restarted");
    const task = await gateway.harness.getTask(taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "orphaned");
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("a revoked poll model stays fail-closed and never reaches cancelDeferred", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-poll-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-poll";
  await mkdir(workspace);
  let gateway;
  try {
    const seeded = await seedContextStore({
      workspace, dataDir, providerId, secret: "poll-context",
      modelIds: ["alpha", "beta"], defaultModelId: "beta",
    });
    const taskId = await createSyntheticTask(
      seeded.config,
      seeded.models,
      seeded.conversationId,
      syntheticGenerationTask(1, "poll"),
      {
        phase: "poll",
        attempt: 1,
        model: { provider: providerId, modelId: "alpha" },
        cutoff: seeded.cutoff,
        handle: {
          provider: providerId,
          modelId: "alpha",
          api: seeded.provider.api,
          id: "deferred:synthetic",
        },
        pollAt: Date.now() + 3_600_000,
      },
    );
    const blocks = await listPreparedContextBlocks(seeded.config, context);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].phase, "poll");
    assert.equal(blocks[0].response, "deferred-response",
      "a poll checkpoint is committed with the received deferred handle");
    assert.deepEqual(
      await cancelPreparedContextBlock(
        seeded.config,
        { taskId, fingerprint: blocks[0].fingerprint },
        context,
      ),
      { status: "abort-marked", taskId },
    );
    assert.deepEqual(await listPreparedContextBlocks(seeded.config, context), []);

    const callsBefore = seeded.provider.state.callCount;
    const revoked = gatewayConfig(workspace, dataDir, providerId, "beta", ["beta"]);
    await assert.rejects(
      openGateway(revoked, context, { models: seeded.models }),
      /prepared model .* is outside allowedModels/,
    );
    assert.equal(seeded.provider.state.cancelledDeferred.length, 0, "revoked poll must not cancel remotely");
    assert.equal(seeded.provider.state.callCount, callsBefore);

    const authorized = gatewayConfig(workspace, dataDir, providerId, "beta", ["alpha", "beta"]);
    gateway = await openGateway(authorized, context, { models: seeded.models });
    await gateway.harness.waitForIdle(context);
    assert.equal(seeded.provider.state.cancelledDeferred.length, 1, "authorized poll abort may cancel its deferred handle");
    assert.equal(seeded.provider.state.callCount, callsBefore, "abort must not dispatch a model request");
    const task = await gateway.harness.getTask(taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "aborted");
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("recovery reports a live gateway lock conflict instead of an empty result", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-lock-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  const providerId = "recovery-lock";
  await mkdir(workspace);
  const config = gatewayConfig(workspace, dataDir, providerId);
  const held = offlineModels(providerId);
  let gateway;
  try {
    gateway = await openGateway(config, context, { models: held.models });
    const startupConfig = await writeConfig(
      temp, workspace, dataDir, "deepseek", "deepseek-flash", { deepseek: "NANOBOT_SYNTHETIC_KEY" },
    );
    const refused = await runStartupCli(startupConfig, {
      env: { NANOBOT_SYNTHETIC_KEY: "synthetic-not-a-key" },
    });
    assert.deepEqual({ code: refused.code, signal: refused.signal }, { code: 1, signal: null }, refused.stderr);
    assert.match(refused.stderr, /durable-nanobot: another process already owns the configured data store/);
    assert.match(refused.stderr, /stop the other running durable-nanobot gateway process/);
    assert.match(refused.stderr, /diagnostic details suppressed/);
    assert.ok(!refused.stderr.includes(temp), "lock diagnostic must not disclose the data path or lock name");
    assert.ok(!refused.stderr.includes(dataDir), "lock diagnostic must not disclose the data path or lock name");
    await assert.rejects(
      listPreparedContextBlocks(config, context),
      /another live owner holds it/,
    );
    await assert.rejects(
      cancelPreparedContextBlock(config, { taskId: 1, fingerprint: "0".repeat(64) }, context),
      /another live owner holds it/,
    );
  } finally {
    if (gateway) await gateway.close(context);
  }
  try {
    assert.deepEqual(await listPreparedContextBlocks(config, context), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("recovery refuses missing data directories or databases before creating a store", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-recovery-missing-"));
  const workspace = resolve(temp, "workspace");
  const missingDataDir = resolve(temp, "typo-state");
  const emptyDataDir = resolve(temp, "empty-state");
  const providerId = "recovery-missing";
  await mkdir(workspace);
  try {
    const missing = gatewayConfig(workspace, missingDataDir, providerId);
    await assert.rejects(
      listPreparedContextBlocks(missing, context),
      /refusing to create a new recovery store/,
    );
    await assert.rejects(stat(missingDataDir), { code: "ENOENT" });
    await assert.rejects(
      cancelPreparedContextBlock(missing, { taskId: 1, fingerprint: "0".repeat(64) }, context),
      /refusing to create a new recovery store/,
    );
    await assert.rejects(stat(missingDataDir), { code: "ENOENT" });

    await mkdir(emptyDataDir);
    const empty = gatewayConfig(workspace, emptyDataDir, providerId);
    await assert.rejects(
      listPreparedContextBlocks(empty, context),
      /SQLite database does not exist; refusing/,
    );
    await assert.rejects(stat(resolve(emptyDataDir, "nanobot.sqlite")), { code: "ENOENT" });
    await assert.rejects(
      cancelPreparedContextBlock(empty, { taskId: 1, fingerprint: "0".repeat(64) }, context),
      /SQLite database does not exist; refusing/,
    );
    await assert.rejects(stat(resolve(emptyDataDir, "nanobot.sqlite")), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a cleanly stopped store restores mapping, transcript, topic memory, and admission dedupe", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-restore-smoke-"));
  const sourceWorkspace = resolve(temp, "source-workspace");
  const sourceDataDir = resolve(temp, "source-state");
  const restoredWorkspace = resolve(temp, "restored-workspace");
  const restoredDataDir = resolve(temp, "restored-state");
  const providerId = "restore-smoke";
  const extra = {
    workspaceContext: { memoryFiles: ["memory/MEMORY.md", "memory/topics/project.md"] },
    episodeSummary: { enabled: false },
  };
  let sourceGateway;
  let restoredGateway;
  try {
    await mkdir(resolve(sourceWorkspace, "memory/topics"), { recursive: true });
    for (const [path, content] of Object.entries({
      "AGENTS.md": "RESTORE-AGENTS",
      "memory/MEMORY.md": "RESTORE-MAIN-MEMORY",
      "memory/topics/project.md": "RESTORE-TOPIC-MEMORY",
    })) {
      await writeFile(resolve(sourceWorkspace, path), content);
    }

    const prompts = [];
    const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic" }] });
    provider.setResponses([(request) => {
      prompts.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("restore reply");
    }]);
    const models = createModels();
    models.setProvider(provider.provider);
    const sourceConfig = gatewayConfig(sourceWorkspace, sourceDataDir, providerId, "synthetic", ["synthetic"], extra);

    let sourceConversationId;
    let originalSubmissionId;
    let originalEntryIds;
    let originalTranscript;
    try {
      sourceGateway = await openGateway(sourceConfig, context, {
        models,
        agentHistory: false,
        ...workspaceContextGatewayOptions(sourceConfig),
      });
      const conversation = await sourceGateway.conversationFor("restore-session", context);
      const submission = await conversation.submit({
        type: "input",
        content: "restore original turn",
        requestId: "restore-request",
      }, context);
      assert.equal((await submission.wait(context)).status, "done");
      sourceConversationId = conversation.id;
      originalSubmissionId = submission.id;
      const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
      originalEntryIds = entries.items.map((entry) => entry.id);
      originalTranscript = JSON.stringify(entries.items);
      assert.match(originalTranscript, /restore original turn/);
      assert.match(originalTranscript, /restore reply/);
      assert.match(prompts[0], /RESTORE-TOPIC-MEMORY/);
    } finally {
      await sourceGateway?.close(context);
      sourceGateway = undefined;
    }

    const sidecars = (await readdir(sourceDataDir)).filter((name) => name.startsWith("nanobot.sqlite-"));
    assert.deepEqual(sidecars, [], "a cleanly closed store must not need a live WAL copy");
    await mkdir(restoredDataDir, { recursive: true, mode: 0o700 });
    await copyFile(resolve(sourceDataDir, "nanobot.sqlite"), resolve(restoredDataDir, "nanobot.sqlite"));
    await cp(sourceWorkspace, restoredWorkspace, { recursive: true });
    // The restored copy, not the original workspace, must supply later context.
    await writeFile(resolve(sourceWorkspace, "memory/topics/project.md"), "SOURCE-MEMORY-CHANGED-AFTER-BACKUP");

    const restoredConfig = gatewayConfig(
      restoredWorkspace, restoredDataDir, providerId, "synthetic", ["synthetic"], extra,
    );
    try {
      restoredGateway = await openGateway(restoredConfig, context, {
        models,
        agentHistory: false,
        ...workspaceContextGatewayOptions(restoredConfig),
      });
      const conversation = await restoredGateway.conversationFor("restore-session", context);
      assert.equal(conversation.id, sourceConversationId, "session mapping must survive the restore");
      const restoredEntries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
      assert.deepEqual(restoredEntries.items.map((entry) => entry.id), originalEntryIds,
        "the original transcript evidence must be retained");
      assert.equal(JSON.stringify(restoredEntries.items), originalTranscript);

      const callsBeforeDuplicate = provider.state.callCount;
      const duplicate = await conversation.submit({
        type: "input",
        content: "must not be admitted twice",
        requestId: "restore-request",
      }, context);
      assert.equal(duplicate.id, originalSubmissionId, "durable admission dedupe must survive the restore");
      assert.equal((await duplicate.wait(context)).status, "done");
      await restoredGateway.harness.waitForIdle(context);
      assert.equal(provider.state.callCount, callsBeforeDuplicate, "a deduplicated request must not dispatch");
      const afterDuplicate = await conversation.entries({ order: "ascending" }, 100, undefined, context);
      assert.equal(afterDuplicate.items.length, restoredEntries.items.length);
      assert.doesNotMatch(JSON.stringify(afterDuplicate.items), /must not be admitted twice/);

      provider.setResponses([(request) => {
        prompts.push(getCurrentSystemPrompt(request.messages));
        return fauxAssistantMessage("restored reply");
      }]);
      const afterRestore = await conversation.submit({
        type: "input",
        content: "after restore",
        requestId: "restore-after",
      }, context);
      assert.equal((await afterRestore.wait(context)).status, "done");
      const restoredPrompt = prompts.at(-1);
      assert.match(restoredPrompt, /RESTORE-AGENTS/);
      assert.match(restoredPrompt, /RESTORE-MAIN-MEMORY/);
      assert.match(restoredPrompt, /RESTORE-TOPIC-MEMORY/);
      assert.doesNotMatch(restoredPrompt, /SOURCE-MEMORY-CHANGED-AFTER-BACKUP/);
    } finally {
      await restoredGateway?.close(context);
      restoredGateway = undefined;
    }
  } finally {
    await sourceGateway?.close(context);
    await restoredGateway?.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});
