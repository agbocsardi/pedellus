# One-off legacy migration — 2026-10-31

## Checklist

- [x] Investigate legacy storage and Durable's SQLite failure model read-only.
- [x] Agree final transcript source: **`memory/history.jsonl` only**; no session-file merge or WebUI display transcripts.
- [x] Keep this plan separate from the lean-assistant work order.
- [ ] Finalize chat/automation dispositions, historical timezone and live-versus-legacy Telegram destination.
- [ ] Write one disposable external ingest script using pinned native Durable APIs.
- [ ] Stop legacy writers and acquire a consistent private source/workspace snapshot.
- [ ] Copy existing Markdown memory, useful skills and referenced files; do not regenerate processed memory.
- [ ] Import each retained Telegram archive record as one native episode, preserving every available message.
- [ ] Atomically seed imported chats' digest cursors to skip legacy evidence without skipping future work.
- [ ] Rehearse in an unpublished fresh destination; verify record accounting, recall, cursor behaviour and reopen.
- [ ] Obtain separate cutover approval and separate approval for episode-summary model spend.
- [ ] Run the finite existing episode-summary backfill; verify coverage and indexed original-message drilldown.

## Final scope

Use `<legacy-root>/workspace/memory/history.jsonl` as the sole conversation-ingestion input. Import what
survives there; do not recover or reconcile session JSONLs, session archives, session headers or WebUI
display-event logs. Earlier sessions-plus-history proposals are superseded. This intentionally gives up
richer tool evidence and any unarchived messages present only in session files in exchange for a simple,
known source. Keep an untouched private source snapshot.

Copy workspace Markdown memory and useful skills separately as existing knowledge. Retain referenced
attachments with explicit relocation where needed; never globally rewrite historical text/arguments.
Do not translate or activate old configuration, schedules, pending work or deliveries.

**Do not carry over Python's rolling history deletion.** Retained imported/native transcript messages
must not be deleted merely because a count threshold is reached or summaries/digestion finish. Summary
text and rebuildable search indexes supplement originals; they do not replace them. This is a retention
requirement, not a promise against corruption, hardware loss or operator deletion: backups still matter.

One disposable script outside this repository is enough. No maintained import command, migration service,
compatibility reader, progress ledger or new retention subsystem. Implementation, process stops, data
copying, model calls and cutover have not happened; this plan alone does not authorize execution.

## Source findings

Re-inventory the frozen acquisition; these observations came from live files:

- History contained 1,001 schema-v3 conversation archive records, cursors 2454–3454, with 13,092 messages.
- Telegram contributed 90 records: 8,352 messages (695 user, 716 assistant, 6,941 omitted-tool-result
  placeholders), with message timestamps spanning October 16–30. Eighty-eight records had a summary.
- All inspected history JSONL records parsed successfully. Archive messages retain roles, text and
  timestamps but not stable entry IDs or tool-call arguments/associations. All 11,185 tool rows across
  history are omission placeholders, not recoverable tool output.
- Python `/new` clears and rewrites the same per-chat session file, then schedules history archival in
  the background. It does not rotate one Telegram JSONL per discussion; the ordering has a crash window.
- Python Dream cleanup prunes history to the latest 1,000 records shared across chats and automation,
  even after failed Dream attempts, without checking the processed cursor. The observed 1,001 rows are
  consistent with another append after pruning. Ninety is a retained archive count, not a lifetime count.
- Archive writers also emit compacted ranges, so an archive unit is not proof of a historical `/new`.
  Earlier discarded messages cannot be reconstructed by this ingest. External backup recovery is out of scope.

## Ingestion

### Snapshot and stage

Stop all source writers before final acquisition, including background archive/Dream work. Parse the
snapshot directly rather than invoke legacy constructors that might rewrite it. Record its hash and
counts without exposing message bodies. Build an unpublished, fresh destination with disjoint workspace
and data directories. Refuse to append to an already-used store. On failure, discard staging and rebuild
from the same snapshot; no uncertain retries or import checkpoints are needed.

### Records and episodes

