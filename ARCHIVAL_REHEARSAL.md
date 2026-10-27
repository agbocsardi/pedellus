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
a package-script/CLI addition. It is not re-exported from `src/index.ts`, not
wired to the CLI, and not production-ready. This document makes no readiness
claim. The caller must supply an explicit, dedicated copy and an explicit,
private destination. Nothing is inferred from `~/.nanobot`, the current
directory, or environment paths.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runArchivalImportRehearsal } from "./src/archival-rehearsal/index.js";

const rehearsal = await runArchivalImportRehearsal({
  sourceRoot: "/srv/rehearsal/source-copy",       // quiescent/synthetic copy
  destinationDir: "/srv/rehearsal/private-store", // existing 0700 directory
  workspace: "/srv/rehearsal/workspace",          // must be disjoint
  storeNamespace: "operator-rehearsal-1",         // opaque, caller-supplied
  // apply: true,                                  // absent => dry-run, no writes
  // acknowledgeMissingSurfaces: ["archive"],       // required for missing surfaces
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
copy and perform in-memory preparation. It also preflights preparation and
persistence limits, so a limit that would block apply is reported as `blocked`
before any destination access. Missing known surfaces remain visible in
`source.expectedSurfacesMissing` and do not by themselves block a dry-run.

`apply: true` is the only write mode. It writes only the supplied snapshot
bytes into the explicit destination database and then optionally inspects the
ledger and performs one bounded search.

## Missing surfaces require explicit attestation

`surfacesAvailable` and `expectedSurfacesMissing` are always reported. Any
missing known surface (`sessions`, `archive`, `memory`, `history`) makes apply a
qualified operation: by default apply is **blocked** with
`missing-surfaces-not-acknowledged`. The operator must name every missing
surface in `acknowledgeMissingSurfaces`:

```ts
await runArchivalImportRehearsal({
  ...options,
  apply: true,
  acknowledgeMissingSurfaces: ["archive", "memory", "history"],
}, context);
```

A partial acknowledgement stays blocked. The applied report records the
accepted missing surfaces in `acknowledgedMissingSurfaces`. Unknown surface
names are rejected as input errors. Dry-run exposes the missing surfaces without
requiring this acknowledgement.

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
be a regular file with exactly one link, never a symlink, special file, or
hardlink (`nlink === 1`). The lock protects the path/process boundary; it does
not protect a hardlinked inode that is also writable outside the destination.
Hardlinks are rejected with `destination-database-hardlink` both before and
after the lock is taken.

Existing pre-planted `-wal`, `-shm`, and `-journal` sidecars are checked the same
way. A symlinked, non-regular, or hardlinked sidecar is rejected with
`destination-wal-shm-unsafe` before SQLite opens the database, so SQLite cannot
follow it to an outside file.

The directory, database identity, and sidecars are rechecked after the lock is
taken and before storage is opened.

`apply` acquires the same process lock the Gateway uses for this database:

```text
nanobot:<canonical destination>/nanobot.sqlite
```

It then opens storage through `openFullSyncNodeSqliteStorage()`, which upgrades
and verifies `journal_mode=wal` and `synchronous=FULL` before Durable is used,
and verifies again after Durable initialization. A lock held by another process
is a hard blocker; this module never retries or weakens the lock.

After opening, the database is chmodded to `0600` before any archival write;
WAL/SHM files created afterwards inherit that mode. Mode changes use a
no-follow descriptor, not a path: open with `O_RDONLY | O_NOFOLLOW |
O_NONBLOCK`, `fstat` the handle, require a regular file with `nlink === 1`,
`fchmod(0o600)`, then re-`fstat` and re-`lstat` the path to confirm it still
names the same inode. Existing sidecars use the same primitive. After close the
database and any surviving sidecars are rechecked under the same rule while
the lock is still held. A residual, unverified exposure is reported in
`destination.databaseMode`, `destination.walShmMode`, and
`privacyLimitations`.

`O_NOFOLLOW` protects **only the final path component**. If a same-user process
can replace an ancestor directory, the path can be redirected to a different
inode while the final name still passes the no-follow open; the fd-based
`fchmod` then affects whatever inode that redirected open produced. No absolute
"symlink/hardlink target is never affected" claim is made. The same-user
destination-race contract below is the governing limitation.

There also remains a narrow same-user race between the pre-`fchmod` `fstat` and
the `fchmod` itself: a process that can write the private destination could add
a hard link in that window. This is outside the ownership contract and is not
claimed hardened.

The rehearsal uses a plain Durable `createSession()` and never opens a
`Harness`, `openGateway()`, a model, a provider, an inbox, a task, a submission,
a live session map, or a Python resume path.

## Persistence, batching, and idempotence

Before taking the lock, `apply` preflights every acquisition batch:

1. preparation runs once per batch with the caller's preparation limits;
2. every per-batch persistence bound is checked against the exact validated
   persistence limits (source count, raw bytes, records, search units, and the
   per-source variants). The rehearsal calls the persistence module's own
   `normalizeArchivalPersistenceLimits()`, so unknown keys, malformed values,
   and values above the persistence hard caps are rejected with
   `persistence-input-invalid` before any destination access;
3. an absolute ledger overflow (the snapshot itself has more sources than
   `maxLedgerSources`) is also rejected before the destination is opened.

A preparation or persistence-limit violation is reported **before** the
destination is opened. After the lock, and before the first batch commit, the
ledger is read and preflighted for namespace agreement, omitted sources,
per-source conflicts, and exact total ledger capacity (`ledger sources in the
destination + new sources`). A source present in the ledger but absent from the
current snapshot is a `ledger-source-not-in-snapshot` blocker, not
`already-applied`; this catches a partial/stale rerun before it writes.

Exact existing-ledger capacity requires opening the destination database, so a
blocked apply may still create, migrate, or chmod `nanobot.sqlite`. The report
sets `destination.databaseOpened` so this is visible. No batch/archival writes
occur in that case.

Only then does `apply` iterate the acquisition's deterministic batches and call
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
- Limit, capacity, namespace, omitted-source, and ledger-metadata conflicts are
  preflighted before any batch write. A persistence commit failure still aborts
  the current batch after earlier batches were committed; those remain atomic,
  and a rerun resolves them idempotently. The module does not retry the failed
  batch itself.
- `writesPerformed` means this run committed at least one new archival source.
  It does not describe database creation/migration, the lock, or chmod; those
  are described by the destination summary.

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
When search is requested, the report also echoes the caller-supplied query text
and query metadata inside `search.query`; without search, no query text is
present. `queryEchoed` is true whenever a successful search page echoes the
query, even with zero hits. `contentExposed` is true only when non-empty search
results are included. A report with `queryEchoed: true` is sensitive even when
`contentExposed` is false.

## Report shape and privacy

Reports contain:

- `status`: `dry-run`, `applied`, `already-applied`, or `blocked`;
- policy literals and `privacyLimitations`;
- acquisition summary (completeness, surfaces, missing surfaces, counts, stable
  diagnostics, opaque source labels);
- acknowledged missing surfaces;
- destination summary (`label` is a hash, `databaseOpened`, `lockAcquired`,
  `durability`, `databaseMode`, `walShmMode`);
- `privacyLimitations` when post-close database/sidecar privacy cannot be fully
  verified;
- per-batch preparation/persistence summaries, counts, and per-source results;
- bounded ledger summary;
- optional bounded search result;
- `blockers` with `stage` and stable `code` (plus an opaque `sourceId` where
  relevant);
- `queryEchoed` for successful search pages, distinct from `contentExposed`;
- policy literals: `experimental: true`, `syntheticOnly: true`,
  `realImportAuthorized: false`, `sameUserRaceHardened: false`. These are
  fixed policy markers, **not** proof that the supplied input is synthetic,
  **not** a provenance/authorization check, and **not** a readiness claim.

Reports never include filesystem paths, OS error messages, record content,
`rawLineBase64`, or provider/quarantine bytes. Typed errors from the composed
modules are reduced to stable codes. `pathsExposed` and
`rawArchivalBytesExposed` are always false. `contentExposed` is true only when
non-empty search results were explicitly requested; those results and the query
text are private.

Search results, ledger rows, snippets, session keys, timestamps, and source
labels remain private archival material. Do not log, publish, or attach them to
bug reports.

## Explicit non-claims

- No live `~/.nanobot` access, live history, network, credentials, model, or
  provider is used.
- No Harness, Gateway, runtime wiring, CLI, package script, session map, task,
  submission, model entry, inbox item, archive cursor, Python resume, replay, or
  scheduled work is created. This module is not re-exported from the package
  barrel and is not exposed by the CLI.
- No content validation beyond the existing preparation/persistence slices; no
  deduplication, reconciliation, retention, redaction, authorization, audit, or
  backup/restore policy.
- Acquisition is Linux-only and diagnostic, not a cryptographic guarantee
  against privileged concurrent writers or unreliable filesystem metadata.
- The lock/path boundary matches the Gateway's enforced boundary. Cross-user
  access is blocked by the 0700 destination, but a **same-user** process that
  writes the destination and ignores the lock can race the post-lock check and
  the SQLite open, or swap an ancestor directory around an `O_NOFOLLOW` open.
  `node:sqlite`'s native opener follows symlinks and has no
  `O_NOFOLLOW`/fd-pinning option; passing `/proc/self/fd/<fd>` is not a safe pin
  because SQLite resolves it to a pathname and creates WAL/SHM beside that
  path. A hardlink/symlink swapped into that window can therefore make Durable
  migrations write schema pages to the external inode before the post-open
  `nlink` check blocks archival writes. This is a documented residual, not a
  hardened guarantee. The rehearsal is experimental and synthetic-only until a
  safe pinned open (or an equivalent ownership gate) is implemented.
- This rehearsal does not authorize a real import. The `syntheticOnly`,
  `realImportAuthorized`, and `sameUserRaceHardened` report fields are policy
  literals, not evidence about the input or an authorization decision.
- The behavior tests are standalone; package-script/test wiring is owned by the
  parent integration, not this slice.

## Tests

`tests/archival-import-rehearsal.behavior.test.mjs` uses temporary synthetic
directories and SQLite databases only. It covers:

- dry-run acquisition/preparation with no destination file, lock, or write;
- apply across session, transcript-archive, and history surfaces;
- ledger inspection and a bounded one-page search with continuations withheld;
- zero-hit query echo (`queryEchoed`) distinct from content exposure;
- search input failure reported as a blocker;
- idempotent reruns across one-source batches and stable conversation IDs;
- changed-digest and changed-namespace conflict reporting without overwrite;
- incomplete acquisition (symlink candidate), missing surfaces, no-source
  root, and apply blocked until every missing surface is acknowledged;
- non-private, symlinked, overlapping, symlinked-database, hardlinked-database
  (before and after the lock), symlinked WAL/SHM, and lock-held destinations,
  plus `.nanobot`-component source/destination refusal;
- database `0600` enforcement under umask 0;
- stale-ledger rerun (source removed from the snapshot) blocked instead of
  reported as already-applied;
- preparation, persistence, and ledger-capacity preflight blocking before any
  batch write, including above-hard-cap/malformed overrides and a 513-source
  absolute ledger overflow with no destination database;
- fd-based fchmod with a path swapped to a symlink (outside mode unchanged),
  and a documented same-user post-lock hardlink race showing external Durable
  migration pages while archival writes are blocked;
- a mid-SQLite-commit storage failure that leaves no ledger, conversation,
  entry, document, task, or submission behind, followed by a clean rerun;
- invalid option shape with no path echo.

```bash
npm run build
node --test tests/archival-import-rehearsal.behavior.test.mjs
```

The test file is standalone and is not added to `package.json`; the parent owns
test wiring.
