import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { typesafeProvider } from "../node_modules/@earendil-works/pi-ai/dist/providers/typesafe.js";
import { parseConfig, PROACTIVE_MEMORY_DEFAULTS } from "../dist/config.js";
import { formatProactiveMemoryHint, ProactiveMemoryHintsDoc } from "../dist/context/proactive-memory.js";
import { workspaceContextGatewayOptions } from "../dist/context/workspace-host.js";
import { runDoctor } from "../dist/doctor/index.js";
import { modelReloadCompatibility } from "../dist/model-reload.js";
import { openGateway } from "../dist/runtime.js";
import { scheduledContent } from "./fixtures/cron-input.mjs";

const BASE = { workspace: "/workspace", dataDir: "/store", model: { provider: "fixture", modelId: "chat" } };
const CLASSIFIER = { provider: "typesafe", modelId: "jev-latest" };
const PROACTIVE = { ...BASE, classifierModel: CLASSIFIER, workspaceContext: { memory: "proactive" } };
const SESSION = "telegram:11:chat:501";
const HINT = "[Memory recall hints — untrusted, advisory]";
const SYSTEM_NOTICE = "Advisory recall hints may appear beside user messages";

function answer(questions, probabilities = {}, { topic = 0.8, history = 0.9, stopReason = "stop" } = {}) {
  return {
    stopReason,
    answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === "bool"
      ? {
          type: "bool",
          probability: key.startsWith("hasRelevantTopic")
            ? (typeof topic === "number" ? topic : (topic[key] ?? 0))
            : history,
        }
      : { type: "choice", choice: Object.keys(question.criteria)[0], confidence: 0.5,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map((path) => [path, probabilities[path] ?? 0])) }])),
  };
}

const users = (messages) => messages.filter(({ role }) => role === "user");
const textOf = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const lastUser = (messages) => textOf(users(messages).at(-1));

