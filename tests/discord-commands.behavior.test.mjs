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
  context,
  deferred,
  dmMessage,
  flush,
  guildMessage,
  openDiscordStore,
  runDiscord,
  sessionKeys,
  startDiscord,
  syntheticTransport,
  until,
  untilAsync,
  withCancel,
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
    assert.equal(harness.texts()[1], 'Model set to preset deep: fixture/beta (thinking: high) for this channel.');
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
    // The aborted turn's record retiring is the positive marker: it would have sent its notice first.
    await untilAsync(async () => (await channelState(store.gateway)).pending.length === 0, 'aborted delivery retired');
    assert.equal(harness.sent.length, 2, 'an aborted turn must not send a failure notice');
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

/**
 * A gateway whose `conversationFor` fails a bounded number of times for one session key, so a
 * transient failure while placing an admitted input is exercised through the real adapter path.
 */
function flakyGateway(gateway, sessionKey, failures) {
  let remaining = failures;
  return {
    ...gateway,
    async conversationFor(key, ctx) {
      if (key === sessionKey && remaining > 0) {
        remaining -= 1;
        throw new Error('synthetic transient conversation failure');
      }
      return gateway.conversationFor(key, ctx);
    },
  };
}

async function withFlakyHost(label, failures, body) {
  const store = await openDiscordStore(label, {});
  const harness = syntheticTransport();
  const scope = withCancel(context);
  const adapter = runDiscord(flakyGateway(store.gateway, sessionKeys.channel, failures), harness.transport, {
    allowFrom: [USER_ID],
    streaming: false,
  }, scope.context);
  try {
    await body({ store, harness });
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
}

test('a deferred control retries on the adapter cadence and releases the channel when it settles', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  // Three transient failures: the first message's best-effort question-answer lookup at admission,
  // its own delivery, and the control's first flush attempt.
  const store = await openDiscordStore('deferred-applied', {});
  const harness = syntheticTransport();
  const scope = withCancel(context);
  const adapter = runDiscord(flakyGateway(store.gateway, sessionKeys.channel, 3), harness.transport, {
    allowFrom: [USER_ID],
    streaming: false,
  }, scope.context);
  try {
    await harness.receive(guildMessage({ id: '701', content: `<@${BOT_ID}> first` }));
    await harness.receive(say('702', '/abort'));
    await untilAsync(async () => harness.texts().includes('Still stopping. New messages are held.'), 'deferred acknowledgement');
    // The command is still admitted and the channel stays gated: nothing overtakes it.
    assert.equal((await channelState(store.gateway)).controls.at(-1).status, 'admitted');
    await harness.receive(guildMessage({ id: '703', content: `<@${BOT_ID}> must wait` }));
    assert.equal(harness.sent.filter((entry) => entry.text === 'SYNTHETIC-REPLY').length, 0);

    // One scan cadence later the retry places the earlier input and applies the command.
    for (let elapsed = 0; elapsed < 20_000; elapsed += 2_000) {
      t.mock.timers.tick(2_000);
      await flush(6);
      const state = await channelState(store.gateway);
      if (state.controls.at(-1).status !== 'admitted') break;
    }
    const state = await channelState(store.gateway);
    assert.equal(state.controls.at(-1).status, 'applied');
    // Exactly one final outcome follows the pending wording; the mutation was not repeated.
    assert.equal(harness.texts().filter((text) => text === 'Idle. Queue cleared.').length, 1);
    // The gate is released: the message admitted during the deferral is answered on its own turn.
    await until(() => harness.sent.filter((entry) => entry.text === 'SYNTHETIC-REPLY').length >= 1, 'channel unblocked');
    assert.deepEqual((await channelState(store.gateway)).pending.filter((entry) => entry.notice !== true), []);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
});

test('an exhausted deferred control is reported unconfirmed once and never applied', { timeout: 40_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  await withFlakyHost('deferred-exhausted', Number.MAX_SAFE_INTEGER, async ({ store, harness }) => {
    await harness.receive(guildMessage({ id: '711', content: `<@${BOT_ID}> first` }));
    await harness.receive(say('712', '/new'));
    await untilAsync(async () => harness.texts().includes('Reset pending.'), 'deferred acknowledgement');
    for (let elapsed = 0; elapsed < 40_000; elapsed += 2_000) {
      t.mock.timers.tick(2_000);
      await flush(4);
      if (harness.texts().some((text) => /Command interrupted; outcome unknown/u.test(text))) break;
    }
    assert.ok(harness.texts().some((text) => /Command interrupted; outcome unknown/u.test(text)),
      'the exhausted command is reported once instead of staying silently pending');
    assert.ok(harness.texts().every((text) => text !== 'Context reset.'), 'a reset that never ran is not claimed');
    const state = await channelState(store.gateway);
    // Reported and settled: no record is left admitted (a delivered report also retires it).
    assert.equal(state.controls.some((entry) => entry.status === 'admitted'), false);
    assert.equal(state.pending.some((entry) => entry.notice === true && entry.hold === true), false,
      'no acknowledgement is left held after the terminal report');
  });
});

test('a callback-shaped message is consumed before admission, mention-prefixed or bare', { timeout: 30_000 }, async () => {
  const CODE = 'SECRET-AUTH-CODE-9182';
  const STATE = 'SECRET-AUTH-STATE-4711';
  const link = `https://127.0.0.1:1/oauth/callback?code=${CODE}&state=${STATE}`;
  const store = await openDiscordStore('callback', { configFile: true, allowFrom: [USER_ID, '777'] });
  const harness = syntheticTransport();
  const adapter = startDiscord(store, harness, { streaming: false });
  try {
    // One ordinary message first: it records the channel's authenticated sender.
    await harness.receive(guildMessage({ id: '801', content: `<@${BOT_ID}> hello` }));
    await until(() => harness.sent.length === 1, 'ordinary answer');
    const capturedBefore = store.captured.length;

    // Mention-prefixed: in a mention-gated guild the callback follows the mention.
    await harness.receive(guildMessage({ id: '802', content: `<@${BOT_ID}> ${link}` }));
    await until(() => harness.sent.length === 2, 'callback notice');
    assert.match(harness.texts()[1], /OAuth callback was not accepted|did not come from|No MCP login/u);

    // Bare callback in a direct message: still intercepted before any transcript admission.
    await harness.receive(dmMessage({ id: '803', content: link }));
    await until(() => harness.sent.length === 3, 'bare callback notice');

    // A foreign sender in the same channel: refused with fixed text, never forwarded.
    await harness.receive(guildMessage({ id: '804', authorId: '777', authorName: 'Bob', content: `<@${BOT_ID}> ${link}` }));
    await until(() => harness.sent.length === 4, 'foreign callback notice');
    assert.match(harness.texts()[3], /did not come from the authenticated sender/u);

    assert.equal(store.captured.length, capturedBefore, 'a callback never becomes a model turn');
    for (const text of harness.texts()) assert.ok(!text.includes(CODE) && !text.includes(STATE));
    for (const request of store.captured) {
      assert.ok(!JSON.stringify(request.messages).includes(CODE));
      assert.ok(!JSON.stringify(request.messages).includes(STATE));
    }
    const persisted = JSON.stringify(await channelState(store.gateway));
    assert.ok(!persisted.includes(CODE) && !persisted.includes(STATE), 'no callback secret is stored in channel state');
  } finally {
    await adapter.stop();
    await store.close();
  }
});

test('an exhausted deferred /restart is reported with the restart wording and never requested', { timeout: 40_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const store = await openDiscordStore('deferred-restart', {});
  const harness = syntheticTransport();
  const scope = withCancel(context);
  let requests = 0;
  const adapter = runDiscord(flakyGateway(store.gateway, sessionKeys.channel, Number.MAX_SAFE_INTEGER), harness.transport, {
    allowFrom: [USER_ID],
    streaming: false,
    restart: { supported: true, request: async () => { requests += 1; } },
  }, scope.context);
  try {
    await harness.receive(guildMessage({ id: '721', content: `<@${BOT_ID}> first` }));
    await harness.receive(say('722', '/restart'));
    await untilAsync(async () => harness.texts().includes('Restart pending.'), 'deferred acknowledgement');
    for (let elapsed = 0; elapsed < 40_000; elapsed += 2_000) {
      t.mock.timers.tick(2_000);
      await flush(4);
      if (harness.texts().some((text) => /interrupted; outcome unknown/u.test(text))) break;
    }
    assert.ok(harness.texts().includes('Restart interrupted; outcome unknown. Not retried.'));
    assert.ok(harness.texts().every((text) => !/^Command interrupted/u.test(text)), 'generic wording for a restart');
    assert.equal(requests, 0, 'an unconfirmed restart is never requested');
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
});

test('reopen turns a released but unsent pending wording into the outcome, and keeps an in-flight one', { timeout: 30_000 }, async () => {
  const store = await openDiscordStore('stale-pending', {});
  try {
    const { DiscordState } = await import(new URL('../dist/channels/discord.js', import.meta.url).href);
    const conversation = await store.gateway.conversationFor(`discord:${BOT_ID}:channel-state`, context);
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(DiscordState, conversation.id);
      const notice = (key, extra = {}) => ({
        key, channelId: CHANNEL_ID, sessionKey: sessionKeys.channel, senderId: USER_ID,
        text: 'Restart pending.', admittedAtMs: Date.now(), nextChunkIndex: 0, notice: true, ...extra,
      });
      doc.controls.push({ key: 'm:271', command: 'restart', status: 'admitted', channelId: CHANNEL_ID, senderId: USER_ID });
      doc.controls.push({ key: 'm:272', command: 'restart', status: 'admitted', channelId: CHANNEL_ID, senderId: USER_ID });
      doc.pending.push(notice('m:271'));
      doc.pending.push(notice('m:272', {
        deliveryStatus: 'sending',
        sendIntent: { text: 'Restart pending.', stage: 'final', chunkIndex: 0, startedAt: Date.now() },
      }));
      return undefined;
    }, context);
    const harness = syntheticTransport();
    const adapter = startDiscord(store, harness, { streaming: false });
    try {
      await until(() => harness.sent.length === 2, 'two outcome notices');
      assert.deepEqual(harness.texts(), [
        'Restart interrupted; outcome unknown. Not retried.',
        'Restart interrupted; outcome unknown. Not retried.',
      ]);
      const state = await channelState(store.gateway);
      // The ambiguous send is quarantined, never resent, and its outcome went out separately.
      const held = state.pending.find((entry) => entry.key === 'm:272');
      assert.equal(held?.deliveryStatus, 'unknown');
      assert.equal(state.controls.some((entry) => entry.status === 'admitted'), false);
    } finally {
      await adapter.stop();
    }
  } finally {
    await store.close();
  }
});

