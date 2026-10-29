# History search index

`src/history/index.ts` is a rebuildable SQLite full-text index over Durable's
retained entries. It is the first bounded slice of the agreed W3 history design:
message and tool search plus committed reset boundaries. Episode summaries and
summary search are not implemented.

## Authority and storage

- Durable is the only transcript authority. Indexing reads entries through the
  Gateway's `root.commit` transaction surface and never writes Durable's store.
- The index is a separate derived file: `nanobot.sqlite` becomes
  `nanobot-history.sqlite` in the same data directory. It can be deleted while the
  Gateway is stopped; the next search rebuilds it from Durable.
- The index stores private text and source identifiers. It must stay inside the
  disjoint data directory and is not a backup of the transcript.

## Search scopes

`gateway.historySearch(query, context)` defaults to user and assistant message
text. `roles` narrows that to `user` and/or `assistant`. `scope: "tools"` searches
tool names, arguments and result text only; `scope: "all"` combines messages and
tools. Thinking blocks, system instructions, reset handoffs and compaction
summaries are never in these scopes. They remain in Durable; this is a query
filter, not deletion.

`pi.reset` entries are recorded as episode boundaries. A hit's
`episodeStartEntryId` names the reset entry (or the first entry, before any reset)
that begins its episode. Busy resets are therefore observed at their committed
entry boundary, not when a command was submitted.

## Reconciliation and lag

Each search reconciles a bounded slice before querying:

1. Read the current mapped chat sessions. State-only `:channel-state` sessions and
   task-owned background runs are excluded; a mapped fork or task-owned
   conversation is rejected instead of being silently indexed.
2. For each session, verify the first and last indexed entry fingerprints. A
   mismatch clears only that conversation's derived rows and reindexes it.
3. Scan forward from the persisted entry ID in pages of at most 100 entries, with
   at most 2,000 entries per search. Progress, documents, episode rows and source
   fingerprints commit in one index transaction.
4. Measure lag with a bounded count (at most 500 entries, reported as a lower
   bound after that).

A large backlog does not fail a search. `coverage` reports mapped/indexed sessions,
indexed entries, reset boundaries, the page boundary, pending entries, whether the
pending count is complete, malformed stored shapes, records omitted by the per-entry
document cap, and the reconciliation counters. The next call continues
where the previous one stopped.

A crash between a Durable append and an index write loses no source data: progress
was not advanced, so the next search replays that range. A crash during an index
write rolls back documents and progress together. Durable entry IDs are globally
monotonic, so a page cannot skip a lower-ID entry appended later.

## Pagination and source identity

Pages are newest-first by Durable entry ID and then document ID. The cursor is
opaque host state, not authorization. It is bound to:

- the normalized query, scope and roles;
- the derived index generation;
- the source coverage boundary;
- the last document and its entry fingerprint.

Entries appended after the first page have higher entry IDs and stay out of that
continuation; a fresh query sees them. The cursor is rejected when the query
changes, the index file is rebuilt, the mapped session set no longer contains the
source, or the source entry at the boundary no longer matches its fingerprint.

The index also persists the Durable file's device/inode identity and rechecks it
on every search. Replacing the store at the same path (the parked candidate's
cursor bug) clears the derived rows, rotates the generation and invalidates old
cursors. A replacement that preserves the inode *and* the first/last entry
fingerprints could still evade this check; that is a documented residual limit of
content-addressed reconciliation.

## Authorization boundary

The Gateway method accepts no conversation ID. The host supplies mapped chat
sessions after its own channel authentication and is the trust boundary for the
single-tenant policy. Results include `sessionKey`, `conversationId`, `entryId`,
`entryKind`, role, timestamp, episode boundary and a bounded excerpt, so they must
not be exposed directly to an untrusted model or channel. Tool hits are records,
never execution authority and never a grant.

## Limits

See `HISTORY_INDEX_LIMITS`: 500 query characters, 16 terms, 20 hits by default
(50 maximum), 8,000 indexed code points per body, 256 mapped sessions, 100 entries
per scan, 2,000 entries reconciled per search, 64 searchable records per entry, and
500 pending entries counted. Long bodies set `bodyTruncated`; records beyond the
per-entry cap are counted in `omittedDocuments`; excerpts may be shorter than the
indexed body.

## Not implemented

- Episode catalog rows with titles, summaries, status and retry.
- Episode-summary indexing or search.
- Background indexing independent of a search; reconciliation happens on demand.
- Relevance ranking: results are deterministic recency order so keyset pagination
  stays stable while FTS corpus statistics change.
- Fetching surrounding entries by hit; callers can use the source IDs with Durable.
- Channel or CLI history browsing UI.
