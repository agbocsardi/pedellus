// Bounded memory-digestion evidence: completed-turn eligibility, labeled message and tool
// evidence, lossless fragmentation and head-tail previews, the one durable cursor and its legacy
// mapping. These checks use synthetic transcripts and a disposable SQLite store; nothing calls a
// model, opens a chat or schedules work.
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
  createDigestSource,
  DigestCursorConflictError,
  DigestCursorDoc,
  DIGEST_LIMITS,
  DIGEST_PREVIEW_CHARS,
} = await load(`${pkg}/dist/history/digestion.js`);
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


/**
 * Write the shape the closed-episode reader persisted: four fields and no step position. The new
 * document's initial value already carries the new fields, so they are removed here to reproduce a
 * store written by the earlier build.
 */
async function writeLegacyCursor(harness, conversationId, fields) {
  await harness.commit(async (tx) => {
    const document = await tx.doc(DigestCursorDoc, conversationId);
    delete document.nextEntryId;
    delete document.nextItemIndex;
    delete document.nextTextStart;
    delete document.pendingToolCalls;
    document.throughEntryId = fields.throughEntryId;
    document.throughChars = fields.throughChars;
    document.episodeStartEntryId = fields.episodeStartEntryId;
    document.episodeEndEntryId = fields.episodeEndEntryId;
  }, context);
}

function batched(result) {
  assert.equal(result.status, "batch", "expected a digest batch");
  return result;
}

async function drain(source, limit = 200) {
  const batches = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await source.read(context);
    if (result.status === "idle") return { batches, idle: result };
    const batch = batched(result);
    const chars = batch.entries.reduce((total, entry) => total + entry.text.length, 0);
    assert.ok(chars <= DIGEST_LIMITS.charsPerBatch, "batch evidence stays within its bound");
    batches.push(batch);
    await source.acknowledge(batch, context);
  }
  throw new Error(`digest did not settle after ${limit} batches`);
}

function idle(result) {
  assert.equal(result.status, "idle", "expected a digest idle report");
  return result;
}

function sourceFor(harness, conversation, limits) {
  return createDigestSource({
    harness,
    ...(limits === undefined ? {} : { limits }),
    sessions: async () => [{ sessionKey: "cli:digest", conversationId: conversation.id }],
  });
}

