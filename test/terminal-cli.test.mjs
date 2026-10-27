import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";

import { runTerminalConversation } from "../dist/terminal/index.js";
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
  const terminal = runTerminalConversation(conversation, withAbortSignal(controller.signal, BACKGROUND_CONTEXT), {
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
    await runTerminalConversation(conversation, BACKGROUND_CONTEXT, {
      input: inputLines("first synthetic prompt", "queued synthetic prompt"), output,
    });
    assert.match(outputChunks.join(""), /preserving 1 Durable-queued CLI input/);
    await harness.close(BACKGROUND_CONTEXT);
    harness = undefined;
    await storage.close(BACKGROUND_CONTEXT);
    storage = undefined;

    storage = await openFullSyncNodeSqliteStorage(database, BACKGROUND_CONTEXT);
    const reopened = await makeHarness(storage);
    harness = reopened.harness;
    const state = await reopened.conversation.viewState(BACKGROUND_CONTEXT);
    try {
      const inbox = state.value.docs["pi.inbox"];
      assert.equal(inbox.items.length, 1);
      assert.match(JSON.stringify(inbox.items), /queued synthetic prompt/);
    } finally { state.dispose(); }
  } finally {
    await harness?.close(BACKGROUND_CONTEXT);
    await storage?.close(BACKGROUND_CONTEXT);
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
    await runTerminalConversation(conversation, BACKGROUND_CONTEXT, { input: inputLines("synthetic prompt"), output });
    const printed = chunks.join("");
    assert.match(printed, /visible textred/);
    assert.doesNotMatch(printed, /SECRET|\r|\u202e|\u001b/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
