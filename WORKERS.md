# Background workers

Bounded ordinary background agents on native Durable tasks. A worker is one Durable task with its
own conversation, model run and workspace; it is not a second agent loop, queue, retry framework or
service. The gateway's Harness schedules, aborts, resumes and records it exactly like any other task.

Opt-in:

```json
{ "workers": { "enabled": true } }
```

| Field | Meaning |
| --- | --- |
| `enabled` | Installs the model-facing `worker` tool and registers the `nanobot.worker-run` task kind. Default off. |
| `maxConcurrent` | Live workers per spawning conversation. Default 2, allowed 1–4. |
| `preset` | Optional named `modelPresets` entry for worker model/thinking. Absent uses the spawning conversation's current selection at launch. |
| `toolAllowlist` | Independent worker tool grants. Omitted inherits the configured chat capabilities; `[]` grants no tools. An explicit list replaces inheritance and can grant worker-only coding tools. |

`worker` is a context capability like `skill`, `cron`, `history` and `telegram`: it takes no path,
runs no shell and carries no filesystem authority, so it is outside the coding-tool ceiling. It is
offered only in an authenticated, scope-checked mapped chat conversation. The root, a channel-state
conversation, a fork, a raw conversation and any task-owned conversation (including a worker's own)
never receive it, so a worker cannot start another worker.

## Separate worker grants

```json
{
  "toolAllowlist": ["read"],
  "workers": {
    "enabled": true,
    "toolAllowlist": ["read", "write", "edit", "bash", "skill", "history", "web_search", "web_fetch", "codemode", "tool_search", "mcp"]
  }
}
```

This allows workers to write and run shell commands while the foreground remains read-only.
Native names are exact: `read`, `write`, `edit`, `bash`, `skill`, `history`, `web_search`,
`web_fetch`, `codemode` and `tool_search`. `mcp` expands to every currently connected MCP
registration; an exact `mcp__<server>__<tool>` registration name grants just that tool.
Expansion is captured as exact names at launch, not as a wildcard future grant.
Unknown names, duplicates and the forbidden `telegram`, `cron` and `worker` names are rejected.

A grant does not enable an integration: web, MCP and Code Mode still require their normal
configuration; skills require the workspace snapshot host. Unavailable tools are not captured.
A worker-only coding registration is never a foreground grant, including through stale state
or Code Mode. Cron and digestion retain their separate existing policies. Disabling workers
or removing a grant prunes live captures on reopen; re-enabling cannot add it back to an old task.

## The tool

`start` requires a bounded task description and an explicit `workspace_mode`:

- `shared` — the actual configured workspace, used in place. Concurrent workers, the foreground
  conversation and the owner see each other's writes; there is no automatic locking.
- `worktree` — a fresh `git worktree` of the configured repository at its current commit, on a
  generated branch `nanobot/worker-<taskId>`. Nothing is merged, rebased, stashed or removed.

`start` returns a task ID immediately; the parent keeps its turn. `list` shows this conversation's
workers, `inspect` returns one worker's bounded result and provenance, `transcript` reads that
worker's own committed conversation in bounded pages, `steer` sends one bounded direction to a live
worker, and `cancel` aborts one. An optional `request_id` makes `start` idempotent; a retried tool
call is deduplicated on Durable's own tool-task identity, never on the provider's tool-call ID (a
provider may reuse `call_0` across independent turns, and each of those starts a real worker). Live
workers are capped per conversation, and a refused start creates no record and no task.

The tool has no model-only `callers` restriction: native Code Mode (`codemode.enabled`) composes it
from a spawning chat like any other agent tool, under exactly the same hosting-conversation, capture
and ceiling checks. A script's nested `start` is its own Durable tool task, so it carries its own host
identity and the capture hook sees it exactly as a direct call.

A worker child also receives the native Code Mode/tool_search bundle, but composition grants nothing:
a child script resolves only the tools captured (and still configured) for that child: coding tools,
configured public web, configured MCP tools, read-only mapped-chat history and Code Mode/tool_search.
MCP registrations stay deferred until discovery; the other captured tools are declared normally.
It never receives `worker`, Telegram or cron, so it cannot delegate, schedule or message the user. Code Mode is not
recursive: `codemode`/`tool_search` are model-only tools, so a script cannot start another script.

Composition authority follows the capture exactly. A terminal or cancelled child loses the capture,
its tools and the compositor selection in the same commit; a removed-model child is denied before
scheduling resumes; and after a narrowed reopen a live child keeps the compositor while its script
can compose only what the current ceiling and capture still allow. A stale nested or prepared call
fails closed through the same call-time hook and native replay guards. Focused regressions drive a
real nested `read` composition plus a denied nested spawn inside a worker child, and check that the
narrowed reopen leaves nothing stale to compose.

## Reading a worker's transcript

`transcript` takes only a `worker_id` from this conversation's own records, plus optional `before`
and `limit`. It resolves the record through the existing record/spawner gate, then verifies the
native facts before reading any entry: the task must be this conversation's `nanobot.worker-run`
task, and the child conversation must be owned by that exact task ID (the task checkpoint and the
record must also agree while a checkpoint exists). A forged record, a child conversation owned by
anything else, another chat, the root, a fork, a raw conversation and a worker child itself all
resolve to "no such worker here". There is no arbitrary conversation-ID or task-ID parameter, and
this action adds no new conversation, history or scheduling authority.

Entries are read from the worker's own committed Durable conversation with the native entry page
API; nothing is captured, exported, copied into a second archive or read from Atuin. The action
works while the worker is live and after it is terminal, and it runs no model, changes no status,
record or cursor, and sends no notification. `inspect` remains the bounded result view; its
provenance line points at this action instead of the old, unsupported "inspect the transcript
there" hint.

One page is at most 20 entries (default 20) and 1,200 characters per entry, with a 48 KiB rendered
budget below the tool's 64 KiB output limiter. Text is control-sanitized and JSON-quoted, and a cut
body ends with `[truncated]`. The worker's task prompt renders as a user/task input entry, and
assistant text, tool calls and tool results are labeled with their entry kind as untrusted data, not
instructions. Image-only and binary entries are omitted with a count; no base64 payload is dumped.
Pages are strictly ordered and non-overlapping: the newest page needs no cursor, and each page
reports the `before` entry ID for the strictly older page, or says that no older entries remain.

## Steering a live worker

`steer` takes only a `worker_id` from this conversation's own records and one bounded `message` (at
most 2,000 characters; 8 accepted messages per worker). It accepts no conversation ID, task ID,
command or new task: a steer is direction for an existing worker from the spawning assistant, never
a user message and never a second worker. Terminal, completing, cancelled, foreign, root, forked,
raw and task-owned conversations are refused; a worker that is still preparing or has no live model
run is refused with a clear "not live" result rather than started implicitly.

