import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  ARCHIVAL_SEARCH_CONTINUATION_TRUST,
  ARCHIVAL_SEARCH_DISPOSITION,
  ARCHIVAL_SEARCH_FORMAT,
  ARCHIVAL_SEARCH_ORDER,
  ARCHIVAL_SEARCH_VERSION,
  ArchivalSearchContinuationError,
  ArchivalSearchInputError,
  searchPersistedArchivalImport,
} from "../dist/archival-search/index.js";
import {
  ArchivalImportLedgerDoc,
  ArchivalRecordEntry,
  persistArchivalImport,
  readArchivalImportLedger,
} from "../dist/archival-persist/index.js";
import { openFullSyncNodeSqliteStorage } from "../dist/storage/sqlite.js";

const context = BACKGROUND_CONTEXT;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = (sourceId, format, text, provenance = "synthetic-search-fixture") => {
  const bytes = Buffer.from(text, "utf8");
  return { sourceId, format, provenance, sha256: sha256(bytes), bytes };
};

const message = (role, content, extra = {}) => ({ role, content, ...extra });
const historyRecord = (timestamp, sessionKey, messages, extra = {}) => ({
  timestamp,
  session_key: sessionKey,
  cursor: 0,
  messages,
  ...extra,
});
const historyText = (records) => records.map((record) => JSON.stringify(record)).join("\n");
const historySource = (sourceId, records) => snapshot(sourceId, "history-jsonl", historyText(records));

async function harnessOn(storage) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return Harness.open(storage, { models, registry: createRegistry() }, context);
}

async function openHarness(database) {
  const storage = await openFullSyncNodeSqliteStorage(database, context);
  return { harness: await harnessOn(storage), storage };
}

async function tempDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-archival-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "archive.sqlite");
}

async function allEntries(harness, conversationId) {
  return harness.commit(async (tx) => {
    const items = [];
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId, order: "ascending" }, 1_000, cursor);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return items;
  }, context);
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

function directUpdateEntry(database, entryId, mutator) {
  const db = new DatabaseSync(database);
  try {
    const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(entryId);
    assert.ok(row, `entry ${entryId} exists`);
    const entry = JSON.parse(row.record);
    mutator(entry);
    db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(entry), entryId);
  } finally {
    db.close();
  }
}

function directDeleteEntry(database, entryId) {
  const db = new DatabaseSync(database);
  try {
    db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
  } finally {
    db.close();
  }
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

const tinyLimits = Object.freeze({
  maxSources: 1,
  maxScanEntries: 1,
  maxScanUnits: 1,
  maxHits: 1,
  maxOutputChars: 5_120,
  maxSnippetChars: 32,
  maxQueryChars: 200,
  scanBatchSize: 1,
});

function assertPageBound(page, maxOutputChars) {
  assert.ok(JSON.stringify(page).length <= maxOutputChars,
    `page JSON ${JSON.stringify(page).length} exceeds ${maxOutputChars}`);
}

function assertNoRawArchivalPayloads(page) {
  const json = JSON.stringify(page);
  assert.equal(json.includes("rawLineBase64"), false);
  assert.equal(json.includes("provider-private-token"), false);
  assert.equal(json.includes("opaque-header-metadata"), false);
  assert.equal(json.includes("opaque-quarantine-payload"), false);
  assert.equal(json.includes("not json"), false);
}

function assertNoLoneSurrogates(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "snippet starts/splits a surrogate pair");
      index++;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), "snippet contains a lone low surrogate");
    }
  }
}

