// Local CLI attachments through the gateway's shared media store.
//
// No network, bot, provider credential or personal workspace is used: the model is
// a faux provider over a temporary store, and the operator files are synthetic.
// Every wait is the terminal's own settlement; no schedule sleeps are involved.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import test from "node:test";

const pkg = process.env.PI_MODEL_CANDIDATE ?? join(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { prepareDataDirectory } = await import(pathToFileURL(`${pkg}/dist/store.js`).href);
const { gatewaySocketPath, serveLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/server.js`).href);
const { connectLocalGateway } = await import(pathToFileURL(`${pkg}/dist/local/client.js`).href);
const { runTerminalConversation } = await import(pathToFileURL(`${pkg}/dist/terminal/index.js`).href);
const { createMediaStore } = await import(pathToFileURL(`${pkg}/dist/media/attachments.js`).href);
const { LocalAttachmentError, prepareLocalAttachment } = await import(pathToFileURL(`${pkg}/dist/media/local.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider } = await import(pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);

const context = BACKGROUND_CONTEXT;
const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF_BYTES = Buffer.from("%PDF-1.4\nsynthetic document body\n%%EOF\n");

function lines(...values) {
  return (async function* () { yield* values; })();
}

function capture(chunks) {
  return new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
}

async function makeEnvironment(t, { media } = { media: { directory: "media" } }) {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-local-attach-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const provider = fauxProvider({ provider: "fixture", models: [{ id: "alpha", name: "Alpha" }] });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = { provider: "fixture", modelId: "alpha" };
  const configValues = {
    workspace,
    dataDir: join(directory, "state"),
    model,
    allowedModels: [model],
    toolAllowlist: [],
    episodeSummary: { enabled: false },
    ...(media === undefined ? {} : { media }),
  };
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify(configValues));
  const config = parseConfig(configValues, directory);
  const prepared = await prepareDataDirectory(config);
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const gateway = await openGateway(config, context, { models });
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: [],
    contextRefresh: false,
    presets: false,
    ...(media === undefined
      ? {}
      : {
          attachments: {
            store: createMediaStore({
              workspace: config.workspace,
              ...(media.directory === undefined ? {} : { directory: media.directory }),
            }),
          },
        }),
  });
  t.after(async () => {
    await server.close();
    await gateway.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace, provider, gateway, socketPath, configFile };
}

/** The same host wiring as the shipped CLI: resolve an operator path, send no bytes. */
function terminalIO(client, input) {
  const chunks = [];
  const output = capture(chunks);
  return {
    chunks,
    io: {
      input,
      output,
      errorOutput: output,
      ...(client.attachments
        ? { attachments: { submit: (path, prompt, ctx) => client.submitAttachment(resolve(path), prompt, ctx) } }
        : {}),
    },
  };
}

