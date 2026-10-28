# Port plan v2 — ship-first sequencing

Date: 2026-10-27. Branch: `feat/pi-durable-rebuild`.

## Owner scope update — 2026-10-28

Prioritize the core agent, memory, skills, tools, cron and heartbeat. The owner confirmed
skill wiring is essential. Background subagents and Code Mode workers are wanted;
determine their implementation shape before building them. The owner also wants
channels (Telegram, Discord, Email and WebSocket); plan their integration after
the core, with actual use and sequencing to be discussed. Do not port the Python
sustained goal/tasks interface or intent/keyword-triggered features. Defer WebUI
and migration until the owner discusses them. Existing work is not a
commitment to activate it.
Complete and validate the core/memory/cron/heartbeat path first; compaction is core context
continuity. The broader W4–W6 descriptions below are historical options, not
standing authorization to implement or deploy them.

## Current checklist

- [x] Verify the existing typecheck, behavioral and execution baselines.
- [x] Prove two provider API families and the bad-model error path (W0).
- [ ] Freeze the shared W1/W2 contract and resolve backend differences.
- [x] Deliver the tool layer and durable per-conversation grants (W1).
- [x] Deliver the selectable Python-like shell sandbox (W2).
- [ ] Decide memory authority and complete memory, context and compaction (W3).
- [ ] Record the A/B and harness-specific acceptance results (W4).
- [ ] Complete automation and channels item by item (W5).
- [ ] Complete WebUI and retirement work (W6).

Supersedes the **sequencing** in `2026-10-26_full-port_TODO.md`: the P1–P9 ordered
milestone list, its "Execution order and next bounded batch" section, and the
per-batch worker-assignment sections as standing instructions. That file stays
authoritative for completed work, the evidence log, the parity map and the reuse
policy. This document changes order, granularity and stop rules only.

Status at time of writing: gateway is tool-less, no real fork-provider call has been
made. 155 behavior checks and 9 execution checks pass.

Scope of this document is engineering only. Deployment preferences and
product-usage decisions live outside the repository and do not gate the work below.

## Owner clarification — 2026-10-28

The goal is to prevent **accidental damage outside the chosen actual workspace**,
not to withstand adversarial commands or provide hostile-tenant isolation.
Ordinary use must operate directly on that workspace; an isolated copy requiring
publish-back is not the ordinary workflow. Filesystem path guards, shell deny
patterns and a filtered environment are guardrails, not confinement: a shell
command can still access other files or the network. Do not claim otherwise.

Prioritize W1 and its real Gateway turn once its practical guardrails and durable
grants pass review and the checks below. Bubblewrap remains a separate optional W2
backend, not a prerequisite for the direct-workspace Gateway. The owner selected
Python-like bwrap behavior: shell commands operate on the actual workspace mounted
read-write, system paths are read-only, temporary space is private, and networking
remains available as in the Python wrapper. File operations use the shared guarded
host environment. Do not silently substitute a managed copy. Review practical
backend differences and preserve native execution semantics; do not expand this
scope into adversarial isolation, hostile-tenant quotas, or extra frameworks.

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
  credentials are not implicitly inherited by commands.
- Runaway protection: command timeout plus process-group kill. A runaway is damage
  even with no attacker.
- Default-deny tool policy per conversation; grants carry expiry, are revocable, and
  are re-checked on replay and after reopen.

## W1/W2 shared contract

The tool layer and the sandbox must agree on one contract, not each carry its own.
The failure mode this prevents: policy that lives in a wrapper outside both produces
a tool that works in the host and a tool that works in the sandbox, diverging
quietly.

Placement rules, which are design constraints rather than implementation choices:

- **Tool policy** (allowed, denied, which tools a conversation is offered) goes into
  per-conversation grants and `beforeTool` hooks. It is backend-independent and must
  behave identically whichever `ExecutionEnv` is active.
- **Filesystem and process policy** (path guard, deny patterns, environment
  allowlist, timeout, process-group kill) is enforced by the `ExecutionEnv`, because
  that is the only layer that sees the actual syscall or process. Duplicating it in
  `beforeTool` creates two sources of truth that can disagree.
