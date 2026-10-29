# Port plan v2 — ship-first sequencing

Date: 2026-10-27. Branch: `feat/pi-durable-rebuild`.

## Owner scope update — 2026-10-28

Prioritize the core agent, memory, skills, tools and cron. The owner confirmed
skill wiring is essential. Background subagents and Code Mode workers are wanted;
determine their implementation shape before building them. The owner also wants
channels (Telegram, Discord, Email and WebSocket); plan their integration after
the core, with actual use and sequencing to be discussed. Do not port the Python
sustained goal/tasks interface, intent/keyword-triggered features, or a dedicated
heartbeat feature: an ordinary cron job can serve the heartbeat use case. Defer
WebUI and migration until the owner discusses them. Existing work is not a
commitment to activate it. Exclude these Python built-in skills from the port:
`summarize`, `weather`, `image-generation`, `tmux`, `clawhub`, `update-setup`,
and `long-goal`. Retain `memory`, `memory-defrag`, `cron`, `skill-creator`,
`github`, and `my` for compatibility review. No fixed cap on the number of
discovered skills or selected/disabled skill names; do not silently omit skills.
Only skill names and descriptions belong in the system prompt; load every full
skill body on demand, including skills marked always or selected. Actual prompt
context remains finite and truncation must be visible. Do not delete the Python reference
or the owner's workspace skills as part of this selection.
Cron is an internal agent capability: the user asks the agent, and the agent calls
the scheduling tool. No cron UI, slash commands, or direct user scheduling interface
is required. It must be model-callable and preserve Python's per-job
isolated-background (default) versus in-conversation mode. In-conversation
jobs wait for an idle session rather than silently dropping. Support one-shot and
recurring schedules, origin delivery, and visible failure; review any parked
one-shot primitive as a foundation, not a complete user feature.
Complete and validate the core/memory/cron path first; compaction is core context
continuity. The broader W4–W6 descriptions below are historical options, not
standing authorization to implement or deploy them.

## Approved next batch — 2026-10-28: offline core acceptance tooling

The owner resumed work and selected acceptance tooling, not live acceptance or channel/delegation
implementation. Use `opencode-go/deepseek-v4.1-flash`, high thinking, for implementation and independent
review. This bounded batch supersedes the consolidation pause only for the work below.

- [x] Implement a reproducible disposable core acceptance runner using the actual Gateway, Markdown
      memory, on-demand skills, native compaction and fresh-process reopen, with machine-readable evidence.
- [x] Validate the runner offline with synthetic provider responses and generated synthetic workspace data.
- [x] Complete one independent review and one blocker-fix pass; merge the reviewed result.
- [x] Run existing typecheck, behavior and execution checks; record results and remaining W4 gates.

The owner separately authorized and completed an offline cron authority hardening slice in parallel:
background-run coding calls are bounded by both their copied grants and the origin's current grants,
including pre-resume pruning. Independent review and upgrade/restart probes passed; no channels or
live calls.

No product-provider calls, credential loading, personal workspace access, channel sends, permanent
regression suite expansion, A/B parity claims or deployment. Keep the runner offline-only in this
batch; live-provider modes and external fixture adapters need a later scope/budget decision.

## Current checklist — consolidated 2026-10-28

- [x] Verify typecheck, 155 behavioral and 9 execution checks.
- [x] Prove two provider API families and local bad-model rejection (W0).
- [x] Settle the shared host/bwrap contract and document backend differences.
- [x] Integrate four native coding tools and durable conversation grants (W1).
- [x] Integrate optional direct-workspace bwrap shell; real provider tool turn (W2).
- [x] Settle Markdown memory authority; integrate opt-in memory and skills.
- [x] Verify compaction continuity across a fresh process with a faux summarizer.
- [x] Integrate deterministic cron timer/run foundation and calendar/timezone math.
- [x] Reconcile the plan, current Gateway wiring and parked branch inventory.
- [x] Check the combined core path offline on both host and bwrap during consolidation.
- [x] Finish curated builtin skill compatibility/package review (parked).
      Landed on `feat/curated-builtin-skills`: `memory`, `memory-defrag`, `skill-creator`,
      `github`, `cron` adapted to shipped tools; `my` stays out with no runtime. The
      skill-creator now documents explicit same-conversation refresh for new skills.
- [ ] Record real-model memory/skill/compaction acceptance and A/B fixture results (W4).
- [x] Connect internal agent cron: model-callable tool, runtime lifecycle and authorization.
      Integrated `287a5fbf5`. An independent review plus one worker fix pass found no blocker; the
      durable reopen bug it caught (cron owners restored only under a context provider) is fixed.
      Verified by a worker probe and a parent smoke on the merged tree.
- [ ] Deliver scheduled results beyond the run's own agent turn (channel outbox), and decide silence.
- [x] Give a scheduled background run the workspace context snapshot (AGENTS.md/memory/skills).
      Integrated `91915c5e9`: prepare installs the origin's snapshot for the run's own conversation, startup
      restores it from live run tasks (never a `SessionMap` entry), and an idle background target is evicted
      at the snapshot cap instead of failing the run.

- [ ] Deliver scheduled results beyond the origin conversation turn (channel outbox) once a channel is accepted.
- [x] Agree transcript/episode/search design (2026-10-29; W3 below).
- [x] Store identity, reset-delimited episode boundaries and durable pending-summary state (2026-10-29; foundation only, no summary pass).
- [x] Implement rebuildable message/tool search over the read-only transcript, with committed reset boundaries (2026-10-29; no episode-summary index yet).
- [x] Implement and independently review the opt-in background-summary task: malformed source handling, version migration, durable retry/backoff across abort, and chat-scope enforcement.
- [ ] Wire a validated summary model/spend policy into the normal assistant path; generate post-reset summaries with visible coverage, retry and explicit backfill policy.
- [x] Index ready episode titles/summaries in the rebuildable derived index and expose cross-source topic
      discovery plus summary reading with provenance and original-source drilldown through the agent-facing
      `history` tool (2026-10-29; summary text is derived navigation, original entries remain the evidence;
      refresh is bounded and on-demand, never a model call or backfill).
- [x] Wire the rebuildable message/tool full-text index and reset boundaries to the durable store
      identity. `Gateway.historySearch` is on by default, bound to the committed `nanobot.store-identity`;
      no caller-injected identity remains. CLI diagnostics and agent-facing retrieval are available;
      background summaries are host-API opt-in. See `HISTORY.md`.
- [x] Expose message/tool search and episode/entry browsing in the local CLI.
- [x] Expose history search and source-entry opening through a default read-only agent-facing tool for
      mapped chats (`agentHistory: false` opts out). Telegram/web command surfaces remain unimplemented.
- [x] Expose source-scoped reset-delimited episode listing and bounded episode drilldown through the
      default agent-facing `history` tool (2026-10-29; search remains the cross-source discovery path;
      no generated titles or summary text exposed, and no cross-source episode pagination).
- [ ] Agree background-subagent / Code Mode worker shape before implementation.
- [ ] Complete requested channels individually after core acceptance.
- [ ] Agree the next bounded implementation scope with the owner; no automatic restart.

WebUI, migration and retirement are deferred decisions, not outstanding authorization.
Dedicated heartbeat, sustained goals/tasks, standing intents/keyword triggers and Dream
archiving are excluded, not unfinished port milestones.

## Current state — what is actually usable

Baseline: `c532c5640` on `feat/pi-durable-rebuild`, before this documentation-only
consolidation. The port is experimental, not deployed or approved for cutover.

