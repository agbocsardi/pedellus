# Rebuild nanobot on Pi Durable (TypeScript)

Status: **Gate 1 partially proven** on `feat/pi-durable-rebuild`: runtime and
real Telegram/scripted-model slice verified; execution, tool replay, and real
provider gates remain open. Full-port roadmap/scope now recorded in
[`2026-10-26_full-port_TODO.md`](2026-10-26_full-port_TODO.md); that is the forward
plan, this file retains spike evidence. Production cutover remains unapproved.
Package design and worker boundaries: `packages/pi-nanobot/DESIGN.md`.
Scope: replace nanobot's Python harness (`agent/loop.py`, `agent/runner.py`,
`session/`, tool durability, subagents) with `@earendil-works/pi-durable` 1.4.0,
porting the product surface to TypeScript.

## Why this is even plausible

Durable already provides, natively, what nanobot hand-built:

| nanobot now | Durable equivalent |
|---|---|
| `AgentLoop` + `AgentRunner` state machine (`TurnState`, 5.3k LOC) | `Harness` + built-in `pi.generation` / `pi.tool` / `compaction` tasks |
| `session/recovery.py` (940), checkpoint dicts in `loop.py`, pending-followup journal | task checkpoints + `harness.resume()` + `requestId` exactly-once submissions |
| `tools/action_receipts.py` receipt ledger (in_flight / unknown / replayed) | tool task intent commit + `replay: "safe" \| unsafe"` |
| `AgentHook` / `CompositeHook`, `progress_hook.py` | extension `hooks` (`beforeTool`, `afterTool`, `beforeRequest`, `onYield`, `afterTools`) + `wraps` |
| `subagent.py` (1.2k LOC), run records, retry/cancel | task-owned conversations (examples 21/22), background anchors, `abort` cascades |
| Python Code Mode + bwrap script worker + artifact store | `pi-durable/codemode` (QuickJS, journaled replay, nested calls as tasks) |
| WebUI runtime-event bridge, session projection, gateway services | `watch()` / `watchDoc()` / `watchEvents()` + committed ops |
| `session/compaction.py`, `microcompaction.py`, `autocompact.py`, Consolidator archiving | compaction task + `settings.compaction` + `pi.compaction` entries |
| model presets per session | `conversation.configure({ model, tools, extensions, instructions, cwd })` stored in `pi.agent` |
| fork plumbing (`webui/forking.py`, `fork_events.py`) | `conversation.fork(entryId)` |
| deferred MCP tool discovery in `codemode.py` | `tool-search` extension + `deferred` tools + `modelTools` |
| cron service (~1.3k LOC) | `runtime.sleepUntil()` durable timers (semantics still ours to port) |

Original hypothesis: roughly 12–13k Python harness lines might be replaced by
~2–3k TS wiring lines. This is not measured savings or a full-product estimate;
use the evidence-gated full-port roadmap, not these numbers, for planning.

## What does NOT come for free (the actual project)

1. **Execution environment + security.** `NodeExecutionEnv` does *not* confine
   paths. Implement `ExecutionEnv` that keeps:
   - `_resolve_path`-equivalent workspace/`extra_allowed_dirs` confinement,
   - bwrap sandboxing for shell (`.agent/security.md` rule),
   - `validate_url_target` SSRF gate for all `web_fetch`/`search`/MCP HTTP.
   Without this the port is a security regression. Highest priority.
2. **Channels** (Telegram 2.8k, Discord 1.1k, Email 0.9k, WS/programmatic),
   pairing store, notification routes, media handling, streaming edits,
   typing/reaction proxies. All rewritten against `watch()`.
3. **Memory + Dream.** MEMORY.md / SOUL.md / USER.md / topic files,
   `history.jsonl` archive with per-archive usage deltas, Dream run with
   snapshot/rollback, diff limits, dedupe cursor. Durable gives atomic
   *commits*, not atomic *workspace file writes* — Dream still needs its own
   snapshot/rollback around the task.
4. **Cron + heartbeat** semantics (timezone, add/list/remove, session
   delivery) on top of `sleepUntil`.
5. **Commands** (`command/builtin.py`, 1.5k), skills loader, image generation,
   transcription, MCP OAuth/presets, CLI apps, self-modification tool.
