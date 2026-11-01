# Telegram adapter

`src/channels/telegram.ts` exports `runTelegram(gateway, options, context)` and
`TelegramOptions`. It uses grammY 1.46.0's typed `Api` client, Telegram updates,
and structured `GrammyError`/`HttpError` types. An explicit native-fetch bridge
keeps offline probes mockable. The API root is fixed to
`https://api.telegram.org`; the bridge forces `redirect: "error"`, disables
sensitive grammY logs, and reads the current global `fetch` at call time. grammY's
Node build supplies its own `AbortController` per call, so the bridge re-expresses
that signal with a native one; cancellation and grammY's timeout still abort the
in-flight request. The adapter calls typed `getMe` before polling and never
writes the token or token-bearing URL into an error message.

## Controls

A bounded authenticated control dispatcher runs before any input admission. It
only sees updates that already passed the private-chat allowlist check, so an
unauthorized sender, a group, a bot, or an attachment can never be a control and
never reaches it. `message.text` (not a caption) is classified:

- The owner controls are `/new`, `/abort`, `/stop`, `/status`, `/model`,
  `/digest`, `/mcp`, `/restart` and `/help`. `/stop` is an alias of `/abort` with
  exactly the same effect and the same durable record (it is normalized before
  admission, so there is one control kind and one code path). Which of them this
  adapter advertises depends on what the host really exposes (see
  [Host capability and the native menu](#host-capability-and-the-native-menu)).
  A typed command the host cannot perform is refused with fixed text and is
  never sent to the assistant.
- Matching is an exact leading command token (case-insensitive). `/new`,
  `/abort`, `/stop`, `/status`, `/restart`, `/digest` and `/help` take no
  arguments; `/model` takes one configured preset name or `default`; `/digest`
  also accepts the literal `status`; `/mcp` takes nothing, or `show <id>`,
  `approve <id>`, `deny <id>` with one 16-hex request ID. Anything else gets a
  bounded usage notice.
- `/new@bot` etc. are controls only when the mention names this bot from
  `getMe` (case-insensitive). Another bot's mention, or a mention while `getMe`
  returned no usable username, gets a bounded notice and is neither executed nor
  forwarded to the assistant. A malformed mention (`/new@`, `/new@@x`) is an
  unknown command as well, answered the same way.
- Any other leading slash command gets a bounded notice naming the controls this
  host implements and is **not** sent to the assistant. `/prose` is therefore not
  a prompt; `//prose` sends `/prose` literally as assistant input.
- Everything else, including plain text and `/new` inside a sentence, is
  ordinary assistant input.

`/new` starts a new context for this chat **and** rebuilds its assembled
workspace prompt. The shipped Gateway pairs both in one host operation
(`Gateway.resetSession`): Durable's native reset stays the context boundary (no
handoff text, no summary, same conversation identity, same tool authority and
cron ownership), and the configured `workspaceContext` snapshot — bootstrap
files, memory files, the memory manifest and the on-demand skill metadata — is
re-read from disk and replaces the previous snapshot for the new session only.
Requests already prepared, other chats and the configuration are untouched.

Because both halves must apply together, `/new` is refused while this chat has a
running turn: a rebuilt snapshot installed mid-run would change the running
turn's later provider request, and a reset alone would leave the new context
with the old prompt. The refusal is atomic and is not queued; `/abort` or waiting
for the turn to settle keeps the chat usable. Messages admitted before the
command are still submitted first, exactly as for `/abort`.

A host with no prompt snapshot (or a narrow SDK gateway without `resetSession`)
keeps the previous behaviour: `/new` is the plain native reset on the same
mapped conversation, and its acknowledgement says nothing about a rebuild. A
host that does have a snapshot reports `busy` instead of a half-effect.

`/abort` calls `Conversation.abort(context)` without `background`, which is the
narrowest public API: it withdraws this conversation's queued inputs, marks its
live non-background tasks and resolves once that ordinary scope is idle. `/stop`
is the same control under a second spelling: the parser normalizes it to the
single `abort` command before validation, the durable record, gating and
acknowledgement, so no second cancellation semantics and no second code path
exist. Other
chats' conversations, background subtrees and cron run tasks (created with
`background: true`) are untouched. Queued inputs withdrawn this way settle
`unanswered` with reason `aborted`, so their pending deliveries are forgotten
without the generic failure text, one per input; the same applies to a turn
ended by a queued reset (reason `reset`). Other settlement reasons keep the
fixed failure text.

`/status` prints bounded point-in-time metadata of **this** authenticated chat
only: the selected model and its preset, whether a turn is running (turn number
and input count) and how many native inputs are queued. A bounded background
summary follows: this chat's own live workers and its own cron jobs
(executing, queued, parked, or with a future occurrence armed) and whether the
one workspace-global memory-digestion run is live in this chat or another. A
natively blocked task is named as parked instead of counted as running;
`Background: idle` means nothing is executing or queued right now, and an armed
future occurrence is its own `Cron:` line with the next due time. It reuses the
native conversation projection the terminal uses, makes no model call, creates
no watch or timer, and includes no transcript, prompt, tool argument, thinking
content, provider error, host path, credential or other-chat data; the summary
never names another chat's ID, and the agent remains the manager of that work.
There is no chat or session selector.

`/digest` is the manual memory-digestion entry. With no argument it asks the
host for one bounded batch of already-completed turns from the shared,
already-mapped chat history (the batch may come from a different mapped chat,
because workspace memory is shared) and acknowledges only the bounded admission:
started, busy, idle or refused. It returns immediately, starts no schedule, holds
no chat turn while the digest runs. The command starts no new digest model turn itself, but it
may re-admit a retained earlier internal issue report, which is an ordinary
origin-agent turn. A digest batch
is one bounded completed-turn range, not a loop until history is exhausted; an
`idle` answer that did not reach every mapped chat's tail says closed history
may remain. `/digest status` is a bounded read-only view of the live run and this
chat's newest run; it performs no transcript scan, model call or cursor change.
Only an issue reaches this chat's agent: a failed or cancelled digest run delivers
one internal event, never a direct user or channel message, and the agent decides
what to relay. A successful run, including a successful no-op, is silent and
starts no agent turn; its outcome stays visible in `/digest status`. The retained
issue reports are bounded: a start may be refused with fixed text when 100
undelivered or unknown issues have no safely prunable slot, and `/digest status`
reports the pending count and whether a start is possible. Undelivered issues are
never evicted, and a reopen retries each admission once from the authoritative
native task. Only an authenticated allowlisted private sender can use either form.
A host without the manual entry advertises no `/digest` and refuses a typed one
with fixed text.

