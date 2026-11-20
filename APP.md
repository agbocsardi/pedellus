# App channel (installable web app)

The `app` adapter is opt-in, adds no tool authority and runs inside the same gateway process as
the CLI, Telegram and Discord. It serves the built PWA from `pwa/app/dist`
over one loopback HTTP+WebSocket listener; `tailscale serve` publishes it on the tailnet with the
node's `*.ts.net` certificate. The wire contract is protocol v2, normative in
`pwa/protocol/v2.md` and `pwa/protocol/v2.ts`. Ship the v2 app and gateway together: the
unchanged `/v1/*` URLs accept wire version 2 only. `src/channels/app-protocol.ts` takes the
shared limits, close codes and hello/thread shapes from `src/channels/generated/protocol-v2.ts`
(a generated mirror of `pwa/protocol/v2.ts`, refreshed by `npm run build` and checked by
`npm run typecheck`) and adds the gateway-only bounds and pure validation;
`src/channels/app-listener.ts` owns transport mechanics (sockets, bodies, cookies, MIME types,
path safety); `src/channels/app.ts` owns admission, the durable event log, controls, pairing and
the operator console; `src/channels/app-files.ts` owns uploads, their durable records, attachment
context and the download lookup; `src/channels/app-tool.ts` is the model-facing `app` file tool,
whose live host the adapter attaches.

Status: offline-verified only. No tailnet, `tailscale serve`, real device, installed PWA or live
pairing has been exercised in this repository. The first deployment is a supervised trial.

## Configuration

Add an `app` block to the explicit configuration file. Absent means no app code, dependency or
listener is loaded.

```json
{
  "app": { "port": 43190, "staticRoot": "/home/owner/deploy/durable-pwa/dist" }
}
```

| Key | Meaning |
| --- | --- |
| `port` | Required explicit integer 1–65535. The listener binds `127.0.0.1` only; no other bind is configurable, and `tailscale serve` is the only publisher. Never Funnel, port forwarding or a wildcard bind. |
| `staticRoot` | Required absolute directory holding the built PWA. Files are served with safe path resolution (no traversal, no directory listing, encoded separators are not structure), correct MIME types and `index.html` for the root; `sw.js` is always served `no-store`. |
| `autoArchiveDays` | Optional integer ≥1, default 14. Automatically archive inactive side threads, but never while they have running or queued work. |
| `agentName` | Optional agent display name, 1–40 printable characters, default `Durable`. Sent as `agent` in every `hello` reply; display only, no authority. |
| `push` | Optional Web Push block: `{subject, publicKey, privateKeyEnv}`. Absent (or a private key variable that is unset at start) leaves every `push.*` request `unsupported` and sends nothing. `subject` is a `mailto:` or `https:` contact, `publicKey` is the base64url uncompressed P-256 VAPID public key, and `privateKeyEnv` names the environment variable holding the private key — the key itself is never in config. |

Uploads and attachments are the existing top-level `media` opt-in — the same block Telegram uses —
not a new `app` key: with it configured, `hello.uploads` is `true` and originals live under
`<workspace>/<media.directory>/app`. Without it the app has no upload surface at all.

The block is strict: an unrecognized key is refused at startup instead of being ignored, like the
Discord block. The listener ignores Tailscale identity headers by construction: any local process
can reach the loopback port and forge them, so the device token is the only authority.

## Setup

```sh
# On the tailnet host, with the built PWA checked out and `npm run build` run there:
durable-nanobot gateway --config config.json
tailscale serve --bg 43190
```

`tailscale serve` terminates TLS and proxies to `127.0.0.1:43190`; HTTPS is required for service
workers and Web Push on the device. The app and the API share that origin, so no CORS exists.

Web Push is optional. Generate one VAPID key pair from the owner's terminal (no gateway, config or
file is involved; the pair is printed once and written nowhere):

```sh
durable-nanobot app push-keys
```

Put the private key in the gateway's environment file (never the repository) and reference it by
name in the config:

```json
{
  "app": {
    "port": 43190,
    "staticRoot": "/home/owner/deploy/durable-pwa/dist",
    "push": {
      "subject": "mailto:owner@example.org",
      "publicKey": "<the printed public key>",
      "privateKeyEnv": "NANOBOT_APP_PUSH_PRIVATE_KEY"
    }
  }
}
```

The private key is read once at gateway start. A missing or malformed variable disables push with
one terse startup diagnostic naming only the variable; the rest of the gateway starts normally.

Pair a device from the owner's terminal:

```sh
durable-nanobot app pair --label iphone     # prints one 8-character code, valid ten minutes
durable-nanobot app devices                 # labels, created times, revoked state
durable-nanobot app revoke iphone           # closes the live stream; the token is dead
```

These commands attach to the running gateway over the private local socket, like the `cron`
console: the running adapter owns every decision (label uniqueness, device limit, revocation), and
this process only parses flags and prints the bounded answer. A label is printable 1–40
characters; `pair` refuses a label already in use by an active device or an outstanding code, and
without a label the code accepts whatever label the device sends at pairing (one not already used
by an active device), while with one the device must send exactly that label. Revoke is exact-label.

## Pairing and devices

