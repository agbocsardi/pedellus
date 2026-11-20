// Shared offline harness for the Discord channel checks.
//
// No bot, token, network, provider or live guild: the Gateway is real over a temporary store with a
// faux provider, and the transport is a synthetic object implementing the adapter's narrow contract.
// Every wait is bounded and every handle is cleaned up by the test that created it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL('../../', import.meta.url).pathname;
const modules = join(packageRoot, 'node_modules/@earendil-works');

export const context = (await import(`${modules}/chord/dist/context/index.js`)).BACKGROUND_CONTEXT;
export const { withCancel } = await import(`${modules}/chord/dist/context/index.js`);
export const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(`${modules}/pi-ai/dist/index.js`);
export const { superviseChannels } = await import(new URL('../../dist/cli.js', import.meta.url).href);
export const {
  DISCORD_HISTORY_LIMITS,
  DISCORD_HISTORY_PROVENANCE,
  DISCORD_HISTORY_REFUSALS,
  DISCORD_HISTORY_SESSION_DENIED,
  DISCORD_HISTORY_TOOL_NAME,
  parseDiscordHistoryArguments,
  parseDiscordHistoryBound,
  renderDiscordHistory,
} = await import(new URL('../../dist/channels/discord-history.js', import.meta.url).href);
export const { inProcessTerminalConversation } = await import(new URL('../../dist/terminal/conversation.js', import.meta.url).href);
export const { getCurrentSystemPrompt } = await import(`${modules}/pi-ai/dist/utils/transcript.js`);
export const { parseConfig, loadConfig } = await import(new URL('../../dist/config.js', import.meta.url).href);
export const { openGateway } = await import(new URL('../../dist/runtime.js', import.meta.url).href);
export const { runDiscord, DiscordState, validateOptions, decodeDiscordSessionKey } = await import(
  new URL('../../dist/channels/discord.js', import.meta.url).href
);
export const {
  DISCORD_TEXT_LIMIT,
  DiscordTransportError,
  classifyDiscordError,
  discordQuotedContext,
  splitDiscordText,
  resolveDiscordMentions,
  discordSpeakerLabel,
  isGoneError,
} = await import(new URL('../../dist/channels/discord-transport.js', import.meta.url).href);
export const { CronDeliveriesDoc } = await import(
  new URL('../../dist/automation/cron-delivery.js', import.meta.url).href
);

export const WAIT_MS = 15_000;
export const BOT_ID = '4242';
export const USER_ID = '501';
export const GUILD_ID = '9001';
export const CHANNEL_ID = '6001';
export const THREAD_ID = '7001';
export const DM_CHANNEL_ID = '8001';

export const SUMMARY_PROMPT_PREFIX = 'You maintain one short factual summary';
export const SUMMARY_BODY = 'Title: synthetic episode\n## Topics\n- synthetic\n## Keywords\n- synthetic';

// Polling waits sleep on the real timer instead of spinning setImmediate (which starves parallel test files
// of CPU); it is captured at load so tests that mock setTimeout cannot stall their own waits.
const realSetTimeout = globalThis.setTimeout;
const pause = () => new Promise((resolve) => realSetTimeout(resolve, 2));

export async function until(predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await pause();
  }
}

export async function untilAsync(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await pause();
  }
}

export async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Faux `fixture` provider that records every chat request (system prompt + messages) and can park
 * the next request so a check can inspect committed state while a turn is genuinely running.
 */
