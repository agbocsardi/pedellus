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
- API calls have bounded retries for transport, rate-limit, and server errors.
  API failures are classified by method and numeric status only; raw Telegram
  response bodies and fetch exceptions are not exposed. A terminal unanswered
  model submission sends the fixed message `Your request could not be completed.
  Please try again.`; empty text answers also get a fixed user-visible response.
  Polling errors other than cancellation terminate `runTelegram` for the host to
  handle.

## Delivery boundary and current limitation

Telegram `sendMessage` has no idempotency key. If Telegram accepts a message
but the process dies before the Durable document records its completion, a
restart can resend it. Request IDs deduplicate Durable input admission only;
external message delivery is at-least-once/unknown at the crash boundary, not
exactly-once. A lost HTTP response can also make a bounded transport retry
repeat a send. Conversely, an API rejection leaves the durable delivery pending
for a later retry. No plaintext sidecar is used.

## Offline integration probe

No live bot or credentials were used. The temporary, uncommitted probe at
`/tmp/tgprobe/probe.mts` exercised the actual adapter with a faux Durable
Harness, persistent JSONL reopen, and a mocked global `fetch`:

```sh
timeout 60s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/probe.mts
```

Observed output:

```text
PASS revoked-draft-safe state + deny/group rejection + restart reuses one admitted user turn
PASS recovered pending reply is reauthorized against current allowlist
PASS Unicode split/explicit final flush (4095,1202 code units)
PASS polling admits update 9 while eight outbound deliveries are blocked; cancellation reaps active work
All offline Telegram integration probes passed.
```

The probe asserts all requests use the fixed HTTPS origin with `redirect: "error"`.
Telegram API delivery remains at-least-once/unknown at the external send boundary.

## Parent integration review — follow-ups still open

The parent integrated `3da30092d` / `cf2ea8f33` as `f93d7c483` / `da2cd5398`.
Package-wide typecheck/build pass, and the parent reran the offline probe above
against source verified identical to the integrated module. No live bot was used.

Additional review found remaining lifecycle/retry issues; do not treat this as a
live-ready adapter:

- Fatal polling/admission errors do not cancel the adapter's active waits or stop
  their completion handlers from draining more pending deliveries. Exit needs a
  local cancellation scope and complete child-work cleanup while preserving the
  underlying durable submissions for restart.
- An edit accepted remotely whose response is lost can be retried into Telegram's
  `message is not modified` rejection and remain stuck. Deleted preview handling
  also needs an explicit recovery outcome.
- Capping `retry_after` at 30 seconds can retry earlier than Telegram permits.
- The channel document currently never checkpoints its delta chain.

A socket-native follow-up launch failed before creating a child because its
wrapper could not find `herdr` (`spawn herdr ENOENT`). No CLI delegation fallback
was used. These items remain tracked in the root TODO.
