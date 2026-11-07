import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runTerminalConversation } from "../dist/terminal/index.js";
import { ownerDisplay } from "../dist/terminal/display.js";
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

/** One line, then an open input; the check decides when EOF happens. */
function heldInput(line) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return {
    release,
    input: (async function* () { yield line; await held; })(),
  };
}

/** Deterministic activity timer: frames advance only when the check ticks them. */
function controlledTimer() {
  const callbacks = new Map();
  const cleared = [];
  let next = 0;
  return {
    cleared,
    tick() { for (const callback of [...callbacks.values()]) callback(); },
    timer: {
      set(callback) { const handle = ++next; callbacks.set(handle, callback); return handle; },
      clear(handle) { cleared.push(handle); callbacks.delete(handle); },
    },
  };
}

test("real readline preserves wrapped Unicode editing across activity and streaming output", { timeout: timeoutMs }, () => {
  const source = new PassThrough();
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  output.columns = 12;
  const input = createInterface({ input: source, output, terminal: true });
  const display = ownerDisplay(input, output);
  try {
    display.prompt();
    source.write("next message 界🙂 that wraps");
    input.write(null, { name: "left" });
    input.write(null, { name: "left" });
    const { line, cursor } = input;
    display.status("| Waiting for the assistant...");
    display.status("/ Assistant working...");
    assert.equal(input.line, line);
    assert.equal(input.cursor, cursor);
    display.status(undefined);
    assert.equal(input.getPrompt(), "You: ");
    assert.ok(input.getCursorPos().rows > 0, "the actual input spans multiple terminal rows");
    display.write("Assistant:\ncommitted answer line one\nstreamed", output);
    assert.equal(input.line, line);
    assert.equal(input.cursor, cursor);
    assert.equal(input.getPrompt(), "streamed\nYou: ");
    source.write("X");
    assert.equal(input.line, `${line.slice(0, cursor)}X${line.slice(cursor)}`);
    // Redrawing a completed answer must start at its fresh output row, not move up into it
    // using readline's old wrapped-input row count.
    chunks.length = 0;
    display.write(" tail\n", output);
    const frame = chunks.join("");
    const afterCommittedAnswer = frame.slice(frame.indexOf("streamed tail\n") + "streamed tail\n".length);
    assert.ok(afterCommittedAnswer.startsWith("\x1b[1G\x1b[0J"));
    assert.equal(input.getPrompt(), "You: ");
    assert.equal(input.cursor, cursor + 1);
    output.columns = 8;
    output.emit("resize");
    display.status("- Waiting for the assistant...");
    assert.equal(input.cursor, cursor + 1);
    display.status(undefined);
    display.erasePrompt();
    chunks.length = 0;
    output.write("permanent answer\n");
    display.prompt();
    assert.ok(chunks.join("").startsWith("permanent answer\n\x1b[1G\x1b[0J"));
    input.close();
    display.close();
    assert.equal(source.isPaused(), true, "display cleanup must not resume closed stdin");
  } finally {
    display.close();
    input.close();
    source.destroy();
  }
});

