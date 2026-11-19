import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp } from '../src/app.ts';
import { callDemo, demoEnabled, ensureDemoConnection, isDemoConnection, DEMO_URL } from '../src/demo.ts';
import { Store } from '../src/store.ts';

describe('demo mode', { concurrency: false }, () => {
  test('demo mode is off unless it is set to 1 or true', () => {
    assert.equal(demoEnabled(undefined), false);
    assert.equal(demoEnabled(''), false);
    assert.equal(demoEnabled('0'), false);
    assert.equal(demoEnabled('false'), false);
    assert.equal(demoEnabled('1'), true);
    assert.equal(demoEnabled('true'), true);
    assert.throws(() => demoEnabled('yes'), /SANI_DEMO/);
  });

  test('the demo module does not reach the network, filesystem, or a shell', async () => {
    const source = await readFile(new URL('../src/demo.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:(fs|net|http|child_process|dns)|from 'undici'|fetch\(/);
    const reply = callDemo('lookup_ticket', { id: '1001' });
    assert.equal(reply.isError, undefined);
    assert.equal(reply.structuredContent?.id, '1001');
    assert.match(String(reply.content[0] && 'text' in reply.content[0] ? reply.content[0].text : ''), /Welcome to Sani/);
    assert.equal(callDemo('lookup_ticket', { id: 'nope' }).isError, true);
  });

  test('installing the demo does not replace a real connection of the same name', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'sani-demo-store-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const store = new Store(join(directory, 'sani.sqlite'), randomBytes(32));
    context.after(() => store.close());
    store.createConnection('demo', 'https://example.com/mcp', { kind: 'bearer', token: 'real-token-value' });
    ensureDemoConnection(store);
    const connection = store.connectionByName('demo');
    assert.equal(connection?.url, 'https://example.com/mcp');
    assert.equal(connection !== undefined && isDemoConnection(connection), false);
    assert.equal(store.tools(connection?.id ?? '').some(tool => tool.name === 'lookup_ticket'), false);
  });

  test('an operator can approve a demo call without Sani contacting another system', async (context) => {
    const preview = callDemo('lookup_ticket', { id: '1001' });
    const detail = preview.structuredContent?.detail;
    assert.equal(typeof detail, 'string');
    assert.equal(String(detail).length >= 8, true);

    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return original(input, init);
    }) as typeof fetch;
    context.after(() => {
      globalThis.fetch = original;
    });

    const { web, form, addAgent, directory } = await openConsole(context, true);
    const home = await fetch(web);
    assert.match(await home.text(), /Demo mode/);

    const signedIn = await fetch(web, { headers: { cookie: (await loginCookie(web)) } });
    const consoleHtml = await signedIn.text();
    assert.match(consoleHtml, /Built-in demo/);
    assert.match(consoleHtml, /lookup_ticket/);
    assert.match(consoleHtml, /cannot reach other systems/);
    assert.equal(consoleHtml.includes(DEMO_URL), false);
    assert.equal(consoleHtml.includes('Replace token'), false);

    const { client, token } = await addAgent('demo-agent');
    const listed = await call(client, 'list_actions');
    assert.equal(listed.isError, false);
    assert.match(listed.body, /lookup_ticket/);
    assert.match(listed.body, /"connection":"demo"/);

    const rejected = await call(client, 'request_action', {
      connection: 'demo', tool: 'lookup_ticket', args: { id: '9999' },
    });
    assert.equal(rejected.isError, true);

    seen.length = 0;
    const requested = await call(client, 'request_action', {
      connection: 'demo', tool: 'lookup_ticket', args: { id: '1001' },
    });
    assert.equal(requested.isError, false, requested.body);
    const pending = JSON.parse(requested.body) as { id: string; status: string; approvalUrl: string };
    assert.equal(pending.status, 'pending');
    assert.ok(seen.every(url => url.startsWith(web)), seen.join('\n'));

    const echoed = await call(client, 'request_action', {
      connection: 'demo', tool: 'echo', args: { message: 'hello from the demo' },
    });
    const echoId = (JSON.parse(echoed.body) as { id: string }).id;

    const page = await fetch(pending.approvalUrl, { headers: { cookie: await loginCookie(web) } });
    const approvalHtml = await page.text();
    assert.match(approvalHtml, /Demo request/);
    assert.match(approvalHtml, /stays inside Sani/);
    assert.match(approvalHtml, /1001/);
    assert.equal(approvalHtml.includes(DEMO_URL), false);
    assert.ok(seen.every(url => url.startsWith(web)), seen.join('\n'));

    assert.equal((await form(`/requests/${pending.id}/approve`)).status, 303);
    assert.equal((await form(`/requests/${echoId}/approve`)).status, 303);
    assert.ok(seen.every(url => url.startsWith(web)), seen.join('\n'));

    const completed = JSON.parse((await call(client, 'get_request', { id: pending.id })).body) as {
      status: string;
      result?: { text?: string[]; data?: { title?: string } };
    };
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.result?.data?.title, 'Welcome to Sani');
    assert.match(completed.result?.text?.join('') ?? '', /does not contact another system/);
    const echo = JSON.parse((await call(client, 'get_request', { id: echoId })).body) as { status: string; result?: { text?: string[] } };
    assert.equal(echo.status, 'succeeded');
    assert.deepEqual(echo.result?.text, ['hello from the demo']);

    const screened = await call(client, 'request_action', {
      connection: 'demo', tool: 'lookup_ticket', args: { id: '1001' },
    });
    const screenedId = (JSON.parse(screened.body) as { id: string }).id;
    assert.equal((await form('/secrets', { name: 'DEMO_CANARY', value: String(detail) })).status, 303);
    assert.equal((await form(`/requests/${screenedId}/approve`)).status, 303);
    const withheld = JSON.parse((await call(client, 'get_request', { id: screenedId })).body) as { status: string; result?: unknown };
    assert.equal(withheld.status, 'failed');
    assert.equal(withheld.result, undefined);
    const withheldPage = await (await fetch(new URL(`/requests/${screenedId}`, web), { headers: { cookie: await loginCookie(web) } })).text();
    assert.equal(withheldPage.includes(String(detail)), false);

    const bogus = await form('/connections', {
      name: 'not-demo', url: DEMO_URL, auth: 'bearer', token: 'not-a-real-token', issuer: '',
    });
    assert.equal(bogus.status, 400);

    const rotate = consoleHtml.match(/\/connections\/[^/"\s]+\/tools/)?.[0]?.replace(/tools$/, 'rotate');
    assert.equal(rotate !== undefined, true);
    assert.equal((await form(rotate ?? '', { token: 'replacement-token-12345678' })).status, 400);

    const { client: raw } = await addAgent('curl-agent');
    assert.equal(token.startsWith('sani_'), true);
    const direct = await raw.callTool({
      name: 'request_action',
      arguments: { connection: 'demo', tool: 'echo', args: { message: 'direct' } },
    });
    assert.equal(direct.isError, undefined);

    const names = await readdir(directory);
    const persisted = Buffer.concat(await Promise.all(names.map(name => readFile(join(directory, name)))));
    assert.equal(persisted.includes(token), false);
    assert.equal(persisted.includes('real-platform-token'), false);
  });

  test('demo mode off removes a previously installed demo connection', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'sani-demo-off-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, 'sani.sqlite');
    const encryptionKey = randomBytes(32);
    const password = 'fixture-operator-password';
    const first = createApp({
      dbPath, encryptionKey, adminPassword: password, publicOrigin: 'http://127.0.0.1:9', demo: true,
    });
    first.close();
    const installed = new Store(dbPath, encryptionKey);
    const demo = installed.connectionByName('demo');
    assert.equal(demo !== undefined && isDemoConnection(demo), true);
    assert.equal(installed.tools(demo?.id ?? '').some(tool => tool.name === 'lookup_ticket' && tool.enabled), true);
    installed.enableTool(demo?.id ?? '', 'echo', false);
    installed.close();
    const again = createApp({
      dbPath, encryptionKey, adminPassword: password, publicOrigin: 'http://127.0.0.1:9', demo: true,
    });
    again.close();
    const kept = new Store(dbPath, encryptionKey);
    const still = kept.connectionByName('demo');
    assert.equal(kept.tools(still?.id ?? '').find(tool => tool.name === 'echo')?.enabled, false);
    assert.equal(kept.tools(still?.id ?? '').find(tool => tool.name === 'lookup_ticket')?.enabled, true);
    kept.close();
    const second = createApp({
      dbPath, encryptionKey, adminPassword: password, publicOrigin: 'http://127.0.0.1:9',
    });
    second.close();
    const store = new Store(dbPath, encryptionKey);
    context.after(() => store.close());
    assert.equal(store.connectionByName('demo'), undefined);
  });

  test('the try-demo script requests a ticket and waits for approval', async (context) => {
    const { web, form, addAgent } = await openConsole(context, true);
    const { token } = await addAgent('script-agent');
    const child = spawn('sh', ['scripts/try-demo.sh'], {
      env: { ...process.env, SANI_URL: web, SANI_AGENT_KEY: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let exitCode: number | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        exitCode = code;
        resolve(code);
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    const approval = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(errorOutput || output || 'script produced no approval URL')), 15_000);
      const watch = () => {
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/requests\/[\w-]+/);
        if (!match?.[0]) return;
        clearTimeout(timer);
        resolve(match[0]);
      };
      watch();
      child.stdout?.on('data', watch);
      void exited.then(() => {
        clearTimeout(timer);
        reject(new Error(errorOutput || output));
      });
    });
    const id = approval.slice(approval.lastIndexOf('/') + 1);
    assert.equal((await form(`/requests/${id}/approve`)).status, 303);
    const code = exitCode ?? await exited;
    assert.equal(code, 0, errorOutput || output);
    assert.match(output, /Welcome to Sani/);
  });
});

