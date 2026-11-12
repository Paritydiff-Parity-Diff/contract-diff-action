export function validateGraphqlResponse(
  g,
  schema,
  query,
  operation,
  variables,
  scalarOutputs,
  response,
) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(response) ||
    Object.keys(response).some((key) => !['data', 'errors', 'extensions'].includes(key)) ||
    (response.extensions !== undefined && !object(response.extensions))
  )
    return { available: true, valid: false, reason: 'graphql_response_envelope_invalid' };
  const hasErrors = response.errors !== undefined;
  const invalidError = (error) => {
    if (
      !object(error) ||
      typeof error.message !== 'string' ||
      (error.extensions !== undefined && !object(error.extensions))
    )
      return true;
    if (
      error.path !== undefined &&
      (!Array.isArray(error.path) ||
        !error.path.length ||
        error.path.some(
          (value) => typeof value !== 'string' && (!Number.isSafeInteger(value) || value < 0),
        ))
    )
      return true;
    return (
      error.locations !== undefined &&
      (!Array.isArray(error.locations) ||
        !error.locations.length ||
        error.locations.some(
          (location) =>
            !object(location) ||
            !Number.isSafeInteger(location.line) ||
            location.line < 1 ||
            !Number.isSafeInteger(location.column) ||
            location.column < 1,
        ))
    );
  };
  if (
    hasErrors &&
    (!Array.isArray(response.errors) ||
      !response.errors.length ||
      response.errors.length > 1000 ||
      response.errors.some(invalidError))
  )
    return { available: true, valid: false, reason: 'graphql_response_errors_invalid' };
  if (!Object.hasOwn(response, 'data') || response.data === null)
    return {
      available: true,
      valid: hasErrors,
      reason: hasErrors ? 'graphql_error_response_validated' : 'graphql_response_data_missing',
    };
  const fragments = new Map(
    query.definitions
      .filter((node) => node.kind === 'FragmentDefinition')
      .map((node) => [node.name.value, node]),
  );
  let visited = 0,
    unavailable = false;
  const active = (node) =>
    !(node.directives ?? []).some((directive) => {
      const arg = directive.arguments?.find((argument) => argument.name.value === 'if');
      const value = arg && g.valueFromASTUntyped(arg.value, variables.coerced);
      return (
        (directive.name.value === 'skip' && value === true) ||
        (directive.name.value === 'include' && value === false)
      );
    });
  const applies = (condition, type) =>
    !condition ||
    condition.name.value === type.name ||
    (g.isAbstractType(schema.getType(condition.name.value)) &&
      schema.isSubType(schema.getType(condition.name.value), type));
  const selections = (sets, type, seen = new Set(), depth = 0) => {
    if (depth > 128 || ++visited > 200000) throw new Error('graphql_response_limit');
    const fields = new Map();
    for (const set of sets)
      for (const node of set.selections) {
        if (!active(node)) continue;
        if (node.kind === 'Field') {
          const name = node.alias?.value ?? node.name.value;
          fields.set(name, [...(fields.get(name) ?? []), node]);
        } else if (node.kind === 'InlineFragment' && applies(node.typeCondition, type)) {
          for (const [name, nodes] of selections([node.selectionSet], type, seen, depth + 1))
            fields.set(name, [...(fields.get(name) ?? []), ...nodes]);
        } else if (node.kind === 'FragmentSpread' && !seen.has(node.name.value)) {
          const fragment = fragments.get(node.name.value);
          if (!fragment || !active(fragment) || !applies(fragment.typeCondition, type)) continue;
          for (const [name, nodes] of selections(
            [fragment.selectionSet],
            type,
            new Set([...seen, node.name.value]),
            depth + 1,
          ))
            fields.set(name, [...(fields.get(name) ?? []), ...nodes]);
        }
      }
    return fields;
  };
  const validateObject = (value, type, sets, depth) => {
    if (!object(value)) return false;
    const fields = selections(sets, type);
    if (
      Object.keys(value).some((name) => !fields.has(name)) ||
      [...fields.keys()].some((name) => !Object.hasOwn(value, name))
    )
      return false;
    for (const [name, nodes] of fields) {
      if (nodes[0].name.value === '__typename') {
        if (value[name] !== type.name) return false;
        continue;
      }
      const field = type.getFields()[nodes[0].name.value];
      if (
        !field ||
        !validate(
          value[name],
          field.type,
          nodes.map((node) => node.selectionSet).filter(Boolean),
          depth + 1,
        )
      )
        return false;
    }
    return true;
  };
  const validate = (value, type, sets, depth = 0) => {
    if (depth > 128 || ++visited > 200000) throw new Error('graphql_response_limit');
    if (g.isNonNullType(type))
      return value !== null && validate(value, type.ofType, sets, depth + 1);
    if (value === null) return true;
    if (g.isListType(type))
      return (
        Array.isArray(value) && value.every((item) => validate(item, type.ofType, sets, depth + 1))
      );
    if (g.isEnumType(type))
      return typeof value === 'string' && type.getValues().some((item) => item.name === value);
    if (g.isScalarType(type)) {
      if (type.name === 'Int')
        return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
      if (type.name === 'Float') return typeof value === 'number' && Number.isFinite(value);
      if (type.name === 'Boolean') return typeof value === 'boolean';
      if (['String', 'ID'].includes(type.name)) return typeof value === 'string';
      if (!scalarOutputs.has(type.name)) {
        unavailable = true;
        return false;
      }
      return Boolean(scalarOutputs.get(type.name)(value));
    }
    if (g.isAbstractType(type)) {
      const candidates = schema
        .getPossibleTypes(type)
        .filter((type) => !object(value) || !value.__typename || value.__typename === type.name);
      return candidates.some((type) => validateObject(value, type, sets, depth + 1));
    }
    return g.isObjectType(type) && validateObject(value, type, sets, depth + 1);
  };
  const root =
    operation.operation === 'mutation'
      ? schema.getMutationType()
      : operation.operation === 'subscription'
        ? schema.getSubscriptionType()
        : schema.getQueryType();
  const valid = root && validateObject(response.data, root, [operation.selectionSet], 0);
  return {
    available: !unavailable,
    valid: Boolean(valid) && !unavailable,
    reason: unavailable
      ? 'custom_scalar_output_validation_unavailable'
      : valid
        ? 'graphql_selected_response_validated'
        : 'graphql_selected_response_invalid',
  };
}
