# Parity close: P1–P7 handoff and combined offline acceptance

Date: 2026-10-31. This is a handoff note, not a work order.
`2026-10-30_lean-assistant_TODO.md` stays the single work-order authority; P6's
checkbox and any follow-up items belong to the parent. The note records what is
usable now, how to turn each part on without activating anything by accident,
what was actually measured, and which limits and live gaps remain.

## Source identity

- Base: main `3bace35` (`Accept published bounded background status summary`),
  confirmed an ancestor of this candidate.
- Published functional tips, all ancestors of this tip:
  - **P1** configurable digest bounds — `3a297fa`.
  - **P2** Telegram outbound local documents/photos/audio/video/voice — `c755673`.
  - **P3** bounded worker transcript reads — `ba6df4e`.
  - **P4** worker steering — `54b2331`.
  - **P5** bounded background summary inside `/status` — `7caa613`.
  - **P7** user-systemd service readiness and parallel instances — `5213837`.
- **P6** is this docs-only close. `src/`, `tests/`, `test/`, `scripts/`,
  `systemd/`, `package.json`, `package-lock.json` and `tsconfig.json` are
  identical to `3bace35`; the whole delta is `SETUP.md`, `TELEGRAM.md` and this
  file. The commit that adds this file is the P6 doc tip
  (`git log -1 -- plan/2026-10-31_parity-handoff.md`).
- The P1/P2/P3/P4/P5/P7 functional tips are already ancestors of main
  `3bace35`; only this docs close is still unpublished. A fresh independent
  review of this combined union passed clean, so publication is a fast-forward of
  this docs-only tip. The parent owns publication and the TODO.

## Active by default vs opt-in

Active once a valid config is loaded:

- The gateway as the single runtime owner: storage, config-scoped tool policy,
  context snapshots, cron foundation, local Unix socket, CLI attach.
- Markdown workspace memory, the read-only `history` tool on mapped chats, native
  compaction and episode summaries. Episode summaries use the conversation's
  current model and cost provider calls; `episodeSummary.enabled: false` turns
  them off. Already-closed episodes are not backfilled.
- Owner commands: `/status`, `/new`, `/abort` (`/stop` with the alias),
  `/model`, `/restart` where the host implements it, `/help`, and `/digest` /
  `/digest status` (the digest forms still refuse without `read`, `write` and
  `edit`).

Opt-in, each switched on by its own config block and nothing else:

| Capability | Switch | Notes |
| --- | --- | --- |
| Coding tools (`read`/`write`/`edit`/`bash`) | `toolAllowlist` | Empty/absent disables; the only coding-tool authority. |
| Cron scheduling and delivery | `cron.enabled` | Installs the `cron` tool; no job is created by startup. |
| Telegram | `telegram` block | Explicit decimal owner allowlist; private chats only. |
| Media ingress and outbound files | `media` block | Transcription stays off unless provisioned; outbound `send` also needs `read`. |
| Digest bounds | `digest` block | Bounds only; never enables or schedules a run. |
| Background workers | `workers.enabled` | Installs the `worker` tool; `maxConcurrent` 1–4, default 2. |
| MCP | `mcp.enabled` + servers | Separate connection authority; not under bwrap. |
| Code Mode | `codemode.enabled` | Follows MCP when the block is absent; grants no new authority. |
| Web search / public fetch | `web.search.keyEnv` / `web.fetch` | Default-off, mapped chats only. |
| User systemd service | copy `systemd/*.service` | Static examples; the repository installs nothing. |
| Python-free voice backend | `media.transcription.backend` + `whisperCli` | Operator provisions engine/model/VAD/FFmpeg. |

## Running it without switching anything on

```bash
npm ci --offline
npm run build
npm start -- gateway --config config.json     # the single runtime owner
npm start -- agent --config config.json       # attach a terminal to it
```

- Without `--config`, `gateway`, `agent` and `recovery` read
  `~/.durable-nanobot/config.json`, resolved from the runtime user home, never
  the working directory. There is no discovery, merge or auto-generation, and a
  missing file fails with fixed, value-free text.
- A CLI disconnect leaves the gateway and any Telegram polling running. Two
  gateways on one store are refused by the live-owner lock instead of
  half-starting.

Secondary instance (no service activation):

