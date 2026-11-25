import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONTEXT_LIMITS, createContextExtension } from "../dist/context/index.js";
import {
  WORKSPACE_CONTEXT_LIMITS,
  WorkspaceContextFileError,
  WorkspaceContextInputError,
  createWorkspaceContextSnapshotProvider,
  loadWorkspaceContextSnapshot,
} from "../dist/context/workspace.js";

async function tempRoot(t, label = "nanobot-workspace-context-") {
  const root = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function isFileError(kind, source) {
  return (error) => {
    assert.ok(error instanceof WorkspaceContextFileError, `expected file error, got ${error?.name}: ${error?.message}`);
    assert.equal(error.kind, kind);
    if (source !== undefined) assert.equal(error.source, source);
    return true;
  };
}

function isInputError(error) {
  assert.ok(error instanceof WorkspaceContextInputError, `expected input error, got ${error?.name}: ${error?.message}`);
  return true;
}

function fdTargetExists(target) {
  let entries;
  try {
    entries = readdirSync("/proc/self/fd");
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      if (readlinkSync(`/proc/self/fd/${entry}`) === target) return true;
    } catch {
      // The fd may have closed between readdir and readlink.
    }
  }
  return false;
}

async function load(root, extra = {}) {
  return loadWorkspaceContextSnapshot({ workspaceRoot: root, ...extra });
}

function render(extension, key, conversationId = 1) {
  const promptSection = extension.sections.find(({ key: sectionKey }) => sectionKey === key);
  assert.ok(promptSection);
  return promptSection.render({ conversationId, agent: { tools: [] } }, undefined) ?? "";
}

test("loads the fixed bootstrap files and explicit memory files deterministically", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "AGENTS.md": "# Agents\nBe direct.",
    "SOUL.md": "Soul body.",
    "USER.md": "User body.",
    "memory/MEMORY.md": "remembered fact",
    "memory/system/preferences.md": "system preference",
    "memory/topics/other.md": "topic body",
  });

  const snapshot = await load(root, {
    memoryFiles: ["memory/system/preferences.md", "memory/MEMORY.md"],
  });

  assert.deepEqual(Object.keys(snapshot).sort(), ["agents", "memory", "soul", "user"]);
  assert.deepEqual(snapshot.agents, { source: "workspace:AGENTS.md", content: "# Agents\nBe direct." });
  assert.deepEqual(snapshot.soul, { source: "workspace:SOUL.md", content: "Soul body." });
  assert.deepEqual(snapshot.user, { source: "workspace:USER.md", content: "User body." });
  assert.deepEqual(snapshot.memory.map(({ source }) => source), [
    "workspace:memory/system/preferences.md",
    "workspace:memory/MEMORY.md",
  ]);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.agents));
  assert.ok(Object.isFrozen(snapshot.memory));
  assert.ok(Object.isFrozen(snapshot.memory[0]));

  const extension = createContextExtension([{ conversationId: 1, ...snapshot }]);
  const instructions = render(extension, "nanobot_instructions");
  assert.match(instructions, /## AGENTS\.md/);
  assert.match(instructions, /Source: "workspace:AGENTS\.md"/);
  assert.match(instructions, /Be direct/);
  assert.match(instructions, /## SOUL\.md/);
  assert.match(instructions, /## USER\.md/);
  assert.match(instructions, /User body/);
  const memory = render(extension, "nanobot_memory");
  assert.match(memory, /## Memory 1/);
  assert.match(memory, /system preference/);
  assert.match(memory, /remembered fact/);
  assert.match(memory, /Source: "workspace:memory\/MEMORY\.md"/);
  assert.equal(render(extension, "nanobot_identity"), "");
  assert.equal(render(extension, "nanobot_skills"), "");
});

test("system memory is recursively loaded in stable order and picked up afresh", { timeout: 10_000 }, async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "memory/topic.md": "explicit topic",
    "memory/MEMORY.md": "unselected index",
    "memory/system/z.md": "selected system",
    "memory/system/.hidden.md": "hidden",
    "memory/system/nested/ü note.md": "nested Unicode",
    "memory/system/HISTORY.md": "system history",
    "memory/system/MEMORY.md": "system index",
    "memory/system/empty.md": "",
    "memory/system/ignored.MD": "uppercase suffix",
    "memory/system/ignored.txt": "not Markdown",
  });
  const selection = { memoryFiles: ["memory/topic.md", "memory/system/z.md"] };
  const first = await load(root, selection);
  assert.deepEqual(first.memory.map(({ source }) => source), [
    "workspace:memory/topic.md",
    "workspace:memory/system/z.md",
    "workspace:memory/system/.hidden.md",
    "workspace:memory/system/HISTORY.md",
    "workspace:memory/system/MEMORY.md",
    "workspace:memory/system/nested/ü note.md",
  ]);
  assert.ok(Object.isFrozen(first.memory));
  assert.ok(first.memory.every(Object.isFrozen));
  await writeFiles(root, { "memory/system/added.md": "added", "memory/system/z.md": "edited" });
  await rm(join(root, "memory/system/.hidden.md"));
  const second = await load(root, selection);
  assert.deepEqual(second.memory.map(({ content }) => content), [
    "explicit topic", "edited", "system history", "system index", "added", "nested Unicode",
  ]);
  assert.equal(first.memory[1].content, "selected system");
  const automatic = await load(root);
  assert.equal(automatic.memory.length, 5);
  assert.ok(automatic.memory.every(({ source }) => source.startsWith("workspace:memory/system/")));
});

