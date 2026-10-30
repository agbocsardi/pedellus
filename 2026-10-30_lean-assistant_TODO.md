# Lean assistant — 2026-10-30

## Checklist

- [x] Finish removal-first simplification and clean up its eight completed agents/four worktrees.
- [x] Archive superseded work orders and make this the single active plan.
- [x] L1 — Prove one offline memory lifecycle: learn, write topic memory, use skill, compact, reset, summarize, reopen, retrieve original evidence. Missing/failed summaries must not block raw recall.
- [x] L2 — Make unsuccessful scheduled work visible: fixed failure/empty-result notices through the existing Telegram outbox, with existing dedupe and unknown-send handling unchanged.
- [x] L3 — Make recovery understandable: specific value-free startup diagnostics and one stopped-store backup/restore smoke using the actual Gateway.
- [x] Independently review and integrate the three slices; fix only material findings.
- [x] Run the combined bounded offline suite and reconcile setup/current docs.
- [x] Obtain owner approval to proceed with one bounded live-model run on synthetic data using the existing acceptance runner.
- [x] Make the explicitly named runtime credential available and execute that run; record pass/fail without increasing caps or silently retrying.
- [x] Agree a CLI/Telegram pilot only after reviewing the live result. Do not imply offline checks prove useful real-model recall or live delivery.
- [x] Fix the demonstrated native-fetch/grammY abort-signal startup incompatibility, with independent offline regression review.
- [x] Show best-effort Telegram typing feedback during active user turns; stop on settlement/abort/shutdown without awaiting typing in model or answer delivery.
- [x] Complete the approved five-minute synthetic Telegram pilot and record the actual outcome; no personal workspace or broader rollout.
- [x] Owner accepts the pilot as sufficient. Defer the reminder-only follow-up; live reminder scheduling/delivery remains unverified, not a blocker for the next discussion.
- [x] Clean up this batch's resources after owner confirms integration.

## Current status and next priorities

The owner accepted the pilot. This implementation/acceptance batch is complete;
stop adding acceptance scaffolding or repeating timed pilots. Live reminder
delivery is still unverified, but the extra check is deferred by owner decision.
The test bot is stopped and completed agents are cleaned up.

The next usability target is a channel-neutral gateway, not a Telegram-specific
daemon. `openGateway` already owns shared runtime/storage; the executable currently
chooses Telegram or terminal. Improve the host so CLI and Telegram can use the
same owner, with Discord/Email as later adapters. Do not create a database owner
per channel, a second agent loop or a general-purpose operations framework.
Owner confirmed the shape: the gateway is the single agent/runtime owner;
CLI/TUI, Telegram and future Discord/Email are conversation surfaces, not runtime
owners. CLI connects to the running gateway and may disconnect without stopping
it. Conversations are separate by default and share workspace/Markdown memory.
Keep explicit config/workspace paths; no deployment or automatic service install.

Owner's annotation feedback sets these next product requirements (plan first,
not permission to start every branch or run live integrations):

- [ ] Keep on-the-fly Markdown memory updates through configured `read`/`write`/
  `edit`; make snapshot/manifest freshness explicit using the existing refresh
  path. Python-named `memory_read`/`memory_write`/`memory_search` are not present;
  add a dedicated operation only when it does more than wrap existing tools.
- [x] Single-owner gateway host plus independently attachable local CLI, preserving
  existing terminal commands, Durable controls, tool authority and recovery.
  Independently reviewed (`5712c98`, material F1 fixed in `ca662bb`); integration
  metadata only, no further source change.
- [x] Native Telegram command menu/autocomplete for commands actually implemented;
  reuse `setMyCommands`, with no speculative command router or dead menu entries.
- [x] Telegram incoming replies/quotes with bounded, labeled source context;
  agent-selected native replies and reactions restricted to observed messages in
  the authenticated current chat. Ordinary answers remain unthreaded by default.
- [x] Handle authenticated Telegram reaction changes as ordinary agent turns,
  with durable update dedupe and explicit added/removed context. Offline handler
  verified; private-chat reaction-update delivery remains unverified live.
- [ ] Wire configured MCP connections into the actual gateway and expose their
  registered tools through Code Mode/tool discovery. The current SDK-only Code
  Mode bundle is not MCP connectivity and is not installed by the shipped host.
