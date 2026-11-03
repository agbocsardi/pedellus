// Discord owner controls: typed commands, the application-command menu, durable control records,
// restart confirmation/refusal and the fixed refusals of a narrow host.
//
// No bot, token, network, provider or live process: the transport is synthetic, the model is a faux
// provider over a temporary store, and the only restart exercised is an injected host callback.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOT_ID,
  CHANNEL_ID,
  USER_ID,
  channelState,
  guildMessage,
  openDiscordStore,
  sessionKeys,
  startDiscord,
  syntheticTransport,
  until,
  untilAsync,
} from './fixtures/discord-harness.mjs';

const PRESETS = {
  fast: { provider: 'fixture', modelId: 'alpha', thinkingLevel: 'off' },
  deep: { provider: 'fixture', modelId: 'beta', thinkingLevel: 'high' },
};

async function withAdapter(label, storeOptions, adapterOptions, body) {
  const store = await openDiscordStore(label, storeOptions);
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, adapterOptions);
  try {
    await body({ store, harness, adapter });
  } finally {
    await adapter.stop();
    await store.close();
  }
}

// In a mention-gated guild a typed command follows the mention (`@bot /status`); the adapter strips
// exactly that one leading self-mention before it parses the command.
const say = (id, content, extra = {}) => guildMessage({ id, content: `<@${BOT_ID}> ${content}`, ...extra });

