import { compiler } from './semantic-compare.mjs';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const protocolHeaders = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'cookie2',
  'expect',
  'forwarded',
  'host',
  'origin',
  'pragma',
  'proxy-authorization',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'date',
  'server',
  'keep-alive',
  'vary',
  'etag',
  'last-modified',
  'expires',
  'retry-after',
  'location',
  'www-authenticate',
  'proxy-authenticate',
]);
export function httpApplicationHeaders(transport) {
  const headers = transport.headers ?? {},
    names = transport.headerNames ?? Object.keys(headers).map((name) => name.toLowerCase());
  const captured = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (names.some((name) => !protocolHeaders.has(name) && !captured.has(name)))
    throw unavailable('asyncapi_header_coverage_unavailable');
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !protocolHeaders.has(name.toLowerCase())),
  );
}
export function selectAsyncapiServers(model, transport, matchChannel) {
  const http = ['http', 'https'].includes(transport.protocol),
    matches = [];
  let unknown;
  if (!model.servers.length) {
    matchChannel(model, transport.channel, http);
    return matches;
  }
  for (const server of model.servers) {
    if (server.protocol !== transport.protocol) continue;
    try {
      if (server.version && transport.protocolVersion === undefined)
        throw unavailable('asyncapi_protocol_version_unavailable');
      if (
        server.version &&
        String(server.version).replace(/^2\.0$/, '2') !==
          String(transport.protocolVersion).replace(/^2\.0$/, '2')
      )
        continue;
      if (http && typeof transport.origin === 'string') {
        const parameters = {};
        const replace = (template, models, prefix) => {
          if (typeof template !== 'string') throw unavailable('asyncapi_channel_unavailable');
          const used = new Set();
          const result = template.replace(/\{([A-Za-z0-9_-]+)\}/g, (_match, name) => {
            if (!Object.hasOwn(models, name))
              throw unavailable('asyncapi_server_variables_unavailable');
            used.add(name);
            const key = prefix + Object.keys(models).indexOf(name);
            parameters[key] = models[name];
            return '{' + key + '}';
          });
          if (Object.keys(models).some((name) => !used.has(name)))
            throw unavailable('asyncapi_channel_parameters_unavailable');
          return result;
        };
        const template =
          replace(server.url, server.parameters ?? {}, 'S').replace(/\/$/, '') +
          '/' +
          replace(model.address, model.parameters, 'C').replace(/^\//, '');
        matchChannel({ address: template, parameters }, transport.origin + transport.channel, true);
      } else {
        if (typeof transport.server !== 'string')
          throw unavailable('asyncapi_server_evidence_unavailable');
        matchChannel(
          { address: server.url, parameters: server.parameters ?? {} },
          transport.server,
        );
        matchChannel(model, transport.channel);
      }
      matches.push(server);
    } catch (error) {
      if (error.available !== true) unknown = error;
    }
  }
  if (unknown) throw unknown;
  if (!matches.length) throw invalid('asyncapi_server_or_channel_mismatch');
  return matches;
}
function wireFields(context, fields, query = false) {
  if (!context?.available) throw unavailable('asyncapi_http_schema_unavailable');
  const resources = new Map(context.resources.map((resource) => [resource.$id, resource]));
  const schema = (node, seen = new Set()) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    if (typeof node.$ref !== 'string') return node;
    if (
      seen.has(node.$ref) ||
      seen.size >= 64 ||
      Object.keys(node).some(
        (key) =>
          !['$id', '$schema', '$ref', 'definitions', '$defs', 'title', 'description'].includes(key),
      )
    )
      throw unavailable('asyncapi_http_type_context_unavailable');
    const target = resources.get(node.$ref);
    if (target === undefined) throw unavailable('asyncapi_http_type_context_unavailable');
    return schema(target, new Set([...seen, node.$ref]));
  };
  const root = schema(context.schema);
  if (root?.type !== 'object' || !root.properties || root.patternProperties)
    throw unavailable('asyncapi_http_type_context_unavailable');
  const value = (input, raw) => {
    const node = schema(raw);
    if (node === false) throw invalid('asyncapi_http_field_invalid');
    if (node === true || node?.type === undefined) return input;
    if (node.type === 'array') {
      if (!query && !Array.isArray(input))
        throw unavailable('asyncapi_http_array_codec_unavailable');
      if (!node.items || Array.isArray(node.items) || node.prefixItems)
        throw unavailable('asyncapi_http_array_codec_unavailable');
      return (Array.isArray(input) ? input : [input]).map((item) => value(item, node.items));
    }
    if (Array.isArray(input)) throw invalid('asyncapi_http_field_repeated');
    if (typeof input !== 'string' || Array.isArray(node.type))
      throw unavailable('asyncapi_http_type_context_unavailable');
    if (node.type === 'string') return input;
    if (node.type === 'boolean') {
      if (input === 'true') return true;
      if (input === 'false') return false;
      throw invalid('asyncapi_http_field_invalid');
    }
    if (node.type === 'null') {
      if (input === 'null') return null;
      throw invalid('asyncapi_http_field_invalid');
    }
    if (['number', 'integer'].includes(node.type)) {
      let parsed;
      try {
        parsed = parseLosslessJson(input);
      } catch (error) {
        if (error.message === 'json_number_precision_unavailable') throw unavailable(error.message);
        throw invalid('asyncapi_http_field_invalid');
      }
      if (
        typeof parsed !== 'number' ||
        !Number.isFinite(parsed) ||
        (node.type === 'integer' && !Number.isInteger(parsed))
      )
        throw invalid('asyncapi_http_field_invalid');
      return parsed;
    }
    throw unavailable('asyncapi_http_field_codec_unavailable');
  };
  const output = Object.fromEntries(
    Object.entries(fields).map(([name, item]) => [
      name,
      value(
        item,
        Object.hasOwn(root.properties, name)
          ? root.properties[name]
          : (root.additionalProperties ?? true),
      ),
    ]),
  );
  if (!compiler(context.schema, context.resources, context.dialect)(output))
    throw invalid('asyncapi_http_fields_invalid');
  return output;
}
function canonicalHeaders(context, fields) {
  if (!context?.available) throw unavailable('asyncapi_http_schema_unavailable');
  const resources = new Map(context.resources.map((resource) => [resource.$id, resource])),
    properties = new Map(),
    seen = new Set();
  let patterns = false,
    steps = 0;
  const collect = (schema, depth = 0) => {
    if (++steps > 4096 || depth > 64) throw unavailable('asyncapi_http_type_context_unavailable');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
    if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
      seen.add(schema.$ref);
      if (!resources.has(schema.$ref)) throw unavailable('asyncapi_http_type_context_unavailable');
      collect(resources.get(schema.$ref), depth + 1);
    }
    for (const name of Object.keys(schema.properties ?? {})) {
      const lower = name.toLowerCase();
      if (properties.has(lower) && properties.get(lower) !== name)
        throw unavailable('asyncapi_http_header_case_ambiguous');
      properties.set(lower, name);
    }
    if (Object.keys(schema.patternProperties ?? {}).length || schema.propertyNames) patterns = true;
    for (const key of ['allOf', 'anyOf', 'oneOf'])
      for (const child of schema[key] ?? []) collect(child, depth + 1);
    for (const key of ['not', 'if', 'then', 'else'])
      if (schema[key] !== undefined) collect(schema[key], depth + 1);
    for (const key of ['dependencies', 'dependentSchemas'])
      for (const child of Object.values(schema[key] ?? {}))
        if (!Array.isArray(child)) collect(child, depth + 1);
  };
  collect(context.schema);
  const output = new Map();
  for (const [name, value] of Object.entries(fields)) {
    const lower = name.toLowerCase(),
      canonical = properties.get(lower) ?? lower;
    if (!properties.has(lower) && patterns)
      throw unavailable('asyncapi_http_header_name_context_unavailable');
    if (output.has(canonical)) throw invalid('asyncapi_http_header_repeated');
    output.set(canonical, value);
  }
  return Object.fromEntries(output);
}
export function validateHttpApplicationHeaders(context, fields) {
  const canonical = canonicalHeaders(context, fields);
  if (compiler(context.schema, context.resources, context.dialect)(canonical)) return canonical;
  return wireFields(context, canonical);
}
export function validateHttpBindings(model, message, servers, transport) {
  const op = model.bindings.http ?? {},
    binding = message.bindings.http ?? {};
  const version = op.bindingVersion ?? '0.3.0',
    messageVersion = binding.bindingVersion ?? '0.3.0';
  if (
    !['0.1.0', '0.2.0', '0.3.0'].includes(version) ||
    !['0.1.0', '0.2.0', '0.3.0'].includes(messageVersion)
  )
    throw unavailable('asyncapi_http_binding_version_unavailable');
  const fields = new Set(
    version === '0.3.0'
      ? ['method', 'query', 'bindingVersion']
      : ['type', 'method', 'query', 'bindingVersion'],
  );
  if (
    Object.keys(op).some((key) => !fields.has(key)) ||
    Object.keys(binding).some(
      (key) => !['headers', 'statusCode', 'bindingVersion'].includes(key),
    ) ||
    Object.keys(model.channelBindings.http ?? {}).length ||
    servers.some((server) => Object.keys(server.bindings.http ?? {}).length)
  )
    throw unavailable('asyncapi_http_binding_unavailable');
  if (op.type && op.type !== (transport.kind ?? 'request'))
    throw invalid('asyncapi_http_message_type_mismatch');
  if (op.method && op.method !== transport.method) throw invalid('asyncapi_http_method_mismatch');
  if (op.query) {
    if (
      typeof transport.search !== 'string' ||
      transport.search.length > 16384 ||
      /^[^?]/.test(transport.search)
    )
      throw unavailable('asyncapi_http_query_unavailable');
    const values = new Map();
    for (const pair of transport.search.slice(1) ? transport.search.slice(1).split('&') : []) {
      const index = pair.indexOf('='),
        rawName = index < 0 ? pair : pair.slice(0, index),
        rawValue = index < 0 ? '' : pair.slice(index + 1);
      let name, value;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
        value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch {
        throw invalid('asyncapi_http_query_encoding_invalid');
      }
      values.set(name, values.has(name) ? [].concat(values.get(name), value) : value);
    }
    wireFields(model.httpQuery, Object.fromEntries(values), true);
  }
  if (binding.headers) {
    const headers = transport.headers ?? {},
      names = transport.headerNames ?? Object.keys(headers).map((name) => name.toLowerCase());
    if (names.some((name) => !Object.keys(headers).some((key) => key.toLowerCase() === name)))
      throw unavailable('asyncapi_http_header_coverage_unavailable');
    validateHttpApplicationHeaders(message.httpHeaders, headers);
  }
  if (
    (transport.kind ?? 'request') === 'response' &&
    binding.statusCode !== undefined &&
    binding.statusCode !== transport.status
  )
    throw invalid('asyncapi_http_status_mismatch');
}
