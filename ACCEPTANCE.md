# Core acceptance (offline)

`npm run test:core-acceptance` is a disposable, offline acceptance run of the
actual built Gateway. It proves that the shipped wiring — not a test double of
it — can carry one conversation through context discovery, an on-demand skill,
topic-memory read/write under expiring grants, native compaction and a
fresh-process reopen.

It is not a unit-test suite and it is not real-model or A/B acceptance.

## Run

```bash
npm ci --offline
npm run test:core-acceptance
```

The runner builds `dist/`, generates a synthetic workspace under the OS temp
directory, and runs two bounded child processes:

1. **First process** — opens `openGateway` with the real workspace host
   (`workspaceContextGatewayOptions`), a faux pi-ai provider and a synthetic
   `AGENTS.md`, `memory/MEMORY.md`, topic memory directory and `skills/`
   directory. It grants `read`/`write`/`edit` with explicit expiries, writes a
   topic memory file through the granted `write` tool, reads it back through the
   granted `read` tool, proves an expired grant blocks its tool call, and runs a
   native manual `Conversation.compact()`.
2. **Second process** — reopens the same SQLite state and workspace, then checks
   that the early fact arrives in a normal model request **through the placed
   compaction summary**, that the original early turn text does not, that
   bootstrap files, the memory manifest and the skill summary are rediscovered
   from Markdown, and that pending grants are still present. The skill body and
   topic body load on demand through tool results.

The faux provider is the only model endpoint. The summarizer request is real
(native Durable compaction), and the runner extracts the acceptance fact from
that request before answering it; if extraction fails the run fails rather than
supplying the fact from a canned answer.

## Output contract

The runner prints one JSON object and nothing else on stdout:

- `status`: `"pass"` or `"fail"`.
- `checks[]`: stable `id`, `status` (`pass`/`fail`) and optionally a bounded
  `detail`; ids are prefixed `runner.`, `phase1.` or `phase2.`.
- `counts`: pass/fail/total.
- `phases`: child exit code, signal, timeout flag and duration.
- `mode`/`provider`: `offline-synthetic`, faux provider, `network: false`.
- `notRun[]`: every acceptance area this runner deliberately does not exercise.
- `limits` and `durationMs`: bounds.

Exit codes: `0` all checks pass, `1` a check failed, `2` output/usage error.
`--output=<path>` additionally writes the report with exclusive creation; an
existing file is never overwritten.

Only synthetic markers and relative workspace labels appear in the report. The
generated workspace, SQLite store and evidence files are deleted at the end of
the run; no output is written into the repository by default.

## Bounds

- Each child process is killed at 120 s; compaction waits at most 20 s and each
  turn is bounded by the child timeout.
- All state is created under one owned temp directory and removed in `finally`.
- No provider request, credential lookup, personal workspace, external fixture,
  channel send or persistent repository artifact is involved.

## Not covered

Real-model summarization fidelity, A/B fixture comparison, provider/fallback
matrices, channels and scheduled delivery, credentials, the owner's real
workspace, Bubblewrap, and deployment are **not run**. Passing this runner is
evidence of plumbing over the real Gateway, not of model-quality or Python
parity. Real-model acceptance remains an owner-approved later step.
