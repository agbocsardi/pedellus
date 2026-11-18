// App channel: pairing, authentication close codes, hello/replay/ack, idempotent send, a full
// turn (echo, preview, answer, settled), reconnect, controls, revocation, oversize frames,
// static path safety, callback interception and scheduled delivery.
//
// Real Gateway over a temporary store, faux provider, one real loopback listener on an ephemeral
// port and a synthetic WebSocket client (the `ws` package itself) speaking protocol v1. No
// tailnet, no live device, no paid inference. Every wait is event-driven; no test sleeps on a
// schedule, and every handle is cleaned up by the test that created it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APP_CHAT_SESSION_KEY,
  APP_LIMITS,
  WebSocket,
  appState,
  context,
  deviceClient,
  openAppStore,
  parseConfig,
  postPair,
  resolveStaticPath,
  seedEvents,
  startApp,
  staticMimeType,
  until,
  untilAsync,
  validateOptions,
} from './fixtures/app-harness.mjs';

const WORKSPACE_BASE = {
  workspace: '/tmp/synthetic-app-workspace',
  dataDir: '/tmp/synthetic-app-state',
  model: { provider: 'fixture', modelId: 'alpha' },
  allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
};

/** A channel with its store and adapter, plus the awaited bound port and its HTTP base. */
async function withChannel(label, options, body) {
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
  assert.match(exchange.cookie, /^durable_device=/u);
  return exchange.cookie.split(';')[0];
}

test('the app config block is opt-in, strict and loopback-only', { timeout: 10_000 }, () => {
  const parsed = parseConfig({
    ...WORKSPACE_BASE,
    app: { port: 43190, staticRoot: '/tmp/synthetic-pwa' },
  }, '/tmp/synthetic');
  assert.deepEqual(parsed.app, { port: 43190, staticRoot: '/tmp/synthetic-pwa' });
  // Absent stays absent: nothing about the app channel is configured or loaded.
  assert.equal(parseConfig({ ...WORKSPACE_BASE }, '/tmp/synthetic').app, undefined);

  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { port: 43190, staticRoot: '/p', host: '0.0.0.0' } }, '/tmp'),
    /not a recognized option/u, 'no other bind is configurable');
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { staticRoot: '/p' } }, '/tmp'), /app\.port/u);
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { port: 0, staticRoot: '/p' } }, '/tmp'), /app\.port/u);
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { port: 43190 } }, '/tmp'), /app\.staticRoot/u);
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { port: 43190, staticRoot: 'pwa' } }, '/tmp'), /absolute/u);
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { port: 70000, staticRoot: '/p' } }, '/tmp'), /app\.port/u);

  // The adapter itself may take an ephemeral port (offline checks); the config never may.
  assert.doesNotThrow(() => validateOptions({ port: 0, staticRoot: '/p' }));
  assert.throws(() => validateOptions({ port: 70000, staticRoot: '/p' }), /port/u);
  assert.throws(() => validateOptions({ port: 43190, staticRoot: 'pwa' }), /absolute/u);
});

