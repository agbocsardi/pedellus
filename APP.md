# App channel (installable web app)

The `app` adapter is opt-in, adds no tool authority and runs inside the same gateway process as
the CLI, Telegram and Discord. It serves the built PWA from the sibling `durable-app` repository
over one loopback HTTP+WebSocket listener; `tailscale serve` publishes it on the tailnet with the
node's `*.ts.net` certificate. The wire contract is protocol v1, normative in the sibling
repository (`protocol/v1.md`); this gateway implements it exactly and changes to it belong there,
not here. `src/channels/app-protocol.ts` holds the limits, close codes and pure validation;
`src/channels/app-listener.ts` owns transport mechanics (sockets, bodies, cookies, MIME types,
path safety); `src/channels/app.ts` owns admission, the durable event log, controls, pairing and
the operator console.

Status: offline-verified only. No tailnet, `tailscale serve`, real device, installed PWA or live
pairing has been exercised in this repository. The first deployment is a supervised trial.

## Configuration

Add an `app` block to the explicit configuration file. Absent means no app code, dependency or
listener is loaded.

```json
{
  "app": { "port": 43190, "staticRoot": "/home/owner/deploy/durable-app/dist" }
}
```

| Key | Meaning |
| --- | --- |
| `port` | Required explicit integer 1–65535. The listener binds `127.0.0.1` only; no other bind is configurable, and `tailscale serve` is the only publisher. Never Funnel, port forwarding or a wildcard bind. |
| `staticRoot` | Required absolute directory holding the built PWA. Files are served with safe path resolution (no traversal, no directory listing, encoded separators are not structure), correct MIME types and `index.html` for the root; `sw.js` is always served `no-store`. |

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
an omitted label picks a free `device-<n>`. Revoke is exact-label.

## Pairing and devices

`POST /v1/pair` exchanges one console-created code for a device token. The code is 8 characters
from `[A-Z2-9]` minus `I`/`O` (case-insensitive input), single-use, and expires after ten minutes.
Only its hash is stored. The token is long and random, exists only in the `durable_device` cookie
(`HttpOnly; Secure; SameSite=Strict; Path=/v1`) and only its SHA-256 hash with the label and
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

One host-derived session key, `app:chat`, is shared by every paired device; the gateway validates
it as an ordinary mapped chat, exactly like the other channels. There is no per-device
conversation. The state document lives in the `app:channel-state` conversation (`nanobot.app-state`),
never in a plaintext sidecar.

The adapter grants no tool: coding tools, MCP, web, cron, memory and worker authority are whatever
the configuration already gives that mapped chat. The app chat is **not** an MCP login or
`ask_user` owner surface in this phase: protocol v1 has no event that could carry a one-time
authorization URL or an owner question without persisting it in the durable event log, and
persisting such a URL in channel state is forbidden by the channels' binding contract (see
*Known gaps*). A callback-shaped `send` is still intercepted before transcript admission, refused
with one fixed notice, and its text is never stored.

## Protocol and delivery

Requests are `{"type":"req","id","op",...}` with exactly one `{"type":"res","id","ok",...}` reply;
fixed error codes only, never free text. Frames and request bodies are bounded at 262 144 bytes;
`send.text` at 16 000 characters; ids and keys at 1–64 characters of `[A-Za-z0-9_-]`.

Durable egress is the adapter's own cursor-numbered event log — `message` (roles `user`,
`assistant`, `notice`), `settled`, `divider` — appended in one commit per delivery. `hello` replays
events with `cursor > hello.cursor` (oldest first, at most 500 per batch; the app re-`hello`s for
more), live sockets are pushed every event after their own position, and `ack` records each
device's highest stored cursor. Replay is idempotent by cursor on the client, so delivery is
at-least-once and the cursor is the dedupe identity. Retention trims events acknowledged by every
active device, then a hard cap of 2 000 keeps the newest; a `hello` below the retention floor
replays from the floor, so a device that acks never sees a gap, and one that returns after the cap
was exceeded has an irreducible hole (the app refetches nothing; phase 2 push mitigates this).

This is the app-channel reconciliation of Telegram's held-unknown boundary: Telegram's external
sends have no idempotency key, so an ambiguous outcome is quarantined and never resent. The app's
"send" is a durable local commit, and its retransmission path is cursor replay, which is exactly
idempotent — so no write-ahead intent or unknown-outcome quarantine exists, and none is needed.
Everything else follows the Telegram adapter, the delivery-semantics reference: admission before
submission with a stable request id (`app:send:<key>`), a repeated `send` key answered
`duplicate: true` with nothing admitted (keys are remembered durably for at least seven days, at
most 2 000 — see *Known gaps*), the shared-answer retirement of steered inputs, control records
with held acknowledgements, gating, applied/refused/unconfirmed outcomes and unconfirmed reporting
at reopen.

