# Pedellus

Pedellus (formerly Durable Nanobot): a TypeScript port of Nanobot on the Pi
1.5.0 stack (`@earendil-works/pi-ai`, `pi-durable`, `chord`). The agent loop is
Durable's; this repo is the nanobot-specific layer (context, tools, execution,
automation, channels, providers).

- Independent project: the Python fork at `~/projects/pi-nanobot` is reference
  only — never merge/rebase onto it; port changes by hand.
- Experimental. Never stop or replace Python's production bot during checks.
- Never install a `nanobot` alias; the executable is `pedellus`.

## Commands

```bash
npm ci --offline
npm run typecheck
npm run build
npm run test:behavior
npm run test:execution
npm run --silent test:core-acceptance   # see ACCEPTANCE.md
npm start -- gateway --config config.json
npm start -- agent --config config.json
```

`bin/pedellus.mjs` runs source via pinned `tsx`; code edits need only a
restart (unit edits also need daemon-reload). Keep the error boundary in
`src/cli.ts:runCli` and diagnostics in `src/failure-diagnostics.ts` — never log
raw exceptions/payloads.

## Layout

- `src/runtime.ts` — `openGateway`: storage, tool policy, context, cron, host API.
- `src/cli.ts` — `gateway` (sole runtime owner), `agent` (attaches), recovery.
- `src/local/` — private Unix-socket CLI protocol; no public listener.
- `src/channels/` — Telegram, Discord, `app` (see TELEGRAM.md, DISCORD.md, APP.md).
- `src/mcp/`, `src/workers/`, `src/automation/`, `src/history/`, `src/media/`,
  `src/context/`, `src/execution/`, `src/auth/`, `src/help/`, `src/doctor/` — one subsystem each.
- `pwa/` — the installable web app for the `app` channel and the shared wire
  protocol (`pwa/protocol/`); its own notes are in `pwa/AGENTS.md`.
- `plan/` — historical evidence, not a work queue.

User onboarding lives in GETTING_STARTED.md and SETUP_PROMPT.md; keep them in
sync with CLI/config changes. Topic docs (MCP.md, WORKERS.md, CRON.md,
MEMORY_RECALL.md, HISTORY.md, MODELS.md, PROVIDERS.md, CODEMODE.md, WEB.md,
TOOLS.md, EXECUTION.md, …) hold the detailed contracts. Read the relevant one before changing a subsystem and
keep it in sync.

## Core invariants

- **Config is the only authority.** Coding tools come from `toolAllowlist`;
  web, MCP, Code Mode, workers, media, Discord, app are separate opt-ins.
  Non-coding tools (`skill`, `cron`, memory recall, `worker`, `ask_user`, `mcp`,
  `telegram`) grant no coding authority.
- **Only authenticated mapped ordinary chats get foreground authority.** Root,
  fork, raw, state, task-owned and automation conversations never become chats,
  origins or tool scopes.
  Sole exception: an app side-thread fork made by `thread.create {from}` and
  admitted under its own exact registered key after exact cutoff checks (APP.md,
  "Fork admission"); every other fork stays denied.
- **Background work runs on captured, narrowing-only grants.** Workers, cron runs
  and digests capture a subset of their origin's authority; removal prunes it
  permanently, re-enabling never restores it. No recursive delegation.
- **Unknown external outcomes are held, never blindly retried or evicted.**
- **Secrets never reach model-facing surfaces, transcripts or channel state.**
  Reference credentials by env var name; no ambient fallback.
- **Nothing starts implicitly**: no model call at open, no digest/login/catalog
  refresh without an explicit owner command.
- Workspace Markdown is memory's source of truth; Durable owns transcript,
  runtime state and compaction.
- Bubblewrap is accidental-damage protection, not isolation; off by default.
- Document known gaps honestly rather than claiming them closed.

## Conventions

- Owner-facing receipts are terse; pending/failed/unknown outcomes stay honest.
- Implementers add small regression tests for their changes; no exhaustive matrices.
- Tests use synthetic providers, controlled clocks, explicit timeouts and
  guaranteed cleanup; no sleep-based waits. Register new files in the npm suite.
- Never write credential filenames, tokens or host paths into docs.
