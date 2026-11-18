# Durable Nanobot

TypeScript port of Nanobot on the Pi 1.5.0 stack (`@earendil-works/pi-ai`,
`pi-durable`, `chord`). Independent project: the Python fork at
`~/projects/pi-nanobot` is reference material only — never merge or rebase onto
it, and port individual changes by hand.

Status is experimental. The owner's separate test-bot user service is deployed
from source; production memory/workspace migration and broader live acceptance
remain pending. Never stop or replace Python's production bot as part of checks.

## Commands

```bash
npm ci --offline          # install the pinned dependency tree
npm run typecheck         # tsc --noEmit
npm run build             # tsc -> dist/
npm run test:behavior     # behaviour checks (builds first; count grows with coverage)
npm run test:execution    # 2 guarded host policy checks (builds first)
npm run --silent test:core-acceptance  # offline core acceptance JSON (builds first; see ACCEPTANCE.md)
npm start -- gateway --config config.json   # single local owner
npm start -- agent --config config.json     # attach a terminal
```

The optional package executable is `durable-nanobot`; never install an alias
named `nanobot` over the Python command. `npm link --offline` is an explicit
operator step after dependency installation, not part of checks. Package bin,
`npm start` and user-unit templates use `bin/durable-nanobot.mjs`, which imports
source with pinned `tsx` in the same process; restart reloads edits without tsc
or a watcher. The launcher disables esbuild's persistent sync compiler worker so
native execve restart does not leave an unreapable compiler child. Keep the
source/compiled error boundary shared through `src/cli.ts:runCli`. Native Durable
`onReport` and gateway/CLI failure boundaries emit bounded journal diagnostics through
`src/failure-diagnostics.ts`; never replace that formatter with raw exception/payload logging.
`npm run typecheck` remains separate; `npm run build` still supports compiled
output/tests. Units use an absolute Node path and do not need a CLI link. Code
edits need restart only; unit edits additionally need daemon-reload.

## Layout

- `src/runtime.ts` — `openGateway`: storage, config-scoped tool policy,
  context, cron and the conversation-facing host API.
- `src/cli.ts` — launch surface: `gateway` owns the single runtime, storage,
  tools and channels; `agent` (or legacy bare `--config`) attaches a terminal to
  it and never opens a second runtime; also the stopped-store recovery command.
  Without `--config`, gateway/agent/recovery read the fixed runtime-home default
  `~/.durable-nanobot/config.json`; an explicit `--config` is the secondary-instance
  override. `systemd/` holds the foreground user-unit examples documented in
  `SERVICE.md`; checks neither install nor start them.
  The agent loop itself is Durable's; this repository is the nanobot-specific
  layer around it (context, tools, execution, automation, channels, providers).
- `src/local/` — private Unix-socket protocol, gateway server and CLI client that
  carry the bounded terminal conversation surface; no public listener.
- `src/index.ts` — small host entry surface (config, gateway, workspace host,
  context/Code Mode factories, recovery, CLI main); import subsystems directly.
- `src/help/` — declarative help text only: the process `--help` pages and the
  one surface-tagged slash-command catalogue that the CLI, Telegram and both
  `/help` paths render. Each host decides which catalogued names it offers.
- `src/mcp/` — explicit MCP server config, the pinned `@earendil-works/pi-mcp`
  client lifecycle, deferred `mcp__<server>__<tool>` registrations, namespace
  summaries, the call-time MCP authority hook, direct owner-authorized management,
  the login lifecycle and the channel-neutral owner-surface registry.
- `src/media/` — shared attachment storage under the workspace, the local
  uv/faster-whisper transcriber, and the configured vision handoff; the fixed
  CPU/`small`/`int8` speech helper is `scripts/local-transcribe.py`. Telegram
  ingress lives in `src/channels/telegram.ts` and `src/channels/telegram-media.ts`.
- `src/providers.ts`, `src/auth/` — native Pi AI provider registration (native IDs,
  documented legacy aliases, explicit `providers` entries), the pinned
  `credentials.<provider>` environment reference, Durable's own file
  `CredentialStore` under the canonical `dataDir`, and the terminal-only
  `login`/`logout` commands. No provider whitelist, no Pi credential store.
- `src/model-catalog.ts`, `src/model-catalog-cli.ts` — Pi-style pi.dev catalog
  shards: explicit terminal `models refresh|list`, validated atomic last-good
  `model-catalog.json` under `dataDir`, offline overlay at open and `/reload`.
- `src/automation/` — cron timer/run tasks, persistent automation conversations, the
  model-facing `cron` tool and the owner's terminal scheduling console
  (`cron create|list|show|cancel` over the private local socket).
- `src/workers/` — bounded ordinary background workers as native Durable tasks:
  the opt-in `worker` start/list/inspect/cancel tool, an explicit
  shared-or-worktree workspace per task, captured child authority and one internal
  result event to the spawning agent. A worker is not an origin and gets no worker
  tool; its child keeps the native Code Mode compositor over its captured tools
  only, so it cannot delegate further.
