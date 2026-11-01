# Memory recall tools

The model-facing memory surface is three read-only tools: `memory_search`,
`memory_browse`, and `memory_read`. They search workspace notes and mapped-chat
history, browse episodes, and read a selected source. They do not call a model,
perform web research or retrieval waterfalls, create an archive, or change the
transcript or workspace.

These are distinct from the legacy `Gateway.history*` SDK/local APIs and their
existing tests. The legacy model-facing `history` tool is not the replacement
contract; see [legacy history implementation and evidence](./HISTORY.md).

## Search and browse

`memory_search` requires `target` and non-empty `query`; `memory_browse` requires
`target` and does not accept `query`. Both accept `filter`, `limit` (1–100 hits),
and an opaque `cursor`. Browse also accepts `order: "oldest" | "newest"`; search
does not. Search defaults to 20 hits and browse defaults to 20. A continuation
repeats the same target, query/filter and mode, adding the returned cursor.

```ts
memory_search({
  "target": "messages",
  "query": "deployment rollback",
  "filter": {
    "sessions": ["telegram:private:42"],
    "roles": ["user", "assistant"],
    "time": { "from": "2026-01-01T00:00:00Z", "to": "2026-02-01T00:00:00Z" }
  },
  "limit": 10
})

memory_search({
  "target": "notes",
  "query": "backup location",
  "filter": { "pathPrefix": "memory/projects", "description": ["backup", "storage"] }
})

memory_browse({
  "target": "episodes",
  "order": "oldest",
  "filter": { "sessions": ["cli:main"], "state": ["open", "closed"] }
})

memory_search({
  "target": "tools",
  "query": "git status",
  "filter": { "toolNames": ["bash"], "kinds": ["call", "result"] }
})
```

Filters combine across fields with **AND**. Values in each non-empty list combine
with **OR**. Empty lists are invalid. Supported filters depend on the target:

| Target | Applicable filter keys |
| --- | --- |
| `notes` | `pathPrefix`, `description` |
| `episodes` | `sessions`, `channel`, `provenance`, `time`, `episodes`, `state` |
| `messages` | episode keys, plus `roles` |
| `tools` | episode keys, plus `toolNames`, `kinds` |

Here, “episode keys” means `sessions`, `channel`, `provenance`, `time`, `episodes`,
and `state`. `provenance` values are `native`, `imported`, or `unknown`; `state`
values are `open` or `closed`; `roles` are `user` or `assistant`; and `kinds` are
`call` or `result`. `time` accepts `from` and/or `to` as ISO timestamps with an
explicit timezone, seconds and at most millisecond precision. The interval is
half-open: `[from, to)`. Unknown source timestamps stay undated; import or index
time is not substituted for conversation time.

Episode browse includes open and unsummarized episodes. Episode search searches
summaries only; it does not generate missing summaries. Summary `generatedAt` is
reported separately from the episode's conversation-time range. Coverage reports
shortened/omitted counts and other limitations; do not treat an excerpt or summary
as the complete source.

## Reading a hit

A hit's opaque `ref` selects the source to read. References are store-bound
identifiers, **not grants**: every call is checked against the caller's current
mapped-chat scope, and a ref from another store is rejected. Do not construct or
modify refs; pass them back unchanged.

```ts
memory_read({ "ref": "<hit.ref>" })
memory_read({ "ref": "<hit.ref>", "view": "transcript", "limit": 8000 })
memory_read({ "ref": "<hit.ref>", "cursor": "<previous-page.cursor>", "limit": 8000 })
```

`view` is `summary` or `transcript` and applies to episode/summary refs; notes and
individual message/tool refs are read in their natural view. Reads return lossless
pages of the selected text resource or canonical JSON transcript, 2–8,000
characters each, with a cursor when more remains. Continue with the same ref and
view. Page `complete` means that enumeration/read is exhausted; coverage has its
own completeness and reports unreadable and undated sources separately from
freshness.

## Snapshot, freshness, and notes

Search/browse pagination uses a frozen first-page manifest and transcript
high-water boundary. Page `complete` reports exhaustion of that frozen query;
`coverage.complete`, `freshness`, unreadable counts, and undated counts are
separate signals. A notes query first prepares its bounded filesystem manifest;
`phase: "preparing"` with no hits means continue with its cursor until reading
begins. Pagination describes exhaustion of that frozen query, not whether the
underlying index or source is fresh. Freshness and completeness are separate
metadata. Notes snapshots and read continuations are bounded gateway state with a
ten-minute lifetime; refs can be passed again after restart, but an expired snapshot
cursor must be restarted. A changed note is refused rather than read as if it still
matched the old hit.

Notes are read on Linux through pinned directory/file descriptors. The `notes`
target covers `memory/**/*.md`, including `memory/system/`, plus only the
explicitly configured `workspaceContext.memoryFiles`. It does not imply other
workspace files are searchable. Search is literal substring matching after
locale-independent Unicode lowercase conversion one code point at a time; there is
no Unicode normalization, tokenization, stemming, or model-based ranking. Note
browse is deterministic path order (or reverse path order for `newest`).

## Authority and opt-in

The tools are read-only and do not grant shell or filesystem write access. They are
installed only when explicitly enabled by the host; SDK `agentHistory: false`
opts out of these model-facing tools as well. This switch does not remove legacy
`Gateway.history*` SDK/local APIs or their existing tests. Ordinary workers receive
only named memory tools captured in their authority; enabling memory recall later
does not widen an existing worker capture. No root, fork, raw, or task-owned conversation gains
mapped-chat history authority through a ref.

This document specifies the approved interface and intended semantics. It makes
no claim of live-model usefulness, production migration, or deployment acceptance.
