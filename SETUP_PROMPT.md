# Setup prompt for a coding agent

Copy the prompt below into your coding agent (Claude Code, Codex, T3 Code, Pi,
Cursor, …) running inside this repository. It walks you through installing and
setting up Pedellus while keeping your secrets out of the chat.

```text
You are helping me install and set up Pedellus, a personal AI assistant gateway,
from this repository checkout. Read GETTING_STARTED.md first, then SETUP.md,
SERVICE.md and APP.md as needed. Go step by step, explain briefly what each step
does, and wait for me when a step needs my input.

Hard rules, no exceptions:
- Never ask me to paste an API key, bot token, OAuth code, push private key or
  any other secret into this chat. When a secret is needed, tell me which command
  to run in my own terminal or which file to edit myself.
- Never write a secret value into ~/.pedellus/config.json or any file in this
  repository. The config only holds environment-variable NAMES (credentials,
  telegram.tokenEnv, discord.tokenEnv, web.search.keyEnv, app.push.privateKeyEnv).
- Never read, print, copy or edit anything under ~/.pedellus/data/ (it holds the
  private credential store and the database), and never read the service's
  environment file (~/.pedellus/secrets.env). You may tell me how to create it.
- Do not install a `nanobot` command or alias; the executable is `pedellus`.
- Do not run `sudo`, enable services or change system settings without asking
  me first and showing the exact command.

Steps:
1. Check the environment and report what you find:
   - OS: Linux, or Windows with WSL2 (`uname -a`, `cat /proc/version`). Native
     Windows is not supported; if I am not in WSL2, help me install it first.
   - Node: `node --version` must be >= 22.19.0. If not, recommend nvm
     (`nvm install 22`) or NodeSource and help me install it.
   - Location: on WSL2, this checkout and ~/.pedellus/ must be on the Linux
     filesystem (under ~), never under /mnt/c/ or any /mnt/<drive>/. If the
     checkout is under /mnt/, stop and help me re-clone it under ~. Refuse to
     create ~/.pedellus/ on a Windows drive.
2. Install dependencies: `npm ci`. Offer `npm link` so `pedellus` is on my PATH;
   if it fails with a permission error, use `node bin/pedellus.mjs` instead.
3. Ask me which model provider I want (and whether I have an API key or a
   subscription with OAuth login), and which channels I want: CLI only,
   Telegram, Discord, and/or the installable web app (PWA) over Tailscale.
4. Ask me to run `pedellus init` myself, in my own terminal, not through you.
   It handles provider login (the key or OAuth sign-in goes into the private
   store, not the config), the model preset, the starter workspace and an
   optional one-minute setup interview. Wait until I say it finished. If `init`
   is not available in this checkout, fall back to SETUP.md: copy
   config.example.json to ~/.pedellus/config.json, adapt workspace, dataDir and
   modelPresets with me, create the workspace files, and have me run
   `pedellus login` myself.
5. For each channel I chose, edit ~/.pedellus/config.json cleanly (valid JSON,
   no secrets, keep existing keys):
   - telegram: tokenEnv plus allowFrom with my numeric Telegram user ID as a
     string. Explain how to get the token from @BotFather and my ID.
   - discord: tokenEnv, allowFrom, optional allowChannels; remind me to enable
     the Message Content intent.
   - app: run `npm run install:pwa && npm run build:pwa`, then set
     {"port": 43190, "staticRoot": "<absolute checkout path>/pwa/app/dist"}.
     Explain `tailscale serve --bg 43190` (on WSL2, run Tailscale on Windows,
     not inside WSL as well), `pedellus app pair --label <name>`, and optional
     `pedellus app push-keys`.
   - media (attachments/voice) and web (Brave search + fetch): only if I want
     them; follow SETUP.md and WEB.md.
   Then tell me exactly which environment variables to set and where (export in
   the gateway's terminal, or lines in ~/.pedellus/secrets.env with chmod 600
   when using the service), without ever seeing the values.
6. If I want it running in the background: copy systemd/pedellus.service to
   ~/.config/systemd/user/, replacing /usr/bin/node with the real output of
   `command -v node` and /opt/pedellus with this checkout's absolute path
   (`pwd`). On WSL2, check that systemd is enabled (/etc/wsl.conf
   `[boot] systemd=true`) and remind me that WSL stops when Windows sleeps or
   the last terminal closes. Show me the systemctl --user commands and let me
   run them.
7. Verify: run `pedellus doctor` and fix what it reports. Then have me start
   `pedellus gateway` in one terminal and `pedellus agent` in another (or the
   service plus my chosen channel) and confirm a reply arrives. Use
   `pedellus --help` and the docs rather than guessing flags.
8. Finish with a short summary: what is configured, which environment variables
   I still need to set, how to start and stop it, and where the logs are.
```
