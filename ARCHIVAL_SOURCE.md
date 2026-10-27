# Operator-explicit legacy source discovery and snapshot acquisition

`src/archival-source/index.ts` is the filesystem boundary for a one-off
historical import. The caller names one dedicated root; the module discovers
only the Python legacy surfaces below it, reads bounded exact bytes, and returns
snapshots for the existing [`ARCHIVAL_IMPORT.md`](./ARCHIVAL_IMPORT.md)
preparation API. It is not an importer, a persistence layer, a CLI command, or
runtime wiring.

```ts
import {
  acquireLegacySourceSnapshots,
  prepareAcquiredArchivalImport,
} from "./src/archival-source/index.js";

const acquisition = await acquireLegacySourceSnapshots({
  root: "/srv/legacy-copies/2026-10-27", // explicit, dedicated, operator-authorized
  storeNamespace: "operator-approved-store-1", // caller-supplied, never inferred
});

if (!acquisition.complete || acquisition.surfacesAvailable === 0) {
  // Report diagnostics only; no partial preparation batch is exposed.
  throw new Error("acquisition incomplete or no expected surfaces");
}

const preparations = prepareAcquiredArchivalImport(acquisition);
```

`storeNamespace` is an opaque, caller-supplied label validated by the same safe
identifier rule as preparation. It is never derived from a path, hostname, or
session content. Source IDs and provenance are stable hash-derived labels; raw
paths are not returned. An empty or wrong root is **incomplete**, not a
successful zero-source import: `no-sources-discovered` is a failure and
`expectedSurfacesMissing`/`surfacesAvailable` make the coverage explicit.

## Discovered surfaces (exactly)

Only these shapes are candidates:

| Root-relative shape | Preparation format | Source kind |
| --- | --- | --- |
| `sessions/*.jsonl` | `session-jsonl` | `session` |
| `sessions/archive/*/*.jsonl` | `session-archive-jsonl` | `archive` |
| `memory/history.jsonl` | `history-jsonl` | `history` |

Everything else is out of scope. Deeper nesting, archive containers (tar, zip,
manifests), memory files other than `history.jsonl`, Dream history/cursors,
`HISTORY.md`, goals, cron, pairing, skills, media, and runtime state are not
read. Non-candidate entries in a scanned directory are counted as ignored;
structural entries (`sessions/archive` and each archive key directory) are
counted separately. No non-candidate file is opened; structural directories are
traversed but their non-candidate children are not read. The counter identity is
`directoryEntriesVisited == sourcesDiscovered + ignoredEntries +
structuralEntries` for every complete report. The module does not parse JSONL,
classify records, or decide whether content is valid; `prepareArchivalImport`
does that next.

## Missing surfaces versus errors

The distinction is explicit and machine-readable:

- A missing `sessions`, `sessions/archive`, `memory`, or `memory/history.jsonl`
  is a **notice**, not a failure by itself. `discovery` reports `missing` or
  `not-checked`, and `expectedSurfacesMissing`/`surfacesAvailable` summarize
  coverage.
- A root with **zero candidate sources** is a failure (`no-sources-discovered`),
  even when the missing surfaces are individually only notices. An empty or
  mistyped root therefore cannot look like a successful import of nothing.
- A surface that exists but is a symlink, not a directory, unreadable, changed,
  or otherwise unsafe is a **failure**. So is a candidate file that is a
  symlink, a hard-link alias (`nlink != 1`), a directory/FIFO/socket/device, or
  unreadable. Any failure makes `complete: false` and withholds all batches.
- Root itself must exist as a real directory; a missing or symlinked root is an
  input error, not an empty acquisition.

Diagnostics contain only stable codes, severity, a surface enum, and an opaque
hash-derived source ID. They never contain a path, OS error message, file name,
or source content.

## Exact snapshots and change detection

