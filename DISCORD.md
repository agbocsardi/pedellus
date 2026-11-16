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
| `dmAllowFrom` | Optional. When set, direct messages additionally require this list, so an open guild policy cannot also open private messages. It can only narrow. A literal `*` is refused: Python's wildcard DM opening is intentionally not imported. |
| `allowChannels` | Optional list of channel or thread IDs. A thread is allowed when its own ID or its parent channel ID is listed. Empty means every channel the bot can read. |
| `groupPolicy` | `mention` (default) admits a guild message only when the bot is mentioned, a raw mention token names it, or the message replies to the bot. `open` answers every message in an allowed channel. |
| `streaming` | Default true. A progressive preview message is edited while a turn runs, and the final answer edits that same message. |
| `receipts` | Best-effort `👀` receipt on the admitted message and a delayed `🔧` working indicator, both removed by the turn that painted them. `false` disables one; `delayMs` is 0–10 000. |

The block is strict: an unrecognized key is refused at startup instead of being
ignored, so a misspelling such as `allowChannel` cannot appear to narrow access
while actually leaving every readable channel open.

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
policy is satisfied. Another bot is admitted only when the operator lists it
explicitly, and then the same mention, channel and DM rules apply; an unlisted
bot is ignored and this bot's own messages are always refused, so a bot can
never answer itself.

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
  bounded quoted line explicitly labeled as untrusted data, never owner
  instructions. Names strip attribution delimiters, and quoted text escapes
  brackets and quotes so it cannot forge a host speaker prefix. Up to four attachments
  from that message are stored with the same limits and labeled
  `[from replied message by <author>]`, so "reply and tag" sees the quoted image.
  One admitted input is bounded at 16 000 characters; a longer body keeps its
  head and ends with an explicit truncation marker.
* Answers are split inside Discord's 2 000-character limit with the same
  fence-aware splitter the Telegram adapter uses, so a code block is closed and
  reopened instead of cut.
* The first message of a turn replies to the admitted message with
  `repliedUser: false`; every send and edit passes
  `allowedMentions: { parse: [], repliedUser: false }`, so no answer, notice or
  scheduled result can ping a user, role, `@everyone` or `@here`.
* A write-ahead intent is committed before every external send **and edit**, and
  cleared only with that request's result, so an accepted request that crashes
  before its local commit is quarantined as ambiguous and never repeated. A proven refusal
  (a 4xx rejection) is held for inspection immediately; a proven
  non-send (a 429 cooldown) is retried on the adapter's own scan cadence; an
  ambiguous outcome (dropped connection, timeout, 5xx) is quarantined as
  `unknown` and never resent, including after a restart. An ambiguous preview
  edit also holds the whole answer: the owner may see only a frozen preview,
  not a delivered final answer.
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
* A command whose earlier inputs keep failing transiently is retried on the
  adapter's scan cadence (bounded) while its channel stays gated, then reported
  once as unconfirmed or applied; it is never applied twice. An interrupted
  command found at reopen is reported once, never replayed.
* Host notices are chunked inside the same 2 000-character bound; a notice that
  exceeds its own cap keeps its head and ends with `… (truncated)` rather than
  dropping text silently.

## Read-only history

The model-facing `discord_history` tool reads bounded history for the current
conversation. It never sends, reacts, deletes or reads another guild.

* **Scope.** The current guild is the only guild, and a direct-message session can
  read only that DM. A message in a channel reads that channel (plus its accessible
  active/archived threads when asked); a message in a thread reads that thread. The
  model may name one other channel, forum or thread in the current guild by `#name`
  or id; naming two channels with the same name is refused, and a channel in another
  guild is refused.
* **Live authority, every call.** The adapter re-derives the session from the
  authenticated session key, re-checks the current `allowFrom`, `dmAllowFrom` and
  `allowChannels` (including thread parents), and requires durable admission
  evidence. The transport then requires **this sender's own** Discord
  `ViewChannel` + `ReadMessageHistory` on every source, as well as the bot's, and
  fails closed when permission data is unavailable. Private threads additionally
  require both to be members. An empty `allowChannels` therefore never bypasses
  Discord permissions.
* **Window and limits.** `since`/`until` accept ISO-8601 with a timezone, or `now`,
  `today`, `yesterday`, `30m`, `6h`, `2d`, `1w`. `today` and `yesterday`
  use the host process timezone, not `cron.timeZone`. `limit` is 1–2000 (default 500),
  `perSource` 1–500 (default 200), `archivedLimit` 1–100 (default 50) per public/private
  listing, `maxChars` 1–16000 (default 12000). Archived listings read one page per
  type; a full page is conservatively reported as limited, not complete. `since`
  is inclusive and `until` exclusive. Only the selected window is read; a
  per-source cap or character cut is reported, never hidden. The mandatory
  coverage envelope may itself exceed a tiny `maxChars` budget. Messages cut to
  fit make `truncated: true`; a fully read empty window remains complete.
