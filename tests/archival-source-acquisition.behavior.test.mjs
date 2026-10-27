import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ARCHIVAL_SOURCE_ACQUISITION_FORMAT,
  ARCHIVAL_SOURCE_ACQUISITION_LIMITS,
  ARCHIVAL_SOURCE_ACQUISITION_VERSION,
  ArchivalSourceBoundsError,
  ArchivalSourceInputError,
  acquireLegacySourceSnapshots,
  prepareAcquiredArchivalImport,
} from "../dist/archival-source/index.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sessionText = (key = "synthetic:1") => [
  JSON.stringify({ _type: "metadata", key, metadata: {} }),
  JSON.stringify({
    role: "user",
    content: "synthetic hello",
    timestamp: "2026-10-27T12:00:00+00:00",
    _entry_id: "m1",
  }),
  "",
].join("\n");

const archiveText = (key = "synthetic:1") => [
  JSON.stringify({ _type: "transcript_archive", key }),
  JSON.stringify({
    role: "assistant",
    content: "synthetic archived answer",
    timestamp: "2026-10-27T12:01:00+00:00",
  }),
  "",
].join("\n");

const historyText = [
  JSON.stringify({
    schema_version: 3,
    kind: "conversation",
    timestamp: "2026-10-27T12:02:00",
    start_time: "2026-10-27T12:00:00",
    end_time: "2026-10-27T12:02:00",
    session_key: "synthetic:1",
    message_count: 1,
    messages: [
      { timestamp: "2026-10-27T12:00:00", role: "user", content: "synthetic question" },
    ],
    summary: "synthetic summary",
    cursor: 1,
  }),
  "",
].join("\n");

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "nanobot-archival-source-"));
  return root;
}

async function writeFixture(root, relativePath, text) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function removeRoot(root) {
  await rm(root, { recursive: true, force: true });
}

function serializedWithoutBytes(report) {
  return JSON.stringify(report, (key, value) => (key === "bytes" ? "<bytes>" : value));
}

async function makeInstrumentedModule() {
  const temporary = await mkdtemp(join(tmpdir(), "nanobot-archival-race-"));
  await mkdir(join(temporary, "archival-import"), { recursive: true });
  await mkdir(join(temporary, "archival-source"), { recursive: true });
  await copyFile(
    new URL("../dist/archival-import/index.js", import.meta.url),
    join(temporary, "archival-import/index.js"),
  );
  const original = await readFile(new URL("../dist/archival-source/index.js", import.meta.url), "utf8");
  const instrumented = original
    .replace(
      "const before = await lstat(path, { bigint: true });",
      "await globalThis.__archivalSourceRaceHook?.('before-read-lstat');\n        const before = await lstat(path, { bigint: true });",
    )
    .replace(
      "const handle = await open(path, FILE_FLAGS);",
      "await globalThis.__archivalSourceRaceHook?.('before-open');\n        const handle = await open(path, FILE_FLAGS);",
    )
    .replace(
      /(offset \+= bytesRead;[\s\S]*?\n\s*\}\n)(\s*)const after = await handle\.stat\(\{ bigint: true \}\);/,
      "$1$2await globalThis.__archivalSourceRaceHook?.('after-read');\n$2const after = await handle.stat({ bigint: true });",
    )
    .replace(
      "await verifyRootAndDirectories(root, rootPath, rootBefore, state);",
      "await globalThis.__archivalSourceRaceHook?.('before-verify');\n        await verifyRootAndDirectories(root, rootPath, rootBefore, state);",
    );
  for (const marker of ["before-read-lstat", "before-open", "after-read", "before-verify"]) {
    assert.equal(instrumented.includes(marker), true, `missing race hook ${marker}`);
  }
  await writeFile(join(temporary, "archival-source/index.js"), instrumented);
  const module = await import(
    `${pathToFileURL(join(temporary, "archival-source/index.js")).href}?race=${Date.now()}`
  );
  return { temporary, module };
}

