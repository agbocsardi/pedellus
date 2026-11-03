# 2026-11-03 Discord channel

Isolated branch `t3/discord-channel-integration` from local `main`
`c193fc4933fe8aef3b2740dbc76b7020efb708ec`. The parent plan
(`2026-11-03_discord-email-channels_TODO.md`) lives in the parent checkout and is
not copied here; this file is the Discord channel's own work order and log.

## Checklist

- [x] Read the Python Discord channel and its tests; list the product behavior to port
- [x] Trace Telegram ingress/outbox/controls/cron/MCP paths in this port
- [x] Add opt-in validated `discord` config (token env reference, sender/channel/DM
      allowlists, mention/open guild policy, receipts, streaming); no wildcard
- [x] Add the narrow transport contract and the real discord.js transport (lazy import)
- [x] Implement ingress admission, session identity (guild/thread/DM), attribution,
      mention resolution, quoted context and bounded attachments
- [x] Implement durable delivery: write-ahead intent, chunking, non-pinging replies,
      preview edits, typing/read/working feedback and cleanup, unknown quarantine
- [x] Implement the shared owner controls (typed + application commands), durable
      control records, restart confirmation/refusal and interrupted-command recovery
- [x] Wire scheduled results and interruption notices through the channel-neutral outbox
- [x] Attach the MCP owner surface and consume OAuth callbacks before model admission
- [x] Start every configured channel concurrently in the gateway CLI
- [x] Register offline regressions in `npm run test:behavior`
- [x] Document setup, intents, privacy, limits and parity gaps in `DISCORD.md`
- [ ] Live bot login, guild/thread/DM round trip, attachment download and rate-limit
      behavior (needs a real bot token and a supervised deployment)
- [ ] Decide whether a model-facing Discord action/history tool is wanted (unported)

## Log

### 2026-11-03

Implemented the channel as three modules: `src/channels/discord.ts` (adapter and
durable state), `src/channels/discord-js.ts` (real discord.js 14.28.0 transport,
imported lazily) and `src/channels/discord-transport.ts` (narrow contract plus
pure splitting/label/failure rules). Config gained a validated `discord` block;
`src/help/commands.ts` gained the `discord` surface; `src/runtime.ts` now admits
cron delivery records for `discord:` origins; `src/cli.ts` starts all configured
channels concurrently through the exported `runChannels` (a failing channel asks
for the shared shutdown first, and the first failure keeps its own stage).

Decisions: message snowflakes are the Durable request IDs (dedupe); the channel
state conversation is `discord:<botId>:channel-state`; attachments are stored at
admission because Discord's CDN URLs expire; `repliedUser: false` plus
`parse: []` is applied to every send and edit; a proven 4xx is held, a 429 is
retried on the adapter scan cadence, and an ambiguous outcome is quarantined.

Checks: `npm run typecheck`, `npm run build`, the four new Discord test files
(38 checks) and `npm run test:behavior` (491 checks before the doc-only edits).

Next: live acceptance with a real bot token, then decide on a model-facing
Discord tool and on referenced-message attachments.
