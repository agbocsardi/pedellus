// Telegram owner commands: the native menu, /status, /model, /new with a rebuilt workspace prompt,
// and /restart through an injected host lifecycle.
//
// No bot, credential, network, provider, live process or package install: the Telegram Bot API is a
// mocked fetch, the model is a faux provider over a temporary store, and the only process
// replacement exercised is a controlled child that re-execs itself through dist/restart.js.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');
const [
  { loadConfig, parseConfig },
  { openGateway },
  { runTelegram, TelegramState },
  { workspaceContextGatewayOptions },
  { BACKGROUND_CONTEXT, withCancel },
  { createModels, fauxAssistantMessage, fauxProvider },
  { getCurrentSystemPrompt },
  { MEMORY_DIGEST_RESULT_ENTRY_KIND, MEMORY_DIGEST_TASK_NAME },
] = await Promise.all([
  import(new URL('../dist/config.js', import.meta.url).href),
  import(new URL('../dist/runtime.js', import.meta.url).href),
  import(new URL('../dist/channels/telegram.js', import.meta.url).href),
  import(new URL('../dist/context/workspace-host.js', import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-ai/dist/utils/transcript.js`),
  import(new URL('../dist/history/memory-digest.js', import.meta.url).href),
]);

const context = BACKGROUND_CONTEXT;
const WAIT_MS = 15_000;
const BOT_ID = 7;
const CHAT_ID = 501;
const TOKEN = '123456:synthetic-token';

const PRESETS = {
  fast: { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' },
  'alpha-high': { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'high' },
  deep: { provider: 'fixture', modelId: 'beta', thinkingLevel: 'high' },
};

const SUMMARY_PROMPT_PREFIX = 'You maintain one short factual summary';
const SUMMARY_BODY = 'Title: synthetic episode\n## Topics\n- synthetic\n## Keywords\n- synthetic';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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

async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/**
 * Faux `fixture` provider: `alpha`/`beta` accept every thinking level. Each request records the
 * system prompt it was actually prepared with, and one optional gate parks the current request so a
 * test can inspect committed state while a turn is genuinely running.
 */
function fauxModels(captured) {
  const provider = fauxProvider({
    provider: 'fixture',
    models: [{ id: 'alpha', name: 'Alpha', reasoning: true }, { id: 'beta', name: 'Beta', reasoning: true }],
  });
  const gate = { held: false, entered: undefined, release: undefined };
  const dispatcher = (request) => {
    provider.appendResponses([dispatcher]);
    const system = getCurrentSystemPrompt(request.messages);
    // The background episode-summary pass is derived work, not a chat turn: it is answered with a
    // synthetic summary and never counted as a request the commands under test produced.
    if (system.startsWith(SUMMARY_PROMPT_PREFIX)) return fauxAssistantMessage(SUMMARY_BODY);
    captured.push({ system, messages: request.messages });
    if (!gate.held) return fauxAssistantMessage('SYNTHETIC-REPLY');
    gate.entered?.resolve();
    return new Promise((resolve) => { gate.release = () => resolve(fauxAssistantMessage('SYNTHETIC-REPLY')); });
  };
  provider.setResponses([dispatcher]);
  const models = createModels();
  models.setProvider(provider.provider);
  return {
    models,
    gate: {
      /** Hold the next request; resolves once it has entered the provider. */
      hold() {
        const entered = {};
        entered.promise = new Promise((resolve) => { entered.resolve = resolve; });
        gate.held = true;
        gate.entered = entered;
        return entered.promise;
      },
      release() {
        gate.held = false;
        gate.entered = undefined;
        const release = gate.release;
        gate.release = undefined;
        release?.();
      },
    },
  };
}

async function syntheticStore(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-telegram-commands-${label}-`));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFiles(workspace, options.files ?? {});
  const captured = [];
  const { models, gate } = fauxModels(captured);
  const raw = {
    workspace,
    dataDir: join(directory, 'state'),
    ...(options.presets === false
      ? {
          model: { provider: 'fixture', modelId: 'alpha' },
          allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
        }
      : { modelPresets: options.presets ?? PRESETS, modelPreset: 'fast' }),
    toolAllowlist: options.tools ?? [],
    // Digestion never inherits the foreground model; name one explicitly.
    digest: options.presets === false
      ? { model: { provider: 'fixture', modelId: 'alpha' } }
      : { preset: 'fast' },
    telegram: { tokenEnv: 'TG_SYNTHETIC_TOKEN', allowFrom: options.allowFrom ?? ['501'] },
    ...(options.workspaceContext === undefined ? {} : { workspaceContext: options.workspaceContext }),
    ...(options.episodeSummary === undefined ? {} : { episodeSummary: options.episodeSummary }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
  };
  // A gateway opened from a file also exposes owner MCP management; the object form does not.
  const loaded = options.configFile === true
    ? await (async () => {
        const file = join(directory, 'config.json');
        await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
        return loadConfig(file);
      })()
    : parseConfig(raw, directory);
  const gateway = await openGateway(loaded, context, { models, ...workspaceContextGatewayOptions(loaded) });
  return { directory, workspace, gateway, config: loaded, captured, gate };
}

function privateChat(chatId = CHAT_ID) {
  return { id: chatId, type: 'private', first_name: 'Synthetic' };
}

function privateUser(userId = CHAT_ID) {
  return { id: userId, is_bot: false, first_name: 'Synthetic' };
}

function textUpdate(updateId, messageId, text, chatId = CHAT_ID) {
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

/** Mocked Bot API; batches are served in order, then the long poll holds until the adapter stops. */
function telegramMock(batches) {
  const original = globalThis.fetch;
  const sent = [];
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
        // A batch may be a thunk, so a later update is only served when the test releases it.
        return response(typeof batch === 'function' ? await batch() : batch);
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
    if (method === 'sendRichMessage') {
      const messageId = nextMessageId++;
      const rich = body.rich_message ?? {};
      // The shipped adapter sends markdown; this mock records it as the text the chat sees.
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
  return { sent, commands, restore() { globalThis.fetch = original; } };
}

/** Run the real adapter over the real Gateway, optionally behind a narrow SDK host shape. */
function start(store, transport, options = {}) {
  const scope = withCancel(context);
  const host = options.narrow === true
    ? { conversationFor: (key, ctx) => store.gateway.conversationFor(key, ctx) }
    : store.gateway;
  const adapter = runTelegram(host, {
    token: TOKEN,
    allowFrom: options.allowFrom ?? ['501'],
    pollTimeoutSeconds: 1,
    ...(options.restart === undefined ? {} : { restart: options.restart }),
  }, scope.context);
  return { scope, adapter, transport };
}

async function stop(harness) {
  harness?.scope?.cancel(new DOMException('test finished', 'AbortError'));
  if (harness?.adapter !== undefined) await harness.adapter.catch(() => undefined);
}

async function cleanup(store, harness) {
  await stop(harness);
  await store.gateway.close(context);
  await rm(store.directory, { recursive: true, force: true });
}

async function stateDoc(gateway) {
  const conversation = await gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(TelegramState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

function userTexts(messages) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')));
}

/**
 * Host notices travel as rich markdown, where literal characters are backslash-escaped and the chat
 * renders the bare character; this is the text the reader sees.
 */
function rendered(text) {
  return text.replace(/\\([\\`*_[\]<>~$])/g, '$1');
}

test('a native host advertises exactly the implemented owner commands, with the /stop alias', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('menu');
  const restart = { supported: true, requested: 0, async request() { this.requested += 1; } };
  const transport = telegramMock([[]]);
  let harness;
  try {
    harness = start(store, transport, { restart });
    await until(() => transport.commands.length === 1, 'command menu registration');
    assert.deepEqual(transport.commands[0].scope, { type: 'all_private_chats' });
    // The menu is the catalogue filtered to this host, so its order and wording are not maintained
    // here: names follow the catalogue, descriptions are its one-line summaries.
    assert.deepEqual(transport.commands[0].commands, [
      { command: 'new', description: 'Start a fresh context for this conversation' },
      { command: 'abort', description: 'Stop this turn and withdraw queued messages' },
      { command: 'stop', description: 'Alias of /abort: stop this turn here' },
      { command: 'status', description: "Show this conversation's model and run state" },
      { command: 'model', description: 'List or select a model for this conversation' },
      { command: 'digest', description: 'Start one bounded memory-digestion batch' },
      { command: 'restart', description: 'Replace the whole gateway process' },
      { command: 'help', description: "Show these controls, or one command's detail" },
    ]);
    // The retired `/refresh` is not an owner command: no menu entry and a truthful refusal.
    assert.ok(!transport.commands[0].commands.some((entry) => entry.command === 'refresh'));
    assert.equal(store.captured.length, 0, 'registering commands costs no model request');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a narrow SDK host keeps the base commands and truthfully refuses typed host commands', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('narrow');
  const transport = telegramMock([[
    textUpdate(300, 300, '/status'),
    textUpdate(301, 301, '/model'),
    textUpdate(302, 302, '/restart'),
    textUpdate(303, 303, '/new'),
    textUpdate(304, 304, '/help'),
    textUpdate(305, 305, '/help refresh'),
    textUpdate(306, 306, '/help guarantee'),
    textUpdate(307, 307, '/help ../SYNTHETIC-HELP-ARGUMENT'),
  ]]);
  let harness;
  try {
    harness = start(store, transport, { narrow: true });
    await until(() => transport.commands.length === 1, 'command menu registration');
    assert.deepEqual(transport.commands[0].commands.map((entry) => entry.command), ['new', 'abort', 'stop', 'help']);
    await until(() => transport.sent.length === 8, 'all eight replies');
    const texts = transport.sent.map((entry) => entry.text);
    assert.ok(texts.some((text) => /Status is unavailable in this host/.test(text)));
    assert.ok(texts.some((text) => /Model commands are unavailable in this host/.test(text)));
    assert.ok(texts.some((text) => /Restart is unavailable in this host/.test(text)));
    assert.ok(texts.some((text) => /Context reset applied/.test(text)), 'plain native /new still works');
    // `/refresh` is a terminal command, so `/help refresh` names that instead of "no such command".
    assert.ok(texts.some((text) => /^\/refresh is only available in the terminal\. Available: /m.test(rendered(text))));
    // A truly unknown name is unknown, and an argument that is not shaped like a command is not echoed.
    const unknown = texts.map(rendered).find((text) => /^No such command \/guarantee here\. Available: /.test(text));
    assert.ok(unknown !== undefined);
    const unsafe = texts.map(rendered).find((text) => /^No such command here\. Available: /.test(text));
    assert.ok(unsafe !== undefined);
    assert.doesNotMatch(unsafe, /SYNTHETIC-HELP-ARGUMENT|\.\./i, 'the unsafe argument never reaches the reply');
    const help = texts.find((text) => text.startsWith('Controls for this chat'));
    // Only the offered controls are listed as controls; the rest are named once as not offered.
    assert.match(help, /Not offered by this host: \/status, \/model, \/digest, \/mcp, \/restart\./);
    assert.doesNotMatch(help, /^\/(status|model|restart|digest|refresh)\b/m);
    assert.doesNotMatch(help, /\/refresh/);
    assert.equal(store.captured.length, 0, 'no command reached the model');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a malformed mention of an offered command names the typo instead of denying the command', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('mention-typo');
  const transport = telegramMock([[
    textUpdate(310, 310, '/new@'),
    textUpdate(311, 311, '/abort@'),
    textUpdate(312, 312, '/digest@'),
  ]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.length === 3, 'three malformed-mention notices');
    const texts = transport.sent.map((entry) => rendered(entry.text));
    for (const [index, name] of ['new', 'abort', 'digest'].entries()) {
      // The offered command keeps its name: it is not refused as an unavailable command it is also listed in.
      assert.match(texts[index], new RegExp(`^/${name} is offered here; that mention is malformed, so use /${name} without one\\.`));
      assert.doesNotMatch(texts[index], new RegExp(`/${name} is (not offered by this host|only available)`));
    }
    assert.equal(store.captured.length, 0, 'no malformed mention reached the model');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a full host fits its whole /help listing in one bounded notice and keeps detail on request', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('help-full', { configFile: true });
  const restart = { supported: true, requested: 0, async request() { this.requested += 1; } };
  const transport = telegramMock([[textUpdate(700, 700, '/help'), textUpdate(701, 701, '/help model')]]);
  let harness;
  try {
    harness = start(store, transport, { restart });
    await until(() => transport.sent.length === 2, 'the help listing and one command detail');
    const help = rendered(transport.sent[0].text);
    // Every offered control and the trailing limits line arrive: nothing is cut mid-document.
    assert.match(help, /^Controls for this chat/);
    for (const line of ['new', 'abort', 'stop', 'status', 'model', 'digest', 'mcp', 'restart', 'help']) {
      assert.ok(help.includes(`/${line}`), `the listing names /${line}`);
    }
    assert.match(help, /\/help \[command\] — Show these controls, or one command's detail/);
    assert.match(help, /Text only: attachments are not read and \/attach is not available/);
    assert.doesNotMatch(help, /Not offered by this host/);
    assert.ok(help.length < 1_500, `the help notice is ${help.length} characters, under the notice bound`);
    // Per-command usage and detail stay on the `/help <command>` path.
    const detail = rendered(transport.sent[1].text);
    assert.match(detail, /^Usage: \/model \(list the configured presets\) or \/model <preset> \(or \/model default\)\./);
    assert.match(detail, /\/model alone lists this host's choices; a selection applies to this conversation only, and a preset lasts until the gateway restarts while a direct model persists\./);
    assert.doesNotMatch(help, /selection applies to this conversation only/);
    assert.equal(store.captured.length, 0, 'no help path reached the model');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/mcp lists owner requests and refuses an unknown decision without a model call', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('mcp-commands', { configFile: true });
  const updates = [
    textUpdate(600, 600, '/mcp'),
    textUpdate(601, 601, '/mcp show 0123456789abcdef'),
    textUpdate(602, 602, '/mcp approve 0123456789abcdef'),
    textUpdate(603, 603, '/mcp deny 0123456789abcdef'),
    textUpdate(604, 604, '/mcp bogus'),
  ];
  // One released update at a time: an admitted control gates this chat until it is applied.
  const gates = updates.map(() => deferred());
  const transport = telegramMock(gates.map((gate, index) => async () => {
    await gate.promise;
    return [updates[index]];
  }));
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.commands.length === 1, 'command menu registration');
    assert.ok(transport.commands[0].commands.some((entry) => entry.command === 'mcp'));
    for (let index = 0; index < updates.length; index += 1) {
      gates[index].resolve();
      await until(() => transport.sent.length >= index + 1, `bounded /mcp notice ${index + 1}`);
    }
    await flush();
    const texts = transport.sent.map((entry) => entry.text);
    assert.equal(texts.length, 5);
    assert.match(texts[0], /MCP is not configured in this gateway's open configuration/);
    assert.match(texts[0], /Owner approval requests: none waiting/);
    assert.match(texts[1], /No MCP owner approval request 0123456789abcdef exists/);
    assert.match(texts[2], /No MCP owner approval request 0123456789abcdef exists/);
    assert.match(texts[3], /No MCP owner approval request 0123456789abcdef exists/);
    assert.match(texts[4], /Usage: \/mcp/);
    assert.equal(store.captured.length, 0, 'no /mcp form reached the model');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/digest status, idle and malformed forms are bounded owner notices with no model call', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('digest-idle', { tools: ['read', 'write', 'edit'] });
  const transport = telegramMock([[
    textUpdate(510, 510, '/digest status'),
    textUpdate(511, 511, '/digest'),
    textUpdate(512, 512, '/digest now'),
    // Not an allowlisted sender: the chat is not admitted, so this starts nothing and replies nothing.
    textUpdate(513, 513, '/digest', 999),
  ]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.length === 3, 'three bounded digest notices');
    await flush();
    assert.equal(transport.sent.length, 3, 'an unauthenticated chat gets no digest control');
    assert.match(transport.sent[0].text, /No memory digestion run is recorded for this conversation/);
    assert.match(transport.sent[0].text, /read-only: no scan, no model call/);
    assert.match(transport.sent[1].text, /No completed turn is pending memory digestion/);
    assert.match(transport.sent[1].text, /No new digest run was started/);
    assert.match(transport.sent[2].text, /Usage: \/digest/);
    assert.equal(store.captured.length, 0, 'no digest command form reached the model');
    const tasks = await store.gateway.harness.commit(
      async (tx) => (await tx.scanTasks({ kind: MEMORY_DIGEST_TASK_NAME }, 10)).items,
      context,
    );
    assert.equal(tasks.length, 0, 'neither status nor an idle start creates a digest task');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/digest starts one bounded batch for this authenticated chat and stays silent on success', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('digest-start', {
    tools: ['read', 'write', 'edit'],
    episodeSummary: { enabled: false },
  });
  const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
  await store.gateway.harness.commit(async (tx) => {
    await tx.appendEntry(chat.id, { kind: 'pi.system', model: [{ role: 'system', content: 'boot', timestamp: 1_000 }] });
    // One completed turn with no text evidence: the no-op path without a provider call.
    await tx.appendEntry(chat.id, { kind: 'pi.user', model: [{ role: 'user', content: '', timestamp: 1_000 }] });
    await tx.appendEntry(chat.id, { kind: 'pi.assistant', model: [fauxAssistantMessage('')] });
  }, context);
  await chat.reset(undefined, context);
  const transport = telegramMock([[textUpdate(520, 520, '/digest')]]);
  let harness;
  try {
    harness = start(store, transport);
    await until(() => transport.sent.length >= 1, 'the bounded start acknowledgement');
    assert.match(transport.sent[0].text, /started for one bounded completed-turn batch/);
    assert.match(transport.sent[0].text, /0 evidence entries/);
    assert.match(transport.sent[0].text, /shared workspace/);
    let task;
    await untilAsync(async () => {
      const page = await store.gateway.harness.commit(
        async (tx) => (await tx.scanTasks({ kind: MEMORY_DIGEST_TASK_NAME }, 10)).items,
        context,
      );
      task = page[0];
      return task !== undefined && task.state.status === 'terminal';
    }, 'digest task terminal');
    assert.equal(task.state.outcome.status, 'completed');
    assert.equal(task.state.outcome.result.outcome, 'noop');
    // A successful no-op is silent: no internal result event and no origin-agent model turn. A
    // follow-up start flushes retained notices once, so no delivery path is left unexercised.
    const followUp = await store.gateway.memoryDigest.start({
      id: chat.id,
      commit: (change, ctx) => chat.commit(change, ctx),
    }, context);
    assert.equal(followUp.status, 'idle');
    assert.equal(store.captured.length, 0, 'no internal result turn');
    const entries = (await chat.entries({ order: 'ascending' }, 100, undefined, context)).items;
    const notices = entries.filter((entry) => entry.kind === MEMORY_DIGEST_RESULT_ENTRY_KIND);
    assert.equal(notices.length, 0, 'a successful run delivers no internal result event');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/model lists and selects one configured preset for this chat only', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('model', { tools: ['read'], allowFrom: ['501', '999'] });
  const otherChat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:999`, context);
  const chat = await store.gateway.conversationFor(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context);
  const toolsBefore = (await chat.agent(context)).tools;
  const transport = telegramMock([[
    textUpdate(400, 400, '/model'),
    textUpdate(401, 401, '/model deep'),
    textUpdate(402, 402, '/model'),
    textUpdate(403, 403, '/model nope'),
    textUpdate(404, 404, '/model fixture alpha high'),
    textUpdate(405, 405, '/model default'),
    textUpdate(406, 406, '/refresh'),
  ]]);
  let harness;
  try {
    harness = start(store, transport, { allowFrom: ['501', '999'] });
    await until(() => transport.sent.length === 7, 'model command replies');
    const texts = transport.sent.map((entry) => entry.text);

    const listing = rendered(texts[0]);
    assert.match(listing, /Current model: fixture\/alpha \(thinking: off\)/);
    assert.match(listing, /\* fast — fixture alpha \[thinking: off\]/);
    assert.match(listing, /\n +deep — fixture beta \[thinking: high\]/);
    assert.match(listing, /Configured default preset: fast/);

    assert.match(texts[1], /Selected preset deep for this chat: fixture\/beta \(thinking: high\)/);
    assert.match(texts[1], /Only this chat's selection changed/);
    assert.match(texts[1], /a restart restores the configured default preset/);

    assert.match(rendered(texts[2]), /Current model: fixture\/beta \(thinking: high\)/);
    assert.match(rendered(texts[2]), /\* deep — fixture beta \[thinking: high\]/);

    assert.match(texts[3], /Unknown model preset nope: nothing was changed/);
    assert.match(texts[4], /Usage: \/model \(list the configured presets\)/);
    assert.match(texts[5], /Selected preset default for this chat: fixture\/alpha \(thinking: off\)/);

    // `/refresh` was retired in favour of `/new`; it is refused and never a control. This host has no
    // restart capability, so `/restart` is not offered either.
    // A typed command is refused with the same catalogue reason `/help refresh` gives.
    assert.match(texts[6], /^\/refresh is only available in the terminal\. Available: /m);
    assert.match(texts[6], /Available: \/new, \/abort, \/stop, \/status, \/model, \/digest, \/help/);
    assert.doesNotMatch(texts[6], /restart/);

    assert.deepEqual((await store.gateway.listModels(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context)).selected,
      { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' });
    assert.deepEqual((await store.gateway.listModels(`telegram:${BOT_ID}:chat:999`, context)).selected,
      { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' });
    const otherAgent = await otherChat.agent(context);
    assert.deepEqual(otherAgent.tools, toolsBefore, 'tool authority is unchanged');
    assert.equal(store.config.modelPreset, 'fast', 'the configured default was not rewritten');
    assert.equal(store.captured.length, 0, 'no command reached the model');
  } finally {
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/model is refused atomically while this chat runs a turn', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('model-busy');
  const entered = store.gate.hold();
  let releaseListing;
  const listingBatch = new Promise((resolve) => { releaseListing = resolve; });
  const transport = telegramMock([
    [textUpdate(500, 500, 'hold this turn')],
    [textUpdate(501, 501, 'second queued input')],
    [textUpdate(502, 502, '/model deep')],
    async () => { await listingBatch; return [textUpdate(503, 503, '/model')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await entered;
    assert.equal(store.captured.length, 1);
    await until(() => transport.sent.some((entry) => /Model preset selection rejected: this chat is busy/.test(entry.text)),
      'busy refusal');
    // The refusal changed nothing and scheduled nothing: even before the turn ends, the selection
    // is still the configured default.
    assert.deepEqual((await store.gateway.listModels(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context)).selected,
      { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' });

    store.gate.release();
    await until(() => transport.sent.filter((entry) => entry.text === 'SYNTHETIC-REPLY').length === 2,
      'both admitted messages answered');
    releaseListing();
    await until(() => transport.sent.some((entry) => /Current model: fixture\/alpha/.test(entry.text)), 'later listing');
    // The busy refusal is terminal, not deferred: no late change happened after the turn settled.
    assert.deepEqual((await store.gateway.listModels(`telegram:${BOT_ID}:chat:${CHAT_ID}`, context)).selected,
      { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' });
    assert.equal(store.captured.length, 2, 'only the two admitted messages reached the model');
  } finally {
    releaseListing();
    store.gate.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/status reports bounded current-chat metadata without a model request', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('status');
  const entered = store.gate.hold();
  let releaseIdle;
  const idleBatch = new Promise((resolve) => { releaseIdle = resolve; });
  const transport = telegramMock([
    [textUpdate(600, 600, 'held turn')],
    [textUpdate(601, 601, '/status')],
    [textUpdate(602, 602, '/status now')],
    async () => { await idleBatch; return [textUpdate(603, 603, '/status')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await entered;
    await until(() => transport.sent.some((entry) => entry.text.startsWith('Status for this chat')), 'running status');
    const running = transport.sent.find((entry) => entry.text.startsWith('Status for this chat')).text;
    assert.match(running, /Model: fixture\/alpha \(thinking: off\) — preset fast/);
    assert.match(running, /Run: running \(turn \d+, 1 input\(s\)/);
    assert.match(running, /Queued native inputs: 0/);
    // The background line is this chat's own bounded metadata: nothing runs here, so it is idle.
    assert.match(running, /^Background: idle$/m);
    assert.match(running, /no model call/);
    assert.doesNotMatch(running, /held turn|SYNTHETIC-REPLY|AGENTS-|MEMORY-/);

    await until(() => transport.sent.filter((entry) => /Usage: \/status \(no arguments\)/.test(entry.text)).length === 1,
      'status argument refusal');
    assert.equal(store.captured.length, 1, 'status and its usage refusal cost no model request');

    store.gate.release();
    await until(() => transport.sent.some((entry) => entry.text === 'SYNTHETIC-REPLY'), 'held turn answer');
    releaseIdle();
    await until(() => transport.sent.filter((entry) => entry.text.startsWith('Status for this chat')).length === 2,
      'idle status');
    const idle = transport.sent.filter((entry) => entry.text.startsWith('Status for this chat'))[1].text;
    assert.match(idle, /Run: idle/);
    assert.match(idle, /Queued native inputs: 0/);
    assert.match(idle, /^Background: idle$/m);
    assert.equal(store.captured.length, 1, 'the status view never dispatched a request');
    // No watch or timer is left behind: the adapter's own visible state is the only durable record.
    assert.deepEqual((await stateDoc(store.gateway)).controls, []);
  } finally {
    releaseIdle();
    store.gate.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/new rebuilds the assembled workspace prompt for the new session only', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('new', {
    workspaceContext: { memoryFiles: ['memory/MEMORY.md'], skills: { disabledSkills: [] } },
    files: {
      'AGENTS.md': 'AGENTS-ALPHA',
      'memory/MEMORY.md': 'MEMORY-ALPHA',
      'skills/note-keeping/SKILL.md': [
        '---',
        'name: note-keeping',
        'description: Keep themed notes current',
        '---',
        '',
        '# Note keeping',
        '',
        'Body text is loaded on demand only.',
        '',
      ].join('\n'),
    },
  });
  const entered = store.gate.hold();
  let releaseNew;
  const resetBatch = new Promise((resolve) => { releaseNew = resolve; });
  let releaseAfter;
  const afterBatch = new Promise((resolve) => { releaseAfter = resolve; });
  const transport = telegramMock([
    [textUpdate(700, 700, 'held turn')],
    [textUpdate(701, 701, '/new')],
    async () => { await resetBatch; return [textUpdate(702, 702, '/new')]; },
    async () => { await afterBatch; return [textUpdate(703, 703, 'after reset')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport);
    await entered;
    assert.match(store.captured[0].system, /AGENTS-ALPHA/);
    assert.match(store.captured[0].system, /MEMORY-ALPHA/);
    assert.match(store.captured[0].system, /note-keeping/);

    // The on-disk documents change while that turn is running. A reset+rebuild must not be a
    // mid-run half-effect: it is refused, and the prepared request keeps its captured snapshot.
    await writeFiles(store.workspace, { 'AGENTS.md': 'AGENTS-BETA', 'memory/MEMORY.md': 'MEMORY-BETA' });
    await until(() => transport.sent.some((entry) => /Context reset rejected: this chat has a running turn/.test(entry.text)),
      'busy reset refusal');
    assert.equal(store.captured.length, 1, 'the refusal dispatched no request');
    assert.match(store.captured[0].system, /AGENTS-ALPHA/, 'the running request kept its captured prompt');

    store.gate.release();
    await until(() => transport.sent.some((entry) => entry.text === 'SYNTHETIC-REPLY'), 'held turn answer');
    releaseNew();
    await until(() => transport.sent.some((entry) =>
      /Context reset applied for this chat[\s\S]*assembled workspace prompt was rebuilt from the current files: 1 skill/.test(entry.text)),
    'rebuild acknowledgement');

    releaseAfter();
    await until(() => transport.sent.filter((entry) => entry.text === 'SYNTHETIC-REPLY').length === 2, 'post-reset answer');
    assert.equal(store.captured.length, 2);
    const afterReset = store.captured[1];
    assert.match(afterReset.system, /AGENTS-BETA/, 'the new session uses the current workspace files');
    assert.match(afterReset.system, /MEMORY-BETA/);
    assert.doesNotMatch(afterReset.system, /AGENTS-ALPHA|MEMORY-ALPHA/, 'the stale snapshot was replaced');
    assert.ok(userTexts(afterReset.messages).some((text) => text.includes('after reset')));
    assert.ok(!userTexts(afterReset.messages).some((text) => text.includes('held turn')),
      'the pre-reset turn did not leak into the new session');
  } finally {
    releaseNew();
    releaseAfter();
    store.gate.release();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/restart is requested once after the durable acknowledgement and is never replayed', { timeout: 30_000 }, async () => {
  const store = await syntheticStore('restart');
  const observed = [];
  const restart = {
    supported: true,
    async request() { observed.push(await stateDoc(store.gateway)); },
  };
  let releaseSecond;
  const secondBatch = new Promise((resolve) => { releaseSecond = resolve; });
  const transport = telegramMock([
    [textUpdate(800, 800, '/restart')],
    async () => { await secondBatch; return [textUpdate(801, 801, '/restart')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport, { restart });
    await until(() => observed.length === 1, 'host restart request');
    // The host was asked only after the acknowledgement and offset were durable.
    const doc = observed[0];
    assert.equal(doc.offset, 801);
    assert.deepEqual(doc.controls.map((entry) => ({ command: entry.command, status: entry.status })),
      [{ command: 'restart', status: 'applied' }]);
    assert.ok(doc.pending.some((item) => item.notice === true &&
      /Restart requested for this gateway/.test(item.text) &&
      /does not confirm that the restart completed/.test(item.text)),
    'the durable acknowledgement exists before the host request');
    await until(() => transport.sent.some((entry) =>
      /Restart requested for this gateway/.test(entry.text) &&
      /does not confirm that the restart completed/.test(entry.text)), 'honest acknowledgement');
    await flush();

    releaseSecond();
    await until(() => transport.sent.some((entry) => /A restart was already requested/.test(entry.text)),
      'second restart refused');
    assert.equal(observed.length, 1, 'a second /restart never asks the host again');
    assert.equal(store.captured.length, 0, 'no restart command reached the model');

    // A reopen never replays an already applied restart request.
    await stop(harness);
    harness = undefined;
    transport.restore();
    const reopened = telegramMock([[]]);
    let reopenedHarness;
    try {
      reopenedHarness = start(store, reopened, { restart: { supported: true, async request() { observed.push('again'); } } });
      await flush();
      assert.equal(observed.length, 1);
    } finally {
      await stop(reopenedHarness);
      reopened.restore();
    }

    // An admitted restart interrupted by a crash is reported honestly and is NOT requested again.
    const stateConversation = await store.gateway.conversationFor(`telegram:${BOT_ID}:channel-state`, context);
    await stateConversation.commit(async (tx) => {
      const current = await tx.doc(TelegramState, stateConversation.id);
      current.controls.push({ updateId: 1500, command: 'restart', status: 'admitted', chatId: CHAT_ID, senderId: '501' });
      current.offset = Math.max(current.offset, 1501);
      return undefined;
    }, context);
    const recoveryTransport = telegramMock([[]]);
    let recoveryHarness;
    try {
      recoveryHarness = start(store, recoveryTransport, { restart: { supported: true, async request() { observed.push('recovered'); } } });
      await until(() => recoveryTransport.sent.some((entry) => /That earlier \/restart was interrupted/.test(entry.text)),
        'interrupted restart report');
      const recoveryNotice = recoveryTransport.sent.find((entry) => /That earlier \/restart was interrupted/.test(entry.text)).text;
      assert.match(recoveryNotice, /it is not requested again/);
      assert.deepEqual(observed, [observed[0]], 'recovery never re-requests a restart');
      await untilAsync(async () => (await stateDoc(store.gateway)).pending.every((item) => item.updateId !== 1500),
        'interrupted report delivered');
      const recovered = await stateDoc(store.gateway);
      assert.deepEqual(recovered.controls.map((entry) => entry.status), ['applied'],
        'the interrupted record settled without requesting a restart');
    } finally {
      await stop(recoveryHarness);
      recoveryTransport.restore();
    }
  } finally {
    releaseSecond();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('/stop is the same control as /abort: same record, same effect, one chat', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('stop', { allowFrom: ['501', '999'] });
  const stopMention = deferred();
  const stopArgs = deferred();
  const abortAgain = deferred();
  const afterStops = deferred();
  const transport = telegramMock([
    [textUpdate(900, 900, '/stop'), textUpdate(901, 901, 'other chat stays alive', 999)],
    async () => { await stopMention.promise; return [textUpdate(902, 902, '/stop@synthetic_bot')]; },
    async () => { await stopArgs.promise; return [textUpdate(903, 903, '/stop now'), textUpdate(904, 904, '/stop@other_bot')]; },
    async () => { await abortAgain.promise; return [textUpdate(905, 905, '/abort')]; },
    async () => { await afterStops.promise; return [textUpdate(906, 906, 'after the stops')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport, { allowFrom: ['501', '999'] });
    const applied = () => transport.sent.filter((entry) => /^Abort applied for this chat/.test(entry.text)).length;
    await until(() => applied() === 1 && transport.sent.some((entry) => entry.text === 'SYNTHETIC-REPLY' && entry.chatId === 999),
      'first /stop and the other chat answer');
    stopMention.resolve();
    await until(() => applied() === 2, 'exact-mention /stop');
    stopArgs.resolve();
    await until(() => transport.sent.some((entry) => entry.text.startsWith('Usage: /stop (no arguments).')) &&
      transport.sent.some((entry) => /\/stop@other_bot did not run here/.test(entry.text)), 'argument and foreign refusals');
    abortAgain.resolve();
    await until(() => applied() === 3, '/abort still works');
    afterStops.resolve();
    await until(() => transport.sent.some((entry) => entry.text === 'SYNTHETIC-REPLY' && entry.chatId === CHAT_ID),
      'post-stop answer');

    // One durable control record per applied command, all of the single `abort` kind: the alias is
    // normalized before admission, so there is no second control path or second effect.
    const doc = await stateDoc(store.gateway);
    assert.deepEqual(doc.controls.map((entry) => [entry.command, entry.status, entry.updateId]),
      [['abort', 'applied', 900], ['abort', 'applied', 902], ['abort', 'applied', 905]]);
    assert.ok(!doc.controls.some((entry) => entry.command === 'stop'));
    assert.equal(doc.offset, 907);
    // Only the two ordinary messages reached the model; every refused form was a notice.
    assert.equal(store.captured.length, 2);
    assert.ok(store.captured.some((request) => userTexts(request.messages).some((text) => text.includes('other chat stays alive'))));
    assert.ok(store.captured.some((request) => userTexts(request.messages).some((text) => text.includes('after the stops'))));
  } finally {
    stopMention.resolve();
    stopArgs.resolve();
    abortAgain.resolve();
    afterStops.resolve();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('a refused host restart is reported honestly and never retried', { timeout: 20_000 }, async () => {
  const store = await syntheticStore('restart-refused');
  let calls = 0;
  const restart = {
    supported: true,
    async request() {
      calls += 1;
      throw new Error('host refused the replacement');
    },
  };
  const firstRefused = deferred();
  const transport = telegramMock([
    [textUpdate(950, 950, '/restart')],
    async () => { await firstRefused.promise; return [textUpdate(951, 951, '/restart')]; },
  ]);
  let harness;
  try {
    harness = start(store, transport, { restart });
    // The acknowledgement was already honest: it confirmed the request, not a completed restart.
    await until(() => transport.sent.some((entry) =>
      /Restart requested for this gateway/.test(entry.text) &&
      /does not confirm that the restart completed/.test(entry.text)), 'request acknowledgement');
    await until(() => calls === 1, 'one host request');
    await flush();
    firstRefused.resolve();
    await until(() => transport.sent.some((entry) =>
      /A restart was already requested in this gateway and the host refused it/.test(entry.text)),
    'failed request reported honestly');
    assert.equal(calls, 1, 'a refused request is not retried by a later /restart');
    const doc = await stateDoc(store.gateway);
    assert.deepEqual(doc.controls.map((entry) => entry.status), ['applied']);
  } finally {
    firstRefused.resolve();
    await cleanup(store, harness);
    transport.restore();
  }
});

test('the restart helper replaces the real process image with the same argv and current environment', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-restart-child-'));
  const restartUrl = JSON.stringify(new URL('../dist/restart.js', import.meta.url).href);
  const fixture = join(directory, 'fixture.mjs');
  try {
    await writeFile(fixture, [
      `import { replaceProcess, restartPlan, restartSupported } from ${restartUrl};`,
      'if (!restartSupported()) { console.log("UNSUPPORTED"); process.exit(3); }',
      'if (process.env.NANOBOT_RESTART_PHASE === "2") {',
      '  console.log("REPLACED argv=" + JSON.stringify(process.argv.slice(1)));',
      '  process.exit(0);',
      '}',
      'process.env.NANOBOT_RESTART_PHASE = "2";',
      'console.log("FIRST argv=" + JSON.stringify(process.argv.slice(1)));',
      'replaceProcess(restartPlan());',
      'console.log("UNREACHABLE");',
      '',
    ].join('\n'));
    const child = spawnSync(process.execPath, [fixture], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, NANOBOT_RESTART_SENTINEL: 'sentinel-present' },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trim().split('\n');
    assert.equal(lines.length, 2, child.stdout);
    assert.match(lines[0], /^FIRST argv=\["/);
    // The second process image continued with the same argv and the environment this process set,
    // which proves both were read from the live process instead of a captured startup copy.
    assert.match(lines[1], /^REPLACED argv=\["/);
    assert.equal(lines[0].slice('FIRST argv='.length), lines[1].slice('REPLACED argv='.length));
    assert.doesNotMatch(child.stdout, /UNREACHABLE|UNSUPPORTED/);
    assert.equal(process.env.NANOBOT_RESTART_SENTINEL, undefined, 'the child environment is its own');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
