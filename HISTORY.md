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
classifies the conversation record (`missing`, `root`, `automation`, `task-owned`, `forked`) and
every derived history consumer uses it. Search, entry reads and episode reads fail loudly with
"Stored session mapping points to a task-owned conversation" / "… forked conversation" /
"… a scheduled run's automation conversation". The episode catalog and the
summary scheduler instead skip such a mapping, so one forged entry cannot stop cataloguing or
summarizing the conversations that really are chat history, and the summary worker re-checks scope in
its first commit: a job whose conversation is out of scope fails with `conversation-out-of-scope` and
creates no summary record, so a task-owned or automation transcript or an inherited fork can never
be summarized into chat history or reach a provider through this pass.

The `automation` reason exists because a scheduled run's conversation is ownerless by design: it
outlives the run task that created it, so `owner`/`parent` cannot distinguish it from a chat. The
host states the class instead, from the durable `nanobot.cron.conversation` marker plus the origin's
cron documents, and `runtime.ts` passes it into the shared rule as `automation: true` — so a stale or
forged mapping naming one is rejected explicitly rather than by the accident of it being unmapped.
The same class keeps every other capability set closed: an automation conversation is never in the
authenticated mapped-chat set, the worker spawner set, the web/Telegram/MCP/Code Mode scope, the
classifier scope or the cron-owner set, and its prepared tools are retired when each run ends. The
channel ingress path reads the same record first and refuses the mapping with the same fixed message
before anything else runs, so a mapped automation conversation cannot become a cron owner, gain an
unevictable snapshot slot or have a live run's capture retired by the chat policy pass.

The rule itself and the read pattern live in one place: `chatScopeExclusion` (classify one record),
`readChatScope` (read one), `partitionChatScope` (split a mapped set) and `chatScopeMessage` (the fixed
rejection text) in `src/history/scope.ts`. `assertMappedChatConversations`, the catalog's
`mappedChatSessions` and the summary worker's `scope` hook all call those, so the three consumers cannot
drift apart. `assertMappedChatConversations` in `runtime.ts` is the same check main's shared validator
uses; the coordinator's version supersedes this one at merge time.

## Automation conversations in indexing

Episode indexing covers automation conversations; the message/tool search index and the summary
policy do not. A scheduled run's conversation is catalogued like a chat one: the reset boundary that
starts each run closes the previous episode, and closed episodes are recorded with their counts and
recovery boundaries. Its entries are ordinary Durable entries, including the `nanobot.cron` input
kind that the summary source already treats as user text.

Episode *summaries* are not generated for them. Summaries are a model-spend opt-in whose only reader
is the mapped-chat-scoped `history` tool, and nothing can read an automation conversation through it,
so initializing the summary policy there would spend on text no surface would show. The
catalog therefore records the conversation's opt-in watermark and defers its closed episodes, which
stay `pending`; a future surface that reads them would start from that recorded point rather than
resummarizing history.

The search index is bound to mapped chat sessions: its rows, its cursor identity and the read-only
`history` tool all resolve a source through the session map and the chat scope rule, and a
conversation that is not a chat session has no label to report and no readable source. Automation
conversations are therefore excluded from that index rather than indexed under a synthetic key that
the tool could not open. Reading a scheduled run's own transcript is an operator/store-level action,
not a `history` tool action.

## Authorization boundary

The Gateway search and episode methods accept no conversation ID. The host
supplies mapped sessions after its own channel authentication and is the trust
boundary for the single-tenant policy. `Gateway.historyEntries` accepts a session
key but resolves it only through the existing session map: it never creates a
conversation, accepts no conversation ID, and rejects state-only channel sessions.
Entry and episode reads share the search validator that also rejects task-owned,
automation and forked conversations mapped under a chat session key. `historyEntries` returns
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
`"episodeSummary": { "preset": "fast" }` to reuse a configured named preset, including its
thinking setting. Legacy direct configs can use `"episodeSummary": { "model": { "provider": "...",
"modelId": "..." } }` instead. Set `"episodeSummary": { "enabled": false }` to disable work. The Gateway's
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

## Digestion input and cursor

