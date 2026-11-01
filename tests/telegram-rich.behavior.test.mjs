// Telegram Bot API 10.1 rich messages.
//
// Replies, scheduled deliveries and host notices travel as rich markdown, so the chat renders what
// the model wrote instead of a chopped plain text. Two rejections are proven non-sends and fall back
// to plain text — a server without the method (latched off for the process) and a body Telegram
// refused to parse — while an ambiguous outcome is quarantined and never resent.
//
// No bot, credential, network, provider or live process: the Bot API is a mocked fetch and the model
// is a faux provider over a temporary store.
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
  { createModels, fauxAssistantMessage, fauxProvider },
  { RICH_TEXT_LIMIT, escapeTelegramLiteral, splitRichText, telegramRichSupport },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(new URL('../dist/channels/telegram-rich.js', import.meta.url).href),
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

/**
 * Advance the mocked clock in small steps until `predicate` holds, so streamed deltas, the preview
 * debounce and any queued background timer all run without waiting on wall-clock time.
 */
async function advanceUntil(t, predicate, label, totalMs = 20_000, stepMs = 50) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    t.mock.timers.tick(stepMs);
    await flush(4);
    if (await predicate()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}


async function syntheticStore(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-rich-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    // `streamTokensPerSecond` makes the faux provider emit text deltas, which is what a live preview
    // follows; the rate is tuned so the turn spans more than one preview interval.
    const faux = fauxProvider({
      provider: 'rich',
      models: [{ id: 'synthetic', name: 'Synthetic' }],
      ...(options.streamTokensPerSecond === undefined ? {} : { tokensPerSecond: options.streamTokensPerSecond }),
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'rich', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: [],
      episodeSummary: { enabled: false },
      telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom: ['501'] },
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
      chat: { id: CHAT_ID, type: 'private', first_name: 'Synthetic' },
      from: { id: CHAT_ID, is_bot: false, first_name: 'Synthetic' },
    },
  };
}

/**
 * Mocked Bot API. `richFailure`/`plainFailure`/`editFailure` answer the corresponding method with the
 * given error body when they match, so a fallback path can be exercised without any network.
 */
function telegramMock(updates, options = {}) {
  const original = globalThis.fetch;
  const rich = [];
  const plain = [];
  const edits = [];
  let polled = false;
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
    if (method === 'getUpdates') {
      if (!polled) {
        polled = true;
        return response(updates);
      }
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'getFile') return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }, 400);
    if (method === 'sendChatAction' || method === 'deleteMessage' || method === 'setMyCommands') return response(true);
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
      const failure = await options.plainFailure?.(text, plain.length);
      if (failure !== undefined) {
        plain.push({ chatId: body.chat_id, text, failed: true });
        return json({ ok: false, ...failure }, failure.status);
      }
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
      const failure = options.editFailure?.(entry, edits.length);
      if (failure !== undefined) {
        edits.push({ ...entry, failed: true });
        return json({ ok: false, ...failure }, failure.status);
      }
      edits.push(entry);
      return response(true);
    }
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return { rich, plain, edits, restore() { globalThis.fetch = original; } };
}

function start(store, transport) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: TOKEN, allowFrom: ['501'], pollTimeoutSeconds: 1,
  }, scope.context);
  return { scope, adapter, transport };
}

/**
 * Stop the adapter and close the store with the mocked clock still running: durable teardown waits on
 * timers of its own, so a frozen clock would deadlock it.
 */
async function cleanupWithClock(store, harness, t) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
  harness?.transport?.restore();
  telegramRichSupport.unavailable = false;
  const closing = store.gateway.close(context);
  for (let elapsed = 0; elapsed < 10_000; elapsed += 50) {
    t.mock.timers.tick(50);
    await flush(2);
    // Stop ticking once the store has settled; a frozen clock afterwards is harmless.
    const settled = closing.then(() => true, () => true);
    if (await Promise.race([settled, new Promise((resolve) => setImmediate(() => resolve(false)))])) break;
  }
  await closing;
  await rm(store.directory, { recursive: true, force: true });
}

async function cleanup(store, harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
  harness?.transport?.restore();
  telegramRichSupport.unavailable = false;
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

async function pendingRecords(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc.pending));
  }, context);
}

const notFound = { error_code: 404, description: 'Not Found' };
const cannotParse = { error_code: 400, description: "Bad Request: can't parse entities: Unexpected end of the message" };

