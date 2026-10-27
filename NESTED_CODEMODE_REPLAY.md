# Nested Code Mode interrupted-tool replay, revocation, and unsafe downgrade

Permanent, synthetic actual-Harness coverage for the durable **nested** Code
Mode restart boundary:
`tests/nested-codemode-replay-revocation.behavior.test.mjs` with the bounded
child fixture `tests/fixtures/nested-codemode-replay-child.mjs`.

## What the test proves

The child opens a real SQLite-backed Durable `Harness` with a faux model, the
fork's actual Code Mode integration, and four harmless synthetic tools. Every
tool body appends one line to a private effect log and then blocks forever. The
child creates two conversations and grants Code Mode plus one or two nested
tools to each:

- **mixed**: one Code Mode script issues `nested_revoked_effect` and
  `nested_downgraded_effect` concurrently through `Promise.allSettled`.
  Both nested calls are admitted and their bodies start before the crash.
- **granted**: the script first awaits `nested_granted_effect`, whose body starts
  and blocks. `nested_pending_effect` is granted at first run but is issued only
  after the first call resolves, so it is still pending when the process dies.

Once the three started bodies have appended their labels, the child publishes
conversation/submission IDs and `READY`; the parent sends a real `SIGKILL`.

The parent reopens the same database and, **before** calling `resume()`:

1. For **mixed**, revokes the host grant for `nested_revoked_effect` while
   keeping the grant for `nested_downgraded_effect`, but re-registers the latter
   with `replay: "unsafe"` (its persisted nested intent says `safe`).
2. For **granted**, keeps the explicit `nested_granted_effect` grant and revokes
   the grant for the still-pending `nested_pending_effect`.

After resume, native Code Mode replays the safe `codemode` tool and reattaches
nested calls by key. The observed outcomes are:

- `nested_revoked_effect` was already admitted and checkpointed before the crash.
  Its current grant is gone, so its nested task does not rerun. It settles with
  the native `interrupted` result: `Tool nested_revoked_effect was interrupted
  and may have partially run`.
- `nested_downgraded_effect` keeps its grant, but stored `safe` plus current
  `unsafe` must not rerun. It settles with the same native `interrupted` result.
- `nested_granted_effect` keeps both stored and current `safe`, so its body
  reruns once after restart and returns normally.
- `nested_pending_effect` was not admitted before the crash. The replayed
  script reaches it only after the granted call resolves; it is then a new
  nested admission against the current grant, so it settles with the native
  non-executing error `Tool nested_pending_effect is not available`.

The mixed script catches both nested failures through `Promise.allSettled` and
returns success; the granted script catches the pending failure and returns
success. The test therefore asserts both transcript-level `pi.tool-result`
entries and the nested `details.calls` rows:

| Conversation | Code Mode result | Nested row | Nested status |
| --- | --- | --- | --- |
| mixed | success | `nested_revoked_effect` | `error`, interrupted |
| mixed | success | `nested_downgraded_effect` | `error`, interrupted |
| granted | success | `nested_granted_effect` | `ok` |
| granted | success | `nested_pending_effect` | `error`, not available |

The effect log has exactly one line for each mixed effect before the crash. After
resume it adds exactly one more `nested_granted_effect` line; the revoked,
downgraded, and pending bodies never run again or for the first time. The test
asserts label counts and the final effect-log append.

## Native semantics this relies on

Durable Code Mode records the script start data (including the callable tool
list), journals delivered results, and reattaches nested calls by key `c<VM call
id>`. Recovery does not trust the persisted grant or replay policy alone:
`ToolTask.execute` resolves the tool against the conversation's **current**
grant and reruns only when both the stored intent and current registration say
`replay: "safe"`. A missing current tool fails that test and settles the native
`interrupted` result without executing the body. A nested call that had not been
admitted before the crash is created after recovery and goes through the normal
call phase, where a missing grant yields `not available` without executing the
body.

A replay-safe call that keeps a safe current registration reruns. Durable does
not promise exactly-once external effects for safe tools; the test uses a
harmless append-only log, not an external service.

## Run it

```bash
cd packages/pi-nanobot
npm run build
node --test tests/nested-codemode-replay-revocation.behavior.test.mjs
```

The run is synthetic and offline: faux model, fake tool bodies, temporary
directory/SQLite, one bounded child process (256 MB heap), no network, no real
tools, and no sandbox or policy change. The child environment is a minimal
allowlist (`HOME`, `TMPDIR`, `PATH`, and the candidate path), so provider/API
credentials in the parent environment are not passed to it. Cleanup kills and
awaits the child if needed, closes the parent Harness, closes the Code Mode
integration, and removes the temporary directory.

Set `PI_CODEMODE_REPLAY_CANDIDATE=/path/to/packages/pi-nanobot` to run against
another built checkout.

The test is included in `test:behavior`; it can also be run directly as above.

## Scope and non-claims

- Covered: actual process `SIGKILL`, SQLite reopen, native Code Mode replay,
  granted nested calls that were already admitted, an interrupted nested call
  whose host grant is revoked before resume, a still-pending nested call whose
  grant is revoked before resume, safe replay with an explicit current grant, and
  stored-safe/current-unsafe replay downgrade.
- Not covered: real coding tools, provider behavior, approval/UI flows,
  Gateway registration, external-effect exactly-once semantics, or Windows
  process/signal behavior.
- This test does not activate production tools, weaken a Gateway allowlist, or
  change runtime policy.