function sourcesFor(harness, chats, limits) {
  return createDigestSource({
    harness,
    ...(limits === undefined ? {} : { limits }),
    sessions: async () => chats.map(({ key, conversation }) => ({
      sessionKey: key,
      conversationId: conversation.id,
    })),
  });
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

test("empty resets do not move an interleaved non-empty episode ahead of an older episode", { timeout: 15_000 }, async () => {
  const directory = await temp("nanobot-digest-reset-order-");
  const harness = await openStore(resolve(directory, "state.sqlite"));
  try {
    const a = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const b = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [emptyReset] = await append(harness, a, reset());
    await append(harness, b, reset(), user("OLDER-B"), assistant("Done."), reset());
    await append(harness, a, reset(), user("NEWER-A"), assistant("Done."), reset());
    const source = sourcesFor(harness, [{ key: "cli:a", conversation: a }, { key: "cli:b", conversation: b }]);
    const first = batched(await source.readClosed(context));
    assert.equal(first.sessionKey, "cli:b");
    await source.acknowledge(first, context);
    const second = batched(await source.readClosed(context));
    assert.equal(second.sessionKey, "cli:a");
    assert.equal(second.firstEntryId, emptyReset.id, "consume empty resets rather than silently skip the frontier");
    await source.acknowledge(second, context);
    assert.equal((await source.readClosed(context)).status, "idle");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("episode ordering retains the real opening when an older cursor consumed its prefix", { timeout: 15_000 }, async () => {
  const directory = await temp("nanobot-digest-partial-order-");
  const harness = await openStore(resolve(directory, "state.sqlite"));
  try {
    const a = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const b = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, a, reset(), user("ALREADY-CONSUMED"), assistant("Done."));
    await append(harness, b, reset(), user("NEWER-EPISODE"), assistant("Done."), reset());
    const [later] = await append(harness, a, user("OLDER-EPISODE-REMAINDER"), assistant("Done."), reset());
    await harness.commit(async (tx) => {
      const cursor = await tx.doc(DigestCursorDoc, a.id);
      cursor.nextEntryId = later.id;
    }, context);
    const source = sourcesFor(harness, [{ key: "cli:b", conversation: b }, { key: "cli:a", conversation: a }]);
    const first = batched(await source.readClosed(context));
    assert.equal(first.sessionKey, "cli:a");
    assert.ok(first.entries.every((entry) => !entry.text.includes("ALREADY-CONSUMED")));
    await source.acknowledge(first, context);
    assert.equal(batched(await source.readClosed(context)).sessionKey, "cli:b");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("admission chunk counts use actual packing when entry and character limits interact", { timeout: 15_000 }, async () => {
  const directory = await temp("nanobot-digest-packing-");
  const harness = await openStore(resolve(directory, "state.sqlite"));
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, ...Array.from({ length: 5 }, () => user("abcdef")), reset());
    const source = sourceFor(harness, conversation, { entriesPerBatch: 2, charsPerBatch: 10 });
    const first = batched(await source.readClosed(context));
    assert.equal(first.estimatedChars, 30);
    assert.equal(first.estimatedChunks, 4, "max(ceil(chars/10), ceil(entries/2)) would underestimate this as three");
    let chunks = 0;
    for (let n = 0; n < 10; n += 1) {
      const next = await source.readClosed(context);
      if (next.status === "idle") break;
      chunks += 1;
      await source.acknowledge(next, context);
    }
    assert.equal(chunks, first.estimatedChunks);
    assert.equal((await source.readClosed(context)).status, "idle");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed selection preserves an imported frontier across reopen and offers only future closed evidence", { timeout: 15_000 }, async () => {
  const directory = await temp("nanobot-digest-closed-import-");
  const dbPath = resolve(directory, "state.sqlite");
  let harness;
  try {
    harness = await openStore(dbPath);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(async (tx) => {
      await tx.appendEntry(conversation.id, reset());
      await tx.appendEntry(conversation.id, user("IMPORTED-DO-NOT-REPLAY"));
      const closing = await tx.appendEntry(conversation.id, reset());
      const cursor = await tx.doc(DigestCursorDoc, conversation.id);
      Object.assign(cursor, { nextEntryId: closing.id, nextItemIndex: 0, nextTextStart: 0,
        episodeStartEntryId: null, episodeEndEntryId: null, pendingToolCalls: [] });
    }, context);
    assert.equal((await sourceFor(harness, conversation).readClosed(context)).status, "idle");
    await harness.close(context);
    harness = await openStore(dbPath);
    const reopened = await harness.conversation(conversation.id, context);
    const source = sourceFor(harness, reopened, { entriesPerBatch: 5, charsPerBatch: 12 });
    assert.equal((await source.readClosed(context)).status, "idle");
    await append(harness, reopened, user("FUTURE-EVIDENCE"), assistant("New answer."));
    assert.equal((await source.readClosed(context)).status, "idle", "completed turns in open episodes remain ineligible");
    await append(harness, reopened, reset());
    const evidence = [];
    for (let n = 0; n < 10; n += 1) {
      const result = await source.readClosed(context);
      if (result.status === "idle") break;
      evidence.push(...result.entries.map((entry) => entry.text));
      await source.acknowledge(result, context);
    }
    assert.equal((await source.readClosed(context)).status, "idle");
    assert.equal(evidence.join(""), "FUTURE-EVIDENCENew answer.");
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed selection resumes an older completed-turn segment without replaying its consumed prefix", { timeout: 15_000 }, async () => {
  const directory = await temp("nanobot-digest-closed-upgrade-");
  const harness = await openStore(resolve(directory, "state.sqlite"));
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("abcdefghij"), assistant("old answer"));
    const source = sourceFor(harness, conversation, { entriesPerBatch: 10, charsPerBatch: 5 });
    const oldChunk = batched(await source.read(context));
    await source.acknowledge(oldChunk, context);
    assert.equal((await source.readClosed(context)).status, "idle", "a frozen segment does not make an open episode eligible");
    await append(harness, conversation, user("later exchange"), assistant("later answer"), reset());
    const evidence = [];
    for (let n = 0; n < 30; n += 1) {
      const result = await source.readClosed(context);
      if (result.status === "idle") break;
      evidence.push(...result.entries.map((entry) => entry.text));
      await source.acknowledge(result, context);
    }
    assert.equal((await source.readClosed(context)).status, "idle");
    assert.equal(evidence.join(""), "fghijold answerlater exchangelater answer");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("three fitting completed turns are one batch and an open tail waits for its answer", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-open-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [q1] = await append(harness, conversation, user("FIRST-QUESTION-5501"));
    const [a1] = await append(harness, conversation, assistant("FIRST-ANSWER-1182"));
    const [q2] = await append(harness, conversation, user("SECOND-QUESTION-7734"));
    const [a2] = await append(harness, conversation, assistant("SECOND-ANSWER-2298"));
    const [q3] = await append(harness, conversation, user("THIRD-QUESTION-4410"));
    const [a3] = await append(harness, conversation, assistant("THIRD-ANSWER-8865"));
    const [open] = await append(harness, conversation, user("STILL-OPEN-6610"));

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    // The range covers every completed turn the scan reached, not just the first boundary.
    assert.equal(first.episodeStartEntryId, q1.id);
    assert.equal(first.episodeEndEntryId, a3.id);
    assert.equal(first.complete, true);
    assert.deepEqual(first.entries.map((entry) => [entry.entryId, entry.trustLabel, entry.text]), [
      [q1.id, "owner message", "FIRST-QUESTION-5501"],
      [a1.id, "assistant reply", "FIRST-ANSWER-1182"],
      [q2.id, "owner message", "SECOND-QUESTION-7734"],
      [a2.id, "assistant reply", "SECOND-ANSWER-2298"],
      [q3.id, "owner message", "THIRD-QUESTION-4410"],
      [a3.id, "assistant reply", "THIRD-ANSWER-8865"],
    ]);
    assert.ok(!first.entries.some((entry) => entry.entryId === open.id), "the open tail is not evidence");

    // Reading again before acknowledgement is stable and moves nothing.
    assert.deepEqual(await source.read(context), first);
    await source.acknowledge(first, context);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: open.id,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    });

    // The last owner message has no answer yet: it is not evidence and the high-water stays put.
    const waiting = idle(await source.read(context));
    assert.equal(waiting.caughtUp, true);
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, open.id);
    assert.deepEqual(await source.read(context), waiting);

    // A turn appended after that read is a later range: processed once, and nothing already
    // acknowledged is replayed.
    const [answer] = await append(harness, conversation, assistant("OPEN-ANSWER-8843"));
    const second = batched(await source.read(context));
    assert.equal(second.episodeStartEntryId, open.id);
    assert.equal(second.episodeEndEntryId, answer.id);
    assert.deepEqual(second.entries.map((entry) => entry.text), ["STILL-OPEN-6610", "OPEN-ANSWER-8843"]);
    assert.ok(!second.entries.some((entry) => entry.entryId <= a3.id), "earlier turns are never replayed");
    await source.acknowledge(second, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an over-budget multi-turn range is delivered as ordered chunks, one per read", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-multiturn-chunks-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const texts = [
      "CHUNK-Q1-00000000001",
      "CHUNK-A1-00000000002",
      "CHUNK-Q2-00000000003",
      "CHUNK-A2-00000000004",
      "CHUNK-Q3-00000000005",
      "CHUNK-A3-00000000006",
    ];
    const entries = [];
    for (let index = 0; index < texts.length; index += 1) {
      const [entry] = index % 2 === 0
        ? await append(harness, conversation, user(texts[index]))
        : await append(harness, conversation, assistant(texts[index]));
      entries.push(entry);
    }

    // Six turns of 20 characters each against 30 characters per chunk: the range cannot fit one
    // chunk, but its accepted bounds never move, and each read serves exactly one ordered chunk.
    const source = sourceFor(harness, conversation, { entriesPerBatch: 6, charsPerBatch: 30 });
    const batches = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      batches.push(batched(result));
      await source.acknowledge(batches.at(-1), context);
    }
    assert.equal(batches.length, 4, "one ordered chunk per read for the over-budget range");
    assert.deepEqual(batches.map((batch) => batch.complete), [false, false, false, true]);
    for (const batch of batches) {
      assert.equal(batch.episodeStartEntryId, entries[0].id, "the range start is immutable across chunks");
      assert.equal(batch.episodeEndEntryId, entries[5].id, "the range end is immutable across chunks");
    }
    for (let index = 0; index < texts.length; index += 1) {
      assert.equal(itemText(batches, entries[index].id, 0), texts[index], `turn ${index + 1} is delivered whole once`);
    }
    const fragments = batches.flatMap((batch) => batch.entries);
    assert.equal(new Set(fragments.map((entry) => `${entry.entryId}:${entry.itemIndex}`)).size, texts.length);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open tool round after completed turns is not cut into the range", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-tool-cutoff-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [firstQuestion] = await append(harness, conversation, user("DONE-QUESTION-1180"));
    const [firstAnswer] = await append(harness, conversation, assistant("DONE-ANSWER-2244"));
    const [secondQuestion] = await append(harness, conversation, user("ROUND-QUESTION-3355"));
    const [call] = await append(harness, conversation, toolCallAssistant("ROUND-READING-4466", "call-cutoff", "read", {
      path: "b.txt",
    }));

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    assert.equal(first.episodeStartEntryId, firstQuestion.id);
    assert.equal(first.episodeEndEntryId, firstAnswer.id, "the range ends at the last completed answer");
    assert.deepEqual(first.entries.map((entry) => entry.text), ["DONE-QUESTION-1180", "DONE-ANSWER-2244"]);
    assert.ok(!first.entries.some((entry) => entry.entryId === call.id), "no partial tool round is offered");
    await source.acknowledge(first, context);
    assert.equal(idle(await source.read(context)).caughtUp, true, "the open round stays queued");

    const [result] = await append(harness, conversation, toolResult("ROUND-CONTENTS-5577", "call-cutoff"));
    const [answer] = await append(harness, conversation, assistant("ROUND-ANSWER-6688"));
    const second = batched(await source.read(context));
    assert.equal(second.episodeStartEntryId, secondQuestion.id);
    assert.equal(second.episodeEndEntryId, answer.id);
    assert.deepEqual(second.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]), [
      [secondQuestion.id, "message", "ROUND-QUESTION-3355"],
      [call.id, "message", "ROUND-READING-4466"],
      [call.id, "tool-call", JSON.stringify({ path: "b.txt" })],
      [result.id, "tool-result", "ROUND-CONTENTS-5577"],
      [answer.id, "message", "ROUND-ANSWER-6688"],
    ]);
    await source.acknowledge(second, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open tool round is held back until its result is paired and the turn is terminal", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-tool-round-");
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
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    });

    const [answer] = await append(harness, conversation, assistant("INSPECTION-DONE-6675"));
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, owner.id);
    assert.equal(batch.episodeEndEntryId, answer.id);
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
  const dir = await temp("nanobot-digest-preview-");
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
    assert.ok(resultEvidence.text.length <= DIGEST_PREVIEW_CHARS);
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
  const dir = await temp("nanobot-digest-excluded-");
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
  const dir = await temp("nanobot-digest-unicode-");
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
  const dir = await temp("nanobot-digest-pairing-restart-");
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
  const dir = await temp("nanobot-digest-replay-");
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
    assert.equal(next.nextEntryId > first.episodeEndEntryId, true);
    assert.deepEqual(await source.cursor(conversation.id, context), next);

    await assert.rejects(
      source.acknowledge(first, context),
      (error) => error instanceof DigestCursorConflictError || error instanceof TypeError,
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
  const dir = await temp("nanobot-digest-empty-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [owner] = await append(harness, conversation, userImageOnly());
    const [answer] = await append(harness, conversation, thinkingOnly());

    const source = sourceFor(harness, conversation);
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, owner.id);
    assert.equal(batch.episodeEndEntryId, answer.id);
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

test("the source accepts only validated mapped chat sessions", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-scope-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("SCOPED-7733"), assistant("SCOPED-ANSWER-1142"));

    const channelState = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "telegram:x:channel-state", conversationId: conversation.id }],
    });
    await assert.rejects(
      channelState.read(context),
      (error) => error instanceof TypeError && /channel-state/.test(error.message),
    );

    const duplicate = createDigestSource({
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

    const emptyKey = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "", conversationId: conversation.id }],
    });
    await assert.rejects(
      emptyKey.read(context),
      (error) => error instanceof TypeError && /non-empty/.test(error.message),
    );

    const missing = idle(await createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:gone", conversationId: conversation.id + 10_000 }],
    }).read(context));
    assert.equal(missing.missingChats, 1, "a missing conversation record is reported, never evidence");
    assert.equal(missing.caughtUp, false);
    assert.equal(idle(await createDigestSource({
      harness,
      sessions: async () => [],
    }).read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh segment starts at its own start when two chats interleave entry IDs", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-interleaved-");
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
      episodeStartEntryId: a2.id,
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
    assert.equal(third.episodeStartEntryId, a3.id);
    assert.equal(third.firstEntryId, a3.id, "a fresh chunk starts at its own segment start");
    assert.equal(third.firstItemIndex, 0);
    assert.equal(third.firstTextStart, 0);
    assert.deepEqual(third.entries.map((entry) => entry.text), ["A-SECOND-QUESTION-8844", "A-SECOND-ANSWER-9955"]);
    await source.acknowledge(third, context);

    const [a5] = await append(harness, a, user("UNACKNOWLEDGED-QUESTION-1166"));
    const [a6] = await append(harness, a, assistant("UNACKNOWLEDGED-ANSWER-2277"));
    const valid = batched(await source.read(context));
    assert.equal(valid.episodeStartEntryId, a5.id);

    // A forged fresh start beyond an unconsumed entry must not be able to skip it.
    const forged = {
      ...valid,
      episodeStartEntryId: a6.id,
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
  const dir = await temp("nanobot-digest-astral-preview-");
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

test("a partially consumed closed episode resumes at its acknowledged offset", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-partial-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [question] = await append(harness, conversation, user("PARTIAL-QUESTION-7733"));
    const [answer] = await append(harness, conversation, assistant("PARTIAL-ANSWER-8844"));
    await append(harness, conversation, reset("PARTIAL-HANDOFF-NOT-EVIDENCE-9955"));
    await writeLegacyCursor(harness, conversation.id, { throughEntryId: question.id, throughChars: 4, episodeStartEntryId: question.id, episodeEndEntryId: answer.id });

    const source = sourceFor(harness, conversation);
    const cursor = await source.cursor(conversation.id, context);
    assert.equal(cursor.nextEntryId, question.id, "the frontier entry is resumed, not replayed");
    assert.equal(cursor.nextTextStart, 4, "the acknowledged message offset is kept");
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, question.id);
    assert.equal(batch.episodeEndEntryId, answer.id);
    assert.equal(batch.firstTextStart, 4);
    assert.deepEqual(
      batch.entries.map((entry) => [entry.entryId, entry.textStart, entry.text]),
      [[question.id, 4, "IAL-QUESTION-7733"], [answer.id, 0, "PARTIAL-ANSWER-8844"]],
      "only the undigested message tail and the rest of the episode are evidence",
    );
    await source.acknowledge(batch, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adoption finishes a frozen closed episode without replaying its frontier message", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-bounds-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [question] = await append(harness, conversation, user("MIGRATE-QUESTION-1166"));
    const [call] = await append(
      harness,
      conversation,
      toolCallAssistant("MIGRATE-REPLY-2277", "call-migrate", "read", { path: "m.txt" }),
    );
    const [result] = await append(harness, conversation, toolResult("MIGRATE-RESULT-3388", "call-migrate"));
    const [answer] = await append(harness, conversation, assistant("MIGRATE-DONE-4499"));
    const [closing] = await append(harness, conversation, reset());
    await writeLegacyCursor(harness, conversation.id, { throughEntryId: call.id, throughChars: "MIGRATE-REPLY-2277".length, episodeStartEntryId: question.id, episodeEndEntryId: answer.id });

    const source = sourceFor(harness, conversation);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: call.id,
      nextItemIndex: 0,
      nextTextStart: "MIGRATE-REPLY-2277".length,
      episodeStartEntryId: question.id,
      episodeEndEntryId: answer.id,
      pendingToolCalls: [],
    }, "the frozen legacy episode bounds are continued");
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, question.id);
    assert.equal(batch.episodeEndEntryId, answer.id);
    assert.equal(batch.firstEntryId, call.id);
    assert.equal(batch.firstTextStart, "MIGRATE-REPLY-2277".length);
    assert.deepEqual(
      batch.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]),
      [
        [call.id, "tool-call", JSON.stringify({ path: "m.txt" })],
        [result.id, "tool-result", "MIGRATE-RESULT-3388"],
        [answer.id, "message", "MIGRATE-DONE-4499"],
      ],
      "the consumed reply is not replayed, its tool round and the rest of the episode are read",
    );
    await source.acknowledge(batch, context);
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, closing.id);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adoption pairs a result whose call precedes the frontier at entry and character boundaries", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-pair-boundary-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);

    const entryChat = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [entryQuestion] = await append(harness, entryChat, user("ENTRY-QUESTION-1100"));
    const [entryCall] = await append(
      harness,
      entryChat,
      toolCallAssistant("ENTRY-REPLY-2200", "call-entry", "read", { path: "entry.txt" }),
    );
    const [entryResult] = await append(harness, entryChat, toolResult("ENTRY-RESULT-3300", "call-entry"));
    await append(harness, entryChat, system("ENTRY-SYSTEM-NOT-EVIDENCE-4400"));
    const [entryAnswer] = await append(harness, entryChat, assistant("ENTRY-ANSWER-5500"));
    await append(harness, entryChat, reset());
    await writeLegacyCursor(harness, entryChat.id, { throughEntryId: entryResult.id, throughChars: 0, episodeStartEntryId: entryQuestion.id, episodeEndEntryId: entryAnswer.id });

    const charText = "CHAR-RESULT-6600";
    const charChat = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [charQuestion] = await append(harness, charChat, user("CHAR-QUESTION-7700"));
    await append(harness, charChat, toolCallAssistant("CHAR-REPLY-8800", "call-char", "read", { path: "char.txt" }));
    const [charResult] = await append(harness, charChat, toolResult(charText, "call-char"));
    const [charAnswer] = await append(harness, charChat, assistant("CHAR-ANSWER-9900"));
    await append(harness, charChat, reset());
    await writeLegacyCursor(harness, charChat.id, { throughEntryId: charResult.id, throughChars: 0, episodeStartEntryId: charQuestion.id, episodeEndEntryId: charAnswer.id });

    const entryLimits = { entriesPerBatch: 2, charsPerBatch: 10_000 };
    const charLimits = { entriesPerBatch: 50, charsPerBatch: charText.length };
    let entrySource = sourceFor(harness, entryChat, entryLimits);
    let charSource = sourceFor(harness, charChat, charLimits);

    const entryFirst = batched(await entrySource.read(context));
    assert.equal(entryFirst.conversationId, entryChat.id);
    assert.equal(entryFirst.complete, false, "the entry bound stops the chunk after the paired result");
    assert.deepEqual(
      entryFirst.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]),
      [[entryResult.id, "tool-result", "ENTRY-RESULT-3300"]],
      "the paired result survives the entry-count boundary",
    );
    await entrySource.acknowledge(entryFirst, context);

    const charFirst = batched(await charSource.read(context));
    assert.equal(charFirst.conversationId, charChat.id);
    assert.equal(charFirst.complete, false, "the character bound stops the chunk after the paired result");
    assert.deepEqual(
      charFirst.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]),
      [[charResult.id, "tool-result", charText]],
      "the paired result survives the character boundary",
    );
    await charSource.acknowledge(charFirst, context);

    await harness.close(context);
    harness = await openStore(db);
    entrySource = sourceFor(harness, entryChat, entryLimits);
    charSource = sourceFor(harness, charChat, charLimits);

    const entrySecond = batched(await entrySource.read(context));
    assert.equal(entrySecond.complete, true);
    assert.deepEqual(
      entrySecond.entries.map((entry) => [entry.entryId, entry.text]),
      [[entryAnswer.id, "ENTRY-ANSWER-5500"]],
      "the reopened entry-count continuation reads the remaining answer",
    );
    await entrySource.acknowledge(entrySecond, context);

    const charSecond = batched(await charSource.read(context));
    assert.equal(charSecond.complete, true);
    assert.deepEqual(
      charSecond.entries.map((entry) => [entry.entryId, entry.text]),
      [[charAnswer.id, "CHAR-ANSWER-9900"]],
      "the reopened character continuation reads the remaining answer",
    );
    await charSource.acknowledge(charSecond, context);

    // The calls are before the frontier and must not be replayed as fresh tool-call evidence.
    assert.ok(entryCall.id < entryResult.id);
    assert.ok(entryFirst.entries.every((entry) => entry.itemKind !== "tool-call"));
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a settled legacy cursor derives calls from its reset prefix instead of orphaning the result", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-settled-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, reset("SETTLED-HANDOFF-1122"));
    const [question] = await append(harness, conversation, user("SETTLED-QUESTION-2233"));
    const [call] = await append(
      harness,
      conversation,
      toolCallAssistant("SETTLED-REPLY-3344", "call-settled", "read", { path: "settled.txt" }),
    );
    const [result] = await append(harness, conversation, toolResult("SETTLED-RESULT-4455", "call-settled"));
    await append(harness, conversation, reset());
    const [laterQuestion] = await append(harness, conversation, user("SETTLED-LATER-5566"));
    const [laterAnswer] = await append(harness, conversation, assistant("SETTLED-LATER-6677"));
    await writeLegacyCursor(harness, conversation.id, { throughEntryId: result.id, throughChars: 0, episodeStartEntryId: null, episodeEndEntryId: null });
    assert.ok(question.id < call.id && call.id < result.id);

    let source = sourceFor(harness, conversation);
    const cursor = await source.cursor(conversation.id, context);
    assert.deepEqual(cursor.pendingToolCalls, ["call-settled"],
      "the open call is derived from the reset-delimited legacy prefix");
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, result.id);
    assert.equal(batch.episodeEndEntryId, laterAnswer.id);
    assert.deepEqual(
      batch.entries.map((entry) => [entry.entryId, entry.itemKind, entry.text]),
      [
        [result.id, "tool-result", "SETTLED-RESULT-4455"],
        [laterQuestion.id, "message", "SETTLED-LATER-5566"],
        [laterAnswer.id, "message", "SETTLED-LATER-6677"],
      ],
      "the frontier result is paired, and a later completed turn carries it without replaying the call",
    );
    await source.acknowledge(batch, context);

    await harness.close(context);
    harness = await openStore(db);
    source = sourceFor(harness, conversation);
    const reopened = await source.cursor(conversation.id, context);
    assert.deepEqual(reopened.pendingToolCalls, [], "the paired result closes the derived call after reopen");
    assert.equal(reopened.nextEntryId, laterAnswer.id + 1);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adoption keeps the legacy empty-block extraction for a partial astral offset", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-empty-block-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [owner] = await append(harness, conversation, {
      kind: "pi.user",
      model: [{
        role: "user",
        content: [
          { type: "text", text: "AB" },
          { type: "text", text: "" },
          { type: "text", text: "🙂CD" },
        ],
        timestamp: 1_000,
      }],
    });
    const [answer] = await append(harness, conversation, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([
        { type: "text", text: "REPLY" },
        { type: "text", text: "" },
        { type: "text", text: "🙂END" },
      ])],
    });
    await append(harness, conversation, reset());
    // The legacy extraction of the owner text is "AB\n\n🙂CD"; offset 4 is the astral pair's start.
    // A reader that dropped the empty block would treat the same offset as the low surrogate.
    await writeLegacyCursor(harness, conversation.id, { throughEntryId: owner.id, throughChars: 4, episodeStartEntryId: owner.id, episodeEndEntryId: answer.id });

    const source = sourceFor(harness, conversation);
    const batch = batched(await source.read(context));
    assert.deepEqual(
      batch.entries.map((entry) => [entry.entryId, entry.textStart, entry.text]),
      [
        [owner.id, 4, "🙂CD"],
        [answer.id, 0, "REPLY\n\n🙂END"],
      ],
      "the empty block keeps the legacy offset space, so the astral pair is not split",
    );
    await source.acknowledge(batch, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adoption refuses a legacy offset that splits a surrogate pair", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-adopt-surrogate-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [owner] = await append(harness, conversation, {
      kind: "pi.user",
      model: [{
        role: "user",
        content: [
          { type: "text", text: "AB" },
          { type: "text", text: "" },
          { type: "text", text: "🙂CD" },
        ],
        timestamp: 1_000,
      }],
    });
    const [answer] = await append(harness, conversation, assistant("SURROGATE-ANSWER-7788"));
    // "AB\n\n🙂CD" puts the low surrogate at 5; the legacy offset cannot start there.
    await writeLegacyCursor(harness, conversation.id, {
      throughEntryId: owner.id,
      throughChars: 5,
      episodeStartEntryId: owner.id,
      episodeEndEntryId: answer.id,
    });

    const source = sourceFor(harness, conversation);
    await assert.rejects(
      source.cursor(conversation.id, context),
      (error) => error instanceof Error && /splits a surrogate pair/.test(error.message),
      "an impossible legacy offset is refused instead of emitting half a pair",
    );
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted or errored assistant entry is not a completed answer", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-abort-error-");
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
    assert.deepEqual(await source.cursor(errored.id, context), {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    });

    const [answer] = await append(harness, errored, assistant("ERROR-RECOVERED-5500"));
    const batch = batched(await source.read(context));
    assert.equal(batch.conversationId, errored.id);
    assert.equal(batch.episodeEndEntryId, answer.id, "a real answer closes the turn");
    assert.ok(batch.entries.some((entry) => entry.text === "ERROR-RECOVERED-5500"));
    await source.acknowledge(batch, context);
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool call id at the accepted bound pairs and a longer id fails closed", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-call-id-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const bound = DIGEST_LIMITS.maxToolCallIdChars;
    const acceptedId = "c".repeat(bound);
    const accepted = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, accepted, user("BOUND-ID-QUESTION-1177"));
    await append(harness, accepted, toolCallAssistant("BOUND-ID-READING-2288", acceptedId, "read", { path: "b.txt" }));
    const [acceptedResult] = await append(harness, accepted, toolResult("BOUND-ID-RESULT-3399", acceptedId));
    await append(harness, accepted, assistant("BOUND-ID-DONE-4411"));

    const acceptedSource = sourceFor(harness, accepted);
    const acceptedBatch = batched(await acceptedSource.read(context));
    const callEvidence = acceptedBatch.entries.find((entry) => entry.itemKind === "tool-call");
    const resultEvidence = acceptedBatch.entries.find((entry) => entry.itemKind === "tool-result");
    assert.ok(callEvidence !== undefined, "the call at the bound is evidence");
    assert.ok(resultEvidence !== undefined, "the paired result at the bound is evidence");
    assert.equal(callEvidence.toolCallId, acceptedId);
    assert.equal(resultEvidence.toolCallId, acceptedId);
    assert.equal(resultEvidence.entryId, acceptedResult.id);
    assert.equal(resultEvidence.text, "BOUND-ID-RESULT-3399", "the paired result is not lost at the bound");
    await acceptedSource.acknowledge(acceptedBatch, context);

    const refused = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const longId = "c".repeat(bound + 1);
    await append(harness, refused, user("LONG-ID-QUESTION-5522"));
    await append(harness, refused, toolCallAssistant("LONG-ID-READING-6633", longId, "read", { path: "l.txt" }));
    await append(harness, refused, toolResult("LONG-ID-RESULT-7744", longId));
    await append(harness, refused, assistant("LONG-ID-DONE-8855"));

    const refusedSource = sourceFor(harness, refused);
    await assert.rejects(
      refusedSource.read(context),
      (error) => error instanceof Error && /tool call id longer than 200 characters/.test(error.message),
      "an over-long id refuses the segment instead of silently orphaning its result",
    );
    assert.deepEqual(await refusedSource.cursor(refused.id, context), {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    }, "a refused segment advances nothing");
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a legacy closed-episode cursor is mapped exactly and upgraded in place", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-legacy-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("OLD-DIGEST-QUESTION-6611"));
    const [oldAnswer] = await append(harness, conversation, assistant("OLD-DIGEST-ANSWER-7722"));
    await append(harness, conversation, user("NEW-TURN-QUESTION-8833"));
    const [newAnswer] = await append(harness, conversation, assistant("NEW-TURN-ANSWER-9944"));
    await writeLegacyCursor(harness, conversation.id, { throughEntryId: oldAnswer.id, throughChars: "OLD-DIGEST-ANSWER-7722".length, episodeStartEntryId: null, episodeEndEntryId: null });
    const legacyBefore = await harness.snapshot(DigestCursorDoc, conversation.id, context);
    assert.ok(legacyBefore !== undefined);

    let source = sourceFor(harness, conversation);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: oldAnswer.id,
      nextItemIndex: 0,
      nextTextStart: "OLD-DIGEST-ANSWER-7722".length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    }, "the acknowledged entry and offset become the next position, not a replay");

    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, oldAnswer.id);
    assert.equal(batch.firstEntryId, oldAnswer.id);
    assert.equal(batch.firstItemIndex, 0);
    assert.equal(batch.firstTextStart, "OLD-DIGEST-ANSWER-7722".length);
    assert.deepEqual(batch.entries.map((entry) => entry.text), ["NEW-TURN-QUESTION-8833", "NEW-TURN-ANSWER-9944"],
      "already digested text is not processed again");
    assert.deepEqual(await harness.snapshot(DigestCursorDoc, conversation.id, context), legacyBefore,
      "a read never rewrites the stored cursor");

    await source.acknowledge(batch, context);
    const upgraded = await harness.snapshot(DigestCursorDoc, conversation.id, context);
    assert.equal(upgraded.nextEntryId, newAnswer.id + 1, "one acknowledgement upgrades the cursor in place");
    assert.equal(upgraded.throughEntryId, null);
    assert.equal(upgraded.throughChars, null);

    await harness.close(context);
    harness = await openStore(db);
    source = sourceFor(harness, conversation);
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, newAnswer.id + 1,
      "the upgraded cursor survives a reopen");
  } finally {
    if (harness !== undefined) await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the oldest completed segment is served first across mapped conversations", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-order-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const alpha = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const beta = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [alphaOne] = await append(harness, alpha, user("ALPHA-ONE-5501"));
    const [alphaResetOne] = await append(harness, alpha, reset());
    const [betaOne] = await append(harness, beta, user("BETA-ONE-2273"));
    const [betaResetOne] = await append(harness, beta, reset());
    const [alphaTwo] = await append(harness, alpha, user("ALPHA-TWO-9918"));
    await append(harness, alpha, reset());
    const [betaTwo] = await append(harness, beta, user("BETA-TWO-4486"));
    await append(harness, beta, reset());

    const source = sourcesFor(harness, [
      { key: "cli:alpha", conversation: alpha },
      { key: "telegram:beta", conversation: beta },
    ]);
    const seen = [];
    for (let index = 0; index < 4; index += 1) {
      const batch = batched(await source.read(context));
      seen.push([batch.sessionKey, batch.episodeStartEntryId, batch.entries[0].text]);
      await source.acknowledge(batch, context);
    }
    // A reset marker opens the next segment, so alpha's second segment starts at its reset, which
    // is older than beta's first turn: serving is by global entry id, never grouped by chat.
    assert.deepEqual(seen, [
      ["cli:alpha", alphaOne.id, "ALPHA-ONE-5501"],
      ["cli:alpha", alphaResetOne.id, "ALPHA-TWO-9918"],
      ["telegram:beta", betaOne.id, "BETA-ONE-2273"],
      ["telegram:beta", betaResetOne.id, "BETA-TWO-4486"],
    ]);
    assert.ok(alphaOne.id < alphaResetOne.id && alphaResetOne.id < betaOne.id);
    assert.ok(alphaTwo.id > alphaResetOne.id && betaTwo.id > betaResetOne.id);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scan resuming from its cache closes the whole segment, not a suffix of it", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-scan-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("FIRST-TURN-8830"));
    const [segmentReset] = await append(harness, conversation, reset());
    const [middleEntry] = await append(harness, conversation, user("SEGMENT-START-EVIDENCE-1147"));

    const source = sourceFor(harness, conversation);
    // First pass consumes the completed first turn, then scans the open segment and caches it.
    const first = batched(await source.read(context));
    await source.acknowledge(first, context);
    assert.equal(idle(await source.read(context)).caughtUp, true, "the unfinished turn is not evidence");

    // The segment completes later. The resumed scan must report its real start and all its evidence.
    const [lastInSegment] = await append(harness, conversation, assistant("SEGMENT-END-EVIDENCE-9025"));
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, segmentReset.id);
    assert.equal(batch.episodeEndEntryId, lastInSegment.id);
    assert.equal(batch.firstEntryId, segmentReset.id);
    assert.deepEqual(batch.entries.map((fragment) => fragment.text), [
      "SEGMENT-START-EVIDENCE-1147",
      "SEGMENT-END-EVIDENCE-9025",
    ]);
    assert.equal(batch.entries[0].entryId, middleEntry.id);
    await source.acknowledge(batch, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bounded scan reports postponed and unfinished chats instead of claiming caught up", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-digest-budget-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const busy = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // One still-open segment longer than a single read's scan budget: no completed exchange exists.
    await harness.commit(async (tx) => {
      for (let index = 0; index < DIGEST_LIMITS.scanEntriesPerRead + 200; index += 1) {
        await tx.appendEntry(busy.id, system(`BUSY-NOT-EVIDENCE-${index}`));
      }
    }, context);
    const closed = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [closedUser] = await append(harness, closed, user("CLOSED-CHAT-1182"));
    await append(harness, closed, reset());

    const sessions = async () => [
      { sessionKey: "cli:busy", conversationId: busy.id },
      { sessionKey: "cli:closed", conversationId: closed.id },
    ];
    const source = createDigestSource({ harness, sessions });

    const first = idle(await source.read(context));
    assert.equal(first.caughtUp, false);
    assert.equal(first.examinedChats, 1);
    assert.equal(first.postponedChats, 1);
    assert.equal(first.unfinishedChats, 1);
    assert.equal(first.missingChats, 0);

    // Rotation gives the postponed chat its turn even though the busy chat is unfinished.
    const batch = batched(await source.read(context));
    assert.equal(batch.sessionKey, "cli:closed");
    assert.equal(batch.entries[0].text, "CLOSED-CHAT-1182");
    await source.acknowledge(batch, context);

    const settled = idle(await source.read(context));
    assert.equal(settled.caughtUp, true);
    assert.equal(settled.postponedChats, 0);
    assert.equal(settled.unfinishedChats, 0);

    // The scan cache is derived: a restart rescans the open chat from its cursor, still bounded.
    await harness.close(context);
    harness = undefined;
    harness = await openStore(db);
    const reopened = createDigestSource({ harness, sessions });
    const afterRestart = idle(await reopened.read(context));
    assert.equal(afterRestart.caughtUp, false);
    assert.equal(afterRestart.unfinishedChats, 1);
    const restartedSettled = idle(await reopened.read(context));
    assert.equal(restartedSettled.caughtUp, true);
    assert.ok(closedUser.id > 0);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bounded long scan ends at the last completed turn and never skips or replays", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-digest-long-scan-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const turnCount = 1_999;
    let firstEntryId = 0;
    let lastCompletedEntryId = 0;
    await harness.commit(async (tx) => {
      for (let index = 0; index < turnCount; index += 1) {
        const question = await tx.appendEntry(conversation.id, user(`S${index}-Q-0000000000`));
        const answer = await tx.appendEntry(conversation.id, assistant(`S${index}-A-0000000000`));
        firstEntryId ||= question.id;
        lastCompletedEntryId = answer.id;
      }
    }, context);
    // An in-progress turn straddles the scan bound: its owner input and open tool call are examined
    // but fall after the last completed turn, so they must not enter the accepted range.
    const [openQuestion] = await append(harness, conversation, user("OPEN-TAIL-QUESTION-7712"));
    const [openCall] = await append(harness, conversation, toolCallAssistant(
      "OPEN-TAIL-READING-8823",
      "call-long-scan",
      "read",
      { path: "c.txt" },
    ));

    const source = sourceFor(harness, conversation, { entriesPerBatch: 4_000, charsPerBatch: 100_000 });
    const first = batched(await source.read(context));
    assert.equal(first.episodeStartEntryId, firstEntryId);
    assert.equal(first.episodeEndEntryId, lastCompletedEntryId, "the range ends before the open live turn");
    assert.ok(!first.entries.some((entry) => entry.entryId >= openQuestion.id));

    // The 3,998-entry range still exceeds the native step cap, so it continues in the same immutable
    // bounds: one chunk per read, and no entry is ever offered twice.
    const batches = [first];
    await source.acknowledge(first, context);
    while (!batches.at(-1).complete) {
      const next = batched(await source.read(context));
      assert.equal(next.episodeStartEntryId, firstEntryId);
      assert.equal(next.episodeEndEntryId, lastCompletedEntryId);
      batches.push(next);
      await source.acknowledge(next, context);
    }
    const consumed = batches.flatMap((batch) => batch.entries);
    assert.equal(consumed.length, turnCount * 2, "every completed turn is evidence exactly once");
    assert.equal(
      new Set(consumed.map((entry) => `${entry.entryId}:${entry.itemIndex}`)).size,
      consumed.length,
      "the bounded scan neither skips nor replays an entry",
    );
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, openQuestion.id);

    // The unfinishable-by-the-bound turn is still queued, and completing it is a later range.
    assert.equal(idle(await source.read(context)).caughtUp, true);
    const [result] = await append(harness, conversation, toolResult("OPEN-TAIL-CONTENTS-9934", "call-long-scan"));
    const [answer] = await append(harness, conversation, assistant("OPEN-TAIL-ANSWER-1045"));
    const tail = batched(await source.read(context));
    assert.equal(tail.episodeStartEntryId, openQuestion.id);
    assert.equal(tail.episodeEndEntryId, answer.id);
    assert.deepEqual(tail.entries.map((entry) => [entry.entryId, entry.itemKind]), [
      [openQuestion.id, "message"],
      [openCall.id, "message"],
      [openCall.id, "tool-call"],
      [result.id, "tool-result"],
      [answer.id, "message"],
    ]);
    await source.acknowledge(tail, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("reset-only segments and handoff text are consumed without evidence", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-handoff-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [u1] = await append(harness, conversation, user("BEFORE-HANDOFF-1234"));
    const [handoff] = await append(harness, conversation, reset("HANDOFF-TEXT-MUST-NOT-BE-EVIDENCE-9999"));
    const [emptyReset] = await append(harness, conversation, reset());
    const [u2] = await append(harness, conversation, user("AFTER-EMPTY-SEGMENT-4321"));
    await append(harness, conversation, reset());

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    assert.equal(first.episodeStartEntryId, u1.id);
    assert.equal(first.episodeEndEntryId, u1.id);
    assert.deepEqual(first.entries.map((entry) => entry.text), ["BEFORE-HANDOFF-1234"]);
    await source.acknowledge(first, context);

    const second = batched(await source.read(context));
    assert.equal(second.episodeStartEntryId, handoff.id, "a reset prefix stays inside the next segment");
    assert.equal(second.episodeEndEntryId, u2.id);
    assert.deepEqual(second.entries.map((entry) => [entry.entryId, entry.text]), [[u2.id, "AFTER-EMPTY-SEGMENT-4321"]]);
    assert.ok(!second.entries.some((entry) => entry.text.includes("HANDOFF-TEXT")));
    assert.ok(handoff.id < emptyReset.id);
    await source.acknowledge(second, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chunk cut mid-item ends before following entries and resumes without stalling", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-cut-entry-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // The dangerous shape: a long assistant reply overflows the character budget and the next entry
    // is an unpaired, evidence-free tool result. Consuming that result after a cut would put a
    // partially consumed item before the chunk's last item, so acknowledgement would refuse the
    // chunk and the deterministic reader would offer it again forever.
    const [question] = await append(harness, conversation, user("CUT-QUESTION-7741"));
    const long = `CUT-MID-ENTRY-${"m".repeat(250)}`;
    const [longEntry] = await append(harness, conversation, assistant(long));
    const [tool] = await append(harness, conversation, toolResult("CUT-TOOL-OUTPUT-3318", "bash"));
    const [afterUser] = await append(harness, conversation, user("AFTER-CUT-1"));
    const [afterAssistant] = await append(harness, conversation, assistant("FINAL-2"));
    await append(harness, conversation, reset());

    const limits = { entriesPerBatch: 100, charsPerBatch: 100 };
    const source = sourceFor(harness, conversation, limits);
    const batches = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      batches.push(batched(result));
      await source.acknowledge(batches.at(-1), context);
    }
    assert.ok(batches.length >= 3, "the long entry and its follow-up span several chunks");
    const last = batches.at(-1);
    assert.equal(last.complete, true);
    assert.equal(last.throughEntryId, afterAssistant.id);
    assert.deepEqual(
      last.entries.filter((entry) => entry.entryId !== longEntry.id).map((entry) => [entry.entryId, entry.text]),
      [
        [afterUser.id, "AFTER-CUT-1"],
        [afterAssistant.id, "FINAL-2"],
      ],
    );
    const tailFragment = last.entries.find((entry) => entry.entryId === longEntry.id);
    if (tailFragment !== undefined) {
      assert.equal(tailFragment.textStart + tailFragment.text.length, tailFragment.chars, "its tail is whole");
    }
    // A partially consumed item always ends its chunk, and the following unpaired result is consumed
    // without evidence: a chunk cut inside the reply never runs past it into the result body.
    for (const batch of batches) {
      const fragment = batch.entries.find((entry) => entry.entryId === longEntry.id);
      if (fragment === undefined || fragment.textStart + fragment.text.length >= fragment.chars) continue;
      assert.equal(batch.throughEntryId, longEntry.id, "a cut chunk ends on the partially consumed entry");
      assert.equal(batch.complete, false, "a cut chunk never claims the segment end");
    }
    assert.equal(batches.flatMap((batch) => batch.entries)
      .some((entry) => entry.text.includes("CUT-TOOL-OUTPUT")), false, "an unpaired result is not evidence");
    const partial = batches.filter((batch) => batch.entries.some((entry) => entry.entryId === longEntry.id));
    assert.ok(partial.length >= 2, "the long entry continues across chunks");
    assert.equal(itemText(batches, longEntry.id, 0), long, "the whole cut entry is consumed exactly once");
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: afterAssistant.id + 1,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);
    assert.ok(afterUser.id > tool.id && tool.id > longEntry.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch recorded without step positions fails closed instead of acknowledging", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-old-format-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const message = "O".repeat(24_000);
    const [messageEntry] = await append(harness, conversation, user(message));
    await append(harness, conversation, reset());

    const source = sourceFor(harness, conversation);
    const current = batched(await source.read(context));
    assert.equal(current.entries[0].entryId, messageEntry.id);
    const oldStyle = { ...current };
    delete oldStyle.firstItemIndex;
    delete oldStyle.throughItemIndex;
    delete oldStyle.nextEntryId;
    delete oldStyle.nextItemIndex;
    delete oldStyle.nextTextStart;
    await assert.rejects(
      () => source.readBatch(oldStyle, context),
      (error) => error instanceof TypeError,
      "a recorded chunk from the earlier extraction is refused rather than re-derived as different evidence",
    );
    await assert.rejects(
      () => source.acknowledge(oldStyle, context),
      (error) => error instanceof TypeError,
      "an old-format acknowledgement cannot move the frontier",
    );
    assert.deepEqual(await source.cursor(conversation.id, context), current.cursor, "nothing advanced");

    const forgedToolEvidence = {
      ...current,
      entries: [
        current.entries[0],
        {
          entryId: messageEntry.id,
          itemIndex: 1,
          role: "tool",
          kind: "pi.tool-result",
          toolName: "read",
          textStart: 0,
          chars: 10,
          text: "0123456789",
        },
      ],
    };
    await assert.rejects(
      () => source.acknowledge(forgedToolEvidence, context),
      (error) => error instanceof TypeError,
      "evidence that does not match the transcript is refused",
    );
    assert.deepEqual(await source.cursor(conversation.id, context), current.cursor);

    await source.acknowledge(current, context);
    assert.equal((await source.cursor(conversation.id, context)).nextEntryId, messageEntry.id + 1);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a two-entry batch minimum is enforced and always advances past a reset marker", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-entry-minimum-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // The wedge shape for a one-entry batch: the segment opens on a reset marker, which carries no
    // evidence, so a one-entry chunk could only hand back that same zero-offset entry.
    const [openingReset] = await append(harness, conversation, reset());
    const [first] = await append(harness, conversation, user("ENTRY-MIN-FIRST-5512"));
    const [second] = await append(harness, conversation, assistant("ENTRY-MIN-SECOND-8841"));
    const [third] = await append(harness, conversation, user("ENTRY-MIN-THIRD-2296"));
    await append(harness, conversation, reset());

    const limits = { entriesPerBatch: 2, charsPerBatch: 1_000 };
    const sessions = async () => [{ sessionKey: "cli:entry-minimum", conversationId: conversation.id }];
    assert.throws(
      () => createDigestSource({ harness, sessions, limits: { entriesPerBatch: 1, charsPerBatch: 5 } }),
      /entriesPerBatch at least 2 and charsPerBatch at least 2/,
    );
    const source = createDigestSource({ harness, sessions, limits });
    await assert.rejects(
      () => source.read(context, { entriesPerBatch: 1, charsPerBatch: 5 }),
      /entriesPerBatch at least 2 and charsPerBatch at least 2/,
    );
    const emptyCursor = {
      nextEntryId: null,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    };
    assert.deepEqual(await source.cursor(conversation.id, context), emptyCursor);
    await assert.rejects(
      () => source.acknowledge({
        status: "batch",
        sessionKey: "cli:entry-minimum",
        conversationId: conversation.id,
        episodeStartEntryId: openingReset.id,
        episodeEndEntryId: third.id,
        firstEntryId: openingReset.id,
        firstItemIndex: 0,
        firstTextStart: 0,
        throughEntryId: first.id,
        throughItemIndex: 0,
        throughChars: "ENTRY-MIN-FIRST-5512".length,
        nextEntryId: second.id,
        nextItemIndex: 0,
        nextTextStart: 0,
        complete: false,
        entries: [],
        cursor: emptyCursor,
      }, context, { entriesPerBatch: 1, charsPerBatch: 5 }),
      /entriesPerBatch at least 2 and charsPerBatch at least 2/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), emptyCursor);

    const batches = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      batches.push(batched(result));
      await source.acknowledge(batches.at(-1), context);
    }
    assert.deepEqual(batches.map((batch) => batch.entries.map((entry) => entry.text)), [
      ["ENTRY-MIN-FIRST-5512"],
      ["ENTRY-MIN-SECOND-8841"],
      ["ENTRY-MIN-THIRD-2296"],
    ], "every chunk advances the frontier and nothing repeats");
    assert.equal(batches[0].episodeStartEntryId, openingReset.id);
    assert.deepEqual(batches.map((batch) => batch.complete), [false, true, true]);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      nextEntryId: third.id + 1,
      nextItemIndex: 0,
      nextTextStart: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
      pendingToolCalls: [],
    });
    assert.ok(openingReset.id < first.id && second.id < third.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long entry is delivered losslessly across batches and its tail cannot be acked away", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-long-entry-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const long = `LONG-ENTRY-${"abcdefghij".repeat(60_000)}`;
    const [longEntry] = await append(harness, conversation, user(long));
    await append(harness, conversation, reset());
    const source = sourceFor(harness, conversation);

    const batches = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      const batch = batched(result);
      const fragment = batch.entries.find((entry) => entry.entryId === longEntry.id);
      assert.ok(fragment !== undefined, "each batch continues the long entry");
      assert.equal(fragment.chars, long.length);
      batches.push(batch);
      await source.acknowledge(batch, context);
    }
    assert.ok(batches.length >= 2, `expected several batches for one long entry, got ${batches.length}`);
    assert.equal(batches.at(-1).complete, true);
    assert.equal(itemText(batches, longEntry.id, 0), long, "every character of the long entry is consumed");

    // A forged fragment that pretends the entry ended early must be refused, not acked away.
    const second = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [secondLong] = await append(harness, second, user(long));
    await append(harness, second, reset());
    const secondSource = sourceFor(harness, second);
    const secondFirst = batched(await secondSource.read(context));
    const fragment = secondFirst.entries[0];
    assert.equal(fragment.entryId, secondLong.id);
    assert.equal(fragment.text.length, DIGEST_LIMITS.charsPerBatch);
    assert.equal(fragment.chars, long.length);
    await assert.rejects(
      () => secondSource.acknowledge({
        ...secondFirst,
        entries: [{ ...fragment, chars: fragment.text.length }],
        complete: false,
        throughChars: fragment.text.length,
        nextEntryId: secondFirst.throughEntryId,
        nextItemIndex: secondFirst.throughItemIndex,
        nextTextStart: fragment.text.length,
      }, context),
      (error) => error instanceof TypeError && /does not match the committed transcript/.test(error.message),
      "a claimed early end loses the tail and is refused",
    );
    assert.deepEqual(await secondSource.cursor(second.id, context), secondFirst.cursor);
    assert.deepEqual(batched(await secondSource.read(context)), secondFirst);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh partial batch cannot persist an unverified or cross-reset end", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-bounds-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [oneUser] = await append(harness, conversation, user("BOUNDS-ONE-1234"));
    const [oneAnswer] = await append(harness, conversation, assistant("BOUNDS-ANSWER-5678"));
    const [firstReset] = await append(harness, conversation, reset());
    const [twoUser] = await append(harness, conversation, user("BOUNDS-TWO-9012"));
    const [twoAnswer] = await append(harness, conversation, assistant("BOUNDS-TWO-ANSWER-3456"));
    const [secondReset] = await append(harness, conversation, reset());
    const [threeUser] = await append(harness, conversation, user("BOUNDS-THREE-7890"));
    const [threeAnswer] = await append(harness, conversation, assistant("BOUNDS-THREE-ANSWER-2345"));
    await append(harness, conversation, reset());
    const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [otherUser] = await append(harness, other, user("BOUNDS-OTHER-6789"));
    const [otherAnswer] = await append(harness, other, assistant("BOUNDS-OTHER-ANSWER-1234"));
    await append(harness, other, reset());

    const source = sourcesFor(harness, [
      { key: "cli:bounds", conversation },
      { key: "telegram:bounds", conversation: other },
    ]);
    const first = batched(await source.read(context));
    assert.deepEqual(first.entries.map((entry) => entry.text), ["BOUNDS-ONE-1234", "BOUNDS-ANSWER-5678"]);
    await source.acknowledge(first, context);
    const frontier = await source.cursor(conversation.id, context);
    const forged = (patch) => ({
      status: "batch",
      sessionKey: "cli:bounds",
      conversationId: conversation.id,
      episodeStartEntryId: firstReset.id,
      episodeEndEntryId: firstReset.id,
      firstEntryId: firstReset.id,
      firstItemIndex: 0,
      firstTextStart: 0,
      throughEntryId: firstReset.id,
      throughItemIndex: -1,
      throughChars: 0,
      nextEntryId: firstReset.id + 1,
      nextItemIndex: 0,
      nextTextStart: 0,
      complete: false,
      entries: [],
      cursor: frontier,
      ...patch,
    });

    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: 10_000_000 }), context),
      (error) => error instanceof TypeError,
      "an end beyond the transcript is refused",
    );
    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: firstReset.id, complete: true, throughEntryId: firstReset.id }), context),
      (error) => error instanceof TypeError,
      "a reset-only segment is refused",
    );
    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: threeAnswer.id }), context),
      (error) => error instanceof TypeError,
      "an end that spans an earlier reset is refused",
    );
    assert.deepEqual(await source.cursor(conversation.id, context), frontier);

    // Both chats stay consumable after the rejections; the poisoned bounds never persisted.
    const seen = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") {
        assert.equal(result.caughtUp, true);
        break;
      }
      const batch = batched(result);
      seen.push([batch.sessionKey, batch.episodeStartEntryId, batch.entries.map((entry) => entry.text)]);
      await source.acknowledge(batch, context);
    }
    assert.deepEqual(seen, [
      ["cli:bounds", firstReset.id, ["BOUNDS-TWO-9012", "BOUNDS-TWO-ANSWER-3456"]],
      ["cli:bounds", secondReset.id, ["BOUNDS-THREE-7890", "BOUNDS-THREE-ANSWER-2345"]],
      ["telegram:bounds", otherUser.id, ["BOUNDS-OTHER-6789", "BOUNDS-OTHER-ANSWER-1234"]],
    ]);
    assert.ok(oneUser.id < oneAnswer.id && twoUser.id > firstReset.id && threeUser.id > twoAnswer.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh start beyond the verification bound is refused loudly and skips nothing", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-gap-bound-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("GAP-FIRST-1100"));
    const [firstAnswer] = await append(harness, conversation, assistant("GAP-FIRST-ANSWER-2200"));
    await harness.commit(async (tx) => {
      for (let index = 0; index < DIGEST_LIMITS.scanEntriesPerRead + 1; index += 1) {
        await tx.appendEntry(conversation.id, reset());
      }
    }, context);
    const [secondQuestion] = await append(harness, conversation, user("GAP-SECOND-3300"));
    const [secondAnswer] = await append(harness, conversation, assistant("GAP-SECOND-ANSWER-4400"));

    const source = sourceFor(harness, conversation);
    const first = batched(await source.read(context));
    assert.equal(first.throughEntryId, firstAnswer.id);
    await source.acknowledge(first, context);
    const frontier = await source.cursor(conversation.id, context);

    // A forged fresh start claims the later segment while the frontier is still far below it: the
    // skipped range holds far more entries than one bounded verification read may examine.
    const forged = {
      status: "batch",
      sessionKey: "cli:digest",
      conversationId: conversation.id,
      episodeStartEntryId: secondQuestion.id,
      episodeEndEntryId: secondAnswer.id,
      firstEntryId: secondQuestion.id,
      firstItemIndex: 0,
      firstTextStart: 0,
      throughEntryId: secondAnswer.id,
      throughItemIndex: 0,
      throughChars: "GAP-SECOND-ANSWER-4400".length,
      nextEntryId: secondAnswer.id + 1,
      nextItemIndex: 0,
      nextTextStart: 0,
      complete: true,
      entries: [],
      cursor: frontier,
    };
    await assert.rejects(
      () => source.acknowledge(forged, context),
      (error) => error instanceof TypeError && /too far from its cursor to verify/.test(error.message),
    );
    assert.deepEqual(await source.cursor(conversation.id, context), frontier);
    // The refusal is loud and nothing was skipped: the long range is still pending and the next
    // bounded read continues it from the same frontier instead of jumping over it.
    let resumed = false;
    for (let index = 0; index < 3; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") {
        assert.equal(result.unfinishedChats, 1, "the bounded scan reports the range as unfinished");
        continue;
      }
      assert.equal(result.status, "batch");
      assert.equal(result.episodeStartEntryId, frontier.nextEntryId, "the scan resumes at the frontier");
      resumed = true;
      break;
    }
    assert.equal(resumed, true, "the skipped range is still offered, never silently dropped");
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcript projections share one user-input kind set, including cron input", async () => {
  const { CRON_INPUT_ENTRY_KIND } = await load(`${pkg}/dist/automation/cron.js`);
  const transcript = await load(`${pkg}/dist/history/transcript.js`);
  const { renderEntry } = await load(`${pkg}/dist/history/summary-source.js`);
  const { projectEntry } = await load(`${pkg}/dist/memory/history-source.js`);
  const { browsedEntry } = await load(`${pkg}/dist/history/entry-view.js`);
  const digestion = await load(`${pkg}/dist/history/digestion.js`);

  assert.deepEqual([...transcript.USER_INPUT_ENTRY_KINDS].sort(), [CRON_INPUT_ENTRY_KIND, "pi.user"].sort());
  // The digestion re-exports are the shared implementations, not copies.
  assert.equal(digestion.clipPreview, transcript.clipPreview);
  assert.equal(digestion.COMPACT_PREVIEW_MARKER, transcript.COMPACT_PREVIEW_MARKER);
  assert.equal(DIGEST_PREVIEW_CHARS, transcript.PREVIEW_CHARS);

  const cron = {
    id: 7,
    kind: CRON_INPUT_ENTRY_KIND,
    model: [{ role: "user", content: [{ type: "text", text: "daily check" }, { type: "image", data: "x" }], timestamp: 1_000 }],
  };
  assert.equal(renderEntry(cron).text, "[User]: daily check");
  assert.equal(renderEntry(cron).message, true);
  assert.deepEqual(projectEntry(cron).parts.map((part) => [part.role, part.body]), [["user", "daily check"]]);
  assert.equal(browsedEntry(cron, "messages", 100)?.label, "user (cron)");
  assert.equal(digestion.evidenceShapeOf(cron)?.role, "user");

  const unknown = { ...cron, kind: "nanobot.unknown" };
  assert.equal(renderEntry(unknown).text, "");
  assert.equal(projectEntry(unknown).parts.length, 0);
  assert.equal(digestion.evidenceShapeOf(unknown), undefined);
});

