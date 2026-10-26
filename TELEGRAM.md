# Telegram adapter

`src/channels/telegram.ts` exports `runTelegram(gateway, options, context)` and
`TelegramOptions`. It uses grammY 1.46.0's typed `Api` client, Telegram updates,
and structured `GrammyError`/`HttpError` types. An explicit native-fetch bridge
keeps offline probes mockable. The API root is fixed to
`https://api.telegram.org`; the bridge forces `redirect: "error"`, disables
sensitive grammY logs, and reads the current global `fetch` at call time. The
adapter calls typed `getMe` before polling and never writes the token or
token-bearing URL into an error message.

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
  Long-poll timeout is sent in seconds and the grammY request deadline is bounded
  to 60 seconds. All requests reject redirects.
- `getUpdates` has its own flood wait and bounded transport/5xx retries,
  independent of outbound calls. Outbound calls share one bot-token flood gate;
  a later concurrent deadline wins. Full finite, positive `retry_after` values
  are honored, including after a call exhausts its bounded attempts. Waits are
  abortable and have a five-minute per-call budget; long timer waits are chunked
  below Node's timer limit. Replaceable previews yield during a flood wait rather
  than queueing stale edits.
- Ambiguous non-idempotent `sendMessage` outcomes (network timeout/reset,
  in-flight cancellation, or Telegram 5xx) retain the original pending record
  with a durable `deliveryStatus: "unknown"` marker. Such records are excluded
  from automatic polling/restart resend. Explicit Bot API 429 rejections remain
  retryable after cooldown. Only narrowly proven pre-connect failures
  (`ENETDOWN`/`EHOSTUNREACH`) are automatically retried as no-send outcomes.
  GrammY error descriptions/causes and raw response bodies are not surfaced or
  logged. A terminal unanswered model submission sends the fixed message
  `Your request could not be completed.
  Please try again.`; empty text answers also get a fixed user-visible response.
  Polling errors other than cancellation terminate `runTelegram` for the host to
  handle.

## Adapter lifecycle and Telegram edit recovery

Each run derives a local cancellation scope from the caller context. Fatal
polling/admission exits stop new delivery scheduling, abort adapter-owned
requests, watches, preview work, and submission waits, and reap active deliveries
before returning. Cancellation of `submission.wait()` only stops this adapter's
waiter; it does not abort the Durable model work. Pending delivery records remain
durable for restart recovery. Preview updates use one in-flight operation plus a
latest-value coalescer; a flood wait skips replaceable previews rather than
retaining stale calls. The channel-state document checkpoints its delta chain
after 64 deltas using Durable's `CheckpointInfo.deltasSinceBase`. Schema version 2
adds a durable next-final-chunk cursor, write-ahead send intent, and unknown-delivery metadata; version-1
state migrates with a zero chunk cursor. Successful final chunks are committed
before attempting later chunks, so an explicit later rejection does not resend
known accepted earlier chunks. Required outcome/progress commits use an
uncancelled cleanup context and are reaped before return.

A grammY 400 `message is not modified` error is treated as success for the exact
short description or a bounded detailed description with that exact prefix
followed by `: `; this classification applies only to `editMessageText`. An exact
`message to edit not found` error clears stale preview metadata and sends a
replacement. Other 400 errors remain failures. See `THIRD_PARTY_NOTICES.md` for
policy provenance.

## Delivery boundary and current limitation

Telegram `sendMessage` has no idempotency key. Durable input request IDs do not
make external sends exactly-once. Observed ambiguous send outcomes are now held
for operator reconciliation rather than blindly resent (an intentional behavior
change). Before dispatch, the pending record stores `deliveryStatus: "sending"` plus the
exact intended text, stage, chunk index, and timestamp. Success atomically clears
that intent and records the returned message ID / accepted chunk cursor. Known
rejections clear the intent; unresolved intents after a crash reopen as unknown
and cannot auto-resend. This deliberately favors reconciliation over blind
at-least-once retransmission; it does not guarantee delivery or exactly-once.
No plaintext sidecar is used.

The adapter emits a fixed, sanitized operator warning containing only update ID
and stage when it marks a send unknown. Inspect the existing channel-state
conversation (`telegram:<bot-id>:channel-state`) with the Durable SDK and the
exported `TelegramState` document token. Each pending item retains input, target,
`nextChunkIndex`, `deliveryStatus`, `sendIntent` (exact intended text/stage/chunk),
`unknownStage`, `unknownChunkIndex` (for final output), and timestamp. Stop the adapter before reconciliation. After checking
Telegram independently, an operator can use a Durable transaction to record an
accepted chunk's progress/message ID and clear the unknown fields, or remove an
already-complete pending record; if confirmed unsent, clear only the unknown
fields to permit recovery from the existing cursor. Never clear an unknown marker
without resolving the external outcome. A retry command/UI is outside this batch.

## Offline integration probe

No live bot or credentials were used. A private temporary copy of the parent
probe imports this checkout's module, uses a faux Durable Harness/persistent
JSONL storage, and mocks `fetch` (the shared probe was not modified):

```sh
npm ci --prefix packages/pi-nanobot --ignore-scripts
npm run typecheck --prefix packages/pi-nanobot
npm run build --prefix packages/pi-nanobot
timeout 220s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/pi-e078edd8-followup.mts
```

All actual-adapter mock-fetch probes passed: baseline recovery/requestId dedupe,
allowlist/group rejection, reauthorization, Unicode splitting/final flush, and
eight-active-delivery polling; fatal polling with a fresh blocked-model gate and
pending-record verification before/after exit plus model continuation and output
delivery after reopen;
cancellation during a blocked partial preview with no post-return work; 35-second
`retry_after` with no early retry and prompt abort; concurrent 429s across eight
deliveries respecting the shared bot-wide deadline; final 429 cooldown retained through five-attempt
exhaustion and later delivery re-entry; short and detailed not-modified
responses after simulated accepted/lost edits; and deleted-preview replacement
with final flush. Additional checks passed version-1 state migration, ambiguous
5xx send persisted as unknown and not retried after reopen, proven ENETDOWN retry,
and first-chunk progress retained after a later explicit rejection. In-flight
send cancellation now intentionally records unknown instead of resending.
Accepted-send/lost-response now also proved one network send across polling and
full storage reopen. A seeded unresolved persisted intent reopened as unknown,
retained its exact intended text, and made no outbound request. All mocked
requests assert the fixed HTTPS origin and `redirect: "error"`.

No live bot or paid model call was used. External sends remain unknown at an
ambiguous boundary and require reconciliation, never an exactly-once claim.