test("automatic system memory fails closed on unsafe or invalid content", { timeout: 10_000 }, async (t) => {
  const outside = await tempRoot(t);
  await writeFile(join(outside, "secret.md"), "outside");
  for (const directoryLink of [false, true]) {
    const root = await tempRoot(t);
    await mkdir(join(root, "memory/system"), { recursive: true });
    await symlink(directoryLink ? outside : join(outside, "secret.md"), join(root, "memory/system/link"));
    await assert.rejects(load(root), isFileError("symlink", "memory/system"));
  }
  const linkedRoot = await tempRoot(t);
  await mkdir(join(linkedRoot, "memory"));
  await symlink(outside, join(linkedRoot, "memory/system"));
  await assert.rejects(load(linkedRoot), isFileError("symlink", "memory/system"));
  const hardlinked = await tempRoot(t);
  await mkdir(join(hardlinked, "memory/system"), { recursive: true });
  await link(join(outside, "secret.md"), join(hardlinked, "memory/system/note.md"));
  await assert.rejects(load(hardlinked), isFileError("hardlink", "memory/system/note.md"));
  const invalid = await tempRoot(t);
  await writeFiles(invalid, { "memory/system/note.md": Buffer.from([0xff]) });
  await assert.rejects(load(invalid), isFileError("encoding", "memory/system/note.md"));
  await writeFile(join(invalid, "memory/system/note.md"), "private");
  await chmod(join(invalid, "memory/system/note.md"), 0o000);
  if (process.getuid?.() !== 0) {
    await assert.rejects(load(invalid), isFileError("unreadable", "memory/system/note.md"));
  }
});

test("system discovery refuses invalid filename bytes instead of loading a valid twin twice", { timeout: 10_000 }, async (t) => {
  for (const directory of [false, true]) {
    const root = await tempRoot(t);
    const valid = `memory/system/bad-�${directory ? "/note.md" : ".md"}`;
    await writeFiles(root, { [valid]: "valid replacement character" });
    assert.deepEqual((await load(root)).memory.map(({ content }) => content), ["valid replacement character"]);
    const malformed = Buffer.concat([
      Buffer.from(join(root, "memory/system/bad-")), Buffer.from([0xff]), Buffer.from(directory ? "" : ".md"),
    ]);
    if (directory) {
      await mkdir(malformed);
      await writeFile(Buffer.concat([malformed, Buffer.from("/note.md")]), "must not be silently omitted");
    } else {
      await writeFile(malformed, "must not be silently omitted");
    }
    await assert.rejects(load(root), isFileError("encoding", "memory/system"));
  }
});

test("system discovery refuses locator and scan bounds instead of partial context", { timeout: 15_000 }, async (t) => {
  const invalid = await tempRoot(t);
  await writeFiles(invalid, { [`memory/system/${"x".repeat(65)}/note.md`]: "unrepresentable" });
  await assert.rejects(load(invalid), isFileError("bounds", "memory/system"));
  const oversized = await tempRoot(t);
  await mkdir(join(oversized, "memory/system"), { recursive: true });
  await Promise.all(Array.from({ length: WORKSPACE_CONTEXT_LIMITS.maxSystemScannedEntries + 1 }, (_, index) =>
    writeFile(join(oversized, "memory/system", `${index}.txt`), "")));
  await assert.rejects(load(oversized), isFileError("bounds", "memory/system"));
});

