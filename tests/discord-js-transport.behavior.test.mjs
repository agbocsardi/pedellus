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
const { renderDiscordHistory } = await import(new URL('../dist/channels/discord-history.js', import.meta.url).href);
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

    // A surfaced 429 keeps the server's cooldown so the adapter can wait instead of retrying at once.
    fake.client.channels.cache.get = () => rawChannel({
      sendError: Object.assign(new Error('rate limited'), { status: 429, retry_after: 2 }),
    });
    await assert.rejects(transport.send({ channelId: CHANNEL_ID, text: 'hello' }), (error) => {
      assert.equal(error.outcome, 'not-sent');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 2_000);
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

// ── Read-only history through the real transport ─────────────────────────────

const VIEW = discord.PermissionsBitField.Flags.ViewChannel;
const READ_HISTORY = discord.PermissionsBitField.Flags.ReadMessageHistory;

/** A permission set that can answer for the two flags this transport checks. */
function permissions({ view = true, history = true } = {}) {
  return {
    has(flag) {
      if (flag === VIEW) return view;
      if (flag === READ_HISTORY) return history;
      return false;
    },
  };
}

function historyMessage(id, timestamp, content = `message ${id}`) {
  return {
    id: String(id),
    content,
    type: 0,
    createdTimestamp: timestamp,
    author: { id: '777', username: 'alice', displayName: 'Alice' },
    member: { displayName: 'Alice (member)' },
    reference: null,
    attachments: collection([]),
    embeds: [],
  };
}

/**
 * A message collection with Discord's newest-first paging and an exclusive `before` cursor.
 * `failAfterPages` makes a later page throw, which must never look like a complete window.
 */
function messageCollection(getMessages, options = {}) {
  let pages = 0;
  return {
    async fetch({ limit, before }) {
      pages += 1;
      if (options.failAfterPages !== undefined && pages > options.failAfterPages) {
        throw Object.assign(new Error('synthetic service unavailable'), { status: 503 });
      }
      const list = [...getMessages()]
        .sort((left, right) => (BigInt(right.id) > BigInt(left.id) ? 1 : -1))
        .filter((entry) => before === undefined || BigInt(entry.id) < BigInt(before));
      const page = list.slice(0, limit);
      return { size: page.length, values: () => page[Symbol.iterator]() };
    },
  };
}

function historyChannel(over = {}) {
  return {
    id: over.id,
    name: over.name,
    type: over.type ?? discord.ChannelType.GuildText,
    guildId: over.guildId ?? GUILD_ID,
    parentId: over.parentId ?? null,
    parent: over.parent,
    guild: over.guild,
    isThread: () => over.thread === true,
    isDMBased: () => over.dm === true,
    permissionsFor: (member) =>
      (member?.id === '4242' ? over.botPermissions ?? permissions() : over.viewerPermissions ?? permissions()),
    messages: messageCollection(() => over.messages ?? [], over.fetchOptions ?? {}),
    ...(over.threads === undefined ? {} : { threads: over.threads }),
    ...(over.members === undefined ? {} : { members: over.members }),
  };
}

function historyGuild(over = {}) {
  const channels = new Map((over.channels ?? []).map((channel) => [channel.id, channel]));
  const members = new Map([
    ['501', { id: '501', permissions: over.viewerPermissions ?? permissions() }],
    ['4242', { id: '4242', permissions: over.botPermissions ?? permissions() }],
  ]);
  return {
    id: over.id ?? GUILD_ID,
    name: over.name ?? 'Synthetic Guild',
    members: {
      get me() { return members.get('4242'); },
      cache: { get: (id) => members.get(id) },
      fetch: async (id) => {
        const member = members.get(id);
        if (member === undefined) throw Object.assign(new Error('unknown member'), { status: 404 });
        return member;
      },
    },
    channels: {
      cache: { get: (id) => channels.get(id), values: () => channels.values() },
      fetchActiveThreads: async () => ({ threads: { values: () => (over.activeThreads ?? []).values() } }),
    },
  };
}

/** Start the real transport over a synthetic client whose channel map holds every reachable channel. */
async function historyTransport(guild, extraChannels = new Map(), fetchFailures = new Map()) {
  const channelMap = new Map([...guild.channels.cache.values()].map((channel) => [channel.id, channel]));
  for (const [id, channel] of extraChannels) channelMap.set(id, channel);
  const fake = fakeClient({ channels: channelMap, user: { id: BOT_ID, username: 'synthetic_bot' } });
  if (fetchFailures.size > 0) {
    fake.client.channels.fetch = async (id) => {
      const failure = fetchFailures.get(id);
      if (failure !== undefined) throw failure;
      const channel = channelMap.get(id);
      if (channel === undefined) throw Object.assign(new Error('unknown channel'), { status: 404 });
      return channel;
    };
  }
  fake.client.guilds = {
    cache: { get: (id) => (id === guild.id ? guild : undefined) },
    fetch: async (id) => {
      if (id !== guild.id) throw new Error('unknown guild');
      return guild;
    },
  };
  const transport = createDiscordJsTransport({ token: 'synthetic-token', createClient: () => fake.client });
  await transport.start(context);
  return transport;
}

const baseQuery = {
  viewerId: '501',
  guildId: GUILD_ID,
  sessionMode: 'channel',
  sessionChannelId: '6001',
  allowChannels: [],
  limit: 500,
  perSourceLimit: 200,
  includeThreads: true,
  includeArchivedThreads: false,
  archivedThreadLimit: 50,
  maxChars: 12_000,
};

test('history reads a text channel oldest-first with paging and stable ids', { timeout: 15_000 }, async () => {
  const messages = Array.from({ length: 150 }, (_, index) =>
    historyMessage(1_000 + index, Date.UTC(2026, 0, 1) + index * 60_000, `line ${index}`));
  const general = historyChannel({ id: '6001', name: 'general', messages });
  const transport = await historyTransport(historyGuild({ channels: [general] }));
  try {
    const read = await transport.history({ ...baseQuery, perSourceLimit: 150 });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.mode, 'channel');
    assert.equal(read.snapshot.messages.length, 150);
    assert.equal(read.snapshot.messages[0].messageId, '1000');
    assert.equal(read.snapshot.messages.at(-1).messageId, '1149');
    assert.equal(read.snapshot.messages[0].channelId, '6001');
    assert.equal(read.snapshot.messages[0].authorId, '777');
    assert.equal(read.snapshot.sourcesScanned, 1);

    // An exclusive window is honored, and a tight per-source cap is reported rather than hidden.
    const windowed = await transport.history({
      ...baseQuery,
      sinceMs: Date.UTC(2026, 0, 1) + 10 * 60_000,
      untilMs: Date.UTC(2026, 0, 1) + 20 * 60_000,
    });
    assert.equal(windowed.ok, true);
    assert.deepEqual(windowed.snapshot.messages.map((entry) => entry.messageId),
      ['1010', '1011', '1012', '1013', '1014', '1015', '1016', '1017', '1018', '1019']);
    const capped = await transport.history({ ...baseQuery, perSourceLimit: 5 });
    assert.equal(capped.ok, true);
    assert.equal(capped.snapshot.messages.length, 5);
    assert.ok(capped.snapshot.warnings.some((warning) => warning.code === 'source-limit-reached'));
  } finally {
    await transport.stop();
  }
});

