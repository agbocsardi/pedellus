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
- [x] Make the explicitly named runtime credential available and execute that run; record pass/fail without increasing caps or silently retrying.
- [x] Agree a CLI/Telegram pilot only after reviewing the live result. Do not imply offline checks prove useful real-model recall or live delivery.
- [x] Fix the demonstrated native-fetch/grammY abort-signal startup incompatibility, with independent offline regression review.
- [x] Show best-effort Telegram typing feedback during active user turns; stop on settlement/abort/shutdown without awaiting typing in model or answer delivery.
- [x] Complete the approved five-minute synthetic Telegram pilot and record the actual outcome; no personal workspace or broader rollout.
- [x] Owner accepts the pilot as sufficient. Defer the reminder-only follow-up; live reminder scheduling/delivery remains unverified, not a blocker for the next discussion.
- [x] Clean up this batch's resources after owner confirms integration.
- [x] Adopt the cron conversation model: one persistent automation conversation per recurring
  job and one catch-all per origin for one-offs, a reset-delimited episode per run, a durable
  bounded one-off queue, and per-run prepared/retired authority.

## Owner follow-up — digest input correction

- [x] F4 — Digest evidence is conversation messages only: user and assistant
  text; no tool calls and no tool-result/output text. A closed episode whose
  selected messages fit the caps is delivered and acknowledged as one whole-episode
  pass. Current defaults: 200,000 characters per pass and 2,000 entries per batch
  (character bound governs; entry bound only stops floods of tiny messages; both
  minimums are 2). Oversized episodes keep independent ordered chunks with separate
  acknowledgements; a cut entry always ends its chunk; no carry-over summary.
  Lossless fragmentation, provenance, cursor and acknowledgement validation use the
  same message-only selection.
- [x] Independently reviewed (one blocking chunk-cut livelock found and fixed), then
  published at `fca5ab5` on clean main with docs/handoff reconciled.

## Owner follow-up — speech provisioning (cancelled)

- [x] F3 — Cancelled by owner after implementation. No provisioning command ships.
  The agent installs missing local speech tooling itself on first use through its
  ordinary shell/setup path, then voice notes work. Runtime still never downloads
  during message handling; an unprovisioned voice note yields the existing
  unavailable note and the stored original, and the agent can act on that.
  Worktree/commit preserved unmerged as evidence; no publication.

## Approved parity batch — bounded digestion, delivery and agent-managed work

Python is the accepted behavioral/product reference. Port onto native Durable
facilities; do not redesign memory quality, holistic usability or agent loops.

- [x] P1 — Configurable digest bounds: entries/batch and characters/batch,
  tool calls (10 individual calls, not Python iterations), whole-run timeout
  (300 seconds), changed files (8) and changed-text volume (32,000). Batch defaults
  were later superseded by owner follow-up F4 to 200,000 characters / 2,000
  entries with message-only evidence; P1's bounds/gates and capture behavior stand.
  Preserve one bounded closed-episode chunk per invocation, partial writes and
  cursor failure guards. Next ordinary invocation may retry a native parked task
  once; no retry loop or user recovery UI. No automatic schedule activation.
- [x] P2 — Telegram outbound local documents/photos/audio/video/voice, current
  authenticated chat only, bounded workspace files and captions, no remote URL
  fetching/arbitrary recipients; retain unknown external outcomes, never blindly
  retry or evict them. No extraction, transcoding or new media backend registry.
- [x] P3 — Agent reads its own workers' bounded paginated transcripts via native
  Durable conversation entries, keyed by authorized worker ID, not raw SQL or
  arbitrary conversation ID. No Atuin capture/export/second transcript archive.
- [x] P4 — Agent steers live workers using native Durable input semantics,
  coordinating admission with completion/authority retirement. Cancellation
  already exists; preserve it. No user worker-management surface or recursion.
- [x] P5 — Concise, read-only background summary inside existing `/status`:
  what is running (workers/digest/cron), if anything. No dashboard, management
  commands, model call or transcript dump; agent remains the manager.
- [x] P7 — User-systemd service readiness and parallel instances: one template
  service per instance, per-instance config/environment, independent
  dataDir/SQLite/socket and workspace. Verify graceful stop/restart/journal and
  same-store duplicate-owner refusal offline. No install/enable/start, lingering,
  dedicated system account or live deployment. Distinct Telegram pollers require
  distinct bot tokens; shared provider keys share quota, not a security boundary.
  Default primary config: `~/.durable-nanobot/config.json`; `--config` overrides
  it for a secondary instance. Resolve home at runtime, never depend on CWD;
  preserve explicit-config semantics for gateway/agent/recovery. No discovery,
  merging configs, auto-generation, migration or reading actual personal config.
  The home directory exists, but that default config file was not present when
  checked (existence only; no contents/settings were read).
  Prioritize this service slice ahead of remaining status work when capacity opens.
- [x] P6 — Independently review the combined union, run bounded existing parity/
  integration checks and reconcile docs. No new holistic usability study or
  live-provider acceptance without separate authorization.

Execution: start P1/P2/P3 independently (2–3 implementers); P4 follows accepted
P3, P5 uses accepted foundation interfaces, P6 closes the union. Pi provider,
`opencode-go/deepseek-v4.1-flash`, thinking high, fresh worktrees. Original workers
retain fixes; fresh independent reviewer per candidate/re-check, then clean-main
fast-forward publication by original worker. Parent owns this plan/orchestration.
Existing pinned dependencies, synthetic providers/transports/clocks, no live API/
provider/paid calls, installs/downloads, credential/settings/personal workspace
access, runtime activation or deployment. Record best assumptions; ask only for
material scope expansion. Preserve branches/worktrees. No freshness project,
recovery UI, document extraction or speculative framework.

## Owner follow-up — quiet digestion and CLI path attachments

- [x] F1 — Successful digest runs, including successful no-ops, do not notify
  or resume the origin agent. Preserve successful task/status/cursor records;
  only issues (failed/aborted runs) notify. Suppress legacy pending success
  notices during start/flush/reopen; retain unknown/issue results conservatively.
- [x] F2 — CLI attachments are path-only for every type, including images.
  Save originals in a CLI-specific workspace attachment directory and supply a
  workspace-relative locator; no native images or automatic vision/transcription.
  Inspect Pi coding-agent attachment handling and reuse compatible interaction
  patterns without transplanting its TUI or claiming unsupported paste behavior.
  Telegram's existing native image/voice behavior and stored locators remain intact.
- [x] Independently review each original worker's changes, fix findings through
  that worker, integrate passing candidates, and reconcile the final union/docs.

Two fresh worktree implementers launched from `8aadbfa` using the same Pi /
`opencode-go/deepseek-v4.1-flash` / high loop. No live/API/provider calls, installs,
credentials, runtime activation or personal workspace use. Parent owns this plan;
workers own code and focused regressions. These explicit owner corrections
supersede the overnight completion-notice and native CLI-photo assumptions below.

## Approved overnight batch — memory digestion and local usability

All six slices are accepted and published. Final reviewed product/docs tip:
`46a00c8` (functional tree identical to `ef0af84`). Morning handoff:
[2026-10-31_overnight-handoff.md](plan/2026-10-31_overnight-handoff.md).

Final independent gate: typecheck/build, 244 behavior checks across 31 files,
2 execution, 83 offline acceptance, and 77 focused union checks. No live
provider/API inference, paid operations, personal workspace, deployment or
schedule activation. Local speech artifacts were downloaded and tested under
owner authorization; that is not real-model memory-quality acceptance.

Batch complete: stop implementation. Completed agents retired; branches,
worktrees and voice proof artifacts preserved. Earlier sections/log entries
record historical decisions; this completed-batch summary supersedes stale
future/deferred wording below.

Owner approved this six-slice batch after the completed channel-neutral build:

- [x] O1 — Closed-episode input and durable digestion cursor. Authenticated
  mapped CLI/Telegram chats only; bounded oldest-first backfill of existing
  reset-closed episodes. Exclude open episodes and raw/root/fork/state/task-owned,
  worker and cron transcripts. Source-label evidence; successful validated
  processing (including no-op) advances the frontier, failures never do.
- [x] O2 — Bounded memory digestion using O1: agent-editable workspace prompt,
  ordinary Markdown/skill writes, provenance, concurrent-edit protection and
  inspectable recovery. No hashes/version registry, second archive or agent loop.
- [x] O3 — Manual invocation plus opt-in ordinary cron integration over O2;
  completion/failure visibility and explicit prompt freshness. Ship inactive:
  create/enable no schedule or personal runtime configuration.
- [x] O4 — Research local Node/TypeScript-compatible speech alternatives before
  choosing readiness work. Compare actual native/Python/audio-decoder/model
  requirements, CPU/Linux support, packaging, licensing and maintenance. Public
  documentation research was authorized initially; the owner subsequently
  authorized local voice dependencies/model downloads and synthetic local tests.
  Delivered an explicitly selected whisper-cli/FFmpeg route, keeping the legacy
  Python default and configuration compatible.
  Do not silently replace faster-whisper or claim empirical quality equivalence.
- [x] O5 — Explicit CLI local photo/document attachment submission through the
  single gateway/shared media pipeline. Preserve media opt-in, native image plus
  locator/vision handoff, document originals without extraction, bounded ingress
  and existing terminal controls. No separate runtime owner or model path grant.
- [x] O6 — Independent combined review, bounded offline acceptance and honest
  setup/plan handoff; reconcile registrations and integration without dropping
  accepted behavior. No live acceptance or deployment.

Execution: O1 and O5 start alongside O4 research; O2 follows accepted O1 and O3
follows accepted O2. O6 closes the union. Use Pi provider,
`opencode-go/deepseek-v4.1-flash`, thinking high, fresh worktrees; 2–3 active
implementers with separate independent reviewers. Retain original implementers
through fixes, review every candidate independently before integration, publish
passing work using the previous clean-main fast-forward loop. Preserve branches
and worktrees. Parent owns plan/orchestration, not functional implementation.

No credential/settings access, personal workspace, live provider/API inference,
paid operations or deployment was authorized. Public voice documentation research
and local voice dependencies/model downloads were explicitly allowed; other
checks used existing pinned dependencies and synthetic providers/fixtures.
No personal runtime configuration or schedule was activated.

## Previous batch status and next priorities

