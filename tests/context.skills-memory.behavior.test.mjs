import assert from "node:assert/strict";
import { readdirSync, readlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MemoryContextInputError,
  loadMemoryContext,
  validateMemoryTopicPath,
} from "../dist/context/memory.js";
import { SkillsContextInputError, loadSkillsContext } from "../dist/context/skills.js";
import { MemoryContextFileError } from "../dist/context/memory.js";
import { createNotesBackend } from "../dist/memory/notes.js";

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "nanobot-context-sizes-"));
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

test("a large skill body and description stay discoverable and loadable", async (t) => {
  const root = await tempRoot(t);
  // Both sizes exceed the removed per-file (64 KiB) and description (1,024
  // character) caps; neither may drop, shorten or disable the skill.
  const description = "D".repeat(4_000);
  const body = "body line\n".repeat(12_000);
  await writeFiles(root, {
    "skills/big/SKILL.md": `---\ndescription: ${description}\n---\n${body}`,
  });

  const result = await loadSkillsContext({ workspaceRoot: root });
  assert.equal(result.discovered.length, 1);
  const skill = result.discovered[0];
  assert.equal(skill.name, "big");
  assert.equal(skill.description, description);
  assert.equal(skill.enabled, true);
  assert.ok(skill.content.includes(body));
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].content, skill.content);
  assert.ok(result.summary.includes(description));
});

test("a large metadata block does not disable a skill", async (t) => {
  const root = await tempRoot(t);
  // Previously an 8 KiB metadata value was reported as oversized, which marked
  // the whole skill unavailable even though its body was readable.
  const metadata = JSON.stringify({ requires: { bins: [], env: [] }, note: "n".repeat(16_000) });
  await writeFiles(root, {
    "skills/gated/SKILL.md": `---\ndescription: gated skill\nmetadata: ${metadata}\n---\nbody`,
  });

  const result = await loadSkillsContext({ workspaceRoot: root });
  assert.equal(result.discovered.length, 1);
  assert.deepEqual(result.discovered[0].metadataStatus, { status: "parsed" });
  assert.equal(result.discovered[0].enabled, true);
});

test("a memory topic above the old byte cap is still listed", async (t) => {
  const root = await tempRoot(t);
  const body = "T".repeat(200_000);
  await writeFiles(root, {
    "memory/large.md": `---\ndescription: a large topic\n---\n${body}`,
  });

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].path, "memory/large.md");
  assert.equal(memory.entries[0].description, "a large topic");
  assert.equal(memory.entries[0].bodyChars, body.length);
  assert.match(memory.manifest, /memory\/large\.md/);
});

test("a manifest lists every entry, with no count cap and no shortening", async (t) => {
  const root = await tempRoot(t);
  const files = {};
  // 120 exceeds Python's 80-entry memory-tree slice and the removed port cap.
  for (let index = 0; index < 120; index++) {
    const name = `memory/topic-${String(index).padStart(3, "0")}.md`;
    files[name] = `---\ndescription: ${"d".repeat(240)}\n---\nbody`;
  }
  await writeFiles(root, files);

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.equal(memory.entries.length, 120);
  const listed = memory.manifest.split("\n").filter((line) => line.startsWith("- `memory/"));
  assert.equal(listed.length, 120);
  assert.doesNotMatch(memory.manifest, /more memory files|not inspected|refused/);
});

test("ordinary topic names with spaces or non-ASCII characters stay discoverable", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "memory/daily notes/2026-01-01.md": "---\ndescription: new year\n---\nbody",
    "memory/über.md": "---\ndescription: umlaut\n---\nbody",
  });

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.deepEqual(memory.entries.map((entry) => entry.path), [
    "memory/daily notes/2026-01-01.md",
    "memory/über.md",
  ]);
  assert.match(memory.manifest, /memory\/daily notes\/2026-01-01\.md/);
  assert.doesNotMatch(memory.manifest, /refused/);
});

