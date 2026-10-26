# Full nanobot port — TypeScript on the Earendil/Pi stack

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

## Owner decisions and definition of full port

- TypeScript owns the application/runtime. Reuse Earendil libraries wherever they
  meet the contract, rather than reproduce the Python implementation line by line.
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
application to reuse one policy. Additional Earendil dependencies are welcome,
but must earn their place; the owner did not request installing the entire org.

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
| Remote files/commands/PTY | `pi-env` RemoteExecutionEnv/SSH/daemon | Candidate integration for isolated environments and existing remote UI; not a sandbox by itself |
| Isolation and controlled egress | `gondolin` micro-VM/VFS/network/secret hooks | Preferred P1 feasibility candidate, NOT an already-approved security fix |
| Interactive terminal | `pi-tui` where useful | Thin Nanobot commands/presentation observing Durable, not another AgentSession |
| Web components | existing frontend plus `elanor-react`/design tokens/icons where useful | React19 compatibility spike; preserve behavior and Nanobot branding, not wholesale cosmetic rewrite |
| Voice | `pi-voice` file-transcription implementation/backend where reusable | It is a Pi extension, not proven headless Durable middleware; preserve channel/provider limits and explicit model-download consent |
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
5. Gondolin disk checkpoints are **not** RAM/process snapshots or durable task
   replay. Host-backed VFS mounts still need path/race/hard-link review; VM branding
   does not make an unsafe host provider safe. Its limits include resource-DoS
   caveats, Alpine/image requirements and mediated-network protocol restrictions.
6. Elanor currently requires React19; this WebUI declares React18. Elanor's repo
   development toolchain also differs from the current Node22 application.
   Verify consumer/package availability, licensing, CSS and peer dependencies;
   don't smuggle a frontend/runtime upgrade into a backend port.
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

- [ ] Time-box a **Gondolin + native ExecutionEnv feasibility spike** before
  investing in more custom filesystem/sandbox code. Evaluate the existing Pi
  integration, reusable pi-env transport/daemon, and supported VFS APIs; decide
  the thinnest Durable adapter. An existing coding-agent example is not a
  drop-in Durable integration.
- [ ] Check Linux architecture, QEMU/acceleration availability, startup latency,
  concurrent-VM memory/CPU/disk costs and target-server feasibility. Installing
  host packages, downloading guest images or changing the server needs approval.
  Pin/verify selected image assets; no floating `latest` in reproducible deploys.
- [ ] Prove traversal, missing-leaf, rename, symlink-race and hard-link invariants
  for **every** read/write/list/spill/temp/cwd path. Prefer isolated storage or
  reviewed upstream providers; do not silently copy back over concurrent host
  edits or expose arbitrary writable host directories. Preserve clear workspace
  and extra-root semantics; never mount credentials or the Durable data root.
- [ ] Prove guest/process/VM teardown, timeout and cancellation, bounded resource
  use and absence of post-return work. No unsafe host/native fallback. Preserve
  per-file serialization and environment identity through upstream tools.
- [ ] Design allow/deny/ask policy and exact-call approval decisions on native
  tasks/documents/hooks, with authenticated approvers, expiry, revocation and
  request-bound resources/arguments/cwd. Prove the chosen durable wait mechanism
  before broadening capabilities; a pending approval must not become permission
  after reopen or for a different nested call.
- [ ] Enforce HTTP target validation including redirects, IPv4/IPv6 private ranges,
  metadata and DNS/connect-time rebinding. Reuse Gondolin policy where applicable,
  but separately guard **host-side** web/search/MCP/OAuth/media requests. Explicit
  narrow exceptions, not a global disable switch. Secrets are host-only; scoped
  substitution still allows exfiltration through an allowed reflecting service.
- [ ] Review storage guarantees against Python's fsync behavior. Upstream SQLite
  defaults to WAL `synchronous=NORMAL`: process-crash evidence does not prove
  latest commits survive power/host failure. Establish an appropriate FULL/fsync
  policy through a supported adapter/configuration, verify startup policy and
  fail-closed behavior; do not claim host-failure-safe send intent prematurely.
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
  wherever possible; assess headless reuse of pi-voice rather than its terminal
  UX. Preserve configured providers, languages, limits, vision handoff/image
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
- [ ] Evaluate Elanor in one bounded component/settings slice. Decide React19
  upgrade and package/license/CSS compatibility separately from protocol migration;
  retain existing UI if adopting it would expand the port without concrete benefit.
  Reuse design primitives, not Earendil logos or an unwanted product rebrand.
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
  Code Mode WASM/worker/image-processing assets and reviewed VM/daemon assets.
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

1. Security/reuse spike: Gondolin + pi-env feasibility, exact trust/host-mount and
   resource model, existing execution blockers, SQLite host-failure durability.
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
  proofs do not imply host-power durability; VM isolation does not imply a safe
  mounted host provider; task recovery does not make arbitrary I/O transactional.
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
release integrations. Pin chosen releases/source commits and audit licenses before
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
