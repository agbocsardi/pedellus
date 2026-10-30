# Core acceptance

`npm run test:core-acceptance` is a disposable, offline acceptance run of the
actual built Gateway. It proves that the shipped wiring — not a test double of
it — can carry one conversation through context discovery, an on-demand skill,
topic-memory read/write through the configured coding tools, native compaction
and, in the default offline run, a fresh-process reopen under a narrowed
configuration.

It is not a unit-test suite. The default and rehearsal modes are offline and
make no provider call; `--mode=real` is the separately authorized live path.

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
   directory. It configures `read`/`write`/`edit`, proves those tools are
   offered, writes a topic memory file through the configured `write` tool, reads
   it back through the configured `read` tool, asks for the unregistered `bash`
   tool and checks the native refusal result (this does not exercise the
   call-time ceiling/capture hook, which `tests/config-tool-authorization`
   covers), and runs a native manual `Conversation.compact()`.
2. **Second process** — only in the default offline run, reopens the same SQLite
   state and workspace with `toolAllowlist: ["read"]`, checking that only the
   configured read tool is offered, then verifies that the early fact arrives in
   a normal model request **through the placed compaction summary**, that the
   original early turn text does not, and that bootstrap files, the memory
   manifest and the skill summary are rediscovered from Markdown. The skill body
   and topic body load on demand through tool results. `--mode=real-rehearsal`
   and `--mode=real` run the separate real-flow phases instead, which keep the
   full configured `read`/`write`/`edit` set and do not narrow it.

The early user turn is the only source of the acceptance fact and also carries a
distinct raw-turn sentinel. The topic memory file uses its own marker, so a topic
read or write can never satisfy the fact assertion. The runner proves the
summarizer request contains the fact and the sentinel in the same early user
block, then checks the placed compaction summary message is the only message in
the phase-1 context and in the phase-2 request that contains the fact. In phase 2
the raw sentinel, the topic body marker and the skill body are absent until their
own tool results load them.

The faux provider is the only model endpoint in offline and rehearsal modes.
The summarizer request is real
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

## Real-model acceptance

The owner set the conservative input cap to 600,000 token-equivalents
(20 requests, 20,000 output, one synthetic run). One owner-approved live run
passed on 2026-10-30; see the result below. `--mode=real-rehearsal` runs the
flow with the faux provider and no network; `--mode=real` additionally requires
`--api-key-env=NAME` and first runs that rehearsal as a preflight.

The flow uses one 70,000-character filler turn so Durable's manual compaction
has an old prefix, then the measured full sequence:

- phase 1: skill load + early fact (2 requests), topic write (2), topic read
  (2), one filler turn (1), native compaction summary (1);
- phase 2: fresh process, one recall + skill + topic-read turn (2).

The early user instruction scopes its no-echo rule to that turn's immediate
conversational acknowledgement and says nothing about summarization or
compaction, so it does not bias the summarizer. The real flow still records
fact/sentinel occurrences inside and outside the placed summary, so a model
echo is distinguishable from genuine leakage. It rejects a fact outside the
summary or a sentinel outside the summary, not a value quoted by the
summarizer. The offline scripted summary never quotes them, so its stricter
checks remain.

The exact-marker pass rule is unchanged. To distinguish omission from reformatting
without recording transcript text, real-mode observations classify the placed
summary text (and, in phase 2, the recall answer) as `exact`, `normalized`
(case/separator variant), `digits-only` or `absent`, with a character count and a
bounded hash. These are observations only: no check accepts a variant. Phase
observations and bounded per-request hashes are recorded as soon as they are
computed, and the `finally` block still writes them when a later check fails, so
an early exit keeps the failure evidence.

An earlier rehearsal measured **10 requests**, about **318,000** conservative
input-token equivalents and **17,920** output reservation (faux reported usage:
103,137 input / 232 output). The 2026-10-30 preflight on the simplified assistant
reserved **348,047** input and **17,920** output over 10 requests. Both fit the
600,000 cap; live dispatch still reserves each actual request against the
remaining ledger.

Run:

```bash
npm run build
node scripts/core-acceptance.mjs --mode=real-rehearsal
node scripts/core-acceptance.mjs --mode=real --api-key-env=OPENCODE_API_KEY
```

The live command requires separate owner approval for each run; the successful
run below does not authorize retries or a provider matrix. Live mode runs the
offline rehearsal first and refuses to start if it fails or exceeds the caps. Only after that gate does a
child read the named environment variable, and it passes only that variable to
`createProviderModels`; no owner config, ambient environment, personal
workspace or non-auth credential is read. A phase-1 failure skips phase 2 so a
failed attempt cannot turn into a second run.

Budget behavior: generation requests may reserve up to 1,536 output tokens and
the summarizer up to 4,096, while the shared total remains capped at 20,000.
`requests` counts reservations committed before dispatch; `refused` counts
pre-dispatch refusals and is never a dispatch. The ledger is replaced by a
temp-file rename under an exclusive lock, but it is not fsync'd and is not a
power-loss-durable accounting store. Only `streamSimple` and `completeSimple`
are guarded; `stream`, `complete`, deferred/cancel, image, classifier and
catalog-refresh methods fail closed. A provider that never calls `onPayload`
fails closed through an abort/timeout race with code `unobserved`.