test("searches only prepared text units and preserves durable line identity", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const sessionKey = "telegram:synthetic";
    const sessionText = [
      JSON.stringify({ _type: "metadata", key: sessionKey, metadata: { secret: "opaque-header-metadata" } }),
      JSON.stringify({
        role: "user",
        content: "same synthetic line",
        timestamp: "2026-10-27T00:00:00",
      }),
      JSON.stringify({
        role: "user",
        content: "same synthetic line",
        timestamp: "2026-10-27T00:00:00",
      }),
      JSON.stringify({ _type: "provider_state", opaque_continuation: "provider-private-token" }),
      "not json",
      "",
      JSON.stringify({ _type: "unknown_record", payload: "opaque-quarantine-payload" }),
      "",
    ].join("\n");
    const source = snapshot("session-a", "session-jsonl", sessionText);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);

    const ledger = await readArchivalImportLedger(harness, context);
    const ledgerRow = ledger.sources[0];
    const entries = await allEntries(harness, ledgerRow.conversationId);
    const storedByLine = new Map(entries.map((entry) => [entry.data.line, entry]));

    const page = await searchPersistedArchivalImport(
      harness,
      { text: "same synthetic line" },
      context,
      { limits: { maxHits: 10 } },
    );
    assert.equal(page.format, ARCHIVAL_SEARCH_FORMAT);
    assert.equal(page.version, ARCHIVAL_SEARCH_VERSION);
    assert.equal(page.disposition, ARCHIVAL_SEARCH_DISPOSITION);
    assert.equal(page.order, ARCHIVAL_SEARCH_ORDER);
    assert.equal(page.continuationTrust, ARCHIVAL_SEARCH_CONTINUATION_TRUST);
    assert.equal(page.scanComplete, true);
    assert.equal(page.stopReason, "complete");
    assert.equal(page.continuation, null);
    assert.equal(page.hits.length, 2);
    assert.equal(page.coverage.ledgerPresent, true);
    assert.equal(page.coverage.sourcesFullyScanned, 1);
    assert.equal(page.coverage.sourcesClean, 0);
    assert.equal(page.coverage.sourcesWithCaveats, 1);
    assert.equal(page.coverage.entriesQuarantined >= 2, true);
    assert.equal(page.coverage.entriesOpaque >= 3, true);
    assert.equal(page.coverage.entriesSearchable, 2);
    assert.equal(page.coverage.coverageComplete, false);
    assert.equal(page.coverage.ledgerOnlyCoverage, true);
    assert.equal(page.coverage.unsupportedSourcesOutsideLedger, true);
    assertNoRawArchivalPayloads(page);

    const [first, second] = page.hits;
    assert.equal(first.lineSha256, second.lineSha256);
    assert.notEqual(first.durableKey, second.durableKey);
    assert.notEqual(first.line, second.line);
    assert.notEqual(first.preparationOrdinal, second.preparationOrdinal);
    assert.equal(first.sourceId, "session-a");
    assert.equal(first.sourceFormat, "session-jsonl");
    assert.equal(first.sourceProvenance, "synthetic-search-fixture");
    assert.equal(first.sessionKey, sessionKey);
    assert.equal(first.role, "user");
    assert.equal(first.timestamp, "2026-10-27T00:00:00");
    assert.equal(first.matchCount, 1);
    assert.equal(first.textOmitted, false);
    assert.equal(first.searchStatus, "complete");
    assert.ok(Number.isSafeInteger(first.durableEntryId));
    assert.equal(storedByLine.get(first.line).data.durableKey, first.durableKey);
    assert.equal(storedByLine.get(first.line).id, first.durableEntryId);
    assert.equal(storedByLine.get(first.line).data.preparationOrdinal, first.preparationOrdinal);

    for (const entry of entries) {
      assert.equal(entry.model, undefined);
      assert.equal(entry.head, undefined);
      assert.equal(entry.edits, undefined);
    }
    const inspection = await harness.inspect(context);
    assert.equal(inspection.tasks.length, 0);
    assert.equal(inspection.submissions.length, 0);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("pages by Durable entry ID across independent batches and restarts", async (t) => {
  const database = await tempDatabase(t);
  let opened = await openHarness(database);
  const collected = [];
  try {
    const batch1 = historySource("batch1-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "shared needle one")]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("assistant", "shared needle two")]),
    ]);
    const batch2 = historySource("batch2-a", [
      historyRecord("2026-10-27T00:00:02", "synthetic", [message("user", "shared needle three")]),
    ]);
    const firstReport = await persistArchivalImport(
      opened.harness,
      { storeNamespace: "synthetic-store", sources: [batch1] },
      context,
    );
    const secondReport = await persistArchivalImport(
      opened.harness,
      { storeNamespace: "synthetic-store", sources: [batch2] },
      context,
    );
    assert.equal(firstReport.sources[0].firstPreparationOrdinal, 0);
    assert.equal(firstReport.sources[0].lastPreparationOrdinal, 1);
    assert.equal(secondReport.sources[0].firstPreparationOrdinal, 0);

    const query = { text: "shared needle" };
    const limits = { ...tinyLimits };
    let page = await searchPersistedArchivalImport(opened.harness, query, context, { limits });
    assertPageBound(page, limits.maxOutputChars);
    assert.equal(page.hits.length, 1);
    assert.equal(page.scanComplete, false);
    assert.ok(page.continuation);
    collected.push(...page.hits);

    // The continuation is plain host state, so it survives a close/reopen.
    await opened.harness.close(context);
    await opened.storage.close(context);
    opened = await openHarness(database);

    let continuation = page.continuation;
    let pages = 1;
    while (continuation !== null) {
      assert.ok(pages < 50, "paging did not make progress");
      page = await searchPersistedArchivalImport(opened.harness, query, context, { limits, continuation });
      pages++;
      assertPageBound(page, limits.maxOutputChars);
      assert.ok(page.hits.length <= limits.maxHits);
      collected.push(...page.hits);
      continuation = page.continuation;
      if (continuation !== null) {
        assert.equal(page.scanComplete, false);
        assert.ok(page.coverage.sourcesNotYetScanned > 0);
      }
    }

    assert.equal(page.scanComplete, true);
    assert.equal(page.stopReason, "complete");
    assert.equal(collected.length, 3);
    assert.deepEqual(
      collected.map((hit) => hit.line).sort((a, b) => a - b),
      [1, 1, 2],
    );
    assert.equal(new Set(collected.map((hit) => hit.durableKey)).size, 3);
    assert.equal(new Set(collected.map((hit) => hit.durableEntryId)).size, 3);
    const zeroOrdinalSources = new Set(
      collected.filter((hit) => hit.preparationOrdinal === 0).map((hit) => hit.sourceId),
    );
    assert.deepEqual([...zeroOrdinalSources].sort(), ["batch1-a", "batch2-a"]);
    assert.equal(collected.every((hit) => hit.preparationSourceOrder === 0), true);
    assert.equal(page.coverage.sourcesFullyScanned, 2);
    assert.equal(page.coverage.entriesSearchable, 3);
    assert.equal(page.coverage.sourcesClean, 2);
    assert.equal(page.coverage.coverageComplete, true);
    assert.equal(page.coverage.sourcesNotYetScanned, 0);
  } finally {
    await opened.harness.close(context);
    await opened.storage.close(context);
  }
});

