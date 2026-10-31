# Overnight handoff: five published slices and the O6 offline union gate

Date: 2026-10-31 (overnight batch started 2026-10-30). This is a handoff note,
not a new work order. It records what is usable now, how to turn it on without
activating anything by accident, what was actually measured, and the limits that
remain. `2026-10-30_lean-assistant_TODO.md` stays the work-order authority.

## Source identity

### Historical — the O6 close before the owner followup

- Base: main `ef0af84`, confirmed an ancestor of that branch. Main's only later
  commit (`a391f1c`) is a TODO/docs acceptance note; that branch did not change
  the TODO.
- Published functional tips, all ancestors of this branch:
  - O1 closed-episode input and durable cursor — `9b38b13`.
  - O2 bounded memory-digestion execution — `51de982`.
  - O3 explicit `/digest`, ordinary cron intent and internal result events —
    `ef0af84` (with `4cf846b`, `d55c9da` and the main merge in its history).
  - O4 opt-in Python-free `whisper-cli` route — `3fdd7de` (legacy
    faster-whisper default unchanged).
  - O5 local CLI `/attach` — `19ce411`.
- O6 is a docs-only close: reconfigured product docs plus this note on branch
  `t3/final-acceptance-handoff`. Functional source in `src/`, the registered
  tests, `package.json` and `package-lock.json` are unchanged from `ef0af84`.
  The delivered tip merges current main's TODO-only acceptance note
  (`a391f1c`) so publication can fast-forward; the TODO is byte-identical to
  main and was not edited here. Nothing is published to main; an independent
  fresh O6 review is still required.

### Current — the quiet-digestion followup

- The owner corrected the overnight assumption after the O6 close: a successful
  digestion run, including a successful no-op, must not notify or resume the
  origin agent; only a failed or cancelled run reports, and the outcome stays
  visible in `/digest status`. That functional change is commit `9c47bb7` on
  branch `t3/silent-successful-digests`, merged with main `8398608` (the
  TODO-only owner-followup scope) and kept byte-identical to main's TODO.
- The historical identity above — base `ef0af84` with product source unchanged —
  describes only the pre-followup O6 tip. The current branch tip is not
  `ef0af84`, so its source identity and gates are recorded under "Current
  followup acceptance run" below.

## What now exists

1. **Lossless digestion input.** Closed episodes of authenticated mapped chats
   are read oldest-first in bounded chunks, with a durable cursor. Open
   episodes, root/fork/state/raw/task-owned transcripts, worker transcripts and
   cron run targets are excluded. Fragment offsets are UTF-16 code-unit offsets
   that never end between the two halves of a surrogate pair, so the actual
   UTF-8 wire form stays valid instead of gaining a replacement character.
2. **Bounded digestion execution.** One native `nanobot.memory-digest` task
   consumes exactly one input batch in its own task-owned conversation. It can
   write only `SOUL.md`, `USER.md`, `memory/**/*.md` and
   `skills/<name>/SKILL.md` through captured `read`/`write`/`edit`, seeds
   `DIGEST.md` only when absent, and validates its own committed turn before the
   cursor advances.
3. **Explicit invocation and internal results.** `/digest` and `/digest status`
   exist in the attached CLI and for the authenticated Telegram owner. An
   ordinary `cron add` with `intent: "digest"` is the only scheduled entry. A
   terminal run admits one `nanobot.memory-digest-result` internal event to its
   origin agent only when it failed or was cancelled; a successful run, including
   a no-op, is silent and queues no channel message.
4. **Optional local voice without Python.** `media.transcription.backend:
   "whisper-cli"` selects an operator-provisioned whisper.cpp CLI with FFmpeg
   pre-decoding. Absent or `"faster-whisper"` keeps the existing uv helper and
   its configuration exactly as before.
5. **Local CLI attachments.** `/attach <path>[ -- <prompt>]` submits one
   operator-named file through the private socket and the gateway-owned media
   store. A real image becomes native image content plus a locator (the
   configured vision handoff applies); everything else, including audio, is
   stored as an unread opaque original.

## How to use it tomorrow without switching anything on

```bash
npm ci --offline
npm run build
npm start -- gateway --config config.json     # the single runtime owner
npm start -- agent --config config.json       # attach a separate CLI chat
```

- The attached CLI is its own mapped chat. It shares the workspace, Markdown
  memory, tools and media store with Telegram; it does not open a second
  runtime. A CLI disconnect leaves the gateway and Telegram running.
- **Memory digestion needs `read`, `write` and `edit` in `toolAllowlist`.** With
  an empty or narrowed list the command still answers, but with a fixed refusal
  and no run. There is no implicit grant and no model tool for starting it.
- `/digest` starts one bounded batch from the shared closed-episode backlog
  (any mapped chat, not only the caller) and returns immediately with `started`,
  `busy`, `idle` or `refused`. `/digest status` is read-only. The batch is
  curated with the caller conversation's pinned model, so it can process another
  mapped chat's episode. A start may re-admit an earlier retained issue, which
  is an ordinary origin-agent turn.
