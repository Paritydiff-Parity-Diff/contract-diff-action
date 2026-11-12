export interface ProtobufContext {
  kind: 'protobuf';
  schema: string;
  descriptor: unknown;
  typeName: string;
  format: string;
  version: string;
  implementation: string;
  imports: { name: string; sha256: string }[];
  resourceHash: string;
}
export function protobufContext(
  schema: unknown,
  format: string,
  version: string,
  selection?: string,
  captured?: unknown,
): ProtobufContext;
export function validateAsyncapiProtobuf(
  context: ProtobufContext,
  input: unknown,
): { valid: true; payload: unknown; wireHash: string };
export function protobufContentType(value: unknown): boolean;
