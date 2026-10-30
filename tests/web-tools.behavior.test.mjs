import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const packageRoot = process.env.PI_NANOBOT_CANDIDATE ?? new URL("../", import.meta.url).pathname;
const modules = join(packageRoot, "node_modules/@earendil-works");
const [
  { parseConfig },
  { openGateway },
  { BACKGROUND_CONTEXT },
  { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall },
  { ToolResultEntry },
  web,
] = await Promise.all([
  import(new URL("../dist/config.js", import.meta.url).href),
  import(new URL("../dist/runtime.js", import.meta.url).href),
  import(`${modules}/chord/dist/context/index.js`),
  import(`${modules}/pi-ai/dist/index.js`),
  import(`${modules}/pi-durable/dist/index.js`),
  import(new URL("../dist/web/index.js", import.meta.url).href),
]);

const { BraveSearchClient, PublicWebFetcher, WebFetchError, createWebToolExtension } = web;
const context = BACKGROUND_CONTEXT;
const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };

async function workspaceStore(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-web-${label}-`));
  const workspace = join(directory, "workspace");
  const dataDir = join(directory, "state");
  await mkdir(workspace);
  return { directory, workspace, dataDir };
}

function config(store, extra = {}) {
  return parseConfig({
    workspace: store.workspace,
    dataDir: store.dataDir,
    model: { provider: "web-fixture", modelId: "synthetic" },
    toolAllowlist: [],
    ...extra,
  }, store.directory);
}

function syntheticModels() {
  const faux = fauxProvider({ provider: "web-fixture", models: [{ id: "synthetic", name: "Synthetic" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

async function say(conversation, text) {
  const submission = await conversation.submit({ type: "input", content: text }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done");
}

async function toolResult(conversation, id) {
  const items = (await conversation.entries({}, 300, undefined, context)).items;
  const results = items.filter(ToolResultEntry.is).map((entry) => {
    const message = entry.model?.[0];
    return {
      id: message?.toolCallId,
      isError: message?.isError === true,
      text: (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    };
  });
  const result = results.find((candidate) => candidate.id === id);
  assert.ok(result, `synthetic ${id} call reached the transcript`);
  return result;
}

function toolNames(agent) {
  return (agent.tools ?? []).map((tool) => (typeof tool === "string" ? tool : tool.name));
}

function headersOf(entries) {
  return new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
}

function jsonResponse(payload, status = 200) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf({ "content-type": "application/json" }),
    body: (async function* yieldBody() { yield body; })(),
  };
}

function searchTransport(calls, response) {
  return async (url, init) => {
    calls.push({ url: url.toString(), headers: { ...init.headers } });
    return typeof response === "function" ? response() : response;
  };
}

function fetchTransport(routes, calls) {
  return async ({ url, address, headers }) => {
    const key = url.toString();
    calls.push({ url: key, address, headers: { ...headers } });
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected fixture request: ${key}`);
    const chunks = [Buffer.from(route.body ?? "")];
    let disposed = 0;
    return {
      status: route.status ?? 200,
      headers: headersOf(route.headers ?? { "content-type": "text/html; charset=utf-8" }),
      body: (async function* body() { for (const chunk of chunks) yield chunk; })(),
      dispose() { disposed += 1; route.disposed = disposed; },
    };
  };
}

function publicResolver(calls, answer = PUBLIC_ADDRESS) {
  return async (hostname) => {
    calls.push(hostname);
    const value = typeof answer === "function" ? answer(hostname, calls.length) : answer;
    return Array.isArray(value) ? value : [value];
  };
}

async function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const HTML_FIXTURE = `<!doctype html>
<html><head>
  <title>Example Domain</title>
  <script>globalThis.pwned = "INJECTED-SCRIPT-TEXT";</script>
  <style>body { color: red }</style>
</head><body>
  <main>
    <h1>Example Domain</h1>
    <p>This domain is for use in illustrative examples in documents.</p>
    <p>Second paragraph with <a href="/more">a relative link</a> and
       <a href="javascript:alert('NO-JS')">a script link</a>.</p>
  </main>
</body></html>`;

