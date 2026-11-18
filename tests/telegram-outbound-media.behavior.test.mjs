// Telegram outbound workspace files: native document/photo/audio/video/voice uploads from the
// authenticated private chat only, with bounded workspace paths and captions.
//
// No bot, credential or network: the Telegram transport is a mocked fetch and the model is a faux
// provider over a temporary store. Timers are never slept on; each wait is an explicit predicate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
const OTHER_CHAT_ID = 999;
const MIB = 1024 * 1024;

const FILE_KINDS = ['document', 'photo', 'audio', 'video', 'voice'];
const UPLOAD_FIELDS = {
  sendDocument: 'document',
  sendPhoto: 'photo',
  sendAudio: 'audio',
  sendVideo: 'video',
  sendVoice: 'voice',
};

function toolRegistrations(agent) {
  return (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? { name: tool } : tool));
}

function telegramTool(agent) {
  return toolRegistrations(agent).find((tool) => tool.name === 'telegram');
}

async function syntheticStore(label, { allowFrom = ['501', '999'], toolAllowlist = ['read'], media = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-outbound-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(join(workspace, 'files'), { recursive: true });
    const faux = fauxProvider({ provider: 'tg-outbound', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'tg-outbound', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist,
      telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom },
      ...(media ? { media: {} } : {}),
    }, directory);
    const gateway = await openGateway(config, context, { models });
    return { directory, workspace, faux, gateway, config, model };
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

function messageUpdate(updateId, messageId, text, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: privateChat(chatId),
      from: privateUser(chatId),
    },
  };
}

/**
 * Parse the multipart stream grammY sends for file uploads. The test only needs the field name,
 * filename and (small) text content; production code never parses this stream.
 */
async function readMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(contentType ?? ''));
  assert.ok(boundary, 'upload carried a multipart boundary');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('latin1');
  const parts = {};
  for (const segment of text.split(`--${boundary[1] ?? boundary[2]}`)) {
    if (!segment.includes('\r\n\r\n')) continue;
    const index = segment.indexOf('\r\n\r\n');
    const headerBlock = segment.slice(0, index);
    const body = segment.slice(index + 4).replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(headerBlock)?.[1];
    if (name === undefined) continue;
    parts[name] = {
      filename: /filename="?([^";\r\n]*)"?/.exec(headerBlock)?.[1],
      value: body,
      bytes: Buffer.from(body, 'latin1'),
    };
  }
  return parts;
}

/**
 * Mocked Bot API. Uploads are recorded from the multipart stream so the test asserts the actual
 * method, chat, caption, reply target, filename and pinned bytes.
 */
function telegramMock(batches) {
  const original = globalThis.fetch;
  const sent = [];
  const uploads = [];
  const uploadAttempts = [];
  let batchIndex = 0;
  let nextMessageId = 900;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const response = (result) => json({ ok: true, result });
  const hang = (signal) => new Promise((_, reject) => {
    const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
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
    if (method === 'setMyCommands' || method === 'sendChatAction' || method === 'editMessageText' ||
        method === 'deleteMessage') {
      return response(true);
    }
    if (method === 'getUpdates') {
      if (batchIndex < batches.length) {
        const batch = batches[batchIndex++];
        if (typeof batch === 'function') {
          return response(await Promise.race([batch(signal), hang(signal)]));
        }
        return response(batch);
      }
      return hang(signal);
    }
    if (method === 'sendMessage') {
      const messageId = nextMessageId++;
      sent.push({ chatId: body.chat_id, text: body.text, messageId });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: 'private' },
        text: body.text,
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
    const field = UPLOAD_FIELDS[method];
    if (field !== undefined) {
      const parts = await readMultipart(init.body, init.headers?.['content-type'] ?? init.headers?.get?.('content-type'));
      // grammY sends the field as `attach://<id>` and the bytes in a separate part named by that id.
      const reference = parts[field]?.value ?? '';
      const attachId = /^attach:\/\/(.+)$/.exec(reference)?.[1];
      const file = attachId === undefined ? parts[field] : parts[attachId];
      assert.ok(file?.filename, `${method} carried an uploaded file`);
      const attempt = {
        method,
        chatId: Number(parts.chat_id?.value),
        caption: parts.caption?.value,
        replyTo: parts.reply_parameters === undefined
          ? undefined
          : JSON.parse(parts.reply_parameters.value).message_id,
        filename: file.filename,
        size: file.bytes.length,
      };
      uploadAttempts.push(attempt);
      if (attempt.caption === 'HANG-UPLOAD') return await hang(signal);
      if (attempt.caption === 'UNKNOWN-UPLOAD') {
        return json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
      }
      const messageId = nextMessageId++;
      uploads.push({ ...attempt, text: file.bytes.toString('utf8'), bytes: file.bytes, messageId });
      return response({
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: attempt.chatId, type: 'private' },
        [field]: { file_name: attempt.filename },
      });
    }
    throw new Error(`unexpected mocked Telegram method: ${method}`);
  };
  return {
    sent,
    uploads,
    uploadAttempts,
    restore() { globalThis.fetch = original; },
  };
}

