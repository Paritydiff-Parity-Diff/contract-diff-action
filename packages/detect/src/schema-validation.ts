import Ajv, { type AnySchema } from 'ajv';
import { legacySchemaUris, legacySchemaDialect } from '@paritydiff/core';
import draft6 from 'ajv/dist/refs/json-schema-draft-06.json';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import AjvLegacy from 'ajv-legacy';
import formats from 'ajv-formats';
import draft4 from 'ajv-legacy/lib/refs/json-schema-draft-04.json';
import openapi30 from './schemas/openapi-3.0.json';
import openapi31 from './schemas/openapi-3.1.json';
import openapi31Base from './schemas/openapi-3.1-base.json';
import openapi31Dialect from './schemas/openapi-3.1-dialect.json';
import openapi31Meta from './schemas/openapi-3.1-meta.json';
import swagger20 from './schemas/swagger-2.0.json';
import openapi32 from './schemas/openapi-3.2.json';
import openapi32Dialect from './schemas/openapi-3.2-dialect.json';
import openapi32Meta from './schemas/openapi-3.2-meta.json';
import postman21 from './schemas/postman-2.1.json';
import postman20 from './schemas/postman-2.0.json';
import { resourceDispatchRequired } from './schema-resource-graph.mjs';
import { validateCompoundSchemaResources } from './semantic-compare.mjs';
import { formatAssertionDialect } from './schema-engine.mjs';

type Json = Record<string, unknown>;
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const mediaRange = new RegExp(
  `^(?:${token}|\\*)/(?:${token}|\\*)(?:[ \\t]*;[ \\t]*${token}=(?:${token}|"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"))*[ \\t]*$`,
);
const validMediaRange = (value: string) =>
  mediaRange.test(value) && (!value.startsWith('*/') || value.split(';')[0]?.trim() === '*/*');
export interface ContractValidation {
  readonly valid: boolean;
  readonly schema: string;
  readonly errors: readonly string[];
}
const legacy = new AjvLegacy({
  schemaId: 'id',
  meta: false,
  allErrors: true,
  validateSchema: false,
});
legacy.addMetaSchema(draft4);
legacy.addFormat('media-range', validMediaRange);
const oas30 = legacy.compile(openapi30);
const swagger = legacy.compile(swagger20);
const modern = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
formats(modern);
modern.addFormat('media-range', validMediaRange);
modern.addMetaSchema(openapi31Meta).addMetaSchema(openapi31Dialect);
modern.addMetaSchema(openapi32Meta).addMetaSchema(openapi32Dialect);
const draft7 = new Ajv({ strict: false, allErrors: true });
draft7.addMetaSchema(draft6);
formats(draft7);
const draft2019 = new Ajv2019({ strict: false, allErrors: true });
formats(draft2019);
const oasSchema = modern.getSchema(openapi31Dialect.$id)!;
const oas32Schema = modern.getSchema(openapi32Dialect.$id)!;
const supportedDialects = [
  openapi31Dialect.$id,
  openapi32Dialect.$id,
  'https://spec.openapis.org/oas/3.1/dialect/base',
  'https://spec.openapis.org/oas/3.2/dialect/base',
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2019-09/schema',
  ...legacySchemaUris,
  formatAssertionDialect,
].flatMap((dialect) => [dialect, ...(dialect.endsWith('#') ? [] : [dialect + '#'])]);

function embeddedSchema(input: unknown, inherited: unknown): boolean {
  if (typeof input !== 'boolean' && (!input || typeof input !== 'object' || Array.isArray(input)))
    return false;
  const dialect = typeof input === 'object' ? ((input as Json)['$schema'] ?? inherited) : inherited;
  if (dialect !== undefined && !supportedDialects.includes(String(dialect))) return false;
  try {
    if (
      dialect === formatAssertionDialect ||
      resourceDispatchRequired(input, [], String(dialect ?? openapi31Dialect.$id))
    )
      return validateCompoundSchemaResources(input, [], String(dialect ?? openapi31Dialect.$id));
  } catch {
    return false;
  }
  const legacyDialect = legacySchemaDialect(dialect);
  if (legacyDialect) {
    const schema = typeof input === 'boolean' ? input : { ...input, $schema: legacyDialect.uri };
    return Boolean(draft7.validateSchema(schema as AnySchema));
  }
  if (String(dialect).replace(/#$/, '') === 'https://json-schema.org/draft/2019-09/schema')
    return Boolean(draft2019.validateSchema(input as AnySchema));
  return Boolean(
    typeof dialect === 'string' && dialect.includes('/oas/3.2/')
      ? oas32Schema(input)
      : oasSchema(input),
  );
}

// Ajv's document-level dynamic-anchor scope differs from the OAS schema seam.
// Validate each seam with the independently compiled official dialect.
function bindSchemaSlots(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(bindSchemaSlots);
  if (!input || typeof input !== 'object') return input;
  if ((input as Json)['$dynamicRef'] === '#meta') return { contractSchema: true };
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, bindSchemaSlots(value)]),
  );
}
const structure = new Ajv2020({ strict: false, allErrors: true });
formats(structure);
structure.addFormat('media-range', validMediaRange);
structure.addKeyword({
  keyword: 'contractSchema',
  schemaType: 'boolean',
  errors: false,
  validate: (
    _enabled: boolean,
    schema: unknown,
    _parent: unknown,
    context?: { rootData?: unknown },
  ) => {
    const root = context?.rootData as Json | undefined;
    if (
      root?.['jsonSchemaDialect'] !== undefined &&
      !supportedDialects.includes(String(root['jsonSchemaDialect']))
    )
      return false;
    return embeddedSchema(
      schema,
      root?.['jsonSchemaDialect'] ??
        (String(root?.['openapi']).startsWith('3.2') ? openapi32Dialect.$id : openapi31Dialect.$id),
    );
  },
});
const oas31 = structure.compile(bindSchemaSlots(openapi31) as AnySchema);
const oas32 = structure.compile(bindSchemaSlots(openapi32) as AnySchema);
const postman = { '2.1': draft7.compile(postman21), '2.0': draft7.compile(postman20) };

