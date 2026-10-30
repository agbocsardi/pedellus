# Native web search and fetch

`web_search` and `web_fetch` are two native tools for one explicitly configured
capability: a Brave web search and a public page reader. They are not coding
tools, are not named by `toolAllowlist`, and grant no filesystem or shell
authority. With no `web` configuration the gateway installs neither the
extension nor a tool, and makes no external call.

Status: experimental. No acceptance run here has used a live provider account,
a personal query or a private page. The behavior checks use synthetic
providers, a controlled resolver and mock transports only.

## Configuration

```json
{
  "web": {
    "search": { "keyEnv": "BRAVE_SEARCH_API_KEY" },
    "fetch": true
  }
}
```

- `web` absent (or `{}`): no web capability. Presence alone installs nothing.
- `web.search`: enables `web_search`. `keyEnv` names the environment variable
  holding the Brave Search subscription token; it is read once at startup. A
  missing or empty variable fails startup with the fixed `webCredential`
  diagnostic. The value is never logged, persisted, put in a tool result or
  included in an error.
- `web.fetch`: `true` enables `web_fetch`. It needs no credential.
- `search` and `fetch` enable independently.
- Unknown fields are configuration errors, and `fetch` must be exactly `true` when
  present (`false` is also rejected).
- Because `toolAllowlist` remains the coding-tool authority, `web_search` and
  `web_fetch` cannot be added to it; doing so is a startup error.

## Authority

Both tools exist only in a conversation the host has validated as a mapped
ordinary chat (the same rule as history retrieval: ownerless, unforked, not the
root, not a channel-state key). The tool extension is selected only for those
conversations, and its own `ToolTask` hook rechecks the conversation at call
time. The root, forks, raw/task-created conversations, channel-state
conversations and isolated cron run targets are denied even when persisted
agent state still names a tool. Cron captures contain only coding-tool names,
so a background run never inherits web authority.

On reopen with `web` removed, the extension is not installed and the policy
pass rewrites each conversation's tool list, so a previously prepared or nested
call cannot resolve the removed tool. Web tools are not exempt from the coding
ceiling by name alone: they carry their own scope hook, and the coding hook
exempts the two fixed names only while that gated extension is installed.

Code Mode's nested tool execution runs the same Durable `ToolTask` hooks, so a
script receives no broader web authority than the conversation has.

## `web_search`

- Provider: Brave Search only. Fixed origin `https://api.search.brave.com`,
  fixed endpoint `/res/v1/web/search`. The model supplies `query` and an
  optional `count` (1-10, default 5); the host composes the URL.
- Auth: the `x-subscription-token` header carries the configured key. It is not
  logged or returned. `accept-encoding: identity` avoids decompression work.
- Response: `web.results[].title`, `url`, `description`. Only `http`/`https`
  URLs are kept; titles and snippets are collapsed to one bounded line and
  marked untrusted. Missing entries are dropped, and the requested count is
  never exceeded.
- Bounds: 600-character / 75-word query, 10 results, 1 MiB response body,
  15-second total deadline.
- Failure is truthful: HTTP status, timeout, oversized response, network
  failure and malformed JSON are explicit tool errors. A provider failure never
  becomes "no results"; only a successful response with no `web.results` does.
- No retry layer: a failed request is reported once.

## `web_fetch`

Accepts one URL. Returns plain readable text for HTML, plain text and JSON
(with source metadata), or an explicit failure for anything else.

Result metadata: original URL, final URL after redirects, title when present,
the raw `content-type`, retrieval time, HTTP status, redirect count, explicit
body/text truncation, and bounded absolute links extracted from the page.
Links and page text are labelled untrusted page data: a successful fetch does
not make them trusted, and no fetched text can become system instructions.
Extraction truncation is reported in characters for the model-facing text;
Durable may independently apply its own byte/line output window to the tool
result.

Security properties:

- `http` and `https` only. Other schemes, embedded credentials (`user:pass@`)
  and port `0` are refused.
- Each hop is resolved with `dns.lookup`, and every answer must be ordinary
  public unicast per ipaddr.js. Loopback, private, link-local/metadata,
  carrier-grade NAT, multicast, unspecified, broadcast, reserved,
  documentation/benchmarking ranges, IPv6 unique-local and IPv4-mapped IPv6 are
  refused. A mixed public/private answer set is refused outright.
- The connection is pinned to the validated address through a custom lookup, so
  a second DNS answer cannot move the socket (DNS rebinding). Location is never
  re-resolved after the check.
- Redirects are followed manually (limit 4), and every new location is
  re-parsed and revalidated before connecting. Bodies of redirect and error
  responses are released, not read.
- The request sends a fixed header set only. There is no cookie jar, no ambient
  proxy configuration, no browser authentication and no credential forwarding,
  so a cross-origin redirect cannot carry state.
- Connect timeout 8 s, total deadline 20 s, streamed body 2 MiB, readable text
  48 KiB, title 300 characters, 40 links. Cancellation and deadlines destroy
  the request, body and listeners.
- Content types: `text/html`, `application/xhtml+xml`, `text/plain`,
  `application/json` and `*+json`. Binary types (including PDF and Office
  documents) fail explicitly; nothing is converted. Non-identity
  `content-encoding` fails explicitly.
- HTML is parsed with htmlparser2, never rendered and never executed. Script,
  style, noscript, template and embedded-content subtrees contribute no text.
  DOM recursion is depth-bounded.
- No files are written: there is no temp spill, no attachment download and no
  user-write-location side effect. Retrieval is synchronous with the call.

## Replay policy

Both tools declare `replay: "unsafe"`. A GET is technically idempotent, but an
interrupted external request can still have provider billing, privacy and
external-reach consequences. Durable therefore never reissues one after a
crash, and this layer has no retry framework.

## Known gaps

- One provider (Brave) and one search endpoint. No provider registry,
  discovery, per-call provider override, custom base URL or self-hosted search.
- `web_fetch` is not a browser: no JavaScript, no subresources, no cookies, no
  login, no paywall handling and no crawling/polling. It reads one URL.
- Only identity content encoding is accepted; compressed responses are refused
  rather than decompressed.
- No PDF, Office, image, OCR or archive extraction, and no conversion of
  unsupported media. Attachments keep their existing disk-only behavior.
- No persistent cache, queue, retry scheduler or background refresh.
- `web.search` uses a single configured environment variable. There is no
  secrets file, key store or runtime key configuration command.

## Dependencies

`htmlparser2` 12.0.0 parses HTML; `ipaddr.js` 2.3.0 classifies addresses. Both
are pinned direct dependencies. See `THIRD_PARTY_NOTICES.md` for the adapted
Brave contract notice and licenses.
