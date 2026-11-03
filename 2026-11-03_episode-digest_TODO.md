# Whole-episode digestion — 2026-11-03

## Checklist

- [x] Closed-only selection preserving imported and partially consumed cursor frontiers.
- [x] Durable internal chunk continuation, first episode unconditional, budget admission for additional episodes and X ceiling.
- [x] Read-only episode progress and honest documentation.
- [x] Focused synthetic regressions and existing bounded checks.
- [ ] Independent Pi Terra/high review and fixes.
- [ ] Commit reviewed implementation; no live activation.

## Log

### 2026-11-03

Owner approved direct implementation after two delegated implementers returned no working candidate. Existing work is checkpointed at c3dfff3a; failed attempts remain isolated. Closed episodes only; always finish the first admitted episode independent of estimated spending, then budget additional episodes. Ordinary memory writes remain nontransactional. Real execution/security failures may interrupt and retain internal cursor progress. No live restart, schedule/config changes, summary retries or model calls authorized.

Implemented closed selection on the existing cursor, automatic native-task chunk continuation with captured per-chunk scope/context/write/time safeguards, unconditional first-episode admission and cumulative input/response targets for later admissions. Added `digest.episodesPerRun` (default 1), checkpointed current batch/usage, and read-only `digestion` metadata on gateway/local episode listing/detail plus CLI rendering. The baseline suffix filter was removed after synthetic source/reopen and gateway recall/search/future-episode checks proved the consumed-prefix invariant; the importer already seeded its current-position cursor at the final closing reset. No new summaries or summary-only evidence path.

A sparse-global-ID regression uncovered an existing mid-item cursor bug: a chunk could persist the nominal lower bound instead of the actual entry ID and replay its head. Fixed the chunk position and refuse stored nonzero item offsets without an actual entry, rather than guess or replay. Historical already-admitted tasks keep captured single-chunk spending limits; all new invocations use episode admission semantics. Ordinary writes are unchanged and nontransactional. Per-chunk write/file reservations sum in invocation reporting, not cross-chunk distinct files.

Validation: typecheck/build; all 439 registered behavior checks (GNU timeout); 2 execution checks; 83 offline core acceptance checks; `git diff --check`. New checks cover closed-only, first-episode overshoot, automatic chunk completion, X/budget deferral, partial failure and live later-chunk reopen with captured bounds, imported cursor reopen and legacy segment upgrade, baseline/future closed evidence and raw search. No live activation. Current live frontier verification remains unavailable until separately approved deployment/activation of the read-only progress projection; historical migration verification and offline synthetic invariants are not claimed as current live-state proof.
