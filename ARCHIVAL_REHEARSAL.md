# Offline archival import rehearsal (operator-facing)

`src/archival-rehearsal/index.ts` is the one-step, offline rehearsal that
connects the existing slices:

```
acquireLegacySourceSnapshots()
  -> persistArchivalImport()          (apply only)
  -> readArchivalImportLedger()       (apply only)
  -> searchPersistedArchivalImport()  (apply only, explicit query)
```

It is deliberately not an importer, a live-store reader, a runtime command, or
a package-script/CLI addition. The caller must supply an explicit, dedicated
copy and an explicit, private destination. Nothing is inferred from
`~/.nanobot`, the current directory, or environment paths.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runArchivalImportRehearsal } from "./src/archival-rehearsal/index.js";

const rehearsal = await runArchivalImportRehearsal({
  sourceRoot: "/srv/rehearsal/source-copy",       // quiescent/synthetic copy
  destinationDir: "/srv/rehearsal/private-store", // existing 0700 directory
  workspace: "/srv/rehearsal/workspace",          // must be disjoint
  storeNamespace: "operator-rehearsal-1",         // opaque, caller-supplied
  // apply: true,                                  // absent => dry-run, no writes
  // search: { query: { text: "synthetic needle" } },
}, BACKGROUND_CONTEXT);

if (rehearsal.status === "blocked") {
  // Inspect rehearsal.blockers (stable codes only) before retrying.
}
```

## Dry-run is the default

Without `apply: true` the module:

- validates all three paths and their disjointness/privateness;
- acquires the source snapshot through the existing no-follow boundary;
- runs the existing preparation API per acquisition batch;
- returns per-batch preparation summaries.

It does **not** open, create, migrate, lock, or write the destination database.
A dry-run leaves the destination directory untouched. It does read the source
copy and perform in-memory preparation.

`apply: true` is the only write mode. It writes only the supplied snapshot
bytes into the explicit destination database and then optionally inspects the
ledger and performs one bounded search.

## Source boundary

`sourceRoot` is passed unchanged to `acquireLegacySourceSnapshots()`:

- only `sessions/*.jsonl`, `sessions/archive/*/*.jsonl`, and
  `memory/history.jsonl` are discovered;
- candidate files are opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` through
  pinned directories and verified before, during, and after the read;
- hard links, symlinks, non-regular files, changed files/directories, and
  unreadable surfaces fail closed;
- `/`, the account home (passwd and environment), `~/.nanobot`, anything with a
  `.nanobot` component, the temp root itself, and `/proc`, `/sys`, `/dev` are
  refused as the source root.

Any incomplete acquisition, zero discovered sources, or zero expected surfaces
stops the rehearsal before the destination is opened. The report keeps the
acquisition's stable diagnostic codes, surface status, missing-surface list,
and opaque source labels. No partial batch is exposed.

The caller remains responsible for pointing at a quiescent/synthetic copy. The
module cannot prove quiescence or synthetic provenance, and it does not scan for
real user data.

## Destination boundary

`destinationDir` must be:

- an absolute, existing, real directory (no symlink in the path);
- private: no group/other permission bits (`mode & 0o077 === 0`);
- not `/`, the account home or an ancestor, `~/.nanobot`/any `.nanobot`
  component, or `/proc`, `/sys`, `/dev`;
- pairwise disjoint from `sourceRoot` and `workspace` (neither inside nor above
  the other).

The database is exactly `<destinationDir>/nanobot.sqlite`. If it exists it must
be a regular file, never a symlink or special file. The directory and database
path are rechecked after the lock is taken and before storage is opened.

`apply` acquires the same process lock the Gateway uses for this database:

```text
nanobot:<canonical destination>/nanobot.sqlite
```

It then opens storage through `openFullSyncNodeSqliteStorage()`, which upgrades
and verifies `journal_mode=wal` and `synchronous=FULL` before Durable is used,
and verifies again after Durable initialization. A lock held by another process
is a hard blocker; this module never retries or weakens the lock.

The rehearsal uses a plain Durable `createSession()` and never opens a
`Harness`, `openGateway()`, a model, a provider, an inbox, a task, a submission,
a live session map, or a Python resume path.

## Persistence, batching, and idempotence

`apply` iterates the acquisition's deterministic batches and calls
`persistArchivalImport()` once per batch with the same caller-supplied
`storeNamespace`, the same acquisition limits, and any explicit persistence
limits. Each batch is one atomic Durable commit.

- Repeating the same quiescent copy is idempotent: every batch reports
  `already-persisted`, no new conversation/entry/ledger rows are created, and
  the existing conversation IDs are returned.
