# History: episode summaries and search index

Two derived layers sit over Durable's retained transcript:

- `src/history/summary-task.ts` is a durable background summary pass, enabled by default.
- `src/history/index.ts` is a rebuildable message/tool and episode-summary index bound to the
  committed store identity.

The default agent-facing `history` tool searches raw messages/tools, browses episodes and original
entries, discovers ready derived summaries across mapped chats, and reads one summary with
provenance and drilldown. Summary text is derived navigation; original entries remain the evidence.
CLI diagnostics are described in
[CLI history search and browsing](./CLI.md#history-search-and-browsing).

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

The tool calls the same `Gateway.historySearch`, `Gateway.historySummarySearch`,
`Gateway.historySummary`, `Gateway.historyEntries`, `Gateway.listHistoryEpisodes` and
`Gateway.historyEpisode` surface as trusted host code. It has six actions:

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
- `summaries`: cross-source topic discovery over the rebuildable summary index. It searches
  `ready` summary titles and bodies only (empty text browses newest), pages 1-20 hits with an
  opaque snapshot-bound cursor, and reports refresh coverage, lag and clamped text. It never
  generates, queues, retries or backfills a summary; pending, failed and corrupt summaries are
  absent and counted, not synthesized, and raw search is unaffected.
- `summary`: one summary by the exact `session` source label and episode-start `entryId`, read
  live from the stored derived documents (not from the index) with provenance: source, episode
  bounds, reset boundary, summarizer version, completion time, coverage of the recorded range and
  clamped-text notice. It then names the drilldown: `episode` for the first bounded window of
  original entries, and `search`+`open` for later passages or exact wording. A missing, pending,
  failed, malformed or unreadable summary is stated explicitly and never blocks the drilldown.

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

Summary text is model output over untrusted stored conversation, so it is quoted and framed as
derived navigation, not evidence. Episode listing reports only the catalog's recorded summary
status; episode drilldown returns quoted original entries as evidence rather than generated prose.
Tool hits are records, never execution authority or a grant. The tool exposes no raw conversation
ID and accepts no conversation ID; `open`, `episodes`, `episode` and `summary` resolve their session
source through the same mapped-chat validator as every other history read. `scope: "tools"` remains
an explicit opt-in for raw tool records and is rejected for summary discovery, whose scope is fixed
to ready summary text.

## Summary discovery index

The summary index lives in the same rebuildable SQLite file as the message/tool index
(`history_summaries`, an FTS5 table over title and body, and `history_summary_sweep`), so it shares
one store identity, one generation, one serialized connection and one delete-and-rebuild lifecycle.
It adds no second connection to Durable and writes no Durable document. The summary read goes through
public document snapshots only: no model request, no summary job, no retry/backfill and no
catalog/episode/transcript write. Store-identity replacement, conversation anchor mismatch and
conversation clearing delete the affected summary rows, and a `schema_version` bump drops and
rebuilds all derived tables. Message/tool tables are created and migrated independently from the
summary tables: if summary table creation or any later summary read/index step fails, this open
reports the summary index as unavailable and raw message/tool search keeps working. The next open
retries the summary schema.

**Readiness is decided from stored documents, not from the index.** The runtime reads the
catalog's `nanobot.episode` document (authoritative closed boundary, lifecycle status and
summarizer version) and the version-keyed `nanobot.episode-summary` record through public
`Harness.snapshot` reads. `src/history/summary-view.ts` normalizes both as untrusted JSON. Only a
`ready` record whose start, end, reset boundary and version agree with the episode document and
whose text is non-empty is exposed; `open`, `pending`, `failed`, missing, malformed and unreadable
states are classified instead of thrown. This read works whether or not the summary pass is enabled
for this open, and it never calls a model, queues a job, retries or backfills. The `summary` tool
action uses the same read directly, so it always shows current stored text, while the index rows
are navigation only.

