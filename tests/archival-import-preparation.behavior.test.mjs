import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ARCHIVAL_PREPARATION_FORMAT,
  ARCHIVAL_PREPARATION_LIMITS,
  ARCHIVAL_PREPARATION_VERSION,
  ArchivalPreparationBoundsError,
  ArchivalPreparationInputError,
  prepareArchivalImport,
} from "../dist/archival-import/index.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = (sourceId, format, text, extra = {}) => {
  const bytes = Buffer.from(text, "utf8");
  return { sourceId, format, provenance: "synthetic-fixture", sha256: sha256(bytes), bytes, ...extra };
};
const sessionKey = "telegram:1";
const sessionHeaderLine = (key) => JSON.stringify({ _type: "metadata", key, metadata: {} });

const sessionText = [
  JSON.stringify({
    _type: "metadata",
    key: sessionKey,
    created_at: "2026-07-19T12:00:00+00:00",
    updated_at: "2026-07-19T12:30:00+00:00",
    metadata: {
      _last_summary: "opaque session summary",
      runtime_checkpoint: { pending_tool_calls: [{ id: "call-1", function: { name: "danger", arguments: "{}" } }] },
      goal_state: { status: "active", objective: "opaque objective" },
      usage: { input: 3 },
    },
    last_consolidated: 1,
  }),
  JSON.stringify({ role: "user", content: "hello", timestamp: "2026-07-19T12:00:00+00:00", _entry_id: "m1" }),
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "hi there" }],
    timestamp: "2026-07-19T12:01:00+00:00",
    _entry_id: "m2",
    tool_calls: [{ id: "call-1", function: { name: "danger", arguments: "{}" } }],
  }),
  JSON.stringify({ _type: "provider_state", opaque_continuation: "provider-private-token" }),
  "",
  "not json",
  JSON.stringify({ role: "user", content: "hello again", timestamp: "2026-07-19T12:02:00+00:00", _entry_id: "m3" }),
  "",
].join("\n");

const historyText = [
  JSON.stringify({ timestamp: "2026-07-19 12:00", content: "legacy text", session_key: sessionKey, cursor: 1 }),
  JSON.stringify({
    schema_version: 3,
    kind: "conversation",
    timestamp: "2026-07-19T12:30",
    start_time: "2026-07-19T12:00",
    end_time: "2026-07-19T12:10",
    session_key: sessionKey,
    message_count: 2,
    messages: [
      { timestamp: "2026-07-19T12:00", role: "user", content: "question" },
      { timestamp: "2026-07-19T12:01", role: "assistant", content: "answer", name: "bot" },
    ],
    summary: "conversation summary",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cursor: 2,
  }),
  JSON.stringify({ timestamp: "2026-07-19T12:30", kind: "mystery", summary: "other summary", session_key: sessionKey, cursor: 3 }),
  "",
].join("\n");

const archiveText = [
  JSON.stringify({ _type: "transcript_archive", key: sessionKey }),
  JSON.stringify({ role: "user", content: "archived question", timestamp: "2026-07-19T12:00:00+00:00" }),
  JSON.stringify({ _type: "batch_manifest", note: "not a supported archive record" }),
  "",
].join("\n");