test("system directory replacement during a load is rejected", { timeout: 10_000 }, async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, { "memory/system/note.md": "original" });
  const system = join(root, "memory/system");
  const probe = await open(join(system, "note.md"));
  const prototype = Object.getPrototypeOf(probe);
  const stat = prototype.stat;
  await probe.close();
  let replaced = false;
  t.mock.method(prototype, "stat", async function (...args) {
    const info = await stat.apply(this, args);
    if (!replaced && readlinkSync(`/proc/self/fd/${this.fd}`) === join(system, "note.md")) {
      replaced = true;
      renameSync(system, `${system}.moved`);
      mkdirSync(system);
      writeFileSync(join(system, "note.md"), "replacement");
    }
    return info;
  });
  await assert.rejects(load(root), (error) => {
    assert.ok(error instanceof WorkspaceContextFileError);
    assert.equal(error.kind, "changed");
    assert.match(error.source, /^memory\/system/);
    return true;
  });
  assert.equal(replaced, true);
});

test("missing and empty bootstrap files are omitted and topic memory is never discovered implicitly", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "AGENTS.md": "",
    "memory/MEMORY.md": "must not be loaded without an explicit selection",
  });

  assert.deepEqual(await load(root), {});
  await mkdir(join(root, "memory/system"));
  assert.deepEqual(await load(root), {});
  const withEmptySelection = await load(root, { memoryFiles: ["memory/MEMORY.md"] });
  assert.deepEqual(Object.keys(withEmptySelection), ["memory"]);
});

test("explicit identity is copied from the request and never derived from ambient state", async (t) => {
  const root = await tempRoot(t);
  const identity = { source: "session:explicit", content: "identity for this request only" };
  const snapshot = await load(root, { identity });
  identity.content = "mutated after loading";
  identity.source = "mutated source";

  assert.deepEqual(snapshot.identity, {
    source: "session:explicit",
    content: "identity for this request only",
  });
  assert.ok(Object.isFrozen(snapshot.identity));
  assert.throws(() => { snapshot.identity.content = "mutated"; }, TypeError);
  assert.deepEqual(Object.keys(snapshot), ["identity"]);
});

test("each load returns detached values and observes file changes without caching", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "AGENTS.md": "version one",
    "memory/MEMORY.md": "memory one",
  });

  const first = await load(root, { memoryFiles: ["memory/MEMORY.md"] });
  const second = await load(root, { memoryFiles: ["memory/MEMORY.md"] });
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.agents, second.agents);
  assert.notStrictEqual(first.memory, second.memory);
  assert.notStrictEqual(first.memory[0], second.memory[0]);
  assert.equal(first.agents.content, second.agents.content);

  await writeFile(join(root, "AGENTS.md"), "version two");
  const third = await load(root, { memoryFiles: ["memory/MEMORY.md"] });
  assert.equal(third.agents.content, "version two");
  assert.equal(first.agents.content, "version one");
});

test("explicitly selected memory must exist, be regular, and stay under memory/**/*.md", async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, "memory"), { recursive: true });
  await mkdir(join(root, "memory", "directory.md"));

  await assert.rejects(load(root, { memoryFiles: ["memory/missing.md"] }), isFileError("missing", "memory/missing.md"));
  await assert.rejects(load(root, { memoryFiles: ["memory/directory.md"] }), isFileError("not-regular", "memory/directory.md"));

  const invalidSelections = [
    "/etc/passwd",
    "AGENTS.md",
    "memory/../AGENTS.md",
    "memory/./MEMORY.md",
    "memory//MEMORY.md",
    "memory\\MEMORY.md",
    "memory/history.jsonl",
    "memory/not-markdown.txt",
    "outside/memory/file.md",
    "memory/",
  ];
  for (const selection of invalidSelections) {
    await assert.rejects(load(root, { memoryFiles: [selection] }), isInputError, `selection: ${selection}`);
  }

  // Locator shape only: a leading dot, a space, or non-ASCII name is a valid
  // selection, matching what topic discovery lists.
  await writeFile(join(root, "memory", "with space.md"), "spaced");
  await assert.equal(
    (await load(root, { memoryFiles: ["memory/with space.md"] })).memory[0].content,
    "spaced",
  );

  await writeFile(join(root, "memory", "MEMORY.md"), "one");
  await assert.rejects(load(root, {
    memoryFiles: ["memory/MEMORY.md", "memory/MEMORY.md"],
  }), isInputError);
});

