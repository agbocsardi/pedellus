# Durable Nanobot

TypeScript port of Nanobot on the Pi 1.4.0 stack (`@earendil-works/pi-ai`,
`pi-durable`, `chord`). Independent project: the Python fork at
`~/projects/pi-nanobot` is reference material only — never merge or rebase onto
it, and port individual changes by hand.

Status is experimental. Nothing here is deployed, and no acceptance run has used
a real workspace or channel yet.

## Commands

```bash
npm ci --offline          # install the pinned dependency tree
npm run typecheck         # tsc --noEmit
npm run build             # tsc -> dist/
npm run test:behavior     # 155 behaviour checks (builds first)
npm run test:execution    # 9 execution/sandbox checks (builds first)
npm run --silent test:core-acceptance  # offline core acceptance JSON (builds first; see ACCEPTANCE.md)
npm start -- --config config.json   # local CLI against a config file
```

## Layout

- `src/runtime.ts` — `openGateway`: storage, policies, grants, context, cron and
  the conversation-facing host API.
- `src/cli.ts` — local terminal client, model selection, recovery command.
  The agent loop itself is Durable's; this repository is the nanobot-specific
  layer around it (context, tools, execution, automation, channels, providers).
- `src/automation/` — cron timer/run tasks and the model-facing `cron` tool.
- `src/execution/` — guarded host environment and the optional Bubblewrap shell.
- `src/context/` — bootstrap/memory/skills snapshots, skill tool, workspace host.
- `src/history/` — durable store identity, reset-delimited episode catalog with
  durable pending-summary state, and the rebuildable message/tool search index that
  `Gateway.historySearch` exposes. Boundaries come from committed resets; no summary
  task, summary search or history UI lives here yet.
- `src/channels/` — Telegram adapter; other channels are not ported.
- `plan/` — dated roadmap, spike history and the current plan. The port plan is
  the scope/status authority; older plans are evidence, not a work queue.

## Invariants worth not breaking

- Coding tools are default-deny per conversation: a host ceiling plus explicit,
  expiring grants, rechecked at call time and pruned before resume. The `skill`
  tool and the `cron` tool are ungated because they grant no filesystem or shell
  authority; cron jobs inherit the origin conversation's grants and never widen
  them.
- The cron timer never calls a model, and a run never schedules: rescheduling is
  a deterministic task commit, so a slow or failed turn cannot stop the schedule.
- Skill prompts carry names, descriptions and locators only; bodies load on
  demand through the read-only `skill` tool.
- Markdown in the workspace is the memory source of truth. Durable owns the
  transcript, runtime state and compaction.
- Bubblewrap is accidental-damage protection over the real workspace, not
  hostile-tenant isolation, and it is off by default.

## Conventions

- Verify with the scripts above; add permanent tests only when asked.
- Keep documentation honest about what is missing; a documented gap beats an
  implied capability.
- Never write credential filenames, tokens or host paths into documentation.