`src/history/digestion.ts` is the one bounded, source-labeled evidence reader for conversation
digestion (memory curation) and its one durable cursor. `openGateway` injects it into
`src/history/memory-digest.ts` below; a run still starts only on an explicit manual command or cron
intent. The module calls no model, writes no memory, creates no task, schedules nothing and adds no
tool surface. There is no second reader or second cursor.

```ts
createDigestSource({
  harness,                       // the same Harness openGateway already owns
  sessions: mappedChatSessions,  // the host-validated provider the index/catalog use
});
const result = await source.read(context);    // DigestBatch | DigestIdle
await source.acknowledge(batch, context);     // only after the caller consumed it
await source.cursor(conversationId, context); // status/tests, read-only
```

Eligibility is a **completed-turn high-water**, not a closed episode. A segment ends just before a
`pi.reset` that follows an owner (`pi.user`/`nanobot.cron`) turn, just before the next owner or
scheduled input, or at a terminal assistant entry whose tool calls are all paired. An in-progress
tail — an owner message still awaiting an answer, an assistant tool round, or a tool result awaiting
its next assistant entry — is never offered. An assistant entry stopped by an explicit error or abort
cannot close a turn. A reset before the first owner input stays inside the next segment's prefix, so a
leading system/reset block is consumed without its own model-free batch. One read offers only
evidence that was already a completed exchange when the read began; entries appended later belong to
a later segment, and an accepted batch's bounds never move.

One scan tracks the furthest completed turn and admits one range covering every completed turn it
reaches inside its 4,000-entry discovery bound, so three short turns are one batch, not three. A
range whose evidence fits both batch bounds is one batch, delivered with `complete: true` and
acknowledged once. Only a larger range splits, into independent ordered chunks that each carry their
own acknowledgement. The tail, a reset after an owner turn, or the scan bound ends the range at its
last completed turn, so an unfinished trailing turn is never cut into it and stays queued. There is
no carry-over note, running summary or cross-chunk state.

Evidence shape and trust labels:

- Owner messages and scheduled triggers are `owner`; assistant message text is `assistant`; assistant
  tool calls and their paired results are always `untrusted-tool`. Reset handoffs, system and
  compaction entries, assistant thinking and unpaired tool results are consumed inside the range but
  contribute no evidence. A tool result pairs only with a call id still open in the same segment; the
  open-call set is durable in the cursor, so a result in a later chunk or after a reopen still pairs.
  A call id longer than 200 characters fails the segment closed instead of silently orphaning its
  result.
- Message prose and tool-call arguments are lossless fragments of the original entry (UTF-16 offsets,
  surrogate-safe); a cut continues in the next chunk from exactly that offset. A tool result is
  machine output: a short one is included whole, and a long one is one head-tail preview of at most
  2,500 characters with an explicit omission marker and a stable original-entry reference. The preview
  is not a fragment, and the omitted middle is never claimed to have been read. Durable remains the
  only transcript authority; no second archive or evidence copy is stored.
- A batch with no evidence is still acknowledged and counts as processed; the consumer advances it
  without a provider call.

Ordering, fairness and bounds: batches are served oldest first by Durable entry ID across the mapped
chats; the discovery scan is bounded to 4,000 examined entries per read and rotates its starting
conversation, so one busy chat cannot starve the others, and a postponed chat is offered later
instead of skipped. The scan position cache is derived, dropped when the cursor moves or the chat is
unmapped, and lost on restart; losing it costs a repeated bounded scan, never evidence. A pathological
entry (more than 1,024 steps, more than 256 open calls, or an over-long call id) fails the read closed.
`DIGEST_LIMITS` holds 2,000 entries and 200,000 evidence characters per batch with minimums of 2 and
2; the character bound is the real size limit and the entry cap is a flood guard. The `digest` config
block may override the batch bounds, and a resumed batch is re-derived with the bounds captured when
it was accepted.