test("discovers only the exact legacy surfaces and snapshots exact bytes", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    await writeFixture(root, "sessions/notes.txt", "ignored\n");
    await writeFixture(root, "sessions/archive/k1/a.jsonl", archiveText());
    await writeFixture(root, "sessions/archive/k1/blob.bin", "ignored\n");
    await writeFixture(root, "sessions/archive/k2/b.jsonl", archiveText("synthetic:2"));
    await writeFixture(root, "memory/history.jsonl", historyText);
    await writeFixture(root, "memory/notes.txt", "ignored\n");
    await writeFixture(root, "elsewhere/x.jsonl", sessionText());

    const first = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    const second = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });

    assert.equal(first.format, ARCHIVAL_SOURCE_ACQUISITION_FORMAT);
    assert.equal(first.version, ARCHIVAL_SOURCE_ACQUISITION_VERSION);
    assert.equal(first.storeNamespace, "synthetic-store");
    assert.equal(first.complete, true);
    assert.equal(first.importPerformed, false);
    assert.equal(first.persistencePerformed, false);
    assert.equal(first.preparationPerformed, false);
    assert.equal(first.replayPerformed, false);
    assert.equal(first.explicitRootReadsPerformed, true);
    assert.equal(first.ambientReadsPerformed, false);
    assert.equal(first.runtimeActionsPrepared, 0);
    assert.equal(first.reviewRequired, true);
    assert.deepEqual(first.discovery, {
      sessions: "present",
      archive: "present",
      memory: "present",
      history: "present",
    });
    assert.equal(first.counts.sourcesDiscovered, 4);
    assert.equal(first.counts.sourcesAcquired, 4);
    assert.equal(first.counts.sourcesRejected, 0);
    assert.equal(first.counts.sessionSources, 1);
    assert.equal(first.counts.archiveSources, 2);
    assert.equal(first.counts.historySources, 1);
    assert.equal(first.surfacesAvailable, 4);
    assert.deepEqual(first.expectedSurfacesMissing, []);
    assert.equal(first.counts.ignoredEntries, 3);
    assert.equal(first.counts.structuralEntries, 3);
    assert.equal(first.counts.directoryEntriesVisited,
      first.counts.sourcesDiscovered + first.counts.ignoredEntries + first.counts.structuralEntries);
    assert.equal(first.counts.diagnostics, 0);
    assert.equal(first.batches.length, 1);
    assert.equal(first.batches[0].sources.length, 4);
    assert.equal(first.batches[0].totalBytes, first.counts.bytesRead);

    assert.deepEqual(first.sources.map((source) => source.kind), ["history", "archive", "archive", "session"]);
    assert.deepEqual(first.sources.map((source) => source.format), [
      "history-jsonl",
      "session-archive-jsonl",
      "session-archive-jsonl",
      "session-jsonl",
    ]);
    for (const source of first.sources) {
      assert.match(source.sourceId, /^legacy-(session|archive|history)-[0-9a-f]{32}$/);
      assert.match(source.provenance, /^legacy-root-[0-9a-f]{32}:snapshot-v1$/);
      assert.equal(source.sourceId, source.snapshot.sourceId);
      assert.equal(source.format, source.snapshot.format);
      assert.equal(source.provenance, source.snapshot.provenance);
      assert.equal(source.sha256, sha256(source.snapshot.bytes));
      assert.equal(source.byteLength, source.snapshot.bytes.length);
      assert.equal(source.snapshot.sha256, source.sha256);
    }
    assert.deepEqual(
      first.sources.map((source) => source.sourceId),
      second.sources.map((source) => source.sourceId),
    );
    assert.equal(first.rootLabel, second.rootLabel);

    const expected = new Map([
      ["sessions/s1.jsonl", sessionText()],
      ["sessions/archive/k1/a.jsonl", archiveText()],
      ["sessions/archive/k2/b.jsonl", archiveText("synthetic:2")],
      ["memory/history.jsonl", historyText],
    ]);
    const snapshots = new Map(
      first.sources.map((source) => [source.snapshot.sha256, source.snapshot.bytes]),
    );
    for (const text of expected.values()) {
      assert.deepEqual(snapshots.get(sha256(Buffer.from(text, "utf8"))), Buffer.from(text, "utf8"));
    }

    const serialized = serializedWithoutBytes(first);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("s1.jsonl"), false);
    assert.equal(serialized.includes("a.jsonl"), false);
    assert.equal(serialized.includes("k1"), false);

    const prepared = prepareAcquiredArchivalImport(first);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].storeNamespace, "synthetic-store");
    assert.equal(prepared[0].importPerformed, false);
    assert.equal(prepared[0].persistencePerformed, false);
    assert.equal(prepared[0].replayPerformed, false);
    assert.equal(prepared[0].complete, true);
    assert.equal(prepared[0].sources.length, 4);
    assert.equal(prepared[0].records.length > 0, true);
  } finally {
    await removeRoot(root);
  }
});

