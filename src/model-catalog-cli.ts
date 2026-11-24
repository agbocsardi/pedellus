/**
 * Terminal `models refresh|list`. Refresh is the only network path for the model catalog; list is
 * offline. Neither opens the gateway, reads a credential, changes configuration or grants a model.
 * List reads the overlay without preparing the data directory, and without a configuration it shows
 * the bundled catalog only, so it works before setup and creates nothing.
 */
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { PortConfig } from "./config.js";
import { modelKey } from "./config.js";
import {
  loadModelCatalog,
  refreshModelCatalog,
  withCatalogOverlay,
  type LoadedCatalog,
  type RefreshOptions,
  type RefreshOutcome,
} from "./model-catalog.js";
import { nativeProviderId } from "./providers.js";
import { prepareDataDirectory, validateDataDirectoryReadOnly } from "./store.js";

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

/** Bundled native provider IDs with their chat model counts, for a listing with no configuration. */
function writeProviderSummary(terminal: ModelsTerminal): void {
  const providers = [...builtinProviders()].sort((a, b) => a.id.localeCompare(b.id));
  const width = Math.max(...providers.map((provider) => provider.id.length));
  for (const provider of providers) {
    const chat = (provider.getAllModels?.() ?? provider.getModels()).filter((model) => (model.type ?? "chat") === "chat");
    terminal.output.write(`${provider.id.padEnd(width)}  ${chat.length} chat models\n`);
  }
  terminal.output.write("Run `pedellus models list <provider>` to see models for one provider.\n");
}

/**
 * Run one models command. `config` is undefined only for a `list` with no configuration file:
 * that listing uses the bundled catalog, with no overlay and no `allowed` markers.
 */
export async function runModelsCommand(
  config: PortConfig | undefined,
  invocation: ModelsInvocation,
  terminal: ModelsTerminal,
): Promise<{ readonly ok: boolean }> {
  if (config === undefined && invocation.action === "refresh") throw new Error("models refresh requires a configuration");
  if (config === undefined && invocation.providers.length === 0) {
    writeProviderSummary(terminal);
    return { ok: true };
  }
  if (invocation.action === "refresh") {
    const prepared = await prepareDataDirectory(config!);
    const providers = invocation.providers.length > 0
      ? [...new Set(invocation.providers.map(nativeProviderId))]
      : configuredNativeProviders(config!);
    if (providers.length === 0) {
      terminal.output.write("No native providers to refresh; name one, for example `pedellus models refresh openai`.\n");
      return { ok: true };
    }
    const outcomes = await refreshModelCatalog(prepared.canonicalDataDir, providers, {
      ...terminal.refresh,
      ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
    });
    for (const outcome of outcomes) terminal.output.write(`${outcome.provider}: ${describe(outcome)}\n`);
    terminal.output.write("Catalog changes apply at gateway restart or the next /reload that changes model config.\n");
    const ok = outcomes.every((outcome) => !["failed", "rejected", "unknown-provider"].includes(outcome.status));
    return { ok };
  }
  const providers = invocation.providers.length > 0
    ? [...new Set(invocation.providers.map(nativeProviderId))]
    : configuredNativeProviders(config!);
  if (providers.length === 0) {
    terminal.output.write("No native providers to refresh; name one, for example `pedellus models refresh openai`.\n");
    return { ok: true };
  }
  // Read-only: validate dataDir disjointness without creating or chmod-ing directories.
  const loaded: LoadedCatalog = config === undefined
    ? { overlay: new Map() }
    : await loadModelCatalog(await validateDataDirectoryReadOnly(config));
  if (loaded.issue !== undefined) terminal.output.write(`Model catalog file is ${loaded.issue}; showing the bundled catalog.\n`);
  const allowed = new Set((config === undefined ? [] : config.allowedModels ?? [config.model]).map((model) =>
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
