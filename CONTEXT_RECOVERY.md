# Prepared context recovery

`openGateway` detects a live Durable provider task that has already pinned a
model context which still contains Nanobot sections. Those checkpoints are:

- `pi.generation` in phase `request` or `poll`, pinned at `cutoff`;
- `pi.compaction` in phase `summarize`, pinned at `tail`.

Resuming them would resend or fetch against the old context instead of a newly
rendered host snapshot. The guard does not rewrite a checkpoint, clear transcript
history, or guess that an apparently unchanged snapshot is equivalent: even an
unchanged snapshot is not replayed. This module supplies the reconciliation:

- the gateway automatically cancels exactly these startup-blocking dispatches
  through native `abortTask`, restores availability, and records one durable
  interruption notice for the originating owner surface;
- if automatic cancellation cannot complete safely, the open still fails closed
  with a fixed diagnostic, and the explicit recovery command below inspects and
  cancels selected tasks by exact fingerprint.

Automatic cancellation supersedes the earlier prohibition on startup cancellation
for this exact scope. It does not authorize automatic replay, resubmission,
provider/tool retry, a model nudge, checkpoint rewriting, cancellation of other
tasks, or automatic continuation: the owner asks to continue.

`pi.compaction` phase `retry` is deliberately not one of them. Durable commits that
checkpoint only after the previous attempt's provider response arrived and its
retryable error was stored, and it still has to commit the next attempt's
`summarize` checkpoint before that attempt can dispatch. A stored `retry` therefore
proves that the attempt it schedules was never sent, and the summarization request
it sends is built from non-system messages of the immutable entry range at `tail`:
it carries no host context at all. Such a task resumes natively when the gateway
opens; no owner action is needed and no unrecorded request is repeated. Its pinned
model still has to stay in `allowedModels`, exactly as before.

A normal CLI start does not print the task ID, pinned entry, path, provider/model
or context text. If automatic recovery cannot complete safely (a full interruption
record after its settled entries were drained, a native abort that failed or did
not persist, or a prepared model outside `allowedModels`), it fails with one fixed,
value-free diagnostic naming `pedellus recovery --config <path>` as the next
action. SDK callers retain the detailed error message for inspection. The explicit
recovery command below is the fallback, while the stopped-store recovery operation
remains available for unsupported or failed cases.

A record the open cannot read is not one of those cases. The interruption mark and
the interrupted-run record carry optional bookkeeping, never authority, so an
unreadable or foreign-version one is retired through native `retireDoc`: the
unreadable incarnation stays in the store's document history, nothing interprets
or repairs it in place, and the authoritative task scan still cancels the
dispatch. Two things are lost with it: any pending notice it held (the owner may
never see that one interruption) and the suppression record of an already-cancelled
run, whose internal result event may then be admitted once. A single fixed,
value-free delivery fault records the notice loss on the origin this open can still
name; it is a `jobId: null` outbox fault, which no owner reader currently displays.

## Automatic interruption recovery

After the prepared-model authority scan accepts every live prepared dispatch, the
open checks the pinned context of each one. A dispatch whose pinned context still
contains a nonempty Nanobot section is cancelled through native
`Harness.abortTask`, exactly as the explicit owner path does. No checkpoint is
rewritten and no provider/tool call is retried. Generation abort keeps a committed
partial as an `aborted` assistant entry when one exists and settles its input as
`unanswered` with reason `aborted`; compaction abort removes its live status. The
transcript and committed progress remain. External effects already performed are
not undone, and a `request`-phase provider call cannot be remotely cancelled or
refunded. A `poll` abort may ask the configured catalog to cancel its deferred
handle best-effort, exactly as before.

The notice is one fixed text per interrupted class, so it never claims more than
the host knows. A cancelled generation in a mapped owner chat says:

> Previous turn was interrupted. Recorded progress is preserved, but some actions
> may have completed without confirmation. Ask me to continue.

A worker or scheduled-run dispatch is background work, not the owner's previous
turn, and says:

> Background work was interrupted. Recorded progress is preserved, but some
> actions may have completed without confirmation. Ask me to continue if you still
> need it.

