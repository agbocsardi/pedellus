# Explicit-root topic memory discovery and manifest

`src/context/memory.ts` is a bounded, read-only helper for the workspace
Markdown memory surface. Markdown files are authoritative; Durable keeps the
conversation transcript and runtime state. There is no second store, cache,
index, cursor, or database here.

Discovery turns one explicit workspace root into a Python-style memory-tree
manifest plus frozen provenance entries. Topic bodies are **not** returned:
the model reads a topic on demand with the existing native `read` tool using the
entry's workspace-relative path, and writes it with the existing native
`write`/`edit` tools. This module never creates, writes, renames, or deletes a
file, including a missing `memory/` directory.

The host opt-in is `workspaceContext.memoryManifest: true`. The configured
`workspaceContext.memoryFiles` are the configured memory sources; only files
actually injected are marked loaded in the manifest. Other topic bodies stay on disk.

## API

```ts
import { loadMemoryContext, validateMemoryTopicPath } from "./context/memory.js";

const memory = await loadMemoryContext({
  workspaceRoot: "/srv/workspace",
  // Files the host already put in context; marked `loaded` in the manifest.
  loadedFiles: ["memory/MEMORY.md", "memory/system/now.md"],
});

// Append last to the existing memory sources, matching Python's order.
const snapshot = {
  conversationId,
  memory: [
    ...(existingMemory ?? []),
    ...(memory.document === undefined ? [] : [memory.document]),
  ],
};

// Before a host-guided native write/edit:
const path = validateMemoryTopicPath("memory/projects/nanobot.md");
```

The result contains:

- `entries`: frozen `{ path, source, state, description, bodyChars }` values.
  `path` is workspace-relative (`memory/...`); `source` is
  `workspace:memory/...`; `state` is `loaded` or `topic`; `bodyChars` is the
  frontmatter-stripped body length in Unicode code points.
- `manifest`: `# Memory Tree` text with the Python intro line and one line per
  entry: ``- `memory/x.md` (topic, 123 chars): description``. More than the entry
  cap, a short character budget, or a stopped directory scan adds a visible
  `more memory files` line; entries are never dropped without that line.
  Discovered files that cannot be read add a visible `N memory files skipped
  (unreadable, oversized, or invalid)` line instead of an entry, so the
  manifest never claims their bodies were read.
- `document`: a frozen `{ source: "memory:manifest", content: manifest }` for
  `ConversationContextSnapshot.memory`; absent when the manifest is empty.

`validateMemoryTopicPath()` refuses `MEMORY.md`, `HISTORY.md`, `memory/system/`,
hidden entries, non-`.md` paths, `..`, backslashes, absolute paths, and anything
outside `memory/`. It is a naming guard only: it cannot confirm expected prior
content or make the native write atomic. `validateMemoryLoadedFiles()` validates
an explicit injected-file list for host config parsing. It is decoupled from the
write guard: protected names such as `HISTORY.md`, `memory/MEMORY.md` and
`memory/system/MEMORY.md` are allowed there, because injected files are read-only
context, not topics.

## Discovery rules

Under `<workspaceRoot>/memory/`, recursively:

| Entry | Behaviour |
| --- | --- |
| `*.md` regular file | Topic, unless excluded below. |
| Any file named `MEMORY.md` | Always-loaded index; not a topic. |
| `HISTORY.md` | Legacy history evidence; not a topic. |
| `history.jsonl`, cursor files | Not `.md`; never discovered. |
| `system/` directory | Always-loaded; not a topic. |
| Hidden file or directory | Skipped (safe segments must start alphanumeric). |
| Symlinked file or directory | Skipped, not followed. |
| Non-regular file, non-`.md` file | Ignored. |
| Unsafe/oversized segment name | Ignored. |
| Workspace-relative path over 246 characters | Ignored; provenance would not fit. |

Only files explicitly named in `loadedFiles` are read outside that topic set.
Each must exist and be a regular, non-symlinked, single-link file; a missing,
unreadable, oversized, or non-UTF-8 explicitly named file rejects the whole load
so configured content is never silently replaced. A supplied loaded file is
always listed even when the entry cap is reached; only the manifest character
budget can shorten the list, and that omission is counted visibly.

A discovered topic that is unreadable, oversized, invalid UTF-8, missing after
discovery, or changed during the read is skipped and counted in the visible
skipped line, so these file errors do not block Gateway reopen. An unreadable
memory directory still fails discovery and can block reopen. No skipped topic is
listed as if its body had been read.

Entries are sorted by path with code-unit comparison, so ordering is stable
across locales. Every file is re-read on each call; a topic written by the native
`write` tool is therefore visible to the next discovery pass and after restart.
Each call returns new frozen objects; there is no module cache.

Loaded-file parents are checked too: each component below the workspace root
must be a real directory, so a configured `memory/topics/x.md` cannot traverse
`memory/topics -> /outside`. A symlinked workspace root is still accepted
because the host named it explicitly.

Descriptions come from flat frontmatter `description:` when present, otherwise
the first Markdown heading, otherwise `(missing description)`. A description is
clipped to 240 code points with a trailing `…`; control characters are replaced
with spaces so each entry stays one line. The frontmatter reader supports only
the flat `key: value` subset used by memory files (CRLF is tolerated).

