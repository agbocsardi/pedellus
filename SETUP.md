# Set up the assistant

A short, CLI-first walkthrough on a synthetic workspace: install dependencies, configure memory,
skills and tool authority in the config, then add Telegram as a separate step.
The config owns persistent settings and policy; the CLI and Telegram are utility
surfaces over it. Changing the config takes effect on restart — there is no hot
reload, and no command is a prerequisite for enabling a capability.

This does not claim live-model success; what you can verify offline is in
[Current status and checks](./README.md#current-status-and-checks).

## 1. Install dependencies

Node >= 22.19 and the pinned dependencies:

```sh
npm ci
```

Optionally run `npm link --offline` from this checkout to expose
**`durable-nanobot`**. Python's `nanobot` command is not replaced. Without linking,
the `node bin/durable-nanobot.mjs` examples below load TypeScript source directly
through pinned `tsx`. A process restart picks up source edits without a build or
watcher; `npm run typecheck` remains a separate recommended check. The systemd
units use that same launcher, without requiring a command link. Compiled output
is still available via `npm run build` for tests/distribution. See
[service/update workflow](SERVICE.md#checkout-command-and-build-workflow).

## 2. Create a workspace

Config paths resolve relative to the **config file's directory**, not the shell's
working directory. Keep `dataDir` outside `workspace`: the gateway rejects a data
directory that resolves inside the workspace or an extra allowed root.

For the persistent primary instance, keep the config at
`~/.durable-nanobot/config.json` and use `"dataDir": "./data"` and
`"workspace": "./workspace"` as in the shipped example. This places Durable state
under `~/.durable-nanobot/data/`, separate from the workspace and the checkout.
JSON does not expand `~`; those relative paths resolve from the config file.
See [primary service layout](SERVICE.md#primary-instance). Do not change an existing
store's path without deliberately migrating its stopped state.

The walkthrough below instead uses a **disposable demo** inside the checkout:
its `./data` resolves under `demo/`, not the persistent primary directory.

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
| `followUpMode` | Where an owner message goes while that CLI or Telegram conversation is busy. Absent or `"followUp"` queues it for the next run; `"steer"` places it after the current tool round so it joins the running turn. Internal worker, digest and scheduled work always keeps the native default. See [busy owner messages](./README.md#busy-owner-messages). |
| `workers` | Default off. `toolAllowlist` grants ordinary subagents tools independently of the foreground coding list; omitted inherits configured chat tools, `[]` gives no tools. Supports native coding/research/skill names, `mcp` for connected MCP tools, or exact MCP registration names. It never grants Telegram, cron or further delegation. Integrations must still be enabled separately; see [worker configuration](WORKERS.md#separate-worker-grants). |
| `cron` | Installs the model-facing `cron` tool; `timeZone: "UTC"` interprets calendar expressions without an explicit zone. |
| `episodeSummary` | Closed episodes use the conversation's current model, or a named override such as `"preset": "fast"`. This costs provider calls; set `enabled: false` to turn it off. |
| `digest` | Requires an explicit background `preset` or `model`; never inherits the chat model. Defaults per invocation: `entriesPerBatch` 2000, `charsPerBatch` 200,000 UTF-16 units (both minimum 2), `maxToolCalls` 24, `maxRequests` 12 successful responses (native failed retries allowed), `maxInputTokens` 500,000 reported input including cache (soft ceiling), `runTimeoutSeconds` 600, `maxChangedFiles` 8 and `maxDiffChars` 32,000 inserted plus removed units. One fitting completed-turn range is one batch; a larger range splits into ordered chunks, potentially within a turn. Evidence includes owner/assistant prose and paired untrusted tool calls/results; long results have 2,500-character head/tail previews with original references. See [bounds and fixed safety caps](HISTORY.md). Values are captured per run; this block enables no schedule. |
| `credentials` | Provider spelling → environment-variable *name*. No secret value belongs in this file. Native provider environment names also work without an entry. |

Export the key named by `credentials.openai` (or whichever provider you allow):

```sh
export OPENAI_API_KEY=...
```

Or store a provider credential explicitly, without putting it in config:

```sh
durable-nanobot login            # choose a native provider and auth method
durable-nanobot login openai --auth oauth
```

`login` validates the same configuration as the gateway, writes Durable's private
credential store under the configured canonical `dataDir`, never reads or changes
Pi's store, and never runs at gateway startup. A configured
`credentials.<provider>` reference pins that one environment variable: when it is
unset or blank, startup or the request fails instead of using the provider's
ambient variables. Custom compatible endpoints use an explicit `providers` block;
see [providers and auth](./PROVIDERS.md#custom-compatible-providers). Code Mode
classifiers need one explicit `classifierModel` pair; see
[classifiers](./PROVIDERS.md#classifiers-and-image-generation).

Configured tools apply to validated mapped ordinary chats — not to arbitrary
internal or forked conversations — and still run over the guarded workspace
environment. Scheduled runs inherit a bounded subset from an authenticated
channel origin, so they never exceed what that origin had; narrowing
`toolAllowlist` and restarting also narrows those runs.

## 4. First run

The gateway owns storage, tools, cron and Telegram; the CLI attaches to it as a
conversation surface. Start the gateway in one terminal:

```sh
node bin/durable-nanobot.mjs gateway --config demo/config.json
```

Then attach a terminal in another:

```sh
node bin/durable-nanobot.mjs agent --config demo/config.json
```

This walkthrough uses an explicit demo config. Without `--config`, `gateway`,
`agent`, `recovery` and `cron` read the fixed primary file
`~/.durable-nanobot/config.json`, resolved from the runtime user home rather than
the working directory; there is no discovery, merge or auto-generation. A
secondary instance passes its own `--config`. See [user services](./SERVICE.md)
for the shipped foreground systemd user units.

The agent resumes the `cli:default` conversation and prints a prompt. The
historical `node bin/durable-nanobot.mjs --config demo/config.json` is the same attach; it
fails with a fixed message when no gateway is running and never opens a second
runtime. `agent --conversation <name>` uses a separate `cli:<name>`
conversation in the same gateway; conversations are separate by default and
share the workspace and Markdown memory. No grant step exists: `toolAllowlist`
in the config is the tool authority. `/tools` is an optional read-only
diagnostic of it. Ask for one round trip:

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
together in the same conversation. `/new` in both CLI and Telegram starts a fresh
model context and rebuilds that chat's workspace prompt, memory and skills. With
workspace context configured, a busy chat refuses the command without applying
either half; use `/abort` (or `/stop`) or wait, then retry. Supported `/restart`
replaces the whole gateway process and disconnects every channel; it is not a CLI
reattach. A gateway restart applies
config edits and re-reads the files, because startup reloads the config selection
for every persisted session mapping.

Ctrl-D or Ctrl-C closes only that CLI attachment; already admitted turns keep
running in the gateway. Attach again with the same command to resume the same
conversation, then retrieve what happened:

```text
/history
/search --scope all setup
/episodes
```

Earlier entries stay stored; summaries are an aid, and `/entry` or `/episode`
opens the original entries. Config edits and file re-reads happen when the
gateway restarts, not when a CLI reconnects.

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
  into JSON. A systemd launch inherits it from the unit's private environment file;
  see [environment handling](SERVICE.md#environment-file). Use a distinct test bot
  while the Python bot remains active; do not run two pollers with the same token.
- `allowFrom` is a non-empty list of decimal Telegram user IDs, written as JSON
  strings (for example `"123456789"`, not unquoted numbers), allowed to talk to
  the bot; only private chats reach the assistant.
- **Every user in `allowFrom` shares the configured workspace and tool
  authority.** Listing a user is the authorization; there is no per-chat
  permission step, so allowlist only people you would let use those tools.
- Adding the section makes the same gateway poll Telegram as well as serve local
  CLI attachments. Both can run at once: each chat and CLI conversation has its
  own Durable conversation, context snapshot and persisted model choice, but they
  share the workspace, Markdown memory and configured tools. Closing a CLI
  attachment does not stop Telegram polling; stopping the gateway stops both.

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

`/help` lists only the controls this host implements: `/new`, `/abort` (also
spelled `/stop`), `/status`, `/model`, `/digest` and `/restart`. There is no
Telegram `/refresh` command: `/new` starts a new context **and** rebuilds this
chat's assembled workspace prompt from the current files, while a gateway
restart is what re-reads configuration. Without a `media` section the adapter is
text-only: an attachment gets a fixed unsupported-attachment notice (caption
text is still passed as input). With `media`, photos, voice/audio and documents
are stored under the workspace and the turn is told exactly what arrived—see
[8. Optional: attachments and voice](#8-optional-attachments-and-voice). Groups or
other bots never reach the assistant.

Reminders are ordinary agent scheduling through the configured `cron` tool. A
default isolated run answers in its own background conversation; an `origin`-mode
job answers inside the original conversation. In either mode a normal settlement is
queued for the originating Telegram private chat: the committed answer, or a fixed
sanitized notice naming the job and occurrence when the run failed or answered with
nothing. A job scheduled with `silent: true`, or a successful run whose final answer is
exactly `[SILENT]`, suppresses that automatic message (a failure still notifies).
Cancelled, superseded and missing-job runs are not pushed; ask the agent to
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
Telegram adapter and the local CLI. Add a top-level `media` key beside the
existing ones:

```json
"media": {
  "directory": "media",
  "transcription": { "language": "en", "maxDurationSeconds": 120 }
}
```

- `directory` is workspace-relative and defaults to `media`. Telegram originals are
  stored there byte-for-byte, while the CLI keeps its own originals in the `cli/`
  subdirectory, so the ordinary configured coding tools (`read`, `bash`, and so on)
  are how the agent opens them. Storing a file grants no tool authority. Nothing is
  written to `dataDir` or outside the workspace. A configured workspace that is
  itself a symlink is accepted and resolved once to its canonical path; symlinks
  below it are refused.
- `transcription.enabled` (default `true`) turns local speech recognition on or
  off; `language` is an optional hint, `maxDurationSeconds` (default `120`,
  accepted range 1–3600) refuses longer audio, and `timeoutMs` (default `180000`,
  accepted range 1–3600000) bounds the whole operation. There is no cloud speech
  provider and no API key.
- Telegram photos arrive as native image content plus a workspace-relative
  locator. Telegram documents are stored unread: no text extraction, OCR,
  PDF/Office conversion or dependency is involved, so reading one is the agent's
  job with the configured tools. Video and stickers get an explicit unsupported
  notice.
- The local CLI submits one operator-named file per `/attach` command through the
  running gateway. Every CLI attachment, photos included, is stored path-only
  under `<workspace>/<media.directory>/cli` (default `media/cli/`); the turn names
  that workspace-relative locator and nothing else. The CLI builds no native image
  content, never triggers the configured vision handoff, and adds no document
  extraction or audio transcription; the configured tools decide whether to read
  the original. The model never receives the operator's absolute path. Telegram's
  own originals stay at `<workspace>/<media.directory>` with its native photo and
  transcription handling unchanged. See [the CLI](./CLI.md#local-attachments).
- Bounds: 20 MB per file (also Telegram's ordinary Bot API `getFile` limit), a
  60s Telegram download timeout, two concurrent attachment jobs, a 180s
  transcription timeout and a 120s audio-duration limit by default (both
  configurable, see below). Stored
  originals are never deleted by the adapter and there is no total-disk cap, so
  the media directory is yours to monitor and prune.
- Outbound files are the scoped `telegram` tool's `send` action, not a general
  upload service: one existing workspace file, unchanged (a document by default,
  or an optional native photo/audio/video/voice presentation), with an optional
  bounded caption, sent to the current authenticated private chat only. It
  exists only when `media` is configured and `toolAllowlist` contains `read`;
  the path is workspace-relative, symlink escapes and non-regular files are
  refused, the 20 MB ceiling applies, and there is no remote-URL fetch,
  arbitrary recipient, extraction, transcoding or automatic kind detection.

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
specific language by hand. The helper itself also refuses its own 20 MiB input
cap, independently of the adapter's download limit.

### Optional: Python-free backend (whisper.cpp)

Another engine is available and is **opt-in**: without the field below, an
existing configuration keeps the uv/faster-whisper helper exactly as it was.
Selecting it is explicit, and the engines are never mixed or switched
automatically:

```json
"media": {
  "directory": "media",
  "transcription": {
    "language": "en",
    "maxDurationSeconds": 120,
    "backend": "whisper-cli",
    "whisperCli": {
      "binary": "/opt/whisper-cli/whisper-cli",
      "model": "/opt/whisper-cli/ggml-small-q5_1.bin",
      "vadModel": "/opt/whisper-cli/ggml-silero-v6.2.0.bin",
      "ffmpeg": "/opt/media-tools/ffmpeg",
      "ffprobe": "/opt/media-tools/ffprobe"
    }
  }
}
```

Every path is absolute and operator-provisioned; the runtime never downloads,
builds, discovers or falls back to another engine. `backend: "faster-whisper"`
is the explicit spelling of the default, and a `whisperCli` block without
`backend: "whisper-cli"` is a configuration error rather than a silent switch.

Pinned provisioning (one-time, the only step that may use the network):

- Engine: the upstream release tarball for the host architecture, for example
  `whisper-bin-ubuntu-x64.tar.gz` from nightly `b5454`
  (`sha256 a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c`).
  Extract it into one directory and keep the sibling `libggml*.so` files: the
  CLI loads its CPU backends from `$ORIGIN`. Stable `v1.9.5` publishes no
  binaries, so a stable pin means building from source with
  `-DGGML_NATIVE=OFF`. `LD_LIBRARY_PATH` is deliberately not inherited, so the
  engine directory must resolve its own libraries.
- Model: `ggml-small-q5_1.bin` from `ggerganov/whisper.cpp`
  (`sha256 ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`);
  `ggml-small-q8_0.bin`
  (`sha256 49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f`)
  is the larger alternative. Both are the multilingual `small` tier; neither is
  claimed to match the CTranslate2 `int8` baseline's output.
- VAD: `ggml-silero-v6.2.0.bin` from `ggml-org/whisper-vad`
  (`sha256 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`).
  VAD is mandatory on this route; without it, silence and music can produce
  phantom text.
- `ffmpeg`/`ffprobe`: any local build with the codecs your attachments use
  (Opus for Telegram voice notes). The project does not ship or download either.

Runtime behavior of this route, all in one bounded operation:

- One deadline (the same 180 s default; there is no separate per-step timeout)
  spans the duration probe, the decode and the inference, so a slow decoder
  cannot buy extra time.
- `maxDurationSeconds` refuses rather than truncates: the probe rejects a longer
  file up front, and the decoded PCM is additionally size-bounded, so wrong
  duration metadata cannot smuggle an over-long file through.
- The 20 MiB input cap applies to every caller of this backend, not only the
  Telegram download path.
- Decoding blocks network protocols (`-protocol_whitelist file`), but permits
  local file references within playlist containers; this is not filesystem
  isolation. It writes one private temporary WAV removed on success, failure, timeout
  and cancellation.
- Children see a small fixed environment (locale and temporary-directory keys
  only). Hugging Face and `uv` variables are not inherited on this route, and
  neither is `LD_LIBRARY_PATH`.
- Failures stay fixed and value-free: `unavailable` (engine or model missing),
  `timeout`, `cancelled`, `too-large`, `failed`, `empty`. Transcripts are capped
  at 64 KiB like any other untrusted input.

On one measured 4-core/8-thread CPU, a 102 s Ogg/Opus file took about 32 s end to
end through this route (probe, decode, VAD and `small` inference). That is one
host's number, not a guarantee.

### Optional: Hex backend (anomalyco/hex)

[Hex](https://github.com/anomalyco/hex) is a local dictation engine with its own
speech models. This route uses it only as a file transcriber through
`hex model transcribe <wav>`: no Hex desktop app, listener, hotkey or local API
is involved, and the gateway never starts Hex in the background. It is opt-in
and explicit, never a fallback:

```json
"media": {
  "directory": "media",
  "transcription": {
    "language": "en",
    "maxDurationSeconds": 600,
    "timeoutMs": 600000,
    "backend": "hex",
    "hex": {
      "binary": "/home/operator/.local/opt/hex/hex",
      "model": "parakeet_unified_en",
      "ffmpeg": "/home/operator/.local/bin/ffmpeg",
      "ffprobe": "/home/operator/.local/bin/ffprobe"
    }
  }
}
```

`binary`, `ffmpeg` and `ffprobe` are absolute operator-provisioned paths. `model`
is a Hex model id and is optional: without it Hex uses whatever model its own
settings select. Hex's model store is Hex's, resolved from the operator's home
exactly as a hand-run `hex model` command sees it; the gateway does not copy,
verify or download models.

Pinned provisioning (one-time, the only step that may use the network):

- Engine: the signed release binary for the host architecture from
  `https://anoma.ly/hex/download/linux-x64` (the redirect resolves to the current
  stable build). Install it at a fixed operator path such as
  `~/.local/opt/hex/hex` with mode `0700`. Record the SHA-256 you installed; this
  route verifies nothing itself, so the operator owns provenance and updates.
  The usual install script is optional and adds a desktop app, an autostart entry
  and a user unit, none of which this route needs.
- Model: `hex model install <model-id> --language <code>`, for example
  `hex model install parakeet_unified_en --language en`. `hex model list` shows
  the catalog, size and languages of each model; `hex model devices` shows the
  devices it will consider.
- `ffmpeg`/`ffprobe`: any local build with the codecs your attachments use (Opus
  for Telegram voice notes). Hex itself takes WAV only, so the decode is required;
  it is not a second inference step.

Runtime behavior, all in one bounded operation:

- One deadline (the same `timeoutMs`, default 180 s) spans the duration probe, the
  decode and the Hex inference, so no leg can buy extra time.
- `maxDurationSeconds` refuses rather than truncates: the probe rejects a longer
  file up front, and the decoded PCM is additionally size-bounded, so wrong
  duration metadata cannot smuggle an over-long file through. Raise it for long
  voice notes (up to one hour) and raise `timeoutMs` with it; the 20 MiB input cap
  above still applies and is Telegram's own `getFile` ceiling.
- The 20 MiB input cap applies to every caller of this backend, not only the
  Telegram download path.
- Decoding blocks network protocols (`-protocol_whitelist file`) and writes one
  temporary WAV in a private `0700` directory, removed on success, failure,
  timeout and cancellation. On the CPU this machine decoded a 9 s Ogg/Opus note in
  0.02–0.08 s.
- Hex runs with the operator's `HOME` so its models resolve, plus the small
  locale/temp environment. No other variable (credentials, `LD_LIBRARY_PATH`,
  Hugging Face settings) is inherited.
- Hex reports every failure as exit 1 — unknown model, uninstalled model,
  undecodable audio. This route therefore distinguishes only a binary it could not
  start at all (`unavailable`) from a failed transcription (`failed`); a missing
  model appears as `failed`. Check `hex model transcribe` by hand when a
  transcription fails. The stored audio is never consumed and the turn never
  claims the speech was understood.

The model and the hardware decide the speed. On one measured i5-1035G1 with
integrated graphics, English Parakeet Unified transcribed a 9 s note in about
2 s end to end, and a 359 s note in about 119 s (roughly 3x real time). Those
are one host's numbers on one English clip, not a quality or speed guarantee.
Benchmark and choose the model for the language and notes you actually send.
