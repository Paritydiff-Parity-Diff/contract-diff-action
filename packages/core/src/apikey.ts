import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GeneratedApiKey {
  readonly plaintext: string; // apiw_<prefix>_<secret> - shown once
  readonly prefix: string; // stored, indexed, non-secret
  readonly keyHash: string; // stored; sha256 of the secret
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { plaintext: `apiw_${prefix}_${secret}`, prefix, keyHash: hashSecret(secret) };
}

export function parseApiKey(plaintext: string): { prefix: string; secret: string } | undefined {
  const match = /^apiw_([0-9a-f]{8})_(.+)$/.exec(plaintext);
  if (!match) return undefined;
  return { prefix: match[1] ?? '', secret: match[2] ?? '' };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifySecret(secret: string, keyHash: string): boolean {
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(keyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const K_ANONYMITY_THRESHOLD = 5;

// Suppress any count derived from fewer than K installations so a vendor cannot
// deanonymize a single customer (spec section 9.6).
export function kAnonymize(count: number, threshold = K_ANONYMITY_THRESHOLD): number | null {
  return count < threshold ? null : count;
}