test("marks an empty or wrong root incomplete instead of silently importing nothing", async () => {
  const emptyRoot = await makeRoot();
  try {
    const empty = await acquireLegacySourceSnapshots({
      root: emptyRoot,
      storeNamespace: "synthetic-store",
    });
    assert.equal(empty.complete, false);
    assert.equal(empty.surfacesAvailable, 0);
    assert.deepEqual(empty.expectedSurfacesMissing, ["sessions", "archive", "memory", "history"]);
    assert.equal(empty.discovery.sessions, "missing");
    assert.equal(empty.discovery.archive, "not-checked");
    assert.equal(empty.discovery.memory, "missing");
    assert.equal(empty.discovery.history, "not-checked");
    assert.equal(empty.sources.length, 0);
    assert.equal(empty.batches.length, 0);
    assert.deepEqual(empty.diagnostics.map((diagnostic) => diagnostic.code), [
      "sessions-directory-missing",
      "archive-directory-not-checked",
      "memory-directory-missing",
      "no-sources-discovered",
    ]);
    assert.equal(empty.diagnostics.at(-1).severity, "failure");
    assert.throws(() => prepareAcquiredArchivalImport(empty), ArchivalSourceInputError);
  } finally {
    await removeRoot(emptyRoot);
  }

  const emptySessionsRoot = await makeRoot();
  try {
    await mkdir(join(emptySessionsRoot, "sessions"), { recursive: true });
    const emptySessions = await acquireLegacySourceSnapshots({
      root: emptySessionsRoot,
      storeNamespace: "synthetic-store",
    });
    assert.equal(emptySessions.complete, false);
    assert.equal(emptySessions.surfacesAvailable, 1);
    assert.deepEqual(emptySessions.expectedSurfacesMissing, ["archive", "memory", "history"]);
    assert.equal(emptySessions.diagnostics.some((diagnostic) => diagnostic.code === "no-sources-discovered"), true);
    assert.equal(emptySessions.batches.length, 0);
  } finally {
    await removeRoot(emptySessionsRoot);
  }

  const partialRoot = await makeRoot();
  try {
    await writeFixture(partialRoot, "sessions/s1.jsonl", sessionText());
    await mkdir(join(partialRoot, "memory"), { recursive: true });
    const partial = await acquireLegacySourceSnapshots({
      root: partialRoot,
      storeNamespace: "synthetic-store",
    });
    assert.equal(partial.complete, true);
    assert.equal(partial.surfacesAvailable, 2);
    assert.deepEqual(partial.expectedSurfacesMissing, ["archive", "history"]);
    assert.equal(partial.discovery.sessions, "present");
    assert.equal(partial.discovery.archive, "missing");
    assert.equal(partial.discovery.memory, "present");
    assert.equal(partial.discovery.history, "missing");
    assert.deepEqual(partial.diagnostics.map((diagnostic) => diagnostic.code), [
      "archive-directory-missing",
      "history-file-missing",
    ]);
    assert.equal(partial.sources.length, 1);
    assert.equal(partial.batches.length, 1);
    const prepared = prepareAcquiredArchivalImport(partial);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].sources.length, 1);
  } finally {
    await removeRoot(partialRoot);
  }
});

test("marks unsafe source shapes incomplete and withholds every batch", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/real.jsonl", sessionText());
    await symlink("real.jsonl", join(root, "sessions/link.jsonl"));
    await mkdir(join(root, "sessions/not-a-file.jsonl"));

    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.sources.length, 1);
    assert.equal(report.batches.length, 0);
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "source-symlink-rejected"), true);
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "source-not-regular-file"), true);
    assert.equal(report.diagnostics.every((diagnostic) =>
      diagnostic.code !== "source-symlink-rejected" || /^legacy-session-[0-9a-f]{32}$/.test(diagnostic.sourceId)), true);
    assert.throws(() => prepareAcquiredArchivalImport(report), ArchivalSourceInputError);

    const serialized = serializedWithoutBytes(report);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("link.jsonl"), false);
  } finally {
    await removeRoot(root);
  }
});

