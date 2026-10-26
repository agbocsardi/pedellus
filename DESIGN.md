# Initial Durable port — 2026-10-26

## Scope and decision

This package is the new TypeScript build target. The Python tree is read-only
reference; the live fork and deployment are not changed. This is Gate 1 of the
root TODO, not approval of a full migration. Use Node >=22.19 and exact Pi 1.4.0
dependencies. No WebUI/API server, memory migration, Dream, cron, MCP, or custom
scheduler in this slice. No new test suite: use existing upstream examples and
bounded one-off runtime checks, recording commands and limitations.

The original assessment's LOC/time estimates and API equivalences are hypotheses,
not measured savings. Native durable commits do not make external side effects
exactly-once; request IDs deduplicate admissions only.

## Ownership

- Parent: design, scaffold, integration, review, acceptance notes.
- Execution worker: `src/execution/**` and `EXECUTION.md` only.
- Runtime worker: `src/config.ts`, `src/providers.ts`, `src/runtime.ts`,
  `src/cli.ts`, `src/index.ts`, `config.example.json`, `README.md` only.
- Telegram worker: `src/channels/**` and `TELEGRAM.md` only.
- Package manifest, lockfile, tsconfig and this design belong to the parent.

Do not modify the Python tree, root instructions, shared reference checkout, or
another worker's files. Workers commit their code on separate branches; the parent
reviews and cherry-picks. No deployment, real bot polling, or paid model call
without explicit authorization. Never read/copy credentials from live config.

## Architecture

One gateway process owns one SQLite storage. Use Durable's Harness, Conversation,
submit/requestId, watch, built-in CodingTools, task recovery, and compaction.
Do not recreate a bus, runner, receipt ledger, retry loop for model requests, or
session JSON files. One conversation per external session key. Store key->ID
mapping atomically in a root conversation document; no in-memory-only identity.
Opening an existing conversation must not reset its transcript or configuration.
On startup reapply explicit host model/cwd policy as needed, install extensions
before resume, and resume pending work. Data lives outside the agent workspace.
Refuse a second owner with a real OS-backed lock or fail-closed acquisition; never
silently steal stale locks. Use an established available facility rather than a
large new locking implementation. Specify crash-reopen behavior explicitly.

### Integration contracts

`src/execution/index.ts` exports:

```ts
interface ExecutionOptions {
  workspace: string;
  cwd?: string;
  extraAllowedDirs?: readonly string[];
  bwrapPath?: string; // absolute trusted binary; default /usr/bin/bwrap
}
// Async setup probes sandbox availability and validates roots.
function createExecutionEnv(options: ExecutionOptions): Promise<ExecutionEnv>;
```

`ExecutionEnv` is the upstream interface from `@earendil-works/pi-durable/env`.
The runtime awaits setup before Harness.open, reuses environments for their
lifetime, validates configured cwd, and calls cleanup after Harness.close. If a
conversation's cwd changes, construct/cache an appropriately confined environment,
not a raw NodeExecutionEnv. Identity must preserve upstream per-file serialization
across environments addressing the same files.

`src/runtime.ts` exports:

```ts
interface Gateway {
  readonly harness: Harness;
  conversationFor(sessionKey: string, context: Context): Promise<Conversation>;
  close(context: Context): Promise<void>;
}
function openGateway(config: PortConfig, context: Context): Promise<Gateway>;
```

Use upstream Context/Harness/Conversation types. `PortConfig` is owned by runtime;
its normalized fields include workspace, dataDir, model `{provider, modelId}`,
optional thinkingLevel, extraAllowedDirs, bwrapPath, and optional telegram
`{tokenEnv: string, allowFrom: readonly string[], pollTimeoutSeconds?: number}`.
Configuration JSON contains environment-variable *names*, never secrets. No
implicit import of Python config or Pi credential store. Provide explicit config
file path in CLI. Fail clearly on malformed config, unknown provider/model or
missing credential. Implement OpenAI and the fork's OpenCode Zen/Go aliases using
native pi-ai providers where possible; avoid a custom provider until needed.
Support scripted faux provider ONLY through SDK injection for offline validation,
never as a silent production fallback.

`src/channels/telegram.ts` exports:

```ts
interface TelegramOptions {
  token: string;
  allowFrom: readonly string[]; // decimal Telegram user IDs, no wildcard
  pollTimeoutSeconds?: number;
}
function runTelegram(
  gateway: Pick<Gateway, "conversationFor">,
  options: TelegramOptions,
  context: Context,
): Promise<void>;
```

It runs until cancellation. It must work with an AbortSignal-derived Context;
CLI arranges SIGINT/SIGTERM cancellation and cleanup. Use `import type` for Gateway
to allow independent development. CLI may import the Telegram module once it lands;
report a missing parallel module as expected, not a reason to add stub code.

## Security and deliberately limited functionality

- Linux-only initial coding tools. Shell always uses a trusted absolute bwrap,
  fresh mount/PID/network namespaces, dropped capabilities, sanitized environment,
  no host-home/config mounts, only workspace/explicit extra roots writable and
  required system tools read-only. No unsandboxed or host-network fallback.
- Filesystem paths are confined equivalently to the Python `_resolve_path`,
  including traversal, sibling-prefix, symlink escapes, and nonexistent write
  destinations. Check every public FileSystem entry point (both rename paths,
  readers, cwd, temp/spill paths). Never expose an unrestricted base object.
  Preserve Result/error and abort contracts. Reuse NodeExecutionEnv facilities
  without claiming realpath checks alone are race-proof. Investigate concurrent
  symlink replacement and hardlink limitations, implement an OS boundary if
  necessary or report a blocker; do not mark the security gate proven prematurely.
- Shell must not inherit bot/provider tokens or host auth sockets. Do not mount
  dataDir in the shell. Runtime rejects dataDir under workspace or extra roots.
- No web/search/MCP HTTP tools in this slice, so no unguarded agent HTTP surface.
  Network isolation intentionally means shell network access is unavailable.
  Fixed Telegram API and configured model providers are host integrations, not
  arbitrary model-controlled URL fetchers. Future HTTP tools require the SSRF gate.
- Telegram uses a nonempty explicit numeric allowlist, private messages only,
  no groups, no wildcard, and no username authorization. Unknown users are ignored
  before creating sessions or sending input. No pairing UI in the spike.
- Never log token-bearing URLs, raw provider errors with credentials, or thinking
  blocks to Telegram. Text-only Telegram; unsupported attachments are not silently
  described as seen. Bound message size, long-poll processing and delivery retries.

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
plaintext sidecar state. Explicitly document restart recovery of undelivered final
answers; if not implemented it remains a failed Gate 1 criterion, not completion.

## Acceptance (parent review before any cutover)

- `npm ci`, `npm run typecheck`, `npm run build` in this package.
- Bounded offline model run -> committed transcript; reopen same session key;
  requestId deduplication; kill -9/reopen evidence for safe/unsafe tools.
- Workspace traversal/symlink/missing-leaf rejections; sandbox rejects outside
  writes/host secrets/network; abort and timeouts stop descendants.
- Telegram adapter checked with a fixed mock transport where feasible, no live
  polling. A real Telegram and fork-provider check remains owner-run unless
  authorized. Record each unproven condition rather than calling the gate passed.
