import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const pkg = resolve(import.meta.dirname, "..");
const { loadModelCatalog, refreshModelCatalog, modelCatalogPath } = await import(pathToFileURL(`${pkg}/dist/model-catalog.js`).href);
const { runModelsCommand } = await import(pathToFileURL(`${pkg}/dist/model-catalog-cli.js`).href);
const { createProviderModels } = await import(pathToFileURL(`${pkg}/dist/providers.js`).href);
const { parseConfig, loadConfig } = await import(pathToFileURL(`${pkg}/dist/config.js`).href);
const { openGateway } = await import(pathToFileURL(`${pkg}/dist/runtime.js`).href);
const { BACKGROUND_CONTEXT } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/chord/dist/context/index.js`).href);
const { createModels } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-ai/dist/index.js`).href);
const { builtinProviders, getBuiltinModelDataGeneratedAt } = await import(
  pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`).href
);

const PROVIDER = "openai-codex";
const NEW_ID = "synthetic-catalog-model";
const bundledAt = getBuiltinModelDataGeneratedAt();
const bundled = builtinProviders().find((provider) => provider.id === PROVIDER).getModels();
const template = bundled[0];
const synthetic = { ...template, id: NEW_ID, name: "Synthetic Catalog Model", type: "chat" };
const NEWER = new Date(bundledAt + 86_400_000).toUTCString();
const NEWEST = new Date(bundledAt + 2 * 86_400_000).toUTCString();
const OLDER = new Date(bundledAt - 86_400_000).toUTCString();
const fixedClock = () => bundledAt + 3 * 86_400_000;

const temp = await mkdtemp(join(tmpdir(), "nanobot-model-catalog-"));
const sockets = new Set();
/** One scripted response per request; every request's headers are recorded. */
let script = [];
const seen = [];
const server = createServer((request, response) => {
  seen.push({ url: request.url, headers: request.headers });
  const next = script.shift();
  if (next === undefined || next.hang) return; // left open: the client deadline must end it
  response.writeHead(next.status, next.headers ?? {});
  response.end(next.body ?? "");
});
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temp, { recursive: true, force: true });
});

const shard = (models, lastModified = NEWER, etag = '"v1"') => ({
  status: 200,
  headers: { "content-type": "application/json", "last-modified": lastModified, etag },
  body: JSON.stringify(models),
});

async function freshDir(name) {
  const dir = join(temp, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function refresh(dir, options = {}) {
  return refreshModelCatalog(dir, [PROVIDER], { baseUrl, now: fixedClock, timeoutMs: 2_000, ...options });
}

function configFor(dir, allowed) {
  return parseConfig({
    workspace: join(dir, "workspace"),
    dataDir: join(dir, "state"),
    model: allowed[0],
    allowedModels: allowed,
  }, dir);
}

test("offline: no file is the bundled catalog and a catalog-only model stays unknown", { timeout: 10_000 }, async () => {
  const dir = await freshDir("offline");
  const loaded = await loadModelCatalog(dir);
  assert.equal(loaded.issue, undefined);
  assert.equal(loaded.overlay.size, 0);
  const config = configFor(dir, [{ provider: PROVIDER, modelId: NEW_ID }]);
  assert.throws(() => createProviderModels(config, {}, undefined, loaded.overlay), /model/i);
});

test("refresh adds metadata without widening allowedModels, then serves offline", { timeout: 10_000 }, async () => {
  const dir = await freshDir("updated");
  seen.length = 0;
  script = [shard([...bundled, synthetic])];
  const [outcome] = await refresh(dir);
  assert.equal(outcome.status, "updated");
  assert.deepEqual(outcome.added, [NEW_ID]);
  assert.equal(seen[0].url, `/api/models/providers/${PROVIDER}?types=chat%2Cimage%2Cclassifier`);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal((await stat(modelCatalogPath(dir))).mode & 0o777, 0o600);

  // Offline from here on: the server has no scripted response.
  const loaded = await loadModelCatalog(dir);
  assert.equal(loaded.overlay.get(PROVIDER).some((model) => model.id === NEW_ID), true);

  // Present in the catalog, but only allowedModels is authority.
  const narrow = createProviderModels(configFor(dir, [{ provider: PROVIDER, modelId: template.id }]), {}, undefined, loaded.overlay);
  assert.equal(narrow.models.getModel(PROVIDER, NEW_ID)?.id, NEW_ID);
  assert.deepEqual(narrow.model, { provider: PROVIDER, modelId: template.id });

  const adopted = createProviderModels(configFor(dir, [{ provider: PROVIDER, modelId: NEW_ID }]), {}, undefined, loaded.overlay);
  assert.deepEqual(adopted.model, { provider: PROVIDER, modelId: NEW_ID });

  // ETag revalidation: 304 keeps the overlay.
  seen.length = 0;
  script = [{ status: 304 }];
  assert.equal((await refresh(dir))[0].status, "unchanged");
  assert.equal(seen[0].headers["if-none-match"], '"v1"');
  assert.equal((await loadModelCatalog(dir)).overlay.get(PROVIDER).some((model) => model.id === NEW_ID), true);
});

test("stale, invalid and unavailable updates keep the last-good catalog", { timeout: 20_000 }, async () => {
  const dir = await freshDir("failures");
  script = [shard([...bundled, synthetic], NEWEST)];
  assert.equal((await refresh(dir))[0].status, "updated");
  const lastGood = await readFile(modelCatalogPath(dir), "utf8");

  const cases = [
    [shard([...bundled], NEWER), "stale"],
    [shard([...bundled], OLDER), "stale"],
    [{ status: 200, headers: { "last-modified": NEWEST }, body: "{not json" }, "rejected"],
    [shard({ models: bundled }, NEWEST), "rejected"],
    [shard([synthetic, synthetic], NEWEST), "rejected"],
    [shard([{ ...synthetic, cost: { input: -1 } }], NEWEST), "rejected"],
    [{ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(bundled) }, "rejected"],
    [{ status: 200, headers: { "last-modified": NEWEST }, body: "x".repeat(4096) }, "rejected", { maxBodyBytes: 1024 }],
    [{ status: 500 }, "failed"],
    [{ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } }, "failed"],
    [{ hang: true }, "failed", { timeoutMs: 200 }],
    [{ status: 404 }, "not-published"],
  ];
  for (const [response, status, options] of cases) {
    script = [response];
    const [outcome] = await refresh(dir, options);
    assert.equal(outcome.status, status, JSON.stringify(response).slice(0, 80));
    assert.equal(await readFile(modelCatalogPath(dir), "utf8"), lastGood);
  }

  // Unreachable endpoint (nothing listens on this closed port).
  const closed = createServer();
  await new Promise((resolveListen) => closed.listen(0, "127.0.0.1", resolveListen));
  const port = closed.address().port;
  await new Promise((resolveClose) => closed.close(resolveClose));
  const [unreachable] = await refresh(dir, { baseUrl: `http://127.0.0.1:${port}` });
  assert.equal(unreachable.status, "failed");
  assert.equal(await readFile(modelCatalogPath(dir), "utf8"), lastGood);
});

