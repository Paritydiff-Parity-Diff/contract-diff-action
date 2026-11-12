import type { Namespace, Type } from 'protobufjs';
export interface ProtobufWireInspection {
  readonly fields: ReadonlyMap<number, { readonly value: unknown }>;
  readonly unknownFields: number;
  readonly mismatchedFields: number;
}
export function validateProtobufWire(
  bytes: Uint8Array,
  type: Type,
  root: Namespace,
): ProtobufWireInspection;
