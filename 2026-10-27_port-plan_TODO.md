# Port plan v2 — ship-first sequencing

Date: 2026-10-27. Branch: `feat/pi-durable-rebuild`.

Supersedes the **sequencing** in `2026-10-26_full-port_TODO.md`: the P1–P9
ordered-milestone list, its "Execution order and next bounded batch" section, and
the per-batch worker-assignment sections as standing instructions. That file stays
authoritative for what has actually been done, the evidence log, the owner
decisions, the parity map and the reuse policy. Nothing here relaxes those
constraints; this changes order, granularity and stop rules only.

Status at time of writing: gateway is tool-less, no real fork-provider call has
been made, no real data has been imported. 155 behavior checks and 9 execution
checks pass.

## Why v1 needed replacing

1. **Depth-first on work that is not on the critical path.** Archival
   import/search went source → preparation → rehearsal → persistence → search →
   staging → publication → renderer: eight slices for a one-off migration of
   read-only evidence. Discord got the same shape. Neither is needed to use the
   product.
2. **Open-ended security gates.** P1 lists confinement, quotas, approval,
   SSRF, storage recovery and crash durability as one exit. Every one is
   defensible; together they never close, and the gateway stays tool-less.
3. **No point at which the thing is judged.** Nothing in v1 asks "is this better
   than the Python bot, on real input, for a week". The only comparison gate is
   P9, after migration and UI work.
4. **The cheapest highest-information test is last.** One real provider call
   through `pi-ai` (umans or opencode_zen) is unproven. It is hours of work and it
   de-risks the layer the whole port rests on.
5. **Review chains have no budget.** build → review → findings → fix → re-review →
   follow-up is the normal shape here. Each round is honest; the sum is why 226
   commits produced no usable bot.

## Hard rules (unchanged, not negotiable by this plan)

- Python tree and production deployment untouched until an approved cutover.
- No live credentials, real history, real bot polling or paid calls without
  explicit owner authorization per action.
- Default-deny tool policy; host-supplied config is authoritative.
- Application-managed private workspace; explicit imports only; no arbitrary host
  binds, no automatic publish-back.
- QuickJS-only Code Mode. Linux only. Existing WebUI is in scope; upstream merge is
  not. No second runner, bus, receipt ledger or scheduler engine beside Durable.
- A model claiming success, or a passing test suite alone, is not acceptance.
  Record the command, the invariant, the bounds and what remains unproven.
- Unknown outcomes stay unknown. Never retransmit, auto-approve or auto-resume
  across a crash into an unverified external effect.

## Gate sequence

Each gate has an exit that is cheap to check and easy to falsify. A gate closes or
parks; it does not expand into two more gates.

### G0 — provider proof (before anything else)

One real completion through `pi-ai` for a fork provider already in `.env`, no
tools, no gateway, throwaway script, worst case a few cents. Then one through a
second provider shape (Anthropic-compatible vs OpenAI-compatible) to catch adapter
assumptions.

Exit: recorded request/response for both, including error path with a bad model
name. Park the remaining 16-entry provider matrix; fill it at G6 against real need.

### G1 — tool-less shadow bot (**the judgement gate**)

Second Telegram bot, separate token, its own store, real config, memory files read
only, no tools, no cron. Runs beside the Python bot for one week of real use.

Exit: a written comparison — what it answered correctly, where it stalled, latency,
token cost per turn, and whether you would hand it to Marjo. Explicit decision:
continue, or stop and keep the Python bot. **This is the only gate allowed to
cancel the port.**

### G2 — confined filesystem and shell tools

Bubblewrap environment wired into the gateway for `read`/`write`/`edit`/`bash`,
with the managed-workspace contract and default-deny policy.

In scope: escape attempts on every path (traversal, missing leaf, rename, symlink
race, hard link), teardown/timeout with no post-return work, CPU/memory/PID/disk
ceilings, per-conversation grants with expiry and revocation verified on replay and
after reopen.

Out of scope for this gate, accepted as documented residual risk on a dedicated
unix user with no other data reachable: same-user path-swap races below the
filesystem API, host-power durability below fsync, kernel/bwrap CVE surface. Record
them in `EXECUTION.md` as accepted, with the compensating control, rather than
carrying them as blockers.

