# Bounded search over persisted archival records

`src/archival-search/index.ts` is the read-only search/browse slice for the
archival entries written by
[`src/archival-persist/index.ts`](./ARCHIVAL_PERSISTENCE.md). It reads the
persisted import ledger and each source's ownerless Durable carrier
conversation directly. It does **not** accept the full prepared-record array
from the earlier in-memory snapshot helper, materialize a corpus, or require the
host to supply prepared records.

```ts
import { searchPersistedArchivalImport } from "./src/archival-search/index.js";

const query = {
  text: "deployment rollback",
  sourceIds: ["session-telegram-000"],
};
const limits = { maxHits: 20, maxOutputChars: 24_000 };

let page = await searchPersistedArchivalImport(session, query, context, { limits });
while (page.continuation !== null) {
  page = await searchPersistedArchivalImport(session, query, context, {
    limits,
    continuation: page.continuation,
  });
}
```

`session` is the host-owned Durable `Session` (a native `Harness` or
`createSession()` result); the host supplies the `Context`. The module never
opens a path, calls the network, acquires a lock, writes storage, reads a model
payload, creates tasks/submissions, advances an archive cursor, or resumes a
Python session.

## Ownership and the ledger boundary

The caller MUST already hold **exclusive single-writer ownership** of the
Session/storage, normally the same process lock the Gateway uses
(`nanobot:<dbPath>` in `src/runtime.ts`). Search itself acquires no lock. If
another import commits while a continuation is live, the ledger source count can
change and the continuation is rejected; do not search concurrently with an
importer or another writer.

The import ledger is one session-scoped document bounded by the persistence
default of **512 sources** (hard cap **1,024**). Search reads that whole ledger
(bounded) to know which source carriers exist, then pages each carrier by
Durable entry ID. It does not load every archival entry or a transcript:

- the ledger clone is bounded by `maxLedgerSources`;
- each scan requests at most `scanBatchSize` entries (also capped by remaining
  `maxScanEntries`);
- only the current page of entries, the bounded hit list, and the cumulative
  coverage counters are retained.

A larger archive needs a reviewed ledger sharding/migration plan; search cannot
make a ledger beyond its hard source cap visible.

## What is searched

Only the prepared text-only `search[]` projection is matched:

- `session-message`
- `archive-message`
- `history-message`
- `history-content`
- `history-summary`

Matching is a **literal substring** (not a regular expression, token index,
boolean query language, stemmer, ranker, or semantic search). It uses
ECMAScript `iu` regular-expression matching by default: Unicode-aware simple
case folding, including astral case pairs, but not full multi-character folds
such as `ß`/`SS`. `caseSensitive: true` selects exact case. There is no Unicode
normalization, locale tailoring, stemming, or ranking. An empty query is
rejected; enumerate with a literal substring instead of a browse-all mode.

Optional query filters:

- `sourceIds`: exact source scope; duplicates are ignored and the scope is
  bounded to 128 labels. An empty scope or any ID outside the current ledger is
  rejected with `ArchivalSearchInputError`; it is never reported as a complete
  search of nothing.
- `role`: exact role on the unit role, falling back to the record role.

Timestamps are returned as stored opaque strings; there is no timestamp range
filter. A hit is produced once per matching unit (not once per occurrence) with
the first-match snippet and a `matchCount` of non-overlapping literal
occurrences. Snippets are bounded and adjusted so they never split a UTF-16
surrogate pair; this is code-unit safety, not grapheme-cluster segmentation.
`textOmitted` on a hit means the prepared projection itself was partial, not
that the snippet was truncated; `snippetTruncated`/`matchTruncated` describe the
snippet.

The following are deliberately **not** searchable and are never returned:

- raw line bytes, including `rawLineBase64`;
- provider-state/continuation records;
- session/archive headers and their metadata/checkpoints;
- blank lines;
- quarantined lines and quarantine reasons/payloads;
- any record with `opaque: true`;
- model messages, task payloads, submissions, or live session-map content.

Ordinary hit objects copy only allowlisted prepared fields: source line
identity (`durableKey`, `sourceId`, `line`, hashes, byte bounds), original
preparation ordinals/source order, category/status, session key/timestamp/role,
unit identity, the bounded snippet, and match offsets. They never include
`rawLineBase64`, metadata objects, provider state, or quarantine bytes.

