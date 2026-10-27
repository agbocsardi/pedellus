import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/node";
import { createSession } from "@earendil-works/pi-durable";
import { runArchivalImportRehearsal } from "../dist/archival-rehearsal/index.js";
import { readArchivalImportLedger } from "../dist/archival-persist/index.js";
import { openFullSyncNodeSqliteStorage } from "../dist/storage/sqlite.js";

const context = BACKGROUND_CONTEXT;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRETS = [
  "synthetic rehearsal needle",
  "history rehearsal needle",
  "archive rehearsal needle",
  "summary needle",
  "opaque-metadata-token",
  "provider-private-token",
  "rawLineBase64",
];

const sessionText = [
  JSON.stringify({
    _type: "metadata",
    key: "telegram:synthetic",
    metadata: { note: "opaque-metadata-token" },
  }),
  JSON.stringify({
    role: "user",
    content: "synthetic rehearsal needle",
    timestamp: "2026-10-27T00:00:00",
  }),
  JSON.stringify({ _type: "provider_state", opaque_continuation: "provider-private-token" }),
  "",
].join("\n");

const historyText = [
  JSON.stringify({
    timestamp: "2026-10-27T00:00:00",
    session_key: "telegram:synthetic",
    cursor: 3,
    messages: [
      { role: "user", content: "history rehearsal needle" },
      { role: "assistant", content: "history answer", tools_used: ["lookup"] },
    ],
    summary: "summary needle",
  }),
  "",
].join("\n");

const archiveText = [
  JSON.stringify({ _type: "transcript_archive", key: "telegram:synthetic" }),
  JSON.stringify({ role: "assistant", content: "archive rehearsal needle" }),
  "",
].join("\n");

async function makeFixture(t, { sessions = true, history = true, archive = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), "nanobot-rehearsal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = join(base, "source-copy");
  const destinationDir = join(base, "destination");
  const workspace = join(base, "workspace");
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  if (sessions) {
    await mkdir(join(sourceRoot, "sessions"), { recursive: true });
    await writeFile(join(sourceRoot, "sessions/s1.jsonl"), sessionText);
  }
  if (history) {
    await mkdir(join(sourceRoot, "memory"), { recursive: true });
    await writeFile(join(sourceRoot, "memory/history.jsonl"), historyText);
  }
  if (archive) {
    await mkdir(join(sourceRoot, "sessions/archive/k1"), { recursive: true });
    await writeFile(join(sourceRoot, "sessions/archive/k1/a1.jsonl"), archiveText);
  }
  const options = {
    sourceRoot,
    destinationDir,
    workspace,
    storeNamespace: "synthetic-rehearsal-store",
  };
  return { base, sourceRoot, destinationDir, workspace, options };
}

function withoutPaths(text, paths) {
  for (const path of paths) assert.equal(text.includes(path), false, `leaked path ${path}`);
  return text;
}

function serializedWithoutBytes(report) {
  return JSON.stringify(report, (key, value) => (key === "bytes" ? "<bytes>" : value));
}

async function tableCount(database, table) {
  try {
    return database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return 0;
  }
}

test("dry-run acquires and prepares the explicit copy without opening the destination", async (t) => {
  const fixture = await makeFixture(t);
  const report = await runArchivalImportRehearsal(fixture.options, context);

  assert.equal(report.status, "dry-run");
  assert.equal(report.destination.databaseOpened, false);
  assert.equal(report.destination.lockAcquired, false);
  assert.equal(report.destination.durability, "not-opened");
  assert.equal(report.writesPerformed, false);
  assert.equal(report.source.complete, true);
  assert.equal(report.source.surfacesAvailable, 4);
  assert.deepEqual(report.source.expectedSurfacesMissing, []);
  assert.equal(report.source.counts.sourcesAcquired, 3);
  assert.equal(report.batches.length, 1);
  assert.equal(report.batches[0].persistence, null);
  assert.equal(report.batches[0].preparation.complete, true);
  assert.equal(report.batches[0].preparation.recordsPrepared > 0, true);
  assert.equal(report.ledger, null);
  assert.equal(report.search, null);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.storeNamespace, fixture.options.storeNamespace);
  assert.equal(report.contentExposed, false);

  // Dry-run does not even create a database file or lock artifact.
  assert.deepEqual(await readdir(fixture.destinationDir), []);

  const text = withoutPaths(serializedWithoutBytes(report), [
    fixture.base,
    fixture.sourceRoot,
    fixture.destinationDir,
    fixture.workspace,
  ]);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `leaked ${secret}`);
});

