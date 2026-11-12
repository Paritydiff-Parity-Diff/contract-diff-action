import { schemaDialectKind, schemaFormatAssertions } from './schema-engine.mjs';

export const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
export const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
export const schemaSingles = new Set([
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
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const escape = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const invalid = () => {
  throw new Error('schema_resource_graph_invalid');
};
const address = (value, base) => {
  if (
    typeof value !== 'string' ||
    [...value].some((char) => char.codePointAt(0) <= 32 || char.codePointAt(0) === 127) ||
    /%(?![a-f0-9]{2})/i.test(value)
  )
    invalid();
  return new URL(value, base).href;
};
export function resourceDispatchRequired(schema, resources, dialect) {
  let steps = 0;
  const walk = (node, inherited, depth = 0) => {
    if (++steps > 10000 || depth > 128) throw new Error('schema_resource_graph_limit');
    if (!record(node)) return false;
    const active = node.$schema ?? inherited;
    const kind = schemaDialectKind(active);
    if (
      kind !== schemaDialectKind(inherited) ||
      (kind === '2019' &&
        (Object.hasOwn(node, 'contains') || Object.hasOwn(node, 'unevaluatedItems'))) ||
      schemaFormatAssertions(active, 'dialect') !== schemaFormatAssertions(inherited, 'dialect') ||
      ['$dynamicRef', '$recursiveRef', '$dynamicAnchor', '$recursiveAnchor'].some((key) =>
        Object.hasOwn(node, key),
      )
    )
      return true;
    for (const [key, value] of Object.entries(node)) {
      const children =
        schemaMaps.has(key) || key === 'dependencies'
          ? Object.values(value ?? {}).filter((child) => !Array.isArray(child))
          : schemaLists.has(key) || (key === 'items' && Array.isArray(value))
            ? value
            : schemaSingles.has(key)
              ? [value]
              : [];
      if (!Array.isArray(children)) throw new Error('schema_resource_graph_invalid');
      if (children.some((child) => walk(child, active, depth + 1))) return true;
    }
    return false;
  };
  return walk(schema, dialect) || resources.some((resource) => walk(resource, dialect));
}
export function schemaResourceGraph(
  schema,
  resources = [],
  defaultDialect = 'https://json-schema.org/draft/2020-12/schema',
  options = {},
) {
  const uris = new Map(),
    anchors = new Map(),
    contexts = [],
    documents = [];
  const register = (map, key, value) => {
    if (map.has(key) && map.get(key) !== value)
      throw new Error('schema_resource_identity_conflict');
    map.set(key, value);
  };
  let requiresDispatch = false,
    resourceCount = 0;
  const walk = (node, inherited, document, pointer, depth = 0) => {
    if (depth > 128 || contexts.length >= 10000) throw new Error('schema_resource_graph_limit');
    if (typeof node !== 'boolean' && !record(node)) invalid();
    let base = inherited.base,
      resource = inherited.resource,
      dialect = inherited.dialect;
    const ignoredReferenceSiblings =
      record(node) &&
      typeof node.$ref === 'string' &&
      ['draft6', 'draft7', 'openapi3.0'].includes(inherited.kind);
    const hasId = record(node) && Object.hasOwn(node, '$id') && !ignoredReferenceSiblings;
    if (record(node) && node.$schema !== undefined) {
      if (pointer && !hasId) throw new Error('schema_dialect_requires_resource_root');
      dialect = node.$schema;
    }
    const kind = schemaDialectKind(dialect);
    if (
      inherited.kind &&
      (kind !== inherited.kind ||
        schemaFormatAssertions(dialect, 'dialect') !==
          schemaFormatAssertions(inherited.dialect, 'dialect'))
    )
      requiresDispatch = true;
    let alias;
    if (hasId) {
      base = address(node.$id, inherited.base);
      const uri = new URL(base);
      if (uri.hash) {
        if (!['draft6', 'draft7', 'openapi3.0'].includes(kind)) invalid();
        alias = base;
      } else resource = undefined;
    }
    const context = {
      id: contexts.length,
      node,
      base,
      dialect,
      kind,
      document,
      pointer,
      maps: {},
      lists: {},
      singles: {},
    };
    contexts.push(context);
    document.locations.set(pointer, context);
    if (!resource) {
      if (++resourceCount > 256) throw new Error('schema_resource_count_limit');
      const uri = new URL(base);
      uri.hash = '';
      resource = { uri: uri.href, root: context, dynamicAnchors: new Map(), recursive: false };
      register(uris, uri.href, context);
    }
    context.resource = resource;
    context.recursive = node?.$recursiveAnchor === true;
    if (alias) register(anchors, alias, context);
    if (!record(node)) return context;
    for (const keyword of ['$anchor', '$dynamicAnchor'])
      if (Object.hasOwn(node, keyword)) {
        if (
          !['2019', '2020'].includes(kind) ||
          (keyword === '$dynamicAnchor' && kind !== '2020') ||
          typeof node[keyword] !== 'string' ||
          !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(node[keyword])
        )
          invalid();
        register(anchors, resource.uri + '#' + node[keyword], context);
        if (keyword === '$dynamicAnchor') {
          register(resource.dynamicAnchors, node[keyword], context);
          requiresDispatch = true;
        }
      }
    if (Object.hasOwn(node, '$recursiveAnchor')) {
      if (kind !== '2019' || typeof node.$recursiveAnchor !== 'boolean') invalid();
      if (context === resource.root) resource.recursive = node.$recursiveAnchor;
      requiresDispatch = true;
    }
    const child = (value, suffix) =>
      walk(value, { base, resource, dialect, kind }, document, pointer + suffix, depth + 1);
    for (const [key, value] of Object.entries(node)) {
      if (schemaMaps.has(key) || key === 'dependencies') {
        if (!record(value)) invalid();
        context.maps[key] = new Map();
        for (const [name, nested] of Object.entries(value)) {
          if (key === 'dependencies' && Array.isArray(nested)) continue;
          context.maps[key].set(name, child(nested, '/' + key + '/' + escape(name)));
        }
      } else if (schemaLists.has(key) || (key === 'items' && Array.isArray(value))) {
        if (!Array.isArray(value)) invalid();
        context.lists[key] = value.map((nested, index) => child(nested, '/' + key + '/' + index));
      } else if (schemaSingles.has(key)) context.singles[key] = child(value, '/' + key);
    }
    for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef'])
      if (Object.hasOwn(node, keyword)) {
        address(node[keyword], base);
        if (keyword === '$dynamicRef' && kind !== '2020') invalid();
        if (keyword === '$recursiveRef' && (kind !== '2019' || node[keyword] !== '#')) invalid();
        if (keyword !== '$ref') requiresDispatch = true;
      }
    return context;
  };
  const addDocument = (node, index) => {
    if (index && (!record(node) || typeof node.$id !== 'string')) invalid();
    const base = index
      ? address(node.$id, 'https://paritydiff.invalid/evaluation/resource')
      : 'https://paritydiff.invalid/evaluation/root';
    if (index && !/^[a-z][a-z0-9+.-]*:/i.test(node.$id)) invalid();
    const document = { locations: new Map() };
    documents.push(document);
    const context = walk(node, { base, dialect: defaultDialect }, document, '');
    register(uris, context.resource.uri, context);
    return context;
  };
  const root = addDocument(schema, 0);
  resources.forEach((node, index) => addDocument(node, index + 1));
  const resolve = (context, reference) => {
    const absolute = new URL(address(reference, context.base));
    const fragment = decodeURIComponent(absolute.hash.slice(1));
    absolute.hash = '';
    const target = uris.get(absolute.href);
    if (!target) throw new Error('schema_reference_unavailable');
    if (!fragment) return target;
    if (!fragment.startsWith('/')) return anchors.get(absolute.href + '#' + fragment) ?? invalid();
    for (const token of fragment.slice(1).split('/')) if (/~(?![01])/.test(token)) invalid();
    return target.document.locations.get(target.pointer + fragment) ?? invalid();
  };
  if (!options.allowUnresolvedReferences)
    for (const context of contexts)
      for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef'])
        if (typeof context.node?.[keyword] === 'string') resolve(context, context.node[keyword]);
  return { root, contexts, resolve, requiresDispatch };
}

export const initialSchemaScope = () => ({
  bindings: new Map(),
  recursiveBase: undefined,
  identity: '',
});
export function enterSchemaScope(context, scope) {
  let bindings = scope.bindings,
    recursiveBase = scope.recursiveBase;
  for (const [name, target] of context.resource.dynamicAnchors)
    if (!bindings.has(name)) {
      if (bindings === scope.bindings) bindings = new Map(bindings);
      bindings.set(name, target);
    }
  if (!recursiveBase && context.recursive) recursiveBase = context.base;
  return bindings === scope.bindings && recursiveBase === scope.recursiveBase
    ? scope
    : {
        bindings,
        recursiveBase,
        identity: JSON.stringify([
          [...bindings].map(([name, target]) => [name, target.id]),
          recursiveBase,
        ]),
      };
}
export function resolveSchemaReference(graph, context, keyword, scope) {
  let target = graph.resolve(context, context.node[keyword]);
  if (keyword === '$dynamicRef') {
    const fragment = decodeURIComponent(new URL(context.node[keyword], context.base).hash.slice(1));
    if (target.resource.dynamicAnchors.get(fragment) === target)
      target = scope.bindings.get(fragment) ?? target;
  } else if (keyword === '$recursiveRef' && target.recursive && scope.recursiveBase)
    target = graph.resolve({ ...context, base: scope.recursiveBase }, '#');
  return target;
}
