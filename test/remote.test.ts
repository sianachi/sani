import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { z } from 'zod';
import { normalizeRemoteUrl, Remote, type OAuthState } from '../src/remote.ts';

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

test('remote URLs require public HTTPS, with loopback reserved for test fixtures', () => {
  assert.equal(normalizeRemoteUrl('https://example.org/mcp'), 'https://example.org/mcp');
  assert.equal(normalizeRemoteUrl('http://127.0.0.1:8123/mcp', true), 'http://127.0.0.1:8123/mcp');
  for (const url of [
    'http://example.org/mcp',
    'https://127.0.0.1/mcp',
    'https://2130706433/mcp',
    'https://[::ffff:a9fe:a9fe]/mcp',
    'https://10.0.0.1/mcp',
    'https://vm.local/mcp',
    'https://user:password@example.org/mcp',
    'https://example.org/mcp#key',
    'https://example.org/mcp#',
    'https://example.org/mcp?token=value',
    'https://example.org/mcp?',
  ]) assert.throws(() => normalizeRemoteUrl(url), url);
});

test('OAuth registers, binds PKCE, refreshes on discovery and spends each tool dispatch once', async (t) => {
  let origin = '';
  let expectedChallenge: string | null;
  let activeToken = 'initial-test-access';
  let differentIssuer = true;
  let acceptToken = true;
  let refuseTool = false;
  let redirectTool = false;
  let toolCalls = 0;
  let refreshes = 0;
  let registrations = 0;
  let redirectedRequests = 0;
  const failures: unknown[] = [];
  const rpcSchema = z.object({
    method: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  });
  const tools = [{ name: 'lookup', inputSchema: { type: 'object' } }];
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end('Fixture assertion failed');
    });
  });
  t.after(() => server.close());

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === '/.well-known/oauth-protected-resource/mcp') {
      assert.equal(request.headers.authorization, undefined);
      return json(response, {
        resource: origin + '/mcp',
        authorization_servers: [origin],
        scopes_supported: ['read', 'write'],
      });
    }
    if (request.url === '/.well-known/oauth-authorization-server') {
      assert.equal(request.headers.authorization, undefined);
      return json(response, {
        issuer: differentIssuer ? origin + '/different' : origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        registration_endpoint: origin + '/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (request.url === '/register' && request.method === 'POST') {
      registrations += 1;
      const input: unknown = JSON.parse(await body(request));
      const registration = z.object({ redirect_uris: z.array(z.string()), scope: z.string() }).parse(input);
      assert.deepEqual(registration.redirect_uris, ['https://operator.example/oauth/callback']);
      assert.equal(registration.scope, 'read');
      return json(response, { ...registration, client_id: 'test-client' });
    }
    if (request.url === '/token' && request.method === 'POST') {
      const params = new URLSearchParams(await body(request));
      assert.equal(params.get('client_id'), 'test-client');
      assert.equal(params.get('resource'), origin + '/mcp');
      if (params.get('grant_type') === 'authorization_code') {
        assert.equal(params.get('code'), 'test-code');
        assert.equal(params.get('redirect_uri'), 'https://operator.example/oauth/callback');
        const verifier = params.get('code_verifier');
        assert.ok(verifier);
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), expectedChallenge);
      } else {
        assert.equal(params.get('grant_type'), 'refresh_token');
        assert.equal(params.get('refresh_token'), 'test-refresh-token');
        refreshes += 1;
        activeToken = 'fresh-test-access';
        acceptToken = true;
      }
      return json(response, {
        access_token: activeToken,
        ...(params.get('grant_type') === 'authorization_code' && { refresh_token: 'test-refresh-token' }),
        token_type: 'Bearer',
        scope: 'read',
      });
    }
    if (request.url === '/unexpected') {
      redirectedRequests += 1;
      response.writeHead(500).end();
      return;
    }
    if (request.url === '/mcp' && request.method === 'POST') {
      const message = rpcSchema.parse(JSON.parse(await body(request)));
      if (message.method === 'tools/call') {
        toolCalls += 1;
        if (redirectTool) {
          response.writeHead(307, { Location: origin + '/unexpected' }).end();
          return;
        }
      }
      if (!acceptToken || request.headers.authorization !== `Bearer ${activeToken}`
        || (message.method === 'tools/call' && refuseTool)) {
        response.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        }).end('Authentication required');
        return;
      }
      if (message.method === 'initialize') {
        return json(response, {
          jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: '2025-11-25', capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        });
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') return json(response, { jsonrpc: '2.0', id: message.id, result: { tools } });
      assert.equal(message.method, 'tools/call');
      assert.deepEqual(message.params, { name: 'lookup', arguments: { invoice: 123 } });
      return json(response, {
        jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Paid' }] },
      });
    }
    response.writeHead(404).end();
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;

  let persisted: OAuthState = {};
  const reconnect = () => new Remote({
    url: origin + '/mcp',
    auth: { kind: 'oauth', issuer: origin, state: persisted, scope: 'read' },
    callbackUrl: 'https://operator.example/oauth/callback',
    saveOAuth: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    allowInsecureLoopback: true,
  });

  await assert.rejects(reconnect().startOAuth('unused-state'), /different OAuth issuer/);
  assert.equal(registrations, 0);
  differentIssuer = false;

  const redirect = new URL(await reconnect().startOAuth('one-time-state'));
  expectedChallenge = redirect.searchParams.get('code_challenge');
  assert.equal(redirect.pathname, '/authorize');
  assert.equal(redirect.searchParams.get('state'), 'one-time-state');
  assert.equal(redirect.searchParams.get('scope'), 'read');
  assert.equal(redirect.searchParams.get('client_id'), 'test-client');
  assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(expectedChallenge);
  assert.equal(registrations, 1);

  await reconnect().finishOAuth('test-code');
  assert.equal(persisted.verifier, undefined);
  assert.equal(persisted.tokens?.access_token, activeToken);
  assert.equal(new URL(String(persisted.tokens?.issuer)).origin, origin);
  assert.equal((await reconnect().discover())[0]?.name, 'lookup');

  acceptToken = false;
  const result = await reconnect().call('lookup', { invoice: 123 }, (discovered) => {
    assert.equal(discovered[0]?.name, 'lookup');
    assert.equal(toolCalls, 0);
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Paid' }]);
  assert.equal(refreshes, 1);
  assert.equal(persisted.tokens?.refresh_token, 'test-refresh-token');
  assert.equal(toolCalls, 1);

  await assert.rejects(reconnect().call('lookup', { invoice: 123 }, () => {
    throw new Error('Approval changed before dispatch.');
  }));
  assert.equal(toolCalls, 1);

  refuseTool = true;
  await assert.rejects(reconnect().call('lookup', { invoice: 123 }), /platform refused/);
  assert.equal(refreshes, 1);
  assert.equal(toolCalls, 2);

  redirectTool = true;
  await assert.rejects(reconnect().call('lookup', { invoice: 123 }), /remote MCP operation failed/);
  assert.equal(toolCalls, 3);
  assert.equal(redirectedRequests, 0);
  assert.deepEqual(failures, []);
});

