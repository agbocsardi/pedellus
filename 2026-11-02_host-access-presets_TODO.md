# Host access and preset completion — 2026-11-02

- [x] Add an explicit full-host tool access opt-in, preserving scoped defaults, tool authority, worktree/digest isolation, and managed-store protection.
- [x] Document access semantics and validate using existing checks plus disposable runtime probes.
- [x] Configure the remaining legacy preset names using native OpenAI ChatGPT auth and the existing Umans endpoint/key.
- [x] Validate configuration/catalog/auth without dispatching paid model probes or changing the default/summary selections.
- [x] Activate at a safe gateway restart and verify the live preset list and access mode; leave legacy unchanged.

## Log

### 2026-11-02

Owner requested all legacy presets and full-machine access as the service user, retaining Telegram owner authorization. Approved native OpenAI routing for Luna/Sol using the existing Durable ChatGPT login, rather than a separate legacy Codex login. Prior recall edits were checkpointed at 38fee706; private files and pre-existing untracked notes remain uncommitted. Existing Umans key is already provisioned in Durable. Live Umans model metadata was read without a generation request. Current foreground remains ds-flash/high; summary remains ds-flash-summary/low. No implicit root privileges or new model fallback behavior.

Implemented restrictToWorkspace:false as a host-wide file/cwd opt-in with the real user HOME. Defaults remain scoped. File guards exclude managed data, resolved aliases and opened descriptors; removal/rename also refuse protected ancestors. Host shell non-confinement, filtered environment and command safeguards are explicit in EXECUTION.md/TOOLS.md. Worktree checkouts reside under dataDir: the first full suite caught the initial blanket protected-root rule blocking a worktree write; fixed by retaining that child's existing checkout-only containment instead of denying the checkout itself. Final typecheck/build, 400/400 behavior and 2/2 execution checks passed. Disposable probes verified outside-workspace read/write/cwd/HOME, scoped defaults, protected-data alias denial and ancestor-mutation refusal, and supported thinking levels for every preset.

Private instance config now includes luna/xhigh and sol/high through native OpenAI, umans-ds-flash/medium, umans-flash/off, and oxalpha/medium through the existing Umans OpenAI-compatible endpoint. Foreground ds-flash/high and summary ds-flash-summary/low are unchanged. Credential checks used the running gateway environment and its own stored OpenAI OAuth without refresh, copying credentials or generating a paid response. Umans model contexts/prices came from GET /v1/models; legacy Umans output ceilings were retained. Unverified Umans cache-price fields are explicit incomplete numeric metadata, not free-cache billing claims; details and rollback config are private under `.migration-work/presets-host-access-20261102/`.

Activation: first native /restart correctly refused live work; nothing was interrupted. A later idle /restart succeeded. Live CLI listed all seven presets and selected each new preset without a generation, then restored default in the dedicated configuration-check chat. Durable is active with zero supervisor restarts; legacy and watchdog timer remain active. Existing owner Telegram authorization, tokens, schedules and summary budget were not changed. No new permanent tests were added; new feature source remains uncommitted, separate from the owner-approved prior recall checkpoint.
