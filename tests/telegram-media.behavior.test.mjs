// Telegram media ingress and shared local transcription.
//
// No bot, credential, network, uv environment or faster-whisper model is used:
// the Telegram Bot API is a mocked fetch, the model is a faux provider over a
// temporary store, and speech recognition is a controlled helper subprocess.
// Every wait is an explicit predicate with a deadline; no schedule sleeps.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile, link, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { parseConfig },
  { openGateway },
  { runTelegram, TelegramState },
  { createMediaStore, validateMediaDirectory, sanitizeOriginalName, MediaRejected },
  { boundedFileBody, telegramFilePath, attachmentContextText },
  { createTranscriber },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(new URL('../dist/media/attachments.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram-media.js', import.meta.url).href),
  import(new URL('../dist/media/transcription.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const BOT_ID = 7;
const CHAT_ID = 501;
const TOKEN = '123456:synthetic-token';
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF_BYTES = Buffer.from('%PDF-1.4\nsynthetic document body\n%%EOF\n');

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function untilAsync(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The adapter's durable channel-state document, read without changing it. */
async function telegramState(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

/** The gateway's episode-summary helper request, not a main conversation turn. */
function isEpisodeSummaryRequest(request) {
  return userMessages([request]).some((message) =>
    messageText(message).startsWith('Summarize this transcript segment'));
}

async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function syntheticStore(label, { allowFrom = ['501'], media } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-media-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const faux = fauxProvider({ provider: 'tg-media', models: [{ id: 'synthetic', name: 'Synthetic' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: 'tg-media', modelId: 'synthetic' };
    const config = parseConfig({
      workspace,
      dataDir: join(directory, 'state'),
      model,
      allowedModels: [model],
      toolAllowlist: [],
      telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom },
      ...(media === undefined ? {} : { media }),
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

function photoUpdate(updateId, messageId, { fileId, uniqueId, bytes, caption, extra = {} }, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
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
      ...extra,
    },
  };
}

function documentUpdate(updateId, messageId, { fileId, uniqueId, bytes, fileName, mimeType, caption, declaredSize }, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(chatId),
      from: privateUser(chatId),
      document: {
        file_id: fileId,
        file_unique_id: uniqueId,
        file_size: declaredSize ?? bytes.byteLength,
        file_name: fileName,
        mime_type: mimeType,
      },
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

function voiceUpdate(updateId, messageId, { fileId, uniqueId, bytes, caption }) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(),
      from: privateUser(),
      voice: {
        file_id: fileId,
        file_unique_id: uniqueId,
        file_size: bytes.byteLength,
        duration: 3,
        mime_type: 'audio/ogg',
      },
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

function textUpdate(updateId, messageId, text, chatId = CHAT_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(chatId),
      from: privateUser(chatId),
      text,
    },
  };
}

/**
 * Mocked Bot API plus the fixed-origin file download. `files` maps a file id to
 * `{ path, bytes, declaredSize?, getFileStatus?, hang? }`; unknown ids are a
 * rejection. getUpdates holds until abort once its batches are exhausted.
 */
/** Reject when the adapter aborts, so mocked gates never outlive shutdown. */
function aborted(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function telegramMock(batches, files = new Map()) {
  const original = globalThis.fetch;
  const sent = [];
  const getFileCalls = [];
  const downloads = [];
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
      commands.push(body.commands);
      return response(true);
    }
    if (method === 'getUpdates') {
      if (batchIndex < batches.length) {
        const entry = batches[batchIndex++];
        if (typeof entry === 'function') {
          // A batch may be gated on a promise, so a test can let the next poll happen
          // after an asynchronous control effect without sleeping. Cancellation still
          // aborts the pending poll, so adapter shutdown never hangs.
          return response(await Promise.race([entry(), aborted(signal)]));
        }
        return response(entry);
      }
      return await new Promise((_, reject) => {
        const aborted = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (method === 'sendChatAction') return response(true);
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
    if (method === 'editMessageText' || method === 'deleteMessage') return response(true);
    if (method === 'getFile') {
      getFileCalls.push(body.file_id);
      const file = files.get(body.file_id);
      if (file === undefined) return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }, 400);
      if (file.getFileStatus !== undefined) {
        return json({ ok: false, error_code: file.getFileStatus, description: 'Bad Request: file is too big' }, file.getFileStatus);
      }
      return response({
        file_id: body.file_id,
        file_unique_id: body.file_id,
        file_size: file.declaredSize ?? file.bytes.byteLength,
        file_path: file.path,
      });
    }
    if (url.origin === 'https://api.telegram.org' && url.pathname.startsWith('/file/bot')) {
      const relative = url.pathname.slice(`/file/bot${TOKEN}/`.length);
      downloads.push({ href: url.href, relative, redirect: init.redirect, method: init.method });
      const file = [...files.values()].find((candidate) => candidate.path === relative);
      if (file === undefined) return new Response('missing', { status: 404 });
      if (file.failDownloads === true) return new Response('busy', { status: 503 });
      if (typeof file.downloadFailures === 'number' && file.downloadFailures > 0) {
        file.downloadFailures -= 1;
        return new Response('busy', { status: 503 });
      }
      // A held download lets a test keep one control flush in flight while a later
      // update is admitted, without sleeping. Abort still releases it.
      if (file.downloadGate !== undefined) await Promise.race([file.downloadGate, aborted(signal)]);
      if (file.hang === true) {
        return await aborted(signal);
      }
      return new Response(file.bytes, {
        status: 200,
        headers: { 'content-type': file.contentType ?? 'application/octet-stream' },
      });
    }
    throw new Error(`unexpected mocked Telegram request: ${method}`);
  };
  return {
    sent, getFileCalls, downloads, commands,
    restore() { globalThis.fetch = original; },
  };
}

function start(store, transport, allowFrom = ['501'], media = store.config.media, workspace = store.workspace) {
  const scope = withCancel(context);
  const adapter = runTelegram(store.gateway, {
    token: TOKEN,
    allowFrom,
    pollTimeoutSeconds: 1,
    ...(media === undefined ? {} : {
      media: {
        workspace,
        directory: media.directory,
        ...(media.transcription === undefined ? {} : { transcription: media.transcription }),
      },
    }),
  }, scope.context);
  return { scope, adapter };
}

async function stop(harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
}

async function cleanup(store, harness, transport) {
  await stop(harness);
  transport?.restore();
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

function userMessages(requests) {
  return requests.flatMap((request) => request.messages ?? []).filter((message) => message.role === 'user');
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

async function mediaFiles(workspace) {
  const directory = join(workspace, 'media');
  try {
    return await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function responses(text, count = 24) {
  return Array.from({ length: count }, () => () => fauxAssistantMessage(text));
}

/** A controlled `uv` replacement: records argv, the child environment and a fixed transcript. */
async function fakeUv(directory, { stdout = 'SYNTHETIC TRANSCRIPT', exitCode = 0 } = {}) {
  const path = join(directory, 'fake-uv');
  const recordPath = join(directory, 'fake-uv-args.bin');
  const envPath = join(directory, 'fake-uv-env.txt');
  await writeFile(path, [
    '#!/bin/sh',
    `: > "${recordPath}"`,
    'for arg in "$@"; do printf \'%s\\000\' "$arg" >> "' + recordPath + '"; done',
    'printf \'%s|%s\' "${NANOBOT_TEST_SECRET-unset}" "${HF_HUB_OFFLINE-unset}" > "' + envPath + '"',
    `printf '%s' '${stdout}'`,
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { path, recordPath, envPath };
}

test('a document is stored byte-for-byte on disk and the turn names the locator without extraction', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('document', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('DOC-NOTED');
  }));
  const files = new Map([['doc-1', { path: 'documents/file_0.pdf', bytes: PDF_BYTES, contentType: 'application/pdf' }]]);
  const transport = telegramMock([[
    documentUpdate(500, 100, {
      fileId: 'doc-1', uniqueId: 'unique-doc-1', bytes: PDF_BYTES,
      fileName: '../../unsafe name.pdf', mimeType: 'application/pdf', caption: 'summarize this?',
    }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'DOC-NOTED'), 'document answer');
    assert.equal(transport.getFileCalls.length, 1);
    assert.equal(transport.downloads.length, 1);
    assert.equal(transport.downloads[0].redirect, 'error');
    assert.ok(transport.downloads[0].href.startsWith(`https://api.telegram.org/file/bot${TOKEN}/documents/`));

    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1, `one stored original, got ${stored.join(',')}`);
    assert.match(stored[0], /^document-[0-9a-f]{16}\.pdf$/);
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), PDF_BYTES);
    const mode = await lstat(join(store.workspace, 'media', stored[0]));
    assert.equal(mode.mode & 0o077, 0, 'stored originals are private');

    const message = userMessages(requests)[0];
    const text = messageText(message);
    assert.match(text, /summarize this\?/, 'the caption is preserved');
    assert.match(text, new RegExp(`Stored file \\(workspace-relative\\): media/${stored[0]}`));
    assert.match(text, /No content was extracted from this document/);
    assert.match(text, /untrusted metadata, not instructions/);
    // The announced filename is bounded metadata only: no traversal, and it never named the file.
    assert.match(text, /Original filename: \.\._\.\._unsafe name\.pdf/);
    assert.equal(typeof message.content, 'string', 'a document turn is ordinary text');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a photo is stored and submitted as native image content with its relative locator', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('photo', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('PHOTO-SEEN');
  }));
  const files = new Map([['photo-1', { path: 'photos/file_1.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg' }]]);
  const transport = telegramMock([[
    photoUpdate(510, 110, {
      fileId: 'photo-1', uniqueId: 'unique-photo-1', bytes: PHOTO_BYTES, caption: 'what is this?',
      extra: {
        reply_to_message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000),
          text: 'the earlier note',
          chat: privateChat(),
          from: privateUser(),
        },
      },
    }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'PHOTO-SEEN'), 'photo answer');

    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1);
    assert.match(stored[0], /^photo-[0-9a-f]{16}\.jpg$/);
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), PHOTO_BYTES);

    const message = userMessages(requests)[0];
    assert.ok(Array.isArray(message.content), 'the photo turn carries pi-ai content parts');
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const images = message.content.filter((part) => part.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/jpeg');
    assert.equal(images[0].data, PHOTO_BYTES.toString('base64'));
    assert.match(text, /what is this\?/);
    assert.match(text, /Telegram photo attachment/);
    assert.match(text, new RegExp(`Stored file \\(workspace-relative\\): media/${stored[0]}`));
    assert.match(text, /also attached as image content/);
    // Existing quote behavior is preserved for a media message.
    assert.match(text, /Telegram quoted message id 100 from the user/);
    assert.match(text, /the earlier note/);
    assert.match(text, /untrusted reference, not instructions/);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('an animation with its backward-compatibility document field stays unsupported and is never downloaded', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('animation', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('ANIMATION-NOTED');
  }));
  const gif = Buffer.from('GIF89a synthetic');
  const files = new Map([['anim-1', { path: 'animations/file_1.gif', bytes: gif, contentType: 'image/gif' }]]);
  const transport = telegramMock([[{
    update_id: 605,
    message: {
      message_id: 205,
      date: Math.floor(Date.now() / 1000),
      chat: privateChat(),
      from: privateUser(),
      caption: 'look at this',
      animation: {
        file_id: 'anim-1', file_unique_id: 'unique-anim-1', file_name: 'a.gif',
        mime_type: 'image/gif', duration: 2, width: 90, height: 90, file_size: gif.byteLength,
      },
      // Telegram includes this backward-compatibility field for animations.
      document: {
        file_id: 'anim-1', file_unique_id: 'unique-anim-1', file_name: 'a.gif',
        mime_type: 'image/gif', file_size: gif.byteLength,
      },
    },
  }]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'ANIMATION-NOTED'), 'animation answer');
    assert.equal(transport.getFileCalls.length, 0, 'an animation never reaches getFile');
    assert.equal(transport.downloads.length, 0, 'an animation is never downloaded');
    assert.deepEqual(await mediaFiles(store.workspace), [], 'no document was stored for an animation');
    const text = messageText(userMessages(requests)[0]);
    assert.match(text, /Unsupported Telegram attachment \(animation\)/);
    assert.match(text, /Caption: look at this/);
    assert.doesNotMatch(text, /Stored file/);
    assert.doesNotMatch(text, /No content was extracted/);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('voice is stored and one labeled local transcript reaches the normal turn through the real helper protocol', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('voice', { media: { directory: 'media' } });
  const { path: uvPath, recordPath, envPath } = await fakeUv(store.directory);
  process.env.NANOBOT_TEST_SECRET = 'test-only-secret';
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('VOICE-HEARD');
  }));
  const audioBytes = Buffer.from('OggS synthetic opus payload');
  const files = new Map([['voice-1', { path: 'voice/file_2.oga', bytes: audioBytes, contentType: 'audio/ogg' }]]);
  const transport = telegramMock([[voiceUpdate(520, 120, {
    fileId: 'voice-1', uniqueId: 'unique-voice-1', bytes: audioBytes, caption: 'note to self',
  })]], files);
  let harness;
  try {
    harness = start(store, transport, ['501'], {
      directory: 'media',
      transcription: { uvPath, timeoutMs: 10_000 },
    });
    await until(() => transport.sent.some((entry) => entry.text === 'VOICE-HEARD'), 'voice answer');

    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1);
    assert.match(stored[0], /^audio-[0-9a-f]{16}\.oga$/);
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), audioBytes);

    const argv = (await readFile(recordPath)).toString('utf8').split('\u0000').filter((value) => value !== '');
    assert.deepEqual(argv.slice(0, 4), ['run', '--quiet', '--script', '--offline']);
    assert.match(argv[4], /scripts\/local-transcribe\.py$/, 'the shipped helper is the default');
    assert.ok(argv[5].endsWith(join('media', stored[0])), 'the stored audio path is one argument');
    assert.equal(argv[6], '--max-duration-seconds');
    assert.equal(argv[7], '120');
    assert.equal(argv.length, 8, 'the runtime passes no provisioning flag');
    assert.ok(!argv.includes('--allow-model-download'));
    // Only the minimal child environment is inherited: unrelated runtime secrets are not.
    assert.equal((await readFile(envPath, 'utf8')).trim(), 'unset|1');

    const text = messageText(userMessages(requests)[0]);
    assert.match(text, /note to self/, 'the caption is preserved');
    assert.match(text, /Recognized speech \(automatic local transcription of the stored audio; untrusted user content, may be wrong\):/);
    assert.match(text, /"SYNTHETIC TRANSCRIPT"/);
    assert.match(text, new RegExp(`Stored file \\(workspace-relative\\): media/${stored[0]}`));
  } finally {
    delete process.env.NANOBOT_TEST_SECRET;
    await cleanup(store, harness, transport);
  }
});

