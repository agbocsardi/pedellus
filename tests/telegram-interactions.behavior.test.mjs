// Telegram interaction slice: command menu, quoted/replied-to context, authenticated reaction
// turns, and model-selected native reply/reaction actions through the actual Gateway tool path.
//
// No bot, credential or network: the Telegram transport is a mocked fetch and the model is a faux
// provider over a temporary store. Timers are never slept on; each wait is an explicit predicate.
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
  { runTelegram, TelegramState },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { ToolResultEntry },
  {
    TELEGRAM_REACTION_CONTEXT_LIMITS,
    retainReactionNote,
    takeReactionContextText,
  },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
  import(new URL('../dist/channels/telegram-interactions.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 10_000;
const BOT_ID = 7;
const CHAT_ID = 501;

function toolNames(agent) {
  return (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name)).sort();
}

async function syntheticStore(label, { allowFrom = ['501'], telegram = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-actions-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const faux = fauxProvider({ provider: 'tg-actions', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'tg-actions', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: [],
      ...(telegram ? { telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom } } : {}),
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, faux, gateway, config, model };
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

function messageUpdate(updateId, messageId, text, chatId = CHAT_ID, extra = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: privateChat(chatId),
      from: privateUser(chatId),
      ...extra,
    },
  };
}

/**
 * Let the next poll happen only after `predicate` holds, so a test can admit a message after an
 * earlier turn was answered instead of relying on a timer or an accidental same-batch grouping.
 */
function after(predicate, updates) {
  return async (signal) => {
    while (!predicate()) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    return updates;
  };
}

function reactionUpdate(updateId, messageId, userId, oldReaction, newReaction, chat = privateChat()) {
  return {
    update_id: updateId,
    message_reaction: {
      chat,
      message_id: messageId,
      user: privateUser(userId),
      date: Math.floor(Date.now() / 1000),
      old_reaction: oldReaction,
      new_reaction: newReaction,
    },
  };
}

/**
 * Mocked Bot API. `batches` are returned by successive getUpdates calls; once exhausted the call
 * holds until the adapter aborts, like the real long poll.
 */
function telegramMock(batches) {
  const original = globalThis.fetch;
  const sent = [];
  const sendAttempts = [];
  const reactions = [];
  const commands = [];
  let batchIndex = 0;
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
        id: BOT_ID, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      });
    }
    if (method === 'setMyCommands') {
      commands.push({ commands: body.commands, scope: body.scope });
      return response(true);
    }
    if (method === 'getUpdates') {
      if (batchIndex < batches.length) {
        const batch = batches[batchIndex++];
        if (typeof batch === 'function') {
          // A batch thunk lets a test admit later messages only after the earlier turn was answered.
          // Adapter shutdown still releases it, so a gated poll never outlives the test.
          return response(await batch(signal));
        }
        return response(batch);
      }
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendChatAction') return response(true);
    if (method === 'sendMessage') {
      const text = body.text ?? '';
      const replyTo = body.reply_parameters?.message_id;
      sendAttempts.push({ chatId: body.chat_id, text, replyTo });
      // An explicit 5xx for one text simulates an ambiguous external send outcome.
      if (text === 'UNKNOWN-REPLY') {
        return json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
      }
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text, messageId, replyTo });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        text,
      });
    }
    if (method === 'sendRichMessage') {
      const rich = body.rich_message ?? {};
      const text = rich.markdown ?? '';
      const replyTo = body.reply_parameters?.message_id;
      sendAttempts.push({ chatId: body.chat_id, text, replyTo, rich: true });
      if (text.startsWith('FALLBACK-LONG')) {
        return json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400);
      }
      if (text === 'UNKNOWN-REPLY') {
        return json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
      }
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text, messageId, replyTo, rich: true });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        rich_message: rich,
      });
    }
    if (method === 'setMessageReaction') {
      reactions.push({ chatId: body.chat_id, messageId: body.message_id, reaction: body.reaction });
      return response(true);
    }
    if (method === 'editMessageText' || method === 'deleteMessage') return response(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return { sent, sendAttempts, reactions, commands, restore() { globalThis.fetch = original; } };
}

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flush() {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function start(store, transport, allowFrom = ['501']) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: '123456:synthetic-token', allowFrom, pollTimeoutSeconds: 1,
  }, scope.context);
  return { scope, adapter, transport };
}

