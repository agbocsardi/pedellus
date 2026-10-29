# Cron: deterministic timer plus finite run

This replaces the parked recurring-task foundation. The opt-in `cron` config installs it in the
gateway together with a model-callable `cron` tool (`add`/`list`/`remove`); there is no command
surface. Calendar expressions and IANA time zones are schedule math; parsing user text or ISO
datetimes stays outside. A completed isolated-background result is also queued in a durable,
channel-neutral outbox for an enabled channel; the run itself still writes only its Durable
conversation and sends no external message.

Cron is an internal agent capability: the user asks the agent, and the agent calls the scheduling
tool. No direct user cron UI or scheduling commands are required, and none exist.

Files:

- `src/automation/cron.ts` — job document, timer task, run task, controller API.
- `src/automation/cron-schedule.ts` — one-shot, interval, and calendar schedule math.
- `src/automation/cron-tool.ts` — the model-facing `cron` tool.
- `src/automation/cron-delivery.ts` — channel-neutral durable outbox for completed background results.
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
`harness.retryTask()` or cancel. The view also carries the newest sanitized delivery fault for the
job (`deliveryFault`), so a malformed or full outbox is visible through the model-facing `list`
operation even though the run itself completed.

## Schedule math

Supported request kinds are Python-like `at`, `every`, and `cron`, plus a relative one-shot
`after`:

- `at` is one absolute epoch-millisecond instant. `once` is accepted and normalized to `at` for
  callers written against the first foundation. Stored jobs use `at`, `every`, or `cron`; a stored
  `once` record from an unshipped probe is not migrated. The instant must be in the future when
  the job is created.
- `after` is a one-shot elapsed delay (`afterMs`). It is not an interval and not a date-parsing
  heuristic: it resolves once, in the commit that creates the job, from the controller clock, and
  is stored as the ordinary `at` instant. `createdAtMs` already records that admission, so no
  stored schedule kind or schema is added. The delay, the epoch addition, and the resulting
  representable `Date` are validated before the commit, so a stored deadline cannot fail later
  formatting.
- `every` is an interval anchored at creation. Every later occurrence is `anchorMs + k * everyMs`,
  so the grid survives restarts and a backward clock jump. This differs from Python's
  `now + interval` recomputation, which resets the phase on restart.
- `cron` is a calendar expression evaluated in an IANA time zone. `timeZone` defaults to `UTC`,
  matching the Python tool's default. Fixed UTC offsets such as `+02:00` are rejected.

Scheduling is idempotent on the caller's key. A retried relative request is deduplicated against
the original stored deadline (stored `at` equal to `createdAtMs + afterMs`), so a replay after a
long delay, a reopen, or a fired one-shot never recomputes the deadline from the current clock,
creates a second job, or arms a second timer. An absolute request naming that same stored instant
is the same schedule. A same-key request with a different delay, message, name, or mode is refused
before any mutation.

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

## Channel outbox

The normal terminal commit of a background run carries its settlement and final assistant entry ID
to the host's optional `finalize` callback. When cron is enabled and the origin session belongs to a
channel enabled in the configuration (currently `telegram:` when `telegram` is configured), the
gateway writes one record to the origin conversation's `nanobot.cron.deliveries` document in that
same commit. The record is keyed by `cron:<jobId>:<scheduledAtMs>` and stores the final text, so a
retried terminal commit cannot admit the same occurrence twice. No model turn is rerun for delivery.

The channel adapter owns external-send state in that record: a bounded chunk cursor, a write-ahead
intent, and an ambiguous-outcome quarantine. Delivery authorization uses durable admission
evidence, not the origin session string or a chat-ID/allowlist shortcut: the adapter requires a
binding for the same bot and private chat naming the original authenticated sender, then rechecks
that sender against its live allowlist. A missing/inconsistent binding is a nonterminal `withheld`
hold with no send; a fresh authenticated admission for that private chat restores/refreshes the
binding and returns those records to `pending`, so a cap eviction or an old migrated store does not
permanently lose a result. A binding whose sender is no longer allowed settles `unauthorized` with
no send and is not released by a later admission. An unresolved intent after a crash reopens as
`unknown` and is never auto-resent; an explicit rejection settles `failed`; rate-limit and proven
pre-connect outcomes stay pending for a later scan. This is deliberate
reconciliation-over-retransmission, not an exactly-once claim.

Network writes for one chat are serialized and use the same bot flood gate, and only one scheduled
record per chat is active at a time. That prevents overlapping network sends and scheduled-record
reordering, but it is not a whole-message lock: chunks of a multi-chunk message can interleave with
another same-chat send between chunks.

