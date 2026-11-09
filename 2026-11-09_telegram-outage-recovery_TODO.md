# 2026-11-09 Telegram read-outage recovery TODO

Confirmed incident: a startup `getMe` 502 and polling `getUpdates` failures could terminate
`runTelegram`; repeated restarts then exhausted the service restart limit. Recovery belongs only to
these idempotent reads, not to broad channel/adapter/process restarts or a supervisor change.

## Checklist

- [x] Retry startup `getMe` and polling `getUpdates` through transport errors, timeouts and
      Telegram 5xx for the whole outage, with cancellation-aware capped exponential backoff and
      bounded jitter; reset after a successful read.
- [x] Keep fatal auth/config rejections (for example 401/409), non-transient local/programming
      failures and genuine state failures fatal.
- [x] Keep outbound delivery, ambiguous-send hold behavior and flood handling unchanged; no config
      knob, dependency, supervisor, systemd or adapter-lifecycle redesign.
- [x] Add one fixed outage announcement and one fixed recovery notice per read-outage episode; no
      raw exception, payload, token or host path logging.
- [x] Add focused offline transport regressions for startup/polling recovery, offset preservation,
      cancellation during backoff and in-flight startup work, fatal auth, and safe cause diagnostics.
- [x] Update `TELEGRAM.md` startup/outage and `getUpdates` retry semantics.
- [x] Run typecheck, build, focused Telegram transport checks, full behavior and execution suites.
- [ ] Independent review findings fixed or explicitly waived by the parent/owner.

## Session log

### 2026-11-09

- Added an opt-in `retryOutage` path to `apiCall` used by exactly `getMe` and `getUpdates`. Only
  5xx `GrammyError` responses and classified transient `HttpError` transports retry; explicit 4xx,
  local/programming failures and all outbound calls keep their previous behavior. Delays are
  abortable, start near 1s, cap at 60s and carry bounded jitter; each successful read ends the
  episode and the next one starts fresh.
- Kept durable state authoritative during an outage: every retried `getUpdates` sends the unchanged
  committed offset, admission/deduplication code is untouched, and ambiguous sends remain held
  unknown with no blanket retry.
- Added eight focused transport checks (six new/adapted): sustained startup transport recovery,
  sustained polling transport/JSON-5xx/HTML-5xx recovery with offset preservation and one
  announcement/recovery pair, cancellation during backoff, in-flight startup cancellation, fatal
  401 without retry, and preserved native cause diagnostics for a non-transient local failure.
- Corrected `TELEGRAM.md` to describe the unbounded safe-read outage retry and fatal polling
  boundary. No service, live config/store, credential, Telegram network or deployment was touched.
- Validation: `npm run typecheck`; `npm run build`; focused transport suite 8/8; full
  `npm run test:behavior` 561/561 in ~45.9s (inside the 60s suite timeout); `npm run test:execution`
  2/2; `git diff --check` clean. No live checks were run.
