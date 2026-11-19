import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.ts';
import { dockerSandbox } from './sandbox.ts';

process.umask(0o077);
const publicOrigin = process.env.SANI_ORIGIN ?? 'http://127.0.0.1:8765';
const port = Number(process.env.SANI_PORT ?? '8765');
const host = process.env.SANI_HOST ?? '127.0.0.1';
const dbPath = resolve(process.env.SANI_DB ?? 'data/sani.sqlite');
const key = process.env.SANI_ENCRYPTION_KEY ?? '';
if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !process.env.SANI_ADMIN_PASSWORD) {
  throw new Error('Set SANI_ENCRYPTION_KEY to a base64url-encoded 32-byte key and set SANI_ADMIN_PASSWORD.');
}
mkdirSync(dirname(dbPath), { mode: 0o700, recursive: true });
const app = createApp({
  dbPath,
  encryptionKey: Buffer.from(key, 'base64url'),
  adminPassword: process.env.SANI_ADMIN_PASSWORD,
  publicOrigin,
  sandbox: process.env.SANI_SANDBOX_IMAGE ? dockerSandbox(process.env.SANI_SANDBOX_IMAGE) : undefined,
});
const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, app.handle);
server.listen(port, host, () => console.log('Sani is ready at ' + new URL(publicOrigin).origin));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => app.close()));
}