test("an entry refused by a locator bound is counted in the manifest", async (t) => {
  const root = await tempRoot(t);
  const longSegment = `${"n".repeat(80)}.md`;
  await writeFiles(root, {
    "memory/listed.md": "body",
    [`memory/${longSegment}`]: "body",
  });

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.deepEqual(memory.entries.map((entry) => entry.path), ["memory/listed.md"]);
  assert.match(memory.manifest, /1 refused memory entry \(name, depth, or path length/);
});

test("a refusals-only tree still yields a visible manifest", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    [`memory/${"n".repeat(80)}.md`]: "body",
  });

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.equal(memory.entries.length, 0);
  assert.match(memory.manifest, /# Memory Tree/);
  assert.match(memory.manifest, /1 refused memory entry/);
  assert.ok(memory.document);
});

test("non-.md files are not reported as refused entries and dot segments stay refused", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "memory/listed.md": "body",
    [`memory/${"t".repeat(80)}.txt`]: "not a topic",
  });

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.deepEqual(memory.entries.map((entry) => entry.path), ["memory/listed.md"]);
  assert.doesNotMatch(memory.manifest, /refused/);

  for (const selection of [
    "memory/../escape.md",
    "memory/./MEMORY.md",
    "memory/a\u0001b.md",
    "memory/a\u2028b.md",
  ]) {
    assert.throws(() => validateMemoryTopicPath(selection), MemoryContextInputError, selection);
  }
});

test("a spaced or non-ASCII topic is writable through the topic-path guard", () => {
  for (const path of ["memory/daily notes/2026-01-01.md", "memory/über.md", "memory/a b/c d.md"]) {
    assert.equal(validateMemoryTopicPath(path), path);
  }
});

test("skills requests refuse inherited fields instead of treating them as present", async (t) => {
  const root = await tempRoot(t);
  // An inherited builtinSkillsRoot used to report found with an undefined value.
  const request = Object.create({ builtinSkillsRoot: root });
  request.workspaceRoot = root;
  await assert.rejects(loadSkillsContext(request), (error) =>
    error instanceof SkillsContextInputError && /builtinSkillsRoot must be an own data property/.test(error.message));
  const inheritedRoot = Object.create({ workspaceRoot: root });
  await assert.rejects(loadSkillsContext(inheritedRoot), SkillsContextInputError);
});

test("pinned skill and memory reads skip links and hard-link aliases visibly", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "skills/plain/SKILL.md": "---\ndescription: plain skill\n---\nbody",
    "outside/SKILL.md": "---\ndescription: outside\n---\nbody",
    "memory/kept.md": "# Kept topic",
    "outside/topic.md": "# Outside topic",
  });
  await mkdir(join(root, "skills", "linked"));
  await symlink(join(root, "outside", "SKILL.md"), join(root, "skills", "linked", "SKILL.md"));
  await mkdir(join(root, "skills", "aliased"));
  await link(join(root, "outside", "SKILL.md"), join(root, "skills", "aliased", "SKILL.md"));
  await link(join(root, "outside", "topic.md"), join(root, "memory", "alias.md"));

  const skills = await loadSkillsContext({ workspaceRoot: root });
  assert.deepEqual(skills.discovered.map((skill) => skill.name), ["plain"]);
  assert.deepEqual(skills.skipped, [
    { name: "aliased", reason: "hardlinked-file" },
    { name: "linked", reason: "symlinked-file" },
  ]);

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.deepEqual(memory.entries.map((entry) => entry.path), ["memory/kept.md"]);
  assert.match(memory.manifest, /1 memory files skipped/);
});

async function listenSocket(t, path) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
}

