import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureSecrets } from '../src/setup.ts';

test('the first run creates a private key and password once and later runs reuse them', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sani-setup-test-'));
  const saved = { key: process.env.SANI_ENCRYPTION_KEY, password: process.env.SANI_ADMIN_PASSWORD };
  context.after(async () => {
    for (const [name, value] of [['SANI_ENCRYPTION_KEY', saved.key], ['SANI_ADMIN_PASSWORD', saved.password]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'sani.env');

  assert.equal(ensureSecrets(file, { SANI_ADMIN_PASSWORD: 'set-by-the-operator' }), undefined);
  await assert.rejects(stat(file), 'configured installs get no file');

  delete process.env.SANI_ENCRYPTION_KEY;
  delete process.env.SANI_ADMIN_PASSWORD;
  const password = ensureSecrets(file, {});
  assert.match(password ?? '', /^[\w-]{32}$/);
  assert.equal(process.env.SANI_ADMIN_PASSWORD, password);
  assert.match(process.env.SANI_ENCRYPTION_KEY ?? '', /^[\w-]{43}$/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  const before = await readFile(file, 'utf8');
  delete process.env.SANI_ENCRYPTION_KEY;
  delete process.env.SANI_ADMIN_PASSWORD;
  assert.equal(ensureSecrets(file, {}), undefined, 'the password is shown only when created');
  assert.equal(process.env.SANI_ADMIN_PASSWORD, password);
  assert.equal(await readFile(file, 'utf8'), before);
});