test('history requires both the sender and the bot to read a source', { timeout: 15_000 }, async () => {
  const messages = [historyMessage(1, Date.UTC(2026, 0, 1))];
  const viewerDenied = historyChannel({
    id: '6001', name: 'general', messages,
    viewerPermissions: permissions({ view: false, history: false }),
  });
  const transport = await historyTransport(historyGuild({ channels: [viewerDenied] }));
  try {
    // The bot can read it, but this sender cannot: the read fails closed.
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '6001' }), { ok: false, refusal: 'forbidden' });
  } finally {
    await transport.stop();
  }

  const botDenied = historyChannel({
    id: '6001', name: 'general', messages,
    botPermissions: permissions({ view: true, history: false }),
  });
  const second = await historyTransport(historyGuild({ channels: [botDenied] }));
  try {
    assert.deepEqual(await second.history({ ...baseQuery, channelId: '6001' }), { ok: false, refusal: 'forbidden' });
  } finally {
    await second.stop();
  }

  // Discovery without a selection also refuses when the current channel is unreadable.
  const denied = historyChannel({
    id: '6001', name: 'general', messages,
    viewerPermissions: permissions({ history: false }),
  });
  const third = await historyTransport(historyGuild({ channels: [denied] }));
  try {
    assert.deepEqual(await third.history(baseQuery), { ok: false, refusal: 'forbidden' });
  } finally {
    await third.stop();
  }
});