test("prepares versioned, ordered, lossless records from one store namespace", () => {
  const sources = [
    snapshot("session-a", "session-jsonl", sessionText),
    snapshot("history-a", "history-jsonl", historyText),
    snapshot("archive-a", "session-archive-jsonl", archiveText),
  ];
  const expectedLineCount = sources.reduce((count, source) => count + (source.bytes.toString("utf8").match(/\n/g)?.length ?? 0), 0);
  const result = prepareArchivalImport({ storeNamespace: "synthetic-store", sources });

  assert.equal(result.format, ARCHIVAL_PREPARATION_FORMAT);
  assert.equal(result.version, ARCHIVAL_PREPARATION_VERSION);
  assert.equal(result.storeNamespace, "synthetic-store");
  assert.equal(result.importPerformed, false);
  assert.equal(result.persistencePerformed, false);
  assert.equal(result.ambientReadsPerformed, false);
  assert.equal(result.replayPerformed, false);
  assert.equal(result.runtimeActionsPrepared, 0);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.disposition, "archive-only-never-resume-or-replay");
  assert.equal(result.complete, false);
  assert.equal(result.counts.quarantinedRecords, 2);
  assert.equal(result.counts.incompleteSources, 3);
  for (const source of result.sources) assert.equal(source.status, "incomplete");
  assert.equal(result.records.length, expectedLineCount);
  assert.equal(result.bounds.recordsEmitted, expectedLineCount);
  assert.deepEqual(result.records.map((record) => record.ordinal), result.records.map((_, index) => index));
  assert.deepEqual(result.sources.map((source) => source.sourceId), ["session-a", "history-a", "archive-a"]);

  for (const source of sources) {
    const records = result.records.filter((record) => record.sourceId === source.sourceId);
    const rebuilt = Buffer.concat(records.map((record) => Buffer.from(record.rawLineBase64, "base64")));
    assert.deepEqual(rebuilt, source.bytes);
    for (const record of records) {
      const raw = Buffer.from(record.rawLineBase64, "base64");
      assert.equal(record.lineSha256, sha256(raw));
      assert.equal(record.sourceSha256, source.sha256);
      assert.equal(record.rawLineEncoding, "base64");
      assert.equal(record.disposition, "archive-only-never-resume-or-replay");
    }
  }

  const header = result.records.find((record) => record.category === "session-header");
  assert.equal(header.status, "prepared");
  assert.equal(header.opaque, true);
  assert.equal(header.sessionKey, sessionKey);
  assert.deepEqual(header.search, []);
  assert.match(Buffer.from(header.rawLineBase64, "base64").toString("utf8"), /opaque session summary/);
  assert.match(Buffer.from(header.rawLineBase64, "base64").toString("utf8"), /pending_tool_calls/);
  assert.equal("metadata" in header, false);
  assert.equal("actions" in header, false);

  const provider = result.records.find((record) => record.category === "provider-state");
  assert.equal(provider.status, "prepared");
  assert.equal(provider.opaque, true);
  assert.equal(provider.searchStatus, "none");
  assert.deepEqual(provider.search, []);
  assert.match(Buffer.from(provider.rawLineBase64, "base64").toString("utf8"), /provider-private-token/);

  const messages = result.records.filter((record) => record.category === "session-message");
  assert.equal(messages.length, 3);
  assert.equal(messages[0].search[0].kind, "session-message");
  assert.equal(messages[0].search[0].text, "hello");
  assert.equal(messages[0].sessionKey, sessionKey);
  assert.equal(messages[0].searchStatus, "complete");
  assert.equal(messages[1].search[0].text, "hi there");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].searchStatus, "partial");
  assert.equal(messages[2].search[0].text, "hello again");
  assert.equal(messages[2].searchStatus, "complete");

  const blank = result.records.find((record) => record.category === "blank-line");
  assert.equal(blank.opaque, true);
  assert.equal(blank.rawLineBase64, Buffer.from("\n").toString("base64"));

  const quarantined = result.records.find((record) => record.quarantineReason === "invalid-json");
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.opaque, true);
  assert.deepEqual(quarantined.search, []);
  assert.equal(Buffer.from(quarantined.rawLineBase64, "base64").toString("utf8"), "not json\n");

  const history = result.records.filter((record) => record.category === "history-entry");
  assert.equal(history.length, 3);
  assert.equal(history[0].archiveCursor, 1);
  assert.deepEqual(history[0].search.map((unit) => [unit.kind, unit.text]), [["history-content", "legacy text"]]);
  assert.equal(history[1].archiveCursor, 2);
  assert.equal(history[1].sessionKey, sessionKey);
  assert.deepEqual(
    history[1].search.map((unit) => [unit.kind, unit.role, unit.text]),
    [
      ["history-message", "user", "question"],
      ["history-message", "assistant", "answer"],
      ["history-summary", null, "conversation summary"],
    ],
  );
  assert.equal(history[2].searchStatus, "complete");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "history-kind-unrecognized"), true);

  const archiveHeader = result.records.find((record) => record.category === "archive-header");
  assert.equal(archiveHeader.opaque, true);
  assert.equal(archiveHeader.sessionKey, sessionKey);
  const archiveMessage = result.records.find((record) => record.category === "archive-message");
  assert.equal(archiveMessage.sessionKey, sessionKey);
  assert.equal(archiveMessage.search[0].text, "archived question");
  const unknownArchive = result.records.find((record) => record.quarantineReason === "archive-record-type-unknown");
  assert.equal(unknownArchive.status, "quarantined");
  assert.match(Buffer.from(unknownArchive.rawLineBase64, "base64").toString("utf8"), /batch_manifest/);

  const allSearchText = result.records.flatMap((record) => record.search.map((unit) => unit.text)).join("\n");
  assert.doesNotMatch(allSearchText, /provider-private-token|opaque session summary|opaque objective|call-1|danger/);

  assert.equal(result.counts.providerStateRecords, 1);
  assert.equal(result.counts.quarantinedLines, 2);
  assert.equal(result.unsupportedSources.length, 0);
  assert.equal(result.unsupportedSurfaces.some((surface) => /archive-batch/.test(surface.surface)), true);
});

