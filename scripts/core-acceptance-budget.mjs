/**
 * Pre-dispatch budget guard for a real-model acceptance run.
 *
 * The guard is deliberately conservative and provider-agnostic:
 *
 * - Input is reserved as the UTF-8 byte length of the exact provider payload,
 *   plus a fixed framing reserve per request. For a byte-level tokenizer every
 *   token covers at least one byte, so payload bytes are an upper bound on the
 *   tokenized payload text; the framing reserve covers provider chat-template
 *   and role markers that are not part of the payload bytes. The reserve is a
 *   documented engineering allowance, not a proof about provider-internal
 *   additions.
 * - Output is reserved as the clamped `max_tokens` (or the provider's
 *   equivalent field) supplied in that same payload. The provider must honour
 *   that field for the reservation to be a hard cap.
 * - Every reservation is written to a persisted ledger before the provider is
 *   called. A second process is excluded by an exclusive lock file, and
 *   in-process mutations are serialized, so retries, compaction and a reopened
 *   process share one budget.
 * - A request whose bound cannot be computed from a plain JSON payload with a
 *   recognised output limit, or whose bound would exceed a remaining cap, is
 *   rejected before dispatch and counted as a refusal, never as a dispatch.
 *   Nothing is estimated from after-the-fact usage.
 *
 * The ledger is replaced with a temp-file rename inside the owned temp
 * directory. That is atomic for concurrent readers and the lock excludes a
 * second writer, but the file is not fsync'd: a power loss can lose the latest
 * reservation. This is a run-local budget guard, not a durable accounting
 * store, and a stale lock after a crash fails closed.
 *
 * `wrapModels` injects the gate through pi-ai's `onPayload` hook, which runs
 * after the provider adapter builds the final payload and before the HTTP
 * request. It also disables SDK-level retries so a retry cannot dispatch
 * outside the ledger. Streams are settled with an abort/timeout race so a
 * provider that never calls `onPayload` fails closed instead of hanging.
 */
import { createHash } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LEDGER_VERSION = 1;
/** Conservative per-request allowance for provider framing outside the payload. */
export const INPUT_FRAMING_TOKENS_PER_REQUEST = 4096;
const SUPPORTED_APIS = new Set(["openai-completions", "anthropic-messages", "openai-responses", "azure-openai-responses"]);
/** Model methods that would dispatch without a reserve; refused rather than forwarded. */
export const UNGUARDED_MODEL_METHODS = Object.freeze([
  "stream",
  "complete",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
  "generateImages",
  "classify",
  "refresh",
]);
const UNGUARDED_DISPATCH_METHODS = new Set(UNGUARDED_MODEL_METHODS);

export class BudgetError extends Error {
  constructor(message, code = "budget") {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new BudgetError(`${name} must be a positive integer`, "config");
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new BudgetError(`${name} must be a non-negative integer`, "ledger");
  return value;
}

function operationOutputCaps(value) {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BudgetError("maxOutputPerRequestByOperation must be an object", "config");
  }
  const caps = {};
  for (const [kind, cap] of Object.entries(value)) {
    if (kind.length === 0 || kind.length > 32) throw new BudgetError("maxOutputPerRequestByOperation key is invalid", "config");
    caps[kind] = positiveInteger(cap, `maxOutputPerRequestByOperation.${kind}`);
  }
  return Object.freeze(caps);
}

function freshLedger() {
  return {
    version: LEDGER_VERSION,
    requests: 0,
    inputReserved: 0,
    outputReserved: 0,
    inputActual: 0,
    outputActual: 0,
    refused: 0,
    records: [],
    violation: null,
  };
}

function validateLedger(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BudgetError("budget ledger is not an object", "ledger");
  if (value.version !== LEDGER_VERSION) throw new BudgetError(`unsupported budget ledger version ${String(value.version)}`, "ledger");
  if (!Array.isArray(value.records)) throw new BudgetError("budget ledger records are not an array", "ledger");
  const ledger = freshLedger();
  for (const field of ["requests", "inputReserved", "outputReserved", "inputActual", "outputActual"]) {
    ledger[field] = nonNegativeInteger(value[field], `ledger.${field}`);
  }
  ledger.refused = value.refused === undefined ? 0 : nonNegativeInteger(value.refused, "ledger.refused");
  if (ledger.requests !== value.records.length) throw new BudgetError("budget ledger request count disagrees with its records", "ledger");
  for (const record of value.records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) throw new BudgetError("budget ledger record is not an object", "ledger");
    if (typeof record.kind !== "string" || record.kind.length === 0 || record.kind.length > 32) throw new BudgetError("budget ledger record kind is invalid", "ledger");
    nonNegativeInteger(record.at, "record.at");
    nonNegativeInteger(record.bytes, "record.bytes");
    positiveInteger(record.inputBound, "record.inputBound");
    positiveInteger(record.outputReserve, "record.outputReserve");
    if (typeof record.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.payloadSha256)) throw new BudgetError("budget ledger record hash is invalid", "ledger");
    ledger.records.push({
      kind: record.kind,
      at: record.at,
      bytes: record.bytes,
      inputBound: record.inputBound,
      outputReserve: record.outputReserve,
      payloadSha256: record.payloadSha256,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    });
  }
  ledger.violation = value.violation ?? null;
  return ledger;
}

