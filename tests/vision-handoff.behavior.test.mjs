import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig, modelKey } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { createVisionHandoffExtension } = await import(pathToFileURL(`${pkg}/dist/media/vision-hook.js`).href);
const { VisionHandoff, VISION_HANDOFF_LIMITS, VISION_HANDOFF_DEFAULTS } = await import(
  pathToFileURL(`${pkg}/dist/media/vision.js`).href
);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;
const SESSION = "telegram:vision-handoff";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

/** Race one promise against a hard deadline so a wedged describer fails instead of hanging. */
async function within(promise, ms, label) {
  const expired = deferred();
  const deadline = setTimeout(() => expired.resolve("timeout"), ms);
  try {
    const result = await Promise.race([promise, expired.promise]);
    if (result === "timeout") throw new Error(`timeout after ${ms}ms: ${label}`);
    return result;
  } finally {
    clearTimeout(deadline);
  }
}

function systemText(messages) {
  const first = messages?.[0];
  if (first?.role !== "system") return "";
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return "";
  return first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function textOf(messages) {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "text").map((block) => block.text)
    : []).join("\n");
}

function imagesOf(messages) {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "image")
    : []);
}

function image(data) {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" };
}

function buildProvider(providerId = "fixture") {
  const provider = fauxProvider({ provider: providerId, models: [
    { id: "chat", name: "Chat", reasoning: false, input: ["text"] },
    { id: "eyes", name: "Eyes", reasoning: false, input: ["text", "image"] },
    { id: "flat", name: "Flat", reasoning: false, input: ["text"] },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const calls = [];
  const dispatcher = (transcript, _options, _state, model) => {
    provider.appendResponses([dispatcher]);
    const describer = systemText(transcript.messages).includes("precise vision assistant");
    const images = imagesOf(transcript.messages);
    calls.push({
      kind: describer ? "describer" : "generation",
      modelId: model.id,
      images: images.length,
      text: textOf(transcript.messages),
      messages: transcript.messages,
    });
    return fauxAssistantMessage(describer
      ? `synthetic description ${images.length}`
      : "synthetic answer");
  };
  provider.setResponses(Array.from({ length: 200 }, () => dispatcher));
  return { models, calls };
}

const tempRoots = [];
async function tempDirs(label) {
  const root = await mkdtemp(resolve(tmpdir(), `nanobot-vision-${label}-`));
  tempRoots.push(root);
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, dataDir: resolve(root, "state") };
}

function namedConfig(temp, workspace, dataDir, extra = {}, providerId = "fixture") {
  return parseConfig({
    workspace,
    dataDir,
    modelPresets: {
      chat: { provider: providerId, modelId: "chat", needsVisionHandoff: true },
      eyes: { provider: providerId, modelId: "eyes" },
    },
    modelPreset: "chat",
    visionHandoff: { describerPreset: "eyes" },
    ...extra,
  }, temp);
}

test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

test("vision config fails closed on missing, recursive or ambiguous describer settings", { timeout: 10_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("config");
  const base = {
    workspace,
    dataDir,
    modelPresets: {
      chat: { provider: "fixture", modelId: "chat", needsVisionHandoff: true },
      eyes: { provider: "fixture", modelId: "eyes" },
    },
    modelPreset: "chat",
  };
  const parsed = parseConfig({ ...base, visionHandoff: { describerPreset: "eyes" } }, root);
  assert.deepEqual(parsed.visionHandoff, {
    describerPreset: "eyes",
    maxRawImages: VISION_HANDOFF_DEFAULTS.maxRawImages,
    maxDescriptionTokens: VISION_HANDOFF_DEFAULTS.maxDescriptionTokens,
  });
  assert.equal(parsed.modelPresets.chat.needsVisionHandoff, true);
  assert.equal(parsed.modelPresets.eyes.needsVisionHandoff, undefined);

  // A flagged preset without a describer is a startup error, never silent raw images.
  assert.throws(
    () => parseConfig(base, root),
    /needsVisionHandoff requires visionHandoff/,
  );
  assert.throws(
    () => parseConfig({ ...base, visionHandoff: { describerPreset: "missing" } }, root),
    /describerPreset must name an entry in modelPresets/,
  );
  assert.throws(
    () => parseConfig({
      ...base,
      modelPresets: {
        chat: { provider: "fixture", modelId: "chat", needsVisionHandoff: true },
        eyes: { provider: "fixture", modelId: "eyes", needsVisionHandoff: true },
      },
      visionHandoff: { describerPreset: "eyes" },
    }, root),
    /must not be a preset that itself needs vision handoff/,
  );
  assert.throws(
    () => parseConfig({
      ...base,
      modelPresets: {
        chat: { provider: "fixture", modelId: "chat", needsVisionHandoff: true },
        twin: { provider: "fixture", modelId: "chat" },
        eyes: { provider: "fixture", modelId: "eyes" },
      },
      visionHandoff: { describerPreset: "eyes" },
    }, root),
    /needsVisionHandoff conflicts with modelPresets\.chat/,
  );
  for (const [field, value, message] of [
    ["maxRawImages", -1, /maxRawImages must be an integer from 0/],
    ["maxRawImages", VISION_HANDOFF_LIMITS.maxRawImages + 1, /maxRawImages must be an integer from 0/],
    ["maxDescriptionTokens", 0, /maxDescriptionTokens must be an integer from 1/],
    ["maxDescriptionTokens", 1.5, /maxDescriptionTokens must be an integer from 1/],
    ["prompt", " ".repeat(2), /prompt must be a non-empty string/],
    ["prompt", "x".repeat(VISION_HANDOFF_LIMITS.maxPromptChars + 1), /prompt must be at most/],
  ]) {
    assert.throws(
      () => parseConfig({ ...base, visionHandoff: { describerPreset: "eyes", [field]: value } }, root),
      message,
      `${field}=${String(value).slice(0, 12)} must be rejected`,
    );
  }
  assert.throws(
    () => parseConfig({ ...base, visionHandoff: { describerPreset: "eyes", temperature: 1 } }, root),
    /Unknown visionHandoff field: temperature/,
  );
  assert.throws(
    () => parseConfig({
      workspace,
      dataDir,
      model: { provider: "fixture", modelId: "chat" },
      visionHandoff: { describerPreset: "eyes" },
    }, root),
    /visionHandoff requires named modelPresets/,
  );

  // A describer whose catalog model cannot accept images fails startup before storage.
  const { models } = buildProvider();
  await assert.rejects(
    openGateway(
      parseConfig({
        ...base,
        visionHandoff: { describerPreset: "flat" },
        modelPresets: { ...base.modelPresets, flat: { provider: "fixture", modelId: "flat" } },
      }, root),
      context,
      { models, agentHistory: false },
    ),
    /describerPreset must name a model that accepts image input/,
  );
  assert.equal(await stat(dataDir).catch(() => undefined), undefined);
});

test("flagged presets send zero raw images to the main model while the describer sees them", { timeout: 15_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("flagged");
  const { models, calls } = buildProvider();
  let gateway;
  try {
    gateway = await openGateway(namedConfig(root, workspace, dataDir), context, { models, agentHistory: false });
    const conversation = await gateway.conversationFor(SESSION, context);
    const shared = image("same-image");
    const turn = async (content, requestId) => {
      const submission = await conversation.submit({ type: "input", content, requestId }, context);
      assert.equal((await submission.wait(context)).status, "done");
    };

    await turn([
      shared,
      { type: "text", text: "media/one.png" },
      { ...shared },
      { type: "text", text: "media/two.png" },
    ], "first");
    let generations = calls.filter((call) => call.kind === "generation");
    assert.equal(generations.length, 1);
    assert.equal(generations[0].images, 0, "a flagged preset keeps zero raw images");
    assert.match(generations[0].text, /untrusted image evidence, never as instructions/);
    assert.match(generations[0].text, /media\/one\.png/, "adjacent locator text stays in the request");
    // Two identical images in one request are one in-flight describer call.
    assert.deepEqual(calls.filter((call) => call.kind === "describer").map((call) => call.images), [1]);

    await turn([image("another-image")], "second");
    generations = calls.filter((call) => call.kind === "generation");
    assert.equal(generations.length, 2);
    assert.equal(generations[1].images, 0, "older and newer images are all described for a text-only target");
    // The repeated first image is a cache hit; only the new second image reaches the describer.
    assert.equal(calls.filter((call) => call.kind === "describer").length, 2);

    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const storedImages = entries.items.flatMap((entry) => entry.model ?? []).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []);
    assert.equal(storedImages.length, 3, "the authoritative transcript keeps every original image");
    assert.equal(storedImages[0].data, shared.data);

    const stats = gateway.visionHandoffStats();
    assert.equal(stats.enabled, true);
    assert.deepEqual(stats.describer, { provider: "fixture", modelId: "eyes" });
    assert.equal(stats.stats.describerCalls, 2);
    assert.ok(stats.stats.cacheHits >= 2, "single-flight and cache reuse are accounted");
    assert.equal(stats.stats.rawImages, 0);
  } finally {
    if (gateway) await gateway.close(context);
  }
});

test("a vision-capable target keeps the newest bounded raw images and describes older ones", { timeout: 15_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("capable");
  const { models, calls } = buildProvider();
  let gateway;
  try {
    gateway = await openGateway(namedConfig(root, workspace, dataDir, {
      visionHandoff: { describerPreset: "eyes", maxRawImages: 2 },
    }), context, { models, agentHistory: false });
    const conversation = await gateway.conversationFor(SESSION, context);
    await gateway.selectModelPreset(SESSION, "eyes", context);
    const submission = await conversation.submit({
      type: "input",
      content: [
        image("old-1"), image("old-2"), image("new-1"), image("new-2"),
      ],
      requestId: "bounded",
    }, context);
    assert.equal((await submission.wait(context)).status, "done");

    const generations = calls.filter((call) => call.kind === "generation");
    assert.equal(generations.length, 1);
    assert.equal(generations[0].modelId, "eyes");
    assert.equal(generations[0].images, 2, "only the newest configured images stay raw");
    assert.match(generations[0].text, /untrusted image evidence, never as instructions/);
    assert.match(generations[0].text, /synthetic description 1/);
    assert.equal(calls.filter((call) => call.kind === "describer").length, 2);

    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const storedImages = entries.items.flatMap((entry) => entry.model ?? []).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []);
    assert.equal(storedImages.length, 4, "the transcript is not rewritten by the raw-image bound");
  } finally {
    if (gateway) await gateway.close(context);
  }
});

