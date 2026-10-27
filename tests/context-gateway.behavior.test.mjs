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
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;

function setupModels(providerId, capture) {
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
  provider.setResponses(Array.from({ length: 10 }, () => (request) => {
    capture.push(JSON.stringify(request.messages));
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

test("pending model retry reopens only after its conversation context is reconstructed", async () => {
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
      captured.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("temporary failure", {
        stopReason: "error",
        errorMessage: "service temporarily unavailable",
      });
    },
    (request) => {
      assert.equal(providerCalls.length, 2, "reconstruction must finish before resumed model work");
      captured.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("recovered");
    },
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const config = gatewayConfig(workspace, dataDir, providerId);
  const contextSnapshotProvider = (sessionKey, conversationId) => {
    providerCalls.push({ sessionKey, conversationId });
    return { identity: { source: "synthetic:host", content: `retry context for ${sessionKey}` } };
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
    assert.match(captured[0], /retry context for retry-session/);

    await gateway.close(context);
    gateway = undefined;
    gateway = await openGateway(config, context, { models, contextSnapshotProvider });
    const resumed = await gateway.harness.submission(submission.id, context);
    assert.ok(resumed);
    assert.equal((await resumed.wait(context)).status, "done");
    assert.match(captured[1], /retry context for retry-session/);
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
  }));
  for (const store of stores) await mkdir(store.workspace);
  const opened = [];
  const open = async (store) => {
    const models = setupModels(store.providerId, store.captured);
    const gateway = await openGateway(gatewayConfig(store.workspace, store.dataDir, store.providerId), context, {
      models,
      contextSnapshotProvider(sessionKey, conversationId) {
        store.providerCalls.push({ sessionKey, conversationId });
        return {
          identity: { source: "synthetic:host", content: `${store.name} context for ${sessionKey}` },
          memory: [{ source: "synthetic:memory", content: `private-${store.name}-${sessionKey}` }],
        };
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
    assert.match(stores[0].captured[1], /store-a context for beta/);
    assert.doesNotMatch(stores[0].captured[1], /store-a context for alpha|private-store-a-alpha/);
    assert.deepEqual(await alpha.agent(context).then(({ tools, callable }) => [tools, callable]), [[], []]);

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
    await send(reopened, "alpha", "store-a-alpha-2", "after reopen");
    assert.match(stores[0].captured[2], /store-a context for alpha/);
    assert.doesNotMatch(stores[0].captured[2], /store-a context for beta/);
  } finally {
    for (const gateway of opened.reverse()) await gateway.close(context);
    await rm(temp, { recursive: true, force: true });
  }
});
