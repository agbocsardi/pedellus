/**
 * One resolution pass over a configuration's foreground model catalog.
 *
 * The gateway uses this for its first open and for an explicit live reload, so both paths validate
 * and expose exactly the same named-preset catalog, finite allowlist and default thinking level.
 */

import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { modelKey, type PortConfig } from "./config.js";
import { nativeModelReference, resolveModelChoices, type ResolvedModelChoice } from "./providers.js";
import { StartupDiagnosticError } from "./startup-diagnostics.js";

export interface GatewayModelPresetEntry {
  readonly choice: ResolvedModelChoice;
  readonly thinkingLevel?: ModelThinkingLevel;
}

export interface ResolvedModelConfiguration {
  readonly choices: readonly ResolvedModelChoice[];
  readonly choicesByConfigured: ReadonlyMap<string, ResolvedModelChoice>;
  readonly choicesByNative: ReadonlyMap<string, ResolvedModelChoice>;
  readonly configuredPresetName: string | undefined;
  readonly presetCatalog: ReadonlyMap<string, GatewayModelPresetEntry>;
  readonly defaultChoice: ResolvedModelChoice;
  readonly defaultThinkingLevel: ModelThinkingLevel;
}

/**
 * Resolve the configured default, allowlist and named presets against one registered catalog.
 * Every reference and thinking level is checked before storage or dispatch. A bad candidate throws
 * a startup diagnostic; the reload path treats that as a fixed refusal and applies nothing.
 */
export function resolveModelConfiguration(config: PortConfig, models: Models): ResolvedModelConfiguration {
  const choices = resolveModelChoices(models, config.allowedModels ?? [config.model]);
  const choicesByConfigured = new Map(choices.map((choice) => [modelKey(choice.configured), choice]));
  const choicesByNative = new Map(choices.map((choice) => [modelKey(choice.native), choice]));
  const configuredPresetName = config.modelPreset;
  const presetCatalog = new Map<string, GatewayModelPresetEntry>();
  if (configuredPresetName !== undefined) {
    if (config.modelPresets === undefined || Object.keys(config.modelPresets).length === 0) {
      throw new StartupDiagnosticError("model", { detail: "modelPreset requires a non-empty modelPresets catalog" });
    }
    for (const [name, preset] of Object.entries(config.modelPresets)) {
      const choice = choicesByConfigured.get(modelKey(preset));
      if (choice === undefined) {
        throw new StartupDiagnosticError("model", {
          detail: `Model preset ${name} is outside the configured model catalog`,
        });
      }
      if (preset.thinkingLevel !== undefined && !choice.thinkingLevels.includes(preset.thinkingLevel)) {
        throw new StartupDiagnosticError("model", {
          detail: `Unsupported thinkingLevel ${preset.thinkingLevel} for model preset ${name}`,
        });
      }
      presetCatalog.set(name, {
        choice,
        ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
      });
    }
    if (!presetCatalog.has(configuredPresetName)) {
      throw new StartupDiagnosticError("model", { detail: "modelPreset must name a configured model preset" });
    }
  }
  const defaultPreset = configuredPresetName === undefined ? undefined : presetCatalog.get(configuredPresetName);
  const defaultChoice = defaultPreset?.choice ?? choicesByConfigured.get(modelKey(config.model));
  if (!defaultChoice) {
    throw new StartupDiagnosticError("model", { detail: "Default model must be included in allowedModels" });
  }
  if (modelKey(defaultChoice.native) !== modelKey(nativeModelReference(config.model))) {
    throw new StartupDiagnosticError("model", {
      detail: "Resolved default model does not match its configured choice",
    });
  }
  if (config.thinkingLevel !== undefined && !defaultChoice.thinkingLevels.includes(config.thinkingLevel)) {
    throw new StartupDiagnosticError("model", {
      detail: `Unsupported thinkingLevel ${config.thinkingLevel} for default model ${config.model.provider}/${config.model.modelId}`,
    });
  }
  return {
    choices,
    choicesByConfigured,
    choicesByNative,
    configuredPresetName,
    presetCatalog,
    defaultChoice,
    defaultThinkingLevel: defaultPreset?.thinkingLevel ?? config.thinkingLevel ?? "off",
  };
}