test("a shard not newer than the bundled data is never stored", { timeout: 10_000 }, async () => {
  const dir = await freshDir("bundled-current");
  script = [shard([...bundled, synthetic], OLDER)];
  assert.equal((await refresh(dir))[0].status, "bundled-current");
  await assert.rejects(stat(modelCatalogPath(dir)), { code: "ENOENT" });
});

test("entries that could redirect credentials or need an unknown API are skipped", { timeout: 10_000 }, async () => {
  const dir = await freshDir("incompatible");
  script = [shard([
    ...bundled,
    { ...synthetic, id: "elsewhere", baseUrl: "https://catalog-attacker.invalid/v1" },
    { ...synthetic, id: "extra-headers", headers: { "x-forwarded-token": "synthetic" } },
    { ...synthetic, id: "future-api", api: "future-unknown-api" },
    { id: "future-type", type: "video", name: "No chat-shaped fields" },
  ])];
  const [outcome] = await refresh(dir);
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.skipped, 4);
  assert.deepEqual(outcome.added, []);
  const ids = (await loadModelCatalog(dir)).overlay.get(PROVIDER).map((model) => model.id);
  for (const id of ["elsewhere", "extra-headers", "future-api", "future-type"]) assert.equal(ids.includes(id), false);
});

test("an unusable or package-stale file falls back to the bundled catalog", { timeout: 10_000 }, async () => {
  const corrupt = await freshDir("corrupt");
  await writeFile(modelCatalogPath(corrupt), "{broken");
  assert.deepEqual(await loadModelCatalog(corrupt), { overlay: new Map(), issue: "invalid" });

  const wrongVersion = await freshDir("wrong-version");
  await writeFile(modelCatalogPath(wrongVersion), JSON.stringify({ version: 99, providers: {} }));
  assert.equal((await loadModelCatalog(wrongVersion)).issue, "invalid");

  // Written by an older bundled catalog: a newer pi-ai package supersedes it, as in Pi.
  const superseded = await freshDir("superseded");
  await writeFile(modelCatalogPath(superseded), JSON.stringify({
    version: 1,
    providers: { [PROVIDER]: { models: [synthetic], lastModified: bundledAt, checkedAt: bundledAt } },
  }));
  const loaded = await loadModelCatalog(superseded);
  assert.equal(loaded.issue, undefined);
  assert.equal(loaded.overlay.size, 0);

  // A tampered stored entry is re-validated, not trusted.
  const tampered = await freshDir("tampered");
  await writeFile(modelCatalogPath(tampered), JSON.stringify({
    version: 1,
    providers: { [PROVIDER]: { models: [{ ...synthetic, contextWindow: "big" }], lastModified: bundledAt + 1, checkedAt: 0 } },
  }));
  assert.equal((await loadModelCatalog(tampered)).issue, "invalid");
});

