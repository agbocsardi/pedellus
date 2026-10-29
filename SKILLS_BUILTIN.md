# Curated builtin skills

`skills/` is the port-owned builtin skills root. Point
`workspaceContext.skills.builtinSkillsRoot` at this directory's absolute path
when builtin skills are wanted. The root is explicit: there is no package
default and no fallback to `nanobot/skills/`. Loader behavior and config shape
are in [SKILLS_CONTEXT.md](./SKILLS_CONTEXT.md).

## Included

Adapted to the implemented tool surface: `read`, `write`, `edit`, and `bash`
when allowlisted and granted, plus the read-only `skill` tool and the opt-in
`cron` tool. No skill uses `always`; the prompt carries only the summary and the
body loads on demand.

| Skill | What it assumes |
| --- | --- |
| `memory` | Workspace Markdown topic files. A host-injected read-only manifest may list topics with descriptions or heading fallback; topic bodies are included only when explicitly selected. There is no memory-tree/search tool, Dream, or history. |
| `memory-defrag` | Reorganizes those files with read/write/edit/bash; no subagents or Dream state. |
| `skill-creator` | Authoring and loading skills with this loader's flat frontmatter subset, and the fixed per-conversation snapshot: a new skill appears in the next conversation, after a Gateway reopen, or after a host-exposed explicit refresh of the current conversation. No packaging scripts. |
| `github` | `gh` through granted `bash`, gated on `requires.bins: ["gh"]`. Authentication may be unavailable in the filtered shell, so the skill checks first and stops rather than placing secrets in the workspace. |
| `cron` | The opt-in `cron` tool (`add`/`list`/`remove`) with `at`/`every_seconds`/`cron_expr`, IANA `tz`, and isolated or origin mode. A successful non-empty isolated result may reach the authenticated Telegram origin through the outbox; origin mode and error/empty results send nothing. No per-job timeout argument. |

## Deferred

- `my`: there is no `my`/self-state tool, scratchpad, or model-adjustable runtime
  state. Model, iteration, and context settings are host configuration, and
  `workspaceContext` is fixed per conversation, so a port `my` skill would have
  to invent a tool.

Not shipped, per the owner selection: `summarize`, `weather`,
`image-generation`, `tmux`, `clawhub`, `update-setup`, and `long-goal`. The
Python tree in `nanobot/skills/` is reference only and is neither modified nor
copied wholesale. This directory answers the packaging follow-up recorded in
[SKILLS_CONTEXT.md](./SKILLS_CONTEXT.md); that document remains the loader
contract.