test("rejects hard-link aliases and symlinked archive keys", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/a.jsonl", sessionText());
    await link(join(root, "sessions/a.jsonl"), join(root, "sessions/b.jsonl"));
    await writeFixture(root, "sessions/archive/real/key.jsonl", archiveText());
    await symlink("real", join(root, "sessions/archive/linkkey"));

    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.diagnostics.filter((diagnostic) => diagnostic.code === "source-hardlink-alias").length, 2);
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "archive-key-directory-symlink"), true);
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].kind, "archive");
    assert.equal(report.batches.length, 0);
  } finally {
    await removeRoot(root);
  }
});

test("rejects a symlinked history file without reading through the link", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    await mkdir(join(root, "memory"), { recursive: true });
    await symlink("../sessions/s1.jsonl", join(root, "memory/history.jsonl"));

    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.discovery.history, "error");
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "history-file-symlink-rejected"), true);
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].kind, "session");
    assert.equal(report.batches.length, 0);
  } finally {
    await removeRoot(root);
  }
});

test("reports an unreadable source file as a failure instead of omitting it", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const root = await makeRoot();
  const source = join(root, "sessions/s1.jsonl");
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    await chmod(source, 0o000);
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.counts.sourcesDiscovered, 1);
    assert.equal(report.sources.length, 0);
    assert.equal(report.batches.length, 0);
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "source-unreadable"), true);
  } finally {
    await chmod(source, 0o600).catch(() => undefined);
    await removeRoot(root);
  }
});

test("treats a non-directory expected surface as an error, not a missing directory", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions", "not a directory\n");
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.discovery.sessions, "error");
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "sessions-directory-not-directory"), true);
    assert.equal(report.batches.length, 0);
  } finally {
    await removeRoot(root);
  }
});

test("marks an unreadable source directory incomplete instead of silently skipping it", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const root = await makeRoot();
  const sessions = join(root, "sessions");
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    await chmod(sessions, 0o000);
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, false);
    assert.equal(report.discovery.sessions, "error");
    assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "sessions-directory-unreadable"), true);
    assert.equal(report.sources.length, 0);
    assert.equal(report.batches.length, 0);
  } finally {
    await chmod(sessions, 0o700).catch(() => undefined);
    await removeRoot(root);
  }
});

test("batches a source count larger than one preparation request without truncation", async () => {
  const root = await makeRoot();
  try {
    for (let index = 0; index < 33; index++) {
      await writeFixture(root, `sessions/s${String(index).padStart(2, "0")}.jsonl`, sessionText(`synthetic:${index}`));
    }
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, true);
    assert.equal(report.sources.length, 33);
    assert.equal(report.counts.sourcesAcquired, 33);
    assert.deepEqual(report.batches.map((batch) => batch.sources.length), [32, 1]);
    assert.deepEqual(report.batches.map((batch) => batch.batch), [0, 1]);

    const prepared = prepareAcquiredArchivalImport(report);
    assert.equal(prepared.length, 2);
    assert.deepEqual(prepared.map((entry) => entry.sources.length), [32, 1]);
    assert.equal(prepared.every((entry) => entry.storeNamespace === "synthetic-store"), true);
    assert.equal(prepared.every((entry) => entry.complete), true);
  } finally {
    await removeRoot(root);
  }
});

