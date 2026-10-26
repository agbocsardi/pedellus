# Execution environment spike

`src/execution/index.ts` exports `createExecutionEnv(options): Promise<ExecutionEnv>`. Setup is Linux-only, validates an absolute Bubblewrap executable (default `/usr/bin/bwrap`, version >= 0.9.0), canonicalizes workspace/extra roots, rejects nested roots, validates cwd, and runs a real sandbox probe before returning. There is no native-shell fallback.

Filesystem calls compose upstream `NodeExecutionEnv` only after checking each public path: file reads/readers, writes/appends/truncate/flush, both rename operands, metadata/listing, watches, cwd/absolute/join paths, and missing write leaves. Existing symlink targets are resolved; missing leaves are resolved through the nearest existing ancestor; dangling symlinks are denied. Host temp/spill files are instead created in a private `.pi-execution-tmp` below the workspace and removed by cleanup. Upstream result/error and abort handling is retained.

Shell runs are wrapped in `/usr/bin/bwrap`-style Bubblewrap with fresh user, PID, and network namespaces, `--die-with-parent`, new session, all capabilities dropped, cleared environment, read-only `/usr` runtime, tmpfs `/tmp`, and only configured roots writable. Extra caller env is ignored. The host-side shell is only a trusted launcher; the supplied command runs inside Bubblewrap. Cleanup delegates process termination to `NodeExecutionEnv` and removes tracked temp paths.

## Checks run

- `npm ci --prefix packages/pi-nanobot --ignore-scripts`
- `npm run typecheck --prefix packages/pi-nanobot`
- `npm run build --prefix packages/pi-nanobot`
- Bounded inline Node probe: workspace write succeeded; `../secret` read was denied; command ran under bwrap, saw no supplied `OPENAI_API_KEY`, and could not see the host secret; ordinary argv command returned successfully. A separate `/proc/self/status` probe observed `CapEff: 0000000000000000` and confirmed `/root` was absent. Another bounded probe checked missing-leaf writes, symlink escape rejection, and both rename operands; cancellation stopped a long-running shell, and spill/temp creation succeeded.

## Security gate still blocked

This is a best-effort path-check wrapper, **not a race-resistant filesystem capability**. Path checks and subsequent Node filesystem calls are separate operations, so concurrent symlink replacement can redirect reads/writes. A hard link inside a writable root can name an inode also reachable outside it; Bubblewrap bind mounts preserve hard links, so shell writes can also affect that external inode. Realpath checks do not solve either issue. The shell namespace probe proves the configured bwrap invocation works, not that arbitrary workspace contents are race/hardlink safe.

Therefore do not expose filesystem or shell tools to untrusted/model-controlled calls as production-safe yet. Keep unsafe coding tools unregistered/disabled until the filesystem boundary is enforced by an OS primitive (e.g. an `openat2`/dirfd-based helper for all path operations plus a hard-link policy, or an isolated copy-on-write workspace that breaks external inode identity), or otherwise provide a reviewed equivalent. Parent integration must also reject `dataDir` inside workspace/extra roots; this factory has no `dataDir` option and cannot enforce that policy itself. This is an experimental integration slice, not a passed security gate.