| Area | Integrated / usable | Missing or limited |
| --- | --- | --- |
| CLI / Gateway / SQLite | Local streaming CLI, persisted sessions/model choices, recovery controls, native `/new` context reset, exclusive store lock and WAL/FULL | `/new` retains entries; summaries require host API opt-in, not normal startup; no everyday-assistant acceptance or backup/restore drill |
| Providers | Nine configured native aliases; real OpenCode Go Gateway tool turns; Anthropic-family Umans proof | Umans proof is not Gateway support; full provider/fallback matrix unproven |
| Coding tools | Native `read`/`write`/`edit`/`bash`, host ceiling, expiring/revocable per-session grants; local CLI `/tools`, `/grant` and `/revoke` | Ceiling defaults empty; Telegram has no grant command |
| Shell backend | Guarded actual workspace; optional `toolSandbox: bwrap`, off by default | Network remains available; file tools stay guarded host APIs; no hostile isolation/quota claim |
| Context / memory | Opt-in bootstrap and selected files, topic manifest, on-demand read/write through granted tools; explicit local `/refresh` | Markdown authoritative; edits do not refresh automatically; unreadable memory directory can block reopen |
| Skills | Opt-in discovery, names/descriptions/locators only in prompt, on-demand read-only `skill` tool; curated port builtins in `skills` (memory, memory-defrag, skill-creator, github, cron) behind an explicit `builtinSkillsRoot` | `my` has no port runtime; no inventory-count cap, but finite prompt/output bounds visibly truncate |
| Compaction | Native Durable summary/transcript plumbing; synthetic fresh-process continuity verified | Real-model fidelity and small-context behavior unverified; fixed upstream budgets |
| Cron | Opt-in `cron.enabled`: agent-callable `add`/`list`/`remove`, `at`/`every`/`cron` with IANA zones, isolated-background or origin mode, owner-scoped jobs, busy/restart/cancel handling; a background run gets the origin's workspace context and `skill` tool; copied grants are bounded by current origin grants | No channel delivery or silence policy; disabling cron leaves persisted timers blocked; a run whose snapshot was evicted at the cap proceeds without context; a phase fault or crash before the terminal commit can retain bounded grants until reopen |
| History | Durable store identity, reset-delimited episode reads, opt-in durable background summaries, message/tool search and default agent-facing episode browsing | Summaries require host API opt-in and are not indexed or exposed to the agent; no real-model fidelity evidence; no cross-source episode pagination; clone/restore provenance limitations remain |
| Telegram | Restricted allowlisted inbound/reply adapter with streaming, durable send intent, unknown-send quarantine | Existing adapter only; scheduled outbound candidate is unmerged; no general pairing or media parity |
| Code Mode / delegation | Reviewed opt-in QuickJS Code Mode/tool-search SDK | Not Gateway-installed; no product background-subagent or worker interface |
| Other surfaces | Read-only usage and inert archival helpers exist | Discord candidates parked; Email/WebSocket, MCP, web/media tools not integrated |

An enabled skill tool supplies instructions only and does not require coding-tool grants.
All effectful coding work still requires its own grant. Configuring a tool ceiling alone
does not by itself produce a tool-capable ordinary CLI or Telegram session; local CLI users
can explicitly grant tools within that ceiling for a finite duration.

## Highest-value next steps — 2026-10-29

The owner wants capabilities the assistant uses, not more user-operated history
commands. CLI history controls are optional diagnostics. Prefer finishing a small
usable retrieval loop over expanding command surfaces, providers or infrastructure.
This section sets priorities; it does not launch new agents or authorize live calls.
Current summary implementation/review may finish under the existing assignment.
New agents use `umans-openai/umans-deepseek-v4.1-flash`, high thinking.

1. **Finish reliable background summaries (current work).** Close review blockers
   before merging the candidate. Required: malformed content cannot strand the
   queue; summary-version changes have a recovery path; abort cannot reset retry
   budgets or skip backoff; backfill under queue pressure remains resumable; scope
   excludes internal/task-owned/forked conversations. Keep coverage, pending/failed/
   blocked state and unknown interrupted-call spend honest. Then wire the approved
   model/thinking/spend policy into the actual assistant startup path: an SDK-only
   option is not a delivered product feature. Preserve native reset ordering and
   make the existing-open-episode activation/backfill policy explicit.
2. **Complete agent-facing episodic recall.** Index generated titles/summaries in
   the rebuildable search database and extend `history` for topic/episode discovery,
   summary reading and original-entry drilldown. Keep default message search and
   optional tool scopes intact. Summary failures must never block raw retrieval;
   summaries remain derived navigation, not evidence or automatic curated memory.
   No additional history slash commands are needed.
3. **Prove the useful loop before adding breadth.** Offline end-to-end first:
   discuss facts/decisions, reset, summarize, restart, ask a differently phrased
   question, let the agent discover the episode and cite original entries. Include
   absent summary, failed provider, large episode and index rebuild cases. Then
   obtain explicit approval for one bounded real-model run on synthetic data to
   evaluate summary fidelity and actual tool selection; passing faux-provider
   checks alone does not demonstrate useful recall. Keep the broader memory/skill/
   compaction acceptance and A/B fixture gates open until actually exercised.
4. **Make the existing Telegram assistant practical.** After recall works, add the
   minimal authenticated control dispatcher: `/new`, `/abort`, `/help` (never model
   prompts). Telegram `/new` must produce the same committed episode/summary flow.
   Keep tool grants default-deny; decide an owner approval path before claiming
   Telegram coding-tool usability. Do not prioritize Telegram history commands—the
   assistant already has the retrieval tool. `/restart` remains parked pending a
   simpler explicit trusted-build/recovery design; it is not a prerequisite for recall.
5. **Finish proactive usefulness: cron result delivery.** The scheduling tool,
   origin mode and isolated-run execution are integrated; do not rebuild them.
   Add the missing channel delivery/outbox, silence policy and actionable failure
   status. Verify schedule → run → delivery → reopen with idempotent admission and
   honest ambiguous-send recovery, not an exactly-once external-send claim.

Defer more channels, background-subagent/Code Mode product interfaces, embeddings,
WebUI, migration and deployment until the core assistant loop is useful. Provider
changes for coding subagents do not silently change the product summarizer model.
No live credentials, personal workspace, channel sends, cutover or Python retirement
are authorized by this prioritization.

## Previous slice — background-run context (integrated; historical design)

The run's conversation gets a snapshot keyed by **its own** conversation id, built from the origin's
session key, installed by `prepare` in the same commit that creates the target alongside the explicit
`tools`/`modelTools`/`extensions` array. Extension choice stays explicit, so no other conversation can
select it.

- `src/context/index.ts`: add a builder `remove(conversationId)` beside `add`, mirroring
  `skill-tool.ts` `removeConversation`, and keep the 256-entry `RangeError` as the last-resort guard.
- `src/runtime.ts`: hoist one `installContextFor` holder (same pattern as `harnessRef`) assigned inside
  the `try`, have it report the skill count, and use it from `prepare` (grants + `skill` registration +
  explicit extensions) and from startup. Startup restore must come from **live `nanobot.cron.run` tasks**
  (checkpoint `targetConversationId`), never from a `SessionMap` entry: a map entry would make the run a
  cron owner and grow the durable map against its cap.
- Eviction: track created background targets in insertion order and evict an idle one
  (`LiveDoc.run === undefined`) at the snapshot cap instead of failing the run.
- Do not touch `SessionMap`, `cronOwners`, `denyNewConversation` or `extensionsPolicy`.

Accepted costs, verified by probe: file I/O inside the prepare commit; orphaned slots after a
rolled-back prepare (bounded, cleared on reopen, evictable); and a prepared-but-not-yet-started target
that can be evicted at the cap, after which that run proceeds without context rather than failing.

## Evidence and limitations

- Parent baseline: typecheck + **155 behavior / 9 execution** checks pass. Those
  counts predate memory/skills/cron and do not imply dedicated regression coverage
  for the new slices; their focused evidence largely consists of temporary probes.
- Consolidation added no permanent tests. A temporary faux-provider probe traversed
  the actual Gateway on **host and bwrap**: bootstrap + memory manifest, skill
  body absent from prompt then loaded on demand, all four coding tools, topic write,
  another session denied coding tools, revoke/reopen, stable conversation identity
  and refreshed skill body. Both passed; no provider or Telegram network calls.
- Compaction, calendar DST/leap-day, timer-before-model and crash/restart probes are
  recorded below and in package docs. Real-model summarization, real scheduled
  delivery and combined real-workspace acceptance remain unproven.
- No new live-data activation, paid call, deployment or Python change occurred in
  consolidation. The copied personal skills remain inactive. Historical Git privacy
  references are retained by owner decision; do not rewrite history during cleanup.
- Calendar refinement exceeded the planned review budget. It is now closed; this
  exception is not permission for further review/fix chains.