6. **Providers.** pi-ai covers Anthropic/OpenAI/OpenRouter/etc. Fork-specific
   `opencode_zen`, `opencode_go`, `umans`, `xiaomi_mimo`, `zai`, `deepseek`,
   `dashscope`, `minimax` are OpenAI-compatible gateways → custom
   `Provider`/base-URL entries. Must be verified one by one, incl. the
   `umans` image-budget quirk currently special-cased in `runner.py`.
7. **Deploy.** Node ≥ 22.19 on `uhl`, systemd unit change, session data
   migration (SQLite/JSONL vs `memory/history.jsonl` + session files).

## Risks / blockers to accept explicitly

- `pi-durable` is **experimental**; API breaks between releases. Every package
  is pinned to 1.4.0 (`chord`, `pi-ai`, `pi-codemode`, `pi-telemetry`).
- Upstream requires one storage owner and supplies no cross-process locking.
  This spike now adds OS-backed owner exclusion. The gateway is the single
  owner and clients attach; never open a second writable Harness for the UI.
- Interrupted non-replay-safe tools now report "interrupted" to the model
  instead of nanobot's auto-continue-at-checkpoint. Behavior change users see.
- Tool-call doctoring in `runner.py` (false-success suppression, failure
  verification, orphan result backfill, policy-block verdicts, vision
  handoff, per-model request quirks) is real accumulated behavior. Some maps
  to `onYield`/`afterTools` hooks; some has no equivalent and would be lost
  unless re-implemented.

## Plan (gated)

- [ ] Gate 1 — spike, throwaway (original estimate ~2–3 days, unverified):
  - [x] Establish isolated TypeScript package, pinned dependencies, and design.
  - [x] Implement and integrate Durable runtime/config/provider/CLI slice.
  - [x] Integrate standalone execution spike and record its security limits.
  - [ ] Close execution TOCTOU/hardlink blockers before enabling coding tools.
  - [x] Implement and integrate allowlisted, text-only Telegram adapter.
  - [x] Parent initial integration and bounded offline validation.
  - [x] Migrate Telegram transport to grammY with selective attributed OpenClaw ports.
  - [x] Integrate raw-transport Telegram fatal-exit cleanup, edit recovery,
        retry_after handling, bounded checkpoints, and independent offline probes.
  - [x] Retain write-ahead send intents, unknown outcomes, and accepted chunk
        progress durably without blind automatic retransmission.
  - [x] Recheck integrated behavior and actual process-crash send boundary offline.
  - [x] Live Telegram smoke check with scripted model, streaming edits, and persisted-state reopen.
  - [ ] bwrap-confined `ExecutionEnv` running `read`/`write`/`edit`/`bash`;
        prove workspace escape attempts fail.
  - [x] Telegram-in → `submit()` → streaming edits from `watch()` → out
        (real Telegram, scripted streaming model; real fork provider still pending).
  - [ ] Kill -9 mid-tool; reopen; verify `replay` semantics as documented.
  - [ ] One real fork provider (umans or opencode_zen) through pi-ai.
- [ ] Gate 2 — accept remaining spike gates before activating unsafe capabilities;
      full-port planning is approved, security acceptance is not inferred from it.
- [ ] Gate 3 — implement P1–P8 of the full-port roadmap in bounded reviewed slices,
      reusing the Pi SDK first; Python remains read-only reference.
- [ ] Gate 4 — P9 owner-approved canary/migration/cutover and rollback drill.
      Use separate accounts/data or side-effect-free replay for comparisons;
      never run two pollers for the same Telegram bot or duplicate real actions.

## Owner decisions (2026-10-26)

1. Full TypeScript product/runtime; no permanent Python agent sidecar.
2. Native QuickJS-only Code Mode; Python scripting compatibility intentionally
   dropped, useful workflows and worker safeguards must be migrated.
3. Include the existing tracked WebUI; do not resurrect unrelated removed APIs
   or upstream channels. Earlier "WebUI removed" guidance is stale for this scope.
4. Linux only; no Windows requirement or portability work.
5. Pi SDK-first: Durable/native tools/QuickJS/compaction/tasks, with pi-ai,
   pi-mcp and other Pi helpers where needed. Prefer bwrap execution. No required
   Gondolin, Elanor, UI-framework migration, or wider-org adoption project.
6. Preserve memory/archive/Dream/usage semantics and provenance by default;
   any further compatibility loss needs an explicit decision. Full roadmap is
   [`2026-10-26_full-port_TODO.md`](2026-10-26_full-port_TODO.md).

## Log

### 2026-10-26 — implementation kickoff

