# Port plan v2 — ship-first sequencing

Date: 2026-10-27. Branch: `feat/pi-durable-rebuild`.

Supersedes the **sequencing** in `2026-10-26_full-port_TODO.md`: the P1–P9 ordered
milestone list, its "Execution order and next bounded batch" section, and the
per-batch worker-assignment sections as standing instructions. That file stays
authoritative for completed work, the evidence log, the parity map and the reuse
policy. This document changes order, granularity and stop rules only.

Status at time of writing: gateway is tool-less, no real fork-provider call has been
made. 155 behavior checks and 9 execution checks pass.

Scope of this document is engineering only. Deployment preferences and
product-usage decisions live outside the repository and do not gate the work below.

## Why v1 needed replacing

1. **Depth-first on work that is not on the critical path.** Archival import/search
   went source → preparation → rehearsal → persistence → search → staging →
   publication → renderer: eight slices for a one-off migration of read-only
   evidence. Discord got the same shape. Neither is required for the product to run.
2. **Open-ended security gates.** P1 lists confinement, quotas, approval, SSRF,
   storage recovery and crash durability as a single exit. Each is defensible;
   together they never close, and the gateway stays tool-less.
3. **No acceptance gate at usable scope.** v1's only comparison point is P9, after
   migration and UI work.
4. **The cheapest highest-information test is last.** One real provider call through
   `pi-ai` (umans or opencode_zen) is unproven. It is hours of work and it de-risks
   the layer the whole port rests on.
5. **Review chains have no budget.** build → review → findings → fix → re-review →
   follow-up is the normal shape here. Each round is honest; the sum is why 226
   commits produced no runnable product.

## Damage model

The tool layer must not (a) corrupt or delete data outside its declared scope, (b)
leak credentials or private context to a provider or the internet, or (c) produce an
unintended external effect — a send, a purchase, a scheduled job, a deleted file.

Out of scope as a hard requirement: an adversary with existing shell access to the
host, kernel or runtime exploits, hostile multi-tenant isolation. Those are the
sandbox workstream's concern where a deployment needs them, not a prerequisite for
the tool layer.

Contract both backends must satisfy:

- `read`/`write`/`edit` refuse `../` traversal and symlink escapes out of the
  workspace root.
- `bash` keeps the ported deny patterns (destructive `rm`, disk and power commands,
  writes to runtime state files) and the `allowedEnvKeys` environment allowlist, so a
  command cannot read `secrets.env` implicitly.
- Runaway protection: command timeout plus process-group kill. A runaway is damage
  even with no attacker.
- Default-deny tool policy per conversation; grants carry expiry, are revocable, and
  are re-checked on replay and after reopen.

## Workstreams

Ordered by dependency. Each has an exit that is cheap to check and easy to falsify.
A workstream closes or parks; it does not expand into a second one.

### W0 — provider proof

One real completion through `pi-ai` for a fork provider in `.env`: no tools, no
gateway, throwaway script. Then one through a second adapter shape
(Anthropic-compatible vs OpenAI-compatible) to catch family assumptions.

Exit: recorded request/response for both, including the error path with a bad model
name. The remaining provider matrix is filled later, against need.

### W1 — tool layer

`read`/`write`/`edit`/`bash` registered through the approved environment with the
damage-model contract above, plus per-conversation grants with expiry and
revocation verified on replay and after reopen.

Out of scope here: bubblewrap (W2), quotas as a hostile-tenant boundary, cross-user
path swaps, host-power durability below fsync. Record each as accepted in
`EXECUTION.md` with its compensating control.

Exit: the four tools work from a real turn; a deliberate `../` escape and a symlink
out of the workspace are refused; a runaway command is killed; a revoked grant stays
revoked across reopen.

### W2 — sandbox backend

An `ExecutionEnv` implementation that confines filesystem and shell, finished to
parity with the host-side tool layer rather than abandoned as a spike. Bubblewrap is
the preferred backend. It must be selectable per instance through configuration, so
a deployment that needs confinement can require it and one that does not is not
blocked by it.

Scope:

- All filesystem paths inside the confinement boundary, not only `bash`.
- Validated bwrap executable, namespace setup, sanitized environment, explicit
  mount set, process and resource limits.
- Traversal, missing-leaf, rename, symlink-race and hard-link behaviour on every
  read/write/list/spill/temp/cwd path.
