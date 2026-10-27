# Bounded legacy migration inventory (dry-run only)

`src/migration/index.ts` accepts explicit host-supplied byte snapshots and returns a deterministic, versioned inventory for human review. It performs **no import, normalization, repair, cutover, destination writes, database access, file traversal, or environment/config reads**. The caller must acquire and label each byte snapshot; this module does not know paths.

```ts
import { inventoryLegacySnapshots } from "./src/migration/index.js";

const report = inventoryLegacySnapshots([
  {
    sourceId: "session-telegram-123",
    format: "session-jsonl",
    provenance: "operator-snapshot-2026-10-27",
    bytes: hostSuppliedSessionBytes,
  },
]);
```

`sourceId` and `provenance` are bounded opaque labels (`[A-Za-z0-9._:-]`); do not put paths, account names, or secrets in them. Input bytes are copied before hashing/parsing and never changed. The report has format `nanobot-legacy-migration-dry-run`, version `1`, target Durable `1.4.0`, and always declares `reviewRequired`. It contains no raw transcript text, summaries, message content, tool arguments/results, goal objectives, config credentials/provider values, arbitrary metadata objects, or parser error text. It includes source SHA-256, exact line SHA-256 (raw line bytes including LF), source/line provenance, allowlisted original IDs/session keys/timestamps/lineage, schema counts, and static next-step mapping hints. Identifier-like values that look credential-bearing, exceed bounds, or contain control characters are replaced with `null` plus a digest.

## Supported input schemas

Each `session-jsonl` snapshot represents one Python `SessionManager` file:

- Line 1 is expected to be the `_type: "metadata"` object with `key`, `created_at`, `updated_at`, `metadata`, and `last_consolidated`.
- Each later nonblank line is inventoried as a session message. Known Python message fields used for this report are `role`, `timestamp`, `_entry_id`, `tool_calls[].id`, `tool_call_id`, and `name`. Their content and arguments are never copied into the report.
- Session metadata is inspected only through an allowlist: `_nanobot_model_preset`, `compaction_checkpoints` boundary IDs, `usage`, `_usage_archived`, `goal_state` / legacy `thread_goal`, `runtime_checkpoint`, `pending_user_turn`, and the presence of `_last_summary`. Other metadata is counted, never dumped. A checkpoint, pending user turn, or active/unknown goal is marked for manual reconciliation. No checkpoint is resumed and no pending tool call is recreated.
- Message IDs, keys, timestamps, duplicate IDs/keys (including cross-session ID collisions), and checkpoint boundaries are reported without synthesizing missing IDs, repairing invalid values, or applying Python's repair/sanitization behavior. Tool calls and results are explicitly history-only; a pending call is never a native runnable call.

Each `history-jsonl` snapshot is a Python `memory/history.jsonl` byte stream:

- Current structured records are schema v3 `kind: "conversation"` with `timestamp`, `start_time`, `end_time`, `session_key`, `message_count`, `messages`, optional `summary` / `usage` / `_idempotency_key`, and a `cursor`.
- Older text and structured records are inventoried when they have the legacy `timestamp` plus `content` or `messages` shape. Unknown shapes are reported, not dropped into a guessed schema.
- The report preserves cursor, source/line hashes, timestamps, message count and a digest of the optional idempotency key. The legacy history cleaner omits per-message entry IDs, so the report explicitly marks embedded message lineage unavailable. A duplicate or missing cursor makes usage unsuitable for aggregate counting.
- The history text, summary, message contents and arbitrary additional fields are not emitted.

A `config-json` snapshot is one decoded legacy config object. The planner recognizes `model_presets` / `modelPresets`, the implicit default preset, `agents.defaults` model/provider/preset settings, `run_presets` / `runPresets`, and counts configured built-in/dynamic provider keys. Preset records emit only allowlisted model/provider identifiers and selected numeric/boolean generation settings. Provider credential values, URLs, headers, arbitrary provider fields and environment substitutions are omitted. This is **not** Python/Pydantic validation; alias ambiguity and malformed shapes are reported for review.

## Durable mapping hints (not an importer)

