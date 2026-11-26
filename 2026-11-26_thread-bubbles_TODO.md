# Thread bubbles, auto-titles, side-thread crons

- [x] Brief 1 — gateway: classifier picks emoji + verb for side threads (`badge` on ThreadInfo); default "New thread" title becomes "<emoji> <verb>"; opt-in `app.threadBadges`
- [x] Brief 1 review (Pi gpt-6.2-sol low) + merge
- [x] Brief 2 — PWA: phone-only row of ≤5 bubbles above the composer (Main 🏠 + newest-activity side threads, current excluded)
- [x] Brief 2 review + screenshot check + merge
- [x] Brief 3 — cron created in a PWA side thread is registered as Main's job (runs/delivers/listed in Main)
- [x] Brief 3 review (+ second reviewer) + merge
- [ ] Try on a real iPhone: bubble row, hide-on-keyboard, safe-area
- [ ] Enable `app.threadBadges` in the live config and watch the first few badges

## Log

### 2026-11-26
- Decided: horizontal bubble row above composer, phones only; recency = last agent activity (`lastAt`); titles = emoji + verb only (no free-text model call); side-thread crons re-homed to Main.
- Implementers: brief 1/3 Pi deepseek-v4.1-flash high, brief 2 Claude Opus 5.5. Reviewer: Pi openai-codex/gpt-6.2-sol low.
- Brief 1 merged after two reviews; a later send retries the badge while a thread has none (recovers after a classifier failure/restart).
- Brief 2 merged after one review (writable-only bubbles, live badge updates, hide on any keyboard fixed).
- Brief 3 merged after four reviews. Non-redirected cron adds keep the `tool:<provider call ID>` key; redirected adds use `side:<task id>`; a pre-upgrade side-thread job is reported only on an exact match; redirected failures use fixed text; only `CronRequestError`/`CronScheduleError` text reaches the model.
- Waived: a durable session map already aliasing `app:chat` to a side conversation (pre-existing corruption the restore path accepts; widens nothing). Known gaps: no crash-mid-tool replay test; legacy side-thread jobs not migrated (`pedellus cron cancel`); a fresh install holds a Main cron result until Main has one owner message.
