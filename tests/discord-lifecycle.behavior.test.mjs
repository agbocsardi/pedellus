// Discord transport lifecycle edges found by review: startup ingress capture, interaction
// acknowledgement during recovery, rate-limit cooldowns, failed control admission, unconfirmed
// control pruning and a failed scheduled write-ahead intent.
//
// The startup case drives the *real* discord.js transport through an injected synthetic client while
// durable recovery is explicitly gated; the rest use the adapter's synthetic transport with the
// adapter's own mocked timers. No token, network, live guild or provider is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOT_ID,
  CHANNEL_ID,
  USER_ID,
  admitDelivery,
  channelState,
  context,
  deferred,
  flush,
  guildMessage,
  openDiscordStore,
  outboxRecords,
  runDiscord,
  sessionKeys,
  startDiscord,
  syntheticTransport,
  until,
  untilAsync,
  withCancel,
} from './fixtures/discord-harness.mjs';

const { createDiscordJsTransport } = await import(
  new URL('../dist/channels/discord-js.js', import.meta.url).href
);
const discord = await import('discord.js');
const { DiscordState } = await import(new URL('../dist/channels/discord.js', import.meta.url).href);

/** A Collection-like wrapper, as discord.js exposes `.values()`/`.map()` on these. */
function collection(items) {
  return { size: items.length, map: (fn) => items.map(fn), values: () => items[Symbol.iterator]() };
}

function rawChannel(over = {}) {
  return {
    id: over.id,
    name: over.name ?? 'dm',
    parentId: null,
    isThread: () => false,
    isDMBased: () => over.dm === true,
    async send(payload) {
      over.sent?.push({ channelId: over.id, text: payload.content });
      return { id: String(9_000 + (over.sent?.length ?? 0)) };
    },
    async sendTyping() { return undefined; },
    messages: {
      async fetch(id) { return rawMessage({ id, channel: over, content: `quoted ${id}` }); },
      async edit() { return undefined; },
    },
  };
}

function rawMessage(over = {}) {
  return {
    id: over.id ?? '1',
    channelId: over.channel.id,
    guildId: over.guildId ?? null,
    partial: false,
    content: over.content ?? 'hello',
    type: 0,
    author: { id: USER_ID, username: 'alice', displayName: 'Alice', bot: false },
    member: { displayName: 'Alice' },
    mentions: { users: collection([]), members: collection([]), everyone: false, repliedUser: null },
    reference: null,
    attachments: collection([]),
    channel: over.channel,
    react: async () => undefined,
    reactions: { resolve: () => null },
  };
}

/** A minimal synthetic discord.js client: records listeners so the test can emit events. */
function fakeClient({ channels, sendTexts }) {
  const handlers = new Map();
  const emit = (event, payload) => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
  };
  const client = {
    user: { id: BOT_ID, username: 'synthetic_bot' },
    application: { commands: { set: async () => new Map() } },
    channels: {
      cache: { get: (id) => channels.get(id) },
      fetch: async (id) => {
        const channel = channels.get(id);
      if (channel === undefined) throw Object.assign(new Error('unknown channel'), { status: 404 });
      return channel;
      },
    },
    guilds: {
      cache: { get: () => undefined },
      fetch: async () => { throw Object.assign(new Error('unknown guild'), { status: 404 }); },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return client;
    },
    once(event, handler) {
      const wrapped = (payload) => { client.off(event, wrapped); handler(payload); };
      return client.on(event, wrapped);
    },
    off(event, handler) { handlers.get(event)?.delete(handler); return client; },
    removeAllListeners() { handlers.clear(); return client; },
    async login() {
      emit(discord.Events.ClientReady, client);
      return 'ok';
    },
    async destroy() { return undefined; },
  };
  void sendTexts;
  return { client, emit };
}

