import { createHash } from 'node:crypto';
import { schemaDialectKind, createSchemaEngine, formatAssertionDialect } from './schema-engine.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const groups = {
  core: [
    '$schema',
    '$id',
    '$ref',
    '$anchor',
    '$dynamicRef',
    '$dynamicAnchor',
    '$recursiveRef',
    '$recursiveAnchor',
    '$vocabulary',
    '$defs',
    'definitions',
    '$comment',
  ],
  applicator: [
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'dependentSchemas',
    'properties',
    'patternProperties',
    'additionalProperties',
    'propertyNames',
    'prefixItems',
    'items',
    'additionalItems',
    'contains',
    'dependencies',
  ],
  unevaluated: ['unevaluatedProperties', 'unevaluatedItems'],
  validation: [
    'type',
    'const',
    'enum',
    'multipleOf',
    'maximum',
    'minimum',
    'exclusiveMaximum',
    'exclusiveMinimum',
    'maxLength',
    'minLength',
    'pattern',
    'maxItems',
    'minItems',
    'uniqueItems',
    'maxContains',
    'minContains',
    'maxProperties',
    'minProperties',
    'required',
    'dependentRequired',
  ],
  'meta-data': [
    'title',
    'description',
    'default',
    'deprecated',
    'readOnly',
    'writeOnly',
    'examples',
  ],
  format: ['format'],
  'format-annotation': ['format'],
  'format-assertion': ['format'],
  content: ['contentEncoding', 'contentMediaType', 'contentSchema'],
};
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const singles = new Set([
  'items',
  'additionalItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
export const vocabularyCatalogKey = 'x-paritydiff-metaschemas';
const vocabularyAliasKey = 'x-paritydiff-metaschema-aliases';
const fail = (reason) => {
  throw new Error(reason);
};
export const knownSchemaDialect = (dialect) => {
  try {
    schemaDialectKind(dialect);
    return true;
  } catch {
    return false;
  }
};
export function capturedMetaschemas(resources = []) {
  return resources.flatMap((resource) =>
    Array.isArray(resource?.[vocabularyCatalogKey]) ? resource[vocabularyCatalogKey] : [],
  );
}
export function metaschemaCatalog(documents) {
  const aliases = [];
  const entries = [...documents].flatMap(([uri, value]) => {
    if (!record(value)) return [];
    const id = new URL(value.$id ?? uri, uri).href;
    const schema = { ...structuredClone(value), $id: id };
    if (id !== uri) aliases.push([uri, id]);
    return [schema];
  });
  return {
    $id:
      'https://paritydiff.invalid/dialect-catalog/' +
      createHash('sha256')
        .update(JSON.stringify([entries, aliases]))
        .digest('hex'),
    [vocabularyCatalogKey]: entries,
    [vocabularyAliasKey]: aliases,
  };
}

function metaschemaIndex(resources) {
  const contexts = [],
    uris = new Map(),
    anchors = new Map();
  const aliases = new Map();
  for (const [source, target] of resources.flatMap(
    (resource) => resource?.[vocabularyAliasKey] ?? [],
  )) {
    if (aliases.has(source) && aliases.get(source) !== target)
      fail('schema_metaschema_identity_conflict');
    aliases.set(source, target);
  }
  const normalize = (uri) => new URL(uri).href.replace(/#$/, '');
  const register = (map, uri, context) => {
    const previous = map.get(uri);
    if (
      previous &&
      (previous.dialect !== context.dialect ||
        JSON.stringify(previous.node) !== JSON.stringify(context.node) ||
        (map === anchors &&
          previous.locations === context.locations &&
          previous.pointer !== context.pointer))
    )
      fail('schema_metaschema_identity_conflict');
    if (!previous) map.set(uri, context);
  };
  const walk = (node, inherited, pointer, locations, depth = 0) => {
    if (!record(node) && typeof node !== 'boolean') return;
    if (contexts.length >= 20000 || depth > 128) fail('schema_vocabulary_resource_limit');
    const dialect = node?.$schema ?? inherited.dialect;
    const ignoresId =
      typeof node?.$ref === 'string' &&
      knownSchemaDialect(inherited.dialect) &&
      ['draft6', 'draft7', 'openapi3.0'].includes(schemaDialectKind(inherited.dialect));
    let base = inherited.base,
      owner = inherited.owner;
    const context = { node, dialect, pointer, locations, ancestors: inherited.ancestors ?? [] };
    if (typeof node?.$id === 'string' && !ignoresId) {
      base = normalize(new URL(node.$id, base).href);
      if (new URL(base).hash) fail('schema_metaschema_identity_conflict');
      owner = context;
      if (uris.size >= 256 && !uris.has(base)) fail('schema_vocabulary_resource_limit');
      register(uris, base, context);
    }
    if (!owner) fail('schema_metaschema_capture_invalid');
    Object.assign(context, { base, owner });
    contexts.push(context);
    locations.set(pointer, context);
    for (const key of ['$anchor', '$dynamicAnchor'])
      if (typeof node?.[key] === 'string') register(anchors, base + '#' + node[key], context);
    if (!record(node)) return;
    const child = (value, suffix) =>
      walk(
        value,
        {
          base,
          dialect,
          owner,
          ancestors: owner === context ? [...context.ancestors, owner] : context.ancestors,
        },
        pointer + suffix,
        locations,
        depth + 1,
      );
    const escape = (name) => name.replaceAll('~', '~0').replaceAll('/', '~1');
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key) && record(value))
        for (const [name, nested] of Object.entries(value))
          if (!(key === 'dependencies' && Array.isArray(nested)))
            child(nested, '/' + key + '/' + escape(name));
      if ((arrays.has(key) || key === 'items') && Array.isArray(value))
        value.forEach((nested, index) => child(nested, '/' + key + '/' + index));
      else if (singles.has(key)) child(value, '/' + key);
    }
  };
  for (const meta of capturedMetaschemas(resources)) {
    if (!record(meta) || typeof meta.$id !== 'string') fail('schema_metaschema_capture_invalid');
    walk(meta, { base: meta.$id, dialect: meta.$schema }, '', new Map());
  }
  for (const [source, target] of aliases)
    if (source !== target && uris.has(source)) fail('schema_metaschema_identity_conflict');
  const canonicalAddress = (value) => {
    const url = new URL(value);
    const fragment = url.hash;
    url.hash = '';
    let base = url.href;
    const seen = new Set();
    while (aliases.has(base)) {
      if (seen.has(base)) fail('schema_metaschema_identity_conflict');
      seen.add(base);
      base = aliases.get(base);
    }
    return base + fragment;
  };
  const resolve = (value) => {
    const url = new URL(canonicalAddress(value));
    const fragment = url.hash;
    url.hash = '';
    const base = url.href;
    const root = uris.get(base);
    if (!root) fail('schema_metaschema_unavailable');
    const decoded = decodeURIComponent(fragment.slice(1));
    let context;
    if (!decoded) context = root;
    else if (decoded.startsWith('/')) {
      if (decoded.split('/').some((token) => /~(?![01])/.test(token)))
        fail('schema_metaschema_unavailable');
      context = root.locations.get(root.pointer + decoded);
    } else context = anchors.get(base + '#' + decoded);
    if (!context) fail('schema_metaschema_unavailable');
    return context;
  };
  const uri = (context) =>
    context.owner.base +
    (context.pointer === context.owner.pointer
      ? ''
      : '#' +
        context.pointer
          .slice(context.owner.pointer.length)
          .split('/')
          .map(encodeURIComponent)
          .join('/'));
  const materialize = (owner) => {
    const schema = { ...structuredClone(owner.node), $id: owner.base, $schema: owner.dialect };
    for (const context of contexts) {
      if (
        context.locations !== owner.locations ||
        !(context === owner || context.pointer.startsWith(owner.pointer + '/'))
      )
        continue;
      let node = schema;
      for (const token of context.pointer.slice(owner.pointer.length).split('/').slice(1))
        node = node[token.replaceAll('~1', '/').replaceAll('~0', '~')];
      for (const key of ['$ref', '$dynamicRef'])
        if (typeof node?.[key] === 'string')
          node[key] = canonicalAddress(new URL(node[key], context.base).href);
    }
    return schema;
  };
  return { contexts, resolve, uri, materialize };
}
export function prepareSchemaVocabularies(
  schema,
  resources,
  declaredDialect,
  options = {},
  validateMeta,
) {
  const metas = capturedMetaschemas(resources),
    index = metaschemaIndex(resources),
    profiles = new Map(),
    active = new Set();
  const profile = (dialect) => {
    if (knownSchemaDialect(dialect)) return { dialect, base: dialect };
    if (profiles.has(dialect)) return profiles.get(dialect);
    if (active.has(dialect) || active.size >= 32) fail('schema_metaschema_dialect_cycle');
    const context = index.resolve(dialect),
      meta = context.node;
    active.add(dialect);
    const parent = profile(context.dialect),
      kind = schemaDialectKind(parent.base);
    if (!['2019', '2020'].includes(kind)) fail('schema_custom_legacy_dialect_unavailable');
    const prefix =
      'https://json-schema.org/draft/' + (kind === '2019' ? '2019-09' : '2020-12') + '/vocab/';
    const vocabularies = meta.$vocabulary;
    if (vocabularies !== undefined && !record(vocabularies))
      fail('schema_vocabulary_declaration_invalid');
    const enabled = new Set(),
      optional = [];
    let assertsFormats = false;
    for (const [uri, required] of Object.entries(
      vocabularies ??
        Object.fromEntries(
          Object.keys(groups)
            .filter((name) =>
              kind === '2019'
                ? !['unevaluated', 'format-annotation', 'format-assertion'].includes(name)
                : !['format', 'format-assertion'].includes(name),
            )
            .map((name) => [prefix + name, true]),
        ),
    )) {
      if (typeof required !== 'boolean' || !/^[a-z][a-z0-9+.-]*:/i.test(uri))
        fail('schema_vocabulary_declaration_invalid');
      const name = uri.startsWith(prefix) ? uri.slice(prefix.length) : undefined;
      if (
        !name ||
        !Object.hasOwn(groups, name) ||
        (kind === '2019' &&
          ['unevaluated', 'format-annotation', 'format-assertion'].includes(name)) ||
        (kind === '2020' && name === 'format')
      ) {
        if (required) fail('schema_required_vocabulary_unavailable');
        optional.push(uri);
        continue;
      }
      for (const keyword of groups[name]) enabled.add(keyword);
      if (kind === '2019' && name === 'applicator')
        for (const keyword of groups.unevaluated) enabled.add(keyword);
      if (name === 'format-assertion') assertsFormats = true;
    }
    if (vocabularies && vocabularies[prefix + 'core'] !== true)
      fail('schema_core_vocabulary_required');
    const result = {
      dialect,
      base: assertsFormats
        ? formatAssertionDialect
        : 'https://json-schema.org/draft/' + (kind === '2019' ? '2019-09' : '2020-12') + '/schema',
      enabled,
      assertsFormats,
      optional,
    };
    profiles.set(dialect, result);
    active.delete(dialect);
    return result;
  };
  let steps = 0,
    changed = false;
  const walk = (node, inherited, depth = 0) => {
    if (++steps > 20000 || depth > 128) fail('schema_vocabulary_resource_limit');
    if (!record(node)) return node;
    const selected = profile(node.$schema ?? inherited);
    if (selected.enabled) {
      if (node.$schema || depth === 0)
        validateMeta?.(
          node.$schema ? node : { ...node, $schema: selected.dialect },
          selected.base,
          metas,
        );
      changed = true;
    }
    const output = Object.create(null);
    for (const [key, value] of Object.entries(node)) {
      if (selected.enabled && !selected.enabled.has(key)) continue;
      if (
        key === 'format' &&
        selected.enabled &&
        options.formatAssertions === 'dialect' &&
        !selected.assertsFormats
      )
        continue;
      if (key === '$schema') output[key] = selected.base;
      else if (maps.has(key) && record(value))
        output[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            key === 'dependencies' && Array.isArray(child)
              ? structuredClone(child)
              : walk(child, selected.dialect, depth + 1),
          ]),
        );
      else if (
        (arrays.has(key) || (key === 'items' && Array.isArray(value))) &&
        Array.isArray(value)
      )
        output[key] = value.map((child) => walk(child, selected.dialect, depth + 1));
      else if (singles.has(key)) output[key] = walk(value, selected.dialect, depth + 1);
      else output[key] = structuredClone(value);
    }
    return output;
  };
  const dialect =
    schema?.$schema ?? declaredDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  const root = profile(dialect);
  const prepared = walk(schema, dialect);
  if (changed && record(prepared) && !Object.hasOwn(prepared, '$schema'))
    prepared.$schema = root.base;
  const normalized = resources
    .filter((resource) => !Object.hasOwn(resource ?? {}, vocabularyCatalogKey))
    .map((resource) => walk(resource, dialect));
  return {
    schema: prepared,
    resources: normalized,
    dialect: root.base,
    changed,
    profiles: [...profiles.values()].map((p) => ({
      dialect: p.dialect,
      base: p.base,
      vocabularies: [...p.enabled].sort(),
      optionalVocabularies: p.optional,
      formatAssertions: p.assertsFormats,
    })),
  };
}