**Bounded refresh.** `Gateway.historySummarySearch` first runs the same bounded message/tool
reconciliation as raw search, so episode boundaries are current, then re-reads a bounded slice of
summary state only for conversations with indexed message records. Refreshing happens on a summary
search, not on every raw message search, so raw retrieval cost and semantics are unchanged. Both
passes write only the derived file: message reconciliation commits indexed documents/progress within
its documented 500-entry/8 MiB/1.5 s pass, and the summary sweep commits summary rows and its cursor
within 64 reads/1.5 s. Neither pass writes Durable, appends an entry, changes a grant, creates a task
or invokes the episode catalog; a catalog that has not recorded a boundary simply leaves that episode
reported as missing.

The per-conversation slice reserves part of every multi-read quota for older episodes instead of
spending it all on the newest few: up to half of a session's quota (at most the newest four, at
least one when any quota remains) is newest, and the rest continues a durable older round-robin cursor. With a
one-read quota, each conversation alternates between its newest page and its
older cursor, so a one-read source still indexes every episode instead of
re-reading only the newest. One pass reads at most 64 summaries across mapped
chats and stops at 1.5 s. Sessions are
processed in conversation-ID order from a durable cross-session rotation cursor, so when there are
more sessions than the read budget, later sessions get a turn on the next pass instead of being
starved indefinitely. A `13 sessions x 4 closed episodes` history therefore re-reads all 52
episodes in one pass and can report `complete`; `13 x 12` reaches every episode across passes but
never claims per-pass completeness; `65 x 1` reaches sessions beyond the first 64 on later passes
while honestly reporting partial per-pass coverage.