test("reports partial, opaque, quarantine, and mixed-content coverage without returning raw data", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const partialHistory = historySource("history-partial", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "partial needled text")], {
        extra_unindexed: "outside the search projection",
      }),
    ]);
    await persistArchivalImport(
      harness,
      { storeNamespace: "synthetic-store", sources: [partialHistory] },
      context,
    );
    const ledger = await readArchivalImportLedger(harness, context);
    const row = ledger.sources[0];
    await harness.commit(async (tx) => {
      await tx.appendEntry(row.conversationId, {
        kind: "mixed.foreign.entry",
        data: { text: "partial needled foreign-secret" },
      });
    }, context);

    const page = await searchPersistedArchivalImport(
      harness,
      { text: "partial needled" },
      context,
      { limits: { maxHits: 10 } },
    );
    assertPageBound(page, 24_000);
    assert.equal(page.hits.length, 1);
    assert.equal(page.hits[0].searchStatus, "partial");
    assert.equal(page.hits[0].textOmitted, true);
    assert.equal(page.coverage.entriesSearchablePartial, 1);
    assert.equal(page.coverage.entriesUnsearchable >= 1, true);
    assert.equal(page.coverage.sourcesWithCaveats, 1);
    assert.equal(page.coverage.coverageComplete, false);
    assert.equal(JSON.stringify(page).includes("foreign-secret"), false);
    assert.equal(JSON.stringify(page).includes("outside the search projection"), false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("flags duplicate/extra carrier records and empty carriers as incomplete", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("carrier-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "carrier needle one")]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "carrier needle two")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const row = ledger.sources[0];
    const entries = await allEntries(harness, row.conversationId);

    await harness.commit(async (tx) => {
      await tx.appendEntry(ArchivalRecordEntry, row.conversationId, {
        data: { ...entries[0].data },
      });
    }, context);

    const duplicatePage = await searchPersistedArchivalImport(
      harness,
      { text: "carrier needle" },
      context,
      { limits: { maxHits: 10 } },
    );
    assert.equal(duplicatePage.hits.length, 3);
    assert.equal(duplicatePage.coverage.sourcesLedgerMismatch, 1);
    assert.equal(duplicatePage.coverage.sourcesDuplicateOrOutOfOrder, 1);
    assert.equal(duplicatePage.coverage.sourcesWithCaveats, 1);
    assert.equal(duplicatePage.coverage.coverageComplete, false);

    const empty = await harness.commit(
      (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
      context,
    );
    await writeLedger(harness, ledger.storeNamespace, [{
      ...row,
      conversationId: empty.id,
    }]);
    const emptyPage = await searchPersistedArchivalImport(
      harness,
      { text: "carrier needle" },
      context,
      { limits: { maxHits: 10 } },
    );
    assert.equal(emptyPage.hits.length, 0);
    assert.equal(emptyPage.coverage.sourcesLedgerMismatch, 1);
    assert.equal(emptyPage.coverage.sourcesFullyScanned, 1);
    assert.equal(emptyPage.coverage.coverageComplete, false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("recomputes durableKey and flags an identity mismatch as incomplete", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("identity-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "identity needle")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const row = ledger.sources[0];
    const entries = await allEntries(harness, row.conversationId);
    const tamperedKey = "e".repeat(64);
    assert.notEqual(entries[0].data.durableKey, tamperedKey);
    const carrier = await createCarrier(harness, [{
      ...entries[0].data,
      durableKey: tamperedKey,
    }]);
    await writeLedger(harness, ledger.storeNamespace, [{
      ...row,
      conversationId: carrier.conversationId,
      firstEntryId: carrier.entryIds[0],
      lastEntryId: carrier.entryIds[0],
    }]);

    const page = await searchPersistedArchivalImport(
      harness,
      { text: "identity needle" },
      context,
      { limits: { maxHits: 10 } },
    );
    assert.equal(page.hits.length, 1);
    assert.equal(page.hits[0].durableKey, tamperedKey);
    assert.equal(page.coverage.sourcesIdentityMismatch, 1);
    assert.equal(page.coverage.sourcesLedgerMismatch, 1);
    assert.equal(page.coverage.coverageComplete, false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("rejects an in-flight entry whose line/key changed between pages", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("inflight-line", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [
        message("user", "inflight needle one"),
        message("assistant", "inflight needle two"),
      ]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "inflight needle three")]),
      historyRecord("2026-10-27T00:00:02", "synthetic", [message("user", "inflight needle four")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const row = ledger.sources[0];
    const entries = await allEntries(harness, row.conversationId);
    const first = await searchPersistedArchivalImport(
      harness,
      { text: "inflight needle" },
      context,
      { limits: tinyLimits },
    );
    assert.equal(first.continuation.nextEntryId, entries[0].id);
    assert.equal(first.continuation.nextUnit, 1);

    directUpdateEntry(database, entries[0].id, (entry) => {
      entry.data.line = 3;
      entry.data.durableKey = sha256(JSON.stringify([
        "nanobot-archival-line-v1", ledger.storeNamespace, row.sourceId, 3,
      ]));
    });

    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "inflight needle" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /in-flight entry changed/.test(error.message),
    );
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("rejects an in-flight entry whose unit list was reordered between pages", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("inflight-units", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [
        message("user", "unit needle zero"),
        message("assistant", "unit filler one"),
        message("user", "unit target two"),
      ]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const row = ledger.sources[0];
    const entries = await allEntries(harness, row.conversationId);
    const first = await searchPersistedArchivalImport(
      harness,
      { text: "unit target" },
      context,
      { limits: tinyLimits },
    );
    assert.equal(first.hits.length, 0);
    assert.equal(first.continuation.nextUnit, 1);

    directUpdateEntry(database, entries[0].id, (entry) => {
      const [zero, one, two] = entry.data.search;
      entry.data.search = [{ ...two, unit: 0 }, { ...one, unit: 1 }, { ...zero, unit: 2 }];
    });

    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "unit target" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /in-flight entry changed/.test(error.message),
    );
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("rejects deletion of an in-flight entry between pages", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("inflight-delete", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [
        message("user", "delete needle one"),
        message("assistant", "delete needle two"),
      ]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "delete needle three")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const entries = await allEntries(harness, ledger.sources[0].conversationId);
    const first = await searchPersistedArchivalImport(
      harness,
      { text: "delete needle" },
      context,
      { limits: tinyLimits },
    );
    assert.equal(first.continuation.nextEntryId, entries[0].id);
    assert.equal(first.continuation.nextUnit, 1);
    directDeleteEntry(database, entries[0].id);

    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "delete needle" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /in-flight entry is missing/.test(error.message),
    );
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("resets unit position when a named fresh entry was deleted", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("fresh-delete", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "fresh needle one")]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "fresh needle two")]),
      historyRecord("2026-10-27T00:00:02", "synthetic", [message("user", "fresh needle three")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const ledger = await readArchivalImportLedger(harness, context);
    const entries = await allEntries(harness, ledger.sources[0].conversationId);
    const limits = { ...tinyLimits, maxHits: 1, maxScanUnits: 10, maxScanEntries: 10, scanBatchSize: 10 };
    const first = await searchPersistedArchivalImport(
      harness,
      { text: "fresh needle" },
      context,
      { limits },
    );
    assert.equal(first.hits.length, 1);
    assert.equal(first.continuation.nextEntryId, entries[0].id + 1);
    assert.equal(first.continuation.currentEntryClassified, false);
    const namedFresh = entries.find((entry) => entry.id >= first.continuation.nextEntryId);
    assert.ok(namedFresh);
    directDeleteEntry(database, namedFresh.id);

    const hits = [...first.hits];
    let continuation = first.continuation;
    let last;
    let guard = 0;
    do {
      last = await searchPersistedArchivalImport(
        harness,
        { text: "fresh needle" },
        context,
        { limits, continuation },
      );
      hits.push(...last.hits);
      continuation = last.continuation;
      if (++guard > 20) throw new Error("fresh-delete paging did not progress");
    } while (continuation !== null);

    assert.equal(hits.every((hit) => hit.unitIndex === 0), true);
    assert.equal(last.coverage.sourcesLedgerMismatch, 1);
    assert.equal(last.coverage.coverageComplete, false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("matches literal Unicode text case-insensitively and keeps snippets surrogate-safe", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("unicode-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "Café déjà vu — synthetic")]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "Emoji 👩‍💻 in message")]),
      historyRecord("2026-10-27T00:00:02", "synthetic", [message("assistant", "ÉLAN final")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);

    const accented = await searchPersistedArchivalImport(harness, { text: "café" }, context);
    assert.equal(accented.hits.length, 1);
    assert.equal(accented.hits[0].snippet.includes("Café"), true);
    assertNoLoneSurrogates(accented.hits[0].snippet);

    const caseSensitive = await searchPersistedArchivalImport(
      harness,
      { text: "café", caseSensitive: true },
      context,
    );
    assert.equal(caseSensitive.hits.length, 0);

    const emoji = await searchPersistedArchivalImport(
      harness,
      { text: "👩‍💻" },
      context,
      { limits: { maxSnippetChars: 2 } },
    );
    assert.equal(emoji.hits.length, 1);
    assert.equal(emoji.hits[0].matchLength, 5);
    assert.equal(emoji.hits[0].snippet.isWellFormed(), true);
    assertNoLoneSurrogates(emoji.hits[0].snippet);

    const roleFiltered = await searchPersistedArchivalImport(
      harness,
      { text: "ÉLAN", role: "assistant" },
      context,
    );
    assert.equal(roleFiltered.hits.length, 1);
    assert.equal(roleFiltered.hits[0].role, "assistant");
    assert.equal(roleFiltered.hits[0].timestamp, "2026-10-27T00:00:02");
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("scopes by source and reports unsupported or unavailable ledger rows honestly", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const sourceA = historySource("scope-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "scope needle a")]),
    ]);
    const sourceB = historySource("scope-b", [
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "scope needle b")]),
    ]);
    await persistArchivalImport(
      harness,
      { storeNamespace: "synthetic-store", sources: [sourceA, sourceB] },
      context,
    );
    const scoped = await searchPersistedArchivalImport(
      harness,
      { text: "scope needle", sourceIds: ["scope-b"] },
      context,
    );
    assert.equal(scoped.hits.length, 1);
    assert.equal(scoped.hits[0].sourceId, "scope-b");
    assert.equal(scoped.coverage.sourcesInScope, 1);
    assert.equal(scoped.coverage.sourcesScopeExcluded, 1);
    assert.equal(scoped.coverage.sourcesFullyScanned, 1);

    const ledger = await readArchivalImportLedger(harness, context);
    const base = ledger.sources.find((row) => row.sourceId === "scope-a");
    const unsupported = {
      ...base,
      sourceId: "scope-unsupported",
      sha256: "c".repeat(64),
      byteLength: 0,
      lineCount: 0,
      preparationStatus: "unsupported",
      recordCount: 0,
      searchUnitCount: 0,
      conversationId: null,
      firstEntryId: null,
      lastEntryId: null,
      firstLine: null,
      lastLine: null,
      firstPreparationOrdinal: null,
      lastPreparationOrdinal: null,
    };
    const unavailable = {
      ...base,
      sourceId: "scope-unavailable",
      sha256: "d".repeat(64),
      byteLength: 0,
      lineCount: 0,
      recordCount: 0,
      searchUnitCount: 0,
      conversationId: 999_999,
      firstEntryId: null,
      lastEntryId: null,
      firstLine: null,
      lastLine: null,
      firstPreparationOrdinal: null,
      lastPreparationOrdinal: null,
    };
    await writeLedger(harness, ledger.storeNamespace, [...ledger.sources, unsupported, unavailable]);

    const page = await searchPersistedArchivalImport(harness, { text: "scope needle" }, context);
    assert.equal(page.hits.length, 2);
    assert.equal(page.scanComplete, true);
    assert.equal(page.coverage.sourcesUnsupported, 1);
    assert.equal(page.coverage.sourcesUnavailable, 1);
    assert.equal(page.coverage.sourcesFullyScanned, 2);
    assert.equal(page.coverage.coverageComplete, false);
    assert.equal(page.coverage.ledgerOnlyCoverage, true);

    await assert.rejects(
      () => searchPersistedArchivalImport(harness, { text: "scope needle", sourceIds: [] }, context),
      (error) => error instanceof ArchivalSearchInputError,
    );
    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "scope needle", sourceIds: ["scope-does-not-exist"] },
        context,
      ),
      (error) => error instanceof ArchivalSearchInputError,
    );
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("resumes mid-entry at unit boundaries and keeps page output bounded", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const multi = historySource("multi-unit", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [
        message("user", "multi needle one"),
        message("assistant", "multi needle two"),
        message("user", "multi needle three"),
      ]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [multi] }, context);

    const limits = {
      ...tinyLimits,
      maxScanEntries: 10,
      maxScanUnits: 10,
      maxSources: 10,
      maxHits: 1,
      maxOutputChars: 5_120,
      maxSnippetChars: 24,
      scanBatchSize: 10,
    };
    const collected = [];
    const stopReasons = new Set();
    let continuation = null;
    const midEntryUnits = [];
    let pages = 0;
    do {
      const page = await searchPersistedArchivalImport(
        harness,
        { text: "multi needle" },
        context,
        { limits, ...(continuation === null ? {} : { continuation }) },
      );
      pages++;
      assert.ok(pages < 20, "unit paging did not make progress");
      assertPageBound(page, limits.maxOutputChars);
      assert.ok(page.hits.length <= limits.maxHits);
      stopReasons.add(page.stopReason);
      collected.push(...page.hits);
      if (page.progress.nextUnit !== null && page.progress.nextUnit > 0) {
        midEntryUnits.push(page.progress.nextUnit);
      }
      continuation = page.continuation;
    } while (continuation !== null);

    assert.equal(collected.length, 3);
    assert.deepEqual(
      collected.map((hit) => hit.unitIndex),
      [0, 1, 2],
    );
    assert.deepEqual(midEntryUnits, [1, 2]);
    assert.equal(new Set(collected.map((hit) => hit.durableKey)).size, 1);
    assert.equal(new Set(collected.map((hit) => hit.unitKind)).size, 1);
    assert.equal(stopReasons.has("max-hits"), true);
    assert.equal(stopReasons.has("complete"), true);
    assert.equal(pages >= 4, true);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("searches entries larger than maxScanUnits across bounded unit pages", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const completeMessages = [];
    const partialMessages = [];
    for (let index = 0; index < 7; index++) {
      completeMessages.push(message(index % 2 === 0 ? "user" : "assistant", `large needle complete-${index}`));
      partialMessages.push(message(index % 2 === 0 ? "assistant" : "user", `large needle partial-${index}`));
    }
    const source = historySource("large-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", completeMessages),
      historyRecord("2026-10-27T00:00:01", "synthetic", partialMessages, {
        extra_unindexed: "large partial omission marker",
      }),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);

    const limits = {
      maxSources: 4,
      maxScanEntries: 10,
      maxScanUnits: 3,
      maxHits: 100,
      maxOutputChars: 24_000,
      maxSnippetChars: 40,
      maxQueryChars: 200,
      scanBatchSize: 10,
    };
    const collected = [];
    const stopReasons = new Set();
    const midEntryProgress = new Map();
    let continuation = null;
    let pages = 0;
    let page;
    do {
      page = await searchPersistedArchivalImport(
        harness,
        { text: "large needle" },
        context,
        { limits, ...(continuation === null ? {} : { continuation }) },
      );
      pages++;
      assert.ok(pages < 30, "large-entry paging did not make progress");
      assertPageBound(page, limits.maxOutputChars);
      assert.ok(page.hits.length <= limits.maxHits);
      assert.ok(page.progress.unitsScannedThisPage <= limits.maxScanUnits);
      if (page.hits.length > 0) assert.ok(page.progress.unitsScannedThisPage > 0);
      stopReasons.add(page.stopReason);
      collected.push(...page.hits);
      if (page.continuation !== null && page.continuation.nextUnit > 0) {
        const entryId = page.continuation.nextEntryId;
        const previous = midEntryProgress.get(entryId);
        if (previous !== undefined) assert.ok(page.continuation.nextUnit > previous);
        midEntryProgress.set(entryId, page.continuation.nextUnit);
        assert.equal(page.coverage.entriesUnsearchable, 0);
      }
      if (page.coverage.entriesSearchablePartial > 0) {
        assert.equal(page.coverage.coverageComplete, false);
      }
      continuation = page.continuation;
    } while (continuation !== null);

    assert.equal(pages >= 5, true);
    assert.equal(collected.length, 14);
    assert.equal(stopReasons.has("max-units"), true);
    assert.equal(stopReasons.has("complete"), true);

    const byLine = new Map();
    for (const hit of collected) {
      const list = byLine.get(hit.line) ?? [];
      list.push(hit);
      byLine.set(hit.line, list);
    }
    assert.deepEqual([...byLine.keys()].sort((a, b) => a - b), [1, 2]);
    for (const [line, hits] of byLine) {
      assert.deepEqual(hits.map((hit) => hit.unitIndex).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
      if (line === 1) {
        assert.equal(hits.every((hit) => hit.searchStatus === "complete"), true);
        assert.equal(hits.every((hit) => hit.textOmitted === false), true);
      } else {
        assert.equal(hits.every((hit) => hit.searchStatus === "partial"), true);
        assert.equal(hits.every((hit) => hit.textOmitted === true), true);
      }
    }

    assert.equal(page.scanComplete, true);
    assert.equal(page.coverage.entriesScanned, 2);
    assert.equal(page.coverage.entriesSearchable, 1);
    assert.equal(page.coverage.entriesSearchablePartial, 1);
    assert.equal(page.coverage.entriesNoSearchText, 0);
    assert.equal(page.coverage.entriesUnsearchable, 0);
    assert.equal(page.coverage.unitsScanned, 14);
    assert.equal(page.coverage.unitsInvalid, 0);
    assert.equal(page.coverage.hits, 14);
    assert.equal(page.coverage.sourcesFullyScanned, 1);
    assert.equal(page.coverage.sourcesWithCaveats, 1);
    assert.equal(page.coverage.coverageComplete, false);

    // The same large entries must remain fully reachable when output trimming
    // stops a page in the middle of an entry, including at its first unit.
    const outputLimits = {
      ...limits,
      maxOutputChars: 5_120,
      maxSnippetChars: 24,
    };
    const outputHits = [];
    const outputStopReasons = new Set();
    let outputContinuation = null;
    let outputPages = 0;
    let outputPage;
    do {
      outputPage = await searchPersistedArchivalImport(
        harness,
        { text: "large needle" },
        context,
        { limits: outputLimits, ...(outputContinuation === null ? {} : { continuation: outputContinuation }) },
      );
      outputPages++;
      assert.ok(outputPages < 40, "large-entry output paging did not make progress");
      assertPageBound(outputPage, outputLimits.maxOutputChars);
      outputStopReasons.add(outputPage.stopReason);
      outputHits.push(...outputPage.hits);
      assert.equal(outputPage.coverage.entriesUnsearchable, 0);
      outputContinuation = outputPage.continuation;
    } while (outputContinuation !== null);

    assert.equal(outputHits.length, 14);
    assert.equal(new Set(outputHits.map((hit) => `${hit.durableKey}:${hit.unitIndex}`)).size, 14);
    assert.equal(outputStopReasons.has("max-output-chars"), true);
    assert.equal(outputPage.scanComplete, true);
    assert.equal(outputPage.coverage.entriesSearchable, 1);
    assert.equal(outputPage.coverage.entriesSearchablePartial, 1);
    assert.equal(outputPage.coverage.entriesUnsearchable, 0);
    assert.equal(outputPage.coverage.unitsScanned, 14);
    assert.equal(outputPage.coverage.hits, 14);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("bounds output and entry work while making progress at the smallest limits", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const records = [];
    for (let index = 1; index <= 12; index++) {
      records.push(historyRecord(
        `2026-10-27T00:00:${String(index).padStart(2, "0")}`,
        "synthetic",
        [message(index % 2 === 0 ? "assistant" : "user", `bound needle ${index}`)],
      ));
    }
    const source = historySource("bounds-a", records);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);

    const limits = {
      ...tinyLimits,
      maxScanEntries: 6,
      maxScanUnits: 6,
      maxSources: 4,
      maxHits: 100,
      maxOutputChars: 5_120,
      maxSnippetChars: 400,
      scanBatchSize: 6,
    };
    const collected = [];
    const stopReasons = new Set();
    let continuation = null;
    let pages = 0;
    do {
      const page = await searchPersistedArchivalImport(
        harness,
        { text: "bound needle" },
        context,
        { limits, ...(continuation === null ? {} : { continuation }) },
      );
      pages++;
      assert.ok(pages < 40, "bounded paging did not make progress");
      assertPageBound(page, limits.maxOutputChars);
      assert.ok(page.hits.length <= limits.maxHits);
      assert.ok(page.progress.entriesScannedThisPage <= limits.maxScanEntries);
      assert.ok(page.progress.unitsScannedThisPage <= limits.maxScanUnits);
      stopReasons.add(page.stopReason);
      collected.push(...page.hits);
      continuation = page.continuation;
    } while (continuation !== null);

    assert.equal(collected.length, 12);
    assert.equal(new Set(collected.map((hit) => hit.durableKey)).size, 12);
    assert.equal(stopReasons.has("max-output-chars"), true);
    assert.equal(stopReasons.has("complete"), true);
    assert.equal(pages >= 2, true);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("rejects stale or mismatched continuations and returns no-ledger honestly", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const empty = await searchPersistedArchivalImport(harness, { text: "nothing" }, context);
    assert.equal(empty.stopReason, "no-ledger");
    assert.equal(empty.hits.length, 0);
    assert.equal(empty.scanComplete, true);
    assert.equal(empty.coverage.ledgerPresent, false);
    assert.equal(empty.coverage.coverageComplete, false);
    assert.equal(empty.continuation, null);

    const source = historySource("stale-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "stale needle one")]),
      historyRecord("2026-10-27T00:00:01", "synthetic", [message("user", "stale needle two")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const first = await searchPersistedArchivalImport(
      harness,
      { text: "stale needle" },
      context,
      { limits: { ...tinyLimits, maxHits: 1 } },
    );
    assert.ok(first.continuation);

    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "different query" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && error instanceof ArchivalSearchInputError,
    );

    const ledgerBeforeMutation = await readArchivalImportLedger(harness, context);
    const mutatedRows = ledgerBeforeMutation.sources.map((row) => row.sourceId === "stale-a"
      ? { ...row, preparationStatus: "incomplete" }
      : row);
    await writeLedger(harness, ledgerBeforeMutation.storeNamespace, mutatedRows);
    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "stale needle" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /ledger digest/.test(error.message),
    );
    await writeLedger(harness, ledgerBeforeMutation.storeNamespace, ledgerBeforeMutation.sources);

    const countMutatedRows = ledgerBeforeMutation.sources.map((row) => row.sourceId === "stale-a"
      ? { ...row, recordCount: row.recordCount + 1 }
      : row);
    await writeLedger(harness, ledgerBeforeMutation.storeNamespace, countMutatedRows);
    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "stale needle" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /ledger digest/.test(error.message),
    );
    await writeLedger(harness, ledgerBeforeMutation.storeNamespace, ledgerBeforeMutation.sources);

    const extra = historySource("stale-b", [
      historyRecord("2026-10-27T00:00:02", "synthetic", [message("user", "stale needle three")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [extra] }, context);
    await assert.rejects(
      () => searchPersistedArchivalImport(
        harness,
        { text: "stale needle" },
        context,
        { limits: tinyLimits, continuation: first.continuation },
      ),
      (error) => error instanceof ArchivalSearchContinuationError && /ledger/.test(error.message),
    );
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("search is read-only: no new conversations, entries, tasks, or submissions", async (t) => {
  const database = await tempDatabase(t);
  const { harness, storage } = await openHarness(database);
  try {
    const source = historySource("readonly-a", [
      historyRecord("2026-10-27T00:00:00", "synthetic", [message("user", "readonly needle")]),
    ]);
    await persistArchivalImport(harness, { storeNamespace: "synthetic-store", sources: [source] }, context);
    const conversationsBefore = await allConversations(harness);
    const ledgerBefore = await readArchivalImportLedger(harness, context);
    const entriesBefore = await allEntries(harness, ledgerBefore.sources[0].conversationId);

    const page = await searchPersistedArchivalImport(harness, { text: "readonly needle" }, context);
    assert.equal(page.hits.length, 1);

    const conversationsAfter = await allConversations(harness);
    const ledgerAfter = await readArchivalImportLedger(harness, context);
    const entriesAfter = await allEntries(harness, ledgerAfter.sources[0].conversationId);
    assert.equal(conversationsAfter.length, conversationsBefore.length);
    assert.deepEqual(ledgerAfter, ledgerBefore);
    assert.equal(entriesAfter.length, entriesBefore.length);
    const inspection = await harness.inspect(context);
    assert.equal(inspection.tasks.length, 0);
    assert.equal(inspection.submissions.length, 0);
    assert.equal(JSON.stringify(page).includes("rawLineBase64"), false);
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});
