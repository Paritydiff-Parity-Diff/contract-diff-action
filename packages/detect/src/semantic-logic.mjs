const composition = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);
const universe = ['null', 'boolean', 'string', 'array', 'object', 'integer', 'fraction'];
function types(schema) {
  if (!schema || typeof schema !== 'object') return universe;
  const declared = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : undefined;
  let domain = declared
    ? declared.flatMap((type) => (type === 'number' ? ['integer', 'fraction'] : [type]))
    : universe;
  if (schema.nullable === true && !domain.includes('null')) domain = domain.concat('null');
  const values = Object.hasOwn(schema, 'const')
    ? [schema.const]
    : Array.isArray(schema.enum)
      ? schema.enum
      : undefined;
  if (values) {
    const literalTypes = new Set(
      values.map((value) =>
        value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value === 'number'
              ? Number.isInteger(value)
                ? 'integer'
                : 'fraction'
              : typeof value,
      ),
    );
    domain = domain.filter((type) => literalTypes.has(type));
  }
  return domain;
}
export function logicalSubset(before, after, atomSubset, canonical, atomConjunctionSubset) {
  try {
    if (/"\$(?:ref|dynamicRef|recursiveRef)"\s*:/.test(JSON.stringify([before, after])))
      return false;
    let steps = 0;
    const atoms = [],
      keys = new Map(),
      nodes = [null, null],
      unique = new Map(),
      memo = new Map(),
      negated = new Map([
        [0, 1],
        [1, 0],
      ]);
    const node = (variable, low, high) => {
      if (low === high) return low;
      const key = variable + ':' + low + ':' + high;
      if (unique.has(key)) return unique.get(key);
      if (nodes.length >= 4096) throw new Error('semantic_logic_resource_limit');
      const id = nodes.push({ variable, low, high }) - 1;
      unique.set(key, id);
      return id;
    };
    const not = (id) => {
      if (negated.has(id)) return negated.get(id);
      const item = nodes[id],
        result = node(item.variable, not(item.low), not(item.high));
      negated.set(id, result);
      return result;
    };
    const apply = (operator, a, b) => {
      if (++steps > 32768) throw new Error('semantic_logic_resource_limit');
      if (a > b) [a, b] = [b, a];
      if (a === b) return a;
      if (operator === 'and' && (a === 0 || b === 1)) return a;
      if (operator === 'and' && a === 1) return b;
      if (operator === 'or' && (a === 1 || b === 1)) return 1;
      if (operator === 'or' && a === 0) return b;
      const key = operator + ':' + a + ':' + b;
      if (memo.has(key)) return memo.get(key);
      const variable = Math.min(nodes[a].variable, nodes[b].variable),
        left = nodes[a].variable === variable ? nodes[a] : { low: a, high: a },
        right = nodes[b].variable === variable ? nodes[b] : { low: b, high: b },
        result = node(
          variable,
          apply(operator, left.low, right.low),
          apply(operator, left.high, right.high),
        );
      memo.set(key, result);
      return result;
    };
    const and = (a, b) => apply('and', a, b),
      or = (a, b) => apply('or', a, b);
    const atom = (schema) => {
      const key = JSON.stringify(canonical(schema));
      if (!keys.has(key)) {
        if (atoms.length >= 16) throw new Error('semantic_logic_atom_limit');
        keys.set(key, atoms.length);
        atoms.push(schema);
      }
      return node(keys.get(key), 0, 1);
    };
    const formula = (schema, depth = 0) => {
      if (depth > 24) throw new Error('semantic_logic_depth_limit');
      if (schema === true) return 1;
      if (schema === false) return 0;
      schema = canonical(schema);
      if (
        Object.hasOwn(schema, 'unevaluatedProperties') ||
        Object.hasOwn(schema, 'unevaluatedItems')
      )
        return atom(schema);
      const rest = Object.fromEntries(
        Object.entries(schema).filter(([key]) => !composition.has(key)),
      );
      let result = Object.keys(rest).length ? atom(rest) : 1;
      for (const child of schema.allOf ?? []) result = and(result, formula(child, depth + 1));
      if (schema.anyOf)
        result = and(
          result,
          schema.anyOf.reduce((value, child) => or(value, formula(child, depth + 1)), 0),
        );
      if (schema.oneOf) {
        let none = 1,
          one = 0;
        for (const child of schema.oneOf) {
          const choice = formula(child, depth + 1);
          one = or(and(one, not(choice)), and(none, choice));
          none = and(none, not(choice));
        }
        result = and(result, one);
      }
      if (Object.hasOwn(schema, 'not')) result = and(result, not(formula(schema.not, depth + 1)));
      if (
        Object.hasOwn(schema, 'if') &&
        (Object.hasOwn(schema, 'then') || Object.hasOwn(schema, 'else'))
      ) {
        const condition = formula(schema.if, depth + 1);
        result = and(
          result,
          or(
            and(condition, formula(schema.then ?? true, depth + 1)),
            and(not(condition), formula(schema.else ?? true, depth + 1)),
          ),
        );
      }
      return result;
    };
    let counterexample = and(formula(before), not(formula(after)));
    if (counterexample === 0) return true;
    const domains = atoms.map(types),
      variables = atoms.map((_, index) => node(index, 0, 1));
    for (let a = 0; a < atoms.length; a++) {
      if (and(counterexample, variables[a]) === 0) continue;
      if (!domains[a].length || atomSubset(atoms[a], false))
        counterexample = and(counterexample, not(variables[a]));
      for (let b = 0; b < atoms.length; b++) {
        if (a === b) continue;
        if (domains[a].every((type) => !domains[b].includes(type)))
          counterexample = and(counterexample, not(and(variables[a], variables[b])));
        if (and(counterexample, and(variables[a], not(variables[b]))) === 0) continue;
        const pureType = Object.keys(atoms[b]).every((key) => key === 'type');
        if (
          (pureType && domains[a].every((type) => domains[b].includes(type))) ||
          atomSubset(atoms[a], atoms[b])
        )
          counterexample = and(counterexample, or(not(variables[a]), variables[b]));
        if (counterexample === 0) return true;
      }
    }
    if (atomConjunctionSubset)
      for (let a = 0; a < atoms.length; a++)
        for (let b = a + 1; b < atoms.length; b++)
          for (let c = 0; c < atoms.length; c++) {
            if (c === a || c === b) continue;
            if (and(counterexample, and(and(variables[a], variables[b]), not(variables[c]))) === 0)
              continue;
            if (atomConjunctionSubset([atoms[a], atoms[b]], atoms[c]))
              counterexample = and(
                counterexample,
                or(not(and(variables[a], variables[b])), variables[c]),
              );
            if (counterexample === 0) return true;
          }
    return counterexample === 0;
  } catch {
    return false;
  }
}
