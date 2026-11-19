import { spawn } from 'node:child_process';

export type SandboxRun = (input: { id: string; command: string; env: Record<string, string> }) =>
  Promise<{ exitCode: number | null; output: string }>;

/** The command did not start, so it had no effect. */
export class NotStarted extends Error {}

const timeout = 60_000;
// Sani screens this much and returns the first 16 KiB, so a credential cut by the limit is still seen whole.
export const captureBytes = 24 * 1024;
export const outputBytes = 16 * 1024;

export function dockerArgs(image: string, name: string, envNames: string[], command: string): string[] {
  return [
    'run', '--rm', '--init', '--pull', 'never', '--name', name,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '512m', '--cpus', '1',
    '--read-only', '--tmpfs', '/tmp:exec,size=64m', '--workdir', '/tmp',
    '--user', '65534:65534', '--env', 'HOME=/tmp',
    // A bare name makes docker read the value from its own environment, which keeps it out of the process list.
    ...envNames.flatMap(envName => ['--env', envName]),
    image, 'sh', '-c', command,
  ];
}

export function dockerSandbox(image: string): SandboxRun {
  if (!/^[a-zA-Z0-9][\w./:@-]{0,255}$/.test(image)) throw new Error('Set SANI_SANDBOX_IMAGE to a Docker image reference.');
  const dockerEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name === 'PATH' || name === 'HOME' || name.startsWith('DOCKER_')));
  return ({ id, command, env }) => new Promise((resolve, reject) => {
    const name = 'sani-' + id;
    const child = spawn('docker', dockerArgs(image, name, Object.keys(env), command), {
      env: { ...dockerEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (chunk: Buffer) => {
      if (size < captureBytes) chunks.push(chunk.subarray(0, captureBytes - size));
      size += chunk.length;
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', name], { env: dockerEnv, stdio: 'ignore' }).on('error', () => {});
    }, timeout);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new NotStarted('Docker is unavailable.'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      // 125 is docker's own failure (no daemon, no image): the command never ran.
      if (code === 125) reject(new NotStarted('Docker could not start the sandbox.'));
      else if (timedOut) reject(new Error('The command exceeded the time limit.'));
      else resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
