---
name: skill-creator
description: Create or update workspace Agent Skills for this port. Use when packaging a repeated workflow, reference set, or tool procedure as a skill.
---

# Skill creator

This port loads skills from `<workspace>/skills/<name>/SKILL.md` and an optional
host-configured builtin root. The prompt carries each skill's name, description,
and locator; the body arrives only when the model calls the `skill` tool.
`always: true` does not inject a body here.

Each conversation captures its skill snapshot once, when it is created or the
Gateway reopens. A skill created or edited now is **not** visible in the current
conversation unless the host offers an explicit refresh for it (the local CLI
exposes `/refresh`): the summary and the `skill` tool keep serving the captured
set. Never assume such a control exists, and never try to verify a new skill
here. The host must also have enabled discovery
with `workspaceContext.skills`; without it, no workspace skill appears anywhere.

## Create a workspace skill

1. Pick a lowercase, hyphenated directory name. The directory name is the skill
   name; frontmatter `name` is not authoritative.
2. Create `skills/<name>/SKILL.md` with the granted `write` tool. If this
   conversation has no granted coding tool, print the file content for the user
   to save instead of claiming it was created.
3. Put trigger information in `description`, not in a "when to use" body
   section: the body is read only after the skill is selected.
4. Keep the body concise and imperative. Add a `references/` file only when
   content is too large or too situational for SKILL.md; link it from SKILL.md
   and read it on demand.
5. Verify what you can see: re-read the file with the `read` tool and check the
   flat frontmatter and the single-line JSON `metadata`. Do not call the `skill`
   tool for it when this conversation's captured set cannot contain it.
6. Tell the user the skill is not available yet. It becomes visible in a new
   conversation, after the Gateway is reopened, or, only if the host exposes an
   explicit refresh control (the local CLI's `/refresh`), after that refresh; a
   conversation never re-reads the skill directory on its own.

## Frontmatter this port accepts

The loader parses a flat `key: value` subset, not full YAML:

```markdown
---
name: deploy-check
description: Check a deployment without changing it. Use when the user asks whether a host is healthy.
metadata: {"nanobot":{"requires":{"bins":["ssh"]}}}
---
```

- `description` is required in practice; without it the directory name is used.
- `metadata` must be a single-line JSON object. When `metadata` uses an
  indented YAML block, anchors, tags, or multi-line values, the skill is
  unavailable rather than silently losing its requirement gates. Non-metadata
  keys are read only as flat `key: value` lines; YAML structures there are not
  interpreted.
- `requires.bins` and `requires.env` are gates. They are evaluated against the
  guarded shell environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TERM`,
  `PYTHONUNBUFFERED`), not the host process environment. A gate for a host-only
  credential will therefore never be satisfied and should not be used.
- `disable-model-invocation: true` hides the skill from the summary and the
  `skill` tool.
- Do not use `always`; bodies are never injected in this port.

## Bundled files

- Workspace skills may keep `references/`, `assets/`, or `scripts/`. The model
  can read them with the granted `read` tool, resolving relative paths against
  `skills/<name>/`.
- Builtin skills live outside the workspace. Their body loads through the
  `skill` tool, but their sibling files are not readable with workspace tools;
  keep builtin skills self-contained.
- Scripts are not executed automatically. A script runs only if the conversation
  has a granted `bash` tool and the model chooses to run it.

## Keep it honest

- Do not add packaging, marketplace, README, changelog, or setup files. This
  port has no `init_skill.py`, `package_skill.py`, `.skill` archive, or install
  command.
- Do not claim the skill is active in this conversation, automatic discovery,
  `always` bodies, YAML block metadata, or subagent execution.
- The real test is the next conversation (or this one after a host-exposed
  explicit refresh such as `/refresh`): its summary should list the skill and
  the `skill` tool should return the body. Say so instead of asserting it now.