- To try scheduled digestion, ask the agent to add an **explicit**
  `cron` job with `intent: "digest"`. Nothing in config parsing or gateway start
  creates that job. No digest job exists in this repository or in any personal
  runtime as a result of this batch.
- Tune digestion through the workspace file `DIGEST.md`: it is seeded only when
  it does not exist and later edits apply to the next accepted batch. The
  shipped text is a starting point, not a managed prompt.
- **Voice:** leaving `media.transcription` alone keeps the old helper. To use
  the Python-free route, add the `backend`/`whisperCli` block from
  [setup](../SETUP.md#optional-python-free-backend-whispercpp), provisioning
  engine, model, VAD model, `ffmpeg` and `ffprobe` yourself first. The runtime
  never downloads, builds, discovers or silently falls back. Telegram voice
  notes are Ogg/Opus, which the engine cannot decode alone: the FFmpeg step is
  part of that route.
- **Attachments:** with a top-level `media` block, Telegram media ingress and
  CLI `/attach` both work. Without it, both stay off and ordinary input is
  text-only. CLI audio is stored, not transcribed.

## O6 acceptance actually run (historical, before the owner followup)

All checks are offline, use synthetic providers/fixtures and the existing pinned
dependency tree. No live provider/API call, paid operation, network fetch,
install, download, credential or personal-workspace access, runtime activation
or deployment was performed. The main checkout's existing `node_modules` was
reused read-only; no `npm ci`/prune/install and no lockfile change.

- Test registration: 31 behavior files exactly (one `test/` plus 30
  `tests/`), all present, no duplicates and none dropped; CLI, voice,
  history/memory, owner controls, cron, workers, media, MCP and web suites are
  all included. `package.json`/`package-lock.json` unchanged.
- `npm run typecheck` and `npm run build` pass.
- Registered behavior suite: **244 passed, 0 failed** under GNU
  `timeout --kill-after=5s 60s`.
- Execution suite: **2 passed, 0 failed** under the same bound.
- Offline core acceptance: **83 passed, 0 failed** (`status: pass`,
  `mode: offline-synthetic`, `network: false`) under the same bound.
- Focused union selection (the same bound, the existing files only):
  `memory-digest-controls`, `memory-digest`, `history-digestion`,
  `local-attachments`, `transcription-backends`, `telegram-commands` —
  **77 passed, 0 failed**. This is where the cross-feature stories live:
  - authenticated CLI `/digest` start plus read-only status, and Telegram
    `/digest` admission/refusal for the authenticated owner;
  - closed episode → digest turn → plain Markdown write → cursor advance →
    origin idle, with authority retired; at that time every terminal run
    (success, no-op, failure or abort) reported once, which the owner followup
    below changes;
  - explicit `cron` digest intent: one run, no task-owned conversation, empty
    channel outbox, next timer slot armed independently of the run, and
    narrowed-reopen refusal;
  - CLI `/attach` photo becomes image content and follows the configured vision
    handoff; a document stays an unread original; FIFO/oversize/mislabel
    refusals are fixed and bounded;
  - existing transcription config keeps the legacy uv helper; the new route is
    selected explicitly and refuses ambiguous/partial configuration.

No new test file, fixture/harness or package was added.

## Current followup acceptance run

Re-run on the current branch tip after the quiet-digestion wording/comment pass
and the main merge, with the same offline bounds and no new dependency, network,
provider or runtime change:

- `npm run typecheck` and `npm run build` pass.
- Focused digest selection: `memory-digest` and `memory-digest-controls` —
  **26 passed, 0 failed** under GNU `timeout --kill-after=5s 60s`.
- Registered behavior suite: **245 passed, 0 failed** across 31 files under the
  same bound.
- Execution suite: **2 passed, 0 failed**; offline core acceptance:
  **83 passed, 0 failed** (`status: pass`, `mode: offline-synthetic`,
  `network: false`).
- Focused union selection (the same six files, same bound): **78 passed,
  0 failed**.
- Current digest stories: closed episode → digest turn → plain Markdown write →
  cursor advance → a successful run (including a no-op) stays silent with no
  internal event and no origin turn → origin idle with authority retired, while
  a later failure reports exactly once; issues-only notice cap/backpressure
  retains undelivered or unknown issues, never delivers a legacy pending
  success, and reclaims its slot on the next start; reopen recovery dedupes by
  the authoritative native task and keeps the pinned model/curation scope.

## Union facts that must stay true together

- The gateway is the sole Durable/runtime owner. CLI and Telegram are separate
  mapped conversations over one shared workspace and Markdown memory.
- `/digest` backfills **all mapped chats'** closed episodes, not the caller's
  only; the caller's pinned model and thinking level run the batch.
- Digestion needs configured `read`/`write`/`edit`; there is no implicit
  authority. Its task-owned target gets no Code Mode, worker, history, MCP, web,
  cron, channel-send or shell authority; it keeps only the curation scope and
  captured Markdown tools. A terminal run retires that authority.
- Manual start is immediate; status is read-only. Flushing retained issues
  before a start may resume an origin agent turn; a successful run never does.
- A digest cron job is optional and never created by startup; an occurrence is
  not a model turn and queues no outbox delivery. Only a failed or cancelled run
  notifies the origin agent; a successful run is silent and its outcome is visible
  only in `/digest status`. Issue notification is exactly-once per failed or
  cancelled result, **not** exactly one batch per occurrence:
  a crash after start can replay into one extra bounded batch. Its next timer
  slot is committed separately, so a slow or failed run cannot stop the
  schedule.
- Retained issue notices are a delivery obligation, capped at 100 per origin:
  undelivered/unknown issues are never evicted; when no safe slot remains a
  start refuses with fixed text. A successful run's pending record is not an
  obligation: it is never delivered and may free its slot. Recovery re-admits
  from the authoritative terminal task and verifies the placed entry is this
  task's `nanobot.memory-digest-result`, because Durable dedupes by request ID
  alone.

## Accepted limitations and assumptions

Memory digestion (offline evidence only; **no real-model quality claim**):

- A turn longer than 4,000 committed entries cannot be verified and fails
  closed; more than 4,000 consecutive empty reset markers before the next
  episode is refused loudly rather than skipped.
- The first acknowledgement of an episode walks it in memory-bounded pages.
  That walk is not interruptible mid-way (SQLite ignores the context), but an
  aborted context cannot commit a cursor advance. Cross-chat order is
  best-effort under scan budgets; the cursor never skips evidence.
- Partial writes from a failed run stay on disk for an idempotent replay; they
  are not rolled back. `write` is an atomic exclusive create. `edit` keeps
  exact-text matching and in-process serialization only; an outside editor
  changing a file between read and write is not detected. The scope is a naming
  guard, not a symlink confinement.
- `DIGEST.md` is read when a new batch first submits; an in-flight attempt keeps
  the text it admitted. Existing ordinary workspace prompts still refresh only
  through the existing `/refresh`/`/new` path.
- A parked or cancelled task counts as live, so start reports `busy` until
  native retry/abort. Failure evidence may report a zero count.
- Digestion has not been run against a real provider. Accepted live evidence
  remains the earlier single core run (skill/memory/compaction/reopen) and the
  bounded Telegram pilot; neither covers digestion, so its Markdown usefulness
  and summarization judgement are unproven.

Media and voice:

- Stored originals are kept byte-for-byte and never auto-deleted; there is no
  total-disk cap. Documents and CLI audio are opaque files with no extraction or
  transcription.
- The voice route's **measured** evidence is local and fixture-input only: one
  host, one public-domain speech clip (repeated for the long-audio fixture), one
  speaker, no comparison against faster-whisper. See
  [the offline proof](./2026-10-30_local-transcription-offline-proof.md). It does
  not establish product-quality equivalence, per-language quality or a corpus
  result.
- The compiler-free engine pin is a rolling nightly prerelease; a stable pin
  means building from source. VAD is mandatory; without it silence produced
  phantom text. One deadline covers probe, decode and inference.
- `maxDurationSeconds` refuses rather than truncates, and the decoded-PCM size
  fence can falsely refuse short audio with metadata far larger than its real
  duration. That is fail-closed, not silently allowed.
- `-protocol_whitelist file` blocks network protocols but still permits local
  file references inside playlist containers; it is not filesystem isolation.
  The one private temporary WAV is removed on every path. No namespace-isolated
  offline run was possible on that host.
- The legacy uv/faster-whisper default was never provisioned or run here, so it
  remains designed-and-unverified. CLI `/attach` dedupe treats bytes with the
  same detected kind but different extensions as separate document locators.

Other carried limits: no live Telegram/Brave/provider acceptance in this batch;
Bubblewrap was not exercised. This close added no new live evidence: the earlier
stopped-store restore, bounded Telegram pilot and single live core run are
unchanged.

## Cautions for the next review

- Publish nothing to main until a fresh independent O6 review passes this branch.
- Do not add an automatic digest schedule, auto-download a model, or activate the
  voice route while checking docs: every opt-in above is explicit by design.
- Use the registered suites and their existing fixtures for further checks; the
  next useful gate is ordinary use, not more test scaffolding. Any functional
  defect found here belongs back with the original slice owner rather than a
  silent cross-slice fix.

## Doc corrections folded into this tip

- `README.md`: owner controls now list `/digest`; the integrated-feature summary
  names owner-invoked digestion and both attachment surfaces.
- `HISTORY.md`: the digestion input is no longer described as unwired/deferred;
  it states the explicit invocation boundary instead.
- `WORKERS.md`: the worker "limits" note points at the now-implemented, still
  explicit digestion slice instead of calling it deferred.
- `CODEMODE.md`: removed a stale "cron/worker composition is later work" note
  that contradicted the same document's callable-set rule and the shipped
  worker-tool composition.

No other file changed.
