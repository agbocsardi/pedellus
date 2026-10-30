# Assistant tree — usable first, breadth second

## Checklist

- [ ] Complete the owner-authorized [removal-first simplification](2026-10-30_simplification_TODO.md) before continuing trunk acceptance.
- [x] Agree the tree: CLI + Telegram trunk; tools, delegation, then more channels.
- [x] T1 — Make the existing assistant straightforward to configure and use (offline verified).
  - [x] Preserve config-tool and preset behavior in focused, reviewed permanent tests.
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
For the ordinary CLI and Telegram assistant, `toolAllowlist` in config selects
its coding tools directly; an empty list disables them. No grant/revoke workflow.
Only trusted Telegram users should be admitted: they share the configured tools
and workspace. Keep raw/forked conversations denied and cron bounded by its origin.
Make context refresh and background-summary costs understandable in setup.

Named model presets define provider/model/thinking once, selected by name for
the assistant and summary model. Runtime switching is a temporary utility;
restart returns to the configured selection. Existing direct-model configs still
work with their legacy persisted choices. Presets never change tool authority or
implicitly enable fallbacks. Setup, config-only tools and presets are integrated
and independently reviewed; combined synthetic CLI/Telegram execution passed.

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

- Config owns persistent settings and policy: tools, model/thinking defaults,
  workspace/skills, channels, summaries and cron enablement. CLI/Telegram commands
  are utilities, not required configuration steps. Any runtime override must be
  explicit and visible, never a hidden replacement for configuration.
- Keep actual conversation/job state in SQLite and memory/skill content in Markdown;
  config-first does not mean storing every reminder or learned fact in config.
- Work on one trunk outcome or major branch at a time. Fix a blocking dependency;
  park unrelated improvements instead of recursively expanding the task.
- Keep this plan short: outcome, done condition, status. Put technical findings
  in feature docs; add a new checklist item only if it changes the tree.
- Prefer a working vertical slice over another standalone SDK helper.
- Implementation workers add a few focused permanent regression tests; reviewers
  verify meaningful coverage and reliability. Use synthetic providers/controlled
  clocks, explicit timeouts and guaranteed cleanup, not real-time sleeps or
  sprawling matrices. Validate new tests under an outer process timeout.
- Real provider spend, live channel sends and personal-data pilots need explicit
  owner approval before execution. This planning update does not authorize them.

## Session log

### 2026-10-29

Reset the roadmap around a CLI + Telegram trunk, followed by tools, delegation
and additional channels. Superseded the sprawling v2 plan without deleting its
implementation evidence. Baseline review passed typecheck, 155 behavior checks,
9 execution checks and 88 offline core acceptance checks; real-model core and
live-channel acceptance remain open. Next: T1, using T2's story to guide setup.

Started two OpenCode Go / DeepSeek Flash high workers for setup and tool authority.
Owner simplified the design: product tool access comes directly from config, not
manual grant/revoke controls. Redirected both assignments accordingly; legacy SDK
grant contracts remain separate. Setup received independent review and a bounded
fix pass; config-only tool execution still needs implementation/integration proof.
Owner authorized rotating workers and starting model presets in parallel within T1.
Keep at most two implementation slices active and review each before integration.

Integrated the reviewed setup, config-only tool policy and named presets. Fixed
the review-discovered history/coding-hook composition bug. Updated the shipped
example and setup to use presets. Combined checks passed: typecheck, 155 behavior,
9 execution and 88 core acceptance checks; a temporary actual-Gateway smoke also
executed skill/write/read/history through CLI chat and the real Telegram adapter
with mocked transport, verified preset switch/reopen and empty-config denial.
T1 is offline-complete; no live provider/channel acceptance is implied. Relative
one-shot reminders are the next bounded worker slice. Keep workers available until
their review fixes and integration are finished; only then close their sessions.

Owner explicitly requested permanent regression coverage. Config-tool and preset
workers now own focused tests for their integrated changes; the relative-reminder
worker includes tests in its slice. Reviewers check coverage and hang resistance.
This replaces the earlier no-permanent-tests restriction for implementation work.
Config-tool tests passed independent review plus a sensitivity fix and are in the
standard suite. Relative one-shot reminders and their reviewed tests are integrated;
the setup now accepts “in ten minutes” without a model clock. Combined checks pass:
161 behavior checks in 8.5s, 9 execution in 12s and 88 core acceptance checks.
Both Node test phases have an external 60s deadline with forced kill after 5s.
Preset tests passed review and are registered; fixed their leaked deadline timer
and the same leak in an older model-policy test. Combined suite: 165 behavior
checks in 6.3s, 9 execution in 12s and 88 core acceptance checks.

Integrated independently reviewed successful origin-mode Telegram delivery via
the existing outbox, plus three focused tests. The final merged tree passes 168
behavior checks in 8.4s, 9 execution checks in 12s and 88 core acceptance checks;
the synthetic actual-Gateway/mocked-Telegram skill, memory, history and preset
smoke also passes. No live provider or channel calls were made. T3 remains open:
failed/empty job outcomes are not pushed, and live delivery/restart acceptance
still needs owner approval. No further work is starting this session.
