// The app channel as an MCP login owner surface: a one-time authorization URL reaches only the
// devices streaming right now, never durable state, a push or a log; a pasted callback is offered
// to the login lifecycle before admission and stored nowhere; and a login with no listener is
// canceled instead of waiting.
//
// Real Gateway over a temporary store with a config file (owner MCP management needs one), faux
// provider, a real app adapter on an ephemeral loopback port, a synthetic WebSocket client and the
// loopback OAuth fixture server the MCP management checks use. Every wait is event-driven and
// every handle is cleaned up by the test that created it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  APP_CHAT_SESSION_KEY,
  appState,
  context,
  deviceClient,
  fauxAssistantMessage,
  fauxToolCall,
  loadConfig,
  makeStaticRoot,
  openGateway,
  postPair,
  startApp,
  until,
  untilAsync,
} from './fixtures/app-harness.mjs';
import { fauxModels } from './fixtures/discord-harness.mjs';
import { callbackFromAuthorization, startOAuthMcp } from './fixtures/mcp-oauth-server.mjs';

const { MCP_ADMIN_TOOL_NAME } = await import('../dist/mcp/index.js');
const { generatePushKeys } = await import('../dist/channels/app-push.js');

const MODEL = { provider: 'fixture', modelId: 'alpha' };

function loginCall(id) {
  return () => fauxAssistantMessage(fauxToolCall(MCP_ADMIN_TOOL_NAME, {
    action: 'login', name: 'remote',
  }, { id }), { stopReason: 'toolUse' });
}

const final = (text) => () => fauxAssistantMessage(text);

