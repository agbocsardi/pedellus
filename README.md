# Nanobot Durable runtime spike

Experimental Gate 1 TypeScript port. Requires Node >=22.19 and the pinned Pi 1.4.0 packages. This is not a production-ready replacement for the Python fork.

## Run

Copy `config.example.json` to a private explicit config file and edit the workspace, model, and environment-variable *names*. The config contains no credentials. `credentials.openai`, `credentials.opencode_zen`, and `credentials.opencode_go` refer only to environment names; the runtime does not read Nanobot/Pi user config or perform live credential discovery. The `opencode_zen` alias uses pi-ai's `opencode` provider and `opencode_go` uses `opencode-go`. SDK hosts may pass an explicit pi-ai `Models` instance as `openGateway(config, context, { models })` for offline/custom use; the CLI never installs a faux provider.

```sh
npm ci
npm run build
node dist/cli.js --config /path/to/config.json
```

Without Telegram settings, the CLI starts a single local prompt session. With Telegram enabled, it delegates to the restricted adapter (explicit decimal user allowlist only). Do not use live bot polling for offline checks.

## Runtime/recovery

One process acquires Chord's kernel-backed `processLock` using the canonical SQLite database path before opening storage. The lock is released when the owning process exits, including an uncatchable kill; a second live owner fails closed. SQLite, under `dataDir/nanobot.sqlite`, stores the Durable transcript and work state. The root conversation's `nanobot.session-map` document commits external session-key-to-conversation mappings atomically. Reopening the database reuses the same conversation without resetting its transcript; pending durable tasks are resumed after extensions are installed. Data directory is private (`0700`) and rejected when it resolves inside the workspace or any extra allowed root; it is not exposed to the shell environment.

## Current status and checks

The runtime/config/providers/CLI wiring, provider aliases and durable identity map are implemented. Because filesystem TOCTOU and writable-hardlink confinement remain unproven, the runtime deliberately installs no CodingTools, exposes no tools, and does not initialize an execution environment or bwrap. Existing and newly created conversations receive an explicit tool-less host policy before resume. Chat/Telegram can be used without tools. The standalone execution module is not imported here. Security acceptance remains open, including filesystem race/hardlink guarantees. A temporary bounded offline runtime check using actual SQLite and explicit injected faux Models passed: submit and read assistant text, request-ID dedupe, same-key reopen identity, prototype-like keys, concurrent-owner rejection, SIGKILL lock release/reopen, missing credentials before data directory creation, and invalid workspace/extra-root rejection. Parent integration passed package-wide `npm run typecheck` and `npm run build`, plus independent actual-SQLite checks for text extraction, request-ID deduplication, prototype-safe keys, private storage, exclusive ownership, reopen identity, and SIGKILL lock release/reopen. SIGKILL mid-tool replay is not proven by that storage-lock check. Telegram's offline integration probes also pass, but fatal-poll shutdown and edit/rate-limit retry handling still need follow-up before live use; see `TELEGRAM.md`. No paid/provider requests or live Telegram polling were performed. A scripted faux model is allowed only via explicit SDK injection, never a production fallback.
