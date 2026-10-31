# Interactive CLI

For a first-time walkthrough of workspace, memory, skills and config-enabled
tools, start with [setup](./SETUP.md).

The gateway is the single agent/Durable owner. A CLI is one conversation
surface over it, like Telegram and future channels, not a runtime:

```sh
nanobot gateway --config /path/to/config.json   # one owner: storage, tools, cron, Telegram
nanobot agent --config /path/to/config.json     # attach a terminal to that gateway
```

`nanobot --config /path/to/config.json` remains the historical terminal command.
It now attaches exactly like `agent` and never opens an implicit gateway or a
second runtime; start `gateway` with the same configuration first. Both commands
take the existing explicit config path. `agent --conversation <name>` attaches a
separate `cli:<name>` conversation; omitted or `default` resumes the historical
`cli:default`.

Workspace context, Markdown memory and the configured tool ceiling belong to the
gateway, so every attached surface sees the same workspace and policy. Each
conversation stays separate by default. Attaching resumes the conversation's
Durable transcript, model selection and queued work; it does not create a new
agent loop. Model text streams only from committed `pi.live` snapshots, filtered
to assistant text blocks. The initial watch snapshot is not replayed. After a
submission settles, the CLI reads its committed assistant entry and flushes any
text missing from the last committed partial. Reasoning blocks, system entries,
tool calls/arguments, and tool output are not printed. ESC/C1 terminal controls,
carriage returns, and bidi formatting controls are removed; ordinary newlines and
Unicode scalar values are preserved. See [workspace context](./WORKSPACE_CONTEXT.md).

## Gateway and local transport

The gateway serves one private Unix socket inside the configured `dataDir`
(`gateway.sock`, created mode `0600`; the data directory is already `0700`).
There is no public or TCP listener and no general RPC surface. The CLI speaks a
bounded newline-delimited JSON protocol over that socket:

- A connection attaches to exactly one `cli:<name>` conversation. Names are
  validated (lowercase letters, digits, `_`, `-`; at most 32 characters); channel
  keys such as `telegram:<id>`, the root/state/fork conversations and arbitrary
  harness IDs are not attachable.
- Requests are validated and bounded. Request lines are capped at 256 KiB,
  admitted prompts at 32,000 code units, attachment paths at 4,096 code units,
  entry pages at 200 rows and history pages at 50 hits; unknown methods, unknown
  fields and out-of-range values are rejected. Rejections carry a fixed code and
  no dependency, path or credential text. Command and admission serialization
  stays in the terminal, not in a new gateway queue.