- `src/execution/` — guarded host environment and the optional Bubblewrap shell.
- `src/context/` — bootstrap/memory/skills snapshots, skill tool, workspace host.
- `src/history/` — durable store identity, reset-delimited episodes, background
  summaries, rebuildable message/tool/summary search, and legacy history SDK/local
  APIs. Original transcript entries remain authoritative; see
  [MEMORY_RECALL.md](./MEMORY_RECALL.md) for the approved three-tool model-facing recall contract.
- `src/channels/` — Telegram and opt-in Discord adapters (`discord.ts` adapter,
  `discord-js.ts` the real discord.js transport, `discord-transport.ts` the narrow
  contract and pure text/failure rules), plus the opt-in `app` channel (`app.ts` adapter
  with the durable cursor event log, `app-listener.ts` the loopback HTTP+WebSocket
  mechanics behind `tailscale serve`, `app-protocol.ts` the shared wire contract, and
  `app-operator-cli.ts` the terminal `app pair|devices|revoke` console; see [APP.md](./APP.md)).
  Channels start concurrently and never await one another.
  `telegram-rich.ts` owns the rich-message limits, fence-aware splitting and the literal-text
  escaping the adapter uses for host notices.
- `plan/` — historical roadmaps and implementation evidence, not a work queue.

## Invariants worth not breaking

- Shipped CLI/Telegram/Discord coding tools come directly from config `toolAllowlist`;
  empty disables them. Config remains the only authority for SDK gateway callers.
  `workers.toolAllowlist` is an independent ordinary-worker ceiling: omitted inherits
  configured chat tools; `[]` grants no tools; explicit worker-only coding names never
  widen foreground, cron or digest authority. `mcp` expands to connected tools at launch,
  or exact MCP registration names can be selected. Integrations still require their
  own opt-ins; Telegram, Discord history, cron and recursive worker grants are forbidden.
  Only validated mapped chats receive foreground authority, and
  every admitted Telegram or Discord user shares the configured workspace/tools. Raw, root and
  state conversations remain denied, as do forks except the following narrow case.
  Only an ownerless fork created by the app channel's `thread.create {from}` from a validated,
  open app chat may be admitted as an ordinary mapped chat, and only under its own exact
  registered app session key: at ingress and at reopen the gateway resolves the fork's recorded
  app message in the conversation its native parent names to a committed user or assistant
  transcript entry and requires it to equal the native fork cutoff at every hop of a
  fork-of-fork chain, with each hop's durable enrollment, exact session mapping and parent
  cutoff agreeing; the enrollment record is the authority, and the registry's displayed
  `origin` is metadata. It gets the source chat's ordinary policy, not inherited grants
  or new authority. Every other fork remains denied, and the exception is never
  conversation-wide: a key naming anything but an ordinary chat or a validated enrolled
  app fork is refused at ingress, before it can become a cron owner or receive chat policy.
  A scheduled run's automation
  conversation is a distinct class: ownerless, recorded by its origin's cron
  documents and by its own class marker, adopted only while that marker names
  the same origin and job and the conversation is still unforked, and restored
  from every mapped conversation's own marker (with the origin's documents naming
  further candidates for a live run's unmapped target) before a reopen admits any
  mapped key as chat, so a lost pointer is not a lost class. That restore belongs to
  the cron-enabled open path: with `cron.enabled` false it does not run, so a stale
  key naming an automation conversation in a store whose cron was since disabled is
  admitted as chat. Open installs no cron
  owner or context snapshot for a mapped key naming the root, a task-owned
  conversation or a fork outside the registered app exception. Such a conversation is never a
  chat, an origin, a digest
  source, a worker, an MCP/Code Mode/compositor scope or a scheduling scope.
  Isolated cron runs capture an origin subset bounded by current config, prepare it
  per run (including its workspace context), and lose it on completion. The subset may include
  the origin's read-only recall and exact connected MCP names, directly offered without Code Mode;
  never MCP management/login, delegation, classifiers, channel actions or scheduling. Separate
  call-time capture checks gate recall/MCP. Live MCP changes and reopen permanently prune the
  capture, even with no coding tools; re-enabling never restores a removed grant. Idle automation
  conversations have no such scope, and persistent history confers no permission.
  The `skill`, `cron`, `memory_search`, `memory_browse`, `memory_read`, `worker`, `ask_user`,
  `mcp` management and scoped `telegram` tools grant no coding-tool authority and
  are exempt from the coding-tool hook, so enabling a coding tool never suppresses them.
  Memory recall is enabled by default for validated mapped chats; the SDK's
  `agentHistory: false` disables it. Worker and live isolated-run recall require exact captured grants;
  isolated-run recall is rechecked against its authenticated origin on every call, never its own history;
  legacy `Gateway.history*` SDK/local APIs and their tests do not widen model-facing
  or captured worker authority. MCP management can write server configuration and launch host-level stdio processes; it is limited
  to authenticated mapped chats, with login additionally requiring a unique live
  owner surface. Memory recall remains read-only over mapped chats; legacy
  history SDK/local calls do not grant model-facing authority. Telegram actions
  additionally require a live adapter, current private-chat
  admission and observed same-chat targets. In the same intent commit, a fresh call ID is refused
  when its same-chat/kind/target/payload effect has an intent, sending, unknown or partially delivered
  predecessor. Unknown and failed/denied partial-delivery records are never evicted in either pruning
  path; a full log refuses. This is exact-effect matching, not detection of reworded/retargeted sends,
  and it does not fence ordinary answers, scheduled outbox deliveries or Discord. Discord is a second opt-in channel:
  `discord.allowFrom` is a required explicit sender list (no wildcard) and
  `dmAllowFrom`/`allowChannels` narrow direct messages and guild channels, with a
  mention-or-reply guild policy unless `open`; the session key is host-derived and
  an allowlisted other bot is admitted only through that same evidence. Its durable
  outbox, control records, scheduled/interruption delivery and MCP owner surface
  mirror Telegram's, and both channels start concurrently without awaiting each
  other. The read-only `discord_history` tool is offered only in a mapped Discord
  ordinary chat: the live adapter re-checks that exact session and sender, the
  current configuration, the current guild (a DM can read only that DM) and the
  sender's own Discord ViewChannel/ReadMessageHistory permissions (private threads
  also require membership), failing closed when permissions are unknown. It is
  independent of `toolAllowlist`, is never inherited by workers, forks, roots,
  scheduled or digest targets, and detaches with the adapter. Unknown external
  outcomes are retained, never blindly retried or evicted. The `app` channel is a third opt-in
  surface: one loopback-only HTTP+WebSocket listener (bind fixed to 127.0.0.1, published only with
  `tailscale serve`, Tailscale identity headers ignored), speaking the sibling `durable-app`
  repository's protocol v2 only. All devices share `main` (`app:chat`) and up to 50 open side
  threads with separate host-derived keys. Manual archive aborts that chat's turn; idle archive
  (default 14 days) skips running and queued work. An archive refuses app send/control; it does
  not reset or delete the chat. Cron delivery restores the original thread before appending its
  result; if all slots are occupied, it waits in the outbox. Devices authenticate solely with a
  cookie token stored as a hash, created from a single-use ten-minute console code
  (`durable-nanobot app pair`, exact-label `revoke` over the private local socket). Egress is the
  adapter's one durable cursor-numbered event log across threads (at-least-once, deduplicated by cursor on the
  device, replayed after `hello`, trimmed by per-device `ack`s): because retransmission is
  idempotent there is no external-send intent to quarantine — the log append is the delivery, the
  deliberate reconciliation of Telegram's held-unknown boundary. `send` and `thread.create` keys
  are idempotent for at least seven days; send admission precedes submission with a stable request id.
  Per-thread `control` new/abort/status reuse the Telegram control records, gating and held
  acknowledgements, with results as `message{role:"notice"}` events and `/new` as a durable
  `divider`. Cron results and interruption notices arrive through the same channel-neutral
  outbox to their original thread, deduplicated by origin and record id and authorized by that
  thread's own admission evidence. An app chat is not an MCP-login or `ask_user` owner surface: the protocol defines no event that
  could carry a one-time URL or a question without persisting it, so a mapped app chat cannot
  start an MCP login, and callback-shaped input is intercepted before admission and never stored.
  No new tool authority exists.
