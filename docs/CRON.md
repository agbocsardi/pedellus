# Cron: deterministic timer plus finite run

This replaces the parked recurring-task foundation. The opt-in `cron` config installs it in the
gateway together with a model-callable `cron` tool (`add`/`list`/`remove`); there is no command
surface. Calendar expressions and IANA time zones are schedule math; parsing user text or ISO
datetimes stays outside. A normal settlement, isolated or origin, is also queued in a
durable, channel-neutral outbox for an enabled channel: the committed answer text for a success, or
fixed sanitized notice text for a failure or empty answer; the run itself still writes only its
Durable conversation and sends no external message. Only a job's persistent `silent` setting
suppresses that occurrence's automatic delivery: a scheduled run is never offered a way to withhold
its own message, so a reminder cannot be lost by the model's choice. A failure is still queued as its
fixed notice, and a successful run that produced no usable text (an empty answer, or only the
retired `[SILENT]` marker) queues the fixed empty-result notice instead of vanishing.

Cron is an internal agent capability: the user asks the agent, and the agent calls the scheduling
tool. No direct user cron UI or scheduling commands are required, and none exist.

Files:

- `src/automation/cron.ts` — job document, timer task, run task, controller API.
- `src/automation/cron-conversations.ts` — persistent automation conversations: the per-conversation
  class marker, lazy creation/reuse, and the durable catch-all one-off queue.
- `src/automation/cron-schedule.ts` — one-shot, interval, and calendar schedule math.
- `src/automation/cron-tool.ts` — the model-facing `cron` tool.
- `src/automation/cron-delivery.ts` — channel-neutral durable outbox for settled run results and
  fixed sanitized failure/empty-result notices.
- This document.

## Why two tasks

A single task that both waited for the next slot and ran the model made recurrence depend on the
model completing. The replacement splits that in two:

- **Timer task** (`nanobot.cron.timer`) sleeps until one slot, then commits its successor and
  durable execution work in one transaction. It never calls a model and then terminates.
- **Run task** (`nanobot.cron.run`) submits/reattaches one native agent input, records the result,
  and terminates. It never computes or creates a schedule.

Both tasks are conversation-owned and `background: true` in the origin conversation. The run task's
*target* is an automation conversation (below), or the origin conversation itself in `origin` mode.

## Conversation model

Conversation and execution are separate things: a conversation is ongoing activity, an episode is
one execution. Scheduled work follows that split.

- **Recurring jobs** (`every`, `cron`) keep **one automation conversation per job** for as long as
  the job exists. Every run adds one episode to it.
- **One-off jobs** (`at`, including a relative `after`) share **one catch-all automation
  conversation per origin chat**, and each occurrence contributes its own episode there. One-off
  jobs never get a conversation each, so an origin chat's automation state does not grow with the
  number of one-off reminders it ever scheduled.
- Every run starts with a **native reset boundary** before its own input. Durable keeps the earlier
  entries: they stay in the transcript and in episode/history indexing, but they are not part of
  the new run's model context. Nothing is trimmed, rewritten or deleted, and no summary is invented
  to stand in for the previous episode.
- **Runs sharing a conversation execute serially.** Recurring jobs keep the timer's existing
  overlap-skipping policy; catch-all one-off runs queue (below) and never interleave or batch their
  episodes.
- **Execution stays a task, not a conversation.** The run task owns one execution and its
  cancellation aborts that work without deleting the conversation or its history.
- **Authority and workspace context are prepared per run and retired when it ends.** Persistent
  history never carries persistent permission: a job whose captured tools were narrowed by
  configuration has none on its next run, and a run whose conversation an earlier run already used
  renders the workspace as it is now, not as that earlier run found it.
- **`origin` mode is unchanged**: the occurrence runs directly in the origin chat conversation, in
  one conversation with no catch-all, no new conversation and no cron-placed reset boundary. The
  owner's own `/new` is that conversation's reset.

### An app side thread schedules into Main

An app (PWA) chat is one mapped ordinary chat per thread: `app:chat` is Main, and every side thread
is its own chat under `app:chat:<threadId>`. Both are authenticated mapped ordinary chats under the
same chat policy, so both are legitimate origins. The `cron` tool nonetheless places a side thread's
job in **Main**: side threads are short-lived (the idle scan archives them), and scheduled work
belongs in the chat that outlives them.

The redirect is one hop in the tool's own origin resolution (`CronToolOptions.originFor`), and
nowhere else:

- It applies only when the calling conversation is an authenticated mapped chat whose exact host key
  is an app side-thread key. The root, a denied fork, a raw or state conversation, a task-owned
  conversation and an automation conversation never redirect; they are never offered the tool at
  all, because it is selected only for a mapped chat that already has a cron owner.
- The target is this app channel's Main conversation (`app:chat`), resolved through the gateway's
  ordinary mapped-chat admission, and only when it is a different conversation whose owner key is
  exactly `app:chat`. If Main cannot be resolved that way, the call is refused with one short fixed
  message and nothing is scheduled anywhere. A stored map that points Main at this same side thread
  is refused by that admission *before* it registers anything, because a mapped conversation is
  admitted under one host key and an alias is rejected: the refusal is therefore repeatable instead
  of leaving the side thread registered as Main, and every other mis-mapping is still caught by the
  same admission checks the channel uses.
