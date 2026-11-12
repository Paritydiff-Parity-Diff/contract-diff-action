import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { parseMimeType } from './mime-wire.mjs';
import { stringify } from 'yaml';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const validators = new WeakMap();
function ordered(value, state = { nodes: 0 }, depth = 0) {
  if (++state.nodes > 20000 || depth > 128) throw unavailable('asyncapi_raml_schema_budget');
  if (Array.isArray(value)) return value.map((child) => ordered(child, state, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key], state, depth + 1)]),
    );
  return value;
}
export function createRamlContext(schema, format, documents = {}) {
  const type = parseMimeType(format);
  if (type.essence !== 'application/raml+yaml' || type.params.get('version') !== '1.0')
    throw unavailable('asyncapi_raml_version_unavailable');
  if (
    (typeof schema !== 'string' &&
      (!schema || typeof schema !== 'object' || Array.isArray(schema))) ||
    !documents ||
    typeof documents !== 'object' ||
    Array.isArray(documents) ||
    Object.keys(documents).length > 32
  )
    throw unavailable('asyncapi_raml_schema_unavailable');
  schema = ordered(schema);
  const body = typeof schema === 'string' ? schema : stringify(schema, { lineWidth: 0 });
  let size = Buffer.byteLength(body);
  if (
    size > 1024 * 1024 ||
    (/^#%RAML\b/.test(body) && !/^#%RAML 1\.0 DataType(?:\r?\n|$)/.test(body))
  )
    throw unavailable('asyncapi_raml_schema_unavailable');
  const sources = Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of sources) {
    if (
      !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:raml|yaml|json)$/.test(name) ||
      name.split('/').some((part) => ['.', '..'].includes(part)) ||
      ['__root__.raml', '__carrier__.raml'].includes(name) ||
      typeof value !== 'string' ||
      (size += Buffer.byteLength(value)) > 1024 * 1024
    )
      throw unavailable('asyncapi_raml_import_bundle_invalid');
  }
  return {
    kind: 'raml',
    schema,
    format,
    documents: Object.fromEntries(sources),
    implementation: 'amf-client-js@5.15.0;paritydiff-offline-v1',
    resourceHash: hash(JSON.stringify({ schema, format, sources })),
    source: /^#%RAML /.test(body) ? body : '#%RAML 1.0 DataType\n' + body,
  };
}
export async function compileRamlContext(context) {
  if (validators.has(context)) return validators.get(context);
  const promise = (async () => {
    const checked = createRamlContext(context.schema, context.format, context.documents);
    if (checked.resourceHash !== context.resourceHash || checked.source !== context.source)
      throw unavailable('asyncapi_raml_resource_identity_mismatch');
    const module = await import('amf-client-js'),
      amf = module.default ?? module,
      root = 'https://raml.bundle.invalid/__root__.raml',
      sources = new Map([
        [root, checked.source],
        [
          'https://raml.bundle.invalid/__carrier__.raml',
          '#%RAML 1.0\ntitle: Native datatype carrier\n/events:\n  post:\n    body:\n      application/json: !include __root__.raml\n',
        ],
        ...Object.entries(checked.documents).map(([name, source]) => [
          new URL(name, root).href,
          source,
        ]),
      ]);
    let denied = false,
      reads = 0;
    const loader = amf.ResourceLoaderFactory.create({
      accepts: () => true,
      fetch: async (url) => {
        if (++reads > 128 || !sources.has(url)) {
          denied = true;
          throw unavailable('asyncapi_raml_import_not_captured');
        }
        return new amf.Content(sources.get(url), url, 'application/yaml');
      },
    });
    const configuration = amf.RAMLConfiguration.RAML10().withResourceLoaders([loader]),
      client = configuration.baseUnitClient();
    let parsed;
    try {
      parsed = await client.parse('https://raml.bundle.invalid/__carrier__.raml');
    } catch {
      throw unavailable(
        denied ? 'asyncapi_raml_import_not_captured' : 'asyncapi_raml_schema_invalid',
      );
    }
    if (denied) throw unavailable('asyncapi_raml_import_not_captured');
    if (!parsed.conforms || parsed.results.length || !parsed.baseUnit.encodes)
      throw unavailable('asyncapi_raml_schema_invalid');
    const report = await client.validate(parsed.baseUnit);
    if (!report.conforms || report.results.length)
      throw unavailable('asyncapi_raml_schema_invalid');
    const transformed = client.transform(parsed.baseUnit);
    if (!transformed.conforms || transformed.results.length || !transformed.baseUnit.encodes)
      throw unavailable('asyncapi_raml_resolution_unavailable');
    if (denied) throw unavailable('asyncapi_raml_import_not_captured');
    const shape =
      transformed.baseUnit.encodes.endPoints?.[0]?.operations?.[0]?.request?.payloads?.[0]?.schema;
    if (!shape) throw unavailable('asyncapi_raml_resolution_unavailable');
    const validator = configuration
      .elementClient()
      .payloadValidatorFor(shape, 'application/json', amf.ValidationMode.StrictValidationMode);
    if (!validator || typeof validator.validate !== 'function')
      throw unavailable('asyncapi_raml_validator_unavailable');
    return validator;
  })();
  validators.set(context, promise);
  return promise;
}
export async function validateRamlPayload(context, input) {
  const type = parseMimeType(input.transport.contentType);
  if (
    !/^application\/(?:[^/]+\+)?json$/.test(type.essence) ||
    (type.params.has('charset') && type.params.get('charset').toLowerCase() !== 'utf-8')
  )
    throw unavailable('asyncapi_raml_wire_codec_unavailable');
  const encoded = input.payloadBytesBase64 ?? input.bytesBase64;
  let bytes, payload;
  try {
    if (encoded !== undefined) {
      if (
        typeof encoded !== 'string' ||
        encoded.length > 1398104 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        throw unavailable('asyncapi_raml_wire_unavailable');
      bytes = Buffer.from(encoded, 'base64');
    } else {
      const text = JSON.stringify(input.payload);
      if (text === undefined) throw unavailable('asyncapi_raml_wire_unavailable');
      bytes = Buffer.from(text);
    }
    if (bytes.length > 1024 * 1024) throw unavailable('asyncapi_raml_wire_unavailable');
    payload = parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error.available !== undefined) throw error;
    throw error.message.endsWith('_unavailable')
      ? unavailable(error.message)
      : invalid('asyncapi_raml_json_invalid');
  }
  const validator = await compileRamlContext(context),
    report = await validator.validate(JSON.stringify(payload));
  if (!report.conforms) throw invalid('asyncapi_raml_payload_invalid');
  if (report.results.length) throw unavailable('asyncapi_raml_validation_incomplete');
  return { valid: true, payload, wireHash: hash(bytes) };
}
export async function prepareRamlContexts(models, issues) {
  for (const model of models)
    for (const message of [...model.messages, ...(model.reply?.messages ?? [])])
      for (const context of [message.payload, message.headers]) {
        if (!context?.available || context.kind !== 'raml') continue;
        try {
          await compileRamlContext(context);
        } catch (error) {
          context.available = false;
          context.reason = /^asyncapi_raml_[a-z_]+$/.test(error.message)
            ? error.message
            : 'asyncapi_raml_schema_unavailable';
          issues.add('AsyncAPI schema validation unavailable: ' + context.reason);
        }
      }
}
