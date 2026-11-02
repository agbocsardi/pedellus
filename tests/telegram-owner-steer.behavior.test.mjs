// Telegram owner busy-mode: with `followUpMode: "steer"` every message admitted while a turn runs
// joins that turn after its tool round, and all of them settle with the SAME committed answer entry.
// One of those records owns the single reply: the others stay silent, one preview message is shared,
// and the owner retires its siblings in the same commit that retires itself — so a crash, a reopen or
// an ambiguous send can never make the same answer arrive twice through another record.
//
// No bot, credential, network, provider or live process: the Bot API is a mocked fetch and the model
// is a faux provider over a temporary store. Every wait is an explicit predicate with a deadline.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { runTelegram, TelegramState },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { inProcessTerminalConversation },
  { CronJobsDoc },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(new URL('../dist/terminal/conversation.js', import.meta.url).href),
  import(new URL('../dist/automation/cron.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const BOT_ID = 7;
const CHAT_ID = 501;
const TOKEN = '123456:synthetic-token';

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Advance the mocked clock until `predicate` holds, so streaming, the preview debounce and timers run. */
async function advanceUntil(t, predicate, label, totalMs = 20_000, stepMs = 50) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    t.mock.timers.tick(stepMs);
    await flush(4);
    if (await predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

function deferred() {
  const box = {};
  box.promise = new Promise((resolve) => { box.resolve = resolve; });
  return box;
}

function userTexts(messages) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')));
}

async function syntheticStore(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-owner-steer-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'note.md'), '# Synthetic note\n\nfixture body\n');
    const faux = fauxProvider({
      provider: 'fixture',
      models: [{ id: 'alpha', name: 'Alpha' }],
      ...(options.streamTokensPerSecond === undefined ? {} : { tokensPerSecond: options.streamTokensPerSecond }),
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model: { provider: 'fixture', modelId: 'alpha' },
      allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
      toolAllowlist: options.tools ?? [],
      episodeSummary: { enabled: false },
      ...(options.cron === true ? { cron: { enabled: true } } : {}),
      ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
      ...(options.media === undefined ? {} : { media: options.media }),
      telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom: ['501'] },
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, workspace, config, faux, models, gateway };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function privateChat(chatId = CHAT_ID) {
  return { id: chatId, type: 'private', first_name: 'Synthetic' };
}

function privateUser(userId = CHAT_ID) {
  return { id: userId, is_bot: false, first_name: 'Synthetic' };
}

function textUpdate(updateId, text, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: privateChat(chatId),
      from: privateUser(chatId),
    },
  };
}

function photoUpdate(updateId, text, { fileId, uniqueId, bytes, caption }, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(chatId),
      from: privateUser(chatId),
      photo: [{
        file_id: fileId,
        file_unique_id: uniqueId,
        file_size: bytes.byteLength,
        width: 90,
        height: 90,
      }],
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

/**
 * Mocked Bot API. Batches are served in order (a batch may be a thunk the test releases), then the
 * long poll holds until the adapter stops. `richFailure` makes one rich send ambiguous.
 */
function telegramMock(batches, options = {}) {
  const original = globalThis.fetch;
  const rich = [];
  const plain = [];
  const edits = [];
  let batchIndex = 0;
  let nextMessageId = 900;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const response = (result) => json({ ok: true, result });
  const message = (chatId, extra) => ({
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    ...extra,
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const signal = init.signal;
    if (method === 'getMe') {
      return response({
        id: BOT_ID, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      });
    }
    if (method === 'setMyCommands' || method === 'sendChatAction' || method === 'deleteMessage') return response(true);
    if (method === 'getFile') {
      const file = options.files?.get(body.file_id);
      if (file === undefined) return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }, 400);
      return response({
        file_id: body.file_id,
        file_unique_id: body.file_id,
        file_size: file.bytes.byteLength,
        file_path: file.path,
      });
    }
    if (url.origin === 'https://api.telegram.org' && url.pathname.startsWith('/file/bot')) {
      const relative = url.pathname.slice(`/file/bot${TOKEN}/`.length);
      const file = [...(options.files?.values() ?? [])].find((candidate) => candidate.path === relative);
      if (file === undefined) return new Response('missing', { status: 404 });
      return new Response(file.bytes, {
        status: 200,
        headers: { 'content-type': file.contentType ?? 'application/octet-stream' },
      });
    }
    if (method === 'getUpdates') {
      if (batchIndex < batches.length) {
        const batch = batches[batchIndex++];
        return response(typeof batch === 'function' ? await batch() : batch);
      }
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendRichMessage') {
      const markdown = body.rich_message?.markdown ?? '';
      const failure = options.richFailure?.(markdown, rich.length);
      if (failure !== undefined) {
        rich.push({ chatId: body.chat_id, text: markdown, failed: true });
        return json({ ok: false, ...failure }, failure.status);
      }
      const sent = message(body.chat_id, { rich_message: body.rich_message });
      rich.push({ chatId: body.chat_id, text: markdown, messageId: sent.message_id });
      return response(sent);
    }
    if (method === 'sendMessage') {
      const text = body.text ?? '';
      const sent = message(body.chat_id, { text });
      plain.push({ chatId: body.chat_id, text, messageId: sent.message_id });
      return response(sent);
    }
    if (method === 'editMessageText') {
      const entry = {
        chatId: body.chat_id,
        messageId: body.message_id,
        rich: body.rich_message !== undefined,
        text: body.rich_message?.markdown ?? body.text ?? '',
      };
      edits.push(entry);
      return response(true);
    }
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return { rich, plain, edits, restore() { globalThis.fetch = original; } };
}

function start(store, transport, options = {}) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: TOKEN,
    allowFrom: ['501'],
    pollTimeoutSeconds: 1,
    followUpMode: store.config.followUpMode,
    ...(store.config.media === undefined
      ? {}
      : { media: { workspace: store.workspace, directory: store.config.media.directory } }),
    ...(options === undefined ? {} : options),
  }, scope.context);
  return { scope, adapter, transport };
}

