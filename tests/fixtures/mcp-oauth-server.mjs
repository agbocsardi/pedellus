// One synthetic MCP Streamable HTTP server that speaks the native OAuth flow: protected-resource
// and authorization-server discovery, dynamic client registration, a PKCE challenge at
// `/authorize`, a token endpoint and an authenticated `/mcp` endpoint with one tool. No real
// provider and no network beyond one loopback listener. Shared by the MCP management checks and
// the app channel's login-surface checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const ACCESS_TOKEN = 'synthetic-access-token-value';
export const REFRESH_TOKEN = 'synthetic-refresh-token-value';
export const AUTHORIZATION_CODE = 'synthetic-authorization-code';

/** GET the authorization URL and return the loopback callback it redirects to, without following it. */
export async function callbackFromAuthorization(authorizationUrl) {
  const started = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const callback = started.headers.get('location');
  assert.ok(callback, 'the authorization endpoint must redirect to the loopback callback');
  return callback;
}

/** Complete a normal same-host browser flow, as the owner's phone would. */
export async function browse(authorizationUrl) {
  const callback = await callbackFromAuthorization(authorizationUrl);
  const page = await fetch(callback);
  assert.equal(page.status, 200);
}

export async function startOAuthMcp(options = {}) {
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