async function stop(harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
  harness?.transport?.restore();
}

async function cleanup(store, harness) {
  await stop(harness);
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

async function toolResults(conversation, id) {
  const items = (await conversation.entries({}, 200, undefined, context)).items;
  const results = items.filter(ToolResultEntry.is).map((entry) => {
    const message = entry.model?.[0];
    return {
      id: message?.toolCallId,
      isError: message?.isError === true,
      text: (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
    };
  });
  const result = results.find((candidate) => candidate.id === id);
  assert.ok(result, `synthetic ${id} call reached the transcript`);
  return result;
}

async function stateDoc(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

test('multipart plain native replies retain every message identity and actual part text', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('multipart-reply');
  const reply = 'FALLBACK-LONG' + 'a'.repeat(4096 - 13) + 'b'.repeat(3900);
  let issued = false;
  store.faux.setResponses(Array.from({ length: 8 }, () => () => {
    if (!issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'reply', messageId: 101, text: reply }, { id: 'multipart-1' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('MULTIPART-DONE');
  }));
  const transport = telegramMock([[messageUpdate(601, 101, 'request multipart reply')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'MULTIPART-DONE'), 'final answer');
    const parts = transport.sent.filter((entry) => entry.text.startsWith('FALLBACK-LONG') || /^b+$/.test(entry.text));
    assert.equal(parts.length, 2);
    assert.equal(parts[0].replyTo, 101);
    assert.equal(parts[1].replyTo, undefined);
    assert.equal(parts.map((part) => part.text).join(''), reply);
    const state = await stateDoc(store.gateway);
    const action = state.actions.find((entry) => entry.kind === 'reply' && entry.text === reply);
    assert.deepEqual(action.resultMessageIds, parts.map((part) => part.messageId));
    for (const part of parts) {
      const target = state.targets.find((entry) => entry.messageId === part.messageId);
      assert.ok(target, 'each accepted part is an observed target');
      assert.ok(part.text.startsWith(target.text.replace(/…\[truncated\]$/, '')),
        'the target excerpt comes from that part');
    }
    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'multipart-1');
    assert.equal(result.isError, false);
    for (const part of parts) assert.match(result.text, new RegExp(String(part.messageId)));
  } finally {
    await cleanup(store, harness);
  }
});

test('the native menu lists only implemented commands', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('menu');
  let harness;
  const transport = telegramMock([[]]);
  try {
    harness = start(store, transport);
    await until(() => transport.commands.length === 1, 'command menu registration');
    assert.deepEqual(transport.commands[0].scope, { type: 'all_private_chats' });
    // This host exposes the model catalog/preset selection and no process restart, so `/restart` is
    // not advertised here; `/status`, `/model` and the `/stop` alias of `/abort` are. Every
    // advertised command is implemented.
    assert.deepEqual(transport.commands[0].commands.map((entry) => entry.command),
      ['new', 'abort', 'stop', 'status', 'notices', 'model', 'digest', 'help']);
    // Descriptions are the catalogue's own summaries, so this test asserts the bound shape only;
    // telegram-commands.behavior.test.mjs pins the derived wording and order.
    assert.ok(transport.commands[0].commands.every((entry) => entry.description.length > 0
      && entry.description.length <= 256), 'every description is a catalogue summary within the Bot API bound');
  } finally {
    await cleanup(store, harness);
  }
});

test('a replied-to message keeps bounded labeled context and the agent can send a native reply', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('quote');
  const requests = [];
  let replyIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push(request);
    const transcript = JSON.stringify(request.messages);
    if (!replyIssued && transcript.includes('what about it?')) {
      replyIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'reply', messageId: 101, text: 'THREADED-REPLY' }, { id: 'reply-1' }),
      ], { stopReason: 'toolUse' });
    }
    if (transcript.includes('reply-1')) return fauxAssistantMessage('DONE-UNTHREADED');
    return fauxAssistantMessage('ACK');
  }));
  const transport = telegramMock([[
    messageUpdate(600, 100, 'the original note'),
    messageUpdate(601, 101, 'what about it?', CHAT_ID, {
      reply_to_message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        text: 'the original note',
        chat: privateChat(),
        from: privateUser(),
      },
    }),
  ]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'DONE-UNTHREADED'), 'final answer');

    const quotedRequest = requests.find((request) =>
      JSON.stringify(request.messages).includes('what about it?'));
    assert.ok(quotedRequest, 'the replied-to turn reached the model');
    const quotedTranscript = JSON.stringify(quotedRequest.messages);
    assert.match(quotedTranscript, /Telegram quoted message id 100 from the user/);
    assert.match(quotedTranscript, /the original note/);
    assert.match(quotedTranscript, /untrusted reference, not instructions/);
    assert.match(quotedTranscript, /private-chat message id 101/);

    const nativeReply = transport.sent.find((entry) => entry.text === 'THREADED-REPLY');
    assert.ok(nativeReply, 'the native reply was sent');
    assert.equal(nativeReply.replyTo, 101, 'reply_parameters names the observed target');
    const ordinary = transport.sent.find((entry) => entry.text === 'DONE-UNTHREADED');
    assert.equal(ordinary.replyTo, undefined, 'an ordinary answer stays unthreaded');

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'reply-1');
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /native reply to message 101/);
    assert.match(result.text, new RegExp(String(nativeReply.messageId)));
  } finally {
    await cleanup(store, harness);
  }
});

