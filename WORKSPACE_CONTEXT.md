# Opt-in workspace context snapshots

`src/context/workspace.ts` is a small, host-invoked loader that turns one
explicit workspace root into the snapshot fields accepted by the existing
context extension and `GatewayContextSnapshotProvider`. It is **not** installed
by `openGateway`, `src/index.ts`, or any CLI path by default; a host must opt in
by calling the loader or passing the provider adapter. It reads no ambient
configuration, credential store, environment variable, or `~/.nanobot`
location, opens no tools, and calls no model provider.

## Local CLI/gateway host

The local CLI/gateway host exposes the loader through one explicit config
section. It remains absent by default; when absent, `src/cli.ts` passes no
snapshot provider and `openGateway` installs no context extension.

```json
{
  "workspace": "./workspace",
  "workspaceContext": {
    "memoryFiles": ["memory/MEMORY.md", "memory/system/preferences.md"],
    "memoryManifest": true,
    "skills": {
      "builtinSkillsRoot": "/opt/nanobot/skills",
      "disabledSkills": ["clawhub"]
    }
  }
}
```

- `workspace` is the existing explicit root and is also the bootstrap root.
  Bootstrap selection is fixed: `AGENTS.md`, `SOUL.md`, `USER.md`.
- `memoryFiles` is an explicit ordered list of `memory/**/*.md` paths and
  defaults to `[]`. No memory file is discovered. Paths are validated with the
  loader's rules at config parse time and again before reading.
- `memoryManifest` is absent or `false` by default. When `true`, each snapshot
  also appends the bounded `# Memory Tree` manifest from
  [`MEMORY_CONTEXT.md`](./MEMORY_CONTEXT.md); configured `memoryFiles` that
  were actually injected are its `loaded` entries and every other topic is read
  on demand with the configured native `read` tool. An empty configured file is
  omitted by this loader, so the manifest does not mark it `loaded`. The
  manifest uses one of the 32 memory source slots, so at most 31 `memoryFiles`
  are accepted in that mode.
- `skills` is absent by default and adds no discovery. When present,
  `builtinSkillsRoot` must be an absolute path to an existing directory and
  `disabledSkills` is an explicit name list validated per entry, with no count
  cap (default `[]`). There is no `selectedSkills`: skill bodies are never
  injected into the prompt, so selection would be inert. Workspace skills are read from
  `<workspace>/skills`; there is no package, home-directory, or other default
  builtin root. See [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md) for metadata,
  requirement and port-builtin-curation rules.
- Unknown `workspaceContext`, `workspaceContext.memoryManifest`, or
  `workspaceContext.skills` fields are rejected.
  There is no bootstrap-file selection, include glob, implicit default memory
  file, or skill auto-selection.
- **Identity is omitted.** The host does not render the Python identity template
  from runtime, platform, channel, workspace, or user values, and this slice has
  no identity config switch. The context extension therefore contributes no
  `nanobot_identity` content.
- The same fixed selection applies to every session key, including `cli:default`
  and channel keys. Each conversation loads the files afresh and keeps its own
  detached snapshot; a later session sees later file contents while an earlier
  conversation keeps the snapshot captured for it until the host explicitly
  refreshes that session with `gateway.refreshContext()` or the Gateway reopens.
- Startup/recovery reloads the config selection for every persisted session
  mapping before resume. Reopening, or an explicit per-session refresh,
  reconstructs workspace context from the current files, not from a cached copy.
  Refresh is available only for an existing mapped session, rejects a live run,
  and leaves the working snapshot in place if a loader fails; see
  [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md#explicit-refresh-of-one-conversation).
- A loader failure (missing selected file, symlink/hardlink, bounds, unsafe
  root, observable replacement, missing builtin skills root) rejects gateway
  startup or `conversationFor`. No partial context is installed, and a retry
  re-runs the loader.
- Skill bodies are never prompt content: the host passes the loader's
  name/description summary as `skillSummary`, and the gateway serves a body only
  when the model calls its read-only `skill` tool. Workspace bundled files stay
  readable with the ordinary configured `read` tool; builtin files are outside the
  workspace and are not. See [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md).
- Skill requirements are checked against the non-secret variables the guarded
  shell exports (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TERM`, `PYTHONUNBUFFERED`,
  from the shared shell policy). The gateway's other environment variables,
  including credentials, never satisfy a `requires.env` gate.
- This adds no tools, workspace roots, credentials, or provider calls. Tool
  policy is unchanged.
- The configured `workspace` path is walked literally by the loader. A root path
  containing a symlink component fails closed even though `openGateway` accepts
  it after `realpath`; use a canonical explicit path when opting in. With a
  symlinked path the gateway can open, but session creation fails closed.
- Context-enabled gateways are limited to 256 mapped sessions, including channel
  state sessions; opening or creating sessions beyond that limit fails closed.

The shipped `config.example.json` opts in with `memoryFiles: ["memory/MEMORY.md"]`,
`memoryManifest: true` and a `skills` section so the documented CLI setup works;
leaving `workspaceContext` out keeps every context loader off.

## SDK usage

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
| `skills/<name>/SKILL.md` | Read only when the explicit `workspaceContext.skills` section is present; see [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md). |
| `<builtinSkillsRoot>/<name>/SKILL.md` | Read only when `workspaceContext.skills.builtinSkillsRoot` names an existing absolute directory. |

Nothing else is discovered, scanned, or inferred. In particular there is no
implicit `memory/MEMORY.md`, no `memory/system/` glob, no topic-memory tree, no
skill scan without the explicit `skills` section, and no workspace-wide search. `memoryFiles` entries must be
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

Path safety here is Linux-only. Other platforms fail closed with `WorkspaceContextPlatformError`
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

This slice maps only the pinned bootstrap files, explicit memory files, explicit
workspace/builtin skill discovery, and an optional host-rendered identity. It
does **not** implement or claim parity with:

- `MemoryStore.get_memory_context()` system/legacy paragraph deduplication or
  the bundled `MEMORY.md` template check;
- `get_memory_tree_context()` topic discovery/descriptions; the opt-in host
  manifest lives in [`MEMORY_CONTEXT.md`](./MEMORY_CONTEXT.md) and is a separate
  helper, not part of this snapshot loader;
- `history.jsonl`, archived summaries, session/Dream cursors, usage deltas, or
  Dream;
- Python's complete `SkillsLoader` behaviour: YAML block metadata, `os` gating,
  install hints, and progressive summary placement are not implemented (the
  bounded subset and its explicit rejections are described in
  [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md));
- Python's runtime/user-message metadata, platform policy, manifest retrieval,
  recent history injection, or tool contract;
- any filesystem discovery beyond the named files and skill directories, or any
  default `~/.nanobot` workspace/credential lookup.

The existing context extension remains responsible for rendering, limits,
skills/tool visibility, and snapshot-to-conversation mapping. This module only
hands it bounded, detached document values.
