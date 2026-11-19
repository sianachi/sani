import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

const SECRETS_FILE = 'sani.env';

describe('process boot', { concurrency: false }, () => {
  test('the first process prints a generated password once and demo mode is explicit', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'sani-boot-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, 'sani.sqlite');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const first = start(baseEnv(dbPath, origin, port, { SANI_DEMO: '1' }));
    context.after(() => stop(first.child));
    await first.ready;
    await first.printed(/It is saved with a new encryption key/);
    const output = first.output();
    const password = output.match(/First run: your operator password is\s+(\S+)/)?.[1];
    assert(password && password.length >= 16);
    const file = await readFile(join(directory, SECRETS_FILE), 'utf8');
    const encryptionKey = file.match(/^SANI_ENCRYPTION_KEY=(\S+)$/m)?.[1];
    assert(encryptionKey);
    assert.equal(file.match(/^SANI_ADMIN_PASSWORD=(\S+)$/m)?.[1], password);
    assert.equal(output.includes(encryptionKey), false);
    assert.match(output, /Demo mode is on/);
    assert.equal((lstatSync(join(directory, SECRETS_FILE)).mode & 0o777), 0o600);
    assert.equal((await signIn(origin, password)).status, 303);
    assert.equal((await signIn(origin, 'wrong-password-value')).status, 401);
    const page = await fetch(origin, { headers: { cookie: (await signIn(origin, password)).headers.getSetCookie()[0]?.split(';')[0] ?? '' } });
    assert.match(await page.text(), /Built-in demo/);
    await stop(first.child);

    const second = start(baseEnv(dbPath, origin, port, { SANI_DEMO: '1' }));
    context.after(() => stop(second.child));
    await second.ready;
    await second.printed(/Your operator password is in/);
    const again = second.output();
    assert.equal(again.includes(password), false);
    assert.equal(again.includes(encryptionKey), false);
    assert.doesNotMatch(again, /First run/);
    assert.equal((await signIn(origin, password)).status, 303);
  });

  test('explicit password and key are used and no secrets file is written', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'sani-boot-env-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, 'sani.sqlite');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const adminPassword = 'explicit-operator-password';
    const encryptionKey = randomBytes(32).toString('base64url');
    const child = start(baseEnv(dbPath, origin, port, {
      SANI_DEMO: '0',
      SANI_ADMIN_PASSWORD: adminPassword,
      SANI_ENCRYPTION_KEY: encryptionKey,
    }));
    context.after(() => stop(child.child));
    await child.ready;
    await child.printed(/Sandbox commands/);
    const output = child.output();
    assert.equal(output.includes(adminPassword), false);
    assert.equal(output.includes(encryptionKey), false);
    assert.doesNotMatch(output, /Demo mode is on/);
    assert.throws(() => lstatSync(join(directory, SECRETS_FILE)));
    const response = await signIn(origin, adminPassword);
    assert.equal(response.status, 303);
    const html = await (await fetch(origin, {
      headers: { cookie: response.headers.getSetCookie()[0]?.split(';')[0] ?? '' },
    })).text();
    assert.equal(html.includes('Built-in demo'), false);
    assert.equal(html.includes('lookup_ticket'), false);
  });

  test('an unexpected SANI_DEMO value refuses to start', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'sani-boot-bad-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = start(baseEnv(join(directory, 'sani.sqlite'), origin, port, {
      SANI_DEMO: 'yes',
      SANI_ADMIN_PASSWORD: 'explicit-operator-password',
      SANI_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    }));
    const code = await new Promise<number | null>((resolve) => child.child.once('exit', resolve));
    await child.ready.catch(() => undefined);
    assert.notEqual(code, 0);
    assert.match(child.output(), /SANI_DEMO/);
    assert.doesNotMatch(child.output(), /Sani is ready/);
    assert.throws(() => lstatSync(join(directory, SECRETS_FILE)));
  });
});

function baseEnv(dbPath: string, origin: string, port: number, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SANI_ADMIN_PASSWORD;
  delete env.SANI_ENCRYPTION_KEY;
  delete env.SANI_DEMO;
  delete env.SANI_SANDBOX_IMAGE;
  return {
    ...env,
    SANI_DB: dbPath,
    SANI_HOST: '127.0.0.1',
    SANI_PORT: String(port),
    SANI_ORIGIN: origin,
    ...extra,
  };
}

function start(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string; ready: Promise<void>; printed: (pattern: RegExp) => Promise<void> } {
  let text = '';
  const child = spawn(process.execPath, ['src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let settleReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(text || 'Sani did not start')), 15_000);
    settleReady = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve();
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`Sani exited ${code}: ${text}`));
    };
    child.once('exit', onExit);
  });
  const take = (chunk: Buffer) => {
    text += chunk.toString();
    if (text.includes('Sani is ready')) settleReady?.();
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  // Lines after "Sani is ready" can arrive in a later chunk.
  const printed = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(text); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(text, pattern);
  };
  return { child, output: () => text, ready, printed };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function signIn(origin: string, password: string): Promise<Response> {
  const response = await fetch(new URL('/login', origin), {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });
  await response.arrayBuffer();
  return response;
}
