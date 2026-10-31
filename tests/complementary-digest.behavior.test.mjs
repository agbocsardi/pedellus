import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const load = (path) => import(pathToFileURL(path).href);

const { Harness, createRegistry } = await load(`${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`);
const { openFullSyncNodeSqliteStorage } = await load(`${pkg}/dist/storage/sqlite.js`);
const {
  createComplementarySource,
  ComplementaryCursorConflictError,
  COMPLEMENTARY_PREVIEW_CHARS,
} = await load(`${pkg}/dist/history/complementary.js`);
const { DigestCursorDoc } = await load(`${pkg}/dist/history/digestion.js`);
const { createModels, fauxAssistantMessage, fauxThinking, fauxToolCall } = await load(`${ai}/index.js`);
const { BACKGROUND_CONTEXT } = await load(`${chord}/context/index.js`);
const context = BACKGROUND_CONTEXT;

const temp = (prefix) => mkdtemp(resolve(tmpdir(), prefix));

async function openStore(dbPath) {
  const storage = await openFullSyncNodeSqliteStorage(dbPath, context);
  return Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
}

function user(text) {
  return { kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1_000 }] };
}
function userImageOnly() {
  return {
    kind: "pi.user",
    model: [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1_000 }],
  };
}
function assistant(text, options = {}) {
  return { kind: "pi.assistant", model: [fauxAssistantMessage(text, options)] };
}
function thinkingOnly() {
  return { kind: "pi.assistant", model: [fauxAssistantMessage([fauxThinking("THINKING-ONLY-7712")])] };
}
function toolCallAssistant(text, id, name, args) {
  return {
    kind: "pi.assistant",
    model: [fauxAssistantMessage([
      { type: "text", text },
      fauxToolCall(name, args, { id }),
    ], { stopReason: "toolUse" })],
  };
}
function toolResult(text, id, name = "read") {
  return {
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1_000,
    }],
  };
}
function reset(handoff) {
  return handoff === undefined
    ? { kind: "pi.reset", head: "self" }
    : { kind: "pi.reset", head: "self", model: [{ role: "user", content: handoff, timestamp: 1_000 }] };
}
function system(text) {
  return { kind: "pi.system", model: [{ role: "system", content: text, timestamp: 1_000 }] };
}
function compaction(text) {
  return {
    kind: "pi.compaction",
    model: [{ role: "user", content: text, timestamp: 1_000 }],
    data: { reason: "manual" },
  };
}

async function append(harness, conversation, ...drafts) {
  return harness.commit(async (tx) => {
    const appended = [];
    for (const draft of drafts) appended.push(await tx.appendEntry(conversation.id, draft));
    return appended;
  }, context);
}

function batched(result) {
  assert.equal(result.status, "batch", "expected a complementary batch");
  return result;
}

function idle(result) {
  assert.equal(result.status, "idle", "expected a complementary idle report");
  return result;
}

function sourceFor(harness, conversation, limits) {
  return createComplementarySource({
    harness,
    ...(limits === undefined ? {} : { limits }),
    sessions: async () => [{ sessionKey: "cli:complementary", conversationId: conversation.id }],
  });
}

function sourcesFor(harness, chats, limits) {
  return createComplementarySource({
    harness,
    ...(limits === undefined ? {} : { limits }),
    sessions: async () => chats.map(({ key, conversation }) => ({
      sessionKey: key,
      conversationId: conversation.id,
    })),
  });
}

async function drain(source, limit = 200) {
  const batches = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await source.read(context);
    if (result.status === "idle") return { batches, idle: result };
    const batch = batched(result);
    batches.push(batch);
    await source.acknowledge(batch, context);
  }
  throw new Error(`complementary digest did not settle after ${limit} batches`);
}

