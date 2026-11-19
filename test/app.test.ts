import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { createApp } from '../src/app.ts';
import { NotStarted, type SandboxRun } from '../src/sandbox.ts';

async function listen(context: TestContext, handle: RequestListener): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function connect(context: TestContext, origin: string, token: string): Promise<Client> {
  const client = new Client({ name: 'sani-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  context.after(() => client.close());
  await client.connect(transport);
  return client;
}

const actionState = z.object({
  id: z.string(),
  status: z.string(),
  approvalUrl: z.string().optional(),
  result: z.unknown().optional(),
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
    isError: z.boolean().optional(),
  }).parse(result);
  return { body: text.content[0].text, isError: text.isError ?? false };
}

async function state(client: Client, id: string) {
  const result = await call(client, 'get_request', { id });
  assert.equal(result.isError, false);
  return actionState.parse(JSON.parse(result.body));
}

async function openConsole(context: TestContext, sandbox?: SandboxRun) {
  const directory = await mkdtemp(join(tmpdir(), 'sani-app-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const adminPassword = 'fixture-operator-password-7654321';
  let handle: RequestListener = (_request, response) => response.writeHead(503).end();
  const web = await listen(context, (request, response) => handle(request, response));
  const app = createApp({
    dbPath: join(directory, 'sani.db'),
    encryptionKey: randomBytes(32),
    adminPassword,
    publicOrigin: web,
    allowInsecureLoopback: true,
    sandbox,
  });
  handle = app.handle;
  context.after(() => app.close());

  let cookie = '';
  async function form(path: string, fields: Record<string, string> = {}, origin = web) {
    return fetch(new URL(path, web), {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, cookie },
      body: new URLSearchParams(fields),
    });
  }

  const login = await form('/login', { password: adminPassword });
  assert.equal(login.status, 303);
  cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  assert.match(cookie, /^[^=]+=[^=]+/);
  await login.text();

  async function addAgent(name: string, credentialCanary: string) {
    const added = await form('/agents', { name });
    assert.equal(added.status, 200);
    const body = await added.text();
    const token = body.match(/<span class="l">(sani_[a-zA-Z0-9_\-]{43})<\/span>/)?.[1];
    assert(body.includes(`claude mcp add --transport http sani ${web}/mcp --header &quot;Authorization: Bearer ${token}&quot;`));
    assert(token, 'the operator receives the new agent credential once');
    assert.equal(body.includes(credentialCanary), false);
    return { token, client: await connect(context, web, token) };
  }

  return { directory, web, cookie, form, addAgent };
}

test('the operator approves one credential-bearing call and controls what agents can see', { timeout: 30_000 }, async (context) => {
  const platformToken = 'fixture-platform-token-AbC0987654321';
  const encodedToken = Buffer.from(platformToken).toString('base64');
  const credentialEchoes = {
    literal: [platformToken],
    encoded: [encodedToken],
    split: [platformToken.slice(0, 16), platformToken.slice(16)],
  };
  const platformCalls: { item: string; authorization: string | undefined }[] = [];
  const upstream = await listen(context, (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(405).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${platformToken}`) {
      response.writeHead(401).end();
      return;
    }
    const platform = new McpServer({ name: 'fixture-platform', version: '1.0.0' });
    platform.registerTool('inspect_widget', { inputSchema: { item: z.enum(['17', '18', 'literal', 'encoded', 'split']) } }, ({ item }) => {
      platformCalls.push({ item, authorization: request.headers.authorization });
      const texts = item === '17' || item === '18' ? [`Widget ${item} is ready`] : credentialEchoes[item];
      return { content: texts.map(text => ({ type: 'text', text })) };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => void platform.close());
    void platform.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  const { directory, web, cookie, form, addAgent } = await openConsole(context);

  const saved = await form('/connections', {
    name: 'widgets',
    url: new URL('/mcp', upstream).href,
    auth: 'bearer',
    token: platformToken,
    issuer: '',
  });
  assert.equal(saved.status, 303);
  assert.equal((await saved.text()).includes(platformToken), false);
  const consolePage = await fetch(web, { headers: { cookie } });
  assert.equal(consolePage.status, 200);
  const consoleHtml = await consolePage.text();
  assert.match(consoleHtml, /widgets/);
  assert.equal(consoleHtml.includes(platformToken), false);
  const connectionPath = consoleHtml.match(/\/connections\/[^/"\s]+\/tools/)?.[0];
  assert(connectionPath, 'the newly discovered tool can be enabled from the console');
  const enabled = await form(connectionPath, { tool: 'inspect_widget', enabled: 'true' });
  assert.equal(enabled.status, 303);
  await enabled.text();

  const agent = await addAgent('first-agent', platformToken);
  const other = await addAgent('second-agent', platformToken);
  const list = await call(agent.client, 'list_actions');
  assert.equal(list.isError, false);
  assert.match(list.body, /inspect_widget/);
  assert.match(list.body, /widgets/);
  assert.equal(list.body.includes(platformToken), false);

  async function request(item: string) {
    const generated = await call(agent.client, 'request_action', {
      connection: 'widgets',
      tool: 'inspect_widget',
      args: { item },
    });
    assert.equal(generated.isError, false, generated.body);
    const action = actionState.parse(JSON.parse(generated.body));
    assert.equal(action.status, 'pending');
    assert.equal(action.approvalUrl, new URL(`/requests/${action.id}`, web).href);
    return action.id;
  }

  const allowed = await request('17');
  assert.equal((await state(agent.client, allowed)).status, 'pending');
  assert.deepEqual(platformCalls, []);
  assert.equal((await call(other.client, 'get_request', { id: allowed })).isError, true);

  const crossOrigin = await form(`/requests/${allowed}/approve`, {}, 'https://wrong-origin.invalid');
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.text();
  assert.deepEqual(platformCalls, []);

  const decisions = await Promise.all([
    form(`/requests/${allowed}/approve`),
    form(`/requests/${allowed}/approve`),
  ]);
  assert(decisions.some(({ status }) => status === 303));
  await Promise.all(decisions.map((response) => response.text()));
  const completed = await state(agent.client, allowed);
  assert.match(JSON.stringify(completed.result), /Widget 17 is ready/);
  assert.deepEqual(platformCalls, [{ item: '17', authorization: `Bearer ${platformToken}` }]);

  const declined = await request('18');
  const denial = await form(`/requests/${declined}/decline`);
  assert.equal(denial.status, 303);
  await denial.text();
  const attempt = await form(`/requests/${declined}/approve`);
  await attempt.text();
  assert.equal((await state(agent.client, declined)).status, 'declined');
  assert.deepEqual(platformCalls.map(({ item }) => item), ['17']);

  for (const format of Object.keys(credentialEchoes)) {
    const echo = await request(format);
    const echoApproval = await form(`/requests/${echo}/approve`);
    assert.equal(echoApproval.status, 303);
    await echoApproval.text();
    const result = await state(agent.client, echo);
    assert.equal(result.status, 'failed');
    assert.equal(result.result, undefined);
    const echoPage = await fetch(new URL(`/requests/${echo}`, web), { headers: { cookie } });
    const echoHtml = await echoPage.text();
    assert.equal(echoHtml.includes(platformToken), false);
    assert.equal(echoHtml.includes(encodedToken), false);
  }
  assert.deepEqual(platformCalls.map(({ item }) => item), ['17', 'literal', 'encoded', 'split']);

  const beforeRotation = await request('18');
  const rotate = await form(connectionPath.replace(/tools$/, 'rotate'), {
    token: 'fixture-rotated-platform-token-12345678',
  });
  assert.equal(rotate.status, 303);
  await rotate.text();
  const staleApproval = await form(`/requests/${beforeRotation}/approve`);
  await staleApproval.text();
  assert.equal((await state(agent.client, beforeRotation)).status, 'failed');
  assert.deepEqual(platformCalls.map(({ item }) => item), ['17', 'literal', 'encoded', 'split']);

  const persisted = Buffer.concat(await Promise.all(
    (await readdir(directory)).map((name) => readFile(join(directory, name))),
  ));
  assert.equal(persisted.includes(platformToken), false);
  assert.equal(persisted.includes(encodedToken), false);
  assert.equal(persisted.includes(agent.token), false);
  assert.equal(persisted.includes(other.token), false);
});

async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding('utf8');
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function verifyOAuthConnection(
  context: TestContext,
  registered?: { clientId: string; clientSecret: string; scope: string },
) {
  const { web, cookie, form, directory, addAgent } = await openConsole(context);
  const oauthToken = 'fixture-oauth-access-token-AbC0987654321';
  const code = 'fixture-oauth-code';
  const clientId = registered?.clientId ?? 'sani-fixture-client';
  let registrations = 0;
  let exchanges = 0;
  let resource = '';
  let issuer = '';
  let challenge = '';
  const oauthServer = await listen(context, (request, response) => {
    void (async () => {
      const path = request.url;
      if (path?.startsWith('/.well-known/oauth-protected-resource')) {
        return json(response, { resource, authorization_servers: [issuer] });
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return json(response, {
          issuer,
          authorization_endpoint: new URL('/authorize', issuer).href,
          token_endpoint: new URL('/token', issuer).href,
          ...(registered
            ? { token_endpoint_auth_methods_supported: ['client_secret_post'] }
            : { registration_endpoint: new URL('/register', issuer).href }),
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (path === '/register' && request.method === 'POST') {
        await readBody(request);
        registrations += 1;
        return json(response, {
          client_id: clientId,
          redirect_uris: [new URL('/oauth/callback', web).href],
          token_endpoint_auth_method: 'none',
        });
      }
      if (path === '/token' && request.method === 'POST') {
        const params = new URLSearchParams(await readBody(request));
        const verifier = params.get('code_verifier') ?? '';
        if (params.get('client_id') !== clientId || params.get('client_secret') !== (registered?.clientSecret ?? null)
          || params.get('code') !== code || createHash('sha256').update(verifier).digest('base64url') !== challenge) {
          response.writeHead(400).end();
          return;
        }
        exchanges += 1;
        return json(response, { access_token: oauthToken, token_type: 'Bearer' });
      }
      if (path === '/mcp' && request.method === 'POST') {
        if (request.headers.authorization !== `Bearer ${oauthToken}`) {
          response.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', issuer).href}"`,
          }).end();
          return;
        }
        const incoming = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
          .parse(JSON.parse(await readBody(request)));
        if (incoming.method === 'initialize') {
          return json(response, {
            jsonrpc: '2.0', id: incoming.id,
            result: { protocolVersion: '2025-11-25', serverInfo: { name: 'oauth-fixture', version: '1.0.0' }, capabilities: { tools: {} } },
          });
        }
        if (incoming.method === 'notifications/initialized') {
          response.writeHead(202).end();
          return;
        }
        if (incoming.method === 'tools/list') {
          return json(response, {
            jsonrpc: '2.0', id: incoming.id,
            result: { tools: [{
              name: 'inspect_oauth_resource',
              inputSchema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: { item: { type: 'string' } },
                required: ['item'],
                unevaluatedProperties: false,
              },
            }] },
          });
        }
      }
      response.writeHead(405).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  issuer = new URL('/', oauthServer).href;
  resource = new URL('/mcp', oauthServer).href;

  const started = await form('/connections', {
    name: 'oauth-widgets', url: resource, auth: 'oauth', issuer, token: '', ...registered,
  });
  assert.equal(started.status, 200);
  const page = await started.text();
  if (registered) assert.equal(page.includes(registered.clientSecret), false);
  const link = page.match(/href="([^"]+)">Continue to provider<\/a>/)?.[1];
  assert(link);
  const consent = new URL(link.replaceAll('&amp;', '&'));
  assert.equal(consent.href.startsWith(new URL('/authorize', issuer).href + '?'), true);
  assert.equal(consent.searchParams.get('client_id'), clientId);
  if (registered) assert.equal(consent.searchParams.get('scope'), registered.scope);
  assert.equal(registrations, registered ? 0 : 1);
  challenge = consent.searchParams.get('code_challenge') ?? '';
  assert.match(challenge, /^[a-zA-Z0-9_-]{43}$/);
  const callbackState = consent.searchParams.get('state');
  assert(callbackState);
  const callback = new URL('/oauth/callback', web);
  callback.searchParams.set('state', callbackState);
  callback.searchParams.set('code', code);

  const anonymous = await fetch(callback);
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  const wrongState = new URL(callback);
  wrongState.searchParams.set('state', 'not-the-consent-state');
  const wrongCallback = await fetch(wrongState, { headers: { cookie } });
  assert.equal(wrongCallback.status, 400);
  await wrongCallback.text();
  assert.equal(exchanges, 0);

  const accepted = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
  assert.equal(accepted.status, 303);
  await accepted.text();
  assert.equal(exchanges, 1);
  const dashboard = await fetch(web, { headers: { cookie } });
  const connected = await dashboard.text();
  assert.match(connected, /inspect_oauth_resource/);
  assert.equal(connected.includes(oauthToken), false);
  if (registered) assert.equal(connected.includes(registered.clientSecret), false);

  const connectionPath = connected.match(/\/connections\/[^/"\s]+\/tools/)?.[0];
  assert(connectionPath);
  const enabled = await form(connectionPath, { tool: 'inspect_oauth_resource', enabled: 'true' });
  assert.equal(enabled.status, 303);
  await enabled.text();

  const { client } = await addAgent('oauth-agent', oauthToken);
  const action = { connection: 'oauth-widgets', tool: 'inspect_oauth_resource' };
  const valid = await call(client, 'request_action', { ...action, args: { item: '17' } });
  assert.equal(valid.isError, false, valid.body);
  assert.equal(actionState.parse(JSON.parse(valid.body)).status, 'pending');
  const invalid = await call(client, 'request_action', { ...action, args: { item: '17', extra: true } });
  assert.equal(invalid.isError, true);

  const replay = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
  assert.equal(replay.status, 400);
  await replay.text();
  assert.equal(exchanges, 1);
  const persisted = Buffer.concat(await Promise.all(
    (await readdir(directory)).map(name => readFile(join(directory, name))),
  ));
  assert.equal(persisted.includes(oauthToken), false);
  if (registered) assert.equal(persisted.includes(registered.clientSecret), false);
}

test('dynamic OAuth requires single-use state and validates draft 2020-12 arguments',
  { timeout: 30_000 }, context => verifyOAuthConnection(context));

test('pre-registered OAuth uses saved client credentials without dynamic registration',
  { timeout: 30_000 }, context => verifyOAuthConnection(context, {
    clientId: 'fixture-existing-client',
    clientSecret: 'fixture-existing-client-secret-123456',
    scope: 'offline_access',
  }));

test('an approved command runs once in the sandbox with only the secrets it named', { timeout: 30_000 }, async (context) => {
  const ghToken = 'fixture-gh-token-AbC0987654321';
  const otherToken = 'fixture-other-token-XyZ1234567890';
  const runs: { command: string; env: Record<string, string> }[] = [];
  const sandbox: SandboxRun = async ({ command, env }) => {
    runs.push({ command, env });
    if (command === 'missing-image') throw new NotStarted('no image');
    if (command === 'hang') throw new Error('timed out');
    if (command === 'leak') return { exitCode: 0, output: 'token=' + Buffer.from(ghToken).toString('base64') };
    if (command === 'long') return { exitCode: 0, output: 'x'.repeat(20_000) };
    return { exitCode: 3, output: 'two open pull requests\n' };
  };
  const { web, cookie, form, addAgent } = await openConsole(context, sandbox);
  const { client } = await addAgent('builder', ghToken);
  const outsider = (await addAgent('outsider', ghToken)).client;

  assert.equal((await form('/secrets', { name: 'GH_TOKEN', value: ghToken })).status, 303);
  assert.equal((await form('/secrets', { name: 'OTHER_TOKEN', value: otherToken })).status, 303);
  for (const name of ['SANI_ENCRYPTION_KEY', 'DOCKER_HOST', 'PATH', 'lower']) {
    assert.equal((await form('/secrets', { name, value: otherToken })).status, 400, name);
  }

  const listed = await call(client, 'list_actions');
  assert.deepEqual(JSON.parse(listed.body).sandbox, { secrets: ['GH_TOKEN', 'OTHER_TOKEN'] });
  assert.equal(listed.body.includes(ghToken), false);

  async function request(command: string, secrets: string[] = ['GH_TOKEN']) {
    const reply = await call(client, 'request_command', { command, secrets });
    assert.equal(reply.isError, false, reply.body);
    return actionState.parse(JSON.parse(reply.body));
  }
  const approve = async (id: string) => assert.equal((await form(`/requests/${id}/approve`)).status, 303);

  assert.equal((await call(client, 'request_command', { command: 'gh pr list', secrets: ['ABSENT'] })).isError, true);
  assert.equal((await call(client, 'request_command', { command: `echo ${ghToken}`, secrets: [] })).isError, true);

  const pending = await request('gh pr list --repo "acme/site"');
  assert.equal(pending.approvalUrl, `${web}/requests/${pending.id}`);
  assert.equal(runs.length, 0, 'nothing runs before approval');
  assert.equal((await call(outsider, 'get_request', { id: pending.id })).isError, true);
  const page = await (await fetch(pending.approvalUrl, { headers: { cookie } })).text();
  assert.match(page, /gh pr list --repo &quot;acme\/site&quot;/);
  assert.match(page, /<code>GH_TOKEN<\/code>/);
  assert.equal(page.includes(ghToken), false);

  await approve(pending.id);
  await approve(pending.id);
  assert.deepEqual(runs, [{ command: 'gh pr list --repo "acme/site"', env: { GH_TOKEN: ghToken } }]);
  assert.deepEqual((await state(client, pending.id)).result,
    { exitCode: 3, output: 'two open pull requests\n', truncated: false });

  const leaked = await request('leak');
  await approve(leaked.id);
  const withheld = await state(client, leaked.id);
  assert.equal(withheld.status, 'failed');
  assert.equal(withheld.result, undefined);

  const long = await request('long');
  await approve(long.id);
  const cut = z.object({ output: z.string(), truncated: z.boolean() }).parse((await state(client, long.id)).result);
  assert.equal(cut.output.length, 16 * 1024);
  assert.equal(cut.truncated, true);

  const unstarted = await request('missing-image');
  await approve(unstarted.id);
  assert.equal((await state(client, unstarted.id)).status, 'failed');
  const hung = await request('hang');
  await approve(hung.id);
  assert.equal((await state(client, hung.id)).status, 'unknown');

  const stale = await request('gh pr list');
  assert.equal((await form('/secrets', { name: 'GH_TOKEN', value: 'fixture-gh-token-rotated-000000' })).status, 303);
  const before = runs.length;
  await approve(stale.id);
  assert.equal((await state(client, stale.id)).status, 'failed');
  assert.equal(runs.length, before, 'replacing a secret invalidates the requests waiting on it');

  assert.equal((await form('/secrets/OTHER_TOKEN/delete')).status, 303);
  assert.deepEqual(JSON.parse((await call(client, 'list_actions')).body).sandbox, { secrets: ['GH_TOKEN'] });
});

test('command requests do not exist while the sandbox is off', async (context) => {
  const { web, cookie, addAgent } = await openConsole(context);
  const fresh = await (await fetch(new URL('/?connect=linear', web), { headers: { cookie } })).text();
  assert.match(fresh, /Get started/);
  assert.match(fresh, /name="url"[^>]* value="https:\/\/mcp\.linear\.app\/mcp\/readonly"/);
  assert.match(fresh, /<option value="oauth" selected>/);
  const { client } = await addAgent('builder', 'unused-credential-canary');
  assert.equal('sandbox' in JSON.parse((await call(client, 'list_actions')).body), false);
  assert.equal((await client.listTools()).tools.some(tool => tool.name === 'request_command'), false);
});
