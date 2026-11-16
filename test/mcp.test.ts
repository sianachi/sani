import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp, type McpApp } from '../src/mcp.ts';

test('MCP requires a current agent key and returns scoped requests without leaking service errors', async (t) => {
  const key = 'sani-test-key';
  let active = true;
  const app: McpApp = {
    authenticateAgent: (token) => active && token === key ? { id: 'agent-1', name: 'Test' } : undefined,
    listAgentTools: (agentId) => {
      assert.equal(agentId, 'agent-1');
      return [{ connection: 'billing', tool: 'get_invoice', inputSchema: { type: 'object' } }];
    },
    requestAction: (agentId, input) => {
      assert.equal(agentId, 'agent-1');
      if (input.connection !== 'billing') throw new Error('provider credential canary');
      assert.deepEqual(input, { connection: 'billing', tool: 'get_invoice', args: { invoice: '123' } });
      return { id: 'request-1', status: 'pending', approvalUrl: 'https://sani.example/requests/request-1' };
    },
    requestResult: (agentId, id) => agentId === 'agent-1' && id === 'request-1'
      ? { id, status: 'succeeded', result: { paid: true } }
      : undefined,
  };

  const server = createServer((req, res) => { void handleMcp(req, res, app); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const unauthorized = await fetch(url, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer realm="sani"');
  await unauthorized.text();

  const headers = { authorization: `Bearer ${key}` };
  const wrongOrigin = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'http://untrusted.example' } });
  assert.equal(wrongOrigin.status, 403);
  await wrongOrigin.text();
  const tooLarge = await fetch(url, {
    method: 'POST',
    headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify('x'.repeat(65_536)),
  });
  assert.equal(tooLarge.status, 413);
  await tooLarge.text();

  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [
    'list_actions', 'request_action', 'get_request',
  ]);
  const actions = await client.callTool({ name: 'list_actions' });
  assert.deepEqual(actions.structuredContent, {
    actions: [{ connection: 'billing', tool: 'get_invoice', inputSchema: { type: 'object' } }],
  });
  const submitted = await client.callTool({
    name: 'request_action',
    arguments: { connection: 'billing', tool: 'get_invoice', args: { invoice: '123' } },
  });
  assert.deepEqual(submitted.structuredContent, {
    id: 'request-1', status: 'pending', approvalUrl: 'https://sani.example/requests/request-1',
  });
  const result = await client.callTool({ name: 'get_request', arguments: { id: 'request-1' } });
  assert.deepEqual(result.structuredContent, { id: 'request-1', status: 'succeeded', result: { paid: true } });
  const missing = await client.callTool({ name: 'get_request', arguments: { id: 'foreign-request' } });
  assert.equal(missing.isError, true);

  const rejected = await client.callTool({
    name: 'request_action', arguments: { connection: 'other', tool: 'get_invoice', args: {} },
  });
  assert.equal(rejected.isError, true);
  assert.doesNotMatch(JSON.stringify(rejected), /provider credential canary|sani-test-key/);

  active = false;
  await assert.rejects(client.listTools(), /A Sani agent key is required/);
});