Owner authorized initial port and Codex Luna high-reasoning implementation
subagents. Parent owns design/review/integration; workers get separate managed
worktrees for runtime, execution security, and Telegram. New package lives in
`packages/pi-nanobot`; Python and live deployments remain unchanged. Pin Pi 1.4.0.
No live credentials, paid requests, or real Telegram polling in this initial batch.
Security/recovery evidence gates remain open until independently checked.
Scaffold/design commit: `6f2057944`; dependency install audited 93 packages with
zero reported vulnerabilities. Node 22.22.2; `/usr/bin/bwrap` 0.9.0; a minimal
user/PID/network namespace probe succeeded. No application acceptance check yet.

Active implementation batch (all `openai-codex / gpt-6-luna / high`):

| Agent | Pane / workspace | Branch | Ownership |
|---|---|---|---|
| `durable-execution-w1p` | `w1Q:p1` / `w1Q` | `sub-pi-durable-execution` | `src/execution/**`, `EXECUTION.md` |
| `durable-runtime-w1p` | `w1R:p1` / `w1R` | `sub-pi-durable-runtime` | config/providers/runtime/CLI/index, example config, README |
| `durable-telegram-w1p` | `w1S:p1` / `w1S` | `sub-pi-durable-telegram` | `src/channels/**`, `TELEGRAM.md` |

Parent: `w1P:p1`. Managed worktrees are under
`/home/gergo/.herdr/worktrees/pi-nanobot/sub-pi-durable-{execution,runtime,telegram}`.
Shared read-only upstream source is `/tmp/pi-durable-reference-1.4.0`, pinned to
Pi tag `v1.4.0` (`4a080252f06caf63a525d7873c5d94d3c23887e0`). Workers must report
commits/checks/blockers before parent integration; no automatic merge or cleanup.

First Telegram report: `3da30092d` (not integrated). Parent review found escaped
transaction drafts, incorrect final-answer model shape, seconds/milliseconds
long-poll mismatch, delivery-cap polling stalls, and incomplete async cleanup.
Returned to `durable-telegram-w1p` for fixes plus bounded offline mock validation.
Runtime worker's safety dialog is cleared and implementation resumed. Parent
sent corrections for per-conversation model/policy initialization, prototype-safe
session mapping, canonical storage locking, and disjoint data roots.

First execution report: `fd580afc0` (not integrated). Bounded sandbox/path probes
and build/typecheck passed in its isolated worktree, but filesystem TOCTOU and
hardlink aliasing remain security blockers. Parent requires the initial gateway to
remain tool-less (no CodingTools registration, no unsafe flag, explicit empty tool
policy on persisted/new conversations). Execution worker is fixing nonzero-probe
handling, real Context usage, cwd validation, and Result/abort contracts before
integration. No application acceptance gate has passed.

Execution follow-up `f886d1f60` recovered after the workers were reloaded without
socket-wrapper registration. Reviewed and integrated the two execution commits as
`a4115ed02` / `e53c1445d`. Parent package typecheck/build passed. Parent bounded
inline Node checks independently confirmed ordinary traversal/symlink/missing-leaf
and rename rejection, sanitized shell env, zero effective capabilities, pre-abort,
and rejection of a fake bwrap exiting 17. An initial check used the wrong Chord
module path; rerun with `dist/context/index.js` passed. Race/hardlink security and
crash/replay semantics remain unproven; the execution factory remains standalone.

Runtime reports `4f9f5036b` / `fd25f259a` are not integrated. Review returned CLI
entry-ID-vs-text output, provider alias/credential selection, partial-startup
cleanup, explicit SDK Models injection, and actual SQLite recovery/locking checks
to the runtime worker. Telegram fixes still in progress. Existing children remain
CLI-managed; no new socket child registry was created by their reload.

### 2026-10-26 — initial integration

Integrated runtime `4f9f5036b` / `fd25f259a` / `c65b0b258` as
`01a8a81d7` / `9c92746fc` / `6c70cd6a5`, and Telegram `3da30092d` /
`cf2ea8f33` as `f93d7c483` / `da2cd5398`. Full package typecheck/build passed.
Parent reran `/tmp/tgprobe/probe.mts` after verifying its imported source exactly
matches the integrated module: recovery/dedupe, allowlist revocation, Unicode
splitting/final flush, polling beyond eight deliveries, and external cancellation
passed. Parent independently checked actual SQLite + injected faux Models: text
extraction, requestId dedupe, prototype-safe keys, private data permissions,
concurrent-owner rejection, same-key reopen, and SIGKILL lock release/reopen.
No live/paid provider or Telegram request; coding tools remain disabled. Storage
lock recovery is not evidence of interrupted-tool replay safety.

