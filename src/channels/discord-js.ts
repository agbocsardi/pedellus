/**
 * The real Discord transport: discord.js v14 (Gateway WebSocket + REST).
 *
 * discord.js is imported lazily so the adapter, its offline checks and a gateway without a Discord
 * block never load the client or require its token. This module owns every Discord-specific detail
 * the adapter must not know: event shapes, partials, thread/DM kinds, reply references, application
 * command registration and error statuses.
 *
 * Two rules are enforced here as defence in depth, not as the authority:
 * - every send and edit passes `allowedMentions: { parse: [], repliedUser: false }`, so a model
 *   answer, host notice or scheduled result can never ping a user, role, `@everyone` or `@here`;
 * - the adapter's own message events are dropped by the adapter (bot ID), and every failure is
 *   rethrown as a {@link DiscordTransportError} whose outcome is derived only from a status code.
 *
 * Limitations this transport does not hide: the Discord Gateway is not an acknowledgement
 * protocol, so a dropped socket can lose events (the adapter deduplicates the ones it does receive
 * by message ID); `MESSAGE_CONTENT` is a privileged intent that must be enabled for the bot; and
 * neither this module nor discord.js can make an external send idempotent.
 */
import type { Context } from "@earendil-works/chord";
import {
  DiscordTransportError,
  classifyDiscordError,
  type DiscordChannelKind,
  type DiscordCommandSpec,
  type DiscordInboundAttachment,
  type DiscordInboundMessage,
  type DiscordInteraction,
  type DiscordInteractionResponse,
  type DiscordReplyReference,
  type DiscordTransport,
} from "./discord-transport.js";
import {
  DISCORD_HISTORY_LIMITS,
  type DiscordHistoryMessage,
  type DiscordHistoryRead,
  type DiscordHistoryWarning,
} from "./discord-history.js";
import type { DiscordHistoryQuery } from "./discord-transport.js";

export type DiscordJsTransportOptions = {
  /** Bot token, read by the host from the configured environment reference. Never logged. */
  readonly token: string;
  /** Advanced: override the Gateway intents the client requests. */
  readonly intents?: number;
  /** Advanced: override the discord.js REST timeout. */
  readonly restTimeoutMs?: number;
  /**
   * Advanced: build the client instead of `new Client(...)`. Offline checks use it to exercise the
   * real event/interaction/error mapping against a synthetic client; it never changes what the
   * adapter sees.
   */
  readonly createClient?: DiscordClientFactory;
};

