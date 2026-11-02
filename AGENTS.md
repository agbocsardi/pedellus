# Durable Nanobot

TypeScript port of Nanobot on the Pi 1.4.0 stack (`@earendil-works/pi-ai`,
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
source/compiled error boundary shared through `src/cli.ts:runCli`.
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
- `src/channels/` — Telegram adapter; other channels are not ported.
  `telegram-rich.ts` owns the rich-message limits, fence-aware splitting and the literal-text
  escaping the adapter uses for host notices.
- `2026-10-30_lean-assistant_TODO.md` — single current work order:
  useful memory, scheduled outcomes and understandable recovery before breadth.
- `plan/` — historical roadmaps and implementation evidence, not a work queue.

## Invariants worth not breaking

- Shipped CLI/Telegram coding tools come directly from config `toolAllowlist`;
  empty disables them. Config remains the only authority for SDK gateway callers.
  `workers.toolAllowlist` is an independent ordinary-worker ceiling: omitted inherits
  configured chat tools; `[]` grants no tools; explicit worker-only coding names never
  widen foreground, cron or digest authority. `mcp` expands to connected tools at launch,
  or exact MCP registration names can be selected. Integrations still require their
  own opt-ins; Telegram, cron and recursive worker grants are forbidden.
  Only validated mapped chats receive foreground authority, and
  every admitted Telegram user shares the configured workspace/tools. Raw, root,
  forked and state conversations remain denied; a mapped session key naming
  anything but an ordinary chat is refused at ingress, before it can become a
  cron owner or receive chat policy. A scheduled run's automation
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
  conversation or a fork. Such a conversation is never a
  chat, an origin, a digest
  source, a worker, an MCP/Code Mode/compositor scope or a scheduling scope.
  Isolated cron runs capture an origin subset bounded by current config, prepare it
  per run (including its workspace context), and lose it on completion; persistent
  history confers no permission.
  The `skill`, `cron`, `memory_search`, `memory_browse`, `memory_read`, `worker`,
  `mcp` management and scoped `telegram` tools grant no coding-tool authority and
  are exempt from the coding-tool hook, so enabling a coding tool never suppresses them.
  Memory recall is enabled by default for validated mapped chats; the SDK's
  `agentHistory: false` disables it. Worker recall still requires exact captured grants;
  legacy `Gateway.history*` SDK/local APIs and their tests do not widen model-facing
  or captured worker authority. MCP management can write server configuration and launch host-level stdio processes; it is limited
  to authenticated mapped chats, with login additionally requiring a unique live
  owner surface. Memory recall remains read-only over mapped chats; legacy
  history SDK/local calls do not grant model-facing authority. Telegram actions
  additionally require a live adapter, current private-chat
  admission and observed same-chat targets. Unknown external outcomes are retained,
  never blindly retried or evicted.
- Provider spellings are native Pi AI IDs, the documented legacy aliases or
  custom `providers` keys; there is no application provider whitelist. A
  `credentials.<provider>` reference pins that one environment variable: when it
  is unset or blank, resolution fails closed and never falls back to the
  provider's ambient variables. A stored login credential wins over the
  reference, and two configured spellings for one native provider may not name
  different references. The credential store is Durable's private file under the
  canonical `dataDir` (never Pi's), and `login`/`logout` are explicit terminal
  commands that never run at startup or from a chat turn.
- Classifiers are default-deny: at most one `classifierModel` pair, which must be a
  classifier-type model in the registered catalog, is reachable only through
  native Code Mode `models.*` from an authenticated mapped chat or a live ordinary
  worker. The model identity is exact and checked at call time (a forged catalog
  object cannot substitute it), catalog discovery lists only that model and no
  image models, and work, cron, digest, root, fork, raw, retired-worker and other
  task-owned scopes get no classifier. A worker capture stores the identity, so a
  removed or changed configuration prunes it permanently and a later re-enable
  cannot resurrect it. Image generation is not registered; the native
  `models.generateImages` script global name cannot be filtered from Durable's
  frozen `models.*` map, so it fails as an unregistered tool without a model call.
- Named model presets define provider/model/thinking in config. CLI preset switches
  are temporary: a CLI reattach keeps the temporary selection, while a gateway
  restart or reopen restores the configured preset without rewriting prepared
  dispatches. Direct-model (non-preset) selection retains its persisted semantics.
- Shared CLI and authenticated Telegram owner controls are `/new`, `/abort`/`/stop`,
  `/status`, `/model`, `/digest` and `/digest status`, plus `/restart` and
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
  history. A job's persistent `silent` setting, or an exact trimmed `[SILENT]`
  successful final answer, suppresses that occurrence's automatic channel
  delivery — never the run, and never a failure notice; the marker applies only
  to a scheduled run, not an ordinary chat reply. The owner's terminal has a thin
  scheduling console (`durable-nanobot cron create|list|show|cancel`) that
  composes the same foundation over the private local socket: creation needs an
  explicit request key, its origin and owner are resolved from current mapped
  ordinary chats, cancellation is exact-ID, and there is no schedule edit,
  re-arm, run-now or bulk path.
- Skill prompts carry names, descriptions and locators only; bodies load on
  demand through the read-only `skill` tool.
- Markdown in the workspace is the memory source of truth. Durable owns the
  transcript, runtime state and compaction.
- Memory digestion starts only on an explicit owner command or an explicit
  ordinary cron intent (`intent: "digest"`); opening the gateway and parsing
  configuration start nothing. `/digest` and `/digest status` are host commands
  in the local CLI and for the authenticated Telegram owner, not model tools.
  One `gateway.memoryDigest.start` consumes one bounded completed-turn batch in
  a task-owned conversation whose only tools are the origin's captured
  `read`/`write`/`edit`, confined to `SOUL.md`, `USER.md`, `memory/**/*.md` and
  `skills/<name>/SKILL.md`. Eligibility is a completed-turn high-water over open
  and reset chats: a reset that follows an owner turn, the next owner/scheduled
  input, or a terminal assistant entry whose calls are all paired closes a
  segment, and an in-progress turn is never offered. One read scans once and
  takes the furthest completed turn within its scan bound. A completed-turn range
  that fits the entry, character and fixed step bounds is one batch and one
  acknowledgement; a larger range splits into independent ordered chunks, and a
  turn may straddle chunks. Each chunk is acknowledged on its own, with no carry-over summary. An open trailing turn is
  never cut into a range. The evidence is owner and
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
  validated from its own committed input through its own answer: any failed
  `pi.tool-result` fails the batch even if the model answers later, and a
  non-empty report is required. A run uses an explicitly configured background
  model (`digest.preset` or `digest.model`) and never inherits the foreground
  model or thinking level; absent one, a start is refused. Its captured bounds
  (200,000 evidence characters, 2,000 entries, 500,000 input tokens including
  cached input, 12 successful model responses, 24 tool calls, 600,000 ms,
  8 files and 32,000 inserted-plus-removed characters) are checked from the committed
  target transcript, including before acknowledgement. Successful responses include
  tool-call responses; native failed attempts/retries are allowed and reported separately.
  A failed tool ends the run before another model round. Tool/time/write limits are the
  primary operational bounds. Input tokens are a soft reported-usage ceiling, not a hard
  pre-dispatch or financial cap: native retries, deferred polls, compaction and a crash
  before a response is committed prevent precise network-request accounting. Missing
  usage fails closed, and an over-budget settled run never acknowledges its batch. The editable workspace policy is `DIGEST.md`
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
  root, state, fork, raw/other task-owned or scheduled-run automation conversations. It may compose
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
  authenticated mapped chats and ordinary workers with captured grants receive MCP tools;
  Code Mode follows its own switch and the same scope rule. Root, state, fork, raw/other
  task-owned, digest and scheduled-run automation conversations get none. A worker's worktree does
  not confine MCP: the server keeps its gateway-owned host cwd and authority. A configured stdio server is a native host
  process, not covered by `toolSandbox: "bwrap"`. Secrets are referenced by
  environment variable name.
- MCP management is direct and explicitly owner-authorized in an authenticated
  mapped ordinary chat, and it is the only path from a model to new MCP
  authority. The `mcp` model tool (`status`, `add`/`configure`, `login`,
  `logout`, `remove`) is offered only there — never to a worker, fork, root,
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
  Fence-aware cuts preserve whitespace and surrogate pairs; host-generated notices are escaped so
  their literal characters render unchanged, while model text is passed through as markdown. A missing
  method latches rich off for the process and resends plain; a refused body (`can't parse`,
  unsupported tag, too long) resends that chunk as plain text split under 4096. Every other
  rejection and every ambiguous outcome keeps the existing hold semantics and is never resent.
  Attachment captions remain plain text with no `parse_mode`, and no media block is used for
  attachments.
- Media ingress is opt-in (`media` config) and owned by the gateway. Telegram
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

- Implementation workers own small permanent regression tests for their changes;
  reviewers check their coverage and reliability. Avoid exhaustive low-value matrices.
- New tests use synthetic providers/controlled clocks, explicit timeouts and guaranteed
  cleanup. No sleep-based schedule waits or abandoned gates/timers/subscriptions.
  Validate new files under an outer process timeout; register them in the npm suite.
  Behavior/execution test phases use GNU timeout: 60s, then forced kill after 5s.
- Keep documentation honest about what is missing; a documented gap beats an
  implied capability.
- Never write credential filenames, tokens or host paths into documentation.