Review still requires Telegram fatal-poll/admission exit cancellation/reaping,
idempotent edit/deleted-preview recovery, respecting long retry_after values, and
bounded channel-state checkpoints. A socket-native worktree worker launch was
attempted from `da2cd5398`, but failed before child creation: wrapper runs `herdr`
from PATH and returned `spawn herdr ENOENT`. Existing CLI workers are not in the
socket registry; user requires native tools only from here. No CLI launch/message
fallback used. Fix the wrapper executable lookup (e.g. honor HERDR_BIN_PATH) or
Pi's inherited PATH before delegating the remaining fixes.

After the owner reported the wrapper fixed, socket-native `herdr_spawn` from
`46d5c16da` created retained child `pi-8d9f1378`, pane `w1V:p1`, workspace
`w1V`, branch `pi-8d9f1378`, checkout
`/home/gergo/.herdr/worktrees/pi-nanobot/pi-8d9f1378` (Codex gpt-6-luna high;
Telegram reliability task above). Startup then failed with `Child ready handshake
timed out`. One recovery inspection returned `agent_not_found` for `w1V:p1`.
No duplicate launch, terminal fallback, or cleanup was attempted. This resource
must be recovered/inspected before retrying; no implementation completion claimed.

Owner explicitly authorized another socket-native spawn after fixing startup.
Retry succeeded: `pi-e078edd8`, pane `w1W:p1`, workspace `w1W`, branch
`pi-e078edd8`, base `d690c1c64`, checkout
`/home/gergo/.herdr/worktrees/pi-nanobot/pi-e078edd8`, Codex gpt-6-luna high.
Assigned only Telegram lifecycle/retry/checkpoint fixes and bounded offline
verification. Native inspection confirmed working and no pending permissions;
completion must arrive via `herdr_report`, not inferred from idle/state notices.
Prior failed resource was left intact; no cleanup authorized.

Native child reported candidate `30fdfc721` with local cancellation/checkpoint/edit
handling changes and passing baseline probes. Not integrated yet. Parent review
found the added fatal-recovery probe reused an already-resolved gate from an
earlier scenario, so its timeout does not establish a runtime recovery failure.
Returned through `herdr_send` for a fresh-gate pending-state check and missing
end-to-end edit/deleted-preview/long429 cancellation probes. Also requested narrow
support for Telegram's detailed not-modified message and preservation of server
cooldown after the last allowed429 attempt. Await explicit revised completion.

### 2026-10-26 — OpenClaw Telegram reuse assessment

At owner request, cloned OpenClaw into `/tmp/openclaw-telegram-reference`, pinned
to `5f1d487758a8560d083fbbd07fc1cc4203b7def8`. MIT license permits selective
porting with retained notice/provenance. Its private Telegram plugin is tightly
coupled to OpenClaw's SDK/routing/queues and spans a much larger feature surface.
Recommendation: grammY client/types plus selective transport-policy ports, while
keeping our thin Durable admission/watch/state boundary. No dependency switch or
code copying implemented yet. See `packages/pi-nanobot/OPENCLAW-ASSESSMENT.md`.
Shared relevant source paths with the active native worker without broadening its
assigned fixes. No upstream install/execution or live bot request.

Owner subsequently approved this recommendation for implementation. Sent the
expanded task through `herdr_send` to sole Telegram editor `pi-e078edd8`
(`w1W:p1` / branch `pi-e078edd8`): migrate HTTP plumbing to grammY's typed Api,
preserve manually controlled durable-before-offset polling, adapt only relevant
OpenClaw policies, keep external at-least-once/unknown semantics explicit, and
retain full MIT notice/source provenance. Extended ownership narrowly to package
manifest/lock and package-local third-party notice. No runtime/Python changes.
Requested exact grammY1.46.0 after registry/Node compatibility verification;
additional dependencies require justification.

Launched independent native read-only reuse reviewer `pi-2a3d0c17`, pane `w1P:p3`,
workspace `w1P`, using Codex gpt-6-luna high, to check extraction boundaries,
SDK/polling/flood/error/cancellation traps, and attribution. Report target:
`/tmp/pi-openclaw-telegram-reuse-review.md`. Implementation and review proceed
independently; await explicit revised completion rather than prior task status.

