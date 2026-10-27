# Provider/config parity slice

This is a bounded P3/P8 slice, not provider-parity acceptance. It uses the pinned
Pi AI `1.4.0` provider factories and their model catalogs. Only the selected
provider is registered; the requested model ID must exist in that pinned catalog.
This slice does not add model discovery, custom/dynamic endpoint configuration,
fallback chains, or legacy presets. No live provider, paid request, or real
credential was used to validate it.

## Credentials and selection

Configuration contains environment-variable **names**, never API keys:

```json
{
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "credentials": { "anthropic": "ANTHROPIC_API_KEY" }
}
```

Credential references (and `telegram.tokenEnv`) must match
`[A-Za-z_][A-Za-z0-9_]*`. The named variable must be set and nonblank when that
provider is selected. Credentials are not inferred from provider defaults.

The adapter exposes only that selected key through the native provider's
expected environment-variable name. Other process environment values are
unavailable to provider auth; Pi credential-file discovery is disabled, and
native API-key login and OAuth methods are removed. Adapter-generated
configuration/auth errors do not include credential values. OpenAI/Anthropic/
OpenRouter subscription OAuth, Codex OAuth, ambient credentials, and Pi
`auth.json` are not part of this slice.

## Supported native aliases

| Nanobot config alias | Pi provider ID | Pi API family | Endpoint in pinned Pi catalog | Credential reference |
|---|---|---|---|---|
| `anthropic` | `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `credentials.anthropic` → `ANTHROPIC_API_KEY` |
| `openai` | `openai` | `openai-responses` | `https://api.openai.com/v1` | `credentials.openai` → `OPENAI_API_KEY` |
| `openrouter` | `openrouter` | `openai-completions` or `anthropic-messages`, per model | `https://openrouter.ai/api/v1` | `credentials.openrouter` → `OPENROUTER_API_KEY` |
| `deepseek` | `deepseek` | `openai-completions` | `https://api.deepseek.com` | `credentials.deepseek` → `DEEPSEEK_API_KEY` |
| `moonshot` | `moonshotai` | `openai-completions` | `https://api.moonshot.ai/v1` | `credentials.moonshot` → `MOONSHOT_API_KEY` |
| `minimax_anthropic` | `minimax` | `anthropic-messages` | `https://api.minimax.io/anthropic` | `credentials.minimax_anthropic` → `MINIMAX_API_KEY` |
| `xiaomi_mimo` | `xiaomi` | `openai-completions` | `https://api.xiaomimimo.com/v1` | `credentials.xiaomi_mimo` → `XIAOMI_API_KEY` |
| `opencode_zen` | `opencode` | Anthropic Messages, Google Generative AI, OpenAI Completions, or OpenAI Responses, per model | `https://opencode.ai/inference` (Anthropic); `/inference/v1` (others) | `credentials.opencode_zen` → `OPENCODE_API_KEY` |
| `opencode_go` | `opencode-go` | Anthropic Messages, Google Generative AI, OpenAI Completions, or OpenAI Responses, per model | `https://opencode.ai/inference/go` (Anthropic); `/inference/go/v1` (others) | `credentials.opencode_go` → `OPENCODE_API_KEY` |

The OpenCode endpoint/API selection and model compatibility metadata come from
each model in Pi's pinned catalog, rather than a Nanobot-side protocol guess.

## Explicit gaps

| Retained Python provider | Status in this slice | Why it is not aliased |
|---|---|---|
| `custom` and dynamic provider names | Unsupported | No user-defined URL, API-family, headers, or model catalog configuration. |
| `openai_codex` | Unsupported | OAuth-only flow is outside the environment-reference credential contract. |
| `zhipu` | Unsupported | No matching first-party Pi adapter/catalog; it is not interchangeable with Z.AI. |
| `zai` | Unsupported | Nanobot's default is `https://api.z.ai/api/paas/v4`; Pi's pinned Z.AI catalog targets the distinct Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4`. This config has no endpoint override. |
| `dashscope` | Unsupported | Nanobot's DashScope endpoint differs from Pi's Qwen token-plan endpoints and auth contract. |
| `minimax` | Unsupported | Nanobot uses OpenAI Chat Completions and a `reasoning_split` quirk; Pi's native MiniMax adapter is Anthropic Messages at `/anthropic`. Only the separate `minimax_anthropic` alias is included. |
| `umans` | Unsupported | No first-party Pi 1.4.0 provider/catalog; a generic OpenAI-compatible endpoint would need explicit endpoint/model metadata and provider-specific behavior. |

The native Moonshot catalog is used as-is. Nanobot's temperature override for
`kimi-k2.5` and `kimi-k2.6` is not ported; `kimi-k2.5` is absent from the pinned
Pi catalog. Other older or dynamic model IDs can likewise be unknown. This is
not a claim of full model, thinking, vision, tool, pricing, fallback, or error
behavior parity. In particular, successful catalog lookup is not evidence of
provider service compatibility.

## Source basis

- Nanobot reference: `nanobot/providers/registry.py`,
  `nanobot/providers/factory.py`, `nanobot/providers/openai_compat_provider.py`,
  and `nanobot/config/schema.py`.
- Pinned Pi source: tag `v1.4.0` (`4a080252f06caf63a525d7873c5d94d3c23887e0`),
  `packages/ai/src/providers/{anthropic,deepseek,minimax,moonshotai,openai,openrouter,opencode,opencode-go,xiaomi}.ts`
  and their provider model catalogs. These provider factories supply the API
  implementations, native model metadata, endpoints, and auth variable names.
- Installed Pi 1.4.0 docs: `docs/providers.md`, `docs/models.md`,
  `docs/models-configuration.md`, and `docs/custom-provider.md`. These distinguish
  compatible API endpoints from custom-provider/OAuth extensions and describe
  endpoint/API-family compatibility settings.