test("honors explicit batch limits and relationship validation", async () => {
  const root = await makeRoot();
  try {
    for (let index = 0; index < 5; index++) {
      await writeFixture(root, `sessions/s${index}.jsonl`, sessionText(`synthetic:${index}`));
    }
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
      limits: { maxSourcesPerBatch: 2 },
    });
    assert.deepEqual(report.batches.map((batch) => batch.sources.length), [2, 2, 1]);
    assert.equal(report.batches.length, 3);
    const prepared = prepareAcquiredArchivalImport(report);
    assert.equal(prepared.length, 3);
    assert.deepEqual(prepared.map((entry) => entry.sources.length), [2, 2, 1]);

    await assert.rejects(
      acquireLegacySourceSnapshots({
        root,
        storeNamespace: "synthetic-store",
        limits: { maxSources: 1, maxSourcesPerBatch: 2 },
      }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root,
        storeNamespace: "synthetic-store",
        limits: { unknownLimit: 1 },
      }),
      ArchivalSourceInputError,
    );
  } finally {
    await removeRoot(root);
  }
});

test("fails closed on source-count, source-byte, total-byte, and directory-entry bounds", async () => {
  const countRoot = await makeRoot();
  try {
    for (let index = 0; index < 3; index++) {
      await writeFixture(countRoot, `sessions/s${index}.jsonl`, sessionText(`synthetic:${index}`));
    }
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: countRoot,
        storeNamespace: "synthetic-store",
        limits: { maxSources: 2, maxSourcesPerBatch: 2 },
      }),
      (error) => error instanceof ArchivalSourceBoundsError && error.bound === "source-count",
    );
  } finally {
    await removeRoot(countRoot);
  }

  const byteRoot = await makeRoot();
  try {
    await writeFixture(byteRoot, "sessions/big.jsonl", "x".repeat(100));
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: byteRoot,
        storeNamespace: "synthetic-store",
        limits: { maxSourceBytes: 16 },
      }),
      (error) => error instanceof ArchivalSourceBoundsError && error.bound === "source-byte",
    );
  } finally {
    await removeRoot(byteRoot);
  }

  const totalRoot = await makeRoot();
  try {
    await writeFixture(totalRoot, "sessions/a.jsonl", "a".repeat(60));
    await writeFixture(totalRoot, "sessions/b.jsonl", "b".repeat(60));
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: totalRoot,
        storeNamespace: "synthetic-store",
        limits: { maxSourceBytes: 64, maxBatchBytes: 100, maxTotalBytes: 100 },
      }),
      (error) => error instanceof ArchivalSourceBoundsError && error.bound === "total-byte",
    );
  } finally {
    await removeRoot(totalRoot);
  }

  const entryRoot = await makeRoot();
  try {
    for (let index = 0; index < 20; index++) {
      await writeFixture(entryRoot, `sessions/ignored-${index}.txt`, "x");
    }
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: entryRoot,
        storeNamespace: "synthetic-store",
        limits: { maxEntriesPerDirectory: 10, maxEntriesVisited: 100 },
      }),
      (error) => error instanceof ArchivalSourceBoundsError && error.bound === "directory-entry-per-directory",
    );
  } finally {
    await removeRoot(entryRoot);
  }
});

test("requires an explicit dedicated root and an operator-supplied safe namespace", async () => {
  const root = await makeRoot();
  try {
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: "relative/path", storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: "/", storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: tmpdir(), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: homedir(), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: join(homedir(), ".nanobot"), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: join(homedir(), ".nanobot", "copy"), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: "/proc/self", storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root, storeNamespace: "not a safe namespace" }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root, storeNamespace: "synthetic-store", unknown: true }),
      ArchivalSourceInputError,
    );
    const missing = await acquireLegacySourceSnapshots({ root, storeNamespace: "synthetic-store" });
    assert.equal(missing.complete, false);
    assert.equal(missing.sources.length, 0);
    assert.equal(missing.diagnostics.some((diagnostic) => diagnostic.code === "no-sources-discovered"), true);
  } finally {
    await removeRoot(root);
  }
});

test("protects the account home when HOME is redirected", async () => {
  const realHome = userInfo().homedir;
  assert.equal(typeof realHome, "string");
  assert.equal(realHome.length > 0, true);
  const fakeHome = await mkdtemp(join(tmpdir(), "nanobot-fake-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: join(realHome, ".nanobot", "probe-nonexistent"),
        storeNamespace: "synthetic-store",
      }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({
        root: join(fakeHome, ".nanobot", "copy"),
        storeNamespace: "synthetic-store",
      }),
      ArchivalSourceInputError,
    );
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: join(realHome, ".."), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
    process.env.HOME = "/";
    await assert.rejects(
      acquireLegacySourceSnapshots({ root: join(realHome, ".."), storeNamespace: "synthetic-store" }),
      ArchivalSourceInputError,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await removeRoot(fakeHome);
  }
});

