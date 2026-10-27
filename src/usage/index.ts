import type { Context } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import {
  UsageDoc,
  type ConversationId,
  type DocumentReader,
  type UsageState,
} from "@earendil-works/pi-durable";

export type UsageSourceIdentity = Readonly<{
  /** Stable, host-owned namespace unique to this independently initialized store. */
  storeNamespace: string;
  conversationId: ConversationId;
}>;

export type UsageSourceScope = Readonly<UsageSourceIdentity & {
  kind: "pi-durable-conversation";
}>;

export type UsageSnapshot = Readonly<{
  source: UsageSourceScope;
  /** Missing is not an empty/zero ledger. */
  status: "available" | "unavailable";
  /** The native ledger contains committed Usage values only, not a request/event log. */
  accounting: "committed-native-usage-only";
  models: Readonly<Record<string, Readonly<Usage>>>;
  tools: Readonly<Record<string, Readonly<Usage>>>;
}>;

export type UsageArchiveCursor = Readonly<{
  version: 1;
  source: UsageSourceScope;
  /** Cumulative native state observed when the associated archive transaction committed. */
  cumulative: UsageSnapshot;
}>;

export type UsageUnknownField = Readonly<{
  bucket: "models" | "tools";
  key: string;
  field: "cacheWrite1h" | "reasoning";
}>;

export type NativeUsageDelta = Readonly<{
  models: Readonly<Record<string, Readonly<Usage>>>;
  tools: Readonly<Record<string, Readonly<Usage>>>;
}>;

export type LegacyModelUsage = Readonly<{
  provider: string;
  model: string;
  /** Exact native `provider/modelId` key, retained when its split is ambiguous. */
  provider_model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}>;

/** Python-history-compatible token fields. Request counts are deliberately absent. */
export type LegacyUsageDelta = Readonly<{
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  by_model?: Readonly<Record<string, LegacyModelUsage>>;
}>;

export type UsageArchiveProjection = Readonly<{
  source: UsageSourceScope;
  accounting: "committed-native-usage-only";
  /** False means no cumulative counters changed; unknown transitions can still require review. */
  hasDelta: boolean;
  /** Compatible model-token projection; tool usage and native costs remain in `native`. */
  legacy: LegacyUsageDelta;
  /** Native bucket/model totals as recorded; nested duplication lacks call provenance. */
  native: NativeUsageDelta;
  /** Durable does not expose a request counter in UsageState. */
  requestCount: Readonly<{ status: "unknown" }>;
  /** Optional native counters that cannot be safely apportioned across this cursor interval. */
  unknownFields: readonly UsageUnknownField[];
  /** Candidate only. The caller must persist it with the archive transaction. */
  nextCursor: UsageArchiveCursor;
}>;

const ACCOUNTING = "committed-native-usage-only" as const;
const REQUIRED_USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
] as const;
const OPTIONAL_USAGE_FIELDS = ["cacheWrite1h", "reasoning"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function objectRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegativeCost(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid native usage cost: ${field}`);
  }
  return value;
}

function safeTokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid native token count: ${field}`);
  }
  return value;
}

function addTokenCounts(left: number, right: number, field: string): number {
  return safeTokenCount(left + right, field);
}

function copyUsage(value: unknown, label: string): Readonly<Usage> {
  if (!isObject(value) || !isObject(value.cost)) {
    throw new TypeError(`Invalid native usage row: ${label}`);
  }
  const cost: Usage["cost"] = {
    input: finiteNonNegativeCost(value.cost.input, `${label}.cost.input`),
    output: finiteNonNegativeCost(value.cost.output, `${label}.cost.output`),
    cacheRead: finiteNonNegativeCost(value.cost.cacheRead, `${label}.cost.cacheRead`),
    cacheWrite: finiteNonNegativeCost(value.cost.cacheWrite, `${label}.cost.cacheWrite`),
    total: finiteNonNegativeCost(value.cost.total, `${label}.cost.total`),
  };
  const input = safeTokenCount(value.input, `${label}.input`);
  const output = safeTokenCount(value.output, `${label}.output`);
  const cacheRead = safeTokenCount(value.cacheRead, `${label}.cacheRead`);
  const cacheWrite = safeTokenCount(value.cacheWrite, `${label}.cacheWrite`);
  safeTokenCount(input + cacheRead + cacheWrite, `${label}.prompt_tokens`);
  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: safeTokenCount(value.totalTokens, `${label}.totalTokens`),
    cost: Object.freeze(cost),
  };
  for (const field of OPTIONAL_USAGE_FIELDS) {
    if (value[field] !== undefined) {
      usage[field] = safeTokenCount(value[field], `${label}.${field}`);
    }
  }
  return Object.freeze(usage);
}

