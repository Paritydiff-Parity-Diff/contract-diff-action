import { err, ok, type Result } from '@paritydiff/core';
import { object } from './contract-tree';
import { snapshotReferences, type ReferencePolicy } from './references';

export async function snapshotPostmanSchemas(
  input: unknown,
  policy: ReferencePolicy,
): Promise<Result<unknown, { reason: string }>> {
  const doc = object(input);
  if (!doc || !Array.isArray(doc['item'])) return ok(input);
  const deadline = Date.now() + (policy.timeoutMs ?? 10000);
  const clone = structuredClone(doc);
  let count = 0,
    bytes = 0;
  let fetchedDocuments = 0,
    fetchedBytes = 0;
  const fetcher: ReferencePolicy['fetcher'] = {
    async fetch(url, options) {
      if (++fetchedDocuments > (policy.maxDocuments ?? 32))
        throw new Error('collection reference document limit');
      const result = await policy.fetcher.fetch(url, options);
      if (result.ok && result.value.status === 'fetched')
        fetchedBytes += Buffer.byteLength(result.value.body);
      if (fetchedBytes > (policy.maxBytes ?? 20 * 1024 * 1024))
        throw new Error('collection reference byte limit');
      return result;
    },
  };
  try {
    const stack: unknown[] = [...(clone['item'] as unknown[])];
    while (stack.length) {
      if (++count > 10000 || Date.now() >= deadline)
        throw new Error('collection schema resolution limit');
      const item = object(stack.pop());
      if (!item) continue;
      if (Array.isArray(item['item'])) stack.push(...item['item']);
      const sources = [
        object(item['request']),
        ...(Array.isArray(item['response']) ? item['response'].map(object) : []),
      ];
      for (const source of sources)
        for (const key of ['x-paritydiff-request-schema', 'x-paritydiff-response-schema']) {
          if (!source || source[key] === undefined) continue;
          const snapshot = await snapshotReferences(source[key], {
            ...policy,
            fetcher,
            timeoutMs: Math.max(1, deadline - Date.now()),
          });
          if (!snapshot.ok) throw new Error(snapshot.error.reason);
          bytes += Buffer.byteLength(JSON.stringify(snapshot.value.document));
          if (bytes > (policy.maxBytes ?? 20 * 1024 * 1024))
            throw new Error('collection schema resolution byte limit');
          source[key] = snapshot.value.document;
        }
    }
    return ok(clone);
  } catch (cause) {
    return err({
      reason: cause instanceof Error ? cause.message : 'collection schema resolution unavailable',
    });
  }
}
