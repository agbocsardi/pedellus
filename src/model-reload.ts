/**
 * Host-owned live reload of foreground model selection and provider credential references.
 *
 * A reload re-reads and validates the whole configuration file, but applies only the fields this
 * module classifies as reloadable: the default model (`model` or `modelPreset`), the finite model
 * allowlist, the named preset catalog (`modelPresets`), direct-mode `thinkingLevel`, and
 * `credentials`. Background model captures (digest, workers, episode summaries, vision handoff,
 * classifier), tools, channels, workspace context and MCP authority are startup-only: a candidate
 * that changes any of them is refused as unrelated instead of partially applied.
 *
 * The contract is deliberately narrow, because a reload rotates provider credentials and a model
 * catalog under whatever work is already admitted:
 *
 * - No live work at all may exist except an armed native cron timer, which cannot run before its
 *   deadline and holds no model capture. A sleeping or blocked task can resume later, so its
 *   captured model and the credential that served it must not change underneath it; the reload is
 *   refused instead. Work admitted after the commit uses the newly published registry and
 *   credentials.
 * - Switching between direct-model and named-preset mode is a restart-required change. Host
 *   surfaces cache that capability once (the local CLI decides whether `/model <preset>` exists at
 *   attach), and this reload cannot republish it, so a transition is refused rather than leaving a
 *   stale surface.
 * - Managed MCP edits are one narrow exception to the startup-only rule: they update the live MCP
 *   block in the same process and rewrite the same file, so they must not make every later model
 *   reload look unrelated. The comparison therefore uses the current effective MCP block, and any
 *   other MCP change — including a hand edit — stays unrelated and needs `/restart`.
 */

import type { PortConfig } from "./config.js";

/** One reload outcome a host surface renders; no configured value or credential is carried. */
export type ModelReloadResult =
  | {
    readonly status: "reloaded" | "unchanged";
    /** Provider/model pairs in the finite allowlist. */
    readonly models: number;
    /** Named presets, 0 in legacy direct-model mode. */
    readonly presets: number;
    readonly defaultPreset?: string;
  }
  | { readonly status: "busy" }
  | {
    readonly status: "refused";
    readonly reason: "unavailable" | "invalid" | "mode" | "unrelated" | "pinned";
  };

/** How a candidate file relates to the live configuration. */
export type ModelReloadCompatibility = "unchanged" | "reloadable" | "mode" | "unrelated" | "pinned";

/**
 * Startup-only configuration fields whose live captures would otherwise drift from the file.
 * A preset named by one of these references must keep its full entry: a background strategy was
 * resolved once at open and is deliberately not reconstructed by a foreground reload.
 */
function pinnedPresetNames(config: PortConfig): readonly string[] {
  const names = new Set<string>();
  if (config.digest?.preset !== undefined) names.add(config.digest.preset);
  if (config.workers?.preset !== undefined) names.add(config.workers.preset);
  if (config.episodeSummary?.preset !== undefined) names.add(config.episodeSummary.preset);
  if (config.visionHandoff?.describerPreset !== undefined) names.add(config.visionHandoff.describerPreset);
  return [...names];
}

/**
 * Deterministic key order, so two parsed configurations compare by content rather than insertion
 * order. An absent key and a key set to `undefined` compare equal, as they do in the JSON file.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * The configuration with every reloadable field removed. `modelPresets` is reloadable as a whole
 * catalog: with vision handoff configured its entries are additionally pinned below, because the
 * flagged-model set and describer were installed at open.
 */
function startupOnly(config: PortConfig): unknown {
  const copy: Record<string, unknown> = { ...config };
  for (const key of ["model", "allowedModels", "thinkingLevel", "modelPreset", "modelPresets", "credentials"]) {
    delete copy[key];
  }
  return copy;
}

/** The fields a reload may change. Preset names and thinking levels are part of the live catalog. */
function reloadable(config: PortConfig): unknown {
  return {
    model: config.model,
    allowedModels: config.allowedModels,
    thinkingLevel: config.thinkingLevel,
    modelPreset: config.modelPreset,
    credentials: config.credentials,
    modelPresets: config.modelPresets === undefined
      ? undefined
      : Object.fromEntries(Object.entries(config.modelPresets).map(([name, preset]) => [
        name,
        {
          provider: preset.provider,
          modelId: preset.modelId,
          thinkingLevel: preset.thinkingLevel,
        },
      ])),
  };
}