/** A gateway opened from a config file (so owner MCP management exists) plus a real app adapter. */
async function openLoginChannel(label, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-app-login-${label}-`));
  const workspace = join(directory, 'workspace');
  const staticRoot = await makeStaticRoot(directory);
  const dataDir = join(directory, 'state');
  const configFile = join(directory, 'config.json');
  await mkdir(workspace, { recursive: true });
  await writeFile(configFile, `${JSON.stringify({
    workspace,
    dataDir,
    model: MODEL,
    allowedModels: [MODEL],
    toolAllowlist: [],
    app: { port: 43190, staticRoot },
    ...(options.mcp === undefined ? {} : {
      mcp: { enabled: true, servers: { remote: { url: options.mcp.url, oauth: true } } },
    }),
  }, null, 2)}\n`);
  const config = await loadConfig(configFile);
  const captured = [];
  const { models, gate } = fauxModels(captured);
  const gateway = await openGateway(config, context, { models });
  const store = { gateway, config, workspace, staticRoot };
  const app = startApp(store, options.adapter ?? {});
  const port = await app.port;
  const base = `http://127.0.0.1:${port}`;
  return {
    directory,
    base,
    gateway,
    captured,
    gate,
    app,
    async pair(deviceLabel) {
      const created = await gateway.appConsole.console().pair(deviceLabel);
      assert.equal('refused' in created, false, `pairing was refused: ${JSON.stringify(created)}`);
      const exchange = await postPair(base, created.code, deviceLabel);
      assert.equal(exchange.status, 204, 'pairing exchange failed');
      return exchange.cookie.split(';')[0];
    },
    async close() {
      await app.stop();
      await gateway.close(context).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function helloDevice(base, cookie) {
  const device = deviceClient(base, cookie);
  await device.open();
  device.send({ type: 'req', id: 'h1', op: 'hello', v: 2, cursor: null });
  await device.wait(() => device.response('h1') !== undefined, 'hello reply');
  return device;
}

async function say(conversation, text) {
  const settled = await (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
  assert.equal(settled.status, 'done');
}

async function toolResults(conversation) {
  return (await conversation.entries({}, 200, undefined, context)).items
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === 'toolResult')
    .map((message) => (message.content ?? []).map((part) => part.text ?? '').join(''));
}

async function transcript(conversation) {
  return JSON.stringify((await conversation.entries({}, 200, undefined, context)).items);
}

test('the app delivers an MCP login URL to streaming devices only, never to durable state or push', { timeout: 60_000 }, async () => {
  const mcp = await startOAuthMcp();
  const keys = await generatePushKeys();
  const pushes = [];
  const push = {
    subject: 'mailto:push@example.test',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    transport: async (request) => {
      pushes.push(request);
      return { statusCode: 201 };
    },
  };
  const channel = await openLoginChannel('surface', { mcp, adapter: { push } });
  let first;
  let second;
  let spare;
  try {
    first = await helloDevice(channel.base, await channel.pair('phone'));
    second = await helloDevice(channel.base, await channel.pair('tablet'));
    // A third device subscribes to push and stops streaming: exactly the device a login URL must
    // never be pushed to.
    spare = await helloDevice(channel.base, await channel.pair('spare'));
    spare.send({
      type: 'req', id: 'p1', op: 'push.subscribe',
      subscription: { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'A'.repeat(88), auth: 'A'.repeat(22) } },
    });
    await spare.wait(() => spare.response('p1') !== undefined, 'push subscribe reply');
    assert.equal(spare.response('p1').ok, true);
    await spare.close();
    pushes.length = 0;

    channel.gate.script([loginCall('login-1'), final('login started')]);
    first.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'log in to the remote server' });
    await first.wait(() => first.events('login').length === 1, 'the first login frame');
    await second.wait(() => second.events('login').length === 1, 'the second login frame');
    const login = first.events('login')[0];
    const url = login.url;
    assert.equal(login.thread, 'main');
    assert.equal(login.server, 'remote');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/u);
    assert.ok(Number.isFinite(Date.parse(login.expiresAt)), 'the frame carries the attempt expiry');
    assert.equal(second.events('login')[0].url, url, 'every hello\'d stream receives the same frame');
    assert.equal(spare.frames.filter((frame) => frame.event === 'login').length, 0,
      'a device with no open stream receives no login frame');

    // The URL is live-only: no durable event, channel state or push carries it or its state value.
    const state = JSON.stringify(await appState(channel.gateway));
    assert.equal(state.includes(url), false, 'the authorization URL is not channel state');
    assert.equal(state.includes('state='), false, 'no authorization state is stored');
    const chat = await channel.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    const entries = await transcript(chat);
    assert.equal(entries.includes(url), false, 'the authorization URL is not a transcript entry');
    assert.equal(entries.includes('state='), false);
    assert.equal(channel.captured.some((entry) => JSON.stringify(entry.messages).includes(url)), false,
      'the model never sees the authorization URL');
    await until(() => pushes.length > 0, 'the ordinary answer pushes to the offline device');
    assert.equal(pushes.some((request) => request.payload.includes(url) || request.payload.includes('state=')), false,
      'a push payload never carries the login URL');
  } finally {
    await first?.close();
    await second?.close();
    await spare?.close();
    await mcp.close();
    await channel.close();
  }
});

test('an app login with no streaming device is canceled', { timeout: 60_000 }, async () => {
  const mcp = await startOAuthMcp();
  const channel = await openLoginChannel('no-socket', { mcp });
  try {
    channel.gate.script([loginCall('login-1'), final('login attempted')]);
    const chat = await channel.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    await say(chat, 'log in to the remote server');
    const results = (await toolResults(chat)).join('\n');
    assert.match(results, /could not be confirmed as delivered/u);
    assert.match(results, /login was canceled/u);
    assert.equal((await channel.gateway.mcpAdmin.list(context)).logins.length, 0);
    assert.notEqual(channel.gateway.mcp.servers.find((server) => server.name === 'remote')?.state, 'connected');
  } finally {
    await mcp.close();
    await channel.close();
  }
});

