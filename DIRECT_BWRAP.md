# Direct Bubblewrap shell argv builder — standalone, not wired

`src/execution/direct-bwrap.ts` is a new, standalone argv builder for the optional
Python-like Bubblewrap shell mode. It does **not** replace `src/execution/index.ts`
or `src/execution/sandbox.ts`, is not imported by `runtime.ts`, and does not enable
Gateway tools. The owner chose accidental-damage protection, not hostile isolation:
the command runs directly on the actual read-write workspace, with no managed copy,
import, publication, or sandbox-owned state.

## API

```ts
import { buildDirectBwrapArgs, resolveDirectBwrapPath } from "./execution/direct-bwrap.js";

const argv = buildDirectBwrapArgs({
  workspace: "/home/user/project", // must be an existing real directory, not "/"
  cwd: "/home/user/project/sub",   // optional; outside cwd falls back to the workspace
  bwrapPath: "/usr/bin/bwrap",     // optional; default prefers /usr/bin/bwrap, then PATH
  mediaDirectory: undefined,       // optional; only mounted when explicitly supplied
  command: ["/bin/sh", "-c", commandText],
});
// spawn(argv[0], argv.slice(1), { cwd: "/home/user/project", env: filteredEnv })
```

`buildDirectBwrapArgs` returns a `string[]` containing the trusted Bubblewrap
binary followed by separate arguments. It never builds a shell string from paths,
so a path or cwd containing spaces, quotes, or shell metacharacters stays one argv
element. The `command` argv is placed after `--`, so command arguments beginning
with `--` are not parsed as Bubblewrap options.

`resolveDirectBwrapPath` follows Python's preference for `/usr/bin/bwrap` and then
PATH when no path is configured. It validates that the binary identifies as
`bubblewrap` version 0.9 or newer and caches that validation per canonical path.
An explicitly configured path that is missing, not executable, or not Bubblewrap
throws; a distro path that exists but fails validation also throws instead of
falling through to an unprofiled PATH build. There is no fallback to another
binary and no unsandboxed execution path. Non-Linux hosts throw the same way.

## Mount layout

| Host | Inside sandbox | Mode |
| --- | --- | --- |
| `workspace` (resolved real path) | same path | read-write `--bind` |
| `/usr` | `/usr` | read-only `--ro-bind` (required) |
| `/bin`, `/lib`, `/lib64`, `/etc/alternatives`, `/etc/ssl/certs`, `/etc/resolv.conf`, `/etc/ld.so.cache` | same path | read-only `--ro-bind-try` (only if present) |
| `/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/localtime` | same path | read-only `--ro-bind-try` (only if present) |
| `workspace` parent | same path | private `--tmpfs`, so siblings such as `config.json` are hidden |
| `mediaDirectory` (only when configured) | same path | read-only `--ro-bind` |
| `/tmp` | `/tmp` | private `--tmpfs` |
| `/proc`, `/dev` | `/proc`, `/dev` | fresh proc/dev |

`HOME` is set to the workspace. No host home directory, config directory, secret
file, runtime state, socket, or data directory is mounted. `--new-session` detaches
the command from the controlling terminal. `--unshare-pid` gives the sandbox its
own PID namespace, and `--die-with-parent` kills Bubblewrap when its parent dies;
when Bubblewrap exits, the PID namespace is torn down and remaining background
descendants are killed. Bounded probes confirmed that a background process does
not survive either command exit or SIGKILL of Bubblewrap's launcher parent.

## Actual guarantees

- The command operates on the real workspace. Writes persist after the process
  exits; there is no copy-in, copy-back, publication, admission record, lock, or
  sandbox-managed workspace directory.
- The workspace is the only writable host mount. `/tmp` is ephemeral and private
  to the sandbox. System paths are read-only.
- The workspace parent is masked by a private tmpfs, so files next to the
  workspace are not visible unless a path is explicitly bound.
- Networking remains available: the builder does not pass `--unshare-net`.
- Background descendants are bounded to the sandbox PID namespace. They are
  killed when Bubblewrap exits or dies, including after its launcher parent is
  SIGKILLed; this was checked with a detached background process writing after a
  delay. It is process-lifecycle cleanup, not a CPU/memory/disk quota and not a
  replacement for the shell timeout and process-group policy.
- The command environment is inherited from the caller, with `HOME` overridden to
  the workspace. The builder does not call `--clearenv`; callers must pass the
  filtered environment required by the shell policy.

## Differences and limits

These are deliberate and must not be described as a confinement boundary.

- **Not hostile isolation.** The process runs as the same uid and uses the host
  network and IPC namespaces (only PID is explicitly unshared). It can use the
  network, read every system path listed above, and consume host CPU, memory,
  file descriptors, and disk until the caller's timeout or operating-system
  limits stop it. There are no CPU, memory, PID-count, or disk quotas here.
