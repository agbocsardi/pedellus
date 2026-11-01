# Execution backends

Two backends exist, both over the actual workspace. There is no managed copy,
workspace import/admission, daemon, launch-intent or workspace lifecycle.

- `src/execution/host.ts` — `HostExecutionEnv`, the guarded host environment used
  by the opt-in coding tools ([`TOOLS.md`](./TOOLS.md)). Native filesystem
  methods are path-guarded; the shell is the native `NodeExecutionEnv` shell.
- `src/execution/direct-bwrap.ts` — argv builder for the optional direct-workspace
  Bubblewrap shell (`toolSandbox: "bwrap"`, off by default), documented in
  [`DIRECT_BWRAP.md`](./DIRECT_BWRAP.md).

`src/execution/policy.ts` is the shared execution policy for both: the ported
shell deny patterns, the environment allowlist, the Python timeout rules, shell
command/allowlist/path filtering, and the filesystem containment check.
`src/execution/host.ts` imports it, and the optional Bubblewrap shell reuses that
same policy and the direct-workspace argv builder rather than a second policy.

`createHostExecutionEnv({ workspaceRoot, allowedRoots?, shell?, cwd?,
  shellSandbox?, tempDirectory? })` wraps the native `NodeExecutionEnv`:

- Roots contract: roots are canonical absolute paths supplied by the backend.
  The policy checks absoluteness and normalizes separators/`..`, but deliberately
  does not call `realpath`. The host resolves `workspaceRoot`, each allowed root,
  `cwd` and the scratch root with `realpath` once at creation; a sandbox passes
  canonical virtual roots such as `/workspace`. This keeps virtual sandbox paths
  usable without a host syscall.
- Filesystem methods reject lexical `..`/absolute escapes and paths that resolve
  through a symlink outside the configured roots. The guard returns the original
  path to the operation, never the canonical probe path. `followFinalLink`
  follows operation semantics: reads/writes/watch follow a final symlink, while
  `remove`, `renameFile`, `fileInfo`, `exists` and `createDir` act on the link or
  parent and are not refused merely because the link target is outside. A link
  that cannot be resolved is refused rather than guessed; this includes a
  dangling symlink whose textual target is inside the workspace. A hard link
  inside a root to an outside inode is not detectable by path and is allowed;
  writing or removing through it affects the outside inode.
- File *content* operations (`readTextFile`, `readTextLines`,
  `openTextLineReader`, `readBinaryFile`, `openBinaryReader`, `writeFile`,
  `appendFile`, `truncateFile`, `flushFile`) do not rely on the resolved-path
  check alone. The operation first opens the path without truncating and then
  identifies the opened file from `/proc/self/fd/<fd>`, which names the opened
  inode rather than the requested path; a descriptor whose real path is outside
  every root is refused before any byte moves. The same descriptor is then the
  operation target, so a concurrent process that swaps a workspace component for
  a symbolic link between the check and the operation cannot redirect the read or
  the write. This is what keeps a private file outside the roots out of a racing
  `read` call. A read-only open is nonblocking, so a path that is (or was swapped
  to) a FIFO or a device cannot park the guard waiting for a peer — a blocking
  open has no cancellation point and would outlive both the tool timeout and an
  owner cancellation. The binary reads additionally refuse any opened descriptor
  that is not a regular file (`invalid: Not a regular file`, or `is_directory`)
  instead of reading content with no size and no cancellation point; the native
  binary reader reaches the same refusal after its own nonblocking open.
  Directory listings, `create`, `rename`, `remove` and `watch` keep
  the resolved-path check; they disclose no file content. Without procfs
  (non-Linux) the content operations fall back to the resolved-path check alone,
  and the sandboxed shell that makes the distinction matter is Linux-only.
- Timeouts match the Python tool: the config-level `timeoutSeconds` is the
  default, is not capped (a configured 900 s stays 900 s), and `0` disables the
  timeout. A caller-supplied timeout is capped at 600 s; a backend may only
  tighten that cap. Invalid timeout values fail before shell launch.
