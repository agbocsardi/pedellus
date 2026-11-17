/**
 * Pi-style model catalog updates, independent of the pinned pi-ai package.
 *
 * Mechanism (ported from Pi coding-agent's `remote-catalog-provider`): one public per-provider
 * shard at `https://pi.dev/api/models/providers/<id>?types=chat,image,classifier`, accepted only
 * when its `Last-Modified` is newer than pi-ai's bundled model data, revalidated with its ETag,
 * and overlaid on the bundled catalog by model type and id.
 *
 * Unlike Pi, nothing here runs at startup or from a chat turn: only the explicit terminal
 * `models refresh` command touches the network, and it writes one validated last-good file under
 * the canonical data directory. Gateway open and `/reload` read that file offline. A missing,
 * unreadable, invalid or package-stale file is the bundled catalog. The overlay only makes model
 * metadata resolvable; configured `allowedModels`/presets remain the only model authority.
 */
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AnyModel, ModelType, Provider } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

export const MODEL_CATALOG_BASE_URL = "https://pi.dev";
export const MODEL_CATALOG_FILE = "model-catalog.json";
const FORMAT_VERSION = 1;
const MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];
/** Per-provider request deadline (headers and body). Pi uses 4 s per attempt with retries. */
export const MODEL_CATALOG_TIMEOUT_MS = 10_000;
/** Response body cap. Current shards are a few KiB; the largest are well under 1 MiB. */
export const MODEL_CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER = 2_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Visible ASCII only, so a stored validator can always be echoed as a request header. */
const ETAG = /^[\x21-\x7e]{1,200}$/;

export interface CatalogEntry {
  readonly models: readonly AnyModel[];
  /** Shard `Last-Modified`, epoch milliseconds. Always newer than the bundled data when stored. */
  readonly lastModified: number;
  readonly checkedAt: number;
  readonly etag?: string;
}

interface CatalogFile {
  readonly version: typeof FORMAT_VERSION;
  readonly providers: Readonly<Record<string, CatalogEntry>>;
}

/** Validated overlay keyed by native provider ID. Empty means the bundled catalog. */
export type CatalogOverlay = ReadonlyMap<string, readonly AnyModel[]>;

export interface LoadedCatalog {
  readonly overlay: CatalogOverlay;
  /** Set when a present file could not be used; the bundled catalog is used instead. */
  readonly issue?: "unreadable" | "invalid";
}

class CatalogRejected extends Error {
  override name = "CatalogRejected";
}

function builtinMap(): ReadonlyMap<string, Provider> {
  return new Map(builtinProviders().map((provider) => [provider.id, provider]));
}

function bundledGeneratedAt(): number {
  // Without a bundled timestamp no remote shard can be proven newer; Pi would accept any.
  // Durable is stricter: nothing is overlaid.
  return getBuiltinModelDataGeneratedAt() ?? Number.POSITIVE_INFINITY;
}

function typeOf(model: { readonly type?: unknown }): ModelType {
  return (model.type ?? "chat") as ModelType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameHeaders(left: unknown, right: Record<string, string> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!isRecord(left)) return false;
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && left[key] === right[key]);
}

/** What the installed pi-ai build can actually dispatch for one provider. */
interface Compatibility {
  readonly apis: ReadonlyMap<ModelType, ReadonlySet<string>>;
  readonly baseUrls: ReadonlySet<string>;
  readonly headers: readonly (Record<string, string> | undefined)[];
}

function compatibility(provider: Provider): Compatibility {
  const bundled: readonly AnyModel[] = provider.getAllModels?.() ?? provider.getModels();
  const apis = new Map<ModelType, Set<string>>();
  const baseUrls = new Set<string>();
  const headers: (Record<string, string> | undefined)[] = [];
  for (const model of bundled) {
    const type = typeOf(model);
    if (!apis.has(type)) apis.set(type, new Set());
    apis.get(type)!.add(model.api);
    baseUrls.add(model.baseUrl);
    if (!headers.some((existing) => sameHeaders(model.headers, existing))) headers.push(model.headers);
  }
  return { apis, baseUrls, headers };
}

