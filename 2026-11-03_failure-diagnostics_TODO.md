# Gateway failure diagnostics — 2026-11-03

## Checklist

- [x] Add bounded, credential-free failure records with stage, safe error codes, cause chain, code locations and stable fingerprint.
- [x] Preserve failures across gateway startup, adapter execution and shutdown; retain transport causes.
- [x] Validate redaction and the real CLI boundary with synthetic offline checks; reconcile docs.
- [ ] Independent review and integration.
- [ ] Owner-approved activation; verify health without triggering work.

## Log

### 2026-11-03

Owner requested prevention or useful error logs after unexplained service exits and systemd start limiting. The current gateway is healthy. Prioritize diagnosability instead of guessing at retries or removing restart safety. Existing journal output is retained by the host; raw exception messages, request bodies, URLs, tokens, paths and arbitrary error fields must never be logged. No live service/unit/configuration change or restart during implementation.

Owner chose to keep existing journald retention and explicitly requested Durable failures no longer disappear. Connected native `HarnessOptions.onReport`, preserving asynchronous storage, scheduler, hook and listener reports. Added bounded error/cause records with safe classes/codes, task IDs, code-relative frames (including source-mapped installed SDK frames), allowlisted Durable invariant messages and a fingerprint. Arbitrary exception messages, properties, absolute paths, URLs, credentials and transcript payloads are not emitted. The CLI logs primary/open, Telegram/runtime and shutdown stages; a cleanup error cannot erase the original record. Non-contention lock failures get their own stage. Telegram transport causes are preserved without widening retry/delivery semantics. Existing human-facing startup summaries remain fixed.

Offline validation: typecheck/build; all 447 behavior checks, 2 execution checks and 83 core acceptance checks pass; `git diff --check` clean. Four focused additions exercise safe native error/cause rendering and hostile fields, a real CLI failure with a synthetic invalid SQLite file, actual native listener-report forwarding, and a real grammY transport wrapper over a synthetic failed fetch. Journal retention, unit definitions, restart policy, live configuration, schedules and the running gateway are unchanged. Independent review is pending; activation requires a separately approved restart.