// Polling waits use the real timer (not a busy setImmediate spin, which starves parallel test files of CPU),
// captured at load so a test that mocks setTimeout cannot stall them.
const realSetTimeout = globalThis.setTimeout;

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
}

async function untilAsync(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
}

async function flush() {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function start(store, transport, { allowFrom = ['501', '999'], media = true } = {}) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: '123456:synthetic-token',
    allowFrom,
    pollTimeoutSeconds: 1,
    ...(media ? { media: { workspace: store.workspace } } : {}),
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
  const items = (await conversation.entries({}, 300, undefined, context)).items;
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

async function seedUnknownActions(store, count) {
  const conversation = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    for (let index = 0; index < count; index += 1) {
      doc.actions.push({
        callId: `seeded-unknown-${index}`,
        kind: 'reply',
        chatId: CHAT_ID,
        targetMessageId: 100,
        text: 'seeded unresolved evidence',
        status: 'unknown',
        nextChunkIndex: 0,
        startedAtMs: index,
        settledAtMs: index,
      });
    }
  }, context);
}

async function prepareFiles(workspace) {
  await writeFile(join(workspace, 'files/report.pdf'), 'REPORT-BYTES');
  await writeFile(join(workspace, 'files/photo.png'), 'PHOTO-BYTES');
  await writeFile(join(workspace, 'files/clip.mp3'), 'AUDIO-BYTES');
  await writeFile(join(workspace, 'files/movie.mp4'), 'VIDEO-BYTES');
  await writeFile(join(workspace, 'files/voice.ogg'), 'VOICE-BYTES');
}

test('a send action needs both the media opt-in and the configured read coding tool', { timeout: 20_000 }, async () => {
  const withBoth = await syntheticStore('authority-both');
  const noMedia = await syntheticStore('authority-no-media', { media: false });
  const noRead = await syntheticStore('authority-no-read', { toolAllowlist: [] });
  try {
    const sendSchema = (agent) => JSON.stringify(telegramTool(agent)?.parameters ?? {});
    const chatWithBoth = await withBoth.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    assert.match(sendSchema(await chatWithBoth.agent(context)), /"send"/);
    const chatNoMedia = await noMedia.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    assert.doesNotMatch(sendSchema(await chatNoMedia.agent(context)), /"send"/,
      'without the media opt-in the send action is not offered');
    const chatNoRead = await noRead.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    assert.doesNotMatch(sendSchema(await chatNoRead.agent(context)), /"send"/,
      'without the configured read tool the send action is not offered');
    assert.match(sendSchema(await chatNoRead.agent(context)), /"targets"/,
      'the observed-target actions remain unchanged');

    // Root, channel state, forks and raw (task-owned-shaped) conversations never get the tool.
    const state = await withBoth.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
    assert.equal(telegramTool(await state.agent(context)), undefined);
    const root = await withBoth.gateway.harness.root(context);
    assert.equal(telegramTool(await root.agent(context)), undefined);
    const raw = await withBoth.gateway.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: { model: withBoth.model } }, context);
    assert.equal(telegramTool(await raw.agent(context)), undefined);
    const entries = (await chatWithBoth.entries({}, 50, undefined, context)).items;
    if (entries.length === 0) {
      withBoth.faux.setResponses([() => fauxAssistantMessage('seed')]);
      await (await chatWithBoth.submit({ type: 'input', content: 'seed' }, context)).wait(context);
    }
    const seeds = (await chatWithBoth.entries({}, 50, undefined, context)).items;
    const fork = await chatWithBoth.fork(seeds[0].id, {
      ownership: { kind: 'ownerless' }, agent: { model: withBoth.model },
    }, context);
    assert.equal(telegramTool(await fork.agent(context)), undefined);
  } finally {
    await withBoth.gateway.close(context);
    await noMedia.gateway.close(context);
    await noRead.gateway.close(context);
    for (const store of [withBoth, noMedia, noRead]) {
      await rm(store.directory, { recursive: true, force: true });
    }
  }
});

