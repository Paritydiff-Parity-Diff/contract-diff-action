import { contentHash, err, ok, sha256Hex, type Result } from '@paritydiff/core';
import {
  contractChildRole,
  contractDialect,
  contractResourceId,
  object,
  pointerEscape,
  pointerFragment,
  visitContract,
  type ContractObject,
  type ContractRole,
} from './contract-tree';
import { contractBudget } from './schema-validation';
import { parseSpec } from './parse';
import type { FetchSpecOptions, SpecFetcher } from './fetch';
import { freezeValidationGraph } from './validation-graph';
import { knownSchemaDialect } from './schema-vocabularies.mjs';
import { builtinMetaSchemas } from './schema-engine.mjs';
import { parseProtocolContract } from './protocol-parser';

export interface ReferencePolicy {
  readonly sourceUrl: string;
  readonly fetcher: Pick<SpecFetcher, 'fetch'>;
  readonly fetchOptions: FetchSpecOptions;
  readonly maxDocuments?: number;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
}
export interface ReferenceSnapshot {
  readonly document: unknown;
  readonly dependencies: readonly { id: string; hash: string; source: string }[];
  readonly issues: readonly string[];
}
type Target = { document: string; pointer: string };
type Reference = { node: ContractObject; key: string; absolute: string; depth: number };

