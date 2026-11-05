# Automatic system-memory context — 2026-11-05

**Machinery implementation approved.** The owner chose automatic system Markdown
loading whenever `workspaceContext` is enabled, with no new flag. Keep bootstrap
and the topic **memory tree**; leave stale-note cleanup to the assistant separately.
This supersedes the default-off flag and pre-implementation content-review proposal
below. The owner subsequently authorized commit and merge. No production config edits,
service changes, deployment or restart.

## Checklist

- [x] Trace actual config, discovery, rendering, snapshot lifecycle and consumers.
- [x] Inspect the current default config's relevant fields and system notes read-only.
- [x] Run existing bounded offline context checks; write this proposal.
- [x] Owner approves automatic discovery machinery and leaves note cleanup out of scope.
- [x] Implement automatic system-memory loading and focused regressions.
- [x] Independently review the implementation; fix the finding, run offline validation and reconcile docs.
- [ ] Obtain separate approval for eventual runtime activation; no note cleanup in this task.

## Verified current behavior

At source revision `2587ff05`:

- The inspected fixed-default config matches the reported `memoryFiles: []` and
  `memoryManifest: true`. Relative workspace resolution is against the config's
  directory (`src/config.ts:loadConfig`), not the shell's working directory.
  Running-service arguments/effective config were not inspected or changed.
- `src/context/workspace.ts:loadWorkspaceContextSnapshot` reads optional root
  `AGENTS.md`, `SOUL.md`, `USER.md`, then only individually selected memory files,
  in configured order. There is no glob, directory selection or automatic system
  memory loading. Missing explicit files fail; empty bodies are omitted.
- `src/context/memory.ts:scanTopics` skips every directory named `system` and
  files named `MEMORY.md`/`HISTORY.md`. The manifest does **not** discover these
  system notes with an empty selection. Its “always-loaded” terminology, and the
  digest routing prompt's same claim, describe intent, not an implemented loader.
  Recall's separate notes reader does include system notes on demand; that is not
  automatic assistant context (`src/memory/notes.ts`, `MEMORY_RECALL.md`).
- `src/context/workspace-host.ts` passes actually injected configured paths as
  `loadedFiles`, appends one manifest, and never injects topic bodies. Manifest
  paths are set-deduplicated and sorted; there is no paragraph/content deduplication.
- `src/context/index.ts` renders complete bodies with relative source labels.
  There is no file/body/token budget or renderer clipping. Path bounds remain:
  246 characters, 64 per segment, 8 segments. Manifest discovery alone has a
  4,096-inspected-entry stop with a visible partial-scan notice; it is unsuitable
  as the source of an “all system files” guarantee.
- `src/runtime.ts:installContextSnapshot` captures mapped-chat context once per
  process, not per turn. New sessions and gateway reopen load current files;
  idle CLI `/refresh` replaces one snapshot; `/new` rebuilds and resets atomically
  on CLI/Telegram/Discord. Busy refresh/reset is refused; refresh failure retains
  the previous snapshot. Background cron preparation and ordinary-worker preparation
  also use this provider. Worker context comes from the host workspace even when
  the worker's execution cwd is a worktree. Digest uses its separate curation path.

**Decision:** naming today's files in `memoryFiles` needs no code change, but
cannot cover future additions automatically. The shipped config has no existing
switch that meets that requirement. A custom SDK snapshot provider could supply
its own discovery without changing Durable's runtime, but adds custom host code;
prefer a small extension to the existing loader, not another provider/framework.

## Original proposal (automatic loading now supersedes the new-flag proposal)

1. Add one default-off boolean, proposed name
   `workspaceContext.systemMemory: true`, forwarded to an equivalent optional
   `WorkspaceContextRequest` field. Keep absent/false behavior, `memoryFiles: []`,
   explicit list validation/order/errors, SDK callers and manifest opt-in unchanged.
   Do not overload `memoryManifest`, auto-enable it, or add general include globs.
