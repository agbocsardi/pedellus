# Durable Nanobot design

## Scope

This package is the current TypeScript build target for Nanobot on the Pi 1.4.0
stack (`@earendil-works/pi-ai`, `pi-durable`, `chord`). The Python fork is a
read-only reference; the live fork, deployment and real user data are not
changed. Nothing here is deployed, and this document does not authorize a
production cutover. Use Node >= 22.19 and the exact pinned dependencies.

The [assistant tree plan](2026-10-29_assistant-tree_TODO.md) is the current scope
and work-order authority; [plan/](plan/) preserves historical roadmaps and
implementation evidence, not a work queue. Out of scope: WebUI/API server,
migration or archival import, MCP, and a custom scheduler. Coding tools run on
the actual workspace through the guarded host, or through the optional
direct-workspace Bubblewrap shell.

## Architecture

One gateway process owns one SQLite storage. Use Durable's Harness, Conversation,
submit/requestId, watch, built-in CodingTools, task recovery, and compaction.
Do not recreate a bus, runner, receipt ledger, retry loop for model requests, or
session JSON files. One conversation per external session key. Store key->ID
mapping atomically in a root conversation document; no in-memory-only identity.
Session keys must not resolve inherited Object.prototype properties. Ownerless
conversation creation does not inherit the root agent: apply explicit host
model/cwd/tool policy in its creating transaction and to persisted conversations
before resume.
Opening an existing conversation must not reset its transcript or configuration.
On startup reapply explicit host model/cwd policy as needed, install extensions
before resume, and resume pending work. Data lives outside the agent workspace.
Refuse a second owner with a real OS-backed lock or fail-closed acquisition; never
silently steal stale locks. Use an established available facility rather than a
large new locking implementation. Specify crash-reopen behavior explicitly.
The gateway enforces WAL/FULL on the native storage connection and verifies it
before and after schema initialization, before opening Harness. See `STORAGE.md`
for fail-closed/reopen evidence and the still-open host-loss/storage-fault gates.

### Gateway and host surface

`src/runtime.ts` exports `openGateway(config, context, options)` and the
`Gateway` handle. The gateway exposes conversation access, model listing and
selection, history reads, context refresh and the durable cron delivery outbox.
Host options may supply an explicit pi-ai `Models` instance, an opt-in context
snapshot provider, the read-only history tool switch and an episode-summary
override; they cannot expand tool authority beyond the configuration.

The package root (`src/index.ts`) is a small host entry surface: config loading
and types, `openGateway` and its host option types,
`workspaceContextGatewayOptions`, the opt-in context and Code Mode factories,
prepared-context recovery operations, and the CLI `main`. Other subsystems are
imported directly from their modules.

`PortConfig` is owned by `src/config.ts`; its normalized fields include workspace,
dataDir, model with optional allowed models/presets and thinking level, the
config-owned `toolAllowlist`, tool timeout and sandbox selection, optional
workspace context, cron and episode-summary settings, `extraAllowedDirs`,
`bwrapPath`, credential environment-variable names and optional telegram
`{ tokenEnv, allowFrom, pollTimeoutSeconds? }`. Configuration JSON contains
environment-variable *names*, never secrets. No implicit import of Python config
or Pi credential store. Fail clearly on malformed config, unknown provider/model
or missing credential, with fixed value-free diagnostics. Support scripted faux
providers ONLY through SDK injection for offline validation, never as a silent
production fallback.

### Tool authority

The configured `toolAllowlist` is the sole coding-tool authority for every
gateway caller. It is empty by default, which installs no coding tools; a
non-empty list may name only `read`, `write`, `edit` and `bash`. Authority is
limited to authenticated mapped ordinary chat conversations. The root
conversation, channel-state conversations, forks, raw and task-owned
conversations are denied, and the call-time hook fails closed if agent state
names a tool that is no longer configured. A scheduled isolated cron run captures
a bounded subset of its authenticated origin's current tools and loses it when
the run finishes; each call must also remain inside the current config, so
narrowing the list and reopening narrows pending runs.

Coding tools run over `HostExecutionEnv` on the actual workspace: filesystem
paths are confined, the shell is the guarded host shell, and this is
accidental-damage protection, not confinement. A gateway may select the optional
direct-workspace Bubblewrap shell with `toolSandbox: "bwrap"`, which wraps only
the shell, keeps the native guarded filesystem on the same workspace and stays
off by default. See [`TOOLS.md`](./TOOLS.md) and
[`DIRECT_BWRAP.md`](./DIRECT_BWRAP.md).

