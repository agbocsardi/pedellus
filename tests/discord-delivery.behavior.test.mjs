// Discord scheduled results, interruption notices, restart confirmation and unknown-outcome honesty,
// plus the gateway's concurrent channel startup.
//
// The outbox is written as a settled cron run would write it, the transport is synthetic and the
// inline timers are the adapter's own scan cadence: no credential, network, live guild or sleep-based
// schedule wait.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOT_ID,
  CHANNEL_ID,
  DiscordTransportError,
  USER_ID,
  admitDelivery,
  channelState,
  context,
  deferred,
  guildMessage,
  openDiscordStore,
  outboxRecords,
  sessionKeys,
  splitDiscordText,
  startDiscord,
  syntheticTransport,
  until,
  untilAsync,
} from './fixtures/discord-harness.mjs';

const { superviseChannels } = await import(new URL('../dist/cli.js', import.meta.url).href);
const { DiscordState } = await import(new URL('../dist/channels/discord.js', import.meta.url).href);
const { turnInterruptionDelivery } = await import(new URL('../dist/recovery/interruption.js', import.meta.url).href);

function delivery(id, overrides = {}) {
  return {
    id,
    sessionKey: sessionKeys.channel,
    text: 'scheduled answer',
    createdAtMs: Date.now(),
    status: 'pending',
    nextChunkIndex: 0,
    ...overrides,
  };
}

async function writeState(store, change) {
  const conversation = await store.gateway.conversationFor(`discord:${BOT_ID}:channel-state`, context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(DiscordState, conversation.id);
    change(doc);
    return undefined;
  }, context);
}

test('channels start together and a failing one shuts the others down before reporting', { timeout: 15_000 }, async () => {
  let shutdowns = 0;
  const order = [];
  let stopLong;
  const long = new Promise((resolve) => { stopLong = () => { order.push('long-stopped'); resolve(); }; });
  const shutdown = () => {
    shutdowns += 1;
    order.push('shutdown');
    stopLong();
  };
  const failure = new Error('synthetic channel failure');

  // Both channels are started (their promises created) before anything is awaited: the supervisor
  // must never await one channel before the other exists.
  const supervisor = superviseChannels(shutdown);
  const longRun = Promise.resolve().then(() => { order.push('long-started'); return long; });
  const failingRun = Promise.resolve().then(() => { order.push('failing-started'); throw failure; });
  supervisor.start('gateway.discord', longRun);
  supervisor.start('gateway.telegram', failingRun);
  assert.equal(supervisor.started(), true);
  const result = await supervisor.settle();

  assert.deepEqual(order.slice(0, 3), ['long-started', 'failing-started', 'shutdown']);
  assert.ok(order.includes('long-stopped'), 'the supervisor waited for the sibling to stop');
  assert.equal(result.stage, 'gateway.telegram');
  assert.equal(result.error, failure);
  assert.equal(shutdowns, 1);

  // A clean stop of every channel reports no failure, and an unused supervisor never started one.
  const clean = superviseChannels(shutdown);
  clean.start('gateway.discord', Promise.resolve());
  assert.equal(await clean.settle(), undefined);
  assert.equal(superviseChannels(shutdown).started(), false);
  assert.equal(shutdowns, 1);
});