function userMessages(requests) {
  return requests.flatMap((request) => request.messages ?? []).filter((message) => message.role === "user");
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function mediaFiles(workspace) {
  try {
    return await readdir(join(workspace, "media"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("a local photo becomes image content and a document stays an unread stored original", { timeout: 30_000 }, async (t) => {
  const { directory, workspace, provider, socketPath } = await makeEnvironment(t);
  const requests = [];
  provider.setResponses(Array.from({ length: 8 }, () => (request) => {
    requests.push({ messages: request.messages });
    return fauxAssistantMessage("attachment noted");
  }));

  const photoPath = join(directory, "operator photo.jpg");
  const documentPath = join(directory, "operator notes.pdf");
  await writeFile(photoPath, PHOTO_BYTES);
  await writeFile(documentPath, PDF_BYTES);

  const client = await connectLocalGateway({ socketPath, context });
  assert.equal(client.attachments, true);
  const terminal = terminalIO(client, lines(
    `/attach ${photoPath} -- describe this photo`,
    `/attach ${documentPath}`,
    "plain text prompt",
  ));
  try {
    await runTerminalConversation(client, context, terminal.io);
    const output = terminal.chunks.join("");
    assert.match(output, /Stored photo at media\/photo-[0-9a-f]{16}\.jpg \(\d+ bytes\) and admitted its turn\./);
    assert.match(output, /Stored document at media\/document-[0-9a-f]{16}\.pdf \(\d+ bytes\) and admitted its turn\./);
    assert.match(output, /attachment noted/);
  } finally {
    await client.close();
  }

  const messages = userMessages(requests);
  const photoTurn = messages.find((message) => messageText(message).includes("describe this photo"));
  assert.ok(photoTurn, "the photo turn reached the model");
  assert.ok(Array.isArray(photoTurn.content), "the photo turn carries pi-ai content parts");
  const text = messageText(photoTurn);
  const images = photoTurn.content.filter((part) => part.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/jpeg");
  assert.equal(images[0].data, PHOTO_BYTES.toString("base64"));
  assert.match(text, /Local CLI photo attachment from the operator/);
  assert.match(text, /Stored file \(workspace-relative\): media\/photo-[0-9a-f]{16}\.jpg/);
  assert.match(text, /also attached as image content/);
  assert.doesNotMatch(text, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the operator's absolute path is never repeated to the model");

  const documentTurn = messages.find((message) => messageText(message).includes("operator notes.pdf"));
  assert.ok(documentTurn, "the document turn reached the model");
  assert.equal(typeof documentTurn.content, "string", "a document turn is ordinary text");
  assert.match(documentTurn.content, /Local CLI document attachment from the operator/);
  assert.match(documentTurn.content, /Stored file \(workspace-relative\): media\/document-[0-9a-f]{16}\.pdf/);
  assert.match(documentTurn.content, /No content was extracted from this document/);

  const plain = messages.find((message) => message.content === "plain text prompt");
  assert.ok(plain, "an ordinary text-only prompt is unchanged");

  const stored = await mediaFiles(workspace);
  assert.equal(stored.length, 2);
  const photoName = stored.find((name) => name.startsWith("photo-"));
  const documentName = stored.find((name) => name.startsWith("document-"));
  assert.deepEqual(await readFile(join(workspace, "media", photoName)), PHOTO_BYTES);
  assert.deepEqual(await readFile(join(workspace, "media", documentName)), PDF_BYTES);
});

test("a local photo still uses the configured vision handoff for a text-only preset", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-local-vision-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const provider = fauxProvider({ provider: "cli-vision", models: [
    { id: "chat", name: "Chat", reasoning: false, input: ["text"] },
    { id: "eyes", name: "Eyes", reasoning: false, input: ["text", "image"] },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const calls = [];
  provider.setResponses(Array.from({ length: 20 }, () => (request, _options, _state, model) => {
    const describer = model.id === "eyes";
    const images = request.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : []);
    const text = messageText({ content: request.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "text")
      : []) });
    calls.push({ kind: describer ? "describer" : "generation", modelId: model.id, images, text });
    return fauxAssistantMessage(describer ? "synthetic description of the local photo" : "LOCAL-VISION-OK");
  }));
  const config = parseConfig({
    workspace,
    dataDir: join(directory, "state"),
    modelPresets: {
      chat: { provider: "cli-vision", modelId: "chat", needsVisionHandoff: true },
      eyes: { provider: "cli-vision", modelId: "eyes" },
    },
    modelPreset: "chat",
    visionHandoff: { describerPreset: "eyes" },
    toolAllowlist: [],
    episodeSummary: { enabled: false },
    media: { directory: "media" },
  }, directory);
  const prepared = await prepareDataDirectory(config);
  const socketPath = gatewaySocketPath(prepared.canonicalDataDir);
  const gateway = await openGateway(config, context, { models });
  const server = await serveLocalGateway({
    socketPath,
    gateway,
    context,
    tools: [],
    contextRefresh: false,
    presets: true,
    attachments: { store: createMediaStore({ workspace: config.workspace, directory: config.media.directory }) },
  });
  const photoPath = join(directory, "vision local.jpg");
  await writeFile(photoPath, PHOTO_BYTES);
  t.after(async () => {
    await server.close();
    await gateway.close(context);
    await rm(directory, { recursive: true, force: true });
  });

  const client = await connectLocalGateway({ socketPath, context });
  try {
    const admitted = await client.submitAttachment(photoPath, "what is in this photo?", context);
    assert.equal((await admitted.submission.wait(context)).status, "done");
  } finally {
    await client.close();
  }

  const describers = calls.filter((call) => call.kind === "describer");
  assert.equal(describers.length, 1, "one describer call for the local photo");
  assert.equal(describers[0].images.length, 1);
  assert.equal(describers[0].images[0].data, PHOTO_BYTES.toString("base64"));
  const main = calls.filter((call) => call.kind === "generation" && call.modelId === "chat"
    && call.text.includes("[An image is attached in the conversation transcript"));
  assert.equal(main.length, 1, "one transformed main-conversation request");
  assert.equal(main[0].images.length, 0, "the text-only main preset received no raw image");
  assert.match(main[0].text, /synthetic description of the local photo/);
  assert.match(main[0].text, /what is in this photo\?/);
  assert.match(main[0].text, /Stored file \(workspace-relative\): media\/photo-/);
});

test("same content is stored once and refusals stay fixed and bounded", { timeout: 30_000 }, async (t) => {
  const { directory, workspace, provider, socketPath } = await makeEnvironment(t);
  provider.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("duplicate noted")));
  const photoPath = join(directory, "same.jpg");
  await writeFile(photoPath, PHOTO_BYTES);

  const client = await connectLocalGateway({ socketPath, context });
  try {
    const first = await client.submitAttachment(photoPath, "", context);
    const second = await client.submitAttachment(photoPath, "again", context);
    assert.equal(first.attachment.relativePath, second.attachment.relativePath);
    assert.equal((await first.submission.wait(context)).status, "done");
    assert.equal((await second.submission.wait(context)).status, "done");
    assert.equal((await mediaFiles(workspace)).length, 1, "identical bytes reuse one stored original");

    // The operator path is a protocol value; relative or missing paths are refused with fixed text.
    await assert.rejects(client.submitAttachment("relative.jpg", "", context),
      /attachment path must be an absolute path without control characters/);
    await assert.rejects(client.submitAttachment(join(directory, "missing.jpg"), "", context),
      /attachment file could not be read/);
    const emptyPath = join(directory, "empty.jpg");
    await writeFile(emptyPath, Buffer.alloc(0));
    await assert.rejects(client.submitAttachment(emptyPath, "", context), /attachment file is empty/);
    const fakeImage = join(directory, "not-really.png");
    await writeFile(fakeImage, PDF_BYTES);
    await assert.rejects(client.submitAttachment(fakeImage, "", context),
      /attachment is named as an image but its bytes are not a supported image/);

    // No attachment text, path or bytes leak into a refusal.
    await assert.rejects(client.submitAttachment(join(directory, "missing.jpg"), "", context), (error) => {
      assert.doesNotMatch(error.message, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    await client.close();
  }

  // The shared store's own byte limit is enforced before publication.
  const store = createMediaStore({ workspace, maxFileBytes: 16 });
  const oversized = join(directory, "oversized.jpg");
  await writeFile(oversized, Buffer.concat([PHOTO_BYTES, Buffer.alloc(32)]));
  await assert.rejects(prepareLocalAttachment(store, { path: oversized }),
    (error) => error instanceof LocalAttachmentError && error.rejection === "too-large");

  // A directory is not a readable attachment and is never opened as one.
  await assert.rejects(prepareLocalAttachment(store, { path: directory }),
    (error) => error instanceof LocalAttachmentError && error.rejection === "unreadable");
});

test("the shipped agent CLI wires /attach through the gateway", { timeout: 30_000 }, async (t) => {
  const { directory, workspace, provider, configFile } = await makeEnvironment(t);
  provider.setResponses([fauxAssistantMessage("cli attachment reply")]);
  const photoPath = join(directory, "cli-photo.jpg");
  await writeFile(photoPath, PHOTO_BYTES);

  const result = await runAgentCli(configFile, `/attach ${photoPath} -- what is this?\n`);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr);
  assert.match(result.stdout, /Stored photo at media\/photo-[0-9a-f]{16}\.jpg \(\d+ bytes\) and admitted its turn\./);
  assert.match(result.stdout, /cli attachment reply/);
  assert.equal(result.stderr, "");
  assert.equal((await mediaFiles(workspace)).length, 1);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
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

test("opening a FIFO path cannot park the local request", { timeout: 10_000 }, async (t) => {
  const { directory, workspace } = await makeEnvironment(t);
  const store = createMediaStore({ workspace });
  const fifo = join(directory, "swapped.jpg");
  try {
    await mkfifo(fifo);
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("mkfifo is unavailable");
      return;
    }
    throw error;
  }
  // The non-blocking open reaches the opened-fd regular-file refusal without waiting
  // for a FIFO writer; the outer test timeout would catch a regression that blocks.
  await assert.rejects(prepareLocalAttachment(store, { path: fifo }),
    (error) => error instanceof LocalAttachmentError && error.rejection === "unreadable");
});

function mkfifo(path) {
  return new Promise((resolveFifo, rejectFifo) => {
    execFile("mkfifo", [path], (error) => (error ? rejectFifo(error) : resolveFifo()));
  });
}

test("without media the local surface keeps its text-only commands", { timeout: 20_000 }, async (t) => {
  const { socketPath, provider } = await makeEnvironment(t, { media: undefined });
  provider.setResponses([fauxAssistantMessage("text only")]);
  const client = await connectLocalGateway({ socketPath, context });
  assert.equal(client.attachments, false);
  await assert.rejects(client.submitAttachment("/tmp/anything.jpg", "", context), /local attachments are not configured/);
  const terminal = terminalIO(client, lines("/attach /tmp/anything.jpg", "ordinary line"));
  try {
    await runTerminalConversation(client, context, terminal.io);
    const output = terminal.chunks.join("");
    assert.match(output, /Local attachments are unavailable here: configure media/);
    assert.match(output, /text only/);
  } finally {
    await client.close();
  }
});
