import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv } from 'ajv';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertScreened, displayName, fingerprint, record, token } from './guard.ts';
import { handleMcp, type McpApp } from './mcp.ts';
import { normalizeRemoteUrl, Remote, type Auth } from './remote.ts';
import { Store, type Connection, type Request } from './store.ts';
import { handleWeb, type Approval, type WebApp } from './web.ts';

export type AppOptions = {
  dbPath: string;
  encryptionKey: Buffer;
  adminPassword: string;
  publicOrigin: string;
  allowInsecureLoopback?: boolean;
};

function credentials(auth: Auth): string[] {
  if (auth.kind === 'bearer') return [auth.token];
  const { tokens, clientInformation, verifier } = auth.state;
  return [
    tokens?.access_token, tokens?.refresh_token, tokens?.id_token,
    clientInformation && 'client_secret' in clientInformation ? clientInformation.client_secret : undefined,
    verifier,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function screenedResult(result: CallToolResult, secrets: string[]): unknown {
  assertScreened(result, secrets);
  if (result.isError) throw new Error('The platform reported an error.');
  const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []);
  assertScreened(text.join(''), secrets);
  return {
    ...(result.structuredContent ? { data: result.structuredContent } : {}),
    text,
  };
}

const schemaValidator = new Ajv({ strict: false, validateFormats: false, addUsedSchema: false });
function canUseArgs(schema: Record<string, unknown>, args: Record<string, unknown>): boolean {
  const check = schemaValidator.compile(schema);
  try {
    return check(args);
  } finally {
    schemaValidator.removeSchema(schema);
  }
}

export function createApp(options: AppOptions): {handle: (req: IncomingMessage, res: ServerResponse) => void; close: () => void} {
  const origin = new URL(options.publicOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.href !== origin.origin + '/' || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) {
    throw new Error('Sani needs an HTTPS public origin, or HTTP on loopback.');
  }
  if (options.adminPassword.length < 16) throw new Error('Set an operator password of at least 16 characters.');

  const publicOrigin = origin.origin;
  const store = new Store(options.dbPath, options.encryptionKey);
  const busy = new Map<string, Promise<void>>();
  const storedSecrets = (): string[] => store.connections().flatMap(connection => credentials(connection.auth));

  function requireConnection(id: string): Connection {
    const connection = store.connection(id);
    if (!connection) throw new Error('The connection is unavailable.');
    return connection;
  }

  function remote(connection: Connection): Remote {
    return new Remote({
      url: connection.url,
      auth: connection.auth,
      callbackUrl: new URL('/oauth/callback', publicOrigin).href,
      allowInsecureLoopback: options.allowInsecureLoopback,
      saveOAuth: state => {
        if (connection.auth.kind !== 'oauth') throw new Error('The connection did not use OAuth.');
        store.saveAuth(connection, { ...connection.auth, state });
      },
    });
  }

  async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (busy.get(id) ?? Promise.resolve()).then(work);
    const done = next.then(() => {}, () => {});
    busy.set(id, done);
    try {
      return await next;
    } finally {
      if (busy.get(id) === done) busy.delete(id);
    }
  }

  async function refresh(connection: Connection): Promise<void> {
    const discovered = await remote(connection).discover();
    const current = requireConnection(connection.id);
    const secrets = [...credentials(connection.auth), ...credentials(current.auth), ...storedSecrets()];
    const tools = discovered.map(tool => {
      assertScreened(tool, secrets);
      const schema = record(tool.inputSchema);
      return { name: tool.name, schema, fingerprint: fingerprint(tool) };
    });
    store.setTools(connection.id, connection.revision, tools);
  }

  function startOAuth(id: string): Promise<string> {
    return exclusive(id, async () => {
      const connection = requireConnection(id);
      if (connection.auth.kind !== 'oauth') throw new Error('This connection uses a bearer token.');
      const { issuer, scope, state: saved } = connection.auth;
      store.changeAuth(connection, {
        kind: 'oauth', issuer, scope, state: { clientInformation: saved.clientInformation },
      });
      const updated = requireConnection(id);
      const state = randomBytes(32).toString('base64url');
      store.saveOAuthFlow(updated, state);
      return await remote(updated).startOAuth(state);
    });
  }

  function approval(request: Request): Approval {
    const { id, agentName, connectionName, tool, createdAt, expiresAt } = request;
    let { args, result, status } = request;
    const secrets = storedSecrets();
    try {
      assertScreened(args, secrets);
    } catch {
      args = {};
      if (status === 'pending' && store.claim(id, 'declined')) status = 'declined';
    }
    if (result !== undefined) {
      try { assertScreened(result, secrets); } catch { result = undefined; }
    }
    return {
      id, agentName, connectionName, tool, args, status, createdAt, expiresAt, result,
      connectionUrl: store.connection(request.connectionId)?.url,
    };
  }

  function currentRequestConnection(request: Request, requireUnexpired = true): Connection {
    const connection = requireConnection(request.connectionId);
    const tool = store.tools(connection.id).find(candidate => candidate.name === request.tool);
    if (!store.agentExists(request.agentId) || !connection.connected || connection.revision !== request.revision ||
      (requireUnexpired && request.expiresAt <= Date.now()) || !tool?.enabled || tool.fingerprint !== request.toolFingerprint) {
      throw new Error('This request no longer matches an enabled action.');
    }
    return connection;
  }

  async function decide(id: string, approve: boolean): Promise<Approval> {
    const request = store.request(id);
    if (!request) throw new Error('The request is unavailable.');
    if (request.status !== 'pending' || !store.claim(id, approve ? 'running' : 'declined')) {
      return approval(store.request(id) ?? request);
    }
    if (approve) await exclusive(request.connectionId, async () => {
      let sent = false;
      try {
        const connection = currentRequestConnection(request);
        const dispatchSecrets = new Set([...credentials(connection.auth), ...storedSecrets()]);
        const reply = await remote(connection).call(request.tool, request.args, (discovered: Tool[]) => {
          const current = currentRequestConnection(request);
          const definition = discovered.find(candidate => candidate.name === request.tool);
          if (!definition || fingerprint(definition) !== request.toolFingerprint) {
            throw new Error('The platform changed the tool. Refresh and enable it again.');
          }
          for (const secret of credentials(current.auth)) dispatchSecrets.add(secret);
          assertScreened(request.args, [...dispatchSecrets, ...storedSecrets()]);
          sent = true;
        });
        const current = currentRequestConnection(request, false);
        try {
          const secrets = [...dispatchSecrets, ...credentials(current.auth), ...storedSecrets()];
          store.finish(id, 'succeeded', screenedResult(reply, secrets));
        } catch {
          store.finish(id, 'failed');
        }
      } catch {
        store.finish(id, sent ? 'unknown' : 'failed');
      }
    });
    return approval(store.request(id) ?? request);
  }

  const service: WebApp & McpApp = {
    publicOrigin,
    adminPassword: options.adminPassword,
    sessionKey: createHmac('sha256', options.encryptionKey).update('sani operator session\0').update(options.adminPassword).digest(),
    listConnections: () => store.connections().map(connection => ({
      id: connection.id, name: connection.name, url: connection.url, auth: connection.auth.kind,
      connected: connection.connected, tools: store.tools(connection.id).map(({ name, enabled }) => ({ name, enabled })),
    })),
    async createConnection(input) {
      const name = displayName(input.name);
      const url = normalizeRemoteUrl(input.url, options.allowInsecureLoopback);
      const auth: Auth = input.auth === 'bearer'
        ? { kind: 'bearer', token: token(input.token) }
        : { kind: 'oauth', issuer: normalizeRemoteUrl(input.issuer, options.allowInsecureLoopback), state: {} };
      assertScreened({ name, url }, credentials(auth));
      const id = store.createConnection(name, url, auth);
      if (auth.kind === 'oauth') return { id, authorizationUrl: await startOAuth(id) };
      await exclusive(id, () => refresh(requireConnection(id)));
      return { id };
    },
    refreshConnection: id => exclusive(id, () => refresh(requireConnection(id))),
    enableTool(id, tool, enabled) {
      const connection = requireConnection(id);
      if (!connection.connected) throw new Error('Connect and discover the platform tools first.');
      store.enableTool(id, tool, enabled);
    },
    deleteConnection: id => store.deleteConnection(id),
    rotateToken(id, raw) {
      const connection = requireConnection(id);
      if (connection.auth.kind !== 'bearer') throw new Error('This connection uses OAuth.');
      const next = token(raw);
      assertScreened({ name: connection.name, url: connection.url, tools: store.tools(id) }, [next]);
      store.changeAuth(connection, { kind: 'bearer', token: next });
    },
    startOAuth,
    async finishOAuth(state, code) {
      const connection = store.consumeOAuthFlow(state);
      if (!connection) throw new Error('This sign-in request has expired or already been used.');
      await exclusive(connection.id, async () => {
        const current = requireConnection(connection.id);
        if (current.revision !== connection.revision) throw new Error('The connection changed.');
        await remote(current).finishOAuth(code);
        await refresh(requireConnection(current.id));
      });
    },
    listRequests: () => store.requests().map(approval),
    getRequest(id) {
      const result = store.request(id);
      return result && approval(result);
    },
    decide,
    createAgent: name => store.createAgent(displayName(name)),
    listAgents: () => store.agents(),
    revokeAgent: id => store.revokeAgent(id),
    authenticateAgent: raw => /^sani_[A-Za-z0-9_-]{43}$/.test(raw) ? store.agentByToken(raw) : undefined,
    listAgentTools() {
      const secrets = storedSecrets();
      return store.connections().flatMap(connection => connection.connected
        ? store.tools(connection.id).filter(tool => tool.enabled).flatMap(tool => {
          const action = { connection: connection.name, tool: tool.name, inputSchema: tool.schema };
          try { assertScreened(action, secrets); } catch { return []; }
          return [action];
        }) : []);
    },
    requestAction(agentId, input) {
      const agent = store.agents().find(candidate => candidate.id === agentId);
      const connection = store.connectionByName(input.connection);
      const tool = connection && store.tools(connection.id).find(candidate => candidate.name === input.tool);
      if (!agent || !connection?.connected || !tool?.enabled) throw new Error('The action is unavailable.');
      assertScreened(input.args, storedSecrets());
      if (!canUseArgs(tool.schema, input.args)) throw new Error('The arguments do not match the tool schema.');
      const id = store.addRequest(agent, connection, tool, input.args);
      return { id, status: 'pending', approvalUrl: new URL('/requests/' + id, publicOrigin).href };
    },
    requestResult(agentId, id) {
      const request = store.request(id);
      if (request?.agentId !== agentId) return;
      const { status, result } = request;
      if (result !== undefined) {
        try { assertScreened(result, storedSecrets()); } catch { return { id, status: 'failed' }; }
      }
      return { id, status, result };
    },
  };

  return {
    handle(req, res) {
      void (async () => {
        const url = new URL(req.url ?? '/', publicOrigin);
        if (url.origin !== publicOrigin) {
          res.writeHead(400).end('Invalid request.');
        } else if (url.pathname === '/mcp') {
          await handleMcp(req, res, service);
        } else {
          await handleWeb(req, res, url, service);
        }
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store', 'content-type': 'text/plain' });
        res.end('Sani could not complete the request.');
      });
    },
    close: () => store.close(),
  };
}
