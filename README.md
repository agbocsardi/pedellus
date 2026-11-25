# Pedellus

**Pedellus** is a self-hosted, durable personal AI assistant written in TypeScript on the [Pi 1.5.0](https://pi.dev) stack (`@earendil-works/pi-ai`, `pi-durable`, `chord`).

One long-running local gateway owns your SQLite state, workspace files, tools, and schedules. You talk to it from whichever surface is handy—terminal, Telegram, Discord, or an installable web app (PWA)—and everything survives restarts.

> **Status:** Experimental personal-use project (Linux & Windows via WSL2, Node >= 22.19). Topic docs note what is verified live vs. offline.

---

## Quick start

```bash
git clone https://github.com/agbocsardi/pedellus.git
cd pedellus
npm ci
npm link --offline   # exposes `pedellus` on your PATH (or run `node bin/pedellus.mjs`)

pedellus init        # guided setup: workspace, provider login, model & optional onboarding interview
pedellus doctor      # read-only health check
pedellus gateway     # start the gateway (or run via systemd; see SERVICE.md)
pedellus agent       # attach an interactive terminal chat
```

- **Full walkthrough (Linux & WSL2):** [GETTING_STARTED.md](./docs/GETTING_STARTED.md)
- **Let a coding agent set it up for you:** copy [SETUP_PROMPT.md](./docs/SETUP_PROMPT.md) into Claude Code, Codex, or Cursor inside this repo.
- **Manual config walkthrough:** [SETUP.md](./docs/SETUP.md)

---

## What it does

- **Multi-surface:** Local terminal CLI (`pedellus agent`), private Telegram bot (rich Markdown, albums, inline buttons), Discord bot (DMs/guilds/threads, mention gating, channel history tool), and an installable Web App (PWA) with Web Push and iOS Shortcuts (`POST /v1/ask`).
- **Plain-Markdown memory & recall:** Long-term notes live in human-readable Markdown files (`AGENTS.md`, `SOUL.md`, `USER.md`, `memory/`), paired with FTS5 conversation search (`memory_search`, `memory_browse`, `memory_read`), automatic closed-episode summaries, whole-episode memory digestion (`/digest`), and optional idle rollover.
- **Scheduling & background workers:** Durable cron reminders/recurring jobs (`CRON.md`), background workers in shared workspaces or isolated git worktrees (`WORKERS.md`), and interactive owner questions (`ask_user`) across CLI, Telegram, Discord, and the web app.
- **Attachments & local media:** Native image input with optional vision handoff for text-only models, plus local voice-note transcription (`faster-whisper` or Python-free `whisper-cli`).
- **Opt-in tools & integrations:** Guarded workspace coding tools (`read`, `write`, `edit`, `bash`, with optional Bubblewrap `toolSandbox: "bwrap"`), MCP servers with in-chat OAuth (`MCP.md`), QuickJS Code Mode (`CODEMODE.md`), and Brave web search + SSRF-hardened `web_fetch` (`WEB.md`).

---

## Core invariants

- **Config is the only authority.** Coding tools (`toolAllowlist`), channels, MCP, Code Mode, web, workers, cron, and media stay off until explicitly enabled in `~/.pedellus/config.json` (only closed-episode summaries default on; disable with `episodeSummary.enabled: false`).
- **Single-owner SQLite durability.** One process holds a kernel-backed lock on `dataDir/nanobot.sqlite` (WAL, `synchronous=FULL`). Queued work, transcripts, and mappings survive restarts; interrupted in-flight turns are cancelled cleanly rather than blindly replayed.
- **Narrowing-only background grants.** Workers, cron runs, and memory digests capture a bounded subset of their origin chat's authority—shrinking config permanently narrows them, re-enabling never widens them, and delegation is non-recursive.
- **Honest external outcomes.** Ambiguous external channel sends or interrupted operations are quarantined and surfaced to the owner rather than silently retried or dropped.
- **No secrets in config, transcripts, or logs.** Credentials are referenced by environment variable name or stored in a private `0600` credential store; startup and runtime diagnostics never dump raw exceptions or secret values.

---

## Repository layout

| Path | Responsibility |
| --- | --- |
| `bin/pedellus.mjs` | CLI launcher (loads TypeScript via pinned `tsx`; read-only commands disable disk cache) |
| `src/runtime.ts`, `src/runtime/` | Gateway composition root, unified `ConversationRegistry` & authority policy, model catalog/reload, context snapshots, restore |
| `src/channels/` | Shared channel core (`contracts`, `controls`, `turn-runtime`, `outbox-drainer`, `markdown`) + Telegram, Discord, and App adapters |
| `src/terminal/`, `src/local/` | Interactive terminal client, history commands, stream renderer, and private Unix-socket RPC |
| `src/history/`, `src/memory/`, `src/context/` | Episode catalog, FTS5 search index, summaries, memory digestion, approved recall tools, pinned safe workspace/skills/memory loaders |
| `src/automation/`, `src/workers/`, `src/tasks/` | Durable cron scheduler & operator, background workers, shared turn-wait/recovery primitives |
| `src/execution/`, `src/tools/` | Lexical/path/command policy, `/proc/self/fd`-verified `HostExecutionEnv`, optional Bubblewrap wrapper, coding tool hooks |
| `src/mcp/`, `src/extensions/`, `src/web/`, `src/media/` | MCP client/OAuth/admin, QuickJS Code Mode, Brave search & public fetch, attachments/vision/transcription |
| `src/init/`, `src/doctor/`, `src/auth/` | Guided `pedellus init` onboarding, read-only `pedellus doctor`, native provider OAuth/API-key store |
| `pwa/` | Installable web app (`pwa/app/`) and shared wire protocol (`pwa/protocol/v2.ts`) |
| `systemd/` | Reference `pedellus.service` and `pedellus@.service` user-service units |

---

## Documentation

| Getting started | Channels | Capabilities | Operations & internals |
| --- | --- | --- | --- |
| [Getting started](./docs/GETTING_STARTED.md) | [Telegram](./docs/TELEGRAM.md) | [Memory recall](./docs/MEMORY_RECALL.md) | [User services](./docs/SERVICE.md) |
| [Setup prompt](./docs/SETUP_PROMPT.md) | [Discord](./docs/DISCORD.md) | [History & summaries](./docs/HISTORY.md) | [Providers & auth](./docs/PROVIDERS.md) |
| [Manual setup](./docs/SETUP.md) | [Web app (PWA)](./docs/APP.md) | [Cron](./docs/CRON.md) | [Models & presets](./docs/MODELS.md) |
| [CLI reference](./docs/CLI.md) | [Owner questions](./docs/ASK_USER.md) | [Workers](./docs/WORKERS.md) | [Tools](./docs/TOOLS.md) & [Bubblewrap](./docs/DIRECT_BWRAP.md) |
| | | [MCP](./docs/MCP.md), [Code Mode](./docs/CODEMODE.md), [Web](./docs/WEB.md) | [Storage](./docs/STORAGE.md), [Observability](./docs/OBSERVABILITY.md), [Recovery](./docs/CONTEXT_RECOVERY.md) |

---

## Development & checks

```bash
npm run typecheck                        # protocol sync check + tsc --noEmit
npm run build                            # sync protocol + build dist/
npm run build:pwa                        # typecheck + build pwa/app/dist/
npm run test:behavior                    # offline behavior suite (synthetic providers, isolated SQLite)
npm run test:execution                   # execution deadline & policy suite
npm run --silent test:core-acceptance    # core acceptance & budget-ledger checks
```

TypeScript source edits take effect on gateway restart without a separate build step.