- [ ] Implement channel-neutral attachment/voice media next: shared transcription
  configuration/processing, Telegram ingress first, native image content for
  photos with configured vision handoff, and document saving without extraction.
  Choose one initial speech backend; do not translate Python's entire provider
  registry.
  - [ ] Photos: send native pi-ai image content through the normal gateway turn;
    a configured vision-capable preset describes images for presets explicitly
    marked as text-only. Never silently switch the main model, and never refuse
    a photo merely because the selected preset is text-only.
  - [ ] Documents: save the original under `workspace/media/` only. This
    docs-only raw-file behavior overrides the earlier "established extraction"
    wording: no automatic PDF/OCR/Office extraction libraries and no hidden
    document pipeline in this slice.
  - [ ] Voice: local faster-whisper CPU/small/int8, owned by the separate media
    ingress worker; no cloud-audio upload, backend install or model download in
    this batch.
  - [ ] Vision handoff slice (this worktree): config-flagged
    `needsVisionHandoff` presets, one named describer preset, bounded raw images
    and descriptions, native `beforeRequest` transform only, focused offline
    checks. Does not own the Telegram adapter, CLI media options or transcription
    config.
- [ ] Add bounded ordinary background workers; scheduled memory curation may then
  be an ordinary cron job using those workers and the existing Markdown tools,
  not a standalone Dream subsystem.

Approved first implementation batch: channel-neutral gateway/local CLI attachment
and Telegram menu/reply/quote/reaction support. These are two independently owned
slices, with offline regression checks and independent review before integration.
Use a minimal local connection protocol, not a new agent loop or general service
framework. CLI disconnect leaves gateway/Telegram alive. Preserve explicit memory
refresh and document snapshot/manifest freshness rather than adding memory tools.

The owner selected local faster-whisper for the subsequent shared media ingress
slice, Telegram first; photos/documents remain high priority. No cloud-audio
upload, backend installation/model download or live integration is authorized by
this implementation batch. For documents, the owner clarified that saving the
original file is the whole feature for now: no automatic extraction, PDF, OCR or
Office processing. That overrides the old "established extraction" wording.
Photos are submitted as ordinary pi-ai image content through the normal gateway
turn (the adapter does no vision preprocessing); a configured vision-capable
preset describes them only for presets explicitly marked text-only.

Then wire product Code Mode + MCP, followed by bounded background workers and
ordinary scheduled memory curation. Photos/documents remain in the high-priority
media work, not a distant polish list.

Web search/fetch remains a useful reach feature alongside MCP. Other channels,
provider variants and richer UI follow actual use, not feature-for-feature parity.
This is a discussion order, not authorization to deploy, read personal settings,
spend on another run or start all feature branches.

## Product and constraints

One personal assistant, CLI or Telegram, one configured workspace. Config selects tools and named models. Markdown is memory; Durable owns transcript, compaction, tasks and recovery. Reuse those facilities. Keep host execution and optional direct-workspace Bubblewrap.

This follows the useful trunk of the [old assistant tree](plan/2026-10-29_assistant-tree_TODO.md) after the [completed removal pass](plan/2026-10-30_simplification_TODO.md). `plan/` is historical evidence, not competing instructions. Do not revive feature-for-feature Python parity, migration/archival SDKs, managed-copy execution or expiring tool grants.

The approved local gateway/client transport is the only new host boundary. No
additional service layer, agent loop, queue, retry framework, configuration mode,
dashboard, backup subsystem or general-purpose acceptance harness. A short integration check is better than a test platform. Prefer deleting obsolete work and fixing observed failures over speculative restructuring. Keep data integrity and provenance; never trade them for fewer lines.

The implementation batch is offline. A separately owner-approved live acceptance run may use only an explicitly named runtime credential, synthetic data and the existing budget guard; no credential-file discovery or value output. No security audit, personal data, migration, deployment or cutover. Live Telegram activity is limited to a separately owner-approved single-user synthetic pilot. The completed pilot batch does not itself enable web/MCP, product delegation or more channels. No standalone Dream engine will return: its desired memory-curation behavior is planned as an ordinary scheduled background job using the same worker/tools path. Standing intents, dedicated heartbeat and sustained goals remain excluded.

