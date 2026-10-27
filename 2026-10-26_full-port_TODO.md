# Full nanobot port — TypeScript on the Pi SDK stack

Date: 2026-10-26. Branch: `feat/pi-durable-rebuild`.
Status: **roadmap agreed in scope; implementation is partial, not production-ready**.
This is the forward plan. The [spike checklist](2026-10-26_pi-durable-rebuild_TODO.md)
retains its evidence/history; [package design](packages/pi-nanobot/DESIGN.md)
continues to constrain the currently integrated tool-less slice.

## Milestone checklist

- [x] P0 — establish baseline, owner decisions, initial parity/reuse map.
- [ ] P1 — prove execution, network, approval, and storage trust boundaries.
- [ ] P2 — integrate native Pi tools, QuickJS Code Mode, tool discovery, and MCP.
- [ ] P3 — deliver an everyday Telegram/CLI/TypeScript-SDK assistant.
- [ ] P4 — preserve memory, compaction, Dream, archive, and usage semantics.
- [ ] P5 — port sustained goals, subagents, read-only workers, cron, and heartbeat.
- [ ] P6 — complete retained channels, pairing, media, and capability tools.
- [ ] P7 — reconnect the existing WebUI to the single Durable gateway.
- [ ] P8 — finish provider parity and rehearse repeatable, lossless migration.
- [ ] P9 — owner-approved canary, cutover, rollback drill, and Python retirement.

Each unchecked milestone needs its exit evidence, not merely compilable code.
P1 security and P8 data integrity cannot be waived by a successful chat demo.

## Active behavioral coverage batch — 2026-10-27

Three independent `openai-codex / gpt-6-luna / high` workers start from committed
`038e9fcf83c06aaf5d04daeeaf105b47ee2fac03`. They own distinct new test files;
production-source issues and shared runner changes must be reported to parent.
No real data, live calls, gateway tools or automatic integration.

- [x] `pi-35c6804d`, `w27:p1` / `w27`: final CLI review found earlier
      blockers addressed; merged `eeea55965` and parent ran three tests covering
      slow output, SQLite EOF preservation and terminal filtering. Dedicated
      control-order, flood and secret-bearing startup-error tests remain open.
- [x] `pi-70f63e0d`, `w28:p1` / `w28`: final migration review found prior
      blockers resolved; merged `c2d6fef34` and parent ran four behavioral tests
      for eligibility, provenance, aliases, session shapes and safety.
- [x] `pi-13bd5370`, `w29:p1` / `w29`: merged `8496fc587` model-policy
      behavioral test. Parent reviewed and ran it against the parent build; it
      covers busy rejection, thinking/selection, normal reopen and revoked choice.
      Prepared-request crash recovery and deferred poll are not permanent tests.
- [ ] Parent review, reconcile any shared runner wiring, run targeted checks on
      the integrated branch, and preserve remaining gaps. Explicit completion
      reports are required; idle/acknowledgement is not acceptance.

## Active sandbox follow-up — 2026-10-27

- [ ] Worker `pi-5907db09`, pane `w26:p1`, workspace `w26`, branch
      `pi-5907db09`, uses `opencode-go / deepseek-v4.1-flash / high` in an
      independent worktree based on preserved sandbox tip `26ab7b9f6`.
      Review outstanding confinement/import/IPC/owner/lifecycle risks and address
      a bounded set with focused Nanobot behavioral checks. Gateway tools remain
      disabled; no live data, deployment, or automatic integration. Await explicit
      report, independently review and verify before accepting any security claim.
      Candidate `fdd8dcf35` adds workspace ownership and guarded deletion; parent
      returned a suspected early lock release during failed-create rollback and
      requested evidence for guest death vs owner SIGKILL lock release. Quotas,
      orphan handling and replay remain open; candidate is not integrated.

## Integrated implementation batch D — 2026-10-27

**Current status:** all three slices are merged; final independent CLI and
migration reviews have passed within their stated scope. The assignments below are historical, not
active instructions. Owned child worktrees and review tabs have been cleaned up;
branches remain. Broad milestones P3/P8 remain unchecked.

Owner requested continuation after C1–C3 acceptance. The batch used
`openai-codex / gpt-6-luna / xhigh`; containerization/sandbox/execution work
remains explicitly excluded and coding tools disabled. Independent managed
worktrees start from committed `32e8b4def1ed5bca8b0a417f55dda9563cce7f0c`.
Parent `w1P:p1` owned coordination, root docs, public exports and integration.
Later user-directed consolidation removed the owned child checkouts and review
tabs without force; the branches were retained.

- [x] D1 — P3 model policy and native persisted per-conversation selection:
      merged `36ff7b95f`; independent review and parent-built crash/reopen checks
      passed. Deferred-poll revocation was source-reviewed, not crash-tested.
- [x] D2 — P3 streaming CLI and native conversation controls: merged `3956e7717`;
      parent-built slow-sink check passed. This is integration, not final acceptance.
- [x] D3 — P8 read-only migration inventory: merged `e00651d33`; parent-built
      alias/message-shape probe passed. This is inventory only, not an importer.
- [ ] Add dedicated CLI control-order, rejection-flood and secret-bearing startup
      error behavioral checks. Final CLI review and EOF/slow-output tests pass;
      readline's 32k limit is post-buffering, not a hard ingress-memory limit.
      Migration's final review and initial safety tests pass; keep P3/P8 unchecked.
- [ ] Port selected Python behavioral scenarios into permanent TypeScript parity
      checks, prioritizing migration integrity, CLI lifecycle and model recovery.
      Owner approved behavior-focused coverage; test Nanobot-owned contracts and
      integration boundaries, not Pi Durable internals or a mechanical suite port.
      No permanent TypeScript parity tests have yet been added.