- Owner message placement is `followUpMode`, config-only and default `followUp`
  (historical queueing): `steer` submits a CLI or Telegram owner input with native
  `whenBusy: "steer"` so it joins the running turn after its tool round. Internal
  worker and digest submissions are unchanged. Owner inputs queue if the observed
  run is foreign, the chat has an admitted origin occurrence, or the chat is idle.
  With steering enabled an origin occurrence defers while a run or queued steer
  exists, then submits with native busy rejection. Other queued follow-ups can
  still precede it. Its checkpoint persists the first deferred admission: after
  five minutes it fails visibly through the existing outbox, without withdrawing
  owner input; retries are one second apart. Isolated cron and non-steering hosts
  keep their previous behavior. The owner gate reads before submission, so a run
  replaced in that narrow gap can still receive a steer and cause duplicate
  cron/chat delivery; that residual is explicitly documented, not claimed closed. The harness always uses native `steeringMode: "all"`: every queued steer is
  placed together at a boundary, including worker steers. Telegram follow-up-mode inputs have a
  bounded 700 ms idle coalescing window (at most three extensions, eight messages and 8,000 input
  characters); sender, same-chat notice and control boundaries stop merging, while steer placement
  is unchanged. Reactions are bounded passive context for the next owner input, never model turns. A steer
  that arrives at the final boundary is placed there and answered by the following
  run. Telegram stores the requested mode with the admitted message, and an absent
  or unrecognized value is conservatively follow-up queueing. A committed answer is
  the shared identity: inputs one run consumed settle with it, so exactly one
  admitted record — the earliest native submission among them — delivers that
  answer once, retires every still-pending sibling in its own completion commit,
  and never lets an ambiguous or held outcome reach a sibling. Only the run's first
  input publishes the shared live preview. A failed run has no such identity and
  Durable exposes no run reference at settlement, so failures are never grouped by
  their reason text: each consumed message reports its own fixed notice, and a held
  or unknown notice is never the owner of a later unrelated failure. The terminal
  reports one `Turn ended` per shared run only from the run's first native input
  observed in a committed snapshot, never from the error text; an input whose run
  membership was never observed reports its own end.
