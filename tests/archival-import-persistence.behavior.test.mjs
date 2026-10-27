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
  ArchivalPersistenceBoundsError,
  ArchivalPersistenceConflictError,
  ARCHIVAL_PERSISTENCE_FORMAT,
  ARCHIVAL_RECORD_ENTRY_KIND,
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
    assert.equal(report.searchIndexed, false);
    assert.equal(report.runnableStateCreated, false);
    assert.equal(report.sessionMapUpdated, false);
    assert.equal(report.cursorAdvanced, false);
    assert.equal(report.modelEntriesCreated, false);
    assert.equal(report.tasksCreated, false);
    assert.equal(report.submissionsCreated, false);
    assert.equal(Object.isFrozen(report), true);

    const ledger = await readArchivalImportLedger(harness, context);
    assert.equal(ledger.storeNamespace, "synthetic-store");
    assert.deepEqual(ledger.sources.map((source) => source.sourceId), ["session-a", "history-a", "archive-a"]);

    const conversations = await allConversations(harness);
    assert.equal(conversations.length, 3);

    for (const sourceResult of report.sources) {
      assert.equal(sourceResult.status, "persisted");
      assert.ok(Number.isSafeInteger(sourceResult.conversationId));
      const entries = await allEntries(harness, sourceResult.conversationId);
      const expected = prepared.records.filter((record) => record.sourceId === sourceResult.sourceId);
      assert.equal(entries.length, expected.length);
      assert.equal(sourceResult.recordsTotal, expected.length);
      for (const [index, entry] of entries.entries()) {
        assert.equal(entry.kind, ARCHIVAL_RECORD_ENTRY_KIND);
        assert.equal(entry.conversationId, sourceResult.conversationId);
        assert.equal(entry.model, undefined);
        assert.equal(entry.head, undefined);
        assert.equal(entry.edits, undefined);
        const record = expected[index];
        assert.equal(entry.data.schema, "nanobot.archival-record");
        assert.equal(entry.data.sourceId, record.sourceId);
        assert.equal(entry.data.sourceFormat, sourceResult.format);
        assert.equal(entry.data.sourceProvenance, sourceResult.provenance);
        assert.equal(entry.data.sourceSha256, record.sourceSha256);
        assert.equal(entry.data.ordinal, record.ordinal);
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
    assert.notEqual(duplicateA.data.ordinal, duplicateB.data.ordinal);

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

test("unsupported formats are recorded honestly and never fabricated as line records", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const request = {
      storeNamespace: "synthetic-store",
      sources: [snapshot("batch-a", "archive-batch-tar", "synthetic bytes that are not a supported line format")],
    };
    const report = await persistArchivalImport(harness, request, context);
    assert.equal(report.persistencePerformed, false);
    assert.equal(report.unsupportedSourcesNotPersisted, 1);
    assert.deepEqual(report.sources.map((source) => [source.status, source.recordsPersisted, source.conversationId]), [
      ["unsupported-not-persisted", 0, null],
    ]);
    assert.deepEqual(await allConversations(harness), []);
    const ledger = await readArchivalImportLedger(harness, context);
    assert.deepEqual(ledger.sources.map((source) => [source.sourceId, source.preparationStatus, source.recordCount]), [
      ["batch-a", "unsupported", 0],
    ]);

    const repeated = await persistArchivalImport(harness, request, context);
    assert.equal(repeated.alreadyPersistedSources, 1);
    assert.deepEqual(await allConversations(harness), []);
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
