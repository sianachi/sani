#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { dockerSandbox } from './sandbox.ts';
import { builtSandboxImage, ensureSecrets, localSandboxImage } from './setup.ts';

if (process.argv[2] === 'sandbox') {
  // Build the image approved commands run in. Edit sandbox/Dockerfile to add tools.
  const built = spawnSync('docker', ['build', '-t', localSandboxImage, fileURLToPath(new URL('../sandbox', import.meta.url))], { stdio: 'inherit' });
  if (built.error) console.error('Docker is needed for sandbox commands. Install Docker and try again.');
  else if (built.status === 0) console.log('\nThe sandbox image is ready. Restart Sani to use it.');
  process.exit(built.status ?? 1);
}
if (process.argv[2]) {
  console.log('Usage: sani-mcp          start Sani\n       sani-mcp sandbox  build the image for sandbox commands');
  process.exit(process.argv[2] === '--help' ? 0 : 1);
}

process.umask(0o077);
const publicOrigin = process.env.SANI_ORIGIN ?? 'http://127.0.0.1:8765';
const port = Number(process.env.SANI_PORT ?? '8765');
const host = process.env.SANI_HOST ?? '127.0.0.1';
const dbPath = resolve(process.env.SANI_DB ?? join(homedir(), '.sani', 'sani.sqlite'));
mkdirSync(dirname(dbPath), { mode: 0o700, recursive: true });
const secretsFile = resolve(dirname(dbPath), 'sani.env');
const usesSecretsFile = !process.env.SANI_ENCRYPTION_KEY && !process.env.SANI_ADMIN_PASSWORD;
const newPassword = ensureSecrets(secretsFile);
const key = process.env.SANI_ENCRYPTION_KEY ?? '';
if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !process.env.SANI_ADMIN_PASSWORD) {
  throw new Error('Set SANI_ENCRYPTION_KEY to a base64url-encoded 32-byte key and set SANI_ADMIN_PASSWORD.');
}
const sandboxImage = process.env.SANI_SANDBOX_IMAGE || builtSandboxImage();
const app = createApp({
  dbPath,
  encryptionKey: Buffer.from(key, 'base64url'),
  adminPassword: process.env.SANI_ADMIN_PASSWORD,
  publicOrigin,
  sandbox: sandboxImage ? dockerSandbox(sandboxImage) : undefined,
});
const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, app.handle);
server.listen(port, host, () => {
  console.log('Sani is ready at ' + new URL(publicOrigin).origin);
  console.log(sandboxImage ? `Sandbox commands run in the ${sandboxImage} image.` : 'Sandbox commands are off. Run "npx github:sianachi/sani sandbox" (needs Docker) and restart to turn them on.');
  if (newPassword) {
    console.log(`\nFirst run: your operator password is\n\n  ${newPassword}\n`);
    console.log(`It is saved with a new encryption key in ${secretsFile}. For real credentials, set SANI_ENCRYPTION_KEY and SANI_ADMIN_PASSWORD yourself and keep the key away from the database.`);
  } else if (usesSecretsFile) {
    console.log('Your operator password is in ' + secretsFile);
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => app.close()));
}
