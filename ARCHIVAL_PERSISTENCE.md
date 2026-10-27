# Transactional archival persistence (data-only custom entries)

`src/archival-persist/index.ts` is the persistence slice for the bounded
preparation in [`ARCHIVAL_IMPORT.md`](./ARCHIVAL_IMPORT.md). It accepts the
host's **original explicit snapshots**, recomputes
`prepareArchivalImport()` internally, re-validates the recomputed records, and
commits them as inert data-only custom Durable entries.

It is deliberately **not** a complete importer and does not deliver search:

- no model entries, runnable tasks, submissions, live session map, or resumed
  Python session;
- no search index, ranking, or browse API;
- no archive-cursor advancement, cursor edits, or replay;
- no filesystem discovery, network access, direct SQL, or new CLI surface.

```ts
import { persistArchivalImport, readArchivalImportLedger } from "./src/archival-persist/index.js";

const report = await persistArchivalImport(harness, {
  storeNamespace: "operator-approved-store-1",
  sources: [
    {
      sourceId: "session-telegram-000",
      format: "session-jsonl",
      provenance: "operator-snapshot-2026-10-27",
      sha256: hostComputedSha256,
      bytes: hostSuppliedBytes,
    },
  ],
}, context);

const ledger = await readArchivalImportLedger(harness, context);
```

`harness` is any Durable `Session` (a native `Harness` or `createSession()`
result). The caller supplies the `Context`.

## Input boundary and record validation

The only input is `{ storeNamespace, sources }`, the same shape
`prepareArchivalImport()` accepts. Preparation is always recomputed from the
supplied bytes. Extra caller fields such as `records` or `report` are ignored;
a forged prepared report cannot request different persisted bytes. The module:

- verifies that the recomputed report is
  `nanobot-archival-import-preparation` version 1;
- requires contiguous global `ordinal` values and consistent `sourceOrder`;
- requires each source's records to be exactly its physical lines, in order;
- decodes every `rawLineBase64` canonically, checks its declared
  `byteLength`, and re-hashes it against `lineSha256`;
- requires per-source concatenated raw bytes to reconstruct the source
  `byteLength` exactly (blank lines, CRLF, and a final unterminated line);
- validates classification fields, search-unit order/kinds, and the
  `archive-only-never-resume-or-replay` disposition.

Unsupported source formats are not parsed and have no line records. They are
recorded in the ledger with `preparationStatus: "unsupported"` and
`recordCount: 0`; their raw bytes are not persisted by this slice. That is
explicit in the report and in the limitations, not presented as a complete
import.

## Identity, idempotence, and conflict policy

The durable ledger is the session-scoped document kind
`nanobot.archival-import-ledger`. It stores:

- exactly one `storeNamespace` per database (`null` before the first import);
- one source row per `sourceId` with `sha256`, format, provenance, byte length,
  line count, preparation status/version, record count, conversation ID,
  first/last entry ID, and first/last ordinal.

Per-source identity is `(storeNamespace, sourceId)` with the exact `sha256` and
metadata. Repeating the exact snapshots is idempotent: no conversation, entry,
or ledger write is added, and the existing conversation ID is returned. If the
same `sourceId` arrives with a changed digest, changed format/provenance, or
changed preparation identity, the call throws
`ArchivalPersistenceConflictError`; it never overwrites, drops, or duplicates
the source. A second, different `storeNamespace` is rejected for the same
database because legacy session keys and archive cursors are store-local.

Line SHA-256 is provenance only. Identical physical lines at different
positions are separate entries; there is no content-only deduplication.
Unknown record types, invalid UTF-8/JSON, non-object JSON, and malformed known
shapes are persisted as `quarantined-line` entries with their exact raw bytes.

## Transaction and crash/retry design

All sources in one call are committed in **one** `Session.commit()`:

1. read the session-scoped ledger;
2. reject namespace or existing-source conflicts for every source;
3. create one ownerless Durable conversation per new supported source;
4. append one custom `nanobot.archival-record.v1` entry per prepared physical
   line;
5. write the source rows into the ledger.

The conversation(s), every custom entry, and the ledger row(s) are in one
atomic storage commit. A process crash before or during the commit leaves no
source records and no ledger row. A crash after the commit leaves both, so a
retry finds the same digest and returns the idempotent result. The module does
not retry a failed storage commit itself: Durable's Session treats that error as
final and the host reopens/replays the request from committed state.