test("marks mixed, tool-use, media, unknown-block, and extra-block content partial", () => {
  const lines = [
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "visible" }, { type: "image", source: { data: "base64-image" } }],
      timestamp: "2026-07-19T12:00:00+00:00",
      _entry_id: "m1",
    }),
    JSON.stringify({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "lookup", arguments: "{\"q\":\"secret\"}" } }],
      timestamp: "2026-07-19T12:01:00+00:00",
      _entry_id: "m2",
    }),
    JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "prefix" },
        { type: "tool_use", id: "t1", name: "lookup", input: { q: "secret" } },
        { type: "tool_result", content: [{ type: "text", text: "nested-hidden" }] },
      ],
      timestamp: "2026-07-19T12:02:00+00:00",
      _entry_id: "m3",
    }),
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "typed", cache_control: { type: "ephemeral" } }],
      timestamp: "2026-07-19T12:03:00+00:00",
      _entry_id: "m4",
    }),
    JSON.stringify({
      role: "user",
      content: [{ type: "mystery", payload: "opaque" }],
      timestamp: "2026-07-19T12:04:00+00:00",
      _entry_id: "m5",
    }),
    JSON.stringify({
      role: "user",
      content: "plain",
      name: "alice",
      timestamp: "2026-07-19T12:05:00+00:00",
      _entry_id: "m6",
    }),
    JSON.stringify({
      role: "user",
      content: "media text",
      media: [{ type: "image", path: "/private/image.png" }],
      timestamp: "2026-07-19T12:06:00+00:00",
      _entry_id: "m7",
    }),
    JSON.stringify({
      role: "user",
      content: [{ type: "mystery_text", text: "unknown but textual" }],
      timestamp: "2026-07-19T12:07:00+00:00",
      _entry_id: "m8",
    }),
    "",
  ].join("\n");
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [snapshot("session-mixed", "session-jsonl", lines)],
  });
  const messages = result.records.filter((record) => record.category === "session-message");
  assert.deepEqual(messages.map((record) => record.searchStatus), [
    "partial", "partial", "partial", "partial", "partial", "complete", "partial", "partial",
  ]);
  assert.deepEqual(messages[0].search.map((unit) => unit.text), ["visible"]);
  assert.deepEqual(messages[1].search, []);
  assert.deepEqual(messages[2].search.map((unit) => unit.text), ["prefix"]);
  assert.doesNotMatch(messages[2].search.map((unit) => unit.text).join("\n"), /nested-hidden/);
  assert.match(Buffer.from(messages[2].rawLineBase64, "base64").toString("utf8"), /nested-hidden/);
  assert.deepEqual(messages[3].search.map((unit) => unit.text), ["typed"]);
  assert.deepEqual(messages[4].search, []);
  assert.equal(messages[5].search[0].text, "plain");
  assert.equal(messages[5].search[0].name, "alice");
  assert.deepEqual(messages[6].search.map((unit) => unit.text), ["media text"]);
  assert.deepEqual(messages[7].search.map((unit) => unit.text), ["unknown but textual"]);
  assert.match(Buffer.from(messages[0].rawLineBase64, "base64").toString("utf8"), /base64-image/);
  assert.match(Buffer.from(messages[1].rawLineBase64, "base64").toString("utf8"), /secret/);
});

