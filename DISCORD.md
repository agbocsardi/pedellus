# Discord channel

The Discord adapter is opt-in, adds no tool authority and runs inside the same
gateway process as the CLI and Telegram. It is a conversation surface: the
Durable agent loop, storage, tool policy, cron, workers, memory and MCP authority
are unchanged. `src/channels/discord.ts` owns ingress admission and the durable
channel outbox; `src/channels/discord-js.ts` is the real discord.js transport;
`src/channels/discord-transport.ts` is the narrow contract plus the pure text and
failure rules both sides share.

Status: offline-verified only. No live bot login, guild, channel, DM, attachment
download or rate-limit interaction has been exercised in this repository. Treat
the first deployment as a supervised trial.

## Configuration

Add a `discord` block to the explicit configuration file. Absent means no
Discord code, dependency or connection is loaded.

```json
{
  "discord": {
    "tokenEnv": "DISCORD_BOT_TOKEN",
    "allowFrom": ["111111111111111111"],
    "dmAllowFrom": ["111111111111111111"],
    "allowChannels": ["222222222222222222"],
    "groupPolicy": "mention",
    "streaming": true,
    "receipts": { "read": "👀", "working": "🔧", "delayMs": 2000 }
  }
}
```

| Key | Meaning |
| --- | --- |
| `tokenEnv` | Environment variable **name** holding the bot token. A missing or blank variable fails startup with a fixed diagnostic; the token is never read from config, a transcript or channel text. |
| `allowFrom` | Required, non-empty list of user snowflakes. There is no wildcard. Anyone else is ignored silently. |
| `dmAllowFrom` | Optional. When set, direct messages additionally require this list, so an open guild policy cannot also open private messages. It can only narrow. |
| `allowChannels` | Optional list of channel or thread IDs. A thread is allowed when its own ID or its parent channel ID is listed. Empty means every channel the bot can read. |
| `groupPolicy` | `mention` (default) admits a guild message only when the bot is mentioned, a raw mention token names it, or the message replies to the bot. `open` answers every message in an allowed channel. |
| `streaming` | Default true. A progressive preview message is edited while a turn runs, and the final answer edits that same message. |
| `receipts` | Best-effort `👀` receipt on the admitted message and a delayed `🔧` working indicator, both removed after the answer. `false` disables one; `delayMs` is 0–10 000. |

### Discord application setup

* Create the application and bot, then copy the **bot token** into the
  environment variable named by `tokenEnv`.
* Enable the **Message Content** privileged intent; without it guild message
  bodies arrive empty and every guild message is refused as unaddressed.
  The client requests `Guilds`, `GuildMessages`, `DirectMessages` and
  `MessageContent`, plus the `Channel` partial so direct messages are delivered.
* Invite the bot with the `bot` and `applications.commands` scopes so the
  `/new`, `/abort`, `/stop`, `/status`, `/model`, `/digest`, `/restart` and
  `/help` menu entries can be registered. Typed commands work without the
  second scope; registration failure is reported once and never blocks ingress.
* Guild command registration is global and may take time to appear. Slash
  commands answer immediately with a private "Processing…" acknowledgement; the
  real result follows as one ordinary channel message through the durable queue.

## Authority

Ingress is admitted only when all of these hold: the author is in `allowFrom`;
the author is not this bot; the message is not a Discord system message; for a
direct message `dmAllowFrom` (when set) also allows the author; for a guild
message the channel (or thread parent) is in `allowChannels` and the guild
policy is satisfied. Another bot needs an explicit `allowFrom` entry; its own
messages are never echoed.

The session key is derived from that evidence only:

| Placement | Session key |
| --- | --- |
| Guild channel | `discord:<botId>:guild:<guildId>:channel:<channelId>` |
| Thread | `discord:<botId>:guild:<guildId>:thread:<threadId>` |
| Direct message | `discord:<botId>:dm:<channelId>` |
| Adapter state | `discord:<botId>:channel-state` |

Threads are separate conversations from their parent channel and carry one
bounded line naming the parent channel ID, so the model can tell where it is.
The state key never becomes chat history, a cron owner, a digest source or a
worker spawner.

Admission evidence (bot ID, sender, channel kind, parent ID, instant) is stored
durably and re-checked before every later delivery: scheduled results and
interruption notices are withheld when the evidence is missing and marked
unauthorized when the original sender has left `allowFrom`.

## Delivery

* Inputs are attributed as `[DisplayName (id=<snowflake>)]: text`, with mention
  tokens resolved to names when the event carried them. A reply contributes one
  bounded quoted line from the message it answers.
* Answers are split inside Discord's 2 000-character limit with the same
  fence-aware splitter the Telegram adapter uses, so a code block is closed and
  reopened instead of cut.
