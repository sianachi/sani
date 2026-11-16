import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import manifest from '../package.json' with { type: 'json' };

export interface McpApp {
  publicOrigin?: string;
  authenticateAgent(raw: string): { id: string; name: string } | undefined;
  listAgentTools(agentId: string): { connection: string; tool: string; inputSchema: unknown }[];
  requestAction(
    agentId: string,
    input: { connection: string; tool: string; args: Record<string, unknown> },
  ): { id: string; status: string; approvalUrl: string };
  requestResult(agentId: string, id: string): { id: string; status: string; result?: unknown } | undefined;
}

const identifier = z.string().min(1).max(256);

function toolReply(read: () => Record<string, unknown> | undefined, failure: string): CallToolResult {
  try {
    const result = read();
    if (result !== undefined) {
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  } catch {
    // Provider and persistence errors can contain credentials or submitted arguments.
  }
  return { isError: true, content: [{ type: 'text', text: failure }] };
}

function serverFor(app: McpApp, agentId: string): McpServer {
  const server = new McpServer({ name: 'sani', version: manifest.version });
  server.registerTool('list_actions', {
    description: 'List enabled actions and their argument schemas on connected platforms.',
    annotations: { readOnlyHint: true },
  }, () => toolReply(() => ({
    actions: app.listAgentTools(agentId).map(({ connection, tool, inputSchema }) => ({
      connection, tool, inputSchema,
    })),
  }), 'Could not list Sani actions.'));

  server.registerTool('request_action', {
    description: 'Request an enabled platform action and return the Sani approval link. A human must approve before the action runs.',
    inputSchema: { connection: identifier, tool: identifier, args: z.record(z.string(), z.unknown()) },
    annotations: { destructiveHint: false },
  }, (input) => toolReply(() => {
    const { id, status, approvalUrl } = app.requestAction(agentId, input);
    return { id, status, approvalUrl };
  }, 'Sani refused this action request. Check the enabled action and its argument schema.'));

  server.registerTool('get_request', {
    description: 'Read the status and permitted result of your Sani action request.',
    inputSchema: { id: identifier },
    annotations: { readOnlyHint: true },
  }, ({ id }) => toolReply(() => {
    const request = app.requestResult(agentId, id);
    if (request === undefined) return undefined;
    return { id: request.id, status: request.status, result: request.result };
  }, 'Sani request unavailable.'));
  return server;
}

function httpError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, app: McpApp): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin !== undefined && req.headers.origin !== app.publicOrigin) {
    httpError(res, 403, 'Origin refused.');
    return;
  }

  let server: McpServer | undefined;
  try {
    const bearer = /^Bearer ([^\s,]{1,256})$/i.exec(req.headers.authorization ?? '')?.[1];
    const agent = bearer && app.authenticateAgent(bearer);
    if (!agent) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="sani"');
      httpError(res, 401, 'A Sani agent key is required.');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      httpError(res, 405, 'This endpoint accepts POST.');
      return;
    }

    server = serverFor(app, agent.id);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 64 * 1024 });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) httpError(res, 500, 'Sani could not process the MCP request.');
    else if (!res.writableEnded) res.end();
  } finally {
    await server?.close().catch(() => {});
  }
}
