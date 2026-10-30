# Removal-first simplification — 2026-10-30

## Checklist

- [x] Confirm scope: one-off migration later, no managed-copy execution, config-only tool authority.
- [ ] S1 — Park migration/archive tooling: remove inactive implementation/tests/docs from the active tree; retain a short deferral note and Git history.
- [ ] S2 — Delete managed-copy execution and its dedicated lifecycle/import scaffolding; preserve guarded host and optional direct-workspace Bubblewrap.
- [ ] S3 — Remove grant/revoke/expiry authorization from runtime, terminal, tools, fixtures and acceptance. Config is the sole tool authority.
- [ ] Independently review each implementation slice and resolve material findings.
- [ ] S4 — Integrate shared manifest/export changes; trim obsolete report boilerplate and reuse genuinely identical types/helpers where it reduces code.
- [ ] Run combined typecheck, build, behavior, retained execution checks and offline core acceptance; reconcile docs with the surviving behavior.
- [ ] Present results and remaining limitations for owner confirmation before child cleanup.

## Decisions and limits

Owner explicitly authorized removal of the migration product, managed-copy execution, and legacy grants; SDK compatibility is not a reason to retain them. A later single migration may be a disposable external script, not a maintained subsystem here. Git history preserves removed work; do not move it into another maintained package or add disabled-mode wrappers.

Config `toolAllowlist` alone selects coding tools. Empty disables coding tools. Preserve mapped-chat scope checks, denied root/raw/fork/state conversations, bounded isolated-cron captures and current-config replay checks. Skill, cron and history stay separate from filesystem/shell authority. Keep model presets, context, history, scheduling and Telegram behavior.

No security audit, live provider spend, live Telegram sends, real data migration or deployment. No new framework, compatibility mode, general-purpose abstraction, or unrelated bug fixing. Static policy literals in retired reports disappear with those reports; do not redesign reports in surviving features without a concrete simplification. Permanent regression coverage should be small and relevant; adapt existing checks rather than building another suite.

## Work batches and ownership

Start up to three implementation workers in separate Herdr worktrees, all using `opencode-go / deepseek-v4.1-flash`, thinking `high`. Parent owns orchestration, review, integration, this checklist and shared files.

- **worker-park-migration:** migration, archival acquisition/preparation/persistence/search/rehearsal and their dedicated tests/docs. Trace legacy archive/usage helpers and remove them too only when exclusively part of this parked surface. No runtime/history/context changes.
- **worker-drop-managed:** managed-copy execution entry, sandbox, import worker, dedicated fixtures/tests/docs. Preserve `execution/host.ts`, `execution/policy.ts`, `execution/direct-bwrap.ts` and active host-tool behavior.
- **worker-config-tools:** runtime/terminal/tool authority, directly affected tests/fixtures, core acceptance and relevant tool/replay docs. Remove all legacy grant APIs/mode/UI; keep config-origin capture and replay boundaries. Reuse matching terminal/gateway model types if straightforward within owned files.

Workers must not edit `package.json`, `package-lock.json`, `src/index.ts`, `AGENTS.md`, the main assistant-tree checklist or this checklist. Report exact shared-file updates for integration; temporary build/export failures from these intentionally shared files are expected and must be identified, not hidden. Do not add compatibility stubs. Commit each bounded result and report branch, commit, checks and remaining integration requests.

When slots open, launch independent read-only reviewers against the corresponding committed worktree. At most three active children at once. Reviewers check removal completeness, retained behavior and focused coverage, not new features or speculative restructuring. Parent integrates reviewed commits and performs one final shared-surface cleanup pass, delegated where bounded.

## Session log

### 2026-10-30

Owner requested a removal-first plan and orchestration with 2–3 OpenCode Go / DeepSeek Flash high subagents. Clean baseline: `eb1f08a4cac43498f3423d86ca283b9a434e8a3f`. Previous offline checks passed 168 behavior, 9 execution and 88 core-acceptance checks; counts will change as retired features and grant-only cases are removed. Exact installed model resolved as `deepseek-v4.1-flash`. No implementation changes yet.
