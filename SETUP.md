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
the config's `workspace` or an explicit file under it. Markdown is the memory and
skill source of truth; the conversation transcript and runtime state live in
Durable's SQLite database under `dataDir`.

## 3. Configure

The shipped [`config.example.json`](./config.example.json) is the starting point:

| Key | Meaning here |
| --- | --- |
| `workspace` / `dataDir` | Workspace root and private state directory, both relative to the config file. |
| `model` / `allowedModels` | Host default and allowlist. The pair must exist in the pinned catalog, so change both together ([providers](./PROVIDERS.md)). A chat's persisted `/model` choice can keep overriding the config default after a restart; clearing that choice is not a config edit. |
| `workspaceContext.memoryFiles` | `["memory/MEMORY.md"]` is loaded into every turn; a missing named file fails closed. |
| `workspaceContext.memoryManifest` | Lists the other `memory/*.md` topics for on-demand `read`; their bodies stay out of the prompt. |
| `workspaceContext.skills.disabledSkills` | `[]`; workspace skills are discovered only because this section exists. |
| `toolAllowlist` | Config authority: these coding tools are enabled for authenticated mapped chats. `[]` or absent disables them. |
| `cron` | Installs the model-facing `cron` tool; `timeZone: "UTC"` interprets calendar expressions without an explicit zone. |
| `episodeSummary` | Closed episodes are summarized in the background with the conversation's current model. That makes provider calls and costs money; set `enabled: false` to turn it off. |
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
`write` and `read` tools.

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
- `allowFrom` is a non-empty list of decimal Telegram user IDs allowed to talk to
  the bot, and only private chats reach the assistant.
- **Every user in `allowFrom` shares the configured workspace and tool
  authority.** Listing a user is the authorization; there is no per-chat
  permission step, so allowlist only people you would let use those tools.
- Adding the section switches the same gateway to Telegram polling instead of the
  local prompt. CLI and Telegram are alternative modes of one process, not
  simultaneous clients; each chat has its own conversation, context snapshot and
  persisted model choice, but the same workspace and config ceiling.

In an allowed private chat:

```text
/help
Load the memory skill and remember that the demo bot is for setup checks.
remind me in ten minutes to stretch, then put today's reminder in memory/topics/demo.md
```

`/new`, `/abort` and `/help` are the channel controls. Context refresh in
Telegram is a gateway restart; there is no Telegram refresh command, and `/new`
does not re-read files. The adapter is text-only: an attachment gets a fixed
unsupported-attachment notice (caption text is still passed as input), and
groups or other bots never reach the assistant.

Reminders are ordinary agent scheduling through the configured `cron` tool. A
default isolated run answers in its own background conversation and its result is
delivered back to the chat that asked. An `origin`-mode job instead answers inside
the origin conversation and creates no outbound send: that answer is visible to
an attached local CLI or through history, not pushed to Telegram. Failures are
not pushed either; ask the agent to `list` cron jobs and read the reported
failure/delivery fault. See [cron](./CRON.md).

## 7. Optional: shell, sandbox, builtin skills

- `bash`: add `"bash"` to `toolAllowlist` and restart. It runs on the real
  workspace over a guarded environment; `toolTimeoutSeconds` is the default
  timeout. Configure it only for users and channels you trust with a shell. See
  [coding tools](./TOOLS.md).
- `toolSandbox`: `"bwrap"` (with an absolute `bwrapPath`) runs shell commands in
  a direct-workspace Bubblewrap view and fails closed when unavailable. It wraps
  the shell only, and it is accidental-damage protection, not hostile-tenant
  isolation. See [direct Bubblewrap](./DIRECT_BWRAP.md).
- Builtin skills: `workspaceContext.skills.builtinSkillsRoot` needs an absolute
  path, so copying curated skills into `workspace/skills` is the portable route.
  See [curated builtin skills](./SKILLS_BUILTIN.md).
- Memory topics, manifest bounds and skill frontmatter are described in
  [memory context](./MEMORY_CONTEXT.md) and [skills context](./SKILLS_CONTEXT.md);
  local utility commands are in [the CLI](./CLI.md).
