# Architecture

An installable web app (PWA) that is a third channel of the Durable Nanobot
gateway, next to Telegram and Discord. One owner, a few devices, reachable only
over the tailnet. Primary target is the iPhone home screen; desktop and Android
come for free.

```
 Phone / laptop (tailnet)                     Host
┌────────────────────────────┐   HTTPS    ┌──────────────────────┐
│ PWA (home-screen web app)  │  wss + /v1 │ tailscale serve      │
│  threads / chat / tasks    │◄──────────►│  *.ts.net cert, TLS  │
│  service worker (push,     │            └──────────┬───────────┘
│  app shell cache)          │                       │ 127.0.0.1
│  IndexedDB store           │            ┌──────────▼───────────┐
└────────────▲───────────────┘            │ durable-nanobot      │
             │ Web Push (encrypted,       │  app listener        │
             │ content-free)              │  src/channels/app*.ts│
      Apple / browser push service ◄──────┤  durable outbox      │
                                          └──────────────────────┘
```

The normative wire contract is [protocol/v2.md](./protocol/v2.md); the
gateway's behavior is [../APP.md](../APP.md). This file is the map between
them.

## Why a PWA (2026-11-18)

The native plan (now in [docs/native-ios/](./docs/native-ios/)) was sized for a
free Apple ID: weekly re-signing, App ID limits and no remote push, so wake-ups
went through an ntfy relay. A home-screen web app gets standard Web Push on iOS
16.4+ without a developer programme, installs once, and uses the same web stack
as the rest of the project. The gateway half and the wire protocol are the same
either way, so a native client stays possible later.

Given up compared with native: share extension (iOS has no Web Share Target),
Siri/App Intents, widgets and Live Activities, uploads that survive closing the
app, and some scrolling/haptic polish.

## Principles

- **The gateway stays the single owner.** The app holds no model credentials,
  tools or authority. It is a surface, like the terminal.
- **Reuse channel machinery.** Session mapping, the durable outbox, owner
  controls, interruption notices and media storage mirror Telegram and Discord.
- **Typed events, not text.** The app gets structured events (status, tool
  steps, questions, task lists), not rendered Telegram text.
- **Offline is normal.** iOS suspends a backgrounded web app and drops its
  socket. Every durable delivery is cursor-based and acknowledged; reconnect
  replays what was missed.
- **No public listener.** Loopback bind, published only with `tailscale serve`.
  Never Funnel, port forwarding or a wildcard bind.

## Gateway side (`src/channels/app*.ts` in this repository)

| Module | Purpose |
|---|---|
| `app.ts` | The adapter: session mapping, ingress, outbox egress, controls, questions, reactions, tasks, forks |
| `app-listener.ts` | HTTP server, WebSocket upgrade, static app, pairing, upload and download endpoints |
| `app-protocol.ts` | Frame parsing, bounds, close codes; the generated mirror of `protocol/v2.ts` |
| `app-files.ts` | Upload records and byte storage, the lookup behind `GET /v1/files/<id>` |
| `app-tool.ts` | The model-facing `app` file tool (`send`, `artifact`) |
| `app-push.ts` | VAPID keys, subscriptions, the content-free sender |
| `app-questions.ts` | `ask_user` delivery, claiming and repair |
| `app-reactions.ts` | Owner reactions and their bounded passive notes |
| `app-tasks.ts` | The Tasks view's read and cancel |
| `app-activity.ts` | A turn's bounded tool steps |
| `app-login.ts` | MCP login owner surface |
| `app-operator-cli.ts` | `app pair` / `devices` / `revoke` |

