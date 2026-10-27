import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { prepareArchivalImport } from "../dist/archival-import/index.js";
import {
  ArchivalImportLedgerDoc,
  ArchivalPersistenceBoundsError,
  ArchivalPersistenceConflictError,
  ArchivalPersistenceCorruptionError,
  ArchivalRecordEntry,
  ARCHIVAL_LEDGER_FORMAT,
  ARCHIVAL_LEDGER_VERSION,
  ARCHIVAL_PERSISTENCE_FORMAT,
  ARCHIVAL_PERSISTENCE_OWNERSHIP,
  ARCHIVAL_RECORD_ENTRY_KIND,
  ARCHIVAL_RECORD_SCHEMA,
  ARCHIVAL_RECORD_SCHEMA_VERSION,
  persistArchivalImport,
  readArchivalImportLedger,
} from "../dist/archival-persist/index.js";
import { openFullSyncNodeSqliteStorage } from "../dist/storage/sqlite.js";

const context = BACKGROUND_CONTEXT;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = (sourceId, format, text, provenance = "synthetic-fixture") => {
  const bytes = Buffer.from(text, "utf8");
  return { sourceId, format, provenance, sha256: sha256(bytes), bytes };
};

const sessionKey = "telegram:synthetic";
const sessionText = [
  JSON.stringify({ _type: "metadata", key: sessionKey, metadata: { note: "opaque metadata" } }),
  JSON.stringify({ role: "user", content: "same synthetic line", timestamp: "2026-10-27T00:00:00" }),
  JSON.stringify({ role: "user", content: "same synthetic line", timestamp: "2026-10-27T00:00:00" }),
  JSON.stringify({ _type: "provider_state", opaque_continuation: "provider-private-token" }),
  "not json",
  JSON.stringify({ _type: "unknown_record", payload: "preserve me" }),
  "",
].join("\n");

const historyText = [
  JSON.stringify({
    timestamp: "2026-10-27T00:00:00",
    session_key: sessionKey,
    cursor: 7,
    messages: [
      { role: "user", content: "synthetic question" },
      { role: "assistant", content: "synthetic answer", tools_used: ["lookup"] },
    ],
    summary: "synthetic summary",
  }),
  "",
].join("\n");

const archiveText = [
  JSON.stringify({ _type: "transcript_archive", key: sessionKey }),
  JSON.stringify({ role: "user", content: "archived synthetic question" }),
  "",
].join("\n");

function syntheticRequest(namespace = "synthetic-store") {
  return {
    storeNamespace: namespace,
    sources: [
      snapshot("session-a", "session-jsonl", sessionText),
      snapshot("history-a", "history-jsonl", historyText),
      snapshot("archive-a", "session-archive-jsonl", archiveText),
    ],
  };
}

async function openHarness(database) {
  const storage = await openFullSyncNodeSqliteStorage(database, context);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  return { harness, storage };
}

