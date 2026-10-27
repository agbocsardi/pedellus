import assert from "node:assert/strict";
import test from "node:test";
import { prepareArchivePayload } from "../dist/archive/index.js";
import { projectUsageDelta, snapshotUsageState } from "../dist/usage/index.js";

const projection = projectUsageDelta(snapshotUsageState("synthetic", 3, {
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

test("prepares an immutable Python-v3-compatible payload without inventing requests", () => {
  const result = prepareArchivePayload(snapshot, projection);
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
  assert.equal(result.usage_provenance.source.storeNamespace, "synthetic");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.messages), true);
  assert.equal(Object.isFrozen(result.usage_provenance.nextCursor), true);
  assert.equal(Object.isFrozen(snapshot.messages[0]), false);
});

test("rejects incomplete snapshots and oversized archives without mutating inputs", () => {
  assert.throws(() => prepareArchivePayload({ ...snapshot, messages: [] }, projection), /1-1000/);
  assert.throws(() => prepareArchivePayload({ ...snapshot, messages: [{ role: "user", content: "x" }] }, projection), /incomplete/);
  const large = { ...snapshot, messages: [{ ...snapshot.messages[0], content: "x".repeat(4 * 1024 * 1024) }] };
  assert.throws(() => prepareArchivePayload(large, projection), /4 MiB/);
  assert.equal(large.messages[0].content.length, 4 * 1024 * 1024);
});

test("preserves recorded unknown provenance while keeping legacy usage model-only", () => {
  const toolOnly = Object.freeze({
    ...projection,
    hasDelta: true,
    legacy: Object.freeze({}),
    native: Object.freeze({ ...projection.native, tools: Object.freeze({ audit: { marker: "retained" } }) }),
    unknownFields: Object.freeze([{ bucket: "tools", key: "audit", field: "reasoning" }]),
  });
  const result = prepareArchivePayload(snapshot, toolOnly);
  assert.equal("usage" in result, false);
  assert.equal(result.usage_provenance.native.tools.audit.marker, "retained");
  assert.equal(result.usage_provenance.unknownFields[0].field, "reasoning");
});