State version 4 starts an empty admission-binding map when migrating v1/v2 or a controls-only v3
channel state; a v3 state with bindings retains them. Pending replies are preserved. Prior queued cron results are not failed or discarded: they are withheld
until that private chat admits one fresh message, which restores the binding and releases them.
The adapter does not infer a sender binding from a chat ID or an old session string.

The v4 migration accepts v1/v2 and both historical v3 channel-state shapes, preserving controls,
origin bindings and pending replies. Cron outbox records are separate. Downgrading to a reader
predating `withheld` can fail held records; upgrades must be forward-only.

Binding capacity is bounded (1000 origins). Eviction is observable through a sanitized fact record
and warning; an evicted chat's withheld result remains nonterminal and a fresh admission restores
it. Every valid admission refreshes that binding's recency, so active chats are not the first
eviction candidates.

Silence policy: only a successful, non-empty final answer is queued. An empty answer, run error,
cancellation or superseded run sends nothing externally; its actionable status stays in
`lastOutcome` and `list()`; no failure notification is sent. An origin-mode run answers inside the
origin conversation and creates no outbox record, so it is not delivered twice. Telegram origin-mode
delivery remains unsolved: no unsolicited send is attempted, and only a local CLI attached to that
conversation prints the answer. With the channel absent from the configuration, no
record is created at all; an existing record is not redirected to another channel. The bounded
outbox (1000 records per origin, 200 terminal records retained) never evicts pending, withheld or
ambiguous records. A full outbox does not queue the new result and records a durable, sanitized
delivery fault; the run still completes. The same fault path covers a stored outbox whose
`deliveries` value is not an array or whose entries are not understood: a single unrecognized entry
blocks every new admission for that origin until an operator repairs it, because the document is
never partially rewritten. Nothing is overwritten or repaired by guess, and the terminal commit is
not faulted. The reason is visible as `last delivery fault` in the cron `list` view. A malformed
fault document is itself ignored rather than replacing job or outbox data.

## Not included / limitations

- No migration of the parked probe document versions or stores. They are not supported.
- No user-facing channel command surface, model selection, or misfire policy. One run submits one
  agent turn to a Durable conversation (the fresh background conversation, or the origin conversation
  in `origin` mode).
- Delivery is background-only and currently only consumed by the Telegram adapter. An origin-mode
  answer becomes part of the origin transcript, so an attached local CLI prints its committed final
  text once when the run ends (see [the CLI](./CLI.md)); Telegram does not send an unsolicited origin-mode
  turn. Queued origin turns that hand over directly to a successor are attributed per run, so a later
  run neither steals nor suppresses an earlier answer. That is conversation presentation, not a
  delivery layer: there is no retry or exactly-once claim, and a CLI started after the run settled
  does not replay it.
- A pending outbox record has no age limit. A channel enabled later can deliver an older queued
  result once; an ambiguous record stays quarantined until an operator resolves it through the
  adapter's documented channel-state/outbox record.
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
  must apply the same deny-by-default rule. The foundation alone does not copy grant records. The
  copy is recorded together with the origin conversation in the same commit that creates and
  configures the target, and stays capped by that origin's current grants; the foundation's optional
  `finalize` callback lets the host retire the target's authority in every terminal commit of the
  run (normal completion or error, target missing, job record missing, generation change or
  cancellation, and ownership fencing) and in the abort handler; only a phase fault or a crash
  before that commit defers retirement to the next reopen (see below). When the origin has no known
  owner, `prepare` copies nothing and the run stays default-deny.
  When a context snapshot provider is configured, `prepare` also installs the origin's snapshot
  for the target conversation — bootstrap/AGENTS files, memory, the skill summary — and the
  read-only `skill` tool, so a scheduled turn renders the same workspace context as a normal turn.
- A background run's target conversation deliberately has no SessionMap entry, so it cannot become
  a cron owner. After a reopen the Gateway restores that target's snapshot from the non-terminal
  run task's checkpoint before applying conversation policy. At the 256-snapshot cap it evicts the
  oldest idle background target rather than failing the run; a mapped session's snapshot, the cron
  tool and the cron foundation are never added to a background run.
- An `origin`-mode run answers in the origin conversation, so it still holds that conversation's
  `cron` tool and can schedule further jobs. Only a background run's fresh conversation is denied
  cron.
