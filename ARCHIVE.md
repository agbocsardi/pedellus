# Read-only archive preparation

`src/archive/index.ts` adds an opt-in pure `prepareArchivePayload(snapshot,
projection)` function. It prepares one schema-v3 conversation record shaped like
`MemoryStore.append_conversation_history` and accepted by Python's
`MemoryStore._valid_history_payload`: string `timestamp`, at least one of
`content`/`summary`/`messages` (this adapter requires non-empty `messages`),
and an optional string `session_key`. It does not write or import history.

The host must supply an already-sanitized message snapshot, a usage delta from
`projectUsageDelta`, and the expected usage source scope (store namespace plus
Durable conversation ID). The function verifies projection scope against that
host mapping but cannot prove the mapping is true or authenticate provenance.
It validates all recognized projection, legacy/native row, aggregate,
request-count, cursor, and optional-field marker shapes/invariants. An unknown
optional-transition marker can refer to a cumulative cursor row with no numeric
delta row; validation checks that provenance against the cursor snapshot.
Unknown projection fields are rejected. This is structural validation, not
transcript-completeness validation. Message content must already be sanitized
as in Python's `_clean_history_messages`; this function does not change it.
`timestamp` is host-supplied; message timestamps determine `start_time` and
`end_time`. An absent session key maps to Python's `unknown` convention. The
optional summary uses Python-compatible `strip_think`, trimming, and the
8,000-code-point truncation (including suffix). Inputs are not changed; output
is detached and deeply frozen.

The output's `usage` field is only the projection's legacy model-token shape.
It contains no synthetic `requests`, and it is omitted when that shape is
empty. Full `usage_provenance` retains projection source, native model/tool
rows and costs, unknown optional-field markers, request-count status, and the
proposed cursor. Python's payload validator ignores these extra fields. Tool
usage and native cost are not folded into legacy model totals. Unknown fields
survive as provenance; they are not imputed into legacy totals.

Preparation rejects absent/empty or over-1,000-message transcripts, message
fields above 256 Ki characters, summaries/metadata fields above that
preflight limit, usage buckets above 1,000 rows, usage keys above 512
characters, malformed message/projection/cursor shapes, non-JSON/cyclic values,
and serialized payloads above 4 MiB. Rejected transcript content is never
silently truncated; summary is the deliberate exception, cleaned and truncated
as Python v3 does. Messages must use Python's sanitized persistence shape
(`timestamp`, `role`, `content`, optional `name` and `tools_used`); stripping
private/tool payloads from messages remains the host's responsibility.

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

The host-provided expected usage scope must be mapped to the selected
transcript/conversation by the caller; the API can compare source identity but
cannot infer that relationship from a session key. No gateway integration,
export wiring, package manifest/lock change, or archive writer is included.
Consumers must import this module directly until the package owner chooses its
public export surface.