test('five native kinds upload bounded workspace files with captions from the current chat only', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('kinds');
  await prepareFiles(store.workspace);
  const calls = [
    { kind: 'document', path: 'files/report.pdf', caption: 'Quarterly report', id: 'send-document' },
    { kind: 'photo', path: 'files/photo.png', caption: 'Team photo', id: 'send-photo' },
    { kind: 'audio', path: 'files/clip.mp3', caption: 'Voice memo', id: 'send-audio' },
    { kind: 'video', path: 'files/movie.mp4', caption: 'Short clip', id: 'send-video' },
    { kind: 'voice', path: 'files/voice.ogg', caption: 'Spoken note', id: 'send-voice' },
  ];
  let uploadsIssued = false;
  let crossIssued = false;
  store.faux.setResponses(Array.from({ length: 16 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!uploadsIssued && transcript.includes('send the files')) {
      uploadsIssued = true;
      return fauxAssistantMessage(calls.map((call) => fauxToolCall('telegram', {
        action: 'send', kind: call.kind, path: call.path, caption: call.caption, messageId: 100,
      }, { id: call.id })), { stopReason: 'toolUse' });
    }
    if (!crossIssued && calls.every((call) => transcript.includes(call.id)) && transcript.includes('cross target')) {
      crossIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'send', kind: 'document', path: 'files/report.pdf', messageId: 200 }, { id: 'cross-send' }),
      ], { stopReason: 'toolUse' });
    }
    if (transcript.includes('cross-send')) return fauxAssistantMessage('CROSS-DENIED');
    if (calls.every((call) => transcript.includes(call.id))) return fauxAssistantMessage('FILES-SENT');
    return fauxAssistantMessage('ACK');
  }));
  let transport;
  transport = telegramMock([
    [messageUpdate(700, 100, 'send the files'), messageUpdate(701, 200, 'other chat note', OTHER_CHAT_ID)],
    // The cross-chat attempt is admitted only after the upload turn was answered, so it is its own
    // turn rather than part of one coalesced input.
    async (signal) => {
      while (!transport.sent.some((entry) => entry.text === 'FILES-SENT')) {
        if (signal?.aborted) return [];
        await new Promise((resolve) => realSetTimeout(resolve, 2));
      }
      return [messageUpdate(702, 101, 'cross target')];
    },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'FILES-SENT'), 'upload turn');
    // Parallel tool calls may complete in any order; compare by file instead of call order.
    const byFile = new Map(transport.uploads.map((entry) => [entry.filename, entry]));
    assert.equal(byFile.size, 5);
    const expectedUploads = {
      'report.pdf': { method: 'sendDocument', caption: 'Quarterly report' },
      'photo.png': { method: 'sendPhoto', caption: 'Team photo' },
      'clip.mp3': { method: 'sendAudio', caption: 'Voice memo' },
      'movie.mp4': { method: 'sendVideo', caption: 'Short clip' },
      'voice.ogg': { method: 'sendVoice', caption: 'Spoken note' },
    };
    for (const [filename, expected] of Object.entries(expectedUploads)) {
      const upload = byFile.get(filename);
      assert.ok(upload, `${filename} was uploaded`);
      assert.equal(upload.method, expected.method, filename);
      assert.equal(upload.caption, expected.caption, filename);
    }
    assert.ok(transport.uploads.every((entry) => entry.chatId === CHAT_ID), 'uploads stay in the mapped chat');
    assert.ok(transport.uploads.every((entry) => entry.replyTo === 100), 'the observed reply target is threaded');
    assert.equal(byFile.get('report.pdf').text, 'REPORT-BYTES', 'the sent bytes are the pinned file contents');
    assert.ok(transport.uploads.every((entry) => entry.size > 0));

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    for (const call of calls) {
      const result = await toolResults(chat, call.id);
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, new RegExp(`Sent one ${call.kind}`));
      assert.doesNotMatch(result.text, new RegExp(store.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    // An observed id from another private chat cannot carry an upload from this one.
    await until(() => transport.sent.some((entry) => entry.text === 'CROSS-DENIED'), 'cross-chat turn');
    const cross = await toolResults(chat, 'cross-send');
    assert.equal(cross.isError, true);
    assert.match(cross.text, /not an observed message in this chat/);
    assert.equal(transport.uploads.length, 5, 'the cross-chat send made no upload');

    const doc = await stateDoc(store.gateway);
    const actions = doc.actions.filter((entry) => FILE_KINDS.includes(entry.kind));
    assert.equal(actions.length, 5);
    assert.ok(actions.every((entry) => entry.status === 'sent' && entry.resultMessageIds.length === 1));
    assert.ok(actions.every((entry) => !entry.path?.startsWith('/')), 'records keep workspace-relative paths only');

    // Every accepted upload becomes an observed target in the same chat, so it can be replied to or
    // reacted to like any other bot message.
    const targets = store.gateway.telegramActions.current().targets(`telegram:${BOT_ID}:chat:${CHAT_ID}`);
    assert.ok(targets !== undefined, 'the chat remains authorized');
    for (const upload of transport.uploads) {
      const target = targets.find((entry) => entry.messageId === upload.messageId);
      assert.ok(target, `upload ${upload.messageId} is observed`);
      assert.equal(target.chatId, CHAT_ID);
      assert.equal(target.direction, 'outgoing');
    }
  } finally {
    await cleanup(store, harness);
  }
});

