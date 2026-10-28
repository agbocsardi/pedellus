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
npm run --silent test:core-acceptance
```

`--silent` suppresses npm's own banners so stdout is only the report. After
`npm run build`, `node scripts/core-acceptance.mjs` does the same. Plain
`npm run test:core-acceptance` also works but prints npm/build banners before
the JSON, so do not parse its raw stdout as JSON.

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

The early user turn is the only source of the acceptance fact and also carries a
distinct raw-turn sentinel. The topic memory file uses its own marker, so a topic
read or write can never satisfy the fact assertion. The runner proves the
summarizer request contains the fact and the sentinel in the same early user
block, then checks the placed compaction summary message is the only message in
the phase-1 context and in the phase-2 request that contains the fact. In phase 2
the raw sentinel, the topic body marker and the skill body are absent until their
own tool results load them.

The faux provider is the only model endpoint. The summarizer request is real
(native Durable compaction); the runner extracts the early-turn fact and topic
locator from that request before answering it. If extraction or the per-message
isolation check fails, the run fails rather than supplying the fact from a
canned answer.

The runner also self-probes the real-run budget guard
(`scripts/core-acceptance-budget.mjs`) with faux models and no network: payload
byte bound plus framing reserve, output clamping, request/input/output refusal,
ledger reload, exclusive lock, malformed-ledger refusal, usage recording and
overrun refusal, and the unsupported-API refusal. These are the `budget.*`
checks.

## Output contract

The runner itself prints one JSON object and nothing else on stdout. Use the
silent npm form above (or direct `node`) for machine parsing; plain npm run adds
banners first.

- `status`: `"pass"` or `"fail"`.
- `checks[]`: stable `id`, `status` (`pass`/`fail`) and optionally a bounded
  `detail`; ids are prefixed `runner.`, `phase1.` or `phase2.`.
- `counts`: pass/fail/total.
- `phases`: child exit code, signal, timeout flag and duration.
- `mode`/`provider`: `offline-synthetic`, faux provider, `network: false`.
- `budgetGuard`: self-probe status/counts, the framing reserve, the enforcement
  shape and why real mode is not enabled.
- `notRun[]`: every acceptance area this runner deliberately does not exercise.
- `limits` and `durationMs`: bounds.

Exit codes: `0` all checks pass, `1` a check failed, `2` output/usage error.
`--output=<path>` additionally writes the report with exclusive creation; an
existing file is never overwritten.

Only synthetic markers and relative workspace labels appear in the report. The
generated workspace, SQLite store and evidence files are deleted at the end of
the run; no output is written into the repository by default.

## Real-model budget feasibility (2026-10-28: blocked)

The budget guard is implemented and self-probed, but real mode is not enabled.
The authorized cap cannot be enforced as a guaranteed upper bound for the
required compaction path.

Durable's manual compaction keeps about 20,000 estimated recent tokens, so the
transcript needs roughly 70,000 ASCII characters of filler before the early fact
is compacted. In the offline flow with one 70,000-character filler turn, the
fourteen payloads measured 519,845 characters in total (phase 1:
4,387/5,439/6,086/6,629/7,515/8,009/8,835/79,277/79,757/80,533 and a 3,225
summary; phase 2: 75,651/76,478/78,024). Repeated context dominates.

The guard's conservative bound is the UTF-8 payload bytes plus 4,096 framing
tokens per request: 519,845 + 14 × 4,096 = 577,189 tokens, above the authorized
320,000. The usual ~3.5 characters/token estimate would put actual usage near
148,500, but that is an estimate, not a pre-dispatch guarantee. Enforcing the
estimate would violate the budget contract; enforcing the byte bound makes the
required path fail closed before completion.

Two provider-side limits remain. `max_tokens` is the only pre-dispatch output
control; whether the proxy counts reasoning tokens inside it is documented API
behavior, not a locally provable fact. The provider tokenizer and any
proxy-added framing are not observable before dispatch, so the 4,096-token
framing reserve is a conservative allowance, not a proof about those additions.

Options, all requiring an owner decision:

1. Raise the authorized input cap to at least 600,000 for this conservative
   guard (actual usage should stay near 150,000).
2. Accept an estimate-based input guard (for example the ~3.5 characters/token
   estimator Durable uses), explicitly not a hard guarantee.
3. Make the Gateway compaction policy configurable for acceptance and lower
   `keepRecentTokens`, shrinking the required transcript and repeated context
   enough to fit 320,000 under the conservative bound. This is a product change,
   not part of this batch.
4. Use a provider that exposes a pre-dispatch token-count endpoint (opencode-go
   does not), then reserve that exact count.

Until one is chosen, no live provider call is made and the runner stays
offline-only. The guard self-probe proves the refusal paths, ledger persistence
and lock exclusion with faux models.

## Bounds

- Each child process is killed at 120 s; compaction waits at most 20 s and each
  turn is bounded by the child timeout. The guard injects the same per-request
  timeout for a future real run.
- All state is created under one owned temp directory and removed in `finally`.
- No provider request, credential lookup, personal workspace, external fixture,
  channel send or persistent repository artifact is involved.
- Real mode reserves 4,096 framing tokens per request on top of the exact
  payload byte length, clamps the payload output limit, persists the ledger and
  holds an exclusive lock; an unfillable or unsupported bound is refused before
  dispatch.

## Not covered

Real-model summarization fidelity, A/B fixture comparison, provider/fallback
matrices, channels and scheduled delivery, credentials, the owner's real
workspace, Bubblewrap, and deployment are **not run**. Passing this runner is
evidence of plumbing over the real Gateway, not of model-quality or Python
parity. Real-model acceptance remains an owner-approved later step; the
feasibility section above records why the current cap cannot yet be enforced as
a guaranteed bound.
