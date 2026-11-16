import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
const { loadConfig, parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const { AgentDoc, defineTask } = await import(pathToFileURL(`${durable}/index.js`).href);
const { CronJobsDoc } = await import(pathToFileURL(`${pkg}/dist/automation/cron.js`).href);
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

/**
 * A local OpenAI-compatible endpoint for reload checks. It records the model and credential header
 * of every request; `holdNext` parks the next response so a reload can be attempted during live work,
 * and `script` queues the next replies so a turn can call a real tool before it answers.
 */
async function localModelServer() {
  const requests = [];
  const replies = [];
  let holdNext = false;
  let enteredHeld;
  let releaseHeld;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const parsed = JSON.parse(body);
    requests.push({ model: parsed.model, authorization: request.headers.authorization });
    if (holdNext) {
      holdNext = false;
      enteredHeld?.();
      enteredHeld = undefined;
      await new Promise((release) => { releaseHeld = release; });
    }
    const reply = replies.shift();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish) => `data: ${JSON.stringify({ id: "reload", object: "chat.completion.chunk",
      model: parsed.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    if (reply?.tool !== undefined) {
      response.write(delta({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-${requests.length}`,
          type: "function",
          function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
        }],
      }, null));
      response.write(delta({}, "tool_calls"));
    } else {
      response.write(delta({ content: reply?.text ?? "synthetic reload answer" }, null));
      response.write(delta({}, "stop"));
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    holdNext() {
      holdNext = true;
      return new Promise((resolveEntered) => { enteredHeld = resolveEntered; });
    },
    /** Queue the next replies, in order: `{ tool: { name, args } }` or `{ text }`. */
    script(...next) { replies.push(...next); },
    release() { releaseHeld?.(); releaseHeld = undefined; },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

/** A file-backed config using one keyless-until-referenced local OpenAI-compatible provider. */
function reloadConfigValues(workspace, dataDir, baseUrl, extra = {}) {
  return {
    workspace,
    dataDir,
    providers: {
      local: {
        name: "Local",
        baseUrl,
        api: "openai-completions",
        models: ["alpha", "beta"].map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
    modelPresets: {
      fast: { provider: "local", modelId: "alpha", thinkingLevel: "off" },
      deep: { provider: "local", modelId: "beta", thinkingLevel: "high" },
    },
    modelPreset: "fast",
    credentials: { local: "RELOAD_MODEL_KEY" },
    episodeSummary: { enabled: false },
    ...extra,
  };
}

test("host reload applies foreground presets and credential references without reopening", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  const firstKey = "RELOAD_MODEL_KEY";
  const secondKey = "RELOAD_MODEL_KEY_TWO";
  process.env[firstKey] = "synthetic-reload-one";
  delete process.env[secondKey];
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl);
    await writeFile(configFile, JSON.stringify(base));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    const conversation = await gateway.conversationFor("cli:reload", context);
    assert.deepEqual((await gateway.listModels("cli:reload", context)).selected, {
      provider: "local", modelId: "alpha", thinkingLevel: "off",
    });
    const turn = async (requestId) => {
      const submission = await conversation.submit({ type: "input", content: requestId, requestId }, context);
      assert.equal((await submission.wait(context)).status, "done");
    };
    await turn("reload-before");
    assert.equal(server.requests.at(-1).model, "alpha");
    assert.equal(server.requests.at(-1).authorization, "Bearer synthetic-reload-one");

    // A temporary preset selection is replaced by the new configured default on reload, exactly as a
    // named-preset reopen documents.
    await gateway.selectModelPreset("cli:reload", "deep", context);
    const candidate = {
      ...base,
      modelPreset: "deep",
      modelPresets: {
        ...base.modelPresets,
        gamma: { provider: "local", modelId: "alpha", thinkingLevel: "high" },
      },
    };
    await writeFile(configFile, JSON.stringify(candidate));
    const reloaded = await gateway.reloadModels(context);
    assert.deepEqual(reloaded, {
      status: "reloaded", models: 2, presets: 3, defaultPreset: "deep",
    });
    assert.doesNotMatch(JSON.stringify(reloaded), /synthetic-reload/u, "a reload result carries no credential");
    assert.deepEqual((await gateway.listModels("cli:reload", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });
    const state = await gateway.harness.snapshot(AgentDoc, conversation.id, context);
    assert.deepEqual(state.model, { provider: "local", modelId: "beta" });
    assert.equal(state.thinkingLevel, "high");
    await turn("reload-after");
    assert.equal(server.requests.at(-1).model, "beta");

    // The same fully validated file is a no-op, not a second application.
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "unchanged", models: 2, presets: 3, defaultPreset: "deep",
    });

    // An unreadable candidate and a startup-only change are refusals with no effect.
    await writeFile(configFile, "{not json");
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "invalid" });
    await writeFile(configFile, JSON.stringify({ ...candidate, toolAllowlist: ["read"] }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "unrelated" });
    assert.deepEqual((await gateway.listModels("cli:reload", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });

    // A reference to an unset variable fails closed before anything is applied.
    await writeFile(configFile, JSON.stringify({ ...candidate, credentials: { local: secondKey } }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "invalid" });
    assert.equal(server.requests.length, 2, "a refused reload made no provider request");
    // Setting the referenced variable makes the same candidate valid, and the new reference really
    // supplies the next request's credential.
    process.env[secondKey] = "synthetic-reload-two";
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 3, defaultPreset: "deep",
    });
    await turn("reload-credential");
    assert.equal(server.requests.at(-1).model, "beta");
    assert.equal(server.requests.at(-1).authorization, "Bearer synthetic-reload-two");
  } finally {
    delete process.env[firstKey];
    delete process.env[secondKey];
    if (gateway) await gateway.close(context);
    server.release();
    await server.close();
  }
});

