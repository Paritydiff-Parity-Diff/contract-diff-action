import { parseDocument, isScalar, isMap, isSeq, isAlias, type Node } from 'yaml';
import { err, ok, parseLosslessJson, type Result, type ContractEncoding } from '@paritydiff/core';
import { assertWithinByteCap, DEFAULT_BYTE_CAP } from './limits';

export type SpecFormat = ContractEncoding;

export type ParseError =
  | { readonly kind: 'too_large'; readonly bytes: number; readonly limit: number }
  | { readonly kind: 'parse_failed'; readonly message: string };

function parseYaml(raw: string): unknown {
  const document = parseDocument(raw, { intAsBigInt: true });
  if (document.errors.length || document.warnings.length) throw new Error('invalid_yaml');
  const queue: { node: Node | null; depth: number }[] = [{ node: document.contents, depth: 0 }],
    maps = [];
  let count = 0;
  while (queue.length) {
    const { node, depth } = queue.pop()!;
    if (++count > 100000 || depth > 100) throw new Error('yaml_structure_limit');
    if (isScalar(node)) {
      if (typeof node.value === 'bigint') {
        const value = Number(node.value);
        if (!Number.isFinite(value) || BigInt(value) !== node.value)
          throw new Error('yaml_number_precision_unavailable');
        node.value = value;
      } else if (typeof node.value === 'number') {
        let source = node.source ?? '';
        if (source.length > 1000) throw new Error('yaml_number_precision_unavailable');
        source = source.replace(/_/g, '');
        if (node.format === 'TIME') {
          const negative = source.startsWith('-');
          const parts = source.replace(/^[+-]/, '').split(':');
          const final = parts.pop()!.split('.');
          if ([...parts, final[0]!].some((part) => !/^[0-9]+$/.test(part)))
            throw new Error('yaml_number_precision_unavailable');
          const whole = [...parts, final[0]!].reduce(
            (value, part) => value * 60n + BigInt(part),
            0n,
          );
          source =
            (negative ? '-' : '') + String(whole) + (final[1] !== undefined ? '.' + final[1] : '');
        } else {
          const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?([eE][+-]?[0-9]+)?$/.exec(source);
          if (!match || (!match[2] && !match[3]))
            throw new Error('yaml_number_precision_unavailable');
          source =
            (match[1] === '-' ? '-' : '') +
            (match[2]?.replace(/^0+(?=[0-9])/, '') || '0') +
            (match[3] !== undefined ? '.' + (match[3] || '0') : '') +
            (match[4] ?? '');
        }
        try {
          if (!Object.is(parseLosslessJson(source), node.value)) throw new Error('precision');
        } catch {
          throw new Error('yaml_number_precision_unavailable');
        }
      } else if (
        node.value !== null &&
        !['string', 'boolean'].includes(typeof node.value) &&
        !(typeof node.value === 'symbol' && node.value.description === '<<' && 'addToJSMap' in node)
      ) {
        throw new Error('yaml_scalar_type_unavailable');
      }
    } else if (isMap(node)) {
      maps.push(node);
      for (const pair of node.items)
        queue.push(
          { node: pair.key as Node | null, depth: depth + 1 },
          { node: pair.value as Node | null, depth: depth + 1 },
        );
    } else if (isSeq(node))
      for (const child of node.items) queue.push({ node: child as Node | null, depth: depth + 1 });
  }
  for (const map of maps) {
    const keys = new Set<string>();
    for (const pair of map.items) {
      const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
      if (!isScalar(key)) throw new Error('yaml_object_key_unavailable');
      if (typeof key.value === 'symbol' && key.value.description === '<<' && 'addToJSMap' in key)
        continue;
      const name = key.value === null ? '' : String(key.value);
      if (keys.has(name)) throw new Error('yaml_object_key_collision');
      keys.add(name);
    }
  }
  return document.toJS({ maxAliasCount: 100 });
}

// maxAliasCount bounds YAML anchor/alias expansion, defeating billion-laughs
// (spec section 4 row 2). The byte cap runs before parsing.
export function parseSpec(
  raw: string,
  format: SpecFormat,
  byteCap = DEFAULT_BYTE_CAP,
): Result<unknown, ParseError> {
  const bytes = Buffer.byteLength(raw, 'utf8');
  const cap = assertWithinByteCap(bytes, byteCap);
  if (!cap.ok) return err({ kind: 'too_large', bytes, limit: cap.error.limit });
  try {
    const doc =
      format === 'yaml'
        ? parseYaml(raw)
        : format === 'json'
          ? parseLosslessJson(raw)
          : format === 'graphql'
            ? { sdl: raw }
            : format === 'protobuf'
              ? { proto: raw }
              : format === 'xml'
                ? { xml: raw }
                : { 'x-paritydiff-upload-kind': 'document', format, content: raw };
    return ok(doc);
  } catch (cause) {
    return err({
      kind: 'parse_failed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
