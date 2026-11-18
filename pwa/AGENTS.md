# Agent notes for `pwa/`

Global rules live in `~/AGENTS.md`; repository rules in `../AGENTS.md`. Claude Code auto memory is off on this
machine; durable agent preferences for this project go here.

## Subagents

- Code: Pi `openai-codex/gpt-6.2-sol`, thinking medium, one worktree per task
  (earlier: Pi `opencode-go/glm-5.3`, thinking high).
- Anything that needs vision (UI polish, judging screenshots): Claude Opus 5.5,
  effort medium. GLM-5.3 cannot see images.
- No swipe navigation in the app (collides with Safari's back gesture).
- Pi children ask for approval on commands they flag as risky; answer them.

## Delegation briefs

- Keep each task small and scoped: 3–4 items, one feature per brief, a commit
  after each item. Split bigger work into a sequence of briefs.
- GLM-5.3 suits well-scoped work (app UI, mock gateway, small diffs). Use Sol
  or Opus for gateway work that touches security invariants, durability or
  forks.
- Tell workers to re-read a file after any failed or partial edit before
  assuming it applied.