test("direct-mode reload keeps allowed per-chat choices and revokes a removed model", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-direct");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-direct";
  let gateway;
  try {
    const provider = reloadConfigValues(workspace, dataDir, server.baseUrl).providers;
    const direct = {
      workspace,
      dataDir,
      providers: provider,
      credentials: { local: "RELOAD_MODEL_KEY" },
      model: { provider: "local", modelId: "alpha" },
      allowedModels: [{ provider: "local", modelId: "alpha" }, { provider: "local", modelId: "beta" }],
      thinkingLevel: "off",
      episodeSummary: { enabled: false },
    };
    await writeFile(configFile, JSON.stringify(direct));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    await gateway.conversationFor("cli:direct-reload", context);
    await gateway.selectModel("cli:direct-reload", { provider: "local", modelId: "beta", thinkingLevel: "high" }, context);

    // A new configured default applies to a new conversation; the existing explicit choice stays.
    await writeFile(configFile, JSON.stringify({ ...direct, model: { provider: "local", modelId: "beta" }, thinkingLevel: "high" }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "reloaded", models: 2, presets: 0 });
    assert.deepEqual((await gateway.listModels("cli:direct-reload", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });
    await gateway.conversationFor("cli:direct-reload-new", context);
    assert.deepEqual((await gateway.listModels("cli:direct-reload-new", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });

    // Removing the selected pair from the finite allowlist resets every foreground conversation to
    // the configured default rather than dispatching a model the file no longer allows.
    await writeFile(configFile, JSON.stringify({
      ...direct,
      model: { provider: "local", modelId: "alpha" },
      allowedModels: [{ provider: "local", modelId: "alpha" }],
      thinkingLevel: "off",
    }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "reloaded", models: 1, presets: 0 });
    for (const sessionKey of ["cli:direct-reload", "cli:direct-reload-new"]) {
      assert.deepEqual((await gateway.listModels(sessionKey, context)).selected, {
        provider: "local", modelId: "alpha", thinkingLevel: "off",
      });
    }
    assert.equal(server.requests.length, 0, "reload checks never call a provider");
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    if (gateway) await gateway.close(context);
    await server.close();
  }
});

test("host reload refuses while live work is active and applies nothing", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-busy");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-busy";
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl);
    await writeFile(configFile, JSON.stringify(base));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    const conversation = await gateway.conversationFor("cli:reload-busy", context);

    await writeFile(configFile, JSON.stringify({
      ...base,
      modelPreset: "deep",
      modelPresets: { deep: base.modelPresets.deep },
    }));
    const entered = server.holdNext();
    const submission = await conversation.submit({ type: "input", content: "held", requestId: "reload-held" }, context);
    const settled = submission.wait(context);
    await within(entered, 5_000, "the held provider request never arrived");
    assert.deepEqual(await gateway.reloadModels(context), { status: "busy" });
    assert.deepEqual((await gateway.listModels("cli:reload-busy", context)).selected, {
      provider: "local", modelId: "alpha", thinkingLevel: "off",
    });
    server.release();
    assert.equal((await settled).status, "done");
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 1, presets: 1, defaultPreset: "deep",
    });
    assert.deepEqual((await gateway.listModels("cli:reload-busy", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    server.release();
    if (gateway) await gateway.close(context);
    await server.close();
  }
});

