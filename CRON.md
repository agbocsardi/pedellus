# Cron replacement: finite occurrence tasks

This replaces the parked recurring-task foundation. It is **not wired** into the gateway,
channels, config, tools, delivery, or a calendar parser. Nothing here sends a message outside
the Durable conversation it submits to.

Files:

- `src/automation/cron.ts` — job document, occurrence task, controller API.
- `src/automation/cron-schedule.ts` — one-shot and interval schedule math.
- This document.

## Shape

One job is one record in the origin conversation's `nanobot.cron.jobs` document:

```ts
{ id, owner, name, message, mode, schedule, idempotencyKey, createdAtMs,
  activeTaskId, cancelledAtMs, lastOutcome }
```

`activeTaskId` is the only live pointer. There is no stored `nextAtMs`, no occurrence array, and
no `scheduled/running/completed` job state machine. History lives in immutable task records and
conversation entries, not in the job document.

Each occurrence is a separate finite Durable task with immutable input:

```ts
{ jobId, scheduledAtMs }
```

Its phases are exactly:

1. `wait` — sleep until `scheduledAtMs` (or continue at once if already due).
2. `execute` — choose the target conversation, run host preparation, submit the native agent
   input, wait for it, then commit the terminal outcome.

A recurring job never loops from `plan` back to `plan`. `execute` ends the task. Its final commit
atomically records `lastOutcome`, creates the next occurrence task, and moves `activeTaskId` to it.
A one-shot clears `activeTaskId` and ends. There is no successor path for a cancelled job.
A settled one-shot is reported as `completed` even when its `lastOutcome.status` is `error`;
consumers must read the outcome rather than treating the lifecycle label as success.

## Native run and crash recovery

`execute` submits one native input with the stable request ID
`cron:<jobId>:<scheduledAtMs>`. Durable's `submissionByRequest` behavior makes a retry after a
crash return the same submission, so the restart waits on the existing run instead of admitting a
second one. The occurrence task's checkpoint stores the chosen target conversation, so a crash
after that commit does not recreate it or rerun host preparation.

`mode: "background"` (default) creates a fresh task-owned conversation, inheriting the origin
conversation's agent. `mode: "origin"` submits into the origin conversation itself.

`createCronFoundation({ prepare })` accepts one optional host callback. It receives the origin and
target conversation IDs, the job, and the occurrence. It runs inside the commit that chooses the
target conversation, so its writes and the target choice are atomic. It is the only place to add
context or tool grants; without it this slice adds none. It must be durable and idempotent because
a crash before that commit reruns it.

A model run that ends without answering is detected when the target conversation becomes idle while
the submission is still queued. The occurrence records that as an error and the recurring schedule
continues, rather than waiting forever. This works with Durable's default
`settings.afterFailedRun: "keep"`.

## Cancellation and visibility

`cancel()` commits `cancelledAtMs` and clears `activeTaskId` before aborting the live task. That is
the fence: a finish commit that lands afterwards sees no matching active pointer and cannot create
a successor. If a finish already created one, cancellation sees and aborts the successor.

`list()` and `inspect()` are owner-scoped and derive status from the actual task record and live
inspection, never from a copied job state. A faulted, failed, aborted, parked, sleeping, or missing
occurrence task is visible on the job view, including its error or blocked reason. A parked task is
retried with Durable's normal `harness.retryTask()`; this slice invents no cron retry policy.

## Schedule math

Supported schedules are `once` (absolute epoch milliseconds) and `every` (fixed interval). An
interval is anchored at creation time, so the grid survives restarts. The next slot is always
strictly after `max(now, scheduledAtMs)`; a backward clock jump cannot duplicate or move a slot
backwards, and missed slots are skipped rather than replayed. One-shot schedules run once however
late. No count, interval, horizon, lateness, or history cap is added.

## Not included / limitations

- No migration of the parked probe document versions or stores. They are not supported.
- No gateway, channel, config, command/tool surface, calendar expression, time zone/DST, delivery,
  silence, model selection, or misfire policy.
- Background occurrence work is owned by its occurrence task, so cancelling the job aborts that
  run. In `origin` mode an already-admitted origin run is not owned by the occurrence task;
  cancellation still fences the successor but cannot retract that run from the origin transcript.
- A task fault does not auto-cancel or replace itself. The active pointer remains, the job view
  shows the fault, and an operator must cancel or retry through the normal task APIs.
- A native task parked at Durable's restart limit is shown as parked; it does not advance until
  retried.

## Offline verification

Temporary probes (not committed) used fresh `mkdtemp` SQLite stores, a fake Harness clock, and a
faux provider. They covered: recurring successor creation; one-shot completion; origin and
background modes; schedule dedupe and owner isolation; clock moving backwards during a run;
finish followed by restart; a crash after submission with reattachment and one transcript;
model and preparation failures; faulted-task display; cancellation before and during a run; and
successor continuation after a restart. No live data, credentials, network, or deployment was used.
