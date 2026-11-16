// Bounded model-facing images from the native read tool.
//
// The gateway runs over a temporary workspace and store with a faux provider.
// Each fixture image is a synthetic PNG: a random-pixel large canvas, a
// random-pixel image that only exceeds the byte bound, and a tiny image that
// must pass through unchanged. The checks prove that only the model-bound copy
// is bounded, that the file on disk keeps its exact bytes, that the resize note
// keeps coordinates mappable, and that an oversized declared canvas is refused
// without being decoded or sent.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { deflateSync } from "node:zlib";

const pkg = process.env.PI_NANOBOT_CANDIDATE ?? join(import.meta.dirname, "..");
const ai = `${pkg}/node_modules/@earendil-works/pi-ai/dist`;
const chord = `${pkg}/node_modules/@earendil-works/chord/dist`;
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { parseConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { READ_IMAGE_LIMITS } = await import(pathToFileURL(`${pkg}/dist/media/read-images.js`).href);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  pathToFileURL(`${ai}/index.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${chord}/context/index.js`).href);

const context = BACKGROUND_CONTEXT;
const SESSION = "telegram:11:chat:501";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "nanobot-read-images-"));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace);
  const provider = fauxProvider({ provider: "fixture", models: [
    { id: "alpha", name: "Alpha", reasoning: false, input: ["text", "image"] },
  ] });
  const models = createModels();
  models.setProvider(provider.provider);
  const config = parseConfig({
    workspace,
    dataDir,
    model: { provider: "fixture", modelId: "alpha" },
    allowedModels: [{ provider: "fixture", modelId: "alpha" }],
    toolAllowlist: ["read"],
    episodeSummary: { enabled: false },
  }, directory);
  const gateway = await openGateway(config, context, { models, agentHistory: false });
  t.after(async () => {
    await gateway.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, provider, gateway };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

/** An 8-bit RGB PNG whose pseudorandom pixels compress poorly, like a noisy photo. */
function noisyPng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    let state = (0x9e3779b9 + y * 0x9e3779b9) >>> 0;
    for (let x = 0; x < width * 3; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[row + 1 + x] = state >>> 24;
    }
  }
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A complete PNG header that declares a canvas far beyond the decode bound, with no pixel data. */
function declaredPng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([signature, chunk("IHDR", header)]);
}

function messagesOf(entries) {
  return entries.flatMap((entry) => entry.model ?? []);
}

function toolResultsOf(entries) {
  return messagesOf(entries).filter((message) => message.role === "toolResult");
}

function blocksOf(message) {
  return Array.isArray(message.content) ? message.content : [];
}

