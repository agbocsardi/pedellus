/**
 * Terminal `models refresh|list`. Refresh is the only network path for the model catalog; list is
 * offline. Neither opens the gateway, reads a credential, changes configuration or grants a model.
 */
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { PortConfig } from "./config.js";
import { modelKey } from "./config.js";
import { loadModelCatalog, refreshModelCatalog, withCatalogOverlay, type RefreshOptions, type RefreshOutcome } from "./model-catalog.js";
import { nativeProviderId } from "./providers.js";
import { prepareDataDirectory } from "./store.js";

export interface ModelsInvocation {
  readonly action: "refresh" | "list";
  readonly providers: readonly string[];
}

export interface ModelsTerminal {
  readonly output: { write(text: string): unknown };
  readonly signal?: AbortSignal;
  /** Test seam: catalog base URL and fetch. Never exposed as configuration. */
  readonly refresh?: Omit<RefreshOptions, "signal">;
}

/** Native built-in providers this configuration references; custom providers have no pi.dev shard. */
export function configuredNativeProviders(config: PortConfig): readonly string[] {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  const spellings = [
    ...(config.allowedModels ?? [config.model]).map((model) => model.provider),
    ...(config.classifierModel === undefined ? [] : [config.classifierModel.provider]),
    ...Object.keys(config.credentials ?? {}),
  ];
  return [...new Set(spellings.map(nativeProviderId))].filter((id) => builtin.has(id)).sort();
}

function describe(outcome: RefreshOutcome): string {
  switch (outcome.status) {
    case "updated":
      return `updated (${outcome.models} models${outcome.skipped > 0 ? `, ${outcome.skipped} incompatible skipped` : ""}; ` +
        `not in bundled catalog: ${outcome.added.length === 0 ? "none" : outcome.added.join(", ")})`;
    case "unchanged": return "unchanged since last refresh";
    case "bundled-current": return "bundled catalog is current";
    case "not-published": return "no published catalog; bundled catalog kept";
    case "stale": return "refused older catalog; last-good kept";
    case "rejected": return `refused invalid catalog (${outcome.reason}); last-good kept`;
    case "failed": return `refresh failed (${outcome.reason}); last-good kept`;
    case "unknown-provider": return "not a native Pi AI provider; skipped";
    case "superseded": return "another refresh stored this provider meanwhile; kept it";
  }
}

export async function runModelsCommand(
  config: PortConfig,
  invocation: ModelsInvocation,
  terminal: ModelsTerminal,
): Promise<{ readonly ok: boolean }> {
  const prepared = await prepareDataDirectory(config);
  const providers = invocation.providers.length > 0
    ? [...new Set(invocation.providers.map(nativeProviderId))]
    : configuredNativeProviders(config);
  if (providers.length === 0) {
    terminal.output.write("No native providers to refresh; name one, for example `durable-nanobot models refresh openai`.\n");
    return { ok: true };
  }
  if (invocation.action === "refresh") {
    const outcomes = await refreshModelCatalog(prepared.canonicalDataDir, providers, {
      ...terminal.refresh,
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
    });
    for (const outcome of outcomes) terminal.output.write(`${outcome.provider}: ${describe(outcome)}\n`);
    terminal.output.write("Catalog changes apply at gateway restart or the next /reload that changes model config.\n");
    const ok = outcomes.every((outcome) => !["failed", "rejected", "unknown-provider"].includes(outcome.status));
    return { ok };
  }
  const loaded = await loadModelCatalog(prepared.canonicalDataDir);
  if (loaded.issue !== undefined) terminal.output.write(`Model catalog file is ${loaded.issue}; showing the bundled catalog.\n`);
  const allowed = new Set((config.allowedModels ?? [config.model]).map((model) =>
    modelKey({ provider: nativeProviderId(model.provider), modelId: model.modelId })));
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  let ok = true;
  for (const id of providers) {
    const provider = builtins.get(id);
    if (provider === undefined) {
      terminal.output.write(`${id}: not a native Pi AI provider\n`);
      ok = false;
      continue;
    }
    const refreshed = new Set((loaded.overlay.get(id) ?? []).map((model) => `${model.type ?? "chat"}\0${model.id}`));
    const merged = withCatalogOverlay(provider, loaded.overlay);
    for (const model of merged.getAllModels?.() ?? merged.getModels()) {
      const type = model.type ?? "chat";
      const source = refreshed.has(`${type}\0${model.id}`) ? "refreshed" : "bundled";
      const grant = type === "chat" && allowed.has(modelKey({ provider: id, modelId: model.id })) ? "  allowed" : "";
      terminal.output.write(`${id}/${model.id}  ${type}  ${source}${grant}\n`);
    }
  }
  return { ok };
}
