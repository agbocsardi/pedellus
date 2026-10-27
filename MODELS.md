# Model allowlist and persisted selection

This is the bounded P3 model-selection slice, not Python preset parity. The
runtime accepts only a finite allowlist, uses the pinned Pi AI 1.4.0 model
catalog, and stores each conversation's choice in Durable's native `pi.agent`
document. No second selection store, model discovery, catalog refresh, fallback
chain, or CLI `/model` command is added.

## Configuration

`model` remains the default selection. Add `allowedModels` to permit additional
choices:

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

Each provider spelling is one of the aliases in [PROVIDERS.md](./PROVIDERS.md).
The default must appear in `allowedModels`; entries must be unique and each
provider/model pair must exist in its pinned native catalog. If `allowedModels`
is omitted, the legacy `model` becomes a singleton allowlist, preserving
single-model config files. Empty lists, duplicate entries, and a default outside
the allowlist fail config parsing.

`thinkingLevel` is optional and applies as the default only where the model
supports it. The runtime checks it against Pi AI's `getSupportedThinkingLevels`
for the default model before opening storage; unsupported values fail startup.
Every allowlisted model exposes exactly the native supported levels in the
Gateway listing. `off` is always supported; `max` is accepted only for models
whose native metadata includes it.

Only providers referenced by the allowlist are registered. For normal config,
each referenced alias must have its own explicit credential reference and a
nonblank value before startup. The adapter does not discover credentials from
other environment variables, auth files, OAuth, or catalog refresh. An SDK host
may inject a `Models` instance to use synthetic/offline providers; configured
model IDs are resolved against that instance without auth checks or network
requests. Authentication behavior of an injected provider remains the host's
responsibility.

## Gateway API

`Gateway.listModels(sessionKey, context)` returns the allowlisted models and the
persisted selection for an existing session key. `Gateway.selectModel(sessionKey,
{ provider, modelId, thinkingLevel? }, context)` validates against that same
allowlist and atomically updates native Durable agent configuration. Provider
names use the config alias shown in `listModels`. Neither method creates a
session; call `conversationFor()` first. Unknown keys and disallowed models are
rejected.

If `thinkingLevel` is omitted, the current level is preserved when supported by
the target model. Otherwise the configured default is used when that target
supports it, falling back to `off`. An explicit unsupported level is rejected
without changing the conversation. Choices and thinking levels survive Durable
reopen because they live in native `pi.agent`; transcripts, entries, request IDs,
and usage are not rewritten by selection.

Durable fixes a prepared request's model and thinking level. A model change while
a run is busy is committed normally and takes effect at the next native request
preparation; it does not cancel or mutate the in-flight request. The selection
API relies on that native boundary.

## Startup policy and revocation

Before `Harness.resume()`, the host reapplies its trusted workspace `cwd` and
forces `tools: []` and `modelTools: []` on every persisted conversation. These
host-owned security fields are not user-selectable. A persisted model still in
the allowlist and a supported thinking choice are preserved; missing or invalid
thinking state is normalized to the configured default when supported, else
`off`.

A persisted `pi.agent` model no longer present in the current allowlist is
deterministically replaced with the configured default model and its configured
default thinking level (or `off` if not configured). This happens before
`Harness.resume()` and again when a session is acquired. The transcript and
requestId identity are left intact. This revocation policy intentionally does
not preserve a choice that the host has removed from the allowlist.

Durable separately checkpoints the model and thinking level of an already
prepared generation request. Reopen resumes that exact native request; this
adapter does not rewrite or cancel an in-flight checkpoint when the allowlist
changes. The newly configured default applies at the next native request
preparation. This follows Durable's fixed-request boundary and is not an
assertion that a prepared external request can be revoked.

## Source basis

- Nanobot's read-only reference: `nanobot/config/schema.py`
  (`ModelPresetConfig`/`AgentDefaults`), `nanobot/agent/model_presets.py`, and
  `nanobot/command/builtin.py` (`cmd_model`). This port intentionally uses a
  per-conversation native choice rather than the Python process-loop preset.
- Pinned Durable 1.4.0: `packages/durable/README.md` (Per-Conversation Agent,
  Busy Conversations) and `packages/durable/src/harness/generation.ts` (request
  preparation checkpoints model and thinking).
- Pinned Pi AI 1.4.0: `packages/ai/src/models.ts`
  (`getSupportedThinkingLevels`), provider `ApiKeyAuth.resolve`, and installed
  `docs/models.md`, `docs/models-configuration.md`, and `docs/providers.md`.
