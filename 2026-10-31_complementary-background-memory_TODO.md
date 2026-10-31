# Bounded background memory — status and remaining work

Date: 2026-10-31. Status: one reader, one cursor, one executor implemented; live-model quality,
the 8-hour activation and a few stated bounds remain.

This is the standing work order for owner-authorized, bounded background memory. It is the single
evidence source for `memory-digest`: the earlier parallel "complementary" reader and its cursor were
salvaged and removed. `src/history/digestion.ts` is the one reader and cursor; `src/history/memory-digest.ts`
is the only executor; the runtime injects that one source.

## Implemented contract

- **Eligibility.** Completed-turn high-water over open and reset chats: a reset after an owner turn,
  the next owner/scheduled input, or a terminal assistant entry whose calls are all paired. An
  in-progress turn is never offered; a read offers only evidence already committed when it began, and
  an accepted batch's bounds never move.
- **Evidence.** Owner/assistant prose is lossless and streamed in ordered fragments (UTF-16 offsets,
  surrogate-safe). Assistant tool calls and paired results are included and labeled `untrusted-tool`.
  A long result is one head-tail preview (≤ 2,500 chars) with an omission marker and the original entry
  reference; the omitted middle is never claimed to have been read. Reset handoffs, system/compaction
  entries, thinking and unpaired results are consumed without evidence.
- **One cursor.** `nanobot.digest-cursor` holds the next step position, the immutable segment bounds
  while chunking, and the open tool-call ids, so pairing survives a chunk, a reopen and a restart.
  Acknowledgement re-proves a fresh segment's end and re-derives the claimed evidence before one
  compare-and-commit. A document written by the earlier closed-episode reader is mapped at its exact
  acknowledged entry/offset and upgraded in place; no second reader, cursor or migration project.
- **One batch per invocation.** A no-evidence batch is acknowledged without a provider call. There is
  no drain loop, retry loop or re-digest of expanding history.
- **Explicit background model.** `digest.preset` or `digest.model` (existing catalog and preset
  validation) is pinned at start; the foreground model and thinking level are never inherited, and
  absent both a start is refused. The target gets only curated `read`/`write`/`edit`, create-only
  `write`, exact-text `edit`, and the workspace/naming scope hook.
- **Captured budgets.** Defaults: 200,000 evidence chars, 2,000 entries, 500,000 input tokens including
  cached input, 12 successful model responses (tool-call responses included), 24 tool calls,
  600,000 ms, 8 changed files, 32,000 inserted-plus-removed chars. The owner accepts native failed
  attempts/retries outside the successful-response count; total recorded responses and token usage
  are still reported. Committed counters survive reopen. Tool/time/write caps are the primary
  operational bounds; tokens are a soft actual-usage ceiling, not a hard spending promise.
  A failed tool aborts the turn before another request; final usage is checked before acknowledgement.
  Missing usage fails closed rather than granting a fresh allowance.
- **Outcomes.** Success (including a no-op and an already-consumed replay) is silent. A failed or
  cancelled run admits one bounded internal issue report, deduplicated by request ID, whose bounded
  notice list is pruned only for definitively reported, successful or nonreportable records.
  `/digest status` shows the model, requests, input/cached input, output, cursor, reserved writes and
  pending issues.

## Remaining checklist

- [ ] **Live-model acceptance and quality.** Every check here is offline with synthetic providers and
      data. Real provider behavior, curation quality on real transcripts and deployment remain unproven.
- [ ] **Inactive 8-hour cron schedule.** The shape is documented (`CRON.md`, "Inactive 8-hour schedule
      shape"); no live job is created, enabled or started. Activation is an owner action with an
      explicit model.
- [x] **Budget decision.** Owner accepts 24 tools / 10 minutes and 12 successful model responses,
      allowing native failed attempts/retries. The 500k input-token ceiling is checked from reported
      usage, not guaranteed before dispatch. Deferred polling, compaction and an uncommitted response
      at crash are not precisely attributable by these counters. No financial or hard network cap is
      claimed. A pi-ai text estimate checks input plus catalog output reserve/context before submit.
- [ ] **Verification-bound refusals.** A forged or mismapped fresh start more than 4,000 entries beyond
      the frontier is refused loudly and offered again; a tool-call id over 200 characters, more than
      256 open calls, or more than 1,024 steps in one entry fails that chat closed. A separate
      2,048-step batch cap can split a range even when the entry/character caps fit. These are fixed
      safety caps, not adaptive handling.
- [ ] **Preview fidelity.** A long tool result is deliberately preview-only; the omission marker and
      reference are exact, but the middle is not part of the evidence.
- [ ] **Legacy frontier boundary.** A legacy offset is mapped onto the same prose extraction, but tool
      steps in the frontier entry after that offset are read while the closed-episode prefix's tool
      steps are not revisited. This preserves "never digest twice"; it is not a second ingestion path.

## Verification

```bash
npm run typecheck
npm run build
npm run test:behavior      # includes tests/history-digestion.behavior.test.mjs and the digest suites
npm run test:execution
npm run --silent test:core-acceptance
```

`tests/history-digestion.behavior.test.mjs` covers completed-turn eligibility, open tool rounds,
untrusted labels and previews, excluded entries, Unicode-safe lossless fragmentation, durable pairing
across chunks and reopens, replay/forged/stale/tail-less acknowledgement rejection, interleaved chat
IDs with fresh-start gap proof, the legacy cursor mapping (entry, character, empty-block, surrogate
and pairing cases), the two-entry minimum, the verification bound and the no-evidence batch. The
`memory-digest*` suites cover the executor, captured bounds, request/tool/write budgets, status,
notices, cancellation and cron intent.

## Log

### 2026-10-31

Started the C1 slice as a separate complementary reader/cursor. Rejected architecture: it duplicated
the cursor/read/ack pipeline (~1,700 lines). The owner approved a single pipeline, so the useful
Unicode preview/extraction code and its regressions were salvaged into `digestion.ts`; the parallel
module and its cursor were removed. Eligibility moved from closed episodes to completed-turn
high-water; evidence now includes paired tool calls/results; the one cursor gained the next step
position and durable open-call ids, with an exact one-time mapping for old documents. The executor
gained an explicit background model, request/token budgets read from the committed transcript, and
usage in its outcome and status. Obsolete closed-only regressions were replaced with tests for the
new contracts; the old scan-bound, forgery, no-op and ordering invariants were adapted and retained.

Independent review found acknowledgement could succeed over budget and failed-tool refusals could
cause additional model requests. Coordinator fixed final-usage validation and abort-after-tools,
separated successful responses from total recorded attempts per owner clarification, corrected the
cron model-availability gate, and added catalog context/output-reserve preflight. No activation.