async function stop(harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
}

async function cleanup(store, harness, t) {
  await stop(harness);
  harness?.transport?.restore();
  if (t?.mock?.timers?.reset !== undefined) {
    // Durable teardown may wait on its own timers; drain them before the clock is released.
    try { t.mock.timers.reset(); } catch { /* no fake clock in this test */ }
  }
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

async function telegramState(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

/** The chat's own durable queue, read through the same projection `/status` uses. */
async function chatInbox(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
  return (await inProcessTerminalConversation(conversation).status(context)).inbox;
}

/**
 * Record each request's user messages. The first request is held until `release`, so later messages
 * are admitted while that turn is genuinely running.
 */
function scriptedRequests(faux, steps) {
  const requests = [];
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  faux.setResponses(steps.map((step, index) => async (transcript) => {
    requests.push(userTexts(transcript.messages));
    if (index !== 0) return step();
    entered.resolve();
    await held;
    return step();
  }));
  return { requests, entered: entered.promise, release: () => release() };
}

const toolCall = (id) => () => fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id }), { stopReason: 'toolUse' });

test('messages steered across tool rounds deliver their one shared answer exactly once', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('shared', { followUpMode: 'steer', tools: ['read'] });
  const transport = telegramMock([[
    textUpdate(1, 'first steered message'),
    textUpdate(2, 'second steered message'),
    textUpdate(3, 'third steered message'),
  ]]);
  const script = scriptedRequests(store.faux, [toolCall('read-1'), toolCall('read-2'), () => fauxAssistantMessage('SHARED-STEER-ANSWER')]);
  let harness;
  try {
    harness = start(store, transport);
    await script.entered;
    // One steer is placed after each tool round, so the third request carries all three in order.
    await until(async () => (await chatInbox(store.gateway)).steer === 2, 'both later messages to queue as steers');
    script.release();
    await until(() => transport.rich.some((entry) => entry.text.includes('SHARED-STEER-ANSWER')), 'the shared answer');
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both sibling records to retire');
    assert.deepEqual(script.requests[0], ['first steered message']);
    assert.deepEqual(script.requests[1], ['first steered message', 'second steered message']);
    assert.deepEqual(script.requests[2], [
      'first steered message',
      'second steered message',
      'third steered message',
    ]);
    const delivered = transport.rich.filter((entry) => entry.text.includes('SHARED-STEER-ANSWER'));
    assert.equal(delivered.length, 1, 'the shared answer is sent once, not once per admitted message');
  } finally {
    script.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('the default follow-up mode still answers every message in its own turn', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('queued');
  const transport = telegramMock([[
    textUpdate(10, 'first queued message'),
    textUpdate(11, 'second queued message'),
  ]]);
  const script = scriptedRequests(store.faux, [
    () => fauxAssistantMessage('FIRST-QUEUED-ANSWER'),
    () => fauxAssistantMessage('SECOND-QUEUED-ANSWER'),
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await script.entered;
    await until(async () => (await chatInbox(store.gateway)).followUp === 1, 'the second message to queue behind the turn');
    script.release();
    await until(() => transport.rich.some((entry) => entry.text.includes('SECOND-QUEUED-ANSWER')), 'the second answer');
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both deliveries to settle');
    assert.deepEqual(script.requests[0], ['first queued message']);
    assert.equal(script.requests[1].at(-1), 'second queued message');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('FIRST-QUEUED-ANSWER')).length, 1);
    assert.equal(transport.rich.filter((entry) => entry.text.includes('SECOND-QUEUED-ANSWER')).length, 1);
  } finally {
    script.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a steer that misses the tool round is answered by the following run, not by interrupting it', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('too-late', { followUpMode: 'steer' });
  const lateAdmitted = deferred();
  const transport = telegramMock([
    [textUpdate(20, 'held message')],
    // The second message is only admitted after the held turn is genuinely in flight.
    async () => {
      lateAdmitted.resolve();
      return [textUpdate(21, 'late steered message')];
    },
  ]);
  const script = scriptedRequests(store.faux, [
    () => fauxAssistantMessage('TOO-LATE-ANSWER'),
    () => fauxAssistantMessage('NEXT-RUN-ANSWER'),
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await script.entered;
    await lateAdmitted.promise;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the late message to queue as a steer');
    script.release();
    await until(() => transport.rich.some((entry) => entry.text.includes('NEXT-RUN-ANSWER')), 'the next run to answer');
    // The held turn already answered when the steer was placed, so it answers a beat later in its own
    // run; nothing is regenerated and no message is answered twice.
    assert.deepEqual(script.requests[0], ['held message']);
    assert.equal(script.requests[1].at(-1), 'late steered message');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('TOO-LATE-ANSWER')).length, 1);
    assert.equal(transport.rich.filter((entry) => entry.text.includes('NEXT-RUN-ANSWER')).length, 1);
  } finally {
    script.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('one preview message is shared, and the final answer edits that same message', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('preview', { followUpMode: 'steer', tools: ['read'], streamTokensPerSecond: 450 });
  const transport = telegramMock([[
    textUpdate(30, 'first preview message'),
    textUpdate(31, 'second preview message'),
  ]]);
  const answer = Array.from({ length: 100 }, (_, index) => `- shared preview line ${index}`).join('\n');
  // The clock is mocked, so every wait ticks it: the held tool-round request is a plain promise, not a timer.
  let entered = false;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  store.faux.setResponses([
    async () => {
      entered = true;
      await held;
      return fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id: 'read-1' }), { stopReason: 'toolUse' });
    },
    () => fauxAssistantMessage(answer),
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await advanceUntil(t, () => entered, 'the first request');
    await advanceUntil(t, async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    release();
    // Only the run's first input owns the live preview: a steered sibling publishes none.
    await advanceUntil(t, () => transport.edits.some((entry) => entry.rich), 'a preview edit');
    assert.equal(transport.rich.length, 1, 'the run has exactly one preview message');
    const preview = transport.rich[0];
    await advanceUntil(t, async () => (await telegramState(store.gateway)).pending.length === 0, 'the shared delivery to settle');
    assert.ok(transport.edits.some((entry) => entry.messageId === preview.messageId),
      'the final answer edits the one shared preview in place');
  } finally {
    release?.();
    await cleanup(store, harness, t);
    transport.restore();
  }
});

test('an ambiguous shared send is never repeated and its silent siblings retire on reopen', { timeout: 40_000 }, async () => {
  const store = await syntheticStore('unknown', { followUpMode: 'steer', tools: ['read'] });
  const transport = telegramMock([[
    textUpdate(40, 'first ambiguous message'),
    textUpdate(41, 'second ambiguous message'),
  ]], {
    // An ambiguous final outcome is quarantined: no plain fallback, no second attempt.
    richFailure: (text) => (text.includes('QUARANTINED-ANSWER')
      ? { error_code: 500, description: 'Internal Server Error: unknown' }
      : undefined),
  });
  const script = scriptedRequests(store.faux, [toolCall('read-1'), () => fauxAssistantMessage('QUARANTINED-ANSWER')]);
  let harness;
  let reopened;
  let reopenedHarness;
  let reopenedTransport;
  try {
    harness = start(store, transport);
    await script.entered;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    script.release();
    await until(async () => {
      const records = (await telegramState(store.gateway)).pending;
      return records.length === 1 && records[0].deliveryStatus === 'unknown';
    }, 'the owner to hold the ambiguous outcome and its sibling to retire');
    await flush();
    assert.equal(transport.rich.filter((entry) => entry.text.includes('QUARANTINED-ANSWER')).length, 1,
      'the ambiguous outcome was attempted once');
    assert.equal(transport.plain.length, 0, 'an ambiguous rich outcome is never resent as plain text');

    // Reopen the same store: the held record is never retried, and no silent sibling is left behind.
    await stop(harness);
    harness = undefined;
    transport.restore();
    await store.gateway.close(context);
    const models = store.models;
    reopened = await openGateway(store.config, context, { models });
    reopenedTransport = telegramMock([[]]);
    reopenedHarness = { scope: withCancel(context), transport: reopenedTransport };
    reopenedHarness.adapter = runTelegram(reopened, {
      token: TOKEN,
      allowFrom: ['501'],
      pollTimeoutSeconds: 1,
      followUpMode: store.config.followUpMode,
    }, reopenedHarness.scope.context);
    await flush(40);
    assert.equal(reopenedTransport.rich.length, 0, 'recovery does not retry the ambiguous delivery');
    const recovered = await telegramState(reopened);
    assert.equal(recovered.pending.length, 1, 'the unknown outcome stays recorded, never evicted');
    assert.equal(recovered.pending[0].deliveryStatus, 'unknown');
  } finally {
    script.release();
    await stop(reopenedHarness);
    reopenedTransport?.restore();
    await reopened?.close(context);
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a delivered shared answer is not resent when the adapter stops before its siblings retire', { timeout: 40_000 }, async () => {
  const store = await syntheticStore('delivered', { followUpMode: 'steer', tools: ['read'] });
  const transport = telegramMock([[
    textUpdate(50, 'first delivered message'),
    textUpdate(51, 'second delivered message'),
  ]]);
  const script = scriptedRequests(store.faux, [toolCall('read-1'), () => fauxAssistantMessage('DELIVERED-ONCE')]);
  let harness;
  let reopened;
  let reopenedHarness;
  let reopenedTransport;
  try {
    harness = start(store, transport);
    await script.entered;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    script.release();
    await until(() => transport.rich.some((entry) => entry.text.includes('DELIVERED-ONCE')), 'the shared answer');
    // Stop immediately: whether or not the retirement commit already landed, no record may resend it.
    await stop(harness);
    harness = undefined;
    transport.restore();
    await store.gateway.close(context);
    reopened = await openGateway(store.config, context, { models: store.models });
    reopenedTransport = telegramMock([[]]);
    reopenedHarness = { scope: withCancel(context), transport: reopenedTransport };
    reopenedHarness.adapter = runTelegram(reopened, {
      token: TOKEN,
      allowFrom: ['501'],
      pollTimeoutSeconds: 1,
      followUpMode: store.config.followUpMode,
    }, reopenedHarness.scope.context);
    await until(async () => (await telegramState(reopened)).pending.length === 0, 'recovery to retire what is left');
    await flush(40);
    assert.equal(reopenedTransport.rich.length, 0, 'no second copy of the delivered answer');
    assert.equal(reopenedTransport.plain.length, 0);
  } finally {
    script.release();
    await stop(reopenedHarness);
    reopenedTransport?.restore();
    await reopened?.close(context);
    await cleanup(store, harness);
    transport.restore();
  }
});

test('an attachment steered with a later message keeps its stored original and its order', { timeout: 30_000 }, async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const store = await syntheticStore('attachment', {
    followUpMode: 'steer',
    tools: ['read'],
    media: { directory: 'media' },
  });
  const transport = telegramMock([[
    photoUpdate(70, 'photo', { fileId: 'photo-1', uniqueId: 'unique-photo-1', bytes, caption: 'what is this?' }),
    textUpdate(71, 'and what about the note?'),
  ]], { files: new Map([['photo-1', { path: 'photos/file_1.jpg', bytes, contentType: 'image/jpeg' }]]) });
  const script = scriptedRequests(store.faux, [toolCall('read-1'), () => fauxAssistantMessage('ATTACHMENT-ANSWER')]);
  let harness;
  try {
    harness = start(store, transport);
    await script.entered;
    // The photo is the run's first input and the text steers into it after the tool round.
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the later message to queue as a steer');
    script.release();
    await until(() => transport.rich.some((entry) => entry.text.includes('ATTACHMENT-ANSWER')), 'the shared answer');
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both deliveries to settle');
    assert.equal(script.requests[0].length, 1);
    assert.match(script.requests[0][0], /^what is this\?/);
    assert.equal(script.requests[1].length, 2);
    assert.match(script.requests[1][0], /^what is this\?/);
    assert.equal(script.requests[1].at(-1), 'and what about the note?');
    // The original is stored before the model sees anything, and its locator travels with the caption.
    const stored = await readdir(join(store.workspace, 'media'));
    assert.equal(stored.length, 1);
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), bytes);
    assert.ok(script.requests[0][0].includes(`media/${stored[0]}`), 'the turn names the stored original');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('ATTACHMENT-ANSWER')).length, 1);
  } finally {
    script.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a reset that lands at a steered boundary ends the shared turn without a failure report', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('reset', { followUpMode: 'steer', tools: ['read'] });
  const resetBatch = deferred();
  const transport = telegramMock([
    [textUpdate(80, 'first reset message'), textUpdate(81, 'second reset message')],
    // The reset is only served once both messages have been admitted into the running turn.
    async () => {
      await resetBatch.promise;
      return [textUpdate(82, '/new')];
    },
  ]);
  const script = scriptedRequests(store.faux, [toolCall('read-1'), () => fauxAssistantMessage('RESET-ANSWER-NEVER')]);
  let harness;
  try {
    harness = start(store, transport);
    await script.entered;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    resetBatch.resolve();
    await until(() => transport.rich.some((entry) => entry.text.includes('Context reset.')), 'the reset acknowledgement');
    script.release();
    // The queued reset ends the turn that was already answering — silently, because the owner asked for
    // it — and the steer it placed continues in the new context, so exactly one answer is delivered.
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both messages to retire');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('RESET-ANSWER-NEVER')).length, 1);
    assert.equal(transport.rich.filter((entry) => entry.text.includes('could not be completed')).length, 0);
  } finally {
    script.release();
    resetBatch.resolve();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('aborting a steered turn reports no delivery failure for any of its messages', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('abort', { followUpMode: 'steer', tools: ['read'] });
  const abortBatch = deferred();
  const transport = telegramMock([
    [textUpdate(60, 'first aborted message'), textUpdate(61, 'second aborted message')],
    // The abort is only served once both messages have been admitted into the running turn.
    async () => {
      await abortBatch.promise;
      return [textUpdate(62, '/abort')];
    },
  ]);
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  store.faux.setResponses([
    // A cooperative provider: the native abort cancels the live request instead of waiting on it.
    async (_transcript, options) => {
      entered.resolve();
      await Promise.race([
        held,
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal === undefined) return;
          const stop = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal.aborted) return stop();
          signal.addEventListener('abort', stop, { once: true });
        }),
      ]);
      return fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id: 'read-1' }), { stopReason: 'toolUse' });
    },
    () => fauxAssistantMessage('NEVER-DELIVERED'),
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await entered.promise;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    abortBatch.resolve();
    await until(() => transport.rich.some((entry) => entry.text.includes('Idle. Queue cleared.')), 'the abort acknowledgement');
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both messages to retire');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('could not be completed')).length, 0,
      'a deliberate abort reports no failure and sends no answer');
    assert.equal(transport.rich.filter((entry) => entry.text.includes('NEVER-DELIVERED')).length, 0);
  } finally {
    release?.();
    abortBatch.resolve();
    await cleanup(store, harness);
    transport.restore();
  }
});