test("invalid roots and invalid requests fail closed", async (t) => {
  const root = await tempRoot(t);
  const fileRoot = join(root, "not-a-directory");
  await writeFile(fileRoot, "file");

  for (const workspaceRoot of ["relative/path", "", "/", "/proc/self", "/sys", "/dev", "/tmp/../.nanobot/workspace", `${root}\n`, null, 42]) {
    await assert.rejects(loadWorkspaceContextSnapshot({ workspaceRoot }), isInputError, `root: ${String(workspaceRoot)}`);
  }
  await assert.rejects(load(join(root, "missing-root")), isInputError);
  await assert.rejects(load(fileRoot), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot(null), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot({ workspaceRoot: root, memoryFiles: "memory/MEMORY.md" }), isInputError);
  await assert.rejects(load(root, { identity: { content: "" } }), isInputError);
  await assert.rejects(load(root, { identity: { source: "bad\nsource", content: "x" } }), isInputError);
});

test("a symlinked root or bootstrap file is rejected without reading the target", async (t) => {
  const outside = await tempRoot(t, "nanobot-workspace-outside-");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "OUTSIDE_SECRET");

  const root = await tempRoot(t);
  await symlink(secret, join(root, "AGENTS.md"));
  await assert.rejects(load(root), (error) => {
    assert.ok(error instanceof WorkspaceContextFileError);
    assert.equal(error.kind, "symlink");
    assert.equal(error.source, "AGENTS.md");
    assert.ok(!error.message.includes("OUTSIDE_SECRET"));
    assert.ok(!error.message.includes(outside));
    return true;
  });

  const linkedRoot = join(await tempRoot(t), "root-link");
  await symlink(root, linkedRoot);
  await assert.rejects(load(linkedRoot), isInputError);
});

test("symlinked memory directories and files are rejected", async (t) => {
  const outside = await tempRoot(t, "nanobot-workspace-outside-");
  await writeFile(join(outside, "secret.md"), "OUTSIDE_SECRET");

  const linkedDirectory = await tempRoot(t);
  await symlink(outside, join(linkedDirectory, "memory"));
  await assert.rejects(load(linkedDirectory, { memoryFiles: ["memory/secret.md"] }), isFileError("symlink", "memory/secret.md"));

  const linkedFile = await tempRoot(t);
  await mkdir(join(linkedFile, "memory"), { recursive: true });
  await symlink(join(outside, "secret.md"), join(linkedFile, "memory", "secret.md"));
  await assert.rejects(load(linkedFile, { memoryFiles: ["memory/secret.md"] }), isFileError("symlink", "memory/secret.md"));

  const nestedLink = await tempRoot(t);
  await mkdir(join(nestedLink, "memory"), { recursive: true });
  await symlink(outside, join(nestedLink, "memory", "system"));
  await assert.rejects(load(nestedLink, { memoryFiles: ["memory/system/secret.md"] }), isFileError("symlink", "memory/system/secret.md"));
});

test("hard-link aliases are rejected", async (t) => {
  const outside = await tempRoot(t, "nanobot-workspace-outside-");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "OUTSIDE_SECRET");

  const root = await tempRoot(t);
  await link(secret, join(root, "AGENTS.md"));
  await assert.rejects(load(root), isFileError("hardlink", "AGENTS.md"));

  const memoryRoot = await tempRoot(t);
  await mkdir(join(memoryRoot, "memory"), { recursive: true });
  await link(secret, join(memoryRoot, "memory", "MEMORY.md"));
  await assert.rejects(load(memoryRoot, { memoryFiles: ["memory/MEMORY.md"] }), isFileError("hardlink", "memory/MEMORY.md"));
});

