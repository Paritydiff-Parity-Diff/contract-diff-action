import {
  schemaResourceGraph,
  schemaMaps,
  schemaLists,
  schemaSingles,
  initialSchemaScope,
  enterSchemaScope,
  resolveSchemaReference,
} from './schema-resource-graph.mjs';

const metadata = new Set([
  '$id',
  '$schema',
  '$anchor',
  '$dynamicAnchor',
  '$recursiveAnchor',
  '$vocabulary',
  '$comment',
  '$defs',
  'definitions',
  'x-paritydiff-vocabulary-profiles',
]);
const references = new Set(['$ref', '$dynamicRef', '$recursiveRef']);
const legacy = (context) => ['draft6', 'draft7', 'openapi3.0'].includes(context.kind);
const result = (valid) => ({ valid, properties: new Set(), items: new Set() });
const merge = (target, source) => {
  for (const property of source.properties) target.properties.add(property);
  for (const item of source.items) target.items.add(item);
};
const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

export function resourceSchemaShape(context) {
  const node = context.node;
  if (typeof node === 'boolean') return node;
  const shape = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      schemaMaps.has(key) || key === 'dependencies'
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              key === 'dependencies' && Array.isArray(child) ? child : true,
            ]),
          )
        : schemaLists.has(key) || (key === 'items' && Array.isArray(value))
          ? value.map(() => true)
          : schemaSingles.has(key)
            ? true
            : value,
    ]),
  );
  for (const name of ['$id', '$anchor', '$dynamicAnchor', '$recursiveAnchor']) delete shape[name];
  if (context.kind === 'openapi3.0') delete shape.$schema;
  return shape;
}
export function compoundCompiler(schema, resources, dialect, engineFor) {
  const graph = schemaResourceGraph(schema, resources, dialect);
  const predicates = new Map();
  for (const context of graph.contexts) {
    const node = context.node;
    if (typeof node === 'boolean') continue;
    const shape = resourceSchemaShape(context);
    const engine = engineFor(context.dialect);
    engine.validateSchema(shape);
    if (legacy(context) && typeof node.$ref === 'string') {
      context.predicate = () => true;
      continue;
    }
    engine.assertKeywords(shape);
    const local = Object.fromEntries(
      Object.entries(shape).filter(
        ([key]) =>
          !metadata.has(key) &&
          !references.has(key) &&
          !schemaMaps.has(key) &&
          !schemaLists.has(key) &&
          !schemaSingles.has(key) &&
          !['minContains', 'maxContains', 'dependencies'].includes(key),
      ),
    );
    if (node.dependencies)
      local.dependencies = Object.fromEntries(
        Object.entries(node.dependencies).filter(([, value]) => Array.isArray(value)),
      );
    const identity = context.dialect + ':' + JSON.stringify(local);
    if (!predicates.has(identity)) predicates.set(identity, engine.compile(local));
    context.predicate = predicates.get(identity);
    context.patterns = [...(context.maps.patternProperties ?? [])].map(([pattern, child]) => [
      new RegExp(pattern, 'u'),
      child,
    ]);
  }
  const validate = (value) => {
    const active = new Set();
    let steps = 0;
    const evaluate = (context, data, path, scope, depth) => {
      if (++steps > 100000 || depth > 256) throw new Error('schema_evaluation_resource_limit');
      scope = enterSchemaScope(context, scope);
      const identity = JSON.stringify([context.id, path, scope.identity]);
      if (active.has(identity)) throw new Error('schema_evaluation_cycle');
      active.add(identity);
      try {
        const node = context.node,
          output = result(true);
        if (typeof node === 'boolean') return result(node);
        if (!context.predicate(data)) return result(false);
        const apply = (child) => {
          const checked = evaluate(child, data, path, scope, depth + 1);
          if (checked.valid) merge(output, checked);
          return checked.valid;
        };
        for (const keyword of references)
          if (typeof node[keyword] === 'string') {
            const target = resolveSchemaReference(graph, context, keyword, scope);
            if (!apply(target)) return result(false);
            if (legacy(context)) return output;
          }
        for (const child of context.lists.allOf ?? []) if (!apply(child)) return result(false);
        for (const keyword of ['anyOf', 'oneOf'])
          if (context.lists[keyword]) {
            const successes = context.lists[keyword]
              .map((child) => evaluate(child, data, path, scope, depth + 1))
              .filter((checked) => checked.valid);
            if (!successes.length || (keyword === 'oneOf' && successes.length !== 1))
              return result(false);
            for (const checked of successes) merge(output, checked);
          }
        if (
          context.singles.not &&
          evaluate(context.singles.not, data, path, scope, depth + 1).valid
        )
          return result(false);
        if (context.singles.if) {
          const checked = evaluate(context.singles.if, data, path, scope, depth + 1);
          if (checked.valid) merge(output, checked);
          const branch = checked.valid ? context.singles.then : context.singles.else;
          if (branch && !apply(branch)) return result(false);
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const keys = Object.keys(data),
            declared = new Set();
          for (const keyword of ['dependentSchemas', 'dependencies'])
            for (const [name, child] of context.maps[keyword] ?? [])
              if (Object.hasOwn(data, name) && !apply(child)) return result(false);
          for (const [name, child] of context.maps.properties ?? [])
            if (Object.hasOwn(data, name)) {
              declared.add(name);
              output.properties.add(name);
              if (!evaluate(child, data[name], path + '/' + pointer(name), scope, depth + 1).valid)
                return result(false);
            }
          for (const [pattern, child] of context.patterns ?? [])
            for (const name of keys)
              if (pattern.test(name)) {
                declared.add(name);
                output.properties.add(name);
                if (
                  !evaluate(child, data[name], path + '/' + pointer(name), scope, depth + 1).valid
                )
                  return result(false);
              }
          if (context.singles.propertyNames)
            for (const name of keys)
              if (
                !evaluate(
                  context.singles.propertyNames,
                  name,
                  path + '/@property/' + pointer(name),
                  scope,
                  depth + 1,
                ).valid
              )
                return result(false);
          if (context.singles.additionalProperties)
            for (const name of keys)
              if (!declared.has(name)) {
                if (
                  !evaluate(
                    context.singles.additionalProperties,
                    data[name],
                    path + '/' + pointer(name),
                    scope,
                    depth + 1,
                  ).valid
                )
                  return result(false);
                output.properties.add(name);
              }
          if (context.singles.unevaluatedProperties)
            for (const name of keys)
              if (!output.properties.has(name)) {
                if (
                  !evaluate(
                    context.singles.unevaluatedProperties,
                    data[name],
                    path + '/' + pointer(name),
                    scope,
                    depth + 1,
                  ).valid
                )
                  return result(false);
                output.properties.add(name);
              }
        }
        if (Array.isArray(data)) {
          const tuple = context.lists.prefixItems ?? context.lists.items;
          if (tuple)
            for (let index = 0; index < Math.min(tuple.length, data.length); index++) {
              if (!evaluate(tuple[index], data[index], path + '/' + index, scope, depth + 1).valid)
                return result(false);
              output.items.add(index);
            }
          const tail = context.lists.items
            ? context.singles.additionalItems
            : context.singles.items;
          if (tail)
            for (let index = tuple?.length ?? 0; index < data.length; index++) {
              if (!evaluate(tail, data[index], path + '/' + index, scope, depth + 1).valid)
                return result(false);
              output.items.add(index);
            }
          if (context.singles.contains) {
            const matches = [];
            for (let index = 0; index < data.length; index++)
              if (
                evaluate(
                  context.singles.contains,
                  data[index],
                  path + '/' + index,
                  scope,
                  depth + 1,
                ).valid
              )
                matches.push(index);
            if (
              matches.length < (node.minContains ?? 1) ||
              matches.length > (node.maxContains ?? Infinity)
            )
              return result(false);
            if (context.kind === '2020') for (const index of matches) output.items.add(index);
          }
          if (context.singles.unevaluatedItems)
            for (let index = 0; index < data.length; index++)
              if (!output.items.has(index)) {
                if (
                  !evaluate(
                    context.singles.unevaluatedItems,
                    data[index],
                    path + '/' + index,
                    scope,
                    depth + 1,
                  ).valid
                )
                  return result(false);
                output.items.add(index);
              }
        }
        return output;
      } finally {
        active.delete(identity);
      }
    };
    const checked = evaluate(graph.root, value, '', initialSchemaScope(), 0);
    validate.errors = checked.valid
      ? null
      : [
          {
            keyword: 'resourceEvaluation',
            instancePath: '',
            message: 'must satisfy the captured schema resource graph',
          },
        ];
    return checked.valid;
  };
  validate.graph = graph;
  return validate;
}