export async function snapshotReferences(
  input: unknown,
  policy: ReferencePolicy,
): Promise<Result<ReferenceSnapshot, { kind: 'reference_failed'; reason: string }>> {
  const deadline = Math.min(
    Date.now() + (policy.timeoutMs ?? 10000),
    policy.fetchOptions.deadline ?? Infinity,
  );
  const maxBytes = policy.maxBytes ?? 20 * 1024 * 1024;
  const maxDocuments = policy.maxDocuments ?? 32;
  const maxDepth = policy.maxDepth ?? 16;
  let root = structuredClone(input);
  if (
    object(root) &&
    [
      'x-paritydiff-reference-documents',
      'x-paritydiff-reference-manifest',
      'x-paritydiff-validation-graph',
    ].some((key) => Object.hasOwn(root as object, key))
  )
    return err({ kind: 'reference_failed', reason: 'reserved reference snapshot extension' });
  let rootUrl: URL;
  try {
    rootUrl = new URL(policy.sourceUrl);
  } catch {
    return err({ kind: 'reference_failed', reason: 'reference base URL is invalid' });
  }
  rootUrl.hash = '';
  const documents = new Map<string, unknown>([[rootUrl.href, root]]);
  const originalHashes = new Map<string, string>([[rootUrl.href, contentHash(root)]]);
  const ids = new Map<string, Target>([[rootUrl.href, { document: rootUrl.href, pointer: '' }]]);
  const references: Reference[] = [];
  const issues: string[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(root));
  let nodes = 0;
  let needsVocabularies = false;
  const scan = (document: unknown, uri: string, refDepth: number) => {
    const budget = contractBudget(document);
    if (budget) throw new Error(budget);
    const stack: {
      value: unknown;
      base: string;
      pointer: string;
      role: ContractRole;
      dialect: string;
    }[] = [
      {
        value: document,
        base: uri,
        pointer: '',
        role: 'structure',
        dialect: contractDialect(document, contractDialect(root)),
      },
    ];
    while (stack.length) {
      if (++nodes > 200000) throw new Error('reference node limit exceeded');
      const item = stack.pop()!;
      if (Array.isArray(item.value)) {
        item.value.forEach((value, index) =>
          stack.push({ ...item, value, pointer: item.pointer + '/' + index }),
        );
        continue;
      }
      const node = object(item.value);
      if (!node || item.role === 'literal') continue;
      let base = item.base;
      const dialect =
        item.role === 'structure' ? contractDialect(node, item.dialect) : item.dialect;
      if (item.role === 'structure') {
        const resourceId = contractResourceId(node, dialect);
        if (resourceId !== undefined) {
          base = new URL(resourceId, base).href;
          const existing = ids.get(base);
          if (existing && (existing.document !== uri || existing.pointer !== item.pointer))
            throw new Error('duplicate schema resource ID');
          ids.set(base, { document: uri, pointer: item.pointer });
        }
        for (const key of ['$anchor', '$dynamicAnchor']) {
          if (typeof node[key] === 'string') {
            const anchor = new URL('#' + node[key], base).href;
            if (ids.has(anchor)) throw new Error('duplicate schema anchor');
            ids.set(anchor, { document: uri, pointer: item.pointer });
          }
        }
        for (const key of ['$ref', '$dynamicRef', '$recursiveRef']) {
          if (typeof node[key] !== 'string') continue;
          references.push({ node, key, absolute: new URL(node[key], base).href, depth: refDepth });
          if (key !== '$ref' && !builtinMetaSchemas.has(uri))
            issues.push('dynamic reference scope requires runtime validation');
        }
        if (typeof node['$schema'] === 'string' && !knownSchemaDialect(node['$schema'])) {
          needsVocabularies = true;
          references.push({
            node,
            key: '$schema',
            absolute: new URL(node['$schema'], base).href,
            depth: refDepth,
          });
        }
        if (
          typeof node['jsonSchemaDialect'] === 'string' &&
          !knownSchemaDialect(node['jsonSchemaDialect'])
        ) {
          needsVocabularies = true;
          references.push({
            node,
            key: 'jsonSchemaDialect',
            absolute: new URL(node['jsonSchemaDialect'], base).href,
            depth: refDepth,
          });
        }
      }
      for (const [key, value] of Object.entries(node)) {
        const role = contractChildRole(item.role, key);
        if (role !== 'literal')
          stack.push({
            value,
            base,
            pointer: item.pointer + '/' + pointerEscape(key),
            role,
            dialect,
          });
      }
    }
  };
  try {
    if (bytes > maxBytes) throw new Error('reference byte limit exceeded');
    scan(root, rootUrl.href, 0);
    for (let index = 0; index < references.length; index++) {
      if (Date.now() >= deadline) throw new Error('reference deadline exceeded');
      const reference = references[index]!;
      if (ids.has(reference.absolute)) continue;
      const url = new URL(reference.absolute);
      url.hash = '';
      if (ids.has(url.href)) continue;
      if (reference.depth >= maxDepth || documents.size >= maxDocuments)
        throw new Error('reference graph limit exceeded');
      const options = {
        ...policy.fetchOptions,
        deadline,
        byteCap: Math.min(policy.fetchOptions.byteCap ?? maxBytes, maxBytes - bytes),
      };
      if (url.origin !== rootUrl.origin) delete (options as { auth?: unknown }).auth;
      const builtin = builtinMetaSchemas.get(url.href);
      const fetched =
        builtin === undefined
          ? await policy.fetcher.fetch(url.href, options)
          : ok({ status: 'fetched' as const, body: JSON.stringify(builtin) });
      if (!fetched.ok || fetched.value.status !== 'fetched')
        throw new Error('reference fetch unavailable or rejected');
      bytes += Buffer.byteLength(fetched.value.body, 'utf8');
      if (bytes > maxBytes) throw new Error('reference byte limit exceeded');
      let parsed = parseSpec(
        fetched.value.body,
        'json',
        maxBytes - bytes + Buffer.byteLength(fetched.value.body),
      );
      if (!parsed.ok)
        parsed = parseSpec(
          fetched.value.body,
          'yaml',
          maxBytes - bytes + Buffer.byteLength(fetched.value.body),
        );
      if (!parsed.ok) throw new Error('reference document could not be parsed');
      documents.set(url.href, parsed.value);
      originalHashes.set(url.href, contentHash(parsed.value));
      ids.set(url.href, { document: url.href, pointer: '' });
      scan(parsed.value, url.href, reference.depth + 1);
    }
    if (needsVocabularies) {
      const prepared = (
        await parseProtocolContract(
          {
            'x-paritydiff-schema-vocabularies': true,
            documents: [...documents],
          },
          Math.max(1, deadline - Date.now()),
        )
      ).document as { documents: [string, unknown][]; profiles: unknown[] };
      for (const [uri, document] of prepared.documents) documents.set(uri, document);
      root = documents.get(rootUrl.href);
      if (object(root)) object(root)!['x-paritydiff-vocabulary-profiles'] = prepared.profiles;
      references.length = 0;
      ids.clear();
      ids.set(rootUrl.href, { document: rootUrl.href, pointer: '' });
      nodes = 0;
      for (const [uri, document] of documents) {
        if (!ids.has(uri)) ids.set(uri, { document: uri, pointer: '' });
        scan(document, uri, 0);
      }
    }
    const locate = (absolute: string): Target => {
      const exact = ids.get(absolute);
      if (exact) return exact;
      const url = new URL(absolute),
        fragment = url.hash;
      url.hash = '';
      const resource = ids.get(url.href);
      if (!resource || (fragment && !fragment.startsWith('#/')))
        throw new Error('unresolved schema reference');
      let pointer = resource.pointer;
      if (fragment)
        for (const part of decodeURIComponent(fragment.slice(1)).slice(1).split('/'))
          pointer += '/' + pointerEscape(part.replace(/~1/g, '/').replace(/~0/g, '~'));
      let value = documents.get(resource.document);
      for (const part of pointer
        .slice(1)
        .split('/')
        .filter(() => Boolean(pointer))) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
          throw new Error('unresolved schema reference');
        value = (value as ContractObject)[key];
      }
      return { document: resource.document, pointer };
    };
    const remoteIds = new Map(
      [...documents.keys()]
        .filter((uri) => uri !== rootUrl.href)
        .map((uri) => [uri, sha256Hex(uri).slice(0, 32)]),
    );
    const dependencies = [...remoteIds]
      .map(([uri, id]) => ({
        id,
        hash: originalHashes.get(uri)!,
        source: new URL(uri).origin + new URL(uri).pathname,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    let validationGraph;
    try {
      validationGraph = freezeValidationGraph(documents, rootUrl.href, locate);
    } catch {
      issues.push('schema validation resource scope unavailable');
    }
    for (const reference of references) {
      const target = locate(reference.absolute);
      if (reference.key !== '$ref') continue;
      reference.node[reference.key] =
        target.document === rootUrl.href
          ? '#' + pointerFragment(target.pointer)
          : '#/x-paritydiff-reference-documents/' +
            remoteIds.get(target.document) +
            pointerFragment(target.pointer);
    }
    for (const document of documents.values())
      visitContract(document, (node, pointer) => {
        if (typeof node['$id'] === 'string') {
          node['x-paritydiff-resource-id'] = node['$id'];
          if (pointer && typeof node['$schema'] === 'string')
            node['$id'] = 'https://paritydiff.invalid/resource/' + sha256Hex(node['$id']);
          else delete node['$id'];
        }
      });
    if (remoteIds.size) {
      const result = object(root);
      if (!result) throw new Error('root reference document must be an object');
      if (Object.hasOwn(result, 'x-paritydiff-reference-documents'))
        throw new Error('reserved reference snapshot extension');
      result['x-paritydiff-reference-documents'] = Object.fromEntries(
        [...remoteIds].map(([uri, id]) => [id, documents.get(uri)]),
      );
      result['x-paritydiff-reference-manifest'] = dependencies;
    }
    if (issues.length && object(root))
      object(root)!['x-paritydiff-coverage-issues'] = [
        ...new Set([
          ...((object(root)!['x-paritydiff-coverage-issues'] as string[] | undefined) ?? []),
          ...issues,
        ]),
      ].sort();
    if (validationGraph && object(root))
      object(root)!['x-paritydiff-validation-graph'] = validationGraph;
    return ok({ document: root, dependencies, issues: [...new Set(issues)] });
  } catch (cause) {
    return err({
      kind: 'reference_failed',
      reason: cause instanceof Error ? cause.message : 'reference resolution unavailable',
    });
  }
}