async function allEntries(harness, conversationId) {
  const conversation = await harness.conversation(conversationId, context);
  assert.ok(conversation, `conversation ${conversationId}`);
  const items = [];
  let cursor;
  do {
    const page = await conversation.entries({ order: "ascending" }, 1_000, cursor, context);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

async function allConversations(harness) {
  return harness.commit(async (tx) => {
    const items = [];
    let cursor;
    do {
      const page = await tx.scanConversations({}, 1_000, cursor);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return items;
  }, context);
}

async function allSessionDocuments(storage) {
  const items = [];
  let cursor;
  do {
    const page = await storage.scanDocuments(
      { scope: { kind: "session" }, at: "current" },
      1_000,
      cursor,
      context,
    );
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

const durableKeyFor = (storeNamespace, sourceId, line) => createHash("sha256")
  .update(JSON.stringify(["nanobot-archival-line-v1", storeNamespace, sourceId, line]))
  .digest("hex");

function entryDataFor(report, source, record, overrides = {}) {
  return {
    schema: ARCHIVAL_RECORD_SCHEMA,
    schemaVersion: ARCHIVAL_RECORD_SCHEMA_VERSION,
    durableKey: durableKeyFor(report.storeNamespace, source.sourceId, record.line),
    storeNamespace: report.storeNamespace,
    sourceId: source.sourceId,
    sourceFormat: source.format,
    sourceProvenance: source.provenance,
    sourceSha256: source.sha256,
    recordVersion: record.recordVersion,
    preparationOrdinal: record.ordinal,
    preparationSourceOrder: record.sourceOrder,
    line: record.line,
    byteOffset: record.byteOffset,
    byteLength: record.byteLength,
    lineTerminated: record.lineTerminated,
    lineSha256: record.lineSha256,
    category: record.category,
    status: record.status,
    quarantineReason: record.quarantineReason,
    opaque: record.opaque,
    searchStatus: record.searchStatus,
    disposition: record.disposition,
    sessionKey: record.sessionKey,
    timestamp: record.timestamp,
    role: record.role,
    archiveCursor: record.archiveCursor,
    search: record.search.map((unit) => ({
      unit: unit.unit,
      kind: unit.kind,
      role: unit.role,
      timestamp: unit.timestamp,
      name: unit.name,
      entryId: unit.entryId,
      text: unit.text,
    })),
    rawLineBase64: record.rawLineBase64,
    rawLineEncoding: "base64",
    ...overrides,
  };
}

async function createCarrier(harness, dataList) {
  return harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const entryIds = [];
    for (const data of dataList) {
      const entry = await tx.appendEntry(ArchivalRecordEntry, conversation.id, { data });
      entryIds.push(entry.id);
    }
    return { conversationId: conversation.id, entryIds };
  }, context);
}

async function writeLedger(harness, storeNamespace, rows) {
  await harness.commit(async (tx) => {
    const ledger = await tx.doc(ArchivalImportLedgerDoc);
    ledger.storeNamespace = storeNamespace;
    ledger.sources.splice(0, ledger.sources.length);
    for (const row of rows) ledger.sources.push(row);
  }, context);
}

function ledgerRow(report, source, records, carrier, overrides = {}) {
  return {
    sourceId: source.sourceId,
    format: source.format,
    provenance: source.provenance,
    sha256: source.sha256,
    byteLength: source.byteLength,
    lineCount: source.lineCount,
    preparationStatus: source.status,
    preparationFormat: report.format,
    preparationVersion: report.version,
    recordSchemaVersion: ARCHIVAL_RECORD_SCHEMA_VERSION,
    recordCount: records.length,
    searchUnitCount: source.searchUnitsEmitted,
    conversationId: carrier.conversationId,
    firstEntryId: carrier.entryIds[0] ?? null,
    lastEntryId: carrier.entryIds[carrier.entryIds.length - 1] ?? null,
    firstLine: records[0]?.line ?? null,
    lastLine: records[records.length - 1]?.line ?? null,
    firstPreparationOrdinal: records[0]?.ordinal ?? null,
    lastPreparationOrdinal: records[records.length - 1]?.ordinal ?? null,
    ...overrides,
  };
}

async function tempDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-archival-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "archive.sqlite");
}

test("persists exact raw lines and provenance as inert custom entries only", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const request = syntheticRequest();
    const prepared = prepareArchivalImport(request);
    const report = await persistArchivalImport(harness, request, context);

    assert.equal(report.format, ARCHIVAL_PERSISTENCE_FORMAT);
    assert.equal(report.disposition, "archive-only-never-resume-or-replay");
    assert.equal(report.persistencePerformed, true);
    assert.equal(report.newSourcesPersisted, 3);
    assert.equal(report.alreadyPersistedSources, 0);
    assert.equal(report.preparation.complete, false);
    assert.equal(report.sources.find((source) => source.sourceId === "session-a").preparationStatus, "incomplete");
    assert.match(report.limitations.join(" "), /not encryption/);
    assert.match(report.limitations.join(" "), /not the runtime session map/);
    assert.equal(JSON.stringify(report).includes("provider-private-token"), false);
    assert.equal(JSON.stringify(report).includes("same synthetic line"), false);
    assert.equal(report.counts.recordsPersisted, prepared.records.length);
    assert.equal(report.ownershipRequirement, ARCHIVAL_PERSISTENCE_OWNERSHIP);
    assert.equal(report.searchIntegration, "future-index-must-use-durable-key-not-preparation-ordinal");
    assert.equal(report.bounds.maxLedgerSources, 512);
    assert.match(report.limitations.join(" "), /exclusive single-writer/);
    assert.match(report.limitations.join(" "), /Gateway scans conversations/);
    assert.match(report.limitations.join(" "), /512 sources/);
    assert.equal(report.searchIndexed, false);
    assert.equal(report.runnableStateCreated, false);
    assert.equal(report.sessionMapUpdated, false);
    assert.equal(report.cursorAdvanced, false);
    assert.equal(report.modelEntriesCreated, false);
    assert.equal(report.tasksCreated, false);
    assert.equal(report.submissionsCreated, false);
    assert.equal(Object.isFrozen(report), true);

    const ledger = await readArchivalImportLedger(harness, context);
    assert.equal(ledger.format, ARCHIVAL_LEDGER_FORMAT);
    assert.equal(ledger.version, ARCHIVAL_LEDGER_VERSION);
    assert.equal(ledger.storeNamespace, "synthetic-store");
    assert.deepEqual(ledger.sources.map((source) => source.sourceId), ["session-a", "history-a", "archive-a"]);
    assert.equal(ledger.sources.every((source) => source.recordSchemaVersion === ARCHIVAL_RECORD_SCHEMA_VERSION), true);

    const conversations = await allConversations(harness);
    assert.equal(conversations.length, 3);

    for (const sourceResult of report.sources) {
      assert.equal(sourceResult.status, "persisted");
      assert.ok(Number.isSafeInteger(sourceResult.conversationId));
      const entries = await allEntries(harness, sourceResult.conversationId);
      const expected = prepared.records.filter((record) => record.sourceId === sourceResult.sourceId);
      assert.equal(entries.length, expected.length);
      assert.equal(sourceResult.recordsTotal, expected.length);
      assert.equal(sourceResult.recordSchemaVersion, ARCHIVAL_RECORD_SCHEMA_VERSION);
      assert.equal(sourceResult.firstLine, expected[0]?.line ?? null);
      assert.equal(sourceResult.lastLine, expected[expected.length - 1]?.line ?? null);
      assert.equal(sourceResult.firstPreparationOrdinal, expected[0]?.ordinal ?? null);
      assert.equal(sourceResult.lastPreparationOrdinal, expected[expected.length - 1]?.ordinal ?? null);
      for (const [index, entry] of entries.entries()) {
        assert.equal(entry.kind, ARCHIVAL_RECORD_ENTRY_KIND);
        assert.equal(entry.conversationId, sourceResult.conversationId);
        assert.equal(entry.model, undefined);
        assert.equal(entry.head, undefined);
        assert.equal(entry.edits, undefined);
        const record = expected[index];
        assert.equal(entry.data.schema, ARCHIVAL_RECORD_SCHEMA);
        assert.equal(entry.data.sourceId, record.sourceId);
        assert.equal(entry.data.sourceFormat, sourceResult.format);
        assert.equal(entry.data.sourceProvenance, sourceResult.provenance);
        assert.equal(entry.data.sourceSha256, record.sourceSha256);
        assert.equal(entry.data.preparationOrdinal, record.ordinal);
        assert.equal(entry.data.preparationSourceOrder, record.sourceOrder);
        assert.equal(entry.data.schemaVersion, ARCHIVAL_RECORD_SCHEMA_VERSION);
        assert.equal(typeof entry.data.durableKey, "string");
        assert.equal(entry.data.durableKey.length, 64);
        assert.equal(entry.data.line, record.line);
        assert.equal(entry.data.lineSha256, record.lineSha256);
        assert.equal(entry.data.role, record.role);
        assert.equal(entry.data.sessionKey, record.sessionKey);
        assert.equal(entry.data.archiveCursor, record.archiveCursor);
        assert.equal(entry.data.rawLineEncoding, "base64");
        assert.equal(entry.data.rawLineBase64, record.rawLineBase64);
        assert.equal(entry.data.disposition, "archive-only-never-resume-or-replay");
      }
      const rebuilt = Buffer.concat(entries.map((entry) => Buffer.from(entry.data.rawLineBase64, "base64")));
      const original = request.sources.find((source) => source.sourceId === sourceResult.sourceId).bytes;
      assert.deepEqual(rebuilt, original);
    }

    const sessionEntries = await allEntries(harness, report.sources[0].conversationId);
    assert.equal(sessionEntries.some((entry) => entry.data.quarantineReason === "invalid-json"), true);
    assert.equal(sessionEntries.some((entry) => entry.data.category === "provider-state"), true);
    assert.equal(sessionEntries.some((entry) => entry.data.category === "quarantined-line"), true);

    // Identical physical lines remain distinct records; line identity is not deduplication.
    const duplicateA = sessionEntries.find((entry) => entry.data.line === 2);
    const duplicateB = sessionEntries.find((entry) => entry.data.line === 3);
    assert.equal(duplicateA.data.lineSha256, duplicateB.data.lineSha256);
    assert.notEqual(duplicateA.data.preparationOrdinal, duplicateB.data.preparationOrdinal);
    assert.notEqual(duplicateA.data.durableKey, duplicateB.data.durableKey);

    // No runtime model/task/submission/session-map state was created.
    const inspection = await harness.inspect(context);
    assert.equal(inspection.tasks.length, 0);
    assert.equal(inspection.submissions.length, 0);
    const documents = await allSessionDocuments(storage);
    assert.equal(documents.some((document) => document.kind === "nanobot.session-map"), false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("repeat is idempotent within one process and after restart", async (t) => {
  const database = await tempDatabase(t);
  const request = syntheticRequest();
  let first;
  {
    const { harness, storage } = await openHarness(database);
    try {
      first = await persistArchivalImport(harness, request, context);
      const second = await persistArchivalImport(harness, request, context);
      assert.equal(second.persistencePerformed, false);
      assert.equal(second.newSourcesPersisted, 0);
      assert.equal(second.alreadyPersistedSources, 3);
      assert.deepEqual(
        second.sources.map((source) => [source.status, source.conversationId]),
        first.sources.map((source) => ["already-persisted", source.conversationId]),
      );
      assert.equal((await allConversations(harness)).length, 3);
      assert.equal((await allSessionDocuments(storage)).filter((doc) => doc.kind === "nanobot-archival-import-ledger").length, 1);
    } finally {
      await harness.close(context);
      await storage.close(context);
    }
  }

  // Reopen the same native Harness/SQLite store and retry the exact snapshots.
  const { harness, storage } = await openHarness(database);
  try {
    const repeated = await persistArchivalImport(harness, request, context);
    assert.equal(repeated.persistencePerformed, false);
    assert.equal(repeated.alreadyPersistedSources, 3);
    assert.equal((await allConversations(harness)).length, 3);
    for (const source of first.sources) {
      const entries = await allEntries(harness, source.conversationId);
      assert.equal(entries.length, source.recordsTotal);
      assert.equal(new Set(entries.map((entry) => entry.data.rawLineBase64)).size > 0, true);
    }
    const ledger = await readArchivalImportLedger(harness, context);
    assert.deepEqual(ledger.sources.map((source) => source.sha256), request.sources.map((source) => source.sha256));
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("rejects a changed digest, namespace, or metadata instead of losing or duplicating a source", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const request = syntheticRequest();
    const first = await persistArchivalImport(harness, request, context);
    const beforeConversations = await allConversations(harness);
    const beforeLedger = await readArchivalImportLedger(harness, context);

    const changed = {
      storeNamespace: "synthetic-store",
      sources: [
        snapshot("session-a", "session-jsonl", `${sessionText}${JSON.stringify({ role: "user", content: "changed" })}\n`),
      ],
    };
    await assert.rejects(
      persistArchivalImport(harness, changed, context),
      (error) => error instanceof ArchivalPersistenceConflictError && error.sourceId === "session-a",
    );
    assert.equal((await allConversations(harness)).length, beforeConversations.length);
    assert.deepEqual(await readArchivalImportLedger(harness, context), beforeLedger);

    // A conflict on one source aborts the whole transaction: the new source is not persisted.
    const mixed = {
      storeNamespace: "synthetic-store",
      sources: [
        changed.sources[0],
        snapshot("new-source", "session-jsonl", `${JSON.stringify({ _type: "metadata", key: "new", metadata: {} })}\n`),
      ],
    };
    await assert.rejects(persistArchivalImport(harness, mixed, context), ArchivalPersistenceConflictError);
    assert.equal((await allConversations(harness)).length, beforeConversations.length);
    const afterMixed = await readArchivalImportLedger(harness, context);
    assert.equal(afterMixed.sources.some((source) => source.sourceId === "new-source"), false);

    await assert.rejects(
      persistArchivalImport(harness, {
        storeNamespace: "different-store",
        sources: [snapshot("other", "session-jsonl", `${JSON.stringify({ _type: "metadata", key: "other", metadata: {} })}\n`)],
      }, context),
      ArchivalPersistenceConflictError,
    );
    assert.equal((await allConversations(harness)).length, beforeConversations.length);

    // A forged prepared-record field is ignored; original snapshots are the only input boundary.
    const forged = {
      ...request,
      records: [{ rawLineBase64: Buffer.from("forged").toString("base64"), line: 999 }],
      report: { complete: true, records: [{ sourceId: "forged" }] },
    };
    const afterForged = await persistArchivalImport(harness, forged, context);
    assert.equal(afterForged.persistencePerformed, false);
    assert.equal(afterForged.alreadyPersistedSources, 3);
    assert.equal((await allConversations(harness)).length, beforeConversations.length);
    assert.equal(first.sources.every((source) => source.conversationId === afterForged.sources.find(
      (candidate) => candidate.sourceId === source.sourceId,
    ).conversationId), true);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("a failed storage commit leaves no ledger, conversation, or entry behind", async (t) => {
  const database = await tempDatabase(t);
  const inner = await openFullSyncNodeSqliteStorage(database, context);
  const failing = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return async () => {
          throw new Error("synthetic commit failure");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(failing, { models, registry: createRegistry() }, context);
  try {
    await assert.rejects(
      persistArchivalImport(harness, syntheticRequest(), context),
      /synthetic commit failure/,
    );
  } finally {
    await harness.close(context).catch(() => {});
    await inner.close(context).catch(() => {});
  }

  const reopened = await openHarness(database);
  try {
    assert.equal(await readArchivalImportLedger(reopened.harness, context), undefined);
    assert.deepEqual(await allConversations(reopened.harness), []);
    assert.equal((await allSessionDocuments(reopened.storage)).length, 0);
  } finally {
    await reopened.harness.close(context);
    await reopened.storage.close(context);
  }
});

test("unsupported formats are not ledgered and remain retryable after support", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const unsupported = {
      storeNamespace: "synthetic-store",
      sources: [snapshot("batch-a", "archive-batch-tar", "synthetic bytes that are not a supported line format")],
    };
    const report = await persistArchivalImport(harness, unsupported, context);
    assert.equal(report.persistencePerformed, false);
    assert.equal(report.unsupportedSourcesNotPersisted, 1);
    assert.deepEqual(report.sources.map((source) => [
      source.status, source.recordsPersisted, source.conversationId, source.recordSchemaVersion,
    ]), [["unsupported-not-persisted", 0, null, null]]);
    assert.deepEqual(await allConversations(harness), []);
    // No permanent ledger row: an unsupported source is not a claimed import.
    assert.equal(await readArchivalImportLedger(harness, context), undefined);

    const repeated = await persistArchivalImport(harness, unsupported, context);
    assert.equal(repeated.alreadyPersistedSources, 0);
    assert.equal(repeated.unsupportedSourcesNotPersisted, 1);
    assert.equal(await readArchivalImportLedger(harness, context), undefined);
    assert.deepEqual(await allConversations(harness), []);

    // The same sourceId can be imported later if the host supplies a supported format.
    const supported = {
      storeNamespace: "synthetic-store",
      sources: [
        snapshot("batch-a", "session-jsonl",
          `${JSON.stringify({ _type: "metadata", key: "batch", metadata: {} })}\n${JSON.stringify({ role: "user", content: "later" })}\n`),
      ],
    };
    const later = await persistArchivalImport(harness, supported, context);
    assert.equal(later.newSourcesPersisted, 1);
    assert.equal(later.sources[0].status, "persisted");
    assert.equal(later.sources[0].recordSchemaVersion, ARCHIVAL_RECORD_SCHEMA_VERSION);
    const ledger = await readArchivalImportLedger(harness, context);
    assert.deepEqual(ledger.sources.map((source) => [source.sourceId, source.recordCount]), [["batch-a", 2]]);
    assert.equal((await allConversations(harness)).length, 1);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("persistence bounds fail before any write", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    await assert.rejects(
      persistArchivalImport(harness, syntheticRequest(), context, { limits: { maxRecords: 1 } }),
      ArchivalPersistenceBoundsError,
    );
    assert.equal(await readArchivalImportLedger(harness, context), undefined);
    assert.deepEqual(await allConversations(harness), []);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("readArchivalImportLedger returns a detached deeply frozen copy", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    await persistArchivalImport(harness, syntheticRequest(), context);
    const ledger = await readArchivalImportLedger(harness, context);
    assert.equal(Object.isFrozen(ledger), true);
    assert.equal(Object.isFrozen(ledger.sources), true);
    assert.equal(Object.isFrozen(ledger.sources[0]), true);
    assert.throws(() => { ledger.storeNamespace = "mutated"; }, TypeError);
    assert.throws(() => { ledger.sources[0].sha256 = "0".repeat(64); }, TypeError);
    assert.throws(() => { ledger.sources.push({}); }, TypeError);

    const again = await readArchivalImportLedger(harness, context);
    assert.notEqual(again, ledger);
    assert.notEqual(again.sources[0], ledger.sources[0]);
    assert.equal(again.storeNamespace, "synthetic-store");
    assert.deepEqual(again, ledger);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("repeat fully verifies every stored line and rejects tamper/missing/extra", async (t) => {
  const text = [
    JSON.stringify({ _type: "metadata", key: "verify", metadata: {} }),
    JSON.stringify({ role: "user", content: "verify one" }),
    JSON.stringify({ role: "assistant", content: "verify two" }),
    "",
  ].join("\n");
  const request = {
    storeNamespace: "synthetic-store",
    sources: [snapshot("verify-source", "session-jsonl", text)],
  };
  const prepared = prepareArchivalImport(request);
  const source = prepared.sources[0];
  const records = prepared.records;
  assert.equal(records.length, 3);

  const scenarios = [
    {
      name: "middle-line tamper",
      data: () => records.map((record) => entryDataFor(prepared, source, record)),
      mutate(data) {
        data[1] = { ...data[1], rawLineBase64: Buffer.from("tampered\n").toString("base64") };
      },
    },
    {
      name: "middle-line missing",
      data: () => [entryDataFor(prepared, source, records[0]), entryDataFor(prepared, source, records[2])],
      mutate() {},
    },
    {
      name: "extra entry",
      data: () => [
        ...records.map((record) => entryDataFor(prepared, source, record)),
        entryDataFor(prepared, source, records[2]),
      ],
      mutate() {},
    },
    {
      name: "provenance tamper",
      data: () => records.map((record) => entryDataFor(prepared, source, record)),
      mutate(data) {
        data[1] = { ...data[1], sourceSha256: "0".repeat(64) };
      },
    },
    {
      name: "order tamper",
      data: () => [
        entryDataFor(prepared, source, records[0]),
        entryDataFor(prepared, source, records[2]),
        entryDataFor(prepared, source, records[1]),
      ],
      mutate() {},
    },
  ];

  for (const scenario of scenarios) {
    const database = await tempDatabase(t);
    const { harness, storage } = await openHarness(database);
    try {
      const data = scenario.data();
      scenario.mutate(data);
      const carrier = await createCarrier(harness, data);
      await writeLedger(harness, request.storeNamespace, [
        ledgerRow(prepared, source, records, carrier),
      ]);
      await assert.rejects(
        persistArchivalImport(harness, request, context),
        ArchivalPersistenceCorruptionError,
        scenario.name,
      );
      // The rejected retry neither appended nor replaced anything.
      assert.equal((await allConversations(harness)).length, 1, scenario.name);
      const ledger = await readArchivalImportLedger(harness, context);
      assert.equal(ledger.sources[0].conversationId, carrier.conversationId, scenario.name);
    } finally {
      await harness.close(context);
      await storage.close(context);
    }
  }
});

test("full verification ignores request-relative ordinals and uses durable line identity", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const header = (key) => JSON.stringify({ _type: "metadata", key, metadata: {} });
    const message = (text) => JSON.stringify({ role: "user", content: text });
    const sourceA = snapshot("ordinal-a", "session-jsonl", `${header("a")}\n${message("a")}\n`);
    const sourceB = snapshot("ordinal-b", "session-jsonl", `${header("b")}\n${message("b1")}\n${message("b2")}\n`);
    const sourceC = snapshot("ordinal-c", "session-jsonl", `${header("c")}\n${message("c")}\n`);

    const both = await persistArchivalImport(harness, {
      storeNamespace: "synthetic-store",
      sources: [sourceA, sourceB],
    }, context);
    const aResult = both.sources.find((source) => source.sourceId === "ordinal-a");
    const bResult = both.sources.find((source) => source.sourceId === "ordinal-b");
    const aEntries = await allEntries(harness, aResult.conversationId);
    const bEntries = await allEntries(harness, bResult.conversationId);
    assert.deepEqual(bEntries.map((entry) => entry.data.preparationOrdinal), [2, 3, 4]);

    // Re-submit B alone: its recomputed preparation ordinals reset to 0..1, but durable verification
    // must compare (sourceId, line) and raw lines, not request-relative ordinals.
    const repeatB = await persistArchivalImport(harness, {
      storeNamespace: "synthetic-store",
      sources: [sourceB],
    }, context);
    assert.equal(repeatB.sources[0].status, "already-persisted");
    assert.equal(repeatB.sources[0].conversationId, bResult.conversationId);
    assert.equal((await allEntries(harness, bResult.conversationId)).length, bEntries.length);

    // A separate batch resets ordinals to 0 again; keys stay distinct by source identity.
    const cReport = await persistArchivalImport(harness, {
      storeNamespace: "synthetic-store",
      sources: [sourceC],
    }, context);
    const cEntries = await allEntries(harness, cReport.sources[0].conversationId);
    assert.equal(aEntries[0].data.preparationOrdinal, cEntries[0].data.preparationOrdinal);
    assert.notEqual(aEntries[0].data.durableKey, cEntries[0].data.durableKey);
    const allKeys = [...aEntries, ...bEntries, ...cEntries].map((entry) => entry.data.durableKey);
    assert.equal(new Set(allKeys).size, allKeys.length);
    assert.equal(cReport.searchIntegration, "future-index-must-use-durable-key-not-preparation-ordinal");
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("explicit format, provenance, preparation, and record-schema conflicts require reconciliation", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const text = [
      JSON.stringify({ _type: "metadata", key: "conflict", metadata: {} }),
      JSON.stringify({ role: "user", content: "conflict" }),
      "",
    ].join("\n");
    const request = {
      storeNamespace: "synthetic-store",
      sources: [snapshot("conflict-source", "session-jsonl", text)],
    };
    const prepared = prepareArchivalImport(request);
    await persistArchivalImport(harness, request, context);
    const conversationsBefore = (await allConversations(harness)).length;

    const changedFormat = {
      storeNamespace: "synthetic-store",
      sources: [snapshot("conflict-source", "history-jsonl", text)],
    };
    await assert.rejects(
      persistArchivalImport(harness, changedFormat, context),
      (error) => error instanceof ArchivalPersistenceConflictError && error.reason === "format",
    );

    const changedProvenance = {
      storeNamespace: "synthetic-store",
      sources: [snapshot("conflict-source", "session-jsonl", text, "different-provenance")],
    };
    await assert.rejects(
      persistArchivalImport(harness, changedProvenance, context),
      (error) => error instanceof ArchivalPersistenceConflictError && error.reason === "provenance",
    );

    await harness.commit(async (tx) => {
      const ledger = await tx.doc(ArchivalImportLedgerDoc);
      ledger.sources[0].preparationVersion = 0;
    }, context);
    await assert.rejects(
      persistArchivalImport(harness, request, context),
      (error) => error instanceof ArchivalPersistenceConflictError && error.reason === "preparation-version",
    );

    await harness.commit(async (tx) => {
      const ledger = await tx.doc(ArchivalImportLedgerDoc);
      ledger.sources[0].preparationVersion = prepared.version;
      ledger.sources[0].recordSchemaVersion = 1;
    }, context);
    await assert.rejects(
      persistArchivalImport(harness, request, context),
      (error) => error instanceof ArchivalPersistenceConflictError && error.reason === "record-schema-version",
    );
    assert.equal((await allConversations(harness)).length, conversationsBefore);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});
