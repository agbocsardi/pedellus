# Native usage projection

This is an opt-in, read-only P4 foundation. `src/usage/index.ts` reads the
pinned Pi Durable 1.4.0 `UsageDoc` for **one conversation** and projects a
cumulative snapshot/delta. It does not install itself in the gateway, create a
second ledger, write `memory/history.jsonl`, archive automatically, reset a
conversation, or persist a cursor.

```ts
// Also exported by the package SDK.
import { readUsageSnapshot, projectUsageDelta, parseUsageArchiveCursor } from "./usage/index.js";

// Supplied and persisted by the owning host; do not derive this from the Harness or DB path.
const storeNamespace = hostProvidedStableStoreNamespace;
const expectedScope = { storeNamespace, conversationId: conversation.id };
const snapshot = await readUsageSnapshot(harness, storeNamespace, conversation.id, context);
const cursor = savedJson === undefined
  ? undefined
  : parseUsageArchiveCursor(savedJson, expectedScope);
const projection = projectUsageDelta(snapshot, cursor);
// projection.legacy is the legacy token shape; projection.native preserves costs,
// tools and exact native provider/model keys. projection.nextCursor is only a proposal.
```

`readUsageSnapshot` reads `harness.snapshot(UsageDoc, conversationId, context)`
and tags the result with the supplied namespace; it never calls `tx.doc()` and
therefore never creates an absent usage document.
A fresh Durable Harness conversation has an empty `pi.usage` document from its
built-in creation commit, so its read is `available` with empty buckets—not an
unavailable document or fabricated zero usage. A plain Chord Session without
Durable's conversation creation hook (or legacy/corrupt storage) may have no
usage document; that remains `unavailable`. Snapshots and projections are
detached and deeply frozen. Their string-keyed maps have null prototypes, so
names such as `__proto__` and `toString` remain ordinary own keys. Token
counters (required and optional) and derived legacy sums must be nonnegative
safe integers. Known optional counters must also satisfy Pi AI's subset
invariants: `reasoning <= output` and `cacheWrite1h <= cacheWrite`. These
checks apply to snapshots, parsed cursor rows, and known-field deltas; two valid
cumulative rows that imply an impossible subset delta fail closed. Invalid
values, subset violations, and aggregate overflow fail closed without rounding
or clamping. Costs remain finite, nonnegative decimals. Malformed rows, a
mismatched cursor scope, a missing current document, or a regressing cumulative
counter fail closed.

## Source and attribution

The native `pi.usage` document is authoritative for this adapter. Durable
conversation IDs are storage-local and can collide across independent stores, so
every snapshot/read and cursor parse requires an opaque host-supplied
`storeNamespace`. It is a non-secret, non-blank string of at most 512 characters,
included in serialized `source` and compared alongside the conversation ID. The
host must persist it across reopen and guarantee it is unique for each
independently initialized store; reusing one namespace across stores defeats
this separation. The adapter does not infer it from a Harness or file path,
generate an ID, or keep a side ledger. Namespaces are compared
exactly (case-sensitive; not normalized).

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
- `tools` is keyed by tool name. Durable records a nested result's usage under
  the nested tool. If the caller forwards that same `usage` in its own result,
  Durable records it again under the caller tool. `UsageState` has bucket totals
  but no call provenance, so this projection preserves both native rows as
  recorded and cannot identify or deduplicate that duplication. Nested model
  calls may not appear in the model bucket or retain per-model attribution there.
  Other conversations (including child conversations) have separate documents;
  `Harness.usage()` is a session-wide sum, not a cursor for this per-conversation
  adapter. Durable forks start with zero usage.
- The Usage schema stores token counters and cost totals, not request counts or
  individual usage events. `requestCount.status` is always `"unknown"`; no
  request count is estimated from tokens. Missing optional `reasoning` and
  `cacheWrite1h` values stay unknown, not zero. Present values are validated
  against their required-counter subset. If an optional cumulative field appears
  only after a cursor, its delta cannot safely be apportioned and the affected
  field is listed in `unknownFields`, not emitted as zero. After an optional
  cumulative value exists, Durable leaves it unchanged when a later response omits
  that field; this projection cannot detect the omission and can return a zero
  **recorded** delta without an `unknownFields` entry. Optional totals/deltas are
  reported-ledger subtotals, not proof of actual provider zeros or completeness.
- Native cost fields are preserved verbatim in `native`; they are provider/model
  cost calculations reported by Pi AI, not an invoice or proof of billing. A
  numeric zero is a recorded zero in the native ledger, not evidence that an
  external provider charged nothing. The package cannot recover usage that the
  provider omitted or Durable never committed.

The `legacy` projection contains only model-bucket token totals and per-model
rows; it intentionally has no `requests` field. Legacy `prompt_tokens` is
`input + cacheRead + cacheWrite` because Pi AI separates cached prompt tokens
from `input`. `cached_tokens` is `cacheRead` (cache writes are retained only
in `native`). These conversions preserve safe-integer token counts exactly; they do not round
fractions, clamp values, or replace overflow with a sentinel. `completion_tokens`
is `output`, `total_tokens` is native `totalTokens`, and reasoning is not added
because Pi AI defines it as a subset of output. The original native key is
retained in `provider_model`; the familiar legacy `provider` / `model` pair is
split at the first `/`. Use `native.models` for unambiguous source attribution
and cost detail.

Tools are never folded into the legacy model-token totals. `native.models` and
`native.tools` preserve bucket-specific counter and cost deltas Durable recorded,
including cost components, cache-write counts, and optional native fields that
the old archive shape cannot represent. The projection does not add another
source count, but it cannot deduplicate usage Durable already recorded twice
because a caller forwarded nested `usage`. The legacy shape remains
model-only and never folds tool buckets into model totals.
When there is no model usage delta, `legacy` is `{}` rather than fabricated
all-zero totals. If a new native row explicitly contains zero counters, its
legacy row retains those recorded zero values.

## Cursor and future archive transaction

A cursor is versioned and bound to the pair of host `storeNamespace` and Durable
conversation ID. It contains the complete cumulative native snapshot last
associated with a successful archive. `parseUsageArchiveCursor` requires the
expected pair, and `projectUsageDelta` checks both components against the current
snapshot. Thus equal numeric IDs in independently namespaced stores do not share
cursors. Cursors must come from trusted host-owned durable state: validation is
structural and scope-based, not authenticity or rollback protection. A valid
same-scope cursor with older/lowered totals is accepted and can re-emit usage;
this helper has no MAC, signature, or separate freshness watermark. Do not load
untrusted cursor JSON as archive state. Projection is deterministic: repeating
it with the same snapshot/cursor returns the same delta, while using its
`nextCursor` again returns no measured delta. It rejects another source scope
and detected counter regressions. Keep the returned `nextCursor` only after the
corresponding archive is durably committed; do not advance it merely because
projection succeeded.

This package does **not** make a history-file append and cursor update atomic.
The host namespace is only an identity contract; it does not prove storage
ownership, prevent the host from reusing a namespace, or make a cursor
transaction durable. A future archive owner must couple archive data and cursor
in one durable transaction, or use a durable outbox/idempotency protocol with
explicit recovery for “append succeeded, cursor did not” and “cursor advanced,
append failed.” A plain JSONL append followed by a separate cursor write can duplicate or lose
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