The owner accepted the pilot and then directed a channel-neutral assistant build.
Today's batch is complete on main `b0b16a6`. The gateway is the single
agent/runtime owner; CLI/TUI, Telegram and future Discord/Email are conversation
surfaces. CLI attach/disconnect leaves the gateway and Telegram alive;
conversations are separate by default and share workspace/Markdown memory.
Explicit config/workspace paths remain; there is no deployment or automatic
service install.

Accepted on main today:

- Single-owner gateway plus independently attachable local CLI.
- Telegram interactions: command menu, quotes/replies, scoped native replies and
  reactions, reaction-triggered turns, media ingress, voice helper, owner
  controls (`/model`, `/status`, `/new`, `/stop`, `/restart`).
- Configured vision handoff for text-only presets.
- MCP through the shipped gateway.
- General Code Mode composition of the current conversation's authorized tools,
  including scoped nested Telegram actions and background-worker children (which
  still never receive the `worker` tool).
- Native Brave search plus safe public fetch (default off).
- Bounded background workers with shared/worktree choice, capture-bounded tool
  authority and completion reported to the spawning agent, not the user.

Final offline gate on main: typecheck/build, 177 registered behavior checks,
2 execution checks and 83 offline core-acceptance checks. Worktrees are preserved
for evidence; completed agents are retired.

Still unverified live, and not implied by the offline suite: real faster-whisper
provisioning/transcription, product Brave queries, live Telegram reaction updates
and full-process restart behaviour, and broad real-provider quality. No deployment,
personal-workspace use or paid acceptance run happened in this batch.

The next product discussion should start from ordinary use and fix what breaks,
not feature parity. Likely candidates, all unapproved work:

- Explicit local voice provisioning and one bounded real transcription check.
- One bounded live Brave product-search check.
- An opt-in digest of previously unprocessed conversations/episodes into memory
  (deferred scope below), once the owner reopens it.
- Discord/Email adapters after agreeing permissions and direct-message scope.
- Small CLI/TUI polish driven by actual use.
- Live Telegram restart/reaction checks, only under a separately approved window.

Owner's earlier annotation requirements, now largely satisfied, follow. Remaining
unchecked items are deliberate gaps, not forgotten work.

- [x] Keep on-the-fly Markdown memory updates through configured `read`/`write`/
  `edit`; make snapshot/manifest freshness explicit through the existing refresh
  path rather than new memory tools. The CLI keeps explicit `/refresh`; Telegram
  `/new` rebuilds the assembled workspace prompt for the new session (and is
  refused while that chat is running). No Python-named memory tools were added.
- [x] Single-owner gateway host plus independently attachable local CLI, preserving
  existing terminal commands, Durable controls, tool authority and recovery.
  Independently reviewed (`5712c98`, material F1 fixed in `ca662bb`); integration
  metadata only, no further source change.
- [x] Native Telegram command menu/autocomplete for commands actually implemented;
  reuse `setMyCommands`, with no speculative command router or dead menu entries.
- [x] Telegram incoming replies/quotes with bounded, labeled source context;
  agent-selected native replies and reactions restricted to observed messages in
  the authenticated current chat. Ordinary answers remain unthreaded by default.
- [x] Handle authenticated Telegram reaction changes as ordinary agent turns,
  with durable update dedupe and explicit added/removed context. Offline handler
  verified; private-chat reaction-update delivery remains unverified live.
- [x] Wire configured MCP connections into the actual gateway and expose their
  registered tools through Code Mode/tool discovery. Implemented as `4d61f50`
  (pinned `@earendil-works/pi-mcp` client plus the existing native Code Mode
  bundle, installed by the shipped host only when `mcp` is explicitly enabled).
  Standalone review passed with no material code defects (`4d61f50`, docs
  corrected in `1c38146`); a fresh combined runtime/config/authority review
  passed `555d34c` with no material findings. Accepted and integrated into main.
- [x] Generalize native Code Mode into the agent's general compositor: scripts may
  compose every tool the current agent is authorized to call (coding, history,
  skill, cron, web, MCP, Telegram actions, and worker tools once accepted), not
  only MCP tools. No new authority: each nested call still passes its normal
  validation and call-time checks, deferred MCP stays callable but undeclared,
  and the tool set is the current conversation's actual callable set. Code Mode
  is not recursive, host-only owner commands are never model tools, and
  raw/root/state/fork targets keep no composition authority. Code Mode must be
  enableable without a dummy MCP server. Background children keep no worker tool
  (no recursive delegation) and only compose tools already captured for them.
  Accepted after the combined runtime/config/authority review of `1204226` and
  published with the web integration. Worker children now receive the same
  compositor over their captured tools only (`d27e3e7`). Cron targets still get
  no Code Mode, and no implicit cron/worker/MCP/web/Telegram grant exists.
- [x] Native Brave web search plus safe public web fetch: one configured provider,
  fixed HTTPS endpoint, key by environment-variable name, explicit default-off
  config, mapped-chat-only authority, public unicast DNS pinning, per-hop redirect
  revalidation, credential/cookie-free headers, bounded time/bytes/text, no script
  execution, and untrusted labeled results. Accepted after standalone reviews
  (`0a6abb6`, `b9e3339`) and the combined review of `1204226`; integrated with
  Code Mode composition. Product Brave search remains **live-unverified** (only
  one bounded implemented fetch smoke to example.com; no live provider query or
  account).
- [x] Implement channel-neutral attachment/voice media ingress: shared transcription
  configuration/processing, Telegram ingress first, native image content for
  photos with configured vision handoff, and document saving without extraction.
  Choose one initial speech backend; do not translate Python's entire provider
  registry. Ingress chain: `062ac68` + `0752ea1` + `a30d1cf` -> `f0e9319` ->
  `be6afc4` -> test-strengthening `0b65601` -> integration `fd6e563`, fresh final
  combined review PASSED and fast-forward published onto main `4a2616e`.
  Local faster-whisper provisioning and real transcription were **not executed**:
  provision the helper explicitly before use, and no automatic cloud, network or
  model download happens while a message is handled.
  - [x] Photos: send native pi-ai image content through the normal gateway turn;
    a configured vision-capable preset describes images for presets explicitly
    marked as text-only. Never silently switch the main model, and never refuse
    a photo merely because the selected preset is text-only.
  - [x] Documents: save the original under `workspace/media/` only. This
    docs-only raw-file behavior overrides the earlier "established extraction"
    wording: no automatic PDF/OCR/Office extraction libraries and no hidden
    document pipeline in this slice.
  - [x] Voice: local faster-whisper CPU/small/int8, owned by the separate media
    ingress worker; no cloud-audio upload, backend install or model download in
    this batch. The helper and bounded subprocess path are implemented and
    offline-tested; provisioning a real environment/model and producing a real
    transcript remain unexecuted operator steps.
  - [x] Vision handoff slice: config-flagged `needsVisionHandoff` presets, one
    named describer preset, bounded raw images and descriptions, native
    `beforeRequest` transform only, focused offline checks. Independently
    reviewed (`86cd25e` + fixes `3043160`, fresh reviewer PASS) and integrated;
    it does not own the Telegram adapter, CLI media options or transcription
    config.
- [x] Add bounded ordinary background workers. Product workers support research
  plus coding: the spawning agent explicitly chooses shared workspace or isolated
  worktree per task. Completion/results notify the spawning agent, not the user
  directly. Scheduled memory curation remains a separate deferred item below.
  - [x] Bounded ordinary workers on native Durable tasks: opt-in `workers` config,
    model-facing `worker` start/list/inspect/cancel, explicit shared-or-worktree
    workspace, captured tool ceiling, one internal result event to the spawning
    agent. Accepted: review fixes `2fbcd6b`/`4fcd9b6`/`74b9355`, integration merge
    `72a20f0` (current web/Code Mode main `dceb23f`), child Code Mode correction
    `d27e3e7`, final combined review PASS, published to main by this metadata
    commit. A worker child composes **only its captured tools** through native
    Code Mode/tool_search and never gets the `worker` tool or recursive
    delegation, nor implicit MCP/web/Telegram/cron/history grants. 16 focused
    worker checks; 177 combined registered behavior checks. Memory curation is
    not implemented here (deferred below).
    Carried cosmetic limitation (docs only, no source change): config parsing
    accepts non-coding `toolAllowlist` names, while gateway startup rejects names
    with no approved registration.
- [x] Add opt-in periodic digestion of previously unprocessed closed mapped-chat
  episodes into long-term memory. Implemented and independently accepted as
  O1–O3 above; activation in the owner's runtime remains unapproved.

Approved first implementation batch: channel-neutral gateway/local CLI attachment
and Telegram menu/reply/quote/reaction support. These are two independently owned
slices, with offline regression checks and independent review before integration.
Use a minimal local connection protocol, not a new agent loop or general service
framework. CLI disconnect leaves gateway/Telegram alive. Preserve explicit memory
refresh and document snapshot/manifest freshness rather than adding memory tools.

The owner selected local faster-whisper for the subsequent shared media ingress
slice, Telegram first; photos/documents remain high priority. No cloud-audio
upload, backend installation/model download or live integration is authorized by
this implementation batch. For documents, the owner clarified that saving the
original file is the whole feature for now: no automatic extraction, PDF, OCR or
Office processing. That overrides the old "established extraction" wording.
Photos are submitted as ordinary pi-ai image content through the normal gateway
turn (the adapter does no vision preprocessing); a configured vision-capable
preset describes them only for presets explicitly marked text-only.

Then wire product Code Mode + MCP, followed by bounded background workers and
ordinary scheduled memory curation. Photos/documents remain in the high-priority
media work, not a distant polish list.

Web search/fetch remains a useful reach feature alongside MCP. Other channels,
provider variants and richer UI follow actual use, not feature-for-feature parity.
This is a discussion order, not authorization to deploy, read personal settings,
spend on another run or start all feature branches.

## Conversation digestion scope — approved inactive implementation

Owner clarified that curation primarily digests previously unprocessed
conversations/episodes, not housekeeping over existing Markdown. Use the Python
reference's `nanobot/templates/agent/dream.md` prompt and guarded memory runner
as behavioral references, not a subsystem to copy.