This is the current scope/status/stop-rule authority. It supersedes the sequencing
and conflicting scope assumptions in `2026-10-26_full-port_TODO.md`, including the
P1–P9 milestones and worker-assignment sections as standing instructions. The older
file preserves historical evidence, completed slices, the original parity map and
reuse guidance; its unchecked boxes are not a current implementation queue.

Deployment preferences and product-usage decisions stay with the owner; engineering
completion does not imply activation or cutover permission.

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
  writes to runtime state files) and the `allowedEnvKeys` environment allowlist, so
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

### W2 — optional shell sandbox (complete for agreed scope)

`toolSandbox: "bwrap"` wraps shell commands on the actual read-write workspace;
filesystem tools use the same guarded host APIs as W1. Networking remains available,
`/tmp` is private, system mounts are read-only, and the workspace parent is masked.
Validated executable/setup errors fail closed without host fallback. Shared shell
policy, environment filtering, timeout and native output semantics remain in force.
Bwrap adds process namespace teardown, not hostile-tenant resource quotas.

Host spill files are readable through `read` during the environment lifetime, not
inside bwrap's private `/tmp`. Extra mount/toolchain limitations are documented in
`DIRECT_BWRAP.md` and `TOOLS.md`. This replaces the old managed-copy,
all-operations-confined design; it does not claim shell/file isolation parity.

Exit met: reviewed config-selectable backend, synthetic checks and an authorized real
provider turn using all four tools. Default remains host/off; W2 does not gate W1.

### W3 — memory, context and compaction

Markdown is the memory source of truth; Durable owns runtime state, transcripts and
compaction. Opt-in loaded context, topic manifest and file read/write, plus summary-only
skills with on-demand bodies are integrated. Snapshots refresh at creation/reopen
or on explicit host refresh (local CLI `/refresh`), not automatically after an edit.

Foundation verified: topic writes survive restart, skill discovery/body loading works,
and an early fact crosses native compaction into a fresh process via a faux summarizer.
Remaining acceptance: curated builtin compatibility and real-model use of memory,
skills and compaction. No claim of full Python memory/search/usage parity.

#### Agreed history design — 2026-10-29 (message/tool slice wired; summaries not started)

Owner preference recorded 2026-10-29: retrieval should be agent-facing. The
assistant should search and open prior discussion itself; the local CLI history
commands remain a trusted debugging surface, not the expected user path. That
preference does not authorize episode summaries or a summary search claim before
the summary index exists.

**Authority and terminology.** Durable's Session is the storage/runtime container;
a Conversation is a persistent transcript. Our Telegram adapter maps each bot + chat
to a conversation, not all Telegram users to one; the CLI has its own. An **episode**
is a discussion bounded by committed resets within a conversation. `/new` starts
fresh model context without deleting entries or changing conversation identity.
Compaction changes working context within an episode; it does not close that episode
or remove originals. Telegram `/new` still needs command wiring.

Durable is the canonical transcript source, untouchable by memory tooling: retrieval
is read-only. Markdown remains authoritative for curated long-term knowledge.
Unlike Python's clear-active-session + archive pipeline, do not maintain another
full-transcript archive. Indexes may duplicate searchable text internally, but are
rebuildable derived data, not a second transcript authority.

**Three layers:**

1. Original Durable entries with stable source references.
2. Episode catalog: identity, exact entry boundaries, dates, message count, title,
   LLM summary (topics, decisions, outcomes, open questions), pending/ready/failed
   status, source references and summarizer version. Summaries aid discovery; the
   original messages establish what was said.
3. Rebuildable full-text indexes over message text, tool activity, and episode
   titles/summaries. Start with SQLite full-text search; defer embeddings unless
   keyword-plus-summary retrieval proves insufficient. The parked scan-based history
   API is not this index and is not accepted by this design decision.

**Search contract:**

- Default: user/assistant message text, optionally filtered by role.
- Optional scopes: tools only (names, arguments, results), or messages + tools.
- Thinking and system instructions stay excluded from these search scopes; synthetic
  reset handoffs and compaction summaries are not ordinary messages. These are query
  filters, not deletion from storage. Episode summaries are separately searchable.
- Support topic discovery through summaries and detail lookup through messages/tools.
  Results identify their source, show matching excerpts, and link to the original
  entry and surrounding discussion.
- Index active episodes too: message search must not require a reset or successful
  summary. All authenticated channels may browse mapped chat conversations under
  the single-tenant policy; hosts authenticate access. State-only conversations are
  not chat history. Optional tool search exposes records, never execution authority.

**Reset and summary lifecycle.** Derive episode boundaries from actual committed
reset entries, not command receipt time: busy resets can be queued. Summarize the
closed episode in the background without delaying fresh context. Prefer incremental
reconciliation with persisted progress and idempotent episode/job identity, catching
up on reopen, over changing native reset ordering. A crash between reset and job
creation must delay, not permanently lose, a summary. Persist status and retry
handling; provider success is not guaranteed. Use the original message range, not
only the latest compacted context; long episodes need bounded processing with
explicit coverage rather than silent truncation. Raw message search remains available
when summarization fails.

**Open implementation gates.** Confirm supported incremental indexing/scheduling
APIs, index freshness/rebuild behavior, long-episode summarization and tool-record
coverage. Require source/store identity and query-bound cursors, stable pagination
under appends/reopen, visible limits/omissions/index lag, and continued access to
originals. Resolve parked cursor/reporting findings before reusing candidate code.
Design agreement is not authorization to resume implementation or launch agents;
the owner requested convergence and discussion.

#### Episode catalog foundation — 2026-10-29 (implemented, summaries not started)

Landing the durable half of W3 without model calls, tasks or scheduling:

- `src/history/store-identity.ts` — one session-scoped `nanobot.store-identity`
  document (`format`, `version`, `storeId`, `createdAt`), minted on the first
  gateway open and only ever read afterwards, so repeated opens converge on the
  first committed value. `ensureStoreIdentity()` is idempotent and needs no scan.
  A derived index must persist `storeId` and discard its rows when the value
  changes; a file path or inode cannot tell a replaced store from the old one.
