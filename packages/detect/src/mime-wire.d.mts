import type { MIMEType } from 'node:util';
export interface MimePart {
  readonly headers: ReadonlyMap<string, string>;
  readonly rawHeaders: readonly (readonly [string, string])[];
  readonly contentType: string;
  readonly bytes: Uint8Array;
}
export function parseMimeType(value: string): MIMEType;
export function matchesMimeType(pattern: string, actual: MIMEType): boolean;
export function decodeMimeParts(bytes: Uint8Array, contentType: string): readonly MimePart[];
