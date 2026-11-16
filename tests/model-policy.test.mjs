import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Build the package first; PI_MODEL_CANDIDATE can point at another built checkout.
const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const durable = `${pkg}/node_modules/@earendil-works/pi-durable/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const { AgentDoc } = await import(pathToFileURL(`${durable}/index.js`).href);
const context = BACKGROUND_CONTEXT;
const temp = await mkdtemp(resolve(tmpdir(), "nanobot-model-policy-"));
const workspace = resolve(temp, "workspace");
const dataDir = resolve(temp, "state");
await mkdir(workspace);
const raw = {
  workspace,
  dataDir,
  model: { provider: "fixture", modelId: "alpha" },
  allowedModels: [
    { provider: "fixture", modelId: "alpha" },
    { provider: "fixture", modelId: "beta" },
    { provider: "fixture", modelId: "plain" },
  ],
  thinkingLevel: "high",
};
const config = parseConfig(raw, temp);
const provider = fauxProvider({ provider: "fixture", models: [
  { id: "alpha", name: "Alpha", reasoning: true },
  { id: "beta", name: "Beta", reasoning: true },
  { id: "plain", name: "Plain", reasoning: false },
] });
let enterRequest;
let releaseRequest;
const entered = new Promise((resolveEntered) => { enterRequest = resolveEntered; });
const blocked = new Promise((resolveBlocked) => { releaseRequest = resolveBlocked; });
const dispatched = [];
provider.setResponses([
  async (_messages, _options, _state, model) => {
    dispatched.push(model.id);
    enterRequest();
    await blocked;
    return fauxAssistantMessage("synthetic response");
  },
  (_messages, _options, _state, model) => {
    dispatched.push(model.id);
    return fauxAssistantMessage("synthetic response");
  },
]);
const models = createModels();
models.setProvider(provider.provider);
let gateway;
// Declared outside the try so the deadline handle is always cleared, including on an assertion
// failure between the race and its original inline cleanup.
let providerDeadline;
try {
  gateway = await openGateway(config, context, { models, agentHistory: false });
  const conversation = await gateway.conversationFor("policy-session", context);
  assert.deepEqual((await gateway.listModels("policy-session", context)).selected, {
    provider: "fixture", modelId: "alpha", thinkingLevel: "high",
  });

  const submission = await conversation.submit({ type: "input", content: "hold", requestId: "policy-1" }, context);
  const waiting = submission.wait(context);
  try {
    await Promise.race([entered, new Promise((_, reject) => {
      providerDeadline = setTimeout(() => reject(new Error("provider timeout")), 5000);
    })]);
  } finally {
    // The race settles on `entered` normally: clear the handle or it keeps the process alive.
    clearTimeout(providerDeadline);
  }
  await assert.rejects(
    gateway.selectModel("policy-session", { provider: "fixture", modelId: "beta" }, context),
    /busy/i,
  );
  assert.deepEqual((await gateway.harness.snapshot(AgentDoc, conversation.id, context)).model,
    { provider: "fixture", modelId: "alpha" });
  releaseRequest();
  assert.equal((await waiting).status, "done");

  assert.deepEqual(await gateway.selectModel("policy-session", { provider: "fixture", modelId: "plain" }, context), {
    provider: "fixture", modelId: "plain", thinkingLevel: "off",
  });
  await assert.rejects(gateway.selectModel("policy-session", {
    provider: "fixture", modelId: "plain", thinkingLevel: "high",
  }, context), /Unsupported thinkingLevel/);
  await gateway.selectModel("policy-session", { provider: "fixture", modelId: "beta", thinkingLevel: "high" }, context);
  assert.deepEqual(await gateway.selectModel("policy-session", { provider: "fixture", modelId: "beta" }, context), {
    provider: "fixture", modelId: "beta", thinkingLevel: "high",
  });
  assert.deepEqual(dispatched, ["alpha"]);
  await gateway.close(context);
  gateway = undefined;

  // Native pi.agent selection and thinking survive reopen; revoked choices recover to default.
  gateway = await openGateway(config, context, { models, agentHistory: false });
  assert.deepEqual((await gateway.listModels("policy-session", context)).selected, {
    provider: "fixture", modelId: "beta", thinkingLevel: "high",
  });
  await gateway.close(context);
  gateway = await openGateway(parseConfig({ ...raw, allowedModels: [raw.model] }, temp), context, { models, agentHistory: false });
  const recovered = await gateway.conversationFor("policy-session", context);
  const state = await gateway.harness.snapshot(AgentDoc, recovered.id, context);
  assert.deepEqual(state.model, { provider: "fixture", modelId: "alpha" });
  assert.equal(state.thinkingLevel, "high");
  // No coding tool is granted; the mapped chat keeps only the owner-question capability.
  assert.deepEqual(state.tools.map((tool) => (typeof tool === 'string' ? tool : tool.name)).sort(), ['ask_user']);
  assert.deepEqual(state.modelTools.map((tool) => (typeof tool === 'string' ? tool : tool.name)).sort(), ['ask_user']);
  assert.deepEqual(dispatched, ["alpha"]);
  console.log("PASS: atomic busy rejection, thinking persistence/reset, reopen, and allowlist revocation use synthetic models only");
} finally {
  releaseRequest();
  if (gateway) await gateway.close(context);
  await rm(temp, { recursive: true, force: true });
}
