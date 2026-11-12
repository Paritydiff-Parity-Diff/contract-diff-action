import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createOfflineOcr, imageDimensions } from './ocr.mjs';
import { scalarContracts } from './graphql-scalars.mjs';

const issues = new Set();
const schemas = Object.create(null);
const paths = Object.create(null);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pointer = (value) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const envelope = (sourceFormat, title, native) => ({
  sourceFormat,
  document: {
    openapi: '3.1.2',
    info: { title, version: 'contract' },
    paths,
    components: { schemas },
    'x-paritydiff-source-format': sourceFormat,
    'x-paritydiff-native-contract': native,
    ...(issues.size ? { 'x-paritydiff-coverage-issues': [...issues].sort() } : {}),
  },
});
function operation(path, input, output, metadata) {
  if (Object.hasOwn(paths, path)) throw new Error('duplicate protocol operation');
  paths[path] = {
    post: {
      'x-paritydiff-protocol-operation': metadata,
      ...(input === undefined
        ? {}
        : { requestBody: { content: { 'application/json': { schema: input } } } }),
      responses: {
        200: {
          description: 'Declared protocol result',
          ...(output === undefined ? {} : { content: { 'application/json': { schema: output } } }),
        },
      },
    },
  };
}
function checkTree(input, allowResourceReferences = false) {
  const stack = [{ value: input, depth: 0, literal: false }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth, literal } = stack.pop();
    if (++nodes > 200000 || depth > 128) throw new Error('parser resource limit');
    if (value && typeof value === 'object') {
      if (
        !allowResourceReferences &&
        !literal &&
        typeof value.$ref === 'string' &&
        !value.$ref.startsWith('#')
      )
        throw new Error('parser-owned external references are disabled');
      for (const [key, child] of Object.entries(value))
        stack.push({
          value: child,
          depth: depth + 1,
          literal: literal || ['const', 'enum', 'default', 'examples', 'example'].includes(key),
        });
    }
  }
}
async function graphql(input) {
  const g = await import('graphql');
  const introspection = input?.data?.__schema ? input.data : input?.__schema ? input : undefined;
  const schema = introspection
    ? g.buildClientSchema(introspection)
    : g.buildSchema(
        [String(input.sdl), ...Object.values(input['x-paritydiff-native-documents'] ?? {})].join(
          '\n',
        ),
        { assumeValid: false },
      );
  const errors = g.validateSchema(schema);
  if (errors.length) throw new Error('invalid GraphQL schema: ' + errors[0].message);
  const scalarProfiles = scalarContracts(input.scalarContracts, schema, g);
  const convert = (type, inputType = false) => {
    if (g.isNonNullType(type)) return nonNull(type.ofType, inputType);
    return { anyOf: [nonNull(type, inputType), { type: 'null' }] };
  };
  const nonNull = (type, inputType) => {
    if (g.isListType(type)) return { type: 'array', items: convert(type.ofType, inputType) };
    if (g.isScalarType(type)) {
      const builtin = {
        String: { type: 'string' },
        ID: { type: 'string' },
        Int: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
        Float: { type: 'number' },
        Boolean: { type: 'boolean' },
      }[type.name];
      if (builtin) return builtin;
      const contract = scalarProfiles[type.name]?.[inputType ? 'input' : 'output'];
      if (contract !== undefined) {
        if (/"\$(?:ref|dynamicRef|recursiveRef|id)"\s*:/.test(JSON.stringify(contract)))
          issues.add('GraphQL scalar resource scope requires native validation');
        return {
          ...(typeof contract === 'boolean' ? { allOf: [contract] } : contract),
        };
      }
      issues.add('custom GraphQL scalar validation requires its runtime implementation');
      return { 'x-paritydiff-graphql-scalar': type.name };
    }
    return { $ref: '#/components/schemas/' + pointer(type.name) };
  };
  for (const type of Object.values(schema.getTypeMap()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (type.name.startsWith('__') || g.isScalarType(type)) continue;
    if (g.isEnumType(type))
      schemas[type.name] = {
        type: 'string',
        enum: type
          .getValues()
          .map((v) => v.name)
          .sort(),
      };
    else if (g.isObjectType(type) || g.isInputObjectType(type) || g.isInterfaceType(type)) {
      const fields = Object.values(type.getFields()).sort((a, b) => a.name.localeCompare(b.name));
      const isInput = g.isInputObjectType(type);
      schemas[type.name] = {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((f) => [
            f.name,
            {
              ...convert(f.type, isInput),
              ...(f.description ? { description: f.description } : {}),
            },
          ]),
        ),
        required: fields
          .filter((f) => !isInput || (g.isNonNullType(f.type) && f.defaultValue === undefined))
          .map((f) => f.name),
        ...(isInput ? { additionalProperties: false } : {}),
      };
      if (g.isInterfaceType(type))
        issues.add('GraphQL interface implementation changes require native selection analysis');
    } else if (g.isUnionType(type)) {
      schemas[type.name] = {
        anyOf: type.getTypes().map((t) => ({ $ref: '#/components/schemas/' + pointer(t.name) })),
      };
    }
  }
  for (const [kind, root] of [
    ['query', schema.getQueryType()],
    ['mutation', schema.getMutationType()],
    ['subscription', schema.getSubscriptionType()],
  ]) {
    if (!root) continue;
    for (const field of Object.values(root.getFields())) {
      const args = {
        type: 'object',
        properties: Object.fromEntries(field.args.map((a) => [a.name, convert(a.type, true)])),
        required: field.args
          .filter((a) => g.isNonNullType(a.type) && a.defaultValue === undefined)
          .map((a) => a.name),
        additionalProperties: false,
      };
      operation('/graphql/' + kind + '/' + field.name, args, convert(field.type), {
        protocol: 'graphql',
        kind,
        field: field.name,
      });
    }
  }
  issues.add(
    'GraphQL selection sets, error behavior and transport binding require repository/runtime evidence',
  );
  const native = introspection
    ? introspection
    : g.parse(
        [String(input.sdl), ...Object.values(input['x-paritydiff-native-documents'] ?? {})].join(
          '\n',
        ),
        { noLocation: true },
      );
  const result = envelope('graphql', 'GraphQL contract', native);
  result.document['x-paritydiff-graphql-scalar-contracts'] = scalarProfiles;
  return result;
}
async function asyncapi(input) {
  checkTree(input);
  const source = structuredClone(input);
  const { Parser } = await import('@asyncapi/parser');
  const parser = new Parser();
  const result = await parser.parse(
    (await import('./asyncapi-schemas.mjs')).asyncapiParserInput(input),
    { parseSchemas: false },
  );
  const errors = result.diagnostics.filter((d) => d.severity === 0);
  if (!result.document || errors.length)
    throw new Error(
      'invalid AsyncAPI: ' + String(errors[0]?.message ?? 'validation unavailable').slice(0, 250),
    );
  const models = (await import('./asyncapi-binding.mjs')).extractAsyncapiBindings(
    source,
    result.document,
    issues,
  );
  await (await import('./asyncapi-raml.mjs')).prepareRamlContexts(models, issues);
  for (const model of models) {
    const payload = (await import('./asyncapi-binding.mjs')).asyncapiPayloadProjection(
      model,
      issues,
    );
    operation(
      model.path,
      model.direction === 'input' ? payload : undefined,
      model.direction === 'output'
        ? payload
        : model.reply?.available
          ? (await import('./asyncapi-binding.mjs')).asyncapiPayloadProjection(model.reply, issues)
          : undefined,
      {
        protocol: 'asyncapi',
        action: model.direction === 'input' ? 'send' : 'receive',
        address: model.address,
      },
    );
  }
  issues.add(
    'AsyncAPI broker bindings, headers, traits and runtime delivery semantics need native repository validation',
  );
  const value = envelope('asyncapi', result.document.info().title(), source);
  value.document['x-paritydiff-asyncapi-bindings'] = models;
  return value;
}
async function xml(input) {
  const source = String(input.xml);
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('XML DTD and entities are disabled');
  const { DOMParser, XMLSerializer } = await import('./xml11.mjs');
  const doc = new DOMParser({
    onError() {
      throw new Error('invalid XML');
    },
  }).parseFromString(source, 'application/xml');
  const root = doc.documentElement;
  const xsd =
    root?.localName === 'schema' && root.namespaceURI === 'http://www.w3.org/2001/XMLSchema';
  const wsdl =
    (root?.localName === 'definitions' &&
      root.namespaceURI === 'http://schemas.xmlsoap.org/wsdl/') ||
    (root?.localName === 'description' && root.namespaceURI === 'http://www.w3.org/ns/wsdl');
  if (!xsd && !wsdl) throw new Error('XML is not a WSDL or XSD contract');
  let nodes = 0;
  const tree = (node, depth = 0) => {
    if (++nodes > 100000 || depth > 100) throw new Error('XML resource limit');
    if (node.nodeType !== 1)
      return node.nodeType === 3 && node.nodeValue?.trim() ? node.nodeValue.trim() : undefined;
    const attributes = Object.fromEntries(
      Array.from(node.attributes)
        .map((a) => [a.name, a.value])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    if (
      ['import', 'include', 'redefine', 'override'].includes(node.localName) &&
      !input['x-paritydiff-native-manifest']
    )
      issues.add('XML external imports require an approved schema resolver');
    return {
      name: '{' + node.namespaceURI + '}' + node.localName,
      attributes,
      children: Array.from(node.childNodes)
        .map((child) => tree(child, depth + 1))
        .filter((child) => child !== undefined),
    };
  };
  const imported = [];
  for (const source of Object.values(input['x-paritydiff-native-documents'] ?? {})) {
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source))
      throw new Error('XML DTD and entities are disabled');
    const dependency = new DOMParser({
      onError() {
        throw new Error('invalid imported XML');
      },
    }).parseFromString(String(source), 'application/xml');
    const importedRoot = dependency.documentElement;
    if (
      ![
        'http://www.w3.org/2001/XMLSchema',
        'http://schemas.xmlsoap.org/wsdl/',
        'http://www.w3.org/ns/wsdl',
      ].includes(importedRoot?.namespaceURI)
    )
      throw new Error('unsupported imported XML namespace');
    imported.push(tree(importedRoot));
  }
  const native = imported.length ? { root: tree(root), documents: imported } : tree(root);
  const nativeXml = Object.fromEntries(
    [
      [input['x-paritydiff-native-root'] ?? 'root', String(input.xml)],
      ...Object.entries(input['x-paritydiff-native-documents'] ?? {}),
    ].map(([id, source]) => {
      const parsed = new DOMParser({
        onError() {
          throw new Error('invalid XML schema bundle');
        },
      }).parseFromString(source, 'application/xml');
      for (const node of Array.from(
        parsed.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'include'),
      ).concat(
        Array.from(parsed.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'import')),
        Array.from(parsed.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'redefine')),
        Array.from(parsed.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'override')),
      )) {
        const location = node.getAttribute('schemaLocation');
        if (!location) continue;
        const edge = input['x-paritydiff-native-edges']?.find(
          (edge) => edge.from === id && edge.import === location,
        );
        if (edge)
          node.setAttribute(
            'schemaLocation',
            edge.to === input['x-paritydiff-native-root'] ? 'root.xsd' : edge.to + '.xsd',
          );
      }
      return [id, new XMLSerializer().serializeToString(parsed)];
    }),
  );
  if (wsdl && root.namespaceURI === 'http://schemas.xmlsoap.org/wsdl/') {
    const ns = root.namespaceURI;
    const operations = Array.from(doc.getElementsByTagNameNS(ns, 'operation'));
    for (const name of new Set(operations.map((op) => op.getAttribute('name')).filter(Boolean)))
      operation('/soap/' + encodeURIComponent(name), {}, {}, { protocol: 'soap', name });
  } else if (!wsdl) operation('/xsd/contract', {}, {}, { protocol: 'xml-schema' });
  issues.add(
    'XML Schema and SOAP serialization are preserved as native evidence; full XSD runtime validation is required',
  );
  const value = envelope(
    wsdl ? 'wsdl' : 'xsd',
    wsdl ? 'WSDL contract' : 'XML Schema contract',
    native,
  );
  const dialect =
    input.xsdVersion ??
    (root.getAttributeNS('http://www.w3.org/2007/XMLSchema-versioning', 'minVersion') === '1.1'
      ? '1.1'
      : '1.0');
  if (!['1.0', '1.1'].includes(dialect)) throw new Error('invalid declared XSD dialect');
  value.document['x-paritydiff-native-xml-source'] = nativeXml;
  value.document['x-paritydiff-xsd-dialect'] = dialect;
  value.document['x-paritydiff-native-root'] = input['x-paritydiff-native-root'] ?? 'root';
  if (wsdl) {
    const soap = (await import('./soap-binding.mjs')).extractSoapBindings(nativeXml);
    value.document['x-paritydiff-soap-bindings'] = soap.bindings;
    value.document['x-paritydiff-wsdl-http-bindings'] = soap.httpBindings;
    value.document['x-paritydiff-soap-mime-bindings'] = soap.mimeBindings;
    value.document['x-paritydiff-xml-schema-bundle'] = { schemas: soap.schemas, files: soap.files };
    for (const name of new Set(
      soap.bindings.filter((binding) => binding.overloaded).map((binding) => binding.name),
    )) {
      const path = '/soap/' + encodeURIComponent(name);
      if (!soap.bindings.some((binding) => binding.path === path)) delete paths[path];
    }
    for (const binding of soap.bindings)
      if (!Object.hasOwn(paths, binding.path))
        operation(binding.path, {}, {}, { protocol: 'soap', name: binding.name });
    for (const binding of soap.httpBindings) {
      const legacy = '/soap/' + encodeURIComponent(binding.name);
      if (!soap.bindings.some((item) => item.path === legacy)) delete paths[legacy];
      if (!Object.hasOwn(paths, binding.path))
        operation(
          binding.path,
          {},
          {},
          {
            protocol: 'wsdl-http',
            name: binding.name,
            method: binding.method,
            location: binding.location,
          },
        );
    }
  }
  return value;
}
async function protobuf(input) {
  const p = (await import('protobufjs')).default;
  const root = new p.Root();
  const parsed = p.parse(String(input.proto), root, { keepCase: true });
  const sources = Object.values(input['x-paritydiff-native-documents'] ?? {});
  const imports = [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])];
  for (const source of sources) {
    const dependency = p.parse(String(source), root, { keepCase: true });
    imports.push(...(dependency.imports ?? []), ...(dependency.weakImports ?? []));
  }
  for (const imported of new Set(imports)) {
    if (Object.hasOwn(p.common, imported)) root.addJSON(p.common[imported].nested);
    else if (
      !input['x-paritydiff-native-manifest']?.some((entry) => entry.imports.includes(imported))
    )
      throw new Error('protobuf imports require an approved descriptor bundle');
  }
  parsed.root.resolveAll();
  const named = (type) => type.fullName.replace(/^\./, '');
  const fieldSchema = (field) => {
    let schema;
    if (field.resolvedType instanceof p.Type)
      schema = { $ref: '#/components/schemas/' + pointer(named(field.resolvedType)) };
    else if (field.resolvedType instanceof p.Enum)
      schema = { type: 'string', enum: Object.keys(field.resolvedType.values).sort() };
    else
      schema = ['double', 'float'].includes(field.type)
        ? { type: 'number' }
        : field.type === 'bool'
          ? { type: 'boolean' }
          : field.type === 'string'
            ? { type: 'string' }
            : field.type === 'bytes'
              ? { type: 'string', contentEncoding: 'base64' }
              : /64$/.test(field.type)
                ? { type: 'string', pattern: '^-?[0-9]+$' }
                : { type: 'integer' };
    if (field.map) schema = { type: 'object', additionalProperties: schema };
    else if (field.repeated) schema = { type: 'array', items: schema };
    return {
      ...schema,
      'x-paritydiff-protobuf-field': {
        number: field.id,
        type: field.type,
        rule: field.rule,
        options: field.options,
      },
    };
  };
  const walk = (namespace, depth = 0) => {
    if (depth > 64) throw new Error('protobuf nesting limit');
    for (const value of namespace.nestedArray ?? []) {
      if (value instanceof p.Type) {
        schemas[named(value)] = {
          type: 'object',
          properties: Object.fromEntries(
            value.fieldsArray.map((field) => [field.name, fieldSchema(field)]),
          ),
          ...(value.fieldsArray.some((field) => field.required)
            ? {
                required: value.fieldsArray
                  .filter((field) => field.required)
                  .map((field) => field.name),
              }
            : {}),
          'x-paritydiff-protobuf-message': {
            reserved: value.reserved,
            oneofs: value.oneofsArray.map((oneof) => oneof.oneof),
          },
        };
      }
      if (value instanceof p.Service)
        for (const method of value.methodsArray)
          operation(
            '/grpc/' + named(value) + '/' + method.name,
            { $ref: '#/components/schemas/' + pointer(named(method.resolvedRequestType)) },
            { $ref: '#/components/schemas/' + pointer(named(method.resolvedResponseType)) },
            {
              protocol: 'grpc',
              requestStream: method.requestStream,
              responseStream: method.responseStream,
            },
          );
      if (value instanceof p.Namespace) walk(value, depth + 1);
    }
  };
  walk(parsed.root);
  if (!Object.keys(paths).length)
    operation('/protobuf/contract', undefined, undefined, { protocol: 'protobuf-descriptor' });
  issues.add(
    'Protocol Buffer wire field numbers, defaults, oneofs and streaming require descriptor/runtime compatibility validation',
  );
  return envelope('protobuf', 'Protocol Buffer contract', parsed.root.toJSON());
}
async function imports(input) {
  const result = [];
  if (input.proto) {
    const p = (await import('protobufjs')).default;
    const parsed = p.parse(String(input.proto));
    for (const path of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])])
      if (!Object.hasOwn(p.common, path)) result.push(path);
  } else if (input.sdl) {
    const g = await import('graphql');
    g.parse(String(input.sdl), { noLocation: true });
    for (const line of String(input.sdl).split(/\r?\n/)) {
      const match = line.match(/^\s*#\s*import\s+(?:(?:[\w*,\s]+)\s+from\s+)?["']([^"']+)["']\s*$/);
      if (match) result.push(match[1]);
    }
  } else if (input.xml) {
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(input.xml))
      throw new Error('XML DTD and entities are disabled');
    const { DOMParser } = await import('./xml11.mjs');
    const doc = new DOMParser({
      onError() {
        throw new Error('invalid XML');
      },
    }).parseFromString(String(input.xml), 'application/xml');
    let count = 0;
    const walk = (node, depth = 0) => {
      if (++count > 100000 || depth > 100) throw new Error('XML resource limit');
      if (
        node.nodeType === 1 &&
        ['import', 'include', 'redefine', 'override'].includes(node.localName) &&
        [
          'http://www.w3.org/2001/XMLSchema',
          'http://schemas.xmlsoap.org/wsdl/',
          'http://www.w3.org/ns/wsdl',
        ].includes(node.namespaceURI)
      ) {
        const location = node.getAttribute('schemaLocation') || node.getAttribute('location');
        if (location) result.push(location);
      }
      for (const child of Array.from(node.childNodes ?? [])) walk(child, depth + 1);
    };
    walk(doc);
  }
  return { sourceFormat: 'document', document: { imports: [...new Set(result)] } };
}
async function document(input) {
  let pages;
  let ocr;
  if (input.format === 'pdf') {
    const raw = String(input.content);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4)
      throw new Error('PDF upload must be valid base64');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.toString('base64') !== raw || bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new Error('invalid PDF upload');
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdf.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: true,
      maxImageSize: 4 * 1024 * 1024,
    });
    try {
      const file = await task.promise;
      if (file.numPages > 100) throw new Error('PDF page limit');
      pages = [];
      let length = 0;
      for (let i = 1; i <= file.numPages; i++) {
        const page = await file.getPage(i);
        let text = (await page.getTextContent()).items.map((item) => item.str ?? '').join(' ');
        let recognition;
        if (text.trim().length < 20) {
          const viewport = page.getViewport({
            scale: Math.min(
              2,
              2048 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1]),
            ),
          });
          if (viewport.width * viewport.height > 4 * 1024 * 1024)
            throw new Error('OCR page pixel limit');
          const { createCanvas } = await import('@napi-rs/canvas');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
          ocr ??= await createOfflineOcr();
          recognition = await ocr.recognize(canvas.toBuffer('image/png'));
          text = recognition.text;
        }
        length += text.length;
        if (length > 1000000) throw new Error('document text limit');
        pages.push({
          page: i,
          text,
          source: recognition ? 'ocr' : 'embedded-text',
          ...(recognition ? { ocr: recognition } : {}),
        });
        page.cleanup();
      }
    } finally {
      await ocr?.terminate();
      await task.destroy();
    }
  } else if (input.format === 'image') {
    const raw = String(input.content);
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
      raw.length % 4 ||
      Buffer.from(raw, 'base64').toString('base64') !== raw
    )
      throw new Error('image upload must be valid base64');
    const bytes = Buffer.from(raw, 'base64');
    imageDimensions(bytes);
    ocr = await createOfflineOcr();
    try {
      const recognition = await ocr.recognize(bytes);
      pages = [{ page: 1, text: recognition.text, source: 'ocr', ocr: recognition }];
    } finally {
      await ocr.terminate();
    }
  } else if (input.format === 'binary') {
    const raw = String(input.content);
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
      raw.length % 4 ||
      Buffer.from(raw, 'base64').toString('base64') !== raw
    )
      throw new Error('opaque upload must be valid base64');
    pages = [];
    issues.add(
      'Opaque input requires a format parser or reviewed machine-readable contract before semantic detection or migration',
    );
  } else {
    const text = String(input.content);
    if (text.length > 1000000) throw new Error('document text limit');
    pages = [{ page: 1, text }];
  }
  operation('/document/evidence', undefined, undefined, { protocol: 'document' });
  issues.add('Document text is evidence, not an asserted executable API contract');
  if (pages.every((page) => !page.text.trim()))
    issues.add('No searchable text; OCR or a machine-readable contract is required');
  return envelope('document', 'API documentation', {
    format: input.format,
    digest: hash(String(input.content)),
    pages,
  });
}
async function graphqlCompatibility({ before, after, operations = [] }) {
  const g = await import('graphql');
  if (before?.kind !== 'Document' || after?.kind !== 'Document')
    throw new Error('GraphQL SDL evidence required');
  const oldSchema = g.buildASTSchema(before);
  const newSchema = g.buildASTSchema(after);
  const safe = new Set(Object.values(g.SafeChangeType));
  const breaking = new Set(Object.values(g.BreakingChangeType));
  const changes = g.findSchemaChanges(oldSchema, newSchema).map(({ type }) => ({
    rule: type.toLowerCase(),
    classification: breaking.has(type) ? 'breaking' : safe.has(type) ? 'non_breaking' : 'ambiguous',
  }));
  if (!Array.isArray(operations) || operations.length > 12)
    throw new Error('GraphQL operation fixture limit');
  for (const { path, source } of operations) {
    let query;
    try {
      if (typeof source === 'string')
        query = g.parse(source, { maxTokens: 20000, noLocation: true });
    } catch {
      // Treat an invalid baseline fixture as incomplete coverage.
    }
    if (
      !query ||
      !query.definitions.some((node) => node.kind === 'OperationDefinition') ||
      g.validate(oldSchema, query).length
    ) {
      changes.push({ path, rule: 'baseline_operation_invalid', classification: 'ambiguous' });
    } else if (g.validate(newSchema, query).length) {
      changes.push({ path, rule: 'operation_no_longer_valid', classification: 'breaking' });
    } else {
      changes.push({ path, rule: 'operation_still_valid', classification: 'non_breaking' });
    }
  }
  return {
    sourceFormat: 'graphql',
    document: { changes },
  };
}

