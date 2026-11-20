// Shortcut credentials and `POST /v1/ask` for the app channel: console add/list/revoke, a token
// that is not a device, one admitted owner message per ask with the same idempotency as `send`,
// the bounded wait for the durable `settled`, fixed errors, the per-token rate window and the
// archived-thread refusal.
//
// Real Gateway over a temporary store, faux provider, one loopback listener on an ephemeral port
// and a synthetic WebSocket client speaking protocol v2. The adapter clock is controlled, every
// wait is event-driven, and every handle is closed by the test that opened it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APP_LIMITS,
  appState,
  deviceClient,
  openAppStore,
  postPair,
  startApp,
  until,
  userTexts,
} from './fixtures/app-harness.mjs';

async function withChannel(label, body, options = {}) {
  const store = await openAppStore(label, options);
  const app = startApp(store, options.adapter ?? {});
  const port = await app.port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await body({ store, app, base });
  } finally {
    await app.stop();
    await store.close();
  }
}

/** One paired device: a console-created code, redeemed over real HTTP, with its cookie. */
async function pairedDevice(store, base, label = 'phone') {
  const created = await store.gateway.appConsole.console().pair(label);
  assert.equal('refused' in created, false, `pairing was refused: ${JSON.stringify(created)}`);
  const exchange = await postPair(base, created.code, label);
  assert.equal(exchange.status, 204, 'pairing exchange failed');
  return exchange.cookie.split(';')[0];
}

/** One console-created shortcut token; only the add call ever sees the plaintext. */
async function shortcutToken(store, label = 'shortcut') {
  const created = await store.gateway.appConsole.console().shortcutAdd(label);
  assert.equal('refused' in created, false, `shortcut creation was refused: ${JSON.stringify(created)}`);
  return created.token;
}

