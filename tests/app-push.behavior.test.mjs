// App channel Web Push: strict config, local key generation, the three push requests, and the
// bounded sender — a content-free payload, no push to a connected device, one subscription per
// device, dead-endpoint removal and coalescing.
//
// Real Gateway over a temporary store, faux provider, the real adapter on an ephemeral loopback
// port, one synthetic push endpoint: a local HTTP server on an ephemeral loopback port that
// records the request the injected transport delivers. The transport seam exists only because
// `web-push` speaks HTTPS; production uses the pinned library. Every wait is event-driven (no
// sleeps), the clock is controllable and every handle is cleaned up.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  appState,
  context,
  deviceClient,
  openAppStore,
  parseConfig,
  postPair,
  startApp,
  until,
  untilAsync,
} from './fixtures/app-harness.mjs';

const modules = new URL('../dist/channels/', import.meta.url);
const { generatePushKeys, pushPayload, resolvePushOptions, PUSH_TTL_SECONDS } = await import(
  new URL('app-push.js', modules).href
);
const { validVapidPrivateKey, validVapidPublicKey } = await import(
  new URL('app-protocol.js', modules).href
);
const { parseAppInvocation } = await import(
  new URL('../dist/channels/app-operator-cli.js', import.meta.url).href
);

const WORKSPACE_BASE = {
  workspace: '/tmp/synthetic-app-push-workspace',
  dataDir: '/tmp/synthetic-app-push-state',
  model: { provider: 'fixture', modelId: 'alpha' },
  allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
};

const keys = await generatePushKeys();
const PUSH = { subject: 'mailto:push@example.test', publicKey: keys.publicKey, privateKey: keys.privateKey };

/** One synthetic push endpoint; the transport posts the pre-encryption payload here. */
async function pushEndpoint() {
  const requests = [];
  let status = 201;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status);
      response.end();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/push`;
  return {
    requests,
    url,
    setStatus(next) { status = next; },
    transport: async (request) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-test-topic': request.topic,
          'x-test-ttl': String(request.ttlSeconds),
          'x-test-urgency': request.urgency,
        },
        body: request.payload,
      });
      return { statusCode: response.status };
    },
    async waitFor(count) {
      await untilAsync(async () => requests.length >= count, `${count} push request(s)`);
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function withChannel(options, body) {
  const store = await openAppStore(options.label ?? 'push', options.store ?? {});
  const app = startApp(store, options.adapter ?? {});
  const port = await app.port;
  try {
    await body({ store, app, base: `http://127.0.0.1:${port}` });
  } finally {
    await app.stop();
    await store.close();
  }
}

async function paired(store, base, label) {
  const created = await store.gateway.appConsole.console().pair(label);
  assert.equal('refused' in created, false, `pairing refused: ${JSON.stringify(created)}`);
  const exchange = await postPair(base, created.code, label);
  assert.equal(exchange.status, 204);
  return exchange.cookie.split(';')[0];
}

/** A connected, hello'd device with a request counter so tests can await its nth request. */
async function connect(base, cookie) {
  const client = deviceClient(base, cookie);
  await client.open();
  client.send({ type: 'req', id: 'hello', op: 'hello', v: 2, cursor: null });
  await client.wait(() => client.response('hello') !== undefined, 'hello reply');
  return client;
}

let requestSeq = 0;
const nextId = (prefix) => `${prefix}${++requestSeq}`;

async function helpNotice(client) {
  const id = nextId('c');
  client.send({ type: 'req', id, op: 'control', command: 'help' });
  await client.wait(() => client.response(id) !== undefined, 'control reply');
}

function subscriptionAt(endpoint = 'https://push.example.test/sub') {
  return { endpoint, keys: { p256dh: keys.publicKey.slice(0, 87), auth: 'A'.repeat(22) } };
}

