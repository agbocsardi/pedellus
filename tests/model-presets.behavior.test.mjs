import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

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
const SESSION = "telegram:model-presets";
const SUMMARY_PROMPT_PREFIX = "You maintain one short factual summary";
const SUMMARY_BODY = "Title: synthetic episode\n## Topics\n- synthetic\n## Keywords\n- synthetic";

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** Race one promise against a hard deadline so a wedged provider fails the test instead of hanging it. */
async function within(promise, ms, label) {
  const expired = deferred();
  const deadline = setTimeout(() => expired.reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    // Clear the handle itself, not the deferred: a surviving timer holds the process open.
    clearTimeout(deadline);
  }
}

/** One request can be parked inside the faux provider until the test reads committed state. */
function holdpoint() {
  const point = { held: false, entered: undefined, release: undefined };
  return {
    held: () => point.held,
    /** Arm before the request can arrive; resolves when a parked request enters. */
    wait() {
      point.entered = deferred();
      point.held = true;
      return point.entered.promise;
    },
    /** Called from the provider: signal entry, then wait for `release()`. */
    park() {
      point.entered.resolve();
      return new Promise((resolveRelease) => { point.release = resolveRelease; });
    },
    release() {
      point.held = false;
      point.entered = undefined;
      const release = point.release;
      point.release = undefined;
      release?.();
    },
  };
}