test("web configuration is opt-in and a missing search key fails startup", { timeout: 15_000 }, async () => {
  const store = await workspaceStore("config");
  try {
    assert.equal(parseConfig({
      workspace: store.workspace,
      dataDir: store.dataDir,
      model: { provider: "web-fixture", modelId: "synthetic" },
    }).web, undefined);
    assert.throws(() => config(store, { web: { search: {} } }), /web\.search\.keyEnv/);
    assert.throws(() => config(store, { web: { search: { keyEnv: "not a name" } } }), /web\.search\.keyEnv/);
    assert.throws(() => config(store, { web: { fetch: "yes" } }), /web\.fetch/);
    assert.throws(() => config(store, { web: { unknown: true } }), /Unknown web field/);

    const missingKey = config(store, {
      web: { search: { keyEnv: "NANOBOT_SYNTHETIC_WEB_KEY" }, fetch: true },
    });
    await assert.rejects(
      openGateway(missingKey, context, { models: syntheticModels().models, web: { env: {} } }),
      (error) => error?.code === "webCredential" && /Missing credential/.test(error.message)
        && !error.message.includes("NANOBOT_SYNTHETIC_WEB_KEY"),
    );

    // The coding allowlist cannot be used as a second web grant.
    await assert.rejects(
      openGateway(
        config(store, { toolAllowlist: ["web_search"], web: { fetch: true } }),
        context,
        { models: syntheticModels().models },
      ),
      /no approved registered tools/,
    );

    // Search alone installs only the search tool, with the key resolved from its named variable.
    const searchOnly = await openGateway(
      config(store, { web: { search: { keyEnv: "NANOBOT_SYNTHETIC_WEB_KEY" } } }),
      context,
      {
        models: syntheticModels().models,
        web: {
          env: { NANOBOT_SYNTHETIC_WEB_KEY: "SYNTHETIC-BRAVE-TOKEN" },
          searchTransport: searchTransport([], jsonResponse({ web: { results: [] } })),
        },
      },
    );
    try {
      const chat = await searchOnly.conversationFor("telegram:1:chat:12", context);
      const names = toolNames(await chat.agent(context));
      assert.ok(names.includes("web_search"));
      assert.ok(!names.includes("web_fetch"));
    } finally {
      await searchOnly.close(context);
    }

    // Fetch alone needs no credential and installs only the page reader.
    const fetchOnly = await openGateway(
      config(store, { web: { fetch: true } }),
      context,
      {
        models: syntheticModels().models,
        web: {
          env: {},
          resolver: publicResolver([], PUBLIC_ADDRESS),
          fetchTransport: fetchTransport({}, []),
        },
      },
    );
    try {
      const chat = await fetchOnly.conversationFor("telegram:1:chat:11", context);
      const names = toolNames(await chat.agent(context));
      assert.ok(names.includes("web_fetch"));
      assert.ok(!names.includes("web_search"));
    } finally {
      await fetchOnly.close(context);
    }
  } finally {
    await rm(store.directory, { recursive: true, force: true });
  }
});

