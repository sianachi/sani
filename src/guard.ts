import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return Object.fromEntries(Object.entries(value));
}

export function seal(key: Buffer, context: string, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function unseal(key: Buffer, context: string, value: string): unknown {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    .setAAD(Buffer.from(context))
    .setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return digest(JSON.stringify(canonical(value)));
}

function fragments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(fragments);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...fragments(entry)]);
  }
  return [];
}

export function assertScreened(value: unknown, secrets: readonly string[]): void {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 64 * 1024) {
    throw new Error('The data exceeded the size limit.');
  }
  const joined = fragments(value).join('');
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
    ]);
    for (const variant of variants) {
      if (json.includes(variant) || joined.includes(variant)) {
        throw new Error('Sani withheld data containing a connection credential.');
      }
    }
  }
}

export function token(value: string): string {
  if (!/^[A-Za-z0-9._~+\/=-]{8,4096}$/.test(value)) {
    throw new Error('Enter a bearer token of 8 to 4096 characters.');
  }
  return value;
}

export function displayName(value: string): string {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name)) {
    throw new Error('Use a name with up to 64 letters, digits, spaces, dots or dashes.');
  }
  return name;
}
