# Cron: deterministic timer plus finite run

This replaces the parked recurring-task foundation. The opt-in `cron` config installs it in the
gateway together with a model-callable `cron` tool (`add`/`list`/`remove`); there is no channel
delivery, silence policy, or command surface. Calendar expressions and IANA time zones are schedule
math; parsing user text or ISO datetimes stays outside. Nothing here sends a message outside the
Durable conversation it submits to.

Cron is an internal agent capability: the user asks the agent, and the agent calls the scheduling
tool. No direct user cron UI or scheduling commands are required, and none exist.

Files:

- `src/automation/cron.ts` — job document, timer task, run task, controller API.
- `src/automation/cron-schedule.ts` — one-shot, interval, and calendar schedule math.
- `src/automation/cron-tool.ts` — the model-facing `cron` tool.
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
configure context and tool authorization. Durable initializes a task-owned conversation from
the origin's agent, including its selected tools and extensions; this slice does not itself copy
grant records. The host must apply its own deny-by-default policy and recheck authorization, not
assume the new conversation has no capabilities. The callback must be durable and idempotent
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

Supported request kinds are Python-like `at`, `every`, and `cron`:

- `at` is one absolute epoch-millisecond instant. `once` is accepted and normalized to `at` for
  callers written against the first foundation. Stored jobs use `at`, `every`, or `cron`; a stored
  `once` record from an unshipped probe is not migrated. The instant must be in the future when
  the job is created.
- `every` is an interval anchored at creation. Every later occurrence is `anchorMs + k * everyMs`,
  so the grid survives restarts and a backward clock jump. This differs from Python's
  `now + interval` recomputation, which resets the phase on restart.
- `cron` is a calendar expression evaluated in an IANA time zone. `timeZone` defaults to `UTC`,
  matching the Python tool's default. Fixed UTC offsets such as `+02:00` are rejected.

Calendar parsing and recurrence use `croner` 10.0.1. Expressions may have 5, 6, or 7 fields:
`minute hour day-of-month month day-of-week`, with optional leading `second` and trailing `year`.
This is croner's field order, not croniter's: a croniter six-field expression puts seconds last,
while a croner six-field expression puts seconds first. Croner also accepts nicknames (`@daily`,
`@hourly`, ...), `L`, `W`, `#`, `?`, and the `+` AND modifier for day-of-week, and defaults to OR
logic between day-of-month and day-of-week like croniter.

The next slot is always strictly after `max(now, scheduledAtMs)`; missed slots are skipped, not
replayed or coalesced. A backward clock jump cannot duplicate or move a slot backwards. No job
count, interval, lateness, horizon, or history cap is added.

Time-zone behavior is verified against IANA data and documented honestly:

- **Gap (spring forward):** a nonexistent wall time is skipped to the next matching wall-clock
  time. For example, `30 2 * * *` in `America/New_York` on 2026-03-08 fires at 03:30 EDT
  (`07:30Z`). Croniter instead normalizes a gap time to the transition instant, 03:00 EDT.
- **Fold (fall back):** for one-hour folds such as `America/New_York` and `Europe/Berlin`,
  croner runs the first occurrence once. If a reference falls in the second repeated hour, a
  bounded one-minute reference advance finds the first matching slot at or after the fold ends
  instead of returning a past instant. Croniter runs both repeated occurrences. In sub-hour
  folds such as `Australia/Lord_Howe` (30 minutes) and two-hour folds such as
  `Antarctica/Troll`, croner resolves an ambiguous wall time to the later offset, so the earlier
  repeated interval is skipped. The later occurrence may run, or be skipped to the next day when
  the reference already passed that wall time; the result is always strictly after the reference.
- Out-of-range croner dates, including references beyond JavaScript's supported date range, are
  wrapped as `CronScheduleError` rather than leaking croner's raw `TypeError`.
- The `at` and `every` kinds have no time zone of their own; `at` is already absolute and `every`
  is a fixed elapsed interval.