The cursor is one small `nanobot.digest-cursor` conversation document: `nextEntryId`,
`nextItemIndex`, `nextTextStart` (position after the last acknowledged step), the immutable
`episodeStartEntryId`/`episodeEndEntryId` while a segment is being chunked, and `pendingToolCalls`.
`acknowledge()` is the only writer and requires the conversation to still be mapped with the same
session key. It compares the stored position with the batch's frontier (`DigestCursorConflictError`),
re-proves a fresh segment's end as a completed boundary by walking that segment, and re-derives the
claimed chunk from the committed transcript evidence by evidence before one commit. A fresh segment
must start at the cursor's next position, and any entry in the same conversation skipped before it is
refused (entry IDs are global and interleave chats, so a zero-entry gap within the conversation is
normal). A forged, stale or non-advancing batch is rejected instead of corrupting the cursor; a gap
longer than the verification bound is refused loudly and offered again, never skipped.

Compatibility with the earlier closed-episode reader is one read-time mapping, not a migration: a
stored document without `nextEntryId` becomes the position of its acknowledged entry and message
offset, and its frozen episode bounds are continued, so already digested text is not processed again
and the remainder still settles. The offset is validated against the same prose extraction that
produced it; an offset beyond that entry's message text or one that would split a surrogate pair fails
closed. Open calls at that frontier are derived once from the immutable segment prefix, so a result
after it still pairs with a call before it, while the prefix itself is never revisited as evidence. The
first acknowledgement writes the new fields and clears the old ones. There is no second cursor, dual
ingestion or cursor migration project; an old *batch record* (no step position) is refused rather than
re-derived as different evidence.

`readBatch(ref)` re-derives one chunk a consumer already recorded from its durable identity without
advancing anything, which makes a resumable consumer independent of cross-conversation scan ordering;
`read()` still chooses the oldest pending batch. `read()` reports `status: "idle"` with `caughtUp`,
`examinedChats`, `postponedChats`, `unfinishedChats` and `missingChats`; `caughtUp` is true only when
every mapped chat was examined to its tail. See `tests/history-digestion.behavior.test.mjs` for the
checked-in evidence over a real Durable Harness: completed-turn eligibility, open tool rounds,
untrusted tool labels and previews, reset/system/compaction/thinking exclusion, lossless Unicode
fragmentation, durable pairing across chunks and reopens, forged/stale/tail-less batch rejection,
two-chat interleaved IDs and fresh-start gap proof, the legacy cursor mapping at entry and character
boundaries, the two-entry minimum, the verification bound, and the no-evidence batch.

## Memory digestion execution

`src/history/memory-digest.ts` is the reusable, bounded conversation-to-memory run over the input and
cursor above. It adds no second agent loop, history archive, retry framework or service: one native
Durable task (`nanobot.memory-digest`) consumes exactly one bounded O1 batch, in its own task-owned
conversation, and acknowledges the cursor only after a settled, answered turn.

```ts
// O3 wires invocation. `start` is the whole host entry; nothing is scheduled or exposed here.
const started = await gateway.memoryDigest.start({
  id: originConversation.id,                            // authenticated mapped chat, from the host
  commit: (change, ctx) => originConversation.commit(change, ctx),
}, context);
// started: {status:"started", taskId, ...} | {status:"busy", taskId} | {status:"idle", idle} | {status:"refused", reason}
```

One run, in order:

1. Re-derive the accepted batch from its durable identity (`source.readBatch`) and read the
   conversation's cursor. A cursor already at or beyond the batch means an earlier attempt
   acknowledged it and only the outcome was missing: the run finishes `consumed` with no model turn.
   A cursor at some other position fails closed before any provider call.
2. A batch with no evidence fragments is acknowledged immediately — a successful no-op that advances
   the frontier without a provider call.
3. Otherwise the origin must currently grant `read`, `write` and `edit`: the curated subset of
   `toolAllowlist`, and only for an authenticated mapped chat origin. An empty or narrower allowlist
   refuses the run (at `start`, and again before the model call) instead of widening authority.