test("models refresh and list use the configured native providers and mark grants", { timeout: 10_000 }, async () => {
  const dir = await freshDir("cli");
  await mkdir(join(dir, "workspace"));
  const config = configFor(dir, [{ provider: PROVIDER, modelId: template.id }]);
  let text = "";
  const output = { write: (chunk) => { text += chunk; } };
  script = [shard([...bundled, synthetic])];
  const refreshed = await runModelsCommand(config, { action: "refresh", providers: [] }, {
    output, refresh: { baseUrl, now: fixedClock, timeoutMs: 2_000 },
  });
  assert.equal(refreshed.ok, true);
  assert.match(text, new RegExp(`${PROVIDER}: updated .*${NEW_ID}`));
  text = "";
  assert.equal((await runModelsCommand(config, { action: "list", providers: [] }, { output })).ok, true);
  assert.match(text, new RegExp(`${PROVIDER}/${NEW_ID}  chat  refreshed\\n`));
  assert.match(text, new RegExp(`${PROVIDER}/${template.id.replaceAll(".", "\\.")}  chat  (bundled|refreshed)  allowed\\n`));
  script = [{ status: 503 }];
  text = "";
  const failed = await runModelsCommand(config, { action: "refresh", providers: [] }, {
    output, refresh: { baseUrl, now: fixedClock, timeoutMs: 2_000 },
  });
  assert.equal(failed.ok, false);
  assert.match(text, /refresh failed \(HTTP 503\); last-good kept/);
});

