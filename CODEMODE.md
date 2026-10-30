# Durable Code Mode integration

This is a reusable bundle for the TypeScript port; the factory itself is inert.
The gateway installs it when `codemode.enabled` is `true`, or — when that block
is absent — when MCP is explicitly enabled (`mcp.enabled: true` with at least
one enabled server), preserving the previous auto-enablement. An explicit
`codemode.enabled: false` disables it even with MCP configured (MCP tools then
stay deferred and unreachable). With neither condition it installs no
extensions and persists `tools: []`, exactly as before. The gateway already
establishes Durable's native default-deny settings before resolving or resuming
conversations, and it selects the bundle only for authenticated mapped chat
conversations. See [MCP.md](./MCP.md) for the connection config, tool naming and
call-time authority. This is only genuinely **per-conversation opt-in** when the
host establishes those default-deny settings before resolving or resuming
conversations. Durable defaults to selecting every installed extension when
`settings.extensions` is absent, and an unset conversation `tools` field enables
every tool in its selected extensions. Installing this bundle into those
permissive defaults is runtime-wide opt-in—not opt-in only for conversations
where the host calls `configure()`.

```ts
import { Type } from "@earendil-works/pi-ai";
import {
  configure, createRegistry, defineExtension, defineTool, Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { createCodeModeIntegration } from "./extensions/codemode.js";

// `storage`, `models`, `context`, and `modelRef` are host-owned. This example's
// strict default denies every extension; a host may list reviewed safe defaults.
const codeMode = createCodeModeIntegration(); // `models.*` stays disabled
const reviewedEcho = defineTool({
  name: "reviewed_echo",
  description: "Echo one reviewed string",
  parameters: Type.Object({ value: Type.String() }),
  callers: ["tools"], // nested Code Mode only, not a direct model tool
  execute: async ({ value }) => ({ output: [{ type: "text", text: value }] }),
});
const reviewedExtension = defineExtension({ name: "reviewed-echo", tools: [reviewedEcho] });
const registry = createRegistry();
for (const extension of codeMode.extensions) registry.install(extension);
registry.install(reviewedExtension);

const harness = await Harness.open(storage, {
  models,
  registry,
  settings: { extensions: [] }, // absent would select every installed extension
  // Native creation defaults, written before agent resolution. Keep creation
  // inputs host-mediated; ConversationCreateOptions.agent is applied afterward.
  conversationCreated: (tx, conversation) => configure(tx, conversation.id, {
    extensions: [], tools: [], modelTools: [],
  }),
}, context);

// Select the actual registered native registrations, not stand-in objects or
// strings. These are the registrations the Harness later resolves by name.
const registrations = registry.snapshot().tools().map(({ tool }) => tool as ToolRegistration);
const requireTool = (name: string): ToolRegistration => {
  const tool = registrations.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing installed tool: ${name}`);
  return tool;
};
const codemodeTool = requireTool(CODEMODE_TOOL_NAME);
const toolSearchTool = requireTool(TOOL_SEARCH_TOOL_NAME);
const conversation = await harness.createConversation({
  ownership: { kind: "ownerless" }, agent: { model: modelRef },
}, context);
await conversation.configure({
  extensions: [...codeMode.extensions, reviewedExtension],
  tools: [codemodeTool, toolSearchTool, reviewedEcho],
  modelTools: [codemodeTool, toolSearchTool],
}, context);