- The agent owns the consolidation prompt as workspace Markdown (for example,
  `prompts/memory-curation.md`), editable through its configured ordinary tools
  so the owner and agent can inspect, discuss and tune it. Shipped prompt text
  is an initial seed only: never overwrite an existing workspace prompt during
  startup, upgrades or runs. Keep this simple: no added prompt hashes, version
  registry or prompt-management machinery. Existing runtime safeguards still apply.
- Read bounded, source-labeled Durable history; original entries remain
  authoritative. Keep a simple digestion cursor, like the Python dream cursor,
  recording how far history has been successfully processed. Use native Durable
  state, not a second history archive; never advance past unprocessed evidence.
- Follow the working Python write scope: `SOUL.md` for behavior/invariants,
  `USER.md` for stable personal preferences, `memory/<topic>/<name>.md` for topic
  context, small `memory/system/` for broadly relevant current material, and
  `skills/<name>/SKILL.md` for genuinely repeated reusable workflows.
- Extract atomic durable facts, prioritize explicit user corrections/preferences,
  update superseded facts in place, deduplicate and prune stale material. Preserve
  permanent preferences, active context and behavioral safeguards; move unique
  useful content to its canonical owner before removing duplication. Topic files
  retain description frontmatter; avoid wholesale restructuring.
- Treat quoted/tool/assistant-derived content as evidence, not owner instructions.
  Keep source provenance and do not save credentials or generic public reference
  material as memory. Adapt paths/tool names to this project; do not import
  Python's legacy-file migration rules or separate archive/command infrastructure.
- Retain the reference's integrity intent: bounded edits/time, inspectable changes
  and recovery, no loss of pre-existing or concurrent user edits. Advance the
  processed frontier only after a successfully validated batch. A completed batch
  with nothing worth remembering still counts as processed; a timeout/provider/
  tool/write failure does not. Use native job/worker outcomes to notify the agent;
  no special user-escalation policy has been selected.
- Implement later as an opt-in ordinary cron job over the accepted worker and
  Markdown-tool path, with explicit snapshot freshness through the existing
  refresh mechanism. No standalone Dream engine, new agent loop or automatic
  schedule activation. Existing-history backfill and exact history-unit boundaries
  must be made explicit before activation.

This scope was initially deferred, then approved and implemented as O1–O3.
`DIGEST.md`, bounded native tasks, `/digest` and explicit cron `intent: "digest"`
are shipped. Backfill includes closed mapped-chat episodes only. Nothing creates
or enables a schedule automatically; personal-runtime activation and real-model
quality acceptance remain unperformed.

## Product and constraints

One personal assistant, CLI or Telegram, one configured workspace. Config selects tools and named models. Markdown is memory; Durable owns transcript, compaction, tasks and recovery. Reuse those facilities. Keep host execution and optional direct-workspace Bubblewrap.

This follows the useful trunk of the [old assistant tree](plan/2026-10-29_assistant-tree_TODO.md) after the [completed removal pass](plan/2026-10-30_simplification_TODO.md). `plan/` is historical evidence, not competing instructions. Do not revive feature-for-feature Python parity, migration/archival SDKs, managed-copy execution or expiring tool grants.

The approved local gateway/client transport is the only new host boundary. No
additional service layer, agent loop, queue, retry framework, configuration mode,
dashboard, backup subsystem or general-purpose acceptance harness. A short integration check is better than a test platform. Prefer deleting obsolete work and fixing observed failures over speculative restructuring. Keep data integrity and provenance; never trade them for fewer lines.

The implementation batch was offline. A separately owner-approved live acceptance run may use only an explicitly named runtime credential, synthetic data and the existing budget guard; no credential-file discovery or value output. No security audit, personal data, migration, deployment or cutover. The completed pilot batch did not itself enable web/MCP/product delegation; those were separately implemented, independently reviewed and published later the same day, still without live acceptance. No standalone Dream engine will return: its desired memory-curation behavior is planned as an ordinary scheduled background job using the same worker/tools path. Standing intents, dedicated heartbeat and sustained goals remain excluded.

## Batch ownership and completion record

Use `opencode-go / deepseek-v4.1-flash`, thinking `high`, in separate
worktrees. This batch started with two implementation workers; the owner later
corrected concurrency to 2–3 IMPLEMENTERS, with independent reviewers separate
and not counted against that implementer bound. Original implementers stay
retained through review and fix rounds rather than being replaced. Parent owns
this plan, shared manifest/root exports, integration and final checks. Workers
commit bounded results and report exact checks and limitations. Add focused
permanent regression checks; no sleep-based schedule waits or leaked
gates/timers/subscriptions.

- **worker-gateway-surfaces:** local gateway server/client, CLI launch/attachment,
  terminal transport boundary, CLI/setup documentation and focused checks.
- **worker-telegram-interactions:** menu registration, incoming reply/quote context,
  authenticated reaction turns, model-callable native reply/reaction actions.

Both were independently reviewed and published; their worktrees remain preserved
for evidence.

### 2026-10-30 — bounded background workers (implementation batch)

Owner decisions for this slice: research **and** coding tasks; completion must
never message the user, Telegram or the CLI directly — it notifies the spawning
agent, which decides what to relay. The spawning agent chooses the workspace for
**each** task: `shared` (the actual configured workspace, concurrent writes
interfere) or `worktree` (isolated git worktree), never a silent default. No auto
merge, rebase, stash or commit of the owner's state; worktree artifacts stay for
review; uncommitted work is never deleted on cancellation. Scheduled memory
curation is out of scope for this batch. No live provider, bot, network,
credential, dependency install, model download or deployment is used.

Ownership: new `src/workers/**` (task foundation, tool, git workspace, limits),
the `workers` config interface/parser next to `cron`, narrowly required
`src/runtime.ts` capture/task/extension/environment/restore integration, one new
focused suite registered in `test:behavior`, `WORKERS.md` and this plan entry.
Telegram/media/CLI/local/terminal/vision/MCP modules, root docs and `src/index.ts`
exports are untouched; `package.json` gained only this suite's registration.

Finish line: the tool returns before the child finishes and the parent keeps its
turn; the mode really changes where writes land and leaves the owner's tracked
state untouched; a non-git or dirty base is refused without copying or stashing;
cancellation retires authority and a late child finish never reports success; a
worker cannot delegate and only its spawning conversation can inspect it; a
narrowed config on reopen cannot restore a removed tool; completion admission is
exactly once across a crash window; a child image read still gets the configured
vision handoff. No live integration is claimed.

New test registration and root exports were parent/integration responsibilities;
all are registered on main.

Later slices (vision handoff, media ingress, MCP, Telegram owner controls,
web + general Code Mode, background workers) each followed the same lifecycle:
original implementer retains its worktree, fresh independent review, findings
returned to that implementer, then publication by that implementer. Every slice
passed its final gate before fast-forwarding main; no separate integration agent
or hand-edited main source was used.

## Session log

### Digest input correction published

F4 published at `fca5ab5`. Digest evidence is now message text only (`pi.user`,
`nanobot.cron` input, `pi.assistant`); tool calls and tool-result/output text are
consumed but never curated. Defaults are 200,000 characters and 2,000 entries per
pass (both minimum 2); an episode within both bounds is one whole-episode read and
acknowledgement, and larger episodes keep independent ordered chunks. Independent
review caught a blocking livelock where a chunk cut mid-message continued into an
evidence-free entry and could never be acknowledged; a cut entry now always ends
its chunk. A one-entry batch minimum prevents a second deterministic stall. Old
recorded batches fail closed and are re-read. Gate: 293 behavior, 2 execution, 83
offline acceptance; published main typecheck/build and 62 focused digest checks.
Accepted: facts only in tool output are not digestible; re-read is entry-count
bounded, not byte-bounded; >4,000 reset gap and 4,000-entry turn verification
unchanged; a large episode is still curated in independent chunks with no
carry-over. Speech provisioning command was cancelled unmerged per owner direction.

### Digest input correction

Owner rejected the tiny 24k evidence pass as unrepresentative and asked that a
run load whole episodes of messages only, not tool calls or tool outputs. Agreed:
200k-character configurable ceiling, 2,000-entry cap, whole-episode single pass
when it fits, independent ordered chunks otherwise. F4 started beside F3.

Owner confirmed Telegram voice auto-transcription is the desired behavior; it is
already automatic once the engine is provisioned. First chose an explicit
provisioning command, then cancelled it: the agent should assume tooling exists
and install what is missing itself on first use. F3 stays unmerged; F4 continues.

### 2026-10-31 — P1–P7 parity batch closed

Final main `facefae1` (docs-only above functional `3bace35`). Published this
batch, each through its original implementer after fresh independent review:
P1 digest bounds `3a297fa`, P2 arbitrary Telegram sending `c755673`, P3 worker
transcripts `ba6df4e`, P4 worker steering `54b2331`, P5 bounded background
`/status` `7caa613`, P7 default config + user-systemd parallel instances
`5213837`, P6 parity handoff `facefae1`. Handoff:
[plan/2026-10-31_parity-handoff.md](plan/2026-10-31_parity-handoff.md).
Final gate: typecheck/build, 286 behavior across 35 suites, 2 execution, 83
offline acceptance; functional identity vs `3bace35` empty. No live
provider/API/paid calls, Telegram traffic, systemd operation, installs or
activation. Accepted limits and remaining live gaps are in the handoff.
Parent plan repaired here: the P5 log edit had displaced the Session-log heading;
entries are restored under it. Stop; await owner direction.

P5 (compact background status) published at `7caa613` after independent PASS and
a narrow re-review of two low findings. `/status` in CLI and Telegram now shows,
on demand, the current chat's running/queued/sleeping/parked workers, own cron
runs and armed jobs, and the workspace digest run labelled own vs shared, with
row/name/character caps and honest truncation. It is read-only: no document,
task, cursor, notice, tool authority or model call; non-mapped conversations get
an empty snapshot. Fixes: parked wording only promises a native retry for a
restart-limit block, and the local `/digest status` payload is an explicit
allowlist that excludes another chat's internal conversation ID. Gate: 286
behavior across 35 files, 2 execution, 83 core; published main build plus 6
focused checks. Accepted limits: parked worker/digest classification is
renderer-covered only, up to two live-task index scans per status, snapshot not
atomic across parts. One earlier offline `npm ci` in a fresh worktree was a
recorded process deviation; no tracked or lockfile change.

### Parity batch — P3 transcripts, P7 service readiness and P4 steering accepted