- The dedupe identity of an `add` is per-direction. A conversation whose jobs are not redirected
  keeps exactly the key it always had, the provider's tool-call ID (`tool:<provider call ID>`), so an
  `add` committed by an earlier build still dedupes against its own replay after an upgrade. A
  redirected `add` instead uses the host's own tool-task identity in a separate namespace
  (`side:<task id>`), which can never collide with a historical `tool:` key even when a provider ID
  is numeric. The separate namespace matters because a redirect puts several threads' jobs in Main's
  one document: two side threads can reuse one provider ID, and it would merge two unrelated requests
  (or silently return the first job's receipt for the second). A replayed execution of the same tool
  task keeps the same task ID, so a commit retried after a crash still dedupes.
- From there the job is Main's in every respect: its document, its `owner` record (`app:chat`), its
  timer and run tasks, its automation conversation's origin, its origin-mode target and its delivery
  session key. Archiving or evicting the side thread touches none of it.
- `list` and `remove` resolve the same redirected origin, so from a side thread they address Main's
  jobs. `list` therefore reports Main's jobs, or `No scheduled jobs in Main.`
- The receipt names the redirect (`Scheduled in Main.`), so the model can tell the owner where the
  job went.

Captured authority cannot widen. `captureFor("scheduledRun", origin)` is the configured
`toolAllowlist` plus the origin's read-only recall and its live MCP tools, and it depends only on the
origin being an authenticated mapped chat, the global allowlist and the live MCP set — never on which
chat the origin is. Main and a side thread are both app chats, so Main's capture set is exactly the
set the creating side thread would have captured, and the run is re-authorized against the same
ceiling on every call. If chat policy ever became key-dependent, that equality would end and a run
would have to capture the intersection with the creating thread; today there is no such input.

Known consequences, all deliberate and documented in APP.md:

- The app channel still requires its own durable admission evidence per thread. A job created in a
  side thread before Main was ever used holds its result in the outbox — never appended, never
  dropped — until the owner sends one authenticated message in Main.
- Job documents that earlier builds wrote inside side threads are **not migrated**. They keep their
  own document, timer, automation conversation, delivery target and owner for the rest of their
  life, and no rebuild re-homes them. The redirect changes only a new `cron add`; and because `list`
  and `remove` now address Main, such a legacy job is no longer visible to the tool from its own
  thread (its thread's app task sheet still lists it, and its results still arrive there).
  `pedellus cron cancel <jobId>` (which searches every mapped chat) still cancels it.
- An `add` the old build committed in a side thread without committing its tool result is not
  duplicated on replay. A redirected `add` first looks for that key in the caller's own job document,
  under the key the old build used (`tool:<provider call ID>`). A key match alone proves nothing, so
  the found job is reported only when it is exactly the job this call would store — the same
  message, name, mode, intent, delivery setting and schedule, compared after the same normalization
  admission applies. That report names the fact that the job stays in that conversation. When the key
  exists but the job differs, the call gets one fixed, value-free answer instead — an earlier job
  with this call already exists in this conversation and nothing new was scheduled — which claims
  nothing about the requested job. Either way nothing is migrated and no second job is written
  anywhere.
- When a redirected call cannot be verified or completed, the model gets one fixed answer and never
  the exception's text: `Could not verify or schedule this job. Check Main's cron list before
  retrying.` That covers a Main resolution that fails, a read of the caller's own job document that
  fails (a replay may already have committed the job, so it must not be answered "nothing was
  scheduled"), and any unexpected failure writing Main's job document. Only the explicit
  request-validation errors the foundation itself raises (a malformed or past schedule, a bad field)
  stay actionable; `list` answers `Could not read scheduled jobs in Main. Nothing was changed.`, and
  a `remove` that failed gives `Could not remove scheduled job <id>. Check Main's cron list before
  retrying.` A conversation whose jobs are not redirected is unchanged: it still gets the
  foundation's own error text, as it always did.

Automation conversations are a distinct conversation class, not chats: they are ownerless so they
outlive every run task, they carry a `nanobot.cron.conversation` marker naming their class, origin
and job, and the origin's own job document records the same ID. They never become chat sessions,
never appear in the session map, never receive foreground chat, channel, worker, MCP management,
Code Mode, classifier, scheduling or digest authority, and never appear to the read-only `history`
tool as a readable chat source. A live run's target holds exactly its own prepared capture (its
configured coding tools plus that origin's read-only recall and exact MCP tools), which is retired
with the run; the conversation between runs holds nothing. A mapped session key naming anything that
is not an ordinary chat conversation is refused when the channel resolves it, before it can become a
cron owner or receive chat policy, so a forged or stale map entry cannot reach either path. The
shared history scope rule classifies them explicitly (`automation`) rather
than relying on them being absent from the session map.

Opening a store reads the session map once and restores that class *before* any mapped key is
admitted as a chat, so a mapping forged, imported or left behind by an older layout is refused by
the process that first reads it, not only by a process that watched the conversation being created.
The conversation's own marker decides, and it names its own class, origin and job, so every mapped
conversation is classified whether or not its origin's job document still records it; that covers a
conversation whose pointer was lost to a damaged write, a hand-edited document or a store restored
from an inconsistent layout. Committed cron documents are still read, but only as an index of
candidate IDs: a live run's target is ownerless and unmapped, so nothing else names it for the
reopen's run-target scan. A document never decides a class, so a damaged pointer can at most fail to
enumerate a conversation, never promote a chat or hide an automation conversation a key names. The
restore decides adoption with the same rule a run applies to a recorded pointer (the conversation is
still ownerless and unforked, and its marker names another conversation as its origin), so a store
this host wrote never loses an ordinary chat to it: this host only ever writes that marker on an
automation conversation. A marker written onto a chat by hand is the other case — it buys denial of
that chat's surfaces and of store-wide history search, never authority, and it clears when the marker
is removed. The authority pass cannot veto the classification of the mapping it has to refuse.

The same open pass installs a mapped session only for a conversation the shared scope rule still
calls chat. A key naming the root, a task-owned conversation or a fork gains no cron owner, no
context-snapshot slot and no resume target, matching the channel ingress refusal for that key, and a
forked ID leaves the mapped-session set so its snapshot stays evictable. A missing conversation keeps
its explicit startup failure. Three known gaps remain. This class restore belongs to the cron-enabled
open path: with `cron.enabled` false it does not run, so a stale key naming an automation conversation
in a store whose cron was since disabled would be admitted as chat. A hand-edited marker on an
ordinary chat takes that chat out of chat scope and makes store-wide history search fail until the
marker is removed: denial only, and only for a store someone already edited. And a `:channel-state` key is a
mapped session and a cron owner by design even though no chat turn runs in it, so the cron tool it is
offered is never exercised from there.

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

## Job and conversation documents

One record per job in the origin conversation's `nanobot.cron.jobs` document, fixed size:

```ts
{ id, owner, name, message, mode, schedule, idempotencyKey, createdAtMs,
  generation, timerTaskId, executionTaskId, cancelledAtMs,
  lastOutcome, lastSkip, lastFault, intent?, silent?, conversationId? }
```

`intent` is `"message"` (also the meaning of an absent field on a historical
record) or `"digest"`. It is set only by an explicit `cron add` with
`intent: "digest"`.

`silent` is a persistent per-job delivery setting, absent on a historical record and then meaning
`false`. When true, every successful occurrence suppresses its automatic channel delivery,
including an empty answer; a failed occurrence still queues its fixed sanitized notice. It is set
to true by an explicit `cron add` with `silent: true` and is shown as `delivery: silent` in `cron
list` and in the add confirmation. A new job stores the normalized boolean, including `false`. It
has no effect on a `digest` occurrence, which never queues a channel delivery either way.

`conversationId` is the recurring job's own automation conversation. It is optional and absent
until that job's first run records it, so a job document written by the earlier per-occurrence
model keeps working. Reuse is never inferred from the pointer alone: the recorded conversation is
adopted only when its own `nanobot.cron.conversation` marker names this origin, this class and this
job. A recorded ID whose conversation is gone, unmarked, or marked for something else, or that
names the origin chat, a mapped session, the root, a task-owned conversation or a fork, is not an
error: the next run creates a fresh automation conversation and rewrites the field. A damaged
pointer therefore costs one new conversation instead of pulling a chat into the automation class,
and it never rewrites a marker on the conversation it named. Nothing is migrated, version-bumped or
dropped, and the same rule covers the two document-level fields below (also optional):

```ts
{ jobs: [...], oneOffConversationId?, oneOffQueue? }
```

`oneOffConversationId` is the catch-all automation conversation this origin's one-off jobs share.
`oneOffQueue` is its durable FIFO of *admitted but unfinished* one-off runs, in admission order:

```ts
[{ jobId, scheduledAtMs, taskId }]   // bounded by CRON_ONE_OFF_QUEUE_LIMIT (16)
```

`taskId` is the queued run task, which is also its waiter. An entry leaves the queue in the same
commit as its run's terminal outcome or cancellation, and in the claim commit that fences an
admitted run out (a job cancelled while the gateway was down, for example), so a stale claim cannot
leave its entry behind. The claim phase also drops entries whose task record is already terminal
before it decides who is next, so a crash cannot leave a dead entry at the head. The bound is a
count of admitted runs, not of time or of jobs ever created. The capacity check runs before any
catch-all conversation is created or recorded. When the bound is reached, the new occurrence is
refused: `lastOutcome` records `status: "error"` with the fixed text
`one-off run queue is full (16 admitted runs); this occurrence was not run`, the conversation is not
touched, and no channel notice is invented. `cron list` shows that text as the job's last run.
An unreadable queue is refused the same way, with the fixed text
`one-off run queue is malformed; this occurrence was not run`: the stored value is neither guessed at
nor rewritten, and the run task settles instead of faulting and blocking the job behind it. The
refusal repeats for each occurrence until an operator repairs the document.

Each automation conversation also carries its own class marker, one small document:

```ts
{ conversationClass: "recurring" | "one-off", originConversationId, jobId: string | null }
```

It is written in the same commit that creates or reuses the conversation, and again by every run's
host preparation. A reopen classifies a conversation only when this marker still names the origin
and job that the job document records, and only while the conversation is still ownerless and
unforked — the same predicate a run applies to the pointer it is about to reuse.

`timerTaskId` is the only timer allowed to arm the next slot. `executionTaskId` is the newest run
task and drives overlap checks. `lastOutcome` is the newest run result; `lastSkip` is the newest
busy skip; `lastFault` retains the newest execution fault after a timer replaces its pointer.
There is no stored `nextAtMs`, no occurrence array, and no job lifecycle state machine. Full
history stays in timer/run task records and conversation entries, under Durable's normal retention.

## Digest intent

A `digest` job is an ordinary job record and uses the same timer/run tasks. What
differs is only the run phase:

- The occurrence is normalized to `mode: origin` when it is created, so the run
  uses the origin chat conversation as its target and creates no task-owned
  conversation, capture or snapshot.
- It never submits the job message. Instead it calls the host's memory-digestion
  entry with `running.conversationId` (the authenticated origin conversation);
  the host calls the same native `start` a manual `/digest` uses. `start`
  re-checks that the origin is still a mapped chat and re-reads the current
  curation allowlist, so a narrowed configuration refuses instead of widening.
- It queues no delivery in the channel outbox. Only a failed or cancelled digest
  run's bounded internal issue report reaches the origin agent; a successful run,
  including a successful no-op, is silent and starts no origin-agent turn. Its
  outcome stays visible in `/digest status`. Existing scheduled-message delivery
  and its dedupe/unknown-send behavior are unchanged.
- `lastOutcome` records the bounded host settlement (`ok` when a run started, one
  was already live or nothing was pending; `error` with fixed text for a refusal,
  a full undelivered-notice queue or a missing host entry), so `cron list` shows
  the outcome without a channel message. A crash after `start` but before the
  occurrence's terminal commit is replayed on reopen and can process one extra
  bounded batch before that occurrence finishes; this is not claimed to be one
  batch per occurrence in that crash window.
- The timer still arms the next occurrence in its own commit. The digest run is
  a separate background native task and does not affect that reschedule.
  Cancelling the job fences its occurrence and later ones; an already-started
  digest task is cancelled with the native task controls, not by the job.

An `intent: "digest"` add is refused unless the calling conversation is an
authenticated mapped chat with `read`, `write` and `edit` currently configured
and `digest.preset` or `digest.model` names an explicit background model.
No configuration parse and no startup pass creates a digest job.

### Inactive 8-hour schedule shape

The ready-made background cadence is one ordinary job every eight hours, added
explicitly by the owner (for example through the `cron` tool with
`{ schedule: { kind: "interval", every: "8h" }, intent: "digest" }`). Nothing in
this repository creates or enables it: an install ships no such job, and parsing
configuration or opening the gateway never arms one. Each occurrence starts at
most one bounded run through the same `start` a manual `/digest` uses, and the
run's own outcome is visible in `/digest status` rather than in a channel
message. A digest job delays and never accelerates the cadence of ordinary
scheduled messages.

## Native run and recovery

Each run task has two phases. `claim` resolves the run's automation conversation (or the origin, in
`origin` mode), records its place in the catch-all queue, and prepares this run's workspace context
and captured authority — all in one commit. `execute` fences the job again, places the native reset
boundary and the occurrence input, waits for the answer, and records the result.

A run that has to wait behind another one-off run commits only its waiting state (`waiting` on the
queue entry ahead of it) and holds no invocation, no prepared authority and no context while it is
queued. It also creates and records no catch-all conversation: a waiting run needs no target yet, and
it re-reads the origin's document when it wakes, so a queued occurrence can never split or overwrite
the one-catch-all-per-origin record. When that task becomes terminal, the wait resolves and the
queued run claims again; the document's order decides who is next, so the order survives a restart
and is never decided in memory. A one-off run's timer is already terminal, so nothing about the
queue is a schedule.

`execute` places one native reset (`Conversation.reset`, the same entry `/new` commits) in a
background run's conversation, then submits one native input with the stable request ID
`cron:<jobId>:<scheduledAtMs>`. Its content is the job's own message, verbatim: the host appends no
delivery instruction, because whether the occurrence is sent is the job's `silent` setting and not a
decision of the run. That committed text is what the model receives in either mode and what the
transcript keeps, not a separate hidden prompt, and it grants nothing. A job created before this
contract keeps its stored message; only new occurrences omit the old marker paragraph, and an
already-placed occurrence keeps its original input. A final answer consisting only of the retired
`[SILENT]` marker is never delivered literally: it counts as an unusable answer and queues the fixed
empty-result notice. Other text containing the marker is delivered normally. Origin-mode inputs can
share a settled answer, so a batched answer can describe more than one scheduled occurrence.
Both are ordered admissions on that conversation, so the boundary is
always ahead of the input even when the conversation was still finishing. A retry after a crash
first looks for its own submission and then at the conversation's newest placed entry: an occurrence
that is already placed is waited on instead of being submitted twice, and a conversation whose newest
*placed* entry is already a reset has its boundary in place, so the retry adds no second `pi.reset`
and closes no empty episode. That check reads the boundary itself, which is durable, rather than
separate state that could disagree with it. `Conversation.reset` is an ordered write submission too,
so a conversation that is still busy can have its newest *placed* entry be something other than that
reset and admit a second one; that is harmless — the later boundary still precedes the retry's input
and the empty episode between the two is omitted — but it is not prevented. Durable's
`submissionByRequest` behavior makes the submit itself idempotent. There is no waiting task on a
submission ID; the execute phase waits directly.

`createCronFoundation({ prepare, finalize, reset })` exposes the host seams. `prepare` receives the
transaction, the origin and target conversation IDs, the job, and the occurrence. It runs inside the
claim commit, so its writes, the conversation choice and the queue entry are atomic, and it runs
once per run — including a run whose conversation is the same one the previous run used. For a
background run it is where the gateway rebuilds the origin's bounded workspace context and records
the run's coding-tool capture; a later episode therefore renders the current bootstrap files,
memory, skills and skill table instead of the ones the first run of this process read. An
automation conversation is ownerless, so Durable copies no agent state into it: the host also
prepares the model, thinking level and workspace the run executes with. A reopen therefore
re-authorizes a live run's capture against the current ceiling and origin before resuming;
anything else is denied. `reset` is the host's native reset entry, called only for a background run
that has no placed submission and whose conversation does not already end at a reset entry.
`finalize` runs in the terminal commit and retires the target's captured authority. Every callback
must be durable and idempotent because a crash before its commit reruns it.

Returning nothing from the claim callback leaves the run task's state unchanged but still commits
the staged document writes. A `prepare` that throws after those writes therefore keeps the
conversation, its marker, the job's or the origin's recorded ID and the queue entry (the run then
settles as an error with nothing prepared to retire); only a crash before the commit itself loses
them.

The run stores its target choice and phase in its checkpoint. A resume after the claim does not
commit a new checkpoint just to look busy, so Durable's real restart counter is preserved and a run
that repeatedly crashes can still park where list/inspect can show it. A stored run task from the
per-occurrence model migrates to `execute` at its already-chosen target, so an in-flight occurrence
still finishes where it prepared. The submit is tagged as the non-`pi.` entry kind `nanobot.cron`
with `jobId`, `scheduledAtMs`, `generation`, and `requestId` provenance in the origin (or
automation) transcript.

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

A cancelled run also leaves the catch-all queue in its own terminal commit, so a queued occurrence
that will never execute cannot hold the queue in front of a later one. A run whose job was cancelled
while the gateway was down re-claims on reopen, is fenced out there, and removes its own queue entry
in that same claim commit. When the cancelled run owned a background conversation, the abort handler
first stops that conversation's live work through Durable's own conversation abort — before the
terminal commit, so a later abort can never withdraw the next run's own queued input. That abort is
bounded (5 s) and best effort: a provider request that ignores the signal keeps running and the next
run queues behind it. The conversation and every entry in it stay, so cancelling a run never deletes
history.

`list()` and `inspect()` are owner-scoped and derive status from the actual timer and run task
records plus live inspection. An admitted one-off run waiting for its turn reports `queued`, not
`running`. The view exposes both task summaries, including faulted, parked,
aborted, and missing states with their errors/reasons. It also exposes the target conversation's
current generation run. If that target generation parks while the cron run is still waiting, the
job view reports it instead of a false-healthy running state. An unhealthy timer dominates the
canonical status over a still-running run. A faulted run is visible while it is the active execution
and is retained in `lastFault` when the timer later replaces its pointer. A timer or run whose task
no installed definition can take is shown as parked: nothing revives it, so cancel the job or
restore a definition that can run it. This slice invents no cron retry policy. The view also carries the newest sanitized delivery fault for the
job (`deliveryFault`), so a malformed or full outbox is visible through the model-facing `list`
operation even though the run itself completed.

## Operator controls

`pedellus cron` is the owner's scheduling console. It is a process subcommand, not a chat
slash command, and it attaches to the running gateway over the private local socket, so every
runtime decision stays in the one owner process:

```sh
pedellus cron list
pedellus cron show <jobId>
pedellus cron cancel <jobId>
pedellus cron create --origin <sessionKey> --key <requestKey> --after 600 --message "Stretch"
pedellus cron create --key daily-1 --cron "0 9 * * 1-5" --tz Europe/Budapest \
  --origin telegram:<identity>:chat:<chatId> --message "Morning check"
```

- **Origins are host-resolved.** The wire names a mapped chat by its host-owned session key and
  nothing else: the gateway resolves that key to its conversation and derives the owner record
  itself, so a caller cannot supply a conversation ID or an owner. The legitimate origin set is the
  current mapped ordinary chat sessions (the same reader history search uses); a channel-state,
  automation, task-owned, forked or root conversation is never an origin. `--origin` may name any
  currently mapped chat, including a Telegram chat (its exact key is printed by `list`),
  and is required. An unmapped key is refused and schedules nothing. Operator commands do not attach or create a chat.
- **`list` and `show` are read-only and store-wide.** `list` reports every job every legitimate
  origin owns, ordered by the next occurrence in pages of 100 compact rows. Follow the printed
  `list --offset <n>` to read further pages; concurrent changes can shift these point-in-time
  pages. It names currently mapped chats so an explicit `--origin` can be given. `show` is
  one exact job ID; its message preview is limited to 300 characters. Neither reads a transcript or calls a model.
- **`create` needs an explicit durable request key** (`--key`). The foundation owns the idempotency:
  an identical retry (same key, same payload, same origin) returns the same job and arms no second
  timer; a different payload under the same key is refused; a key whose original job was cancelled
  reports that cancelled job and is never re-armed. Exactly one of `--at` (ISO 8601 with an explicit
  offset or `Z`), `--after`, `--every` or `--cron` (with optional `--tz`) is accepted, and `--mode`
  chooses `background` (default) or `origin`. A background job records its outcome on the job
  (`cron show`) and its answer is queued for a channel outbox; only the Telegram adapter consumes
  that outbox, so a background job on a CLI chat does not print its answer in the terminal. Use
  `--mode origin` for a CLI chat when the answer should appear in that conversation instead.
- **`cancel` is exact-ID**, also across origins: the caller's own attachment never limits which
  chat's job it may cancel. The foundation's fencing is unchanged — cancellation increments the
  generation, clears both pointers and abort-signals the timer and run — and a post-commit cleanup
  failure is reported as recorded-cancellation-plus-cleanup-failure, never as a failed removal. An
  ID recorded under more than one origin (a damaged or forged store) is refused rather than guessed
  at. An already terminal or settled job reports that there is nothing to cancel.
- **A lost response is an unknown outcome.** If the gateway stops answering, `create` tells the
  operator to re-run the identical request (the key makes that safe) and `cancel` says the
  cancellation may already be recorded and points at `cron show` before any retry. The command never
  reports a made-up result.
- There is no bulk operation, run-now, re-arm, schedule editing or direct SQL path, and this
  surface is not a model tool. With `cron.enabled` false the gateway exposes none of it and the
  command refuses with one fixed message.

Jobs are stored in their origin's document and are never deleted, so `cron list` also shows
cancelled and finished jobs and grows with the store's history. A job whose origin conversation is
no longer a currently mapped chat is not listed: that conversation gives no operator visibility
either. Its native timers can still fire; losing the mapping does not cancel a job.
Restoring such a chat's mapping is outside this surface.

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

One added product cap does exist: every accepted time — a one-shot instant, an interval anchor,
an armed timer instant and each recurrence — must stay inside the range a JavaScript `Date` can
represent (8.64e15 epoch milliseconds, `MAX_DATE_MS` in `cron-schedule.ts`). Anything beyond it is
refused before any job or timer state is written, because no receipt or renderer can print it; the
operator wire holds the same bound. A legacy record that already holds such a time is never
fabricated into a valid schedule: its next time projects as "none" and its schedule line reads
`once at an unrepresentable time` (or `every Ns from an unrepresentable time`), while the job
itself stays inspectable and cancellable. A legacy timer task whose persisted input names such a
deadline settles as failed with fixed text the moment Durable runs its phase — it never reaches
the sleep, arms no occurrence and leaves the job cancellable. A sleep beyond the bound written by
an older build can never come due, so it is inert — its residual is a clamped native wakeup
reference that fires and re-arms without dispatching anything, never an executed occurrence — and
it remains cancellable through the abort path. Because such a restored sleep would otherwise sit
on that residual forever, the gateway start (`runGateway`) runs one recovery sweep
(`disarmInvalidSleepingCronTimers`) over the public task APIs: it scans sleeping cron timers,
commits an abort mark on exactly those whose persisted deadline is out of range, and touches
nothing else; valid timers, job records and owner cancellation are unaffected. Durable's contract
is that an abort mark does not wait for a sleep, so the committed mark ends the sleep and the
task's own abort handler settles it "cancelled" through the ordinary scheduler; the sweep does not
wait for that. The sweep is not best-effort: a scan, commit or abort failure (such as a storage
failure that fails the Durable session) or a shutdown during open or recovery stops startup with
a fixed diagnostic before the local socket, any channel or `gateway.surfaces.started`. A timer
that settled meanwhile is the one benign race and is skipped. Durable restores the sleep at open
and arms its clamped native wakeup reference once `openGateway()` calls `harness.resume()`, so
until the CLI sweep runs that reference still exists; that window is inert. Arithmetic overflow while following
an interval is the absence of a next slot, never a failure of the occurrence that is due right
now: the timer admits that occurrence exactly once and the job simply stops re-arming, instead of
the overflow discarding the whole terminal commit.

## Channel outbox

The normal terminal commit of a settled run (success or error), isolated or origin, carries its
settlement and final assistant entry ID to the host's optional `finalize` callback. A separate
task-owned target's captured authority is retired there; an origin-mode run answers in the origin
conversation, so that conversation keeps its configured tools, cron ownership and context and none
of its documents are retired. When cron is enabled and the origin session belongs to a
channel enabled in the configuration (currently `telegram:` when `telegram` is configured), the
gateway writes one record to the origin conversation's `nanobot.cron.deliveries` document in that
same commit. The record is keyed by `cron:<jobId>:<scheduledAtMs>` and stores the text to send, so a
retried terminal commit cannot admit the same occurrence twice. A successful result's text is read
from the answer entry the scheduled submission settled with, so no model turn is rerun and no nearby
user answer is substituted for it.

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

Outcome policy: every normal settlement is queued, successful or not, unless suppressed. A
successful answer is queued from the committed answer entry of that scheduled submission; when
that entry is missing or its text is empty, the record carries a fixed empty-result notice instead. An error settlement
queues a fixed failure notice. Both notices name only the machine-generated `cron-<uuid>` job id and
the occurrence's ISO instant, and ask the owner to list scheduled jobs to inspect it; no provider
error, job message, model text or secret is copied into an external channel. A job created with
`silent: true` suppresses every successful automatic delivery, including the empty-result notice;
a failed occurrence still queues its fixed failure notice. Nothing else suppresses a successful
delivery: a scheduled run has no way to opt out of its own message, so an explicit reminder cannot
be silently dropped. A successful answer whose trimmed text is exactly `[SILENT]` (the retired
marker) is instead treated as unusable and queues that same fixed empty-result notice, so the
occurrence stays visible; the answer itself stays in the run's conversation, and the marker has no
meaning in an ordinary chat reply. An answer whose first line is exactly `[FAILED]` reports that
the run's own work failed: the terminal commit records it as an error (`run reported failure`), so
it queues the fixed failure notice even for a `silent` job. The marker can only escalate an
answered occurrence to failure, never suppress a delivery. These checks and that substitution run before
admission, so a suppressed occurrence creates no record, an unusable one queues its notice in the
same terminal commit, and a reopen or retried terminal commit cannot create one later. A cancelled, superseded,
fenced or missing-job run passes no settlement (`delivery: null`) and sends nothing externally, so
abandoned work never notifies; an earlier queued result for the same occurrence is unaffected. The
same occurrence key covers notices, so a reopen or retried terminal commit cannot queue a second
one. An origin-mode successful answer is queued through the same record and authorization path as
an isolated one, so it reaches its authenticated originating chat in addition to remaining the
origin conversation's answer for a locally attached CLI. Delivery uses the committed answer entry
of that scheduled submission; when
native admission batches several inputs into one run, they settle on the same answer entry, so that
batched answer can describe more than the scheduled message. There is no separate delivery service,
config key or per-chat permission. With the channel absent from the configuration, no
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
- No chat command surface, model selection, or misfire policy. A chat schedules through the agent's
  `cron` tool; the owner's terminal uses [`pedellus cron`](#operator-controls). One run
  submits one agent turn to a Durable conversation (the job's automation conversation, or the origin
  conversation in `origin` mode).
- Delivery covers both modes and is currently only consumed by the Telegram adapter. An origin-mode
  answer becomes part of the origin transcript, so an attached local CLI prints its committed final
  text once when the run ends (see [the CLI](./CLI.md)); the same answer is also queued for its
  authenticated private chat. Queued origin turns that hand over directly to a successor are
  attributed per run, so a later run neither steals nor suppresses an earlier answer. That is
  conversation presentation, not a delivery layer: there is no retry or exactly-once claim, and a
  CLI started after the run settled does not replay it.
- A pending outbox record has no age limit. A channel enabled later can deliver an older queued
  result once; an ambiguous record stays quarantined until an operator resolves it through the
  adapter's documented channel-state/outbox record.
- Silent delivery suppresses only the automatic channel message. The run still happens, its answer
  stays in its conversation, and a failure notice is never suppressed; removing or cancelling the
  job is the way to stop its notices. No scheduled run can suppress its own delivery, so the marker
  is never a host command, an ordinary chat convention or a per-occurrence opt-out: an answer that is
  only the retired `[SILENT]` text becomes the empty-result notice.
- The `cron` tool parses only ISO 8601 timestamps with an explicit UTC offset for `at`; parsing
  natural-language user text stays outside.
- The run task owns one execution, but not the conversation. Cancelling a job aborts its run task,
  and a cancelled run leaves the one-off queue and stops the background conversation's live work;
  the conversation and all of its entries stay. In `origin` mode an already-placed origin run is
  not owned by the run task; cancellation still fences both pointers and withdraws a still-queued
  input, but cannot retract an already-placed run.
- Origin-mode runs use the origin conversation's current agent and configured tool authority at
  request preparation. Background runs prepare an automation conversation through the trusted
  `prepare` callback, which also copies the origin's current model and thinking level and sets the
  configured workspace: an ownerless conversation inherits no agent state from Durable. The
  gateway records a `nanobot.config-tool-capture` document on the target with the origin
  conversation ID and the exact names the authenticated origin currently holds: its configured
  coding tools, the read-only memory recall it has (`memory_search`, `memory_browse`, `memory_read`
  while recall is enabled and it is a mapped chat), and the registration names of the currently
  connected MCP servers. It offers exactly those tools, so a **background** run cannot schedule
  another job or widen authority, and it captures no scheduling, worker delegation, MCP management
  or login, channel action, classifier or Code Mode authority. Recall and MCP are the origin's
  read-only/remote capabilities, not new ones: a scheduled-run call-time hook rechecks the durable
  capture and the current grants (recall still enabled, the server still connected and configured)
  on every call, and the recall service rechecks its own scope, so a revoked capability denies
  instead of widening. MCP tools are offered directly rather than deferred, because a scheduled run
  has no Code Mode or tool search to load a deferred tool. A different host must apply the same
  deny-by-default rule. The capture is a snapshot of names, not
  a grant: every call must also remain inside the current config `toolAllowlist` (or, for the two
  non-coding capabilities, inside the current recall/MCP grants) and require the
  recorded origin to still be an authenticated mapped chat, so narrowing the config and reopening
  narrows a pending run. A server configured or authorized after a run started is never added to
  that run's capture. The capture is written together with the origin conversation in the same
  commit that claims the conversation, and the foundation's optional `finalize` callback lets the
  host retire it in every terminal commit of the run (normal completion or error, target
  missing, job record missing, generation change or cancellation, and ownership fencing) and in the
  abort handler; only a phase fault or a crash before that commit defers retirement to the next
  reopen (see below). A reopen re-bounds a live scheduled run against that same current ceiling and
  the origin's current recall/MCP grants, so a revoked capability is pruned from the durable capture
  there and cannot return when it is enabled again. Because preparation happens per run, a later
  run's authority is whatever the configuration allows then, never what an earlier run held. When
  the origin has no known owner, `prepare` records no capture and the run stays default-deny.
  When a context snapshot provider is configured, `prepare` also rebuilds the origin's snapshot
  for the target conversation — bootstrap/AGENTS files, memory, the skill summary — and the
  read-only `skill` tool, so a scheduled turn renders the workspace context a normal turn would see
  at that moment: a later episode of the same conversation sees the current files, not the ones its
  first run read.
- An automation conversation deliberately has no SessionMap entry, so nothing maps to it and it
  cannot become a cron owner. The channel ingress path applies the same chat-scope rule and refuses
  a session key mapped to one instead of continuing with chat policy. After a reopen the Gateway
  restores the class before it admits any mapped key as a chat, finds a live run's target from the
  run task's checkpoint plus the class the origin's cron documents record, and restores that
  target's snapshot before applying conversation policy. A stored key naming an automation
  conversation therefore gets no cron ownership, no snapshot slot and no chat policy from that
  reopen either, and the policy pass leaves it with no tools. At the
  256-snapshot cap it evicts the oldest idle background target rather than failing the run; a mapped
  session's snapshot, the cron tool and the cron foundation are never added to an automation
  conversation.
- An `origin`-mode run answers in the origin conversation, so it still holds that conversation's
  `cron` tool and can schedule further jobs. An automation conversation is never given cron.
- A scheduled run's history participates in the episode catalog, because the reset boundary that
  starts each run also closes the previous episode; its closed episodes are recorded with their
  counts. It is not part of the message/tool search index, whose rows and cursors are bound to mapped
  chat sessions, and the read-only `history` tool cannot open it: automation conversations are not
  chat sources. Episode summaries are therefore not generated for one (the catalog records the opt-in
  watermark and defers), so nothing spends a model call on text no surface can read.
- A background run's captured tools are bounded, not independent. The config hook requires each
  requested coding name to be in the current config ceiling, in that run's capture, and the recorded
  origin to still be an authenticated mapped chat; the scheduled-run hook does the same for the
  captured recall and MCP names against the current grants, and the MCP hook against the live
  connection. A malformed or missing capture, or an unknown origin owner, fails closed. There is no expiry and no copied grant document. Because Durable's
  tool hooks run only in the call phase, the gateway also intersects every live run target before
  `resume()` with the current ceiling and its authenticated origin, so a new admission after the
  config narrowed is not offered the removed tool. A committed `execute` intent for a native coding
  tool is `unsafe` and settles as interrupted rather than rerunning (an MCP call is `unsafe` for the
  same reason). Every terminal commit of a run that already prepared a separate target retires that
  target's captured tools in the same commit,
  as does the abort handler, so a completed, failed, cancelled or superseded run leaves no capture
  behind for a later admission. A phase fault or a crash before the terminal commit still leaves
  the capture until the next reopen, where the pre-resume pass retires it; in that interval a
  direct host submission remains bounded by the config hook. The capture still drives tool
  selection during the run, so it may be offered a tool the config just removed; the call itself
  is blocked. One that already passed the hook and recorded intent can still execute.
- Disabling cron (`cron.enabled: false`) on a store that has jobs is not a cleanup operation. Job
  documents and unfinished runs' tool captures remain, and their persisted timer/run tasks have no
  installed task definition, so they stay blocked until cron is enabled again.
- A non-terminal run task, including a parked one, blocks new work with visible skips until it is
  retried or cancelled. Cancellation may remain pending if an owned model request ignores abort.
  For one-off jobs the same rule applies to the queue: a parked or faulted head run holds the runs
  behind it, which report `queued` until that task is terminal.
- The catch-all queue is a property of the origin conversation, not of a run: it is bounded at 16
  admitted runs and refuses rather than growing. A refused occurrence is visible only in the job
  record (`cron list` shows the fixed text); it is not announced in the chat.
- A crash that lands between a redirected `add`'s job commit and its tool result is not exercised
  by a committed restart test: reaching that window needs a crash mid-tool inside an app gateway,
  which the offline harnesses cannot produce without new machinery. What is covered is the dedupe
  identity that recovery relies on: the tool is executed twice with one host task identity across a
  reopened store and adds one job, and a second execution with the provider's ID reused adds its
  own. A tool whose replay identity is `unsafe` (every native coding tool, and MCP) settles as
  interrupted instead, so this applies to the cron tool's own `replay: "safe"`.
- A restart while a one-off run is queued is not covered by a committed test. The order is durable
  state (the origin's queue document plus each run task's native `waiting` state) and the run
  resumes from its own checkpoint, so the guarantee follows from the state model rather than from an
  exercised restart.
- A queued one-off run that is cancelled leaves the queue, and Durable keeps its terminal task
  record. Nothing compacts the queue document beyond those bounded entries.
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
`add`, isolated and origin runs, `list`/`remove`/terminal/unknown IDs, invalid
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
returned `full`, retained every pending record and recorded a deduped overflow fault. Those probes
were temporary and uncommitted, and used no live bot, credential or network request.

Relative-reminder regression coverage is permanent in `tests/cron-relative.behavior.test.mjs`.
With an injected foundation clock it checks that `after` resolves once to admission plus the delay
and that a replay after a clock advance and reopen dedupes that stored deadline and timer; that a
fired short one-shot retry still dedupes its original instant with no new job or timer; and that a
real Gateway turn issuing `cron add` with `after_seconds` stores and acknowledges the expected
once-at deadline. Invalid and same-key changed requests are asserted to leave the record unchanged.
The same suite asserts that `silent` is stored, part of dedupe identity, validated as a boolean, and
that a stored record whose field was removed still dedupes as `false` without being rewritten.

Permanent conversation-model coverage is in `tests/cron-conversations.behavior.test.mjs`. It drives
the foundation with a faux provider on fresh `mkdtemp` stores and a host that applies the real
prepare/retire seams: a recurring job records its conversation lazily on its first run, keeps the
same conversation across two runs, places one native reset before each run's input, and its episode
transcript is exactly reset/input/answer twice; the second run's provider request contains only its
own episode, so the boundary is real and not a trim. It checks that a run's captured authority is
gone between runs while the conversation persists. For one-off jobs it gates the first run's model
request, schedules a second, and asserts the second is `waiting` in the durable queue and `queued` in
the job view, that the admission order is the document's order, that the queued run wakes when the
head finishes and executes in that order in its own episode, that cancelling the queued job removes
exactly its entry and terminals its task, that cancelling the head lets the next queued run proceed,
that the next one-off reuses the same catch-all conversation with its own reset, and that finished
runs leave an empty queue. A fenced re-claim (a job whose generation moved on while the
gateway was down) removes its own queue entry. A full queue refuses the occurrence with its fixed
`lastOutcome` text without creating a catch-all conversation or adding a queue entry, and a
malformed queue refuses it with its own fixed text instead of faulting the run. A recorded pointer
is adopted only when the conversation's own marker names that job: a chat-like conversation, the
root and another origin and job's conversation are all left untouched (no marker rewrite, no
boundary, no input) and a fresh conversation is recorded in their place. A boundary already at the
end of a conversation is not placed a second time, and
`origin` mode creates no conversation, records no conversation ID and places no cron boundary. A
gateway case schedules one occurrence through the real `cron` tool, then asserts the recorded
automation conversation, its `one-off` class marker, retired capture and empty tool list, that a
forged session mapping to it is rejected as an `automation` conversation by `historyEntries`,
`listHistoryEpisodes` and the channel ingress path (which also leaves the real chat working), and that
the reset scheduled an episode-catalog pass for it. A reopen case forges the mapping before the next
open and asserts the same three refusals, an empty tool list and an offer of no tools at all, while
the real chat key keeps its configured coding tool and its cron ownership; a second reopen case
deletes the origin's `oneOffConversationId` and every `job.conversationId` before forging the mapping,
so the conversation's own marker is the only record left, and the same refusals hold. A third reopen
case forges a mapping to a fork and asserts that the startup pass installed no cron extension or tool
for it while the chat key and a `:channel-state` key keep their mapped-session behaviour. A second
gateway case schedules a recurring job
through the `cron` tool with a context snapshot provider whose content changes on every call, and
asserts that each episode's request renders the snapshot rebuilt for it instead of the one the
earlier episode installed.

The same suite covers the per-run recall/MCP capture with a real MCP stdio fixture and a workspace
note. An isolated scheduled run's durable capture is asserted to be exactly the origin's coding
ceiling plus `memory_search`/`memory_browse`/`memory_read` and the five connected MCP registration
names, with no `codemode`, `tool_search`, `worker`, `cron`, MCP management, channel tool or captured
classifier; the run is offered the recall and MCP tools directly. A gated model request lets the
test act between rounds: `memory_search` and the captured MCP tool both succeed against the real
workspace and the real server. Owner MCP removal and re-addition during the run permanently prune
its captured MCP names; re-addition never restores them, while captured recall survives policy
refresh even with an empty coding ceiling. Both `read` and empty-ceiling variants run. The capture
is then narrowed to coding tools and the same capability calls are denied while `read`, if granted,
still succeeds. A separate case leaves a stale capture naming recall and
MCP on a settled automation conversation, reopens with both withdrawn, asserts the capture is
retired and the conversation holds no tool, then reopens once more with both enabled and asserts no
name is resurrected and the conversation still has no recall scope. The live-run reopen bound (the
per-capability ceiling and prune of a still-running target) is derived from the same helpers but is
not exercised across a process restart, because a scheduled run cannot be parked deterministically
without a committed test seam.

Stored-document compatibility was verified in that same suite: a job document written by the earlier
per-occurrence model (no `conversationId`, no `oneOffConversationId`, no `oneOffQueue`) is exercised
by every case above, because `schedule()` writes none of those fields and the first run records them
lazily. There is no document version bump, so no stored job is rewritten or dropped.

Permanent channel-outcome coverage is in `tests/cron-origin-delivery.behavior.test.mjs`. It drives
the real `openGateway` (and `runTelegram` with a mocked transport) on a faux provider in fresh
`mkdtemp` stores: an origin-mode scheduled answer is delivered once through the outbox while the
origin keeps its configured tools and cron ownership; a non-Telegram origin creates no outbox
document; isolated success delivery remains `pending`; an isolated run whose provider errors queues
exactly one fixed failure notice, asserted against the raw provider error and job message text, and
the finished target's captured config tools are gone; an empty origin-mode answer queues the fixed
empty-result notice once, and reopening the same store still holds exactly that one record; and an
aborted scheduled run queues no record at all. Silent-delivery coverage uses the same real gateway
path: a `silent` background job with an empty answer and a `silent` failing job queue no record and
one fixed failure notice respectively, a stored job whose `silent` field was removed still delivers,
the add confirmation and `list` both name `delivery: silent`, the live background target holds only its
captured `read` tool and no Telegram, cron, worker or other widened tool, and a reopen re-admits
neither suppressed occurrence nor changes the stored setting; a `silent` origin success stays
undelivered while remaining in the origin transcript, a whitespace-trimmed `[SILENT]` answer from a
non-silent origin job queues the fixed empty-result notice, an ordinary chat answer keeps the same
literal text, and a recurring background job queues that notice for its first `[SILENT]` occurrence
and delivers the next ordinary answer.

Permanent operator-control coverage is in `tests/cron-operator.behavior.test.mjs`. It drives the real
`openGateway`, the real private local server/client and a faux provider on a fresh `mkdtemp` store:
create, list, show and cancel across a CLI chat and an explicitly selected Telegram chat; a
conversation ID or an unmapped key on the wire refused while the host derives the owner itself; an
identical retry deduping to the same job with no second timer; a conflicting payload under the same
key refused with the record unchanged; a cancelled original reported and never re-armed by an
identical replay; exact-ID cancellation of another chat's job; `already_terminal` and `not_found`
results; compact paginated listings and read-only operator connections that create no chat;
the CLI's create/list/show rendering and a spawned `pedellus cron` process; and closing
the server before a cancel, asserted to produce the CLI's unknown-outcome text
instead of a claimed failure or a claimed cancellation.
