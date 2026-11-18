# iOS app plan

> **Parked (2026-11-18).** The project moved to a PWA (see `../../ARCHITECTURE.md`).
> This native SwiftUI plan is kept for a possible later iOS app. The gateway
> half and wire protocol are shared, so it would be a second client, not a redesign.

Each phase ends with something usable on the phone. Gateway work happens in
`durable-nanobot`; app work happens here.

## Phase 0 — decisions

- [x] Developer programme: free Apple ID for now, wake-ups through ntfy
- [x] Session model: the app has its own session
- [x] Notification body: content-free by default
- [ ] ntfy topic on the public server or self-hosted
- [ ] Throwaway Xcode project: confirm which capabilities a free Apple ID signs
- [ ] Read the prior-art projects listed in ARCHITECTURE.md
- [ ] Transport security on the tailnet: plain HTTP vs tailnet certificates
- [ ] Write `protocol/` schema v1 (messages listed in ARCHITECTURE.md)

## Phase 1 — text chat end to end

Gateway:
- [ ] `app` config block, default off, explicit bind address
- [ ] Listener: WebSocket stream, bounded frames, fixed error text
- [ ] Pairing command, hashed device tokens, revoke by label
- [ ] `src/channels/app.ts`: ingress, outbox egress, per-device cursor and ack
- [ ] Events: `message`, `preview`, `status`, `settled`
- [ ] Regression tests with a synthetic client and controlled clock

App:
- [ ] Xcode project, `Core` package, protocol types
- [ ] Connection with reconnect, cursor replay, idempotent send
- [ ] Local store; chat renders from the store
- [ ] Pairing screen (code entry, QR scan)
- [ ] Chat screen: streaming markdown, composer, status pill

Done when: a message typed on the phone gets a streamed answer, and killing the
app mid-answer loses nothing on reopen.

## Phase 2 — notifications

- [ ] Gateway: notifier interface with an ntfy sender, send-when-offline rule
- [ ] App: URL scheme and deep-link handling into the right thread
- [ ] App: local notifications for events that arrive while it is running
- [ ] Cron and worker results trigger a wake-up
- [ ] Weekly re-signing routine written down

Done when: a scheduled reminder reaches a locked phone.

## Phase 3 — files

- [ ] Gateway: upload endpoint, `media/app/` storage, download endpoint
- [ ] App: attach from Photos, Files and camera; background upload
- [ ] Share extension with App Group store
- [ ] Render files and images the agent sends

## Phase 4 — system integration

- [ ] App Intents: Ask, Send file, New chat, Run named prompt
- [ ] Shortcuts and Siri phrases, Spotlight, Action button
- [ ] Dictation in the composer
- [ ] Lock-screen widget and Control Center control

## Phase 5 — agent surface

- [ ] Events: `activity`, `task`, `card`
- [ ] Three-level activity disclosure
- [ ] Tasks tab: workers and cron jobs, cancel by id
- [ ] Owner controls as native UI: model picker, status sheet, new context
- [ ] Approval and quick-reply cards
- [ ] Side threads (channels)
- [ ] MCP login owner surface

## Phase 6 — polish

- [ ] Live Activity for running turns and workers
- [ ] Avatar states driven by `status`
- [ ] Voice mode (audio to the gateway's transcription path)
- [ ] Morning brief as a cron job with a dedicated notification category
- [ ] Watch app (only if still wanted)

## Log

### 2026-11-15

- Repository created with architecture overview and this plan. No code.
- Researched the reference apps (Meta Muse, Claude Duet, ChatGPT dots). Shared
  pattern: one persistent thread with a character, a status pill, drill-down
  activity, a tasks view, approval cards, proactive notifications. Duet's
  screen-level detail came from an unofficial clone specification, so it is
  inspiration, not a reference.
- Decided: separate repository from the gateway; tailnet-only listener; typed
  event protocol rather than rendered text.
- Finding: remote push needs the paid developer programme. A free Apple ID
  cannot sign the push entitlement.
- Owner decisions: stay on a free Apple ID; the app gets its own session.
  Wake-ups therefore go through ntfy, content-free, with a deep link. The
  notification service extension and reply-from-notification are dropped.
- Added prior art, a do-not-build table and interface details to
  ARCHITECTURE.md.
- Unverified: the exact capability list for a free Apple ID, and whether an
  ntfy tap action opens a custom URL scheme on iOS. Both are phase 0 checks.
- Next: remaining phase 0 checks, then the protocol schema.
