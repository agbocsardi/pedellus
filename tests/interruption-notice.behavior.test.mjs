// Automatic startup recovery records one interruption notice through the existing durable channel
// outbox. These cases use a synthetic prepared dispatch (no crash fixture) so the notice-admission,
// mapping and external-send semantics stay fast and deterministic. The crash/reopen path itself is
// covered by tests/context-recovery.behavior.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_NANOBOT_CANDIDATE ?? new URL("../", import.meta.url).pathname;
const modules = join(pkg, "node_modules/@earendil-works");
const load = (relative) => import(pathToFileURL(resolve(pkg, "dist", relative)).href);
const [
  { parseConfig },
  { openGateway },
  { CRON_DELIVERIES_KIND, CronDeliveriesDoc },
  {
    COMPACTION_INTERRUPTION_NOTICE,
    interruptionNoticeText,
    interruptionOrigin,
    TURN_INTERRUPTION_NOTICE,
    TurnInterruptionMarksDoc,
    turnInterruptionNoticeId,
  },
  { runTelegram },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider },
  { createRegistry, defineTask, Harness },
  { openFullSyncNodeSqliteStorage, },
] = await Promise.all([
  load("config.js"),
  load("runtime.js"),
  load("automation/cron-delivery.js"),
  load("recovery/interruption.js"),
  load("channels/telegram.js"),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
  load("storage/sqlite.js"),
]);

const context = BACKGROUND_CONTEXT;
const ORIGIN = "telegram:7:chat:501";
const WAIT_MS = 10_000;

function syntheticGenerationTask() {
  return defineTask({
    name: "pi.generation",
    version: 999,
    initial: (input) => input.checkpoint,
    phases: {
      request: async () => { throw new Error("synthetic task must never run"); },
    },
    abort: async () => { throw new Error("synthetic task must never take its own abort path"); },
  });
}