- Provider spellings are native Pi AI IDs, the documented legacy aliases or
  custom `providers` keys; there is no application provider whitelist. A
  `credentials.<provider>` reference pins that one environment variable: when it
  is unset or blank, resolution fails closed and never falls back to the
  provider's ambient variables. A stored login credential wins over the
  reference, and two configured spellings for one native provider may not name
  different references. A pi.dev catalog overlay (explicit `models refresh` only,
  never at startup or from a turn) only makes native model metadata resolvable;
  it never widens `allowedModels`/presets. Entries are field-projected (no sampling
  overrides; compatibility limited to bundled keys/values, unbundled fallback lists
  dropped), and entries with an unknown type/API or an unbundled base URL/header
  set are skipped, so a catalog neither renames request models nor redirects credentials.
  The credential store is Durable's private file under the
  canonical `dataDir` (never Pi's), and `login`/`logout` are explicit terminal
  commands that never run at startup or from a chat turn.
- Classifiers are default-deny: at most one `classifierModel` pair, which must be a
  classifier-type model in the registered catalog, is reachable only through
  native Code Mode `models.*` from an authenticated mapped chat or a live ordinary
  worker. The model identity is exact and checked at call time (a forged catalog
  object cannot substitute it), catalog discovery lists only that model and no
  image models, and work, cron, digest, root, unregistered forks, raw, retired-worker and other
  task-owned scopes get no classifier. A worker capture stores the identity, so a
  removed or changed configuration prunes it permanently and a later re-enable
  cannot resurrect it. Image generation is not registered; the native
  `models.generateImages` script global name cannot be filtered from Durable's
  frozen `models.*` map, so it fails as an unregistered tool without a model call.
- Named model presets define provider/model/thinking in config. CLI preset switches
  are temporary: a CLI reattach keeps the temporary selection, while a gateway
  restart or reopen restores the configured preset without rewriting prepared
  dispatches. Direct-model (non-preset) selection retains its persisted semantics.
- CLI-only `/reload` applies foreground model/preset/direct-thinking and credential-reference
  changes from a fully validated config file. Direct↔preset transitions and unrelated startup
  changes require restart. Every nonterminal task or queued input blocks reload except sleeping
  native cron timers, so no captured work resumes under changed credentials. Managed MCP edits
  are reflected in the live baseline; unapplied disk edits are refused. Config is re-read inside the
  policy commit before writes, though an external edit after that last read can remain unapplied
  until another explicit reload/restart (no filesystem CAS). Only authenticated mapped chats are
  repolicied, and pinned background models remain allowed. A matching stored policy-revision
  commit publishes registry/defaults through synchronous native `observeCommits`, never beforehand.
- `ask_user` is model-only, sole-tool-round delivery to the unique authenticated mapped-chat owner
  surface (CLI or Telegram), never worker, isolated cron, digest, root, unregistered fork or state authority.
  It ends the tool round without parking tasks; answers arrive as ordinary later inputs. Button claims
  and typed answers settle with admission in one commit; typed text answers the oldest delivered
  question for that exact session. `/new` cancels pending questions. Unknown external sends are
  quarantined and retained, never reported as definite failure, resent or evicted to admit more.
  Missing/ambiguous surfaces refuse; Discord has no question surface. Origin-mode cron shares its
  ordinary chat class and can ask, unlike isolated scheduled-run conversations.
- Telegram-only `/notices` lists unknown non-answer host notices and dismisses exact same-chat
  IDs without resending or touching model/scheduled answers. Interruption notices retain failed
  dismissal provenance in the outbox; pending control/restart acknowledgements leave the queue only
  in the commit that archives their original text and unknown outcome (100 records, refuse when full).
  Typing refreshes represent only active provider generation, never tool work, deferred polls,
  retry backoff or background keepalives. Worker status distinguishes running/waiting/queued.
- Shared CLI, authenticated Telegram and authenticated Discord owner controls are `/new`,
  `/abort`/`/stop`, `/status`, `/model`, `/digest` and `/digest status`, plus `/restart` and
  the read-only `/mcp` status command, advertised only where the host implements
  them. MCP configuration and login are ordinary model-management requests in an
  authenticated mapped chat, not slash approvals. `/model` selects one
  configured preset for that chat only; `/status` is bounded read-only metadata
  with no model call; `/new` starts a new context and
  rebuilds the assembled workspace prompt, so a host with a prompt snapshot
  refuses it while that chat runs instead of half-applying; `/restart` is the
  host's full-process replacement (same executable, argv and environment through
  POSIX `process.execve`, after normal teardown), never a model tool, daemon or
  supervisor. One host gate shared by the local CLI and Telegram refuses it with
  fixed text while live work would be interrupted: running, queued, waiting or
  finishing tasks (generation, tool, compaction, worker, digest, cron run).
  Sleeping native timers and parked blocked tasks are not active work, so an
  armed schedule never blocks indefinitely. A refusal acknowledges nothing, tears
  down nothing and may be retried after finishing or aborting; `/status` names
  only the bounded gateway-wide count, and the inspect-then-teardown check is not
  atomic, so work admitted in that window is not protected.
  The CLI flushes its acknowledgement before restart tears down connections and
  does not wait for the replacement; an authenticated Telegram `/restart` records each requesting
  chat durably in the same applied commit, and the replacement posts one ordinary notice per chat
  and clears them, while a host refusal reports that nothing was restarted instead. A sender the
  live allowlist no longer admits gets no notice.
  Prompt rebuild and the idle reset marker share one commit across all channel attachments.
  `/refresh` is CLI-only; browsing, compaction and local attachments also remain CLI extras.