Group by history `session_key`; preserve distinct namespaces. Retain source line/cursor, original
message timestamps, archive timestamp and source summary as provenance. Do not mistake archive-write
time for message time. Establish the historical timezone for naive timestamps, retain ambiguity and
source ordering, and never silently use the import machine's timezone.

Each Telegram archive record becomes one episode, separated by native resets, in either the live
Telegram conversation or one separate mapped legacy Telegram conversation. The latter is recommended
for a clean historical/current separation; final choice remains open. Existing cross-chat history search
can discover a mapped legacy conversation without a new archive reader. Label boundaries as imported
Python archive units, not recovered original `/new` events. Use the same source-unit principle for other
human chats. Preserve repeated text and all record occurrences: there is no cross-source merge or blanket
content-hash deduplication. A simple source-to-destination accounting report replaces reconciliation machinery.

Use native transaction APIs, not direct internal SQL inserts. Allocate new IDs and render messages into
recognised native message/tool entry kinds so existing history search can see them. Preserve unknowns
explicitly; never invent historical model identity, usage, tool outcomes or associations. Keep legacy
summaries as labelled provenance, not fabricated ready native summaries with invented coverage.

Create each destination conversation's entries, mapping, episode reset boundaries, final closing reset
(`head: "self"`) and initialized digest cursor atomically. No historical prompt is submitted. Import no
runnable generation/tool tasks, pending submissions, Python compaction state, deliveries or schedules.
Do not open the full product gateway during ingestion: startup can resume work and connect integrations.

Account for every retained archive row, including automation. Keep cron/dream/heartbeat records inert,
not ordinary mapped chat evidence for summary/digest processing; settle their audit-storage disposition
before writing the script. Mapping confers current chat authority, not read-only archive status. The
source spans more than 256 session keys, so mapping every automation run separately is not acceptable.
No source row may silently disappear because it is excluded from the ordinary chat scope.

## Skip already-processed legacy memory

The owner confirms Python has already folded migrated material into workspace memory. Copy that memory;
mark the imported transcript prefix as consumed by future Durable digestion. Not running `/digest` during
migration is insufficient: later manual/scheduled digestion must skip the imported material too.

Seed exported `DigestCursorDoc` from `src/history/digestion.ts` per imported mapped conversation, in the
same transaction as its imported records and mapping:

- `throughEntryId`: the last imported entry immediately before the final closing reset, using its NEW
  native ID, never the Python archive cursor or a global store maximum.
- `throughChars`: that entry's full digest evidence-text length in UTF-16 code units (zero if no evidence).
- `episodeStartEntryId` and `episodeEndEntryId`: both `null`, with no partially consumed episode.

Leave the final closing reset **after**, not inside, this frontier. The reader starts strictly above the
frontier and needs that reset to establish a valid future episode start; skipping it could produce an
ordinary-message start that acknowledgement rejects. Do not initialize an empty conversation past a
future episode's reset. Python's counters cannot be copied directly into Durable's different ID space.

Record this as an owner-authorized migration baseline, not a fake successful digest task. Do not disable
digestion globally or mark future entries consumed. This cursor is independent of episode summaries:
old messages remain eligible for summary generation and recall while excluded from memory re-digestion.

On an isolated rehearsal copy, verify no legacy evidence is offered before/after reopen, then append a
synthetic new discussion and closing reset and verify only new evidence is offered with a valid starting
reset. Do not run a digest model or acknowledge synthetic work in the actual destination.

## Episode-summary backfill

Use the existing **reset-triggered episode summarizer**, not `/digest`. It generates stored titles and
summaries for indexed discovery and original-message recall; it does not rewrite copied Markdown memory.
The memory manifest is discovered mechanically, and raw history indexing also needs no model calls.

After import and separate approval of summary spend:

1. Enable the summary model and reconcile each mapped episode catalog until caught up.
2. Use `backfillEpisodeSummaries(sessionKey)` to queue historical closed episodes; default activation
   alone does not backfill them. Inspect `historySummaryQueue` and `historyEpisodeSummary`.