/** The client surface this transport uses; the real discord.js client satisfies it structurally. */
export interface DiscordClientLike {
  user: { readonly id: string; readonly username?: string } | null;
  application: { readonly commands: { set(commands: readonly unknown[]): Promise<Map<string, unknown>> } } | null;
  channels: {
    readonly cache: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
  on(event: string, handler: (payload: never) => void): unknown;
  once(event: string, handler: (...args: never[]) => void): unknown;
  off(event: string, handler: (...args: never[]) => void): unknown;
  removeAllListeners(): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
}

/** One client-factory request: the loaded module, the resolved intents and the transport's bounds. */
export interface DiscordClientFactoryRequest {
  readonly module: DiscordModule;
  readonly intents: number;
  readonly partials: readonly unknown[];
  readonly restTimeoutMs?: number;
}

export type DiscordClientFactory = (request: DiscordClientFactoryRequest) => DiscordClientLike;

/** The production factory: a discord.js client with non-pinging defaults and the DM channel partial. */
const createDiscordJsClient: DiscordClientFactory = ({ module, intents, partials, restTimeoutMs }) =>
  new module.Client({
    intents,
    partials: partials as never[],
    allowedMentions: { parse: [], repliedUser: false },
    ...(restTimeoutMs === undefined ? {} : { rest: { timeout: restTimeoutMs } }),
  }) as unknown as DiscordClientLike;

type DiscordModule = typeof import("discord.js");
type DiscordMessage = import("discord.js").Message;

/** Discord's own message types that carry a conversational prompt. */
const MESSAGE_TYPE_DEFAULT = 0;
const MESSAGE_TYPE_REPLY = 19;

/** The parts of a Discord channel this transport uses; narrowed structurally to keep types small. */
type DiscordChannelLike = {
  send(options: DiscordSendOptions): Promise<{ id: string }>;
  sendTyping?: () => Promise<void>;
  messages?: {
    edit(id: string, options: DiscordSendOptions): Promise<unknown>;
    fetch(id: string): Promise<DiscordMessage>;
  };
  isThread?: () => boolean;
  isDMBased?: () => boolean;
  parentId?: string | null;
  name?: string;
};

type DiscordSendOptions = {
  content: string;
  allowedMentions: { parse: readonly never[]; repliedUser: false };
  reply?: { messageReference: string; failIfNotExists: false };
};

/**
 * Build the real transport. Nothing connects until `start`; the returned object is inert (and
 * `botId` empty) before that, so a host can construct it without I/O.
 */
export function createDiscordJsTransport(options: DiscordJsTransportOptions): DiscordTransport {
  const token = options.token;
  if (typeof token !== "string" || token.trim() === "" || /[\r\n]/u.test(token)) {
    throw new Error("Discord token is required and must be a single line");
  }
  let discord: DiscordModule | undefined;
  let client: DiscordClientLike | undefined;
  let botId = "";
  let botName: string | undefined;

  const transport: DiscordTransport = {
    get botId() {
      return botId;
    },
    get botName() {
      return botName;
    },
    async start(context: Context) {
      discord ??= await import("discord.js");
      const d = discord;
      const intents = options.intents ?? (
        d.GatewayIntentBits.Guilds |
        d.GatewayIntentBits.GuildMessages |
        d.GatewayIntentBits.DirectMessages |
        // Privileged: enable "Message Content Intent" for the bot, or guild messages arrive empty.
        d.GatewayIntentBits.MessageContent
      );
      const ready = deferred<void>();
      const createClient = options.createClient ?? createDiscordJsClient;
      const created = createClient({
        module: d,
        intents,
        // Direct-message channels arrive as partials; without this a DM event is never delivered.
        partials: [d.Partials.Channel],
        ...(options.restTimeoutMs === undefined ? {} : { restTimeoutMs: options.restTimeoutMs }),
      });
      client = created;
      const onReady = () => {
        botId = created.user?.id ?? "";
        botName = created.user?.username;
        ready.resolve();
      };
      const onError = (error: unknown) => ready.reject(error);
      created.once(d.Events.ClientReady, onReady);
      created.once(d.Events.Error, onError);
      const aborted = () => ready.reject(new DiscordTransportError(
        "Discord transport stopped while connecting",
        { outcome: "unknown" },
      ));
      context.abortSignal?.addEventListener("abort", aborted, { once: true });
      try {
        await created.login(token);
        await ready.promise;
      } catch (error) {
        created.removeAllListeners();
        if (client === created) client = undefined;
        // Never leave a half-open Gateway socket behind a failed login.
        await created.destroy().catch(() => undefined);
        const classified = classifyDiscordError(error);
        throw new DiscordTransportError(
          classified.outcome === "rejected"
            ? "Discord rejected the bot login"
            : "Discord login did not complete",
          {
            outcome: classified.outcome,
            ...(classified.status === undefined ? {} : { status: classified.status }),
            cause: error,
          },
        );
      } finally {
        context.abortSignal?.removeEventListener("abort", aborted);
      }
      created.off(d.Events.Error, onError);
      created.on(d.Events.Error, () => {
        // A Gateway error is a connection event, not a message outcome. Never log its text: it may
        // quote the token or a request URL.
        console.warn("Discord client reported a connection error; reconnecting if possible.");
      });
      if (botId === "") {
        throw new DiscordTransportError("Discord client connected without a bot identity", { outcome: "unknown" });
      }
    },
    async stop() {
      const current = client;
      client = undefined;
      botId = "";
      botName = undefined;
      if (current === undefined) return;
      try {
        await current.destroy();
      } catch {
        // A failed close is not an actionable adapter error; the process is stopping anyway.
      }
    },
    onMessage(listener) {
      const d = discord;
      const current = client;
      if (d === undefined || current === undefined) return () => undefined;
      const handler = (raw: DiscordMessage) => {
        void mapMessage(raw).then((message) => {
          if (message !== undefined) listener(message);
        }).catch(() => {
          // Mapping reads only local event data; a failure here is a malformed event, never a send.
          console.warn("Discord message event could not be read; it was ignored.");
        });
      };
      current.on(d.Events.MessageCreate, handler);
      return () => { current.off(d.Events.MessageCreate, handler); };
    },
    onInteraction(listener) {
      const d = discord;
      const current = client;
      if (d === undefined || current === undefined) return () => undefined;
      const handler = (raw: import("discord.js").Interaction) => {
        if (!raw.isChatInputCommand()) {
          void replyInteraction(raw, {
            text: "This interaction is not implemented by this bot. Nothing was changed.",
            ephemeral: true,
          }, d);
          return;
        }
        const channel = raw.channel as DiscordChannelLike | null;
        const parentId = channel?.parentId;
        const preset = raw.options.getString("preset");
        const mapped: DiscordInteraction = {
          id: raw.id,
          channelId: raw.channelId,
          channelKind: channelKindOf(channel),
          ...(raw.guildId === null ? {} : { guildId: raw.guildId }),
          ...(parentId === null || parentId === undefined ? {} : { parentChannelId: parentId }),
          userId: raw.user.id,
          userName: raw.user.username,
          userIsBot: raw.user.bot,
          commandName: raw.commandName,
          ...(preset === null ? {} : { option: preset }),
        };
        void Promise.resolve()
          .then(() => listener(mapped))
          .then((response) => replyInteraction(raw, response ?? { text: "Processing…", ephemeral: true }, d))
          .catch(() => replyInteraction(raw, { text: "This command could not be accepted.", ephemeral: true }, d));
      };
      current.on(d.Events.InteractionCreate, handler);
      return () => { current.off(d.Events.InteractionCreate, handler); };
    },
    async send(request) {
      const current = client;
      if (current === undefined) {
        throw new DiscordTransportError("the Discord client is not running", { outcome: "not-sent" });
      }
      const channel = asChannelLike(await resolveChannel(current, request.channelId));
      if (channel === undefined || typeof channel.send !== "function") {
        throw new DiscordTransportError("this Discord channel cannot receive messages", { outcome: "not-sent", status: 404 });
      }
      try {
        const message = await channel.send({
          content: request.text,
          allowedMentions: { parse: [], repliedUser: false },
          ...(request.replyToMessageId === undefined
            ? {}
            : {
                reply: {
                  messageReference: request.replyToMessageId,
                  // A deleted target must not fail the answer: send it unthreaded instead.
                  failIfNotExists: false,
                },
              }),
        });
        return { messageId: message.id, text: request.text };
      } catch (error) {
        throw sendFailure(error);
      }
    },
    async edit(channelId, messageId, text) {
      const current = client;
      if (current === undefined) {
        throw new DiscordTransportError("the Discord client is not running", { outcome: "not-sent" });
      }
      const channel = asChannelLike(await resolveChannel(current, channelId));
      if (channel?.messages === undefined) {
        throw new DiscordTransportError("this Discord channel has no messages", { outcome: "not-sent", status: 404 });
      }
      try {
        await channel.messages.edit(messageId, {
          content: text,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (error) {
        throw sendFailure(error);
      }
    },
    async typing(channelId) {
      const current = client;
      if (current === undefined) return;
      const channel = asChannelLike(await resolveChannel(current, channelId));
      if (channel === undefined || typeof channel.sendTyping !== "function") return;
      try {
        await channel.sendTyping();
      } catch {
        // A typing indicator is cosmetic; it never fails a turn or a delivery.
      }
    },
    async addReaction(channelId, messageId, emoji) {
      const message = await resolveMessage(client, channelId, messageId);
      if (message === undefined) {
        throw new DiscordTransportError("the target message is gone", { outcome: "not-sent", status: 404 });
      }
      try {
        await message.react(emoji);
      } catch (error) {
        throw sendFailure(error);
      }
    },
    async removeReaction(channelId, messageId, emoji) {
      const message = await resolveMessage(client, channelId, messageId);
      if (message === undefined) return;
      try {
        const reaction = message.reactions.resolve(emoji);
        if (reaction === null) return;
        await reaction.users.remove(botId);
      } catch {
        // Best effort: a reaction cleanup failure must not fail the answer it decorates.
      }
    },
    async fetchMessage(channelId, messageId) {
      const message = await resolveMessage(client, channelId, messageId);
      return message === undefined ? undefined : replySnapshot(message);
    },
    async history(query) {
      const d = discord;
      const current = client;
      if (d === undefined || current === undefined || botId === "") {
        return { ok: false, refusal: "unavailable" };
      }
      try {
        return await readHistory(d, current, botId, query);
      } catch {
        // A fixed refusal: never a transport message, URL or token.
        return { ok: false, refusal: "unavailable" };
      }
    },
    async registerCommands(commands: readonly DiscordCommandSpec[]) {
      const d = discord;
      const current = client;
      if (d === undefined || current === undefined) return;
      const application = current.application;
      if (application === null) return;
      try {
        await application.commands.set(commands.map((command) => ({
          name: command.name,
          description: command.description,
          type: d.ApplicationCommandType.ChatInput,
          ...(command.option === undefined
            ? {}
            : {
                options: [{
                  name: command.option.name,
                  description: command.option.description,
                  type: d.ApplicationCommandOptionType.String,
                  required: false,
                }],
              }),
        })));
      } catch {
        // A bot without the applications.commands scope keeps typed commands working; the failure
        // is reported once without any Discord response body.
        console.warn("Discord application command registration failed; typed commands still work.");
      }
    },
  };
  return transport;
}

/** Map one Gateway message event to the adapter's bounded view, or `undefined` when unusable. */
async function mapMessage(raw: DiscordMessage): Promise<DiscordInboundMessage | undefined> {
  if (raw.partial) return undefined;
  const channel = raw.channel as DiscordChannelLike | null;
  const reference = raw.reference;
  const repliedUser = raw.mentions.repliedUser;
  const replyTarget = reference === null || reference.messageId === undefined || reference.messageId === null
    ? undefined
    : {
        messageId: reference.messageId,
        ...(repliedUser === null ? {} : { authorId: repliedUser.id }),
        authorIsBot: repliedUser?.bot === true,
      };
  const author = raw.author;
  const parentId = channel?.parentId;
  const name = channel?.name;
  const type = raw.type;
  return {
    id: raw.id,
    channelId: raw.channelId,
    channelKind: channelKindOf(channel),
    ...(raw.guildId === null ? {} : { guildId: raw.guildId }),
    ...(parentId === null || parentId === undefined ? {} : { parentChannelId: parentId }),
    ...(name === undefined ? {} : { channelName: name }),
    authorId: author.id,
    authorName: raw.member?.displayName ?? author.displayName ?? author.username,
    authorIsBot: author.bot,
    // Only a plain message and a reply carry a prompt; every other type is a Discord system event.
    system: type !== MESSAGE_TYPE_DEFAULT && type !== MESSAGE_TYPE_REPLY,
    content: raw.content,
    mentions: raw.mentions.users.map((user) => ({
      id: user.id,
      name: raw.mentions.members?.get(user.id)?.displayName ?? user.displayName ?? user.username,
    })),
    mentionsEveryone: raw.mentions.everyone,
    ...(replyTarget === undefined ? {} : { reply: replyTarget }),
    attachments: raw.attachments.map(attachmentSnapshot),
  };
}

function replySnapshot(message: DiscordMessage): DiscordReplyReference {
  return {
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
    authorIsBot: message.author.bot,
    text: message.content,
    attachments: message.attachments.map(attachmentSnapshot),
  };
}

/** One attachment's metadata; its signed CDN URL is used once at admission, never stored. */
function attachmentSnapshot(attachment: {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly url: string;
}): DiscordInboundAttachment {
  return {
    id: attachment.id,
    filename: attachment.name,
    sizeBytes: attachment.size,
    ...(attachment.contentType === null ? {} : { contentType: attachment.contentType }),
    url: attachment.url,
  };
}

function channelKindOf(channel: DiscordChannelLike | null | undefined): DiscordChannelKind {
  if (channel === null || channel === undefined) return "channel";
  if (typeof channel.isThread === "function" && channel.isThread()) return "thread";
  if (typeof channel.isDMBased === "function" && channel.isDMBased()) return "dm";
  return "channel";
}

function asChannelLike(channel: unknown): DiscordChannelLike | undefined {
  return channel !== null && typeof channel === "object" ? channel as DiscordChannelLike : undefined;
}

async function resolveChannel(client: DiscordClientLike, channelId: string): Promise<unknown> {
  const cached = client.channels.cache.get(channelId);
  if (cached !== undefined) return cached;
  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    const classified = classifyDiscordError(error);
    // A 404/403 proves this bot cannot reach the channel; anything else leaves it ambiguous.
    throw new DiscordTransportError("the Discord channel is not reachable", {
      outcome: classified.outcome,
      ...(classified.status === undefined ? {} : { status: classified.status }),
    });
  }
}

async function resolveMessage(
  client: DiscordClientLike | undefined,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | undefined> {
  if (client === undefined) return undefined;
  const channel = asChannelLike(await resolveChannel(client, channelId));
  if (channel?.messages === undefined) return undefined;
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return undefined;
  }
}

async function replyInteraction(
  raw: import("discord.js").Interaction,
  response: DiscordInteractionResponse,
  module: DiscordModule,
): Promise<void> {
  if (!raw.isRepliable()) return;
  try {
    // The current API spells an ephemeral reply with a message flag; `ephemeral` is deprecated.
    await raw.reply({
      content: response.text,
      ...(response.ephemeral ? { flags: module.MessageFlags.Ephemeral } : {}),
    });
  } catch {
    // The three-second window may already be closed; the durable notice still carries the result.
  }
}

/** Re-throw any Discord failure with only a status-derived outcome; the text is a fixed summary. */
function sendFailure(error: unknown): DiscordTransportError {
  if (error instanceof DiscordTransportError) return error;
  const classified = classifyDiscordError(error);
  return new DiscordTransportError(
    classified.outcome === "unknown" ? "Discord send outcome is unknown" : "Discord refused this request",
    {
      outcome: classified.outcome,
      cause: error,
      ...(classified.status === undefined ? {} : { status: classified.status }),
      ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
    },
  );
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// ── Read-only history ────────────────────────────────────────────────────────
//
// Every source is checked twice: this sender must hold ViewChannel + ReadMessageHistory there, and so
// must this bot. The current guild is the only guild, a direct-message session can only read that DM,
// private threads additionally require the sender (and the bot) to be members, and any unavailable
// permission information fails closed. Discord returns newest-first in pages of at most 100, so a read
// walks backwards with a `before` cursor and stops at the window's `since` bound.

type HistoryPermissionsLike = { has(flag: unknown): boolean };

type HistoryMembersLike = {
  readonly cache?: { get?(id: string): unknown; has?(id: string): boolean };
  readonly me?: unknown;
  fetch?(id: string): Promise<unknown>;
};

type HistoryPageLike = {
  readonly size?: number;
  values(): IterableIterator<HistoryRawMessageLike>;
};

type HistoryMessageCollection = {
  fetch(options: { limit: number; before?: string }): Promise<{
    readonly size?: number;
    values(): IterableIterator<HistoryRawMessageLike>;
  }>;
};

type HistoryThreadCollection = {
  readonly cache?: { values(): IterableIterator<unknown> };
  fetchArchived?(options: {
    type?: string;
    limit?: number;
  }): Promise<{ readonly threads?: { values(): IterableIterator<unknown> } }>;
};

type HistoryRawMessageLike = {
  readonly id: string;
  readonly content?: string | null;
  readonly type?: number;
  readonly createdTimestamp?: number;
  readonly createdAt?: Date;
  readonly author?: {
    readonly id?: string;
    readonly username?: string;
    readonly displayName?: string;
  };
  readonly member?: { readonly displayName?: string } | null;
  readonly reference?: { readonly messageId?: string | null } | null;
  readonly attachments?: { values?(): IterableIterator<HistoryAttachmentLike>; size?: number; map?(fn: (value: never) => unknown): unknown[] };
  readonly embeds?: readonly HistoryEmbedLike[];
};

type HistoryAttachmentLike = { readonly name?: string; readonly filename?: string; readonly url?: string | null };
type HistoryEmbedLike = { readonly type?: string | null; readonly title?: string | null; readonly url?: string | null };

type HistoryChannelLike = {
  readonly id: string;
  readonly name?: string;
  readonly type?: number;
  readonly guildId?: string | null;
  readonly parentId?: string | null;
  readonly parent?: HistoryChannelLike | null;
  readonly guild?: HistoryGuildLike | null;
  isThread?(): boolean;
  isDMBased?(): boolean;
  permissionsFor?(member: unknown): unknown;
  messages?: HistoryMessageCollection;
  threads?: HistoryThreadCollection;
  members?: HistoryMembersLike;
};

type HistoryGuildLike = {
  readonly id: string;
  readonly name: string;
  readonly members?: HistoryMembersLike;
  readonly channels?: {
    readonly cache?: {
      get(id: string): unknown;
      values?(): IterableIterator<unknown>;
    };
    fetchActiveThreads?(): Promise<{ readonly threads?: { values(): IterableIterator<unknown> } }>;
  };
};

function historyChannel(value: unknown): HistoryChannelLike | undefined {
  return value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? value as HistoryChannelLike
    : undefined;
}

function historyGuild(value: unknown): HistoryGuildLike | undefined {
  return value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? value as HistoryGuildLike
    : undefined;
}

function channelGuildId(channel: HistoryChannelLike): string | undefined {
  const direct = channel.guildId;
  if (typeof direct === "string" && direct !== "") return direct;
  const guild = channel.guild;
  return guild === null || guild === undefined ? undefined : guild.id;
}

function channelParentId(channel: HistoryChannelLike): string | undefined {
  const direct = channel.parentId;
  if (typeof direct === "string" && direct !== "") return direct;
  const parent = channel.parent;
  return parent === null || parent === undefined ? undefined : parent.id;
}

function isThreadChannel(channel: HistoryChannelLike): boolean {
  return typeof channel.isThread === "function" && channel.isThread();
}

function isDmChannel(channel: HistoryChannelLike): boolean {
  return typeof channel.isDMBased === "function" && channel.isDMBased();
}

function isPrivateThread(d: DiscordModule, channel: HistoryChannelLike): boolean {
  const type = channel.type;
  if (type === undefined) return false;
  const privateThread = (d.ChannelType as unknown as Record<string, number>).PrivateThread;
  return typeof privateThread === "number" && type === privateThread;
}

/** This sender's or the bot's resolved permissions on one channel; `undefined` fails closed. */
function channelPermissions(channel: HistoryChannelLike, member: unknown): HistoryPermissionsLike | undefined {
  if (typeof channel.permissionsFor !== "function" || member === undefined || member === null) return undefined;
  let permissions: unknown;
  try {
    permissions = channel.permissionsFor(member);
  } catch {
    return undefined;
  }
  if (permissions === null || permissions === undefined) return undefined;
  const has = (permissions as { has?: unknown }).has;
  if (typeof has !== "function") return undefined;
  return permissions as HistoryPermissionsLike;
}

/** Both this sender and this bot must be able to view the source and read its message history. */
function canReadSource(d: DiscordModule, channel: HistoryChannelLike, viewer: unknown, bot: unknown): boolean {
  const viewerPermissions = channelPermissions(channel, viewer);
  const botPermissions = channelPermissions(channel, bot);
  if (viewerPermissions === undefined || botPermissions === undefined) return false;
  const flags = (d.PermissionsBitField as unknown as { Flags: Record<string, unknown> }).Flags;
  const view = flags.ViewChannel;
  const history = flags.ReadMessageHistory;
  if (view === undefined || history === undefined) return false;
  const check = (permissions: HistoryPermissionsLike): boolean =>
    permissions.has(view) === true && permissions.has(history) === true;
  return check(viewerPermissions) && check(botPermissions);
}

/** A private thread is readable only for a member; the sender must be one, and so must the bot. */
async function privateThreadMember(
  channel: HistoryChannelLike,
  memberId: string,
  allowFetch: boolean,
): Promise<boolean | undefined> {
  const members = channel.members;
  if (members === undefined) return undefined;
  const cache = members.cache;
  if (cache?.has?.(memberId) === true) return true;
  if (typeof cache?.get === "function" && cache.get(memberId) !== undefined) return true;
  const fetchMember = members.fetch;
  if (typeof fetchMember !== "function" || !allowFetch) return false;
  try {
    await fetchMember.call(members, memberId);
    return true;
  } catch {
    return false;
  }
}

async function resolveHistoryMember(
  members: HistoryMembersLike | undefined,
  id: string,
): Promise<unknown | undefined> {
  if (members === undefined) return undefined;
  const cached = typeof members.cache?.get === "function" ? members.cache.get(id) : undefined;
  if (cached !== undefined) return cached;
  const fetchMember = members.fetch;
  if (typeof fetchMember !== "function") return undefined;
  try {
    return await fetchMember.call(members, id);
  } catch {
    return undefined;
  }
}

async function resolveHistoryGuild(current: DiscordClientLike, guildId: string): Promise<HistoryGuildLike | undefined> {
  // Guilds live on `client.guilds`, not in the channel cache.
  const guilds = (current as unknown as { guilds?: { cache?: { get(id: string): unknown }; fetch?(id: string): Promise<unknown> } }).guilds;
  const fromCache = guilds?.cache?.get(guildId);
  if (fromCache !== undefined) return historyGuild(fromCache);
  const fetchGuild = guilds?.fetch;
  if (typeof fetchGuild !== "function") return undefined;
  try {
    return historyGuild(await fetchGuild.call(guilds, guildId));
  } catch {
    return undefined;
  }
}

/** Discord ids encode their creation time; use it as an exclusive page cursor for `until`. */
export function discordSnowflakeAt(ms: number): string {
  const epoch = 1_420_070_400_000n;
  const value = BigInt(Math.max(0, Math.floor(ms)));
  return ((value - epoch < 0n ? 0n : value - epoch) << 22n).toString();
}

function historyMessageTimestamp(message: HistoryRawMessageLike): number | undefined {
  if (typeof message.createdTimestamp === "number" && Number.isFinite(message.createdTimestamp)) {
    return message.createdTimestamp;
  }
  const created = message.createdAt;
  if (created instanceof Date && Number.isFinite(created.getTime())) return created.getTime();
  return undefined;
}

function historyAttachmentList(message: HistoryRawMessageLike): HistoryAttachmentLike[] {
  const attachments = message.attachments;
  if (attachments === undefined) return [];
  if (typeof attachments.values === "function") return [...attachments.values()];
  if (Array.isArray(attachments)) return attachments as HistoryAttachmentLike[];
  return [];
}

/**
 * Read one source's messages inside the window, newest page first, bounded by the per-source limit.
 * Reports a source-limit warning when the cap stopped a read that may have older in-window messages.
 */
async function readHistorySource(
  d: DiscordModule,
  source: HistoryChannelLike,
  parent: HistoryChannelLike | undefined,
  query: DiscordHistoryQuery,
  budget: number,
): Promise<{ messages: DiscordHistoryMessage[]; warning: boolean }> {
  const messages = source.messages;
  if (messages === undefined) return { messages: [], warning: false };
  const cap = Math.max(0, Math.min(query.perSourceLimit, budget));
  if (cap === 0) return { messages: [], warning: false };
  const collected: HistoryMessageRow[] = [];
  let before = query.untilMs === undefined ? undefined : discordSnowflakeAt(query.untilMs);
  let capReached = false;
  for (;;) {
    const remaining = cap - collected.length;
    if (remaining <= 0) {
      capReached = true;
      break;
    }
    const pageLimit = Math.min(100, remaining);
    let page: { readonly size?: number; values(): IterableIterator<HistoryRawMessageLike> };
    try {
      page = await messages.fetch({ limit: pageLimit, ...(before === undefined ? {} : { before }) });
    } catch {
      return { messages: collected.map((row) => row.message), warning: false };
    }
    const rows = [...page.values()];
    if (rows.length === 0) break;
    let crossedSince = false;
    for (const row of rows) {
      const timestamp = historyMessageTimestamp(row);
      if (timestamp === undefined) continue;
      if (query.untilMs !== undefined && timestamp >= query.untilMs) continue;
      if (query.sinceMs !== undefined && timestamp < query.sinceMs) {
        crossedSince = true;
        break;
      }
      collected.push({ message: serializeHistoryMessage(d, row, source, parent), timestamp });
    }
    if (crossedSince) break;
    // Discord pages newest-first; the oldest row in this page becomes the next exclusive cursor.
    const oldest = rows[rows.length - 1];
    if (oldest === undefined || oldest.id === before) break;
    before = oldest.id;
    if (rows.length < pageLimit) break;
  }
  collected.sort((left, right) => left.timestamp - right.timestamp || compareSnowflake(left.message.messageId, right.message.messageId));
  return { messages: collected.map((row) => row.message), warning: capReached && collected.length >= cap };
}

type HistoryMessageRow = { readonly message: DiscordHistoryMessage; readonly timestamp: number };

function compareSnowflake(left: string, right: string): number {
  if (left === right) return 0;
  return BigInt(left.length === 0 ? "0" : left) < BigInt(right.length === 0 ? "0" : right) ? -1 : 1;
}

function serializeHistoryMessage(
  d: DiscordModule,
  message: HistoryRawMessageLike,
  source: HistoryChannelLike,
  parent: HistoryChannelLike | undefined,
): DiscordHistoryMessage {
  const author = message.author ?? {};
  const attachments = historyAttachmentList(message);
  const referenceId = message.reference?.messageId;
  const typeName = typeof message.type === "number"
    ? (d.MessageType as unknown as Record<number, string>)[message.type] ?? String(message.type)
    : "unknown";
  return {
    messageId: message.id,
    channelId: isThreadChannel(source) ? (parent?.id ?? null) : source.id,
    channelName: isThreadChannel(source) ? (parent?.name ?? null) : (source.name ?? null),
    threadId: isThreadChannel(source) ? source.id : null,
    threadName: isThreadChannel(source) ? (source.name ?? null) : null,
    authorId: author.id ?? "",
    authorName: message.member?.displayName ?? author.displayName ?? author.username ?? author.id ?? "",
    timestampMs: historyMessageTimestamp(message) ?? null,
    messageType: typeName,
    content: message.content ?? "",
    replyToId: typeof referenceId === "string" && referenceId !== "" ? referenceId : null,
    attachments: attachments.slice(0, 10).map((attachment) => ({
      filename: attachment.name ?? attachment.filename ?? "(unnamed)",
      url: attachment.url ?? null,
    })),
    embeds: (message.embeds ?? []).slice(0, 10).map((embed) => ({
      type: embed.type ?? null,
      title: embed.title ?? null,
      url: embed.url ?? null,
    })),
  };
}

/** `#name`, case-insensitive, or `category/name`; ambiguity and absence are one fixed refusal. */
async function findHistoryChannelByName(
  guild: HistoryGuildLike,
  wanted: string,
): Promise<HistoryChannelLike | "none" | "ambiguous"> {
  // `guild.channels.cache` is a Collection; `values()` is what this function needs.
  const needle = wanted.trim().replace(/^#+/u, "").trim().toLowerCase();
  if (needle === "") return "none";
  const cache = guild.channels?.cache;
  if (cache === undefined || typeof cache.values !== "function") return "none";
  const lastSegment = needle.includes("/") ? needle.slice(needle.lastIndexOf("/") + 1) : needle;
  const matches: HistoryChannelLike[] = [];
  for (const value of cache.values()) {
    const channel = historyChannel(value);
    if (channel === undefined) continue;
    const name = (channel.name ?? "").toLowerCase();
    if (name === "") continue;
    const parent = channel.parent?.name?.toLowerCase();
    const display = parent === undefined ? name : `${parent}/${name}`;
    if (needle === name || needle === display || lastSegment === name) matches.push(channel);
  }
  if (matches.length === 0) return "none";
  return matches.length === 1 ? matches[0]! : "ambiguous";
}

/** Sources of one selected channel: itself, its active threads and optionally archived threads/posts. */
async function collectHistorySources(
  d: DiscordModule,
  guild: HistoryGuildLike,
  selected: HistoryChannelLike,
  query: DiscordHistoryQuery,
  viewer: unknown,
  bot: unknown,
): Promise<{ sources: { source: HistoryChannelLike; parent: HistoryChannelLike | undefined }[]; skipped: number; warnings: DiscordHistoryWarning[] }> {
  const sources: { source: HistoryChannelLike; parent: HistoryChannelLike | undefined }[] = [];
  const warnings: DiscordHistoryWarning[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const allowed = (channel: HistoryChannelLike): boolean => {
    if (query.allowChannels.length === 0) return true;
    const ids = new Set<string>([channel.id]);
    const parentId = channelParentId(channel);
    if (parentId !== undefined) ids.add(parentId);
    return query.allowChannels.some((id) => ids.has(id));
  };
  const tryAdd = async (source: HistoryChannelLike, parent: HistoryChannelLike | undefined): Promise<void> => {
    if (seen.has(source.id)) return;
    seen.add(source.id);
    if (!allowed(source)) {
      skipped += 1;
      return;
    }
    if (!canReadSource(d, source, viewer, bot)) {
      skipped += 1;
      return;
    }
    if (isPrivateThread(d, source)) {
      const viewerMember = await privateThreadMember(source, query.viewerId, true);
      const botMember = await privateThreadMember(source, (bot as { id?: string })?.id ?? "", false);
      // Unknown or false membership fails closed: a private thread is never read on a guess.
      if (viewerMember !== true || botMember !== true) {
        skipped += 1;
        return;
      }
    }
    sources.push({ source, parent });
  };
  await tryAdd(selected, isThreadChannel(selected) ? selected.parent ?? undefined : undefined);
  if (query.includeThreads && !isThreadChannel(selected)) {
    // Active threads are listed once for the guild and filtered to this parent; forum posts live in
    // the forum's own thread collection.
    const forumPosts = selected.threads?.cache;
    if (forumPosts !== undefined && typeof forumPosts.values === "function") {
      for (const value of forumPosts.values()) {
        const thread = historyChannel(value);
        if (thread !== undefined) await tryAdd(thread, selected);
      }
    }
    const fetchActive = guild.channels?.fetchActiveThreads;
    if (typeof fetchActive === "function") {
      try {
        const active = await fetchActive.call(guild.channels);
        for (const value of active.threads?.values() ?? []) {
          const thread = historyChannel(value);
          if (thread === undefined || channelParentId(thread) !== selected.id) continue;
          await tryAdd(thread, selected);
        }
      } catch {
        warnings.push({ code: "active-threads-unavailable", sourceId: selected.id });
      }
    }
  }
  if (query.includeArchivedThreads) {
    const threads = selected.threads;
    if (threads !== undefined && typeof threads.fetchArchived === "function") {
      for (const type of ["public", "private"] as const) {
        try {
          const archived = await threads.fetchArchived({ type, limit: query.archivedThreadLimit });
          for (const value of archived.threads?.values() ?? []) {
            const thread = historyChannel(value);
            if (thread !== undefined) await tryAdd(thread, selected);
          }
        } catch {
          warnings.push({ code: "archived-threads-unavailable", sourceId: selected.id });
        }
      }
    }
  }
  return { sources, skipped, warnings };
}

async function readHistory(
  d: DiscordModule,
  current: DiscordClientLike,
  botId: string,
  query: DiscordHistoryQuery,
): Promise<DiscordHistoryRead> {
  if (query.sessionMode === "dm") {
    const dm = historyChannel(await resolveChannel(current, query.sessionChannelId));
    if (dm === undefined || !isDmChannel(dm)) return { ok: false, refusal: "forbidden" };
    const read = await readHistorySource(d, dm, undefined, query, query.limit);
    return {
      ok: true,
      snapshot: {
        guild: { id: null, name: "Direct message" },
        channel: { id: dm.id, name: dm.name ?? null },
        mode: "dm",
        messages: read.messages,
        sourcesScanned: 1,
        sourcesSkipped: 0,
        omittedMessages: 0,
        warnings: read.warning ? [{ code: "source-limit-reached", sourceId: dm.id }] : [],
      },
    };
  }
  if (query.guildId === null) return { ok: false, refusal: "guild-unavailable" };
  const guild = await resolveHistoryGuild(current, query.guildId);
  if (guild === undefined) return { ok: false, refusal: "guild-unavailable" };
  const members = guild.members;
  const viewer = await resolveHistoryMember(members, query.viewerId);
  const bot = members?.me ?? await resolveHistoryMember(members, botId);
  if (bot === undefined || bot === null) return { ok: false, refusal: "guild-unavailable" };
  // A sender who is no longer a guild member has no Discord permissions to verify: fail closed.
  if (viewer === undefined) return { ok: false, refusal: "forbidden" };

  let selected: HistoryChannelLike | undefined;
  const explicit = query.channelId !== undefined || query.channelName !== undefined;
  if (query.channelId !== undefined) {
    selected = historyChannel(await resolveChannel(current, query.channelId));
  } else if (query.channelName !== undefined) {
    const byName = await findHistoryChannelByName(guild, query.channelName);
    if (byName === "none" || byName === "ambiguous") return { ok: false, refusal: "not-found" };
    selected = byName;
  } else {
    selected = historyChannel(await resolveChannel(current, query.sessionChannelId));
  }
  if (selected === undefined || channelGuildId(selected) !== query.guildId) {
    return { ok: false, refusal: explicit ? "not-found" : "forbidden" };
  }
  // An explicit selection must itself be readable; otherwise the generic refusal keeps the reason private.
  const { sources, skipped, warnings } = await collectHistorySources(d, guild, selected, query, viewer, bot);
  if (sources.length === 0) {
    return { ok: false, refusal: skipped > 0 || explicit ? "forbidden" : "not-found" };
  }
  const messages: DiscordHistoryMessage[] = [];
  let scanned = 0;
  for (const { source, parent } of sources) {
      if (scanned >= DISCORD_HISTORY_LIMITS.maxSources || messages.length >= query.limit) break;
    const budget = query.limit - messages.length;
    if (budget <= 0) break;
    const read = await readHistorySource(d, source, parent, query, budget);
    scanned += 1;
    if (read.warning) warnings.push({ code: "source-limit-reached", sourceId: source.id });
    messages.push(...read.messages);
  }
  messages.sort((left, right) =>
    (left.timestampMs ?? 0) - (right.timestampMs ?? 0) || compareSnowflake(left.messageId, right.messageId));
  const omitted = Math.max(0, messages.length - query.limit);
  const kept = omitted === 0 ? messages : messages.slice(0, query.limit);
  return {
    ok: true,
    snapshot: {
      guild: { id: guild.id, name: guild.name },
      channel: { id: selected.id, name: selected.name ?? null },
      mode: isThreadChannel(selected) ? "thread" : "channel",
      messages: kept,
      sourcesScanned: scanned,
      sourcesSkipped: skipped,
      omittedMessages: omitted,
      warnings,
    },
  };
}
