import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const modules = join(testRoot, 'node_modules/@earendil-works');
const fixture = join(testRoot, 'tests/fixtures/mcp-stdio-server.mjs');

const [
  { parseConfig },
  { openGateway },
  { mcpToolNames },
  { BACKGROUND_CONTEXT },
  { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall },
  { ToolResultEntry },
] = await Promise.all([
  import(join(testRoot, 'dist/config.js')),
  import(join(testRoot, 'dist/runtime.js')),
  import(join(testRoot, 'dist/mcp/index.js')),
  import(join(modules, 'chord/dist/context/index.js')),
  import(join(modules, 'pi-ai/dist/index.js')),
  import(join(modules, 'pi-durable/dist/index.js')),
]);

const context = BACKGROUND_CONTEXT;
const TOKEN = 'SYNTHETIC-MCP-TOKEN-VALUE';
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
const final = (text) => fauxAssistantMessage([fauxText(text)]);
const toolNames = (agent) => (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
const callableNames = (agent) => (agent.callable ?? []).map((tool) => tool.name);
const deferredNames = (agent) => (agent.deferred ?? []).map((tool) => tool.name);

async function waitForFile(path, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error(`file ${path} did not appear within ${ms}ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function store(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-mcp-${label}-`));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'note.txt'), 'MCP-NESTED-READ-CONTENT\n');
  const model = { provider: 'mcp-faux', modelId: 'synthetic' };
  return {
    directory,
    workspace,
    model,
    config(extra = {}) {
      return parseConfig({ workspace, dataDir, model, toolAllowlist: [], ...extra }, directory);
    },
    models() {
      const faux = fauxProvider({ provider: 'mcp-faux', models: [{ id: 'synthetic', name: 'Synthetic' }] });
      const models = createModels();
      models.setProvider(faux.provider);
      return { faux, models };
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function stdioServer(workspace, extraArgs = []) {
  return {
    command: process.execPath,
    args: [fixture, ...extraArgs],
    cwd: workspace,
  };
}

async function say(conversation, text) {
  const settled = await (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
  assert.equal(settled.status, 'done');
}

async function toolResults(conversation) {
  const items = (await conversation.entries({}, 500, undefined, context)).items;
  return items.filter(ToolResultEntry.is).map((entry) => {
    const message = entry.model?.[0];
    return {
      id: message?.toolCallId,
      name: message?.toolName,
      isError: message?.isError === true,
      text: (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
    };
  });
}

/** A minimal Streamable HTTP MCP endpoint; JSON responses only, GET stream disabled. */
async function startHttpMcp(requests) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(307, { location: '/mcp' });
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    requests.push({ method: message.method, authorization: request.headers.authorization ?? null });
    if (message.id === undefined || message.id === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (message.method === 'initialize') headers['mcp-session-id'] = 'synthetic-http-session';
    const send = (result) => {
      response.writeHead(200, headers);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      send({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-http', version: '1.0.0' },
        instructions: 'HTTP-SERVER-INSTRUCTIONS',
      });
      return;
    }
    if (message.method === 'tools/list') {
      send({
        tools: [{
          name: 'echo',
          description: 'Echo one label over HTTP',
          inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
        }],
      });
      return;
    }
    if (message.method === 'tools/call') {
      send({
        content: [{ type: 'text', text: `http:${String(message.params?.arguments?.label)}` }],
        structuredContent: { transport: 'http', label: message.params?.arguments?.label },
      });
      return;
    }
    send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    redirectUrl: `http://127.0.0.1:${port}/redirect`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('MCP config is explicit, strict, and value-free', () => {
  const workspace = '/tmp/mcp-config-workspace';
  const base = { workspace, dataDir: '/tmp/mcp-config-state', model: { provider: 'p', modelId: 'm' } };
  const parse = (mcp) => parseConfig({ ...base, mcp }, '/tmp');

  assert.equal(parseConfig(base, '/tmp').mcp, undefined);
  // Disabled: no server entries are read, so nothing can connect.
  assert.deepEqual(parse({ enabled: false, servers: { bogus: { command: 'x' } } }).mcp,
    { enabled: false, servers: {} });
  assert.equal(parse({ enabled: true, servers: {} }).mcp.servers !== undefined, true);

  // Newline rejection: the config must be JSON, not a shell string or a legacy transport.
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', sse: true } } }), /SSE/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', type: 'stdio' } } }), /type/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', url: 'https://example.test/mcp' } } }), /exactly one/);
  assert.throws(() => parse({ enabled: true, servers: { s: { url: 'http://example.test/mcp' } } }), /https/);
  assert.throws(() => parse({ enabled: true, servers: { s: { url: 'https://example.test/mcp', command: 'node' } } }), /exactly one/);
  assert.throws(() => parse({ enabled: true, servers: { s: { url: 'https://user:pass@example.test/mcp' } } }), /credentials/);
  assert.throws(() => parse({ enabled: true, servers: { s: { url: 'https://example.test/mcp', oauth: {} } } }), /oauth must be a boolean/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', oauth: true } } }), /Streamable HTTP/);
  assert.throws(() => parse({
    enabled: true,
    servers: { s: { url: 'https://example.test/mcp', oauth: true, headers: { Authorization: 'MCP_HOST_TOKEN' } } },
  }), /one HTTP credential/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', env: { TOKEN: 'Bearer raw-value' } } } }), /environment variable/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', headers: { Authorization: TOKEN } } } }), /Streamable HTTP/);
  assert.throws(() => parse({ enabled: true, servers: { s: { command: 'node', cwd: '../outside' } } }), /inside the workspace/);
  assert.throws(() => parse({ enabled: true, servers: { 'a-b': { command: 'node' }, a_b: { command: 'node' } } }), /one tool namespace/);
  assert.throws(() => parse({ enabled: true, servers: { 'bad name': { command: 'node' } } }), /letters, digits/);
  assert.throws(() => parse({ enabled: 'yes', servers: {} }), /mcp.enabled/);

  const accepted = parse({
    enabled: true,
    servers: {
      local: {
        command: 'node',
        args: ['-e', 'process.exit(0)', '--root='],
        env: { MCP_CHILD_TOKEN: 'MCP_HOST_TOKEN' },
        description: ' Synthetic stdio server ',
        timeoutSeconds: 5,
      },
      remote: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'MCP_HOST_TOKEN' } },
    },
  });
  assert.equal(accepted.mcp.servers.local.description, 'Synthetic stdio server');
  assert.equal(accepted.mcp.servers.local.timeoutSeconds, 5);
  assert.deepEqual({ ...accepted.mcp.servers.local.env }, { MCP_CHILD_TOKEN: 'MCP_HOST_TOKEN' });
  assert.equal(accepted.mcp.servers.remote.url, 'http://127.0.0.1:9/mcp');
  const oauthEntry = parse({ enabled: true, servers: { remote: { url: 'https://example.test/mcp', oauth: true } } });
  assert.equal(oauthEntry.mcp.servers.remote.oauth, true);
});