test('static files are served with safe paths, correct types and no-store for sw.js', { timeout: 15_000 }, async () => {
  await withChannel('static', {}, async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await index.text(), /synthetic app/u);

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('cache-control'), 'no-store');
    assert.equal(sw.headers.get('content-type'), 'text/javascript; charset=utf-8');

    assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${base}/icons/icon.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);

    // Undici (like a browser) normalizes dot segments before sending, so traversal never reaches
    // the server through fetch; the unnormalized forms are refused by `resolveStaticPath` below.
    assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/icons/../app.js`)).status, 200);
    assert.equal((await fetch(`${base}//app.js`)).status, 400, 'an empty segment is refused');
    assert.equal((await fetch(`${base}/icons/`)).status, 400, 'directories are not listed');

    // The raw unnormalized forms a hostile client could write are refused before any fs call.
    assert.equal(resolveStaticPath('/../etc/passwd'), undefined);
    assert.equal(resolveStaticPath('/icons/../app.js'), undefined);
    assert.equal(resolveStaticPath('/%2e%2e/etc/passwd'), undefined);
    assert.equal(resolveStaticPath('//app.js'), undefined);
    assert.equal(resolveStaticPath('/a%2f..%2f..%2fetc'), undefined, 'an encoded separator is not structure');
    assert.deepEqual(resolveStaticPath('/'), { segments: [] });
    assert.deepEqual(resolveStaticPath('/icons/icon.png'), { segments: ['icons', 'icon.png'] });
    assert.equal(resolveStaticPath('/x?query=1').segments[0], 'x');
    assert.equal(staticMimeType('sw.js'), 'text/javascript; charset=utf-8');
    assert.equal(staticMimeType('unknown.bin'), 'application/octet-stream');

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/`, { method: 'PUT' })).status, 405);
  });
});

test('pairing creates one single-use code that redeems into a hashed device', { timeout: 15_000 }, async () => {
  await withChannel('pairing', {}, async ({ store, app, base }) => {
    const created = await store.gateway.appConsole.console().pair('phone');
    assert.equal('refused' in created, false);
    assert.match(created.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u);
    assert.ok(created.expiresAtMs > app.clock.now);

    // Input is case-insensitive; the cookie carries exactly the protocol's attributes.
    const exchange = await postPair(base, created.code.toLowerCase(), 'phone');
    assert.equal(exchange.status, 204);
    assert.match(exchange.cookie, /HttpOnly; Secure; SameSite=Strict; Path=\/v1$/u);

    const devices = await store.gateway.appConsole.console().devices();
    assert.deepEqual(devices.map((device) => device.label), ['phone']);
    // The token exists only in the cookie: the durable record holds its hash.
    const state = await appState(store.gateway);
    assert.equal(state.devices.length, 1);
    assert.match(state.devices[0].tokenHash, /^[0-9a-f]{64}$/u);
    assert.equal(state.devices[0].tokenHash.includes(exchange.cookie.split('=')[1]), false);

    // Single use: the same code never redeems again.
    assert.equal((await postPair(base, created.code, 'phone')).status, 401);
    // A labelled code answers only to its own label.
    const labelled = await store.gateway.appConsole.console().pair('tablet');
    assert.equal((await postPair(base, labelled.code, 'other')).status, 401);
    assert.equal((await postPair(base, labelled.code, 'tablet')).status, 204);
  });
});

test('malformed bodies and bad codes are refused with fixed errors', { timeout: 15_000 }, async () => {
  await withChannel('bad-codes', {}, async ({ base }) => {
    const malformed = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"code": ',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'bad_request' });

    assert.equal((await postPair(base, 'ABCD234', 'phone')).status, 400);
    assert.equal((await postPair(base, 'ABCD23I5', 'phone')).status, 400, 'the alphabet excludes I');
    assert.equal((await postPair(base, 'ABCD23O5', 'phone')).status, 400, 'the alphabet excludes O');
    assert.equal((await postPair(base, 'ABCD2345', 'not a label')).status, 400);
    assert.equal((await postPair(base, 'ABCD2345', 'phone')).status, 401);
    const invalid = await postPair(base, 'ABCD2345', 'phone');
    assert.deepEqual(invalid.body, { error: 'invalid_code' });

    const oversized = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"code":"${'x'.repeat(300_000)}"}`,
    });
    assert.equal(oversized.status, 400);
  });
});

test('an expired code is refused and five failures rate-limit the next minute', { timeout: 15_000 }, async () => {
  await withChannel('expiry-rate', {}, async ({ store, app, base }) => {
    const created = await store.gateway.appConsole.console().pair('phone');
    app.clock.now += APP_LIMITS.pairTtlMs + 1_000;
    assert.equal((await postPair(base, created.code, 'phone')).status, 401, 'an expired code must not redeem');

    const fresh = await store.gateway.appConsole.console().pair('tablet');
    for (let attempt = 0; attempt < APP_LIMITS.pairRateMax; attempt += 1) {
      assert.equal((await postPair(base, 'ZZZZ9999', `bad${attempt}`)).status, 401);
    }
    // More than five failures inside one minute: the next attempt is refused without consuming.
    const limited = await postPair(base, fresh.code, 'tablet');
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: 'rate_limited' });
    // The window is rolling: once it passes, the same still-unused code redeems.
    app.clock.now += APP_LIMITS.pairRateWindowMs + 1_000;
    assert.equal((await postPair(base, fresh.code, 'tablet')).status, 204);
    assert.equal((await store.gateway.appConsole.console().devices()).length, 1);
  });
});