/**
 * Shape check for one entry. A malformed entry rejects its whole shard. A well-formed entry this
 * build cannot use safely — unknown type or API, or a base URL/header set the bundled provider
 * never sends credentials to — is skipped, so a catalog can never redirect a credential.
 */
function checkModel(providerId: string, raw: unknown, compat: Compatibility): AnyModel | undefined {
  if (!isRecord(raw)) throw new CatalogRejected("entry is not an object");
  const { id, name, api, baseUrl, input, cost, provider, type, headers } = raw;
  if (typeof id !== "string" || !MODEL_ID.test(id)) throw new CatalogRejected("invalid model id");
  if (type !== undefined && typeof type !== "string") throw new CatalogRejected("invalid type");
  const modelType = (type ?? "chat") as string;
  // A type this build does not know is skipped before its shape is checked, as Pi filters types.
  if (!(MODEL_TYPES as readonly string[]).includes(modelType)) return undefined;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) throw new CatalogRejected("invalid name");
  if (typeof api !== "string" || api.length === 0 || api.length > 100) throw new CatalogRejected("invalid api");
  if (typeof baseUrl !== "string" || baseUrl.length > 2_000) throw new CatalogRejected("invalid baseUrl");
  if (provider !== undefined && provider !== providerId) throw new CatalogRejected("provider mismatch");
  if (!Array.isArray(input) || !input.every((value) => value === "text" || value === "image")) {
    throw new CatalogRejected("invalid input");
  }
  if (!isRecord(cost) || !["input", "output", "cacheRead", "cacheWrite"].every((key) =>
    typeof cost[key] === "number" && Number.isFinite(cost[key]) && (cost[key] as number) >= 0)) {
    throw new CatalogRejected("invalid cost");
  }
  if (headers !== undefined && (!isRecord(headers) || !Object.values(headers).every((value) => typeof value === "string"))) {
    throw new CatalogRejected("invalid headers");
  }
  if (modelType === "chat") {
    if (typeof raw.reasoning !== "boolean" || !positiveInteger(raw.contextWindow) || !positiveInteger(raw.maxTokens)) {
      throw new CatalogRejected("invalid chat limits");
    }
    if (raw.thinkingLevelMap !== undefined && (!isRecord(raw.thinkingLevelMap)
      || !Object.values(raw.thinkingLevelMap).every((value) => value === null || typeof value === "string"))) {
      throw new CatalogRejected("invalid thinkingLevelMap");
    }
  } else if (modelType === "classifier") {
    if (!positiveInteger(raw.contextWindow)) throw new CatalogRejected("invalid classifier limits");
  } else if (modelType === "image") {
    if (!Array.isArray(raw.output)) throw new CatalogRejected("invalid image output");
  }
  if (!compat.apis.get(modelType as ModelType)?.has(api)) return undefined;
  if (!compat.baseUrls.has(baseUrl)) return undefined;
  if (!compat.headers.some((allowed) => sameHeaders(headers, allowed))) return undefined;
  return { ...raw, provider: providerId } as unknown as AnyModel;
}

/** Validate a whole shard. Duplicates, non-array bodies and oversized lists reject it. */
export function validateShard(
  provider: Provider,
  body: unknown,
): { readonly models: readonly AnyModel[]; readonly skipped: number } {
  if (!Array.isArray(body)) throw new CatalogRejected("catalog body is not an array");
  if (body.length > MAX_MODELS_PER_PROVIDER) throw new CatalogRejected("catalog has too many models");
  const compat = compatibility(provider);
  const seen = new Set<string>();
  const models: AnyModel[] = [];
  let skipped = 0;
  for (const raw of body) {
    const model = checkModel(provider.id, raw, compat);
    const key = isRecord(raw) ? `${String(raw.type ?? "chat")}\0${String(raw.id)}` : "";
    if (seen.has(key)) throw new CatalogRejected("duplicate model");
    seen.add(key);
    if (model === undefined) skipped += 1;
    else models.push(model);
  }
  return { models, skipped };
}