test('a long valid basename keeps its photo extension and pinned bytes', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('long-name');
  const longName = `${'a'.repeat(200)}.png`;
  const path = `files/${longName}`;
  await writeFile(join(store.workspace, path), 'LONG-PHOTO-BYTES');
  let issued = false;
  store.faux.setResponses(Array.from({ length: 6 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'send', kind: 'photo', path, caption: 'Long name' }, { id: 'long-photo' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('LONG-DONE');
  }));
  const transport = telegramMock([[messageUpdate(705, 100, 'send the long photo')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'LONG-DONE'), 'long-name turn');
    assert.equal(transport.uploads.length, 1, 'the long valid photo was not falsely refused');
    const upload = transport.uploads[0];
    assert.equal(upload.method, 'sendPhoto');
    assert.equal(upload.text, 'LONG-PHOTO-BYTES', 'the pinned bytes are the long file contents');
    assert.equal(upload.size, Buffer.byteLength('LONG-PHOTO-BYTES'));
    assert.equal(upload.filename.length, 120, 'the display name stays inside the 120-character bound');
    assert.match(upload.filename, /^a{116}\.png$/, 'the validated suffix survives the bound');

    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'long-photo');
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Sent one photo/);
    assert.doesNotMatch(result.text, new RegExp(longName));
    const record = (await stateDoc(store.gateway)).actions.find((entry) => entry.kind === 'photo');
    assert.equal(record?.status, 'sent');
    assert.equal(record?.path, path, 'the record keeps the workspace-relative path, not the host path');

    // A symlink target can give a document an extension containing a control character. The
    // display name is sanitized, never passed through raw from the resolved path.
    await writeFile(join(store.workspace, 'files/report.\u0007pdf'), 'CTRL-BYTES');
    await symlink('report.\u0007pdf', join(store.workspace, 'files/ctrl.alias'));
    const ctrl = await store.gateway.telegramActions.current().act(
      `telegram:${BOT_ID}:chat:${CHAT_ID}`,
      'ctrl-suffix',
      { kind: 'document', path: 'files/ctrl.alias' },
      context,
    );
    assert.equal(ctrl.ok, true, ctrl.text);
    const ctrlUpload = transport.uploads.find((entry) => entry.method === 'sendDocument');
    assert.ok(ctrlUpload, 'the resolved control-character document reached the mock');
    assert.equal(ctrlUpload.text, 'CTRL-BYTES');
    assert.doesNotMatch(ctrlUpload.filename, /[\u0000-\u001f\u007f]/, 'the display name is sanitized');
    assert.ok(ctrlUpload.filename.length <= 120);
  } finally {
    await cleanup(store, harness);
  }
});

