export function conditionalAnnotations(context, metadata, charge) {
  if (context.node?.type !== 'object' || context.node.unevaluatedProperties !== false)
    return context;
  let serial = 0;
  const unit = (parent, node, members = {}) => {
    charge();
    return {
      ...parent,
      id: 'activation-' + context.id + '-' + serial++,
      node,
      maps: {},
      lists: {},
      singles: {},
      ...members,
    };
  };
  const group = (keyword, children, parent = context) =>
    unit(parent, { [keyword]: children.map(() => true) }, { lists: { [keyword]: children } });
  const negate = (child) => unit(child, { not: true }, { singles: { not: child } });
  const allowed = new Set([
    'type',
    'properties',
    'patternProperties',
    'additionalProperties',
    'propertyNames',
    'required',
    'dependentRequired',
    'minProperties',
    'maxProperties',
    'const',
    'enum',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'dependentSchemas',
  ]);
  let visits = 0,
    activated = false;
  const bounded = (cases) => {
    if (cases.length > 7) throw new Error('annotation_activation_limit');
    return cases;
  };
  const combine = (left, right) =>
    bounded(
      left.flatMap((a) =>
        right.map((b) => ({
          constraints: [...a.constraints, ...b.constraints],
          producers: [...a.producers, ...b.producers],
        })),
      ),
    );
  const cases = (entry) => {
    charge();
    if (++visits > 64) throw new Error('annotation_activation_limit');
    const node = entry.node;
    if (typeof node === 'boolean') return [{ constraints: [entry], producers: [] }];
    if (Object.keys(node).some((name) => !metadata.has(name) && !allowed.has(name)))
      throw new Error('annotation_activation_unavailable');
    const remove = new Set(['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas']);
    const own = unit(
      entry,
      Object.fromEntries(Object.entries(node).filter(([name]) => !remove.has(name))),
      {
        maps: Object.fromEntries(Object.entries(entry.maps).filter(([name]) => !remove.has(name))),
        singles: Object.fromEntries(
          Object.entries(entry.singles).filter(([name]) => !remove.has(name)),
        ),
      },
    );
    let result = [{ constraints: [own], producers: [own] }];
    for (const child of entry.lists.allOf ?? []) result = combine(result, cases(child));
    for (const keyword of ['anyOf', 'oneOf']) {
      const branches = entry.lists[keyword];
      if (!branches) continue;
      if (branches.length > 3) throw new Error('annotation_activation_limit');
      const alternatives = branches.map(cases),
        selected = [];
      for (let mask = 1; mask < 2 ** branches.length; mask++) {
        if (keyword === 'oneOf' && mask & (mask - 1)) continue;
        let branchCases = [{ constraints: [], producers: [] }];
        for (const [index, child] of branches.entries())
          branchCases = combine(
            branchCases,
            mask & (1 << index)
              ? alternatives[index]
              : [{ constraints: [negate(child)], producers: [] }],
          );
        selected.push(...branchCases);
        bounded(selected);
      }
      result = combine(result, selected);
    }
    if (entry.singles.if) {
      activated = true;
      const positive = cases(entry.singles.if);
      const empty = [{ constraints: [], producers: [] }];
      const then = entry.singles.then ? cases(entry.singles.then) : empty;
      const otherwise = entry.singles.else ? cases(entry.singles.else) : empty;
      result = combine(
        result,
        bounded([
          ...combine(positive, then),
          ...combine([{ constraints: [negate(entry.singles.if)], producers: [] }], otherwise),
        ]),
      );
    }
    for (const [name, child] of entry.maps.dependentSchemas ?? []) {
      activated = true;
      const trigger = unit(entry, { type: 'object', required: [name] });
      result = combine(
        result,
        bounded([
          ...combine([{ constraints: [trigger], producers: [] }], cases(child)),
          { constraints: [negate(trigger)], producers: [] },
        ]),
      );
    }
    return result;
  };
  try {
    const { unevaluatedProperties: _closed, ...node } = context.node;
    const { unevaluatedProperties: _single, ...singles } = context.singles;
    const accepted = cases(
      unit(context, node, { maps: context.maps, lists: context.lists, singles }),
    );
    if (!activated) return context;
    const yes = unit(context, true),
      no = unit(context, false);
    const alternatives = accepted.map(({ constraints, producers }) => {
      if (!producers.some((producer) => producer.singles.additionalProperties)) {
        const names = [
          ...new Set(producers.flatMap((p) => [...(p.maps.properties?.keys() ?? [])])),
        ];
        const patterns = [
          ...new Set(producers.flatMap((p) => [...(p.maps.patternProperties?.keys() ?? [])])),
        ];
        constraints.push(
          unit(
            context,
            {
              properties: Object.fromEntries(names.map((name) => [name, true])),
              patternProperties: Object.fromEntries(patterns.map((name) => [name, true])),
              additionalProperties: false,
            },
            {
              maps: {
                properties: new Map(names.map((name) => [name, yes])),
                patternProperties: new Map(patterns.map((name) => [name, yes])),
              },
              singles: { additionalProperties: no },
            },
          ),
        );
      }
      return group('allOf', constraints);
    });
    return group('anyOf', alternatives);
  } catch (error) {
    if (
      ['annotation_activation_limit', 'annotation_activation_unavailable'].includes(error.message)
    )
      return context;
    throw error;
  }
}