Code Mode is opt-in and uninstalled. `src/extensions/codemode.ts` provides the
`createCodeModeIntegration` factory, fixed budgets and lifecycle/types, also
exported by the package root. Native Code Mode/tool-search stays uninstalled in
the gateway. SDK hosts must establish native default-deny extension/tool state
before scheduling, grant tools explicitly, and reapply persisted selections
before resume; `modelTools` is not the nested-call authorization boundary. See
`CODEMODE.md` for reviewed host setup, budgets/replay/cancellation evidence and
remaining limitations.

Context snapshots are opt-in host data. `workspaceContextGatewayOptions` supplies
the local host's bounded bootstrap/memory/skills snapshot; importing it installs
nothing.

### Telegram

`src/channels/telegram.ts` exports `runTelegram(gateway, options, context)` with
`options: { token, allowFrom, pollTimeoutSeconds? }`. `allowFrom` is an explicit
list of decimal Telegram user IDs, no wildcard; private messages only. It runs
until cancellation. The CLI arranges SIGINT/SIGTERM cancellation and cleanup.
Unknown users are ignored before creating sessions or sending input. See
[`TELEGRAM.md`](./TELEGRAM.md) for durability and delivery semantics.

## Security and deliberately limited functionality

- Linux-only coding tools. The default shell is the guarded host shell, which is
  not confinement. The optional `toolSandbox: "bwrap"` shell uses a validated
  absolute Bubblewrap binary over the actual workspace, read-only system paths,
  a private `/tmp`, PID-namespace teardown, a sanitized environment, no
  host-home/config mounts, and no unsandboxed fallback; like Python, it keeps the
  host network namespace and is not a quota or hostile-tenant boundary.
- Filesystem paths are confined equivalently to the Python `_resolve_path`,
  including traversal, sibling-prefix, symlink escapes, and nonexistent write
  destinations. Check every public FileSystem entry point (both rename paths,
  readers, cwd, temp/spill paths). Never expose an unrestricted base object.
  Preserve Result/error and abort contracts. Reuse NodeExecutionEnv facilities
  without claiming realpath checks alone are race-proof. Concurrent symlink
  replacement and hardlink limits remain a documented limitation rather than a
  proven OS boundary.
- Shell must not inherit bot/provider tokens or host auth sockets. Do not mount
  dataDir in the shell. Runtime rejects dataDir under the workspace or an extra
  allowed root.
- No web/search/MCP HTTP tools are ported, so there is no model-controlled HTTP
  surface. The guarded shell and Bubblewrap backend both retain host network
  access; neither is a network boundary. Fixed Telegram API and configured model
  providers are host integrations, not arbitrary model-controlled fetchers.
  Future HTTP tools require the SSRF gate.
- Telegram uses a nonempty explicit numeric allowlist, private messages only,
  no groups, no wildcard, and no username authorization. Unknown users are
  ignored before creating sessions or sending input. No pairing UI.
- Never log token-bearing URLs, raw provider errors with credentials, or thinking
  blocks to Telegram. Text-only Telegram; unsupported attachments are not
  silently described as seen. Bound message size, long-poll processing and
  delivery retries.

## Telegram durability and output

Derive session keys from stable bot identity + chat ID, request IDs from stable
Telegram update identity. Long polling must admit eligible updates durably before
advancing past them; a slow model must not block polling. Per-conversation queues
belong to Durable, not a second in-memory agent queue. Watch committed snapshots,
coalesce edits to Telegram limits, flush final assistant text explicitly, split
long answers, and stop watches at terminal state/shutdown. Don't assume a final
watch callback has arrived just because submission.wait returned. Handle snapshots
and watch backpressure without leaking historic replies or reasoning.

Document the external send boundary honestly: Telegram sendMessage has no
idempotency key, so exactly-once sends across a crash cannot be guaranteed. If
outbound state/cursors are persisted, use Durable documents, never token-bearing
plaintext sidecar state. Restart recovery of undelivered final answers is
documented in `TELEGRAM.md`; unproven conditions remain open rather than being
called complete.

## Acceptance

- `npm ci --offline`, `npm run typecheck`, `npm run build` in this package.
- Bounded offline model run -> committed transcript; reopen same session key;
  requestId deduplication; kill -9/reopen evidence for safe/unsafe tools.
- Workspace traversal/symlink/missing-leaf rejections; the optional Bubblewrap
  shell rejects outside writes and host secrets and fails closed when the binary
  or namespace setup is unavailable; abort and timeouts stop descendants.
- Telegram adapter checked with a fixed mock transport where feasible, no live
  polling. A real Telegram and fork-provider check remains owner-run unless
  authorized. Record each unproven condition rather than calling the gate passed.