An opt-in `app` config block starts one HTTP server on an explicit loopback
port. `tailscale serve` terminates TLS with the node's `*.ts.net` certificate
(HTTPS is required for service workers and push) and proxies to it.

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /` | The built PWA (static files from a configured absolute directory) |
| `GET /v1/stream` | The WebSocket; a plain GET without an upgrade is `400` |
| `POST /v1/pair` | One-time pairing code → `204` + `durable_device` cookie |
| `POST /v1/upload` | Attachment upload (raw body, bounded), stored under `media/app/` |
| `GET\|HEAD /v1/files/<id>` | One file a durable message references; `?view=artifact` serves an agent artifact inline under the sandbox CSP |
| `POST /v1/ask` | iOS Shortcuts ask (**in review**, already specified in `protocol/v2.md`) |

Same origin for app and API: no CORS, and the device credential is a
`durable_device` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/v1`) that
the WebSocket handshake carries.

Tailscale Serve adds identity headers (`Tailscale-User-Login`). They are not
trusted on their own, since any local process can reach the loopback port and
forge them; the device token is the authority.

### Stream requests

| op | Purpose |
|---|---|
| `hello` | `v: 2` + resume cursor; returns device label, `head`, agent name, `commands`, `presets`, `uploads` |
| `send` | Owner message with a client `key`, optional `thread`, optional `attachments` upload ids |
| `ack` | Highest durable cursor stored; drives retention and push decisions |
| `control` | One of `hello.commands` (`new`, `abort`, `status`, `model`, `digest`, `restart`, `help`) on one thread |
| `threads` | Thread list, or a title search with `query` |
| `thread.create` / `thread.rename` / `thread.archive` | Thread lifecycle; `from` forks at a message |
| `answer` | One option of an open owner question |
| `react` | The owner's emoji (or `null`) on a `user`/`assistant` message |
| `tasks` / `task.cancel` | A thread's workers and scheduled jobs; cancel by id |
| `push.key` / `push.subscribe` / `push.unsubscribe` | Web Push enrolment |
| `ping` | App sends every 25 s while visible |

`history` is still `unsupported` (protocol v2 marks it *later*).

### Events

| event | Durable | Meaning |
|---|---|---|
| `message` | yes | `user`/`assistant`/`notice` text, attachments, a turn's `steps`, `part {i,n}` when split |
| `settled` | yes | The owner `key` finished: answered, failed, aborted |
| `divider` | yes | A `/new` context boundary |
| `question` | yes | An owner question and every later state change |
| `reaction` | yes | The owner's reaction (latest per message wins) |
| `thread` | yes | Created, renamed, archived or restored |
| `preview` | no | Full answer so far for the running turn |
| `status` | no | `idle`/`queued`/`thinking`/`tool` (+ label) |
| `model` | no | The thread's current preset |
| `activity` | no | The running turn's tool steps so far |
| `login` | no | A one-time MCP authorization URL, live devices only |

`card` is *later*. Durable events carry a strictly increasing per-device
cursor, are delivered at least once and are de-duplicated by the app.

Close codes: `4401` not paired (drop to the pairing screen), `4400` protocol
violation, `4426` unsupported version (reload), `4409` a newer stream replaced
this one (stay quiet while hidden), anything else is a network-class reconnect.

### Authentication

- `durable-nanobot app pair` prints a short-lived one-time code and a QR code in
  the owner's terminal.
- The app exchanges it for a long random device token. The gateway stores only
  a hash with a device label and can revoke by label.
- The cookie's 400-day `Max-Age` is deliberate: iOS drops session cookies when a
  home-screen app is closed, which would force re-pairing.
- **iOS gotcha:** a home-screen web app has its own cookie and storage jar,
  separate from Safari. Pair from inside the installed app, not by opening a
  pairing link in Safari. The first-run screen says so.
- A paired device maps to one host-derived session key, validated as an ordinary
  mapped chat like any other channel. Only such chats get foreground authority;
  root, fork, raw, state and automation conversations never become app threads.

### Owner surfaces

- Controls (`new`, `abort`, `status`, `model`, `digest`, `restart`, `help`) act
  on one thread and answer with a `notice`.
- `ask_user` questions arrive as durable `question` events; an `answer` claims
  the record and admits the follow-up in one commit.
- Owner reactions are stored as durable `reaction` events and kept as bounded
  passive context for that thread's next ordinary owner message.
