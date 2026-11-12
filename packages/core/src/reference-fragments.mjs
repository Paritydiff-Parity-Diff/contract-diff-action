const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
  'dependentRequired',
]);
const literals = new Set([
  'const',
  'enum',
  'default',
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
]);
export function normalizeReferenceFragments(input) {
  let nodes = 0;
  const reference = (value) => {
    const index = value.indexOf('#');
    if (index < 0) return value;
    const fragment = decodeURIComponent(value.slice(index + 1));
    if (fragment.startsWith('/') && /~(?![01])/.test(fragment))
      throw new Error('reference_fragment_pointer_invalid');
    return value.slice(0, index + 1) + fragment.split('/').map(encodeURIComponent).join('/');
  };
  const walk = (node, role = 'schema', depth = 0) => {
    if (++nodes > 20000 || depth > 128) throw new Error('reference_fragment_resource_limit');
    if (!node || typeof node !== 'object' || role === 'literal') return node;
    if (Array.isArray(node)) return node.map((child) => walk(child, role, depth + 1));
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        role === 'schema' &&
        ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
        typeof value === 'string'
          ? reference(value)
          : walk(
              value,
              role === 'map'
                ? 'schema'
                : literals.has(key) || key.startsWith('x-')
                  ? 'literal'
                  : maps.has(key)
                    ? 'map'
                    : 'schema',
              depth + 1,
            ),
      ]),
    );
  };
  return walk(input);
}