`/model` lists the current selection and the finite configured catalog: named
presets in named-preset mode (`/model <name>`, `/model default`), or the
read-only direct choices in legacy direct-model mode together with an explicit
"named presets are not configured" answer. It calls the host's
`listModels`/`selectModelPreset`; it invents no model registry and never rewrites
the configuration. A selection applies to this chat only: other chats keep
their own and tool authority is unchanged. Like the local CLI's preset switch it
is temporary — it lasts while this Gateway stays open, a restart restores the
configured default preset, and a request already prepared keeps its model. A
busy chat is refused atomically (nothing is queued and no change lands on a
later turn); unknown names and legacy direct configs are refused with fixed
text.

`/mcp` is the owner's decision surface for the assistant's MCP proposals. With no
argument it lists this gateway's configured MCP servers (with live state) and the
requests waiting for a decision; `/mcp show <id>` prints the exact proposed entry
— a stdio command verbatim and every header/environment mapping as a host
variable *name*, never a value; `/mcp approve <id>` writes that entry into the
gateway's configuration file or starts one owner-approved OAuth login and returns
its one-time authorization URL in the acknowledgement; `/mcp deny <id>` discards
the request. Listing and showing are bounded read-only notices with no model
call. Approve and deny are durable owner controls: they gate this chat, report a
known refusal as refused, and a replayed update finds the request already
consumed instead of applying it twice. The URL in a login acknowledgement carries
this attempt's OAuth `state`, is delivered only to this authenticated private
chat, and is never sent to the assistant or written to a transcript; open it on
a device that can reach the gateway host (a remote browser needs that loopback
port forwarded). A written entry or new grant takes effect at the next start, so
follow an approval with `/restart`. A gateway opened without an on-disk
configuration file advertises no `/mcp` and refuses a typed one with fixed text.

`/restart` asks the host to replace the Gateway process so current code and a
re-read configuration are loaded. It is not a model tool, it is available only to
an authenticated allowlisted private sender, and it affects every surface and
background job. The host performs it only after its own graceful teardown —
adapters and local clients closed, timers cleared, Harness, Code Mode sandbox and
MCP clients closed, store lock released — and only where the Node runtime can
replace the process image (`process.execve`, POSIX; absent on Windows and IBM i).
The replacement keeps the same executable, the same argv (script, `gateway`,
`--config <path>`) and the current process environment; nothing is re-discovered
from disk, and no shell respawn, supervisor or service manager is involved. The
acknowledgement confirms the **request**, not a completed restart; a failed
replacement leaves a fixed diagnostic and a stopped process rather than a false
success.

The host owns that capability: the local CLI injects it, and an SDK host that
does not gets no `/restart` entry and a fixed refusal when the command is typed.
A second `/restart` is refused while the first is stopping the Gateway, a
recovered admitted record is only reported as interrupted (never re-requested),
and the durable offset means a replayed update cannot restart it a second time.

## Attachments and local transcription