test("a Unix socket is a non-regular entry: skipped as a skill, rejected as a loaded memory file", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, { "skills/plain/SKILL.md": "---\ndescription: plain\n---\nbody" });
  await mkdir(join(root, "skills", "sock"));
  await listenSocket(t, join(root, "skills", "sock", "SKILL.md"));
  await mkdir(join(root, "memory"));
  await listenSocket(t, join(root, "memory", "socket.md"));

  const skills = await loadSkillsContext({ workspaceRoot: root });
  assert.deepEqual(skills.discovered.map((skill) => skill.name), ["plain"]);
  assert.deepEqual(skills.skipped, []);

  await assert.rejects(
    loadMemoryContext({ workspaceRoot: root, loadedFiles: ["memory/socket.md"] }),
    (error) => error instanceof MemoryContextFileError && error.kind === "not-regular" && error.source === "memory/socket.md",
  );
  // As a discovered topic it is not a regular file entry and never blocks the manifest.
  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.deepEqual(memory.entries, []);
});

test("a notes description line with an embedded line separator keeps the heading fallback", async (t) => {
  const root = await tempRoot(t);
  await writeFiles(root, {
    "memory/separated.md": "---\ndescription: first\u2028second\n---\n# Heading Fallback\nbody",
    "memory/plain.md": "---\ndescription: 'Quoted plain'\n---\nbody",
  });
  const backend = createNotesBackend();
  t.after(() => backend.close());
  const page = await backend.browse(
    { target: "notes", limit: 10 },
    { storeId: "synthetic", workspaceRoot: root, memoryFiles: [], sessions: [] },
  );
  assert.deepEqual(
    page.hits.map((hit) => [hit.source.path, hit.excerpt]),
    [["memory/plain.md", "Quoted plain"], ["memory/separated.md", "Heading Fallback"]],
  );
});

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
      // The descriptor may close between readdir and readlink.
    }
  }
  return false;
}

test("a failed parent close never leaks the open note descriptor", async (t) => {
  if (typeof registerHooks !== "function") {
    t.skip("module.registerHooks is unavailable on this runtime");
    return;
  }
  const root = await tempRoot(t);
  const note = join(root, "memory", "note.md");
  await writeFiles(root, { "memory/note.md": "---\ndescription: leak probe\n---\n# Leak Probe\nbody" });
  // Node gives every FileHandle a per-instance `close`, so a prototype patch cannot inject a
  // failure. Route a fresh copy of the notes backend to a shim whose first created handle fails
  // its close for real after closing: that first handle is the note's parent directory, closed in
  // `noteHandle`'s cleanup while the note descriptor is already open.
  const shim = `data:text/javascript,${encodeURIComponent([
    'import * as real from "node:fs/promises";',
    "export * from 'node:fs/promises';",
    "let armed = true;",
    "export const open = async (...args) => {",
    "  const handle = await real.open(...args);",
    "  if (armed) {",
    "    armed = false;",
    "    const close = handle.close;",
    "    handle.close = async () => {",
    "      await close.call(handle);",
    '      throw Object.assign(new Error("synthetic parent close failure"), { code: "EIO" });',
    "    };",
    "  }",
    "  return handle;",
    "};",
  ].join("\n"))}`;
  const marker = "notes.js?close-failure";
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:fs/promises" && String(context.parentURL).includes(marker)) {
        return { url: shim, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const notesModule = await import(new URL(`../dist/memory/notes.js?close-failure`, import.meta.url).href);
  const backend = notesModule.createNotesBackend();
  t.after(() => backend.close());
  const scope = { storeId: "synthetic", workspaceRoot: root, memoryFiles: [], sessions: [] };
  const ref = { kind: "note", path: "memory/note.md", fingerprint: "synthetic" };
  await assert.rejects(
    backend.read({ ref, limit: 64 }, ref, scope),
    /Note is unsafe, changed, unreadable or no longer available/,
  );
  assert.equal(fdTargetExists(note), false, "the note descriptor does not survive the failed parent close");
  assert.equal(fdTargetExists(join(root, "memory")), false, "the parent directory is closed behind its failing close");
});
