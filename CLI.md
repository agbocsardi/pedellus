# Interactive CLI

For a first-time walkthrough of workspace, memory, skills and config-enabled
tools, start with [setup](./SETUP.md).

Run the configured local conversation with the existing explicit config path:

```sh
nanobot --config /path/to/config.json
```

When Telegram is configured, the CLI keeps the existing Telegram path; otherwise
it opens the local `cli:default` Durable conversation. Workspace context is off
unless the config contains `workspaceContext`; when enabled it applies the same
fixed bootstrap and explicit `memoryFiles` selection to every session key and
adds no identity. Adding `workspaceContext.memoryManifest: true` also appends the
bounded topic manifest for on-demand native reads. See [workspace context](./WORKSPACE_CONTEXT.md). Model text
streams only from committed `pi.live` snapshots, filtered to assistant text
blocks. The
initial watch snapshot is not replayed. After a submission settles, the CLI
reads its committed assistant entry and flushes any text missing from the last
committed partial. Reasoning blocks, system entries, tool calls/arguments, and
tool output are not printed. ESC/C1 terminal controls, carriage returns, and bidi
formatting controls are removed; ordinary newlines and Unicode scalar values are preserved.

## Startup diagnostics

The CLI fails closed with exit status 1. Known configuration and startup failures
print one fixed, value-free message: unreadable/invalid configuration, invalid
configuration fields, unsupported provider aliases, unavailable models or
thinking levels, missing credential alias references, a missing Telegram token
environment variable, workspace/data-directory preparation failures, a data
store already owned by another live process, and a prepared model dispatch that
pins historical Nanobot context. These messages never include configuration
values, environment values, filesystem paths, provider/dependency error text or
the underlying exception. Unexpected failures keep the generic
`nanobot: command failed; diagnostic details suppressed` message.

For live-owner lock contention, the fixed message says to stop the other running
nanobot/gateway process. For a blocked prepared dispatch, it says to run
`nanobot recovery --config <path>` with the same configuration to inspect and
cancel the blocked task, then start again. The CLI does not cancel the task or
rewrite its checkpoint automatically.

Recovery operation errors keep their dedicated `nanobot recovery:` text and
remain governed by recovery's existing disclosure contract, not this startup
policy. This section does not broaden or change that behavior. Configuration
loading for a recovery invocation still uses the fixed startup messages above.

## Scheduled results

An `origin`-mode cron job submits its turn into the same `cli:default`
conversation. When an attached CLI observes a run whose inputs were not admitted
by this terminal process, it prints that run's committed final assistant text
once when the run ends. This includes queued turns that hand over directly to
the next run without an idle frame: each observed run is attributed by its own
inputs and generation task, so
an earlier answer is not replaced by a later one.

The CLI does not stream an external run's partial text, and it does not replay an
already-settled answer at startup; a run already active at attachment may also
be missed if no live update is observed. `/history` shows settled entries. A run that
ends with a model error, an abort, a tool-call answer (even with narration), no text, or no attributable
assistant entry produces a local notice instead of guessed text. The terminal
does not retry or reorder queued turns; Durable's normal failed-run policy still
governs whether a later queued turn runs after a failure. This is
presentation of one Durable conversation, not a delivery outbox or an exactly-once
external send. A default isolated/background cron run uses its own task-owned
conversation and is not shown in the CLI. Normal settlements in either mode (an
answer, or a fixed sanitized failure/empty-answer notice) can be delivered to a
Telegram origin through its outbox; cancelled and superseded runs are not. See
[cron](./CRON.md).

## Recovery

Startup fails closed when a prepared model dispatch still pins historical Nanobot
context, with a fixed value-free message naming the recovery command below. The
same executable exposes an owner-only recovery path that never opens
the gateway, resumes scheduling, or requires credentials. It does require the
existing SQLite database and the gateway process to be stopped; a live owner is
reported as a lock conflict. Inspection may perform Durable's native
`Harness.open()` crash reconciliation but never resumes task execution:

```sh
node dist/cli.js recovery --config /path/to/config.json
node dist/cli.js recovery --config /path/to/config.json --cancel <taskId> --fingerprint <sha256>
```

