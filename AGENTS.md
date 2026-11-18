# Agent notes for this repository

Global rules live in `~/AGENTS.md`. Claude Code auto memory is off on this
machine; durable agent preferences for this project go here.

## Subagents

- Code: Pi `opencode-go/glm-5.3`, thinking high, one worktree per task.
- Anything that needs vision (UI polish, judging screenshots): Claude Opus 5.5,
  effort medium. GLM-5.3 cannot see images.
- Pi children ask for approval on commands they flag as risky; answer them.
