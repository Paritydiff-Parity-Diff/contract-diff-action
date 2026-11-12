export function sdkRegistryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      url.pathname.includes('%') ||
      url.pathname.includes('\\')
    )
      return undefined;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return undefined;
  }
}
export function sdkRegistryArchive(url: string, registry?: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      url.length > 4096
    )
      return false;
    if (
      parsed.origin === 'https://registry.npmjs.org' ||
      parsed.origin === 'https://registry.yarnpkg.com'
    )
      return true;
    if (!registry) return false;
    const base = new URL(registry);
    const decoded = decodeURIComponent(parsed.pathname);
    if (
      /[\\%\r\n\0]/.test(decoded) ||
      decoded.split('/').some((part) => part === '.' || part === '..')
    )
      return false;
    const normalized = new URL(parsed.origin + decoded);
    return (
      parsed.origin === base.origin &&
      parsed.pathname.startsWith(base.pathname) &&
      normalized.pathname.startsWith(base.pathname)
    );
  } catch {
    return false;
  }
}
import { prefixedId } from './hash';

export const sdkRegistrySecretId = (vendor: string, pkg: string, registry: string) =>
  prefixedId('sec', vendor, pkg, registry, 'sdk_registry_auth');
