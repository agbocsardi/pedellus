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
- API calls have bounded retries for transport, rate-limit, and server errors. Telegram `retry_after` is honored as a full retry deadline (not capped); waits remain abortable and total attempts are bounded.
  API failures are classified by method and numeric status only; raw Telegram
  response bodies and fetch exceptions are not exposed. A terminal unanswered
  model submission sends the fixed message `Your request could not be completed.
  Please try again.`; empty text answers also get a fixed user-visible response.
  Polling errors other than cancellation terminate `runTelegram` for the host to
  handle.

## Adapter lifecycle and Telegram edit recovery

Each run derives a local cancellation scope from the caller context. Fatal polling/admission exits stop new delivery scheduling, abort adapter-owned fetches, watches, preview queues, and submission waits, and reap active deliveries before returning. Cancellation of `submission.wait()` only stops this adapter's waiter; it does not abort the Durable model work. Pending delivery records remain durable for restart recovery. The channel-state document checkpoints its delta chain after 64 deltas, using Durable's `CheckpointInfo.deltasSinceBase` without changing its schema version.

An exact Telegram 400 `message is not modified` response to an edit is treated as success (covering an edit accepted before a lost response). An exact `message to edit not found` response clears stale preview metadata and sends a replacement. Other 400 errors remain failures. Telegram descriptions are retained only for these exact internal classifications; surfaced errors contain method/status, not raw descriptions or token-bearing URLs.

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
timeout 60s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/pi-e078edd8-probe.mts
```

The unchanged parent probe cases passed: durable restart/requestId dedupe,
allowlist and group rejection, reauthorization, Unicode splitting/final flush,
and polling admission while eight deliveries are blocked. Every request asserts
the fixed HTTPS origin and `redirect: "error"`.

An additional private fatal-poll probe confirmed the adapter rejects promptly
and aborts an in-flight outbound wait. Its follow-on attempt to assert completed
output after reopening timed out; model-completion recovery after a fatal exit is
therefore not claimed by this check (the durable admission remains pending for
recovery). Exact edit-not-modified/deleted-preview scenarios and cancellation of
a long `retry_after` wait were not exercised end-to-end in the temporary probe.
Typecheck/build passed; no live bot or paid model call was used. External sends
remain at-least-once/unknown, never exactly-once.