* **Honest coverage.** The result carries the window and a `coverage` block that
  keeps three kinds of gap distinct: `messagesCut` (retrieved messages dropped
  by the character budget — exact), `sourcesUnscanned`/enumeration
  limits (sources a bound left unread — known counts or a flag), and
  `unreadMessages: "unknown"` when a per-source cap, an unread source, a failed page
  or a limited thread listing prevents counting what remains. `partial` marks a
  failed page or unusable rows, `truncated` marks any bound, and `complete` is true
  only when nothing was cut, skipped, unread or partially read. Warnings are
  deduplicated per code with an occurrence count and a bounded sample of source IDs.
  A provenance sentence says Discord text is untrusted third-party data and that
  anything outside the returned set was not read. Every message carries stable
  channel, thread, author and message IDs so an answer can cite exact evidence. A
  read that fails entirely (for example a transient Discord error) is reported as a
  failed read, not as a missing capability. Missing and unreadable channel
  selections share one model-facing refusal so it does not reveal hidden
  channel existence. Message metadata includes at most ten attachments and
  ten embeds; these are descriptors, not downloaded or fully read contents.
* **Where it is offered.** Only a scope-checked mapped Discord ordinary chat, by the
  same registry pattern as the Telegram action tool: the adapter attaches the live
  host while it runs and detaches on stop, so a stopped adapter answers every call
  with a fixed refusal. Code Mode may compose it from such a chat; the call-time
  checks are identical. It is not a `toolAllowlist` coding tool, so configuration
  cannot hand it to workers, forks, roots, scheduled runs or digest targets (and
  `workers.toolAllowlist` refuses the name outright). Its availability is
  independent of the coding-tool ceiling: `toolAllowlist: []` does not disable
  this separately configured, live, permission-checked integration.

This is narrower than the Python reference: there is no `guild_id` parameter
because another guild is never readable from this session, and no default
guild-wide scan. `channel`/`channelId` selection inside the current guild, thread
and forum-post discovery, archived public threads, joined archived private threads
and channel-name resolution are provided.

## Controls

The Discord chat offers the shared owner commands, and `/help` lists exactly
those this host implements: `/new`, `/abort` (and `/stop`), `/status`, `/model
[preset]`, `/digest [status]`, `/restart`, `/mcp` (read-only status) and `/help
[command]`. An unsupported command is refused with fixed text naming the surface
that owns it (`/history` and `/reload` are CLI-only). `//text` sends a leading slash to the
assistant literally. In a mention-gated guild a typed command follows the
mention (`@bot /status`); exactly that one leading self-mention is dropped
before parsing.

MCP login initiated by the model in a mapped Discord chat delivers its one-time
authorization URL directly to that channel and nowhere else; a channel that is
no longer authorized refuses the delivery and cancels the login. A
callback-shaped message is consumed before transcript admission and is accepted
only from the sender that owns the channel.

## Bounded and default-deny behavior

* During durable startup recovery, at most 64 Gateway message events are buffered
  in memory and replayed in order after recovery. Overflow is not admitted and
  is reported only in the journal. Application commands received during recovery
  get a fixed refusal and can be retried once startup finishes.

* At most 500 admitted items and 64 control records are kept. Further messages are
  refused at admission — the durable record is not created and the refusal is
  reported in the gateway journal, **not** in the Discord chat, because a full
  queue has no room for the notice either. This is the same bound the Telegram
  adapter has; it is not a silent drop of an admitted message.
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

* **No message/reaction action tool.** Discord history is read-only. The Python
  reference's `react` tool is Telegram-only there as well, so this port adds no
  Discord send, react or delete capability.
* **No member roster index.** Mention names come from the event, not from a
  per-guild index with previous display names, and history author names come from
  the message as Discord reported them.
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

## Dependency

`discord.js` 14.28.0 (Apache-2.0) with its `@discordjs/*` packages is a pinned
runtime dependency, imported lazily from `discord-js.ts`. A gateway without a
`discord` block never loads it, but `npm ci` installs it because the lockfile
includes it. `createDiscordJsTransport` also accepts an injected client factory;
the offline checks use that to exercise the real event, interaction and error
mapping without a token or a live Gateway.

## Checks

`tests/discord-channel.behavior.test.mjs`, `tests/discord-commands.behavior.test.mjs`,
`tests/discord-delivery.behavior.test.mjs`, `tests/discord-transport.behavior.test.mjs`
`tests/discord-js-transport.behavior.test.mjs`, `tests/discord-history.behavior.test.mjs`
and `tests/discord-lifecycle.behavior.test.mjs` run offline in
`npm run test:behavior`: a synthetic adapter transport plus an injected
discord.js client, a faux provider and a temporary store. They assert admission,
session isolation, attribution, chunking, mentions, receipts, referenced
attachments, the input bound, bots, strict config keys, chunked/withheld/
unauthorized/unknown scheduled delivery, interruption notices, restart
confirmation, deferred-control retry and exhaustion, pre-send intents, callback
interception, progressive edits, the real event/interaction/error mapping,
startup ingress capture and replay, rate-limit cooldowns, control-admission
failure, unconfirmed-control pruning, scheduled intent-commit failure, quoted-text
injection, the history read's live authority and transport permissions, and
concurrent channel startup. No token, network, live guild or paid inference is
used.
