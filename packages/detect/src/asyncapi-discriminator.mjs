import { createSchemaEngine } from './schema-engine.mjs';
import { dialectSchema } from './semantic-compare.mjs';
const unavailable = (reason) => {
  throw new Error(reason);
};
export function createDiscriminatorPlans(locations, resolve, add) {
  const named = [...locations.values()].filter(
    (context) =>
      /^\/components\/schemas\/[^/]+(?:\/schema)?$/.test(context.pointer) &&
      context.kind === 'asyncapi',
  );
  if (
    !named.some(
      (context) =>
        context.node &&
        typeof context.node === 'object' &&
        Object.hasOwn(context.node, 'discriminator'),
    )
  )
    return () => undefined;
  if (named.length > 256) unavailable('asyncapi_discriminator_family_budget');
  const byPointer = new Map(named.map((context) => [context.pointer, context])),
    parents = new Map(),
    ancestors = new Map();
  let steps = 0;
  const collect = (node, context, depth = 0) => {
    if (++steps > 20000 || depth > 64) unavailable('asyncapi_discriminator_family_budget');
    const output = new Set();
    for (const branch of node?.allOf ?? []) {
      if (branch && typeof branch === 'object' && typeof branch.$ref === 'string') {
        const parent = resolve(branch.$ref, context.base);
        if (!byPointer.has(parent.pointer))
          unavailable('asyncapi_discriminator_parent_unavailable');
        output.add(parent.pointer);
      } else for (const pointer of collect(branch, context, depth + 1)) output.add(pointer);
    }
    return output;
  };
  for (const context of named) parents.set(context.pointer, collect(context.node, context));
  const lineage = (pointer, seen = new Set()) => {
    if (ancestors.has(pointer)) return ancestors.get(pointer);
    if (seen.has(pointer) || seen.size > 64)
      unavailable('asyncapi_discriminator_inheritance_cycle');
    const next = new Set(seen).add(pointer),
      result = new Set([pointer]);
    for (const parent of parents.get(pointer) ?? [])
      for (const ancestor of lineage(parent, next)) result.add(ancestor);
    ancestors.set(pointer, result);
    return result;
  };
  for (const context of named) lineage(context.pointer);
  const declarations = named.filter((context) =>
    Object.hasOwn(context.node ?? {}, 'discriminator'),
  );
  for (const context of declarations) {
    const key = context.node.discriminator;
    if (
      typeof key !== 'string' ||
      !key.length ||
      !Object.hasOwn(context.node.properties ?? {}, key) ||
      !context.node.required?.includes(key)
    )
      unavailable('asyncapi_discriminator_declaration_invalid');
  }
  const tag = (context, key) => {
    const values = new Set();
    const scan = (node, depth = 0) => {
      if (++steps > 20000 || depth > 64) unavailable('asyncapi_discriminator_family_budget');
      const property = node?.properties?.[key];
      if (property && typeof property === 'object') {
        const value = Object.hasOwn(property, 'const')
          ? property.const
          : Array.isArray(property.enum) && property.enum.length === 1
            ? property.enum[0]
            : undefined;
        if (value !== undefined) {
          if (typeof value !== 'string' || !value.length)
            unavailable('asyncapi_discriminator_tag_unavailable');
          values.add(value);
        }
      }
      for (const child of node?.allOf ?? [])
        if (typeof child?.$ref !== 'string') scan(child, depth + 1);
    };
    scan(context.node);
    if (values.size > 1) unavailable('asyncapi_discriminator_tag_ambiguous');
    return values.size
      ? [...values][0]
      : context.pointer
          .match(/^\/components\/schemas\/([^/]+)/)[1]
          .replace(/~1/g, '/')
          .replace(/~0/g, '~');
  };
  return (context) => {
    if (!byPointer.has(context.pointer)) return;
    const inherited = declarations.filter((base) =>
      ancestors.get(context.pointer).has(base.pointer),
    );
    if (!inherited.length) return;
    const plans = [],
      keys = new Set();
    for (const base of inherited) {
      const key = base.node.discriminator;
      if (keys.has(key)) unavailable('asyncapi_discriminator_multiple_declarations');
      keys.add(key);
      const targets = [],
        values = new Set();
      for (const target of named.filter((target) =>
        ancestors.get(target.pointer).has(context.pointer),
      )) {
        const value = tag(target, key);
        if (values.has(value)) unavailable('asyncapi_discriminator_tag_ambiguous');
        values.add(value);
        targets.push({ value, ref: add(target) });
      }
      plans.push({ key, targets, scope: context.pointer });
    }
    return plans;
  };
}
export function compileAsyncapiDiscriminator(context) {
  let engine, active, calls;
  const validate = (plans, data) => {
    if (++calls > 20000) unavailable('asyncapi_discriminator_instance_budget');
    if (!Array.isArray(plans) || plans.length > 32)
      unavailable('asyncapi_discriminator_plan_invalid');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    let running = active.get(data);
    if (!running) {
      running = new Set();
      active.set(data, running);
    }
    for (const plan of plans) {
      if (
        typeof plan.scope !== 'string' ||
        typeof plan.key !== 'string' ||
        !Array.isArray(plan.targets) ||
        plan.targets.length > 256
      )
        unavailable('asyncapi_discriminator_plan_invalid');
      const identity = plan.scope + '#' + plan.key;
      if (running.has(identity)) continue;
      const targets = plan.targets.filter((target) => target.value === data[plan.key]);
      if (!Object.hasOwn(data, plan.key) || targets.length !== 1) return false;
      const target = engine.getSchema(targets[0].ref);
      if (!target) unavailable('asyncapi_discriminator_target_unavailable');
      running.add(identity);
      try {
        if (!target(data)) return false;
      } finally {
        running.delete(identity);
      }
    }
    return true;
  };
  engine = createSchemaEngine(context.dialect, dialectSchema, { nativeDiscriminator: validate });
  const root = engine.compile(context.schema, context.resources);
  return (data) => {
    active = new WeakMap();
    calls = 0;
    return root(data);
  };
}
