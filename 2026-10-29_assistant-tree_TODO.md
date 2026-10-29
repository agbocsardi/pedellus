# Assistant tree — usable first, breadth second

## Checklist

- [x] Agree the tree: CLI + Telegram trunk; tools, delegation, then more channels.
- [ ] T1 — Make the existing assistant straightforward to configure and use.
- [ ] T2 — Prove memory and recall through a complete conversation lifecycle.
- [ ] T3 — Make reminders and scheduled work useful end to end.
- [ ] T4 — Prove restart, failure handling and basic backup/restore.
- [ ] T5 — Complete a short CLI + Telegram daily-use pilot; fix actual blockers.
- [ ] B1 — Add web search/fetch and MCP to the ordinary assistant.
- [ ] B2 — Add background subagents and product Code Mode workers.
- [ ] B3 — Add Discord, Email and WebSocket, one channel at a time.
- [ ] Revisit leaves after the trunk and major branches are useful.

This is the current scope and work-order authority. Earlier plans in `plan/`
are historical evidence, not additional queues. Existing safety and data-integrity
contracts still apply; their implementation details belong in the relevant docs.

## The tree

```text
Useful personal assistant
|
+-- TRUNK: CLI + Telegram
|   +-- Easy setup and explicit tool authority
|   +-- Memory, skills, compaction and useful recall
|   +-- Reminders and scheduled results
|   +-- Restart/recovery and a real daily-use pilot
|
+-- B1: Reach -- web search/fetch, MCP
+-- B2: Delegate -- background subagents, Code Mode workers
+-- B3: Connect -- Discord, Email, WebSocket
|
+-- LEAVES: polish, broader compatibility, media, UI, migration
```

**Build down this list, not sideways into every possible improvement.**
The goal is useful assistant behavior, not a line-for-line Python rewrite.

## Trunk — finish the assistant we already have

The runtime, coding tools/grants, optional Bubblewrap, Markdown context, skills,
compaction, history/episode summaries, cron and restricted Telegram adapter are
already integrated. Start by using them together, not rebuilding them.

### T1 — Ready to use

Provide a clear setup path that enables memory, skills and cron deliberately.
Keep the existing CLI grants; choose and implement the smallest explicit owner
approval/provisioning path for Telegram tools, without weakening default-deny.
Make context refresh and background-summary costs understandable in setup.

**Done:** a fresh synthetic workspace can be configured from the docs, and the
assistant can use a skill and perform an authorized workspace task through both
CLI and Telegram. CLI and Telegram need not run simultaneously.

### T2 — Remember and recall

Exercise one continuous story: discuss a fact or decision, write topic memory,
use a skill, cross compaction, reset, summarize, restart, then ask a differently
phrased question. The assistant should find the old episode and inspect original
entries rather than treating its summary as evidence. Check that missing/failed
summaries do not prevent raw retrieval.

**Done:** the story works with a real model on synthetic data, with a short
pass/fail record. Fix failures that prevent useful recall; do not expand history
commands or build another memory subsystem.

### T3 — Be useful later

Keep the existing scheduling/runtime/outbox design. Finish origin-mode channel
delivery and make failed jobs actionable rather than silently invisible. Verify
one-shot and recurring work, cancellation, restart and Telegram result delivery.

**Done:** ask for a reminder or scheduled task in chat, receive the result, and
restart without duplicating the model submission or blindly resending an
ambiguous external send. Failure is discoverable with a clear next action.

### T4 — Survive ordinary trouble

Use existing checks and bounded probes for interrupted turns, provider errors,
rate limits and reopen. Do one disposable backup/restore smoke before trusting
personal data. Keep this a practical recovery path, not a new operations platform.

**Done:** the owner can restart or restore the assistant, keep its memory/history,
and understand a failed or uncertain operation without guessing from hidden state.

### T5 — Daily-use pilot

After the synthetic/live acceptance above, agree a small real-workspace pilot
through CLI and Telegram for roughly a week. Fix observed blockers to conversation,
workspace tasks, recall and reminders before adding breadth.

**Trunk done:** the owner finds it useful for ordinary daily tasks without routine
manual database repair, lost context or unexplained missing scheduled results.
This is a pilot milestone, not automatic Python retirement.

## Big branches — in order

| Order | Capability | Done means |
| --- | --- | --- |
| B1 — Reach | Model-facing web search/fetch, then MCP integration | The ordinary assistant can research a question with source links and use a configured MCP service under explicit authority. Not SDK-only plumbing. |
| B2 — Delegate | Background subagents, then Code Mode workers | The assistant can hand off bounded work, receive results and handle cancellation/failure without widening authority. Choose one simple parent/worker design before building. |
| B3 — Connect | Discord, Email, WebSocket | Each channel carries the same assistant capabilities with appropriate authentication and result delivery. Pick channel order when this branch starts; prove one before adding another. |

These branches are the intended direction, not permission to start all of them
while the trunk is unfinished.

## Leaves — parked, not forgotten

- Rich media/attachments and channel polish.
- More providers, OAuth/fallback compatibility and advanced model routing.
- WebUI, historical import/migration, deployment polish and eventual cutover.
- Performance tuning and abstractions justified by actual use.

WebUI, migration and cutover need a later owner decision. Sustained goals/tasks,
standing intents/keyword triggers, dedicated heartbeat and Dream remain excluded.
Previously excluded built-in skills stay excluded; a Python feature's existence
alone does not put it back in scope.

## Working rules

- Work on one trunk outcome or major branch at a time. Fix a blocking dependency;
  park unrelated improvements instead of recursively expanding the task.
- Keep this plan short: outcome, done condition, status. Put technical findings
  in feature docs; add a new checklist item only if it changes the tree.
- Prefer a working vertical slice over another standalone SDK helper.
- Use the existing checks; add permanent tests only when explicitly requested.
- Real provider spend, live channel sends and personal-data pilots need explicit
  owner approval before execution. This planning update does not authorize them.

## Session log

### 2026-10-29

Reset the roadmap around a CLI + Telegram trunk, followed by tools, delegation
and additional channels. Superseded the sprawling v2 plan without deleting its
implementation evidence. Baseline review passed typecheck, 155 behavior checks,
9 execution checks and 88 offline core acceptance checks; real-model core and
live-channel acceptance remain open. Next: T1, using T2's story to guide setup.
