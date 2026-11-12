import p from 'protobufjs';
import { createHash } from 'node:crypto';
import { validateProtobufWire } from './protobuf-wire.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
export const protobufContentType = (value) =>
  ['application/protobuf', 'application/x-protobuf', 'application/vnd.google.protobuf'].includes(
    value?.split(';')[0],
  );
export function protobufContext(schema, format, version, selection, captured = {}) {
  if (typeof schema !== 'string' || schema.length > 1024 * 1024)
    throw unavailable('asyncapi_protobuf_schema_unavailable');
  const root = new p.Root(),
    parsed = p.parse(schema, root, { keepCase: true });
  const rootTypes = new Set();
  const rootNames = (scope) => {
    for (const child of scope.nestedArray ?? []) {
      if (child instanceof p.Type) rootTypes.add(child.fullName);
      if (child.nestedArray) rootNames(child);
    }
  };
  rootNames(root);
  if (
    !captured ||
    typeof captured !== 'object' ||
    Array.isArray(captured) ||
    Object.keys(captured).length > 32
  )
    throw unavailable('asyncapi_protobuf_import_budget');
  const origin = 'https://protobuf.bundle.invalid/',
    rootUrl = origin + '__root__.proto',
    sources = new Map(),
    manifest = [];
  let total = Buffer.byteLength(schema);
  for (const [name, body] of Object.entries(captured)) {
    if (
      !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.proto$/.test(name) ||
      name.split('/').some((part) => ['.', '..'].includes(part)) ||
      name === '__root__.proto' ||
      Object.hasOwn(p.common, name)
    )
      throw unavailable('asyncapi_protobuf_import_path_invalid');
    if (typeof body !== 'string' || (total += Buffer.byteLength(body)) > 1024 * 1024)
      throw unavailable('asyncapi_protobuf_import_budget');
    sources.set(new URL(name, origin).href, body);
  }
  const queue = [{ parsed, url: rootUrl, depth: 0 }],
    seen = new Set([rootUrl]),
    common = new Set();
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index],
      imports = [...(entry.parsed.imports ?? []), ...(entry.parsed.weakImports ?? [])];
    if (imports.length > 128 || entry.depth > 16)
      throw unavailable('asyncapi_protobuf_import_budget');
    for (const name of imports) {
      if (Object.hasOwn(p.common, name)) {
        if (!common.has(name)) {
          root.addJSON(p.common[name].nested);
          common.add(name);
        }
        continue;
      }
      if (
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_./-]+\.proto$/.test(name) ||
        name.startsWith('/')
      )
        throw unavailable('asyncapi_protobuf_import_path_invalid');
      const url = new URL(name, entry.url);
      if (url.origin !== 'https://protobuf.bundle.invalid' || !sources.has(url.href))
        throw unavailable('asyncapi_protobuf_import_not_captured');
      if (seen.has(url.href)) continue;
      if (seen.size >= 33) throw unavailable('asyncapi_protobuf_import_budget');
      seen.add(url.href);
      const source = sources.get(url.href),
        dependency = p.parse(source, root, { keepCase: true });
      manifest.push({ name: url.pathname.slice(1), sha256: hash(source) });
      queue.push({ parsed: dependency, url: url.href, depth: entry.depth + 1 });
    }
  }
  root.resolveAll();
  const types = [],
    used = new Set();
  let nodes = 0;
  const visit = (scope, depth = 0) => {
    if (++nodes > 20000 || depth > 64) throw unavailable('asyncapi_protobuf_schema_budget');
    for (const child of scope.nestedArray ?? []) {
      if (child instanceof p.Type) {
        types.push(child);
        if (child.fieldsArray.length > 256) throw unavailable('asyncapi_protobuf_schema_budget');
      }
      if (child.nestedArray) visit(child, depth + 1);
    }
  };
  visit(root);
  const declared = types.filter((type) => rootTypes.has(type.fullName));
  if (declared.some((type) => type._edition !== 'proto' + version))
    throw unavailable('asyncapi_protobuf_version_mismatch');
  for (const type of declared)
    for (const field of type.fieldsArray)
      if (field.resolvedType instanceof p.Type && field.resolvedType !== type)
        used.add(field.resolvedType.fullName);
  const candidates = declared.filter((type) => !used.has(type.fullName));
  const selected = selection
    ? root.lookupType(selection)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!selected || !declared.includes(selected))
    throw unavailable('asyncapi_protobuf_message_ambiguous');
  return {
    kind: 'protobuf',
    schema,
    descriptor: root.toJSON(),
    typeName: selected.fullName,
    format,
    version,
    implementation: 'protobufjs@7.6.6;paritydiff-wire-v1',
    imports: manifest.sort((a, b) => a.name.localeCompare(b.name)),
    resourceHash: hash(
      JSON.stringify({ schema, format, typeName: selected.fullName, imports: manifest }),
    ),
  };
}
export function validateAsyncapiProtobuf(context, input) {
  if (!protobufContentType(input.transport.contentType))
    throw unavailable('asyncapi_protobuf_wire_codec_unavailable');
  const encoded = input.payloadBytesBase64 ?? input.bytesBase64;
  if (
    typeof encoded !== 'string' ||
    encoded.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw unavailable('asyncapi_protobuf_wire_unavailable');
  const wire = Buffer.from(encoded, 'base64'),
    root = p.Root.fromJSON(context.descriptor);
  if (wire.length > 1024 * 1024) throw unavailable('asyncapi_protobuf_wire_unavailable');
  root.resolveAll();
  const type = root.lookupType(context.typeName);
  try {
    const checked = validateProtobufWire(wire, type, root);
    if (checked.mismatchedFields) throw invalid('asyncapi_protobuf_field_wire_mismatch');
    if (checked.unknownFields) throw unavailable('asyncapi_protobuf_unknown_field_coverage');
    const decoded = type.decode(wire),
      error = type.verify(decoded);
    if (error) throw unavailable('asyncapi_protobuf_value_representation_unavailable');
    const payload = type.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: String,
      json: true,
      defaults: false,
    });
    const reconstructed = type.fromObject(payload);
    if (
      !Buffer.from(type.encode(decoded).finish()).equals(
        Buffer.from(type.encode(reconstructed).finish()),
      )
    )
      throw unavailable('asyncapi_protobuf_roundtrip_unavailable');
    return { valid: true, payload, wireHash: hash(wire) };
  } catch (error) {
    if (error.available !== undefined) throw error;
    if (['grpc_wire_resource_limit', 'grpc_any_type_unavailable'].includes(error.message))
      throw unavailable(error.message);
    throw invalid('asyncapi_protobuf_payload_invalid');
  }
}
