import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { dockerArgs, dockerSandbox, NotStarted } from '../src/sandbox.ts';

test('the sandbox container is locked down and takes secret values from the environment', () => {
  const args = dockerArgs('alpine:3', 'sani-1', ['GH_TOKEN'], 'echo "$GH_TOKEN"');
  assert.deepEqual(args.slice(-4), ['alpine:3', 'sh', '-c', 'echo "$GH_TOKEN"']);
  for (const flag of ['--rm', '--read-only', 'no-new-privileges', 'ALL', '65534:65534']) assert(args.includes(flag), flag);
  assert.equal(args[args.indexOf('GH_TOKEN') - 1], '--env');
  assert.equal(args.some(arg => arg.startsWith('GH_TOKEN=')), false);
  assert.throws(() => dockerSandbox('--privileged'));
});

const image = 'alpine:3';
const available = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
test('docker runs a command with its secret and reports the exit code', { skip: !available && `needs docker and ${image}` }, async () => {
  const run = dockerSandbox(image);
  const result = await run({ id: 'test-' + process.pid, command: 'echo "$FIXTURE_SECRET"; id -u; touch /x; exit 4', env: { FIXTURE_SECRET: 'fixture-value' } });
  assert.equal(result.exitCode, 4);
  assert.match(result.output, /^fixture-value\n65534\n/);
  assert.match(result.output, /Read-only file system/);
  await assert.rejects(dockerSandbox('sani-absent-image:none')({ id: 'absent-' + process.pid, command: 'true', env: {} }), NotStarted);
});
