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

`worker` is a context capability like `skill`, `cron`, `history` and `telegram`: it takes no path,
runs no shell and carries no filesystem authority, so it is outside the coding-tool ceiling. It is
offered only in an authenticated, scope-checked mapped chat conversation. The root, a channel-state
conversation, a fork, a raw conversation and any task-owned conversation (including a worker's own)
never receive it, so a worker cannot start another worker.

## The tool

`start` requires a bounded task description and an explicit `workspace_mode`:

- `shared` — the actual configured workspace, used in place. Concurrent workers, the foreground
  conversation and the owner see each other's writes; there is no automatic locking.
- `worktree` — a fresh `git worktree` of the configured repository at its current commit, on a
  generated branch `nanobot/worker-<taskId>`. Nothing is merged, rebased, stashed or removed.

`start` returns a task ID immediately; the parent keeps its turn. `list` shows this conversation's
workers, `inspect` returns one worker's bounded result and provenance, `cancel` aborts one. An
optional `request_id` makes `start` idempotent; a retried tool call is deduplicated on Durable's own
tool-task identity, never on the provider's tool-call ID (a provider may reuse `call_0` across
independent turns, and each of those starts a real worker). Live workers are capped per conversation,
and a refused start creates no record and no task.

The tool has no model-only `callers` restriction: native Code Mode may compose it like any other tool,
under exactly the same hosting-conversation, capture and ceiling checks, and a worker's child still
receives no `worker` tool. The shipped host does not install Code Mode today; when the generalized
Code Mode slice lands, its integration test should drive a nested `worker start` through a script and
assert the same `spawnerFor`/capture denial outside a mapped spawning chat.

## What a worker is

The worker task's first phase creates a task-owned conversation, configures it with a captured subset
of the spawning conversation's currently configured tools plus the model chosen at launch, submits
one bounded task prompt and waits for that turn's committed answer. The child inherits:

- the config ceiling captured at launch, re-intersected with the current config and the origin's
  current authorization on every reopen; a removed tool never returns;
- the current workspace snapshot path (bootstrap/AGENTS, memory manifest, skill summary, on-demand
  `skill` tool) only when the host configured a snapshot provider and the spawner is mapped;
- the configured vision handoff, so a flagged text-only worker model never receives raw images;
- no `worker`, `cron`, `history` or channel tool, and no mapped-conversation history.

Research workers therefore use the tools actually configured for that conversation. This slice adds
no web search or fetch reach; a research worker without such a configured tool has none.

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

## Authority

The child conversation starts default-deny. In the same commit that prepares it, the host records the
spawning conversation as its capture origin and copies the configured tool names; the existing
call-time hook still requires that origin to be a currently authorized mapped chat and every name to
be inside the current config ceiling. A capture is a subset of configured authority, never a grant.

The terminal commit records the outcome, retires the capture document and strips the target's tools.
Before scheduling resumes after a reopen, every live worker target's capture is intersected with the
current ceiling and origin; a finished or cancelled worker keeps nothing, and a conversation that is
not owned by a live worker task is not treated as a worker target.

## The result event

Completion, failure and cancellation each produce exactly one internal result event in the spawning
conversation. It is a normal admitted input, queued behind whatever the parent is doing, so the parent
resumes at a native busy boundary rather than being steered into an unfinished tool call. The event is
formatted deterministically (no summarizer model call), labeled as internal, and states that the
worker output is untrusted data rather than user instructions. Its admission uses the conversation-
scoped request ID `nanobot.worker-result:<taskId>`, and a reopen re-attempts any admission a crash
interrupted: a retry cannot duplicate the parent turn.

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
authority and admits the cancellation event; a late child completion cannot turn it into a success.
Missing or changed worktrees are reported, never silently replaced, and a completed model turn is
never re-run.

## Limits

- This slice adds no memory curation, consolidation prompt, processed-history bookkeeping or
  "Dream" engine, and nothing here schedules or activates it. The owner deferred that work until
  workers are accepted. The latest planning keeps it simple — an editable agent-owned workspace
  prompt plus a simple digestion cursor over unprocessed conversations/episodes, with no
  hash/version machinery — and supersedes the earlier, more elaborate notes. It is not implemented
  or promised by this slice.
- No automatic merge, cleanup, stash, rebase or commit of the owner's state, and no worktree deletion.
  A `git worktree add` that fails after creating the branch or an empty directory can leave those
  behind; they are bounded and non-destructive, so this slice documents them instead of adding a
  cleanup framework. A persisted `shared` task whose recorded path is no longer the configured
  workspace root fails truthfully rather than reusing the stale path.
- No live-model, Telegram or deployment run is claimed: the offline checks use a faux provider and
  temporary git fixtures.