/** `POST /v1/ask` over real loopback HTTP; status and parsed JSON only. */
async function postAsk(base, token, body) {
  const headers = body === undefined || body === null
    ? { 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };
  const response = await fetch(`${base}/v1/ask`, {
    method: 'POST',
    headers: token === undefined ? headers : { ...headers, authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function connectedDevice(base, cookie) {
  const device = deviceClient(base, cookie);
  await device.open();
  device.send({ type: 'req', id: 'h1', op: 'hello', v: 2, cursor: null });
  await device.wait(() => device.response('h1') !== undefined, 'hello reply');
  return device;
}

test('shortcut tokens are created once, listed by label, hashed and revoked immediately', { timeout: 20_000 }, async () => {
  await withChannel('shortcut-console', async ({ store, app }) => {
    const console = store.gateway.appConsole.console();
    const first = await console.shortcutAdd('morning');
    assert.equal('refused' in first, false);
    assert.equal(first.label, 'morning');
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u, '32 random bytes, base64url');
    assert.ok(first.createdAtMs >= app.clock.now - 1_000);

    // Only a label and a hash reach the durable state; the token itself exists nowhere else.
    let state = await appState(store.gateway);
    assert.equal(state.shortcuts.length, 1);
    assert.equal(state.shortcuts[0].label, 'morning');
    assert.match(state.shortcuts[0].tokenHash, /^[0-9a-f]{64}$/u);
    assert.equal(state.shortcuts[0].revokedAtMs, undefined);
    assert.equal(JSON.stringify(state).includes(first.token), false, 'the token is never stored');

    assert.deepEqual(await console.shortcutAdd('morning'), { refused: 'label-in-use' });
    assert.deepEqual(await console.shortcutAdd('bad\nlabel'), { refused: 'invalid-label' });
    assert.deepEqual(await console.shortcutAdd('x'.repeat(41)), { refused: 'invalid-label' });

    // Labels are bounded like device labels: eight active tokens at most, then a fixed refusal.
    for (let index = 0; index < 7; index += 1) {
      assert.equal('refused' in await console.shortcutAdd(`extra-${index}`), false);
    }
    assert.deepEqual(await console.shortcutAdd('one-too-many'), { refused: 'shortcut-limit' });

    const listed = await console.shortcuts();
    assert.equal(listed.length, 8);
    assert.deepEqual(listed.map((entry) => entry.label).sort(),
      ['extra-0', 'extra-1', 'extra-2', 'extra-3', 'extra-4', 'extra-5', 'extra-6', 'morning']);
    assert.equal(listed.every((entry) => entry.revokedAtMs === undefined), true);

    assert.equal(await console.shortcutRevoke('no-such-shortcut'), 'missing');
    assert.equal(await console.shortcutRevoke('morning'), 'revoked');
    assert.equal(await console.shortcutRevoke('morning'), 'missing');
    state = await appState(store.gateway);
    assert.equal(typeof state.shortcuts.find((entry) => entry.label === 'morning').revokedAtMs, 'number');
    const revoked = (await console.shortcuts()).find((entry) => entry.label === 'morning');
    assert.equal(typeof revoked.revokedAtMs, 'number');
    // A revoked label is free again, exactly like a device label.
    assert.equal('refused' in await console.shortcutAdd('morning'), false);
  });
});

test('an ask answers with the final text and is visible to a connected device', { timeout: 25_000 }, async () => {
  await withChannel('shortcut-answer', async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = await connectedDevice(base, cookie);
    const token = await shortcutToken(store, 'daily');
    store.setAnswer('SHORTCUT-ANSWER');

    const ask = await postAsk(base, token, { text: 'shortcut hello', key: 'sc-1' });
    assert.equal(ask.status, 200);
    assert.deepEqual(ask.body, { outcome: 'answered', text: 'SHORTCUT-ANSWER' });

    // The echo and the answer are the same durable events a device `send` produces.
    await device.wait(() => device.events('settled').some((event) => event.key === 'sc-1'), 'settled');
    const echo = device.events('message').find((event) => event.role === 'user' && event.key === 'sc-1');
    assert.equal(echo.text, 'shortcut hello');
    const answer = device.events('message').find((event) => event.role === 'assistant' && event.key === 'sc-1');
    assert.equal(answer.text, 'SHORTCUT-ANSWER');
    assert.deepEqual(
      device.events('settled').filter((event) => event.key === 'sc-1').map((event) => event.outcome),
      ['answered'],
    );

    // The same key is the same message: a duplicate admits nothing and reports the same answer.
    const duplicate = await postAsk(base, token, { text: 'shortcut hello', key: 'sc-1' });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, { outcome: 'answered', text: 'SHORTCUT-ANSWER' });
    assert.equal(userTexts(store.captured).filter((text) => text.includes('shortcut hello')).length, 1,
      'a repeated key admits no second turn');

    // A fresh request without a key gets one and admits its own turn.
    const generated = await postAsk(base, token, { text: 'another shortcut question' });
    assert.equal(generated.status, 200);
    assert.deepEqual(generated.body, { outcome: 'answered', text: 'SHORTCUT-ANSWER' });
    await device.close();
  });
});

test('a slow turn answers 202 pending and the answer still arrives on the stream', { timeout: 25_000 }, async () => {
  await withChannel('shortcut-pending', async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = await connectedDevice(base, cookie);
    const token = await shortcutToken(store);

    const entered = store.gate.hold();
    const request = postAsk(base, token, { text: 'slow shortcut question', key: 'sc-slow' });
    await entered;
    const pending = await request;
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.body, { outcome: 'pending', key: 'sc-slow' });

    // Admission already happened, so the device sees the echo while the turn runs.
    await device.wait(() => device.events('message').some((event) => event.key === 'sc-slow'), 'echo');
    store.gate.release();
    await device.wait(() => device.events('settled').some((event) => event.key === 'sc-slow'), 'settled');
    const answer = device.events('message').find((event) => event.role === 'assistant' && event.key === 'sc-slow');
    assert.equal(answer.text, 'SYNTHETIC-REPLY');
    assert.deepEqual(
      device.events('settled').find((event) => event.key === 'sc-slow').outcome,
      'answered',
    );
    await device.close();
  }, { adapter: { askWaitMs: 100 } });
});

