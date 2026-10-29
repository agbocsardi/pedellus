# History search index

`src/history/index.ts` is a rebuildable SQLite full-text index over Durable's
retained entries. It is the first bounded slice of the agreed W3 history design:
message and tool search plus committed reset boundaries. Episode summaries and
summary search are not implemented.

## Authority, identity and storage

- Durable is the only transcript authority. Indexing reads entries through the
  Gateway's `root.commit` transaction surface and never writes Durable's store.
  It does not open a second connection to Durable SQLite.
- The index is a separate derived file: `history-index.sqlite` in the data
  directory, with owner-only (`0600`) file and SQLite sidecars. It can be deleted
  while the Gateway is stopped; the next search rebuilds it from Durable.
- The index is bound to a caller-supplied `storeId`, never a path or inode. The
  planned durable `nanobot.store-identity` document is the authority for that
  value; `HistoryIndexOptions.storeId` accepts a string or an async resolver that
  is re-checked before each search. A changed store ID clears the derived rows,
  rotates the index generation and invalidates every old cursor.
- The index stores `conversation_id`, entry IDs and searchable text, but not raw
  `sessionKey` values. Channel labels are resolved from the current session map
  at query time. The derived file still contains private transcript text and must
  stay inside the host trust boundary.
- Why a separate file: sharing Durable's connection or writing its file would be
  uncoordinated mutation. A second writable connection can block behind Durable's
  write transaction. Index writes are therefore eventual, idempotent and derived.

## Integration interface

The index accepts the caller-owned identity directly:

```ts
createHistoryIndex({
  indexPath,              // dataDir/history-index.sqlite
  storeId,                // string, or (context) => Promise<string> from nanobot.store-identity
  sessions: (context) => Promise<readonly HistorySession[]>,
  scan: (context, read) => Promise<T>, // root.commit(read, context), read-only
})
```

`openGateway` exposes the same injection point as
`OpenGatewayOptions.historyStoreId` (string or async resolver). Without it,
`Gateway.historySearch` fails closed rather than inventing a path/inode identity.
The coordinator can resolve the durable identity document after the harness root
is available and supply either form.

## Search scopes and query semantics

`gateway.historySearch(query, context)` requires the Gateway to be opened with a
`historyStoreId`; without one it fails closed instead of inventing identity.
Default scope is user and assistant message text; `roles` narrows that to `user`
and/or `assistant`. `scope: "tools"` searches tool names, arguments and result
text only; `scope: "all"` combines messages and tools.

Query text uses FTS5 `unicode61 remove_diacritics 2` tokenization. Terms are
ANDed, each term is quoted/bound, and the last term is a prefix (`deploy` also
matches `deployed`). This is token/prefix matching, **not substring matching**;
punctuation-only text returns no hits and empty text browses the selected scope.

Thinking blocks, system instructions, reset handoffs, compaction summaries,
images and payload metadata are never in these scopes. They remain in Durable;
this is a query filter, not deletion. `pi.reset` entries are recorded as episode
boundaries. A hit's `episodeStartEntryId` names the reset entry (or the first
entry, before any reset) that begins its episode, so busy resets are observed at
their committed boundary rather than command receipt time.

## Extraction

Only these entry kinds contribute searchable records:

- `pi.user` and `nanobot.cron`: user text.
- `pi.assistant`: text blocks become assistant records; `toolCall` blocks become
  separate tool records with name, canonical arguments JSON, `argumentsError`
  when present, and `toolCallId`.
- `pi.tool-result`: tool name plus rendered text content, with `toolCallId` when
  present. `details`, nested-call metadata and image data are not indexed.

System, reset, compaction, archival-record and unknown custom kinds are excluded
by kind, before role handling. Tool records are linked to calls by
`(conversationId, toolCallId)` metadata; orphan calls and results are both kept.

Long message/tool text is chunked at 8,000 UTF-16 code units. Every chunk remains
searchable; a hit includes `chunkIndex` and `charStart`. At most 64 chunks are
stored per entry, enough for roughly 512k characters. Chunks beyond that cap are
counted in `coverage.omittedChunks`, and every stored chunk of that part carries
`bodyTruncated: true`. This is explicit coverage, never silent truncation of a
short record.

## Reconciliation and lag

Each search reconciles a bounded slice before querying:

1. Read the current mapped sessions. Task-owned and forked conversations are
   rejected. A mapped session becomes chat history only after at least one
   message/tool record exists in the index; channel-state bookkeeping is thereby
   excluded without reserving a session-key suffix.
2. For each session, verify the first and last indexed entry fingerprints. A
   mismatch clears only that conversation's derived rows and reindexes it.
3. Scan forward from the persisted entry ID in pages of at most 100 entries, with
   at most 2,000 entries per search. Progress, documents, episode rows and source
   fingerprints commit in one index transaction.
4. Measure lag with a bounded count (at most 500 entries, reported as a lower
   bound after that).

A large backlog does not fail a search. `coverage` reports mapped sessions, the
session cap, chat sessions, indexed sessions, indexed entries, reset boundaries,
the page boundary, pending entries, whether the pending count is complete,
malformed stored shapes, omitted chunks, and reconciliation counters. The next
call continues where the previous one stopped.

A crash between a Durable append and an index write loses no source data: progress
was not advanced, so the next search replays that range. A crash during an index
write rolls back documents and progress together. Durable entry IDs are globally
monotonic, so a page cannot skip a lower-ID entry appended later. There is no
`commitSeq` on entry scans and the index does not need one.

## Pagination and mapping stability

Pages are newest-first by Durable entry ID and then document ID. The cursor is
opaque host state, not authorization. It is bound to:

- the normalized query, scope and roles;
- the derived index generation and the caller-supplied store identity;
- the hash of the mapped conversation-ID set captured on the first page;
- the source coverage boundary;
- the last document and its entry fingerprint.

Entries appended after the first page have higher entry IDs and stay out of that
continuation; a fresh query sees them. The cursor is rejected when the query
changes, the index or store identity is replaced, the session mapping changes,
the mapped set no longer contains the source, or the source entry at the boundary
no longer matches its fingerprint.

## Authorization boundary

The Gateway method accepts no conversation ID. The host supplies mapped sessions
after its own channel authentication and is the trust boundary for the
single-tenant policy. Results include `sessionKey`, `conversationId`, `entryId`,
`entryKind`, role, tool name/call identity, timestamp, episode boundary, chunk
position and a bounded excerpt, so they must not be exposed directly to an
untrusted model or channel. Tool hits are records, never execution authority and
never a grant. Stored tool output can contain hostile instructions; treat excerpts
as untrusted quoted data.

## Limits

See `HISTORY_INDEX_LIMITS`: 500 query characters, 16 terms, 20 hits by default
(50 maximum), 8,000-character chunks, 64 chunks per entry, 256 mapped sessions,
100 entries per scan, 2,000 entries reconciled per search, and 500 pending
entries counted. Long records can produce more than one hit, one per matched
chunk.

## Not implemented

- Episode catalog rows with titles, summaries, status and retry.
- Episode-summary indexing or search.
- Background indexing independent of a search; reconciliation happens on demand.
- Relevance ranking: results are deterministic recency order so keyset pagination
  stays stable while FTS corpus statistics change.
- Fetching surrounding entries by hit; callers can use the source IDs with Durable.
- Channel or CLI history browsing UI.