test('a reply is one rich markdown message, not chopped plain text', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('reply');
  const reply = '# Heading\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage(reply)]);
    const transport = telegramMock([update(600, 'send me markdown')]);
    harness = start(store, transport);
    await until(() => transport.rich.length === 1, 'one rich reply');
    assert.equal(transport.rich[0].text, reply, 'the reply travels as the markdown the model wrote');
    assert.equal(transport.rich[0].chatId, CHAT_ID);
    assert.equal(transport.plain.length, 0, 'no plain text fallback was needed');
  } finally {
    await cleanup(store, harness);
  }
});

test('an unsupported rich method latches off and the reply is sent plain', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('unsupported');
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage('FIRST-REPLY'), fauxAssistantMessage('SECOND-REPLY')]);
    const transport = telegramMock(
      [update(610, 'first'), update(611, 'second')],
      { richFailure: () => notFound },
    );
    harness = start(store, transport);
    await until(() => transport.plain.some((entry) => entry.text === 'FIRST-REPLY'), 'plain first reply');
    await until(() => transport.plain.some((entry) => entry.text === 'SECOND-REPLY'), 'plain second reply');
    assert.equal(transport.rich.length, 1, 'the process stops trying a method the server does not have');
    assert.equal(transport.plain.length, 2);
  } finally {
    await cleanup(store, harness);
  }
});

test('a refused markdown body is resent as plain text, split inside the plain limit', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('format');
  // Longer than one plain message but well inside one rich message.
  const words = Array.from({ length: 1_600 }, (_, index) => `word${index}`).join(' ');
  assert.ok(words.length > 4_096 && words.length < RICH_TEXT_LIMIT);
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage(words)]);
    const transport = telegramMock([update(620, 'long reply')], { richFailure: () => cannotParse });
    harness = start(store, transport);
    await until(() => transport.plain.reduce((total, entry) => total + entry.text.length, 0) >= words.length - 8,
      'every plain part of the fallback');
    assert.equal(transport.rich.length, 1, 'one rich attempt, then the proven-safe plain fallback');
    assert.ok(transport.plain.length > 1, 'the fallback respects the plain per-message limit');
    for (const part of transport.plain) {
      assert.ok(part.text.length <= 4_096, `part of ${part.text.length} characters exceeds the plain limit`);
    }
    const joined = transport.plain.map((entry) => entry.text).join(' ');
    for (const marker of ['word0', 'word799', 'word1599']) {
      assert.ok(joined.includes(marker), `${marker} is missing from the fallback delivery`);
    }
  } finally {
    await cleanup(store, harness);
  }
});

for (const legacy of [false, true]) test(
  legacy ? 'scheduled recovery keeps a pre-upgrade legacy cursor' :
    'scheduled recovery keeps persisted rich boundaries when capability is disabled',
  { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const store = await syntheticStore('chunk-plan');
  const sessionKey = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
  const answer = 'a'.repeat(legacy ? 4096 : 32768) + 'b'.repeat(6000);
  const record = {
    id: 'cron:fixture:1', sessionKey, text: answer, createdAtMs: 1,
    status: 'pending', nextChunkIndex: 1, ...(legacy ? {} : { telegramChunkPlan: 'rich-v1' }),
  };
  const outbox = {
    async sessions() { return [{ sessionKey }]; },
    async list() { return [structuredClone(record)]; },
    async update(_session, _id, change) { change(record); return structuredClone(record); },
    async recordFault() {},
  };
  let harness;
  try {
    const state = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
    await state.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, state.id);
      doc.origins[String(CHAT_ID)] = {
        botId: String(BOT_ID), chatType: 'private', senderId: String(CHAT_ID), admittedAtMs: 1,
      };
    }, context);
    telegramRichSupport.unavailable = !legacy;
    const transport = telegramMock([]);
    const scope = withCancel(context);
    const host = { conversationFor: store.gateway.conversationFor.bind(store.gateway), cronOutbox: outbox };
    const adapter = runTelegram(host, { token: TOKEN, allowFrom: ['501'], pollTimeoutSeconds: 1 }, scope.context);
    harness = { scope, adapter, transport };
    await advanceUntil(t, () => record.status === 'delivered', 'resumed scheduled delivery');
    if (legacy) {
      assert.equal(record.telegramChunkPlan, 'legacy');
      assert.equal(transport.rich.map((entry) => entry.text).join(''), 'b'.repeat(6000));
      assert.equal(record.nextChunkIndex, 3);
    } else {
      assert.equal(transport.rich.length, 0);
      assert.equal(transport.plain.map((entry) => entry.text).join(''), 'b'.repeat(6000));
      assert.equal(record.nextChunkIndex, 2);
    }
  } finally {
    await cleanupWithClock(store, harness, t);
  }
});

