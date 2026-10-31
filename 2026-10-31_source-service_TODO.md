# Source-run test-bot service — 2026-10-31

## Checklist

- [x] Inspect the clean source checkout, current runtime support and inactive service.
- [x] Add a standard pinned TypeScript runtime and a small source launcher; retain the compiled entry point for builds/tests.
- [x] Point the package command, npm start and systemd templates at that launcher so process restart reloads source without a build.
- [x] Validate source-mode import, synthetic startup/restart and existing offline suites; keep secrets out of logs.
- [x] Install the user-local command and primary user unit without replacing Python's command or service.
- [x] Verify the configured token selects the separate test bot, then enable/start the Durable service as authorized.
- [x] Check local read-only status, clean service restart and original Python-service continuity; document operational state and remaining migration.

## Log

### 2026-10-31

Owner authorized a source-editable launch and service activation. Checkout is clean at `8a369f33`; the Durable unit/command are not installed. Native Node type stripping cannot run the existing parameter-property syntax/import layout unchanged, so use the established tsx runtime rather than rewrite the TypeScript tree or build on every restart. The launcher must run in-process so native execve restart reruns it and reloads source, without a watcher or extra supervisor. Preserve separate runtime-home state and the test-bot identity; do not replace or stop Python's bot. No personal-memory migration, classifier selection or extra model prompt is implied.

Added exact runtime dependency tsx 4.23.15 and `bin/durable-nanobot.mjs`, using its public `tsImport` API with the checkout tsconfig. Kept native source import side-effect-free and shared CLI diagnostics through exported `runCli`; the compiled entry point remains usable. Package bin, npm start and both unit templates now use the in-process source launcher. Existing service-readiness checks now exercise that shipped source executable. The launcher sets esbuild's synchronous-transform worker option before importing tsx so native execve does not strand a compiler helper; the real deployment uses the verified Node runtime. No file watcher, build-on-start step, second gateway or new supervisor was added.

Verification: typecheck/build and the existing full gate passed (306 behavior, 2 execution, 83 offline acceptance). After the final compiler-worker setting, all six source-service checks and the disposable exact-launcher restart probe passed again. The probe edits only a temporary TypeScript fixture, performs native restart without building, verifies the new value and stable PID, and checks no persistent/zombie compiler child remains. One initial live readiness probe incorrectly required a different socket inode; the filesystem reused it, so readiness was verified through the new socket timestamp and fresh local status instead.

With owner authorization, verified the configured bot is separate from Python, linked the package command into the existing user prefix, installed a statically verified primary user unit with real launch paths, reloaded the user manager, enabled and started the service. No Python command, unit, private original environment file or process was changed. Read-only local status and live native restart passed; the source gateway remained active with zero systemd crash restarts. No model prompt was submitted by the agent. The owner then independently sent a Telegram message, received a reply and confirmed the basic live path works.

Documentation now describes restart-to-reload source mode and distinguishes optional compiled builds. Persistent state remains under the approved runtime home. Memory/skills/instructions migration, explicit classifier selection and broader live feature/OAuth acceptance remain separate follow-up work.
