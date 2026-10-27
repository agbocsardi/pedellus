import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function instrumentedRehearsal(t, replacements) {
  const temporary = await mkdtemp(join(packageRoot, ".rehearsal-instrument-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(join(packageRoot, "dist"), join(temporary, "dist"), { recursive: true });
  const modulePath = join(temporary, "dist/archival-rehearsal/index.js");
  let source = await readFile(modulePath, "utf8");
  for (const [from, to] of replacements) {
    assert.equal(source.includes(from), true, `missing instrumentation marker: ${from}`);
    source = source.replace(from, to);
  }
  await writeFile(modulePath, source);
  return modulePath;
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
  assert.equal(report.queryEchoed, false);
  assert.equal(report.experimental, true);
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.realImportAuthorized, false);
  assert.equal(report.sameUserRaceHardened, false);

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
  assert.equal(report.queryEchoed, true);

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
  assert.equal(applied.queryEchoed, true);

  const zeroHit = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    search: { query: { text: "synthetic no-such-token" } },
  }, context);
  assert.equal(zeroHit.status, "already-applied");
  assert.equal(zeroHit.search.hits.length, 0);
  assert.equal(zeroHit.queryEchoed, true);
  assert.equal(zeroHit.contentExposed, false);

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

  await writeFile(join(fixture.sourceRoot, "sessions/s1.jsonl"), sessionText);
  const namespaceConflict = await runArchivalImportRehearsal({
    ...fixture.options,
    storeNamespace: "different-synthetic-store",
    apply: true,
  }, context);
  assert.equal(namespaceConflict.status, "blocked");
  assert.equal(namespaceConflict.blockers.length, 1);
  assert.equal(namespaceConflict.blockers[0].code, "ledger-namespace-mismatch");
  assert.equal(namespaceConflict.ledger.storeNamespace, fixture.options.storeNamespace);

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
    assert.equal(report.ledger.present, false);
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

test("apply requires explicit per-surface acknowledgement when a known surface is missing", async (t) => {
  const fixture = await makeFixture(t, { history: false, archive: false });
  const blocked = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.destination.databaseOpened, false);
  assert.deepEqual(blocked.blockers.map((blocker) => blocker.code), ["missing-surfaces-not-acknowledged"]);
  assert.deepEqual([...blocked.source.expectedSurfacesMissing].sort(), ["archive", "history", "memory"]);
  assert.deepEqual(await readdir(fixture.destinationDir), []);

  const partialAck = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    acknowledgeMissingSurfaces: ["archive"],
  }, context);
  assert.equal(partialAck.status, "blocked");
  assert.deepEqual(partialAck.blockers.map((blocker) => blocker.code), ["missing-surfaces-not-acknowledged"]);
  assert.deepEqual(partialAck.acknowledgedMissingSurfaces, ["archive"]);
  assert.deepEqual(await readdir(fixture.destinationDir), []);

  const acknowledged = await runArchivalImportRehearsal({
    ...fixture.options,
    apply: true,
    acknowledgeMissingSurfaces: ["archive", "memory", "history"],
  }, context);
  assert.equal(acknowledged.status, "applied");
  assert.equal(acknowledged.ledger.sourceCount, 1);
  assert.deepEqual([...acknowledged.acknowledgedMissingSurfaces].sort(), ["archive", "history", "memory"]);
  assert.deepEqual(acknowledged.blockers, []);

  const dry = await runArchivalImportRehearsal(fixture.options, context);
  assert.equal(dry.status, "dry-run");
  assert.deepEqual([...dry.source.expectedSurfacesMissing].sort(), ["archive", "history", "memory"]);

  await assert.rejects(
    runArchivalImportRehearsal({
      ...fixture.options,
      apply: true,
      acknowledgeMissingSurfaces: ["not-a-surface"],
    }, context),
    /acknowledged surface is invalid/,
  );
});

