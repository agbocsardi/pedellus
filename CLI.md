# Interactive CLI

Run the configured local conversation with the existing explicit config path:

```sh
nanobot --config /path/to/config.json
```

When Telegram is configured, the CLI keeps the existing Telegram path; otherwise
it opens the local `cli:default` Durable conversation. Model text streams only
from committed `pi.live` snapshots, filtered to assistant text blocks. The
initial watch snapshot is not replayed. After a submission settles, the CLI
reads its committed assistant entry and flushes any text missing from the last
committed partial. Reasoning blocks, system entries, tool calls/arguments, and
tool output are not printed. ESC/C1 terminal controls, carriage returns, and bidi
formatting controls are removed; ordinary newlines and Unicode scalar values are preserved.

## Recovery

Startup fails closed when a prepared model dispatch still pins historical Nanobot
context. The same executable exposes an owner-only recovery path that never opens
the gateway, resumes scheduling, or requires credentials:

```sh
node dist/cli.js recovery --config /path/to/config.json
node dist/cli.js recovery --config /path/to/config.json --cancel <taskId> --fingerprint <sha256>
```

Inspection prints JSON with task ID, kind, phase, pinned entry, and fingerprint.
Cancellation requires the exact fingerprint, durably marks only that native task
for abort, and preserves the transcript. Reopen the gateway to run the abort
protocol. See [prepared context recovery](./CONTEXT_RECOVERY.md).

## Local controls

| Command | Behavior |
|---|---|
| `/help` | Show this CLI's local controls. |
| `/status` | Show the conversation's current host-selected model, native run/inbox state, and Durable-recorded per-model/tool usage. Provider-side charges or unrecorded spend remain unknown. |
| `/history [count]` | Show the latest user/assistant text messages only (default 10, max 50), using Durable entry pagination; each snippet is limited to 200 characters and the scan to 2,000 entries. System, reasoning, tool, and non-text blocks are omitted. |
| `/model` | List the current host-selected model and finite allowed choices, including supported thinking levels. In the integrated CLI, select with `/model <provider> <modelId> [thinkingLevel]`; the pair must exactly match the host allowlist. A busy conversation rejects selection atomically; retry when idle. Standalone terminal callers without a host callback remain read-only. |
| `/compact` | Admit native Durable manual compaction. Summarization is asynchronous; summary placement follows native inbox boundaries and original entries remain stored. |
| `/abort` | Use native `Conversation.abort()`: stop foreground conversation work, withdraw queued inputs, and wait for native idleness. It does not implement Python sustained-goal/background abort semantics. |
| `/steer TEXT` | Submit with native `whenBusy: "steer"`; while busy it joins the run at a native safe boundary. |
| `/after TEXT` | Submit as a native follow-up for a fresh run after current work. |

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
