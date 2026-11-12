import type { Message, Type } from 'protobufjs';
export function createProtobufMessage(
  payload: object,
  type: Type,
): Message & Record<string, unknown>;
export function encodeProtobufMessage(message: object, type: Type): Uint8Array;
export function validProtobufMapKey(key: string, type: string): boolean;