| Child / branch | Pane / workspace | Worktree | Exclusive ownership |
|---|---|---|---|
| `pi-86637320` | `w23:p1` / `w23` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-86637320` | src/config.ts, src/providers.ts, src/runtime.ts, config.example.json, PROVIDERS.md, new MODELS.md |
| `pi-0d64c0d6` | `w24:p1` / `w24` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-0d64c0d6` | src/cli.ts, new src/terminal/**, CLI.md |
| `pi-4b9c165f` | `w25:p1` / `w25` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-4b9c165f` | new src/migration/**, MIGRATION.md |

Ownership paths are relative to packages/pi-nanobot. No manifest/lock changes or
new dependencies assigned; request review if concretely needed. Python and pinned
`/tmp/pi-durable-reference-1.4.0` remain read-only references. No live/paid/network
requests, real credentials/history/config, host/deployment changes, push or cleanup.
The batch used bounded private synthetic/native Harness and SQLite probes plus
existing typecheck/build, without committed test scaffolding. Explicit reports,
not startup/idle/acknowledgement, were required for completion.

D1 proposes existing-session listModels/selectModel with explicit Context and
native transaction-scoped busy check/configuration. Model/thinking preservation
must not race security-policy reapplication. D2 initially supports /model status
only; parent may integrate selection after D1 review. Unsupported legacy commands
must remain explicit, especially /new archive semantics and /stop's parked-work
behavior; do not silently alias to native abort/reset. D3 is a dry-run inventory,
not a migration transaction or permission to auto-resume legacy work.

## Completed implementation batch C — 2026-10-27

Owner requested continued roadmap work using **Codex Luna xhigh**, explicitly
excluding containerization/sandbox work. That step is deferred for this batch:
no execution candidate integration, sandbox changes, or gateway tool activation.
Existing P1 blockers remain open; other work does not waive them.

All three workers use `openai-codex / gpt-6-luna / xhigh`, native Herdr wrappers,
independent managed worktrees, and committed base
`0fea899afce7e2c21055b45d3c567b8e6cd6f2ed`. Parent `w1P:p1` owns review,
root roadmap, public exports/integration and acceptance.

- [x] C1 — bounded P3/P8 provider/config slice: nine total native aliases,
      explicit credential references and source-backed support/limitations matrix.
      Integrated `ca85ed9ba`; independent review and parent-built checks pass.
      Real-provider acceptance, unsupported aliases and full P8 remain open.
- [x] C2 — bounded P3/P4 context composition SDK: opt-in native sections from
      host-supplied identity/memory/skill snapshots, no ambient discovery.
      Integrated `8cedf36a0` / `0252ab6dc` / `73bc37a86`; independent final review
      and parent-built probes pass with mandatory dedicated per-Harness ownership.
      Gateway loading, template conversion and full memory/skills parity remain open.
- [x] C3 — bounded P4 read-only native usage/archive-delta foundation: source-
      scoped immutable snapshots, exact safe-integer deltas and explicit unknowns.
      Integrated `2b6b8f2d9` / `e155b2099` / `7113cf96a` / `914638d3d`;
      independent final review and parent-built checks pass. Native duplication/
      omitted spend cannot be repaired; archive writer/reset/atomic cursor remain open.
- [x] Parent review, bounded independent verification and integration of C1–C3;
      unsupported semantics remain explicit and broad milestones unchecked.

| Child / branch | Pane / workspace | Worktree | Exclusive ownership |
|---|---|---|---|
| `pi-7dcd4062` | `w10:p1` / `w10` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-7dcd4062` | `src/providers.ts`, `src/config.ts`, config.example.json, new PROVIDERS.md |
| `pi-1db6d944` | `w21:p1` / `w21` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-1db6d944` | new `src/context/**`, CONTEXT.md |
| `pi-a34c1f70` | `w22:p1` / `w22` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-a34c1f70` | new `src/usage/**`, USAGE.md |

Paths in ownership column are relative to `packages/pi-nanobot`. No manifest/lock
changes assigned; request any necessary dependency rather than editing shared
ownership. Python and pinned `/tmp/pi-durable-reference-1.4.0` are read-only
references. No live credentials/data, paid/live calls, host/deployment changes,
push, cleanup, or committed test scaffolding. Use bounded private synthetic
checks and existing package typecheck/build. Workers explicitly report commits,
checks and remaining gaps through `herdr_report`; startup/idle is not completion.

## Previous implementation batch — 2026-10-26

Owner explicitly authorized Codex Luna xhigh implementation subagents. All start
from committed `0ea2c76eb3896646fb089549ad9d7669c7a6ed52`, in independent
Herdr worktrees; native wrapper tools only. Parent pane `w1P:p1` owns review,
root docs, integration and acceptance. No P1/P2 milestone is passed by launch.

- [ ] B1 — bwrap/native ExecutionEnv confinement: `pi-ccd4ba61`, former pane `w1X:p1`.
      Branch retained, checkout removed; latest unmerged tip `26ab7b9f6` includes
      additional follow-ups, but has not been accepted. Managed follow-up
      `4c1a96976` atop partial `6ab2ccc89` is withheld pending
      review/fixes: parent confirmed host IPC shared-memory exposure; initial
      import-ancestor race review plus quota/owner/lifecycle gates remain open.
- [x] B2 — opt-in native Code Mode/tool-search SDK lifecycle and offline nested
      replay: `pi-9dd12539`, pane `w1Y:p1`. Integrated `49f11d387`, `e150a0485`,
      `e508567dd`; direct dependency `be2453c84`. Final review and parent-built
      activation/sandbox/cancellation/safe-unsafe replay probes pass. Gateway
      installation, CodingTools/MCP/approvals and failure-verification remain open.
- [x] B3 — actual-connection SQLite WAL/FULL and fail-closed setup:
      `pi-72ce3be3`, pane `w1Z:p1`. Candidate `e8269c650` integrated as
      `2d5af1adf`; independent review and parent-checkout probes/build pass.
      Broader backup/restore/disk-full/schema/host-loss gates remain open.
- [ ] Parent review/integration and independent bounded verification; read-only
      security/replay review as needed before acceptance or gateway activation.

| Child / branch | Worktree | Exclusive ownership |
|---|---|---|
| `pi-ccd4ba61` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-ccd4ba61` | `src/execution/**`, EXECUTION.md, manifest/lock |
| `pi-9dd12539` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-9dd12539` | new `src/extensions/**`, CODEMODE.md |
| `pi-72ce3be3` | `/home/gergo/.herdr/worktrees/pi-nanobot/pi-72ce3be3` | `src/storage/**`, runtime.ts storage-open integration only, STORAGE.md |

All use `openai-codex / gpt-6-luna / xhigh`. Manifest owner is authorized to
add exact direct pi-codemode1.4.0 for native imports and pi-env1.4.0 only if
concretely useful; other dependencies require review. Existing Pi/grammY pins
remain. No worker enables tools in gateway, edits Python/Telegram/other workers'
files, reads live credentials, makes paid/live calls, changes host/server setup,
pushes/deploys or cleans worktrees. Runtime retains tools:[]/modelTools:[] before
resume. Probes use private synthetic data/faux models with bounded time/memory.
Completion requires explicit herdr_report; idle/working notices are not evidence.

## Owner decisions and definition of full port

- TypeScript owns the application/runtime. **Pi SDK-first** means Durable and its
  native tools/Code Mode/compaction/tasks, with supporting Pi packages as needed;
  not adoption of the entire Earendil ecosystem or a line-by-line Python rewrite.
- **Prefer bwrap for Linux execution.** Close the existing adapter's filesystem
  gaps before enabling tools. The owner selected an **application-managed isolated
  workspace with explicit imports** for the initial execution contract: reject
  arbitrary writable host-directory/extra-root binds; no automatic publish-back.
  This is an approved behavior change, not transparent compatibility with the old
  workspace API. No Gondolin/micro-VM requirement or Elanor/UI-framework migration.
  Consider another backend only if bwrap cannot meet the reviewed requirements
  and the owner approves a change.
- **Include the existing tracked WebUI**, despite older repository guidance saying
  it was removed. Adapt this fork's frontend/backend contracts; do not re-merge
  upstream or restore its unrelated OpenAI-compatible API server.
- **QuickJS-only Code Mode.** Python Code Mode syntax/API is an explicitly accepted
  breaking change. Migrate useful workflows, skills, examples, and restricted-worker
  semantics; no permanent Python orchestration service or Python Code Mode bridge.
- **Linux only.** Windows is explicitly out of scope, not a deferred release gate.
  Do not add portability scaffolding or native-shell fallbacks for it.
- Full means the current fork's supported capabilities and important safeguards,
  not every old file, inert setting, upstream feature, or implementation quirk.
  Any further loss/change requires an explicit recorded decision.
- Retain Telegram, Discord, Email, and programmatic WebSocket; CLI and a TypeScript
  SDK; memory/Dream; automation/goals; tools/MCP; providers; and the existing UI.
- Deliberately removed channels, WhatsApp, and the OpenAI-compatible serving API
  remain excluded. No new desktop/mobile app, cloud platform, or distributed
  multi-writer runtime is implied.
- Keep Python and production deployment unchanged during development. Separate
  test accounts/data; future paid calls, machine changes, and production cutover
  need explicit authorization. The completed bot smoke grant is not standing
  approval to poll that bot indefinitely or use live provider credentials.

**Completion:** every in-scope inventory row is implemented and verified, or has
an owner-approved replacement; migration preserves data/provenance; a canary and
rollback drill pass; operations no longer require the Python agent service.

## P0 baseline — what we actually have

- Exact Pi1.4.0 dependencies, isolated strict TypeScript package and build.
- One SQLite owner with OS-backed exclusion; atomic prototype-safe session map;
  explicit environment-variable credential references; provider/CLI scaffold.
- Tool-less runtime: explicit `tools: []` on persisted and new conversations.
- grammY1.46.0 text/private-DM Telegram transport: durable-before-offset admission,
  watches, Unicode chunks, preview edits, cancellation/reaping, separate polling
  and outbound flood gates, accepted-chunk cursors, pre-dispatch send intent,
  unknown-outcome quarantine and documented reconciliation.
- Parent offline checks cover actual Harness/storage, dedupe/reopen/ownership,
  transport recovery, and SIGKILL after mocked remote acceptance.
- A real allowlisted Telegram smoke passed with a scripted streaming model:
  one send/four edits, final reply confirmed, persisted turn/empty delivery queue
  verified on SQLite reopen, polling stopped. No paid LLM call was made.
- Execution spike exists, but realpath/check-then-use and hard-link aliasing remain
  blockers. It is not installed in the gateway. Tool replay is not yet proven.
- No real fork-provider acceptance, full feature parity, migration, or deployment.
  See [Telegram evidence](packages/pi-nanobot/TELEGRAM.md) and
  [execution limitations](packages/pi-nanobot/EXECUTION.md).

## Reuse policy: dependency first, small adapter second, copy last

For each component: inspect the public API, pinned source/examples, license,
security assumptions, lifecycle/cancellation, and version compatibility. Prefer a
supported dependency over vendoring. If adaptation is necessary, retain exact
source provenance and required MIT/Apache/third-party notices. Do not fork a whole
application to reuse one policy. Supporting Pi SDK packages are preferred when
needed; broader-org research is not an adoption backlog. The current plan uses
bwrap and the existing frontend, not Gondolin or Elanor.

Current Pi core remains coherently pinned to1.4.0. Other projects have independent
versions: select/pin compatible releases and asset hashes when adopting them;
never assume an org-wide1.4.0 release or quietly upgrade the core to `main`.

| Concern | Preferred upstream reuse | Product glue / remaining proof |
|---|---|---|
| Runtime, transcripts, queued inputs, recovery | `pi-durable` Harness/Conversation/tasks/documents/requestIds | Session routing, policy application, lifecycle/locking; no second runner/bus/receipt ledger |
| Filesystem/shell | `pi-durable/tools`: native `read`, `write`, `edit`, `bash` | Supply a genuinely confined `ExecutionEnv`; don't rewrite these four tools |
| JavaScript orchestration | `pi-durable/codemode` + `pi-codemode` QuickJS | Limits, policy, workflow migration; use the durable integration, not a fresh journal |
| Deferred tool discovery | `pi-durable/tool-search`; native Code Mode declarations/search | Namespaces, per-session exposure, enabled-tool filtering |
| MCP transport and OAuth | standalone `pi-mcp` and `pi-mcp/oauth` | Durable tool binding, private state store, guarded HTTP, server policy; legacy SSE gap below |
| Chat/vision models and credentials | `pi-ai` Models/providers, compatible endpoints and OAuth helpers | Fork aliases/presets/fallback semantics, consent and secure credential ownership |
| Images/classifiers | `pi-ai` model APIs + Code Mode integration; Durable image processing | Existing image-generation routing, media limits, usage and channel delivery |
| Compaction | native Durable compaction/tasks/settings | Retention policy, legacy history/archive and Dream are not the same feature |
| Subagents/goals/workers | owned conversations, child tasks, background anchors/reporters, inbox/abort; upstream examples | Product budgets, read-only artifact scope, reporting/commands/goal policy |
| Timers | native `sleepUntil`, task checkpoints and Harness clock | Recurrence, timezone/DST, missed-run and delivery semantics remain ours |
| State, UI updates and RPC | Chord and Durable `watch`/`watchDoc`/`watchEvents`, task graph/inspect | Authenticated product endpoints/projections; use native state/RPC facilities where suitable, no independent runtime-event bus |
| Remote files/commands/PTY | `pi-env` only if a concrete environment/remote-UI feature needs it | Reuse existing transport rather than build a protocol; not required for Code Mode and not a sandbox by itself |
| Local execution isolation | existing Linux bwrap, through native ExecutionEnv interfaces | Confine filesystem operations as well as shell; close race/hard-link gaps; no micro-VM dependency |
| Interactive terminal | `pi-tui` where useful | Thin Nanobot commands/presentation observing Durable, not another AgentSession |
| Web components | existing React frontend/components | Adapt backend contracts; no Elanor, React upgrade, or design-system migration for this port |
| Voice | preserve existing transcription behavior with reusable SDK/provider capabilities | No automatic pi-voice dependency or terminal UX migration; preserve provider/language/media limits |
| Telemetry | `pi-telemetry` schemas/contracts and native reports/usage | Redacted operational reporting; no speculative analytics service |
| Chat adapter policies | `pi-chat`, selective OpenClaw references, grammY and established channel SDKs | Reuse narrow media/rendering patterns after review; do not import their sessions/tmux/pollers/state owners |

### Important non-equivalences

1. `pi-coding-agent` ExtensionAPI / AgentSession is **not** the Durable extension
   API. Do not instantiate AgentSession/SessionManager or pi-agent-core's loop
   beside Harness. Extract/reuse public helpers or adapt a small boundary only.
2. Native tools and pi-env do not confine host access automatically. Native Code
   Mode removes direct VM capabilities, not the authority of its injected tools.
   Every nested call must pass Durable validation, policy/approval, and replay.
3. `pi-mcp`1.4.0 provides stdio and Streamable HTTP, not legacy HTTP+SSE. The
   Python config accepts SSE. Inventory real uses; use a reviewed existing
   compatibility layer or an explicitly approved endpoint migration. Do not
   silently drop support or write a new MCP protocol stack by default.
4. Nested tool results are not a permanent bulk-evidence archive: Durable keeps
   nested results through the caller's lifetime and small task receipts afterward.
   Preserve worker evidence/large artifacts explicitly where the product needs it.
5. bwrap confines only operations actually performed inside its namespaces. A
   sandboxed bash tool does not fix host-side Node filesystem check-then-use races
   or external hard-link aliases. Close those boundaries without assuming that
   another SDK package, or even a VM, makes shared host storage automatically safe.
6. Existing WebUI inclusion is not a request for a new UI framework. Elanor was
   researched but dropped from the implementation plan; keep the current frontend
   and React version unless a separate concrete requirement justifies a change.
7. pi-chat demonstrates relevant Discord/Telegram/media patterns but runs Pi
   sessions with tmux orchestration and documents open outbound HTTP/TLS by
   default. Neither ownership nor that network default belongs in this port.
8. Do not add Absurd/Postgres or replace native Code Mode with dquickts merely
   because they are in the org. A second durability engine or scripting VM adds
   an unjustified migration. Revisit only for a concrete unmet requirement.

## Product parity map

This is the initial source-backed inventory. Before each subsystem is implemented,
expand its row into concrete config keys, CLI/wire/tool contracts, consumers,
Python reference checks and accepted differences. Track semantic behavior, not LOC.

| Area / current reference | Milestones | Required behavior |
|---|---|---|
| `config/`, `cli/`, `nanobot.py` | P3/P8 | Explicit config, aliases/defaults, onboarding/status, streaming CLI, TypeScript SDK lifecycle/hooks/concurrency; clear Python SDK migration guide |
| `agent/context.py`, templates, skills | P3/P4 | Identity/SOUL/USER/MEMORY instructions, bounded retrieval, disabled skills, trusted discovery, correct prompt/tool visibility |
| `agent/loop.py`, `runner.py`, hooks, `session/` | P2–P5 | Native runtime replacement with preserved stop/abort/steer/follow-up, failure verification, model/context policy, history/compaction/recovery invariants |
| filesystem/shell/apply_patch/search/exec sessions | P1/P2/P6 | Confined native operations; preserve needed patch/search/document-extraction/background-exec capabilities with thin adapters where native tools don't cover them |
| web/search/MCP/OAuth/policy/approval/ask-user | P1/P2/P6 | SSRF/redirect/DNS controls, structured errors/results, scoped approvals and human interaction, cancellation and honest external-effect outcomes |
| Code Mode/artifacts/read-only workers | P2/P5 | QuickJS replacement, bounded results, selected-artifact-only workers, one-shot ask, shared budgets/capacity, failure evidence and no usage double count |
| memory tools/store/usage/archive/Dream | P4 | Search/read/write/ranking, provenance, archive deltas, TTL/retention, rollback/diff limits, dedupe cursor and restore/log |
| cron/heartbeat/triggers/standing intents/goals | P5 | Schedules, recurrence, bound-session turns and notifications, usage and restart-safe ownership; stale triggers/cancel semantics |
| retained channels/notification routes/pairing | P3/P6 | Admission/auth/revocation, channel session keys, delivery/retry/media/reactions/history, explicit scopes |
| providers/image-generation/transcription | P3/P6/P8 | Native provider reuse plus fork aliases, compatible endpoints, auth, streaming/tools/vision, fallback and model-specific quirks |
| `command/builtin.py`, router | P3–P7 | Full current command inventory, task/action inspection and approvals; not only a chat prompt loop |
| CLI apps / `self.py` / skills marketplace | P6/P7 | Existing scoped capability and privileged owner workflows; preserve protections, no arbitrary remote package installation by default |
| `webui/`, `nanobot/webui/` helpers | P7 | Existing frontend experience over one owner: chats/workspaces/forks, settings, automation, media, task/tool activity and remote-host controls |
| security, runtime inspection, deployment | P1/P8/P9 | Secret separation, owner exclusion, redacted diagnostics, backups, schema changes, Linux packaging and real rollback |

## P1 — close trust and durability gaps first

- [ ] Finish a **bwrap-backed native ExecutionEnv** design/proof, starting with
  the existing spike. Ensure filesystem operations, not just bash, cross the
  confinement boundary. Evaluate applicable native environment/transport helpers
  before writing custom machinery; pi-env is an option only if it simplifies
  that concrete boundary. Do not make micro-VM/Elanor feasibility prerequisites.
- [ ] Validate the configured bwrap executable, namespace setup, sanitized env,
  allowed mounts, process/resource limits and target-server feasibility. No
  unsandboxed fallback, inherited credentials, or host-network escape. Host package
  installation or server changes still require explicit authorization.
- [ ] Prove traversal, missing-leaf, rename, symlink-race and hard-link invariants
  for **every** read/write/list/spill/temp/cwd path. Use the owner-approved managed
  workspace contract: secure creation/reopen/provenance, explicit alias-free imports,
  and documented lifetime/persistence. Reject arbitrary writable host/extra roots;
  do not auto-copy/import/publish or overwrite host edits. A permission bit, marker
  or one-time hard-link scan alone does not prove isolation. Never mount credentials
  or the Durable data root.
- [ ] Prove sandbox/process-group teardown, timeout and cancellation, bounded resource
  use and absence of post-return work. No unsafe host/native fallback. Preserve
  per-file serialization and environment identity through upstream tools.
- [ ] Design allow/deny/ask policy and exact-call approval decisions on native
  tasks/documents/hooks, with authenticated approvers, expiry, revocation and
  request-bound resources/arguments/cwd. Prove the chosen durable wait mechanism
  before broadening capabilities; a pending approval must not become permission
  after reopen or for a different nested call.
- [ ] Enforce HTTP target validation including redirects, IPv4/IPv6 private ranges,
  metadata and DNS/connect-time rebinding. Preserve the existing SSRF semantics
  through guarded **host-side** web/search/MCP/OAuth/media requests; use mature
  networking facilities where available. Explicit narrow exceptions, not a global
  disable switch. Shell network remains isolated; approved host integrations do
  not grant generated code arbitrary network or credential access.
- [x] Establish reviewed WAL/FULL startup policy through the supported native
  adapter, verify it before/after initialization on the actual connection and
  fail closed on mismatch. Integrated `2d5af1adf`; source review plus parent
  crash/reopen/fault-injection probes passed. As with Python fsync, physical
  power/host-loss guarantees still depend on the actual storage stack; neither
  SIGKILL nor pragma readback establishes host-failure-safe send intent.
- [ ] Check snapshot/backup restore, schema/version failures, disk-full/storage
  errors and owner-lock recovery. Close failure must not start a second writer.

**Exit:** reviewed confinement/permission/storage decision plus bounded adversarial
and crash evidence. Unsafe tools remain off until their applicable boundary passes.
If the preferred upstream stack cannot satisfy it, record the gap and choose an
established equivalent or stop; do not accumulate hopeful wrappers.

## P2 — native tools and Code Mode, not a translated runner

- [ ] Register native CodingTools through the approved environment and narrow
  conversation policies. Map needed legacy names/contracts in prompts/consumers;
  prefer native names rather than a permanent alias for every Python tool.
- [ ] Audit the other Pi tool/resource helpers before porting remaining tool
  implementations: file search/listing/patching, skill/prompt parsing, truncation,
  image handling and result rendering. Reuse compatible public factories;
  adapt operations through the approved environment, never call a raw host-FS
  tool implementation in a way that bypasses Durable hooks or confinement.
- [x] Implement an opt-in SDK bundle of `pi-durable/codemode`, native
  CodemodeSandbox and tool-search. Reuse native journal/store/fork, declarations,
  nested keys, progress/error channels; no custom worker/replay store. Reviewed
  and parent-built probes pass; gateway deliberately does not install it.
- [x] Enforce Code Mode QuickJS-heap/deadline/output/concurrency budgets; hold
  capacity until actual worker exit. No direct recursive Code Mode or host globals;
  hard caps are host-owned. Heap cap is not Node/process RSS or P1 OS quotas.
- [ ] Integrate the bundle into the gateway only after applicable P1 policy,
  environment/approval boundaries and product lifecycle review pass. Establish
  native default-deny state and revoke persisted grants before scheduling.
- [ ] Bind standalone pi-mcp discovery/calls and OAuth to Durable tools. Preserve
  isError, structured content, progress and cancellation; schemas and exposure
  must agree. Keep explicit server/tool allowlists, scoped stdio environments,
  trusted lifecycle and private OAuth state. Resolve the legacy-SSE gap explicitly.
- [ ] Adapt existing failure-verification semantics through native hooks/results:
  caught/discarded nested failures or partial workers cannot become false success.
  Respect native bash's nonzero-exit structured-result semantics.
- [ ] SIGKILL/reopen actual safe and unsafe calls, including nested Code Mode
  calls: reuse completed results, never automatically repeat unsafe/unknown
  effects, fail clearly on incompatible code/sandbox fingerprints or definitions.
  Admission requestId dedupe is not external side-effect exactly-once. Completed,
  interrupted-safe and interrupted-unsafe synthetic nested calls now pass actual
  parent SIGKILL/reopen; real coding tools and incompatible fingerprint/definition
  cases remain pending (`CODEMODE.md`).

**Exit:** an actual coding task plus restart/cancel/approval cases with proven tool
policy and no duplicate effects; migrated Python Code Mode workflows demonstrated
in QuickJS. No filesystem/bash implementation fork merely for naming compatibility.

## P3 — an everyday assistant vertical slice

- [ ] Verify one explicitly authorized real fork provider first (e.g. OpenCode
  Zen or Umans), with streaming, cancellation, error redaction and accounting.
  The faux-model Telegram smoke is not this acceptance check.
- [ ] Port model presets/thinking and allowed-model selection. Reapply host
  security on startup without accidentally resetting user model/workspace choices.
  Use pi-ai retries/errors; add fallback policy only where the fork needs it.
- [ ] Load existing identity/templates/basic memory/skills via native sections and
  reusable Pi resource helpers where compatible. Template conversion and tool
  names must be explicit; no unsafe automatic extension-code discovery.
- [ ] Implement `/help`, `/status`, `/new`, `/history`, `/model`, `/compact`,
  `/stop`, `/abort`, owner-authorized `/restart`, `/steer`, `/after`, `/interrupt`,
  `/btw`, `/skill` and relevant
  `/policy`/`/receipt` surfaces on native state, with correct owner/session scope.
  `/new` preserves archive/usage semantics; `/abort` also handles sustained work.
- [ ] Finish interactive CLI, onboarding/config validation, status/health and
  TypeScript SDK run/stream/hooks/cancellation/lifecycle. Reuse pi-tui components
  only when needed; neither UI nor SDK opens a competing store behind the gateway.
- [ ] Integrate pairing and revocation before broadening Telegram beyond the
  explicit current private-DM allowlist. Keep existing send-intent/recovery rules.

**Exit:** owner can use a private test account for a real everyday task, change
models, interrupt/continue, compact/new and reopen without losing identity/state.
This is a useful pilot milestone, not permission to cut over every surface.

## P4 — memory, context, Dream and usage fidelity

- [ ] Preserve MEMORY/SOUL/USER/topic files and read/write/search/ranking behavior,
  source provenance and context budgets. Keep memory/deliveries session-scoped.
- [ ] Reuse native manual/background/overflow compaction, retain source transcript,
  and port TTL/retrieval/history-visibility policy without parallel summarizers.
- [ ] Preserve `history.jsonl` compatibility and per-session **delta** usage since
  last archive, including `/new`, failed attempts, compaction, children and tools.
  Use native usage as truth with archive cursors/projections; don't double-count
  nested spend or invent zero usage for unknown cancelled remote requests.
- [ ] Port single-phase Dream as product tasks with independent model/batch/
  iteration/timeout/file/diff limits. Execute against isolated candidate memory
  state; use reviewed staging/snapshots with conflict detection and byte-for-byte
  rollback (creation/deletion included). Native DB commits do not atomically
  commit external memory files.
- [ ] Preserve Dream history cursor/dedupe, success-only publication/commit,
  `/dream`, `/dream-log`, `/dream-restore` and `/remember`; prove timeout,
  exception, budget/diff failures and interrupted publication cannot lose memory
  or overwrite concurrent owner changes. Recovery of file transactions is part
  of this gate, not an assumed property of a Git worktree.

**Exit:** known histories conserve archived/active usage, compaction leaves original
history available, and failed/interrupted Dream returns the required original data.

## P5 — durable automation and bounded delegation

- [ ] Reuse foreground/background owned conversations and anchor/reporter examples.
  Add product spawn/message/wait/stop/list/retry semantics, model presets, no
  unauthorized child delegation, task inspection and owner-bound action evidence.
- [ ] Port artifact-only read-only workers and one-call `ask` to QuickJS/native
  tasks. Preserve selected-input scope (no parent transcript/host file access),
  evidence provenance, discarded/caught failures, partial outcomes, shared
  admission/budgets/deadlines/cancellation, and exact-once usage attribution.
- [ ] Preserve standing intents, waiting runs, sustained-goal state/budgets and
  explicit stop/abort semantics; use task graph/inspect and native inbox rather
  than build a parallel job/run engine. Persist only missing product metadata.
- [ ] Build recurrence policy on `sleepUntil` with a mature calendar implementation:
  once/interval/cron, IANA timezones/DST, missed/overlapping occurrences, edits/
  removal, execution identity, bound-session delivery, retries and usage.
- [ ] Port heartbeat and automatic Dream scheduling as the same durable task
  model. Prevent recursive automation, stale trigger firing, duplicate external
  notifications and jobs escaping cancellation/owner shutdown.
- [ ] Implement `/goal`, `/tasks`, `/task`, `/pairing`, complete `/policy` and
  `/receipt`; expose parked/blocked/unknown states honestly instead of guessing
  success. Historical task results need more than the live-only task graph.

**Exit:** restart during sleeps, child work, report delivery and scheduled turns
preserves exactly the intended work/ownership. Concurrent workers cannot starve
parents or exceed budgets; schedule changes/cancellation do not revive old jobs.

## P6 — channels, media and remaining tools

- [ ] Telegram parity beyond the spike: approved group/thread/mention policy,
  reply targets, files/photos/audio/voice, typing/reactions and message/history
  tools as currently supported. Pairing and ACL changes apply on recovery too.
- [ ] Port Discord, Email and programmatic WebSocket one at a time using mature
  clients and the same Durable admission/watch boundary. Preserve session keys,
  notification routes, account scopes and channel-specific cancellation/rates.
- [ ] Port transcription and image generation with native pi-ai/image support
  wherever possible, without adopting a separate voice extension/terminal UX.
  Preserve configured providers, languages, limits, vision handoff/image
  budgets, caching/provenance and honest unsupported-input behavior.
- [ ] Complete safe web/search, structured human questions, reactions/messages,
  patch/search/list/document extraction (PDF/Office), background exec/session
  controls, CLI apps and owner-scoped self-modification workflows. Reuse native
  operations/output/inspection; add only capabilities the inventory still needs.
- [ ] Preserve skills discovery/installation/marketplace, plugin extension points
  and explicit trust. Python entry-point plugins do not run unchanged in a TS
  runtime; publish the replacement contract/migration, not a second plugin framework.
- [ ] Verify fetch/download/upload bounds, safe media roots, SSRF and preview
  policy; no accidental credentials/reasoning/host-path exposure. Classify each
  non-idempotent external operation, record intent where required, hold ambiguous
  results, and never promise exactly-once Telegram/SMTP/media delivery.

**Exit:** each retained channel and capability has evidence against its inventory,
including media/revocation/restart/error cases. A working Telegram adapter does
not stand in for Discord, Email, or real voice-note transcription acceptance.

## P7 — existing WebUI on a single gateway

- [ ] Inventory actual frontend contracts and reachable backend behavior; separate
  inert leftovers from supported UI features. Reconcile stale project guidance
  with the owner's WebUI decision before assigning UI implementation. Use the
  existing React/Vite app, components and tests. No concurrent Python/TS edits
  to the same frontend.
- [ ] Supply an authenticated local-first HTTP/WebSocket boundary into the one
  gateway owner. Reuse Chord/native watch machinery where suitable; thin
  permission-checked projections, not a second server-side session/event store.
  Declare wire versions and reconnect snapshot/backpressure behavior.
- [ ] Deliver chat/streaming/tool+nested-task activity, cancel/steer/queue controls,
  history pagination/search, session lists, forks, temporary chats and workspaces.
  Authorize every session/artifact/file/task operation, not only the handshake.
- [ ] Port settings/model/provider/preset configuration, pairing/policy requests,
  skills/MCP/OAuth/apps, memory/Dream, automation/calendar, usage and task views.
  Preserve current attachments/voice/images, file/diff/web previews, shortcuts,
  localization, remote-host/pairing controls and workspace behavior where supported.
- [ ] Retain existing frontend components, styling, React version and Nanobot
  branding. No design-system evaluation/migration is needed to replace the
  backend; UI changes should serve concrete missing product behavior.
- [ ] Reuse pi-env SSH/host-key/PTY mechanisms for applicable existing remote
  controls after explicit owner trust. Never silently accept host keys, deploy a
  remote daemon, expose localhost previews or install remote packages.
- [ ] Ensure settings updates apply through explicit host configuration/registry
  boundaries, preserve secret references, and cannot bypass runtime security or
  switch a conversation to an unconfined cwd/environment.

**Exit:** existing UI workflows operate through Durable, survive reconnect/server
restart with correct final/history/tool state, and pass existing applicable frontend
checks. No OpenAI-compatible serving API or upstream plugin runtime is restored.

## P8 — provider completeness and migration rehearsal

- [ ] Finish the source-backed provider matrix: `custom`, `anthropic`, `openai`,
  `openrouter`, `openai_codex`, `deepseek`, `zhipu`, `zai`, `dashscope`, `moonshot`,
  `minimax`, `minimax_anthropic`, `xiaomi_mimo`, `umans`, `opencode_zen`,
  `opencode_go`; dynamic/custom entries, OAuth and chosen API families included.
  Use native adapters/compatible endpoints first. Verify reasoning/tool/vision
  shapes, fallback, image quirks, error classification and spend. Live validation
  needs credentials/consent; unverified entries stay unverified, not silently passed.
- [ ] Freeze a precise legacy schema/feature inventory and create an explicit
  dry-run importer for config/presets, sessions/history/compaction boundaries,
  usage/archive cursors, memory/Dream metadata, pairing/routes, skills, media
  references and cron/goal/task metadata. Never mutate original source data.
- [ ] Preserve timestamps, original IDs/lineage, checksums and a versioned import
  manifest/checkpoint. Re-running or interrupting import must not duplicate turns,
  spend or schedules; write into a new private destination and report unsupported
  records/settings rather than silently normalizing them away.
- [ ] Historical tools/results are history, not pending runnable tool calls.
  Legacy active/unknown actions, jobs, approvals and goals need explicit review/
  reconciliation; don't auto-resume Python checkpoints as if they were native tasks.
  Missing/truncated source evidence remains explicitly incomplete.
- [ ] Reconcile record/attachment counts, usage totals/deltas, memory bytes,
  session lookup and sample transcript/context rendering. Prove backup/restore,
  importer failure/re-run, native schema migration and paused automation handling.
- [ ] Produce migration guides for Python SDK/plugins, config/secret references,
  tool names/templates/skills, Python→QuickJS scripts and Linux deployment.
  Export/readability of the legacy archive is not a substitute for import parity.

**Exit:** rehearsed idempotent migration on representative private copies with
reconciliation reports and no live side effects or shared-writer assumptions.

## P9 — production release and safe retirement

- [ ] Build/install from the lockfile on a clean Linux environment; include all
  Code Mode WASM/worker/image-processing assets and any explicitly selected daemon
  assets. No VM image or hypervisor is required by the bwrap plan.
  Verify supported Node version, system requirements, service startup/shutdown,
  bounded logs, diagnostics/readiness, resource limits and backup/restore runbook.
- [ ] Run an owner-approved canary on dedicated credentials/accounts or replayed
  inputs with side effects disabled, isolated storage and reconciled expected
  behavior. Never run Python and TS getUpdates consumers on the same bot token,
  share a writable store, or execute real side effects twice for a comparison.
- [ ] Compare correctness, latency, memory, token/spend and recovery/maintenance
  costs; fix regressions. Agree a concrete soak workload/window and rollback
  thresholds, not an arbitrary promise of a multi-day rewrite.
- [ ] Freeze legacy writers/schedules, take verified backups, perform final import,
  reconcile pending/unknown work, then switch one external account at a time.
  Do not enable the same cron job or outbound route in both runtimes.
- [ ] Rehearse rollback **after** TS has accepted new turns/usage/memory/job changes.
  A stale pre-cutover Python backup loses those changes; provide a verified
  reverse/export/reconciliation path or pause and recover them before switching.
  Unknown external outcomes stay held, never auto-replayed by rollback.
- [ ] Only with owner approval: integrate/push/deploy, update the `uhl` service and
  operator docs, and retire Python as the live agent. Keep a tagged readable
  reference and backups through the agreed recovery window; don't delete the
  source/worktrees or stop production processes as a planning side effect.

**Exit:** accepted full parity/differences ledger, canary and rollback evidence,
runbook, recoverable data and explicit owner cutover sign-off.

## Execution order and next bounded batch

Critical path: **P1 → P2 → P3 pilot**, then P4/P5/P6 completion, P7 product UI,
P8 reconciliation, P9 cutover. Provider work starts at P3 and continues through P8.
After P1 establishes policy/state contracts, read-only UI/protocol and importer
inventory work can proceed independently; don't wait for every channel before
showing a UI, and don't enable tools to unblock unrelated UI progress.

The next batch should be small enough to review independently:

1. bwrap/native ExecutionEnv completion: all filesystem and shell paths inside the
   reviewed boundary, race/hard-link policy, sanitized environment and bounded
   teardown; separately check SQLite host-failure durability. Native environment
   helpers only where useful; no micro-VM or UI-framework side project.
2. Native tool/Code Mode integration design and offline replay proof, initially
   inert or limited to approved synthetic capabilities until P1 passes. Include
   pi-mcp/OAuth/SSE compatibility and nested approval/failure semantics.
3. Product inventory: frontend command/wire/config contracts plus a concrete
   feature/difference ledger. Establish the minimal real-provider pilot spec;
   no automatic paid call or secret sharing with workers.

Do not start a giant parallel rewrite. Parent owns design/gates/integration;
implementation workers get bounded disjoint committed-base worktrees; independent
read-only review and parent verification precede integration. Use native Herdr
socket tools only, with explicit provider/model selection before a future batch.
No delegation or new implementation worker was launched for this roadmap.

## Verification and scope discipline

- Reuse existing Python/frontend checks as semantic references and upstream
  examples/conformance facilities; bounded private runtime probes for new paths.
  New committed test suites/scaffolding require explicit owner request.
- Each result records source/version, exact command, observed invariant, bounds,
  failures/fixes and what remains unverified. A model saying “passed” or a UI
  screenshot alone is not acceptance; inspect committed state too.
- Temporary probes/artifacts must not disappear as the only provenance: record
  essential procedure/outcomes in the milestone log. Do not commit user secrets,
  transcripts or private migration fixtures. Bound memory/time, including worker
  processes; existing Python checks use uv and the capped runner.
- Review every native API for actual behavior. For example, custom documents use
  `watchDoc`/`documentState`; the live smoke helper incorrectly assumed they were
  in the structural view, so its auto-pass detector was not authoritative.
- No new runner, transport queue framework, receipt database, scheduler engine or
  omnibus plugin SDK merely to mirror old classes. Native commit/task ownership
  first; small product state where a concrete feature actually requires it.
- Unknown delivery/provider spend is unknown, not success or zero. Process-crash
  proofs do not imply host-power durability; shell isolation does not imply safe
  host-side filesystem operations; task recovery does not make arbitrary I/O transactional.
- Do not publish dates/LOC savings as facts. Estimate each bounded slice after
  evidence, with security, provider access, UI compatibility and data migration
  uncertainty visible. Full port is substantially more than translating a loop.

## Sources and provenance

**Pinned source of truth for existing Pi APIs:** local Pi tag `v1.4.0`, commit
`4a080252f06caf63a525d7873c5d94d3c23887e0`, shared read-only checkout
`/tmp/pi-durable-reference-1.4.0`; installed Pi1.4.0 docs/packages. Read Durable's
README/tools/examples, Code Mode docs, standalone pi-mcp docs, and pi-env
README/protocol/semantics from that same Git tree. Python references above are this
checkout; `webui/package.json` declares React18.3.1.

Broader-org review on2026-10-26 used public main-branch documentation, not verified
release integrations. The owner subsequently narrowed the preference to the Pi SDK:
Gondolin/Elanor/pi-voice links below are historical research, not adoption tasks.
Pin any actually chosen releases/source commits and audit licenses before
implementation; these links are research provenance, not build inputs:

- [Pi repository / package catalog](https://github.com/earendil-works/pi)
- [Durable at v1.4.0](https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable)
- [Native Code Mode](https://github.com/earendil-works/pi/tree/v1.4.0/packages/codemode)
- [pi-mcp](https://github.com/earendil-works/pi/tree/v1.4.0/packages/mcp)
- [pi-env](https://github.com/earendil-works/pi/tree/v1.4.0/packages/env)
- [Earendil repository catalog](https://github.com/orgs/earendil-works/repositories?type=all)
- [Gondolin README](https://github.com/earendil-works/gondolin)
- [Gondolin security](https://earendil-works.github.io/gondolin/security/)
- [Gondolin limitations](https://earendil-works.github.io/gondolin/limitations/)
- [Gondolin SDK](https://earendil-works.github.io/gondolin/sdk/)
- [Elanor design system](https://github.com/earendil-works/elanor)
- [Elanor React requirements](https://github.com/earendil-works/elanor/tree/main/packages/react)
- [pi-chat](https://github.com/earendil-works/pi-chat)
- [pi-voice](https://github.com/earendil-works/pi-voice)

## Log

### 2026-10-26 — roadmap and scope decisions

Owner requested a comprehensive full port, reuse of native Pi Code Mode/tools and
wider Earendil dependencies. Clarified existing WebUI inclusion, QuickJS-only
scripting, and no Windows requirement. Inspected actual tracked product surfaces
and fork worker safeguards, rather than rely on stale “WebUI removed” guidance.

Established P0 evidence and P1–P9 deliverables/exits, upstream-first reuse map,
parity inventory, explicit SSE/React/security/storage gaps, migration/rollback
requirements and next bounded batch. Brave search was initially unconfigured;
owner configured it, then public Pi/org/Gondolin/Elanor/pi-chat/pi-voice docs were
reviewed. Broader dependencies remain researched candidates; no package, VM asset,
server, Python source, production setting or live credential was changed. This
planning work launches no new workers and does not authorize deployment.

### 2026-10-26 — narrowed to Pi SDK-first, bwrap preferred

Owner clarified that “their stack” primarily means the Pi SDK, not the whole
Earendil ecosystem; bwrap is preferred if workable. Removed Gondolin/Elanor
feasibility work and the implied React/design-system migration from the active
plan. Kept native Durable tools/Code Mode/tasks/compaction, supporting Pi packages
when needed, and the existing frontend. pi-env is conditional on a concrete
execution/remote transport need, not a new runtime requirement. The execution
gate is unchanged: sandboxed bash alone cannot justify host-side filesystem race
or hard-link exposure. No implementation, dependency or deployment change.

### 2026-10-26 — implementation batch launched

Owner requested Codex Luna xhigh workers to begin implementation. Verified clean
parent at0ea2c76eb, HERDR_ENV=1, and read native wrapper guide at
`/home/gergo/dotfiles/docs/herdr-socket.md` (older linked paths no longer exist).
Launched the three disjoint workers recorded above using herdr_spawn with explicit
committed base/model/thinking; all acknowledged startup/working. One initial
metadata inspection recorded exact pane/workspace/worktree identities; no polling
loop or terminal/CLI fallback. Existing prior resources retained untouched.

Sent manifest/direct-dependency coordination to B1/B2 via herdr_send. Await explicit
reports, handle exact permission requests within scope, review/integrate and run
independent checks before claiming any gate. No initial proof of race/hard-link,
tool replay, or host-power durability is inferred from startup. No production or
live-secret changes authorized by this batch.

### 2026-10-26 — managed workspace decision for execution

B1 explicitly reported the remaining hard-link boundary: ordinary writable bind
mounts cannot prevent outside-inode alias effects even with all FS operations
inside bwrap. Before implementation, parent asked the owner to choose isolated
copies/publication, managed workspace, or continued tool disablement. Owner chose
**Managed workspace**: application-owned isolated storage, explicit imports,
reject arbitrary writable host roots, no automatic publish-back. Sent the exact
choice/boundaries through herdr_send; worker may adjust its standalone API within
ownership, but gateway/config/tool enabling remain untouched. Secure provenance,
import/reopen semantics and adversarial evidence are still required; this is not
a completed security proof. B2/B3 continue independently.

### 2026-10-26 — SQLite candidate and parent verification

B3 explicitly completed as `e8269c65054cacdb37052ba0c31f104b761d9b89`, clean
worker branch `pi-72ce3be3`; owned storage/runtime/STORAGE.md changes only. Parent
reviewed the native NodeSqliteDatabase queue/connection and SqliteStorage.open
migration/ownership paths. Candidate upgrades the native opener's NORMAL to FULL,
checks WAL/2 before and after native migrations, and gives that same adapter to
storage; no second connection or tool activation.

Parent reran `/tmp/pi-nanobot-storage-probe.mjs` with 70-second timeout and 512-MB
Node heap: actual WAL/FULL reads, requestId/session reuse, owner exclusion, real
subprocess SIGKILL/reopen with two retained entries, injected setup failure and
successful reopen all passed. Parent separately wrote and ran
`/tmp/pi-nanobot-parent-storage-failclosed.mjs` (45 seconds/256 MB): injected
before/after initialization journal/synchronous mismatches, read failure and
migration failure all reject, close adapter and permit clean lock/database reopen.
Pre-check failures never reach migrations. Real non-WAL `:memory:` is rejected.
These are private probes, not a committed test suite; mismatch/fault injections
are not real VFS/disk-full or power-loss tests. No paid/live calls or credentials.

Launched read-only reviewer `pi-7e58645f`, pane `w1P:p5`, same Luna/xhigh, scoped to
this committed candidate and native SQLite implementation. Expected report
`/tmp/pi-storage-full-review.md`; await explicit completion before integration.
B1/B2 remain outstanding, tools disabled. This does not close the full storage
backup/restore/disk-full/schema/host-loss acceptance gate.

### 2026-10-26 — SQLite policy integrated and reverified

Reviewer `pi-7e58645f` explicitly reported PASS with no blocker;
`/tmp/pi-storage-full-review.md` traces same-connection/native migration/queue,
cleanup, owner lock and unchanged tool-less policy. Parent cherry-picked B3 as
`2d5af1adf` after clean-status check. Package typecheck/build and diff check pass.

Parent reran probes against the **parent checkout's built runtime**, not only
worker artifacts: `/tmp/pi-nanobot-parent-storage-crash.mjs` (70s/512 MB; adaptation
of worker probe with explicit parent imports) passes actual SIGKILL/reopen,
WAL/FULL, owner exclusion, dedupe and setup-failure cleanup. Parent's independently
written `/tmp/pi-nanobot-parent-storage-failclosed.mjs` (45s/256 MB), selected with
`PI_STORAGE_CANDIDATE=/home/gergo/projects/pi-nanobot/packages/pi-nanobot`, passes
all six failure scenarios and real non-WAL rejection. No paid/live requests.

B3's bounded policy task is accepted. Backups/restores, real disk-full/VFS/schema
faults, close failure and physical-host-loss acceptance remain separate unfinished
work; P1 as a whole stays unchecked. README now describes the active FULL policy.
Execution/Code Mode workers remain outstanding; tools still disabled, no production
change, push or cleanup.

### 2026-10-26 — Code Mode candidate and independent parent probes

B2 explicitly completed clean branch `pi-9dd12539` as `eb900a862`, owning only
`src/extensions/codemode.ts` and CODEMODE.md. Opt-in native extension/tool-search
bundle: fixed QuickJS heap, source-clamped journaled deadlines/output, shared
worker reservations held until exit, combined caller/shutdown cancellation, and
host close/drain. No gateway/config/execution changes or tool activation.

Reassigned completed read-only reviewer `pi-7e58645f`/`w1P:p5` via herdr_send to
this candidate/native lifecycle/source/context boundary, with report target
`/tmp/pi-codemode-bundle-review.md`. Await explicit report, not idle notice.
Asked sole manifest owner B1 for a separate direct pi-codemode1.4.0 declaration
commit when practical; parent has not edited its manifest ownership or integrated
an undeclared direct import. Candidate compilation/probes currently use the exact
transitive installation.

Parent inspected native source parsing, worker reservation/exit, native durable
run/journal and combined Chord cancellation. Ran candidate local Harness/QuickJS
probe with expected boundary/capacity results. Parent independently wrote and ran
`/tmp/pi-nanobot-parent-codemode-edges.mjs` (65s/512 MB): no host globals/recursion,
CRLF and oversized budgets persisted clamped, malformed options never execute,
missing required nested argument denied before execute, real QuickJS OOM and CPU
loop timeout, caller abort without host shutdown, shutdown abort without caller
abort, worker close drain/idempotence and admission rejection on a fresh Harness
after close all pass. Corrected initial probe assumptions: native task docs retire
on completion (inspect live run), and native validation intentionally coerces
scalar values (use a genuinely missing field to verify rejection). No product
change was needed for these probe fixes.

Parent also wrote `/tmp/pi-nanobot-parent-codemode-replay.mjs` and companion
`...-replay-child.mjs` (110s controller/256-MB heap; children 512 MB). Actual
subprocess SIGKILL/SQLite reopen for both unsafe and safe interrupted synthetic
calls passes: completed effect executes once; unsafe interruption surfaces native
unknown/partial-run error without rerun; explicitly replay-safe call runs again
and completes using the fixture's genuine fixed-key idempotency. RequestId remains
stable. The fixture, not Durable, supplies effect idempotency; no exactly-once
external-effect claim. These runs import candidate built artifacts; repeat on
parent after reviewed integration. No live/paid calls, production changes or
committed tests. Caught/discarded failures and structured nonzero-success policy
still need later product hooks; B2/P2 and P1 are not globally accepted.

### 2026-10-26 — Code Mode default-selection review blocker

Reviewer `pi-7e58645f` explicitly reported bounded core adapter PASS but a
**documentation/integration blocker** in `/tmp/pi-codemode-bundle-review.md`:
installing extensions in a default native registry makes them defaults for
conversations without explicit restrictive selection/tools. Selecting extensions
on A does not deny B. The sample also did not bind/include its named tool handles.
This is not exposure in the current gateway, which never installs the bundle and
reapplies tools:[] before resume. Candidate remains unintegrated.

Parent sent B2 a bounded follow-up via herdr_send: supported native default-deny
host setup, real registration bindings/allowlists, explicit distinction between
constructor and registry installation and between tools/modelTools, persisted
policy revocation before resume, plus private actual-Harness A-enabled/B-disabled
and reopen evidence. No new abstraction/API change unless needed, no manifest or
gateway edits. Await explicit follow-up commit/report, then re-review; do not
substitute passed sandbox/replay probes for this activation-policy gate.

### 2026-10-26 — opt-in documentation follow-up; fixture correction pending

B2 explicitly reported `da5a2392c774b5077db959df05ca4759e8c94121`, docs only,
with concrete native defaults, actual tool bindings and persisted-grant revocation.
Parent read the full follow-up and private verify-optin.mjs before acceptance.
Found a proof bug: fixture nests conversationCreated inside settings, where native
HarnessSettings ignores it; actual callback belongs on HarnessOptions (the doc
snippet places it correctly). So reported probe success does not yet establish
creation-hook behavior. Parent requested corrected initial/reopen options,
asserted hook invocation and a fork-of-enabled-A denial check; no module rewrite
or unnecessary commit. Await explicit corrected evidence, then reviewer re-check
and dependency declaration. Neither follow-up is integrated yet.

### 2026-10-26 — corrected opt-in/fork proof passes parent run

B2 explicitly reported corrected fixture plus docs evidence commit `711ba19f7`.
Parent read it and reran it successfully (65s/512 MB): actual top-level creation
callback runs five times, clears inherited enabled-A fork grants before resolution,
and never runs just for reopening existing IDs. A runs one synthetic effect;
forged fork/B calls and modelTools-only missing nested tool remain denied;
persisted C requires explicit revoke before resume.

Sent final candidate chain eb900a862/da5a2392c/711ba19f7 to the same read-only
reviewer for explicit blocker-resolution re-review. Parent also created separate
private `/tmp/pi-nanobot-parent-codemode-local.mjs` and `...-optin.mjs` adaptations,
using explicit selectable **built** artifact/SDK imports (no shared probe edits),
and ran both with 65-second/512-MB bounds. Both exit0 and pass boundary/capacity,
store/fork, nested errors, and corrected opt-in assertions against candidate.
`PI_CODEMODE_CANDIDATE` can select the parent package after integration. Await
final review and manifest-owner dependency commit; no gateway activation.

### 2026-10-26 — partial execution withheld; direct dependency integrated

B1 explicitly reported **blocked**, not complete: `6ab2ccc89` moves native pi-env
filesystem daemon inside outer bwrap and uses nested bwrap for shell, but still
binds arbitrary writable host roots. Its own synthetic external hard-link sentinel
changes, so inode isolation fails; CPU/memory/process-count quotas are missing.
Parent has not integrated this execution/pi-env candidate or accepted P1. This
partial does not satisfy the owner-approved managed workspace contract.

A single recovery inspection could not capture recent output because the worker
was working; no polling retry, CLI/terminal fallback or replacement worker.
Parent reconciled current owner instructions via wrapper; worker explicitly
acknowledged continuing with app-created storage/copy-only imports, no arbitrary
writable roots or automatic publication. Nested bwrap is no longer its blocker.
A transport acknowledgement alone was never taken as proof earlier follow-ups
had been processed. Await bounded managed follow-up/security evidence.

B1 separately supplied `c491bac5940a5824fdc97fbe8af3f245dda0d64a`, exactly two
manifest/lock declarations for direct pi-codemode1.4.0. Parent reviewed the diff,
cherry-picked with provenance as `be2453c84` (without partial execution/pi-env),
and clean-installed with scripts ignored: 100 packages added/101 audited, zero
reported vulnerabilities. Package typecheck/build and diff check pass. Sent B1
confirmation that dependency requests are satisfied; no duplicate manifest work.
Code Mode module/docs remain unintegrated pending explicit final re-review.

### 2026-10-26 — opt-in Code Mode SDK integrated and parent-reverified

Reviewer `pi-7e58645f` explicitly reported final PASS in
`/tmp/pi-codemode-bundle-review.md`: native default-deny example/tool bindings and
corrected top-level creation hook resolve the prior blocker. Parent integrated
B2's three commits as `49f11d387`, `e150a0485`, `e508567dd` with source provenance;
direct dependency was already `be2453c84`. Parent exports the inert factory,
budgets and types from src/index.ts; no runtime/config/registry enabling change.

Package typecheck/build and inert public SDK import/create/close smoke pass.
With PI_CODEMODE_CANDIDATE explicitly selecting the parent built package, parent
reran all four private probes: local and opt-in (65s/512 MB), independently written
edges (65s/512 MB), and actual safe/unsafe subprocess SIGKILL replay (110s/256-MB
controller, children512 MB). All exit0/pass, including OOM/deadline, independent
caller/host cancellation, true worker-exit drain, new/fork/reopen default-deny,
completed-result reuse and refusal to rerun interrupted unsafe effects. Safe
fixture supplies its own genuine idempotency; no exactly-once external claim.

Parent also wrote `/tmp/pi-nanobot-parent-sdk-inert.mjs` (40s/512 MB): importing
public SDK and creating an uninstalled bundle does not grant actual gateway
capabilities. Forged codemode/tool_search/bash calls all reject as unavailable,
Code Mode store is never created, and reopened conversation tools/callable remain
empty. Storage crash/reopen and six failure-path regressions still pass. No live
or paid integration calls, committed tests, production changes, push or cleanup.

Bounded B2 task accepted; P2 overall stays unchecked (gateway activation,
CodingTools/MCP/approvals, product failure verification, incompatible fingerprints,
real coding task remain). B1 managed workspace/quota/provenance proof outstanding;
unsafe partial execution remains withheld. Gateway still tools:[]/modelTools:[].

### 2026-10-26 — managed candidate reviewed; host IPC escape confirmed

B1 explicitly completed clean layered candidate `4c1a96976`: app-created opaque-id
workspace, private admission/dev-inode metadata, persistent reopen, and explicit
FD-mounted read-only imports copied into fresh inodes. Arbitrary writable roots
and publication remain rejected. Source/EXECUTION.md disclose missing aggregate
CPU/RSS/PID/disk quotas, default shell deadline, OS owner locking/GC and runtime
integration. Parent has not integrated execution/pi-env or enabled any tools.

Parent read daemon/shell/import/provenance paths, then adapted the worker probe
without modifying it: `/tmp/pi-nanobot-parent-managed-probe.mjs`, explicit worker
built imports, 90s timeout/5s kill grace/256-MB heap. Baseline native FS, explicit
imports/source preservation, aliases/leaf symlinks, namespace sentinels/network,
reopen, teardown and failed/cancelled setup all passed. This did not cover every
host namespace or the initial host-path ancestor admission race.

Reassigned reviewer `pi-7e58645f`/`w1P:p5` to the bounded managed contract, report
`/tmp/pi-managed-execution-review.md`; priority initial canonicalImport ancestor
ABA ordering and private admission/import guarantees. Host lstat/realpath/final
O_NOFOLLOW may still pin an unintended outside inode despite safe worker-local
traversal. Await its concrete conclusion; do not substitute a quiescent-source
snapshot caveat for proof against secret traversal.

Parent independently noticed missing IPC unshare and **confirmed exposure** with
`/tmp/pi-nanobot-parent-managed-ipc.mjs` and C fixture
`/tmp/pi-nanobot-parent-ipc-fixture.c` (70s/5s grace/256 MB). Only an owned synthetic
0600 SysV segment was created; guest shmat(SHM_RDONLY) successfully read that
known sentinel (exit23), and host/guest IPC namespace IDs matched. No real host
IPC objects were listed/read. Fixture host cleaned up its own segment and exited0.
No system package/config changes: used existing cc and private temporary binary.

Sent B1 a minimal required IPC-isolation fix for outer daemon, copy worker and
nested shell, fail closed with no unsafe toggle, plus actual-SHM regression and
full managed checks. Sent reviewer the reproduction so it can focus on import
admission without duplicating it. Await explicit fix/review reports. Candidate
remains withheld; quotas, shell deadline and ownership/integration are still
separate blockers even after namespace fixes.

### 2026-10-27 — non-sandbox roadmap batch launched

Owner explicitly excluded containerization/sandbox work and requested coordinated
Codex Luna xhigh subagents. Parent verified a clean `feat/pi-durable-rebuild` at
`0fea899af`, Herdr environment, current roadmap/design and native wrapper guide.
Launched C1/C2/C3 above independently from the same committed base. One initial
metadata inspection recorded branch/pane/worktree identities; all accepted startup,
with no pending permissions. No polling loop or terminal/CLI fallback.

Provider work may expand the existing tool-less slice; context/usage are opt-in
foundations pending native API/semantic review. Context accepts explicit trusted
snapshots rather than introducing a filesystem authority while P1 is unresolved.
Usage must preserve native attribution and expose gaps rather than fabricate
requests or an atomic external archive. No sandbox/execution change, unsafe
candidate acceptance, live request, dependency change or deployment is authorized.
Await explicit child reports, then review and verify before integration.

### 2026-10-27 — provider candidate and parent consumer proof

C1 explicitly completed clean `pi-7dcd4062` as `311670d92`, nine total native
provider aliases and strict env-name-only credentials, with source-backed gaps in
PROVIDERS.md. Parent reviewed candidate/config changes and native auth/transport
consumers; no integration yet. Launched independent read-only reviewer
`pi-eb98e056`, pane `w1P:p6`, Luna/xhigh, report
`/tmp/pi-provider-parity-review.md`; await explicit conclusion.

Parent reran the worker's offline auth/catalog/faux-DeepSeek probe through a
private selectable-import adaptation `/tmp/pi-nanobot-parent-provider-baseline.mjs`
(45s/384 MB), passing all nine mappings and boundary checks. Parent independently
wrote `/tmp/pi-nanobot-parent-provider-gateway.mjs` (60s/512 MB): actual native
DeepSeek adapter with globally intercepted synthetic fetch, actual gateway and
SQLite, transcript text/usage, credential absence from entries, reopen/requestId
dedupe and unchanged tools:[] all pass. Exactly one mocked request, no live/paid
call. Probes currently select candidate built artifacts; rerun against parent
build after reviewed integration. Real-provider acceptance and full P8 parity
remain open. C2/C3 continue independently; sandbox work remains untouched.

### 2026-10-27 — usage candidate scope correction requested

C3 explicitly completed `40d6688fc` on clean `pi-a34c1f70`, owning only new
src/usage/index.ts and USAGE.md. Candidate reads native UsageDoc without creating
it, detaches/freezes snapshots, projects model/tool/cost deltas without counting
nested spend twice, and leaves request counts/unknowns explicit. No archive writer,
cursor persistence, runtime integration or reset; broad P4 remains open.

Parent reviewed the module, private fixture and pinned native usage accumulator.
Found a cursor provenance blocker: numeric conversation IDs are storage-local,
so another store's same-ID cursor could subtract unrelated totals. Returned a
bounded follow-up through herdr_send: explicit stable host-owned source namespace,
validated in current/serialized/expected cursor scope; no inferred ephemeral IDs,
DB-path exposure, new state store or runtime/config changes. Require cross-store
same-ID rejection and same-source reopen/JSON roundtrip evidence. Await explicit
revised completion before independent acceptance/integration.

### 2026-10-27 — context candidate and lifecycle follow-up

C2 explicitly completed clean `pi-1db6d944` as `dece7e988`, only new
src/context/index.ts and CONTEXT.md. Native sections capture bounded host-supplied
identity/bootstrap/memory/selected-skill text, with own-property skill gates and
actual agent.tools visibility. No ambient loading, dependency, public export or
gateway activation. Python template conversion, discovery/retrieval, archives and
Dream remain explicitly unimplemented.

Parent reviewed module/docs/private fixture and reran a private selectable-import
baseline `/tmp/pi-nanobot-parent-context-baseline.mjs` (60s/384 MB): actual Harness
conversation isolation, post-construction mutation, disabled/always/selected
skills, hostile metadata, tool visibility and Unicode bounds pass against candidate.
Requested bounded lifecycle evidence for stable repeated prompts, replacement
with removed snapshots/sections, fork current-vs-historical context and reopen;
clarify that current-section removal does not erase inherited transcript content.
Await explicit follow-up and independent review before integration.

### 2026-10-27 — provider slice integrated and parent-reverified

Reviewer `pi-eb98e056` explicitly reported bounded PASS, no security blocker, in
`/tmp/pi-provider-parity-review.md`. Parent integrated C1 as `ca85ed9ba` with source
provenance, then passed package typecheck/build and both provider probes explicitly
selecting the **parent built package**. Native DeepSeek transport/auth, actual
SQLite transcript/usage, same-session reopen/dedupe and tool-less policy still pass.
No live/paid calls; this does not pass the real-provider or P8 acceptance gates.

Reconciled README and public credential-provider type export. Documented the
Python-vs-Pi OpenCode route difference (already present in the original spike),
and kept the example's Xiaomi reference on Python's `XIAOMIMIMO_API_KEY`, mapped
explicitly to Pi's expected `XIAOMI_API_KEY`. Unsupported endpoint variants,
OAuth/custom providers and model-specific quirks stay explicit, not auto-aliased.

Reassigned the completed reviewer through herdr_send to C2's committed context
module/lifecycle/skill/bounds contract; report target
`/tmp/pi-context-composition-review.md`. C2 lifecycle follow-up and C3 provenance
fix remain outstanding. Sandbox/execution changes remain deferred and tools disabled.

### 2026-10-27 — usage source fix and independent parent probes

C3 explicitly reported clean follow-up `b5ddc97a1` atop `40d6688fc`: required
host-owned storeNamespace plus conversation ID in snapshot/read/cursor contracts;
exact serialized-scope validation, no inferred identity or side store. Parent
reviewed the diff and native accumulator. Reassigned completed provider worker
`pi-7dcd4062`/`w10:p1` as an independent **read-only** usage reviewer, report
`/tmp/pi-usage-projection-review.md`; no further provider edits assigned.

Parent reran the updated native Harness/usage fixture via selectable-import
`/tmp/pi-nanobot-parent-usage-baseline.mjs` (60s/384 MB), passing fresh empty usage,
immutable/prototype-safe snapshots, store/cursor scope, model/tool conservation,
nested usage once, failed response and compaction accounting. Parent independently
wrote `/tmp/pi-nanobot-parent-usage-edges.mjs` (45s/384 MB): 120 cumulative steps
conserve model/tool tokens and costs; repeated JSON cursors, case-sensitive
cross-store same-ID rejection, cumulative-source tampering, malformed/missing/
regressing counters and nested cost immutability pass. Candidate built artifacts
only so far; repeat on parent after explicit independent review/integration.
No archive writer, request-count invention, abort-runtime proof, live calls or
sandbox changes. P4 remains incomplete.

### 2026-10-27 — context lifecycle parent verification

C2 explicitly reported docs-only follow-up `8a0da7610`, clarifying restart host
responsibility and fork/current-vs-history behavior; module remains `dece7e988`.
Parent read the private SQLite fixture and reran a selectable-import adaptation
`/tmp/pi-nanobot-parent-context-lifecycle.mjs` (90s/384 MB), passing unchanged-prompt
patch stability, same-name replacement/null removals, fork inheritance then current
section clearing, retained historical source, and same-snapshot reopen stability.
Shared the committed clarification and fixture with reviewer `pi-eb98e056`.

Parent independently wrote `/tmp/pi-nanobot-parent-context-edges.mjs` (45s/384 MB):
saturated total/section/tool budgets, Unicode-safe truncation, getter-free skill/
scope gating, missing-conversation isolation and duplicate/overflow rejection pass
against candidate. No module revision, ambient reads or gateway activation.
Independent C2/C3 conclusions remain pending; rerun all accepted probes on the
parent package after integration rather than claim candidate-only evidence.

### 2026-10-27 — independent usage review blockers

Reviewer `pi-7dcd4062` explicitly reported BLOCKED in
`/tmp/pi-usage-projection-review.md`. Namespace separation passes, but token rows
accept fractional/unsafe numbers, and the candidate overstates nested deduplication.
Pinned Durable counts nested usage again if a caller forwards that usage in its
own result; aggregated UsageDoc has no provenance to recover/deduplicate it.
Earlier passing well-behaved-caller probes do not establish prevention of that
source-level duplication. This adapter must preserve native facts, not claim to
repair them.

Parent returned bounded fixes to C3: safe-integer token validation including
legacy aggregate overflow (decimal costs remain valid), exact nested-source
limitation with good/bad-caller Harness evidence, and explicit trusted host-owned
cursor boundary. Namespace/shape validation is not cursor authenticity or rollback
protection; a legitimate-looking older/lowered same-scope cursor can re-emit usage.
No signing scheme, new ledger or archive writer requested. Usage remains unmerged
pending corrected candidate and explicit independent re-review.

### 2026-10-27 — independent context review blockers

Reviewer `pi-eb98e056` explicitly reported BLOCKED in
`/tmp/pi-context-composition-review.md`: captured numeric conversation IDs can
collide across independent Harnesses if a host shares extension/registry instances,
and selectedSkills entries lack the skill-name length bound before Set hashing.
Current single-Harness/fork/reopen checks do not prove safe multi-Harness reuse.
PromptInput supplies no trustworthy store namespace; a fake namespace option
would not solve the renderer's authority boundary.

Parent returned minimal corrections to C2: a mandatory fresh dedicated extension
and registry per Harness/storage-session contract in API/docs, narrowed isolation
claims and explicit per-conversation output limits; one shared named skill-name
bound applied to both records and selected names before insertion. Require actual
two-Harness same-root-ID isolated-registry evidence and oversized-selection checks,
plus unchanged lifecycle/bounds behavior. No new runtime, namespace scheme or
sandbox work. Context remains unmerged pending correction and explicit re-review.

### 2026-10-27 — context composition SDK integrated and parent-reverified

C2 explicitly completed correction `687e9d50e`; final independent reviewer
`pi-eb98e056` reported PASS with required per-Harness host precondition in
`/tmp/pi-context-composition-review.md`. Parent reviewed both fixes and reran
candidate baseline, two-Harness isolation, native SQLite lifecycle and independent
saturated-bounds/accessor probes. Integrated the three source commits with
provenance as `8cedf36a0`, `0252ab6dc`, `73bc37a86`.

Parent exports the opt-in factory/limits/types from SDK and links CONTEXT.md from
README; no runtime/config/gateway registration or discovery change. Fresh package
typecheck/build and all four probes **explicitly selecting the parent built package**
pass. Added private `/tmp/pi-nanobot-parent-context-sdk-inert.mjs` (45s/384 MB):
creating the public context and Code Mode factories installs neither into the
actual gateway; context sentinel absent from transcript, forged tool calls remain
unavailable, and SQLite reopen remains tool-less. No live/paid requests.

Bounded C2 accepted, not P3/P4 completion. Registry/extension ownership is a
mandatory host contract, not a runtime-detectable multi-store guard; inherited
history is retained even when current sections clear. Filesystem loading, Python
template conversion, progressive skills/retrieval, archive and Dream remain open.
Usage fixes/re-review still outstanding; sandbox work remains deferred.

### 2026-10-27 — usage numeric fixes verified; subset correction pending

C3 explicitly completed `c1ba415c9`, separating safe-integer tokens from decimal
costs, rejecting derived/aggregate overflow, and correcting native duplication and
trusted-cursor claims. Parent reviewed and reran updated baseline plus independent
120-step edges against candidate; numeric/source/cursor/nested/failure/compaction
checks passed. Independent re-review confirms the earlier blockers are resolved.

Reviewer found a remaining semantic gap: optional reasoning must be a subset of
output, and cacheWrite1h a subset of cacheWrite. Candidate accepted impossible
relationships, and the private makeUsage fixture itself generated those invalid
optional values. Thus prior fixture passes are not acceptance evidence for valid
optional-token semantics. Parent requested minimal validation on copied snapshots,
cursors and derived deltas, valid fixture counters and explicit invalid-subset
probes, while preserving missing/unknown behavior. No speculative totalTokens
reconstruction or source repair. Usage remains unmerged; await final correction
and review, then fresh parent-built verification.

### 2026-10-27 — usage SDK integrated; bounded batch complete

C3 explicitly completed subset fix `bcfc51523`; independent reviewer
`pi-7dcd4062` reported final PASS, no material blocker, in
`/tmp/pi-usage-projection-review.md`. Parent read the final fix/report and reran
valid fixture baseline plus independent numeric/subset/cursor/conservation edges.
Integrated all four source commits with provenance as `2b6b8f2d9`, `e155b2099`,
`7113cf96a`, `914638d3d`, then exports the read-only helpers/types via SDK.
README links USAGE.md; no runtime/storage/config activation or archive writer.

Fresh package typecheck/build and updated usage baseline/edges explicitly select
the **parent built package** and pass. Baseline includes safe-integer/overflow,
subset snapshot/cursor/delta validation, native missing/first-known fields, fresh
empty document, trusted older-cursor behavior, actual Harness omit/forward nested
usage, classified failure and compaction accounting. Independent edges cover
120-step token/cost conservation, exact source/cursor scope, optional unknowns,
malformed/regressing rows and immutable costs. Public SDK SQLite probe
`/tmp/pi-nanobot-parent-usage-sdk-readonly.mjs` (45s/384 MB) verifies unchanged
native snapshots after projection, external cursor JSON roundtrip, reopen usage
conservation and tool-less policy.

Final bounded parent-build regression reruns provider baseline/native transport
with actual gateway/SQLite, all four context probes, and context/Code Mode inert
SDK check; all pass. Added the reviewer's cumulative-source caveat explicitly:
a later omitted optional field can look like a zero **recorded** increment after
aggregation; it is not proof of zero actual provider use. Native already-duplicated
nested spend, unknown/uncommitted spend and request counts stay unrecoverable here.
Cursors require trusted host-owned state; no authenticity, rollback protection or
external archive transaction is claimed.

C1–C3 bounded tasks accepted; P3/P4/P8 remain incomplete. No production/live/paid
request, new dependency, committed test suite, push/deploy or worktree cleanup.
Containerization/sandbox/execution work remains untouched, candidate withheld,
gateway still tools:[]/modelTools:[]. Batch complete; no new worker task assigned.

### 2026-10-27 — next non-sandbox batch launched

Owner requested proceeding. Parent verified clean branch at `32e8b4def`, current
roadmap/runtime/config/providers/CLI and retained completed children. Launched
D1–D3 independently through native herdr_spawn using the same explicit committed
base and Luna/xhigh. One initial metadata inspection recorded the identities above;
no polling, terminal fallback or prior-resource cleanup.

D1 sent an early API proposal; parent approved existing-session-only model listing/
selection with explicit Context, exact provider identity and atomic busy-check/
configure semantics. Requested native security reapplication preserve allowed
choices, including root and absent thinking settings, and provider-specific key
isolation when aliases share an auth-env name. D2 has no dependency on an unfinished
D1 API: /model status only for now. D3 uses supplied bytes to avoid introducing
ambient filesystem authority while the execution gate remains open.

Await explicit reports; review/integrate and fresh-build verify before accepting
any bounded task. No new provider/channel/live credential/production grant.

### 2026-10-27 — first model-policy candidate withheld

D1 explicitly completed clean `pi-86637320` as `7a943bcb7`. Parent reviewed
runtime/config/provider/docs and private fixture. Candidate broadens native model
selection and preserves agent state, but is **not integrated**: acquisition and
selection still read snapshots then configure separately, allowing stale policy
reapplication to roll back a concurrent choice. Busy selection was accepted,
contrary to the approved atomic-rejection contract; its concurrent probe selected
an already-selected model and therefore did not prove the missing race boundary.
Host cwd policy also used the noncanonical configuration spelling.

Prepared generation requests persist their own native model/thinking checkpoints.
Rewriting only pi.agent on reopen does not stop a denied same-provider checkpoint
from dispatching through the still-complete provider catalog. Parent requires
fail-closed pre-resume or another proven native pre-dispatch guard, no checkpoint
rewrite/cancel or claim that prior remote spend is known. Native deferred-poll
and compaction paths must be considered, not only fresh model generation.

Returned bounded corrections through herdr_send. Worker subsequently confirmed
planned atomic LiveDoc busy rejection/AgentDoc read+configure, and model-change
thinking reset to configured supported default or off. Independent read-only
reviewer `pi-eb98e056`/`w1P:p6` is assigned the whole D1 contract and remaining
checkpoint/auth/cleanup boundaries; report `/tmp/pi-model-policy-review.md`.
Await explicit corrected commit and review. D2/D3 continue independently;
sandbox/execution work remains excluded and tool-less gateway unchanged.

### 2026-10-27 — atomic model follow-up; remaining guard work acknowledged

D1 explicitly reported `3295a7c1f` atop `7a943bcb7`. Parent read the diff:
AgentDoc/LiveDoc busy rejection and selection now share one native commit,
acquisition reapplication is atomic, and model changes reset thinking by the
approved supported-default/off policy. Not integrated: canonical cwd and prepared
revoked-request enforcement are still missing from that follow-up; MODELS.md
continues to allow the revoked prepared request.

Parent returned those two remaining blockers explicitly. Worker acknowledged
plans for canonicalization before policy construction, deterministic concurrency
barriers, and a gateway-local allowlist Models view or native pre-resume inspection
without mutating caller-injected Models. Requires actual same-provider prepared
request SIGKILL/reopen evidence of zero new denied dispatches, plus compaction/
deferred-poll source coverage and clean failure/reopen ownership. Prior external
outcomes remain unknown, not cancelled or rewritten. Shared `3295a7c1f` and pending
boundaries with the independent reviewer; await corrected explicit completion.

### 2026-10-27 — streaming CLI candidate withheld; slow-sink race reproduced

D2 explicitly completed clean `pi-0d64c0d6` as `66d5fcb10`, streaming native
watches/submissions with local commands and CLI docs. Parent read the full module
and CLI wiring. Not integrated: EOF explicitly withdrew durable queued inputs
after a failed kept run, rather than preserve them; asynchronous /abort could
overtake prior admission (or swallow subsequent input); rejection notices could
queue without honoring sink backpressure; render/final state mutated concurrently.
Requested bounded fixes plus incomplete-C1/Unicode sanitization checks. EOF may
cancel local observers and report held work, not delete durable user intent merely
to settle local waits; explicit /abort retains its documented native semantics.

Assigned independent read-only reviewer `pi-7dcd4062`/`w10:p1` to D2, report
`/tmp/pi-terminal-cli-review.md`. Parent independently wrote and ran
`/tmp/pi-nanobot-parent-terminal-backpressure.mjs` (30s/384 MB): actual native
Harness/faux provider, first partial Writable callback blocked until the final
assistant entry is committed. Expected 326 output characters, observed 372 with
duplicated prefix/newlines (`exactOnce:false`), built module SHA256
`8b84bce635cfae30e3ccb303f7eb08ca8d64ffa1db805a96be9c5c8a4fc350df`.
Shared the repro with worker and reviewer. Serialize render/reconcile transitions,
not only output writes; rerun final candidate and parent build with exact assertion.
No live calls, committed test suite or sandbox changes; await explicit fixes/review.

### 2026-10-27 — migration inventory candidate; schema corrections requested

D3 explicitly completed clean `pi-4b9c165f` as `1cd69b350`, new migration module
and MIGRATION.md only. Parent read the whole source/docs and Python session/config/
archive consumers. Assigned independent read-only reviewer `pi-1db6d944`/`w21:p1`,
report `/tmp/pi-migration-inventory-review.md`; no new editing ownership.

Parent independently wrote `/tmp/pi-nanobot-parent-migration-schema.mjs`
(30s/384 MB, synthetic bytes only). Actual persisted camelCase modelPreset was
incorrectly reported as default; camelCase maxTokens/contextWindowTokens/
reasoningEffort/needsVisionHandoff became null. Python's Base uses to_camel and
save_config writes by_alias=True. Missing message role and numeric user content
also returned complete:true with no diagnostic. Candidate remains unintegrated.

Returned bounded fixes: source-backed snake/camel aliases for reported fields,
explicit ambiguity rather than fabricated defaults, supported role/content shape
checks with incomplete/manual-review status, and one legacy-store/workspace per
invocation precondition for store-local cursor/key collision maps. No full config
loader, arbitrary normalization, destination importer or namespace fiction.
Shared the exact reproduction with worker/reviewer; await corrected commit and
fresh-build evidence. Broader P8 surfaces and migration transaction stay open.

### 2026-10-27 — model guard candidate and parent crash/reopen verification

D1 explicitly completed final chain `7a943bcb7` / `3295a7c1f` / `36ff7b95f`.
Parent reviewed guard/canonicalization diff and full updated selection fixture.
Private selectable-import adaptation `/tmp/pi-nanobot-parent-model-selection.mjs`
(75s/512 MB) passes actual SQLite selection/reopen, forced stale-acquisition and
thinking barriers, root preservation/revocation, canonical symlink cwd, busy
rejection and provider-key isolation against candidate build.

Worker supplied four inspectable private generation/compaction SIGKILL fixtures
and bounds after explicit parent/reviewer requests. Parent read all four and
created selectable-import copies under `/tmp/pi-nanobot-parent-model-{sigkill,
compaction-sigkill}-{reopen,worker}.mjs`, leaving worker fixtures unchanged.
Added repeated rejected startup to check retained denied task and owner/connection
cleanup. Both controller probes pass (40s timeout + 5s kill grace, 512-MB per-Node
old-space ceiling inherited by children; actual ~15.5s each). Real child SIGKILL
leaves prepared same-provider alpha; beta-only reopen twice rejects before replay,
with the sentinel retaining only one original fake dispatch. No original remote
outcome/spend or host-power durability claim; deferred-poll is source-reviewed,
not separately exercised by these crash fixtures.

Independent reviewer has final source and exact fixture paths. Candidate remains
unintegrated pending explicit final verdict and later fresh parent-build reruns.
CLI/migration corrections continue; sandbox/execution still untouched.

### 2026-10-27 — full migration source-review blockers returned

Independent reviewer `pi-1db6d944` updated
`/tmp/pi-migration-inventory-review.md`, still blocked. Beyond parent-confirmed
alias/session-shape issues, invalid legacy history payloads could contribute known
usage despite Python rejecting them; config and some issue hashes mislabeled whole
source digests as raw line hashes; malformed role/call combinations were not
uniformly labeled history-only. Raw session keys can identify accounts, so reports
need explicit private-source-level handling rather than an implied PII scrub.

Parent sent all findings together to sole D3 editor: source-faithful history usage
eligibility, document-vs-line provenance (audit issue fields too), alias/nested-shape
validation, universal historical-call non-execution classification, one-store
precondition and private-report contract. No heuristic secret scrub or inventory
report can justify public disclosure; no new privacy framework/importer requested.
Await corrected commit and re-review. Parent preserved actual D1 crash probe tool
results at `/tmp/pi-nanobot-parent-model-crash-results.md`; no new acceptance
claim or extra execution/sandbox work.

### 2026-10-27 — full CLI review and read-only scope recovery

Reviewer `pi-7dcd4062` explicitly reported BLOCKED for immutable `66d5fcb10` in
`/tmp/pi-terminal-cli-review.md`, confirming parent blockers and adding post-
readline input-buffer limits, CR/C1/bidi terminal controls, closed-Writable drain
hangs, surrogate truncation and raw process-level error-message risks. Parent sent
all remaining findings together to sole D2 editor; require committed correction
and inspectable private checks, not acceptance of concurrent working-tree changes.

A reviewer activity notice showed a blocked question. One recovery inspection
found an unnecessary dirty-checkout questionnaire about fixing the render race,
with no Bash permission request. Parent issued native scope correction: reviewer
is read-only, no edits/commits/approval of another worker's dirty changes, wait for
committed follow-up; abandon its own questionnaire only through supported native
cancellation if possible, otherwise leave it blocked. No approval keys, terminal
fallback or global permission change; delivery acknowledgement is not resolution.
The private race reproduction was shared for review, never delegated as a second
editing task. Existing D2 work remains exclusively owned by `pi-0d64c0d6`.

### 2026-10-27 — initial CLI/migration fixes; final CLI frame race persists

D2 explicitly completed `a46146954`; D3 completed `9f2839470`. Parent diff review
confirms initial correction sets, but both omit previously sent supplementary
full-review findings; returned those remaining issues explicitly rather than
accepting partial fixes. D3's parent config/message schema assertions now pass;
history eligibility/provenance/privacy/tool dispositions still need correction.

D2's active dist had temporary debugging artifacts, so parent did not attribute
that run to an immutable candidate. Instead archived exact `a46146954` into
`/tmp/pi-terminal-a461-WVIFFE`, linked installed dependencies read-only and freshly
built. Parent exact slow-sink probe still fails: expected326 characters, observed346,
with a stale partial suffix printed **after** the complete final answer. Exact
built terminal SHA256 `81c440ec79b8ae91a38217e6d5a019611b9a0ef5d2257b6c02b4d44d8c0dae1c`.
A render serializer alone does not terminalize final state or reject older queued
watch frames; shared the exact committed repro with the sole editor. Require
late-frame rejection/finalization plus remaining ingress/sanitization/closed-sink/
error-secrecy fixes. Neither D2 nor D3 is integrated.

### 2026-10-27 — user-directed consolidation

User requested direct integration and cleanup. Merged model `36ff7b95f`, CLI
`3956e7717`, and migration `e00651d33` without conflicts. Model independent
review passed; clarified Durable's normal startup task reconciliation in
`MODELS.md`. Parent-built package typecheck/build, slow-sink exact output,
migration alias/message-shape probe and generation/compaction SIGKILL reopen
probes passed. The final CLI and migration commits did not receive independent
final review; earlier EOF/order/flood and migration safety probes were inline or
not retained. No broad milestone, production-readiness or full parity claim.
CLI's completed-line limit does not bound readline's ingress memory. Gateway
tools remain disabled; sandbox/execution work was not integrated.

Removed nine clean owned Herdr child worktrees and closed two owned review tabs
without force. Prior sandbox candidate remains preserved on branch
`pi-ccd4ba61`, not merged. Other older closed worktrees lack established ownership
in this session and were left intact pending identification; no branch deleted.
