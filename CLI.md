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
tool output are not printed. Terminal control sequences are stripped.

## Local controls

| Command | Behavior |
|---|---|
| `/help` | Show this CLI's local controls. |
| `/status` | Show the conversation's current host-selected model, native run/inbox state, and Durable-recorded per-model/tool usage. Provider-side charges or unrecorded spend remain unknown. |
| `/history [count]` | Show the latest user/assistant text messages only (default 10, max 50), using Durable entry pagination; each snippet is limited to 200 characters and the scan to 2,000 entries. System, reasoning, tool, and non-text blocks are omitted. |
| `/model` | Report the current host-selected model. Arguments do not change it; model mutation belongs to the host's allowed-model API. |
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
conversation. Durable owns the busy inbox; this CLI does not create a second
agent queue. At most 64 locally admitted inputs may remain unsettled, and at
most 16 local control operations may run concurrently. Each input line is
limited to 32,000 characters and displayed response text to 64,000 characters.
Writable backpressure is awaited. EOF waits for this process's admitted inputs
to settle before gateway shutdown; if a failed/ended run leaves this process's
inputs queued under Durable's default `afterFailedRun: "keep"`, EOF explicitly
withdraws only those still-queued local submissions and reports that fallback
(the native API cannot drain them without another user submission). SIGINT and
SIGTERM cancel local waits and watches, close input, and let the gateway
close/reap its Harness.

This remains a text-only local surface, not a complete Python command port or
interactive terminal UI. It does not add another agent runner, queue, session
store, or model selector.
