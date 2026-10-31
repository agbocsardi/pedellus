# Native provider/auth and classifier integration — 2026-10-31

## Checklist

- [x] Inspect clean worktree at `f17a45a`; read project docs, pinned Pi docs and the Pi AI README.
- [x] Remove the application provider/credential whitelists; resolve native Pi AI provider IDs, documented legacy aliases and explicit custom providers.
- [x] Add Durable's independent private `CredentialStore` under the configured `dataDir`; never read or write Pi's store.
- [x] Keep explicit API-key environment references, native provider environment resolution and native OAuth.
- [x] Add terminal `login`/`logout` with native UI-neutral provider/method selection and browser/device-code prompts.
- [x] Validate configured chat-provider auth before storage opens; never log in at startup or from a model/channel turn.
- [x] Add an explicit custom compatible-provider block using native `createProvider()` and native API implementations.
- [x] Expose native classifier models through Code Mode `models.*`; remove image generation and its helper.
- [x] Gate classifier tasks to mapped chats/captured workers and include them in worker capture narrowing.
- [x] Preserve SDK `openGateway(..., { models })`, model presets/allowlists, prepared dispatch, channel controls, workers, digest and defaults.
- [x] Update `PROVIDERS.md`, `MODELS.md`, `CODEMODE.md`, `CLI.md`, `README.md`, `SETUP.md` and `SERVICE.md`.
- [x] Run baseline offline checks and bounded synthetic probes.
- [x] Commit in the prepared worktree; leave independent review and merge to the parent.

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
