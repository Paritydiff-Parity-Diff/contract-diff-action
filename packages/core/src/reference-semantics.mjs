import { legacySchemaDialect } from './schema-dialects.mjs';
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
const literals = new Set(['const', 'enum', 'default', 'example', 'examples']);
export function bindReferenceSemantics(input) {
  const walk = (node, role = 'schema', documentRoot = true) => {
    if (!node || typeof node !== 'object' || role === 'literal') return node;
    if (Array.isArray(node)) return node.map((child) => walk(child, role, false));
    return Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key]) =>
            role !== 'schema' ||
            typeof node.$ref !== 'string' ||
            !(['type', 'nullable'].includes(key) || (key === '$id' && !documentRoot)),
        )
        .map(([key, child]) => [
          key,
          walk(
            role === 'schema' && key === '$schema'
              ? (legacySchemaDialect(child)?.uri ?? child)
              : child,
            role === 'map'
              ? 'schema'
              : literals.has(key) || key.startsWith('x-')
                ? 'literal'
                : maps.has(key)
                  ? 'map'
                  : 'schema',
            false,
          ),
        ]),
    );
  };
  return walk(input);
}