test('history includes private threads only for a member and keeps thread identity', { timeout: 15_000 }, async () => {
  const parent = historyChannel({ id: '6001', name: 'general', messages: [historyMessage(1, Date.UTC(2026, 0, 1))] });
  const thread = historyChannel({
    id: '7001', name: 'secret', thread: true, type: discord.ChannelType.PrivateThread,
    parentId: '6001', parent, messages: [historyMessage(9, Date.UTC(2026, 0, 1, 1), 'in thread')],
    members: { cache: { has: () => false }, fetch: async () => { throw new Error('not a member'); } },
  });
  const transport = await historyTransport(historyGuild({ channels: [parent, thread] }));
  try {
    // Not a member: even an explicit id is refused.
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '7001' }), { ok: false, refusal: 'forbidden' });

    // A member sees it, with the thread id and the parent channel id.
    thread.members = { cache: { has: () => true }, fetch: async () => ({}) };
    const read = await transport.history({ ...baseQuery, channelId: '7001' });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.mode, 'thread');
    assert.equal(read.snapshot.messages[0].threadId, '7001');
    assert.equal(read.snapshot.messages[0].channelId, '6001');
    assert.equal(read.snapshot.messages[0].channelName, 'general');
  } finally {
    await transport.stop();
  }
});

test('history never widens beyond the current guild and reads a DM only as a DM', { timeout: 15_000 }, async () => {
  const general = historyChannel({ id: '6001', name: 'general', messages: [historyMessage(1, Date.UTC(2026, 0, 1))] });
  const foreign = historyChannel({
    id: '6601', name: 'other-guild', guildId: '9999',
    messages: [historyMessage(2, Date.UTC(2026, 0, 1))],
  });
  const transport = await historyTransport(historyGuild({ channels: [general] }), new Map([['6601', foreign]]));
  try {
    // A channel whose own guild differs from the session's guild is refused, never read.
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '6601' }), { ok: false, refusal: 'not-found' });
  } finally {
    await transport.stop();
  }

  const dm = historyChannel({
    id: '8001', name: undefined, dm: true, guildId: null,
    messages: [historyMessage(5, Date.UTC(2026, 0, 1), 'direct hello')],
  });
  const dmTransport = await historyTransport(historyGuild({ channels: [] }), new Map([['8001', dm]]));
  try {
    const read = await dmTransport.history({
      ...baseQuery,
      sessionMode: 'dm',
      sessionChannelId: '8001',
      guildId: null,
    });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.mode, 'dm');
    assert.equal(read.snapshot.guild.id, null);
    assert.equal(read.snapshot.messages[0].channelId, '8001');
  } finally {
    await dmTransport.stop();
  }
});