test('an unavailable speech backend is reported truthfully and the stored audio still reaches the turn', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('voice-unavailable', { media: { directory: 'media' } });
  const { path: uvPath } = await fakeUv(store.directory, { stdout: '', exitCode: 3 });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('VOICE-UNKNOWN');
  }));
  const audioBytes = Buffer.from('OggS synthetic opus payload');
  const files = new Map([['voice-2', { path: 'voice/file_3.oga', bytes: audioBytes, contentType: 'audio/ogg' }]]);
  const transport = telegramMock([[voiceUpdate(530, 130, {
    fileId: 'voice-2', uniqueId: 'unique-voice-2', bytes: audioBytes,
  })]], files);
  let harness;
  try {
    harness = start(store, transport, ['501'], {
      directory: 'media',
      transcription: { uvPath, timeoutMs: 10_000 },
    });
    await until(() => transport.sent.some((entry) => entry.text === 'VOICE-UNKNOWN'), 'voice answer');
    const text = messageText(userMessages(requests)[0]);
    assert.match(text, /Recognized speech: unavailable \(the local speech backend or model is not provisioned\); the speech was not understood\./);
    assert.doesNotMatch(text, /"SYNTHETIC TRANSCRIPT"/);
    assert.match(text, /Stored file \(workspace-relative\): media\/audio-/);
    assert.equal((await mediaFiles(store.workspace)).length, 1);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a too-large or rejected Telegram file becomes a truthful note and the turn still runs', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('too-large', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('LARGE-NOTED');
  }));
  const files = new Map([[
    'big-1',
    { path: 'documents/file_9.bin', bytes: Buffer.from('x'), declaredSize: 25 * 1024 * 1024 },
  ]]);
  const transport = telegramMock([[
    // The message already announces an oversize file: no getFile call is spent on it.
    documentUpdate(540, 140, {
      fileId: 'big-1', uniqueId: 'unique-big-1', bytes: Buffer.from('x'), fileName: 'big.bin',
      mimeType: 'application/octet-stream', declaredSize: 25 * 1024 * 1024,
    }),
    // This one announces a small message but getFile reports the real oversize.
    documentUpdate(541, 141, {
      fileId: 'big-2', uniqueId: 'unique-big-2', bytes: Buffer.from('x'), fileName: 'big2.bin',
      mimeType: 'application/octet-stream',
    }),
  ]], files);
  files.set('big-2', { path: 'documents/file_10.bin', bytes: Buffer.from('x'), declaredSize: 25 * 1024 * 1024 });
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.filter((entry) => entry.text === 'LARGE-NOTED').length === 2, 'both large-file answers');
    assert.equal(transport.getFileCalls.length, 1, 'only the under-advertised file reached getFile');
    assert.equal(transport.downloads.length, 0, 'an oversize file is never downloaded');
    assert.deepEqual(await mediaFiles(store.workspace), []);
    for (const request of requests) {
      assert.match(userMessages([request]).map(messageText).join('\n'),
        /The file could not be stored \(the file exceeds the configured size limit\)\./);
    }
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('an unsafe advertised file path is refused before any second request', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('unsafe-path', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('PATH-REFUSED');
  }));
  const files = new Map([['doc-2', { path: '../../etc/passwd', bytes: Buffer.from('root:x:0:0'), contentType: 'text/plain' }]]);
  const transport = telegramMock([[
    documentUpdate(545, 145, { fileId: 'doc-2', uniqueId: 'unique-doc-2', bytes: Buffer.from('root:x:0:0'), fileName: 'passwd', mimeType: 'text/plain' }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'PATH-REFUSED'), 'path-refusal answer');
    assert.equal(transport.getFileCalls.length, 1);
    assert.equal(transport.downloads.length, 0, 'no request was made to an unvalidated path');
    assert.match(messageText(userMessages(requests)[0]), /The file could not be stored \(the file locator was rejected as unsafe\)\./);
    assert.deepEqual(await mediaFiles(store.workspace), []);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('authentication happens before any file request', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('auth-first', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 4 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('NEVER');
  }));
  const files = new Map([['photo-9', { path: 'photos/file_9.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg' }]]);
  const transport = telegramMock([[
    photoUpdate(550, 150, { fileId: 'photo-9', uniqueId: 'unique-photo-9', bytes: PHOTO_BYTES }, 998),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.length === 0, 'no delivery');
    await flush();
    assert.equal(requests.length, 0, 'an unauthorized sender never reaches the model');
    assert.equal(transport.getFileCalls.length, 0, 'an unauthorized sender never triggers getFile');
    assert.equal(transport.downloads.length, 0);
    assert.deepEqual(await mediaFiles(store.workspace), []);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a symlinked or hardlinked locator is refused and never written through', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('links', { media: { directory: 'media' } });
  const mediaRoot = join(store.workspace, 'media');
  await mkdir(mediaRoot, { mode: 0o700 });
  const outside = join(store.directory, 'outside.txt');
  await writeFile(outside, 'OUTSIDE SECRET');
  const storeApi = createMediaStore({ workspace: store.workspace, directory: 'media' });
  // Deterministic locators for the two identities the mocked update will use.
  const symlinked = storeApi.locator('telegram:document:unique-link-1', 'document', 'text/plain');
  const hardlinked = storeApi.locator('telegram:document:unique-link-2', 'document', 'text/plain');
  await symlink(outside, join(store.workspace, symlinked));
  await link(outside, join(store.workspace, hardlinked));

  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('LINKS-REFUSED');
  }));
  const files = new Map([
    ['link-1', { path: 'documents/file_1.txt', bytes: Buffer.from('HOSTILE ONE'), contentType: 'text/plain' }],
    ['link-2', { path: 'documents/file_2.txt', bytes: Buffer.from('HOSTILE TWO'), contentType: 'text/plain' }],
  ]);
  const transport = telegramMock([[
    documentUpdate(560, 160, { fileId: 'link-1', uniqueId: 'unique-link-1', bytes: Buffer.from('HOSTILE ONE'), fileName: 'one.txt', mimeType: 'text/plain' }),
    documentUpdate(561, 161, { fileId: 'link-2', uniqueId: 'unique-link-2', bytes: Buffer.from('HOSTILE TWO'), fileName: 'two.txt', mimeType: 'text/plain' }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.filter((entry) => entry.text === 'LINKS-REFUSED').length === 2, 'both refusals');
    const refused = new Set(requests.map((request) =>
      userMessages([request]).map(messageText).join('\n'))
      .filter((text) => /The file could not be stored \(the file locator was rejected as unsafe\)\./.test(text)));
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(userMessages([request]).map(messageText).join('\n'),
        /The file could not be stored \(the file locator was rejected as unsafe\)\./);
    }
    assert.equal(refused.size, 2, 'both attachments were refused');
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE SECRET', 'the outside file was never overwritten');
    const names = await readdir(mediaRoot);
    assert.equal(names.filter((name) => name.startsWith('.tmp-')).length, 0, 'no temporary file was left behind');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a symlinked media directory is refused and nothing is written through it', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('symlink-dir', { media: { directory: 'media' } });
  const outside = join(store.directory, 'outside-dir');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(store.workspace, 'media'));
  const requests = [];
  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('DIR-REFUSED');
  }));
  const files = new Map([['doc-4', { path: 'documents/file_4.txt', bytes: Buffer.from('DATA'), contentType: 'text/plain' }]]);
  const transport = telegramMock([[
    documentUpdate(565, 165, { fileId: 'doc-4', uniqueId: 'unique-doc-4', bytes: Buffer.from('DATA'), fileName: 'data.txt', mimeType: 'text/plain' }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'DIR-REFUSED'), 'directory refusal');
    assert.match(messageText(userMessages(requests)[0]),
      /The file could not be stored \(the attachment directory is not a plain directory inside the workspace\)\./);
    assert.deepEqual(await readdir(outside), [], 'nothing was written through the symlinked directory');
    assert.equal((await lstat(join(store.workspace, 'media'))).isSymbolicLink(), true, 'the symlink was left untouched');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a symlinked workspace root is canonicalized for media storage and delivery', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('root-symlink', { media: { directory: 'media' } });
  const alias = join(store.directory, 'workspace-alias');
  await symlink(store.workspace, alias);
  const requests = [];
  store.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('ROOT-SYMLINK-OK');
  }));
  const files = new Map([['photo-root', { path: 'photos/file_root.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg' }]]);
  const transport = telegramMock([[
    photoUpdate(606, 206, { fileId: 'photo-root', uniqueId: 'unique-root', bytes: PHOTO_BYTES, caption: 'root alias' }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport, ['501'], store.config.media, alias);
    await until(() => transport.sent.some((entry) => entry.text === 'ROOT-SYMLINK-OK'), 'root-alias answer');
    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1, 'the original landed in the canonical workspace');
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), PHOTO_BYTES);
    assert.equal((await lstat(alias)).isSymbolicLink(), true, 'the operator alias was left untouched');
    const message = userMessages(requests)[0];
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content.filter((part) => part.type === 'image').length, 1);
    // The shared store resolves the alias to the same canonical original.
    const direct = createMediaStore({ workspace: alias, directory: 'media' });
    const deduped = await direct.save({
      kind: 'photo', identity: 'telegram:photo:unique-root', mimeType: 'image/jpeg',
      body: (async function* () { yield PHOTO_BYTES; })(),
    });
    assert.equal(deduped.relativePath, `media/${stored[0]}`);
    assert.equal((await readdir(join(store.workspace, 'media'))).length, 1, 'no duplicate was written');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('an aborted download keeps the admitted update and no partial file; a reopen delivers it once', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('abort-reopen', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 20 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('RECOVERED-PHOTO');
  }));
  const file = { path: 'photos/file_5.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg', hang: true };
  const files = new Map([['photo-5', file]]);
  const update = photoUpdate(570, 170, { fileId: 'photo-5', uniqueId: 'unique-photo-5', bytes: PHOTO_BYTES });
  const transport = telegramMock([[update]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.downloads.length === 1, 'the download attempt started');
    await stop(harness);
    harness = undefined;
    assert.equal(requests.length, 0, 'the aborted download never submitted a turn');
    assert.deepEqual(await mediaFiles(store.workspace), [], 'no partial or temporary file survived the abort');

    const stateConversation = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
    const pending = await stateConversation.commit(async (tx) => {
      const doc = await tx.doc(TelegramState, stateConversation.id);
      return JSON.parse(JSON.stringify(doc.pending));
    }, context);
    assert.equal(pending.length, 1, 'the admitted update was not lost');
    assert.equal(pending[0].attachments[0].status, 'pending');

    // Reopen: the durable pending record is delivered, downloading the file exactly once.
    file.hang = false;
    const replay = telegramMock([[update]], files);
    harness = start(store, replay);
    await until(() => replay.sent.some((entry) => entry.text === 'RECOVERED-PHOTO'), 'recovered answer');
    assert.equal(replay.getFileCalls.length, 1, 'the reopen downloads the attachment');
    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1);
    const message = userMessages(requests)[0];
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content.filter((part) => part.type === 'image').length, 1);
    transport.restore();
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('the same Telegram file sent twice is stored once and every turn keeps the same locator', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('file-dedupe', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('DEDUPE-OK');
  }));
  const files = new Map([['photo-7', { path: 'photos/file_7.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg' }]]);
  const transport = telegramMock([[
    photoUpdate(580, 180, { fileId: 'photo-7', uniqueId: 'unique-photo-7', bytes: PHOTO_BYTES }),
    photoUpdate(581, 181, { fileId: 'photo-7', uniqueId: 'unique-photo-7', bytes: PHOTO_BYTES }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.filter((entry) => entry.text === 'DEDUPE-OK').length === 2, 'both turns');
    assert.equal(transport.getFileCalls.length, 1, 'the content-stable identity avoided a second download');
    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1);
    assert.equal(requests.length, 2);
    const locators = requests.map((request) => {
      const matches = [...userMessages([request]).map(messageText).join('\n')
        .matchAll(/media\/photo-[0-9a-f]{16}\.jpg/g)].map((match) => match[0]);
      return matches[0];
    });
    assert.ok(locators.every((locator) => locator !== undefined), 'every turn names the stored file');
    assert.equal(new Set(locators).size, 1, 'both turns name the same stored file');

    // The update offset is durable: replaying it after a reopen creates no third turn or download.
    await stop(harness);
    harness = undefined;
    const replay = telegramMock([[
      photoUpdate(580, 180, { fileId: 'photo-7', uniqueId: 'unique-photo-7', bytes: PHOTO_BYTES }),
    ]], files);
    harness = start(store, replay);
    await flush();
    await flush();
    assert.equal(replay.getFileCalls.length, 0);
    assert.equal(requests.length, 2);
    transport.restore();
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a control that forces an earlier media message to submit keeps its image content', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('control-media', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('CONTROL-PHOTO-OK');
  }));
  // The first download is a transient failure, so the photo is still pending when /new arrives.
  const files = new Map([[
    'photo-control',
    { path: 'photos/file_control.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg', downloadFailures: 1 },
  ]]);
  let releaseNextPoll;
  const nextPoll = new Promise((resolve) => { releaseNextPoll = resolve; });
  const transport = telegramMock([
    [photoUpdate(590, 190, { fileId: 'photo-control', uniqueId: 'unique-control-photo', bytes: PHOTO_BYTES, caption: 'held photo' })],
    [textUpdate(591, 191, '/new')],
    async () => { await nextPoll; return []; },
  ], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => /Context reset applied/.test(entry.text)), 'reset acknowledgement');
    // The transient failure is retried on the next poll, after the control forced the
    // earlier media message to be submitted first.
    releaseNextPoll();
    await until(() => transport.sent.some((entry) => entry.text === 'CONTROL-PHOTO-OK'), 'photo answer');
    assert.equal(transport.getFileCalls.length >= 1, true);

    const photoTurn = requests
      .map((request) => userMessages([request]))
      .find((messages) => messages.some((message) => messageText(message).includes('held photo')));
    assert.ok(photoTurn, 'the pre-control photo turn reached the model');
    const images = photoTurn.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === 'image');
    assert.equal(images.length, 1, 'the forced submission kept the native image content');
    assert.equal(images[0].data, PHOTO_BYTES.toString('base64'));
    assert.equal((await mediaFiles(store.workspace)).length, 1);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a transient attachment failure during a control flush keeps polling and defers the command honestly', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('control-deferred', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 24 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('OK-REPLY');
  }));
  const file = {
    path: 'photos/file_deferred.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg', failDownloads: true,
  };
  const files = new Map([['photo-deferred', file]]);
  let releaseNextPoll;
  const nextPoll = new Promise((resolve) => { releaseNextPoll = resolve; });
  const transport = telegramMock([
    [photoUpdate(700, 300, { fileId: 'photo-deferred', uniqueId: 'unique-deferred', bytes: PHOTO_BYTES, caption: 'deferred photo' })],
    [textUpdate(701, 301, '/new')],
    [textUpdate(702, 302, 'other chat is alive', 999)],
    async () => { await nextPoll; return []; },
  ], files);
  let harness;
  try {
    harness = start(store, transport, ['501', '999']);
    // Another chat keeps being served while this chat's command waits for its earlier input.
    await until(() => transport.sent.some((entry) => entry.chatId === 999 && entry.text === 'OK-REPLY'), 'other chat answer');
    await until(() => transport.sent.some((entry) => /Context reset is still pending/.test(entry.text)), 'honest pending ack');
    assert.ok(!transport.sent.some((entry) => /Context reset applied/.test(entry.text)), 'no false applied claim');
    assert.equal(transport.sent.filter((entry) => entry.chatId === CHAT_ID && entry.text === 'OK-REPLY').length, 0,
      'the gated chat delivers no model reply while the command is deferred');
    assert.deepEqual(await mediaFiles(store.workspace), [], 'the failed download stored nothing');

    // Controlled recovery: the transient failure stops and the next poll retries the deferred flush.
    file.failDownloads = false;
    releaseNextPoll();
    await until(() => transport.sent.some((entry) => entry.chatId === CHAT_ID && entry.text === 'OK-REPLY'), 'deferred photo answer');
    const stored = await mediaFiles(store.workspace);
    assert.equal(stored.length, 1);
    assert.deepEqual(await readFile(join(store.workspace, 'media', stored[0])), PHOTO_BYTES);
    const photoTurns = requests.filter((request) =>
      userMessages([request]).some((message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'image') &&
        messageText(message).includes('deferred photo')));
    assert.equal(photoTurns.length, 1, 'the earlier media turn is submitted exactly once');
    const images = userMessages([photoTurns[0]]).flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === 'image');
    assert.equal(images.length, 1, 'the recovered turn kept its native image content');
    assert.equal(transport.sent.filter((entry) => entry.chatId === CHAT_ID && entry.text === 'OK-REPLY').length, 1,
      'the earlier photo is delivered exactly once');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a newer control is refused while an earlier one is still applying, so resets never reorder', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('control-applying', { media: { directory: 'media' } });
  const requests = [];
  store.faux.setResponses(Array.from({ length: 24 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('OK-REPLY');
  }));
  let releaseDownload;
  const downloadGate = new Promise((resolve) => { releaseDownload = resolve; });
  let releasePostReset;
  const postResetGate = new Promise((resolve) => { releasePostReset = resolve; });
  const files = new Map([[
    'photo-hold',
    { path: 'photos/file_hold.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg', downloadGate },
  ]]);
  const transport = telegramMock([
    [photoUpdate(800, 400, { fileId: 'photo-hold', uniqueId: 'unique-hold', bytes: PHOTO_BYTES, caption: 'pre-command photo' })],
    [textUpdate(801, 401, '/new')],
    [textUpdate(802, 402, '/new'), textUpdate(803, 403, '/new')],
    async () => { await postResetGate; return [textUpdate(804, 404, 'after reset ping')]; },
  ], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.downloads.length === 1, 'the first flush download started');
    // Both newer commands are refused durably while the first is still applying. Their notices
    // wait behind the first command's held acknowledgement, so inspect the durable records.
    await untilAsync(async () => {
      const doc = await telegramState(store.gateway);
      const refusals = doc.pending.filter((item) => item.notice === true && item.updateId > 801 &&
        /still being applied or is still pending/.test(item.text));
      return refusals.length === 2 && doc.controls.length === 1;
    }, 'both newer commands refused while the first applies');
    assert.equal(transport.sent.filter((entry) => /Context reset applied/.test(entry.text)).length, 0,
      'no reset is claimed while the first command is still applying');

    releaseDownload();
    await until(() => transport.sent.some((entry) => /Context reset applied/.test(entry.text)), 'the first command applied');
    await until(() => transport.sent.some((entry) => entry.chatId === CHAT_ID && entry.text === 'OK-REPLY'), 'photo answer');
    assert.equal(transport.sent.filter((entry) => /Context reset applied/.test(entry.text)).length, 1,
      'exactly one reset was applied');
    await until(() => transport.sent.filter((entry) => /still being applied or is still pending/.test(entry.text)).length === 2,
      'both refusals were delivered after the earlier acknowledgement');
    const photoTurns = requests.filter((request) =>
      userMessages([request]).some((message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'image') &&
        messageText(message).includes('pre-command photo')));
    assert.equal(photoTurns.length, 1, 'the pre-command photo turn kept its native image and ran once');
    assert.equal((await mediaFiles(store.workspace)).length, 1);

    // A normal message after the reset must start a fresh episode: the actual main
    // conversation request (not the episode-summary helper) must not carry the
    // pre-command photo or any image content.
    releasePostReset();
    await until(() => transport.sent.filter((entry) => entry.chatId === CHAT_ID && entry.text === 'OK-REPLY').length === 2,
      'post-reset answer');
    const postResetTurns = requests.filter((request) =>
      !isEpisodeSummaryRequest(request) &&
      userMessages([request]).some((message) => messageText(message).includes('after reset ping')));
    assert.equal(postResetTurns.length, 1, 'one main-conversation request for the post-reset message');
    const postResetMessages = userMessages([postResetTurns[0]]);
    assert.equal(postResetMessages.length, 1, 'the reset started a fresh episode');
    assert.match(messageText(postResetMessages[0]), /after reset ping/);
    assert.doesNotMatch(messageText(postResetMessages[0]), /pre-command photo/,
      'the pre-command photo stayed in the pre-reset episode');
    const postResetContent = postResetMessages[0].content;
    assert.equal(typeof postResetContent === 'string' ? 0 : postResetContent.filter((part) => part.type === 'image').length, 0,
      'no pre-command image content leaked into the post-reset request');
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('a reopened pending record reuses the stored file and cached transcript without re-downloading', { timeout: 25_000 }, async () => {
  const store = await syntheticStore('reopen-stored', { media: { directory: 'media' } });
  const { path: uvPath, recordPath } = await fakeUv(store.directory);
  const mediaStore = createMediaStore({ workspace: store.workspace, directory: 'media' });
  const bytes = (buffer) => (async function* () { yield buffer; })();
  const photo = await mediaStore.save({
    kind: 'photo', identity: 'telegram:photo:unique-reopen', mimeType: 'image/jpeg', body: bytes(PHOTO_BYTES),
  });
  const audioBytes = Buffer.from('OggS cached audio');
  const audio = await mediaStore.save({
    kind: 'audio', identity: 'telegram:audio:unique-reopen', mimeType: 'audio/ogg', body: bytes(audioBytes),
  });
  const sessionKey = `telegram:${BOT_ID}:chat:${CHAT_ID}`;
  const stateConversation = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  await stateConversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, stateConversation.id);
    doc.pending.push({
      updateId: 700, nextChunkIndex: 0, chatId: CHAT_ID, sessionKey, senderId: '501', text: 'a stored photo',
      attachments: [{
        kind: 'photo', identity: photo.identity, fileId: 'never-fetched', status: 'stored',
        relativePath: photo.relativePath, bytes: photo.bytes, mimeType: 'image/jpeg',
      }],
    });
    doc.pending.push({
      updateId: 701, nextChunkIndex: 0, chatId: CHAT_ID, sessionKey, senderId: '501', text: 'a stored voice note',
      attachments: [{
        kind: 'audio', identity: audio.identity, fileId: 'never-fetched', status: 'stored',
        relativePath: audio.relativePath, bytes: audio.bytes, mimeType: 'audio/ogg',
      }],
      transcript: 'CACHED SPEECH',
    });
    doc.offset = 702;
  }, context);

  const requests = [];
  store.faux.setResponses(Array.from({ length: 12 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage('REOPENED-OK');
  }));
  const transport = telegramMock([[]]);
  let harness;
  try {
    harness = start(store, transport, ['501'], {
      directory: 'media',
      transcription: { uvPath, timeoutMs: 10_000 },
    });
    await until(() => transport.sent.filter((entry) => entry.text === 'REOPENED-OK').length === 2, 'both reopened turns');
    assert.equal(transport.getFileCalls.length, 0, 'stored attachments are never downloaded again');
    assert.equal(transport.downloads.length, 0);
    await assert.rejects(readFile(recordPath), /ENOENT/, 'a cached transcript is never recomputed');
    assert.equal((await mediaFiles(store.workspace)).length, 2, 'no duplicate originals were written');

    const texts = requests.map((request) => userMessages([request]));
    const photoTurn = texts.find((messages) => messages.some((message) => messageText(message).includes('a stored photo'))) ?? [];
    assert.ok(photoTurn.length > 0);
    const photoImages = photoTurn.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === 'image');
    assert.equal(photoImages.length, 1);
    assert.equal(photoImages[0].data, PHOTO_BYTES.toString('base64'));
    const voiceText = texts.map((messages) => messages.map(messageText).join('\n'))
      .find((text) => text.includes('a stored voice note')) ?? '';
    assert.match(voiceText, /"CACHED SPEECH"/);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('the shared store keeps unknown document formats as safe generic originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-media-store-'));
  try {
    const store = createMediaStore({ workspace: directory, directory: 'incoming/files' });
    const source = Buffer.from([0, 1, 2, 3, 0xff]);
    const request = {
      kind: 'document',
      identity: 'telegram:document:unique-generic',
      mimeType: 'application/x-unknown',
      originalName: 'report.weird',
      body: (async function* () { yield source; })(),
    };
    const saved = await store.save(request);
    assert.match(saved.relativePath, /^incoming\/files\/document-[0-9a-f]{16}\.bin$/);
    assert.deepEqual(await store.read(saved.relativePath), source);
    const repeated = await store.save({ ...request, body: (async function* () { yield source; })() });
    assert.equal(repeated.relativePath, saved.relativePath, 'the identity maps to the same file');
    assert.deepEqual(await readdir(join(directory, 'incoming/files')), [saved.relativePath.split('/').pop()],
      'a repeated store leaves exactly one original and no temporary file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent stores of one identity publish one complete original', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-media-concurrent-'));
  try {
    const store = createMediaStore({ workspace: directory, directory: 'media' });
    const bytes = Buffer.from('same identity body');
    const request = () => ({
      kind: 'document',
      identity: 'telegram:document:unique-concurrent',
      mimeType: 'text/plain',
      body: (async function* () { yield bytes; })(),
    });
    const [first, second] = await Promise.all([store.save(request()), store.save(request())]);
    assert.equal(first.relativePath, second.relativePath);
    assert.equal(first.bytes, bytes.byteLength);
    assert.equal(second.bytes, bytes.byteLength);
    assert.deepEqual(await store.read(first.relativePath), bytes);
    assert.deepEqual(await readdir(join(directory, 'media')), [first.relativePath.split('/').pop()],
      'one complete original and no temporary file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a transient workspace-root resolution failure does not poison the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-media-root-retry-'));
  try {
    const root = join(directory, 'workspace');
    // A self-referential symlink makes realpath fail transiently (ELOOP).
    await symlink(root, root);
    const store = createMediaStore({ workspace: root, directory: 'media' });
    const request = () => ({
      kind: 'document',
      identity: 'telegram:document:retry-root',
      mimeType: 'text/plain',
      body: (async function* () { yield Buffer.from('retry body'); })(),
    });
    await assert.rejects(store.save(request()), (error) => error instanceof Error);

    // The same intended root now resolves; a poisoned memo would keep failing here.
    await unlink(root);
    await mkdir(root, { mode: 0o700 });
    const saved = await store.save(request());
    assert.match(saved.relativePath, /^media\/document-[0-9a-f]{16}\.txt$/);
    assert.deepEqual(await store.read(saved.relativePath), Buffer.from('retry body'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a configured vision handoff describes the Telegram photo for a text-only main model', { timeout: 30_000 }, async () => {
  // Cross-feature check: the media adapter submits native image content through the normal
  // gateway turn, and the main vision hook (owned by the vision slice) describes it for a
  // flagged text-only preset. No adapter-side describer and no duplicated image pipeline.
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-telegram-vision-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const provider = fauxProvider({ provider: 'tg-vision', models: [
    { id: 'chat', name: 'Chat', reasoning: false, input: ['text'] },
    { id: 'eyes', name: 'Eyes', reasoning: false, input: ['text', 'image'] },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const calls = [];
  const dispatcher = (transcript, _options, _state, model) => {
    const describer = model.id === 'eyes';
    const images = transcript.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'image')
      : []);
    const text = transcript.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'text').map((part) => part.text)
      : []).join('\n');
    calls.push({
      kind: describer ? 'describer' : 'generation',
      modelId: model.id,
      images: images.length,
      data: images.map((part) => part.data),
      text,
    });
    return fauxAssistantMessage(describer ? 'synthetic description of the telegram photo' : 'OK-VISION');
  };
  provider.setResponses(Array.from({ length: 80 }, () => dispatcher));
  const config = parseConfig({
    workspace,
    dataDir: join(directory, 'state'),
    modelPresets: {
      chat: { provider: 'tg-vision', modelId: 'chat', needsVisionHandoff: true },
      eyes: { provider: 'tg-vision', modelId: 'eyes' },
    },
    modelPreset: 'chat',
    visionHandoff: { describerPreset: 'eyes' },
    toolAllowlist: [],
    telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom: ['501'] },
    media: { directory: 'media' },
  }, directory);
  const gateway = await openGateway(config, context, { models });
  const store = { directory, workspace, gateway, config };
  const files = new Map([['photo-vision', { path: 'photos/file_vision.jpg', bytes: PHOTO_BYTES, contentType: 'image/jpeg' }]]);
  const transport = telegramMock([[
    photoUpdate(900, 500, { fileId: 'photo-vision', uniqueId: 'unique-vision', bytes: PHOTO_BYTES, caption: 'vision telegram photo' }),
  ]], files);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.some((entry) => entry.text === 'OK-VISION'), 'vision main answer');

    const describers = calls.filter((call) => call.kind === 'describer');
    assert.equal(describers.length, 1, 'one describer call for the Telegram photo');
    assert.equal(describers[0].modelId, 'eyes');
    assert.equal(describers[0].images, 1, 'the describer received the original image');
    assert.equal(describers[0].data[0], PHOTO_BYTES.toString('base64'));

    const main = calls.filter((call) => call.kind === 'generation' && call.modelId === 'chat' &&
      call.text.includes('[An image is attached in the conversation transcript'));
    assert.equal(main.length, 1, 'one transformed main-conversation request');
    assert.equal(main[0].images, 0, 'the text-only main model received no raw image');
    assert.match(main[0].text, /synthetic description of the telegram photo/);
    assert.match(main[0].text, /vision telegram photo/);
    assert.match(main[0].text, /Stored file \(workspace-relative\): media\//);

    const stored = await mediaFiles(workspace);
    assert.equal(stored.length, 1, 'the authoritative original is on disk');
    assert.deepEqual(await readFile(join(workspace, 'media', stored[0])), PHOTO_BYTES);
  } finally {
    await cleanup(store, harness, transport);
  }
});

