# Gateway journal observability — 2026-11-15

- [x] Add a bounded, content-free journal adapter for native Durable/AI telemetry.
- [x] Connect native submission, task, model and nested-tool tracing without changing extension/tool authority.
- [x] Instrument Telegram, Discord and local ingress/preparation/submission/delivery boundaries and retry failures.
- [x] Record typing unavailability/recovery without logging every refresh.
- [x] Document correlation, slow-work warnings, privacy and deployment.
- [x] Validate with existing checks; review the diff for privacy and lifecycle regressions.

## Log

### 2026-11-15

User requested general gateway observability and chose journal-first, not an incident-specific patch or live-status UI. Native pi-durable/pi-ai telemetry already covers admission, scheduler phases, model requests, first-chunk latency, token usage and nested tools; use its adapter contract rather than installing authority-affecting hooks. Add host-side boundaries for work before model submission and after settlement. No content/payload/credential logging, per-token logs, external backend, ordering fix or automatic restart in this change.

Implemented `src/observability.ts` as a streaming native telemetry adapter with explicit scalar-attribute projection, trace propagation/link IDs, start/end events, one ten-second slow warning per span, and existing safe failure diagnostics. Provider error-status messages are omitted. The adapter retains no trace archive and preserves synchronous callback admission and value/error identity. Native harness telemetry is enabled without changing extension selection or tool authority. Pinned the already-installed telemetry package as a direct dependency.

Added host boundaries for Telegram/Discord preparation, submission-slot waits, settlement, final replies and scheduled delivery; local file/submission/settlement operations and request failures; gateway/channel lifecycle; Telegram rate limits and typing failure/recovery episodes. Telegram file lookup, response headers, streamed body/storage and transcription are separately visible. Preserved safe download causes without raw URL/error logging. Documented correlation and limitations in OBSERVABILITY.md and linked SERVICE.md/TELEGRAM.md.

Validation: final typecheck and whitespace checks pass; existing behavior suite 564/564 (two full runs, final ~54.8s), execution suite 2/2. Parsed 14,259 structured records from the final offline run: every record parsed, all 4,768 started spans finished, expected slow/typing-failure events were present, only projected metadata keys appeared, and the largest observed JSON record was 928 bytes. Reviewed adapter capability identity, propagation, privacy and affected delivery paths directly; no delegated implementation/review or new test suite. Tests used disposable fixtures, not the live store or Telegram network. The production gateway was not restarted, so deployment remains an explicit owner step. Tool error-result contents and direct model calls outside the native harness remain transcript-only/uninstrumented as documented.
