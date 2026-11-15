# Run the gateway as a user service

This page describes the shipped, operator-installed **user** systemd units for a
foreground gateway. The repository does not install, enable, start or reload
services, does not enable lingering, and does not change system settings. The
commands below are operator steps; none were run by this project's checks.

The gateway itself remains an ordinary foreground process. These units do not
add a daemon, supervisor, background shell, restart loop or npm-start wrapper:
systemd runs one `node bin/durable-nanobot.mjs gateway` process per instance and stops it with
the existing SIGTERM/SIGINT teardown.

## Units

| File | Use |
| --- | --- |
| [`systemd/durable-nanobot.service`](systemd/durable-nanobot.service) | The primary instance uses the default config `~/.durable-nanobot/config.json`. |
| [`systemd/durable-nanobot@.service`](systemd/durable-nanobot@.service) | One named secondary instance uses `~/.durable-nanobot/instances/i-<name>/config.json`. |

Both are user units. Copy or symlink them into the user unit directory, for
example `~/.config/systemd/user/`, after editing the launch paths.

Each unit has two placeholders that must become absolute paths on the installed
machine:

- `/usr/bin/node` — the Node >= 22.19 executable. Use the absolute path from
  `command -v node`; do not rely on a shell `PATH` or either global CLI command.
- `/opt/durable-nanobot` — this checkout. The unit runs
  `<checkout>/bin/durable-nanobot.mjs` through Node after `npm ci`, independently
  of `npm link`. The launcher loads source TypeScript through pinned `tsx`.

The TypeScript command and units are named `durable-nanobot`; Python keeps
`nanobot`. These templates neither replace nor stop an installed Python unit.
The existing runtime home and storage/protocol identities are unchanged.

Because the unit file cannot expand shell variables in `ExecStart`, those two
paths are edited directly in the copy. Everything else uses systemd specifiers:
`%h` is the user's home and `%i` is the unit instance name.

## Checkout command and build workflow

The package exposes only `durable-nanobot` as its executable. From the checkout,
after installing the pinned dependencies, these are optional operator steps:

```sh
npm link --offline
durable-nanobot agent
```

The linked command, `npm start -- ...` and the service all use the same small
JavaScript source launcher. It loads `src/cli.ts` in-process with pinned `tsx`,
including TypeScript parameter properties and the source tree's `.js` import
specifiers. Its compiler setting avoids a persistent helper child across native
execve restart. Loading it is independent of the process working directory.

`npm link` does not copy the code, run a gateway, install a service or claim
Python's `nanobot` command. Without linking, use
`node bin/durable-nanobot.mjs agent` or `npm start -- agent`. The agent attaches
to an already-running gateway with the same configuration.

For source edits, restart the gateway: **no build is needed**. Checking types
first is recommended because runtime transpilation does not typecheck:

```sh
npm run typecheck
systemctl --user restart durable-nanobot.service
```

A supported owner `/restart` also reloads source through the same launcher and
keeps the current process environment. This is restart-to-reload, not hot reload;
there is no filesystem watcher or build-on-start step. Code-only edits need no
`daemon-reload`, `npm link` or `tsc` output. Dependency changes require updating
the pinned installation before restarting. `npm run build` still creates the
optional compiled `dist/cli.js` entry point for distribution and existing tests;
that alternative does require rebuilding before a code change can take effect.

Editing a unit or drop-in requires `systemctl --user daemon-reload` before
restart. Editing only an environment file needs a service restart to reload it;
`/restart` does not reload systemd's environment file. Relocating the checkout
requires updating the unit's absolute launch path and relinking the CLI if used.
Do not run a second `gateway` manually while the service owns the same store.
None of these linking or service-manager commands is run by the offline checks.

Reinstalling dependencies (`npm ci`), rebuilding or relinking the command does not
remove Durable state. The authoritative SQLite store remains under the configured
`dataDir`, not `node_modules` or the command link. Keep `dataDir`, workspace and
private config outside a checkout you may delete or replace. Continue using the
same `dataDir` after reinstalling: selecting a different directory opens a different
store, not the old history. The database and its storage identities are not renamed
by the `durable-nanobot` command/unit rename.

## Logs

The shipped units already send stdout and stderr to journald. Inspect the gateway
without starting another process:

```sh
journalctl --user -u durable-nanobot.service --since "1 hour ago"
journalctl --user -u durable-nanobot.service -f
```

The gateway also emits content-free structured lifecycle/timing records with the
`durable-nanobot journal:` prefix: native submission/task/model/tool spans plus
host preparation/queue/delivery boundaries, ten-second slow-work warnings, and
safe transient-failure and typing-recovery visibility. See
[OBSERVABILITY.md](OBSERVABILITY.md) for correlation, coverage and privacy limits.