// Shutdown: stop Code Mode admission, close/abort the owning Harness so Durable
// can drain nested tasks, then wait for the sandbox's actual worker exits.
codeMode.stopAdmission();
await harness.close(context);
await codeMode.close();
```

## Contract and limits

`createCodeModeIntegration()` composes `@earendil-works/pi-durable@1.4.0`'s
`createCodemodeExtension` and `createToolSearchExtension`, with the exact direct
`@earendil-works/pi-codemode@1.4.0` dependency. The SDK barrel `src/index.ts`
exports the factory, fixed `CODEMODE_BUDGETS`, and integration/options types.
Importing that barrel or creating a bundle does not install it. Its extensions use Durable's registry and
Harness; this is not the coding-agent `ExtensionAPI` / `AgentSession`. It does
not implement a second runner, VM, journal, nested-call router, receipt store,
or discovery index. All script tool
calls use Durable `executeTool()` and therefore its schema validation, callers,
`ToolTask` hooks, ownership, replay policy, structured results and cancellation.
`tool_search` only loads the enabled deferred tools in the current agent. Disabled
or otherwise unenabled tools are neither searchable nor callable from Code Mode.

The host adapter clamps the native Code Mode options line (and injects defaults)
so Durable persists a restart-stable deadline and output budget with its native
run document. The QuickJS sandbox and shared worker admission defaults are:

| Limit | Default / behavior |
| --- | --- |
| QuickJS heap | 128 MiB per script; not a cap on Node worker/process RSS |
| Script deadline | 60 seconds, also the maximum accepted `timeout_ms` |
| Model-visible output | 4,000 tokens, also the maximum accepted `max_output_tokens` |
| Native tool output | Durable's 4 MiB / 100,000-line output limit |
| Worker capacity | Two workers per bundle; excess admission fails fast, no waiting queue |
| Shutdown | Stop admission, abort active Code Mode calls, close the native sandbox and wait for actual worker exit |

All Code Mode executions from one bundle share its two-worker capacity. Create
one bundle per Harness/runtime, not one per conversation, or each instance would
have a separate allowance; `tool_search` itself does not start a VM. Native `CodemodeSandbox`
can settle a cancelled result before the worker exits; this adapter holds each
slot through the native `acquireWorker()` release callback and makes `close()`
await `onWorkerStarted(exited)`. A non-interruptible native worker operation can
therefore delay shutdown. The QuickJS environment has no direct Node, filesystem,
network, or timer globals; injected tools still carry their own authority and
must be independently confined.

`models: true` is an explicit opt-in for Durable's additional `models.*`
capabilities. It is not enabled by default. Code Mode is model-only (scripts
cannot recursively start Code Mode); native deferred discovery is still available
to scripts through `searchTools()`.

## Native default-deny and host-selected tools

`extensions`, `tools` and `modelTools` are Durable's native conversation
configuration, not an expiring grant or a Nanobot authorization step.

`HarnessSettings.extensions` is the native default when an agent has no stored
extension selection (or a selection cleared with `null`); absent means every
installed extension. `HarnessOptions.conversationCreated` can store a native
`AgentChange` for each new or forked conversation before it is resolved. For
strict default-deny, pass `settings: { extensions: [] }` and set
`{ extensions: [], tools: [], modelTools: [] }` in that callback. If using a
non-empty default extension list, review every tool it contains: when `tools` is
unset, all tools in the selected extensions are enabled. Do not add the Code
Mode or tool-search extensions to the default list.

The `conversationCreated` callback runs before `ConversationCreateOptions.agent`
is applied. The host must mediate creation/configuration inputs rather than
forwarding untrusted `extensions`, `tools`, or `modelTools` changes. These are
native configuration APIs, not an authorization service.

For an enabled conversation, explicitly select the installed bundle extensions
and exact `ToolRegistration` values in `AgentChange.extensions` and
`AgentChange.tools`. `modelTools` only filters tools offered directly to the
model; it does not add an extension, enable a tool, or enable `executeTool()`
access. Nested Code Mode calls resolve from the conversation's enabled `tools`
filtered by `callers: ["tools"]`. The example above keeps `reviewed_echo` out
of direct model tools while explicitly enabling it for nested calls. Tool
registration names alone are not authorization.

These defaults do not revoke persisted selections. An existing conversation
with an explicit stored extension selection or tools override keeps it after
reopen, even if the Harness now uses `settings.extensions: []`; the creation
callback is not called for conversations already in storage. Before `harness.resume()`
(or `submit()`, `wait()`, or another operation that can start scheduling),
reinstall the extensions, load every persisted conversation, and reapply its
current host-approved native `configure()` values. For a conversation whose
selection is no longer approved, clear the extension override with
`extensions: null` (returning to the secure Harness default) and explicitly deny
tools/model tools, e.g.
`{ extensions: null, tools: [], modelTools: [] }`. Do this before starting the
scheduler; the settings default by itself is not a revocation mechanism.

## Shipped gateway wiring

`mcpHasEnabledServers` still gates the MCP client: `mcp.enabled` must be true
and at least one server entry must not be `enabled: false`. No block, a disabled
block, or only disabled entries means no client and no MCP namespaces. When that
gate passes, `openGateway()` connects the configured servers before building the
Durable registry. If every enabled server fails, Code Mode is still available
(for authenticated mapped chats) with `tool_search` and zero MCP namespaces.

Code Mode itself is an independent compositor. `codemode.enabled: true` installs
it without any MCP server; with no `codemode` block the previous rule applies
(MCP configured means Code Mode on). Its enabled tool filter includes
`codemode`, `tool_search` and the deferred `mcp__*` registrations when MCP is
connected, while `modelTools` offers only the first two until `tool_search`
loads a match. A dedicated authority hook extension is selected with the bundle
and blocks `codemode`/`tool_search` outside authenticated mapped chats; it does
not depend on MCP being connected. The coding ceiling delegates those two fixed
names to that hook and delegates `mcp__*` to the MCP extension's own call-time
hook, which rechecks the conversation and the server's live tool list.

Nested scripts resolve against the conversation's actual `callable` filter, not
the global registry, through native `executeTool()` and `ToolTask` hooks. That
makes every tool the current conversation holds composable — read/write/edit/
bash, `history`, `skill`, `cron`, `web_search`, `web_fetch`, configured MCP
tools and Telegram actions — without adding authority. Deferred MCP tools remain
discoverable through `searchTools()`/`ALL_TOOLS`; tools outside the ceiling (for
example `write` when only `read` is configured) are absent. The Telegram action
tool now accepts nested Code Mode callers while keeping its live-adapter,
current-chat, observed-target, write-ahead journal and task-id checks; an
unobserved target is denied by the host, not by a blanket caller rule. Code Mode
stays non-recursive (`codemode` and `tool_search` remain model-only).

The prior MCP-only wiring was accepted: standalone review passed `4d61f50` with
documentation corrections in `1c38146`, and a fresh combined
runtime/config/authority review passed the integration with `555d34c` with no
material findings. The independent-composition generalisation and the Telegram
caller change are a newer candidate change and are **not** part of that
acceptance; they require a fresh combined review before publication.

`gateway.close()` closes the Harness first, then this bundle (stopping admission
and waiting for sandbox workers), then every MCP client. An open that fails after
the bundle was created applies the same order. A gateway opened without MCP still
owns a sandbox if Code Mode is explicitly enabled.

## Replay and failure semantics

Durable journals Code Mode call results before delivering them to the deterministic
QuickJS replay, reattaches nested calls by their native keys, and owns `store()` /
`load()` in the native per-conversation rewindable document. A fork sees the
store as of its fork entry. A completed nested call is not rerun just because the
script resumes. An interrupted nested call follows *its own* replay setting:
unsafe calls return an interrupted error rather than being blindly replayed;
replay-safe calls can rerun and must be genuinely idempotent. This is storage and
submission replay behavior, **not** external-side-effect exactly-once safety.
An interrupted external request can have taken effect before its result was
committed. Durable `requestId` deduplicates admission, not the external effect.

A rejected nested tool call throws in the script unless its schema-bearing error
returns a structured value. A script can catch and discard an error and then
return success; this integration has no product-level failure-verification hook
that can infer a discarded error. That legacy worker/failure-verification
semantics remains open for later host policy. In particular, Durable `bash`
returns structured `{ output, exitCode, ... }` even for nonzero status. Such a
schema result can resolve to the script rather than throw, so scripts must inspect
`exitCode`; nonzero must not be presented as success. These probes used a synthetic
schema tool to verify the result shape and did **not** enable or run bash.

The helper does not own the Harness scheduler or nested Durable tasks. On host
shutdown, call `stopAdmission()`, then close/abort the owning Harness so its task
ownership drains, then call `close()` to wait for the actual worker exits. Closing
only the native sandbox is deliberately not a durable tool outcome; without
caller cancellation, native Code Mode can leave the task pending for recovery.

This bundle does not install native filesystem/bash tools or approve MCP server
configs, and it does not make P1 confinement pass. The gateway installs it when
Code Mode is explicitly enabled or, absent that block, when MCP is explicitly
configured next to the `@earendil-works/pi-mcp` client; the MCP integration has
its own call-time authority, described in [MCP.md](./MCP.md). Neither path
establishes P1 confinement. Enabling either is not evidence that P1, P2 as a
whole, or the TypeScript port has passed acceptance.

## Offline verification evidence

Committed synthetic conversation and crash/replay coverage is described in
[NESTED_CODEMODE_REPLAY.md](./NESTED_CODEMODE_REPLAY.md). Earlier temporary probes used Node
22.22.2, the actual Durable Harness and file-backed SQLite storage, the actual
QuickJS worker, faux models, and only synthetic tools. No provider credentials,
network, Telegram, bash, production host configuration, or production data were used.

- `/tmp/nanobot-p2-probes/verify-local.mjs` (run with
  `timeout 60s node --experimental-strip-types /tmp/nanobot-p2-probes/verify-local.mjs`):
  native tool-search exposes an enabled deferred tool; Code Mode invokes only
  enabled synthetic tools; disabled tool lookup/call fails; hooks deny before
  execution; a caught nested error may still yield a successful script; an
  uncaught error remains an error; structured synthetic exit code 7 is visible;
  `store` survives and forks as-of; output is clamped; an oversized user budget
  is persisted as 60,000 ms / 4,000 tokens; a third worker is denied at the
  two-worker limit; cancellation aborts both running nested calls; Harness tasks
  drain before helper close. Captured output:
  `/tmp/nanobot-p2-probes/local-result.json`.
- `/tmp/nanobot-p2-probes/verify-optin.mjs` (run with
  `timeout 60s node --experimental-strip-types /tmp/nanobot-p2-probes/verify-optin.mjs`):
  the actual Harness used `settings.extensions: []` and passed
  `conversationCreated` as the top-level Harness option, recording all five
  creation callbacks (A, B, C, D, and A's fork). The callback stored empty
  extension, tool, and model-tool selections before resolution. A explicitly
  selected the bundle and one synthetic reviewed effect; its script discovered
  and ran that effect once. An ungranted fork of A inherited the parent's stored
  grant, which the callback cleared before resolution; forged calls to
  `codemode`, `tool_search`, and the synthetic effect were unavailable, with no
  second effect. Independent B had no extension/tool grant and only a
  `modelTools` override; its forged calls were likewise unavailable. A separate
  Code-Mode-only conversation could not execute the omitted nested effect even
  when `modelTools` named it. Opening existing IDs invoked zero creation
  callbacks; B remained restricted, while stale C's explicit grant persisted
  until revoked through native `configure()` before `resume()`. Output is printed
  by the probe; it uses no provider credentials or external effects.
- `/tmp/nanobot-p2-probes/verify-replay.mjs` launches
  `/tmp/nanobot-p2-probes/replay-child.mjs`, sends the first actual Harness
  process `SIGKILL` after a completed synthetic effect and a second unsafe effect
  has written to a private local ledger, then reopens the same SQLite database.
  Evidence: `/tmp/nanobot-p2-probes/replay-result.json` and the private run
  directory named there. After reopen the run settled with the native
  `unsafe_effect was interrupted and may have partially run` error; ledger rows
  remained exactly `completed`, `unsafe-started` (one each). This shows completed
  nested-result replay and non-replay of an interrupted **unsafe** call, not
  rollback or exactly-once behavior for an external service.

The probes have bounded `timeout` limits (60 seconds for local integration,
30 seconds for restart recovery), three Harnesses maximum, two admitted workers,
and a 128 MiB QuickJS heap limit. They do not establish provider behavior,
filesystem confinement, non-interruptible-worker upper bounds, safe-tool effect
idempotency, or live service readiness.

### Parent integration verification

Final independent source/API review passed in `/tmp/pi-codemode-bundle-review.md`.
The candidate chain was integrated as `49f11d387`, `e150a0485`, and `e508567dd`,
with direct dependency declaration `be2453c84`. Parent typecheck/build/diff check
and inert SDK export/lifecycle smoke passed.

Parent ran the following private probes against the **parent's built package**,
selected with `PI_CODEMODE_CANDIDATE=/home/gergo/projects/pi-nanobot`:

- `/tmp/pi-nanobot-parent-codemode-local.mjs` and `...-optin.mjs`: adaptations of
  the reviewed worker fixtures with explicit built SDK imports; native boundaries,
  store/fork, two-worker capacity, cancellation, default-deny/new/fork/reopen and
  stale-grant revocation pass (65-second timeout/512-MB Node heap each).
- `/tmp/pi-nanobot-parent-codemode-edges.mjs`: independently written checks of
  missing host globals/recursion, CRLF and oversized option clamping, invalid-source
  and nested-schema rejection, actual QuickJS OOM/CPU deadline, independent caller
  and host cancellation, worker drain, idempotent close and post-close admission
  pass (65 seconds/512 MB).
- `/tmp/pi-nanobot-parent-codemode-replay.mjs` plus `...-replay-child.mjs`:
  independently written actual SIGKILL/SQLite reopen scenarios for safe and unsafe
  interrupted calls pass (110-second controller/256 MB, children 512 MB).
  Completed effect executes once; unsafe interruption is not rerun; the explicitly
  safe fixture runs again and completes using its own genuine fixed-key effect
  idempotency. This is not an external-effect exactly-once guarantee.

`/tmp/pi-nanobot-parent-sdk-inert.mjs` (40 seconds/512 MB) additionally imports the
public SDK and creates an uninstalled bundle, then uses the actual gateway:
forged `codemode`, `tool_search` and `bash` calls are rejected as unavailable,
Code Mode store is never created, and reopened conversation policy stays tool-less.
Parent storage crash/reopen and all six failure-path probes also still pass.
No live/paid integrations, execution environment or production store were used.
