import { createHash } from 'node:crypto';
import { parseMimeType } from './mime-wire.mjs';
import { compiler } from './semantic-compare.mjs';
import { createAvroContext } from './asyncapi-avro.mjs';
import { protobufContext } from './asyncapi-protobuf.mjs';
import { createRamlContext } from './asyncapi-raml.mjs';
import { assertAsyncapiOpenapi30 } from './asyncapi-openapi.mjs';
import { createOpenapiDiscriminatorPlans } from './asyncapi-openapi-discriminator.mjs';
import {
  createDiscriminatorPlans,
  compileAsyncapiDiscriminator,
} from './asyncapi-discriminator.mjs';
import {
  legacySchemaDialect,
  assertLegacySchemaKeywords,
} from '../../core/src/schema-dialects.mjs';
const draft7 = 'http://json-schema.org/draft-07/schema#';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const escape = (value) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => {
  throw new Error(reason);
};
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const singles = new Set([
  'items',
  'additionalItems',
  'contains',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const literals = new Set([
  'const',
  'enum',
  'default',
  'example',
  'examples',
  'xml',
  'externalDocs',
]);
const schemaChildren = (node, visit) => {
  for (const [key, value] of Object.entries(node)) {
    if (maps.has(key))
      for (const [name, child] of Object.entries(value))
        visit(child, '/' + key + '/' + escape(name));
    else if (arrays.has(key) || (key === 'items' && Array.isArray(value)))
      value.forEach((child, index) => visit(child, '/' + key + '/' + index));
    else if (singles.has(key)) visit(value, '/' + key);
    else if (key === 'dependencies')
      for (const [name, child] of Object.entries(value))
        if (!Array.isArray(child)) visit(child, '/dependencies/' + escape(name));
  }
};
export function asyncapiParserInput(source) {
  const walk = (node, pointer = '') => {
    if (Array.isArray(node)) return node.map((child, index) => walk(child, pointer + '/' + index));
    if (!object(node)) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        const path = pointer + '/' + escape(key);
        const schema =
          ['payload', 'headers'].includes(key) || /^\/components\/schemas\/[^/]+$/.test(path);
        return [
          key,
          schema
            ? typeof value === 'boolean'
              ? value
                ? {}
                : { not: {} }
              : structuredClone(value)
            : literals.has(key) || key.startsWith('x-')
              ? structuredClone(value)
              : walk(value, path),
        ];
      }),
    );
  };
  return walk(source);
}
export function asyncapiSchemaFormat(raw, format, version) {
  const selection = object(raw) ? raw['x-paritydiff-message-type'] : undefined;
  const imports = object(raw) ? raw['x-paritydiff-protobuf-imports'] : undefined;
  const ramlImports = object(raw) ? raw['x-paritydiff-raml-imports'] : undefined;
  if (object(raw) && Object.hasOwn(raw, 'schemaFormat') && Object.hasOwn(raw, 'schema')) {
    format = raw.schemaFormat;
    raw = raw.schema;
  }
  const type = parseMimeType(format ?? 'application/vnd.aai.asyncapi;version=' + version);
  if (type.essence === 'application/raml+yaml' && type.params.get('version') === '1.0')
    return { schema: raw, kind: 'raml', format, imports: ramlImports };
  if (
    type.essence === 'application/vnd.google.protobuf' &&
    ['2', '3'].includes(type.params.get('version'))
  )
    return {
      schema: raw,
      kind: 'protobuf',
      format,
      version: type.params.get('version'),
      selection,
      imports,
    };
  if (
    /^application\/vnd\.apache\.avro(?:\+(?:json|yaml))?$/.test(type.essence) &&
    ['1.9.0', '1.11.0'].includes(type.params.get('version'))
  )
    return { schema: raw, kind: 'avro', format };
  if (typeof raw !== 'boolean' && !object(raw)) unavailable('asyncapi_payload_schema_unspecified');
  let dialect;
  if (
    /^application\/vnd\.aai\.asyncapi(?:\+(?:json|yaml))?$/.test(type.essence) &&
    type.params.get('version') === version
  )
    dialect = draft7;
  else if (['application/schema+json', 'application/schema+yaml'].includes(type.essence))
    dialect =
      new Map([
        ['draft-07', draft7],
        ['draft-06', 'http://json-schema.org/draft-06/schema#'],
        ['draft-2019-09', 'https://json-schema.org/draft/2019-09/schema'],
        ['draft-2020-12', 'https://json-schema.org/draft/2020-12/schema'],
      ]).get(type.params.get('version')) ??
      (type.params.size === 0 && object(raw) ? raw.$schema : undefined);
  else if (
    /^application\/vnd\.oai\.openapi(?:\+(?:json|yaml))?$/.test(type.essence) &&
    type.params.get('version') === '3.0.0'
  )
    dialect = 'openapi3.0';
  if (
    !dialect ||
    (object(raw) &&
      raw.$schema &&
      raw.$schema !== dialect &&
      !(
        legacySchemaDialect(raw.$schema) &&
        legacySchemaDialect(dialect) &&
        legacySchemaDialect(raw.$schema).uri === legacySchemaDialect(dialect).uri
      ))
  )
    unavailable('asyncapi_schema_format_unavailable');
  if (
    !legacySchemaDialect(dialect) &&
    ![
      'https://json-schema.org/draft/2019-09/schema',
      'https://json-schema.org/draft/2020-12/schema',
      'openapi3.0',
    ].includes(dialect)
  )
    unavailable('asyncapi_schema_dialect_unavailable');
  return {
    schema: raw,
    dialect,
    format,
    kind:
      dialect === 'openapi3.0'
        ? 'openapi30'
        : /^application\/vnd\.aai\.asyncapi/.test(type.essence)
          ? 'asyncapi'
          : 'jsonschema',
  };
}
export function createAsyncapiSchemas(source) {
  const base = 'https://paritydiff.invalid/asyncapi/' + digest(JSON.stringify(source));
  const locations = new Map(),
    ids = new Map(),
    anchors = new Map();
  let nodes = 0;
  const register = (map, key, context) => {
    if (map.has(key) && map.get(key).pointer !== context.pointer)
      unavailable('asyncapi_schema_identifier_ambiguous');
    map.set(key, context);
  };
  const walk = (node, pointer, parent, dialect, depth = 0, kind = 'asyncapi') => {
    if (++nodes > 20000 || depth > 128) unavailable('asyncapi_schema_resource_limit');
    if (locations.has(pointer)) return;
    if (typeof node !== 'boolean' && !object(node)) unavailable('asyncapi_schema_invalid');
    let scope = parent;
    if (object(node) && typeof node.$id === 'string') scope = new URL(node.$id, parent).href;
    const context = { node, pointer, base: scope, dialect, kind };
    locations.set(pointer, context);
    if (object(node)) {
      if (typeof node.$id === 'string') {
        const uri = new URL(scope);
        if (uri.hash) {
          register(anchors, scope, context);
          uri.hash = '';
          context.base = uri.href;
        } else register(ids, scope, context);
      }
      for (const key of ['$anchor', '$dynamicAnchor'])
        if (typeof node[key] === 'string')
          register(anchors, context.base + '#' + node[key], context);
      schemaChildren(node, (child, suffix) =>
        walk(child, pointer + suffix, context.base, dialect, depth + 1, kind),
      );
    }
  };
  let discovery = 0;
  const discover = (node, pointer = '', depth = 0) => {
    if (++discovery > 200000 || depth > 128) unavailable('asyncapi_schema_resource_limit');
    if (Array.isArray(node)) {
      node.forEach((child, index) => discover(child, pointer + '/' + index, depth + 1));
      return;
    }
    if (!object(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (literals.has(key) || key.startsWith('x-')) continue;
      const path = pointer + '/' + escape(key);
      if (
        ['payload', 'headers'].includes(key) ||
        /^\/components\/schemas\/[^/]+$/.test(path) ||
        (key === 'schema' && !Object.hasOwn(node, 'schemaFormat'))
      ) {
        let chosen;
        try {
          chosen = asyncapiSchemaFormat(value, node.schemaFormat, source.asyncapi);
        } catch {
          continue;
        }
        if (['avro', 'protobuf', 'raml'].includes(chosen.kind)) continue;
        walk(
          chosen.schema,
          path + (chosen.schema === value ? '' : '/schema'),
          base,
          chosen.dialect,
          0,
          chosen.kind,
        );
      } else discover(value, path, depth + 1);
    }
  };
  discover(source);
  const pointerAt = (pointer) => {
    let node = source;
    for (const part of pointer ? pointer.slice(1).split('/') : []) {
      if (/~(?![01])/.test(part)) unavailable('asyncapi_reference_invalid');
      const name = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, name))
        unavailable('asyncapi_reference_missing');
      node = node[name];
    }
    return node;
  };
  const protocolObject = (pointer) => {
    const seen = new Set();
    for (let depth = 0; depth < 64; depth++) {
      if (seen.has(pointer)) unavailable('asyncapi_reference_cycle');
      seen.add(pointer);
      const node = pointerAt(pointer);
      if (!object(node) || typeof node.$ref !== 'string')
        return { node, pointer, pointers: [...seen] };
      const uri = new URL(node.$ref, base);
      const fragment = decodeURIComponent(uri.hash.slice(1));
      uri.hash = '';
      if (uri.href !== base || !fragment.startsWith('/'))
        unavailable('asyncapi_reference_not_captured');
      pointer = fragment;
    }
    unavailable('asyncapi_reference_resource_limit');
  };
  const resolve = (ref, parent) => {
    const uri = new URL(ref, parent),
      fragment = decodeURIComponent(uri.hash.slice(1));
    uri.hash = '';
    const root = ids.get(uri.href);
    if (!fragment) return root ?? unavailable('asyncapi_reference_not_schema');
    if (!fragment.startsWith('/'))
      return (
        anchors.get(uri.href + '#' + fragment) ?? unavailable('asyncapi_reference_not_captured')
      );
    const target =
      (uri.href === base ? '' : (root?.pointer ?? unavailable('asyncapi_reference_not_captured'))) +
      fragment;
    let found = locations.get(target);
    if (!found) {
      const wrapped = pointerAt(target);
      if (
        object(wrapped) &&
        Object.hasOwn(wrapped, 'schemaFormat') &&
        Object.hasOwn(wrapped, 'schema')
      )
        found = locations.get(target + '/schema');
    }
    return found ?? unavailable('asyncapi_reference_not_schema');
  };
  const compileContext = (raw, format) => {
    const chosen = asyncapiSchemaFormat(raw, format, source.asyncapi);
    if (chosen.kind === 'raml')
      return createRamlContext(chosen.schema, chosen.format, chosen.imports);
    if (chosen.kind === 'avro') return createAvroContext(chosen.schema, source, chosen.format);
    if (chosen.kind === 'protobuf')
      return protobufContext(
        chosen.schema,
        chosen.format,
        chosen.version,
        chosen.selection,
        chosen.imports,
      );
    const resources = new Map(),
      queue = [];
    const add = (context) => {
      if (context.dialect !== chosen.dialect)
        unavailable('asyncapi_mixed_schema_dialect_unavailable');
      if (context.kind !== chosen.kind) unavailable('asyncapi_reference_schema_format_mismatch');
      const id = base + '/schema/' + digest(context.pointer);
      if (!resources.has(id)) {
        if (resources.size >= 128) unavailable('asyncapi_schema_resource_limit');
        resources.set(id, undefined);
        queue.push({ id, context });
      }
      return id;
    };
    const discriminatorPlan =
      chosen.kind === 'asyncapi'
        ? createDiscriminatorPlans(locations, resolve, add)
        : chosen.kind === 'openapi30'
          ? createOpenapiDiscriminatorPlans(locations, resolve, add)
          : () => undefined;
    let count = 0,
      nativePlan,
      nativeDiscriminator = false;
    const convert = (node, parent, role = 'schema', depth = 0, scoped = false) => {
      if (++count > 100000 || depth > 128) unavailable('asyncapi_schema_resource_limit');
      if (!node || typeof node !== 'object' || role === 'literal') return structuredClone(node);
      if (Array.isArray(node)) return node.map((child) => convert(child, parent, role, depth + 1));
      let scope = parent;
      if (role === 'schema') {
        if (
          node.$schema !== undefined &&
          node.$schema !== chosen.dialect &&
          !(
            legacySchemaDialect(node.$schema) &&
            legacySchemaDialect(chosen.dialect) &&
            legacySchemaDialect(node.$schema).uri === legacySchemaDialect(chosen.dialect).uri
          )
        )
          unavailable('asyncapi_mixed_schema_dialect_unavailable');
        if (
          (Object.hasOwn(node, 'discriminator') && !(depth === 0 && nativePlan)) ||
          ['$dynamicRef', '$recursiveRef', '$dynamicAnchor', '$recursiveAnchor'].some((key) =>
            Object.hasOwn(node, key),
          )
        )
          unavailable('asyncapi_schema_semantics_unavailable');
        if (!scoped && typeof node.$id === 'string') scope = new URL(node.$id, parent).href;
        if (
          typeof node.$ref === 'string' &&
          (legacySchemaDialect(chosen.dialect) || chosen.dialect === 'openapi3.0')
        )
          return { $ref: add(resolve(node.$ref, scope)) };
      }
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => role !== 'schema' || !['$id', '$anchor'].includes(key))
          .map(([key, value]) => [
            key,
            role === 'schema' && key === '$ref' && typeof value === 'string'
              ? add(resolve(value, scope))
              : convert(
                  value,
                  scope,
                  role === 'map'
                    ? 'schema'
                    : literals.has(key) || key.startsWith('x-')
                      ? 'literal'
                      : maps.has(key) || key === 'dependencies' || key === 'dependentRequired'
                        ? 'map'
                        : 'schema',
                  depth + 1,
                ),
          ]),
      );
    };
    const selected = {
      node: chosen.schema,
      pointer: 'selected-' + digest(JSON.stringify(chosen.schema)),
      base,
      dialect: chosen.dialect,
      kind: chosen.kind,
    };
    const selectedId = add(selected);
    for (let index = 0; index < queue.length; index++) {
      const { id, context } = queue[index];
      nativePlan = discriminatorPlan(context);
      if (chosen.kind === 'openapi30') assertAsyncapiOpenapi30(context.node);
      if (legacySchemaDialect(context.dialect))
        assertLegacySchemaKeywords(context.node, legacySchemaDialect(context.dialect).name);
      const transformed = convert(context.node, context.base, 'schema', 0, context !== selected);
      if (nativePlan) {
        transformed.discriminator = nativePlan;
        nativeDiscriminator = true;
      }
      resources.set(
        id,
        typeof transformed === 'boolean' ||
          (legacySchemaDialect(context.dialect) && typeof transformed.$ref === 'string')
          ? { $id: id, $schema: context.dialect, allOf: [transformed] }
          : {
              ...transformed,
              $id: id,
              ...(context.dialect === 'openapi3.0' ? {} : { $schema: context.dialect }),
            },
      );
    }
    const collected = [...resources.values()];
    if (chosen.kind === 'asyncapi') {
      const checks = [],
        values = [];
      const defaults = (schema, id, pointer = '', depth = 0) => {
        if (depth > 128 || checks.length > 2048)
          unavailable('asyncapi_schema_default_resource_limit');
        if (!object(schema)) return;
        if (Object.hasOwn(schema, 'default')) {
          checks.push({ $ref: id + '#' + pointer });
          values.push(schema.default);
        }
        schemaChildren(schema, (child, suffix) => defaults(child, id, pointer + suffix, depth + 1));
      };
      for (const resource of collected) defaults(resource, resource.$id);
      if (
        checks.length &&
        !(
          nativeDiscriminator
            ? compileAsyncapiDiscriminator({
                schema: {
                  type: 'array',
                  items: checks,
                  additionalItems: false,
                  minItems: checks.length,
                  maxItems: checks.length,
                },
                resources: collected,
                dialect: chosen.dialect,
              })
            : compiler(
                {
                  type: 'array',
                  items: checks,
                  additionalItems: false,
                  minItems: checks.length,
                  maxItems: checks.length,
                },
                collected,
                chosen.dialect,
              )
        )(values)
      )
        unavailable('asyncapi_schema_default_invalid');
    }
    return {
      schema: { $ref: selectedId },
      resources: collected,
      dialect: chosen.dialect,
      ...(nativeDiscriminator
        ? {
            kind: 'asyncapi-polymorphic',
            implementation:
              chosen.kind === 'openapi30'
                ? 'paritydiff-openapi-discriminator-v1'
                : 'paritydiff-asyncapi-discriminator-v1',
            format: chosen.kind === 'openapi30' ? chosen.format : undefined,
          }
        : {}),
    };
  };
  return { protocolObject, compileContext, base };
}