test("unreadable and invalid UTF-8 files fail closed", async (t) => {
  const encodingRoot = await tempRoot(t);
  await writeFile(join(encodingRoot, "AGENTS.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(load(encodingRoot), isFileError("encoding", "AGENTS.md"));

  const unreadableRoot = await tempRoot(t);
  const unreadable = join(unreadableRoot, "AGENTS.md");
  await writeFile(unreadable, "cannot read me");
  await chmod(unreadable, 0o000);
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    await assert.rejects(load(unreadableRoot), isFileError("unreadable", "AGENTS.md"));
  }
});

test("large content passes through the loader and renderer in full", async (t) => {
  const root = await tempRoot(t);
  const agents = `${"a".repeat(120_000)}AGENTS_TAIL_MUST_SURVIVE`;
  const soul = "😀".repeat(30_000);
  const user = `${"u".repeat(60_000)}USER_TAIL_MUST_SURVIVE`;
  await writeFiles(root, { "AGENTS.md": agents, "SOUL.md": soul, "USER.md": user });

  const memoryFiles = [];
  const memoryFixture = {};
  for (let index = 0; index < 40; index++) {
    const relative = `memory/topic-${index}.md`;
    memoryFiles.push(relative);
    memoryFixture[relative] = `topic ${index}\n${"m".repeat(4_000)}`;
  }
  await writeFiles(root, memoryFixture);

  const identityContent = `i`.repeat(50_000);
  const snapshot = await load(root, {
    memoryFiles,
    identity: { source: "session:large", content: identityContent },
  });
  assert.equal(snapshot.agents.content, agents);

  const extension = createContextExtension([{ conversationId: 1, ...snapshot }]);
  const instructions = render(extension, "nanobot_instructions");
  assert.ok(instructions.includes(agents));
  assert.ok(instructions.includes(user));
  assert.ok(instructions.includes(soul));

  const memory = render(extension, "nanobot_memory");
  assert.ok(memory.includes(memoryFixture[memoryFiles[39]]));
  assert.ok(memory.includes(memoryFixture[memoryFiles[0]]));
  assert.match(memory, /Memory 40\nSource: "workspace:memory\/topic-39\.md"/);

  const identity = render(extension, "nanobot_identity");
  assert.ok(identity.includes(identityContent));
});

test("provider adapts explicit session selections without shared state", async (t) => {
  const rootA = await tempRoot(t, "nanobot-workspace-a-");
  const rootB = await tempRoot(t, "nanobot-workspace-b-");
  await writeFiles(rootA, {
    "AGENTS.md": "workspace A instructions",
    "memory/MEMORY.md": "workspace A memory",
  });
  await writeFiles(rootB, {
    "AGENTS.md": "workspace B instructions",
    "memory/MEMORY.md": "workspace B memory",
  });

  const calls = [];
  const context = { marker: "explicit-context-argument" };
  const provider = createWorkspaceContextSnapshotProvider((sessionKey, conversationId, receivedContext) => {
    calls.push([sessionKey, conversationId, receivedContext]);
    if (sessionKey === "session-a") {
      return {
        workspaceRoot: rootA,
        memoryFiles: ["memory/MEMORY.md"],
        identity: { source: `session:${sessionKey}`, content: `identity for ${sessionKey}` },
      };
    }
    if (sessionKey === "session-b") {
      return {
        workspaceRoot: rootB,
        memoryFiles: ["memory/MEMORY.md"],
        identity: { source: `session:${sessionKey}`, content: `identity for ${sessionKey}` },
      };
    }
    return undefined;
  });

  const [a, b, none] = await Promise.all([
    provider("session-a", 1, context),
    provider("session-b", 2, context),
    provider("session-c", 3, context),
  ]);

  assert.equal(none, undefined);
  assert.deepEqual(calls.map(([sessionKey, conversationId]) => [sessionKey, conversationId]), [
    ["session-a", 1],
    ["session-b", 2],
    ["session-c", 3],
  ]);
  assert.ok(calls.every(([, , receivedContext]) => receivedContext === context));

  assert.match(a.agents.content, /workspace A instructions/);
  assert.doesNotMatch(a.agents.content, /workspace B/);
  assert.match(a.memory[0].content, /workspace A memory/);
  assert.doesNotMatch(a.memory[0].content, /workspace B/);
  assert.deepEqual(a.identity, { source: "session:session-a", content: "identity for session-a" });

  assert.match(b.agents.content, /workspace B instructions/);
  assert.doesNotMatch(b.agents.content, /workspace A/);
  assert.match(b.memory[0].content, /workspace B memory/);
  assert.doesNotMatch(b.memory[0].content, /workspace A/);
  assert.deepEqual(b.identity, { source: "session:session-b", content: "identity for session-b" });

  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.memory, b.memory);
  assert.notStrictEqual(a.identity, b.identity);
});