test('a pasted app callback completes the login, a replay is refused and nothing is stored', { timeout: 90_000 }, async () => {
  const mcp = await startOAuthMcp();
  const channel = await openLoginChannel('callback', { mcp });
  let device;
  try {
    const cookie = await channel.pair('phone');
    device = await helloDevice(channel.base, cookie);
    channel.gate.script([loginCall('login-1'), final('login started')]);
    device.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'log in to the remote server' });
    await device.wait(() => device.events('login').length === 1, 'the login frame');
    const login = device.events('login')[0];
    const url = login.url;
    assert.equal(login.thread, 'main');
    assert.equal(login.server, 'remote');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/u);
    assert.ok(Number.isFinite(Date.parse(login.expiresAt)));

    // The URL is live-only: no durable event or channel state carries it or its state value.
    const state = JSON.stringify(await appState(channel.gateway));
    assert.equal(state.includes(url), false, 'the authorization URL is not channel state');
    assert.equal(state.includes('state='), false, 'no authorization state is stored');
    const chat = await channel.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
    const entries = await transcript(chat);
    assert.equal(entries.includes(url), false, 'the authorization URL is not a transcript entry');
    assert.equal(entries.includes('state='), false);
    assert.equal(channel.captured.at(-1)?.messages.some((message) => JSON.stringify(message).includes(url)) ?? false,
      false, 'the model never sees the authorization URL');

    const callback = await callbackFromAuthorization(url);

    // A callback in another thread is refused before it reaches the login.
    device.send({ type: 'req', id: 't1', op: 'thread.create', key: 'tc1', title: 'Side' });
    await device.wait(() => device.response('t1') !== undefined, 'thread.create reply');
    const side = device.response('t1').thread;
    assert.ok(side);
    device.send({ type: 'req', id: 'x1', op: 'send', key: 'cross', thread: side, text: callback });
    await device.wait(() => device.response('x1') !== undefined, 'cross-thread callback reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:cross#')), 'cross-thread refusal');
    const cross = device.events('message').find((event) => event.id.startsWith('notice:callback:cross#'));
    assert.match(cross.text, /did not match the active login/u);

    // A valid callback completes the attempt and answers with the lifecycle's fixed notice.
    device.send({ type: 'req', id: 'c1', op: 'send', key: 'valid', text: callback });
    await device.wait(() => device.response('c1') !== undefined, 'callback reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:valid#')), 'accepted notice');
    const accepted = device.events('message').find((event) => event.id.startsWith('notice:callback:valid#'));
    assert.match(accepted.text, /Authorization callback received/u);
    assert.equal(accepted.text.includes('code='), false);
    assert.equal(accepted.text.includes('state='), false);

    // The same send key is idempotent and submits nothing a second time.
    device.send({ type: 'req', id: 'c2', op: 'send', key: 'valid', text: callback });
    await device.wait(() => device.response('c2') !== undefined, 'duplicate callback reply');
    assert.equal(device.response('c2').duplicate, true);

    await untilAsync(() => channel.gateway.mcp.servers.find((server) => server.name === 'remote')?.state === 'connected',
      'the logged-in connection');
    await until(() => device.events('message').some((event) =>
      event.role === 'notice' && /MCP login for "remote" completed/u.test(event.text)), 'the completion notice');
    const completion = device.events('message').find((event) => /MCP login for "remote" completed/u.test(event.text));
    assert.match(completion.text, /1 tool\(s\)/u);
    assert.equal(completion.text.includes('code='), false);

    // Nothing stored the callback's code or state, then or now.
    const after = JSON.stringify(await appState(channel.gateway));
    assert.equal(after.includes('code='), false);
    assert.equal(after.includes('state='), false);
    assert.equal(after.includes(callback), false);
    const afterEntries = await transcript(chat);
    assert.equal(afterEntries.includes(callback), false);

    // A callback arriving after the attempt is gone gets the fixed stale text.
    device.send({ type: 'req', id: 'stale1', op: 'send', key: 'stale', text: callback });
    await device.wait(() => device.response('stale1') !== undefined, 'stale callback reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:stale#')), 'stale notice');
    const stale = device.events('message').find((event) => event.id.startsWith('notice:callback:stale#'));
    assert.match(stale.text, /No MCP login is waiting for a callback in this chat/u);
  } finally {
    await device?.close();
    await mcp.close();
    await channel.close();
  }
});

