const unavailable = (reason) => {
  throw new Error(reason);
};
export function createOpenapiDiscriminatorPlans(locations, resolve, add) {
  const named = [...locations.values()].filter(
      (context) =>
        context.kind === 'openapi30' &&
        /^\/components\/schemas\/[^/]+(?:\/schema)?$/.test(context.pointer),
    ),
    byPointer = new Map(named.map((context) => [context.pointer, context])),
    parents = new Map(),
    ancestors = new Map();
  if (named.length > 256) unavailable('asyncapi_openapi_discriminator_budget');
  let steps = 0;
  const collect = (node, context, depth = 0) => {
    if (++steps > 20000 || depth > 64) unavailable('asyncapi_openapi_discriminator_budget');
    const result = new Set();
    for (const branch of node?.allOf ?? []) {
      if (typeof branch?.$ref === 'string') {
        const parent = resolve(branch.$ref, context.base);
        if (byPointer.has(parent.pointer)) result.add(parent.pointer);
      } else for (const pointer of collect(branch, context, depth + 1)) result.add(pointer);
    }
    return result;
  };
  for (const context of named) parents.set(context.pointer, collect(context.node, context));
  const lineage = (pointer, seen = new Set()) => {
    if (ancestors.has(pointer)) return ancestors.get(pointer);
    if (seen.has(pointer) || seen.size > 64) unavailable('asyncapi_openapi_discriminator_cycle');
    const result = new Set([pointer]),
      next = new Set(seen).add(pointer);
    for (const parent of parents.get(pointer) ?? [])
      for (const ancestor of lineage(parent, next)) result.add(ancestor);
    ancestors.set(pointer, result);
    return result;
  };
  for (const context of named) lineage(context.pointer);
  const declarations = named.filter((context) => context.node?.discriminator);
  const schemaName = (context) =>
    context.pointer
      .match(/^\/components\/schemas\/([^/]+)/)[1]
      .replace(/~1/g, '/')
      .replace(/~0/g, '~');
  return (context) => {
    const bases = declarations.filter((base) => ancestors.get(context.pointer)?.has(base.pointer));
    if (context.node?.discriminator && !bases.includes(context)) bases.push(context);
    if (!bases.length) return;
    const keys = new Set();
    return bases.map((base) => {
      const declaration = base.node.discriminator,
        key = declaration?.propertyName;
      if (typeof key !== 'string' || !key || keys.has(key))
        unavailable('asyncapi_openapi_discriminator_declaration_invalid');
      keys.add(key);
      const references = base.node.oneOf ?? base.node.anyOf;
      let candidates;
      if (references) {
        if (!Array.isArray(references) || !references.length || references.length > 128)
          unavailable('asyncapi_openapi_discriminator_union_unavailable');
        candidates = references.map((branch) => {
          if (typeof branch?.$ref !== 'string' || Object.keys(branch).length !== 1)
            unavailable('asyncapi_openapi_discriminator_inline_unavailable');
          const target = resolve(branch.$ref, base.base);
          if (!byPointer.has(target.pointer))
            unavailable('asyncapi_openapi_discriminator_target_unavailable');
          return target;
        });
      } else {
        if (!byPointer.has(base.pointer))
          unavailable('asyncapi_openapi_discriminator_inline_unavailable');
        candidates = named.filter((target) => ancestors.get(target.pointer).has(base.pointer));
      }
      const mapping = declaration.mapping ?? {},
        targets = [],
        values = new Set(),
        explicit = new Set();
      if (
        !mapping ||
        typeof mapping !== 'object' ||
        Array.isArray(mapping) ||
        Object.keys(mapping).length > 256
      )
        unavailable('asyncapi_openapi_discriminator_mapping_unavailable');
      for (const [value, reference] of Object.entries(mapping)) {
        if (typeof reference !== 'string' || !reference || !value)
          unavailable('asyncapi_openapi_discriminator_mapping_unavailable');
        let target;
        if (!reference.includes('/') && !reference.includes('#') && !reference.includes(':')) {
          const matches = named.filter((item) => schemaName(item) === reference);
          if (matches.length !== 1)
            unavailable('asyncapi_openapi_discriminator_target_unavailable');
          target = matches[0];
        } else target = resolve(reference, base.base);
        if (!candidates.some((item) => item.pointer === target.pointer))
          unavailable('asyncapi_openapi_discriminator_target_unavailable');
        explicit.add(target.pointer);
        values.add(value);
        targets.push({ value, ref: add(target) });
      }
      for (const target of candidates) {
        if (explicit.has(target.pointer)) continue;
        const value = schemaName(target);
        if (values.has(value)) unavailable('asyncapi_openapi_discriminator_tag_ambiguous');
        values.add(value);
        targets.push({ value, ref: add(target) });
      }
      const selected =
        !references && byPointer.has(context.pointer)
          ? targets.filter((target) =>
              candidates.some(
                (candidate) =>
                  add(candidate) === target.ref &&
                  ancestors.get(candidate.pointer).has(context.pointer),
              ),
            )
          : targets;
      return { key, scope: base.pointer, targets: selected };
    });
  };
}