```bash
npm start -- gateway --config ~/.durable-nanobot/instances/i-work/config.json
npm start -- agent   --config ~/.durable-nanobot/instances/i-work/config.json
```

- Give every instance its own config, `dataDir`, workspace and socket; the
  socket is derived from that `dataDir`, and the store refuses a `dataDir`
  inside the workspace or an extra allowed root. Independent instances are
  separate processes, not multi-tenancy.
- The shipped user units mirror that layout: `systemd/nanobot.service` runs the
  primary default config, `systemd/nanobot@.service` maps an instance name to
  `~/.durable-nanobot/instances/i-<name>/config.json`. The literal `i-` prefix
  keeps a dot-like instance name inside a real directory.
- To check a unit without starting anything, use `systemd-analyze verify` on an
  edited copy. Installing, enabling, starting, reloading the user manager or
  enabling lingering are operator steps outside this repository and were not
  run here. Every unit stops the gateway with the existing SIGTERM teardown:
  the socket closes, attached CLIs detach, accepted work and queued input stay
  in the store, and the lock is released.
- Two pollers need two bot tokens. Sharing a provider key shares its quota; it
  is not a security boundary, and same-user instances are not isolated from each
  other by file permissions.

## Digest: invoking it and bounding it

- `/digest` (CLI, or the authenticated Telegram owner) starts **one** bounded
  closed-episode batch from the shared mapped-chat history and returns at once
  with `started`, `busy`, `idle` or `refused`. `idle` with `caughtUp: false`
  means closed history may remain; nothing loops to exhaustion.
- `/digest status` is read-only: live run, this chat's newest run, batch
  position, evidence count, recorded error, retained issue-notice count and
  whether a new start is possible. No scan, model call or cursor change.
- A batch needs `read`, `write` and `edit` in the current `toolAllowlist` for a
  mapped chat origin. Narrowing the allowlist narrows the run; it never widens.
- Scheduled digestion is only an explicit `cron add` with `intent: "digest"`. It
  creates an ordinary origin-mode job; no startup pass creates one, and the
  occurrence queues no channel delivery.
- One `digest` config block bounds a run, with these accepted defaults:
  `entriesPerBatch: 80`, `charsPerBatch: 24000` (UTF-16 units, minimum 2),
  `maxToolCalls: 10` individual calls, `runTimeoutSeconds: 300`,
  `maxChangedFiles: 8`, `maxDiffChars: 32000`. A started run captures what it
  accepted, so a narrowed reopen never widens it. `DIGEST.md` is seeded once
  when absent and edits apply to the next accepted batch.
- Reporting is issues-only: a failed or cancelled run admits one bounded
  internal event (`nanobot.memory-digest-result`) to its origin conversation and
  the agent decides what to relay. A successful run, including a successful
  no-op, is silent and starts no origin-agent turn; its outcome stays in
  `/digest status`. Up to 100 undelivered/unknown issue records are retained per
  origin and never evicted; when no safe slot remains a start refuses with fixed
  text. An ordinary start retries a parked task once at the native layer.

## Telegram outbound files

- The scoped `telegram` tool keeps `targets`, `reply` and `react`; `send` exists
  only when the top-level `media` block is configured **and** `toolAllowlist`
  contains `read`, so it adds no read grant. It is offered only in an
  authenticated mapped private chat with a live adapter.
- `send` uploads one existing workspace file, unchanged. Omit `kind` to send any
  file as a document; `kind` may be `document`, `photo`, `audio`, `video` or
  `voice` as a presentation hint, and native kinds keep a short extension
  allowlist because nothing is converted. An optional caption is bounded
  (1,024 characters) and an optional observed `messageId` threads the upload.
- Refusals are pre-send and fixed: absolute path, `..`, symlink escape,
  non-regular file, empty file, more than 20 MiB, or a kind/extension mismatch.
  Bytes are pinned before the call, so a later write or growth cannot change what
  is uploaded. There is no remote URL, Telegram file-id reuse, arbitrary
  recipient, extraction, transcoding or automatic kind detection.
- The action is write-ahead recorded and declared unsafe to replay. An ambiguous
  outcome is retained as `unknown` and never evicted; a repeat of the same action
  identity resolves to the stored record instead of resending.

## Workers: transcript and steering

