# Telegram adapter

`src/channels/telegram.ts` exports `runTelegram(gateway, options, context)` and
`TelegramOptions`. It uses Telegram's fixed HTTPS Bot API with Node's built-in
`fetch`; no Telegram SDK or live credentials are needed. The adapter calls
`getMe` before polling and never writes the token or token-bearing URL into an
error message.

## Behavior

- Requires a nonempty allowlist of decimal Telegram user IDs. Only private
  messages from those IDs are admitted; groups, bots, unknown users, and
  malformed/non-text content do not create user conversations. Non-text
  messages from an allowed user are submitted as an explicit unsupported-input
  notice, not represented as content the agent has seen.
- Session keys are stable per bot ID and private chat. Request IDs are stable
  per bot ID and Telegram `update_id`. Unknown/denied updates advance the
  offset without a reply.
- A channel-state Durable document stores the polling offset and admitted
  requests, including original input, chat target, and sender ID. Document values
  are copied to strict JSON inside transaction callbacks before they return; no
  revoked transaction draft escapes. Each accepted input is submitted to Durable
  before its offset is committed; polling does not wait for model completion.
  Pending deliveries are retried after restart, and re-submission uses the same
  request ID. Recovered deliveries are checked against the current allowlist;
  revoked senders' pending outputs are discarded (a known preview is best-effort
  deleted).
- The adapter watches committed snapshots for the active input and coalesces
  partial text updates into `editMessageText` calls. It filters to text blocks
  only (never reasoning/thinking), explicitly flushes the final assistant entry
  after `submission.wait()`, splits output under Telegram's 4096-character
  limit, and bounds concurrent deliveries to eight. The remote message ID and
  last preview are stored with the Durable pending-delivery record.
- The poller continues admitting updates while up to eight deliveries wait on
  model or Telegram work. The eight-job limit applies only to started deliveries;
  a full durable pending queue (1000 items) fails closed before offset advance.
  Long-poll timeout is sent in seconds and its fetch deadline is seconds plus a
  10-second margin, converted to milliseconds. All requests reject redirects.
- API calls have bounded retries for transport, rate-limit, and server errors. A bot-wide adapter-lifetime throttle honors the full finite positive Telegram `retry_after` deadline (not capped), including after the final local attempt; waits are abortable and total attempts are bounded. Long timer waits are chunked below Node's timer limit.
  API failures are classified by method and numeric status only; raw Telegram
  response bodies and fetch exceptions are not exposed. A terminal unanswered
  model submission sends the fixed message `Your request could not be completed.
  Please try again.`; empty text answers also get a fixed user-visible response.
  Polling errors other than cancellation terminate `runTelegram` for the host to
  handle.

## Adapter lifecycle and Telegram edit recovery

Each run derives a local cancellation scope from the caller context. Fatal polling/admission exits stop new delivery scheduling, abort adapter-owned fetches, watches, preview queues, and submission waits, and reap active deliveries before returning. Cancellation of `submission.wait()` only stops this adapter's waiter; it does not abort the Durable model work. Pending delivery records remain durable for restart recovery. The channel-state document checkpoints its delta chain after 64 deltas, using Durable's `CheckpointInfo.deltasSinceBase` without changing its schema version.

Telegram 400 `message is not modified` is treated as success for the exact short description or a bounded detailed description beginning with that exact prefix plus `: `; this classification applies only to `editMessageText`. An exact `message to edit not found` response clears stale preview metadata and sends a replacement. Other 400 errors remain failures. Telegram descriptions are retained only for these internal classifications; surfaced errors contain method/status, not raw descriptions or token-bearing URLs.

## Delivery boundary and current limitation

Telegram `sendMessage` has no idempotency key. If Telegram accepts a message
but the process dies before the Durable document records its completion, a
restart can resend it. Request IDs deduplicate Durable input admission only;
external message delivery is at-least-once/unknown at the crash boundary, not
exactly-once. A lost HTTP response can also make a bounded transport retry
repeat a send. Conversely, an API rejection leaves the durable delivery pending
for a later retry. No plaintext sidecar is used.

## Offline integration probe

No live bot or credentials were used. The parent probe was copied to a private
uncommitted variant that imports this checkout's source; the shared probe was not
modified. It used a faux Durable Harness, persistent JSONL storage, and mocked
`fetch`:

```sh
npm ci --prefix packages/pi-nanobot --ignore-scripts
npm run typecheck --prefix packages/pi-nanobot
npm run build --prefix packages/pi-nanobot
timeout 150s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/pi-e078edd8-followup.mts
```

The private follow-up copied the shared probe (without modifying it), pointed at
this checkout, and used fresh gates per scenario. All actual-adapter mock-fetch
probes passed:

- Baseline recovery/requestId dedupe, allowlist/group rejection, reauthorization,
  Unicode splitting/final flush, and polling admission with eight active sends.
- Fatal polling with a fresh blocked outbound gate: verified one durable pending
  record before forcing poll failure, prompt cancellation/reaping, the record
  still pending after exit, and the completed response delivered after reopening.
- Cancellation while a partial preview HTTP request was blocked; run returned
  and no further adapter requests occurred.
- `retry_after: 35` caused no second request during a 1.2-second observation;
  cancellation returned promptly and no request occurred after return. Eight
  concurrently blocked sends receiving 429 together also retried only after the
  shared bot-wide cooldown.
- Slow streamed model + actual preview edits: both the short and detailed
  “message is not modified” descriptions after a simulated accepted/lost edit
  were treated as success; deleted-preview error sent a replacement and the
  final answer flushed.

Every mocked request asserts fixed HTTPS origin and `redirect: "error"`. Package
`npm ci`, typecheck, and build passed. No live bot or paid model call was used.
External sends remain at-least-once/unknown, never exactly-once.