test('a disabled MCP block starts nothing and leaves the shipped tool set unchanged', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-mcp-disabled-'));
  const pidFile = join(directory, 'server.pid');
  const env = await store('disabled');
  const { models } = env.models();
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: { enabled: false, servers: { synthetic: stdioServer(env.workspace, ['--pid-file', pidFile]) } },
    }), context, { models });
    assert.equal(gateway.mcp, undefined);
    const chat = await gateway.conversationFor('telegram:7:chat:900', context);
    const agent = await chat.agent(context);
    assert.ok(!toolNames(agent).includes('codemode'));
    assert.ok(!toolNames(agent).includes('tool_search'));
    assert.ok(!callableNames(agent).some((name) => name.startsWith('mcp__')));
    const appeared = await readFile(pidFile, 'utf8').then(() => true, () => false);
    assert.equal(appeared, false, 'a disabled block must not spawn the configured server');
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP names are sanitized, collision-stable, and independent of list order', () => {
  const names = mcpToolNames('srv-one', ['a-b', 'a_b', 'echo']);
  assert.equal(names.get('echo'), 'mcp__srv_one__echo');
  const dashed = names.get('a-b');
  const underscored = names.get('a_b');
  assert.notEqual(dashed, underscored);
  assert.match(dashed, /^mcp__srv_one__a_b_[0-9a-f]{8}$/);
  assert.match(underscored, /^mcp__srv_one__a_b_[0-9a-f]{8}$/);
  assert.deepEqual([...mcpToolNames('srv-one', ['echo', 'a_b', 'a-b'])], [...names]);
  const long = 'x'.repeat(80);
  const longName = mcpToolNames('srv-one', [long]).get(long);
  assert.ok(longName.length <= 64);
});

