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

if (!acquisition.complete) {
  // Report diagnostics only; no partial preparation batch is exposed.
  throw new Error("acquisition incomplete");
}

const preparations = prepareAcquiredArchivalImport(acquisition);
```

`storeNamespace` is an opaque, caller-supplied label validated by the same safe
identifier rule as preparation. It is never derived from a path, hostname, or
session content. Source IDs and provenance are stable hash-derived labels; raw
paths are not returned.

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
read. Non-candidate entries in a scanned directory are counted as ignored; they
are never opened. The module does not parse JSONL, classify records, or decide
whether content is valid; `prepareArchivalImport` does that next.

## Missing surfaces versus errors

The distinction is explicit and machine-readable:

- A missing `sessions`, `sessions/archive`, `memory`, or `memory/history.jsonl`
  is a **notice**, not a failure. `discovery` reports `missing` or
  `not-checked`, and the acquisition can still be complete. An empty root is an
  honest empty acquisition with zero sources and zero batches.
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
batch, with the same caller-supplied `storeNamespace`. It rejects an incomplete
acquisition and returns `[]` for a complete acquisition with zero sources. It
performs no persistence, search indexing, cursor advancement, session resume,
archive replay, or runtime action. `history` and `archive` records are never
run.

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
- the user's home directory, or any ancestor of it;
- `~/.nanobot`, anything inside it, or any ancestor of it;
- the temp root itself (a child temp directory is allowed);
- `/proc`, `/sys`, or `/dev` and anything inside them.

The caller remains responsible for using a dedicated copy and for not pointing
the module at live data.

## Limitations

- No content validation, deduplication, reconciliation, import, persistence, or
  search index.
- No archive-batch container or directory discovery beyond the exact shapes.
- No recovery from a missing source that disappears before read; it is recorded
  as a failure and no batch is exposed.
- No defense against privileged concurrent writers or unreliable filesystem
  metadata.
- Caller-supplied preparation limits smaller than an acquisition batch can still
  throw in `prepareArchivalImport`; acquisition cannot predict preparation's
  record/search-unit bounds without parsing.
- Source ID and root label are stable hashes, not reversible paths. This is
  intentional to avoid path leakage.

## Synthetic tests

`tests/archival-source-acquisition.behavior.test.mjs` uses temporary synthetic
fixtures only (no live history, no network). It covers exact-shape discovery,
byte-for-byte snapshots, stable opaque labels, ignored entries, missing versus
error surfaces, symlink/hard-link/non-regular rejection, unreadable directories/files,
root and namespace validation, incomplete-acquisition withholding, default and
overridden batching, bounds, non-mutation, and preparation integration. Run it
with:

```bash
npm run build
node --test tests/archival-source-acquisition.behavior.test.mjs
```