P3 (worker transcripts) published at `ba6df4e`: existing `worker` tool gained a
bounded, ownership-verified `transcript` action over native Durable entries;
history's bounded entry renderer was shared rather than copied. No Atuin
capture/export or SQL surface. Independent PASS: 19 worker checks, 250 behavior,
2 execution, 83 core.

P7 published at `52138372` by its original implementer after two independent
reviews (first found the branch predated P1/P2 and dropped a registered suite):
default config `~/.durable-nanobot/config.json` resolved from the runtime home,
explicit `--config` preserved for secondary instances, user-systemd templates
for a primary and `nanobot@` secondaries, per-instance config/dataDir/workspace/
socket separation. Instance paths use a literal `i-%i` directory so a dot-like
name cannot traverse. Static `systemd-analyze verify` only; nothing installed,
enabled, started, lingered or reloaded. Final gate: 276 behavior across 34 files,
2 execution, 83 core; published main build plus 6 focused service checks.
One docs link defect and a silent-skip were fixed before publication. Accepted
limits: same-UID instances are not a security boundary, distinct pollers need
distinct bot tokens, live systemd operation untested, canceled/parked worker and
restart-limit block classification covered by renderer tests only.

P4 (worker steering) published at `54b2331` after two independent reviews. The
`worker` tool gained bounded `steer` (2,000 UTF-16 units, 8 accepted per worker)
using one native commit that verifies task/spawner/child ownership and a live run
owning this worker's initial or accepted steer submission, so admission cannot
race finalize into an orphan turn; queued steers are withdrawn on cancel and the
worker joins successor runs. Re-review fixed silently deduping a changed payload:
the record stores a SHA-256 of the exact steer text, replays dedupe, and a changed
payload refuses without a second inbox item. Independent probes confirmed 10
concurrent admissions → exactly 8 accepted, full successor chain joined, latest
answer reported, no dangling child task. Gate: 280 behavior across 34 files,
2 execution, 83 core; published main build plus 23 focused worker checks.
Accepted limits: admission is a narrow native submission/inbox mirror without a
submission trace link (telemetry only); `afterFailedRun:"continue"` is unsupported
and not configurable by the shipped harness; no worker deadline exists. Untracked
owner migration plan stayed untouched.

### Parity batch — P1 digest budgets and P2 Telegram sends published

P1 published at `3a297fa`: configurable per-invocation digest bounds (entries,
characters, individual tool calls, run timeout, changed files and changed text),
captured across replay/reopen; repaired native-edit argument shapes are charged
using the same normalizer; one ordinary-invocation native parked-task retry; no
retry loop or recovery UI. Independent review found and the original worker
fixed repaired-edit budget bypass and a one-unit Unicode wedge. Gate: 262
behavior / 32 files, 2 execution, 83 core; published main rebuild plus 12 bounds
and 14 digest checks. Accepted limits: UTF-16 conservative diff accounting, no
path-alias resolution, 4,000-entry verification bound, no nested digest tools.

P2 published at `c755673` after two independent passes and a final union PASS:
agent sends any workspace file through the current authenticated private chat;
omitted kind sends unchanged bytes as a document, while photo/audio/video/voice
are optional presentation hints. Authority is media opt-in plus `read` for the
model tool, current mapping/allowlist, workspace-only paths and 20 MiB; durable
task identity, write-ahead records, unknown retention and cancellation preserved.
Gate: 270 behavior / 33 files, 2 execution, 83 core, 8 focused; published main
rebuild plus 8 outbound and 12 bounds checks. Accepted limits: live Telegram
format/delivery unverified, no transcoding/autodetect, documented parent-directory
resolve/open race and UTF-16 display-name stem. Owner parallel migration plan
remained untracked, unread and untouched.

### Service readiness and parallel instances approved

Owner identified service operation as important and approved a user-systemd
service template, plus independent parallel instances rather than multi-tenancy.
Use the existing foreground gateway and its SIGTERM/SIGINT teardown; separate
configs/data directories/workspaces supply separate SQLite stores and sockets.
No automatic service installation/activation or system settings changes.
P7 added to the batch; implement when an active worker slot opens, then include
it in P6 combined review. No new daemon or supervisor layer.

### Parity batch — worker transcripts accepted; steering starts

P3 published at `ba6df4e` by original implementer after independent CLEAN PASS:
19 worker checks, 250 combined behavior, 2 execution, 83 core, typecheck/build.
Shared bounded entry rendering preserves history scope; task/spawner/child-owner
edges are checked before reading live or terminal worker transcripts. No Atuin
capture/export or raw SQL surface. Published main rebuild and 19 focused checks
passed. Cosmetic start-hint, record-lag wording and truncation-suffix nits waived.
P4 starts in a fresh worktree with native steering/completion-race coordination.

A separate untracked `2026-10-31_legacy-migration_TODO.md` appeared in main;
owner explicitly directed leaving it untouched while continuing in isolated
worktrees. Do not read, commit, modify or delete that parallel work item.

### Parity batch authorized

Owner approved P1–P6 above with the same worktree/DeepSeek Flash high/original-
worker fix/independent-review loop. Python behavior is the reference, not a
request to redesign memory or prove holistic assistant usability. Initial slices
are digest limits/retry, Telegram local-media sending and worker transcript
access; later steering/status and union acceptance remain within this batch.

### Owner follow-up — both corrections accepted and published

Path-only CLI attachments published at `49407ff` after independent fix/union
PASS; all originals, including images, now use `<media.directory>/cli` and plain
workspace-relative locators. No native images, vision or transcription on CLI;
Telegram unchanged. Review caught/fixed valid 125–128-character media-directory
startup regression by validating the operator base before the trusted child.
No clipboard/drag interaction parity with Pi is claimed.

Quiet-success digestion published at `cf5407a` after independent standalone and
combined PASS. Successful digested/no-op/consumed tasks stay visible in status
but never notify or resume the origin agent, including legacy pending records
on reopen/flush; failed/aborted issues still notify once. Unknown issues remain
retained; success records safely release notice capacity. Final AGENTS wording
now distinguishes Telegram media from path-only CLI attachments.

Combined reviewed gate: typecheck/build, 247 behavior across 31 files,
2 execution, 83 offline acceptance, 80 focused union; published main build,
typecheck, 26 digest and 8 CLI checks passed. Pre-existing transcription tests'
global temporary-directory snapshot race was observed in earlier worker runs,
reported honestly; final independent union passed first-run. No live API/provider,
network, installs, settings or runtime activation. Branches/worktrees preserved.

Next batch remains discussion only: owner rejected digest recovery UI, memory
freshness and document extraction. Proposed six are digest limits/next-invocation
retry, Telegram local-media sending, worker transcript reading, worker steering,
compact background `/status`, and combined acceptance/docs. Read-only research
confirmed native Durable entries (not Atuin capture) are the worker transcript
source; cancel already exists. Python limits count history records, not sessions.
Exact next-batch defaults and final work orders await owner approval.

### Owner follow-up — assumptions corrected

Owner accepted the overnight assumptions except two: digestion should notify
its agent only on issues, not successful runs/no-ops; CLI attachments should be
path-only, saved in a channel-specific workspace directory. CLI photos must not
be submitted as native images. Two scoped workers started with independent
review required before integration; Telegram media behavior remains unchanged.

### 2026-10-31 — overnight batch closed

O6 published by its original implementer via clean-main fast-forward to
`46a00c8`, after independent CLEAN PASS on `fef0407` and two wording-only nits
corrected. No source/test/script/dependency difference from functional tip
`ef0af84`. Final independently repeated gate: 244 behavior, 2 execution,
83 offline core, 77 focused cross-feature checks, typecheck/build; final docs
publication also passed main typecheck/build. All six checklist items complete.
Handoff records commands, opt-in setup, exact tips, best assumptions and accepted
limitations. No live API/provider or paid calls, deployment, personal-workspace
use, automatic schedule or runtime activation. Completed agents retired;
branches/worktrees and voice proof artifacts retained. Stop; await owner review.

### Overnight — manual/cron integration accepted; final handoff starts

O3 published by original implementer via clean-main fast-forward to `ef0af84`
after fresh independent final PASS. CLI/Telegram owner `/digest` starts one
bounded batch, `/digest status` is read-only; explicit ordinary cron
`intent: "digest"` uses authenticated origin/current tool authority and no channel
outbox. No schedule is created/enabled automatically. Completion/failure/no-op/
abort reaches the spawning agent through one internal result event, not a direct
channel message. Review fixes preserve all pending/unknown results at the
100-notice cap (safe pruning/backpressure), recover authoritative terminal tasks,
and verify the actual result-entry kind/task/origin before marking reported.
Status no longer creates an empty doc; idle/refused text notes that flushing old
results may resume the origin agent, despite no new digest run being started.

Gate: typecheck/build, 244 behavior, 2 execution, 83 core; published main
rebuild/typecheck and 11 focused controls passed. Accepted edges: cron crash after
start before occurrence finish may process one extra bounded batch on replay;
queued result admissions stay pending until verified; a submit throw with a
missing notice may require reopen recovery. No false reported flag/eviction is
accepted. Rendered O2 concurrency wording was corrected to the actual in-process
edit guarantee. No provider/API, paid, personal-runtime or deployment activity.
O6 now starts in a fresh worktree: combined existing offline acceptance, current
doc reconciliation and a concise evidence/assumptions morning handoff only.

### Overnight — memory digestion execution accepted; controls/scheduling starts

O2 published by original implementer via clean-main fast-forward to `51de982`
after fresh independent PASS. One native `nanobot.memory-digest` task consumes
one O1 batch, seeds editable `DIGEST.md` only if absent, and receives narrowly
captured read/write/edit tools. No model-facing command/tool/cron activation yet.
Review fixes require a non-empty committed report and reject any failed tool
result before acknowledging; partial writes remain for replay, never rolled back.
Digest write now uses guarded atomic exclusive create; exact edits are serialized
in-process only, not protected against an uncooperative external editor racing
between native edit's read and write. Task failure/reopen accounting and retired
authority were independently checked. Gate: 231 behavior, 2 execution, 83 core,
typecheck/build; published typecheck/build and 14 focused checks passed.

