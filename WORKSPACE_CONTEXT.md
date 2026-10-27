# Opt-in workspace context snapshots

`src/context/workspace.ts` is a small, host-invoked loader that turns one
explicit workspace root into the snapshot fields accepted by the existing
context extension and `GatewayContextSnapshotProvider`. It is **not** installed
by `openGateway`, `src/index.ts`, or any CLI path; a host must opt in by calling
the loader or passing the provider adapter. It reads no ambient configuration,
credential store, environment variable, or `~/.nanobot` location, opens no
tools, and calls no model provider.

```ts
import {
  createWorkspaceContextSnapshotProvider,
  loadWorkspaceContextSnapshot,
} from "./src/context/workspace.js";

const snapshot = await loadWorkspaceContextSnapshot({
  workspaceRoot: "/srv/workspaces/project",        // explicit, absolute
  memoryFiles: ["memory/MEMORY.md", "memory/system/preferences.md"],
  identity: { source: "session:project", content: renderedIdentity }, // optional, explicit
});

const provider = createWorkspaceContextSnapshotProvider((sessionKey) => ({
  workspaceRoot: "/srv/workspaces/project",
  memoryFiles: ["memory/MEMORY.md"],
  identity: { source: `session:${sessionKey}`, content: identityFor(sessionKey) },
}));
```

The loader returns `Omit<ConversationContextSnapshot, "conversationId">`; the
gateway/runtime attaches the conversation ID and owns snapshot mapping.

## Exact scope

| Source | Behaviour |
| --- | --- |
| `AGENTS.md` | Read from the workspace root if present. |
| `SOUL.md` | Read from the workspace root if present. |
| `USER.md` | Read from the workspace root if present. |
| `memory/**/*.md` | Read only when individually named in `memoryFiles`, in that order. |

Nothing else is discovered, scanned, or inferred. In particular there is no
implicit `memory/MEMORY.md`, no `memory/system/` glob, no topic-memory tree, no
skills scan, and no workspace-wide search. `memoryFiles` entries must be
literal relative paths under `memory/`, end in `.md`, and use only the safe
segment character set (`A-Z`, `a-z`, `0-9`, `.`, `_`, `-`; segments start with
an alphanumeric). Absolute paths, `..`, `.`, empty segments, backslashes, and
files outside `memory/` are rejected.

Provenance labels are deterministic (`workspace:AGENTS.md`,
`workspace:memory/system/preferences.md`) and never contain the absolute root.
The `workspace:` prefix counts toward `CONTEXT_LIMITS.sourceChars`, so a memory
path is capped at 246 characters and the resulting label at 256. Content is the
file body; the existing renderer supplies the `##` heading and `Source:` line. A
missing bootstrap file is omitted, matching Python
`ContextBuilder._load_bootstrap_files`. A missing explicitly selected memory
file is an error because the caller named it. Empty files are omitted.

Request fields are captured only as own data properties. Inherited fields,
getters, array holes, and accessor-backed `memoryFiles` entries are rejected
rather than invoked. The `memoryFiles` length is read once from its own data
descriptor and used for a bounded indexed loop.

## Missing, empty, and failure behaviour

| Situation | Result |
| --- | --- |
| Missing `AGENTS.md`/`SOUL.md`/`USER.md` | Omitted; load succeeds. |
| Empty bootstrap or selected memory file | Omitted; load succeeds. |
| Missing selected memory file | `WorkspaceContextFileError` (`kind: "missing"`). |
| File is a symlink | Rejected (`kind: "symlink"`). |
| File has more than one hard link | Rejected (`kind: "hardlink"`). |
| Path component symlink or non-directory | Rejected, never followed. |
| FIFO/socket/device/directory where a file is expected | Rejected (`not-regular`). |
| Unreadable file/directory | Rejected (`unreadable`). |
| Invalid UTF-8 | Rejected (`encoding`). |
| Invalid root, relative root, `/`, `~/.nanobot`, `/proc`, `/sys`, `/dev` | `WorkspaceContextInputError`. |
| File or aggregate bound exceeded | `WorkspaceContextBoundsError`. |
| Observable file change during read | Rejected (`changed`). |
| Selected file replaced after its read but before return | Rejected (`changed`, file source label). |
| Root path or an opened directory changed identity during load | Rejected (`changed`). |
| Renderer section budget would clip any accepted document | `WorkspaceContextBoundsError` (`identitySection`, `instructionsSection`, `memorySection`, or `contextTotal`). |

Any file or safety error rejects the whole load; there is no partial snapshot.
Errors carry a stable kind and a workspace-relative source label, not an
absolute path or file content.

