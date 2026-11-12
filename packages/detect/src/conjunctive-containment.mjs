import {
  schemaResourceGraph,
  initialSchemaScope,
  enterSchemaScope,
  resolveSchemaReference,
} from './schema-resource-graph.mjs';
import { schemaFormatAssertions } from './schema-engine.mjs';
import { propertyNamePartitions } from './pattern-proof.mjs';
import { logicalSubset } from './semantic-logic.mjs';
import { annotationObligations } from './annotation-obligations.mjs';

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
const structural = new Set([
  ...references,
  'allOf',
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
  'propertyNames',
]);
const assertions = new Set([
  'type',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'required',
  'dependentRequired',
  'minProperties',
  'maxProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
  'const',
  'enum',
]);
const legacy = (context) => ['draft6', 'draft7', 'openapi3.0'].includes(context.kind);
const booleanKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);
function closedDisjointUnion(context) {
  const node = context.node;
  if (
    node?.type !== 'object' ||
    node.unevaluatedProperties !== false ||
    !context.lists.anyOf ||
    (context.singles.additionalProperties && context.singles.additionalProperties.node !== false)
  )
    return context;
  const allowed = new Set([
    'type',
    'properties',
    'patternProperties',
    'required',
    'dependentRequired',
    'minProperties',
    'maxProperties',
    'const',
    'enum',
    'anyOf',
    'additionalProperties',
    'unevaluatedProperties',
    'propertyNames',
  ]);
  if (Object.keys(node).some((key) => !metadata.has(key) && !allowed.has(key))) return context;
  const names = new Map();
  const patterns = new Map();
  const register = (unit, owner) => {
    for (const [keyword, values] of [
      ['properties', names],
      ['patternProperties', patterns],
    ])
      for (const name of unit.maps[keyword]?.keys() ?? []) {
        if (!values.has(name)) values.set(name, new Set());
        values.get(name).add(owner);
      }
  };
  register(context, -1);
  for (const [index, branch] of context.lists.anyOf.entries()) {
    if (branch.node === true) continue;
    if (
      !branch.node ||
      typeof branch.node !== 'object' ||
      (branch.node.type !== undefined && branch.node.type !== 'object') ||
      Object.keys(branch.node).some(
        (key) => !metadata.has(key) && !['type', 'properties', 'patternProperties'].includes(key),
      )
    )
      return context;
    register(branch, index);
  }
  if ([...names.values()].some((owners) => owners.size > 1)) return context;
  if (patterns.size) {
    const expressions = [...patterns.keys()];
    const partitions = propertyNamePartitions(expressions, [...names.keys()]);
    if (!partitions) return context;
    const rows = [
      ...[...names].map(([name, owners]) => ({
        owners,
        matches: expressions.map((pattern) => new RegExp(pattern, 'u').test(name)),
      })),
      ...partitions.map(({ matches }) => ({ matches, owners: new Set() })),
    ];
    for (const row of rows) {
      const owners = new Set(row.owners);
      row.matches.forEach((matched, index) => {
        if (matched) for (const owner of patterns.get(expressions[index])) owners.add(owner);
      });
      if (owners.size > 1) return context;
    }
  }
  const { anyOf, ...rest } = node;
  const { anyOf: branches, ...lists } = context.lists;
  return { ...context, node: { ...rest, allOf: anyOf }, lists: { ...lists, allOf: branches } };
}

