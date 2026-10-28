# Explicit-root skills discovery and selection

`src/context/skills.ts` is a bounded, opt-in loader that turns Markdown skill
files into the existing `ContextSkillSnapshot` shape. Markdown remains
authoritative; this module stores no runtime state, installs nothing, and never
executes a skill. It reads only the two roots the host names.

## API

```ts
import { loadSkillsContext } from "./context/skills.js";
import { createContextExtension } from "./context/index.js";

const skills = await loadSkillsContext({
  workspaceRoot: "/srv/workspace",
  builtinSkillsRoot: "/srv/nanobot/skills", // optional, explicit
  disabledSkills: ["clawhub"],
  selectedSkills: ["project-guide"],
  environment: { PATH: process.env.PATH }, // optional; defaults to process.env
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
  parsed metadata, `metadataStatus`, `always`, `disabled`, `available`,
  `enabled`, and requirement details.
- `skipped`: directory entries refused before their body was read, with a stable
  reason (`unsafe-name`, `name-too-long`, `symlinked-skill`, `symlinked-file`).
  A refused skill is therefore visible to the host instead of silently absent.
- `summary`: Python-style progressive `name — description — path` lines.
  Unavailable skills are marked with their missing gates or unsupported
  metadata; disabled skills are omitted.

The existing context extension still decides inclusion: an enabled skill is
rendered only when frontmatter marks it `always` (top-level, `metadata.nanobot`,
or `metadata.openclaw`) or the host names it in `selectedSkills`. Disabled or
requirement-unavailable entries carry `enabled: false` and never render.
Frontmatter is stripped by the extension, not here.

## Host wiring

`workspaceContextGatewayOptions()` wires this loader into `openGateway` only when
the config contains an explicit section (see
[`WORKSPACE_CONTEXT.md`](./WORKSPACE_CONTEXT.md)):

```json
{
  "workspace": "./workspace",
  "workspaceContext": {
    "memoryFiles": [],
    "skills": {
      "builtinSkillsRoot": "/opt/nanobot/skills",
      "disabledSkills": ["clawhub"],
      "selectedSkills": ["project-guide"]
    }
  }
}
```

- Absent `skills` means no skill discovery at all. There is no default builtin
  root and no ambient read.
- Each conversation receives its own detached snapshot: the loaders run once per
  session key on open/create, an existing conversation keeps the snapshot
  captured for it, and reopening the gateway reconstructs every mapped session
  before `harness.resume()` (the same lifecycle as bootstrap/memory context, so
  the prepared-context recovery guard applies unchanged).
- A loader failure rejects that conversation's setup and installs no partial
  context; a retry re-runs the loader.
- Requirement gates are evaluated against an explicit environment map. The host
  passes only `PATH`, because the guarded shell exports that same `PATH` and
  inherits no other host variable. A `requires.env` entry therefore stays unmet
  instead of being satisfied by a host-only value that the tools never see.
- Discovery and prompt inclusion are not execution. The model sees a selected
  skill body and decides what to do with the already-granted `read`/`bash`
  tools; nothing in this module runs a skill, its scripts, or its references.

## Requirements and metadata honesty

`metadata.nanobot.requires` (or `metadata.openclaw.requires`) supports `bins`
and `env`. Binaries are looked up on `PATH` and must be regular executable files;
a directory with execute bits is not a program (Python's `shutil.which` also
rejects directories). Environment variables are checked against the supplied
`environment` map. Missing entries leave the skill discovered but disabled.

The frontmatter parser is a flat, bounded subset of YAML, so a gate can be
unreadable. Rather than dropping it silently, the result reports it and the
skill fails closed (`enabled: false`, excluded from `selectedSkills`):

| Situation | `metadataStatus` / `requirements` |
| --- | --- |
| No `metadata` key | `absent`; requirements `none` |
| Single-line JSON `metadata` object | `parsed`; requirements `evaluated` when a list is declared, else `none` |
| `metadata:` with an indented block mapping | `unsupported` (`metadata-block-form`); requirements `unsupported` |
| Metadata value over 8 KiB, or a JSON array/scalar | `unsupported` (`metadata-oversized`, `metadata-not-object`, `metadata-unparseable`) |
| Frontmatter unterminated, or over 16 KiB | `unsupported` (`frontmatter-unterminated`, `frontmatter-oversized`) |
| `requires` not an object, `bins`/`env` not a list, or a list entry that is not a bounded string | requirements `unsupported` (`requires-not-object`, `requires-bins-not-list`, `requires-env-not-list`, `requires-…-entry-unsupported`) |

A `requires` list that is partly readable keeps the readable names for the
report, but the skill remains unavailable because the declared gate set is
incomplete. `metadata: null` carries no gates and is treated as parsed, matching
YAML `null` → Python's empty payload.

## Bounds and file safety

Limits live in `SKILLS_CONTEXT_LIMITS`: 64 actual `SKILL.md` records (candidate
directories without one do not count), 64 selected/disabled names, 128-code-unit
names, 64 KiB per file, 1 MiB total across all roots, 16 KiB frontmatter, 8 KiB
metadata value, 256-character requirement entries, 64 skipped-entry reports, and
4,096-character roots. Discovery fails closed on unreadable files, invalid UTF-8,
or a bound violation; no partial result is returned.

Scope is accidental damage, not adversarial confinement. Reads use normal
filesystem calls with size and aggregate bounds, and frontmatter parsing is
bounded. Symlinked skill directories and symlinked `SKILL.md` files are refused
and reported rather than followed; explicit roots are used as supplied. There is
no `/proc/self/fd` pinning, hard-link rejection, or post-read race verification.

Rendered bodies share the existing context renderer bounds (16,000 code points
per section, 48,000 per conversation). A selected body larger than the section
bound is clipped by the renderer with its visible
`[context truncated at configured bounds]` marker rather than by this loader;
keep selected skill files well below the section bound.

## Deliberate parity gaps

- Frontmatter parsing is a flat, bounded subset: top-level scalar keys plus a
  single-line JSON `metadata` object. YAML block mappings, anchors, tags,
  multi-line scalars, and YAML-flow (non-JSON) metadata are unsupported and are
  reported as above when they carry `metadata`. Non-gate keys are read only as
  flat `key: value` lines. Python's `yaml.safe_load` rejects the shipped
  `update-setup` description line (it contains `: `), so Python falls back to the
  directory name; this parser keeps the text as the description. That is a
  documented difference, not parity.
- Skill names come from directory names, as in Python; frontmatter `name` is not
  authoritative. Directory names that are unsafe or exceed the context limit are
  reported in `skipped`. Directory entries that are symlinks or not directories
  are reported and skipped, as are symlinked `SKILL.md` files.
- `metadata.nanobot.os` gating and install hints are parsed but not acted on;
  only `requires.bins` and `requires.env` are evaluated.
- Python silently ignores an unparseable `metadata` value; this loader fails
  that skill closed instead, so a broken gate cannot look satisfied.
- Unknown selected names are ignored, matching the loader's lookup behaviour.
  Disabled skills still shadow a builtin with the same name.
- The summary is returned for the host to place; this module does not inject a
  separate summary section, add a skill-loading tool, or claim that unselected
  bodies are available at runtime. Progressive loading (summary first, then read
  the file) is reliable only for workspace skills whose files are reachable; a
  builtin skill must be selected or marked `always` to load its body, and its
  sibling reference files stay outside the workspace.
- Memory, Dream, history, compaction, and tool policy are unchanged.
