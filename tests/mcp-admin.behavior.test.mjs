import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const modules = join(testRoot, 'node_modules/@earendil-works');
const fixture = join(testRoot, 'tests/fixtures/mcp-stdio-server.mjs');

const [
  { loadConfig, parseConfig },
  { openGateway },
  {
    mcpOAuthStatePath,
    hasMcpOAuthTokens,
    FileMcpOAuthStateStore,
    MCP_ADMIN_TOOL_NAME,
    adoptMcpOAuthRefresh,
    commitMcpOAuthState,
    mcpOAuthGrantEpoch,
    snapshotMcpOAuthGrant,
  },
  { BACKGROUND_CONTEXT },
  { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall },
  { WORKER_TOOL_NAME },
  { WorkerRecordsDoc },
  { ConfigToolCaptureDoc },
] = await Promise.all([
  import(join(testRoot, 'dist/config.js')),
  import(join(testRoot, 'dist/runtime.js')),
  import(join(testRoot, 'dist/mcp/index.js')),
  import(join(modules, 'chord/dist/context/index.js')),
  import(join(modules, 'pi-ai/dist/index.js')),
  import(join(testRoot, 'dist/workers/tool.js')),
  import(join(testRoot, 'dist/workers/worker-task.js')),
  import(join(testRoot, 'dist/tools/index.js')),
]);