test("activity does not rearm over streaming text, and a queued successor returns to waiting", { timeout: timeoutMs }, async () => {
  const input = new PassThrough({ objectMode: true });
  const timer = controlledTimer();
  const statuses = [];
  const submitted = [];
  let deliver;
  let ready;
  const watching = new Promise((resolve) => { ready = resolve; });
  const receipts = [];
  let receiptCount = 0;
  const firstReceipt = new Promise((resolve) => { receipts.push(resolve); });
  const secondReceipt = new Promise((resolve) => { receipts.push(resolve); });
  const conversation = {
    watch: async () => ({ start(listener) { deliver = listener; ready(); }, stop: async () => {} }),
    submit: async () => {
      let resolve;
      const settlement = new Promise((done) => { resolve = done; });
      const id = submitted.length + 1;
      submitted.push({ resolve });
      return { id, wait: () => settlement };
    },
    answer: async (id) => ({ text: id === 101 ? "partial" : "second answer" }),
  };
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (chunk.toString().includes("Reply pending")) receipts[receiptCount++]();
    callback();
  } });
  const controller = new AbortController();
  const terminal = runTerminalConversation(conversation, withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input, output, activityTimer: timer.timer,
    display: { interactive: true, prompt() {}, erasePrompt() {}, status(text) { statuses.push(text); } },
  });
  try {
    await watching;
    input.write("first");
    await firstReceipt;
    await deliver({ run: { taskId: 10, inputs: [1], generation: { attempt: 0, text: "partial" } }, answers: [] });
    const afterPartial = statuses.length;
    input.write("second");
    await secondReceipt;
    await new Promise((resolve) => setImmediate(resolve));
    timer.tick();
    assert.equal(statuses.slice(afterPartial).filter((text) => typeof text === "string").length, 0);
    await deliver({ answers: [] });
    submitted[0].resolve({ status: "done", type: "input", answer: 101 });
    await new Promise((resolve) => setImmediate(resolve));
    timer.tick();
    assert.match(statuses.filter((text) => typeof text === "string").at(-1), /Waiting for the assistant/);
    await deliver({ run: { taskId: 20, inputs: [2] }, answers: [] });
    timer.tick();
    assert.match(statuses.filter((text) => typeof text === "string").at(-1), /Assistant working/);
    submitted[1].resolve({ status: "done", type: "input", answer: 102 });
    input.end();
    await terminal;
    const frames = statuses.length;
    timer.tick();
    assert.equal(statuses.length, frames, "no timer remains after attachment shutdown");
  } finally {
    submitted.forEach(({ resolve }) => resolve({ status: "unanswered", type: "input", reason: "aborted" }));
    controller.abort();
    input.end();
    await Promise.allSettled([terminal]);
    input.destroy();
  }
});

test("a plain TTY prompt remains available without interactive display features", { timeout: timeoutMs }, async () => {
  let prompts = 0;
  await runTerminalConversation({ watch: async () => ({ start() {}, stop: async () => {} }) }, BACKGROUND_CONTEXT, {
    input: inputLines(""), output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    prompt() { prompts++; },
  });
  assert.equal(prompts, 2);
});

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

