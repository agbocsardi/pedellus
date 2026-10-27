# Opt-in context composition

`src/context/index.ts` is a bounded, opt-in Durable extension for composing context
from **host-supplied snapshots**. It does not access the filesystem, environment,
credential store, coding-agent resource loader, or extension discovery. Nothing in
this slice installs or selects the extension in the gateway.

## API and scope

Import `createContextExtension()` directly from `src/context/index.ts`. Give it a
bounded array of snapshots keyed by their Durable `conversationId`:

```ts
const context = createContextExtension([{
  conversationId: conversation.id,
  identity: { source: "builtin:identity", content: renderedIdentity },
  agents: { source: "workspace:AGENTS.md", content: agentsText },
  soul: { source: "workspace:SOUL.md", content: soulText },
  user: { source: "workspace:USER.md", content: userText },
  memory: [{ source: "memory/system/preferences.md", content: memoryText }],
  skills: [{
    name: "project-guide",
    source: "workspace:skills/project-guide/SKILL.md",
    enabled: true, // host has applied disabled-skill and availability policy
    metadata: { description: "Project-specific instructions", always: true },
    content: skillMarkdown,
  }],
  selectedSkills: [],
}]);
```

The host must install/select the returned extension explicitly. It copies and
pre-renders snapshot values when constructed; later mutations to caller objects do
not change prompt content. Recreate/reinstall it when host-owned snapshots or
selected skills change. A snapshot with no matching conversation ID contributes no
identity, document, memory, or skill content. There is no fallback to another
conversation, a parent/fork, or a default workspace. A host must associate each
snapshot with the correct Durable conversation; this API cannot detect incorrect
host mapping. Durable conversation IDs are only unique within one storage/Harness;
independent Harnesses can both have root ID `1`. Construct a fresh context extension
**and dedicated registry per Harness/storage**. Never share either across stores:
`PromptInput` has no trustworthy store namespace, so this module cannot distinguish
colliding IDs. This is a required host precondition, not runtime-detected. Use
relative/opaque provenance labels rather than disclosing unnecessary absolute host
paths.

## Restart and fork lifecycle

The Durable agent document persists the selected extension name, not this
extension's captured snapshots. Before reopening/resuming a storage or accepting
new work, the host must create a fresh dedicated registry and same-named context
extension for that Harness, reconstructing snapshots from that same store's
conversation IDs. Install it before resume for each conversation whose context
should remain available; never reuse a registry/extension from another store. A
missing snapshot intentionally renders no context for that conversation on its next
request; native Durable section replay then removes those keys from the effective
current prompt. Reinstalling a changed same-name extension updates current sections
on the next request, while unchanged snapshots require no section patch.

