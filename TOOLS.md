# Opt-in coding tools and configured authority

`openGateway` can register the native Pi 1.4.0 `read`, `write`, `edit` and `bash`
tools over a guarded `HostExecutionEnv` on the **actual workspace**. It stays
disabled unless the host explicitly configures a non-empty `toolAllowlist`; that
list is the only coding-tool authority for validated chats and for the bounded capture
of a scheduled isolated run.

This is W1 accidental-damage protection, not confinement. The default host shell
can still read host files, use the network, follow a hard link out of the
workspace, or escape process-group teardown with `setsid`. Those limits are the
same ones recorded for the host backend in
[`EXECUTION.md`](./EXECUTION.md) and are not weakened or hidden here. An optional
direct-workspace Bubblewrap shell (W2) narrows the shell mount view and is
described below; Code Mode is not part of this slice.

## Activation

```jsonc
{
  "workspace": "./workspace",
  "dataDir": "./.nanobot-data",
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "toolAllowlist": ["read", "bash"],
  "toolTimeoutSeconds": 60,
  "toolSandbox": "host",
  "bwrapPath": "/usr/bin/bwrap"
}
```

- An empty or absent `toolAllowlist` means no tool extension and no host
  execution environment. Existing gateway behavior is unchanged.
- The allowlist is the host-owned **ceiling** and the authority. Every name must
  be one of `read`, `write`, `edit` or `bash`; an unsupported name fails startup
  before provider or storage setup. Validated chats receive exactly these tools,
  described below.
- `toolTimeoutSeconds` is the config-level default for the host shell. Absent
  keeps the shared policy default (60 s); `0` disables the default timeout. A
  caller-supplied per-call timeout is capped by the shared policy at 600 s. The
  value must be an integer from `0` to `2_147_483`; an unrepresentable value is
  rejected at startup rather than failing on the first `bash` call.
- `toolSandbox` selects the shell backend. Absent or `"host"` keeps the guarded
  native shell. `"bwrap"` runs shell commands under direct-workspace Bubblewrap;
  the value is validated at startup and an unknown value is rejected. The
  filesystem tools are unaffected by this selector and always use the guarded
  host filesystem on the actual workspace.
- `bwrapPath` is the optional absolute Bubblewrap executable used by
  `toolSandbox: "bwrap"`. Absent prefers `/usr/bin/bwrap`, then PATH. It is
  validated (Bubblewrap 0.9 or newer) when the Gateway opens, and a missing,
  non-executable, wrong or too-old binary fails startup. There is no unsandboxed
  fallback. The field is inert for the host backend.
- `extraAllowedDirs` remains an explicit list of additional canonical
  filesystem roots. They are not created, and the data directory must stay
  disjoint from them.
- When `workspaceContext.skills` is configured, the gateway also offers one
  read-only `skill` tool that lists discovered skills and returns one skill body
  from the conversation's context snapshot. It is not one of the four coding
  tools: it is not in this ceiling, accepts no filesystem path, and executes
  nothing. See
  [`SKILLS_CONTEXT.md`](./SKILLS_CONTEXT.md).