const FAILURE_NOTICE = 'Your request could not be completed. Please try again.';

/** A faux provider that fails every request with the same synthetic model error. */
function alwaysFails(faux) {
  faux.setResponses(Array.from({ length: 8 }, () => () => { throw new Error('synthetic provider failure'); }));
}

test('a held failure notice never owns a later unrelated failure with the same model error', { timeout: 40_000 }, async () => {
  const store = await syntheticStore('failure-independent', { followUpMode: 'steer' });
  const secondBatch = deferred();
  const thirdBatch = deferred();
  const transport = telegramMock([
    [textUpdate(90, 'first failing message')],
    async () => {
      await secondBatch.promise;
      return [textUpdate(91, 'second failing message')];
    },
  ], {
    // Only the very first notice is ambiguous; every later notice is an ordinary send.
    richFailure: (_text, index) => (index === 0
      ? { error_code: 500, description: 'Internal Server Error: unknown' }
      : undefined),
  });
  alwaysFails(store.faux);
  let harness;
  let reopened;
  let reopenedHarness;
  let reopenedTransport;
  try {
    harness = start(store, transport);
    // The first run fails and its notice is ambiguous: the record is held, not evicted.
    await until(async () => {
      const records = (await telegramState(store.gateway)).pending;
      return records.length === 1 && records[0].deliveryStatus === 'unknown';
    }, 'the ambiguous failure notice to be held');
    secondBatch.resolve();
    // An independent failure with the SAME provider error still reports itself; the held record keeps
    // its evidence and is never treated as the owner of this run.
    await until(() => transport.rich.length === 2, 'the second failure notice');
    assert.ok(transport.rich[1].text.includes(FAILURE_NOTICE));
    const afterSecond = (await telegramState(store.gateway)).pending;
    assert.equal(afterSecond.length, 1, 'only the held first notice stays pending');
    assert.equal(afterSecond[0].updateId, 90);
    assert.equal(afterSecond[0].deliveryStatus, 'unknown');

    // Reopen: the held outcome is never retried, and a third independent failure still reports.
    await stop(harness);
    harness = undefined;
    transport.restore();
    await store.gateway.close(context);
    reopened = await openGateway(store.config, context, { models: store.models });
    reopenedTransport = telegramMock([
      async () => {
        await thirdBatch.promise;
        return [textUpdate(93, 'third failing message')];
      },
    ]);
    reopenedHarness = { scope: withCancel(context), transport: reopenedTransport };
    reopenedHarness.adapter = runTelegram(reopened, {
      token: TOKEN,
      allowFrom: ['501'],
      pollTimeoutSeconds: 1,
      followUpMode: store.config.followUpMode,
    }, reopenedHarness.scope.context);
    await flush(40);
    assert.equal(reopenedTransport.rich.length, 0, 'recovery never retries the held notice');
    thirdBatch.resolve();
    await until(() => reopenedTransport.rich.length === 1, 'the third failure notice after reopen');
    assert.ok(reopenedTransport.rich[0].text.includes(FAILURE_NOTICE));
    const recovered = (await telegramState(reopened)).pending;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].deliveryStatus, 'unknown');
  } finally {
    secondBatch.resolve();
    thirdBatch.resolve();
    await stop(reopenedHarness);
    reopenedTransport?.restore();
    await reopened?.close(context);
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a failed shared turn reports its fixed notice for every message it consumed', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('failure-shared', { followUpMode: 'steer', tools: ['read'] });
  const transport = telegramMock([[
    textUpdate(94, 'first failing steered message'),
    textUpdate(95, 'second failing steered message'),
  ]]);
  const entered = deferred();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  store.faux.setResponses([
    async () => {
      entered.resolve();
      await held;
      return fauxAssistantMessage(fauxToolCall('read', { path: 'note.md' }, { id: 'read-1' }), { stopReason: 'toolUse' });
    },
    // Both messages are in the run by now, so this one failure settles both of them.
    () => { throw new Error('synthetic provider failure'); },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await entered.promise;
    await until(async () => (await chatInbox(store.gateway)).steer === 1, 'the second message to queue as a steer');
    release();
    // A failed run exposes no run identity at settlement, so its failure is never guessed from the
    // reason text: each consumed message reports its own fixed notice and none is silently dropped.
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'both failure notices to settle');
    assert.equal(transport.rich.filter((entry) => entry.text.includes(FAILURE_NOTICE)).length, 2);
  } finally {
    release?.();
    await cleanup(store, harness);
    transport.restore();
  }
});

