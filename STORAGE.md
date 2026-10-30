# SQLite storage durability

The gateway stores Durable state in `dataDir/nanobot.sqlite`. The data directory is
created with mode `0700`; SQLite may also create `nanobot.sqlite-wal` and
`nanobot.sqlite-shm` beside the database. Keep the directory on a local filesystem
that honors SQLite's locking and sync requests. Do not copy or manipulate the live
database/WAL files while the gateway owns them; use a consistent SQLite backup.

## Startup and connection policy

Startup first canonicalizes the data path, checks it is disjoint from the workspace
and extra allowed roots, creates the private directory, rejects a non-regular
existing database path, and acquires Chord's OS-backed process lock for the
canonical database path. Only then does the storage adapter open SQLite.

The pinned Pi 1.4.0 `openNodeSqliteDatabase()` creates the single Node SQLite
connection, configures WAL, and initially sets `synchronous=NORMAL`. Before
constructing Durable storage, `src/storage/sqlite.ts` changes `synchronous` to
`FULL` on that same connection and reads back both `PRAGMA journal_mode` and
`PRAGMA synchronous`. It fails closed unless the effective values are `wal` and
`2` (`FULL`). It checks them again after Durable's native schema initialization,
so migrations cannot silently weaken the connection policy. The connection stays
private to Durable; there is no second connection, arbitrary SQL/PRAGMA surface,
or weaker mode. The Harness is opened only after these checks. Conversation policy
is reapplied before `harness.resume()` schedules recovered work.

Any setup or verification error closes the SQLite connection/storage and releases
the process lock; the Harness is not exposed and recovery work does not start.
SQLite commits continue through Durable's native storage, transaction, and queued
connection operations. Request-ID deduplication protects durable admission only;
it does not make external effects exactly-once.

## What FULL does and does not guarantee

In WAL mode, `synchronous=FULL` requests that SQLite synchronize the WAL at each
transaction commit before reporting success. It is stronger than the upstream
`NORMAL` default and is intended to retain the newest committed state across a
power loss, subject to the SQLite VFS, kernel, filesystem, storage controller, and
device correctly honoring synchronization and write-ordering requests. It cannot
guarantee survival of faulty/volatile hardware, broken filesystem or remote-volume
semantics, physical damage, or every host/power failure. A process `SIGKILL` is not
a power-cut test and does not establish physical-host durability.

The setting is per connection, so every gateway open enforces and verifies it anew.
The existing process lock still excludes another live gateway owner and is
released on process exit; it is not a substitute for backups. Unknown external
outcomes (for example an accepted remote message followed by a crash) remain
unknown and must not be retried merely because the database retained its intent.

## Manual stopped backup and restore

There is no backup command or backup subsystem. For a simple manual copy, stop
the owning gateway process and wait for it to exit before touching storage. Then
copy `dataDir/nanobot.sqlite` together with the configured workspace files to an
empty destination `dataDir` and workspace. Do not copy a database or its `-wal`/
`-shm` files while a gateway owns them. After a clean close this checkout's smoke
observed no sidecars; if sidecars are still present, the main database file alone
is not a consistent backup and the copy must not be treated as one.

Point the configuration at the restored paths and open normally. The restored
store keeps its existing session mappings, transcript entries and durable
admission dedupe, and the restored workspace supplies the current Markdown
memory and bootstrap files. The copy step does not repair, rewrite or migrate
the database; normal startup still runs Durable's schema initialization. A
corrupt or incomplete copy is not made usable by this procedure.

`tests/context-recovery.behavior.test.mjs` proves the bounded synthetic case:
a gateway serves one turn, closes, its database and workspace are copied, the
original source workspace changes afterwards, and the restored gateway reopens
the same conversation with the same entry IDs and text, reads the restored topic
memory instead of the changed source, and deduplicates the original request ID
without a new model dispatch. This is a stopped-process copy test. It does not
establish physical-host durability, a live database backup, external-effect
exactly-once semantics or recovery from a torn/corrupt copy.

## Offline verification

`npm ci --ignore-scripts`, followed by
`npm run typecheck` and
`npm run build`, succeeded. The private bounded probe
at `/tmp/pi-nanobot-storage-probe.mjs` uses injected Faux Models and temporary
SQLite files; it observed `journal_mode=wal` and `synchronous=2` twice on each of
four actual gateway adapter connections (before and after Durable initialization).
It also verified durable submission/request-ID and session-map reuse after reopen,
rejected a concurrent owner, and killed a real subprocess with `SIGKILL` after a
completed turn before reopening the two-entry transcript and same IDs. A one-shot
failure injected at the adapter's `PRAGMA synchronous = FULL` setup call verified
that the adapter was closed and the runtime lock released (a subsequent open
succeeded). That injected failure is not an SQLite/VFS fault test. The SIGKILL
case establishes process-crash recovery only; it does not test power loss or
physical-host durability.

Independent source review passed: `/tmp/pi-storage-full-review.md`. After integration
as `2d5af1adf`, parent package typecheck/build and diff check passed, followed by
`/tmp/pi-nanobot-parent-storage-crash.mjs` against the parent checkout (70-second
bound, 512-MB Node heap): actual crash/reopen, WAL/FULL, owner exclusion, dedupe
and setup cleanup passed. Parent's separate
`/tmp/pi-nanobot-parent-storage-failclosed.mjs` (45 seconds/256 MB) also passed
before/after journal/synchronous mismatch injections, read and migration failures,
lock/database reopen after each, and real non-WAL in-memory database rejection.
Injected faults are not real disk-full/VFS failures. Backup/restore, real storage
faults, close failure and physical-host-loss acceptance remain open.
