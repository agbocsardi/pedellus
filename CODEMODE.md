# Durable Code Mode integration

This is a reusable, **opt-in** bundle for the TypeScript port. The current gateway
is unchanged: it still installs no extensions and persists `tools: []`. Creating
the bundle does not install or select it.

```ts
import { createCodeModeIntegration } from "./extensions/codemode.js";

const codeMode = createCodeModeIntegration(); // `models.*` stays disabled
for (const extension of codeMode.extensions) registry.install(extension);
// Select the bundle only on reviewed conversations, and explicitly enable only
// reviewed tools. `modelTools` narrows direct model calls; it cannot enable a
// tool omitted from `tools`.
await conversation.configure({
  extensions: { add: codeMode.extensions },
  tools: approvedTools,
  modelTools: [codemodeTool, toolSearchTool],
}, context);
// Shutdown: stop Code Mode admission, close/abort the owning Harness so Durable
// can drain nested tasks, then wait for the sandbox's actual worker exits.
codeMode.stopAdmission();
await harness.close(context);
await codeMode.close();
```

## Contract and limits

`createCodeModeIntegration()` composes `@earendil-works/pi-durable@1.4.0`'s
`createCodemodeExtension` and `createToolSearchExtension`, with transitive
`@earendil-works/pi-codemode@1.4.0`. Its extensions use Durable's registry and
Harness; this is not the coding-agent `ExtensionAPI` / `AgentSession`. It does
not implement a second runner, VM, journal, nested-call router, receipt store,
or discovery index. All script tool
calls use Durable `executeTool()` and therefore its schema validation, callers,
`ToolTask` hooks, ownership, replay policy, structured results and cancellation.
`tool_search` only loads the enabled deferred tools in the current agent. Disabled
or otherwise unenabled tools are neither searchable nor callable from Code Mode.

The host adapter clamps the native Code Mode options line (and injects defaults)
so Durable persists a restart-stable deadline and output budget with its native
run document. The QuickJS sandbox and shared worker admission defaults are:

| Limit | Default / behavior |
| --- | --- |
| QuickJS heap | 128 MiB per script; not a cap on Node worker/process RSS |
| Script deadline | 60 seconds, also the maximum accepted `timeout_ms` |
| Model-visible output | 4,000 tokens, also the maximum accepted `max_output_tokens` |
| Native tool output | Durable's 4 MiB / 100,000-line output limit |
| Worker capacity | Two workers per bundle; excess admission fails fast, no waiting queue |
| Shutdown | Stop admission, abort active Code Mode calls, close the native sandbox and wait for actual worker exit |

All Code Mode executions from one bundle share its two-worker capacity. Create
one bundle per Harness/runtime, not one per conversation, or each instance would
have a separate allowance; `tool_search` itself does not start a VM. Native `CodemodeSandbox`
can settle a cancelled result before the worker exits; this adapter holds each
slot through the native `acquireWorker()` release callback and makes `close()`
await `onWorkerStarted(exited)`. A non-interruptible native worker operation can
therefore delay shutdown. The QuickJS environment has no direct Node, filesystem,
network, or timer globals; injected tools still carry their own authority and
must be independently confined.

`models: true` is an explicit opt-in for Durable's additional `models.*`
capabilities. It is not enabled by default. Code Mode is model-only (scripts
cannot recursively start Code Mode); native deferred discovery is still available
to scripts through `searchTools()`.

## Replay and failure semantics

Durable journals Code Mode call results before delivering them to the deterministic
QuickJS replay, reattaches nested calls by their native keys, and owns `store()` /
`load()` in the native per-conversation rewindable document. A fork sees the
store as of its fork entry. A completed nested call is not rerun just because the
script resumes. An interrupted nested call follows *its own* replay setting:
unsafe calls return an interrupted error rather than being blindly replayed;
replay-safe calls can rerun and must be genuinely idempotent. This is storage and
submission replay behavior, **not** external-side-effect exactly-once safety.
An interrupted external request can have taken effect before its result was
committed. Durable `requestId` deduplicates admission, not the external effect.

A rejected nested tool call throws in the script unless its schema-bearing error
returns a structured value. A script can catch and discard an error and then
return success; this integration has no product-level failure-verification hook
that can infer a discarded error. That legacy worker/failure-verification
semantics remains open for later host policy. In particular, Durable `bash`
returns structured `{ output, exitCode, ... }` even for nonzero status. Such a
schema result can resolve to the script rather than throw, so scripts must inspect
`exitCode`; nonzero must not be presented as success. These probes used a synthetic
schema tool to verify the result shape and did **not** enable or run bash.

The helper does not own the Harness scheduler or nested Durable tasks. On host
shutdown, call `stopAdmission()`, then close/abort the owning Harness so its task
ownership drains, then call `close()` to wait for the actual worker exits. Closing
only the native sandbox is deliberately not a durable tool outcome; without
caller cancellation, native Code Mode can leave the task pending for recovery.

This bundle does not install native filesystem/bash tools, approve MCP, or make
P1 confinement pass. It must remain uninstalled until the host explicitly enables
reviewed tools under their own policy. It is not evidence that P1, P2 as a whole,
or the TypeScript port has passed acceptance.

## Offline verification evidence

No committed test scaffolding was added. The bounded temporary probes used Node
22.22.2, the actual Durable Harness and file-backed SQLite storage, the actual
QuickJS worker, faux models, and only synthetic tools. No provider credentials,
network, Telegram, bash, host configuration, or production data were used.

- `/tmp/nanobot-p2-probes/verify-local.mjs` (run with
  `timeout 60s node --experimental-strip-types /tmp/nanobot-p2-probes/verify-local.mjs`):
  native tool-search exposes an enabled deferred tool; Code Mode invokes only
  enabled synthetic tools; disabled tool lookup/call fails; hooks deny before
  execution; a caught nested error may still yield a successful script; an
  uncaught error remains an error; structured synthetic exit code 7 is visible;
  `store` survives and forks as-of; output is clamped; an oversized user budget
  is persisted as 60,000 ms / 4,000 tokens; a third worker is denied at the
  two-worker limit; cancellation aborts both running nested calls; Harness tasks
  drain before helper close. Captured output:
  `/tmp/nanobot-p2-probes/local-result.json`.
- `/tmp/nanobot-p2-probes/verify-replay.mjs` launches
  `/tmp/nanobot-p2-probes/replay-child.mjs`, sends the first actual Harness
  process `SIGKILL` after a completed synthetic effect and a second unsafe effect
  has written to a private local ledger, then reopens the same SQLite database.
  Evidence: `/tmp/nanobot-p2-probes/replay-result.json` and the private run
  directory named there. After reopen the run settled with the native
  `unsafe_effect was interrupted and may have partially run` error; ledger rows
  remained exactly `completed`, `unsafe-started` (one each). This shows completed
  nested-result replay and non-replay of an interrupted **unsafe** call, not
  rollback or exactly-once behavior for an external service.

The probes have bounded `timeout` limits (60 seconds for local integration,
30 seconds for restart recovery), three Harnesses maximum, two admitted workers,
and a 128 MiB QuickJS heap limit. They do not establish provider behavior,
filesystem confinement, non-interruptible-worker upper bounds, safe-tool effect
idempotency, or live service readiness.