/**
 * A blocked task: its definition is deliberately never installed in the gateway's registry, so the
 * scheduler cannot run it and `inspect()` reports it parked. A new control-plane test needs a
 * nonterminal capture the gateway itself would never create.
 */
function uninstalledTask() {
  return defineTask({
    name: "test.model-reload.blocked",
    version: 1,
    initial: (input) => input.checkpoint,
    phases: {
      start: async () => { throw new Error("an uninstalled task must never run"); },
    },
  });
}

/** Bounded wait for a condition; never polls past its deadline. */
async function untilReady(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

test("reload refuses selection-mode transitions in both directions as restart-required", { timeout: 20_000 }, async () => {
  const server = await localModelServer();
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-mode";
  const gateways = [];
  try {
    // Preset mode refuses a candidate that switches to direct-model selection.
    const presetDirs = await tempDirs("reload-mode-preset");
    const presetFile = resolve(presetDirs.root, "config.json");
    const presetBase = reloadConfigValues(presetDirs.workspace, presetDirs.dataDir, server.baseUrl);
    await writeFile(presetFile, JSON.stringify(presetBase));
    const presetGateway = await openGateway(await loadConfig(presetFile), context, {
      reloadConfig: () => loadConfig(presetFile),
      agentHistory: false,
    });
    gateways.push({ gateway: presetGateway, ...presetDirs });
    await presetGateway.conversationFor("cli:mode-preset", context);
    await writeFile(presetFile, JSON.stringify({
      workspace: presetDirs.workspace,
      dataDir: presetDirs.dataDir,
      providers: presetBase.providers,
      credentials: presetBase.credentials,
      model: { provider: "local", modelId: "alpha" },
      allowedModels: [{ provider: "local", modelId: "alpha" }, { provider: "local", modelId: "beta" }],
      thinkingLevel: "off",
      episodeSummary: { enabled: false },
    }));
    assert.deepEqual(await presetGateway.reloadModels(context), { status: "refused", reason: "mode" });
    const presetListing = await presetGateway.listModels("cli:mode-preset", context);
    assert.equal(presetListing.presets.length, 2, "a refused mode change applies no catalog");
    assert.deepEqual(presetListing.selected, { provider: "local", modelId: "alpha", thinkingLevel: "off" });

    // A within-mode reload still works after a refused transition.
    await writeFile(presetFile, JSON.stringify({ ...presetBase, modelPreset: "deep" }));
    assert.deepEqual(await presetGateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
    assert.deepEqual((await presetGateway.listModels("cli:mode-preset", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });

    // Direct mode refuses a candidate that introduces named presets.
    const directDirs = await tempDirs("reload-mode-direct");
    const directFile = resolve(directDirs.root, "config.json");
    const directBase = {
      workspace: directDirs.workspace,
      dataDir: directDirs.dataDir,
      providers: presetBase.providers,
      credentials: { local: "RELOAD_MODEL_KEY" },
      model: { provider: "local", modelId: "alpha" },
      allowedModels: [{ provider: "local", modelId: "alpha" }, { provider: "local", modelId: "beta" }],
      thinkingLevel: "off",
      episodeSummary: { enabled: false },
    };
    await writeFile(directFile, JSON.stringify(directBase));
    const directGateway = await openGateway(await loadConfig(directFile), context, {
      reloadConfig: () => loadConfig(directFile),
      agentHistory: false,
    });
    gateways.push({ gateway: directGateway, ...directDirs });
    await directGateway.conversationFor("cli:mode-direct", context);
    // Preset mode owns the whole catalog, so the candidate replaces the direct fields instead of
    // extending them: that is the file an owner writes to switch, and it is refused, not applied.
    await writeFile(directFile, JSON.stringify({
      workspace: directDirs.workspace,
      dataDir: directDirs.dataDir,
      providers: directBase.providers,
      credentials: directBase.credentials,
      modelPresets: { deep: { provider: "local", modelId: "beta", thinkingLevel: "high" } },
      modelPreset: "deep",
      episodeSummary: { enabled: false },
    }));
    assert.deepEqual(await directGateway.reloadModels(context), { status: "refused", reason: "mode" });
    const directListing = await directGateway.listModels("cli:mode-direct", context);
    assert.equal(directListing.presets, undefined, "a refused mode change publishes no preset catalog");
    assert.deepEqual(directListing.selected, { provider: "local", modelId: "alpha", thinkingLevel: "off" });

    // A within-mode direct reload still works after the refusal. The existing chat keeps its
    // still-allowed selection; a new conversation receives the new configured default.
    await writeFile(directFile, JSON.stringify({ ...directBase, model: { provider: "local", modelId: "beta" } }));
    assert.deepEqual(await directGateway.reloadModels(context), { status: "reloaded", models: 2, presets: 0 });
    assert.deepEqual((await directGateway.listModels("cli:mode-direct", context)).selected, {
      provider: "local", modelId: "alpha", thinkingLevel: "off",
    });
    await directGateway.conversationFor("cli:mode-direct-new", context);
    assert.deepEqual((await directGateway.listModels("cli:mode-direct-new", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "off",
    });
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    for (const entry of gateways.reverse()) {
      await entry.gateway.close(context).catch(() => undefined);
      await rm(entry.root, { recursive: true, force: true });
    }
    await server.close();
  }
});

test("reload allows an armed cron timer but refuses a blocked background capture", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-capture");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-capture";
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl, { cron: { enabled: true } });
    await writeFile(configFile, JSON.stringify(base));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    const conversation = await gateway.conversationFor("cli:reload-capture", context);
    const created = await gateway.cronOperator.create("cli:reload-capture", {
      message: "report later",
      schedule: { kind: "every", everyMs: 3_600_000 },
      idempotencyKey: "reload-capture-timer",
    }, context);
    assert.equal(created.status, "scheduled");
    // The armed timer really is a sleeping native task, so this proves the allowed exception.
    const timer = await untilReady(async () => (await gateway.harness.inspect(context)).tasks
      .find((task) => task.record.kind === "nanobot.cron.timer" && task.state.kind === "sleeping"), "the armed cron timer");
    assert.ok(timer);

    await writeFile(configFile, JSON.stringify({ ...base, modelPreset: "deep" }));
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
    assert.deepEqual((await gateway.listModels("cli:reload-capture", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });

    // A blocked capture cannot run here, but it would resume later; rotating credential references
    // or the catalog under it would silently change its authority, so the reload is refused.
    await gateway.harness.commit(
      (tx) => tx.createTask(uninstalledTask(), { checkpoint: { phase: "start" } }, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      }),
      context,
    );
    await untilReady(async () => (await gateway.harness.inspect(context)).tasks
      .find((task) => task.record.kind === "test.model-reload.blocked" && task.state.kind === "blocked"),
    "the blocked capture");

    await writeFile(configFile, JSON.stringify({ ...base, modelPreset: "fast" }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "busy" });
    assert.deepEqual((await gateway.listModels("cli:reload-capture", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    }, "a refused reload publishes nothing");
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    if (gateway) await gateway.close(context).catch(() => undefined);
    await server.close();
  }
});

test("a managed MCP edit updates the live baseline so a later model reload still applies", { timeout: 40_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-mcp");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  const fixtures = resolve(import.meta.dirname, "fixtures", "mcp-stdio-server.mjs");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-mcp";
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl);
    await writeFile(configFile, JSON.stringify(base));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    const conversation = await gateway.conversationFor("cli:reload-mcp", context);
    const turn = async (requestId) => {
      const submission = await conversation.submit({ type: "input", content: requestId, requestId }, context);
      assert.equal((await submission.wait(context)).status, "done");
    };
    const addTool = {
      name: "mcp",
      args: {
        action: "add",
        name: "synthetic",
        server: { command: process.execPath, args: [fixtures], cwd: workspace },
      },
    };
    server.script({ tool: addTool }, { text: "added" });
    await turn("add the synthetic server");
    const written = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(written.mcp.enabled, true);
    assert.equal(gateway.mcp.servers.find((entry) => entry.name === "synthetic")?.state, "connected");

    // The managed edit rewrote the same file the reload reads; without the live MCP baseline this
    // candidate would look like an unrelated startup-only change forever.
    await writeFile(configFile, JSON.stringify({ ...written, modelPreset: "deep" }));
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
    assert.equal(gateway.mcp.servers.find((entry) => entry.name === "synthetic")?.state, "connected",
      "a foreground reload leaves MCP authority untouched");

    // A hand edit to the MCP block never reached this process, so it stays a startup-only change:
    // the candidate is refused rather than silently applying a server the gateway is not running.
    await writeFile(configFile, JSON.stringify({
      ...written,
      mcp: { ...written.mcp, servers: { ...written.mcp.servers, hand: written.mcp.servers.synthetic } },
      modelPreset: "fast",
    }));
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "unrelated" });
    assert.deepEqual((await gateway.listModels("cli:reload-mcp", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    }, "an external MCP edit applies nothing");
    // Restore the file the gateway really reflects, then let the owner remove the server normally.
    await writeFile(configFile, JSON.stringify({ ...written, modelPreset: "deep" }));

    server.script({ tool: { name: "mcp", args: { action: "remove", name: "synthetic" } } }, { text: "removed" });
    await turn("remove the synthetic server");
    const removed = JSON.parse(await readFile(configFile, "utf8"));
    assert.deepEqual(removed.mcp.servers, {});
    await writeFile(configFile, JSON.stringify({ ...removed, modelPreset: "fast" }));
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "fast",
    });
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    if (gateway) await gateway.close(context).catch(() => undefined);
    await server.close();
  }
});

