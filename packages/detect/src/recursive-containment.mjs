import {
  schemaResourceGraph,
  initialSchemaScope,
  enterSchemaScope,
  resolveSchemaReference,
} from './schema-resource-graph.mjs';
import { schemaFormatAssertions } from './schema-engine.mjs';
import { propertyNamePartitions } from './pattern-proof.mjs';
import { containsAnnotationCoverage } from './annotation-obligations.mjs';

const references = ['$ref', '$dynamicRef', '$recursiveRef'];
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
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'x-paritydiff-resource-id',
  'x-paritydiff-vocabulary-profiles',
]);
const positive = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependencies',
  'contains',
]);
const descending = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
]);
const legacy = (context) => ['draft6', 'draft7', 'openapi3.0'].includes(context.kind);
const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function recursiveContainment(before, after, options, scalarSubset, adapt) {
  try {
    const graphs = [
      schemaResourceGraph(before, options.beforeResources, options.beforeDialect),
      schemaResourceGraph(after, options.afterResources, options.afterDialect),
    ];
    if (graphs.reduce((sum, graph) => sum + graph.contexts.length, 0) > 4096) return false;
    const active = new Map();
    const normalized = new WeakMap();
    let steps = 0;
    const compare = (
      left,
      right,
      leftScope,
      rightScope,
      annotations = false,
      progress = 0,
      depth = 0,
      direction = 0,
    ) => {
      if (++steps > 20000 || depth > 256) throw new Error('recursive_containment_resource_limit');
      const normalize = (context) => {
        if (!normalized.has(context))
          normalized.set(
            context,
            containsAnnotationCoverage(context, metadata, () => {
              if (++steps > 20000) throw new Error('recursive_containment_resource_limit');
            }),
          );
        return normalized.get(context);
      };
      left = normalize(left);
      right = normalize(right);
      leftScope = enterSchemaScope(left, leftScope);
      rightScope = enterSchemaScope(right, rightScope);
      const identity = JSON.stringify([
        direction,
        left.id,
        right.id,
        leftScope.identity,
        rightScope.identity,
        annotations,
      ]);
      if (active.has(identity)) return progress > active.get(identity);
      const x = left.node,
        y = right.node;
      if (x === false) return true;
      if (y === true && !annotations) return true;
      if (typeof x === 'boolean' && typeof y === 'boolean') return x === y;
      const keys = (context) =>
        Object.keys(context.node).filter(
          (key) =>
            !metadata.has(key) &&
            !references.includes(key) &&
            !(
              key === 'format' &&
              !schemaFormatAssertions(context.dialect, options.formatAssertions ?? 'dialect')
            ),
        );
      const xs = keys(left),
        ys = keys(right);
      const xr = references.filter((key) => typeof x?.[key] === 'string');
      const yr = references.filter((key) => typeof y?.[key] === 'string');
      active.set(identity, progress);
      try {
        const followX = xr.length === 1 && (legacy(left) || !xs.length);
        const followY = yr.length === 1 && (legacy(right) || !ys.length);
        if (followX || followY)
          return compare(
            followX ? resolveSchemaReference(graphs[direction], left, xr[0], leftScope) : left,
            followY
              ? resolveSchemaReference(graphs[1 - direction], right, yr[0], rightScope)
              : right,
            leftScope,
            rightScope,
            annotations,
            progress,
            depth + 1,
            direction,
          );
        if (typeof x === 'boolean' || typeof y === 'boolean') {
          const other = typeof x === 'boolean' ? right : left;
          if (
            Object.values(other.maps).some((map) => map.size) ||
            Object.values(other.lists).some((list) => list.length) ||
            Object.keys(other.singles).some((key) => !metadata.has(key)) ||
            xr.length ||
            yr.length
          )
            return false;
          const local = (context, names) =>
            typeof context.node === 'boolean'
              ? context.node
              : Object.fromEntries(names.map((key) => [key, context.node[key]]));
          return scalarSubset(local(left, xs), local(right, ys));
        }
        if (
          (left.kind !== right.kind &&
            ![left.kind, right.kind].every((kind) => ['2019', '2020'].includes(kind))) ||
          xr.length !== yr.length
        )
          return false;
        const structural = (context, names) =>
          names.filter(
            (key) =>
              Object.hasOwn(context.maps, key) ||
              Object.hasOwn(context.lists, key) ||
              Object.hasOwn(context.singles, key),
          );
        const implicit = (parent) => ({
          ...parent,
          id: 'implicit-' + parent.id,
          node: true,
          maps: {},
          lists: {},
          singles: {},
        });
        const array = (context) => {
          const prefix = context.lists.prefixItems ?? context.lists.items ?? [];
          const declared = context.lists.items
            ? context.singles.additionalItems
            : context.singles.items;
          const tail = declared ?? implicit(context),
            forbidden = prefix.findIndex((child) => child.node === false);
          return {
            prefix,
            tail,
            declared,
            maximum: Math.min(
              context.node.maxItems ?? Infinity,
              tail.node === false ? prefix.length : Infinity,
              forbidden < 0 ? Infinity : forbidden,
            ),
          };
        };
        const sourceArray = array(left),
          targetArray = array(right);
        const propertyEdges =
          (!left.maps.patternProperties?.size && !right.maps.patternProperties?.size) ||
          !sameNames(
            left.maps.patternProperties?.keys() ?? [],
            right.maps.patternProperties?.keys() ?? [],
          ) ||
          !sameNames(left.maps.properties?.keys() ?? [], right.maps.properties?.keys() ?? []) ||
          Boolean(left.singles.additionalProperties) !==
            Boolean(right.singles.additionalProperties);
        const edges = (context, names) =>
          structural(context, names).filter(
            (key) =>
              !['items', 'prefixItems', 'additionalItems'].includes(key) &&
              (!propertyEdges ||
                !['properties', 'patternProperties', 'additionalProperties'].includes(key)),
          );
        const sourceEdges = edges(left, xs),
          targetEdges = edges(right, ys);
        if (!sameNames(sourceEdges, targetEdges) || sourceEdges.some((key) => !positive.has(key)))
          return false;
        const local = (context, names, model) =>
          adapt(
            {
              ...Object.fromEntries(
                names
                  .filter(
                    (key) => !positive.has(key) && !['minContains', 'maxContains'].includes(key),
                  )
                  .map((key) => [key, context.node[key]]),
              ),
              ...(Number.isFinite(model.maximum) ? { maxItems: model.maximum } : {}),
            },
            context.kind === 'openapi3.0',
          );
        if (!scalarSubset(local(left, xs, sourceArray), local(right, ys, targetArray)))
          return false;
        const carriesAnnotations =
          annotations ||
          Boolean(
            left.singles.unevaluatedProperties ||
            right.singles.unevaluatedProperties ||
            left.singles.unevaluatedItems ||
            right.singles.unevaluatedItems,
          );
        if (
          carriesAnnotations &&
          left.kind === '2020' &&
          right.kind !== '2020' &&
          left.singles.contains &&
          left.singles.contains.node !== false &&
          x.maxContains !== 0
        )
          return false;
        for (let index = 0; index < xr.length; index++)
          if (
            !compare(
              resolveSchemaReference(graphs[direction], left, xr[index], leftScope),
              resolveSchemaReference(graphs[1 - direction], right, yr[index], rightScope),
              leftScope,
              rightScope,
              carriesAnnotations,
              progress,
              depth + 1,
              direction,
            )
          )
            return false;
        if (propertyEdges) {
          const p = left.maps.properties ?? new Map(),
            q = right.maps.properties ?? new Map();
          const names = [...new Set([...p.keys(), ...q.keys()])];
          const patterns = [
            ...new Set([
              ...(left.maps.patternProperties?.keys() ?? []),
              ...(right.maps.patternProperties?.keys() ?? []),
            ]),
          ];
          const partitions = patterns.length
            ? propertyNamePartitions(patterns, names)
            : [{ matches: [], representative: '' }];
          if (!partitions) return false;
          const values = (context, name, matches) => {
            const children =
              name !== undefined && context.maps.properties?.has(name)
                ? [context.maps.properties.get(name)]
                : [];
            for (const [index, pattern] of patterns.entries())
              if (matches[index] && context.maps.patternProperties?.has(pattern))
                children.push(context.maps.patternProperties.get(pattern));
            const annotated = children.length > 0 || Boolean(context.singles.additionalProperties);
            return {
              annotated,
              children: children.length
                ? children
                : [context.singles.additionalProperties ?? implicit(context)],
            };
          };
          const nested = (source, target) =>
            compare(
              source,
              target,
              leftScope,
              rightScope,
              false,
              progress + 1,
              depth + 1,
              direction,
            );
          const rows = [
            ...names.map((name) => ({
              name,
              matches: patterns.map((pattern) => new RegExp(pattern, 'u').test(name)),
            })),
            ...partitions.map(({ matches }) => ({ name: undefined, matches })),
          ];
          for (const { name, matches } of rows) {
            const source = values(left, name, matches),
              target = values(right, name, matches);
            if (source.children.some((child) => child.node === false)) continue;
            if (carriesAnnotations && source.annotated && !target.annotated) return false;
            for (const constraint of target.children)
              if (!source.children.some((child) => nested(child, constraint))) return false;
          }
        }
        const length = Math.max(sourceArray.prefix.length, targetArray.prefix.length);
        const items = (source, target) =>
          compare(source, target, leftScope, rightScope, false, progress + 1, depth + 1, direction);
        for (let index = 0; index < Math.min(sourceArray.maximum, length); index++) {
          if (
            carriesAnnotations &&
            (index < sourceArray.prefix.length || sourceArray.declared) &&
            !(index < targetArray.prefix.length || targetArray.declared)
          )
            return false;
          if (
            !items(
              sourceArray.prefix[index] ?? sourceArray.tail,
              targetArray.prefix[index] ?? targetArray.tail,
            )
          )
            return false;
        }
        if (sourceArray.maximum > length) {
          if (carriesAnnotations && sourceArray.declared && !targetArray.declared) return false;
          if (!items(sourceArray.tail, targetArray.tail)) return false;
        }
        for (const key of sourceEdges) {
          const next = progress + (descending.has(key) ? 1 : 0);
          const nested = (p, q) =>
            compare(
              p,
              q,
              leftScope,
              rightScope,
              descending.has(key) ? false : carriesAnnotations,
              next,
              depth + 1,
              direction,
            );
          const reverse = (p, q) =>
            compare(q, p, rightScope, leftScope, false, next, depth + 1, 1 - direction);
          if (left.maps[key] || right.maps[key]) {
            const p = left.maps[key],
              q = right.maps[key];
            if (!p || !q || !sameNames(p.keys(), q.keys())) return false;
            for (const [name, child] of p) if (!nested(child, q.get(name))) return false;
            if (key === 'dependencies') {
              const arrays = (node) =>
                Object.fromEntries(
                  Object.entries(node.dependencies).filter(([, value]) => Array.isArray(value)),
                );
              if (!scalarSubset({ dependencies: arrays(x) }, { dependencies: arrays(y) }))
                return false;
            }
          } else if (left.lists[key] || right.lists[key]) {
            const p = left.lists[key],
              q = right.lists[key];
            if (!p || !q) return false;
            if (key === 'anyOf') {
              if (!p.every((child) => q.some((target) => nested(child, target)))) return false;
            } else if (['allOf', 'oneOf'].includes(key) && p.length <= 16 && q.length <= 16) {
              if (p.length !== q.length) return false;
              const candidates = p.map((child) =>
                q.flatMap((target, index) =>
                  nested(child, target) && (key !== 'oneOf' || reverse(child, target))
                    ? [index]
                    : [],
                ),
              );
              const assigned = new Map();
              const match = (source, visited) => {
                if (++steps > 20000) throw new Error('recursive_containment_resource_limit');
                for (const target of candidates[source]) {
                  if (visited.has(target)) continue;
                  visited.add(target);
                  if (!assigned.has(target) || match(assigned.get(target), visited)) {
                    assigned.set(target, source);
                    return true;
                  }
                }
                return false;
              };
              if (!p.every((_, index) => match(index, new Set()))) return false;
            } else {
              if (p.length !== q.length) return false;
              for (let index = 0; index < p.length; index++) {
                if (!nested(p[index], q[index])) return false;
                if (key === 'oneOf' && !reverse(p[index], q[index])) return false;
              }
            }
          } else {
            const p = left.singles[key],
              q = right.singles[key];
            if (!p || !q) return false;
            if (key === 'not') {
              if (!reverse(p, q)) return false;
              continue;
            }
            if (key === 'if' && !reverse(p, q)) return false;
            if (key === 'contains') {
              if ((x.minContains ?? 1) < (y.minContains ?? 1)) return false;
              if (y.maxContains !== undefined) {
                if ((x.maxContains ?? Infinity) > y.maxContains) return false;
                if (!reverse(p, q)) return false;
              }
            }
            if (!nested(p, q)) return false;
          }
        }
        return true;
      } finally {
        active.delete(identity);
      }
    };
    return compare(graphs[0].root, graphs[1].root, initialSchemaScope(), initialSchemaScope());
  } catch {
    return false;
  }
}
