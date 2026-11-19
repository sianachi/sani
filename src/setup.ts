import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const localSandboxImage = 'sani-sandbox';

/**
 * First run with nothing configured: create a key and operator password in `file` and load them.
 * Returns the new password once, so the caller can show it.
 */
export function ensureSecrets(file: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SANI_ENCRYPTION_KEY || env.SANI_ADMIN_PASSWORD) return;
  let created: string | undefined;
  if (!existsSync(file)) {
    created = randomBytes(24).toString('base64url');
    writeFileSync(file, `SANI_ADMIN_PASSWORD=${created}\nSANI_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}\n`,
      { mode: 0o600, flag: 'wx' });
  }
  process.loadEnvFile(file);
  return created;
}

/** The image built by `npm run sandbox:build`, if it exists on this host. */
export function builtSandboxImage(): string | undefined {
  const found = spawnSync('docker', ['image', 'inspect', localSandboxImage], { stdio: 'ignore', timeout: 5000 });
  return found.status === 0 ? localSandboxImage : undefined;
}