test("marks history search partial for unindexed message and top-level content", () => {
  const history = [
    JSON.stringify({
      timestamp: "2026-07-19T12:00",
      session_key: sessionKey,
      cursor: 1,
      messages: [
        { role: "assistant", content: "answer", tools_used: ["lookup"] },
        { role: "user", content: [{ type: "text", text: "visible" }, { type: "image", source: { data: "img" } }] },
      ],
    }),
    JSON.stringify({
      timestamp: "2026-07-19T12:10",
      session_key: sessionKey,
      cursor: 2,
      messages: [{ role: "user", content: "clean" }],
      extra_field: { note: "opaque top-level content" },
    }),
    JSON.stringify({
      timestamp: "2026-07-19T12:20",
      session_key: sessionKey,
      cursor: 3,
      schema_version: 3,
      kind: "conversation",
      start_time: "2026-07-19T12:20",
      end_time: "2026-07-19T12:20",
      message_count: 1,
      usage: { prompt_tokens: 1 },
      messages: [{ role: "user", content: "clean" }],
      summary: "summary",
    }),
    "",
  ].join("\n");
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [snapshot("history-mixed", "history-jsonl", history)],
  });
  const entries = result.records.filter((record) => record.category === "history-entry");
  assert.deepEqual(entries.map((record) => record.searchStatus), ["partial", "partial", "complete"]);
  assert.deepEqual(entries[0].search.map((unit) => unit.text), ["answer", "visible"]);
  assert.deepEqual(entries[1].search.map((unit) => unit.text), ["clean"]);
  assert.match(Buffer.from(entries[1].rawLineBase64, "base64").toString("utf8"), /opaque top-level content/);
});

test("keeps identical physical lines as distinct records and preserves CRLF/EOF shape", () => {
  const identical = JSON.stringify({ role: "user", content: "same bytes" });
  const bytes = Buffer.from(`${identical}\r\n${identical}\r\n${identical}`, "utf8");
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      { sourceId: "session-lines", format: "session-jsonl", provenance: "synthetic-fixture", sha256: sha256(bytes), bytes },
    ],
  });

  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].lineSha256, result.records[1].lineSha256);
  assert.equal(result.records[0].lineSha256, sha256(Buffer.from(`${identical}\r\n`, "utf8")));
  assert.notEqual(result.records[1].lineSha256, result.records[2].lineSha256);
  assert.deepEqual(result.records.map((record) => record.ordinal), [0, 1, 2]);
  assert.deepEqual(result.records.map((record) => record.line), [1, 2, 3]);
  assert.deepEqual(result.records.map((record) => record.lineTerminated), [true, true, false]);
  assert.equal(result.records[0].byteLength, identical.length + 2);
  assert.equal(result.records[2].byteLength, identical.length);
  assert.deepEqual(
    Buffer.concat(result.records.map((record) => Buffer.from(record.rawLineBase64, "base64"))),
    bytes,
  );
  assert.equal(new Set(result.records.map((record) => record.ordinal)).size, 3);
});

test("preserves caller source order instead of sorting labels", () => {
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      snapshot("z-last", "session-jsonl", `${sessionHeaderLine("z")}\n${JSON.stringify({ role: "user", content: "z" })}\n`),
      snapshot("a-first", "session-jsonl", `${sessionHeaderLine("a")}\n${JSON.stringify({ role: "user", content: "a" })}\n`),
    ],
  });
  assert.deepEqual(result.sources.map((source) => source.sourceId), ["z-last", "a-first"]);
  assert.deepEqual(result.records.map((record) => [record.sourceOrder, record.sourceId]), [
    [0, "z-last"],
    [0, "z-last"],
    [1, "a-first"],
    [1, "a-first"],
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.counts.quarantinedRecords, 0);
});

test("classifies unsupported sources and never claims complete coverage", () => {
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      snapshot("unsupported-batch", "archive-batch-tar", "not parsed"),
      snapshot("session-a", "session-jsonl", `${sessionHeaderLine("kept")}\n${JSON.stringify({ role: "user", content: "kept" })}\n`),
    ],
  });
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].status, "unsupported");
  assert.equal(result.sources[0].lineCount, null);
  assert.equal(result.sources[0].recordsEmitted, 0);
  assert.equal(result.sources[1].status, "complete");
  assert.deepEqual(result.unsupportedSources, [{
    sourceId: "unsupported-batch",
    format: "archive-batch-tar",
    byteLength: Buffer.byteLength("not parsed"),
    sha256: sha256(Buffer.from("not parsed")),
    classification: "unsupported-source-format",
  }]);
  assert.equal(result.records.some((record) => record.sourceId === "unsupported-batch"), false);
  assert.equal(result.records[0].sourceId, "session-a");
  assert.equal(result.unsupportedSurfaces.some((surface) => surface.status === "not-read"), true);
});

