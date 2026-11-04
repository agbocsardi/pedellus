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
- [x] Corrective review pass: pre-send intents for sends and edits, resumable deferred
      controls, channel supervisor for setup failures, mention-stripped callback
      interception, allowlisted-bot interop, strict config keys, MCP authority
      re-checks, notice chunking/truncation markers, referenced attachments, input
      bound, per-delivery feedback cleanup, injected-client transport mapping checks
- [ ] Live bot login, guild/thread/DM round trip, attachment download and rate-limit
      behavior (needs a real bot token and a supervised deployment)
- [x] Owner decided to port bounded read-only Discord history.
- [x] Implement history with current mapped-chat/sender/channel authority checks (awaiting independent review).
- [x] Resolve remaining review findings: startup ingress window and rate-limit backoff; reconcile AGENTS invariants.

## Log

### 2026-11-04 — honest history coverage after review

The history reader could return a failed page as a complete window, silently skip rows without a
timestamp, hide unread sources behind `maxSources`/the global limit, and report `omitted: 0` after a
cut. Rewritten so every gap is explicit: per-source reads report `capped`/`failure`
(`fetch-failed`/`channel-unavailable`)/`skippedRows`; the snapshot carries `sourcesUnscanned`,
`cutMessages`, `skippedMessages`, `partial`, `unreadUnknown` and `enumerationLimited` alongside the
known `sourcesSkipped`; the renderer derives `complete`/`partial`/`truncated` and reports
`unreadMessages: "unknown"` whenever a bound or failure prevents counting, never zero. Warnings are
deduplicated per code with an occurrence count and a bounded sample of source IDs. A whole-read failure
is `read-failed` (the capability is live); a missing or refused explicit channel is
`not-found`/`forbidden`. The tool description and DISCORD.md state the taxonomy.

Regressions use the real injected client for a failed second page, an unusable timestamp, a global and
DM limit, a character budget, 121 sources beyond the scan bound and a bounded archived listing, and
assert the *rendered* flags; the adapter's non-Discord/channel refusals are unchanged. Also added the
parent's fixes as permanent checks: an empty coding ceiling still offers the tool and the mapping is
restored across a reopen, and an early-rejected channel run emits no unhandled rejection.

### 2026-11-03 — full history review follow-up

Independent review confirmed permissions/privacy but blocked misleading history coverage: failed pages silently look complete, global/source limits omit no honest accounting. Coordinator fixed smaller findings before returning the substantive accounting work: supervisor records rather than rethrows an early rejected channel promise; restored mappings load when Discord history alone needs them; removed duplicate runtime registry spread; shutdown stops ingress and awaits its chain before task snapshot/transport teardown. Corrected coding-ceiling/local-timezone/startup-buffer docs. Typecheck/build and88 Discord+service-readiness checks passed; temporary delayed-settlement probe saw zero unhandled rejections and preserved original failure stage. History page failures/omission accounting and not-found classification remain for original implementer, followed by fresh review. No findings waived, no merge.

### 2026-11-04 — owner-approved history port and remaining re-review fixes

`discord_history` is a read-only model tool with a live, call-time-checked host: the
adapter derives the session from the mapped key, re-checks current admission,
`allowFrom`/`dmAllowFrom`/`allowChannels` (thread parents included) and the live
sender's own Discord `ViewChannel`+`ReadMessageHistory` on every source (the bot's
too; private threads need membership), failing closed when permissions are unknown.
The current guild is the only guild and a DM reads only that DM; no `guild_id`
parameter exists, which is narrower than Python and deliberate. Results carry an
explicit window, coverage, fixed warning codes, stable IDs and an untrusted-data
provenance sentence; a per-source cap or character budget is reported, never hidden.
The runtime offers the tool only in a scope-checked mapped Discord chat through its
own registry, so config cannot hand it to workers, forks, roots, scheduled or digest
targets (and `workers.toolAllowlist` refuses the name).

Also fixed the remaining re-review findings: ingress events between Gateway READY
and the end of durable recovery are buffered in memory (bounded, ordered) and
replayed, with a fixed refusal for commands inside the three-second window; a
validated 429 hint now opens a shared cooldown that is waited out without spending
delivery attempts (ordinary and scheduled); the AGENTS invariants now describe
Discord and the history tool accurately. Parent fixes (quoted-data escaping,
label bracket stripping, failed-admission gate release, unconfirmed pruning,
pre-request intent failures) were traced and kept, with focused regressions.

Checks: typecheck, build, 527 behaviour checks (19 new), execution checks and core
acceptance. Still no live bot/token/guild/DM/API use.

### 2026-11-03 — coordinator fixes and owner history decision

Fresh re-review verified previous high findings fixed but found quoted third-party attribution injection and smaller lifecycle edges. Coordinator escaped quoted-body bracket/quote syntax, marked it untrusted, stripped label brackets (including filenames/referenced authors), released failed-admission control gates, corrected unconfirmed-notice/control identity pruning, and distinguished pre-request scheduled intent failures from ambiguous external sends. Documented frozen-preview ambiguity and immediate 4xx hold. Updated affected existing expectations. Typecheck/build and all55 Discord checks passed, plus temporary adversarial attribution output checks and diff --check. These changes await fresh independent review; nothing waived. Owner explicitly approved a bounded read-only history port. Existing implementer will continue that substantive feature and resolve startup/backoff transport issues without merging email.

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

### 2026-11-03 — corrective pass after independent review

Fixed every reported finding rather than waiving it: H1 now writes a true
pre-send intent before each send/edit and clears it only on acceptance, so an
accepted-but-uncommitted request is quarantined on reopen; H2 retries deferred
commands on the scan cadence, keeps the channel gated while unresolved, and
reports an exhausted command once; H3 replaced the two-phase channel list with a
supervisor that a *setup* failure drains before the gateway closes. Also: callback
interception now runs on the mention-stripped body; allowlisted other bots are
admitted again; strict config keys; MCP ownership and scheduled delivery re-check
`allowChannels`/`dmAllowFrom`; notices are chunked with a truncation marker;
referenced attachments are stored; the input bound is enforced; receipts clear
per delivery; the transport is exercised through an injected discord.js client.

Checks after the pass: typecheck, build, 55 Discord checks, the full behaviour
suite, execution checks and core acceptance.

Next: live acceptance with a real bot token, then decide on a model-facing
Discord tool.