The message is committed as an entry of kind `nanobot.worker-steer`, labeled `assistant (worker
steer)` in the shared transcript formatter, with the worker ID, the host tool-task ID and its source
in the entry data. Its model text says explicitly that it is internal direction from the spawning
assistant, not the user and not a new task. The worker still has only its captured tools; a steer
adds no tool, history, channel, scheduling or delegation authority, and the child cannot steer
anything.

Admission is one native commit, not a check followed by `Conversation.submit()`: that API commits
separately, so a terminal worker could win the race between the check and the submit. The steer
commit re-verifies the worker record, the `nanobot.worker-run` task and its spawner, the task-owned
child, and the child's live `pi.live.run` (which must own this worker's initial submission or an
already accepted steer); in that same commit it creates the native submission record and appends the
native `pi.inbox` steer item. This is the smallest platform facility with the required ordering:
no second queue, no custom boundary and no agent loop. Native boundaries place the item at the next
tool round, exactly as ordinary steering does; a steer never preempts a tool already claimed by the
run.

Completion is a joined boundary, not a second orphan task. After the initial turn answers, the
worker waits until its child is genuinely idle. If the final answer boundary placed an accepted
steer as the next run's first input, that run is part of the same worker: its tools stay captured,
its answer becomes the worker outcome, and a chain of accepted steers is joined the same way. On a
cancelled turn, and on a failed turn under the shipped default `afterFailedRun: "keep"`, every
accepted steer that is still queued is settled `unanswered` and removed from the inbox in the same
terminal commit, so it cannot start a run afterwards under retired tools. Consequently an accepted
steer is either delivered into the worker's own run chain or safely cancelled with a recorded
reason; a terminal worker refuses new steering instead of restarting, and the admission commit
cannot accept input after terminal/completing or after the child has gone idle. The Harness
`afterFailedRun: "continue"` override is not configured by this host and is not supported by the
join: it could start a successor run with a queued steer before the worker's failed terminal commit.

Dedupe uses the conversation-scoped request ID
`nanobot.worker-steer:<workerTaskId>:<hostToolTaskId>`: a replay of the same host tool task with the
same message returns the existing acceptance, while the provider's tool-call ID is not identity and
two independent tool tasks may reuse it. The record keeps only a SHA-256 digest of the steer text
for that comparison, never the text itself; the same identity with a different message is refused
with a fixed value-free reason instead of silently dropping the new direction. The accepted count is
kept in the worker record, shown by `inspect`, and stated in the internal result event; the worker's
own transcript keeps the authoritative steer entries. Steering adds no config and no timeout: it
never extends a job deadline (there is none) and it cannot revive a worker that has already finished.