test("fails closed on bounds, bad digests, duplicate ids, and malformed requests", () => {
  const twoLines = `${JSON.stringify({ role: "user", content: "a" })}\n${JSON.stringify({ role: "user", content: "b" })}\n`;
  const call = (sources, limits = {}) => prepareArchivalImport({ storeNamespace: "synthetic-store", sources }, { limits });

  assert.throws(
    () => call([snapshot("a", "session-jsonl", "x".repeat(11))], { maxSourceBytes: 10 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([
      snapshot("a", "session-jsonl", "12345"),
      snapshot("b", "session-jsonl", "67890"),
    ], { maxTotalBytes: 9 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("a", "session-jsonl", "a\nb\nc\n")], { maxLinesPerSource: 2 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("a", "session-jsonl", twoLines)], { maxRecords: 1 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("a", "session-jsonl", twoLines)], { maxSearchUnits: 1 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("a", "history-jsonl", `${JSON.stringify({
      timestamp: "2026-07-19T12:00",
      messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }],
    })}\n`)], { maxNestedReferences: 1 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("a", "history-jsonl", `${JSON.stringify({
      timestamp: "2026-07-19T12:00",
      messages: [null, null],
    })}\n`)], { maxDiagnostics: 1 }),
    ArchivalPreparationBoundsError,
  );
  assert.throws(
    () => call([snapshot("same", "session-jsonl", "a"), snapshot("same", "session-jsonl", "b")]),
    ArchivalPreparationInputError,
  );
  const badDigest = snapshot("a", "session-jsonl", "a");
  badDigest.sha256 = "0".repeat(64);
  assert.throws(() => call([badDigest]), /Declared SHA-256/);
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "path/with/slash", sources: [] }),
    /safe storeNamespace/,
  );
  assert.throws(
    () => call([{ ...snapshot("a", "session-jsonl", "a"), format: "x".repeat(161) }]),
    ArchivalPreparationInputError,
  );
});

test("returns deeply frozen output and does not mutate caller bytes", () => {
  const source = snapshot("session-a", "session-jsonl", sessionText);
  const original = Buffer.from(source.bytes);
  const result = prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] });

  assert.deepEqual(source.bytes, original);
  source.bytes.fill(0);
  assert.deepEqual(
    Buffer.concat(result.records.map((record) => Buffer.from(record.rawLineBase64, "base64"))),
    original,
  );

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.bounds), true);
  assert.equal(Object.isFrozen(result.bounds.limits), true);
  assert.equal(Object.isFrozen(result.sources), true);
  assert.equal(Object.isFrozen(result.sources[0]), true);
  assert.equal(Object.isFrozen(result.records), true);
  assert.equal(Object.isFrozen(result.records[0]), true);
  assert.equal(Object.isFrozen(result.records[0].search), true);
  assert.equal(Object.isFrozen(result.records[1].search[0]), true);
  assert.equal(Object.isFrozen(result.unsupportedSurfaces), true);
  assert.equal(Object.isFrozen(result.unsupportedSurfaces[0]), true);
  assert.equal(Object.isFrozen(result.diagnostics), true);
});

test("keeps partial history search and unknown session rows explicit", () => {
  const history = `${JSON.stringify({
    timestamp: "2026-07-19T12:00",
    session_key: sessionKey,
    messages: [
      { role: "user", content: "kept" },
      { role: 5, content: "not indexable" },
    ],
    cursor: 1,
  })}\n`;
  const session = [
    JSON.stringify({ role: "narrator", content: "unknown role" }),
    JSON.stringify({ _type: "mystery", content: "unknown record type" }),
    "",
  ].join("\n");
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      snapshot("history-partial", "history-jsonl", history),
      snapshot("session-unknown", "session-jsonl", session),
    ],
  });

  const entry = result.records.find((record) => record.category === "history-entry");
  assert.equal(entry.status, "prepared");
  assert.equal(entry.searchStatus, "partial");
  assert.deepEqual(entry.search.map((unit) => unit.text), ["kept"]);
  assert.equal(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "history-message-not-indexed" && diagnostic.line === 1), true);

  const unknownRole = result.records.find((record) => record.role === null && record.category === "quarantined-line" &&
    record.quarantineReason === "session-message-shape-invalid");
  assert.equal(unknownRole.status, "quarantined");
  assert.equal(unknownRole.opaque, true);
  assert.match(Buffer.from(unknownRole.rawLineBase64, "base64").toString("utf8"), /unknown role/);
  const unknownType = result.records.find((record) => record.quarantineReason === "session-record-type-unknown");
  assert.equal(unknownType.status, "quarantined");
  assert.match(Buffer.from(unknownType.rawLineBase64, "base64").toString("utf8"), /mystery/);
});

