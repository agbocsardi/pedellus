// Best-effort Telegram typing feedback: an active inbound turn refreshes sendChatAction until it
// settles, overlapping queued turns share one loop, shutdown clears it, and a rejected action never
// blocks the final reply. Timers are controlled through node:test mock timers; the model is held by
// an explicit promise and the Telegram transport is a mocked fetch. No sleep-based waits.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { runTelegram },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 10_000;

async function syntheticStore(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-typing-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const faux = fauxProvider({ provider: 'typing', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'typing', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: [],
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, faux, gateway };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function update(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: 501, type: 'private', first_name: 'Synthetic' },
      from: { id: 501, is_bot: false, first_name: 'Synthetic' },
    },
  };
}

function telegramMock(identity, updates, actionFailure) {
  const original = globalThis.fetch;
  const actions = [];
  const sent = [];
  let polled = false;
  let nextMessageId = 900;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const response = (result) => json({ ok: true, result });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const signal = init.signal;
    if (method === 'getMe') {
      return response({
        id: identity, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      });
    }
    if (method === 'getUpdates') {
      if (!polled) {
        polled = true;
        return response(updates);
      }
      // The adapter's long poll: hold until the test stops it, then reject like a real abort.
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendChatAction') {
      actions.push({ chatId: body.chat_id, action: body.action });
      return actionFailure === undefined
        ? response(true)
        : json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
    }
    if (method === 'sendMessage') {
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text: body.text ?? '', messageId });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        text: body.text ?? '',
      });
    }
    if (method === 'sendRichMessage') {
      const messageId = nextMessageId++;
      const rich = body.rich_message ?? {};
      sent.push({ chatId: body.chat_id, text: rich.markdown ?? '', messageId, rich });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        rich_message: rich,
      });
    }
    if (method === 'editMessageText' || method === 'deleteMessage') return response(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return { actions, sent, restore() { globalThis.fetch = original; } };
}

/** Yield through pending promises and I/O without depending on the mocked timer API. */
async function flush() {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function start(store, transport) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: '123456:synthetic-token', allowFrom: ['501'], pollTimeoutSeconds: 1,
  }, scope.context);
  return { scope, adapter, transport };
}

async function cleanup(store, harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
  harness?.transport?.restore();
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

test('typing starts during a held model turn, refreshes, and stops at settlement', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('held');
  let harness;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  store.faux.setResponses([async () => {
    await held;
    return fauxAssistantMessage('TYPING-DONE');
  }]);
  try {
    harness = await start(store, telegramMock(7, [update(700, 'slow request')]));

    await until(() => harness.transport.actions.length === 1, 'initial typing action');
    assert.deepEqual(harness.transport.actions[0], { chatId: 501, action: 'typing' });
    assert.equal(harness.transport.sent.length, 0, 'the model turn is still held');

    t.mock.timers.tick(4_000);
    await until(() => harness.transport.actions.length === 2, 'typing refresh during the held turn');
    assert.equal(harness.transport.sent.length, 0, 'refresh does not deliver before the answer');

    release();
    await until(() => harness.transport.sent.some((entry) => entry.text === 'TYPING-DONE'), 'final reply');
    await flush();
    const settledActions = harness.transport.actions.length;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(harness.transport.actions.length, settledActions, 'no refresh after settlement');
  } finally {
    await cleanup(store, harness);
  }
});

test('overlapping queued turns share one typing loop and shutdown ends it', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('queued');
  let harness;
  // Model calls are issued in submission order; hold each one explicitly instead of inferring a
  // turn from the shared conversation transcript.
  const resolvers = [];
  const gate = () => new Promise((resolve) => { resolvers.push(resolve); });
  const gates = [gate(), gate(), gate()];
  let calls = 0;
  store.faux.setResponses(Array.from({ length: 8 }, () => async () => {
    const index = calls++;
    if (index < gates.length) await gates[index];
    return fauxAssistantMessage(`reply:${index}`);
  }));
  try {
    harness = await start(store, telegramMock(7, [
      update(710, 'first'), update(711, 'second'), update(712, 'third'),
    ]));

    await until(() => harness.transport.actions.length === 1, 'one typing loop for the chat');
    await flush();
    assert.equal(harness.transport.actions.length, 1, 'queued turns do not start a second loop');

    t.mock.timers.tick(4_000);
    await until(() => harness.transport.actions.length === 2, 'one shared refresh');
    await flush();
    assert.equal(harness.transport.actions.length, 2, 'no duplicate overlapping refresh');

    resolvers[0]();
    resolvers[1]();
    await until(() => harness.transport.sent.some((entry) => entry.text === 'reply:0')
      && harness.transport.sent.some((entry) => entry.text === 'reply:1'), 'both released replies');

    // The third turn never settles, so the shared loop keeps running for it.
    t.mock.timers.tick(4_000);
    await until(() => harness.transport.actions.length === 3, 'refresh for the remaining turn');

    harness.scope.cancel(new DOMException('test finished', 'AbortError'));
    await harness.adapter.catch(() => undefined);
    const stoppedActions = harness.transport.actions.length;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(harness.transport.actions.length, stoppedActions, 'shutdown clears the refresh timer');

    // The adapter stopped, but Durable's model work for the third turn continues independently.
    resolvers[2]();
    await flush();
  } finally {
    await cleanup(store, harness);
  }
});

test('a rejected typing action never blocks the reply', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('rejected');
  let harness;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  store.faux.setResponses([async () => {
    await held;
    return fauxAssistantMessage('REPLY-AFTER-TYPING-FAILURE');
  }]);
  try {
    harness = await start(store, telegramMock(7, [update(720, 'typing fails')], 400));

    await until(() => harness.transport.actions.length === 1, 'rejected typing attempt');
    release();
    await until(() => harness.transport.sent.some((entry) => entry.text === 'REPLY-AFTER-TYPING-FAILURE'),
      'reply after the rejected typing action');
    await flush();
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(harness.transport.actions.length, 1, 'a failed action does not retry or linger');
  } finally {
    await cleanup(store, harness);
  }
});
