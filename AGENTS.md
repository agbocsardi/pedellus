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
npm start -- --config config.json   # local CLI against a config file
```

## Layout

- `src/runtime.ts` — `openGateway`: storage, config-scoped tool policy,
  context, cron and the conversation-facing host API.
- `src/cli.ts` — local terminal client, model selection, recovery command.
  The agent loop itself is Durable's; this repository is the nanobot-specific
  layer around it (context, tools, execution, automation, channels, providers).
- `src/index.ts` — small host entry surface (config, gateway, workspace host,
  opt-in context/Code Mode, recovery, CLI main); import subsystems directly.
- `src/automation/` — cron timer/run tasks and the model-facing `cron` tool.
- `src/execution/` — guarded host environment and the optional Bubblewrap shell.
- `src/context/` — bootstrap/memory/skills snapshots, skill tool, workspace host.
- `src/history/` — durable store identity, reset-delimited episodes, background
  summaries, rebuildable message/tool/summary search, and the read-only
  model-facing `history` tool. Original transcript entries remain authoritative.
- `src/channels/` — Telegram adapter; other channels are not ported.
- `2026-10-29_assistant-tree_TODO.md` — current scope and work-order authority:
  CLI + Telegram trunk, then tools, delegation and more channels.
- `plan/` — historical roadmaps and implementation evidence, not a work queue.

## Invariants worth not breaking

- Shipped CLI/Telegram coding tools come directly from config `toolAllowlist`;
  empty disables them. The same config is the only tool authority for SDK
  gateway callers. Only validated mapped chats receive this authority, and
  every admitted Telegram user shares the configured workspace/tools. Raw, root,
  forked and state conversations remain denied. Isolated cron runs capture an
  origin subset bounded by current config and lose it on completion. The `skill`,
  `cron` and `history` tools carry no filesystem/shell authority and are exempt
  from the coding-tool hook; history remains read-only over mapped chats.
- Named model presets define provider/model/thinking in config. CLI preset switches
  are temporary: reopening restores the configured preset without rewriting prepared
  dispatches. Legacy direct-model SDK selection retains its persisted semantics.
- The cron timer never calls a model, and a run never schedules: rescheduling is
  a deterministic task commit, so a slow or failed turn cannot stop the schedule.
- Skill prompts carry names, descriptions and locators only; bodies load on
  demand through the read-only `skill` tool.
- Markdown in the workspace is the memory source of truth. Durable owns the
  transcript, runtime state and compaction.
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
