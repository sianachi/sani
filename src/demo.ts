import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fingerprint } from './guard.ts';
import type { Auth } from './remote.ts';
import type { Store } from './store.ts';

/**
 * Built-in demo connection. This module has no filesystem, network, or process access.
 * Tool calls return fixed sample data and cannot reach another system.
 */
export const DEMO_NAME = 'demo';
/** Not a URL. Remote URL checks reject it, so it cannot be fetched. */
export const DEMO_URL = 'builtin:demo';

const lookupSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', enum: ['1001', '1002', '1003'] },
  },
  required: ['id'],
};

const echoSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['message'],
};

const DEMO_TOOLS: { name: string; schema: Record<string, unknown> }[] = [
  { name: 'lookup_ticket', schema: lookupSchema },
  { name: 'echo', schema: echoSchema },
];

const tickets: Record<string, { id: string; title: string; state: string; detail: string }> = {
  '1001': {
    id: '1001',
    title: 'Welcome to Sani',
    state: 'open',
    detail: 'Demo data only. Approving this request does not contact another system.',
  },
  '1002': {
    id: '1002',
    title: 'Demo tickets stay inside Sani',
    state: 'open',
    detail: 'This record was produced in-process. It is not from a connected platform.',
  },
  '1003': {
    id: '1003',
    title: 'Nothing here is a real credential',
    state: 'closed',
    detail: 'The demo connection stores no token and cannot call out.',
  },
};

export function demoEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error('Set SANI_DEMO to 1 to enable the built-in demo, or leave it unset.');
}

export function isDemoConnection(connection: { url: string; auth: Auth }): boolean {
  return connection.url === DEMO_URL && connection.auth.kind === 'demo';
}

export function callDemo(tool: string, args: Record<string, unknown>): CallToolResult {
  if (tool === 'lookup_ticket') {
    const ticket = typeof args.id === 'string' ? tickets[args.id] : undefined;
    if (!ticket) return { isError: true, content: [{ type: 'text', text: 'Unknown demo ticket.' }] };
    const text = `${ticket.id}: ${ticket.title} (${ticket.state}). ${ticket.detail}`;
    return { content: [{ type: 'text', text }], structuredContent: ticket };
  }
  if (tool === 'echo' && typeof args.message === 'string' && args.message.length > 0 && args.message.length <= 200) {
    return { content: [{ type: 'text', text: args.message }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'Unknown demo tool.' }] };
}

/** Install the demo connection, or refresh its tools, without contacting a network. */
export function ensureDemoConnection(store: Store): void {
  const existing = store.connectionByName(DEMO_NAME);
  if (existing && !isDemoConnection(existing)) return;
  const created = existing ?? store.connection(store.createConnection(DEMO_NAME, DEMO_URL, { kind: 'demo' }));
  if (!created) throw new Error('Could not install the demo connection.');
  const previous = new Set(store.tools(created.id).map(tool => tool.name));
  store.setTools(created.id, created.revision, DEMO_TOOLS.map(tool => ({
    name: tool.name,
    schema: tool.schema,
    fingerprint: fingerprint({ name: tool.name, inputSchema: tool.schema }),
  })));
  for (const tool of DEMO_TOOLS) {
    if (!previous.has(tool.name)) store.enableTool(created.id, tool.name, true);
  }
}

export function removeDemoConnection(store: Store): void {
  for (const connection of store.connections()) {
    if (isDemoConnection(connection)) store.deleteConnection(connection.id);
  }
}