- Teardown, timeout, cancellation, bounded resource use, no post-return work.
- Orphan and manual reconciliation for a workspace left behind by a crash.
- No unsandboxed fallback and no host-network or credential mount.
- `restrictToWorkspace` semantics preserved so existing configurations map cleanly.

Exit: the behavioral suite runs against the sandboxed backend with the same results
as the host backend; escape attempts on each path class are refused and recorded;
the backend is selectable by config and off by default. Remaining known limits are
written down rather than carried as blockers.

### W3 — memory, context and compaction

Preserve or re-derive: loaded context assembly, compaction with a durable transcript,
topic-file reads and writes, skills discovery. Whether Markdown files remain the
single source of truth or Durable owns a store is an open design question; it
constrains this workstream and should be settled before it starts.

Exit: a conversation that crosses a compaction checkpoint still recalls an early
fact; topic memory reads on demand and a write survives restart; a skill is
discovered and run.

### W4 — acceptance suite

The gate that makes later cutover decisions defensible, and the only place where the
two harnesses are compared.

**A/B fixtures.** Run the fixture task suite at `~/gergos-benchmark/tasks`
(outside this repo; copy into `runs/`, never point at live data) through both
harnesses on fresh state and diff the artifacts. The suite was built for model
scoring, so read results as *harness* evidence: correct files read, valid output
written, tools used without stalling, same budget.

**Harness-specific cases the fixtures cannot cover.** These are where a port
actually loses:

- a conversation that crosses a compaction checkpoint and still recalls an early
  fact
- topic memory read on demand; a memory write that survives restart
- skill discovery and one skill actually executed
- a scheduled job firing exactly once, delivering, and not double-firing after
  restart
- SIGKILL mid-turn, then reopen: no duplicate external effect, coherent state
- provider error and rate limit surfaced to the caller rather than swallowed

Each is a fixture transcript. Exit: both parts recorded with pass/fail and the diff,
scored by reading the output. The suite's own automatic checks are partial by design.

### W5 — automation and channels

One-shot and recurring scheduling (resurrect `pi-cbf84ad6` after one review) →
heartbeat → sustained goals and read-only workers → Discord → Email/WebSocket →
media tools.

Exit per item: it runs a week without a silent failure, and a failure is visible in
the journal rather than inferred.

### W6 — WebUI and retirement

Inventory the fork's actual wire contracts, then adapt the existing frontend to the
single Durable gateway. Then retention, backup/restore runbook, schema freeze, and
retirement of the Python service with a tagged readable reference kept.

## Open design questions

1. **Memory source of truth** — port nanobot's file layout and semantics closely, or
   keep Markdown files authoritative and let Durable own runtime state only. Blocks
   W3; the largest unresolved design question in the port.
2. **SQLite ancestor-swap race** — Node's SQLite has no safe pinned-open API.
   `pi-b54f4507` (tmpfs staging) and `pi-ba6fe170` (create-only publication) build
   machinery for it. Decide whether the remaining window is acceptable for a
   one-off offline operation before either branch continues.
3. **MCP legacy SSE** — `pi-mcp` 1.4.0 does not support it. Either a reviewed
   compatibility layer, an endpoint migration, or an explicit loud failure on a
   configured SSE server.
4. **Tool names** — native Pi names with a mapping table in prompts, or aliases
   matching the Python names. Affects prompts, consumers and the migration guide.
5. **Review budget** — proposed two rounds maximum per slice (below). Confirm.

## Review protocol

- One independent review per slice. Blockers get one fix pass by the same owner.
  A second blocker set parks the branch with a recorded reason. No third round.
- At most two implementation slices in flight at once.
- Every branch ends merged or parked with a reason. No indefinitely preserved
  candidates; that is how 25 branches became a backlog.
- A slice that grows a second security boundary mid-review is a scope error: park it
  and write the boundary down instead.
- Existing behavioral suite stays green. New permanent tests only for behaviour that
  would otherwise silently regress.

## Parked

`archival-*` (source, preparation, rehearsal, persist, search, renderer, staging,
publication), memory-search-over-snapshots, the gateway grant synthetic fixture and
the WebUI inventory. Branches stay; no new work and no reviews until a concrete need
appears. Discord is deferred to W5.

## Done

Tools, memory and skills working on the port with the damage-model contract
satisfied on both backends, an acceptance suite recorded with diffs, and a sandbox
backend selectable by configuration. Everything after that is operational.