/**
 * A scheduled origin-mode run in the owner's chat plus one owner message admitted while that run is
 * genuinely in flight. The scheduled run owns the chat's current run, so the owner message queues
 * behind it instead of joining it: the scheduled answer is delivered once by the durable outbox, the
 * owner message is answered once by its own run, and neither delivery is dropped or duplicated.
 */
async function withOriginRun(label, scheduledAnswer, body) {
  const store = await syntheticStore(label, { followUpMode: 'steer', cron: true });
  const origin = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
  const scheduledMessage = 'deliver the origin reminder';
  const ownerBatch = deferred();
  const runHeld = deferred();
  let releaseRun;
  const held = new Promise((resolve) => { releaseRun = resolve; });
  let scheduled = false;
  const dispatcher = (transcript) => {
    store.faux.appendResponses([dispatcher]);
    const input = userTexts(transcript.messages).at(-1) ?? '';
    if (input.startsWith(scheduledMessage)) {
      runHeld.resolve();
      return held.then(() => fauxAssistantMessage(scheduledAnswer));
    }
    if (input === 'schedule the reminder' && !scheduled) {
      scheduled = true;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          message: scheduledMessage,
          name: 'origin reminder',
          isolated: false,
          at: new Date(Date.now() + 1_500).toISOString(),
        }, { id: 'origin-cron-add' }),
      ], { stopReason: 'toolUse' });
    }
    if (input === 'owner message during the reminder') return fauxAssistantMessage('OWNER-OWN-ANSWER');
    return fauxAssistantMessage('Synthetic reply.');
  };
  store.faux.setResponses([dispatcher]);
  const transport = telegramMock([
    [textUpdate(120, 'schedule the reminder')],
    async () => {
      await ownerBatch.promise;
      return [textUpdate(121, 'owner message during the reminder')];
    },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await runHeld.promise;
    ownerBatch.resolve();
    // The scheduled run owns this conversation, so the owner message must not steer into it.
    await until(async () => {
      const inbox = await chatInbox(store.gateway);
      return inbox.followUp === 1 && inbox.steer === 0;
    }, 'the owner message to queue behind the scheduled run');
    releaseRun();
    await until(() => transport.rich.some((entry) => entry.text.includes('OWNER-OWN-ANSWER')), 'the owner answer');
    await until(async () => (await telegramState(store.gateway)).pending.length === 0, 'every reply delivery to settle');
    // The scheduled occurrence settles through its own task, not through the chat's pending queue.
    const chat = await store.gateway.conversationFor(origin, context);
    await until(async () => {
      const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
      return jobs.jobs[0]?.lastOutcome !== null && jobs.jobs[0]?.lastOutcome !== undefined;
    }, 'the scheduled occurrence to settle');
    await body({ store, transport, origin });
  } finally {
    releaseRun?.();
    ownerBatch.resolve();
    await cleanup(store, harness);
    transport.restore();
  }
}