## Safety

Path safety is identical in spirit to `src/archival-source/index.ts` and is
Linux-only. Other platforms fail closed with `WorkspaceContextPlatformError`
rather than falling back to weaker path checks.

- The absolute root is walked from `/` with `O_DIRECTORY | O_NOFOLLOW`, so a
  symlinked root component is rejected.
- Every directory is pinned through `/proc/self/fd/<fd>`; memory path
  components are opened relative to a pinned parent with `O_NOFOLLOW`.
- Files are opened with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`.
- `fstat` must report a regular file with `nlink == 1`; additional hard-link
  aliases are rejected at check time. This is a link-count check, not proof
  that the inode originated inside the workspace: a link-then-unlink sequence
  can leave a file with `nlink == 1`.
- Device, inode, size, mode, link count, `mtimeNs`, and `ctimeNs` are compared
  before read, after read, and against a final path `lstat`. Replacement,
  truncation, growth, or removal during the read fails closed.
- After all reads, every selected file is reopened through its pinned directory
  chain and compared by dev/inode/size/mode/link count/`mtimeNs`/`ctimeNs`.
  This catches a root-level `AGENTS.md` (or any other selected file) renamed or
  replaced after its own read but before the snapshot is returned.
- After the file checks, the pinned root and every directory reached are
  rechecked. Root dev/inode/mode must still match both the pinned handle and
  `lstat(rootPath)`; each tracked directory is reopened through the pinned root
  and compared. A rename or replacement fails the whole load instead of
  returning content with stale provenance.
- Request/identity/memory inputs are read only through own data descriptors;
  revoked Proxies become typed `WorkspaceContextInputError` values.
- No path, raw OS message, or file content is included in error messages.

This prevents ordinary symlink and hard-link escapes and detects observable
file or directory replacement. Residual limits: the `nlink == 1` check does not
prove inode origin after link-then-unlink; metadata comparisons are only as
precise as the filesystem's `stat` data (coarse timestamp filesystems can miss
a same-size rewrite); and a change after the final file/directory check remains
a TOCTOU window between verification and the caller using the snapshot. It is
not a defence against a privileged or kernel-level adversary, mount tricks, or
a filesystem that fails to update metadata.

## Bounds

`WORKSPACE_CONTEXT_LIMITS` exposes the fixed limits: 3 bootstrap files, at most
32 memory sources, 64 KiB per file, 128 KiB total bytes, 48,000 total code
points (the renderer's context budget, including explicit identity), 14,400
identity code points, 256 code points per provenance label (identity source is
also counted in code points), at most 246
characters per memory path (including the `workspace:` prefix), at most 8 path
segments, and at most 64 characters per path segment. UTF-8 is decoded with
`fatal: true`; a BOM is stripped by the decoder.

Before returning, the loader mirrors the renderer's exact heading, provenance
escaping, separator, and truncation rules. If `AGENTS.md`/`SOUL.md`/`USER.md`,
memory, or identity would be clipped by the per-section 16,000-code-point limit
or the shared 48,000-code-point budget, the load fails closed. It never returns
a snapshot whose later document would be silently dropped by the renderer.

## Detachment and session isolation

Each call reads files afresh, builds new objects, and returns a frozen snapshot
with frozen documents and a frozen memory array. There is no module-level cache,
no mutable registry, and no shared handle. A provider adapter calls its
resolver on every request and caches nothing. Hosts choose session-scoped values
(such as identity) only from explicit resolver arguments; returning `undefined`
means no snapshot. Mutating a request object after the load does not change the
returned snapshot, and mutating a returned snapshot is rejected.

## Deliberate omissions from Python parity

This slice maps only the pinned bootstrap files, explicit memory files, and an
optional host-rendered identity. It does **not** implement or claim parity with:

- `MemoryStore.get_memory_context()` system/legacy paragraph deduplication or
  the bundled `MEMORY.md` template check;
- `get_memory_tree_context()` topic discovery/descriptions;
- `history.jsonl`, archived summaries, session/Dream cursors, usage deltas, or
  Dream;
- `SkillsLoader`, always/selected skills, requirement checks, or skill bodies;
- Python's runtime/user-message metadata, platform policy, manifest retrieval,
  recent history injection, or tool contract;
- any filesystem discovery beyond the named files, or any default `~/.nanobot`
  workspace/credential lookup.

The existing context extension remains responsible for rendering, limits,
skills/tool visibility, and snapshot-to-conversation mapping. This module only
hands it bounded, detached document values.
