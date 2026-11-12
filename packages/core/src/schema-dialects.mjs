const dialects = new Map();
for (const version of ['06', '07'])
  for (const scheme of ['http', 'https'])
    for (const fragment of ['', '#'])
      dialects.set(
        scheme + '://json-schema.org/draft-' + version + '/schema' + fragment,
        Object.freeze({
          name: version === '06' ? 'draft6' : 'draft7',
          uri: 'http://json-schema.org/draft-' + version + '/schema#',
        }),
      );
export const legacySchemaUris = Object.freeze([...dialects.keys()]);
export const legacySchemaDialect = (uri) => dialects.get(uri);
const base = new Set([
  '$schema',
  '$id',
  '$ref',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'multipleOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'items',
  'additionalItems',
  'contains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'dependencies',
  'propertyNames',
  'definitions',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);
const draft7 = new Set([
  '$comment',
  'if',
  'then',
  'else',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding',
]);
const annotations = new Set([
  '$comment',
  'deprecated',
  'example',
  'xml',
  'externalDocs',
  'discriminator',
  'x-paritydiff-resource-id',
  'x-paritydiff-vocabulary-profiles',
  'x-paritydiff-http-bindings',
]);
const literals = new Set([
  'const',
  'enum',
  'default',
  'examples',
  'example',
  'xml',
  'externalDocs',
  'discriminator',
]);
const maps = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependencies']);
export function assertLegacySchemaKeywords(input, inherited) {
  const walk = (node, dialect, role = 'schema') => {
    if (!node || typeof node !== 'object' || role === 'literal') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, dialect, role);
      return;
    }
    if (role === 'schema' && node.$schema !== undefined) {
      const declared = legacySchemaDialect(node.$schema);
      if (!declared) throw new Error('unsupported_legacy_resource_dialect');
      dialect = declared.name;
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        role === 'schema' &&
        typeof node.$ref !== 'string' &&
        !base.has(key) &&
        !(dialect === 'draft7' && draft7.has(key)) &&
        !annotations.has(key)
      ) {
        const error = new Error('keyword_unavailable_for_declared_dialect');
        error.keyword = key;
        throw error;
      }
      walk(
        value,
        dialect,
        role === 'map'
          ? 'schema'
          : literals.has(key) || annotations.has(key)
            ? 'literal'
            : maps.has(key)
              ? 'map'
              : 'schema',
      );
    }
  };
  walk(input, inherited);
}