- A startup-blocking prepared dispatch (`pi.generation` request/poll or
  `pi.compaction` summarize) whose pinned context still carries a Nanobot section
  is cancelled automatically through native `abortTask` after the prepared-model
  authority scan accepts it. The gateway then opens and records one bounded,
  deduplicated interruption notice in the origin mapped chat's existing durable
  channel outbox, cleared with a small session-scoped mark in one commit. Notice
  text is class-aware: an owner turn keeps the manual continue suggestion, worker
  or scheduled work says background work was interrupted, a digest says its
  unacknowledged batch is offered again, and a compaction says no action is needed.
  No checkpoint is rewritten, no provider/tool call or input is retried, no model
  turn is started and no continuation is nudged; stored transcript and committed
  progress stay, while external effects and provider billing are not undone or
  guaranteed cancelled. Origin resolution is class-aware: a mapped chat owns
  itself, a scheduled-run automation conversation is reported to its recorded
  mapped origin, and a worker or digest target is reported to the mapped chat
  whose run task created it; an unmapped target is cancelled without a guessed
  notice. Abort-marked and terminal tasks are skipped, so ordinary cancellations
  and already fenced jobs acquire no notice and are not rearmed. A cancelled worker
  or digest dispatch fails its run, and that run is recorded in a small bounded
  session disposition before the abort so its own terminal commit suppresses only
  the internal model-facing result event for this automatic interruption. Only a
  dispatch whose cancellation actually fails the run is recorded (the target's own
  generation, or a blocking compaction a generation waits on), so a background
  compaction can never silence a later ordinary failure. All ordinary
  worker/digest failure or cancellation reporting and all terminal outcome rules
  are unchanged. Telegram uses
  the existing outbox admission, live allowlist and unknown-send hold; a local CLI
  attach prints and acknowledges pending notices without a model turn, and no notice
  is pushed by the gateway. Pending notices are admitted before a new mark, so the
  bounded mark only refuses after real undelivered notices. A native abort failure or
  mark that did not persist, a still-full bounded record, or a prepared
  model outside `allowedModels` (including a revoked generation poll) remains a
  fixed startup failure handled by stopped-store recovery; the allowlist is never
  widened to make startup pass. An unreadable interruption record is retired through
  native `retireDoc` without interpreting or repairing it, so startup stays
  available and the authoritative task scan still cancels the dispatch; the notices
  that record held, and the suppression entry of an already-cancelled run, are lost
  with it, and a fixed value-free outbox fault records the notice loss where an
  origin is known.
- The cron timer never calls a model, and a run never schedules: rescheduling is
  a deterministic task commit, so a slow or failed turn cannot stop the schedule.
  A conversation is ongoing activity and an episode is one execution: a recurring
  job keeps one automation conversation with a reset-delimited episode per run,
  one-off jobs share one catch-all conversation per origin and queue durably on it
  (bounded, refusing visibly when full), and `origin` mode still runs in the chat
  with no new conversation and no cron-placed reset. Runs sharing a conversation
  never interleave; the execution task stays separate from the conversation, so
  cancelling a run retires its authority and stops its work without deleting
  history. A job's persistent `silent` setting is the only way an occurrence's
  automatic channel delivery is suppressed, and never its run or a failure notice:
  a scheduled run is offered no per-occurrence opt-out, so a reminder cannot be
  silenced by its own answer. A non-silent successful answer is delivered; an
  empty answer, or one that is only the retired `[SILENT]` marker, queues the fixed
  empty-result notice instead. The marker has no meaning in an ordinary chat reply.
  The owner's terminal has a thin
  scheduling console (`durable-nanobot cron create|list|show|cancel`) that
  composes the same foundation over the private local socket: creation needs an
  explicit request key, its origin and owner are resolved from current mapped
  ordinary chats, cancellation is exact-ID, and there is no schedule edit,
  re-arm, run-now or bulk path.
- Skill prompts carry names, descriptions and locators only; bodies load on
  demand through the read-only `skill` tool.
- Idle rollover (`idleRollover`, default off) is a native `pi.reset` carrying a handoff written by
  one configured preset, applied only to an authenticated mapped chat with no run, no pending
  question, no interrupting gateway work and no entry appended since the handoff was written
  (checked in the reset commit). It grants nothing, starts no turn and sends no channel message.