The pinned Durable `1.4.0` source treats conversations as immutable entries with `id`, `conversationId`, `kind`, optional model messages/data, and ancestry (`parent.conversationId` + `parent.at`). Its built-in transcript entries include `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, and `pi.reset`; Pi AI messages use roles `user`, `assistant`, and `toolResult` (not Python `tool`). The inventory marks simple legacy user/assistant messages with candidate entry kinds. Legacy tool calls/results and all archive records instead map to `nanobot.legacy.history` and are marked history-only. No conversion to Pi AI messages, entry IDs, reset boundaries, fork ancestry or session-map identities happens here. A future importer must not replay historical calls/results through a native tool executor.

Pinned source references: `/tmp/pi-durable-reference-1.4.0/packages/durable/README.md` (entries and transcript flow), `packages/durable/src/types.ts` (`ConversationRecord`, `EntryRecord`, `EntryDraft`), `packages/durable/src/harness/types.ts` (submission/reset/conversation contracts), and `packages/ai/src/types.ts` (`UserMessage`, `AssistantMessage`, `ToolResultMessage`). Python schema references are `nanobot/session/manager.py` (`_load`, `save`, session metadata/message lines), `nanobot/agent/memory.py` (`append_conversation_history`, usage/archive behavior), `nanobot/config/schema.py`, `nanobot/agent/model_presets.py`, `nanobot/command/builtin.py` (`/new`), `nanobot/session/goal_state.py`, `nanobot/agent/loop.py` (runtime checkpoints), and `nanobot/agent/tools/action_receipts.py`.

## Limits, incompleteness and usage

Default bounds are 64 sources, 4 MiB/source, 16 MiB total, 100,000 lines/source, 50,000 report records, 500 diagnostics, and 256 nested references; caller overrides cannot exceed hard caps (256 sources, 16 MiB/source, 32 MiB total, 250,000 lines, 100,000 records, 2,000 diagnostics, 1,024 references). Over-limit sources are explicitly incomplete/not processed; records/issues are never silently truncated. `complete` describes only whether the supplied supported snapshots were fully scanned and structurally inventoried; it does not mean all legacy surfaces were supplied or P8 is complete. `complete: false`, per-source status, `unprocessedLines`, and omitted diagnostic counts identify partial reports. An over-byte-limit source has no checksum because hashing it would exceed the configured work bound. A malformed final non-newline line is labeled possibly truncated; a valid final JSON line without LF is accepted as-is.

Usage is an observation, not an accounting migration:

- Archive `usage` uses Python's sparse per-archive delta fields (`prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`, `requests`); absent fields in a present sparse delta are reported as zero for that record. Missing/invalid usage is counted as unknown/invalid. Duplicate/missing archive cursors are excluded from sums.
- An active session delta is reported only when both cumulative `metadata.usage` and `_usage_archived` watermark exist and contain valid counters. Missing watermark, absent counters, invalid values and regressions remain unknown/invalid; no zero watermark is invented. Provider/model breakdown is neither emitted nor reconciled.
- Archived reported subtotals and exact active deltas stay separate; same snapshots and limits produce a deterministic report, not importer idempotence evidence. `/new` clears active usage and watermarks while appending the final archive asynchronously; session-key reuse and reset boundaries are not enough to prove a lifetime total. The report therefore does not claim exact overall conservation and never assigns legacy usage to native `pi.usage`. Native usage requires a reviewed import transaction with explicit reconciliation.

`unsupported` explicitly lists memory/Dream files and cursors, `HISTORY.md`, session archive files, action receipts, approvals, jobs/cron/heartbeat/subagents, pairings/routes, skills/media, and provider-private state. These are outside this inventory, not evidence that they are absent.

## Required gates before any importer or cutover

1. Freeze actual source schemas and decide treatment for legacy session archives, history versions, compaction checkpoints, resets/`/new`, usage watermarks, providers/presets, memory/Dream state, receipts/approvals, active goals/jobs, pairing/routes, skills and media. Unknown or unavailable inputs remain explicit.
2. Review session-key mapping/collision policy, reset and compaction boundaries, transcript rendering, IDs/lineage and unsupported records. Select host-owned Durable store namespace, data directory, identities and privacy policy; do not derive them from legacy IDs alone.
3. Reconcile archived deltas, active watermarks, unknown/missing spend and `/new` cycles from a private copy. Preserve report/source hashes and records in a reviewed, versioned import transaction; establish crash/retry/idempotence behavior without appending duplicate turns or usage.
4. Manually classify active/unknown Python checkpoints, pending calls, goals, receipts, approvals, schedules and external effects. No task is resumed automatically; ambiguous side effects stay held for operator reconciliation.
5. Implement only after separate design/review of destination writes, manifest/checkpoint durability, rollback, backup/restore, restart and repeat-import evidence. Keep original inputs unchanged and make a fresh isolated destination.
6. Run private synthetic and representative private-copy reconciliation first. Live credentials, histories, network/model calls, cutover, rollback, Python retirement and deployment each require separate owner authorization.

This bounded inventory is one P8 planning primitive only. It has no persistence, archive writer, import manifest, cursor advancement, destination transaction, migration server or runtime/config/CLI integration. It does not pass P8 or authorize production cutover.