The ledger's `firstEntryId`/`lastEntryId` are spot-checked on repeat
(conversation presence, kind, source identity, ordinal). A missing or foreign
carrier throws `ArchivalPersistenceCorruptionError` rather than silently
re-appending records.

## Stored entry shape

Each entry is kind `nanobot.archival-record.v1`, with no `model`, `head`, or
`edits`, so Durable's context builder treats it as display-only bookkeeping.
The `data` payload contains the prepared record fields plus source provenance:
store namespace, `sourceId`, source format/provenance/SHA-256, ordinal, source
order, line number/offset/length, termination flag, line SHA-256, category,
prepared/quarantined status, quarantine reason, opacity, search status,
allowlisted session/timestamp/role/archive-cursor fields, the text-only search
units, and the exact `rawLineBase64` bytes.

No task, submission, model message, `pi.user`/`pi.assistant` entry, inbox item,
live session-map row, or Python session is created. The per-source conversation
is an archival carrier, not a runtime conversation reachable through the live
session map.

## Bounds

Defaults mirror what the preparation defaults can produce; overrides cannot
exceed the hard caps:

| Bound | Default | Hard cap |
|---|---:|---:|
| `maxSources` | 32 | 128 |
| `maxRecordsPerSource` | 100,000 | 250,000 |
| `maxRecords` | 100,000 | 250,000 |
| `maxRawBytesPerSource` | 4 MiB | 16 MiB |
| `maxRawBytes` | 16 MiB | 64 MiB |
| `maxSearchUnitsPerSource` | 200,000 | 500,000 |
| `maxSearchUnits` | 200,000 | 500,000 |
| `maxLedgerSources` | 512 | 1,024 |

Exceeding a bound throws `ArchivalPersistenceBoundsError` before any write.
Unknown/invalid limit keys throw `ArchivalPersistenceInputError`. Preparation
bounds/input errors from `prepareArchivalImport()` propagate unchanged.

## Privacy and sensitivity

Persisted entries are **at least as sensitive as the original source bytes** and
are not a redacted export:

- raw transcript text, session metadata, provider-private continuation state,
  tool calls/results, goals/checkpoints, and malformed/quarantined bytes are
  stored verbatim base64 — encoding, not encryption or redaction;
- search-unit text and allowlisted session keys/timestamps/entry IDs/archive
  cursors are stored as separate fields and can contain account/chat PII;
- the ledger exposes source labels, digests, byte counts, and conversation/entry
  IDs, but not record content;
- the module performs no credential scanning, PII scrubbing, authorization, or
  retention policy, and does not know whether the host is authorized to read
  the source.

Treat the database, backups, logs, dumps, and test fixtures as private archival
material: restricted access, no telemetry, no automatic publication, and no
inclusion in error reports. `storeNamespace`, `sourceId`, `format`, and
`provenance` are opaque labels; do not put paths, chat IDs, account names, or
secrets in them.

Do not run this against live user data as part of implementation checks. The
tests use synthetic SQLite databases and synthetic snapshots only.

## Remaining import work (explicitly not delivered)

This slice does not provide a searchable import or an end-to-end migration.
Still required before any import claim:

1. a reviewed search/index projection over the persisted custom entries;
2. reconciliation of timestamps, session/archive identity, usage, counts, and
   duplicate/collision policy;
3. retention policy for sensitive raw bytes and a restore/rollback rehearsal;
4. an authorization and operator-approval flow for a real private copy;
5. an explicit decision that no Python session, pending tool call, or archive
   cursor will ever be resumed from archived data.

## Tests

`tests/archival-import-persistence.behavior.test.mjs` uses temporary synthetic
SQLite databases and a native `Harness` to cover byte-for-byte entry
persistence, custom-entry-only/model-free entries, duplicate-line preservation,
quarantine/provider-state preservation, ledger identity, in-process repeat,
restart repeat, changed-digest/namespace conflict rejection, forged prepared
records being ignored, no tasks/submissions/session-map state, unsupported
format honesty, persistence bounds before writes, and a failed storage commit
leaving no ledger/conversation/entry.

```bash
npm run build
node --test tests/archival-import-persistence.behavior.test.mjs
```