test('gateway Code Mode discovers and calls stdio MCP tools with namespaces and structured results', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-mcp-stdio-'));
  const pidFile = join(directory, 'server.pid');
  const env = await store('stdio');
  const { faux, models } = env.models();
  const echo = mcpToolNames('synthetic', ['echo']).get('echo');
  const collision = mcpToolNames('synthetic', ['a-b', 'a_b']);
  const dashed = collision.get('a-b');
  const underscored = collision.get('a_b');
  faux.setResponses([
    call('codemode', {
      code: [
        'const namespace = await describeNamespace("mcp__synthetic");',
        `const found = await searchTools("echo dashed underscore");`,
        `const result = await tools.${echo}({ label: "first" });`,
        `const one = await tools.${dashed}({});`,
        `const two = await tools.${underscored}({});`,
        'return { namespace, found: found.map((tool) => tool.name), result, one, two };',
      ].join('\n'),
    }, 'stdio-code'),
    final('stdio answer'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: {
        enabled: true,
        servers: {
          synthetic: {
            ...stdioServer(env.workspace, ['--pid-file', pidFile]),
            description: 'Synthetic stdio server for transport checks',
          },
        },
      },
    }), context, { models });
    assert.equal(gateway.mcp.servers.length, 1);
    assert.equal(gateway.mcp.servers[0].state, 'connected');
    assert.equal(gateway.mcp.servers[0].tools, 5);

    const chat = await gateway.conversationFor('telegram:7:chat:901', context);
    const agent = await chat.agent(context);
    assert.ok(toolNames(agent).includes('codemode'));
    assert.ok(toolNames(agent).includes('tool_search'));
    // MCP tools stay out of the main prompt but are reachable and discoverable.
    assert.ok(!toolNames(agent).includes(echo), `declared tools: ${toolNames(agent)}`);
    assert.ok(callableNames(agent).includes(echo));
    assert.ok(deferredNames(agent).includes(echo));

    await say(chat, 'use the synthetic server');
    const results = await toolResults(chat);
    const code = results.find((result) => result.id === 'stdio-code');
    assert.ok(code, 'codemode result reached the transcript');
    assert.equal(code.isError, false, code.text.slice(0, 400));
    assert.match(code.text, /"name":"mcp__synthetic"/);
    assert.match(code.text, /"found":\[[^\]]*mcp__synthetic__echo/);
    assert.match(code.text, /"text":"echo:first"/);
    assert.match(code.text, /Synthetic stdio server for transport checks/);
    // The server's instructions are bounded untrusted text, not a tool description.
    assert.match(code.text, /Untrusted instructions reported by MCP server/);
    assert.match(code.text, /SYNTHETIC-SERVER-INSTRUCTIONS/);
    assert.match(code.text, /"tool":"a-b"/);
    assert.match(code.text, /"tool":"a_b"/);
    const pid = Number.parseInt((await waitForFile(pidFile, 5_000)).trim(), 10);
    assert.match(code.text, new RegExp(`"pid":${pid}`));

    await gateway.close(context);
    gateway = undefined;
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'closing the gateway tears down the server process');
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP tools stay deferred until tool_search loads them, and an unoffered direct call is denied', { timeout: 60_000 }, async () => {
  const env = await store('deferred');
  const { faux, models } = env.models();
  const echo = mcpToolNames('synthetic', ['echo']).get('echo');
  faux.setResponses([
    call(echo, { label: 'unoffered' }, 'unoffered-direct'),
    call('tool_search', { query: 'echo synthetic' }, 'search'),
    call(echo, { label: 'loaded' }, 'loaded-direct'),
    final('deferred answer'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: { enabled: true, servers: { synthetic: stdioServer(env.workspace) } },
    }), context, { models });
    const chat = await gateway.conversationFor('telegram:7:chat:902', context);
    await say(chat, 'discover the synthetic tool');
    const results = await toolResults(chat);
    const unoffered = results.find((result) => result.id === 'unoffered-direct');
    assert.equal(unoffered.isError, true, 'a tool that was never loaded cannot be called');
    const search = results.find((result) => result.id === 'search');
    assert.equal(search.isError, false);
    assert.match(search.text, new RegExp(echo));
    const loaded = results.find((result) => result.id === 'loaded-direct');
    assert.equal(loaded.isError, false, loaded.text.slice(0, 300));
    assert.match(loaded.text, /echo:loaded/);
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('gateway Code Mode reaches a loopback Streamable HTTP server with configured auth headers and refuses redirects', { timeout: 60_000 }, async () => {
  const requests = [];
  const http = await startHttpMcp(requests);
  const env = await store('http');
  const { faux, models } = env.models();
  process.env.MCP_TEST_AUTHORIZATION = `Bearer ${TOKEN}`;
  const echo = mcpToolNames('remote', ['echo']).get('echo');
  faux.setResponses([
    call('codemode', {
      code: [
        'const namespace = await describeNamespace("mcp__remote");',
        `const result = await tools.${echo}({ label: "over-http" });`,
        'return { namespace, result };',
      ].join('\n'),
    }, 'http-code'),
    final('http answer'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: {
        enabled: true,
        servers: {
          remote: {
            url: http.url,
            headers: { Authorization: 'MCP_TEST_AUTHORIZATION' },
          },
          redirected: { url: http.redirectUrl },
        },
      },
    }), context, { models });
    const statuses = new Map(gateway.mcp.servers.map((server) => [server.name, server]));
    assert.equal(statuses.get('remote').state, 'connected');
    assert.equal(statuses.get('redirected').state, 'failed');
    assert.equal(statuses.get('redirected').tools, 0);
    assert.ok(requests.some((request) => request.method === 'initialize'));
    assert.ok(requests.every((request) => request.authorization === `Bearer ${TOKEN}`),
      'the configured header is sent from the named environment variable');

    const chat = await gateway.conversationFor('telegram:7:chat:903', context);
    await say(chat, 'call the http tool');
    const code = (await toolResults(chat)).find((result) => result.id === 'http-code');
    assert.equal(code.isError, false, code.text.slice(0, 300));
    assert.match(code.text, /http:over-http/);
    assert.match(code.text, /"transport":"http"/);
    // Without a configured description the namespace summary is the server's first instruction line.
    assert.match(code.text, /"description":"HTTP-SERVER-INSTRUCTIONS"/);
    assert.match(code.text, /Untrusted instructions reported by MCP server/);
  } finally {
    delete process.env.MCP_TEST_AUTHORIZATION;
    if (gateway) await gateway.close(context);
    await http.close();
    await env.cleanup();
  }
});