function systemText(messages) {
  const first = messages?.[0];
  if (first?.role !== "system") return "";
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return "";
  return first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Synthetic provider for `fixture`: `alpha`/`beta` accept every thinking level, `plain` none.
 * One dispatcher re-arms itself, so every generation and the episode-summary fold are answered
 * by the same script and recorded as `{ kind, modelId, reasoning }`.
 */
function buildProvider() {
  const provider = fauxProvider({ provider: "fixture", models: [
    { id: "alpha", name: "Alpha", reasoning: true },
    { id: "beta", name: "Beta", reasoning: true },
    { id: "plain", name: "Plain", reasoning: false },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const calls = [];
  const generationGate = holdpoint();
  const summaryGate = holdpoint();
  const dispatcher = (transcript, options, _state, model) => {
    provider.appendResponses([dispatcher]);
    const summary = systemText(transcript.messages).startsWith(SUMMARY_PROMPT_PREFIX);
    calls.push({ kind: summary ? "summary" : "generation", modelId: model.id, reasoning: options?.reasoning ?? "off" });
    const body = summary ? SUMMARY_BODY : "synthetic response";
    const gate = summary ? summaryGate : generationGate;
    return gate.held()
      ? gate.park().then(() => fauxAssistantMessage(body))
      : fauxAssistantMessage(body);
  };
  provider.setResponses([dispatcher]);
  return { provider, models, calls, generationGate, summaryGate };
}

/** Named catalog with two presets over one model pair, so dedupe and thinking stay observable. */
function namedConfig(temp, workspace, dataDir, extra = {}) {
  return parseConfig({
    workspace,
    dataDir,
    modelPresets: {
      fast: { provider: "fixture", modelId: "alpha", thinkingLevel: "off" },
      "alpha-high": { provider: "fixture", modelId: "alpha", thinkingLevel: "high" },
      deep: { provider: "fixture", modelId: "beta", thinkingLevel: "high" },
    },
    modelPreset: "fast",
    ...extra,
  }, temp);
}

const tempRoots = [];
async function tempDirs(label) {
  const root = await mkdtemp(resolve(tmpdir(), `nanobot-model-presets-${label}-`));
  tempRoots.push(root);
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, dataDir: resolve(root, "state") };
}

test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

test("named preset parsing rejects ambiguous config and dedupes one model pair", { timeout: 10_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("parse");
  const base = { workspace, dataDir };
  const presets = {
    fast: { provider: "fixture", modelId: "alpha", thinkingLevel: "off" },
    "alpha-high": { provider: "fixture", modelId: "alpha", thinkingLevel: "high" },
  };

  const config = parseConfig({ ...base, modelPresets: presets, modelPreset: "fast" }, root);
  assert.deepEqual(config.model, { provider: "fixture", modelId: "alpha" });
  assert.equal(config.modelPreset, "fast");
  assert.deepEqual({ ...config.modelPresets }, presets);
  // Two names over one pair are one native choice: the allowlist holds the pair once.
  assert.deepEqual(config.allowedModels, [{ provider: "fixture", modelId: "alpha" }]);

  // One alternative to the legacy direct surface: mixing the two is ambiguous, not merged.
  for (const [field, value] of [
    ["model", { provider: "fixture", modelId: "alpha" }],
    ["allowedModels", [{ provider: "fixture", modelId: "alpha" }]],
    ["thinkingLevel", "high"],
  ]) {
    assert.throws(
      () => parseConfig({ ...base, modelPresets: presets, modelPreset: "fast", [field]: value }, root),
      new RegExp(`does not accept ${field}`),
      `${field} must be rejected beside modelPresets`,
    );
  }
  assert.throws(() => parseConfig({ ...base, modelPreset: "fast" }, root), /modelPreset requires modelPresets/);
  assert.throws(() => parseConfig({ ...base, modelPresets: presets }, root), /requires modelPreset/);
  assert.throws(
    () => parseConfig({ ...base, modelPresets: { ...presets, default: presets.fast }, modelPreset: "fast" }, root),
    /reserved name "default"/,
  );
  assert.throws(
    () => parseConfig({ ...base, modelPresets: { fast: { ...presets.fast, temperature: 1 } }, modelPreset: "fast" }, root),
    /Unknown modelPresets.fast field: temperature/,
  );
  assert.throws(
    () => parseConfig({ ...base, modelPresets: { fast: { ...presets.fast, thinkingLevel: "turbo" } }, modelPreset: "fast" }, root),
    /thinkingLevel must be one of/,
  );
  assert.throws(
    () => parseConfig({ ...base, modelPresets: presets, modelPreset: "missing" }, root),
    /modelPreset must name an entry in modelPresets/,
  );
  assert.throws(
    () => parseConfig({ ...base, modelPresets: presets, modelPreset: "fast", episodeSummary: { preset: "missing" } }, root),
    /episodeSummary.preset must name an entry in modelPresets/,
  );
  assert.throws(
    () => parseConfig({
      ...base,
      modelPresets: presets,
      modelPreset: "fast",
      episodeSummary: { model: { provider: "fixture", modelId: "alpha" }, preset: "fast" },
    }, root),
    /mutually exclusive/,
  );
  assert.throws(
    () => parseConfig({
      ...base,
      model: { provider: "fixture", modelId: "alpha" },
      episodeSummary: { preset: "fast" },
    }, root),
    /episodeSummary.preset requires named modelPresets/,
  );

  // Legacy direct config keeps its own allowlist and carries no preset catalog.
  const direct = parseConfig({
    ...base,
    model: { provider: "fixture", modelId: "alpha" },
    allowedModels: [{ provider: "fixture", modelId: "alpha" }, { provider: "fixture", modelId: "beta" }],
  }, root);
  assert.equal(direct.modelPreset, undefined);
  assert.equal(direct.modelPresets, undefined);
  assert.equal(direct.allowedModels.length, 2);

  // The catalog is validated against native model metadata before any store is created.
  const synthetic = buildProvider();
  await assert.rejects(
    openGateway(
      parseConfig({
        ...base,
        modelPresets: { plainHigh: { provider: "fixture", modelId: "plain", thinkingLevel: "high" } },
        modelPreset: "plainHigh",
      }, root),
      context,
      { models: synthetic.models, agentHistory: false },
    ),
    /Unsupported thinkingLevel high for model preset plainHigh/,
  );
  assert.equal(await stat(dataDir).catch(() => undefined), undefined);
});

test("gateway dispatches configured presets, keeps same-pair thinking distinct, and rejects atomically", { timeout: 10_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("gateway");
  const { models, calls, generationGate } = buildProvider();
  let gateway;
  try {
    gateway = await openGateway(namedConfig(root, workspace, dataDir), context, { models, agentHistory: false });
    const conversation = await gateway.conversationFor(SESSION, context);

    const listing = await gateway.listModels(SESSION, context);
    assert.deepEqual(listing.selected, { provider: "fixture", modelId: "alpha", thinkingLevel: "off" });
    assert.equal(listing.defaultPreset, "fast");
    assert.deepEqual(listing.presets.map((preset) => preset.name), ["fast", "alpha-high", "deep"]);
    // Same-pair presets stay distinct in the catalog but produce one allowlisted model choice.
    assert.equal(listing.models.length, 2);

    const turn = async (requestId) => {
      const submission = await conversation.submit({ type: "input", content: requestId, requestId }, context);
      assert.equal((await submission.wait(context)).status, "done");
    };

    await turn("preset-default");
    assert.deepEqual(calls.at(-1), { kind: "generation", modelId: "alpha", reasoning: "off" });

    assert.deepEqual(await gateway.selectModelPreset(SESSION, "deep", context), {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
    await turn("preset-deep");
    assert.deepEqual(calls.at(-1), { kind: "generation", modelId: "beta", reasoning: "high" });

    assert.deepEqual(await gateway.selectModelPreset(SESSION, "alpha-high", context), {
      provider: "fixture", modelId: "alpha", thinkingLevel: "high",
    });
    await turn("preset-alpha-high");
    assert.deepEqual(calls.at(-1), { kind: "generation", modelId: "alpha", reasoning: "high" });

    // `/model default` is the configured preset, not a catalog entry, and it is temporary.
    assert.deepEqual(await gateway.selectModelPreset(SESSION, "default", context), {
      provider: "fixture", modelId: "alpha", thinkingLevel: "off",
    });
    await assert.rejects(gateway.selectModelPreset(SESSION, "missing", context), /Unknown model preset/);

    const entered = generationGate.wait();
    const submission = await conversation.submit({ type: "input", content: "hold", requestId: "preset-busy" }, context);
    const settled = submission.wait(context);
    await within(entered, 5_000, "generation never reached the provider");
    await assert.rejects(gateway.selectModelPreset(SESSION, "deep", context), /busy/i);
    const held = await gateway.harness.snapshot(AgentDoc, conversation.id, context);
    assert.deepEqual(held.model, { provider: "fixture", modelId: "alpha" });
    assert.equal(held.thinkingLevel, "off");
    generationGate.release();
    assert.equal((await settled).status, "done");
    assert.deepEqual(calls.at(-1), { kind: "generation", modelId: "alpha", reasoning: "off" });

    assert.deepEqual(calls.map((call) => `${call.modelId}/${call.reasoning}`), [
      "alpha/off", "beta/high", "alpha/high", "alpha/off",
    ]);
  } finally {
    generationGate.release();
    if (gateway) await gateway.close(context);
  }
});

test("named presets reset to the configured default on reopen while direct selection persists", { timeout: 10_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reopen");
  const { models, calls } = buildProvider();
  let gateway;
  try {
    gateway = await openGateway(namedConfig(root, workspace, dataDir), context, { models, agentHistory: false });
    await gateway.conversationFor(SESSION, context);
    assert.deepEqual(await gateway.selectModelPreset(SESSION, "deep", context), {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
    await gateway.close(context);
    gateway = undefined;

    gateway = await openGateway(namedConfig(root, workspace, dataDir), context, { models, agentHistory: false });
    assert.deepEqual((await gateway.listModels(SESSION, context)).selected, {
      provider: "fixture", modelId: "alpha", thinkingLevel: "off",
    });
    await gateway.close(context);
    gateway = undefined;

    // Changing the configured default changes what a restart selects.
    gateway = await openGateway(
      namedConfig(root, workspace, dataDir, { modelPreset: "deep" }),
      context,
      { models, agentHistory: false },
    );
    assert.deepEqual((await gateway.listModels(SESSION, context)).selected, {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
    await gateway.close(context);
    gateway = undefined;

    // Legacy direct mode keeps its persisted native selection across reopen.
    const direct = () => parseConfig({
      workspace,
      dataDir,
      model: { provider: "fixture", modelId: "alpha" },
      allowedModels: [{ provider: "fixture", modelId: "alpha" }, { provider: "fixture", modelId: "beta" }],
      thinkingLevel: "high",
    }, root);
    gateway = await openGateway(direct(), context, { models, agentHistory: false });
    const directConversation = await gateway.conversationFor("telegram:direct-mode", context);
    await assert.rejects(
      gateway.selectModelPreset("telegram:direct-mode", "fast", context),
      /Named model presets are not configured/,
    );
    assert.deepEqual(await gateway.selectModel("telegram:direct-mode", {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    }, context), { provider: "fixture", modelId: "beta", thinkingLevel: "high" });
    await gateway.close(context);
    gateway = undefined;

    gateway = await openGateway(direct(), context, { models, agentHistory: false });
    assert.deepEqual((await gateway.listModels("telegram:direct-mode", context)).selected, {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
    assert.deepEqual(await gateway.harness.snapshot(AgentDoc, directConversation.id, context).then((state) => state.model),
      { provider: "fixture", modelId: "beta" });
  } finally {
    if (gateway) await gateway.close(context);
  }
  assert.deepEqual(calls, []);
});

test("a real summary job folds with the configured preset model and thinking, and enabled:false disables it", { timeout: 15_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("summary");
  const { models, calls, summaryGate } = buildProvider();
  let gateway;
  try {
    gateway = await openGateway(
      namedConfig(root, workspace, dataDir, { episodeSummary: { preset: "deep" } }),
      context,
      { models, agentHistory: false },
    );
    const conversation = await gateway.conversationFor(SESSION, context);
    const submission = await conversation.submit({ type: "input", content: "episode content", requestId: "summary-turn" }, context);
    assert.equal((await submission.wait(context)).status, "done");

    const entered = summaryGate.wait();
    await conversation.reset(undefined, context);
    await within(
      gateway.reconcileHistoryEpisodes(SESSION, context).then(() => entered),
      8_000,
      "summary request never reached the provider",
    );

    const queue = await gateway.historySummaryQueue(SESSION, context);
    assert.equal(queue.provider, "fixture");
    assert.equal(queue.modelId, "beta");
    assert.equal(queue.thinkingLevel, "high");
    assert.ok(Number.isSafeInteger(queue.currentTaskId) && queue.currentTaskId > 0);
    const waiting = gateway.harness.waitForTask(queue.currentTaskId, context);
    summaryGate.release();
    const settled = await within(waiting, 8_000, "summary task did not settle");
    assert.equal(settled.state.outcome.status, "completed");

    const episodes = await gateway.listHistoryEpisodes(SESSION, { limit: 5 }, context);
    const closed = episodes.episodes.find((episode) => episode.status === "closed");
    assert.ok(closed, "reset must close the first episode");
    const record = await gateway.historyEpisodeSummary(SESSION, closed.startEntryId, context);
    assert.equal(record.status, "ready");
    assert.equal(record.provider, "fixture");
    assert.equal(record.modelId, "beta");
    // The preset's thinking level reaches the real provider request, not just display metadata.
    assert.deepEqual(calls.filter((call) => call.kind === "summary"), [
      { kind: "summary", modelId: "beta", reasoning: "high" },
    ]);

    await gateway.close(context);
    gateway = undefined;

    // `enabled: false` keeps the catalog's model invalid: nothing is summarized, including on reset.
    gateway = await openGateway(
      namedConfig(root, workspace, dataDir, { episodeSummary: { enabled: false, preset: "deep" } }),
      context,
      { models, agentHistory: false },
    );
    const reopened = await gateway.conversationFor(SESSION, context);
    await reopened.reset(undefined, context);
    await gateway.reconcileHistoryEpisodes(SESSION, context);
    await assert.rejects(gateway.historySummaryQueue(SESSION, context), /Episode summaries require/);
    assert.equal(calls.filter((call) => call.kind === "summary").length, 1);
  } finally {
    summaryGate.release();
    if (gateway) await gateway.close(context);
  }
});
