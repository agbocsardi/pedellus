import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createContextExtension } from "../dist/context/index.js";
import {
  WORKSPACE_CONTEXT_LIMITS,
  WorkspaceContextBoundsError,
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

function isBoundsError(bound) {
  return (error) => {
    assert.ok(error instanceof WorkspaceContextBoundsError, `expected bounds error, got ${error?.name}: ${error?.message}`);
    assert.equal(error.bound, bound);
    return true;
  };
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

test("missing and empty bootstrap files are omitted and memory is never discovered implicitly", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "AGENTS.md": "",
    "memory/MEMORY.md": "must not be loaded without an explicit selection",
  });

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
    "memory/.hidden.md",
    "outside/memory/file.md",
    "memory/",
  ];
  for (const selection of invalidSelections) {
    await assert.rejects(load(root, { memoryFiles: [selection] }), isInputError, `selection: ${selection}`);
  }

  await writeFile(join(root, "memory", "MEMORY.md"), "one");
  await assert.rejects(load(root, {
    memoryFiles: ["memory/MEMORY.md", "memory/MEMORY.md"],
  }), isInputError);

  const tooMany = Array.from({ length: WORKSPACE_CONTEXT_LIMITS.maxMemoryFiles + 1 }, (_, index) =>
    `memory/file-${index}.md`);
  await assert.rejects(load(root, { memoryFiles: tooMany }), isBoundsError("maxMemoryFiles"));
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
  await assert.rejects(load(root, {
    identity: { source: "host:identity", content: "x".repeat(WORKSPACE_CONTEXT_LIMITS.maxIdentityChars + 1) },
  }), isBoundsError("maxIdentityChars"));
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

test("file and aggregate bounds are enforced before rendering", async (t) => {
  const oversized = await tempRoot(t);
  await writeFile(join(oversized, "AGENTS.md"), "x".repeat(WORKSPACE_CONTEXT_LIMITS.maxFileBytes + 1));
  await assert.rejects(load(oversized), isBoundsError("maxFileBytes"));

  const tooManyChars = await tempRoot(t);
  await writeFiles(tooManyChars, {
    "AGENTS.md": "a".repeat(17_000),
    "SOUL.md": "b".repeat(17_000),
    "USER.md": "c".repeat(17_000),
  });
  await assert.rejects(load(tooManyChars), isBoundsError("maxTotalChars"));

  const tooManyBytes = await tempRoot(t);
  const emoji = "😀".repeat(11_000);
  await writeFiles(tooManyBytes, {
    "AGENTS.md": emoji,
    "SOUL.md": emoji,
    "USER.md": emoji,
  });
  await assert.rejects(load(tooManyBytes), isBoundsError("maxTotalBytes"));

  const identityAndFiles = await tempRoot(t);
  await writeFile(join(identityAndFiles, "AGENTS.md"), "a".repeat(40_000));
  await assert.rejects(load(identityAndFiles, {
    identity: { source: "session:large", content: "i".repeat(10_000) },
  }), isBoundsError("maxTotalChars"));
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
