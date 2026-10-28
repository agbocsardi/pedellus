# Opt-in coding tools and durable grants

`openGateway` can register the native Pi 1.4.0 `read`, `write`, `edit` and `bash`
tools over a guarded `HostExecutionEnv` on the **actual workspace**. It stays
disabled unless the host explicitly configures a non-empty `toolAllowlist`, and
even then a conversation receives no tool until it is explicitly granted.

This is W1 accidental-damage protection, not confinement. The shell can still
read host files, use the network, follow a hard link out of the workspace, or
escape process-group teardown with `setsid`. Those limits are the same ones
recorded for the host backend in [`EXECUTION.md`](./EXECUTION.md) and are not
weakened or hidden here. Bubblewrap (W2) and Code Mode are not part of this
slice.

## Activation

```jsonc
{
  "workspace": "./workspace",
  "dataDir": "./.nanobot-data",
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "toolAllowlist": ["read", "bash"],
  "toolTimeoutSeconds": 60
}
```

- An empty or absent `toolAllowlist` means no tool extension and no host
  execution environment. Existing gateway behavior is unchanged.
- The allowlist is the host-owned **ceiling**. Every name must be one of
  `read`, `write`, `edit` or `bash`; an unsupported name fails startup before
  provider or storage setup. The ceiling does not itself grant anything.
- `toolTimeoutSeconds` is the config-level default for the host shell. Absent
  keeps the shared policy default (60 s); `0` disables the default timeout. A
  caller-supplied per-call timeout is capped by the shared policy at 600 s. The
  value must be an integer from `0` to `2_147_483`; an unrepresentable value is
  rejected at startup rather than failing on the first `bash` call.
- `extraAllowedDirs` remains an explicit list of additional canonical
  filesystem roots. They are not created, and the data directory must stay
  disjoint from them.

## Per-conversation grants

Grants live in the latest-only conversation document `nanobot.tool-grants`
(`{ grants: { [name]: expiresAtEpochMs } }`). A fork starts with an empty grant
document (`fork: "initial"`), so a fork is default-deny even if its copied agent
state still names tools.

`Gateway` exposes:

```ts
listToolGrants(sessionKey, context): Promise<readonly GatewayToolGrant[]>;
grantTools(sessionKey, grants, context): Promise<readonly GatewayToolGrant[]>;
revokeTools(sessionKey, names, context): Promise<readonly GatewayToolGrant[]>;
```

`grants` is an array of `{ name, expiresAt }`:

- `name` must be in the host ceiling.
- `expiresAt` is a future integer epoch millisecond timestamp. There is no
  permanent or implicit grant.
- Duplicate names are rejected.
- `revokeTools` removes names and is idempotent for names that are not granted.

The conversation must already exist (`conversationFor`). A grant does not widen
the ceiling, and another conversation's grants have no effect on this one:
agent tool filters are read from that conversation's own document.

Every native conversation creation goes through the Durable `conversationCreated`
hook, which retires any grant document and writes empty `tools`/`modelTools`
filters before the optional `agent` convenience. This covers raw ownerless
creation, forks (whose agent state is copied from the parent), and task-created
conversations, so they are not offered inherited tools in the first place. A
fork's grant document is `fork: "initial"` as a second layer. Durable still
applies a caller-supplied `ConversationCreateOptions.agent` after this hook; the
Gateway does not pass one that re-adds tools.

Emptying `toolAllowlist` retires the grant document of every conversation before
resume. Re-enabling the ceiling therefore starts from default-deny again instead
of resurrecting a previously granted tool. An absent document is not created by
this retirement pass.

## Replay and reopen

Before `harness.resume()`, the gateway scans every conversation, removes expired,
malformed and out-of-ceiling grants from the document, and rewrites the
conversation's native `tools`/`modelTools` filters to the remaining grants. A
revoked or expired grant is therefore **removed from persisted policy before
recovery can schedule a tool**. Native recovery resolves a prepared call against
that current policy, so a prepared call for a removed tool settles as
`Tool <name> was interrupted and may have partially run` rather than rerunning.

A `beforeTool` hook rechecks the grant document at call time, so expiry between
reopen and a call blocks before intent with `Tool <name> grant expired ...`.
Revocation also reapplies the agent filter immediately, so later calls are no
longer offered the tool. The hook returns an explicit `block` if the grant read
fails; it does not rely on Durable treating a throwing hook as denied, and it
keeps storage error detail out of the model-visible reason.

The native coding tools have no `replay: "safe"` marker, so Durable treats them
as unsafe: recovery never reruns an interrupted execution body. The existing
synthetic replay fixture in
[`TOOL_REPLAY.md`](./TOOL_REPLAY.md) remains the evidence for safe-tool replay
under explicit grants and for unsafe downgrades.

One narrow window is inherent: a call that passes `beforeTool` and records
intent can still execute after concurrent expiry or revocation. Revocation is
not mid-execution cancellation, and Durable does not promise exactly-once
external effects for replay-safe tools.

## Environment and native semantics

When tools are enabled, each conversation gets one cached `HostExecutionEnv`
built by `createHostExecutionEnv`:

- Root is the canonical configured `workspace`; extra roots are the canonical
  `extraAllowedDirs`. File operations use the shared path guard from
  `execution/policy.ts`.
- `restrictToWorkspace: true` applies Python's practical shell guard: textual
  `../`/`..\\` and absolute or home paths outside the roots are refused with
  the workspace-boundary note.
- The shell gets only the policy environment (workspace `HOME`, private
  per-conversation `TMPDIR`, `PATH`/`LANG`/`TERM`); caller `env` and
  `inheritEnv` are ignored. The shared command deny list is active.
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
- No bubblewrap (W2), Code Mode, approval UI, resource quotas or hostile-tenant
  isolation is added here. `toolAllowlist` names are not user approvals and no
  human-approval flow is implied.
- The gateway knows only the four native coding tool names; hosts that install
  additional extensions into the same harness must not reuse this grant hook as
  a policy for them.

## Checks

The change was validated with the existing offline suites:

```bash
cd packages/pi-nanobot
npm run typecheck
npm run test:behavior   # 155 checks
npm run test:execution  # 9 checks
```

Bounded temporary probes (not committed as tests) used a faux provider, a
temporary workspace/data directory and the real `openGateway`:

- default-deny before a grant; grants are conversation-scoped;
- forks and raw ownerless conversations received no tools before any explicit
  configure call;
- emptying the ceiling retired the persisted grant document, and re-enabling did
  not resurrect the tool;
- a throwing grant snapshot produced a block result rather than an exception;
- an impossible `toolTimeoutSeconds` was rejected at config/openGateway startup,
  and the bash declaration named the configured host default;
- `read`, `write`, `edit` and `bash` worked from real turns;
- lexical `../` and symlink escapes were refused for file tools, and the outside
  sentinel was unchanged;
- `rm -rf` was refused by the deny filter;
- a host-default 1 s timeout produced `Command timed out after 1 seconds`;
- a grant that expired mid-session was blocked by the `beforeTool` hook, then
  pruned before the next resume;
- a SIGKILL during a real `bash` effect with a grant revoked before reopen left
  exactly one effect, settled the call as interrupted, and removed the tool
  before resume.

No provider request, real credential, network request, live data or permanent
test file was used.