test('MCP and Code Mode authority is limited to mapped chats and nested calls obey the coding ceiling', { timeout: 60_000 }, async () => {
  const env = await store('scope');
  const { faux, models } = env.models();
  const echo = mcpToolNames('synthetic', ['echo']).get('echo');
  faux.setResponses([
    call('codemode', {
      code: [
        'const read = await tools.read({ path: "note.txt" });',
        'let writeError = null;',
        'try { await tools.write({ path: "new.txt", content: "x" }); } catch (error) { writeError = error.message; }',
        'const writeListed = ALL_TOOLS.filter((tool) => tool.name === "write").length;',
        `const remote = await tools.${echo}({ label: "nested" });`,
        'return { read, writeError, writeListed, remote };',
      ].join('\n'),
    }, 'scope-code'),
    final('scope answer'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(env.config({
      toolAllowlist: ['read'],
      mcp: { enabled: true, servers: { synthetic: stdioServer(env.workspace) } },
    }), context, { models });
    const chat = await gateway.conversationFor('telegram:7:chat:904', context);
    const authorized = await chat.agent(context);
    assert.ok(toolNames(authorized).includes('codemode'));
    assert.ok(callableNames(authorized).includes(echo));
    assert.ok(callableNames(authorized).includes('read'));
    assert.ok(!callableNames(authorized).includes('write'), 'the coding ceiling still applies');

    await say(chat, 'use nested tools');
    const code = (await toolResults(chat)).find((result) => result.id === 'scope-code');
    assert.equal(code.isError, false, code.text.slice(0, 400));
    assert.match(code.text, /MCP-NESTED-READ-CONTENT/);
    assert.match(code.text, /does not exist/);
    assert.match(code.text, /"writeListed":0/);
    assert.match(code.text, /echo:nested/);

    const root = await gateway.harness.root(context);
    assert.ok(!toolNames(await root.agent(context)).includes('codemode'));
    const raw = await gateway.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: { model: env.model } }, context);
    const rawAgent = await raw.agent(context);
    assert.ok(!toolNames(rawAgent).includes('codemode'));
    assert.ok(!callableNames(rawAgent).includes(echo));
    const entries = (await chat.entries({}, 50, undefined, context)).items;
    const fork = await chat.fork(entries[0].id, { ownership: { kind: 'ownerless' }, agent: { model: env.model } }, context);
    const forkAgent = await fork.agent(context);
    assert.ok(!toolNames(forkAgent).includes('codemode'));
    assert.ok(!callableNames(forkAgent).includes(echo));
    const state = await gateway.conversationFor('telegram:7:channel-state', context);
    assert.ok(!toolNames(await state.agent(context)).includes('codemode'));
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('a failed server is value-free, and a timed-out MCP call is cancelled and never retried', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-mcp-failure-'));
  const cancelledFile = join(directory, 'cancelled.txt');
  const env = await store('failure');
  const { faux, models } = env.models();
  const slow = mcpToolNames('synthetic', ['slow']).get('slow');
  faux.setResponses([
    call('codemode', {
      code: `// @options: {"timeout_ms": 3000}\nreturn await tools.${slow}({ ms: 30000 });`,
    }, 'slow-code'),
    final('timeout answer'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: {
        enabled: true,
        servers: {
          synthetic: stdioServer(env.workspace, ['--cancelled-file', cancelledFile]),
          broken: { ...stdioServer(env.workspace, ['--fail']), enabled: true },
          needsEnv: {
            command: process.execPath,
            args: [fixture],
            env: { MCP_MISSING_CHILD_VAR: 'MCP_MISSING_HOST_VAR' },
          },
        },
      },
    }), context, { models });
    const statuses = new Map(gateway.mcp.servers.map((server) => [server.name, server]));
    assert.equal(statuses.get('synthetic').state, 'connected');
    assert.equal(statuses.get('broken').state, 'failed');
    assert.equal(statuses.get('broken').failure, 'start-failed');
    assert.equal(statuses.get('needsEnv').state, 'failed');
    assert.equal(statuses.get('needsEnv').failure, 'missing-environment');
    const serialized = JSON.stringify(gateway.mcp);
    assert.doesNotMatch(serialized, /MCP-FIXTURE-FAILURE-SECRET/, 'the server failure message stays value-free');

    const chat = await gateway.conversationFor('telegram:7:chat:905', context);
    assert.ok(!callableNames(await chat.agent(context)).some((name) => name.startsWith('mcp__broken')));
    await say(chat, 'call the slow tool');
    const code = (await toolResults(chat)).find((result) => result.id === 'slow-code');
    assert.equal(code.isError, true, 'a script that outlives its deadline fails');
    // The pending call is cancelled at the server, once; no retry is issued.
    const cancelled = (await waitForFile(cancelledFile, 5_000)).trim().split('\n').filter(Boolean);
    assert.equal(cancelled.length, 1, `cancellation notifications: ${cancelled.length}`);
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reopening with a failed server removes its persisted tools from every call path', { timeout: 60_000 }, async () => {
  const env = await store('reopen');
  const echo = mcpToolNames('synthetic', ['echo']).get('echo');
  const key = 'telegram:7:chat:906';
  let gateway;
  try {
    const first = env.models();
    first.faux.setResponses([
      call('tool_search', { query: 'echo' }, 'load'),
      final('loaded'),
    ]);
    gateway = await openGateway(env.config({
      mcp: { enabled: true, servers: { synthetic: stdioServer(env.workspace) } },
    }), context, { models: first.models });
    const chat = await gateway.conversationFor(key, context);
    await say(chat, 'load the echo tool');
    assert.ok((await chat.agent(context)).callable.some((tool) => tool.name === echo));
    await gateway.close(context);
    gateway = undefined;

    // The same persisted conversation, whose modelTools already named the tool, reopens against a
    // server that now fails to start. Code Mode stays configured, but no MCP tool is reachable.
    const second = env.models();
    second.faux.setResponses([fauxAssistantMessage([
      fauxToolCall(echo, { label: 'stale' }, { id: 'stale-call' }),
      fauxToolCall('codemode', {
        code: [
          `const names = ALL_TOOLS.map((tool) => tool.name).filter((name) => name.startsWith("mcp__"));`,
          `let nested = null;`,
          `try { nested = await tools.${echo}({ label: "stale" }); } catch (error) { nested = error.message; }`,
          'return { names, nested };',
        ].join('\n'),
      }, { id: 'stale-code' }),
    ], { stopReason: 'toolUse' }), final('stale answer')]);
    gateway = await openGateway(env.config({
      mcp: { enabled: true, servers: { synthetic: { ...stdioServer(env.workspace, ['--fail']), enabled: true } } },
    }), context, { models: second.models });
    assert.equal(gateway.mcp.servers[0].state, 'failed');
    const reopened = await gateway.conversationFor(key, context);
    const agent = await reopened.agent(context);
    assert.ok(!callableNames(agent).includes(echo), `callable after reopen: ${callableNames(agent)}`);
    assert.ok(!deferredNames(agent).includes(echo));
    await say(reopened, 'try the persisted tools');
    const results = await toolResults(reopened);
    const stale = results.find((result) => result.id === 'stale-call');
    assert.equal(stale.isError, true);
    assert.doesNotMatch(stale.text, /echo:stale/);
    const nested = results.find((result) => result.id === 'stale-code');
    assert.equal(nested.isError, false, nested.text.slice(0, 300));
    assert.match(nested.text, /"names":\[\]/);
    assert.match(nested.text, /does not exist/);
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});