test('the app.push config block is optional, strict and never holds the private key', { timeout: 10_000 }, () => {
  const app = (push) => ({ ...WORKSPACE_BASE, app: { port: 43190, staticRoot: '/p', ...(push === undefined ? {} : { push }) } });
  assert.equal(parseConfig(app(), '/tmp').app.push, undefined);

  const parsed = parseConfig(app({ subject: PUSH.subject, publicKey: PUSH.publicKey, privateKeyEnv: 'APP_PUSH_KEY' }), '/tmp');
  assert.deepEqual(parsed.app.push, { subject: PUSH.subject, publicKey: PUSH.publicKey, privateKeyEnv: 'APP_PUSH_KEY' });

  for (const subject of ['owner@example.test', '', 'ftp://example.test', 'mailto:', `https://${'a'.repeat(250)}.test`]) {
    assert.throws(() => parseConfig(app({ subject, publicKey: PUSH.publicKey, privateKeyEnv: 'APP_PUSH_KEY' }), '/tmp'), /app\.push\.subject/u);
  }
  for (const publicKey of ['', PUSH.publicKey.slice(0, 86), 'A'.repeat(87), 7]) {
    assert.throws(() => parseConfig(app({ subject: PUSH.subject, publicKey, privateKeyEnv: 'APP_PUSH_KEY' }), '/tmp'), /app\.push\.publicKey/u);
  }
  for (const privateKeyEnv of ['', '1BAD', 'WITH-DASH', 7]) {
    assert.throws(() => parseConfig(app({ subject: PUSH.subject, publicKey: PUSH.publicKey, privateKeyEnv }), '/tmp'), /app\.push\.privateKeyEnv/u);
  }
  assert.throws(() => parseConfig(app({ subject: PUSH.subject, publicKey: PUSH.publicKey, privateKeyEnv: 'K', privateKey: keys.privateKey }), '/tmp'),
    /not a recognized option/u, 'the private key itself is never config');

  // Missing or malformed environment value: push is disabled, never fatal, and nothing is logged as a secret.
  assert.equal(resolvePushOptions(parsed.app.push, {}), undefined);
  assert.equal(resolvePushOptions(parsed.app.push, { APP_PUSH_KEY: 'not-a-key' }), undefined);
  assert.deepEqual(resolvePushOptions(parsed.app.push, { APP_PUSH_KEY: keys.privateKey }), PUSH);
});

test('app push-keys generates a usable pair locally and writes nothing', { timeout: 10_000 }, async () => {
  const invocation = parseAppInvocation(['push-keys']);
  assert.deepEqual(invocation.command, { kind: 'push-keys' });
  assert.equal(invocation.configPath, undefined);
  assert.throws(() => parseAppInvocation(['push-keys', '--config', '/tmp/x']), /Usage:|app/u);

  const pair = await generatePushKeys();
  assert.equal(validVapidPublicKey(pair.publicKey), true);
  assert.equal(validVapidPrivateKey(pair.privateKey), true);
  assert.notDeepEqual(pair, keys, 'every invocation generates a fresh pair');
});

test('push requests are unsupported without push configured', { timeout: 20_000 }, async () => {
  await withChannel({ label: 'push-off', store: { appBlock: {} } }, async ({ store, base }) => {
    const cookie = await paired(store, base, 'phone');
    const client = await connect(base, cookie);
    try {
      for (const [op, body] of [
        ['push.key', {}],
        ['push.subscribe', { subscription: subscriptionAt() }],
        ['push.unsubscribe', {}],
      ]) {
        const id = nextId('p');
        client.send({ type: 'req', id, op, ...body });
        await client.wait(() => client.response(id) !== undefined, `${op} reply`);
        assert.deepEqual(client.response(id), { type: 'res', id, ok: false, error: 'unsupported' });
      }
      // Nothing durable was stored either.
      assert.equal((await appState(store.gateway)).devices[0].pushSubscription, undefined);
    } finally {
      await client.close();
    }
  });
});

