// The real discord.js transport's own mapping, driven through an injected synthetic client.
//
// No token, network, live guild or SDK connection: discord.js is imported for its real constants and
// error-free type surface, while the client is a synthetic object. This exercises the code the
// synthetic *adapter* transport never touches: Gateway event mapping (guild/thread/DM, system types,
// reply metadata, attachments), application-command interactions and their ephemeral flags, and the
// status-derived failure classification the adapter relies on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOT_ID, CHANNEL_ID, context, until } from './fixtures/discord-harness.mjs';

const { createDiscordJsTransport } = await import(
  new URL('../dist/channels/discord-js.js', import.meta.url).href
);
const discord = await import('discord.js');

const GUILD_ID = '9001';
const THREAD_ID = '7001';
const DM_CHANNEL_ID = '8001';
const OTHER_USER = '777';

/** A Collection-like wrapper: discord.js exposes `.map`, `.size` and `.get` on these. */
function collection(items) {
  return {
    size: items.length,
    map(fn) { return items.map(fn); },
    get(key) { return items.find((item) => item.id === key); },
  };
}

function rawChannel(over = {}) {
  return {
    name: over.name ?? 'general',
    parentId: over.parentId ?? null,
    isThread: () => over.kind === 'thread',
    isDMBased: () => over.kind === 'dm',
    send: async (payload) => {
      if (over.sendError !== undefined) throw over.sendError;
      return { id: over.messageId ?? '5000', payload };
    },
    sendTyping: async () => undefined,
    messages: {
      fetch: async (id) => {
        if (over.fetchError !== undefined) throw over.fetchError;
        return rawMessage({ id, content: over.fetchedText ?? `quoted ${id}` });
      },
      edit: async (id, payload) => {
        if (over.editError !== undefined) throw over.editError;
        return { id, payload };
      },
    },
  };
}

function rawMessage(over = {}) {
  const author = {
    id: over.authorId ?? OTHER_USER,
    username: over.username ?? 'alice',
    displayName: over.displayName ?? 'Alice',
    bot: over.authorIsBot ?? false,
  };
  const mentionsUsers = (over.mentions ?? []).map((mention) => ({
    id: mention.id,
    username: mention.name,
    displayName: mention.name,
  }));
  return {
    id: over.id ?? '1001',
    channelId: over.channelId ?? CHANNEL_ID,
    guildId: 'guildId' in over ? over.guildId : GUILD_ID,
    partial: over.partial ?? false,
    content: over.content ?? 'hello',
    type: over.type ?? discord.MessageType.Default,
    author,
    member: { displayName: over.memberName ?? 'Alice (member)' },
    mentions: {
      users: collection(mentionsUsers),
      members: collection(mentionsUsers.map((user) => ({ id: user.id, displayName: `${user.displayName} (member)` }))),
      everyone: false,
      repliedUser: over.repliedUser ?? null,
    },
    reference: over.reference ?? null,
    attachments: collection((over.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      contentType: attachment.contentType ?? null,
      url: attachment.url,
    }))),
    channel: over.channel ?? rawChannel(),
    react: async (emoji) => ({ emoji }),
    reactions: { resolve: () => over.reaction ?? null },
  };
}

/** A synthetic discord.js client: records listeners, lets the test emit events. */
function fakeClient(options = {}) {
  const handlers = new Map();
  const registered = [];
  const record = {
    loggedInWith: undefined,
    destroyed: false,
    client: undefined,
  };
  const emit = (event, payload) => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
  };
  const client = {
    user: options.user ?? null,
    application: options.application ?? {
      commands: {
        set: async (commands) => {
          if (options.registerFailure === true) throw new Error('missing applications.commands scope');
          registered.push(commands);
          return new Map(commands.map((command) => [command.name, {}]));
        },
      },
    },
    channels: {
      cache: { get: (id) => (options.channels ?? new Map()).get(id) },
      fetch: async (id) => {
        const channel = (options.channels ?? new Map()).get(id);
        if (channel === undefined) throw Object.assign(new Error('unknown channel'), { status: 404 });
        return channel;
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return client;
    },
    once(event, handler) {
      const wrapped = (payload) => {
        client.off(event, wrapped);
        handler(payload);
      };
      return client.on(event, wrapped);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return client;
    },
    removeAllListeners() {
      handlers.clear();
      return client;
    },
    async login(token) {
      record.loggedInWith = token;
      client.user = options.user ?? { id: BOT_ID, username: 'synthetic_bot' };
      emit(discord.Events.ClientReady, client);
      return 'ok';
    },
    async destroy() {
      record.destroyed = true;
    },
  };
  record.client = client;
  return { client, record, emit, registered };
}

