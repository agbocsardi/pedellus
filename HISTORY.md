# History search index

`src/history/index.ts` is a rebuildable SQLite full-text index over Durable's
retained entries. It is the first bounded slice of the agreed W3 history design:
message and tool search plus committed reset boundaries. `Gateway.historySearch`
is always available and its derived rows are bound to the store's committed
`nanobot.store-identity`; there is no host-injected identity option. Episode
summaries and summary search are not implemented. The local CLI exposes bounded
search, episode listing and entry windows over these reads; see
[CLI history search and browsing](./CLI.md#history-search-and-browsing). The
same Gateway offers a read-only model-facing `history` tool to mapped chat
conversations by default; the assistant can search, open prior discussion, and
browse reset-delimited episodes without a separate CLI session. See
[Agent-facing tool](#agent-facing-history-tool).

## Authority, identity and storage

- Durable is the only transcript authority. Indexing reads entries through the
  Gateway's `root.commit` transaction surface and never writes Durable's store.
  It does not open a second connection to Durable SQLite.
- The index is a separate derived file: `nanobot-history-index.sqlite` in the
  data directory (derived from the store filename, so two store files in one
  directory cannot collide). The file is created `0600` before SQLite opens it and
  its WAL/SHM sidecars are tightened immediately after; it can be deleted while the
  Gateway is stopped, and the next search rebuilds it from Durable.
- The index is bound to the store's `storeId`, never a path or inode. `openGateway`
  resolves the committed `nanobot.store-identity` document once with
  `ensureStoreIdentity` and passes its `storeId` to the index, so the value is the
  same one `Gateway.historyIdentity()` reports. A changed store ID clears the
  derived rows, rotates the index generation and invalidates every old cursor. The
  index is opened on the first search that has at least one mapped chat session; a
  search with none returns an empty page without opening the file, and the next
  mapped search rebinds it.
- The identity is not a secret and is not a store fingerprint: it is copied with
  the SQLite file. A **clone or restored backup** therefore carries the *same*
  `storeId`, and store-identity replacement alone cannot separate the two lineages.
  That case is covered by the per-conversation anchors below, and only imperfectly
  (see "Replacement, clone and rollback").
- The index stores `conversation_id`, entry IDs and searchable text, but not raw
  `sessionKey` values. Channel labels are resolved from the current session map
  at query time. The derived file still contains private transcript text and must
  stay inside the host trust boundary; its `0600` mode is the same protection a
  Durable store copy already needs, not an additional isolation claim.
- Why a separate file: sharing Durable's connection or writing its file would be
  uncoordinated mutation. A second writable connection can block behind Durable's
  write transaction. Index writes are therefore eventual, idempotent and derived.

## Integration interface

`openGateway` wires the index itself:

```ts
ensureStoreIdentity(harness, context)   // -> frozen { storeId, createdAt }
createHistoryIndex({
  indexPath: historyIndexPath(dbPath),
  sourcePath: dbPath,                   // alias guard only, never an identity
  storeId: identity.storeId,            // resolved once, immutable for this open
  sessions: mappedChatSessions,         // validated chat scope, host-authenticated
  scan: (ctx, read) => root.commit(read, ctx),
})
```

There is no `OpenGatewayOptions` override: an arbitrary caller-supplied identity
string could silently re-bind a stale index to a different store, so the durable
document is the only source. The module still accepts `storeId` as a string or
resolver because it is reusable and testable on its own, and because a resolver is
re-checked before each search.

## Search scopes and query semantics

`gateway.historySearch(query, context)` needs no host configuration: the index is
bound to this store's identity when the Gateway opens. Default scope is user and
assistant message text; `roles` narrows that to `user`
and/or `assistant`. `scope: "tools"` searches tool names, arguments and result
text only and rejects roles. `scope: "all"` combines messages and tools; `roles`
filters message records only, while tool records are always included.

Query text uses FTS5 `unicode61 remove_diacritics 2` tokenization. Terms are
ANDed, each term is quoted/bound, and the last term is a prefix (`deploy` also
matches `deployed`). This is token/prefix matching, **not substring matching**;
punctuation-only text returns no hits and empty text browses the selected scope.
Prefix matching also matches unrelated longer tokens that merely start with the
last term (`cat` finds `category`), and long text can return several hits for one
part, one per overlapping chunk; dedupe with `(entryId, partIndex)` and treat each
excerpt as a chunk fragment rather than a whole message.

Known tokenizer/chunk limits are explicit:
- contiguous CJK runs are one token, so only a full run or a prefix of it matches;
  middle-of-run substrings do not;
- terms must occur in the same chunk. Adjacent chunks overlap by 256 UTF-16 units,
  which reduces boundary misses but does not eliminate a multi-term query whose
  terms fall on opposite sides of that overlap.
- chunks are cut on code-unit boundaries, not word boundaries, so a chunk can end
  (and the next can begin) inside a word. The last-term prefix rule then matches a
  fragment token: a hit may be a part of a longer word rather than a word, and an
  excerpt can start or end mid-word. A word longer than the 256-unit overlap is
  split in every chunk, so the whole word is not a token anywhere. Excerpts are
  quoted fragments; verify against the source entry before relying on exact
  wording.

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
  separate tool records with name, bounded canonical arguments JSON,
  `argumentsError` when present, and `toolCallId`. The serializer budget is 1M
  output units. A string consumes budget directly, but JSON escaping can exhaust
  it before the source string does; any truncation is explicit and makes the part
  count as truncated.
- `pi.tool-result`: tool name plus rendered text content, with `toolCallId` when
  present. `details`, nested-call metadata and image data are not indexed.

System, reset, compaction, archival-record and unknown custom kinds are excluded
by kind, before role handling. Tool records are linked to calls by
`(conversationId, toolCallId)` metadata; orphan calls and results are both kept.

Long message/tool text is chunked at 8,000 UTF-16 code units with a 256-unit
overlap. Generation stops at the 64-chunk/entry cap instead of building all
chunks; every stored chunk remains searchable and a hit includes `chunkIndex` and
`charStart`. A part with omitted chunks increments `coverage.truncatedParts`, sets
`bodyTruncated: true` on its stored chunks, and makes `coverage.complete` false.
This is explicit coverage, never silent truncation of a short record, and never
unbounded chunk generation.

`entry.edits` (`ContextEdit`) is not projected. Raw entries are indexed as the
historical transcript; an entry carrying edits increments
`coverage.editsUnsupported` and makes `coverage.complete` false rather than
claiming the search reflects the active edited context.

## Reconciliation and lag

Each search reconciles a bounded slice before querying:

1. Read the current mapped sessions through the one shared session-map reader
   (`src/history/scope.ts`), which rejects a malformed map, an invalid or root
   conversation ID and two keys sharing one conversation. Chat scope drops
   `:channel-state` keys there, so the index never sees them; the module still
   refuses such a session defensively. The host callback also rejects task-owned
   and forked conversations and more than the session cap before indexing. A
   mapped session
   then becomes chat history only after at least one message/tool record exists in
   the index.
2. For each session, verify the first and last indexed entry fingerprints. A
   mismatch clears only that conversation's derived rows and reindexes it. The
  fingerprint hashes identity fields exactly but bounds model/data content; a
  replacement differing only beyond that budget can share a fingerprint. The
  store identity remains the primary replacement authority.
3. Scan forward from the persisted entry ID in pages of at most 5 entries. Each
   entry is extracted and written in its own index transaction with bounded
   generation; a pass stops at 500 entries, 8 MiB of prepared document text, or
   1.5 s, whichever comes first. Progress, documents, episode rows and source
   fingerprints commit together per entry.
4. Measure lag with a bounded count (at most 100 entries and the same time budget,
   reported as a lower bound after that).

A large backlog does not fail a search. `coverage` reports mapped sessions, the
session cap, chat sessions, indexed sessions, indexed entries, reset boundaries,
truncated parts, unsupported edits, the page boundary, pending entries, whether the
pending count is complete, malformed stored shapes, and reconciliation bytes/time.
`complete` is the authoritative completeness signal: it is false when a budget
stopped reconciliation, pending counting was capped, text was omitted, or
unsupported edits exist. `pendingEntries === 0` does not by itself mean complete.
A no-hit result with `complete: false` is explicitly incomplete. The next call
continues where the previous one stopped.

A crash between a Durable append and an index write loses no source data: progress
was not advanced, so the next search replays that range. A crash during an index
write rolls back documents and progress together. Durable entry IDs are globally
monotonic, so a page cannot skip a lower-ID entry appended later. There is no
`commitSeq` on entry scans and the index does not need one.

### Scan cost

Steady state is cheap but not free: every search opens the derived file, then for
each mapped chat session reads the first and last indexed entries to verify the
anchors and the newest entry to measure lag. A caught-up search therefore costs a
few Durable reads per session plus the FTS query, and indexes nothing. Catching up
reads entries in pages of at most 5, one index transaction per entry, and stops at
500 entries, 8 MiB of prepared text or 1.5 s per pass, so a cold rebuild of `n`
entries needs about `n/5` page reads spread across `n/500`-ish searches. A
256-session map costs 256 anchor checks per search even when nothing changed.

### Replacement, clone and rollback

- **New store file at the same path** (deleted, recreated or initialized from
  scratch): `ensureStoreIdentity` mints a new `storeId`, and the first search with
  a mapped chat session discards every derived row and rebinds the file. A search
  with no mapped session returns an empty page without opening the index, so old
  rows can sit in the file until the next mapped search; they are never returned.
- **Clone or restored backup** (SQLite file copied, identity included): the copy
  has the *same* `storeId`, so identity comparison cannot detect it. Each
  conversation's first/last entry fingerprints are the fallback anchor. After a
  copy is restored and the gateway reopened, an indexed first or last entry that
  no longer exists or matches causes that conversation's rows to be cleared and
  rebuilt on the next search. Divergence between unchanged anchors can go undetected.
- **Same-store rollback** to an earlier copy therefore normally drops the future
  hits of that conversation and rejects continuations bound past the new tail.
- The fallback is not proof. A replacement tail whose identity fields and first
  1M characters of model/data are identical to the old tail can share a
  fingerprint, and entries that are byte-identical in both lineages are rightly
  kept. Treat the derived file as disposable: delete it after restoring a backup if
  exact provenance matters. Replacement requires reopening the gateway; identity is
  resolved at open, not when a file is swapped under a running process. The fixture
  has no per-entry sequence or store-wide content hash.

## Pagination and mapping stability

Pages are newest-first by Durable entry ID and then document ID. The cursor is
opaque host state, not authorization. It is bound to:

- the normalized query, scope and roles;
- the derived index generation and the store identity;
- the hash of the mapped conversation-ID set captured on the first page;
- the source coverage boundary;
- the last document and its entry fingerprint.

Entries appended after the first page have higher entry IDs and stay out of that
continuation; a fresh query sees them. The cursor is rejected when the query
changes, the index or store identity is replaced, the session mapping changes,
the mapped set no longer contains the source, or the source entry at the boundary
no longer exists or no longer matches its fingerprint.

## Agent-facing history tool

`openGateway` installs one read-only, model-facing tool named `history` for mapped
chat conversations by default. It is not in the coding-tool ceiling, cannot be
granted or revoked, accepts no filesystem path or shell command, executes nothing,
modifies no transcript and creates no conversation. A host that needs a bare
gateway can pass `agentHistory: false`; the local CLI/Telegram path uses the
default. The tool reads only conversations already mapped by the host, so channel
authentication and the single-tenant session policy still decide what exists.

The tool calls the same `Gateway.historySearch`, `Gateway.historyEntries`,
`Gateway.listHistoryEpisodes` and `Gateway.historyEpisode` surface as trusted host
code. It has four actions:

- `search` (default): user and assistant message text across every mapped chat
  conversation. `scope: "tools"` searches tool names, arguments and result text
  only, and `scope: "all"` combines both; tool records are never included
  implicitly. `role` narrows message scopes to `user` or `assistant`. Pages are
  1-20 hits with an opaque cursor from the previous result.
- `open`: a bounded window (radius 0-5) around one source entry, addressed by the
  exact `session` source label and `entryId` from a search hit. The default
  message scope omits tool calls/results; `scope: "tools"` or `"all"` includes
  them only when asked.
- `episodes`: reset-delimited episodes for one source, newest first, with entry
  bounds, open/closed state, entry/message/tool-result counts, reset boundary and
  recorded summary status only. `before` must be the exact `next.before` entry ID
  from the previous page. Listing is source-scoped because no host API enumerates
  mapped conversations for a cross-source episode page; `search` is the discovery
  path across mapped chats, and every search hit carries its session label and
  episode start. No total episode count and no cross-source ordering are claimed.
- `episode`: one episode by its start entry ID, plus the first bounded window of
  its displayable message/tool entries. It reads the episode range through
  `Gateway.historyEntries` in ascending pages, hides reset handoff, system,
  compaction, thinking and image-only content by the same rules as `open`, and
  lets `scope` select messages, tools or both. An open episode is pinned to a tail
  entry read at call time; when the result remains open, it says so, and entries
  appended or a reset placed after that snapshot are excluded. A later passage is reached through
  `search` and `open`; this action has no continuation cursor.

Output is explicit about provenance and limits: each hit names its source session,
entry, role, kind, episode start and tool/call identity; each opened entry is
quoted and marked selected/raw. Results report index completeness, lag, omitted
text, malformed records and the captured boundary, and say when a no-hit answer is
incomplete. Historical text is sanitized and JSON-quoted as untrusted data because
prior user text or tool output can contain instructions for a later model; U+2028
and U+2029 are escaped so they cannot create raw line breaks in tool output. The
rendered result is bounded by UTF-8 bytes (48 KiB, then the 64 KiB tool output limiter), with the
mandatory coverage/cursor footer reserved before rows are admitted, and
pagination says whether a fresh search is required for later entries. `open` and
`episode` report the rows actually displayed separately from the rows selected;
rows culled by the byte bound are counted in both that line and the omission
notice. A limit reached inside a raw page reports the unexamined rows and whether
more raw pages remain instead of claiming the episode was exhausted.

This is not summary search: episode summaries and titles do not exist yet, so the
tool says so and searches only raw message/tool records. Episode listing reports
only the catalog's recorded summary status, and episode drilldown returns quoted
original entries as evidence rather than generated prose. Tool hits are records,
never execution authority or a grant. The tool exposes no raw conversation ID and
accepts no conversation ID; `open`, `episodes` and `episode` resolve their session
source through the same mapped-chat validator as every other history read.

## Authorization boundary

The Gateway search and episode methods accept no conversation ID. The host
supplies mapped sessions after its own channel authentication and is the trust
boundary for the single-tenant policy. `Gateway.historyEntries` accepts a session
key but resolves it only through the existing session map: it never creates a
conversation, accepts no conversation ID, and rejects state-only channel sessions.
Entry and episode reads share the search validator that also rejects task-owned and
forked conversations mapped under a chat session key. `historyEntries` returns
bounded raw entries, so the caller must filter system, reset, compaction and
thinking content before display. This is a trusted host surface, not an
untrusted-channel API. Search results include `sessionKey`, `conversationId`,
`entryId`, `entryKind`, role, tool name/call identity, timestamp, episode boundary,
chunk position and a bounded excerpt. The default model-facing `history` tool is
part of the agent's trusted context, but its results must not be forwarded to an
untrusted channel as an API or command surface. Tool hits are records, never
execution authority and never a grant. Stored tool output can contain hostile
instructions; treat excerpts as untrusted quoted data.

## Limits

See `HISTORY_INDEX_LIMITS`: 500 query characters, 16 terms, 20 hits by default
(50 maximum), 8,000-character chunks with 256-character overlap, 64 chunks per
entry, 256 mapped chat sessions (context snapshots have a separate cap over all
mapped sessions), 5 entries per scan,
1M tool-argument units, 500 entries / 8 MiB / 1.5 s per reconciliation pass, and 100
pending entries counted. Long records can produce more than one hit, one per
matched chunk. `HISTORY_TOOL_LIMITS` additionally bounds the model-facing tool: 8
hits by default (20 maximum), radius 2 by default (5 maximum), 1,200 characters per
opened entry, 400 per excerpt, 50 raw entries per episode page and 200 scanned
entries per episode drilldown, and 48 KiB of rendered UTF-8 bytes per result. Quoted
fields escape U+2028 and U+2029, and the output byte budget reserves the mandatory
coverage/cursor footer before adding result rows.

## Not implemented

- Episode summary generation, episode titles and summary search. The episode
  catalog records closed episodes as `pending`; nothing claims or summarizes them.
- Background indexing independent of a search; reconciliation happens on demand.
- Relevance ranking: results are deterministic recency order so keyset pagination
  stays stable while FTS corpus statistics change.
- Fetching surrounding entries by hit through a summary or excerpt API; the local
  CLI's `/entry` and `/episode` windows and the agent-facing `history` tool's
  `open` and `episode` actions use `Gateway.historyEntries`, which returns bounded
  raw entry pages for existing mapped chat sessions. Any other caller can use the
  source IDs with Durable.
- Cross-conversation episode enumeration or pagination. `history` lists episodes
  for one exact source label and discovers sources/episode starts through search
  hits; it does not merge episode pages from several conversations or claim a
  total count.
- Any Telegram or other channel history command, a web surface, or an
  untrusted-channel result API. The model-facing `history` tool is read-only and
  installed by default, and it is not a channel command or an authorization
  surface.