function textOf(message) {
  return blocksOf(message).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function imagesOf(messages) {
  return messages.flatMap((message) => blocksOf(message).filter((block) => block.type === "image"));
}

function imageSizeOf(data, mimeType) {
  const bytes = Buffer.from(data, "base64");
  if (mimeType === "image/png") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType !== "image/jpeg") return undefined;
  for (let offset = 2; offset + 9 <= bytes.length;) {
    assert.equal(bytes[offset], 0xff, "JPEG segment must start with a marker");
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

test("read bounds the model-facing image copy and leaves the original file intact", { timeout: 60_000 }, async (t) => {
  const { workspace, provider, gateway } = await fixture(t);
  const wide = noisyPng(1800, 1200);
  const noisy = noisyPng(1000, 700);
  const tiny = noisyPng(8, 8);
  await writeFile(join(workspace, "wide.png"), wide);
  await writeFile(join(workspace, "noisy.png"), noisy);
  await writeFile(join(workspace, "tiny.png"), tiny);
  assert.ok(wide.toString("base64").length > READ_IMAGE_LIMITS.maxBytes);
  assert.ok(noisy.toString("base64").length > READ_IMAGE_LIMITS.maxBytes);

  let finalRequest;
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "wide.png" }, { id: "read-wide" }),
      fauxToolCall("read", { path: "noisy.png" }, { id: "read-noisy" }),
      fauxToolCall("read", { path: "tiny.png" }, { id: "read-tiny" }),
    ], { stopReason: "toolUse" }),
    (transcript) => {
      finalRequest = transcript.messages;
      return fauxAssistantMessage("synthetic bounded answer");
    },
  ]);

  const conversation = await gateway.conversationFor(SESSION, context);
  const submission = await conversation.submit({
    type: "input",
    content: "read the image files",
    requestId: "read-images",
  }, context);
  assert.equal((await submission.wait(context)).status, "done");

  const entries = (await conversation.entries({ order: "ascending" }, 200, undefined, context)).items;
  const results = new Map(toolResultsOf(entries).map((message) => [message.toolCallId, message]));

  const wideResult = results.get("read-wide");
  assert.ok(wideResult, "the wide image must reach a tool result");
  assert.equal(wideResult.isError, false);
  const [wideImage] = blocksOf(wideResult).filter((block) => block.type === "image");
  assert.ok(wideImage, "the wide image must be returned as an image block");
  assert.ok(["image/jpeg", "image/png"].includes(wideImage.mimeType));
  assert.ok(wideImage.data.length <= READ_IMAGE_LIMITS.maxBytes,
    `${wideImage.data.length} exceeds ${READ_IMAGE_LIMITS.maxBytes}`);
  const wideSize = imageSizeOf(wideImage.data, wideImage.mimeType);
  assert.ok(wideSize, "the bounded image must keep a readable header");
  assert.ok(wideSize.width <= READ_IMAGE_LIMITS.maxWidth, `width ${wideSize.width}`);
  assert.ok(wideSize.height <= READ_IMAGE_LIMITS.maxHeight, `height ${wideSize.height}`);
  const wideNote = textOf(wideResult);
  assert.match(wideNote, /Resized from 1800x1200 to \d+x\d+/);
  assert.match(wideNote, /Multiply coordinates by [\d.]+ to map them to the original/,
    "the model must be able to map coordinates back to the file it read");

  const noisyResult = results.get("read-noisy");
  assert.ok(noisyResult);
  assert.equal(noisyResult.isError, false);
  const [noisyImage] = blocksOf(noisyResult).filter((block) => block.type === "image");
  assert.ok(noisyImage, "the byte-bound image must be returned");
  assert.ok(noisyImage.data.length <= READ_IMAGE_LIMITS.maxBytes,
    `${noisyImage.data.length} exceeds ${READ_IMAGE_LIMITS.maxBytes}`);
  assert.match(textOf(noisyResult), /Resized from|Converted from/);

  const tinyResult = results.get("read-tiny");
  assert.ok(tinyResult);
  assert.equal(tinyResult.isError, false);
  const [tinyImage] = blocksOf(tinyResult).filter((block) => block.type === "image");
  assert.deepEqual(tinyImage, { type: "image", data: tiny.toString("base64"), mimeType: "image/png" },
    "an image already within the bounds passes through unchanged");
  assert.doesNotMatch(textOf(tinyResult), /Resized from|Converted from/);

  // The next request carries the same bounded copies, not the source files.
  assert.ok(finalRequest, "the turn must reach a final generation");
  const requestImages = imagesOf(finalRequest);
  assert.equal(requestImages.length, 3);
  for (const image of requestImages) {
    assert.ok(image.data.length <= READ_IMAGE_LIMITS.maxBytes);
  }

  // The authoritative files are untouched byte for byte.
  assert.deepEqual(await readFile(join(workspace, "wide.png")), wide);
  assert.deepEqual(await readFile(join(workspace, "noisy.png")), noisy);
  assert.deepEqual(await readFile(join(workspace, "tiny.png")), tiny);

  // Provenance stays the read call's own path; a later locator or the file's name is not used.
  const readCalls = messagesOf(entries)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => blocksOf(message))
    .filter((block) => block.type === "toolCall" && block.name === "read");
  assert.deepEqual(readCalls.map((call) => call.arguments.path), ["wide.png", "noisy.png", "tiny.png"]);
});

test("read refuses an oversized declared canvas without decoding or sending it", { timeout: 30_000 }, async (t) => {
  const { workspace, provider, gateway } = await fixture(t);
  const bomb = declaredPng(20_000, 20_000);
  await writeFile(join(workspace, "bomb.png"), bomb);
  let finalRequest;
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "bomb.png" }, { id: "read-bomb" }),
    ], { stopReason: "toolUse" }),
    (transcript) => {
      finalRequest = transcript.messages;
      return fauxAssistantMessage("synthetic refusal acknowledged");
    },
  ]);

  const conversation = await gateway.conversationFor(SESSION, context);
  const submission = await conversation.submit({
    type: "input",
    content: "read the oversized image",
    requestId: "read-bomb",
  }, context);
  assert.equal((await submission.wait(context)).status, "done");

  const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
  const result = toolResultsOf(entries).find((message) => message.toolCallId === "read-bomb");
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.equal(imagesOf([result]).length, 0, "a refused image must not be sent");
  assert.match(textOf(result), /cannot be prepared for the model/);
  assert.ok(finalRequest, "the turn must reach a final generation");
  assert.equal(imagesOf(finalRequest).length, 0);
  assert.deepEqual(await readFile(join(workspace, "bomb.png")), bomb);
});