3. Let the existing workers run; `drainEpisodeSummaries` starts a missing worker for queued jobs.
   Repeat bounded backfill when queue capacity is available until its scan reports complete. Scan
   completion is not proof every summary is ready. Stop on issues or agreed spending/run limits.
4. Review initial results before finishing the finite remainder. Verify all intended episode outcomes,
   coverage and summary-search drilldown. Summary indexing refreshes on demand and may need several passes.

**Do not run backfill until a maintenance-only path is verified.** An ordinary gateway open can resume
persisted work, and disabling cron skips automation-conversation classification on reopen. Disabling
integrations alone is therefore not sufficient to guarantee a safe maintenance run. Keep the service
stopped and disabled; back up the store and obtain separate approval for model spend before execution.

Existing limits matter: entries shorten at 2,000 characters; chunks bound at 24,000 characters / 400
entries; an episode keeps as many chunks as it needs, each one its own bounded provider request, with the
collection cursor and chunk list durable across a restart. Ordinary message text is cut at its head; a
tool call's arguments or a tool result that does not fit is quoted as a head-tail preview with an
omission marker and the original `entry:<id>/tool-call|tool-result/<key>` reference, so the summarizer
never sees the omitted middle. `ready` is not proof of complete, unshortened coverage.
Preserve source-unit episodes and inspect limitations rather than silently invent additional splits.
Ready summaries cannot currently be replaced by a re-summarize operation. Originals remain available
regardless of summary failure, partial coverage or truncation.

Native queue/task checkpoints already provide recovery; no separate backfill service/checkpoint is
needed. Backfill must not alter the seeded digest cursors. Interrupted model requests can have unknown
spend, so provider execution is not exactly-once. Inspect summary-record usage/attempts: ordinary
conversation usage does not include summary spend. Back up the imported store before this model pass.

## SQLite, publication and acceptance

- Use `src/storage/sqlite.ts`'s verified WAL/FULL opener, exclusive ownership and correct local filesystem
  locking/sync semantics. Upstream defaults to WAL/NORMAL; FULL must apply to the actual connection.
- Atomicity is per commit, not the whole script. A storage error fails the Session/Harness: never catch
  disk-full, I/O, locking or commit errors and continue through that handle. Lost acknowledgement is not
  proof nothing committed; discard unpublished staging instead of retrying uncertain append operations.
- WAL/FULL improves power-loss durability but cannot guarantee faulty hardware/filesystem survival.
  Existing process-kill checks do not prove physical-host-loss durability.
- Never copy a live main database file alone or delete its WAL. Require clean close/checkpoint or a
  consistent SQLite backup; investigate surviving sidecars. Check SQLite integrity AND logical references.
- Workspace files and SQLite are not one transaction. Publish the verified destination together where
  possible under one staged parent on the same filesystem; use correct final paths and sync publication.
- Account for every source record/message, valid unique mappings, preserved provenance and placeholders,
  empty active contexts after final resets, and no imported runnable tasks or pending submissions.
- Verify representative Telegram/other chat raw searches and original-entry retrieval after bounded index
  catch-up, copied memory/skills, attachments, clean reopen and persisted digest frontiers. Rehearsal must
  not activate channels, schedules or paid/model calls. Summary generation has separate acceptance above.

## Log

### 2026-10-31

Investigated legacy JSONL writers, reset/retention behaviour, native history/summary/digest readers and
SQLite failure models read-only. Initially proposed merging sessions and history, and mistakenly treated
summary backfill as Markdown digestion; corrected both through owner discussion. Owner requires native
episode-summary recall and preseeded digest cursors because existing Python memory is already processed.
After confirming shared rolling history pruning, owner accepted surviving history as the sole transcript
source: removed session merging/recovery from scope. Preserve individual Telegram archive units as
episodes and do not port rolling transcript deletion. Workspace memory still comes forward separately.
Only this separate plan was created/updated; the lean-assistant TODO remains untouched. No ingest code,
source-data changes, process stops, runtime activation, model calls or migration execution occurred.