const context = BACKGROUND_CONTEXT;
const ACCESS_TOKEN = 'synthetic-access-token-value';
const REFRESH_TOKEN = 'synthetic-refresh-token-value';
const AUTHORIZATION_CODE = 'synthetic-authorization-code';
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
const final = (text) => fauxAssistantMessage([fauxText(text)]);
const toolNames = (agent) => (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
const callableNames = (agent) => (agent.callable ?? []).map((tool) => tool.name);
const deferredNames = (agent) => (agent.deferred ?? []).map((tool) => tool.name);

async function store(label) {
  const directory = await mkdtemp(join(tmpdir(), `nanobot-mcp-admin-${label}-`));
  const workspace = join(directory, 'workspace');
  const dataDir = join(directory, 'state');
  const configFile = join(directory, 'config.json');
  await mkdir(workspace);
  await writeFile(configFile, `${JSON.stringify({
    workspace,
    dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    toolAllowlist: [],
  }, null, 2)}\n`);
  const model = { provider: 'mcp-faux', modelId: 'synthetic' };
  return {
    directory,
    workspace,
    dataDir,
    configFile,
    config(extra = {}) {
      return parseConfig({ workspace, dataDir, model, toolAllowlist: [], ...extra }, directory);
    },
    configFromFile: () => loadConfig(configFile),
    models() {
      const faux = fauxProvider({ provider: 'mcp-faux', models: [{ id: 'synthetic', name: 'Synthetic' }] });
      const models = createModels();
      models.setProvider(faux.provider);
      return { faux, models };
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function stdioServer(workspace) {
  return { command: process.execPath, args: [fixture], cwd: workspace };
}

async function say(conversation, text) {
  const settled = await (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
  assert.equal(settled.status, 'done');
}

function attachOwnerSurface(gateway, sessionKey, options = {}) {
  const delivered = [];
  const notices = [];
  const detach = gateway.mcpSurfaces.attach({
    owns: (candidate) => candidate === sessionKey,
    async deliverAuthorization(key, authorization) {
      if (options.failDelivery === true) throw new Error("synthetic delivery failure");
      assert.equal(key, sessionKey);
      delivered.push(authorization);
    },
    async deliverNotice(key, text) {
      assert.equal(key, sessionKey);
      notices.push(text);
    },
  });
  return { delivered, notices, detach };
}


function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function lastUserText(messages) {
  const users = messages.filter((message) => message.role === 'user');
  const last = users.at(-1);
  if (last === undefined) return "";
  return Array.isArray(last.content)
    ? last.content.map((part) => part.type === 'text' ? part.text : '').join('')
    : String(last.content);
}

async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function callbackFromAuthorization(authorizationUrl) {
  const started = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const callback = started.headers.get('location');
  assert.ok(callback, 'the authorization endpoint must redirect to the loopback callback');
  return callback;
}

async function browse(authorizationUrl) {
  const callback = await callbackFromAuthorization(authorizationUrl);
  const page = await fetch(callback);
  assert.equal(page.status, 200);
}

async function startOAuthMcp(options = {}) {
  const calls = [];
  let issuer;
  let redirectUris = [];
  const server = createServer(async (request, response) => {
    const origin = issuer;
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/.well-known/oauth-protected-resource/mcp'
      || request.url === '/.well-known/oauth-protected-resource') {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (request.url === '/.well-known/oauth-authorization-server') {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      });
      return;
    }
    if (request.url === '/register' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const metadata = JSON.parse(body);
      redirectUris = metadata.redirect_uris ?? [];
      json({ client_id: 'synthetic-client', redirect_uris: redirectUris });
      return;
    }
    if (request.url?.startsWith('/authorize') && request.method === 'GET') {
      const url = new URL(`${origin}${request.url}`);
      const state = url.searchParams.get('state');
      const redirectUri = url.searchParams.get('redirect_uri');
      assert.ok(url.searchParams.get('code_challenge'), 'the flow must send a PKCE challenge');
      assert.ok(redirectUri && redirectUris.includes(redirectUri), 'the redirect URI must be registered');
      const target = new URL(redirectUri);
      target.searchParams.set('code', AUTHORIZATION_CODE);
      target.searchParams.set('state', state ?? '');
      target.searchParams.set('iss', origin);
      response.writeHead(302, { location: target.href });
      response.end();
      return;
    }
    if (request.url === '/token' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      calls.push({ grant: form.get('grant_type'), verifier: form.get('code_verifier') });
      assert.ok(form.get('code_verifier'), 'the code exchange must send the PKCE verifier');
      json({
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        scope: 'mcp',
      });
      return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push({ method: message.method });
    if (message.id === undefined || message.id === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (message.method === 'initialize') headers['mcp-session-id'] = 'synthetic-oauth-session';
    const send = (result) => {
      response.writeHead(200, headers);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      send({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-oauth', version: '1.0.0' },
      });
      return;
    }
    if (message.method === 'tools/list') {
      if (options.failToolList === true) {
        response.writeHead(200, headers);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'synthetic listing failure' },
        }));
        return;
      }
      send({
        tools: [{
          name: 'echo',
          description: 'Echo one label over authorized HTTP',
          inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
        }],
      });
      return;
    }
    send({});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  issuer = `http://127.0.0.1:${port}`;
  return {
    url: `${issuer}/mcp`,
    sequence: calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('direct add and remove manage the live gateway with no proposal or approval gate', { timeout: 60_000 }, async () => {
  const env = await store('direct');
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, {
      action: 'add',
      name: 'synthetic',
      server: { ...stdioServer(env.workspace), description: 'Synthetic local server' },
    }, 'add-1'),
    final('added'),
    call(MCP_ADMIN_TOOL_NAME, { action: 'remove', name: 'synthetic' }, 'remove-1'),
    final('removed'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    assert.ok(admin, 'a configuration-file gateway exposes MCP management');
    const chat = await gateway.conversationFor('telegram:7:chat:920', context);
    const sessionKey = 'telegram:7:chat:920';
    assert.ok(toolNames(await chat.agent(context)).includes(MCP_ADMIN_TOOL_NAME));
    const stateChat = await gateway.conversationFor('telegram:7:channel-state', context);
    assert.ok(!toolNames(await stateChat.agent(context)).includes(MCP_ADMIN_TOOL_NAME));

    await say(chat, 'add the synthetic MCP server');
    const written = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.equal(written.mcp.enabled, true);
    assert.equal(written.mcp.servers.synthetic.command, process.execPath);
    assert.equal(gateway.mcp.servers.find((server) => server.name === 'synthetic')?.state, 'connected');
    const afterAdd = await chat.agent(context);
    assert.ok(callableNames(afterAdd).some((name) => name.startsWith('mcp__synthetic__')));
    assert.ok(deferredNames(afterAdd).some((name) => name.startsWith('mcp__synthetic__')));
    assert.ok(toolNames(afterAdd).includes('codemode'), 'the live first server installs legacy Code Mode');

    await say(chat, 'remove the synthetic MCP server');
    const removed = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.deepEqual(removed.mcp.servers, {});
    assert.equal(gateway.mcp.servers.length, 0);
    const afterRemove = await chat.agent(context);
    assert.ok(!callableNames(afterRemove).some((name) => name.startsWith('mcp__synthetic__')));
    assert.ok(!deferredNames(afterRemove).some((name) => name.startsWith('mcp__synthetic__')));
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('an OAuth login link goes only to the initiating surface, a pasted callback activates tools, and replay or cross-chat is refused', { timeout: 90_000 }, async () => {
  const env = await store('oauth-paste');
  const mcp = await startOAuthMcp();
  const { faux, models } = env.models();
  const chatKey = 'telegram:7:chat:921';
  const otherKey = 'telegram:7:chat:922';
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, {
      action: 'add',
      name: 'remote',
      server: { url: mcp.url, oauth: true, description: 'Synthetic remote server' },
    }, 'add-oauth'),
    final('added'),
    call(MCP_ADMIN_TOOL_NAME, { action: 'logout', name: 'remote' }, 'logout-remote'),
    final('logged out'),
  ]);
  let gateway;
  let surface;
  let otherSurface;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor(chatKey, context);
    await gateway.conversationFor(otherKey, context);
    surface = attachOwnerSurface(gateway, chatKey);
    otherSurface = attachOwnerSurface(gateway, otherKey);

    await say(chat, 'add and log in to the remote MCP server');
    assert.equal(surface.delivered.length, 1, 'the initiating owner surface receives the one-time URL');
    assert.equal(otherSurface.delivered.length, 0, 'another chat never receives the link');
    assert.ok(!surface.delivered[0].url.includes(AUTHORIZATION_CODE));
    const toolResults = (await chat.entries({}, 100, undefined, context)).items
      .flatMap((entry) => (entry.model ?? []))
      .filter((message) => message.role === 'toolResult')
      .map((message) => (message.content ?? []).map((part) => part.text ?? '').join(''));
    for (const text of toolResults) {
      assert.ok(!text.includes(surface.delivered[0].url), 'the URL is not a model-facing tool result');
      assert.ok(!text.includes('state='), 'the tool result carries no authorization state');
    }

    const callback = await callbackFromAuthorization(surface.delivered[0].url);
    const cross = await admin.submitCallback(otherKey, callback, context);
    assert.equal(cross.handled, true);
    assert.equal(cross.accepted, false, 'a callback from another chat is refused');

    const accepted = await admin.submitCallback(chatKey, callback, context);
    assert.equal(accepted.handled, true);
    assert.equal(accepted.accepted, true, accepted.text);
    await until(() => gateway.mcp.servers.find((server) => server.name === 'remote')?.state === 'connected',
      'the logged-in server connection');
    await until(() => surface.notices.length > 0, 'the completion notice');
    assert.match(surface.notices[0], /completed: 1 tool/);
    const agent = await chat.agent(context);
    assert.ok(callableNames(agent).some((name) => name.startsWith('mcp__remote__')));

    const replay = await admin.submitCallback(chatKey, callback, context);
    assert.equal(replay.handled, true);
    assert.equal(replay.accepted, false, 'a replayed callback is refused');

    await say(chat, 'log out of the remote server');
    await until(() => gateway.mcp.servers.find((server) => server.name === 'remote')?.failure === 'auth-required',
      'the logged-out connection to fail closed');
    assert.equal(await hasMcpOAuthTokens(mcpOAuthStatePath(env.dataDir, mcp.url), mcp.url), false);
    const revokedAgent = await chat.agent(context);
    assert.ok(!callableNames(revokedAgent).some((name) => name.startsWith('mcp__remote__')),
      'logout retires live MCP tools immediately');

    // Neither the callback nor its values ever became a transcript entry.
    const transcript = JSON.stringify((await chat.entries({}, 200, undefined, context)).items);
    assert.ok(!transcript.includes('code='));
    assert.ok(!transcript.includes('state='));
    assert.ok(!transcript.includes(callback));
  } finally {
    surface?.detach();
    otherSurface?.detach();
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});

test('a normal same-host browser callback completes the login and a failed link delivery cancels the attempt', { timeout: 90_000 }, async () => {
  const env = await store('oauth-browser');
  const mcp = await startOAuthMcp();
  const secondMcp = await startOAuthMcp();
  const { faux, models } = env.models();
  const key = 'telegram:7:chat:923';
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, {
      action: 'add',
      name: 'remote',
      server: { url: mcp.url, oauth: true },
    }, 'browser-add'),
    final('added'),
    call(MCP_ADMIN_TOOL_NAME, { action: 'add', name: 'second', server: { url: secondMcp.url, oauth: true } }, 'fail-add'),
    final('failed'),
  ]);
  let gateway;
  let surface;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor(key, context);
    surface = attachOwnerSurface(gateway, key);
    await say(chat, 'add the remote server');
    assert.equal(surface.delivered.length, 1);
    await browse(surface.delivered[0].url);
    await until(() => gateway.mcp.servers.find((server) => server.name === 'remote')?.state === 'connected',
      'the same-host browser login');
    assert.equal((await admin.list(context)).logins.length, 0);

    surface.detach();
    surface = attachOwnerSurface(gateway, key, { failDelivery: true });
    await say(chat, 'add the second server and send the link');
    assert.equal(surface.delivered.length, 0);
    assert.equal(await hasMcpOAuthTokens(mcpOAuthStatePath(env.dataDir, secondMcp.url), secondMcp.url), false,
      'a canceled login stores no grant');
    assert.equal(await hasMcpOAuthTokens(mcpOAuthStatePath(env.dataDir, mcp.url), mcp.url), true,
      'the first verified grant is unchanged by the canceled second attempt');
    const listing = await admin.list(context);
    assert.deepEqual(listing.logins, [], 'a canceled login leaves nothing waiting');
  } finally {
    surface?.detach();
    if (gateway) await gateway.close(context);
    await mcp.close();
    await secondMcp.close();
    await env.cleanup();
  }
});