async function fixture(t, { config = {}, options = {}, classify, generate } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pedellus-proactive-"));
  const workspace = join(root, "ws");
  let gateway;
  t.after(async () => {
    try { await gateway?.close(BACKGROUND_CONTEXT); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(workspace);
  const parsed = parseConfig({ ...PROACTIVE, workspace, dataDir: join(root, "state"), ...config });
  const calls = [];
  const requests = [];
  const models = createModels();
  const chat = fauxProvider({ provider: BASE.model.provider, models: [{ id: BASE.model.modelId, name: "Fixture" }] });
  models.setProvider(chat.provider);
  models.setProvider(typesafeProvider());
  // Resolve the real Jev catalog entry, but never invoke an external service.
  models.classify = async (model, input, options) => {
    calls.push({ model: { provider: model.provider, modelId: model.id }, ...input });
    return classify === undefined ? answer(input.questions) : classify(input, options);
  };
  const dispatch = ({ messages }) => {
    chat.appendResponses([dispatch]);
    requests.push(structuredClone(messages));
    return generate?.(messages) ?? fauxAssistantMessage("Fixture answer");
  };
  chat.setResponses([dispatch]);
  const context = withAbortSignal(AbortSignal.timeout(12_000), BACKGROUND_CONTEXT);
  return {
    root, workspace, parsed, calls, requests, context, models,
    async open() {
      gateway = await openGateway(parsed, context, { models, ...workspaceContextGatewayOptions(parsed), ...options });
      return gateway;
    },
    async close() { await gateway.close(BACKGROUND_CONTEXT); gateway = undefined; },
  };
}

async function send(conversation, context, content, extra = {}) {
  const input = await conversation.submit({ type: "input", content, ...extra }, context);
  assert.equal((await input.wait(context)).status, "done");
}

async function note(workspace, path, content) {
  const full = join(workspace, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

test("validates proactive config, keeps startup-only fields, and reports safe doctor diagnostics", async (t) => {
  const defaults = parseConfig({ ...PROACTIVE, proactiveMemory: {} });
  assert.deepEqual(defaults.proactiveMemory, PROACTIVE_MEMORY_DEFAULTS);
  assert.throws(() => parseConfig({ ...PROACTIVE, classifierModel: undefined }), /requires classifierModel/);
  assert.throws(() => parseConfig({ ...PROACTIVE, workspaceContext: { memory: "off", memoryManifest: false } }), /cannot be combined/);
  assert.throws(() => parseConfig({ ...PROACTIVE, workspaceContext: { memory: "private-value" } }), /must be off, manifest or proactive/);
  assert.throws(() => parseConfig({ ...BASE, proactiveMemory: {} }), /requires workspaceContext\.memory/);
  assert.throws(() => parseConfig({ ...PROACTIVE, workspaceContext: {
    memory: "proactive", memoryFiles: [`memory/${"x".repeat(65)}.md`],
  } }), /workspaceContext.memoryFiles is invalid/);
  assert.equal(parseConfig({ ...BASE, workspaceContext: { memoryManifest: true } }).workspaceContext.memoryManifest, true);
  assert.equal(parseConfig({ ...BASE, workspaceContext: { memory: "manifest" } }).workspaceContext.memory, "manifest");
  for (const [key, value] of [["timeoutMs", 99], ["timeoutMs", 15_001], ["maxTopics", 1.5], ["maxTopics", 21],
    ["topicGateThreshold", Infinity], ["topicMinProbability", -0.1], ["historyGateThreshold", 1.1]]) {
    assert.throws(() => parseConfig({ ...PROACTIVE, proactiveMemory: { [key]: value } }), new RegExp(`proactiveMemory\\.${key} must be`));
  }
  assert.equal(modelReloadCompatibility(defaults, parseConfig({ ...PROACTIVE, proactiveMemory: { maxTopics: 4 } })), "unrelated");
  assert.equal(modelReloadCompatibility(defaults, parseConfig({ ...PROACTIVE, workspaceContext: { memory: "manifest" } })), "unrelated");

  const { root, workspace, models, parsed, context } = await fixture(t);
  await assert.rejects(openGateway({ ...parsed, classifierModel: undefined }, context, { models }), /requires classifierModel/);
  const configPath = join(root, "config.json");
  const doctor = async (changes) => {
    await writeFile(configPath, JSON.stringify({ ...PROACTIVE, workspace, ...changes }));
    let output = "";
    await runDoctor({ configPath, output: { write: (chunk) => { output += chunk; } }, env: {},
      platform: "linux", nodeVersion: "v22.19.0", isWsl: false, socketProbe: async () => "closed" });
    assert.doesNotMatch(output, /private-value/);
    return output;
  };
  assert.match(await doctor({ classifierModel: undefined }), /workspaceContext\.memory requires classifierModel/);
  assert.match(await doctor({ proactiveMemory: { timeoutMs: "private-value" } }), /proactiveMemory\.timeoutMs must be an integer/);
  assert.match(await doctor({ proactiveMemory: { "private-value.with.dots": true } }), /proactiveMemory contains an unrecognized option/);
});

test("one Jev call ranks fresh unloaded notes across choice chunks and replaces the memory tree", async (t) => {
  const classified = [];
  t.mock.method(console, "info", (line) => {
    const event = JSON.parse(line.slice("pedellus journal: ".length));
    if (event.event === "gateway.proactiveMemory.classified") classified.push(event.attributes);
  });
  const { workspace, context, calls, requests, open } = await fixture(t, {
    config: {
      workspaceContext: { memory: "proactive", memoryFiles: ["memory/loaded.md"] },
      proactiveMemory: { maxTopics: 3 },
    },
    classify: ({ questions }) => answer(questions, {
      "memory/note-001.md": 0.40, "memory/note-002.md": 0.25, "memory/note-003.md": 0.20,
      "memory/note-255.md": 0.95,
    }, { topic: { hasRelevantTopic_0: 0.8, hasRelevantTopic_1: 0.2 } }),
  });
  await note(workspace, "memory/loaded.md", "EXPLICIT MEMORY CONTENT");
  await note(workspace, "memory/system/nested/base.md", "SYSTEM MEMORY CONTENT");
  const gateway = await open();
  const conversation = await gateway.conversationFor(SESSION, context);
  assert.equal(calls.length, 0, "startup and conversation setup do not call the classifier");
  for (let i = 0; i < 256; i++) {
    await note(workspace, `memory/note-${String(i).padStart(3, "0")}.md`, `---\ndescription: Note ${i}\n---\nTOPIC BODY`);
  }
  await send(conversation, context, "Check our earlier choice");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].model, CLASSIFIER);
  assert.equal(classified.length, 1);
  const { latencyMs, ...metadata } = classified[0];
  assert.ok(Number.isFinite(latencyMs));
  assert.deepEqual(metadata, { candidateTopics: 256, matchedTopics: 3, needsHistoryRecall: true });
  assert.deepEqual(calls[0].state, { newMessage: "Check our earlier choice" });
  const questions = calls[0].questions;
  assert.deepEqual(Object.keys(questions), [
    "hasRelevantTopic_0", "relevantTopic_0", "hasRelevantTopic_1", "relevantTopic_1", "needsHistoryRecall",
  ]);
  assert.equal(questions.hasRelevantTopic_0.type, "bool");
  assert.equal(questions.hasRelevantTopic_1.type, "bool");
  assert.equal(questions.needsHistoryRecall.type, "bool");
  assert.equal(questions.relevantTopic_0.type, "choice");
  assert.equal(questions.relevantTopic_1.type, "choice");
  assert.equal(Object.keys(questions.relevantTopic_0.criteria).length, 128);
  assert.equal(Object.keys(questions.relevantTopic_1.criteria).length, 128);
  assert.equal(questions.relevantTopic_0.criteria["memory/note-001.md"], "Note 1");
  assert.equal(questions.relevantTopic_1.criteria["memory/note-255.md"], "Note 255");
  assert.doesNotMatch(JSON.stringify(questions), /loaded\.md|system\/nested|TOPIC BODY/);
  const prompt = JSON.stringify(requests[0].filter(({ role }) => role === "system"));
  assert.match(prompt, /EXPLICIT MEMORY CONTENT/);
  assert.match(prompt, /SYSTEM MEMORY CONTENT/);
  assert.ok(prompt.includes(SYSTEM_NOTICE));
  assert.doesNotMatch(prompt, /# Memory Tree|TOPIC BODY|note-255/);
  // Chunk 1's companion gate failed (0.2 < 0.5), so note-255's local 0.95 peak is excluded;
  // chunk 0's candidates are weighted by its gate (0.8 * 0.40 = 32%, 0.8 * 0.25 = 20%, 0.8 * 0.20 = 16%).
  assert.match(lastUser(requests[0]), /note-001\.md" \(32%\), "memory\/note-002\.md" \(20%\), "memory\/note-003\.md" \(16%\)/);
  assert.match(lastUser(requests[0]), /prior conversations with memory_search or memory_browse/);
  assert.doesNotMatch(lastUser(requests[0]), /note-255/);
  const escaped = formatProactiveMemoryHint({ topics: [{ path: "memory/a\u2028b\u2029.md", probability: 0.4 }], needsHistoryRecall: false });
  assert.match(escaped, /a\\u2028b\\u2029/);
  assert.equal(formatProactiveMemoryHint({ topics: [], needsHistoryRecall: true }, false), undefined);
});

test("hints are stable across tool rounds, identical timestamps, subsequent turns and reopen; recall remains clean", async (t) => {
  let toolIssued = false;
  const { workspace, context, requests, calls, open, close } = await fixture(t, {
    config: { toolAllowlist: ["read"] },
    classify: ({ questions, state }) => answer(questions, { "memory/topic.md": state.recentConversation === undefined ? 0.93 : 0.81 }),
    generate() {
      if (toolIssued) return;
      toolIssued = true;
      return fauxAssistantMessage([fauxToolCall("read", { path: "sample.txt" }, { id: "probe-read" })], { stopReason: "toolUse" });
    },
  });
  await note(workspace, "memory/topic.md", "# Topic");
  await note(workspace, "sample.txt", "EXCLUDE TOOL RESULT CONTENT");
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  let gateway = await open();
  let conversation = await gateway.conversationFor(SESSION, context);
  const input = [{ type: "text", text: "Identical owner text" }];
  await send(conversation, context, input);
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 2);
  const first = users(requests[0])[0];
  assert.match(textOf(first), /93%/);
  assert.deepEqual(users(requests[1]), [first]);

  await send(conversation, context, input);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].state, {
    newMessage: "Identical owner text", recentConversation: "Owner: Identical owner text\nAssistant: Fixture answer",
  });
  const next = users(requests.at(-1));
  assert.equal(next[0].timestamp, next[1].timestamp);
  assert.deepEqual(next[0], first);
  assert.match(textOf(next[1]), /81%/);
  const entries = await gateway.historyEntries(SESSION, {}, 50, undefined, context);
  const owners = entries.items.filter(({ kind }) => kind === "pi.user");
  assert.equal(owners.length, 2);
  assert.deepEqual(owners.map(({ model }) => model[0].content), [input, input]);
  const lookup = (query) => gateway.memorySearch(conversation.id, { target: "messages", query }, context);
  assert.equal((await lookup("Identical owner text")).hits.length, 2);
  assert.equal((await lookup(HINT)).hits.length, 0);
  await close();

  gateway = await open();
  conversation = await gateway.conversationFor(SESSION, context);
  assert.equal(calls.length, 2);
  const persisted = await gateway.harness.snapshot(ProactiveMemoryHintsDoc, conversation.id, context);
  assert.equal(Object.keys(persisted.decisions).length, 2);
  await send(conversation, context, "Third turn");
  assert.equal(calls.length, 3);
  assert.deepEqual(users(requests.at(-1)).slice(0, 2), next);
});

test("classifier failures leave durable empty decisions that also survive a generation retry", async (t) => {
  const diagnostics = [];
  t.mock.method(console, "error", (message) => diagnostics.push(String(message)));
  let timeoutSignal;
  let failedGeneration = false;
  const { context, calls, requests, open } = await fixture(t, {
    config: { proactiveMemory: { timeoutMs: 100 } },
    classify: ({ state, questions }, { signal }) => {
      if (state.newMessage === "timeout") {
        timeoutSignal = signal;
        return new Promise(() => {});
      }
      if (state.newMessage === "throw") throw new Error("SENSITIVE CLASSIFIER DATA");
      return answer(questions, {}, { stopReason: "error" });
    },
    generate(messages) {
      if (!failedGeneration && lastUser(messages) === "non-stop") {
        failedGeneration = true;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic HTTP 503" });
      }
    },
  });
  const gateway = await open();
  const conversation = await gateway.conversationFor(SESSION, context);
  for (const input of ["timeout", "throw", "non-stop", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]]) {
    await send(conversation, context, input);
  }
  assert.ok(timeoutSignal.aborted);
  assert.equal(timeoutSignal.reason.name, "TimeoutError");
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(calls[0].questions), ["needsHistoryRecall"], "missing memory directory is normal");
  assert.equal(requests.length, 5);
  assert.equal(requests.filter((messages) => lastUser(messages) === "non-stop").length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /untrusted, advisory/);
  assert.match(diagnostics.join("\n"), /gateway\.proactiveMemory/);
  assert.doesNotMatch(diagnostics.join("\n"), /extension_error|SENSITIVE CLASSIFIER DATA/);
  const persisted = await gateway.harness.snapshot(ProactiveMemoryHintsDoc, conversation.id, context);
  assert.deepEqual(Object.values(persisted.decisions), Array.from({ length: 4 }, () => ({ topics: [], needsHistoryRecall: false })));
});