test('a partially accepted plain fallback is held unknown after a later rejection', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('partial-fallback');
  const answer = 'x'.repeat(10_000);
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage(answer)]);
    const transport = telegramMock([update(625, 'partial fallback')], {
      richFailure: () => cannotParse,
      plainFailure: async (_text, index) => {
        if (index !== 1) return undefined;
        const pending = await pendingRecords(store.gateway);
        assert.equal(pending[0]?.deliveryStatus, 'sending', 'an accepted prior part retains an intent');
        assert.ok(pending[0]?.sendIntent, 'a crash before rejection is recovered as unknown');
        return { error_code: 400, description: 'Bad Request: rejected' };
      },
    });
    harness = start(store, transport);
    await until(async () => (await pendingRecords(store.gateway))
      .some((entry) => entry.deliveryStatus === 'unknown'), 'partial fallback quarantine');
    await flush();
    assert.equal(transport.plain.length, 2, 'accepted part is never resent');
    assert.equal(transport.plain[0].text.length, 4096);
    assert.equal(transport.plain[1].failed, true);
  } finally {
    await cleanup(store, harness);
  }
});

test('an ambiguous rich outcome is quarantined and never resent as plain text', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('unknown');
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage('MAYBE-DELIVERED')]);
    const transport = telegramMock(
      [update(630, 'ambiguous')],
      { richFailure: () => ({ error_code: 500, description: 'Internal Server Error: unknown method' }) },
    );
    harness = start(store, transport);
    await until(async () => (await pendingRecords(store.gateway))
      .some((entry) => entry.deliveryStatus === "unknown" || entry.unknownSince !== undefined), 'quarantined delivery');
    await flush();
    assert.equal(transport.rich.length, 1);
    assert.equal(transport.plain.length, 0, 'an ambiguous send is never retried as a different message');
    const records = await pendingRecords(store.gateway);
    const record = records.find((entry) => entry.unknownStage === 'final' || entry.deliveryStatus === 'unknown');
    assert.ok(record !== undefined, 'the durable record keeps the ambiguous outcome');
  } finally {
    await cleanup(store, harness);
  }
});

test('a host notice travels rich with literal characters escaped', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('notice');
  let harness;
  try {
    const transport = telegramMock([update(640, '/help')]);
    harness = start(store, transport);
    await until(() => transport.rich.length === 1, 'one rich notice');
    const notice = transport.rich[0].text;
    assert.match(notice, /Controls for this chat/);
    assert.match(notice, /\\<preset\\>/, 'the placeholder is escaped so it is not read as an HTML tag');
    assert.equal(transport.plain.length, 0);
  } finally {
    await cleanup(store, harness);
  }
});

test('a final answer edits the live preview in place as a rich message', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('preview', { streamTokensPerSecond: 450 });
  const answer = Array.from({ length: 320 }, (_, index) => `- markdown line ${index}`).join('\n');
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage(answer)]);
    const transport = telegramMock([update(650, 'preview please')]);
    harness = start(store, transport);
    await advanceUntil(t, () => transport.edits.some((entry) => entry.rich), 'a rich preview edit');
    const chunks = splitRichText(answer, 4096);
    await advanceUntil(t, () => transport.edits.some((entry) => entry.text === chunks[0]) &&
      transport.rich.some((entry) => entry.text === chunks[1]), 'all final chunks');
    assert.equal(chunks.join(''), answer, 'final chunks preserve the answer');
    assert.ok(transport.edits.every((entry) => entry.rich), 'every preview edit is a rich edit');
    assert.equal(transport.plain.length, 0, 'no plain fallback was needed');
  } finally {
    await cleanupWithClock(store, harness, t);
  }
});

