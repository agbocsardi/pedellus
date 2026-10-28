---
name: memory
description: Keep durable project facts in workspace memory topic files and recall them on demand. Use when a decision, preference, or gotcha should survive the conversation.
---

# Memory

Memory is plain Markdown in the workspace. When the host enables the memory
manifest, it injects a read-only topic manifest with one line per topic:
workspace-relative path and description. The manifest is navigation only; topic
bodies stay out of the prompt unless the host explicitly selects that file, so
read a topic before relying on it.

This port has no memory-tree or memory-search tool, no Dream consolidation, and
no dedicated `history.jsonl` search. Use the granted `read`, `write`, `edit`, and
`bash` tools on ordinary workspace files.

## Layout

| Path | Use |
| --- | --- |
| `memory/<topic>/<name>.md` | Topic files you may create and edit |
| `memory/system/` | Host-managed; do not edit unless the user asks |
| `memory/MEMORY.md`, `HISTORY.md` | Legacy names; never topics. Do not create or edit them here |
| `memory/history.jsonl` | Not maintained here; do not write it |

Descriptions in the manifest come from a one-line frontmatter `description:`;
if it is absent, the first Markdown heading is used. Frontmatter is the more
reliable and specific navigation hint:

```markdown
---
description: Fork maintenance - branches, sync workflow, deploy host
---

# Nanobot fork
...
```

## Save a durable fact

1. Search existing files first: with a granted `bash` tool, run
   `grep -rn "<subject>" memory/` or list `memory/`. Without `bash`, read the
   likely existing path directly and do not assume the directory listing.
2. If a file covers the subject, read it and edit in place. Replace stale facts;
   never keep a contradictory duplicate.
3. Otherwise create a small focused file under `memory/<topic>/`.
4. If `bash` and git are available, commit the change:
   `git add memory/ && git commit -m "memory: <what changed and why>"`.
   If git is unavailable, or the commit fails (the guarded shell has no host git
   identity), leave the files written and say no commit was made instead of
   inventing another store.

Do not save transient status, temporary errors, conversational filler, or facts
that a quick lookup answers.

## Recall

- Read the topic file when its manifest description or heading matches the
  question.
- The manifest is read-only; edit topic files, never the injected manifest.
- Use `grep` or `rg` through `bash` only if that tool is granted. There is no
  dedicated memory-search tool in this port.
- Treat `memory/system/`, `SOUL.md`, and `USER.md` as host-owned. They are not
  consolidated or rewritten by this port, and there is no Dream history here.

When memory looks disorganized, suggest the `memory-defrag` skill.