test('omitting kind sends any workspace file unchanged as a document', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('default-document');
  const binary = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x7f, 0x80, 0x0b, 0x2e]);
  await writeFile(join(store.workspace, 'files/payload.weird'), binary);
  let issued = false;
  store.faux.setResponses(Array.from({ length: 6 }, () => (request) => {
    if (!issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'send', path: 'files/payload.weird', caption: 'Anything' },
          { id: 'default-document' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('DEFAULT-DOC-DONE');
  }));
  const transport = telegramMock([[messageUpdate(707, 100, 'send anything')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'DEFAULT-DOC-DONE'), 'default document turn');
    assert.equal(transport.uploads.length, 1, 'an omitted kind is a document send');
    const upload = transport.uploads[0];
    assert.equal(upload.method, 'sendDocument');
    assert.equal(upload.caption, 'Anything');
    assert.equal(Buffer.compare(upload.bytes, binary), 0, 'the arbitrary binary bytes are sent unchanged');
    assert.equal(upload.filename, 'payload.weird');
    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const result = await toolResults(chat, 'default-document');
    assert.equal(result.isError, false, result.text);
    const record = (await stateDoc(store.gateway)).actions.find((entry) => entry.path === 'files/payload.weird');
    assert.equal(record?.kind, 'document');
    assert.equal(record?.status, 'sent');
  } finally {
    await cleanup(store, harness);
  }
});

