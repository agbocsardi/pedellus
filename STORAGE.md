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

## Offline verification

`npm ci --prefix packages/pi-nanobot --ignore-scripts`, followed by
`npm run typecheck --prefix packages/pi-nanobot` and
`npm run build --prefix packages/pi-nanobot`, succeeded. The private bounded probe
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
