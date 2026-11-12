import type { ContractEncoding } from '@paritydiff/core';

export const CONTRACT_FORMATS: readonly {
  encoding: ContractEncoding;
  label: string;
  accept: string;
  contract: 'native' | 'mixed' | 'evidence';
  description: string;
}[] = [
  {
    encoding: 'json',
    label: 'JSON',
    accept: '.json',
    contract: 'mixed',
    description:
      'OpenAPI, Swagger, Postman, JSON Schema, AsyncAPI or GraphQL introspection. Collections remain observational unless explicitly asserted.',
  },
  {
    encoding: 'yaml',
    label: 'YAML',
    accept: '.yaml,.yml',
    contract: 'mixed',
    description: 'OpenAPI, Swagger, JSON Schema or AsyncAPI. Validation uses the declared dialect.',
  },
  {
    encoding: 'graphql',
    label: 'GraphQL SDL',
    accept: '.graphql,.gql',
    contract: 'native',
    description:
      'GraphQL schema validation and declared type changes. Repository selection and execution semantics need independent evidence.',
  },
  {
    encoding: 'protobuf',
    label: 'Protocol Buffers',
    accept: '.proto',
    contract: 'native',
    description:
      'Protocol Buffer descriptors and gRPC method contracts. Imports and wire/runtime compatibility need independent evidence.',
  },
  {
    encoding: 'xml',
    label: 'WSDL / XSD',
    accept: '.wsdl,.xsd,.xml',
    contract: 'mixed',
    description:
      'Native XML contracts with captured imports. Declared XSD 1.0/1.1 validation uses the configured standards validator. SOAP binding and repository behavior require separate evidence.',
  },
  {
    encoding: 'pdf',
    label: 'PDF documentation',
    accept: '.pdf',
    contract: 'evidence',
    description:
      'Embedded text and local OCR for scanned pages, with page, location and confidence evidence. Review and validate an extracted contract before authorizing a migration.',
  },
  {
    encoding: 'image',
    label: 'Scanned image',
    accept: '.png,.jpg,.jpeg',
    contract: 'evidence',
    description:
      'Local OCR with page, location and confidence evidence. English model is bundled; recognition must be reviewed before it establishes a contract.',
  },
  {
    encoding: 'text',
    label: 'Plain text',
    accept: '.txt',
    contract: 'evidence',
    description:
      'Documentation evidence is retained without executing it or asserting a complete contract.',
  },
  {
    encoding: 'markdown',
    label: 'Markdown',
    accept: '.md,.markdown',
    contract: 'evidence',
    description:
      'Documentation evidence is retained without executing it or asserting a complete contract.',
  },
  {
    encoding: 'html',
    label: 'HTML documentation',
    accept: '.html,.htm',
    contract: 'evidence',
    description:
      'HTML is stored as text evidence. Scripts, links and embedded resources are never executed or followed.',
  },
  {
    encoding: 'binary',
    label: 'Other file (review required)',
    accept: '*',
    contract: 'evidence',
    description:
      'Preserve any bounded file as opaque evidence. Changes are monitored by content hash; a parser or reviewed machine-readable contract is required for semantic detection or migration.',
  },
];
