# Gateway failure diagnostics — 2026-11-03

## Checklist

- [x] Add bounded, credential-free failure records with stage, safe error codes, cause chain, code locations and stable fingerprint.
- [x] Preserve failures across gateway startup, adapter execution and shutdown; retain transport causes.
- [x] Validate redaction and the real CLI boundary with synthetic offline checks; reconcile docs.
- [x] Independent review and integration.
  - [x] Preserve all caught Telegram transport/API causes without widening retry semantics.
  - [x] Forward allowlisted Durable report reasons and bounded restart counts.
  - [x] Make formatting/output best-effort and mark deduplication only after output succeeds.
  - [x] Preserve primary exceptions through CLI and runtime cleanup failures.
  - [x] Make normal SDK shutdown attempt every resource, report each failure and retain the first exception.
  - [x] Fresh independent re-check of the fixes.
- [ ] Owner-approved activation; verify health without triggering work.

## Log

### 2026-11-03

Owner requested prevention or useful error logs after unexplained service exits and systemd start limiting. The current gateway is healthy. Prioritize diagnosability instead of guessing at retries or removing restart safety. Existing journal output is retained by the host; raw exception messages, request bodies, URLs, tokens, paths and arbitrary error fields must never be logged. No live service/unit/configuration change or restart during implementation.

Owner chose to keep existing journald retention and explicitly requested Durable failures no longer disappear. Connected native `HarnessOptions.onReport`, preserving asynchronous storage, scheduler, hook and listener reports. Added bounded error/cause records with safe classes/codes, task IDs, code-relative frames (including source-mapped installed SDK frames), allowlisted Durable invariant messages and a fingerprint. Arbitrary exception messages, properties, absolute paths, URLs, credentials and transcript payloads are not emitted. The CLI logs primary/open, Telegram/runtime and shutdown stages; a cleanup error cannot erase the original record. Non-contention lock failures get their own stage. Telegram transport causes are preserved without widening retry/delivery semantics. Existing human-facing startup summaries remain fixed.

Offline validation: typecheck/build; all 447 behavior checks, 2 execution checks and 83 core acceptance checks pass; `git diff --check` clean. Four focused additions exercise safe native error/cause rendering and hostile fields, a real CLI failure with a synthetic invalid SQLite file, actual native listener-report forwarding, and a real grammY transport wrapper over a synthetic failed fetch. Journal retention, unit definitions, restart policy, live configuration, schedules and the running gateway are unchanged. Independent review is pending; activation requires a separately approved restart.

The first independent review found four medium-severity gaps; none are waived. Fixed all caught Telegram API/send wrappers to retain causes while preserving unknown-send holds and the existing narrow pre-connect retry classification. Forwarded native report reasons and bounded restart counts, with reasons included in the grouping fingerprint. Made formatter/output failures best-effort and deduplication conditional on a completed output call. CLI and runtime cleanup now report secondary failures but retain the primary exception returned to callers, and runtime cleanup still attempts every resource and lock release.

Added focused regressions for failing formatter/stderr and later retry, simultaneous SDK open/cleanup failures with lock release and report metadata, simultaneous CLI Telegram-token/shutdown failures, and controlled-clock real adapter sends showing unchanged unknown outcomes and five attempts only for the existing proven pre-connect category. ECONNREFUSED remains conservatively unknown as before; retry policy was not widened. Post-review validation: typecheck/build, all 451 behavior checks, 2 execution checks and 83 offline acceptance checks pass; whitespace check clean. Fresh independent re-check remains pending. No live changes or activation.

Fresh review found one remaining medium-severity gap in normal `gateway.close()`: an early catalog failure could skip native teardown/lock release, and nested `finally` failures could mask the first shutdown exception. No waiver: normal shutdown now independently attempts all cleanup in the existing order, records every observed failure and returns the first. Added normal SDK close regressions (native failure alone and catalog plus native failures, idempotence and successful ownership re-acquisition) plus an otherwise successful CLI startup/normal-stop check that must reject with its cleanup-only error. The CLI check invokes only that temporary host's installed stop callback; it sends no OS signal and touches no live service. Typecheck/build, all 453 behavior checks, 2 execution checks and 83 offline acceptance checks pass; whitespace clean. Another fresh re-check is required before integration, and owner-approved activation is still pending.

Final independent Pi `openai-codex/gpt-6.1-terra` / high review of candidate `bfe8b43d`: **no material findings**, with independent typecheck/build, all 35 targeted offline tests and whitespace check passing. It reviewed the full candidate, shutdown ordering, MCP login teardown, CLI exception propagation, diagnostics and regressions. All earlier findings were fixed, none waived. The reviewed candidate plus this sign-off is fast-forwarded into `main`; owner-approved activation and health verification remain the only pending step. No service, configuration, retention, retry policy or live data changes were made during review/integration.
