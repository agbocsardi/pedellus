# Set up the assistant

A short, CLI-first walkthrough on a synthetic workspace: build, configure memory,
skills and tool authority in the config, then add Telegram as a separate step.
The config owns persistent settings and policy; the CLI and Telegram are utility
surfaces over it. Changing the config takes effect on restart — there is no hot
reload, and no command is a prerequisite for enabling a capability.

This does not claim live-model success; what you can verify offline is in
[Current status and checks](./README.md#current-status-and-checks).

## 1. Build

Node >= 22.19 and the pinned dependencies:

```sh
npm ci
npm run build
```

## 2. Create a workspace

Config paths resolve relative to the **config file's directory**, not the shell's
working directory. Keep `dataDir` outside `workspace`: the gateway rejects a data
directory that resolves inside the workspace or an extra allowed root.

From the checkout, make a disposable sample that matches the shipped example:

```sh
mkdir -p demo/workspace/memory demo/workspace/skills
cp config.example.json demo/config.json
cp -R skills/memory skills/skill-creator skills/cron demo/workspace/skills/
```

`workspace/skills` is the only skill root the example reads; `github` is not
copied because it needs a shell and `gh`, and builtin skills are not enabled
here. Then create the fixed bootstrap file and the memory file the config names:

```sh
cat > demo/workspace/AGENTS.md <<'EOF'
You are a local assistant with a Markdown workspace.
Keep durable project facts in memory/ and read the matching topic before relying on it.
EOF
cat > demo/workspace/memory/MEMORY.md <<'EOF'
# Memory

Durable facts live here. Topic files under memory/ are listed in the manifest and
read on demand.
EOF
```

There is no default workspace, memory file, or skill root: every path is either
the config's `workspace` or an explicit file under it. `memory/MEMORY.md` is the
explicitly selected bootstrap memory loaded on every turn; durable topic facts
belong in `memory/topics/*.md`, which the manifest lists and the agent reads on
demand. Markdown is the memory and skill source of truth; the conversation
transcript and runtime state live in Durable's SQLite database under `dataDir`.

## 3. Configure

The shipped [`config.example.json`](./config.example.json) is the starting point:

| Key | Meaning here |
| --- | --- |
| `workspace` / `dataDir` | Workspace root and private state directory, both relative to the config file. |
| `modelPresets` / `modelPreset` | Named provider/model/thinking choices and the configured default (`deep` in the example). Each pair and thinking level must exist in the pinned catalog ([providers](./PROVIDERS.md)). Local `/model fast` temporarily switches; `/model default` or restart returns to the configured preset. |
| `workspaceContext.memoryFiles` | `["memory/MEMORY.md"]` is loaded into every turn; a missing named file fails closed. |
| `workspaceContext.memoryManifest` | Lists the other `memory/**/*.md` topics recursively for on-demand `read`; their bodies stay out of the prompt. |
| `workspaceContext.skills` | Its presence opts into workspace skill discovery; `disabledSkills` can hide names. |
| `toolAllowlist` | Config authority: these coding tools are enabled for authenticated mapped chats. `[]` or absent disables them. |
| `cron` | Installs the model-facing `cron` tool; `timeZone: "UTC"` interprets calendar expressions without an explicit zone. |
| `episodeSummary` | Closed episodes use the conversation's current model, or a named override such as `"preset": "fast"`. This costs provider calls; set `enabled: false` to turn it off. |
| `credentials` | Environment-variable *names* only. No secret value belongs in this file. |

Export the key named by `credentials.openai` (or whichever alias you allow):

```sh
export OPENAI_API_KEY=...
```

Configured tools apply to validated mapped ordinary chats — not to arbitrary
internal or forked conversations — and still run over the guarded workspace
environment. Scheduled runs inherit a bounded subset from an authenticated
channel origin, so they never exceed what that origin had; narrowing
`toolAllowlist` and restarting also narrows those runs.

## 4. First run

```sh
node dist/cli.js --config demo/config.json
```

Without a `telegram` section the CLI opens the local `cli:default` conversation
and prints a prompt. No grant step exists: `toolAllowlist` in the config is the
tool authority. `/tools` is an optional read-only diagnostic of it. Ask for one
round trip:

```text
Load the memory skill, then write the fact "the demo workspace is for setup checks"
to memory/topics/setup.md with a one-line description and read it back.
```

The `skill` tool is context, not authority; the write and read use the configured
`write` and `read` tools. `/model` lists the named choices; switching presets never
changes tool access. Existing direct `model`/`allowedModels` configs still work,
but retain their legacy persisted selections; do not mix those fields with presets.
See [model presets](./MODELS.md#named-presets).

## 5. Refresh, reset, restart

A conversation captures its workspace context and skill inventory when it is
created or when the gateway reopens. Editing `AGENTS.md`, `MEMORY.md`, or a
`SKILL.md` does nothing to the current conversation until you re-capture it:

```text
/refresh
```

`/refresh` re-reads bootstrap files, selected memory, the manifest and skills
together in the same conversation. `/new` is different: it starts a fresh model
context with no handoff and does **not** re-read files. A gateway restart applies
config edits and re-reads the files, because startup reloads the config selection
for every persisted session mapping.

Restart (Ctrl-D or Ctrl-C, then the same command) and retrieve what happened:

```text
/history
/search --scope all setup
/episodes
```

Earlier entries stay stored; summaries are an aid, and `/entry` or `/episode`
opens the original entries.

## 6. Telegram continuation

Telegram is an explicit second configuration step, not part of the CLI-first
example. Add `telegram` as a top-level key beside the existing ones in
`demo/config.json`:

```json
"telegram": {
  "tokenEnv": "TELEGRAM_BOT_TOKEN",
  "allowFrom": ["123456789"],
  "pollTimeoutSeconds": 30
}
```

- `tokenEnv` is an environment-variable name; export the token, never paste it
  into the file.
- `allowFrom` is a non-empty list of decimal Telegram user IDs, written as JSON
  strings (for example `"123456789"`, not unquoted numbers), allowed to talk to
  the bot; only private chats reach the assistant.
- **Every user in `allowFrom` shares the configured workspace and tool
  authority.** Listing a user is the authorization; there is no per-chat
  permission step, so allowlist only people you would let use those tools.
- Adding the section switches the same gateway to Telegram polling instead of the
  local prompt. CLI and Telegram are alternative modes of one process, not
  simultaneous clients; each chat has its own conversation, context snapshot and
  persisted model choice, but the same workspace and configured tools.

In an allowed private chat:

```text
/help
Load the memory skill and remember that the demo bot is for setup checks.
Remind me in ten minutes to stretch, then save that reminder in memory/topics/demo.md.
```

For a relative one-shot reminder the agent uses `after_seconds` (600 for ten
minutes). The gateway fixes the deadline from its own clock once, so the model
needs no clock tool and retries never push it back. For an exact instant, use an
ISO timestamp with `Z` or a UTC offset; naive local timestamps remain rejected.

`/new`, `/abort` and `/help` are the channel controls. Context refresh in
Telegram is a gateway restart; there is no Telegram refresh command, and `/new`
does not re-read files. Without a `media` section the adapter is text-only: an
attachment gets a fixed unsupported-attachment notice (caption text is still
passed as input). With `media`, photos, voice/audio and documents are stored under
the workspace and the turn is told exactly what arrived—see
[8. Optional: attachments and voice](#8-optional-attachments-and-voice). Groups or
other bots never reach the assistant.

Reminders are ordinary agent scheduling through the configured `cron` tool. A
default isolated run answers in its own background conversation; an `origin`-mode
job answers inside the original conversation. In either mode a normal settlement is
queued for the originating Telegram private chat: the committed answer, or a fixed
sanitized notice naming the job and occurrence when the run failed or answered with
nothing. Cancelled, superseded and missing-job runs are not pushed; ask the agent to
`list` cron jobs to inspect a failure and read the reported delivery fault. See
[cron](./CRON.md).

## 7. Optional: shell, sandbox, builtin skills

- `bash`: add `"bash"` to `toolAllowlist` and restart. It runs on the real
  workspace over a guarded environment; add `toolTimeoutSeconds` (integer seconds)
  when you want a different default timeout. Configure it only for users and
  channels you trust with a shell. See [coding tools](./TOOLS.md).
- `toolSandbox`: set `"toolSandbox": "bwrap"` with an absolute `bwrapPath` to run
  shell commands in a direct-workspace Bubblewrap view; it fails closed when
  unavailable. It wraps the shell only, and it is accidental-damage protection,
  not hostile-tenant isolation. See [direct Bubblewrap](./DIRECT_BWRAP.md).
- Builtin skills: `workspaceContext.skills.builtinSkillsRoot` needs an absolute
  path, so copying curated skills into `workspace/skills` is the portable route.
  See [curated builtin skills](./SKILLS_BUILTIN.md).
- Memory topics, manifest bounds and skill frontmatter are described in
  [memory context](./MEMORY_CONTEXT.md) and [skills context](./SKILLS_CONTEXT.md);
  local utility commands are in [the CLI](./CLI.md).

## 8. Optional: attachments and voice

Attachment ingress is opt-in, shared by channels and currently wired into the
Telegram adapter. Add a top-level `media` key beside the existing ones:

```json
"media": {
  "directory": "media",
  "transcription": { "language": "en", "maxDurationSeconds": 120 }
}
```

- `directory` is workspace-relative and defaults to `media`. Originals are stored
  there byte-for-byte, so the ordinary configured coding tools (`read`, `bash`,
  and so on) are how the agent opens them. Storing a file grants no tool
  authority. Nothing is written to `dataDir` or outside the workspace.
- `transcription.enabled` (default `true`) turns local speech recognition on or
  off; `language` is an optional hint and `maxDurationSeconds` (default `120`)
  refuses longer audio. There is no cloud speech provider and no API key.
- Photos arrive as native image content plus a workspace-relative locator.
  Documents are stored unread: no text extraction, OCR, PDF/Office conversion or
  dependency is involved, so reading one is the agent's job with the configured
  tools. Video and stickers get an explicit unsupported notice.
- Bounds: 20 MB per file (Telegram's ordinary Bot API `getFile` limit), a 60s
  download timeout, two concurrent attachment jobs, a 180s transcription timeout
  and a 120s audio-duration limit by default.

Local speech needs a one-time provisioning step; the runtime never installs or
downloads anything while handling a message. The helper is
`scripts/local-transcribe.py`, a PEP 723 script pinned to `faster-whisper==1.1.1`
with the model/device/compute type fixed to `small`/`cpu`/`int8`. Provision it
explicitly (this is the only step that may use the network):

```bash
# One-time provisioning: creates the helper environment, downloads the model and
# transcribes once. The adapter never passes this flag.
uv run --script scripts/local-transcribe.py sample.oga --max-duration-seconds 5 --allow-model-download
```

The adapter then runs the helper as `uv run --script --offline …` with Hugging
Face hub offline mode forced. If the environment or model is not cached,
transcription fails and says so truthfully: the stored audio is still on disk,
the caption is preserved, and the turn is never told that the speech was
understood. Use `--language` in the helper call when you want to check a
specific language by hand.
