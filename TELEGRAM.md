# Telegram adapter

`src/channels/telegram.ts` exports `runTelegram(gateway, options, context)` and
`TelegramOptions`. It uses grammY 1.46.0's typed `Api` client, Telegram updates,
and structured `GrammyError`/`HttpError` types. An explicit native-fetch bridge
keeps offline probes mockable. The API root is fixed to
`https://api.telegram.org`; the bridge forces `redirect: "error"`, disables
sensitive grammY logs, and reads the current global `fetch` at call time. grammY's
Node build supplies its own `AbortController` per call, so the bridge re-expresses
that signal with a native one; cancellation and grammY's timeout still abort the
in-flight request. The adapter calls typed `getMe` before polling and never
writes the token or token-bearing URL into an error message.

## Controls

A bounded authenticated control dispatcher runs before any input admission. It
only sees updates that already passed the private-chat allowlist check, so an
unauthorized sender, a group, a bot, or an attachment can never be a control and
never reaches it. `message.text` (not a caption) is classified:

- `/new`, `/abort`, `/help` are the only controls. Matching is an exact leading
  command token (case-insensitive; arguments are refused with a usage notice).
- `/new@bot` and `/abort@bot` are controls only when the mention names this bot
  from `getMe` (case-insensitive). Another bot's mention, or a mention while
  `getMe` returned no usable username, gets a bounded notice and is neither
  executed nor forwarded to the assistant. A malformed mention (`/new@`,
  `/new@@x`) is an unknown command as well, answered the same way.
- Any other leading slash command gets a bounded notice naming the three
  controls and is **not** sent to the assistant. `/prose` is therefore not a
  prompt; `//prose` sends `/prose` literally as assistant input.
- Everything else, including plain text and `/new` inside a sentence, is
  ordinary assistant input.

`/new` calls Durable's native `Conversation.reset(undefined, context)` on the
same mapped conversation: fresh model context, no handoff text, no summary, no
model call, unchanged conversation identity, tool authority and cron ownership.
Reset placement while busy is Durable's own next-boundary ordering; the adapter
does not reorder a reset, and queued messages are kept and run in the new
context. Episode boundaries that the history catalog derives from committed
resets apply unchanged.

`/abort` calls `Conversation.abort(context)` without `background`, which is the
narrowest public API: it withdraws this conversation's queued inputs, marks its
live non-background tasks and resolves once that ordinary scope is idle. Other
chats' conversations, background subtrees and cron run tasks (created with
`background: true`) are untouched. Queued inputs withdrawn this way settle
`unanswered` with reason `aborted`, so their pending deliveries are forgotten
without the generic failure text, one per input; the same applies to a turn
ended by a queued reset (reason `reset`). Other settlement reasons keep the
fixed failure text.

## Coding tools

The adapter has no tool-authority commands. The shipped Gateway's sole tool
authority is `config toolAllowlist`, which enables exactly those coding tools
for each authenticated private chat; `[]` or absent disables them. Every sender
admitted by `telegram.allowFrom` shares the configured workspace and tool
authority in its private chat. Admission is not per-tool authority, and there is
no grant, expiry, approval prompt or startup re-grant.