- Every Gateway offers one read-only `history` tool to mapped chat conversations
  by default. The local CLI/Telegram path uses that default; a host can pass
  `agentHistory: false` for a bare gateway. The tool can search prior
  user/assistant message text across those mapped chats, explicitly opt into tool
  names/arguments/results, list episodes, and open a bounded window around a source
  entry. It can also discover ready derived episode summaries (`summaries`) and read
  one summary with provenance and drilldown (`summary`), but it never generates or
  backfills a summary, and original entries remain the evidence. It is not in the
  coding-tool ceiling, and the coding-tool call hook exempts it like the `skill`
  tool, so enabling coding tools never suppresses it. It accepts no path or shell command, modifies no transcript and
  creates no conversation. Its output is bounded, source-labeled, and quoted as
  untrusted historical data. See
  [`HISTORY.md`](./HISTORY.md#agent-facing-history-tool).

When `telegram` is configured, mapped Telegram chat conversations also receive
one scoped `telegram` channel-action tool (`targets`, `reply`, `react`). It is not
a coding-tool name or filesystem/shell grant. A running adapter rechecks current
private-chat admission and observed same-chat targets; root/state/fork/isolated
cron conversations do not receive it. Native replies are additional messages,
not replacements for the ordinary answer. See [Telegram interactions](./TELEGRAM.md#replies-quotes-reactions-and-native-actions).

## Configured authority

`toolAllowlist` is the only coding-tool authority. A validated mapped ordinary chat
conversation receives exactly the configured coding tools, and an empty or
absent list disables them. There is no grant, expiry, approval prompt, startup
re-grant or per-channel permission list to manage.

- Every sender admitted by `telegram.allowFrom` shares the configured workspace
  and coding-tool authority for its private chat. Admission is not per-tool
  authority: the owner chooses tools once in the configuration.
- Changing a tool is a configuration change: edit `toolAllowlist` and restart.
  Chat and terminal commands never change tool authority, and the model cannot.
- Scope is validated from durable state, never from a session-key string alone:
  only a conversation that is the target of a persisted chat session key and is
  ordinary (ownerless, unforked, not the root) is authorized. The root, a
  channel-state conversation, a raw conversation, a fork and any other
  task-owned conversation keep no coding tool even if its agent state names one.
- Every native conversation creation goes through the Durable
  `conversationCreated` hook, which retires any capture document and writes empty
  `tools`/`modelTools` filters before the optional `agent` convenience. This
  covers raw ownerless creation, forks (whose agent state is copied from the
  parent), and task-created conversations, so they are not offered inherited
  tools in the first place. Durable still applies a caller-supplied
  `ConversationCreateOptions.agent` after this hook; the Gateway does not pass
  one that re-adds tools.
- Emptying `toolAllowlist` retires the capture document of every conversation
  before resume and offers no coding tool. Re-enabling the ceiling offers the
  newly configured names from configuration alone; no earlier state can
  resurrect a tool.
- A `beforeTool` hook rechecks authority at call time, so agent state that still
  names a removed tool can never call it. It returns an explicit `block` if the
  capture read fails; it does not rely on Durable treating a throwing hook as
  denied, and it keeps storage error detail out of the model-visible reason.
- The workspace guard, `extraAllowedDirs`, `toolSandbox` and the rest of the
  execution policy are unchanged. Tool authorization decides which coding tools
  are enabled, not how far their filesystem or shell reach goes.

CLI `/tools` is read-only diagnostics: it lists the configured tool names and
states that configuration is the authority. There are no `/grant` or `/revoke`
commands: like any other unknown slash command they are rejected locally and
never sent to the model. The Telegram adapter has no tool-authority commands at
all.

### Captured tools of a scheduled isolated run

A scheduled run's target is a fresh, task-owned conversation with no session
key. At prepare, cron captures the names the current ceiling gives its
authenticated origin, together with that origin, in
`nanobot.config-tool-capture` (`{ originConversationId, tools }`). The capture
is a subset of config, never new authority: the call-time hook requires the name
to be in the current ceiling, the capture to name it, and the recorded origin to
still be an authenticated mapped chat.

Before `harness.resume()` every conversation owned by a live run task is
re-bounded: the gateway intersects the capture with the current `toolAllowlist`
and the validated origin, writes the intersection back, and the pre-resume
policy pass offers only that subset. An ended run, a missing or mismatched
capture, an unknown origin and an unmapped or non-chat origin all yield an empty
bound, so the target keeps no tool after its terminal commit. Finalize retires
that target's capture; a denied or reconciled target can instead keep an emptied
capture (`tools: []`), which authorizes nothing. A capture found on a
conversation that is not a validated live run target is retired by the policy
pass instead of being honored.

Every terminal commit of a run that already prepared a separate target retires
that target's capture and tools in the same commit: normal completion or a
recorded error, a missing target conversation, a missing job record, a generation
change or cancellation, and ownership fencing, plus the run task's abort handler.
A completed, failed, cancelled or superseded run therefore leaves no capture
behind for a later admission. A phase fault or a crash before that terminal
commit still leaves the capture until the next reopen, where the pre-resume pass
retires a target whose run already ended; a direct host submission in that
interval remains bounded by the call-time hook.


## Replay and reopen

The pre-resume pass rebuilds every mapped chat's offered tools from the current
`toolAllowlist`, so removing a configured tool and reopening removes it from
persisted policy before recovery can schedule or replay it. Native recovery
resolves a prepared call against that current policy, so a prepared call for a
removed tool settles as `Tool <name> was interrupted and may have partially run`
rather than rerunning. Captures of scheduled run targets are re-bounded as
described above.

Durable's tool hooks run in the call phase only, so a committed `execute` intent
resolves without them. Two rules keep that closed:

- Before `harness.resume()`, every conversation owned by a live cron run task is
  re-bounded against the current ceiling and its validated origin. The rewritten
  capture is what the pre-resume policy pass turns into the conversation's
  offered tools, so a new admission after a config change or origin loss is not
  offered the tool at all.
- The native coding tools have no `replay: "safe"` marker, so Durable treats them
  as unsafe: recovery never reruns an interrupted execution body. The synthetic
  replay fixtures in [`TOOL_REPLAY.md`](./TOOL_REPLAY.md) and
  [`NESTED_CODEMODE_REPLAY.md`](./NESTED_CODEMODE_REPLAY.md) remain the evidence
  for safe-tool replay under host-held tool state and for unsafe downgrades.

One narrow window is inherent: a call that passes `beforeTool` and records intent
can still execute after a concurrent configuration change. A configuration
change is not mid-execution cancellation, and Durable does not promise
exactly-once external effects for replay-safe tools.

## Optional direct-workspace Bubblewrap shell

With `toolSandbox: "bwrap"`, only the shell is wrapped; `read`, `write` and `edit`
continue to use the guarded host filesystem. The shell uses the same
`src/execution/policy.ts` deny patterns, environment allowlist, path guard and
timeout, then launches the existing
[`buildDirectBwrapArgs`](./DIRECT_BWRAP.md) argv directly, with no outer shell and
no managed copy or publish-back.

- The actual workspace is bound read-write at its real path. Its parent is masked,
  so a sibling config file is not visible; `/tmp` is a private tmpfs and the
  network namespace is the host's, matching Python. System paths are read-only.
- Bash command text keeps native tool semantics by using `/bin/bash -c` when
  available (then `/usr/bin/bash`, `/bin/sh`, `/usr/bin/sh`). This is a deliberate
  difference from Python's inner `sh -c`; the inherited shared shell policy still
  checks the original command text before wrapping.
- The sandbox receives only the policy environment. `HOME` is the workspace and
  `TMPDIR` is `/tmp` inside the sandbox, because the host scratch root is not
  mounted. The native bash spill file is written by the host parent under its
  private scratch root; the reported `fullOutputPath` is readable through `read`
  while the environment lives, but is not visible to an in-sandbox `bash` command.
  Spill and scratch paths remain environment-lifetime only.
- The shared timeout and process-group kill still bound the command; Bubblewrap
  adds `--unshare-pid` and `--die-with-parent` so its background descendants die
  with the sandbox. A command that cannot build or start the Bubblewrap argv fails
  closed; it is never retried on the host.

## Environment and native semantics

When tools are enabled, each conversation gets one cached `HostExecutionEnv`
built by `createHostExecutionEnv`:

- Root is the canonical configured `workspace`; extra roots are the canonical
  `extraAllowedDirs`. File operations use the shared path guard from
  `execution/policy.ts`. In bwrap mode this still applies to the native file
  tools; only shell commands are wrapped.
- `restrictToWorkspace: true` applies Python's practical shell guard: textual
  `../`/`..\\` and absolute or home paths outside the roots are refused with
  the workspace-boundary note.
- The shell gets only the policy environment (workspace `HOME`, private
  per-conversation `TMPDIR`, `PATH`/`LANG`/`TERM`); caller `env` and
  `inheritEnv` are ignored. The shared command deny list is active. In bwrap
  mode the command's `TMPDIR` is replaced with the sandbox's private `/tmp`.
- Scratch, temp and bash spill paths are private to that conversation and are
  removed on `Gateway.close`. They are never durable storage.
- The environment lives for the gateway lifetime, not one tool call. A failed
  creation is removed from the cache; `close` cleans every environment and then
  releases the store lock.
- Tool definitions, truncation, retained tail, streaming and spill behavior are
  the native Durable implementations. `read`/`write`/`edit` are unchanged. The
  `bash` wrapper declares the configured host default in the tool and timeout
  descriptions and replaces the native user-visible
  `Command timed out after undefined seconds` message with that duration when
  the host default fires; execution, output and spill are untouched. With
  `toolTimeoutSeconds: 0` no default is declared or applied.

## Non-claims and remaining gaps

- Host shell execution is not confinement. Deny patterns, the environment
  allowlist and the path guard reduce accidental damage; a permitted program can
  still read host files, including credentials, and reach the network.
- Hard links inside a root to an outside inode are indistinguishable by path;
  writing or removing through one affects the outside inode. A descendant that
  creates a new process group (`setsid`) escapes process-group teardown.
- Python's exec URL guard is **not** ported into the shared policy or this host
  integration. A URL in shell text is not scanned. The deny list and path guard
  do not close that gap.
- Bubblewrap shell mode is optional damage reduction, not hostile isolation. It
  has no CPU, memory, PID-count or disk quota, and a permitted command can still
  use the network. It does not sandbox the native file APIs or Python's exec URL
  guard. Code Mode, approval UI, resource quotas and hostile-tenant isolation are
  not added here. `toolAllowlist` names are not user approvals and no
  human-approval flow is implied.
- The gateway knows only the four native coding tool names; hosts that install
  additional extensions into the same harness must not reuse this call hook as a
  policy for them.

## Checks

Validated with the committed offline suites on this branch:

```bash
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm run test:behavior
npm run test:execution
```

`tests/config-tool-authorization.behavior.test.mjs` covers configured authority
for a mapped chat, refusal of a call outside the configured set, no coding
authority for forks, raw, state-only and root conversations, a reopen under a
narrowed `toolAllowlist`, and the call-time capture hook.
`scripts/core-acceptance.mjs` default offline run exercises configured
`read`/`write`/`edit`, the native refusal of a `bash` call this configuration
does not register, native compaction and a fresh-process reopen under a narrowed
`toolAllowlist`; the real-flow rehearsal keeps the full configured set instead.

Earlier bounded temporary probes (not committed as tests) used a faux provider, a
temporary workspace/data directory and the real `openGateway`:

- an impossible `toolTimeoutSeconds` was rejected at config/openGateway startup,
  and the bash declaration named the configured host default;
- `read`, `write`, `edit` and `bash` worked from real turns;
- lexical `../` and symlink escapes were refused for file tools, and the outside
  sentinel was unchanged;
- `rm -rf` was refused by the deny filter;
- a host-default 1 s timeout produced `Command timed out after 1 seconds`.

The optional bwrap shell was checked separately with bounded temporary workspaces
and a real Bubblewrap 0.9.0 binary: config validation, fail-closed startup for a
missing or non-Bubblewrap binary, a real `openGateway` bash turn writing to the
actual workspace, `TMPDIR=/tmp`, masked siblings, host network namespace
unchanged, a host-readable spill path absent from the sandbox `/tmp`, timeout
teardown, and the shared path guard. No provider request, real credential,
network request, live data or permanent test file was used.