test('path, symlink, kind, size and non-regular refusals happen before any upload', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('refusals');
  await prepareFiles(store.workspace);
  await writeFile(join(store.directory, 'outside.txt'), 'OUTSIDE-BYTES');
  await symlink('../../outside.txt', join(store.workspace, 'files/escape.txt'));
  execFileSync('mkfifo', [join(store.workspace, 'files/pipe')]);
  await writeFile(join(store.workspace, 'files/huge.bin'), Buffer.alloc(20 * MIB + 1));

  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!transcript.includes('traversal-send')) {
      return fauxAssistantMessage([
        fauxToolCall('telegram', { action: 'send', kind: 'document', path: '../outside.txt' }, { id: 'traversal-send' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('REFUSALS-DONE');
  }));
  const transport = telegramMock([[messageUpdate(710, 100, 'try refusals')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'REFUSALS-DONE'), 'refusal turn');
    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const traversal = await toolResults(chat, 'traversal-send');
    assert.equal(traversal.isError, true);
    assert.match(traversal.text, /workspace-relative/);
    assert.ok(!traversal.text.includes(store.workspace), 'the refusal never discloses a host path');

    const host = store.gateway.telegramActions.current();
    const session = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
    const refusals = [
      { callId: 'refuse-symlink', request: { kind: 'document', path: 'files/escape.txt' }, match: /workspace/ },
      { callId: 'refuse-fifo', request: { kind: 'document', path: 'files/pipe' }, match: /not a regular file/ },
      { callId: 'refuse-huge', request: { kind: 'document', path: 'files/huge.bin' }, match: /larger than/ },
      { callId: 'refuse-format', request: { kind: 'voice', path: 'files/report.pdf' }, match: /resend as kind=document/ },
      { callId: 'refuse-missing', request: { kind: 'document', path: 'files/missing.pdf' }, match: /no such file/ },
      { callId: 'refuse-kind', request: { kind: 'sticker', path: 'files/report.pdf' }, match: /Unknown Telegram file kind/ },
    ];
    for (const refusal of refusals) {
      const outcome = await host.act(session, refusal.callId, refusal.request, context);
      assert.equal(outcome.ok, false, refusal.callId);
      assert.match(outcome.text, refusal.match, refusal.callId);
      assert.ok(!outcome.text.includes(store.workspace), `${refusal.callId} discloses no host path`);
      assert.ok(!outcome.text.includes('outside.txt'), `${refusal.callId} discloses no outside name`);
    }
    assert.equal(transport.uploads.length, 0, 'no refusal produced an upload');
    assert.equal(transport.uploadAttempts.length, 0, 'no refusal reached the network');

    const doc = await stateDoc(store.gateway);
    for (const refusal of refusals.filter((entry) => entry.callId !== 'refuse-kind')) {
      const record = doc.actions.find((entry) => entry.callId === refusal.callId);
      assert.equal(record?.status, 'failed', `${refusal.callId} is a known pre-send refusal`);
    }
    assert.equal(doc.actions.find((entry) => entry.callId === 'refuse-kind'), undefined,
      'an unknown kind is refused before any action record is admitted');

    // A chat without admission evidence has no upload authority at all.
    const unawarded = await host.act(`telegram:${BOT_ID}:chat:12345`, 'no-admission', {
      kind: 'document', path: 'files/report.pdf',
    }, context);
    assert.equal(unawarded.ok, false);
    assert.match(unawarded.text, /not currently authorized/);

    // Revoking the admitted sender from the live allowlist stops the next upload at call time.
    await stop(harness);
    harness = undefined;
    const revokedTransport = telegramMock([[]]);
    harness = start(store, revokedTransport, { allowFrom: ['999'] });
    await until(() => store.gateway.telegramActions.current() !== undefined, 'revoked adapter attach');
    const revoked = await store.gateway.telegramActions.current().act(session, 'revoked-send', {
      kind: 'document', path: 'files/report.pdf',
    }, context);
    assert.equal(revoked.ok, false);
    assert.match(revoked.text, /not currently authorized/);
    assert.equal(revokedTransport.uploadAttempts.length, 0, 'a revoked sender uploads nothing');
  } finally {
    await cleanup(store, harness);
  }
});

