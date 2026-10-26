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

## Active implementation batch — 2026-10-26

Owner explicitly authorized Codex Luna xhigh implementation subagents. All start
from committed `0ea2c76eb3896646fb089549ad9d7669c7a6ed52`, in independent
Herdr worktrees; native wrapper tools only. Parent pane `w1P:p1` owns review,
root docs, integration and acceptance. No P1/P2 milestone is passed by launch.

- [ ] B1 — bwrap/native ExecutionEnv confinement: `pi-ccd4ba61`, pane `w1X:p1`.
- [ ] B2 — native Code Mode/tool-search lifecycle and offline nested replay:
      `pi-9dd12539`, pane `w1Y:p1`. Candidate `eb900a862` explicitly completed;
      parent candidate probes pass; review found a default-selection example
      blocker. Default-deny A/B/reopen follow-up, re-review and direct dependency
      declaration/integration pending.
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
- [ ] Install `pi-durable/codemode` using native CodemodeSandbox and native
  tool-search. Reuse journal, store/fork behavior, declarations, nested task keys,
  progress and error channels; no custom script worker or replay store.
- [ ] Enforce memory/deadline/output/concurrency budgets; release worker capacity
  on actual worker exit, not just a cancelled result. No recursive orchestration
  or unrestricted globals. Keep limits owned by the host, not model arguments.
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
  Admission requestId dedupe is not external side-effect exactly-once.

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
