import { randomUUID } from "node:crypto";
import type {
  SpanAttributes, SpanOptions, SpanStatus, TelemetryCarrier, TelemetryContext, TelemetryPropagation, TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { failureDiagnostic } from "./failure-diagnostics.js";

// An explicit projection, not serialization of SDK objects. Never admit content, arguments,
// output, filenames, paths, URLs, provider payloads, response IDs or raw error messages.
const NUMBERS = new Set([
  "conversation.id", "submission.id", "task.id", "entry.id", "answer.entry_id", "update.id",
  "message.id", "chat.id", "queue.depth", "attachments", "attempt", "source.age_ms", "cooldown.ms",
  "usage.input", "usage.output", "usage.cache_read", "usage.cache_write", "cost.total",
  "candidateTopics", "matchedTopics", "latencyMs", "topicGate", "historyGate", "topTopicProb",
]);
const IDENTIFIERS = new Set([
  "provider", "model", "api", "reasoning", "task.name", "tool.name", "entry.kind", "phase",
  "kind", "outcome", "result", "status", "stop", "submission.type", "type", "reason", "extension",
  "channel.id", "message.key", "delivery.id",
]);
const BOOLEANS = new Set(["resumed", "notice", "intentional", "isError", "needsHistoryRecall"]);
const STATUS_ERRORS = new Set(["provider_error", "task_faulted", "task_failed", "task_orphaned"]);
// Entry/submission commits are already durable records, and reports already reach onReport's diagnostic.
const NATIVE_EVENTS = new Set(["pi.durable.checkpoint", "pi.durable.replay", "pi.ai.first_chunk"]);
const SLOW_MS = 10_000;
const bootId = randomUUID().replaceAll("-", "");
let sequence = 0;
type Identity = { traceId: string; spanId: string };
const identities = new WeakMap<TelemetryContext, Identity>();
// One capability object on roots, children and extracted parents, as the native contract requires.
const propagation: TelemetryPropagation = {
  inject(source): TelemetryCarrier | undefined {
    const id = identities.get(source);
    return id === undefined ? undefined : { journalTrace: id.traceId, journalSpan: id.spanId };
  },
  extract(carrier): TelemetryContext {
    const traceId = carrier?.journalTrace;
    const spanId = carrier?.journalSpan;
    return typeof traceId === "string" && /^[a-f0-9]{32}$/.test(traceId)
      && typeof spanId === "string" && /^[a-f0-9]{32}:[0-9]{1,12}$/.test(spanId)
      ? context({ traceId, spanId }) : journalTelemetry;
  },
};

function attributes(input: SpanAttributes | undefined): SpanAttributes {
  const safe: SpanAttributes = {};
  if (input === undefined) return safe;
  for (const [key, value] of Object.entries(input)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (BOOLEANS.has(key) && typeof value === "boolean") safe[key] = value;
    else if (IDENTIFIERS.has(key) && typeof value === "string" && value.length <= 160
      && /^[A-Za-z0-9_.:/@+= -]+$/.test(value)) safe[key] = value;
  }
  return safe;
}

/** Logging must never fail an operation. All callers use fixed event names and projected attributes. */
function write(event: string, fields: object, warning = false): void {
  try {
    const line = `pedellus journal: ${JSON.stringify({ event, ...fields })}`;
    if (warning) console.warn(line);
    else console.info(line);
  } catch { /* Diagnostic sinks are best effort, never application state. */ }
}

export function journalEvent(event: string, input?: SpanAttributes, error?: unknown): void {
  write(event, {
    attributes: attributes(input),
    ...(error === undefined ? {} : { diagnostic: failureDiagnostic(error, "gateway.observe") }),
  }, error !== undefined);
}

/**
 * Streaming journal exporter for the SDK's existing content-free spans. No retained trace buffer,
 * ambient context or metrics-per-token output. Carriers correlate native durable tasks across restarts;
 * they are opaque diagnostics only, never authorization. Child contexts share this same adapter.
 */
export const journalTelemetry: TelemetryContext = context();

function context(parent?: Identity): TelemetryContext {
  const root: TelemetryContext = {
    propagation,
    startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
      const identity = { traceId: parent?.traceId ?? randomUUID().replaceAll("-", ""), spanId: `${bootId}:${++sequence}` };
      const base = { ...identity, ...(parent === undefined ? {} : { parentId: parent.spanId }), operation: options.name };
      const started = performance.now();
      let data = attributes(options.attributes);
      let settled = false;
      let status: SpanStatus["status"] | undefined;
      let errorKind: string | undefined;
      const elapsedMs = () => Math.round(performance.now() - started);
      const span: TelemetrySpan = {
        ...context(identity),
        setAttributes(next) { if (!settled) data = { ...data, ...attributes(next) }; },
        setStatus(next) {
          if (settled) return;
          status = next.status;
          errorKind = next.status === "error" && next.error && STATUS_ERRORS.has(next.error.name)
            ? next.error.name : undefined;
          // SDK status.error.message may contain credentials/provider payloads: deliberately omitted.
        },
        addEvent(name, input) {
          if (!settled && NATIVE_EVENTS.has(name)) write(name, { ...base, elapsedMs: elapsedMs(), attributes: attributes(input) });
        },
        addLink(link) {
          if (settled) return;
          const target = identities.get(link.context);
          if (target !== undefined) write("span.link", { ...base, target, attributes: attributes(link.attributes) });
        },
      };
      identities.set(span, identity);
      write("span.started", { ...base, attributes: data });
      for (const link of options.links ?? []) span.addLink(link);
      // Once per live span, not a heartbeat or a declaration of failure.
      const timer = setTimeout(() => {
        if (!settled) write("span.slow", { ...base, elapsedMs: elapsedMs(), attributes: data }, true);
      }, SLOW_MS);
      timer.unref?.();
      const finish = (failed: boolean, error?: unknown) => {
        settled = true;
        clearTimeout(timer);
        write("span.finished", { ...base, elapsedMs: elapsedMs(), status: status ?? (failed ? "error" : "ok"),
          ...(errorKind === undefined ? {} : { errorKind }), attributes: data,
          ...(failed ? { diagnostic: failureDiagnostic(error, "gateway.observe") } : {}),
        }, failed || status === "error");
      };
      let result: T | Promise<T>;
      try { result = callback(span); }
      catch (error) { finish(true, error); return Promise.reject(error); }
      return Promise.resolve(result).then(
        (value) => { finish(false); return value; },
        (error: unknown) => { finish(true, error); throw error; },
      );
    },
  };
  if (parent !== undefined) identities.set(root, parent);
  return root;
}

/** Explicit host boundary: the callback runs once, and the exact value/error is preserved. */
export function observeOperation<T>(
  name: string, input: SpanAttributes, work: (span: TelemetrySpan) => T | Promise<T>,
  parent: TelemetryContext = journalTelemetry,
): Promise<T> {
  return parent.startSpan({ name, attributes: input }, work);
}