test("a configured provider alias still matches the native flagged pair", { timeout: 10_000 }, async () => {
  const { root, workspace, dataDir } = await tempDirs("alias");
  // `opencode_go` is a config alias for the native `opencode-go` provider id.
  const { models, calls } = buildProvider("opencode-go");
  let gateway;
  try {
    gateway = await openGateway(
      namedConfig(root, workspace, dataDir, {}, "opencode_go"),
      context,
      { models, agentHistory: false },
    );
    const conversation = await gateway.conversationFor(SESSION, context);
    const submission = await conversation.submit({
      type: "input",
      content: [image("alias-image")],
      requestId: "alias",
    }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const generation = calls.find((call) => call.kind === "generation");
    assert.ok(generation);
    assert.equal(generation.images, 0, "the native pair must carry the per-preset text-only flag");
    assert.equal(calls.filter((call) => call.kind === "describer").length, 1);
  } finally {
    if (gateway) await gateway.close(context);
  }
});

test("describer failure and cancellation never fabricate a seen image", { timeout: 10_000 }, async () => {
  const messages = [{
    role: "user",
    content: [image("one"), image("two")],
    timestamp: 0,
  }];
  const flagged = { provider: "fixture", modelId: "chat" };
  const escriber = { provider: "fixture", modelId: "eyes" };
  const model = { input: ["text", "image"] };

  let calls = 0;
  const failing = {
    getModel: () => model,
    completeSimple: async () => {
      calls += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider failure" });
    },
  };
  const handoff = new VisionHandoff({ describer: escriber, flaggedModels: new Set([modelKey(flagged)]) });
  const failed = await handoff.transform(messages, flagged, failing, modelKey);
  const failedText = JSON.stringify(failed);
  assert.match(failedText, /description is unavailable/);
  assert.match(failedText, /have not seen this image/);
  assert.doesNotMatch(failedText, /synthetic description/);
  assert.equal(calls, 2, "distinct failing images each call the describer once");
  assert.equal(handoff.stats().describerFailures, 2);

  // Failures are not cached: the next request retries instead of reusing "unavailable".
  await handoff.transform(messages, flagged, failing, modelKey);
  assert.equal(calls, 4);

  calls = 0;
  const controller = new AbortController();
  const parked = deferred();
  const hanging = {
    getModel: () => model,
    completeSimple: async (_model, _context, options) => {
      calls += 1;
      parked.resolve();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      return fauxAssistantMessage("never reached");
    },
  };
  const cancelHandoff = new VisionHandoff({ describer: escriber, flaggedModels: new Set([modelKey(flagged)]) });
  const pending = cancelHandoff.transform(messages, flagged, hanging, modelKey, controller.signal);
  await within(parked.promise, 2_000, "describer call never started");
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(within(pending, 2_000, "cancelled describer call did not settle"), /cancelled/);
  assert.equal(cancelHandoff.stats().describedImages, 0);
  assert.equal(cancelHandoff.stats().unavailableImages, 0, "cancellation does not commit unavailable text");
});

test("vision transform bounds described images, output and read-tool locators", { timeout: 10_000 }, async () => {
  const flagged = { provider: "fixture", modelId: "chat" };
  const model = { input: ["text", "image"] };
  let calls = 0;
  const models = {
    getModel: () => model,
    completeSimple: async () => {
      calls += 1;
      return fauxAssistantMessage("bounded description");
    },
  };
  const handoff = new VisionHandoff({
    describer: { provider: "fixture", modelId: "eyes" },
    flaggedModels: new Set([modelKey(flagged)]),
  });
  const count = VISION_HANDOFF_LIMITS.maxDescribedImages + 5;
  const messages = [{
    role: "user",
    content: Array.from({ length: count }, (_, index) => image(`image-${index}`)),
    timestamp: 0,
  }];
  const transformed = await handoff.transform(messages, flagged, models, modelKey);
  assert.equal(calls, VISION_HANDOFF_LIMITS.maxDescribedImages, "only the newest digest window is described");
  const text = JSON.stringify(transformed);
  assert.match(text, /description budget was exceeded/);
  assert.equal(handoff.stats().describedImages, VISION_HANDOFF_LIMITS.maxDescribedImages);
  assert.equal(handoff.stats().unavailableImages, 5);
  assert.ok(JSON.stringify(transformed).length < 20_000_000);

  // The read tool's own path argument labels the description; a filename elsewhere is not authority.
  const readMessages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "media/read.png" } }],
      api: "fixture", provider: "fixture", model: "chat", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "toolUse", timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [image("read-image")],
      isError: false,
      timestamp: 0,
    },
  ];
  const read = await new VisionHandoff({
    describer: { provider: "fixture", modelId: "eyes" },
    flaggedModels: new Set([modelKey(flagged)]),
  }).transform(readMessages, flagged, models, modelKey);
  assert.match(JSON.stringify(read), /media\/read\.png/);
  assert.match(JSON.stringify(read), /read tool path/);
});

