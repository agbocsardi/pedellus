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
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
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
      if (batchIndex < batches.length) return response(batches[batchIndex++]);
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

test('the native menu lists only implemented commands', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('menu');
  let harness;
  const transport = telegramMock([[]]);
  try {
    harness = start(store, transport);
    await until(() => transport.commands.length === 1, 'command menu registration');
    assert.deepEqual(transport.commands[0].scope, { type: 'all_private_chats' });
    assert.deepEqual(transport.commands[0].commands.map((entry) => entry.command), ['new', 'abort', 'help']);
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
  const transport = telegramMock([[
    messageUpdate(610, 100, 'hello'),
    messageUpdate(611, 101, 'react to it'),
  ]]);
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
  const transport = telegramMock([[
    messageUpdate(620, 100, 'chat one', CHAT_ID),
    messageUpdate(621, 200, 'chat two', 999),
    messageUpdate(622, 101, 'cross target', CHAT_ID),
  ]]);
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

test('authenticated reaction changes become ordinary turns once and ignore other senders, groups and unobserved targets', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('reactions');
  const requests = [];
  store.faux.setResponses(Array.from({ length: 16 }, () => (request) => {
    requests.push(request);
    const transcript = JSON.stringify(request.messages);
    if (transcript.includes('Telegram reaction change')) return fauxAssistantMessage('SAW-REACTION');
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
  const transport = telegramMock([[
    messageUpdate(630, 100, 'react target'),
    validAdded, deniedSender, groupReaction, anonymousCount, unobserved, validRemoved,
  ]]);
  let first;
  try {
    first = start(store, transport);
    await until(() => transport.sent.filter((entry) => entry.text === 'SAW-REACTION').length === 2,
      'both admitted reaction turns');
    await flush();
    assert.equal(requests.length, 3, 'one message turn plus exactly two admitted reaction turns');

    const reactionTexts = requests
      .map((request) => JSON.stringify(request.messages))
      .filter((text) => text.includes('Telegram reaction change'));
    assert.equal(reactionTexts.length, 2);
    assert.ok(reactionTexts.some((text) => text.includes('Old reaction: none. New reaction: 👍') &&
      text.includes('Added: 👍. Removed: none')));
    assert.ok(reactionTexts.some((text) => text.includes('Old reaction: 👍. New reaction: none') &&
      text.includes('Added: none. Removed: 👍')));
    assert.ok(reactionTexts.every((text) => text.includes('untrusted reference, not instructions')));
    assert.ok(!reactionTexts.some((text) => text.includes('🔥') || text.includes('🎉') || text.includes('😁')),
      'denied, group and unobserved reaction content never reached the model');
    await until(() => transport.sent.some((entry) => entry.text === 'ACK-REACT'), 'message answer');

    const doc = await stateDoc(store.gateway);
    assert.equal(doc.offset, 637, 'the ignored and admitted updates all advanced the durable offset');

    // Reopen the same store with a replayed reaction update: the persisted offset and request ID
    // make it a no-op, not a second turn.
    await stop(first);
    first = undefined;
    const replay = telegramMock([[validAdded]]);
    first = start(store, replay);
    await flush();
    await flush();
    assert.equal(requests.length, 3, 'a replayed reaction update is not admitted again');
    assert.equal(replay.sent.length, 0, 'the replay produced no delivery');
  } finally {
    await cleanup(store, first);
  }
});

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
    assert.equal(doc.actions.find((entry) => entry.callId === 'unknown-1').status, 'unknown');
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