test("apply persists all surfaces, inspects the ledger, and searches one bounded page", async (t) => {
  const fixture = await makeFixture(t);
  const report = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    search: { query: { text: "needle" }, limits: { maxHits: 10 } },
  }, context);

  assert.equal(report.status, "applied");
  assert.equal(report.destination.databaseOpened, true);
  assert.equal(report.destination.lockAcquired, true);
  assert.equal(report.destination.durability, "wal-full");
  assert.equal(report.writesPerformed, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.ledger.present, true);
  assert.equal(report.ledger.storeNamespace, fixture.options.storeNamespace);
  assert.equal(report.ledger.sourceCount, 3);
  assert.deepEqual(
    report.ledger.sources.map((source) => source.sourceId).sort(),
    report.batches[0].persistence.sources.map((source) => source.sourceId).sort(),
  );
  for (const row of report.ledger.sources) {
    assert.equal(row.preparationStatus, "complete");
    assert.equal(row.recordCount > 0, true);
    assert.equal(row.conversationId > 0, true);
  }

  assert.equal(report.search.privateResults, true);
  assert.equal(report.search.scanComplete, true);
  assert.equal(report.search.stopReason, "complete");
  assert.equal(report.search.hits.length >= 3, true);
  assert.equal(new Set(report.search.hits.map((hit) => hit.sourceId)).size, 3);
  assert.equal("continuation" in report.search, false);
  assert.equal(report.contentExposed, true);

  const text = withoutPaths(JSON.stringify(report.search), [
    fixture.base,
    fixture.sourceRoot,
    fixture.destinationDir,
    fixture.workspace,
  ]);
  assert.equal(text.includes("rawLineBase64"), false);
  assert.equal(text.includes("provider-private-token"), false);
  assert.equal(text.includes("opaque-metadata-token"), false);
  assert.equal(report.rawArchivalBytesExposed, false);

  const database = new DatabaseSync(join(fixture.destinationDir, "nanobot.sqlite"));
  try {
    assert.equal(await tableCount(database, "conversations"), 3);
    assert.equal(await tableCount(database, "tasks"), 0);
    assert.equal(await tableCount(database, "submissions"), 0);
  } finally {
    database.close();
  }
});

test("a one-page search withholds continuations and reports query errors as blockers", async (t) => {
  const fixture = await makeFixture(t);
  const applied = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    search: { query: { text: "rehearsal needle" }, limits: { maxHits: 1 } },
  }, context);
  assert.equal(applied.status, "applied");
  assert.equal(applied.search.hits.length, 1);
  assert.equal(applied.search.continuationAvailable, true);
  assert.equal("continuation" in applied.search, false);

  const blocked = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    search: { query: { text: "" } },
  }, context);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.search, null);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ["search-input-invalid"]);
  assert.equal(blocked.ledger.present, true);
});

test("rerun is idempotent across batches and keeps source conversation identities", async (t) => {
  const fixture = await makeFixture(t);
  const options = {
    ...fixture.options,
    apply: true,
    acquisitionLimits: { maxSourcesPerBatch: 1 },
  };
  const first = await runArchivalImportRehearsal(options, context);
  assert.equal(first.status, "applied");
  assert.equal(first.batches.length, 3);
  assert.equal(first.batches.every((batch) => batch.persistence.newSourcesPersisted === 1), true);
  assert.equal(first.writesPerformed, true);
  const identities = first.ledger.sources.map((source) => ({
    sourceId: source.sourceId,
    conversationId: source.conversationId,
    firstEntryId: source.firstEntryId,
    lastEntryId: source.lastEntryId,
  }));

  const second = await runArchivalImportRehearsal(options, context);
  assert.equal(second.status, "already-applied");
  assert.equal(second.writesPerformed, false);
  assert.equal(second.batches.length, 3);
  assert.equal(second.batches.every((batch) => batch.persistence.alreadyPersistedSources === 1), true);
  assert.equal(second.batches.every((batch) => batch.persistence.newSourcesPersisted === 0), true);
  assert.deepEqual(second.ledger.sources.map((source) => ({
    sourceId: source.sourceId,
    conversationId: source.conversationId,
    firstEntryId: source.firstEntryId,
    lastEntryId: source.lastEntryId,
  })), identities);
  assert.deepEqual(second.blockers, []);

  const database = new DatabaseSync(join(fixture.destinationDir, "nanobot.sqlite"));
  try {
    assert.equal(await tableCount(database, "conversations"), 3);
    const entryCount = await tableCount(database, "entries");
    assert.equal(entryCount, first.batches.reduce(
      (total, batch) => total + batch.persistence.sources.reduce(
        (sourceTotal, source) => sourceTotal + source.recordsTotal,
        0,
      ),
      0,
    ));
  } finally {
    database.close();
  }
});

