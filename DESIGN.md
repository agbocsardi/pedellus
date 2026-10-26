# Initial Durable port — 2026-10-26

## Scope and decision

This package is the new TypeScript build target. The Python tree is read-only
reference; the live fork and deployment are not changed. This document specifies Gate 1 of the root spike TODO. The owner subsequently
requested the comprehensive [full-port roadmap](../../2026-10-26_full-port_TODO.md)
(existing WebUI included, QuickJS-only Code Mode, Linux only, Pi SDK-first reuse
and bwrap preferred; no new UI framework or micro-VM requirement).
Those future milestones do not relax this slice's tool-less/security constraints
or authorize production cutover. Use Node >=22.19 and exact Pi 1.4.0
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
- Package manifest, lockfile, tsconfig and this design normally belong to the parent.
  For the approved grammY migration, `pi-e078edd8` also owns manifest/lock changes
  limited to adding the exact-pinned grammY dependency, plus package-local
  `THIRD_PARTY_NOTICES.md`. The parent does not edit these concurrently.

These are the historical spike assignments. Current P1/P2 ownership, including
exclusive manifest/lock ownership, is recorded in the full-port roadmap's active
batch and supersedes these assignments for that batch.

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

### Integration contracts

The owner approved a managed isolated workspace with explicit imports for the
next execution implementation, rejecting arbitrary writable host/extra roots and
omitting automatic publish-back. The legacy standalone spike contract below is
not that future gateway contract; revised API/security proof is pending worker
review. No execution capability is currently installed in the gateway.

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
When coding tools are approved, the runtime will await setup before Harness.open,
reuse environments for their lifetime, validate configured cwd, and call cleanup
after Harness.close. If a conversation's cwd changes, construct/cache an
appropriately confined environment, not a raw NodeExecutionEnv. Identity must
preserve upstream per-file serialization across environments addressing the same
files.

**Current integration decision:** the execution spike has unresolved filesystem
TOCTOU and hardlink escape risks. The gateway must remain tool-less: do not install
CodingTools, do not start an execution environment, and force `tools: []` on every
existing/new conversation before resuming work. No unsafe opt-in configuration.
The standalone experimental execution factory is not a production-safe capability.
This preserves a useful chat/Telegram slice without pretending the security gate
has passed.

`src/extensions/codemode.ts` provides the opt-in `createCodeModeIntegration`
factory, budgets and lifecycle/types, also exported by `src/index.ts`. Native
Code Mode/tool-search stays uninstalled in the gateway. SDK hosts must establish
native default-deny extension/tool state before scheduling, grant tools explicitly,
and reapply/revoke persisted selections before resume; `modelTools` is not the
nested-call authorization boundary. See `CODEMODE.md` for reviewed host setup,
budgets/replay/cancellation evidence and remaining product/security limitations.

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
  no host-home/config mounts, only the application-managed isolated workspace
  writable (explicit imports, no arbitrary writable host/extra roots), and required
  system tools read-only. No unsandboxed or host-network fallback.
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

## Approved Telegram transport direction

Use grammY's typed API client in place of hand-written Bot API request/response
plumbing. Preserve manually controlled `getUpdates` and the existing runTelegram
contract: no polling runner may acknowledge an update before Durable admission
and its recovery metadata are committed. Durable remains the sole state/session
owner; do not import OpenClaw runtime, SDK, or ingress/outbound queues.

Selectively adapt OpenClaw's bot-scoped flood policy, replaceable-preview
coalescing, edit error classification, and lifecycle separation. Keep protocol
adaptations narrow and preserve full MIT notice plus exact source provenance for
copied code. See `OPENCLAW-ASSESSMENT.md`. Adding grammY does not prove sendMessage retry safety or exactly-once external
delivery. Independent review requires a specific unknown-send policy: an ambiguous
timeout/reset/5xx on sendMessage must retain an explicit durable unknown-delivery
marker, not enter automatic resend/drain or claim success. Persist each send intent
with exact intended text BEFORE network dispatch; unresolved intents after a crash
must also be held as unknown. Atomically clear intent with known outcome/progress;
a failed intent commit must prevent the request. Preserve known accepted
chunk progress and expose sanitized status for operator inspection/reconciliation
through existing Durable state/SDK. Known rejections (e.g.429) and proven no-send
failures can retry under policy. No new retry UI/operator framework is in scope.

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
