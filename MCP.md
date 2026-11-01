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
findings. All coverage is offline and synthetic: no live MCP server, provider,
credential or production data has been used, and no real OAuth provider has been
contacted. The management/OAuth slice is verified against loopback fixture
servers and a synthetic authorization server only.

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
  or browser flow happens; see [OAuth login](#oauth-login).

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

`/mcp show <id>` is the disclosure: the exact entry, rendered from the validated
shape, with a stdio command shown as "a local process the gateway would launch on
this host" and every header/environment mapping shown as `header <- host
environment variable NAME`. Read it before approving; approval is exactly as
powerful as the owner writing that entry by hand. `/mcp` and `/mcp show` are
read-only and cost no model call. Approve/deny run as durable owner controls with
the same acknowledgement, gating and replay semantics as `/digest`.

What an approval does:

- `config`: writes `mcp.servers.<name>` into this gateway's own configuration
  file and sets `mcp.enabled: true`, then removes the request. The write is
  atomic (temporary file in the same directory, then rename), keeps the existing
  file mode, changes nothing outside the `mcp` block, and is refused unless the
  whole merged document parses. Limitations: JSON is re-serialized with two-space
  indentation, so hand formatting and key order are not preserved; the rename
  gives the file the gateway user's ownership; a symlinked configuration file is
  refused rather than followed. A written entry connects at the **next gateway
  start** — this gateway keeps the configuration it opened with, and `/restart`
  is the existing owner control that re-reads it.
- `login` (and a `config` entry with `"oauth": true`): starts the flow described
  below and returns the one-time authorization URL to the approving surface.
- `logout`: deletes the stored grant file. A live connection is unaffected, and
  after the next start the entry reports `auth-required`.
- `remove`: deletes `mcp.servers.<name>`. `mcp.enabled` is left as it is: wiping
  the whole capability stays a separate owner decision.

A refused write leaves the request available; a decision that succeeded consumes
it. Pending/running requests are bounded (8) and further proposals are refused
while that many wait; settled requests are pruned to the most recent 8.

## OAuth login

`"oauth": true` on an HTTP entry means the gateway reads a bearer token from this
runtime's private token file (under the canonical data directory, mode `0600`,
directory `0700`, one file per exact server URL). Tokens never appear in the
configuration, a conversation entry, a tool result, a channel message or the
`gateway.mcp` status.

Login is always owner-initiated and gateway-run:

1. the assistant, or the owner, asks for a login; the owner approves the request;
2. the gateway starts the native `@earendil-works/pi-mcp/oauth` authorization code
   flow with PKCE: protected-resource and authorization-server discovery, dynamic
   client registration for this attempt's loopback redirect URI, and state
   generation;
3. the approving surface receives the one-time authorization URL. Open it as the
   owner in a browser that can reach this host and finish consent. The URL carries
   this attempt's `state`, is never sent to the model, and is never written into a
   transcript;
4. the loopback callback delivers the code; the gateway exchanges it, stores the
   grant, and verifies it with one real connection and tool listing;
5. one internal result entry reaches the origin chat's agent, so it can relay
   "login complete / failed" and tell the owner to restart. It carries the server
   name, the request ID, the fixed outcome and the discovered tool count — never
   the URL, the code, the verifier or a token.

Bounds and rules: one flow at a time; a 5-minute deadline for the browser step;
the callback listener is loopback-only on `127.0.0.1` with an ephemeral port;
`/mcp deny` cancels a running flow; closing the gateway aborts it. Each attempt
discards stored client registration (the redirect URI changes per attempt) but
keeps an existing token until the new one is stored, so a failed attempt does not
destroy a working grant. A stored grant is refreshed on a `401` by the native
provider; if the server requires a fresh authorization instead, the connection
reports `auth-required` rather than opening anything.

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
- Tokens are stored in plaintext in a private file (like the provider credential
  store). There is no OS keychain integration, and an owner with the same filesystem
  access can read them.

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
  the limitations under [OAuth login](#oauth-login).
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
