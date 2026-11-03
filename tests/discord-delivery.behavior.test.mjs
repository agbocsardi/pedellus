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

const { runChannels } = await import(new URL('../dist/cli.js', import.meta.url).href);
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

  // Both runs are created (and started) before the helper is awaited: it must never await one
  // channel before the other exists.
  const longRun = Promise.resolve().then(() => { order.push('long-started'); return long; });
  const failingRun = Promise.resolve().then(() => { order.push('failing-started'); throw failure; });

  const result = await runChannels([
    { stage: 'gateway.discord', run: longRun },
    { stage: 'gateway.telegram', run: failingRun },
  ], shutdown);
  assert.deepEqual(order.slice(0, 3), ['long-started', 'failing-started', 'shutdown']);
  assert.ok(order.includes('long-stopped'), 'the helper waited for the sibling to stop');
  assert.equal(result.stage, 'gateway.telegram');
  assert.equal(result.error, failure);
  assert.equal(shutdowns, 1);

  // A clean stop of every channel reports no failure.
  assert.equal(await runChannels([{ stage: 'gateway.discord', run: Promise.resolve() }], shutdown), undefined);
  assert.equal(shutdowns, 1);
  assert.equal(await runChannels([], shutdown), undefined);
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
    // The scan keeps running; a quarantined record is never sent again.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(harness.sent.length, 1);
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

    // A second open reports nothing new for the confirmed channel.
    await adapter.stop();
    const second = syntheticTransport();
    const again = startDiscord(store, second, { streaming: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
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
