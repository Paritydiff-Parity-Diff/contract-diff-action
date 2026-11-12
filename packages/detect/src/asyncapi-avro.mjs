import avro from 'avsc';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { logicalTypes, assertAvroLogicalBudget, AVRO_IMPLEMENTATION } from './avro-logical.mjs';
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const avroBinaryContentType = (value) =>
  ['avro/binary', 'application/avro', 'application/vnd.apache.avro+binary'].includes(
    value?.split(';')[0],
  );
function checkedSchema(schema) {
  const stack = [{ node: schema, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > 20000 || depth > 64) throw unavailable('asyncapi_avro_schema_budget');
    if (typeof node === 'string') {
      if (node.length > 1000) throw unavailable('asyncapi_avro_schema_budget');
      continue;
    }
    if (Array.isArray(node)) {
      if (node.length > 256) throw unavailable('asyncapi_avro_schema_budget');
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    assertAvroLogicalBudget(node);
    if (node.fields && (!Array.isArray(node.fields) || node.fields.length > 256))
      throw unavailable('asyncapi_avro_schema_budget');
    if (node.fields?.some((field) => field.name === '__proto__'))
      throw unavailable('asyncapi_avro_reserved_field_unavailable');
    for (const [name, value] of Object.entries(node))
      if (!['doc', 'default', 'aliases'].includes(name))
        stack.push({ node: value, depth: depth + 1 });
  }
  return schema;
}
export function avroType(context) {
  checkedSchema(context.schema);
  const registry = Object.create(null),
    definitions = new Map(context.definitions ?? []),
    resolving = new Set();
  return avro.Type.forSchema(context.schema, {
    registry,
    wrapUnions: 'always',
    noAnonymousTypes: true,
    logicalTypes,
    typeHook: (schema, options) => {
      if (typeof schema !== 'string' || registry[schema] !== undefined || !definitions.has(schema))
        return;
      if (resolving.has(schema)) throw unavailable('asyncapi_avro_named_reference_cycle');
      resolving.add(schema);
      try {
        return avro.Type.forSchema(checkedSchema(definitions.get(schema)), options);
      } finally {
        resolving.delete(schema);
      }
    },
  });
}
export function createAvroContext(schema, source, format) {
  const definitions = [],
    names = new Set();
  for (const value of Object.values(source.components?.schemas ?? {})) {
    if (!value || typeof value !== 'object' || value.schemaFormat !== format || !value.schema?.name)
      continue;
    const definition = value.schema,
      name = definition.name.includes('.')
        ? definition.name
        : (definition.namespace ? definition.namespace + '.' : '') + definition.name;
    if (names.has(name)) throw unavailable('asyncapi_avro_name_ambiguous');
    names.add(name);
    definitions.push([name, definition]);
  }
  const context = {
    kind: 'avro',
    schema,
    definitions,
    format,
    implementation: AVRO_IMPLEMENTATION,
  };
  avroType(context);
  return context;
}
export function validateAvroPayload(context, input) {
  const binary = avroBinaryContentType(input.transport.contentType),
    json = /^application\/(?:[^;]+\+)?json(?:;|$)/i.test(input.transport.contentType ?? '');
  if (!binary && !json) throw unavailable('asyncapi_avro_wire_codec_unavailable');
  const encoded = input.payloadBytesBase64 ?? input.bytesBase64;
  if (
    typeof encoded !== 'string' ||
    encoded.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw unavailable('asyncapi_avro_wire_unavailable');
  const wire = Buffer.from(encoded, 'base64');
  if (wire.length > 1024 * 1024) throw unavailable('asyncapi_avro_wire_unavailable');
  try {
    const type = avroType(context),
      original = json
        ? parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(wire))
        : undefined,
      value = json ? type.fromString(JSON.stringify(original)) : type.fromBuffer(wire);
    const stack = [value];
    let count = 0;
    while (stack.length) {
      const item = stack.pop();
      if (++count > 20000) throw unavailable('asyncapi_avro_value_budget');
      if (typeof item === 'number' && !Number.isFinite(item))
        throw unavailable('asyncapi_avro_nonfinite_representation_unavailable');
      if (item && typeof item === 'object' && !Buffer.isBuffer(item))
        stack.push(...Object.values(item));
    }
    if (!type.isValid(value, { noUndeclaredFields: true }))
      throw invalid('asyncapi_avro_payload_invalid');
    const nativeBytes = type.toBuffer(value),
      payload = parseLosslessJson(type.toString(type.fromBuffer(nativeBytes)));
    if (json ? !isDeepStrictEqual(original, payload) : !nativeBytes.equals(wire))
      throw unavailable('asyncapi_avro_roundtrip_unavailable');
    return { valid: true, payload, wireHash: hash(wire), implementation: AVRO_IMPLEMENTATION };
  } catch (error) {
    if (error.available !== undefined) throw error;
    if (/precision|safe integer|potential precision loss/i.test(error.message))
      throw unavailable('asyncapi_avro_number_precision_unavailable');
    throw invalid('asyncapi_avro_payload_invalid');
  }
}