test("gateway opens offline from the last-good catalog; reload adopts or refuses without network", { timeout: 20_000 }, async () => {
  const context = BACKGROUND_CONTEXT;
  const dir = await freshDir("gateway");
  const workspace = join(dir, "workspace");
  const dataDir = join(dir, "state");
  await mkdir(workspace);
  await mkdir(dataDir, { mode: 0o700 });
  const native = "openai";
  const base = builtinProviders().find((provider) => provider.id === native).getModels()[0];
  const added = { ...base, id: NEW_ID, name: "Synthetic Catalog Model" };
  const catalogFile = modelCatalogPath(dataDir);
  const writeCatalog = (models) => writeFile(catalogFile, JSON.stringify({
    version: 1, providers: { [native]: { models, lastModified: bundledAt + 1, checkedAt: bundledAt + 1 } },
  }));
  const keyName = "SYNTHETIC_CATALOG_KEY";
  process.env[keyName] = "synthetic-catalog-value";
  const configFile = join(dir, "config.json");
  const values = (allowed) => ({
    workspace, dataDir,
    model: { provider: native, modelId: base.id },
    allowedModels: allowed.map((modelId) => ({ provider: native, modelId })),
    credentials: { [native]: keyName },
    episodeSummary: { enabled: false },
  });
  let gateway;
  try {
    // A catalog-only model in allowedModels without a usable catalog is a fixed startup refusal.
    await writeFile(configFile, JSON.stringify(values([base.id, NEW_ID])));
    await assert.rejects(openGateway(await loadConfig(configFile), context, { agentHistory: false }), { code: "model" });

    await writeCatalog([added]);
    await writeFile(configFile, JSON.stringify(values([base.id])));
    gateway = await openGateway(await loadConfig(configFile), context, {
      reloadConfig: () => loadConfig(configFile),
      agentHistory: false,
    });
    await gateway.conversationFor("cli:catalog", context);
    const listed = async () => (await gateway.listModels("cli:catalog", context)).models.map((model) => model.modelId);
    // Resolvable in the catalog is not a grant.
    assert.deepEqual(await listed(), [base.id]);

    // Owner adoption: add the refreshed model to allowedModels, then reload.
    await writeFile(configFile, JSON.stringify(values([base.id, NEW_ID])));
    assert.equal((await gateway.reloadModels(context)).status, "reloaded");
    assert.deepEqual(await listed(), [base.id, NEW_ID]);

    // A catalog that became unusable refuses a reload that needs it; the live catalog is kept.
    await writeFile(catalogFile, "{broken");
    await writeFile(configFile, JSON.stringify(values([NEW_ID, base.id])));
    assert.deepEqual(await gateway.reloadModels(context), { status: "refused", reason: "invalid" });
    assert.deepEqual(await listed(), [base.id, NEW_ID]);
  } finally {
    delete process.env[keyName];
    if (gateway) await gateway.close(context);
  }
});

test("catalog entries cannot change the request model, add fallbacks or inject request fields", { timeout: 10_000 }, async () => {
  const dir = await freshDir("projection");
  const native = "openai";
  const openai = builtinProviders().find((provider) => provider.id === native).getModels();
  const target = openai[0];
  const fallbackCarrier = builtinProviders().flatMap((provider) => provider.getModels())
    .find((model) => Array.isArray(model.compat?.allowedFallbackModels));
  // Served shard: the bundled model with request-shaping extras, plus new entries carrying
  // compatibility values this build never ships.
  script = [shard([
    { ...target, samplingParams: { model: "outside-allowlist", store: true }, samplingParamsByThinkingLevel: { high: { model: "x" } }, lab: "x" },
    { ...target, id: "fallbacks", compat: { allowedFallbackModels: fallbackCarrier.compat.allowedFallbackModels } },
    { ...target, id: "field-name", compat: { maxTokensField: "model" } },
    { ...target, id: "unknown-format", compat: { thinkingFormat: "future-format" } },
    { ...target, id: "unknown-compat", compat: { futureFlag: true, supportsStore: false } },
  ])];
  const [outcome] = await refreshModelCatalog(dir, [native], { baseUrl, now: fixedClock, timeoutMs: 2_000 });
  assert.equal(outcome.status, "updated");
  // A new request field name or thinking format cannot be served by this build: skipped.
  assert.equal(outcome.skipped, 2);
  const loaded = await loadModelCatalog(dir);
  const stored = loaded.overlay.get(native);
  const byId = new Map(stored.map((model) => [model.id, model]));
  assert.equal(byId.has("field-name"), false);
  assert.equal(byId.has("unknown-format"), false);
  // Fallback models the bundled entry never named are dropped; the model itself stays usable.
  assert.equal(byId.get("fallbacks").compat?.allowedFallbackModels, undefined);
  // Unknown keys are dropped; a known boolean is kept.
  assert.deepEqual(byId.get("unknown-compat").compat, { supportsStore: false });
  const replaced = stored.find((model) => model.id === target.id);
  for (const key of ["samplingParams", "samplingParamsByThinkingLevel", "lab"]) assert.equal(key in replaced, false);

  // Payload level: the request a refreshed entry produces names exactly the configured model.
  const config = configFor(dir, [{ provider: native, modelId: target.id }]);
  const { models } = createProviderModels(config, {}, undefined, loaded.overlay);
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response("{}", { status: 500 });
  };
  try {
    const stream = models.streamSimple(models.getModel(native, target.id), {
      messages: [{ role: "user", content: "synthetic", timestamp: 0 }],
    }, { apiKey: "synthetic-not-a-credential" });
    for await (const event of stream) if (event.type === "done" || event.type === "error") break;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(body.model, target.id);
  assert.notEqual(body.store, true);
});