`POST /v1/pair` exchanges one console-created code for a device token. The code is 8 characters
from `[A-Z2-9]` minus `I`/`O` (case-insensitive input), single-use, and expires after ten minutes.
Only its hash is stored. The token is long and random, exists only in the `durable_device` cookie
(`HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=34560000`, the 400-day lifetime the protocol
requires because iOS drops session cookies when a home-screen app closes) and only its SHA-256
hash with the label and
created time is stored durably in the app channel state — the same file-based trust boundary as the
provider credential store. A console-created label must match at redemption when one was given.
More than five pairing failures in one minute across all clients refuse the next attempt with
`429 rate_limited`; the window is rolling and in-memory, so a gateway restart clears it. At most 16
devices are retained; further pairing is refused until one is revoked. At most 8 outstanding codes
exist; expired ones are pruned on every access.

`GET /v1/stream` always completes the WebSocket upgrade and then closes with `4401` when the
cookie is missing, unknown or revoked — so the app can tell an authentication failure from a
network failure. A second stream for the same device closes the older one with `4409`. Protocol
violations (bad JSON, unknown op, a non-`hello` first request, an oversize frame) close `4400`; a
wrong protocol version closes `4426`. A later `hello` on an open stream is answered normally and
replays again from its cursor — the app fetches the next 500-event batch that way.

## Session and authority

Every paired device shares the same threads. `main` keeps its `app:chat` session and history;
retained v1 events and pending work without a thread belong to `main`. Side threads use host-assigned
IDs and host-derived session keys. They start empty unless `thread.create {from: {thread, messageId}}`
forks a validated open app chat at a committed message; admission resolves that message to a
typed committed transcript entry equal to the native fork cutoff, per exact session key, at
creation and reopen. The fork inherits only the context through that message, records `origin`,
and receives the same ordinary chat policy. A queued echo, host notice, or isolated cron reply
has no entry in that chat and cannot be forked. No other kind of fork receives chat authority. There is no per-device conversation. The registry and log live in the
`app:channel-state` conversation (`nanobot.app-state`), never in a plaintext sidecar.

`threads` returns `main`, every open thread and the 200 most recently active archived threads,
newest activity first. With `query` (1–80 characters), it returns up to 200 case-insensitive title
substring matches, including older archives, newest first. `thread.create` defaults to `New thread`
and remembers its key for at least seven days; titles are 1–80 printable characters.
Manual archive aborts the thread's turn and records `archivedReason: "manual"`. The idle scan
records `"idle"` without aborting work. Archive does not delete history, cancel schedules, or reset
the episode; the separately configured idle rollover still runs under its own safeguards.
An archived thread refuses `send` and `control` with `bad_request`. Restoring clears the reason
and counts toward the 50-open-side-thread limit. `main` cannot be renamed or archived.
Lifecycle changes append durable `thread` events.