test("an input admitted while the candidate is validated keeps the old catalog and publishes nothing", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-admission");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-admission";
  let gateway;
  let settled;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl);
    await writeFile(configFile, JSON.stringify(base));
    const candidate = { ...base, modelPreset: "deep" };
    let armed = false;
    gateway = await openGateway(await loadConfig(configFile), context, {
      // The candidate parses, then this host loader admits a real owner input. The reload's earlier
      // check already passed, so only the post-validation or in-commit gate can refuse it.
      reloadConfig: async () => {
        const parsed = await loadConfig(configFile);
        if (armed) return parsed;
        armed = true;
        const entered = server.holdNext();
        await writeFile(configFile, JSON.stringify(candidate));
        const conversation = await gateway.conversationFor("cli:reload-admission", context);
        const submission = await conversation.submit({ type: "input", content: "admitted-mid-validation", requestId: "mid" }, context);
        settled = submission.wait(context);
        await within(entered, 5_000, "the admitted request never reached the provider");
        return loadConfig(configFile);
      },
      agentHistory: false,
    });
    await gateway.conversationFor("cli:reload-admission", context);
    await writeFile(configFile, JSON.stringify(candidate));
    assert.deepEqual(await gateway.reloadModels(context), { status: "busy" });
    // The admitted turn under the old policy really used the old model and credential, and the
    // refused candidate was never published.
    server.release();
    assert.equal((await settled).status, "done");
    assert.equal(server.requests.at(-1).model, "alpha");
    assert.equal(server.requests.at(-1).authorization, "Bearer synthetic-reload-admission");
    assert.deepEqual((await gateway.listModels("cli:reload-admission", context)).selected, {
      provider: "local", modelId: "alpha", thinkingLevel: "off",
    });
    // Once the live work is gone the same candidate applies normally.
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    server.release();
    if (gateway) await gateway.close(context).catch(() => undefined);
    await server.close();
  }
});

