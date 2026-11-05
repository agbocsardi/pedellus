# 2026-11-05 Telegram reply-context fix TODO

Approved fix: a replied-to Telegram message must contribute readable, bounded reference context
whatever shape Telegram delivered it in, including a received `rich_message.blocks` tree. The fix
must not be a cron-specific or recent-target-cache workaround.

## Checklist

- [x] Add typed, bounded received-message text extraction (`src/channels/telegram-content.ts`):
      text, caption, rich block tree (nested), explicit labels for empty/non-text bodies, no
      URLs/identifiers/button targets, depth/node/character budgets.
- [x] Use it for quoted reply context, including an explicit partial quote (`message.quote`), and
      for the inbound message's own observed-target excerpt; controls still parse `message.text`.
- [x] Preserve known target excerpts when a later observation is empty/unreadable; keep the earlier
      readable observation time so it is not presented as a fresh reading.
- [x] Keep same-chat-only authority: cross-chat/external replies add no quote and no target.
- [x] Focused regression tests (`tests/telegram-reply-context.behavior.test.mjs`): ordinary rich
      delivery, real scheduled rich delivery, nested blocks, entities/captions, labels, non-erasure,
      `/new` episode reset, reopen with no cached target, cross-chat refusal, partial quote.
- [x] Register the new test file in the npm behavior suite.
- [x] Update `TELEGRAM.md` and the Telegram invariant in `AGENTS.md`.
- [x] Typecheck, build, new suite, existing Telegram/rich/cron-origin suites, full behavior suite.
- [ ] Independent audit/review (separate agent); merge only after a clean review.

## Residual limitations (documented, not fixed here)

- A regular (non-rich) inbound message's own body admission is unchanged: an inbound *rich* message
  from the owner is not read as a new turn's body, only as reference/target text. This avoids
  granting rich content host-control or callback-interception authority by accident.
- A quote snapshot is not re-fetched from Telegram: an edited or later-unreadable original cannot
  be refreshed. The stored excerpt is the earlier readable snapshot, with its original observation
  time, never a claim about the current remote text.
- Labels are lexical, not semantic: a photo/unsupported body is reported as unreadable, and rich
  media is never downloaded, extracted, transcribed or described.
- Exact wire shapes for a given server/client combination remain inferred from the pinned Bot API
  schema; tests use the pinned received shape (`blocks`), not the input mirror (`markdown`).

## Session log

### 2026-11-05

- Root cause confirmed in `quotedMessageContext`: `quoted.text ?? quoted.caption ?? ""` ignored a
  received `rich_message.blocks`, so a reply to a rich cron/ordinary delivery produced an empty
  quote and overwrote the stored target excerpt with an empty string.
- Added `telegram-content.ts` (typed `RichText`/`RichBlock` traversal, display text only), extended
  `TelegramObservedTarget` with `textSource`, and made `observeTarget` keep known readable text on
  an empty/unreadable re-observation.
- Added the seven focused tests above. Verified they are real regressions: with the previous
  `telegram.ts`/`telegram-interactions.ts` restored and rebuilt, 6 of 7 fail (the extraction module
  test passes by construction); with the fix all 7 pass.
- Checks: `npm run typecheck`; `npm run build`; new suite 7/7; existing telegram-interactions /
  telegram-rich / cron-origin-delivery / telegram-media 68/68; `npm run test:execution` 2/2; full
  `npm run test:behavior` 548/548 in ~46s (inside the suite's 60s budget).
- Next: independent review of the diff in this worktree; no merge from this session.
