# Operator scheduling and restart recovery — 2026-11-01

## Checklist

- [x] Implement thin live operator create/list/show/cancel controls over existing cron APIs, with validated mapped origins and native idempotency.
- [x] Investigate and implement only evidence-backed prepared-context recovery improvements; preserve unknown outcomes and authority, and document any native limitation.
- [x] Extend existing operator status with useful active-work visibility and refuse interactive restart while busy; no maintenance framework.
- [x] Independently review each candidate in its worktree; fix material findings before integration.
- [x] Integrate sequentially, validate the union offline, and reconcile affected documentation.

## Approved follow-up — automatic interrupted-turn recovery

- [x] Automatically abort startup-blocking prepared turns through native Durable semantics; do not replay or auto-nudge.
- [x] Record and deliver one durable, deduplicated interruption notice to the originating owner surface, preserving unknown external outcomes and current admission checks.
- [x] Add focused offline regressions, independently review, integrate, and validate.

Owner explicitly approved cancelling the interrupted turn so the gateway can become available, followed by one channel notice and manual continuation. This supersedes the earlier prohibition on automatic startup cancellation below, but does not authorize automatic retries, shutdown cancellation, checkpoint rewriting, broader task cancellation, job rearming, or live deployment. Use existing result/outbox facilities where appropriate; no new recovery framework.

## Scope

Owner approved implementation using Pi DeepSeek Flash subagents. Use pi / opencode-go/deepseek-v4.1-flash / thinking high. Fresh worktrees for implementation; fresh independent reviews. Keep useful changes small: no broad shutdown redesign, maintenance mode, bulk operations, run-now/rearm, new dashboard, or automatic startup/shutdown cancellation to hide the recovery failure. Add focused regression coverage, not exhaustive matrices.

Gateway is paused by owner. Do not access live store/config/credentials/personal workspace, start or stop services, deploy, rearm the nine cancelled/fenced incident jobs, or change legacy jobs/services. Another agent owns workspace skills; do not edit them. Synthetic offline checks only.

## Log

### 2026-11-01

- Read-only planning completed with three Pi DeepSeek Flash/high researchers. Existing cron foundation supplies required scheduling/cancellation/idempotency. Prepared-context guard is presence-based; native request replay can resend an unknown-outcome provider call. Native shutdown currently interrupts rather than drains work.
- Owner requested simplification, then authorized implementation of live scheduling, precise recovery work, and minimal busy-restart protection. Implementation dispatched in isolated worktrees; parent owns integration and shared-file conflict resolution.
- Candidates implemented and independently reviewed: scheduling `0fddd8c6` + review fixes `1dd0b9f3`; recovery `1cebf589` + fixes `f73e16cb`; restart `2d81414d` + fixes `958aabc8`. Parent fixed review findings directly. Targeted checks pass.
- Recovery scope is intentionally narrow: native compaction retry resumes safely; interrupted generation request remains fail-closed, requiring existing owner recovery. No automatic cancellation or replay was added.
- Found concurrent uncommitted history changes in main. Owner explicitly chose to leave them untouched and validate integration in a separate worktree. Dispatched a Pi DeepSeek Flash/high integration worker from committed main `b3434356`, preserving accepted silent-cron changes. Fresh union review follows; main merge remains pending.
- Integrated candidate based on `b3434356` preserves accepted silent-cron behavior. Fresh independent union review found one stale coverage claim and an out-of-range-page message; both fixed directly, with a focused assertion. No review findings waived. Documented limits remain: inspect/teardown is not atomic, operator visibility covers mapped origins only, and interrupted generation request continuation still needs native support.
- Final offline gate after fixes: typecheck/build pass, 386/386 behavior, 2/2 execution, 83/83 core acceptance. No live/provider/channel acceptance, deployment, service or job changes. Main was rechecked clean apart from this workorder before fast-forward integration; other agent's history work remains outside this candidate.
- Owner approved a follow-up: automatically cancel the startup-blocking interrupted turn, restore gateway availability, and send one durable deduplicated channel notice; owner manually nudges continuation. No automatic model turn or replay. Dispatch one Pi DeepSeek Flash/high implementer in a fresh worktree, then fresh independent review. Current clean main before this workorder update: `2aa1963d` (includes independently integrated MCP active-channel work; preserve it).
- Implemented and independently reviewed; fixed unreadable notice bookkeeping, background report suppression, and class-aware notices. Pi Codex Luna/high final review approved with no must-fix findings; no findings waived. Incorporated later committed main history changes in the worktree and revalidated offline: typecheck/build, 400 behavior, 2 execution, 83 core acceptance pass. No live deployment or job changes. Limitations include a revoked pinned model still blocking startup, at-least-once CLI notice on lost acknowledgement, and a full or unreadable notice outbox potentially preventing delivery without evicting unknown outcomes.