With `workers.enabled: true`, the `worker` tool offers `start`, `list`,
`inspect`, `transcript`, `steer` and `cancel`:

- `transcript` takes only a `worker_id` from this conversation's own records, plus
  optional `before` and `limit`. It verifies that the task is this
  conversation's `nanobot.worker-run` task and that the child conversation is
  owned by that exact task before reading anything. There is no arbitrary
  conversation/task ID parameter, no export and no second archive.
- One page is at most 20 entries (default 20), 1,200 characters per entry and
  48 KiB rendered. Pages are ordered and non-overlapping; the newest page needs
  no cursor, and the reply names the `before` entry ID for the next older page or
  says none remain. Entries are labeled untrusted data; image-only and binary
  entries are omitted with a count.
- `steer` sends one bounded direction (at most 2,000 characters, 8 accepted per
  worker) to a worker that is live in a model run; terminal, completing,
  cancelled and foreign workers are refused. Admission is one native commit that
  re-verifies spawner/child ownership and the live run before appending the inbox
  item, so it cannot race the worker into an orphan turn. A queued steer is
  withdrawn on cancel or a failed turn and cannot start a successor run under
  retired tools.
- Dedupe uses the conversation-scoped request ID
  `nanobot.worker-steer:<workerTaskId>:<hostToolTaskId>` and stores only a
  SHA-256 of the text. A replay with the same text returns the first acceptance;
  the same identity with different text is refused with a fixed reason. Worker
  results still arrive as one internal event; the agent remains the manager.

## What `/status` means

Both the attached CLI and the authenticated Telegram owner get the same bounded,
read-only view — no model call, no watch or timer, no transcript, prompt, tool
argument, host path, credential or other-chat data:

- the selected model/preset, whether a turn is running (turn number, input
  count), how many native inputs are queued, running/pending model tools and
  compaction count;
- a `Background:` headline that names this conversation's live and parked workers,
  its executing/queued/parked cron runs, and whether the one workspace-global
  digest run is live in this chat or another;
- `Background: idle` means nothing is executing or queued right now; an armed
  future cron occurrence is its own following `Cron:` line with the next due
  time, and a natively blocked task is named parked rather than counted as
  running;
- detail rows are capped (4 worker rows, 4 executing-run rows, 80 characters per
  name/task label, 600 characters for the whole block) with honest truncation.

`/status` never starts, cancels, retries or reorders anything. The agent remains
the manager of that work; there is no dashboard or recovery UI.

## Combined acceptance actually run

All checks are offline, use synthetic providers/transports/clocks and temporary
stores, and ran on this candidate with the existing pinned dependency tree. The
main checkout's `node_modules` was reused read-only (symlinked); there was no
`npm ci`, install, prune or lockfile change. Every phase ran under GNU
`timeout --kill-after=5s 60s`.

- Test registration: exactly **35** behavior files (1 under `test/`, 34 under
  `tests/`), all present, no duplicates, none dropped; `tests/execution-deadline`
  stays in the separate execution suite and `tests/fixtures/*` are fixtures, not
  suites.
- `npm run typecheck` and `npm run build` pass.
- Registered behavior suite: **286 passed, 0 failed**.
- Execution suite: **2 passed, 0 failed**.
- Offline core acceptance: **83 passed, 0 failed** (`status: pass`,
  `mode: offline-synthetic`, `network: false`).
- `git diff 3bace35..<tip> -- src tests test scripts systemd package.json
  package-lock.json tsconfig.json` is empty; the delta is `SETUP.md`,
  `TELEGRAM.md` and this note, so no functional identity changed and no
  dependency moved.

## Accepted limitations

Digestion:

- Budgets are conservative UTF-16 text-unit accounting, not a git diff; there is
  no path-alias resolution, so aliases can under- or overcharge.
- A turn longer than 4,000 committed entries cannot be verified and fails
  closed, and cross-chat ordering is best effort under the scan bounds.
- The bounded gap check between the previous frontier and the next closed
  episode examines up to 4,000 entries. A conversation with more than 4,000
  consecutive empty `pi.reset` markers before that episode is refused loudly
  rather than assumed: the same evidence is offered again, the cursor stays
  unchanged, and no evidence is silently skipped.