A summary whose record is no longer ready loses its row and is counted. An unreadable document also
loses its row and is counted, because a retained row could present stale summary text as current;
the next successful read re-adds it. A summary search never fails because one stored summary is bad.
`coverage` reports known closed episodes (excluding each conversation's open episode), distinct
episodes re-read in this pass, ready/not-ready/missing/malformed/unreadable counts, removed stale
rows, clamped text, omitted rows, sessions swept and pending. `complete` is per-pass and
conservative: it requires caught-up episode reconciliation, every known closed episode re-read in
this pass, no partially checked source, no malformed/unreadable records, no clamped text and no
omitted rows. A bounded sweep that re-reads only part of the history can never claim `complete`, and
its no-hit result says absence is not proven. A summary written inside a bounded fold can exceed the
8,000-character stored cap only through a hand-edited or legacy record; indexing clamps it to 20,000
code units and 32 KiB of UTF-8 (title 500 code units and 1 KiB), with an explicit flag, and the
whole-index body budget is 64 MiB. A new row beyond that budget is not stored; a **replacement** that no longer
fits removes the previous row instead of leaving its text in place as if current. The omission (and
removal, if any) is counted for that pass (`summariesOmitted`, `summariesRemoved`) and the full
budget is reported as `indexFull` with `indexBytes`, so it is never silent. The byte counter is
recomputed from stored rows when the summary schema is created or repaired, so a stale counter
cannot make an empty content table look full. A rebuild starts from empty and can admit the same
history again.

**Integrity.** Before every summary page, the summary schema object types and columns (content
table, FTS table, all three triggers, sweep table) are checked, and FTS5 `integrity-check` compares
the index with the content table. A deleted FTS table/trigger, a wrong-shaped sweep table, or a
logical FTS mismatch triggers repair: the FTS/triggers are recreated, the index is rebuilt from
stored content, and the byte counter is recomputed. A wrongly shaped content table is dropped and
recreated empty so later bounded sweeps can repopulate it. If repair fails, or any summary SQL error
escapes, the summary index is reported `indexReady: false` and `complete: false` and raw
message/tool search continues normally. Repair keeps a valid content table, so stored summary rows
are preserved when only the FTS layer or sweep state is missing. The integrity check runs on demand,
not on raw search, and is bounded by the 64 MiB summary-index budget. An offline synthetic
review measured roughly 0.44–0.49 seconds per summary page at that cap. A view occupying a summary
schema name can prevent repair across reopen; the summary index remains unavailable until the
rebuildable index is deleted and rebuilt.

**Snapshot pagination.** Summary pages are newest-first by episode start entry ID then conversation
ID. The opaque cursor binds the normalized query, schema generation (which rotates on store-identity
replacement), the mapped conversation-ID hash, a captured `summary_id` watermark, the number of rows
at or below that watermark, and the last row's start entry, conversation and content fingerprint.
Every content change is a delete+insert, never an in-place update, so a row at or below the watermark
cannot be rewritten in place: the snapshot row count changes if any snapshot member is deleted or
replaced, and the cursor is rejected with an explicit "snapshot changed" error instead of silently
omitting older matching summaries. A changed boundary row, query or mapping, a rebuilt index or a
replaced store rejects the cursor the same way. Newly indexed rows after the first page receive a higher
`summary_id`; they are excluded from that continuation and reported as `summariesAfterSnapshot` with
`snapshotCurrent: false`, so a partial page never implies those newer summaries do not exist.
Replacing or removing any row that belongs to the snapshot changes the snapshot row count and
rejects the cursor rather than silently omitting it from the continuation. A fresh summary search is
required for a current view.

## Scope validation (shared rule)

A session key is a host string and can be forged, imported or left behind by an older
layout, so the key alone never decides scope: `chatScopeExclusion` in `src/history/scope.ts`
classifies the conversation record (`missing`, `root`, `task-owned`, `forked`) and every derived
history consumer uses it. Search, entry reads and episode reads fail loudly with "Stored session
mapping points to a task-owned conversation" / "… forked conversation". The episode catalog and the
summary scheduler instead skip such a mapping, so one forged entry cannot stop cataloguing or
summarizing the conversations that really are chat history, and the summary worker re-checks scope in
its first commit: a job whose conversation is out of scope fails with `conversation-out-of-scope` and
creates no summary record, so a task-owned background run's transcript or an inherited fork can never
be summarized into chat history or reach a provider through this pass.
The rule itself and the read pattern live in one place: `chatScopeExclusion` (classify one record),
`readChatScope` (read one), `partitionChatScope` (split a mapped set) and `chatScopeMessage` (the fixed
rejection text) in `src/history/scope.ts`. `assertMappedChatConversations`, the catalog's
`mappedChatSessions` and the summary worker's `scope` hook all call those, so the three consumers cannot
drift apart. `assertMappedChatConversations` in `runtime.ts` is the same check main's shared validator
uses; the coordinator's version supersedes this one at merge time.

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
matched chunk. `HISTORY_SUMMARY_LIMITS` bounds summary discovery: 500 query
characters and 16 terms (the same FTS tokenizer), 8 hits by default (20 maximum),
400-character browse excerpts, 20,000 code units and 32 KiB of UTF-8 per summary
body, 500 code units and 1 KiB per title (the summary pass itself stores at most
8,000 and 120), up to half of each session's quota reserved for the newest
episodes (at most four) and the rest for the older round-robin, at most eight
episodes per source per pass, a durable cross-session rotation cursor, a 64 MiB
whole-index body budget with reported omissions and `indexFull`/`indexBytes`,
the newest four episodes per source plus at most eight per source per pass, 64
summary reads across mapped chats per pass, and 1.5 s. `HISTORY_TOOL_LIMITS` additionally bounds the
model-facing tool: 8 hits by default (20 maximum), radius 2 by default (5 maximum),
1,200 characters per opened entry, 400 per excerpt, 200 per summary title, 4,000 per
summary body, 50 raw entries per episode page and 200 scanned entries per episode
drilldown, and 48 KiB of rendered UTF-8 bytes per result. Quoted fields escape
U+2028 and U+2029, and the output byte budget reserves the mandatory
coverage/cursor footer before adding result rows. Tool errors for summary reads and searches are
fixed text: stored-record failures are classified, and host paths, provider text and exception
messages are never rendered into the tool result. Index size is bounded by the per-body/title byte
clamps and the whole-index budget, so a derived summary file cannot grow through one hand-edited
record; the number of rows still grows with the number of episodes, like the message/tool index.

## Episode summaries

`src/history/summary-task.ts` runs one durable background task chain per mapped chat
conversation and writes a derived summary for each closed, non-empty episode. Summaries are enabled
by default and use the conversation's selected model when a job starts. The choice is persisted for
that job's retries and rechecked against `allowedModels` before every call. Set
`"episodeSummary": { "model": { "provider": "...", "modelId": "..." } }` to use an allowed
model instead, or `"episodeSummary": { "enabled": false }` to disable summary work. The Gateway's
explicit `OpenGatewayOptions.episodeSummary` remains a host override.

Provider requests use short cache retention where supported, but this separate summary prompt does
not necessarily share a prefix with the conversation; cache hits are not guaranteed. Background
summaries can incur provider costs.

**Activation and backfill policy.**

- Default activation includes the currently open episode when it closes, but does not automatically
  summarize already-closed episodes. A durable per-conversation watermark preserves this boundary.
  The explicit Gateway host override retains its prior activation watermark behavior.
- `backfill: "none"` (default) keeps that boundary. `backfill: "pending"`, or an explicit
  `backfillEpisodeSummaries` call, is the deliberate opt-in to already-closed episodes: a bounded,
  resumable scan of the catalog's own episode listing (`backfillBeforeEntryId`, four pages per pass)
  queues every closed episode whose record is not ready, whether it was catalogued before opt-in or
  omitted by the queue cap.
- That scan advances its durable cursor **only** when the whole page was queued and the catalog had
  recorded every boundary on it. Queue capacity delays candidates instead of dropping them: they are
  not counted in `overflow`, the cursor stays where it was, and the next call re-lists the same page
  (identity dedupe makes the already-queued ones free). The result reports `{queued, pages, complete,
  reason}` with `queue-full`, `catalog-behind` or `bounded`, so an incomplete scan is never presented
  as finished and `backfillCompleteAtMs` is only written after a full pass. At startup the catalog
  reconciles (bounded) before the scan runs, because an unrecorded boundary is not work yet.
- `retryEpisodeSummary(startEntryId)` recreates a job from the closed episode document, so a failed,
  retained-out, cap-omitted or watermark-excluded episode is never unrecoverable. It reports
  `queued`, `already_queued`, `already_ready`, `queue_full`, `missing`, or `version_incompatible` when
  the episode record names a *newer* summarizer version than this build: such a job would be retired
  as obsolete in its first commit, so the call says so instead of promising work it cannot do, and it
  leaves both the queue and the episode record untouched.
- `historySummaryQueue` reports the policy (`backfill`, `sinceEntryId`, `backfillBeforeEntryId`,
  `backfillCompleteAtMs`), the counters, the model policy (`conversation/current` for the default),
  any blocked chain and any stranded chain, so an operator can see why nothing is being summarized.

**Durability and ordering.**

- The episode catalog queues a job inside the commit that records a closed episode, and that same
  commit creates the worker task. A crash can neither lose a closed episode nor queue it twice.
- Episode documents are a Durable document family keyed by start entry ID, and this Durable version
  cannot enumerate a family. A conversation-scoped `nanobot.episode-summary-queue` document is
  therefore the enumerable work list: `(startEntryId, summarizerVersion)` is the job identity, so a
  retry is always the same job, never a second entry.
- One conversation runs at most one summary task. A task owns exactly one job and its final commit
  starts the next queued job, so the chain is ordered and bounded, with no provider fan-out. Every
  terminal path — ready, failed, superseded, aborted — clears this task's chain pointer and hands
  the queue on, so no branch can strand the queue behind a dead task. An abort stops the current
  attempt, settles its spend and returns the job to the queue; the chain continues with the oldest
  queued job (usually the same one), so an abort never leaves queued work without a worker. A pointer
  that is nevertheless terminal or missing while jobs wait — or that is absent while jobs wait — is
  reported as `stalled: { reason: "no-worker", startEntryId }` (derived from the task record, re-read
  to avoid a hand-off race) and `drainEpisodeSummaries` restarts it. Job removal is per
  `(startEntryId, summarizerVersion)`, so one version's completion never deletes another version's
  queued job.
- The catalog's background scheduler now keeps a mid-pass request flag: a reset that commits while a
  pass is running arms another pass instead of being dropped as "caught up" until the next reset or
  reopen. The pure decision is `catalogWorkAction` in `episodes.ts`.
- Source entries are read from committed entries only, through the immutable boundary the episode
  document recorded (`[startEntryId, endEntryId]`), never from the current compacted context. The
  pass appends no entry, resets nothing, reorders nothing, calls no tool and touches no grant. It
  only writes its own derived documents and makes one provider request per fold chunk.
- A summary record is keyed `<startEntryId>:<summarizerVersion>`, so a summarizer version bump writes
  a distinct record instead of overwriting another version's history. The episode document records
  which version is authoritative, and `historyEpisodeSummary` reads that version's record.
  - An episode that is **not ready** adopts a newer job's version: the job rewrites the episode
    document's `summarizerVersion` in the same commit that claims it, and summarizes normally. A
    version bump therefore migrates history forward through `retryEpisodeSummary` or
    `backfillEpisodeSummaries` instead of stranding it, and the older version's derived record stays
    addressable under its own key.
  - An episode recorded at a **newer** version makes an older job obsolete; that job is retired, and
    the newer version's own live job or record covers the work.
  - An episode that is already **ready** is never re-summarized automatically, whatever the version.
    Replacing a ready summary with a newer summarizer version would need an explicit operation that
    does not exist yet (see limitations).
- A chain that Durable parks at its restart limit is reported, not hidden:
  `drainEpisodeSummaries` and `historySummaryQueue` return
  `blocked: { taskId, reason }`, and the host revives it with `Harness.retryTask(taskId)`.

**Provider accounting and failure reporting.**

- `attempts` counts provider requests that were started and is committed *before* each request, so a
  crash cannot erase the fact that spend may have happened. `usage` sums only answers that arrived.
  `pendingAttempt` records that one attempt is outstanding, and it is durable on the summary record
  rather than in the task checkpoint, so an explicit abort (which discards the checkpoint) cannot lose
  it. Whoever resolves it — the next attempt, the abort handler, or a terminal decision — settles it
  as `interruptedCalls`, keeping
  `attempts === usage.calls + interruptedCalls + (pendingAttempt ? 1 : 0)` true at every point.
  Both counters survive retries, aborts and reopen.
- The per-chunk provider budget is durable for the same reason: `chunkAttempts` and `retryAtMs` live
  on the summary record, not in the task checkpoint. A worker that starts with a pending deadline
  enters a `backoff` phase and sleeps durably until it, and a fold refuses to start a request once
  `chunkAttempts` has reached the budget. **An abort is not a pause**: it settles the outstanding
  attempt, keeps the spent chunk budget and records a fresh deadline, so restarting a job can neither
  refill its budget nor skip its delay. The budget resets only when a chunk completes.
  Verified: an abort during a hung request settles as one interrupted attempt and the next start is
  delayed by the recorded backoff; a normal provider-failure run ends after exactly four attempts,
  four observed provider errors, no pending attempt, and a terminal `provider-error-transient` with the
  queue settled (a normal-failure terminal check, run separately from the abort case). An independent
  review subsequently exercised the *abort* loop to its own terminal state over four rounds, which is
  the abort-specific terminal evidence this note previously lacked. Not verified: a worker that
  actually faults in integration — the `worker-faulted` recovery path is exercised only through the
  pure claim-settling helper, never by a real faulted task in a running harness.
- Only a fixed, classified failure vocabulary is persisted (`EPISODE_SUMMARY_FAILURES`):
  `model-unavailable`, `unsupported-thinking-level`, `provider-error-transient`,
  `provider-error-permanent`, `provider-aborted`, `output-limit`, `empty-summary`, `empty-source`,
  `source-unrenderable`, `worker-faulted`, `episode-boundary-missing`,
  `episode-summarizer-version-changed`, `episode-already-ready`, `job-not-queued`,
  `job-claimed-by-another-task`, `conversation-out-of-scope`. Provider exception text, request payloads, headers,
  tokens, cookies and JWTs are never written to durable state; a host that wants the provider's own
  words reads `HarnessOptions.onReport` (`task_error`), which stays in process.
- A retryable provider error sleeps with exponential backoff (2 s doubling to 60 s) up to 4 attempts
  per chunk, then records the classified failure. A request that throws instead of answering
  (transport error, timeout, SDK rejection) is classified the same way, as
  `provider-error-transient` with its attempt counted as interrupted, rather than as a permanent
  provider verdict. A raw crash loop is Durable's own concern.
- The configured `thinkingLevel` is validated at open against the selected model's supported levels
  and re-checked at each dispatch; an unsupported level fails the episode as
  `unsupported-thinking-level` instead of burning a provider request. A `null`/non-object
  `episodeSummary` is rejected as a startup diagnostic, and a missing or empty model is a type error.

**Source, coverage, chunking and untrusted text** (`summary-source.ts`).

- `pi.user` and `nanobot.cron` entries contribute their user text; `pi.assistant` entries contribute
  visible text and a compact tool-call list; `pi.tool-result` entries contribute tool name plus text.
  Thinking blocks are omitted. `pi.reset` (including handoff text), `pi.system` and `pi.compaction`
  entries are skipped but counted: they are synthetic context, not discussion. `entry.edits` are not
  applied, so a summary describes the stored transcript.
- Rendering is total over stored data. An entry is JSON, not a typed API call: a legacy, imported or
  hand-written entry can hold any shape a store accepts, so a non-array `model`, a `null` element, a
  numeric or missing `text`, a `null` block or message, an unknown role, a nameless tool call, circular
  tool arguments and a missing or non-string `kind` are all normalized (skipped, stringified or
  described as `unknown-tool`) instead of thrown. `renderEntries` renders a page with one part per
  entry, so the chunk boundaries `collect` computes and the text `fold` sends stay identical.
  - A residual read failure is a property of the episode, not a transient fault: it is classified as
    `source-unrenderable`, recorded in the queue, the episode document and the summary record, and the
    chain is handed on. It does not throw out of a phase, because a task fault would strand every
    later job behind it. This is a safety net: because rendering is total, no stored shape tested so
    far reaches it, so the classification path itself has not been triggered end to end.
  - If a worker ever does fault anyway, `reviveOrphanedClaims` bounds recovery: a faulted claim counts
    one `faults` on the job, retries up to `maxWorkerFaults` (3), and then fails the job as
    `worker-faulted` instead of retrying forever. The counter is normalized first (`safeCount`), so a
    legacy, hand-edited or forged job with a missing, `null`, `NaN`, negative, fractional or string
    `faults` counts from zero instead of becoming `NaN` — and since every `NaN >= cap` comparison is
    false, that normalization is what keeps the cap effective. On failure the counter is clamped to the
    cap, so the durable value stays a small exact integer that always serializes cleanly.
- One entry keeps at most 2,000 characters with a visible truncation marker. Chunks close at 24,000
  characters or 400 entries (also at each read page), at most 12 chunks per episode, and each chunk is
  folded through a separate provider request that carries the previous answer forward.
- `coverage` records the source bounds and counts from the episode document, the entries
  read/included/skipped/truncated, characters, chunks, and the uncovered count with the last covered
  entry ID. `complete` is true only when every entry in the range was read; an uncovered tail is
  explicit, never silent. Per-entry shortening does not flip `complete` and is counted separately.
- Untrusted text is framed, not trusted: the transcript and every earlier summary are wrapped in
  `«transcript»…«/transcript»` / `«summary»…«/summary»` fences after every `«` and `»` in the text is
  neutralized to `‹`/`›`, so stored text cannot close or open a fence, or speak as the prompt around
  it. Only those two characters are rewritten, so code, commands, paths and URLs stay exact. No tools
  are offered, the system prompt says the fenced text is data, and a summary is never execution
  authority and never a grant.

**Stored records.**

- `nanobot.episode-summary-queue` holds pending, claimed and (bounded) failed jobs, the single live
  task pointer, the opt-in watermark, the backfill cursor and an explicit `overflow` counter. Each job
  also carries `attempts`, `faults`, `retryAtMs` and a classified `lastError`. It keeps at most 256
  jobs and 20 failed jobs; a job beyond the cap is not queued and the omission is counted.
  The episode stays `pending`, so the gap is visible in `listHistoryEpisodes` and recoverable through
  backfill or retry.
- `nanobot.episode-summary` holds status (`running`/`ready`/`failed`), provider/model, summarizer
  version, title, bounded summary text, `attempts`, `interruptedCalls`, `pendingAttempt`,
  `chunkAttempts`, `retryAtMs`, `coverage`, aggregated `usage`, `completedAtMs` and the classified
  `error`. A failed pass stores no summary text.
- The episode document mirrors `summary.status`, `attempts`, `title` and the summarizer version, so
  `listHistoryEpisodes` shows the lifecycle without reading summary records.

**Host API (dark unless opted in).** `historyEpisodeSummary(sessionKey, startEntryId)`,
`historySummaryQueue(sessionKey)`, `drainEpisodeSummaries(sessionKey)`,
`backfillEpisodeSummaries(sessionKey)` and `retryEpisodeSummary(sessionKey, startEntryId)`. All fail
closed without an opted-in model. Reading a summary is host-authoritative: the host authenticates the
session key, and the summary text is model output over untrusted source.

**Known limitations.**

- Provider spend is recorded on the summary record only, not in Durable's conversation `pi.usage`
  ledger: pi-durable 1.4.0 does not export `recordUsage`, and this slice does not write that document
  privately. The CLI usage view therefore excludes summarization.
- An attempt that was in flight and is settled as interrupted is counted, not priced: its token and
  cost contribution is unknown by definition, so `usage` is a lower bound on spend.
- Summary discovery is bounded and on-demand: it refreshes only on a summary search, and with many
  episodes a newly ready summary can take several searches to appear. There is no readiness
  notification, no background summary-index refresh, no CLI/channel summary surface and no date
  index; dates are unavailable because Durable entries have none.
- A summary refers to the derived record's stored text; there is no re-summarize operation, so a
  ready summary is not replaced after a summarizer version bump.
- A ready episode is never re-summarized, at any summarizer version. Replacing a ready summary after a
  version bump would need an explicit re-summarize operation, which does not exist yet.
- Already-closed history is summarized only through explicit backfill or retry. Default activation
  includes the currently open episode; the explicit Gateway override keeps its older watermark behavior.
- A parked chain keeps its jobs claimed until a host calls `Harness.retryTask(taskId)` or retries the
  failed job; nothing revives a parked task automatically.
- Backfill is bounded and resumable rather than exhaustive in one call; a full queue, a catalog that
  has not recorded a page yet, or the per-call page budget stops it with `complete: false` and a
  reason, and the same page is retried later.
- Model fidelity and real-provider behavior are unverified: only a faux provider over temporary
  synthetic data has been used.

## Not implemented

- Background indexing independent of a search; message reconciliation and the summary sweep both
  happen on demand, and summary rows refresh only on a summary search.
- Summary ranking beyond recency: summary pages are newest-first by episode start, with no relevance
  score or cross-source date ordering.
- Relevance ranking: results are deterministic recency order so keyset pagination
  stays stable while FTS corpus statistics change.
- Fetching surrounding entries by hit through a summary or excerpt API; the local
  CLI's `/entry` and `/episode` windows and the agent-facing `history` tool's
  `open` and `episode` actions use `Gateway.historyEntries`, which returns bounded
  raw entry pages for existing mapped chat sessions. Any other caller can use the
  source IDs with Durable.
- Cross-conversation episode enumeration or pagination. `history` lists episodes
  for one exact source label and discovers sources/episode starts through search
  or summary hits; it does not merge episode pages from several conversations or
  claim a total count.
- Any Telegram or other channel history command, a web surface, or an
  untrusted-channel result API. The model-facing `history` tool is read-only and
  installed by default, and it is not a channel command or an authorization
  surface.