An interrupted memory-digestion dispatch is host maintenance: its batch is not
acknowledged, so it is offered again without the owner doing anything:

> Background memory digestion was interrupted. Recorded progress is preserved;
> the unacknowledged batch is offered again, so no action is needed.

A cancelled compaction is background maintenance, not a turn, wherever it ran,
and says:

> Background context compaction was interrupted. Recorded progress is preserved;
> no action is needed.

It is admitted into the origin chat's existing bounded channel outbox
(`nanobot.cron.deliveries`, `host:turn-interrupted:<taskId>`) in the same commit
that clears a small session-scoped interruption mark. It creates no transcript
entry, submits nothing, and calls no model. The record is idempotent by task ID,
so a reopen cannot duplicate it. A local CLI attach prints pending interruption
notices and acknowledges exactly those records; an unacknowledged notice is
shown again on reattach rather than lost, and a CLI that attaches while nothing is
pending never sees an older one. Telegram consumes the same record
through its existing outbox path: durable origin admission, the live `allowFrom`
recheck, rich chunking, write-ahead intent and unknown-outcome hold all apply.
An ambiguous send becomes `unknown` and is never resent; a missing admission
binding is `withheld` until that private chat admits a fresh message; a sender no
longer admitted is `unauthorized` and not sent.

A cancelled worker or digest dispatch also fails the background run that owned it.
Its ordinary terminal report is one internal model-facing event into the origin
chat, which would start a model turn and duplicate the notice, so the open records
that exact run in a small bounded session disposition before the native abort. Only
a dispatch whose cancellation actually fails the run is recorded: the target's own
generation, or a blocking compaction a generation waits on. A background or manual
compaction is cancelled without failing the run, so it records nothing and cannot
make a later ordinary failure or cancellation silent. The
run's own terminal commit consumes the entry and marks its record already reported
in the same commit, so a reopen, an abort, or a crash between the abort and the
notice admission cannot resurrect the turn. The terminal state, status, history,
frontier and every ordinary worker/digest failure or cancellation report are
unchanged: only an automatic startup interruption is silent to the model. A
digest target deliberately carries no host context snapshot, so in the shipped
configuration its own batch dispatch is not startup-blocked at all; the same
disposition exists so a digest dispatch that ever does pin host sections cannot
start an origin turn either.

The notice origin is derived from authoritative state, never guessed from a
conversation ID:

- a mapped ordinary chat owns its own prepared dispatch;
- a scheduled run's automation conversation is reported to the mapped origin that
  the host's cron classification records;
- a worker or digest target is reported to the mapped chat whose run task created
  it;
- a target with no mapped-chat origin (for example a damaged mapping) is still
  cancelled so the gateway can start, but it gets no user-facing notice.

Calling an already owner-abort-marked or terminal task "interrupted" is wrong, so
the exact scanner skips it: ordinary cancellations and already fenced jobs acquire
no notice and are not rearmed. The session mark is bounded at 8 pending entries,
and notices already pending from an earlier open are admitted and cleared first, so
the bound only refuses a new mark for eight genuinely undelivered notices. Native
`abortTask` failures, a native abort mark that did not persist, and a still-full
record fail the open with the fixed recovery diagnostic instead of leaving a
half-cancelled dispatch behind.
The notice outbox is bounded by the existing 1000-record/200-terminal limits. If
admission returns `full` or `invalid`, startup still restores availability and
records a bounded delivery fault rather than retrying or evicting an
unknown-outcome record; that occurrence then gets no owner notice, and nothing is
ever resent or evicted to make room.

A configured channel is not required to cancel: a host with no attached channel
leaves the record pending. The notice is not redirected to another chat or
channel, and a notice is only ever shown by a CLI attach or delivered by Telegram:
the gateway itself never pushes it to a terminal.

## What recovery does

`listPreparedContextBlocks(config, context, options?)`:

- requires an existing `dataDir/nanobot.sqlite`; a missing directory, typo, or
  missing database fails closed instead of creating an empty store;
- takes the same kernel process lock and canonical SQLite path as the gateway.
  Stop the running gateway first: a live owner is reported as a lock conflict,
  not as an empty or successful result;