test("current native ID forms are accepted", { timeout: 10_000 }, async () => {
  const dir = await freshDir("ids");
  script = [shard([...bundled, { ...synthetic, id: "@cf/vendor/model-0731" }, { ...synthetic, id: "~vendor/model-latest" }])];
  const [outcome] = await refresh(dir);
  assert.equal(outcome.status, "updated");
  assert.deepEqual(outcome.added, ["@cf/vendor/model-0731", "~vendor/model-latest"]);
  script = [shard([{ ...synthetic, id: "has space" }])];
  assert.equal((await refresh(dir))[0].status, "rejected");
});

test("a concurrent older refresh never replaces a newer stored shard or another provider", { timeout: 10_000 }, async () => {
  const dir = await freshDir("concurrent");
  const other = "openai";
  const otherBundled = builtinProviders().find((provider) => provider.id === other).getModels();
  // The slow refresh holds its (older) response until the fast one has written its newer shard.
  let releaseSlow;
  let slowEntered;
  const slowGate = new Promise((resolveGate) => { releaseSlow = resolveGate; });
  const entered = new Promise((resolveEntered) => { slowEntered = resolveEntered; });
  const slowFetch = async () => {
    slowEntered();
    await slowGate;
    return new Response(JSON.stringify([...bundled, synthetic]), {
      status: 200, headers: { "last-modified": NEWER, etag: '"old"' },
    });
  };
  const slow = refreshModelCatalog(dir, [PROVIDER], { fetch: slowFetch, now: fixedClock, timeoutMs: 2_000 });
  // The slow run has read its (empty) snapshot; only the locked re-read can see the newer shard.
  await entered;
  script = [shard([...bundled], NEWEST, '"new"'), shard([...otherBundled], NEWEST, '"other"')];
  const fast = await refreshModelCatalog(dir, [PROVIDER, other], { baseUrl, now: fixedClock, timeoutMs: 2_000 });
  assert.deepEqual(fast.map((outcome) => outcome.status), ["updated", "updated"]);
  releaseSlow();
  const [late] = await slow;
  assert.equal(late.status, "stale");
  const file = JSON.parse(await readFile(modelCatalogPath(dir), "utf8"));
  assert.equal(file.providers[PROVIDER].etag, '"new"');
  assert.equal(file.providers[other].etag, '"other"');
});

test("the offline read refuses symlinks and special files without blocking", { timeout: 10_000 }, async () => {
  const { symlink } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const linked = await freshDir("symlink");
  const real = join(linked, "elsewhere.json");
  await writeFile(real, JSON.stringify({ version: 1, providers: {} }));
  await symlink(real, modelCatalogPath(linked));
  assert.equal((await loadModelCatalog(linked)).issue, "invalid");
  const fifo = await freshDir("fifo");
  execFileSync("mkfifo", [modelCatalogPath(fifo)]);
  assert.equal((await loadModelCatalog(fifo)).issue, "invalid");
});
