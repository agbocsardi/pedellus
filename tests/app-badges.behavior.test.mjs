// App thread badges: the opt-in config cross-check, one off-request-path classifier call for the
// two fixed-list choices, the untouched-default-title rule, `main` staying unbadged, and every
// failure path leaving the thread exactly as it was with no content in the journal.
//
// Real Gateway over a temporary store, faux chat provider, a synthetic classifier answering the
// two fixed-list choices (no external service), one real loopback listener and a synthetic device
// speaking protocol v2. Every wait is event-driven; no test sleeps on a schedule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typesafeProvider } from '../node_modules/@earendil-works/pi-ai/dist/providers/typesafe.js';

import { fauxModels } from './fixtures/discord-harness.mjs';
import {
  appState,
  deviceClient,
  openAppStore,
  parseConfig,
  postPair,
  startApp,
  untilAsync,
} from './fixtures/app-harness.mjs';

const CLASSIFIER = { provider: 'typesafe', modelId: 'jev-latest' };
const WORKSPACE_BASE = {
  workspace: '/tmp/synthetic-app-badge-workspace',
  dataDir: '/tmp/synthetic-app-badge-state',
  model: { provider: 'fixture', modelId: 'alpha' },
  allowedModels: [{ provider: 'fixture', modelId: 'alpha' }],
};
const APP_BASE = { port: 43190, staticRoot: '/tmp/synthetic-pwa' };

/** One classifier result with both choice answers filled in. */
function choice(emoji, verb, stopReason = 'stop') {
  return {
    api: 'typesafe-system-one', provider: 'typesafe', model: 'jev-latest', stopReason, timestamp: 0,
    answers: {
      emoji: { type: 'choice', choice: emoji, confidence: 0.9, probabilities: { [emoji]: 0.9 } },
      verb: { type: 'choice', choice: verb, confidence: 0.9, probabilities: { [verb]: 0.9 } },
    },
  };
}

/** The chat catalog a real gateway needs, plus a synthetic classifier the test controls. */
function badgeModels() {
  const { models } = fauxModels([]);
  models.setProvider(typesafeProvider());
  const classifier = { calls: [], reply: () => choice('💻', 'Fix'), hold: undefined };
  models.classify = async (model, input) => {
    classifier.calls.push({ model: { provider: model.provider, modelId: model.id }, ...input });
    if (classifier.hold !== undefined) await classifier.hold;
    return classifier.reply();
  };
  return { models, classifier };
}

/** The real gateway with `threadBadges` on, the adapter over an ephemeral loopback port. */
async function openBadgeChannel(t) {
  const { models, classifier } = badgeModels();
  const store = await openAppStore('badge', {
    rawConfig: (raw) => parseConfig({
      ...raw,
      classifierModel: CLASSIFIER,
      app: { ...raw.app, threadBadges: true },
    }, '/tmp'),
    gatewayOptions: { models },
  });
  const app = startApp(store, {});
  const port = await app.port;
  const channel = {
    store,
    classifier,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.stop();
      await store.close();
    },
  };
  t.after(() => channel.close());
  return channel;
}

/** One paired device on a live stream, past `hello`. */
async function openDevice(channel, t) {
  const created = await channel.store.gateway.appConsole.console().pair('phone');
  assert.equal('refused' in created, false, 'pairing was refused');
  const exchange = await postPair(channel.base, created.code, 'phone');
  assert.equal(exchange.status, 204, 'pairing exchange failed');
  const device = deviceClient(channel.base, exchange.cookie.split(';')[0]);
  await device.open();
  t.after(() => device.close());
  device.send({ type: 'req', id: 'hello', op: 'hello', v: 2, cursor: null });
  await device.wait(() => device.response('hello') !== undefined, 'hello reply');
  return device;
}

async function request(device, id, op, fields = {}) {
  device.send({ type: 'req', id, op, ...fields });
  await device.wait(() => device.response(id) !== undefined, `${op} reply`);
  return device.response(id);
}

async function threadInfo(gateway, thread) {
  const state = await appState(gateway);
  return state.threads.find((entry) => entry.id === thread);
}

test('app.threadBadges is off by default, strict, and requires classifierModel', () => {
  assert.equal(parseConfig({ ...WORKSPACE_BASE, app: APP_BASE }, '/tmp').app.threadBadges, undefined);
  assert.equal(parseConfig({ ...WORKSPACE_BASE, app: { ...APP_BASE, threadBadges: false } }, '/tmp').app.threadBadges, undefined);
  assert.equal(parseConfig({
    ...WORKSPACE_BASE, classifierModel: CLASSIFIER, app: { ...APP_BASE, threadBadges: true },
  }, '/tmp').app.threadBadges, true);
  assert.throws(() => parseConfig({ ...WORKSPACE_BASE, app: { ...APP_BASE, threadBadges: true } }, '/tmp'),
    /app\.threadBadges requires classifierModel/u);
  for (const threadBadges of ['yes', 1, null, []]) {
    assert.throws(() => parseConfig({
      ...WORKSPACE_BASE, classifierModel: CLASSIFIER, app: { ...APP_BASE, threadBadges },
    }, '/tmp'), /app\.threadBadges must be true or false/u);
  }
});

