import { object, resolveLocalReference, visitContract, type ContractObject } from './contract-tree';
import {
  validateContractDocument,
  validateJsonSchema,
  validatePostmanDocument,
} from './schema-validation';
import { sha256Hex } from '@paritydiff/core';
import type { ValidationGraph } from './validation-graph';

export interface AdaptedContract {
  document: ContractObject;
  sourceFormat: 'swagger2' | 'postman' | 'json-schema';
}
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const copyExcept = (input: ContractObject, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parameterSchema(param: ContractObject): ContractObject {
  return Object.fromEntries(
    Object.entries(param).filter(([key]) =>
      [
        'type',
        'format',
        'items',
        'enum',
        'default',
        'maximum',
        'minimum',
        'exclusiveMaximum',
        'exclusiveMinimum',
        'maxLength',
        'minLength',
        'pattern',
        'maxItems',
        'minItems',
        'uniqueItems',
        'multipleOf',
      ].includes(key),
    ),
  );
}
function swaggerParameter(param: ContractObject): ContractObject {
  const next = {
    ...copyExcept(param, [...Object.keys(parameterSchema(param)), 'collectionFormat']),
    schema: parameterSchema(param),
  };
  if (param['collectionFormat'] === 'multi') return { ...next, style: 'form', explode: true };
  if (param['collectionFormat'] === 'ssv')
    return { ...next, style: 'spaceDelimited', explode: false };
  if (param['collectionFormat'] === 'pipes')
    return { ...next, style: 'pipeDelimited', explode: false };
  if (param['collectionFormat'] === 'tsv')
    throw new Error('tab-separated parameter serialization requires an explicit adapter');
  return next;
}

export function adaptSwagger(input: unknown): AdaptedContract {
  const validation = validateContractDocument(input);
  if (!validation.valid) throw new Error('invalid Swagger: ' + validation.errors.join('; '));
  const doc = structuredClone(input) as ContractObject;
  const reusableParams = object(doc['parameters']) ?? {};
  const resolveParam = (value: unknown) => {
    const param = object(value);
    const resolved =
      typeof param?.['$ref'] === 'string'
        ? object(resolveLocalReference(doc, param['$ref']))
        : param;
    if (!resolved) throw new Error('unresolved Swagger parameter');
    return resolved;
  };
  const response = (raw: unknown, produces: unknown): unknown => {
    const value = object(raw);
    if (!value) throw new Error('invalid Swagger response');
    if (value['$ref']) return value;
    const schema = value['schema'];
    const media = list(produces).length ? list(produces) : ['application/json'];
    return {
      ...copyExcept(value, ['schema', 'examples', 'headers']),
      ...(schema !== undefined
        ? {
            content: Object.fromEntries(
              media.map((type) => [
                String(type),
                {
                  schema,
                  ...(object(value['examples'])?.[String(type)] !== undefined
                    ? { example: object(value['examples'])![String(type)] }
                    : {}),
                },
              ]),
            ),
          }
        : {}),
      ...(value['headers']
        ? {
            headers: Object.fromEntries(
              Object.entries(object(value['headers']) ?? {}).map(([name, header]) => [
                name,
                swaggerParameter(object(header) ?? {}),
              ]),
            ),
          }
        : {}),
    };
  };
  const paths: ContractObject = Object.create(null);
  for (const [path, raw] of Object.entries(object(doc['paths']) ?? {})) {
    if (path.startsWith('x-')) {
      paths[path] = raw;
      continue;
    }
    const item = object(raw)!;
    const target = copyExcept(item, [...methods, 'parameters']);
    for (const method of methods) {
      const op = object(item[method]);
      if (!op) continue;
      const params = [
        ...new Map(
          [...list(item['parameters']), ...list(op['parameters'])]
            .map(resolveParam)
            .map((p) => [String(p['in']) + ':' + String(p['name']), p]),
        ).values(),
      ];
      const bodies = params.filter((p) => p['in'] === 'body');
      const forms = params.filter((p) => p['in'] === 'formData');
      if (bodies.length > 1 || (bodies.length && forms.length))
        throw new Error('conflicting Swagger payload parameters');
      const body = bodies[0];
      const consumes = list(op['consumes'] ?? doc['consumes']);
      const schema =
        body?.['schema'] ??
        (forms.length
          ? {
              type: 'object',
              properties: Object.fromEntries(
                forms.map((p) => [
                  String(p['name']),
                  p['type'] === 'file' ? { type: 'string', format: 'binary' } : parameterSchema(p),
                ]),
              ),
              required: forms.filter((p) => p['required']).map((p) => p['name']),
            }
          : undefined);
      target[method] = {
        ...copyExcept(op, ['consumes', 'produces', 'schemes', 'parameters', 'responses']),
        parameters: params
          .filter((p) => !['body', 'formData'].includes(String(p['in'])))
          .map(swaggerParameter),
        responses: Object.fromEntries(
          Object.entries(object(op['responses']) ?? {}).map(([status, value]) => [
            status,
            response(value, op['produces'] ?? doc['produces']),
          ]),
        ),
        ...(schema !== undefined
          ? {
              requestBody: {
                required: body?.['required'] === true || forms.some((p) => p['required'] === true),
                ...(body?.['description'] ? { description: body['description'] } : {}),
                content: Object.fromEntries(
                  (consumes.length
                    ? consumes
                    : [forms.length ? 'multipart/form-data' : 'application/json']
                  ).map((type) => [String(type), { schema }]),
                ),
              },
            }
          : {}),
      };
    }
    paths[path] = target;
  }
  const securitySchemes = Object.fromEntries(
    Object.entries(object(doc['securityDefinitions']) ?? {}).map(([name, raw]) => {
      const value = object(raw)!;
      if (value['type'] === 'basic')
        return [name, { ...copyExcept(value, ['type']), type: 'http', scheme: 'basic' }];
      if (value['type'] !== 'oauth2') return [name, value];
      const flow = (
        {
          implicit: 'implicit',
          password: 'password',
          application: 'clientCredentials',
          accessCode: 'authorizationCode',
        } as Record<string, string>
      )[String(value['flow'])];
      return [
        name,
        {
          type: 'oauth2',
          ...(value['description'] ? { description: value['description'] } : {}),
          flows: { [flow!]: copyExcept(value, ['type', 'flow', 'description']) },
        },
      ];
    }),
  );
  const converted: ContractObject = {
    ...copyExcept(doc, [
      'swagger',
      'host',
      'basePath',
      'schemes',
      'consumes',
      'produces',
      'definitions',
      'parameters',
      'responses',
      'securityDefinitions',
      'paths',
    ]),
    openapi: '3.0.4',
    paths,
    components: {
      schemas: doc['definitions'] ?? {},
      parameters: Object.fromEntries(
        Object.entries(reusableParams)
          .filter(([, value]) => !['body', 'formData'].includes(String(object(value)?.['in'])))
          .map(([name, value]) => [name, swaggerParameter(object(value)!)]),
      ),
      responses: Object.fromEntries(
        Object.entries(object(doc['responses']) ?? {}).map(([name, value]) => [
          name,
          response(value, doc['produces']),
        ]),
      ),
      securitySchemes,
    },
    ...(doc['host']
      ? {
          servers: (list(doc['schemes']).length ? list(doc['schemes']) : ['https']).map(
            (scheme) => ({ url: String(scheme) + '://' + doc['host'] + (doc['basePath'] ?? '') }),
          ),
        }
      : {}),
    'x-paritydiff-source-format': 'swagger2',
  };
  visitContract(converted, (node) => {
    if (typeof node['$ref'] === 'string')
      node['$ref'] = node['$ref']
        .replace(/^#\/definitions\//, '#/components/schemas/')
        .replace(/^#\/parameters\//, '#/components/parameters/')
        .replace(/^#\/responses\//, '#/components/responses/');
  });
  return { document: converted, sourceFormat: 'swagger2' };
}

function sampleSchema(value: unknown, depth = 0): ContractObject {
  if (depth > 30) throw new Error('sample schema nesting limit');
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const variants = [
      ...new Map(
        value.map((v) => {
          const schema = sampleSchema(v, depth + 1);
          return [JSON.stringify(schema), schema];
        }),
      ).values(),
    ];
    return {
      type: 'array',
      items: variants.length === 1 ? variants[0] : variants.length ? { anyOf: variants } : {},
    };
  }
  const members = object(value);
  if (members)
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(members).map(([key, child]) => [key, sampleSchema(child, depth + 1)]),
      ),
    };
  return {
    type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
  };
}

export function adaptPostman(input: unknown): AdaptedContract {
  const validation = validatePostmanDocument(input);
  if (!validation.valid) throw new Error('invalid Postman: ' + validation.errors.join('; '));
  const doc = input as ContractObject;
  const info = object(doc['info'])!;
  const paths: ContractObject = Object.create(null);
  const issues: string[] = [];
  const schemas: ContractObject = Object.create(null);
  const remoteDocuments: ContractObject = Object.create(null);
  const manifest: unknown[] = [];
  const validationGraph: ValidationGraph = { version: 1, resources: [], contexts: {} };
  const embeddedContexts = new Map<string, { schema: unknown; dialect: string }>();
  const embed = (raw: unknown): unknown => {
    if (typeof raw === 'boolean') return raw;
    const schema = structuredClone(raw) as ContractObject;
    const id = 'CollectionSchema' + Object.keys(schemas).length;
    const prefix = '#/components/schemas/' + id;
    const captured = schema['x-paritydiff-validation-graph'] as ValidationGraph | undefined;
    delete schema['x-paritydiff-validation-graph'];
    if (captured?.rootSchema) {
      const aliases = new Map<string, string>();
      for (const resource of captured.resources)
        visitContract(resource, (node) => {
          if (typeof node['$id'] === 'string')
            aliases.set(
              node['$id'],
              'https://paritydiff.invalid/collection/' + sha256Hex(id + ':' + node['$id']),
            );
        });
      const rewrite = (value: unknown) => {
        const copy = structuredClone(value);
        visitContract(copy, (node) => {
          for (const key of ['$id', '$ref', '$dynamicRef', '$recursiveRef']) {
            const text = node[key];
            if (typeof text !== 'string' || text.startsWith('#')) continue;
            const index = text.indexOf('#'),
              base = index < 0 ? text : text.slice(0, index);
            if (aliases.has(base))
              node[key] = aliases.get(base)! + (index < 0 ? '' : text.slice(index));
          }
        });
        return copy;
      };
      validationGraph.resources.push(...captured.resources.map(rewrite));
      const root = captured.resources.find(
        (resource) => object(resource)?.['$id'] === object(captured.rootSchema)?.['$ref'],
      );
      embeddedContexts.set(prefix, {
        schema: rewrite(captured.rootSchema),
        dialect: String(
          object(root)?.['$schema'] ?? 'https://json-schema.org/draft/2020-12/schema',
        ),
      });
    }
    const nodes = new Map<unknown, string>();
    visitContract(schema, (node, pointer) => nodes.set(node, pointer));
    const remotes = object(schema['x-paritydiff-reference-documents']) ?? {};
    manifest.push(...list(schema['x-paritydiff-reference-manifest']));
    for (const [key, value] of Object.entries(remotes)) {
      visitContract(value, (node) => {
        if (
          typeof node['$ref'] === 'string' &&
          node['$ref'].startsWith('#') &&
          !node['$ref'].startsWith('#/x-paritydiff-reference-documents/')
        )
          node['$ref'] = prefix + node['$ref'].slice(1);
      });
      if (
        Object.hasOwn(remoteDocuments, key) &&
        JSON.stringify(remoteDocuments[key]) !== JSON.stringify(value)
      )
        throw new Error('collection dependency changed during capture');
      remoteDocuments[key] = value;
    }
    delete schema['x-paritydiff-reference-documents'];
    delete schema['x-paritydiff-reference-manifest'];
    visitContract(schema, (node, pointer, resource) => {
      const ref = node['$ref'];
      if (
        typeof ref === 'string' &&
        ref.startsWith('#') &&
        !ref.startsWith('#/x-paritydiff-reference-documents/')
      ) {
        const resolved = resolveLocalReference(resource, ref);
        const target = nodes.get(resolved);
        if (target !== undefined) node['$ref'] = prefix + target;
        else if (ref === '#' || ref.startsWith('#/'))
          node['$ref'] = prefix + (nodes.get(resource) ?? '') + ref.slice(1);
        else throw new Error('unresolved collection schema anchor at ' + pointer);
      }
      if (typeof node['$id'] === 'string') {
        node['x-paritydiff-resource-id'] = node['$id'];
        delete node['$id'];
      }
      if (node['$dynamicRef'])
        issues.push('dynamic collection schema scope requires independent validation');
    });
    schemas[id] = schema;
    return { $ref: prefix };
  };
  if (doc['x-paritydiff-contract-authority'] !== 'asserted')
    issues.push('collection entries are observations, not an asserted complete API contract');
  const variables = (values: unknown) =>
    Object.fromEntries(
      list(values).map((v) => {
        const item = object(v) ?? {};
        return [String(item['key'] ?? item['id']), String(item['value'] ?? '')];
      }),
    );
  let examples = false;
  const collect = (
    items: unknown[],
    inherited: Record<string, string>,
    depth: number,
    inheritedBehavior = false,
  ): void => {
    if (depth > 30) throw new Error('collection folder depth limit');
    for (const raw of items) {
      const item = object(raw)!;
      const vars = { ...inherited, ...variables(item['variable']) };
      const hasBehavior = inheritedBehavior || Boolean(item['auth'] || item['event']);
      if (Array.isArray(item['item'])) {
        collect(item['item'], vars, depth + 1, hasBehavior);
        continue;
      }
      const request =
        typeof item['request'] === 'string'
          ? { method: 'GET', url: item['request'] }
          : object(item['request']);
      if (!request) throw new Error('collection request is missing');
      const urlObject = object(request['url']);
      const rawUrl = typeof request['url'] === 'string' ? request['url'] : urlObject?.['raw'];
      if (typeof rawUrl !== 'string') {
        issues.push('request URL is unavailable');
        continue;
      }
      const local = { ...vars, ...variables(urlObject?.['variable']) };
      const resolved = rawUrl.replace(
        /\{\{([^{}]+)\}\}/g,
        (full, key: string) => local[key] ?? full,
      );
      if (/\{\{/.test(resolved)) {
        issues.push('unresolved request URL variables');
        continue;
      }
      let url: URL;
      try {
        url = new URL(resolved);
      } catch {
        issues.push('request URL is not absolute');
        continue;
      }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('unsafe collection URL');
      const path = url.pathname.replace(/:([A-Za-z_][\w]*)/g, '{$1}');
      const method = String(request['method'] ?? 'GET').toLowerCase();
      if (!methods.includes(method)) {
        issues.push('unsupported collection method ' + method);
        continue;
      }
      const parameters = [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      for (const name of new Set([...url.searchParams.keys()]))
        parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
      const body = object(request['body']);
      let schema = request['x-paritydiff-request-schema'];
      if (schema === undefined && typeof body?.['raw'] === 'string') {
        try {
          schema = sampleSchema(JSON.parse(body['raw']));
          examples = true;
        } catch {
          issues.push('non-JSON request body requires a serialization adapter');
        }
      }
      if (schema !== undefined && !validateJsonSchema(schema).valid)
        throw new Error('invalid collection request schema');
      if (schema !== undefined) schema = embed(schema);
      const requestContext = embeddedContexts.get(String(object(schema)?.['$ref']));
      if (requestContext)
        validationGraph.contexts[
          JSON.stringify([path, method, 'request', 'application/json', ''])
        ] = requestContext;
      const responseEntries = list(item['response']).map((rawResponse) => {
        const response = object(rawResponse) ?? {};
        const explicit = response['x-paritydiff-response-schema'];
        if (explicit !== undefined && !validateJsonSchema(explicit).valid)
          throw new Error('invalid collection response schema');
        if (explicit === undefined) examples = true;
        const responseSchema = explicit !== undefined ? embed(explicit) : undefined;
        const responseContext = embeddedContexts.get(String(object(responseSchema)?.['$ref']));
        if (responseContext)
          validationGraph.contexts[
            JSON.stringify([
              path,
              method,
              'response',
              'application/json',
              String(response['code'] ?? 'default'),
            ])
          ] = responseContext;
        return [
          String(response['code'] ?? 'default'),
          {
            description: String(response['name'] ?? 'Collection response'),
            ...(explicit !== undefined
              ? { content: { 'application/json': { schema: responseSchema } } }
              : {}),
          },
        ];
      });
      if (new Set(responseEntries.map(([code]) => code)).size !== responseEntries.length)
        throw new Error(
          'multiple response examples for the same status require an explicit merged schema',
        );
      const responses = Object.fromEntries(responseEntries);
      const op = {
        summary: String(item['name'] ?? 'Collection request'),
        parameters,
        responses: Object.keys(responses).length
          ? responses
          : { default: { description: 'Response contract not supplied' } },
        ...(schema !== undefined
          ? { requestBody: { content: { 'application/json': { schema } } } }
          : {}),
      };
      const target = object(paths[path]) ?? Object.create(null);
      if (Object.hasOwn(target, method))
        throw new Error('conflicting collection requests for the same operation');
      target[method] = op;
      paths[path] = target;
      if (
        (body && !schema) ||
        !Object.keys(responses).length ||
        request['auth'] ||
        request['header'] ||
        hasBehavior ||
        item['event'] ||
        doc['event']
      )
        issues.push(
          'collection coverage is observational or includes scripts/authentication not represented as a contract',
        );
    }
  };
  collect(list(doc['item']), variables(doc['variable']), 0, Boolean(doc['auth'] || doc['event']));
  if (examples) issues.push('example values do not establish authoritative constraints');
  return {
    sourceFormat: 'postman',
    document: {
      openapi: '3.1.2',
      info: {
        title: String(info['name']),
        version: String(object(info['version'])?.['raw'] ?? 'collection'),
      },
      paths,
      components: { schemas },
      ...(validationGraph.resources.length
        ? { 'x-paritydiff-validation-graph': validationGraph }
        : {}),
      ...(Object.keys(remoteDocuments).length
        ? {
            'x-paritydiff-reference-documents': remoteDocuments,
            'x-paritydiff-reference-manifest': manifest,
          }
        : {}),
      'x-paritydiff-source-format': 'postman',
      ...(issues.length ? { 'x-paritydiff-coverage-issues': [...new Set(issues)].sort() } : {}),
    },
  };
}

export function adaptJsonSchema(input: unknown): AdaptedContract {
  const valid = validateJsonSchema(input);
  if (!valid.valid) throw new Error('invalid JSON Schema: ' + valid.errors.join('; '));
  const schema = structuredClone(input) as ContractObject;
  const graph = Object.fromEntries(
    [
      'x-paritydiff-reference-documents',
      'x-paritydiff-reference-manifest',
      'x-paritydiff-validation-graph',
      'x-paritydiff-vocabulary-profiles',
    ]
      .filter((key) => Object.hasOwn(schema, key))
      .map((key) => [key, schema[key]]),
  );
  for (const key of Object.keys(graph)) delete schema[key];
  const bindings = list(schema['x-paritydiff-http-bindings']);
  const paths: ContractObject = Object.create(null);
  visitContract(schema, (node) => {
    if (
      typeof node['$ref'] === 'string' &&
      node['$ref'].startsWith('#') &&
      !node['$ref'].startsWith('#/x-paritydiff-reference-documents/')
    )
      node['$ref'] = '#/components/schemas/Contract' + node['$ref'].slice(1);
  });
  for (const document of Object.values(object(graph['x-paritydiff-reference-documents']) ?? {}))
    visitContract(document, (node) => {
      if (
        typeof node['$ref'] === 'string' &&
        node['$ref'].startsWith('#') &&
        !node['$ref'].startsWith('#/x-paritydiff-reference-documents/')
      )
        node['$ref'] = '#/components/schemas/Contract' + node['$ref'].slice(1);
    });
  const reference = { $ref: '#/components/schemas/Contract' };
  for (const raw of bindings.length
    ? bindings
    : [{ path: '/$contract', method: 'POST', direction: 'request' }]) {
    const binding = object(raw)!;
    const path = String(binding['path']),
      method = String(binding['method']).toLowerCase();
    if (!path.startsWith('/') || !methods.includes(method))
      throw new Error('invalid schema HTTP binding');
    const target = object(paths[path]) ?? Object.create(null);
    if (Object.hasOwn(target, method)) throw new Error('duplicate schema HTTP binding');
    const parameters = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: {},
    }));
    target[method] =
      binding['direction'] === 'response'
        ? {
            parameters,
            responses: {
              '200': {
                description: 'Schema contract',
                content: { 'application/json': { schema: reference } },
              },
            },
          }
        : {
            parameters,
            requestBody: { content: { 'application/json': { schema: reference } } },
            responses: { default: { description: 'No response contract supplied' } },
          };
    paths[path] = target;
  }
  return {
    sourceFormat: 'json-schema',
    document: {
      openapi: '3.1.2',
      jsonSchemaDialect: schema['$schema'] ?? 'https://json-schema.org/draft/2020-12/schema',
      info: { title: String(schema['title'] ?? 'JSON Schema contract'), version: 'schema' },
      paths,
      components: { schemas: { Contract: schema } },
      ...graph,
      'x-paritydiff-source-format': 'json-schema',
      ...(!bindings.length
        ? { 'x-paritydiff-coverage-issues': ['application bindings are not supplied'] }
        : {}),
    },
  };
}