## What a worker is

The worker task's first phase creates a task-owned conversation, configures it with its configured
worker grants (independent when explicit) plus the model chosen at launch, submits
one bounded task prompt and waits for that turn's committed answer. Accepted steering is joined into
that same task outcome as described above. The child inherits:

- the config ceiling captured at launch, re-intersected with the current config and the origin's
  current authorization on every reopen; a removed tool never returns;
- the current workspace snapshot path (bootstrap/AGENTS, memory manifest, skill summary, on-demand
  `skill` tool) only when the host configured a snapshot provider and the spawner is mapped;
- the configured vision handoff, so a flagged text-only worker model never receives raw images;
- configured public web search/fetch, configured MCP, Code Mode/tool_search and read-only history
  over the same validated mapped chats the parent can retrieve;
- no `worker`, `cron` or Telegram tool. Digest and scheduled-run automation targets do not inherit these grants.

Research capabilities are stored by exact tool name in the existing durable capture. A worker-specific
call-time hook checks the live child and its authorized origin; reopen intersects and persists the
capture against current config. Disabled and later re-enabled tools cannot return to an old capture.
MCP connections remain gateway-owned: a stdio server uses its configured host cwd, not the child's
worktree or shell sandbox, and may have write authority. A worker worktree does not isolate MCP.

The model is the spawning conversation's actual selection (provider/model and thinking level) at
launch, or the configured `workers.preset`. On reopen the worker keeps that model. If the model left
the configured catalog, nothing is silently substituted:

- before scheduling resumes, the target's capture is retired, its coding tools are stripped, its
  queued inputs are withdrawn and its live tasks that hold no saved provider dispatch are aborted (all
  scoped to that worker's own conversation);
- the worker task then commits a terminal error that retires its authority in the same commit, so no
  fallback-model turn and no late child work runs under a captured tool;
- if a *saved* provider dispatch names the removed model, the inherited prepared-request guard refuses
  to open the gateway at all (operator recovery or explicit cancellation), rather than silently
  cancelling that dispatch to "repair" startup. That inherited refusal, not a silently repaired open,
  is the documented behavior of that case.

## Workspace mode

`shared` is the configured workspace itself. Its documented interference: concurrent writers race in
one tree, exactly as two terminals would.

`worktree` needs the configured workspace to be the root of a git work tree with a clean tracked
state. It fails truthfully, without copying, stashing or committing anything, when:

- the workspace is not a git work tree;
- the workspace is a subdirectory of a repository (a checkout would expose sibling paths the
  configured workspace never authorized);
- tracked files are modified or staged (the checkout would silently be a different revision);
- an existing checkout for that task is missing, belongs to another branch/repository, or sits at a
  different commit.

Ignored and untracked files are not part of the commit and are not copied. The checkout lives under
`<dataDir>/worker-worktrees/worker-<taskId>`: it is outside the configured workspace, so the owner's
checkout is never the parent of a tool root, and only that leaf directory becomes the worker's tool
root and shell cwd. The store file is not inside any worker root, and the worker gets no
`extraAllowedDirs`. `git worktree add` necessarily writes administrative metadata under the owner's
repository `.git/worktrees` and creates the task branch; it stages nothing in the working tree.

Provenance (mode, path, branch, base commit) is committed with the prepared target, so it is
inspectable while the worker is still running. The worktree and branch are the task's artifacts:
cancellation or failure deletes nothing, and the spawning agent decides what to review or integrate.

The worker task prompt tells the child that if Git refuses to create a commit because no author
identity is configured, it must not invent a name or email and must not write Git configuration
(global or repository); it reports the missing identity as a blocker instead. The host never sets an
author identity, inspects the owner's Git configuration or changes it for the worker.

## Authority

The child conversation starts default-deny. In the same commit that prepares it, the host records the
spawning conversation as its capture origin and records the expanded worker grants. Call-time hooks
require a currently authorized mapped origin and the worker-specific ceiling, not the foreground
coding ceiling. Foreground calls still use only the foreground ceiling; cron and digest captures do
not gain worker-only grants. The capture can narrow its configured authority, never enlarge it.

The terminal commit records the outcome, retires the capture document and strips the target's tools.
Before scheduling resumes after a reopen, every live worker target's capture is intersected with the
current ceiling and origin; a finished or cancelled worker keeps nothing, and a conversation that is
not owned by a live worker task is not treated as a worker target.

## The result event

Completion, failure and cancellation each produce exactly one internal result event in the spawning
conversation. It is a normal admitted input, queued behind whatever the parent is doing, so the parent
resumes at a native busy boundary rather than being steered into an unfinished tool call. The event is
formatted deterministically (no summarizer model call), labeled as internal, and states that the
worker output is untrusted data rather than user instructions. When steering was accepted, it reports
how many messages were part of the live worker and whether any had to be cancelled at completion.
Its admission uses the conversation-scoped request ID `nanobot.worker-result:<taskId>`, and a reopen
re-attempts any admission a crash interrupted: a retry cannot duplicate the parent turn. The
admission and the record's ownership of it (the native submission ID) are one commit, so no Stop or
crash can land between them, and a commit that fails rolls the admission back with it. Durable
dedupes by request ID alone, so the record is marked notified only when the submission under that
ID has placed this worker's own `nanobot.worker-result` entry in the spawning conversation — never
while it is merely queued in the inbox, because a Stop can still withdraw a queued input. A
confirmed withdrawal moves to the next attempt's request ID and is redelivered once. A foreign
input holding the same request ID is not proof: the record stays unnotified, is never evicted, and
each reopen retries without admitting a duplicate.

Records written before this rule could mark `notified` while the event was still only queued (or
settled before ownership was ever recorded). Such legacy rows are reconciled before anything is
admitted or evicted for them: one whose submission is still queued with this worker's entry is
downgraded to pending and delivered by the normal path; one whose entry is placed is confirmed; one
that settled without a placed entry and without recorded ownership is an unknown outcome — it is
kept forever (`resultHeld` on the record), reported as neither delivered nor failed, never pruned
and never resubmitted under that request ID. Inspect held rows manually.

Nothing here writes a channel outbox or sends user-facing text. The worker never messages the user.
The spawning agent decides what, if anything, to relay.

- **Telegram**: no delivery is attributed to the worker event. The Telegram adapter only sends the
  answer to an inbound update it admitted, so a worker-completion turn is never sent to the chat.
- **Local terminal**: an attached CLI renders a run it did not admit (for example a scheduled
  origin-mode cron turn) as an external run, so it prints the *parent's own* answer after the internal
  event. That is the spawning agent's turn, not worker output, and it appears only on that local
  terminal.

## Durability and failure

Worker records are bounded metadata (`nanobot.worker-records`) in the spawning conversation; the
Durable task record and the worker's own transcript remain authoritative. Records retain the request
ID, mode, workspace provenance, bounded result and bounded reason. Pruning only ever removes a
terminal worker whose internal event was already admitted, so an outstanding result is never evicted;
when nothing is evictable, `start` refuses instead of dropping history.

A worker is `background`, so it is outside the spawning conversation's idle wait, abort cascade and
ownership scope: an ordinary chat abort does not cancel it, and `waitForIdle` does not wait for it.
`cancel` marks the task, its abort phase commits a terminal aborted outcome, retires the target's
authority, withdraws accepted steering that was still queued, and admits the cancellation event; a
late child completion cannot turn it into a success. Missing or changed worktrees are reported, never
silently replaced, and a completed model turn is never re-run.

## Limits

- This worker slice adds no memory curation, consolidation prompt, processed-history bookkeeping or
  "Dream" engine, and nothing here schedules or activates it. That work was implemented later as a
  separate bounded slice (see [memory digestion](./HISTORY.md#memory-digestion-execution)): only an
  explicit `/digest` or an ordinary cron job with `intent: "digest"` starts a run, and workers
  neither trigger nor schedule it.
- No automatic merge, cleanup, stash, rebase or commit of the owner's state, and no worktree deletion.
  A `git worktree add` that fails after creating the branch or an empty directory can leave those
  behind; they are bounded and non-destructive, so this slice documents them instead of adding a
  cleanup framework. A persisted `shared` task whose recorded path is no longer the configured
  workspace root fails truthfully rather than reusing the stale path.
- `transcript` is a read-only view of one paginated window, not a live stream, an export or a complete
  archive. Very old pages remain reachable by paging, but the view is bounded at each call and may
  lag entries that are not committed yet.
- Steering admission mirrors Durable's own busy/`whenBusy: "steer"` branch over the public
  submission and `pi.inbox` primitives, because `Conversation.submit()` would commit separately and
  lose the terminal-race ordering. It deliberately emits no submission trace link to the live run
  (telemetry only, no model or tool authority). If a future Durable admission API accepts a
  liveness condition in the caller's commit, it should replace this narrow mirror.
- The steering join supports the shipped default `afterFailedRun: "keep"`. The Harness
  `afterFailedRun: "continue"` override is not configurable here and is not exercised: it could place
  an accepted steer into a successor run before a failed worker reaches its terminal commit, which
  this worker would not join. No shipped gateway opens with that override.
- No live-model, Telegram or deployment run is claimed: the offline checks use a faux provider and
  temporary git fixtures.