test('history resolves a channel name, enumerates archived threads and refuses ambiguity', { timeout: 15_000 }, async () => {
  const parent = historyChannel({ id: '6001', name: 'general', messages: [] });
  const archivedPublic = historyChannel({
    id: '7101', name: 'old-public', thread: true, type: discord.ChannelType.PublicThread,
    parentId: '6001', parent, messages: [historyMessage(11, Date.UTC(2026, 0, 1), 'archived public')],
  });
  const archivedPrivate = historyChannel({
    id: '7102', name: 'old-private', thread: true, type: discord.ChannelType.PrivateThread,
    parentId: '6001', parent, messages: [historyMessage(12, Date.UTC(2026, 0, 1), 'archived private')],
    members: { cache: { has: (id) => id === '501' || id === '4242' }, fetch: async () => ({}) },
  });
  const archivedCalls = [];
  parent.threads = {
    cache: { values: () => [].values() },
    fetchArchived: async ({ type, limit }) => {
      archivedCalls.push({ type, limit });
      return { threads: { values: () => (type === 'private' ? [archivedPrivate] : [archivedPublic]).values() } };
    },
  };
  const transport = await historyTransport(
    historyGuild({ channels: [parent, archivedPublic, archivedPrivate] }),
  );
  try {
    const byName = await transport.history({ ...baseQuery, channelName: '#general', includeArchivedThreads: true });
    assert.equal(byName.ok, true);
    assert.deepEqual(archivedCalls.map((call) => call.type), ['public', 'private']);
    assert.deepEqual(new Set(byName.snapshot.messages.map((entry) => entry.threadId)), new Set(['7101', '7102']));
    assert.equal(byName.snapshot.channel.id, '6001');

    // Two channels sharing a name are ambiguous: the model must use an id.
    const duplicate = historyChannel({ id: '6002', name: 'general', messages: [] });
    const second = await historyTransport(historyGuild({ channels: [parent, duplicate] }));
    try {
      assert.deepEqual(await second.history({ ...baseQuery, channelName: 'general' }), { ok: false, refusal: 'not-found' });
    } finally {
      await second.stop();
    }
  } finally {
    await transport.stop();
  }
});

test('a later page failure keeps the rows read but never claims a complete window', { timeout: 15_000 }, async () => {
  const messages = Array.from({ length: 150 }, (_, index) =>
    historyMessage(1_000 + index, Date.UTC(2026, 0, 1) + index * 60_000, `line ${index}`));
  const general = historyChannel({
    id: '6001', name: 'general', messages,
    fetchOptions: { failAfterPages: 1 },
  });
  const transport = await historyTransport(historyGuild({ channels: [general] }));
  try {
    const read = await transport.history({ ...baseQuery, perSourceLimit: 150 });
    assert.equal(read.ok, true);
    // Page one is real evidence and is kept; the shape itself says the window is unfinished.
    assert.equal(read.snapshot.messages.length, 100);
    assert.equal(read.snapshot.partial, true);
    assert.equal(read.snapshot.unreadUnknown, true);
    assert.deepEqual(read.snapshot.warnings.find((warning) => warning.code === 'fetch-failed'),
      { code: 'fetch-failed', count: 1, sourceIds: ['6001'] });
    // Nothing about the failure text reaches the model.
    assert.equal(JSON.stringify(read.snapshot).includes('synthetic service unavailable'), false);

    const rendered = JSON.parse(renderDiscordHistory(read.snapshot, {
      ...baseQuery, perSourceLimit: 150, maxChars: 12_000,
    }));
    assert.equal(rendered.coverage.partial, true);
    assert.equal(rendered.coverage.complete, false);
    assert.equal(rendered.coverage.truncated, true);
    assert.equal(rendered.coverage.unreadMessages, 'unknown');
    // The character budget may cut further; the whole-page evidence is kept and the cut is exact.
    assert.ok(rendered.messages.length > 0);
    assert.equal(rendered.coverage.messagesReturned, rendered.messages.length);
    assert.equal(rendered.coverage.messagesCut, 100 - rendered.messages.length);
  } finally {
    await transport.stop();
  }
});

test('a row without a usable timestamp is counted as skipped instead of silently dropped', { timeout: 15_000 }, async () => {
  const good = historyMessage(1, Date.UTC(2026, 0, 1), 'good');
  const timestampLess = { ...historyMessage(2, 0, 'no timestamp') };
  delete timestampLess.createdTimestamp;
  delete timestampLess.createdAt;
  const channel = historyChannel({ id: '6001', name: 'general', messages: [good, timestampLess] });
  const transport = await historyTransport(historyGuild({ channels: [channel] }));
  try {
    const read = await transport.history({ ...baseQuery, channelId: '6001' });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.messages.length, 1);
    assert.equal(read.snapshot.skippedMessages, 1);
    assert.equal(read.snapshot.partial, true);
    assert.deepEqual(read.snapshot.warnings.find((warning) => warning.code === 'rows-unusable'),
      { code: 'rows-unusable', count: 1, sourceIds: ['6001'] });
    const rendered = JSON.parse(renderDiscordHistory(read.snapshot, baseQuery));
    assert.equal(rendered.coverage.skippedMessages, 1);
    assert.equal(rendered.coverage.complete, false);
    assert.equal(rendered.coverage.partial, true);
  } finally {
    await transport.stop();
  }
});