- **Limits and truncation** are declared once, at the tool definition, and honoured
  by both backends. `bash` truncating to a retained tail with a full-output path is
  the native shape; keep it rather than layering a second truncation pass.
- Nothing that a sandbox enforces may depend on the host backend enforcing it first,
  and nothing the host backend allows may be silently refused by the sandbox without
  that difference being recorded as a config-level difference.

Both workstreams exit against the same conformance checks, and `registerEnvConformance()`
from `@earendil-works/pi-durable/testing` is the supported way to drive them. A check
that only one backend passes is a contract bug or a documented backend difference,
never a build flavour.

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

Follows the W1/W2 shared contract: policy in grants and `beforeTool`, filesystem and
process enforcement in the `ExecutionEnv`, limits declared once at the tool
definition.

Out of scope here: bubblewrap (W2), quotas as a hostile-tenant boundary, cross-user
path swaps, host-power durability below fsync. Record each as accepted in
`EXECUTION.md` with its compensating control.

Exit: the four tools work from a real turn; a deliberate `../` escape and a symlink
out of the workspace are refused; a runaway command is killed; a revoked grant stays
revoked across reopen.

### W2 — sandbox backend

> **Owner clarification, 2026-10-28:** The managed-copy, all-operations-confined
> design below is superseded. Implement an optional Python-like shell bwrap mode
> over the actual read-write workspace, with host-side filesystem guards. The
> owner wants accidental-damage protection, not hostile isolation; network stays
> available. W2 does not gate W1 Gateway activation.

An `ExecutionEnv` implementation that confines filesystem and shell, finished to
parity with the host-side tool layer rather than abandoned as a spike. Bubblewrap is
the preferred backend. It must be selectable per instance through configuration, so
a deployment that needs confinement can require it and one that does not is not
blocked by it.

Bound by the W1/W2 shared contract: confinement is enforced here, tool policy is not.
Where the sandbox genuinely cannot honour a host-side allowance, that difference is a
config-level declaration, not a silent refusal.

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

## Session log

### 2026-10-28 — baseline and next batch

On `9d3afa1b9`, bounded `npm run typecheck`, `npm run test:behavior` and
`npm run test:execution` passed: 155 behavior and 9 execution checks. Started
read-only provider-proof and shared-contract investigations with
`opencode-go/deepseek-v4.1-flash` at high thinking. No live provider calls or
credentials used. The next step is to review their reports and settle the W1/W2 contract before
implementation.

The context, provider, usage, Code Mode, SQLite, Telegram and original execution
branches are patch-equivalent to integrated work. Keep the genuinely unmerged
grant fixture, Discord, scheduling, memory-search and archival candidates parked
according to v2; the newer Discord and scheduling branches include their older
candidates. Existing worktrees are clean and were not removed.

The owner clarified that ordinary use targets the actual workspace and protects
against accidental damage, not adversarial shell behavior. W1 Gateway activation
no longer waits for optional W2; the host shell is an honest guardrail, not a
confinement boundary.

W0: the owner authorized a local credential source and selected OpenCode Go
DeepSeek V4.1 Flash, then Umans for the second family. A parent-only bounded
`pi-ai` 1.4.0 completion through the port's `createProviderModels` with
`opencode-go/deepseek-v4.1-flash`, high reasoning, max 256 tokens, and request
`Reply with exactly: OK` returned `OK` (`stop`; 35 input, 14 output). Two earlier
requests without `sessionId` returned HTTP 400 `MissingSessionID`; supplying a
random session ID fixed routing. The deliberately invalid model was rejected by
the pinned local catalog before dispatch, not by the remote service.

A second parent-only `pi-ai` completion used the native Anthropic Messages
adapter with explicit Umans endpoint `https://api.code.umans.ai`, model
`umans-deepseek-v4.1-flash`, max 128 tokens, and the same request; it returned
`OK` (`stop`; 35 input, 13 output). This was a throwaway custom model, not port
provider integration: `umans` remains unsupported by the Gateway. Its displayed
cost came from cloned Anthropic model metadata and is not Umans billing evidence.
Neither proof establishes tool, streaming-recovery, fallback or provider-matrix
parity. No secrets, real workspace or Gateway state were sent.
Source: https://app.umans.ai/offers/code/docs#api-reference