test('media config is validated and traversal directories are refused before startup', async () => {
  assert.equal(validateMediaDirectory(undefined), 'media');
  assert.equal(validateMediaDirectory('attachments/incoming'), 'attachments/incoming');
  for (const bad of ['../outside', '/abs', 'a/../../b', 'a//b', 'a\\b', '']) {
    assert.throws(() => validateMediaDirectory(bad), /media\.directory/);
  }
  assert.equal(sanitizeOriginalName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeOriginalName('a\u0000b\nc'), 'a b c');

  const base = { workspace: '.', dataDir: '.state', model: { provider: 'p', modelId: 'm' } };
  const parsed = parseConfig({ ...base, media: { directory: 'media', transcription: { language: 'en', maxDurationSeconds: 90 } } }, '/tmp');
  assert.equal(parsed.media.directory, 'media');
  assert.deepEqual(parsed.media.transcription, { language: 'en', maxDurationSeconds: 90 });
  assert.deepEqual(parseConfig({ ...base, media: { transcription: { enabled: false } } }, '/tmp').media.transcription,
    { enabled: false });
  assert.equal(parseConfig({ ...base, media: {} }, '/tmp').media.directory, 'media');
  assert.throws(() => parseConfig({ ...base, media: { directory: '../outside' } }, '/tmp'), /media\.directory/);
  assert.throws(() => parseConfig({ ...base, media: { unknown: true } }, '/tmp'), /Unknown media field/);
  assert.throws(() => parseConfig({ ...base, media: { transcription: { enabled: 'yes' } } }, '/tmp'), /enabled must be a boolean/);
  assert.throws(() => parseConfig({ ...base, media: { transcription: { maxDurationSeconds: 0 } } }, '/tmp'), /maxDurationSeconds/);
  assert.throws(() => parseConfig({ ...base, media: { transcription: { cloud: true } } }, '/tmp'), /Unknown media\.transcription field/);
});

