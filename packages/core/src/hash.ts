import { createHash } from 'node:crypto';

/**
 * Deterministic JSON for hashing: object keys sorted at every depth so a
 * re-serialized-but-equal payload produces the same identity. Arrays keep order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentHash(...parts: readonly unknown[]): string {
  return sha256Hex(parts.map(canonicalize).join('\u0000'));
}

export function prefixedId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}_${contentHash(...parts)}`;
}
