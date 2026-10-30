# Lean assistant — 2026-10-30

## Checklist

- [x] Finish removal-first simplification and clean up its eight completed agents/four worktrees.
- [x] Archive superseded work orders and make this the single active plan.
- [x] L1 — Prove one offline memory lifecycle: learn, write topic memory, use skill, compact, reset, summarize, reopen, retrieve original evidence. Missing/failed summaries must not block raw recall.
- [x] L2 — Make unsuccessful scheduled work visible: fixed failure/empty-result notices through the existing Telegram outbox, with existing dedupe and unknown-send handling unchanged.
- [x] L3 — Make recovery understandable: specific value-free startup diagnostics and one stopped-store backup/restore smoke using the actual Gateway.
- [x] Independently review and integrate the three slices; fix only material findings.
- [x] Run the combined bounded offline suite and reconcile setup/current docs.
- [x] Obtain owner approval to proceed with one bounded live-model run on synthetic data using the existing acceptance runner.
- [ ] Make the explicitly named runtime credential available and execute that run; record pass/fail without increasing caps or silently retrying.
- [ ] Agree a CLI/Telegram pilot only after reviewing the live result. Do not imply offline checks prove useful real-model recall or live delivery.
- [x] Clean up this batch's resources after owner confirms integration.

## Product and constraints

One personal assistant, CLI or Telegram, one configured workspace. Config selects tools and named models. Markdown is memory; Durable owns transcript, compaction, tasks and recovery. Reuse those facilities. Keep host execution and optional direct-workspace Bubblewrap.

This follows the useful trunk of the [old assistant tree](plan/2026-10-29_assistant-tree_TODO.md) after the [completed removal pass](plan/2026-10-30_simplification_TODO.md). `plan/` is historical evidence, not competing instructions. Do not revive feature-for-feature Python parity, migration/archival SDKs, managed-copy execution or expiring tool grants.

No new service layer, agent loop, queue, retry framework, configuration mode, dashboard, backup subsystem or general-purpose acceptance harness. A short integration check is better than a test platform. Prefer deleting obsolete work and fixing observed failures over speculative restructuring. Keep data integrity and provenance; never trade them for fewer lines.

The implementation batch is offline. A separately owner-approved live acceptance run may use only an explicitly named runtime credential, synthetic data and the existing budget guard; no credential-file discovery or value output. No security audit, live Telegram sends, personal data, migration, deployment or cutover. Future web/MCP, product delegation and additional channels remain possible, but are not this batch's work. Dream, standing intents, heartbeat and sustained goals remain excluded.

## Batch ownership and finish line

Use `opencode-go / deepseek-v4.1-flash`, thinking `high`, 2–3 implementation workers in separate Herdr worktrees. Independent review before integration; at most three active children including reviewers/fix passes. Parent owns work orders, shared manifest/root exports, integration and final checks. Workers commit bounded results and report exact checks and limitations. Small permanent regression checks are appropriate for changed behavior; no sleep-based schedule waits or leaked gates/timers/subscriptions.

- **worker-memory-story:** history/context and one focused lifecycle regression. Reuse existing fixtures/patterns. Do not change runtime/CLI; report any integration hunk required. No new memory tools, ranking or history commands.
- **worker-cron-outcomes:** existing cron/outbox and runtime's cron finalization region; a few focused scheduled-outcome checks. Failed/empty runs get fixed text, never raw provider errors. Cancelled/superseded/missing jobs remain silent. Preserve existing success delivery and authority retirement.
- **worker-recovery-help:** startup diagnostics, recovery, CLI and runtime lock/prepared-replay failure sites only; a small stopped-backup/reopen check and concise storage instructions. No automatic cancellation, live-store copying, schema/data repair or new backup command.

Workers sharing `runtime.ts` own disjoint regions: cron finalization vs startup lock/replay failures. Do not reformat unrelated code or edit each other's region. New test file registration is a parent integration request, not permission for concurrent manifest edits.

Done for this batch means the retained assistant has a reproducible offline story, scheduled failures are no longer silent, recovery gives the owner a clear next action, and a disposable stopped-store restore works. It does not mean deployment or real-model acceptance is complete.

## Session log

### 2026-10-30

Owner confirmed the simplification and asked to continue toward a lean assistant with 2–3 implementation subagents at a time. Completed batch resources cleaned up after confirming all worker commits were patch-equivalent in main; unrelated older worktrees left untouched. Archived the former root plans into `plan/`. Baseline `b4fe8f1`: 21,496 source lines; typecheck/build, 71 behavior, 2 execution, 83 offline core acceptance and 48 faux real-flow rehearsal checks passed. This plan chooses useful end-to-end outcomes instead of restarting the old parity roadmap. Plan committed as `e3ab5b4f7231835886dd7f6e61c2ad39eaed8537`; launched all three slices from that explicit base:

