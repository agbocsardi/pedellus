# Durable App

Installable web app (PWA) for a personal [Durable Nanobot](../durable-nanobot)
gateway, reached over the tailnet with `tailscale serve`. Personal use only,
one owner.

Status: phase 1 app (`app/`) and phase 0 probe (`phase0/`) built; gateway channel in progress.

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the app and gateway fit together.
- [2026-11-18_pwa_TODO.md](./2026-11-18_pwa_TODO.md) — plan and work log.
- [docs/native-ios/](./docs/native-ios/) — parked native SwiftUI plan, kept for
  a possible later iOS app.

The gateway half (channel adapter, listener, push sender) lives in the
`durable-nanobot` repository. This repository holds the web app and the wire
protocol description both sides implement.