function copyBucket(value: unknown, bucket: "models" | "tools"): Readonly<Record<string, Readonly<Usage>>> {
  if (!isObject(value)) throw new TypeError(`Invalid native usage bucket: ${bucket}`);
  const result = objectRecord<Readonly<Usage>>();
  for (const key of Object.keys(value)) {
    setOwn(result, key, copyUsage(value[key], `${bucket}.${key}`));
  }
  return Object.freeze(result);
}

function conversationId(value: unknown): ConversationId {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Invalid Durable conversation ID in usage scope");
  }
  return value as ConversationId;
}

function makeSource(namespace: unknown, id: unknown): UsageSourceScope {
  if (typeof namespace !== "string" || namespace.trim().length === 0 || namespace.length > 512) {
    throw new TypeError("Invalid host-supplied usage store namespace");
  }
  return Object.freeze({
    kind: "pi-durable-conversation",
    storeNamespace: namespace,
    conversationId: conversationId(id),
  });
}

function sameSource(left: UsageSourceScope, right: UsageSourceScope): boolean {
  return left.kind === right.kind && left.storeNamespace === right.storeNamespace &&
    left.conversationId === right.conversationId;
}

/** Copy and freeze one native document value; absent documents stay explicitly unavailable. */
export function snapshotUsageState(
  storeNamespace: string,
  id: ConversationId,
  state: Readonly<UsageState> | undefined,
): UsageSnapshot {
  const source = makeSource(storeNamespace, id);
  if (state === undefined) {
    return Object.freeze({
      source,
      status: "unavailable",
      accounting: ACCOUNTING,
      models: Object.freeze(objectRecord<Readonly<Usage>>()),
      tools: Object.freeze(objectRecord<Readonly<Usage>>()),
    });
  }
  if (!isObject(state)) throw new TypeError("Invalid native pi.usage document");
  return Object.freeze({
    source,
    status: "available",
    accounting: ACCOUNTING,
    models: copyBucket(state.models, "models"),
    tools: copyBucket(state.tools, "tools"),
  });
}

/** Read only the native conversation UsageDoc; this helper never creates or mutates a document. */
export async function readUsageSnapshot(
  reader: Pick<DocumentReader, "snapshot">,
  storeNamespace: string,
  id: ConversationId,
  context: Context,
): Promise<UsageSnapshot> {
  return snapshotUsageState(storeNamespace, id, await reader.snapshot(UsageDoc, id, context));
}

function normalizeSnapshot(value: unknown): UsageSnapshot {
  if (!isObject(value) || value.accounting !== ACCOUNTING) {
    throw new TypeError("Invalid usage snapshot");
  }
  const source = parseSource(value.source);
  if (value.status === "unavailable") {
    return snapshotUsageState(source.storeNamespace, source.conversationId, undefined);
  }
  if (value.status !== "available") throw new TypeError("Invalid usage snapshot status");
  return snapshotUsageState(source.storeNamespace, source.conversationId, {
    models: value.models as UsageState["models"],
    tools: value.tools as UsageState["tools"],
  });
}

function parseSource(value: unknown): UsageSourceScope {
  if (!isObject(value) || value.kind !== "pi-durable-conversation") {
    throw new TypeError("Invalid usage source scope");
  }
  return makeSource(value.storeNamespace, value.conversationId);
}

