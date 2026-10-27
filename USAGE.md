# Native usage projection

This is an opt-in, read-only P4 foundation. `src/usage/index.ts` reads the
pinned Pi Durable 1.4.0 `UsageDoc` for **one conversation** and projects a
cumulative snapshot/delta. It does not install itself in the gateway, create a
second ledger, write `memory/history.jsonl`, archive automatically, reset a
conversation, or persist a cursor.

```ts
import { readUsageSnapshot, projectUsageDelta, parseUsageArchiveCursor } from "./usage/index.js";

const snapshot = await readUsageSnapshot(harness, conversation.id, context);
const cursor = savedJson === undefined
  ? undefined
  : parseUsageArchiveCursor(savedJson, conversation.id);
const projection = projectUsageDelta(snapshot, cursor);
// projection.legacy is the legacy token shape; projection.native preserves costs,
// tools and exact native provider/model keys. projection.nextCursor is only a proposal.
```

`readUsageSnapshot` calls `harness.snapshot(UsageDoc, conversationId, context)`;
it never calls `tx.doc()` and therefore never creates an absent usage document.
Snapshots and projections are detached and deeply frozen. Their string-keyed
maps have null prototypes, so names such as `__proto__` and `toString` remain
ordinary own keys. Malformed numeric rows, a mismatched cursor scope, a missing
current document, or a regressing cumulative counter fail closed.

## Source and attribution

The native `pi.usage` document is authoritative for this adapter:

- `models` is keyed by Durable's exact `provider/modelId` key. It includes
  committed assistant usage and compaction-summary attempts. Failed responses
  with returned usage are recorded when classified; a generation retry records
  its failed response before retrying. Compaction response usage is recorded in
  its classification commit. An abort/close before that commit, a request that
  never returns usage, or other uncommitted provider work may be absent. The
  ledger cannot distinguish “no request” from “request with unknown/uncommitted
  usage.” Pi AI's required numeric fields can also normalize provider fields that
  were not reported to zero; the adapter preserves that native zero but cannot
  tell whether the provider meant an actual zero.
- `tools` is keyed by tool name. Reported nested-call usage is counted under
  that tool, not again under the caller. Nested model calls therefore may not
  appear in the model bucket or retain per-model attribution there. Other
  conversations (including child conversations) have separate documents;
  `Harness.usage()` is a session-wide sum, not a cursor for this per-conversation
  adapter. Durable forks start with zero usage.
- The Usage schema stores token counters and cost totals, not request counts or
  individual usage events. `requestCount.status` is always `"unknown"`; no
  request count is estimated from tokens. Missing optional `reasoning` and
  `cacheWrite1h` values stay unknown, not zero. If an optional cumulative field
  appears only after a cursor, its delta cannot safely be apportioned and the
  affected field is listed in `unknownFields`.
- Native cost fields are preserved verbatim in `native`; they are provider/model
  cost calculations reported by Pi AI, not an invoice or proof of billing. A
  numeric zero is a recorded zero in the native ledger, not evidence that an
  external provider charged nothing. The package cannot recover usage that the
  provider omitted or Durable never committed.

The `legacy` projection contains only model-bucket token totals and per-model
rows; it intentionally has no `requests` field. Legacy `prompt_tokens` is
`input + cacheRead + cacheWrite` because Pi AI separates cached prompt tokens
from `input`. `cached_tokens` is `cacheRead` (cache writes are retained only in
`native`). `completion_tokens` is `output`, `total_tokens` is native
`totalTokens`, and reasoning is not added because Pi AI defines it as a subset
of output. The original native key is retained in `provider_model`; the familiar
legacy `provider` / `model` pair is split at the first `/`. Use `native.models`
for unambiguous source attribution and cost detail.

Tools are never folded into the legacy model-token totals. `native.models` and
`native.tools` hold independent counter/cost deltas; this avoids double-counting
nested usage and retains cost components, cache-write counts, and optional native
fields that the old archive shape cannot represent. When there is no model
usage delta, `legacy` is `{}` rather than fabricated all-zero totals. If a new
native row explicitly contains zero counters, its legacy row retains those
recorded zero values.

## Cursor and future archive transaction

A cursor is versioned and bound to one Durable conversation ID. It contains the
complete cumulative native snapshot last associated with a successful archive.
`projectUsageDelta(snapshot, cursor)` is deterministic: repeating it with the
same snapshot/cursor returns the same delta, while using its `nextCursor` again
returns no measured delta. It rejects another conversation's cursor and detected
counter regressions. Keep the returned `nextCursor` only after the corresponding
archive is durably committed; do not advance it merely because projection
succeeded.

This package does **not** make a history-file append and cursor update atomic.
A future archive owner must couple archive data and cursor in one durable
transaction, or use a durable outbox/idempotency protocol with explicit recovery
for “append succeeded, cursor did not” and “cursor advanced, append failed.” A
plain JSONL append followed by a separate cursor write can duplicate or lose
usage on a crash. Do not claim exactly-once external archive effects from this
helper. The cursor is conversation-scoped and cumulative, not aligned to
individual transcript entries; the P4 archive policy must establish which
messages and conversation usage belong together, including resets, compaction,
child conversations, and concurrent turns, before writing history.

## Compatibility references

- Root roadmap: `../../2026-10-26_full-port_TODO.md` (P4 usage/archive requirement).
- Python behavior reference: `nanobot/utils/usage.py`,
  `nanobot/agent/memory.py`, `nanobot/command/builtin.py`, and
  `nanobot/session/manager.py`. Python increments `requests` per normalized
  model response and stores a session-level `_usage_archived` watermark; native
  Durable has neither that request counter nor the same archive/session cursor.
- Pinned source: Pi tag `v1.4.0`, commit
  `4a080252f06caf63a525d7873c5d94d3c23887e0`, in the shared read-only checkout
  `/tmp/pi-durable-reference-1.4.0`. See Durable README “Usage and Cost”,
  `src/harness/usage.ts`, `src/harness/generation.ts`,
  `src/harness/compaction.ts`, `src/harness/tool.ts`, and spec §8.6–8.7; Pi AI
  `packages/ai/src/types.ts` defines `Usage` and its cache/reasoning semantics.