export function contractBudget(input: unknown): string | undefined {
  const stack = [{ node: input, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > 128 || ++nodes > 200000) return 'document limits exceeded';
    if (item.node && typeof item.node === 'object')
      for (const child of Object.values(item.node))
        stack.push({ node: child, depth: item.depth + 1 });
  }
  return undefined;
}

export function validateContractDocument(input: unknown): ContractValidation {
  const budget = contractBudget(input);
  if (budget) return { valid: false, schema: 'resource-boundary', errors: [budget] };
  const doc = input as Json | null;
  const version = doc?.['openapi'];
  const dialect = doc?.['jsonSchemaDialect'];
  if (dialect !== undefined && !supportedDialects.includes(String(dialect)))
    return { valid: false, schema: String(dialect), errors: ['unsupported contract dialect'] };
  const validator =
    typeof version === 'string' && /^3\.0\.\d+$/.test(version)
      ? oas30
      : typeof version === 'string' && /^3\.1\.\d+$/.test(version)
        ? oas31
        : typeof version === 'string' && /^3\.2\.\d+$/.test(version)
          ? oas32
          : doc?.['swagger'] === '2.0'
            ? swagger
            : undefined;
  if (!validator)
    return { valid: false, schema: 'unknown', errors: ['unsupported contract version'] };
  try {
    const valid = validator(input);
    const errors = (validator.errors ?? []).slice(0, 25).map((e) => {
      const pointer = 'instancePath' in e ? e.instancePath : e.dataPath;
      return `${pointer || '/'}: ${e.message ?? e.keyword}`;
    });
    return {
      valid: Boolean(valid),
      schema:
        validator === oas30
          ? openapi30.id
          : validator === swagger
            ? swagger20.id
            : validator === oas32
              ? openapi32.$id
              : openapi31Base.$id,
      errors,
    };
  } catch {
    return {
      valid: false,
      schema: 'validator-unavailable',
      errors: ['contract validation unavailable'],
    };
  }
}

export function validatePostmanDocument(input: unknown): ContractValidation {
  const budget = contractBudget(input);
  if (budget) return { valid: false, schema: 'resource-boundary', errors: [budget] };
  const doc = input as { info?: { schema?: unknown } } | null;
  const uri = String(doc?.info?.schema ?? '');
  const version = /\/v2\.1\.0\//.test(uri) ? '2.1' : /\/v2\.0\.0\//.test(uri) ? '2.0' : undefined;
  if (!version)
    return { valid: false, schema: uri, errors: ['Postman collection schema version is required'] };
  const validator = postman[version];
  try {
    return {
      valid: Boolean(validator(input)),
      schema: uri,
      errors: (validator.errors ?? []).slice(0, 25).map((e) => `${e.instancePath}: ${e.message}`),
    };
  } catch {
    return { valid: false, schema: uri, errors: ['collection validation unavailable'] };
  }
}

export function validateJsonSchema(input: unknown): ContractValidation {
  const budget = contractBudget(input);
  if (budget) return { valid: false, schema: 'resource-boundary', errors: [budget] };
  const dialect = input && typeof input === 'object' ? (input as Json)['$schema'] : undefined;
  const validator = legacySchemaDialect(dialect)
    ? draft7
    : String(dialect).replace(/#$/, '') === 'https://json-schema.org/draft/2019-09/schema'
      ? draft2019
      : modern;
  if (
    dialect !== undefined &&
    ![
      ...legacySchemaUris,
      'https://json-schema.org/draft/2020-12/schema',
      'https://json-schema.org/draft/2019-09/schema',
      formatAssertionDialect,
    ].some((known) => known.replace(/#$/, '') === String(dialect).replace(/#$/, ''))
  )
    return { valid: false, schema: String(dialect), errors: ['unsupported JSON Schema dialect'] };
  try {
    if (
      dialect === formatAssertionDialect ||
      resourceDispatchRequired(
        input,
        [],
        String(dialect ?? 'https://json-schema.org/draft/2020-12/schema'),
      )
    ) {
      validateCompoundSchemaResources(
        input,
        [],
        dialect === undefined ? undefined : String(dialect),
      );
      return {
        valid: true,
        schema: String(dialect ?? 'https://json-schema.org/draft/2020-12/schema'),
        errors: [],
      };
    }
    const checked =
      validator === draft7 && typeof input === 'object' && input !== null
        ? { ...input, $schema: legacySchemaDialect(dialect)!.uri }
        : input;
    return {
      valid: Boolean(validator.validateSchema(checked as AnySchema)),
      schema: String(dialect ?? 'https://json-schema.org/draft/2020-12/schema'),
      errors: (validator.errors ?? []).slice(0, 25).map((e) => `${e.instancePath}: ${e.message}`),
    };
  } catch {
    return { valid: false, schema: String(dialect), errors: ['schema validation unavailable'] };
  }
}