test('a channel that fails before the supervisor is awaited emits no unhandled rejection', { timeout: 15_000 }, async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const supervisor = superviseChannels(() => {});
    // The run rejects immediately, before anything awaits the supervisor's bookkeeping.
    supervisor.start('gateway.discord', Promise.reject(new Error('early channel failure')));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'an early channel failure must be retained, not rethrown into nothing');
    const failed = await supervisor.settle();
    assert.equal(failed.stage, 'gateway.discord');
    assert.match(failed.error.message, /early channel failure/u);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('a later channel setup failure stops and awaits the channel that already started', { timeout: 15_000 }, async () => {
  // This mirrors the gateway's own order: Telegram starts, Discord setup then fails before starting.
  const order = [];
  let stopTelegram;
  const telegram = new Promise((resolve) => { stopTelegram = () => { order.push('telegram-stopped'); resolve(); }; });
  const shutdown = () => {
    order.push('shutdown');
    stopTelegram();
  };
  const supervisor = superviseChannels(shutdown);
  supervisor.start('gateway.telegram', Promise.resolve().then(() => { order.push('telegram-started'); return telegram; }));
  // Setup continues on a later tick, exactly as a real adapter start does.
  await new Promise((resolve) => setImmediate(resolve));
  // The second channel never starts: its setup throws. The gateway's catch does exactly this.
  let setupError;
  try {
    throw new Error('discord setup failed');
  } catch (error) {
    setupError = error;
    shutdown();
    const failed = await supervisor.settle();
    assert.equal(failed, undefined, 'a setup failure is not a channel failure');
  }
  assert.deepEqual(order, ['telegram-started', 'shutdown', 'telegram-stopped']);
  assert.match(setupError.message, /discord setup failed/u);
});

test('a scheduled result is delivered once, chunked, unthreaded and marked delivered', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('scheduled', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    // Establish durable admission evidence for this channel exactly as an owner message would.
    await harness.receive(guildMessage({ id: '301', content: `<@${BOT_ID}> hello` }));
    await until(() => harness.sent.length === 1, 'ordinary answer');
    const text = `${'a'.repeat(1_900)}\n\n${'b'.repeat(1_900)}`;
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-1:1', { text }));

    await until(() => harness.sent.length === 3, 'two scheduled chunks');
    assert.deepEqual(harness.texts().slice(1), splitDiscordText(text));
    assert.ok(harness.texts().slice(1).every((chunk) => chunk.length <= 2_000));
    assert.ok(harness.sent.slice(1).every((entry) => entry.replyToMessageId === undefined));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-1:1')?.status === 'delivered', 'delivered status');
    const record = (await outboxRecords(store.gateway, sessionKeys.channel)).find((entry) => entry.id === 'cron:job-1:1');
    assert.equal(record.nextChunkIndex, 2);
    assert.equal(record.sendIntent, undefined);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a result for a channel with no admission evidence is withheld, then released by a fresh admission', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('withheld', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-2:1'));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-2:1')?.status === 'withheld', 'withheld hold');
    assert.equal(harness.sent.length, 0);

    await harness.receive(guildMessage({ id: '311', content: `<@${BOT_ID}> hello again` }));
    await until(() => harness.sent.length === 2, 'ordinary answer plus released result');
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-2:1')?.status === 'delivered', 'released delivery');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a result is unauthorized when its original sender left the allowlist', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('unauthorized', { allowFrom: ['999'] });
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = {
      botId: BOT_ID, senderId: '777', kind: 'channel', admittedAtMs: Date.now(),
    };
  });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-3:1'));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-3:1')?.status === 'unauthorized', 'unauthorized status');
    assert.equal(harness.sent.length, 0);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('an ambiguous scheduled outcome is quarantined and never resent', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('scheduled-unknown', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await harness.receive(guildMessage({ id: '321', content: `<@${BOT_ID}> hello` }));
    await until(() => harness.sent.length === 1, 'ordinary answer');
    harness.state.nextSendFailure = new DiscordTransportError('dropped', { outcome: 'unknown' });
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-4:1'));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-4:1')?.status === 'unknown', 'unknown quarantine');
    const record = (await outboxRecords(store.gateway, sessionKeys.channel)).find((entry) => entry.id === 'cron:job-4:1');
    assert.ok(record.unknownSince > 0);
    assert.equal(record.sendIntent, undefined);

    // A later admission runs a full delivery after the quarantined record; the ambiguous result is
    // still never resent, which a positive ordering marker proves without a sleep.
    await harness.receive(guildMessage({ id: '322', content: `<@${BOT_ID}> later` }));
    await until(() => harness.sent.length === 2, 'later answer after the quarantine');
    assert.equal(harness.texts()[1], 'SYNTHETIC-REPLY');
    assert.equal(harness.texts().filter((text) => text === 'scheduled answer').length, 0,
      'the quarantined scheduled result was never sent');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a write-ahead intent left by a crash is quarantined on open and never sent', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('intent-recovery', {});
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
  });
  await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-5:1', {
    status: 'sending',
    sendIntent: { text: 'scheduled answer', chunkIndex: 0, startedAt: Date.now() },
  }));
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-5:1')?.status === 'unknown', 'quarantined intent');
    assert.equal(harness.sent.length, 0);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a partially delivered result resumes at its persisted chunk cursor', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('resume', {});
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
  });
  const text = `${'x'.repeat(1_900)}\n\n${'y'.repeat(1_900)}`;
  await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-6:1', { text, nextChunkIndex: 1 }));
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 1, 'remaining chunk');
    assert.equal(harness.sent[0].text, splitDiscordText(text)[1]);
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-6:1')?.status === 'delivered', 'delivered status');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a recorded interruption notice is delivered as ordinary host text', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('interruption', {});
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
  });
  // Recorded by the gateway's own startup recovery, in the origin chat's bounded outbox.
  const notice = turnInterruptionDelivery(sessionKeys.channel, 77, Date.now(), 'pi.generation', 'worker');
  await admitDelivery(store.gateway, sessionKeys.channel, notice);
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 1, 'interruption notice');
    assert.match(harness.sent[0].text, /^Background work was interrupted\./u);
    assert.equal(harness.sent[0].replyToMessageId, undefined);
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .every((record) => record.status === 'delivered'), 'notice delivered');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a replacement process confirms a recorded restart once per requesting channel', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('restart-live', {});
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
    doc.restart = [{ channelId: CHANNEL_ID, senderId: USER_ID }, { channelId: '6002', senderId: '888' }];
  });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 1, 'restart confirmation');
    assert.equal(harness.texts()[0], 'Restarted.');
    assert.equal(harness.sent[0].channelId, CHANNEL_ID);
    const state = await channelState(store.gateway);
    // A requesting sender the live allowlist no longer admits gets no notice and no owed record.
    assert.equal(state.restart, undefined);

    // A second open reports nothing new for the confirmed channel: the dropped record is the
    // positive marker that recovery ran, and no message was sent while it did.
    await adapter.stop();
    const second = syntheticTransport();
    const again = startDiscord(store, second, { streaming: false });
    try {
      await untilAsync(async () => (await channelState(store.gateway)).restart === undefined,
        'restart recovery to run on the second open');
      assert.equal(second.sent.length, 0);
    } finally {
      await again.stop();
    }
  } finally {
    await store.close();
  }
});

