# Memory recall — 2026-11-01

## Checklist

- [ ] Freeze shared contracts, strict validation and store-bound references.
- [ ] Implement conversation search, snapshot-bounded exhaustive browse and complete original reads.
- [ ] Implement scoped Markdown search, browse and complete reads.
- [ ] Wire the three tools into the gateway, Code Mode and captured worker authority; retire model-facing history.
- [ ] Document filter, timestamp, provenance, snapshot, continuation and coverage semantics.
- [ ] Independently review each candidate and the combined integration; fix findings.
- [ ] Run typecheck, build, existing offline suites and targeted runtime checks.

## Architecture

One gateway-owned recall service; three thin tools (`memory_search`, `memory_browse`, `memory_read`). Markdown and Durable remain authoritative. Existing derived history indexes remain discovery aids, never the authority for exhaustive enumeration or complete reading. No model calls, implicit waterfall, new transcript archive, live deployment or personal-data access.

Queries address one target (`notes`, `episodes`, `messages`, `tools`). Typed target-specific filters combine with AND; values in a list combine with OR; empty lists are rejected. Timestamps require explicit zones; intervals are start-inclusive/end-exclusive. References bind store identity and scoped resource identity but grant no access. Every page revalidates authority. Browse freezes high-water and note identities; completeness and index freshness are distinct. Complete reads paginate within oversized content, not merely between entries.

## Log

### 2026-11-01

Owner approved architecture and requested implementation/review with Pi Codex Luna high agents. Earlier broad delegations yielded an unsuitable contract and a partial search-filter slice; neither was merged. Continuing with explicit shared interfaces and bounded backends. Main starts clean at `75406534`. Only synthetic offline validation is authorized.
