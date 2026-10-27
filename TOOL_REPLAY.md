# Interrupted tool replay, grant revocation, and unsafe downgrade

Permanent, synthetic actual-Harness coverage for the durable tool restart
boundary: `tests/tool-replay-revocation.behavior.test.mjs` with the bounded
child fixture `tests/fixtures/tool-replay-child.mjs`.

## What the test proves

The child opens a real SQLite-backed Durable `Harness` with a faux model and
three harmless fake tools. All three are registered `replay: "safe"` in the
child (`revoked_effect`, `granted_effect`, `downgraded_effect`). Each tool body
appends one line to a synthetic effect log and then blocks forever. Once all
three bodies have started, the child publishes conversation/submission IDs and
`READY`; the parent sends a real `SIGKILL`.

The parent then reopens the same database and, before calling `resume()`:

1. Revokes the `revoked_effect` grant with `configure({ tools: [], modelTools: [] })`.
   Its tool body, and therefore its synthetic external effect, must not run
   again. The recovered call settles with the native `interrupted` result:
   `Tool revoked_effect was interrupted and may have partially run`.
2. Explicitly grants `granted_effect` again. Because both the stored intent and
   the current registration are `replay: "safe"`, recovery reruns the body once
   and settles a normal result.
3. Keeps the `downgraded_effect` grant but re-registers that tool with
   `replay: "unsafe"`. Its persisted intent still says `safe`, so recovery must
   not rerun the body: the call settles as native `interrupted` and leaves the
   synthetic effect log alone.

The effect-log assertions count labels rather than assuming append order. The
pre-resume log has exactly one line for each of the three effects. After resume
it has exactly one line for each revoked/downgraded effect and two lines for the
explicitly granted safe effect. The test also asserts the transcript's
`pi.tool-result` entries and a final model answer in each of the three
conversations.

This is native Durable 1.4.0 behavior, not a product hook. Recovery resolves the
tool against the conversation's **current** grant and replay policy, so removing
a grant or downgrading a tool to `replay: "unsafe"` before scheduling resumes
prevents re-execution even though the stored intent says `replay: "safe"`. A
replay-safe call that keeps a safe current registration reruns; Durable does not
promise exactly-once external effects for safe tools.

## Run it

```bash
cd packages/pi-nanobot
npm run build
node --test tests/tool-replay-revocation.behavior.test.mjs
```

The run is synthetic and offline: faux model, fake tool bodies, temporary
directory/SQLite, one bounded child process (256 MB heap), no network, no real
tools, no sandbox change. The child environment is constructed from a minimal
allowlist (`HOME`, `TMPDIR`, `PATH`, and the candidate path) rather than
inherited from the test process, so provider/API credentials in the parent
environment are not passed to it. Cleanup kills and awaits the child if needed,
closes the parent Harness, and removes the temporary directory. The test is
included in `test:behavior`.

Set `PI_TOOL_REPLAY_CANDIDATE=/path/to/packages/pi-nanobot` to run the test
against another built checkout.

## Scope and non-claims

- Covered: model-issued direct tool calls, actual process `SIGKILL`, SQLite
  reopen, grant revocation before resume, positive safe replay with an explicit
  grant, and safe-persisted/unsafe-current replay downgrade.
- Not covered: real coding tools, approval/UI flows, external-effect
  exactly-once semantics, or fingerprint / definition compatibility.
- Nested Code Mode coverage lives in
  [`NESTED_CODEMODE_REPLAY.md`](./NESTED_CODEMODE_REPLAY.md).
- The Gateway's nonempty `toolAllowlist` fail-closed behavior is unchanged and
  not bypassed. This test uses a raw Harness because the Gateway deliberately
  has no approved registered tools to grant.
- This test does not activate production tools or change runtime policy.
