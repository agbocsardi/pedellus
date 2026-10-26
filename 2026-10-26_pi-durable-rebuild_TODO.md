# Rebuild nanobot on Pi Durable (TypeScript)

Status: **assessment only**. No code written, no branch, no decision ratified.
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

- [ ] Gate 1 — spike, throwaway, ~2–3 days:
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

### 2026-10-26

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