test("marks header diagnostics as failures without dropping records", () => {
  const message = (text) => JSON.stringify({ role: "user", content: text });
  const archiveHeader = (key) => JSON.stringify({ _type: "transcript_archive", key });
  const sources = [
    snapshot("session-missing-header", "session-jsonl", `${message("missing")}\n`),
    snapshot("session-duplicate-header", "session-jsonl",
      `${sessionHeaderLine("h1")}\n${sessionHeaderLine("h1")}\n${message("duplicate")}\n`),
    snapshot("session-out-of-order-header", "session-jsonl",
      `${message("before")}\n${sessionHeaderLine("h2")}\n`),
    snapshot("session-inconsistent-header", "session-jsonl",
      `${sessionHeaderLine("h3")}\n${sessionHeaderLine("h4")}\n${message("inconsistent")}\n`),
    snapshot("session-malformed-header", "session-jsonl",
      `${JSON.stringify({ _type: "metadata", metadata: "not-object" })}\n${message("malformed")}\n`),
    snapshot("archive-missing-header", "session-archive-jsonl", `${message("archive missing")}\n`),
    snapshot("archive-duplicate-header", "session-archive-jsonl",
      `${archiveHeader("a1")}\n${archiveHeader("a1")}\n${message("archive duplicate")}\n`),
    snapshot("archive-out-of-order-header", "session-archive-jsonl",
      `${message("archive before")}\n${archiveHeader("a2")}\n`),
    snapshot("archive-malformed-header", "session-archive-jsonl",
      `${JSON.stringify({ _type: "transcript_archive" })}\n${message("archive malformed")}\n`),
  ];
  const result = prepareArchivalImport({ storeNamespace: "synthetic-store", sources });

  assert.equal(result.complete, false);
  assert.equal(result.counts.incompleteSources, sources.length);
  for (const source of result.sources) assert.equal(source.status, "incomplete");

  for (const code of [
    "session-header-missing",
    "session-header-duplicate",
    "session-header-out-of-order",
    "session-header-key-invalid",
    "session-header-metadata-not-object",
    "header-key-inconsistent",
    "archive-header-missing",
    "archive-header-duplicate",
    "archive-header-out-of-order",
    "archive-header-key-invalid",
  ]) {
    const diagnostic = result.diagnostics.find((item) => item.code === code);
    assert.equal(diagnostic?.severity, "failure", code);
  }

  const counts = Object.fromEntries(result.sources.map((source) => [source.sourceId, source.recordsEmitted]));
  assert.deepEqual(counts, {
    "session-missing-header": 1,
    "session-duplicate-header": 3,
    "session-out-of-order-header": 2,
    "session-inconsistent-header": 3,
    "session-malformed-header": 2,
    "archive-missing-header": 1,
    "archive-duplicate-header": 3,
    "archive-out-of-order-header": 2,
    "archive-malformed-header": 2,
  });
  assert.equal(result.records.filter((record) => record.category === "session-header").length, 6);
  assert.equal(result.records.filter((record) => record.category === "archive-header").length, 4);
});

test("keeps optional metadata diagnostics as notices", () => {
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      snapshot("session-notices", "session-jsonl", [
        sessionHeaderLine("notices"),
        JSON.stringify({
          role: "user",
          content: "notice text",
          timestamp: 123,
          name: 456,
          _entry_id: 789,
        }),
        "",
      ].join("\n")),
    ],
  });

  assert.equal(result.complete, true);
  assert.equal(result.sources[0].status, "complete");
  assert.equal(result.records[1].searchStatus, "partial");
  for (const code of ["message-timestamp-invalid", "message-name-invalid", "message-entry-id-invalid"]) {
    const diagnostic = result.diagnostics.find((item) => item.code === code);
    assert.equal(diagnostic?.severity, "notice", code);
  }
});