function makeCursor(snapshot: UsageSnapshot): UsageArchiveCursor {
  if (snapshot.status !== "available") {
    throw new Error("Cannot propose an archive cursor from an unavailable native usage document");
  }
  return Object.freeze({ version: 1, source: snapshot.source, cumulative: snapshot });
}

/**
 * Validate cursor shape and source scope only; callers must load trusted
 * host-owned durable cursor state.
 */
export function parseUsageArchiveCursor(
  value: unknown,
  expectedScope: UsageSourceIdentity,
): UsageArchiveCursor {
  if (!isObject(value) || value.version !== 1) throw new TypeError("Invalid usage archive cursor version");
  const expected = makeSource(expectedScope.storeNamespace, expectedScope.conversationId);
  const source = parseSource(value.source);
  if (!sameSource(source, expected)) {
    throw new Error("Usage archive cursor belongs to another store/conversation scope");
  }
  const cumulative = normalizeSnapshot(value.cumulative);
  if (cumulative.status !== "available" || !sameSource(cumulative.source, source)) {
    throw new Error("Usage archive cursor has an invalid cumulative snapshot");
  }
  return makeCursor(cumulative);
}

function addUnknown(
  unknownFields: UsageUnknownField[],
  bucket: "models" | "tools",
  key: string,
  field: (typeof OPTIONAL_USAGE_FIELDS)[number],
): void {
  unknownFields.push(Object.freeze({ bucket, key, field }));
}

function difference(current: number, previous: number, label: string): number {
  if (current < previous) throw new Error(`Native usage regressed at ${label}`);
  return current - previous;
}

function subtractUsage(
  current: Readonly<Usage>,
  previous: Readonly<Usage> | undefined,
  bucket: "models" | "tools",
  key: string,
  unknownFields: UsageUnknownField[],
): { usage?: Readonly<Usage>; changed: boolean } {
  const prior = previous;
  const isNew = prior === undefined;
  const numeric: Record<string, number> = objectRecord();
  let measuredChange = isNew;
  let uncertainTransition = false;
  const unknown: (typeof OPTIONAL_USAGE_FIELDS)[number][] = [];

  for (const field of REQUIRED_USAGE_FIELDS) {
    const delta = prior === undefined
      ? current[field]
      : difference(current[field], prior[field], `${bucket}.${key}.${field}`);
    numeric[field] = delta;
    if (delta > 0) measuredChange = true;
  }
  const cost: Record<string, number> = objectRecord();
  for (const field of COST_FIELDS) {
    const delta = prior === undefined
      ? current.cost[field]
      : difference(current.cost[field], prior.cost[field], `${bucket}.${key}.cost.${field}`);
    cost[field] = delta;
    if (delta > 0) measuredChange = true;
  }

  const optional: Partial<Pick<Usage, (typeof OPTIONAL_USAGE_FIELDS)[number]>> = {};
  for (const field of OPTIONAL_USAGE_FIELDS) {
    const currentValue = current[field];
    const previousValue = prior?.[field];
    if (prior === undefined) {
      if (currentValue === undefined) unknown.push(field);
      else optional[field] = currentValue;
      continue;
    }
    if (previousValue !== undefined && currentValue === undefined) {
      throw new Error(`Native usage regressed at ${bucket}.${key}.${field}`);
    }
    if (previousValue === undefined || currentValue === undefined) {
      unknown.push(field);
      if (previousValue === undefined && currentValue !== undefined) uncertainTransition = true;
      continue;
    }
    const delta = difference(currentValue, previousValue, `${bucket}.${key}.${field}`);
    optional[field] = delta;
    if (delta > 0) measuredChange = true;
  }

  if (measuredChange) {
    for (const field of unknown) addUnknown(unknownFields, bucket, key, field);
  } else if (uncertainTransition) {
    for (const field of unknown) addUnknown(unknownFields, bucket, key, field);
  }
  const changed = measuredChange || uncertainTransition;
  if (!measuredChange) return { changed };

  const usage = copyUsage({ ...numeric, cost, ...optional }, `${bucket}.${key}.delta`);
  return { usage, changed };
}