4. The run prepares one task-owned conversation in one commit: the host captures the curated tool
   subset, pins the explicitly configured background model (`digest.preset` or `digest.model`, never
   the foreground conversation's selection), and installs a curation-scope hook. The model
   input is the fixed trust framing, the agent-owned prompt, a read-only workspace index (memory topic
   manifest plus workspace skill summaries) and the bounded evidence fragments.
5. A settled, answered turn is validated before the frontier may move. The check reads this attempt's
   own committed range — its placed digest input entry through its own answer entry — in pages,
   bounded to 4,000 entries. That bound covers the run's own turn (one input entry, at most
   `maxToolCalls` tool rounds and the answer), not the batch: a bigger batch is one larger input
   entry, not more entries, so raising the batch bounds does not move it. The input must be this task's input (kind and `data.taskId`), no
   `pi.tool-result` inside the range may be an error (a refused write, a stale edit or a failed read
   fails the batch even when the model recovered and answered later), and the answer entry must be a
   non-empty assistant report. Only then is the batch acknowledged, re-validating it against the
   committed transcript. The terminal commit retires the captured tools and hook in the same commit
   that records the outcome. Provider error, a failed or refused tool call, an empty report, an
   unverifiable range, a withdrawn input, a cancelled task or an expired turn deadline leaves the
   frontier unchanged, so the same batch is offered again. Because the check reads the committed
   transcript, the same accounting applies to a resumed attempt after a reopen.

The model input is bounded by the O1 batch plus fixed prompt limits in `MEMORY_DIGEST_LIMITS`: the
prompt file is read up to 64 KiB and rendered to 16,000 characters, the derived index to 12,000, and
the outcome keeps a 2,000-character answer excerpt. One `digest` config block names the explicit background model and exposes the
invocation bounds, with the accepted defaults `entriesPerBatch: 2000`, `charsPerBatch: 200000`,
`maxToolCalls: 24`, `maxRequests: 12`, `maxInputTokens: 500000`, `runTimeoutSeconds: 600`,
`maxChangedFiles: 8` and `maxDiffChars: 32000`. The character bound is the real size limit and the
entry cap is a flood guard. A completed-turn range that fits these and the fixed step bound is
one batch/run; a larger range splits, and a turn inside it can straddle chunks. It
neither enables nor schedules digestion — frequency stays with ordinary cron — and an absent block
keeps the defaults. A started task captures the resolved values in its input; a replay or reopen
re-derives its batch, deadline, tool budget and write budget from that capture, never from a widened
current config. A legacy task record without captured limits uses current defaults only to attempt
exact re-derivation; it fails closed when they do not reproduce its original chunk. The host seam
`memoryDigest.turnTimeoutMs` supplies a deadline only when config leaves `runTimeoutSeconds`
absent; a configured product deadline wins. The task record stores only
the batch identity, pinned model and those bounds; the evidence lives once in the committed
transcript and once in the run's own transcript, never in a permanent task input.

The agent-owned prompt is `<workspace>/DIGEST.md`, seeded with `DEFAULT_MEMORY_DIGEST_PROMPT` only when
the file does not exist (exclusive create; an existing file is read as-is and never rewritten,
shortened on disk or versioned). Ordinary configured tools edit it in a normal conversation. Editing it
changes guidance only: the trust framing, scope and authority text is composed by the host, so the
prompt cannot grant a tool, a path or an effect.