test("rejects forged or inconsistent acquisition reports before preparation", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    await writeFixture(root, "sessions/s2.jsonl", sessionText("synthetic:2"));
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(report.complete, true);
    assert.equal(report.batches.length, 1);
    assert.equal(report.batches[0].sources.length, 2);

    assert.throws(
      () => prepareAcquiredArchivalImport({ ...report, version: 99 }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        diagnostics: [{
          code: "source-changed",
          severity: "failure",
          surface: "source",
          sourceId: report.sources[0].sourceId,
        }],
      }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({ ...report, diagnostics: [{ severity: "unknown" }] }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        get bounds() { throw new Error("boom"); },
      }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({ ...report, sources: [], batches: report.batches }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        batches: [{
          ...report.batches[0],
          sources: report.batches[0].sources.slice(0, 1),
          totalBytes: report.sources[0].byteLength,
        }],
      }),
      ArchivalSourceInputError,
    );

    const first = report.sources[0];
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        batches: [
          { batch: 0, sources: [first.snapshot], totalBytes: first.byteLength },
          { batch: 1, sources: [first.snapshot], totalBytes: first.byteLength },
        ],
      }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        sources: [first, first],
        batches: [
          { batch: 0, sources: [first.snapshot], totalBytes: first.byteLength },
          { batch: 1, sources: [first.snapshot], totalBytes: first.byteLength },
        ],
      }),
      ArchivalSourceInputError,
    );
    assert.throws(
      () => prepareAcquiredArchivalImport({
        ...report,
        sources: [{ ...first, sha256: "0".repeat(64) }, ...report.sources.slice(1)],
      }),
      ArchivalSourceInputError,
    );
  } finally {
    await removeRoot(root);
  }
});

test("rejects a failed acquisition forged as complete", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/real.jsonl", sessionText());
    await symlink("real.jsonl", join(root, "sessions/link.jsonl"));
    const bad = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    assert.equal(bad.complete, false);
    assert.equal(bad.sources.length, 1);
    assert.equal(bad.diagnostics.some((diagnostic) => diagnostic.severity === "failure"), true);
    const forged = {
      ...bad,
      complete: true,
      batches: [{
        batch: 0,
        sources: bad.sources.map((source) => source.snapshot),
        totalBytes: bad.sources.reduce((total, source) => total + source.byteLength, 0),
      }],
    };
    assert.throws(() => prepareAcquiredArchivalImport(forged), ArchivalSourceInputError);
  } finally {
    await removeRoot(root);
  }
});

test("rejects a snapshot mutated after acquisition and accepts restored bytes", async () => {
  const root = await makeRoot();
  try {
    await writeFixture(root, "sessions/s1.jsonl", sessionText());
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    const bytes = report.sources[0].snapshot.bytes;
    const original = Buffer.from(bytes);
    bytes.fill(0x41);
    assert.throws(() => prepareAcquiredArchivalImport(report), ArchivalSourceInputError);
    bytes.set(original);
    const prepared = prepareAcquiredArchivalImport(report);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].sources.length, 1);
  } finally {
    await removeRoot(root);
  }
});