/** One no-crash store: a seed turn supplies pinned context, then a synthetic prepared dispatch pins it. */
async function seedBlockedStore(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-interruption-${label}-`));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace);
  const providerId = `interruption-${label}`;
  const faux = fauxProvider({ provider: providerId, models: [{ id: "synthetic" }] });
  faux.setResponses([() => fauxAssistantMessage("seeded reply")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: providerId, modelId: "synthetic" };
  const config = parseConfig({
    workspace,
    dataDir,
    model,
    allowedModels: [model],
    telegram: { tokenEnv: "SYNTHETIC_TELEGRAM_TOKEN", allowFrom: ["501"] },
  }, directory);
  let gateway;
  try {
    gateway = await openGateway(config, context, {
      models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "pinned-context" } }),
    });
    const chat = await gateway.conversationFor(ORIGIN, context);
    const submission = await chat.submit({ type: "input", content: "interrupted request", requestId: "seed" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const latest = await chat.entries({ order: "descending" }, 1, undefined, context);
    const cutoff = latest.items[0]?.id;
    assert.ok(cutoff);
    const conversationId = chat.id;
    await gateway.close(context);
    gateway = undefined;

    const storage = await openFullSyncNodeSqliteStorage(resolve(config.dataDir, "nanobot.sqlite"), context);
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    try {
      const taskId = await harness.commit((tx) => tx.createTask(syntheticGenerationTask(), {
        checkpoint: {
          phase: "request",
          attempt: 1,
          model,
          thinkingLevel: "off",
          streamOptions: {},
          cutoff,
        },
      }, {
        ownership: { kind: "conversation" },
        conversationId,
      }), context);
      return { directory, config, providerId, conversationId, taskId: Number(taskId) };
    } finally {
      await harness.close(context);
    }
  } catch (error) {
    if (gateway !== undefined) await gateway.close(context).catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function recoveredModels(providerId) {
  const faux = fauxProvider({
    provider: providerId,
    models: [{ id: "synthetic", name: "Synthetic" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

async function openRecovered(store) {
  const { models, faux } = recoveredModels(store.providerId);
  const gateway = await openGateway(store.config, context, {
    models,
    contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "pinned-context" } }),
  });
  await gateway.harness.waitForIdle(context);
  assert.equal(faux.state.callCount, 0, "automatic recovery must not dispatch a model request");
  const task = await gateway.harness.getTask(store.taskId, context);
  assert.ok(task);
  assert.equal(task.state.status, "terminal");
  assert.equal(task.state.outcome.status, "orphaned");
  const outbox = await gateway.harness.snapshot(CronDeliveriesDoc, store.conversationId, context);
  const notice = outbox.deliveries.find((record) => record.id === turnInterruptionNoticeId(store.taskId));
  assert.ok(notice);
  assert.equal(notice.status, "pending");
  assert.equal(notice.text, TURN_INTERRUPTION_NOTICE);
  assert.equal(notice.sessionKey, ORIGIN);
  return { gateway, faux };
}

/** Resolve on the next commit whose outbox document matches, with a bounded deadline. */
function outboxWatcher(harness, conversationId, predicate, label) {
  let stop;
  const promise = new Promise((resolveWatch, rejectWatch) => {
    const timer = setTimeout(() => { unsubscribe(); rejectWatch(new Error(`timed out waiting for ${label}`)); }, WAIT_MS);
    const unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.record.kind !== CRON_DELIVERIES_KIND) continue;
        if (change.conversationId !== conversationId || change.value === null) continue;
        const deliveries = change.value.deliveries;
        if (!Array.isArray(deliveries)) continue;
        if (!deliveries.some(predicate)) continue;
        clearTimeout(timer);
        unsubscribe();
        resolveWatch(undefined);
        return;
      }
    });
    stop = () => { clearTimeout(timer); unsubscribe(); rejectWatch(new Error(`stopped waiting for ${label}`)); };
  });
  // A failing test may stop before awaiting; keep that rejection from surfacing as unhandled.
  void promise.catch(() => undefined);
  return {
    promise,
    stop: () => stop?.(),
  };
}

function telegramFetchMock(identity, updates, options = {}) {
  const original = globalThis.fetch;
  const sent = [];
  const listeners = new Set();
  let polled = false;
  let nextMessageId = 900;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const response = (result) => new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const signal = init.signal;
    if (method === "getMe") {
      return response({
        id: identity, is_bot: true, first_name: "Synthetic", username: "synthetic_bot",
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      });
    }
    if (method === "getUpdates") {
      if (!polled) {
        polled = true;
        return response(updates);
      }
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (signal?.aborted) return aborted();
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      const text = method === "sendRichMessage" ? (body.rich_message?.markdown ?? "") : (body.text ?? "");
      if (options.rejectText?.({ method, text }) === true) {
        // No `ok` envelope: an ambiguous transport outcome, exactly like a network failure.
        throw new TypeError("synthetic network failure");
      }
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text, method, messageId });
      notify();
      return response(method === "sendRichMessage"
        ? { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: "private" }, rich_message: body.rich_message }
        : { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: "private" }, text });
    }
    if (method === "sendChatAction") return response(true);
    if (method === "editMessageText" || method === "deleteMessage") return response(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return {
    sent,
    restore() { globalThis.fetch = original; },
    waitForText(predicate, label) {
      const existing = sent.find((entry) => predicate(entry.text));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveWait, rejectWait) => {
        const listener = () => {
          const match = sent.find((entry) => predicate(entry.text));
          if (match === undefined) return;
          listeners.delete(listener);
          clearTimeout(timer);
          resolveWait(match);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          rejectWait(new Error(`timed out waiting for ${label}: ${JSON.stringify(sent)}`));
        }, WAIT_MS);
        listeners.add(listener);
      });
    },
  };
}

function allowedUpdate(updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text: "hello",
      chat: { id: 501, type: "private", first_name: "Synthetic" },
      from: { id: 501, is_bot: false, first_name: "Synthetic" },
    },
  };
}

test("interruption origin follows the active task class rather than a target conversation", () => {
  const chat = 10;
  const automation = 11;
  const workerTarget = 12;
  const digestTarget = 13;
  const sources = {
    chatSessionKey: (id) => id === chat ? "telegram:7:chat:501" : undefined,
    automationOrigin: (id) => id === automation ? chat : undefined,
    backgroundOrigin: (id) => id === workerTarget || id === digestTarget ? chat : undefined,
  };
  assert.deepEqual(interruptionOrigin(chat, sources), { conversationId: chat, sessionKey: "telegram:7:chat:501" });
  assert.deepEqual(interruptionOrigin(automation, sources), { conversationId: chat, sessionKey: "telegram:7:chat:501" });
  assert.deepEqual(interruptionOrigin(workerTarget, sources), { conversationId: chat, sessionKey: "telegram:7:chat:501" });
  assert.deepEqual(interruptionOrigin(digestTarget, sources), { conversationId: chat, sessionKey: "telegram:7:chat:501" });
  assert.equal(interruptionOrigin(99, sources), undefined, "an unmapped target is never guessed");
  assert.equal(interruptionNoticeText("pi.generation"), TURN_INTERRUPTION_NOTICE);
  assert.equal(interruptionNoticeText("pi.compaction"), COMPACTION_INTERRUPTION_NOTICE);
  assert.match(COMPACTION_INTERRUPTION_NOTICE, /compaction was interrupted/);
  assert.doesNotMatch(COMPACTION_INTERRUPTION_NOTICE, /Previous turn/);
});

test("a marked dispatch with a stale origin is cancelled without a guessed notice", { timeout: 20_000 }, async () => {
  const store = await seedBlockedStore("stale-origin");
  let gateway;
  try {
    // Recreate a pending mark whose recorded session is no longer this conversation's mapped chat.
    const { models } = recoveredModels(store.providerId);
    const storage = await openFullSyncNodeSqliteStorage(resolve(store.config.dataDir, "nanobot.sqlite"), context);
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnInterruptionMarksDoc);
        doc.marks = [{
          taskId: store.taskId,
          kind: "pi.generation",
          originConversationId: store.conversationId,
          sessionKey: "telegram:7:chat:999",
          createdAtMs: 1,
        }];
      }, context);
    } finally {
      await harness.close(context);
    }

    const reopened = recoveredModels(store.providerId);
    gateway = await openGateway(store.config, context, {
      models: reopened.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "pinned-context" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.faux.state.callCount, 0);
    const task = await gateway.harness.getTask(store.taskId, context);
    assert.ok(task);
    assert.equal(task.state.status, "terminal");
    assert.equal(task.state.outcome.status, "orphaned");
    assert.equal(await gateway.harness.snapshot(CronDeliveriesDoc, store.conversationId, context), undefined,
      "a mark whose session is no longer the mapped chat must not create a notice");
    const marks = await gateway.harness.snapshot(TurnInterruptionMarksDoc, context);
    assert.deepEqual(marks?.marks ?? [], [], "the stale mark is cleared without retargeting it");
  } finally {
    if (gateway !== undefined) await gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test("a recovered notice reaches the authenticated Telegram chat once through the durable outbox", { timeout: 30_000 }, async () => {
  const store = await seedBlockedStore("telegram");
  let gateway;
  let adapter;
  let scope;
  let transport;
  let watcher;
  try {
    const recovered = await openRecovered(store);
    gateway = recovered.gateway;
    recovered.faux.setResponses([() => fauxAssistantMessage("hello reply")]);
    const noticeId = turnInterruptionNoticeId(store.taskId);
    watcher = outboxWatcher(
      gateway.harness,
      store.conversationId,
      (record) => record.id === noticeId && record.status === "delivered",
      "delivered interruption notice",
    );
    transport = telegramFetchMock(7, [allowedUpdate(800)]);
    scope = withCancel(context);
    adapter = runTelegram(gateway, {
      token: "123456:synthetic-token",
      allowFrom: ["501"],
      pollTimeoutSeconds: 1,
    }, scope.context);

    await transport.waitForText((text) => text === TURN_INTERRUPTION_NOTICE, "the interruption notice");
    await transport.waitForText((text) => text === "hello reply", "the ordinary reply");
    await watcher.promise;
    assert.equal(transport.sent.filter((entry) => entry.text === TURN_INTERRUPTION_NOTICE).length, 1);
    const outbox = await gateway.harness.snapshot(CronDeliveriesDoc, store.conversationId, context);
    assert.equal(outbox.deliveries.filter((record) => record.id === noticeId).length, 1);
    assert.equal(outbox.deliveries.find((record) => record.id === noticeId).status, "delivered");
    const marks = await gateway.harness.snapshot(TurnInterruptionMarksDoc, context);
    assert.deepEqual(marks?.marks ?? [], []);
  } finally {
    watcher?.stop();
    scope?.cancel(new DOMException("test finished", "AbortError"));
    if (adapter !== undefined) await adapter.catch(() => undefined);
    transport?.restore();
    if (gateway !== undefined) await gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test("an ambiguous Telegram send is retained as unknown and never resent on reopen", { timeout: 30_000 }, async () => {
  const store = await seedBlockedStore("unknown");
  let gateway;
  let adapter;
  let scope;
  let transport;
  let unknownWatcher;
  try {
    const recovered = await openRecovered(store);
    gateway = recovered.gateway;
    recovered.faux.setResponses([() => fauxAssistantMessage("hello reply")]);
    const noticeId = turnInterruptionNoticeId(store.taskId);
    unknownWatcher = outboxWatcher(
      gateway.harness,
      store.conversationId,
      (record) => record.id === noticeId && record.status === "unknown",
      "held unknown interruption notice",
    );
    transport = telegramFetchMock(7, [allowedUpdate(801)], {
      rejectText: ({ text }) => text === TURN_INTERRUPTION_NOTICE,
    });
    scope = withCancel(context);
    adapter = runTelegram(gateway, {
      token: "123456:synthetic-token",
      allowFrom: ["501"],
      pollTimeoutSeconds: 1,
    }, scope.context);

    await unknownWatcher.promise;
    await transport.waitForText((text) => text === "hello reply", "the ordinary reply");
    assert.equal(transport.sent.some((entry) => entry.text === TURN_INTERRUPTION_NOTICE), false,
      "an ambiguous send must not be reported as delivered");
    const unknown = await gateway.harness.snapshot(CronDeliveriesDoc, store.conversationId, context);
    const held = unknown.deliveries.find((record) => record.id === noticeId);
    assert.equal(held.status, "unknown");
    assert.equal(held.sendIntent, undefined);

    scope.cancel(new DOMException("test finished", "AbortError"));
    scope = undefined;
    await adapter.catch(() => undefined);
    adapter = undefined;
    transport.restore();
    transport = undefined;

    await gateway.close(context);
    gateway = undefined;

    const reopened = recoveredModels(store.providerId);
    gateway = await openGateway(store.config, context, {
      models: reopened.models,
      contextSnapshotProvider: () => ({ identity: { source: "synthetic", content: "pinned-context" } }),
    });
    await gateway.harness.waitForIdle(context);
    assert.equal(reopened.faux.state.callCount, 0, "reopening must not start a turn or a provider call");
    const after = await gateway.harness.snapshot(CronDeliveriesDoc, store.conversationId, context);
    const retained = after.deliveries.find((record) => record.id === noticeId);
    assert.equal(retained.status, "unknown", "unknown external outcome is retained, never evicted or retried");
    assert.equal(after.deliveries.filter((record) => record.id === noticeId).length, 1);
  } finally {
    unknownWatcher?.stop();
    scope?.cancel(new DOMException("test finished", "AbortError"));
    if (adapter !== undefined) await adapter.catch(() => undefined);
    transport?.restore();
    if (gateway !== undefined) await gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});