test("reload refuses a disk edit made after its candidate snapshot was read", { timeout: 20_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-disk-race");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-race";
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl);
    const candidate = { ...base, modelPreset: "deep" };
    await writeFile(configFile, JSON.stringify(base));
    let edited = false;
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: async () => {
        const snapshot = await loadConfig(configFile);
        if (!edited) {
          edited = true;
          // The first valid snapshot is now stale, just as when an outside editor writes while
          // credential validation awaits. Only a second disk read can detect the unapplied edit.
          await writeFile(configFile, JSON.stringify({ ...candidate, toolAllowlist: ["read"] }));
        }
        return snapshot;
      },
      agentHistory: false,
    });
    await gateway.conversationFor("cli:reload-disk-race", context);
    await writeFile(configFile, JSON.stringify(candidate));
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "unrelated" });
    assert.equal((await gateway.listModels("cli:reload-disk-race", context)).selected.modelId, "alpha");
    assert.equal(server.requests.length, 0);
    await writeFile(configFile, JSON.stringify(candidate));
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
    assert.equal((await gateway.listModels("cli:reload-disk-race", context)).selected.modelId, "beta");
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    if (gateway) await gateway.close(context).catch(() => undefined);
    await server.close();
  }
});

test("a reload leaves an isolated scheduled target's prepared model and thinking untouched", { timeout: 30_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("reload-cron-target");
  const server = await localModelServer();
  const configFile = resolve(root, "config.json");
  process.env.RELOAD_MODEL_KEY = "synthetic-reload-cron-target";
  let gateway;
  try {
    const base = reloadConfigValues(workspace, dataDir, server.baseUrl, { cron: { enabled: true } });
    await writeFile(configFile, JSON.stringify(base));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    const conversation = await gateway.conversationFor("cli:reload-cron-target", context);
    const created = await gateway.cronOperator.create("cli:reload-cron-target", {
      message: "one background occurrence",
      mode: "background",
      schedule: { kind: "after", afterMs: 50 },
      idempotencyKey: "reload-cron-target-one",
    }, context);
    assert.equal(created.status, "scheduled");
    // The occurrence runs in its own automation conversation, whose AgentDoc carries the model and
    // thinking level prepared from the origin for that run.
    const target = await untilReady(async () => {
      const jobs = await gateway.harness.snapshot(CronJobsDoc, conversation.id, context);
      const id = jobs?.oneOffConversationId;
      return typeof id === "number" && id > 0 ? id : undefined;
    }, "the automation conversation");
    const prepared = await untilReady(async () => {
      const state = await gateway.harness.snapshot(AgentDoc, target, context);
      return state?.model === undefined ? undefined : state;
    }, "the prepared target model");
    assert.deepEqual(prepared.model, { provider: "local", modelId: "alpha" });
    // Wait for the run to settle so the reload's live-work refusal does not apply.
    await untilReady(async () => {
      const jobs = await gateway.harness.snapshot(CronJobsDoc, conversation.id, context);
      const job = jobs?.jobs.find((entry) => entry.idempotencyKey === "reload-cron-target-one");
      return job?.lastOutcome !== null && job?.lastSkip === null ? true : undefined;
    }, "the settled occurrence");

    await writeFile(configFile, JSON.stringify({ ...base, modelPreset: "deep" }));
    assert.deepEqual(await gateway.reloadModels(context), {
      status: "reloaded", models: 2, presets: 2, defaultPreset: "deep",
    });
    assert.deepEqual((await gateway.listModels("cli:reload-cron-target", context)).selected, {
      provider: "local", modelId: "beta", thinkingLevel: "high",
    });
    // The automation conversation is not a chat: it keeps exactly what its run prepared.
    const preserved = await gateway.harness.snapshot(AgentDoc, target, context);
    assert.deepEqual(preserved.model, { provider: "local", modelId: "alpha" });
    assert.equal(preserved.thinkingLevel, "off");
  } finally {
    delete process.env.RELOAD_MODEL_KEY;
    if (gateway) await gateway.close(context).catch(() => undefined);
    await server.close();
  }
});
