import { randomUUID } from 'node:crypto';
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const literalKeys = new Set(['const', 'enum', 'default', 'example', 'examples']);
const pointer = (value) => value.replace(/~/g, '~0').replace(/\//g, '~1');
export function bindValidationProperties(input) {
  if (!input || typeof input !== 'object') return input;
  const seed = 'https://paritydiff.invalid/validation/' + randomUUID() + '/root';
  const rootId = new URL(input.$id ?? seed, seed).href;
  let changed = false;
  const walk = (node, base, location, role = 'schema') => {
    if (!node || typeof node !== 'object' || role === 'literal') return node;
    if (Array.isArray(node))
      return node.map((value, index) => walk(value, base, location + '/' + index, role));
    if (role === 'schema' && typeof node.$id === 'string') {
      const uri = new URL(node.$id, base);
      if (!uri.hash) {
        base = uri.href;
        location = '';
      }
    }
    const result = Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        walk(
          value,
          base,
          location + '/' + pointer(key),
          role === 'map'
            ? 'schema'
            : literalKeys.has(key) || key.startsWith('x-')
              ? 'literal'
              : maps.has(key)
                ? 'map'
                : 'schema',
        ),
      ]),
    );
    if (role === 'schema' && node.properties && Object.hasOwn(node.properties, '__proto__')) {
      changed = true;
      const patterns = result.patternProperties ?? {};
      let pattern = '^(?:__proto__)(?![\\s\\S])',
        attempts = 0;
      while (Object.hasOwn(patterns, pattern)) {
        if (++attempts > 128) throw new Error('reserved_property_pattern_limit');
        pattern += '(?:)';
      }
      result.patternProperties = Object.fromEntries([
        ...Object.entries(patterns),
        [pattern, { $ref: base + '#' + location + '/properties/__proto__' }],
      ]);
    }
    return result;
  };
  const result = walk(input, rootId, '');
  return changed ? { ...result, $id: rootId } : input;
}