## Ordering, identity, and duplicates

Pages follow **ledger source order**, then ascending **Durable entry ID** within
that source's carrier conversation. A continuation stores the next entry ID and
unit index; it does not store a backend cursor that could be replayed against a
different scan.

`durableKey` is the stable line identity
`(storeNamespace, sourceId, line)`. `preparationOrdinal` and
`preparationSourceOrder` are copied from the stored entry as provenance only;
they reset per import batch and are not identity or ordering keys. Two
independent import batches can both start at preparation ordinal 0 without
colliding, and identical text at different physical lines remains a separate
hit with a different `durableKey`, line, and Durable entry ID. Search never
deduplicates by text, timestamp, line hash, or content.

Search scans the **entire ledger carrier conversation**, not merely the
ledger's first/last entry IDs. A foreign or malformed entry appended to a
carrier is counted as `entriesUnsearchable` (and makes coverage incomplete); it
is not returned. This keeps mixed content from crashing the scan or silently
looking like a clean archival carrier.

## Continuation state (trusted host only)

A page returns `continuation: null` when the ledger scan finished, or an object
containing:

- format/version, query SHA-256, store namespace, ledger source count, and a
  SHA-256 digest over every relevant ledger row (including preparation status
  and counts);
- the ledger source index/source ID/conversation ID;
- the next Durable entry ID and unit index;
- whether that entry's metadata is already classified, plus its unit-progress
  flags;
- for an in-flight entry, its line, durableKey, unit count, and a SHA-256
  fingerprint over the entry ID, line, key, search status, and full unit list;
- bounded per-source observation state (records/units/bytes, first/last entry
  IDs and lines, sequence validity, malformed/identity flags);
- the current source's caveat flag;
- cumulative coverage counters.

The next call validates format/version, query fingerprint, store namespace,
ledger digest, ledger source count, source identity, source-observation shape,
in-flight entry identity, and position shape. A query change, a different
namespace, any changed relevant ledger row (preparation status/counts
included), a changed source conversation, a changed/deleted in-flight entry, or
a missing named in-flight entry is rejected with
`ArchivalSearchContinuationError`; opaque or unavailable sources are skipped
honestly. Changing page-size limits between calls is allowed. Digesting the
ledger is bounded by the ledger source cap but costs a linear row pass on every
page. Resuming a large in-flight entry also re-hashes its full unit list, so
that verification cost is proportional to the in-flight entry's unit data per
resumed page.

**Continuations are host-trusted, unsigned state.** `continuationTrust` is
`"host-trusted-not-authenticated"`. The ledger digest is a mixing/staleness
guard, not a MAC/HMAC, claim authorization, or tamper-proof guarantee: a caller
that can forge a continuation can reset coverage counters or skip positions.
Keep continuations in trusted host/server state, bind them to an authenticated
session if they cross a trust boundary, or replace this slice with a store that
issues authenticated scan tokens. Do not use a continuation as proof that a
source was searched.

The per-source observation and durableKey recomputation detect missing/extra
carrier records, duplicate/out-of-order lines, and metadata/identity drift as
coverage caveats. They do not prove every raw line byte is unchanged; use the
persistence repeat-verification path for full integrity reconciliation.
Exclusive single-writer ownership is what keeps the carrier stable during a
continuation chain.

Reconciliation is **forward-looking only**: search does not re-read records that
are already behind the cursor. Deleting or changing an already-scanned record
after it was observed is not detected by a later page. The host MUST hold
exclusive single-writer ownership and a stable carrier snapshot for the entire
continuation chain; an external writer invalidates these coverage claims.

## Coverage and progressive bounds

Limits and their defaults/hard caps:

| Bound | Default | Hard cap | Meaning |
|---|---:|---:|---|
| `maxSources` | 16 | 128 | in-scope ledger source rows considered per page |
| `maxScanEntries` | 500 | 10,000 | Durable entries examined/touched per page |
| `maxScanUnits` | 10,000 | 100,000 | search units examined per page |
| `maxHits` | 20 | 200 | hits returned per page |
| `maxOutputChars` | 24,000 | 200,000 | `JSON.stringify(page).length`, in UTF-16 code units |
| `maxSnippetChars` | 240 | 2,000 | snippet bound in code units |
| `maxQueryChars` | 200 | 1,000 | literal query bound |
| `scanBatchSize` | 25 | 200 | entries requested from one Durable scan |

