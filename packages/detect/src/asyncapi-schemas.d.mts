interface JsonSchemaContext {
  kind?: 'asyncapi' | 'jsonschema' | 'openapi30' | 'asyncapi-polymorphic';
  schema: unknown;
  resources: unknown[];
  dialect: string;
  implementation?: string;
  format?: string | undefined;
}
interface AvroSchemaContext {
  kind: 'avro';
  schema: unknown;
  definitions: [string, unknown][];
  format: string;
  implementation: string;
}
interface ProtobufSchemaContext {
  kind: 'protobuf';
  schema: string;
  descriptor: unknown;
  typeName: string;
  format: string;
  version: string;
  implementation: string;
  resourceHash: string;
}
interface RamlSchemaContext {
  kind: 'raml';
  schema: unknown;
  format: string;
  source: string;
  documents: Record<string, string>;
  implementation: string;
  resourceHash: string;
}
export function asyncapiSchemaFormat(
  raw: unknown,
  format: string | undefined,
  version: string,
): {
  schema: unknown;
  kind: 'asyncapi' | 'jsonschema' | 'openapi30' | 'avro' | 'protobuf' | 'raml';
  dialect?: string;
  format?: string;
};
export function createAsyncapiSchemas(source: unknown): {
  base: string;
  compileContext(
    raw: unknown,
    format?: string,
  ): JsonSchemaContext | AvroSchemaContext | ProtobufSchemaContext | RamlSchemaContext;
  protocolObject(pointer: string): { node: unknown; pointer: string; pointers: string[] };
};
export function asyncapiParserInput(source: unknown): unknown;