Ordering for one turn: `message{role:"user",key}` at admission, `status`/`preview` (non-durable,
replaced by the next) while it runs, `message{role:"assistant",key}` and one `settled{key}` per
consumed key. A failed run settles each consumed key `failed` individually (failures are never
grouped by error text); an abort or `/new` reset settles `aborted`. An empty answer is replaced by
a fixed notice. `followUpMode: "steer"` submits with native `whenBusy: "steer"` under the same
owner-run check as Telegram.

## Controls

The `control` op implements `new`, `abort` and `status`, mapping to the same host operations the
Telegram commands use: `new` is the paired reset (native reset plus prompt-snapshot rebuild,
refused atomically while a run is live) and appends a durable `divider{reason:"new"}` event;
`abort` withdraws this chat's queued inputs and stops its live work; `status` is the bounded
read-only projection. The visible result of every control arrives as a `message{role:"notice"}`
event, with the same acknowledgement texts (`Context reset.`, `Idle. Queue cleared.`), the same
held acknowledgement until the native call returns, the same 30-second still-pending wording, and
the same at-most-once control records with replay reporting. The catalogued later commands
(`model`, `digest`, `restart`, `mcp`) are refused with the fixed `unsupported` error; anything
else is `bad_request`.

## Scheduled results and interruption notices

The adapter consumes the channel-neutral durable outbox (`nanobot.cron.deliveries`) for its one
chat, like Telegram: a completed cron result is appended as `message{role:"assistant"}` and a
host interruption notice as `message{role:"notice"}`, both cursor events, authorized by this
channel's own durable admission evidence (created by the first authenticated input; a fresh
admission restores it and releases withheld records). The outbox record is marked `delivered`
after the append; a crash between the two is closed by the event's stable id (`outbox:<record
id>`), so the append is never duplicated. A malformed record is quarantined `failed` with a fixed
reason and a durable fault entry; no raw record contents are logged.

## Bounded and default-deny behavior

* Pending inputs are bounded at 500; further `send`s reply the fixed `not_ready` error and admit
  nothing. Control records follow the Telegram bounds (at most 64 unresolved).
* Delivery concurrency is bounded at eight replies and eight notices; one chat keeps one
  submission order.
* A delivery that keeps failing is held after ten attempts (`held: true`), never resent
  automatically.
* Device sockets are bounded by the 16-device pairing limit; the pairing rate window is one minute.

## Known gaps (phase 1)

* **No MCP login or `ask_user` surface.** A mapped app chat cannot start an MCP login (no owner
  surface is registered, so the login is refused before delivery) and cannot receive an
  `ask_user` question. Protocol v1 defines no owner-only non-durable event; a later protocol
  revision must add one before this channel can carry URLs or questions.
* **No uploads, media, history, tasks, cards or Web Push.** The protocol marks them *later*;
  `history` and `tasks` reply `unsupported`; a `send` with `attachments` replies `unsupported`.
* **Send-key idempotency is bounded at 2 000 keys inside seven days.** The protocol promises
  idempotency "for at least 7 days"; with more than 2 000 distinct keys in that window the oldest
  is evicted early and a re-used key would be admitted again. The durable request id
  (`app:send:<key>`) still fences the model turn, so the duplicate becomes an echo, not a second
  answer.
* **The event log is capped at 2 000.** Beyond it the oldest events are dropped even if
  unacknowledged; a returning device below the floor replays from the floor with a visible cursor
  gap.
* **The pairing rate window is in-memory.** A restart clears it; five failures then a restart
  allows five more immediately.
* **A label mismatch or a full device limit burns nothing but is not an explicit error.** They
  are reported as `invalid_code`/`bad_request` per the protocol's three-error vocabulary.
* **The cookie has no `Max-Age`.** The protocol names exactly its four attributes, so the cookie
  is session-scoped: a device that loses its cookie jar re-pairs with a new code.
* **Not covered offline:** a real `tailscale serve` proxy, an installed PWA's cookie jar, iOS
  suspension and reconnect backoff, `sw.js` update semantics, and mid-turn process replacement
  (the listener closes all sockets with 1001; the app replays from its stored cursor after
  reconnect).

## Dependency

`ws` 8.21.0 (MIT) is a pinned direct dependency, imported lazily from `app-listener.ts`. A gateway
without an `app` block never loads the listener; `npm ci` installs it because the lockfile includes
it. `@types/ws` 8.18.2 is a dev dependency for typechecking only.

## Checks

`tests/app-channel.behavior.test.mjs` runs offline in `npm run test:behavior`: a real gateway over
a temporary store with a faux provider, the real listener on an ephemeral loopback port, a
synthetic WebSocket client and a controllable clock. It covers config strictness, static paths and
types, pairing (good/bad/expired/reused codes, the rate limit and its rolling window, label
uniqueness), the auth close codes (4401, 4409, 4400, 4426), bounded replay with later `hello`
continuation and ack trimming, idempotent send, a full streaming turn (echo, preview, status,
answer, settled), reconnect without loss, controls with their replay reporting, revocation,
oversize frames and callback interception. No tailnet, device, credential or paid inference is
used. The `app pair`/`devices`/`revoke` local-socket dispatch is exercised through the same console
host the running adapter exports; the thin socket layer itself follows the `cron` console's
existing tests.