test("rejects unsafe format labels instead of echoing them", () => {
  for (const format of ["path/to/secret", "bad\u0000format", "has space", "x".repeat(161)]) {
    assert.throws(
      () => prepareArchivalImport({
        storeNamespace: "synthetic-store",
        sources: [snapshot("source", format, "x")],
      }),
      ArchivalPreparationInputError,
    );
  }
});

test("uses intrinsic typed-array bytes and rejects shared or resizable snapshots", () => {
  class SpoofedBytes extends Uint8Array {
    get byteLength() {
      return 4;
    }
    get byteOffset() {
      return 0;
    }
  }
  const actual = new SpoofedBytes(64);
  actual.fill(0x61);
  const actualBytes = Buffer.from(actual.buffer, 0, 64);
  const source = {
    sourceId: "spoofed",
    format: "session-jsonl",
    provenance: "synthetic-fixture",
    sha256: sha256(actualBytes),
    bytes: actual,
  };
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] },
      { limits: { maxSourceBytes: 4 } }),
    ArchivalPreparationBoundsError,
  );
  const result = prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] });
  assert.equal(result.sources[0].byteLength, 64);
  assert.equal(result.bounds.inputBytes, 64);
  assert.equal(result.records.length, 1);
  assert.equal(Buffer.from(result.records[0].rawLineBase64, "base64").length, 64);
  assert.equal(result.records[0].lineSha256, sha256(actualBytes));

  const sharedBytes = new Uint8Array(new SharedArrayBuffer(8));
  assert.throws(
    () => prepareArchivalImport({
      storeNamespace: "synthetic-store",
      sources: [{
        sourceId: "shared",
        format: "session-jsonl",
        provenance: "synthetic-fixture",
        sha256: sha256(Buffer.from(sharedBytes)),
        bytes: sharedBytes,
      }],
    }),
    /SharedArrayBuffer/,
  );

  const resizableBytes = new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }));
  assert.throws(
    () => prepareArchivalImport({
      storeNamespace: "synthetic-store",
      sources: [{
        sourceId: "resizable",
        format: "session-jsonl",
        provenance: "synthetic-fixture",
        sha256: sha256(Buffer.from(resizableBytes)),
        bytes: resizableBytes,
      }],
    }),
    /resizable ArrayBuffer/,
  );
});

test("rejects inconsistent proxy source arrays", () => {
  const target = [
    snapshot("a", "session-jsonl", `${sessionHeaderLine("a")}\n${JSON.stringify({ role: "user", content: "a" })}\n`),
    snapshot("b", "session-jsonl", `${sessionHeaderLine("b")}\n${JSON.stringify({ role: "user", content: "b" })}\n`),
  ];
  let lengthReads = 0;
  const lyingLength = new Proxy(target, {
    get(value, property, receiver) {
      if (property === "length") {
        lengthReads += 1;
        return lengthReads === 1 ? 1 : 1_000;
      }
      return Reflect.get(value, property, receiver);
    },
  });
  assert.throws(
    () => prepareArchivalImport(
      { storeNamespace: "synthetic-store", sources: lyingLength },
      { limits: { maxSources: 1 } },
    ),
    /inconsistent/,
  );
  const overBound = new Proxy(target, {
    get(value, property, receiver) {
      if (property === "length") return 1_000;
      return Reflect.get(value, property, receiver);
    },
  });
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: overBound },
      { limits: { maxSources: 1 } }),
    ArchivalPreparationBoundsError,
  );
});

test("rejects unknown/cyclic limit objects and never freezes caller limits", () => {
  const source = snapshot("clean", "session-jsonl", `${sessionHeaderLine("clean")}\n`);
  const cyclic = { maxRecords: 1 };
  cyclic.self = cyclic;
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] }, { limits: cyclic }),
    ArchivalPreparationInputError,
  );
  const limits = { maxRecords: 5 };
  const result = prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] }, { limits });
  assert.equal(Object.isFrozen(limits), false);
  assert.equal(Object.hasOwn(result.bounds.limits, "self"), false);
  assert.deepEqual(
    Object.keys(result.bounds.limits).sort(),
    Object.keys(ARCHIVAL_PREPARATION_LIMITS).sort(),
  );
});

test("rejects empty source requests", () => {
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [] }),
    /at least one source/,
  );
});