Inspection prints JSON with task ID, kind, phase, pinned entry, and fingerprint.
Cancellation requires the exact fingerprint, durably marks only that native task
for abort, and preserves the transcript. The result reports `abort-marked`,
`terminal`, or `orphaned` from a fresh task read. Reopen the gateway to run the
abort protocol; a cancelled poll whose model is outside `allowedModels` remains
fail-closed and is not remotely cancelled. See
[prepared context recovery](./CONTEXT_RECOVERY.md).

## Local controls

| Command | Behavior |
|---|---|
| `/help` | Show this CLI's local controls. |
| `/status` | Show the conversation's current host-selected model, native run/inbox state, and Durable-recorded per-model/tool usage. Provider-side charges or unrecorded spend remain unknown. |
| `/history [count]` | Show the latest user/assistant text messages only (default 10, max 50), using Durable entry pagination; each snippet is limited to 200 characters and the scan to 2,000 entries. Reasoning, tool, and non-text blocks are omitted; synthetic user-role reset or compaction messages may also appear. |
| `/search [--scope messages\|tools\|all] [--role user\|assistant] [--limit 1-50] [--next] [--] [query]` | Search or browse the local history index. Default scope is messages; `--scope tools` searches tool names, arguments and result text only, and `--scope all` combines messages and tools. Empty text browses the selected scope. See [history search and browsing](#history-search-and-browsing). |
| `/episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>]` | List reset-delimited episodes newest first, with entry ranges, counts and recorded summary status only. `--session` must name an existing mapped chat session; the default is `cli:default`. This command does not generate or show summary text. |
| `/episode [--session <sessionKey>] <startEntryId> [--limit 1-30]` | Open one episode's bounded first window of message/tool entries from an existing mapped chat session. |
| `/entry [--session <sessionKey>] <entryId> [--radius 0-5]` | Open one entry plus at most five neighboring entry IDs on each side, showing only user/assistant text and tool calls/results. `--session` must be an existing mapped chat session. |
| `/model` | List named presets and the current/default choice. `/model <name>` temporarily selects one; `/model default` or restart returns to the configured preset. Direct-model configs retain `/model <provider> <modelId> [thinkingLevel]` and persisted selection. Busy selection is rejected atomically; retry when idle. Standalone terminal callers without a host callback remain read-only. |
| `/tools` | Read-only diagnostic of the config-selected coding tools for this conversation. |
| `/refresh` | Re-read the configured workspace bootstrap, memory files, manifest and skill inventory for this `cli:default` conversation. Requires `workspaceContext`; rejected while the conversation is busy. The refreshed summary and skill table apply to the next model request. |
| `/compact` | Admit native Durable manual compaction. Summarization is asynchronous; summary placement follows native inbox boundaries and original entries remain stored. |
| `/abort` | Use native `Conversation.abort()`: stop foreground conversation work, withdraw queued inputs, and wait for native idleness. It does not implement Python sustained-goal/background abort semantics. |
| `/new` | Admit native `Conversation.reset(undefined)`: the same conversation starts a new context with no handoff. No archive, summary, usage reset or extra model call is produced; earlier entries stay stored and remain visible to `/history`, and configured tools are unchanged. While busy it is placed at the next safe boundary and ends that run there instead of interrupting the current model turn; inputs queued before or after it in the same busy window run in the new context. A queued `/new` is a write, so `/abort` withdraws queued inputs but not the pending reset. |

Equivalent presets can both show as selected because the marker matches the actual
provider/model/thinking settings, not a separately stored preset identity. A legacy
pair selection may match no preset. See [model selection](./MODELS.md).

## History search and browsing

These are local, host-bound, read-only controls over the mapped chat sessions
of this single-tenant store. Browse commands default to `cli:default`; search
spans the mapped sessions. They are not model-facing tools and have no Telegram
equivalent.
Search uses `Gateway.historySearch`; episode listing/open uses
`Gateway.listHistoryEpisodes` and `Gateway.historyEpisode`; `/entry` and the
episode-entry window use `Gateway.historyEntries`, a bounded raw-entry page over
an existing mapped chat session. No control writes a transcript, changes tool
authority,
or starts a model turn.

```text
/search [--scope messages|tools|all] [--role user|assistant] [--limit 1-50] [--next] [--] [query]
/episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>]
/episode [--session <sessionKey>] <startEntryId> [--limit 1-30]
/entry [--session <sessionKey>] <entryId> [--radius 0-5]
```

- `/search` defaults to `messages` and both roles; `--role` narrows messages.
  `--scope tools` searches tool names, arguments and result text only and rejects
  `--role`; `--scope all` combines messages and tools, with `--role` filtering
  messages only. Omitting the query browses the selected scope. Options must come
  before the query; `--` ends options, so `/search -- --tools` searches for the
  literal text `--tools`; `--` must be followed by query text, and duplicate
  options are rejected. The default page size is 10 and the maximum is 50; query
  text is capped at 500 characters (the index limit).
- Matching is the index's token/prefix matching, not substring matching. Terms are
  ANDed and the last term is a prefix; punctuation-only text has no terms. Hits are
  newest first. A long record can produce more than one hit (one per overlapping
  chunk), and each excerpt is a quoted chunk fragment, not a whole message.
- `/search --next` continues the last successful search with the same query,
  scope, roles and limit. The continuation is rejected if the query, derived
  index, store identity, session mapping or boundary entry changed. Entries
  appended after the first page require a fresh search. Cursors are held in this
  terminal process only and are never printed; restart the search after a
  reconnect or a mapping change. Without a held cursor, `/search --next` reports
  that no continuation exists.
- Each hit shows the role, entry ID, session key, conversation ID, episode start
  entry, entry kind, timestamp and tool/call identity when present, plus a
  sanitized excerpt. Terminal escape/C1 controls, carriage returns and bidi
  controls are removed, and labels collapse whitespace so a stored name cannot
  forge an extra output line; excerpts are untrusted quoted text. Display labels
  are never used as identifiers. Every hit prints an actionable
  `/entry --session <key> <entryId>` and
  `/episode --session <key> <episodeStartEntryId>` hint only when the exact session
  key round-trips through `--session`: non-empty, at most 200 code units, no
  whitespace, no C0/C1 or bidi controls (including LRM/RLM/ALM), and no unpaired
  surrogates. Otherwise the hint is suppressed and says why.
- Coverage is always reported. `Index: complete` describes the captured store
  boundary; a later entry still needs a fresh search. `Index: INCOMPLETE` lists
  the reason (reconciliation bound, pending lag, omitted long text, unsupported
  context edits or malformed records). Malformed counts force `INCOMPLETE` even if
  the index API reports `complete`. An incomplete no-hit answer does not prove
  absence. Large backlogs are caught up across calls, not inside one unbounded
  scan.
- `/episodes` lists only non-empty reset-delimited episodes and reports the
  recorded summary status (`pending`, `open`, `unknown`, ...), never summary text.
  No summary task is started. `/episode` shows at most 30 displayable entries from
  the first 300 scanned entries and reports the bound instead of claiming a full
  episode view.
- `/entry` reads at most 11 entry IDs. System, reset, compaction and thinking
  content is never shown; user, assistant and tool-result text is sanitized and
  each entry is limited to 2,000 characters, with tool-call arguments limited to
  400. Entries carrying unsupported context edits are shown as raw stored text
  with that fact noted. `/history` is unchanged and still scans only the latest
  user/assistant text messages.
- `/episodes`, `/episode` and `/entry` default to `cli:default` with a history
  host. `--session` must name an existing mapped chat session and must be exactly
  representable as one CLI token under the same round-trip rule above; labels with
  whitespace, controls, bidi marks, unpaired surrogates or more than 200 code units
  cannot be used. The host resolves the existing mapping without creating a
  conversation, and state-only, task-owned or forked conversations are rejected. A
  search hit prints the exact session key to use. Standalone terminal callers
  without a history host can still use `/entry` for their own default conversation;
  `--session`, `/episodes` and `/episode` require the host.
- Required metadata (search coverage, continuation, episode bounds and the
  hidden-content footer) is printed before bounded hit/entry rows. Rows that do
  not fit the 48,000-code-unit history view bound are omitted with an explicit
  count; metadata is never silently dropped in favor of rows.
- Search and browse commands are serialized with other local controls, so they
  observe earlier admissions without waiting for model completion. They can run
  while a turn is active; they do not queue, retry or alter that turn. SIGINT,
  SIGTERM or an output failure cancels the pending read where the host API
  supports cancellation. A failed or rejected read never falls back to a raw
  exception message or a model prompt.

There is no claim of complete archival coverage: only mapped chat sessions are in
scope, the derived index is rebuildable and disposable, and tool output remains
untrusted data rather than instructions. Opening a full episode or arbitrary
surrounding transcript beyond these bounds is not implemented.

## Coding tools

`toolAllowlist` in the config is the tool authority. A non-empty list enables
exactly those native `read`/`write`/`edit`/`bash` tools for authenticated mapped
ordinary chats; `[]` or absent disables them. No grant step, expiry or per-chat
approval is involved, and `/tools` is only a read-only diagnostic:

```text
/tools
```

Restart after editing `toolAllowlist`; there is no hot reload. Narrowing the list
limits later requests and pending calls fail closed rather than being restored by
old records. `/grant` and `/revoke` are not commands: they take the ordinary
unknown-slash-command path and are never sent to the model.

See [coding tools](./TOOLS.md).

## Workspace refresh

When the config contains `workspaceContext`, `/refresh` re-captures the current
`cli:default` conversation's host snapshot without reopening the Gateway:

```text
/refresh
```

- It uses the same provider and loader as conversation creation and reopen, so
  bootstrap files, selected memory, the optional memory manifest and workspace
  or builtin skills are re-read together. Disabled names and `requires` gates
  are re-evaluated.
- The refreshed skill summary and the read-only `skill` table replace the
  captured ones for the next model request. Skill bodies remain on demand and
  never enter the prompt.
- It is rejected while the conversation is busy; retry when idle. A provider or
  loader failure leaves the previous snapshot in effect. `/refresh` adds no
  tool authority, workspace root or shell authority.
- Without `workspaceContext`, or for standalone terminal callers without the
  host callback, `/refresh` reports that workspace context is unavailable.

This is the supported way to make a skill created or edited during the current
conversation usable without starting another conversation. Scheduled background
runs have no session key and are not refreshed; they pick up the snapshot on
their next run or Gateway reopen.

`/stop` is deliberately not an alias for `/abort`: native abort withdraws queued
inputs, while Python stop preserves queued work. `/restart`, `/goal`,
`/interrupt`, `/btw`, task/policy/receipt/skill, memory/Dream and pairing
commands are not implemented here. `/steer` and `/after` were removed; normal
input is admitted by the native conversation in input order. Unsupported slash
commands are reported locally and are never silently sent as model prompts.
Prefix a prompt with `//` to send one literal leading slash (for example,
`//help` sends `/help` to the model).

Normal input is admitted in input order by the native conversation. Controls
are ordered between those admissions: a control observes all earlier durable
submissions, and later inputs cannot overtake a mutating control such as
`/abort`. This boundary waits for submission admission and the control
operation, never for model completion (except native `/abort` itself).
Durable owns the busy inbox; this CLI does not create a second agent queue. At
most 64 locally admitted inputs may remain unsettled, and at most 16 local
control operations may be pending. Only completed lines up to 32,000 UTF-16
code units are admitted, and displayed response text is capped at 64,000
UTF-16 code units without splitting a Unicode scalar. This is an admitted-line
limit, not a hard ingress-memory cap: Node `readline` buffers until newline
before yielding a line to the check, so a very long or newline-free stdin record
can consume memory first. Injected `TerminalIO` sources likewise own any
pre-yield memory bound. Writable backpressure is awaited; rejected-line
notices are also awaited rather than queued. EOF waits for this process's admitted inputs to settle before gateway
shutdown; if a failed/ended run leaves inputs queued under Durable's default
`afterFailedRun: "keep"`, EOF reports that state and cancels only local
watch/wait contexts. The durable submissions remain queued for owner
reconciliation or reopen; only explicit `/abort` withdraws them. SIGINT and
SIGTERM cancel local waits and watches, close input, and let the gateway
close/reap its Harness.

This remains a text-only local surface, not a complete Python command port or
interactive terminal UI. Model selection delegates to Gateway's allowlist and
persists in native Durable `pi.agent`; it adds no agent runner, queue, session
store, or parallel model state. Scheduled origin-mode answers are rendered from
the same conversation's committed entries; the terminal adds no delivery queue.
