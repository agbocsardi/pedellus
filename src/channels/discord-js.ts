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