- Each source keeps the acquisition's stable `sourceId`, `provenance`, and
  digest. Source identity is `(storeNamespace, sourceId)`; line identity is
  `(storeNamespace, sourceId, line)`.
- A changed digest, namespace, format, provenance, preparation version/status,
  or record-schema version is an explicit conflict. Nothing is overwritten,
  silently superseded, or duplicated. The report returns the conflict reason
  and opaque source ID.
- A failure aborts the current batch. Earlier batches remain committed and
  atomic; a rerun resolves them idempotently. The module does not retry the
  failed batch itself.

If any batch is blocked, the report still reads the bounded ledger when the
session is usable, so the operator can see what was already persisted. Search
is skipped after a blocker.

## Ledger inspection and one-page search

After a successful `apply`, the module reads the existing
`readArchivalImportLedger()` summary through the same lock/session, then checks
that every acquired source has a ledger row with the same source ID, format,
provenance, digest, and byte length. A mismatch is a `ledger` blocker, not a
silent success:

- namespace, source count, source labels, formats, provenance, digests, byte
  and line counts, preparation status, record/search-unit counts, carrier
  conversation and first/last entry IDs.

It never returns record content, raw bytes, or provider state.

`search` requires `apply: true`; a dry-run rejects it instead of silently
ignoring it. If `search` is supplied, `searchPersistedArchivalImport()` runs
once in the same lock/session with caller-supplied search limits. The rehearsal returns one
bounded page containing allowlisted hits and coverage, but **withholds the
host-trusted continuation token** and reports only `continuationAvailable`.
A caller that needs another page runs another one-step rehearsal with a
narrower query/source scope; continuations are not a rehearsal artifact.

Search hits contain private snippets and allowlisted metadata (session key,
timestamps, roles, entry IDs, source labels), never `rawLineBase64`, provider
continuation state, header metadata, quarantine bytes, or model/task content.
`contentExposed` is true when non-empty search results are included.

## Report shape and privacy

Reports contain:

- `status`: `dry-run`, `applied`, `already-applied`, or `blocked`;
- acquisition summary (completeness, surfaces, missing surfaces, counts, stable
  diagnostics, opaque source labels);
- destination summary (`label` is a hash, `databaseOpened`, `lockAcquired`,
  `durability`);
- per-batch preparation/persistence summaries, counts, and per-source results;
- bounded ledger summary;
- optional bounded search result;
- `blockers` with `stage` and stable `code` (plus an opaque `sourceId` where
  relevant).

Reports never include filesystem paths, OS error messages, record content,
`rawLineBase64`, or provider/quarantine bytes. Typed errors from the composed
modules are reduced to stable codes. `pathsExposed` and
`rawArchivalBytesExposed` are always false. `contentExposed` is true only when
non-empty search results were explicitly requested.

Search results, ledger rows, snippets, session keys, timestamps, and source
labels remain private archival material. Do not log, publish, or attach them to
bug reports.

## Explicit non-claims

- No live `~/.nanobot` access, live history, network, credentials, model, or
  provider is used.
- No Harness, Gateway, runtime wiring, CLI, package script, session map, task,
  submission, model entry, inbox item, archive cursor, Python resume, replay, or
  scheduled work is created.
- No content validation beyond the existing preparation/persistence slices; no
  deduplication, reconciliation, retention, redaction, authorization, audit, or
  backup/restore policy.
- Acquisition is Linux-only and diagnostic, not a cryptographic guarantee
  against privileged concurrent writers or unreliable filesystem metadata.
- The lock/path boundary matches the Gateway's enforced boundary, but a
  privileged race between the final check and SQLite open is not defended
  against. Do not run this against live data or a shared destination.
- This rehearsal does not authorize a real import.

## Tests

`tests/archival-import-rehearsal.behavior.test.mjs` uses temporary synthetic
directories and SQLite databases only. It covers:

- dry-run acquisition/preparation with no destination file, lock, or write;
- apply across session, transcript-archive, and history surfaces;
- ledger inspection and a bounded one-page search with continuations withheld;
- search input failure reported as a blocker;
- idempotent reruns across one-source batches and stable conversation IDs;
- changed-digest and changed-namespace conflict reporting without overwrite;
- incomplete acquisition (symlink candidate), missing surfaces, and no-source
  root with no destination write;
- non-private, symlinked, overlapping, symlinked-database, and lock-held
  destinations, plus `.nanobot`-component source/destination refusal;
- a mid-SQLite-commit storage failure that leaves no ledger, conversation,
  entry, document, task, or submission behind, followed by a clean rerun;
- invalid option shape with no path echo.

```bash
npm run build
node --test tests/archival-import-rehearsal.behavior.test.mjs
```
