import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { err, ok, type Result } from '@paritydiff/core';

export type Resolver = (hostname: string) => Promise<readonly string[]>;

export interface SsrfOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedSchemes?: readonly string[];
  readonly resolveHost?: Resolver;
  readonly timeoutMs?: number;
}

export type SsrfError =
  | { readonly kind: 'invalid_url' }
  | { readonly kind: 'scheme_not_allowed'; readonly scheme: string }
  | { readonly kind: 'host_not_allowed'; readonly host: string }
  | { readonly kind: 'resolution_failed' }
  | { readonly kind: 'blocked_ip'; readonly ip: string };

const DEFAULT_SCHEMES = ['https'];

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

// Validate an outbound spec URL before any fetch: scheme and host allowlist, then
// resolve DNS and reject if any resolved address is private/loopback/link-local or
// the cloud metadata address (spec section 4 row 1). Blocking on any resolved
// address defeats DNS-rebinding to a mixed answer.
export async function assertSafeUrl(
  rawUrl: string,
  options: SsrfOptions,
): Promise<Result<URL, SsrfError>> {
  const resolved = await resolveSafeUrl(rawUrl, options);
  return resolved.ok ? ok(resolved.value.url) : resolved;
}

export async function resolveSafeUrl(
  rawUrl: string,
  options: SsrfOptions,
): Promise<Result<{ url: URL; addresses: readonly string[] }, SsrfError>> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return err({ kind: 'invalid_url' });
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (url.username || url.password) return err({ kind: 'invalid_url' });
  if (!(options.allowedSchemes ?? DEFAULT_SCHEMES).includes(scheme)) {
    return err({ kind: 'scheme_not_allowed', scheme });
  }
  if (!options.allowedHosts.includes(url.hostname)) {
    return err({ kind: 'host_not_allowed', host: url.hostname });
  }

  const resolver = options.resolveHost ?? defaultResolver;
  let ips: readonly string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    ips = isIP(host)
      ? [host]
      : await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('DNS deadline')), options.timeoutMs ?? 10000);
          }),
        ]);
  } catch {
    return err({ kind: 'resolution_failed' });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (ips.length === 0) return err({ kind: 'resolution_failed' });
  for (const ip of ips) {
    if (isBlockedIp(ip)) return err({ kind: 'blocked_ip', ip });
  }
  return ok({ url, addresses: ips });
}

export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  return true;
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedV6(ip: string): boolean {
  let canonical: string;
  try {
    canonical = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  } catch {
    return true;
  }
  const halves = canonical.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map((s) =>
    parseInt(s, 16),
  );
  const first = words[0]!;
  if (words.slice(0, 7).every((n) => n === 0) && words[7]! <= 1) return true;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00)
    return true;
  if (words.slice(0, 5).every((n) => n === 0) && words[5] === 0xffff) {
    return isBlockedV4(
      [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.'),
    );
  }
  // Only global unicast is eligible; includes neither transition nor site-local ranges.
  return (
    (first & 0xe000) !== 0x2000 ||
    first === 0x2002 ||
    (first === 0x2001 && ((words[1]! & 0xfe00) === 0 || words[1] === 0xdb8))
  );
}