- `src/history/episodes.ts` — episode boundaries derived from committed
  `pi.reset` entries only (`conversation.reset()` and the `handoff` tool control
  both write one; a handoff's user message is part of the reset entry). An
  episode is `[startEntryId, endEntryId]` inclusive, starting at its reset entry
  or at the conversation's first entry. Compaction (`pi.compaction`) and system
  entries stay inside an episode: only a reset closes one.
- Empty episodes are omitted everywhere, by the same rule: an episode is empty
  when it holds no entry other than its own reset marker. That covers two
  consecutive resets, a reset carrying only handoff text, and a reset that closed
  a segment before any content was committed. An empty episode is never recorded,
  never listed and never returned by the single-episode read, so the tail cannot
  show a phantom open discussion.
- A reset handoff is synthetic context, not an ordinary user message: the text
  lives in the reset entry's own `model` payload, so it is never counted in
  `messages` and never makes an episode exist (`messages` counts only
  `pi.user`/`pi.assistant` entries). `entries` counts every entry in the inclusive
  range including the reset marker, and `toolResults` counts `pi.tool-result`
  entries; system and compaction entries are entries but not messages. The
  handoff text may later be exposed as separate episode metadata.
- Durable state: one fixed-size `nanobot.episode-catalog` progress document per
  conversation (scan cursor, open-episode start/reset/end, counters) and one
  small `nanobot.episode` document per closed, non-empty episode, keyed by its
  start entry ID. Episode documents and the cursor commit together, so a crash
  neither loses a closed episode nor records it twice; an existing closed
  episode is never rewritten. Nothing grows with entry count: progress is
  O(1), an episode is O(1), and empty episodes are never stored.
- A closed episode records `summary.status = "pending"`,
  `summarizerVersion = 1`, `attempts = 0`. That is durable state for a later
  summary pass, deliberately not a schedule: no task, model call, retry or
  notification exists yet. The future job identity is
  `conversationId:startEntryId:summarizerVersion`.
- Reconciliation is incremental: ascending entry batches from the persisted
  cursor, committed in bounded groups (`EPISODE_LIMITS`), rescheduled until
  caught up, retried a bounded number of times in-process, surfaced by the
  explicit `reconcileHistoryEpisodes()` call, and deferred past gateway open so
  a long history blocks neither startup nor a turn. It triggers on committed
  reset entries through the public `Session.subscribeCommits()` listener (an
  acknowledgment, not a poll) and catches up on reopen, including resets another
  process committed while this one was gone. It never changes native reset/busy
  ordering: only entries that are already committed are read.
- Scope is single-tenant mapped chat: the values of `nanobot.session-map` minus
  keys ending in `:channel-state` (the channel bookkeeping convention in
  `src/history/scope.ts`). Task-owned and otherwise unmapped conversations
  (a scheduled run's background target) and the root are never catalogued,
  because they are not in that map. Hosts authenticate before naming a session
  key; the read API rejects a state-only session key rather than guessing.
- Host API (additive on `Gateway`): `historyIdentity()`, `listHistoryEpisodes(sessionKey,
  { limit?, before? })`, `historyEpisode(sessionKey, startEntryId)`,
  `reconcileHistoryEpisodes(sessionKey)`. Listing reads entries and episode
  documents and writes nothing. Reads agree before and after reconciliation,
  because `list` and `historyEpisode` derive boundaries from committed entries
  with the same rules; reconciliation only turns an `unknown` summary state into
  `pending` and makes a closed episode's document authoritative (it is immutable
  and answers identically before and after). Exact counts come from the same
  scan, or from the progress counters when they reach the tail. A tail reset
  closes the episode above it in every path. `next.before` is a durable entry ID
  (an episode start), so pagination is stable across appends and reopen, and any
  other bound is rejected instead of mislabelled.
- Read bounds are page bounds, not a hard cap: a page reads entries in groups of
  `EPISODE_LIMITS.entriesPerPage` until it has filled a page of episodes (so a
  conversation without resets costs one full scan), the single-episode read walks
  only that episode's entries, and the caught-up fast paths cost one entry read
  plus one document read per episode. No read writes anything. Empty episodes and
  `unknown` summary states make omissions visible; original entries remain the
  authority.

Known gaps, deliberately not claimed: episodes carry no wall-clock dates
(Durable entries have no timestamp; only entry IDs order them), no titles, and no
summary text. Summaries, retry/backoff, long-episode coverage bounds and summary
search are later slices. Message/tool search, CLI browsing and a default
agent-facing `history` tool now exist; there is no Telegram/web command surface.
There is also no durable enumeration of pending summaries: episode
documents are not scanned by this module, so a future summary pass needs its own
work queue or an index over `pending` episodes, and nothing schedules one today.
The store identity document itself is frozen and never updated.

**First bounded slice — 2026-10-29 (identity-wired; no summaries, no UI).**
`src/history/index.ts` implements the message/tool FTS5 index, committed reset
boundaries, bounded incremental reconciliation and query-bound stable pagination
behind `Gateway.historySearch`. The slice is wired: `openGateway` resolves the
committed `nanobot.store-identity` with `ensureStoreIdentity` and binds the index
to that `storeId`, so the method is available on every Gateway and there is no
caller-injected identity option. It does not implement episode summaries or
summary search. The local CLI browses these reads and the read-only agent-facing
`history` tool is installed by default for mapped chats, including source-scoped
episode listing and bounded episode drilldown; no Telegram or web command surface
exists. The
index is a separate `0600` rebuildable file and never writes Durable; long text is
chunked and lag, coverage and omitted chunks are visible. Identity is copied with
the store file, so a clone or restored backup keeps the same `storeId`; detection
there relies on the per-conversation first/last entry fingerprints, which rebuild a
conversation whose tail no longer matches, and only imperfectly (see `HISTORY.md`
for the rollback caveat and scan costs). This is not acceptance of the parked scan
candidate `worker-history-read-252d9447`; no code from it was reused.

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

Cron timer/calendar foundation is integrated; do not resurrect superseded one-shot
kernels. Agent-callable scheduling, runtime authorization and delivery remain unwired.
No direct user-facing cron interface is required.

Wanted after core acceptance and owner agreement: background subagents and Code Mode
workers, then Telegram/Discord/Email/WebSocket integration. Define a bounded acceptance
gate per chosen item before building. Dedicated heartbeat, sustained goals/tasks and
standing intents are excluded; an ordinary cron job can cover heartbeat use cases.
No new W5 work starts during consolidation.

### W6 — WebUI and retirement

Deferred pending an explicit owner discussion. Existing inventory/import work does
not authorize UI reconnection, migration, retention policy, deployment or Python
retirement. Backup/restore and cutover/rollback acceptance must be planned separately
if and when a live pilot is approved.

## Open design questions

1. **Memory source of truth — decided:** Markdown files are authoritative for
   memory; Durable owns runtime state, transcripts and compaction. Preserve the
   useful Python layout and behavior without introducing a second memory store.
2. **SQLite ancestor-swap race** — Node's SQLite has no safe pinned-open API.
   `pi-b54f4507` (tmpfs staging) and `pi-ba6fe170` (create-only publication) build
   machinery for it. Decide whether the remaining window is acceptable for a
   one-off offline operation before either branch continues.
3. **MCP legacy SSE** — `pi-mcp` 1.4.0 does not support it. Either a reviewed
   compatibility layer, an endpoint migration, or an explicit loud failure on a
   configured SSE server.
4. **Tool names — decided for coding:** native `read`/`write`/`edit`/`bash` plus
   read-only `skill`; adapt curated instructions rather than adding Python aliases.
5. **Delegation shape — open:** background subagents versus Code Mode workers,
   parent/child authority, reporting and cancellation; decide before implementation.
6. **Pilot and acceptance — open:** agree actual use, budgets and requested channels
   before authorizing real-workspace/provider acceptance. No live polling by default.

## Review protocol

- One independent review per slice. Blockers get one fix pass by the same owner.
  A second blocker set parks the branch with a recorded reason. No third round.
- At most two implementation slices in flight at once.
- Every branch ends merged or parked with a reason. No indefinitely preserved
  candidates; that is how 25 branches became a backlog.
- A slice that grows a second security boundary mid-review is a scope error: park it
  and write the boundary down instead.
- Existing behavioral suite stays green. Add or expand permanent tests only when
  explicitly requested; otherwise use existing checks and bounded temporary probes.

## Consolidation pause — 2026-10-28

Calendar verification and integration are finished. Consolidation is active;
new implementation slices and review/fix chains are paused. Do not begin Gateway
cron-tool, grant, outbox, channel or other feature wiring. Reconcile status, verify
the core path offline and inventory cleanup; agree priorities before more work.
Cleanup removes only proven-owned, reviewed resources, never fixed/unowned temp
paths or independently owned worktrees.

## Cron foundation status

Cron calendar schedules `c14e5353c`, `3acdd2b80`, `247a97300`, `60cf77cd9` are
integrated as `430abd7db`, `560bdee98`, `27082bfd7`, `2f618474a`. These add
`at`/`every`/`cron` with IANA timezones, using exact dependency `croner` 10.0.1
(offline install). Functional verification passed, including leap-day and
`W`/`LW` month-list expressions, strict-future and daylight-saving checks. Parent
typecheck, 155 behavior and 9 execution checks pass after an offline `npm ci`.
Known library differences: six-field seconds come first; one-hour folds run the
first occurrence, while tested 30-minute/two-hour folds resolve to the later offset
and can skip same-day occurrences. Year/search bounds apply; see `CRON.md`. This remains an
unwired foundation; no Gateway cron tool, delivery or grant reauthorization is
active.

Cron replacement `072ed6d2d`, `340c26b54`, `6dc74fac4` passed independent final
review (`pi-c2787ba0`) and was integrated as `a9e788a56`, `022162fd0`,
`8a8213bf6`. Finite timers arm successors before model work; a separate run task
reattaches using native submission IDs. Fake-provider crash, cancellation and
hung-run probes passed; parent typecheck, 155 behavior and 9 execution checks
pass. Calendar schedules are now integrated. This is still an unwired foundation:
Gateway tool, grant reauthorization, outbox and channel delivery are required. Cancellation may
wait for a model that ignores abort; origin cancellation cannot retract a placed
turn. Stored task records have no platform retention yet.

## Parked / unmerged inventory — 2026-10-28

| Candidate | State / reason | Consolidation disposition |
| --- | --- | --- |
| `pi-818cb00c` / `b986d5adb` | Scheduled Telegram outbound path; existing independent review told to stop after its current command and report | Unmerged; collect findings only, no more probes/fixes/runtime wiring |
| `pi-e796f4e1` / `bd5442e2d` | Curated builtin skills candidate, superseded: its skill-creator required same-conversation verification despite fixed snapshots | Superseded by `feat/curated-builtin-skills`, which fixes that instruction, adds `cron`, and drops `my` |
| `pi-d2c45589` / `93365737a` | Old recurring cron kernel faults on no-progress checkpoint | Superseded by integrated finite timer/run design; do not revive |
| `pi-cbf84ad6` / `f03f75c9c`, `pi-23d2bdf0` / `9cc565dc3` | Earlier one-shot scheduling kernels | Superseded; reference only |
| `pi-acb8f4a0`, `pi-71c6dac3` | Discord candidates, not integrated | Preserve until channel scope agreed |
| `pi-b5ac8248` | Memory search over supplied snapshots | Not Markdown-authority memory parity; no activation |
| `pi-1631ba70` | Synthetic Gateway grant proof | Existing product grants supersede the need for a new fixture feature |
| `pi-7384fed4`, `pi-b54f4507`, `pi-ba6fe170`, `pi-be224dbf` | Unmerged archival renderer/staging/publication/search refinements | Deferred with migration; preserve data-integrity findings |

Some earlier archival helpers and the managed-copy sandbox are already integrated
SDK/experimental code; parked follow-ups do not mean those files are absent. They
are not part of the current ordinary Gateway path.

Git worktree inventory after the 2026-10-28 cleanup: parent, `pi-818cb00c` (parked
Telegram candidate, still unmerged) and the active worker. The five other checkouts
(`pi-8d9f1378`, `pi-e078edd8`, `sub-pi-durable-execution`, `sub-pi-durable-runtime`,
`sub-pi-durable-telegram`) were clean, and `git cherry` showed every unique commit
already present in the integration branch, so their worktrees and branches were
removed. Parked candidate branches without a checkout stay preserved; no bulk branch
or Git-object pruning is authorized.

The reviewed calendar worktree/branch was already removed after patch-equivalence
verification. Consolidation closed its two remaining completed reviewer tabs and
removed only the parent's freshly owned synthetic-probe directory after recording
results. Temporary paths of uncertain ownership remain untouched. Do not treat an
old worker registry entry as proof that its worktree still exists.

## Target exit — not yet achieved

Tools, memory and skills work together on the port within the agreed damage model,
a real-model acceptance suite and diffs are recorded, and the optional shell backend
is selectable. Core foundations are integrated, but W3/W4 acceptance and internal
agent cron wiring remain open; this is not yet an everyday replacement or cutover approval.

## Session log

### 2026-10-29 — reviewed episode browsing and background summaries

Integrated reviewed agent-facing episode listing/drilldown with truthful bounded output,
quoted labels and reset-safe open-episode snapshots. Integrated the independently
reviewed durable summary task with bounded folds, scope validation, backfill and retry
accounting; normal startup policy and summary indexing remain open. Combined tree
passed typecheck, 155 behavior, 9 execution and 88 core acceptance checks offline.
Real-model fidelity, an actual worker-fault integration case and the source-unrenderable
fallback remain unverified. The merged-tree reviewer verified task-owned scope gating,
agent-tool host wiring and concurrent catalog/summary operations.

### 2026-10-29 — episode drilldown review hardening

Review fixes on the agent-facing episode slice: a display limit reached inside the
final raw page no longer marks the episode exhausted; the footer reports the actual
unexamined rows and any remaining raw pages. `open` and `episode` now report the
rows actually displayed versus selected, with byte-culled rows counted consistently
in the count line and omission notice. Stored tool labels are collapsed to one
sanitized line before display, so a newline in a tool name cannot forge a result
line. Open-episode drilldown is pinned to a tail entry read at call time and
re-confirms the episode before reading content, so a concurrent reset or append
cannot spill into the next episode; the result reports the snapshot bound. Offline
probes covered closed 11-entry/limit-8 and 30-entry/limit-3 final pages, forced
48 KiB multibyte culling for `episode` and `open` with matching counts, newline
tool-name spoofing, concurrent reset interleaving, source isolation and no network
or permanent test. Typecheck and the existing behaviour, execution and core
acceptance suites pass.

### 2026-10-29 — agent-facing episode listing and drilldown

Extended the default read-only `history` tool with `episodes` and `episode` actions
over the existing `Gateway.listHistoryEpisodes`, `Gateway.historyEpisode` and
`Gateway.historyEntries` methods. `episodes` lists reset-delimited boundaries for
one exact source label, newest first, with durable `before` continuation from
`next.before`; `episode` opens one start boundary and its first bounded window of
displayable message/tool entries. No new Gateway scope or cross-conversation
pagination was invented: `search` remains the discovery path because its hits
already carry session labels and episode starts, while episode listing stays
source-scoped and claims no total count. Both actions share the mapped-chat,
ownerless/unforked validator; state-only, unknown, task-owned and unmapped sources
remain rejected. Output quotes and sanitizes entry text, hides reset handoff/system/
compaction/thinking/image-only content, respects the 48 KiB UTF-8 bound, and reports
partial scans, omitted entries, open episodes and `unknown` summary state honestly.
No titles or generated summaries are fabricated, and summary status is metadata only.
Offline faux-provider probes covered reset boundaries and recorded `pending`
summary state, per-source pagination and rejected arbitrary bounds, state-only/
unknown source rejection, search discovery with state-only exclusion, pre-reset and
post-reset drilldown, Gateway reopen stability, the runtime-installed tool,
injection-like U+2028 text and multibyte bounds. Typecheck, build and the existing
behaviour, execution and core acceptance commands pass; no permanent test, live
provider, network, credentials or personal data was used.

### 2026-10-29 — authorized implementation batch: recall reliability and Telegram controls

Owner approved committing the priority plan (`ffa6b71`) and coordinating 2–3 Umans
DeepSeek Flash/high agents. Active bounded assignments:

- `worker-summary-task-e10a8d20` (`w2R:p1`): close summary renderer/version/retry
  blockers; commit a stable candidate for independent re-review. Existing summary
  reviewer holds prior findings and awaits that candidate.
- `worker-tg-controls-0d903ab6` (`w2V:p1`, worktree/branch of the same name, base
  `ffa6b71`): implement authenticated `/new`, `/abort`, `/help` via native APIs,
  preserving per-chat authority and durable update/reply handling.
- `reviewer-tg-controls-66707c9b` (`w2D:p3B`): preflight authentication, admission,
  reset/abort and redelivery constraints, then review the stable implementation.

Summary discovery/indexing follows a reviewed summary contract; cron delivery comes
later. No live model/channel calls, credentials, personal data, deployment or
permanent tests are authorized by this batch. Integrate only reviewed commits and
validate the combined tree; record limitations rather than imply acceptance.

### 2026-10-29 — prioritize finishing agent-facing recall

Recorded the next-value order: finish the reviewed summary candidate and normal-path
model policy, index summaries for agent topic discovery, prove recall across reset/
reopen, then minimal Telegram controls and cron channel delivery. Consolidated duplicate
history checklist items and corrected the stale no-CLI status. Agent-facing retrieval
is the product interface; no more history commands planned. Summary code remains
unmerged; no new agents or live runs started for this planning update.

### 2026-10-29 — agent-facing history tool

Added one read-only model-facing `history` tool to the default Gateway for mapped
chat conversations. `OpenGatewayOptions.agentHistory` defaults on and is a host
off-switch for a bare deployment; the local CLI/Telegram path uses the default. The
tool searches user/assistant message text across the mapped chat conversations by
default, accepts explicit `tools`/`all` scopes for tool names, arguments and results,
and opens a bounded entry window around a source hit.
It calls the existing `Gateway.historySearch`/`historyEntries` host surface, so it
creates no conversation, writes no transcript, grants no filesystem or shell
authority and rejects state-only/task-owned sources through the same validator. Output
is bounded and source-labeled, quotes historical text as untrusted data, reports
completeness/lag/truncation, and offers an opaque validated cursor. It explicitly
says episode summaries are not searchable. Offline faux-provider Gateway probes
covered cross-session message search, explicit tool scope, pagination, open/radius,
malformed and changed-query cursors, reset-handoff exclusion, injection strings,
abort and the `agentHistory: false` opt-out boundary; typecheck, 155 behaviour
checks and 9 execution checks pass. No summary code, test file, live provider, network or personal
data was involved.

### 2026-10-29 — history tool review hardening

Review fixes for the default agent-facing tool: `open` with `scope: "tools"` no
longer returns user/cron text and counts those entries as omitted; quoted fields
escape U+2028/U+2029 so they cannot inject raw line breaks; and the rendered result
now budgets UTF-8 bytes (48 KiB) instead of UTF-16 characters, reserving the
mandatory coverage/cursor footer before admitting rows so the 64 KiB tool limiter
cannot truncate it for multibyte text. Synthetic probes covered open scopes
`tools`/`all` and omitted counts, quoted separators, a forced multibyte byte-bound
with an intact cursor/footer and visible row omission, and multibyte cursor resume.
Typecheck, 155 behaviour checks, 9 execution checks and 88 core-acceptance checks
pass; no permanent test or live data involved.

### 2026-10-29 — local history browsing

Integrated independently reviewed CLI message/tool search and cross-session episode/entry
browsing (`3d2fa58`, `b845e21`, `c2a0110`). The terminal reports incomplete index
coverage and bounded output; session hints require exact identifier round-tripping.
Summary work remains unmerged and under review. No live channel/provider validation.

### 2026-10-29 — episode catalog consistency fixes after review

Fixed a reset at the tail being reported as the open episode whenever it followed
content: the descending derivation now marks the scan as reset-bounded at every reset
entry it meets, including a reset with no content above it. One rule now decides
emptiness for reconciliation, listing and the single-episode read (no entry other than
the reset marker), so consecutive resets, resets carrying only handoff text and resets
closed before any content are all omitted instead of appearing as an empty open
discussion. `historyEpisode` derives the same boundary as `list` before reconciliation
(marker validation plus a walk over that episode's entries, with the caught-up fast
path using the progress counters), so reads agree before and after a pass and only the
summary state moves from `unknown` to `pending`. The store identity object is frozen.
Documented the handoff-is-synthetic rule (handoff text is neither a message nor
episode content), the counts contract, the page-bounded read cost, and the remaining
pending-summary enumeration gap: no work queue or index over pending episodes exists,
and nothing schedules a summary. Offline probes covered pre-/post-reconciliation tail
resets, consecutive and handoff-only resets, busy/queued resets, pagination before and
after reconciliation, background and startup catch-up, scope exclusion, and that
derived documents match the listed view; the 155 behaviour, 9 execution and core
acceptance checks still pass.

### 2026-10-29 — durable store identity and episode catalog foundation

Implemented the durable half of W3 with no model calls, tasks or scheduling: one
immutable store identity document, reset-delimited episode boundaries derived from
committed `pi.reset` entries, one fixed-size progress document plus one small document
per closed episode with durable `pending` summary state, and a narrow host read API
(`historyIdentity`, `listHistoryEpisodes`, `historyEpisode`, `reconcileHistoryEpisodes`).
Reconciliation is incremental, batched, crash-resumable, triggered by the public
commit subscription and caught up on reopen; the mapped single-tenant chat scope
excludes channel-state, task-owned and unmapped conversations. Offline synthetic probe
covered idle, consecutive and handoff resets, a queued busy reset, pagination, reopen,
an offline-committed reset, background and startup catch-up, idempotent writes and
scope exclusion; `typecheck`, 155 behaviour checks, 9 execution checks and core
acceptance still pass. Known gaps: no dates, titles, summary generation, retry or
search yet.

### 2026-10-29 — history search wired to the durable store identity

`Gateway.historySearch` is now on by default instead of dark: `openGateway` passes
the committed `nanobot.store-identity` `storeId` to the derived index and the
`OpenGatewayOptions.historyStoreId` injection point is gone, so no caller can
re-bind a stale index with an arbitrary string. The Gateway's restore pass, episode
scope and search scope now read the persisted session map through one shared
validator in `src/history/scope.ts` (`readMappedSessions`/`readChatSessions`),
keeping the task-owned/fork rejection and the 256-session cap; the index imports the
same `:channel-state` constant instead of a third copy. A failed open and a close
now close the derived index handle. `HISTORY.md` and this plan were corrected:
identity is now the committed document, the clone/restored-backup rollback caveat
and the per-conversation fingerprint fallback are explicit, steady-state and cold
rebuild scan costs are stated, and the last-term prefix/chunk-fragment false
positives are documented. Summaries, summary search and any history UI remain
unimplemented. Disposable synthetic Gateway probes covered message/tool search,
role and scope rejection, state-only exclusion, reset boundaries and episodes,
reopen without reindex, clone, same-store rollback, store replacement with index
rebinding, a failed-open cleanup path and search-after-close; typecheck, 155
behaviour checks, 9 execution checks and 88 offline core-acceptance checks pass.

### 2026-10-29 — first message/tool history index slice

Added a rebuildable SQLite FTS5 index over Durable-retained user/assistant messages,
tool names/arguments/results and committed reset boundaries, exposed as
`Gateway.historySearch` (no UI, no episode summaries, no candidate reuse). At that
point it was dark/unwired: it required an injected durable store identity and had
no default exposure. The index lives in a separate `nanobot-history-index.sqlite` file, reconciles bounded forward from
persisted entry fingerprints and progress, reports lag/coverage/truncation/edits,
chunks long text with bounded per-entry generation and per-entry writes, and rejects
stale/replaced-store/mapping-changed cursors. `:channel-state` remains explicitly
excluded in addition to positive chat-history classification. Offline synthetic
probes covered scopes, role filters, reset boundaries, long-text chunks, tool-call
IDs, pagination under appends, store-identity rotation, explicit lag and byte/time
bounds, file mode, source-path alias guard, reopen and a real faux-provider Gateway
with an injected store ID and a populated channel-state conversation. Typecheck, 155 behavior, 9 execution and 88 offline
acceptance checks passed. Episode catalog/summary work and summary search remain open.

### 2026-10-29 — history design agreement; implementation remains paused

Recorded the agreed canonical transcripts, reset-delimited episodes with background
LLM summaries, and rebuildable full-text indexes. Search defaults to user/assistant
text with optional tool names/arguments/results and links to original entries/context.
Added the W3 contract and unchecked delivery tasks. Documentation only; no new code
or agents. Next: agree a bounded implementation scope before resuming.

### 2026-10-29 — local usability and history direction

Integrated reviewed fixed, value-free startup diagnostics (`c0b4465`, `0027f3e`), removed
local `/steer` and `/after` at the owner's request (`387b4fa`), and added native CLI
`/new` reset (`9321d20`). Reset retains Durable entries and conversation grants; it
currently makes no summary. Independent synthetic review verified busy ordering,
SQLite reopen and authority. Owner prefers native retention and browsing across all
authenticated channels in this single-tenant system, with a summary after each `/new`;
summary scheduling/search remain future work. The subsequent W3 agreement makes
message text the default search scope, adds tool-only or combined search, and adds
an episode-summary discovery index.
Origin-mode scheduled turns observed by the attached CLI now display their final
answers (`6c72388`, `dd84509`); isolated runs still have no outbox. Owner also
requested Telegram `/restart` with automatic build and a separate admin allowlist.
The unintegrated restart candidate `worker-tg-restart-ab803a34` (`8b06ec7`) is parked:
repeat restarts fail, Node build isolation is weaker than claimed, and source stability
and power-loss durability need design. The unintegrated message-history candidate
`worker-history-read-252d9447` (`87bd269`) is also parked: cursors can cross a replaced
store at the same path and Unicode normalization can invalidate continuations. Further
history bounds and reporting issues are in its review. Both worktrees are preserved;
no new fix pass was started after the owner requested convergence.

### 2026-10-29 — local CLI grants and context refresh

Integrated local CLI `/tools`, `/grant` and `/revoke` controls (`d7e1d15`): grants
remain explicit, expiring, ceiling-bounded and local to the CLI conversation. Added
explicit Gateway context refresh and CLI `/refresh` (`e4b848b`, `57c6980`, `61a868e`),
so skills created during a conversation can be discovered without reopening. Refresh
rejects busy conversations and preserves grants. Independent reviews and synthetic
probes covered authorization, refresh rollback, concurrent loads and CLI behavior;
workers ran typecheck, 155 behavior, 9 execution and 88 offline acceptance checks.
No live provider, credentials, personal workspace or channels were used.

### 2026-10-28 — real-model synthetic core acceptance passed on revised prompt

Owner authorized one additional live attempt under the same per-run limits. After independent review,
`0097664` and `43382bd` scoped the no-echo instruction to the immediate conversational reply without
instructing the summarizer, retained exact-match pass criteria, and recorded normalized observations
on failure. The revised synthetic run passed 40 live checks: on-demand skill load, Markdown topic
write/read, native compaction with the exact early fact in the summary, fresh-process reopen and
exact recall. It made 10 provider requests, reported 55,369 input tokens plus cached input and 1,471
output tokens, and reserved 319,567 input equivalents and 17,920 output tokens without a budget
violation. Budget assumptions remain conditional as documented in ACCEPTANCE.md. The earlier
confounded failure remains evidence; one later success does not establish general reliability.
The summary also carried the skill body and topic marker into the reopened request; the initial system
prompt still contained only skill metadata. A/B fixtures, channels and real workspaces remain unrun;
W4 as a whole is not complete. Parent reran typecheck, offline acceptance and rehearsal, 155 behavior
and 9 execution checks successfully.

### 2026-10-28 — cron terminal retirement fix

Integrated `0e50103`: all request-linked terminal paths retire a prepared background target's
copied grants and tools in the terminal commit, including fenced and missing-job cases. Independent
review covered ten synthetic scenarios and a SIGKILL/reopen probe, with a negative control. Origin
mode and newer runs retain their own authority. A phase fault or crash before the terminal commit
can still defer retirement until reopen; the origin hook bounds calls in the meantime.

### 2026-10-28 — real-model core acceptance: compaction fidelity failed

Owner authorized one synthetic DeepSeek Flash run at low thinking, with at most 20 provider requests,
600,000 conservative input-token equivalents and 20,000 output tokens; the byte-based accounting and
provider output cap depend on explicitly reported assumptions. Reviewed runner integrated as
`b35eb74`, `a36a358`, `6f7e972`; offline rehearsal passed. One live run made 8 requests, reported
24,996 input tokens (plus cached input) and 1,050 output tokens; no budget violation. Skill discovery
and on-demand loading, topic memory write and read, and native compaction completed. The summarizer
request contained the early fact, but the placed summary did not: the check failed and the fresh-process
recall phase was skipped. The summary input checks verified the early fact and sentinel in the same
user turn. This exact-string failure is confounded: that turn also instructed the model not to repeat
or quote the code, and the report cannot distinguish omission from normalization or reasoning-only
placement. A reviewer confirmed output truncation is not a plausible cause at the reported usage.
Fresh-process recall is unproven, not failed. No retry or A/B fixtures were run; W4 remains open.
Temporary synthetic state was removed.

### 2026-10-28 — cron origin authority reauthorization

Owner selected this slice in parallel with acceptance tooling. Integrated `8011821` and `00d7aff`:
background coding grants are bounded by the origin's current grants at call time and pruned before
resume; normal completion and abort retire them. Independent review reproduced an upgrade/restart
failure on the first commit and verified the follow-up fails closed for pre-upgrade targets, preserves
valid new targets, and handles terminal targets. Native coding tool execute intents are unsafe to
replay. Some cancelled/superseded early-return paths retain bounded grants until reopen; documentation
records this limitation. Parent reran typecheck, 52 synthetic acceptance checks, 155 behavior and
9 execution checks. No real provider, channel, personal workspace or permanent tests were used.

### 2026-10-28 — offline acceptance tooling integrated

Integrated `d77c8d9` and `94a83d8`. The offline synthetic Gateway acceptance runner uses a generated
workspace, native tools, on-demand skill, compaction and fresh-process reopen; `npm run --silent
test:core-acceptance` passed 52 checks. An independent reviewer identified a false-positive risk from
reusing the recall fact in topic memory; the single fix pass isolated it and the reviewer verified the
fix. Parent reran the runner, typecheck, 155 behavior and 9 execution checks successfully. Real-model
fidelity, A/B fixtures and channel delivery remain unrun; W4 is not complete. Owner additionally
selected parallel cron origin-grant reauthorization, currently under implementation and review.

### 2026-10-28 — offline acceptance tooling authorized

Owner requested a plan and orchestrated implementation/review with OpenCode Go DeepSeek Flash at
high thinking. Clean extracted checkout at `6382af4`; selected the offline acceptance-tooling option.
Plan: one implementation worker plus one independent reviewer, disposable synthetic inputs only,
one blocker-fix pass, existing checks, then record evidence without marking real-model W4 complete.

### 2026-10-28 — extracted into its own repository

The port moved out of the Python fork into this repository at
`~/projects/durable-nanobot`. History was rewritten with `git filter-repo`: only
`packages/pi-nanobot/` (now the repository root) and the three dated plan
documents were kept, and every branch including the parked `pi-*` candidates came
along. The package prefix was dropped from documentation and the plan documents
moved under `plan/`.

The Python fork keeps `feat/pi-durable-rebuild` as a frozen archive branch; it is
no longer the integration line. Do not push this repository back to the fork, and
do not merge the fork's `main` into it.


### 2026-10-28 — background-run context and curated skills

Integrated the curated builtin skills (`memory`, `memory-defrag`, `skill-creator`, `github`, `cron`)
after a hand-port onto current code; `my` stays out because there is no self-state runtime, and the
`skill-creator` same-conversation verification defect is fixed in the content itself. Then integrated
workspace context for scheduled background runs: `prepare` installs the origin's snapshot for the
run's own conversation, startup restores live run targets from their task checkpoints without a
`SessionMap` entry, and an idle background target is evicted at the snapshot cap.

Verification: worker probes for both slices plus a parent probe on the merged tree — a background run
rendered AGENTS bootstrap, the memory manifest, the memory topic line and the skill description, kept
the skill body out of the prompt, loaded it through `skill` on demand, offered only its granted coding
tools plus `skill`, and refused a `cron` call. Typecheck, 155 behavior and 9 execution checks green.


### 2026-10-28 — agent cron integrated

Integrated `287a5fbf5`. The `cron` tool is now agent-callable (`add`/`list`/`remove`) behind
`cron.enabled`, with ISO-or-calendar schedules, `isolated` default true, owner-scoped job documents
and Gateway preparation that copies the origin's still-valid grants into a fresh background
conversation. The tool is exempt from the grant document because it grants no filesystem or shell
authority, and a background run's conversation never receives it.

An independent review found no blocker and 7 should-fix items. Two were real: cron owners were
restored only inside the context-snapshot branch, so a restart silently removed scheduling from
every persisted session; and a post-commit read error after a successful `add` reported "Scheduling
failed", inviting a duplicate retry. Both are fixed, along with honest cancel results, a replay-safe
tool declaration that makes `tool:<callId>` dedupe real, a `cron` example-config entry and the `tz`
default text.

Verification: worker probe (config gate, model-issued add, isolated and origin runs, copied grants,
list/remove/terminal/unknown IDs, invalid schedules, restart with a pending one-shot, sleeping-timer
cancel) plus a parent smoke on the merged tree; typecheck, 155 behavior and 9 execution checks green.
Known gaps recorded above: no channel delivery, no workspace context snapshot for a background run.


### 2026-10-28 — agent-callable cron, first pass

Owner resumed implementation and asked for coordination through subagents. Committed the first
pass of internal agent cron as `79748d0ad`: a `cron` tool with add/list/remove, `cron.enabled`
opt-in config, Gateway install-before-resume, and background-run preparation that copies the origin
conversation's still-valid grants with their original expiries. The tool is exempt from the coding
tool grant document because it grants no filesystem or shell authority, and a scheduled background
conversation does not receive it.

Two children are running from that commit: `pi-fe0fd520` (verification probe plus fixes) and
`pi-89c0ac7d` (independent read-only review of authority, owner scoping, replay, lifecycle, failure
visibility and doc accuracy). Nothing is integrated or claimed verified until both report. Known
open gaps recorded above: no workspace context snapshot in a background run, and no delivery beyond
the origin conversation.

### 2026-10-28 — cron interface clarification

Owner clarified cron is purely internal: the agent schedules work on the user's
behalf. Corrected "user-facing cron" wording to agent-callable tool/runtime wiring;
no cron UI, slash commands or direct user scheduling surface is required. Existing
execution, authorization and delivery requirements remain. Documentation only;
implementation remains paused.

### 2026-10-28 — consolidation

Owner paused implementation after calendar verification. Reconciled the current
plan against Gateway/config/CLI/SDK code, package documentation and Git metadata.
Corrected stale tool-less/provider/calendar claims, replaced superseded W2/W5/W6
scope, separated integrated foundations from user-facing gaps and excluded features,
and inventoried preserved candidates/worktrees without deleting unrelated checkouts.
Corrected package README and the older roadmap entry point so they point here.

Parent reran typecheck, 155 behavior and 9 execution checks successfully. A temporary
synthetic Gateway probe passed the combined memory/skills/four-tool path on host and
bwrap, including another session's default deny, revoke/reopen, stable session
identity and refreshed on-demand skill body. The probe's first run had an incorrect
assertion about resolved tool objects versus names; correcting the probe (not
product code) yielded both passes. Removed its proven-owned temporary directory
and closed two completed calendar reviewer tabs. The existing Telegram reviewer
was told to stop after its current command and report findings; no fix pass starts.
No new runtime code, permanent tests, network calls, personal workspace activation
or deployment. Next: owner chooses a bounded scope after reviewing the consolidated
state, not automatic implementation.

### 2026-10-28 — baseline and next batch (historical)

Entries below record events at the time; intermediate statements such as "not wired"
are superseded by later entries and the current-state table above.

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

Gateway skill wiring and the summary-only follow-up passed independent reviews
(`pi-f2a1cb04`, `pi-52f41d58`, `pi-50673873`) and are integrated through
`4dcccab46`. Per-conversation prompts contain names, descriptions and locators,
not skill bodies; a read-only `skill` tool loads bodies on demand. No fixed
inventory count cap remains. Parent typecheck, 155 behavior and 9 execution checks
pass; the final reviewer exercised 250 synthetic skills and grant/reopen behavior.
The six retained Python builtins still need port-specific adaptation and packaging;
non-SKILL.md builtin assets are not accessible through the workspace read tool.
The copied personal skill inventory has not been activated or sent to a provider.
Curated builtin candidate branch `pi-e796f4e1` (`d73d907e7`, `bd5442e2d`) was
parked after its final review found that skill-creator incorrectly instructed
in-session verification of newly created or updated skills, despite snapshots
remaining fixed until a new conversation or Gateway reopen. It is superseded by
`feat/curated-builtin-skills`, based on `e326bc364`: the curated set now ships
`memory`, `memory-defrag`, `skill-creator`, `github` and `cron` in
`skills`, adapted to the shipped `read`/`write`/`edit`/`bash`,
read-only `skill` and opt-in `cron` tools. skill-creator now states the fixed
snapshot instead of instructing same-conversation verification, and `my` remains
out because no self-state runtime exists. `builtinSkillsRoot` is still an
explicit host value, so nothing is enabled by shipping the directory.

W3 memory manifest foundation `6bd2d38cf` passed independent review
(`pi-2c56da78`) and was cherry-picked as `050a91ca7`. Markdown remains the memory
authority; Durable owns runtime state and transcripts. Parent typecheck, 155
behavior and 9 execution checks pass. The reviewer verified Python manifest parity
on synthetic data, native read/write/edit and reload in a separate process. This
helper is not wired into the Gateway. Before wiring, address loaded-file parent
symlink traversal, make manifest/total-size limits practical for real workspaces,
ensure loaded files are actually injected, and decide how errors affect a turn.

Memory Gateway wiring `ad53638fe` and fix `5496ffe95` passed independent reviews
(`pi-60a764b0`, `pi-685d1383`) and were integrated as `5ef3a8dcd` and
`07cd71875`. Typecheck, 155 behavior and 9 execution checks pass. Synthetic probes
verified topic read/write, a fresh-process reload, grants, skill coexistence and
visible reporting of bad topic files. An unreadable memory directory can still
block discovery and Gateway reopen; it is documented. Memory and skills are
opt-in and the copied personal workspace has not been activated.

Compaction continuity was probed on `aea2ab774` by `pi-0a9feeec` using an actual
Durable compaction and a synthetic summarizer that extracted an early fact from
the real summary request. A fresh process received the fact via the summary,
not the original message; transcript, grants, memory manifest and skill summary
remained coherent. Typecheck, 155 behavior and 9 execution checks passed. This
proves plumbing, not real-model summarization fidelity; a real acceptance run is
still needed. Durable defaults may be unsuitable for small context windows.

Agent-facing episodic recall by `worker-summary-search-7e4cdd2c` (branch commit)
adds a rebuildable summary title/body index to the existing derived SQLite file
and `summaries`/`summary` actions to the default read-only `history` tool. It
indexes only ready records whose episode document, summarizer version, boundary
and text agree; refresh is on-demand and bounded (newest episodes plus a durable
older cursor), never a model call, catalog write or backfill, and a missing,
failed or malformed summary can only remove its own derived row. `complete` is
per-pass and conservative: a sweep that re-reads only part of the history never
claims complete coverage or absence. Summary pagination uses a snapshot
watermark plus snapshot row count: replacing or removing a member rejects the
cursor, while newer rows are excluded and explicitly reported. Summary schema
creation is isolated from message schema creation, so a summary-index failure
leaves raw message search available. Bodies are bounded per row (20,000 code
units / 32 KiB, titles 1 KiB) and by a 64 MiB whole-index budget with reported
omissions; tool errors are fixed text and do not include host paths. Focused re-review fixes add: one-read quota alternation (a source reads its newest page,
then its older cursor, so 33x2 indexes 66/66 across two passes); byte-counter recomputation
when the summary schema is created/repaired (a fake high counter or missing content table
cannot make the index look full); FTS `integrity-check` plus schema-shape validation before
every summary page (post-open logical FTS row loss, deleted FTS/trigger/sweep and
wrong-shaped sweep are repaired from content; wrong-shaped content is recreated or marked
unavailable); and removal of a replaced summary that no longer fits the budget instead of
retaining stale text. Summary SQL failures return `indexReady:false`/`complete:false`
without affecting raw search. Earlier review hardening adds a durable cross-session rotation cursor (later sessions
are reached on later passes instead of starving beyond the first 64), reserves
part of each session's quota for older episodes, deletes rows for unreadable as
well as unready records, refreshes the now-stale search/episodes/episode
guidance, and verifies/repairs the summary FTS layer from stored content if the
FTS table or triggers disappear (marking the summary index unavailable if repair
fails) without touching raw search. Synthetic offline probes covered exact
13x12 (52 reads/pass, all 156 reachable across passes, never complete), 13x4
(52/52 complete in one pass), 65x1 (first pass 64/65, rotation reaches the
last session next), 33x2 (33 newest then 33 older, 66/66 indexed), 1x12
(8/pass, incomplete, all 12 indexed), deleted FTS/trigger/sweep repair,
post-open logical FTS row deletion repair, wrong-shaped schema recovery,
fake counter/missing content counter recovery, oversize replacement removal,
and raw search intact throughout,
unreadable/malformed summary views, cross-source discovery, absent unready
summaries, malformed and byte-clamped records, non-boundary snapshot replacement
rejection, newer-row snapshot flagging, reopen, index-deletion rebuild, scope
rejection, path scrubbing and tool injection quoting. Typecheck, 155 behaviour
and 9 execution checks pass. Normal-startup summary model/spend policy,
background index refresh and a CLI/channel summary surface remain open.
