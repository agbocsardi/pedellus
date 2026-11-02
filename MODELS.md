# Model presets and selection

Named presets are the config-first model surface; direct model/allowlist configs
remain supported. Both use the pinned Pi AI 1.5.0 registry and Durable's native
`pi.agent` state. There is no second selection store, automatic model discovery,
catalog refresh or fallback chain.

## Configuration

For legacy direct configs, `model` is the default and `allowedModels` permits
additional choices. For named configs, use [presets](#named-presets) instead:

```json
{
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "allowedModels": [
    { "provider": "openai", "modelId": "gpt-6-sol" },
    { "provider": "openai", "modelId": "gpt-6-luna" }
  ],
  "thinkingLevel": "high"
}
```

Each provider spelling is a native Pi AI provider ID, a documented legacy alias
from [PROVIDERS.md](./PROVIDERS.md), or a key in the config's custom `providers`
block. The default must appear in `allowedModels`; entries must be unique and each
provider/model pair must exist in the registered native/custom catalog. If
`allowedModels` is omitted, the legacy `model` becomes a singleton allowlist,
preserving single-model config files. Empty lists, duplicate entries, and a
default outside the allowlist fail config parsing.

Chat selection authority stays with `allowedModels`/`modelPresets`. Registering a
provider for authentication, custom-endpoint use or classifier access does not
make any of its chat models selectable. At startup, each provider named by the
chat allowlist must have usable native auth; this check reads a stored credential
or resolves its configured/native API-key environment without refreshing OAuth or
making a network request. An explicit `credentials.<provider>` reference pins its
one environment variable and fails closed when that variable is unset or blank; it
never falls back to the provider's ambient variables. See
[credentials and login](./PROVIDERS.md#credentials).

Classifiers are outside this allowlist and never appear in `/model`. Exactly one
optional `classifierModel` `{ provider, modelId }` pair is reachable, only through
native Code Mode `models.*` in an authenticated mapped chat or a captured ordinary
worker; absent, classifiers are unavailable. See
[classifiers](./CODEMODE.md#classifiers-and-image-generation). Image generation
is not installed.

`thinkingLevel` is optional and applies as the default only where the model
supports it. The runtime checks it against Pi AI's `getSupportedThinkingLevels`
for the default model before opening storage; unsupported values fail startup.
Every allowlisted model exposes exactly the native supported levels in the
Gateway listing. `off` is always supported; `max` is accepted only for models
whose native metadata includes it.

### Named presets

`modelPresets` defines the provider, model and optional thinking level once, and
`modelPreset` selects the configured default by name:

```json
{
  "modelPresets": {
    "fast": { "provider": "opencode_go", "modelId": "deepseek-v4.1-flash", "thinkingLevel": "off" },
    "deep": { "provider": "opencode_go", "modelId": "deepseek-v4.1-flash", "thinkingLevel": "high" }
  },
  "modelPreset": "fast",
  "episodeSummary": { "preset": "deep" }
}
```

Named mode requires both keys and is an alternative to the direct `model`,
`allowedModels` and top-level `thinkingLevel` fields; supplying any of those
together with `modelPresets`/`modelPreset` fails config parsing. Each preset must
have `provider` and `modelId`, may add only `thinkingLevel`, and rejects every
other field: this slice has no temperature, output or context budgets, fallback
chains, inheritance, provider auto-detection, tool policy or run-role knobs.
Preset names are exact, whitespace-free and may not be `default`, which is
reserved for returning to the configured selection.

The catalog is normalized into the same native provider/model choices as the
direct surface: the configured preset supplies `model`, and the deduped set of
provider/model pairs supplies the internal allowlist. Users do not repeat the
catalog in `allowedModels`. Two presets that differ only by thinking level share
one allowed model pair, which is explicitly valid; a preset without
`thinkingLevel` selects `off` for conversation selection. A summary preset without
that field leaves the provider's native reasoning default unchanged. Startup
validates every name, reference, native
model and thinking level against the pinned catalog before storage opens.

`episodeSummary.preset` references the same catalog and is mutually exclusive
with the legacy `episodeSummary.model`. The named preset's provider, model and
thinking level are passed to real summary jobs, not stored as display metadata;
unknown references fail startup instead of falling back to another preset.
Without a configured summary override, summaries keep using the conversation's
current model, and `enabled: false` still disables them. Direct
`episodeSummary.model` continues to work in direct configs.

Only providers referenced by the allowlist (or the preset catalog derived from
it), `credentials`, or a custom `providers` entry are registered; preset mode
derives its provider list from the catalog and uses the same explicit credential
references as direct mode.

### Vision handoff

A text-only preset must be marked explicitly; images are never silently dropped
and the main model is never switched:

```json
{
  "modelPresets": {
    "chat": { "provider": "opencode_go", "modelId": "deepseek-v4.1-flash", "needsVisionHandoff": true },
    "eyes": { "provider": "opencode_go", "modelId": "<small vision-capable model>" }
  },
  "modelPreset": "chat",
  "visionHandoff": { "describerPreset": "eyes", "maxRawImages": 9, "maxDescriptionTokens": 1024 }
}
```

`visionHandoff` present enables the handoff. `describerPreset` must name a
catalog preset whose model accepts image input and is not itself flagged; the
runtime checks the pinned catalog before storage opens. A flagged preset with no
`visionHandoff`, an unknown or non-vision describer, and a describer that also
needs handoff all fail startup with a configuration/model diagnostic instead of
falling back to raw images. Presets that share one provider/model pair must
agree on `needsVisionHandoff`, so the per-preset flag never collapses into
ambiguous pair-only matching. `maxRawImages` defaults to 9 (0-64) and
`maxDescriptionTokens` to 1024 (1-8192).

On every `pi.generation` request — ordinary chat, mapped channels and scheduled
background runs alike — `pi.generation`'s native `beforeRequest` hook transforms
only the copy sent to the provider:

- A flagged text-only target keeps **zero** raw images. Every image is replaced
  by a describer preset's text description.
- A vision-capable target keeps the newest `maxRawImages` raw images; older ones
  become descriptions.
- An unresolved target fails closed to zero raw images.
- The persisted transcript, entries and prepared task checkpoints are never
  rewritten. Descriptions are derived, quoted evidence: each replacement says the
  image was not sent raw and that the description is untrusted image evidence,
  not instructions. Adjacent user text (including a channel's relative file
  locator) is retained. For a `read` tool result, the transcript's own tool-call
  `path` argument is quoted as an untrusted source label.
- A describer failure, oversized image or per-request description budget
  produces an explicit "description unavailable / omitted" text. Such a failure
  is not cached and never claims the target saw the image.
- Cancellation is per request. Identical in-flight images share one
  service-owned describer call, but one caller aborting does not reject another
  live caller's transform or cancel the shared call while that caller still
  waits. A real cancellation of the requesting turn still rejects and sends
  nothing.
- Durable treats a thrown generation hook as `extension_error` and would then
  send the original request. The hook therefore catches non-cancellation helper
  errors: a flagged or unresolved target is replaced with explicit unavailable
  text and zero raw images, never the untransformed request. A capable target
  keeps its intended raw images.

Descriptions are cached by image content for the process lifetime (256 entries,
LRU) with single-flight for identical in-flight images and at most four
concurrent describer requests. The cache key is MIME type plus image bytes; this
is safe because one gateway instance has one fixed describer preset, prompt and
token budget, and a configuration change creates a new cache rather than sharing
descriptions across different describer settings. One request describes at most 32 older images;
older ones are explicitly omitted rather than causing unbounded calls. One image
above 16 MiB of base64 payload is not sent to the describer, and the described
images in one request share a 64 MiB base64 budget; older images past it are
explicitly omitted. Describer output is
bounded by `maxDescriptionTokens` and a 32,000-character safety cap. The
`prompt` override is optional and bounded to 4,000 characters.

Describer calls go through the same configured `Models` collection and captured
provider credentials as the main request, but they are auxiliary: they can spend
tokens that the main model request does not show. `Gateway.visionHandoffStats()`
returns the configured describer and process-lifetime counters (requests, raw,
described and unavailable images, describer calls/failures, cache hits and
reported input/output tokens). It is accounting, not a budget enforcer; the
provider's own budget guard still applies to calls it controls.

A prepared generation `request` keeps its checkpointed model even when startup
resets conversation state to the configured preset in named-preset mode; startup
records that task's model and the hook prefers it for the one saved dispatch.
The pin is consumed on use, so a later retry of the same generation task
re-prepares from the reset `pi.agent` selection and applies that model's image
policy. A deferred `poll` resumes the already-sent request and runs no
`beforeRequest` hook.

Durable compaction serializes only text and drops image blocks, so it does not
send raw images to a text-only summarizer. The real limitation is loss: handoff
descriptions are request-only, and the compacted summary prefix therefore omits
the image evidence. After compaction a long image-heavy conversation may retain
only the original file/locator text as its source evidence, not the visual
description. This slice adds no compaction engine or summary rewriting.

This slice is offline-tested with faux models and a temporary store; no live
provider, Telegram media adapter, PDF/OCR/Office extraction or audio path is
included. Documents are saved as files for later explicit reading; no automatic
extraction is performed.

## Gateway API

`Gateway.listModels(sessionKey: string, context: Context):
Promise<GatewayModelList>` returns `models: readonly GatewayModelChoice[]` and
`selected: GatewayModelSelection`. A choice has `{ provider, modelId, name,
thinkingLevels }`; a selection has `{ provider, modelId, thinkingLevel }`.
`Gateway.selectModel(sessionKey: string, selection:
GatewayModelSelectionRequest, context: Context):
Promise<GatewayModelSelection>` accepts `{ provider, modelId, thinkingLevel? }`.
The `provider` field is always the exact config alias (for example,
`opencode_zen`), both in results and requests. Durable stores the corresponding
native Pi provider ID in `pi.agent`. Provider and model ID are compared as a
pair; no `provider/model` string parsing is used. Neither method creates a
session; call `conversationFor()` first. Unknown keys and disallowed models are
rejected.

In named-preset mode the same listing adds `presets: readonly GatewayModelPreset[]`
(`{ name, provider, modelId, thinkingLevel? }`) and `defaultPreset`, and
`Gateway.selectModelPreset(sessionKey, name, context)` selects a preset.
`default` selects the configured preset, and a preset without `thinkingLevel`
selects `off`, so two names over one model pair stay distinguishable. Preset
selection reuses the same busy-checked native transaction and persists only in
`pi.agent`; it adds no second selection store. It never changes tools or
authority. The local CLI is the only shipped temporary-switch UI in this slice:
Telegram runs on the configured default preset and has no `/model` command.

If `thinkingLevel` is omitted while selecting the same model, a still-supported
current level is preserved; otherwise the configured default is used when that
target supports it, falling back to `off`. If `thinkingLevel` is omitted while
changing models, thinking resets to the configured default when supported by the
target, otherwise `off` (including when no default is configured). An explicit
unsupported level is rejected
without changing the conversation. Choices and thinking levels survive Durable
reopen because they live in native `pi.agent`; transcripts, entries, request IDs,
and usage are not rewritten by selection. This omitted-level behavior is the
legacy direct `selectModel` contract and remains available to SDK hosts; in
named-preset mode such a host can hold a selection that matches no preset,
because preset selection itself always supplies a concrete thinking level.

Selection and the busy check share one native conversation transaction: it reads
`pi.live.run` and `pi.agent`, rejects with `ConversationBusy` when a run is
active, and only then applies the host security policy and selected model/thinking
level. There is no wait-then-configure race; the caller can retry once idle. A
prepared request keeps its checkpointed model/thinking level, as described
below.

## Startup policy and revocation

Before `Harness.resume()`, the host uses the workspace's canonical `realpath`
for `cwd`, forces `tools: []` and `modelTools: []`, and reapplies policy to every
persisted conversation. These host-owned fields are not user-selectable. A
persisted allowed model and supported thinking choice are preserved; missing or
invalid thinking state is normalized to the configured default when supported,
else `off`. This includes the root conversation: its initial agent policy is
create-only, so opening an existing root does not replace an allowed choice.

In named-preset mode this same pre-resume pass instead replaces a persisted
conversation selection with the configured default preset and its thinking level
(or `off`). A temporary `/model <name>` switch therefore does not survive a
restart or a configuration reload; changing `modelPreset` and reopening selects
the new configured default. Direct-mode conversations keep the preserve-allowed
behavior described above. Neither path rewrites entries, usage, request IDs or
checkpointed task dispatches: already prepared requests keep their original
allowed model and thinking level, and the removed-model guard below still fails
closed.

Before applying policy, startup scans active native Durable task checkpoints. If
a prepared generation `request`/`poll` or compaction `summarize`/`retry` refers
to a model removed from the allowlist, startup fails closed before
`Harness.resume()`. Model identity is checked as the native provider/model pair,
so another model from the same provider does not authorize replay. The guard does
not rewrite checkpoints or transcripts or cancel tasks. Before the guard,
`Harness.open()` may perform its normal recovery of interrupted running tasks to
pending and increment restart counts. Restore the prior allowlist and let the task
finish before revoking that model. Generation `prepare`/`retry` and
compaction `select` checkpoints have not selected a request model; they resume
using the normalized current `pi.agent` choice.

This guard follows Durable 1.5.0's public task records and dispatch paths:
`generation.ts` resolves the checkpoint model before streaming or polling, while
`compaction.ts` resolves it before summarization. The scan covers those model
dispatches only. A Code Mode classifier call is a nested tool task, not a chat
dispatch: the native classifier registration has no `replay: "safe"` opt-in, so an
interrupted nested call is never rerun after restart, and a fresh call passes the
current call-time classifier authority again. `tool.ts` resolves every tool from
the current agent's `tools`/`callable` lists, which startup clears before resume.
The model catalog supplied by an SDK host is not mutated. Offline SIGKILL/reopen sentinels
left prepared alpha generation and compaction requests, then reopened with only
same-provider beta allowed; both startups failed before a second provider call.
Each sentinel recorded the original faux-provider dispatch. If that original call
began before the process was killed, the adapter cannot know whether it was
processed or paid; the guard proves only that reopen does not replay it under the
revoked policy.

When no live prepared task targets a revoked model, a removed persisted
`pi.agent` selection is deterministically replaced by the configured default and
its thinking level (or `off`). This occurs before resume and again on session
acquisition. Transcript and requestId identity remain intact.

## Source basis

- Nanobot's read-only reference: `nanobot/config/schema.py`
  (`ModelPresetConfig`/`AgentDefaults`), `nanobot/agent/model_presets.py`, and
  `nanobot/command/builtin.py` (`cmd_model`). This port intentionally uses a
  per-conversation native choice rather than the Python process-loop preset.
- Pinned Durable 1.5.0: `packages/durable/README.md` (Per-Conversation Agent,
  Busy Conversations), public task/`scanTasks` records, and
  `packages/durable/src/harness/{generation,compaction,tool}.ts` (checkpointed
  model dispatch and tool resolution).
- Pinned Pi AI 1.5.0: `packages/ai/src/models.ts`
  (`getSupportedThinkingLevels`, `checkAuth`, native provider registry), provider
  `ApiKeyAuth.resolve`, and installed `docs/models.md`,
  `docs/models-configuration.md`, and `docs/providers.md`.
