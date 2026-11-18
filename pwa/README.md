# Durable App

Installable web app (PWA) for a personal [Durable Nanobot](../README.md)
gateway, reached over the tailnet with `tailscale serve`. Personal use only,
one owner.

Status: app (`app/`) and gateway `app` channel (`../src/channels/app*.ts`,
[../APP.md](../APP.md)) both speak protocol v2; offline-verified, not yet
deployed.

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the app and gateway fit together.
- [2026-11-18_pwa_TODO.md](./2026-11-18_pwa_TODO.md) — plan and work log.
- [docs/native-ios/](./docs/native-ios/) — parked native SwiftUI plan, kept for
  a possible later iOS app.

This directory holds the web app and the wire protocol both sides implement;
the gateway half lives in this repository's `src/channels/`. It was a separate
`durable-app` repository until 2026-11-18 (history kept via git subtree).
