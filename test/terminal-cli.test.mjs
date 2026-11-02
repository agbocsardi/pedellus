import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runTerminalConversation } from "../dist/terminal/index.js";
import { inProcessTerminalConversation } from "../dist/terminal/conversation.js";
import { openGateway } from "../dist/runtime.js";
import { parseConfig } from "../dist/config.js";
import { openFullSyncNodeSqliteStorage } from "../dist/storage/sqlite.js";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const timeoutMs = 10_000;

async function eventually(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

async function makeHarness(storage) {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [], modelTools: [] },
  });
  return { harness, conversation, faux };
}

function inputLines(...lines) {
  return (async function* () { yield* lines; })();
}

test("settled final text waits for slow writable and appears exactly once", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  const expected = `synthetic-${"answer-".repeat(50)}`;
  faux.setResponses([fauxAssistantMessage(expected)]);
  const controller = new AbortController();
  let release;
  let entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  const chunks = [];
  let firstWrite = true;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    if (firstWrite) { firstWrite = false; release = callback; entered(); }
    else callback();
  } });
  const terminal = runTerminalConversation(inProcessTerminalConversation(conversation), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input: inputLines("synthetic prompt"), output,
  });
  try {
    await Promise.race([blocked, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("partial did not reach output")), timeoutMs);
      timer.unref();
    })]);
    await eventually(async () => (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.some(AssistantEntry.is), "assistant entry did not settle");
    release();
    release = undefined;
    await terminal;
    const printed = chunks.join("");
    assert.equal(printed.split(expected).length - 1, 1);
    assert.equal(printed.replace(/\n+$/, ""), expected);
  } finally {
    release?.();
    controller.abort();
    await Promise.allSettled([terminal]);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("EOF preserves failed-run follow-up in SQLite for reopen", { timeout: timeoutMs + 2_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-cli-eof-"));
  const database = join(directory, "terminal.sqlite");
  let harness;
  let storage;
  try {
    storage = await openFullSyncNodeSqliteStorage(database, BACKGROUND_CONTEXT);
    const made = await makeHarness(storage);
    harness = made.harness;
    const { conversation, faux } = made;
    faux.setResponses([() => { throw new Error("synthetic provider failure"); }]);
    const outputChunks = [];
    const output = new Writable({ write(chunk, _encoding, callback) { outputChunks.push(chunk.toString()); callback(); } });
    await runTerminalConversation(inProcessTerminalConversation(conversation), BACKGROUND_CONTEXT, {
      input: inputLines("first synthetic prompt", "queued synthetic prompt"), output,
    });
    assert.match(outputChunks.join(""), /1 input\(s\) remain queued/);
    await harness.close(BACKGROUND_CONTEXT);
    harness = undefined;
    await storage.close(BACKGROUND_CONTEXT);
    storage = undefined;

    storage = await openFullSyncNodeSqliteStorage(database, BACKGROUND_CONTEXT);
    const reopened = await makeHarness(storage);
    harness = reopened.harness;
    const watch = await reopened.conversation.watch(BACKGROUND_CONTEXT);
    try {
      const inbox = watch.value.docs["pi.inbox"];
      assert.equal(inbox.items.length, 1);
      assert.match(JSON.stringify(inbox.items), /queued synthetic prompt/);
    } finally { await watch.stop(); }
  } finally {
    await harness?.close(BACKGROUND_CONTEXT);
    await storage?.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("controls execute between preceding and following admissions", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  const operations = [];
  let releaseAdmission;
  let markEntered;
  const gate = new Promise((resolve) => { releaseAdmission = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const proxy = new Proxy(conversation, { get(target, property) {
    if (property === "submit") return async (...args) => {
      const content = args[0].content;
      operations.push(`submit:${content}:start`);
      if (content === "first") { markEntered(); await gate; }
      const submission = await target.submit(...args);
      operations.push(`submit:${content}:done`);
      return submission;
    };
    if (property === "abort") return async (...args) => {
      operations.push("abort:start");
      const result = await target.abort(...args);
      operations.push("abort:done");
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const controller = new AbortController();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = runTerminalConversation(inProcessTerminalConversation(proxy), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input: inputLines("first", "/abort", "second"), output,
  });
  try {
    await entered;
    assert.deepEqual(operations, ["submit:first:start"]);
    releaseAdmission();
    await terminal;
    assert.deepEqual(operations, ["submit:first:start", "submit:first:done", "abort:start", "abort:done", "submit:second:start", "submit:second:done"]);
  } finally {
    releaseAdmission();
    controller.abort();
    await Promise.allSettled([terminal]);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("rejected lines stop ingress while output is backpressured", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation } = await makeHarness(new MemoryStorage());
  let consumed = 0;
  let release;
  let markBlocked;
  const blocked = new Promise((resolve) => { markBlocked = resolve; });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
    release = callback;
    markBlocked();
  } });
  const controller = new AbortController();
  const input = (async function* () {
    for (let i = 0; i < 1000; i++) { consumed++; yield "x".repeat(32_001); }
  })();
  const terminal = runTerminalConversation(inProcessTerminalConversation(conversation), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), { input, output });
  try {
    await blocked;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(consumed, 1);
  } finally {
    controller.abort();
    release?.();
    await Promise.allSettled([terminal]);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("startup errors do not disclose sensitive paths", { timeout: timeoutMs + 2_000 }, () => {
  const secret = "SYNTHETIC-SECRET-CONFIG-PATH";
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--config", `/nonexistent/${secret}`], {
    encoding: "utf8", timeout: timeoutMs,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diagnostic details suppressed/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(secret));
});

test("local model command lists, selects, rejects invalid input without disclosure, and persists through Gateway", { timeout: timeoutMs + 2_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-terminal-model-"));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace);
  const config = parseConfig({
    workspace, dataDir,
    model: { provider: "fixture", modelId: "alpha" },
    allowedModels: [
      { provider: "fixture", modelId: "alpha" },
      { provider: "fixture", modelId: "beta" },
    ],
  }, directory);
  const provider = fauxProvider({ provider: "fixture", models: [
    { id: "alpha", name: "Alpha", reasoning: true },
    { id: "beta", name: "Beta", reasoning: true },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  let gateway;
  try {
    gateway = await openGateway(config, BACKGROUND_CONTEXT, { models });
    const conversation = await gateway.conversationFor("cli:default", BACKGROUND_CONTEXT);
    const chunks = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    await runTerminalConversation(inProcessTerminalConversation(conversation), BACKGROUND_CONTEXT, {
      input: inputLines("/model", "/model fixture beta high", "/model fixture SYNTHETIC-CREDENTIAL"),
      output,
      modelSelection: {
        list: () => gateway.listModels("cli:default", BACKGROUND_CONTEXT),
        select: (selection) => gateway.selectModel("cli:default", selection, BACKGROUND_CONTEXT),
      },
    });
    const printed = chunks.join("");
    assert.match(printed, /Allowed models/);
    assert.match(printed, /fixture beta/);
    assert.match(printed, /Model: fixture\/beta \(thinking: high\)/);
    assert.match(printed, /Model unchanged: choice unavailable/);
    assert.doesNotMatch(printed, /SYNTHETIC-CREDENTIAL/);
    assert.deepEqual((await gateway.listModels("cli:default", BACKGROUND_CONTEXT)).selected, {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
    await gateway.close(BACKGROUND_CONTEXT);
    gateway = undefined;
    gateway = await openGateway(config, BACKGROUND_CONTEXT, { models });
    assert.deepEqual((await gateway.listModels("cli:default", BACKGROUND_CONTEXT)).selected, {
      provider: "fixture", modelId: "beta", thinkingLevel: "high",
    });
  } finally {
    await gateway?.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal suppresses tool/reasoning text and strips terminal control characters", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  faux.setResponses([fauxAssistantMessage([
    { type: "thinking", thinking: "SECRET-THOUGHT" },
    { type: "toolCall", id: "synthetic", name: "SECRET-TOOL", arguments: { token: "SECRET-ARG" } },
    { type: "text", text: "visible\r\u202e text\u001b[31mred\u001b[0m" },
  ])]);
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  try {
    await runTerminalConversation(inProcessTerminalConversation(conversation), BACKGROUND_CONTEXT, { input: inputLines("synthetic prompt"), output });
    const printed = chunks.join("");
    assert.match(printed, /visible textred/);
    assert.doesNotMatch(printed, /SECRET|\r|\u202e|\u001b/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
