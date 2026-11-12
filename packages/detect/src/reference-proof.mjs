const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaSingles = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'items',
  'additionalItems',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
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
const metadata = new Set([
  '$id',
  '$schema',
  '$anchor',
  '$defs',
  'definitions',
  '$comment',
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
  'x-paritydiff-vocabulary-profiles',
]);
const record = (node) => node && typeof node === 'object' && !Array.isArray(node);
const reject = () => {
  throw new Error('reference_proof_unavailable');
};
function graph(root, resources, dialect) {
  let count = 0;
  const nodes = new WeakMap(),
    uris = new Map(),
    anchors = new Map();
  const register = (map, key, context) => {
    if (map.has(key) && map.get(key) !== context) reject();
    map.set(key, context);
  };
  const walk = (node, base, depth = 0) => {
    if (++count > 2048 || depth > 128 || (typeof node !== 'boolean' && !record(node))) reject();
    if (record(node) && nodes.has(node)) reject();
    if (record(node)) {
      if (
        ['$dynamicRef', '$recursiveRef', '$dynamicAnchor', '$recursiveAnchor'].some((key) =>
          Object.hasOwn(node, key),
        )
      )
        reject();
      if (node.$schema !== undefined && node.$schema !== dialect) reject();
      if (
        node.$id !== undefined &&
        !(depth > 0 && /draft-0[67]/.test(dialect) && typeof node.$ref === 'string')
      ) {
        base = new URL(node.$id, base).href;
        if (new URL(base).hash) reject();
      }
    }
    const context = { id: count, node, base };
    if (!record(node)) return context;
    nodes.set(node, context);
    if (
      node.$id !== undefined &&
      !(depth > 0 && /draft-0[67]/.test(dialect) && typeof node.$ref === 'string')
    )
      register(uris, base, context);
    if (node.$anchor !== undefined) register(anchors, base + '#' + node.$anchor, context);
    for (const [key, child] of Object.entries(node)) {
      if (schemaMaps.has(key)) {
        for (const value of Object.values(child)) walk(value, base, depth + 1);
      } else if (schemaArrays.has(key) || (key === 'items' && Array.isArray(child))) {
        for (const value of child) walk(value, base, depth + 1);
      } else if (schemaSingles.has(key)) walk(child, base, depth + 1);
      else if (key === 'dependencies')
        for (const value of Object.values(child))
          if (!Array.isArray(value)) walk(value, base, depth + 1);
    }
    return context;
  };
  const context = walk(root, 'https://paritydiff.invalid/semantic-root');
  register(uris, context.base, context);
  for (const resource of resources) {
    if (
      !record(resource) ||
      typeof resource.$id !== 'string' ||
      !/^[a-z][a-z0-9+.-]*:/i.test(resource.$id)
    )
      reject();
    walk(resource, 'https://paritydiff.invalid/semantic-resource');
  }
  const at = (node, parent) =>
    record(node)
      ? (nodes.get(node) ?? reject())
      : { id: 'boolean-' + node, node, base: parent.base };
  const resolve = (context) => {
    const uri = new URL(context.node.$ref, context.base),
      fragment = decodeURIComponent(uri.hash.slice(1));
    uri.hash = '';
    let target = uris.get(uri.href);
    if (!target) reject();
    if (!fragment) return target;
    if (!fragment.startsWith('/')) return anchors.get(uri.href + '#' + fragment) ?? reject();
    let node = target.node;
    for (const part of fragment.slice(1).split('/')) {
      if (/~(?![01])/.test(part)) reject();
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) reject();
      node = node[key];
    }
    return at(node, target);
  };
  return { context, at, resolve };
}
export function referenceEquivalent(before, after, options, canonical) {
  try {
    if (options.beforeDialect !== options.afterDialect) return false;
    const a = graph(before, options.beforeResources, options.beforeDialect),
      b = graph(after, options.afterResources, options.afterDialect);
    const active = new Map(),
      complete = new Set();
    let steps = 0;
    const compare = (left, right, progress = 0, depth = 0) => {
      if (++steps > 20000 || depth > 256) reject();
      const key = left.id + ':' + right.id;
      if (active.has(key)) return progress > active.get(key);
      if (complete.has(key)) return true;
      const x = left.node,
        y = right.node;
      if (typeof x === 'boolean' || typeof y === 'boolean') return x === y;
      active.set(key, progress);
      const assertions = (node) =>
        Object.keys(node)
          .filter((name) => !metadata.has(name) && name !== '$ref')
          .sort();
      const xs = assertions(x),
        ys = assertions(y);
      const xr = typeof x.$ref === 'string',
        yr = typeof y.$ref === 'string';
      const followsX = xr && (options.ignoreRefSiblings || !xs.length),
        followsY = yr && (options.ignoreRefSiblings || !ys.length);
      let valid;
      if (followsX || followsY)
        valid = compare(
          followsX ? a.resolve(left) : left,
          followsY ? b.resolve(right) : right,
          progress,
          depth + 1,
        );
      else {
        valid =
          xr === yr &&
          (!xr || compare(a.resolve(left), b.resolve(right), progress, depth + 1)) &&
          JSON.stringify(xs) === JSON.stringify(ys);
        for (const name of xs) {
          if (!valid) break;
          const p = x[name],
            q = y[name],
            next = progress + (descending.has(name) ? 1 : 0);
          if (schemaMaps.has(name) || name === 'dependencies') {
            const keys = Object.keys(p).sort();
            valid =
              JSON.stringify(keys) === JSON.stringify(Object.keys(q).sort()) &&
              keys.every((key) =>
                name === 'dependencies' && (Array.isArray(p[key]) || Array.isArray(q[key]))
                  ? JSON.stringify(canonical(p[key], 'literal')) ===
                    JSON.stringify(canonical(q[key], 'literal'))
                  : compare(a.at(p[key], left), b.at(q[key], right), next, depth + 1),
              );
          } else if (
            schemaArrays.has(name) ||
            (name === 'items' && (Array.isArray(p) || Array.isArray(q)))
          )
            valid =
              Array.isArray(p) &&
              Array.isArray(q) &&
              p.length === q.length &&
              p.every((child, index) =>
                compare(a.at(child, left), b.at(q[index], right), next, depth + 1),
              );
          else if (schemaSingles.has(name))
            valid = compare(a.at(p, left), b.at(q, right), next, depth + 1);
          else
            valid =
              JSON.stringify(canonical({ [name]: p })) === JSON.stringify(canonical({ [name]: q }));
        }
      }
      active.delete(key);
      if (valid) complete.add(key);
      return valid;
    };
    return compare(a.context, b.context);
  } catch {
    return false;
  }
}
