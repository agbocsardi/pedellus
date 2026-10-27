# Prepared context recovery

`openGateway` fails closed when a live Durable provider task has already pinned a
model context that still contains Nanobot sections. Those checkpoints are:

- `pi.generation` in phase `request` or `poll`, pinned at `cutoff`;
- `pi.compaction` in phase `summarize` or `retry`, pinned at `tail`.

Resuming them would resend or fetch against the old context instead of a newly
rendered host snapshot. The guard does not rewrite a checkpoint, clear transcript
history, or guess that an apparently unchanged snapshot is equivalent: even an
unchanged snapshot stays blocked. This module supplies the missing owner-driven
reconciliation: inspect exactly which dispatches are blocked, then cancel selected
ones durably.

## What recovery does

`listPreparedContextBlocks(config, context, options?)`:

- takes the same kernel process lock and canonical SQLite path as the gateway;
- opens storage and a Harness but never calls `resume()`;
- scans live tasks for prepared generation/compaction dispatches;
- reads each pinned context and reports only dispatches with a nonempty Nanobot
  section;
- does not resume scheduling or change a transcript entry, submission, policy, or
  provider state. Native `Harness.open()` may still perform its documented crash
  recovery of a `running` task to `pending` and increment its restart counter, so
  inspection is not byte-for-byte read-only.

It returns at most one record per task:

```ts
interface PreparedContextBlock {
  taskId: number;
  kind: "pi.generation" | "pi.compaction";
  conversationId: number;
  phase: "request" | "poll" | "summarize" | "retry";
  at: number;          // pinned cutoff/tail entry ID
  fingerprint: string; // binds cancellation to this exact state
}
```

`cancelPreparedContextBlock(config, { taskId, fingerprint }, context, options?)`
re-lists blocked dispatches under the lock and requires the exact fingerprint.
A changed phase, cutoff/tail, task, or already-cancelled state is rejected rather
than retargeted. It then calls native `Harness.abortTask(taskId)` and closes
without resuming scheduling.

Native `abortTask` persists an abort mark. The next `openGateway` skips
abort-marked tasks in both the model and context replay guards, applies host
policy/context, then resumes. The native abort protocol runs before any provider
phase. Generation abort appends a committed partial as an `aborted` assistant
entry when one exists and settles its input as `unanswered` with reason
`aborted`; compaction abort removes its live status. The native abort protocol also
cascades to ordinary tool tasks the cancelled task owns. No checkpoint is rewritten
and no remote request is retried.

## What is intentionally not supported

- **Resume the pinned request with new context.** Durable has no supported
  operation that rewrites a live generation/compaction checkpoint. Replacing its
  cutoff, model, or request body would bypass the persisted task protocol. Cancel
  it and let the next run prepare from the current host snapshot instead.
- **Automatic cancellation or settlement.** `openGateway` never cancels a task
  because context changed. The owner chooses the task and supplies its
  fingerprint; an incorrect or stale choice writes nothing.
- **Proof that a changed/unchanged snapshot is equivalent.** Section rendering
  and the checkpoint are not cryptographically bound, so recovery does not
  auto-accept unchanged content.
- **Cancelling a remote request that was already dispatched.** In `request`,
  Durable has no handle to cancel; any provider response or charge remains
  outside our control and is never retried automatically. In `poll`, native abort
  asks the configured `Models` catalog to cancel the deferred handle best-effort.
  The default recovery catalog is empty (offline, no credentials), so no provider
  call is made; cancellation just stops further polling.
- **Blocking-compaction cancellation cascading into a stale request.** If a
  generation was waiting for the cancelled blocking compaction, the gateway's
  next normal preparation re-renders the current host context. If that
  preparation itself has already committed to `request`/`poll`, it is a separate
  blocked task that must also be listed and cancelled.
- **Transcript or database deletion.** Cancellation preserves all stored entries
  and session mappings. It does not erase historical context entries.

## CLI

`node dist/cli.js recovery` does not open the gateway, require provider
credentials, or install a context snapshot provider.

```sh
# Inspect blocked prepared dispatches (JSON, no task payloads or secrets)
node dist/cli.js recovery --config /path/to/config.json

# Cancel exactly the inspected task
node dist/cli.js recovery --config /path/to/config.json \
  --cancel 42 --fingerprint 8b42b0c2b065d87442bdcd67238c3197bf6163a9ef6e53bb18373c70f382a189
```

The cancel output is `{"status":"abort-marked","taskId":42}`. Reopen the gateway
to run the native abort protocol. A task already terminal when cancellation runs
reports `terminal`.

## SDK

The same operations are exported from the package barrel:

```ts
import { listPreparedContextBlocks, cancelPreparedContextBlock } from "@nanobot/pi-durable-port";

const blocked = await listPreparedContextBlocks(config, context);
await cancelPreparedContextBlock(config, {
  taskId: blocked[0].taskId,
  fingerprint: blocked[0].fingerprint,
}, context);
```

`options.models` is available for a host that wants poll cancellation to use its
real catalog. The default is an empty catalog, so recovery performs no provider
call and needs no credentials.

## Verified offline boundaries

`tests/context-recovery.behavior.test.mjs` uses temporary SQLite stores and faux
providers only:

- a real child process SIGKILL during a prepared generation `request`; changed,
  unchanged, and opted-out host snapshots each block; CLI inspection and stale
  fingerprint rejection leave the lock released; explicit cancel then reopen
  sends zero replay requests, keeps the original user transcript, runs the task
  to terminal `aborted`, and lets a later request use the fresh snapshot;
- two concurrent conversations with prepared requests: one is cancelled through
  the CLI, the other still blocks, then the second is cancelled; both end terminal
  without replay;
- SIGKILL during a prepared manual compaction `summarize`; cancel prevents a
  second summarize dispatch and preserves the large original transcript.

Not covered here: an actual deferred `poll` crash fixture (the guard and recovery
share the same checkpoint scanner used for `request`/`summarize`, but polling is
source-reviewed only), provider-side cancellation of a live remote request,
cross-process recovery against a running gateway, and physical power-loss
durability beyond SQLite's configured WAL/FULL behavior.
