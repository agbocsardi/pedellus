# Nanobot Durable runtime spike

Experimental Gate 1 TypeScript port. Requires Node >=22.19 and the pinned Pi 1.4.0 packages. This is not a production-ready replacement for the Python fork.

The [full-port roadmap](../../2026-10-26_full-port_TODO.md) covers the existing WebUI, Linux-only deployment, native QuickJS Code Mode/tools, Pi SDK-first reuse and bwrap confinement, feature parity, migration and cutover gates.

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

`toolAllowlist` is the host-owned **global ceiling** and defaults to `[]`. Conversations may only narrow such a ceiling; they cannot widen it. The gateway currently has no approved registered tools, so any nonempty list makes startup fail closed. This field neither names installed registration identities nor represents human approval, and it does not activate tools.

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
memory and selected-skill snapshots through native Durable sections. Direct callers
need a **fresh extension and dedicated registry per Harness/storage**: conversation
IDs collide across stores. `openGateway` can also accept an opt-in host snapshot
provider and reconstructs snapshots before resume; it does not load files itself.
An opt-in [workspace loader](./WORKSPACE_CONTEXT.md) supplies fixed bootstrap files
and explicitly selected memory files to such a provider; it does not discover skills
or provide full Python memory parity. Prepared requests containing old Nanobot context
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
fixtures. These do not establish full parity or production security. The standalone
experimental sandbox is not installed in the Gateway; resource quotas, approvals,
replay policy and filesystem confinement remain open. [Tool replay checks](./TOOL_REPLAY.md)
exercise synthetic direct tools only. The Gateway remains tool-less and rejects
nonempty `toolAllowlist`.

For earlier Telegram reliability and scripted smoke evidence, see [TELEGRAM.md](./TELEGRAM.md).
Real-provider acceptance, backup/restore and owner-approved cutover remain open;
no paid LLM request or production cutover has been performed.