test('a global message limit, a DM limit and a character budget each mark the read incomplete', { timeout: 15_000 }, async () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    historyMessage(1_000 + index, Date.UTC(2026, 0, 1) + index * 60_000, `line ${index}`));
  const general = historyChannel({ id: '6001', name: 'general', messages });
  const transport = await historyTransport(historyGuild({ channels: [general] }));
  try {
    const limited = await transport.history({ ...baseQuery, limit: 2 });
    assert.equal(limited.ok, true);
    assert.equal(limited.snapshot.messages.length, 2);
    assert.equal(limited.snapshot.unreadUnknown, true);
    assert.ok(limited.snapshot.warnings.some((warning) => warning.code === 'source-limit-reached'));
    const limitedRendered = JSON.parse(renderDiscordHistory(limited.snapshot, { ...baseQuery, limit: 2 }));
    assert.equal(limitedRendered.coverage.truncated, true);
    assert.equal(limitedRendered.coverage.complete, false);
    assert.equal(limitedRendered.coverage.unreadMessages, 'unknown');

    // A character budget is an exact cut: the message count that did not fit is known.
    const many = Array.from({ length: 40 }, (_, index) =>
      historyMessage(2_000 + index, Date.UTC(2026, 0, 2) + index * 60_000, 'x'.repeat(300)));
    general.messages = messageCollection(() => many);
    const cut = await transport.history({ ...baseQuery, perSourceLimit: 40 });
    const cutRendered = JSON.parse(renderDiscordHistory(cut.snapshot, {
      ...baseQuery, perSourceLimit: 40, maxChars: 2_000,
    }));
    assert.ok(cutRendered.messages.length < 40);
    assert.equal(cutRendered.coverage.messagesCut, 40 - cutRendered.messages.length);
    assert.equal(cutRendered.coverage.truncated, true);
    assert.equal(cutRendered.coverage.complete, false);
  } finally {
    await transport.stop();
  }

  const dmMessages = Array.from({ length: 5 }, (_, index) =>
    historyMessage(3_000 + index, Date.UTC(2026, 0, 1) + index * 60_000, `dm ${index}`));
  const dm = historyChannel({ id: '8001', name: undefined, dm: true, guildId: null, messages: dmMessages });
  const dmTransport = await historyTransport(historyGuild({ channels: [] }), new Map([['8001', dm]]));
  try {
    const limited = await dmTransport.history({
      ...baseQuery, sessionMode: 'dm', sessionChannelId: '8001', guildId: null, limit: 2,
    });
    assert.equal(limited.ok, true);
    assert.equal(limited.snapshot.messages.length, 2);
    assert.equal(limited.snapshot.unreadUnknown, true);
    const rendered = JSON.parse(renderDiscordHistory(limited.snapshot, {
      ...baseQuery, sessionMode: 'dm', sessionChannelId: '8001', guildId: null, limit: 2,
    }));
    assert.equal(rendered.coverage.truncated, true);
    assert.equal(rendered.coverage.complete, false);
    assert.equal(rendered.coverage.unreadMessages, 'unknown');
  } finally {
    await dmTransport.stop();
  }
});