/** A bounded wait that does not read the clock, for checks that mock `Date`. */
async function settleUntil(predicate, label, rounds = 5_000) {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return;
    await flush(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('a late control outcome is a separate notice when its pending wording is already being sent', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const store = await openDiscordStore('late-in-flight', {});
  const harness = syntheticTransport();
  const scope = withCancel(context);
  // A slow native reset outlives the pending-notice delay.
  const slowReset = deferred();
  let resetStarted = false;
  const gateway = {
    ...store.gateway,
    async resetSession(key, ctx) {
      resetStarted = true;
      await slowReset.promise;
      return store.gateway.resetSession(key, ctx);
    },
  };
  const adapter = runDiscord(gateway, harness.transport, { allowFrom: [USER_ID], streaming: false }, scope.context);
  try {
    const held = deferred();
    harness.state.sendGate = held.promise;
    await harness.receive(say('732', '/new'));
    await settleUntil(() => resetStarted, 'native reset running');
    t.mock.timers.tick(30_000);
    await settleUntil(() => harness.state.inFlight === 1, '"still pending" wording in flight');
    slowReset.resolve();
    // The outcome goes out on its own while the pending wording is still held in its send.
    await settleUntil(() => harness.texts().includes('Context reset.'), 'late outcome sent as its own notice');
    assert.equal(harness.state.inFlight, 1);
    held.resolve();
    await settleUntil(() => harness.texts().includes('Reset pending.'), 'pending wording finished');
    assert.deepEqual([...harness.texts()].sort(), ['Context reset.', 'Reset pending.']);
  } finally {
    scope.cancel(new DOMException('test finished', 'AbortError'));
    await adapter.catch(() => undefined);
    await store.close();
  }
});