test('unauthenticated and revoked streams complete the upgrade then close 4401', { timeout: 15_000 }, async () => {
  await withChannel('auth-codes', {}, async ({ store, base }) => {
    const anonymous = deviceClient(base, undefined);
    await until(() => anonymous.closed.code !== undefined, 'unpaired close');
    assert.equal(anonymous.closed.code, 4401);
    await anonymous.close();

    const forged = deviceClient(base, 'durable_device=forged-token');
    await until(() => forged.closed.code !== undefined, 'unknown token close');
    assert.equal(forged.closed.code, 4401);
    await forged.close();

    const cookie = await pairedDevice(store, base, 'phone');
    const live = deviceClient(base, cookie);
    await live.open();
    live.send({ type: 'req', id: 'r1', op: 'hello', v: 1, cursor: null });
    await live.wait(() => live.response('r1') !== undefined, 'hello reply');

    // The same device opening a newer stream replaces the old one.
    const newer = deviceClient(base, cookie);
    await newer.open();
    await until(() => live.closed.code !== undefined, 'the older stream is replaced');
    assert.equal(live.closed.code, 4409);
    newer.send({ type: 'req', id: 'r1', op: 'hello', v: 1, cursor: null });
    await newer.wait(() => newer.response('r1') !== undefined, 'the newer stream answers');

    assert.equal(await store.gateway.appConsole.console().revoke('phone'), 'revoked');
    assert.equal(await store.gateway.appConsole.console().revoke('phone'), 'missing');
    const revoked = deviceClient(base, cookie);
    await until(() => revoked.closed.code !== undefined, 'revoked token close');
    assert.equal(revoked.closed.code, 4401);
    await revoked.close();
  });
});

test('hello replays the durable log in bounded batches, answers later hellos and trims on ack', { timeout: 20_000 }, async () => {
  // Seed the log before the adapter starts, exactly as an earlier session of this channel would
  // have left it; the adapter then serves it from its own recovery snapshot.
  const store = await openAppStore('replay', {});
  await seedEvents(store.gateway, 600);
  const app = startApp(store);
  const base = `http://127.0.0.1:${await app.port}`;
  try {
    const cookie = await pairedDevice(store, base, 'phone');
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.events('message').length >= APP_LIMITS.replayBatch, 'first replay batch');
    const hello = device.response('h1');
    assert.equal(hello.ok, true);
    assert.equal(hello.v, 1);
    assert.equal(hello.device, 'phone');
    assert.equal(hello.head, 600);
    assert.equal(device.events('message').length, APP_LIMITS.replayBatch, 'replay is bounded at 500');
    assert.equal(device.events('message')[0].cursor, 1, 'replay is oldest first');
    assert.equal(device.events('message')[0].text, 'seeded event 1');

    // A later hello on the same open stream is answered normally and replays the next batch.
    device.send({ type: 'req', id: 'h2', op: 'hello', v: 1, cursor: 500 });
    await device.wait(() => device.response('h2') !== undefined && device.events('message').length >= 600,
      'the continued batch');
    assert.equal(device.response('h2').ok, true);
    assert.equal(device.events('message').length, 600);
    assert.equal(device.events('message').at(-1).cursor, 600);

    // The acknowledged prefix is trimmed durably; a replay from below the floor repeats nothing.
    device.send({ type: 'req', id: 'a1', op: 'ack', cursor: 600 });
    await device.wait(() => device.response('a1') !== undefined, 'ack reply');
    const state = await appState(store.gateway);
    const deviceId = Object.keys(state.acks)[0];
    assert.equal(state.acks[deviceId], 600);
    assert.equal(state.events.length, 0, 'acked events were trimmed');
    device.send({ type: 'req', id: 'h3', op: 'hello', v: 1, cursor: 1 });
    await device.wait(() => device.response('h3') !== undefined, 'post-ack hello');
    assert.equal(device.events('message').length, 600, 'the trimmed prefix did not replay again');
    await device.close();
  } finally {
    await app.stop();
    await store.close();
  }
});

