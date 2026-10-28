# Nanobot on Pi Durable (experimental)

TypeScript port requiring Node >=22.19 and the pinned Pi 1.4.0 packages. This is not a production-ready replacement for the Python fork.

The [current plan and consolidation snapshot](../../2026-10-27_port-plan_TODO.md)
are the scope/status authority. Core coding tools, durable grants, optional bwrap
shell, opt-in memory/skills and compaction plumbing are integrated. Cron has a
reviewed internal timer/calendar foundation; **agent-callable scheduling is not yet
wired**. Cron needs no user UI or direct scheduling commands.
New implementation is paused for consolidation; WebUI, migration and cutover are
deferred. The [older roadmap](../../2026-10-26_full-port_TODO.md) preserves evidence,
not a standing implementation queue.

## Run

Copy `config.example.json` to a private explicit config file and edit the workspace, model, and environment-variable *names*. The config contains no credentials. The nine supported provider aliases and their `credentials` fields are listed in [provider support and migration notes](./PROVIDERS.md). Credential references and `telegram.tokenEnv` must be environment-variable names, not values or `${...}` expressions; the runtime does not read Nanobot/Pi user config or perform live credential discovery. Native catalogs/routes are not drop-in Python-provider parity, and real-provider acceptance remains open. SDK hosts may pass an explicit pi-ai `Models` instance as `openGateway(config, context, { models })` for offline/custom use; the CLI never installs a faux provider.

```sh
npm ci
npm run build
node dist/cli.js --config /path/to/config.json
```

Without Telegram settings, the CLI starts a single local prompt session. With Telegram enabled, it delegates to the restricted adapter (explicit decimal user allowlist only). Do not use live bot polling for offline checks.

## Runtime/recovery

One process acquires Chord's kernel-backed `processLock` using the canonical SQLite database path before opening storage. The lock is released when the owning process exits, including an uncatchable kill; a second live owner fails closed. SQLite, under `dataDir/nanobot.sqlite`, stores the Durable transcript and work state. The root conversation's `nanobot.session-map` document commits external session-key-to-conversation mappings atomically. Reopening the database reuses the same conversation without resetting its transcript; pending durable tasks are resumed after extensions are installed. Data directory is private (`0700`) and rejected when it resolves inside the workspace or any extra allowed root; it is not exposed to the shell environment.

The gateway upgrades upstream SQLite's NORMAL default to **WAL `synchronous=FULL` on its actual connection**, verifying both settings before and after native schema initialization and failing closed on mismatch. Parent crash/reopen and injected setup/readback/migration-failure probes passed; this is not proof of physical power/host-loss survival. Backup/restore, disk-full and broader storage acceptance remain open. See [storage policy and evidence](./STORAGE.md).

`toolAllowlist` is the host-owned **global ceiling** and defaults to `[]`.
Conversations may only narrow such a ceiling; they cannot widen it. An empty ceiling
disables coding tools (the opt-in read-only `skill` tool is separate). A non-empty
ceiling may name only the native
`read`, `write`, `edit` and `bash` tools; the gateway registers them over a guarded
host environment on the actual workspace, and every conversation still needs an
explicit per-conversation grant with an expiry. Revoked and expired grants are
reapplied before resume, and a `beforeTool` hook rechecks them at call time. This
field is not an approval UI. Grant/revoke currently requires the SDK host API;
the ordinary CLI and Telegram adapter have no approval/grant command, so setting
the ceiling alone does not enable coding tools in those sessions. A deployment may
select the optional
direct-workspace Bubblewrap shell with `toolSandbox: "bwrap"`; it is off by
default, wraps shell commands only, and falls back to neither the host shell nor a
managed copy. See [coding tools and grants](./TOOLS.md) and
[direct Bubblewrap shell](./DIRECT_BWRAP.md).

## Internal cron foundation (not activated)