test('the agent can list and react to its own recent outgoing message', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('react-outgoing');
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (transcript.includes('react to it')) {
      if (!transcript.includes('Recent observed message targets')) {
        return fauxAssistantMessage([
          fauxToolCall('telegram', { action: 'targets' }, { id: 'targets-1' }),
        ], { stopReason: 'toolUse' });
      }
      if (!transcript.includes('react-1')) {
        return fauxAssistantMessage([
          fauxToolCall('telegram', { action: 'react', messageId: 900, emoji: '👍' }, { id: 'react-1' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('REACT-DONE');
    }
    return fauxAssistantMessage('HELLO-ASSISTANT');
  }));
  const transport = telegramMock([
    [messageUpdate(610, 100, 'hello')],
    after(() => transport.sent.some((entry) => entry.text === 'HELLO-ASSISTANT'),
      [messageUpdate(611, 101, 'react to it')]),
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'REACT-DONE'), 'final answer');

    const hello = transport.sent.find((entry) => entry.text === 'HELLO-ASSISTANT');
    assert.ok(hello, 'the assistant answer was sent');
    assert.equal(hello.replyTo, undefined);
    assert.deepEqual(transport.reactions, [{
      chatId: CHAT_ID,
      messageId: hello.messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    }]);

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const targets = await toolResults(chat, 'targets-1');
    assert.equal(targets.isError, false, targets.text);
    assert.match(targets.text, new RegExp(`id ${hello.messageId} \\(outgoing assistant\\)`));
    assert.match(targets.text, /HELLO-ASSISTANT/);
    const reacted = await toolResults(chat, 'react-1');
    assert.equal(reacted.isError, false, reacted.text);
    assert.match(reacted.text, /👍 reaction/);
  } finally {
    await cleanup(store, harness);
  }
});