test('events that arrive before durable recovery are buffered, replayed in order, and never lost', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('startup-ingress', { tools: ['read'] });
  const sent = [];
  const dmChannel = rawChannel({ id: '8001', dm: true, sent });
  const fake = fakeClient({ channels: new Map([['8001', dmChannel]]), sendTexts: sent });

  // Explicitly gate durable recovery: the adapter must have registered its listeners by then.
  const recoveryGate = deferred();
  const recoveryEntered = deferred();
  const base = store.gateway.conversationFor.bind(store.gateway);
  const gatedGateway = {
    ...store.gateway,
    async conversationFor(key, ctx) {
      if (key.endsWith(':channel-state')) {
        recoveryEntered.resolve();
        await recoveryGate.promise;
      }
      return base(key, ctx);
    },
  };
  const scope = withCancel(context);
  const transport = createDiscordJsTransport({ token: 'synthetic-token', createClient: () => fake.client });
  const adapter = runDiscord(gatedGateway, transport, {
    allowFrom: [USER_ID],
    streaming: false,
  }, scope.context);
  const replies = [];
  try {
    await recoveryEntered.promise;
    // Two owner messages arrive while recovery is still running: both are captured, not dropped.
    fake.emit(discord.Events.MessageCreate, rawMessage({ id: '2101', channel: dmChannel, content: 'first early' }));
    fake.emit(discord.Events.MessageCreate, rawMessage({ id: '2102', channel: dmChannel, content: 'second early' }));
    // A command during recovery gets a fixed refusal within the acknowledgement window and is not stored.
    fake.emit(discord.Events.InteractionCreate, {
      id: '910001',
      channelId: '8001',
      guildId: null,
      channel: dmChannel,
      user: { id: USER_ID, username: 'alice', bot: false },
      commandName: 'status',
      isChatInputCommand: () => true,
      isRepliable: () => true,
      options: { getString: () => null },
      reply: async (payload) => { replies.push(payload); },
    });
    await until(() => replies.length === 1, 'startup interaction refusal');
    assert.match(replies[0].content, /still starting/u);
    assert.equal(replies[0].flags, discord.MessageFlags.Ephemeral);
    assert.deepEqual((await channelState(store.gateway)).pending, []);
    assert.deepEqual((await channelState(store.gateway)).controls, []);

    recoveryGate.resolve();
    await until(() => sent.filter((entry) => entry.text === 'SYNTHETIC-REPLY').length === 2, 'both buffered messages answered');
    // The original order is preserved: the two model requests carry the inputs in arrival order.
    const inputs = store.captured
      .flatMap((request) => request.messages)
      .filter((entry) => entry.role === 'user')
      .map((entry) => (typeof entry.content === 'string'
        ? entry.content
        : entry.content.filter((part) => part.type === 'text').map((part) => part.text).join('')));
    assert.ok(inputs.some((text) => text.includes('first early')));
    assert.ok(inputs.some((text) => text.includes('second early')));
    const secondIndex = inputs.findIndex((text) => text.includes('second early'));
    const firstIndex = inputs.findIndex((text) => text.includes('first early'));
    assert.ok(firstIndex >= 0 && secondIndex > firstIndex, 'buffered events are replayed in arrival order');
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
});

