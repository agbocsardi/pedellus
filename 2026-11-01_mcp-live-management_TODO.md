# MCP live management — 2026-11-01

Owner-approved UX change: ordinary authenticated-channel requests manage MCP directly.
No slash-command approval gate; a login link goes privately to the initiating surface, the
owner pastes the callback back there, and tools become callable without a gateway restart.

## Checklist

- [x] Create the dated work order and record the policy change.
- [x] Make MCP management direct: add/configure, login, logout and remove without proposal records
      or `/mcp approve`, serialized per gateway.
- [x] Keep configuration writes on the validated, atomic, serialized install path with stale-file
      and exact-entry checks.
- [x] Add shared channel-neutral owner surfaces: authorization links and fixed completion notices
      route only to the authenticated session that initiated the action (Telegram chat + CLI attach).
- [x] Intercept OAuth callbacks before transcript admission/model dispatch on every active ingress;
      validate exact loopback origin/port/path/state, originating session (and Telegram sender),
      active attempt and non-replay; fail safely without persisting callback values.
- [x] Support the existing same-host browser callback unchanged; pasted callback completes the same
      native flow without shell/curl or arbitrary URL fetching.
- [x] Live activation: after add/update/login reconnect affected servers, refresh registrations,
      namespaces, discovery and tool policy for subsequent turns.
- [x] Live revocation: logout/remove/update retires stale tools and nested Code Mode access
      immediately; existing worker captures are pruned and never widened by new servers.
- [x] Retain `/mcp` as an optional status/compatibility command only; no approval requirement.
- [x] Add bounded synthetic regression coverage for direct management, private link delivery,
      callback validation/replay/cross-chat denial, live activation/revocation, cancellation and
      unchanged-grant behaviour, CLI and Telegram.
- [x] Update MCP.md, help text and the AGENTS invariants to the new explicitly owner-authorized
      policy, with honest limitations.
- [x] Run typecheck/build, relevant behavior suites, execution checks and core acceptance; report
      actual results and commit with a why-oriented message for independent review.

## Session log

### 2026-11-01

- Scope clarified by the owner: this is channel-neutral, not Telegram-only. The active foreground
  channel carries the link and the pasted callback; no broadcast to every attachment.
- Work started in worktree `t3-255f310a` on branch `t3/mcp-live-management`.
- Implemented direct management in `src/mcp/admin.ts`; removed the proposal
  document, request store and `/mcp` approval controls. The `mcp` tool now
  performs `status`, `add`/`configure`, `login`, `logout` and `remove`.
- Added a channel-neutral owner-surface registry. CLI attachments and Telegram
  chats deliver their own login URL and fixed completion notice; nothing is
  broadcast to another attachment.
- Added callback interception before model admission in the CLI terminal input
  path and Telegram update loop. Validation is exact on active loopback origin,
  port, path and state, plus session/sender binding and one-use.
- Made the MCP integration mutable: live add/reconnect/remove rebuilds
  registrations and Code Mode namespaces and reapplies policy. Worker captures
  are pruned, never widened; live worker policy keeps its model/cwd.
- Tests: direct add/remove activation; pasted callback activation with
  cross-chat/replay denial and transcript/state leak checks; same-host browser;
  failed delivery cancellation; close cancellation; unchanged grant;
  worker-capture pruning; CLI surface delivery/callback; Telegram callback
  ingress and read-only `/mcp`.
- Documentation updated: `MCP.md`, `README.md`, `CLI.md`, `TELEGRAM.md`,
  `TOOLS.md`, `CODEMODE.md` and the AGENTS invariants.
- Checks run: `npm run typecheck`, `npm run build`, the full
  `npm run test:behavior` suite (371/371 pass), `npm run test:execution`
  (2/2 pass) and `npm run --silent test:core-acceptance` (83/83 checks pass in
  offline-synthetic mode; 34/34 budget guard). No live provider, real MCP
  server, credential or production data was contacted.