test('an owner message admitted during an origin-mode run queues and its answer is not duplicated', { timeout: 40_000 }, async () => {
  await withOriginRun('cron-origin-shared', 'SCHEDULED-ORIGIN-RESULT', async ({ store, transport, origin }) => {
    await until(async () => (await store.gateway.cronOutbox.list(origin, context))
      .some((record) => record.status === 'delivered'), 'the scheduled delivery');
    // The scheduled answer travels once, and only through the durable outbox for that occurrence.
    assert.equal(transport.rich.filter((entry) => entry.text.includes('SCHEDULED-ORIGIN-RESULT')).length, 1);
    assert.equal(transport.rich.filter((entry) => entry.text.includes('OWNER-OWN-ANSWER')).length, 1);
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 1, 'one outbox record for the origin occurrence');
    assert.equal(records[0].status, 'delivered');
    assert.equal(records[0].text, 'SCHEDULED-ORIGIN-RESULT');
    // The origin chat keeps exactly its own policy: the scheduled run captured nothing and widened nothing.
    const chat = await store.gateway.conversationFor(origin, context);
    const names = ((await chat.agent(context)).tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
    assert.ok(names.includes('cron'), `cron ownership after the run: ${names}`);
    assert.ok(!names.includes('read'), `no captured tool widened the chat: ${names}`);
    const jobs = await store.gateway.harness.snapshot(CronJobsDoc, chat.id, context);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].mode, 'origin');
    assert.equal(jobs.jobs[0].lastOutcome.status, 'ok');
  });
});

test('a [SILENT] scheduled occurrence stays silent while the queued owner message is still answered', { timeout: 40_000 }, async () => {
  await withOriginRun('cron-origin-silent', '[SILENT]', async ({ store, transport, origin }) => {
    assert.equal(transport.rich.filter((entry) => entry.text.includes('[SILENT]')).length, 0);
    assert.equal(transport.rich.filter((entry) => entry.text.includes('OWNER-OWN-ANSWER')).length, 1);
    const records = await store.gateway.cronOutbox.list(origin, context);
    assert.equal(records.length, 0, 'a silent occurrence queues no scheduled delivery');
  });
});