/** Concatenated lossless fragments of one evidence item, by start offset. */
function itemText(batches, entryId, itemIndex) {
  const fragments = batches
    .flatMap((batch) => batch.entries)
    .filter((entry) => entry.entryId === entryId && entry.itemIndex === itemIndex)
    .sort((left, right) => left.textStart - right.textStart);
  assert.ok(fragments.length > 0, "expected fragments for the item");
  for (let index = 1; index < fragments.length; index += 1) {
    assert.equal(
      fragments[index].textStart,
      fragments[index - 1].textStart + fragments[index - 1].text.length,
      "fragments are contiguous",
    );
  }
  return fragments.map((entry) => entry.text).join("");
}

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("complementary digest advances only through completed turns in an open chat", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-open-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [q1] = await append(harness, conversation, user("FIRST-QUESTION-5501"));
    const [a1] = await append(harness, conversation, assistant("FIRST-ANSWER-1182"));
    const [q2] = await append(harness, conversation, user("SECOND-QUESTION-7734"));
    const [a2] = await append(harness, conversation, assistant("SECOND-ANSWER-2298"));
    const [open] = await append(harness, conversation, user("STILL-OPEN-6610"));

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    assert.equal(first.segmentStartEntryId, q1.id);
    assert.equal(first.segmentEndEntryId, a1.id);
    assert.equal(first.highWaterEntryId, a1.id);
    assert.equal(first.complete, true);
    assert.deepEqual(first.entries.map((entry) => [entry.entryId, entry.trustLabel, entry.text]), [
      [q1.id, "owner message", "FIRST-QUESTION-5501"],
      [a1.id, "assistant reply", "FIRST-ANSWER-1182"],
    ]);

    // Reading again before acknowledgement is stable and moves nothing.
    assert.deepEqual(await source.read(context), first);
    await source.acknowledge(first, context);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: q2.id,
      nextItemIndex: 0,
      nextTextStart: 0,
      segmentStartEntryId: null,
      segmentEndEntryId: null,
      pendingToolCalls: [],
    });

    const second = batched(await source.read(context));
    assert.equal(second.segmentStartEntryId, q2.id);
    assert.equal(second.segmentEndEntryId, a2.id);
    assert.deepEqual(second.entries.map((entry) => entry.text), ["SECOND-QUESTION-7734", "SECOND-ANSWER-2298"]);
    await source.acknowledge(second, context);

    // The last owner message has no answer yet: it is not evidence and the high-water stays put.
    const waiting = idle(await source.read(context));
    assert.equal(waiting.caughtUp, true);
    assert.equal(waiting.openChats, 1);
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, open.id);
    assert.deepEqual(await source.read(context), waiting);

    const [answer] = await append(harness, conversation, assistant("OPEN-ANSWER-8843"));
    const third = batched(await source.read(context));
    assert.equal(third.segmentStartEntryId, open.id);
    assert.equal(third.segmentEndEntryId, answer.id);
    assert.deepEqual(third.entries.map((entry) => entry.text), ["STILL-OPEN-6610", "OPEN-ANSWER-8843"]);
    await source.acknowledge(third, context);
    assert.equal(idle(await source.read(context)).openChats, 0);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open tool round is held back until its result is paired and the turn is terminal", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-tool-round-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [owner] = await append(harness, conversation, user("INSPECT-THE-FILE-9921"));
    const [call] = await append(harness, conversation, toolCallAssistant("READING-7612", "call-open", "read", { path: "a.txt" }));
    const [result] = await append(harness, conversation, toolResult("FILE-CONTENTS-3348", "call-open"));

    const source = sourceFor(harness, conversation);
    const waiting = idle(await source.read(context));
    assert.equal(waiting.caughtUp, true);
    assert.equal(waiting.openChats, 1);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      segmentStartEntryId: null,
      segmentEndEntryId: null,
      pendingToolCalls: [],
    });

    const [answer] = await append(harness, conversation, assistant("INSPECTION-DONE-6675"));
    const batch = batched(await source.read(context));
    assert.equal(batch.segmentStartEntryId, owner.id);
    assert.equal(batch.segmentEndEntryId, answer.id);
    assert.deepEqual(batch.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]), [
      [owner.id, "message", "INSPECT-THE-FILE-9921"],
      [call.id, "message", "READING-7612"],
      [call.id, "tool-call", JSON.stringify({ path: "a.txt" })],
      [result.id, "tool-result", "FILE-CONTENTS-3348"],
      [answer.id, "message", "INSPECTION-DONE-6675"],
    ]);
    const shortResult = batch.entries.find((entry) => entry.itemKind === "tool-result");
    assert.ok(shortResult !== undefined);
    assert.equal(shortResult.preview, null, "a short tool result is included whole");
    assert.equal(shortResult.chars, "FILE-CONTENTS-3348".length);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool calls and paired results are untrusted and long results use head-tail previews", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-preview-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const head = "RESULT-HEAD-4410";
    const tail = "-RESULT-TAIL-7785";
    const longResult = `${head}${"z".repeat(4_000)}${tail}`;
    const [owner] = await append(harness, conversation, user("READ-THE-LOG-3352"));
    const [call] = await append(harness, conversation, toolCallAssistant("READING-1197", "call-preview", "read", {
      path: "log.txt",
      offset: 12,
    }));
    const [result] = await append(harness, conversation, toolResult(longResult, "call-preview"));
    const [orphan] = await append(harness, conversation, toolResult("ORPHAN-RESULT-5561", "missing-call"));
    const [answer] = await append(harness, conversation, assistant("LOG-SUMMARY-2280"));

    const source = sourceFor(harness, conversation);
    const batch = batched(await source.read(context));
    assert.equal(batch.complete, true);
    const texts = batch.entries.map((entry) => entry.text);
    assert.ok(texts.includes("READ-THE-LOG-3352"));
    assert.ok(texts.includes("READING-1197"));
    assert.ok(texts.includes("LOG-SUMMARY-2280"));
    assert.ok(!texts.includes("ORPHAN-RESULT-5561"), "an unpaired result is not evidence");
    assert.ok(!batch.entries.some((entry) => entry.entryId === orphan.id));

    const callEvidence = batch.entries.find((entry) => entry.itemKind === "tool-call");
    assert.ok(callEvidence !== undefined);
    assert.equal(callEvidence.trust, "untrusted-tool");
    assert.equal(callEvidence.trustLabel, "untrusted tool call arguments");
    assert.equal(callEvidence.toolCallId, "call-preview");
    assert.equal(callEvidence.toolName, "read");
    assert.equal(callEvidence.ref, `entry:${call.id}/tool-call/call-preview`);
    assert.deepEqual(JSON.parse(callEvidence.text), { path: "log.txt", offset: 12 });

    const resultEvidence = batch.entries.find((entry) => entry.itemKind === "tool-result");
    assert.ok(resultEvidence !== undefined);
    assert.equal(resultEvidence.trust, "untrusted-tool");
    assert.equal(resultEvidence.trustLabel, "untrusted tool result");
    assert.equal(resultEvidence.toolCallId, "call-preview");
    assert.equal(resultEvidence.ref, `entry:${result.id}/tool-result/call-preview`);
    assert.equal(resultEvidence.chars, longResult.length);
    assert.ok(resultEvidence.text.length <= COMPLEMENTARY_PREVIEW_CHARS);
    assert.ok(resultEvidence.text.startsWith(head));
    assert.ok(resultEvidence.text.endsWith(tail));
    assert.ok(resultEvidence.text.includes(`original at ${resultEvidence.ref}`));
    assert.ok(resultEvidence.text.includes("characters omitted"));
    assert.ok(resultEvidence.preview !== null);
    assert.equal(
      resultEvidence.preview.headChars + resultEvidence.preview.tailChars + resultEvidence.preview.omittedChars,
      longResult.length,
    );
    assert.equal(resultEvidence.preview.omittedStart, resultEvidence.preview.headChars);
    assert.equal(resultEvidence.preview.omittedEnd, longResult.length - resultEvidence.preview.tailChars);
    assert.equal(resultEvidence.text.slice(0, resultEvidence.preview.headChars).length, resultEvidence.preview.headChars);
    assert.equal(resultEvidence.text.slice(-resultEvidence.preview.tailChars).length, resultEvidence.preview.tailChars);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("reset handoffs, system and compaction entries, thinking and unpaired output are excluded", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-excluded-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, system("SYSTEM-NOT-EVIDENCE-8820"));
    await append(harness, conversation, reset("HANDOFF-NOT-EVIDENCE-4417"));
    const [owner] = await append(harness, conversation, user("OWNER-VISIBLE-9931"));
    await append(harness, conversation, compaction("COMPACTION-NOT-EVIDENCE-5528"));
    await append(harness, conversation, toolResult("UNPAIRED-NOT-EVIDENCE-2277", "not-a-call"));
    const [answer] = await append(harness, conversation, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([
        fauxThinking("THINKING-NOT-EVIDENCE-6652"),
        { type: "text", text: "ASSISTANT-VISIBLE-1108" },
      ])],
    });

    const source = sourceFor(harness, conversation);
    const batch = batched(await source.read(context));
    assert.deepEqual(batch.entries.map((entry) => [entry.entryId, entry.text]), [
      [owner.id, "OWNER-VISIBLE-9931"],
      [answer.id, "ASSISTANT-VISIBLE-1108"],
    ]);
    const allText = batch.entries.map((entry) => entry.text).join("\n");
    for (const excluded of [
      "SYSTEM-NOT-EVIDENCE-8820",
      "HANDOFF-NOT-EVIDENCE-4417",
      "COMPACTION-NOT-EVIDENCE-5528",
      "UNPAIRED-NOT-EVIDENCE-2277",
      "THINKING-NOT-EVIDENCE-6652",
    ]) {
      assert.ok(!allText.includes(excluded), `excluded text must not be evidence: ${excluded}`);
    }
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("large prose and tool-call arguments fragment losslessly at Unicode-safe boundaries", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-unicode-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const emoji = "😀🚀🧠";
    const prose = `START-${emoji.repeat(40)}-END-${"a".repeat(35)}`;
    const args = { path: "unicode.txt", query: emoji.repeat(30), note: "n".repeat(25) };
    const [owner] = await append(harness, conversation, user(prose));
    const [call] = await append(harness, conversation, toolCallAssistant("CALLING-5540", "call-unicode", "read", args));
    await append(harness, conversation, toolResult("OK-1129", "call-unicode"));
    await append(harness, conversation, assistant("DONE-8864"));

    const source = sourceFor(harness, conversation, { entriesPerBatch: 2, charsPerBatch: 32 });
    const { batches } = await drain(source);
    assert.ok(batches.length > 1, "the small bound forces several chunks");

    const ownerText = itemText(batches, owner.id, 0);
    assert.equal(ownerText, prose);
    assert.equal(hasLoneSurrogate(ownerText), false);
    assert.equal(Buffer.from(ownerText, "utf8").toString("utf8"), ownerText);

    const argumentText = itemText(batches, call.id, 1);
    assert.equal(argumentText, JSON.stringify(args));
    assert.deepEqual(JSON.parse(argumentText), args);
    assert.equal(hasLoneSurrogate(argumentText), false);
    assert.equal(Buffer.from(argumentText, "utf8").toString("utf8"), argumentText);

    for (const batch of batches) {
      for (const entry of batch.entries) {
        assert.equal(hasLoneSurrogate(entry.text), false, "no fragment splits a surrogate pair");
      }
    }
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable pairing survives a chunk boundary and a fresh source instance", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-pairing-restart-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("PAIRING-QUESTION-9910"));
    await append(harness, conversation, toolCallAssistant(
      "PAIRING-READING-3358",
      "call-durable",
      "read",
      { path: "long.txt", query: "q".repeat(180) },
    ));
    await append(harness, conversation, toolResult("PAIRED-AFTER-RESTART-7726", "call-durable"));
    await append(harness, conversation, assistant("PAIRING-ANSWER-4409"));

    const limits = { entriesPerBatch: 2, charsPerBatch: 32 };
    let source = sourceFor(harness, conversation, limits);
    const evidence = [];
    let sawPending = false;
    for (let index = 0; index < 80; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      const batch = batched(result);
      evidence.push(...batch.entries);
      await source.acknowledge(batch, context);
      const cursor = await source.cursor(conversation.id, context);
      if (cursor.pendingToolCalls.includes("call-durable")) {
        sawPending = true;
        // A fresh reader has no in-process state; only the durable cursor carries the open call.
        source = sourceFor(harness, conversation, limits);
      }
      if (batch.complete) break;
    }
    assert.equal(sawPending, true, "the call stayed open across a chunk boundary");
    const resultEvidence = evidence.find((entry) => entry.itemKind === "tool-result");
    assert.ok(resultEvidence !== undefined, "a result in a later chunk is still paired");
    assert.equal(resultEvidence.toolCallId, "call-durable");
    assert.equal(resultEvidence.trust, "untrusted-tool");
    assert.equal(resultEvidence.text, "PAIRED-AFTER-RESTART-7726");
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay re-derives the same chunk, and a forged or repeated acknowledgement moves nothing", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-replay-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("REPLAY-QUESTION-3341"));
    await append(harness, conversation, toolCallAssistant("REPLAY-READING-7720", "call-replay", "read", { path: "r.txt" }));
    await append(harness, conversation, toolResult(`${"r".repeat(3_000)}REPLAY-TAIL-9913`, "call-replay"));
    await append(harness, conversation, assistant("REPLAY-ANSWER-5584"));

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    assert.deepEqual(await source.read(context), first, "an unacknowledged read is stable");
    const replay = await source.readBatch(first, context);
    assert.deepEqual(replay.entries, first.entries);
    assert.equal(replay.throughEntryId, first.throughEntryId);
    assert.equal(first.entries.length > 0, true);

    const forged = {
      ...first,
      entries: first.entries.map((entry, index) => (index === 0 ? { ...entry, text: "X".repeat(entry.text.length) } : entry)),
    };
    await assert.rejects(
      source.acknowledge(forged, context),
      (error) => error instanceof TypeError && /does not match the committed transcript/.test(error.message),
    );
    assert.deepEqual(await source.cursor(conversation.id, context), first.cursor, "a forged batch moves nothing");

    const next = await source.acknowledge(first, context);
    assert.equal(next.nextEntryId > first.segmentEndEntryId, true);
    assert.deepEqual(await source.cursor(conversation.id, context), next);

    await assert.rejects(
      source.acknowledge(first, context),
      (error) => error instanceof ComplementaryCursorConflictError || error instanceof TypeError,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), next, "a repeated acknowledgement moves nothing");

    const after = await source.readBatch(first, context);
    assert.deepEqual(after.entries, first.entries, "a replay after acknowledgement still re-derives the same evidence");
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a completed no-evidence turn is one empty batch, so no model is needed", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-empty-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [owner] = await append(harness, conversation, userImageOnly());
    const [answer] = await append(harness, conversation, thinkingOnly());

    const source = sourceFor(harness, conversation);
    const batch = batched(await source.read(context));
    assert.equal(batch.segmentStartEntryId, owner.id);
    assert.equal(batch.segmentEndEntryId, answer.id);
    assert.equal(batch.complete, true);
    assert.deepEqual(batch.entries, []);
    const next = await source.acknowledge(batch, context);
    assert.equal(next.nextEntryId, answer.id + 1);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the complementary source accepts only validated mapped chat sessions", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-scope-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("SCOPED-7733"), assistant("SCOPED-ANSWER-1142"));

    const channelState = createComplementarySource({
      harness,
      sessions: async () => [{ sessionKey: "telegram:x:channel-state", conversationId: conversation.id }],
    });
    await assert.rejects(
      channelState.read(context),
      (error) => error instanceof TypeError && /channel-state/.test(error.message),
    );

    const duplicate = createComplementarySource({
      harness,
      sessions: async () => [
        { sessionKey: "cli:one", conversationId: conversation.id },
        { sessionKey: "cli:two", conversationId: conversation.id },
      ],
    });
    await assert.rejects(
      duplicate.read(context),
      (error) => error instanceof TypeError && /at most once/.test(error.message),
    );

    const emptyKey = createComplementarySource({
      harness,
      sessions: async () => [{ sessionKey: "", conversationId: conversation.id }],
    });
    await assert.rejects(
      emptyKey.read(context),
      (error) => error instanceof TypeError && /non-empty/.test(error.message),
    );
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh segment starts at its own start when two chats interleave entry IDs", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-interleaved-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const a = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const b = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, a, user("A-FIRST-QUESTION-6610"));
    await append(harness, b, user("B-FIRST-QUESTION-7721"));
    const [a2] = await append(harness, a, assistant("A-FIRST-ANSWER-3382"));
    await append(harness, b, assistant("B-FIRST-ANSWER-4493"));

    const source = sourcesFor(harness, [
      { key: "cli:a", conversation: a },
      { key: "cli:b", conversation: b },
    ]);
    const first = batched(await source.read(context));
    assert.equal(first.sessionKey, "cli:a");
    assert.deepEqual(first.entries.map((entry) => entry.text), ["A-FIRST-QUESTION-6610", "A-FIRST-ANSWER-3382"]);

    // With no cursor yet, a claimed start beyond an unconsumed entry is still refused.
    const skippedPrefix = {
      ...first,
      segmentStartEntryId: a2.id,
      firstEntryId: a2.id,
      entries: first.entries.filter((entry) => entry.entryId >= a2.id),
    };
    await assert.rejects(
      source.acknowledge(skippedPrefix, context),
      (error) => error instanceof TypeError && /skip an earlier entry/.test(error.message),
    );
    await source.acknowledge(first, context);
    const second = batched(await source.read(context));
    assert.equal(second.sessionKey, "cli:b");
    await source.acknowledge(second, context);

    const [a3] = await append(harness, a, user("A-SECOND-QUESTION-8844"));
    await append(harness, a, assistant("A-SECOND-ANSWER-9955"));
    const frontier = await source.cursor(a.id, context);
    assert.ok(frontier.nextEntryId !== null && frontier.nextEntryId < a3.id, "the chat frontier is below its next entry ID");

    const third = batched(await source.read(context));
    assert.equal(third.sessionKey, "cli:a");
    assert.equal(third.segmentStartEntryId, a3.id);
    assert.equal(third.firstEntryId, a3.id, "a fresh chunk starts at its own segment start");
    assert.equal(third.firstItemIndex, 0);
    assert.equal(third.firstTextStart, 0);
    assert.deepEqual(third.entries.map((entry) => entry.text), ["A-SECOND-QUESTION-8844", "A-SECOND-ANSWER-9955"]);
    await source.acknowledge(third, context);

    const [a5] = await append(harness, a, user("UNACKNOWLEDGED-QUESTION-1166"));
    const [a6] = await append(harness, a, assistant("UNACKNOWLEDGED-ANSWER-2277"));
    const valid = batched(await source.read(context));
    assert.equal(valid.segmentStartEntryId, a5.id);

    // A forged fresh start beyond an unconsumed entry must not be able to skip it.
    const forged = {
      ...valid,
      segmentStartEntryId: a6.id,
      firstEntryId: a6.id,
      entries: valid.entries.filter((entry) => entry.entryId >= a6.id),
    };
    await assert.rejects(
      source.acknowledge(forged, context),
      (error) => error instanceof TypeError && /skip an earlier entry/.test(error.message),
    );
    assert.deepEqual(await source.cursor(a.id, context), valid.cursor, "a rejected skip moves nothing");

    await source.acknowledge(valid, context);
    assert.deepEqual(valid.entries.map((entry) => entry.text), ["UNACKNOWLEDGED-QUESTION-1166", "UNACKNOWLEDGED-ANSWER-2277"]);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an astral tool-result preview keeps whole surrogate pairs at odd budgets", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-astral-preview-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const emoji = "😀🚀";
    const longResult = `${emoji.repeat(1_500)}-TAIL-${emoji.repeat(20)}`;
    for (const charsPerBatch of [99, 100, 101, 102, 103, 105, 107]) {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      await append(harness, conversation, user("PREVIEW-OWNER-3311"));
      await append(harness, conversation, toolCallAssistant("PREVIEW-READING-4422", "call-astral", "read", { path: "e.txt" }));
      const [result] = await append(harness, conversation, toolResult(longResult, "call-astral"));
      await append(harness, conversation, assistant("PREVIEW-DONE-5533"));

      const source = sourceFor(harness, conversation, { entriesPerBatch: 2, charsPerBatch });
      const { batches } = await drain(source, 400);
      const previews = batches
        .flatMap((batch) => batch.entries)
        .filter((entry) => entry.entryId === result.id && entry.itemKind === "tool-result");
      assert.equal(previews.length, 1, `one preview for budget ${charsPerBatch}`);
      const evidence = previews[0];
      assert.ok(evidence.preview !== null, `preview at budget ${charsPerBatch}`);
      assert.ok(evidence.text.length <= charsPerBatch, `preview fits budget ${charsPerBatch}`);
      assert.equal(hasLoneSurrogate(evidence.text), false, `no split pair at budget ${charsPerBatch}`);
      assert.equal(Buffer.from(evidence.text, "utf8").toString("utf8"), evidence.text);

      const preview = evidence.preview;
      assert.equal(preview.headChars, evidence.text.slice(0, preview.headChars).length);
      assert.equal(preview.omittedStart, preview.headChars);
      assert.equal(preview.tailChars, evidence.text.length - preview.headChars - preview.marker.length);
      assert.equal(preview.omittedEnd, evidence.chars - preview.tailChars);
      assert.equal(preview.headChars + preview.tailChars + preview.omittedChars, evidence.chars);
    }
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the complementary cursor adopts an existing digest frontier without moving it", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-complementary-adopt-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("OLD-DIGEST-QUESTION-6611"));
    const [oldAnswer] = await append(harness, conversation, assistant("OLD-DIGEST-ANSWER-7722"));
    const [newQuestion] = await append(harness, conversation, user("NEW-TURN-QUESTION-8833"));
    const [newAnswer] = await append(harness, conversation, assistant("NEW-TURN-ANSWER-9944"));
    await harness.commit(async (tx) => {
      const document = await tx.doc(DigestCursorDoc, conversation.id);
      document.throughEntryId = oldAnswer.id;
      document.throughChars = "OLD-DIGEST-ANSWER-7722".length;
      document.episodeStartEntryId = null;
      document.episodeEndEntryId = null;
    }, context);
    const legacyBefore = await harness.snapshot(DigestCursorDoc, conversation.id, context);
    assert.ok(legacyBefore !== undefined);

    let source = sourceFor(harness, conversation);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: oldAnswer.id + 1,
      nextItemIndex: 0,
      nextTextStart: 0,
      segmentStartEntryId: null,
      segmentEndEntryId: null,
      pendingToolCalls: [],
    });
    const batch = batched(await source.read(context));
    assert.equal(batch.segmentStartEntryId, newQuestion.id);
    assert.equal(batch.firstEntryId, newQuestion.id);
    assert.deepEqual(batch.entries.map((entry) => entry.text), ["NEW-TURN-QUESTION-8833", "NEW-TURN-ANSWER-9944"]);
    assert.deepEqual(await source.read(context), batch, "adoption is stable before acknowledgement");
    await source.acknowledge(batch, context);
    assert.deepEqual(await harness.snapshot(DigestCursorDoc, conversation.id, context), legacyBefore,
      "the closed-episode cursor is untouched");

    // A later closed-episode move must not pull the complementary frontier forward.
    const [laterQuestion] = await append(harness, conversation, user("LATER-TURN-QUESTION-1155"));
    await append(harness, conversation, assistant("LATER-TURN-ANSWER-2266"));
    await harness.commit(async (tx) => {
      const document = await tx.doc(DigestCursorDoc, conversation.id);
      document.throughEntryId = laterQuestion.id + 1;
      document.throughChars = 1;
    }, context);
    const frozen = await source.cursor(conversation.id, context);
    assert.equal(frozen.nextEntryId, newAnswer.id + 1, "the complementary cursor is independent after adoption");

    await harness.close(context);
    harness = await openStore(db);
    source = sourceFor(harness, conversation);
    assert.deepEqual(await source.cursor(conversation.id, context), frozen, "the adopted cursor survives a reopen");
    const reopened = batched(await source.read(context));
    assert.equal(reopened.segmentStartEntryId, laterQuestion.id);
    assert.deepEqual(reopened.entries.map((entry) => entry.text), ["LATER-TURN-QUESTION-1155", "LATER-TURN-ANSWER-2266"]);
    await source.acknowledge(reopened, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adopting a partially consumed closed episode replays it from its start", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-adopt-partial-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [question] = await append(harness, conversation, user("PARTIAL-QUESTION-7733"));
    const [answer] = await append(harness, conversation, assistant("PARTIAL-ANSWER-8844"));
    await append(harness, conversation, reset("PARTIAL-HANDOFF-NOT-EVIDENCE-9955"));
    await harness.commit(async (tx) => {
      const document = await tx.doc(DigestCursorDoc, conversation.id);
      document.throughEntryId = question.id;
      document.throughChars = 4;
      document.episodeStartEntryId = question.id;
      document.episodeEndEntryId = answer.id;
    }, context);

    const source = sourceFor(harness, conversation);
    const cursor = await source.cursor(conversation.id, context);
    assert.equal(cursor.nextEntryId, question.id, "a partial episode restarts at its immutable start");
    const batch = batched(await source.read(context));
    assert.equal(batch.segmentStartEntryId, question.id);
    assert.equal(batch.segmentEndEntryId, answer.id);
    assert.deepEqual(batch.entries.map((entry) => entry.text), ["PARTIAL-QUESTION-7733", "PARTIAL-ANSWER-8844"]);
    await source.acknowledge(batch, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted or errored assistant entry is not a completed answer", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-complementary-abort-error-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const errored = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, errored, user("ERROR-QUESTION-1166"));
    await append(harness, errored, assistant("ERROR-PARTIAL-2277", { stopReason: "error" }));
    const aborted = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, aborted, user("ABORT-QUESTION-3388"));
    await append(harness, aborted, assistant("ABORT-PARTIAL-4499", { stopReason: "aborted" }));

    const source = sourcesFor(harness, [
      { key: "cli:error", conversation: errored },
      { key: "cli:abort", conversation: aborted },
    ]);
    const waiting = idle(await source.read(context));
    assert.equal(waiting.caughtUp, true);
    assert.equal(waiting.openChats, 2, "neither failed entry closes its turn");
    assert.deepEqual(await source.cursor(errored.id, context), {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      segmentStartEntryId: null,
      segmentEndEntryId: null,
      pendingToolCalls: [],
    });

    const [answer] = await append(harness, errored, assistant("ERROR-RECOVERED-5500"));
    const batch = batched(await source.read(context));
    assert.equal(batch.conversationId, errored.id);
    assert.equal(batch.segmentEndEntryId, answer.id, "a real answer closes the turn");
    assert.ok(batch.entries.some((entry) => entry.text === "ERROR-RECOVERED-5500"));
    await source.acknowledge(batch, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
