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
const { loadConfig, parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { workspaceContextGatewayOptions } = await import(pathToFileURL(`${pkg}/dist/context/workspace-host.js`).href);
const { prepareDataDirectory } = await import(pathToFileURL(`${pkg}/dist/store.js`).href);
const { gatewaySocketPath, serveLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/server.js`).href);
const { connectLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
const { LocalGatewayError } = await import(pathToFileURL(`${pkg}/dist/local/protocol.js`).href);
const { runTerminalConversation } = await import(pathToFileURL(`${pkg}/dist/terminal/index.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);
const { AskQuestionsDoc, AskDeliveryUnknown } = await import(pathToFileURL(`${pkg}/dist/questions/index.js`).href);
const { ToolResultEntry } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-durable/dist/index.js`).href);

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

async function toolResultText(conversation, callId) {
  const page = await conversation.entries({}, 200, undefined, context);
  const result = page.items.filter(ToolResultEntry.is)
    .map((entry) => entry.model?.[0])
    .find((message) => message?.toolCallId === callId);
  assert.ok(result, `synthetic ${callId} call reached the transcript`);
  return (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function askDocument(conversation) {
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(AskQuestionsDoc, conversation.id);
    return {
      questions: doc.questions.map((question) => ({
        id: question.id,
        status: question.status,
        delivery: question.delivery,
      })),
    };
  }, context);
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
  const configValues = {
    workspace: "workspace",
    dataDir: "state",
    model: { provider: "fixture", modelId: "alpha" },
    allowedModels: [
      { provider: "fixture", modelId: "alpha" },
      { provider: "fixture", modelId: "beta" },
    ],
    toolAllowlist: ["read"],
    episodeSummary: { enabled: false },
    workspaceContext: { memoryFiles: ["memory/MEMORY.md"] },
  };
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify(configValues));
  // Loaded from the file so the gateway also exposes owner MCP management, exactly as `npm start` does.
  const config = await loadConfig(configFile);
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
  return { gateway, provider, socketPath, configFile };
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
      ...(client.mcp
        ? {
            mcp: {
              list: () => client.mcpList(context),
              submitCallback: (text) => client.mcpSubmitCallback(text, context),
            },
          }
        : {}),
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
  assert.match(printed, /Model: fixture\/beta \(thinking: high\)/);
  assert.match(printed, /Current model: fixture\/beta/);
  assert.match(printed, /Coding tools: read/);
  assert.match(printed, /Context refreshed\./);
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
  assert.match(resumedOutput, /Idle\. Queue cleared\./);
  assert.match(resumedOutput, /Context reset\./);
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
    observer.start(async (call) => {
      if (call.kind === "value" && call.value.docs["pi.live"]?.run !== undefined) runSeen();
    });
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

test("the owner reads MCP status from the attached terminal", { timeout: 20_000 }, async (t) => {
  const { socketPath } = await makeEnvironment(t);
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await client.close(); });
  assert.equal(client.mcp, true, "a gateway opened from a config file exposes MCP management");
  const { chunks, io } = terminalIO(client, lines(
    "/mcp",
    "/mcp bogus",
  ));
  io.prompt = () => {};
  await runTerminalConversation(client, context, io);
  const printed = chunks.join("");
  assert.match(printed, /MCP is not configured in this gateway/);
  assert.match(printed, /OAuth logins waiting for a callback: none/);
  assert.match(printed, /Usage: \/mcp/);
});

test("two real CLI attachments sharing a conversation refuse ambiguous login delivery", { timeout: 20_000 }, async (t) => {
  const { gateway, provider, socketPath } = await makeEnvironment(t);
  const first = await connectLocalGateway({ socketPath, context });
  const second = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal(first.sessionKey, second.sessionKey);
  assert.equal(gateway.mcpSurfaces.surfaceFor(first.sessionKey), undefined);
  const links = [];
  first.onMcpAuthorization = (link) => links.push(link);
  second.onMcpAuthorization = (link) => links.push(link);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp", {
      action: "add", name: "remote", server: { url: "http://127.0.0.1:1/mcp", oauth: true },
    }, { id: "ambiguous-add" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("login refused"),
  ]);
  const chat = await gateway.conversationFor(first.sessionKey, context);
  const submission = await chat.submit({ type: "input", content: "add and log in" }, context);
  assert.equal((await submission.wait(context)).status, "done");
  assert.equal(links.length, 0);
  assert.equal((await gateway.mcpAdmin.list(context)).logins.length, 0);
  const transcript = JSON.stringify((await chat.entries({}, 100, undefined, context)).items);
  assert.match(transcript, /No unique authenticated owner surface/);
  await first.close();
  await eventually(() => gateway.mcpSurfaces.surfaceFor(second.sessionKey) !== undefined,
    "remaining attachment should become the unique owner for a future login");
});

test("the CLI surface receives a direct MCP link and consumes a pasted callback before model admission", { timeout: 20_000 }, async (t) => {
  const { gateway, provider, socketPath } = await makeEnvironment(t);
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await client.close(); });
  const authorizations = [];
  client.onMcpAuthorization = (authorization) => authorizations.push(authorization);
  const surface = gateway.mcpSurfaces.surfaceFor(client.sessionKey);
  assert.ok(surface, "the attached CLI registers an owner surface for its exact session");
  await surface.deliverAuthorization(client.sessionKey, {
    requestId: "0123456789abcdef",
    name: "synthetic",
    url: "http://127.0.0.1:1234/authorize?state=SYNTHETIC-STATE",
    expiresAtMs: Date.now() + 60_000,
  }, context);
  await eventually(() => authorizations.length === 1, "the CLI did not receive the direct authorization link");
  assert.match(authorizations[0].url, /SYNTHETIC-STATE/);

  const callback = "http://127.0.0.1:54321/callback?code=SYNTHETIC-CODE&state=SYNTHETIC-STATE";
  const { chunks, io } = terminalIO(client, lines(callback));
  io.prompt = () => {};
  await runTerminalConversation(client, context, io);
  const printed = chunks.join("");
  assert.match(printed, /No MCP login is waiting for a callback in this chat/);
  assert.ok(!printed.includes("SYNTHETIC-CODE"), "the callback code is not echoed");
  assert.equal(provider.state.callCount, 0, "the callback never became model input");
});

test("terminal /help lists only offered commands and one command's detail on demand", { timeout: 20_000 }, async (t) => {
  const { socketPath } = await makeEnvironment(t);
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await client.close(); });
  assert.equal(client.mcp, true, "a gateway opened from a config file exposes MCP management");
  const { chunks, io } = terminalIO(client, lines(
    "/help",
    "/help model",
    "/help attach",
    "/help guarantee",
    "/help reload",
    "/help ../SYNTHETIC-HELP-ARGUMENT",
  ));
  io.prompt = () => {};
  await runTerminalConversation(client, context, io);
  const printed = chunks.join("");
  // The listing is the catalogue's one-line form, and only this host's commands are advertised.
  assert.match(printed, /Local commands in this CLI conversation:/);
  assert.match(printed, /\/model \[preset\] — List or select a model for this conversation/);
  assert.match(printed, /Not offered by this host: \/digest, \/attach, \/restart, \/reload\./);
  assert.match(printed, /Unknown slash commands are not sent to the model/);
  // `/help <command>` carries the catalogue's usage line and its one-sentence detail.
  assert.match(printed, /Usage: \/model \[preset\] \| \/model <provider> <modelId> \[thinkingLevel\]/);
  assert.match(printed, /Applies to this conversation only: a preset lasts until the gateway restarts, a direct pick persists\./);
  // A catalogued command this host lacks is refused as such; an unknown one is unknown.
  assert.match(printed, /\/attach is not offered by this host\. Configure media in the gateway configuration and restart\. Available: \/new, \/abort, /);
  assert.match(printed, /No such command \/guarantee here\. Available: \/new, /);
  // The typed name is never echoed when it is not shaped like a command.
  assert.match(printed, /No such command here\./);
  assert.doesNotMatch(printed, /SYNTHETIC-HELP-ARGUMENT|synthetic-help-argument/);
});

test("terminal /reload reports a bounded host result and is offered only by a supporting host", { timeout: 20_000 }, async (t) => {
  const { socketPath, provider } = await makeEnvironment(t);
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await client.close(); });
  let calls = 0;
  const { chunks, io } = terminalIO(client, lines(
    "/help reload",
    "/reload",
    "/reload",
    "/reload extra",
  ));
  io.prompt = () => {};
  io.reload = {
    reload: async () => (++calls === 1
      ? { status: "reloaded", models: 2, presets: 1, defaultPreset: "fast" }
      : { status: "busy" }),
  };
  await runTerminalConversation(client, context, io);
  const printed = chunks.join("");
  assert.match(printed, /Usage: \/reload\nHost-only: validates the whole file/);
  assert.match(printed, /Model configuration reloaded: 2 allowed models, 1 preset; default preset fast\./);
  assert.match(printed, /Background model captures .* are unchanged\./);
  assert.match(printed, /Model reload refused: live work is active or queued, so nothing was changed\./);
  assert.match(printed, /Usage: \/reload/);
  assert.equal(provider.state.callCount, 0, "a host reload is never a model turn");
});

test("typed local commands share the catalogue refusal and never reach the model", { timeout: 20_000 }, async (t) => {
  const { socketPath } = await makeEnvironment(t);
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => { await client.close(); });
  const { chunks, io } = terminalIO(client, lines(
    "/attach",
    "/digest",
    "/restart",
    "/reload",
    "/goal",
    "/foo_bar",
    "/../SYNTHETIC-TYPED-ARGUMENT",
  ));
  io.prompt = () => {};
  await runTerminalConversation(client, context, io);
  const printed = chunks.join("");
  // A catalogued command this host lacks gives the same reason `/help <command>` gives.
  for (const name of ["attach", "digest", "restart", "reload"]) {
    assert.match(printed, new RegExp(`/${name} is not offered by this host\\.`));
  }
  // The refusal keeps the actionable fix and the effect command's no-effect guarantee.
  assert.match(printed, /\/attach is not offered by this host\. Configure media in the gateway configuration and restart\. Available: /);
  assert.match(printed, /\/digest is not offered by this host\. Nothing was started\. Available: /);
  assert.doesNotMatch(printed, /Unsupported slash command|not implemented in this CLI|was removed from this CLI/);
  // An unknown bounded name keeps its name and the // escape; the former fixed list is gone.
  assert.match(printed, /No such command \/goal here\.[\s\S]*?It was not sent to the model\. Use \/\/goal to send it literally\./);
  assert.match(printed, /No such command \/foo_bar here\.[\s\S]*?Use \/\/foo_bar to send it literally\./);
  // A name that is not command-shaped is never echoed, and the line still never reaches the model.
  assert.match(printed, /No such command here\.[\s\S]*?It was not sent to the model\./);
  assert.doesNotMatch(printed, /SYNTHETIC-TYPED-ARGUMENT|synthetic-typed-argument/);
});

test("the local protocol advertises reload only from a supporting gateway", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-local-reload-"));
  const socketPath = join(directory, "gateway.sock");
  let calls = 0;
  const gateway = {
    // Attach reprints still-open questions from this exact conversation, so the fake handle needs
    // one empty question document in addition to the reload surface.
    async conversationFor() {
      return {
        id: 1,
        async commit(change) {
          return change({ doc: async () => ({ version: 1, questions: [] }) });
        },
      };
    },
    async reloadModels() {
      calls += 1;
      return { status: "refused", reason: "pinned" };
    },
  };
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: [],
    contextRefresh: false,
    presets: true,
  });
  const client = await connectLocalGateway({ socketPath, context });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(client.reloadSupported, true);
  assert.deepEqual(await client.reloadModels(context), { status: "refused", reason: "pinned" });
  assert.equal(calls, 1, "the attach capability and the method use the same host surface");
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

test("an operator-only connection reaches no chat, and a missing episode stays a reply", { timeout: 20_000 }, async (t) => {
  const { socketPath } = await makeEnvironment(t);
  const { LocalRemoteError } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
  const operator = await connectLocalGateway({ socketPath, operatorOnly: true, context });
  // Its type has no conversation methods; a raw call still reaches no chat on the gateway.
  await assert.rejects(operator.status(context), (error) => error instanceof LocalRemoteError && error.code === "unavailable");
  await operator.close();
  await operator.close();

  const client = await connectLocalGateway({ socketPath, context });
  // JSON drops `undefined`; the reply must still arrive and leave the connection usable.
  assert.equal(await client.episode(client.sessionKey, 999_999, context), undefined);
  assert.equal((await client.status(context)).run, undefined);
  await client.close();
  await assert.rejects(client.status(context), /closed/);
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
  assert.match(rejectedName.stderr, /Usage: pedellus/);
});

test("real agent piped input is not lost while the watch attaches", { timeout: 30_000 }, async (t) => {
  const { configFile } = await makeEnvironment(t);

  const immediate = await runAgentCli(configFile, "/status\n");
  assert.deepEqual({ code: immediate.code, signal: immediate.signal }, { code: 0, signal: null }, immediate.stderr);
  assert.match(immediate.stdout, /Run: idle/);
  assert.equal(immediate.stderr, "");

  const empty = await runAgentCli(configFile, "");
  assert.deepEqual({ code: empty.code, signal: empty.signal }, { code: 0, signal: null }, empty.stderr);
  assert.equal(empty.stderr, "");
  assert.equal(empty.stdout, "");

  const ordered = await runAgentCli(configFile, "/status\n/tools\n/model\n/status\n");
  assert.deepEqual({ code: ordered.code, signal: ordered.signal }, { code: 0, signal: null }, ordered.stderr);
  const firstStatus = ordered.stdout.indexOf("Run: idle");
  const tools = ordered.stdout.indexOf("Coding tools: read");
  const model = ordered.stdout.indexOf("Current model: fixture/alpha");
  const lastStatus = ordered.stdout.lastIndexOf("Run: idle");
  assert.ok(firstStatus >= 0 && tools > firstStatus && model > tools && lastStatus > model,
    `immediate commands were dropped or reordered:\n${ordered.stdout}`);
  assert.equal(ordered.stderr, "");
});

/** Run the real built agent against the already-listening test gateway. */
function runAgentCli(configFile, stdinText) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(pkg, "dist", "cli.js"), "agent", "--config", configFile], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdinText);
  });
}

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

test("ask_user refuses without a surface and reaches the attached CLI as durable questions", { timeout: 30_000 }, async (t) => {
  const { gateway, provider, socketPath } = await makeEnvironment(t);
  const conversation = await gateway.conversationFor("cli:default", context);
  const askCall = (id) => fauxToolCall("ask_user", {
    questions: [{
      question: "Deploy now?",
      options: [{ label: "Yes", description: "publish the current build" }, { label: "No" }],
    }],
  }, { id });

  // No owner surface is attached yet: the tool admits nothing and says so.
  provider.setResponses([
    fauxAssistantMessage(askCall("ask-no-surface"), { stopReason: "toolUse" }),
    // A refused question does not end the turn: the model continues without pretending to ask.
    fauxAssistantMessage("synthetic answer without asking"),
  ]);
  const unattached = await conversation.submit({ type: "input", content: "ask without an owner surface" }, context);
  assert.equal((await unattached.wait(context)).status, "done");
  assert.match(await toolResultText(conversation, "ask-no-surface"), /No live owner surface/);
  assert.equal((await askDocument(conversation)).questions.length, 0);

  const client = await connectLocalGateway({ socketPath, context });
  const delivered = [];
  client.onAskQuestion = (question) => delivered.push(question);
  provider.setResponses([
    fauxAssistantMessage([askCall("ask-mixed"), fauxToolCall("read", { path: "missing.md" }, { id: "mixed-read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("mixed question was refused before delivery"),
  ]);
  await (await client.submit("mixed tool round", context)).wait(context);
  assert.match(await toolResultText(conversation, "ask-mixed"), /only tool call/);
  assert.equal(delivered.length, 0);
  assert.equal((await askDocument(conversation)).questions.length, 0);
  provider.setResponses([
    fauxAssistantMessage(askCall("ask-with-surface"), { stopReason: "toolUse" }),
    fauxAssistantMessage("synthetic answer to the owner decision"),
    fauxAssistantMessage(askCall("ask-again"), { stopReason: "toolUse" }),
  ]);

  const asked = await client.submit("ask with this terminal attached", context);
  assert.equal((await asked.wait(context)).status, "done");
  await eventually(() => delivered.length === 1, "the attached CLI did not receive the question");
  assert.equal(delivered[0].question, "Deploy now?");
  assert.deepEqual(delivered[0].options.map((option) => option.label), ["Yes", "No"]);
  assert.match(await toolResultText(conversation, "ask-with-surface"), /delivered to the owner's surface/);

  let doc = await askDocument(conversation);
  assert.equal(doc.questions.length, 1);
  assert.equal(doc.questions[0].status, "pending");
  assert.equal(doc.questions[0].delivery, "delivered");

  // Typed replies settle the oldest delivered question atomically with ordinary input admission.
  const answered = await client.submit("Yes", context);
  assert.equal((await answered.wait(context)).status, "done");
  await eventually(async () => {
    const page = await conversation.entries({}, 200, undefined, context);
    return page.items.some((entry) =>
      JSON.stringify(entry.model ?? []).includes("synthetic answer to the owner decision"));
  }, "the typed answer did not reach the model");
  assert.equal((await askDocument(conversation)).questions[0].status, "answered");
  await (await client.submit("ask again", context)).wait(context);
  await eventually(() => delivered.length === 2, "typed reply did not free the next question");
  await client.reset(context);
  doc = await askDocument(conversation);
  assert.equal(doc.questions[0].status, "answered");
  assert.equal(doc.questions[1].status, "cancelled", "/new retires questions the new context cannot answer");
  await client.close();
});

test("partial question delivery ends the turn while keeping accepted questions answerable", { timeout: 15_000 }, async (t) => {
  const { gateway, provider } = await makeEnvironment(t);
  const conversation = await gateway.conversationFor("cli:default", context);
  let sends = 0;
  const detach = gateway.askSurfaces.attach({
    owns: (key) => key === "cli:default",
    async deliverQuestion() { if (++sends > 1) throw new Error("definite refusal"); },
  });
  t.after(detach);
  let continued = false;
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall("ask_user", {
      questions: ["First decision?", "Second decision?"].map((question) => ({
        question, options: [{ label: "Yes" }, { label: "No" }],
      })),
    }, { id: "ask-partial" })], { stopReason: "toolUse" }),
    () => { continued = true; return fauxAssistantMessage("must not continue"); },
  ]);
  assert.equal((await (await conversation.submit({ type: "input", content: "ask" }, context)).wait(context)).status, "done");
  assert.equal(continued, false);
  assert.match(await toolResultText(conversation, "ask-partial"), /Delivered question/);
  assert.deepEqual((await askDocument(conversation)).questions.map((question) => [question.status, question.delivery]),
    [["pending", "delivered"], ["failed", "failed"]]);
});

test("ambiguous question delivery is quarantined rather than reported as non-delivery", { timeout: 15_000 }, async (t) => {
  const { gateway, provider } = await makeEnvironment(t);
  const conversation = await gateway.conversationFor("cli:default", context);
  const detach = gateway.askSurfaces.attach({
    owns: (key) => key === "cli:default",
    async deliverQuestion() { throw new AskDeliveryUnknown(); },
  });
  t.after(detach);
  provider.setResponses([fauxAssistantMessage([fauxToolCall("ask_user", {
    questions: [{ question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] }],
  }, { id: "ask-unknown" })], { stopReason: "toolUse" })]);
  assert.equal((await (await conversation.submit({ type: "input", content: "ask" }, context)).wait(context)).status, "done");
  assert.match(await toolResultText(conversation, "ask-unknown"), /outcome is unknown/);
  const doc = await askDocument(conversation);
  assert.equal(doc.questions[0].status, "unknown");
  assert.equal(doc.questions[0].delivery, "unknown");
});
