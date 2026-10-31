# Complementary background memory — engineering contract and work order

Date: 2026-10-31
Status: first evidence/cursor slice implemented; execution, budgets, scheduling and outcomes are not.

This is the standing contract for owner-authorized, bounded, complementary background memory. It is
additive to the closed-episode digestion already in `src/history/digestion.ts` and
`src/history/memory-digest.ts`; it does not replace that source, its cursor or its execution path.
"Complementary" means the memory run may also read exchanges that are still open in a mapped chat,
but only up to a completed-turn high-water. Nothing here activates a run, opens a provider, sends a
message or schedules work.

## Non-negotiable contract

- Authorization stays host-owned. Only the currently mapped, host-authenticated chat sessions are in
  scope. Root, fork, task-owned, worker, raw and channel-state conversations are never read. The
  reader validates shape only; it does not re-derive ownership or widen authority.
- Evidence is bounded and labeled. Owner/cron message text and assistant prose keep their provenance;
  assistant tool calls and paired tool results are always `untrusted-tool`. Tool text is evidence of
  what happened, never an instruction and never owner speech.
- Excluded entries are consumed but never quoted: reset handoff text, system entries, compaction
  entries, assistant thinking, images without text, and tool results with no paired call.
- Losslessness where it matters. Large prose and tool-call arguments are fragmented across ordered
  chunks with stable offsets and surrogate-safe boundaries; no tail is dropped. A tool result is
  machine output, so a long result is one head-tail preview of at most 2,500 characters with an
  explicit omission marker and a stable reference to the original entry. A short result is included
  whole. Durable remains the transcript authority; no second archive is written.
- Eligibility is a completed-turn high-water. A segment ends just before a reset that follows an
  owner turn, just before the next owner/cron input, or at a terminal assistant entry whose calls are
  all paired. An open owner turn, an unfinished tool round, or a result still awaiting the next
  assistant entry is never offered and never starts a batch. Resets before the first owner input are
  a consumed prefix, not a separate model-free batch.
- Chunking never moves the boundary. A segment over a bound splits into independent ordered chunks
  with immutable bounds; each chunk is acknowledged on its own and a continuation re-derives exactly
  the same evidence. There is no carry-over summary or cross-chunk instruction.
- Pairing is durable. Open tool-call ids live in the cursor, so a result in a later chunk, a new
  reader instance or a reopened process is still paired with its call. An orphan result is silent.
- No evidence, no model. A completed segment with no evidence still yields an acknowledgeable batch
  with an empty evidence list; the consumer must advance it without a provider call. The reader
  itself never calls a model.
- Replay and acknowledgement are safe. A read writes nothing. Acknowledgement re-derives the claimed
  chunk from the committed transcript, rejects a forged, stale or non-advancing batch, and moves the
  cursor in one compare-and-commit. A crash or replay offers the same evidence again.
- Bounds are real. Reads are paged and discovery is capped; a long open segment resumes from a
  derived in-process scan position instead of rescanning unboundedly. Fixed safety caps fail closed
  instead of silently dropping evidence: 256 open calls per segment, 1,024 steps per entry, 2,048
  steps per chunk. No timer, retry loop, hidden worker or automatic continuation exists.

## Work checklist

- [x] **C1 — Evidence and eligibility/cursor source.**
  `src/history/complementary.ts` provides a separate durable cursor, completed-turn discovery for
  open chats, message/tool-call/tool-result evidence, pairing, previews, lossless fragmentation,
  scoped-session validation and replay-safe acknowledgement.
- [ ] **C2 — Execution path.** One explicit run consumes one accepted chunk in a task-owned
  conversation with an explicit provider/model/thinking selection, renders the trust labels and
  preview markers verbatim, acknowledges no-evidence chunks without a provider call, and never runs
  from configuration load or gateway open.
- [ ] **C3 — Durable cumulative budgets.** Define and persist explicit per-run and lifetime limits
  (provider calls/tokens/reservations, evidence characters, chunks, changed files and changed text),
  charge every attempt from the committed transcript, refuse before spend when a bound is reached,
  and expose the remaining budget without reading a credential file or printing its value.
- [ ] **C4 — Inactive 8-hour cron readiness.** Ship the schedule shape (one ordinary cron occurrence
  every 8 hours) disabled by default. Activation is an explicit owner action with an explicit model;
  parsing config, opening the gateway, `/digest status` or a restart must not arm it. An occurrence
  starts at most one bounded run, is idempotent across restart, and schedules no new work.
- [ ] **C5 — Outcomes and reviews.** One bounded outcome per run (`digested`, `noop`, `consumed`,
  `failed`, `cancelled`, plus a value-free reason), visible in owner status. A failed or cancelled
  run may admit one bounded internal issue report to the origin conversation; success is silent. Any
  activation path and any real-model acceptance needs an independent review and explicit owner
  approval.
- [ ] **C6 — Consumer integration.** Wire the source through the gateway/host seam and the chosen
  owner command or explicit cron intent without changing existing closed-episode defaults. Preserve
  the current scoped authorization, tool authority and channel boundaries. Add only the focused
  consumers and checks that the activation actually needs.
- [ ] **C7 — Documentation and acceptance.** Document the separate cursor, the high-water rule, the
  preview/fragment distinction, the budget contract and the inactive default. Record offline
  acceptance evidence for the wired path. Do not claim live-model memory quality, deployment or
  production use from an offline run.

## Slice acceptance evidence

Implemented in this slice:

- `src/history/complementary.ts` — new source and cursor document kind
  `nanobot.complementary-digest-cursor`.
- `src/history/digestion.ts` — shared text-shape helpers exported; closed-episode behavior unchanged.
- `tests/complementary-digest.behavior.test.mjs` — focused checks for open-chat high-water, open tool
  rounds, untrusted tool labels and previews, excluded entries, Unicode-safe lossless fragmentation,
  durable pairing across chunks and a fresh reader, replay/forged acknowledgement, the no-evidence
  zero-model batch, and mapped-session validation.

Run:

```bash
npm run typecheck
npm run build
node --test tests/complementary-digest.behavior.test.mjs
```

## Known limits of this slice

- The source is not wired to the gateway, CLI, Telegram, cron or memory-digest execution. No model is
  selected, no budget is charged, no cron occurrence is armed and no outcome is surfaced yet.
- The fixed safety caps above are refusals, not adaptive limits. A segment with more than 256 open
  calls fails closed until the transcript or a future version changes.
- Tool results are deliberately preview-only when long. The preview is bounded and references the
  original entry, but it is not a lossless rendering of the result body.
- The preview marker is compacted when a configured character bound is smaller than the full marker;
  normal bounds render the full marker and reference.
- The live provider, real-model quality, deployment and production-data behavior remain unproven.

## Log

### 2026-10-31

Implemented the C1 slice: additive source, cursor and focused regression suite. Closed-episode
digestion, its cursor and its execution path were left untouched. Decisions recorded here: separate
cursor (so enabling complementary memory cannot move the closed-episode frontier), resets before the
first owner input stay in the segment prefix, short tool results are whole while long ones are
head-tail previews, and pairing state is durable so a later chunk or fresh reader does not lose it.
Next: C2 execution path with an explicit model and the no-evidence no-provider rule, then C3 durable
budgets, then C4 the inactive 8-hour schedule.