test('the bounded body check enforces advertised and actual byte limits', async () => {
  const streamOf = (chunks) => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
  const collect = async (response, maxBytes) => {
    const parts = [];
    for await (const chunk of boundedFileBody(response, maxBytes)) parts.push(chunk);
    return Buffer.concat(parts).byteLength;
  };
  assert.equal(await collect(streamOf([Buffer.from('abc'), Buffer.from('de')]), 5), 5);
  await assert.rejects(collect(streamOf([Buffer.from('abc'), Buffer.from('def')]), 5),
    (error) => error instanceof MediaRejected && error.reason === 'too-large');
  const advertised = new Response(Buffer.from('abc'), { headers: { 'content-length': '100' } });
  await assert.rejects(collect(advertised, 10),
    (error) => error instanceof MediaRejected && error.reason === 'too-large');
});

test('Telegram file paths are validated before a URL is built', () => {
  assert.equal(telegramFilePath('photos/file_1.jpg'), 'photos/file_1.jpg');
  assert.equal(telegramFilePath('documents/report.v2.pdf'), 'documents/report.v2.pdf');
  for (const bad of [undefined, '', '/etc/passwd', '../x', 'photos/../x', 'photos//x', 'a b.jpg', 'a\tb', 'https://evil/x', 42]) {
    assert.equal(telegramFilePath(bad), undefined, `rejected ${String(bad)}`);
  }
});