[`CRON.md`](./CRON.md) describes finite timer/run tasks, `at`/`every`/calendar
schedules and IANA time zones. Timers arm their successors independently of model
execution. The module is not installed by `openGateway` or exported through the SDK
barrel; the agent-callable tool, per-run authorization, outbound/silent delivery and
runtime lifecycle wiring remain missing. The user asks the agent to schedule work;
no direct cron UI or user scheduling commands are required. The unmerged Telegram outbound candidate is
not part of this checkout's runtime.

## Opt-in Code Mode SDK

The SDK barrel exports `createCodeModeIntegration`, fixed budgets and types for
native Durable QuickJS Code Mode/tool-search. It does **not** install them in the
gateway. Hosts must establish explicit default-deny grants and reapply persisted
policy before scheduling; see [Code Mode contract and verified boundaries](./CODEMODE.md).
The bounded SDK bundle passed independent review and parent-built sandbox,
activation, cancellation and safe/unsafe crash-replay probes. Execution, approvals,
MCP and product failure-verification gates remain separate.

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
default off); it contributes no identity. Prepared requests containing old Nanobot context
conservatively block recovery. With the gateway stopped and an existing database, an
owner can inspect blocked task IDs/fingerprints and explicitly cancel them without
resuming or rewriting the prepared request; see
[prepared context recovery](./CONTEXT_RECOVERY.md) and the
[context contract](./CONTEXT.md).

## Read-only usage SDK

`readUsageSnapshot` / `snapshotUsageState`, `projectUsageDelta` and
`parseUsageArchiveCursor` expose native conversation usage and legacy model-token
deltas without writing archives or advancing cursors. Hosts supply a persistent
unique store namespace and trusted cursor state. Unknown spend/request counts and
native nested-usage duplication cannot be reconstructed from cumulative totals.
See [usage boundaries](./USAGE.md) before using a projection for accounting.

## Historical import SDK

The opt-in SDK has separate bounded slices for [source acquisition](./ARCHIVAL_SOURCE.md),
[preparation](./ARCHIVAL_IMPORT.md), [inert persistence](./ARCHIVAL_PERSISTENCE.md)
and [search](./ARCHIVAL_SEARCH.md). Acquisition requires a separately supplied
quiescent copy and refuses the live `~/.nanobot` directory. Imported records are
history-only: they do not create live sessions, runnable tools or tasks. Persistence
and paginated search require exclusive host ownership of a stable store. There is
not yet an operator-facing import command, browse UI, authenticated search cursor,
large-corpus index, or completed real-history rehearsal.

## Current status and checks

Run `npm run typecheck` and `npm run test:behavior` for offline Nanobot-owned
contracts using synthetic providers, temporary SQLite stores and crash/reopen
fixtures. These do not establish full parity or production security. The
standalone managed-copy experimental sandbox is not installed in the Gateway;
resource quotas, approvals and filesystem confinement remain open. The opt-in
[coding tools and grants](./TOOLS.md) register native tools over the guarded host
environment on the actual workspace; they are disabled by default and are not
confinement. The optional [direct Bubblewrap shell](./DIRECT_BWRAP.md) narrows
the shell mount view but is not a quota or hostile-tenant boundary.
[Tool replay checks](./TOOL_REPLAY.md) exercise synthetic direct tools and the
native replay/grant boundary.

For earlier Telegram reliability and scripted smoke evidence, see [TELEGRAM.md](./TELEGRAM.md).
Bounded owner-authorized real-provider proofs and OpenCode Go tool turns passed
on host and bwrap in disposable workspaces. These do not establish full-provider,
real-memory/skill/compaction or scheduled-delivery acceptance. Offline consolidation
also checked the combined Gateway memory/skills/four-tool path and revoke/reopen
on both backends with a faux provider. The 155 behavior and 9 execution checks do
not include dedicated permanent coverage for every newer slice; focused temporary
probes are described in their documents. Backup/restore, A/B acceptance and
owner-approved cutover remain open; no production cutover has been performed.