Each accepted file is opened with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` through a
pinned parent directory. The module compares device, inode, size, mode, link
count, `mtimeNs`, and `ctimeNs`:

1. during discovery (`lstat` through the pinned directory),
2. before reading (repeat `lstat` and compare),
3. immediately after open (`fstat`),
4. after reading (`fstat` and a final path `lstat`).

A replacement, truncation, growth, metadata change, hard-link alias, or vanished
path fails closed for that source. Directories are pinned with `O_DIRECTORY |
O_NOFOLLOW`; their `dev`/`ino`/size/`mtimeNs`/`ctimeNs` are rechecked after the
read phase. If a tracked directory or the root changed during acquisition, the
report is incomplete and no batch is exposed. Exact source bytes are copied into
a fresh `Buffer`; the source is never written, renamed, or modified.

This is an observable-consistency check, not a cryptographic guarantee. It does
not defend against a privileged or kernel-level adversary, a filesystem that
does not update metadata, or a change that occurs after the final check and
before the caller uses the snapshot. The returned bytes are the point-in-time
snapshot the module verified.

## Bounds and batching

Defaults (see `ARCHIVAL_SOURCE_ACQUISITION_LIMITS`):

- 256 candidate sources, 4 MiB per source, 64 MiB total read bytes;
- 4,096 entries per directory and 16,384 entries visited;
- 32 sources and 16 MiB per preparation batch;
- 4,096 diagnostics.

The default batch shape deliberately fits
`prepareArchivalImport`'s default source-count, per-source byte, and total-byte
limits. If discovery finds more sources than one preparation request, `batches`
splits them in deterministic path order, respecting both the source-count and
byte limits. Every source is retained; there is no silent truncation. A source
count or byte total beyond the acquisition limit throws
`ArchivalSourceBoundsError` instead of returning a partial acquisition.

`prepareAcquiredArchivalImport` calls the existing preparation API once per
batch, with the same caller-supplied `storeNamespace`. It revalidates the report
format/version, every source and snapshot label/digest, unique source IDs, and
batch membership, then recomputes batches from `sources`; a forged report with
altered labels or omitted/duplicated batches is rejected instead of silently
dropping work. It rejects an incomplete acquisition or a report with zero
sources. It performs no persistence, search indexing, cursor advancement,
session resume, archive replay, or runtime action. `history` and `archive`
records are never run.

## Namespace, resume, and conflict rules

- Use **one `storeNamespace` per legacy root**. `sourceId` hashes only
  `kind` plus the root-relative path, not the root path or content. Two different
  roots with the same relative layout under one namespace collide; persistence
  then fails closed on provenance/digest conflict rather than mixing stores.
- Acquisition must run against a **quiescent copy**. If a live file is appended
  or replaced, the relative path (and therefore `sourceId`) stays the same while
  the digest changes. Re-acquiring that file is a **reconciliation event**, not
  a resume: existing persistence rejects a changed digest/provenance and does not
  silently supersede it. No archive cursor is advanced here.
- `rootLabel` is a stable hash of the normalized absolute root path. Renaming or
  moving the same bytes changes `rootLabel`/`provenance`, which is also a
  reconciliation conflict for an existing namespace. Treat `rootLabel` as
  sensitive metadata (it is a confirmation oracle for guessable paths).

## Memory bound

All snapshot bytes remain resident until the report is returned. Peak memory is
bounded by `maxTotalBytes` (default 64 MiB, hard 256 MiB), plus preparation's
per-batch copies (default 16 MiB) and the final freeze walk. The hard limits are
planning numbers, not defaults; lower them for constrained/earlyoom hosts.

## Platform guarantees

The implementation is **Linux-only**. It requires:

- `O_NOFOLLOW`, `O_DIRECTORY`, and `O_NONBLOCK`;
- `/proc/self/fd` for pinned directory traversal and child opens.

On any other platform it throws `ArchivalSourcePlatformError` rather than
falling back to weaker path-only checks. Hard links are rejected; source files
must be regular files with exactly one link. The module does not enforce
ownership, permissions, confidentiality, authorization, retention, redaction,
or PII scanning. Use a private synthetic fixture or a separately authorized
private copy; treat the snapshot and all preparation output as sensitive.

## Root safety rules

`root` must be absolute, explicit, and dedicated. The module refuses:

- the filesystem root `/`;
- the user's home directory, or any ancestor of it, using **both** the
  passwd-derived `os.userInfo().homedir` and `os.homedir()` (so a redirected
  `HOME` cannot drop the guard);
- `~/.nanobot`, anything inside it, or any ancestor of it, and any path with a
  `.nanobot` component (defence in depth for altered `HOME`);
- the temp root itself (a child temp directory is allowed);
- `/proc`, `/sys`, or `/dev` and anything inside them.

If the passwd account home cannot be determined, acquisition fails closed.
The caller remains responsible for using a dedicated copy and for not pointing
the module at live data. `ambientReadsPerformed: false` means no implicit
legacy-store read; the module does read `/proc/self/fd`, the environment home,
and the temp directory for safety checks.

## Limitations

- No content validation, deduplication, reconciliation, import, persistence, or
  search index.
- No archive-batch container or directory discovery beyond the exact shapes.
- No recovery from a missing source that disappears before read; it is recorded
  as a failure and no batch is exposed.
- No defense against privileged concurrent writers or unreliable filesystem
  metadata.
- `nlink == 1` proves no other hard link; it does not prove provenance. A
  single-link file moved from outside the root, or a privileged bind-mounted
  file with a foreign device, is accepted and snapshotted. Ownership/device
  policy is not enforced.
- Unrelated writes to the root or a scanned directory (lock file, new session)
  make the acquisition incomplete; run against a quiescent copy.
- Caller-supplied preparation limits smaller than an acquisition batch can still
  throw in `prepareArchivalImport`; acquisition cannot predict preparation's
  record/search-unit bounds without parsing. Caller-supplied acquisition batch
  limits above preparation defaults likewise need matching preparation options.
- Source ID and root label are stable hashes, not reversible paths. This is
  intentional to avoid path leakage; treat `rootLabel` as sensitive metadata.

## Synthetic tests

`tests/archival-source-acquisition.behavior.test.mjs` uses temporary synthetic
fixtures only (no live history, no network). It covers exact-shape discovery,
byte-for-byte snapshots, stable opaque labels, ignored/structural counter
reconciliation, missing versus error surfaces, empty/wrong-root failure,
symlink/hard-link/non-regular/unreadable rejection, redirected-`HOME` protection,
root and namespace validation, incomplete-acquisition withholding, forged-report
rejection, default and overridden batching, bounds, deterministic pre-open /
post-read mutation races, descriptor hygiene, non-mutation, and preparation
integration. The race tests use a test-only instrumented copy of the built
module; production code has no test hook. Run it with:

```bash
npm run build
node --test tests/archival-source-acquisition.behavior.test.mjs
```
