# Execution environment spike — still blocked

`src/execution/index.ts` exports `createExecutionEnv(options, context?)`. It is a
standalone experiment; `runtime.ts` does not import it, the gateway remains
tool-less, and this is **not** approval to register coding tools.

## Current boundary

- Exact dependency: `@earendil-works/pi-env@1.4.0` (MIT, from Pi v1.4.0). Its
  native daemon/protocol supplies Durable `RemoteExecutionEnv` filesystem and
  shell semantics; no custom FS RPC implementation was added.
- The daemon and a pinned copy of the validated bwrap executable are started
  inside an outer bwrap user/PID/network namespace. Only configured roots are
  writable bind mounts. `/usr` is read-only; host `/etc`, home, dataDir, auth
  sockets, and network are not mounted/granted. Environment is cleared and set
  to a small fixed `PATH`, `HOME` (workspace), `TMPDIR`, and `LANG`; caller `env`
  and `inheritEnv` are ignored.
- Each shell command runs in another bwrap PID namespace with the configured
  roots mounted explicitly, capabilities dropped, and a PID-1 command. This
  makes timeout/abort tear down ordinary and `setsid`-detached descendants.
  There is no unsandboxed fallback. Setup probes a real command and rejects
  nonzero exits. `createExecutionEnv` also accepts a Chord `Context` for bounded,
  cancellable setup; cleanup closes the daemon, waits for the bwrap host PID to
  exit, then removes its private launcher/binary directory.
- Every filesystem syscall (including both rename operands, missing destinations,
  readers, list/listFiles, watches, cwd lookup, temp files, and daemon spill
  files) is performed by pi-env inside bwrap. The host `realpath` is used only
  to canonicalize configured root directories; after sandbox start their device
  and inode are checked against the mounted roots. The adapter retains an
  in-sandbox path policy check as defense in depth. A stable environment id,
  `nanobot:bwrap:local`, lets Durable coordinate same-path writes across local
  environment instances. `/tmp` is private to the sandbox; it is not a host
  `/tmp` bind. For a workspace below host `/tmp`, mount the workspace before
  creating private `/tmp` ancestors so the source path is not hidden.
- Workspace and extra-root writes retain direct, immediate host visibility.
  Roots under protected system locations, roots overlapping the host home, `/`,
  and nested roots are rejected. The factory has no `dataDir` input; the runtime
  must continue to reject a Durable dataDir inside a mounted writable root.

## Security gate: hard-link identity remains exposed

bwrap confines path traversal and symlink resolution to its mount namespace,
but a writable bind mount is still the same host filesystem and inode. A
preexisting hard link in a writable root can therefore name a file also
reachable outside it. The bounded synthetic probe created
`outside/sentinel.txt`, hard-linked it into the workspace *before setup*, then
wrote through that workspace alias; the outside sentinel changed to
`HARDLINK_ALIAS_PROOF`. This is a reproduced security failure, not a theoretical
caveat. Path checks, pi-env, nested PID namespaces, Durable replay policy, and
submit/requestId deduplication do not solve it.

No isolated-copy/publication behavior or blanket rejection of writable roots has
been chosen. Keep tools disabled until the parent approves a reviewed policy
that breaks external inode identity (and defines workspace/extra-root publication
and conflict semantics), or an equivalent OS boundary. This spike also does not
apply CPU, memory, or process-count limits; bwrap namespaces alone are not resource
quotas. In particular, do not claim this adapter is production-safe from
compilation or the passing symlink probes.

## Bounded evidence

- `npm install --prefix packages/pi-nanobot --save-exact
  @earendil-works/pi-env@1.4.0 --ignore-scripts`
- `npm run typecheck --prefix packages/pi-nanobot`
- `npm run build --prefix packages/pi-nanobot`
- Synthetic-only probe:
  `timeout --signal=TERM --kill-after=5s 90s node --max-old-space-size=256
  --max-semi-space-size=32 /tmp/pi-nanobot-p1-probe.mjs`
  (the probe is outside the repository; no test scaffolding was committed).
- Observed: native FS round trips, readers, directory and recursive listing,
  watches, temp/spill paths, absent-destination rename, and both out-of-root
  rename operands; explicit extra root remained writable. Ordinary and racing
  symlink cases could not read or alter the synthetic outside sentinel. The host
  sentinel, synthetic auth socket, and synthetic dataDir were unavailable to
  shell; synthetic host-loopback TCP was unreachable; `/usr` was read-only and
  rejected as an extra root. A detached `setsid` child left no marker after
  abort, timeout, or explicit cleanup. A fake bwrap whose nested execution
  exited 17 failed setup; aborting a deliberately delayed setup returned after
  teardown. Nonexistent cwd was rejected.
- One probe iteration exposed that an inner bwrap must bind the configured roots
  itself before changing cwd; it was fixed and rerun. Creating `/tmp` before
  binding a workspace below `/tmp` masked the source path; ordering was fixed and
  rerun. The hard-link probe is the remaining failed invariant and blocks the
  gate.

These checks use only temporary synthetic files, a synthetic Unix socket, and a
loopback listener; no credentials, live bot, external provider, or host package
changes were used. The probe's hard-link write is intentionally confined to that
temporary directory, which is removed at exit. `npm ci --prefix packages/pi-nanobot
--ignore-scripts` also completed successfully.