/**
 * Classify a fully parsed candidate against the live configuration.
 *
 * `unrelated` means a startup-only field changed and nothing may be applied. `mode` means the
 * candidate switches between direct-model and named-preset mode, which a host surface caches and
 * only a restart republishes. `pinned` means a preset still owned by a background capture changed.
 * `unchanged` means applying it would be a no-op, including a file rewritten with identical model
 * configuration.
 */
export function modelReloadCompatibility(live: PortConfig, candidate: PortConfig): ModelReloadCompatibility {
  if (canonical(startupOnly(live)) !== canonical(startupOnly(candidate))) return "unrelated";
  if ((live.modelPreset === undefined) !== (candidate.modelPreset === undefined)) return "mode";
  // With vision handoff installed, every preset contributes to the process-lifetime flagged-model
  // set and describer choice. Rebuilding that hook is outside this reload, so the whole catalog is
  // pinned for as long as the feature is configured.
  if (live.visionHandoff !== undefined && canonical(live.modelPresets) !== canonical(candidate.modelPresets)) {
    return "pinned";
  }
  for (const name of pinnedPresetNames(live)) {
    const before = live.modelPresets?.[name];
    const after = candidate.modelPresets?.[name];
    if (canonical(before) !== canonical(after)) return "pinned";
  }
  return canonical(reloadable(live)) === canonical(reloadable(candidate)) ? "unchanged" : "reloadable";
}

const RELOADED_PREFIX = "Model configuration reloaded";
const BACKGROUND_UNCHANGED =
  "Background model captures (digest, workers, episode summaries, vision handoff, classifier), tools, " +
  "channels, workspace context and MCP authority are unchanged.";

/** One bounded host notice for a reload outcome. It never contains a credential or environment value. */
export function renderModelReloadNotice(result: ModelReloadResult): string {
  switch (result.status) {
    case "reloaded": {
      const name = result.defaultPreset === undefined
        ? ""
        : result.defaultPreset.length <= 80 ? result.defaultPreset : `${result.defaultPreset.slice(0, 80)}…`;
      const defaultPreset = name === "" ? "" : `; default preset ${name}`;
      const presetCount = result.presets === 0 ? "direct model selection" : `${result.presets} preset${result.presets === 1 ? "" : "s"}`;
      const selectionRule = result.presets === 0
        ? "Direct-mode chats keep a still-allowed selection; a removed model resets to the new configured default."
        : "Named-preset chats reset to the new configured default.";
      return `${RELOADED_PREFIX}: ${result.models} allowed model${result.models === 1 ? "" : "s"}, ${presetCount}${defaultPreset}. ` +
        `${BACKGROUND_UNCHANGED} ${selectionRule} New work uses the reloaded catalog and credential references.`;
    }
    case "unchanged":
      return "Model configuration is unchanged: the file matches the live model catalog and credential references, so nothing was applied.";
    case "busy":
      return "Model reload refused: live work is active or queued, so nothing was changed. A reload also refuses sleeping or " +
        "blocked background work, because resuming it under a rotated credential or catalog would silently change its authority. " +
        "Wait for it to finish (see /status) or cancel it through its existing controls, then retry /reload.";
    case "refused":
      switch (result.reason) {
        case "unavailable":
          return "Model reload is not available on this host; nothing was changed.";
        case "invalid":
          return "Model reload refused: the configuration file could not be loaded and validated, so nothing was applied. " +
            "Fix the file on the host and retry. Credential values are never read into a chat.";
        case "mode":
          return "Model reload refused: switching between a direct model and named presets is restart-required, because " +
            "each attached terminal caches that capability. Nothing was applied; change models or presets within the " +
            "current mode, or use /restart for the mode change.";
        case "unrelated":
          return "Model reload refused: the file changed beyond model presets, model selection and credential references, " +
            "so nothing was applied. Use /restart to apply tools, channels, workspace context, MCP or other startup configuration.";
        case "pinned":
          return "Model reload refused: a preset is still pinned by background model configuration or vision handoff, " +
            "or a model still used by prepared or background work would leave the allowlist. Nothing was applied; " +
            "finish that work or keep the preset entry unchanged, then retry /reload.";
      }
  }
}