Attachment ingress is opt-in through the top-level `media` configuration (see
[setup](./SETUP.md#8-optional-attachments-and-voice)). Without it, the adapter keeps
the previous text-only behavior exactly: an attachment gets a fixed
unsupported-attachment notice and only its caption is passed as input.

With `media` configured, an authenticated private message's photo, voice/audio or
document is admitted with the input before anything is downloaded: one durable
commit records the exact caption, the attachment identity and the polling offset.
The delivery path then stores the original and submits the turn through the same
per-chat order, retry and cancellation machinery as text. A crash or failed
download keeps the admitted update instead of losing it, and a reopen resumes it.

- **Storage.** Originals are written byte-for-byte under
  `<workspace>/<media.directory>` (default `media/`) and stay readable through the
  configured coding tools. Nothing is written to `dataDir` or an arbitrary
  external root. A configured workspace root may itself be an operator symlink:
  it is resolved once successfully to its canonical path; a failed attempt can be
  retried, and every level below it is still checked individually. Filenames are
  generated from the attachment kind and a hash of Telegram's content-stable file
  identity, never from the announced filename, so a retry or replay maps to the
  same file and a re-sent file is stored once. Publication is atomic with private
  permissions, and a symlinked, hardlinked or non-regular target path is refused
  rather than followed or overwritten. Stored originals are never deleted by the adapter and there is no
  total-disk cap; keeping the workspace media directory bounded is the
  operator's job.
- **Photos** are submitted as native pi-ai image content (base64 + MIME) together
  with a labeled, workspace-relative locator and bounded untrusted metadata. The
  stored file is the authoritative original; the adapter performs no vision API
  call and no image preprocessing. Documents are **not** submitted as image
  content, whatever MIME they announce.
- **Documents** have no extraction scope: the file simply exists on disk with no
  read, OCR, PDF/Office conversion or automatic content extraction. The turn says
  so explicitly and leaves reading it to the configured tools.
- **Voice/audio** is stored first and then transcribed locally by the configured
  engine. Two explicit backends exist: the default `faster-whisper` helper
  (`scripts/local-transcribe.py` through `uv`, model `small` on CPU with `int8`)
  and an opt-in Python-free `whisper-cli` route (`media.transcription.backend`,
  see [setup](./SETUP.md#optional-python-free-backend-whispercpp)). Omit `backend`
  and the adapter behaves exactly as before; a `whisperCli` block without
  `backend: "whisper-cli"` is refused instead of switching silently. The
  transcript is bounded, labeled as automatic and untrusted user
  content, and never implies the speech was understood correctly. The caption is
  preserved. If the backend or model is not provisioned, or transcription fails
  or times out, the turn says that truthfully and the stored audio remains
  available; nothing is claimed to have been heard. Transcription is a bounded
  subprocess with a single wall-clock deadline, an output cap, an audio-duration
  refusal, and a killed process group on abort or timeout. It runs offline with
  local-model-only loading, so handling a message never installs or
  downloads anything. There is no cloud fallback, no automatic engine switching
  and no provider registry.
- **Unsupported kinds** (video, video notes, animations, stickers) are named in a
  fixed notice and never downloaded, stored or read.

The Bot API download is authenticated first: `getFile` and the streamed body run
only for an allowed private sender in a mapped chat. The request origin is fixed
to `https://api.telegram.org`, redirects are errors, and the announced
`file_path` is validated before it is interpolated into the file URL. The token
is never written to a log, error message or document. Advertised and actual bytes
are both bounded (Telegram's ordinary `getFile` ceiling is 20 MB), a download has
a wall-clock timeout, and concurrent attachment work across chats is capped so
polling is never blocked. Temporary files are removed on failure or abort.

This section does not add a general media service, a durable download queue, a
retry framework, video handling, OCR/PDF extraction, cloud speech, or a Telegram
command for media. The reverse direction is the scoped `telegram` tool's `send`
action described under
[native actions](#replies-quotes-reactions-and-native-actions): one existing
workspace file, never a download or a
subscription. The local CLI's explicit `/attach` submission is a separate
local-surface path into the same workspace media store, kept in its own
`media/cli/` subdirectory; it is path-only, so Telegram's storage location, native
photo handling and transcription are unchanged.

## Coding tools

The adapter has no tool-authority commands. The shipped Gateway's sole tool
authority is `config toolAllowlist`, which enables exactly those coding tools
for each authenticated private chat; `[]` or absent disables them. Every sender
admitted by `telegram.allowFrom` shares the configured workspace and tool
authority in its private chat. Admission is not per-tool authority, and there is
no grant, expiry, approval prompt or startup re-grant.

Tool authority comes from the configuration: editing `toolAllowlist` and restarting
the gateway (`/restart` replaces the process, re-reading the same config path) is
the only way to change it. `/tools`, `/grant`, `/revoke` and other
grant or approval commands do not exist in this adapter, and the model cannot
request or change tool authority. The same scope rules as the CLI apply: only a
validated ordinary mapped chat conversation is authorized, and scheduled
isolated runs get a captured subset bounded by the current config and origin.
See [`TOOLS.md`](./TOOLS.md#configured-authority).

Acknowledgements are ordinary channel-state pending records with `notice: true`.
They go through the same bounded chunk send, flood gate, write-ahead send intent
and unknown-outcome quarantine as model replies, and are never submitted to
Durable or the model. `/help`, `/status`, `/model` listing and refused commands
create no conversation; reading the catalog or status may create this chat's own
empty mapped conversation, which is the same mapping an ordinary message creates
and grants no other authority.

### Acknowledgement and pending semantics

A mutating control (`/new`, `/abort`, `/model`, `/digest`, `/restart`)
acknowledgement is committed **held** (`hold: true`) with the command intent, and
published once:

- the native call returns: "Context reset applied …" (with the rebuilt prompt
  and skill count when the host rebuilt it), "Abort applied for this chat: it is
  idle now. Queued messages were withdrawn and any running turn was stopped …"
  — phrased so an idle conversation is not claimed to have had a turn stopped —
  "Selected preset … for this chat: …", the bounded `/digest` admission
  (started/busy/idle/refused, never evidence text), or "Restart requested for
  this gateway … This acknowledgement confirms the request only; it does not
  confirm that the restart completed.";
- the native call proved that nothing changed (`/new` or `/model` on a busy chat,
  an unknown or unavailable preset, a legacy direct config): the acknowledgement
  is corrected to that fixed refusal; the record becomes `refused`, never
  `applied`, so a replay cannot claim a change that did not happen;
- or the call has not returned after 30 seconds: the explicit still-pending
  wording, e.g. "Abort is still pending for this chat … the provider may be
  ignoring cancellation. Queued messages stay withdrawn and new messages are
  held, never answered and never dropped, until the turn ends." No completion is
  claimed, and no second message follows when the call finally returns.

A held acknowledgement is never delivered early, and it is not tied to the input
gate: notices are never model submissions, so a released notice can still reach
the user while that chat's inputs are held, even when the reply bound is full.
`/help` and refusal notices are not held, so they can be delayed behind an
earlier acknowledgement from the same chat that is still held; that keeps a
chat's acknowledgements in admission order.

Any non-notice item of a chat with a pending command waits: nothing is submitted
to the model, so a later message cannot be admitted early and then withdrawn by
the abort it followed. If a provider never honours cancellation, that chat stays
gated until the turn ends (a restart also unwedges it, because the durably kept
messages are then submitted); other chats, polling and their deliveries are
unaffected throughout.

### Admission, durability and per-chat serialization

Admission is one commit per update: the exact input text, its pending delivery
record and the polling offset. The model submission happens from that durable
record in the delivery path (with the update's stable request ID), so a crash
before submission is recovered rather than lost, and a duplicate update cannot
create a second turn.

`/new`, `/abort` (also spelled `/stop`), `/model`, `/digest` and `/restart` are
admitted the same way and additionally record `{ updateId, command, status, chatId, senderId }` in the
`controls` log **before** the native call. While a chat's command is being
applied, that chat is gated:
none of its pending inputs are submitted or delivered, so the acknowledgement
cannot precede or overstate the effect, and a message admitted after the command
cannot be submitted early and withdrawn by the abort it followed. The gate is per
chat: polling, other chats and other chats' deliveries continue, and the command
runs off the polling loop. The command itself is not queued behind a running
turn, which is what makes `/abort` able to interrupt one.

A transient failure while a command is flushing an earlier input (for example a
media download that keeps failing) is not fatal and does not apply the command
early. The command stays admitted, the chat stays gated, its acknowledgement is
released as the explicit still-pending wording, and the same ordered flush is
retried once per poll response. A control-forced input reuses its single model
turn when it is later delivered, so it is answered exactly once. After a bounded
number of failed attempts the command is reported as unconfirmed and the gate is
released rather than leaving the chat unusable; a reopen reports any command
still admitted the same honest way. A newer command in that chat is refused
while an earlier one is still being applied or is deferred, so two commands
cannot reorder; there is no queued-command guarantee.

Per-chat model submissions keep admission order, and each chat's place is
reserved when a delivery is dispatched, before any asynchronous
`conversationFor`/`watch` work, so a slow first lookup of a real conversation
cannot let a later message submit ahead of an earlier one. Reply deliveries and
acknowledgements have separate concurrency bounds (eight each), so a full reply
queue cannot hide an acknowledgement.

Before a control is applied, every message admitted before it in that chat is
submitted, including one still parked behind that bound: the command task
re-submits them with their stable request IDs through the chat's submission
order, then applies the native call. A pre-command message is therefore
withdrawn or marked by the abort as native semantics require, never answered
after the acknowledgement; messages admitted afterwards stay gated and run later.

After the native call returns, the record becomes `applied` (for `/restart`, once
the host accepted the request), the log is pruned, and the held acknowledgement
is released. The host replacement for `/restart` is requested only after that
acknowledgement and offset are durable, and never more than once. If the process
dies in between, the next open reports the command exactly once: its held
acknowledgement is corrected to the explicit "interrupted, may not have taken
effect" wording and released, or, when no acknowledgement record is left, a
bounded report is queued for the recorded chat. `unconfirmed` and `refused` are
terminal, so later opens do not repeat them; a replayed update (possible only if
the offset was not committed) answers with the recorded outcome and never
repeats the action. An interrupted `/restart` is reported as interrupted and is
**not** requested again, so recovery cannot produce a restart cycle. The log
keeps every unresolved record and bounds `applied` history at 64 on admission and
completion, so a crash cannot evict a command whose effect is unknown. A
reported terminal (`unconfirmed` or `refused`) record is pruned once its report
is durably delivered; unresolved records are never dropped. At most 64
unresolved (`admitted`/`unconfirmed`) records are kept: further control commands
are refused with a bounded notice (nothing is executed or sent to the
assistant), so a hung provider plus a flood of commands cannot grow the log.
Refusal creates no record and no held acknowledgement. So a command is
at-most-once: it can be lost and reported as unconfirmed, but it is not
automatically applied twice in normal recovery. If an operator rolls back the
polling offset without restoring the pruned control record, that update can apply
again. No exactly-once claim is made for a native reset (Durable exposes no reset
idempotency key).

State version 5 adds bounded observed message targets and write-ahead action records.
Version 4 state migrates with empty `targets` and `actions` lists; versions 1 and 2
migrate with an empty `controls` list. Version 6 adds admitted attachment records
and the cached local transcript; earlier versions migrate with no attachments.
Version 7 adds the `refused` control status; versions 1–6 migrate unchanged.
Invalid stored shapes fail closed.

Not implemented here: tool-authority or approval commands, history commands,
`/tools`, and any command that would widen tool authority. `/stop` is only the
`/abort` alias; there is no stronger cancellation, no background-worker
cancellation and no cron mutation. A separate `/refresh` owner command was never
implemented: `/new` rebuilds the prompt as part of starting the new context, and
`/refresh` stays an unsupported command that is never advertised. Tool
authority is configured by the owner, not requested in chat: this adapter
exposes no grant or approval commands and the model cannot ask for one.

## Replies, quotes, reactions and native actions

The adapter requests `message` and `message_reaction` updates and registers the
implemented owner controls with `setMyCommands` for all private chats at startup.
Registration is best-effort: a rejection or flood wait logs one fixed warning
and leaves typed commands working; no unimplemented command is advertised.

### Host capability and the native menu

The menu and `/help` list exactly the controls this host can perform, and a typed
command outside that set is refused with fixed text instead of a silent failure:

- `/new`, `/abort` (with the `/stop` alias) and `/help` are always implemented.
- `/status` and `/model` need the host model catalog; `/model` also needs preset
  selection. The shipped Gateway exposes both; a narrow SDK gateway without them
  keeps the three base commands and gets a truthful refusal for the typed
  commands.
- `/restart` needs a host restart capability. The local CLI injects it with
  `process.execve` support detected at startup; without it the command is
  neither advertised nor performed.
- `/digest` and `/digest status` need the host manual digestion entry
  (`memoryDigest.start`/`status`). Without it neither form is advertised and a
  typed one is refused with fixed text. The shipped Gateway always exposes it;
  the run itself still refuses when this chat has no `read`/`write`/`edit`
  authority.

A test-only host that offers none of the optional host operations therefore
advertises exactly `/new`, `/abort`, `/stop`, `/help`, while the shipped gateway
with the CLI restart host advertises `/new`, `/abort`, `/stop`, `/status`,
`/model`, `/restart`, `/digest`, `/help`.

An ordinary user message keeps its existing input text (including literal `//`
handling), so literal content is unchanged. A message that replies to another
message in the same private chat is prefixed with a bounded, labeled context
block naming the current message id and the quoted message id/author; the quoted
text is JSON-quoted and marked as untrusted reference. Quoted text is never an
authorization and never creates cross-chat authority. A forwarded message adds
no authority either.

The channel-state document keeps two bounded sets:

- `targets`: recently observed message identities in each private chat — every
  admitted user message (and a quoted message) plus every bot message actually
  accepted by Telegram, with a truncated excerpt. Old targets are evicted; a
  target that is not present fails closed.
- `actions`: write-ahead records for model-requested external effects. Each has
  an identity derived from the Durable tool task id (not the provider call id),
  kind, exact chat and (for a reply/reaction) target, reply text, emoji, or the
  workspace-relative file path with its bounded caption, plus status, accepted
  chunk cursor and returned message ids.

`openGateway` creates a model-facing `telegram` tool only when `config.telegram`
is configured, and offers it only in a scope-checked mapped Telegram private-chat
conversation. It is a separate channel capability, not a `toolAllowlist` name,
and the coding-tool ceiling is unchanged. Root, channel-state, fork, raw and
task-owned cron conversations never receive it. The live adapter attaches a host
to the Gateway; if it is not running, every call is denied. At call time the
host re-derives the chat from the host-owned session key (the model supplies no
chat or session selector), rechecks durable private-chat admission evidence for
this bot, the current `telegram.allowFrom`, and target presence.

Actions:

- `targets` lists the newest observed ids in this chat. An ordinary incoming
  message's own id is reachable this way; a replied-to turn also names it in its
  context block.
- `reply` sends a native reply (`reply_parameters.message_id`) to one observed
  id. Text is chunked under the rich-message limit and delivered as rich
  markdown, falling back to plain text (see "Rich message formatting"); the first
  chunk is threaded. The turn's ordinary answer is still delivered unthreaded
  afterwards, so `reply` adds a separate threaded message and is worth using only
  when that is useful.
- `react` calls `setMessageReaction` with one emoji on one observed id.
- `send` uploads one existing workspace file unchanged: any file, whatever its
  extension or content, can be sent as a document, which is the default when
  `kind` is omitted. `kind` optionally selects a native `photo`, `audio`, `video`
  or `voice` presentation when that is useful. An optional bounded caption is
  passed through, and an optional observed `messageId` makes it a native reply.
  The path is workspace-relative; the adapter resolves it under the canonical
  configured workspace and refuses an absolute path, a `..` segment, a symlink
  escape, a non-regular file, a file larger than 20 MiB or an empty file. Bytes
  are pinned into memory before the call, so a later write or growth cannot
  change what is uploaded; a file that shrinks or grows while it is read is
  refused rather than sent as a partial snapshot. The caption is plain text (no
  `parse_mode`), so it cannot inject markup. Explicit native kinds keep a short
  extension allowlist as a capability hint (voice needs `.ogg`/`.oga`/`.opus`;
  video, audio and photo have short allowlists); nothing is converted, so a
  mismatch is refused before upload with a fixed suggestion to resend as
  `kind=document` for the same bytes. Document sends perform no content check.
  Telegram remains the format validator, and its rejection is a known non-send.
  There is no remote URL, Telegram file id, credential, arbitrary recipient,
  extraction, transcoding or automatic kind detection.

The `send` action is offered only when two operator decisions hold: the top-level
`media` configuration is present (which also supplies the channel workspace) and
`toolAllowlist` contains `read`. The same conversation already has the
configured read tool, so the upload adds no filesystem read grant. Without both,
`send` is absent from the model tool's schema and its execute path refuses a
bypassing call. The adapter behind that tool checks only the configured `media`
workspace at call time: the `read` conjunction is the model tool's authority
rule, so it never widens what a direct host caller may request. Path resolution
is workspace-only and does not use `extraAllowedDirs`.

The tool is declared `replay: "unsafe"`, so Durable never reruns an interrupted
execution. The adapter additionally writes `intent` before the call and
`sending` before the API request; a known rejection becomes `failed`, a success
records the returned ids, and any ambiguous outcome becomes `unknown`. On reopen
every `intent`/`sending` action is quarantined as `unknown`. A repeat of the same
action identity resolves to its stored record while retained and is not resent;
a mismatched chat, target or payload is denied without disclosing the old result.
Interrupted tool execution remains non-replayable even after record pruning.
Unknown outcomes are never evicted; if unresolved records fill the bounded log,
new actions are denied rather than losing reconciliation evidence. Target observation is
best-effort bookkeeping: a failed target commit can make an id untargetable but
never turns an accepted send into an ambiguous delivery.

An authenticated reaction change becomes an ordinary model turn. The update's
`user` (never `actor_chat`) must be a non-bot sender in the live allowlist, the
chat must be private with matching durable admission evidence, and the reacted
message must be an observed target in that chat; otherwise the update only
advances the offset. The turn input labels the target and the old/new reaction
lists, including added and removed emoji. Pending input and offset commit
together and use the normal submission request id, so a replay cannot admit the
same reaction twice and a crash before submission is recovered normally. The
reply to a reaction turn is an ordinary unthreaded answer.

Telegram limitations: private-chat reaction-update delivery is unverified live.
The installed Bot API type documentation requires administrator status for
`message_reaction` updates, which is not a private-chat role; requesting that
update type alone does not establish that Telegram sends it to a private bot chat.
This adapter handles authenticated updates if received; it does not promise
private-chat reaction-triggered turns work on the live service. Bot-generated
reaction events are ignored, so actions cannot start a second model loop.
Bot API sends have no idempotency
key; an ambiguous action or delivery is quarantined for reconciliation, not
retried. Outbound file uploads were validated offline against a mocked Bot API
only; live delivery, format acceptance and the service's current upload limits
are not verified here. Path resolution and open are separate host calls: a local
process racing the workspace between them is not fully excluded on this host
(Node has no `openat`), though the final component is opened with `O_NOFOLLOW`.

## Behavior

- Requires a nonempty allowlist of decimal Telegram user IDs. Only private
  messages from those IDs are admitted; groups, bots, unknown users, and
  malformed/non-text content do not create user conversations. Non-text
  messages from an allowed user are submitted as an explicit unsupported-input
  notice, not represented as content the agent has seen.
- Session keys are stable per bot ID and private chat. Request IDs are stable
  per bot ID and Telegram `update_id`. Unknown/denied updates advance the
  offset without a reply.
- A channel-state Durable document stores the polling offset and admitted
  requests, including original input, chat target, and sender ID, plus the
  bounded observed targets and write-ahead action records described above.
  Document values are copied to strict JSON inside transaction callbacks before
  they return; no revoked transaction draft escapes. Each accepted input is
  committed with its pending-delivery record and offset before any model
  submission; the delivery path submits it with the update's stable request ID. Polling does not wait for
  model completion. Pending deliveries are retried after restart, and
  re-submission uses the same request ID, so recovery cannot create a second
  turn. Recovered deliveries are checked against the current allowlist;
  revoked senders' pending outputs are discarded (a known preview is best-effort
  deleted).
- The adapter watches committed snapshots for the active input and coalesces
  partial text updates into rich `editMessageText` calls. It filters to text
  blocks only (never reasoning/thinking), explicitly flushes the final assistant
  entry after `submission.wait()`, splits output under the rich-message limit and
  bounds concurrent deliveries to eight. The remote message ID and last preview
  are stored with the Durable pending-delivery record. Previews stay inside one
  plain-sized message because they are replaced repeatedly while a turn runs.
- The poller continues admitting updates while up to eight deliveries wait on
  model or Telegram work. The eight-job limit applies only to started deliveries;
  a full durable pending queue (1000 items) fails closed before offset advance.
  Long-poll timeout is sent in seconds and the grammY request deadline is bounded
  to 60 seconds. All requests reject redirects.
- While an admitted user turn is active, the adapter sends a best-effort
  `sendChatAction` typing action and refreshes it before Telegram's short
  lifetime. One loop per chat is shared by queued turns and stops when the last
  one settles, is aborted, or the adapter shuts down. Control acknowledgements,
  unauthorized input and scheduled-outbox delivery do not type. A rejected or
  flood-gated action is skipped without retry. Typing is not awaited by model
  admission or reply delivery; Telegram rate limits still apply to the shared
  outbound gate. No typing state is stored.
- `getUpdates` has its own flood wait and bounded transport/5xx retries,
  independent of outbound calls. Outbound calls share one bot-token flood gate;
  a later concurrent deadline wins. Full finite, positive `retry_after` values
  are honored, including after a call exhausts its bounded attempts. Waits are
  abortable and have a five-minute per-call budget; long timer waits are chunked
  below Node's timer limit. Replaceable previews yield during a flood wait rather
  than queueing stale edits.
- Ambiguous non-idempotent `sendMessage` outcomes (network timeout/reset,
  in-flight cancellation, or Telegram 5xx) retain the original pending record
  with a durable `deliveryStatus: "unknown"` marker. Such records are excluded
  from automatic polling/restart resend. An explicit Telegram rejection is held
  at once and any other delivery failure after ten consecutive attempts in one
  process, as `deliveryStatus: "failed"`: the record keeps its input, is not
  resent automatically, and produces one sanitized operator warning. Bot API 429
  rejections are never quarantined, however many times they repeat: the shared
  flood gate defers the retry and the record stays retryable (a 400 or another
  non-flood rejection is still permanent). Only narrowly proven pre-connect failures
  (`ENETDOWN`/`EHOSTUNREACH`) are automatically retried as no-send outcomes.
  GrammY error descriptions/causes and raw response bodies are not surfaced or
  logged. A terminal unanswered model submission sends the fixed message
  `Your request could not be completed.
  Please try again.`, except an intentional native settlement (`aborted` after
  `/abort`, or `reset` when the `/new` reset ended the turn), which is forgotten
  silently because the user asked for it; empty text answers also get a fixed
  user-visible response.
  Polling errors other than cancellation terminate `runTelegram` for the host to
  handle.

## Rich message formatting

Bot API 10.1 rich messages carry the answer as markdown instead of one more chunk of plain text,
so headings, lists, tables, code and links render as the agent wrote them and most turns are a single
message.

- Ordinary replies, scheduled cron deliveries, live previews and their final edits all use
  `sendRichMessage` with `rich_message.markdown`, or `editMessageText` with `rich_message` for
  in-place edits. No `parse_mode`, no markdown→HTML conversion, no second formatting authority.
- Rich chunking normally uses the 32,768-character budget, cuts on a line then a word boundary and
  preserves whitespace and surrogate pairs. A cut inside a ``` fence closes and reopens it unless
  its header exceeds a quarter of the chunk budget; oversized headers are cut raw to bound output
  amplification, so their formatting may not survive the split. When an existing preview must be
  edited, final chunks instead use a 4096-character budget so a rejected
  rich edit can fall back to plain text without losing the rest. The chunk plan is recorded before
  delivery and remains stable if capability changes or the gateway restarts; an older in-flight
  cursor without a plan continues with the original 4096-character chunking.
- Host-generated notices (status, help, digest status, control acknowledgements) are escaped so
  paths, ids, `<placeholder>`s and `*` selection markers render exactly as written; an underscore
  between two alphanumerics is left bare, and an escaped character renders as the bare character.
- Two rejections are proven non-sends and fall back to plain text: a server without the method
  (404/`method not found`/`invalid parameter`) latches rich off for the rest of the process, and a
  refused body (`can't parse`, `unsupported start tag`, `message is too long`, `rich_message`)
  resends that chunk as plain text split under the 4096-character limit. Every other rejection and
  every ambiguous outcome keeps the existing semantics: held, never blindly resent. The plain
  fallback is all-or-nothing per chunk — after any part is accepted, its write-ahead intent remains
  until the whole chunk settles. If a later part fails or the process crashes, the record is held as
  an ambiguous outcome rather than resent. Each acknowledged plain part is observed under its own
  message ID and actual text; native reply actions also record every returned ID.
- `sendRichMessage` is in the ambiguous-send method set, so a 5xx or transport failure is `unknown`
  like any other send.
- Attachment captions stay plain text with no `parse_mode`, and media is sent through the upload
  actions, not as rich media blocks.

Live acceptance is outstanding: offline checks cover the request shapes, chunking, latching and
fallbacks against a mocked Bot API, not the live service accepting rich bodies or a client rendering
them. A model-written markdown image or video reference is resolved by Telegram's servers, not this
adapter.

## Adapter lifecycle and Telegram edit recovery

Each run derives a local cancellation scope from the caller context. Fatal
polling/admission exits stop new delivery scheduling, abort adapter-owned
requests, watches, preview work, and submission waits, and reap active deliveries
before returning. Cancellation of `submission.wait()` only stops this adapter's
waiter; it does not abort the Durable model work. Pending delivery records remain
durable for restart recovery. Preview updates use one in-flight operation plus a
latest-value coalescer; a flood wait skips replaceable previews rather than
retaining stale calls. The channel-state document checkpoints its delta chain
after 64 deltas using Durable's `CheckpointInfo.deltasSinceBase`. Schema version 5
combines durable sender-to-chat admission evidence (`origins`) with controls,
the next-final-chunk cursor, write-ahead send intent, unknown-delivery metadata,
bounded observed targets and write-ahead action records. Version 4 state migrates
with empty `targets` and `actions` lists; version-1 and version-2 state migrate
with an empty `origins` map; version 1 resets
the chunk cursor, and version 2 preserves it. Pending replies are kept, and no sender
binding is inferred from a chat ID. Prior
queued cron results remain in the outbox as nonterminal `withheld` records until that private chat
admits one fresh message, which restores the binding and releases them; they are not failed or
discarded.

Downgrading to a pre-`withheld` outbox reader can fail held deliveries; upgrades must be forward-only.

Successful final chunks are committed before attempting later chunks, so an
explicit later rejection does not resend known accepted earlier chunks. Required
outcome/progress commits use an uncancelled cleanup context and are reaped before
return.

A grammY 400 `message is not modified` error is treated as success for the exact
short description or a bounded detailed description with that exact prefix
followed by `: `; this classification applies only to `editMessageText`. An exact
`message to edit not found` error clears stale preview metadata and sends a
replacement. Other 400 errors remain failures. See `THIRD_PARTY_NOTICES.md` for
policy provenance.

## Delivery boundary and current limitation

Telegram `sendMessage` has no idempotency key. Durable input request IDs do not
make external sends exactly-once. Observed ambiguous send outcomes are now held
for operator reconciliation rather than blindly resent (an intentional behavior
change). Before dispatch, the pending record stores `deliveryStatus: "sending"` plus the
exact intended text, stage, chunk index, and timestamp. Success atomically clears
that intent and records the returned message ID / accepted chunk cursor. Known
rejections clear the intent; unresolved intents after a crash reopen as unknown
and cannot auto-resend. This deliberately favors reconciliation over blind
at-least-once retransmission; it does not guarantee delivery or exactly-once.
No plaintext sidecar is used.

The adapter emits a fixed, sanitized operator warning containing only update ID
and stage when it marks a send unknown. Inspect the existing channel-state
conversation (`telegram:<bot-id>:channel-state`) with the Durable SDK and the
exported `TelegramState` document token. Each pending item retains input, target,
`nextChunkIndex`, `deliveryStatus`, `sendIntent` (exact intended text/stage/chunk),
`unknownStage`, `unknownChunkIndex` (for final output), and timestamp, plus
`notice: true` for a control acknowledgement that is never a model reply and
`hold: true` while that acknowledgement waits for its native call. Stop the adapter before reconciliation. After checking
Telegram independently, reconcile in one Durable transaction:

- If accepted, record the returned message ID / accepted final-chunk progress,
  then clear `sendIntent`, `deliveryStatus`, `unknownStage`, `unknownChunkIndex`,
  and `unknownSince` atomically. Removing an already-complete record is also valid.
- If confirmed unsent, preserve `nextChunkIndex` and known message metadata, and
  clear those same five fields atomically to permit recovery from the cursor.

Leaving `sendIntent` behind will quarantine the record again on reopen. Never
clear these fields without resolving the external outcome. A `failed` record is
recovered by clearing `deliveryStatus` (it is a known non-send, not an ambiguous
one), after which normal delivery can resume. A retry command/UI is outside this
batch.

The `telegram` action tool has the same external-send limitation. Its durable
`actions` records make the intent and outcome inspectable and prevent automatic
resend, but they cannot make a native reply or a reaction exactly-once. A
multi-chunk native reply records the accepted message ids and chunk cursor; a
crash mid-sequence is quarantined as unknown rather than continued blindly. An
operator reconciles it like a pending delivery: check Telegram, then update the
record. There is no automatic action retry or action command/UI.

## Offline control probes — 2026-10-29

No bot, credential, network or real model: the adapter was driven against a faux
Durable Harness over generated temporary JSONL stores with a mocked `fetch` in
throwaway directories, with prompts answered by content rather than call order,
plus one case on the real `openGateway` (generated workspace and data directory,
faux provider) where the first chat lookup is deliberately slowed. Checks passed:
allowlist-before-control (denied sender and group `/new` ignored, no reply, no
conversation); `/help`, unknown and argument-refused commands answered without a
conversation or a model call; `/new` and `/new@this_bot` writing exactly one
`pi.reset` entry; `/new@other_bot` refused with a notice instead of reaching the
model; `//new` reaching the model literally; `/abort` admitted only after the
current turn was running, withdrawing its queued pre-command input, preserving
and answering a post-command message, cancelling the abandoned provider call (its
late result never delivered), suppressing the generic failure reply, and leaving
another chat's answer untouched while polling continued; a `/new` acknowledgement
released after native admission; a replayed and a reopened interrupted command
each reporting the unconfirmed effect without a second reset and without repeating
the report, then pruned once delivered; a known-rejected delivery held after one
attempt, not resent across a full reopen; a flood-limited (429) delivery retried
across its cooldown and never quarantined; a malformed mention refused without
reaching the model; version-1 and version-2 state migrating to the control-aware
shape; a
provider that ignores cancellation (the poll kept serving another chat, the chat
stayed gated, the acknowledgement said the abort was still pending, the later
message stayed durably unsubmitted and then ran once released, and no completion
was claimed); `/new` during a gated tool round landing at Durable's boundary after
the tool result, with no failure text and a message queued before it running in
the new context; the real Gateway keeping per-chat submission order (first,
second, third) despite a slow first `conversationFor`, then closing and reopening
the same store and mapped conversation without repeating an earlier turn; a full reply bound with a
pre-command message parked behind it, which was submitted before the abort and
never answered after the acknowledgement; consecutive `/abort` then `/new`
applying in order with one acknowledgement each; 70 applied plus 60 interrupted
control records, where every unresolved record survived, each was reported
exactly once, and only applied records were pruned; and a hung abort followed by
70 `/new` commands, which kept the unresolved log at its bound, refused the
excess with a bounded notice, and reported every remaining record exactly once
after a reopen.

## Scheduled cron delivery

The adapter also consumes the durable, channel-neutral cron outbox
(`nanobot.cron.deliveries` in the origin chat conversation). A normal settlement, isolated or
origin, writes the text to send there in the same terminal commit as its outcome: the committed
final answer, or fixed sanitized notice text for a failure or empty answer; no model turn is
rerun to resend. On startup and every few seconds the adapter enumerates already-mapped chat sessions and
accepts only candidate keys for its own bot ID (`telegram:<bot id>:chat:<chatId>`). That key is a
locator, not authentication: before any send the adapter requires durable admission evidence for
that private chat, written before the message was mapped or submitted. The evidence records the
admitting bot ID, `chatType: "private"`, and the original authenticated `senderId`. The adapter
rechecks that original `senderId` against the live `allowFrom` list. It never equates `chatId`
with the sender and never treats the session string or a model-provided value as proof of identity.
If the evidence is missing, inconsistent, for another bot, or not private, the result enters a
nonterminal `withheld` state with no send. A fresh authenticated admission for that private chat
restores/refreshes the binding and returns the withheld records to `pending`; a cap eviction or a
migrated store therefore causes delay, not permanent loss. A valid binding whose sender is no longer
allowed settles `unauthorized` with no send and is not released by a later admission. Admission
evidence is bounded (1000 origins per bot): every valid admission refreshes `admittedAtMs`, and an
eviction is surfaced through a deduped sanitized fault and warning rather than silently hiding the
lost binding.

Scheduled sends share the bot flood gate, rich-message chunking, chunk cursor, write-ahead
`sendIntent`, and bounded retries with inbound replies. Network writes for one chat are serialized
in request order, and only one scheduled record per chat is active at a time. That prevents
overlapping network calls and scheduled-record reordering, but it is not a whole-message lock: the
chunks of a multi-chunk message can interleave with another same-chat send between chunks.

Delivery state lives on the outbox record, not only in this process: `pending`, `sending`,
`unknown`, `withheld`, `delivered`, `failed`, or `unauthorized`, plus `nextChunkIndex`, `messageId`,
`sendIntent`, `unknownSince`, `withheldSince`, `settledAt`, and a sanitized `error`. An unresolved intent at open
becomes `unknown` and is never auto-resent; an explicit rejection becomes `failed`; 429 and proven
pre-connect outcomes stay pending for a later scan. Every normal settlement is queued: a
successful answer's committed text, or fixed notice text for a run error or an empty answer. A
notice names only the job id and occurrence instant and asks the owner to list scheduled jobs; no
provider error, job message or model text is copied. Cancellations, superseded, fenced and
missing-job runs remain silent externally and are visible through cron `lastOutcome`/`list`. If the channel is
absent from the configuration, no record is created; an existing record is never redirected to
another chat or channel. The outbox is bounded (1000 records per origin, 200 terminal records
retained) and never evicts pending or ambiguous records. A full outbox does not queue the new result
and records a durable sanitized fault; the run still completes. A stored outbox whose `deliveries`
value is not an array, or whose entries are not understood, is left untouched and surfaced the same
way instead of faulting the run. Cron `list` shows the newest fault as `last delivery fault`; the
operator document is `CronDeliveryFaultsDoc`.

A malformed individual outbox record is quarantined, never sent. If it has a usable ID the adapter
settles it `failed` with a fixed reason such as `delivery record has no text`; without a usable ID,
or when the whole document cannot be read, the adapter writes a sanitized entry to
`CronDeliveryFaultsDoc` and logs a fixed warning. Repeated scans dedupe the same fault and make no
outbound request. Raw error text, provider text and record contents are not logged or persisted as
the reason.

An origin-mode successful answer uses the same record, authorization and send path, so it reaches the
same authenticated private chat while remaining the origin conversation's answer for a locally
attached CLI. Delivery text is the committed answer entry of the scheduled submission; no duplicate
ordinary reply is produced, because the adapter sends only records from this outbox for work it did
not submit itself. When native admission batches several inputs into one run they settle on the same
answer entry, so a batched answer can describe more than the scheduled message.

Reconciliation for scheduled records uses the origin conversation's `CronDeliveriesDoc` token rather
than `TelegramState`. Stop the adapter first. If Telegram accepted the exact intended text, advance
`nextChunkIndex`/`messageId` and settle `delivered`; if it was confirmed unsent, clear `sendIntent`,
set `status: "pending"`, and preserve the chunk cursor. Never clear an unresolved intent without
checking Telegram, and never expect exactly-once external delivery.

## Offline integration probe

No live bot or credentials were used. A private temporary copy of the parent
probe imports this checkout's module, uses a faux Durable Harness/persistent
JSONL storage, and mocks `fetch` (the shared probe was not modified):

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
timeout 220s node --max-old-space-size=512 --experimental-strip-types /tmp/tgprobe/pi-e078edd8-followup.mts
```

All actual-adapter mock-fetch probes passed: baseline recovery/requestId dedupe,
allowlist/group rejection, reauthorization, Unicode splitting/final flush, and
eight-active-delivery polling; fatal polling with a fresh blocked-model gate and
pending-record verification before/after exit plus model continuation and output
delivery after reopen;
cancellation during a blocked partial preview with no post-return work; 35-second
`retry_after` with no early retry and prompt abort; concurrent 429s across eight
deliveries respecting the shared bot-wide deadline; final 429 cooldown retained through five-attempt
exhaustion and later delivery re-entry; short and detailed not-modified
responses after simulated accepted/lost edits; and deleted-preview replacement
with final flush. Additional checks passed version-1 state migration, ambiguous
5xx send persisted as unknown and not retried after reopen, proven ENETDOWN retry,
and first-chunk progress retained after a later explicit rejection. In-flight
send cancellation now intentionally records unknown instead of resending.
Every mocked `sendMessage` inspects the actual Durable document before remote
acceptance and asserts `deliveryStatus: "sending"`, the exact intended text, and
preview/final stage. Accepted-send/lost-response also proved one network send across polling and
full storage reopen. A seeded unresolved persisted intent reopened as unknown,
retained its exact intended text, and made no outbound request. All mocked
requests assert the fixed HTTPS origin and `redirect: "error"`.

Parent integration independently passed the full probe against the integration
checkout and also ran an actual subprocess SIGKILL-after-mocked-acceptance check
using the SQLite gateway. The mock inspected committed exact-text intent before
recording remote acceptance; after SIGKILL and full reopen, state was unknown,
the intended text remained available, and no retransmission occurred. This checks
our local crash boundary with mocked Telegram, not delivery over Telegram's network.
No live bot or paid model call was used in the offline probes above. External
sends remain unknown at an ambiguous boundary and require reconciliation, never
an exactly-once claim.

Scheduled-delivery probes (temporary and uncommitted) used the real Gateway and
adapter with a faux provider and mocked Telegram transport in fresh `mkdtemp`
stores. They covered end-to-end background-result delivery, full reopen without a
second send, unresolved intent reopening as `unknown`, a live-revoked binding
settling `unauthorized`, a mapped chat with no durable admission binding entering
nonterminal `withheld`, same-chat ordering with no overlapping network writes,
chunk cursors, an explicit rejection, and the disabled-channel boundary. State
probes covered a 1000-binding cap: the next admission evicted the oldest binding
with an observable sanitized fault, the evicted origin's result stayed `withheld`,
and a fresh authenticated admission restored the binding and delivered once. A
stored version-2 state migrated with an empty binding map; a prior queued result
became `withheld` without a fault flood and was restored by a fresh admission.
Corruption probes covered a stored `deliveries` value that was not an array, a
malformed pending record with and without a usable ID, and a reopen/recurring run:
the terminal run still completed, invalid data was left untouched, malformed
records were quarantined or surfaced in the fault document with fixed reasons, and
no outbound request was made. No permanent test, live bot, credential or network
request was involved.

## Live smoke check — 2026-10-26

Owner-authorized sole polling with private credentials outside the checkout and
an explicit numeric sender allowlist exercised the real Telegram API. A scripted
streaming faux model produced the reply (no paid LLM request). The owner confirmed
the final response with a screenshot; API observations recorded one sendMessage
and four editMessageText successes, including final text.

The temporary runner's auto-pass observer did not fire, so parent stopped polling
cleanly and independently reopened its isolated SQLite store. The SDK check found
one user/assistant turn, no pending output, no enabled tools, and only faux model
usage. This proves the real Telegram/Durable streaming path, not production
readiness, execution confinement, or real-provider compatibility. No credentials
or private transcript contents were added to the repository.

## Synthetic real-model pilot — 2026-10-30

After fixing the grammY/native-fetch signal mismatch, a first five-minute window
expired unused. A later owner-approved window used a disposable workspace/store,
one allowlisted user and the real DeepSeek Flash model. Telegram accepted 11
typing actions, five new messages (including a control acknowledgement) and one
edit. The owner reported that the replies worked well.

Paused, no-dispatch inspection of the closed store confirmed a skill load, topic
memory write, one reset, successful history search/open calls and a cron list.
The pilot stopped at its four-prompt guard when a fifth message arrived, before
that last request was admitted—not at the time limit. No cron job was created,
so reminder scheduling/delivery is **not** a live pass.

The run used 11 model requests, reserved 201,609 conservative input-token
equivalents and 16,896 output tokens, with no budget violation. It closed with
no pending replies. No webhook change, pending-update clearing, real workspace,
deployment or security audit was performed. The owner accepted this pilot as
sufficient and deferred the optional reminder-only follow-up. Live reminder
delivery remains unverified; the current bot process is stopped.