## Batch ownership and finish line

Use `opencode-go / deepseek-v4.1-flash`, thinking `high`, two implementation
workers in separate worktrees. Independent review before integration; at most
three active children including reviewers. Parent owns this plan, shared
manifest/root exports, integration and final checks. Workers commit bounded
results and report exact checks and limitations. Add focused permanent regression
checks; no sleep-based schedule waits or leaked gates/timers/subscriptions.

- **worker-gateway-surfaces:** local gateway server/client, CLI launch/attachment,
  terminal transport boundary, CLI/setup documentation and focused checks. Owns
  `src/cli.ts`, `src/terminal/`, new local transport modules, `CLI.md`, `SETUP.md`.
  Does not edit `src/runtime.ts` or Telegram files. No second Durable owner or
  remote/public listener; terminal disconnect does not stop gateway work.
- **worker-telegram-interactions:** menu registration, incoming reply/quote context,
  authenticated reaction turns, model-callable native reply/reaction actions and
  focused checks. Owns Telegram/new interaction modules, narrowly required runtime
  tool integration, `TELEGRAM.md`. Restrict actions to authenticated current-chat
  observed targets; no raw chat selector, inherited fork/cron authority or blind
  replay of ambiguous external sends. Preserve existing outbox/control behavior.

New test registration and root exports are parent integration requests. No
unrelated reformatting or edits to the other worker's region.

Done means offline checks demonstrate one gateway serving an independently
connecting/disconnecting CLI plus Telegram, separate conversations, implemented
command menu, preserved quote/reply context, agent-selected reply/reaction actions
and reaction-triggered turns with durable dedupe/recovery. Existing terminal
commands, config tool ceiling, outbox unknown-send handling and memory refresh
remain intact. No deployment or live-delivery claim; no live model/bot run.

## Session log

### 2026-10-30 — media ingress and configured vision handoff

Owner decisions for the next media slice: the gateway remains the sole Durable
agent owner; CLI/Telegram are separate conversation surfaces sharing the one
workspace and Markdown memory. Media follows voice, photos and documents. Photos
are accepted as normal pi-ai image content plus an adjacent labeled relative
locator, with the authoritative original image retained in the transcript; the
adapter does no vision preprocessing. Documents are saved under
`workspace/media/` only — no automatic extraction, PDF, OCR or Office libraries.
This explicitly overrides the earlier "established extraction" wording. Local
faster-whisper CPU/small/int8 transcription belongs to the separate media worker.
The main model/preset is never silently switched.

Two disjoint media work orders share config/runtime only where stated. The media
worker owns Telegram/channel ingress, transcription/media config near `telegram`,
the media config parser, `src/cli.ts`/`runTelegram` options and Telegram files.
This vision worker owns `src/media/vision*.ts`, narrow vision-only runtime
model-selection/hook wiring, `MODELS.md` vision documentation, focused vision
checks and this plan entry. Config is shared but disjoint: this worker owns
`ModelPreset.needsVisionHandoff`, the `modelPresets` parser change, and
`PortConfig.visionHandoff` plus its parser/validation near `modelPreset`; the
media worker's top-level fields and parser stay untouched.

Vision finish line: a flagged text-only preset's model-bound request carries zero
raw images and is never silently left with them; the configured vision-capable
describer receives the image; a capable target keeps only the newest bounded raw
images and gets labeled descriptions for older ones; the persisted transcript,
original evidence and prepared dispatch are unchanged; invalid, recursive or
non-vision describer config fails closed; failures and cancellation never
fabricate a seen image; cache, single-flight, concurrency, image/description
counts and output are bounded; auxiliary describer calls are disclosed. Work is
committed on branch `t3/a5ce93e2`; parent integration records the final hash.
Only faux-model/temp-store checks were run. No live provider, bot, network,
credentials, personal settings, dependency install, model download or deployment
was used. Parent reported the gateway/CLI work independently reviewed and landed
in main as `7b9b8a9`; this vision branch still bases on `d9e0a3b` because the
runtime Telegram source is unchanged, and integration happens later, after a
clean vision review.

