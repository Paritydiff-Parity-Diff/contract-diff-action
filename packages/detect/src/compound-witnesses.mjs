import {
  schemaResourceGraph,
  initialSchemaScope,
  enterSchemaScope,
  resolveSchemaReference,
} from './schema-resource-graph.mjs';
import { propertyNamePartitions } from './pattern-proof.mjs';

const references = ['$ref', '$dynamicRef', '$recursiveRef'];
const metadata = new Set([
  '$id',
  '$schema',
  '$defs',
  'definitions',
  '$anchor',
  '$dynamicAnchor',
  '$recursiveAnchor',
  '$vocabulary',
  '$comment',
  'x-paritydiff-resource-id',
  'title',
  'description',
  'default',
  'examples',
  'example',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
]);
const descending = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'unevaluatedItems',
]);

export function compoundWitnessCandidates(
  schema,
  resources,
  dialect,
  adapt,
  sample,
  seed,
  comparisonPatterns = [],
) {
  const candidates = new Map();
  try {
    const graph = schemaResourceGraph(schema, resources, dialect);
    let steps = 0;
    for (const budget of [0, 1, 2, 4]) {
      const active = new Set();
      const render = (context, scope, remaining, depth = 0) => {
        if (++steps > 10000 || depth > 64) throw new Error('compound_witness_resource_limit');
        if (remaining < 0) return true;
        if (typeof context.node === 'boolean') return context.node;
        scope = enterSchemaScope(context, scope);
        const identity = JSON.stringify([context.id, scope.identity, remaining]);
        if (active.has(identity)) return true;
        active.add(identity);
        try {
          const refs = references.filter((key) => typeof context.node[key] === 'string');
          const follow = (key) =>
            render(resolveSchemaReference(graph, context, key, scope), scope, remaining, depth + 1);
          if (['draft6', 'draft7', 'openapi3.0'].includes(context.kind) && refs.length)
            return follow(refs[0]);
          const node = Object.fromEntries(
            Object.entries(context.node).filter(
              ([key]) => !metadata.has(key) && !references.includes(key),
            ),
          );
          if (refs.length === 1 && !Object.keys(node).length) return follow(refs[0]);
          const child = (key, nested) =>
            render(nested, scope, remaining - (descending.has(key) ? 1 : 0), depth + 1);
          for (const [key, children] of Object.entries(context.maps)) {
            if (metadata.has(key)) continue;
            node[key] = Object.fromEntries([
              ...(key === 'dependencies'
                ? Object.entries(context.node.dependencies).filter(([, value]) =>
                    Array.isArray(value),
                  )
                : []),
              ...[...children].map(([name, nested]) => [name, child(key, nested)]),
            ]);
          }
          for (const [key, children] of Object.entries(context.lists))
            node[key] = children.map((nested) => child(key, nested));
          for (const [key, nested] of Object.entries(context.singles))
            node[key] = child(key, nested);
          if (refs.length) node.allOf = [...refs.map(follow), ...(node.allOf ?? [])];
          return adapt(
            node,
            context.kind === 'openapi3.0',
            'schema',
            ['draft6', 'draft7', '2019'].includes(context.kind),
            true,
          );
        } finally {
          active.delete(identity);
        }
      };
      const shape = render(graph.root, initialSchemaScope(), budget);
      const construct = (node, depth = 0) => {
        if (++steps > 10000 || depth > 16) throw new Error('compound_witness_resource_limit');
        if (
          node?.type === 'object' ||
          (!node?.type && (node?.properties || node?.patternProperties || node?.required))
        ) {
          if ((node.required?.length ?? 0) > 128)
            throw new Error('compound_witness_resource_limit');
          return Object.fromEntries(
            (node.required ?? []).map((key) => [
              key,
              construct(node.properties?.[key] ?? node.additionalProperties, depth + 1),
            ]),
          );
        }
        if (node?.type === 'array') {
          const length = Math.max(node.minItems ?? 0, node.contains ? (node.minContains ?? 1) : 0);
          if (length > 128) throw new Error('compound_witness_resource_limit');
          return Array.from({ length }, (_, index) =>
            construct(node.prefixItems?.[index] ?? node.items ?? node.contains, depth + 1),
          );
        }
        return seed(node, sample(node));
      };
      const variants = function* (node, baseline, depth = 0) {
        if (++steps > 10000 || depth > 16) throw new Error('compound_witness_resource_limit');
        if (baseline === null || typeof baseline !== 'object')
          for (const value of sample(node)
            .filter((value) => value === null || typeof value !== 'object')
            .slice(0, 24))
            yield value;
        if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
          const declared = (schema, nesting = 0) => {
            if (++steps > 10000 || nesting > 16) throw new Error('compound_witness_resource_limit');
            return [
              ...Object.entries(schema?.properties ?? {}),
              ...[
                ...(schema?.allOf ?? []),
                ...(schema?.anyOf ?? []),
                ...(schema?.oneOf ?? []),
              ].flatMap((child) => declared(child, nesting + 1)),
            ];
          };
          const combined = declared(node);
          if (combined.length > 128) throw new Error('compound_witness_resource_limit');
          if (combined.length)
            yield Object.fromEntries([
              ...Object.entries(baseline),
              ...combined.map(([name, child]) => [name, construct(child)]),
            ]);
          if (node?.if) {
            for (const branches of [[node.if, node.then], [node.else]]) {
              const fields = branches.flatMap((branch) => declared(branch));
              if (fields.length > 128) throw new Error('compound_witness_resource_limit');
              const selected = Object.fromEntries([
                ...Object.entries(baseline),
                ...fields.map(([name, child]) => [name, construct(child)]),
              ]);
              yield selected;
              for (const [name, child] of fields)
                for (const value of sample(child).slice(0, 8))
                  yield Object.fromEntries([...Object.entries(selected), [name, value]]);
            }
          }
          const ownPatterns = Object.keys(node?.patternProperties ?? {});
          const patterns = [...new Set([...ownPatterns, ...comparisonPatterns])];
          const names = [
            ...new Set([...Object.keys(node?.properties ?? {}), ...Object.keys(baseline)]),
          ];
          const partitions = patterns.length ? propertyNamePartitions(patterns, names) : [];
          for (const partition of partitions ?? []) {
            const children = ownPatterns
              .filter((_, index) => partition.matches[index])
              .map((pattern) => node.patternProperties[pattern]);
            if (!children.length) children.push(node?.additionalProperties ?? true);
            for (const child of children)
              for (const value of [construct(child), ...sample(child).slice(0, 8)])
                yield Object.fromEntries([
                  ...Object.entries(baseline),
                  [partition.representative, value],
                ]);
          }
          for (const [name, child] of Object.entries(node?.properties ?? {})) {
            yield Object.fromEntries([...Object.entries(baseline), [name, construct(child)]]);
            for (const value of variants(
              child,
              Object.hasOwn(baseline, name) ? baseline[name] : construct(child),
              depth + 1,
            ))
              yield Object.fromEntries([...Object.entries(baseline), [name, value]]);
          }
        } else if (Array.isArray(baseline)) {
          const values = baseline.length
            ? baseline
            : [construct(node?.prefixItems?.[0] ?? node?.items)];
          for (let index = 0; index < values.length; index++)
            for (const value of variants(
              node?.prefixItems?.[index] ?? node?.items,
              values[index],
              depth + 1,
            )) {
              const changed = [...values];
              changed[index] = value;
              yield changed;
            }
        }
        for (const child of [
          ...(node?.allOf ?? []),
          ...(node?.anyOf ?? []),
          ...(node?.oneOf ?? []),
        ])
          yield* variants(child, baseline, depth + 1);
      };
      // Cutoffs generate candidates only; original validators decide membership.
      const baseline = construct(shape),
        values = [baseline];
      for (const seed of [baseline, ...(baseline && typeof baseline === 'object' ? [] : [{}, []])])
        for (const value of variants(shape, seed)) {
          values.push(value);
          if (values.length >= 96) break;
        }
      values.push(...sample(shape).slice(0, 128 - values.length));
      for (const value of values) {
        candidates.set(JSON.stringify(value), value);
        if (candidates.size >= 512) return [...candidates.values()];
      }
    }
  } catch {
    // Resource limits leave the available candidates, never a containment proof.
  }
  return [...candidates.values()];
}