test("only mapped chat owner entries classify, not fork inputs, cron runs, worker prompts or reset handoffs", async (t) => {
  const worker = Promise.withResolvers();
  const isolatedCron = Promise.withResolvers();
  let workerIssued = false;
  const { workspace, context, calls, requests, open } = await fixture(t, {
    config: {
      workers: { enabled: true }, cron: { enabled: true },
      telegram: { tokenEnv: "SYNTHETIC_TELEGRAM_TOKEN", allowFrom: ["501"] },
    },
    options: { agentHistory: false },
    classify: ({ questions }) => answer(questions, { "memory/topic.md": 0.99 }, { topic: 0.1 }),
    generate(messages) {
      const input = lastUser(messages);
      if (input.startsWith("spawn worker") && !workerIssued) {
        workerIssued = true;
        return fauxAssistantMessage([fauxToolCall("worker", {
          action: "start", task: "worker work", workspace_mode: "shared",
        }, { id: "worker-probe" })], { stopReason: "toolUse" });
      }
      if (input.includes("Background worker task.")) worker.resolve();
      if (input === scheduledContent("isolated cron")) isolatedCron.resolve();
    },
  });
  await note(workspace, "memory/topic.md", "# Topic");
  const gateway = await open();
  const chat = await gateway.conversationFor(SESSION, context);
  await send(chat, context, "origin cron", { entry: { kind: "nanobot.cron", data: {} } });
  assert.equal(calls.length, 0);
  await chat.reset("origin reset handoff", context);
  const continuation = await chat.submit({ type: "continue" }, context);
  assert.equal((await continuation.wait(context)).status, "done");
  assert.equal(lastUser(requests.at(-1)), "origin reset handoff");
  assert.equal(calls.length, 0);
  await send(chat, context, "spawn worker");
  await awaitWithContext(worker.promise, context);
  const latest = (await chat.entries({}, 1, undefined, context)).items[0];
  const fork = await chat.fork(latest.id, { ownership: { kind: "ownerless" } }, context);
  await send(fork, context, "ungranted fork input");

  const job = await gateway.cronOperator.create(SESSION, {
    message: "isolated cron", mode: "background", schedule: { kind: "after", afterMs: 500 }, idempotencyKey: "cron-probe",
  }, context);
  assert.equal(job.status, "scheduled");
  await awaitWithContext(isolatedCron.promise, context);
  assert.deepEqual(calls.map(({ state }) => state.newMessage), ["spawn worker"]);
  assert.deepEqual(Object.keys(calls[0].questions), ["hasRelevantTopic", "relevantTopic"]);
  assert.doesNotMatch(JSON.stringify(requests), /untrusted, advisory/);
});

