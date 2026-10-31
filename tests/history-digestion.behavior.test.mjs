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
const { createDigestSource, DigestCursorConflictError, DIGEST_LIMITS } = await load(
  `${pkg}/dist/history/digestion.js`,
);
const { createModels, fauxAssistantMessage } = await load(`${ai}/index.js`);
const { BACKGROUND_CONTEXT } = await load(`${chord}/context/index.js`);
const context = BACKGROUND_CONTEXT;

const temp = (prefix) => mkdtemp(resolve(tmpdir(), prefix));

async function openStore(dbPath) {
  const storage = await openFullSyncNodeSqliteStorage(dbPath, context);
  return Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
}

function user(text, timestamp = 1_000) {
  return { kind: "pi.user", model: [{ role: "user", content: text, timestamp }] };
}
function assistant(text) {
  return { kind: "pi.assistant", model: [fauxAssistantMessage(text)] };
}
function toolResult(text, toolName = "read") {
  return {
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      toolCallId: "call-1",
      toolName,
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
function system(text = "") {
  return { kind: "pi.system", model: [{ role: "system", content: text, timestamp: 1_000 }] };
}

async function append(harness, conversation, ...drafts) {
  return harness.commit(async (tx) => {
    const appended = [];
    for (const draft of drafts) appended.push(await tx.appendEntry(conversation.id, draft));
    return appended;
  }, context);
}

/** Latest handle of one conversation. */
async function conversationOf(harness, conversation) {
  return harness.conversation(conversation.id, context);
}

function batched(result) {
  assert.equal(result.status, "batch", "expected a digest batch");
  return result;
}

function idle(result) {
  assert.equal(result.status, "idle", "expected a digest idle report");
  return result;
}

function evidenceChars(batch) {
  return batch.entries.reduce((total, entry) => total + entry.text.length, 0);
}

/** Every fragment of one entry across batches, as `[textStart, text]` pairs. */
function fragmentsOf(batches, entryId) {
  return batches.flatMap((batch) => batch.entries
    .filter((entry) => entry.entryId === entryId)
    .map((entry) => [entry.textStart, entry.text]));
}

async function drain(source, limit = 40) {
  const batches = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await source.read(context);
    if (result.status === "idle") return { batches, idle: result };
    const batch = batched(result);
    assert.ok(evidenceChars(batch) <= DIGEST_LIMITS.charsPerBatch, "batch evidence stays within its bound");
    batches.push(batch);
    await source.acknowledge(batch, context);
  }
  throw new Error(`digest did not settle after ${limit} batches`);
}

test("digest reads closed episodes oldest first and never the open tail", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-basic-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [u1] = await append(harness, conversation, user("FIRST-QUESTION-8812"));
    const [a1] = await append(harness, conversation, assistant("FIRST-ANSWER-3391"));
    await append(harness, conversation, reset("SYNTHETIC-HANDOFF-4470"));
    const [u2] = await append(harness, conversation, user("SECOND-QUESTION-6619"));
    const [a2, tool] = await append(harness, conversation, assistant("SECOND-ANSWER-1184"), toolResult("TOOL-OUTPUT-5523"));
    await append(harness, conversation, reset());
    await append(harness, conversation, user("STILL-OPEN-7701"), assistant("OPEN-ANSWER-9080"));

    const handle = await conversationOf(harness, conversation);
    assert.ok(handle !== undefined);
    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:digest", conversationId: conversation.id }],
    });
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: null,
      throughChars: null,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });

    const first = batched(await source.read(context));
    assert.equal(first.sessionKey, "cli:digest");
    assert.equal(first.conversationId, conversation.id);
    assert.equal(first.episodeStartEntryId, u1.id);
    assert.equal(first.episodeEndEntryId, a1.id);
    assert.equal(first.firstEntryId, u1.id);
    assert.equal(first.firstTextStart, 0);
    assert.equal(first.throughEntryId, a1.id);
    assert.equal(first.complete, true);
    assert.deepEqual(first.entries.map((entry) => [entry.entryId, entry.role, entry.textStart, entry.chars, entry.text]), [
      [u1.id, "user", 0, "FIRST-QUESTION-8812".length, "FIRST-QUESTION-8812"],
      [a1.id, "assistant", 0, "FIRST-ANSWER-3391".length, "FIRST-ANSWER-3391"],
    ]);

    // Reading again before acknowledging is stable: nothing advanced.
    assert.deepEqual(await source.read(context), first);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, null);

    await source.acknowledge(first, context);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: a1.id,
      throughChars: "FIRST-ANSWER-3391".length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });

    const second = batched(await source.read(context));
    assert.equal(second.episodeEndEntryId, tool.id);
    assert.equal(second.complete, true);
    // The episode starts at its reset marker; the reset marker itself is not evidence.
    assert.ok(second.episodeStartEntryId > a1.id && second.episodeStartEntryId < u2.id);
    // The whole episode is one batch: the trailing tool result is covered and consumes no evidence.
    assert.deepEqual(second.entries.map((entry) => [entry.entryId, entry.role]), [
      [u2.id, "user"],
      [a2.id, "assistant"],
    ]);
    assert.deepEqual(second.entries.map((entry) => entry.text), ["SECOND-QUESTION-6619", "SECOND-ANSWER-1184"]);
    assert.equal(second.throughEntryId, tool.id, "the tool result entry is consumed, never its text");
    await source.acknowledge(second, context);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, tool.id);

    // The still-open segment is never evidence, however often it is read.
    const settled = idle(await source.read(context));
    assert.equal(settled.caughtUp, true);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest skips reset-only segments and never returns reset handoff text", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-handoff-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [u1] = await append(harness, conversation, user("BEFORE-HANDOFF-1234"));
    const [handoff] = await append(harness, conversation, reset("HANDOFF-TEXT-MUST-NOT-BE-EVIDENCE-9999"));
    // Two consecutive resets: the segment after the handoff reset holds no content entry.
    const [emptyReset] = await append(harness, conversation, reset());
    const [u2] = await append(harness, conversation, user("AFTER-EMPTY-SEGMENT-4321"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "telegram:1", conversationId: conversation.id }],
    });

    const first = batched(await source.read(context));
    assert.equal(first.episodeStartEntryId, u1.id);
    assert.equal(first.episodeEndEntryId, u1.id);
    assert.deepEqual(first.entries.map((entry) => entry.text), ["BEFORE-HANDOFF-1234"]);
    await source.acknowledge(first, context);

    const second = batched(await source.read(context));
    assert.equal(second.episodeStartEntryId, emptyReset.id);
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