function subtractBucket(
  current: Readonly<Record<string, Readonly<Usage>>>,
  previous: Readonly<Record<string, Readonly<Usage>>> | undefined,
  bucket: "models" | "tools",
  unknownFields: UsageUnknownField[],
): { values: Readonly<Record<string, Readonly<Usage>>>; changed: boolean } {
  const result = objectRecord<Readonly<Usage>>();
  let changed = false;
  if (previous !== undefined) {
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(current, key)) throw new Error(`Native usage row disappeared at ${bucket}.${key}`);
    }
  }
  for (const key of Object.keys(current)) {
    const prior = previous !== undefined && Object.hasOwn(previous, key) ? previous[key] : undefined;
    const currentUsage = current[key];
    if (currentUsage === undefined) throw new Error(`Invalid native usage row: ${bucket}.${key}`);
    const delta = subtractUsage(currentUsage, prior, bucket, key, unknownFields);
    changed ||= delta.changed;
    if (delta.usage !== undefined) setOwn(result, key, delta.usage);
  }
  return { values: Object.freeze(result), changed };
}

function providerAndModel(providerModel: string): { provider: string; model: string } {
  const separator = providerModel.indexOf("/");
  return separator < 0
    ? { provider: "unknown", model: providerModel }
    : { provider: providerModel.slice(0, separator) || "unknown", model: providerModel.slice(separator + 1) };
}

function legacyProjection(models: Readonly<Record<string, Readonly<Usage>>>): LegacyUsageDelta {
  const keys = Object.keys(models);
  if (keys.length === 0) return Object.freeze({});
  const byModel = objectRecord<LegacyModelUsage>();
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let cached = 0;
  for (const key of keys) {
    const usage = models[key];
    if (usage === undefined) throw new Error(`Invalid native usage row: models.${key}`);
    const promptTokens = safeTokenCount(
      usage.input + usage.cacheRead + usage.cacheWrite,
      `legacy.by_model.${key}.prompt_tokens`,
    );
    const attribution = providerAndModel(key);
    const row = Object.freeze({
      ...attribution,
      provider_model: key,
      prompt_tokens: promptTokens,
      completion_tokens: usage.output,
      total_tokens: usage.totalTokens,
      cached_tokens: usage.cacheRead,
    });
    setOwn(byModel, key, row);
    prompt = addTokenCounts(prompt, promptTokens, "legacy.prompt_tokens");
    completion = addTokenCounts(completion, usage.output, "legacy.completion_tokens");
    total = addTokenCounts(total, usage.totalTokens, "legacy.total_tokens");
    cached = addTokenCounts(cached, usage.cacheRead, "legacy.cached_tokens");
  }
  return Object.freeze({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    by_model: Object.freeze(byModel),
  });
}

/**
 * Project one cumulative native ledger against its prior archive cursor. This is read-only: `nextCursor` is a proposal,
 * not a commit. Callers must transactionally couple that proposal with their archive write or use an idempotent archive.
 */
export function projectUsageDelta(
  rawSnapshot: UsageSnapshot,
  rawCursor?: UsageArchiveCursor,
): UsageArchiveProjection {
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (snapshot.status !== "available") {
    throw new Error("Cannot calculate an archive delta from an unavailable native usage document");
  }
  const cursor = rawCursor === undefined
    ? undefined
    : parseUsageArchiveCursor(rawCursor, snapshot.source);
  const previous = cursor?.cumulative;
  const unknownFields: UsageUnknownField[] = [];
  const models = subtractBucket(snapshot.models, previous?.models, "models", unknownFields);
  const tools = subtractBucket(snapshot.tools, previous?.tools, "tools", unknownFields);
  const native = Object.freeze({ models: models.values, tools: tools.values });
  return Object.freeze({
    source: snapshot.source,
    accounting: ACCOUNTING,
    hasDelta: models.changed || tools.changed,
    legacy: legacyProjection(models.values),
    native,
    requestCount: Object.freeze({ status: "unknown" as const }),
    unknownFields: Object.freeze(unknownFields),
    nextCursor: makeCursor(snapshot),
  });
}