`maxOutputChars` must be at least 5,120. The page envelope (query, coverage,
continuation, limitations, counters) must fit; if even one bounded hit cannot
fit, the call raises `ArchivalSearchBoundsError` instead of silently dropping
the hit. A page that would exceed the output bound drops the latest hit(s),
keeps earlier hits, and resumes at the exact unit of the first dropped hit,
even when that unit is inside a large entry. Unit and hit limits also resume at
the exact next unit.

Work limits are checked at entry/unit boundaries and always leave a resumable
position. A source may require one extra empty entry scan to prove completion.
An entry with more units than one page's `maxScanUnits` is **not** rejected:
its allowlisted metadata is classified once, then units are validated and
searched incrementally across as many pages as needed. A page may stop in the
middle of such an entry and resume at the exact next unit. If the complete
traversal finds no valid searchable unit, the entry is reclassified at its end
as `entriesNoSearchText` or `entriesUnsearchable`; a partial projection remains
`entriesSearchablePartial` with `textOmitted: true` on its hits.

`stopReason` is one of:

- `complete` — every in-scope ledger source carrier was traversed;
- `no-ledger` — no import ledger exists; nothing was searched;
- `max-sources`, `max-entries`, `max-units`, `max-hits`, `max-output-chars` —
  the named per-page bound stopped this page with a continuation.

`scanComplete` means the carrier traversal finished. It does **not** mean every
archival surface was searched. Coverage separately reports:

- `sourcesConsidered`, `sourcesFullyScanned`, `sourcesClean`,
  `sourcesWithCaveats`, `sourcesUnsupported`, `sourcesUnavailable`;
- `sourcesLedgerMismatch`, `sourcesDuplicateOrOutOfOrder`,
  `sourcesIdentityMismatch`;
- `sourcesInScope`, `sourcesScopeExcluded`, `sourcesNotYetScanned`;
- `entriesScanned`, `entriesSearchable`, `entriesSearchablePartial`,
  `entriesNoSearchText`, `entriesOpaque`, `entriesQuarantined`,
  `entriesUnsearchable`;
- `unitsScanned`, `unitsInvalid`, and cumulative `hits`;
- `coverageComplete`, which is true only when the ledger is present, the scan
  completed, every in-scope source was accounted for, no source was unavailable
  or unsupported, no ledger/carrier mismatch, duplicate/out-of-order line, or
  identity mismatch was observed, and every scanned entry was fully searchable.
  Any opaque header/provider/blank line, quarantine, partial search projection,
  missing text, or foreign/malformed entry keeps it false.

At each source boundary, search reconciles bounded observed state against the
ledger row: record count, `lineCount`, search-unit count, accumulated byte
length, first/last Durable entry IDs, first/last line, and a contiguous
`line = previous + 1` sequence starting at the ledger first line. It also
recomputes each line's `durableKey` from
`(storeNamespace, sourceId, line)`. Missing/extra records, empty carriers,
duplicate or out-of-order lines, malformed archival entries, foreign entries,
and identity drift mark the source as a mismatch and a caveat. The state is
bounded per source; it does not retain every record or unit.

`ledgerOnlyCoverage` and `unsupportedSourcesOutsideLedger` are always true:
unsupported or never-persisted sources have no ledger row and are therefore
invisible. A zero unsupported count is not evidence that none exist. An
`incomplete` persistence preparation status makes its source a caveat; its
stored searchable units are still searched.

`ArchivalSearchCorruptionError` is reserved for a broken scan invariant such as
non-ascending Durable entry IDs. A malformed/foreign carrier entry is normally
counted as unsearchable, not fatal.

## Privacy

Search results are at least as sensitive as the archived material:

- searched text, snippets, session keys, timestamps, entry IDs, source labels,
  and provenance are private archival data;
- the module performs no credential scanning, PII scrubbing, redaction,
  authorization, retention, or audit policy;
- no raw provider continuation state, header metadata, quarantine bytes, or
  model/task content is returned;
- treat pages, continuations, logs, and test fixtures as private material.