test('closing the gateway aborts a waiting login and stores no grant', { timeout: 60_000 }, async () => {
  const env = await store('abort');
  const mcp = await startOAuthMcp();
  const { faux, models } = env.models();
  const key = 'telegram:7:chat:924';
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'add', name: 'remote', server: { url: mcp.url, oauth: true } }, 'abort-add'),
    final('added'),
  ]);
  let gateway;
  let surface;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const chat = await gateway.conversationFor(key, context);
    surface = attachOwnerSurface(gateway, key);
    await say(chat, 'add the remote server');
    assert.equal(surface.delivered.length, 1);
    const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
    assert.equal(await hasMcpOAuthTokens(grantPath, mcp.url), false);
    await gateway.close(context);
    gateway = undefined;
    assert.equal(await hasMcpOAuthTokens(grantPath, mcp.url), false);
  } finally {
    surface?.detach();
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});

test('an already-working grant makes a login a no-op without delivering a URL', { timeout: 60_000 }, async () => {
  const env = await store('already-authorized');
  const mcp = await startOAuthMcp();
  await writeFile(env.configFile, `${JSON.stringify({
    workspace: env.workspace,
    dataDir: env.dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    toolAllowlist: [],
    mcp: { enabled: true, servers: { remote: { url: mcp.url, oauth: true } } },
  }, null, 2)}\n`);
  const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
  await new FileMcpOAuthStateStore(grantPath, mcp.url).save({
    serverUrl: mcp.url,
    tokensExpireAt: Date.now() + 3_600_000,
    tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
  });
  const before = JSON.parse(await readFile(grantPath, 'utf8'));
  const { faux, models } = env.models();
  const key = 'telegram:7:chat:925';
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'login', name: 'remote' }, 'login-already'),
    final('login checked'),
  ]);
  let gateway;
  let surface;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const chat = await gateway.conversationFor(key, context);
    surface = attachOwnerSurface(gateway, key);
    await say(chat, 'log in again to the remote server');
    assert.equal(surface.delivered.length, 0, 'an already-working grant needs no browser step');
    assert.equal((await gateway.mcpAdmin.list(context)).logins.length, 0);
    assert.equal(gateway.mcp.servers.find((server) => server.name === 'remote')?.state, 'connected');
    const toolResult = (await chat.entries({}, 100, undefined, context)).items
      .flatMap((entry) => (entry.model ?? []))
      .filter((message) => message.role === 'toolResult')
      .map((message) => (message.content ?? []).map((part) => part.text ?? '').join('')).join('\n');
    assert.match(toolResult, /already accepted the stored grant/);
    assert.ok(!toolResult.includes(ACCESS_TOKEN));
    // The no-op keeps the stored grant unchanged.
    assert.deepEqual(JSON.parse(await readFile(grantPath, 'utf8')).state.tokens, before.state.tokens);
  } finally {
    surface?.detach();
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});