- MCP login URLs go only to devices streaming at that moment as a non-durable
  `login` frame; none connected cancels the attempt. A pasted loopback callback
  is offered to the login lifecycle before admission and never stored.
- The one model-facing tool is the `app` file capability (`send`, `artifact`):
  it grants no coding authority, returns no file content and reaches only the
  thread the model is already answering.
- No new tool authority: coding tools come from config, not from the channel.

### Wake-ups (Web Push)

- VAPID key pair generated once by an explicit owner command, private key in a
  `0600` file under the canonical `dataDir`. Sending with the `web-push` npm
  package.
- One subscription per paired device; a new one replaces it, revoking the device
  deletes it. A `404`/`410` from the push service drops it; other failures are
  not retried, the next message tries again.
- Sent only when a durable `assistant`/`notice` message is admitted for a
  device with no open, `hello`'d stream. One send in flight per device, request
  timeout, and one coalesced follow-up.
- Payload is encrypted end to end (RFC 8291) but content-free: `{v, thread,
  unread}` only. The `Topic` header is a hash of the thread id, so a newer
  push replaces an undelivered older one. A notification is a hint; the outbox
  stays the source of truth.
- A rotated VAPID key means the old subscription cannot be addressed: the app
  compares the key its subscription was made with against `push.key` and
  re-subscribes when they differ.

## App side (this repository, `app/`)

### Stack

| Need | Use |
|---|---|
| Build | Vite 8, TypeScript 5.9 |
| UI | React 19, Tailwind 4 for the shell |
| Streaming markdown, code blocks, tables | Streamdown 2 |
| Service worker, precache, push handler | `vite-plugin-pwa` 2 in `injectManifest` mode over Workbox |
| Local store | IndexedDB via `idb` 8 |
| Icons | `scripts/gen-icons.mjs`, no dependencies |

### Components and data flow

| File | Role |
|---|---|
| `src/App.tsx` | Loads the store, then starts the connection; first-run vs chat; iOS keyboard handling via `visualViewport` |
| `src/conn.ts` | The one WebSocket: `hello` + replay, ack, pings, backoff, close-code reactions, the outbox and upload queue |
| `src/store.ts` | All state and its IndexedDB cache; renders through `useSyncExternalStore` |
| `src/Chat.tsx` | Thread header, model chip, message list, composer, sheets (menu, commands, model, tasks, thread list) |
| `src/sw.ts` | App-shell precache and the Web Push handler |
| `src/push.ts` | Permission, subscribe/unsubscribe, VAPID key rotation, badge |
| `src/uploads.ts` | `POST /v1/upload` with the protocol's bounds and owner-facing errors |
| `src/recorder.ts` | Voice-note capture (`audio/mp4` on iOS, Opus/WebM elsewhere) |
| `src/Question.tsx`, `LoginCard.tsx`, `Reactions.tsx`, `ActivitySteps.tsx`, `TasksSheet.tsx` | The cards and sheets for questions, MCP logins, reactions, tool steps and tasks |

Data flow is one direction: the socket writes durable events into the store
and only then acks them; the store persists them and notifies React; a queued
send goes store → upload → `send` with its original `key`; the `settled` event
(or the assistant message) closes it. A failed durable write freezes acks until
the hole is gone, so a replay can never skip a message.

- Replay: `hello` with the resume cursor; a 500-event batch ends with another
  `hello` from the new cursor; only acknowledged, persisted cursors are
  resumed.
- Sends are idempotent by `key`; queued rows and their uploaded blobs survive a
  reload, and every pending/sent row is re-sent with the same key on reconnect.
- Uploads run before the send they belong to, retry with backoff on
  rate-limit/network errors, and fail honestly (with a note) when the gateway
  refuses them.
- A `BroadcastChannel` keeps the outbox in step across two open windows.
- The service worker is separate state: it reads two cached keys (agent name,
  thread title) and shows a notification; the app clears the badge once it is
  visible and has acked everything.

### Interface

Main thread plus owner-created side threads, in one window.

