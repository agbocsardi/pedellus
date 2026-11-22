# Providers, auth, models and classifiers

This slice exposes the pinned Pi AI `1.5.0` provider registry and its native auth,
model and API facilities. There is no application-side provider whitelist: a
configured provider spelling is a native Pi AI provider ID, one documented legacy
alias, or an explicit custom provider entry. The model allowlist remains the
authority for chat selection; registering a provider does not select or dispatch
its models.

No live provider, paid request, browser login, Telegram call or real credential
was used to validate this slice. It is offline-tested with synthetic credentials,
temporary stores, faux models and synthetic classifiers.

## Provider identity

The gateway registers only providers referenced by `allowedModels`, named
`modelPresets` (which derive `allowedModels`), `credentials`, or `providers`.
Native provider factories and catalogs come directly from
`@earendil-works/pi-ai@1.5.0`; there is no second hand-maintained provider list,
model discovery, fallback chain or automatic substitution. The explicit
`durable-nanobot models refresh` command can overlay newer native model metadata
from pi.dev ([catalog updates](./MODELS.md#catalog-updates)); it grants nothing.

Existing configuration keeps working through these explicit legacy spellings.
They are compatibility aliases, not a provider whitelist:

| Existing spelling | Native provider ID |
|---|---|
| `minimax_anthropic` | `minimax` |
| `moonshot` | `moonshotai` |
| `opencode_zen` | `opencode` |
| `opencode_go` | `opencode-go` |
| `xiaomi_mimo` | `xiaomi` |

Every other spelling must be a native provider ID from the pinned Pi AI registry
or a key in the config's `providers` block. Unknown spellings fail startup. The
default seed remains unchanged: `opencode_go` / `deepseek-v4.1-flash` at thinking
level `high`, with `credentials.opencode_go` naming its environment variable.

A custom provider key cannot redefine a native provider ID or a legacy alias.

## Credentials

`credentials` maps a configured provider spelling to an environment-variable
**name**. Configuration never contains a secret value:

```json
{
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "credentials": { "openai": "OPENAI_API_KEY" }
}
```

The referenced variable must match `[A-Za-z_][A-Za-z0-9_]*` and is resolved from
the gateway process environment, for example one supplied by a systemd
environment file. There is no blanket `${VAR}` expansion in JSON and no CLI
dotenv loader.

An explicit reference pins the source it names: while `credentials.<spelling>` is
configured, that one variable is the provider's only environment source. If it is
unset or blank, auth resolution fails closed with a configuration error and does
not fall back to the provider's native ambient variables. Only when no reference
is configured do the provider's native environment variables and ambient
credential facilities remain available. A stored credential from `login` owns its
provider and is used before environment resolution, with or without a reference;
OAuth refresh is native and happens under the credential-store lock. A custom
provider without a reference is keyless unless a stored login key exists.

Every provider referenced by the chat allowlist needs usable auth before the
gateway opens storage. `opencode_zen` and `opencode_go` are distinct native
providers and can hold separate credentials even when both ultimately use the
same environment-variable name in native code. If several configured spellings
map to one native provider, one explicit credentials reference applies to that
provider; two different references are ambiguous and fail startup.

## Login and logout

Authentication is an explicit terminal operation, never startup, model-triggered
or Telegram-triggered:

```sh
durable-nanobot login                  # list and choose a native provider and method
durable-nanobot login openai           # one provider; prompts for its available method
durable-nanobot login openai --auth oauth
durable-nanobot logout                 # choose a stored credential
durable-nanobot logout openai
```

Both commands take the same optional `--config <path>` as the gateway, validate
the full configuration the same way, and prepare (create if absent, `0700`) the
configured canonical `dataDir`; they open no gateway, no Durable store and no model
turn. Errors print one fixed diagnostic for a known cause (unknown provider,
unsupported method, missing stored credential, cancelled, or failed) and never a
credential value, provider error text or path. It presents the native provider list and the methods each provider
offers: stored API key, or provider-owned OAuth (for example Sign in with ChatGPT,
Anthropic subscription login, GitHub Copilot, or OpenRouter PKCE). Browser URLs,
device codes, progress and manual-code prompts come from the provider's
UI-neutral `AuthInteraction`; the terminal prints them and returns typed answers.
API-key entry is hidden in an interactive terminal.

`logout` removes one provider's stored credential from Durable's store only.

Durable keeps an independent private credential store under the configured
`dataDir`. It never reads, shares or modifies Pi's own credential store. The store
uses the native type-tagged credential shape, private file permissions, atomic
replacement and a sibling lock so login and gateway OAuth refresh do not
double-rotate a token. Do not copy Pi credentials into it; run `login` instead.
Keep the data directory private, as for every other runtime secret.

The gateway uses stored OAuth without a login flow: a request resolves and
refreshes the provider credential natively. `/restart` keeps the current process
environment; a systemd environment-file change needs a service restart.

The local CLI owner may run `/reload` after editing `credentials` references in
the configuration file. It re-reads and fully validates the whole file, resolves
the candidate provider catalog and fails closed if a referenced variable is unset
or blank, then swaps only the foreground model catalog and provider wrappers once
the committing transaction is stored. Values are never printed, persisted to a
transcript or written to diagnostics. Only new work uses the rotated references: a
reload is refused while any live task (including a sleeping or blocked background
capture) or queued input exists, except an armed native cron timer, so no work
admitted under the previous credential resumes under the new one. Changing
`providers` definitions (or any non-model field) still needs `/restart`; see
[live reload](./MODELS.md#live-reload-cli-owner-action).

## Custom compatible providers

Use `providers` for an OpenAI-, Anthropic- or Google-compatible endpoint that is
not a pinned native provider. Models are metadata supplied by the operator and
requests run through a native Pi AI API implementation, not a bespoke client:

```json
{
  "model": { "provider": "umans", "modelId": "umans-deepseek-v4.1-flash" },
  "allowedModels": [
    { "provider": "umans", "modelId": "umans-deepseek-v4.1-flash" }
  ],
  "credentials": { "umans": "UMANS_API_KEY" },
  "providers": {
    "umans": {
      "name": "Umans",
      "baseUrl": "https://api.code.umans.ai",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "umans-deepseek-v4.1-flash",
          "name": "Umans DeepSeek V4.1 Flash",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

`providers.<key>` accepts exactly `name`, `baseUrl`, `api` and `models`. `api` is
one of `anthropic-messages`, `openai-completions`, `openai-responses` or
`google-generative-ai`. Each model requires `id`, `contextWindow`, `maxTokens`
and a complete `cost` object; `name` defaults to the ID, `reasoning` to false and
`input` to `["text"]`. Cost values are display/accounting metadata supplied by
the operator, not provider billing evidence. There are no provider headers,
model overrides, dynamic discovery, command interpolation or image/classifier
entries in this block.

Omit `credentials.<key>` for a keyless local compatible endpoint. A custom
provider still needs model metadata and an absolute `http(s)` base URL without
embedded credentials or a fragment. `durable-nanobot login <key>` can store a key
for such a provider; a stored key wins and the endpoint is keyless otherwise.

## Classifiers and image generation

At most one classifier model is reachable, only when configuration grants it:
model-facing only through native Code Mode `models.*`, and host-side only for the
idle-rollover continuation check (see README):

```json
{
  "classifierModel": { "provider": "typesafe", "modelId": "jev-latest" },
  "credentials": { "typesafe": "TYPESAFE_API_KEY" }
}
```

`classifierModel` is one exact `{ provider, modelId }` pair that must name a
classifier-type model in the registered native/custom catalog. Absent, classifiers
are unavailable even while Code Mode is enabled: the native classifier nested tool
is not registered, discovery lists none, and a script call fails without a model
request. A registered provider's other classifier models are never implied. There
is no list, fallback, substitution or chat-model grant. A classifier-only provider
is registered by naming its model here (plus `credentials` or `login`), with no
`allowedModels` entry.

Scripts can list what they may use with `models.getModelsOfType("classifier")` or
`models.getAvailableOfType("classifier")` — only the configured model appears —
and call the native `models.classify(model, { state, questions, images? })`.
Calls are native nested Durable tasks: their cancellation, replay policy and usage
accounting apply, and the usage lands in the conversation's `pi.usage` under the
nested tool's bucket rather than in the `codemode` result. Image input is accepted
only when the classifier model declares `"image"` input.

Image **generation** is not installed. The generator registration and its Code
Mode documentation are removed and image models are hidden from the scoped
catalog. One native constraint remains: `models: true` installs the native
`models.*` globals from a frozen internal map, so the `models.generateImages`
global name still exists in a script; a call resolves to no registered tool and
fails without any provider or image-model request.

## Explicit gaps

- No dynamic provider/model discovery, automatic or startup catalog refresh,
  fallback chain or automatic model substitution. Catalog updates are the explicit
  pi.dev `models refresh` command only; custom providers are not refreshed.
- No endpoint override for a native provider, only whole custom providers.
- No custom-provider classifier or image entries, provider headers, compatibility
  overrides, command-backed credentials or `${VAR}` interpolation.
- No image generation.
- No provider matrix acceptance. Catalog lookup is not evidence that a remote
  service accepts requests, tool calls, streaming or image input.
- Python's `zhipu`, `zai`, `dashscope` and plain `minimax` endpoint differences
  are not aliased. Use a native provider whose catalog matches the service, or an
  explicit compatible provider entry.
- The native Moonshot catalog is used as-is; Python model-specific temperature
  overrides are not ported.

## Source basis

- Pinned Pi AI `1.5.0`: `createModels`, `createProvider`, `CredentialStore`,
  `Models.login`/`logout`/`getAuth`/`checkAuth`, provider factories and native API
  implementations. Installed `docs/models.md`, `custom-provider.md`,
  `models-configuration.md` and the Pi AI README describe the native contracts.
- Pinned Durable `1.5.0`: Code Mode `models.*` catalog globals, the reserved
  `pi.codemode.models.classify` nested tool and the `pi.codemode.models.generateImages`
  registration deliberately omitted here.
- Nanobot reference: `nanobot/providers/registry.py`, `factory.py`,
  `openai_compat_provider.py` and `nanobot/config/schema.py`. Provider aliases are
  migration compatibility only, not a replacement catalog.