test('send is idempotent by key: one echo, one turn, one settlement', { timeout: 20_000 }, async () => {
  await withChannel('idempotent', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.response('h1') !== undefined, 'hello reply');

    device.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'hello there' });
    await device.wait(() => device.response('s1') !== undefined, 'first send reply');
    assert.deepEqual(device.response('s1').duplicate, false);
    device.send({ type: 'req', id: 's2', op: 'send', key: 'k1', text: 'hello there' });
    await device.wait(() => device.response('s2') !== undefined, 'duplicate send reply');
    assert.deepEqual(device.response('s2').duplicate, true, 'a repeated key admits nothing');

    await device.wait(() => device.events('settled').length === 1, 'the one turn settled');
    assert.equal(store.captured.length, 1, 'a duplicate key became a second turn');
    const users = device.events('message').filter((event) => event.role === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].key, 'k1');
    const settled = device.events('settled')[0];
    assert.deepEqual({ key: settled.key, outcome: settled.outcome }, { key: 'k1', outcome: 'answered' });
    assert.match(store.captured[0].messages.at(-1).content, /hello there/u);

    // A malformed send is a fixed reply, never a turn.
    device.send({ type: 'req', id: 's3', op: 'send', key: 'k2', text: '' });
    await device.wait(() => device.response('s3') !== undefined, 'empty send reply');
    assert.equal(device.response('s3').error, 'bad_request');
    device.send({ type: 'req', id: 's4', op: 'send', key: 'bad key!', text: 'x' });
    await device.wait(() => device.response('s4') !== undefined, 'bad key reply');
    assert.equal(device.response('s4').error, 'bad_request');
    await device.close();
  });
});

test('a full turn echoes, previews, answers and settles in protocol order', { timeout: 30_000 }, async () => {
  await withChannel('full-turn', { streamTokensPerSecond: 40 }, async ({ store, base }) => {
    store.setAnswer(Array.from({ length: 40 }, (_, index) => `answer line ${index}`).join(' '));
    const cookie = await pairedDevice(store, base);
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.response('h1') !== undefined, 'hello reply');

    device.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'stream me an answer' });
    await device.wait(() => device.response('s1') !== undefined, 'send admitted');
    // The answer streams slowly, so at least one preview and one thinking status must appear.
    await device.wait(() => device.events('preview').length > 0 && device.events('settled').length === 1,
      'preview and settlement');

    const order = device.frames.filter((frame) => frame.type === 'event').map((frame) => frame.event);
    assert.equal(order[0], 'message', 'the admission echo comes first');
    assert.ok(order.includes('preview'), 'a preview arrived while the turn ran');
    assert.ok(device.events('preview').every((event) => event.key === 'k1'));
    assert.ok(device.events('status').some((event) => event.state === 'thinking'),
      'generation was reported as thinking');

    const answered = device.events('message').find((event) => event.role === 'assistant');
    assert.ok(answered !== undefined);
    assert.equal(answered.key, 'k1');
    assert.match(answered.text, /answer line 39/u);
    const settled = device.events('settled')[0];
    assert.deepEqual({ key: settled.key, outcome: settled.outcome }, { key: 'k1', outcome: 'answered' });
    const state = await appState(store.gateway);
    assert.equal(state.pending.length, 0, 'the settled turn left no pending record');
    await device.close();
  });
});

test('a reconnect replays exactly what was missed', { timeout: 30_000 }, async () => {
  await withChannel('reconnect', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const first = deviceClient(base, cookie);
    await first.open();
    first.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await first.wait(() => first.response('h1') !== undefined, 'hello reply');
    // Hold the provider call so the socket dies while the turn is genuinely running.
    const entered = store.gate.hold();
    first.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: 'answer while I am away' });
    await entered;
    await first.wait(() => first.events('message').some((event) => event.role === 'user'), 'the echo is durable');
    const echo = first.events('message').find((event) => event.role === 'user');
    await first.close();

    store.gate.release();
    await untilAsync(async () => (await appState(store.gateway)).pending.length === 0, 'the turn settled');

    const second = deviceClient(base, cookie);
    await second.open();
    second.send({ type: 'req', id: 'h2', op: 'hello', v: 1, cursor: echo.cursor });
    await second.wait(() => second.events('settled').length === 1, 'the missed events replayed');
    assert.equal(second.events('message').length, 1, 'only events after the cursor replayed');
    assert.equal(second.events('message')[0].role, 'assistant');
    assert.equal(second.events('settled')[0].key, 'k1');
    // The durable log is the source of truth: the reconnect duplicated nothing.
    const state = await appState(store.gateway);
    assert.equal(state.events.filter((event) => event.event === 'message' && event.role === 'assistant').length, 1);
    await second.close();
  });
});