- Markdown in the workspace is the memory source of truth. Durable owns the
  transcript, runtime state and compaction.
- Memory digestion starts only on an explicit owner command or an explicit
  ordinary cron intent (`intent: "digest"`); opening the gateway and parsing
  configuration start nothing. `/digest` and `/digest status` are host commands
  in the local CLI and for the authenticated Telegram owner, not model tools.
  One `gateway.memoryDigest.start` processes up to `digest.episodesPerRun` closed episodes
  (default 1), oldest unconsumed first. Open episodes are entirely ineligible. The first
  pending closed episode is always admitted regardless of estimated spending. Bounded internal
  chunks run in fresh task-owned conversations with only the origin's captured `read`/`write`/`edit`,
  confined to `SOUL.md`, `USER.md`, `memory/**/*.md` and `skills/<name>/SKILL.md`.
  Each validated chunk is acknowledged durably and automatically continued until its episode
  finishes. Only then are remaining cumulative input/response targets and the next episode's
  estimated cost checked to decide whether to admit another. Spending targets never deliberately
  truncate an admitted episode. Real failures/cancellation retain partial cursor progress and
  ordinary memory writes; no transactional staging or rollback. Imported prefixes retain their
  migration-seeded consumed frontiers, not a blanket legacy-channel exclusion: future closed
  episodes in those chats remain eligible, and recall/search are unchanged. Episode listing/detail
  exposes read-only cursor-based `digestion` progress (including partial, imported baseline,
  open/ineligible and unknown); summary readiness never implies digestion. Evidence is owner and
  assistant message text plus paired assistant tool calls and results labeled as
  untrusted machine output; a long result is a bounded head-tail preview with an
  omission marker and the original entry reference, never a claim that the
  omitted middle was read. The one durable cursor carries the next step position
  and the open tool-call ids, so
  pairing survives a chunk, a reopen and a restart; a cursor written by the earlier
  closed-episode reader is mapped at its exact acknowledged offset and upgraded in
  place, never replayed and never migrated into a second reader. Digest `write` is a guarded atomic exclusive create
  (`O_CREAT | O_EXCL`), never a precheck plus truncation; `edit` keeps exact-text
  in-process protection only, and an uncooperative outside editor between read
  and write is not detected. The cursor advances only after a settled turn is
  validated from its own committed input through its own answer. Failed exploratory reads are
  harmless, but failed mutations require a later successful same-operation retry at the same
  normalized workspace path with unchanged replacement/content; edits also require an intervening
  successful read and preserve every replacement's `newText` while refreshing exact `oldText`.
  An unrelated same-file edit or an edit after a refused create is not a verified repair.
  Host budget/usage and non-tool failures remain fatal, and a non-empty report is required. A run uses an explicitly configured background
  model (`digest.preset` or `digest.model`) and never inherits the foreground
  model or thinking level; absent one, a start is refused. Captured internal chunk safeguards are
  200,000 evidence characters (narrowed for model context), 2,000 entries, 24 tool calls,
  600,000 ms, 8 files and 32,000 inserted-plus-removed characters. These are real failure
  boundaries, not successful partial outcomes. Invocation admission targets default to
  500,000 reported input tokens including cached input and 12 successful responses. Successful
  responses include tool-call responses; native retries are recorded separately. The next-episode
  estimate counts chunks with the actual reader (including interacting character, entry and
  evidence-step bounds), then allows three rounds plus framing per chunk with 25% headroom, but is neither exact
  tokenization nor a financial ceiling. Fatal tool failures abort before another model round;
  harmless reads and repairable mutations may continue only within the existing bounds.
  Missing usage fails the chunk closed; native retries, polls, compaction and crashes prevent
  exact network-spend accounting. Finished chunks keep their acknowledgements on failure.
  Write/file counts are summed per chunk for invocation reporting, not a cross-chunk distinct-file
  count. The editable workspace policy is `DIGEST.md`
  (seeded only when absent) and it can never grant authority. Only a failed or
  cancelled run admits one bounded internal issue report to its origin
  conversation (`nanobot.memory-digest-result`, deduplicated by request ID); a
  successful run, including a successful no-op or an already-consumed replay, is
  silent and starts no origin-agent turn, and `/digest status` still shows its
  outcome. The agent decides what to relay, and a digest cron occurrence queues no
  channel delivery. The bounded notice list is pruned only for definitively
  reported, successful, or genuinely nonreportable (`faulted`/`orphaned`) native
  outcomes; a pending successful record left by an older version is never
  delivered and may free its slot, while an undelivered or unknown issue is never
  evicted. A start refuses with fixed text when no safe slot remains. Recovery
  re-admits from the authoritative terminal task when the record is missing,
  without advancing the cursor, and only when the placed entry is this task's
  internal issue report (Durable dedupes by request ID alone); a queued or foreign
  entry under that ID stays pending and visible. No digest run gets shell,
  network, worker, channel-send, history, MCP or scheduling authority, and a
  digest cron occurrence runs from the validated mapped origin with the current
  allowlist, never from a task-owned target.
