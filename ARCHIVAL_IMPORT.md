# Bounded archival import preparation (pure, no import)

`src/archival-import/index.ts` prepares immutable, versioned, lossless archival
records from host-supplied Python session/history bytes. It is a **preparation
slice only**: it performs no filesystem reads, no persistence, no database or
search-index writes, no gateway/runtime wiring, no replay, and no import
manifest or cursor advancement. The caller must acquire and label every byte
snapshot; this module never sees paths.

This is deliberately separate from [`MIGRATION.md`](./MIGRATION.md): that module
returns a bounded **inventory/review** report. This module returns the actual
raw-line records a future import transaction can consume, while retaining enough
provenance to reconstruct the input byte-for-byte. Neither module is an importer.

```ts
import { createHash } from "node:crypto";
import { prepareArchivalImport } from "./src/archival-import/index.js";

const bytes = hostSuppliedSessionBytes;
const report = prepareArchivalImport({
  storeNamespace: "operator-approved-store-1",
  sources: [
    {
      sourceId: "session-telegram-123",
      format: "session-jsonl",
      provenance: "operator-snapshot-2026-10-27",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    },
  ],
});
```

`sourceId`, `format`, `provenance`, and `storeNamespace` are bounded opaque
labels (`[A-Za-z0-9][A-Za-z0-9._:-]{0,159}`). `format` must already be a safe
identifier before it is accepted or echoed; paths, spaces, control characters,
and secrets are rejected with `ArchivalPreparationInputError` rather than being
copied into the report. Do not put paths, account names, chat IDs, or secrets in
the other labels. `sha256` must be lowercase hex over the exact supplied bytes;
it is verified before any parsing. The module copies the bytes once and never
mutates the caller's buffer.

Each invocation describes **one legacy store/workspace namespace**. Session keys
and archive cursors are store-local. The module echoes `storeNamespace` but
cannot infer or verify that the caller grouped sources correctly; mixing stores
remains a caller error.

## Supported schemas

### `session-jsonl` — Python `SessionManager` files

One physical line is one prepared record. Blank lines are preserved as
`blank-line` records, so every source byte is represented.

- The first non-blank record is expected to be the `_type: "metadata"` header.
  Header lines are prepared as `session-header` records; missing, duplicate, and
  out-of-order headers are diagnosed as failures without dropping any record.
  Only `key` and `updated_at` are exposed as safe structural search/provenance
  fields. The `metadata` object itself — usage, `_last_summary`,
  `compaction_checkpoints`, `runtime_checkpoint`, pending tool calls,
  `goal_state`, model preset, and any provider/application-specific values — is
  **opaque**. It is retained only inside the raw line and is never expanded into
  actions, summaries, checkpoints, or runnable state.
- `_type: "provider_state"` lines are prepared as `provider-state` records with
  `opaque: true` and no search projection. Python treats this as upstream
  provider-private continuation state; it is not interpreted here. It must never
  be replayed.
- Other lines are `session-message` records. Known roles are `user`,
  `assistant`, `tool`, and `system`. The record exposes role, timestamp,
  `_entry_id`, and a text-only search projection. `tool_calls`, `tool_call_id`,
  and tool results are retained in raw bytes and are **history only**, never
  pending or runnable calls.
- Unknown `_type` values, invalid UTF-8/JSON, non-object JSON, and message rows
  whose role/content/tool/media shape is not a recognized Python message shape
  become explicit `quarantined-line` records.

### `history-jsonl` — Python `memory/history.jsonl`

- Current v3 `kind: "conversation"` records, older structured records with
  `messages`, and legacy text records with `content` are prepared as
  `history-entry` records.
- The search projection contains one unit per embedded message (role,
  timestamp, name, entry ID, text), plus a legacy `content` unit and/or a
  `summary` unit. Message order is preserved; summary is appended last.
- Top-level `cursor` is exposed only when it is a non-negative safe integer.
  Usage fields, idempotency keys, and all other fields stay in the raw line.
- Missing/non-string `timestamp`, invalid `session_key`, a non-array `messages`
  field, no `content`/`summary`/`messages` body, or an unexpected `_type`
  quarantines the line with its raw bytes preserved.
- Embedded message rows that cannot be indexed add a diagnostic and make the
  line's `searchStatus` `partial`; they do not drop the physical line.

### `session-archive-jsonl` — Python `sessions/archive/<key>/<fingerprint>.jsonl`

Python's trimmed-prefix transcript batches are supported faithfully when the
host supplies each batch explicitly:

- The first non-blank record is expected to be `_type: "transcript_archive"`.
  It becomes an `archive-header` (opaque; exposes `key` only). Missing,
  duplicate, and out-of-order archive headers are diagnosed as failures without
  dropping records.
- Message rows → `archive-message` (same message-shape rules as sessions).
- The header's key is propagated to later archive messages in that snapshot.
- Archive batches are content-addressed by Python. This module does **not**
  deduplicate by content, filename, or cross-batch identity. Identical lines at
  different physical positions remain distinct records.

