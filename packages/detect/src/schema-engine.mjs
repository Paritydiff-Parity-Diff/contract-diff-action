import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  legacySchemaDialect,
  legacySchemaUris,
  assertLegacySchemaKeywords,
} from '../../core/src/schema-dialects.mjs';
import { bindValidationProperties } from '../../core/src/validation-properties.mjs';
import { bindReferenceSemantics } from '../../core/src/reference-semantics.mjs';
import { normalizeReferenceFragments } from '../../core/src/reference-fragments.mjs';
import { installExactMultipleOf } from '../../core/src/number-validation.mjs';
import { installInternationalFormats } from './international-formats.mjs';
import { installStandardFormats } from './standard-formats.mjs';

const require = createRequire(import.meta.url);
const draft6Meta = require('ajv/dist/refs/json-schema-draft-06.json');
export const formatAssertionDialect =
  'https://paritydiff.invalid/dialects/2020-12-format-assertion';
const formatAssertionMeta = {
  $id: formatAssertionDialect,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $dynamicAnchor: 'meta',
  $vocabulary: {
    ...require('ajv/dist/refs/json-schema-2020-12/schema.json').$vocabulary,
    'https://json-schema.org/draft/2020-12/vocab/format-assertion': true,
  },
  allOf: [{ $ref: 'https://json-schema.org/draft/2020-12/schema' }],
};
const profiles = ['3.1', '3.2'].map((version) => ({
  version,
  meta: JSON.parse(
    readFileSync(new URL('./schemas/openapi-' + version + '-meta.json', import.meta.url), 'utf8'),
  ),
  dialect: JSON.parse(
    readFileSync(
      new URL('./schemas/openapi-' + version + '-dialect.json', import.meta.url),
      'utf8',
    ),
  ),
}));
const dialects = new Map([
  ...legacySchemaUris.map((uri) => [uri, Ajv]),
  ['https://json-schema.org/draft/2019-09/schema', Ajv2019],
  ['https://json-schema.org/draft/2020-12/schema', Ajv2020],
  [formatAssertionDialect, Ajv2020],
  ['openapi3.0', Ajv2020],
  ...profiles.flatMap(({ version, dialect }) => [
    [dialect.$id, Ajv2020],
    ['https://spec.openapis.org/oas/' + version + '/dialect/base', Ajv2020],
  ]),
]);
export const builtinMetaSchemas = new Map(
  [
    formatAssertionMeta,
    draft6Meta,
    require('ajv/dist/refs/json-schema-draft-07.json'),
    ...['2019-09', '2020-12'].flatMap((version) => [
      require('ajv/dist/refs/json-schema-' + version + '/schema.json'),
      ...[
        'core',
        'applicator',
        'validation',
        'meta-data',
        'content',
        ...(version === '2019-09' ? ['format'] : ['format-annotation', 'unevaluated']),
      ].map((name) => require('ajv/dist/refs/json-schema-' + version + '/meta/' + name + '.json')),
    ]),
    ...profiles.flatMap((profile) => [profile.meta, profile.dialect]),
  ].flatMap((meta) =>
    [
      ...new Set([
        meta.$id.replace(/#$/, ''),
        meta.$id.replace(/^http:/, 'https:').replace(/#$/, ''),
      ]),
    ].map((id) => [id, meta]),
  ),
);
export function schemaDialectKind(dialect) {
  const C = dialects.get(String(dialect).replace(/#$/, ''));
  if (!C) throw new Error('unsupported_schema_dialect');
  return (
    legacySchemaDialect(dialect)?.name ??
    (dialect === 'openapi3.0' ? 'openapi3.0' : C === Ajv2019 ? '2019' : '2020')
  );
}
export function schemaFormatAssertions(dialect, policy = true) {
  if (![true, false, 'dialect'].includes(policy)) throw new Error('schema_format_policy_invalid');
  if (String(dialect).replace(/#$/, '') === formatAssertionDialect) return true;
  return policy === 'dialect'
    ? dialect === formatAssertionDialect ||
        ['draft6', 'draft7', 'openapi3.0'].includes(schemaDialectKind(dialect))
    : policy;
}
export function createSchemaEngine(dialect, adapt, options = {}) {
  const kind = schemaDialectKind(dialect),
    C = dialects.get(String(dialect).replace(/#$/, ''));
  const ajv = new C({
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allErrors: false,
    ownProperties: true,
    allowMatchingProperties: true,
    ignoreKeywordsWithRef: C === Ajv || kind === 'openapi3.0',
    logger: false,
    validateFormats: schemaFormatAssertions(dialect, options.formatAssertions ?? true),
  });
  addFormats(ajv);
  installInternationalFormats(ajv);
  installStandardFormats(ajv);
  if (C === Ajv2020 || C === Ajv2019) ajv.addKeyword('$anchor');
  if (C === Ajv) ajv.addMetaSchema(draft6Meta);
  if (C === Ajv2020) ajv.addMetaSchema(formatAssertionMeta);
  if (C === Ajv2020)
    for (const { version, meta, dialect: profile } of profiles) {
      ajv.addMetaSchema(meta).addMetaSchema(profile);
      if (profile.$id !== 'https://spec.openapis.org/oas/' + version + '/dialect/base')
        ajv.addMetaSchema({
          ...profile,
          $id: 'https://spec.openapis.org/oas/' + version + '/dialect/base',
        });
    }
  const pendingMetas = [...(options.metaSchemas ?? [])].filter(
    (meta) => typeof meta?.$id === 'string' && !ajv.getSchema(meta.$id),
  );
  while (pendingMetas.length) {
    const index = pendingMetas.findIndex((meta) => !meta.$schema || ajv.getSchema(meta.$schema));
    if (index < 0) throw new Error('schema_metaschema_dependency_unavailable');
    ajv.addMetaSchema(pendingMetas.splice(index, 1)[0], undefined, false);
  }
  for (const [format, validate] of Object.entries({
    int32: (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
    int64: Number.isSafeInteger,
    float: Number.isFinite,
    double: Number.isFinite,
  }))
    ajv.addFormat(format, { type: 'number', validate });
  ajv.addFormat('password', { type: 'string', validate: () => true });
  ajv.addFormat('byte', {
    type: 'string',
    validate: (value) =>
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
  });
  for (const key of [
    'example',
    'xml',
    'externalDocs',
    'discriminator',
    'x-paritydiff-resource-id',
    'x-paritydiff-vocabulary-profiles',
  ])
    ajv.addKeyword(key);
  installExactMultipleOf(ajv);
  if (options.nativeDiscriminator) {
    ajv.removeKeyword('discriminator');
    ajv.addKeyword({
      keyword: 'discriminator',
      schemaType: 'array',
      errors: false,
      validate: options.nativeDiscriminator,
    });
  }
  const bind = (value) => {
    if (C === Ajv) assertLegacySchemaKeywords(value, legacySchemaDialect(dialect).name);
    const converted = adapt(value, kind === 'openapi3.0');
    return normalizeReferenceFragments(
      bindValidationProperties(
        C === Ajv || kind === 'openapi3.0' ? bindReferenceSemantics(converted) : converted,
      ),
    );
  };
  const add = (schema) => {
    ajv.addSchema(schema);
    if ((C === Ajv2020 || C === Ajv2019) && typeof schema?.$anchor === 'string')
      ajv.addSchema(schema, String(schema.$id ?? '').split('#')[0] + '#' + schema.$anchor);
  };
  return {
    kind,
    getSchema: (id) => ajv.getSchema(id),
    validateSchema(value) {
      const bound = bind(value);
      const checked =
        bound && typeof bound === 'object' && !bound.$schema
          ? {
              ...bound,
              $schema:
                C === Ajv
                  ? legacySchemaDialect(dialect).uri
                  : kind === 'openapi3.0'
                    ? 'https://json-schema.org/draft/2020-12/schema'
                    : dialect,
            }
          : bound;
      if (!ajv.validateSchema(checked)) throw new Error('schema_metaschema_invalid');
    },
    assertKeywords(value) {
      const bound = bind(value);
      if (bound && typeof bound === 'object')
        for (const key of Object.keys(bound))
          if (!Object.hasOwn(ajv.RULES.keywords, key))
            throw new Error('schema_keyword_unavailable_for_declared_dialect');
    },
    compile(schema, resources = []) {
      const bound = bind(schema);
      const checked =
        C === Ajv && bound && typeof bound === 'object' && !bound.$schema
          ? { ...bound, $schema: legacySchemaDialect(dialect).uri }
          : bound;
      if (['2019', '2020'].includes(kind)) {
        if (!ajv.validateSchema(checked)) throw new Error('schema_metaschema_invalid');
        const emptyEnums = (value, role = 'schema') => {
          if (!value || typeof value !== 'object' || role === 'literal') return value;
          if (Array.isArray(value)) return value.map((child) => emptyEnums(child, role));
          const transformed = Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              emptyEnums(
                child,
                role === 'map'
                  ? 'schema'
                  : ['const', 'enum', 'default', 'example', 'examples'].includes(key)
                    ? 'literal'
                    : [
                          'properties',
                          'patternProperties',
                          '$defs',
                          'definitions',
                          'dependentSchemas',
                          'dependencies',
                        ].includes(key)
                      ? 'map'
                      : 'schema',
              ),
            ]),
          );
          if (role === 'schema' && Array.isArray(value.enum) && !value.enum.length) {
            transformed.enum = [null];
            transformed.allOf = [...(transformed.allOf ?? []), false];
          }
          return transformed;
        };
        const transformed = emptyEnums(checked);
        for (const resource of resources) {
          const boundResource = bind(resource);
          if (!ajv.validateSchema(boundResource)) throw new Error('schema_metaschema_invalid');
          add(emptyEnums(boundResource));
        }
        if (typeof transformed?.$anchor === 'string') add(transformed);
        return ajv.compile(transformed);
      }
      for (const resource of resources) add(bind(resource));
      return ajv.compile(checked);
    },
  };
}
