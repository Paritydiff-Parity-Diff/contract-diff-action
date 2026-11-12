import { contentHash, sha256Hex } from '@paritydiff/core';
import { object } from './contract-tree';
import { parseProtocolContract } from './protocol-parser';
import type { ReferencePolicy } from './references';

export async function snapshotNativeImports(
  input: unknown,
  policy?: ReferencePolicy,
): Promise<unknown> {
  const value = object(input);
  const key = value?.['proto']
    ? 'proto'
    : value?.['sdl']
      ? 'sdl'
      : value?.['xml']
        ? 'xml'
        : undefined;
  if (!value || !key) return input;
  if (
    Object.hasOwn(value, 'x-paritydiff-native-documents') ||
    Object.hasOwn(value, 'x-paritydiff-native-manifest') ||
    Object.hasOwn(value, 'x-paritydiff-native-edges') ||
    Object.hasOwn(value, 'x-paritydiff-native-root')
  )
    throw new Error('reserved native import extension');
  const supplied = object(value['documents']) ?? {};
  if (
    Object.keys(supplied).length > 32 ||
    Object.values(supplied).some((body) => typeof body !== 'string')
  )
    throw new Error('invalid native document bundle');
  if (Buffer.byteLength(JSON.stringify(input)) > (policy?.maxBytes ?? 20 * 1024 * 1024))
    throw new Error('native import bundle byte limit');
  const base = policy?.sourceUrl ?? 'https://bundle.invalid/root';
  const rootUrl = new URL(base);
  rootUrl.hash = '';
  const bundles = new Map<string, string>();
  for (const [path, body] of Object.entries(supplied))
    bundles.set(new URL(path, base).href, body as string);
  const queue = [{ url: rootUrl.href, body: String(value[key]), depth: 0 }],
    seen = new Set<string>(),
    documents = new Map<string, string>(),
    manifest: { id: string; hash: string; source: string; imports: string[] }[] = [];
  const edges: { from: string; to: string; import: string }[] = [];
  const deadline = Math.min(
    Date.now() + (policy?.timeoutMs ?? 10000),
    policy?.fetchOptions.deadline ?? Infinity,
  );
  let bytes = 0;
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    bytes += Buffer.byteLength(next.body);
    if (
      seen.size > (policy?.maxDocuments ?? 32) ||
      next.depth > (policy?.maxDepth ?? 16) ||
      bytes > (policy?.maxBytes ?? 20 * 1024 * 1024)
    )
      throw new Error('native import graph limit');
    if (Date.now() >= deadline) throw new Error('native import deadline exceeded');
    const references = (
      await parseProtocolContract(
        { [key]: next.body, 'x-paritydiff-import-scan': true },
        Math.min(3000, deadline - Date.now()),
      )
    ).document['imports'] as string[];
    for (const imported of references) {
      const target = new URL(imported, next.url);
      target.hash = '';
      if (target.username || target.password || !['http:', 'https:'].includes(target.protocol))
        throw new Error('native import source rejected');
      edges.push({
        from: sha256Hex(next.url).slice(0, 32),
        to: sha256Hex(target.href).slice(0, 32),
        import: imported,
      });
      if (seen.has(target.href) || queue.some((entry) => entry.url === target.href)) {
        const existing = manifest.find((entry) => entry.id === sha256Hex(target.href).slice(0, 32));
        if (existing) {
          if (!existing.imports.includes(imported)) existing.imports.push(imported);
        } else if (target.href === rootUrl.href)
          manifest.push({
            id: sha256Hex(target.href).slice(0, 32),
            hash: contentHash(value[key]),
            source: rootUrl.origin + rootUrl.pathname,
            imports: [imported],
          });
        continue;
      }
      let body = bundles.get(target.href);
      if (body === undefined) {
        if (!policy)
          throw new Error('native import requires a descriptor bundle or approved source');
        const options = {
          ...policy.fetchOptions,
          deadline,
          byteCap: Math.min(
            policy.fetchOptions.byteCap ?? Infinity,
            (policy.maxBytes ?? 20 * 1024 * 1024) - bytes,
          ),
        };
        if (target.origin !== rootUrl.origin) delete (options as { auth?: unknown }).auth;
        const fetched = await policy.fetcher.fetch(target.href, options);
        if (!fetched.ok || fetched.value.status !== 'fetched')
          throw new Error('native import fetch rejected or unavailable');
        body = fetched.value.body;
      }
      documents.set(target.href, body);
      manifest.push({
        id: sha256Hex(target.href).slice(0, 32),
        hash: contentHash(body),
        source: target.origin + target.pathname,
        imports: [imported],
      });
      queue.push({ url: target.href, body, depth: next.depth + 1 });
    }
  }
  const { documents: _provided, ...root } = value;
  return {
    ...root,
    'x-paritydiff-native-documents': Object.fromEntries(
      [...documents].map(([url, body]) => [sha256Hex(url).slice(0, 32), body]),
    ),
    'x-paritydiff-native-manifest': manifest.sort((a, b) => a.id.localeCompare(b.id)),
    'x-paritydiff-native-root': sha256Hex(rootUrl.href).slice(0, 32),
    'x-paritydiff-native-edges': edges.sort((a, b) =>
      (a.from + a.import).localeCompare(b.from + b.import),
    ),
  };
}
