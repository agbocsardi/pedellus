# Explicit-root skills discovery

`src/context/skills.ts` is a bounded, opt-in loader that turns Markdown skill
files into the existing `ContextSkillSnapshot` shape. Markdown remains
authoritative; this module stores no runtime state and installs nothing. Host
wiring into `openGateway` is a later slice.

## API

```ts
import { loadSkillsContext } from "./context/skills.js";
import { createContextExtension } from "./context/index.js";

const skills = await loadSkillsContext({
  workspaceRoot: "/srv/workspace",
  builtinSkillsRoot: "/srv/nanobot/skills", // optional, explicit
  disabledSkills: ["clawhub"],
  selectedSkills: ["project-guide"],
});

const context = createContextExtension([{ conversationId, ...skills }]);
```

`loadSkillsContext()` reads only:

- `<workspaceRoot>/skills/<name>/SKILL.md`
- `<builtinSkillsRoot>/<name>/SKILL.md`

There is no package default, home-directory fallback, environment-derived root,
or filesystem scan outside those two directories. A missing
`<workspaceRoot>/skills` means no workspace skills; a supplied builtin root must
exist. Workspace entries win over builtin entries with the same directory name,
before disabled-skill filtering, matching Python's `SkillsLoader` precedence.

The result contains:

- `skills`: snapshots for `ConversationContextSnapshot.skills`.
- `selectedSkills`: requested names that were discovered and enabled.
- `discovered`: name, provenance, optional workspace-relative `path`, content,
  parsed metadata, `always`, `disabled`, `available`, `enabled`, and requirement
  details.
- `summary`: Python-style progressive `name — description — path` lines.
  Unavailable skills are marked; disabled skills are omitted.

The existing context extension still decides inclusion: an enabled skill is
rendered only when frontmatter marks it `always` (top-level, `metadata.nanobot`,
or `metadata.openclaw`) or the host names it in `selectedSkills`. Disabled or
requirement-unavailable entries carry `enabled: false` and never render.
Frontmatter is stripped by the extension, not here.

## Requirements and execution

`metadata.nanobot.requires` (or `metadata.openclaw.requires`) supports `bins`
and `env`. Binaries are looked up on `PATH` with execute access; environment
variables are checked against the supplied `environment` map, which defaults to
a copy of `process.env`. Missing entries leave the skill discovered but
disabled.

A selected workspace skill's body is included in the prompt, so it is executable
with the existing `read`/`bash` tools; its `path` (`skills/<name>/SKILL.md`) and
its sibling references stay workspace-relative. Builtin skill bodies can be
selected and rendered, but their files live outside the workspace and are not
assumed readable by workspace tools.

## Bounds and file safety

Limits live in `SKILLS_CONTEXT_LIMITS`: 64 skills, 64 selected/disabled names,
128-code-unit names, 64 KiB per file, 1 MiB total across all roots, 16 KiB
frontmatter, and 4,096-character roots. All discovered skills are verified again
before return; any replacement or rename is a `changed` failure and no partial
result is returned.

Roots and directories are traversed through `/proc/self/fd` with
`O_DIRECTORY | O_NOFOLLOW`; files use `O_NOFOLLOW`, extra hard links
(`nlink != 1`) are rejected, UTF-8 decoding is fatal, and reads must be stable.
This is not a defence against a privileged/kernel adversary or coarse
filesystem metadata.

## Deliberate parity gaps

- Frontmatter parsing is a flat, bounded subset: top-level scalar keys plus a
  single-line JSON `metadata` object. YAML block mappings, anchors, tags,
  multi-line scalars, and YAML-flow (non-JSON) metadata are ignored. The shipped
  skills use the supported form.
- Skill names come from directory names, as in Python; frontmatter `name` is not
  authoritative. Directory names that are unsafe or exceed the context limit are
  skipped. Entries that are symlinks fail the load instead of being followed.
- `metadata.nanobot.os` gating and install hints are parsed but not acted on;
  only `requires.bins` and `requires.env` are evaluated.
- Unknown selected names are ignored, matching the loader's lookup behaviour.
  Disabled skills still shadow a builtin with the same name.
- The summary is returned for the host to place; this module does not inject a
  separate summary section, add a skill-loading tool, or claim that unselected
  bodies are available at runtime.
- Memory, Dream, history, compaction, and tool policy are unchanged.
