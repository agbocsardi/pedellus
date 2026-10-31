# Durable Nanobot

TypeScript port of Nanobot on the Pi 1.4.0 stack (`@earendil-works/pi-ai`,
`pi-durable`, `chord`). Independent project: the Python fork at
`~/projects/pi-nanobot` is reference material only — never merge or rebase onto
it, and port individual changes by hand.

Status is experimental. Nothing here is deployed, and no acceptance run has used
production data or a live user workspace.

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
- `src/mcp/` — explicit MCP server config, the pinned `@earendil-works/pi-mcp`
  client lifecycle, deferred `mcp__<server>__<tool>` registrations, namespace
  summaries and the call-time MCP authority hook.
- `src/media/` — shared attachment storage under the workspace, the local
  uv/faster-whisper transcriber, and the configured vision handoff; the fixed
  CPU/`small`/`int8` speech helper is `scripts/local-transcribe.py`. Telegram
  ingress lives in `src/channels/telegram.ts` and `src/channels/telegram-media.ts`.
- `src/automation/` — cron timer/run tasks and the model-facing `cron` tool.
- `src/workers/` — bounded ordinary background workers as native Durable tasks:
  the opt-in `worker` start/list/inspect/cancel tool, an explicit
  shared-or-worktree workspace per task, captured child authority and one internal
  result event to the spawning agent. A worker is not an origin and gets no worker
  tool; its child keeps the native Code Mode compositor over its captured tools
  only, so it cannot delegate further.
- `src/execution/` — guarded host environment and the optional Bubblewrap shell.
- `src/context/` — bootstrap/memory/skills snapshots, skill tool, workspace host.
- `src/history/` — durable store identity, reset-delimited episodes, background
  summaries, rebuildable message/tool/summary search, and the read-only
  model-facing `history` tool. Original transcript entries remain authoritative.
- `src/channels/` — Telegram adapter; other channels are not ported.
- `2026-10-30_lean-assistant_TODO.md` — single current work order:
  useful memory, scheduled outcomes and understandable recovery before breadth.
- `plan/` — historical roadmaps and implementation evidence, not a work queue.

## Invariants worth not breaking

- Shipped CLI/Telegram coding tools come directly from config `toolAllowlist`;
  empty disables them. The same config is the only tool authority for SDK
  gateway callers. Only validated mapped chats receive this authority, and
  every admitted Telegram user shares the configured workspace/tools. Raw, root,
  forked and state conversations remain denied. Isolated cron runs capture an
  origin subset bounded by current config and lose it on completion. The `skill`,
  `cron`, `history`, `worker` and scoped `telegram` tools carry no filesystem/shell
  authority and are exempt from the coding-tool hook; history remains read-only
  over mapped chats. Telegram actions additionally require a live adapter, current private-chat
  admission and observed same-chat targets. Unknown external outcomes are retained,
  never blindly retried or evicted.
- Named model presets define provider/model/thinking in config. CLI preset switches
  are temporary: a CLI reattach keeps the temporary selection, while a gateway
  restart or reopen restores the configured preset without rewriting prepared
  dispatches. Direct-model (non-preset) selection retains its persisted semantics.
- The authenticated Telegram owner's controls are `/new`, `/abort`/`/stop`,
  `/status`, `/model`, `/digest` and `/digest status`, plus `/restart`,
  advertised only where the host implements them. `/model` selects one
  configured preset for that chat only; `/status` is bounded read-only metadata
  with no model call; `/new` starts a new context and
  rebuilds the assembled workspace prompt, so a host with a prompt snapshot
  refuses it while that chat runs instead of half-applying; `/restart` is the
  host's full-process replacement (same executable, argv and environment through
  POSIX `process.execve`, after normal teardown), never a model tool, daemon or
  supervisor. `/refresh` is not a command.
- The cron timer never calls a model, and a run never schedules: rescheduling is
  a deterministic task commit, so a slow or failed turn cannot stop the schedule.
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
  segment, and an in-progress turn is never offered. The evidence is owner and
  assistant message text plus paired assistant tool calls and results labeled as
  untrusted machine output; a long result is a bounded head-tail preview with an
  omission marker and the original entry reference, never a claim that the
  omitted middle was read. One completed segment whose evidence fits the batch
  bounds is one batch and one acknowledgement; a larger segment is independent
  ordered chunks, each acknowledged on its own, with no carry-over summary. The
  one durable cursor carries the next step position and the open tool-call ids, so
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
  cached input, 12 provider requests including retries, 24 tool calls, 600,000 ms,
  8 files and 32,000 inserted-plus-removed characters) are read from the committed
  target transcript, so they survive a retry and a reopen, and crossing one fails
  the batch without acknowledging it. A host cannot tokenize or intercept an
  in-flight provider request, so the token bound is enforced on actual reported
  usage before the next tool round is admitted; overshoot is bounded by the one
  request already in flight. The editable workspace policy is `DIGEST.md`
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
  public reader. Both are limited to authenticated mapped chats. Public fetch
  refuses userinfo and private/loopback/link-local/reserved targets, pins the
  validated DNS answer, revalidates redirects, sends no credentials or cookies,
  bounds time/bytes/text, and never executes page scripts. Product Brave search
  remains live-unverified.
- Native Code Mode is independently opt-in (`codemode.enabled`) or follows MCP
  auto-enablement when that block is absent. Scripts compose only the current
  conversation's callable set through native `executeTool`/`ToolTask` hooks: no
  new authority, no recursion, no host-only owner commands, and no composition in
  root, state, fork, raw/task-owned or isolated cron conversations. It may compose
  the `worker` tool from a spawning mapped chat under that tool's own spawner and
  capture checks. A worker child also gets the compositor, but only over its
  captured tools (never `worker`, MCP, web, Telegram, cron or history), and its
  composition authority is retired with the capture.
- MCP is a separate, default-off connection authority from `toolAllowlist`:
  `mcp.enabled` plus at least one enabled server connects it, and only
  authenticated mapped chats receive MCP tools; Code Mode follows its own switch
  and the same mapped-chat rule. Root, state, fork, raw/task-owned and isolated
  cron conversations get none. A configured stdio server is a native host
  process, not covered by `toolSandbox: "bwrap"`. Secrets are referenced by
  environment variable name.
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
