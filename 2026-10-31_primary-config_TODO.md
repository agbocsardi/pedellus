# Primary config and inherited environment — 2026-10-31

## Checklist

- [x] Checkpoint completed command/service naming and persistent-layout work.
- [x] Seed a private primary config using supported ds-flash, explicit runtime-home data/workspace paths, configured tools and Telegram admission metadata; do not start polling.
- [x] Copy existing environment entries without changing the Python original; add a dedicated prior test-bot token and verify private permissions without exposing values.
- [x] Point primary and secondary service templates at private per-instance environment files, preserving systemd-to-process environment inheritance.
- [x] Verify env-name references through the existing config/provider pipeline with synthetic inherited environment; no blanket interpolation or secret values in JSON.
- [x] Run applicable existing offline checks and document the resulting inactive setup and remaining migrations.

## Log

### 2026-10-31

Owner selected a checkpoint (`3ba49ea`), copying rather than moving the environment file, and a Telegram-ready ds-flash seed without gateway/service activation. Existing config supports credential, Telegram, web and MCP environment-variable names; systemd supplies actual values to the gateway process. Unsupported legacy provider routes are not silently replaced. Retain the Python installation, its original private environment file and its running bot unchanged. No secrets belong in repository files, logs or this checklist.

Owner subsequently required the earlier pilot bot rather than the Python bot. Recovered the pilot's credential source through read-only Atuin Threads inspection, verified the token differs from Python and its allowed owner matches, and added a dedicated environment-variable reference for it. The copied legacy environment entries and original file remain unchanged. Both new private files are regular mode-0600 files inside the mode-0700 runtime home; no credential values are in JSON or repository files.

Seeded the primary config with ds-flash/high, separate data/workspace paths, an initially empty memory-file selection, independent worker grants, coding/web/Code Mode, explicit lower-thinking digest model selection, and the test bot's admission metadata. No digest schedule, automatic episode summaries, MCP connections or media migration were activated. No gateway, SQLite store, Telegram polling, API request or service-manager action was started.

Updated only the source unit templates to read a private environment file alongside each config. Existing environment-name handling already supports inherited process values; no new interpolation or dotenv loader was needed. A synthetic child-process check exercised provider auth resolution and Telegram/web lookup from inherited environment, plus missing-credential refusal. Local checks confirmed legacy entries were copied unchanged, the chosen bot token is distinct, JSON contains no copied secret values, and no database was created. Existing gate passed: typecheck/build, 306 behavior checks, 2 execution checks and 83 offline acceptance checks, including static unit verification.

The owner then requested full native Pi AI provider/auth/custom-endpoint capability. That is the next implementation scope, not a claim that the current narrow adapter already supports it.
