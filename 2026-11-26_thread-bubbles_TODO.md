# Thread bubbles, auto-titles, side-thread crons

- [ ] Brief 1 — gateway: classifier picks emoji + verb for side threads (`badge` on ThreadInfo); default "New thread" title becomes "<emoji> <verb>"; opt-in config
- [ ] Brief 1 review (Pi gpt-6.2-sol low) + merge
- [ ] Brief 2 — PWA: phone-only row of ≤5 bubbles above the composer (Main 🏠 + newest-activity side threads, current excluded); Opus implementer
- [ ] Brief 2 review + Opus screenshot check + merge
- [x] Brief 3 — cron created in a PWA side thread is registered as Main's job (runs/delivers/listed in Main)
- [ ] Brief 3 review (+ second reviewer if blockers) + merge

## Log

### 2026-11-26
- Decided: horizontal bubble row above composer, phones only; recency = last agent activity (`lastAt`); titles = emoji + verb only (no free-text model call); side-thread crons re-homed to Main.
- Implementers: brief 1/3 Pi deepseek-v4.1-flash high, brief 2 Claude Opus 5.5. Reviewer: Pi openai-codex/gpt-6.2-sol low.
- Briefs 1 and 3 started in parallel; brief 2 waits for brief 1's protocol field.

### 2026-11-26 (Brief 3)
- Implemented the side-thread → Main re-home in the cron tool's origin resolution (`originFor`), wired
  by `runtime/cron-host.ts` and `runtime.ts`; app Main is resolved through the gateway's ordinary
  mapped-chat admission and a resolution failure refuses the call instead of placing the job elsewhere.
- Verified the capture cannot widen: both Main and a side thread are ordinary app chats, so
  `captureFor("scheduledRun", origin)` is identical for either.
- Recorded the deliberate consequences in `docs/CRON.md` and `docs/APP.md`: the app channel still holds
  a Main result until Main has its own admission evidence, the thread `tasks` view stays per-thread,
  and legacy side-thread jobs are not migrated (cancel them with `pedellus cron cancel`).