- A local attachment is one request carrying the operator's path and optional
  prompt. The gateway reads, bounds and stores the file; the CLI never opens the
  media directory, reads the file or learns its bytes. See
  [local attachments](#local-attachments).
- Snapshot delivery is bounded: the CLI keeps at most 64 pending frames
  (dropping the oldest) and awaits each render in order, while the gateway
  disconnects a socket that queues more than 8 MiB. A disconnected or stalled
  client never grows unbounded buffers.
- Exactly one gateway serves the configured store. The Durable store lock is the
  owner; a stale socket file is removed only after a connection attempt fails, and
  a live listener is refused rather than replaced. Binding failures, including a
  second gateway on the same endpoint, are reported with fixed, value-free text.
  The socket is removed on normal shutdown.
- Closing the CLI closes this attachment and its watch. Already admitted durable
  turns keep running in the gateway, queued inputs stay queued, and the same
  conversation is resumed on the next attach. The CLI never aborts work merely
  because its terminal exited; explicit `/abort` remains the way to withdraw it.

Telegram runs inside the same gateway process, so a local CLI and Telegram can be
used at the same time. Disconnecting the CLI does not stop Telegram polling, and
vice versa; stopping the gateway stops both.

## Startup diagnostics

Gateway startup fails closed with exit status 1. Known configuration and startup
failures print one fixed, value-free message: unreadable/invalid configuration,
invalid configuration fields, unsupported provider aliases, unavailable models
or thinking levels, missing credential alias references, a missing Telegram token
environment variable, workspace/data-directory preparation failures, a data
store already owned by another live process, and a prepared model dispatch that
pins historical Nanobot context. These messages never include configuration
values, environment values, filesystem paths, provider/dependency error text or
the underlying exception. Unexpected failures keep the generic
`nanobot: command failed; diagnostic details suppressed` message.

An `agent` (or legacy default) launch additionally fails closed when no gateway
answers on the configured endpoint, or when the endpoint's socket path cannot be
used. Its fixed message says to start `nanobot gateway --config <path>` with the
same configuration. The CLI does not fall back to opening a store or starting a
second runtime.

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

An `origin`-mode cron job submits its turn into the same CLI conversation that
owns the job (normally `cli:default`). When an attached CLI observes a run whose inputs were not admitted
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

Gateway startup fails closed when a prepared model dispatch still pins historical
Nanobot context, with a fixed value-free message naming the recovery command
below. The same executable exposes an owner-only recovery path that never opens
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
| `/episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>]` | List reset-delimited episodes newest first, with entry ranges, counts and recorded summary status only. `--session` must name an existing mapped chat session; the default is this attachment's session key (normally `cli:default`). This command does not generate or show summary text. |
| `/episode [--session <sessionKey>] <startEntryId> [--limit 1-30]` | Open one episode's bounded first window of message/tool entries from an existing mapped chat session. |
| `/entry [--session <sessionKey>] <entryId> [--radius 0-5]` | Open one entry plus at most five neighboring entry IDs on each side, showing only user/assistant text and tool calls/results. `--session` must be an existing mapped chat session. |
| `/model` | List named presets and the current/default choice. `/model <name>` temporarily selects one; `/model default` returns to the configured preset. A CLI reattach keeps the temporary selection; a gateway restart also returns to the configured preset. Direct-model configs retain `/model <provider> <modelId> [thinkingLevel]` and persisted selection. Busy selection is rejected atomically; retry when idle. In-process/SDK terminal callers without a host callback remain read-only. |
| `/tools` | Read-only diagnostic of the config-selected coding tools for this conversation. |
| `/refresh` | Re-read the configured workspace bootstrap, memory files, manifest and skill inventory for this attached CLI conversation. Requires `workspaceContext`; rejected while the conversation is busy. The refreshed summary and skill table apply to the next model request. |
| `/digest` | Start one bounded closed-episode memory-digestion run for this attached conversation and print only the fixed bounded admission: started, busy, idle or refused. The batch may come from any mapped chat because workspace memory is shared. It returns immediately; the run is a background native task, holds no terminal turn, creates no schedule and calls no model from the command. An `idle` answer that did not reach every mapped chat's tail says closed history may remain and a later invocation continues the bounded scan; it never loops to exhaustion. |
| `/digest status` | Bounded read-only view of the live digestion run and this conversation's newest run: task IDs, outcome, batch position, evidence count and a bounded recorded error. It performs no transcript scan, model call or cursor change. |
| `/attach <path>[ -- <prompt>]` | Store one operator-named local file through the gateway under the configured workspace media directory and submit it as an ordinary turn, optionally with prompt text after the first ` -- ` (paths may contain spaces). Requires top-level `media` config; see [local attachments](#local-attachments). |
| `/compact` | Admit native Durable manual compaction. Summarization is asynchronous; summary placement follows native inbox boundaries and original entries remain stored. |
| `/abort` | Use native `Conversation.abort()`: stop foreground conversation work, withdraw queued inputs, and wait for native idleness. It does not implement Python sustained-goal/background abort semantics. |
| `/new` | Admit native `Conversation.reset(undefined)`: the same conversation starts a new context with no handoff. No archive, summary, usage reset or extra model call is produced; earlier entries stay stored and remain visible to `/history`, and configured tools are unchanged. While busy it is placed at the next safe boundary and ends that run there instead of interrupting the current model turn; inputs queued before or after it in the same busy window run in the new context. A queued `/new` is a write, so `/abort` withdraws queued inputs but not the pending reset. |

Memory digestion's result is one internal event for this conversation's agent (the
same pattern as a worker result), not a local terminal answer the command
produces; the agent decides what to relay. `/digest` and `/digest status` require
the configured `read`, `write` and `edit` tools for this authenticated chat;
without them the admission is a fixed refusal and nothing runs.

The Telegram adapter exposes its own owner controls; they are not CLI commands.
`/new` there also rebuilds the assembled workspace prompt from the current files,
so a host with a prompt snapshot refuses it while that chat runs. `/abort` has a
`/stop` alias, `/status` and `/model` are bounded per-chat views, and `/restart`
is a host full-process replacement (the same Node executable, argv and current
environment through POSIX `process.execve`, after normal graceful teardown), not
a Harness close/reopen, daemon or supervisor. The CLI `/refresh` above is
unrelated: there is no Telegram `/refresh` command. See
[Telegram controls](./TELEGRAM.md#controls).

Equivalent presets can both show as selected because the marker matches the actual
provider/model/thinking settings, not a separately stored preset identity. A legacy
pair selection may match no preset. See [model selection](./MODELS.md).

## Local attachments

`/attach` is explicit, one file per command, and opt-in with the same top-level
`media` configuration Telegram ingress uses (see
[setup](./SETUP.md#8-optional-attachments-and-voice)). Without `media`, the
command reports that local attachments are unavailable and ordinary input stays
text-only. An in-process/SDK terminal host without an attachment callback gets the
same refusal; this adds no fallback path or local media reader.

The CLI only names an operator path. The gateway, which already owns storage,
resolves the file, reads it bounded, stores the original under
`<workspace>/<media.directory>` (default `media/`) and composes the ordinary turn.
The private owner-only local socket is the authorization boundary: the gateway
reads the named path with its own OS user's privileges, so it can read any file
that user can read. The CLI does not open storage, read the file, or receive its
bytes, and the model receives only a workspace-relative locator plus bounded
metadata, never the operator's absolute path. Paths are operator input, not model
input, and no tool authority is added.

- A path must be absolute or is resolved by the CLI process against its own
  working directory; it is capped at 4,096 code units and rejected if it contains
  control characters. The gateway refuses a relative path it still receives.
- Known image extensions (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) are accepted as
  photos only when the bytes match that format. A photo becomes native pi-ai image
  content plus its stored locator, so the existing configured vision handoff for
  a text-only preset applies unchanged; the CLI adds no vision call or image
  preprocessing.
- Every other file is stored as an opaque original with its locator only. Nothing
  is extracted, OCRed, converted or opened; PDF/Office handling and audio
  transcription are not added to the CLI, and no speech backend is provisioned or
  implied.
- The shared store enforces 20 MB per file. Empty, unreadable, non-regular,
  oversized and mislabeled-image files are refused with fixed, value-free text
  before anything is submitted. A stored identity comes from the file's bytes, so
  the same content with the same detected kind and extension reuses one stored
  original; the same bytes named `.txt` and `.md` are separate document locators,
  because the locator carries the extension. Stored originals are not deleted
  automatically and there is no total-disk cap.

A successful command prints the stored kind, workspace-relative locator and byte
count, then admits one ordinary submission. It counts against the same 64
unsettled-input bound as typed prompts, and the existing stream, settlement,
`/abort`, `/new` and EOF behavior is unchanged.

The shared store's generated filename is the only locator the model sees; reading
it is still a configured-tool decision. The named file is an ordinary stored
original, not a capability, and attaching it grants no path or shell authority.


## History search and browsing

These are local, host-bound, read-only controls over the mapped chat sessions
of this single-tenant store. Browse commands default to the attached conversation's key (normally `cli:default`); search
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
- `/episodes`, `/episode` and `/entry` default to the attached conversation's
  session key (normally `cli:default`) with a history host. `--session` must name an existing mapped chat session and must be exactly
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
attached conversation's host snapshot through the running Gateway:

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
notices are also awaited rather than queued. EOF waits for this attachment's
admitted inputs to settle before it disconnects; if a failed/ended run leaves
inputs queued under Durable's default `afterFailedRun: "keep"`, EOF reports that
state and cancels only local watch/wait contexts. The durable submissions remain
queued for owner reconciliation or reopen; only explicit `/abort` withdraws
them. SIGINT and SIGTERM cancel local waits and watches and close input; they do
not stop the gateway or its Harness.

This remains a text-first local surface, not a complete Python command port or
interactive terminal UI. Without `media`, ordinary input is text-only and
`/attach` is unavailable; with it, only the explicit `/attach` command can submit
a stored file. Model selection delegates to the gateway's allowlist and persists
in native Durable `pi.agent`; the CLI adds no agent runner, queue, session store,
or parallel model state, and it owns no storage or provider credential. Scheduled
origin-mode answers are rendered from the same conversation's committed entries;
the terminal adds no delivery queue.