test('durable identity sends once, unknown outcomes are retained and never retried', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('identity');
  await prepareFiles(store.workspace);
  store.faux.setResponses(Array.from({ length: 10 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!transcript.includes('Identity one')) {
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'Identity one',
        }, { id: 'call_0' }),
      ], { stopReason: 'toolUse' });
    }
    if (!transcript.includes('Identity two')) {
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'Identity two',
        }, { id: 'call_0' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('IDENTITY-DONE');
  }));
  const transport = telegramMock([[messageUpdate(720, 100, 'provider id send')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'IDENTITY-DONE'), 'identity turn');
    assert.equal(transport.uploads.length, 2,
      'a reused provider call id is not the durable identity: both executions uploaded once');

    const doc = await stateDoc(store.gateway);
    const actions = doc.actions.filter((entry) => FILE_KINDS.includes(entry.kind));
    assert.equal(actions.length, 2);
    assert.equal(new Set(actions.map((entry) => entry.callId)).size, 2);
    assert.ok(actions.every((entry) => entry.callId !== 'call_0' && entry.callId.startsWith('tool:')),
      'the adapter records the Durable tool-task identity, not the provider call id');
    assert.deepEqual(actions.map((entry) => entry.caption).sort(), ['Identity one', 'Identity two']);

    // Replaying the same durable task identity resolves to the stored record, exactly once.
    const host = store.gateway.telegramActions.current();
    const session = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
    const request = { kind: 'document', path: 'files/photo.png', caption: 'Replay once' };
    const first = await host.act(session, 'replay-same-task', request, context);
    assert.equal(first.ok, true, first.text);
    const repeated = await host.act(session, 'replay-same-task', request, context);
    assert.equal(repeated.ok, true, repeated.text);
    assert.equal(transport.uploads.filter((entry) => entry.caption === 'Replay once').length, 1);
    const changed = await host.act(session, 'replay-same-task', { ...request, path: 'files/voice.ogg' }, context);
    assert.equal(changed.ok, false);
    assert.match(changed.text, /different request/);
    assert.equal(transport.uploads.filter((entry) => entry.caption === 'Replay once').length, 1);

    // An ambiguous 5xx upload is recorded as unknown and is never resent, including after reopen.
    const unknown = await host.act(session, 'unknown-upload', {
      kind: 'document', path: 'files/report.pdf', caption: 'UNKNOWN-UPLOAD',
    }, context);
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /may or may not/);
    assert.equal(transport.uploadAttempts.filter((entry) => entry.caption === 'UNKNOWN-UPLOAD').length, 1);
    assert.equal((await stateDoc(store.gateway)).actions.find((entry) => entry.callId === 'unknown-upload')?.status,
      'unknown');

    await stop(harness);
    harness = undefined;
    const replay = telegramMock([[messageUpdate(720, 100, 'provider id send')]]);
    harness = start(store, replay);
    await flush();
    await flush();
    assert.equal(replay.uploadAttempts.length, 0, 'a reopen never resends the quarantined upload');
    assert.equal(replay.uploads.length, 0);
  } finally {
    await cleanup(store, harness);
  }
});

test('a full action log refuses a new upload without losing unknown evidence', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('backpressure');
  await prepareFiles(store.workspace);
  // Leave room for exactly one more record, then fill it with an unknown outcome.
  await seedUnknownActions(store, 99);
  let fillIssued = false;
  let capacityIssued = false;
  store.faux.setResponses(Array.from({ length: 10 }, () => (request) => {
    const transcript = JSON.stringify(request.messages);
    if (!fillIssued) {
      fillIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'UNKNOWN-UPLOAD',
        }, { id: 'fill-log' }),
      ], { stopReason: 'toolUse' });
    }
    if (transcript.includes('try the next') && !capacityIssued) {
      capacityIssued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'send', kind: 'document', path: 'files/photo.png', caption: 'Over capacity',
        }, { id: 'over-capacity' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('CAP-DONE');
  }));
  const transport = telegramMock([[
    messageUpdate(730, 100, 'fill the log'),
    messageUpdate(731, 101, 'try the next'),
  ]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'CAP-DONE'), 'capacity turn');
    const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
    const refused = await toolResults(chat, 'over-capacity');
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Too many Telegram actions/);
    assert.equal(transport.uploadAttempts.filter((entry) => entry.caption === 'Over capacity').length, 0);
    const doc = await stateDoc(store.gateway);
    assert.equal(doc.actions.length, 100);
    assert.ok(doc.actions.some((entry) => entry.callId === 'seeded-unknown-0'), 'old unknown evidence survives');
    assert.ok(doc.actions.some((entry) => entry.caption === 'UNKNOWN-UPLOAD' && entry.status === 'unknown'));
  } finally {
    await cleanup(store, harness);
  }
});