Invalid expressions, unknown/non-IANA zones, and expressions with no future occurrence are
rejected before a job record or timer task is created. Validation errors can include croner's own
internal text (for example `CronPattern` or `CronDate` messages) because that text is surfaced
rather than rewritten. Stored values are safe integers; a next occurrence that would exceed the
safe-integer range fails visibly instead of wrapping. Croner's own parser supports years 1-9999
and bounds its search near year 3000/9999; that is a library limit, not an added product cap.

## Not included / limitations

- No migration of the parked probe document versions or stores. They are not supported.
- No user channel/outbound delivery, silence policy, model selection, or misfire policy. A run
  submits one agent turn to a Durable conversation (the fresh background conversation, or the
  origin conversation in `origin` mode); nothing is sent to Telegram, Discord, email, or another
  channel.
- The `cron` tool parses only ISO 8601 timestamps with an explicit UTC offset for `at`; parsing
  natural-language user text stays outside.
- Background runs are owned by the run task, so cancelling the job aborts that run. In `origin` mode
  an already-placed origin run is not owned by the run task; cancellation still fences both
  pointers and withdraws a still-queued input, but cannot retract an already-placed run.
- Origin-mode runs use the origin conversation's current agent, tool selection, and grants at
  request preparation. Background runs provision a fresh task-owned conversation through the
  trusted `prepare` callback, but inherit the origin's agent selection before preparation. The
  Gateway's `prepare` copies the origin's still-valid coding-tool grants and offers exactly those
  tools, so a **background** run cannot schedule another job or widen authority; a different host
  must apply the same deny-by-default rule. The foundation alone does not copy grant records.
- An `origin`-mode run answers in the origin conversation, so it still holds that conversation's
  `cron` tool and can schedule further jobs. Only a background run's fresh conversation is denied
  cron.
- A background run's copied grants are a snapshot: revoking or expiring the origin grant after the
  run is prepared does not remove the copy, which stays valid until its own expiry. The grant hook
  still rechecks the copy and the host ceiling at call time.
- Disabling cron (`cron.enabled: false`) on a store that has jobs is not a cleanup operation. Job
  documents and grants remain, and their persisted timer/run tasks have no installed task
  definition, so they stay blocked until cron is enabled again.
- A non-terminal run task, including a parked one, blocks new work with visible skips until it is
  retried or cancelled. Cancellation may remain pending if an owned model request ignores abort.
- In origin mode, the displayed target generation may belong to another input while the cron input
  is queued; it describes conversation health, not necessarily that occurrence.
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
unhealthy-timer status dominance, and overflow rejection before job creation. A later gateway probe
drove the real `openGateway` path with a faux provider and covered the config gate, model-issued
`add`, isolated and origin runs, copied grants, `list`/`remove`/terminal/unknown IDs, invalid
schedules, restart with a pending one-shot, and a background run that is offered no `cron` tool.

Calendar probes covered `at`/`every`/`cron` parsing, the `once` alias, UTC default, invalid zones
and offsets, invalid expressions, no-future-occurrence rejection, strict advancement after an exact
slot, backward/forward clock jumps, and safe-integer overflow. A fake-clock Harness probe confirmed
a calendar timer commits the next occurrence before a blocked model answers, plus the
`America/New_York` spring gap and fall fold. A stress probe walked calendar occurrences across
`America/New_York`, `Europe/Berlin`, `Australia/Lord_Howe`, `Antarctica/Troll`, and
`Pacific/Chatham`, asserting every next instant was strictly later and monotonic. Differential
probes covered leap-day and `W`/`LW` month-list expressions where croner's backward search can
fail; previous-occurrence recovery is optional and falls back to the forward result. Edge probes
covered 1-hour, 30-minute, and 2-hour folds, the 1969 `America/New_York` fold, and
huge/out-of-range references, including wrapped `CronScheduleError` failures. No live data,
credentials, network, or deployment was used.
