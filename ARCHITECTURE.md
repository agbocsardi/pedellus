# Architecture

A native SwiftUI app that is a third channel of the Durable Nanobot gateway,
next to Telegram and Discord. One owner, one or two devices, no public service.

```
 iPhone                                   Host
┌──────────────────────────┐            ┌─────────────────────────────────┐
│ App (SwiftUI)            │  WebSocket │ durable-nanobot gateway         │
│  Chat / Tasks / Settings │◄──────────►│  src/channels/app.ts  (adapter) │
│ Share extension          │   HTTPS    │  app listener (tailnet only)    │
│ App Intents              │◄──────────►│  durable outbox, sessions,      │
│ Live Activity / widget   │  uploads   │  workers, cron, media           │
└───────────▲──────────────┘            └───────────────┬─────────────────┘
            │ tap deep-links                            │ content-free post
       ntfy app ◄──────────── ntfy relay ◄──────────────┘
```

## Principles

- **The gateway stays the single owner.** The app holds no model credentials, no
  tools and no authority of its own. It is a surface, like the terminal.
- **Reuse channel machinery.** Session mapping, the durable outbox, owner
  controls, interruption notices and media storage already exist for Telegram and
  Discord. The app adapter mirrors them rather than inventing parallel ones.
- **Typed events, not text.** Telegram gets rendered text. The app gets
  structured events (status, tool activity, cards, task updates) so it can show
  a status pill, a task list and approval cards.
- **Offline is normal.** The phone sleeps and changes networks. Every delivery
  is cursor-based and acknowledged; a reconnect replays what was missed.
- **No public listener.** Reachable over the tailnet only.

## Gateway side (in `durable-nanobot`)

### Listener

A new opt-in `app` config block starts one HTTP server bound to an explicit
tailnet address (never a wildcard address). It serves:

| Path | Purpose |
|---|---|
| `GET /v1/stream` (WebSocket) | Events down, requests up |
| `POST /v1/uploads` | Attachment upload, bounded size, stored under `media/app/` |
| `GET /v1/media/<id>` | Download of a file the agent sent to this chat |
| `POST /v1/pair` | One-time pairing exchange |

TLS: the tailnet already encrypts and authenticates the hop. Use the tailnet's
own HTTPS certificates if App Transport Security makes plain HTTP awkward;
decide during phase 1.

### Authentication

- Pairing: `durable-nanobot app pair` prints a short-lived one-time code (and a
  QR code) in the owner's terminal. The app exchanges it for a long random
  device token, stored in the Keychain.
- The gateway stores only a hash of each device token, with a device label, and
  can revoke one by name.
- Every request carries the token. Unknown or revoked tokens are refused with
  fixed text.
- A paired device maps to one host-derived session key, validated as an
  ordinary mapped chat like any other channel.

### Adapter (`src/channels/app.ts`)

- Ingress: admit owner messages with `followUpMode`, attachments by reference
  to a finished upload.
- Egress: the existing durable outbox, with a per-device delivery cursor and
  acknowledgement. Unknown outcomes are held, never blindly resent.
- Owner controls: `/new`, `/abort`, `/status`, `/model`, `/digest`, `/restart`,
  `/mcp` exposed as typed requests rather than parsed text.
- MCP login owner surface: the app can receive the one-time authorization URL,
  as the CLI and Telegram private chat do.
- No new tool authority. If an `app` model tool is ever added (for example to
  send a card), it follows the scoped `telegram` tool pattern.

### Wake-up notifications

The app is signed with a free Apple ID, which cannot use remote push. The
gateway therefore wakes the phone through a relay app that has its own push:

- The gateway posts to one unguessable ntfy topic when an outbox record is
  admitted for a device that has no live stream. A connected device gets the
  event over the stream instead.
- The body is content-free by default ("New message", "Task finished"), with a
  tap action that deep-links into this app. Message text never leaves the
  tailnet unless a config switch opts into a short preview.
- The topic is referenced by environment variable name, never stored in config.
- A notification is a hint. The outbox remains the source of truth; a lost one
  loses nothing.
- The sender sits behind one small interface, so a later move to the paid
  programme swaps in token-based APNs without touching the adapter or protocol.

## Wire protocol

JSON messages over one WebSocket, versioned in the handshake. The schema lives
in this repository under `protocol/` and both sides implement it.

Client to gateway (requests, each with an id and a single reply):

- `hello` — protocol version, device token, last acknowledged cursor
- `send` — text, attachment ids, client request key for idempotency
- `ack` — cursor up to which events are stored on the device
- `control` — one of the owner controls
- `history` — page of earlier entries for scroll-back
- `tasks` — list workers and cron jobs; cancel by exact id

Gateway to client (events, each with a monotonically increasing cursor):

- `message` — a committed entry: owner text, assistant answer, host notice
- `preview` — streaming text for the running turn (not durable, no cursor)
- `status` — run state: idle, generating, tool, compacting, queued
- `activity` — tool call started/finished, with a bounded label and preview
- `card` — structured block: approval, quick replies, file, task result
- `task` — worker or cron job state change
- `settled` — a turn ended, with outcome

Rules:

- Durable events carry a cursor; previews and status do not and are simply
  replaced by the next one.
- Reconnect sends the last acknowledged cursor; the gateway replays from there.
- Requests are idempotent by client request key, so a retry after a dropped
  connection cannot double-send.
- Bounded sizes everywhere, mirroring the local protocol's limits.

## App side (this repository)

### Targets

| Target | Role |
|---|---|
| App | SwiftUI interface |
| `Core` (Swift package) | Protocol types, connection, local store, shared by all targets |
| Share extension | Send files, photos, links and text from any app |
| Widget extension | Live Activity, lock-screen widget, Control Center control |