- Native web tools are default-off and separate from `toolAllowlist`: `web.search`
  names the Brave credential environment variable, and `web.fetch` enables the
  public reader. Both are limited to authenticated mapped chats and live ordinary workers
  with exact per-tool captures. Public fetch
  refuses userinfo and private/loopback/link-local/reserved targets, pins the
  validated DNS answer, revalidates redirects, sends no credentials or cookies,
  bounds time/bytes/text, and never executes page scripts. Product Brave search
  remains live-unverified.
- Native Code Mode is independently opt-in (`codemode.enabled`) or follows MCP
  auto-enablement when that block is absent. Scripts compose only the current
  conversation's callable set through native `executeTool`/`ToolTask` hooks: no
  new authority, no recursion, no host-only owner commands, and no composition in
  root, state, unregistered fork, raw/other task-owned or scheduled-run automation conversations. It may compose
  the `worker` tool from a spawning mapped chat under that tool's own spawner and
  capture checks. A worker child also gets the compositor, but only over its
  captured coding, web, MCP and explicitly captured memory-recall tools over mapped
  chats (never `worker`, Telegram or cron); existing workers are not widened when
  recall is enabled later. A worker-specific call-time hook checks the durable
  capture and authorized origin and, for the classifier nested tool, the captured model identity;
  reopen permanently prunes removed names and identities, and terminal authority
  is retired with the capture. Digest and scheduled-run automation targets remain unchanged.
- MCP is a separate, default-off connection authority from `toolAllowlist`:
  `mcp.enabled` plus at least one enabled server connects it, and only
  authenticated mapped chats, ordinary workers with captured grants, and live isolated scheduled
  runs with exact per-run captures receive MCP tools. Scheduled runs offer those tools directly,
  never through Code Mode; no MCP management or login is inherited. Code Mode follows its own
  switch and excludes scheduled runs. Root, state, unregistered fork, raw/other task-owned, digest and idle
  scheduled-run automation conversations get none. A worker's worktree does
  not confine MCP: the server keeps its gateway-owned host cwd and authority. A configured stdio server is a native host
  process, not covered by `toolSandbox: "bwrap"`. Secrets are referenced by
  environment variable name.
- MCP management is direct and explicitly owner-authorized in an authenticated
  mapped ordinary chat, and it is the only path from a model to new MCP
  authority. The `mcp` model tool (`status`, `add`/`configure`, `login`,
  `logout`, `remove`) is offered only there — never to a worker, unregistered fork, root,
  digest or scheduled-run target — and login requires a unique live owner surface for that
  exact session. There is no proposal document and no separate approval command.
  An `add` validates one entry with the start parser and writes
  `mcp.servers.<name>` (and `mcp.enabled: true`) atomically, preserving file mode
  and touching nothing else; it enables only the entry asked for (other entries
  are pinned to `enabled: false` when the block was off), serializes managed
  edits, refuses to replace a file whose bytes or identity changed since it was
  read, and refuses when the block on disk is no longer the one this gateway
  reflects. The check and the rename remain two operations: an outside write in
  that window is lost, and no portable lock or content compare-and-swap removes
  it. A `remove` deletes only the exact current entry and never disables the
  capability. A completed write, login, logout or removal applies live: affected
  servers connect or close, registrations and Code Mode namespaces are rebuilt,
  and authenticated chats and live workers are re-policied. A new server never
  widens an existing worker capture, and a removed or logged-out one is pruned
  from the durable capture and its nested callable set immediately. No scheduled,
  worker or automation scope can manage MCP.
  An `oauth: true` HTTP entry reads its grant from one private `0600` file per
  exact URL under the canonical data directory, never from config, transcript,
  entry or channel text; with no usable grant it fails closed as `auth-required`
  instead of starting a flow. That file has the same trust boundary as the
  provider credential store: another user cannot read it, and same-user code (the
  coding shell, a stdio MCP server, a worker) can. The runtime does not claim
  isolation from same-user processes; it keeps token *content* out of every
  model-facing surface. Login is owner-initiated from a mapped chat and
  gateway-run native PKCE with a loopback callback, one flow at a time and a
  five-minute deadline; it works on a staged grant read together with its
  generation, installs it only after a verification connection, adopts a
  rotation of the stored grant that the starting connection performed instead of
  leaving it unusable — including after a failed or canceled startup connection —
  while a refresh of the unverified browser authorization is never adopted (those
  tokens carry the attempt's own client registration and are installed only
  inside the verified replacement), and a logout increments the generation so a
  stale refresh or a late commit cannot restore it. Cancellation is rechecked up
  to the replacement's irreversible rename, so a canceled attempt either installs
  nothing or is reported as the grant being there. The one-time authorization URL
  is delivered directly to the initiating owner surface only — the attached CLI
  session or the authenticated Telegram private chat — and never persisted in
  channel state, a transcript or a tool result. A callback-shaped ingress message
  is intercepted before transcript admission or model dispatch and must match the
  active attempt's exact loopback origin, port, path and state, the initiating
  session (and the current Telegram sender binding) and be unused; malformed,
  stale, foreign, cross-chat and replayed callbacks are consumed and refused with
  fixed text, and their code, state, verifier and tokens never reach the model,
  diagnostics or durable channel state. A pasted callback is replayed only to the
  active loopback listener, never fetched from the pasted host. Multiple CLI attachments
  sharing a session refuse login rather than guessing the origin; an active attempt
  stays pinned to its original surface, never a replacement attachment. Completion
  reconnects the server, refreshes registrations/namespaces/policy and sends one
  fixed credential-free notice to the same surface, so tools are callable without
  a restart. A delivery failure cancels the attempt and is not blindly retried.
