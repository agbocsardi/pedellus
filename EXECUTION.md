# Managed Bubblewrap execution spike — not enabled

`src/execution/index.ts` is standalone. `runtime.ts` does not import it, the
Gateway remains tool-less, and this is **not** approval to register coding tools.
The owner-approved initial contract is an application-managed private workspace
with explicit copy-in imports: arbitrary host workspace/extra-root binds are
rejected, and there is no publication or copy-back.

## API and lifecycle

```ts
interface ExecutionOptions {
  storageDirectory?: string; // trusted app-owned private store; default ~/.local/share/nanobot/execution
  imports?: readonly string[]; // absolute source paths, creation only
  cwd?: string;               // virtual /workspace path, or relative to it
  bwrapPath?: string;         // absolute trusted executable; default /usr/bin/bwrap
}

createExecutionEnv(options, context?): Promise<ManagedExecutionEnv>;
openExecutionEnv(workspaceId, options?, context?): Promise<ManagedExecutionEnv>;
```

Creation generates a random UUID, makes an owner-only store entry at
`workspaces/<id>/root`, copies only explicit imports into `root/imports/<basename>`,
then writes `admissions/<id>.json` outside the guest root. The admission record is
owner-only and binds the id to the created root's device/inode. Reopen accepts only
a UUID with matching private metadata, verifies the root's identity/owner, then
restores its usable mode. It never resets workspace contents or re-imports files.
`ExecutionEnv.id` is stable per workspace (`nanobot:bwrap:<id>`), so Durable's
same-file identity is preserved when that workspace is reopened.

Import admission normalizes and policy-checks the absolute path, then opens every
ancestor from `/` relative to the previously pinned directory FD with
`O_DIRECTORY|O_NOFOLLOW`; the final component is opened relative to that pinned
parent with `O_NOFOLLOW`. Type/link checks use `fstat` on that exact final FD—no
separate lstat/realpath loop authorizes a different pathname resolution. The
resulting source descriptors are read-only mounts in a short-lived, isolated
bwrap copy worker; their mounts disappear before execution starts. The worker
rejects symlinks, special files, and files with
`nlink != 1`; it opens files with `O_NOFOLLOW`, checks the opened inode, and copies
bytes into exclusive new files (no source hard links or symlinks are preserved).
Directories are traversed via pinned directory descriptors. Per-file and
per-directory metadata checks reject sources that change while copying; this is
not a filesystem-wide atomic snapshot, so callers must provide a quiescent tree
for content consistency; this assumption is not the authorization boundary.
A bounded actual-filesystem ancestor-symlink injection check is recorded below.
Limits are 32 imports,
64 MiB total file content, 10,000 entries, depth 64, and
30 seconds. The worker uses a private copy of the host Node executable plus
read-only `/usr`; runtimes that need external host libraries fail closed.
Duplicate basenames, system roots, `/`, the host home itself/its parents, host
`/tmp` itself, and any symlink in an import path are rejected. Explicitly
importing a file or subdirectory grants the guest a copy of its contents; do not
select credentials or other data you do not intend to disclose. Imports never
mutate their source.

`cleanup()` stops the daemon and descendants but **retains** the workspace for
`openExecutionEnv(id, ...)`. The workspace persists until its trusted host owner
removes it after all owners have stopped. This spike has no deletion API, cross-
process workspace lock, or garbage collector; those are parent runtime/manager
integration requirements. A setup failure removes its new workspace unless
cleanup itself fails, in which case the id/path is included in the error and the
retained private data is reported for recovery or garbage collection. There is no
automatic publication.

The old `{ workspace, extraAllowedDirs }` API is intentionally rejected at
runtime, not just omitted from TypeScript types. The factory has no `dataDir`
input. Runtime/config integration, conversation ownership, an OS-backed owner
lock, and safe garbage collection remain with the parent; do not infer them from
the standalone adapter.

## Namespace boundary

- The pi-env `1.4.0` daemon runs in an outer Bubblewrap user/PID/network/IPC namespace.
  The only writable host bind is the application-created workspace, mounted at
  virtual `/workspace`. `/usr` is read-only. Host `/etc`, home, dataDir, auth
  sockets, and host network are absent. `/tmp` is sandbox-private scratch.
- The one-shot import worker and each shell command also receive a fresh IPC
  namespace via mandatory `--unshare-ipc` in the shared Bubblewrap argument
  builder. Unsupported launches fail closed; there is no fallback switch. The
  import helper's synthetic SysV shared-memory probe is recorded below.
- The standalone `@earendil-works/pi-env@1.4.0` daemon implements native Durable
  `RemoteExecutionEnv` FS and shell semantics. Every filesystem syscall (rename
  source and destination, readers, listings, watches, temp/spill paths, etc.)
  occurs inside the namespace; path checks are defense in depth, not the boundary.
