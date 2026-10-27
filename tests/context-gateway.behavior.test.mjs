import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { getCurrentSystemPrompt } = await import(pathToFileURL(`${ai}/utils/transcript.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;

function setupModels(providerId, capture) {
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
  provider.setResponses(Array.from({ length: 10 }, () => (request) => {
    capture.push(getCurrentSystemPrompt(request.messages));
    return fauxAssistantMessage("synthetic reply");
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  return models;
}

function gatewayConfig(workspace, dataDir, provider) {
  const model = { provider, modelId: "synthetic" };
  return parseConfig({ workspace, dataDir, model, allowedModels: [model] }, resolve(workspace, ".."));
}

async function send(gateway, key, id, message) {
  const conversation = await gateway.conversationFor(key, context);
  const submission = await conversation.submit({ type: "input", content: message, requestId: id }, context);
  assert.equal((await submission.wait(context)).status, "done");
  return conversation;
}

test("context remains absent and tool policy remains empty without opt-in", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-context-off-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  await mkdir(workspace);
  const captured = [];
  const models = setupModels("context-off", captured);
  const config = gatewayConfig(workspace, dataDir, "context-off");
  let gateway;
  try {
    gateway = await openGateway(config, context, { models });
    const conversation = await gateway.conversationFor("plain-session", context);
    const agent = await conversation.agent(context);
    assert.deepEqual(agent.tools, []);
    assert.deepEqual(agent.callable, []);
    assert.doesNotMatch(JSON.stringify(agent.sections), /nanobot_identity|nanobot_memory/);
    await send(gateway, "plain-session", "plain-request", "no context please");
    assert.doesNotMatch(captured[0], /nanobot-context|workspace|memory/);
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("no-provider reopen clears persisted context before a pending retry resumes", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-context-retry-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  await mkdir(workspace);
  const providerId = "context-pending";
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
  const providerCalls = [];
  const captured = [];
  provider.setResponses([
    (request) => {
      captured.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("temporary failure", {
        stopReason: "error",
        errorMessage: "service temporarily unavailable",
      });
    },
    (request) => {
      captured.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("recovered without context");
    },
    (request) => {
      captured.push(getCurrentSystemPrompt(request.messages));
      return fauxAssistantMessage("next turn without context");
    },
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const config = gatewayConfig(workspace, dataDir, providerId);
  const contextSnapshotProvider = (sessionKey, conversationId) => {
    providerCalls.push({ sessionKey, conversationId });
    return { identity: { source: "synthetic:host", content: `stale-context-secret for ${sessionKey}` } };
  };
  let gateway;
  try {
    gateway = await openGateway(config, context, { models, contextSnapshotProvider });
    const conversation = await gateway.conversationFor("retry-session", context);
    const submission = await conversation.submit({ type: "input", content: "retry me", requestId: "retry-1" }, context);
    const deadline = Date.now() + 5_000;
    let sleeping = false;
    let lastInspection;
    while (Date.now() < deadline && !sleeping) {
      lastInspection = await gateway.harness.inspect(context);
      sleeping = lastInspection.tasks.some((task) => task.state?.kind === "sleeping");
      if (!sleeping) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.ok(sleeping, `synthetic retry should persist in a sleeping state before restart: ${JSON.stringify(lastInspection)}`);
    assert.match(captured[0], /stale-context-secret for retry-session/);

    await gateway.close(context);
    gateway = undefined;
    gateway = await openGateway(config, context, { models });
    const resumed = await gateway.harness.submission(submission.id, context);
    assert.ok(resumed);
    assert.equal((await resumed.wait(context)).status, "done");
    assert.doesNotMatch(captured[1], /stale-context-secret/);
    const conversationAfterResume = await gateway.conversationFor("retry-session", context);
    const agentAfterResume = await conversationAfterResume.agent(context);
    assert.doesNotMatch(JSON.stringify(agentAfterResume.sections), /nanobot_identity|stale-context-secret/);
    await send(gateway, "retry-session", "retry-2", "new turn after opt out");
    assert.doesNotMatch(captured[2], /stale-context-secret/);
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("concurrent session creation keeps snapshots detached and single-flight", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-context-concurrent-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  await mkdir(workspace);
  const captured = [];
  const models = setupModels("context-concurrent", captured);
  let releaseA;
  let releaseB;
  const gateA = new Promise((resolveGate) => { releaseA = resolveGate; });
  const gateB = new Promise((resolveGate) => { releaseB = resolveGate; });
  const calls = [];
  const snapshots = {};
  let gateway;
  try {
    gateway = await openGateway(gatewayConfig(workspace, dataDir, "context-concurrent"), context, {
      models,
      async contextSnapshotProvider(sessionKey) {
        calls.push(sessionKey);
        const snapshot = { identity: { source: "synthetic:host", content: `stable-${sessionKey}` } };
        snapshots[sessionKey] = snapshot;
        await (sessionKey === "gate-a" ? gateA : gateB);
        return snapshot;
      },
    });
    const a1 = gateway.conversationFor("gate-a", context);
    const a2 = gateway.conversationFor("gate-a", context);
    const b = gateway.conversationFor("gate-b", context);
    const deadline = Date.now() + 5_000;
    while (calls.length < 2 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.deepEqual([...calls].sort(), ["gate-a", "gate-b"]);

    releaseA();
    const [conversationA1, conversationA2] = await Promise.all([a1, a2]);
    assert.equal(conversationA1.id, conversationA2.id);
    snapshots["gate-a"].identity.content = "mutated after compiled";
    releaseB();
    const conversationB = await b;
    assert.notEqual(conversationA1.id, conversationB.id);

    await send(gateway, "gate-a", "gate-a-1", "a request");
    await send(gateway, "gate-b", "gate-b-1", "b request");
    await send(gateway, "gate-a", "gate-a-2", "a again");
    assert.match(captured[0], /stable-gate-a/);
    assert.doesNotMatch(captured[0], /stable-gate-b|mutated after compiled/);
    assert.match(captured[1], /stable-gate-b/);
    assert.doesNotMatch(captured[1], /stable-gate-a/);
    assert.match(captured[2], /stable-gate-a/);
    assert.doesNotMatch(captured[2], /mutated after compiled|stable-gate-b/);
  } finally {
    releaseA();
    releaseB();
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("provider errors leave no partial snapshot and can be retried", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-context-provider-error-"));
  const workspace = resolve(temp, "workspace");
  const dataDir = resolve(temp, "state");
  await mkdir(workspace);
  const captured = [];
  const models = setupModels("context-provider-error", captured);
  let calls = 0;
  let getterCalled = false;
  let gateway;
  try {
    gateway = await openGateway(gatewayConfig(workspace, dataDir, "context-provider-error"), context, {
      models,
      contextSnapshotProvider(sessionKey) {
        calls++;
        if (calls === 1) throw new Error("synthetic host snapshot failure");
        if (sessionKey === "getter-session") {
          const accessorSnapshot = {};
          Object.defineProperty(accessorSnapshot, "identity", {
            get() { getterCalled = true; throw new Error("must not invoke snapshot getters"); },
          });
          return accessorSnapshot;
        }
        return { identity: { source: "synthetic:host", content: "recovered snapshot" } };
      },
    });
    await assert.rejects(gateway.conversationFor("flaky-session", context), /synthetic host snapshot failure/);
    const recovered = await gateway.conversationFor("flaky-session", context);
    assert.equal(calls, 2);
    await send(gateway, "flaky-session", "flaky-request", "retry provider");
    assert.match(captured[0], /recovered snapshot/);
    assert.doesNotMatch(captured[0], /synthetic host snapshot failure/);
    assert.equal(recovered.id, (await gateway.conversationFor("flaky-session", context)).id);
    await send(gateway, "getter-session", "getter-request", "ignore accessor snapshot");
    assert.equal(getterCalled, false);
    assert.doesNotMatch(captured[1], /must not invoke snapshot getters|recovered snapshot/);
  } finally {
    if (gateway) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});

test("opt-in context follows session mappings across conversations, stores, and reopen", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "nanobot-context-gateway-"));
  const stores = ["store-a", "store-b"].map((name) => ({
    name,
    workspace: resolve(temp, `${name}-workspace`),
    dataDir: resolve(temp, `${name}-data`),
    providerId: `context-${name}`,
    captured: [],
    providerCalls: [],
    capturedHostSnapshots: {},
  }));
  for (const store of stores) await mkdir(store.workspace);
  const opened = [];
  const open = async (store) => {
    const models = setupModels(store.providerId, store.captured);
    const gateway = await openGateway(gatewayConfig(store.workspace, store.dataDir, store.providerId), context, {
      models,
      contextSnapshotProvider(sessionKey, conversationId) {
        store.providerCalls.push({ sessionKey, conversationId });
        const snapshot = {
          identity: { source: "synthetic:host", content: `${store.name} context for ${sessionKey}` },
          memory: [{ source: "synthetic:memory", content: `private-${store.name}-${sessionKey}` }],
        };
        store.capturedHostSnapshots[sessionKey] = snapshot;
        return snapshot;
      },
    });
    opened.push(gateway);
    return gateway;
  };

  try {
    const first = await open(stores[0]);
    const root = await first.harness.root(context);
    const rootAgent = await root.agent(context);
    assert.doesNotMatch(JSON.stringify(rootAgent.sections), /nanobot_identity|nanobot_memory/);
    const alpha = await send(first, "alpha", "store-a-alpha-1", "alpha request");
    const beta = await send(first, "beta", "store-a-beta-1", "beta request");
    assert.notEqual(alpha.id, beta.id);
    assert.deepEqual(stores[0].providerCalls.map(({ sessionKey }) => sessionKey), ["alpha", "beta"]);
    assert.match(stores[0].captured[0], /store-a context for alpha/);
    assert.match(stores[0].captured[0], /private-store-a-alpha/);
    assert.doesNotMatch(stores[0].captured[0], /store-a context for beta|private-store-a-beta/);
    stores[0].capturedHostSnapshots.alpha.identity.content = "mutated host snapshot after capture";
    assert.match(stores[0].captured[1], /store-a context for beta/);
    assert.doesNotMatch(stores[0].captured[1], /store-a context for alpha|private-store-a-alpha/);
    assert.deepEqual(await alpha.agent(context).then(({ tools, callable }) => [tools, callable]), [[], []]);
    await send(first, "alpha", "store-a-alpha-2", "alpha after another session was added");
    assert.match(stores[0].captured[2], /store-a context for alpha/);
    assert.doesNotMatch(stores[0].captured[2], /mutated host snapshot/);

    const second = await open(stores[1]);
    const otherStoreAlpha = await send(second, "alpha", "store-b-alpha-1", "other store request");
    assert.equal(otherStoreAlpha.id, alpha.id, "storage-local IDs intentionally collide");
    assert.deepEqual(stores[1].providerCalls.map(({ sessionKey }) => sessionKey), ["alpha"]);
    assert.match(stores[1].captured[0], /store-b context for alpha/);
    assert.doesNotMatch(stores[1].captured[0], /store-a context|private-store-a/);

    await first.close(context);
    opened.splice(opened.indexOf(first), 1);
    const reopened = await open(stores[0]);
    assert.deepEqual(stores[0].providerCalls.slice(2).map(({ sessionKey }) => sessionKey), ["alpha", "beta"]);
    await send(reopened, "alpha", "store-a-alpha-3", "after reopen");
    assert.match(stores[0].captured[3], /store-a context for alpha/);
    assert.doesNotMatch(stores[0].captured[3], /store-a context for beta/);
  } finally {
    for (const gateway of opened.reverse()) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});
