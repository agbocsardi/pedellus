# Direct Bubblewrap shell backend — optional, off by default

`src/execution/direct-bwrap.ts` is the argv builder for the optional Python-like
Bubblewrap shell mode. `HostExecutionEnv` uses it only when a Gateway instance
configures `toolSandbox: "bwrap"`; absent or `"host"` keeps the guarded native
shell. It is the only Bubblewrap path: there is no managed copy, import, stage
or publish-back, and no sandbox-owned workspace state. The owner chose
accidental-damage protection, not hostile isolation: the command runs directly on
the actual read-write workspace.

Only shell commands are wrapped. The native `read`, `write` and `edit` tools keep
using the guarded `HostExecutionEnv` filesystem methods on the same actual
workspace; they do not run inside the Bubblewrap mount namespace.

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

The Gateway builds one environment per conversation with
`createHostExecutionEnv({ shellSandbox: { bwrapPath } })`. When tools are enabled,
a configured backend is resolved and validated before storage is opened, and the
environment is created lazily for its first tool call. `bwrapPath` is the
optional top-level config field of the same name. An invalid or missing binary
fails startup; a command that cannot build or start its argv fails the call.
There is no fallback to the host shell.

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
  the workspace. The builder does not call `--clearenv`; the Gateway passes only
  the shared policy environment and replaces its host scratch `TMPDIR` with `/tmp`.

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
  returns the argv directly, and the Gateway spawns Bubblewrap without an outer
  shell. For a string bash command the Gateway chooses `/bin/bash -c` when the
  host has it (then `/usr/bin/bash`, `/bin/sh`, `/usr/bin/sh`), so bash-specific
  command text keeps native tool semantics; Python's inner command shell is
  `sh -c`. The literal command remains one argv element and paths/cwd are not
  reparsed by an outer shell.
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
- **`/tmp` is private and not a spill transport.** `/tmp` is a private tmpfs, so
  files a command writes there are invisible to the host and disappear when the
  sandbox exits. The Gateway therefore sets `TMPDIR=/tmp` for the sandboxed command
  rather than the host scratch path, which is not mounted. The native bash tool's
  full-output spill file is different: the host parent writes it under its private
  scratch root, so the reported `fullOutputPath` stays readable through the guarded
  `read`/filesystem API while the environment lives. That spill path is not mounted
  into the sandbox and is not readable by an in-sandbox `bash` command; use `read`.
  Spill and scratch files are removed when the environment is cleaned up, not
  durable storage.
- **Policy lives elsewhere.** Deny patterns, environment allowlisting, command
  timeout, cwd containment, and the filesystem guard remain
  `ExecutionEnv`/`policy.ts` policy. The Gateway applies the same policy before
  wrapping the command; this builder only describes the mount/namespace shape and
  does not enforce them. There is no second policy in the bwrap path.
- **No resource cleanup is needed.** The builder creates no files or directories
  and leaves no state. `/tmp` contents disappear when the sandbox exits.

## Validation performed and limits

On 2026-10-28, bounded probes used temporary workspaces under `/tmp` on Linux with
Bubblewrap 0.9.0. All 32 builder checks passed, plus separate `--new-session` and
`--die-with-parent`/PID-namespace probes. A second bounded Gateway integration
probe (nine shell-environment checks through `createHostExecutionEnv` and four
through `openGateway` with a faux provider and a temporary workspace/data
directory) confirmed:

- config accepts `toolSandbox: "bwrap"` and rejects an unknown value;
- a configured `/usr/bin/true` or missing binary fails environment creation, and
  `openGateway` with tools enabled fails before use;
- a real Gateway turn runs `bash` on the actual workspace and its write persists;
- the shell reports `TMPDIR=/tmp`, workspace siblings stay masked, and the host
  network namespace is unchanged;
- a host-written bash spill file is readable through the guarded filesystem while
  its name is absent from the sandbox `/tmp`;
- the shared timeout still ends the bwrap process group, and the shared path guard
  still refuses an outside absolute path.

The earlier builder checks confirmed:

- a workspace path and cwd containing spaces survive argv handling unchanged;
- workspace writes are visible on the host, and a relative cwd under the
  workspace is used;
- sibling configuration and credential fixtures, and an unrelated host `/tmp`
  marker, are hidden from the sandbox;
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
pre-0.9 Bubblewrap binary, host `bash -l` environment parity, and every filesystem
race. The shared shell deny patterns, environment allowlist, timeout and
process-group kill are `ExecutionEnv`/tool-layer checks, not properties of this
argv builder; the integration probe exercised only the cases listed above. No
provider request, real credential, network request, live data or permanent test
file was used.
