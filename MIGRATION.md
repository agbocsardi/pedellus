# Legacy migration is deferred

There is no migration subsystem in this tree. Python Nanobot history, archives,
usage ledgers and configs are **not** imported, converted, searched or cut over.
The native Durable transcript, workspace Markdown memory and the `history` tool
are separate, current surfaces; they do not read legacy stores.

The previously parked dry-run inventory and archival
acquisition/preparation/persistence/search/rehearsal helpers were removed
deliberately. If a migration is ever needed, it should be a single disposable
run against a quiescent copy, written outside this repository, rather than a
maintained product surface. Removed implementation remains in Git history and
is not supported. No operator-facing import command or compatibility mode is
planned here.