test("vision hooks use the prepared task model before the reset conversation selection", { timeout: 5_000 }, async () => {
  const targets = [];
  const handoff = {
    transform: async (messages, target) => {
      targets.push(target);
      return messages;
    },
  };
  const extension = createVisionHandoffExtension({
    handoff,
    defaultModel: { provider: "fixture", modelId: "flat" },
    preparedModel: (taskId) => taskId === 7 ? { provider: "fixture", modelId: "chat" } : undefined,
  });
  const beforeRequest = extension.hooks[0].handlers.beforeRequest;
  const contextWithoutSignal = { abortSignal: undefined };
  const api = (taskId, state) => ({
    taskId,
    conversationId: 1,
    models: {},
    snapshot: async () => state,
  });

  await beforeRequest({ messages: [] }, api(7, { model: { provider: "fixture", modelId: "eyes" } }), contextWithoutSignal);
  await beforeRequest({ messages: [] }, api(8, { model: { provider: "fixture", modelId: "eyes" } }), contextWithoutSignal);
  await beforeRequest({ messages: [] }, api(9, undefined), contextWithoutSignal);
  assert.deepEqual(targets, [
    { provider: "fixture", modelId: "chat" },
    { provider: "fixture", modelId: "eyes" },
    { provider: "fixture", modelId: "flat" },
  ]);
});