test('a shortcut token never authenticates a device, an upload or a file', { timeout: 20_000 }, async () => {
  await withChannel('shortcut-not-device', async ({ store, base }) => {
    const token = await shortcutToken(store, 'automation');
    const cookie = `durable_device=${token}`;

    // Not a stream: the upgrade completes, then the unknown cookie closes 4401.
    const stream = deviceClient(base, cookie);
    await until(() => stream.closed.code !== undefined, 'shortcut token stream close');
    assert.equal(stream.closed.code, 4401);
    await stream.close();

    const upload = await fetch(`${base}/v1/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'x-filename': 'note.txt' },
      body: 'synthetic',
    });
    assert.equal(upload.status, 401);
    assert.deepEqual(await upload.json(), { error: 'unauthorized' });

    const file = await fetch(`${base}/v1/files/f_${'a'.repeat(22)}`, { headers: { cookie } });
    assert.equal(file.status, 401);
    assert.deepEqual(await file.json(), { error: 'unauthorized' });
  });
});

test('missing, unknown and revoked tokens are the same 401', { timeout: 20_000 }, async () => {
  await withChannel('shortcut-auth', async ({ store, base }) => {
    const missing = await postAsk(base, undefined, { text: 'hello' });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { error: 'unauthorized' });

    const unknown = await postAsk(base, 'not-a-shortcut-token', { text: 'hello' });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, { error: 'unauthorized' });
    // A well-formed device cookie is not a shortcut bearer token either.
    const cookie = await pairedDevice(store, base);
    assert.equal((await postAsk(base, cookie.split('=')[1], { text: 'hello' })).status, 401);

    const token = await shortcutToken(store);
    assert.equal((await postAsk(base, token, { text: 'hello' })).status, 200);
    assert.equal(await store.gateway.appConsole.console().shortcutRevoke('shortcut'), 'revoked');
    const revoked = await postAsk(base, token, { text: 'hello again' });
    assert.equal(revoked.status, 401);
    assert.deepEqual(revoked.body, { error: 'unauthorized' });
  });
});

test('the per-token rate limit is asksPerMinute and resets with the rolling window', { timeout: 40_000 }, async () => {
  await withChannel('shortcut-rate', async ({ store, app, base }) => {
    const token = await shortcutToken(store);
    for (let index = 0; index < APP_LIMITS.asksPerMinute; index += 1) {
      const answer = await postAsk(base, token, { text: `rate ask ${index}` });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.outcome, 'answered');
    }
    const limited = await postAsk(base, token, { text: 'one ask too many' });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: 'rate_limited' });

    // The window is rolling and in-memory: past one minute the same token asks again.
    app.clock.now += 60_000 + 1_000;
    const after = await postAsk(base, token, { text: 'after the window' });
    assert.equal(after.status, 200);
    assert.equal(after.body.outcome, 'answered');

    // Rate limits are per token: a second token has its own window.
    const other = await shortcutToken(store, 'other');
    assert.equal((await postAsk(base, other, { text: 'second token' })).status, 200);
  });
});

test('bad bodies, oversize text and archived threads are refused with fixed errors', { timeout: 30_000 }, async () => {
  await withChannel('shortcut-bounds', async ({ store, app, base }) => {
    const token = await shortcutToken(store);
    const cookie = await pairedDevice(store, base);
    const device = await connectedDevice(base, cookie);

    for (const body of [
      {},
      { text: '' },
      { text: 7 },
      { text: 'x', thread: 'not-a-thread' },
      { text: 'x', key: 'bad key' },
      { text: 'x', attachments: [] },
      [],
      'null',
    ]) {
      const response = await postAsk(base, token, body);
      assert.equal(response.status, 400, `body: ${JSON.stringify(body)}`);
      assert.deepEqual(response.body, { error: 'bad_request' });
    }
    const tooLong = await postAsk(base, token, { text: 'x'.repeat(APP_LIMITS.sendTextChars + 1) });
    assert.equal(tooLong.status, 413);
    assert.deepEqual(tooLong.body, { error: 'too_large' });
    const oversize = await postAsk(base, token, `{"text":"${'x'.repeat(300_000)}"}`);
    assert.equal(oversize.status, 413);
    assert.deepEqual(oversize.body, { error: 'too_large' });

    // An archived thread refuses admission exactly as a device `send` does.
    // (The refusals above already spent this token's minute; a fresh window keeps the point local.)
    app.clock.now += 60_000 + 1_000;
    device.send({ type: 'req', id: 'c1', op: 'thread.create', key: 'tc-1', title: 'Archive me' });
    await device.wait(() => device.response('c1') !== undefined, 'thread create reply');
    const thread = device.response('c1').thread;
    device.send({ type: 'req', id: 'a1', op: 'thread.archive', thread, archived: true });
    await device.wait(() => device.response('a1') !== undefined, 'thread archive reply');
    assert.equal(device.response('a1').ok, true);

    const archived = await postAsk(base, token, { text: 'into an archived thread', thread });
    assert.equal(archived.status, 400);
    assert.deepEqual(archived.body, { error: 'bad_request' });
    const unknown = await postAsk(base, token, { text: 'into nowhere', thread: 't_missing' });
    assert.equal(unknown.status, 400);
    await device.close();
  });
});

test('a failed turn answers 200 failed without an answer text', { timeout: 25_000 }, async () => {
  await withChannel('shortcut-failure', async ({ store, base }) => {
    const token = await shortcutToken(store);
    store.script([() => { throw new Error('synthetic provider failure'); }]);
    const failed = await postAsk(base, token, { text: 'this run will fail', key: 'sc-fail' });
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body, { outcome: 'failed' });
  });
});

test('an archived turn answers 200 aborted', { timeout: 30_000 }, async () => {
  await withChannel('shortcut-abort', async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = await connectedDevice(base, cookie);
    const token = await shortcutToken(store);
    store.setAnswer('ABORT-ME '.repeat(200));
    device.send({ type: 'req', id: 'c1', op: 'thread.create', key: 'tc-1', title: 'Abort me' });
    await device.wait(() => device.response('c1') !== undefined, 'thread create reply');
    const thread = device.response('c1').thread;

    // Archiving the thread mid-stream aborts its turn; the ask reports that settlement as aborted.
    const request = postAsk(base, token, { text: 'abort this ask', thread, key: 'sc-abort' });
    await until(() => userTexts(store.captured).some((text) => text.includes('abort this ask')),
      'the shortcut turn started');
    device.send({ type: 'req', id: 'a1', op: 'thread.archive', thread, archived: true });
    await device.wait(() => device.response('a1') !== undefined, 'thread archive reply');
    const aborted = await request;
    assert.equal(aborted.status, 200);
    assert.deepEqual(aborted.body, { outcome: 'aborted' });
    await device.close();
  }, { streamTokensPerSecond: 40, adapter: { askWaitMs: 5_000 } });
});

test('the app command parses shortcut add, list and revoke', async () => {
  const { parseAppInvocation, AppCommandError, AppUsageError } = await import(
    new URL('../dist/channels/app-operator-cli.js', import.meta.url).href
  );
  assert.deepEqual(parseAppInvocation(['shortcut', 'add', '--label', 'morning']).command,
    { kind: 'shortcut-add', label: 'morning' });
  assert.deepEqual(parseAppInvocation(['shortcut', 'list']).command, { kind: 'shortcut-list' });
  assert.deepEqual(parseAppInvocation(['shortcut', 'revoke', 'morning']).command,
    { kind: 'shortcut-revoke', label: 'morning' });
  assert.deepEqual(parseAppInvocation(['shortcut', 'list', '--config', '/tmp/config.json']),
    { command: { kind: 'shortcut-list' }, configPath: '/tmp/config.json' });
  for (const args of [
    ['shortcut'],
    ['shortcut', 'add'],
    ['shortcut', 'add', '--label'],
    ['shortcut', 'add', 'morning'],
    ['shortcut', 'list', 'extra'],
    ['shortcut', 'revoke'],
    ['shortcut', 'revoke', 'a', 'b'],
    ['shortcut', 'remove', 'morning'],
  ]) {
    assert.throws(() => parseAppInvocation(args), AppUsageError, `usage: ${JSON.stringify(args)}`);
  }
  assert.throws(() => parseAppInvocation(['shortcut', 'add', '--label', 'bad label']), AppCommandError);
});
