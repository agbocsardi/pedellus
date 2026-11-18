# Architecture

An installable web app (PWA) that is a third channel of the Durable Nanobot
gateway, next to Telegram and Discord. One owner, a few devices, reachable only
over the tailnet. Primary target is the iPhone home screen; desktop and Android
come for free.

```
 Phone / laptop (tailnet)                     Host
┌────────────────────────────┐   HTTPS    ┌──────────────────────┐
│ PWA (home-screen web app)  │  wss + /v1 │ tailscale serve      │
│  Chat / Tasks / Settings   │◄──────────►│  *.ts.net cert, TLS  │
│  service worker (push,     │            └──────────┬───────────┘
│  app shell cache)          │                       │ 127.0.0.1
│  IndexedDB store           │            ┌──────────▼───────────┐
└────────────▲───────────────┘            │ durable-nanobot      │
             │ Web Push (encrypted,       │  app listener        │
             │ content-free)              │  src/channels/app.ts │
      Apple / browser push service ◄──────┤  durable outbox      │
                                          └──────────────────────┘
```

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
  activity, cards, task updates), not rendered Telegram text.
- **Offline is normal.** iOS suspends a backgrounded web app and drops its
  socket. Every durable delivery is cursor-based and acknowledged; reconnect
  replays what was missed.
- **No public listener.** Loopback bind, published only with `tailscale serve`.
  Never Funnel, port forwarding or a wildcard bind.

## Gateway side (`src/channels/app*.ts` in this repository)

### Listener

An opt-in `app` config block starts one HTTP server on an explicit loopback
port. `tailscale serve` terminates TLS with the node's `*.ts.net` certificate
(HTTPS is required for service workers and push) and proxies to it.

| Path | Purpose |
|---|---|
| `/` | The built PWA (static files from a configured absolute directory) |
| `GET /v1/stream` (WebSocket) | Events down, requests up |
| `POST /v1/pair` | One-time pairing exchange |
| `POST /v1/uploads` | Attachment upload, bounded size, stored under `media/app/` |
| `GET /v1/media/<id>` | Download of a file the agent sent to this chat |
| `POST /v1/push/subscription` | Store or replace this device's Web Push subscription |

Same origin for app and API: no CORS, and the device credential can be an
`HttpOnly; Secure; SameSite=Strict` cookie that the WebSocket handshake carries.

Tailscale Serve adds identity headers (`Tailscale-User-Login`). They are not
trusted on their own, since any local process can reach the loopback port and
forge them; the device token is the authority.

### Authentication

- `durable-nanobot app pair` prints a short-lived one-time code and a QR code in
  the owner's terminal.
- The app exchanges it for a long random device token. The gateway stores only
  a hash with a device label and can revoke by label.
- **iOS gotcha:** a home-screen web app has its own cookie and storage jar,
  separate from Safari. Pair from inside the installed app, not by opening a
  pairing link in Safari. The first-run screen says so.
- Unknown or revoked tokens are refused with fixed text.
- A paired device maps to one host-derived session key, validated as an ordinary
  mapped chat like any other channel.

### Adapter (`src/channels/app.ts`)

- Ingress: owner messages with `followUpMode`; attachments by reference to a
  finished upload.
- Egress: the existing durable outbox with a per-device cursor and ack. Unknown
  outcomes are held, never blindly resent.
- Owner controls (`/new`, `/abort`, `/status`, `/model`, `/digest`, `/restart`,
  `/mcp`) as typed requests, not parsed text.
- MCP login owner surface and `ask_user` surface, like CLI and Telegram.
- No new tool authority.

### Wake-ups (Web Push)

- VAPID key pair generated once by an explicit command, private key in a `0600`
  file under the canonical `dataDir`. Sending with the `web-push` npm package.
- One subscription per paired device; revoking the device deletes it. A `404`/
  `410` from the push service drops the subscription.
- Sent when an outbox record is admitted for a device with no live stream.
- Payload is encrypted end to end (RFC 8291) but still content-free by default:
  "New message", "Task finished", plus a deep link. A config switch may opt into
  a short preview later.
- A notification is a hint; the outbox stays the source of truth.
- App icon badge via the Badging API (`navigator.setAppBadge`).

## Wire protocol

