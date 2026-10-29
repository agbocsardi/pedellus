# Interactive CLI

Run the configured local conversation with the existing explicit config path:

```sh
nanobot --config /path/to/config.json
```

When Telegram is configured, the CLI keeps the existing Telegram path; otherwise
it opens the local `cli:default` Durable conversation. Workspace context is off
unless the config contains `workspaceContext`; when enabled it applies the same
fixed bootstrap and explicit `memoryFiles` selection to every session key and
adds no identity. Adding `workspaceContext.memoryManifest: true` also appends the
bounded topic manifest for on-demand native reads. See [workspace context](./WORKSPACE_CONTEXT.md). Model text
streams only from committed `pi.live` snapshots, filtered to assistant text
blocks. The
initial watch snapshot is not replayed. After a submission settles, the CLI
reads its committed assistant entry and flushes any text missing from the last
committed partial. Reasoning blocks, system entries, tool calls/arguments, and
tool output are not printed. ESC/C1 terminal controls, carriage returns, and bidi
formatting controls are removed; ordinary newlines and Unicode scalar values are preserved.

## Startup diagnostics

The CLI fails closed with exit status 1. Known configuration and startup failures
print one fixed, value-free message: unreadable/invalid configuration, invalid
configuration fields, unsupported provider aliases, unavailable models or
thinking levels, missing credential alias references, a missing Telegram token
environment variable, and workspace/data-directory preparation failures. These messages
never include configuration values, environment values, filesystem paths,
provider/dependency error text or the underlying exception. Unexpected failures
keep the generic `nanobot: command failed; diagnostic details suppressed`
message.

Recovery operation errors keep their dedicated `nanobot recovery:` text and
remain governed by recovery's existing disclosure contract, not this startup
policy. This section does not broaden or change that behavior. Configuration
loading for a recovery invocation still uses the fixed startup messages above.

## Recovery

Startup fails closed when a prepared model dispatch still pins historical Nanobot
context. The same executable exposes an owner-only recovery path that never opens
the gateway, resumes scheduling, or requires credentials. It does require the
existing SQLite database and the gateway process to be stopped; a live owner is
reported as a lock conflict. Inspection may perform Durable's native
`Harness.open()` crash reconciliation but never resumes task execution:

```sh
node dist/cli.js recovery --config /path/to/config.json
node dist/cli.js recovery --config /path/to/config.json --cancel <taskId> --fingerprint <sha256>
```

Inspection prints JSON with task ID, kind, phase, pinned entry, and fingerprint.
Cancellation requires the exact fingerprint, durably marks only that native task
for abort, and preserves the transcript. The result reports `abort-marked`,
`terminal`, or `orphaned` from a fresh task read. Reopen the gateway to run the
abort protocol; a cancelled poll whose model is outside `allowedModels` remains
fail-closed and is not remotely cancelled. See
[prepared context recovery](./CONTEXT_RECOVERY.md).

## Local controls

| Command | Behavior |
|---|---|
| `/help` | Show this CLI's local controls. |
| `/status` | Show the conversation's current host-selected model, native run/inbox state, and Durable-recorded per-model/tool usage. Provider-side charges or unrecorded spend remain unknown. |
| `/history [count]` | Show the latest user/assistant text messages only (default 10, max 50), using Durable entry pagination; each snippet is limited to 200 characters and the scan to 2,000 entries. System, reasoning, tool, and non-text blocks are omitted. |
| `/model` | List the current host-selected model and finite allowed choices, including supported thinking levels. In the integrated CLI, select with `/model <provider> <modelId> [thinkingLevel]`; the pair must exactly match the host allowlist. A busy conversation rejects selection atomically; retry when idle. Standalone terminal callers without a host callback remain read-only. |
| `/tools` | List the host tool ceiling and this conversation's active coding-tool grants with expiry. Reports a disabled ceiling instead of offering a grant. |
| `/grant <tool[,tool]> <duration>` | Grant one or more ceiling tools to this `cli:default` conversation with an explicit finite duration (for example `/grant read,bash 30m`). No duration, an unknown unit, an out-of-ceiling name or a disabled ceiling is rejected; there is no default or permanent grant. |
| `/revoke <tool[,tool]\|all>` | Revoke named grants or every active grant in this conversation. Revocation is persisted and survives reopen. |
| `/refresh` | Re-read the configured workspace bootstrap, memory files, manifest and skill inventory for this `cli:default` conversation. Requires `workspaceContext`; rejected while the conversation is busy. The refreshed summary and skill table apply to the next model request. |
| `/compact` | Admit native Durable manual compaction. Summarization is asynchronous; summary placement follows native inbox boundaries and original entries remain stored. |
| `/abort` | Use native `Conversation.abort()`: stop foreground conversation work, withdraw queued inputs, and wait for native idleness. It does not implement Python sustained-goal/background abort semantics. |
| `/steer TEXT` | Submit with native `whenBusy: "steer"`; while busy it joins the run at a native safe boundary. |
| `/after TEXT` | Submit as a native follow-up for a fresh run after current work. |