/**
 * Create a budget bound to one owned state directory. Call `acquire()` before
 * use and `close()` in a finally block.
 */
export function createBudget(options) {
  const stateDir = options.stateDir;
  if (typeof stateDir !== "string" || stateDir.length === 0) throw new BudgetError("stateDir is required", "config");
  const maxRequests = positiveInteger(options.maxRequests, "maxRequests");
  const maxInputTokens = positiveInteger(options.maxInputTokens, "maxInputTokens");
  const maxOutputTokens = positiveInteger(options.maxOutputTokens, "maxOutputTokens");
  const maxOutputPerRequest = positiveInteger(options.maxOutputPerRequest, "maxOutputPerRequest");
  const maxOutputPerRequestByOperation = operationOutputCaps(options.maxOutputPerRequestByOperation);
  const framingTokens = positiveInteger(options.framingTokens ?? INPUT_FRAMING_TOKENS_PER_REQUEST, "framingTokens");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, "timeoutMs");
  const ledgerName = options.ledgerName ?? "budget-ledger.json";
  const now = options.now ?? Date.now;
  const ledgerPath = join(stateDir, ledgerName);
  const lockPath = `${ledgerPath}.lock`;
  let lock;
  let ledger;
  let acquired = false;
  let tail = Promise.resolve();

  const serial = (work) => {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  /** Mark a pre-dispatch refusal in the ledger, then return the error to throw. */
  async function refuse(code, message) {
    ledger.refused += 1;
    await persist();
    return new BudgetError(message, code);
  }

  async function persist() {
    // Atomic replacement for readers; deliberately no fsync (see module note).
    const temporary = `${ledgerPath}.${process.pid}.${now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, ledgerPath);
  }

  async function load() {
    let text;
    try {
      text = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return freshLedger();
      throw new BudgetError(`cannot read budget ledger: ${error?.message ?? String(error)}`, "ledger");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BudgetError(`budget ledger is not valid JSON: ${error?.message ?? String(error)}`, "ledger");
    }
    return validateLedger(parsed);
  }

  async function acquire() {
    return serial(async () => {
      if (acquired) throw new BudgetError("budget is already acquired", "state");
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code === "EEXIST") throw new BudgetError("budget ledger is locked by another process", "locked");
        throw error;
      }
      try {
        await handle.writeFile(`${process.pid} ${now()}\n`);
        ledger = await load();
        lock = handle;
        acquired = true;
        await persist();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Reserve before dispatch. Mutates `payload` to clamp its output limit and
   * returns the reservation. Throws `BudgetError` when the request must not be
   * sent.
   */
  async function reservePayload(payload, kind = "request") {
    if (typeof kind !== "string" || kind.length === 0 || kind.length > 32) throw new BudgetError("request kind is invalid", "config");
    return serial(async () => {
      if (!acquired) throw new BudgetError("budget is not acquired", "state");
      if (ledger.violation !== null) throw new BudgetError(`budget is already violated: ${ledger.violation}`, "violated");
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw await refuse("unbounded", "provider payload is not an object");
      }
      let text;
      try {
        text = JSON.stringify(payload);
      } catch (error) {
        throw await refuse("unbounded", `provider payload cannot be serialized: ${error?.message ?? String(error)}`);
      }
      if (typeof text !== "string") throw await refuse("unbounded", "provider payload cannot be serialized");
      const outputField = Object.hasOwn(payload, "max_tokens")
        ? "max_tokens"
        : Object.hasOwn(payload, "max_completion_tokens")
          ? "max_completion_tokens"
          : undefined;
      if (outputField === undefined) {
        throw await refuse("unbounded", "provider payload has no recognised output token limit");
      }
      const requestedOutput = payload[outputField];
      if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) {
        throw await refuse("unbounded", "provider payload output token limit is not a positive integer");
      }
      const bytes = Buffer.byteLength(text, "utf8");
      const inputBound = bytes + framingTokens;
      if (ledger.requests + 1 > maxRequests) {
        throw await refuse("requests", `provider request cap reached (${maxRequests})`);
      }
      if (inputBound > maxInputTokens - ledger.inputReserved) {
        throw await refuse(
          "input",
          `request would exceed the input budget: bound ${inputBound} > remaining ${maxInputTokens - ledger.inputReserved} (${bytes} payload bytes + ${framingTokens} framing)`,
        );
      }
      const perRequestCap = maxOutputPerRequestByOperation[kind] ?? maxOutputPerRequest;
      const outputReserve = Math.min(requestedOutput, perRequestCap, maxOutputTokens - ledger.outputReserved);
      if (outputReserve < 1) throw await refuse("output", "request would exceed the output budget");
      payload[outputField] = outputReserve;
      const record = {
        kind,
        at: now(),
        bytes,
        inputBound,
        outputReserve,
        payloadSha256: sha256(JSON.stringify(payload)),
      };
      ledger.requests += 1;
      ledger.inputReserved += inputBound;
      ledger.outputReserved += outputReserve;
      ledger.records.push(record);
      await persist();
      return { ...record, index: ledger.records.length - 1 };
    });
  }

  /** Record provider-reported usage after a response; never used to reserve. */
  async function recordUsage(usage, context = {}) {
    return serial(async () => {
      if (!acquired) throw new BudgetError("budget is not acquired", "state");
      const raw = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const reported = [raw.input, raw.output, raw.cacheRead, raw.cacheWrite];
      if (!reported.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new BudgetError("provider usage is not a set of non-negative integers", "usage");
      }
      const input = raw.input + raw.cacheRead + raw.cacheWrite;
      const output = raw.output;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) throw new BudgetError("provider usage overflows", "usage");
      ledger.inputActual += input;
      ledger.outputActual += output;
      const index = context.index;
      if (Number.isSafeInteger(index) && ledger.records[index] !== undefined) {
        ledger.records[index].usage = {
          input,
          output,
          cacheRead: raw.cacheRead,
          cacheWrite: raw.cacheWrite,
          ...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning }),
          totalTokens: raw.totalTokens,
        };
        const record = ledger.records[index];
        if (input > record.inputBound) {
          ledger.violation = `reported input ${input} exceeded record ${index} bound ${record.inputBound}`;
        }
        if (output > record.outputReserve) {
          ledger.violation = `reported output ${output} exceeded record ${index} reserve ${record.outputReserve}`;
        }
      }
      if (ledger.inputActual > ledger.inputReserved) {
        ledger.violation = `reported input ${ledger.inputActual} exceeded reserved ${ledger.inputReserved}`;
      }
      if (ledger.outputActual > ledger.outputReserved) {
        ledger.violation = `reported output ${ledger.outputActual} exceeded reserved ${ledger.outputReserved}`;
      }
      await persist();
      if (ledger.violation !== null) throw new BudgetError(ledger.violation, "violated");
      return { input, output };
    });
  }

  async function close() {
    return serial(async () => {
      if (!acquired) return;
      try {
        await persist();
      } finally {
        acquired = false;
        const handle = lock;
        lock = undefined;
        await handle?.close().catch(() => undefined);
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    });
  }

  function snapshot() {
    if (ledger === undefined) throw new BudgetError("budget is not acquired", "state");
    return JSON.parse(JSON.stringify({
      maxRequests,
      maxInputTokens,
      maxOutputTokens,
      maxOutputPerRequest,
      maxOutputPerRequestByOperation,
      framingTokens,
      timeoutMs,
      ...ledger,
    }));
  }

  return {
    acquire,
    close,
    reservePayload,
    recordUsage,
    snapshot,
    /** The request timeout injected into every provider call. */
    timeoutMs,
  };
}

function newGate() {
  let resolve;
  let reject;
  const prepared = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A gate that is never observed has no waiter; keep its rejection from becoming unhandled.
  prepared.catch(() => undefined);
  return { observed: false, reserving: false, index: undefined, prepared, resolve, reject };
}

/** Fail closed when a provider skips onPayload (including a pre-aborted request). */
function awaitPrepared(gate, signal, timeoutMs) {
  if (gate.observed) return Promise.resolve();
  let timer;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(new BudgetError("request was aborted before a pre-dispatch payload was observed", "unobserved"));
      return;
    }
    onAbort = () => reject(new BudgetError("request was aborted before a pre-dispatch payload was observed", "unobserved"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timed = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BudgetError("provider did not expose a pre-dispatch payload before the request timeout", "unobserved")),
      timeoutMs,
    );
  });
  return Promise.race([gate.prepared, aborted, timed]).finally(() => {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function wrapResult(events, budget, kind, gate, options = {}) {
  return new Proxy(events, {
    get(target, property) {
      if (property === "result") {
        return async () => {
          await awaitPrepared(gate, options.signal, options.timeoutMs ?? budget.timeoutMs);
          const message = await target.result();
          if (!gate.observed) throw new BudgetError("provider did not expose a pre-dispatch payload", "unobserved");
          await budget.recordUsage(message?.usage, { kind, index: gate.index });
          return message;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapCompletion(promise, budget, kind, gate, options = {}) {
  return promise.then(async (message) => {
    await awaitPrepared(gate, options.signal, options.timeoutMs ?? budget.timeoutMs);
    if (!gate.observed) throw new BudgetError("provider did not expose a pre-dispatch payload", "unobserved");
    await budget.recordUsage(message?.usage, { kind, index: gate.index });
    return message;
  });
}

function syntheticPayload(model, context, options) {
  return {
    model: `${model.provider}/${model.id}`,
    max_tokens: options?.maxTokens ?? model.maxTokens,
    messages: context.messages,
  };
}

/**
 * Wrap a pi-ai `Models` object so every dispatch reserves first.
 *
 * `allowUnobserved` exists only for the offline faux self-probe, whose adapter
 * has no `onPayload` hook. It reserves a synthetic payload before delegating;
 * real provider APIs must call `onPayload`, and an unsupported API is refused
 * before the inner call.
 */
export function wrapModels(models, budget, options = {}) {
  const allowUnobserved = options.allowUnobserved === true;
  const onRequest = options.onRequest;
  const bindings = new Map();
  const prepare = (operation, model, context, requestOptions) => {
    const api = model?.api;
    if (typeof api !== "string" || !SUPPORTED_APIS.has(api)) {
      if (!allowUnobserved) {
        throw new BudgetError(`provider API ${String(api)} has no pre-dispatch payload hook; refusing an unbounded request`, "unbounded");
      }
    }
    // Observation happens before dispatch and before the payload reserve, so the
    // acceptance checks see exactly the context the provider will receive.
    if (onRequest !== undefined) onRequest({ operation, model, context });
    const gate = newGate();
    if (!SUPPORTED_APIS.has(api)) {
      gate.reserving = true;
      budget.reservePayload(syntheticPayload(model, context, requestOptions), operation).then(
        (reservation) => {
          gate.observed = true;
          gate.index = reservation.index;
          gate.resolve(reservation);
        },
        (error) => gate.reject(error),
      );
    }
    const originalOnPayload = requestOptions?.onPayload;
    const merged = {
      ...requestOptions,
      // SDK-level retries would dispatch again without a new onPayload call.
      maxRetries: 0,
      timeoutMs: budget.timeoutMs,
      onPayload: async (payload, payloadModel) => {
        let next = payload;
        try {
          if (originalOnPayload !== undefined) {
            const replaced = await originalOnPayload(payload, payloadModel);
            if (replaced !== undefined) next = replaced;
          }
          if (!gate.observed && !gate.reserving) {
            const reservation = await budget.reservePayload(next, operation);
            gate.observed = true;
            gate.index = reservation.index;
            gate.resolve(reservation);
          }
          return next;
        } catch (error) {
          gate.reject(error);
          throw error;
        }
      },
    };
    return { gate, merged };
  };
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") {
        return (model, context, requestOptions) => {
          const { gate, merged } = prepare("streamSimple", model, context, requestOptions);
          return wrapResult(models.streamSimple(model, context, merged), budget, "streamSimple", gate,
            { signal: merged.signal, timeoutMs: budget.timeoutMs });
        };
      }
      if (property === "completeSimple") {
        return (model, context, requestOptions) => {
          const { gate, merged } = prepare("completeSimple", model, context, requestOptions);
          return wrapCompletion(models.completeSimple(model, context, merged), budget, "completeSimple", gate,
            { signal: merged.signal, timeoutMs: budget.timeoutMs });
        };
      }
      if (UNGUARDED_DISPATCH_METHODS.has(property)) {
        return () => {
          throw new BudgetError(`Models.${String(property)} is not budget-guarded; refusing`, "unbounded");
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!bindings.has(property)) bindings.set(property, value.bind(target));
      return bindings.get(property);
    },
  });
}