Durable report callbacks and gateway/CLI failure boundaries emit bounded
`durable-nanobot diagnostic:` records: stages, safe error classes/codes, cause
chains, code-relative stack locations, task IDs, report reasons/bounded restart
counts where available, and a fingerprint.
No raw request payloads, credentials or transcript text are logged. Only known
safe Durable invariant messages are included verbatim; other error messages stay
private. A later shutdown failure does not replace the primary exception returned
to callers. Normal shutdown attempts every resource and returns its first failure;
subsequent failures are reported separately. Reporting is best-effort: an unavailable
stderr cannot block cleanup, and an unsuccessful output attempt does not suppress
a later attempt.

No verbosity switch, extra log file, retention change, systemd override or new
retry loop is needed for these records. Journald retention remains host-managed;
this project does not promise a fixed number of days or survival of a host reboot.
Systemd still records exits, signals and restart-limit failures independently of
the application. These diagnostics require a gateway restart to load new code.

## Primary instance

The default launch path is fixed and independent of the process working
directory:

```text
~/.durable-nanobot/config.json
```

Keep the primary instance's persistent layout outside the checkout:

```text
~/.durable-nanobot/
  config.json
  data/                # Durable SQLite store, derived indexes and private socket
  workspace/           # Markdown memory, skills and attachments
```

Place the example configuration at that primary config path with
`"workspace": "./workspace"` and `"dataDir": "./data"`. Relative paths resolve
from the config file, so the primary store is `~/.durable-nanobot/data/nanobot.sqlite`,
independent of the checkout or working directory. This layout is explicit config,
not an implicit data-directory fallback. JSON paths do not expand `~`; use these
relative paths or an absolute path. Secondary configs should similarly use their
own `./data` and `./workspace` under their instance directory. Preserve an existing
store's configured location until a deliberate stopped-store migration is approved.

`durable-nanobot gateway` without `--config` reads exactly that file. `durable-nanobot agent`
without `--config`, `durable-nanobot recovery` without `--config` and `durable-nanobot cron`
without `--config` use it too, and the
historical `durable-nanobot --config <path>` still attaches an agent with the explicit
path. There is no discovery, merge, search, auto-generation, migration or
implicit runtime activation: create the file and its workspace/data directories
yourself. A missing default file fails with a fixed message that names no
filesystem path or environment value.

Set `HOME` normally for the user manager; the unit's `%h` is the same home. The
gateway's configured paths still resolve relative to the config file's directory,
as documented in [setup](./SETUP.md).

After editing the copy:

```sh
systemctl --user daemon-reload
systemctl --user enable --now durable-nanobot.service
```

Those commands are the operator's; they are not part of any offline check here.

## Secondary instances

The template maps the instance name into one fixed directory pattern:

```text
~/.durable-nanobot/instances/i-<instance>/config.json
```

`<instance>` is a systemd unit instance name, not a filesystem path. The literal
`i-` prefix keeps every selected directory a real child of the fixed
`instances/` directory, so even a dot-like name such as `..` selects `i-..`, not
a parent path. systemd also validates and normalizes unit names before starting
a template instance: a name that is not a valid instance name, including any
name containing `/`, is refused. The units assume a systemd release with
`Type=exec` (systemd 230 or newer); use `Type=simple` on an older release if
needed. Create the directory and `config.json` yourself, then use the explicit
config only on that instance's command line (the unit already does):

```sh
systemctl --user daemon-reload
systemctl --user start 'durable-nanobot@work.service'
journalctl --user -u 'durable-nanobot@work.service'
```

Use a separate `dataDir` and `workspace` in every instance config. The store
validates that `dataDir` is disjoint from the workspace and extra allowed roots;
two gateways that point at the same database are refused by the live-owner lock,
and each gateway derives its own private socket from its own `dataDir`. Memory
and attachments stay separate by default because they live under the configured
workspace and media directory; this is not enforced by a global instance
registry.

Two instances are independent processes, not a multi-tenant boundary. They run
as the same operating-system user, so file permissions do not isolate them from
each other. Distinct Telegram pollers require distinct bot tokens. Sharing a
provider key shares its quota; it is not a security boundary.

## Environment file

Each template names its private environment file beside its instance config.
`EnvironmentFile=-%h/...` is optional to systemd: the leading `-` ignores a
missing file, but the gateway still refuses missing configured credentials.
Keep the runtime directory private (`0700`) and the environment file private
(`0600`), outside this repository. Use systemd environment-file syntax, not
shell commands; never commit secret values.