test('a foreign or replayed app callback is refused without storing it', { timeout: 90_000 }, async () => {
  const mcp = await startOAuthMcp();
  const channel = await openLoginChannel('refuse', { mcp });
  let device;
  try {
    const cookie = await channel.pair('phone');
    device = await helloDevice(channel.base, cookie);
    channel.gate.script([loginCall('login-1'), final('login started')]);
    device.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'log in to the remote server' });
    await device.wait(() => device.events('login').length === 1, 'the login frame');
    const callback = await callbackFromAuthorization(device.events('login')[0].url);

    const foreign = new URL(callback);
    foreign.searchParams.set('state', 'foreign-state-value');
    device.send({ type: 'req', id: 'f1', op: 'send', key: 'foreign', text: foreign.href });
    await device.wait(() => device.response('f1') !== undefined, 'foreign callback reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:foreign#')), 'foreign refusal');
    assert.match(device.events('message').find((event) => event.id.startsWith('notice:callback:foreign#')).text,
      /did not match the active login/u);

    device.send({ type: 'req', id: 'a1', op: 'send', key: 'good', text: callback });
    await device.wait(() => device.response('a1') !== undefined, 'valid callback reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:good#')), 'accepted notice');
    // The attempt is claimed; a second, differently-keyed paste of the same callback is a replay.
    device.send({ type: 'req', id: 'a2', op: 'send', key: 'replay', text: callback });
    await device.wait(() => device.response('a2') !== undefined, 'replay reply');
    await until(() => device.events('message').some((event) => event.id.startsWith('notice:callback:replay#')), 'replay refusal');
    assert.match(device.events('message').find((event) => event.id.startsWith('notice:callback:replay#')).text,
      /did not match the active login/u);

    const state = JSON.stringify(await appState(channel.gateway));
    assert.equal(state.includes('foreign-state-value'), false);
    assert.equal(state.includes(callback), false);
  } finally {
    await device?.close();
    await mcp.close();
    await channel.close();
  }
});

test('/mcp on the app lists the configured servers read-only, like Telegram and Discord', { timeout: 60_000 }, async () => {
  const mcp = await startOAuthMcp();
  const channel = await openLoginChannel('mcp-command', { mcp });
  let device;
  try {
    device = await helloDevice(channel.base, await channel.pair('phone'));
    assert.ok(device.response('h1').commands.some((command) => command.name === 'mcp'), 'hello offers /mcp');
    const notices = () => device.events('message').filter((event) => event.role === 'notice').map((event) => event.text);
    const control = async (id, fields) => {
      const before = notices().length;
      device.send({ type: 'req', id, op: 'control', ...fields });
      await device.wait(() => device.response(id) !== undefined && notices().length > before, `${id} notice`);
      assert.equal(device.response(id).ok, true);
      return notices().at(-1);
    };

    const listing = await control('m1', { command: 'mcp' });
    assert.match(listing, /^MCP servers in this gateway's live configuration: 1$/mu);
    assert.match(listing, /^- remote \(.*oauth\): /mu);
    assert.match(listing, /OAuth logins waiting for a callback: none\./u);
    assert.match(await control('m2', { command: 'mcp', args: 'login' }), /^Usage: \/mcp \(no arguments\)\. Nothing was sent/u);
    assert.match(await control('m3', { command: 'help', args: 'mcp' }), /^Usage: \/mcp\n/u);
    // Only an absent `args` means none: `null` or any other non-string is malformed, with no effect.
    for (const [id, args] of [['m4', null], ['m5', 7], ['m6', ['x']]]) {
      device.send({ type: 'req', id, op: 'control', command: 'mcp', args });
      await device.wait(() => device.response(id) !== undefined, `${id} reply`);
      assert.deepEqual(device.response(id), { type: 'res', id, ok: false, error: 'bad_request' });
    }
    // Read-only: no turn ran and nothing was admitted to the model.
    assert.equal(channel.captured.length, 0);
    assert.equal((await appState(channel.gateway)).controls.length, 0);
  } finally {
    await device?.close();
    await mcp.close();
    await channel.close();
  }
});
