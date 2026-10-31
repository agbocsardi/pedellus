# Channel controls and worker capabilities — 2026-10-31

## Checklist

- [x] Checkpoint the existing legacy migration plan with owner approval.
- [x] Align shared CLI controls with Telegram: reset plus prompt rebuild, stop/abort, status, model, digest, help and host-owned gateway restart; retain useful CLI-only controls.
- [x] Give ordinary workers web, MCP, Code Mode and read-only mapped-chat history, with independent `workers.toolAllowlist` grants; never Telegram, scheduling or recursive delegation. Preserve current-config narrowing and retirement across reopen.
- [x] Run existing offline typecheck/build, behavior, execution and core acceptance checks.
- [x] Review digest rollback with the owner; reject it and retain documented partial-write/retry semantics.
- [x] Reconcile affected documentation and report limitations; no live services or paid calls.

## Log

### 2026-10-31

Owner requested channel command parity and richer ordinary worker capabilities. Committed the pre-existing migration plan as `2faadc3` before edits. Rollback was considered as design-only work, then rejected by the owner below; operational acceptance remains deferred. Implementation preserves single gateway ownership and fail-closed tool capture, rather than treating a worker as a mapped chat.

Implemented CLI reset via the shared gateway reset host, with prompt replacement and reset marker in one idle-only commit. Added native stop/abort parity and a supporting-host restart path whose acknowledgement flushes before process teardown. CLI-only controls remain.

Owner then requested separate worker config and explicitly chose independent grants. Added `workers.toolAllowlist`: omission inherits configured chat capabilities, empty disables tools, explicit names replace inheritance, `mcp` expands at launch and exact MCP registrations can be selected. Coding registrations cover the union needed by the runtime, but separate call-time ceilings keep worker-only tools unavailable to the foreground and non-worker targets. Workers retain no Telegram, cron or delegation capability. Existing worker assertions were reconciled with the new history contract; no new permanent suite was added.

Verification: typecheck/build, all 306 behavior checks, 2 execution checks and 83 offline core acceptance checks passed. A disposable runtime probe exercised independent worker-only bash while a forged foreground selection was denied, nested web search/fetch plus MCP and history, no Telegram, terminal retirement, removal/re-enablement without grant resurrection, local prompt reload and multi-attachment busy refusal, and stop/restart acknowledgement through the real local transport. No process replacement or live API/service operation was performed.

Owner rejected rollback after reviewing the existing digest behavior: the model reads current memory and checks for already-recorded facts on retry. Retain partial writes, leave a failed batch unacknowledged, and offer the same evidence on a later invocation. Create-only writes and exact edits remain safeguards, not guarantees of semantic idempotence. Replaced the staging proposal with a short rejected-decision record at `plan/2026-10-31_digest-rollback-design.md`; rollback/staging is not a pending implementation item. Clarified the retained behavior in `HISTORY.md`. Documentation-only follow-up; runtime code and its prior verification are unchanged.
