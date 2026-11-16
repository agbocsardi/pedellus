# Usage-driven harness improvements — 2026-11-16

## Worklist

- [ ] Digest: distinguish recoverable reads from mutation failures; safe bounded provider retry behavior.
- [ ] Isolated cron: explicit captured read-only recall/MCP authority without management or recursive scheduling.
- [ ] Telegram conversation flow: bounded idle-message coalescing, passive reaction context.
- [ ] Telegram inputs: location pins and attachment filename/MIME preservation.
- [ ] Owner interaction: structured questions/buttons with bounded authenticated lifecycle.
- [ ] Background progress: honest worker visibility and completion integration where supported.
- [ ] Stale host notices: explicit safe retirement without retrying/forgetting ambiguous answers.
- [ ] Images: bound model-facing read payloads without modifying stored originals.
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
