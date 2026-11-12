import {
  schemaResourceGraph,
  initialSchemaScope,
  enterSchemaScope,
  resolveSchemaReference,
} from './schema-resource-graph.mjs';
import { schemaFormatAssertions } from './schema-engine.mjs';
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
const referenceKeys = ['$ref', '$dynamicRef', '$recursiveRef'];
const legacy = (context) => ['draft6', 'draft7', 'openapi3.0'].includes(context.kind);
const annotations = new Set([
  ...metadata,
  'title',
  'description',
  'default',
  'examples',
  'example',
  'deprecated',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  'discriminator',
  'x-paritydiff-resource-id',
]);
const descending = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
]);

export function compoundReferenceEquivalent(before, after, options, canonical) {
  try {
    const a = schemaResourceGraph(before, options.beforeResources, options.beforeDialect),
      b = schemaResourceGraph(after, options.afterResources, options.afterDialect);
    if (a.contexts.length + b.contexts.length > 4096) return false;
    const active = new Map(),
      complete = new Set();
    let steps = 0;
    const compare = (left, right, leftScope, rightScope, progress = 0, depth = 0) => {
      if (++steps > 20000 || depth > 256) throw new Error('compound_reference_proof_limit');
      leftScope = enterSchemaScope(left, leftScope);
      rightScope = enterSchemaScope(right, rightScope);
      const key = JSON.stringify([left.id, right.id, leftScope.identity, rightScope.identity]);
      if (active.has(key)) return progress > active.get(key);
      if (complete.has(key)) return true;
      const x = left.node,
        y = right.node;
      const keys = (context) =>
        Object.keys(context.node)
          .filter(
            (name) =>
              !annotations.has(name) &&
              !referenceKeys.includes(name) &&
              !(
                name === 'format' &&
                !schemaFormatAssertions(context.dialect, options.formatAssertions ?? 'dialect')
              ),
          )
          .sort();
      const unconstrained = (context) =>
        context.node === true ||
        (context.node &&
          typeof context.node === 'object' &&
          !keys(context).length &&
          !referenceKeys.some((name) => typeof context.node[name] === 'string'));
      if (typeof x === 'boolean' || typeof y === 'boolean')
        return x === y || (unconstrained(left) && unconstrained(right));
      if (left.kind !== right.kind) return false;
      const xs = keys(left),
        ys = keys(right),
        xr = referenceKeys.filter((name) => typeof x[name] === 'string'),
        yr = referenceKeys.filter((name) => typeof y[name] === 'string');
      active.set(key, progress);
      const followsX = xr.length === 1 && (legacy(left) || !xs.length),
        followsY = yr.length === 1 && (legacy(right) || !ys.length);
      let valid;
      if (followsX || followsY) {
        valid = compare(
          followsX ? resolveSchemaReference(a, left, xr[0], leftScope) : left,
          followsY ? resolveSchemaReference(b, right, yr[0], rightScope) : right,
          leftScope,
          rightScope,
          progress,
          depth + 1,
        );
      } else {
        valid = xr.length === yr.length && JSON.stringify(xs) === JSON.stringify(ys);
        for (let index = 0; valid && index < xr.length; index++)
          valid = compare(
            resolveSchemaReference(a, left, xr[index], leftScope),
            resolveSchemaReference(b, right, yr[index], rightScope),
            leftScope,
            rightScope,
            progress,
            depth + 1,
          );
        for (const name of xs) {
          if (!valid) break;
          const next = progress + (descending.has(name) ? 1 : 0),
            nested = (p, q) => compare(p, q, leftScope, rightScope, next, depth + 1);
          if (left.maps[name] || right.maps[name]) {
            const p = left.maps[name],
              q = right.maps[name];
            valid =
              Boolean(p && q) &&
              JSON.stringify([...p.keys()].sort()) === JSON.stringify([...q.keys()].sort()) &&
              [...p].every(([key, child]) => nested(child, q.get(key)));
            if (valid && name === 'dependencies')
              valid =
                JSON.stringify(
                  canonical(
                    Object.fromEntries(Object.entries(x[name]).filter(([, v]) => Array.isArray(v))),
                    'literal',
                  ),
                ) ===
                JSON.stringify(
                  canonical(
                    Object.fromEntries(Object.entries(y[name]).filter(([, v]) => Array.isArray(v))),
                    'literal',
                  ),
                );
          } else if (left.lists[name] || right.lists[name]) {
            const p = left.lists[name],
              q = right.lists[name];
            valid =
              Boolean(p && q) &&
              p.length === q.length &&
              p.every((child, index) => nested(child, q[index]));
          } else if (left.singles[name] || right.singles[name])
            valid =
              Boolean(left.singles[name] && right.singles[name]) &&
              nested(left.singles[name], right.singles[name]);
          else
            valid =
              JSON.stringify(canonical({ [name]: x[name] })) ===
              JSON.stringify(canonical({ [name]: y[name] }));
        }
      }
      active.delete(key);
      if (valid) complete.add(key);
      return valid;
    };
    return compare(a.root, b.root, initialSchemaScope(), initialSchemaScope());
  } catch {
    return false;
  }
}

export function expandCompoundProof(schema, resources, dialect, adapt, options = {}) {
  const graph = schemaResourceGraph(schema, resources, dialect),
    active = new Set();
  let steps = 0;
  const expand = (context, scope, depth = 0) => {
    if (++steps > 10000 || depth > 64) throw new Error('compound_proof_resource_limit');
    scope = enterSchemaScope(context, scope);
    const identity = context.id + ':' + scope.identity;
    if (active.has(identity)) throw new Error('compound_proof_recursive_graph');
    if (typeof context.node === 'boolean') return context.node;
    active.add(identity);
    try {
      const refs = referenceKeys.filter((key) => typeof context.node[key] === 'string');
      if (legacy(context) && refs.length)
        return expand(resolveSchemaReference(graph, context, refs[0], scope), scope, depth + 1);
      if (
        context.kind === '2019' &&
        graph.contexts.some((child) => child.singles.unevaluatedItems) &&
        context.singles.contains
      )
        throw new Error('compound_proof_annotation_model_required');
      const output = Object.fromEntries(
        Object.entries(context.node).filter(
          ([key]) => !metadata.has(key) && !referenceKeys.includes(key),
        ),
      );
      for (const [key, children] of Object.entries(context.maps)) {
        if (metadata.has(key)) continue;
        output[key] = Object.fromEntries([
          ...(key === 'dependencies'
            ? Object.entries(context.node.dependencies).filter(([, value]) => Array.isArray(value))
            : []),
          ...[...children].map(([name, child]) => [name, expand(child, scope, depth + 1)]),
        ]);
      }
      for (const [key, children] of Object.entries(context.lists))
        output[key] = children.map((child) => expand(child, scope, depth + 1));
      for (const [key, child] of Object.entries(context.singles))
        output[key] = expand(child, scope, depth + 1);
      const translated = adapt(
        output,
        context.kind === 'openapi3.0',
        'schema',
        ['draft6', 'draft7', '2019'].includes(context.kind),
        true,
      );
      if (!schemaFormatAssertions(context.dialect, options.formatAssertions ?? true))
        delete translated.format;
      if (refs.length)
        translated.allOf = [
          ...refs.map((key) =>
            expand(resolveSchemaReference(graph, context, key, scope), scope, depth + 1),
          ),
          ...(translated.allOf ?? []),
        ];
      return translated;
    } finally {
      active.delete(identity);
    }
  };
  return expand(graph.root, initialSchemaScope());
}