export function conjunctiveContainment(before, after, options, scalarSubset, adapt) {
  try {
    const graphs = [
      schemaResourceGraph(before, options.beforeResources, options.beforeDialect),
      schemaResourceGraph(after, options.afterResources, options.afterDialect),
    ];
    if (graphs.reduce((sum, graph) => sum + graph.contexts.length, 0) > 4096) return false;
    graphs.forEach((graph, side) =>
      graph.contexts.forEach((context) => {
        context.proofSide = side;
      }),
    );
    let steps = 0;
    const active = new Map();
    const normalized = new WeakMap();
    const bounded = (depth) => {
      if (++steps > 20000 || depth > 256) throw new Error('conjunctive_proof_resource_limit');
    };
    const atom = (context, scope) => {
      if (!normalized.has(context)) {
        const disjoint = closedDisjointUnion(context);
        normalized.set(
          context,
          disjoint === context
            ? annotationObligations(context, metadata, () => bounded(0))
            : disjoint,
        );
      }
      context = normalized.get(context);
      return { context, scope: enterSchemaScope(context, scope) };
    };
    const identity = ({ context, scope }) =>
      JSON.stringify([context.proofSide, context.id, scope.identity]);
    const expand = (entry, side, pending = new Set(), depth = 0) => {
      bounded(depth);
      const { context, scope } = entry;
      const node = context.node;
      if (typeof node === 'boolean') return { ...entry, local: node, children: [] };
      const key = identity(entry);
      if (pending.has(key)) throw new Error('conjunctive_proof_unguarded_reference');
      pending.add(key);
      try {
        const children = [];
        for (const keyword of references)
          if (typeof node[keyword] === 'string') {
            children.push(
              expand(
                atom(
                  resolveSchemaReference(graphs[context.proofSide], context, keyword, scope),
                  scope,
                ),
                side,
                pending,
                depth + 1,
              ),
            );
            if (legacy(context)) return { ...entry, local: true, children, ignored: true };
          }
        for (const child of context.lists.allOf ?? [])
          children.push(expand(atom(child, scope), side, pending, depth + 1));
        const local = {};
        for (const [name, value] of Object.entries(node)) {
          if (name === 'dependencies') {
            if (context.maps.dependencies?.size)
              throw new Error('conjunctive_proof_unsupported_keyword');
            local.dependentRequired = value;
            continue;
          }
          if (metadata.has(name) || structural.has(name)) continue;
          if (!assertions.has(name)) throw new Error('conjunctive_proof_unsupported_keyword');
          if (
            name !== 'format' ||
            schemaFormatAssertions(context.dialect, options.formatAssertions ?? 'dialect')
          )
            local[name] = value;
        }
        return { ...entry, local: adapt(local, context.kind === 'openapi3.0'), children };
      } finally {
        pending.delete(key);
      }
    };
    const flatten = (units) => units.flatMap((unit) => [unit, ...flatten(unit.children)]);
    const conjunction = (values) => (values.length ? { allOf: values } : true);
    const logical = (sources, targets, progress, depth) => {
      const atoms = new Map();
      const implications = new Map();
      const deduce = (sources, target) => {
        const key = JSON.stringify([sources.map(identity).sort(), identity(target)]);
        if (!implications.has(key))
          implications.set(key, compare(sources, [target], progress, depth + 1));
        return implications.get(key);
      };
      const formula = (entry, side, pending = new Set(), nesting = 0) => {
        bounded(depth + nesting);
        const { context, scope } = entry;
        if (typeof context.node === 'boolean') return context.node;
        if (context.singles.unevaluatedProperties || context.singles.unevaluatedItems)
          return undefined;
        const key = side + ':' + identity(entry);
        if (pending.has(key)) return undefined;
        pending.add(key);
        try {
          const parts = [];
          for (const keyword of references)
            if (typeof context.node[keyword] === 'string') {
              const referenceKey = key + ':reference:' + keyword;
              atoms.set(
                referenceKey,
                atom(
                  {
                    ...context,
                    id: 'boolean-reference-' + context.id + '-' + keyword,
                    node: { [keyword]: context.node[keyword] },
                    maps: {},
                    lists: {},
                    singles: {},
                  },
                  scope,
                ),
              );
              parts.push({ 'x-proof-atom': referenceKey });
              if (legacy(context)) return conjunction(parts);
            }
          const local = {
            ...context,
            id: 'boolean-atom-' + context.id,
            node: Object.fromEntries(
              Object.entries(context.node).filter(
                ([name]) =>
                  !booleanKeywords.has(name) &&
                  !references.includes(name) &&
                  !['dependentSchemas', 'dependencies'].includes(name),
              ),
            ),
            lists: Object.fromEntries(
              Object.entries(context.lists).filter(([name]) => !booleanKeywords.has(name)),
            ),
            singles: Object.fromEntries(
              Object.entries(context.singles).filter(([name]) => !booleanKeywords.has(name)),
            ),
            maps: Object.fromEntries(
              Object.entries(context.maps).filter(
                ([name]) => !['dependentSchemas', 'dependencies'].includes(name),
              ),
            ),
          };
          const arrayDependencies = Object.fromEntries(
            Object.entries(context.node.dependencies ?? {}).filter(([, value]) =>
              Array.isArray(value),
            ),
          );
          if (Object.keys(arrayDependencies).length) local.node.dependencies = arrayDependencies;
          if (Object.keys(local.node).some((name) => !metadata.has(name))) {
            atoms.set(key, atom(local, scope));
            parts.push({
              'x-proof-atom': key,
              ...(local.node.type ? { type: local.node.type } : {}),
              ...(Object.hasOwn(local.node, 'const') ? { const: local.node.const } : {}),
              ...(local.node.enum ? { enum: local.node.enum } : {}),
            });
          }
          const output = { allOf: parts };
          for (const keyword of ['dependentSchemas', 'dependencies'])
            for (const [name, child] of context.maps[keyword] ?? []) {
              const then = formula(atom(child, scope), side, pending, nesting + 1);
              if (then === undefined) return undefined;
              const triggerKey = key + ':dependency:' + JSON.stringify(name);
              const trigger = {
                ...context,
                id: 'dependency-trigger-' + context.id + '-' + JSON.stringify(name),
                node: { type: 'object', required: [name] },
                maps: {},
                lists: {},
                singles: {},
              };
              atoms.set(triggerKey, atom(trigger, scope));
              parts.push({ if: { 'x-proof-atom': triggerKey, type: 'object' }, then });
            }
          for (const keyword of ['allOf', 'anyOf', 'oneOf'])
            if (context.lists[keyword]) {
              const children = context.lists[keyword].map((child) =>
                formula(atom(child, scope), side, pending, nesting + 1),
              );
              if (children.includes(undefined)) return undefined;
              if (keyword === 'allOf') parts.push(...children);
              else output[keyword] = children;
            }
          for (const keyword of ['not', 'if', 'then', 'else'])
            if (context.singles[keyword]) {
              const child = formula(
                atom(context.singles[keyword], scope),
                side,
                pending,
                nesting + 1,
              );
              if (child === undefined) return undefined;
              output[keyword] = child;
            }
          return output;
        } finally {
          pending.delete(key);
        }
      };
      const p = sources.map((entry) => formula(entry, 0));
      const q = targets.map((entry) => formula(entry, 1));
      if (p.includes(undefined) || q.includes(undefined)) return false;
      const falseTarget = {
        ...graphs[1].root,
        id: 'boolean-false',
        node: false,
        maps: {},
        lists: {},
        singles: {},
      };
      return logicalSubset(
        conjunction(p),
        conjunction(q),
        (source, target) => {
          const a = atoms.get(source?.['x-proof-atom']);
          const b =
            target === false
              ? atom(falseTarget, initialSchemaScope())
              : atoms.get(target?.['x-proof-atom']);
          return Boolean(a && b && deduce([a], b));
        },
        (value) => value,
        (sources, target) => {
          const a = sources.map((source) => atoms.get(source?.['x-proof-atom']));
          const b = atoms.get(target?.['x-proof-atom']);
          return Boolean(a.every(Boolean) && b && deduce(a, b));
        },
      );
    };
    const compare = (sources, targets, progress = 0, depth = 0) => {
      bounded(depth);
      const factors = (entry) => {
        bounded(depth);
        const { context, scope } = entry;
        if (context.node === true) return [];
        if (context.node && typeof context.node === 'object') {
          const names = Object.keys(context.node).filter((name) => !metadata.has(name));
          if (!names.length) return [];
          if (names.length === 1 && names[0] === 'allOf')
            return context.lists.allOf.flatMap((child) => factors(atom(child, scope)));
          if (
            names.length > 1 &&
            context.singles.not &&
            !context.singles.unevaluatedProperties &&
            !context.singles.unevaluatedItems
          ) {
            const { not: _not, ...node } = context.node;
            const { not: _single, ...singles } = context.singles;
            return [
              atom({ ...context, id: 'without-not-' + context.id, node, singles }, scope),
              atom(
                {
                  ...context,
                  id: 'not-only-' + context.id,
                  node: { not: true },
                  maps: {},
                  lists: {},
                  singles: { not: context.singles.not },
                },
                scope,
              ),
            ];
          }
        }
        return [entry];
      };
      sources = sources.flatMap(factors);
      targets = targets.flatMap(factors);
      if (targets.length > 1)
        return targets.every((target) => compare(sources, [target], progress, depth + 1));
      const premises = new Set(sources.map(identity));
      if (targets.every((target) => premises.has(identity(target)))) return true;
      const key = JSON.stringify([
        [...new Set(sources.map(identity))].sort(),
        [...new Set(targets.map(identity))].sort(),
      ]);
      if (active.has(key)) return progress > active.get(key);
      active.set(key, progress);
      try {
        const unfold = (entry) => {
          const { context, scope } = entry;
          const refs = references.filter((keyword) => typeof context.node?.[keyword] === 'string');
          if (
            refs.length !== 1 ||
            (!legacy(context) &&
              Object.keys(context.node).some(
                (name) => !metadata.has(name) && !references.includes(name),
              ))
          )
            return entry;
          return atom(
            resolveSchemaReference(graphs[context.proofSide], context, refs[0], scope),
            scope,
          );
        };
        const unfoldedSource = sources.map(unfold),
          unfoldedTarget = targets.map(unfold);
        if (
          sources.some((entry, index) => entry !== unfoldedSource[index]) ||
          targets.some((entry, index) => entry !== unfoldedTarget[index])
        )
          return compare(unfoldedSource, unfoldedTarget, progress, depth + 1);
        const alternatives = ({ context }) =>
          context.lists.anyOf &&
          !context.singles.unevaluatedProperties &&
          !context.singles.unevaluatedItems;
        const choiceBase = ({ context, scope }) => {
          const { anyOf: _choice, ...node } = context.node;
          const { anyOf: _list, ...lists } = context.lists;
          return atom({ ...context, id: 'choice-base-' + context.id, node, lists }, scope);
        };
        const choice = sources.findIndex(alternatives);
        if (choice >= 0) {
          const entry = sources[choice];
          return entry.context.lists.anyOf.every((child) =>
            compare(
              [
                ...sources.map((source, index) => (index === choice ? choiceBase(entry) : source)),
                atom(child, entry.scope),
              ],
              targets,
              progress,
              depth + 1,
            ),
          );
        }
        if (targets.length === 1 && alternatives(targets[0])) {
          const entry = targets[0];
          const negations = (context) => [
            ...(context.singles.not ? [JSON.stringify(context.singles.not.node)] : []),
            ...(context.lists.allOf ?? []).flatMap(negations),
          ];
          const known = new Set(sources.flatMap(({ context }) => negations(context)));
          const branches = [...entry.context.lists.anyOf].sort(
            (a, b) =>
              negations(b).filter((key) => known.has(key)).length -
              negations(a).filter((key) => known.has(key)).length,
          );
          if (
            branches.some((child) =>
              compare(sources, [choiceBase(entry), atom(child, entry.scope)], progress, depth + 1),
            )
          )
            return true;
        }
        let left, right;
        const positiveSources = [];
        const expandedSources = [];
        for (const entry of sources) {
          try {
            expandedSources.push(expand(entry, 0));
            positiveSources.push(entry);
          } catch (error) {
            if (error.message !== 'conjunctive_proof_unsupported_keyword') throw error;
          }
        }
        if (
          positiveSources.length &&
          positiveSources.length < sources.length &&
          compare(positiveSources, targets, progress, depth + 1)
        )
          return true;
        try {
          if (positiveSources.length < sources.length)
            return logical(sources, targets, progress, depth);
          left = expandedSources;
          right = targets.map((entry) => expand(entry, 1));
        } catch (error) {
          if (error.message === 'conjunctive_proof_unsupported_keyword')
            return logical(sources, targets, progress, depth);
          throw error;
        }
        const a = flatten(left),
          b = flatten(right);
        const scalarA = conjunction(a.map((unit) => unit.local));
        const scalarB = conjunction(b.map((unit) => unit.local));
        if (scalarSubset(scalarA, false)) return true;
        const objects = !scalarSubset(scalarA, { not: { type: 'object' } });
        const arrays = !scalarSubset(scalarA, { not: { type: 'array' } });
        const kinds = new Set([...a, ...b].map((unit) => unit.context.kind));
        if (kinds.size > 1 && ![...kinds].every((kind) => ['2019', '2020'].includes(kind)))
          return false;
        const effective = [...a, ...b].filter((unit) => !unit.ignored);
        const propertyNames = (units) =>
          units
            .filter((unit) => !unit.ignored && unit.context.singles.propertyNames)
            .map((unit) => atom(unit.context.singles.propertyNames, unit.scope));
        const nameTargets = propertyNames(b);
        if (objects && nameTargets.length) {
          const domain = {
            ...(a[0]?.context ?? graphs[0].root),
            id: 'property-name-domain',
            node: { type: 'string' },
            maps: {},
            lists: {},
            singles: {},
          };
          if (
            !compare(
              [...propertyNames(a), atom(domain, initialSchemaScope())],
              nameTargets,
              progress + 1,
              depth + 1,
            )
          )
            return false;
        }
        const names = objects
          ? [
              ...new Set(
                effective.flatMap(({ context }) => [...(context.maps.properties?.keys() ?? [])]),
              ),
            ]
          : [];
        const patterns = objects
          ? [
              ...new Set(
                effective.flatMap(({ context }) => [
                  ...(context.maps.patternProperties?.keys() ?? []),
                ]),
              ),
            ]
          : [];
        const partitions = patterns.length
          ? propertyNamePartitions(patterns, names)
          : [{ matches: [] }];
        if (!partitions) return false;
        const property = (unit, name, matches) => {
          bounded(depth);
          const { context, scope } = unit;
          const nested = unit.children.map((child) => property(child, name, matches));
          const constraints = nested.flatMap((result) => result.constraints);
          let evaluated = nested.some((result) => result.evaluated);
          if (unit.ignored) return { constraints, evaluated };
          const own = [];
          if (name !== undefined && context.maps.properties?.has(name))
            own.push(context.maps.properties.get(name));
          for (const [index, pattern] of patterns.entries())
            if (matches[index] && context.maps.patternProperties?.has(pattern))
              own.push(context.maps.patternProperties.get(pattern));
          if (!own.length && context.singles.additionalProperties)
            own.push(context.singles.additionalProperties);
          if (own.length) evaluated = true;
          constraints.push(...own.map((child) => atom(child, scope)));
          if (!evaluated && context.singles.unevaluatedProperties) {
            constraints.push(atom(context.singles.unevaluatedProperties, scope));
            evaluated = true;
          }
          return { constraints, evaluated };
        };
        const rows = (
          objects
            ? [
                ...names.map((name) => ({
                  name,
                  matches: patterns.map((pattern) => new RegExp(pattern, 'u').test(name)),
                })),
                ...partitions.map(({ matches }) => ({ name: undefined, matches })),
              ]
            : []
        ).map(({ name, matches }) => ({
          name,
          p: left.flatMap((unit) => property(unit, name, matches).constraints),
          q: right.flatMap((unit) => property(unit, name, matches).constraints),
        }));
        const forbidden = (constraints) =>
          constraints.some(({ context }) => context.node === false);
        const propertyLimit = rows
          .filter((row) => row.name === undefined)
          .every((row) => forbidden(row.p))
          ? rows.filter((row) => row.name !== undefined && !forbidden(row.p)).length
          : Infinity;
        const prefix = (unit) =>
          unit.ignored ? [] : (unit.context.lists.prefixItems ?? unit.context.lists.items ?? []);
        const boundary = Math.max(0, ...effective.map((unit) => prefix(unit).length));
        const item = (unit, index) => {
          bounded(depth);
          const { context, scope } = unit;
          const nested = unit.children.map((child) => item(child, index));
          const constraints = nested.flatMap((result) => result.constraints);
          let evaluated = nested.some((result) => result.evaluated);
          if (unit.ignored) return { constraints, evaluated };
          const tuple = prefix(unit);
          const tail = context.lists.items
            ? context.singles.additionalItems
            : context.singles.items;
          const child = tuple[index] ?? (index >= tuple.length ? tail : undefined);
          if (child) {
            constraints.push(atom(child, scope));
            evaluated = true;
          }
          if (!evaluated && context.singles.unevaluatedItems) {
            constraints.push(atom(context.singles.unevaluatedItems, scope));
            evaluated = true;
          }
          return { constraints, evaluated };
        };
        const positions = Array.from({ length: arrays ? boundary + 1 : 0 }, (_, index) => ({
          p: left.flatMap((unit) => item(unit, index).constraints),
          q: right.flatMap((unit) => item(unit, index).constraints),
        }));
        const forbiddenPosition = positions.findIndex((position) => forbidden(position.p));
        const maximum = Math.min(
          Infinity,
          ...a.map((unit) => unit.local?.maxItems ?? Infinity),
          forbiddenPosition < 0 ? Infinity : forbiddenPosition,
        );
        const inferred = {
          ...(objects && Number.isFinite(propertyLimit) ? { maxProperties: propertyLimit } : {}),
          ...(arrays && Number.isFinite(maximum) ? { maxItems: maximum } : {}),
        };
        if (!scalarSubset(conjunction([...a.map((unit) => unit.local), inferred]), scalarB))
          return false;
        for (const { p, q } of rows)
          if (q.length && !compare(p, q, progress + 1, depth + 1)) return false;
        for (const { p, q } of positions.slice(0, Math.min(maximum, positions.length)))
          if (q.length && !compare(p, q, progress + 1, depth + 1)) return false;
        return true;
      } finally {
        active.delete(key);
      }
    };
    return compare(
      [atom(graphs[0].root, initialSchemaScope())],
      [atom(graphs[1].root, initialSchemaScope())],
    );
  } catch {
    return false;
  }
}
