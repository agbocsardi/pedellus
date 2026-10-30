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

A normal CLI start that hits this guard fails with one fixed, value-free
message naming `nanobot recovery --config <path>` as the next action. SDK callers
retain the detailed error message for inspection. It does not
print the task ID, pinned entry, path, provider/model or context text, and it does
not cancel the task. The same configuration's recovery command is the next step.

## What recovery does

`listPreparedContextBlocks(config, context, options?)`:

- requires an existing `dataDir/nanobot.sqlite`; a missing directory, typo, or
  missing database fails closed instead of creating an empty store;
- takes the same kernel process lock and canonical SQLite path as the gateway.
  Stop the running gateway first: a live owner is reported as a lock conflict,
  not as an empty or successful result;
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
  fingerprint: string; // exact task state binding, see below
}
```

The fingerprint is SHA-256 over a version string, task ID, kind, conversation ID,
phase, and pinned entry ID. It does **not** cover the checkpoint model, stream
options, request body, task definition version, transcript bytes, or any other
checkpoint field. Cancellation re-reads the blocked list under the lock and
requires the exact task ID and fingerprint, so a changed phase or cutoff is
rejected rather than retargeted; unrelated checkpoint changes are not
independently bound.

`cancelPreparedContextBlock(config, { taskId, fingerprint }, context, options?)`
re-lists blocked dispatches under the lock and requires the exact fingerprint,
then calls native `Harness.abortTask(taskId)` and closes without resuming
scheduling. It re-reads the task rather than trusting the native `marked` return:

- `abort-marked`: live and durably marked; the next gateway open runs the abort
  protocol;
- `terminal`: already settled;
- `orphaned`: immediately settled because no registered definition can take the
  persisted task (for example an unsupported task version).

Native `abortTask` persists an abort mark. The next `openGateway` skips
abort-marked tasks in the context guard and applies host policy/context before
resuming. The model guard is not bypassed for an abort-marked generation `poll`:
that abort can call `models.cancelDeferred`, so its checkpoint model must still be
in `allowedModels`. Other abort-marked phases cannot dispatch and may skip the
model guard. The native abort protocol runs before any run phase. Generation abort
appends a committed partial as an `aborted` assistant entry when one exists and
settles its input as `unanswered` with reason `aborted`; compaction abort removes
its live status. The native abort protocol also cascades to ordinary tool tasks
the cancelled task owns. No checkpoint is rewritten and no remote request is
retried.

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
  outside our control and is never retried automatically. Recovery itself never
  calls `cancelDeferred`. For `poll`, the next gateway open's native abort may ask
  its configured `Models` catalog to cancel the deferred handle best-effort, but
  only after the model guard accepts the checkpoint model. If that model was
  removed from `allowedModels`, recovery can still mark the task but the gateway
  remains blocked and no remote cancellation is attempted; restore the allowlist
  or leave the task blocked.
- **Blocking-compaction cancellation cascading into a stale request.** If a
  generation was waiting for the cancelled blocking compaction, the gateway's
  next normal preparation re-renders the current host context. If that
  preparation itself has already committed to `request`/`poll`, it is a separate
  blocked task that must also be listed and cancelled.
- **Transcript or database deletion.** Cancellation preserves all stored entries
  and session mappings. It does not erase historical context entries.

## CLI

`node dist/cli.js recovery` does not open the gateway, require provider
credentials, or install a context snapshot provider. It does require an existing
database and the gateway process to be stopped. Inspection may perform Durable's
native `Harness.open()` crash reconciliation (for example `running` to `pending`
and restart counters); it never resumes task execution.

```sh
# Inspect blocked prepared dispatches (JSON, no task payloads or secrets)
node dist/cli.js recovery --config /path/to/config.json

# Cancel exactly the inspected task
node dist/cli.js recovery --config /path/to/config.json \
  --cancel 42 --fingerprint 8b42b0c2b065d87442bdcd67238c3197bf6163a9ef6e53bb18373c70f382a189
```

The cancel output is `{"status":"abort-marked","taskId":42}`; an immediately
settled task reports `terminal` or `orphaned`. Reopen the gateway to run the native
abort protocol for `abort-marked`. A revoked poll model remains fail-closed at that
reopen and is not remotely cancelled.

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

`options.models` only constructs the paused inspection Harness; recovery never
dispatches, resumes, or authorizes a model with it. The default is an empty
catalog, so recovery performs no provider call and needs no credentials. A later
gateway open uses its own authoritative `allowedModels` and catalog.

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
  second summarize dispatch and preserves the large original transcript;
- an unsupported persisted task version reports `orphaned` immediately instead of
  a bare abort mark;
- a synthetic prepared `poll` on a revoked model remains blocked after
  cancellation, with a faux `cancelDeferred` spy at zero; restoring the allowlist
  permits the native abort and exactly one best-effort `cancelDeferred`, with no
  model dispatch;
- normal CLI startup for a blocked prepared dispatch prints the fixed recovery
  action and no path, provider, model, session or pinned-context value, and leaves
  the dispatch blocked; startup against a live owner prints the fixed
  stop-the-other-owner message with the raw lock name and paths suppressed;
- a cleanly stopped synthetic gateway is copied by main database file plus
  workspace (no live WAL copy), then reopened at new paths: the same session
  mapping and entry IDs/text, restored topic memory, and durable request-ID
  dedupe all survive without a new model dispatch; the original source workspace
  later changes and is not used by the restored gateway;
- holding the real gateway lock makes recovery report an actionable conflict;
  closing the gateway then releases the lock;
- a typo/missing data directory or missing database is rejected before `mkdir` or
  SQLite initialization, leaving no empty store behind.

Not covered here: an actual deferred `poll` crash fixture (the synthetic poll task
exercises the same checkpoint scanner and abort path, but no real crash fixture),
provider-side cancellation of a live remote request, recovery while a gateway is
still running (it fails closed on the lock), live database/WAL copying, corrupt or
torn-copy restore, and physical power-loss durability beyond SQLite's configured
WAL/FULL behavior.