2. On **each snapshot load**, recursively discover regular files ending exactly
   `.md` beneath `memory/system/` (including nested/hidden names and otherwise
   protected basenames). Missing subtree means no additions; never create it.
   Preserve configured memory order, append discovered paths in deterministic
   locale-independent workspace-relative lexical order, omitting paths already
   explicitly selected. Bootstrap stays first; manifest stays last. Each nonempty
   body appears once, with existing provenance. No text/paragraph dedupe: identical
   text in different files remains distinct evidence, not an excuse to drop a source.
3. Discover/read within the existing Linux pinned-dirfd workspace loader, not the
   weaker topic scanner or shell glob expansion. Preserve no-follow traversal,
   single-link regular-file checks, fatal UTF-8 decoding and final file/directory
   revalidation; track enumerated directories too, including an empty system root.
   Ignore non-Markdown ordinary files; reject unsafe Markdown candidates and
   symlinked traversal rather than claiming complete loading after skipping them.
   Reject unrepresentable subtrees, invalid/deep/overlong Markdown paths and
   observable scan/read changes; never silently skip a subtree that could contain notes.
   Use an explicit 4,096-inspected-entry discovery fence, failing the entire load
   rather than returning a truncated set. Missing explicit selections still fail.
   Preserve relative, content-free typed errors and no-partial-install behavior.
   Metadata checks retain existing filesystem/TOCTOU limits; no atomic-tree claim.
4. In `workspace-host.ts`, derive manifest `loadedFiles` from actual workspace
   memory documents in the finished snapshot, not just the configured list. This
   includes discovered files even though topic discovery skips `system/`; empty
   files are not marked loaded. Keep one metadata entry per path and no duplicate
   bodies. The current manifest separately rereads files for descriptions and may
   fail if a loaded file disappears; do not claim cross-loader atomicity.
5. Keep snapshot freshness unchanged: later additions/edits/removals appear at the
   next new-session, idle refresh, `/new`, reopen, or background preparation boundary.
   Existing chats do not acquire them merely on the next ordinary message. No
   watcher, hot reload, mid-turn replacement or automatic refresh of other chats.
   **Owner must accept this meaning of “always loaded”.** If every generation must
   see filesystem changes automatically, pause for a separate design of safe native
   generation-boundary refresh, including steering, queued turns and replay; this
   proposal does not promise that stronger behavior.
6. Update `WORKSPACE_CONTEXT.md`, `MEMORY_CONTEXT.md`, `SETUP.md`, config comments
   and digest routing wording to distinguish opt-in injection from topic exclusion.
   Do not silently enable the example or production config. Reuse existing runtime
   install/refresh paths; do not change tool grants, recall scope or task classes.

## Earlier content-risk inventory (cleanup deferred by owner)

Read-only inventory found three regular, single-link system notes:
`corrections.md` (24,124 bytes), `now.md` (13,406), `procedures.md` (7,551):
**45,081 bytes** of additional raw text before prompt framing. This is a byte
measurement, not a token count. Root bootstrap adds 24,130 bytes; skills, manifest,
tools, conversation and output reserve need further room. Check the fully assembled
prompt against every intended foreground/worker/cron model, especially the smallest
window; assess latency, provider privacy and recurring input cost. Compaction cannot
make an oversized fixed prompt small. Keep full-body semantics: curate/rehome bulky
material with approval rather than introduce silent clipping or arbitrary body caps.

The current workspace `AGENTS.md` already identifies Durable as authoritative, but
adding contradictory prose to the same prompt is not made safe by render ordering.
Review at least:

- `procedures.md`: Dream ownership/eight-hour consolidation, protected heartbeat,
  JSONL as ongoing history, universal cron preset, old isolation/message-send APIs,
  legacy tool names, Python-fork repository workflow and broad staging instructions.
- `corrections.md`: watchfiles/model hot-reload assumptions, Python session redaction
  and tool-output limits, shell/SSRF configuration advice, cron timeout/silent-failure
  claims, and assertions that workers receive no bootstrap/memory. Some are explicitly
  inconsistent with current Durable code; retain only verified, correctly scoped rules.
- `now.md`: outdated port/background-memory status, legacy model/service/schedule
  assertions and dated reminders. Treat remembered live state as unverified, not an
  instruction to recreate schedules or touch either bot.
