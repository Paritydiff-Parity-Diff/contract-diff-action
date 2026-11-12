import { compiler } from './semantic-compare.mjs';

export function scalarContracts(input, schema, g) {
  if (input === undefined) return {};
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length > 100
  )
    throw new Error('invalid_graphql_scalar_contracts');
  for (const [name, contract] of Object.entries(input)) {
    const scalar = schema.getType(name);
    if (
      !g.isScalarType(scalar) ||
      g.isSpecifiedScalarType(scalar) ||
      !contract ||
      typeof contract !== 'object' ||
      Array.isArray(contract) ||
      !Object.keys(contract).length ||
      Object.keys(contract).some((key) => !['input', 'output'].includes(key))
    )
      throw new Error('invalid_graphql_scalar_contract');
    for (const value of Object.values(contract)) compiler(value);
  }
  return input;
}

export function installScalarContracts(contracts, schema, g) {
  const inputs = new Set(),
    outputs = new Map();
  for (const [name, contract] of Object.entries(scalarContracts(contracts, schema, g))) {
    const scalar = schema.getType(name);
    if (Object.hasOwn(contract, 'input')) {
      const validate = compiler(contract.input);
      const accept = (value) => {
        if (!validate(value))
          throw new g.GraphQLError('Declared scalar input contract rejected value');
        return value;
      };
      scalar.coerceInputValue = accept;
      scalar.parseValue = accept;
      scalar.coerceInputLiteral = (node) => accept(g.valueFromASTUntyped(node));
      scalar.parseLiteral = (node, variables) => accept(g.valueFromASTUntyped(node, variables));
      inputs.add(name);
    }
    if (Object.hasOwn(contract, 'output')) outputs.set(name, compiler(contract.output));
  }
  return { inputs, outputs };
}