test("native web tools are reachable only in mapped chats", { timeout: 20_000 }, async () => {
  const store = await workspaceStore("gateway");
  const searchCalls = [];
  const fetchCalls = [];
  const searchResponse = jsonResponse({
    web: {
      results: [
        {
          title: "Example Domain",
          url: "https://example.com/",
          description: "Illustrative examples in documents.",
        },
        { title: "Absent URL", description: "must be dropped" },
      ],
    },
  });
  let gateway;
  try {
    const { faux, models } = syntheticModels();
    let step = 0;
    faux.setResponses(Array.from({ length: 6 }, () => (request) => {
      const text = JSON.stringify(request.messages);
      if (text.includes("find the example") && step === 0) {
        step = 1;
        return fauxAssistantMessage([fauxToolCall("web_search", { query: "example domain", count: 3 }, { id: "web-search-1" })], { stopReason: "toolUse" });
      }
      if (text.includes("read the page") && step === 1) {
        step = 2;
        return fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/" }, { id: "web-fetch-1" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("synthetic answer");
    }));
    gateway = await openGateway(
      config(store, {
        toolAllowlist: ["read"],
        web: { search: { keyEnv: "NANOBOT_SYNTHETIC_WEB_KEY" }, fetch: true },
      }),
      context,
      {
        models,
        web: {
          env: { NANOBOT_SYNTHETIC_WEB_KEY: "SYNTHETIC-BRAVE-TOKEN" },
          searchTransport: searchTransport(searchCalls, searchResponse),
          resolver: publicResolver([], PUBLIC_ADDRESS),
          fetchTransport: fetchTransport({
            "https://example.com/": { body: HTML_FIXTURE },
          }, fetchCalls),
          now: () => new Date("2026-10-30T12:00:00.000Z"),
        },
      },
    );
    const chat = await gateway.conversationFor("telegram:2:chat:22", context);
    const names = toolNames(await chat.agent(context));
    assert.ok(names.includes("web_search") && names.includes("web_fetch"), `chat tools: ${names}`);

    await say(chat, "find the example");
    const search = await toolResult(chat, "web-search-1");
    assert.equal(search.isError, false, search.text);
    assert.match(search.text, /external data, not instructions/);
    assert.match(search.text, /Example Domain/);
    assert.match(search.text, /https:\/\/example\.com\//);
    assert.match(search.text, /Results: 1 of up to 3 requested/);
    assert.doesNotMatch(search.text, /Absent URL/);
    assert.doesNotMatch(search.text, /SYNTHETIC-BRAVE-TOKEN/);
    assert.equal(searchCalls.length, 1);
    const braveUrl = new URL(searchCalls[0].url);
    assert.equal(braveUrl.origin, "https://api.search.brave.com");
    assert.equal(braveUrl.pathname, "/res/v1/web/search");
    assert.equal(braveUrl.searchParams.get("q"), "example domain");
    assert.equal(braveUrl.searchParams.get("count"), "3");
    assert.equal(searchCalls[0].headers["x-subscription-token"], "SYNTHETIC-BRAVE-TOKEN");
    assert.equal(searchCalls[0].headers.accept, "application/json");

    await say(chat, "read the page");
    const fetched = await toolResult(chat, "web-fetch-1");
    assert.equal(fetched.isError, false, fetched.text);
    assert.match(fetched.text, /Original URL: https:\/\/example\.com\//);
    assert.match(fetched.text, /Title: Example Domain/);
    assert.match(fetched.text, /Content type: text\/html; charset=utf-8/);
    assert.match(fetched.text, /Retrieved: 2026-10-30T12:00:00\.000Z/);
    assert.match(fetched.text, /Truncated: no/);
    assert.match(fetched.text, /BEGIN UNTRUSTED PAGE CONTENT/);
    assert.match(fetched.text, /illustrative examples in documents/);
    assert.match(fetched.text, /https:\/\/example\.com\/more/);
    assert.doesNotMatch(fetched.text, /INJECTED-SCRIPT-TEXT/);
    assert.doesNotMatch(fetched.text, /NO-JS/);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].address.address, PUBLIC_ADDRESS.address);
    for (const forbidden of ["authorization", "cookie", "proxy-authorization", "x-subscription-token"]) {
      assert.ok(!(forbidden in fetchCalls[0].headers), `fetch sent ${forbidden}`);
    }

    const raw = await gateway.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "web-fixture", modelId: "synthetic" } } },
      context,
    );
    assert.deepEqual(toolNames(await raw.agent(context)), []);
    const entries = (await chat.entries({}, 50, undefined, context)).items;
    const fork = await chat.fork(entries[0].id, {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "web-fixture", modelId: "synthetic" } },
    }, context);
    const forkNames = toolNames(await fork.agent(context));
    assert.ok(!forkNames.includes("web_search") && !forkNames.includes("web_fetch"), `fork tools: ${forkNames}`);
    const state = await gateway.conversationFor("telegram:2:channel-state", context);
    assert.deepEqual(toolNames(await state.agent(context)), []);
    assert.deepEqual(toolNames(await (await gateway.harness.root(context)).agent(context)), []);
  } finally {
    if (gateway) await gateway.close(context);
  }

  // Reopening without `web` removes both tools from the persisted mapped chat.
  let reopened;
  try {
    reopened = await openGateway(config(store, { toolAllowlist: ["read"] }), context, {
      models: syntheticModels().models,
    });
    const chat = await reopened.conversationFor("telegram:2:chat:22", context);
    const names = toolNames(await chat.agent(context));
    assert.ok(!names.includes("web_search") && !names.includes("web_fetch"), `reopened tools: ${names}`);
  } finally {
    if (reopened) await reopened.close(context);
    await rm(store.directory, { recursive: true, force: true });
  }
});