Forks inherit the parent's transcript, including historical `pi.system` context
entries, through the fork point. A fork has a new `conversationId`, so it receives
no captured context unless the host supplies a snapshot for that ID. Before its
first request it can still have the inherited effective prompt; when it first
renders without a snapshot, Durable clears those keys from the *current prompt*.
This is not transcript erasure: old system entries remain in stored history (and
may remain visible through a fork's inherited history). The host owns snapshot
mapping and any decision to copy context to a fork; clearing a section must not be
treated as securely deleting prior context or secrets.

Fixed Durable section keys/order are `nanobot_identity`, `nanobot_instructions`,
`nanobot_memory`, `nanobot_skills`, and `nanobot_tools`. Native sections keep
unchanged content stable for prompt-cache reuse; no timestamps or session data are
added. The tools section is rendered from the current `PromptInput.agent.tools`
(model-facing declarations), says when none are exposed, and explicitly does not
enable tools. Tools callable only by other tools are not listed. No legacy Python
tool names are copied into the prompt.

## Bounds and skill rules

The exported `CONTEXT_LIMITS` documents hard bounds: 256 conversation snapshots;
**per conversation**, 48,000 Unicode code points for context section values,
16,000 per context section, and 2,000 for tool visibility; 32 memory sources; 64
inspected skill records / 32 included skills; 64 selected-skill names of at most
128 UTF-16 code units each; 128 listed tool names; 256 code points per provenance
label; and 1,024 per skill description. A selected-skill name over 128 code units
is ignored before set insertion; skill record names use the same limit. Truncation
is marked, and slicing preserves Unicode code points. The 50,000-code-point
section-value bound (48,000 context + 2,000 tool visibility) is also **per
conversation**, not an aggregate across the 256 snapshots. The snapshot-count cap
limits fan-out; aggregate retained strings across all snapshots can be larger.

A skill must have `enabled: true` from the host to appear; absent, false, or
non-boolean values are disabled. The host is responsible for applying Nanobot's
disabled-skill configuration and requirement checks (Python checks binaries and
environment variables). For enabled skills, `always: true` in parsed frontmatter,
`metadata.nanobot.always`, or `metadata.openclaw.always` includes full content on
every prompt. Otherwise the host must name the skill in `selectedSkills` to include
its body. Disabled/unselected skills are not listed, and this extension offers no
skill-loading tool or claim that omitted skill bodies are available at runtime.
Only own data properties are read from metadata; inherited/accessor `always` or
enabled values cannot grant a skill. Skill frontmatter is stripped from included
Markdown using a bounded delimiter check; YAML is not parsed here.

## Python semantic reference and deliberate gaps

This is a context-composition slice, **not P3/P4 completion or full Python parity**.
The source-backed mapping is:

- Python `ContextBuilder` combines the rendered identity template, workspace
  `AGENTS.md`/`SOUL.md`/`USER.md`, memory, always-skill bodies, skill summaries,
  archived summaries, runtime annotations, and a tool contract. This extension
  accepts already-rendered identity text and explicit bootstrap/memory/skill
  snapshots only. It does not implement Jinja template variables, Python's
  `platform_policy.md`, tool-contract template, runtime/user-message metadata, or
  archived conversation summaries.
- `SkillsLoader` gives workspace skills precedence over built-ins, filters
  configured-disabled and requirement-unavailable entries, supports top-level or
  Nanobot/OpenClaw `always`, strips frontmatter from loaded bodies, and builds a
  progressive description/path summary. Here the host supplies provenance,
  already-decided `enabled`, parsed metadata, and body; no roots are scanned,
  requirements checked, paths loaded, or progressive loading advertised. Duplicate
  skill names in one supplied snapshot are rejected.
- `MemoryStore.get_memory_context()` loads system memory and non-template legacy
  `MEMORY.md` material with paragraph deduplication; `get_memory_tree_context()`
  indexes topic files. This extension only inserts memory snapshots explicitly
  supplied by the host. It does not discover/deduplicate topics, rank or retrieve
  them, build a memory tree, access `history.jsonl`, filter archived context by
  session/Dream cursor, or implement memory writes, archive/usage deltas, or Dream.
  Those semantics remain P4 work.
- Python's manifest retrieval mode, recent history injection, and subagent-specific
  prompt construction are also not ported. Durable compaction is not memory archive
  or Dream and is not changed here.

The pinned Pi `DefaultResourceLoader` / `loadSkills*` helpers discover and read
ambient resource paths, which this trust boundary forbids. The public
`formatSkillsForPrompt()` helper advertises a skill file path and a file-reading
tool, but this extension neither loads files nor assumes such a tool exists; it is
therefore not a compatible renderer for these snapshots. This slice instead uses
Durable's public `defineExtension()` and `section()` composition APIs, with no new
dependency. The Pi coding-agent prompt-template parser is unrelated to Nanobot's
identity/template conversion and is not used.

For provenance, semantic references are `nanobot/agent/context.py`,
`nanobot/agent/skills.py`, `nanobot/agent/memory.py`,
`nanobot/templates/agent/{identity,platform_policy,skills_section,tool_contract}.md`,
`nanobot/templates/{AGENTS,SOUL,USER}.md`, and
`nanobot/templates/memory/MEMORY.md`. The conversion decision is deliberate:

- the host must render identity values and choose trustworthy sources;
- this extension only composes supplied strings and never decides whether a file
  or skill is trusted;
- host-mapped snapshots in a dedicated per-Harness registry replace automatic
  ambient reads for this slice;
- search/ranking, archived history, memory-tree discovery, and Dream are explicitly
  deferred rather than implied by context inclusion.
