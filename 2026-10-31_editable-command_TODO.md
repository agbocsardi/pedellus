# Editable command and service naming — 2026-10-31

## Checklist

- [x] Checkpoint channel/worker parity and the rejected rollback decision before packaging edits.
- [x] Expose only `durable-nanobot` through package bin metadata and an executable Node entry point; preserve internal storage/protocol identities.
- [x] Rename user-unit templates to `durable-nanobot.service` / `durable-nanobot@.service` without changing installed services.
- [x] Update active command examples, diagnostics and existing assertions for the new command/service names.
- [x] Document checkout linking, build/watch and gateway/service restart requirements.
- [x] Set the example and primary setup layout to use `~/.durable-nanobot/data/`, separate from the workspace and checkout.
- [x] Validate package metadata, built CLI, static units and existing offline checks; do not link globally, install/start/reload services or touch Python's `nanobot`.

## Log

### 2026-10-31

Owner selected `durable-nanobot` and approved checkpointing the prior batch. Committed that batch as `a8aadd7`. Naming/packaging only: keep the existing runtime home, data names, lock key and native task identities. systemd will continue launching an absolute Node executable against this checkout's built entry point, independently of a shell command link. All install/link/service-manager commands remain operator steps.

Added the `durable-nanobot` package bin and Node shebang, updated CLI diagnostics and active examples, and renamed the two unit templates. Replaced path-based executable detection with native `import.meta.main` (available since Node 22.18, below the supported minimum) so symlinked npm commands actually launch. Added only root bin metadata to the lockfile; the dependency graph is unchanged. Existing assertions were updated for renamed outputs and paths; no new permanent suite was added.

Validation: typecheck/build, 306 behavior checks, 2 execution checks and 83 offline core acceptance checks passed, including static systemd verification. A disposable symlink probe confirmed the built entry point runs through a symlink, retains its shebang and remains side-effect-free on import; package/lock bin metadata agree. Python's existing command still resolves to its uv-managed executable. No global npm link, package installation, live inference, service install/start/reload or process replacement was performed. Documented that code/dependency reinstall leaves the configured SQLite store intact; keeping persistent data outside a replaceable checkout and preserving the same `dataDir` remain operator responsibilities.

Owner selected persistent state beneath the runtime home. An empty `data/` directory already exists there, with no primary config or SQLite store present. Changed the example to `dataDir: "./data"` and documented that placing it at the fixed primary config path resolves state beneath the runtime home; secondary instances retain their own sibling data/workspace directories. Kept the demo explicitly disposable. No live config was synthesized, no fallback/path-expansion behavior was added, and no state was moved or runtime started.