Accepted limits: >4,000-entry turn verification fails closed, parked tasks block
new starts until native retry/abort, caller's pinned model may process another
mapped chat's batch in the shared workspace, failure evidence count currently
reports zero. A rendered trust-envelope edit sentence still overclaims external
concurrency protection; O3 owns its narrow wording correction. No provider/API
inference, paid operation, personal-runtime activation or schedule was performed.
O3 starts in a fresh worktree: manual host controls, explicit ordinary-cron path,
internal spawning-agent completion visibility, all inactive until invoked.

### Overnight — closed-episode foundation accepted; digestion starts

O1 published by original implementer via clean-main fast-forward to `9b38b13`:
functional candidate `7b9e4f6` passed fresh independent review; final change only
corrected cancellation comments/docs. Review rounds fixed loss of truncated
evidence, ambiguous idle results, initial/frontier and partial-bound skip holes,
reset-scan resume and first-closing-reset verification; Unicode-safe fragments
remain strictly bounded. Final gate: 217 behavior, 2 execution, 83 offline core,
typecheck/build; published rebuild and 17 focused checks passed.

Accepted limits: >4,000 empty-reset gap refuses loudly; first ack of each episode
walks that episode in bounded-memory pages but is not interruptible mid-walk
(SQLite ignores context), though aborted context cannot commit cursor advance;
cross-chat order is best-effort under scan budgets. No deployed poisoned-cursor
migration/repair is claimed. O2 now starts in a fresh worktree: bounded editable-
prompt digestion, provenance, replay-safe memory edits and concurrent-edit
protection; no commands, schedule activation or new agent loop. O3 follows its
accepted execution interface. No paid/live provider or API calls authorized.

### Overnight — Python-free local voice accepted and published

O4 published by original implementer via clean-main fast-forward to `3fdd7de`,
after research correction/re-review and fresh independent implementation/union
PASS. Research and empirical evidence:
[backend decision](plan/2026-10-30_local-transcription-backend-decision.md).
Explicit whisper-cli backend uses operator-provisioned FFmpeg/ffprobe, engine,
model and VAD; legacy faster-whisper remains the default with existing config
compatibility. One deadline covers probe/decode/transcription; input, duration,
decoded PCM and output bounds, cancellation/reaping and private-temp cleanup
were checked. No runtime downloads, automatic fallback or personal config changes.

Candidate gate: typecheck/build, 200 behavior, 2 execution, 83 offline core;
published main typecheck/build and 17 focused checks passed. Real local Opus
speech, silence and over-duration checks used downloaded local artifacts only;
no provider/API inference or paid operations. No quality parity claim, one
speaker/host, nightly prebuilt pin and no namespace-isolated offline proof.
Accepted fail-closed limitation: metadata-heavy short audio can hit the PCM size
fence. File-only protocol restrictions block network protocols but permit local
playlist file references, not filesystem isolation; setup wording clarified.
Optional extra test matrices/cosmetics deferred after clean independent review.
Branches/worktrees and local proof artifacts preserved.

### Overnight — CLI attachments accepted and published

O5 published by its original implementer via clean-main fast-forward to
`19ce411` after independent initial PASS and fresh fix/union PASS. `/attach`
submits one operator-named file through the private socket and gateway-owned
media store: native photos plus locator/vision handoff, raw documents only.
Review hardening made file opening nonblocking before regular-file checks;
dedupe documentation now states the kind/extension boundary. Full candidate gate:
typecheck/build, 183 behavior, 2 execution, 83 offline acceptance checks. Published
main rebuild and six focused attachment checks passed; no live API/provider use.
Optional formatter refactor and exhaustive filename-framing tests waived as
outside scope. FIFO blocking mutation is bounded by the suite's outer process
timeout. Worktree/branch preserved. CLI audio remains an opaque stored original.

Voice scope update: owner subsequently authorized local voice dependencies/model
downloads and best assumptions documented in branches, but prohibited live
provider/API calls and paid operations. Research and local proof passed fresh
review; an explicitly selected whisper.cpp + FFmpeg route is being implemented,
retaining existing Python configuration/default compatibility. No runtime
activation, automatic downloads or silent backend switch is authorized.

### Overnight batch authorization

Owner approved the six slices above, closed mapped-chat episodes with bounded
existing-history backfill, inactive opt-in curation and offline checks. Requested
public research into avoiding Python/uv for local voice before selecting a
replacement. Reconfirmed the same Pi/DeepSeek Flash high worktree/independent
review/original-worker fix/integration loop. O1, O5 and O4 research launched;
no live operations, installs or model downloads authorized.

### 2026-10-30 — channel-neutral batch integrated

Final main `b0b16a6`, clean. Published today, each through its own retained
implementer, independent review(s) and fast-forward: gateway/CLI (`5712c98` +
`ca662bb`), Telegram interactions (`30d34f1` + `59c15d7`), vision handoff
(`86cd25e` + `3043160`), media ingress (`fd6e563` → `ef6d742`), MCP (`4d61f50`
+ docs → `4a2616e`), Telegram owner controls (`d416fbc` → `578dc20`), web +
general Code Mode (`0a6abb6` + `b9e3339` + composition → `dceb23f`), and
background workers (`74b9355` + child Code Mode `d27e3e7` → `b0b16a6`).
Review findings were fixed by the original implementers, not the parent; only
docs/metadata were parent-owned. Final gate: typecheck/build, 177 behavior,
2 execution, 83 offline core. Completed agents retired, worktrees preserved.

Environment note: the new pinned dependencies were added to main's shared
`node_modules` additively and offline (`--ignore-scripts --no-save`) from the
accepted lock, with versions/integrity audited and no removals or upgrades;
`package.json`/`package-lock.json` are unchanged by that sync.

No live Whisper provisioning, product Brave search, live reaction/restart run,
deployment or paid acceptance was performed. Next session starts from actual
use; curation remains deferred by owner choice.

### 2026-10-30 — Code Mode becomes the general tool compositor

Owner direction: Code Mode should allow composing all tools generally available
to the agent, not just MCP tools. This supersedes the MCP-only exposure scope
while keeping every existing authority check, deferral rule and denial intact.
The active web-tools integration worker owns the small native generalization and
must report functional changes for the combined review. Separately recorded:
Telegram owner commands are `/model`, `/status`, `/new` (reset plus rebuilt
workspace prompt) and full-process `/restart`, with no separate `/refresh`; the
background-worker fix round is in progress; curation stays deferred with a simple
editable prompt and digestion cursor. No live runs or new spend authorized.

### 2026-10-30 — Telegram owner-command scope

Owner selected Telegram owner commands as independent work. Use `/model` for
configured presets and `/status` for bounded own-chat metadata. Do not add a
separate Telegram `/refresh`: `/new` must reset the conversation and rebuild the
assembled workspace Markdown/skills prompt for the new session. `/restart` must
gracefully restart the full gateway process so new code and config load; attached
CLI clients disconnect and Durable work recovers under existing safety rules.
No deployment, service manager, live bot run or new tool authority is authorized.
The original owner-command implementer received this scope update; review and
integration are still required.

### 2026-10-30 — deferred conversation digestion scope

Read the Python curation prompt and guarded runner after the owner clarified
that unprocessed conversations/episodes are the main input. Recorded its broad
memory/skill editing and pruning scope, source/processed-frontier integrity and
ordinary cron/worker implementation constraint. Corrected product-worker wording:
shared/worktree is chosen by the spawning agent; completion notifies that agent,
not the user. Owner also required an agent-owned, inspectable/editable workspace
consolidation prompt, seeded once. The owner subsequently clarified: a simple
editable prompt plus digestion cursor, without prompt hashes/version machinery.
Existing runtime safety and data-integrity requirements remain. Owner explicitly
deferred curation implementation until background workers exist and requested a
different next slice. No curation code, schedule, model run or historical-data
processing started; this is planning only.

### 2026-10-30 — MCP accepted and published

A fresh combined runtime/config/authority review passed `555d34c` with no material
findings, verifying the reviewed vision/gateway source coexists with the MCP
slice, 116 registered behavior checks, 2 execution checks, 83 offline core checks,
typecheck and build. Publication only reconciled front-door metadata and docs:
the plan status, README/AGENTS statements that Code Mode was SDK-only with no MCP
installed, and the MCP/CODEMODE accepted status. No functional source, test or
dependency file changed relative to the reviewed tip. Current parallel work is
recorded as: media ingestion under its final review (`be6`), product background
workers under active implementation, and native Brave web search plus fetch newly
owner-approved and running. None of those were imported here, and no live MCP,
provider, credential or production run was performed for this slice.

### 2026-10-30 — MCP connections through product Code Mode (accepted, integrated)

The MCP worker wired explicit `mcp` config (stdio and Streamable HTTP, env-name
secrets, no OAuth/`mcp.json`/hot reload) to the pinned
`@earendil-works/pi-mcp@1.4.0` client and exposed discovered tools as deferred
native `mcp__<server>__<tool>` registrations through the existing Code
Mode/tool-search bundle (`4d61f50`). Authority is default-deny: mapped
authenticated chats only, call-time hook plus per-conversation tool filter,
coding ceiling preserved for nested calls, no scheduled-run MCP authority.
Independent review passed with no material code defects after verifying native
hook scopes, connection withdrawal handling, startup-timeout cleanup and no
retry; only three documentation corrections were requested, fixed in `1c38146`
(scoped nested-call wording, the real install gate, and the `content`/
`structuredContent`/`isError` result shape with `_meta` dropped). The same
correction pass documents that a configured stdio server is a native host
process not covered by `toolSandbox: "bwrap"`, labels cancellation evidence
honestly (script deadline tested, native request timeout code-read), and notes
that a `tool_search`-loaded tool can need rediscovery after a policy reapply.

Integration candidate `44c7385` merges current main (`c6474ee`: reviewed
gateway/local CLI plus reviewed vision handoff) into the MCP branch. Conflicts
were only `package.json` (test registration union, 22 files) and `src/config.ts`
(both import/field families kept). `src/runtime.ts` auto-merged and was checked
for semantic overlap: the vision hook keeps its all-conversation selection,
`denyNewConversation` and cron-prepare inclusion, prepared-dispatch pin and hook
order; MCP keeps its default-deny tool filter, call-time hook delegation,
connection lifecycle, status surface and close/catch teardown, and cron targets
receive no MCP authority. Combined offline checks: typecheck/build, 116
registered behavior checks (107 main plus 9 MCP), 2 execution and 83 core
acceptance. Carried limits: no OAuth/browser sign-in or token store, no
`mcp.json` discovery or resources/prompts tools, no hot reload or lazy
reconnect, tools added after open need a reopen, and no CLI notice for a failed
server (fixed codes on the SDK `gateway.mcp` surface only). Not integrated into
main pending the combined review, which then passed `555d34c` with no material
findings. Front-door metadata/docs were reconciled for publication and the work
merged by fast-forward into main. No live MCP server, provider, credential or
production data was used; the carried limits above still hold.

