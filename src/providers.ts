import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type AuthContext,
  type CredentialStore,
  type Model,
  type Models,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Api, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  modelKey,
  type CustomProviderApi,
  type CustomProviderConfig,
  type ModelReference,
  type PortConfig,
} from "./config.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";

/**
 * Compatibility spellings used by existing Durable configuration. This is a
 * migration map, not a provider whitelist: a configured spelling resolves to
 * itself when a native Pi AI provider with that ID exists, and every custom
 * provider key resolves to itself. A new configuration should use native IDs.
 */
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  minimax_anthropic: "minimax",
  moonshot: "moonshotai",
  opencode_zen: "opencode",
  opencode_go: "opencode-go",
  xiaomi_mimo: "xiaomi",
});

const CUSTOM_PROVIDER_API: Readonly<Record<CustomProviderApi, () => ProviderStreams>> = Object.freeze({
  "anthropic-messages": anthropicMessagesApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "google-generative-ai": googleGenerativeAIApi,
});

/** Native provider ID for a configured spelling. Unknown spellings stay unchanged for validation. */
export function nativeProviderId(configured: string): string {
  // Own-property only: a spelling such as `constructor` or `__proto__` is never an alias.
  return Object.hasOwn(LEGACY_PROVIDER_ALIASES, configured) ? LEGACY_PROVIDER_ALIASES[configured]! : configured;
}

export interface ResolvedModelChoice {
  /** Provider spelling accepted in config and Gateway selection calls. */
  configured: ModelReference;
  /** Provider/model identity stored by native Durable in pi.agent. */
  native: ModelReference;
  model: Model<Api>;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export function nativeModelReference(model: ModelReference): ModelReference {
  return {
    provider: nativeProviderId(model.provider),
    modelId: model.modelId,
  };
}

/**
 * Resolve the one configured classifier model. A classifier is never implied by a
 * registered provider or by a chat `allowedModels` entry: the pair must name a
 * classifier-type model in the registered native/custom catalog.
 */
export function resolveClassifierModel(
  models: Models,
  configured: ModelReference | undefined,
): ModelReference | undefined {
  if (configured === undefined) return undefined;
  const native = nativeModelReference(configured);
  if (models.getModelOfType("classifier", native.provider, native.modelId) === undefined) {
    throw new StartupDiagnosticError("model", {
      detail: `Unknown classifier model ${native.provider}/${native.modelId} in the configured Models catalog`,
    });
  }
  return native;
}

/** Resolve only the explicit allowlist, without auth lookup, catalog refresh, or network access. */
export function resolveModelChoices(models: Models, allowed: readonly ModelReference[]): ResolvedModelChoice[] {
  const seen = new Set<string>();
  return allowed.map((configured) => {
    const native = nativeModelReference(configured);
    const key = modelKey(native);
    if (seen.has(key)) {
      throw new StartupDiagnosticError("model", {
        detail: "allowedModels contains aliases for the same native model",
      });
    }
    seen.add(key);
    const model = models.getModel(native.provider, native.modelId);
    if (!model) {
      throw new StartupDiagnosticError("model", {
        detail: `Unknown model ${native.provider}/${native.modelId} in the configured Models catalog`,
      });
    }
    return { configured: { ...configured }, native, model, thinkingLevels: getSupportedThinkingLevels(model) };
  });
}

function existsPath(path: string): Promise<boolean> {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return access(expanded, constants.F_OK).then(() => true, () => false);
}

function authContext(env: NodeJS.ProcessEnv): AuthContext {
  return {
    // Own-property and string-only: an inherited prototype member such as `constructor`
    // is never a credential value. Withheld rather than stringified.
    env: async (name) => {
      if (!Object.hasOwn(env, name)) return undefined;
      const value = env[name];
      return typeof value === "string" ? value : undefined;
    },
    // Native Vertex ADC discovery uses this; it does not read Pi's credential store.
    fileExists: existsPath,
  };
}

function configuredEnvName(config: PortConfig, spelling: string): string | undefined {
  const credentials = config.credentials;
  return credentials !== undefined && Object.hasOwn(credentials, spelling) ? credentials[spelling] : undefined;
}

/** One native provider may be referenced by an alias and its native spelling. */
function configuredEnvNameForNative(config: PortConfig, nativeId: string): string | undefined {
  const names = new Set<string>();
  for (const [spelling, name] of Object.entries(config.credentials ?? {})) {
    if (nativeProviderId(spelling) === nativeId) names.add(name);
  }
  if (names.size > 1) {
    throw new StartupDiagnosticError("provider", {
      detail: "Configured spellings for the same native provider must use the same credentials reference",
    });
  }
  return [...names][0];
}

function requireEnvName(name: string | undefined, spelling: string): string | undefined {
  if (name === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new StartupDiagnosticError("credential", {
      detail: `Invalid environment variable reference: credentials.${spelling}`,
    });
  }
  return name;
}

/**
 * Read one explicitly configured environment reference. An unset or blank variable
 * fails closed instead of falling back to the provider's native ambient variables,
 * so `credentials.<spelling>` always pins the source it names. Errors name the
 * configuration key and variable only, never a value.
 */
async function configuredEnvValue(
  ctx: AuthContext,
  envName: string,
  spelling: string,
  signal: AbortSignal,
): Promise<string> {
  const value = await ctx.env(envName);
  signal.throwIfAborted();
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `credentials.${spelling} requires environment variable ${envName} to be set and non-empty; ` +
      "native ambient credential discovery is disabled while that reference is configured",
    );
  }
  return value;
}

