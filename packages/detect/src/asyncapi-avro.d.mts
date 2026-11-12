import type { Type } from 'avsc';
export interface AvroContext {
  kind: 'avro';
  schema: unknown;
  definitions?: readonly (readonly [string, unknown])[];
  format: string;
  implementation: string;
}
export function avroType(context: AvroContext): Type<unknown>;
export function createAvroContext(
  schema: unknown,
  source: Record<string, unknown>,
  format: string,
): AvroContext;
export function validateAvroPayload(
  context: AvroContext,
  input: { payloadBytesBase64?: string; bytesBase64?: string; transport: { contentType: string } },
): { valid: true; payload: unknown; wireHash: string; implementation: string };
export function avroBinaryContentType(value: string | undefined): boolean;