### 2026-10-30 — bounded background workers (accepted and integrated)

Implemented bounded ordinary background workers as native Durable tasks on
`t3/durable-background-workers`: `nanobot.worker-run` task kind, `worker` tool
(start/list/inspect/cancel), `workers` config (`enabled`, bounded `maxConcurrent`
default 2, optional named `preset`), child conversations that keep the spawning
conversation's captured tool ceiling and chosen model, explicit `shared`/
`worktree` workspaces (generated branch/path under `<dataDir>/worker-worktrees`,
clean-base and full-repo-scope checks, no shell interpolation), terminal-commit
retirement of captured authority and one internal idempotent result event to the
spawning agent. Fourteen offline checks in
`tests/background-workers.behavior.test.mjs` cover the agreed finish line with a
faux provider and temporary git/non-git fixtures.

Review round (`74b9355`): `start` dedupes on Durable's tool-task identity, not the
provider's tool-call ID, so two turns that reuse `call_0` start two workers while a
replayed task stays idempotent. A reopen that removed a live worker's captured
model no longer leaves capture, tools or pending child work: the target is denied
and its own pending work withdrawn before scheduling resumes, the worker commits a
terminal error, and the pin is never silently replaced by the configured default;
a saved dispatch naming a removed model keeps the inherited startup refusal and is
documented rather than auto-cancelled. The worker tool carries no model-only
`callers` restriction, so general Code Mode may compose it under the same
spawning-conversation and capture checks, while a worker child still gets no
`worker` tool. Fresh independent review passed with no material findings (121
behavior, 14 new three times, 2 execution, 83 core, typecheck/build).

Owner scope correction after that review, applied in the same integration
candidate: child/background workers must also receive the native Code
Mode/tool_search compositor, composing **only** their captured (and still
configured) tools — never the `worker` tool, MCP, web, Telegram, cron or history —
so a child can neither delegate nor discover a grant it does not hold. Direct
model tools for a child stay its captured coding tools plus the bundle's own
`codemode`/`tool_search` visibility. Capture retirement, cancellation and the
removed-model denial now revoke the compositor selection in the same commit, and
a narrowed reopen leaves a live child composing only what the capture still
allows; stale nested or prepared calls fail closed through the existing hook and
replay guards. Two focused regressions cover a real nested `read` composition
with a denied nested spawn, and the narrowed-reopen callable/deferred state.

Acceptance: the final combined runtime/config/authority review passed `d27e3e7`
with no material findings, independently verifying the merge union (no main
behavior deleted), the child Code Mode authority/retirement/narrowed-reopen
rules, the docs, and the reviewed worker source remaining byte-identical to
`74b9355`. Checks at that tip: typecheck/build, 177 registered behavior checks
(16 worker checks run three times under the 60s outer bound), 2 execution and 83
offline core acceptance. Publication was a fast-forward of main to this
metadata commit; no functional source, test or dependency changed after
`d27e3e7`. Curation remains deferred with the owner's simpler shape (an editable
agent-owned workspace prompt plus a simple digestion cursor, no hash/version
machinery); no cron/worker MCP composition and no live run is claimed.

Integration candidate merges current main `dceb23f` (Telegram owner controls,
media ingress, vision, MCP, general Code Mode, web tools) into this branch.
Conflicts were only `package.json` (test registration union), `src/config.ts`
and `src/runtime.ts` (both add independent field/import/close-chain blocks) and
this plan file; the reviewed worker source and behavior are unchanged. No live
provider, bot, network, credential, dependency change, model download or
deployment was used, and scheduled memory curation remains unimplemented.

### 2026-10-30 — media ingress and configured vision handoff

Owner decisions for the next media slice: the gateway remains the sole Durable
agent owner; CLI/Telegram are separate conversation surfaces sharing the one
workspace and Markdown memory. Media follows voice, photos and documents. Photos
are accepted as normal pi-ai image content plus an adjacent labeled relative
locator, with the authoritative original image retained in the transcript; the
adapter does no vision preprocessing. Documents are saved under
`workspace/media/` only — no automatic extraction, PDF, OCR or Office libraries.
This explicitly overrides the earlier "established extraction" wording. Local
faster-whisper CPU/small/int8 transcription belongs to the separate media worker.
The main model/preset is never silently switched.

Two disjoint media work orders share config/runtime only where stated. The media
worker owns Telegram/channel ingress, transcription/media config near `telegram`,
the media config parser, `src/cli.ts`/`runTelegram` options and Telegram files.
This vision worker owns `src/media/vision*.ts`, narrow vision-only runtime
model-selection/hook wiring, `MODELS.md` vision documentation, focused vision
checks and this plan entry. Config is shared but disjoint: this worker owns
`ModelPreset.needsVisionHandoff`, the `modelPresets` parser change, and
`PortConfig.visionHandoff` plus its parser/validation near `modelPreset`; the
media worker's top-level fields and parser stay untouched.

Vision finish line: a flagged text-only preset's model-bound request carries zero
raw images and is never silently left with them; the configured vision-capable
describer receives the image; a capable target keeps only the newest bounded raw
images and gets labeled descriptions for older ones; the persisted transcript,
original evidence and prepared dispatch are unchanged; invalid, recursive or
non-vision describer config fails closed; failures and cancellation never
fabricate a seen image; cache, single-flight, concurrency, image/description
counts and output are bounded; auxiliary describer calls are disclosed. Work is
committed on branch `t3/a5ce93e2` and integrated through the merge recorded here.
Only faux-model/temp-store checks were run. No live provider, bot, network,
credentials, personal settings, dependency install, model download or deployment
was used. The gateway/CLI work was independently reviewed and landed in main as
`7b9b8a9`; this vision branch merged that tip only after the fresh vision review
passed, because the runtime Telegram source was unchanged.

Independent review did **not** pass the first vision commit `86cd25e`. It found
four material gaps: the cron background-run prepare path dropped the vision
extension; single-flight inherited the first caller's abort signal, so one
cancelled conversation could reject another live transform and, because Durable
reports a thrown generation hook and then sends the original request, leak raw
images to a flagged model; the startup prepared-model pin was never consumed, so
a later retry of the same generation task could apply a stale image policy; and
the docs claimed more coverage than the code and misdescribed the compaction
limitation. The retained original implementer fixed these in the same worktree:
the cron path selects the non-authoritative vision extension, the describer call
is service-owned with per-waiter cancellation, non-cancellation hook failures
fail closed for flagged/unresolved targets, the prepared pin is consumed on use,
and the docs now state the real text-only compaction and summary-context loss.
Focused faux regressions cover a real background cron read-tool image round, two
concurrent transforms with one cancellation, hook fail-closed behavior, and
prepared-pin consumption. A fresh independent reviewer then passed the fixed
state without material findings, independently running the 10 vision checks
three times plus 91 baseline behavior, 83 core and 26 affected checks. The
review verified native cron preparation, per-waiter cancellation, fail-closed
hook behavior and prepared-pin/retry semantics.

The reviewed vision source (`src/media/vision.ts`, `src/media/vision-hook.ts`)
and the vision hunks in `src/config.ts`/`src/runtime.ts` are unchanged from
`3043160`; merging current main (`7b9b8a9`) added only gateway/local/terminal/CLI
source and docs. Integration registers the 10 vision checks in the behavior
suite and reconciles this plan. Preserved limitations: original images,
locators and transcript evidence remain authoritative; descriptions are
request-only, so a compacted summary prefix can lose visual context even though
compaction itself serializes only text; and no full crash-retry harness proves
the prepared retry end to end (the native request/poll/retry ordering was traced
and is covered by the focused hook regression). Media adapter/transcription work
still belongs to the original media worker's fixes, and native MCP/product Code
Mode has not completed independent review.

### 2026-10-30 — Telegram media ingress (accepted, integrated)

The media worker's branch `t3/telegram-media-transcription` merged current main
`4a2616e` (merge `cc26bfc`) after its standalone fixes passed at `be6afc4`, and
added one cross-feature check on top of the 25 focused media checks. The final
combined review passed `fd6e563` with no material findings, and the metadata tip
was fast-forward published onto main. The ingress chain is `062ac68` +
`0752ea1` + `a30d1cf` -> `f0e9319` -> `be6afc4` -> `0b65601` -> `fd6e563`. The gateway
process owns Telegram and media; the adapter submits photos as native pi-ai image
content plus a labeled workspace-relative locator, stores documents unread and
transcribes voice with the local uv/faster-whisper helper. A mocked Telegram
photo reaches a `needsVisionHandoff` text-only preset: the configured vision
describer receives the original image, the main request carries zero raw images
and the labeled description, and the original stays on disk. Typecheck, build,
142 registered behavior checks, 2 execution checks and 83 offline core checks
pass; only faux-model/temp-store/mocked-fetch checks ran, with no live bot,
provider, network, credential, dependency install or model download. The
package.json union keeps all main gateway/vision/MCP registrations plus
telegram-media; `src/config.ts`, `src/cli.ts` and `SETUP.md` were the semantic
union points, with no functional conflict beyond the package.json test line.
Stored originals are never auto-deleted and there is no total-disk cap. Deferred,
reported limits: control exhaustion/reopen matrix, early-submission memory edge,
crash hard-link window, pending-only ack after eventual apply, cached failed
transcription, and two optional child cache-dir variables. Local faster-whisper
provisioning and real transcription were not executed: the helper must be
provisioned explicitly before use, and no cloud, network or model download happens
while a message is handled. The background worker agreement is unchanged: 2–3
implementers with separate reviewers, the spawning agent (not the user) is
notified whether the assignment uses a shared checkout or a worktree, and
scheduled memory curation remains later work.

### 2026-10-30 — channel surfaces and Telegram interactions