Independent review did **not** pass the first vision commit `86cd25e`. It found
four material gaps: the cron background-run prepare path dropped the vision
extension; single-flight inherited the first caller's abort signal, so one
cancelled conversation could reject another live transform and, because Durable
reports a thrown generation hook and then sends the original request, leak raw
images to a flagged model; the startup prepared-model pin was never consumed, so
a later retry of the same generation task could apply a stale image policy; and
the docs claimed more coverage than the code and misdescribed the compaction
limitation. The retained original implementer fixed these in the same worktree:
the cron path selects the non-authoritative vision extension, the describer call
is service-owned with per-waiter cancellation, non-cancellation hook failures
fail closed for flagged/unresolved targets, the prepared pin is consumed on use,
and the docs now state the real text-only compaction and summary-context loss.
Focused faux regressions cover a real background cron read-tool image round, two
concurrent transforms with one cancellation, hook fail-closed behavior, and
prepared-pin consumption. A fresh independent reviewer must review these fixes;
the failed reviewer is not resumed and nothing is integrated until that review
is clean. Owner permits 2–3 parallel implementers; independent reviews are
separate and do not consume an implementer slot.

### 2026-10-30 — channel surfaces and Telegram interactions

Owner clarified that the gateway itself is the single agent/Durable owner and
CLI/TUI is another conversation surface alongside Telegram and future channels.
Python's standalone CLI runtime is not the desired ownership model. Agreed
separate conversations by default, shared workspace/memory, and local
faster-whisper for later media work. Owner approved implementation and added
Telegram replies/quotes/reactions: agent chooses native reply threading; incoming
user reaction changes trigger turns. This batch is offline gateway/CLI plus
Telegram interactions; media/MCP/workers remain subsequent work. Replaced the
completed L1–L3 assignments with two bounded work orders and independent review.

Telegram worker completed `a16c962`; independent Pi / OpenCode Go / DeepSeek Flash
high-thinking review passed, independently checking 7 new interaction checks,
82 existing behavior, 2 execution and offline core acceptance. Parent fixed the
review's call-id collision finding at the root: action identity derives from the
Durable tool task id, with chat/target/payload-bound duplicate results. Parent also
kept unknown outcomes non-evictable to retain reconciliation evidence, clarified
retained-record dedupe, additional-message reply semantics and the private-chat
reaction-delivery uncertainty. Focused collision/unknown-retention checks added;
9 interaction plus 5 existing transport/typing checks pass with typecheck/build.
Integrated as `30d34f1` + `59c15d7`; manifest and authority docs updated by parent.
No broad optional test matrix or settled-text compaction added: bounded records
remain inspectable and the targeted changes cover the material findings. No live
bot/provider run. Gateway worker completed `5712c98`; independent review found
one material CLI input-loss defect (F1), fixed in `ca662bb`, and the reviewed
slice is integrated (see the integration note below).

### 2026-10-30

Owner confirmed the simplification and asked to continue toward a lean assistant with 2–3 implementation subagents at a time. Completed batch resources cleaned up after confirming all worker commits were patch-equivalent in main; unrelated older worktrees left untouched. Archived the former root plans into `plan/`. Baseline `b4fe8f1`: 21,496 source lines; typecheck/build, 71 behavior, 2 execution, 83 offline core acceptance and 48 faux real-flow rehearsal checks passed. This plan chooses useful end-to-end outcomes instead of restarting the old parity roadmap. Plan committed as `e3ab5b4f7231835886dd7f6e61c2ad39eaed8537`; launched all three slices from that explicit base:

- `worker-memory-story-4fe2eca5`, pane `w2J:p1`, workspace `w2J`, branch of the same name — L1 memory lifecycle.
- `worker-cron-outcomes-a308f483`, pane `w2K:p1`, workspace `w2K`, branch of the same name — L2 scheduled outcome notices.
- `worker-recovery-help-96b2cbb5`, pane `w2M:p1`, workspace `w2M`, branch of the same name — L3 actionable recovery and stopped-store restore.

All use OpenCode Go / DeepSeek v4.1 Flash, high thinking. Runtime regions are disjoint; no shared manifest edits. Await explicit reports, then independent review before integration.