test('the first side-thread message gets a listed badge and the default title, never main', { timeout: 20_000 }, async (t) => {
  const channel = await openBadgeChannel(t);
  const device = await openDevice(channel, t);

  const main = await request(device, 'main-send', 'send', { key: 'main-1', text: 'good morning' });
  assert.deepEqual(main, { type: 'res', id: 'main-send', ok: true, duplicate: false });
  const created = await request(device, 'create', 'thread.create', { key: 't1' });
  const side = created.thread;
  assert.equal((await threadInfo(channel.store.gateway, side)).title, 'New thread');

  await request(device, 'side-send', 'send', { key: 'side-1', thread: side, text: 'help me debug this function' });
  await untilAsync(async () => (await threadInfo(channel.store.gateway, side)).badge !== undefined, 'badge committed');

  const info = await threadInfo(channel.store.gateway, side);
  assert.deepEqual(info.badge, { emoji: '💻', verb: 'Fix' });
  assert.equal(info.title, '💻 Fix');
  assert.equal((await threadInfo(channel.store.gateway, 'main')).badge, undefined, 'main is never badged');
  assert.equal(channel.classifier.calls.length, 1, 'one call for one first message');
  const call = channel.classifier.calls[0];
  assert.deepEqual(call.state, { title: 'New thread', firstMessage: 'help me debug this function' });
  assert.deepEqual(Object.keys(call.questions), ['emoji', 'verb']);
  assert.equal(call.questions.emoji.type, 'choice');
  assert.ok(Object.hasOwn(call.questions.emoji.criteria, '💻'), 'the emoji criteria are the fixed list');
  assert.ok(Object.hasOwn(call.questions.verb.criteria, 'Fix'), 'the verb criteria are the fixed list');
});

test('a rename classifies the new title, keeps it, and one in-flight call is never doubled', { timeout: 20_000 }, async (t) => {
  const channel = await openBadgeChannel(t);
  const device = await openDevice(channel, t);

  // A rename with no owner message yet classifies the title alone.
  const created = await request(device, 'create', 'thread.create', { key: 't1' });
  channel.classifier.reply = () => choice('🛒', 'Buy');
  await request(device, 'rename', 'thread.rename', { thread: created.thread, title: 'Groceries for the week' });
  await untilAsync(async () => (await threadInfo(channel.store.gateway, created.thread)).badge !== undefined, 'badge after rename');
  let info = await threadInfo(channel.store.gateway, created.thread);
  assert.deepEqual(info.badge, { emoji: '🛒', verb: 'Buy' });
  assert.equal(info.title, 'Groceries for the week');
  assert.deepEqual(channel.classifier.calls.at(-1).state, { title: 'Groceries for the week' });

  // A later rename reclassifies an already-badged thread.
  channel.classifier.reply = () => choice('🍳', 'Cook');
  await request(device, 'rename-2', 'thread.rename', { thread: created.thread, title: 'Dinner ideas' });
  await untilAsync(async () =>
    (await threadInfo(channel.store.gateway, created.thread)).badge.emoji === '🍳', 'badge updated');
  info = await threadInfo(channel.store.gateway, created.thread);
  assert.equal(info.title, 'Dinner ideas');

  // A manual rename that wins a held classification keeps its title; the badge still arrives.
  let release;
  channel.classifier.hold = new Promise((resolve) => { release = resolve; });
  channel.classifier.reply = () => choice('💻', 'Debug');
  const forked = await request(device, 'create-2', 'thread.create', { key: 't2' });
  await request(device, 'send-2', 'send', { key: 'side-2', thread: forked.thread, text: 'the build is broken' });
  await untilAsync(() => channel.classifier.calls.length === 3, 'held classification started');
  await request(device, 'rename-3', 'thread.rename', { thread: forked.thread, title: 'Build failure' });
  release();
  channel.classifier.hold = undefined;
  await untilAsync(async () => (await threadInfo(channel.store.gateway, forked.thread)).badge !== undefined, 'held badge applied');
  info = await threadInfo(channel.store.gateway, forked.thread);
  assert.equal(info.title, 'Build failure', 'a manual rename that won the race is kept');
  assert.deepEqual(info.badge, { emoji: '💻', verb: 'Debug' });
  assert.equal(channel.classifier.calls.length, 3, 'a rename during one call starts no second call');
});

test('a failed or unlisted classification leaves the thread unbadged and journals no content', { timeout: 20_000 }, async (t) => {
  const events = [];
  const lines = [];
  t.mock.method(console, 'info', (line) => {
    lines.push(String(line));
    const event = JSON.parse(String(line).slice('pedellus journal: '.length));
    if (String(event.event).startsWith('app.threadBadge.')) events.push(event);
  });
  const channel = await openBadgeChannel(t);
  const device = await openDevice(channel, t);
  const SECRET_TEXT = 'my passport number is tied to this private message';

  channel.classifier.reply = () => { throw new Error('provider payload that must never be journalled'); };
  const failed = await request(device, 'create-failed', 'thread.create', { key: 'failed' });
  await request(device, 'send-failed', 'send', { key: 'failed-1', thread: failed.thread, text: SECRET_TEXT });
  await untilAsync(() => events.some((event) => event.attributes?.reason === 'failed'), 'failed classification journalled');
  assert.equal((await threadInfo(channel.store.gateway, failed.thread)).badge, undefined);
  assert.equal((await threadInfo(channel.store.gateway, failed.thread)).title, 'New thread');

  channel.classifier.reply = () => choice('🚀', 'Fix');
  const unlisted = await request(device, 'create-unlisted', 'thread.create', { key: 'unlisted' });
  await request(device, 'send-unlisted', 'send', { key: 'unlisted-1', thread: unlisted.thread, text: 'something else' });
  await untilAsync(() => events.some((event) => event.attributes?.reason === 'no_choice'), 'unlisted choice journalled');
  assert.equal((await threadInfo(channel.store.gateway, unlisted.thread)).badge, undefined);
  assert.equal((await threadInfo(channel.store.gateway, unlisted.thread)).title, 'New thread');

  const journal = lines.join('\n');
  assert.doesNotMatch(journal, /passport number|private message|provider payload/);
});