async function listen(context: { after: (fn: () => unknown) => void }, handle: RequestListener): Promise<string> {
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

async function openConsole(context: { after: (fn: () => unknown) => void }, demo: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'sani-demo-app-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const adminPassword = 'fixture-operator-password';
  let handle: RequestListener = (_request, response) => response.writeHead(503).end();
  const web = await listen(context, (request, response) => handle(request, response));
  const app = createApp({
    dbPath: join(directory, 'sani.sqlite'),
    encryptionKey: randomBytes(32),
    adminPassword,
    publicOrigin: web,
    allowInsecureLoopback: true,
    demo,
  });
  handle = app.handle;
  context.after(() => app.close());
  let cookie = '';
  async function form(path: string, fields: Record<string, string> = {}) {
    const response = await fetch(new URL(path, web), {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: web, cookie },
      body: new URLSearchParams(fields),
    });
    await response.text();
    return response;
  }
  const login = await form('/login', { password: adminPassword });
  assert.equal(login.status, 303);
  cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  async function addAgent(name: string) {
    const added = await fetch(new URL('/agents', web), {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: web, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name }),
    });
    const body = await added.text();
    const token = body.match(/<span class="l">(sani_[a-zA-Z0-9_-]{43})<\/span>/)?.[1];
    assert(token);
    const client = new Client({ name: 'sani-demo-test', version: '1.0.0' });
    context.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', web), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return { token, client };
  }
  return { directory, web, form, addAgent };
}

async function loginCookie(web: string): Promise<string> {
  const login = await fetch(new URL('/login', web), {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: web, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'fixture-operator-password' }),
  });
  await login.arrayBuffer();
  return login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  let body = '';
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === 'text' && 'text' in item && typeof item.text === 'string') {
        body = item.text;
        break;
      }
    }
  }
  return { body, isError: result.isError === true };
}
