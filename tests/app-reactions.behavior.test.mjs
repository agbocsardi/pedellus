// Owner reactions on the app channel: one durable `reaction` event, a bounded per-thread passive
// note for the next ordinary send, and no turn from the reaction itself.
//
// Real Gateway over a temporary store, faux provider, one loopback listener on an ephemeral port
// and a synthetic WebSocket client speaking protocol v2. The adapter clock is controlled, every
// wait is event-driven, and every handle is closed by the test that opened it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APP_CHAT_SESSION_KEY, appState, deviceClient, openAppStore, postPair, startApp, userTexts,
} from './fixtures/app-harness.mjs';

async function withChannel(label, body, setup) {
  const store = await openAppStore(label);
  const app = startApp(store, setup === undefined ? {} : setup(store));
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

async function request(device, id, op, fields = {}) {
  device.send({ type: 'req', id, op, ...fields });
  await device.wait(() => device.response(id) !== undefined, `${op} reply`);
  return device.response(id);
}

async function connectV2(base, cookie) {
  const device = deviceClient(base, cookie);
  await device.open();
  assert.equal((await request(device, 'hello', 'hello', { v: 2, cursor: null })).v, 2);
  await device.wait(() => device.events('status').length > 0, 'end of replay');
  return device;
}

/** Admit one ordinary message and wait for its own turn to settle. */
async function sendAndSettle(device, key, text, thread) {
  const reply = await request(device, `send-${key}`, 'send', { key, text, ...(thread === undefined ? {} : { thread }) });
  assert.equal(reply.ok, true);
  await device.wait(() => device.events('settled').some((event) => event.key === key), `${key} settled`);
}

/** The model-facing user texts of every captured turn, oldest first. */
const prompts = (store) => userTexts(store.captured);

test('a reaction is durable, starts no turn and is carried once by the next send', { timeout: 30_000 }, async () => {
  await withChannel('reaction-context', async ({ store, base, app }) => {
    const device = await connectV2(base, await pairedDevice(store, base));
    await sendAndSettle(device, 'k1', 'message k1');
    await sendAndSettle(device, 'k2', 'message k2');
    assert.equal(store.captured.length, 2);

    app.clock.now += 5_000;
    assert.deepEqual(await request(device, 'react-1', 'react', { message: 'send:k1', emoji: '👍' }), { type: 'res', id: 'react-1', ok: true });
    await device.wait(() => device.events('reaction').length === 1, 'reaction event');
    const reaction = device.events('reaction')[0];
    assert.deepEqual(
      { thread: reaction.thread, message: reaction.message, by: reaction.by, emoji: reaction.emoji },
      { thread: 'main', message: 'send:k1', by: 'owner', emoji: '👍' },
    );
    assert.equal(typeof reaction.cursor, 'number');
    assert.equal(store.captured.length, 2, 'a reaction never starts a turn');

    const afterReact = await appState(store.gateway);
    assert.equal(afterReact.reactions.main.length, 1);
    assert.equal(afterReact.reactions.main[0].messageId, 'send:k1');
    assert.match(afterReact.reactions.main[0].text, /reaction on message send:k1 \(user\): old none; new 👍/u);

    // The next ordinary send carries the note to the model, while its echo keeps the owner's text.
    await sendAndSettle(device, 'k3', 'message k3');
    assert.match(prompts(store)[2], /\[App reaction context:/u);
    assert.match(prompts(store)[2], /reaction on message send:k1 \(user\)/u);
    assert.match(prompts(store)[2], /target "message k1"/u);
    assert.match(prompts(store)[2], /message k3$/u);
    const echo = device.events('message').find((event) => event.key === 'k3');
    assert.equal(echo.text, 'message k3', 'the echo is never prefixed');
    assert.equal((await appState(store.gateway)).reactions.main.length, 0, 'the note was consumed');

    // A later send sees nothing: the note is attached exactly once.
    await sendAndSettle(device, 'k4', 'message k4');
    assert.doesNotMatch(prompts(store)[3], /reaction context/u);
    assert.equal(prompts(store)[3], 'message k4');

    // A second change to the same message replaces the note instead of appending another one.
    assert.equal((await request(device, 'react-2', 'react', { message: 'send:k1', emoji: '❤️' })).ok, true);
    assert.equal((await request(device, 'react-3', 'react', { message: 'send:k1', emoji: '🎉' })).ok, true);
    await device.wait(() => device.events('reaction').length === 3, 'reaction events');
    const replaced = await appState(store.gateway);
    assert.equal(replaced.reactions.main.length, 1, 'one message keeps one note');
    assert.equal(replaced.reactions.main[0].emoji, '🎉');
    await sendAndSettle(device, 'k5', 'message k5');
    const bullets = prompts(store)[4].split('\n').filter((line) => line.includes('reaction on message send:k1'));
    assert.equal(bullets.length, 1);
    assert.match(bullets[0], /old ❤️; new 🎉; added 🎉; removed ❤️/u, 'the change is named explicitly');
    await device.close();
  });
});

test('a reaction is refused while its thread is being archived', { timeout: 30_000 }, async () => {
  // The archive's own commit is held open, so the thread is provably mid-archive when the reaction
  // arrives; it must be refused rather than appended to a thread that is going away.
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const gate = { armed: false, key: '', armedCheck: false };
  await withChannel('reaction-archive-race', async ({ store, base }) => {
    const device = await connectV2(base, await pairedDevice(store, base));
    const side = await request(device, 'create-side', 'thread.create', { key: 'side', title: 'Side' });
    assert.equal(side.ok, true);
    await sendAndSettle(device, 'ks', 'side message', side.thread);

    // The archive only reaches its conversation while `archiving` already holds the thread.
    gate.key = `${APP_CHAT_SESSION_KEY}:${side.thread}`;
    gate.armed = true;
    device.send({ type: 'req', id: 'archive-side', op: 'thread.archive', thread: side.thread, archived: true });
    await entered.promise;
    assert.equal(
      (await request(device, 'react-mid-archive', 'react', { thread: side.thread, message: 'send:ks', emoji: '👍' })).error,
      'bad_request',
    );
    release.resolve();
    await device.wait(() => device.response('archive-side')?.ok === true, 'archive completes');

    // Archived afterwards: still no target, and no reaction event was ever appended.
    assert.equal(
      (await request(device, 'react-archived', 'react', { thread: side.thread, message: 'send:ks', emoji: '👍' })).error,
      'bad_request',
    );
    assert.equal(device.events('reaction').length, 0);
    assert.equal((await appState(store.gateway)).reactions?.side, undefined);
    await device.close();
  }, (store) => {
    const gateway = store.gateway;
    return {
      gateway: {
        ...gateway,
        async conversationFor(key, ctx) {
          const chat = await gateway.conversationFor(key, ctx);
          if (!gate.armed || key !== gate.key) return chat;
          gate.armed = false;
          gate.armedCheck = true;
          entered.resolve();
          await release.promise;
          return chat;
        },
      },
    };
  });
  assert.equal(gate.armedCheck, true, 'the archive reached the gated point');
  release.resolve();
});

test('a notice is not a reaction target', { timeout: 30_000 }, async () => {
  await withChannel('reaction-notice', async ({ store, base }) => {
    const device = await connectV2(base, await pairedDevice(store, base));
    // An OAuth-callback send is stored as a gateway `notice`, never as the owner's own text.
    const callback = 'https://example.test/cb?state=s1&code=c1';
    assert.equal((await request(device, 'send-callback', 'send', { key: 'cb', text: callback })).ok, true);
    await device.wait(() => device.events('message').some((event) => event.role === 'notice'), 'callback notice');
    const notice = device.events('message').find((event) => event.role === 'notice');
    assert.equal((await request(device, 'react-notice', 'react', { message: notice.id, emoji: '👍' })).error, 'bad_request');
    assert.equal(device.events('reaction').length, 0, 'no reaction was appended');
    assert.equal((await appState(store.gateway)).reactions?.main, undefined, 'no note was retained');
    await device.close();
  });
});

test('reaction context is bounded, ages out, and refuses bad or archived targets', { timeout: 60_000 }, async () => {
  await withChannel('reaction-bounds', async ({ store, base, app }) => {
    const device = await connectV2(base, await pairedDevice(store, base));
    for (let index = 1; index <= 9; index += 1) await sendAndSettle(device, `k${index}`, `message k${index}`);
    assert.equal(store.captured.length, 9);

    for (let index = 1; index <= 9; index += 1) {
      app.clock.now += 1_000;
      assert.equal((await request(device, `react-${index}`, 'react', { message: `send:k${index}`, emoji: '👍' })).ok, true);
    }
    await device.wait(() => device.events('reaction').length === 9, 'reaction events');
    const bounded = await appState(store.gateway);
    assert.equal(bounded.reactions.main.length, 8, 'at most eight notes are kept per thread');
    assert.deepEqual(bounded.reactions.main.map((note) => note.messageId),
      ['send:k2', 'send:k3', 'send:k4', 'send:k5', 'send:k6', 'send:k7', 'send:k8', 'send:k9']);

    await sendAndSettle(device, 'k10', 'message k10');
    const carried = prompts(store)[9].split('\n').filter((line) => line.startsWith('- reaction on message'));
    assert.equal(carried.length, 8, 'the oldest note was evicted');
    assert.doesNotMatch(prompts(store)[9], /message send:k1\b/u);
    assert.match(prompts(store)[9], /message send:k9\b/u);

    // A note older than an hour is dropped instead of being attached to a much later input.
    app.clock.now += 2_000;
    assert.equal((await request(device, 'react-stale', 'react', { message: 'send:k10', emoji: '😂' })).ok, true);
    app.clock.now += 60 * 60_000 + 1;
    await sendAndSettle(device, 'k11', 'message k11');
    assert.doesNotMatch(prompts(store)[10], /reaction context/u);
    assert.equal(prompts(store)[10], 'message k11');
    assert.equal((await appState(store.gateway)).reactions.main.length, 0, 'the stale note was consumed, not kept');

    // Unknown targets and emoji outside the fixed palette are fixed refusals.
    assert.equal((await request(device, 'bad-emoji', 'react', { message: 'send:k1', emoji: '💩' })).error, 'bad_request');
    assert.equal((await request(device, 'missing-emoji', 'react', { message: 'send:k1' })).error, 'bad_request');
    assert.equal((await request(device, 'unknown-message', 'react', { message: 'send:nope', emoji: '👍' })).error, 'bad_request');
    assert.equal((await request(device, 'bad-message', 'react', { message: 42, emoji: '👍' })).error, 'bad_request');
    assert.equal((await request(device, 'bad-thread', 'react', { thread: 'not a thread', message: 'send:k1', emoji: '👍' })).error, 'bad_request');
    assert.equal(device.events('reaction').length, 10, 'no refused request appended an event');

    // An archived thread refuses the reaction even for a message it still owns.
    const side = await request(device, 'create-side', 'thread.create', { key: 'side', title: 'Side' });
    assert.equal(side.ok, true);
    await sendAndSettle(device, 'ks', 'side message', side.thread);
    assert.equal((await request(device, 'archive-side', 'thread.archive', { thread: side.thread, archived: true })).ok, true);
    assert.equal((await request(device, 'react-archived', 'react', { thread: side.thread, message: 'send:ks', emoji: '👍' })).error,
      'bad_request');
    assert.equal(device.events('reaction').length, 10);
    await device.close();
  });
});
