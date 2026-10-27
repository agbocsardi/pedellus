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

If `thinkingLevel` is omitted while selecting the same model, a still-supported
current level is preserved; otherwise the configured default is used when that
target supports it, falling back to `off`. If `thinkingLevel` is omitted while
changing models, thinking resets to the configured default when supported by the
target, otherwise `off` (including when no default is configured). An explicit
unsupported level is rejected
without changing the conversation. Choices and thinking levels survive Durable
reopen because they live in native `pi.agent`; transcripts, entries, request IDs,
and usage are not rewritten by selection.

Selection and the busy check share one native conversation transaction: it reads
`pi.live.run` and `pi.agent`, rejects with `ConversationBusy` when a run is
active, and only then applies the host security policy and selected model/thinking
level. There is no wait-then-configure race; the caller can retry once idle. A
prepared request keeps its checkpointed model/thinking level, as described
below.

## Startup policy and revocation

Before `Harness.resume()`, the host reapplies its trusted workspace `cwd` and
forces `tools: []` and `modelTools: []` on every persisted conversation. These
host-owned security fields are not user-selectable. A persisted model still in
the allowlist and a supported thinking choice are preserved; missing or invalid
thinking state is normalized to the configured default when supported, else
`off`. This includes the reserved root conversation: its initial agent policy is
create-only, so opening an existing root does not replace an allowed choice.

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