test('controls map to the owner operations and reply with fixed results', { timeout: 30_000 }, async () => {
  await withChannel('controls', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.response('h1') !== undefined, 'hello reply');

    device.send({ type: 'req', id: 'c1', op: 'control', command: 'status' });
    await device.wait(() => device.response('c1') !== undefined, 'status control reply');
    await device.wait(() => device.events('message').some((event) =>
      event.role === 'notice' && /Status for this chat/u.test(event.text)), 'status notice');
    const statusNotice = device.events('message').find((event) => event.role === 'notice');
    assert.match(statusNotice.text, /Model: fixture\/alpha/u);

    device.send({ type: 'req', id: 'c2', op: 'control', command: 'new' });
    await device.wait(() => device.response('c2') !== undefined, 'new control reply');
    await device.wait(() => device.events('divider').length === 1, 'the new context boundary');
    await device.wait(() => device.events('message').some((event) =>
      event.role === 'notice' && event.text === 'Context reset.'), 'the applied acknowledgement');

    device.send({ type: 'req', id: 'c3', op: 'control', command: 'abort' });
    await device.wait(() => device.events('message').some((event) =>
      event.role === 'notice' && event.text === 'Idle. Queue cleared.'), 'abort acknowledgement on an idle chat');

    // A replayed command id reports its recorded outcome instead of running twice.
    device.send({ type: 'req', id: 'c2', op: 'control', command: 'new' });
    await device.wait(() => {
      const notices = device.events('message').filter((event) => event.role === 'notice');
      return /already applied/u.test(notices.at(-1)?.text ?? '');
    }, 'the replay reports');
    assert.equal(device.events('divider').length, 1, 'no second boundary was recorded');

    device.send({ type: 'req', id: 'c4', op: 'control', command: 'model' });
    await device.wait(() => device.response('c4') !== undefined, 'later command reply');
    assert.equal(device.response('c4').error, 'unsupported');
    device.send({ type: 'req', id: 'c5', op: 'control', command: 'nonsense' });
    await device.wait(() => device.response('c5') !== undefined, 'unknown command reply');
    assert.equal(device.response('c5').error, 'bad_request');
    await device.close();
  });
});

test('a non-hello first request is a protocol violation and closes 4400', { timeout: 15_000 }, async () => {
  await withChannel('violations', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'r1', op: 'ping' });
    await device.wait(() => device.closed.code !== undefined, 'non-hello first close');
    assert.equal(device.closed.code, 4400);
    await device.close();
  });
});

test('early sends, bad json, wrong versions and oversize frames close with fixed codes', { timeout: 20_000 }, async () => {
  await withChannel('frames', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);

    const early = deviceClient(base, cookie);
    await early.open();
    early.send({ type: 'req', id: 'r1', op: 'send', key: 'k', text: 'too early' });
    await early.wait(() => early.closed.code !== undefined, 'send before hello close');
    assert.equal(early.closed.code, 4400);
    await early.close();

    const wrongVersion = deviceClient(base, cookie);
    await wrongVersion.open();
    wrongVersion.send({ type: 'req', id: 'r1', op: 'hello', v: 2, cursor: null });
    await wrongVersion.wait(() => wrongVersion.closed.code !== undefined, 'wrong version close');
    assert.equal(wrongVersion.closed.code, 4426);
    await wrongVersion.close();

    const badJson = deviceClient(base, cookie);
    await badJson.open();
    badJson.send('{not json');
    await badJson.wait(() => badJson.closed.code !== undefined, 'bad json close');
    assert.equal(badJson.closed.code, 4400);
    await badJson.close();

    const oversize = deviceClient(base, cookie);
    await oversize.open();
    oversize.send({ type: 'req', id: 'r1', op: 'hello', v: 1, cursor: null });
    await oversize.wait(() => oversize.response('r1') !== undefined, 'hello reply');
    oversize.send(JSON.stringify({ type: 'req', id: 'r2', op: 'send', key: 'big', text: 'x'.repeat(300_000) }));
    await oversize.wait(() => oversize.closed.code !== undefined, 'oversize frame close');
    assert.equal(oversize.closed.code, 4400);
    await oversize.close();
  });
});