Curation scope is enforced by a hook on the digest conversation, not by the prompt: `read`, `write`
and `edit` may only touch `SOUL.md`, `USER.md`, `memory/**/*.md` (never a `MEMORY.md` or `HISTORY.md`),
and `skills/<name>/SKILL.md`. Digest `write` is a real create-only operation: the wrapped tool asks the
guarded host environment for one `O_CREAT | O_EXCL` create (`HostExecutionEnv.createFileExclusive`), so
a concurrent create by this process or an outside editor makes the call fail and nothing is
overwritten. There is no check-then-write window, and the create stays inside the same guarded roots
as the native `write`. The platform's internal per-file mutation queue is not exported, so the digest
create does not join it; atomic exclusivity, not queue ordering, is the integrity property. `edit`
keeps the native exact-text semantics and its in-process serialization: it protects against changes
made through this assistant's tools in this process, but an outside editor changing the file between
the read and the write is not detected — there is no lock framework, and the prompt tells the model to
edit only text it just saw. There are no hashes, versions, managed workspace copies, rollback or
transaction: a failed run keeps whatever it already wrote, says so honestly, and does not acknowledge
its batch or advance the cursor. A later invocation can process the same evidence again. The curation
prompt tells the model to read existing files and check whether a fact is already recorded before
adding it; create-only writes and exact-text edits remain enforced, but semantic correctness and
duplicate-free replay are not guaranteed. This partial-write/retry behavior is intentional; rollback
and staged publication are [not planned](plan/2026-10-31_digest-rollback-design.md).
No shell, network, MCP, Code Mode, history, channel, worker, cron or
scheduling tool is installed in a digest target, and a run never writes to the origin chat, a channel
outbox or a schedule. The same curation hook enforces the run's budgets at the native call: every
assistant tool-call part counts, including a call that is refused or fails, so `maxToolCalls` is a
per-run ceiling over individual calls. For `write` and `edit` it also reserves changed files and
changed text before execution. A create charges its whole content; an edit charges both `oldText` and
`newText`, summed across calls, so repeated edits of one file accumulate instead of being
undercharged. A call that would exceed `maxChangedFiles` or `maxDiffChars` is blocked before it
mutates anything. `maxRequests` counts successful committed model responses (`stop`, `length`,
`toolUse`), including responses requesting tools. Native failed attempts/retries are allowed outside
that count, as approved by the owner. Status separates successful responses from all recorded
responses. Input spend is `usage.input + usage.cacheRead + usage.cacheWrite`; pi-ai reports the cache
counters separately, so nothing is counted twice. Missing usage fails the run closed. A failed tool
aborts the target after its result is committed, rather than inviting another request to repair it.
Final response/token usage is checked again before acknowledgement, including runs without tools.
Tool/time/write limits are the primary operational bounds. Tokens are a soft actual-usage ceiling,
not a hard pre-dispatch or financial cap. Native retries can spend beyond it; deferred polls,
compaction and a crash before a response commits are not fully counted. Committed counters survive
reopen, but uncommitted provider activity cannot be reconstructed. Before submit, pi-ai's text-token
estimate checks the rendered input plus catalog output ceiling and 4,096 tokens for tool/framing
headroom against the model context. Native pi-ai also clamps output to available model capacity. A budget refusal is a failed
tool result, so the batch is not acknowledged; whatever earlier calls already wrote stays (there is
still no rollback), and the same batch is offered again. These are conservative text-unit bounds,
not a git-diff computation.

Reopen is restored from the task itself: a live digest target keeps its pinned model, thinking level,
captured Markdown tools and scope hook, and its queued turn resumes before the configured default can
replace them. A digest target deliberately gets no origin context snapshot — its model input is its
own bounded batch — so a resumed attempt renders the same framing. A model that left the catalog fails
closed: its pending child input is withdrawn, its capture is retired, and the task commits the terminal
error on resume. A terminal task's target keeps no authority after a reopen.

Known limits, stated rather than implied: cross-conversation ordering is still best effort, so a
resumed task re-derives its own batch instead of relying on which batch a new `read()` would pick; the
first acknowledgement of a segment still pays a bounded, non-interruptible SQLite walk; a forged or
mismapped fresh start more than `DIGEST_LIMITS.scanEntriesPerRead` entries beyond the frontier is
refused loudly; input-token usage is a soft ceiling rather than a hard pre-dispatch cap; the scope check is a naming guard, not confinement (a symlink swapped in after the check is
not defended, exactly like the rest of the workspace tools, though `O_EXCL` itself never follows a
final symlink); `edit` cannot detect an outside process changing the file between its read and its
write, so the in-process serialization and exact-text match are the honest boundary; a turn longer
than 4,000 committed entries cannot be verified and fails closed; a cancelled or parked digest task
still counts as live, so `start` reports `busy` with its task ID rather than allowing a second writer.
Before that busy result, an ordinary start calls Durable's `retryTask` once for the live digest task,
outside any commit; it is a no-op unless the task was parked at the restart limit and never starts a
new task or loops. There is no digest user recovery command. The prompt is read when an attempt first
submits its turn, so an owner edit applies to the next accepted batch rather than to a run already in
flight (a resumed attempt re-submits its request ID, and text already admitted stays authoritative for
that attempt).
Nothing here was exercised with a real provider, a live channel, credentials or a personal workspace.
`tests/memory-digest.behavior.test.mjs` covers the offline evidence over the real Gateway and a faux
provider: fact/no-op/cursor, idle and refusal, provider failure and a replay that reads the retained
fact instead of duplicating it, refused/create-only/stale calls failing the batch, an empty final
report failing the batch, a concurrent create that is never overwritten, cancellation, the turn
deadline, an existing prompt not being clobbered, and a reopen that keeps the pinned model and
curation tools (including a failed call before the reopen that still fails the resumed attempt).
`tests/memory-digest-bounds.behavior.test.mjs` covers the configured bounds and their capture in the
task input, the call-time tool budget (a refused call included), changed-file and changed-text
refusals before mutation, a repeated same-file edit, parallel calls, budget persistence across a
reopen, the config-over-seam deadline precedence, and the single native parked-task retry.

