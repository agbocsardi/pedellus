# MCP servers and Code Mode

The gateway can connect explicitly configured [Model Context
Protocol](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP
and make their tools reachable through Code Mode and tool search. The MCP client,
transports and teardown come from the pinned `@earendil-works/pi-mcp@1.4.0`
package; Code Mode and deferred discovery are the native
`@earendil-works/pi-durable` tools already wrapped by
[`src/extensions/codemode.ts`](./src/extensions/codemode.ts). This port does not
implement a parallel client, tool registry, runner, queue or retry layer.

Status: accepted, with one later authority expansion: agent-proposed server
management and owner-approved OAuth login for HTTP servers (below). Independent
review passed the standalone implementation (`4d61f50`) with documentation
corrections only (`1c38146`), then a fresh combined runtime/config/authority
review passed the integration with current main (`555d34c`) with no material
findings. A later independent review of the management/OAuth slice found
credential-exposure, disclosure, race, config-write and Telegram-delivery
defects; that pass is fixed here: OAuth fails closed around an unconfined shell,
`show` discloses the entire exact entry, approvals claim atomically, config edits
refuse a changed file, a login works on a staged grant, and the authorization URL
is a direct owner message outside channel state. A further review of that pass
found a path-check/open race in the coding tools, login races around cancellation,
generation capture and refresh rotation, a swallowed tool-listing failure and an
over-optimistic config-write claim; those are fixed here with the residual
limitations stated below. That review also proposed refusing OAuth whenever any
same-user process could read the grant file. The project does not carry that
boundary: the grant is a private `0600` file like the provider credential store,
same-user code (including the model's own shell and any stdio MCP server) can read
it, and no execution mode changes that. The guard is therefore removed and the
risk is documented instead of approximated by a mode check. All coverage is offline and
synthetic: no live MCP server, provider, credential or production data has been
used, and no real OAuth provider has been contacted. The management/OAuth slice
is verified against loopback fixture servers and a synthetic authorization server
only.

MCP is **off unless explicitly configured**. With no `mcp` block,
`"enabled": false`, or no enabled server entry, the gateway starts no MCP client,
registers no MCP tool and does not install Code Mode: the shipped CLI keeps
exactly the tools it had.

## Configuration

`mcp` is a top-level config block next to `cron`. It is a separate connection
authority from `toolAllowlist`; `toolAllowlist` still names only the coding tools
`read`, `write`, `edit` and `bash`.

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "description": "Read files under the workspace"
      },
      "docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "DOCS_MCP_AUTHORIZATION" }
      },
      "calendar": {
        "url": "https://calendar.example.com/mcp",
        "oauth": true
      }
    }
  }
}
```

- `enabled` (required, boolean) is the switch. `false` discards `servers`; no
  client is ever started.
- `servers` maps a server name to one entry. Names use only letters, digits,
  `_` and `-`. Two names that differ only by `-`/`_` (or case) are rejected
  because they would share one tool namespace.
- Exactly one of `command` (stdio) or `url` (Streamable HTTP) is required. The
  legacy HTTP+SSE transport, `type`, `auth`, `exposure` and `toolExposure` are
  rejected with an explanation. There is no implicit `mcp.json` discovery, no Pi
  user settings import, and no `!command` value interpolation.
- `enabled: false` on one entry keeps it in the config without connecting it.
- `description` is one line (at most 200 characters) used as the Code Mode
  namespace summary.
- `timeoutSeconds` bounds each request, including startup. Default 60, range
  1–600.
- `command` is one executable; `args` is its argument vector. It is never
  interpreted by a shell. `cwd` resolves against the workspace and must stay
  inside it.
- `url` must be `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`.
  Credentials in the URL and fragments are rejected. Redirects are refused, so a
  configured `Authorization` header cannot be forwarded to another origin.
- `oauth` (HTTP only, boolean) uses a bearer token from this runtime's private
  MCP token file instead of a configured header. It cannot be combined with an
  `Authorization` header: an entry selects one credential. With no stored grant
  the entry fails closed as `auth-required` and no request, dynamic registration
  or browser flow happens; see [OAuth login](#oauth-login). It works in every
  execution mode; the file's trust boundary is described there.

### Secrets

Raw tokens never appear in the config. `env` and `headers` map a child variable
or HTTP header to the **name** of a host environment variable, the same way
`credentials.<provider>` and `telegram.tokenEnv` do:

```json
{
  "servers": {
    "internal": {
      "command": "internal-mcp",
      "env": { "INTERNAL_MCP_TOKEN": "INTERNAL_TOKEN_ENV_NAME" }
    }
  }
}
```

A stdio child does not inherit the host environment. It receives `PATH` (to find
the command) and exactly the configured values; anything else, for example
`HOME`, must be named explicitly. A missing variable fails that server's
startup with a fixed code; the failure carries no value. HTTP headers are
resolved the same way from the host environment at connect time.

## Authority

Connecting a server is owner authorization for the gateway to run that
configured subprocess or contact that URL. It is not a model-chosen shell
execution and grants nothing else. A configured stdio server runs as a native
host process owned by the gateway; `toolSandbox: "bwrap"` applies only to the
shell backend and does **not** wrap MCP servers. There is no additional MCP
confinement layer, so treat a server command as host-level authority.

MCP tools are enabled in authenticated mapped ordinary chats and in ordinary workers
with an exact per-tool capture from an authorized spawning chat. Neither requires a
nonempty coding `toolAllowlist`. Workers may discover and compose captured MCP tools,
but never receive Telegram, cron or recursive worker delegation. A worker-specific
call-time hook checks its durable capture; reopening prunes it against current config,
and completion/cancellation retires it. See [worker authority](WORKERS.md).
Code Mode can also be enabled independently (`codemode.enabled`). Root, state,
forked, raw and other task-owned conversations, digest runs and scheduled-run automation conversations
remain denied. MCP connections and their configured cwd remain gateway-owned, not
isolated inside a worker's shell sandbox or worktree.

The ceiling is enforced twice: the tool filter enables the tools per
conversation, and a call-time `ToolTask` hook rechecks the conversation and the
server's live state on every call. When MCP is installed, the hook also covers
`codemode` and `tool_search`; an independent Code Mode authority hook covers
them when only Code Mode is enabled. The coding-tool ceiling delegates each
fixed name only to the hook that is actually installed. A call from a
conversation that lost authorization, a nested call naming a tool the current
scope no longer has, a persisted selection or a prepared replay therefore fails
closed. Nested calls to tools still in the current scope succeed. Coding tools
reached from a script are still bounded by `toolAllowlist`: a disabled tool is
neither listed in `ALL_TOOLS` nor callable.

MCP tool annotations (`readOnlyHint` etc.) are untrusted server hints and are not
used for authorization. No MCP tool call is retried by this layer: a dropped
response may mean the server already performed the call. An interrupted call is
Durable's default `unsafe` replay policy, so it is not rerun after a restart.

Configuration and account authorization stay owner decisions. The assistant can
*propose* a server entry, a login, a logout or a removal, but only through a
recorded request that the owner approves; see [owner-approved
management](#owner-approved-management). No model tool writes configuration,
starts a browser flow, stores a token or connects a new server, and a proposal
grants nothing until the decision.

## Owner-approved management

The one model-facing management tool is `mcp`. It is a thin request recorder, not
an authority:

| action | what it does |
| --- | --- |
| `status` | bounded read-only listing: configured servers with live connection state, plus waiting and recent requests |
| `propose` | records one verbatim MCP config entry (`command`→stdio or `url`→HTTP, plus optional `args`, `cwd`, `env`, `headers`, `oauth`, `description`, `timeoutSeconds`, `enabled`) |
| `login` | records an OAuth login request for a configured HTTP server |
| `logout` | records a request to delete a stored grant |
| `remove` | records a request to delete a configured entry |

A proposal is validated with the same parser a gateway start uses, is written
once into a root-scoped Durable document (never rewritten, surviving a restart),
and is consumed by the decision. It is offered only to authenticated mapped
ordinary chats — never a worker, fork, root, digest or scheduled-run
conversation — and it cannot approve itself: it cannot approve, deny, write
configuration, start a flow or read a grant. `env` and `headers` values are host
environment variable *names*, so a proposal carries no secret value.

Decisions come from two owner surfaces and nowhere else:

- the attached terminal, `/mcp`, `/mcp show <id>`, `/mcp approve <id>`,
  `/mcp deny <id>`;
- the authenticated Telegram owner chat, the same four forms.

`/mcp show <id>` is the disclosure: the normalized shape, the **entire exact
entry** that would be written (never truncated; a proposal is bounded at 8 KiB),
and every effect of an approval on the `mcp` block. A `remove` request shows the
**entire exact entry** that would be deleted, taken from this gateway's open
configuration; its approval deletes only that entry and refuses when the entry on
disk no longer parses to it. A stdio command is shown as
"a local process the gateway would launch on this host", and every
header/environment mapping is shown as `header <- host environment variable
NAME`. Read it before approving; approval is exactly as powerful as the owner
writing that entry by hand. The disclosed block is the one this gateway opened
with, and a `config` approval refuses when the block on disk is no longer that
one (see below), so the owner never approves an effect that was not described.
`/mcp` and `/mcp show` are read-only and cost no model
call. Approve/deny run as durable owner controls with the same acknowledgement,
gating and replay semantics as `/digest`.

What an approval does:

- `config`: writes `mcp.servers.<name>` into this gateway's own configuration
  file and sets `mcp.enabled: true`, then removes the request. Only the approved
  entry may become newly active: when that block was disabled on disk, every
  other entry there is pinned to `enabled: false` first. The write is atomic
  (temporary file in the same directory, then rename), keeps the existing file
  mode, changes nothing outside the `mcp` block, and is refused unless the whole
  merged document parses. It is also refused, before writing, when the block on
  disk is not the one the disclosure described — same `enabled` flag and same
  entry names as the configuration this gateway opened with — because otherwise an
  entry could land with pinning or enabling effects the owner never saw; restart
  the gateway and review again in that case. Managed edits are serialized inside
  this process, and
  the file is reopened once the complete replacement document has been written to
  a temporary file and immediately before the rename: if its bytes or its
  identity (device, inode, size, mtime) changed since the edit was prepared, the
  approval is refused without writing. Limitations: JSON is re-serialized with
  two-space indentation, so hand formatting and key order are not preserved; the
  rename gives the file the gateway user's ownership; a symlinked configuration
  file is refused rather than followed; and the identity/bytes check and the
  rename are still two operations, so an outside writer that lands in the few
  microseconds between them is overwritten. POSIX has no compare-and-swap for
  file content and no lock an arbitrary editor honors, so that window is narrowed
  and disclosed rather than claimed closed. A written entry connects at the
  **next gateway start** — this gateway keeps the configuration it opened with,
  and `/restart` is the existing owner control that re-reads it.
- `login` (and a `config` entry with `"oauth": true`): starts the flow described
  below and returns the one-time authorization URL to the approving surface. On
  Telegram the URL is a separate direct message, not part of the durable
  acknowledgement.
- `logout`: deletes the stored grant file and retires writers created before the
  decision. A live connection is unaffected, a refresh that completes afterwards
  cannot restore the deleted grant, and after the next start the entry reports
  `auth-required`.
- `remove`: deletes `mcp.servers.<name>`, but only the entry the disclosure showed:
  an entry on disk that no longer parses to that one is refused instead of
  deleted, and the refusal leaves the request available. `mcp.enabled` is left as
  it is: wiping the whole capability stays a separate owner decision.

A refused write leaves the request available; a decision that succeeded consumes
it. Approve and deny claim the request atomically before any asynchronous work,
so two concurrent decisions cannot both apply it. A denial can cancel a login
waiting for its browser (including one still starting), but it refuses to claim a
short non-login write was stopped halfway. Pending/running requests are bounded
(8) and further proposals are refused while that many wait; settled requests are
pruned to the most recent 8. A request left `running` by a restart or a shutdown
that could not settle it is repaired durably as `failed` on the next read or
proposal, so it stops counting against that bound and cannot leave the gateway
permanently unable to accept proposals.

## OAuth login

`"oauth": true` on an HTTP entry means the gateway reads a bearer token from this
runtime's private token file (under the canonical data directory, mode `0600`,
directory `0700`, one file per exact server URL). Tokens never appear in the
configuration, a conversation entry, a tool result, a channel message or the
`gateway.mcp` status.

### What the private file does and does not protect

`mode 0600` in a `0700` directory means another *user* cannot read the grant. It
does not mean the model cannot: everything the model can ask this runtime to run
— the coding shell (`toolSandbox: "host"`, and a Bubblewrap shell whose mount view
includes the data directory), a configured stdio MCP server, a worker — runs as
the same OS user and can read any file that user can. That is the same trust
boundary as the provider credential store (`auth.json`) and is accepted, as it is
in Python nanobot's `FileTokenStorage`: the protection is file permissions against
other users, not isolation from same-user code.

What the runtime does guarantee instead:

- token material never appears in the configuration, a conversation entry, a tool
  result, a log line, a channel message or the `gateway.mcp` status and `/mcp`
  listings; the owner-approved browser flow hands the authorization URL to the
  owner surface only, never to the agent;
- the file is written atomically with a private mode, one file per exact server
  URL, and only an owner-approved logout (or an approved login/refresh, see below)
  rewrites it;
- a refusal or a failed attempt never deletes it.

Anyone who can read the file can impersonate the owner at that server. If you
believe it was copied — for example because you ran an untrusted stdio server or
let the agent run shell commands with access to the data directory, and you do not
trust that code — treat the grant as compromised: `logout` deletes the local file,
and revoke the client at the provider's console (deleting the file does not revoke
the token server-side).

Login is always owner-initiated and gateway-run:

1. the assistant, or the owner, asks for a login; the owner approves the request;
2. the gateway starts the native `@earendil-works/pi-mcp/oauth` authorization code
   flow with PKCE from a staged copy of the stored grant: protected-resource and
   authorization-server discovery, dynamic client registration for this attempt's
   loopback redirect URI, and state generation;
3. the approving surface receives the one-time authorization URL. Open it as the
   owner in a browser that can reach this host and finish consent. The URL carries
   this attempt's `state`, is never sent to the model, and is never written into a
   transcript or durable channel state;
4. the loopback callback delivers the code; the gateway exchanges it in the staged
   state, verifies the result with one real connection and tool listing, and only
   then installs it as the stored grant (a rotation of the stored grant that the
   starting connection performed is adopted earlier, because the server has
   already issued it);
5. one internal result entry reaches the origin chat's agent, so it can relay
   "login complete / failed" and tell the owner to restart. It carries the server
   name, the request ID, the fixed outcome and the discovered tool count — never
   the URL, the code, the verifier or a token.

Bounds and rules: one flow at a time, reserved before the attempt starts; a
5-minute deadline covers the initial connection, its tool listing and the browser
step; the callback
listener is loopback-only on `127.0.0.1` with an ephemeral port; `/mcp deny`
cancels a running flow, including one still setting up and one already
verifying; closing the gateway aborts it, and cancellation is rechecked up to the
replacement's irreversible rename, so a denial either installs nothing or is
reported as the grant being there. The attempt works on a staged file seeded with
the stored grant's durable material only (client registration, tokens, discovery):
the transient `state` value and PKCE verifier of an earlier attempt are dropped,
so every authorization attempt generates its own, and the staged file is read
together with the grant generation it will commit against, so a grant
that still works makes the login a no-op and a logout that lands in between
retires the generation instead of handing the attempt a fresh expectation for a
grant it copied before the deletion. A failed or canceled attempt does not delete
or replace the stored grant. One exception is stated plainly because it is not a
local decision: a refresh the starting connection performed on the stored grant has
already been issued by the authorization server, which may have invalidated the
previous refresh token, so the rotation is adopted immediately (only while the
stored grant is still the one the attempt read) rather than discarded with a failed
or canceled startup connection. That is the only adopted rotation, and its
provenance is what bounds it: a refresh after the browser step rotates the
authorization this attempt just obtained, whose client registration is the
attempt's own loopback one, so those tokens are installed only as part of the
verified replacement and a failed or canceled verification discards them with the
staging file. An unverified browser authorization is never adopted. Each
committed grant increments a process-local generation: a logout during the
attempt, and a refresh from a connection created before it, cannot restore the
deleted grant. A gateway restart or crash ends a pending attempt; its URL is not
replayed, so request a new login.

On Telegram, the authorization URL is delivered as one direct plain message to
the authenticated owner chat after the durable acknowledgement, and is not
stored in the channel-state document. If that delivery fails (or the URL cannot
fit one message), the just-started login is canceled rather than left waiting for
nobody. A slow start that already published the "still pending" wording gets its
final outcome as a follow-up notice, so the only URL is never lost. The
terminal prints the URL in its command response and persists nothing.

A stored grant is refreshed on a `401` by the native provider; if the server
requires a fresh authorization instead, the connection reports `auth-required`
rather than opening anything.

Real limitations:

- The redirect URI is a loopback address on the **gateway host**. An owner whose
  browser runs elsewhere must forward that port over SSH; a provider that refuses
  a loopback public-client redirect (or requires a fixed registered redirect)
  cannot be used.
- Dynamic client registration must be supported. There is no configurable
  `client_id`/`client_secret`, no authorization-server metadata override and no
  device-code flow.
- A step-up scope challenge after a working grant is not implemented as an owner
  flow: the entry reports `auth-required`.
- A grant is keyed by the exact URL, so renaming a server keeps it while changing
  its URL does not. Logging out deletes it; nothing else does.
- A staged attempt can perform a real refresh, which may rotate the token
  server-side even if the later browser step fails. The rotated grant is adopted
  immediately (and only while the stored grant is still the one the attempt read),
  so the file keeps the token the server most recently issued; a provider that
  invalidates the old refresh token therefore does not leave an unusable grant
  behind. A logout that happens in the same window still wins, and then the token
  the server issued is discarded along with the grant the owner deleted.
- An already-working stored grant still makes an approved login a no-op. It is
  verified with one connection and a tool listing; if that listing fails, the
  result reports an unknown tool count instead of "0 tools".
- A staged attempt starts from the stored client registration. If a refresh fails
  transiently and the server then challenges for a browser, a provider that binds
  one exact loopback redirect URI to that registration may refuse it; log out and
  request a new login to register a fresh client.
- Tokens are stored in plaintext in a private file (like the provider credential
  store). There is no OS keychain integration and no isolation from same-user
  code: an owner, the model's own shell, a stdio MCP server or a worker can read
  them. What the runtime keeps out of model-facing surfaces is the token *content*
  (tool results, listings, notices, logs), not the file.
- The configuration write's external-change check (bytes plus file identity) and
  its rename are separate operations. An outside editor writing in that window can
  still be overwritten; no portable filesystem lock or content
  compare-and-swap exists for an arbitrary editor.

## Tools and discovery

Each connected server contributes one Code Mode namespace `mcp__<server>` and one
tool registration per server tool, named `mcp__<server>__<tool>`. Every character
outside `[A-Za-z0-9_]` becomes `_`. Tools whose sanitized names collide, or whose
name exceeds the 64-character provider limit, get a stable 8-hex-character
SHA-256 suffix derived from the exact server/tool pair, so the name does not
depend on the order the server listed them.

MCP tools are registered `deferred`:

- they are absent from the model's main tool list and from the `codemode`
  description;
- a Code Mode script reaches them through `searchTools()`, `describeTool()`,
  `ALL_TOOLS` or `tools.mcp__<server>__<tool>()`;
- `tool_search` can load a match into the next model call as a direct tool. That
  loaded declaration is agent state, so a later policy reapply (`listModels`,
  model selection, reopen) drops it and the model must search again;
- the server's own instructions are exposed only through
  `describeNamespace("mcp__<server>")`, bounded and labeled untrusted, never as a
  tool description.

A Code Mode tool call resolves to `content`, `structuredContent` and `isError`
from the MCP `CallToolResult`; `_meta` is deliberately dropped, and a response
without `content` is normalized to `[]`. An `isError` result resolves inside a
script and is reported as an error result for a direct model call. Input
schemas are forced to object schemas; a schema over 16 KiB is replaced with an
unconstrained object so declarations stay bounded and the tool stays callable.

With MCP disabled, Code Mode appears only when `codemode.enabled` explicitly
enables it; otherwise the gateway installs no Code Mode. See
[CODEMODE.md](./CODEMODE.md) for the native bundle's contract, budgets and
replay semantics.

## Lifecycle and limits

At gateway open the runtime connects every enabled server in parallel before the
Durable registry is built, then registers the discovered tools. A server that
fails to connect contributes no tool and no namespace and is reported as `failed`
through the gateway's `mcp.servers` status; the gateway still opens.

Whether anything is installed is decided before connecting:
`mcpHasEnabledServers` requires `mcp.enabled: true` **and at least one server
entry that is not `enabled: false`**. With no block, `enabled: false`, or only
disabled entries, no MCP client starts and no MCP-fed Code Mode is installed; an
independent `codemode.enabled` still applies on its own. When at least
one server is enabled but every enabled server fails, the MCP extension has no
tools and Code Mode is still installed with `tool_search` but **zero MCP
namespaces** for authenticated mapped chats. The status
carries only a fixed failure code (`start-failed`, `start-timeout`,
`missing-environment`, `auth-required`, `connection-closed`, `closed`),
never a transport message, response body, stderr tail, URL or configured value.
`auth-required` means the entry uses OAuth and has no usable stored grant (or the
server rejected it); only an owner-approved login changes that.

Tool calls pass `timeoutSeconds` (default 60) as the native per-request timeout
and the calling turn's abort signal. The committed cancellation test covers a
Code Mode *script deadline* aborting one pending call (one MCP cancellation, no
retry); an expired native request timeout itself is code-read, not separately
tested. Closing the gateway closes the Harness first, then stops Code Mode
admission and closes the sandbox and its workers, then closes every MCP client. A stdio server
is stopped per the specification — close stdin, then SIGTERM, then SIGKILL to its
whole process group — using the native transport. `gateway.close()` waits for
that teardown.

Known limits of this slice:

- OAuth is authorization-code + PKCE with loopback redirect and dynamic client
  registration only. There is no device-code flow, no configurable client
  identity, no authorization-server metadata override and no step-up flow; see
  the limitations under [OAuth login](#oauth-login), including the trust boundary
  of the private token file.
- Management is proposal + owner decision. There is no model- or chat-driven
  automatic approval, no approval by the agent's own message, no third owner
  surface, and no scheduled-run, worker or automation-scope proposal.
- No implicit `mcp.json`, Pi settings, extension-registered servers, resources or
  prompts API, resource tools, MCP Apps.
- `/mcp` is a control surface, not a dashboard: it lists configured servers and
  owner requests, but does not edit arbitrary configuration, change a live
  connection, expose a transport error, or show a token.
- A server's tool list is read at open. A `notifications/tools/list_changed`
  withdrawal makes the tool unreachable immediately; a newly added tool requires
  reopening the gateway. There is no lazy reconnect: a dropped connection makes
  that server's tools fail until the gateway is reopened. An approved entry or a
  new grant therefore takes effect at the next start (`/restart`).
- No config hot reload, no per-conversation MCP selection and no scheduled-run
  MCP authority.
- Startup and connection failures are visible only as fixed failure codes on the
  SDK `gateway.mcp` surface and in `/mcp`. The codes name no cause; inspect the
  server command yourself.
- The server's declared output schema is not used as a validation contract;
  results arrive as the server sent them, bounded by native output limits.

All coverage is synthetic: fixture stdio servers, loopback HTTP servers, a
loopback authorization server with PKCE, faux models, and no external network,
provider, credential or production data. No real OAuth provider has been
contacted, and no live acceptance of a browser-consent flow has been performed.