test("changed snapshot bytes and a changed namespace are reported as conflicts without overwriting", async (t) => {
  const fixture = await makeFixture(t);
  const first = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(first.status, "applied");
  const sessionSource = first.ledger.sources.find((source) => source.format === "session-jsonl");
  assert.ok(sessionSource);

  await writeFile(join(fixture.sourceRoot, "sessions/s1.jsonl"), `${sessionText}${JSON.stringify({
    role: "user",
    content: "appended after the snapshot",
  })}\n`);
  const changed = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(changed.status, "blocked");
  assert.equal(changed.writesPerformed, false);
  assert.equal(changed.blockers.length, 1);
  assert.equal(changed.blockers[0].code, "persistence-conflict-digest");
  assert.equal(changed.blockers[0].sourceId, sessionSource.sourceId);
  assert.equal(changed.ledger.sources.length, 3);
  assert.equal(changed.ledger.sources.find((source) => source.sourceId === sessionSource.sourceId).sha256,
    sessionSource.sha256);

  const namespaceConflict = await runArchivalImportRehearsal({
    ...fixture.options,
    storeNamespace: "different-synthetic-store",
    apply: true,
  }, context);
  assert.equal(namespaceConflict.status, "blocked");
  assert.equal(namespaceConflict.blockers.length, 1);
  assert.equal(namespaceConflict.blockers[0].code, "persistence-conflict-namespace");
  assert.equal(namespaceConflict.ledger.storeNamespace, fixture.options.storeNamespace);

  await writeFile(join(fixture.sourceRoot, "sessions/s1.jsonl"), sessionText);
  const after = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(after.status, "already-applied");
  assert.equal(after.ledger.sources.length, 3);
});

test("incomplete acquisition and missing surfaces are reported without writes or leaks", async (t) => {
  const incomplete = await makeFixture(t);
  await symlink(join(incomplete.sourceRoot, "sessions/s1.jsonl"),
    join(incomplete.sourceRoot, "sessions/symlink.jsonl"));
  const blocked = await runArchivalImportRehearsal({ ...incomplete.options, apply: true }, context);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.destination.databaseOpened, false);
  assert.equal(blocked.source.complete, false);
  assert.equal(blocked.source.counts.sourcesRejected > 0, true);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ["source-acquisition-incomplete"]);
  assert.equal(blocked.source.diagnostics.some((diagnostic) => diagnostic.severity === "failure"), true);
  assert.deepEqual(await readdir(incomplete.destinationDir), []);
  const text = withoutPaths(JSON.stringify(blocked), [
    incomplete.base,
    incomplete.sourceRoot,
    incomplete.destinationDir,
    incomplete.workspace,
  ]);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `leaked ${secret}`);

  const partialFixture = await makeFixture(t, { history: false, archive: false });
  const missing = await runArchivalImportRehearsal(partialFixture.options, context);
  assert.equal(missing.status, "dry-run");
  assert.equal(missing.source.complete, true);
  assert.deepEqual([...missing.source.expectedSurfacesMissing].sort(), ["archive", "history", "memory"]);

  const emptyBase = await mkdtemp(join(tmpdir(), "nanobot-rehearsal-empty-"));
  t.after(() => rm(emptyBase, { recursive: true, force: true }));
  const emptySource = join(emptyBase, "source");
  const emptyDestination = join(emptyBase, "destination");
  const emptyWorkspace = join(emptyBase, "workspace");
  await mkdir(emptySource, { recursive: true, mode: 0o700 });
  await mkdir(emptyDestination, { recursive: true, mode: 0o700 });
  await mkdir(emptyWorkspace, { recursive: true, mode: 0o700 });
  const empty = await runArchivalImportRehearsal({
    sourceRoot: emptySource,
    destinationDir: emptyDestination,
    workspace: emptyWorkspace,
    storeNamespace: "synthetic-rehearsal-store",
    apply: true,
  }, context);
  assert.equal(empty.status, "blocked");
  assert.equal(empty.blockers.some((blocker) => blocker.code === "source-no-sources"), true);
  assert.deepEqual(await readdir(emptyDestination), []);
});