export function fauxModels(captured, options = {}) {
  const provider = fauxProvider({
    provider: 'fixture',
    models: [{ id: 'alpha', name: 'Alpha', reasoning: true }, { id: 'beta', name: 'Beta', reasoning: true }],
    ...(options.streamTokensPerSecond === undefined ? {} : { tokensPerSecond: options.streamTokensPerSecond }),
  });
  const gate = { held: false, entered: undefined, release: undefined, answer: undefined, steps: [], step: 0 };
  const dispatcher = (request) => {
    provider.appendResponses([dispatcher]);
    const system = getCurrentSystemPrompt(request.messages);
    if (system.startsWith(SUMMARY_PROMPT_PREFIX)) return fauxAssistantMessage(SUMMARY_BODY);
    captured.push({
      system,
      messages: request.messages,
      tools: (request.tools ?? []).map((tool) => tool.name),
    });
    const next = () => gate.step < gate.steps.length
      ? gate.steps[gate.step++](request)
      : fauxAssistantMessage(gate.answer ?? 'SYNTHETIC-REPLY');
    if (!gate.held) return next();
    gate.entered?.resolve();
    return new Promise((resolve) => { gate.release = () => resolve(next()); });
  };
  provider.setResponses([dispatcher]);
  const models = createModels();
  models.setProvider(provider.provider);
  return {
    models,
    gate: {
      setAnswer(text) { gate.answer = text; },
      script(steps) { gate.steps = steps; gate.step = 0; },
      hold() {
        const entered = deferred();
        gate.held = true;
        gate.entered = entered;
        return entered.promise;
      },
      release() {
        gate.held = false;
        gate.entered = undefined;
        const release = gate.release;
        gate.release = undefined;
        release?.();
      },
    },
  };
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** A real Gateway over a temporary store, configured with a Discord block. */
export async function openDiscordStore(label, options = {}) {
  // A caller may reopen an existing store directory (a gateway restart over the same data).
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), `nanobot-discord-${label}-`));
  try {
    const workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFiles(workspace, options.files ?? {});
    const captured = [];
    const { models, gate } = fauxModels(captured, options);
    const model = { provider: 'fixture', modelId: 'alpha' };
    const raw = {
      workspace,
      dataDir: join(directory, 'state'),
      ...(options.presets === undefined
        ? { model, allowedModels: [model] }
        : { modelPresets: options.presets, modelPreset: options.defaultPreset ?? Object.keys(options.presets)[0] }),
      toolAllowlist: options.tools ?? [],
      ...(options.digest === false ? {} : { digest: { model } }),
      ...(options.cron === true ? { cron: { enabled: true } } : {}),
      discord: {
        tokenEnv: 'SYNTHETIC_DISCORD_TOKEN',
        allowFrom: options.allowFrom ?? [USER_ID],
        ...(options.dmAllowFrom === undefined ? {} : { dmAllowFrom: options.dmAllowFrom }),
        ...(options.allowChannels === undefined ? {} : { allowChannels: options.allowChannels }),
        ...(options.groupPolicy === undefined ? {} : { groupPolicy: options.groupPolicy }),
        ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
      },
      ...(options.media === true ? { media: {} } : {}),
      ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
    };
    // A gateway opened from a file also exposes owner MCP management; the object form does not.
    let config;
    if (options.configFile === true) {
      const file = join(directory, 'config.json');
      await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
      config = await loadConfig(file);
    } else {
      config = parseConfig(raw, directory);
    }
    const gateway = await openGateway(config, context, { models, ...(options.gatewayOptions ?? {}) });
    return {
      directory,
      workspace,
      config,
      gateway,
      captured,
      gate,
      setAnswer(text) { gate.setAnswer(text); },
      script(steps) { gate.script(steps); },
      async close() {
        await gateway.close(context).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * A synthetic transport: it records every outbound call, exposes listeners the test can drive, and
 * can make the next send throw an exact failure (a status-carrying error, or an ambiguous one).
 */
export function syntheticTransport(options = {}) {
  const listeners = [];
  const interactionListeners = [];
  const sent = [];
  const edits = [];
  const typingCalls = [];
  const reactions = [];
  const registered = [];
  const failures = [];
  let nextMessageId = options.firstMessageId ?? 9_000;
  const state = {
    /** Returned by fetchMessage when the adapter asks for quoted context. */
    quoted: undefined,
    /** Throw this on the next send; cleared after it fires. */
    nextSendFailure: undefined,
    nextEditFailure: undefined,
    /** Resolve this promise before the next send completes, to hold an in-flight send. */
    sendGate: undefined,
    /** Sends currently inside `transport.send` (before any result). */
    inFlight: 0,
  };
  const transport = {
    botId: BOT_ID,
    botName: 'synthetic_bot',
    started: false,
    async start() {
      if (options.startFailure !== undefined) throw options.startFailure;
      transport.started = true;
    },
    async stop() { transport.started = false; },
    onMessage(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    onInteraction(listener) {
      interactionListeners.push(listener);
      return () => {
        const index = interactionListeners.indexOf(listener);
        if (index >= 0) interactionListeners.splice(index, 1);
      };
    },
    async send(request) {
      state.inFlight += 1;
      try {
        if (state.sendGate !== undefined) {
          const gate = state.sendGate;
          state.sendGate = undefined;
          await gate;
        }
        if (state.nextSendFailure !== undefined) {
          const failure = state.nextSendFailure;
          state.nextSendFailure = undefined;
          throw failure;
        }
        const messageId = String(nextMessageId++);
        sent.push({ ...request, messageId });
        return { messageId, text: request.text };
      } finally {
        state.inFlight -= 1;
      }
    },
    async edit(channelId, messageId, text) {
      if (state.nextEditFailure !== undefined) {
        const failure = state.nextEditFailure;
        state.nextEditFailure = undefined;
        throw failure;
      }
      edits.push({ channelId, messageId, text });
    },
    async typing(channelId) { typingCalls.push(channelId); },
    async addReaction(channelId, messageId, emoji) { reactions.push({ op: 'add', channelId, messageId, emoji }); },
    async removeReaction(channelId, messageId, emoji) { reactions.push({ op: 'remove', channelId, messageId, emoji }); },
    async fetchMessage(channelId, messageId) {
      return state.quoted === undefined ? undefined : { ...state.quoted, messageId };
    },
    async registerCommands(commands) { registered.push(commands); },
  };
  return {
    transport,
    sent,
    edits,
    typingCalls,
    reactions,
    registered,
    failures,
    state,
    /** Drive one inbound message and await its admission attempt (delivery is asynchronous). */
    async receive(message) {
      await waitForListener(listeners, 'message');
      for (const listener of listeners) listener(message);
      await flush(4);
    },
    async interact(interaction) {
      await waitForListener(interactionListeners, 'interaction');
      return interactionListeners[0](interaction);
    },
    texts() { return sent.map((entry) => entry.text); },
  };
}

/** The adapter attaches its listeners after its own durable recovery; wait for that, never a fixed sleep. */
async function waitForListener(list, label) {
  const deadline = Date.now() + WAIT_MS;
  while (list.length === 0) {
    if (Date.now() > deadline) throw new Error(`the adapter never attached a ${label} listener`);
    await pause();
  }
}

export function guildMessage(overrides = {}) {
  const content = overrides.content ?? `<@${BOT_ID}> hello there`;
  // Default mention metadata mirrors the content: an explicit mention list always wins.
  const mentions = overrides.mentions ?? (content.includes(`<@${BOT_ID}>`) || content.includes(`<@!${BOT_ID}>`)
    ? [{ id: BOT_ID, name: 'synthetic_bot' }]
    : []);
  return {
    id: overrides.id ?? '1001',
    channelId: overrides.channelId ?? CHANNEL_ID,
    channelKind: overrides.channelKind ?? 'channel',
    guildId: GUILD_ID,
    ...(overrides.parentChannelId === undefined ? {} : { parentChannelId: overrides.parentChannelId }),
    authorId: overrides.authorId ?? USER_ID,
    authorName: overrides.authorName ?? 'Alice',
    authorIsBot: overrides.authorIsBot ?? false,
    system: overrides.system ?? false,
    content,
    mentions,
    mentionsEveryone: overrides.mentionsEveryone ?? false,
    attachments: overrides.attachments ?? [],
    ...(overrides.reply === undefined ? {} : { reply: overrides.reply }),
    ...(overrides.quoted === undefined ? {} : { quoted: overrides.quoted }),
  };
}

export function dmMessage(overrides = {}) {
  return {
    ...guildMessage(overrides),
    channelId: overrides.channelId ?? DM_CHANNEL_ID,
    channelKind: 'dm',
    guildId: undefined,
    content: overrides.content ?? 'hello from a direct message',
    mentions: overrides.mentions ?? [],
  };
}

export function threadMessage(overrides = {}) {
  return {
    ...guildMessage(overrides),
    channelId: overrides.channelId ?? THREAD_ID,
    channelKind: 'thread',
    parentChannelId: overrides.parentChannelId ?? CHANNEL_ID,
  };
}

/** Start the real adapter over the real gateway with a synthetic transport. */
export function startDiscord(store, harness, options = {}) {
  const scope = withCancel(context);
  const adapter = runDiscord(store.gateway, harness.transport, {
    allowFrom: options.allowFrom ?? store.config.discord.allowFrom,
    ...(store.config.discord.dmAllowFrom === undefined ? {} : { dmAllowFrom: store.config.discord.dmAllowFrom }),
    ...(options.allowChannels !== undefined
      ? { allowChannels: options.allowChannels }
      : store.config.discord.allowChannels === undefined ? {} : { allowChannels: store.config.discord.allowChannels }),
    ...(store.config.discord.groupPolicy === undefined ? {} : { groupPolicy: store.config.discord.groupPolicy }),
    ...(store.config.discord.receipts === undefined ? {} : { receipts: store.config.discord.receipts }),
    ...(store.config.discord.streaming === undefined ? {} : { streaming: store.config.discord.streaming }),
    ...(store.config.media === undefined ? {} : { media: { workspace: store.workspace } }),
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
  }, scope.context);
  return {
    scope,
    adapter,
    async stop() {
      scope.cancel(new DOMException('test finished', 'AbortError'));
      await adapter.catch(() => undefined);
    },
  };
}

export async function channelState(gateway) {
  const conversation = await gateway.conversationFor(`discord:${BOT_ID}:channel-state`, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(DiscordState, conversation.id);
    return JSON.parse(JSON.stringify(doc));
  }, context);
}

/** Record one durable outbox delivery in the origin conversation, as a settled cron run would. */
export async function admitDelivery(gateway, sessionKey, record) {
  const conversation = await gateway.conversationFor(sessionKey, context);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(CronDeliveriesDoc, conversation.id);
    doc.deliveries.push(record);
  }, context);
  return conversation;
}

export async function outboxRecords(gateway, sessionKey) {
  const conversation = await gateway.conversationFor(sessionKey, context);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(CronDeliveriesDoc, conversation.id);
    return JSON.parse(JSON.stringify(doc.deliveries));
  }, context);
}

/** A model-facing text view of one captured request, for attribution/content assertions. */
export function userTexts(messages) {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')));
}

/** A chat's own durable queue projection, exactly what `/status` reads. */
export async function chatInbox(gateway, sessionKey) {
  const conversation = await gateway.conversationFor(sessionKey, context);
  return (await inProcessTerminalConversation(conversation).status(context)).inbox;
}

export const sessionKeys = {
  channel: `discord:${BOT_ID}:guild:${GUILD_ID}:channel:${CHANNEL_ID}`,
  thread: `discord:${BOT_ID}:guild:${GUILD_ID}:thread:${THREAD_ID}`,
  dm: `discord:${BOT_ID}:dm:${DM_CHANNEL_ID}`,
};
