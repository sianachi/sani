import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { digest, record, seal, unseal } from './guard.ts';
import type { Auth } from './remote.ts';

type Row = Record<string, SQLOutputValue>;
const REQUEST_TTL = 15 * 60 * 1000;
const connectionContext = (id: string, revision: number, url: string): string => JSON.stringify([id, revision, url]);

export type Connection = {
  id: string;
  name: string;
  url: string;
  auth: Auth;
  revision: number;
  connected: boolean;
};
export type EnabledTool = {
  name: string;
  schema: Record<string, unknown>;
  fingerprint: string;
  enabled: boolean;
};
export type Request = {
  id: string;
  agentId: string;
  agentName: string;
  connectionId: string;
  connectionName: string;
  revision: number;
  tool: string;
  toolFingerprint: string;
  args: Record<string, unknown>;
  status: string;
  createdAt: number;
  expiresAt: number;
  result?: unknown;
};

const text = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string') throw new Error('Invalid stored data.');
  return value;
};

export class Store {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new Error('The encryption key must contain 32 bytes.');
    this.#key = key;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS connection (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, url TEXT NOT NULL,
        secret TEXT NOT NULL, revision INTEGER NOT NULL, connected INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tool (
        connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
        name TEXT NOT NULL, schema TEXT NOT NULL, fingerprint TEXT NOT NULL,
        enabled INTEGER NOT NULL, PRIMARY KEY(connection_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, secret_hash TEXT UNIQUE NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        connection_id TEXT NOT NULL, connection_name TEXT NOT NULL, revision INTEGER NOT NULL,
        tool TEXT NOT NULL, tool_fingerprint TEXT NOT NULL, args TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        result TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS request_status ON request(status, expires_at);
      CREATE TABLE IF NOT EXISTS oauth_flow (
        state_hash TEXT PRIMARY KEY, connection_id TEXT UNIQUE NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      UPDATE request SET status = 'unknown' WHERE status = 'running';
    `);
  }

  close(): void { this.#db.close(); }

  createConnection(name: string, url: string, auth: Auth): string {
    const id = randomUUID();
    this.#db.prepare('INSERT INTO connection VALUES (?, ?, ?, ?, 1, 0)')
      .run(id, name, url, seal(this.#key, connectionContext(id, 1, url), auth));
    return id;
  }

  #connection(row: Row): Connection {
    const id = text(row, 'id');
    const url = text(row, 'url');
    const revision = Number(row.revision);
    // Only this store writes these authenticated records.
    const auth = unseal(this.#key, connectionContext(id, revision, url), text(row, 'secret')) as Auth;
    return { id, name: text(row, 'name'), url, auth, revision, connected: row.connected === 1 };
  }

  connection(id: string): Connection | undefined {
    const row = this.#db.prepare('SELECT * FROM connection WHERE id = ?').get(id);
    return row && this.#connection(row);
  }

  connectionByName(name: string): Connection | undefined {
    const row = this.#db.prepare('SELECT * FROM connection WHERE name = ?').get(name);
    return row && this.#connection(row);
  }

  connections(): Connection[] {
    return this.#db.prepare('SELECT * FROM connection ORDER BY name').all().map(row => this.#connection(row));
  }

  saveAuth({ id, url, revision }: Connection, auth: Auth): void {
    const result = this.#db.prepare('UPDATE connection SET secret = ? WHERE id = ? AND revision = ? AND url = ?')
      .run(seal(this.#key, connectionContext(id, revision, url), auth), id, revision, url);
    if (result.changes !== 1) throw new Error('The connection changed.');
  }

  changeAuth(connection: Connection, auth: Auth): void {
    const revision = connection.revision + 1;
    this.#db.prepare('UPDATE connection SET secret = ?, revision = ?, connected = 0 WHERE id = ? AND revision = ?')
      .run(seal(this.#key, connectionContext(connection.id, revision, connection.url), auth),
        revision, connection.id, connection.revision);
    this.#db.prepare('UPDATE tool SET enabled = 0 WHERE connection_id = ?').run(connection.id);
    this.#db.prepare('DELETE FROM oauth_flow WHERE connection_id = ?').run(connection.id);
  }

  deleteConnection(id: string): void { this.#db.prepare('DELETE FROM connection WHERE id = ?').run(id); }

  tools(id: string): EnabledTool[] {
    return this.#db.prepare('SELECT * FROM tool WHERE connection_id = ? ORDER BY name').all(id).map(row => ({
      name: text(row, 'name'),
      schema: record(JSON.parse(text(row, 'schema'))),
      fingerprint: text(row, 'fingerprint'),
      enabled: row.enabled === 1,
    }));
  }

  setTools(id: string, revision: number, tools: Omit<EnabledTool, 'enabled'>[]): void {
    if (this.connection(id)?.revision !== revision) throw new Error('The connection changed.');
    const existing = new Map(this.tools(id).map(tool => [tool.name, tool]));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM tool WHERE connection_id = ?').run(id);
      const insert = this.#db.prepare('INSERT INTO tool VALUES (?, ?, ?, ?, ?)');
      for (const tool of tools) {
        const previous = existing.get(tool.name);
        const enabled = previous?.enabled === true && previous.fingerprint === tool.fingerprint;
        insert.run(id, tool.name, JSON.stringify(tool.schema), tool.fingerprint, Number(enabled));
      }
      this.#db.prepare('UPDATE connection SET connected = 1 WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  enableTool(connectionId: string, name: string, enabled: boolean): void {
    const result = this.#db.prepare('UPDATE tool SET enabled = ? WHERE connection_id = ? AND name = ?')
      .run(Number(enabled), connectionId, name);
    if (result.changes !== 1) throw new Error('The tool is unavailable.');
  }

  saveOAuthFlow(connection: Connection, state: string): void {
    this.#db.prepare('DELETE FROM oauth_flow WHERE connection_id = ? OR expires_at <= ?').run(connection.id, Date.now());
    this.#db.prepare('INSERT INTO oauth_flow VALUES (?, ?, ?, ?)')
      .run(digest(state), connection.id, connection.revision, Date.now() + REQUEST_TTL);
  }

  consumeOAuthFlow(state: string): Connection | undefined {
    const row = this.#db.prepare('DELETE FROM oauth_flow WHERE state_hash = ? AND expires_at > ? RETURNING *')
      .get(digest(state), Date.now());
    if (!row) return;
    const connection = this.connection(text(row, 'connection_id'));
    if (connection?.revision === row.revision) return connection;
  }

  createAgent(name: string): {id: string; token: string} {
    const id = randomUUID();
    const token = 'sani_' + randomBytes(32).toString('base64url');
    this.#db.prepare('INSERT INTO agent VALUES (?, ?, ?)').run(id, name, digest(token));
    return { id, token };
  }

  agents(): {id: string; name: string}[] {
    return this.#db.prepare('SELECT id, name FROM agent ORDER BY name').all()
      .map(row => ({ id: text(row, 'id'), name: text(row, 'name') }));
  }

  agentByToken(raw: string): {id: string; name: string} | undefined {
    const row = this.#db.prepare('SELECT id, name FROM agent WHERE secret_hash = ?').get(digest(raw));
    if (row) return { id: text(row, 'id'), name: text(row, 'name') };
  }

  agentExists(id: string): boolean {
    return this.#db.prepare('SELECT id FROM agent WHERE id = ?').get(id) !== undefined;
  }

  revokeAgent(id: string): void { this.#db.prepare('DELETE FROM agent WHERE id = ?').run(id); }

  addRequest(agent: {id: string; name: string}, connection: Connection, tool: EnabledTool, args: Record<string, unknown>): string {
    const now = Date.now();
    const open = this.#db.prepare("SELECT count(*) AS total FROM request WHERE agent_id = ? AND status = 'pending' AND expires_at > ?")
      .get(agent.id, now);
    if (Number(open?.total) >= 25) throw new Error('This agent has too many pending requests.');
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO request VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
    `).run(id, agent.id, agent.name, connection.id, connection.name, connection.revision,
      tool.name, tool.fingerprint, JSON.stringify(args), now, now + REQUEST_TTL);
    return id;
  }

  #request(row: Row): Request {
    const status = text(row, 'status');
    return {
      id: text(row, 'id'),
      agentId: text(row, 'agent_id'),
      agentName: text(row, 'agent_name'),
      connectionId: text(row, 'connection_id'),
      connectionName: text(row, 'connection_name'),
      revision: Number(row.revision),
      tool: text(row, 'tool'),
      toolFingerprint: text(row, 'tool_fingerprint'),
      args: record(JSON.parse(text(row, 'args'))),
      status: status === 'pending' && Number(row.expires_at) <= Date.now() ? 'expired' : status,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      ...(typeof row.result === 'string' ? { result: JSON.parse(row.result) } : {}),
    };
  }

  request(id: string): Request | undefined {
    const row = this.#db.prepare('SELECT * FROM request WHERE id = ?').get(id);
    return row && this.#request(row);
  }

  requests(): Request[] {
    return this.#db.prepare('SELECT * FROM request ORDER BY created_at DESC LIMIT 100').all()
      .map(row => this.#request(row));
  }

  claim(id: string, status: 'running' | 'declined'): boolean {
    return this.#db.prepare("UPDATE request SET status = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .run(status, id, Date.now()).changes === 1;
  }

  finish(id: string, status: 'succeeded' | 'failed' | 'unknown', result?: unknown): void {
    this.#db.prepare("UPDATE request SET status = ?, result = ? WHERE id = ? AND status = 'running'")
      .run(status, result === undefined ? null : JSON.stringify(result), id);
  }
}