test("detects deterministic mutations before, during, after read, and before verification", async () => {
  const { temporary, module } = await makeInstrumentedModule();
  try {
    const cases = [
      {
        phase: "before-read-lstat",
        mutate: async (target) => { await writeFile(target, sessionText("changed-before-lstat")); },
        expectedSources: 0,
        expectedCodes: ["source-changed"],
      },
      {
        phase: "before-open",
        mutate: async (target) => {
          await rename(target, `${target}.old`);
          await writeFile(target, sessionText("replaced-before-open"));
        },
        expectedSources: 0,
        expectedCodes: ["source-changed"],
      },
      {
        phase: "after-read",
        mutate: async (target) => { await writeFile(target, sessionText("changed-after-read")); },
        expectedSources: 0,
        expectedCodes: ["source-changed"],
      },
      {
        phase: "after-read",
        mutate: async (target) => {
          await rename(target, `${target}.old`);
          await writeFile(target, sessionText("replaced-after-read"));
        },
        expectedSources: 0,
        expectedCodes: ["source-changed"],
      },
      {
        phase: "before-verify",
        mutate: async (_target, root) => { await writeFile(join(root, "sessions/added.jsonl"), sessionText("added")); },
        expectedSources: 1,
        expectedCodes: ["directory-changed"],
      },
      {
        phase: "before-verify",
        mutate: async (_target, root) => { await writeFile(join(root, "added.txt"), "added\n"); },
        expectedSources: 1,
        expectedCodes: ["root-changed"],
      },
    ];
    for (const { phase, mutate, expectedSources, expectedCodes } of cases) {
      const root = await makeRoot();
      try {
        await writeFixture(root, "sessions/s1.jsonl", sessionText());
        const target = join(root, "sessions/s1.jsonl");
        let fired = false;
        globalThis.__archivalSourceRaceHook = async (currentPhase) => {
          if (currentPhase !== phase || fired) return;
          fired = true;
          await mutate(target, root);
        };
        const report = await module.acquireLegacySourceSnapshots({
          root,
          storeNamespace: "synthetic-store",
        });
        assert.equal(fired, true, phase);
        assert.equal(report.complete, false, phase);
        assert.equal(report.sources.length, expectedSources, phase);
        assert.equal(report.batches.length, 0, phase);
        for (const code of expectedCodes) {
          assert.equal(
            report.diagnostics.some((diagnostic) => diagnostic.code === code),
            true,
            `${phase}: ${code}`,
          );
        }
      } finally {
        delete globalThis.__archivalSourceRaceHook;
        await removeRoot(root);
      }
    }
  } finally {
    delete globalThis.__archivalSourceRaceHook;
    await removeRoot(temporary);
  }
});

test("closes file descriptors across repeated acquisitions", async () => {
  const root = await makeRoot();
  try {
    for (let index = 0; index < 30; index++) {
      await writeFixture(root, `sessions/s${String(index).padStart(2, "0")}.jsonl`, sessionText(`synthetic:${index}`));
    }
    const counts = [];
    for (let round = 0; round < 3; round++) {
      const report = await acquireLegacySourceSnapshots({
        root,
        storeNamespace: "synthetic-store",
      });
      assert.equal(report.complete, true);
      assert.equal(report.sources.length, 30);
      counts.push((await readdir("/proc/self/fd")).length);
    }
    assert.equal(counts[1], counts[0]);
    assert.equal(counts[2], counts[1]);
  } finally {
    await removeRoot(root);
  }
});

test("does not mutate source files and exposes the snapshot bytes without freezing them", async () => {
  const root = await makeRoot();
  try {
    const text = sessionText();
    await writeFixture(root, "sessions/s1.jsonl", text);
    const before = await lstat(join(root, "sessions/s1.jsonl"), { bigint: true });
    const report = await acquireLegacySourceSnapshots({
      root,
      storeNamespace: "synthetic-store",
    });
    const after = await lstat(join(root, "sessions/s1.jsonl"), { bigint: true });
    assert.equal(before.dev, after.dev);
    assert.equal(before.ino, after.ino);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeNs, after.mtimeNs);
    assert.equal(await readFile(join(root, "sessions/s1.jsonl"), "utf8"), text);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.sources), true);
    assert.equal(Object.isFrozen(report.sources[0].snapshot), true);
    assert.equal(Buffer.isBuffer(report.sources[0].snapshot.bytes), true);
    assert.equal(report.sources[0].snapshot.bytes.toString("utf8"), text);
  } finally {
    await removeRoot(root);
  }
});

test("documents the default batch shape used by preparation integration", async () => {
  assert.equal(ARCHIVAL_SOURCE_ACQUISITION_LIMITS.maxSourcesPerBatch, 32);
  assert.equal(ARCHIVAL_SOURCE_ACQUISITION_LIMITS.maxBatchBytes, 16 * 1024 * 1024);
  assert.equal(ARCHIVAL_SOURCE_ACQUISITION_LIMITS.maxSourceBytes, 4 * 1024 * 1024);
});