test("destination safety, overlap, and the Gateway lock are enforced before writes", async (t) => {
  const fixture = await makeFixture(t);

  const nonPrivateBase = await mkdtemp(join(tmpdir(), "nanobot-rehearsal-public-"));
  t.after(() => rm(nonPrivateBase, { recursive: true, force: true }));
  const publicDestination = join(nonPrivateBase, "destination");
  await mkdir(publicDestination, { mode: 0o755 });
  await writeFile(join(publicDestination, "marker"), "keep");
  const publicReport = await runArchivalImportRehearsal({
    ...fixture.options,
    destinationDir: publicDestination,
    apply: true,
  }, context);
  assert.equal(publicReport.status, "blocked");
  assert.equal(publicReport.blockers.some((blocker) => blocker.code === "destination-not-private"), true);
  assert.deepEqual(await readdir(publicDestination), ["marker"]);

  const symlinkDestination = join(fixture.base, "destination-link");
  await symlink(fixture.destinationDir, symlinkDestination);
  const symlinkReport = await runArchivalImportRehearsal({
    ...fixture.options,
    destinationDir: symlinkDestination,
    apply: true,
  }, context);
  assert.equal(symlinkReport.status, "blocked");
  assert.equal(symlinkReport.blockers.some((blocker) => blocker.code === "destination-invalid"), true);
  assert.deepEqual(await readdir(fixture.destinationDir), []);

  const overlapReport = await runArchivalImportRehearsal({
    ...fixture.options,
    destinationDir: join(fixture.workspace, "destination"),
    apply: true,
  }, context);
  assert.equal(overlapReport.status, "blocked");
  assert.equal(overlapReport.blockers.some((blocker) => blocker.code === "destination-invalid"), true);

  await mkdir(join(fixture.workspace, "nested", "destination"), { recursive: true, mode: 0o700 });
  const nestedOverlap = await runArchivalImportRehearsal({
    ...fixture.options,
    destinationDir: join(fixture.workspace, "nested", "destination"),
    apply: true,
  }, context);
  assert.equal(nestedOverlap.status, "blocked");
  assert.equal(nestedOverlap.blockers.some((blocker) => blocker.code === "destination-workspace-overlap"), true);
  assert.deepEqual(await readdir(join(fixture.workspace, "nested", "destination")), []);

  const databaseSymlink = join(fixture.destinationDir, "nanobot.sqlite");
  await writeFile(join(fixture.base, "not-a-database"), "x");
  await symlink(join(fixture.base, "not-a-database"), databaseSymlink);
  const databaseReport = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(databaseReport.status, "blocked");
  assert.equal(databaseReport.blockers.some((blocker) => blocker.code === "destination-database-unsafe"), true);
  await rm(databaseSymlink, { force: true });

  const lockPath = join(fixture.destinationDir, "nanobot.sqlite");
  const release = await processLock(`nanobot:${lockPath}`);
  try {
    const locked = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
    assert.equal(locked.status, "blocked");
    assert.equal(locked.destination.lockAcquired, false);
    assert.equal(locked.blockers.some((blocker) => blocker.code === "destination-lock-unavailable"), true);
    assert.deepEqual(await readdir(fixture.destinationDir), []);
  } finally {
    await release();
  }

  const text = withoutPaths(JSON.stringify(publicReport), [
    nonPrivateBase,
    publicDestination,
    fixture.base,
  ]);
  assert.equal(text.includes("keep"), false);
});