test('an unparseable preview edit falls back to the plain edit', { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await syntheticStore('edit-fallback', { streamTokensPerSecond: 450 });
  const answer = Array.from({ length: 320 }, (_, index) => `- fallback line ${index}`).join('\n');
  let harness;
  try {
    store.faux.setResponses([fauxAssistantMessage(answer)]);
    const transport = telegramMock([update(660, 'edit fallback')], {
      // Only a rich edit is refused; a plain edit of the same message is accepted.
      editFailure: (entry) => (entry.rich ? cannotParse : undefined),
    });
    harness = start(store, transport);
    const chunks = splitRichText(answer, 4096);
    await advanceUntil(t,
      () => transport.edits.some((entry) => entry.rich === false && entry.text === chunks[0]) &&
        transport.rich.some((entry) => entry.text === chunks[1]),
      'the bounded plain edit and remaining rich chunk');
    assert.equal(chunks.join(''), answer);
    assert.ok(transport.edits.some((entry) => entry.rich === true && entry.failed === true),
      'the rich edit was attempted first');
    await advanceUntil(t, async () => (await pendingRecords(store.gateway)).length === 0,
      'the delivery to settle instead of being held');
  } finally {
    await cleanupWithClock(store, harness, t);
  }
});

test('rich splitting keeps every chunk inside the limit and never breaks a fence', () => {
  const block = (name) => `## ${name}\n\n\`\`\`python\n${`print("${name}")\n`.repeat(1_100)}\`\`\`\n\n`;
  const text = block('one') + block('two') + block('three');
  assert.ok(text.length > RICH_TEXT_LIMIT, 'the fixture must need splitting');
  const chunks = splitRichText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= RICH_TEXT_LIMIT, `chunk of ${chunk.length} characters exceeds the limit`);
    const fences = chunk.split('```').length - 1;
    assert.equal(fences % 2, 0, 'each chunk closes every fence it opens');
  }
  const rejoined = chunks.join('\n');
  for (const marker of ['## one', '## two', '## three', 'print("three")']) {
    assert.ok(rejoined.includes(marker), `${marker} was lost while splitting`);
  }
});

test('a long single-line fenced block terminates and preserves its content', { timeout: 5_000 }, () => {
  const text = '```\n' + 'x'.repeat(40_000) + '\n```';
  const chunks = splitRichText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= RICH_TEXT_LIMIT));
  assert.equal(chunks.join('').replaceAll('```', '').replaceAll('\n', ''), 'x'.repeat(40_000));
});

test('oversized fence headers cannot amplify output', { timeout: 5_000 }, () => {
  const text = '```' + 'a'.repeat(32759) + '\n' + 'b'.repeat(1000) + '\n```';
  const chunks = splitRichText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length <= 2, 'raw cuts avoid repeated oversized headers');
  assert.ok(chunks.every((chunk) => chunk.length <= RICH_TEXT_LIMIT));
});

test('splitting preserves leading and boundary whitespace', () => {
  const text = '  abc\n    defgh';
  assert.equal(splitRichText(text, 6).join(''), text);
  assert.equal(splitRichText('  untouched')[0], '  untouched');
});

test('rich splitting never cuts a surrogate pair in half', () => {
  const text = '😀'.repeat(5_000);
  const chunks = splitRichText(text, 1_001);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'a chunk ends with a lone high surrogate');
    assert.ok(!(chunk.charCodeAt(0) >= 0xdc00 && chunk.charCodeAt(0) <= 0xdfff), 'a chunk starts with a lone low surrogate');
  }
  assert.equal(chunks.join(''), text);
});

test('literal escaping protects markup without touching intraword text', () => {
  assert.equal(escapeTelegramLiteral('media/2026_10_31_source-service_TODO.md'),
    'media/2026_10_31_source-service_TODO.md');
  assert.equal(escapeTelegramLiteral('a @user_name and _emphasis_ here'),
    'a @user_name and \\_emphasis\\_ here');
  assert.equal(escapeTelegramLiteral('  * fast — fixture alpha [thinking: off]'),
    '  \\* fast — fixture alpha \\[thinking: off\\]');
  assert.equal(escapeTelegramLiteral('use /model <preset>'), 'use /model \\<preset\\>');
  assert.equal(escapeTelegramLiteral('1. first\n- second'), '1\\. first\n\\- second');
  assert.equal(escapeTelegramLiteral('path\\to\\file and $x$'), 'path\\\\to\\\\file and \\$x\\$');
});
