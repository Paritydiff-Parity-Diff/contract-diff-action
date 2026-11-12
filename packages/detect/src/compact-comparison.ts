import { createHash } from 'node:crypto';
import { contractChildRole, object, type ContractRole } from './contract-tree';

interface Shape {
  hash: string;
  bytes: number;
  movable: boolean;
}
const children = new Set([
  'schema',
  'schemas',
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
  'dependentSchemas',
  'propertyNames',
  'unevaluatedItems',
]);
const scoped = new Set([
  '$schema',
  '$id',
  'id',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveRef',
  '$recursiveAnchor',
]);

// Factor identical expanded schemas into shared local references for the engine.
// Stored documents, hashes, literal examples and resource scopes stay unchanged.
export function compactComparisonDocument(
  input: unknown,
  reservedNames: readonly string[] = [],
): unknown {
  const root = object(input);
  if (!root || typeof root['openapi'] !== 'string') return input;
  const shapes = new WeakMap<object, Shape>();
  const counts = new Map<string, number>();
  const protectedPointers = new Set<string>();
  const references: { value: unknown; role: ContractRole; pointer: string }[] = [
    { value: input, role: 'structure', pointer: '' },
  ];
  let scanned = 0;
  while (references.length) {
    if (++scanned > 6000000) throw new Error('comparison_compaction_limit');
    const { value, role, pointer: location } = references.pop()!;
    if (!value || typeof value !== 'object' || role === 'literal') continue;
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        references.push({ value: child, role, pointer: location + '/' + index }),
      );
      continue;
    }
    const refs =
      role === 'structure'
        ? [
            (value as Record<string, unknown>)['$ref'],
            ...Object.values(
              object(object((value as Record<string, unknown>)['discriminator'])?.['mapping']) ??
                {},
            ),
          ]
        : [];
    if (role === 'structure' && Object.hasOwn(value, 'discriminator')) {
      protectedPointers.add(location);
      for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
        const branches = (value as Record<string, unknown>)[keyword];
        if (Array.isArray(branches))
          branches.forEach((_, index) =>
            protectedPointers.add(location + '/' + keyword + '/' + index),
          );
      }
    }
    for (const ref of refs)
      if (typeof ref === 'string' && ref.startsWith('#/')) {
        let pointer: string;
        try {
          pointer = decodeURIComponent(ref.slice(1));
        } catch {
          pointer = '';
        }
        while (pointer) {
          protectedPointers.add(pointer);
          pointer = pointer.slice(0, pointer.lastIndexOf('/'));
        }
      }
    for (const [key, child] of Object.entries(value))
      references.push({
        value: child,
        role: contractChildRole(role, key),
        pointer: location + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'),
      });
  }
  let remaining = 6000000;
  const analyze = (
    value: unknown,
    role: ContractRole,
    schema: boolean,
    depth: number,
    scope = false,
    pointer = '',
  ): Shape => {
    if (--remaining < 0 || depth > 128) throw new Error('comparison_compaction_limit');
    const hash = createHash('sha256');
    let bytes = 2,
      movable = true;
    if (!value || typeof value !== 'object') {
      const encoded = JSON.stringify(value) ?? 'null';
      return {
        hash: hash.update(encoded).digest('hex'),
        bytes: Buffer.byteLength(encoded),
        movable,
      };
    }
    const nestedScope =
      scope ||
      (!Array.isArray(value) &&
        role === 'structure' &&
        Object.keys(value).some((key) => scoped.has(key)));
    hash.update(Array.isArray(value) ? '[' : '{');
    const entries = Array.isArray(value)
      ? value.map((child, index) => [String(index), child] as const)
      : Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, child] of entries) {
      const nextRole = Array.isArray(value) ? role : contractChildRole(role, key);
      const nextSchema = Array.isArray(value)
        ? schema
        : role === 'literal'
          ? false
          : role === 'members'
            ? schema
            : children.has(key);
      const shape = analyze(
        child,
        nextRole,
        nextSchema,
        depth + 1,
        nestedScope,
        pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'),
      );
      hash.update(JSON.stringify(key)).update(':').update(shape.hash).update(',');
      bytes += Buffer.byteLength(JSON.stringify(key)) + shape.bytes + 2;
      movable &&= shape.movable && !(role === 'structure' && scoped.has(key));
    }
    const shape = { hash: hash.digest('hex'), bytes, movable };
    if (
      schema &&
      role === 'structure' &&
      !Array.isArray(value) &&
      !scope &&
      !protectedPointers.has(pointer) &&
      movable &&
      bytes >= 256
    ) {
      shapes.set(value, shape);
      counts.set(shape.hash, (counts.get(shape.hash) ?? 0) + 1);
    }
    return shape;
  };
  analyze(input, 'structure', false, 0);
  const names = new Map<string, string>();
  const definitions: Record<string, unknown> = Object.create(null);
  const originalSchemas = object(object(root['components'])?.['schemas']) ?? {};
  const encode = (value: unknown, definition = false): unknown => {
    if (!value || typeof value !== 'object') return value;
    const shape = shapes.get(value);
    if (!definition && shape && (counts.get(shape.hash) ?? 0) > 1) {
      let name = names.get(shape.hash);
      if (!name) {
        name = 'ParityDiffShared_' + shape.hash;
        while (Object.hasOwn(originalSchemas, name) || reservedNames.includes(name)) name += '_';
        names.set(shape.hash, name);
        definitions[name] = encode(value, true);
      }
      return { $ref: '#/components/schemas/' + name };
    }
    if (Array.isArray(value)) return value.map((child) => encode(child));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]));
  };
  const result = encode(input) as Record<string, unknown>;
  if (names.size)
    result['components'] = {
      ...object(result['components']),
      schemas: { ...object(object(result['components'])?.['schemas']), ...definitions },
    };
  return result;
}

export function compactComparisonPair(
  before: unknown,
  after: unknown,
): readonly [unknown, unknown] {
  const schemas = (doc: unknown) => object(object(object(doc)?.['components'])?.['schemas']) ?? {};
  const reserved = [...new Set([...Object.keys(schemas(before)), ...Object.keys(schemas(after))])];
  const first = compactComparisonDocument(before, reserved),
    second = compactComparisonDocument(after, reserved);
  const generated = Object.fromEntries(
    [first, second].flatMap((doc) =>
      Object.entries(schemas(doc)).filter(([name]) => !reserved.includes(name)),
    ),
  );
  const complete = (doc: unknown): unknown => {
    const root = object(doc);
    if (!root || !Object.keys(generated).length) return doc;
    return {
      ...root,
      components: { ...object(root['components']), schemas: { ...schemas(doc), ...generated } },
    };
  };
  return [complete(first), complete(second)];
}