- Shell commands run with only the policy environment (`HOME` is the workspace,
  `TMPDIR` is the private scratch directory, and `PATH`/`LANG`/`TERM` plus
  snapshotted `allowedEnvKeys` are the only forwarded host values). Caller `env`
  and `inheritEnv` are ignored. Allowed keys are resolved once by the owning
  process; a backend that discards caller env must apply that fixed set inside
  its own namespace. Networking remains available, as in the Python wrapper.
- When `shell.restrictToWorkspace` is enabled, the policy applies Python's
  practical guard: textual `../`/`..\` and absolute or home paths outside the
  roots are refused with the workspace-boundary note. This is an
  accidental-damage guardrail, not confinement; command substitution, shell
  expansion and permitted programs can still reach outside paths.
- The native bash tool keeps its own output window, streaming callbacks, spill
  file and structured output. The host env passes those options and results
  through unchanged; it adds no second truncation pass. Spill/temp files are
  created under the private scratch root, which is also an allowed read root so
  `read` can recover the full output while the environment lives. Spill is not
  durable: the owned scratch root is removed on `cleanup` (including setup
  rollback), and a caller-supplied `tempDirectory` stays caller-owned. The
  optional sandbox has the same lifetime shape: outer `/tmp` spill is readable
  through the environment while live, unavailable to nested bash, and lost on
  cleanup. Neither backend may assume the spill survives.

## Limits

Host shell execution is **not** confinement. Deny patterns, the environment
allowlist and the optional path guard reduce accidental damage and stop a command
from inheriting secrets implicitly, but a permitted command can still read host
files, including credentials, and can use the network. The filesystem API guard
does not change that. `NodeExecutionEnv` kills the command's process group on
timeout, abort and cleanup, but a descendant that creates a new session/process
group (for example with `setsid`) escapes that teardown. The host backend has no
namespace to contain it.

The direct-workspace Bubblewrap shell narrows the mount view but stays
accidental-damage protection: it has no aggregate CPU, memory, PID-count or disk
quota, and a writable persistent workspace can fill host storage. Bubblewrap
namespaces alone are not resource quotas.

Python's exec URL guard is not ported into the shared policy or the host backend.
A URL in shell text is not scanned here, so the host backend does not claim
Python parity for that check; the gap is recorded rather than replaced by a
weaker approximation. The deny list and path guard do not close it.

## Checks

`npm run test:behavior` covers registration and authorization of the opt-in
coding tools but does not execute them. `npm run test:execution` covers the
shared policy deadline behavior on the host backend (invalid timeouts refused
before spawn, config default and its `0` opt-out, caller timeout expiry).

Private bounded probes (not repository tests) also exercised the shared policy
through `createHostExecutionEnv` with temporary workspaces: lexical and symlink
escapes were refused on read, write, canonicalize and shell cwd;
removing/renaming an outside-pointing link was allowed as a link operation and
the sentinel was unchanged; missing nested writes succeeded; deny patterns,
allow-pattern override, environment allowlist, caller-env ignoring and
process-group timeout teardown were observed; a 60 KiB output command spilled
intact and the spill was readable through the guard; a private temp file was
readable; and a shell `cat` of the outside sentinel succeeded, confirming the
documented non-confinement limitation. The native `createEnvConformance` suite
passed 24/24 cases against the host backend (temp-only, cleaned up), and still
passed 24/24 after the descriptor-verified content operations were added: byte
ranges, line scans, rename survival, `noFollow` refusal, metadata path/name,
directory readers, watch cases and exec cases were unchanged. Config
default 900 s survived uncapped while a 1200 s caller timeout clamped to 600 s
and a 0 config disabled the timeout; relative roots were rejected; a symlinked
workspace root canonicalized once to its real path; Python-style `../`, outside
absolute, outside home and `~other` commands were refused while inside absolute,
`~/`, `$HOME/`, `/dev/null` and a URL text remained allowed; caller env was
ignored and the allowlist snapshot survived a later host-env change; spill was
readable while live and gone after cleanup; cwd and invalid-policy setup failures
left no owned scratch root; a `setsid` descendant survived process-group
teardown; a workspace hard link wrote the outside inode; and a dangling
inside-target symlink was refused for read/write but removable as a link.
