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
  requests, including the original input and chat target. Each accepted input
  is submitted to Durable before its offset is committed; polling does not wait
  for model completion. Pending deliveries are retried after restart, and
  re-submission uses the same request ID.
- The adapter watches committed snapshots for the active input and coalesces
  partial text updates into `editMessageText` calls. It filters to text blocks
  only (never reasoning/thinking), explicitly flushes the final assistant entry
  after `submission.wait()`, splits output under Telegram's 4096-character
  limit, and bounds concurrent deliveries to eight. The remote message ID and
  last preview are stored with the Durable pending-delivery record.
- API calls have bounded retries for transport, rate-limit, and server errors.
  API failures are classified by method and numeric status only; raw Telegram
  response bodies and fetch exceptions are not exposed. Polling errors other
  than cancellation terminate `runTelegram` for the host to handle.

## Delivery boundary and current limitation

Telegram `sendMessage` has no idempotency key. If Telegram accepts a message
but the process dies before the Durable document records its completion, a
restart can resend it. Request IDs deduplicate Durable input admission only;
external message delivery is at-least-once/unknown at the crash boundary, not
exactly-once. A lost HTTP response can also make a bounded transport retry
repeat a send. Conversely, an API rejection leaves the durable delivery pending
for a later retry. No plaintext sidecar is used.

The adapter has not been checked against a live bot. The implementation was
constrained to offline validation; no credentials or live polling were used.