## Coding-tool grants

The CLI opens the host `toolAllowlist` ceiling and, when it is non-empty, offers
explicit local grant controls for the `cli:default` conversation. Grants are not
requested by the model and are never inferred from config: a non-empty ceiling
still grants nothing until `/grant` is issued.

```text
/tools
/grant read 30m
/grant read,bash 2h
/revoke bash
/revoke all
```

- Durations require a unit: integer seconds (`s`), minutes (`m`) or hours (`h`).
  The expiry is `now + duration`; there is no default duration and no permanent
  grant.
- A name outside the host ceiling is rejected, and an empty ceiling reports the
  config gap instead of accepting a grant. `/revoke` is idempotent for names that
  are not currently granted.
- Grants are conversation-scoped and persisted in Durable. They reappear after a
  Gateway reopen until their expiry; expired grants are pruned and are never
  resurrected by re-enabling the ceiling.
- `/grant` takes effect for the next model request. A request already in progress
  keeps its current tool list, and a call that already passed the grant check is
  not cancelled retroactively. `/revoke` similarly bounds later calls, not a
  command already running.

The commands are local controls, not a model-facing tool or an approval channel.
Unknown slash commands are never sent to the model. This CLI surface has no
Telegram equivalent; see [coding tools and grants](./TOOLS.md).

## Workspace refresh

When the config contains `workspaceContext`, `/refresh` re-captures the current
`cli:default` conversation's host snapshot without reopening the Gateway:

```text
/refresh
```

- It uses the same provider and loader as conversation creation and reopen, so
  bootstrap files, selected memory, the optional memory manifest and workspace
  or builtin skills are re-read together. Disabled names and `requires` gates
  are re-evaluated.
- The refreshed skill summary and the read-only `skill` table replace the
  captured ones for the next model request. Skill bodies remain on demand and
  never enter the prompt.
- It is rejected while the conversation is busy; retry when idle. A provider or
  loader failure leaves the previous snapshot in effect. `/refresh` adds no
  tool grant, workspace root or shell authority.
- Without `workspaceContext`, or for standalone terminal callers without the
  host callback, `/refresh` reports that workspace context is unavailable.

This is the supported way to make a skill created or edited during the current
conversation usable without starting another conversation. Scheduled background
runs have no session key and are not refreshed; they pick up the snapshot on
their next run or Gateway reopen.

`/stop` is deliberately not an alias for `/abort`: native abort withdraws queued
inputs, while Python stop preserves queued work. `/new`, `/restart`, `/goal`,
`/interrupt`, `/btw`, task/policy/receipt/skill, memory/Dream and pairing
commands are not implemented here. Unsupported slash commands are reported
locally and are never silently sent as model prompts. Prefix a prompt with `//`
to send one literal leading slash (for example, `//help` sends `/help` to the
model).

Normal input, `/steer`, and `/after` are admitted in input order by the native
conversation. Controls are ordered between those admissions: a control observes
all earlier durable submissions, and later inputs cannot overtake a mutating
control such as `/abort`. This boundary waits for submission admission and the
control operation, never for model completion (except native `/abort` itself).
Durable owns the busy inbox; this CLI does not create a second agent queue. At
most 64 locally admitted inputs may remain unsettled, and at most 16 local
control operations may be pending. Only completed lines up to 32,000 UTF-16
code units are admitted, and displayed response text is capped at 64,000
UTF-16 code units without splitting a Unicode scalar. This is an admitted-line
limit, not a hard ingress-memory cap: Node `readline` buffers until newline
before yielding a line to the check, so a very long or newline-free stdin record
can consume memory first. Injected `TerminalIO` sources likewise own any
pre-yield memory bound. Writable backpressure is awaited; rejected-line
notices are also awaited rather than queued. EOF waits for this process's admitted inputs to settle before gateway
shutdown; if a failed/ended run leaves inputs queued under Durable's default
`afterFailedRun: "keep"`, EOF reports that state and cancels only local
watch/wait contexts. The durable submissions remain queued for owner
reconciliation or reopen; only explicit `/abort` withdraws them. SIGINT and
SIGTERM cancel local waits and watches, close input, and let the gateway
close/reap its Harness.

This remains a text-only local surface, not a complete Python command port or
interactive terminal UI. Model selection delegates to Gateway's allowlist and
persists in native Durable `pi.agent`; it adds no agent runner, queue, session
store, or parallel model state.