### Interface

Borrowed from the current crop of agent apps (see the research notes in the
TODO log): one persistent thread with a character, not a list of chats.

- **Chat**: avatar and status pill at the top, streaming markdown, attachment
  and card rendering, floating capsule composer (`+`, text, dictation, send).
- **Activity disclosure in three levels**: status pill, then the turn's tool
  list, then one tool's raw bounded output.
- **Tasks**: workers and cron jobs grouped as needs input, working, scheduled
  and done.
- **Channels**: a side menu with the main thread plus named side threads, each
  its own gateway session.
- **Settings**: gateway address, pairing, model preset, notification choices.

Details that matter more than they look:

- **Connection state in the pill.** Tailnet down, reconnecting and replaying
  are states of the same pill as generating and running a tool.
- **Per-message delivery state.** Queued on device, sent, admitted by gateway.
  A message typed offline is kept and sent on reconnect.
- **Send becomes stop** while a turn runs. Sending during a run offers steer or
  queue, mapping to the gateway's `followUpMode`.
- **`/new` is a visible divider** in the thread, not a new screen. Earlier
  episodes stay scrollable above it.
- **Model preset chip** in the header opens the picker.
- **Long-press a message**: copy, quote into the composer, share.
- **Search** over the thread, backed by the gateway's history search.
- **Haptic** when a turn settles while the app is in the foreground.
- **Code blocks** scroll horizontally with a copy button; long tool output is
  collapsed by default.

### Local store

SwiftData (or GRDB if SwiftData proves limiting) holds received entries keyed
by cursor, pending outgoing messages and upload state. The app renders from the
store; the connection only fills it. The App Group container shares it with the
extensions.

### System integration

- **App Intents**: Ask (send and wait briefly for the answer, otherwise say it
  will arrive as a notification), Send file, New chat, Run a named prompt. These
  give Siri, Shortcuts, Spotlight and the Action button.
- **Share extension**: uploads in a background `URLSession` so it finishes
  after the sheet closes.
- **Notifications**: arrive through the relay app and deep-link here. Local
  notifications cover events that land while the app is still running.
- **Live Activity**: shows a running turn or worker, updated only while the app
  is alive.
- **Voice**: on-device dictation first; sending audio to the gateway's existing
  transcription path is a later option.

## Sideloading constraints (free Apple ID, chosen for now)

Verified:

- No remote push entitlement.
- Builds expire after seven days; at most three sideloaded apps per device and
  ten App IDs per seven days. Each extension is its own App ID, so keep the
  extension count low (share extension and widget extension only).

From memory, to verify with a throwaway project in phase 1:

- App Intents, widgets, local notifications, Live Activities started and
  updated by the running app, and App Groups are expected to work.
- Time-sensitive notifications, iCloud and SiriKit domains are expected not to.

Consequences:

- No notification service extension, no reply-from-notification, no Live
  Activity updates while the app is suspended.
- Weekly re-signing: rerun from Xcode, or use a refresh tool that re-signs over
  the local network.
- Moving to the paid programme later restores all of it without a redesign.

## Prior art

Read these before building the matching part. Take patterns, not code; several
are copyleft.

| Project | Learn from it |
|---|---|
| Ice Cubes (Mastodon client) | SwiftUI app split into local packages; share extension, widgets and App Intents in one codebase |
| Home Assistant iOS | Companion to a self-hosted server: WebSocket session, Shortcuts and intents, notification categories, widgets, Watch |
| T3 Code mobile and `t3code-ios` | Pairing a phone to a self-hosted agent server by URL; rendering agent activity |
| Signal iOS | Durable send queue, attachment upload and download pipeline, share extension. UIKit and very large: read, do not imitate |
| Element X iOS | SwiftUI message timeline and composer at scale |
| Open-Relay, ayna | SwiftUI AI chat with streaming answers; ayna also has a Watch target |
| ntfy iOS | The relay app the wake-up path depends on |

## Do not build

Use the platform or an existing package for each of these:

| Need | Use |
|---|---|
| Floating capsule tab bar, glass materials, dark mode, Dynamic Type | Stock `TabView`, `NavigationStack` and system materials |
| Streaming markdown, code blocks, tables | A streaming markdown package (candidates: SwiftStreamingMarkdown, StreamingText); pick one in phase 1 |
| WebSocket | `URLSessionWebSocketTask` |
| Uploads that survive the app closing | Background `URLSession` |
| Local store | SwiftData, or GRDB if it proves limiting |
| Device token storage | Keychain |
| Photo, file and camera picking | `PhotosPicker`, `fileImporter` |
| File and image preview | Quick Look |
| QR pairing scan | VisionKit `DataScannerViewController` |
| Dictation | The system keyboard's own dictation; nothing to build |
| Network reachability over the tailnet | The Tailscale app; do not embed a VPN |
| Wake-up delivery | ntfy app |

## Deliberately out of scope

- Multi-user accounts, sharing, sync between owners.
- A generative feed, an app-builder surface, a connectors marketplace UI.
- Android, iPad-specific layout, Mac Catalyst.
- Exposing the gateway to the public internet.

## Open questions

1. Decided: the app has its own session; side threads are further sessions.
2. Whether the ntfy topic lives on the public ntfy server or a self-hosted one.
3. Cards: which model-facing mechanism produces them, if any, beyond host
   notices and approvals the gateway already knows about.
4. Whether the listener reuses the local protocol's request shapes or defines
   its own. Current lean: its own, since the local protocol trusts the
   filesystem and carries host paths.
5. Avatar: static, or a small set of animated states driven by `status`.
