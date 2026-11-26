# Thread bubbles, auto-titles, side-thread crons

- [ ] Brief 1 — gateway: classifier picks emoji + verb for side threads (`badge` on ThreadInfo); default "New thread" title becomes "<emoji> <verb>"; opt-in config
- [ ] Brief 1 review (Pi gpt-6.2-sol low) + merge
- [ ] Brief 2 — PWA: phone-only row of ≤5 bubbles above the composer (Main 🏠 + newest-activity side threads, current excluded); Opus implementer
- [ ] Brief 2 review + Opus screenshot check + merge
- [ ] Brief 3 — cron created in a PWA side thread is registered as Main's job (runs/delivers/listed in Main)
- [ ] Brief 3 review (+ second reviewer if blockers) + merge

## Log

### 2026-11-26
- Decided: horizontal bubble row above composer, phones only; recency = last agent activity (`lastAt`); titles = emoji + verb only (no free-text model call); side-thread crons re-homed to Main.
- Implementers: brief 1/3 Pi deepseek-v4.1-flash high, brief 2 Claude Opus 5.5. Reviewer: Pi openai-codex/gpt-6.2-sol low.
- Briefs 1 and 3 started in parallel; brief 2 waits for brief 1's protocol field.