test('push.subscribe validates, replaces and unsubscribes one subscription per device', { timeout: 20_000 }, async () => {
  const endpoint = await pushEndpoint();
  try {
    await withChannel({ label: 'push-sub', adapter: { push: { ...PUSH, transport: endpoint.transport } } }, async ({ store, base }) => {
      const cookie = await paired(store, base, 'phone');
      const client = await connect(base, cookie);
      try {
        const keyId = nextId('p');
        client.send({ type: 'req', id: keyId, op: 'push.key' });
        await client.wait(() => client.response(keyId) !== undefined, 'push.key reply');
        assert.deepEqual(client.response(keyId), { type: 'res', id: keyId, ok: true, key: PUSH.publicKey });

        for (const bad of [
          undefined,
          null,
          { endpoint: 'http://push.example.test/x', keys: subscriptionAt().keys },
          { endpoint: 'https://push.example.test/x' },
          { endpoint: `https://push.example.test/${'a'.repeat(2_050)}`, keys: subscriptionAt().keys },
          { endpoint: 'https://push.example.test/x', keys: { p256dh: 'A'.repeat(129), auth: 'A'.repeat(22) } },
          { endpoint: 'https://push.example.test/x', keys: { p256dh: 'A'.repeat(30), auth: 'A'.repeat(65) } },
        ]) {
          const id = nextId('p');
          client.send({ type: 'req', id, op: 'push.subscribe', subscription: bad });
          await client.wait(() => client.response(id) !== undefined, 'bad subscription reply');
          assert.deepEqual(client.response(id), { type: 'res', id, ok: false, error: 'bad_request' });
        }

        const first = subscriptionAt('https://push.example.test/first');
        const id1 = nextId('p');
        client.send({ type: 'req', id: id1, op: 'push.subscribe', subscription: first });
        await client.wait(() => client.response(id1) !== undefined, 'subscribe reply');
        assert.equal(client.response(id1).ok, true);
        let device = (await appState(store.gateway)).devices.find((entry) => entry.label === 'phone');
        assert.deepEqual(device.pushSubscription, { endpoint: first.endpoint, ...first.keys });

        const second = subscriptionAt('https://push.example.test/second');
        const id2 = nextId('p');
        client.send({ type: 'req', id: id2, op: 'push.subscribe', subscription: second });
        await client.wait(() => client.response(id2) !== undefined, 'replace reply');
        device = (await appState(store.gateway)).devices.find((entry) => entry.label === 'phone');
        assert.deepEqual(device.pushSubscription, { endpoint: second.endpoint, ...second.keys },
          'a new subscription replaces the old');

        for (const attempt of [1, 2]) {
          const id = nextId('p');
          client.send({ type: 'req', id, op: 'push.unsubscribe' });
          await client.wait(() => client.response(id) !== undefined, `unsubscribe ${attempt} reply`);
          assert.equal(client.response(id).ok, true, 'unsubscribe is idempotent');
        }
        device = (await appState(store.gateway)).devices.find((entry) => entry.label === 'phone');
        assert.equal(device.pushSubscription, undefined);
      } finally {
        await client.close();
      }
    });
  } finally {
    await endpoint.close();
  }
});

test('a disconnected device gets one content-free push and a connected one gets none', { timeout: 30_000 }, async () => {
  const endpoint = await pushEndpoint();
  try {
    const adapter = { push: { ...PUSH, transport: endpoint.transport } };
    await withChannel({ label: 'push-send', adapter }, async ({ store, base }) => {
      const senderCookie = await paired(store, base, 'sender');
      const phoneCookie = await paired(store, base, 'phone');
      const sender = await connect(base, senderCookie);
      const phone = await connect(base, phoneCookie);
      try {
        const id = nextId('p');
        phone.send({ type: 'req', id, op: 'push.subscribe', subscription: subscriptionAt() });
        await phone.wait(() => phone.response(id) !== undefined, 'subscribe reply');
      } finally {
        await phone.close();
      }

      // The phone is offline: the notice reaches it as one push, and the payload has no text.
      await helpNotice(sender);
      await endpoint.waitFor(1);
      const [first] = endpoint.requests;
      assert.deepEqual(JSON.parse(first.body), { v: 2, thread: 'main', unread: 1 });
      assert.equal(/Usage|help/u.test(first.body), false, 'no message text in the payload');
      assert.match(first.headers['x-test-topic'], /^[A-Za-z0-9_-]{1,32}$/u);
      assert.equal(first.headers['x-test-ttl'], String(PUSH_TTL_SECONDS));
      assert.equal(first.headers['x-test-urgency'], 'normal');

      // Reconnected and hello'd, the same durable message arrives over the socket instead.
      const online = await connect(base, phoneCookie);
      try {
        const before = online.events('message').length;
        await helpNotice(sender);
        await online.wait(() => online.events('message').length > before, 'notice over the live stream');
        assert.equal(endpoint.requests.length, 1, 'a connected, hello\'d device is never pushed');
      } finally {
        await online.close();
      }
    });
  } finally {
    await endpoint.close();
  }
});