- A background run's copied grants are bounded, not independent. The grant hook requires both the
  copied grant and the origin's current grant for the name, and blocks once **either** expiry
  passes: revoking or expiring at the origin takes effect on the run's next call, including after a
  crash and reopen, and a later origin grant cannot extend the copy. A present-but-malformed origin
  link, a missing origin grant document or an unknown origin owner fails closed. Because Durable's
  tool hooks run only in the call phase, the Gateway also reauthorizes every live run target before
  `resume()`: it intersects the copy with the origin's current grants and clears a copy whose durable
  link, origin owner or origin document is missing or mismatched, so a new admission after a revoke
  is not offered the tool. A committed `execute` intent for a native coding tool is `unsafe` and
  settles as interrupted rather than rerunning. Every terminal commit of a run that already prepared
  a separate target retires that target's copied grants and tools in the same commit, as does the
  abort handler, so a completed, failed, cancelled or superseded run leaves no copy behind for a
  later admission. A phase fault or a crash before the terminal commit still leaves the copy until
  the next reopen, where the pre-resume pass retires it; in that interval a direct host submission
  remains bounded by the origin hook.
  The copy still drives tool selection during the run,
  so it may be offered a tool the origin just revoked; the call itself is blocked. As for any granted
  call, one that already passed the hook and recorded intent can still execute.
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
A later bounded-authority probe drove the same path with a faux provider and covered the origin link
written beside the copied grants, a copied grant usable while the origin still grants it, a missing
origin grant document, revocation after preparation, a shortened origin expiry beating the still
valid copy, and a later longer origin grant that could not extend the copy past its own expiry; it
also confirmed the terminal commit retires the target's copied grants and tools, a finished target
denies a direct host submission, and an invalid origin link fails closed during a live run. One
restart probe SIGKILLed a prepared run whose origin was revoked mid-request: after reopen the
pre-resume pass had already removed the copy and tool from the target, and the resumed admission was
denied. Another SIGKILL probe interrupted a native `bash` call **after** its execute intent committed,
revoked the origin grant while the command was running, and reopened: the call settled as interrupted
without rerunning, the killed command's later effect never appeared, and the target's authority was
already pruned before resume. An origin-mode conversation with no link was unaffected.
A later retirement probe drove the same path with a faux provider and asserted, for each terminal
path of a run whose target was already prepared, that the target's grant document is retired and
that it offers no tools: normal completion (plus a denied direct host submission), a job generation
change, a missing job record and an execution-ownership change while the run was live, cancellation
by the model-issued `remove` tool, and a SIGKILL after preparation whose resumed early return was
fenced by a generation change written through a raw Harness commit before reopen. The same probe
confirmed an origin-mode run leaves its own conversation's grants and tools untouched. A control
build without the new retirements failed exactly the generation, missing-record, ownership and
resume probes while normal completion and the abort handler still passed.

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

Channel-delivery probes (2026-10-29, temporary and uncommitted) drove the real `openGateway` and
`runTelegram` paths with a faux provider and a mocked Telegram transport in fresh `mkdtemp` stores.
They covered: a Telegram-origin scheduling turn, the isolated run's final text written to the
origin outbox and sent once to the originating chat with a stored message ID and chunk cursor; a
delivered record not resent after full gateway/store reopen; an unresolved persisted send intent
reopening as `unknown` with no outbound request and no model call; a mapped origin removed from the
live allowlist settling `unauthorized` with no send; a mapped origin with no durable admission
binding entering nonterminal `withheld` with no send; two same-chat records sent in order with no
overlapping external calls; and a gateway opened without the channel writing no outbox record for a
completed background run. State probes covered a 1000-binding cap: the next admission evicted the
oldest binding, recorded an observable sanitized eviction fault, left that origin's result
`withheld`, and a fresh authenticated admission restored the binding, released the result and sent
it once to the origin chat. A stored version-2 channel state migrated with an empty binding
map; a prior queued result became `withheld` without a fault flood, then a fresh admission restored
its binding and delivered it once. A live-revoked sender stayed terminal `unauthorized`; an
ambiguous send reopened as `unknown` and was never resent. Corruption probes covered a stored outbox
whose `deliveries` value was not an array: the recurring
scheduled run still committed its terminal outcome, left the stored value untouched, and recorded a
sanitized durable delivery fault visible in the job list; a malformed pending record was settled
`failed` without an external send; a malformed record without a usable ID was surfaced in the fault
document; and a reopened gateway repeated none of them as a faulting loop. A full all-pending outbox
returned `full`, retained every pending record and recorded a deduped overflow fault. No permanent
test, live bot, credential or network request was involved.

Relative-reminder probes (temporary and uncommitted) drove the real foundation with a fake clock,
and the real `openGateway` path with a faux provider. They covered: `after` resolving once to the
admission instant plus the delay and storing the ordinary `at` form; rejection of zero, negative,
fractional, `NaN`, unsafe and epoch/Date-overflow delays plus mixed schedule fields before any job
exists; a replayed request deduping the original deadline after the deadline passed, after a
backwards clock jump, and after reopen; a fired one-shot remaining one job with no second timer and
the replay still deduping its original instant; a same-key different delay refused with the record
unchanged; equivalent absolute `at` deduping the same instant; unchanged `at`/`every`/`cron`
semantics; and a model-issued `cron add` with `after_seconds` reporting the stored next instant.
No permanent test, live provider, credential or workspace was involved.