test("reports empty content and empty message lists as none", () => {
  const session = [
    sessionHeaderLine("empty"),
    JSON.stringify({ role: "user", content: [] }),
    JSON.stringify({ role: "user", content: "" }),
    JSON.stringify({ role: "user", content: [{ type: "text", text: "" }] }),
    "",
  ].join("\n");
  const history = [
    JSON.stringify({ timestamp: "2026-07-19T12:00", session_key: sessionKey, cursor: 1, messages: [] }),
    JSON.stringify({
      timestamp: "2026-07-19T12:01",
      session_key: sessionKey,
      cursor: 2,
      messages: [{ role: "user", content: [] }],
    }),
    JSON.stringify({ timestamp: "2026-07-19T12:02", session_key: sessionKey, cursor: 3, content: "" }),
    "",
  ].join("\n");
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [
      snapshot("session-empty", "session-jsonl", session),
      snapshot("history-empty", "history-jsonl", history),
    ],
  });

  const messages = result.records.filter((record) => record.category === "session-message");
  assert.deepEqual(messages.map((record) => record.searchStatus), ["none", "none", "none"]);
  assert.deepEqual(messages.map((record) => record.search.length), [0, 0, 0]);
  const entries = result.records.filter((record) => record.category === "history-entry");
  assert.deepEqual(entries.map((record) => record.searchStatus), ["none", "none", "none"]);
  assert.deepEqual(entries.map((record) => record.search.length), [0, 0, 0]);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "history-message-text-not-indexed"), false);
  assert.equal(result.complete, true);
});

test("reports input getter and proxy failures as input errors", () => {
  const source = snapshot("input", "session-jsonl", `${sessionHeaderLine("input")}\n`);
  const throwingNamespace = { sources: [source] };
  Object.defineProperty(throwingNamespace, "storeNamespace", {
    get() {
      throw new Error("namespace getter");
    },
    enumerable: true,
  });
  assert.throws(() => prepareArchivalImport(throwingNamespace), ArchivalPreparationInputError);

  const throwingSources = { storeNamespace: "synthetic-store" };
  Object.defineProperty(throwingSources, "sources", {
    get() {
      throw new Error("sources getter");
    },
    enumerable: true,
  });
  assert.throws(() => prepareArchivalImport(throwingSources), ArchivalPreparationInputError);

  const throwingBytes = { ...source };
  Object.defineProperty(throwingBytes, "bytes", {
    get() {
      throw new Error("bytes getter");
    },
    enumerable: true,
  });
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [throwingBytes] }),
    ArchivalPreparationInputError,
  );

  const throwingLimits = {};
  Object.defineProperty(throwingLimits, "limits", {
    get() {
      throw new Error("limits getter");
    },
    enumerable: true,
  });
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: [source] }, throwingLimits),
    ArchivalPreparationInputError,
  );

  const throwingLength = new Proxy([source], {
    get(value, property, receiver) {
      if (property === "length") throw new Error("length getter");
      return Reflect.get(value, property, receiver);
    },
  });
  assert.throws(
    () => prepareArchivalImport({ storeNamespace: "synthetic-store", sources: throwingLength }),
    ArchivalPreparationInputError,
  );
});

test("rejects unknown top-level option keys", () => {
  const source = snapshot("options", "session-jsonl", `${sessionHeaderLine("options")}\n`);
  assert.throws(
    () => prepareArchivalImport(
      { storeNamespace: "synthetic-store", sources: [source] },
      { limits: {}, limit: {} },
    ),
    /Unknown archival preparation option property/,
  );
});

test("classifies unknown future history schema versions as failures", () => {
  const history = `${JSON.stringify({
    timestamp: "2026-07-19T12:00",
    session_key: sessionKey,
    cursor: 1,
    schema_version: 4,
    messages: [{ role: "user", content: "future" }],
  })}\n`;
  const result = prepareArchivalImport({
    storeNamespace: "synthetic-store",
    sources: [snapshot("history-future", "history-jsonl", history)],
  });
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].status, "incomplete");
  assert.equal(result.records[0].category, "history-entry");
  assert.equal(result.records[0].search[0].text, "future");
  const diagnostic = result.diagnostics.find((item) => item.code === "history-schema-version-unknown");
  assert.equal(diagnostic?.severity, "failure");
});
