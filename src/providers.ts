import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import type { CredentialProvider, PortConfig } from "./config.js";

type ProviderAlias = {
  providerId: string;
  credential: CredentialProvider;
  authEnv: string;
  create: () => Provider;
};

// Map lookup rejects prototype names instead of resolving inherited object properties.
const PROVIDER_ALIASES = new Map<string, ProviderAlias>([
  ["anthropic", { providerId: "anthropic", credential: "anthropic", authEnv: "ANTHROPIC_API_KEY", create: anthropicProvider }],
  ["deepseek", { providerId: "deepseek", credential: "deepseek", authEnv: "DEEPSEEK_API_KEY", create: deepseekProvider }],
  ["minimax_anthropic", { providerId: "minimax", credential: "minimax_anthropic", authEnv: "MINIMAX_API_KEY", create: minimaxProvider }],
  ["moonshot", { providerId: "moonshotai", credential: "moonshot", authEnv: "MOONSHOT_API_KEY", create: moonshotaiProvider }],
  ["openai", { providerId: "openai", credential: "openai", authEnv: "OPENAI_API_KEY", create: openaiProvider }],
  ["openrouter", { providerId: "openrouter", credential: "openrouter", authEnv: "OPENROUTER_API_KEY", create: openrouterProvider }],
  ["opencode_zen", { providerId: "opencode", credential: "opencode_zen", authEnv: "OPENCODE_API_KEY", create: opencodeProvider }],
  ["opencode_go", { providerId: "opencode-go", credential: "opencode_go", authEnv: "OPENCODE_API_KEY", create: opencodeGoProvider }],
  ["xiaomi_mimo", { providerId: "xiaomi", credential: "xiaomi_mimo", authEnv: "XIAOMI_API_KEY", create: xiaomiProvider }],
]);

export function createProviderModels(
  config: PortConfig,
  env: NodeJS.ProcessEnv = process.env,
): { models: Models; model: { provider: string; modelId: string } } {
  const selection = PROVIDER_ALIASES.get(config.model.provider);
  if (!selection) throw new Error("Unsupported provider; see packages/pi-nanobot/PROVIDERS.md");

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

  // The closed auth context prevents ambient env/auth-file discovery; expose only this key.
  const models = createModels({
    authContext: {
      env: async (name) => name === selection.authEnv ? apiKey : undefined,
      fileExists: async () => false,
    },
  });
  const nativeProvider = selection.create();
  if (!nativeProvider.auth.apiKey) throw new Error("Selected provider has no environment API-key authentication");
  const apiKeyAuth = { ...nativeProvider.auth.apiKey };
  delete apiKeyAuth.login;
  models.setProvider({ ...nativeProvider, auth: { apiKey: apiKeyAuth } });

  if (!models.getModel(selection.providerId, config.model.modelId)) {
    throw new Error(`Unknown model ${selection.providerId}/${config.model.modelId} in the pinned Pi provider catalog`);
  }
  return { models, model: { provider: selection.providerId, modelId: config.model.modelId } };
}
