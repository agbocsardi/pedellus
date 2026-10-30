# MCP servers and Code Mode

The gateway can connect explicitly configured [Model Context
Protocol](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP
and make their tools reachable through Code Mode and tool search. The MCP client,
transports and teardown come from the pinned `@earendil-works/pi-mcp@1.4.0`
package; Code Mode and deferred discovery are the native
`@earendil-works/pi-durable` tools already wrapped by
[`src/extensions/codemode.ts`](./src/extensions/codemode.ts). This port does not
implement a parallel client, tool registry, runner, queue or retry layer.

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
  legacy HTTP+SSE transport, `type`, `oauth`, `auth`, `exposure` and
  `toolExposure` are rejected with an explanation. There is no implicit
  `mcp.json` discovery, no Pi user settings import, and no `!command` value
  interpolation.
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
execution and grants nothing else.

MCP tools and their Code Mode/tool-search tools are enabled **only in
authenticated mapped ordinary chat conversations** — the same set that may use
`toolAllowlist`. The root conversation, state-only channel conversations, forks,
raw or task-owned conversations and isolated scheduled cron runs receive no MCP
tool, no `codemode` and no `tool_search`. A scheduled run has no bounded MCP
capture; that capability is deliberately not implemented.

The ceiling is enforced twice: the tool filter enables the tools per
conversation, and a call-time `ToolTask` hook rechecks the conversation and the
server's live state on every call. The hook also covers `codemode` and
`tool_search`, which the coding-tool ceiling delegates to it. A call from a
conversation that lost authorization, a nested Code Mode call, a persisted
selection or a prepared replay therefore fails closed. Coding tools reached from
a script are still bounded by `toolAllowlist`: a disabled tool is neither listed
in `ALL_TOOLS` nor callable.

MCP tool annotations (`readOnlyHint` etc.) are untrusted server hints and are not
used for authorization. No MCP tool call is retried by this layer: a dropped
response may mean the server already performed the call. An interrupted call is
Durable's default `unsafe` replay policy, so it is not rerun after a restart.

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
- `tool_search` can load a match into the next model call as a direct tool;
- the server's own instructions are exposed only through
  `describeNamespace("mcp__<server>")`, bounded and labeled untrusted, never as a
  tool description.

A Code Mode tool call resolves to the complete MCP `CallToolResult`:
`content`, `structuredContent` and `isError`. An `isError` result resolves inside
a script and is reported as an error result for a direct model call. Input
schemas are forced to object schemas; a schema over 16 KiB is replaced with an
unconstrained object so declarations stay bounded and the tool stays callable.

With MCP disabled there is no Code Mode in the gateway at all. See
[CODEMODE.md](./CODEMODE.md) for the native bundle's contract, budgets and
replay semantics.

## Lifecycle and limits

At gateway open the runtime connects every enabled server in parallel before the
Durable registry is built, then registers the discovered tools. A server that
fails to connect contributes no tool and no namespace and is reported as `failed`
through the gateway's `mcp.servers` status; the gateway still opens. The status
carries only a fixed failure code (`start-failed`, `start-timeout`,
`missing-environment`, `connection-closed`, `closed`),
never a transport message, response body, stderr tail, URL or configured value.

Tool calls use the native request timeout and the calling turn's abort signal.
When a script's deadline cancels a pending call, the client sends one MCP
cancellation; it is not retried. Closing the gateway stops Code Mode admission,
closes the sandbox and its workers, then closes every MCP client. A stdio server
is stopped per the specification — close stdin, then SIGTERM, then SIGKILL to its
whole process group — using the native transport. `gateway.close()` waits for
that teardown.

Known limits of this slice:

- No OAuth, browser sign-in or token store. HTTP servers must accept a configured
  `Authorization` header or none.
- No implicit `mcp.json`, Pi settings, extension-registered servers, resources or
  prompts API, resource tools, MCP Apps, or a `/mcp` management UI.
- A server's tool list is read at open. A `notifications/tools/list_changed`
  withdrawal makes the tool unreachable immediately; a newly added tool requires
  reopening the gateway. There is no lazy reconnect: a dropped connection makes
  that server's tools fail until the gateway is reopened.
- No config hot reload, no per-conversation MCP selection and no scheduled-run
  MCP authority.
- The server's declared output schema is not used as a validation contract;
  results arrive as the server sent them, bounded by native output limits.

All coverage is synthetic: fixture stdio servers and loopback HTTP servers, faux
models, no external network, provider, credential or production data.