test("interactive receipts follow durable admission and precede the reply", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  faux.setResponses([fauxAssistantMessage("synthetic admitted answer")]);
  let releaseAdmission;
  let markEntered;
  const gate = new Promise((resolve) => { releaseAdmission = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const proxy = new Proxy(conversation, { get(target, property) {
    if (property === "submit") return async (...args) => {
      markEntered();
      await gate;
      return target.submit(...args);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const chunks = [];
  const statuses = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const controller = new AbortController();
  const terminal = runTerminalConversation(inProcessTerminalConversation(proxy), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input: inputLines("synthetic prompt"),
    output,
    display: {
      interactive: true,
      prompt() {},
      erasePrompt() {},
      status(text) { statuses.push(text); },
    },
  });
  try {
    await entered;
    const waiting = chunks.join("");
    assert.match(waiting, /Earlier replies are not replayed; \/history prints them/);
    assert.match(waiting, /Closing this terminal does not cancel admitted work/);
    assert.doesNotMatch(waiting, /Reply pending/, "a receipt must not precede durable admission");
    releaseAdmission();
    await terminal;
    const printed = chunks.join("");
    assert.match(printed, /Reply pending; it may be queued behind a running turn/);
    assert.ok(printed.indexOf("Reply pending") < printed.indexOf("synthetic admitted answer"));
  } finally {
    releaseAdmission?.();
    controller.abort();
    await Promise.allSettled([terminal]);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("interactive attachment receipt also follows durable admission", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  faux.setResponses([fauxAssistantMessage("synthetic attachment answer")]);
  let releaseAdmission;
  let markEntered;
  const gate = new Promise((resolve) => { releaseAdmission = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const controller = new AbortController();
  const terminal = runTerminalConversation(inProcessTerminalConversation(conversation), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input: inputLines("/attach synthetic.txt -- describe"),
    output,
    display: {
      interactive: true,
      prompt() {},
      erasePrompt() {},
      status() {},
    },
    attachments: { submit: async (path, prompt, context) => {
      markEntered();
      await gate;
      const submission = await conversation.submit({ type: "input", content: `stored ${path} ${prompt}` }, context);
      return { submission, attachment: { relativePath: "media/cli/document-synthetic.txt", bytes: 12 } };
    } },
  });
  try {
    await entered;
    assert.doesNotMatch(chunks.join(""), /Stored attachment|Reply pending/);
    releaseAdmission();
    await terminal;
    const printed = chunks.join("");
    assert.match(printed, /Stored attachment at media\/cli\/document-synthetic\.txt \(12 bytes\) and admitted its turn/);
    assert.match(printed, /Reply pending/);
    assert.ok(printed.indexOf("Stored attachment") < printed.indexOf("Reply pending"));
    assert.ok(printed.indexOf("Reply pending") < printed.indexOf("synthetic attachment answer"));
  } finally {
    releaseAdmission?.();
    controller.abort();
    await Promise.allSettled([terminal]);
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("activity line reports waiting then work, and stops before committed answer text", { timeout: timeoutMs + 2_000 }, async () => {
  const { harness, conversation, faux } = await makeHarness(new MemoryStorage());
  let releaseGeneration;
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve; });
  faux.setResponses([async () => {
    await generationGate;
    return fauxAssistantMessage("synthetic spinner answer");
  }]);
  const statuses = [];
  let promptCalls = 0;
  let eraseCalls = 0;
  const timer = controlledTimer();
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const controller = new AbortController();
  const held = heldInput("synthetic prompt");
  // Hold committed snapshots so the waiting label is observed before any run; deliver them together.
  const buffered = [];
  let deliver;
  const snapshots = new Proxy(conversation, { get(target, property) {
    if (property === "watch") return async (...args) => {
      const watch = await target.watch(...args);
      return {
        start(listener) { deliver = listener; watch.start((call) => { buffered.push(call); }); },
        stop: () => watch.stop(),
      };
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const terminal = runTerminalConversation(inProcessTerminalConversation(snapshots), withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
    input: held.input,
    output,
    display: {
      interactive: true,
      prompt() { promptCalls++; },
      erasePrompt() { eraseCalls++; },
      status(text) { statuses.push(text); },
    },
    activityTimer: timer.timer,
  });
  const frames = () => statuses.filter((text) => typeof text === "string");
  try {
    // The activity line starts only after durable admission and beside a drawn prompt.
    await eventually(async () => frames().length > 0, "activity line did not start after admission");
    assert.ok(promptCalls > 0);
    assert.match(frames()[0], /^\| Waiting for the assistant\.\.\.$/);
    const beforeTick = statuses.length;
    timer.tick();
    assert.ok(statuses.length > beforeTick, "one timer tick renders one frame");
    assert.match(frames().at(-1), /^\/ Waiting for the assistant\.\.\.$/);
    // An observed run containing the admitted input switches the same line to work, before any text.
    await eventually(async () => {
      const pending = buffered.splice(0);
      for (const call of pending) await deliver(call);
      timer.tick();
      return frames().at(-1)?.includes("Assistant working...") === true;
    }, "activity line never reported the observed run");
    assert.doesNotMatch(chunks.join(""), /Assistant:/);
    releaseGeneration();
    await eventually(async () => chunks.join("").includes("synthetic spinner answer"), "committed answer did not arrive");
    held.release();
    await terminal;
    const printed = chunks.join("");
    assert.equal(printed.split("Assistant:").length - 1, 1, "one answer header");
    assert.ok(printed.indexOf("Assistant:") < printed.indexOf("synthetic spinner answer"));
    assert.ok(eraseCalls > 0, "the prompt line is cleared before answer text");
    assert.equal(timer.cleared.length, 1, "the activity interval is released once");
    assert.equal(statuses.at(-1), undefined, "the activity line is cleared before the prompt returns");
  } finally {
    releaseGeneration?.();
    held.release();
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