test('the action tool exists only in mapped Telegram chat conversations', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('scopes', { allowFrom: ['501', '999'] });
  try {
    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    assert.ok(toolNames(await chat.agent(context)).includes('telegram'));
    store.faux.setResponses([() => fauxAssistantMessage('seed')]);
    const seed = await chat.submit({ type: 'input', content: 'seed' }, context);
    assert.equal((await seed.wait(context)).status, 'done');
    const otherChat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:999`, context);
    assert.ok(toolNames(await otherChat.agent(context)).includes('telegram'));

    const state = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
    assert.ok(!toolNames(await state.agent(context)).includes('telegram'));
    const cli = await store.gateway.conversationFor('cli:default', context);
    assert.ok(!toolNames(await cli.agent(context)).includes('telegram'));
    const root = await store.gateway.harness.root(context);
    assert.ok(!toolNames(await root.agent(context)).includes('telegram'));

    const raw = await store.gateway.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: { model: store.model } }, context);
    assert.ok(!toolNames(await raw.agent(context)).includes('telegram'),
      'a raw/task-owned conversation (the shape of a cron background target) gets no channel action tool');

    const entries = (await chat.entries({}, 50, undefined, context)).items;
    assert.ok(entries.length > 0, 'the mapped chat has an entry to fork at');
    const fork = await chat.fork(entries[0].id, {
      ownership: { kind: 'ownerless' }, agent: { model: store.model },
    }, context);
    assert.ok(!toolNames(await fork.agent(context)).includes('telegram'));
  } finally {
    await cleanup(store);
  }
});

test('a target observed in another chat cannot be replied to from this chat', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('cross-chat', { allowFrom: ['501', '999'] });
  let harness;
  let crossIssued = false;
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!crossIssued && transcript.includes('cross target')) {
      crossIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'reply', messageId: 200, text: 'CROSS-CHAT-REPLY' }, { id: 'cross-1' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  }));
  const transport = telegramMock([
    [messageUpdate(620, 100, 'chat one', CHAT_ID)],
    // Each later input is admitted only after the earlier turns were answered, so this test keeps
    // testing cross-chat authority rather than the coalescing window.
    after(() => transport.sent.filter((entry) => entry.text === 'ok').length >= 1,
      [messageUpdate(621, 200, 'chat two', 999)]),
    after(() => transport.sent.filter((entry) => entry.text === 'ok').length >= 2,
      [messageUpdate(622, 101, 'cross target', CHAT_ID)]),
  ]);
  try {
    harness = start(store, transport, ['501', '999']);
    await until(() => transport.sent.filter((entry) => entry.text === 'ok').length === 3, 'all three answers');
    assert.ok(!transport.sent.some((entry) => entry.text === 'CROSS-CHAT-REPLY'),
      'no cross-chat reply was sent');

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'cross-1');
    assert.equal(result.isError, true);
    assert.match(result.text, /not an observed message in this chat/);
  } finally {
    await cleanup(store, harness);
  }
});

test('reused provider call ids remain distinct and stored action results stay request-bound', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('action-identities', { allowFrom: ['501', '999'] });
  let harness;
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    const secondChat = JSON.stringify(request.messages).includes('second identity chat');
    if (!request.messages.some((message) => message.role === 'toolResult')) {
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'reply', messageId: secondChat ? 200 : 100,
          text: secondChat ? 'SECOND-NATIVE' : 'FIRST-NATIVE',
        }, { id: 'call_0' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(secondChat ? 'SECOND-DONE' : 'FIRST-DONE');
  }));
  const transport = telegramMock([[
    messageUpdate(625, 100, 'first identity chat'),
    messageUpdate(626, 200, 'second identity chat', 999),
  ]]);
  try {
    harness = start(store, transport, ['501', '999']);
    await until(() => transport.sent.some((entry) => entry.text === 'FIRST-DONE') &&
      transport.sent.some((entry) => entry.text === 'SECOND-DONE'), 'both identity turns');
    assert.equal(transport.sent.filter((entry) => entry.text === 'FIRST-NATIVE').length, 1);
    assert.equal(transport.sent.filter((entry) => entry.text === 'SECOND-NATIVE').length, 1);
    const doc = await stateDoc(store.gateway);
    assert.equal(doc.actions.length, 2);
    assert.equal(new Set(doc.actions.map((entry) => entry.callId)).size, 2,
      'provider call_0 is not the durable action identity');

    const host = store.gateway.telegramActions.current();
    const firstSession = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
    const secondSession = `telegram:${BOT_ID}:chat:999`;
    const request = { kind: 'reply', messageId: 100, text: 'BOUND-REPLY' };
    const applied = await host.act(firstSession, 'synthetic-collision', request, context);
    assert.equal(applied.ok, true);
    const repeated = await host.act(firstSession, 'synthetic-collision', request, context);
    assert.equal(repeated.ok, true);
    const otherChat = await host.act(secondSession, 'synthetic-collision', {
      kind: 'reply', messageId: 200, text: 'OTHER-CHAT',
    }, context);
    const changedPayload = await host.act(firstSession, 'synthetic-collision', {
      ...request, text: 'CHANGED-PAYLOAD',
    }, context);
    const changedKind = await host.act(firstSession, 'synthetic-collision', {
      kind: 'react', messageId: 100, emoji: '👍',
    }, context);
    for (const denied of [otherChat, changedPayload, changedKind]) {
      assert.equal(denied.ok, false);
      assert.match(denied.text, /different request/);
      assert.equal(denied.messageIds, undefined, 'a mismatched request cannot read the old result');
      assert.ok(!applied.messageIds.some((id) => denied.text.includes(String(id))));
    }
    assert.equal(transport.sent.filter((entry) => entry.text === 'BOUND-REPLY').length, 1);
    assert.equal(transport.reactions.length, 0);
  } finally {
    await cleanup(store, harness);
  }
});

test('unknown action evidence survives pruning and a full unknown log refuses new effects', async () => {
  const { admitAction, settleActionRecord, TELEGRAM_ACTION_LIMITS } =
    await import(new URL('../dist/channels/telegram-interactions.js', import.meta.url).href);
  const actions = [];
  const record = (callId) => ({
    callId, kind: 'reply', chatId: CHAT_ID, targetMessageId: 100,
    text: 'unresolved evidence', status: 'intent', nextChunkIndex: 0, startedAtMs: 1,
  });
  for (let index = 0; index < TELEGRAM_ACTION_LIMITS.total; index++) {
    const id = `unknown-${index}`;
    assert.equal(admitAction(actions, record(id)), 'admitted');
    settleActionRecord(actions, id, 'unknown');
  }
  assert.equal(actions.length, TELEGRAM_ACTION_LIMITS.total);
  assert.equal(admitAction(actions, record('would-evict')), 'full');
  assert.equal(actions.length, TELEGRAM_ACTION_LIMITS.total);
  assert.ok(actions.some((entry) => entry.callId === 'unknown-0'), 'old unknown evidence is retained');
});

test('authenticated reaction changes are passive context for the next owner input, never their own turn', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('reactions');
  const requests = [];
  store.faux.setResponses(Array.from({ length: 16 }, () => (request) => {
    requests.push(request);
    const transcript = JSON.stringify(request.messages);
    if (transcript.includes('next input')) return fauxAssistantMessage('SAW-CONTEXT');
    return fauxAssistantMessage('ACK-REACT');
  }));
  const validAdded = reactionUpdate(631, 100, 501, [], [{ type: 'emoji', emoji: '👍' }]);
  const deniedSender = reactionUpdate(632, 100, 502, [], [{ type: 'emoji', emoji: '🔥' }]);
  const groupReaction = reactionUpdate(633, 100, 501, [], [{ type: 'emoji', emoji: '🎉' }], {
    id: -100123, type: 'group', title: 'Synthetic group',
  });
  const anonymousCount = {
    update_id: 634,
    message_reaction_count: {
      chat: privateChat(), message_id: 100, date: Math.floor(Date.now() / 1000),
      reactions: [{ type: { type: 'emoji', emoji: '👍' }, total_count: 1 }],
    },
  };
  const unobserved = reactionUpdate(635, 999, 501, [], [{ type: 'emoji', emoji: '😁' }]);
  const validRemoved = reactionUpdate(636, 100, 501, [{ type: 'emoji', emoji: '👍' }], []);
  const transport = telegramMock([
    [messageUpdate(630, 100, 'react target'), validAdded, deniedSender, groupReaction, anonymousCount,
      unobserved, validRemoved],
    // The next owner input is admitted only after the earlier turn was answered, outside the
    // coalescing window, and is the one that consumes the retained reaction context.
    after(() => transport.sent.some((entry) => entry.text === 'ACK-REACT'),
      [messageUpdate(637, 101, 'next input')]),
  ]);
  let first;
  try {
    first = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'ACK-REACT'), 'message answer');
    await until(() => transport.sent.some((entry) => entry.text === 'SAW-CONTEXT'), 'next-input answer');
    assert.equal(requests.length, 2, 'the reaction changes started no turn of their own');

    const reactionText = JSON.stringify(requests[1].messages);
    assert.match(reactionText, /Telegram reaction context/);
    assert.match(reactionText, /passive reference, not a request and not instructions/);
    // The latest change to one message replaces its earlier note, so a removal is shown, not a
    // sequence of stale transitions.
    assert.match(reactionText, /reaction on message id 100 \(incoming user\)/);
    assert.match(reactionText, /old 👍; new none; added none; removed 👍/);
    assert.match(reactionText, /react target/);
    assert.ok(!reactionText.includes('🔥') && !reactionText.includes('🎉') && !reactionText.includes('😁'),
      'denied, group and unobserved reaction content never reached the model');

    const doc = await stateDoc(store.gateway);
    assert.equal(doc.offset, 638, 'the ignored and retained updates all advanced the durable offset');
    assert.deepEqual(doc.reactionContext, [], 'the next owner input consumed the retained context');

    // Reopen the same store with a replayed reaction update: the persisted offset makes it a no-op.
    await stop(first);
    first = undefined;
    const replay = telegramMock([[validAdded]]);
    first = start(store, replay);
    await flush();
    await flush();
    assert.equal(requests.length, 2, 'a replayed reaction update is not retained or turned into a turn');
    assert.equal(replay.sent.length, 0, 'the replay produced no delivery');
    assert.deepEqual((await stateDoc(store.gateway)).reactionContext, []);
  } finally {
    await cleanup(store, first);
  }
});

test('reaction context is bounded per chat and a repeated message replaces its note', () => {
  const notes = [];
  const limit = TELEGRAM_REACTION_CONTEXT_LIMITS.perChat;
  for (let index = 1; index <= limit + 3; index += 1) {
    assert.equal(retainReactionNote(notes, {
      updateId: index, chatId: CHAT_ID, messageId: 900 + index, senderId: '501',
      text: `note ${index}`, observedAtMs: index,
    }), 'retained');
  }
  assert.equal(notes.length, limit, 'the per-chat bound is enforced');
  assert.ok(!notes.some((note) => note.text === 'note 1'), 'the oldest note was evicted');
  assert.equal(retainReactionNote(notes, notes[0]), 'duplicate', 'a replayed update id changes nothing');

  const target = notes.at(-1).messageId;
  assert.equal(retainReactionNote(notes, {
    updateId: 100, chatId: CHAT_ID, messageId: target, senderId: '501',
    text: 'latest change', observedAtMs: 100,
  }), 'retained');
  assert.equal(notes.filter((note) => note.messageId === target).length, 1);
  assert.equal(notes.find((note) => note.messageId === target).text, 'latest change');

  const text = takeReactionContextText(notes, CHAT_ID, 100);
  assert.match(text, /latest change/);
  assert.equal(notes.length, 0, 'every note for the chat is consumed in the same read');
  assert.equal(takeReactionContextText(notes, CHAT_ID, 100), undefined);

  // A note older than the age bound is dropped instead of being attached to a much later input.
  retainReactionNote(notes, {
    updateId: 200, chatId: CHAT_ID, messageId: 500, senderId: '501',
    text: 'stale note', observedAtMs: 1,
  });
  assert.equal(takeReactionContextText(notes, CHAT_ID, 1 + TELEGRAM_REACTION_CONTEXT_LIMITS.maxAgeMs + 1), undefined);
  assert.equal(notes.length, 0);
});

test('consecutive ordinary owner messages from one chat coalesce into one ordered turn', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('coalesce', { allowFrom: ['501', '999'] });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    requests.push(request);
    return fauxAssistantMessage('COALESCED-ANSWER');
  }));
  const earlier = {
    message_id: 120,
    date: Math.floor(Date.now() / 1000),
    text: 'first line',
    chat: privateChat(),
    from: privateUser(),
  };
  const batch = [
    messageUpdate(700, 120, 'first line'),
    messageUpdate(701, 121, 'second line', CHAT_ID, { reply_to_message: earlier }),
    // A different chat never joins the window, even in the same poll batch.
    messageUpdate(702, 130, 'other chat line', 999),
  ];
  let transport = telegramMock([batch]);
  let first;
  try {
    first = start(store, transport, ['501', '999']);
    await until(() => transport.sent.filter((entry) => entry.text === 'COALESCED-ANSWER').length === 2,
      'one answer per chat');
    assert.equal(requests.length, 2, 'one turn per chat, not one per message');

    const transcripts = requests.map((request) => JSON.stringify(request.messages));
    const merged = transcripts.find((text) => text.includes('second line'));
    const single = transcripts.find((text) => text.includes('other chat line'));
    assert.ok(merged && single);
    assert.match(merged, /consecutive private-chat messages \(message ids 120, 121\) from the same sender/);
    assert.ok(merged.indexOf('first line') < merged.indexOf('second line'), 'arrival order is preserved');
    // The second message keeps its own quoted reply metadata inside the merged input.
    assert.match(merged, /Telegram quoted message id 120 from the user/);
    assert.ok(!merged.includes('other chat line'));
    assert.ok(!single.includes('first line'), 'the other chat never takes another chat\'s input');

    assert.equal(transport.sent.filter((entry) => entry.chatId === CHAT_ID && entry.text === 'COALESCED-ANSWER').length, 1);
    assert.equal(transport.sent.filter((entry) => entry.chatId === 999 && entry.text === 'COALESCED-ANSWER').length, 1);

    const doc = await stateDoc(store.gateway);
    assert.equal(doc.offset, 703);
    assert.deepEqual(doc.pending, [], 'every record settled, including both merged ones');

    // Replaying the same update batch after a reopen cannot admit a second copy of any message.
    await stop(first);
    first = undefined;
    transport = telegramMock([batch]);
    first = start(store, transport, ['501', '999']);
    await flush();
    await flush();
    assert.equal(requests.length, 2, 'a replayed batch is below the durable offset and starts no turn');
    assert.equal(transport.sent.length, 0);
  } finally {
    await stop(first);
    transport.restore();
    await cleanup(store);
  }
});

for (const boundary of ['sender', 'control']) {
  test(`coalescing stops at an intervening ${boundary} boundary`, { timeout: 15_000 }, async () => {
    const store = await syntheticStore(`coalesce-${boundary}`, { allowFrom: ['501', '999'] });
    const inputs = [];
    store.faux.setResponses(Array.from({ length: 10 }, () => (request) => {
      const last = request.messages.filter((message) => message.role === 'user').at(-1);
      inputs.push(typeof last.content === 'string' ? last.content : last.content.map((part) => part.text ?? '').join(''));
      return fauxAssistantMessage('BOUNDARY-ANSWER');
    }));
    const middle = boundary === 'sender'
      ? messageUpdate(801, 201, 'BOB-MIDDLE', CHAT_ID, { from: privateUser(999) })
      : messageUpdate(801, 201, '/help');
    const transport = telegramMock([[
      messageUpdate(800, 200, 'ALICE-FIRST'), middle,
      messageUpdate(802, 202, 'ALICE-LAST'),
    ]]);
    let harness;
    try {
      harness = start(store, transport, ['501', '999']);
      const count = boundary === 'sender' ? 3 : 2;
      await until(() => inputs.length === count && transport.sent.filter((entry) => entry.text === 'BOUNDARY-ANSWER').length === count,
        'separate boundary turns');
      assert.ok(inputs[0].includes('ALICE-FIRST'));
      assert.ok(inputs.at(-1).includes('ALICE-LAST'));
      assert.ok(!inputs.some((text) => text.includes('ALICE-FIRST') && text.includes('ALICE-LAST')));
      if (boundary === 'sender') assert.ok(inputs[1].includes('BOB-MIDDLE'));
    } finally {
      await stop(harness);
      transport.restore();
      await cleanup(store);
    }
  });
}

test('an ambiguous action send is quarantined and never resent, including across reopen', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('unknown-action');
  let harness;
  // Seed an interrupted write-ahead action: recovery must quarantine it without sending.
  const stateConversation = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  await stateConversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, stateConversation.id);
    doc.actions.push({
      callId: 'seeded-sending',
      kind: 'reply',
      chatId: CHAT_ID,
      targetMessageId: 100,
      text: 'SEEDED-NEVER-SENT',
      status: 'sending',
      nextChunkIndex: 0,
      startedAtMs: Date.now(),
    });
  }, context);

  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!transcript.includes('unknown-1') && transcript.includes('reply with unknown outcome')) {
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'reply', messageId: 640, text: 'UNKNOWN-REPLY' }, { id: 'unknown-1' }),
      ], { stopReason: 'toolUse' });
    }
    if (transcript.includes('unknown-1')) return fauxAssistantMessage('AFTER-UNKNOWN');
    return fauxAssistantMessage('idle');
  }));
  const transport = telegramMock([[messageUpdate(640, 640, 'reply with unknown outcome')]]);
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'AFTER-UNKNOWN'), 'final answer');

    assert.equal(transport.sent.filter((entry) => entry.text === 'UNKNOWN-REPLY').length, 0,
      'the mocked ambiguous send was attempted once and accepted nowhere');
    assert.equal(transport.sendAttempts.filter((entry) => entry.text === 'UNKNOWN-REPLY').length, 1,
      'exactly one external send attempt was made');
    assert.equal(transport.sent.filter((entry) => entry.text === 'SEEDED-NEVER-SENT').length, 0,
      'an interrupted intent is never sent on reopen');
    assert.equal(transport.sent.find((entry) => entry.text === 'AFTER-UNKNOWN').replyTo, undefined);

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'unknown-1');
    assert.equal(result.isError, true);
    assert.match(result.text, /may or may not have been applied/);

    const doc = await stateDoc(store.gateway);
    assert.equal(doc.actions.find((entry) => entry.text === 'UNKNOWN-REPLY').status, 'unknown');
    assert.equal(doc.actions.find((entry) => entry.callId === 'seeded-sending').status, 'unknown');

    // Reopen with the same update: the durable offset prevents a second turn and no action is resent.
    await stop(harness);
    harness = undefined;
    const replay = telegramMock([[messageUpdate(640, 640, 'reply with unknown outcome')]]);
    harness = start(store, replay);
    await flush();
    await flush();
    assert.equal(replay.sent.length, 0, 'reopen sends nothing for the quarantined action');
    assert.equal(replay.sendAttempts.length, 0, 'reopen makes no external action attempt');
  } finally {
    await cleanup(store, harness);
  }
});