test("provider supports async resolvers and propagates lookup failures", async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, "AGENTS.md"), "async instructions");
  const provider = createWorkspaceContextSnapshotProvider(async (sessionKey) => {
    await Promise.resolve();
    if (sessionKey === "missing") return { workspaceRoot: root, memoryFiles: ["memory/missing.md"] };
    if (sessionKey === "none") return undefined;
    return { workspaceRoot: root };
  });

  const snapshot = await provider("present", 1, {});
  assert.equal(snapshot.agents.content, "async instructions");
  assert.equal(await provider("none", 2, {}), undefined);
  await assert.rejects(provider("missing", 3, {}), isFileError("missing", "memory/missing.md"));
  assert.throws(() => createWorkspaceContextSnapshotProvider(null), isInputError);
});

test("request, identity, and memory selections are captured from own data properties only", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "AGENTS.md": "own data",
    "memory/MEMORY.md": "proxy memory",
  });

  await assert.rejects(loadWorkspaceContextSnapshot(Object.create({ workspaceRoot: root })), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot({
    get workspaceRoot() { return root; },
  }), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot(
    Object.create({ workspaceRoot: root, memoryFiles: [] }),
  ), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot({
    workspaceRoot: root,
    get memoryFiles() { return []; },
  }), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot(
    Object.assign(Object.create({ memoryFiles: [] }), { workspaceRoot: root }),
  ), isInputError);
  await assert.rejects(loadWorkspaceContextSnapshot(
    Object.assign(
      Object.create({ identity: { source: "session:x", content: "content" } }),
      { workspaceRoot: root },
    ),
  ), isInputError);

  const inheritedIdentitySource = {
    workspaceRoot: root,
    identity: Object.create({ source: "session:inherited" }),
  };
  Object.defineProperty(inheritedIdentitySource.identity, "content", {
    value: "content", enumerable: true, configurable: true, writable: true,
  });
  await assert.rejects(loadWorkspaceContextSnapshot(inheritedIdentitySource), isInputError);

  await assert.rejects(load(root, {
    identity: { source: "session:x", get content() { return "hidden"; } },
  }), isInputError);

  const inheritedIdentityContent = {
    workspaceRoot: root,
    identity: Object.create({ content: "hidden" }),
  };
  Object.defineProperty(inheritedIdentityContent.identity, "source", {
    value: "session:x", enumerable: true, configurable: true, writable: true,
  });
  await assert.rejects(loadWorkspaceContextSnapshot(inheritedIdentityContent), isInputError);

  await assert.rejects(load(root, { memoryFiles: new Array(1) }), isInputError);

  const accessorItem = [];
  Object.defineProperty(accessorItem, "0", {
    get() { return "memory/MEMORY.md"; }, enumerable: true, configurable: true,
  });
  await assert.rejects(load(root, { memoryFiles: accessorItem }), isInputError);

  const target = ["memory/MEMORY.md"];
  let lengthReads = 0;
  let getCalls = 0;
  const proxied = new Proxy(target, {
    get(object, key, receiver) {
      getCalls++;
      return Reflect.get(object, key, receiver);
    },
    getOwnPropertyDescriptor(object, key) {
      if (key === "length") {
        lengthReads++;
        return { value: 1, writable: true, enumerable: false, configurable: false };
      }
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });
  const snapshot = await load(root, { memoryFiles: proxied });
  assert.equal(lengthReads, 1);
  assert.equal(getCalls, 0);
  assert.deepEqual(snapshot.memory.map(({ content }) => content), ["proxy memory"]);
});