test("public fetch revalidates every hop and refuses non-public targets", { timeout: 20_000 }, async () => {
  const cases = [
    ["http://127.0.0.1/", "address"],
    ["http://[::1]/", "address"],
    ["http://[::ffff:127.0.0.1]/", "address"],
    ["http://[64:ff9b:1::1]/", "address"],
    ["http://[3fff::1]/", "address"],
    ["http://169.254.169.254/latest/meta-data/", "address"],
    ["http://10.1.2.3/", "address"],
    ["http://192.168.0.1/", "address"],
    ["http://100.64.0.1/", "address"],
    ["http://user:pass@example.com/", "credentials-in-url"],
    ["file:///etc/passwd", "unsupported-protocol"],
    ["ftp://example.com/", "unsupported-protocol"],
  ];
  for (const [url, code] of cases) {
    const transportCalls = [];
    const fetcher = new PublicWebFetcher({
      resolver: publicResolver([]),
      transport: fetchTransport({}, transportCalls),
      limits: { totalTimeoutMs: 2_000 },
    });
    await assert.rejects(fetcher.fetch(url), (error) => error instanceof WebFetchError && error.code === code, url);
    assert.equal(transportCalls.length, 0, `transport reached for ${url}`);
  }

  // A numeric host resolves through DNS as a private address and is refused.
  const numericCalls = [];
  const numeric = new PublicWebFetcher({
    resolver: publicResolver(numericCalls, { address: "169.254.169.254", family: 4 }),
    transport: fetchTransport({}, []),
  });
  await assert.rejects(numeric.fetch("http://2852039166/"), (error) => error.code === "address");

  // DNS rebinding: the first answer is public, a later answer would be private.
  // The fetcher resolves once, validates that answer, and connects to exactly it.
  const rebindResolutions = [];
  const rebindCalls = [];
  const rebind = new PublicWebFetcher({
    resolver: publicResolver(rebindResolutions, (_host, call) => call === 1 ? PUBLIC_ADDRESS : { address: "127.0.0.1", family: 4 }),
    transport: fetchTransport({ "https://rebind.example/": { body: HTML_FIXTURE } }, rebindCalls),
  });
  const rebound = await rebind.fetch("https://rebind.example/");
  assert.equal(rebound.finalUrl, "https://rebind.example/");
  assert.equal(rebindResolutions.length, 1);
  assert.equal(rebindCalls.length, 1);
  assert.equal(rebindCalls[0].address.address, PUBLIC_ADDRESS.address);

  // A redirect to a private target is refused before any connection to it.
  const privateRedirectCalls = [];
  const privateRedirect = new PublicWebFetcher({
    resolver: publicResolver([]),
    transport: fetchTransport({
      "https://example.com/start": { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: "" },
    }, privateRedirectCalls),
  });
  await assert.rejects(privateRedirect.fetch("https://example.com/start"), (error) => error.code === "address");
  assert.equal(privateRedirectCalls.length, 1);

  // A cross-origin redirect resolves and revalidates the new host.
  const redirectResolutions = [];
  const redirectCalls = [];
  const redirect = new PublicWebFetcher({
    resolver: publicResolver(redirectResolutions, (_host, call) => call === 1 ? PUBLIC_ADDRESS : { address: "10.0.0.5", family: 4 }),
    transport: fetchTransport({
      "https://first.example/a": { status: 307, headers: { location: "https://second.example/b" }, body: "" },
    }, redirectCalls),
  });
  await assert.rejects(redirect.fetch("https://first.example/a"), (error) => error.code === "address");
  assert.deepEqual(redirectResolutions, ["first.example", "second.example"]);
  assert.equal(redirectCalls.length, 1);

  // Same-origin redirects are followed with an explicit final URL and hop count.
  const followCalls = [];
  const follow = new PublicWebFetcher({
    resolver: publicResolver([], PUBLIC_ADDRESS),
    transport: fetchTransport({
      "https://example.com/a": { status: 301, headers: { location: "/b" }, body: "" },
      "https://example.com/b": { body: HTML_FIXTURE },
    }, followCalls),
  });
  const followed = await follow.fetch("https://example.com/a");
  assert.equal(followed.originalUrl, "https://example.com/a");
  assert.equal(followed.finalUrl, "https://example.com/b");
  assert.equal(followed.redirects, 1);

  // Hop limit.
  const hop = new PublicWebFetcher({
    resolver: publicResolver([], PUBLIC_ADDRESS),
    transport: fetchTransport({
      "https://example.com/a": { status: 302, headers: { location: "/b" }, body: "" },
      "https://example.com/b": { status: 302, headers: { location: "/c" }, body: "" },
    }, []),
    limits: { maxRedirects: 1 },
  });
  await assert.rejects(hop.fetch("https://example.com/a"), (error) => error.code === "redirect");

  // Binary content types fail explicitly; the body is never decoded as text.
  for (const contentType of ["image/png", "application/pdf", "application/octet-stream"]) {
    const fetcher = new PublicWebFetcher({
      resolver: publicResolver([], PUBLIC_ADDRESS),
      transport: fetchTransport({
        "https://example.com/file": { headers: { "content-type": contentType }, body: "BINARY" },
      }, []),
    });
    await assert.rejects(fetcher.fetch("https://example.com/file"), (error) => error.code === "content-type");
  }
  const encoded = new PublicWebFetcher({
    resolver: publicResolver([], PUBLIC_ADDRESS),
    transport: fetchTransport({
      "https://example.com/gzip": { headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: "x" },
    }, []),
  });
  await assert.rejects(encoded.fetch("https://example.com/gzip"), (error) => error.code === "content-encoding");
});

