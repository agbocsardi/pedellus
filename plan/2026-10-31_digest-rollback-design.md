# Digest rollback — rejected, 2026-10-31

## Decision

Owner chose to keep the existing partial-write/retry behavior. Rollback and staged publication are **not planned**, not deferred implementation work. No Git repository, worktree, snapshot, publication journal or rollback mechanism is required for digestion.

## Retained behavior

- A failed or cancelled digest may leave the memory edits it already made.
- Failure does not acknowledge the batch or advance its cursor; a later invocation can process the same evidence again.
- The curation prompt tells the model to read existing files before editing and check whether a fact is already recorded before adding it.
- Create-only writes and exact-text edits remain enforced. They do not guarantee semantically correct or duplicate-free memory; checking existing facts is model guidance, not a transactional guarantee.
- Existing scope, budgets, failure reporting and external-editor concurrency limits remain unchanged.

The earlier staging/Git proposal is rejected as unnecessary machinery for the current requirement. Any future rollback work requires a new concrete need and owner approval.