test("an existing hardlinked destination database is rejected before and after the lock", async (t) => {
  const fixture = await makeFixture(t);
  const outside = join(fixture.base, "outside-notes.txt");
  await writeFile(outside, "user notes that must not change\n");
  const databasePath = join(fixture.destinationDir, "nanobot.sqlite");
  await link(outside, databasePath);

  const before = await readFile(outside, "utf8");
  const blocked = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.destination.databaseOpened, false);
  assert.equal(blocked.blockers.some((blocker) => blocker.code === "destination-database-hardlink"), true);
  assert.equal(await readFile(outside, "utf8"), before);
  assert.deepEqual(await readdir(fixture.destinationDir), ["nanobot.sqlite"]);
  assert.equal((await lstat(databasePath)).nlink, 2);
  await rm(databasePath, { force: true });

  // Force the hardlink to appear only after the pre-lock check: the post-lock
  // check must reject it with the same stable code.
  const outsideLate = join(fixture.base, "late-outside.txt");
  await writeFile(outsideLate, "late user notes\n");
  const modulePath = await instrumentedRehearsal(t, [[
    "const postLockPathBlockers = await databasePathBlockers(paths.databasePath);",
    "await globalThis.__rehearsalAfterLockHook?.(paths.databasePath);\n    const postLockPathBlockers = await databasePathBlockers(paths.databasePath);",
  ]]);
  let hookRan = false;
  globalThis.__rehearsalAfterLockHook = async (path) => {
    hookRan = true;
    await link(outsideLate, path);
  };
  try {
    const { runArchivalImportRehearsal: instrumentedRun } = await import(
      `${pathToFileURL(modulePath).href}?hardlink=${Date.now()}`
    );
    const late = await instrumentedRun({ ...fixture.options, apply: true }, context);
    assert.equal(hookRan, true);
    assert.equal(late.status, "blocked");
    assert.equal(late.destination.lockAcquired, true);
    assert.equal(late.destination.databaseOpened, false);
    assert.equal(late.blockers.some((blocker) => blocker.code === "destination-database-hardlink"), true);
    assert.equal(await readFile(outsideLate, "utf8"), "late user notes\n");
  } finally {
    globalThis.__rehearsalAfterLockHook = undefined;
  }
});

test("pre-planted symlinked WAL/SHM sidecars are rejected before opening the database", async (t) => {
  for (const suffix of ["-wal", "-shm"]) {
    const fixture = await makeFixture(t);
    const outside = join(fixture.base, `outside${suffix}.sqlite`);
    await writeFile(outside, "OUTSIDE-PLACEHOLDER");
    await symlink(outside, join(fixture.destinationDir, `nanobot.sqlite${suffix}`));
    const blocked = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
    assert.equal(blocked.status, "blocked", suffix);
    assert.equal(blocked.destination.databaseOpened, false, suffix);
    assert.equal(blocked.blockers.some((blocker) => blocker.code === "destination-wal-shm-unsafe"), true, suffix);
    assert.equal(await readFile(outside, "utf8"), "OUTSIDE-PLACEHOLDER", suffix);
  }
});

test("apply makes the database 0600 even under umask 0", async (t) => {
  const fixture = await makeFixture(t);
  const prior = process.umask(0);
  let report;
  try {
    report = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  } finally {
    process.umask(prior);
  }
  assert.equal(report.status, "applied");
  assert.equal(report.destination.databaseMode, "0600");
  assert.equal(["private-0600", "absent"].includes(report.destination.walShmMode), true);
  assert.deepEqual(report.privacyLimitations, []);
  const databasePath = join(fixture.destinationDir, "nanobot.sqlite");
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  for (const name of await readdir(fixture.destinationDir)) {
    const mode = (await stat(join(fixture.destinationDir, name))).mode & 0o777;
    assert.equal(mode, 0o600, name);
  }
});

test("a stale ledger source missing from the snapshot blocks instead of reporting already-applied", async (t) => {
  const fixture = await makeFixture(t);
  const first = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(first.status, "applied");
  const removed = first.ledger.sources.find((source) => source.format === "session-archive-jsonl");
  assert.ok(removed);
  const database = new DatabaseSync(join(fixture.destinationDir, "nanobot.sqlite"));
  const conversationsBefore = await tableCount(database, "conversations");
  const entriesBefore = await tableCount(database, "entries");
  database.close();

  await rm(join(fixture.sourceRoot, "sessions/archive/k1/a1.jsonl"));
  const stale = await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  assert.equal(stale.status, "blocked");
  assert.equal(stale.writesPerformed, false);
  assert.equal(stale.ledger.sourceCount, 3);
  assert.deepEqual(
    stale.blockers.filter((blocker) => blocker.code === "ledger-source-not-in-snapshot")
      .map((blocker) => blocker.sourceId),
    [removed.sourceId],
  );
  const after = new DatabaseSync(join(fixture.destinationDir, "nanobot.sqlite"));
  try {
    assert.equal(await tableCount(after, "conversations"), conversationsBefore);
    assert.equal(await tableCount(after, "entries"), entriesBefore);
  } finally {
    after.close();
  }
});