L3 worker reported `d00a49cd8183a9e2ca0eccde6bd06ddead8a5ae2`: fixed store-lock/prepared-context startup diagnostics plus actual CLI checks and a stopped-store/workspace restore regression in the existing recovery suite. Worker reports typecheck/build, 73 behavior and 83 offline core checks pass. Independent `reviewer-recovery-help-f1a6e6a3`, pane `w2D:p3X`, is reviewing at the committed L3 checkout. No backup framework or automatic repair was added. Independent L3 review passed: actual CLI refusal tests preserve the blocked dispatch, restored mapping/transcript/memory/dedupe assertions are meaningful, retained gateway replay checks pass. Two doc-only clarifications (CLI vs SDK diagnostic detail, copy-step vs normal schema initialization) will be folded into integration. Integrated as `466d350`; parent typecheck/diff checks pass. Both doc clarifications applied; no executable change beyond reviewed commit.

L1 worker reported `c6ecf60`: one 464-line lifecycle test plus short HISTORY.md evidence; no source blocker found or source changed. Worker reports the new test passed under an outer 60-second timeout five times, plus baseline 71 behavior and 2 execution checks. It is not registered yet. Independent `reviewer-memory-story-a0fb8d9c`, pane `w2D:p3Y`, is checking provenance, pending/failed-summary fallbacks, cleanup and whether the test setup is proportionate rather than another acceptance harness. Independent review passed: actual original-entry marker attribution, pending/failed-summary retrieval and gate cleanup verified; setup judged proportionate to the four-phase story with no new shared harness. Integrated as `1400fda`; parent registered the file in test:behavior. No production source change was necessary, and no real-model usefulness claim is made.

L2 worker reported `3e59d604a90f136b07167056a158f5bf77576fee`: normal error/empty settlements use fixed job/occurrence notices through the existing outbox; abandoned/cancelled work stays silent, and capture retirement assertions cover success/error/abort. Worker reports 74 behavior, 2 execution and 83 offline core checks pass. Independent `reviewer-cron-outcomes-a1431f3e`, pane `w2D:p3Z`, is reviewing. Abort coverage uses `harness.abortTask`, not model-issued `cron remove`; no claim of the latter or live sends. Independent L2 code/test review passed. Reviewer found shipped cron skill prose and builtin table still describing error/empty silence; parent requested those exact guidance fixes plus removal of a pre-existing 'no channel delivery' claim in SKILLS_CONTEXT.md. Also requested direct job-id/occurrence assertions within the existing tests, not a new matrix. Worker completed `8c237a7` (four files: shipped skill/builtin/context prose and direct notice-identity assertions), then parent inspected and integrated as `94e12cb` + `b8448a1`. Parent softened skill wording to 'queued for delivery' rather than promising an external send always succeeds. No source change beyond reviewed L2 commit.

Final combined validation: removed stale dist, npm ci --offline, typecheck/build passed; 77/77 behavior (including the registered memory story), 2/2 execution, 83/83 default offline acceptance and 48/48 faux real-flow rehearsal checks pass. Root Markdown file links and diff whitespace checks pass. Production source is 21,542 lines, +46 from this batch baseline; additions are mostly focused regression evidence, not a new subsystem. All three slices independently reviewed and integrated. No live provider/channel, security audit, credentials/personal data, migration or deployment. Real-model recall/live delivery remain unproven; abortTask silence is covered, model-issued cancellation mid-uncooperative model call is not. Next useful gate needs owner approval for synthetic live-model acceptance; no broader feature work or acceptance harness is scheduled. Owner confirmed the result and requested cleanup/proceed. Closed all three reviewers and removed the three clean implementation worktrees and their patch-equivalent integrated branches; unrelated older worktrees left untouched.

For the next phase, owner approved proceeding with the existing bounded real-model synthetic acceptance runner: OpenCode Go / DeepSeek v4.1 Flash, low thinking for the product probe, at most 20 requests / 600,000 conservative input-token equivalents / 20,000 output, with offline rehearsal preflight. This is one controlled run, not parallel paid experiments; live Telegram remains out of scope. Credential presence check found no OpenCode key variable in the current environment; no credential value or file was read. Owner explicitly supplied a credential source for this run. Loaded only the selected OpenCode key into the runner environment; no value or unrelated configuration was printed or persisted.

