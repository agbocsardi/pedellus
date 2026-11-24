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
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isChordError } from "@earendil-works/chord";
import { processLock } from "@earendil-works/chord/node";
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
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Native IDs include forms such as `@cf/...` and `~vendor/...`: anything without whitespace/controls. */
const MODEL_ID = /^[^\s\p{Cc}]{1,256}$/u;
/** The model fields a catalog entry may carry. Anything else (for example sampling overrides) is dropped. */
const MODEL_FIELDS = new Set([
  "id", "name", "api", "provider", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens",
  "inputLimits", "type", "compat", "thinkingLevelMap", "promptCache", "headers", "output",
]);
const LOCK_POLL_MS = 50;
const LOCK_WAIT_MS = 10_000;
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
  /** Bundled entries by type and ID, for structured compatibility values. */
  readonly bundled: ReadonlyMap<string, AnyModel>;
}

/**
 * Compatibility values this pi-ai build ships, per key, across every bundled model. A catalog may
 * select a known boolean or one of these scalar values; it can never introduce a new string (such
 * as a request field name) or a structured value that the bundled same model does not carry.
 */
let knownCompatValues: ReadonlyMap<string, ReadonlySet<string>> | undefined;
function compatValues(): ReadonlyMap<string, ReadonlySet<string>> {
  if (knownCompatValues !== undefined) return knownCompatValues;
  const values = new Map<string, Set<string>>();
  for (const provider of builtinProviders()) {
    for (const model of provider.getAllModels?.() ?? provider.getModels()) {
      const compat = (model as { readonly compat?: unknown }).compat;
      if (!isRecord(compat)) continue;
      for (const [key, value] of Object.entries(compat)) {
        if (!values.has(key)) values.set(key, new Set());
        values.get(key)!.add(typeof value === "object" && value !== null ? "\0structured" : JSON.stringify(value));
      }
    }
  }
  knownCompatValues = values;
  return values;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Project compatibility overrides onto what this build ships. A known boolean and a known scalar
 * value are kept. A structured value (such as `allowedFallbackModels`, which names further request
 * models, or `chatTemplateArgs`) is kept only when it equals the bundled entry for the same model,
 * and is otherwise dropped, as is a key this build does not know (pi-ai ignores those anyway). An
 * unknown scalar value (for example a new thinking format) means this build cannot serve the
 * entry: `undefined`, and the entry is skipped.
 */
function projectCompat(compat: unknown, bundled: AnyModel | undefined): { readonly value?: Record<string, unknown> } | undefined {
  if (compat === undefined) return {};
  if (!isRecord(compat)) return undefined;
  const known = compatValues();
  const bundledCompat = (bundled as { readonly compat?: unknown } | undefined)?.compat;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(compat)) {
    const values = known.get(key);
    if (values === undefined) continue;
    if (typeof value === "object" && value !== null) {
      if (isRecord(bundledCompat) && stableJson(bundledCompat[key]) === stableJson(value)) projected[key] = value;
      continue;
    }
    if (typeof value === "boolean" && (values.has("true") || values.has("false"))) projected[key] = value;
    else if (values.has(JSON.stringify(value))) projected[key] = value;
    else return undefined;
  }
  return Object.keys(projected).length === 0 ? {} : { value: projected };
}