* The first message of a turn replies to the admitted message with
  `repliedUser: false`; every send and edit passes
  `allowedMentions: { parse: [], repliedUser: false }`, so no answer, notice or
  scheduled result can ping a user, role, `@everyone` or `@here`.
* A write-ahead intent is committed before every external send. A proven refusal
  (a 4xx rejection) is held for inspection after the retry bound; a proven
  non-send (a 429 cooldown) is retried on the adapter's own scan cadence; an
  ambiguous outcome (dropped connection, timeout, 5xx) is quarantined as
  `unknown` and never resent, including after a restart.
* Completed cron results and startup interruption notices are read from the
  gateway's channel-neutral durable outbox, delivered chunk by chunk with the
  same intent protocol, and marked `delivered`, `failed`, `withheld` or
  `unauthorized`. They are ordinary messages with no reply reference.
* The message snowflake is the Durable request ID, so a repeated Gateway event
  cannot become a second turn. A steered message settles with the same committed
  answer as the run it joined, and exactly one admitted message delivers it.
* `/restart` is the host's full-process replacement; every requesting channel is
  recorded durably and told once when a replacement process is live, or told that
  the host refused. `/status` names only the bounded gateway-wide active-work
  count.

## Controls

The Discord chat offers the shared owner commands, and `/help` lists exactly
those this host implements: `/new`, `/abort` (and `/stop`), `/status`, `/model
[preset]`, `/digest [status]`, `/restart`, `/mcp` (read-only status) and `/help
[command]`. An unsupported command is refused with fixed text naming the surface
that owns it (`/history` is CLI-only). `//text` sends a leading slash to the
assistant literally. In a mention-gated guild a typed command follows the
mention (`@bot /status`); exactly that one leading self-mention is dropped
before parsing.

MCP login initiated by the model in a mapped Discord chat delivers its one-time
authorization URL directly to that channel and nowhere else; a channel that is
no longer authorized refuses the delivery and cancels the login. A
callback-shaped message is consumed before transcript admission and is accepted
only from the sender that owns the channel.

## Bounded and default-deny behavior

* At most 500 admitted items and 64 control records are kept; further messages
  are refused visibly, never silently dropped.
* At most 4 attachments per message, each bounded by the shared 20 MiB media
  limit; originals are stored under `<workspace>/media/discord/` and are never
  auto-deleted. Discord's signed CDN URL is used once at admission and never
  stored.
* Active replies and notices are capped at 8 each; scheduled deliveries at 4
  concurrent records with one delivery per channel at a time.
* The admitted-identity list is bounded at 1 000, origin evidence at 1 000
  channels, with the oldest binding evicted and its diagnostic recorded.

## Known gaps and differences from the Python reference

These are deliberate or unported, not implied capabilities:

* **No model-facing Discord tool.** The Python reference exposes a Discord
  message-history tool; this port offers no channel tool on Discord. Replies,
  reactions and history reads therefore come from the ordinary answer path only.
  Python's `react` tool is Telegram-only there as well.
* **No referenced-message attachments.** A reply's quoted text is fetched
  (bounded), but images attached to the message being replied to are not pulled
  into the turn. Python downloads up to four.
* **No member roster index.** Mention names come from the event, not from a
  per-guild index with previous display names.
* **No local transcription.** Stored audio attachments are labeled by locator and
  never transcribed, matching the Python Discord channel.
* **No message deletion.** A sender removed from `allowFrom` after admission is
  not submitted and their admitted record is dropped without deleting the
  original Discord message.
* **No `send_progress` commentary messages.** Tool-call hints, `send_progress`
  and gateway-proxied HTTP are not implemented; the discord.js client uses its
  own REST/Gateway connection.
* **No deferred-control persistence.** A command whose earlier inputs keep
  failing is retried in-process up to a bound and then reported unconfirmed; a
  reopen reports an interrupted command once instead of replaying it.
* **Gateway event loss.** The Discord Gateway is not an acknowledgement
  protocol: a dropped socket can lose events, and duplicates are deduplicated by
  message ID, not replayed.

## Checks

`tests/discord-channel.behavior.test.mjs`, `tests/discord-commands.behavior.test.mjs`,
`tests/discord-delivery.behavior.test.mjs` and `tests/discord-transport.behavior.test.mjs`
run offline in `npm run test:behavior`: a synthetic transport, a faux provider
and a temporary store, with admission, session isolation, attribution, chunking,
mentions, receipts, chunked/withheld/unauthorized/unknown scheduled delivery,
interruption notices, restart confirmation, control recovery, progressive edits
and the concurrent channel startup all asserted. No token, network, live guild
or paid inference is used.