test('an admitted notice with a held acknowledgement survives a reopen as unconfirmed', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('held-notice', {});
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
    doc.pending.push({
      key: 'm:401', channelId: CHANNEL_ID, sessionKey: sessionKeys.channel, senderId: USER_ID,
      text: 'Model selected.', admittedAtMs: Date.now(), nextChunkIndex: 0, notice: true, hold: true,
    });
  });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 1, 'released held notice');
    assert.equal(harness.texts()[0], 'Command interrupted; outcome unknown. Send it again if needed.');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('an ordinary send persists its intent before the request and clears it only on acceptance', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('ordinal-intent', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    const gate = deferred();
    harness.state.sendGate = gate.promise;
    await harness.receive(guildMessage({ id: '601', content: `<@${BOT_ID}> answer me` }));
    await until(() => harness.state.inFlight === 1, 'an in-flight send');
    // The intent is durable while the request is still in flight: a crash right here is ambiguous.
    const inFlight = (await channelState(store.gateway)).pending.find((entry) => entry.key === 'm:601');
    assert.ok(inFlight !== undefined);
    assert.equal(inFlight.deliveryStatus, 'sending');
    assert.equal(inFlight.sendIntent.stage, 'final');
    assert.equal(inFlight.sendIntent.chunkIndex, 0);
    assert.equal(inFlight.sendIntent.text, 'SYNTHETIC-REPLY');

    gate.resolve();
    await until(() => harness.sent.length === 1, 'accepted answer');
    await untilAsync(async () => (await channelState(store.gateway)).pending.length === 0, 'intent cleared');
    assert.equal(harness.sent[0].text, 'SYNTHETIC-REPLY');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('an accepted-but-uncommitted ordinary send is quarantined on reopen and never repeated', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('ordinal-recovery', {});
  // The exact durable shape a crash between Discord accepting the message and the local commit leaves.
  await writeState(store, (doc) => {
    doc.origins[CHANNEL_ID] = { botId: BOT_ID, senderId: USER_ID, kind: 'channel', admittedAtMs: Date.now() };
    doc.pending.push({
      key: 'm:611',
      channelId: CHANNEL_ID,
      sessionKey: sessionKeys.channel,
      senderId: USER_ID,
      text: '[Alice (id=501)]: answer me',
      admittedAtMs: Date.now(),
      nextChunkIndex: 0,
      deliveryStatus: 'sending',
      sendIntent: { text: 'SYNTHETIC-REPLY', stage: 'final', chunkIndex: 0, startedAt: Date.now() },
    });
  });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await untilAsync(async () => (await channelState(store.gateway)).pending
      .some((entry) => entry.deliveryStatus === 'unknown'), 'quarantined intent');
    const record = (await channelState(store.gateway)).pending.find((entry) => entry.key === 'm:611');
    // The exact ambiguous attempt stays with the record as evidence; the status is what stops a resend.
    assert.equal(record.sendIntent.text, 'SYNTHETIC-REPLY');
    assert.equal(record.deliveryStatus, 'unknown');
    assert.ok(record.unknownSince > 0);
    // A later admission is a full delivery after recovery: the ambiguous answer is still unsent.
    await harness.receive(guildMessage({ id: '612', content: `<@${BOT_ID}> later` }));
    await until(() => harness.sent.length === 1, 'later answer');
    assert.equal(harness.sent[0].replyToMessageId, '612');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a plain status-carrying transport failure is classified without a wrapper class', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('plain-status', {});
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    // A proven 4xx refusal from the real client arrives as an error carrying a numeric status.
    harness.state.nextSendFailure = Object.assign(new Error('refused by Discord'), { status: 400 });
    await harness.receive(guildMessage({ id: '621', content: `<@${BOT_ID}> refused` }));
    await untilAsync(async () => (await channelState(store.gateway)).pending
      .some((entry) => entry.deliveryStatus === 'failed'), 'proven refusal held');
    assert.equal(harness.sent.length, 0);

    // A 5xx leaves the outcome ambiguous: quarantined, not retried.
    harness.state.nextSendFailure = Object.assign(new Error('gateway error'), { status: 502 });
    await harness.receive(guildMessage({ id: '622', content: `<@${BOT_ID}> maybe` }));
    await untilAsync(async () => (await channelState(store.gateway)).pending
      .some((entry) => entry.key === 'm:622' && entry.deliveryStatus === 'unknown'), 'ambiguous held');
    assert.equal(harness.sent.length, 0);
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a host notice longer than one message is delivered in bounded chunks with a cursor', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('notice-chunks', {});
  const notice = 'n'.repeat(4_500);
  await writeState(store, (doc) => {
    doc.pending.push({
      key: 'unconfirmed:m:901',
      channelId: CHANNEL_ID,
      sessionKey: sessionKeys.channel,
      senderId: USER_ID,
      text: notice,
      admittedAtMs: Date.now(),
      nextChunkIndex: 0,
      notice: true,
    });
  });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    await until(() => harness.sent.length === 3, 'three notice chunks');
    assert.ok(harness.texts().every((chunk) => chunk.length <= 2_000));
    assert.equal(harness.texts().join(''), notice);
    await untilAsync(async () => (await channelState(store.gateway)).pending.length === 0, 'notice settled');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('a channel removed from allowChannels loses MCP ownership and scheduled delivery', { timeout: 30_000 }, async () => {
  // A gateway opened from a file is the host shape that exposes owner MCP surfaces.
  const store = await openDiscordStore('policy-narrowing', { allowChannels: [CHANNEL_ID], configFile: true });
  const first = syntheticTransport();
  const firstAdapter = startDiscord(store, first, { streaming: false });
  try {
    await first.receive(guildMessage({ id: '631', content: `<@${BOT_ID}> hello` }));
    await until(() => first.sent.length === 1, 'first answer');
    // The live adapter owns the MCP surface for this authenticated channel.
    assert.ok(store.gateway.mcpSurfaces.surfaceFor(sessionKeys.channel) !== undefined);
  } finally {
    await firstAdapter.stop();
  }
  // The same store reopens with the channel no longer allowed: admission evidence alone is not authority.
  const narrowed = syntheticTransport();
  const narrowedAdapter = startDiscord(store, narrowed, { streaming: false, allowChannels: ['999'] });
  try {
    assert.equal(store.gateway.mcpSurfaces.surfaceFor(sessionKeys.channel), undefined);
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-7:1'));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-7:1')?.status === 'unauthorized', 'narrowed delivery refused');
    assert.equal(narrowed.sent.length, 0);
  } finally {
    await narrowedAdapter.stop();
    await store.close();
  }
});

test('the outbox leaves terminal records alone and never copies a malformed-outbox message into a fault', { timeout: 30_000 }, async () => {
  const { CronDeliveryOutboxError } = await import(new URL('../dist/automation/cron-delivery.js', import.meta.url).href);
  const { runDiscord } = await import(new URL('../dist/channels/discord.js', import.meta.url).href);
  const { withCancel } = await import('./fixtures/discord-harness.mjs');
  const store = await openDiscordStore('outbox-terminal', {});
  const real = store.gateway.cronOutbox;
  const faults = [];
  let failList = true;
  const cronOutbox = {
    sessions: (ctx) => real.sessions(ctx),
    async list(sessionKey, ctx) {
      if (failList && sessionKey === sessionKeys.channel) {
        failList = false;
        throw new CronDeliveryOutboxError('SYNTHETIC-PRIVATE-DETAIL');
      }
      return real.list(sessionKey, ctx);
    },
    update: (sessionKey, id, change, ctx) => real.update(sessionKey, id, change, ctx),
    async recordFault(sessionKey, message, ctx) {
      faults.push(message);
      await real.recordFault(sessionKey, message, ctx);
    },
  };
  const harness = syntheticTransport();
  const scope = withCancel(context);
  try {
    // A settled record without text is history, not a malformed pending delivery.
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:done:1', {
      status: 'delivered', text: '', settledAt: Date.now(),
    }));
    const adapter = runDiscord({ ...store.gateway, cronOutbox }, harness.transport, {
      allowFrom: [USER_ID], streaming: false,
    }, scope.context);
    await harness.receive(guildMessage({ id: '331', content: `<@${BOT_ID}> hello` }));
    await until(() => harness.sent.length === 1, 'ordinary answer');
    await admitDelivery(store.gateway, sessionKeys.channel, delivery('cron:job-9:1'));
    await untilAsync(async () => (await outboxRecords(store.gateway, sessionKeys.channel))
      .find((record) => record.id === 'cron:job-9:1')?.status === 'delivered', 'later delivery after the terminal one');
    const terminal = (await outboxRecords(store.gateway, sessionKeys.channel)).find((record) => record.id === 'cron:done:1');
    assert.equal(terminal.status, 'delivered');
    assert.equal(terminal.error, undefined);
    assert.deepEqual(faults, ['delivery outbox is malformed']);
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await store.close();
  }
});