async function parseTask({ kind, input }) {
  try {
    checkTree(input, kind === 'semantic' || kind === 'payload' || kind === 'vocabularies');
    const value =
      kind === 'payload'
        ? {
            sourceFormat: 'document',
            document: {
              validation: input.soapBinding
                ? input.native.operationPaths?.some((path) => path.startsWith('/wsdl-http/'))
                  ? (await import('./wsdl-http.mjs')).bindWsdlHttpPayload(input)
                  : input.bytesBase64 !== undefined
                    ? (await import('./soap-package.mjs')).bindSoapWirePayload(input)
                    : (await import('./soap-binding.mjs')).bindSoapPayload(
                        input.native.document,
                        input.payload,
                        input.native.operationPaths,
                        input.direction,
                        input.native.bindingId,
                      )
                : input.native
                  ? await (await import('./native-validation.mjs')).validateNativePayload(input)
                  : await (async () => {
                      try {
                        const validate = (await import('./semantic-compare.mjs')).compiler(
                          input.schema,
                          input.resources ?? [],
                          input.dialect,
                        );
                        return { available: true, valid: Boolean(validate(input.payload)) };
                      } catch {
                        return { available: false, valid: false };
                      }
                    })(),
            },
          }
        : kind === 'semantic'
          ? {
              sourceFormat: 'document',
              document: {
                comparison: (await import('./semantic-compare.mjs')).compareSchemas(input),
              },
            }
          : kind === 'vocabularies'
            ? {
                sourceFormat: 'json-schema',
                document: (await import('./schema-vocabularies.mjs')).prepareCapturedDocuments(
                  input.documents,
                ),
              }
            : kind === 'graphql-compatibility'
              ? await graphqlCompatibility(input)
              : await { graphql, asyncapi, protobuf, xml, document, imports }[kind](input);
    if (kind !== 'imports' && input['x-paritydiff-native-manifest']) {
      value.document['x-paritydiff-native-manifest'] = input['x-paritydiff-native-manifest'];
      value.document['x-paritydiff-native-documents'] = input['x-paritydiff-native-documents'];
      value.document['x-paritydiff-native-edges'] = input['x-paritydiff-native-edges'];
      value.document['x-paritydiff-native-root'] = input['x-paritydiff-native-root'];
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('parsed contract size limit');
    const result = { ok: true, value };
    if (parentPort) parentPort.postMessage(result);
    else process.send(result, () => process.disconnect());
  } catch (cause) {
    const result = {
      ok: false,
      reason:
        kind === 'vocabularies' && !/^schema_[a-z_]+$/.test(String(cause?.message))
          ? 'schema_metaschema_validation_unavailable'
          : String(cause?.message ?? 'contract parsing unavailable').slice(0, 400),
    };
    if (parentPort) parentPort.postMessage(result);
    else process.send(result, () => process.disconnect());
  }
}
if (parentPort) void parseTask(workerData);
else process.once('message', (input) => void parseTask(input));
