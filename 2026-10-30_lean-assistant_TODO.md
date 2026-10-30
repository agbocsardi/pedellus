# Lean assistant — 2026-10-30

## Checklist

- [x] Finish removal-first simplification and clean up its eight completed agents/four worktrees.
- [x] Archive superseded work orders and make this the single active plan.
- [ ] L1 — Prove one offline memory lifecycle: learn, write topic memory, use skill, compact, reset, summarize, reopen, retrieve original evidence. Missing/failed summaries must not block raw recall.
- [ ] L2 — Make unsuccessful scheduled work visible: fixed failure/empty-result notices through the existing Telegram outbox, with existing dedupe and unknown-send handling unchanged.
- [ ] L3 — Make recovery understandable: specific value-free startup diagnostics and one stopped-store backup/restore smoke using the actual Gateway.
- [ ] Independently review and integrate the three slices; fix only material findings.
- [ ] Run the combined bounded offline suite and reconcile setup/current docs.
- [ ] Ask for approval of a small live-model/synthetic-data acceptance run, then a CLI/Telegram pilot. Do not imply offline checks prove useful real-model recall or live delivery.
- [ ] Clean up this batch's resources after owner confirms integration.

## Product and constraints

One personal assistant, CLI or Telegram, one configured workspace. Config selects tools and named models. Markdown is memory; Durable owns transcript, compaction, tasks and recovery. Reuse those facilities. Keep host execution and optional direct-workspace Bubblewrap.

This follows the useful trunk of the [old assistant tree](plan/2026-10-29_assistant-tree_TODO.md) after the [completed removal pass](plan/2026-10-30_simplification_TODO.md). `plan/` is historical evidence, not competing instructions. Do not revive feature-for-feature Python parity, migration/archival SDKs, managed-copy execution or expiring tool grants.

No new service layer, agent loop, queue, retry framework, configuration mode, dashboard, backup subsystem or general-purpose acceptance harness. A short integration check is better than a test platform. Prefer deleting obsolete work and fixing observed failures over speculative restructuring. Keep data integrity and provenance; never trade them for fewer lines.

No security audit, live provider spend, live Telegram sends, credentials/personal data, migration, deployment or cutover in this batch. Do not read secrets. Future web/MCP, product delegation and additional channels remain possible, but are not this batch's work. Dream, standing intents, heartbeat and sustained goals remain excluded.

## Batch ownership and finish line

Use `opencode-go / deepseek-v4.1-flash`, thinking `high`, 2–3 implementation workers in separate Herdr worktrees. Independent review before integration; at most three active children including reviewers/fix passes. Parent owns work orders, shared manifest/root exports, integration and final checks. Workers commit bounded results and report exact checks and limitations. Small permanent regression checks are appropriate for changed behavior; no sleep-based schedule waits or leaked gates/timers/subscriptions.

- **worker-memory-story:** history/context and one focused lifecycle regression. Reuse existing fixtures/patterns. Do not change runtime/CLI; report any integration hunk required. No new memory tools, ranking or history commands.
- **worker-cron-outcomes:** existing cron/outbox and runtime's cron finalization region; a few focused scheduled-outcome checks. Failed/empty runs get fixed text, never raw provider errors. Cancelled/superseded/missing jobs remain silent. Preserve existing success delivery and authority retirement.
- **worker-recovery-help:** startup diagnostics, recovery, CLI and runtime lock/prepared-replay failure sites only; a small stopped-backup/reopen check and concise storage instructions. No automatic cancellation, live-store copying, schema/data repair or new backup command.

Workers sharing `runtime.ts` own disjoint regions: cron finalization vs startup lock/replay failures. Do not reformat unrelated code or edit each other's region. New test file registration is a parent integration request, not permission for concurrent manifest edits.

Done for this batch means the retained assistant has a reproducible offline story, scheduled failures are no longer silent, recovery gives the owner a clear next action, and a disposable stopped-store restore works. It does not mean deployment or real-model acceptance is complete.

## Session log

### 2026-10-30

Owner confirmed the simplification and asked to continue toward a lean assistant with 2–3 implementation subagents at a time. Completed batch resources cleaned up after confirming all worker commits were patch-equivalent in main; unrelated older worktrees left untouched. Archived the former root plans into `plan/`. Baseline `b4fe8f1`: 21,496 source lines; typecheck/build, 71 behavior, 2 execution, 83 offline core acceptance and 48 faux real-flow rehearsal checks passed. This plan chooses useful end-to-end outcomes instead of restarting the old parity roadmap. Next: launch L1/L2/L3 from the committed plan.