- **Thread list**: explicit header control opens a sheet (a persistent sidebar
  from 900px up) with the main thread pinned, open side threads by activity and
  archived ones below; title search goes through `threads {query}`, message-text
  search covers what this device has cached.
- **Chat**: avatar and status pill, streaming markdown, files and images, the
  turn's activity disclosure, question cards, the login card, and a floating
  capsule composer (commands, attach, text, send/stop, or the mic).
- **Wide layout (900px and up)**: sidebar instead of the list sheet, a centred
  reading column, and shortcuts — `Escape` closes a sheet, `Ctrl/Cmd+K` focuses
  thread search, `Alt+↑/↓` steps through the open threads. Below the breakpoint
  the phone layout is unchanged; switching keeps the thread, draft and reading
  position.
- **Model presets**: a header chip and a model sheet fed by `hello.presets`; the
  choice goes out as `control {command: "model"}` and is shown only once its
  `model` event arrives.
- **Command toolbox**: the wrench sheet and the composer's `/` menu both render
  `hello.commands`; nothing is hardcoded, and `/name args` in the composer is a
  control, never a message.
- **Activity disclosure in three levels**: status pill, the turn's tool list
  under the answer ("Used N tools"), and one tool's name, outcome and duration.
- **Tasks**: a sheet, not a stream — fetched when it opens and after any durable
  event while open; cancelling asks first and reports the gateway's outcome.
- **Questions**: an open card per `question` event, disabled while the answer
  is in flight, read-only with its final state afterwards.
- **Reactions**: a small button in the message's control row, a six-emoji
  palette, and a badge that only follows the durable `reaction` event.
- **Voice notes**: the send slot becomes a mic when the composer is empty;
  recording stops on background, thread change, read-only, 5 minutes or the
  upload byte cap, and a kept recording stays as a chip.
- **Files**: attach from Photos, Files or the camera, upload on connect, render
  images and audio inline, everything else as a download chip.
- **Notifications**: the "Notifications" row in the thread menu asks for
  permission on tap and hides itself when the gateway has no push configured.
- **No swipe navigation and no long-press gestures**: edge swipes collide with
  Safari's back gesture, and every action is an explicit control.
- **Offline**: text and file picks are kept in the store and sent on reconnect;
  the pill shows offline/reconnecting/replaying.

Long answers are split into `part {i,n}` durable events; the app joins them in
order and marks an incomplete message until every part has arrived.

### Local store

IndexedDB database `durable-app` (version 3):

| Store | Holds |
|---|---|
| `events` | Durable events, keyed by cursor |
| `outbox` | Queued/sent/admitted outgoing messages, their upload ids and blob ids |
| `files` | Blob bytes for a queued send, until its turn is over |
| `threads` | Thread metadata (`ThreadInfo`) |
| `creates` | Offline `thread.create` keys |
| `view` | Last viewed cursor per thread (unread state) |
| `settings` | `openThread`, `resumeCursor`, `identity` (device, agent, commands, presets, uploads), `push` |

Never persisted: MCP login URLs (memory only, dropped on reload, expiry or the
outcome notice), `activity` steps, `status`, `model`, `preview` text, upload
retry timers, and every per-turn scratch list. The store is a cache:
iOS may evict web storage, and losing it means a full replay, nothing more.

## Security model

- **One credential.** The `durable_device` cookie, set only by `POST /v1/pair`,
  `HttpOnly; Secure; SameSite=Strict; Path=/v1`. Revocation is server-side.
  Tailscale identity headers are ignored.
- **Same origin.** The app is served by the gateway, so there is no CORS and no
  cross-origin cookie path; the socket, the upload endpoint and file downloads
  all carry the same cookie.
- **Uploads are device-private** until a `send` references them; an unknown,
  foreign, expired or reused id refuses the whole send and consumes nothing.
  Names are untrusted metadata, never a path.
- **Files are only served when a durable message references them**, with
  `nosniff`, `Content-Security-Policy: sandbox` and an immutable private cache;
  inline only for `image/*` (except SVG) and `audio/*`, everything else as an
  attachment.
