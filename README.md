# Nanobot on Pi Durable (experimental)

TypeScript port requiring Node >=22.19 and the pinned Pi 1.4.0 packages. This is not a production-ready replacement for the Python fork.

The [lean assistant plan](2026-10-30_lean-assistant_TODO.md) is the current scope
and work-order authority: CLI + Telegram first, then tools, delegation and channels.
Config-selected coding tools, named model presets, optional bwrap shell, opt-in
memory/skills, compaction plumbing, configured vision handoff, MCP, native Code
Mode composition, native Brave web search plus safe public fetch, and opt-in
Telegram media ingress are integrated.
Agent-callable
cron scheduling and Telegram delivery are available. WebUI, migration and cutover are
deferred. The [older roadmap](plan/2026-10-26_full-port_TODO.md) preserves evidence,
not a standing implementation queue.

## Run

[`SETUP.md`](./SETUP.md) is the short walkthrough: build, create a synthetic
workspace with memory and skills, enable tools in the config, then add Telegram
as a separate step. The example uses named `fast`/`deep` model presets; the default
comes from config. A local `/model <name>` switch is temporary: reattaching a CLI
keeps it, and a gateway restart returns to the configured preset.
One bounded synthetic live-model core run passed; see [acceptance](./ACCEPTANCE.md#2026-10-30--one-live-run-passed).
This is not a real-workspace or live-channel acceptance claim.

Copy `config.example.json` to a private explicit config file and edit the workspace, model, and environment-variable *names*. The config contains no credentials. The nine supported provider aliases and their `credentials` fields are listed in [provider support and migration notes](./PROVIDERS.md). Credential references and `telegram.tokenEnv` must be environment-variable names, not values or `${...}` expressions; the runtime does not read Nanobot/Pi user config or perform live credential discovery. Native catalogs/routes are not drop-in Python-provider parity, and broad provider acceptance remains open. SDK hosts may pass an explicit pi-ai `Models` instance as `openGateway(config, context, { models })` for offline/custom use; the CLI never installs a faux provider.

```sh
npm ci
npm run build
node dist/cli.js gateway --config /path/to/config.json
node dist/cli.js agent --config /path/to/config.json
```

The gateway is the single owner: it opens storage, config tools, cron and, when
configured, the restricted Telegram adapter (explicit decimal user allowlist
only). One or more `agent` CLIs attach to it as conversation surfaces; the
historical bare `node dist/cli.js --config ...` is the same attach and never opens
a second runtime. A CLI disconnect leaves the gateway, Telegram polling, admitted
turns and queued work running; a gateway restart stops all of them. Do not use
live bot polling for offline checks. Known startup/configuration failures print
fixed, value-free diagnostics; unexpected failures stay suppressed. See
[interactive CLI](./CLI.md#startup-diagnostics).

The authenticated owner also drives that gateway from a private Telegram chat:
`/new`, `/abort` (also spelled `/stop`), `/status`, `/model` and `/restart`.
Each host advertises only what it implements and refuses a typed command it cannot
perform. `/model` selects one configured preset for that chat only. `/status` is
bounded read-only metadata with no model call. `/new` starts a new context **and**
rebuilds the assembled workspace prompt from the current files, so a host with a
prompt snapshot refuses it while that chat has a running turn rather than
half-applying; there is no separate `/refresh` command. `/restart` is a full
process replacement: after the normal graceful teardown the same executable,
argv and current environment are re-exec'd (POSIX `process.execve`), so current
code and the re-read config load. It is not a daemon, supervisor or service
manager, and a platform without `execve` refuses it. These controls add no tool
authority and coexist with media ingress and MCP. See
[Telegram controls](./TELEGRAM.md#controls).

Closed episodes are summarized in the background by default using the conversation's current
model when the job starts. This makes provider calls and can incur costs. To use a different
model, set `episodeSummary.preset` to a configured preset name. Legacy direct configs
can set `episodeSummary.model` to an allowed `{ "provider": "...", "modelId": "..." }`;
set `episodeSummary.enabled` to `false` to disable summaries. Already-closed episodes are not
backfilled automatically. Short cache retention is requested, but cache reuse is not guaranteed;
see [episode summaries](./HISTORY.md#episode-summaries).

## Media

Attachment ingress is opt-in with a top-level `media` config, and the gateway owns
it. Photos arrive as native pi-ai image content plus a labeled workspace-relative
locator, so a preset marked `needsVisionHandoff` is described by the configured
describer preset instead of receiving raw bytes. Documents are saved unread under
the workspace media directory: no PDF, OCR or Office extraction. Voice/audio uses
the local uv/faster-whisper helper (CPU, `small`, `int8`); provision it explicitly
before use, because handling a message never installs the helper, downloads a
model or calls a cloud provider. Stored originals are ordinary workspace files
readable through the configured tools: no extra tool authority, no automatic
deletion and no total-disk cap. See
[setup](./SETUP.md#8-optional-attachments-and-voice) and
[Telegram media](./TELEGRAM.md#attachments-and-local-transcription).

## Runtime/recovery

One process acquires Chord's kernel-backed `processLock` using the canonical SQLite database path before opening storage. The lock is released when the owning process exits, including an uncatchable kill; a second live owner fails closed. SQLite, under `dataDir/nanobot.sqlite`, stores the Durable transcript and work state. The root conversation's `nanobot.session-map` document commits external session-key-to-conversation mappings atomically. Reopening the database reuses the same conversation without resetting its transcript; pending durable tasks are resumed after extensions are installed. Data directory is private (`0700`) and rejected when it resolves inside the workspace or any extra allowed root; it is not exposed to the shell environment.

The gateway upgrades upstream SQLite's NORMAL default to **WAL `synchronous=FULL` on its actual connection**, verifying both settings before and after native schema initialization and failing closed on mismatch. Parent crash/reopen and injected setup/readback/migration-failure probes passed; this is not proof of physical power/host-loss survival. Stopped-store synthetic backup/restore is verified; disk-full and broader storage acceptance remain open. See [storage policy and evidence](./STORAGE.md).

`toolAllowlist` is the **config-owned tool authority** for every conversation
(local CLI, Telegram and SDK hosts) and defaults to `[]`. A non-empty list may name only the
native `read`, `write`, `edit` and `bash` tools; the gateway enables exactly those
for authenticated mapped ordinary chats (not root, internal, forked or task-owned
conversations) over a guarded host environment on the actual workspace. Empty or
absent disables coding tools; the opt-in read-only `skill` tool is separate.
Scheduled isolated runs inherit a bounded subset captured from an authenticated
origin and stay bounded by current host config, so narrowing the list and
reopening also narrows those runs; pending calls for a removed tool fail closed.
Every Telegram user in
`allowFrom` shares the configured workspace and tool authority;
there is no per-chat approval or expiry step, so allowlist only
trusted users. The local CLI's `/tools` is a read-only diagnostic. A deployment
may select the optional direct-workspace Bubblewrap shell with
`toolSandbox: "bwrap"`; it is off by default, wraps shell commands only, and
never falls back to the unconfined host shell. See
[coding tools](./TOOLS.md) and [direct Bubblewrap shell](./DIRECT_BWRAP.md).

## Internal cron (opt-in)

[`CRON.md`](./CRON.md) describes finite timer/run tasks, relative one-shot
reminders (`after_seconds`), absolute/recurring/calendar schedules and IANA zones. Timers arm their successors independently of model
execution. Setting `cron: { enabled: true }` installs the foundation and a
model-callable `cron` tool (`add`/`list`/`remove`) in `openGateway`. The agent
schedules work when the user asks; there is no direct cron UI or user scheduling
command. Normal settlements of isolated and origin-mode runs (an answer, or a
fixed sanitized notice for a failure or empty answer) deliver through the durable
Telegram outbox; cancelled and superseded runs stay silent. Live-channel
acceptance remains open.

The package root (`src/index.ts`) is a small host entry surface: config loading and
types, `openGateway` and its host option types, `workspaceContextGatewayOptions`,
the context and Code Mode factories, prepared-context recovery operations,
and the CLI `main`. Other subsystems are imported directly from their modules.

## Code Mode and MCP

Native Code Mode is independently opt-in with `codemode: { enabled: true }`; with
no `codemode` block it is installed when MCP is configured, as before. Scripts
compose every tool the current authenticated mapped-chat conversation is already
authorized to call, through native `executeTool` validation and `ToolTask` hooks.
Code Mode adds no authority, is not recursive, and grants nothing to root, state,
fork, raw/task-owned or isolated cron conversations. See
[Code Mode contract](./CODEMODE.md).

MCP is **off by default**. Configuring `mcp: { enabled: true, servers: {...} }` with
at least one enabled stdio or Streamable HTTP server makes the shipped gateway
connect them and install the native Durable QuickJS Code Mode/tool-search bundle.
Discovered tools are deferred `mcp__<server>__<tool>` registrations reachable from
Code Mode scripts and `tool_search`, and only in authenticated mapped chat
conversations; root, state, forked and isolated cron/task conversations get no MCP
tool and no Code Mode. `toolAllowlist` still names only the coding tools
(`read`/`write`/`edit`/`bash`), independently of MCP.

MCP is a separate explicit connection authority. A configured stdio server runs as
a native host process, not under `toolSandbox: "bwrap"`. This slice has no OAuth,
implicit `mcp.json` discovery, resources/prompts tools, hot reload or CLI status UI;
startup failures surface only as fixed codes on the SDK `gateway.mcp` surface. See
[MCP servers and Code Mode](./MCP.md) and [Code Mode contract and verified
boundaries](./CODEMODE.md).

## Web search and public fetch (opt-in)

`web: { search: { keyEnv: "BRAVE_SEARCH_API_KEY" }, fetch: true }` installs two
native tools, both off by default: `web_search` uses the fixed
`https://api.search.brave.com` endpoint and reads its key from the named
environment variable once at startup, and `web_fetch` reads one public HTML,
plain-text or JSON URL. Fetch is limited to `http`/`https`, refuses userinfo and
private, loopback, link-local, reserved and mapped addresses, pins the validated
DNS answer, revalidates every redirect, sends no credentials or cookies, bounds
time/bytes/text, parses HTML without executing scripts, and reports original/final
URLs, MIME, retrieval time and explicit truncation. Neither tool grants filesystem
or shell authority, and both are offered only in authenticated mapped chats. There
is no login, cookie jar, browser automation, crawling, PDF/Office extraction or
retrieval cache. Product Brave search remains **live-unverified**; the implemented
fetch has one bounded `example.com` smoke. See [WEB.md](./WEB.md).

## Opt-in context SDK

`createContextExtension` composes bounded, host-supplied identity/bootstrap,
memory and skill summaries through native Durable sections. Direct callers
need a **fresh extension and dedicated registry per Harness/storage**: conversation
IDs collide across stores. `openGateway` can also accept an opt-in host snapshot
provider and reconstructs snapshots before resume; it does not load files itself.
An opt-in [workspace loader](./WORKSPACE_CONTEXT.md) supplies fixed bootstrap files
and explicitly selected memory files to such a provider; it can also append a
bounded topic-memory manifest for on-demand reads ([MEMORY_CONTEXT.md](./MEMORY_CONTEXT.md)). Skill discovery is also
opt-in through `workspaceContext.skills`: it reads only `<workspace>/skills` and an
explicitly configured builtin skills root, fails closed on metadata it cannot
parse, never executes a skill, and supports progressive loading — a prompt
summary plus a read-only `skill` tool that serves a discovered workspace or
builtin body on demand ([details](./SKILLS_CONTEXT.md)). Neither loader
provides full Python memory or skills parity. The local CLI/gateway host opts in
only when the config contains a `workspaceContext` section
(`workspaceContext.memoryFiles` and optional `workspaceContext.memoryManifest`,
default off); the shipped example enables it, and leaving the section out keeps
it off. It contributes no identity. The local CLI exposes `/refresh` to
re-capture that conversation's context and skills when it is idle. Prepared
requests containing old Nanobot context
conservatively block recovery. With the gateway stopped and an existing database, an
owner can inspect blocked task IDs/fingerprints and explicitly cancel them without
resuming or rewriting the prepared request; see
[prepared context recovery](./CONTEXT_RECOVERY.md) and the
[context contract](./CONTEXT.md).

## Migration (parked)

A future migration is a single owner-approved run, potentially outside this
repository. There is no maintained migration or archival SDK; see [the deferral
note](./MIGRATION.md).

## Current status and checks

Run `npm run typecheck` and `npm run test:behavior` for offline Nanobot-owned
contracts using synthetic providers, temporary SQLite stores and crash/reopen
fixtures. These do not establish full parity or production security. The opt-in
[coding tools](./TOOLS.md) register native tools over the guarded host
environment on the actual workspace; they are disabled by default and are not
confinement. The optional [direct Bubblewrap shell](./DIRECT_BWRAP.md) narrows
the shell mount view but is not a quota or hostile-tenant boundary.
[Tool replay checks](./TOOL_REPLAY.md) exercise synthetic direct tools and the
native replay/tool-policy boundary.

For earlier Telegram reliability and scripted smoke evidence, see [TELEGRAM.md](./TELEGRAM.md).
Bounded owner-authorized provider/tool probes passed in disposable workspaces.
A synthetic OpenCode Go / DeepSeek Flash core run also passed skill loading,
topic-memory write/read, compaction and fresh-process recall; see
[acceptance](./ACCEPTANCE.md#2026-10-30--one-live-run-passed). This does not
establish broad provider support, real-model reset/history-search quality,
real-workspace usefulness or live scheduled delivery. Offline consolidation
also checked the combined Gateway memory/skills/four-tool path on both backends
with a faux provider. The behavior suite includes focused config-tool regression tests, but does not
cover every newer slice; additional temporary probes are described in feature docs.
Behavior/execution Node test phases use GNU `timeout`: 60 seconds, followed by a
forced kill after 5 seconds if necessary, so leaked handles cannot wait forever.
Stopped-store synthetic restore passes; broader storage-fault/restore acceptance,
A/B acceptance and owner-approved cutover remain open. No production cutover
has been performed.
