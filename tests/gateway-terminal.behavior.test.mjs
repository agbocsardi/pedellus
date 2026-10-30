import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { Writable } from "node:stream";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? join(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { workspaceContextGatewayOptions } = await import(pathToFileURL(`${pkg}/dist/context/workspace-host.js`).href);
const { prepareDataDirectory } = await import(pathToFileURL(`${pkg}/dist/store.js`).href);
const { gatewaySocketPath, serveLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/server.js`).href);
const { connectLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
const { LocalGatewayError } = await import(pathToFileURL(`${pkg}/dist/local/protocol.js`).href);
const { runTerminalConversation } = await import(pathToFileURL(`${pkg}/dist/terminal/index.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);

const context = BACKGROUND_CONTEXT;
const timeoutMs = 15_000;

async function eventually(check, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

function lines(...values) {
  return (async function* () { yield* values; })();
}

function capture(chunks) {
  return new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
}

async function makeEnvironment(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-local-gateway-"));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace);
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "memory", "MEMORY.md"), "# Memory\n\nsynthetic fixture memory\n");
  const config = parseConfig({
    workspace,
    dataDir,
    model: { provider: "fixture", modelId: "alpha" },
    allowedModels: [
      { provider: "fixture", modelId: "alpha" },
      { provider: "fixture", modelId: "beta" },
    ],
    toolAllowlist: ["read"],
    episodeSummary: { enabled: false },
    workspaceContext: { memoryFiles: ["memory/MEMORY.md"] },
  }, directory);
  const provider = fauxProvider({
    provider: "fixture",
    tokensPerSecond: 1000,
    models: [
      { id: "alpha", name: "Alpha", reasoning: true },
      { id: "beta", name: "Beta", reasoning: true },
    ],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const prepared = await prepareDataDirectory(config);
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const gateway = await openGateway(config, context, {
    models,
    ...workspaceContextGatewayOptions(config),
  });
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: config.toolAllowlist ?? [],
    contextRefresh: config.workspaceContext !== undefined,
    presets: config.modelPreset !== undefined,
  });
  t.after(async () => {
    await server.close();
    await gateway.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  return { gateway, provider, socketPath };
}

function terminalIO(client, input) {
  const chunks = [];
  const output = capture(chunks);
  return {
    chunks,
    io: {
      input,
      output,
      errorOutput: output,
      modelSelection: {
        list: () => client.listModels(context),
        select: (selection) => client.selectModel(selection, context),
        ...(client.presets ? { selectPreset: (name) => client.selectModelPreset(name, context) } : {}),
      },
      toolPolicy: { tools: client.tools },
      contextRefresh: {
        available: client.contextRefresh,
        refresh: () => client.refreshContext(context),
      },
      history: {
        defaultSession: client.sessionKey,
        search: (query, ctx) => client.historySearch(query, ctx),
        listEpisodes: (sessionKey, query, ctx) => client.listEpisodes(sessionKey, query, ctx),
        episode: (sessionKey, startEntryId, ctx) => client.episode(sessionKey, startEntryId, ctx),
        entries: (sessionKey, query, limit, cursor, ctx) => client.historyEntries(sessionKey, query, limit, cursor, ctx),
      },
    },
  };
}

test("a CLI attaches, disconnects and resumes while the gateway keeps serving", { timeout: 30_000 }, async (t) => {
  const { gateway, provider, socketPath } = await makeEnvironment(t);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  provider.setResponses([
    fauxAssistantMessage("synthetic telegram-only marker reply"),
    fauxAssistantMessage("synthetic answer one"),
    () => gate.then(() => fauxAssistantMessage("synthetic-gated-answer")),
    fauxAssistantMessage("synthetic second answer"),
  ]);

  // A mapped channel conversation is a separate durable conversation in the same gateway.
  const channel = await gateway.conversationFor("telegram:alpha", context);
  const channelSubmission = await channel.submit({ type: "input", content: "telegram-only marker" }, context);
  assert.equal((await channelSubmission.wait(context)).status, "done");

  const first = await connectLocalGateway({ socketPath, context });
  const firstSession = first.sessionKey;
  const firstConversation = first.id;
  assert.equal(firstSession, "cli:default");
  const session = terminalIO(first, lines(
    "/status",
    "/model",
    "/model fixture beta high",
    "/model",
    "/tools",
    "/refresh",
    "hello from the CLI",
  ));
  await runTerminalConversation(first, context, session.io);
  const printed = session.chunks.join("");
  assert.match(printed, /Model: fixture\/alpha[\s\S]*Run: idle/);
  assert.match(printed, /Current model: fixture\/alpha/);
  assert.match(printed, /Selected model: fixture\/beta \(thinking: high\)/);
  assert.match(printed, /Current model: fixture\/beta/);
  assert.match(printed, /Coding tools configured for authenticated chats: read/);
  assert.match(printed, /Workspace context refreshed for this conversation: 0 skill\(s\)/);
  assert.match(printed, /synthetic answer one/);
  await first.close();

  // The terminal left; the gateway and its already admitted work did not.
  assert.equal((await gateway.listModels("cli:default", context)).selected.modelId, "beta");
  const second = await connectLocalGateway({ socketPath, context });
  assert.equal(second.sessionKey, firstSession);
  assert.equal(second.id, firstConversation);
  const gated = await second.submit("slow gated turn", context);
  assert.ok(Number.isSafeInteger(gated.id));
  await second.close();
  releaseGate();
  const conversation = await gateway.conversationFor(firstSession, context);
  await eventually(async () => {
    const page = await conversation.entries({}, 50, undefined, context);
    return page.items.some((entry) => JSON.stringify(entry.model ?? []).includes("synthetic-gated-answer"));
  }, "an admitted turn did not survive the CLI disconnect");

  const third = await connectLocalGateway({ socketPath, context });
  assert.equal(third.id, firstConversation);
  const resumed = terminalIO(third, lines(
    "/history 10",
    "/search telegram-only",
    "/episodes --session telegram:alpha",
    "/abort",
    "/new",
    "/status",
    "second CLI turn",
  ));
  await runTerminalConversation(third, context, resumed.io);
  const resumedOutput = resumed.chunks.join("");
  assert.match(resumedOutput, /Assistant: synthetic answer one/);
  assert.match(resumedOutput, /Assistant: synthetic-gated-answer/);
  assert.match(resumedOutput, /session=telegram:alpha/);
  assert.match(resumedOutput, /Episodes for session telegram:alpha/);
  assert.match(resumedOutput, /Native Durable conversation abort completed/);
  assert.match(resumedOutput, /Native Durable context reset admitted/);
  assert.match(resumedOutput, /Run: idle/);
  assert.match(resumedOutput, /synthetic second answer/);
  assert.doesNotMatch(resumedOutput, /telegram-only marker reply/);
  await third.close();
});

test("an attached CLI renders a turn admitted by another surface", { timeout: 20_000 }, async (t) => {
  const { gateway, provider, socketPath } = await makeEnvironment(t);
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  provider.setResponses([() => providerGate.then(() => fauxAssistantMessage("synthetic external answer"))]);
  const client = await connectLocalGateway({ socketPath, context });
  let releaseInput;
  const inputGate = new Promise((resolve) => { releaseInput = resolve; });
  const chunks = [];
  const input = (async function* () {
    yield "/status";
    await inputGate;
    yield "/history 5";
  })();
  const terminal = runTerminalConversation(client, context, { input, output: capture(chunks) });
  try {
    await eventually(async () => chunks.join("").includes("Run: idle"), "the CLI did not attach");
    const conversation = await gateway.conversationFor("cli:default", context);
    const observer = await conversation.watch(context);
    let runSeen;
    const observed = new Promise((resolve) => { runSeen = resolve; });
    observer.start(async (view) => { if (view.docs["pi.live"]?.run !== undefined) runSeen(); });
    try {
      const submission = await conversation.submit({ type: "input", content: "external surface turn" }, context);
      await observed;
      releaseProvider();
      assert.equal((await submission.wait(context)).status, "done");
    } finally {
      await observer.stop();
    }
    await eventually(async () => chunks.join("").includes("synthetic external answer"), "the external answer was not rendered");
    assert.equal(chunks.join("").split("synthetic external answer").length - 1, 1,
      "the external answer must be rendered exactly once before history is read");
    releaseInput();
    await terminal;
    assert.match(chunks.join(""), /Assistant: synthetic external answer/);
  } finally {
    releaseProvider();
    releaseInput();
    await client.close();
  }
});

test("a second local gateway owner is refused without disturbing the live one", { timeout: 20_000 }, async (t) => {
  const { gateway, socketPath } = await makeEnvironment(t);
  await assert.rejects(
    serveLocalGateway({
      socketPath,
      gateway,
      context,
      tools: [],
      contextRefresh: false,
      presets: false,
    }),
    (error) => error instanceof LocalGatewayError && error.reason === "address",
  );
  // The rejected attempt must not unlink the live endpoint.
  const client = await connectLocalGateway({ socketPath, context });
  assert.equal(client.sessionKey, "cli:default");
  const status = await client.status(context);
  assert.equal(status.run, undefined);
  assert.deepEqual(status.inbox.total, 0);
  const named = await connectLocalGateway({ socketPath, context, conversation: "work" });
  assert.equal(named.sessionKey, "cli:work");
  assert.notEqual(named.id, client.id);
  await named.close();
  await client.close();
});

test("malformed and out-of-scope requests stay inside the attach scope", { timeout: 20_000 }, async (t) => {
  const { socketPath } = await makeEnvironment(t);
  const raw = await rawConnection(socketPath);
  try {
    raw.send({ id: 1, method: "attach", params: { conversation: "telegram:alpha" } });
    assert.deepEqual(await raw.next(), { id: 1, error: { code: "invalid", message: "conversation name is not accepted" } });
    raw.send({ id: 2, method: "attach", params: { conversation: ".." } });
    assert.equal((await raw.next()).error.code, "invalid");
    raw.write("this is not json\n");
    assert.deepEqual(await raw.next(), { id: 0, error: { code: "invalid", message: "invalid request envelope" } });
    await raw.closed();
  } finally {
    raw.destroy();
  }

  const scoped = await rawConnection(socketPath);
  try {
    scoped.send({ id: 1, method: "status" });
    assert.equal((await scoped.next()).error.code, "unavailable");
    scoped.send({ id: 2, method: "attach", params: {} });
    assert.equal((await scoped.next()).result.sessionKey, "cli:default");
    scoped.send({ id: 3, method: "answer", params: { entryId: -1 } });
    assert.equal((await scoped.next()).error.code, "invalid");
    scoped.send({ id: 4, method: "dropEverything", params: {} });
    assert.equal((await scoped.next()).error.code, "invalid");
    scoped.send({ id: 5, method: "historyEpisodes", params: { session: "telegram:missing" } });
    assert.equal((await scoped.next()).error.code, "failed");
    scoped.send({ id: 6, method: "status" });
    assert.equal((await scoped.next()).result.run, undefined);
  } finally {
    scoped.destroy();
  }

  // A rejected raw client never removes the live gateway for a legitimate one.
  const client = await connectLocalGateway({ socketPath, context });
  assert.equal((await client.status(context)).run, undefined);
  await client.close();
});

test("default --config and agent attach instead of opening another runtime", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-agent-attach-"));
  const configFile = join(directory, "config.json");
  await mkdir(join(directory, "workspace"));
  await writeFile(configFile, JSON.stringify({
    workspace: "workspace",
    dataDir: "state",
    model: { provider: "faux", modelId: "faux-1" },
  }));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const legacy = await runCli(["--config", configFile]);
  assert.deepEqual({ code: legacy.code, signal: legacy.signal }, { code: 1, signal: null }, legacy.stderr);
  assert.match(legacy.stderr, /no running gateway answers on this configuration's local endpoint/);
  assert.match(legacy.stderr, /diagnostic details suppressed/);
  assert.ok(!legacy.stderr.includes(directory), "the attach diagnostic must not disclose the data path");
  await assert.rejects(stat(join(directory, "state", "nanobot.sqlite")), /ENOENT/,
    "an attach attempt must not open a Durable store");

  const explicit = await runCli(["agent", "--config", configFile]);
  assert.equal(explicit.code, 1);
  assert.match(explicit.stderr, /no running gateway answers/);
  const rejectedName = await runCli(["agent", "--config", configFile, "--conversation", "../escape"]);
  assert.equal(rejectedName.code, 1);
  assert.match(rejectedName.stderr, /Usage: nanobot/);
});

function runCli(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(pkg, "dist", "cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function rawConnection(socketPath) {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = connect({ path: socketPath });
    const buffered = [];
    const waiting = [];
    const closeWaiters = [];
    let closed = false;
    const flush = () => {
      while (waiting.length > 0 && buffered.length > 0) {
        waiting.shift()(JSON.parse(buffered.shift()));
      }
    };
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      let newline = text.indexOf("\n");
      while (newline >= 0) {
        buffered.push(text.slice(0, newline));
        text = text.slice(newline + 1);
        newline = text.indexOf("\n");
      }
      flush();
    });
    socket.on("close", () => {
      closed = true;
      for (const waiter of closeWaiters) waiter();
    });
    socket.on("error", () => undefined);
    socket.once("connect", () => resolveConnection({
      send: (value) => socket.write(`${JSON.stringify(value)}\n`),
      write: (value) => socket.write(value),
      next: () => new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => rejectNext(new Error("no local gateway response")), timeoutMs);
        timer.unref();
        waiting.push((value) => { clearTimeout(timer); resolveNext(value); });
        flush();
      }),
      closed: () => new Promise((resolveClosed) => {
        if (closed) { resolveClosed(); return; }
        closeWaiters.push(resolveClosed);
      }),
      destroy: () => socket.destroy(),
    }));
    socket.once("error", rejectConnection);
  });
}
