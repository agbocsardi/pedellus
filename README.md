# Nanobot on Pi Durable (experimental)

TypeScript port requiring Node >=22.19 and the pinned Pi 1.5.0 packages. This is not a production-ready replacement for the Python fork.

Config-selected coding tools, named model presets, optional bwrap shell, opt-in
memory/skills, compaction plumbing, owner-invoked closed-episode memory
digestion, configured vision handoff, MCP, native Code Mode composition, native
Brave web search plus safe public fetch, and opt-in media ingress (Telegram and
local CLI attachments) are integrated.
Agent-callable
cron scheduling and Telegram delivery are available. WebUI, migration and cutover are
deferred. [Historical handoffs](plan/) preserve evidence, not a standing
implementation queue.

## Run

[`SETUP.md`](./SETUP.md) is the short walkthrough: install dependencies, create a synthetic
workspace with memory and skills, enable tools in the config, then add Telegram
as a separate step. The example uses named `fast`/`deep` model presets; the default
comes from config. A local `/model <name>` switch is temporary: reattaching a CLI
keeps it, and a gateway restart returns to the configured preset.
One bounded synthetic live-model core run passed; see [acceptance](./ACCEPTANCE.md#2026-10-30--one-live-run-passed).
This is not a real-workspace or live-channel acceptance claim.

Copy `config.example.json` to a private explicit config file and edit the workspace, model, and environment-variable *names*. The config contains no credentials. Provider spellings are native Pi AI IDs, documented legacy aliases, or explicit custom compatible providers; [providers and auth](./PROVIDERS.md) lists the migration aliases, login/logout commands, native OAuth, the private credential store and the custom `providers` block. Credential references and `telegram.tokenEnv` must be environment-variable names, not values or `${...}` expressions; the runtime never reads Pi's credential store, performs model discovery, or falls back to another model; the explicit `models refresh` command can overlay newer native model metadata from pi.dev without granting it ([catalog updates](./MODELS.md#catalog-updates)). Native catalogs/routes are not drop-in Python-provider parity, and broad provider acceptance remains open. SDK hosts may pass an explicit pi-ai `Models` instance as `openGateway(config, context, { models })` for offline/custom use; the CLI never installs a faux provider. Code Mode classifiers are default-deny and need one explicit `classifierModel` pair; image generation is not installed.

```sh
npm ci
node bin/durable-nanobot.mjs gateway --config /path/to/config.json
node bin/durable-nanobot.mjs agent --config /path/to/config.json
```

The optional checkout-linked command is **`durable-nanobot`**, not Python's
`nanobot`: after installing dependencies, run `npm link --offline` to expose it.
The command and service use pinned `tsx` to load source in-process. Restart after
TypeScript edits: no full build, watcher or hot reload is required. Run
`npm run typecheck` separately for type errors. The `durable-nanobot.service` /
`durable-nanobot@.service` templates use that same launcher without needing a
command link. `npm run build` remains available for compiled output/tests. See
[checkout and service updates](./SERVICE.md#checkout-command-and-build-workflow).

Without `--config`, `gateway`, `agent`, `login`, `logout`, `models`, `recovery` and `cron` use the fixed primary file
`~/.durable-nanobot/config.json`, resolved from the runtime user home rather than
the working directory. A secondary instance passes its own explicit `--config`.
[User services](./SERVICE.md) documents the shipped foreground systemd user
units; this repository does not install or start them.

The gateway is the single owner: it opens storage, config tools, cron and, when
configured, the restricted Telegram adapter (explicit decimal user allowlist
only) and the opt-in Discord adapter. Every configured channel starts
concurrently and none is awaited before another starts. Discord needs its own
explicit sender/channel allowlists, a bot token environment reference and the
privileged message-content intent; a mapped Discord chat can also ask the model
for bounded, read-only channel/thread history under that sender's own Discord
permissions; see [Discord](./DISCORD.md). One or more
`agent` CLIs attach to it as conversation surfaces; the
historical bare `node bin/durable-nanobot.mjs --config ...` is the same attach and never opens
a second runtime. A CLI disconnect leaves the gateway, Telegram polling, admitted
turns and queued work running; a gateway restart stops all of them. Do not use
live bot polling for offline checks. Known startup/configuration failures print
fixed, value-free diagnostics; unexpected failures stay suppressed. See
[interactive CLI](./CLI.md#startup-diagnostics).

The authenticated owner also drives that gateway from a private Telegram chat:
`/new`, `/abort` (also spelled `/stop`), `/status`, `/model`, `/digest` and `/restart`.
`/digest` processes closed episodes only, automatically finishing every admitted episode across
internal chunks. The first pending episode is always admitted; spending targets only decide whether
to start another, up to `digest.episodesPerRun` (default 1). See [digest controls](./CLI.md#local-controls).

Each host advertises only what it implements and refuses a typed command it cannot
perform. `/model` selects one configured preset for that chat only. `/status` is
bounded read-only metadata with no model call. `/new` starts a new context **and**
rebuilds the assembled workspace prompt from the current files, so a host with a
prompt snapshot refuses it while that chat has a running turn rather than
half-applying; there is no separate `/refresh` command. Routine command receipts
are terse ("Context reset.", "Idle. Queue cleared."); status views retain
their data. The CLI-only `/reload` owner action validates the whole
configuration file and applies only foreground model presets/selection and
credential references, refusing while any live work or queued input exists (an
armed native cron timer is the one exception) and refusing a direct/preset mode
switch; everything else needs a restart. `/restart` is a full
process replacement: after the normal graceful teardown the same executable,
argv and current environment are re-exec'd (POSIX `process.execve`), so current
code and the re-read config load. Its acknowledgement is short: the replacement
posts one confirmation to each requesting Telegram chat once it is serving again,
while the CLI disconnects and does not wait for it. It is not a daemon,
supervisor or service
manager, and a platform without `execve` refuses it. These controls add no tool
authority and coexist with media ingress and MCP. See
[Telegram controls](./TELEGRAM.md#controls).

Answers, scheduled deliveries and host notices are delivered as rich messages: the answer travels as
markdown (Bot API 10.1), so headings, lists, tables and code render as written and most turns are one
message instead of several plain chunks. A server without the method, or a body Telegram refuses to
parse, falls back to plain text; attachment captions stay plain. See
[rich message formatting](./TELEGRAM.md#rich-message-formatting).

Closed episodes are summarized in the background by default using the conversation's current
model when the job starts. This makes provider calls and can incur costs. To use a different
model, set `episodeSummary.preset` to a configured preset name. Legacy direct configs
can set `episodeSummary.model` to an allowed `{ "provider": "...", "modelId": "..." }`;
set `episodeSummary.enabled` to `false` to disable summaries. Already-closed episodes are not
backfilled automatically. Short cache retention is requested, but cache reuse is not guaranteed;
see [episode summaries](./HISTORY.md#episode-summaries).

Idle rollover is off by default. With `"idleRollover": { "afterMinutes": 30, "preset": "small" }`
(it requires `classifierModel`), an authenticated mapped chat that stays fully idle that long (no
run, no gateway work, no pending `ask_user` question) gets a short handoff note prepared by the
named preset, usually a cheap model. Nothing is committed yet. When the owner's next message
arrives, the configured classifier decides whether it continues the conversation: if it does, the
note is dropped and the chat goes on in the same episode; if it is a new topic, or the classifier
fails or takes longer than 10 seconds, a new episode starts exactly like `/new`, with the note as its first
message, just before that message. A closed episode is digested and summarized like any other; a
chat the owner keeps continuing stays one open episode until `/new`. It costs one provider call
per idle period plus one classifier call on the next message, sends no channel message, and the
clock and prepared note are in memory, so a restart drops them and the next message continues.

## Busy owner messages

`followUpMode` decides where an owner's CLI or Telegram message goes when that conversation is
already answering. The default `"followUp"` keeps the historical queueing: the message waits and
starts the next run when the current one answers. `"steer"` submits it with native Durable
`whenBusy: "steer"`, so it is placed after the current tool round and joins the running work
without interrupting the generation.

All pending steers are placed together at each tool-round boundary, in admission order. This is a
fixed harness-wide policy, including worker steering; follow-up queueing is unchanged.
A steer that arrives at the final boundary is placed there and answered by the
following run, so it answers a beat later instead of pre-empting the answer already being written.

Owner messages queue rather than steer when the observed run belongs to another path or an
origin-mode cron occurrence is pending/running. With steering enabled, origin occurrences defer
admission while a run or queued steer exists and use native busy rejection before submitting.
Other queued follow-ups may still precede the occurrence. A blocked occurrence retries once per
second for at most five minutes, then records a visible failure; it never withdraws owner input.
A stranded queued steer can be cleared with `/abort`. Isolated cron and non-steering hosts keep
their existing behavior. The owner's read-to-submit decision is not atomic: a run replaced in that
narrow gap can still receive the steer and produce duplicate cron/chat delivery. This known race is
not eliminated by the scheduling gate.
Telegram stores the requested mode with each admitted message, so a later config change or a reopen
keeps that message's semantics, and every message a steered turn consumes delivers its single
committed answer once. Internal worker, digest and scheduled submissions are unaffected and keep the
native default. A failed turn has no committed answer and Durable exposes no run identity at
settlement, so it is never guessed from its error text: every message the failed turn consumed reports
its own fixed notice, which can repeat that notice for a shared turn but never drops or misattributes
one.

## Media

Attachment ingress is opt-in with a top-level `media` config, and the gateway owns
it. Photos arrive as native pi-ai image content plus a labeled workspace-relative
locator, so a preset marked `needsVisionHandoff` is described by the configured
describer preset instead of receiving raw bytes. Documents are saved unread under
the workspace media directory: no PDF, OCR or Office extraction. Voice/audio uses
the configured local engine: the default uv/faster-whisper helper (CPU, `small`,
`int8`) or the opt-in Python-free `whisper-cli` route
(`media.transcription.backend`, with engine/model/VAD/FFmpeg paths provisioned by
the operator). Provision whichever you choose explicitly before use, because
handling a message never installs the helper, downloads a model or calls a cloud
provider. Stored originals are ordinary workspace files
readable through the configured tools: no extra tool authority, no automatic
deletion and no total-disk cap. The local CLI submits one operator-named file per
explicit `/attach` through the same gateway store, under its own `media/cli/`
subdirectory. Every CLI attachment is path-only, photos included: the original is
stored unchanged and the turn names its workspace-relative locator, so no native
image content, vision handoff, transcription or extraction is added and the
configured tools decide whether to read it. See
[setup](./SETUP.md#8-optional-attachments-and-voice),
[Telegram media](./TELEGRAM.md#attachments-and-local-transcription) and
[local CLI attachments](./CLI.md#local-attachments).

## Runtime/recovery

One process acquires Chord's kernel-backed `processLock` using the canonical SQLite database path before opening storage. The lock is released when the owning process exits, including an uncatchable kill; a second live owner fails closed. SQLite, under `dataDir/nanobot.sqlite`, stores the Durable transcript and work state. The root conversation's `nanobot.session-map` document commits external session-key-to-conversation mappings atomically. Reopening the database reuses the same conversation without resetting its transcript; pending durable tasks are resumed after extensions are installed. Data directory is private (`0700`) and rejected when it resolves inside the workspace or any extra allowed root; it is not exposed to the shell environment.

The gateway upgrades upstream SQLite's NORMAL default to **WAL `synchronous=FULL` on its actual connection**, verifying both settings before and after native schema initialization and failing closed on mismatch. Parent crash/reopen and injected setup/readback/migration-failure probes passed; this is not proof of physical power/host-loss survival. Stopped-store synthetic backup/restore is verified; disk-full and broader storage acceptance remain open. See [storage policy and evidence](./STORAGE.md).

`toolAllowlist` is the **config-owned tool authority** for every conversation
(local CLI, Telegram and SDK hosts) and defaults to `[]`. A non-empty list may name only the
native `read`, `write`, `edit` and `bash` tools; the gateway enables exactly those
for authenticated mapped ordinary chats (not root, internal, forked or task-owned
conversations) over a guarded host environment on the actual workspace. Empty or
absent disables coding tools; the opt-in read-only `skill` tool is separate.
Scheduled isolated runs inherit a bounded subset captured from an authenticated
origin and stay bounded by current host config, so narrowing the list and
reopening also narrows those runs; pending calls for a removed tool fail closed.
Every Telegram user in
`allowFrom` shares the configured workspace and tool authority;
there is no per-chat approval or expiry step, so allowlist only
trusted users. The local CLI's `/tools` is a read-only diagnostic. A deployment
may select the optional direct-workspace Bubblewrap shell with
`toolSandbox: "bwrap"`; it is off by default, wraps shell commands only, and
never falls back to the unconfined host shell. See
[coding tools](./TOOLS.md) and [direct Bubblewrap shell](./DIRECT_BWRAP.md).

A mapped ordinary chat (the local CLI attach, an authenticated Telegram private
chat, or a mapped app thread while its adapter runs) also holds the model-facing
`ask_user` capability: 1-4 bounded questions with 2-4 options are delivered to that
chat's live owner surface with Telegram buttons, numbered terminal text or an app
question card, and the turn ends. The owner's answer arrives later as an ordinary
follow-up turn; nothing is parked and no authority is granted. See
[owner questions](./ASK_USER.md).

## Internal cron (opt-in)

[`CRON.md`](./CRON.md) describes finite timer/run tasks, relative one-shot
reminders (`after_seconds`), absolute/recurring/calendar schedules and IANA zones. Timers arm their successors independently of model
execution. Setting `cron: { enabled: true }` installs the foundation and a
model-callable `cron` tool (`add`/`list`/`remove`) in `openGateway`. The agent
schedules work when the user asks; there is no direct cron UI or user scheduling
command. Normal settlements of isolated and origin-mode runs (an answer, or a
fixed sanitized notice for a failure or empty answer) deliver through the durable
Telegram outbox; only a job's persistent `silent` setting suppresses a successful
result — a run cannot suppress its own message — while a failure still notifies,
an empty or marker-only answer queues the fixed notice, and cancelled or superseded
runs stay silent. Live-channel
acceptance remains open.

The package root (`src/index.ts`) is a small host entry surface: config loading and
types, `openGateway` and its host option types, `workspaceContextGatewayOptions`,
the context and Code Mode factories, prepared-context recovery operations,
and the CLI `main`. Other subsystems are imported directly from their modules.

## Code Mode and MCP

Native Code Mode is independently opt-in with `codemode: { enabled: true }`; with
no `codemode` block it is installed when MCP is configured, as before. Scripts
compose every tool the current authenticated mapped-chat conversation is already
authorized to call, through native `executeTool` validation and `ToolTask` hooks.
Code Mode adds no authority, is not recursive, and grants nothing to root, state,
fork, raw/other task-owned or scheduled-run automation conversations. Ordinary workers
may compose their captured coding, web, MCP and explicitly captured memory-recall
tools, but never Telegram, cron or workers.
`workers.toolAllowlist` sets independent worker grants (including worker-only shell/file tools);
omitted inherits configured chat capabilities, and `[]` grants none. Integrations still require
their own opt-ins. See [worker grants](./WORKERS.md#separate-worker-grants) and
[Code Mode contract](./CODEMODE.md).

MCP is **off by default**. Configuring `mcp: { enabled: true, servers: {...} }` with
at least one enabled stdio or Streamable HTTP server makes the shipped gateway
connect them and install the native Durable QuickJS Code Mode/tool-search bundle.
Discovered tools are deferred `mcp__<server>__<tool>` registrations reachable from
Code Mode scripts and `tool_search` in authenticated mapped chats and ordinary workers
with exact per-tool captures. Root, state, forked, digest and scheduled-run automation/other task
conversations get no MCP tool and no Code Mode. `toolAllowlist` still names only the coding tools
(`read`/`write`/`edit`/`bash`), independently of MCP.

MCP is a separate explicit connection authority. A configured stdio server runs as
a native host process, not under `toolSandbox: "bwrap"`. In an authenticated mapped
ordinary chat the assistant can directly add or update a server entry, start an
OAuth login, log out, or remove an entry; there is no proposal record and no
`/mcp approve` gate. An OAuth authorization link is delivered directly to the
initiating CLI attachment or Telegram chat (login refuses ambiguous shared CLI
attachments), and the owner can finish on another
device by pasting the callback URL back into that same chat. A completed login or
a configuration change connects/retires the affected server and refreshes tools
without a restart. Writes keep serialized atomic edits, whole-document validation,
stale-file refusal and exact-entry removal binding; existing worker captures are
never widened. OAuth grants live in a private `0600` file with the same trust
boundary as the provider credential store: protected from other users, not from
same-user code such as the model's own shell. There is no implicit `mcp.json`
discovery, no resources/prompts tool and no dashboard; failures surface as fixed
codes on the SDK `gateway.mcp` surface and in `/mcp`. See [MCP servers, management
and OAuth](./MCP.md) and [Code Mode contract and verified boundaries](./CODEMODE.md).

## Web search and public fetch (opt-in)

`web: { search: { keyEnv: "BRAVE_SEARCH_API_KEY" }, fetch: true }` installs two
native tools, both off by default: `web_search` uses the fixed
`https://api.search.brave.com` endpoint and reads its key from the named
environment variable once at startup, and `web_fetch` reads one public HTML,
plain-text or JSON URL. Fetch is limited to `http`/`https`, refuses userinfo and
private, loopback, link-local, reserved and mapped addresses, pins the validated
DNS answer, revalidates every redirect, sends no credentials or cookies, bounds
time/bytes/text, parses HTML without executing scripts, and reports original/final
URLs, MIME, retrieval time and explicit truncation. Neither tool grants filesystem
or shell authority, and both are offered in authenticated mapped chats and ordinary
workers with captured grants. There
is no login, cookie jar, browser automation, crawling, PDF/Office extraction or
retrieval cache. Product Brave search remains **live-unverified**; the implemented
fetch has one bounded `example.com` smoke. See [WEB.md](./WEB.md).

## Opt-in context SDK

`createContextExtension` composes bounded, host-supplied identity/bootstrap,
memory and skill summaries through native Durable sections. Direct callers
need a **fresh extension and dedicated registry per Harness/storage**: conversation
IDs collide across stores. `openGateway` can also accept an opt-in host snapshot
provider and reconstructs snapshots before resume; it does not load files itself.
An opt-in [workspace loader](./WORKSPACE_CONTEXT.md) supplies fixed bootstrap files
and explicitly selected memory files, plus all Markdown beneath `memory/system/`,
to such a provider; it can also append a
bounded topic-memory manifest for on-demand reads ([MEMORY_CONTEXT.md](./MEMORY_CONTEXT.md));
model-facing note and conversation recall has a separate three-tool contract
([MEMORY_RECALL.md](./MEMORY_RECALL.md)). Skill discovery is also opt-in through
`workspaceContext.skills`: it reads only `<workspace>/skills` and an
explicitly configured builtin skills root, fails closed on metadata it cannot
parse, never executes a skill, and supports progressive loading — a prompt
summary plus a read-only `skill` tool that serves a discovered workspace or
builtin body on demand ([details](./SKILLS_CONTEXT.md)). Neither loader
provides full Python memory or skills parity. The local CLI/gateway host opts in
only when the config contains a `workspaceContext` section
(`workspaceContext.memoryFiles` and optional `workspaceContext.memoryManifest`,
default off); the shipped example enables it, and leaving the section out keeps
it off. It contributes no identity. The local CLI exposes `/refresh` to
re-capture that conversation's context and skills when it is idle. A prepared
request containing old Nanobot context is cancelled automatically at startup
through native Durable abort semantics, so the gateway becomes available without
replaying, resubmitting or rewriting that request. One durable, deduplicated
interruption notice is left for the originating mapped chat, worded for the class
that was interrupted (an owner turn, background worker or scheduled work, a
memory-digestion batch, or a compaction); a local CLI attach
shows it once, and Telegram delivers it through the existing outbox and admission
checks. No model turn is started and continuation is the owner's next input. With
the gateway stopped and an existing database, an owner can still inspect blocked
task IDs/fingerprints and explicitly cancel a dispatch when the automatic path
cannot complete (for example a prepared model outside `allowedModels`); see
[prepared context recovery](./CONTEXT_RECOVERY.md) and the
[context contract](./CONTEXT.md).

## Migration (parked)

A future migration is a single owner-approved run, potentially outside this
repository. There is no maintained migration or archival SDK; see [the deferral
note](./MIGRATION.md).

## Current status and checks

The approved model-facing memory recall contract specifies `memory_search`,
`memory_browse` and `memory_read`; see [MEMORY_RECALL.md](./MEMORY_RECALL.md).
It is separate from legacy history SDK/local APIs and makes no claim of live-model
usefulness or deployment acceptance.

Run `npm run typecheck` and `npm run test:behavior` for offline Nanobot-owned
contracts using synthetic providers, temporary SQLite stores and crash/reopen
fixtures. These do not establish full parity or production security. The opt-in
[coding tools](./TOOLS.md) register native tools over the guarded host
environment on the actual workspace; they are disabled by default and are not
confinement. The optional [direct Bubblewrap shell](./DIRECT_BWRAP.md) narrows
the shell mount view but is not a quota or hostile-tenant boundary.
[Tool replay checks](./TOOL_REPLAY.md) exercise synthetic direct tools and the
native replay/tool-policy boundary.

For earlier Telegram reliability and scripted smoke evidence, see [TELEGRAM.md](./TELEGRAM.md).
Bounded owner-authorized provider/tool probes passed in disposable workspaces.
A synthetic OpenCode Go / DeepSeek Flash core run also passed skill loading,
topic-memory write/read, compaction and fresh-process recall; see
[acceptance](./ACCEPTANCE.md#2026-10-30--one-live-run-passed). This does not
establish broad provider support, real-model reset/history-search quality,
real-workspace usefulness or live scheduled delivery. Offline consolidation
also checked the combined Gateway memory/skills/four-tool path on both backends
with a faux provider. The behavior suite includes focused config-tool regression tests, but does not
cover every newer slice; additional temporary probes are described in feature docs.
Behavior/execution Node test phases use GNU `timeout`: 60 seconds, followed by a
forced kill after 5 seconds if necessary, so leaked handles cannot wait forever.
Stopped-store synthetic restore passes; broader storage-fault/restore acceptance,
A/B acceptance and owner-approved cutover remain open. No production cutover
has been performed.
