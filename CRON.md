# Cron: deterministic timer plus finite run

This replaces the parked recurring-task foundation. It is **not wired** into the gateway,
channels, config, tools, delivery, or a calendar parser. Nothing here sends a message outside
the Durable conversation it submits to.

Files:

- `src/automation/cron.ts` — job document, timer task, run task, controller API.
- `src/automation/cron-schedule.ts` — one-shot and interval schedule math.
- This document.

## Why two tasks

A single task that both waited for the next slot and ran the model made recurrence depend on the
model completing. The replacement splits that in two:

- **Timer task** (`nanobot.cron.timer`) sleeps until one slot, then commits its successor and
  durable execution work in one transaction. It never calls a model and then terminates.
- **Run task** (`nanobot.cron.run`) submits/reattaches one native agent input, records the result,
  and terminates. It never computes or creates a schedule.

Both tasks are conversation-owned and `background: true` in the origin conversation. The run task
creates a fresh task-owned conversation for one occurrence (or uses the origin in `origin` mode).

## Timer handoff

When the timer wakes at `scheduledAtMs`, one commit does all of this before any model request:

1. Fence the job: generation, cancellation, and `timerTaskId`.
2. Check the previous run task. A non-terminal run task means it is still active.
3. On overlap: record `lastSkip`, leave `lastOutcome` untouched, and arm only the next timer.
4. Otherwise: create the run task and set `executionTaskId`.
5. Create the next timer task on the fixed grid and move `timerTaskId` to it, or clear it for a
   one-shot.
6. Terminal-commit the timer task.

A slow, unavailable, failed, faulted, or crashing model cannot prevent step 5: it has already
committed. The next timer is deterministic code and cannot be skipped by a model result.

Busy slots are skipped, not backfilled or coalesced. A skipped slot writes `lastSkip` and a timer
task record; the active run's `lastOutcome` is not overwritten. A non-terminal run task, including
a parked one, counts as active, so the schedule visibly keeps skipping until it is retried or
cancelled.

## Job document

One record in the origin conversation's `nanobot.cron.jobs` document, fixed size:

```ts
{ id, owner, name, message, mode, schedule, idempotencyKey, createdAtMs,
  generation, timerTaskId, executionTaskId, cancelledAtMs,
  lastOutcome, lastSkip, lastFault }
```

`timerTaskId` is the only timer allowed to arm the next slot. `executionTaskId` is the newest run
task and drives overlap checks. `lastOutcome` is the newest run result; `lastSkip` is the newest
busy skip; `lastFault` retains the newest execution fault after a timer replaces its pointer.
There is no stored `nextAtMs`, no occurrence array, and no job lifecycle state machine. Full
history stays in timer/run task records and conversation entries, under Durable's normal retention.

## Native run and recovery

Each run submits one native input with the stable request ID
`cron:<jobId>:<scheduledAtMs>`. Durable's `submissionByRequest` behavior makes a retry after a
crash return the same submission, so the restart waits on the existing run instead of admitting a
second one. The run task's checkpoint stores its chosen target conversation, so a crash after that
commit does not recreate it or rerun host preparation. There is no waiting task on a submission ID;
the run phase waits directly.

`createCronFoundation({ prepare })` accepts one optional host callback. It receives the origin and
target conversation IDs, the job, and the occurrence. It runs inside the commit that chooses the
run's target conversation, so its writes and the target choice are atomic. It is the only place to
add context or tool grants; without it this slice adds none. It must be durable and idempotent
because a crash before that commit reruns it.

The run stores that target choice once in its checkpoint. A resume after that commit does not
commit a new checkpoint just to look busy, so Durable's real restart counter is preserved and a
run that repeatedly crashes can still park where list/inspect can show it. The submit is tagged as
the non-`pi.` entry kind `nanobot.cron` with `jobId`, `scheduledAtMs`, `generation`, and `requestId`
provenance in the origin (or background) transcript.

A model run that ends without answering is detected when the target conversation becomes idle while
the submission is still queued. The queued input is withdrawn, the run records an error, and the
already-armed timer chain continues. This works with Durable's default
`settings.afterFailedRun: "keep"`.

## Cancellation and visibility

`cancel()` increments `generation`, clears both pointers, and aborts both the pending timer and the
active run. Every timer and run commit checks generation and its pointer, so stale work cannot arm a
successor or overwrite the result after cancellation. A settled one-shot returns `already_terminal`.

`cancel()` also withdraws the occurrence's queued submission when its target conversation and
stable request ID are known. The lookup is by `requestId`; `abortSubmission()` reports the race
result. A queued origin input is removed and cannot run after cancellation. An input that was
already placed stays in the origin transcript and may still complete: that is the documented
`already_placed` limitation. Cancellation cannot retract it, only fence future scheduling and
recording.

`list()` and `inspect()` are owner-scoped and derive status from the actual timer and run task
records plus live inspection. The view exposes both task summaries, including faulted, parked,
aborted, and missing states with their errors/reasons. It also exposes the target conversation's
current generation run. If that target generation parks while the cron run is still waiting, the
job view reports it instead of a false-healthy running state. An unhealthy timer dominates the
canonical status over a still-running run. A faulted run is visible while it is the active execution
and is retained in `lastFault` when the timer later replaces its pointer. A parked timer or run is
shown as parked; this slice invents no cron retry policy, so use Durable's normal
`harness.retryTask()` or cancel.

## Schedule math

Supported schedules are `once` (absolute epoch milliseconds) and `every` (fixed interval). An
interval is anchored at creation time, so the grid survives restarts. The first interval slot is
validated as a safe integer before the job is created. The next slot is always strictly after
`max(now, scheduledAtMs)`; a backward clock jump cannot duplicate or move a slot backwards, and
missed slots are skipped rather than replayed. One-shot schedules run once however late. No count,
interval, horizon, lateness, or history cap is added.

## Not included / limitations

- No migration of the parked probe document versions or stores. They are not supported.
- No gateway, channel, config, command/tool surface, calendar expression, time zone/DST, delivery,
  silence, model selection, or misfire policy.
- Background runs are owned by the run task, so cancelling the job aborts that run. In `origin` mode
  an already-placed origin run is not owned by the run task; cancellation still fences both
  pointers and withdraws a still-queued input, but cannot retract an already-placed run.
- Origin-mode runs use the origin conversation's current agent, tool selection, and grants at
  request preparation. Background runs provision a fresh task-owned conversation through the
  trusted `prepare` callback. A host that needs equivalent authorization must recheck current
  grants during that preparation; this slice does not copy or invent grants.
- A non-terminal run task, including a parked one, blocks new work with visible skips until it is
  retried or cancelled.
- A timer fault leaves its pointer in place and stops the chain visibly; an execution fault is
  surfaced and retained in `lastFault` while the timer chain continues.

## Offline verification

Temporary probes (not committed) used fresh `mkdtemp` SQLite stores, a fake Harness clock, and a
faux provider. They covered: timer arming successor+run before the model; a blocked model with the
next timer skipping without touching `lastOutcome`; model failure with the timer chain intact; clock
moving backwards during a run; restart during a run and after execution with the successor already
armed; cancellation before due and during a run; one-shot origin completion; timer and execution
fault visibility; parked target generation visibility; owner scoping; and dedupe. Additional
review probes covered: a queued origin input withdrawn on cancel, the already-placed limitation,
unhealthy-timer status dominance, and overflow rejection before job creation. No live data,
credentials, network, or deployment was used.
