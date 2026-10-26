import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { PortConfig } from "./config.js";

export function createProviderModels(config: PortConfig, env: NodeJS.ProcessEnv = process.env) {
  const credential = config.credentials ?? {};
  const envNames: Record<string, string | undefined> = {
    OPENAI_API_KEY: credential.openai,
    OPENCODE_API_KEY: credential.opencode_zen ?? credential.opencode_go,
  };
  const models = createModels({ authContext: {
    env: async (name) => {
      const configured = envNames[name];
      return configured === undefined ? undefined : env[configured];
    },
    fileExists: async () => false,
  } });
  const selected = config.model.provider;
  const id = selected === "opencode_zen" ? "opencode" : selected === "opencode_go" ? "opencode-go" : selected;
  if (!["openai", "opencode", "opencode-go"].includes(id)) throw new Error(`Unsupported provider: ${selected}`);
  const model = selected === "opencode_zen" ? opencodeProvider() : selected === "opencode_go" ? opencodeGoProvider() : openaiProvider();
  models.setProvider(model);
  const catalogModel = models.getModel(id, config.model.modelId);
  if (!catalogModel) throw new Error(`Unknown model ${selected}/${config.model.modelId}`);
  const keyName = credential[selected as keyof typeof credential];
  if (!keyName || !env[keyName]) throw new Error(`Missing credential: set environment variable named by credentials.${selected}`);
  return { models, model: { provider: id, modelId: config.model.modelId } };
}
