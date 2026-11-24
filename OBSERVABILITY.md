# Gateway journal observability

The gateway exports structured records to stdout/stderr, already captured by the
shipped systemd units. There is no external collector, server, trace database or
in-memory trace archive. Logging is enabled by default and source changes require
a gateway restart to take effect.

```sh
journalctl --user -u pedellus.service --since "15 minutes ago" -o cat
journalctl --user -u pedellus.service -f -o cat
```

## Records and correlation

New records begin with `pedellus journal: ` followed by JSON. Existing
`pedellus diagnostic:` failures and fixed channel warnings remain intact.

- `span.started` / `span.finished`: operation, trace/span/parent IDs, elapsed
  milliseconds, projected attributes, status, and a safe diagnostic on a throw.
- `span.slow`: one warning after an operation has remained open for ten seconds.
  It is a latency signal, not proof of a hang or failure. The eventual finish
  supplies the total duration. There is no repeating slow-work heartbeat.
- `span.link`: a link between native submission traces and their host callers.
  Native input/continue admissions start their own traces by design.
- `pi.durable.checkpoint` / `pi.durable.replay`: content-free phase-change and tool-replay
  events. Entry/submission commits are not echoed (the durable store already holds them),
  and durable reports appear once, as the existing `pedellus diagnostic:` line.
- `pi.ai.first_chunk`: first normalized stream event latency, not necessarily the
  first visible text token. Model finishes include stop reason and reported token
  usage/cost. No token deltas or content-block events are emitted.
- `telegram.admitted` / `discord.admitted`: durable admission IDs, attachment
  count and pending queue depth. Telegram also records the age relative to the
  Telegram message timestamp (second precision; dependent on wall clocks).
- Typing failures/skips and recovery are recorded once per unavailable episode
  in each live typing loop, not on every refresh. Telegram's `typing.requested`
  means the adapter reached that point, not that Telegram displayed the indicator.
- Gateway startup/stopping/stopped and channel polling/serving events distinguish
  process startup from actual channel readiness. Rate-limit notices include the
  method and cooldown without response bodies.

Find an ingress record by Telegram `update.id` / `message.id`, or Discord
`message.key`. Its delivery-attempt span carries that same ID and a `traceId`.
Filter by the trace ID, follow `span.link` to the native submission trace, or use
`submission.id` / `task.id` to follow a specific native operation. Example:

```sh
journalctl --user -u pedellus.service --since "1 hour ago" -o cat \
  | grep '"update.id":903180346'
# Substitute the traceId from the matching delivery span:
journalctl --user -u pedellus.service --since "1 hour ago" -o cat \
  | grep '"traceId":"TRACE_ID"'
```

Each retry gets a new attempt span; the durable message ID stays the correlation
key. A successful later attempt is the recovery evidence. Attempt counts derive
from the adapter's existing consecutive-failure counter, not a persistent lifetime
counter (429/ambiguous outcomes follow their existing special handling).

## Coverage

The native Durable/AI adapter covers CLI, Telegram, Discord, cron and worker work
that runs through the native harness: admission, task phases, model attempts,
compaction phases and top-level/nested tool timings. Phase outcomes show retries,
sleeping, waiting and recovery. Sleeping until a scheduled job's next due time is
not an open execution span and does not trigger slow warnings.

Host spans cover Telegram/Discord submission-slot waits, preparation, settlement,
final-reply work and scheduled delivery. Telegram attachment work is broken down
into file lookup, response headers, streamed body/storage and transcription.
Discord ingress preparation includes quoted-message/file retrieval before durable
admission. Local file preparation, submission, settlement and request failures are
also recorded.

These records do **not** change queue ordering, retry policy, typing start time,
permissions, message content or delivery guarantees. A successful span means that
operation returned, not that the owner read a message; shared-run siblings do not
send another reply. A tool phase can complete normally with an error result:
its result/diagnostics still live in the transcript, not the journal. Direct model
calls outside the native harness are not automatically covered. There is no new
status UI, metrics endpoint or retained live-queue dashboard in this journal-first
baseline. Work waiting for an adapter's concurrency slot is visible through
admission/dequeue timestamps and queue depth, not its own active span.

## Privacy and operational bounds

The exporter projects a fixed set of scalar identifiers, states, counts, timings
and usage. It does not serialize request/response objects, prompts, completions,
tool arguments/results, filenames, file paths, URLs, provider response IDs,
credentials, raw exception messages or SDK error-status messages. Thrown errors
use the existing bounded safe diagnostic formatter. Native schema tool/model/API
identifiers and chat/message/conversation/task IDs are operational metadata:
logs are **not anonymous** and should retain normal private journal permissions.

Idle Telegram polls, healthy typing refreshes and per-token activity do not log.
Active model polls and task phases do log; busy agents therefore produce more
journal output. Journald controls storage/retention/rate limits as before. A
logging-sink failure must not replace the operation's value or error. Neither the
logger nor its timers own or restart application work.