JSON over one WebSocket, versioned in the handshake. Schema lives in this
repository under `protocol/` and both sides implement it. Unchanged from the
native plan:

Client to gateway (each with an id and a single reply): `hello` (version,
last acked cursor), `send` (text, attachment ids, client request key), `ack`,
`control`, `history`, `tasks`.

Gateway to client: `message`, `preview`, `status`, `activity`, `card`, `task`,
`settled`. Durable events carry a monotonic cursor; `preview` and `status` do
not and are replaced by the next one. Sends are idempotent by client request
key. Bounded sizes everywhere.

The local Unix-socket protocol is not reused: it trusts the filesystem and
carries host paths.

## App side (this repository)

### Stack (leaning; confirm in phase 0)

| Need | Use |
|---|---|
| Build | Vite, TypeScript |
| UI | React (needed for Streamdown); Preact if bundle size matters |
| Streaming markdown, code blocks, tables | Streamdown (handles incomplete markdown mid-stream) |
| Service worker, precache, push handler | Serwist or `vite-plugin-pwa` in `injectManifest` mode |
| Local store | IndexedDB via `idb` |
| Gateway push sender | `web-push` (VAPID) |
| QR pairing scan | Typing the code is enough; QR via camera only if cheap |
| Dictation | The system keyboard's own dictation |
| Network path | The Tailscale app on each device |

### Interface

One persistent thread with a character, not a list of chats.

- **Chat**: avatar and status pill, streaming markdown, attachments and cards,
  floating capsule composer (`+`, text, send).
- **Activity disclosure in three levels**: status pill, the turn's tool list,
  one tool's bounded raw output.
- **Tasks**: workers and cron jobs: needs input, working, scheduled, done.
- **Settings**: pairing, model preset, notifications, device list.

Details that matter:

- Connection state (offline, reconnecting, replaying) lives in the same pill as
  generating and running a tool.
- Per-message delivery state: queued on device, sent, admitted. Text typed
  offline is kept and sent on reconnect.
- Send becomes stop during a run; sending mid-run offers steer or queue.
- `/new` is a visible divider, not a new screen.
- Model preset chip in the header.
- Long-press: copy, quote, share (Web Share API).
- Code blocks scroll horizontally with a copy button; long tool output collapsed.
- Safe-area insets, `100dvh`, keyboard-aware composer: the usual iOS standalone
  web app pitfalls.

### Local store

IndexedDB holds received entries by cursor, pending outgoing messages and upload
state; the UI renders from it. iOS may evict web storage under pressure, so the
store is a cache: losing it means a full replay, nothing more.

## iOS platform notes

Verified by third-party sources, to confirm on the owner's phone in phase 0:

- Web Push works only for an installed home-screen web app (iOS 16.4+), after a
  permission prompt triggered by a user gesture. Not in a Safari tab.
- Declarative Web Push exists from iOS 18.4; not needed.
- Since iOS 26, any site added to the Home Screen opens as a web app by default.
- No install prompt (`beforeinstallprompt`); installation is Share → Add to Home
  Screen.
- No Web Share Target, no Background Sync; sockets die when backgrounded.
- EU standalone web app support was contested in 2024; irrelevant here, but it
  shows Apple's support can change.

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
| Service worker plumbing | Serwist or `vite-plugin-pwa` |
| Streaming markdown | Streamdown |
| TLS certificates | `tailscale serve` |
| Reachability | The Tailscale app; no embedded VPN |
| File and camera picking | `<input type="file" accept capture>` |
| Sharing out | Web Share API |

## Deliberately out of scope

- Multi-user accounts, sharing, sync between owners.
- Public exposure (Funnel, port forwarding, a public relay).
- A generative feed, app builder or connector marketplace UI.
- Native wrappers (Capacitor, Tauri) until the PWA proves insufficient.

## Open questions

1. Decided: the app has its own session; side threads are further sessions.
2. React + Streamdown, or Preact/Lit with a framework-free streaming renderer.
3. Serwist vs `vite-plugin-pwa`.
4. Cards: which model-facing mechanism produces them beyond host notices and
   approvals the gateway already knows about.
5. Whether the built PWA is served by the gateway from a configured directory
   (current lean) or by `tailscale serve` directly from disk.