## Manual and scheduled invocation

`start` is the whole execution entry. Two host paths call it, and nothing else does:

- **Manual owner command.** The local CLI has `/digest` (start one bounded batch) and `/digest
  status` (bounded read-only status). The Telegram adapter offers the same two forms to an
  authenticated owner, advertised in its command menu only when the host exposes the entry. Both
  use the existing host command surfaces and fixed, value-free acknowledgements; neither adds a
  model tool. A start returns as soon as one native task is committed (or reports `busy`, `idle` or
  `refused`), so the user's turn is never held while the digest runs. `idle` distinguishes a
  genuinely complete scan from one that stopped early: a `caughtUp: false` answer says closed
  history may remain and a later manual or scheduled invocation continues the bounded scan. One
  invocation consumes one bounded batch; nothing loops until the history is exhausted.
- **Explicit ordinary cron intent.** The existing `cron` tool's `add` action accepts
  `intent: "digest"`. It creates one ordinary job record in the origin chat conversation with that
  discriminant, and the existing timer/run task path invokes the same `start` through a host
  callback. There is no new timer, queue, agent loop or automatic job: the job is created only by
  that explicit add, a digest occurrence never submits the job message, and it is normalized to
  `mode: origin` so no task-owned target conversation is created or can gain authority. The run
  calls `start` with the authenticated origin conversation, and `start` re-checks that origin and
  the current curation allowlist, so a narrowed reopen refuses instead of widening. The timer still
  arms the next occurrence in its own deterministic commit; a slow or failed digest cannot stop
  the schedule. Cancelling the job stops its occurrence and later ones; an already-started digest
  task is a separate native task and is cancelled through the native task controls.

Completion is issues-only: a failed or cancelled run admits one bounded internal Durable event,
never a user or channel message. Its entry kind is `nanobot.memory-digest-result`, it is admitted to
the origin conversation at the conversation-scoped request ID
`nanobot.memory-digest-result:<taskId>`, and it reports only the outcome, the bounded batch shape,
the evidence count and a bounded report excerpt. The origin agent decides what, if anything, to
relay. A successful run — `digested`, a provider-free `noop`, or an already-`consumed` replay — is
silent: it admits no event, so opening, starting, flushing or recovering the gateway cannot start an
origin-agent turn after it, and `/digest status` is where its outcome stays visible. A small
write-ahead notice document records which terminal runs were admitted so a reopen retries a lost
admission; the request ID makes that retry a no-op instead of a duplicate turn. Digest cron jobs
queue nothing in the channel delivery outbox, so existing scheduled-job notices and dedupe are
unchanged.

The notice list is bounded at 100 records per origin and treated as a delivery obligation, not a
cache. It is pruned only when a record is definitively reported, when the native outcome is a
successful run that will never be delivered, or when the native outcome proves there is nothing to
report (a genuinely terminal `faulted` or `orphaned` task). A pending successful record left behind
by an older version is never delivered and may free its slot. A missing, live or malformed record
is unknown and is never evicted; an undelivered issue is never evicted.
Before a start consumes a batch, retained undelivered issues are flushed once, outside the start
commit. The start commit then prunes only safe records and reserves its own slot atomically with the
task; if no safe slot remains it returns `refused` with fixed text, starts no task, consumes no
batch and makes no provider request. The same count is visible in `/digest status` (pending notices
and whether a new start is possible), so an owner never sees a silent loss or an unexplained refusal.

