import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inventoryLegacySnapshots } from "../dist/migration/index.js";

const snapshot = (sourceId, format, value, provenance = "synthetic-test") => ({
  sourceId,
  provenance,
  format,
  bytes: value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const header = (key = "cli:synthetic") => ({
  _type: "metadata", key, created_at: "2026-10-27T00:00:00", updated_at: "2026-10-27T00:00:00",
  metadata: {}, last_consolidated: 0,
});
const message = (role, content, extra = {}) => ({
  _entry_id: `synthetic-${role}`, role, content, timestamp: "2026-10-27T00:00:00", ...extra,
});
const history = (extra = {}) => ({
  kind: "conversation", schema_version: 3, cursor: 1, timestamp: "2026-10-27T00:00:00",
  session_key: "cli:synthetic", messages: [], message_count: 0,
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, requests: 1 }, ...extra,
});

 test("Python history payload eligibility gates usage subtotals", () => {
  const valid = history();
  const rejected = [
    history({ session_key: 7, cursor: 2 }),
    history({ timestamp: null, cursor: 3 }),
    history({ messages: undefined, message_count: undefined, cursor: 4 }),
  ];
  const report = inventoryLegacySnapshots([snapshot("history", "history-jsonl", [valid, ...rejected].map(JSON.stringify).join("\n") + "\n")]);
  assert.equal(report.usageReconciliation.archived.recordsWithKnownUsage, 1);
  assert.equal(report.usageReconciliation.archived.invalidPayloadRecords, 3);
  assert.equal(report.usageReconciliation.archived.knownReportedSubtotal.prompt_tokens, 7);
  assert.equal(report.records.slice(0, 4)[0].usage.status, "known");
  assert.ok(report.records.slice(1, 4).every((record) => record.usage.status === "invalid"));
  assert.ok(report.issues.some((issue) => issue.code === "invalid_history_session_key"));
});

test("camelCase config aliases preserve values; conflicting aliases and malformed shapes stay incomplete", () => {
  const config = {
    agents: { defaults: { model: "legacy/default", provider: "openai", modelPreset: "fast", runPresets: { cron: "fast" } } },
    modelPresets: { fast: { model: "legacy/fast", provider: "openai", maxTokens: 1024,
      contextWindowTokens: 16000, reasoningEffort: "low", needsVisionHandoff: true } },
    providers: { openai: { apiKey: "synthetic-private-value" } },
  };
  const report = inventoryLegacySnapshots([snapshot("config", "config-json", config)]);
  const preset = report.records.find((record) => record.originalId?.value === "fast");
  assert.equal(report.configuration[0].activePreset.value, "fast");
  assert.equal(preset.lineage.maxTokens, 1024);
  assert.equal(preset.lineage.contextWindowTokens, 16000);
  assert.equal(preset.lineage.reasoningEffort.value, "low");
  assert.equal(preset.lineage.needsVisionHandoff, true);
  assert.equal(report.configuration[0].runPresetCount, 1);
  assert.equal(report.sources[0].lineCount, null);
  assert.equal(preset.identityScope, "document");
  assert.equal(preset.line, null);
  assert.equal(preset.lineSha256, null);
  assert.equal(preset.sourceSha256, sha256(JSON.stringify(config)));
  assert.equal(JSON.stringify(report).includes("synthetic-private-value"), false);

  const ambiguous = inventoryLegacySnapshots([snapshot("ambiguous", "config-json", {
    agents: { defaults: { model_preset: "slow", modelPreset: "fast" } },
    model_presets: {}, modelPresets: { fast: { maxTokens: 2 } },
  })]);
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.configuration[0].activePreset, null);
  assert.ok(ambiguous.issues.some((issue) => issue.code === "conflicting_config_aliases"));

  const malformed = inventoryLegacySnapshots([snapshot("malformed", "config-json", { agents: [], providers: 7 })]);
  assert.equal(malformed.complete, false);
  assert.equal(malformed.configuration[0].configuredBuiltinProviders, null);
  assert.ok(malformed.issues.some((issue) => issue.code === "agents_not_object"));
  assert.ok(malformed.issues.some((issue) => issue.code === "providers_not_object"));
});