test("reopening with agentHistory: false suppresses stored history nudges and batched steers classify together", async (t) => {
  const { workspace, context, calls, requests, open, close } = await fixture(t, {
    config: { toolAllowlist: ["read"] },
    classify: ({ questions }) => answer(questions, { "memory/topic.md": 0.9 }, { topic: 0.9, history: 0.9 }),
  });
  await note(workspace, "memory/topic.md", "# Topic");
  let gateway = await open();
  let chat = await gateway.conversationFor(SESSION, context);
  await send(chat, context, "First turn");
  assert.match(lastUser(requests.at(-1)), /memory_search or memory_browse/);
  await close();

  // Reopen with agentHistory: false — previously stored needsHistoryRecall must not replay.
  let holdSecondRound;
  const secondRoundHeld = new Promise((resolve) => { holdSecondRound = resolve; });
  let releaseTool;
  const toolReleased = new Promise((resolve) => { releaseTool = resolve; });
  let toolIssued = false;
  const reopenedConfig = parseConfig({
    ...PROACTIVE, workspace, dataDir: join(dirname(workspace), "state"), toolAllowlist: ["read"],
  });
  const reopenedModels = createModels();
  const faux = fauxProvider({ provider: BASE.model.provider, models: [{ id: BASE.model.modelId, name: "Fixture" }] });
  const reply = async ({ messages }) => {
    faux.appendResponses([reply]);
    requests.push(structuredClone(messages));
    if (!toolIssued) {
      toolIssued = true;
      holdSecondRound();
      await toolReleased;
      return fauxAssistantMessage([fauxToolCall("read", { path: "sample.txt" }, { id: "batch-read" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("No-history answer");
  };
  await note(workspace, "sample.txt", "hello");
  faux.setResponses([reply]);
  reopenedModels.setProvider(faux.provider);
  reopenedModels.setProvider(typesafeProvider());
  reopenedModels.classify = async (model, input) => {
    calls.push({ model: { provider: model.provider, modelId: model.id }, ...input });
    return answer(input.questions, { "memory/topic.md": 0.85 }, { topic: 0.9 });
  };
  gateway = await openGateway(reopenedConfig, context, {
    models: reopenedModels,
    ...workspaceContextGatewayOptions(reopenedConfig),
    agentHistory: false,
  });
  t.after(async () => { await gateway?.close(BACKGROUND_CONTEXT); });
  chat = await gateway.conversationFor(SESSION, context);
  const trigger = await chat.submit({ type: "input", content: "Trigger tool round" }, context);
  await secondRoundHeld;
  // Queue two steered inputs during the active tool round: text followed by image-only.
  const firstBatch = await chat.submit({ type: "input", content: "Steered text context", whenBusy: "steer" }, context);
  const secondBatch = await chat.submit({
    type: "input",
    content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    whenBusy: "steer",
  }, context);
  releaseTool();
  assert.equal((await trigger.wait(context)).status, "done");
  assert.equal((await firstBatch.wait(context)).status, "done");
  assert.equal((await secondBatch.wait(context)).status, "done");
  const latestRequest = requests.at(-1);
  // First turn kept its topic hint, but suppressed the stale history nudge under agentHistory: false.
  assert.match(textOf(users(latestRequest)[0]), /memory\/topic\.md/);
  assert.doesNotMatch(textOf(users(latestRequest)[0]), /memory_search or memory_browse/);
  // Batched trailing steers classified the earlier text even though the trailing entry was image-only,
  // and attached the hint to the last entry in that batch.
  const batchCall = calls.find(({ state }) => state.newMessage === "Steered text context");
  assert.ok(batchCall !== undefined);
  assert.match(lastUser(latestRequest), /memory\/topic\.md" \(85%\)/);
  await gateway.close(BACKGROUND_CONTEXT);
  gateway = undefined;
});