- opens storage and a Harness but never calls `resume()`;
- scans live tasks for prepared generation request/poll and compaction `summarize`
  dispatches;
- reads each pinned context and reports only dispatches with a nonempty Nanobot
  section;
- reports what durable state records about each dispatch's provider response;
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
  phase: "request" | "poll" | "summarize";
  at: number;          // pinned cutoff/tail entry ID
  response: "partial-response" | "deferred-response" | "unrecorded";
  fingerprint: string; // exact task state binding, see below
}
```

The fingerprint is SHA-256 over a version string, task ID, kind, conversation ID,
phase, pinned entry ID, pinned attempt, and the reported `response`. It does **not**
cover the checkpoint model, stream options, request body, task definition version,
transcript bytes, or any other checkpoint field. Cancellation re-reads the blocked
list under the lock and requires the exact task ID and fingerprint, so a changed
phase, cutoff, attempt or response evidence is rejected rather than retargeted;
unrelated checkpoint changes are not independently bound. This is fingerprint v2;
values listed by an older build must be re-listed before cancellation.

`response` is read from Durable's own durable state, so an owner can tell what a
cancellation gives up:

- `partial-response`: `pi.live` holds a committed throttled partial of this attempt.
  The provider stream produced content; its remote outcome is unknown.
- `deferred-response`: a `poll` checkpoint is committed together with the received
  deferred handle. Whether a fetch was attempted or answered is not durably
  recorded: a crash before classification commits can leave the same checkpoint.
- `unrecorded`: the dispatching phase may have run; nothing durable proves it did
  not. Durable 1.5.0 stores the `request` phase's `pi.live` attempt marker like
  streamed progress, so a crash can lose the marker and even the document; an absent
  marker is a missing observation, never proof that no request was sent. What a
  cancellation gives up is the pending turn, and possibly a remote request whose
  outcome nobody recorded. A compaction carries no dispatch marker, and a `request` whose marker
  matches can be a fresh attempt that streamed nothing yet or a retried attempt
  whose marker the retry phase pre-set. The guard reports this as unknown rather
  than guessing.

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
- **Continue an interrupted generation request at all.** No phase-specific
  reconciliation makes a blocked `pi.generation` `request` resumable with this
  pinned Durable generation. A supported continuation would need an upstream
  checkpoint transition back to `prepare` (with its own authority and audit
  rules); approximating it here would either resend the pinned view or rewrite a
  checkpoint. Cancelling keeps the transcript and loses only the pending turn,
  and `response` distinguishes recorded evidence from unknown outcomes. Likewise,
  a `poll` is not resumed: fetching its deferred response makes a provider call
  without resending the generation context, but the answer was generated from
  the pre-stop snapshot, so the guard treats it like the rest of the pinned view.
- **Automatic replay, resubmission or continuation.** Automatic startup recovery
  cancels only the exact prepared dispatch; it never resends the pinned request,
  retries a provider/tool call, rewrites a checkpoint, starts a model turn or
  nudges the agent to continue. The owner supplies the next input. Explicit
  recovery still requires the owner to choose a task and supply its fingerprint;
  an incorrect or stale choice writes nothing.
- **Cancelling every task, job or background task.** The scope is only
  `pi.generation` request/poll and `pi.compaction` summarize dispatches whose
  pinned context still carries Nanobot sections and whose prepared model passed
  the authority scan. A model-authority failure remains a startup failure; no
  allowlist entry is silently added or bypassed to make the open pass.
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

- a real child process SIGKILL during a prepared generation `request`; CLI
  inspection and stale fingerprint rejection leave the lock released; explicit
  cancel then reopen sends zero replay requests, keeps the original user
  transcript, runs the task to terminal `aborted`, and lets a later request use
  the fresh snapshot; the explicit path acquires no interruption notice;
- automatic startup recovery of that same crash shape: the gateway opens, sends
  zero requests, keeps the input transcript, settles the task `aborted`, admits
  exactly one pending notice in the origin chat's outbox, and a reopen neither
  duplicates the notice nor dispatches a model; the notice survives to a CLI
  attach, is acknowledged once, and a later input renders only the fresh context;
- a recreated crash window with the native abort mark and pending interruption
  mark already durable but the notice not yet admitted: the next open admits one
  notice, clears the mark in that commit, and runs the abort protocol with no
  dispatch;
- the class mapping reports a scheduled automation, worker and digest target to
  the mapped chat origin with its own wording class, and an unmapped target yields
  no guessed surface; a pending mark whose recorded session no longer maps to that
  origin is cleared while its dispatch is still cancelled, with no notice
  retargeted;
- an unreadable interruption record is retired instead of blocking startup: the
  blocked dispatch is still cancelled by the authoritative task scan, the current
  cancellation still gets one notice, and the fixed value-free loss fault is
  recorded on the origin;
- a real SIGKILLed worker whose child turn left a prepared generation inside the
  worker's task-owned target: the reopen sends zero requests, the work still ends
  terminal, exactly one background notice is pending for the mapped origin chat,
  no internal worker result event is admitted, the run's suppression entry is
  consumed by its own terminal commit, and a second reopen resurrects neither the
  report nor the notice;
- a digest terminal result that carries the automatic-interruption flag is silent
  and prunable, while an ordinary failed or cancelled digest result stays
  reportable and a flagged result whose native status disagrees stays unknown; the
  digest behaviour suites still cover the real ordinary failure and cancellation
  reports end to end;
- a synthetic Telegram origin receives the notice once through the real adapter
  and mocked transport, and an ambiguous notice send is retained as `unknown`
  across a gateway reopen with no resend or eviction;
- two concurrent conversations with prepared requests: one is cancelled through
  the CLI, the other still blocks, then the second is cancelled; both end terminal
  without replay;
- `blocked` entries carry the phase, pinned entry, fingerprint and the
  `response` evidence; `partial-response` and `deferred-response` are reported, and
  an absent attempt marker is reported `unrecorded` rather than claimed as proof;
- a prepared compaction `retry` is not listed and not blocked: reopening resumes it
  and sends exactly the next summarize attempt, whose request carries neither the
  pinned nor a freshly rendered Nanobot section, and places its summary at the
  pinned first entry;
- SIGKILL during a prepared manual compaction `summarize`; cancel prevents a
  second summarize dispatch and preserves the large original transcript;
- an unsupported persisted task version reports `orphaned` immediately instead of
  a bare abort mark;
- a synthetic prepared `poll` on a revoked model remains blocked after
  cancellation, with a faux `cancelDeferred` spy at zero; restoring the allowlist
  permits the native abort and exactly one best-effort `cancelDeferred`, with no
  model dispatch;
- an automatic recovery that cannot complete prints the fixed value-free recovery
  action and no path, provider, model, session or pinned-context value; startup
  against a live owner prints the fixed stop-the-other-owner message with the raw
  lock name and paths suppressed;
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
exercises the same checkpoint scanner and abort path, but no real crash fixture), a
real crash between a compaction `retry` checkpoint and its next attempt (the record
is written directly, then resumed through the same native phase), a real crash
between a generation's request checkpoint and its attempt-marker commit (a crash
there is reported `unrecorded`, so no test asserts that it was never dispatched),
provider-side cancellation or billing of an already-dispatched remote request,
recovery while a gateway is still running (it fails closed on the lock), live
database/WAL copying, corrupt or torn-copy restore, and physical power-loss
durability beyond SQLite's configured WAL/FULL behavior. The crash window between
a CLI printing a notice and acknowledging it is at-least-once by design (the next
attach repeats it), and a full or malformed notice outbox records a fault instead
of delivering that one notice; that fault is a `jobId: null` record, so no owner
reader displays it yet. An unreadable interruption record loses the notices it
held and the suppression entry of an already-cancelled run; there is no repair
operation for that transient bookkeeping and none is needed for availability. A
mixed client/gateway local protocol (a stale attached process against a v3
gateway) fails with the fixed `local gateway protocol mismatch` message and no
attach; the shipped executable always serves both halves together.
A prepared dispatch whose model left
`allowedModels` is never auto-cancelled, including a revoked generation `poll`
whose abort would need that model for `cancelDeferred`; the fixed model guard
still stops the open.
