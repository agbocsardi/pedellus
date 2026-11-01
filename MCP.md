# MCP servers and Code Mode

The gateway can connect explicitly configured [Model Context
Protocol](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP
and make their tools reachable through Code Mode and tool search. The MCP client,
transports and teardown come from the pinned `@earendil-works/pi-mcp@1.4.0`
package; Code Mode and deferred discovery are the native
`@earendil-works/pi-durable` tools already wrapped by
[`src/extensions/codemode.ts`](./src/extensions/codemode.ts). This port does not
implement a parallel client, tool registry, runner, queue or retry layer.

Status: accepted, with one later authority expansion: direct agent management of
server configuration and OAuth login for HTTP servers (below). An authenticated
mapped ordinary chat asks the assistant; the management tool validates, writes
and applies the change, and a login link is delivered directly to that same
owner surface. There is no proposal record and no `/mcp approve` gate. The
security boundary is unchanged in the parts that matter: configuration writes
keep the serialized atomic edit, whole-document validation, stale-file refusal
and exact-entry removal binding, and OAuth keeps the native PKCE/state/issuer
flow, staged grant verification, generation-based logout/cancellation and the
one-flow bound. A later independent review of the earlier proposal/approval
slice found credential-exposure, disclosure, race, config-write and
Telegram-delivery defects; those fixes remain in the direct path (a private
delivery failure cancels the attempt, config edits refuse a changed file, a
login works on a staged grant, and callback values never enter a model result
or transcript). The scope is channel-neutral: the active foreground channel
(attached CLI or authenticated Telegram chat) receives its own link and consumes
its own pasted callback; nothing is broadcast to another attachment. All
coverage is offline and synthetic: no live MCP server, provider, credential or
production data has been used, and no real OAuth provider has been contacted.
The management/OAuth slice is verified against loopback fixture servers and a
synthetic authorization server only.

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

Configuration and account authorization stay owner decisions, now exercised by
an explicit request in an authenticated mapped ordinary chat. The `mcp` model
tool validates and writes that one entry, starts one login, deletes a grant or
removes an entry directly; see [direct owner-authorized
management](#direct-owner-authorized-management). A stdio entry is a local
process the gateway launches on this host, so asking for one is asking for that
host-level authority. The tool is never offered to workers, forks, the root,
digest targets or scheduled-run automation conversations, and it cannot widen
`toolAllowlist` or worker captures. No scheduled run, worker or automation scope
can manage MCP.

## Direct owner-authorized management

The one model-facing management tool is `mcp`. It acts only in an authenticated
mapped ordinary chat with a live owner surface for that exact session:

| action | what it does |
| --- | --- |
| `status` | bounded read-only listing: configured servers with live connection state, plus any login waiting for a callback |
| `add` (alias `configure`) | validates and writes one MCP config entry (`command`→stdio or `url`→HTTP, plus optional `args`, `cwd`, `env`, `headers`, `oauth`, `description`, `timeoutSeconds`, `enabled`), then applies it live |
| `login` | starts one native OAuth login for a configured, enabled HTTP entry |
| `logout` | deletes the stored grant and retires its live tools |
| `remove` | deletes the configured entry and retires its live tools |

An `add` carrying `"oauth": true` writes and activates the entry, then starts
the login when no usable grant connects it. `env` and `headers` values are host
environment variable *names*, so no secret value enters the tool call or its
result. A stdio `command` is a local process the gateway will launch; an HTTP
`url` is one origin the gateway will contact.

Configuration writes keep the same guarantees as before:

- edits are serialized per configuration path inside this process. Management
  operations are serialized too, so two direct actions cannot interleave.
- the file is read into a snapshot, only `mcp.enabled` and
  `mcp.servers.<name>` are changed, and everything else is preserved.
- the file is reopened once the complete replacement exists and immediately
  before the rename; a changed byte or file identity refuses the write.
- when the whole block was disabled, every other entry present is pinned to
  `enabled: false`, so an add activates only the entry that was asked for.
- the whole merged document is validated with the parser a gateway start uses,
  the write is atomic, keeps the existing mode and refuses a symlink.
- an add records the entry it wrote; a remove deletes only the entry the current
  gateway configuration still holds, and refuses an on-disk entry that no longer
  parses to it.

Live activation is part of the same action: a new or changed entry is connected
now, a removed one is closed, registrations and Code Mode namespaces are
rebuilt, and the current authenticated chats and live workers are re-policied.
Existing worker captures are intersected with the new state, never widened by a
new server. See [lifecycle](#lifecycle-and-limits).

Login delivery is channel-neutral and direct:

1. the assistant starts the login in the request's authenticated foreground
   chat. The one-time authorization URL is delivered to that surface only, as a
   direct owner message or terminal output — never a tool result, transcript
   entry or durable channel outbox record.
2. the owner opens it on a phone or another device. A same-host browser still
   completes the normal loopback callback. When the browser cannot reach this
   host, the owner pastes the callback URL back into the same chat.
3. ingress recognizes a callback-shaped URL before transcript admission or model
   dispatch and offers it to the login lifecycle. It must be the exact active
   attempt's loopback origin, port, path and `state`, bound to the initiating
   session (and, on Telegram, the current authenticated sender of that private
   chat), and unused. Malformed, stale, foreign, cross-chat and replayed
   callbacks are consumed and refused with fixed text; their code, state,
   verifier and tokens are never stored, logged, returned to the model or sent
   to a diagnostic. The pasted host is never fetched; only the active loopback
   listener receives the validated response.
4. the native flow exchanges the code, verifies the staged grant with one real
   connection and tool listing, commits it, reconnects the server, refreshes
   registrations and policy, and sends one fixed outcome notice to the same
   surface. Tools are callable on the next request; no gateway restart is
   needed.

A URL delivery failure cancels that just-started attempt and is not blindly
retried. If the callback arrives normally in the browser, the same completion
and notice apply. `/mcp` remains an optional read-only status command; no slash
approval is required or offered.

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
  listings; a login hands the authorization URL to the initiating owner surface
  only, never to the agent;
- the file is written atomically with a private mode, one file per exact server
  URL, and only an explicit logout (or the login/refresh flow, see below)
  rewrites it;
- a refusal or a failed attempt never deletes it.

Anyone who can read the file can impersonate the owner at that server. If you
believe it was copied — for example because you ran an untrusted stdio server or
let the agent run shell commands with access to the data directory, and you do not
trust that code — treat the grant as compromised: `logout` deletes the local file,
and revoke the client at the provider's console (deleting the file does not revoke
the token server-side).

Login is owner-initiated in an authenticated foreground chat and gateway-run:

1. the assistant, on the owner's ordinary request, starts the login directly;
2. the gateway starts the native `@earendil-works/pi-mcp/oauth` authorization code
   flow with PKCE from a staged copy of the stored grant: protected-resource and
   authorization-server discovery, dynamic client registration for this attempt's
   loopback redirect URI, and state generation;
3. the initiating surface receives the one-time authorization URL. Open it as the
   owner and finish consent. The URL carries this attempt's `state`, is never sent
   to the model, and is never written into a transcript or durable channel state;
4. the loopback callback delivers the code, or the owner pastes the callback URL
   back into the same chat. The pasted form is validated against the exact active
   loopback origin, port, path and state, and replayed only to that listener; no
   arbitrary URL is fetched;
5. the gateway exchanges the code in the staged state, verifies the result with
   one real connection and tool listing, and only then installs it as the stored
   grant (a rotation of the stored grant that the starting connection performed is
   adopted earlier, because the server has already issued it);
6. the server reconnects, registrations and namespaces refresh, the current chat
   and worker policy is reapplied, and one fixed outcome notice reaches the same
   surface. It carries the server name and outcome — never the URL, the code, the
   verifier or a token. Tools are callable on the next request, with no restart.

Bounds and rules: one flow at a time, reserved before the attempt starts; a
5-minute deadline covers the initial connection, its tool listing and the browser
step; the callback
listener is loopback-only on `127.0.0.1` with an ephemeral port; closing the
gateway aborts a running flow, including one still setting up and one already
verifying, and cancellation is rechecked up to the replacement's irreversible
rename, so a canceled attempt either installs nothing or is reported as the grant
being there. A second login is refused while one waits for its callback. The attempt works on a staged file seeded with
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

The active foreground channel owns the exchange. On Telegram, the URL is one
direct plain message to the initiating authenticated private chat and is not
stored in channel state; a pasted callback is accepted only from the current
authenticated sender binding of that exact chat, before transcript admission. In
the attached CLI, the URL is one transient terminal line over the private local
socket and a callback-shaped line is offered to the login lifecycle before it
becomes model input; neither the URL nor the callback is persisted. If delivery
fails (including a URL too long for one message), the just-started login is
canceled rather than left waiting for nobody. Ambiguous delivery is not blindly
retried.

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
- An already-working stored grant still makes a login a no-op. It is
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

With no MCP server and no explicit `codemode.enabled`, the gateway installs no
Code Mode. An independent `codemode.enabled: true` applies on its own; the
legacy tie installs Code Mode once a live `add` first brings an enabled server.
See [CODEMODE.md](./CODEMODE.md) for the native bundle's contract, budgets and
replay semantics.

## Lifecycle and limits

At gateway open the runtime connects every enabled server in parallel before the
Durable registry is built, then registers the discovered tools. A server that
fails to connect contributes no tool and no namespace and is reported as `failed`
through the gateway's `mcp.servers` status; the gateway still opens. A direct `add`,
`remove`, `logout` or completed login applies the same connection, registration,
namespace and policy refresh while the gateway runs.

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
server rejected it); only a new owner-initiated login changes that.

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
- Management is direct in an authenticated mapped ordinary chat. There is no
  separate approval surface or approval record, and no scheduled-run, worker or
  automation-scope management. The owner's request is the authorization; a stdio
  entry still launches a host process and deserves the same scrutiny.
- No implicit `mcp.json`, Pi settings, extension-registered servers, resources or
  prompts API, resource tools, MCP Apps.
- `/mcp` is a bounded status view, not a dashboard: it lists configured servers
  and any login waiting for a callback, but does not edit configuration, expose a
  transport error, or show a token.
- A server's tool list is read at open. A `notifications/tools/list_changed`
  withdrawal makes the tool unreachable immediately. Management or a completed
  login reconnects the affected server and refreshes registration, namespaces and
  policy without a restart. There is still no lazy reconnect: an unrelated
  dropped connection makes that server's tools fail until a management action or
  a restart reconnects it.
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