test("public fetch bounds bytes, text, time and cancellation", { timeout: 20_000 }, async () => {
  const resolver = publicResolver([], PUBLIC_ADDRESS);

  const streamed = new PublicWebFetcher({
    resolver,
    transport: async ({ url }) => ({
      status: 200,
      headers: headersOf({ "content-type": "text/html; charset=utf-8" }),
      body: (async function* cappedBody() {
        assert.equal(url.toString(), "https://example.com/big");
        yield Buffer.from("<html><body><p>");
        for (let index = 0; index < 5; index += 1) yield Buffer.from("B".repeat(512));
        yield Buffer.from("</p></body></html>");
      })(),
      dispose() {},
    }),
    limits: { maxBodyBytes: 600 },
  });
  const capped = await streamed.fetch("https://example.com/big");
  assert.equal(capped.bodyTruncated, true);
  assert.ok(capped.text.length > 0);

  const truncatedText = new PublicWebFetcher({
    resolver,
    transport: async () => ({
      status: 200,
      headers: headersOf({ "content-type": "text/plain; charset=utf-8" }),
      body: (async function* plainBody() { yield Buffer.from("C".repeat(200)); })(),
      dispose() {},
    }),
    limits: { maxTextChars: 32 },
  });
  const plain = await truncatedText.fetch("https://example.com/plain");
  assert.equal(plain.textTruncated, true);
  assert.equal(plain.text.length, 32);

  const hanging = new PublicWebFetcher({
    resolver,
    transport: async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    limits: { totalTimeoutMs: 60 },
  });
  await assert.rejects(within(hanging.fetch("https://example.com/slow"), 3_000, "total deadline"), (error) => error.code === "timed-out");

  const controller = new AbortController();
  const cancelled = new PublicWebFetcher({
    resolver,
    transport: async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const pending = cancelled.fetch("https://example.com/cancel", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(within(pending, 3_000, "caller cancellation"), (error) => error.code === "cancelled");

  const missingType = new PublicWebFetcher({
    resolver,
    transport: async () => ({
      status: 200,
      headers: headersOf({}),
      body: (async function* emptyBody() { yield Buffer.from(""); })(),
      dispose() {},
    }),
  });
  await assert.rejects(missingType.fetch("https://example.com/no-type"), (error) => error.code === "content-type");
});

test("search and fetch tools deny unauthorized scopes and sanitize failures", { timeout: 15_000 }, async () => {
  const searchCalls = [];
  const client = new BraveSearchClient({
    apiKey: "SYNTHETIC-SECRET",
    transport: searchTransport(searchCalls, jsonResponse({ message: "SYNTHETIC-RAW-PROVIDER-BODY" }, 429)),
  });
  const extension = createWebToolExtension({
    search: client,
    isAuthorizedChat: (id) => id === 1,
  }).extension;
  const beforeTool = extension.hooks[0].handlers.beforeTool;
  const call = { type: "toolCall", id: "synthetic-web", name: "web_search", arguments: {} };
  assert.match(
    (await beforeTool(call, { conversationId: 2 }, context))?.block ?? "",
    /not enabled for this conversation/,
  );
  assert.equal(await beforeTool(call, { conversationId: 1 }, context), undefined);

  const tool = extension.tools[0];
  const api = { conversationId: 2 };
  const denied = await tool.execute({ query: "synthetic" }, api, context);
  assert.equal(denied.isError, true);
  assert.match(denied.output[0].text, /not available in this conversation/);
  assert.equal(searchCalls.length, 0);

  const failed = await tool.execute({ query: "synthetic" }, { conversationId: 1 }, context);
  assert.equal(failed.isError, true);
  assert.match(failed.output[0].text, /HTTP 429/);
  assert.doesNotMatch(failed.output[0].text, /SYNTHETIC-RAW-PROVIDER-BODY/);
  assert.doesNotMatch(failed.output[0].text, /SYNTHETIC-SECRET/);

  const emptyCalls = [];
  const emptyClient = new BraveSearchClient({
    apiKey: "SYNTHETIC-SECRET",
    transport: searchTransport(emptyCalls, jsonResponse({ web: { results: [] } })),
  });
  const empty = await emptyClient.search("synthetic query", { count: 99 });
  assert.equal(empty.results.length, 0);
  assert.equal(empty.requestedCount, 10);
  assert.match(new URL(emptyCalls[0].url).searchParams.get("count"), /^10$/);
});

test("already-aborted signals stop web requests before any transport", { timeout: 15_000 }, async () => {
  const searchCalls = [];
  const resolverCalls = [];
  const fetchCalls = [];
  const aborted = AbortSignal.abort();
  const client = new BraveSearchClient({
    apiKey: "SYNTHETIC-SECRET",
    transport: searchTransport(searchCalls, jsonResponse({ web: { results: [{ title: "must not be requested", url: "https://example.com/" }] } })),
  });
  await assert.rejects(
    client.search("synthetic query", { signal: aborted }),
    (error) => error instanceof web.WebSearchError && error.code === "cancelled",
  );
  assert.equal(searchCalls.length, 0);

  const fetcher = new PublicWebFetcher({
    resolver: publicResolver(resolverCalls),
    transport: fetchTransport({}, fetchCalls),
  });
  await assert.rejects(
    fetcher.fetch("https://example.com/", { signal: aborted }),
    (error) => error instanceof WebFetchError && error.code === "cancelled",
  );
  assert.equal(resolverCalls.length, 0);
  assert.equal(fetchCalls.length, 0);

  // The native tool entry must report cancellation, not a successful result, even
  // before its own authorization or client call.
  const extension = createWebToolExtension({
    search: client,
    fetcher,
    isAuthorizedChat: () => true,
  }).extension;
  const tools = new Map(extension.tools.map((tool) => [tool.name, tool]));
  const abortedContext = { ...context, abortSignal: aborted };
  await assert.rejects(
    tools.get("web_search").execute({ query: "synthetic" }, { conversationId: 1 }, abortedContext),
    /Operation aborted/,
  );
  await assert.rejects(
    tools.get("web_fetch").execute({ url: "https://example.com/" }, { conversationId: 1 }, abortedContext),
    /Operation aborted/,
  );
  assert.equal(searchCalls.length, 0);
  assert.equal(resolverCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});