Exit: `read`/`write`/`edit`/`bash` usable from a real Telegram turn inside the
confined workspace; adversarial cases pass; accepted risks written down.

### G3 — memory and skills (**decision required before start**)

See decision 2. Then preserve or re-derive the loaded context, compaction
checkpoints, topic-file reads/writes, skills discovery and history search.

Exit: a real conversation that survives compaction with topic memory intact and
skills discoverable, judged side by side against the Python bot.

### G4 — automation and channels

Order: cron/one-shot scheduling (resurrect `pi-cbf84ad6` after one review) →
heartbeat → sustained goals and read-only workers → Discord → Email/WebSocket →
media tools.

Exit per item: it runs for a week without a silent failure, and a failure is
visible in the journal.

### G5 — WebUI

Only after G2, because the UI is not on the path to an assistant you can use.
Inventory the fork's actual wire contracts first, then adapt the existing frontend
to the single Durable gateway.

### G6 — migration and cutover

Historical import (decisions 3 and 4), schema freeze, reconciliation, canary on
dedicated credentials, rollback rehearsed *after* TS has accepted new turns, then
one external account at a time. Provider matrix filled here.

## Decision queue (owner)

Each is a real fork; the plan does not proceed past its gate without an answer.

1. **Historical import scope** — sessions, archived prefixes, `history.jsonl`, or
   all three? Blocks G6 and the archival branches.
   *Recommendation:* `history.jsonl` + sessions, read-only search only. Never
   resumable, never replayed. That is what you actually asked for.
2. **Memory shape on Durable** — (a) port nanobot's file layout and semantics
   closely, or (b) keep the Markdown files as the single source of truth and let
   Durable own runtime state only.
   *Recommendation:* (b). The files are the artifact you read in Obsidian; a second
   store inside SQLite is a migration you would maintain forever. Blocks G3, and it
   is the largest unresolved design question in the port.
3. **Is the SQLite ancestor-swap race a real boundary?** Node's SQLite has no safe
   pinned-open API. `pi-b54f4507` (tmpfs staging) and `pi-ba6fe170` (create-only
   publication) are building machinery for it.
   *Recommendation:* no. The import is one-off and offline with the gateway
   stopped, on a copy, by you. Accept it in writing, delete both branches. Blocks
   nothing else.
4. **MCP legacy SSE** — `pi-mcp` 1.4.0 does not support it.
   *Recommendation:* inventory configured MCP servers; if none use SSE, drop it
   and fail loudly on a configured SSE endpoint.
5. **Tool names** — native Pi names with a mapping table in prompts, or aliases
   matching the Python names.
   *Recommendation:* native names, migration guide at G6.
6. **Discord** — required in the port's scope. Is it required before G1?
   *Recommendation:* no. Parked until G4.
7. **Review budget** — see below. Confirm two rounds maximum.
8. **Kill criterion** — G1 is the stop point. If G1 fails, does the port end or
   become a background experiment? Answer before G1 finishes, not after.

## Review protocol (cost control)

- One independent review per slice. If it returns blockers, one fix pass by the
  same owner. Second blocker set → park the branch, record why, move on. No third
  round, no follow-up-of-the-follow-up.
- At most two implementation slices in flight at once.
- Every branch ends merged or parked with a reason. No branch is carried
  indefinitely as "preserved candidate"; that is how 25 branches became a backlog.
- A slice that grows a second security boundary mid-review is a scope error: park
  it and write the boundary down instead.
- Tests: keep the existing behavioral suite green. New permanent tests only for
  behaviour that would otherwise silently regress.

## Parked until G1 passes

`archival-*` (source, preparation, rehearsal, persist, search, renderer, staging,
publication), Discord adapter, memory-search-over-snapshots, the gateway grant
synthetic fixture, and the WebUI inventory. Branches stay; no new work on them and
no reviews. Re-evaluate at G1.

## What "done" means

An assistant on Durable that answers real Telegram turns with confined tools,
topic memory and skills, running on its own credentials for a week with no silent
failures — and a recorded decision that you would rather use it than the Python
bot. Everything else is maintainable afterwards.