### 2026-10-26 — reliability checkpoint and independent reuse review

Integrated native worker's raw-transport reliability commits `30fdfc721` /
`53fd019f0` / `dbf0345fd` as `1f5e8ca32` / `ed8b676e1` / `80304bd14`.
Full package typecheck/build passed. Parent made an uncommitted private probe
variant importing the integration checkout and ran:
`timeout 150s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/parent-reliability-probe.mts`.
All eleven cases passed: baseline admission/recovery/allowlist/Unicode/concurrency,
fresh-gate fatal-poll pending-state recovery, blocked-preview cancellation,
35-second429 no-early-retry and cancellation, concurrent shared cooldown,
short/detailed unchanged-edit recovery, and deleted-preview replacement/final flush.
No live bot or paid request. This is NOT a completed grammY migration.

Read independent review `/tmp/pi-openclaw-telegram-reuse-review.md` from
`pi-2a3d0c17`. It confirms the thin typed Api/manual polling direction and warns
that generic sendMessage retries after ambiguous network/5xx failures can duplicate
accepted messages. Sent its findings and a concrete design decision to active
migration worker `pi-e078edd8`: preserve explicit unknown-delivery records outside
automatic resend, persist known accepted chunk progress, report sanitized status,
and leave reconciliation to existing Durable state/SDK rather than add a UI.
Outbound flood waits must not stop getUpdates; SDK transport contracts and MIT
provenance still need verification in the actual migration. Await revised report.

### 2026-10-26 — grammY candidate review

Worker reported migration candidate `ba52081d4`, exact grammY1.46.0, typed Api,
separate poll/outbound gates, preview coalescing, native-fetch bridge, and MIT
provenance. NOT integrated: parent review found that durable unknown-delivery
and known accepted-chunk progress were still absent. Suppressing retries within
one API call left the same pending send eligible on later polls/restart, contrary
to the approved requirement. Returned through native send for minimal write-ahead
intent, unknown-outcome exclusion from automatic drain, accepted-chunk progress,
and offline ambiguous-response/cancellation/reopen/partial-chunk proofs.

Reassigned read-only reviewer `pi-2a3d0c17` to inspect actual committed migration
and now-installed grammY1.46.0 source/types, especially fetch/AbortSignal/timeouts,
redaction, poll ownership, flood waits and preview coalescing. Report target:
`/tmp/pi-grammy-transport-review.md`. Both children are active; await revised
explicit reports. No live bot/provider calls or deployment.

### 2026-10-26 — unknown-delivery candidate review

Independent actual-SDK report `/tmp/pi-grammy-transport-review.md` verifies
custom fetch/redirect rejection, redacted errors, native signal bridge, 60s SDK
timeout, manual polling, coalescing, and MIT notices. Its flood-scope observation
is not a direction to merge gates: one shared outbound gate and separate polling
cooldown are intentional, matching OpenClaw's explicit getUpdates bypass.

Worker's `491d4b77a` adds durable caught-error unknown markers and accepted-chunk
progress, with reported passing offline checks. Still NOT integrated: parent
review found no write-ahead intent before sendMessage, leaving process death or
failed outcome commits able to trigger duplicate sends after reopen. Sent precise
callback-level pre-dispatch intent / atomic known-outcome / safe-rejection clearing
algorithm via native send, plus intent-observation, ambiguous AbortError, and
crash/reopen validation requirements. Original request and exact intended output
must survive for reconciliation. Await final boundary fix, not another catch-only
unknown marker. No deployment or live requests.

### 2026-10-26 — integrated grammY and verified write-ahead boundary

Integrated `ba52081d4` / `491d4b77a` / `6b745f46d` / `0c20d0fba` as
`36479934e` / `34f9df76d` / `5f2a470dd` / `6fa14337f`. Exact grammy1.46.0;
clean npm ci audited101 packages with zero reported vulnerabilities. Full package
typecheck/build/diff-check passed. Parent independently ran updated full temporary
`/tmp/tgprobe/parent-grammy-probe.mts` (220s timeout,512MB Node heap): all baseline,
recovery/edit/flood/abort/migration/unknown/progress/intent checks passed.

