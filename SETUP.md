# Set up the assistant

A short, CLI-first walkthrough on a synthetic workspace: build, enable memory and
skills, grant finite tool authority, then add Telegram as a separate step. It
does not claim live-model success; what you can verify offline is in
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
copied because it needs a granted `bash` tool and `gh`, and builtin skills are
not enabled here. Then create the fixed bootstrap file and the memory file the
config names:

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
the config's `workspace` or an explicit file under it.

## 3. Configure

The shipped [`config.example.json`](./config.example.json) is the starting point:

| Key | Meaning here |
| --- | --- |
| `workspace` / `dataDir` | Workspace root and private state directory, both relative to the config file. |
| `model` / `allowedModels` | Host allowlist; `/model` can switch only inside it. The pair must exist in the pinned catalog, so change both together ([providers](./PROVIDERS.md)). |
| `workspaceContext.memoryFiles` | `["memory/MEMORY.md"]` is loaded into every turn; a missing named file fails closed. |
| `workspaceContext.memoryManifest` | Lists the other `memory/*.md` topics for on-demand `read`; their bodies stay out of the prompt. |
| `workspaceContext.skills.disabledSkills` | `[]`; workspace skills are discovered only because this section exists. |
| `toolAllowlist` | The host ceiling: `read`, `write`, `edit`. It is not a grant and enables nothing by itself. |
| `cron` | Installs the model-facing `cron` tool; `timeZone: "UTC"` interprets calendar expressions without an explicit zone. |
| `episodeSummary` | Closed episodes are summarized in the background with the conversation's current model. That makes provider calls and costs money; set `enabled: false` to turn it off. |
| `credentials` | Environment-variable *names* only. No secret value belongs in this file. |

Export the key named by `credentials.openai` (or whichever alias you allow):

```sh
export OPENAI_API_KEY=...
```

## 4. First run

```sh
node dist/cli.js --config demo/config.json
```

Without a `telegram` section the CLI opens the local `cli:default` conversation
and prints a prompt. Now grant tools for this conversation:

```text
/tools
/grant read,write,edit 30m
```

`/tools` shows the ceiling and no active grants. A non-empty ceiling still grants
nothing until `/grant`; the duration is required and finite, and grants are
re-checked at call time and survive a restart until they expire. Then ask for one
round trip:

```text
Load the memory skill, then write the fact "the demo workspace is for setup checks"
to memory/topics/setup.md with a one-line description and read it back.
```

The `skill` tool needs no grant; the actual write and read do.

## 5. Refresh, reset, restart

A conversation captures its workspace context and skill inventory when it is
created or when the gateway reopens. Editing `AGENTS.md`, `MEMORY.md`, or a
`SKILL.md` does nothing to the current conversation until you re-capture it:

```text
/refresh
```

`/refresh` re-reads bootstrap files, selected memory, the manifest and skills
together in the same conversation; it adds no grant. `/new` is different: it
starts a fresh model context with no handoff and does **not** re-read files. A
gateway restart re-reads them, because startup reloads the config selection for
every persisted session mapping.

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
  "toolGrantFrom": ["123456789"],
  "pollTimeoutSeconds": 30
}
```

- `tokenEnv` is an environment-variable name; export the token, never paste it
  into the file.
- `allowFrom` is a non-empty list of decimal Telegram user IDs allowed to talk to
  the bot. Only private chats reach the assistant.
- `toolGrantFrom` is an optional admin list of decimal user IDs; it must be a
  subset of `allowFrom` and defaults to empty. It enables the in-chat grant
  commands and nothing else. Config alone grants nothing, and grants still stay
  inside `toolAllowlist`.
- Adding the section switches the same gateway to Telegram polling instead of the
  local prompt. CLI and Telegram are alternative modes of one process, not
  simultaneous clients; the conversations are separate, so grants and context
  snapshots are per chat.

In an allowed private chat:

```text
/tools
/grant read,write,edit 30m
/revoke edit
remind me in ten minutes to stretch, then put today's reminder in memory/topics/demo.md
```

`/grant`/`/revoke` require both a listed admin sender and the chat's own
authentication; they never widen the host ceiling. `/new`, `/abort` and `/help`
are the other controls; any other slash command gets a bounded notice and is not
sent to the model (`//help` sends it as text). Limits: private chats only, and the
adapter is text-only — an attachment gets a fixed unsupported-attachment notice
(caption text is still passed as input), and groups or other bots never reach the
assistant. Controls only apply to text messages.

Reminders are ordinary agent scheduling through the `cron` tool. A default
isolated run answers in its own background conversation and its result is
delivered back to the chat that asked. An `origin`-mode job instead answers inside
the origin conversation and creates no outbound send: that answer is visible to
an attached local CLI or through history, not pushed to Telegram. Failures are
not pushed either; ask the agent to `list` cron jobs and read the reported
failure/delivery fault. See [cron](./CRON.md).

Context refresh in Telegram is a gateway restart, not a chat command; `/new` does
not re-read files. If the running build predates the chat grant commands, `/grant`
is refused in chat and grants remain CLI-only.

## 7. Optional: shell, sandbox, builtin skills

- `bash`: add `"bash"` to `toolAllowlist` and `/grant bash 30m`. It runs on the
  real workspace over a guarded environment; `toolTimeoutSeconds` is the default
  timeout. See [coding tools and grants](./TOOLS.md).
- `toolSandbox`: `"bwrap"` (with an absolute `bwrapPath`) runs shell commands in
  a direct-workspace Bubblewrap view and fails closed when unavailable. It wraps
  the shell only, and it is accidental-damage protection, not hostile-tenant
  isolation. See [direct Bubblewrap](./DIRECT_BWRAP.md).
- Builtin skills: `workspaceContext.skills.builtinSkillsRoot` needs an absolute
  path, so copying curated skills into `workspace/skills` is the portable route.
  See [curated builtin skills](./SKILLS_BUILTIN.md).
- Memory topics, manifest bounds and skill frontmatter are described in
  [memory context](./MEMORY_CONTEXT.md) and [skills context](./SKILLS_CONTEXT.md);
  local commands are in [the CLI](./CLI.md).