The filename is never read or trusted; only supplied bytes matter.

## Record provenance and lossless recovery

Every `PreparedArchivalRecord` has `recordVersion: 1` and carries:

- `ordinal` (global order), `sourceOrder` (caller-supplied position), `line`
  (one-based physical line), `byteOffset`, `byteLength`, and
  `lineTerminated`;
- `sourceId`, `sourceSha256`, and `lineSha256` over the **exact physical line
  bytes**, including any trailing LF/CRLF;
- `rawLineBase64` / `rawLineEncoding: "base64"` for the exact same bytes;
- `category`, `status`, `quarantineReason`, `opaque`, `searchStatus`, and
  `disposition: "archive-only-never-resume-or-replay"`;
- allowlisted structural identity (`sessionKey`, `timestamp`, `role`,
  `archiveCursor`) and a text-only `search` projection.

Concatenating `rawLineBase64` for one source in `ordinal` order reconstructs the
source bytes exactly, including blank lines, CRLF, and a final line without LF.
`lineSha256` is a line identity, not a deduplication key: the same bytes at two
positions produce two records with the same hash but different `ordinal`,
`line`, and `byteOffset`. No content-only deduplication is performed anywhere.

The search projection is deliberately **text-scoped**, and `searchStatus`
reports whether that scope covered the record. It must not be read as "every
field is indexed".

Indexed content:

- session/archive message: `role`, `content` text, `timestamp`, `name`, and
  `_entry_id`;
- history: top-level `timestamp`, `session_key`, `content`, `summary`, and
  `cursor`; each embedded message's `role`, `content` text, `timestamp`, `name`,
  and `_entry_id`.

`PreparedSearchUnit` carries role/timestamp/name/entry ID as separate searchable
metadata; they are not concatenated into `text`. A future index must index those
fields explicitly if it wants name/role lookups.

`searchStatus` values:

- `complete`: at least one search unit exists and **no content-bearing part of
  the record was omitted**;
- `partial`: a prepared record has no indexable units, or any content-bearing
  part was omitted (see below);
- `none`: the record is opaque, blank, or quarantined.

Omissions that force `partial`:

- a content array containing non-string, non-text, or unknown blocks;
- a text/content block with keys beyond `type` plus `text` (or `type` plus
  `content`), or a block carrying both text and content;
- non-empty `tool_calls` (IDs, names, arguments), `tool_call_id`, `media`,
  `thinking_blocks`, `cli_apps`, `mcp_presets`, or any other non-indexed message
  field with a value;
- non-empty history message `tools_used` or any other non-indexed history
  message field with a value;
- malformed embedded history messages, an invalid history cursor, non-string
  top-level content/summary fields, or indexed metadata strings
  (timestamp/name/entry ID/session key) that are too long or the wrong type to
  project;
- unknown history top-level fields with values.

Known operational/accounting history fields are intentionally outside the
search scope and do **not** alone force `partial`: `schema_version`, `kind`,
`start_time`, `end_time`, `message_count`, `usage`, and `_idempotency_key`. They
remain raw-only. Session-header metadata and `provider_state` payloads are opaque
and always have no search units, even when their raw bytes contain text-like
values; they are source-grade-sensitive archival data, not index input. Raw bytes
remain authoritative for every record.

## Quarantine

Malformed or unrecognized physical lines are never silently dropped. They become
`quarantined-line` records with `opaque: true`, no search units, a stable
`quarantineReason`, and their complete raw bytes. This covers invalid UTF-8,
invalid JSON, non-object JSON, unknown record types, and invalid known-record
shapes. Diagnostics contain only stable codes, source IDs, line numbers, and line
hashes — never parser error text or content.

## Bounds and failure behavior

Defaults: 32 sources, 4 MiB/source, 16 MiB total, 100,000 lines/source, 100,000
records, 200,000 search units, 2,000 nested references (tool calls or embedded
history messages) per line, and 10,000 diagnostics. Caller overrides cannot
exceed hard caps (128 sources, 16 MiB/source, 64 MiB total, 250,000 lines,
250,000 records, 500,000 search units, 10,000 nested references, 100,000
diagnostics).

The module **fails closed**. Exceeding any bound throws
`ArchivalPreparationBoundsError`; it never truncates input, drops trailing
records, or returns a partial report. A declared digest mismatch, duplicate
`sourceId`, unsafe source/format/provenance/store label, missing bytes, or
invalid limit throws `ArchivalPreparationInputError`. Unsupported source formats are different: they
are classified in `unsupportedSources`, make `complete: false`, and contribute
no records. The supported sources in the same request are still processed.

Each source `status` is `complete`, `incomplete`, or `unsupported`.
`complete: true` means every supplied source had a supported format, every
physical line produced a record, no line was quarantined, and no diagnostic with
`severity: "failure"` was emitted. Any failure diagnostic or quarantined line
also sets that source's `status` to `incomplete`; `complete` does **not** mean
all content was understood, searchable, reconciled, or imported.

Diagnostics carry `severity`:

- `failure`: structural classification is incomplete. This includes missing,
  duplicate, or out-of-order session/archive headers; invalid header key or
  non-object header metadata; inconsistent header keys; an unrecognized history
  `kind`; and an invalid history schema-version value.
- `notice`: the record is still classified, but optional metadata is invalid or
  some text content could not be projected into search units. Examples:
  invalid message timestamp/name/entry ID, invalid history cursor, or
  unindexable embedded history messages. Notices do **not** make the source or
  report incomplete; use `searchStatus` for text-search coverage.

Recognized opaque records (session headers, provider state) do not by themselves
make `complete` false. Quarantined and opaque records remain visible through
`counts`, `status`, `quarantineReason`, `searchStatus`, and `diagnostics`.
`reviewRequired` is always `true`.

Physical lines are split on LF only, matching the Python writer (`json.dumps` +
`"\n"`). A CR-only legacy file is not re-split into Python text-mode lines; it
is preserved as one physical line and will normally be quarantined as invalid
JSON. A final line without LF is accepted and marked `lineTerminated: false`.

## Unsupported surfaces (explicit)

`unsupportedSurfaces` records what this preparation does **not** read or infer:

- archive-batch containers (tar, zip, multi-file manifests, directory
  discovery) — supply one JSONL transcript archive as `session-archive-jsonl`;
- memory files, Dream history/cursors, `HISTORY.md`, session-archive discovery,
  action receipts, approvals, goals, cron/heartbeat/jobs, pairing/routes,
  skills, and media;
- any runtime/session continuation state or external effect.

Passing a safe, syntactically valid `format` that is not one of the three
supported values is not an error: it is classified as
`unsupported-source-format` with its own byte length and verified digest. An
unsafe, path-like, control-character, or overlong `format` label is rejected
before it can be echoed.

## Security and privacy exposure

Prepared records are **at least as sensitive as the source bytes** and are not a
redacted export:

- Raw transcript text, summaries, tool calls/results, session metadata,
  provider-private continuation state, usage, model presets, goals, checkpoints,
  and malformed/quarantined bytes are retained verbatim in `rawLineBase64`.
  Base64 is encoding, not encryption or redaction.
- Search units expose message/summary text directly. Session keys, message entry
  IDs, timestamps, and archive cursors can contain account/chat PII.
- Session metadata and provider-private records are intentionally opaque, but
  their byte content is still present and may contain credentials, provider
  tokens, internal endpoints, or private reasoning.
- The module performs no credential scanning, PII scrubbing, redaction,
  authorization, or retention policy. It does not know whether the caller is
  authorized to read the source.
- The output is an in-memory object. This module does not log or persist it, but
  the caller can. Treat reports, logs, dumps, test fixtures, and any serialized
  form as private archival material: private approved storage, restricted
  access, no automatic publication, no telemetry, and no inclusion in error
  reports.
- `storeNamespace`, `sourceId`, `format`, and `provenance` should remain opaque
  labels;
  putting paths, chat IDs, or secrets there would add exposure.

Do not run this on live data as part of the implementation check. Use synthetic
or separately authorized private copies.

## Deferred import work

This module does not provide a searchable database import. Still required before
any import claim:

1. A reviewed destination/store schema and access policy.
2. An import transaction with idempotence keyed by source + line identity
   (not content alone), crash/retry handling, and explicit handling of
   quarantined/opaque records.
3. Reconciliation of timestamps, session/archive identities, usage, count
   totals, and duplicate/collision policy.
4. A decision on indexed fields and retention for sensitive raw bytes.
5. Private-copy rehearsal, review, and owner approval.

Nothing here resumes a Python session, recreates a pending tool call, advances
an archive cursor, or writes to any store.

## Source references

The schemas above were derived from the Python writers/readers, not from live
data: `nanobot/session/manager.py` (`_load`, `_repair`, `save`,
`_archive_session_prefix`, `_PROVIDER_STATE_RECORD_TYPE`),
`nanobot/agent/memory.py` (`append_history`, `append_conversation_history`,
`_append_history_record`, `_valid_history_payload`, `_clean_history_messages`,
`read_unprocessed_history`), and `nanobot/session/recovery.py`
(provider-state checkpoint handling). The existing TypeScript inventory in
`src/migration/index.ts` was used only as a consistency reference for line
hashing, malformed-line handling, and unsupported-surface classification.

## Synthetic tests

`tests/archival-import-preparation.behavior.test.mjs` covers byte-for-byte raw
reconstruction (including CRLF and a final unterminated line), ordering and
source-order preservation, distinct records for identical lines, opaque
metadata/provider state, quarantine of malformed/unknown lines, text-search
completeness for mixed/tool/media/unknown content, missing/duplicate/out-of-order
session and archive headers, failure-vs-notice diagnostics, unsafe format label
rejection, history conversation/text search units, supported transcript archives,
unsupported format classification, every bound, digest/identity failures, deep
freezing, and caller-byte immutability. Run it with:

```bash
npm run build
node --test tests/archival-import-preparation.behavior.test.mjs
```