test('removing an MCP server prunes a live worker capture and retires its nested tools', { timeout: 60_000 }, async () => {
  const env = await store('worker-revoke');
  const { faux, models } = env.models();
  const childStarted = deferred();
  const releaseChild = deferred();
  const issued = new Set();
  faux.setResponses(Array.from({ length: 30 }, () => async (transcript) => {
    const input = lastUserText(transcript.messages);
    if (input.includes('Background worker task.')) {
      childStarted.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage('WORKER-CHILD-RESULT');
    }
    if (input.includes('[internal worker result]')) return fauxAssistantMessage('PARENT-AFTER-WORKER');
    if (input.includes('spawn a worker') && !issued.has('spawn')) {
      issued.add('spawn');
      return fauxAssistantMessage([
        fauxToolCall(WORKER_TOOL_NAME, {
          action: 'start',
          task: 'report the synthetic MCP tools you hold',
          workspace_mode: 'shared',
        }, { id: 'worker-start' }),
      ], { stopReason: 'toolUse' });
    }
    if (input.includes('remove the server') && !issued.has('remove')) {
      issued.add('remove');
      return fauxAssistantMessage([
        fauxToolCall(MCP_ADMIN_TOOL_NAME, { action: 'remove', name: 'synthetic' }, { id: 'worker-remove' }),
      ], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('PARENT-CONTINUED');
  }));
  let gateway;
  try {
    await writeFile(env.configFile, `${JSON.stringify({
      workspace: env.workspace,
      dataDir: env.dataDir,
      model: { provider: 'mcp-faux', modelId: 'synthetic' },
      toolAllowlist: [],
      mcp: { enabled: true, servers: { synthetic: stdioServer(env.workspace) } },
      workers: { enabled: true },
    }, null, 2)}\n`);
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const chat = await gateway.conversationFor('telegram:7:chat:926', context);
    await say(chat, 'spawn a worker');
    await childStarted.promise;
    const record = await until(async () => {
      const records = await gateway.harness.snapshot(WorkerRecordsDoc, chat.id, context);
      const candidate = records?.workers[0];
      return candidate?.conversationId ? candidate : undefined;
    }, 'the worker target conversation');
    const childConversationId = record.conversationId;
    const before = await gateway.harness.snapshot(ConfigToolCaptureDoc, childConversationId, context);
    assert.ok(before.tools.some((name) => name.startsWith('mcp__synthetic__')),
      'the live worker captured the MCP tools it was spawned with');

    await say(chat, 'remove the server');
    const after = await gateway.harness.snapshot(ConfigToolCaptureDoc, childConversationId, context);
    assert.ok(!after.tools.some((name) => name.startsWith('mcp__synthetic__')),
      'removal prunes the durable worker capture');
    for (const retained of before.tools.filter((name) => !name.startsWith('mcp__'))) {
      assert.ok(after.tools.includes(retained), `removal keeps the worker's ${retained} grant`);
    }
    const child = await gateway.harness.conversation(childConversationId, context);
    const childAgent = await child.agent(context);
    assert.ok(!callableNames(childAgent).some((name) => name.startsWith('mcp__synthetic__')),
      'the live worker cannot call or compose a removed MCP tool');

    releaseChild.resolve();
    await until(async () => {
      const records = await gateway.harness.snapshot(WorkerRecordsDoc, chat.id, context);
      return records?.workers[0]?.status === 'completed';
    }, 'the worker completion');
    await until(async () =>
      (await gateway.harness.snapshot(ConfigToolCaptureDoc, childConversationId, context)) === undefined,
      'retirement of the pruned worker capture');
  } finally {
    releaseChild.resolve();
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('the private grant file is bound to one server URL and is never shared across URLs', async () => {
  const env = await store('grant-binding');
  const first = 'https://one.example.test/mcp';
  const second = 'https://two.example.test/mcp';
  try {
    assert.notEqual(mcpOAuthStatePath(env.dataDir, first), mcpOAuthStatePath(env.dataDir, second));
    const storeOne = new FileMcpOAuthStateStore(mcpOAuthStatePath(env.dataDir, first), first);
    await storeOne.save({
      serverUrl: first,
      tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
    });
    assert.equal((await storeOne.load())?.tokens?.access_token, ACCESS_TOKEN);
    const other = new FileMcpOAuthStateStore(mcpOAuthStatePath(env.dataDir, first), second);
    assert.equal(await other.load(), undefined);
    await assert.rejects(() => storeOne.save({ serverUrl: second }), /different server URL/);
    await storeOne.clear();
    assert.equal(await storeOne.load(), undefined);
  } finally {
    await env.cleanup();
  }
});

test('a login snapshot, a rotated refresh and a logout cannot resurrect or discard a grant', async () => {
  const env = await store('grant-epoch');
  const url = 'https://epoch.example.test/mcp';
  try {
    const path = mcpOAuthStatePath(env.dataDir, url);
    const store = new FileMcpOAuthStateStore(path, url);
    await store.save({
      serverUrl: url,
      tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
    });
    const snapshot = await snapshotMcpOAuthGrant(path, url);
    assert.equal(snapshot.state.tokens.refresh_token, REFRESH_TOKEN);
    assert.equal(snapshot.epoch, 0);

    const rotated = {
      ...snapshot.state,
      tokens: { access_token: 'rotated-access', token_type: 'Bearer', refresh_token: 'rotated-refresh' },
    };
    assert.equal(await adoptMcpOAuthRefresh(path, url, snapshot, rotated), true);
    assert.equal((await store.load()).tokens.refresh_token, 'rotated-refresh');
    assert.equal(mcpOAuthGrantEpoch(path), 0);
    assert.equal(await adoptMcpOAuthRefresh(path, url, snapshot, {
      ...rotated,
      tokens: { ...rotated.tokens, refresh_token: 'third-refresh' },
    }), false);

    const canceledAttempt = await snapshotMcpOAuthGrant(path, url);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => commitMcpOAuthState(path, url, rotated, canceledAttempt.epoch, aborted.signal),
      /canceled/,
    );
    assert.equal((await store.load()).tokens.refresh_token, 'rotated-refresh');
    assert.equal(mcpOAuthGrantEpoch(path), 0);

    const late = await snapshotMcpOAuthGrant(path, url);
    await store.clear();
    assert.equal(await adoptMcpOAuthRefresh(path, url, late, rotated), false);
    await assert.rejects(
      () => commitMcpOAuthState(path, url, late.state, late.epoch),
      /changed while the login was running/,
    );
    assert.equal(await hasMcpOAuthTokens(path, url), false);
  } finally {
    await env.cleanup();
  }
});