function parseFile(text: string): CatalogFile {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== FORMAT_VERSION || !isRecord(value.providers)) {
    throw new CatalogRejected("unsupported catalog file");
  }
  const providers: Record<string, CatalogEntry> = {};
  for (const [id, entry] of Object.entries(value.providers)) {
    if (!PROVIDER_ID.test(id) || !isRecord(entry) || !Array.isArray(entry.models)
      || typeof entry.lastModified !== "number" || !Number.isFinite(entry.lastModified)
      || typeof entry.checkedAt !== "number" || !Number.isFinite(entry.checkedAt)
      || (entry.etag !== undefined && (typeof entry.etag !== "string" || !ETAG.test(entry.etag)))) {
      throw new CatalogRejected("invalid catalog entry");
    }
    providers[id] = {
      models: entry.models as AnyModel[],
      lastModified: entry.lastModified,
      checkedAt: entry.checkedAt,
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    };
  }
  return { version: FORMAT_VERSION, providers };
}

async function readFileBounded(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new CatalogRejected("catalog file is not a bounded regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function modelCatalogPath(canonicalDataDir: string): string {
  return join(canonicalDataDir, MODEL_CATALOG_FILE);
}

/**
 * Offline read of the last-good catalog. Every stored shard is re-validated against the installed
 * pi-ai build, and a shard not newer than its bundled data (for example after a package upgrade)
 * is ignored, exactly as Pi does. Never throws for file content; never touches the network.
 */
export async function loadModelCatalog(canonicalDataDir: string): Promise<LoadedCatalog> {
  let text: string | undefined;
  try {
    text = await readFileBounded(modelCatalogPath(canonicalDataDir));
  } catch (error) {
    return { overlay: new Map(), issue: error instanceof CatalogRejected ? "invalid" : "unreadable" };
  }
  if (text === undefined) return { overlay: new Map() };
  let file: CatalogFile;
  try {
    file = parseFile(text);
  } catch {
    return { overlay: new Map(), issue: "invalid" };
  }
  const builtins = builtinMap();
  const generatedAt = bundledGeneratedAt();
  const overlay = new Map<string, readonly AnyModel[]>();
  try {
    for (const [id, entry] of Object.entries(file.providers)) {
      const provider = builtins.get(id);
      if (provider === undefined || !(entry.lastModified > generatedAt)) continue;
      const { models } = validateShard(provider, entry.models);
      if (models.length > 0) overlay.set(id, models);
    }
  } catch {
    return { overlay: new Map(), issue: "invalid" };
  }
  return { overlay };
}

/** Bundled models with the overlay replacing same type+id entries, as Pi merges. */
export function withCatalogOverlay(provider: Provider, overlay: CatalogOverlay | undefined): Provider {
  const dynamic = overlay?.get(provider.id);
  if (dynamic === undefined || dynamic.length === 0) return provider;
  const merged = new Map<string, AnyModel>();
  for (const model of [...(provider.getAllModels?.() ?? provider.getModels()), ...dynamic]) {
    merged.set(`${typeOf(model)}\0${model.id}`, model);
  }
  const all = Object.freeze([...merged.values()]);
  const chat = Object.freeze(all.filter((model) => typeOf(model) === "chat"));
  return {
    ...provider,
    getModels: () => chat as never,
    getAllModels: () => all as never,
  };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readBodyBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new CatalogRejected("catalog response too large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new CatalogRejected("catalog response too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type RefreshOutcome =
  | { readonly provider: string; readonly status: "updated"; readonly models: number; readonly skipped: number; readonly added: readonly string[] }
  | { readonly provider: string; readonly status: "unchanged" }
  | { readonly provider: string; readonly status: "bundled-current" }
  | { readonly provider: string; readonly status: "not-published" }
  | { readonly provider: string; readonly status: "stale" }
  | { readonly provider: string; readonly status: "rejected"; readonly reason: string }
  | { readonly provider: string; readonly status: "failed"; readonly reason: string }
  | { readonly provider: string; readonly status: "unknown-provider" };

export interface RefreshOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

/**
 * Explicit network refresh of the named native providers. Each provider is fetched with no
 * credentials, cookies or redirects under its own deadline and size cap. A failed, stale or
 * invalid shard keeps that provider's last-good entry. The file is rewritten atomically once,
 * only when some entry changed; a run where every request fails writes nothing.
 */
export async function refreshModelCatalog(
  canonicalDataDir: string,
  providerIds: readonly string[],
  options: RefreshOptions = {},
): Promise<readonly RefreshOutcome[]> {
  const path = modelCatalogPath(canonicalDataDir);
  let current: Record<string, CatalogEntry> = {};
  try {
    const text = await readFileBounded(path);
    if (text !== undefined) current = { ...parseFile(text).providers };
  } catch {
    // An unusable last-good file is replaced by this run's validated shards; the gateway
    // already treats it as the bundled catalog.
    current = {};
  }
  const builtins = builtinMap();
  const generatedAt = bundledGeneratedAt();
  const baseUrl = options.baseUrl ?? MODEL_CATALOG_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const outcomes: RefreshOutcome[] = [];
  let changed = false;
  for (const providerId of [...new Set(providerIds)]) {
    options.signal?.throwIfAborted();
    const provider = builtins.get(providerId);
    if (provider === undefined) {
      outcomes.push({ provider: providerId, status: "unknown-provider" });
      continue;
    }
    const stored = current[providerId];
    const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, baseUrl);
    url.searchParams.set("types", MODEL_TYPES.join(","));
    const deadline = AbortSignal.timeout(options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
    let outcome: RefreshOutcome;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          accept: "application/json",
          "user-agent": "durable-nanobot",
          ...(stored?.etag === undefined || stored.models.length === 0 ? {} : { "if-none-match": stored.etag }),
        },
        signal,
      });
      if (response.status === 304 && stored !== undefined) {
        current[providerId] = { ...stored, checkedAt: now() };
        changed = true;
        outcome = { provider: providerId, status: "unchanged" };
      } else if (response.status === 404 || response.status === 501) {
        outcome = { provider: providerId, status: "not-published" };
      } else if (!response.ok) {
        outcome = { provider: providerId, status: "failed", reason: `HTTP ${response.status}` };
      } else {
        const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
        const text = await readBodyBounded(response, options.maxBodyBytes ?? MODEL_CATALOG_MAX_BODY_BYTES);
        if (Number.isNaN(lastModified)) throw new CatalogRejected("missing Last-Modified");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new CatalogRejected("response is not JSON");
        }
        const { models, skipped } = validateShard(provider, body);
        if (stored !== undefined && lastModified < stored.lastModified) {
          outcome = { provider: providerId, status: "stale" };
        } else if (!(lastModified > generatedAt)) {
          outcome = { provider: providerId, status: "bundled-current" };
        } else {
          const etag = response.headers.get("etag") ?? undefined;
          current[providerId] = {
            models,
            lastModified,
            checkedAt: now(),
            ...(etag === undefined || !ETAG.test(etag) ? {} : { etag }),
          };
          changed = true;
          const bundled = new Set((provider.getAllModels?.() ?? provider.getModels()).map((model) => `${typeOf(model)}\0${model.id}`));
          const added = models.filter((model) => !bundled.has(`${typeOf(model)}\0${model.id}`)).map((model) => model.id);
          outcome = { provider: providerId, status: "updated", models: models.length, skipped, added };
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      outcome = error instanceof CatalogRejected
        ? { provider: providerId, status: "rejected", reason: error.message }
        : { provider: providerId, status: "failed", reason: deadline.aborted ? "timed out" : "request failed" };
    }
    outcomes.push(outcome);
  }
  if (changed) {
    const file: CatalogFile = { version: FORMAT_VERSION, providers: current };
    await writeAtomic(path, `${JSON.stringify(file)}\n`);
  }
  return outcomes;
}