## Bounds and failure behaviour

`MEMORY_CONTEXT_LIMITS` is exported: 80 manifest entries, 32 explicit loaded
files, 64 KiB per file, 5 MiB aggregate (80 files at the per-file cap),
15,488 manifest code points (`sectionChars - 512` reserved for the renderer
heading and provenance), 240 description code points, 246-character paths, 8
path segments, 64 characters per segment, 4,096 inspected directory entries,
and 4,096-character roots.

The entry cap and byte aggregate are practical for a real workspace: the byte
aggregate is exactly the entry cap times the per-file cap, so it cannot reject a
load that the entry cap accepts, and peak memory stays at one file because
bodies are discarded. An over-budget manifest is shortened, not rejected, and a
directory tree beyond the inspected-entry bound stops discovery with a visible
manifest line. Neither case silently drops entries or fails an ordinary
workspace.

Explicitly loaded file failures fail closed with `MemoryContextBoundsError`,
`MemoryContextFileError` (a stable kind and workspace-relative source, never an
absolute path or file body), or `MemoryContextInputError`. A missing `memory/`
directory is not an error and is never created. Discovered-topic failures of the
same kinds are skipped and counted as above, so one stale topic cannot prevent
startup or reopen.

The manifest is bounded on its own, not together with other memory documents.
A host adding it beside many other memory sources must keep the shared renderer
section budget; the helper does not see those sources. `workspace-host.ts`
appends the manifest after the configured memory files, matching Python's order,
so a combined memory section that exceeds the renderer budget is clipped with
the renderer's visible truncation marker.

## Safety and limitations

Scope is accidental damage, not adversarial confinement. Reads use normal
filesystem calls with bounds and `O_NOFOLLOW`; observed symlinks are skipped or
rejected, additional hard links (`nlink != 1`) are rejected, and metadata is
compared before and after the read. There is no `/proc/self/fd` pinning, so a
swap between check and open or read is not detected. A `memory/` symlink is
refused; a symlinked workspace root is accepted because the host named it.

The helper deliberately does not duplicate the native tools:

- no topic body is embedded in context; the manifest points at `memory/...`
  for the native `read` tool;
- no write implementation, atomic-write helper, or write-time frontmatter is
  added; native `write`/`edit` own those semantics;
- `validateMemoryTopicPath()` narrows which names a memory write may use, but a
  native write still overwrites an existing topic and is not atomic. A completed
  write survives restart; a crash during a native write can leave partial
  content.

## Deliberate parity gaps

This is the memory-discovery foundation, not full Python `MemoryStore` parity.
It does not implement `get_memory_context()` system/legacy paragraph
deduplication, automatic `MEMORY.md`/`memory/system/` injection, `history.jsonl`,
archived summaries, Dream, cursor/usage state, ranking or retrieval,
`memory_read`/`memory_write`/`memory_search` tool actions, or the memory-tree
description format's Python truncation suffix. The host injects only the
explicitly configured files, not every file Python would mark loaded. It does
not include topic bodies, follow symlinks, or create `memory/` directories.
Python's tree slices the combined file list to 80; this helper always includes
explicitly loaded files first so a named file cannot be silently hidden by the
cap.

Memory writes still use the native `write`/`edit` tools without a topic-path
wrapper; `validateMemoryTopicPath()` is available for a future tool-policy
slice.

## Host integration

`workspaceContextGatewayOptions()` reads `workspaceContext.memoryManifest`.
When it is `true`:

- configuration rejects non-boolean values and more than 31 `memoryFiles`, since
  the manifest needs one of the 32 memory source slots;
- config parsing also applies `validateMemoryLoadedFiles()` so manifest and
  workspace selections agree at startup;
- each conversation snapshot loads `loadWorkspaceContextSnapshot()` first, then
  `loadMemoryContext()` without a cache, and appends the manifest document after
  the configured memory documents;
- only configured files actually present in that snapshot are passed as
  `loadedFiles`. The workspace loader omits empty files, so an empty configured
  file is not falsely marked `loaded`; if it remains discoverable it is shown as
  a zero-body topic;
- the snapshot provider is re-run on every gateway open, so a topic write made
  through the granted native tools is present after reopen;
- a loaded-file error rejects conversation setup instead of installing false
  content. Broken discovered topics, shortened manifests, and stopped scans are
  not errors; each has a visible manifest line.

The gateway `read`/`edit`/`write` grants are unchanged and still come from the
Durable tool-grant document, so restart keeps both the grants and the
file-backed memory. Compaction and per-conversation snapshot capture are also
unchanged: the snapshot is host context, not transcript state.

Synthetic probes exercised a fresh gateway read, a native topic write,
close/reopen, grant persistence, manifest reload, oversized/invalid-UTF-8/
unreadable discovered topics across reopen, loud loaded-file failures, empty
configured files, protected injected names (`HISTORY.md`,
`memory/system/MEMORY.md`), 200 topics, 80 maximum-size files, a >4,096-entry
tree, and a loaded-file parent symlink. They used temporary directories only and
were not committed.