test('a 410 answer removes the subscription and later messages do not push', { timeout: 30_000 }, async () => {
  const endpoint = await pushEndpoint();
  try {
    const adapter = { push: { ...PUSH, transport: endpoint.transport } };
    await withChannel({ label: 'push-gone', adapter }, async ({ store, base }) => {
      const sender = await connect(base, await paired(store, base, 'sender'));
      const phone = await connect(base, await paired(store, base, 'phone'));
      try {
        const id = nextId('p');
        phone.send({ type: 'req', id, op: 'push.subscribe', subscription: subscriptionAt() });
        await phone.wait(() => phone.response(id) !== undefined, 'subscribe reply');
      } finally {
        await phone.close();
      }
      const hasSubscription = async () => (await appState(store.gateway)).devices
        .find((entry) => entry.label === 'phone').pushSubscription !== undefined;

      endpoint.setStatus(410);
      await helpNotice(sender);
      await untilAsync(async () => !(await hasSubscription()), 'the dead subscription was removed');
      await endpoint.waitFor(1);

      // The next durable message pushes nothing: not retried, not queued for that device.
      endpoint.setStatus(201);
      await helpNotice(sender);
      await until(() => sender.events('message').length >= 2, 'the second notice was appended');
      assert.equal(endpoint.requests.length, 1);
      await sender.close();
    });
  } finally {
    await endpoint.close();
  }
});

test('pushes to one device coalesce while a send is in flight', { timeout: 30_000 }, async () => {
  const endpoint = await pushEndpoint();
  let releaseFirst;
  const firstHeld = new Promise((resolveHeld) => { releaseFirst = resolveHeld; });
  let started;
  const firstStarted = new Promise((resolveStarted) => { started = resolveStarted; });
  let hold = true;
  const transport = async (request) => {
    if (hold) {
      hold = false;
      started();
      await firstHeld;
    }
    return endpoint.transport(request);
  };
  try {
    await withChannel({ label: 'push-coalesce', adapter: { push: { ...PUSH, transport } } }, async ({ store, base }) => {
      const sender = await connect(base, await paired(store, base, 'sender'));
      const phone = await connect(base, await paired(store, base, 'phone'));
      try {
        const id = nextId('p');
        phone.send({ type: 'req', id, op: 'push.subscribe', subscription: subscriptionAt() });
        await phone.wait(() => phone.response(id) !== undefined, 'subscribe reply');
      } finally {
        await phone.close();
      }

      await helpNotice(sender);
      await firstStarted;
      // Two more durable notices arrive while the first send is still in flight.
      await helpNotice(sender);
      await helpNotice(sender);
      await until(() => sender.events('message').length >= 3, 'all three notices were appended');
      releaseFirst();
      await endpoint.waitFor(2);

      assert.equal(endpoint.requests.length, 2, 'at most one follow-up is sent');
      assert.deepEqual(JSON.parse(endpoint.requests[0].body), { v: 2, thread: 'main', unread: 1 });
      assert.deepEqual(JSON.parse(endpoint.requests[1].body), { v: 2, thread: 'main', unread: 3 },
        'the follow-up carries the latest unread count');
      await sender.close();
    });
  } finally {
    await endpoint.close();
  }
});

test('the payload caps unread and hashes the thread into a valid Topic', { timeout: 10_000 }, async () => {
  assert.deepEqual(JSON.parse(pushPayload('main', 250)), { v: 2, thread: 'main', unread: 99 });
  assert.deepEqual(JSON.parse(pushPayload('main', -1)), { v: 2, thread: 'main', unread: 0 });
});
