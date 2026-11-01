import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const modules = join(testRoot, 'node_modules/@earendil-works');

const [
  { loadConfig, parseConfig },
  { openGateway },
  {
    loginNoticeText,
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
] = await Promise.all([
  import(join(testRoot, 'dist/config.js')),
  import(join(testRoot, 'dist/runtime.js')),
  import(join(testRoot, 'dist/mcp/index.js')),
  import(join(modules, 'chord/dist/context/index.js')),
  import(join(modules, 'pi-ai/dist/index.js')),
]);

const context = BACKGROUND_CONTEXT;
const ACCESS_TOKEN = 'synthetic-access-token-value';
const REFRESH_TOKEN = 'synthetic-refresh-token-value';
const AUTHORIZATION_CODE = 'synthetic-authorization-code';
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
const final = (text) => fauxAssistantMessage([fauxText(text)]);
const toolNames = (agent) => (agent.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));

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

async function say(conversation, text) {
  const settled = await (await conversation.submit({ type: 'input', content: text }, context)).wait(context);
  assert.equal(settled.status, 'done');
}

/**
 * A synthetic MCP endpoint that requires an OAuth bearer token, plus the minimum authorization-server
 * surface the native client discovers. No network leaves loopback and every value is synthetic.
 */
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

/** Complete the owner's browser step for one started login, as a loopback browser would. */
async function browse(authorizationUrl) {
  const started = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const callbackUrl = started.headers.get('location');
  assert.ok(callbackUrl, 'the authorization endpoint must redirect to the loopback callback');
  const page = await fetch(callbackUrl);
  assert.equal(page.status, 200);
}

