# Native provider/auth and classifier integration — 2026-10-31

## Checklist

- [x] Inspect clean worktree at `f17a45a`; read project docs, pinned Pi docs and the Pi AI README.
- [x] Remove the application provider/credential whitelists; resolve native Pi AI provider IDs, documented legacy aliases and explicit custom providers.
- [x] Add Durable's independent private `CredentialStore` under the configured `dataDir`; never read or write Pi's store.
- [x] Keep explicit API-key environment references, native provider environment resolution and native OAuth.
- [x] Add terminal `login`/`logout` with native UI-neutral provider/method selection and browser/device-code prompts.
- [x] Validate configured chat-provider auth before storage opens; never log in at startup or from a model/channel turn.
- [x] Add an explicit custom compatible-provider block using native `createProvider()` and native API implementations.
- [x] Expose one explicitly configured `classifierModel` through Code Mode `models.*`; do not register image generation.
- [x] Gate classifier tasks to mapped chats/captured workers and capture the model identity in worker narrowing.
- [x] Preserve SDK `openGateway(..., { models })`, model presets/allowlists, prepared dispatch, channel controls, workers, digest and defaults.
- [x] Update `PROVIDERS.md`, `MODELS.md`, `CODEMODE.md`, `CLI.md`, `README.md`, `SETUP.md` and `SERVICE.md`.
- [x] Run baseline offline checks and bounded synthetic probes.
- [x] Commit in the prepared worktree; leave independent review and merge to the parent.
- [x] Address independent review blockers: lock-wait liveness, pinned credential
  sources, explicit single classifier authority, image-helper honesty, worker
  capture narrowing, own-property safety, login diagnostics, canonical store path.
- [x] Re-run offline checks and the post-review synthetic probes; keep review fixes
  in their own commit for a fresh reviewer.

## Log

### 2026-10-31

- Reworked `src/providers.ts` around `builtinProviders()`, `createModels()`,
  `createProvider()` and native API implementations. Removed the nine-provider
  gate and env-auth/OAuth stripping. Kept an explicit compatibility map for the
  five existing spellings.
- `PortConfig.credentials` is now an open provider-spelling map validated only as
  environment names. Added the strict `providers` custom-provider block.
- Added `src/auth/store.ts` (private file credential store, atomic writes,
  cross-process lock, stable OAuth device ID) and `src/auth/cli.ts` (terminal
  native login/logout). Wired `login`/`logout` into the CLI.
- Runtime creates its own store, fails early when an allowlisted chat provider
  has no credential, and preserves host-supplied `Models` unchanged.
- Code Mode now passes `models: true`, removes the native image-generation tool
  and its description, adds the classifier nested tool only with Code Mode, and
  refuses generation. Worker capture includes the classifier with Code Mode and
  prunes both together.
- Offline evidence: typecheck/build; 306/306 behavior; 2/2 execution; 83/83 core
  acceptance. Synthetic probes: `/tmp/nanobot-native-provider-probe.mjs`,
  `/tmp/nanobot-worker-classifier-probe.mjs`,
  `/tmp/nanobot-worker-classifier-narrowing-probe.mjs` (all pass; temporary
  directories, synthetic credentials, no network or real login).
- HEAD on worktree branch `t3/native-provider-classifier-integration`, based on `f17a45a4`.
- Remaining: independent reviewer, then parent merge. Real provider, OAuth,
  Telegram and service operation remain unverified.

### 2026-10-31 — review fixes

Cherry-picked `9b9bcfe` onto a worktree based on `f17a45a` (clean pick), then
fixed the independent review findings:

- `FileCredentialStore`: the lock poll timer is no longer unref'd, so a waiting
  login/logout process stays alive until release or abort; the wait stays bounded
  by the existing deadline/abort, a stale lock is reclaimed, the store directory is
  created and chmodded `0700`, the file must be a regular file opened with
  `O_NOFOLLOW`, and the gateway resolves the same canonical `dataDir` that
  `login`/`logout` prepare (with a mismatch refusal if it changes during startup).
- `credentials.<provider>` now pins its named environment variable: unset or blank
  fails closed with a configuration error instead of falling back to native ambient
  variables. Stored credentials keep precedence (documented), custom providers
  follow the same pinned/keyless/stored rules, and two spellings of one native
  provider may not name different references.
- Classifier authority is one optional `classifierModel` `{ provider, modelId }`
  pair (owner direction: no list and no generalized model permission system).
  Absent means unavailable: the nested tool is not registered, catalog discovery
  returns no classifier, and calls fail without a model request. The call-time hook
  checks the exact pair (forged objects only resolve to the catalog entry), the
  scoped catalog hides all image models, and worker captures store the identity so
  removing or changing the configuration prunes it permanently.
- Own-property safety for legacy aliases, custom provider lookups and environment
  reads; prototype-named keys are clear diagnostics rather than prototype members.
- Login/logout print fixed, specific diagnostics and never raw provider/store text.
- Docs and AGENTS updated: provider/auth layout and invariants, default-deny
  classifier, accurate nested-tool usage accounting (`pi.usage` tool bucket, not
  the Code Mode result), and the native `models.generateImages` global constraint.

Checks: typecheck/build; 306/306 behavior; 2/2 execution; 83/83 core acceptance.
Post-review probes (temporary dirs, synthetic credentials, no network):
`/tmp/nanobot-store-lock-probe.mjs`, `/tmp/nanobot-auth-authority-probe.mjs`,
`/tmp/nanobot-classifier-authority-probe.mjs`,
`/tmp/nanobot-worker-classifier-grants-probe.mjs`,
`/tmp/nanobot-auth-cli-probe.mjs`. Remaining: fresh independent review, then the
parent's merge. Real provider, OAuth, Telegram and service operation remain
unverified.
