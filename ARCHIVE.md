# Read-only archive preparation

`src/archive/index.ts` adds an opt-in pure `prepareArchivePayload(snapshot,
projection)` function. It prepares one schema-v3 conversation record shaped like
`MemoryStore.append_conversation_history` and accepted by Python's
`MemoryStore._valid_history_payload`: string `timestamp`, at least one of
`content`/`summary`/`messages` (this adapter requires non-empty `messages`),
and an optional string `session_key`. It does not write or import history.

The host must supply an already-sanitized transcript snapshot and a usage delta
from `projectUsageDelta`. This function validates structure but does not
sanitize content or establish whether the supplied transcript is complete,
current, correctly scoped, or safe to archive. `timestamp` is host-supplied;
message `timestamp` values determine `start_time`/`end_time`. An absent session
key maps to Python's `unknown` convention. Empty summary is omitted. Inputs
are not changed; the JSON-compatible output is detached and deeply frozen.

The output's `usage` field is only the projection's legacy model-token shape.
It contains no synthetic `requests`, and it is omitted when that shape is
empty. Full `usage_provenance` retains projection source, native model/tool
rows and costs, unknown optional-field markers, request-count status, and the
proposed cursor. Python's payload validator ignores these extra fields. Tool
usage and native cost are not folded into legacy model totals. Unknown fields
survive as provenance; they are not imputed into legacy totals.

Preparation rejects absent/empty or over-1,000-message transcripts, malformed
required message fields, malformed optional session/summary/name/tool-list
fields, malformed projection envelopes, non-JSON/cyclic values, and serialized
payloads above 4 MiB. Rejection is fail-closed: it does not truncate the
payload or silently turn invalid data into an empty record. The 4 MiB limit is
measured on JSON UTF-8 serialization. Messages are expected in the sanitized
Python persistence shape (`timestamp`, `role`, `content`, optional `name` and
`tools_used`); responsibility for stripping private/tool payloads stays with
the host.

This function is only preparation. It does not read a filesystem or real
history, append, allocate an archive cursor, update a cursor, start tasks, or
provide idempotency, atomicity, or exactly-once effects. `usage_provenance`
includes a *proposal* cursor and is not evidence that the archive committed.
The current Python usage delta helper counts normalized response events, while
Pi Durable exposes committed cumulative token/cost totals without request
counts. Therefore this adapter deliberately preserves `requestCount: unknown`
and never fabricates `requests`; Python consumers that require request totals
must treat this source accordingly. Cursor and archive persistence still need a
product-level transaction/idempotency design before any writer integration.

No gateway integration, export wiring, package manifest/lock change, or archive
writer is included. Consumers must import this module directly until the
package owner chooses its public export surface.