test("an episode over the entry cap is consumed in ordered independent chunks", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-chunks-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [segmentReset] = await append(harness, conversation, reset());
    // One commit: the point is the entry bound, not per-entry write cost.
    const appended = await harness.commit(async (tx) => {
      const entries = [];
      for (let index = 0; index < DIGEST_LIMITS.entriesPerBatch + 5; index += 1) {
        entries.push(await tx.appendEntry(conversation.id, user(`CHUNK-EVIDENCE-${index}`)));
      }
      return entries;
    }, context);
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:chunks", conversationId: conversation.id }],
    });
    const { batches } = await drain(source);
    assert.ok(batches.length >= 2, `expected the entry cap to split the episode, got ${batches.length}`);
    assert.equal(batches[0].episodeStartEntryId, segmentReset.id);
    assert.equal(batches[0].firstEntryId, segmentReset.id);
    let entry = segmentReset.id - 1;
    let chars = 0;
    for (const [index, batch] of batches.entries()) {
      assert.equal(batch.episodeStartEntryId, segmentReset.id);
      assert.equal(batch.episodeEndEntryId, appended.at(-1).id);
      if (batch.firstEntryId === entry) {
        assert.equal(batch.firstTextStart, chars);
      } else {
        assert.ok(batch.firstEntryId > entry);
        assert.equal(batch.firstTextStart, 0);
      }
      assert.equal(batch.complete, index === batches.length - 1);
      const ids = batch.entries.map((fragment) => fragment.entryId);
      assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
      if (batch.entries.length > 0) {
        const last = batch.entries.at(-1);
        entry = last.entryId;
        chars = last.textStart + last.text.length;
      }
    }
    const evidence = batches.flatMap((batch) => batch.entries
      .filter((fragment) => fragment.role === "user")
      .map((fragment) => fragment.text));
    assert.deepEqual(evidence, appended.map((_, index) => `CHUNK-EVIDENCE-${index}`));
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: appended.at(-1).id,
      throughChars: `CHUNK-EVIDENCE-${appended.length - 1}`.length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("an episode under both caps is read as one complete batch and acknowledged once", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-whole-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [segmentReset] = await append(harness, conversation, reset());
    // A long ordinary episode: far more entries than the old 80-entry batch, still one pass.
    const count = 1_500;
    const appended = await harness.commit(async (tx) => {
      const entries = [];
      for (let index = 0; index < count; index += 1) {
        entries.push(await tx.appendEntry(conversation.id, user(`WHOLE-EPISODE-${index}-${"x".repeat(90)}`)));
      }
      return entries;
    }, context);
    await append(harness, conversation, reset());
    assert.ok(count < DIGEST_LIMITS.entriesPerBatch, "the entry cap is not what splits this episode");
    assert.ok(count * 110 < DIGEST_LIMITS.charsPerBatch, "the character bound is not reached either");

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:whole", conversationId: conversation.id }],
    });
    const batch = batched(await source.read(context));
    assert.equal(batch.complete, true, "the whole episode arrives in one complete batch");
    assert.equal(batch.episodeStartEntryId, segmentReset.id);
    assert.equal(batch.episodeEndEntryId, appended.at(-1).id);
    assert.equal(batch.entries.length, count, "every message is in that one batch");
    assert.deepEqual(batch.cursor, {
      throughEntryId: null,
      throughChars: null,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.ok(evidenceChars(batch) <= DIGEST_LIMITS.charsPerBatch);

    // One acknowledgement consumes it: no chunk continuation state is left behind.
    assert.deepEqual(await source.acknowledge(batch, context), {
      throughEntryId: appended.at(-1).id,
      throughChars: batch.entries.at(-1).text.length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);

    // Exactly at the character bound, with trailing tool output: still one complete batch,
    // because the budget only closes a chunk at an entry that still carries evidence.
    const capped = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const exact = "E".repeat(DIGEST_LIMITS.charsPerBatch);
    const [exactMessage] = await append(harness, capped, user(exact));
    const [trailingTool] = await append(harness, capped, toolResult("TRAILING-TOOL-OUTPUT-5540", "bash"));
    await append(harness, capped, reset());
    const cappedSource = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:whole-capped", conversationId: capped.id }],
    });
    const cappedBatch = batched(await cappedSource.read(context));
    assert.equal(cappedBatch.complete, true, "an exact-bound episode is still one pass");
    assert.deepEqual(cappedBatch.entries.map((fragment) => [fragment.entryId, fragment.text.length]), [
      [exactMessage.id, DIGEST_LIMITS.charsPerBatch],
    ]);
    assert.equal(cappedBatch.throughEntryId, trailingTool.id, "the trailing tool result rides along");
    assert.equal(cappedBatch.throughChars, 0);
    await cappedSource.acknowledge(cappedBatch, context);
    assert.equal(idle(await cappedSource.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("an episode over the character cap splits into ordered independent chunks with no loss", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-char-cap-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [segmentReset] = await append(harness, conversation, reset());
    const messages = ["A", "B", "C"].map((letter) => `${letter}-${letter.repeat(150_000 - 2)}`);
    const appended = [];
    for (const message of messages) appended.push(...await append(harness, conversation, user(message)));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:char-cap", conversationId: conversation.id }],
    });
    const { batches } = await drain(source);
    assert.ok(batches.length >= 2, `expected the character cap to split the episode, got ${batches.length}`);
    for (const [index, batch] of batches.entries()) {
      assert.equal(batch.episodeStartEntryId, segmentReset.id);
      assert.equal(batch.episodeEndEntryId, appended.at(-1).id);
      assert.equal(batch.complete, index === batches.length - 1, "only the last chunk reaches the episode end");
      assert.ok(evidenceChars(batch) <= DIGEST_LIMITS.charsPerBatch, "each chunk respects the shared bound");
      const ids = batch.entries.map((fragment) => fragment.entryId);
      assert.deepEqual(ids, [...ids].sort((left, right) => left - right), "fragments stay in transcript order");
    }
    // Independent chunks: every chunk starts where the previous one stopped, each fragment is
    // contiguous within its entry, and the three messages rebuild exactly once, in order.
    const rebuilt = messages.map(() => "");
    const offsets = messages.map(() => 0);
    for (const batch of batches) {
      for (const fragment of batch.entries) {
        const index = appended.findIndex((entry) => entry.id === fragment.entryId);
        assert.equal(fragment.textStart, offsets[index], "no gap and no overlap between chunks");
        assert.equal(fragment.chars, messages[index].length);
        offsets[index] += fragment.text.length;
        rebuilt[index] += fragment.text;
      }
    }
    assert.deepEqual(rebuilt, messages, "every character is consumed exactly once");
    assert.deepEqual(offsets, messages.map((message) => message.length));
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: appended.at(-1).id,
      throughChars: messages.at(-1).length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chunk cut mid-entry ends before following tool output and resumes without stalling", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-cut-entry-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // The dangerous shape: a long assistant reply overflows the character budget and the very next
    // entry is its evidence-free tool result. Consuming that tool result after a cut would put a
    // partially consumed entry before the chunk's last entry, so acknowledgement would refuse the
    // chunk and the deterministic reader would offer it again forever.
    const long = `CUT-MID-ENTRY-${"m".repeat(250)}`;
    const [longEntry] = await append(harness, conversation, assistant(long));
    const [tool] = await append(harness, conversation, toolResult("CUT-TOOL-OUTPUT-3318", "bash"));
    const [afterUser] = await append(harness, conversation, user("AFTER-CUT-1"));
    const [afterAssistant] = await append(harness, conversation, assistant("FINAL-2"));
    await append(harness, conversation, reset());

    const limits = { entriesPerBatch: 100, charsPerBatch: 100 };
    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:cut-entry", conversationId: conversation.id }],
      limits,
    });

    const first = batched(await source.read(context));
    assert.equal(first.complete, false);
    assert.equal(first.throughEntryId, longEntry.id, "the cut entry ends the chunk, before its tool result");
    assert.equal(first.throughChars, 100);
    assert.deepEqual(first.entries.map((fragment) => [fragment.entryId, fragment.chars]), [[longEntry.id, long.length]]);
    await source.acknowledge(first, context);

    // The chunk that used to livelock: it still ends on the cut entry, so it is acknowledgeable.
    const second = batched(await source.read(context));
    assert.equal(second.episodeStartEntryId, first.episodeStartEntryId);
    assert.equal(second.firstEntryId, longEntry.id);
    assert.equal(second.firstTextStart, 100);
    assert.equal(second.throughEntryId, longEntry.id);
    assert.equal(second.throughChars, 200);
    assert.equal(second.complete, false);
    await source.acknowledge(second, context);

    const third = batched(await source.read(context));
    assert.equal(third.firstEntryId, longEntry.id);
    assert.equal(third.firstTextStart, 200);
    assert.equal(third.complete, true, "the tail of the cut entry, its tool result and the rest fit one chunk");
    assert.equal(third.throughEntryId, afterAssistant.id);
    assert.deepEqual(third.entries.filter((fragment) => fragment.role === "user").map((fragment) => fragment.text), [
      "AFTER-CUT-1",
    ]);
    assert.equal(third.entries.some((fragment) => fragment.text.includes("CUT-TOOL-OUTPUT")), false);
    await source.acknowledge(third, context);

    // The long reply rebuilds exactly once, in order, and the cursor settles on the last entry.
    const batches = [first, second, third];
    const pieces = fragmentsOf(batches, longEntry.id);
    let offset = 0;
    let rebuilt = "";
    for (const [textStart, text] of pieces) {
      assert.equal(textStart, offset, "fragments are contiguous across chunks");
      offset += text.length;
      rebuilt += text;
    }
    assert.equal(rebuilt, long, "the whole cut entry is consumed exactly once");
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: afterAssistant.id,
      throughChars: "FINAL-2".length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);
    assert.ok(afterUser.id > tool.id && tool.id > longEntry.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool results and tool calls are consumed without contributing evidence", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-tool-heavy-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [question] = await append(harness, conversation, user("OWNER-QUESTION-4417"));
    // Backend traffic that would dominate the batch if tool output were evidence: 40 results of
    // 5,000 characters each, twice the character bound together.
    const toolTexts = [];
    for (let index = 0; index < 40; index += 1) {
      const text = `TOOL-OUTPUT-${index}-${"z".repeat(5_000)}`;
      toolTexts.push(text);
      await append(harness, conversation, toolResult(text, "bash"));
    }
    const [answer] = await append(harness, conversation, assistant("OWNER-ANSWER-8825"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:tool-heavy", conversationId: conversation.id }],
    });
    const batch = batched(await source.read(context));
    assert.equal(batch.complete, true, "tool output cannot push one episode over the character bound");
    assert.deepEqual(batch.entries.map((fragment) => [fragment.entryId, fragment.role]), [
      [question.id, "user"],
      [answer.id, "assistant"],
    ]);
    assert.deepEqual(batch.entries.map((fragment) => fragment.text), ["OWNER-QUESTION-4417", "OWNER-ANSWER-8825"]);
    assert.equal(batch.entries.some((fragment) => toolTexts.some((text) => fragment.text.includes(text))), false);
    // Cursor progress is unchanged: the range is covered to its last entry, with no offset in a
    // non-evidence entry, so nothing is skipped and nothing is counted twice.
    assert.equal(batch.throughEntryId, answer.id);
    await source.acknowledge(batch, context);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: answer.id,
      throughChars: "OWNER-ANSWER-8825".length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });

    // An episode ending inside tool output is complete at that entry with a zero offset.
    const second = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [secondQuestion] = await append(harness, second, user("SECOND-QUESTION-1173"));
    const [secondTool] = await append(harness, second, toolResult("SECOND-TOOL-OUTPUT-6619", "read"));
    await append(harness, second, reset());
    const secondSource = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:tool-heavy-second", conversationId: second.id }],
    });
    const secondBatch = batched(await secondSource.read(context));
    assert.equal(secondBatch.complete, true);
    assert.deepEqual(secondBatch.entries.map((fragment) => fragment.text), ["SECOND-QUESTION-1173"]);
    assert.equal(secondBatch.throughEntryId, secondTool.id);
    assert.equal(secondBatch.throughChars, 0);
    assert.deepEqual(await secondSource.acknowledge(secondBatch, context), {
      throughEntryId: secondTool.id,
      throughChars: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });

    // A tool-result-only episode is an acknowledgeable no-op, not skipped evidence.
    const third = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [onlyTool] = await append(harness, third, toolResult("ONLY-TOOL-OUTPUT-2084", "bash"));
    await append(harness, third, reset());
    const thirdSource = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:tool-only", conversationId: third.id }],
    });
    const thirdBatch = batched(await thirdSource.read(context));
    assert.deepEqual(thirdBatch.entries, []);
    assert.equal(thirdBatch.complete, true);
    await thirdSource.acknowledge(thirdBatch, context);
    assert.equal((await thirdSource.cursor(third.id, context)).throughEntryId, onlyTool.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool-result acknowledgement is refused when it claims tool text or its offset", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-tool-forged-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [question] = await append(harness, conversation, user("FORGED-QUESTION-7731"));
    const toolText = "FORGED-TOOL-OUTPUT-9934";
    const [tool] = await append(harness, conversation, toolResult(toolText, "read"));
    const [answer] = await append(harness, conversation, assistant("FORGED-ANSWER-2265"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:tool-forged", conversationId: conversation.id }],
    });
    const batch = batched(await source.read(context));
    const empty = {
      throughEntryId: null,
      throughChars: null,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    };
    const userFragment = batch.entries.find((fragment) => fragment.entryId === question.id);
    const answerFragment = batch.entries.find((fragment) => fragment.entryId === answer.id);
    assert.ok(userFragment !== undefined && answerFragment !== undefined);
    const forged = (patch) => ({
      status: "batch",
      sessionKey: "cli:tool-forged",
      conversationId: conversation.id,
      episodeStartEntryId: question.id,
      episodeEndEntryId: answer.id,
      firstEntryId: question.id,
      firstTextStart: 0,
      throughEntryId: answer.id,
      throughChars: answerFragment.text.length,
      complete: true,
      entries: [userFragment, answerFragment],
      cursor: empty,
      ...patch,
    });

    // Presenting a tool result's text as evidence is refused: the selection has no tool role.
    await assert.rejects(
      () => source.acknowledge(forged({
        entries: [
          userFragment,
          { entryId: tool.id, role: "assistant", kind: "pi.tool-result", textStart: 0, chars: toolText.length, text: toolText },
          answerFragment,
        ],
      }), context),
      /tool is invalid|already consumed entry|does not match/,
    );
    // Honest evidence list, but a through offset that counts the removed tool text.
    await assert.rejects(
      () => source.acknowledge(forged({ throughChars: toolText.length }), context),
      /through offset/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), empty);

    // The real chunk is still exactly what the reader offers, and it acknowledges cleanly.
    assert.deepEqual(batched(await source.read(context)), batch);
    await source.acknowledge(batch, context);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, answer.id);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recorded batch from the old selection fails closed instead of acknowledging", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-old-format-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // The old build split at exactly 24,000 evidence characters, so this message filled one chunk
    // and the trailing tool result started the next one.
    const message = "O".repeat(24_000);
    const [messageEntry] = await append(harness, conversation, user(message));
    const toolText = "OLD-FORMAT-TOOL-OUTPUT-7702";
    const [tool] = await append(harness, conversation, toolResult(toolText, "read"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:old-format", conversationId: conversation.id }],
    });
    const oldLimits = { entriesPerBatch: 80, charsPerBatch: 24_000 };
    // Under today's selection the message no longer fills the old character bound, so the recorded
    // old chunk (cut at the message, not complete) cannot be re-derived and is refused.
    const current = batched(await source.read(context, oldLimits));
    assert.equal(current.complete, true, "message and trailing tool result are one pass now");
    assert.equal(current.throughEntryId, tool.id);
    const oldRef = {
      sessionKey: current.sessionKey,
      conversationId: current.conversationId,
      episodeStartEntryId: current.episodeStartEntryId,
      episodeEndEntryId: current.episodeEndEntryId,
      firstEntryId: current.firstEntryId,
      firstTextStart: 0,
      throughEntryId: messageEntry.id,
      throughChars: 24_000,
      complete: false,
      cursor: current.cursor,
    };
    await assert.rejects(
      () => source.readBatch(oldRef, context, oldLimits),
      /no longer matches/,
      "an old recorded chunk is refused rather than silently re-derived as a different chunk",
    );

    // A recorded old-format evidence object (tool role, tool name) is not acknowledged wrongly.
    await assert.rejects(
      () => source.acknowledge({
        ...current,
        entries: [
          current.entries[0],
          { entryId: tool.id, role: "tool", kind: "pi.tool-result", toolName: "read", textStart: 0, chars: toolText.length, text: toolText },
        ],
      }, context),
      /role is invalid/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), oldRef.cursor, "nothing advanced");

    // The honest current chunk still acknowledges cleanly.
    assert.deepEqual(batched(await source.read(context)), current);
    await source.acknowledge(current, context);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, tool.id);
    assert.equal(idle(await source.read(context)).caughtUp, true);
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
    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:long", conversationId: conversation.id }],
    });

    const batches = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      const batch = batched(result);
      assert.ok(evidenceChars(batch) <= DIGEST_LIMITS.charsPerBatch);
      const fragment = batch.entries.find((entry) => entry.entryId === longEntry.id);
      assert.ok(fragment !== undefined, "each batch continues the long entry");
      assert.equal(fragment.chars, long.length);
      batches.push(batch);
      await source.acknowledge(batch, context);
    }
    assert.ok(batches.length >= 3, `expected several batches for one long entry, got ${batches.length}`);
    assert.equal(batches.at(-1).complete, true);
    assert.equal(batches.at(-1).throughChars, long.length);
    const fragments = fragmentsOf(batches, longEntry.id);
    let offset = 0;
    let rebuilt = "";
    for (const [textStart, text] of fragments) {
      assert.equal(textStart, offset, "fragments are contiguous");
      offset += text.length;
      rebuilt += text;
    }
    assert.equal(rebuilt, long, "every character of the long entry is consumed");
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: longEntry.id,
      throughChars: long.length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });

    // A forged fragment that pretends the entry ended early must be refused, not acked away.
    const second = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [secondLong] = await append(harness, second, user(long));
    await append(harness, second, reset());
    const secondSource = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:long-second", conversationId: second.id }],
    });
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
      }, context),
      /length does not match/,
    );
    assert.equal((await secondSource.cursor(second.id, context)).throughEntryId, null);
    // The untouched chunk is still exactly what the reader offers next.
    assert.deepEqual(batched(await secondSource.read(context)), secondFirst);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale acknowledgement rejects and leaves the frontier unchanged", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-conflict-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("ONE-4821"), assistant("ANSWER-1387"));
    await append(harness, conversation, reset());
    await append(harness, conversation, user("TWO-9074"), assistant("ANSWER-6613"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:conflict", conversationId: conversation.id }],
    });
    const first = batched(await source.read(context));
    await source.acknowledge(first, context);
    const frontier = await source.cursor(conversation.id, context);

    await assert.rejects(() => source.acknowledge(first, context), DigestCursorConflictError);
    assert.deepEqual(await source.cursor(conversation.id, context), frontier);

    // A batch read before another acknowledgement cannot be applied afterwards either.
    const stale = batched(await source.read(context));
    const fresh = batched(await source.read(context));
    assert.deepEqual(stale, fresh);
    await source.acknowledge(fresh, context);
    await assert.rejects(() => source.acknowledge(stale, context), DigestCursorConflictError);
    const moved = await source.cursor(conversation.id, context);
    assert.ok(moved.throughEntryId > frontier.throughEntryId);
    assert.deepEqual(await source.cursor(conversation.id, context), moved);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest resumes at the acknowledged frontier after a restart", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-restart-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [firstUser] = await append(harness, conversation, user("EPISODE-ONE-3042"));
    const [firstAnswer] = await append(harness, conversation, assistant("ANSWER-ONE-7751"));
    await append(harness, conversation, reset());
    await append(harness, conversation, user("EPISODE-TWO-6183"), assistant("ANSWER-TWO-2204"));
    await append(harness, conversation, reset());
    const sessions = async () => [{ sessionKey: "cli:restart", conversationId: conversation.id }];
    const source = createDigestSource({ harness, sessions });
    const first = batched(await source.read(context));
    await source.acknowledge(first, context);

    await harness.close(context);
    harness = undefined;
    harness = await openStore(db);
    const reopened = createDigestSource({ harness, sessions });
    assert.deepEqual(await reopened.cursor(conversation.id, context), {
      throughEntryId: firstAnswer.id,
      throughChars: "ANSWER-ONE-7751".length,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    const second = batched(await reopened.read(context));
    assert.ok(second.episodeStartEntryId > firstAnswer.id);
    assert.deepEqual(second.entries.map((fragment) => fragment.text), ["EPISODE-TWO-6183", "ANSWER-TWO-2204"]);
    assert.ok(firstUser.id < firstAnswer.id);
    await reopened.acknowledge(second, context);
    assert.equal(idle(await reopened.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("an episode with no evidence is an acknowledgeable no-op batch", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-noop-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [systemEntry] = await append(harness, conversation, system("prompt section"));
    const [closingReset] = await append(harness, conversation, reset());
    await append(harness, conversation, user("OPEN-1234"));

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:noop", conversationId: conversation.id }],
    });
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, systemEntry.id);
    assert.equal(batch.episodeEndEntryId, systemEntry.id);
    assert.deepEqual(batch.entries, []);
    assert.equal(batch.complete, true);
    await source.acknowledge(batch, context);
    assert.deepEqual(await source.cursor(conversation.id, context), {
      throughEntryId: systemEntry.id,
      throughChars: 0,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    });
    assert.equal(idle(await source.read(context)).caughtUp, true);
    assert.ok(closingReset.id > systemEntry.id);
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
    await append(harness, conversation, user("OLD-EPISODE-8830"));
    const [segmentReset] = await append(harness, conversation, reset());
    const [middleEntry] = await append(harness, conversation, user("SEGMENT-START-EVIDENCE-1147"));
    await append(harness, conversation, assistant("SEGMENT-MIDDLE-EVIDENCE-6629"));

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:scan", conversationId: conversation.id }],
    });
    // First pass consumes the closed first episode, then scans the open segment and caches it.
    const first = batched(await source.read(context));
    await source.acknowledge(first, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);

    // The segment closes later. The resumed scan must report its real start and all of its evidence.
    const [lastInSegment] = await append(harness, conversation, assistant("SEGMENT-END-EVIDENCE-9025"));
    await append(harness, conversation, reset());
    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, segmentReset.id);
    assert.equal(batch.episodeEndEntryId, lastInSegment.id);
    assert.equal(batch.firstEntryId, segmentReset.id);
    assert.deepEqual(batch.entries.map((fragment) => fragment.entryId), [
      middleEntry.id,
      batch.entries[1].entryId,
      lastInSegment.id,
    ]);
    assert.deepEqual(batch.entries.map((fragment) => fragment.text), [
      "SEGMENT-START-EVIDENCE-1147",
      "SEGMENT-MIDDLE-EVIDENCE-6629",
      "SEGMENT-END-EVIDENCE-9025",
    ]);
    await source.acknowledge(batch, context);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("the oldest pending episode is served first across mapped conversations", { timeout: 15_000 }, async () => {
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
    const [alphaResetTwo] = await append(harness, alpha, reset());
    const [betaTwo] = await append(harness, beta, user("BETA-TWO-4486"));
    await append(harness, beta, reset());

    const sessions = async () => [
      { sessionKey: "cli:alpha", conversationId: alpha.id },
      { sessionKey: "telegram:beta", conversationId: beta.id },
    ];
    const source = createDigestSource({ harness, sessions });
    const seen = [];
    for (let index = 0; index < 4; index += 1) {
      const batch = batched(await source.read(context));
      seen.push([batch.sessionKey, batch.episodeStartEntryId, batch.entries[0].text]);
      await source.acknowledge(batch, context);
    }
    assert.deepEqual(seen, [
      ["cli:alpha", alphaOne.id, "ALPHA-ONE-5501"],
      ["cli:alpha", alphaResetOne.id, "ALPHA-TWO-9918"],
      ["telegram:beta", betaOne.id, "BETA-ONE-2273"],
      ["telegram:beta", betaResetOne.id, "BETA-TWO-4486"],
    ]);
    assert.ok(alphaTwo.id > alphaResetOne.id && alphaResetTwo.id > alphaTwo.id && betaTwo.id > betaResetOne.id);
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
    // One still-open segment longer than a single read's scan budget: no closed episode exists.
    await harness.commit(async (tx) => {
      for (let index = 0; index < DIGEST_LIMITS.scanEntriesPerRead + 200; index += 1) {
        await tx.appendEntry(busy.id, user(`BUSY-${index}`));
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

test("a forged episode start or chunk cannot skip evidence", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-forged-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [firstUser] = await append(harness, conversation, user("EPISODE-ONE-6612"));
    const [firstAnswer] = await append(harness, conversation, assistant("ANSWER-ONE-7714"));
    const [firstReset] = await append(harness, conversation, reset());
    const [secondUser] = await append(harness, conversation, user("EPISODE-TWO-8830"));
    const [secondAnswer] = await append(harness, conversation, assistant("ANSWER-TWO-9901"));
    const [secondReset] = await append(harness, conversation, reset());
    const [thirdUser] = await append(harness, conversation, user("EPISODE-THREE-2245"));
    const [thirdAnswer] = await append(harness, conversation, assistant("ANSWER-THREE-3356"));
    const [thirdReset] = await append(harness, conversation, reset());
    const [openTail] = await append(harness, conversation, user("OPEN-TAIL-4467"));

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:forged", conversationId: conversation.id }],
    });
    const first = batched(await source.read(context));
    assert.deepEqual(first.entries.map((fragment) => fragment.text), ["EPISODE-ONE-6612", "ANSWER-ONE-7714"]);
    await source.acknowledge(first, context);
    const frontier = await source.cursor(conversation.id, context);
    const placeholder = (entryId, text, chars = text.length) => ({
      entryId,
      role: "user",
      kind: "pi.user",
      textStart: 0,
      chars,
      text,
    });
    const forged = (patch) => ({
      status: "batch",
      sessionKey: "cli:forged",
      conversationId: conversation.id,
      episodeStartEntryId: secondReset.id,
      episodeEndEntryId: secondReset.id,
      firstEntryId: secondReset.id,
      firstTextStart: 0,
      throughEntryId: secondReset.id,
      throughChars: 0,
      complete: false,
      entries: [],
      cursor: frontier,
      ...patch,
    });

    // Skip an entire closed episode by claiming a later reset as the next episode start.
    await assert.rejects(
      () => source.acknowledge(forged({ episodeStartEntryId: secondReset.id }), context),
      /skip an earlier segment|does not cover its claimed entry range/,
    );

    // Start inside a segment instead of at a reset or the conversation's first entry.
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: secondUser.id,
        episodeEndEntryId: secondUser.id,
        firstEntryId: secondUser.id,
        throughEntryId: secondUser.id,
        throughChars: "EPISODE-TWO-8830".length,
        complete: true,
        entries: [placeholder(secondUser.id, "EPISODE-TWO-8830")],
      }), context),
      /neither a reset nor the first entry/,
    );

    // Omit one evidence entry from a covered range.
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: firstReset.id,
        episodeEndEntryId: secondAnswer.id,
        firstEntryId: firstReset.id,
        throughEntryId: secondAnswer.id,
        throughChars: "ANSWER-TWO-9901".length,
        complete: true,
        entries: [placeholder(secondUser.id, "EPISODE-TWO-8830")],
      }), context),
      /omits evidence/,
    );

    // Claim a through position that does not match the covered evidence.
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: firstReset.id,
        episodeEndEntryId: secondAnswer.id,
        firstEntryId: firstReset.id,
        throughEntryId: secondAnswer.id,
        throughChars: 1,
        complete: true,
        entries: [
          placeholder(secondUser.id, "EPISODE-TWO-8830"),
          { ...placeholder(secondAnswer.id, "ANSWER-TWO-9901"), role: "assistant", kind: "pi.assistant" },
        ],
      }), context),
      /through offset/,
    );

    // Claim a closed episode whose claimed end runs into the next segment's content.
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: firstReset.id,
        episodeEndEntryId: thirdUser.id,
        firstEntryId: firstReset.id,
        throughEntryId: thirdUser.id,
        throughChars: "EPISODE-THREE-2245".length,
        complete: true,
        entries: [
          placeholder(secondUser.id, "EPISODE-TWO-8830"),
          { ...placeholder(secondAnswer.id, "ANSWER-TWO-9901"), role: "assistant", kind: "pi.assistant" },
          placeholder(thirdUser.id, "EPISODE-THREE-2245"),
        ],
      }), context),
      /spans a reset boundary|not closed by a reset/,
    );
    assert.ok(secondReset.id > secondAnswer.id && thirdReset.id > thirdAnswer.id);

    assert.deepEqual(await source.cursor(conversation.id, context), frontier);
    // The real second episode is still available and consumable after every rejection.
    const second = batched(await source.read(context));
    assert.deepEqual(second.entries.map((fragment) => fragment.text), ["EPISODE-TWO-8830", "ANSWER-TWO-9901"]);
    await source.acknowledge(second, context);
    const third = batched(await source.read(context));
    assert.deepEqual(third.entries.map((fragment) => fragment.text), ["EPISODE-THREE-2245", "ANSWER-THREE-3356"]);
    await source.acknowledge(third, context);
    const thirdFrontier = await source.cursor(conversation.id, context);

    // Start the claimed episode after its own start (a fresh chunk must begin at the start).
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: firstReset.id,
        episodeEndEntryId: secondAnswer.id,
        firstEntryId: secondUser.id,
        throughEntryId: secondAnswer.id,
        throughChars: "ANSWER-TWO-9901".length,
        complete: true,
        entries: [
          placeholder(secondUser.id, "EPISODE-TWO-8830"),
          { ...placeholder(secondAnswer.id, "ANSWER-TWO-9901"), role: "assistant", kind: "pi.assistant" },
        ],
      }), context),
      /must start its episode at the episode start/,
    );

    // Claim completeness into the still-open tail, whose episode has no closing reset.
    await assert.rejects(
      () => source.acknowledge(forged({
        episodeStartEntryId: thirdReset.id,
        episodeEndEntryId: openTail.id,
        firstEntryId: thirdReset.id,
        throughEntryId: openTail.id,
        throughChars: "OPEN-TAIL-4467".length,
        complete: true,
        entries: [placeholder(openTail.id, "OPEN-TAIL-4467")],
        cursor: thirdFrontier,
      }), context),
      /not closed by a reset/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), thirdFrontier);
    assert.equal(idle(await source.read(context)).caughtUp, true);
    assert.ok(firstUser.id < secondUser.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest refuses malformed or out-of-scope session mappings and reports missing chats", { timeout: 15_000 }, async () => {
  const dir = await temp("nanobot-digest-scope-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(harness, conversation, user("SCOPE-CHECK-7315"));
    const make = (sessions) => createDigestSource({ harness, sessions: async () => sessions });

    await assert.rejects(
      () => make([{ sessionKey: "telegram:1:channel-state", conversationId: conversation.id }]).read(context),
      /channel-state sessions/,
    );
    await assert.rejects(
      () => make([
        { sessionKey: "cli:one", conversationId: conversation.id },
        { sessionKey: "cli:two", conversationId: conversation.id },
      ]).read(context),
      /each conversation at most once/,
    );
    await assert.rejects(() => make([{ sessionKey: "", conversationId: conversation.id }]).read(context), /non-empty strings/);

    const missing = idle(await make([
      { sessionKey: "cli:gone", conversationId: conversation.id + 10_000 },
    ]).read(context));
    assert.equal(missing.missingChats, 1);
    assert.equal(missing.caughtUp, false);
    assert.equal(idle(await make([]).read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("an initial acknowledgement cannot start at a later episode and skip earlier closed ones", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-initial-gap-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const [oneUser] = await append(harness, conversation, user("EPISODE-ONE-1111"));
    const [oneAnswer] = await append(harness, conversation, assistant("ANSWER-ONE-2222"));
    await append(harness, conversation, reset());
    await append(harness, conversation, user("EPISODE-TWO-3333"), assistant("ANSWER-TWO-4444"));
    const [secondReset] = await append(harness, conversation, reset());
    const [threeUser] = await append(harness, conversation, user("EPISODE-THREE-5555"));
    const [threeAnswer] = await append(harness, conversation, assistant("ANSWER-THREE-6666"));
    const [thirdReset] = await append(harness, conversation, reset());
    await append(harness, conversation, user("OPEN-7777"));

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:initial-gap", conversationId: conversation.id }],
    });
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, null);
    const empty = {
      throughEntryId: null,
      throughChars: null,
      episodeStartEntryId: null,
      episodeEndEntryId: null,
    };
    // A later reset is claimed as the next episode start while episodes one and two are unconsumed.
    await assert.rejects(
      () => source.acknowledge({
        status: "batch",
        sessionKey: "cli:initial-gap",
        conversationId: conversation.id,
        episodeStartEntryId: secondReset.id,
        episodeEndEntryId: threeAnswer.id,
        firstEntryId: secondReset.id,
        firstTextStart: 0,
        throughEntryId: secondReset.id,
        throughChars: 0,
        complete: false,
        entries: [],
        cursor: empty,
      }, context),
      /skip an earlier segment with content/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), empty);

    // The honest first episode is still available and starts at the transcript beginning.
    const first = batched(await source.read(context));
    assert.equal(first.episodeStartEntryId, oneUser.id);
    assert.deepEqual(first.entries.map((fragment) => fragment.text), ["EPISODE-ONE-1111", "ANSWER-ONE-2222"]);
    await source.acknowledge(first, context);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, oneAnswer.id);
    assert.ok(threeUser.id > oneAnswer.id && thirdReset.id > threeAnswer.id && secondReset.id < threeUser.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh partial batch cannot persist an unverified, contentless or cross-reset end", { timeout: 20_000 }, async () => {
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

    const sessions = async () => [
      { sessionKey: "cli:bounds", conversationId: conversation.id },
      { sessionKey: "telegram:bounds", conversationId: other.id },
    ];
    const source = createDigestSource({ harness, sessions });
    const first = batched(await source.read(context));
    assert.deepEqual(first.entries.map((fragment) => fragment.text), ["BOUNDS-ONE-1234", "BOUNDS-ANSWER-5678"]);
    await source.acknowledge(first, context);
    const frontier = await source.cursor(conversation.id, context);
    const forged = (patch) => ({
      status: "batch",
      sessionKey: "cli:bounds",
      conversationId: conversation.id,
      episodeStartEntryId: firstReset.id,
      episodeEndEntryId: firstReset.id,
      firstEntryId: firstReset.id,
      firstTextStart: 0,
      throughEntryId: firstReset.id,
      throughChars: 0,
      complete: false,
      entries: [],
      cursor: frontier,
      ...patch,
    });

    // A partial chunk from the reset marker claiming an end far beyond the transcript.
    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: 10_000_000 }), context),
      /end is not a committed entry/,
    );
    // A reset-only "episode" whose successor reset appears to close it.
    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: firstReset.id, complete: true }), context),
      /end is a reset marker/,
    );
    // An otherwise valid later episode end still spans this episode's first closing reset.
    await assert.rejects(
      () => source.acknowledge(forged({ episodeEndEntryId: threeAnswer.id }), context),
      /first reset that closes its start/,
    );
    assert.deepEqual(await source.cursor(conversation.id, context), frontier);

    // Both chats stay consumable after the rejection; the poisoned bounds never persisted.
    const seen = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") {
        assert.equal(result.caughtUp, true);
        break;
      }
      const batch = batched(result);
      seen.push([batch.sessionKey, batch.episodeStartEntryId, batch.entries.map((fragment) => fragment.text)]);
      await source.acknowledge(batch, context);
    }
    assert.deepEqual(seen, [
      ["cli:bounds", firstReset.id, ["BOUNDS-TWO-9012", "BOUNDS-TWO-ANSWER-3456"]],
      ["cli:bounds", secondReset.id, ["BOUNDS-THREE-7890", "BOUNDS-THREE-ANSWER-2345"]],
      ["telegram:bounds", otherUser.id, ["BOUNDS-OTHER-6789", "BOUNDS-OTHER-ANSWER-1234"]],
    ]);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, threeAnswer.id);
    assert.equal((await source.cursor(other.id, context)).throughEntryId, otherAnswer.id);
    assert.ok(oneUser.id < oneAnswer.id && twoUser.id > firstReset.id && threeUser.id > twoAnswer.id);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scan paused on reset markers never invents a reset-only episode", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-digest-reset-boundary-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const resets = await harness.commit(async (tx) => {
      const appended = [];
      for (let index = 0; index < DIGEST_LIMITS.scanEntriesPerRead; index += 1) {
        appended.push(await tx.appendEntry(conversation.id, reset()));
      }
      return appended;
    }, context);
    const [nextReset] = await append(harness, conversation, reset());
    const [content] = await append(harness, conversation, user("AFTER-BUDGET-RESETS-8134"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:reset-boundary", conversationId: conversation.id }],
    });
    const firstRead = idle(await source.read(context));
    assert.equal(firstRead.caughtUp, false);
    assert.equal(firstRead.unfinishedChats, 1);
    assert.equal(firstRead.examinedChats, 1);

    const batch = batched(await source.read(context));
    assert.equal(batch.episodeStartEntryId, nextReset.id, "the episode starts at the reset after the paused one");
    assert.equal(batch.episodeEndEntryId, content.id);
    assert.deepEqual(batch.entries.map((fragment) => fragment.text), ["AFTER-BUDGET-RESETS-8134"]);
    assert.equal(batch.entries.every((fragment) => fragment.chars > 0), true);
    assert.notEqual(batch.episodeStartEntryId, resets.at(-1).id);
    // The genuine 4,000-reset gap is still verifiable, so the honest episode can be consumed.
    await source.acknowledge(batch, context);
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, content.id);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a gap beyond the verification bound is refused loudly and skips nothing", { timeout: 30_000 }, async () => {
  const dir = await temp("nanobot-digest-gap-bound-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const resets = await harness.commit(async (tx) => {
      const appended = [];
      for (let index = 0; index < DIGEST_LIMITS.scanEntriesPerRead + 1; index += 1) {
        appended.push(await tx.appendEntry(conversation.id, reset()));
      }
      return appended;
    }, context);
    await append(harness, conversation, reset());
    const [content] = await append(harness, conversation, user("BEYOND-GAP-BOUND-2265"));
    await append(harness, conversation, reset());

    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:gap-bound", conversationId: conversation.id }],
    });
    let batch;
    for (let index = 0; index < 4; index += 1) {
      const result = await source.read(context);
      if (result.status === "batch") {
        batch = result;
        break;
      }
    }
    assert.ok(batch !== undefined, "the bounded scan still reaches the closed episode");
    assert.equal(batch.entries[0].text, "BEYOND-GAP-BOUND-2265");
    await assert.rejects(
      () => source.acknowledge(batch, context),
      /too far from its cursor to verify/,
    );
    assert.equal((await source.cursor(conversation.id, context)).throughEntryId, null);
    // The refusal is loud and the same evidence is offered again, never silently skipped.
    let next;
    for (let index = 0; index < 4; index += 1) {
      const result = await source.read(context);
      if (result.status === "batch") {
        next = result;
        break;
      }
    }
    assert.ok(next !== undefined);
    assert.deepEqual(next.entries, batch.entries);
    assert.ok(resets.length === DIGEST_LIMITS.scanEntriesPerRead + 1 && content.id > 0);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-BMP text is fragmented on code-unit boundaries and survives UTF-8 encoding", { timeout: 20_000 }, async () => {
  const dir = await temp("nanobot-digest-surrogate-");
  const db = resolve(dir, "probe.sqlite");
  let harness;
  try {
    harness = await openStore(db);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    // Three leading units put a high surrogate exactly on the 200,000-unit budget edge.
    const long = `abc${"😀".repeat(100_000)}`;
    const [longEntry] = await append(harness, conversation, user(long));
    await append(harness, conversation, reset());
    const source = createDigestSource({
      harness,
      sessions: async () => [{ sessionKey: "cli:surrogate", conversationId: conversation.id }],
    });

    const batches = [];
    for (let index = 0; index < 10; index += 1) {
      const result = await source.read(context);
      if (result.status === "idle") break;
      const batch = batched(result);
      assert.ok(evidenceChars(batch) <= DIGEST_LIMITS.charsPerBatch, "strict evidence bound");
      batches.push(batch);
      await source.acknowledge(batch, context);
    }
    assert.ok(batches.length >= 2);
    assert.equal(batches[0].entries[0].text.length, DIGEST_LIMITS.charsPerBatch - 1, "pair-safe cut shortens the fragment");
    let rebuilt = "";
    let offset = 0;
    for (const batch of batches) {
      for (const fragment of batch.entries) {
        assert.equal(fragment.entryId, longEntry.id);
        assert.equal(fragment.chars, long.length);
        assert.equal(fragment.textStart, offset, "offsets continue in UTF-16 code units");
        assert.equal(fragment.text.isWellFormed(), true, "no unpaired surrogate at a fragment edge");
        const encoded = Buffer.from(fragment.text, "utf8");
        assert.equal(encoded.toString("utf8"), fragment.text, "UTF-8 wire round trip is lossless");
        assert.equal(encoded.toString("utf8").includes("\uFFFD"), false);
        offset += fragment.text.length;
        rebuilt += fragment.text;
      }
    }
    assert.equal(rebuilt, long, "the full non-BMP entry is consumed exactly");
    assert.equal(offset, long.length);
    assert.equal((await source.cursor(conversation.id, context)).throughChars, long.length);
    assert.equal(idle(await source.read(context)).caughtUp, true);
  } finally {
    if (harness !== undefined) await harness.close(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