- `worker-memory-story-4fe2eca5`, pane `w2J:p1`, workspace `w2J`, branch of the same name — L1 memory lifecycle.
- `worker-cron-outcomes-a308f483`, pane `w2K:p1`, workspace `w2K`, branch of the same name — L2 scheduled outcome notices.
- `worker-recovery-help-96b2cbb5`, pane `w2M:p1`, workspace `w2M`, branch of the same name — L3 actionable recovery and stopped-store restore.

All use OpenCode Go / DeepSeek v4.1 Flash, high thinking. Runtime regions are disjoint; no shared manifest edits. Await explicit reports, then independent review before integration.

L3 worker reported `d00a49cd8183a9e2ca0eccde6bd06ddead8a5ae2`: fixed store-lock/prepared-context startup diagnostics plus actual CLI checks and a stopped-store/workspace restore regression in the existing recovery suite. Worker reports typecheck/build, 73 behavior and 83 offline core checks pass. Independent `reviewer-recovery-help-f1a6e6a3`, pane `w2D:p3X`, is reviewing at the committed L3 checkout. No backup framework or automatic repair was added. Independent L3 review passed: actual CLI refusal tests preserve the blocked dispatch, restored mapping/transcript/memory/dedupe assertions are meaningful, retained gateway replay checks pass. Two doc-only clarifications (CLI vs SDK diagnostic detail, copy-step vs normal schema initialization) will be folded into integration. Integrated as `466d350`; parent typecheck/diff checks pass. Both doc clarifications applied; no executable change beyond reviewed commit.

L1 worker reported `c6ecf60`: one 464-line lifecycle test plus short HISTORY.md evidence; no source blocker found or source changed. Worker reports the new test passed under an outer 60-second timeout five times, plus baseline 71 behavior and 2 execution checks. It is not registered yet. Independent `reviewer-memory-story-a0fb8d9c`, pane `w2D:p3Y`, is checking provenance, pending/failed-summary fallbacks, cleanup and whether the test setup is proportionate rather than another acceptance harness. Independent review passed: actual original-entry marker attribution, pending/failed-summary retrieval and gate cleanup verified; setup judged proportionate to the four-phase story with no new shared harness. Integrated as `1400fda`; parent registered the file in test:behavior. No production source change was necessary, and no real-model usefulness claim is made.

L2 worker reported `3e59d604a90f136b07167056a158f5bf77576fee`: normal error/empty settlements use fixed job/occurrence notices through the existing outbox; abandoned/cancelled work stays silent, and capture retirement assertions cover success/error/abort. Worker reports 74 behavior, 2 execution and 83 offline core checks pass. Independent `reviewer-cron-outcomes-a1431f3e`, pane `w2D:p3Z`, is reviewing. Abort coverage uses `harness.abortTask`, not model-issued `cron remove`; no claim of the latter or live sends. Independent L2 code/test review passed. Reviewer found shipped cron skill prose and builtin table still describing error/empty silence; parent requested those exact guidance fixes plus removal of a pre-existing 'no channel delivery' claim in SKILLS_CONTEXT.md. Also requested direct job-id/occurrence assertions within the existing tests, not a new matrix. Worker completed `8c237a7` (four files: shipped skill/builtin/context prose and direct notice-identity assertions), then parent inspected and integrated as `94e12cb` + `b8448a1`. Parent softened skill wording to 'queued for delivery' rather than promising an external send always succeeds. No source change beyond reviewed L2 commit.

Final combined validation: removed stale dist, npm ci --offline, typecheck/build passed; 77/77 behavior (including the registered memory story), 2/2 execution, 83/83 default offline acceptance and 48/48 faux real-flow rehearsal checks pass. Root Markdown file links and diff whitespace checks pass. Production source is 21,542 lines, +46 from this batch baseline; additions are mostly focused regression evidence, not a new subsystem. All three slices independently reviewed and integrated. No live provider/channel, security audit, credentials/personal data, migration or deployment. Real-model recall/live delivery remain unproven; abortTask silence is covered, model-issued cancellation mid-uncooperative model call is not. Next useful gate needs owner approval for synthetic live-model acceptance; no broader feature work or acceptance harness is scheduled. Owner confirmed the result and requested cleanup/proceed. Closed all three reviewers and removed the three clean implementation worktrees and their patch-equivalent integrated branches; unrelated older worktrees left untouched.

For the next phase, owner approved proceeding with the existing bounded real-model synthetic acceptance runner: OpenCode Go / DeepSeek v4.1 Flash, low thinking for the product probe, at most 20 requests / 600,000 conservative input-token equivalents / 20,000 output, with offline rehearsal preflight. This is one controlled run, not parallel paid experiments; live Telegram remains out of scope. Credential presence check found no OpenCode key variable in the current environment; no credential value or file was read. Await explicit runtime credential provisioning or owner-run output before live dispatch.