test("limit and ledger-capacity violations are blocked before any batch write", async (t) => {
  const many = async (count) => {
    const fixture = await makeFixture(t, { history: false, archive: false });
    for (let index = 1; index < count; index += 1) {
      await writeFile(join(fixture.sourceRoot, `sessions/s${String(index).padStart(3, "0")}.jsonl`),
        `${JSON.stringify({ role: "user", content: `synthetic ${index}` })}\n`);
    }
    return fixture;
  };

  const preparationLimit = await many(40);
  const prepBlocked = await runArchivalImportRehearsal({
    ...preparationLimit.options,
    apply: true,
    acknowledgeMissingSurfaces: ["archive", "history", "memory"],
    acquisitionLimits: { maxSourcesPerBatch: 33 },
  }, context);
  assert.equal(prepBlocked.status, "blocked");
  assert.equal(prepBlocked.destination.databaseOpened, false);
  assert.equal(prepBlocked.blockers.some((blocker) => blocker.code === "preparation-bound-exceeded"), true);
  assert.deepEqual(await readdir(preparationLimit.destinationDir), []);

  const persistenceLimit = await many(40);
  const persistBlocked = await runArchivalImportRehearsal({
    ...persistenceLimit.options,
    apply: true,
    acknowledgeMissingSurfaces: ["archive", "history", "memory"],
    acquisitionLimits: { maxSourcesPerBatch: 33 },
    preparation: { limits: { maxSources: 128 } },
  }, context);
  assert.equal(persistBlocked.status, "blocked");
  assert.equal(persistBlocked.destination.databaseOpened, false);
  assert.equal(persistBlocked.blockers.some(
    (blocker) => blocker.code === "persistence-preflight-max-sources"), true);
  assert.deepEqual(await readdir(persistenceLimit.destinationDir), []);

  const capacity = await many(513);
  const capacityOptions = {
    ...capacity.options,
    apply: true,
    acknowledgeMissingSurfaces: ["archive", "history", "memory"],
    acquisitionLimits: { maxSources: 600, maxSourcesPerBatch: 128 },
    preparation: { limits: { maxSources: 128 } },
    persistenceLimits: { maxSources: 128 },
  };
  const capacityBlocked = await runArchivalImportRehearsal(capacityOptions, context);
  assert.equal(capacityBlocked.status, "blocked");
  assert.equal(capacityBlocked.destination.databaseOpened, false);
  assert.equal(capacityBlocked.writesPerformed, false);
  assert.equal(capacityBlocked.blockers.some((blocker) => blocker.code === "ledger-capacity-exceeded"), true);
  assert.equal(capacityBlocked.ledger, null);
  assert.deepEqual(await readdir(capacity.destinationDir), []);
  const rerun = await runArchivalImportRehearsal(capacityOptions, context);
  assert.equal(rerun.status, "blocked");
  assert.equal(rerun.blockers.some((blocker) => blocker.code === "ledger-capacity-exceeded"), true);
});

test("persistence overrides above hard caps or malformed block before destination open", async (t) => {
  const fixture = await makeFixture(t);
  const invalidOverrides = [
    { maxSources: 999 },
    { maxLedgerSources: 9_999 },
    { maxRawBytes: 64 * 1024 * 1024 + 1 },
    { maxSources: 0 },
    { unknownLimit: 1 },
    { maxSources: "128" },
  ];
  for (const persistenceLimits of invalidOverrides) {
    const dry = await runArchivalImportRehearsal({ ...fixture.options, persistenceLimits }, context);
    assert.equal(dry.status, "blocked", JSON.stringify(persistenceLimits));
    assert.equal(dry.destination.databaseOpened, false, JSON.stringify(persistenceLimits));
    assert.equal(dry.blockers.some((blocker) => blocker.code === "persistence-input-invalid"), true,
      JSON.stringify(persistenceLimits));
    assert.deepEqual(await readdir(fixture.destinationDir), [], JSON.stringify(persistenceLimits));

    const apply = await runArchivalImportRehearsal({ ...fixture.options, apply: true, persistenceLimits }, context);
    assert.equal(apply.status, "blocked", JSON.stringify(persistenceLimits));
    assert.equal(apply.destination.databaseOpened, false, JSON.stringify(persistenceLimits));
    assert.equal(apply.blockers.some((blocker) => blocker.code === "persistence-input-invalid"), true,
      JSON.stringify(persistenceLimits));
    assert.deepEqual(await readdir(fixture.destinationDir), [], JSON.stringify(persistenceLimits));
  }
});

