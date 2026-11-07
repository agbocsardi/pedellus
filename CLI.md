# Interactive CLI

For a first-time walkthrough of workspace, memory, skills and config-enabled
tools, start with [setup](./SETUP.md).

The package exposes `durable-nanobot`, leaving Python's `nanobot` untouched.
After installing pinned dependencies, optionally run `npm link --offline` from
the checkout to expose the command. Without linking, `node bin/durable-nanobot.mjs`
or `npm start --` uses the same source entry point. Restart after TypeScript edits;
no build is required, while `npm run typecheck` remains a useful separate check.
The optional compiled `node dist/cli.js` alternative still needs a build;
[service/update details](./SERVICE.md#checkout-command-and-build-workflow).

The gateway is the single agent/Durable owner. A CLI is one conversation
surface over it, like Telegram and future channels, not a runtime:

```sh
durable-nanobot gateway                    # uses ~/.durable-nanobot/config.json
durable-nanobot gateway --config /path/to/config.json   # one owner: storage, tools, cron, Telegram
durable-nanobot agent                      # attaches to the same default gateway
durable-nanobot agent --config /path/to/config.json     # attach a terminal to that gateway
```

Without `--config`, `gateway`, `agent`, `login`, `logout`, `recovery` and `cron` read exactly
`~/.durable-nanobot/config.json`, resolved from the runtime user home rather than
the shell's working directory. A secondary instance passes its own explicit
`--config`. There is no config discovery, merging, search, auto-generation or
migration, and a missing default file fails with a fixed message. See
[user services](./SERVICE.md) for the shipped systemd unit pattern.

## Help

`--help`/`-h` prints to standard output and exits 0 without reading a
configuration, opening a socket or starting a runtime, so it works in a fresh
checkout:

```sh
durable-nanobot --help            # overview: commands, config default, slash commands
durable-nanobot help gateway      # the same page as `gateway --help`
durable-nanobot gateway --help
durable-nanobot agent --help
durable-nanobot login --help
durable-nanobot logout --help
durable-nanobot recovery --help
durable-nanobot cron --help
```

A per-command page carries that command's exact usage line, its own options, at
most two short notes and two examples. A help flag is honoured before dispatch,
so `--help` on any known subcommand line names that subcommand's page and never
reads the configuration named on the same line.

The bare `help` word is a help request as the first argument with nothing after
it, or with a help flag on the same line, so `help` and `help --help` print the
overview and exit 0; `--help --config x` does too. `help --config x` and
`--config x help` are ordinary argument lists: they print the fixed usage block
on standard error and exit 1.

An unrecognized subcommand prints one fixed `unknown command` diagnostic with
the usage block and a help hint, and exits 1. That diagnostic echoes the typed
token only when it is shaped like a command name; no other argument is ever
repeated. Any other malformed known form also prints the full usage block and
exits 1.

Both conversation surfaces render the same command catalogue, one short line per
command. `/help` prints the listing this host actually offers; `/help <command>`
prints one command's usage line and its one-sentence detail:

- CLI: `/help`, `/help model`. Commands this host does not offer are named in one
  line instead of being advertised as working.
- Telegram: `/help`, `/help digest`. The listing stays inside one bounded notice,
  so only the owner commands this gateway implements are listed and nothing is
  advertised that would be refused.

## Provider authentication

Authentication is explicit and terminal-only; the gateway never logs in at
startup, and no model or Telegram chat can start a login flow:

```sh
durable-nanobot login
durable-nanobot login openai
durable-nanobot login openai --auth oauth
durable-nanobot logout
durable-nanobot logout openai
```

`login` presents the native provider list and each provider's native API-key or
OAuth method, then prints browser URLs, device codes, progress and typed prompts.
`--auth` accepts `api_key` or `oauth`; `provider` is a native provider ID (a
legacy alias is resolved for convenience). `logout` removes one stored provider
credential. Both accept `--config <path>` like the gateway and validate the full
configuration the same way, including `workspace` and the `dataDir` boundary.
They prepare (create if absent, `0700`) the canonical configured `dataDir` and
write only Durable's private credential files there; they open no gateway, no
Durable store and no model turn. Failures print one fixed diagnostic naming the
cause (unknown provider, unsupported method, missing stored credential, cancelled,
or failed) without echoing credentials, provider errors or paths. Durable's private
credential store is independent of Pi's; see
[providers and auth](./PROVIDERS.md#login-and-logout).

A gateway request resolves stored OAuth and refreshes it natively. `/restart`
keeps the current process environment, so a changed systemd environment file needs
a service restart.

`durable-nanobot --config /path/to/config.json` remains the historical terminal command.
It now attaches exactly like `agent` and never opens an implicit gateway or a
second runtime; start `gateway` with the same configuration first. The bare
historical form still takes an explicit path. `agent --conversation <name>` attaches a
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

An interactive attach (stdin and stdout are both a TTY) labels the two roles: the
readline prompt reads `You: ` and each answer begins with one `Assistant:` line. It
prints one connection line: earlier replies are not replayed, `/history` prints them,
and closing the terminal does not cancel admitted work. Each ordinary input or
`/attach` turn then prints one receipt, only after native admission and before any
reply, saying the reply is pending and that `/status` distinguishes a running turn
from a queued one. While that input is admitted and unsettled, and before any answer
text is written, one activity line above the prompt animates: `Waiting for the
assistant...` until a committed snapshot shows a run that owns the input, then
`Assistant working...`. Neither label claims a model request is generating before
that run is observed, and the line is cleared, with its timer released, on answer
text, settlement, abort or attachment close. Prompt erasure preserves the typed
buffer, so multiline and Unicode input and its cursor keep working. Host notices are
never labelled as assistant text, and reasoning, tool calls/arguments and tool output
stay hidden. A non-interactive terminal (or `TERM=dumb`) gets no labels, receipts or
activity line; piped output stays answer-only.

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
failures print one fixed, value-free message: a missing default configuration,
unreadable/invalid configuration,
invalid configuration fields, unknown providers or custom-provider entries, unavailable models
or thinking levels, missing provider credentials, a missing Telegram token
environment variable, workspace/data-directory preparation failures, a data
store already owned by another live process, and an automatic interrupted-turn
recovery that could not complete safely. These messages never include configuration
values, environment values, filesystem paths, provider/dependency error text or
the underlying exception. Unexpected failures keep the generic
`durable-nanobot: command failed; diagnostic details suppressed` summary.

Failures additionally emit a bounded `durable-nanobot diagnostic:` JSON record to
stderr (journald in the shipped units). It records the failure stage, stable
fingerprint, allowlisted error class/code/reason, a task ID and report reason when
Durable supplies them, bounded restart counts, code-relative stack locations and
up to four errors in the cause chain.
Native Durable `onReport` events also reach that log, including asynchronous
storage, task, hook and listener failures that do not fail the calling operation.
Known value-free Durable invariant messages are included; arbitrary exception
messages, absolute host paths, provider request objects, credentials, URLs and
transcript text are not. This is diagnostic metadata, not an unrestricted debug
trace. Primary gateway/open errors remain the errors returned to callers, even
when cleanup also fails; those shutdown failures are reported separately. Normal
shutdown attempts every resource and returns the first cleanup failure, if any.
Reporting is best-effort and cannot throw into application cleanup. Telegram
transport wrappers retain the native cause for this formatter. Log retention and
service restart policy are unchanged. See [service logs](./SERVICE.md#logs).

A prepared model dispatch that pins historical Nanobot context no longer makes a
normal startup fail by itself. The gateway cancels exactly that dispatch through
native Durable abort semantics, restores availability, and leaves one durable
interruption notice for the originating chat. A local `agent`/terminal attach
prints a pending notice once and acknowledges it; a Telegram notice uses the
existing durable channel outbox and admission checks. No model turn is started and
nothing is resubmitted. A notice says what class was interrupted: an owner turn
suggests asking to continue, background worker or scheduled work says the same of
background work, an interrupted memory-digestion batch says the unacknowledged
batch is offered again, and an interrupted compaction says no action is needed.
Notices appear only on attach; a running gateway never pushes one to the terminal.
If the prepared model itself left `allowedModels`, the bounded recovery record is
still full after its settled entries were drained, or native abort failed, the
fixed startup failure and explicit recovery command below remain. An unreadable
interruption record does not block startup: it is retired natively and the owner
may then never see the notice it held.

An `agent` (or legacy default) launch additionally fails closed when no gateway
answers on the configured endpoint, or when the endpoint's socket path cannot be
used. Its fixed message says to start `durable-nanobot gateway --config <path>` with the
same configuration. The CLI does not fall back to opening a store or starting a
second runtime.

For live-owner lock contention, the fixed message says to stop the other running
durable-nanobot gateway process. If automatic interrupted-turn recovery cannot
complete, the fixed message says to run
`durable-nanobot recovery [--config <path>]` with the same configuration to inspect and
cancel the blocked task, then start again. Normal startup cancels only the exact
startup-blocking prepared dispatch and never rewrites its checkpoint; the recovery
command remains the stopped-store fallback.

Recovery operation errors keep their dedicated `durable-nanobot recovery:` text and
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
Telegram origin through its outbox; only a job's persistent `silent` setting
suppresses a successful result — a scheduled run cannot suppress its own message —
while a failure still notifies, an empty or marker-only answer queues the fixed
notice, and cancelled or superseded runs are not. See
[cron](./CRON.md).

## Operator scheduling

`durable-nanobot cron` is the owner's scheduling console. It attaches to the running
gateway over the same private local socket as `agent`, so the gateway resolves every
origin, owner and cancellation; the command itself schedules nothing:

```sh
durable-nanobot cron list
durable-nanobot cron show <jobId>
durable-nanobot cron cancel <jobId>
durable-nanobot cron create --origin <sessionKey> --key <requestKey> --after 600 --message "Stretch"
durable-nanobot cron create --key daily-1 --cron "0 9 * * 1-5" --tz Europe/Budapest \
  --origin telegram:<identity>:chat:<chatId> --message "Morning check"
```

`list` and `show` are read-only and cover every currently mapped chat; `list` order is the
next occurrence and it names the mapped chat keys an explicit `--origin` can use.
Listings are bounded to 100 compact rows; follow the printed `list --offset <n>` for the
next page (a point-in-time view, not a frozen snapshot). Neither command attaches or creates a chat. `create`
requires explicit `--origin` and `--key`; the cron foundation dedupes an identical retry, refuses
a different payload under the same key, and never re-arms a cancelled original.
Exactly one of `--at`, `--after`, `--every` or `--cron` (with optional `--tz`) is
accepted, and `--mode background|origin` matches the job's run mode: a background job
records its outcome on the job (`cron show`) and its answer is delivered only through a
channel outbox (currently Telegram), while `--mode origin` answers in the origin
conversation itself. `--origin` must name an already mapped chat.
`cancel` is exact-ID, refuses an ID recorded under more than one chat, and reports a
recorded cancellation separately from a post-commit cleanup failure. If the gateway
stops answering, the command reports an unknown outcome and points at the retry-safe
or verify-first path instead of claiming a result. There is no bulk, run-now,
re-arm or schedule-editing command. See [cron](./CRON.md#operator-controls).

## Recovery

Normal startup automatically cancels a prepared model dispatch that pins
historical Nanobot context (after its model passed the configured authority scan),
restores availability, and records one interruption notice. This stopped-store
command remains the fallback when that automatic path cannot complete: a full or
unreadable interruption record, an abort mark that did not persist, or a prepared
model outside `allowedModels`. It prints a fixed value-free message naming this
command. The same executable exposes an owner-only recovery path that never opens
the gateway, resumes scheduling, or requires credentials. It does require the
existing SQLite database and the gateway process to be stopped; a live owner is
reported as a lock conflict. Inspection may perform Durable's native
`Harness.open()` crash reconciliation but never resumes task execution:

```sh
node bin/durable-nanobot.mjs recovery                         # default primary configuration
node bin/durable-nanobot.mjs recovery --config /path/to/config.json
node bin/durable-nanobot.mjs recovery --config /path/to/config.json --cancel <taskId> --fingerprint <sha256>
```

Inspection prints JSON with task ID, kind, phase, pinned entry, and fingerprint.
Cancellation requires the exact fingerprint, durably marks only that native task
for abort, and preserves the transcript. The result reports `abort-marked`,
`terminal`, or `orphaned` from a fresh task read. Reopen the gateway to run the
abort protocol; a cancelled poll whose model is outside `allowedModels` remains
fail-closed and is not remotely cancelled. See
[prepared context recovery](./CONTEXT_RECOVERY.md).

## Busy messages

While this conversation is answering, a typed line is placed by the configured `followUpMode`:
the default `"followUp"` queues it and starts the next run when the current answer settles, while
`"steer"` places it after the current tool round so it joins the running turn. Only one queued
steer is placed per tool round (the pinned native default), and a steer that arrives after the last
tool round is placed at the final boundary, so it is answered by the following run a beat later
instead of interrupting the answer already being written. A turn that consumes several inputs settles
all of them with one committed answer entry, which the terminal prints once, and typing stays
available meanwhile. `/attach` turns follow the same mode. An idle conversation and a run the
terminal did not start — a scheduled origin-mode turn, a digest result or a worker result — are never
steered into: the typed line queues and is answered by its own turn, because the scheduled path
delivers that run's answer itself. A chat with an admitted origin-mode cron occurrence queues too, so
a scheduled input is never placed at the same boundary as a steer. Native `submit` has no conditional
steering, so this is a read of the running input set and the chat's job record immediately before
admission, and a reattached terminal conservatively queues until it has admitted an input of its own.
A failed turn reports `Turn ended` once when the terminal observed its membership in the shared run
(identified by that run's first native input, never by the error text); an input whose run membership
it never observed reports its own end. See
[busy owner messages](./README.md#busy-owner-messages).

## Local controls

| Command | Behavior |
|---|---|
| `/help` | Show the owner controls this host offers, one command per line with a short description; `/help <command>` prints that command's usage and detail. |
| `/status` | Show the conversation's current host-selected model, native run/inbox state, and Durable-recorded per-model/tool usage. Provider-side charges or unrecorded spend remain unknown. A bounded background summary follows: this conversation's own live workers and cron jobs (executing, queued, parked, or with a future occurrence armed) and whether the one workspace-global memory-digestion run is live in this chat or another. A natively blocked task is named as parked instead of counted as running; `Background: idle` means nothing is executing or queued right now, and an armed future occurrence is its own `Cron:` line with the next due time. When gateway-wide work would be interrupted by `/restart`, one `Restart:` line names only the bounded count. It is read-only metadata: no model call, dashboard, management command, recovery interface or transcript read, and the agent remains the manager of that work. |
| `/history [count]` | Show the latest user/assistant text messages only (default 10, max 50), using Durable entry pagination; each snippet is limited to 200 characters and the scan to 2,000 entries. Reasoning, tool, and non-text blocks are omitted; synthetic user-role reset or compaction messages may also appear. |
| `/search [--scope messages\|tools\|all] [--role user\|assistant] [--limit 1-50] [--next] [--] [query]` | Search or browse the local history index. Default scope is messages; `--scope tools` searches tool names, arguments and result text only, and `--scope all` combines messages and tools. Empty text browses the selected scope. See [history search and browsing](#history-search-and-browsing). |
| `/episodes [--session <sessionKey>] [--limit 1-50] [--before <entryId>]` | List reset-delimited episodes newest first, with entry ranges, counts and recorded summary status only. `--session` must name an existing mapped chat session; the default is this attachment's session key (normally `cli:default`). This command does not generate or show summary text. |
| `/episode [--session <sessionKey>] <startEntryId> [--limit 1-30]` | Open one episode's bounded first window of message/tool entries from an existing mapped chat session. |
| `/entry [--session <sessionKey>] <entryId> [--radius 0-5]` | Open one entry plus at most five neighboring entry IDs on each side, showing only user/assistant text and tool calls/results. `--session` must be an existing mapped chat session. |
| `/model` | List named presets and the current/default choice. `/model <name>` temporarily selects one; `/model default` returns to the configured preset. A CLI reattach keeps the temporary selection; a gateway restart also returns to the configured preset. Direct-model configs retain `/model <provider> <modelId> [thinkingLevel]` and persisted selection. Busy selection is rejected atomically; retry when idle. In-process/SDK terminal callers without a host callback remain read-only. |
| `/tools` | Read-only diagnostic of the config-selected coding tools for this conversation. |
| `/refresh` | Re-read the configured workspace bootstrap, memory files, manifest and skill inventory for this attached CLI conversation. Requires `workspaceContext`; rejected while the conversation is busy. The refreshed summary and skill table apply to the next model request. |
| `/digest` | Start a background closed-episode memory invocation; print started, busy, idle or refused. Requires an explicit digest model. The first pending closed episode is always admitted regardless of estimated cost; internal chunks automatically continue until it finishes. After each episode, budget remaining input/responses against the next episode's estimated cost, up to `digest.episodesPerRun` (default 1). Never processes an open episode. Real failures or cancellation retain partial cursor progress and ordinary writes; invocation budgets never deliberately truncate an admitted episode. Returns immediately and creates no schedule. Success is silent; failures may resume the origin agent. |
| `/digest status` | Bounded read-only view of the live digestion run, this conversation's newest run, and the retained internal issue reports (pending count and whether a new start is possible): task IDs, outcome, whole episodes/internal chunks completed, budget deferral, last position, evidence count and a bounded recorded error. Episode listing/detail additionally shows cursor-derived digestion progress, including imported baseline, partial and open/ineligible. It performs no transcript scan, model call or cursor change. |
| `/mcp` | Bounded read-only status of configured MCP servers and any login waiting for a callback, with no model call. Ask the assistant in this attached conversation to add or update a server, log in, log out or remove one; management is direct, not an approval command. A login URL is printed here once as a transient owner line; a callback-shaped line is consumed before model admission and completes the flow. Requires a gateway opened from a configuration file. |
| `/attach <path>[ -- <prompt>]` | Store one operator-named local file through the gateway under the CLI attachment subdirectory of the configured workspace media root and submit it as an ordinary path-only turn, optionally with prompt text after the first ` -- ` (paths may contain spaces). Requires top-level `media` config; see [local attachments](#local-attachments). |
| `/compact` | Admit native Durable manual compaction. Summarization is asynchronous; summary placement follows native inbox boundaries and original entries remain stored. |
| `/abort`, `/stop` | Use native `Conversation.abort()`: stop foreground conversation work, withdraw queued inputs, and wait for native idleness. It does not implement Python sustained-goal/background abort semantics. |
| `/new` | Start a fresh context in the same conversation and rebuild configured workspace instructions, memory and skills, exactly as Telegram does. With workspace context configured, a busy conversation is refused; prompt replacement and the reset marker commit atomically. No handoff, archive, summary, usage reset or extra model call; original entries and tool authority remain. Without configured workspace context, native reset semantics apply, including safe-boundary placement while busy. |
| `/restart` | Ask the owner host to replace the whole gateway process after graceful teardown, using the same executable, argv and environment. Advertised only when supported. Refused with a fixed no-effect reason while live work (a running generation, tool, compaction, worker, digest or cron run) would be interrupted; a sleeping cron timer does not block. Finish or abort that work and retry; nothing is auto-cancelled. Configuration and workspace context reload; every attached CLI and Telegram surface disconnects. The local acknowledgement is flushed before shutdown. |

Digest sizing: `digest.episodesPerRun` is the whole-episode ceiling (default 1).
`maxInputTokens` (500,000 including cached input) and `maxRequests` (12 successful
responses) are invocation targets for admitting **additional** episodes. The first
pending episode is always admitted, and admitted episodes may overshoot these targets.
The next-episode estimate uses the actual reader's chunk packing (including character,
entry and fixed evidence-step limits), then allows three rounds plus framing per chunk
with 25% headroom. It is not an exact token count or financial cap. Native retries,
compaction and uncommitted provider work prevent exact network-spend accounting.

Internal chunk safeguards remain: `charsPerBatch` (200,000, narrowed for model context),
`entriesPerBatch` (2,000), `maxToolCalls` (24), `runTimeoutSeconds` (600),
`maxChangedFiles` (8), `maxDiffChars` (32,000 inserted plus removed).
A safety failure, provider/tool error or cancellation can interrupt an episode; its
acknowledged prefix stays consumed and ordinary writes are not rolled back. Reopen
restores the accepted current chunk and captured bounds; a later invocation resumes
unfinished evidence. Invocation write counts sum per-chunk reservations, not distinct
files across chunks. Historical already-admitted tasks keep their original captured
single-chunk spending semantics; new invocations use whole-episode admission.

Imported transcript prefixes remain consumed via migration-seeded cursors. There is
no blanket legacy-channel exclusion: new closed episodes in those chats can be digested.
Original history remains searchable/recallable. Episode summaries are navigation only,
never evidence of full digestion or a substitute for transcript facts.

Memory digestion reports only issues. A failed or cancelled run is one internal
event for this conversation's agent (the same pattern as a worker result), not a
local terminal answer the command produces; the agent decides what to relay. A
successful run, including a successful no-op, sends nothing at all and starts no
origin-agent turn: its outcome is visible only under `/digest status`.
`/digest` and `/digest status` require
the configured `read`, `write` and `edit` tools for this authenticated chat;
without them the admission is a fixed refusal and nothing runs. A start is also refused
when the bounded internal issue-report queue holds 100 undelivered or unknown
issues and none can be safely pruned; `/digest status` reports that pending count
and the refusal. Undelivered issues are never evicted to make room, and reopening
the gateway retries each admission once from the authoritative native task.

Shared owner controls have the same effects in CLI and Telegram: `/new`, `/abort`/`/stop`,
`/status`, `/model`, `/digest`, `/digest status`, `/help` and supported `/restart`.
Presentation remains channel-specific; CLI retains browsing, compaction, attachment and `/refresh`
controls. `/restart` is whole-process replacement, not a Harness reopen or terminal reconnect.
There is no Telegram `/refresh`; `/new` rebuilds that chat's prompt. See
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
resolves the file, reads it bounded, stores the original byte-for-byte under
`<workspace>/<media.directory>/cli` (default `media/cli/`) and composes an ordinary
text turn naming that workspace-relative locator. The CLI channel keeps its own
subdirectory, so its generated names never collide with Telegram originals; the
Telegram adapter's existing locators under `<workspace>/<media.directory>` and its
native photo handling are unchanged. The private owner-only local socket is the
authorization boundary: the gateway reads the named path with its own OS user's
privileges, so it can read any file that user can read. The CLI does not open
storage, read the file, or receive its bytes, and the model receives only the
locator plus bounded metadata, never the operator's absolute path. Paths are
operator input, not model input, and no tool authority is added.

Every CLI attachment is path-only, photos included:

- Pi's own interactive CLI turns clipboard-pasted images and `@file` images into
native image content after resizing. This line-oriented local surface deliberately
  does not: it receives completed lines over the private socket, has no clipboard
  or drag input, and keeps every attachment path-only as an explicit owner
  decision. A photo is inspectable only through a configured `read` tool.
- The original bytes are stored unchanged and the turn carries ordinary text with
the workspace-relative locator only. No native image content is built, no vision
handoff or describer model is called, and no transcription or document extraction
runs. Whether and how to inspect the file is the configured tools' decision, and
the labeled original filename and announced MIME type are untrusted metadata.
- File names never decide validity: a `.jpg` that holds other bytes is stored as an
opaque original rather than refused, and an unknown extension is stored as `bin`.
Nothing is interpreted as an image, audio or document.
- A path must be absolute or is resolved by the CLI process against its own
  working directory; it is capped at 4,096 code units and rejected if it contains
  control characters. The gateway refuses a relative path it still receives.
- The shared store enforces 20 MB per file. Empty, unreadable, non-regular and
  oversized files are refused with fixed, value-free text before anything is
  submitted. A stored identity comes from the file's bytes, so the same content
  with the same extension reuses one stored original; the same bytes named `.txt`
  and `.md` are separate locators, because the locator carries the extension.
  Stored originals are not deleted automatically and there is no total-disk cap.

A successful command prints the workspace-relative locator and byte count, then
admits one ordinary submission. It counts against the same 64 unsettled-input
bound as typed prompts, and the existing stream, settlement, `/abort`, `/new` and
EOF behavior is unchanged.

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
  host callback, `/refresh` is refused as not offered here and names the fix:
  set `workspaceContext` in the configuration and restart.

This is the supported way to make a skill created or edited during the current
conversation usable without starting another conversation. Scheduled background
runs have no session key and are not refreshed; they pick up the snapshot on
their next run or Gateway reopen.

`/stop` aliases `/abort` in CLI and Telegram: both withdraw queued foreground inputs.
`/restart` is available only through a supporting gateway host. The earlier
`/steer`, `/after`, goal, interrupt, btw, task, policy, receipt, skill,
memory/Dream and pairing commands no longer exist here; normal input is admitted
by the native conversation in input order. A typed slash command this host does
not offer is refused with the same reason `/help <command>` gives, and an
unknown one is refused as unknown; neither is sent as a model prompt. Prefix a
prompt with `//` to send one literal leading slash (for example, `//help` sends
`/help` to the model).

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
