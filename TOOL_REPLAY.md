# Interrupted tool replay and host-grant revocation

Permanent, synthetic actual-Harness coverage for the durable tool restart
boundary: `tests/tool-replay-revocation.behavior.test.mjs` with the bounded
child fixture `tests/fixtures/tool-replay-child.mjs`.

## What the test proves

The child opens a real SQLite-backed Durable `Harness` with a faux model and two
harmless fake, replay-safe tools (`revoked_effect`, `granted_effect`). Each tool
body appends one line to a synthetic effect log and then blocks forever. Once
both bodies have started, the child publishes conversation/submission IDs and
`READY`; the parent sends a real `SIGKILL`.

The parent then reopens the same database and, before calling `resume()`:

1. Revokes the `revoked_effect` grant with `configure({ tools: [], modelTools: [] })`.
   Its tool body, and therefore its synthetic external effect, must not run
   again. The recovered call settles with the native `interrupted` result:
   `Tool revoked_effect was interrupted and may have partially run`.
2. Explicitly grants `granted_effect` again. Because both the stored intent and
   the current registration are `replay: "safe"`, recovery reruns the body once
   and settles a normal result.

The test asserts the effect log remains `[revoked, granted]` immediately after
revocation, and becomes `[revoked, granted, granted]` after resume: the revoked
call executed once (before the crash) and never after revocation; the explicitly
granted safe call replayed exactly once. It also asserts the transcript's
`pi.tool-result` entries and final model answer.

This is native Durable 1.4.0 behavior, not a product hook. Recovery resolves the
tool against the conversation's **current** grant, so removing the grant before
scheduling resumes prevents re-execution even though the stored intent says
`replay: "safe"`. A replay-safe call that keeps its grant reruns; Durable does
not promise exactly-once external effects for safe tools.

## Run it

```bash
cd packages/pi-nanobot
npm run build
node --test tests/tool-replay-revocation.behavior.test.mjs
```

The run is synthetic and offline: faux model, fake tool bodies, temporary
directory/SQLite, one bounded child process (256 MB heap), no credentials, no
network, no real tools, no sandbox change. The test is intentionally not added
to `package.json` here; the package manifest owner can wire it into
`test:behavior` when integrating.

Set `PI_TOOL_REPLAY_CANDIDATE=/path/to/packages/pi-nanobot` to run the test
against another built checkout.

## Scope and non-claims

- Covered: model-issued direct tool calls, actual process `SIGKILL`, SQLite
  reopen, revocation before resume, and positive safe replay with an explicit
  grant.
- Not covered: nested Code Mode calls (separate probes/docs), real coding tools,
  approval/UI flows, external-effect exactly-once semantics, or fingerprint /
  definition compatibility.
- The Gateway's nonempty `toolAllowlist` fail-closed behavior is unchanged and
  not bypassed. This test uses a raw Harness because the Gateway deliberately
  has no approved registered tools to grant.
- No production activation, runtime, index, package, or TODO change is implied.
