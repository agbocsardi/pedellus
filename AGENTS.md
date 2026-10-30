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
  `cron`, `history` and scoped `telegram` tools carry no filesystem/shell authority
  and are exempt from the coding-tool hook; history remains read-only over mapped
  chats. Telegram actions additionally require a live adapter, current private-chat
  admission and observed same-chat targets. Unknown external outcomes are retained,
  never blindly retried or evicted.
- Named model presets define provider/model/thinking in config. CLI preset switches
  are temporary: a CLI reattach keeps the temporary selection, while a gateway
  restart or reopen restores the configured preset without rewriting prepared
  dispatches. Direct-model (non-preset) selection retains its persisted semantics.
- The authenticated Telegram owner's controls are `/new`, `/abort`/`/stop`,
  `/status`, `/model` and `/restart`, advertised only where the host implements
  them. `/model` selects one configured preset for that chat only; `/status` is
  bounded read-only metadata with no model call; `/new` starts a new context and
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
- MCP is a separate, default-off connection authority from `toolAllowlist`:
  `mcp.enabled` plus at least one enabled server connects it, and only
  authenticated mapped chats receive MCP tools, `codemode` and `tool_search`.
  Root, state, fork, raw/task-owned and isolated cron conversations get none.
  A configured stdio server is a native host process, not covered by
  `toolSandbox: "bwrap"`. Secrets are referenced by environment variable name.
- Media ingress is opt-in (`media` config) and owned by the gateway. Photos are
  native pi-ai image content plus a workspace-relative locator; configured vision
  handoff describes them for flagged text-only presets. Documents are stored
  unread with no extraction, and voice/audio is transcribed locally only when the
  helper is provisioned explicitly. Stored originals grant no tool authority, are
  never auto-deleted, and have no total-disk cap.
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