test('/help lists exactly the offered controls and names another surface for the rest', { timeout: 30_000 }, async () => {
  await withAdapter('help', {}, { streaming: false }, async ({ harness }) => {
    await harness.receive(guildMessage({ id: '201', content: `<@${BOT_ID}> /help` }));
    await until(() => harness.sent.length === 1, 'help listing');
    const help = harness.texts()[0];
    assert.match(help, /^Controls for this channel \(other messages go to the assistant\):$/mu);
    assert.match(help, /^\/new — Start a fresh context for this conversation$/mu);
    assert.match(help, /^\/model \[preset\] — List or select a model for this conversation$/mu);
    assert.match(help, /^Not offered by this host: \/mcp, \/restart\.$/mu);
    assert.match(help, /^\/help \[command\] — Show these controls, or one command's detail$/mu);
    assert.ok(!help.includes('/history'), 'a CLI-only command must not be advertised on Discord');
    assert.match(help, /\/\/ sends a leading slash literally/u);

    await harness.receive(say('202', '/help history'));
    await until(() => harness.sent.length === 2, 'help detail refusal');
    assert.match(harness.texts()[1], /\/history is only available in the terminal/u);

    await harness.receive(say('203', '/help status'));
    await until(() => harness.sent.length === 3, 'help detail');
    assert.match(harness.texts()[2], /^Usage: \/status$/mu);

    // `//text` stays ordinary assistant input with its leading slash intact.
    await harness.receive(guildMessage({ id: '204', content: `<@${BOT_ID}> //not a command`, mentions: [] }));
    await until(() => harness.sent.length === 4, 'literal slash answer');
    assert.equal(harness.sent.length, 4);
  });
});

test('/status is read only and /model lists then refuses without configured presets', { timeout: 30_000 }, async () => {
  await withAdapter('status', {}, { streaming: false }, async ({ harness, store }) => {
    await harness.receive(say('211', '/status'));
    await until(() => harness.sent.length === 1, 'status notice');
    const status = harness.texts()[0];
    assert.match(status, /^Status for this channel \(no model call, no configuration change\):$/mu);
    assert.match(status, /^Model: fixture\/alpha \(thinking: off\)$/mu);
    assert.match(status, /^Run: idle$/mu);
    assert.match(status, /^Queued native inputs: 0$/mu);
    assert.equal(store.captured.length, 0, 'a status command must not call the model');

    await harness.receive(say('212', '/model'));
    await until(() => harness.sent.length === 2, 'model listing');
    assert.match(harness.texts()[1], /^Current model: fixture\/alpha \(thinking: off\)\.$/mu);
    assert.match(harness.texts()[1], /Named model presets are not configured in this deployment/u);

    await harness.receive(say('213', '/model deep'));
    await until(() => harness.sent.length === 3, 'preset refusal');
    assert.match(harness.texts()[2], /Named model presets are not configured/u);
    assert.equal(store.captured.length, 0);

    await harness.receive(say('214', '/model one two'));
    await until(() => harness.sent.length === 4, 'model usage');
    assert.match(harness.texts()[3], /^Usage: \/model \(list the configured presets\)/mu);
  });
});

test('/model selects one configured preset for this channel only', { timeout: 30_000 }, async () => {
  await withAdapter('preset', { presets: PRESETS, digest: false }, { streaming: false }, async ({ harness, store }) => {
    await harness.receive(say('221', '/model'));
    await until(() => harness.sent.length === 1, 'preset listing');
    assert.match(harness.texts()[0], /\* fast — fixture alpha \[thinking: off\] \(default\)/u);

    await harness.receive(say('222', '/model deep'));
    await until(() => harness.sent.length === 2, 'preset applied');
    assert.equal(harness.texts()[1], 'Model set to fixture/beta (thinking: high) for this chat.');
    const state = await channelState(store.gateway);
    assert.equal(state.controls.at(-1).command, 'model');
    assert.equal(state.controls.at(-1).status, 'applied');
    assert.deepEqual(state.pending, []);

    // Only the finite configured catalog may be selected.
    await harness.receive(say('223', '/model not-a-preset'));
    await until(() => harness.sent.length === 3, 'unknown preset refusal');
    assert.match(harness.texts()[2], /^Unknown model preset not-a-preset: nothing was changed\./u);
  });
});

test('/new resets this channel and /abort ends a live turn without a failure notice', { timeout: 30_000 }, async () => {
  await withAdapter('mutations', {}, { streaming: false }, async ({ harness, store }) => {
    await harness.receive(say('231', '/new'));
    await until(() => harness.sent.length === 1, 'reset ack');
    assert.equal(harness.texts()[0], 'Context reset.');
    assert.equal((await channelState(store.gateway)).controls.at(-1).status, 'applied');

    // A held turn, then /abort: the command answers and the aborted turn reports nothing. The faux
    // provider ignores the abort signal, so the test releases it once the command was admitted.
    const entered = store.gate.hold();
    await harness.receive(guildMessage({ id: '232', content: `<@${BOT_ID}> long task` }));
    await entered;
    await harness.receive(say('233', '/abort'));
    store.gate.release();
    await until(() => harness.sent.length === 2, 'abort ack');
    assert.equal(harness.texts()[1], 'Idle. Queue cleared.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.sent.length, 2, 'an aborted turn must not send a failure notice');
    assert.deepEqual((await channelState(store.gateway)).pending, []);
  });
});

test('/digest reports a bounded status and /mcp refuses honestly without a management host', { timeout: 30_000 }, async () => {
  await withAdapter('digest', {}, { streaming: false }, async ({ harness }) => {
    await harness.receive(say('241', '/digest status'));
    await until(() => harness.sent.length === 1, 'digest status');
    assert.match(harness.texts()[0], /digest|Digest/u);

    await harness.receive(say('242', '/digest now'));
    await until(() => harness.sent.length === 2, 'digest usage');
    assert.match(harness.texts()[1], /^Usage: \/digest \[status\]/u);

    await harness.receive(say('243', '/mcp'));
    await until(() => harness.sent.length === 3, 'mcp refusal');
    assert.match(harness.texts()[2], /MCP management is unavailable in this host/u);
  });

  await withAdapter('digest-start', { digest: true }, { streaming: false }, async ({ harness }) => {
    await harness.receive(say('244', '/digest'));
    await until(() => harness.sent.length === 1, 'digest start ack');
    assert.match(harness.texts()[0], /Digest/u);
  });
});

test('/restart asks the host once, reports a second request, and reports a busy refusal', { timeout: 30_000 }, async () => {
  const restartAt = [];
  const accepted = await openDiscordStore('restart-host', {});
  const acceptedHarness = syntheticTransport();
  const acceptedAdapter = startDiscord(accepted, acceptedHarness, {
    streaming: false,
    restart: { supported: true, request: async () => { restartAt.push(Date.now()); } },
  });
  try {
    await acceptedHarness.receive(say('251', '/restart'));
    await until(() => acceptedHarness.sent.length === 1, 'restart ack');
    assert.equal(acceptedHarness.texts()[0], 'Restart requested; checking active work.');
    await until(() => restartAt.length === 1, 'host restart request');
    await acceptedHarness.receive(say('252', '/restart'));
    await until(() => acceptedHarness.sent.length === 2, 'second restart answer');
    assert.match(acceptedHarness.texts()[1], /A restart was already requested/u);
    assert.equal(restartAt.length, 1, 'the host is asked at most once');
    // The durable record names the chat that is owed the confirmation once the replacement is live.
    const state = await channelState(accepted.gateway);
    assert.deepEqual(state.restart, [{ channelId: CHANNEL_ID, senderId: USER_ID }]);
  } finally {
    await acceptedAdapter.stop();
    await accepted.close();
  }

  // A host refusal is a known no-effect: it is reported, and the owner may ask again later.
  const refused = await openDiscordStore('restart-busy', {});
  const refusedHarness = syntheticTransport();
  let requests = 0;
  const refusedAdapter = startDiscord(refused, refusedHarness, {
    streaming: false,
    restart: {
      supported: true,
      request: async () => {
        requests += 1;
        const { RestartBusyError } = await import(new URL('../dist/restart.js', import.meta.url).href);
        throw new RestartBusyError('live work');
      },
    },
  });
  try {
    await refusedHarness.receive(say('253', '/restart'));
    await until(() => refusedHarness.sent.length === 2, 'ack plus busy refusal');
    assert.equal(refusedHarness.texts()[0], 'Restart requested; checking active work.');
    assert.match(refusedHarness.texts()[1], /restart refused/iu);
    assert.deepEqual((await channelState(refused.gateway)).restart, undefined);
    // The refusal did not latch: a later request reaches the host again.
    await refusedHarness.receive(say('254', '/restart'));
    await until(() => requests === 2, 'a retry after the refusal');
  } finally {
    await refusedAdapter.stop();
    await refused.close();
  }
});

test('a slash command is acknowledged immediately and answers through the durable queue', { timeout: 30_000 }, async () => {
  await withAdapter('slash', {}, { streaming: false }, async ({ harness, store }) => {
    const response = await harness.interact({
      id: '900001',
      channelId: CHANNEL_ID,
      channelKind: 'channel',
      guildId: '9001',
      userId: USER_ID,
      userName: 'Alice',
      userIsBot: false,
      commandName: 'status',
    });
    assert.deepEqual(response, { text: 'Processing /status…', ephemeral: true });
    await until(() => harness.sent.length === 1, 'slash status notice');
    assert.match(harness.texts()[0], /^Status for this channel/u);

    // A mutation is recorded before its effect, so a repeated interaction reports it instead of
    // running it twice.
    const reset = await harness.interact({
      id: '900010',
      channelId: CHANNEL_ID,
      channelKind: 'channel',
      guildId: '9001',
      userId: USER_ID,
      userName: 'Alice',
      userIsBot: false,
      commandName: 'new',
    });
    assert.deepEqual(reset, { text: 'Processing /new…', ephemeral: true });
    await until(() => harness.sent.length === 2, 'interaction reset ack');
    assert.equal(harness.texts()[1], 'Context reset.');
    const replay = await harness.interact({
      id: '900010',
      channelId: CHANNEL_ID,
      channelKind: 'channel',
      guildId: '9001',
      userId: USER_ID,
      userName: 'Alice',
      userIsBot: false,
      commandName: 'new',
    });
    assert.equal(replay.ephemeral, true);
    await until(() => harness.sent.length === 3, 'replayed interaction');
    assert.match(harness.texts()[2], /already applied|already requested before this process/u);
    assert.deepEqual((await channelState(store.gateway)).pending, []);

    // The registered menu is exactly the offered catalogue, in catalogue order.
    assert.equal(harness.registered.length, 1);
    assert.deepEqual(harness.registered[0].map((command) => command.name),
      ['new', 'abort', 'stop', 'status', 'model', 'digest', 'help']);
    assert.deepEqual(harness.registered[0].find((command) => command.name === 'model').option,
      { name: 'preset', description: 'Optional configured model preset name.' });

    // A repeated interaction is reported, not applied twice.

  });
});

test('a slash command from an unlisted user or channel is refused without a durable record', { timeout: 30_000 }, async () => {
  await withAdapter('slash-policy', { allowChannels: ['999'] }, { streaming: false }, async ({ harness, store }) => {
    const wrongUser = await harness.interact({
      id: '900002', channelId: CHANNEL_ID, channelKind: 'channel', guildId: '9001',
      userId: '999', userName: 'Mallory', userIsBot: false, commandName: 'new',
    });
    assert.deepEqual(wrongUser, { text: 'You are not allowed to use this bot.', ephemeral: true });

    const wrongChannel = await harness.interact({
      id: '900003', channelId: CHANNEL_ID, channelKind: 'channel', guildId: '9001',
      userId: USER_ID, userName: 'Alice', userIsBot: false, commandName: 'new',
    });
    assert.deepEqual(wrongChannel, { text: 'This channel is not allowed for this bot.', ephemeral: true });
    assert.deepEqual((await channelState(store.gateway)).controls, []);
  });
});

test('an interrupted control is reported once as unconfirmed on reopen and never replayed', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('unconfirmed', {});
  let harness = syntheticTransport();
  let adapter = startDiscord(store, harness, { streaming: false });
  try {
    await harness.receive(say('261', '/new'));
    await until(() => harness.sent.length === 1, 'reset ack');
  } finally {
    await adapter.stop();
  }

  // Record a command that was admitted but never confirmed, as a crash between admission and effect leaves it.
  const { DiscordState } = await import(new URL('../dist/channels/discord.js', import.meta.url).href);
  const conversation = await store.gateway.conversationFor(`discord:${BOT_ID}:channel-state`, (await import('./fixtures/discord-harness.mjs')).context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(DiscordState, conversation.id);
    doc.controls.push({ key: 'm:262', command: 'abort', status: 'admitted', channelId: CHANNEL_ID, senderId: USER_ID });
    doc.pending.push({
      key: 'm:262', channelId: CHANNEL_ID, sessionKey: sessionKeys.channel, senderId: USER_ID,
      text: 'Idle. Queue cleared.', admittedAtMs: Date.now(), nextChunkIndex: 0, notice: true, hold: true,
    });
    return undefined;
  }, (await import('./fixtures/discord-harness.mjs')).context);

  harness = syntheticTransport();
  adapter = startDiscord(store, harness, { streaming: false });
  try {
    await untilAsync(async () => harness.sent.length === 1, 'unconfirmed report');
    assert.equal(harness.sent[0].text, 'Command interrupted; outcome unknown. Send it again if needed.');
    const state = await channelState(store.gateway);
    // The interrupted record is reported and pruned with its notice: nothing stays unresolved.
    assert.deepEqual(state.pending, []);
    assert.equal(state.controls.some((entry) => entry.status === 'admitted'), false);
  } finally {
    await adapter.stop();
    await store.close();
  }
});
