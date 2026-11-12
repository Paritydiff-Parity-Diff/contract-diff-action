import { conditionalAnnotations } from './conditional-annotations.mjs';

export function containsAnnotationCoverage(context, metadata, charge = () => {}) {
  let node = context.node;
  if (!node || typeof node !== 'object') return context;
  if (
    node.type === 'array' &&
    context.kind === '2020' &&
    node.unevaluatedItems === false &&
    context.lists.allOf?.length &&
    context.lists.allOf.length <= 3 &&
    Object.keys(node).every(
      (name) =>
        metadata.has(name) ||
        ['type', 'allOf', 'unevaluatedItems', 'minItems', 'maxItems', 'uniqueItems'].includes(name),
    ) &&
    context.lists.allOf.every(
      (child) =>
        child.kind === '2020' &&
        child.singles.contains &&
        Object.keys(child.node).every(
          (name) =>
            metadata.has(name) || ['type', 'contains', 'minContains', 'maxContains'].includes(name),
        ) &&
        (child.node.type === undefined || child.node.type === 'array'),
    )
  ) {
    charge();
    charge();
    const contains = context.lists.allOf.map((child) => child.singles.contains),
      union = {
        ...context,
        id: 'contains-coverage-' + context.id,
        node: { anyOf: contains.map(() => true) },
        maps: {},
        singles: {},
        lists: { anyOf: contains },
      },
      { unevaluatedItems: _closed, ...rest } = node,
      { unevaluatedItems: _single, ...singles } = context.singles;
    return { ...context, node: { ...rest, items: true }, singles: { ...singles, items: union } };
  }
  return context;
}
export function annotationObligations(context, metadata, charge = () => {}) {
  context = containsAnnotationCoverage(context, metadata, charge);
  let node = context.node;
  if (!node || typeof node !== 'object') return context;
  const arrayKeywords = new Set([
    'type',
    'contains',
    'minContains',
    'maxContains',
    'minItems',
    'maxItems',
    'uniqueItems',
    'const',
    'enum',
    'unevaluatedItems',
  ]);
  if (
    node.type === 'array' &&
    node.unevaluatedItems === false &&
    context.singles.contains &&
    ['2019', '2020'].includes(context.kind) &&
    Object.keys(node).every((name) => metadata.has(name) || arrayKeywords.has(name))
  ) {
    charge();
    const {
      contains: _contains,
      minContains: _min,
      maxContains: _max,
      unevaluatedItems: _unevaluated,
      ...rest
    } = node;
    const minimum = node.minContains ?? 1;
    if (context.kind === '2019')
      return { ...context, node: minimum > 0 ? false : { ...rest, maxItems: 0 }, singles: {} };
    return {
      ...context,
      node: {
        ...rest,
        items: true,
        minItems: Math.max(node.minItems ?? 0, minimum),
        ...(node.maxContains !== undefined || node.maxItems !== undefined
          ? { maxItems: Math.min(node.maxItems ?? Infinity, node.maxContains ?? Infinity) }
          : {}),
      },
      singles: { items: context.singles.contains },
    };
  }
  const coveredProperties =
    context.singles.additionalProperties && context.singles.unevaluatedProperties;
  const coveredItems =
    (context.singles.items || (context.lists.items && context.singles.additionalItems)) &&
    context.singles.unevaluatedItems;
  if (coveredProperties || coveredItems) {
    node = { ...node };
    const singles = { ...context.singles };
    for (const [covered, keyword] of [
      [coveredProperties, 'unevaluatedProperties'],
      [coveredItems, 'unevaluatedItems'],
    ])
      if (covered) {
        delete node[keyword];
        delete singles[keyword];
      }
    context = { ...context, node, singles };
  }
  const conditional = conditionalAnnotations(context, metadata, charge);
  if (conditional !== context) return conditional;
  if (
    node.type !== 'object' ||
    node.unevaluatedProperties !== false ||
    (context.lists.anyOf?.length ?? 0) > 3
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
    'unevaluatedProperties',
    'propertyNames',
  ]);
  if (Object.keys(node).some((name) => !metadata.has(name) && !allowed.has(name))) return context;
  if (!context.lists.anyOf) {
    const { unevaluatedProperties: _unevaluated, ...rest } = node;
    const { unevaluatedProperties: _single, ...singles } = context.singles;
    charge();
    const no = {
      ...context,
      id: 'annotation-local-false-' + context.id,
      node: false,
      maps: {},
      lists: {},
      singles: {},
    };
    return {
      ...context,
      node: { ...rest, additionalProperties: false },
      singles: { ...singles, additionalProperties: no },
    };
  }
  const branches = context.lists.anyOf.filter((branch) => branch.node !== false);
  if (
    !branches.length ||
    branches.some(
      (branch) =>
        branch.node !== true &&
        ((branch.node.type !== undefined && branch.node.type !== 'object') ||
          Object.keys(branch.node).some(
            (name) =>
              !metadata.has(name) && !['type', 'properties', 'patternProperties'].includes(name),
          )),
    )
  )
    return context;
  const unit = (id, node, members = {}) => {
    charge();
    return {
      ...context,
      id: 'annotation-' + context.id + '-' + id,
      node,
      maps: {},
      lists: {},
      singles: {},
      ...members,
    };
  };
  const keys = (branch, keyword) => [...(branch.maps[keyword]?.keys() ?? [])].sort();
  const sameKeys = (keyword) =>
    branches.every(
      (branch) =>
        JSON.stringify(keys(branch, keyword)) === JSON.stringify(keys(branches[0], keyword)),
    );
  const sameChild = (a, b) =>
    a.base === b.base &&
    a.dialect === b.dialect &&
    a.resource === b.resource &&
    JSON.stringify(a.node) === JSON.stringify(b.node);
  if (
    branches.every(
      (branch) =>
        branch.resource === context.resource &&
        branch.base === context.base &&
        branch.dialect === context.dialect,
    ) &&
    sameKeys('properties') &&
    sameKeys('patternProperties')
  ) {
    const names = keys(branches[0], 'properties');
    const patterns = keys(branches[0], 'patternProperties');
    const different = names.filter(
      (name) =>
        !branches.every((branch) =>
          sameChild(branches[0].maps.properties.get(name), branch.maps.properties.get(name)),
        ),
    );
    if (
      different.length <= 1 &&
      patterns.every((name) =>
        branches.every((branch) =>
          sameChild(
            branches[0].maps.patternProperties.get(name),
            branch.maps.patternProperties.get(name),
          ),
        ),
      )
    ) {
      const properties = new Map(branches[0].maps.properties ?? []);
      if (different.length) {
        const name = different[0];
        properties.set(
          name,
          unit(
            'value-union-' + JSON.stringify(name),
            { anyOf: branches.map(() => true) },
            { lists: { anyOf: branches.map((branch) => branch.maps.properties.get(name)) } },
          ),
        );
      }
      const merged = unit(
        'merged-properties',
        {
          properties: Object.fromEntries(names.map((name) => [name, true])),
          patternProperties: Object.fromEntries(patterns.map((name) => [name, true])),
        },
        {
          maps: { properties, patternProperties: branches[0].maps.patternProperties ?? new Map() },
        },
      );
      const { anyOf: _choices, ...rest } = node;
      const { anyOf: _list, ...lists } = context.lists;
      return { ...context, node: { ...rest, allOf: [true] }, lists: { ...lists, allOf: [merged] } };
    }
  }
  const { anyOf: _anyOf, unevaluatedProperties: _unevaluated, ...baseNode } = node;
  const { anyOf: _anyOfList, ...baseLists } = context.lists;
  const { unevaluatedProperties: _unevaluatedSingle, ...baseSingles } = context.singles;
  const base = unit('base', baseNode, {
    maps: context.maps,
    lists: baseLists,
    singles: baseSingles,
  });
  const yes = unit('true', true),
    no = unit('false', false);
  const closures = new Map();
  const cases = [];
  for (let mask = 1; mask < 2 ** branches.length; mask++) {
    const positives = branches.filter((_, index) => mask & (1 << index));
    const selected = [context, ...positives];
    const properties = [
      ...new Set(selected.flatMap((branch) => [...(branch.maps.properties?.keys() ?? [])])),
    ].sort();
    const patterns = [
      ...new Set(selected.flatMap((branch) => [...(branch.maps.patternProperties?.keys() ?? [])])),
    ].sort();
    const key = JSON.stringify([properties, patterns]);
    if (!closures.has(key))
      closures.set(
        key,
        unit(
          'closure-' + closures.size,
          {
            type: 'object',
            properties: Object.fromEntries(properties.map((name) => [name, true])),
            patternProperties: Object.fromEntries(patterns.map((name) => [name, true])),
            additionalProperties: false,
          },
          {
            maps: {
              properties: new Map(properties.map((name) => [name, yes])),
              patternProperties: new Map(patterns.map((name) => [name, yes])),
            },
            singles: { additionalProperties: no },
          },
        ),
      );
    const constraints = [base, closures.get(key), ...positives];
    for (const [index, branch] of branches.entries())
      if (!(mask & (1 << index)))
        constraints.push(unit('negative-' + index, { not: true }, { singles: { not: branch } }));
    cases.push(
      unit(
        'case-' + mask,
        { allOf: constraints.map(() => true) },
        { lists: { allOf: constraints } },
      ),
    );
  }
  return {
    ...context,
    node: { anyOf: cases.map(() => true) },
    maps: {},
    lists: { anyOf: cases },
    singles: {},
  };
}
