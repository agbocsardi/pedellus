import { createModels, getSupportedThinkingLevels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import type { CredentialProvider, ModelReference, PortConfig } from "./config.js";

type ProviderAlias = {
  providerId: string;
  credential: CredentialProvider;
  create: () => Provider;
};

// Map lookup rejects prototype names instead of resolving inherited object properties.
const PROVIDER_ALIASES = new Map<string, ProviderAlias>([
  ["anthropic", { providerId: "anthropic", credential: "anthropic", create: anthropicProvider }],
  ["deepseek", { providerId: "deepseek", credential: "deepseek", create: deepseekProvider }],
  ["minimax_anthropic", { providerId: "minimax", credential: "minimax_anthropic", create: minimaxProvider }],
  ["moonshot", { providerId: "moonshotai", credential: "moonshot", create: moonshotaiProvider }],
  ["openai", { providerId: "openai", credential: "openai", create: openaiProvider }],
  ["openrouter", { providerId: "openrouter", credential: "openrouter", create: openrouterProvider }],
  ["opencode_zen", { providerId: "opencode", credential: "opencode_zen", create: opencodeProvider }],
  ["opencode_go", { providerId: "opencode-go", credential: "opencode_go", create: opencodeGoProvider }],
  ["xiaomi_mimo", { providerId: "xiaomi", credential: "xiaomi_mimo", create: xiaomiProvider }],
]);

export interface ResolvedModelChoice {
  /** Provider spelling accepted in config and Gateway selection calls. */
  configured: ModelReference;
  /** Provider/model identity stored by native Durable in pi.agent. */
  native: ModelReference;
  model: Model<Api>;
  thinkingLevels: readonly ModelThinkingLevel[];
}

function modelKey(model: ModelReference): string {
  return JSON.stringify([model.provider, model.modelId]);
}

export function nativeModelReference(model: ModelReference): ModelReference {
  return {
    provider: PROVIDER_ALIASES.get(model.provider)?.providerId ?? model.provider,
    modelId: model.modelId,
  };
}

/** Resolve only the explicit allowlist, without auth lookup, catalog refresh, or network access. */
export function resolveModelChoices(models: Models, allowed: readonly ModelReference[]): ResolvedModelChoice[] {
  const seen = new Set<string>();
  return allowed.map((configured) => {
    const native = nativeModelReference(configured);
    const key = modelKey(native);
    if (seen.has(key)) throw new Error("allowedModels contains aliases for the same native model");
    seen.add(key);
    const model = models.getModel(native.provider, native.modelId);
    if (!model) throw new Error(`Unknown model ${native.provider}/${native.modelId} in the configured Models catalog`);
    return { configured: { ...configured }, native, model, thinkingLevels: getSupportedThinkingLevels(model) };
  });
}

export function createProviderModels(
  config: PortConfig,
  env: NodeJS.ProcessEnv = process.env,
): { models: Models; model: ModelReference } {
  const aliases = new Map<string, ProviderAlias>();
  for (const configured of config.allowedModels ?? [config.model]) {
    const selection = PROVIDER_ALIASES.get(configured.provider);
    if (!selection) throw new Error("Unsupported provider; see packages/pi-nanobot/PROVIDERS.md");
    const previous = aliases.get(selection.providerId);
    if (previous && previous.credential !== selection.credential) {
      throw new Error("Configured aliases cannot share a native provider with different credentials");
    }
    aliases.set(selection.providerId, selection);
  }

  const models = createModels({
    // Provider credentials below are resolved from their own captured config key. No ambient lookup is permitted.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const [providerId, selection] of aliases) {
    const credentials = config.credentials;
    const keyName = credentials && Object.hasOwn(credentials, selection.credential)
      ? credentials[selection.credential]
      : undefined;
    if (typeof keyName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
      throw new Error(`Invalid environment variable reference: credentials.${selection.credential}`);
    }
    const apiKey = Object.hasOwn(env, keyName) ? env[keyName] : undefined;
    if (!apiKey?.trim()) {
      throw new Error(`Missing credential: set the environment variable named by credentials.${selection.credential}`);
    }

    const nativeProvider = selection.create();
    const nativeApiKey = nativeProvider.auth.apiKey;
    if (!nativeApiKey) throw new Error("Selected provider has no environment API-key authentication");
    models.setProvider({
      ...nativeProvider,
      auth: {
        // Native provider-scoped resolution prevents aliases with a shared env name (OpenCode) crossing keys.
        apiKey: {
          name: nativeApiKey.name,
          resolve: async ({ signal }) => {
            signal.throwIfAborted();
            return { auth: { apiKey }, source: `credentials.${selection.credential}` };
          },
        },
      },
    });
    if (providerId !== nativeProvider.id) throw new Error("Native provider alias identity changed unexpectedly");
  }

  const choices = resolveModelChoices(models, config.allowedModels ?? [config.model]);
  const defaultChoice = choices.find((choice) => modelKey(choice.configured) === modelKey(config.model));
  if (!defaultChoice) throw new Error("Default model must be included in allowedModels");
  return { models, model: defaultChoice.native };
}
