---
name: cron
description: Schedule one-shot or recurring work with the cron tool. Use when the user asks for a reminder, a periodic check, or a calendar-based task.
---

# Cron

The `cron` tool is an internal agent capability: it exists only when the host
config sets `cron.enabled`. There is no user scheduler or slash command. A due
job submits one agent turn — into a fresh background conversation, or into this
conversation. A successful, non-empty result from a background run may be
delivered to the authenticated Telegram private chat that created the job when
the Telegram adapter is enabled; no other channel delivers results, and errors,
cancellations or empty answers send nothing.

## Actions

- `add` creates a job. `message` is required and is the instruction the agent
  receives when the job fires, so write it as a self-contained task. `name` is an
  optional short label.
- `list` shows this conversation's jobs with schedule, mode, status, next run,
  last run, last skip, and last failure. There is no job-count cap.
- `remove` cancels one job by `job_id`. It is idempotent: a finished or cancelled
  job reports that there is nothing to remove, and the record's last outcome is
  kept.

Retrying the same `add` call cannot create a second job, because the job is
deduplicated on the tool call ID. Call `list` when you need job IDs.

## Schedule arguments

Provide exactly one schedule:

| Argument | Meaning |
| --- | --- |
| `after_seconds` | One-shot delay in whole seconds from now, for example `600` for ten minutes. Use this for relative reminders such as "in ten minutes"; it is an elapsed duration, independent of time zone. |
| `at` | One-shot instant as ISO 8601 with an explicit UTC offset or `Z`, for example `2026-11-01T09:00:00+01:00`. Use it only when the user states an exact instant. It must be in the future. A naive local time is rejected. |
| `every_seconds` | Fixed interval in whole seconds, anchored at creation, so the phase survives restarts. |
| `cron_expr` | Calendar expression, plus optional `tz`. |

`cron_expr` takes 5, 6, or 7 fields — `minute hour day-of-month month
day-of-week`, with seconds first when six fields are given (`0 0 9 * * 1-5` is
09:00 on weekdays) and year last. Nicknames such as `@daily` work. `tz` is an
IANA zone name and defaults to the configured `cron.timeZone`, or `UTC` when
unset; fixed offsets such as `+02:00` are rejected.

Do not guess at parsing user text: for a relative request such as "remind me in ten
minutes", pass `after_seconds: 600`; for an exact instant the user states, pass an
offset-qualified `at`; for a recurring wall-clock request, map it onto `cron_expr` plus
`tz`.

## Mode

`isolated` defaults to `true`: the job runs in a fresh background conversation
and answers there. `isolated: false` runs it here, once this conversation is
idle. Jobs are owner-scoped to the conversation that created them, so another
conversation's jobs are invisible and its IDs are refused.

Say which mode will run and where the answer appears. In background mode the
answer appears in a separate conversation; with a Telegram origin, a successful
non-empty answer is also delivered to that private chat, while errors and empty
answers are not sent. With `isolated: false` the answer appears here, and no
channel send is attempted.

## Authority and limits

- A run gets the origin's enabled tools captured when it is prepared, never
  more, and stays bounded by current host policy. Effectful work inside a run
  uses those tools exactly like an ordinary turn; a host with no configured
  tools gives the run none.
- A background run is offered no `cron` tool, so it cannot schedule more jobs.
  An origin-mode run still holds this conversation's `cron` tool.
- There is no per-job timeout argument: a run is an ordinary agent turn under
  the normal run limits.
- Busy slots are skipped, not queued or replayed, and the skip is recorded as
  `last skipped`. Slots missed while the Gateway was down are skipped the same
  way.
- A one-shot job is not deleted when it fires; it stays listed until `remove`.
- Setting `cron.enabled` to false is not a cleanup. Persisted jobs and their
  timers stay blocked until cron is enabled again.