export function prepareCapturedSchema(schema, resources, dialect, options = {}) {
  const validators = new Map(),
    index = metaschemaIndex(resources);
  return prepareSchemaVocabularies(schema, resources, dialect, options, (node, base) => {
    const selected = new Map();
    const collect = (uri) => {
      if (knownSchemaDialect(uri)) return;
      const target = index.resolve(uri),
        owner = target.owner;
      if (selected.has(owner.base)) return;
      selected.set(owner.base, owner);
      collect(owner.dialect);
      for (const context of index.contexts) {
        if (
          context.locations !== owner.locations ||
          !(context === owner || context.pointer.startsWith(owner.pointer + '/'))
        )
          continue;
        for (const key of ['$ref', '$schema', '$dynamicRef', '$recursiveRef'])
          if (typeof context.node?.[key] === 'string')
            collect(new URL(context.node[key], context.base).href);
      }
    };
    collect(node.$schema);
    const identity = base + ':' + node.$schema;
    if (!validators.has(identity)) {
      const owners = [...selected.values()].filter(
        (owner) => !owner.ancestors.some((ancestor) => selected.has(ancestor.base)),
      );
      const preparedMetas = owners.map(
        (owner) =>
          prepareSchemaVocabularies(index.materialize(owner), resources, owner.dialect, options)
            .schema,
      );
      const engine = createSchemaEngine(base, (value) => value, { metaSchemas: preparedMetas });
      const validate = (value, declared) => {
        if (knownSchemaDialect(declared)) {
          engine.validateSchema({ ...value, $schema: declared });
          return;
        }
        if (!engine.compile({ $ref: index.uri(index.resolve(declared)) })(value))
          fail('schema_metaschema_invalid');
      };
      for (const owner of selected.values()) validate(owner.node, owner.dialect);
      validators.set(identity, validate);
    }
    validators.get(identity)(node, node.$schema);
  });
}

