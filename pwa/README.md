# Pedellus app

Installable web app (PWA) for a personal [Pedellus](../README.md)
gateway, reached over the tailnet with `tailscale serve`. Personal use only,
one owner.

Status: the app (`app/`) and the gateway's `app` channel
(`../src/channels/app*.ts`, [../APP.md](../docs/APP.md)) both speak protocol v2, and
the features below are on `main`. Offline-verified only: no check has run
against a real device or a live `tailscale serve`, and the supervised deployment
is still pending.

Shipped: threads with side threads, forks, archiving and search; model preset
chip and command toolbox; whole answers with long-message splitting; activity
disclosure; owner questions; owner reactions; the Tasks sheet; files (upload,
attach, render, offline queue); voice notes; Web Push (permission, service
worker notifications, badge, thread deep links, VAPID key rotation); the wide
layout with keyboard shortcuts; MCP login cards; agent-sent files and the
sandboxed artifact viewer.

The gateway also serves `POST /v1/ask` for iOS Shortcuts (APP.md, *Shortcuts*).

- [protocol/v2.md](./protocol/v2.md) — the normative wire contract.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — components, data flow, every op and
  route, storage, security model, known gaps.
- [app/README.md](./app/README.md) — dev workflow and the mock gateway's
  affordances.
- [../GETTING_STARTED.md](../docs/GETTING_STARTED.md#installable-web-app-pwa) — build,
  serve and pair it on a real gateway.
- [docs/native-ios/](./docs/native-ios/) — parked native SwiftUI plan, kept for
  a possible later iOS app.

This directory holds the web app and the wire protocol both sides implement;
the gateway half lives in this repository's `src/channels/`. It was a separate
`durable-app` repository until 2026-11-18 (history kept via git subtree).