test('registered GitHub App uses PKCE and sends client credentials only in the issuer token form', async (t) => {
  const resource = 'https://api.githubcopilot.com/mcp/x/pull_requests/readonly';
  const issuer = 'https://github.com/login/oauth';
  const callback = 'http://127.0.0.1:8765/oauth/callback';
  const clientId = 'test-github-app-id';
  const clientSecret = 'test-github-app-secret';
  let challenge: string | null;
  let formResponse = true;
  let exchanges = 0;
  let refreshes = 0;
  let activeToken = 'test-user-access';
  let expired = false;
  let persisted: OAuthState = { clientInformation: { client_id: clientId, client_secret: clientSecret, issuer } };

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    if (url === issuer + '/access_token') {
      assert.equal(init?.method, 'POST');
      assert.equal(headers.get('Accept'), 'application/json');
      assert.equal(headers.get('Authorization'), null);
      const form = init?.body;
      assert.ok(form instanceof URLSearchParams);
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('client_secret'), clientSecret);
      assert.equal(form.get('resource'), resource);
      if (form.get('grant_type') === 'authorization_code') {
        exchanges += 1;
        assert.equal(form.get('redirect_uri'), callback);
        assert.equal(form.get('code'), 'test-github-code');
        const verifier = form.get('code_verifier');
        assert.ok(verifier);
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
        if (formResponse) {
          return new Response('access_token=unexpected-form-token&token_type=bearer', {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        }
      } else {
        refreshes += 1;
        expired = false;
        activeToken = 'test-replacement-access';
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'test-github-refresh');
      }
      return Response.json({ access_token: activeToken, refresh_token: 'test-github-refresh', token_type: 'bearer' });
    }

    assert.ok(!url.includes(clientId) && !url.includes(clientSecret));
    assert.ok(!JSON.stringify([...headers]).includes(clientSecret));
    assert.ok(!String(init?.body).includes(clientId) && !String(init?.body).includes(clientSecret));
    if (url === 'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/x/pull_requests/readonly') {
      assert.equal(headers.get('Authorization'), null);
      return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['repo', 'write:packages'] });
    }
    if (url === 'https://github.com/.well-known/oauth-authorization-server/login/oauth') {
      assert.equal(headers.get('Authorization'), null);
      return Response.json({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/access_token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['offline_access'],
      });
    }
    assert.equal(url, resource);
    if (expired) return new Response(null, { status: 401 });
    assert.equal(headers.get('Authorization'), `Bearer ${activeToken}`);
    assert.equal(typeof init?.body, 'string');
    const request = z.object({ method: z.string(), id: z.number().optional() }).parse(JSON.parse(String(init?.body)));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'initialize') return Response.json({
      jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'GitHub fixture', version: '1' },
      },
    });
    assert.equal(request.method, 'tools/list');
    return Response.json({
      jsonrpc: '2.0', id: request.id,
      result: { tools: [{ name: 'pull_request_read', inputSchema: { type: 'object' } }] },
    });
  });

  const connect = () => new Remote({
    url: resource,
    auth: { kind: 'oauth', issuer, state: persisted, scope: 'offline_access' },
    callbackUrl: callback,
    saveOAuth: (state) => { persisted = state; },
  });

  const first = new URL(await connect().startOAuth('first-state'));
  challenge = first.searchParams.get('code_challenge');
  assert.equal(first.searchParams.get('client_id'), clientId);
  assert.equal(first.searchParams.get('scope'), 'offline_access');
  assert.equal(first.searchParams.get('resource'), resource);
  assert.ok(!first.href.includes(clientSecret));
  await assert.rejects(connect().finishOAuth('test-github-code'), /Could not complete authorization/);
  assert.ok(!Object.hasOwn(persisted, 'tokens'));

  formResponse = false;
  challenge = new URL(await connect().startOAuth('second-state')).searchParams.get('code_challenge');
  await connect().finishOAuth('test-github-code');
  assert.equal(exchanges, 2);
  assert.equal(persisted.tokens?.access_token, activeToken);
  assert.equal(persisted.tokens?.issuer, issuer);

  expired = true;
  assert.equal((await connect().discover())[0]?.name, 'pull_request_read');
  assert.equal(refreshes, 1);
  assert.equal(persisted.tokens?.access_token, activeToken);
});
