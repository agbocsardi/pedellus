// Telegram reply context: a quoted message is read from the admitted update itself, including a
// received rich-message block tree, so a scheduled or ordinary rich delivery stays readable when
// the owner replies to it. Covers the durable-target non-erasure rule, an episode reset, a store
// reopen with the target absent from any cache, cross-chat refusal and explicit partial quotes.
//
// No bot, credential or network: the Bot API is a mocked fetch with a queued long poll and the
// model is a faux provider over a temporary store. Every wait is an explicit predicate with a
// bounded deadline; nothing sleeps on a schedule.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { scheduledContent } from './fixtures/cron-input.mjs';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { runTelegram, TelegramState },
  { telegramMessageContent },
  { observeTarget },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram-content.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram-interactions.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const BOT_ID = 7;
const CHAT_ID = 501;

async function syntheticStore(label, { cron = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-reply-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const faux = fauxProvider({ provider: 'tg-reply', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'tg-reply', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: [],
      ...(cron ? { cron: { enabled: true } } : {}),
      telegram: { tokenEnv: 'TG_REPLY_SYNTHETIC_TOKEN', allowFrom: ['501'] },
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, faux, models, config, gateway };
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

function botUser() {
  return { id: BOT_ID, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' };
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

/** A reply update whose replied-to message is delivered with the given received message fields. */
function replyUpdate(updateId, messageId, text, quoted, chatId = CHAT_ID) {
  return messageUpdate(updateId, messageId, text, chatId, {
    reply_to_message: {
      message_id: quoted.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(quoted.chatId ?? chatId),
      from: quoted.from ?? privateUser(),
      ...quoted.fields,
    },
  });
}

/**
 * Mocked Bot API with a real long poll: queued updates are returned, and when the queue is empty the
 * call holds until `enqueue` supplies more or the adapter aborts. `sendRichMessage` answers with the
 * received rich shape (`rich_message.blocks`), never the input mirror (`rich_message.markdown`).
 */
function telegramMock(identity, initial = []) {
  const original = globalThis.fetch;
  const sent = [];
  const listeners = new Set();
  let queue = [...initial];
  let held;
  let nextMessageId = 900;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const response = (result) => json({ ok: true, result });
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const flush = () => {
    if (held === undefined || queue.length === 0) return;
    const resolve = held;
    held = undefined;
    const batch = queue;
    queue = [];
    resolve(response(batch));
  };
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
    if (method === 'setMyCommands') return response(true);
    if (method === 'getUpdates') {
      if (queue.length > 0) {
        const batch = queue;
        queue = [];
        return response(batch);
      }
      return await new Promise((resolve, reject) => {
        held = resolve;
        const aborted = () => {
          if (held === resolve) held = undefined;
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendChatAction') return response(true);
    if (method === 'sendMessage') {
      const messageId = nextMessageId++;
      const text = body.text ?? '';
      sent.push({ chatId: body.chat_id, text, messageId });
      notify();
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        text,
      });
    }
    if (method === 'sendRichMessage') {
      const messageId = nextMessageId++;
      const markdown = body.rich_message?.markdown ?? '';
      // Telegram renders the markdown and delivers a block tree to the bot; a plain single-paragraph
      // body is the exact received shape this mock reports back and later quotes.
      const blocks = [{ type: 'paragraph', text: markdown }];
      sent.push({ chatId: body.chat_id, text: markdown, messageId, blocks, rich: true });
      notify();
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        rich_message: { blocks },
      });
    }
    if (method === 'editMessageText' || method === 'deleteMessage') return response(true);
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return {
    sent,
    enqueue(updates) {
      queue.push(...updates);
      flush();
    },
    waitForText(predicate, label) {
      const existing = sent.find((entry) => predicate(entry.text));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const listener = () => {
          const match = sent.find((entry) => predicate(entry.text));
          if (match === undefined) return;
          listeners.delete(listener);
          clearTimeout(timer);
          resolve(match);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for ${label}`));
        }, WAIT_MS);
        listeners.add(listener);
      });
    },
    restore() {
      for (const listener of listeners) listeners.delete(listener);
      globalThis.fetch = original;
    },
  };
}

function start(store, transport) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: '123456:synthetic-token', allowFrom: ['501'], pollTimeoutSeconds: 1,
  }, scope.context);
  return { scope, adapter };
}

async function stop(harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
}

async function closeStore(store) {
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

/** The last user input in a request, so quoted or tool text never impersonates a new turn. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    return typeof message.content === 'string'
      ? message.content
      : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

function requestText(messages) {
  return JSON.stringify(messages);
}

async function stateDoc(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

test('received message shapes become bounded excerpts and honest labels, never an empty quote', () => {
  const text = telegramMessageContent({
    message_id: 1,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    text: 'plain note',
    entities: [{ type: 'bold', offset: 0, length: 5 }],
  });
  assert.deepEqual(text, { source: 'text', text: 'plain note' });

  const caption = telegramMessageContent({
    message_id: 2,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    photo: [{ file_id: 'f', file_unique_id: 'u', width: 4, height: 4 }],
    caption: 'photo caption',
    caption_entities: [{ type: 'italic', offset: 0, length: 5 }],
  });
  assert.deepEqual(caption, { source: 'text', text: 'photo caption' });

  const photoOnly = telegramMessageContent({
    message_id: 3,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    photo: [{ file_id: 'f', file_unique_id: 'u', width: 4, height: 4 }],
  });
  assert.equal(photoOnly.source, 'unreadable');
  assert.match(photoOnly.text, /photo message without readable text/u);

  const empty = telegramMessageContent({
    message_id: 4,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    text: '',
  });
  assert.equal(empty.source, 'empty');
  assert.equal(empty.text, '[empty message]');

  const emptyRich = telegramMessageContent({
    message_id: 5,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: { blocks: [] },
  });
  assert.equal(emptyRich.source, 'empty');
  assert.equal(emptyRich.text, '[empty rich message]');

  const rich = telegramMessageContent({
    message_id: 6,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: {
      blocks: [
        {
          type: 'paragraph',
          text: [
            'Hello ',
            { type: 'bold', text: 'world' },
            { type: 'custom_emoji', custom_emoji_id: '5068324170671202286', alternative_text: '👍' },
            { type: 'url', text: ' (link label)', url: 'https://example.invalid/private-path' },
            { type: 'mathematical_expression', expression: '$x^2$' },
          ],
        },
        { type: 'divider' },
        { type: 'list', items: [{ label: '-', blocks: [{ type: 'paragraph', text: 'list item' }] }] },
        {
          type: 'table',
          cells: [[
            { text: 'cell one', align: 'left', valign: 'top' },
            { text: 'cell two', align: 'left', valign: 'top' },
          ]],
        },
        {
          type: 'buttons',
          buttons: [{ text: 'Run it', callback_data: 'callback-secret' }],
        },
        {
          type: 'photo',
          photo: [{ file_id: 'file-id-secret', file_unique_id: 'unique-secret', width: 9, height: 9 }],
          caption: { text: 'rich photo caption' },
        },
      ],
    },
  });
  assert.equal(rich.source, 'rich');
  for (const expected of ['Hello world👍', '(link label)', '$x^2$', 'list item', 'cell one', 'cell two',
    'rich photo caption']) {
    assert.ok(rich.text.includes(expected), `rich excerpt keeps ${expected}`);
  }
  for (const hidden of ['example.invalid', 'callback-secret', 'file-id-secret', 'unique-secret',
    '5068324170671202286']) {
    assert.equal(rich.text.includes(hidden), false, `rich excerpt drops ${hidden}`);
  }

  const onlyMedia = telegramMessageContent({
    message_id: 7,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: {
      blocks: [{ type: 'photo', photo: [{ file_id: 'f', file_unique_id: 'u', width: 4, height: 4 }] }],
    },
  });
  assert.equal(onlyMedia.source, 'unreadable');
  assert.equal(onlyMedia.text, '[rich message without readable text]');

  // A malformed or input-shaped payload never crashes the reply path and never becomes text.
  const unsupported = telegramMessageContent({
    message_id: 8,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: { markdown: '# not a received shape' },
  });
  assert.equal(unsupported.source, 'empty');
  assert.equal(unsupported.text, '[empty rich message]');

  // Nesting and length are bounded, and truncation is marked rather than silently dropping text.
  let deep = { type: 'bold', text: 'deep text' };
  for (let level = 0; level < 40; level += 1) deep = { type: 'bold', text: deep };
  const nested = telegramMessageContent({
    message_id: 9,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: { blocks: [{ type: 'paragraph', text: deep }] },
  });
  assert.equal(nested.source, 'unreadable', 'content beyond the nesting budget is labeled, not guessed at');
  assert.equal(nested.text, '[rich message without readable text]');

  const longRich = telegramMessageContent({
    message_id: 10,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    rich_message: { blocks: [{ type: 'paragraph', text: 'y'.repeat(1_500) }] },
  });
  assert.equal(longRich.source, 'rich');
  assert.ok(longRich.text.endsWith('…[truncated]'), 'length-bound truncation is marked');
  assert.ok(longRich.text.length < 700);

  const long = telegramMessageContent({
    message_id: 11,
    date: 0,
    chat: { id: CHAT_ID, type: 'private' },
    text: 'x'.repeat(1_500),
  });
  assert.equal(long.source, 'text');
  assert.ok(long.text.length > 600, 'plain text is bounded later by the shared excerpt sanitizer');
});

test('a target keeps its earlier readable excerpt when a later observation cannot read text', () => {
  const doc = { targets: [] };
  observeTarget(doc, {
    chatId: CHAT_ID, messageId: 100, direction: 'incoming', senderId: '501',
    text: 'the original note', textSource: 'text', observedAtMs: 1_000,
  });
  observeTarget(doc, {
    chatId: CHAT_ID, messageId: 100, direction: 'incoming', senderId: '501',
    text: '[photo message without readable text]', textSource: 'unreadable', observedAtMs: 2_000,
  });
  assert.equal(doc.targets.length, 1);
  assert.equal(doc.targets[0].text, 'the original note');
  assert.equal(doc.targets[0].textSource, 'text');
  assert.equal(doc.targets[0].observedAtMs, 1_000, 'the readable snapshot keeps its own time');

  observeTarget(doc, {
    chatId: CHAT_ID, messageId: 100, direction: 'incoming', senderId: '501',
    text: 'the edited note', textSource: 'text', observedAtMs: 3_000,
  });
  assert.equal(doc.targets[0].text, 'the edited note');
  assert.equal(doc.targets[0].observedAtMs, 3_000);
});

test('an ordinary rich delivery quoted by reply reaches the model as readable reference context', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('ordinary-rich');
  const requests = [];
  const answer = 'REMINDER: water the plants';
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push(request);
    const input = lastUserText(request.messages);
    return input.includes('what was that reminder?')
      ? fauxAssistantMessage('QUOTE-SEEN')
      : fauxAssistantMessage(answer);
  }));
  const transport = telegramMock(BOT_ID, [messageUpdate(700, 100, 'send the reminder')]);
  let harness;
  try {
    harness = start(store, transport);
    const delivered = await transport.waitForText((text) => text === answer, 'the ordinary rich answer');
    assert.equal(delivered.rich, true);
    transport.enqueue([replyUpdate(701, 101, 'what was that reminder?', {
      messageId: delivered.messageId,
      fields: { from: botUser(), rich_message: { blocks: delivered.blocks } },
    })]);
    await transport.waitForText((text) => text === 'QUOTE-SEEN', 'the reply turn answer');

    const quoted = requests.find((request) =>
      lastUserText(request.messages).includes('what was that reminder?'));
    assert.ok(quoted, 'the reply turn reached the model');
    const transcript = requestText(quoted.messages);
    assert.match(transcript, new RegExp(`Telegram quoted message id ${delivered.messageId} from the assistant`));
    assert.match(transcript, /REMINDER: water the plants/);
    assert.equal(transcript.includes(`from the assistant: ""`), false, 'the quote is never empty');

    const state = await stateDoc(store.gateway);
    const target = state.targets.find((entry) => entry.messageId === delivered.messageId);
    assert.ok(target, 'the quoted message is an observed target');
    assert.match(target.text, /REMINDER: water the plants/);
    assert.equal(target.textSource, 'rich');
  } finally {
    await stop(harness);
    transport.restore();
    await closeStore(store);
  }
});

test('a real scheduled rich delivery quoted by reply reaches the model as readable context', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('scheduled-rich', { cron: true });
  const requests = [];
  const scheduledMessage = 'deliver the scheduled reminder';
  const answer = 'SCHEDULED: take the bins out';
  let scheduled = false;
  store.faux.setResponses(Array.from({ length: 20 }, () => (request) => {
    requests.push(request);
    const input = lastUserText(request.messages);
    if (input === scheduledContent(scheduledMessage)) return fauxAssistantMessage(answer);
    if (input.includes('what was the scheduled reminder?')) return fauxAssistantMessage('CRON-QUOTE-SEEN');
    if (input === 'schedule the reminder' && !scheduled) {
      scheduled = true;
      return fauxAssistantMessage([
        fauxToolCall('cron', {
          action: 'add',
          message: scheduledMessage,
          name: 'scheduled rich reminder',
          isolated: false,
          at: new Date(Date.now() + 500).toISOString(),
        }, { id: 'cron-rich-add' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Scheduled.');
  }));
  const transport = telegramMock(BOT_ID, [messageUpdate(710, 100, 'schedule the reminder')]);
  let harness;
  try {
    harness = start(store, transport);
    const delivered = await transport.waitForText((text) => text === answer, 'the scheduled rich send');
    assert.equal(delivered.rich, true, 'scheduled delivery uses the rich send');
    transport.enqueue([replyUpdate(711, 101, 'what was the scheduled reminder?', {
      messageId: delivered.messageId,
      fields: { from: botUser(), rich_message: { blocks: delivered.blocks } },
    })]);
    await transport.waitForText((text) => text === 'CRON-QUOTE-SEEN', 'the reply turn answer');

    const quoted = requests.find((request) =>
      lastUserText(request.messages).includes('what was the scheduled reminder?'));
    assert.ok(quoted, 'the reply to the scheduled delivery reached the model');
    const transcript = requestText(quoted.messages);
    assert.match(transcript, new RegExp(`Telegram quoted message id ${delivered.messageId} from the assistant`));
    assert.match(transcript, /SCHEDULED: take the bins out/);
    assert.equal(transcript.includes(`from the assistant: ""`), false, 'the quote is never empty');

    const state = await stateDoc(store.gateway);
    const target = state.targets.find((entry) => entry.messageId === delivered.messageId);
    assert.ok(target);
    assert.match(target.text, /SCHEDULED: take the bins out/);
  } finally {
    await stop(harness);
    transport.restore();
    await closeStore(store);
  }
});

test('a reset episode keeps the readable excerpt and labels an unreadable reply body', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('episode-reset');
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push(request);
    return lastUserText(request.messages).includes('what was that note?')
      ? fauxAssistantMessage('EPISODE-SEEN')
      : fauxAssistantMessage('ACK');
  }));
  const transport = telegramMock(BOT_ID, [messageUpdate(720, 100, 'the original note')]);
  let harness;
  try {
    harness = start(store, transport);
    await transport.waitForText((text) => text === 'ACK', 'the first answer');
    const before = await stateDoc(store.gateway);
    const first = before.targets.find((entry) => entry.messageId === 100);
    assert.equal(first.text, 'the original note');

    transport.enqueue([messageUpdate(721, 101, '/new')]);
    await transport.waitForText((text) => text === 'Context reset.', 'the reset acknowledgement');
    transport.enqueue([replyUpdate(722, 102, 'what was that note?', {
      messageId: 100,
      fields: {
        from: privateUser(),
        photo: [{ file_id: 'f', file_unique_id: 'u', width: 4, height: 4 }],
      },
    })]);
    await transport.waitForText((text) => text === 'EPISODE-SEEN', 'the post-reset answer');

    const quoted = requests.find((request) =>
      lastUserText(request.messages).includes('what was that note?'));
    assert.ok(quoted);
    const transcript = requestText(quoted.messages);
    assert.match(transcript, /Telegram quoted message id 100 from the user/);
    assert.match(transcript, /photo message without readable text/);
    assert.equal(transcript.includes('from the user: ""'), false);

    const after = await stateDoc(store.gateway);
    const retained = after.targets.find((entry) => entry.messageId === 100);
    assert.equal(retained.text, 'the original note', 'an unreadable re-observation never erases known text');
    assert.equal(retained.textSource, 'text');
    assert.equal(retained.observedAtMs, first.observedAtMs);
  } finally {
    await stop(harness);
    transport.restore();
    await closeStore(store);
  }
});

test('a reopened store quotes a nested rich message that was never in the target cache', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('reopen-rich');
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) =>
    lastUserText(request.messages).includes('summarize the quoted note')
      ? fauxAssistantMessage('REOPEN-SEEN')
      : fauxAssistantMessage('ACK')));
  let transport = telegramMock(BOT_ID, [messageUpdate(730, 100, 'hello')]);
  let harness;
  try {
    harness = start(store, transport);
    await transport.waitForText((text) => text === 'ACK', 'the first answer');
    await stop(harness);
    harness = undefined;
    transport.restore();
    await store.gateway.close(context);

    store.gateway = await openGateway(store.config, context, { models: store.models });
    transport = telegramMock(BOT_ID, []);
    harness = start(store, transport);
    const requests = [];
    const request = (candidate) => {
      requests.push(candidate);
      return lastUserText(candidate.messages).includes('summarize the quoted note')
        ? fauxAssistantMessage('REOPEN-SEEN')
        : fauxAssistantMessage('ACK');
    };
    store.faux.setResponses(Array.from({ length: 12 }, () => request));

    transport.enqueue([replyUpdate(731, 101, 'summarize the quoted note', {
      messageId: 555,
      fields: {
        from: privateUser(),
        rich_message: {
          blocks: [
            {
              type: 'blockquote',
              blocks: [{
                type: 'list',
                items: [{ label: '-', blocks: [{ type: 'paragraph', text: 'nested reminder item' }] }],
              }],
            },
            { type: 'paragraph', text: 'plain paragraph after the quote' },
            {
              type: 'photo',
              photo: [{ file_id: 'f', file_unique_id: 'u', width: 4, height: 4 }],
              caption: { text: 'rich photo caption' },
            },
          ],
        },
      },
    })]);
    await transport.waitForText((text) => text === 'REOPEN-SEEN', 'the reopened reply answer');

    const quoted = requests.find((candidate) =>
      lastUserText(candidate.messages).includes('summarize the quoted note'));
    assert.ok(quoted, 'the reopened reply reached the model without any cached target');
    const transcript = requestText(quoted.messages);
    assert.match(transcript, /Telegram quoted message id 555 from the user/);
    for (const expected of ['nested reminder item', 'plain paragraph after the quote', 'rich photo caption']) {
      assert.ok(transcript.includes(expected), `quoted rich excerpt keeps ${expected}`);
    }

    const state = await stateDoc(store.gateway);
    const target = state.targets.find((entry) => entry.messageId === 555);
    assert.ok(target, 'the quoted rich message becomes a durable target');
    assert.equal(target.textSource, 'rich');
  } finally {
    await stop(harness);
    transport.restore();
    // A reopen that failed after the first close must not hide its own error behind a second close.
    await store.gateway.close(context).catch(() => undefined);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('a cross-chat reply grants no quote or target, and an explicit partial quote is used', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('cross-chat');
  const requests = [];
  store.faux.setResponses(Array.from({ length: 16 }, () => (request) => {
    requests.push(request);
    const input = lastUserText(request.messages);
    if (input.includes('what is this foreign thing?')) return fauxAssistantMessage('FOREIGN-SEEN');
    if (input.includes('what did the local note say?')) return fauxAssistantMessage('PARTIAL-SEEN');
    return fauxAssistantMessage('ACK');
  }));
  const transport = telegramMock(BOT_ID, [messageUpdate(740, 100, 'the local note text')]);
  let harness;
  try {
    harness = start(store, transport);
    await transport.waitForText((text) => text === 'ACK', 'the first answer');

    transport.enqueue([replyUpdate(741, 101, 'what is this foreign thing?', {
      messageId: 900,
      chatId: 999,
      fields: { from: privateUser(999), text: 'FOREIGN-SECRET' },
    })]);
    await transport.waitForText((text) => text === 'FOREIGN-SEEN', 'the cross-chat reply answer');

    const foreign = requests.find((request) =>
      lastUserText(request.messages).includes('what is this foreign thing?'));
    assert.ok(foreign);
    const foreignTranscript = requestText(foreign.messages);
    assert.equal(foreignTranscript.includes('FOREIGN-SECRET'), false,
      'a cross-chat replied-to message is never quoted');
    assert.equal(foreignTranscript.includes('Telegram quoted message'), false,
      'a cross-chat reply contributes no quote context');
    const foreignState = await stateDoc(store.gateway);
    assert.equal(foreignState.targets.some((entry) => entry.chatId === 999), false,
      'a foreign chat never becomes a same-chat target');

    transport.enqueue([messageUpdate(742, 102, 'what did the local note say?', CHAT_ID, {
      reply_to_message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        text: 'the local note text',
        chat: privateChat(),
        from: privateUser(),
      },
      quote: { text: 'local note', entities: [{ type: 'bold', offset: 0, length: 10 }], position: 4, is_manual: true },
    })]);
    await transport.waitForText((text) => text === 'PARTIAL-SEEN', 'the partial quote answer');

    const partial = requests.find((request) =>
      lastUserText(request.messages).includes('what did the local note say?'));
    assert.ok(partial);
    const partialInput = lastUserText(partial.messages);
    assert.ok(partialInput.includes('[Telegram quoted message id 100 from the user: "local note"]'),
      'the explicit partial quote is the referenced fragment');
  } finally {
    await stop(harness);
    transport.restore();
    await closeStore(store);
  }
});