function compatibility(provider: Provider): Compatibility {
  const bundled: readonly AnyModel[] = provider.getAllModels?.() ?? provider.getModels();
  const apis = new Map<ModelType, Set<string>>();
  const baseUrls = new Set<string>();
  const headers: (Record<string, string> | undefined)[] = [];
  const byKey = new Map<string, AnyModel>();
  for (const model of bundled) {
    byKey.set(`${typeOf(model)}\0${model.id}`, model);
    const type = typeOf(model);
    if (!apis.has(type)) apis.set(type, new Set());
    apis.get(type)!.add(model.api);
    baseUrls.add(model.baseUrl);
    if (!headers.some((existing) => sameHeaders(model.headers, existing))) headers.push(model.headers);
  }
  return { apis, baseUrls, headers, bundled: byKey };
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
  for (const key of ["inputLimits", "promptCache", "compat"]) {
    if (raw[key] !== undefined && !isRecord(raw[key])) throw new CatalogRejected(`invalid ${key}`);
  }
  if (headers !== undefined && (!isRecord(headers) || !Object.values(headers).every((value) => typeof value === "string"))) {
    throw new CatalogRejected("invalid headers");
  }
  if (modelType === "chat") {
    if (typeof raw.reasoning !== "boolean" || !positiveInteger(raw.contextWindow) || !positiveInteger(raw.maxTokens)) {
      throw new CatalogRejected("invalid chat limits");
    }
    if (raw.thinkingLevelMap !== undefined && (!isRecord(raw.thinkingLevelMap)
      || !Object.values(raw.thinkingLevelMap).every((value) =>
        value === null || (typeof value === "string" && value.length <= 64)))) {
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
  const compatProjection = projectCompat(raw.compat, compat.bundled.get(`${modelType}\0${id}`));
  if (compatProjection === undefined) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (MODEL_FIELDS.has(key) && key !== "compat") projected[key] = value;
  if (compatProjection.value !== undefined) projected.compat = compatProjection.value;
  return { ...projected, provider: providerId } as unknown as AnyModel;
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
    // No symlink is followed and a FIFO cannot block the open; only a regular file is read.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new CatalogRejected("catalog file is a symlink");
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new CatalogRejected("catalog file is not a regular file");
    // Byte-counted, so a file that grows after the stat still cannot exceed the bound.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new CatalogRejected("catalog file is too large");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
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
  | { readonly provider: string; readonly status: "unknown-provider" }
  | { readonly provider: string; readonly status: "superseded" };

export interface RefreshOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Merged-file bound; defaults to the offline reader's limit so a write is always loadable. */
  readonly maxFileBytes?: number;
}

function sameEntry(left: CatalogEntry, right: CatalogEntry | undefined): boolean {
  return right !== undefined && left.lastModified === right.lastModified
    && left.checkedAt === right.checkedAt && left.etag === right.etag;
}

type Proposal =
  | { readonly kind: "replace"; readonly entry: CatalogEntry }
  | { readonly kind: "touch"; readonly basis: CatalogEntry; readonly checkedAt: number };

async function readEntries(path: string): Promise<Record<string, CatalogEntry>> {
  try {
    const text = await readFileBounded(path);
    return text === undefined ? {} : { ...parseFile(text).providers };
  } catch {
    // An unusable last-good file is replaced by validated shards; the gateway already treats
    // it as the bundled catalog.
    return {};
  }
}

/** Kernel-owned cross-process lock (no stale lock file), waited for within a fixed bound. */
async function withCatalogLock<T>(path: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let release: () => Promise<void>;
  for (;;) {
    signal?.throwIfAborted();
    try {
      release = await processLock(`nanobot-model-catalog:${path}`);
      break;
    } catch (error) {
      if (!isChordError(error) || error.reason !== "locked") throw error;
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("model catalog is busy");
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * Explicit network refresh of the named native providers. Each provider is fetched with no
 * credentials, cookies or redirects under its own deadline and size cap. A failed, stale or
 * invalid shard keeps that provider's last-good entry. Results are merged into the file under a
 * cross-process lock against what is on disk then, so a concurrent refresh never loses another
 * provider's entry and an older shard never replaces a newer one. Nothing changed, nothing written.
 */
export async function refreshModelCatalog(
  canonicalDataDir: string,
  providerIds: readonly string[],
  options: RefreshOptions = {},
): Promise<readonly RefreshOutcome[]> {
  const path = modelCatalogPath(canonicalDataDir);
  const snapshot = await readEntries(path);
  const builtins = builtinMap();
  const generatedAt = bundledGeneratedAt();
  const baseUrl = options.baseUrl ?? MODEL_CATALOG_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const results: { outcome: RefreshOutcome; readonly proposal?: Proposal }[] = [];
  for (const providerId of [...new Set(providerIds)]) {
    options.signal?.throwIfAborted();
    const provider = builtins.get(providerId);
    if (provider === undefined) {
      results.push({ outcome: { provider: providerId, status: "unknown-provider" } });
      continue;
    }
    const stored = snapshot[providerId];
    const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, baseUrl);
    url.searchParams.set("types", MODEL_TYPES.join(","));
    const deadline = AbortSignal.timeout(options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          accept: "application/json",
          "user-agent": "pedellus",
          ...(stored?.etag === undefined || stored.models.length === 0 ? {} : { "if-none-match": stored.etag }),
        },
        signal,
      });
      if (response.status === 304 && stored !== undefined) {
        results.push({
          outcome: { provider: providerId, status: "unchanged" },
          proposal: { kind: "touch", basis: stored, checkedAt: now() },
        });
      } else if (response.status === 404 || response.status === 501) {
        results.push({ outcome: { provider: providerId, status: "not-published" } });
      } else if (!response.ok) {
        results.push({ outcome: { provider: providerId, status: "failed", reason: `HTTP ${response.status}` } });
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
          results.push({ outcome: { provider: providerId, status: "stale" } });
        } else if (!(lastModified > generatedAt)) {
          results.push({ outcome: { provider: providerId, status: "bundled-current" } });
        } else {
          const etag = response.headers.get("etag") ?? undefined;
          const bundled = new Set((provider.getAllModels?.() ?? provider.getModels()).map((model) => `${typeOf(model)}\0${model.id}`));
          const added = models.filter((model) => !bundled.has(`${typeOf(model)}\0${model.id}`)).map((model) => model.id);
          results.push({
            outcome: { provider: providerId, status: "updated", models: models.length, skipped, added },
            proposal: {
              kind: "replace",
              entry: { models, lastModified, checkedAt: now(), ...(etag === undefined || !ETAG.test(etag) ? {} : { etag }) },
            },
          });
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      results.push({
        outcome: error instanceof CatalogRejected
          ? { provider: providerId, status: "rejected", reason: error.message }
          : { provider: providerId, status: "failed", reason: deadline.aborted ? "timed out" : "request failed" },
      });
    }
  }
  if (results.some((result) => result.proposal !== undefined)) {
    await withCatalogLock(path, options.signal, async () => {
      const current = await readEntries(path);
      let changed = false;
      for (const result of results) {
        const { proposal } = result;
        if (proposal === undefined) continue;
        const providerId = result.outcome.provider;
        const onDisk = current[providerId];
        if (proposal.kind === "replace") {
          // Another refresh stored this provider since our snapshot. A strictly older shard of ours
          // never wins, and an equal timestamp proves nothing (second precision): keep theirs.
          if (onDisk !== undefined && !sameEntry(onDisk, snapshot[providerId])
            && onDisk.lastModified >= proposal.entry.lastModified) {
            result.outcome = { provider: providerId, status: "superseded" };
            continue;
          }
          current[providerId] = proposal.entry;
          changed = true;
        } else if (onDisk !== undefined && onDisk.lastModified === proposal.basis.lastModified
          && onDisk.etag === proposal.basis.etag) {
          // Only the freshness time of the entry this 304 revalidated moves.
          current[providerId] = { ...onDisk, checkedAt: Math.max(onDisk.checkedAt, proposal.checkedAt) };
          changed = true;
        }
      }
      if (!changed) return;
      const contents = `${JSON.stringify({ version: FORMAT_VERSION, providers: current })}\n`;
      if (Buffer.byteLength(contents, "utf8") > (options.maxFileBytes ?? MAX_FILE_BYTES)) {
        // The offline reader would refuse this file: keep last-good and report nothing as updated.
        for (const result of results) {
          if (result.proposal !== undefined && result.outcome.status !== "superseded") {
            result.outcome = { provider: result.outcome.provider, status: "failed", reason: "catalog file would exceed its size limit" };
          }
        }
        return;
      }
      await writeAtomic(path, contents);
    });
  }
  return results.map((result) => result.outcome);
}
