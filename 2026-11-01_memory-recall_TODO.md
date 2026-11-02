# Memory recall — 2026-11-01

## Checklist

- [x] Freeze shared contracts, strict validation and store-bound references.
- [x] Implement conversation search, snapshot-bounded exhaustive browse and complete original reads.
- [x] Implement scoped Markdown search, browse and complete reads.
- [x] Wire the three tools into the gateway, Code Mode and captured worker authority; retire model-facing history.
- [x] Document filter, timestamp, provenance, snapshot, continuation and coverage semantics.
- [x] Independently review each candidate and the combined integration; fix findings.
- [x] Run typecheck, build, existing offline suites and targeted runtime checks.

## Architecture

One gateway-owned recall service; three thin tools (`memory_search`, `memory_browse`, `memory_read`). Markdown and Durable remain authoritative. Existing derived history indexes remain discovery aids, never the authority for exhaustive enumeration or complete reading. No model calls, implicit waterfall, new transcript archive, live deployment or personal-data access.

Queries address one target (`notes`, `episodes`, `messages`, `tools`). Typed target-specific filters combine with AND; values in a list combine with OR; empty lists are rejected. Timestamps require explicit zones; intervals are start-inclusive/end-exclusive. References bind store identity and scoped resource identity but grant no access. Every page revalidates authority. Browse freezes high-water and note identities; completeness and index freshness are distinct. Complete reads paginate within oversized content, not merely between entries.

## Log

### 2026-11-01

Owner approved architecture and requested implementation/review with Pi Codex Luna high agents. Earlier broad delegations yielded an unsuitable contract and a partial search-filter slice; neither was merged. Continuing with explicit shared interfaces and bounded backends. Main starts clean at `75406534`. Only synthetic offline validation is authorized.

Shared validation/routing was independently reviewed and integrated with capped page limits and millisecond timestamp precision. Markdown implementation review found deferred-manifest and ancestor-link defects; fixed with first-call manifest capture and pinned Linux directory descriptors. Fresh re-review found no material issues. Integrated Markdown at `74a2b6bb`; synthetic checks reconstructed a note over 6,146 pages, tested delayed file exclusion, changed-ref rejection, long-description filtering, symlink refusal and backend isolation. Main typecheck and diff checks pass. Conversation backend and runtime integration remain unmerged candidates under repair/review. Following owner direction, subagents own all remaining implementation and fixes; parent coordinates architecture, integration, review and validation.

Completed and merged the reviewed union at `efdf521d`. Conversation recall now uses shared typed original-message/tool projections, the existing search indexes, progressive metadata-only browsing, and streaming authoritative reads. Corrected review findings on per-message timestamps, tool-result hydration, state/date filters, snapshot failures/budgets, replay and lower-limit retries, tiny-page JSON framing, HMAC cursor integrity, source coverage, worker SDK operation captures, and native structured Code Mode results. Existing test consumers were adapted; no new permanent tests or framework were added. Final fresh review found only default-on authority wording in two documents; corrected before merge. No findings were waived.

Validation of the final source tree: typecheck/build pass, 400/400 behavior, 2/2 execution and 83/83 offline core acceptance. The independent validator also passed 3/3 actual synthetic gateway/Code Mode/reopen smoke checks and reader roundtrips at limits 2, 3, 5, 8 and 8000, oversized Unicode/tool arguments, HMAC tamper/scope/close rejection and append exclusion. Earlier backend-specific disposable checks covered >20,000-entry browsing/reading, cached-page retries, index lag, scan failures, late episode dates, and frozen empty sessions. Main's merged source/test/package trees exactly matched the validated candidate; main typecheck/build and diff checks passed again.

Limits: current transcript provenance is explicitly `unknown` because no trusted importer marker exists; native/imported labels are never inferred. Discovery metadata has explicit capacity/deadline/expiry limits; native read deadlines are cooperative, checked after the current read settles. The final validator did not independently exercise the exact worker SDK search-only versus read/browse negative case, missing worker-root branch, store-replacement refs, or repeat all backend-specific checks; these paths were reviewed and some are covered by earlier checks/existing tests, not claimed as new runtime proofs. No live provider, personal store/workspace, service restart, production migration or deployment was performed. User-facing semantics are in `MEMORY_RECALL.md`.