async function settledRequest(admin, id) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const listing = await admin.list(context);
    const request = listing.requests.find((entry) => entry.id === id);
    if (request !== undefined && (request.status === 'done' || request.status === 'failed')) return request;
    if (Date.now() > deadline) throw new Error(`request ${id} did not settle: ${JSON.stringify(request)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('an agent proposal is inert until the owner approves it, and approval writes the config file', { timeout: 60_000 }, async () => {
  const env = await store('proposal');
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, {
      action: 'propose',
      name: 'files',
      server: { command: process.execPath, args: ['-e', 'process.exit(0)'], description: 'Synthetic local server' },
    }, 'propose-config'),
    final('recorded'),
    final('relayed denial'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    assert.ok(admin, 'a gateway opened from a configuration file exposes owner MCP management');
    const chat = await gateway.conversationFor('telegram:7:chat:910', context);
    assert.ok(toolNames(await chat.agent(context)).includes(MCP_ADMIN_TOOL_NAME));
    // A state-only conversation is not a chat and receives no management tool.
    const stateChat = await gateway.conversationFor('telegram:7:channel-state', context);
    assert.ok(!toolNames(await stateChat.agent(context)).includes(MCP_ADMIN_TOOL_NAME));

    await say(chat, 'propose a local MCP server');
    const listing = await admin.list(context);
    assert.equal(listing.configured, false);
    assert.equal(listing.requests.length, 1);
    const request = listing.requests[0];
    assert.equal(request.kind, 'config');
    assert.equal(request.name, 'files');
    assert.equal(request.status, 'pending');
    // Nothing was written by the proposal.
    const before = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.equal(before.mcp, undefined);

    const shown = await admin.show(request.id, context);
    assert.equal(shown.found, true);
    assert.match(shown.text, /stdio/);
    assert.match(shown.text, /Synthetic local server/);
    assert.equal((await admin.show('0123456789abcdef', context)).found, false);

    const denied = await admin.deny(request.id, context);
    assert.equal(denied.status, 'applied');
    assert.match(denied.text, /nothing was configured/i);
    const afterDeny = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.equal(afterDeny.mcp, undefined);
    assert.deepEqual((await admin.list(context)).requests, []);
    assert.equal((await admin.approve(request.id, context)).status, 'refused');
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('an approved entry is written atomically and an owner-approved OAuth login stores a private grant', { timeout: 90_000 }, async () => {
  const env = await store('oauth');
  const mcp = await startOAuthMcp();
  const { faux, models } = env.models();
  const proposal = {
    action: 'propose',
    name: 'remote',
    server: { url: mcp.url, oauth: true, description: 'Synthetic remote server' },
  };
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, proposal, 'propose-oauth'),
    final('recorded'),
    final('relayed login result'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor('telegram:7:chat:911', context);
    await say(chat, 'propose the remote MCP server');
    const request = (await admin.list(context)).requests[0];
    assert.equal(request.kind, 'config');

    // An unapproved proposal still creates no connection and no grant.
    assert.equal((await stat(join(env.dataDir, 'mcp')).catch(() => undefined)), undefined);

    const approved = await admin.approve(request.id, context);
    assert.equal(approved.status, 'login-started', approved.text);
    assert.ok(approved.authorization, 'the approving owner surface receives the authorization URL');
    const written = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.equal(written.mcp.enabled, true);
    assert.equal(written.mcp.servers.remote.url, mcp.url);
    assert.equal(written.mcp.servers.remote.oauth, true);
    assert.equal(written.mcp.servers.remote.description, 'Synthetic remote server');
    // The running gateway keeps its open configuration: nothing connected yet.
    assert.equal(gateway.mcp, undefined);

    // While the browser step is outstanding the request is running, not approvable again.
    const running = (await admin.list(context)).requests[0];
    assert.equal(running.status, 'running');
    assert.equal((await admin.approve(request.id, context)).status, 'refused');

    await browse(approved.authorization.url);
    const settled = await settledRequest(admin, request.id);
    assert.equal(settled.status, 'done', JSON.stringify(settled));
    assert.match(settled.summary, /login complete, 1 tool/);
    assert.deepEqual(mcp.sequence.filter((entry) => entry.grant).map((entry) => entry.grant), ['authorization_code']);

    const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
    const mode = (await stat(grantPath)).mode & 0o777;
    assert.equal(mode, 0o600, 'the stored grant is private to the runtime user');
    const stored = JSON.parse(await readFile(grantPath, 'utf8'));
    assert.equal(stored.state.tokens.access_token, ACCESS_TOKEN);
    assert.equal((await stat(join(env.dataDir, 'mcp', 'oauth'))).mode & 0o777, 0o700);

    // The internal result reaches the origin chat's agent without any credential material.
    const notice = loginNoticeText({
      requestId: request.id,
      name: 'remote',
      originConversationId: chat.id,
      outcome: { ok: true, tools: 1 },
    });
    assert.ok(!notice.includes(ACCESS_TOKEN));
    assert.ok(!notice.includes(REFRESH_TOKEN));
    assert.ok(!notice.includes('http://127.0.0.1'));
    const kinds = (await chat.entries({}, 200, undefined, context)).items
      .filter((entry) => entry.kind === 'nanobot.mcp-login-result');
    assert.equal(kinds.length, 1);
    assert.equal(kinds[0].data.requestId, request.id);
  } finally {
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});

test('an owner-approved logout deletes the grant and an approved removal edits the config file', { timeout: 60_000 }, async () => {
  const env = await store('logout');
  const url = 'https://docs.example.test/mcp';
  await writeFile(env.configFile, `${JSON.stringify({
    workspace: env.workspace,
    dataDir: env.dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    toolAllowlist: [],
    // Configured but never connected: this entry exists only for the management surface.
    mcp: { enabled: true, servers: { docs: { url, oauth: true, enabled: false } } },
  }, null, 2)}\n`);
  const grantPath = mcpOAuthStatePath(env.dataDir, url);
  await new FileMcpOAuthStateStore(grantPath, url).save({
    serverUrl: url,
    tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
  });
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'logout', name: 'docs' }, 'logout-1'),
    final('logout recorded'),
    call(MCP_ADMIN_TOOL_NAME, { action: 'remove', name: 'docs' }, 'remove-1'),
    final('removal recorded'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    // The only entry is `enabled: false`, so this open starts no MCP client at all.
    assert.equal(gateway.mcp, undefined);
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor('telegram:7:chat:912', context);

    await say(chat, 'log out of the docs server');
    const logout = (await admin.list(context)).requests[0];
    assert.equal(logout.kind, 'logout');
    const loggedOut = await admin.approve(logout.id, context);
    assert.equal(loggedOut.status, 'applied');
    assert.equal((await stat(grantPath).catch(() => undefined)), undefined);

    await say(chat, 'remove the docs server');
    const remove = (await admin.list(context)).requests.find((entry) => entry.status === 'pending');
    assert.ok(remove);
    assert.equal(remove.kind, 'remove');
    const removed = await admin.approve(remove.id, context);
    assert.equal(removed.status, 'applied');
    const written = JSON.parse(await readFile(env.configFile, 'utf8'));
    assert.deepEqual(written.mcp.servers, {});
    assert.equal(written.mcp.enabled, true, 'removing one entry is not a capability-wide disable');
  } finally {
    if (gateway) await gateway.close(context);
    await env.cleanup();
  }
});

test('an oauth entry without a stored grant fails closed with auth-required', { timeout: 60_000 }, async () => {
  const env = await store('auth-required');
  const mcp = await startOAuthMcp();
  const { models } = env.models();
  let gateway;
  try {
    gateway = await openGateway(env.config({
      mcp: { enabled: true, servers: { remote: { url: mcp.url, oauth: true } } },
    }), context, { models });
    assert.equal(gateway.mcp.servers.length, 1);
    assert.equal(gateway.mcp.servers[0].state, 'failed');
    assert.equal(gateway.mcp.servers[0].failure, 'auth-required');
    assert.equal(gateway.mcp.servers[0].tools, 0);
    // No dynamic registration or authorization attempt happens at connect time.
    assert.deepEqual(mcp.sequence, []);
  } finally {
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});

test('closing the gateway aborts a waiting login and leaves no grant or stuck request', { timeout: 60_000 }, async () => {
  const env = await store('abort');
  const mcp = await startOAuthMcp();
  await writeFile(env.configFile, `${JSON.stringify({
    workspace: env.workspace,
    dataDir: env.dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    toolAllowlist: [],
    mcp: { enabled: true, servers: { remote: { url: mcp.url, oauth: true, enabled: false } } },
  }, null, 2)}\n`);
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'login', name: 'remote' }, 'login-1'),
    final('login recorded'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor('telegram:7:chat:913', context);
    await say(chat, 'log in to the remote MCP server');
    const request = (await admin.list(context)).requests[0];
    assert.equal(request.kind, 'login');
    const approved = await admin.approve(request.id, context);
    assert.equal(approved.status, 'login-started');
    const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
    assert.equal(await hasMcpOAuthTokens(grantPath, mcp.url), false);

    const id = request.id;
    await gateway.close(context);
    gateway = undefined;
    // Shutdown stops the flow before the callback: a pending client registration is not a grant.
    assert.equal(await hasMcpOAuthTokens(grantPath, mcp.url), false);

    // The interrupted request is repaired on the next open instead of blocking every later decision.
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const reopened = (await gateway.mcpAdmin.list(context)).requests.find((entry) => entry.id === id);
    assert.ok(reopened);
    assert.equal(reopened.status, 'failed');
    assert.match(reopened.summary, /interrupted|canceled/i);
  } finally {
    if (gateway) await gateway.close(context);
    await mcp.close();
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
    // Another server URL reading the same file content receives no grant.
    const other = new FileMcpOAuthStateStore(mcpOAuthStatePath(env.dataDir, first), second);
    assert.equal(await other.load(), undefined);
    await assert.rejects(() => storeOne.save({ serverUrl: second }), /different server URL/);
    await storeOne.clear();
    assert.equal(await storeOne.load(), undefined);
  } finally {
    await env.cleanup();
  }
});

test('an oauth grant is used in every execution mode and never surfaces through a model-facing value', { timeout: 60_000 }, async () => {
  const env = await store('accepted-mode');
  const mcp = await startOAuthMcp();
  await writeFile(env.configFile, `${JSON.stringify({
    workspace: env.workspace,
    dataDir: env.dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    // The coding shell runs unsandboxed and a stdio server is enabled: the accepted same-user trust
    // boundary, which is not a reason to refuse the grant.
    toolAllowlist: ['bash'],
    mcp: {
      enabled: true,
      servers: {
        local: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        remote: { url: mcp.url, oauth: true },
      },
    },
  }, null, 2)}\n`);
  const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
  await new FileMcpOAuthStateStore(grantPath, mcp.url).save({
    serverUrl: mcp.url,
    tokensExpireAt: Date.now() + 3_600_000,
    tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
  });
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'login', name: 'remote' }, 'login-accepted'),
    final('login recorded'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const remote = gateway.mcp.servers.find((server) => server.name === 'remote');
    assert.equal(remote.state, 'connected');
    assert.equal(remote.tools, 1);
    // No status field carries credential material.
    const status = JSON.stringify(gateway.mcp.servers);
    assert.ok(!status.includes(ACCESS_TOKEN));
    assert.ok(!status.includes(REFRESH_TOKEN));

    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor('telegram:7:chat:916', context);
    await say(chat, 'log in to the remote server');
    const request = (await admin.list(context)).requests[0];
    assert.equal(request.kind, 'login');
    // The listing, the full disclosure and the approval result never contain the tokens.
    const shown = await admin.show(request.id, context);
    assert.equal(shown.found, true);
    for (const text of [JSON.stringify(await admin.list(context)), shown.text]) {
      assert.ok(!text.includes(ACCESS_TOKEN));
      assert.ok(!text.includes(REFRESH_TOKEN));
    }
    const approved = await admin.approve(request.id, context);
    assert.match(approved.text, /already accepted the stored grant/);
    assert.ok(!approved.text.includes(ACCESS_TOKEN));
    assert.ok(!approved.text.includes(REFRESH_TOKEN));
    // The approved no-op keeps the grant file in place.
    assert.equal(await hasMcpOAuthTokens(grantPath, mcp.url), true);
  } finally {
    if (gateway) await gateway.close(context);
    await mcp.close();
    await env.cleanup();
  }
});

test('an already-authorized grant whose tool listing fails reports an unknown tool count', { timeout: 60_000 }, async () => {
  const env = await store('already-authorized');
  const mcp = await startOAuthMcp({ failToolList: true });
  await writeFile(env.configFile, `${JSON.stringify({
    workspace: env.workspace,
    dataDir: env.dataDir,
    model: { provider: 'mcp-faux', modelId: 'synthetic' },
    toolAllowlist: [],
    mcp: { enabled: true, servers: { remote: { url: mcp.url, oauth: true, enabled: false } } },
  }, null, 2)}\n`);
  const grantPath = mcpOAuthStatePath(env.dataDir, mcp.url);
  await new FileMcpOAuthStateStore(grantPath, mcp.url).save({
    serverUrl: mcp.url,
    tokensExpireAt: Date.now() + 3_600_000,
    tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN },
  });
  const before = JSON.parse(await readFile(grantPath, 'utf8'));
  const { faux, models } = env.models();
  faux.setResponses([
    call(MCP_ADMIN_TOOL_NAME, { action: 'login', name: 'remote' }, 'login-already'),
    final('login recorded'),
  ]);
  let gateway;
  try {
    gateway = await openGateway(await env.configFromFile(), context, { models });
    const admin = gateway.mcpAdmin;
    const chat = await gateway.conversationFor('telegram:7:chat:915', context);
    await say(chat, 'log in to the remote server');
    const request = (await admin.list(context)).requests[0];
    assert.equal(request.kind, 'login');
    const approved = await admin.approve(request.id, context);
    assert.equal(approved.status, 'applied', approved.text);
    assert.match(approved.text, /tool listing failed/);
    // It must not claim a count it did not observe.
    assert.doesNotMatch(approved.text, /\(0 tool/);
    const settled = (await admin.list(context)).requests.find((entry) => entry.id === request.id);
    assert.equal(settled.status, 'done');
    assert.match(settled.summary, /tool listing failed/);
    // A no-op login keeps the stored grant's tokens as they were (the store re-serializes field order).
    assert.deepEqual(JSON.parse(await readFile(grantPath, 'utf8')).state.tokens, before.state.tokens);
  } finally {
    if (gateway) await gateway.close(context);
    await mcp.close();
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
    // The generation is read together with the grant, so a logout cannot land between the two.
    const snapshot = await snapshotMcpOAuthGrant(path, url);
    assert.equal(snapshot.state.tokens.refresh_token, REFRESH_TOKEN);
    assert.equal(snapshot.epoch, 0);

    // A refresh the server already issued is adopted, because it may have invalidated the old one.
    const rotated = {
      ...snapshot.state,
      tokens: { access_token: 'rotated-access', token_type: 'Bearer', refresh_token: 'rotated-refresh' },
    };
    assert.equal(await adoptMcpOAuthRefresh(path, url, snapshot, rotated), true);
    assert.equal((await store.load()).tokens.refresh_token, 'rotated-refresh');
    // Adoption does not retire the generation, so the live writer and this attempt keep working.
    assert.equal(mcpOAuthGrantEpoch(path), 0);
    // The same snapshot cannot adopt twice: the stored grant is no longer what it read.
    assert.equal(await adoptMcpOAuthRefresh(path, url, snapshot, {
      ...rotated,
      tokens: { ...rotated.tokens, refresh_token: 'third-refresh' },
    }), false);

    // A canceled attempt installs nothing, even when it reaches the commit.
    const canceledAttempt = await snapshotMcpOAuthGrant(path, url);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => commitMcpOAuthState(path, url, rotated, canceledAttempt.epoch, aborted.signal),
      /canceled/,
    );
    assert.equal((await store.load()).tokens.refresh_token, 'rotated-refresh');
    assert.equal(mcpOAuthGrantEpoch(path), 0);

    // A logout wins over both the adoption and a late verified commit.
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
