# Usage-driven harness improvements — 2026-11-16

## Worklist

- [x] Digest: distinguish recoverable reads from mutation failures; safe bounded provider retry behavior.
- [ ] Isolated cron: explicit captured read-only recall/MCP authority without management or recursive scheduling.
- [ ] Telegram conversation flow: bounded idle-message coalescing, passive reaction context.
- [x] Telegram inputs: location pins and attachment filename/MIME preservation.
- [ ] Owner interaction: structured questions/buttons with bounded authenticated lifecycle.
- [ ] Background progress: honest worker visibility and completion integration where supported.
- [ ] Stale host notices: explicit safe retirement without retrying/forgetting ambiguous answers.
- [x] Images: bound model-facing read payloads without modifying stored originals.
- [ ] Live model/preset/credential reload: explicit owner action with safe busy handling.
- [x] Operational defaults: source unit PATH/memory guidance; actionable git identity failures (no invented author).
- [ ] Web 403/browser and external COROS/T3 constraints: implement safe supported paths, document external limits.
- [ ] Independently review every implementation with Pi Codex Luna; fix findings before integration.
- [ ] Integrated typecheck, existing behavior/execution suites and offline acceptance.

## Boundaries

No live configuration edits, service restarts, production store mutations, or Python bot changes. Do not weaken security or silently discard ambiguous deliveries. New authority must be explicit, captured, call-time checked and revocable. No automatic browser/SSRF bypass or invented git identity. Implementation agents use independent worktrees and permanent focused regression checks. Configuration choices (including default preset) and operator provisioning remain deferred.

## Log

### 2026-11-16

Started from a clean checkout. Prior usage audit is a hypothesis list, not proof that every proposed workaround is safe. Requested implementers: Pi `opencode-go/deepseek-v4.1-flash`, thinking high. Requested independent reviewers: Pi `openai-codex/gpt-6-luna`. Plan parallel bounded implementations, then fresh independent review and sequential integration. Track actual outcomes and remaining external limitations here.

Integrated operational commit `9a03332f` after independent Luna review (no findings). Reviewer could not build in its checkout (`tsc` unavailable); parent reproduced typecheck/build and all 58 focused service/web/MCP/worker checks under the required 60s timeout (39.2s). Source units now fix PATH and account cgroup memory; hard caps remain explicitly operator-chosen/deferred. Git identity guidance never invents authors. Web 401/403 guidance does not bypass access controls. OAuth auth-required status requests owner login; proactive COROS refresh and external T3 completion remain unsupported, not claimed fixed. Other implementation work remains in flight.

User reduced concurrency to three agents total (including reviewers). Existing agents were not interrupted; no new launches until active work drops below that ceiling.

Digest Luna review found two P2 issues: unrelated same-path success was too permissive, and path normalization differed from execution. Parent fixed both in `903ded94` after integrating `2962f817`: repair now preserves operation and every intended replacement/content, with successful intervening read for edit retries, normalized using execution containment rules. Refused create-to-edit is conservatively not a repair. Typecheck/build and 25 digest checks pass under 60s. Findings fixed, none waived; semantic correctness remains model responsibility, not a host guarantee.

Telegram media Luna review found two P2 issues: reply pins lacked coordinates and old generic attachment locators could be stranded after a crash. Parent fixed both in `2c36ef66` after integrating `8a48bb83`: common extraction renders locations using existing readable source, and storage/Telegram pre-download reuse adopts legacy complete generic identity locators without renaming originals. Typecheck/build and 41 media/reply checks pass under 60s. Findings fixed, none waived. Invariant documentation updated. Image review and remaining implementations are still pending.

Integrated image commit `b141c508` after clean independent Luna review; parent reproduced typecheck/build and all 15 image/tool-policy/vision checks under 60s (4.1s). Native Photon copies are bounded, originals untouched; native pre-processor file allocation and repeated bounded image resend remain documented limitations. Isolated cron implementation `599dbb8` is awaiting independent review; no new reviewer launched because existing implementers still fill the three-agent ceiling. Telegram coalescing/passive reactions `c7075fa6` also awaits review. Parent pre-review spotted two cron concerns to address: live MCP refresh does not include scheduled targets (revoke then re-enable could resurrect a capture), and the no-coding-extension policy branch may retire an otherwise legitimate recall/MCP-only scheduled capture. Neither cron nor coalescing is integrated.