test("provenance labels fit CONTEXT_LIMITS.sourceChars including the workspace prefix", async (t) => {
  const root = await tempRoot(t);
  const buildPath = (length) => {
    const base = `memory/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/`;
    const remaining = length - base.length - ".md".length;
    assert.ok(remaining > 0 && remaining <= 64, `last segment length ${remaining}`);
    return `${base}${"d".repeat(remaining)}.md`;
  };

  const accepted = buildPath(WORKSPACE_CONTEXT_LIMITS.maxPathChars);
  assert.equal(accepted.length, WORKSPACE_CONTEXT_LIMITS.maxPathChars);
  await assert.rejects(load(root, { memoryFiles: [accepted] }), isFileError("missing", accepted));
  await writeFiles(root, { [accepted]: "max label" });
  const snapshot = await load(root, { memoryFiles: [accepted] });
  assert.equal(snapshot.memory[0].source.length, CONTEXT_LIMITS.sourceChars);
  assert.equal(`workspace:${accepted}`.length, CONTEXT_LIMITS.sourceChars);
  const extension = createContextExtension([{ conversationId: 1, ...snapshot }]);
  const memory = render(extension, "nanobot_memory");
  assert.ok(memory.includes(`Source: "workspace:${accepted}"`));

  const rejected = buildPath(WORKSPACE_CONTEXT_LIMITS.maxPathChars + 1);
  await assert.rejects(load(root, { memoryFiles: [rejected] }), isInputError);
});

test("workspace documents reach the renderer without a content budget", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, { "memory/MEMORY.md": `${"Z".repeat(20_000)}MEMORY_TAIL_MUST_SURVIVE` });
  const snapshot = await load(root, {
    memoryFiles: ["memory/MEMORY.md"],
    identity: { source: "session:identity", content: "identity body" },
  });
  const extension = createContextExtension([{ conversationId: 1, ...snapshot }]);

  const memory = render(extension, "nanobot_memory");
  assert.match(memory, /MEMORY_TAIL_MUST_SURVIVE/);

  const identity = render(extension, "nanobot_identity");
  assert.match(identity, /identity body/);
  assert.match(identity, /Source: "session:identity"/);
});