test("a mid-commit storage failure rolls back the destination database", async (t) => {
  const fixture = await makeFixture(t);
  const temporary = await mkdtemp(join(packageRoot, ".rehearsal-instrument-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(join(packageRoot, "dist"), join(temporary, "dist"), { recursive: true });
  const modulePath = join(temporary, "dist/archival-rehearsal/index.js");
  const original = await readFile(modulePath, "utf8");
  const marker = "storage = await openFullSyncNodeSqliteStorage(paths.databasePath, context);";
  assert.equal(original.includes(marker), true, "missing storage hook marker");
  const instrumented = original.replace(
    marker,
    `${marker}\n            if (globalThis.__rehearsalStorageHook) storage = globalThis.__rehearsalStorageHook(storage);`,
  );
  assert.notEqual(instrumented, original);
  await writeFile(modulePath, instrumented);

  let inner;
  globalThis.__rehearsalStorageHook = (storage) => {
    inner = storage;
    return new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "commit") {
          return async (writes, ctx) => target.commit(
            [...writes, { type: "task", value: { id: 999_999_999 } }],
            ctx,
          );
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    const { runArchivalImportRehearsal: instrumentedRun } = await import(
      `${pathToFileURL(modulePath).href}?failure=${Date.now()}`
    );
    const report = await instrumentedRun({ ...fixture.options, apply: true }, context);
    assert.equal(report.status, "blocked");
    assert.equal(report.destination.databaseOpened, true);
    assert.equal(report.ledger, null);
    assert.equal(report.blockers.some((blocker) => blocker.stage === "persistence"), true);
  } finally {
    globalThis.__rehearsalStorageHook = undefined;
    if (inner) await inner.close(context).catch(() => undefined);
  }

  const storage = await openFullSyncNodeSqliteStorage(join(fixture.destinationDir, "nanobot.sqlite"), context);
  const session = createSession(storage);
  try {
    assert.equal(await readArchivalImportLedger(session, context), undefined);
  } finally {
    await session.close(context).catch(() => undefined);
    await storage.close(context).catch(() => undefined);
  }

  const database = new DatabaseSync(join(fixture.destinationDir, "nanobot.sqlite"));
  try {
    for (const table of ["entries", "conversations", "documents", "record_ids", "tasks", "submissions"]) {
      assert.equal(await tableCount(database, table), 0, table);
    }
  } finally {
    database.close();
  }

  // A clean rerun still works after the failed attempt.
  const rerun = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(rerun.status, "applied");
  assert.equal(rerun.ledger.sourceCount, 3);
});

test("invalid option shape is rejected without echoing input values", async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    runArchivalImportRehearsal({ ...fixture.options, unknown: "value" }, context),
    (error) => error.code === "archival_import_rehearsal_input_invalid" &&
      !error.message.includes(fixture.base),
  );
  await assert.rejects(
    runArchivalImportRehearsal({ ...fixture.options, apply: "yes" }, context),
    /apply must be a boolean/,
  );
  await assert.rejects(
    runArchivalImportRehearsal({ ...fixture.options, search: { query: { text: "needle" } } }, context),
    /search requires apply/,
  );
  assert.deepEqual(await readdir(fixture.destinationDir), []);
});

test("paths with a .nanobot component are refused before acquisition or writes", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "nanobot-rehearsal-restricted-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, ".nanobot", "source-copy");
  const destination = join(base, "destination");
  const workspace = join(base, "workspace");
  await mkdir(join(source, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "sessions/s1.jsonl"), sessionText);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });

  const sourceReport = await runArchivalImportRehearsal({
    sourceRoot: source,
    destinationDir: destination,
    workspace,
    storeNamespace: "synthetic-rehearsal-store",
    apply: true,
  }, context);
  assert.equal(sourceReport.status, "blocked");
  assert.equal(sourceReport.blockers.some((blocker) => blocker.code === "source-root-restricted"), true);
  assert.deepEqual(await readdir(destination), []);

  const restrictedDestination = join(base, ".nanobot", "destination");
  const plainSource = join(base, "plain-source");
  await mkdir(join(plainSource, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(join(plainSource, "sessions/s1.jsonl"), sessionText);
  await mkdir(restrictedDestination, { recursive: true, mode: 0o700 });
  const destinationReport = await runArchivalImportRehearsal({
    sourceRoot: plainSource,
    destinationDir: restrictedDestination,
    workspace,
    storeNamespace: "synthetic-rehearsal-store",
    apply: true,
  }, context);
  assert.equal(destinationReport.status, "blocked");
  assert.equal(destinationReport.blockers.some((blocker) => blocker.code === "destination-invalid" ||
    blocker.code === "destination-restricted"), true);
  assert.deepEqual(await readdir(restrictedDestination), []);
});
