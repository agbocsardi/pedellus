# Agent notes for `pwa/`

Global rules live in `~/AGENTS.md`; repository rules in `../AGENTS.md`. Claude Code auto memory is off on this
machine; durable agent preferences for this project go here.

## Subagents

- Implementation: Pi `opencode-go/deepseek-v4.1-flash`, thinking high, one
  worktree per task (earlier: Pi `openai-codex/gpt-6.2-sol` medium, GLM-5.3 high).
- Review (fresh agent, no implementer context): Pi `opencode-go/glm-5.3`,
  thinking high.
- Anything that needs vision (UI review, judging screenshots): Claude Opus 5.5,
  effort low. GLM and DeepSeek cannot see images.
- No swipe navigation in the app (collides with Safari's back gesture).
- Pi children ask for approval on commands they flag as risky; answer them.

## Delegation briefs

- Keep each task small and scoped: 3–4 items, one feature per brief, a commit
  after each item. Split bigger work into a sequence of briefs.
- Gateway work that touches security invariants, durability or forks gets
  extra review scrutiny (and a second reviewer if the first finds blockers).
- Tell workers to re-read a file after any failed or partial edit before
  assuming it applied.
