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
PATH when no path is configured. An explicitly configured path that is missing or
not executable throws; there is no fallback to another binary and no unsandboxed
execution path. Non-Linux hosts throw the same way.

## Mount layout

| Host | Inside sandbox | Mode |
| --- | --- | --- |
| `workspace` (resolved real path) | same path | read-write `--bind` |
| `/usr` | `/usr` | read-only `--ro-bind` (required) |
| `/bin`, `/lib`, `/lib64`, `/etc/alternatives`, `/etc/ssl/certs`, `/etc/resolv.conf`, `/etc/ld.so.cache` | same path | read-only `--ro-bind-try` (only if present) |
| `workspace` parent | same path | private `--tmpfs`, so siblings such as `config.json` are hidden |
| `mediaDirectory` (only when configured) | same path | read-only `--ro-bind` |
| `/tmp` | `/tmp` | private `--tmpfs` |
| `/proc`, `/dev` | `/proc`, `/dev` | fresh proc/dev |

`HOME` is set to the workspace. No host home directory, config directory, secret
file, runtime state, socket, or data directory is mounted. `--new-session` detaches
the command from the controlling terminal. `--die-with-parent` makes Bubblewrap
SIGKILL the command when Bubblewrap or its parent dies.

## Actual guarantees

- The command operates on the real workspace. Writes persist after the process
  exits; there is no copy-in, copy-back, publication, admission record, lock, or
  sandbox-managed workspace directory.
- The workspace is the only writable host mount. `/tmp` is ephemeral and private
  to the sandbox. System paths are read-only.
- The workspace parent is masked by a private tmpfs, so files next to the
  workspace are not visible unless a path is explicitly bound.
- Networking remains available: the builder does not pass `--unshare-net`.
- The command environment is inherited from the caller, with `HOME` overridden to
  the workspace. The builder does not call `--clearenv`; callers must pass the
  filtered environment required by the shell policy.

## Differences and limits

These are deliberate and must not be described as a confinement boundary.

- **Not hostile isolation.** The process runs as the same user in the host PID,
  network, and IPC namespaces. It can use the network, read every system path
  listed above, and consume host CPU, memory, file descriptors, and disk until the
  caller's timeout or operating-system limits stop it. There are no CPU, memory,
  PID-count, or disk quotas here.
- **No `--unshare-pid`, `--unshare-ipc`, `--unshare-net`, `--clearenv`, or
  `--cap-drop`.** These omissions match the Python `_bwrap` wrapper and keep
  network and native process semantics; they are why this is a guardrail, not an
  adversarial sandbox. The managed `sandbox.ts` backend is different: it unshares
  user/PID/network/IPC namespaces, clears the environment, drops capabilities, and
  uses a copied workspace.
- **ARGV instead of a quoted shell string.** Python joins the whole Bubblewrap
  argv with `shlex.join` and later hands that string to `bash -l -c`. This builder
  returns the argv directly. The caller chooses the in-sandbox shell (for example
  `["/bin/sh", "-c", command]`) and any outer launch policy. Paths and cwd are not
  reparsed by a shell.
- **Media is opt-in.** Python always attempts to bind its media directory. Here
  `mediaDirectory` is added only when explicitly supplied, and a configured path
  must exist, be a directory, and not be the workspace or one of its parents.
  Omitting it mounts no media.
- **Cwd behavior.** Relative cwd is resolved against the workspace. A cwd that
  resolves outside the workspace falls back to the workspace root, matching Python.
  A missing or non-directory cwd throws rather than silently changing directories.
- **Policy lives elsewhere.** Deny patterns, environment allowlisting, command
  timeout, and process-group kill remain `ExecutionEnv`/tool-layer policy. This
  builder only describes the mount/namespace shape and does not enforce them.
- **No resource cleanup is needed.** The builder creates no files or directories
  and leaves no state. `/tmp` contents disappear when the sandbox exits.

## Validation performed and limits

On 2026-10-28, bounded probes used temporary workspaces under `/tmp` on Linux with
Bubblewrap 0.9.0. All 23 checks passed, plus separate `--new-session` and
`--die-with-parent` probes. The checks confirmed:

- a workspace path and cwd containing spaces survive argv handling unchanged;
- workspace writes are visible on the host, and a relative cwd under the
  workspace is used;
- a sibling `config.json` and `secrets.env`, and an unrelated host `/tmp` marker,
  are hidden from the sandbox;
- `/tmp` is a private tmpfs and `/usr` is mounted `ro`;
- configured media is readable and read-only, and absent when not configured;
- the caller environment is inherited (no `--clearenv`);
- the sandbox net namespace is the host net namespace, with no network request
  made by the probe;
- `--new-session` makes the command a session leader, and `--die-with-parent`
  kills the command after its launcher parent is SIGKILLed;
- a missing configured Bubblewrap, the host root as workspace, a media ancestor
  of the workspace, and an empty command all fail closed.

Not checked here: adversarial escape, resource exhaustion or quotas, host
`bash -l` environment parity, the shell deny patterns, environment allowlist,
timeout, and process-group kill. Those remain `ExecutionEnv`/tool-layer checks,
not properties of this argv builder.
