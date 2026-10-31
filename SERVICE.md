# Run the gateway as a user service

This page describes the shipped, operator-installed **user** systemd units for a
foreground gateway. The repository does not install, enable, start or reload
services, does not enable lingering, and does not change system settings. The
commands below are operator steps; none were run by this project's checks.

The gateway itself remains an ordinary foreground process. These units do not
add a daemon, supervisor, background shell, restart loop or npm-start wrapper:
systemd runs one `node dist/cli.js gateway` process per instance and stops it with
the existing SIGTERM/SIGINT teardown.

## Units

| File | Use |
| --- | --- |
| [`systemd/nanobot.service`](systemd/nanobot.service) | The primary instance uses the default config `~/.durable-nanobot/config.json`. |
| [`systemd/nanobot@.service`](systemd/nanobot@.service) | One named secondary instance uses `~/.durable-nanobot/instances/i-<name>/config.json`. |

Both are user units. Copy or symlink them into the user unit directory, for
example `~/.config/systemd/user/`, after editing the launch paths.

Each unit has two placeholders that must become absolute paths on the installed
machine:

- `/usr/bin/node` — the Node >= 22.19 executable. Use the absolute path from
  `command -v node`; do not rely on a shell `PATH` or a global `nanobot` command.
- `/opt/durable-nanobot` — this checkout. The package is private and installs no
  `nanobot` executable, so the unit runs `<checkout>/dist/cli.js` through Node
  after `npm ci` and `npm run build`.

Because the unit file cannot expand shell variables in `ExecStart`, those two
paths are edited directly in the copy. Everything else uses systemd specifiers:
`%h` is the user's home and `%i` is the unit instance name.

## Primary instance

The default launch path is fixed and independent of the process working
directory:

```text
~/.durable-nanobot/config.json
```

`nanobot gateway` without `--config` reads exactly that file. `nanobot agent`
without `--config` and `nanobot recovery` without `--config` use it too, and the
historical `nanobot --config <path>` still attaches an agent with the explicit
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
systemctl --user enable --now nanobot.service
```

Those commands are the operator's; they are not part of any offline check here.

## Secondary instances

The template maps the instance name into one fixed directory pattern:

```text
~/.durable-nanobot/instances/i-<instance>/config.json
~/.durable-nanobot/instances/i-<instance>.env      # optional, ignored when absent
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
systemctl --user start 'nanobot@work.service'
journalctl --user -u 'nanobot@work.service'
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

`EnvironmentFile=-%h/...` is optional: the leading `-` makes a missing file
harmless. Use it for per-instance environment such as the variable names the
config's `credentials` and `telegram.tokenEnv` refer to. Put each value on its
own line, keep the file private (for example mode `0600`) and outside this
repository, and never commit secret values. The shipped units contain no
credentials. The gateway prints fixed startup diagnostics and does not echo
configuration values, environment values or paths; journal output is the
process's standard output and error, plus systemd's own unit messages.

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
- The authenticated owner `/restart` control uses POSIX `process.execve` to
  replace the process image with the same executable, argv and environment. It
  keeps the same PID and service process, so systemd does not see a second
  gateway; the old process completes its normal teardown first.
- `journalctl --user -u nanobot.service` (or the instance unit) shows output.
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

The unit files are static examples. `systemd-analyze verify` accepts them and an
edited copy that points at the actual Node executable, checkout, and instance
config path. That is a static file check only: no service was installed, enabled
or started, no user manager was reloaded, and no lingering login lifetime was
tested in this environment. The graceful gateway SIGTERM shutdown, store-lock
release and reopen, duplicate-owner refusal and two independent instances are
covered by bounded offline process checks with synthetic configuration; see the
repository's behavior tests. Live provider, Telegram polling and real systemd
operation remain unverified.