test("root rename or replacement during a load is detected", async (t) => {
  const root = await tempRoot(t);
  const memoryFiles = [];
  const fixture = {};
  for (let index = 0; index < 32; index++) {
    const relative = `memory/a/b/c/d/e/f/file-${index}.md`;
    memoryFiles.push(relative);
    fixture[relative] = `content ${index}`;
  }
  await writeFiles(root, fixture);
  const realRoot = realpathSync(root);
  const moved = `${root}.moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));

  let settled = false;
  let renamed = false;
  const operation = load(root, { memoryFiles });
  const tracked = operation.then(() => { settled = true; }, () => { settled = true; });
  const watcher = (async () => {
    for (let attempt = 0; attempt < 20_000 && !settled; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) return;
      if (!fdTargetExists(realRoot)) continue;
      renameSync(root, moved);
      mkdirSync(root);
      renamed = true;
      return;
    }
  })();

  try {
    await assert.rejects(operation, isFileError("changed", "workspace-root"));
  } finally {
    await tracked;
    await watcher;
  }
  assert.equal(renamed, true);
});

test("memory directory replacement during a load is detected", async (t) => {
  const root = await tempRoot(t);
  const memoryFiles = [];
  const fixture = {};
  for (let index = 0; index < 32; index++) {
    const relative = `memory/file-${index}.md`;
    memoryFiles.push(relative);
    fixture[relative] = `memory ${index}`;
  }
  await writeFiles(root, fixture);
  const realMemory = realpathSync(join(root, "memory"));
  const moved = join(root, "memory.moved");
  t.after(() => rm(moved, { recursive: true, force: true }));

  let settled = false;
  let replaced = false;
  const operation = load(root, { memoryFiles });
  const tracked = operation.then(() => { settled = true; }, () => { settled = true; });
  const watcher = (async () => {
    for (let attempt = 0; attempt < 20_000 && !settled; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) return;
      if (!fdTargetExists(realMemory)) continue;
      renameSync(join(root, "memory"), moved);
      mkdirSync(join(root, "memory"));
      for (let index = 0; index < 32; index++) {
        writeFileSync(join(root, "memory", `file-${index}.md`), fixture[`memory/file-${index}.md`]);
      }
      replaced = true;
      return;
    }
  })();

  try {
    await assert.rejects(operation, (error) => {
      assert.ok(error instanceof WorkspaceContextFileError);
      assert.equal(error.kind, "changed");
      assert.match(error.source, /^memory/);
      return true;
    });
  } finally {
    await tracked;
    await watcher;
  }
  assert.equal(replaced, true);
});

test("root-level selected file replacement after its read is detected", async (t) => {
  const root = await tempRoot(t);
  const memoryFiles = [];
  const fixture = { "AGENTS.md": "original instructions" };
  for (let index = 0; index < 32; index++) {
    const relative = `memory/file-${index}.md`;
    memoryFiles.push(relative);
    fixture[relative] = `memory ${index}`;
  }
  await writeFiles(root, fixture);
  const realMemory = realpathSync(join(root, "memory"));
  const moved = join(root, "AGENTS.md.moved");
  t.after(() => rm(moved, { force: true }));

  let settled = false;
  let replaced = false;
  const operation = load(root, { memoryFiles });
  const tracked = operation.then(() => { settled = true; }, () => { settled = true; });
  const watcher = (async () => {
    for (let attempt = 0; attempt < 50_000 && !settled; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) return;
      // The memory directory can only be opened after every bootstrap file,
      // including AGENTS.md, has been read and closed.
      if (!fdTargetExists(realMemory)) continue;
      renameSync(join(root, "AGENTS.md"), moved);
      writeFileSync(join(root, "AGENTS.md"), "REPLACEMENT_AFTER_READ");
      replaced = true;
      return;
    }
  })();

  try {
    await assert.rejects(operation, isFileError("changed", "AGENTS.md"));
  } finally {
    await tracked;
    await watcher;
  }
  assert.equal(replaced, true);
});

test("identity source limits count code points and revoked proxies are typed inputs", async (t) => {
  const root = await tempRoot(t);
  const acceptedSource = "😀".repeat(CONTEXT_LIMITS.sourceChars);
  const snapshot = await load(root, {
    identity: { source: acceptedSource, content: "identity" },
  });
  assert.equal([...snapshot.identity.source].length, CONTEXT_LIMITS.sourceChars);
  assert.equal(snapshot.identity.source, acceptedSource);

  await assert.rejects(load(root, {
    identity: { source: "😀".repeat(CONTEXT_LIMITS.sourceChars + 1), content: "identity" },
  }), isInputError);

  const revokedRequest = Proxy.revocable({ workspaceRoot: root }, {});
  revokedRequest.revoke();
  await assert.rejects(loadWorkspaceContextSnapshot(revokedRequest.proxy), isInputError);

  const revokedMemory = Proxy.revocable(["memory/MEMORY.md"], {});
  revokedMemory.revoke();
  await assert.rejects(load(root, { memoryFiles: revokedMemory.proxy }), isInputError);

  const revokedIdentity = Proxy.revocable({ source: "session:x", content: "identity" }, {});
  revokedIdentity.revoke();
  await assert.rejects(load(root, { identity: revokedIdentity.proxy }), isInputError);
});

test("a failed close during root traversal never leaks the newly opened directory", async (t) => {
  if (typeof registerHooks !== "function") {
    t.skip("module.registerHooks is unavailable on this runtime");
    return;
  }
  const root = await tempRoot(t);
  // Node gives every FileHandle a per-instance `close`, so a prototype patch can never inject a
  // failure. Route a fresh copy of fs-safe.js to a shim instead: its second close really closes and
  // then fails. The traversal closes `/` cleanly and fails on the tmpdir handle right after
  // the workspace-root directory was opened, so a leaked new descriptor is visible as an open fd
  // targeting the root.
  const shim = `data:text/javascript,${encodeURIComponent([
    'import * as real from "node:fs/promises";',
    "export * from 'node:fs/promises';",
    "let closes = 0;",
    "export const open = async (...args) => {",
    "  const handle = await real.open(...args);",
    "  const close = handle.close;",
    "  handle.close = async () => {",
    "    await close.call(handle);",
    "    closes += 1;",
    '    if (closes === 2) throw Object.assign(new Error("synthetic close failure"), { code: "EIO" });',
    "  };",
    "  return handle;",
    "};",
  ].join("\n"))}`;
  const marker = "fs-safe.js?close-failure";
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:fs/promises" && String(context.parentURL).includes(marker)) {
        return { url: shim, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const fsSafe = await import(new URL(`../dist/context/fs-safe.js?close-failure`, import.meta.url).href);
  const failures = [];
  await assert.rejects(
    fsSafe.openAbsoluteDirectoryNoFollow(root, (error) => { failures.push(error); return error; }),
    (error) => failures.length === 1 && error.code === "EIO" && error.message === "synthetic close failure",
  );
  assert.equal(fdTargetExists(root), false, "no descriptor survives the failed traversal");
});
