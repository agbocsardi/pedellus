import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { PortConfig } from "./config.js";

export function createProviderModels(config: PortConfig, env: NodeJS.ProcessEnv = process.env): { models: Models; model: { provider: string; modelId: string } } {
  const selected = config.model.provider;
  const aliases: Record<string, { id: string; credential: string; provider: () => Provider }> = {
    openai: { id: "openai", credential: "openai", provider: openaiProvider },
    opencode_zen: { id: "opencode", credential: "opencode_zen", provider: opencodeProvider },
    opencode_go: { id: "opencode-go", credential: "opencode_go", provider: opencodeGoProvider },
  };
  const selection = aliases[selected];
  if (!selection) throw new Error(`Unsupported provider: ${selected}`);
  const keyName = config.credentials?.[selection.credential as keyof NonNullable<PortConfig["credentials"]>];
  if (!keyName || !env[keyName]) throw new Error(`Missing credential: set environment variable named by credentials.${selected}`);
  const envNames: Record<string, string | undefined> = {
    OPENAI_API_KEY: selected === "openai" ? keyName : undefined,
    OPENCODE_API_KEY: selected === "openai" ? undefined : keyName,
  };
  const models = createModels({ authContext: {
    env: async (name) => {
      const configured = envNames[name];
      return configured === undefined ? undefined : env[configured];
    },
    fileExists: async () => false,
  } });
  models.setProvider(selection.provider());
  if (!models.getModel(selection.id, config.model.modelId)) throw new Error(`Unknown model ${selected}/${config.model.modelId}`);
  return { models, model: { provider: selection.id, modelId: config.model.modelId } };
}