Owner clarified that the gateway itself is the single agent/Durable owner and
CLI/TUI is another conversation surface alongside Telegram and future channels.
Python's standalone CLI runtime is not the desired ownership model. Agreed
separate conversations by default, shared workspace/memory, and local
faster-whisper for later media work. Owner approved implementation and added
Telegram replies/quotes/reactions: agent chooses native reply threading; incoming
user reaction changes trigger turns. This batch is offline gateway/CLI plus
Telegram interactions; media/MCP/workers remain subsequent work. Replaced the
completed L1–L3 assignments with two bounded work orders and independent review.

Telegram worker completed `a16c962`; independent Pi / OpenCode Go / DeepSeek Flash
high-thinking review passed, independently checking 7 new interaction checks,
82 existing behavior, 2 execution and offline core acceptance. Parent fixed the
review's call-id collision finding at the root: action identity derives from the
Durable tool task id, with chat/target/payload-bound duplicate results. Parent also
kept unknown outcomes non-evictable to retain reconciliation evidence, clarified
retained-record dedupe, additional-message reply semantics and the private-chat
reaction-delivery uncertainty. Focused collision/unknown-retention checks added;
9 interaction plus 5 existing transport/typing checks pass with typecheck/build.
Integrated as `30d34f1` + `59c15d7`; manifest and authority docs updated by parent.
No broad optional test matrix or settled-text compaction added: bounded records
remain inspectable and the targeted changes cover the material findings. No live
bot/provider run. Gateway worker completed `5712c98`; independent review found
one material CLI input-loss defect (F1), fixed in `ca662bb`, and the reviewed
slice is integrated (see the integration note below).

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

For the next phase, owner approved proceeding with the existing bounded real-model synthetic acceptance runner: OpenCode Go / DeepSeek v4.1 Flash, low thinking for the product probe, at most 20 requests / 600,000 conservative input-token equivalents / 20,000 output, with offline rehearsal preflight. This is one controlled run, not parallel paid experiments; live Telegram remains out of scope. Credential presence check found no OpenCode key variable in the current environment; no credential value or file was read. Owner explicitly supplied a credential source for this run. Loaded only the selected OpenCode key into the runner environment; no value or unrelated configuration was printed or persisted.

One existing-runner live acceptance completed successfully on checkout `7fa9804`: 39/39 live checks, 95/95 whole-report checks including rehearsal/gates, 10 live requests, 348,544 conservative input reservation and 17,920 output reservation, no refused requests or budget violation. Provider-reported usage: 62,350 input / 1,629 output. Native DeepSeek v4.1 Flash (low) loaded a skill, wrote/read topic memory, produced compaction and recalled the exact early synthetic fact after fresh-process reopen, with the fact confined to the placed summary. No second experiment or retry was run. Typecheck/build and offline preflight passed. Recorded result and report digest in ACCEPTANCE.md; no credential filename/value or host path recorded there. Live reset/history-search quality, Telegram/scheduled sends, personal workspace and deployment remain unproven. Next decision: agree a hands-on pilot; no further provider spend or live sends are authorized by this completed run.

Owner chose planning a Telegram pilot and asked to reuse the previous smoke-test details. Recovered the captured 2026-10-26 session and matching historical test record: scripted live Telegram smoke completed, the owner confirmed the final reply, polling stopped, and persisted state was independently reopened. Saved private setup is still present (0600), token present and one decimal user ID valid; no token value or user ID printed or recorded here. Reuse that setup rather than asking for the same inputs again. Proposed pilot: five minutes, disposable workspace/store, configured read/write/edit (no bash), four synthetic prompts plus one reminder, existing 20-request/600,000-input/20,000-output model guard. Do not clear pending updates, alter webhooks or stop existing bot processes. Owner freshly confirmed sole polling ownership and approved the bounded five-minute live-channel run. Preflight confirmed the prior bot identity, no webhook and no pending updates; no webhook/pending-update changes were made.

Pilot startup exposed a real compatibility bug before listening: grammY passes a shim AbortSignal into Node's native fetch, which rejects it. Three startup attempts made zero model requests and zero outbound bot messages; they closed storage and released the zero-use budget. The five-minute listening window never began. Pilot paused. Started `worker-tg-transport-805e8521`, pane `w2N:p1`, workspace `w2N`, branch of the same name, from `63dce3a`: one narrow compatibility fix and offline cancellation/brand regression, no live credentials or calls delegated. Independent review required before resuming the already approved pilot. No new networking layer, configuration or dependency requested.

Transport worker completed `695fc457717320c2fb9e521d344eb52fc3d2a85f`: narrow per-call native signal bridge, preserving redirect refusal and cancellation; two offline native-fetch/data-URL regressions (both fail on unbridged transport). Worker reports typecheck/build, 2 new checks and 13 affected existing checks pass. Independent `reviewer-tg-transport-6462243d`, pane `w2D:p30`, is reviewing. New test registration remains parent-owned. Independent transport review passed: exact brand rejection reproduced offline; native pass-through, already-aborted/mid-flight cancellation, grammY timeout and per-call signal lifetime checked; no retry/unknown-send behavior changed. Reviewer ran typecheck/build, 2 new tests, existing 77 behavior and 83 offline core checks. Integrated as `63c46ea`, registered the new test in `ec86721`; parent typecheck/build, 79 behavior, 2 execution and 83 offline core checks pass. No live calls delegated.

With the reviewed transport fix, the approved pilot reached READY and polled for its five-minute window. It expired normally with 0 owner prompts, 0 outbound messages/edits, 0 model requests and no pending replies or budget violation. Owner reported a Wi-Fi outage, so this is a startup/polling/shutdown observation only, not end-to-end acceptance. No automatic pilot restart.

Owner requested Telegram typing feedback while the agent works. Next slice is a small best-effort `sendChatAction` lifecycle for active inbound user turns (including tool work), with periodic refresh and cleanup on settle/abort/shutdown. It must not delay model admission, previews or final replies, and must respect shared flood handling. No new config, queue, durable typing state or indicator for idle/scheduled-notice delivery. Add focused offline lifecycle checks and independent review before another pilot window. Started `worker-tg-typing-77c33d53`, pane `w2P:p1`, workspace `w2P`, branch of the same name, from committed base `335905fc7cc9a878b27d01b1a29da829e2ef3006`, OpenCode Go / DeepSeek Flash high. Worker completed `57e4c01f6ebfcae93e65b18bb23d1ce00c1fc6c0`: per-chat shared typing refresh, best-effort flood handling and three controlled offline lifecycle checks; worker reports typecheck/build, baseline 79 behavior, 2 execution, 83 core and 3 new typing checks pass. Independent `reviewer-tg-typing-e90e67ae`, pane `w2D:p41`, is reviewing. Independent typing review passed: single per-chat loop, timer cleanup and best-effort reply path verified; no new architecture required. A last in-flight action may expire naturally after settlement, acceptable for this feedback. Parent will correct the overly absolute non-blocking doc claim because Telegram's shared rate limit still applies, then integrate without further scope. Integrated as `6fa0000`, registered the three typing checks, and corrected the doc/comment to distinguish non-awaited typing from the shared Telegram rate limit. Parent typecheck/build, 82/82 behavior and 2/2 execution checks pass. No extra presence framework or per-loop cancellation layer added. Owner then asked to retry the Telegram pilot when finished; reopen the same bounded five-minute synthetic test (previous window consumed zero requests), with the saved single-user setup and existing budget.

The resumed pilot preserved a queued message from the allowlisted owner sent during the approved test period instead of clearing updates. Real Telegram accepted 11 typing actions, 5 messages and 1 edit. The owner confirmed the interactions worked well. The local four-prompt cap stopped polling when a fifth owner message arrived; that message was not admitted. This was not timer expiry. The cap was too tight for the guided sequence; no production behavior was changed to compensate. Paused no-dispatch store inspection confirmed skill/write/reset/history search+open/cron list activity and zero cron jobs, so reminder delivery remains unverified. Model use: 11 requests, 201,609 conservative input reserved, 16,896 output reserved; no refusal/violation and no pending replies at close. Bot is stopped; no automatic restart or extra paid run.

Recorded the narrow result in TELEGRAM.md. After owner confirmed the working interactions, cleaned the completed transport/typing workers and reviewers (4 agents, 2 clean worktrees and their patch-equivalent integrated branches). Other older unrelated resources remain untouched. A short separately approved reminder-only check was the remaining Telegram pilot item; do not repeat the whole sequence or silently renew the consumed budget.

Owner subsequently accepted this as good enough and explicitly asked to update the plan and discuss what comes next. The pilot batch is now complete by owner decision. Reminder-only live verification is deferred, not marked passed. No more testing, provider spend or implementation was started. The initial recommendation was ordinary-use setup, then reach features. Owner's subsequent annotations corrected the next priorities: gateway is channel-neutral (CLI plus Telegram, future Discord/Email), native Telegram command-menu niceties, MCP through product Code Mode, and high-priority photos/documents/voice. Memory already supports on-the-fly Markdown changes via configured read/write/edit, but not the Python-named memory tools or automatic snapshot refresh after each write. Current Code Mode is an opt-in SDK bundle only; no MCP client/config or shipped gateway installation exists. (Superseded: configured MCP connections through product Code Mode were later accepted and integrated; see the MCP entries above.) Python's voice flow is channel download -> shared transcription config/service -> provider -> labeled transcript in the normal user turn. Plan the equivalent shared ingress with one initial backend, rather than copying its provider registry. Dream was parked as a special subsystem, not rejected as a behavior: ordinary cron plus bounded background workers and memory tools should provide its essence. No implementation/live calls launched for these annotations.

Gateway integration: combined the independently reviewed gateway/CLI slice
(`5712c98` + `ca662bb`) with the approved Telegram interactions (`30d34f1` +
`59c15d7` + `d9e0a3b`) on one branch. The only integration changes are metadata and
docs: register the six new gateway/terminal checks in `test:behavior`, record the
single-owner launch in `AGENTS.md`, and update plan status. No reviewed functional
source was changed. Offline combined checks pass: typecheck/build, 97 registered
behavior checks (91 existing plus 6 gateway), 2 execution and 83 offline core
acceptance. No live provider, Telegram or deployment run; immediate-input, external
turn rendering and disconnect behavior are proven only offline.