Parent also independently used an actual subprocess and SQLite gateway: mock
Telegram inspected committed exact-text send intent, recorded remote acceptance,
then parent killed the subprocess with SIGKILL before response/outcome commit.
Reopening retained unknown intent and made zero retransmissions. This is offline
external-send evidence, not proof of tool replay or real Telegram delivery.

Final read-only audit `/tmp/pi-telegram-intent-final-review.md` passes code paths;
its reconciliation-doc blocker is corrected: clear sendIntent, deliveryStatus,
unknownStage, unknownChunkIndex, unknownSince atomically with resolved progress.
No tool enabling or deployment. Live Telegram check is newly offered by owner;
use a scripted injected model first, no paid/model credentials needed. Environment
exports in another shell were not visible to this Pi process. Created private
owner-editable template `/home/gergo/.config/pi-nanobot/test.env` (0600, parent
0700), outside checkout; awaiting replacement token, numeric sender ID, and sole
poller confirmation. Token values must not enter repository files or tool output.

### 2026-10-26 — live Telegram smoke test started

Owner populated private test.env; parent validated permissions/presence without
printing credentials. Real getMe authenticated the bot and getWebhookInfo showed
no webhook. Owner explicitly confirmed sole polling ownership. Started bounded
three-minute scripted-model smoke runner `/tmp/pi-nanobot-live-smoke.mjs`, log
`/tmp/pi-nanobot-live-smoke.log`, supervisor PID773417. READY confirmed; private
isolated SQLite/transcript data `/tmp/pi-nanobot-live-xM2Emp`. Only configured
numeric sender is allowlisted, model is explicitly injected faux streaming, tools
remain disabled, no paid LLM calls. Await owner sending `pi durable smoke` and
inspect final log/result; startup/authentication are not an end-to-end pass.

### 2026-10-26 — live Telegram smoke verified

Owner sent `pi durable smoke` and supplied screenshot showing the final reply.
Real API accepted one sendMessage and four editMessageText calls (including final
text). The temporary runner's automatic pass detector did not fire, despite
matched input/finalVisible=true, so parent stopped its sole polling process with
SIGTERM rather than treating that helper as authoritative. Log confirms CLOSED.

Parent then reopened the actual isolated SQLite store through openGateway and
verified one persisted user turn, one assistant entry, empty pending output queue,
explicitly zero enabled tools, and only faux model usage. This independently
establishes the real Telegram → Durable → streamed Telegram path; no paid LLM
request was made. Secret contents were never printed or committed. Private smoke
data/log remain outside checkout for inspection; bot polling is stopped. This
completes the Telegram slice only: execution confinement and real fork-provider
checks remain open, and nothing was deployed.

### 2026-10-26 — full-port roadmap supersedes the initial outline

Owner requested comprehensive scope and upstream-first Pi/Earendil reuse,
including native tools/Code Mode. Explicit decisions: existing WebUI included,
QuickJS only, Linux only. Created `2026-10-26_full-port_TODO.md` with reuse/parity
maps, P1–P9 gates, native-library gaps, source provenance, migration and non-lossy
rollback, and a bounded next-batch recommendation. Updated stale forward-plan
questions/unsafe dual-poller canary wording here. No implementation batch launched,
new dependency installed, machine changed, paid request or deployment performed.

### 2026-10-26 — clarified SDK reuse and bwrap preference

Owner clarified that reuse primarily means the Pi SDK stack. Updated the full
roadmap: bwrap/native ExecutionEnv completion is the next security task, not a
Gondolin spike; retain the existing frontend, no Elanor/React migration. Supporting
Pi packages remain useful when concrete needs arise, rather than adopting the
whole org. Existing race/hard-link/tool-replay/storage gates stay open; preference
for bwrap is not acceptance of the unsafe current filesystem wrapper.

### 2026-10-26 — assessment

Project relocated to its own checkout `/home/gergo/projects/pi-nanobot`, cloned
from `fork-nanobot` at `53d7e0ead`. That clone's only remote is `github`
(`agbocsardi/nanobot`), renamed from `origin` so two checkouts cannot push
`main` to the same branch by habit; `upstream` is still fetch-only reference.
The Python tree in this checkout is reference material, not the build target.

Read the Pi Durable post, `packages/durable/README.md` (v1.4.0) and the
installed Pi 1.4.0 SDK docs; mapped them against nanobot's `agent/`,
`session/`, `tools/`, `channels/`, `cron/` and the security constraints in
`.agent/security.md`. No code, branch, config or deployment change. Assessment
above is static reading plus LOC counts, no prototype.