test('the transport maps Gateway messages, reply metadata and attachments without a live client', { timeout: 15_000 }, async () => {
  const fake = fakeClient();
  let factoryRequest;
  const transport = createDiscordJsTransport({
    token: 'synthetic-token',
    createClient: (request) => {
      factoryRequest = request;
      return fake.client;
    },
  });
  await transport.start(context);
  try {
    assert.equal(transport.botId, BOT_ID);
    assert.equal(transport.botName, 'synthetic_bot');
    // The client really asks for the privileged content intent and the DM channel partial.
    assert.equal((factoryRequest.intents & discord.GatewayIntentBits.MessageContent) !== 0, true);
    assert.equal((factoryRequest.intents & discord.GatewayIntentBits.DirectMessages) !== 0, true);
    assert.deepEqual(factoryRequest.partials, [discord.Partials.Channel]);

    const seen = [];
    transport.onMessage((message) => seen.push(message));
    fake.emit(discord.Events.MessageCreate, rawMessage({
      content: '<@4242> and <@777> look',
      mentions: [{ id: BOT_ID, name: 'synthetic_bot' }, { id: OTHER_USER, name: 'bob' }],
      repliedUser: { id: OTHER_USER, username: 'bob', bot: false },
      reference: { messageId: '1000' },
      attachments: [{ id: 'a1', name: 'shot.png', size: 12, contentType: 'image/png', url: 'https://cdn.example/shot.png' }],
    }));
    await until(() => seen.length === 1, 'one mapped message');
    const message = seen[0];
    assert.equal(message.channelKind, 'channel');
    assert.equal(message.guildId, GUILD_ID);
    assert.equal(message.authorId, OTHER_USER);
    assert.equal(message.authorName, 'Alice (member)');
    assert.equal(message.system, false);
    assert.deepEqual(message.mentions.map((mention) => [mention.id, mention.name]),
      [[BOT_ID, 'synthetic_bot (member)'], [OTHER_USER, 'bob (member)']]);
    // A reply maps its target and replied-user metadata without an extra request.
    assert.deepEqual(message.reply, { messageId: '1000', authorId: OTHER_USER, authorIsBot: false });
    assert.equal(message.quoted, undefined);
    assert.deepEqual(message.attachments, [{
      id: 'a1', filename: 'shot.png', sizeBytes: 12, contentType: 'image/png', url: 'https://cdn.example/shot.png',
    }]);

    // Threads and DMs keep their own placement and parent.
    fake.emit(discord.Events.MessageCreate, rawMessage({
      id: '1002', channelId: THREAD_ID, type: discord.MessageType.Reply,
      channel: rawChannel({ kind: 'thread', parentId: CHANNEL_ID, name: 'topic' }),
    }));
    fake.emit(discord.Events.MessageCreate, rawMessage({
      id: '1003', channelId: DM_CHANNEL_ID, guildId: null,
      channel: rawChannel({ kind: 'dm', name: undefined }),
    }));
    // A Discord system event is mapped with `system: true` so the adapter can refuse it, and a
    // partial event is dropped by the transport itself.
    // Type 7 is a Discord system message (a member joined); it carries no conversational prompt.
    fake.emit(discord.Events.MessageCreate, rawMessage({ id: '1004', type: 7 }));
    fake.emit(discord.Events.MessageCreate, rawMessage({ id: '1005', partial: true }));
    await until(() => seen.length >= 4, 'thread, DM and system mapping');
    assert.equal(seen[1].channelKind, 'thread');
    assert.equal(seen[1].parentChannelId, CHANNEL_ID);
    assert.equal(seen[1].system, false);
    assert.equal(seen[2].channelKind, 'dm');
    assert.equal(seen[2].guildId, undefined);
    assert.equal(seen.some((message) => message.id === '1004' && message.system === true), true,
      'a system event is labeled so the adapter refuses it');
    assert.equal(seen.some((message) => message.id === '1005'), false, 'a partial event is dropped');
  } finally {
    await transport.stop();
    assert.equal(fake.record.destroyed, true);
  }
});