test('the console refuses duplicate labels, lists devices and revokes exactly by label', { timeout: 15_000 }, async () => {
  await withChannel('console', {}, async ({ store, app }) => {
    const console = store.gateway.appConsole.console();
    const first = await console.pair('phone');
    assert.equal('refused' in first, false);
    const reused = await console.pair('phone');
    assert.deepEqual(reused, { refused: 'label-in-use' });

    const unnamed = await console.pair();
    assert.equal('refused' in unnamed, false, 'an omitted label picks a free default');
    const base = `http://127.0.0.1:${await app.port}`;
    assert.equal((await postPair(base, unnamed.code, 'device-1')).status, 204);

    const devices = await console.devices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].label, 'device-1');
    assert.equal(await console.revoke('no-such-device'), 'missing');
    assert.equal(await console.revoke('device-1'), 'revoked');
    assert.deepEqual((await console.devices()).map((device) => device.revokedAtMs === undefined ? 'active' : 'revoked'),
      ['revoked']);
  });
});

test('a callback-shaped send is consumed before admission and never stored', { timeout: 20_000 }, async () => {
  await withChannel('callback', {}, async ({ store, base }) => {
    const cookie = await pairedDevice(store, base);
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.response('h1') !== undefined, 'hello reply');
    const callback = 'https://example.mcp/redirect?state=abc&code=secret-code';
    device.send({ type: 'req', id: 's1', op: 'send', key: 'k1', text: callback });
    await device.wait(() => device.response('s1') !== undefined, 'callback send reply');
    assert.equal(device.response('s1').ok, true);
    await device.wait(() => device.events('message').some((event) => event.role === 'notice'), 'the refusal notice');
    assert.equal(device.events('message').filter((event) => event.role === 'user').length, 0,
      'the callback never reached the model');
    const state = await appState(store.gateway);
    assert.equal(JSON.stringify(state).includes('secret-code'), false, 'the callback text is never stored');
    assert.equal(store.captured.length, 0);
    await device.close();
  });
});

test('scheduled results are delivered through the channel-neutral outbox as cursor events', { timeout: 20_000 }, async () => {
  // The outbox record and this channel's admission evidence are seeded before the adapter starts,
  // as an earlier session would have left them; the startup scan then delivers without a tick.
  const store = await openAppStore('scheduled', {});
  const { CronDeliveriesDoc } = await import(new URL('../dist/automation/cron-delivery.js', import.meta.url).href);
  const { AppState } = await import(new URL('../dist/channels/app.js', import.meta.url).href);
  const stateConversation = await store.gateway.conversationFor('app:channel-state', context);
  await stateConversation.commit(async (tx) => {
    const doc = await tx.doc(AppState, stateConversation.id);
    doc.origin = { admittedAtMs: 1 };
  }, context);
  const conversation = await store.gateway.conversationFor(APP_CHAT_SESSION_KEY, context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(CronDeliveriesDoc, conversation.id);
    doc.deliveries.push({
      id: 'cron:1:1000',
      sessionKey: APP_CHAT_SESSION_KEY,
      text: 'SCHEDULED-REMINDER',
      createdAtMs: Date.now(),
      status: 'pending',
      nextChunkIndex: 0,
    });
  }, context);
  const app = startApp(store);
  const base = `http://127.0.0.1:${await app.port}`;
  try {
    const cookie = await (async () => {
      const created = await store.gateway.appConsole.console().pair('phone');
      const exchange = await postPair(base, created.code, 'phone');
      assert.equal(exchange.status, 204);
      return exchange.cookie.split(';')[0];
    })();
    const device = deviceClient(base, cookie);
    await device.open();
    device.send({ type: 'req', id: 'h1', op: 'hello', v: 1, cursor: null });
    await device.wait(() => device.response('h1') !== undefined, 'hello reply');
    await device.wait(() => device.events('message').some((event) => event.text === 'SCHEDULED-REMINDER'),
      'the scheduled result arrived');
    const scheduled = device.events('message').find((event) => event.text === 'SCHEDULED-REMINDER');
    assert.equal(scheduled.role, 'assistant');
    assert.ok(scheduled.cursor > 0);
    const records = await conversation.commit(async (tx) => {
      const doc = await tx.doc(CronDeliveriesDoc, conversation.id);
      return JSON.parse(JSON.stringify(doc.deliveries));
    }, context);
    assert.equal(records.find((record) => record.id === 'cron:1:1000').status, 'delivered');
    await device.close();
  } finally {
    await app.stop();
    await store.close();
  }
});