Shared-contract reviewer `pi-c62894ea` found that the bwrap spike imposes a
5-second timeout and output window, discards native bash spill output, uses a
different shell and environment, and canonicalizes paths before filesystem
operations. The latter can alter no-follow, removal and rename semantics; the
review also predicts an incorrect missing-program result. These are source-review
findings, not all reproduced yet. The native conformance suite does not cover
spill, environment filtering, path escape or deny patterns; supplemental bounded
checks are needed. The first implementation slice must establish shared policy
and host semantics before the sandbox follows. Host shell execution is not a
confinement boundary: environment filtering and command deny patterns do not
prevent arbitrary shell programs from reading host files. The owner accepted
accidental-damage guardrails rather than adversarial isolation; Gateway tools
still require durable grants and its end-to-end checks.

W1 foundation `3cf9838a1` and fix pass `dbea20e7c` passed independent final
review (`pi-de3d8e5b`) and were cherry-picked as `931875a75` and `438c3f928`.
Parent reran typecheck, 155 behavior checks and 9 execution checks successfully;
the reviewer separately ran 24 host conformance checks. The host backend is
not yet registered in the Gateway. Its lexical shell guard does not implement
Python's exec URL guard, and cannot fully confine shell, hard links or detached
processes; these are documented limitations, not claims of isolation. Native bash
may report an undefined duration when a host-default timeout fires; integration
must check/fix that user-visible error. W1 Gateway integration `62da62b17` and fix `13900cd4e` passed final review
(`pi-39e78946`) and were cherry-picked as `2c90f2158` and `e8d750275`. Parent
reran typecheck, 155 behavior and 9 execution checks. Synthetic real-Gateway
probes covered default deny, all four tools, traversal/symlink refusal, timeout,
expiry, revoke/reopen and unsafe interrupted replay. The owner-authorized real
`opencode-go/deepseek-v4.1-flash` high-thinking turn used all four native tools
successfully in a disposable workspace: write `ALPHA`, edit to `BETA`, read, and
bash `printf CHECK`; the final file was `BETA\n`. The temporary workspace and
store were removed. W1 is complete for the clarified accidental-damage scope;
no production deployment or real user data was involved.

Direct-workspace bwrap builder `8db828970` plus fix `8446957d1` passed final
independent review (`pi-96ca0073`) and were cherry-picked as `5913b0ba2` and
`37d8777a1`. Parent reran typecheck, 155 behavior and 9 execution checks. The
builder is standalone, not a configured backend or Gateway activation. It binds
the real workspace read-write, keeps network available, and uses a PID namespace
for background-process teardown; host temp/spill visibility and home toolchains
remain documented integration constraints. The initial reviewer performed a DNS
lookup despite the no-network assignment; no credentials were involved. The final
review used no network.

W2 integration `e5abbf56e` passed independent review (`pi-4d1c7b32`) and was
cherry-picked as `2319b9679`; the privacy-only follow-up was already applied on
this branch. Parent typecheck, 155 behavior checks and 9 execution checks pass.
An owner-authorized real `opencode-go/deepseek-v4.1-flash` high-thinking turn
with `toolSandbox: bwrap` successfully used write, edit, read and bash in a
disposable workspace; the expected file contents were observed and the temporary
workspace and store were removed. Shell bwrap operates on the actual workspace;
filesystem tools use the host guard. Full bash spill remains readable via `read`
while the environment lives, but not from inside the sandbox's private `/tmp`.
No production deployment or real user workspace was involved.

W3 skill discovery foundation `6510e0185` and fix `166646281` passed independent
final review (`pi-6b6be142`) and were cherry-picked as `d3e6a5a97` and
`4768681e9`. Parent typecheck, 155 behavior and 9 execution checks pass; the
reviewer additionally compared all 13 shipped skills with Python and ran 28
synthetic assertions. This helper is not yet wired into the Gateway. Before
wiring, handle oversized or unsupported metadata without silently dropping
requirement gates, check executable requirements do not accept directories,
and decide how to surface skipped skills and load builtin skills on demand.
