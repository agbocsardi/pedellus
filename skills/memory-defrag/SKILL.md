---
name: memory-defrag
description: Reorganize workspace memory topic files into a clean hierarchy on request. Use when memory files overlap, lack descriptions, or have grown unwieldy.
---

# Memory defrag

This port has no Dream, cursors, or subagent spawning. Reorganize ordinary
Markdown files with the tools the conversation actually has: `read`, `write`,
`edit`, and `bash` when granted.

## Scope

Only topic files under `memory/` ending in `.md`, excluding `memory/system/`,
`MEMORY.md`, and `HISTORY.md`. Do not create or rewrite `history.jsonl`, cursor
files, `SOUL.md`, or `USER.md`.

## Procedure

1. Inventory. Start from the memory manifest when the host enables it. With a
   granted `bash` tool, list `memory/` and read every in-scope file; without one,
   read the paths the manifest names and say which files you could not inspect.
   Note size, description, and overlap.
2. Plan a hierarchy of focused files, for example:
   `memory/projects/<name>.md`, `memory/people/<name>.md`,
   `memory/infra/<host>.md`, `memory/decisions/<area>.md`.
3. If `bash` and git are available, checkpoint before editing:
   `git add memory/ && git commit -m "memory: checkpoint before defrag" || true`.
4. Reorganize with `write` and `edit`:
   - split files covering unrelated subjects;
   - merge duplicates, keeping each fact once;
   - remove resolved incidents, superseded decisions, and ephemeral state.
     Deleting a file needs a granted `bash` tool and a plain `rm <path>`; the
     shell blocks recursive deletion. Without `bash`, merge or clear the file
     and report anything still waiting for deletion;
   - give every file a specific one-line `description:` frontmatter.
5. Verify that every file has a description, no fact appears twice, and no file
   mixes unrelated subjects.
6. If git is available, commit with a summary:
   `git add -A memory/ && git commit -m "memory: defrag - <summary>"`.
   Otherwise, or when the commit fails (no host git identity in the guarded
   shell), leave the files written and say that no commit was made.
7. Report files created, merged, or deleted; facts removed; and the commit SHA
   if there is one.

Do not invent a memory index, search database, or consolidation run. If the
workspace is not a git repository, skip the checkpoint and commit steps rather
than creating repository state.