- Every shell command runs in a nested user/PID/network/IPC namespace with only
  `/workspace`, read-only `/usr`, fresh `/proc` and `/dev`, private `/tmp`, dropped
  capabilities, cleared environment, and a PID-1 command. `HOME=/workspace`,
  `PATH=/usr/bin:/bin`, `TMPDIR=/tmp`, and `LANG=C.UTF-8`; caller `env` and
  `inheritEnv` are ignored. Setup is cancellable, probes a real command, and has
  no unsandboxed fallback. Shell timeout/cancellation/cleanup tear down detached
  descendants.
- Managed provenance is the app-created owner-only store plus guest-inaccessible
  admission metadata and verified root identity—not a marker, chmod, realpath, or
  an `nlink` scan alone. Imports are copied into fresh inodes; preexisting outside
  hard-link aliases are rejected before their content is copied. Guest-created
  links remain within the private mounted workspace/scratch namespace.

## Remaining security blockers

The managed-root and import invariants passed bounded synthetic probes, but this
is not an overall security acceptance. Shell execution still has no aggregate
CPU, memory, PID-count, or disk quota; a writable persistent workspace can fill
host storage, and an omitted shell timeout is not capped here. Bubblewrap
namespaces alone are not resource quotas. The app-owned store also still needs
the parent runtime's cross-process owner lock, deletion/GC lifecycle, and
conversation-to-workspace persistence. Keep tools disabled until those limits
and integration contracts are reviewed. No Python daemon, VM, unsafe fallback,
config-store access, or deployment changes were introduced.

## Bounded synthetic evidence

- `npm ci --prefix packages/pi-nanobot --ignore-scripts`
- `npm run typecheck --prefix packages/pi-nanobot`
- `npm run build --prefix packages/pi-nanobot`
- `timeout --signal=TERM --kill-after=5s 90s node --max-old-space-size=256 --max-semi-space-size=32 /tmp/pi-nanobot-managed-probe.mjs`
  (private probe only; no repository tests were added).
- Probe evidence: native FS readers/listing/watch/temp/spill/rename; explicit file
  and directory imports created fresh inodes and left sources unchanged; opaque-
  id reopen preserved workspace edits; guest could not see admission metadata,
  synthetic dataDir, host `/etc`, auth socket, credentials, or host loopback. A
  workspace symlink race and a racing import symlink could not read or change the
  outside synthetic sentinel. Import trees with an outside hard-link alias or a
  symlink were rejected; the sentinel remained unchanged and failed imports left
  no workspace. `setsid` descendants left no markers after abort, timeout, or
  cleanup. A fake nested bwrap exit 17 rejected setup; delayed setup cancellation
  removed its new workspace. Arbitrary host roots were rejected.
- An initial managed-import probe showed a directory import absent after a regular
  file import. Instrumentation showed the worker advanced only the first manifest
  entry while copying through `FileHandle` streams configured with `autoClose:false`.
  Replacing that path with bounded 64 KiB positional reads/writes fixed it; the
  combined file/directory import probe then passed.
- The exact import limitation test hard-linked a synthetic outside sentinel into
  a selected import directory before admission. The worker rejected the `nlink`
  alias before copying content; no read or mutation of the sentinel was observed.
- Parent-provided read-only IPC fixture/probe created one private synthetic
  `0600` SysV segment and attempted read-only attach from the guest shell. After
  requiring `--unshare-ipc`, host and guest IPC namespace IDs differed, `shmat`
  was denied (guest exit 0), and no real host IPC objects were inspected. The
  same shared bwrap argument builder applies this requirement to outer daemon,
  importer, and shell launches.
- `timeout --signal=TERM --kill-after=5s 60s node --max-old-space-size=256
  --max-semi-space-size=32 /tmp/pi-nanobot-import-ancestor-aba-probe.mjs`
  used a controlled `open()` boundary hook around the built admission helper,
  actual temporary directories/symlink swaps, and real file descriptors. For
  both file and directory roots, it swapped an ancestor to a symlink to an
  outside synthetic sentinel after opening the selected parent FD and kept it
  swapped through the final open. The admitted FD exposed only authorized
  inside bytes. Stable symlink ancestors were rejected through public creation;
  no workspace remained and repeated rejection left the process FD count stable.
  No fabricated inode/stat results or real host data were used.

The probe uses only a temporary app store, synthetic imported files, a synthetic
Unix auth socket, a loopback listener, and a synthetic outside sentinel; it
removes all temporary data on exit. No real credentials, live bot, provider,
Python deployment, or host package install was used.
