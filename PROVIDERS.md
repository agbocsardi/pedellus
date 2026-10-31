# Providers, auth, models and classifiers

This slice exposes the pinned Pi AI `1.4.0` provider registry and its native auth,
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
`@earendil-works/pi-ai@1.4.0`; there is no second hand-maintained provider list,
catalog refresh, model discovery, fallback chain or automatic substitution.

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

An explicit reference overrides the provider's default API-key variable for that
provider only. If no reference is configured, the provider's native environment
variables and ambient credential facilities remain available. A stored credential
from `login` owns its provider and is used before environment resolution. OAuth
refresh is native and happens under the credential-store lock.

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

Both commands take the same optional `--config <path>` as the gateway and use the
configured `dataDir`. `login` opens no gateway, starts no model turn and makes no
model request. It presents the native provider list and the methods each provider
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

Classifier models are exposed through the native Code Mode `models.*` surface
when [Code Mode](./CODEMODE.md) is enabled for an authenticated mapped chat or a
captured ordinary worker. They are not chat selections, do not appear in
`/model`, and cannot be run directly by the model. A classifier-only provider can
be registered by naming it in `credentials` even when no chat model from that
provider is in `allowedModels`:

```json
{
  "credentials": {
    "opencode_go": "OPENCODE_GO_API_KEY",
    "typesafe": "TYPESAFE_API_KEY"
  }
}
```

Scripts list candidates with `models.getModelsOfType("classifier")` or
`models.getAvailableOfType("classifier")` and call the native
`models.classify(model, { state, questions, images? })`. Calls are native nested
Durable tasks: their cancellation, usage accounting, replay policy and the Code
Mode time/output budgets apply. Image input is accepted only when the classifier
model declares `"image"` input.

Image **generation** is not installed. There is no `models.generateImages`
helper, no image-generation tool and no generation API registration. The `image()`
script output helper remains only for showing existing image blocks. Existing
image understanding, `read` image results and the vision handoff are unchanged.

## Explicit gaps

- No dynamic provider/model discovery, catalog refresh, fallback chain or
  automatic model substitution.
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

- Pinned Pi AI `1.4.0`: `createModels`, `createProvider`, `CredentialStore`,
  `Models.login`/`logout`/`getAuth`/`checkAuth`, provider factories and native API
  implementations. Installed `docs/models.md`, `custom-provider.md`,
  `models-configuration.md` and the Pi AI README describe the native contracts.
- Pinned Durable `1.4.0`: Code Mode `models.*` catalog globals, the reserved
  `pi.codemode.models.classify` nested tool and the `pi.codemode.models.generateImages`
  registration deliberately omitted here.
- Nanobot reference: `nanobot/providers/registry.py`, `factory.py`,
  `openai_compat_provider.py` and `nanobot/config/schema.py`. Provider aliases are
  migration compatibility only, not a replacement catalog.