Tool authority comes from the configuration: editing `toolAllowlist` and
restarting is the only way to change it. `/tools`, `/grant`, `/revoke` and other
grant or approval commands do not exist in this adapter, and the model cannot
request or change tool authority. The same scope rules as the CLI apply: only a
validated ordinary mapped chat conversation is authorized, and scheduled
isolated runs get a captured subset bounded by the current config and origin.
See [`TOOLS.md`](./TOOLS.md#configured-authority).

Acknowledgements are ordinary channel-state pending records with `notice: true`.
They go through the same bounded chunk send, flood gate, write-ahead send intent
and unknown-outcome quarantine as model replies, and are never submitted to
Durable or the model. `/help` and refused commands create no conversation.

### Acknowledgement and pending semantics

A `/new` or `/abort` acknowledgement is committed **held** (`hold: true`) with
the command intent, and published once:

- the native call returns: "Context reset applied …" or "Abort applied for this
  chat: it is idle now. Queued messages were withdrawn and any running turn was
  stopped …" — phrased so an idle conversation is not claimed to have had a turn
  stopped;
- or the call has not returned after 30 seconds: the explicit still-pending
  wording, e.g. "Abort is still pending for this chat … the provider may be
  ignoring cancellation. Queued messages stay withdrawn and new messages are
  held, never answered and never dropped, until the turn ends." No completion is
  claimed, and no second message follows when the call finally returns.

A held acknowledgement is never delivered early, and it is not tied to the input
gate: notices are never model submissions, so a released notice can still reach
the user while that chat's inputs are held, even when the reply bound is full.
`/help` and refusal notices are not held, so they can be delayed behind an
earlier acknowledgement from the same chat that is still held; that keeps a
chat's acknowledgements in admission order.

Any non-notice item of a chat with a pending command waits: nothing is submitted
to the model, so a later message cannot be admitted early and then withdrawn by
the abort it followed. If a provider never honours cancellation, that chat stays
gated until the turn ends (a restart also unwedges it, because the durably kept
messages are then submitted); other chats, polling and their deliveries are
unaffected throughout.

### Admission, durability and per-chat serialization

Admission is one commit per update: the exact input text, its pending delivery
record and the polling offset. The model submission happens from that durable
record in the delivery path (with the update's stable request ID), so a crash
before submission is recovered rather than lost, and a duplicate update cannot
create a second turn.

`/new` and `/abort` are admitted the same way and additionally record
`{ updateId, command, status, chatId, senderId }` in the `controls` log **before**
the native call. While a chat's command is being applied, that chat is gated:
none of its pending inputs are submitted or delivered, so the acknowledgement
cannot precede or overstate the effect, and a message admitted after the command
cannot be submitted early and withdrawn by the abort it followed. The gate is per
chat: polling, other chats and other chats' deliveries continue, and the command
runs off the polling loop. The command itself is not queued behind a running
turn, which is what makes `/abort` able to interrupt one.

Per-chat model submissions keep admission order, and each chat's place is
reserved when a delivery is dispatched, before any asynchronous
`conversationFor`/`watch` work, so a slow first lookup of a real conversation
cannot let a later message submit ahead of an earlier one. Reply deliveries and
acknowledgements have separate concurrency bounds (eight each), so a full reply
queue cannot hide an acknowledgement.

Before a control is applied, every message admitted before it in that chat is
submitted, including one still parked behind that bound: the command task
re-submits them with their stable request IDs through the chat's submission
order, then applies the native call. A pre-command message is therefore
withdrawn or marked by the abort as native semantics require, never answered
after the acknowledgement; messages admitted afterwards stay gated and run later.

After the native call returns, the record becomes `applied`, the log is pruned,
and the held acknowledgement is released. If the process dies in between, the
next open reports the command exactly once: its held acknowledgement is
corrected to the explicit "interrupted, may not have taken effect" wording and
released, or, when no acknowledgement record is left, a bounded report is queued
for the recorded chat. `unconfirmed` is terminal, so later opens do not repeat
it; a replayed update (possible only if the offset was not committed) answers
that it was already reported and never repeats the action. The log keeps every
unresolved record and bounds `applied` history at 64 on admission and completion,
so a crash cannot evict a command whose effect is unknown. A
reported terminal (`unconfirmed`) record is pruned once its report is durably
delivered; unresolved records are never dropped. At most 64 unresolved records
are kept: further control commands are refused with a bounded notice (nothing is
executed or sent to the assistant), so a hung provider plus a flood of commands
cannot grow the log. Refusal creates no record and no held acknowledgement. So a
command is at-most-once: it can be lost and reported as unconfirmed, but it is
not automatically applied twice in normal recovery. If an operator rolls back the
polling offset without restoring the pruned control record, that update can apply
again. No exactly-once claim is made for a native reset (Durable exposes no reset
idempotency key). Version 1 and 2 state documents
migrate with an empty `controls` list.

State version 4 accepts both historical version-3 shapes and preserves any present
`controls` and authenticated origin bindings. Invalid stored shapes fail closed.

Not implemented here: `/restart`, tool-authority or approval commands, history
commands, `/stop` aliasing, and any command that would widen tool authority. Tool
authority is configured by the owner, not requested in chat: this adapter
exposes no grant or approval commands and the model cannot ask for one.

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
  revoked transaction draft escapes. Each accepted input is committed with its
  pending-delivery record and offset before any model submission; the delivery
  path submits it with the update's stable request ID. Polling does not wait for
  model completion. Pending deliveries are retried after restart, and
  re-submission uses the same request ID, so recovery cannot create a second
  turn. Recovered deliveries are checked against the current allowlist;
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
- While an admitted user turn is active, the adapter sends a best-effort
  `sendChatAction` typing action and refreshes it before Telegram's short
  lifetime. One loop per chat is shared by queued turns and stops when the last
  one settles, is aborted, or the adapter shuts down. Control acknowledgements,
  unauthorized input and scheduled-outbox delivery do not type. A rejected or
  flood-gated action is skipped without retry. Typing is not awaited by model
  admission or reply delivery; Telegram rate limits still apply to the shared
  outbound gate. No typing state is stored.
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
  from automatic polling/restart resend. An explicit Telegram rejection is held
  at once and any other delivery failure after ten consecutive attempts in one
  process, as `deliveryStatus: "failed"`: the record keeps its input, is not
  resent automatically, and produces one sanitized operator warning. Bot API 429
  rejections are never quarantined, however many times they repeat: the shared
  flood gate defers the retry and the record stays retryable (a 400 or another
  non-flood rejection is still permanent). Only narrowly proven pre-connect failures
  (`ENETDOWN`/`EHOSTUNREACH`) are automatically retried as no-send outcomes.
  GrammY error descriptions/causes and raw response bodies are not surfaced or
  logged. A terminal unanswered model submission sends the fixed message
  `Your request could not be completed.
  Please try again.`, except an intentional native settlement (`aborted` after
  `/abort`, or `reset` when a queued `/new` ended the turn), which is forgotten
  silently because the user asked for it; empty text answers also get a fixed
  user-visible response.
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
after 64 deltas using Durable's `CheckpointInfo.deltasSinceBase`. Schema version 4
combines durable sender-to-chat admission evidence (`origins`) with controls,
the next-final-chunk cursor, write-ahead send intent, and unknown-delivery metadata.
Version-1 and version-2 state migrate with an empty `origins` map; version 1 resets
the chunk cursor, and version 2 preserves it. Pending replies are kept, and no sender
binding is inferred from a chat ID. Prior
queued cron results remain in the outbox as nonterminal `withheld` records until that private chat
admits one fresh message, which restores the binding and releases them; they are not failed or
discarded.

Downgrading to a pre-`withheld` outbox reader can fail held deliveries; upgrades must be forward-only.

Successful final chunks are committed before attempting later chunks, so an
explicit later rejection does not resend known accepted earlier chunks. Required
outcome/progress commits use an uncancelled cleanup context and are reaped before
return.

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
`unknownStage`, `unknownChunkIndex` (for final output), and timestamp, plus
`notice: true` for a control acknowledgement that is never a model reply and
`hold: true` while that acknowledgement waits for its native call. Stop the adapter before reconciliation. After checking
Telegram independently, reconcile in one Durable transaction:

- If accepted, record the returned message ID / accepted final-chunk progress,
  then clear `sendIntent`, `deliveryStatus`, `unknownStage`, `unknownChunkIndex`,
  and `unknownSince` atomically. Removing an already-complete record is also valid.
- If confirmed unsent, preserve `nextChunkIndex` and known message metadata, and
  clear those same five fields atomically to permit recovery from the cursor.

Leaving `sendIntent` behind will quarantine the record again on reopen. Never
clear these fields without resolving the external outcome. A `failed` record is
recovered by clearing `deliveryStatus` (it is a known non-send, not an ambiguous
one), after which normal delivery can resume. A retry command/UI is outside this
batch.

## Offline control probes — 2026-10-29

No bot, credential, network or real model: the adapter was driven against a faux
Durable Harness over generated temporary JSONL stores with a mocked `fetch` in
throwaway directories, with prompts answered by content rather than call order,
plus one case on the real `openGateway` (generated workspace and data directory,
faux provider) where the first chat lookup is deliberately slowed. Checks passed:
allowlist-before-control (denied sender and group `/new` ignored, no reply, no
conversation); `/help`, unknown and argument-refused commands answered without a
conversation or a model call; `/new` and `/new@this_bot` writing exactly one
`pi.reset` entry; `/new@other_bot` refused with a notice instead of reaching the
model; `//new` reaching the model literally; `/abort` admitted only after the
current turn was running, withdrawing its queued pre-command input, preserving
and answering a post-command message, cancelling the abandoned provider call (its
late result never delivered), suppressing the generic failure reply, and leaving
another chat's answer untouched while polling continued; a `/new` acknowledgement
released after native admission; a replayed and a reopened interrupted command
each reporting the unconfirmed effect without a second reset and without repeating
the report, then pruned once delivered; a known-rejected delivery held after one
attempt, not resent across a full reopen; a flood-limited (429) delivery retried
across its cooldown and never quarantined; a malformed mention refused without
reaching the model; version-1 and version-2 state migrating to the control-aware
shape; a
provider that ignores cancellation (the poll kept serving another chat, the chat
stayed gated, the acknowledgement said the abort was still pending, the later
message stayed durably unsubmitted and then ran once released, and no completion
was claimed); `/new` during a gated tool round landing at Durable's boundary after
the tool result, with no failure text and a message queued before it running in
the new context; the real Gateway keeping per-chat submission order (first,
second, third) despite a slow first `conversationFor`, then closing and reopening
the same store and mapped conversation without repeating an earlier turn; a full reply bound with a
pre-command message parked behind it, which was submitted before the abort and
never answered after the acknowledgement; consecutive `/abort` then `/new`
applying in order with one acknowledgement each; 70 applied plus 60 interrupted
control records, where every unresolved record survived, each was reported
exactly once, and only applied records were pruned; and a hung abort followed by
70 `/new` commands, which kept the unresolved log at its bound, refused the
excess with a bounded notice, and reported every remaining record exactly once
after a reopen.

## Scheduled cron delivery

The adapter also consumes the durable, channel-neutral cron outbox
(`nanobot.cron.deliveries` in the origin chat conversation). A normal settlement, isolated or
origin, writes the text to send there in the same terminal commit as its outcome: the committed
final answer, or fixed sanitized notice text for a failure or empty answer; no model turn is
rerun to resend. On startup and every few seconds the adapter enumerates already-mapped chat sessions and
accepts only candidate keys for its own bot ID (`telegram:<bot id>:chat:<chatId>`). That key is a
locator, not authentication: before any send the adapter requires durable admission evidence for
that private chat, written before the message was mapped or submitted. The evidence records the
admitting bot ID, `chatType: "private"`, and the original authenticated `senderId`. The adapter
rechecks that original `senderId` against the live `allowFrom` list. It never equates `chatId`
with the sender and never treats the session string or a model-provided value as proof of identity.
If the evidence is missing, inconsistent, for another bot, or not private, the result enters a
nonterminal `withheld` state with no send. A fresh authenticated admission for that private chat
restores/refreshes the binding and returns the withheld records to `pending`; a cap eviction or a
migrated store therefore causes delay, not permanent loss. A valid binding whose sender is no longer
allowed settles `unauthorized` with no send and is not released by a later admission. Admission
evidence is bounded (1000 origins per bot): every valid admission refreshes `admittedAtMs`, and an
eviction is surfaced through a deduped sanitized fault and warning rather than silently hiding the
lost binding.

Scheduled sends share the bot flood gate, 4096-character chunking, chunk cursor, write-ahead
`sendIntent`, and bounded retries with inbound replies. Network writes for one chat are serialized
in request order, and only one scheduled record per chat is active at a time. That prevents
overlapping network calls and scheduled-record reordering, but it is not a whole-message lock: the
chunks of a multi-chunk message can interleave with another same-chat send between chunks.

Delivery state lives on the outbox record, not only in this process: `pending`, `sending`,
`unknown`, `withheld`, `delivered`, `failed`, or `unauthorized`, plus `nextChunkIndex`, `messageId`,
`sendIntent`, `unknownSince`, `withheldSince`, `settledAt`, and a sanitized `error`. An unresolved intent at open
becomes `unknown` and is never auto-resent; an explicit rejection becomes `failed`; 429 and proven
pre-connect outcomes stay pending for a later scan. Every normal settlement is queued: a
successful answer's committed text, or fixed notice text for a run error or an empty answer. A
notice names only the job id and occurrence instant and asks the owner to list scheduled jobs; no
provider error, job message or model text is copied. Cancellations, superseded, fenced and
missing-job runs remain silent externally and are visible through cron `lastOutcome`/`list`. If the channel is
absent from the configuration, no record is created; an existing record is never redirected to
another chat or channel. The outbox is bounded (1000 records per origin, 200 terminal records
retained) and never evicts pending or ambiguous records. A full outbox does not queue the new result
and records a durable sanitized fault; the run still completes. A stored outbox whose `deliveries`
value is not an array, or whose entries are not understood, is left untouched and surfaced the same
way instead of faulting the run. Cron `list` shows the newest fault as `last delivery fault`; the
operator document is `CronDeliveryFaultsDoc`.

A malformed individual outbox record is quarantined, never sent. If it has a usable ID the adapter
settles it `failed` with a fixed reason such as `delivery record has no text`; without a usable ID,
or when the whole document cannot be read, the adapter writes a sanitized entry to
`CronDeliveryFaultsDoc` and logs a fixed warning. Repeated scans dedupe the same fault and make no
outbound request. Raw error text, provider text and record contents are not logged or persisted as
the reason.

An origin-mode successful answer uses the same record, authorization and send path, so it reaches the
same authenticated private chat while remaining the origin conversation's answer for a locally
attached CLI. Delivery text is the committed answer entry of the scheduled submission; no duplicate
ordinary reply is produced, because the adapter sends only records from this outbox for work it did
not submit itself. When native admission batches several inputs into one run they settle on the same
answer entry, so a batched answer can describe more than the scheduled message.

Reconciliation for scheduled records uses the origin conversation's `CronDeliveriesDoc` token rather
than `TelegramState`. Stop the adapter first. If Telegram accepted the exact intended text, advance
`nextChunkIndex`/`messageId` and settle `delivered`; if it was confirmed unsent, clear `sendIntent`,
set `status: "pending"`, and preserve the chunk cursor. Never clear an unresolved intent without
checking Telegram, and never expect exactly-once external delivery.

## Offline integration probe

No live bot or credentials were used. A private temporary copy of the parent
probe imports this checkout's module, uses a faux Durable Harness/persistent
JSONL storage, and mocks `fetch` (the shared probe was not modified):

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
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
Every mocked `sendMessage` inspects the actual Durable document before remote
acceptance and asserts `deliveryStatus: "sending"`, the exact intended text, and
preview/final stage. Accepted-send/lost-response also proved one network send across polling and
full storage reopen. A seeded unresolved persisted intent reopened as unknown,
retained its exact intended text, and made no outbound request. All mocked
requests assert the fixed HTTPS origin and `redirect: "error"`.

Parent integration independently passed the full probe against the integration
checkout and also ran an actual subprocess SIGKILL-after-mocked-acceptance check
using the SQLite gateway. The mock inspected committed exact-text intent before
recording remote acceptance; after SIGKILL and full reopen, state was unknown,
the intended text remained available, and no retransmission occurred. This checks
our local crash boundary with mocked Telegram, not delivery over Telegram's network.
No live bot or paid model call was used in the offline probes above. External
sends remain unknown at an ambiguous boundary and require reconciliation, never
an exactly-once claim.

Scheduled-delivery probes (temporary and uncommitted) used the real Gateway and
adapter with a faux provider and mocked Telegram transport in fresh `mkdtemp`
stores. They covered end-to-end background-result delivery, full reopen without a
second send, unresolved intent reopening as `unknown`, a live-revoked binding
settling `unauthorized`, a mapped chat with no durable admission binding entering
nonterminal `withheld`, same-chat ordering with no overlapping network writes,
chunk cursors, an explicit rejection, and the disabled-channel boundary. State
probes covered a 1000-binding cap: the next admission evicted the oldest binding
with an observable sanitized fault, the evicted origin's result stayed `withheld`,
and a fresh authenticated admission restored the binding and delivered once. A
stored version-2 state migrated with an empty binding map; a prior queued result
became `withheld` without a fault flood and was restored by a fresh admission.
Corruption probes covered a stored `deliveries` value that was not an array, a
malformed pending record with and without a usable ID, and a reopen/recurring run:
the terminal run still completed, invalid data was left untouched, malformed
records were quarantined or surfaced in the fault document with fixed reasons, and
no outbound request was made. No permanent test, live bot, credential or network
request was involved.

## Live smoke check — 2026-10-26

Owner-authorized sole polling with private credentials outside the checkout and
an explicit numeric sender allowlist exercised the real Telegram API. A scripted
streaming faux model produced the reply (no paid LLM request). The owner confirmed
the final response with a screenshot; API observations recorded one sendMessage
and four editMessageText successes, including final text.

The temporary runner's auto-pass observer did not fire, so parent stopped polling
cleanly and independently reopened its isolated SQLite store. The SDK check found
one user/assistant turn, no pending output, no enabled tools, and only faux model
usage. This proves the real Telegram/Durable streaming path, not production
readiness, execution confinement, or real-provider compatibility. No credentials
or private transcript contents were added to the repository.

## Synthetic real-model pilot — 2026-10-30

After fixing the grammY/native-fetch signal mismatch, a first five-minute window
expired unused. A later owner-approved window used a disposable workspace/store,
one allowlisted user and the real DeepSeek Flash model. Telegram accepted 11
typing actions, five new messages (including a control acknowledgement) and one
edit. The owner reported that the replies worked well.

Paused, no-dispatch inspection of the closed store confirmed a skill load, topic
memory write, one reset, successful history search/open calls and a cron list.
The pilot stopped at its four-prompt guard when a fifth message arrived, before
that last request was admitted—not at the time limit. No cron job was created,
so reminder scheduling/delivery is **not** a live pass.

The run used 11 model requests, reserved 201,609 conservative input-token
equivalents and 16,896 output tokens, with no budget violation. It closed with
no pending replies. No webhook change, pending-update clearing, real workspace,
deployment or security audit was performed. A separately approved reminder-only
follow-up remains; the current bot process is stopped.