test("fd-based fchmod does not follow a database path swapped to a symlink", async (t) => {
  const fixture = await makeFixture(t);
  await runArchivalImportRehearsal({ ...fixture.options, apply: true }, context);
  const databasePath = join(fixture.destinationDir, "nanobot.sqlite");
  const outside = join(fixture.base, "outside-mode.txt");
  await writeFile(outside, "outside mode target\n");
  await chmod(outside, 0o664);

  const modulePath = await instrumentedRehearsal(t, [[
    "        await handle.chmod(0o600);",
    "        await globalThis.__rehearsalBeforeFchmodHook?.(path);\n        await handle.chmod(0o600);",
  ]]);
  let swapped = false;
  globalThis.__rehearsalBeforeFchmodHook = async (path) => {
    if (swapped || !path.endsWith("nanobot.sqlite")) return;
    swapped = true;
    await rm(path, { force: true });
    await symlink(outside, path);
  };
  try {
    const { runArchivalImportRehearsal: instrumentedRun } = await import(
      `${pathToFileURL(modulePath).href}?fchmod=${Date.now()}`
    );
    const report = await instrumentedRun({ ...fixture.options, apply: true }, context);
    assert.equal(swapped, true);
    assert.equal(report.status, "blocked");
    assert.equal(report.destination.databaseOpened, true);
    assert.equal(report.blockers.some((blocker) => blocker.code === "destination-database-unsafe"), true);
    assert.equal(report.destination.databaseMode, "not-verified");
    assert.equal(report.privacyLimitations.length > 0, true);
  } finally {
    globalThis.__rehearsalBeforeFchmodHook = undefined;
  }
  // The outside target was never chmodded through the symlink.
  assert.equal((await stat(outside)).mode & 0o777, 0o664);
  assert.equal(await readFile(outside, "utf8"), "outside mode target\n");
});

test("documents the same-user race: a post-lock hardlink swap can migrate an external DB before archival writes block", async (t) => {
  const fixture = await makeFixture(t);
  const outside = join(fixture.base, "outside.sqlite");
  const outsideDb = new DatabaseSync(outside);
  outsideDb.exec("CREATE TABLE outside_notes(x TEXT)");
  outsideDb.exec("INSERT INTO outside_notes VALUES ('preserve me')");
  outsideDb.close();
  const sizeBefore = (await stat(outside)).size;

  const modulePath = await instrumentedRehearsal(t, [[
    "            storage = await openFullSyncNodeSqliteStorage(paths.databasePath, context);",
    "            await globalThis.__rehearsalBeforeOpenHook?.(paths.databasePath);\n            storage = await openFullSyncNodeSqliteStorage(paths.databasePath, context);",
  ]]);
  let hookRan = false;
  globalThis.__rehearsalBeforeOpenHook = async (path) => {
    hookRan = true;
    await link(outside, path);
  };
  let report;
  try {
    const { runArchivalImportRehearsal: instrumentedRun } = await import(
      `${pathToFileURL(modulePath).href}?openrace=${Date.now()}`
    );
    report = await instrumentedRun({ ...fixture.options, apply: true }, context);
  } finally {
    globalThis.__rehearsalBeforeOpenHook = undefined;
  }

  // Documented residual: the post-lock check passed before the hardlink appeared,
  // so SQLite opened/migrated the external inode. The post-open check blocks
  // archival writes, but does not undo Durable migration pages.
  assert.equal(hookRan, true);
  assert.equal(report.status, "blocked");
  assert.equal(report.destination.databaseOpened, true);
  assert.equal(report.blockers.some((blocker) => blocker.code === "destination-database-hardlink"), true);
  assert.equal(report.ledger, null);
  assert.equal(report.experimental, true);
  assert.equal(report.sameUserRaceHardened, false);
  assert.equal(report.realImportAuthorized, false);
  assert.equal((await lstat(join(fixture.destinationDir, "nanobot.sqlite"))).nlink, 2);
  assert.equal((await stat(outside)).size > sizeBefore, true);

  const mutated = new DatabaseSync(outside);
  try {
    assert.equal(mutated.prepare("SELECT x FROM outside_notes").get().x, "preserve me");
    const tables = mutated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.equal(tables.includes("durable_schema"), true);
  } finally {
    mutated.close();
  }
});