test("mutating readClosed() or readBatch() evidence cannot poison the cached chunk", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-cache-isolation-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const longOutput = `${"A".repeat(400)}${"B".repeat(2_000)}${"C".repeat(400)}`;
    await append(harness, conversation, user("CACHE-ISOLATION-USER"));
    await append(harness, conversation, toolCallAssistant("", "call-cache-1", "read", { path: "notes.md" }));
    await append(harness, conversation, toolResult(longOutput, "call-cache-1", "read"));
    await append(harness, conversation, assistant("CACHE-ISOLATION-ANSWER"));
    await append(harness, conversation, reset());

    const source = sourceFor(harness, conversation);
    const first = batched(await source.readClosed(context, undefined, undefined, { estimate: false }));
    const originalTexts = first.entries.map((entry) => entry.text);
    const previewIndex = first.entries.findIndex((entry) => entry.preview !== null);
    assert.ok(previewIndex >= 0, "fixture includes a previewed tool result");
    const originalMarker = first.entries[previewIndex].preview.marker;

    // Mutate the batch returned by readClosed() in place (text, preview metadata, and array length).
    first.entries[0].text = "TAMPERED-FROM-READ-CLOSED";
    first.entries[previewIndex].preview.marker = "TAMPERED-MARKER";
    first.entries.push({ ...first.entries[0], text: "EXTRA-ENTRY" });

    // readBatch() hits the cached chunk and must return pristine, isolated evidence.
    const second = await source.readBatch(first, context);
    assert.deepEqual(second.entries.map((entry) => entry.text), originalTexts);
    assert.equal(second.entries[previewIndex].preview.marker, originalMarker);

    // Mutating readBatch()'s output must also leave subsequent cached reads untouched.
    second.entries[0].text = "TAMPERED-FROM-READ-BATCH";
    second.entries[previewIndex].preview.marker = "TAMPERED-MARKER-2";
    const third = await source.readBatch(first, context);
    assert.deepEqual(third.entries.map((entry) => entry.text), originalTexts);
    assert.equal(third.entries[previewIndex].preview.marker, originalMarker);

    await assert.rejects(() => source.acknowledge(first, context), TypeError);
    await source.acknowledge(third, context);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