export function prepareCapturedContract(input, resources, defaultDialect) {
  const profiles = new Map();
  const root = record(input) ? input : undefined;
  const remember = (result) => {
    for (const entry of result.profiles) profiles.set(entry.dialect, entry);
    return result.schema;
  };
  if (!root || (!root.openapi && root.swagger !== '2.0')) {
    const result = prepareCapturedSchema(input, resources, root?.$schema ?? defaultDialect);
    return { document: remember(result), profiles: [...profiles.values()] };
  }
  const inherited = root.jsonSchemaDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  let steps = 0;
  const memberMaps = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'schemas',
    'paths',
    'responses',
    'headers',
    'content',
    'requestBodies',
    'callbacks',
    'webhooks',
  ]);
  const walk = (node, pointer = '', role = 'structure', depth = 0) => {
    if (++steps > 200000 || depth > 128) fail('schema_vocabulary_resource_limit');
    if (!node || typeof node !== 'object' || role === 'literal') return structuredClone(node);
    if (Array.isArray(node))
      return node.map((child, index) => walk(child, pointer + '/' + index, role, depth + 1));
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        const path = pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
        if (
          (role === 'structure' && key === 'schema') ||
          /^\/(components\/schemas|definitions)\/[^/]+$/.test(path)
        )
          return [key, remember(prepareCapturedSchema(value, resources, inherited))];
        return [
          key,
          walk(
            value,
            path,
            role === 'members'
              ? 'structure'
              : ['enum', 'const', 'example', 'examples', 'default'].includes(key) ||
                  key.startsWith('x-')
                ? 'literal'
                : memberMaps.has(key)
                  ? 'members'
                  : 'structure',
            depth + 1,
          ),
        ];
      }),
    );
  };
  const document = walk(input);
  if (!knownSchemaDialect(inherited))
    document.jsonSchemaDialect = prepareSchemaVocabularies({}, resources, inherited).dialect;
  return { document, profiles: [...profiles.values()] };
}

export function prepareCapturedDocuments(entries) {
  if (!Array.isArray(entries) || entries.length > 256) fail('schema_metaschema_capture_invalid');
  const documents = new Map(entries),
    catalog = metaschemaCatalog(documents),
    profiles = [];
  const root = entries[0]?.[1],
    defaultDialect =
      root?.$schema ?? root?.jsonSchemaDialect ?? 'https://json-schema.org/draft/2020-12/schema';
  const prepared = [...documents].map(([uri, document]) => {
    const result = prepareCapturedContract(document, [catalog], defaultDialect);
    profiles.push(...result.profiles);
    return [uri, result.document];
  });
  return { documents: prepared, profiles };
}