test('attachment text never claims a document was read and labels failed speech', () => {
  const document = {
    kind: 'document', identity: 'x', fileId: 'f', status: 'stored',
    relativePath: 'media/document-0000000000000000.pdf', bytes: 1024, mimeType: 'application/pdf',
    originalName: 'report.pdf',
  };
  const text = attachmentContextText(document);
  assert.match(text, /No content was extracted/);
  assert.match(text, /untrusted metadata/);
  assert.match(text, /media\/document-0000000000000000\.pdf/);

  const voice = { ...document, kind: 'audio', relativePath: 'media/audio-0000000000000000.oga', mimeType: 'audio/ogg' };
  const failed = attachmentContextText(voice, { failure: 'local transcription failed' });
  assert.match(failed, /the speech was not understood/);
  assert.doesNotMatch(failed, /Recognized speech \(automatic/);
  const disabled = attachmentContextText(voice, { disabled: true });
  assert.match(disabled, /transcription is disabled/);
});

test('the local transcriber kills a stuck helper group and reports a timeout', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-uv-timeout-'));
  try {
    const pidFile = join(directory, 'pid');
    const helper = join(directory, 'stuck-uv');
    await writeFile(helper, [
      '#!/bin/sh',
      `printf '%s' "$$" > "${pidFile}"`,
      'sleep 30',
      '',
    ].join('\n'), { mode: 0o755 });
    const transcriber = createTranscriber({ uvPath: helper, timeoutMs: 300 });
    const outcome = await transcriber.transcribe(join(directory, 'audio.oga'));
    assert.deepEqual(outcome, { ok: false, reason: 'timeout' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    // The API settles only after the killed child group is reaped: no caller-side wait.
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
