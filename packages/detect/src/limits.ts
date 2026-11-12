import { err, ok, type Result } from '@paritydiff/core';

export type LimitError =
  | { readonly kind: 'too_large'; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'too_deep'; readonly depth: number; readonly limit: number };

export const DEFAULT_BYTE_CAP = 20 * 1024 * 1024;
export const DEFAULT_DEPTH_CAP = 100;

export function assertWithinByteCap(bytes: number, limit = DEFAULT_BYTE_CAP): Result<number, LimitError> {
  return bytes > limit ? err({ kind: 'too_large', bytes, limit }) : ok(bytes);
}

// Guards against deeply nested payloads after parse (spec section 4 row 2). The
// byte cap bounds the input before this ever runs.
export function assertParseDepth(value: unknown, limit = DEFAULT_DEPTH_CAP): Result<number, LimitError> {
  const depth = measureDepth(value);
  return depth > limit ? err({ kind: 'too_deep', depth, limit }) : ok(depth);
}

function measureDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let max = 0;
    for (const child of value) max = Math.max(max, measureDepth(child));
    return max + 1;
  }
  if (value !== null && typeof value === 'object') {
    let max = 0;
    for (const child of Object.values(value)) max = Math.max(max, measureDepth(child));
    return max + 1;
  }
  return 0;
}
