# OpenClaw Telegram reuse assessment — 2026-10-26

Reference checkout: `/tmp/openclaw-telegram-reference` (read-only).
Repository: https://github.com/openclaw/openclaw
Commit: `5f1d487758a8560d083fbbd07fc1cc4203b7def8`.
No OpenClaw implementation has been copied into this package.

## Recommendation

Reuse selectively, not the entire channel plugin. Prefer grammY for Telegram's
client/types, adapt useful OpenClaw transport policies, and retain a small
Pi Durable admission/watch/delivery adapter. This would replace some hand-written
HTTP plumbing, not our durable state or exactly-once admission boundary. The owner approved this direction and it is now implemented with exact-pinned
grammY 1.46.0, manual typed API polling, and Durable-owned delivery state.
OpenClaw is credited in `README.md`.

## License

The checked-out root LICENSE is MIT, copyright 2026 OpenClaw Foundation.
Copying/adapting substantial portions is permitted with the copyright and MIT
permission notice retained. Any port should record original file paths, exact
commit, and local changes. Do not present copied code as original work.

## Why not drop in the plugin?

`extensions/telegram/package.json` is a private OpenClaw channel plugin with
workspace/plugin-SDK dependencies, not a standalone Telegram adapter. It uses
`grammy` 1.46.0 and `@grammyjs/transformer-throttler` 1.2.1, alongside other
OpenClaw-specific dependencies. These are observed upstream pins, not a chosen
local dependency set.

A rough source inventory, excluding obvious `.test.ts` and test-support/helper
files, is about 52k lines across 276 TypeScript files; this is not a dependency
closure or a claim that all files are needed. Many modules directly import
`openclaw/plugin-sdk/*`, routing, config, approvals, rich messages, runtime state,
and their own ingress/outbound queues. Copying those wholesale would recreate a
second framework around Durable rather than simplify nanobot.

## Useful source surfaces

- `extensions/telegram/src/account-throttler.ts`: shared bot-token flood deadline;
  later concurrent deadline wins; replaceable previews yield during penalties;
  final sends have a bounded wait budget; authorization rechecked before I/O.
  Depends heavily on OpenClaw runtime and grammY throttler lifecycle facilities.
- `extensions/telegram/src/network-errors.ts`: error classification, detailed
  unchanged-edit detection, missing edit targets, and the distinction between
  proven pre-connect failures and ambiguous failures of non-idempotent sends.
  In particular, blindly retrying sendMessage on a lost response can duplicate it.
- `extensions/telegram/src/send-edit.ts`, `draft-stream-message.ts`, and
  `telegram-text-delivery.ts`: edit success on unchanged text, preview/final
  delivery separation, formatting/chunk planning and fallback. Rich-formatting
  dependencies exceed this spike's plain-text scope.
- `extensions/telegram/src/polling-session.ts`: cancellation ownership and
  cleanup, reconnect/backoff and stall handling. It uses OpenClaw ingress workers
  and delivery queues; those are not appropriate to import here.
- `extensions/telegram/src/update-offset-persistence.ts` and
  `telegram-ingress-spool.ts`: durable admission before cursor catch-up, with
  spool-owned deduplication. Preserve the principle, but use Durable documents
  and request IDs instead of adopting the OpenClaw spool/runtime API.

## Current work

The socket-native worker implemented the approved narrow grammY migration and
selective policy adaptation; parent integration and offline validation passed.
Durable was not replaced, tools remain disabled, and no OpenClaw plugin/runtime
was imported. No upstream dependency install/application execution or live bot
call was run during this assessment. See TELEGRAM.md for delivery boundaries and
current verification.
