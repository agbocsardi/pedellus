# Execution backends

`src/execution/index.ts` is a standalone managed-copy adapter. `runtime.ts` does
not import it, and it is **not** the Gateway's tool backend. The owner-approved
W1 path is the guarded host environment on the actual workspace
([`TOOLS.md`](./TOOLS.md)); the optional direct-workspace Bubblewrap shell is now
selectable per Gateway instance with `toolSandbox: "bwrap"` and is off by default
([`DIRECT_BWRAP.md`](./DIRECT_BWRAP.md)). The managed-copy contract below is not
approval to substitute it silently.

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
removeExecutionWorkspace(workspaceId, options?, context?): Promise<void>;
```

Creation generates a random UUID, makes an owner-only store entry at
`workspaces/<id>/root`, copies only explicit imports into `root/imports/<basename>`,
then writes `admissions/<id>.json` outside the guest root. The admission record is
owner-only and binds the id to the created root's device/inode. Reopen accepts only
a UUID with matching private metadata, verifies the root's identity/owner, then
restores its usable mode. It never resets workspace contents or re-imports files.
`ExecutionEnv.id` is stable per workspace (`nanobot:bwrap:<id>`), so Durable's
same-file identity is preserved when that workspace is reopened. Admission records
use format version 3; workspaces created by any earlier format are refused instead
of being reopened without a launch-intent witness.

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
`openExecutionEnv(id, ...)`. Reopening does not reset contents or re-import files.
Every create/open/remove holds one kernel-backed Chord `processLock` named from
the canonical store path and workspace id. A second live owner in any process
fails closed; the lock follows the owning process and is released by a crash or
SIGKILL, so there is no stale lock file to steal.

Before spawning anything, the owner durably writes `runs/<id>.launch` as
`pending <nonce>`. The host-side launcher then claims exactly that pending intent
and publishes `pid <supervisor-pid> <nonce>` before it execs bwrap; the same pid
remains the bwrap supervisor while the sandbox lives. Open and remove refuse while
a published supervisor still exists (a reused pid only delays startup). They also
refuse, and never auto-remove, a `pending` intent: a crash between spawn and
publication cannot be distinguished from no launcher at all, so that state
requires manual reconciliation. Once a published supervisor is gone its PID
namespace has been torn down and the stale file is removed. This fences the
owner-SIGKILL window: the kernel process lock can vanish while a pre-publication
launcher is still in flight, but the next owner sees the durable pending intent
and fails closed instead of mounting the same root. The launcher also re-reads
its nonce claim before exec, so a launcher cannot exec against a revoked or
replaced intent. Teardown clears only an intent whose nonce and published pid
match the launch it just stopped; a file that changed hands is retained. Manual
reconciliation of a `pending` file must first confirm on the host that no launcher
or sandbox for that workspace remains (the file deliberately carries no pid to
trust), then remove `runs/<id>.launch`; the workspace itself should be reclaimed
only by trusted host cleanup.

A setup failure calls a non-releasing `discard()` teardown, deletes the partial
bundle, admission, container, and launch file, and only then releases ownership.
Teardown must confirm a published supervisor pid before it may delete the launch
file; without that witness the intent is kept and the lock retained, leaving
manual-reconciliation state. If any part of the rollback is unverified, the lock
is retained for the rest of the process. Runtime `cleanup()` likewise releases
only after the supervisor pid is reaped and its launch file removed; a launch-file
deletion failure retains ownership rather than pretending teardown completed.
`removeExecutionWorkspace` requires the same lock and launch checks, re-validates
the private admission record and root identity, then deletes the workspace
container, admission record, and launch file. It refuses while any owner is live
or any pending intent exists. A partial deletion retains the owner lock until
that process exits so a damaged workspace cannot be reopened as if intact.

If a setup failure's rollback cannot be verified, the id/path is included in the
error and the retained private data is reported for recovery. A crash can leave
an orphaned container without an admission record; `removeExecutionWorkspace`
fails closed on it, so the trusted host owner must reclaim that store entry. There
is no automatic garbage collector, cross-store discovery, or publication.
Runtime/config integration and conversation-to-workspace mapping remain with the
parent; do not infer them from the standalone adapter.

The old `{ workspace, extraAllowedDirs }` API is intentionally rejected at
runtime, not just omitted from TypeScript types. The factory has no `dataDir`
input. Runtime/config integration, conversation ownership, and automatic
garbage collection remain with the parent; do not infer them from the standalone
adapter.

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
  descendants. As an experimental standalone-adapter guardrail—not a chosen
  product timeout policy—it enforces a host-owned 5-second maximum deadline
  (seconds, clamped with `min`; shorter valid caller limits remain intact), even
  when omitted. Commands exceeding it return a timeout error. It also applies
  the native output window capped at 64 KiB / 2,000 lines and 64 KiB/s, and
  disables spill-to-disk. Smaller valid caller windows remain in effect. With
  this native tail window, older output is omitted and reported as
  `ShellOutputInfo.skipped`; callers cannot recover omitted output and there is
  no spill file. The window bounds retained/transferred output, not bytes
  generated internally by a command. Invalid timeout/window values fail before
  shell launch.
- Managed provenance is the app-created owner-only store plus guest-inaccessible
  admission metadata and verified root identity—not a marker, chmod, realpath, or
  an `nlink` scan alone. Imports are copied into fresh inodes; preexisting outside
  hard-link aliases are rejected before their content is copied. Guest-created
  links remain within the private mounted workspace/scratch namespace.

## Shared policy and guarded host backend (W1 foundation)

`src/execution/policy.ts` is the shared execution policy. It owns the ported
shell deny patterns, the environment allowlist, the Python timeout rules, shell
command/allowlist/path filtering, and the filesystem containment check.
`src/execution/host.ts` imports it, including the optional direct-workspace
Bubblewrap shell. The Gateway's opt-in coding tools use `HostExecutionEnv` over
the actual workspace and per-conversation durable grants; see
[`TOOLS.md`](./TOOLS.md). That is accidental-damage protection, not hostile
isolation.

The optional shell backend is selected with `toolSandbox: "bwrap"` (absent or
`"host"` keeps the native shell) and an optional absolute `bwrapPath`. When tools
are enabled, `createToolEnvironments` resolves and validates Bubblewrap before
storage is opened, so a selected backend cannot silently fall back to the host
shell. Only `exec` is wrapped: the native `read`/`write`/`edit` tools and all
other `ExecutionEnv` filesystem methods stay the guarded host implementation on
the same workspace. The shell uses `buildDirectBwrapArgs` from
[`DIRECT_BWRAP.md`](./DIRECT_BWRAP.md), the shared deny/environment/timeout
policy, the actual workspace bound read-write, a private `/tmp`, and the host
network namespace. The parent writes bash spill files under its private scratch
root, so the reported full-output path remains readable through the guarded
filesystem while the environment lives but is not mounted in the sandbox; the
sandboxed command receives `TMPDIR=/tmp`. This is not a managed copy.

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
  dangling symlink whose textual target is inside the workspace. A check/use race
  remains, so this is a damage-reduction guard, not a security boundary. A hard
  link inside a root to an outside inode is not detectable by path and is
  allowed; writing or removing through it affects the outside inode.
- Timeouts match the Python tool: the config-level `timeoutSeconds` is the
  default, is not capped (a configured 900 s stays 900 s), and `0` disables the
  timeout. A caller-supplied timeout is capped at 600 s; a backend may only
  tighten that cap.
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

Host shell execution is **not** confinement. Deny patterns, the environment
allowlist and the optional path guard reduce accidental damage and stop a command
from inheriting secrets implicitly, but a permitted command can still read host
files, including credentials, and can use the network. The filesystem API guard
does not change that. `NodeExecutionEnv` kills the command's process group on
timeout, abort and cleanup, but a descendant that creates a new session/process
group (for example with `setsid`) escapes that teardown. The host backend has no
namespace to contain it.

Python's exec URL guard is not ported into the shared policy or the host backend.
A URL in shell text is not scanned here, so the host backend does not claim
Python parity for that check; the gap is recorded rather than replaced by a
weaker approximation. The deny list and path guard do not close it.

W2 source note: an earlier review overstated canonical rewriting in the
bubblewrap `checked()` helper. A later trace showed it authorizes the canonical
target and then passes the candidate path to the operation; escaping and dangling
final symlink operations remain refused. The direct-workspace W2 shell does not
use that helper: its filesystem operations are the same native guarded
`HostExecutionEnv` path, so there is no second path policy to reconcile there.
The standalone managed-copy adapter remains unreviewed for gateway use.

## Remaining security blockers

The managed-root, import, and owner invariants passed bounded synthetic probes,
but this is not an overall security acceptance. Shell execution still has no
aggregate CPU, memory, PID-count, or disk quota; a writable persistent workspace
can fill host storage. The adapter's deadline and output window are not
substitutes for CPU, memory, process-count, or disk quotas.
Bubblewrap namespaces alone are not resource quotas. Denial of service by filling
the private store is bounded only by the host filesystem. The launch intent is a
fail-closed liveness witness, not a sandbox-wide truth: a reused pid can delay
reopen, a `pending` intent requires manual reconciliation (restarting the process
does not clear it), and once the supervisor pid is gone the implementation relies
on Linux PID-namespace teardown (bounded probing observed the supervisor stays
alive while a guest runs and killing it kills the guest). The parent still owns runtime/config
integration, conversation-to-workspace persistence, and any automatic orphan
garbage collection; the lock only prevents concurrent owners. This slice does not
enable tools; the optional managed-copy bwrap adapter stays disabled until those
limits are reviewed. The owner clarification makes optional bwrap non-blocking for
the direct-workspace W1 path, which still requires its own review and durable
grants. The selectable `toolSandbox: "bwrap"` shell is the direct-workspace W2
mode, not the managed-copy adapter; it keeps the host filesystem guard, has no
CPU/memory/PID-count/disk quota, and is not a hostile-tenant boundary. No Python
daemon, VM, unsafe fallback, config-store access, or deployment changes were
introduced.

## Bounded synthetic evidence

- `npm run test:behavior --prefix packages/pi-nanobot` (155 checks) and
  `npm run test:execution --prefix packages/pi-nanobot` (9 checks) passed
  unchanged after the host policy slice.
- Bounded host probes (private, no repository tests added) created a temporary
  workspace and outside sentinel and exercised the shared policy through
  `createHostExecutionEnv`: lexical and symlink escapes were refused on read,
  write, canonicalize and shell cwd; removing/renaming an outside-pointing link
  was allowed as a link operation and the sentinel was unchanged; missing nested
  writes succeeded; deny patterns, allow-pattern override, environment allowlist,
  caller-env ignoring, policy timeout and process-group timeout teardown were
  observed;
  a 60 KiB output command spilled intact and the spill was readable through the
  guard; a private temp file was readable; and a shell `cat` of the outside
  sentinel succeeded, confirming the documented non-confinement limitation.
  The native `createEnvConformance` suite passed 24/24 cases against the host
  backend (temp-only, cleaned up).
- Fix-pass probe (private, temp-only, no repository tests): config default 900 s
  survived uncapped while a 1200 s caller timeout clamped to 600 s and a 0 config
  disabled the timeout; relative roots were rejected; a symlinked workspace root
  canonicalized once to its real path; Python-style `../`, outside absolute,
  outside home and `~other` commands were refused while inside absolute, `~/`,
  `$HOME/`, `/dev/null` and a URL text remained allowed; caller env was ignored
  and the allowlist snapshot survived a later host-env change; spill was readable
  while live and gone after cleanup; cwd and invalid-policy setup failures left no
  owned scratch root; a `setsid` descendant survived process-group teardown; a
  workspace hard link wrote the outside inode; and a dangling inside-target
  symlink was refused for read/write but removable as a link. The conformance
  suite still passed 24/24, and `npm run test:behavior` (155) plus
  `npm run test:execution` (9) stayed green.
- `npm ci --prefix packages/pi-nanobot --ignore-scripts`
- `npm run typecheck --prefix packages/pi-nanobot`
- `npm run build --prefix packages/pi-nanobot`
- `timeout --signal=TERM --kill-after=5s 90s node --max-old-space-size=256 --max-semi-space-size=32 /tmp/pi-nanobot-managed-probe.mjs`
  (private probe; no repository tests were added at that time).
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

- `npm run --prefix packages/pi-nanobot test:execution` builds and runs
  `node --test tests/execution-lifecycle.test.mjs` (5 tests, 120 s per-test
  budget). Nanobot-owned behavior only: a second live `openExecutionEnv` and a
  `removeExecutionWorkspace` attempt both fail closed while an owner exists;
  cleanup retains the workspace and leaves imported content intact for reopen;
  guarded deletion removes the container and admission record; the launcher's
  `pid <supervisor> <nonce>` publication is live while the sandbox lives and gone
  after verified cleanup; a live published pid blocks both open and removal until
  its process exits; malformed launch files are refused; a synthetic
  `pending <nonce>` intent (owner died between durable intent and publication) is
  refused by open and remove across repeated attempts and is never auto-removed;
  a failed setup (invalid cwd after daemon start) leaves no workspace, admission,
  or launch file behind; and a separate Node owner process is SIGKILLed, its
  intent survives, and the workspace either fails closed on a still-live sandbox
  or reopens after that supervisor is reaped.
- A bounded host probe (not a repository test) launched `bwrap --unshare-pid
  --die-with-parent --as-pid-1 ... /usr/bin/sleep` and observed that the bwrap
  supervisor pid stayed alive while the guest ran, and killing that pid killed
  the guest. After a short-lived Node spawner exited, the supervisor and guest
  were gone within the 0.5 s sampling window. The implementation does not rely
  on that timing: it refuses while the recorded supervisor pid exists.
- Actual Bubblewrap daemons and temporary stores only; no host workspace,
  credentials, service, or deployment was touched.
