import { visitContract } from './contract-tree';
import { contractBudget } from './schema-validation';

const generated = new Set([
  'x-paritydiff-validation-graph',
  'x-paritydiff-reference-documents',
  'x-paritydiff-reference-manifest',
  'x-paritydiff-native-contract',
  'x-paritydiff-native-documents',
  'x-paritydiff-native-manifest',
  'x-paritydiff-native-edges',
  'x-paritydiff-native-root',
  'x-paritydiff-native-xml-source',
  'x-paritydiff-native-schema-validation',
  'x-paritydiff-xml-schema-bundle',
  'x-paritydiff-soap-bindings',
  'x-paritydiff-wsdl-http-bindings',
  'x-paritydiff-soap-mime-bindings',
  'x-paritydiff-asyncapi-bindings',
  'x-paritydiff-graphql-scalar-contracts',
  'x-paritydiff-graphql-compatibility',
  'x-paritydiff-payload-validation',
  'x-paritydiff-semantic-comparison',
  'x-paritydiff-import-scan',
]);

export function rejectGeneratedInputMetadata(input: unknown): void {
  const budget = contractBudget(input);
  if (budget) throw new Error(budget);
  const inspect = (value: unknown) =>
    visitContract(value, (node) => {
      if (Object.keys(node).some((key) => generated.has(key)))
        throw new Error('reserved generated contract metadata');
      for (const key of ['x-paritydiff-request-schema', 'x-paritydiff-response-schema'])
        if (node[key] !== undefined) inspect(node[key]);
    });
  inspect(input);
}