Recovery does not depend on the record surviving. `recover` treats the terminal native task as
authoritative: a successful run is never admitted, and for an issue whose record is missing, the
event is re-admitted only when Durable does not already hold this exact result entry. Durable
deduplicates an input by request ID alone, so a
request ID occupied by a queued or foreign input is a collision, not proof: the placed entry must
have `nanobot.memory-digest-result` kind and this task's `data.taskId` in the origin conversation.
A queued, missing or foreign entry never marks the run reported; a missing record is reconstructed
as a pending record into a safe bounded slot so it stays visible to status and cannot grow the
list. Neither notification recovery nor a retry ever advances or rewinds the digest cursor.
`/digest status` is strictly read-only: it reads notices from a snapshot instead of creating the
document, so a fresh status leaves no child document behind.

Two bounded edges are stated rather than implied. A cron occurrence whose digest task starts and
then crashes before its run commit is replayed on reopen and can process one additional bounded
batch before the occurrence finishes; a digest cron occurrence is therefore not claimed to consume
exactly one batch in that crash window, while manual `start` still consumes at most one accepted
batch per call. If an origin mapping is removed at settle time, the internal issue route has no tools
or authority, exactly as the accepted worker result behaves.

Status is bounded and read-only: `memoryDigest.status(writer, context)` returns the live task ID
(one run at a time) and this origin's newest task with its outcome, batch position and recorded
error. It performs no transcript scan, provider call or cursor change. `/digest status` renders it.
Recovery stays native: a cancelled or parked digest task keeps its ID until the host retries or
aborts it, and `start` reports `busy` meanwhile instead of allowing a second writer.

Prompt freshness is per accepted batch. A new run reads `DIGEST.md` from disk when it first submits
its turn, so an owner edit applies to the next accepted batch. An attempt already in flight keeps
the text it admitted (a resumed attempt re-submits the same request ID, so its placed input stays
authoritative). Editing `DIGEST.md` or any memory file never rewrites an assembled workspace prompt
mid-turn; the existing refresh/`/new` path is still what updates an ordinary conversation's
snapshot on its next request. `tests/memory-digest-controls.behavior.test.mjs` covers the manual CLI
path, Telegram command exposure, no activation on open, issues-only reporting where a success or
no-op stays silent (no event, no origin turn) while failure and cancellation report once with reopen
dedupe, a legacy pending success that is suppressed and whose slot is reclaimed, idle-pending
wording, prompt freshness including an in-flight pin, the
cron digest occurrence and its independent reschedule, narrowed-reopen refusal, and cancellation
leaving cursor and authority unchanged. All checks are offline with a faux provider and a
synthetic workspace; no live provider, channel, credential or personal workspace was used.

## Offline lifecycle evidence

`tests/history-lifecycle.behavior.test.mjs` is one bounded, checked-in regression over the actual
`openGateway` and Durable Harness, a faux provider, and a disposable synthetic workspace. It covers a
single continuous story rather than a new harness:

1. an early fact/decision turn, an on-demand `skill` body, and a topic-memory `write` to
   `memory/topics/...`;
2. native Durable manual compaction, with the early fact placed in the summary and the raw early turn
   removed from active context;
3. `conversation.reset()` closing the episode, then the real episode-summary pass reading the original
transcript (including the pre-compaction early turn) and storing a ready summary;
4. close/reopen of the same store, then `historySearch` and the model-facing `history` tool's
   `search`/`open` actions returning the original early user entry, including the marker that no
   longer existed in active context and was deliberately absent from the derived summary;
5. a second closed episode whose summary pass fails with the classified `empty-summary` error, after
   which raw search/open still returns that episode's original decision.

This is evidence that the lifecycle is wired through the real Gateway and that a failed derived summary
does not block raw transcript recall. It is not evidence of useful recall with a real model, and it
uses no live provider, channel, credential or personal workspace. It is a bounded behavior test; after
`npm run build`, run it directly with `node --test tests/history-lifecycle.behavior.test.mjs` under
an outer timeout (or through the behavior suite once it is registered there).

## Not implemented

- Digesting conversations into memory on its own: no timer, startup pass or configuration parse
  starts a digest. The manual owner command (`/digest`, `/digest status`) and an explicit ordinary
  cron job with `intent: "digest"` are the only callers of `gateway.memoryDigest.start`; nothing
  runs until one of those is invoked.
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