- Reconcile with workspace `AGENTS.md`, `SOUL.md`, `USER.md`, `DIGEST.md` and current
  repository instructions; preserve useful owner preferences, not obsolete mechanics.
  Do not copy personal note bodies or sensitive host/credential details into project docs.

Owner must approve the curated content and its exposure to **all admitted chats and
provider-backed worker/cron contexts using this shared host workspace**, not just the
current chat. New files would gain the same prompt influence at the next load, including
files written by ordinary coding tools or digestion. This directory is a trusted
curation surface, not a new authority grant or a hostile-writer isolation boundary.
No cleanup, permission change, schedule activation or migration is part of this plan.

## Validation scope

Existing synthetic, temporary-workspace checks cover the machinery; no new flag:

- Workspace context absent compatibility and existing explicit ordering;
  recursive deterministic discovery, added/edited/deleted files across successive loads,
  missing/empty tree, case-sensitive suffix, Unicode/spaced/hidden paths, empty bodies,
  explicit/discovered overlap, protected basenames and unrelated topics staying on demand.
- Unsafe links/ancestors, nonregular candidates, unreadable/invalid UTF-8, locator/scan
  fences and controlled directory/file replacement; refusal never installs partial context.
- Capture the actual synthetic-provider prompt: each body once, each manifest loaded
  entry once, no empty file marked loaded, manifest off still loads automatic system files.
- Gateway new session versus unchanged existing snapshot; idle refresh and `/new` pickup,
  busy refusal and failed-refresh rollback, reopen reconstruction, worker/cron snapshots
  and unchanged root/fork/task authority. Preserve digest's separate policy and recall scope.
- No sleep-based races, live providers, personal-workspace test writes or service checks.
  Reuse existing test files/synthetic providers and controlled gates, with cleanup/timeouts.

Run `npm run typecheck`, `npm run build`, bounded focused context/lifecycle checks,
then the registered behavior, execution and offline core-acceptance suites. Independent
implementation review precedes any separately authorized integration/activation.

## Log

### 2026-11-05

- Completed source/config/note inspection and this plan. Owner authorized leaving the
  pre-existing untracked channel TODO untouched; no existing file was edited.
- Baseline passed: typecheck, build and **41/41** existing tests across
  `context.workspace`, `context.workspace-host`, `context.skills-memory` and
  `context.identity` (GNU timeout 60s, kill grace 5s). These validate current behavior,
  not the unimplemented proposal; broader suites and live acceptance were not run.
- Planning phase made no source/config/service/deployment changes, merge, restart or
  personal-data model calls. Implementation was subsequently approved as recorded below.

### 2026-11-05 — approved machinery implementation

- Owner chose automatic loading with the existing `workspaceContext` opt-in; no
  `systemMemory` flag or production config edit. Confirmed the term is **memory tree**.
  Content/heartbeat/cron cleanup is explicitly outside this machinery task.
- Implemented recursive pinned-directory discovery, lexical ordering, explicit-path
  deduplication, whole-load safety refusals and actual injected-file manifest entries.
  Bootstrap, topic-body exclusion, snapshot freshness and tool authority are unchanged.
- Added six registered regressions in the existing workspace/host test files, covering
  discovery, freshness/startup/reset/refresh rollback, manifest inclusion, bounds, unsafe
  files, controlled directory replacement and invalid filename-byte collisions.
- Independent reviewer found one material bug: lossy UTF-8 filename decoding could
  alias an invalid name to a valid file/subtree. Fixed locally using byte-preserving
  enumeration and UTF-8 round-trip validation; the new regression covers both file
  and directory twins. No findings waived; no second delegated review of this small fix.
- Final checks passed: typecheck/build, **47/47** focused context checks, **541/541**
  registered behavior checks, **2/2** execution checks, **83/83** offline core acceptance,
  and diff whitespace validation. No live-provider or personal-workspace tests.
- Owner subsequently authorized committing and merging this task. Integration targets
  local `main`, preserving its two already-fetched upstream cron-delivery commits.
  The unrelated channel TODO remains untouched and excluded from the commit.
- No note cleanup, runtime config edit, service change, deployment or restart.
  Activation still requires separate explicit approval.