test('an ordinary rate-limit cooldown is waited out without spending delivery attempts', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const store = await openDiscordStore('cooldown-ordinary', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    harness.state.nextSendFailure = Object.assign(new Error('rate limited'), { status: 429, retry_after: 30 });
    await harness.receive(guildMessage({ id: '2201', content: `<@${BOT_ID}> slow down` }));
    await until(() => harness.state.inFlight === 0 && harness.sent.length === 0, 'the first attempt to fail');
    // The record stays pending with no failure status: the cooldown is a wait, not an attempt.
    let record = (await channelState(store.gateway)).pending.find((entry) => entry.key === 'm:2201');
    assert.ok(record !== undefined);
    assert.equal(record.deliveryStatus, undefined);
    for (let elapsed = 0; elapsed < 20_000; elapsed += 2_000) {
      t.mock.timers.tick(2_000);
      await flush(4);
    }
    assert.equal(harness.sent.length, 0, 'no request is attempted inside the cooldown');
    record = (await channelState(store.gateway)).pending.find((entry) => entry.key === 'm:2201');
    assert.equal(record.deliveryStatus, undefined, 'waiting scans never count as delivery failures');

    // Past the hint the next cadence delivers once.
    t.mock.timers.tick(15_000);
    await flush(6);
    await until(() => harness.sent.length === 1, 'delivery after the cooldown');
    assert.equal(harness.sent[0].text, 'SYNTHETIC-REPLY');
    assert.deepEqual((await channelState(store.gateway)).pending, []);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a scheduled rate-limit cooldown keeps the record pending and retries after the hint', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const store = await openDiscordStore('cooldown-scheduled', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await harness.receive(guildMessage({ id: '2301', content: `<@${BOT_ID}> establish origin` }));
    await until(() => harness.sent.length === 1, 'origin admission');
    harness.state.nextSendFailure = Object.assign(new Error('rate limited'), { status: 429, retry_after: 30 });
    await admitDelivery(store.gateway, sessionKeys.channel, {
      id: 'cron:job-cooldown:1',
      sessionKey: sessionKeys.channel,
      text: 'scheduled answer',
      createdAtMs: Date.now(),
      status: 'pending',
      nextChunkIndex: 0,
    });
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-cooldown:1')?.status === 'pending'
      && harness.state.inFlight === 0 && harness.sent.length === 1, 'first scheduled attempt to fail');
    let record = (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((entry) => entry.id === 'cron:job-cooldown:1');
    assert.equal(record.status, 'pending', 'a cooldown is retryable, not failed or ambiguous');
    for (let elapsed = 0; elapsed < 20_000; elapsed += 2_000) {
      t.mock.timers.tick(2_000);
      await flush(4);
    }
    assert.equal(harness.texts().filter((text) => text === 'scheduled answer').length, 0);
    t.mock.timers.tick(15_000);
    await flush(6);
    await until(() => harness.texts().includes('scheduled answer'), 'scheduled delivery after the cooldown');
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((entry) => entry.id === 'cron:job-cooldown:1')?.status === 'delivered', 'delivered status');
    record = (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((entry) => entry.id === 'cron:job-cooldown:1');
    assert.equal(record.sendIntent, undefined);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a failed control admission releases its gate and never leaves a half-admitted command', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('control-admission-failure', {});
  const harness = syntheticTransport();
  const stateKey = `discord:${BOT_ID}:channel-state`;
  const base = store.gateway.conversationFor.bind(store.gateway);
  let failNextCommit = false;
  const gateway = {
    ...store.gateway,
    async conversationFor(key, ctx) {
      const conversation = await base(key, ctx);
      if (key !== stateKey) return conversation;
      return new Proxy(conversation, {
        get(target, property, receiver) {
          if (property === 'commit') {
            return (change, commitContext) => {
              if (failNextCommit) {
                failNextCommit = false;
                return Promise.reject(new Error('synthetic state commit failure'));
              }
              return target.commit(change, commitContext);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
  const scope = withCancel(context);
  const adapter = runDiscord(gateway, harness.transport, { allowFrom: [USER_ID], streaming: false }, scope.context);
  try {
    await harness.receive(guildMessage({ id: '2401', content: `<@${BOT_ID}> hello` }));
    await until(() => harness.sent.length === 1, 'adapter ready');
    failNextCommit = true;
    await harness.receive(guildMessage({ id: '2402', content: `<@${BOT_ID}> /new`, mentions: [] }));
    await flush(8);
    // The failed admission left no control record and no held notice.
    let state = await channelState(store.gateway);
    assert.deepEqual(state.controls, []);
    assert.deepEqual(state.pending.filter((entry) => entry.notice === true), []);
    // The channel is not gated: the same command works now.
    await harness.receive(guildMessage({ id: '2403', content: `<@${BOT_ID}> /new`, mentions: [] }));
    await untilAsync(async () => harness.texts().includes('Context reset.'), 'control after the failure');
    state = await channelState(store.gateway);
    assert.equal(state.controls.at(-1).status, 'applied');
    assert.deepEqual(state.pending, []);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
});

test('a reported unconfirmed control is pruned with its notice on reopen', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('control-pruning', {});
  const conversation = await store.gateway.conversationFor(`discord:${BOT_ID}:channel-state`, context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(DiscordState, conversation.id);
    doc.controls.push({
      key: 'm:2501', command: 'abort', status: 'admitted', channelId: CHANNEL_ID, senderId: USER_ID,
    });
    // The report a previous recovery already queued for that command.
    doc.pending.push({
      key: 'unconfirmed:m:2501', channelId: CHANNEL_ID, sessionKey: sessionKeys.channel, senderId: USER_ID,
      text: 'Command interrupted; outcome unknown. Send it again if needed.',
      admittedAtMs: Date.now(), nextChunkIndex: 0, notice: true,
    });
    return undefined;
  }, context);
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 1, 'unconfirmed report');
    assert.match(harness.texts()[0], /Command interrupted/u);
    await untilAsync(async () => (await channelState(store.gateway)).pending.length === 0, 'report retired');
    const state = await channelState(store.gateway);
    // The report's identity covers its control: a delivered report leaves nothing unresolved behind.
    assert.equal(state.controls.some((entry) => entry.key === 'm:2501'), false);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a failed scheduled write-ahead intent commit is retryable, never an ambiguous send', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('scheduled-intent-failure', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await harness.receive(guildMessage({ id: '2601', content: `<@${BOT_ID}> establish origin` }));
    await until(() => harness.sent.length === 1, 'origin admission');
    // The next outbox write (the pre-request intent) fails before any Discord request is made.
    let failNextUpdate = true;
    const original = store.gateway.cronOutbox;
    const flaky = {
      ...original,
      async update(sessionKey, id, change, ctx) {
        if (failNextUpdate) {
          failNextUpdate = false;
          throw new Error('synthetic intent commit failure');
        }
        return original.update(sessionKey, id, change, ctx);
      },
    };
    const flakyGateway = { ...store.gateway, cronOutbox: flaky };
    // Restart the adapter so it holds the flaky outbox.
    await adapter.stop();
    const retryHarness = syntheticTransport();
    const retryAdapter = startDiscord({ ...store, gateway: flakyGateway }, retryHarness, { streaming: false });
    try {
      await admitDelivery(store.gateway, sessionKeys.channel, {
        id: 'cron:job-intent:1',
        sessionKey: sessionKeys.channel,
        text: 'intent answer',
        createdAtMs: Date.now(),
        status: 'pending',
        nextChunkIndex: 0,
      });
      await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
        .find((record) => record.id === 'cron:job-intent:1')?.status === 'pending', 'record still pending');
      let record = (await outboxRecords(store.gateway, sessionKeys.channel))
        .find((entry) => entry.id === 'cron:job-intent:1');
      assert.notEqual(record.status, 'unknown', 'a pre-request intent failure is not an ambiguous send');
      assert.equal(record.sendIntent, undefined);
      assert.equal(retryHarness.texts().includes('intent answer'), false);
      // The next cadence retries and delivers.
      await until(() => retryHarness.texts().includes('intent answer'), 'retry delivery', 20_000);
      await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
        .find((entry) => entry.id === 'cron:job-intent:1')?.status === 'delivered', 'delivered');
    } finally {
      await retryAdapter.stop();
    }
  } finally {
    await adapter.stop();
    await store.close();
  }
});