Durable `scanEntries` returns the **entire** requested `EntryRecord`, including
`data` with `rawLineBase64` and any `model`, `head`, `edits`, or foreign payload.
Search ignores those fields but reads the records to validate/search them.
`scanBatchSize` and `maxScanEntries` bound entry count, not bytes. A legitimate
carrier written by persistence is bounded per source by its raw-byte limits, but
a corrupt or hostile foreign entry is not byte-bounded by this module. The host
must preserve exclusive ownership and carrier integrity; use the persistence
repeat-verification path for legitimate-source integrity and size reconciliation.

Use synthetic SQLite databases and synthetic snapshots for implementation
checks. This slice does not authorize a real private copy.

## Tests

`tests/archival-search.behavior.test.mjs` uses temporary synthetic SQLite
databases and a native `Harness`. It covers:

- prepared-text-only hits, durable identity, duplicate physical lines, and no
  raw header/provider/quarantine payloads;
- multiple independent import batches whose preparation ordinals restart at 0;
- Durable entry-ID paging across sources, continuation over a close/reopen, and
  no duplicate/lost hits;
- partial projections, quarantine/opaque coverage, and a foreign mixed-content
  entry that is counted but never returned;
- Unicode case-insensitive matching, source/role metadata, and surrogate-safe
  snippets;
- source scoping, defensive unsupported/unavailable ledger rows, and honest
  coverage;
- mid-entry unit paging, smallest scan limits, serialized output bounds, and
  progress without an accidental full-corpus load;
- entries with more units than `maxScanUnits`, including a large partial
  history record and output-trimmed pages, whose full hit set is reachable over
  repeated pages with monotonic unit progress and correct cumulative omission
  flags;
- in-flight line/key tampering with a recomputed durableKey, in-flight unit
  reordering, deletion of the named in-flight entry, and deletion of the named
  fresh entry with unit position reset;
- duplicate/extra archival entries, empty carriers, identity (durableKey)
  mismatch, stale ledger preparation status/counts in a continuation, and
  empty/unknown `sourceIds` rejection;
- query/ledger continuation mismatch rejection and the no-ledger page;
- read-only behavior: no new conversations, entries, ledger changes, tasks, or
  submissions.

```bash
npm run build
node --test tests/archival-search.behavior.test.mjs
```

## Remaining limitations (explicit)

1. No index and no ranking. Every page scans Durable entry-ID pages; total work
   grows with the entries/units visited, not with a precomputed index.
2. The session ledger's 512/1,024 source cap is a hard visibility limit. Larger
   archives need sharding/migration.
3. Unsupported and never-persisted sources are invisible because they have no
   ledger row. Search cannot count or search them.
4. Coverage is strict and therefore usually not `coverageComplete` for session
   sources: headers, provider state, blank lines, and quarantine are known
   unsearched surfaces.
5. A line with more prepared units than one page's `maxScanUnits` is searched
   incrementally across pages; it is not excluded solely for unit count. A
   single page still stops at `maxScanUnits`, so very large entries require
   multiple continuation calls.
6. Continuations are unsigned host state with no authentication or tamper
   proof; the ledger digest is a mixing guard, not a MAC. They are not
   authorization and must not be exposed to untrusted clients.
7. Matching is simple Unicode case folding and literal substring only; no
   full case folding, normalization, locale tailoring, tokenization, stemming,
   or timestamp filtering.
8. Snippets are UTF-16 code-unit bounded and surrogate-safe, but not
   grapheme-cluster aware.
9. No redaction, retention, authorization, audit, backup/restore, or operator
   approval flow is implemented.
10. The module reads the bounded ledger document, digests every ledger row on
    each page, and materializes page-sized full `EntryRecord` batches (including
    raw/model/foreign payload bytes). Entry counts are bounded, but corrupt
    foreign entry bytes are not. It does not implement a resumable
    storage-side search cursor, so each page reopens the carrier scan at an
    entry ID.
11. No CLI, runtime wiring, package-script, session-map, model, task, or Python
    resume surface is added. The one-off path discovery/import CLI remains
    separate.
12. Search reconciles bounded per-source counts/bytes, first/last entry IDs and
    lines, contiguous line order, and each line's recomputed durableKey, but it
    does not read/verify every raw line hash or source SHA-256. A changed raw
    line or search-unit text with unchanged ledger-visible metadata and
    durableKey is not detected. Reconciliation only covers forward-observed
    carrier state; records changed or deleted after they were already scanned
    are not detected. Use the persistence repeat-verification path for full
    integrity reconciliation and keep an exclusive single-writer stable snapshot
    for the continuation chain.