- **PID namespace is a deliberate Python difference.** Python does not unshare
  PID, so background work can outlive the command. This builder adds
  `--unshare-pid` so Bubblewrap exit tears the namespace down. The trade-off is
  that `/proc` and `ps` show only sandbox processes, and PIDs differ from host
  PIDs. The builder still omits `--unshare-ipc`, `--unshare-net`, `--clearenv`,
  and `--cap-drop`; the managed `sandbox.ts` backend is different again because it
  also unshares user/network/IPC namespaces, clears the environment, drops
  capabilities, and uses a copied workspace.
- **Bubblewrap identity is validated.** Python's `_resolve_bwrap` prefers
  `/usr/bin/bwrap` when it exists and otherwise searches PATH. This builder runs
  `/usr/bin/bwrap --version` (or the configured/PATH candidate) once per canonical
  path, requires a `bubblewrap` version of 0.9 or newer, and fails closed on a
  wrong executable or a distro binary that does not validate.
- **Normal identity files are mounted.** This builder adds read-only
  `/etc/passwd`, `/etc/group`, `/etc/hosts`, and `/etc/localtime` when present so
  ordinary tools can resolve users, groups, hosts, and time zones. Python's
  optional list does not include these four files.
- **ARGV instead of a quoted shell string.** Python joins the whole Bubblewrap
  argv with `shlex.join` and later hands that string to `bash -l -c`. This builder
  returns the argv directly. The caller chooses the in-sandbox shell (for example
  `["/bin/sh", "-c", command]`) and any outer launch policy. Paths and cwd are not
  reparsed by a shell.
- **Media is opt-in and disjoint.** Python always attempts to bind its media
  directory. Here `mediaDirectory` is added only when explicitly supplied, and a
  configured path must exist, be a directory, and not overlap the workspace.
  Overlap is rejected because a read-only bind over a workspace subtree would
  silently make that subtree read-only; Python would allow that overlay. Omitting
  the option mounts no media.
- **Cwd behavior.** Relative cwd is resolved against the workspace. A cwd that
  resolves outside the workspace falls back to the workspace root, matching Python.
  A missing or non-directory cwd throws rather than silently changing directories.
- **Host-home toolchains are unavailable.** Only the system paths in the mount
  table (plus synthetic `/proc`, `/dev`, `/tmp`), the workspace, and optional
  media are mounted. Host-home binaries such as `~/.local/bin`, `~/.cargo/bin`,
  nvm/pyenv installs, and paths under `/opt`, `/run`, or `/snap` are absent even
  if the caller's `PATH` names them. No general bind configuration is added; a
  workflow that needs a tool must use one available in the mounted system paths
  or inside the workspace.
- **`/tmp` spill files are not host-visible.** `/tmp` is a private tmpfs, so a
  command's spill or temporary output written there cannot be read by the host
  after the sandbox exits. Host-side spill paths must be under the workspace.
- **Policy lives elsewhere.** Deny patterns, environment allowlisting, command
  timeout, and process-group kill remain `ExecutionEnv`/tool-layer policy. This
  builder only describes the mount/namespace shape and does not enforce them.
- **No resource cleanup is needed.** The builder creates no files or directories
  and leaves no state. `/tmp` contents disappear when the sandbox exits.

## Validation performed and limits

On 2026-10-28, bounded probes used temporary workspaces under `/tmp` on Linux with
Bubblewrap 0.9.0. All 32 checks passed, plus separate `--new-session` and
`--die-with-parent`/PID-namespace probes. The checks confirmed:

- a workspace path and cwd containing spaces survive argv handling unchanged;
- workspace writes are visible on the host, and a relative cwd under the
  workspace is used;
- a sibling `config.json` and `secrets.env`, and an unrelated host `/tmp` marker,
  are hidden from the sandbox;
- `/tmp` is a private tmpfs and `/usr` is mounted `ro`;
- `/etc/passwd`, `/etc/group`, `/etc/hosts`, and `/etc/localtime` are readable
  when present on the host;
- configured media is readable and read-only, and absent when not configured;
  media inside or above the workspace is rejected;
- the caller environment is inherited (no `--clearenv`);
- the sandbox net namespace is the host net namespace, with no network request
  made by the probe;
- `--new-session` gives the sandbox a new session, and a background descendant
  does not survive command exit or SIGKILL of the launcher parent;
- missing configured Bubblewrap, a non-Bubblewrap executable (`/usr/bin/true`),
  the host root as workspace, media overlap, and an empty command all fail closed.

Not checked here: adversarial escape, resource exhaustion or quotas, an actual
pre-0.9 Bubblewrap binary, host `bash -l` environment parity, the shell deny
patterns, environment allowlist, timeout, and process-group kill. Those remain
`ExecutionEnv`/tool-layer checks, not properties of this argv builder.
