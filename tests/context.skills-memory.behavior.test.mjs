import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadMemoryContext } from "../dist/context/memory.js";
import { loadSkillsContext } from "../dist/context/skills.js";

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

test("a full manifest lists every entry instead of shortening itself", async (t) => {
  const root = await tempRoot(t);
  const files = {};
  for (let index = 0; index < 80; index++) {
    const name = `memory/topic-${String(index).padStart(2, "0")}.md`;
    files[name] = `---\ndescription: ${"d".repeat(240)}\n---\nbody`;
  }
  await writeFiles(root, files);

  const memory = await loadMemoryContext({ workspaceRoot: root });
  assert.equal(memory.entries.length, 80);
  const listed = memory.manifest.split("\n").filter((line) => line.startsWith("- `memory/"));
  assert.equal(listed.length, 80);
  assert.doesNotMatch(memory.manifest, /more memory files/);
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
  assert.match(memory.manifest, /1 memory entries refused \(name, depth, or path length/);
});
