# Durable iOS

Native iOS client for a personal [Durable Nanobot](../durable-nanobot) gateway.
Personal use only, sideloaded, one owner.

Status: design only. No code yet.

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the app and gateway fit together.
- [2026-11-15_ios-app_TODO.md](./2026-11-15_ios-app_TODO.md) — plan and work log.

The gateway half (channel adapter, listener, push sender) lives in the
`durable-nanobot` repository. This repository holds the Swift app and the wire
protocol description both sides implement.