One existing-runner live acceptance completed successfully on checkout `7fa9804`: 39/39 live checks, 95/95 whole-report checks including rehearsal/gates, 10 live requests, 348,544 conservative input reservation and 17,920 output reservation, no refused requests or budget violation. Provider-reported usage: 62,350 input / 1,629 output. Native DeepSeek v4.1 Flash (low) loaded a skill, wrote/read topic memory, produced compaction and recalled the exact early synthetic fact after fresh-process reopen, with the fact confined to the placed summary. No second experiment or retry was run. Typecheck/build and offline preflight passed. Recorded result and report digest in ACCEPTANCE.md; no credential filename/value or host path recorded there. Live reset/history-search quality, Telegram/scheduled sends, personal workspace and deployment remain unproven. Next decision: agree a hands-on pilot; no further provider spend or live sends are authorized by this completed run.

Owner chose planning a Telegram pilot and asked to reuse the previous smoke-test details. Recovered the captured 2026-10-26 session and matching historical test record: scripted live Telegram smoke completed, the owner confirmed the final reply, polling stopped, and persisted state was independently reopened. Saved private setup is still present (0600), token present and one decimal user ID valid; no token value or user ID printed or recorded here. Reuse that setup rather than asking for the same inputs again. Proposed pilot: five minutes, disposable workspace/store, configured read/write/edit (no bash), four synthetic prompts plus one reminder, existing 20-request/600,000-input/20,000-output model guard. Do not clear pending updates, alter webhooks or stop existing bot processes. Owner freshly confirmed sole polling ownership and approved the bounded five-minute live-channel run. Preflight confirmed the prior bot identity, no webhook and no pending updates; no webhook/pending-update changes were made.

Pilot startup exposed a real compatibility bug before listening: grammY passes a shim AbortSignal into Node's native fetch, which rejects it. Three startup attempts made zero model requests and zero outbound bot messages; they closed storage and released the zero-use budget. The five-minute listening window never began. Pilot paused. Started `worker-tg-transport-805e8521`, pane `w2N:p1`, workspace `w2N`, branch of the same name, from `63dce3a`: one narrow compatibility fix and offline cancellation/brand regression, no live credentials or calls delegated. Independent review required before resuming the already approved pilot. No new networking layer, configuration or dependency requested.

Transport worker completed `695fc457717320c2fb9e521d344eb52fc3d2a85f`: narrow per-call native signal bridge, preserving redirect refusal and cancellation; two offline native-fetch/data-URL regressions (both fail on unbridged transport). Worker reports typecheck/build, 2 new checks and 13 affected existing checks pass. Independent `reviewer-tg-transport-6462243d`, pane `w2D:p30`, is reviewing. New test registration remains parent-owned. Independent transport review passed: exact brand rejection reproduced offline; native pass-through, already-aborted/mid-flight cancellation, grammY timeout and per-call signal lifetime checked; no retry/unknown-send behavior changed. Reviewer ran typecheck/build, 2 new tests, existing 77 behavior and 83 offline core checks. Integrated as `63c46ea`, registered the new test in `ec86721`; parent typecheck/build, 79 behavior, 2 execution and 83 offline core checks pass. No live calls delegated.

With the reviewed transport fix, the approved pilot reached READY and polled for its five-minute window. It expired normally with 0 owner prompts, 0 outbound messages/edits, 0 model requests and no pending replies or budget violation. Owner reported a Wi-Fi outage, so this is a startup/polling/shutdown observation only, not end-to-end acceptance. No automatic pilot restart.