The adapter grants no tool: coding tools, MCP, web, cron, memory and worker authority are whatever
the configuration already gives that mapped chat. Its one model-facing tool is the `app` file
capability above (*Files*), which grants no coding authority, returns no file content to the
model, and reaches only the thread the model is already answering. The app chat **is** an MCP
login owner surface for its own open threads: the one-time authorization URL goes to the devices
streaming at that moment as a non-durable `login` event, never into the durable log, channel
state or a push, and a completion is one fixed notice in that thread (protocol v2, *MCP login*). A login
attempt stays bound to the adapter instance that delivered it: after an app adapter restart, a
pasted callback for it is refused with fixed text and its completion notice is dropped (the
browser's loopback callback still completes it, and `/mcp` shows the result).
A callback-shaped `send` is intercepted before admission and offered to the login lifecycle; only
the lifecycle's fixed notice is stored, and the callback text itself is never stored. It is also an
owner-question surface for the model's `ask_user` capability (see *Owner questions*).

## Fork admission

Only an ownerless fork created by the app channel's `thread.create {from}` from a validated,
open app chat may be admitted as an ordinary mapped chat, and only under its own exact
registered app session key: at ingress and at reopen the gateway resolves the fork's recorded
app message in the conversation its native parent names to a committed user or assistant
transcript entry and requires it to equal the native fork cutoff at every hop of a
fork-of-fork chain, with each hop's durable enrollment, exact session mapping and parent
cutoff agreeing; the enrollment record is the authority, and the registry's displayed
`origin` is metadata. It gets the source chat's ordinary policy, not inherited grants
or new authority. Every other fork remains denied, and the exception is never
conversation-wide: a key naming anything but an ordinary chat or a validated enrolled
app fork is refused at ingress, before it can become a cron owner or receive chat policy.

## Protocol and delivery

Requests are `{"type":"req","id","op",...}` with exactly one `{"type":"res","id","ok",...}` reply;
fixed error codes only, never free text. Frames and request bodies are bounded at 262 144 bytes;
`send.text` at 16 000 characters (an over-bound text is the fixed `too_large` error); ids and
keys at 1–64 characters of `[A-Za-z0-9_-]`.

Durable egress is one adapter-wide cursor log — `message` (roles `user`, `assistant`, `notice`),
`settled`, `divider`, `thread` and `question` — across all threads. Each event names its thread; lifecycle
events carry its full metadata. `hello` replies with the protocol version, the device label, the
durable head cursor, the configured agent display name (`app.agentName`, default `Durable`) and
`commands` (the shared catalogue's `app` surface this host implements, in catalogue order), and replays
events with `cursor > hello.cursor` (oldest first, at most 500 per batch; the app re-`hello`s for
more), live sockets are pushed every event after their own position, and `ack` records each
device's highest stored cursor, clamped to the current head. Replay is idempotent by cursor on the
client, so delivery is at-least-once and the cursor is the dedupe identity. After replay, the
adapter sends `status` for `main` and all other threads with non-idle app turns. `send` and
`control` default to `main`. Previews and status are independent per thread. Previews are bounded to
the same frame budget with a tail-safe prefix of the streamed text; the final message carries the
whole answer. Retention trims events acknowledged by every
active device, then a hard cap of 2 000 keeps the newest; a `hello` below the retention floor
replays from the floor, so a device that acks never sees a gap, and one that returns after the cap
was exceeded has an irreducible hole (the app refetches nothing; phase 2 push mitigates this).

A durable `message` whose frame would exceed 262 144 bytes is stored as up to 64 parts sharing one
id, thread, role, `at` and `key`, each with its own cursor and `part: {i, n}` (protocol v2, *Long
messages*). The split measures each part's escaped JSON bytes, never cuts a UTF-16 surrogate pair,
and keeps every frame inside the limit; the app joins the parts in `i` order and `settled` follows
the last one. Parts are ordinary cursor events, so a replay batch may end mid-message and the app
shows what it has until the next batch. *Known bound:* a text that would need more than 64 parts
(about 16 MB escaped) keeps its leading parts and truncates the last, marked `[truncated]` and
reported once with a `console.warn` naming the event id; the full text is still in the transcript. Parts are ordinary events for retention, so trimming at the ack floor or the event cap can drop
the leading parts of a message a device never stored; that device then shows the rest as incomplete.

This is the app-channel reconciliation of Telegram's held-unknown boundary: Telegram's external
sends have no idempotency key, so an ambiguous outcome is quarantined and never resent. The app's
"send" is a durable local commit, and its retransmission path is cursor replay, which is exactly
idempotent — so no write-ahead intent or unknown-outcome quarantine exists, and none is needed.
Everything else follows the Telegram adapter, the delivery-semantics reference: admission before
submission with a stable request id (`app:send:<key>`), a repeated `send` key answered
`duplicate: true` with nothing admitted (keys are remembered for seven days by time-based
pruning, and a key whose echo is still in the event log stays a duplicate even then — no re-used
key can ever leave a second echo), the shared-answer retirement of steered inputs, control records
with held acknowledgements, gating, applied/refused/unconfirmed outcomes and unconfirmed reporting
at reopen.

Ordering for one turn: `message{role:"user",key}` at admission, `status`/`preview`/`activity`
(non-durable, replaced by the next) while it runs, `message{role:"assistant",key}` and one
`settled{key}` per consumed key. A failed run settles each consumed key `failed` individually (failures are never
grouped by error text); an abort or `/new` reset settles `aborted`. An empty answer is replaced by
a fixed notice. `followUpMode: "steer"` submits with native `whenBusy: "steer"` under the same
owner-run check as Telegram.

## Activity steps

While a turn runs, the adapter derives its tool steps from that run's committed transcript entries
and sends non-durable `activity {thread, key, steps, omitted?}` whenever they change, coalesced
like previews. An assistant `toolCall` starts a step and the `toolResult` carrying the same call id
ends it `done`, or `failed` when that result is an error; both times are the entries' own. A step
carries only its id, the tool name (bounded to `LIMITS.activityToolChars`), its state and its times
— never arguments, results, file paths or error text, so nothing a tool was handed or returned can
reach channel state or a socket. The list is bounded to `LIMITS.maxActivitySteps`: the first
`maxActivitySteps - 1` steps and the newest one are kept, and `omitted` counts the rest. Only the
run's first input publishes activity, exactly as for previews. The final assistant `message`
carries the same bounded list as `steps` and `omitted`, on its first part only when it is split; a
turn without tools carries neither, and `settled` ends the live list. The transcript remains the
only place a tool's arguments, output or errors are kept.

## Files

Uploads, attachments and downloads follow protocol v2's *Files* section and are available only when
the top-level `media` block is configured: then `hello.uploads` is `true`, `POST /v1/upload` accepts
originals and `send.attachments` attaches them. Otherwise the app hides the attach control, an
upload is the fixed `400 unsupported`, and a send naming ids (which cannot exist) is `bad_request`.

- **Upload.** `POST /v1/upload` is cookie-authenticated exactly like the stream. The body is the raw
  bytes (no multipart); `Content-Type` is the announced type and `X-Filename` the percent-encoded
  UTF-8 original name, 1–120 characters after decoding. The listener streams the body straight into
  the shared media store with a hard `LIMITS.uploadBytes` cap: an advertised length over the cap is
  refused before a byte is read, an actually-received body over it is aborted and answered `413`,
  and nothing is buffered whole. `201 {"id":"f_…"}` is answered only after the record is durable;
  `400 bad_request` (missing, oversize or undecodable name; empty file), `400 unsupported`,
  `401 unauthorized`, `413 too_large`, `429 rate_limited`.
- **Storage.** Originals are written byte-for-byte under `<workspace>/<media.directory>/app`
  (default `media/app`), a code-owned child of the operator's media directory, with the shared
  store's atomic publication, private permissions and symlink refusal. The path is derived from the
  random upload id, never from the announced name; the announced type only picks the locator's
  known extension, and an unknown type is stored as a generic original. Nothing is sniffed and
  nothing is written to `dataDir`. Stored originals stay ordinary workspace files the configured
  coding tools can read, like Telegram's.
- **Pending records.** One durable document next to the channel state holds
  `{id, deviceId, name, type, size, kind, path, createdAtMs}` per upload, plus the reference once a
  message used it. An upload is private to the device that made it and unusable until an admitted
  `send` references it; an unreferenced upload older than 24 hours is discarded — record first,
  then file — by the adapter's scan (the work is throttled to once a minute). Gateway-only bounds:
  at most 200 unreferenced uploads per device and 4 000 records in total, both answered
  `429 rate_limited`; `LIMITS.uploadsPerMinute` is a rolling per-device window held in memory, so a
  restart clears it (like the pairing window). Referenced records and their files are kept, because
  a message that showed a file must stay downloadable.
- **Attach.** `send.attachments` lists up to `LIMITS.maxAttachments` upload ids from this device,
  each used at most once; `text` may then be empty. The claim runs inside the same durable commit
  as the echo, the idempotency key and the pending input: an unknown, foreign, expired or reused id
  refuses the whole send with `bad_request` and records nothing — not even the key, so the upload is
  still usable afterwards. A repeated `send.key` stays `duplicate` and claims nothing.
- **Echo.** The admitted user `message` carries `attachments: AttachmentInfo[]` (`id`, bounded
  `name`, announced `type`, `size`, and `kind` from the announced type only) in send order, on the
  first part only when the message is split.
- **What the agent sees** is exactly Telegram's media handling: the send text, then one labeled
  block per attachment with the bounded untrusted metadata and the workspace-relative locator;
  images are additionally submitted as native image content (base64 + announced type, no vision
  call and no preprocessing); audio is transcribed locally when transcription is configured, and
  says so truthfully when it is disabled, fails or times out; documents are never extracted, and
  their block says so instead of implying the file was read. A missing stored file is reported as
  such rather than described.
- **Download.** `GET /v1/files/<id>` is cookie-authenticated, and any paired device may fetch a file
  a durable message references. Headers are fixed: the stored type,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
  `Cache-Control: private, max-age=31536000, immutable`, and `Content-Disposition: inline` for
  `image/*` (except `image/svg+xml`) and `audio/*`, `attachment; filename*=UTF-8''…` otherwise. Every other id — pending,
  pruned, foreign-shaped or malformed — is `404`, and the id shape is checked before any state is
  read. The served path is the one the store resolved inside its media root; it is never built from
  request input. `HEAD` answers the same headers without the body. `?view=artifact` on an `artifact`
  record instead serves it inline with `Content-Disposition: inline` and the preview policy protocol
  v2 states exactly: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src
  'none'; frame-ancestors 'self'`, plus `nosniff`. Without `?view=artifact`, or on any other record,
  the file keeps the normal headers and downloads as an attachment.
- **Agent files and artifacts.** With the top-level `media` block configured, a mapped app chat
  conversation also holds the model-facing `app` tool (TOOLS.md), the counterpart of Telegram's
  `send`. `send {path, caption?}` copies one existing regular workspace file (any type, at most
  `LIMITS.uploadBytes`) into app file storage and appends one durable assistant `message` whose
  text is the caption (possibly empty) and whose `attachments` carry its `AttachmentInfo` with
  `kind: "file"`. `artifact {path, title?}` does the same for one `.html`, `.htm` or `.svg` file (at
  most `LIMITS.artifactBytes`) with `kind: "artifact"` and the exact stored type (`text/html` or
  `image/svg+xml`); the title is the message text. The path is resolved exactly as the Telegram
  send resolves it — workspace-relative, no traversal, no symlink escape, one stable bounded read —
  and nothing else about the file is read back to the model. The referenced record and the message
  commit together, so a message that shows a file always has it downloadable (and vice versa), and a
  repeated execution appends nothing twice. The tool is offered in a mapped app chat (an admitted
  app side-thread fork included) whenever `app` and the top-level `media` block are configured;
  while the adapter itself is stopped there is no live host, so every call is refused with fixed
  text and delivers nothing. It is never offered to the channel state conversation, the root, a
  worker, a scheduled run or any other fork, and the model cannot choose a thread or a device. The receipt is bounded and names only the workspace-relative path.

## Reactions

The owner can react to one message of a thread with one emoji from protocol v2's fixed `REACTIONS`
palette, or clear it: `react {thread?, message, emoji|null}`. `message` must be a durable `message`
id in that thread whose role is `user` or `assistant`. A `notice` is not a target — it is the
gateway's own text, so a note naming it would attribute it to the owner — and is refused like any
other untargetable id. An unknown id, a `notice` id, an emoji outside the palette, a `emoji` that
is neither the palette nor `null`, a malformed thread and an archived (or archiving) thread are all
`bad_request`, and
nothing is appended. The reply is a bare `ok`; the visible result is the durable
`reaction {cursor, thread, message, by:"owner", emoji}` event every device replays, and the latest
event per (`message`, `by`) is the current state — clearing appends `emoji: null` instead of
deleting the earlier event.

A reaction never admits input and never starts a turn. It is retained only as bounded passive
context for that thread's next ordinary (non-callback) owner `send`: at most 8 notes per thread, at
most one per message (a later change replaces that message's note), and the oldest evicted beyond
the bound. Each note names the target, the target's role and a bounded excerpt, and spells out the
old/new/added/removed reaction. The notes are prefixed to the model-facing input — the durable echo
keeps the owner's exact text — and are consumed in the same commit that admits that send, so a
replay cannot attach them twice and a crash cannot lose them. A note older than one hour is dropped
rather than attached to a much later input, and an expired note is consumed all the same. Notes
grant no tool authority and are never host commands. A message id the event log no longer retains
(trimmed below the gateway's floor) cannot be reacted to, because its target could not be named.

The PWA offers the palette from a small reaction button on each user and assistant message (a
quiet always-present button on touch, hover-visible with a fine pointer; no long-press, no swipe).
A badge appears only once the durable `reaction` event arrives — there is no optimistic local state
— and tapping the emoji already shown sends `emoji: null`.

## Controls

The `control` op takes `command` (a name from `hello.commands`) and optional `args` (≤ 1 000
characters), acting on its thread. The app surface is `new`, `abort`/`stop`, `status`, `model
[preset]`, `digest [status]`, `restart` and `help [command]`, each offered only when the host
implements it; CLI-only commands (`tools`, `refresh`, `compact`, `reload`) and `mcp`/`notices`
are not listed. They map to the same host operations the Telegram and Discord commands use: `new` is the paired reset (native reset plus prompt-snapshot rebuild,
refused atomically while a run is live) and appends a durable `divider{reason:"new"}` event;
`abort` withdraws this chat's queued inputs and stops its live work; `status` is the bounded
read-only projection. The visible result of every control arrives as a `message{role:"notice"}`
event, with the same acknowledgement texts (`Context reset.`, `Idle. Queue cleared.`), the same
held acknowledgement until the native call returns, the same 30-second still-pending wording, and
the same at-most-once control records with replay reporting. `model <preset>` applies to that
thread only until restart; `digest` starts one batch for that thread's conversation; `restart`
records the requesting thread durably, then asks the host once, and the replacement posts
`Restarted.` there (a host refusal is reported instead). An unlisted name is `unsupported`;
bad arguments are answered by a usage notice with no effect; a non-string `command`/`args` or
oversize `args` is `bad_request`.

### Model presets and `model` events

`hello.presets` lists the host's named presets (config order, bounded; `[]` without named presets),
read from the live host catalogue (`Gateway.modelPresets()`), so it needs no conversation, is
complete on a fresh deployment and follows `/reload`. After the replay, and again whenever a
thread's selection changes (`model` control, new thread), the gateway sends a non-durable
`model{thread, preset}` event: it is never stored, never consumes a cursor and never moves `head`.
A mapped thread reports its selection (`Gateway.selectedModel()`, read-only); a thread with no
mapping yet reports the configured default; a thread whose selection cannot be read, an archived
thread and a refused or unknown preset send nothing. `/new` appends a context entry and does not
touch the stored model selection, so it sends no `model` event.
Presets are bounded on the wire (at most 50; an entry whose name or `provider/model` is
unprintable, contains whitespace or is too long is dropped) and a `model` event only names a
listed preset, otherwise `null`. Known gap: a CLI `/reload` that changes presets or resets
selections is not pushed to connected apps; they see it on their next `hello`.

## Owner questions

A running adapter attaches one owner-question surface for its mapped, open thread sessions, so the
model's `ask_user` capability (ASK_USER.md) works in a mapped app chat. Delivery is the channel's
own durable log: the adapter appends a `question` event with `state: "open"` and the record's
`expiresAt` in one commit, which is a definite delivery — no external send exists to be fenced. A
session with no live adapter (gateway stopped, thread archived) has no surface, and the tool
refuses without admitting anything.

Every later change is another `question` event for the same `id`, and the app keeps the latest one:
`answered` (with the chosen option id for a tapped answer; a typed answer carries none), `expired`,
`cancelled` by `/new`, and `unknown` for a delivery interrupted in a way the gateway cannot prove.
Alongside the log the channel keeps the last state it published per question id, because retention
trims events: a terminal state whose event was trimmed is never published again, and that memory
goes away with the question record, so it stays bounded by the record set. A live `open` event
itself proves the append happened, so a delivery mark lost in a crash is repaired on the next read
instead of being quarantined — including a record already quarantined `unknown` whose `open` event
is still in the log; an `unknown` record with no such event stays quarantined. Expiry and quarantine
are enforced when a question is read or claimed — on `answer`, a typed message, `/new`, archiving,
or adapter start — never by an adapter timer, so an open card can outlive its answer window until
one of those reads.

`answer {thread, question, option}` claims the durable record against that exact thread session and
admits the follow-up input in one commit. Only the stored record's own label is admitted
(`Answered question <id>: <label>`), never a client string. The reply is `accepted: true` and the
`question` `answered` event follows it; a duplicate, stale, expired, cancelled or foreign question
replies `accepted: false`, appends one fixed `notice` message (once per request id) and admits
nothing. A typed ordinary `send` settles the oldest delivered question in that thread atomically
with its own admission — commands, callback-shaped text and attachment-only sends never count — so
the answer is that message and the record stores no duplicate text. `/new` cancels every pending
question in the thread after repairing a delivery mark lost in a crash in the same commit, so a
quarantined question whose card is still live is cancelled too instead of being reopened by that
repair: the plain native reset repairs and cancels in one commit right after the reset, while the
host paired reset repairs first, commits the reset, and commits the cancellation immediately after
(so the `cancelled` card is published right after them); a failed repair refuses the reset, and a
refused reset cancels nothing. On the plain path a crash between the reset and its cancel commit
can leave one pending question in the new context until it is answered or expires.
Archiving a thread cancels its open questions in the archive's own commit, after the same repair,
so the archived thread and the `cancelled` card arrive together and restoring the thread does not
reopen them; an open question would otherwise leave a card that can never be answered and a record
that blocks every later ask. The idle auto-archive performs the same repair, cancellation and
`cancelled` append in its own archive commit. `abort` and a restart cancel nothing.

## Shortcuts

`POST /v1/ask` lets an iOS Shortcut (or any automation that cannot hold the app's cookie) ask the
agent one question and read the answer back. It is off until the owner creates a token on the host,
over the same private local socket as `app pair`:

```bash
durable-nanobot app shortcut add --label morning   # prints the token once
durable-nanobot app shortcut list                  # labels, created, revoked
durable-nanobot app shortcut revoke morning        # immediate
```

The token is 32 random bytes (base64url), printed exactly once and stored durably only as its
SHA-256 hash beside its label, like a device hash. Labels follow the device rules (printable,
1–40 characters); at most 8 shortcut tokens are active, and a revoked label is free again.
Comparison is constant-time, and revocation is immediate because every ask re-reads the state:
a revoked token stops every *new* ask. An ask already admitted is not cancelled by revocation —
its turn still runs and its answer still arrives, as it would if the token had never been revoked.

A shortcut token is **not a device**. It is read only from the `Authorization: Bearer` header of
`/v1/ask`; it never authenticates the stream (it is never the `durable_device` cookie), and it
cannot upload, download, pair, subscribe to Web Push or run a control. The listener has no path
that resolves a shortcut token to a device, and the adapter has none that grants it thread or
file authority.

- Request: JSON `{"text": "...", "thread"?: "<id>", "key"?: "<send key>"}`. `text` and `key`
  are bounded exactly like `send` (`16 000` characters, `[A-Za-z0-9_-]{1,64}`); the body is bounded
  like a stream frame. `thread` defaults to `main` and must be open (an archived or unknown thread
  is `400 bad_request`). A missing `key` gets a fresh one.
- Admission is the **same commit** a device `send` uses: the same idempotency by `key`, the same
  durable `message{role:"user"}` echo and pending record, the same typed-answer settlement of an
  open question. Every paired device therefore sees the message and its answer in that thread. The
  journal records creation and revocation events without the token (its projection carries no
  labels either).
- After admission the endpoint waits up to `LIMITS.askWaitMs` (25 s) for that key's durable
  `settled`, event-driven rather than polled: `200 {"outcome":"answered","text":"<final answer>"}`
  (a split answer is joined by part), `200 {"outcome":"failed"}` or `{"outcome":"aborted"}`, or
  `202 {"outcome":"pending","key":"<key>"}` when the turn is still running — the answer then
  arrives in the app as usual. A repeated `key` admits nothing and reports that key's existing
  outcome, so a retried Shortcut is safe. A duplicate whose `settled` event has already been
  trimmed out of the capped log cannot be told from a running turn: it waits out the window and
  answers `202 {"outcome":"pending","key":"<key>"}` too, still admitting nothing.
- Errors are fixed and carry nothing else: `401 {"error":"unauthorized"}` (missing, unknown or
  revoked token), `400 {"error":"bad_request"}`, `413 {"error":"too_large"}`, `429
  {"error":"rate_limited"}` (more than `LIMITS.asksPerMinute` = 10 asks per token in a rolling
  minute; in-memory, so a restart clears it). No free text, no stack, no token echo.

### Example: iOS Shortcut ("Get contents of URL")

One action is enough; a Dictate or Ask-for-Input action fills the question.

| Field | Value |
|---|---|
| URL | `https://<tailnet-host>/v1/ask` |
| Method | POST |
| Headers | `Authorization` = `Bearer <token>` (the value `app shortcut add` printed once) |
| Request Body | JSON: `text` = the dictated question (optionally `thread`, `key`) |

The reply is a dictionary. `outcome` is `answered`, `failed`, `aborted` or `pending`; when
`answered`, `text` holds the final answer; when `pending`, `key` names the admitted message and
its answer appears in the installed app. A `401` means the token was revoked or mistyped; create a
new one on the host.

## Notifications (Web Push)

Optional and off unless `app.push` is configured and its private key variable is set. The wire
contract is in `pwa/protocol/v2.md`; this section is the gateway's behavior.

- `push.key` returns the configured VAPID public key. `push.subscribe` validates the browser's
  `PushSubscription.toJSON()` bounds and stores exactly one subscription per device, replacing the
  previous one; `push.unsubscribe` removes it and is idempotent. All three reply `unsupported` when
  push is not configured. The endpoint must be a public DNS name: `https:` on port 443, no userinfo,
  no IP literal and no `localhost`, single-label or `.local`/`.internal`/`.ts.net` name; anything
  else is `bad_request`. Known gap: a public name that resolves to a private address is not caught
  (no DNS pinning); only a paired device can subscribe. Subscriptions live in the device record of the app channel state, never in
  a transcript, model context or log line; revoking a device drops its subscription with its token.
- After a durable `message` with role `assistant` or `notice` is appended, each subscribed device
  without an open, `hello`'d stream is sent one push. The payload is content-free JSON
  `{"v":2,"thread":"<id>","unread":<n>}` — never message text. `unread` counts that device's
  durable `assistant`/`notice` messages above its acked cursor, capped at 99.
- The `Topic` header is a 22-character base64url hash of the thread id, so a newer push for the same
  thread replaces an undelivered older one; TTL is 24 hours and urgency `normal`.
- Sends are bounded: a request timeout, at most one in flight per device, and one coalesced follow-up
  that re-reads the latest unread count when notifications arrived during a send. A 404 or 410
  answer removes that subscription (unless it was already replaced). Any other failure is not
  retried; the next message tries again. Each 404/410 removal and each failed send records one
  journal event carrying only the status code (or, for a network error, a fixed class) — never the
  endpoint, the keys, the payload or the error text.

The sender uses the pinned `web-push` library (the same one the phase-0 probe used), imported
lazily so a gateway without `app.push` never loads it.

## Tasks

`tasks {thread?}` lists one thread's own background work: the retained workers and scheduled jobs
of that thread's mapped conversation, read through the same owner-scoped functions the agent's
`worker list` and `cron list` use. Nothing another thread or chat owns is listed or named. A thread
that is not mapped lists nothing, and the read maps no conversation, so it creates nothing and the
`main` thread stays empty until it has received input. Entries are newest first and capped at
`LIMITS.maxListedTasks`; ids are namespaced (`w:<task id>` for a worker, `c:<job id>` for a job).

`TaskInfo.title` is a bounded one-line label (the worker's instruction or the job's name, never a
stored prompt body in full), and `detail` is a bounded derived line such as the job's schedule and
its last-run status. Neither carries worker output, a credential or a host path; the read calls no
model, reads no transcript and starts, retries or changes nothing.

`task.cancel {thread?, task}` is final. A worker goes through the existing durable worker cancel, a
scheduled job through the existing owner-scoped cron cancel. The task is resolved through that
thread's own list first, so an id from another conversation reports `unknown` and neither
foundation is called: nothing there is touched. `cancelled` means the cancellation was recorded,
`finished` means it had already ended (a second removal of the same job reports this), and
`unknown` means this thread has no such task. A worker cancel that throws is reported as a failed
request, like the model-facing tool, rather than inventing an outcome; a cron cancel that throws
after recording the cancellation still reports `cancelled`, as the cron tool does. The visible
receipt is one bounded durable `notice` in the thread; an archived thread refuses `task.cancel`
with `bad_request`, like `send` and `control`. There is no task event stream: the app fetches the
list when the sheet opens and after any durable event in that thread while it stays open.

## Scheduled results and interruption notices

The adapter consumes the channel-neutral durable outbox (`nanobot.cron.deliveries`) for each
thread's own session. A cron result restores its archived thread before appending the result as
`message{role:"assistant"}`. The restore, message, and outbox settlement commit together, so replay
trimming cannot make a retry append or restore twice. At the 50-open-thread limit the result stays
pending in the outbox without consuming a dispatch slot. A host interruption notice is appended as
`message{role:"notice"}` without restoring the thread. Both are authorized by the
thread's own durable admission evidence (created by the first authenticated input; a fresh
admission restores it and releases withheld records). A malformed record is quarantined `failed`
with a fixed reason and a durable fault entry; no raw record contents are logged.

## Bounded and default-deny behavior

* Pending inputs are bounded at 500; further `send`s reply the fixed `not_ready` error and admit
  nothing. Control records follow the Telegram bounds (at most 64 unresolved).
* Each thread keeps its own submission order and may run concurrently with other threads.
  Delivery tracks up to eight replies per thread and eight notices across the adapter.
* A delivery that keeps failing is held after ten attempts (`held: true`), never resent
  automatically.
* Device sockets are bounded by the 16-device pairing limit; the pairing rate window is one minute.
* Shortcut credentials are bounded at 8 active tokens and 10 asks per token per rolling minute.
  A shortcut ask waits at most `LIMITS.askWaitMs`; past that it answers `pending` and the turn
  keeps running, so a slow answer is never guessed or retried.
* Upload records are bounded (200 unreferenced per device, 4 000 total) and uploads are rate limited
  per device and minute; a refused upload stores no bytes. Referenced originals are never deleted by
  the adapter and there is no total-disk cap — keeping the workspace media directory bounded is the
  operator's job, exactly as for Telegram. A hard crash between storing an upload and committing its
  record can leave an unnamed original that the 24 h discard never sees. A refused upload body is
  read at most 64 KiB before the connection is dropped.

## Known gaps (phase 1)

* **No history or cards.** The protocol marks them *later*; `history` still replies
  `unsupported`. The Tasks view is implemented (see *Tasks*). Files are implemented (see *Files*),
  including agent-sent files and sandboxed artifacts, but with no thumbnails, resumable or
  multipart uploads and no per-file deletion.
* **The upload rate window is in-memory.** A restart clears it, like the pairing window; the durable
  per-device and total record bounds still apply.
* **The shortcut ask window is in-memory.** A restart clears it, like the pairing and upload
  windows; the durable per-token record and its hash remain.
* **Web Push is offline-verified only.** No real push service, browser subscription or service
  worker has been exercised; a failed (non-404/410) send is only retried by the next message, as
  specified. The app side (permission, service worker, badge) lives in `pwa/app`.
* **The event log is capped at 2 000.** Beyond it the oldest events are dropped even if
  unacknowledged; a returning device below the floor replays from the floor with a visible cursor
  gap.
* **The pairing rate window is in-memory.** A restart clears it; five failures then a restart
  allows five more immediately.
* **A label mismatch or a full device limit burns nothing but is not an explicit error.** They
  are reported as `invalid_code`/`bad_request` per the protocol's three-error vocabulary.
* **Oversize frames beyond eight times the frame bound** are aborted by the WebSocket layer with
  1009 (a network-class close for the app) rather than the gateway's `4400`; the bound itself is
  enforced with `4400` up to that backstop.
* **Very long final answers are split, with one bound.** An answer over the frame budget becomes up
to `maxMessageParts` (64) durable parts, losslessly; a text needing more than that (about 16 MB of
escaped text) has its last part truncated and marked `[truncated]`, and is reported once by a
`console.warn` naming the event id. The transcript keeps the whole text.
* **Archive keeps the mapping.** Idle archived snapshots are evictable and rebuilt on restore.
  The gateway reserves snapshot capacity before acknowledging a new thread or send.
* **Legacy fork anchors.** For assistant replies written before fork support, the gateway needs the
  retained app event to identify the native entry. New replies keep that link after replay trimming.
* **No agent-side reactions.** Protocol v2 marks them *later*: the gateway stores and replays owner
  reactions only, and the transcript carries no reaction state for the model beyond the bounded
  passive note.
* **Not covered offline:** a real `tailscale serve` proxy, an installed PWA's cookie jar, iOS
  suspension and reconnect backoff, `sw.js` update semantics, or native process replacement with
  a real device. Offline checks reopen a gateway mid-turn and verify side-thread recovery.

## Dependency

`ws` 8.21.0 (MIT) is a pinned direct dependency, imported lazily from `app-listener.ts`. A gateway
without an `app` block never loads the listener; `npm ci` installs it because the lockfile includes
it. `@types/ws` 8.18.2 is a dev dependency for typechecking only.

`web-push` 4.0.0 (MPL-2.0) is pinned for Web Push and imported lazily from `app-push.ts`, like `ws`
from the listener; a gateway without `app.push` never loads it. It ships no type declarations, so
`src/types/web-push.d.ts` declares exactly the surface used.

## Checks

`tests/app-shortcuts.behavior.test.mjs` covers the shortcut endpoint offline: token creation,
listing and revocation through the console host, the token's inability to authenticate the stream,
uploads or files, an ask that answers and appears on a connected device, duplicate keys, a slow
turn's `pending` and its later streamed answer, `failed`/`aborted` outcomes, the per-token rate
window, bounded bodies, and archived-thread refusal.

`tests/app-channel.behavior.test.mjs` runs offline in `npm run test:behavior`: a real gateway over
a temporary store with a faux provider, the real listener on an ephemeral loopback port, a
synthetic WebSocket client and a controllable clock. It covers config strictness, static paths and
types, pairing (good/bad/expired/reused codes, the rate limit and its rolling window, label
uniqueness), the auth close codes (4401, 4409, 4400, 4426), bounded replay with later `hello`
continuation and ack trimming, idempotent send and the `too_large` text bound, a full streaming
turn (echo, preview, status, answer, settled), activity steps (a `running` step while its tool
runs, `done` and `failed` after, the answer carrying the same bounded list, the
`maxActivitySteps` bound with its `omitted` count, no tool argument or result text anywhere in the
channel's durable log or frames, and no `steps` on a turn without tools), a steered pair answered
once with a settled per
key, reconnect without loss, controls with their replay reporting, the `hello.commands`
catalogue with `model`/`help`/`digest`/`restart` arguments, usage notices and `unsupported`, a seeded reopen (interrupted
command reported, held acknowledgement released, a pre-restart turn still answered), a failed run
(`settled{failed}` with the error presence state), revocation, oversize frames and callback
interception. `tests/app-mcp-login.behavior.test.mjs` covers the login surface with the loopback
OAuth fixture: the URL reaching every hello'd device as a `login` frame and no durable event,
channel state, push payload or transcript, the no-device cancellation, a pasted callback's fixed
notice and completion, and stale, foreign, replayed and cross-thread callbacks refused with fixed
text. v2 coverage includes thread lifecycle, search and list limits, concurrent turns and
replay, fork context and scope checks after reopen, idle archive, interruption recovery, and cron restore.
Files coverage: the opt-in (upload and `send.attachments` refused without `media`, `hello.uploads`),
a durable upload record with byte-for-byte storage, the advertised and streamed `413` with nothing
stored, name bounds and traversal-shaped names, the per-device rate window, an image riding a send
into the echo and the model turn as native image content, unknown/foreign/expired/reused ids
refusing the whole send without consuming anything, and download headers (`inline` for media types,
`filename*` for documents) with `401` for an unpaired request and `404` for pending, malformed or
unreferenced ids.
No tailnet, device, credential or paid inference is
used. The `app pair`/`devices`/`revoke` and `app shortcut add`/`list`/`revoke` local-socket dispatch
is exercised through the same console host the running adapter exports; the thin socket layer
itself follows the `cron` console's existing tests.

`tests/app-agent-files.behavior.test.mjs` covers agent file delivery offline: `send` appends one
durable assistant message with an attachment record in one commit and the file downloads unchanged
with the fixed headers; `artifact` stores `kind: "artifact"` with `text/html`/`image/svg+xml`, and
`?view=artifact` serves exactly the preview CSP and `nosniff` inline while the plain download stays
an attachment; traversal, absolute, symlink-escaping, oversize and wrong-extension paths are refused
with no message and no record, and the receipt carries no host path or file content; and the tool is
absent from the channel state conversation, the terminal chat, the root, an ownerless raw
conversation, a worker child and a scheduled run's automation conversation.

`tests/app-tasks.behavior.test.mjs` covers the Tasks view offline: the list is scoped to one
thread's own worker and scheduled job (another thread and the unmapped `main` thread list nothing),
newest first and bounded with no host path in any field; cancelling a worker aborts it and leaves one
honest durable notice; removing a scheduled job cancels it and a second attempt reports `finished`; a
task id from another thread reports `unknown` and leaves that thread untouched; and a worker that
already completed reports `finished`.

`tests/app-push.behavior.test.mjs` covers Web Push offline: config strictness, local key generation,
the unconfigured `unsupported` replies, subscription validation/replacement/unsubscription, a
content-free push only to a disconnected device, 410 removal without later sends, and coalescing
with a synthetic push endpoint on an ephemeral loopback port.