test('the transport answers application commands with the current ephemeral flag', { timeout: 15_000 }, async () => {
  const replies = [];
  const fake = fakeClient();
  const interactionClient = {
    ...fake.client,
    user: { id: BOT_ID, username: 'synthetic_bot' },
  };
  const transport = createDiscordJsTransport({
    token: 'synthetic-token',
    createClient: () => interactionClient,
  });
  await transport.start(context);
  try {
    const seen = [];
    transport.onInteraction((interaction) => {
      seen.push(interaction);
      return { text: `Processing /${interaction.commandName}…`, ephemeral: true };
    });
    const interaction = {
      id: '900010',
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      channel: rawChannel(),
      user: { id: OTHER_USER, username: 'alice', bot: false },
      commandName: 'model',
      isChatInputCommand: () => true,
      isRepliable: () => true,
      options: { getString: () => 'deep' },
      reply: async (payload) => { replies.push(payload); },
    };
    fake.emit(discord.Events.InteractionCreate, interaction);
    await until(() => replies.length === 1, 'command acknowledgement');
    assert.equal(replies[0].content, 'Processing /model…');
    // The current API replaces the deprecated `ephemeral: true` with the ephemeral message flag.
    assert.equal(replies[0].flags, discord.MessageFlags.Ephemeral);
    assert.equal(replies[0].ephemeral, undefined);
    assert.equal(seen[0].commandName, 'model');
    assert.equal(seen[0].option, 'deep');
    assert.equal(seen[0].channelKind, 'channel');

    // A non-command interaction is refused without reaching the adapter.
    fake.emit(discord.Events.InteractionCreate, {
      id: '900011',
      isChatInputCommand: () => false,
      isRepliable: () => true,
      reply: async (payload) => { replies.push(payload); },
    });
    await until(() => replies.length === 2, 'non-command refusal');
    assert.match(replies[1].content, /not implemented by this bot/u);
    assert.equal(replies[1].flags, discord.MessageFlags.Ephemeral);
    assert.equal(seen.length, 1);
  } finally {
    await transport.stop();
  }
});

test('the transport classifies real client failures by status and never leaks their text', { timeout: 15_000 }, async () => {
  const fake = fakeClient();
  fake.client.channels.cache.get = () => rawChannel({ sendError: Object.assign(new Error('PRIVATE-API-TEXT'), { status: 403 }) });
  const transport = createDiscordJsTransport({ token: 'synthetic-token', createClient: () => fake.client });
  await transport.start(context);
  try {
    await assert.rejects(transport.send({ channelId: CHANNEL_ID, text: 'hello' }), (error) => {
      assert.equal(error.name, 'DiscordTransportError');
      assert.equal(error.outcome, 'rejected');
      assert.equal(error.status, 403);
      assert.ok(!error.message.includes('PRIVATE-API-TEXT'));
      return true;
    });

    // A connection-level failure is ambiguous, not a refusal.
    fake.client.channels.cache.get = () => rawChannel({ sendError: new TypeError('socket hang up') });
    await assert.rejects(transport.send({ channelId: CHANNEL_ID, text: 'hello' }), (error) => {
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.status, undefined);
      return true;
    });

    // An unreachable channel is a proven refusal; an edit of a gone message stays a final-cursor signal.
    fake.client.channels.cache.get = () => undefined;
    await assert.rejects(transport.send({ channelId: '404404', text: 'hello' }), (error) => error.outcome === 'rejected');
    fake.client.channels.cache.get = () => rawChannel({ editError: Object.assign(new Error('gone'), { status: 404 }) });
    await assert.rejects(transport.edit(CHANNEL_ID, '1', 'text'), (error) => error.status === 404);
  } finally {
    await transport.stop();
  }
});

test('application command registration is best effort and never blocks the transport', { timeout: 15_000 }, async () => {
  const fake = fakeClient({ registerFailure: true });
  const transport = createDiscordJsTransport({ token: 'synthetic-token', createClient: () => fake.client });
  await transport.start(context);
  try {
    await transport.registerCommands([{ name: 'status', description: 'Show status' }]);
    // A refused registration is swallowed; the transport keeps running with typed commands.
    assert.equal(fake.record.destroyed, false);
    assert.equal(transport.botId, BOT_ID);
  } finally {
    await transport.stop();
  }

  const working = fakeClient();
  const second = createDiscordJsTransport({ token: 'synthetic-token', createClient: () => working.client });
  await second.start(context);
  try {
    await second.registerCommands([
      { name: 'model', description: 'List or select a model', option: { name: 'preset', description: 'Preset name' } },
    ]);
    assert.equal(working.registered.length, 1);
    const [command] = working.registered[0];
    assert.equal(command.name, 'model');
    assert.equal(command.type, discord.ApplicationCommandType.ChatInput);
    assert.equal(command.options[0].name, 'preset');
    assert.equal(command.options[0].type, discord.ApplicationCommandOptionType.String);
  } finally {
    await second.stop();
  }
});