Owner requested Telegram typing feedback while the agent works. Next slice is a small best-effort `sendChatAction` lifecycle for active inbound user turns (including tool work), with periodic refresh and cleanup on settle/abort/shutdown. It must not delay model admission, previews or final replies, and must respect shared flood handling. No new config, queue, durable typing state or indicator for idle/scheduled-notice delivery. Add focused offline lifecycle checks and independent review before another pilot window. Started `worker-tg-typing-77c33d53`, pane `w2P:p1`, workspace `w2P`, branch of the same name, from committed base `335905fc7cc9a878b27d01b1a29da829e2ef3006`, OpenCode Go / DeepSeek Flash high. Worker completed `57e4c01f6ebfcae93e65b18bb23d1ce00c1fc6c0`: per-chat shared typing refresh, best-effort flood handling and three controlled offline lifecycle checks; worker reports typecheck/build, baseline 79 behavior, 2 execution, 83 core and 3 new typing checks pass. Independent `reviewer-tg-typing-e90e67ae`, pane `w2D:p41`, is reviewing. Independent typing review passed: single per-chat loop, timer cleanup and best-effort reply path verified; no new architecture required. A last in-flight action may expire naturally after settlement, acceptable for this feedback. Parent will correct the overly absolute non-blocking doc claim because Telegram's shared rate limit still applies, then integrate without further scope. Integrated as `6fa0000`, registered the three typing checks, and corrected the doc/comment to distinguish non-awaited typing from the shared Telegram rate limit. Parent typecheck/build, 82/82 behavior and 2/2 execution checks pass. No extra presence framework or per-loop cancellation layer added. Owner then asked to retry the Telegram pilot when finished; reopen the same bounded five-minute synthetic test (previous window consumed zero requests), with the saved single-user setup and existing budget.

The resumed pilot preserved a queued message from the allowlisted owner sent during the approved test period instead of clearing updates. Real Telegram accepted 11 typing actions, 5 messages and 1 edit. The owner confirmed the interactions worked well. The local four-prompt cap stopped polling when a fifth owner message arrived; that message was not admitted. This was not timer expiry. The cap was too tight for the guided sequence; no production behavior was changed to compensate. Paused no-dispatch store inspection confirmed skill/write/reset/history search+open/cron list activity and zero cron jobs, so reminder delivery remains unverified. Model use: 11 requests, 201,609 conservative input reserved, 16,896 output reserved; no refusal/violation and no pending replies at close. Bot is stopped; no automatic restart or extra paid run.

Recorded the narrow result in TELEGRAM.md. After owner confirmed the working interactions, cleaned the completed transport/typing workers and reviewers (4 agents, 2 clean worktrees and their patch-equivalent integrated branches). Other older unrelated resources remain untouched. A short separately approved reminder-only check was the remaining Telegram pilot item; do not repeat the whole sequence or silently renew the consumed budget.

Owner subsequently accepted this as good enough and explicitly asked to update the plan and discuss what comes next. The pilot batch is now complete by owner decision. Reminder-only live verification is deferred, not marked passed. No more testing, provider spend or implementation was started. The initial recommendation was ordinary-use setup, then reach features. Owner's subsequent annotations corrected the next priorities: gateway is channel-neutral (CLI plus Telegram, future Discord/Email), native Telegram command-menu niceties, MCP through product Code Mode, and high-priority photos/documents/voice. Memory already supports on-the-fly Markdown changes via configured read/write/edit, but not the Python-named memory tools or automatic snapshot refresh after each write. Current Code Mode is an opt-in SDK bundle only; no MCP client/config or shipped gateway installation exists. Python's voice flow is channel download -> shared transcription config/service -> provider -> labeled transcript in the normal user turn. Plan the equivalent shared ingress with one initial backend, rather than copying its provider registry. Dream was parked as a special subsystem, not rejected as a behavior: ordinary cron plus bounded background workers and memory tools should provide its essence. No implementation/live calls launched for these annotations.

Gateway integration: combined the independently reviewed gateway/CLI slice
(`5712c98` + `ca662bb`) with the approved Telegram interactions (`30d34f1` +
`59c15d7` + `d9e0a3b`) on one branch. The only integration changes are metadata and
docs: register the six new gateway/terminal checks in `test:behavior`, record the
single-owner launch in `AGENTS.md`, and update plan status. No reviewed functional
source was changed. Offline combined checks pass: typecheck/build, 97 registered
behavior checks (91 existing plus 6 gateway), 2 execution and 83 offline core
acceptance. No live provider, Telegram or deployment run; immediate-input, external
turn rendering and disconnect behavior are proven only offline.

Owner concurrency correction for following batches: run 2–3 IMPLEMENTERS, not 2–3
children total. Reviewers do not count against that implementer bound, and original
implementers are retained through review and fix rounds rather than replaced.
Parent orchestrates only. Independent media/vision reviews are still ongoing, and
native MCP plus product Code Mode wiring is forthcoming; neither is complete or
accepted here.