test('sources beyond the scan bound are counted as unread, with one deduped warning', { timeout: 15_000 }, async () => {
  const messages = [historyMessage(1, Date.UTC(2026, 0, 1))];
  const parent = historyChannel({ id: '6001', name: 'general', messages });
  const threads = Array.from({ length: 120 }, (_, index) => historyChannel({
    id: String(7_000 + index),
    name: `thread-${index}`,
    thread: true,
    type: discord.ChannelType.PublicThread,
    parentId: '6001',
    parent,
    messages: [historyMessage(9_000 + index, Date.UTC(2026, 0, 1, 1) + index * 60_000, `thread ${index}`)],
  }));
  const guild = historyGuild({ channels: [parent, ...threads], activeThreads: threads });
  const transport = await historyTransport(guild);
  try {
    const read = await transport.history({ ...baseQuery, perSourceLimit: 1, limit: 2_000 });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.sourcesScanned, 100);
    assert.equal(read.snapshot.sourcesUnscanned, 21);
    assert.equal(read.snapshot.unreadUnknown, true);
    // One warning row, carrying the count and a bounded sample of ids — not one row per source.
    const limitWarnings = read.snapshot.warnings.filter((warning) => warning.code === 'source-limit-reached');
    assert.equal(limitWarnings.length, 1);
    assert.equal(limitWarnings[0].count, 100);
    assert.ok(limitWarnings[0].sourceIds.length <= 5);
    const rendered = JSON.parse(renderDiscordHistory(read.snapshot, { ...baseQuery, perSourceLimit: 1, limit: 2_000 }));
    assert.equal(rendered.coverage.sourcesUnscanned, 21);
    assert.equal(rendered.coverage.truncated, true);
    assert.equal(rendered.coverage.complete, false);
    assert.equal(rendered.coverage.unreadMessages, 'unknown');
    assert.equal(rendered.warnings.filter((warning) => warning.code === 'source-limit-reached').length, 1);
  } finally {
    await transport.stop();
  }
});

test('a bounded archived listing marks the enumeration limited', { timeout: 15_000 }, async () => {
  const parent = historyChannel({ id: '6001', name: 'general', messages: [] });
  const archived = Array.from({ length: 2 }, (_, index) => historyChannel({
    id: String(7_500 + index),
    name: `archived-${index}`,
    thread: true,
    type: discord.ChannelType.PublicThread,
    parentId: '6001',
    parent,
    messages: [historyMessage(9_500 + index, Date.UTC(2026, 0, 1), `archived ${index}`)],
  }));
  parent.threads = {
    cache: { values: () => [].values() },
    fetchArchived: async ({ type }) => ({
      threads: { values: () => (type === 'public' ? archived : []).values() },
    }),
  };
  const transport = await historyTransport(historyGuild({ channels: [parent, ...archived] }));
  try {
    const read = await transport.history({ ...baseQuery, includeArchivedThreads: true, archivedThreadLimit: 2 });
    assert.equal(read.ok, true);
    assert.equal(read.snapshot.enumerationLimited, true);
    assert.equal(read.snapshot.unreadUnknown, true);
    const rendered = JSON.parse(renderDiscordHistory(read.snapshot, {
      ...baseQuery, includeArchivedThreads: true, archivedThreadLimit: 2,
    }));
    assert.equal(rendered.coverage.truncated, true);
    assert.equal(rendered.coverage.complete, false);
    assert.equal(rendered.coverage.unreadMessages, 'unknown');
  } finally {
    await transport.stop();
  }
});

test('a missing, refused or failing channel maps to its own fixed refusal', { timeout: 15_000 }, async () => {
  const general = historyChannel({ id: '6001', name: 'general', messages: [historyMessage(1, Date.UTC(2026, 0, 1))] });
  const guild = historyGuild({ channels: [general] });
  const transport = await historyTransport(guild, new Map(), new Map([
    ['6601', Object.assign(new Error('unknown channel'), { status: 404 })],
    ['6602', Object.assign(new Error('missing access'), { status: 403 })],
    ['6603', Object.assign(new Error('service unavailable'), { status: 503 })],
  ]));
  try {
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '6601' }), { ok: false, refusal: 'not-found' });
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '6602' }), { ok: false, refusal: 'forbidden' });
    // The capability is live; the read itself failed. That is not "history is unavailable".
    assert.deepEqual(await transport.history({ ...baseQuery, channelId: '6603' }), { ok: false, refusal: 'read-failed' });
  } finally {
    await transport.stop();
  }
});