systemd reads that file when it launches the gateway and supplies its values in
the process environment. The config stores **variable names**, not values:

```json
{
  "credentials": { "opencode_go": "OPENCODE_GO_API_KEY" },
  "telegram": { "tokenEnv": "DURABLE_TELEGRAM_TOKEN", "allowFrom": ["123456789"] },
  "web": { "search": { "keyEnv": "BRAVE_SEARCH_API_KEY" }, "fetch": true }
}
```

The existing provider, Telegram and web paths resolve those names from the gateway
process environment; MCP has the same explicit environment-name convention.
`credentials` names one environment variable for a provider spelling; it is not a
closed provider list. An explicit reference pins that variable and fails closed
when it is unset or blank, without falling back to native ambient variables; with
no reference, native providers use their documented variables. A provider
credential stored by `durable-nanobot login` is used first. There is no blanket `${VAR}` substitution in JSON and no automatic environment-file
loader in the CLI. A manually launched gateway must inherit its environment by
another explicit launch mechanism; an attaching agent uses the running gateway
and does not need provider credentials locally. The gateway's shell tools keep
their separate filtered environment and do not inherit all gateway credentials.

`durable-nanobot login` and `logout` are explicit terminal commands. They load and
validate the same configuration as the gateway (workspace and `dataDir` boundary
included), prepare the canonical private `dataDir`, write Durable's own credential
store there, and never open the gateway, the Durable store or contact a model. A
failed authentication command prints one fixed diagnostic and no credential value. The gateway
never logs in automatically and never reads Pi's credential store. A stored OAuth
credential is refreshed natively when a request needs it, under the store lock.

Use a service-manager restart after changing the environment file; the owner
`/restart` preserves the existing process environment and cannot reload it.
Use a distinct Telegram token while Python's bot is still running; two pollers
must not share a token. The shipped units contain no credential values. Startup
diagnostics suppress configuration/environment values and underlying errors;
journal output also contains systemd's own unit messages.

## Stop, restart and journal

- `KillSignal=SIGTERM` reaches the same graceful gateway shutdown as Ctrl-C:
  the local socket closes, attached CLIs detach, accepted Durable work and queued
  input stay in the store, and the store lock is released. Reopening the same
  config resumes the transcript and queued work.
- `KillMode=mixed` sends SIGTERM to the main process only. If
  `TimeoutStopSec=45` expires, systemd sends SIGKILL to the remaining service
  processes, such as an MCP stdio server or a shell child. Native workers are
  Durable tasks inside the gateway process, not separate service processes.
- `Restart=on-failure` restarts after a crash or non-zero exit, with
  `RestartSec=5s` and `StartLimitIntervalSec=300`/`StartLimitBurst=5` limiting a
  crash loop. A clean stop is not restarted.
- The authenticated Telegram owner or attached CLI `/restart` control uses POSIX `process.execve` to
  replace the process image with the same executable, argv and environment. It
  keeps the same PID and service process, so systemd does not see a second
  gateway; the old process completes its normal teardown first.
- `journalctl --user -u durable-nanobot.service` (or the instance unit) shows output.
  Startup failures use the fixed, value-free diagnostics described in
  [interactive CLI](./CLI.md#startup-diagnostics).

## Login lifetime and lingering

A user service normally runs while that user's systemd user manager is active,
which is tied to the user's login session. On a machine that should keep the
gateway running without an interactive login, the operator may choose to enable
lingering for that user. That is a host setting, not a repository feature; it was
not enabled or tested here. Enabling it is optional and outside this project's
installation scope.

## What is verified

Offline checks use static `systemd-analyze verify` plus temporary synthetic
source-mode processes: graceful SIGTERM, store-lock release/reopen, duplicate-owner
refusal and separate instances. They do not install or activate services or send
provider requests. A disposable probe also changes TypeScript without building,
then verifies native execve restart loads the change with the same PID and no
persistent compiler child.

### Owner-authorized test deployment — 2026-10-31

The linked source command and primary user service were explicitly installed,
enabled and started for the separate test bot, with private state outside the
checkout. Its identity was verified distinct from Python's bot; the Python command,
unit and running process were left unchanged. Read-only CLI status succeeded, and
live owner restart reopened the endpoint with the same PID and no systemd crash
restart. The owner then confirmed sending a Telegram message and receiving a reply.

This establishes the basic source-launch/service/Telegram/model path, not migrated
personal memory, worker/MCP/media behavior, classifier quality or live OAuth. Existing
lingering was observed enabled; logout/reboot survival was not separately tested.