- **Agent artifacts** are the only HTML the gateway serves inline, and only
  under `?view=artifact` with `sandbox allow-scripts; default-src 'none';
  connect-src 'none'; frame-ancestors 'self'`: an opaque origin with no network
  that cannot reach `/v1` or the cookie. The app's card and full-screen viewer
  render it only inside `<iframe sandbox="allow-scripts">`, opening focused on
  Close; previews run only while their card is near the screen.
- **Push is content-free.** `{v, thread, unread}` only — never message text,
  never a token. The service worker derives the title from cached identity and
  must accept only well-formed thread ids.
- **MCP login URLs** are live-only: never in the event log, channel state or a
  push, and the app opens only `https:` or a loopback `http:` URL.
- **Activity steps** carry a tool name, state and timings; never arguments,
  results, paths or error text.
- **No host paths, tokens or credential filenames** in the app's state, frames
  or docs.
- **No gesture-only actions**: no swipe, no long-press. Reactions, forks and
  every other message action are explicit buttons.

## iOS platform notes

Verified by third-party sources, to confirm on the owner's phone:

- Web Push works only for an installed home-screen web app (iOS 16.4+), after a
  permission prompt triggered by a user gesture. Not in a Safari tab.
- Declarative Web Push exists from iOS 18.4; not needed.
- Since iOS 26, any site added to the Home Screen opens as a web app by default.
- No install prompt (`beforeinstallprompt`); installation is Share → Add to Home
  Screen.
- No Web Share Target, no Background Sync; sockets die when backgrounded.

Unverified on a real device: push delivery, the app badge, keyboard/visual-
viewport behaviour, the voice-note codec (`audio/mp4`) and the installed app's
separate cookie jar.

## In review / known gaps

- **Shortcuts `POST /v1/ask` (gateway, in review).** Specified in protocol v2
  (token-based, waits for the turn to settle); not on `main` yet.
- **No agent-side reactions**: v2 marks them *later*; owner reactions only.
- **`card` events**: *later*. No buttons or quick replies on agent messages.
- **`history`**: `unsupported`.
- **Push and the installed app are offline-verified only**: no real push
  service, badge, keyboard or codec has been exercised.

## Prior art

Take patterns, not code; check licences first.

| Project | Learn from it |
|---|---|
| Hermes UI+ (`robbyczgw-cla/hermes-ui-plus`) | Closest match: PWA client for a self-hosted agent, a bridge published with `tailscale serve`, one-time pairing code exchanged for a revocable device token, Web Push in the installed PWA, approval and answer cards, live tool steps |
| Salchi | Phone UI for coding-agent sessions; `--tailscale-serve` mode and a written guide for PWA push over Tailscale Serve; pairing URL with token in the fragment; local whisper.cpp dictation |
| `@timmygod/pi-web-local` | Pi-ecosystem web UI: Go server, SSE streaming, Tailscale Serve, token-protected remote access |
| agy-remote | Self-hosted PWA remote with local VAPID keys and lock-screen push on iOS and Android |
| T3 Code | Pairing a device to a self-hosted agent server; rendering agent activity |
| Home Assistant frontend | Long-lived WebSocket to a self-hosted server, reconnect and auth handling |

## Do not build

| Need | Use |
|---|---|
| Push transport | Web Push via the platform push service; no ntfy, no APNs |
| Push encryption and VAPID | `web-push` |
| Service worker plumbing | `vite-plugin-pwa` |
| Streaming markdown | Streamdown |
| TLS certificates | `tailscale serve` |
| Reachability | The Tailscale app; no embedded VPN |
| File and camera picking | `<input type="file" accept capture>` |
| Sharing out | The file download |

## Deliberately out of scope

- Multi-user accounts, sharing, sync between owners.
- Public exposure (Funnel, port forwarding, a public relay).
- A generative feed, app builder or connector marketplace UI.
- Native wrappers (Capacitor, Tauri) until the PWA proves insufficient.