test("session shapes preserve valid Python cases and quarantine malformed messages", () => {
  const messages = [
    message("user", "plain"),
    message("assistant", null, { tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }),
    message("user", null, { media: [{ type: "image" }] }),
    message("tool", "result", { tool_call_id: "call-1" }),
    { _entry_id: "bad-role", content: "synthetic", timestamp: "2026-10-27T00:00:00" },
    message("user", 42),
    message("user", "malformed", { tool_calls: [{ id: "spoofed" }] }),
  ];
  const bytes = [header(), ...messages].map(JSON.stringify).join("\n") + "\n";
  const report = inventoryLegacySnapshots([snapshot("session", "session-jsonl", bytes)]);
  assert.equal(report.complete, false);
  const entries = report.records.filter((record) => record.category === "session-message");
  assert.equal(entries[0].targetEntryKind, "pi.user");
  assert.equal(entries[1].targetEntryKind, "nanobot.legacy.history");
  assert.equal(entries[1].executionDisposition, "historical-only-never-runnable");
  assert.equal(entries[2].targetEntryKind, "pi.user");
  assert.equal(entries[3].executionDisposition, "historical-only-never-runnable");
  assert.equal(entries[4].targetEntryKind, null);
  assert.equal(entries[4].executionDisposition, "review-required");
  assert.equal(entries[5].targetEntryKind, null);
  assert.equal(entries[5].executionDisposition, "review-required");
  assert.equal(entries[6].targetEntryKind, "nanobot.legacy.history");
  assert.equal(entries[6].executionDisposition, "review-required-history-only-never-runnable");
  assert.ok(report.issues.some((issue) => issue.code === "missing_session_message_role"));
  assert.ok(report.issues.some((issue) => issue.code === "invalid_session_message_content"));
  assert.ok(report.issues.some((issue) => issue.code === "tool_calls_role_mismatch"));
});

test("history-only disposition, exact line provenance, caller scope, privacy, and caps are explicit", () => {
  const raw = [JSON.stringify(header()), JSON.stringify(message("assistant", "private transcript", {
    tool_calls: [{ id: "call-private", function: { name: "secret-tool", arguments: "private args" } }],
  }))].join("\n") + "\n";
  const input = Buffer.from(raw);
  const report = inventoryLegacySnapshots([snapshot("session", "session-jsonl", input)]);
  const record = report.records.find((item) => item.category === "session-message");
  const secondLine = Buffer.from(raw.split("\n")[1] + "\n");
  assert.equal(record.line, 2);
  assert.equal(record.lineSha256, sha256(secondLine));
  assert.equal(record.identityScope, "line");
  assert.equal(record.targetEntryKind, "nanobot.legacy.history");
  assert.equal(record.executionDisposition, "historical-only-never-runnable");
  assert.equal(input.toString(), raw, "inventory must not mutate host snapshot bytes");
  const serialized = JSON.stringify(report);
  for (const secret of ["private transcript", "private args", "secret-tool"]) assert.equal(serialized.includes(secret), false);
  assert.equal(report.aggregationScope, "caller-must-supply-one-store-or-workspace-per-invocation;not-enforced");
  assert.equal(report.importPerformed, false);
  assert.equal(report.ambientReadsPerformed, false);
  const bounded = inventoryLegacySnapshots([snapshot("too-large", "session-jsonl", "xx")], {
    limits: { maxSourceBytes: 1 },
  });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.sources[0].status, "incomplete");
  assert.ok(bounded.issues.some((issue) => issue.code === "source_byte_limit_exceeded"));

  const docs = readFileSync(new URL("../MIGRATION.md", import.meta.url), "utf8");
  for (const claim of ["one legacy store/workspace", "not PII-scrubbed", "document-scoped", "history-only/non-runnable", "invalidPayloadRecords"])
    assert.ok(docs.includes(claim), `missing migration contract documentation: ${claim}`);
});