Review points before the single live call:

- `scripts/core-acceptance-budget.mjs`: reserve-before-dispatch, persisted ledger,
  exclusive lock, serialized mutations, output clamp, unsupported-payload/API
  refusal, and actual-usage overrun checks. The self-probe covers them.
- `scripts/core-acceptance.mjs`: `runReal`, `runRealFirstPhase`,
  `runRealSecondPhase`, and `realGatewayConfig`. Confirm the preflight gate, the
  isolated one-variable provider environment, the phase-2 skip after a failed
  phase 1, that the live child reads the credential only after the budget
  lock is held, and that observations are recorded before the checks and in
  `finally` so an early exit still leaves evidence.
- The report carries `assumptions`, `caps`, per-request `budget.records`
  (bytes, bounds, hashes, usage), `observations`, and phase timings. It carries
  no transcript, fact/body marker, credential or host path.

### 2026-10-30 — one live run passed

Source checkout: `7fa9804` (runtime code from the reviewed lean-assistant batch).
Native OpenCode Go / `deepseek-v4.1-flash`, thinking `low`, synthetic workspace
and disposable SQLite store only. Typecheck/build and the offline rehearsal
passed before live dispatch. No retry or second live experiment was run.

| Observation | Result |
| --- | --- |
| Live checks | 39 passed, 0 failed |
| Whole report (rehearsal + live + runner gates) | 95 passed, 0 failed |
| Provider requests | 10 of 20 allowed; 0 refused |
| Conservative input reservation | 348,544 of 600,000 |
| Output reservation | 17,920 of 20,000 |
| Provider-reported input/output tokens | 62,350 / 1,629 |
| Budget violation | None |

The live model loaded a skill, wrote/read topic memory, produced the native
compaction summary, reopened the same conversation in a fresh process and
returned the exact early synthetic fact. That fact was present only in the
placed summary, not in other messages or the system prompt. The live summary
also quoted the raw-turn sentinel; it remained confined to the summary rather
than being replayed as the original turn.

This is evidence for one skill/memory/compaction/reopen story, not broad recall
quality. Reset-delimited episode summaries and model-facing raw-history search
remain offline-only evidence from `tests/history-lifecycle.behavior.test.mjs`.
No live channel, scheduled send, personal workspace, Bubblewrap or deployment
was exercised. Budget accounting retains the assumptions below, not a billing
or physical-durability guarantee.

Sanitized full-report SHA-256:
`33bba490d977adcc24e79e352fb2d555ce60d2fa032156bca36fa80200a53cb1`.

## Guard assumptions (explicit, not proven from source)

- The input reservation is the UTF-8 payload byte length plus 4,096 framing
tokens per request. Payload bytes bound tokens only if every provider token
covers at least one byte (a byte-level tokenizer). The opencode-go tokenizer is
not verified from source.
- The 4,096-token framing reserve is a conservative allowance for chat-template
  and proxy-added framing. It is not a proof that the provider adds no more.
- The output reservation assumes the provider honours `max_tokens` as the total
  generated-token cap, including reasoning. opencode-go's reasoning accounting
  is not verified from source.
- The guard sees pi-ai's pre-dispatch payload. Provider- or proxy-internal
  transformations after that hook are unobservable.
- The rehearsal measures a faux synthetic payload. The live run re-reserves the
  native adapter payload, so the measured bound is a preflight floor, not the
  live exact bound. The live guard can still fail closed mid-run if real
  responses are larger than the rehearsal.

These assumptions are repeated in every real-mode report. If any input or
output payload lacks a recognised limit, or the adapter has no pre-dispatch
hook, the guard refuses before dispatch. A live run therefore remains an
acceptance experiment, not a proof about provider accounting.

## Bounds

- Offline children are killed at 120 s. Real children are killed at 900 s; each
  provider request is also capped at 120 s by the guard.
- Real mode reserves 4,096 framing tokens per request on top of the exact
  payload byte length, clamps the payload output limit to the remaining output
  budget (1,536 for generation, 4,096 for the summarizer, shared 20,000 total),
  persists the ledger and holds an exclusive lock; an unfillable or unsupported
  bound is refused before dispatch and counted as a refusal.
- All state is created under one owned temp directory and removed in `finally`.
- Offline mode makes no provider request, credential lookup, personal workspace
  access, external fixture call or channel send. Live mode is opt-in and reads
  only the named credential variable.

## Not covered

The live result above covers only its single synthetic story. Broad model
quality/summarization fidelity, real-model reset/history-search recall, A/B fixture
comparison, provider/fallback matrices, live channels and scheduled delivery,
the owner's real workspace, Bubblewrap and deployment remain unverified.
Passing the offline rehearsal alone establishes wiring and budget fit, not model
behaviour or Python parity. Any further live experiment needs owner approval.