- Telegram outbound text is rich by default (Bot API 10.1 `sendRichMessage` /
  `editMessageText` with `rich_message.markdown`) for ordinary replies, scheduled deliveries,
  previews and their edits, and host notices. Chunking uses a persisted, capability-independent
  plan: the 32,768-character rich budget normally, or 4096 when a preview must be edited so a
  rejected rich edit can fall back safely. Older progressed records retain the legacy split.
  Fence-aware cuts preserve whitespace and surrogate pairs; host-generated notice data is escaped,
  with trusted rich labels and lists for `/status` and `/model`, while model text passes through as markdown. A missing
  method latches rich off for the process and resends plain; a refused body (`can't parse`,
  unsupported tag, too long) resends that chunk as plain text split under 4096. Every other
  rejection and every ambiguous outcome keeps the existing hold semantics and is never resent.
  Attachment captions remain plain text with no `parse_mode`, and no media block is used for
  attachments. Inbound reply context uses an explicit partial quote when present; observed-target
  excerpts always describe the full received message. Both are read from the admitted update:
  `text`/`caption`, else a received `rich_message.blocks` tree traversed by declared shape within
  bounded depth/node/character budgets, including array iteration. Only display text is
  copied (never URLs, identifiers or button targets), unreadable bodies become fixed labels rather
  than empty strings, and an unreadable/empty re-observation keeps an earlier readable target excerpt.
  Nothing is filled from a transcript or recent-target cache, and controls are still parsed from
  `message.text` alone.
- Native `read` uses Durable's Photon processor for model-facing image copies only: at most
  1568×1568 pixels and 1 MiB base64, intersected with caller limits. Sources declaring more than
  50 MP or exceeding 64 MiB are refused before decode (native read has already loaded the file).
  Processor failures fail closed; original files and native coordinate/conversion diagnostics remain
  intact. Other image ingress and tool/path authority are unchanged.
- Telegram locations and venues are readable labeled update content (bounded venue labels and
  six-decimal coordinates), including reply/target excerpts; no geocoding, attachment or authority
  is implied. Attachment suffixes use fixed known MIME/name metadata, never byte sniffing or the
  announced filename as a path. Recovery adopts complete legacy generic identity locators before
  redownloading, without renaming originals; stored paths remain authoritative.
- Media ingress is opt-in (`media` config) and owned by the gateway. Discord
  attachments are stored once at admission under `media/discord/` with the same
  size bound; Discord audio is never transcribed. Telegram
  photos are native pi-ai image content plus a workspace-relative locator, and
  configured vision handoff describes them for flagged text-only presets;
  Telegram documents are stored unread and Telegram voice/audio is transcribed
  locally only when the chosen engine is provisioned explicitly. Every CLI
  `/attach` file, photos included, is a stored opaque original named only by a
  workspace-relative locator: no native image content, vision handoff,
  transcription or extraction. The default engine is the uv/
  faster-whisper helper (`small`/CPU/`int8`) and stays the default: the Python-free
  `whisper-cli` route is selected only by `media.transcription.backend` plus an
  absolute, operator-provisioned engine/model/VAD/FFmpeg block. No runtime
  download, engine fallback or in-process native addon; that route enforces VAD,
  one deadline over probe+decode+inference, a refusing duration bound backed by a
  decoded-PCM size fence, and a cleaned private temp WAV. Stored originals grant
  no tool authority, are never auto-deleted, and have no total-disk cap.
- Bubblewrap is accidental-damage protection over the real workspace, not
  hostile-tenant isolation, and it is off by default.

## Conventions

- Owner-facing receipts are terse (e.g. "Context reset."). Skip implementation
  explanations; keep pending/failed/unknown outcomes honest and actionable.
  Explicit status views and security/approval disclosures retain necessary detail.
- Implementation workers own small permanent regression tests for their changes;
  reviewers check their coverage and reliability. Avoid exhaustive low-value matrices.
- New tests use synthetic providers/controlled clocks, explicit timeouts and guaranteed
  cleanup. No sleep-based schedule waits or abandoned gates/timers/subscriptions.
  Validate new files under an outer process timeout; register them in the npm suite.
  Behavior/execution test phases use GNU timeout: 60s, then forced kill after 5s.
- Keep documentation honest about what is missing; a documented gap beats an
  implied capability.
- Never write credential filenames, tokens or host paths into documentation.
