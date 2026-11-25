import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pkg = process.env.PI_MODEL_CANDIDATE ?? resolve(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { workspaceContextGatewayOptions } = await import(
  pathToFileURL(`${pkg}/dist/context/workspace-host.js`).href
);
const { WorkspaceContextFileError } = await import(
  pathToFileURL(`${pkg}/dist/context/workspace.js`).href
);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(
  pathToFileURL(`${ai}/index.js`).href
);
const { getCurrentSystemPrompt } = await import(
  pathToFileURL(`${ai}/utils/transcript.js`).href
);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const context = BACKGROUND_CONTEXT;

async function tempRoot(t, label) {
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

function setupModels(providerId, captured) {
  const provider = fauxProvider({ provider: providerId, models: [{ id: "synthetic", name: "Synthetic" }] });
  provider.setResponses(Array.from({ length: 20 }, () => (request) => {
    captured.push(getCurrentSystemPrompt(request.messages));
    return fauxAssistantMessage("synthetic reply");
  }));
  const models = createModels();
  models.setProvider(provider.provider);
  return models;
}

function hostConfig(workspace, dataDir, extra = {}) {
  const model = { provider: "fixture", modelId: "synthetic" };
  return parseConfig({
    workspace,
    dataDir,
    model,
    allowedModels: [model],
    ...extra,
  }, resolve(workspace, ".."));
}

async function send(gateway, key, requestId, message) {
  const conversation = await gateway.conversationFor(key, context);
  const submission = await conversation.submit({ type: "input", content: message, requestId }, context);
  assert.equal((await submission.wait(context)).status, "done");
  return conversation;
}

function isFileError(kind, source) {
  return (error) => {
    assert.ok(error instanceof WorkspaceContextFileError, `expected file error, got ${error?.name}: ${error?.message}`);
    assert.equal(error.kind, kind);
    if (source !== undefined) assert.equal(error.source, source);
    return true;
  };
}

test("workspace context stays default-off without an explicit config section", async (t) => {
  const temp = await tempRoot(t, "nanobot-workspace-host-off-");
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  await writeFiles(workspace, {
    "AGENTS.md": "MUST-NOT-APPEAR-WITHOUT-OPT-IN",
    "memory/system/now.md": "SYSTEM-MUST-NOT-APPEAR-WITHOUT-OPT-IN",
  });
  const config = hostConfig(workspace, join(temp, "state"));
  assert.equal(config.workspaceContext, undefined);
  assert.deepEqual(workspaceContextGatewayOptions(config), {});

  const captured = [];
  const models = setupModels("fixture", captured);
  let gateway;
  try {
    gateway = await openGateway(config, context, { models, ...workspaceContextGatewayOptions(config) });
    const conversation = await send(gateway, "cli:default", "off-1", "hello");
    assert.doesNotMatch(captured[0], /MUST-NOT-APPEAR-WITHOUT-OPT-IN/);
    const agent = await conversation.agent(context);
    assert.doesNotMatch(JSON.stringify(agent.sections), /nanobot_/);
  } finally {
    if (gateway) await gateway.close(context);
  }
});

test("explicit host config drives the Gateway path for every session and across reopen", async (t) => {
  const temp = await tempRoot(t, "nanobot-workspace-host-on-");
  const workspace = join(temp, "workspace");
  const dataDir = join(temp, "state");
  await mkdir(workspace);
  await writeFiles(workspace, {
    "AGENTS.md": "AGENTS-ALPHA",
    "SOUL.md": "SOUL-ALPHA",
    "USER.md": "USER-ALPHA",
    "memory/MEMORY.md": "MEMORY-ALPHA",
    "memory/system/preferences.md": "PREFERENCES-ALPHA",
    "memory/topics/unselected.md": "UNSELECTED-MEMORY",
  });
  const config = hostConfig(workspace, dataDir, {
    workspaceContext: {
      memoryFiles: ["memory/MEMORY.md", "memory/system/preferences.md"],
    },
  });
  assert.deepEqual(config.workspaceContext.memoryFiles, [
    "memory/MEMORY.md",
    "memory/system/preferences.md",
  ]);

  const captured = [];
  const models = setupModels("fixture", captured);
  let gateway;
  try {
    gateway = await openGateway(config, context, { models, agentHistory: false, ...workspaceContextGatewayOptions(config) });
    const alpha = await send(gateway, "cli:default", "alpha-1", "first");
    assert.match(captured[0], /AGENTS-ALPHA/);
    assert.match(captured[0], /SOUL-ALPHA/);
    assert.match(captured[0], /USER-ALPHA/);
    assert.match(captured[0], /MEMORY-ALPHA/);
    assert.match(captured[0], /PREFERENCES-ALPHA/);
    assert.doesNotMatch(captured[0], /UNSELECTED-MEMORY/);
    assert.match(captured[0], /Source: "workspace:AGENTS\.md"/);
    assert.match(captured[0], /Source: "workspace:memory\/MEMORY\.md"/);

    assert.doesNotMatch(captured[0], /## Identity|Your workspace is at:|## Runtime\n|## Skill /);
    const agent = await alpha.agent(context);
    // Workspace context adds no tool; the mapped chat keeps only the owner-question capability.
    assert.deepEqual(agent.tools.map((tool) => tool.name), ["ask_user"]);
    assert.deepEqual(agent.callable, []);

    const root = await gateway.harness.root(context);
    assert.doesNotMatch(JSON.stringify((await root.agent(context)).sections), /nanobot_|AGENTS-ALPHA/);

    // A later session loads fresh files; the earlier conversation keeps its captured snapshot.
    await writeFiles(workspace, {
      "AGENTS.md": "AGENTS-BETA",
      "memory/MEMORY.md": "MEMORY-BETA",
    });
    await send(gateway, "telegram:42", "beta-1", "second");
    assert.match(captured[1], /AGENTS-BETA/);
    assert.match(captured[1], /MEMORY-BETA/);
    assert.doesNotMatch(captured[1], /AGENTS-ALPHA|MEMORY-ALPHA/);

    await send(gateway, "cli:default", "alpha-2", "third");
    assert.match(captured[2], /AGENTS-ALPHA/);
    assert.match(captured[2], /MEMORY-ALPHA/);
    assert.doesNotMatch(captured[2], /AGENTS-BETA|MEMORY-BETA/);

    // Reopen reconstructs mapped-session snapshots before resume from the config selection.
    await gateway.close(context);
    gateway = undefined;
    await writeFiles(workspace, {
      "AGENTS.md": "AGENTS-GAMMA",
      "memory/MEMORY.md": "MEMORY-GAMMA",
    });
    gateway = await openGateway(config, context, { models, ...workspaceContextGatewayOptions(config) });
    await send(gateway, "cli:default", "alpha-3", "fourth");
    assert.match(captured[3], /AGENTS-GAMMA/);
    assert.match(captured[3], /MEMORY-GAMMA/);
    assert.doesNotMatch(captured[3], /AGENTS-BETA|MEMORY-BETA/);
  } finally {
    if (gateway) await gateway.close(context);
  }
});

test("empty memoryFiles loads system bodies and the topic tree through refresh and startup", { timeout: 20_000 }, async (t) => {
  const temp = await tempRoot(t, "nanobot-system-memory-host-");
  const workspace = join(temp, "workspace");
  await writeFiles(workspace, {
    "AGENTS.md": "AGENTS-AUTO",
    "SOUL.md": "SOUL-AUTO",
    "USER.md": "USER-AUTO",
    "memory/system/now.md": "---\ndescription: Current priorities\n---\nSYSTEM_BODY",
    "memory/system/empty.md": "",
    "memory/topic.md": "---\ndescription: Topic description\n---\nTOPIC_BODY_NOT_IN_PROMPT",
  });
  const config = hostConfig(workspace, join(temp, "state"), {
    workspaceContext: { memoryFiles: [], memoryManifest: true },
  });
  const captured = [];
  const models = setupModels("fixture", captured);
  let gateway;
  try {
    gateway = await openGateway(config, context, { models, agentHistory: false, ...workspaceContextGatewayOptions(config) });
    await send(gateway, "cli:default", "auto-1", "hello");
    const first = captured.at(-1);
    for (const marker of ["AGENTS-AUTO", "SOUL-AUTO", "USER-AUTO", "SYSTEM_BODY"]) {
      assert.equal(first.split(marker).length - 1, 1, marker);
    }
    assert.match(first, /- `memory\/system\/now\.md` \(loaded, \d+ chars\): Current priorities/);
    assert.match(first, /- `memory\/topic\.md` \(topic, \d+ chars\): Topic description/);
    assert.doesNotMatch(first, /TOPIC_BODY_NOT_IN_PROMPT|memory\/system\/empty\.md/);
    assert.equal(first.split("# Memory Tree").length - 1, 1);
    assert.equal(first.split("- `memory/system/now.md`").length - 1, 1);

    await writeFiles(workspace, { "memory/system/later.md": "LATER_BODY" });
    await send(gateway, "cli:default", "auto-2", "same snapshot");
    assert.doesNotMatch(captured.at(-1), /LATER_BODY/);
    await gateway.refreshContext("cli:default", context);
    await send(gateway, "cli:default", "auto-3", "refreshed");
    assert.match(captured.at(-1), /LATER_BODY/);
    assert.match(captured.at(-1), /- `memory\/system\/later\.md` \(loaded,/);

    await writeFiles(workspace, { "memory/system/bad.md": Buffer.from([0xff]) });
    await assert.rejects(gateway.refreshContext("cli:default", context), isFileError("encoding", "memory/system/bad.md"));
    await send(gateway, "cli:default", "auto-4", "old snapshot survives");
    assert.match(captured.at(-1), /SYSTEM_BODY/);
    assert.match(captured.at(-1), /LATER_BODY/);
    await rm(join(workspace, "memory/system/bad.md"));
    await rm(join(workspace, "memory/system/later.md"));
    await writeFiles(workspace, { "memory/system/now.md": "RESET_BODY" });
    assert.equal((await gateway.resetSession("cli:default", context)).promptRebuilt, true);
    await send(gateway, "cli:default", "auto-5", "reset");
    assert.match(captured.at(-1), /RESET_BODY/);
    assert.doesNotMatch(captured.at(-1), /SYSTEM_BODY|LATER_BODY/);

    await gateway.close(context);
    gateway = undefined;
    await writeFiles(workspace, { "memory/system/startup.md": "STARTUP_BODY" });
    gateway = await openGateway(config, context, { models, agentHistory: false, ...workspaceContextGatewayOptions(config) });
    await send(gateway, "cli:default", "auto-6", "reopened");
    assert.match(captured.at(-1), /STARTUP_BODY/);
    const root = await gateway.harness.root(context);
    assert.doesNotMatch(JSON.stringify((await root.agent(context)).sections), /nanobot_|STARTUP_BODY/);
  } finally {
    if (gateway) await gateway.close(context);
  }

  // The memory tree switch controls metadata only, not system-body injection.
  const withoutManifest = hostConfig(workspace, join(temp, "unused"), { workspaceContext: {} });
  const snapshot = await workspaceContextGatewayOptions(withoutManifest).contextSnapshotProvider("cli:default", 1, context);
  assert.ok(snapshot.memory.some(({ content }) => content === "STARTUP_BODY"));
  assert.ok(snapshot.memory.every(({ source }) => source !== "memory:manifest"));
});

test("workspaceContext config rejects unsafe, duplicate, and unknown selections", () => {
  const model = { provider: "fixture", modelId: "synthetic" };
  const base = {
    workspace: "/synthetic/workspace",
    dataDir: "/synthetic/state",
    model,
    allowedModels: [model],
  };
  for (const memoryFiles of [
    "../escape.md",
    "/absolute.md",
    "memory/../escape.md",
    "AGENTS.md",
    "memory/MEMORY.txt",
    "memory/MEMORY.md\\..\\escape.md",
    ["memory/MEMORY.md", "memory/MEMORY.md"],
  ]) {
    assert.throws(
      () => parseConfig({ ...base, workspaceContext: { memoryFiles } }),
      /workspaceContext\.memoryFiles/,
      `expected rejection for ${JSON.stringify(memoryFiles)}`,
    );
  }
  // Selection count is the owner's choice: no source-count cap rejects a long list.
  const manyFiles = Array.from({ length: 200 }, (_value, index) => `memory/file-${index}.md`);
  assert.deepEqual(
    parseConfig({ ...base, workspaceContext: { memoryFiles: manyFiles, memoryManifest: true } }).workspaceContext.memoryFiles,
    manyFiles,
  );
  assert.throws(
    () => parseConfig({ ...base, workspaceContext: { bootstrapFiles: ["AGENTS.md"] } }),
    /workspaceContext\.bootstrapFiles is not a recognized option/,
  );
  assert.deepEqual(parseConfig({ ...base, workspaceContext: {} }).workspaceContext, {
    memoryFiles: [],
  });
});

test("loader denials reject conversation setup without installing partial context", async (t) => {
  const temp = await tempRoot(t, "nanobot-workspace-host-denied-");
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  await writeFiles(workspace, {
    "AGENTS.md": "MUST-NOT-APPEAR-AFTER-DENIAL",
    "memory/selected.md": "selected",
  });
  const captured = [];
  const models = setupModels("fixture", captured);
  let gateway;
  try {
    const missing = hostConfig(workspace, join(temp, "state-missing"), {
      workspaceContext: { memoryFiles: ["memory/missing.md"] },
    });
    gateway = await openGateway(missing, context, { models, ...workspaceContextGatewayOptions(missing) });
    await assert.rejects(
      gateway.conversationFor("denied-session", context),
      isFileError("missing", "memory/missing.md"),
    );
    // A retry re-runs the loader instead of caching the failure or a partial snapshot.
    await assert.rejects(
      gateway.conversationFor("denied-session", context),
      isFileError("missing", "memory/missing.md"),
    );
    assert.doesNotMatch(captured.join("\n"), /MUST-NOT-APPEAR-AFTER-DENIAL/);
    await gateway.close(context);
    gateway = undefined;
    // Startup/recovery re-runs the same loader and fails closed on the same denial.
    await assert.rejects(
      openGateway(missing, context, { models, ...workspaceContextGatewayOptions(missing) }),
      isFileError("missing", "memory/missing.md"),
    );

    const symlinked = join(temp, "symlinked-workspace");
    await mkdir(join(symlinked, "memory"), { recursive: true });
    await writeFiles(temp, { "outside.md": "outside-secret" });
    await writeFile(join(symlinked, "AGENTS.md"), "SYMLINK-AGENTS");
    await symlink(join(temp, "outside.md"), join(symlinked, "memory", "MEMORY.md"));
    const linked = hostConfig(symlinked, join(temp, "state-symlink"), {
      workspaceContext: { memoryFiles: ["memory/MEMORY.md"] },
    });
    gateway = await openGateway(linked, context, { models, ...workspaceContextGatewayOptions(linked) });
    await assert.rejects(
      gateway.conversationFor("symlink-session", context),
      isFileError("symlink", "memory/MEMORY.md"),
    );
    assert.doesNotMatch(captured.join("\n"), /outside-secret|SYMLINK-AGENTS/);
  } finally {
    if (gateway) await gateway.close(context);
  }
});