Owner concurrency correction for following batches: run 2–3 IMPLEMENTERS, not 2–3
children total. Reviewers do not count against that implementer bound, and original
implementers are retained through review and fix rounds rather than replaced.
Parent orchestrates only. The vision handoff passed fresh independent review and
is integrated with this gateway tip. Media adapter/transcription work remains
under the original media implementer's final review (`be6`), and native MCP plus
product Code Mode wiring is accepted and integrated (see the MCP entry above).
Product background workers are under active research and coding implementation;
the spawning agent (not the user) is notified whether each implementer uses a
shared checkout or a worktree, and scheduled memory curation remains later work.
Native web search (Brave) plus fetch and the general Code Mode compositor were
later accepted (see the publication entry below); product web search remains
live-unverified.

### 2026-10-30 — Web + Code Mode compositor candidate (not published)

Combined current main `4dbc71e` (docs over `199de08`) with the web branch
(`b9e3339`) in this retained worktree. Resolution kept both `web` and
`media`/`mcp` config, selected MCP and Code Mode only for mapped ordinary chats,
made Code Mode enableable without MCP (`codemode.enabled`) while preserving MCP
auto-enablement, and kept web tools in the same mapped set. The coding ceiling
now delegates `codemode`/`tool_search` to an independent Code Mode authority hook
and `mcp__*` to the MCP hook; nested scripts compose the conversation's actual
callable set (coding, history, skill, cron, web, MCP, Telegram actions) through
native `executeTool()`/`ToolTask` hooks with no new authority. The Telegram
action tool accepts nested Code Mode callers while keeping its host,
observed-target, journal and task-binding denials.

Checks on this candidate: typecheck/build, 151 behavior checks (142 main + 9 web,
including the actual gateway MCP/Code Mode nested path, no-MCP composition and a
nested Telegram action), 2 execution and 83 core acceptance. No live Brave,
site, provider, Telegram, credential or network run. The candidate is **not**
merged or published; a fresh combined runtime/config/authority review is required
first. Product Brave search remains unverified live.

### 2026-10-30 — Native web + Code Mode compositor accepted and published

A fresh combined runtime/config/authority review of `1204226` passed with no
material findings, covering the merged MCP/media/vision/Telegram sources, mapped
chat authority, nested composition, the Telegram caller widening, cron/worker
non-grants, lifecycle and dependency union. Main advanced to the Telegram
owner-controls publication (`578dc20`); merging it preserved `/model`, `/status`,
`/new`, `/stop` and full-process `/restart`, the reset-with-rebuild path and the
restart host code while keeping both command parsing/menu and the web/Code Mode
tool wiring. Package test registration is the union (161 behavior checks: 152
main + 9 web), with
pinned `pi-mcp`, `htmlparser2` and `ipaddr.js` and no unrelated upgrades.

Small review-hygiene fixes only: corrected the stale `mcp` config comment, removed
a duplicated JSDoc opener, and moved web-test temp cleanup so failures also clean
up. Checks on the merged tip: typecheck/build, 161 behavior checks, 2 execution
and 83 core acceptance. Published by fast-forward merge after confirming main was
clean and the validated tip's ancestor. Product Brave search remains
live-unverified (one bounded example.com implemented fetch smoke only); cron and
background-worker composition remain deliberately later, and the worker branch is
still in review. No new live provider, Telegram, credential or network run.

### Session — cron conversation model

Conversation and execution are now separate for scheduled work. A recurring job keeps one
ownerless automation conversation for its lifetime and each run adds a reset-delimited episode; all
one-off jobs of an origin share one catch-all conversation and queue on it in a document-backed FIFO
(bounded at 16 admitted runs, refusing the occurrence with fixed text in the job record when full).
Runs sharing a conversation execute serially: recurring jobs keep the timer's skip-on-overlap rule
and queued one-offs wait on the native task ahead of them, so nothing is decided in memory. The run
task still owns one execution, in two phases (`claim`, `execute`), and every run prepares its own
model, workspace context and captured tools and retires them in its terminal commit, so persistent
history never carries permission. `origin` mode is unchanged.

Decisions: no document version bump — the new job/queue fields are optional and created lazily, so a
job document written by the per-occurrence model keeps working and a stale conversation ID is
recreated instead of adopted. The new class is named `automation` in the shared scope rule and
"automation conversation" everywhere else, carried by a `nanobot.cron.conversation` marker plus the
origin's cron documents rather than inferred from being unmapped. Episode cataloguing includes these
conversations; the message/tool search index and the summary policy stay mapped-chat only, so no
model call is spent on a summary nothing can read. Verified offline: typecheck/build, 309 behavior
checks (3 new in `tests/cron-conversations.behavior.test.mjs`) and 83 core acceptance. Deliberate
gaps: a restart while a one-off run is queued is reasoned from durable state, not exercised by a
test; a provider request that ignores abort keeps running in the automation conversation after its
run is cancelled (the next run queues behind it).

### Session — cron conversation model review fixes

An independent review of the conversation-model change verified nine findings against the code and
probes; all are fixed at their root rather than reworded away. Channel ingress (`conversationFor`)
now applies the shared chat-scope rule and refuses a mapped session key naming anything but an
ordinary chat, so an automation conversation can no longer become a cron owner, gain an unevictable
snapshot slot or have a live run's capture retired by the chat policy pass. A recorded automation
conversation is adopted only when its own `nanobot.cron.conversation` marker names the same origin,
class and job, read by a snapshot before the claim commit so an unadoptable pointer cannot even have
a marker written onto it (the root and an unrelated ownerless chat are both covered). A background
run rebuilds its workspace snapshot on every run instead of freezing the first run's bootstrap,
memory, skills and skill table for the process. The claim phase also removes a fenced run's queue
entry, decides capacity before creating the catch-all conversation, and refuses an unreadable queue
with fixed visible text instead of faulting the run; the prepare-failure comment now states that
the staged document writes commit, and classification happens before preparation so a failed
prepare cannot leave the conversation chat-like in memory. The reset boundary is detected from the
conversation's own newest entry, so a crash between reset and submit cannot place a second one.

Docs updated where a claim changed (CRON.md, HISTORY.md, AGENTS.md). Coverage grew to 12 cases in
`tests/cron-conversations.behavior.test.mjs`, including a queued one-off that wakes and runs in
order, a cancelled head that lets the queue proceed, queue-full and malformed-queue refusals, the
adoption guard, the single boundary on retry, `origin` mode with no conversation and no reset, a
fenced claim that leaves no queue entry, ingress refusal of a forged mapping, and per-episode
workspace context in the real gateway. Verified offline: typecheck/build, 318 behavior checks and 83
core acceptance; the three signature tests (boundary, per-run context, fenced claim) were confirmed
to fail against the pre-fix behaviour. Execution checks were not run for this fix.

### Session — cron conversation model, second review

A second independent review reproduced one major finding with a probe: the automation-conversation
class was restored *after* the mapped-chat authority pass at gateway open, so a chat key mapped to an
automation conversation was admitted as a chat, became a cron owner with an unevictable snapshot
slot, and could never be reclassified for that process (`historyEntries` accepted it and
`conversationFor` returned it with the full coding allowlist plus `cron` and `history`). The stored
session map is now read once at open, the class is restored from the map's own origins before any
mapped key is admitted as chat, adoption uses the same marker/owner/parent predicate a run uses
(`classifyAutomationConversation`), and the open path skips an automation-classified id entirely (no
`cronOwners`, no `sessionConversations`, no snapshot install). The old guard was `cronOwners.has`,
i.e. the set the authority pass had just filled, which is why it could veto the very id it had to
protect.

Also fixed: a queued one-off committed and recorded a catch-all conversation before deciding to wait,
so two same-tick claims could split the one-catch-all-per-origin record (it now commits only its
waiting state and re-reads the document when it wakes); the read-then-commit exposure of the
pre-claim marker snapshot is documented where it happens; the reopen restore shares the run's
adoption predicate instead of re-deriving it; the claim phase returns explicitly after a terminal
fence commit instead of relying on the framework refusing a second `finishRun`; the boundary scan
states `order: "descending"`; and CRON.md no longer claims a crash between `reset(...)` and
`submit(...)` can never admit a second boundary (it can, harmlessly, while the conversation is
busy).

Coverage is 14 cases: the reopened-forged-mapping case and the waiting-run case were both confirmed
to fail against the previous commit (the reopened process accepted the forged history read, and the
waiting run created conversation 17). Verified offline: typecheck/build, 320 behavior checks and 83
core acceptance; the cron file ran three times with no flakes. Execution checks were not run.

### Session — cron conversation model, third review

A final narrow round on the two remaining holes of the class the previous review fixed. (1) The
open-time class restore enumerated candidates from committed cron documents only, so an automation
conversation whose pointer was lost (damaged write, hand-edited document, store restored from an
inconsistent layout) kept its marker but was never classified, and a stale mapping to it was admitted
as chat — `historyEntries` accepted it and `conversationFor` handed out the coding allowlist plus
`cron` and `history`. The conversation's own marker now decides: every mapped conversation is
classified from its marker, the document scan only enumerates candidate IDs (a live run's target is
unmapped). Documents never decide a class, so a damaged pointer can at most fail to enumerate.

(2) The mapped-session install loop skipped only this host's automation class, unlike the authority
pass above it: a forged or stale key naming a fork, a task-owned conversation or the root still
installed a cron owner, an unevictable snapshot slot and a cron tool. It now applies the shared
`readChatScope` rule and skips those reasons; a missing conversation keeps its explicit failure, and
a forked ID leaves the mapped set so its snapshot is evictable again.

(3) The `ensureAutomationConversation` comment claimed the marker is re-read inside the commit; only
the conversation record is. It now says so, and still states what the transaction does re-check.

Coverage is 16 cases: the lost-pointer reopen case and the forged-fork reopen case were both
confirmed to fail against d5b7cad5 (the reopened process accepted the stale history read and left
`cron` on the fork), and the adoption case gained a foreign-origin/job assertion. Known gaps recorded
in CRON.md: the class restore belongs to the cron-enabled open path, so a store opened with
`cron.enabled` false does not classify one, and a `:channel-state` key stays a mapped cron owner by
design. Verified offline: typecheck, 322 behavior checks and 83 core acceptance; the cron file ran
three times with no flakes. Execution checks were not run.