- Partial writes from a failed run stay on disk for an idempotent replay; there
  is no rollback. `write` is an atomic exclusive create, but `edit` keeps exact
  text plus in-process serialization only — an outside editor changing the file
  between read and write is not detected. The curation scope is a naming guard,
  not symlink confinement.
- A cancelled or parked run counts as live, so `start` reports `busy` until the
  native task is retried or aborted. A crash after a cron occurrence started can
  replay into one extra bounded batch.
- No nested digest tools: a run gets only captured `read`/`write`/`edit` with
  the curation scope.

Telegram outbound files:

- No Bot API idempotency key exists, so an ambiguous upload is retained for
  reconciliation, never blindly retried; unknown records are never evicted.
- Live delivery, format acceptance and current service upload limits are
  unverified; the offline checks use a mocked Bot API.
- Path resolution and open are separate host calls: a local process racing the
  workspace parent directories is not fully excluded (Node has no `openat`),
  though the final component is opened with `O_NOFOLLOW`.
- A bounded display name is truncated in UTF-16 units and does not transcode.

Worker transcripts and steering:

- A transcript page is a bounded view, not a live stream or complete archive,
  and may lag entries that are not committed yet.
- Steering admission mirrors Durable's busy/`whenBusy: "steer"` branch over
  public submission and inbox primitives; it emits no submission trace link
  (telemetry only).
- The join supports the shipped `afterFailedRun: "keep"`. The Harness
  `afterFailedRun: "continue"` override is unsupported and not configurable
  here, and there is no worker deadline.

`/status`:

- A native task whose state cannot be classified by the renderer (for example a
  worker parked for a reason other than the restart limit) is covered by renderer
  tests only.
- One snapshot may take up to two live-task index scans, and it is not atomic
  across its parts: a job that starts or settles mid-render can appear in one
  section and not another.

Service:

- Static `systemd-analyze verify` only; no unit was installed, enabled, started,
  reloaded or lingered, and live journal/stop/restart behaviour is unverified.
- Same-user instances are not a security boundary; isolated `dataDir`,
  workspace and socket are the separation, and memory/attachments stay separate
  only because each instance is configured with its own workspace.

## Still unverified live

- No live provider, model, paid call, network fetch, Telegram traffic, systemd
  operation or installation happened for this close or for P1–P7.
- Telegram outbound file delivery/format and the service's current upload limits;
  live private-chat reaction updates; Brave search; public fetch against real
  hosts; configured MCP servers.
- Digest and summary quality, and general real-model memory recall: the offline
  evidence proves plumbing and bounds, not usefulness.
- Live scheduled delivery and reminders. Earlier live evidence — the single
  synthetic core run, the bounded Telegram pilot and the older Telegram smoke
  check — is unchanged and does not cover these slices.

## Doc corrections folded into this tip

- `SETUP.md` Telegram section: the controls list now names what the shipped host
  implements (`/new`, `/abort`/`/stop`, `/status`, `/model`, `/digest`,
  `/restart`) instead of only `/new`, `/abort` and `/help`, and the stale claim
  that `/new` does not re-read files is replaced with the shipped behaviour
  (reset plus assembled-prompt rebuild; a gateway restart is what re-reads
  configuration).
- `SETUP.md` refresh/reset section: the surface is now explicit — the CLI's
  `/new` resets without re-reading files, while the Telegram owner's `/new` also
  rebuilds that chat's assembled workspace prompt — so the two SETUP passages
  cannot be read as contradicting each other.
- `SETUP.md` config table: the `digest` row now states the accepted default
  bounds and that `maxToolCalls` counts individual calls, matching
  `config.example.json` and the shipped defaults.
- `TELEGRAM.md` attachments section: its `send` cross-reference pointed "above"
  at a section below it; it now links to the native-actions section.

No other current document contradicted shipped behaviour when checked against
the code paths for digest bounds, quiet success, Telegram sends, worker
transcript/steer, `/status`, the default config path and the user units.

## Cautions for the next review

- Publish nothing to main until a fresh independent review passes this union.
- Do not activate a service, create a digest cron job, provision a voice engine
  or run live Telegram polling while checking docs; every opt-in above is
  explicit by design.
- Use the registered suites and their existing fixtures for further checks; more
  test scaffolding is not the next useful gate.
- A functional defect found while reviewing belongs back with the original slice
  owner as a concrete reproduction, not as a silent cross-slice fix.
