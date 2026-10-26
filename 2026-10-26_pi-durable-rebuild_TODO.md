# Rebuild nanobot on Pi Durable (TypeScript)

Status: **Gate 1 implementation started** on `feat/pi-durable-rebuild`.
TypeScript port authorized; production cutover/full migration not yet approved.
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

Net: roughly 12–13k lines of Python harness disappear; ~2–3k lines of TS
wiring replace them.

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
- One process owns a storage; no cross-process locking. The gateway becomes
  the single owner and all clients attach — different model from today's
  multi-service layout.
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
  - [ ] Implement Durable runtime/config/provider/CLI slice.
  - [ ] Implement confined execution environment and record security limits.
  - [ ] Implement allowlisted, text-only Telegram adapter.
  - [ ] Parent review/integration and bounded offline validation.
  - [ ] bwrap-confined `ExecutionEnv` running `read`/`write`/`edit`/`bash`;
        prove workspace escape attempts fail.
  - [ ] Telegram-in → `submit()` → streaming edits from `watch()` → out.
  - [ ] Kill -9 mid-tool; reopen; verify `replay` semantics as documented.
  - [ ] One real fork provider (umans or opencode_zen) through pi-ai.
- [ ] Gate 2 — decide, on spike evidence only: proceed / stop.
- [ ] Gate 3 — port in dependency order (new TS package, Python frozen as
      reference): env+security → coding tools → MCP/tool-search/codemode →
      memory+skills sections → cron/heartbeat → channels → WebUI on `watch()`.
- [ ] Gate 4 — parallel-run one channel against the old gateway, then cut over
      `uhl`; keep Python repo readable for one release cycle.

## Open questions for the owner

1. Cut over fully, or permanently run the TS gateway *beside* a thin Python
   service for Telegram/Yandex-ish integration glue?
2. Is losing the Python Code Mode (bwrap + Python stdlib) acceptable in
   exchange for QuickJS codemode? (Python codemode is a fork feature with
   tests.)
3. Keep `memory/history.jsonl` as an importable legacy archive only, or port
   its Dream/usage semantics verbatim?

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
Runtime worker paused at a safety dialog for cleanup of an accidentally nested
config path; user asked to deny it before a narrower correction. Execution worker
still implementing. No application acceptance gate has passed.

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
