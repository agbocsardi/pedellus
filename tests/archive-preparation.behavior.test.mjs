import assert from "node:assert/strict";
import test from "node:test";
import { prepareArchivePayload } from "../dist/archive/index.js";
import { projectUsageDelta, snapshotUsageState } from "../dist/usage/index.js";

const scope = { storeNamespace: "synthetic", conversationId: 3 };
const projection = projectUsageDelta(snapshotUsageState(scope.storeNamespace, scope.conversationId, {
  models: {
    "provider/model": {
      input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
  tools: {},
}));
const snapshot = {
  timestamp: "2026-07-19T12:30:00+00:00",
  session_key: "synthetic-session",
  messages: [{ timestamp: "2026-07-19T12:00:00+00:00", role: "user", content: "hello" }],
};
const prepare = (data = snapshot, usage = projection, expectedScope = scope) =>
  prepareArchivePayload(data, usage, expectedScope);

const validToolOnlyProjection = projectUsageDelta(snapshotUsageState(scope.storeNamespace, scope.conversationId, {
  models: {},
  tools: {
    audit: {
      input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
}));

test("prepares immutable Python-v3 payload without inventing requests", () => {
  const result = prepare();
  assert.equal(result.schema_version, 3);
  assert.equal(result.kind, "conversation");
  assert.equal(result.message_count, 1);
  assert.deepEqual(result.usage, {
    prompt_tokens: 3,
    completion_tokens: 3,
    total_tokens: 6,
    cached_tokens: 1,
    by_model: {
      "provider/model": {
        provider: "provider", model: "model", provider_model: "provider/model",
        prompt_tokens: 3, completion_tokens: 3, total_tokens: 6, cached_tokens: 1,
      },
    },
  });
  assert.equal("requests" in result.usage, false);
  assert.equal(result.usage_provenance.source.storeNamespace, scope.storeNamespace);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.messages), true);
  assert.equal(Object.isFrozen(result.usage_provenance.nextCursor), true);
  assert.equal(Object.isFrozen(snapshot.messages[0]), false);
});

test("matches Python summary stripping and truncation before persistence", () => {
  const result = prepare({ ...snapshot, summary: "  conclusion <think>secret reasoning</think> ok  " });
  assert.equal(result.summary, "conclusion  ok");
  assert.doesNotMatch(result.summary, /secret reasoning|<think>/);
  const long = prepare({ ...snapshot, summary: "x".repeat(8_001) });
  assert.equal(long.summary, `${"x".repeat(8_000)}\n... (truncated)`);
});

test("rejects incomplete snapshots, oversized fields, and wrong source scope", () => {
  assert.throws(() => prepare({ ...snapshot, messages: [] }), /1-1000/);
  assert.throws(() => prepare({ ...snapshot, messages: [{ role: "user", content: "x" }] }), /incomplete/);
  assert.throws(() => prepare({ ...snapshot, summary: "x".repeat(256 * 1024 + 1) }), /field limit/);
  assert.throws(() => prepare(snapshot, projection, { ...scope, conversationId: 4 }), /does not match/);
  const large = { ...snapshot, messages: [{ ...snapshot.messages[0], content: "x".repeat(4 * 1024 * 1024) }] };
  assert.throws(() => prepare(large), /field limit|preflight size/);
  assert.equal(large.messages[0].content.length, 4 * 1024 * 1024);
});

test("rejects forged accounting shapes and preserves valid tool-only provenance", () => {
  assert.throws(() => prepare(snapshot, { ...projection, legacy: { ...projection.legacy, prompt_tokens: -1 } }), /Malformed|Invalid|mismatch/);
  assert.throws(() => prepare(snapshot, { ...projection, native: { ...projection.native, models: {
    ...projection.native.models,
    "provider/model": { ...projection.native.models["provider/model"], output: Number.NaN },
  } } }), /Invalid archive usage counter/);
  assert.throws(() => prepare(snapshot, { ...projection, nextCursor: { ...projection.nextCursor, version: 8 } }), /cursor proposal/);
  const result = prepare(snapshot, validToolOnlyProjection);
  assert.equal("usage" in result, false);
  assert.equal(result.usage_provenance.native.tools.audit.output, 1);
  assert.equal(result.usage_provenance.requestCount.status, "unknown");
});
