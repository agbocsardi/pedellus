# Getting started with Pedellus

Pedellus is a personal AI assistant that runs on your own machine. This page gets
you from zero to a first chat in about five minutes, then adds a phone channel.
Every step is something you run yourself; nothing starts in the background unless
you set it up.

Want a coding agent to walk you through it instead? Use the
[setup prompt](./SETUP_PROMPT.md).

## Prerequisites

- **Linux, or Windows with WSL2.** Native Windows is not supported yet: Pedellus
  relies on Linux-only pieces such as `/proc/self/fd`, Unix domain sockets for the
  local CLI, and POSIX `execve` for `/restart`. On Windows, install WSL2 with
  Ubuntu (`wsl --install` in an administrator PowerShell) and do everything below
  inside the Ubuntu terminal. macOS is untested.
- **Node.js >= 22.19.0.** Check with `node --version`. Ubuntu's own `nodejs`
  package (including the one in WSL) is usually older. Two easy options:
  - [nvm](https://github.com/nvm-sh/nvm): install it, open a new terminal, then
    `nvm install 22`.
  - [NodeSource](https://github.com/nodesource/distributions): its Node 22
    repository for Ubuntu/Debian, then `sudo apt-get install -y nodejs`.
- `git`, and an account with at least one model provider (for example an OpenAI,
  Anthropic or OpenRouter API key, or a subscription that supports OAuth login).

> [!IMPORTANT]
> **WSL2 essentials**
>
> - **Stay on the Linux filesystem.** Clone the repo somewhere under your Linux
>   home (`~`) and keep `~/.pedellus/` there too. Avoid putting either under
>   `/mnt/c/...`: the Windows drive (DrvFs) can break file permissions (Pedellus
>   keeps its data directory `0700`), Unix sockets, `O_NOFOLLOW` checks and
>   SQLite's WAL journal, and is much slower.
> - **Background running.** To use the systemd service below, enable systemd in
>   WSL: add this to `/etc/wsl.conf` (with `sudo`), then run `wsl --shutdown` in
>   PowerShell and reopen Ubuntu.
>
>   ```ini
>   [boot]
>   systemd=true
>   ```
>
>   Even with systemd, Windows sleep makes the gateway unreachable, and WSL may
>   stop the distro shortly after you close the last WSL terminal. Keep a WSL
>   terminal open while you want Pedellus reachable. For a 24/7 assistant, run it
>   on an always-on Linux box instead (a small VPS, a Raspberry Pi, a home server).
> - **Tailscale and the web app.** On the Windows desktop itself you can open the
>   app at `http://localhost:<port>`, because WSL2 forwards localhost to Windows.
>   A phone, and Web Push notifications, need HTTPS, which `tailscale serve`
>   provides. Avoid running Tailscale inside WSL2 at the same time as Tailscale
>   on Windows (nested tunneling can break routing). Instead run Tailscale
>   **on Windows** and point it at the forwarded port from an administrator
>   PowerShell (`tailscale serve --bg <port>`), or run Pedellus on a Linux host
>   that has its own Tailscale. This WSL2 path has not been exercised end to end
>   yet; if localhost forwarding does not reach the port on Windows 11 22H2 or
>   newer, try WSL's mirrored networking mode.

## Quickstart: first chat in five minutes

**1. Get the code and install dependencies**

Clone this repository into `~/pedellus` (substitute your clone URL), then
install dependencies:

```sh
cd ~/pedellus
npm ci
npm link    # optional: puts `pedellus` on your PATH
```

If `npm link` fails with a permission error (common with a system-wide Node),
skip it and use `node bin/pedellus.mjs` wherever this page says `pedellus`, or
switch to nvm. Never link a `nanobot` command: the executable is `pedellus`.

**2. Set up your assistant**

```sh
pedellus init
```

`init` walks you through:

- **Provider login**: pick a provider and sign in with OAuth (for example Sign in
  with ChatGPT) or paste an API key. The key goes into Pedellus's private
  credential store under `~/.pedellus/data/`, never into `config.json`.
- **Model preset**: a fast and a deeper model for that provider.
- **Starter workspace**: `~/.pedellus/config.json`, `~/.pedellus/workspace/`
  with Markdown memory and skills, and the private `~/.pedellus/data/` store.
- **A one-minute setup interview** (skippable): a few questions so the assistant
  knows your name, preferences and what you want help with. Skip it and Pedellus
  introduces itself and asks on your first chat instead.

Prefer to write the config by hand? Follow [SETUP.md](./SETUP.md) from the
shipped [`config.example.json`](../config.example.json), and store a provider
credential with `pedellus login`.

**3. Check everything**

```sh
pedellus doctor
```

`doctor` checks Node, the config, the workspace and data directories, and your
provider credentials, and says what to fix.

**4. Start it and say hello**

Terminal 1, the gateway (the one process that owns everything):

```sh
pedellus gateway
```

Terminal 2, a chat attached to it:

```sh
pedellus agent
```

Type a message. `/help` lists the commands; `/new` starts a fresh context;
Ctrl-D detaches this terminal while the gateway keeps running. Without
`--config`, every command uses `~/.pedellus/config.json`.

## Adding channels

Each channel is one block in `~/.pedellus/config.json`. Restart the gateway after
editing. Secrets never go into the config: it names an **environment variable**,
and the gateway reads the value from its environment.

When you run the gateway in a terminal, `export` the variable first. When it runs
as the systemd service (below), put the values in the private `EnvironmentFile`
configured in your systemd unit (`chmod 600`, one `NAME=value` per line). Never
commit that file or paste it into a chat.

### Telegram (easiest on your phone)

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token.
2. Find your numeric Telegram user ID (for example by messaging a user-info bot
   such as **@userinfobot**).
3. Add to the config:

   ```json
   "telegram": {
     "tokenEnv": "TELEGRAM_BOT_TOKEN",
     "allowFrom": ["123456789"]
   }
   ```

   `allowFrom` holds decimal user IDs as JSON strings. Everyone listed shares your
   workspace and tool access, so list only yourself or people you fully trust.
4. Provide the token (`export TELEGRAM_BOT_TOKEN=...` or in your unit's
   `EnvironmentFile`), restart the gateway and send your bot a private message.

Only private chats from listed users reach the assistant. One token can be
polled by only one bot process. Details: [TELEGRAM.md](./TELEGRAM.md).

### Discord

1. Create an application and bot in the Discord Developer Portal, copy the bot
   token, and enable the **Message Content** privileged intent.
2. Invite the bot with the `bot` and `applications.commands` scopes.
3. Add to the config (Discord IDs, as strings):

   ```json
   "discord": {
     "tokenEnv": "DISCORD_BOT_TOKEN",
     "allowFrom": ["111111111111111111"],
     "allowChannels": ["222222222222222222"]
   }
   ```

   `allowFrom` (required) lists the users allowed to talk to it; `allowChannels`
   limits which server channels it answers in. Mention the bot in a server
   channel; direct messages work too. Details: [DISCORD.md](./DISCORD.md).

### Installable web app (PWA)

The web app gives you threads, files, voice notes and push notifications on
your phone and desktop, over your private tailnet.

1. Build it once, from the checkout (and again after each update):

   ```sh
   npm run install:pwa && npm run build:pwa
   ```

2. Add to the config, with the absolute path of your checkout (`pwd` prints it):

   ```json
   "app": { "port": 43190, "staticRoot": "<checkout>/pwa/app/dist" }
   ```

   The app listens on `127.0.0.1` only.
3. Restart the gateway, then publish it on your tailnet with HTTPS (on WSL2, run
   this on Windows; see the WSL2 essentials above):

   ```sh
   tailscale serve --bg 43190
   ```

   Never use Tailscale Funnel or port forwarding: the app is for your tailnet only.
4. Pair a device:
   - On **iOS**, open the `https://….ts.net` address in Safari, tap Share →
     **"Add to Home Screen"**, and open the installed app from the Home Screen
     *first* (Safari and the Home Screen app have separate cookie jars).
   - On the host, run `pedellus app pair` (unlabeled, so the app's device label
     is accepted — or pass `--label <name>` and enter the exact same label in
     the app). Enter the 8-character code (valid ten minutes).
5. Optional push notifications: `pedellus app push-keys` prints a key pair once.
   Put the private key in the gateway's environment (for example
   `PEDELLUS_APP_PUSH_PRIVATE_KEY` in your unit's `EnvironmentFile`) and the
   public key in the config as shown in [APP.md](./APP.md#setup).

Supervised iPhone/iPad pairing over Tailscale has been exercised on Linux; WSL2
deployment, Web Push delivery and kill/reopen replay remain unverified. See
[APP.md](./APP.md) for status, device management (`pedellus app devices`,
`pedellus app revoke`) and limits.

## Optional add-ons

- **Run it as a service.** [`systemd/pedellus.service`](../systemd/pedellus.service)
  keeps the gateway running and restarts it after a crash. Copy it to
  `~/.config/systemd/user/`, replace `/usr/bin/node` with the output of
  `command -v node` and `/opt/pedellus` with your checkout path, then
  `systemctl --user daemon-reload && systemctl --user enable --now pedellus.service`.
  Logs: `journalctl --user -u pedellus.service -f`. With nvm, update the Node
  path after upgrading Node. To keep it running without an open login session,
  `loginctl enable-linger "$USER"` is an optional host setting. See
  [SERVICE.md](./SERVICE.md).
- **Web search and page reading.** Add
  `"web": { "search": { "keyEnv": "BRAVE_SEARCH_API_KEY" }, "fetch": true }` and
  provide a Brave Search API key. See [WEB.md](./WEB.md).
- **MCP servers.** Connect tools such as a calendar or docs server with an `mcp`
  block; HTTP servers can sign in with OAuth from a chat. See [MCP.md](./MCP.md).
- **Coding tools and shell.** `toolAllowlist` turns on `read`, `write`, `edit`
  and, only if you want it, `bash`. See [TOOLS.md](./TOOLS.md).
- **Attachments and local voice transcription.** Add a `media` block. Voice notes
  are transcribed locally, never by a cloud service, with one of: the default
  `uv` + faster-whisper helper, the Python-free `whisper-cli` (whisper.cpp), or
  `hex`. Each needs a one-time provisioning step; see
  [SETUP.md](./SETUP.md#8-optional-attachments-and-voice).
- **Reminders and background workers.** `cron` is on in the example config; ask
  "remind me in ten minutes to stretch". Workers are off until you enable them;
  see [CRON.md](./CRON.md) and [WORKERS.md](./WORKERS.md).

## When something goes wrong

- Run `pedellus doctor` first.
- `pedellus agent` says no gateway answers: start `pedellus gateway` with the same
  config in another terminal.
- Errors are short on purpose and never print secrets or paths; the gateway's
  terminal (or `journalctl --user -u pedellus.service`) has the matching
  diagnostic. See [CLI.md](./CLI.md#startup-diagnostics).
- Never run two gateways on the same `~/.pedellus/`; the second one refuses to
  start.