/**
 * Preserve the native provider and its OAuth method, but let an explicit
 * `credentials.<spelling>` environment reference stand in for the provider's
 * default API-key variable. A stored credential still owns the provider.
 */
function withConfiguredCredential(
  provider: Provider,
  spelling: string,
  envName: string | undefined,
): Provider {
  if (envName === undefined) return provider;
  const nativeApiKey = provider.auth.apiKey;
  if (nativeApiKey === undefined) {
    throw new StartupDiagnosticError("credential", {
      detail: `credentials.${spelling} names an environment variable but the provider has no API-key authentication`,
    });
  }
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...nativeApiKey,
        resolve: async (input) => {
          input.signal.throwIfAborted();
          // Stored API-key and OAuth credentials keep precedence over a configured reference.
          if (input.credential?.key) return nativeApiKey.resolve(input);
          const value = await configuredEnvValue(input.ctx, envName, spelling, input.signal);
          return { auth: { apiKey: value }, source: `credentials.${spelling}` };
        },
      },
    },
  };
}

function customProvider(
  key: string,
  config: CustomProviderConfig,
  envName: string | undefined,
): Provider {
  const displayName = `${config.name} API key`;
  // Stored login keys win. With an explicit `credentials.<key>` reference the named
  // environment variable is the only other source and fails closed when unset; with no
  // reference the endpoint is keyless.
  const apiKey: NonNullable<ProviderAuth["apiKey"]> = {
    name: displayName,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const secret = await interaction.prompt({ type: "secret", message: `Enter ${displayName}` });
      interaction.signal.throwIfAborted();
      return { type: "api_key", key: secret };
    },
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) {
        return {
          auth: { apiKey: credential.key },
          ...(credential.env === undefined ? {} : { env: credential.env }),
          source: "stored credential",
        };
      }
      if (envName === undefined) return { auth: {}, source: "keyless" };
      const value = await configuredEnvValue(ctx, envName, key, signal);
      return { auth: { apiKey: value }, source: `credentials.${key}` };
    },
  };
  const auth: ProviderAuth = { apiKey };
  const api = config.api as Api;
  const models: Model<Api>[] = config.models.map((model) => ({
    type: "chat",
    id: model.id,
    name: model.name,
    api,
    provider: key,
    baseUrl: config.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  return createProvider({
    id: key,
    name: config.name,
    baseUrl: config.baseUrl,
    auth,
    models,
    api: CUSTOM_PROVIDER_API[config.api](),
  });
}

function nativeProviders(): ReadonlyMap<string, Provider> {
  return new Map(builtinProviders().map((provider) => [provider.id, provider]));
}

/**
 * Register the configured custom providers and the native providers referenced
 * by model allowances or credential references. No catalog refresh, discovery,
 * request client or provider whitelist is involved.
 */
export function createProviderModels(
  config: PortConfig,
  env: NodeJS.ProcessEnv = process.env,
  credentials?: CredentialStore,
): { models: Models; model: ModelReference; classifier: ModelReference | undefined } {
  const builtins = nativeProviders();
  const custom = config.providers ?? {};
  const customProviderConfig = (spelling: string): CustomProviderConfig | undefined =>
    Object.hasOwn(custom, spelling) ? custom[spelling] : undefined;
  for (const key of Object.keys(custom)) {
    if (builtins.has(key) || Object.hasOwn(LEGACY_PROVIDER_ALIASES, key)) {
      throw new StartupDiagnosticError("provider", {
        detail: `providers.${key} cannot redefine a native provider or legacy alias`,
      });
    }
  }

  const spellings = new Set<string>();
  for (const configured of config.allowedModels ?? [config.model]) spellings.add(configured.provider);
  if (config.classifierModel !== undefined) spellings.add(config.classifierModel.provider);
  for (const key of Object.keys(config.credentials ?? {})) spellings.add(key);
  for (const key of Object.keys(custom)) spellings.add(key);

  const registrations = new Map<string, { readonly spelling: string; readonly envNames: Set<string> }>();
  for (const spelling of spellings) {
    const nativeId = nativeProviderId(spelling);
    const envName = requireEnvName(configuredEnvName(config, spelling), spelling);
    const previous = registrations.get(nativeId);
    if (previous !== undefined) {
      if (envName !== undefined) previous.envNames.add(envName);
      continue;
    }
    if (customProviderConfig(spelling) === undefined && !builtins.has(nativeId)) {
      throw new StartupDiagnosticError("provider", {
        detail: `Unknown provider ${spelling}; use a native Pi AI provider ID, a documented legacy alias, or a providers entry`,
      });
    }
    registrations.set(nativeId, {
      spelling,
      envNames: envName === undefined ? new Set() : new Set([envName]),
    });
  }

  const models = createModels({
    ...(credentials === undefined ? {} : { credentials }),
    authContext: authContext(env),
  });
  for (const [nativeId, { spelling, envNames }] of registrations) {
    if (envNames.size > 1) {
      throw new StartupDiagnosticError("provider", {
        detail: "Configured spellings for the same native provider must use the same credentials reference",
      });
    }
    const envName = [...envNames][0];
    const definition = customProviderConfig(spelling);
    const provider = definition === undefined
      ? withConfiguredCredential(builtins.get(nativeId)!, spelling, envName)
      : customProvider(spelling, definition, envName);
    if (provider.id !== nativeId) {
      throw new StartupDiagnosticError("provider", { detail: "Native provider alias identity changed unexpectedly" });
    }
    models.setProvider(provider);
  }

  const choices = resolveModelChoices(models, config.allowedModels ?? [config.model]);
  const defaultChoice = choices.find((choice) => modelKey(choice.configured) === modelKey(config.model));
  if (!defaultChoice) {
    throw new StartupDiagnosticError("model", { detail: "Default model must be included in allowedModels" });
  }
  const classifier = resolveClassifierModel(models, config.classifierModel);
  return { models, model: defaultChoice.native, classifier };
}

/**
 * Register every built-in provider plus configured custom providers for the
 * explicit `login`/`logout` command. Gateway authority is intentionally not
 * reused here: login never selects or runs a model. It also never starts a
 * login flow by itself.
 */
export function createAuthModels(
  config: PortConfig,
  env: NodeJS.ProcessEnv = process.env,
  credentials?: CredentialStore,
): Models {
  const models = createModels({
    ...(credentials === undefined ? {} : { credentials }),
    authContext: authContext(env),
  });
  const builtins = nativeProviders();
  const custom = config.providers ?? {};
  for (const key of Object.keys(custom)) {
    if (builtins.has(key) || Object.hasOwn(LEGACY_PROVIDER_ALIASES, key)) {
      throw new StartupDiagnosticError("provider", {
        detail: `providers.${key} cannot redefine a native provider or legacy alias`,
      });
    }
  }
  for (const provider of builtins.values()) {
    const envName = requireEnvName(configuredEnvNameForNative(config, provider.id), provider.id);
    models.setProvider(withConfiguredCredential(provider, provider.id, envName));
  }
  for (const [key, definition] of Object.entries(custom)) {
    const envName = requireEnvName(configuredEnvName(config, key), key);
    models.setProvider(customProvider(key, definition, envName));
  }
  return models;
}

/**
 * Fail before storage opens when a configured chat provider has no usable
 * credential. Native `checkAuth` resolves env/custom/keyless auth and checks
 * stored OAuth presence without refreshing it or making a network request.
 */
export async function assertConfiguredModelAuth(
  models: Models,
  choices: readonly ResolvedModelChoice[],
  signal?: AbortSignal,
): Promise<void> {
  const checked = new Set<string>();
  for (const choice of choices) {
    const providerId = choice.native.provider;
    if (checked.has(providerId)) continue;
    checked.add(providerId);
    let auth;
    try {
      auth = await models.checkAuth(providerId, signal === undefined ? {} : { signal });
    } catch (cause) {
      throw new StartupDiagnosticError("credential", {
        detail: `Credential lookup failed for provider ${providerId}`,
        cause,
      });
    }
    if (auth === undefined) {
      throw new StartupDiagnosticError("credential", {
        detail: `Missing credential for provider ${providerId}; log in or set its API-key environment`,
      });
    }
  }
}