test('an abort during upload leaves an unknown, never-resent action and detaches the host', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('abort');
  await prepareFiles(store.workspace);
  let issued = false;
  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    if (!issued) {
      issued = true;
      return fauxAssistantMessage([
        fauxToolCall('telegram', {
          action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'HANG-UPLOAD',
        }, { id: 'hang-upload' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('HANG-DONE');
  }));
  const transport = telegramMock([[messageUpdate(740, 100, 'hang the upload')]]);
  const harness = start(store, transport);
  try {
    await until(() => transport.uploadAttempts.length === 1, 'in-flight upload');
    harness.scope.cancel(new DOMException('test abort', 'AbortError'));
    await harness.adapter.catch(() => undefined);
    assert.equal(transport.uploadAttempts.length, 1, 'the abort caused no second attempt');
    assert.equal(transport.uploads.length, 0);
    // The mid-flight settle runs on the adapter's cleanup context after the abort; wait for it
    // instead of assuming the adapter's own shutdown awaited the tool task.
    await untilAsync(async () => {
      const action = (await stateDoc(store.gateway)).actions.find((entry) => entry.kind === 'document');
      return action?.status === 'unknown';
    }, 'quarantined aborted upload');
    assert.equal(store.gateway.telegramActions.current(), undefined, 'the model tool host is detached');
  } finally {
    await stop(harness);
    await store.gateway.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test('a repeat of an unresolved upload is refused, while a settled or different effect still sends',
  { timeout: 25_000 }, async () => {
    const store = await syntheticStore('duplicate-upload');
    await prepareFiles(store.workspace);
    store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
      const transcript = JSON.stringify(request.messages);
      if (!transcript.includes('upload the report')) return fauxAssistantMessage('idle');
      if (!transcript.includes('unknown-upload')) {
        return fauxAssistantMessage([
          fauxToolCall('telegram', {
            action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'UNKNOWN-UPLOAD',
          }, { id: 'unknown-upload' }),
        ], { stopReason: 'toolUse' });
      }
      if (!transcript.includes('repeat-upload')) {
        return fauxAssistantMessage([
          fauxToolCall('telegram', {
            action: 'send', kind: 'document', path: 'files/report.pdf', caption: 'UNKNOWN-UPLOAD',
          }, { id: 'repeat-upload' }),
        ], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('UPLOAD-DONE');
    }));
    const transport = telegramMock([[messageUpdate(750, 100, 'upload the report')]]);
    let harness;
    try {
      harness = start(store, transport);
      await until(() => transport.sent.some((entry) => entry.text === 'UPLOAD-DONE'), 'upload turn');
      assert.equal(transport.uploadAttempts.filter((entry) => entry.caption === 'UNKNOWN-UPLOAD').length, 1,
        'the repeated upload made no second external attempt');
      assert.equal(transport.uploads.length, 0);

      const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
      const refused = await toolResults(chat, 'repeat-upload');
      assert.equal(refused.isError, true);
      assert.match(refused.text, /No new Telegram message was sent/);
      assert.equal(refused.text.includes('UNKNOWN-UPLOAD'), false, 'the refusal discloses no channel content');

      const records = (await stateDoc(store.gateway)).actions;
      assert.equal(records.length, 1, 'the refused upload created no action record');
      assert.equal(records[0].status, 'unknown');
      assert.equal(records[0].path, 'files/report.pdf');

      const host = store.gateway.telegramActions.current();
      const session = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
      // A different caption is a different visible effect.
      const otherCaption = await host.act(session, 'other-caption', {
        kind: 'document', path: 'files/report.pdf', caption: 'OTHER-CAPTION',
      }, context);
      assert.equal(otherCaption.ok, true, otherCaption.text);
      assert.equal(transport.uploadAttempts.filter((entry) => entry.caption === 'OTHER-CAPTION').length, 1);
      // A definitively sent effect does not block a deliberate later repeat of the same effect.
      const again = await host.act(session, 'other-caption-again', {
        kind: 'document', path: 'files/report.pdf', caption: 'OTHER-CAPTION',
      }, context);
      assert.equal(again.ok, true, again.text);
      assert.equal(transport.uploadAttempts.filter((entry) => entry.caption === 'OTHER-CAPTION').length, 2);
      assert.ok((await stateDoc(store.gateway)).actions
        .some((entry) => entry.caption === 'UNKNOWN-UPLOAD' && entry.status === 'unknown'),
      'the unresolved upload is retained as evidence');
    } finally {
      await cleanup(store, harness);
    }
  });
