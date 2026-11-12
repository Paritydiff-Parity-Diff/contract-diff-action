import { sha256Hex, legacySchemaDialect } from '@paritydiff/core';
import {
  object,
  pointerEscape,
  pointerFragment,
  contractChildRole,
  contractDialect,
  contractResourceId,
  type ContractRole,
} from './contract-tree';
type Location = { document: string; pointer: string };
export interface SchemaValidationContext {
  schema: unknown;
  resources: readonly unknown[];
  dialect: string;
}
function reachableResources(schema: unknown, resources: readonly unknown[]): readonly unknown[] {
  const owners = new Map<string, Set<number>>(),
    references: Set<string>[] = [];
  const inspect = (value: unknown, register?: number): Set<string> => {
    const found = new Set<string>();
    let steps = 0;
    const walk = (node: unknown, base: string, role: ContractRole, depth: number) => {
      if (++steps > 200000 || depth > 128) throw new Error('validation_resource_graph_limit');
      if (role === 'literal') return;
      if (Array.isArray(node)) {
        node.forEach((child) => walk(child, base, role, depth + 1));
        return;
      }
      const entry = object(node);
      if (!entry) return;
      if (role === 'structure' && typeof entry['$id'] === 'string')
        base = new URL(entry['$id'], base).href;
      if (role === 'structure' && register !== undefined && typeof entry['$id'] === 'string') {
        const uri = new URL(base);
        uri.hash = '';
        const indices = owners.get(uri.href) ?? new Set<number>();
        indices.add(register);
        owners.set(uri.href, indices);
      }
      for (const [key, child] of Object.entries(entry)) {
        if (
          role === 'structure' &&
          ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
          typeof child === 'string'
        ) {
          const uri = new URL(child, base);
          uri.hash = '';
          found.add(uri.href);
        } else walk(child, base, contractChildRole(role, key), depth + 1);
      }
    };
    walk(value, 'https://paritydiff.invalid/validation-context', 'structure', 0);
    return found;
  };
  resources.forEach((resource, index) => references.push(inspect(resource, index)));
  const selected = new Set<number>(),
    pending = [...inspect(schema)];
  for (let position = 0; position < pending.length; position++) {
    for (const index of owners.get(pending[position]!) ?? []) {
      if (selected.has(index)) continue;
      selected.add(index);
      pending.push(...references[index]!);
    }
  }
  return resources.filter((_, index) => selected.has(index));
}
export function schemaValidationContext(
  document: unknown,
  method: string,
  path: string,
  direction: 'request' | 'response' = 'request',
  media = 'application/json',
  status = '200',
): SchemaValidationContext {
  const root = object(document),
    graph = root?.['x-paritydiff-validation-graph'] as ValidationGraph | undefined;
  const operation = object(object(object(root?.['paths'])?.[path])?.[method.toLowerCase()]);
  const responses = object(operation?.['responses']) ?? {};
  const selectedStatus =
    direction === 'response'
      ? ([status, ...(/^[1-5][0-9]{2}$/.test(status) ? [status[0] + 'XX'] : []), 'default'].find(
          (key) => Object.hasOwn(responses, key),
        ) ?? status)
      : '';
  const mediaChoices = [...new Set([media, media.split('/')[0] + '/*', '*/*'])];
  const frozen = mediaChoices
    .map(
      (type) =>
        graph?.contexts?.[
          JSON.stringify([path, method.toLowerCase(), direction, type, selectedStatus])
        ],
    )
    .find(Boolean);
  if (frozen) return { ...frozen, resources: reachableResources(frozen.schema, graph!.resources) };
  if (graph?.rootSchema)
    return {
      schema: graph.rootSchema,
      resources: reachableResources(graph.rootSchema, graph.resources),
      dialect: String(
        root?.['$schema'] ??
          root?.['jsonSchemaDialect'] ??
          'https://json-schema.org/draft/2020-12/schema',
      ),
    };
  const container =
    direction === 'request'
      ? object(operation?.['requestBody'])
      : object(responses[selectedStatus]);
  const content = object(container?.['content']) ?? {};
  const selectedMedia = mediaChoices.find((type) => Object.hasOwn(content, type));
  const schema = selectedMedia ? object(content[selectedMedia])?.['schema'] : undefined;
  return {
    schema,
    resources: [],
    dialect: String(
      object(schema)?.['$schema'] ??
        root?.['jsonSchemaDialect'] ??
        (String(root?.['openapi']).startsWith('3.0')
          ? 'openapi3.0'
          : 'https://json-schema.org/draft/2020-12/schema'),
    ),
  };
}
export interface ValidationGraph {
  version: 1;
  resources: unknown[];
  contexts: Record<string, { schema: unknown; dialect: string }>;
  rootSchema?: unknown;
}
export function freezeValidationGraph(
  documents: ReadonlyMap<string, unknown>,
  rootUrl: string,
  locate: (absolute: string) => Location,
): ValidationGraph | undefined {
  const rootDocument = object(documents.get(rootUrl));
  const inheritedDialect = String(
    rootDocument?.['jsonSchemaDialect'] ??
      (String(rootDocument?.['openapi']).startsWith('3.0') || rootDocument?.['swagger'] === '2.0'
        ? 'openapi3.0'
        : 'https://json-schema.org/draft/2020-12/schema'),
  );
  const slots: {
    document: string;
    pointer: string;
    schema: unknown;
    id: string;
    dialect: string;
  }[] = [];
  for (const [document, value] of documents) {
    const root = object(value);
    const isOpenApi = typeof root?.['openapi'] === 'string' || root?.['swagger'] === '2.0';
    if (!isOpenApi) {
      if (
        typeof value === 'boolean' ||
        (root &&
          [
            'type',
            '$schema',
            '$defs',
            'definitions',
            'allOf',
            'anyOf',
            'oneOf',
            'enum',
            'const',
            '$ref',
            '$dynamicRef',
          ].some((key) => Object.hasOwn(root, key)))
      )
        slots.push({
          document,
          pointer: '',
          schema: value,
          id: 'https://paritydiff.invalid/schema/' + sha256Hex(document),
          dialect: String(root?.['$schema'] ?? inheritedDialect),
        });
      if (slots.at(-1)?.document === document) continue;
    }
    const dialect = String(
      root?.['jsonSchemaDialect'] ??
        (String(root?.['openapi']).startsWith('3.0') || root?.['swagger'] === '2.0'
          ? 'openapi3.0'
          : inheritedDialect),
    );
    const walk = (node: unknown, pointer: string, role: ContractRole) => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, pointer + '/' + index, role));
        return;
      }
      const entry = object(node);
      if (!entry || role === 'literal') return;
      for (const [key, child] of Object.entries(entry)) {
        const next = pointer + '/' + pointerEscape(key);
        if (
          (role === 'structure' && key === 'schema') ||
          /^\/(components\/schemas|definitions)\/[^/]+$/.test(next)
        ) {
          slots.push({
            document,
            pointer: next,
            schema: child,
            id: 'https://paritydiff.invalid/schema/' + sha256Hex(document + next),
            dialect: String(object(child)?.['$schema'] ?? dialect),
          });
        } else walk(child, next, contractChildRole(role, key));
      }
    };
    walk(value, '', 'structure');
  }
  if (!slots.length) return undefined;
  const target = (absolute: string) => {
    const location = locate(absolute);
    const slot = slots
      .filter(
        (slot) =>
          slot.document === location.document &&
          (slot.pointer === location.pointer || location.pointer.startsWith(slot.pointer + '/')),
      )
      .sort((a, b) => b.pointer.length - a.pointer.length)[0];
    if (!slot) throw new Error('reference target is not a validation schema');
    let base = slot.document,
      scopePointer = slot.pointer,
      resource = slot.id;
    let node = slot.schema;
    const remainder = location.pointer.slice(slot.pointer.length);
    const parts = remainder ? remainder.slice(1).split('/') : [];
    let pointer = slot.pointer;
    let dialect = slot.dialect,
      role: ContractRole = 'structure';
    for (let index = 0; index <= parts.length; index++) {
      const entry = object(node);
      if (role === 'structure') dialect = contractDialect(node, dialect);
      const resourceId =
        entry && role === 'structure' ? contractResourceId(entry, dialect) : undefined;
      if (resourceId !== undefined) {
        base = new URL(resourceId, base).href;
        scopePointer = pointer;
        resource = 'https://paritydiff.invalid/resource/' + sha256Hex(base);
      }
      if (index === parts.length) break;
      const part = parts[index]!;
      role = contractChildRole(role, part.replace(/~1/g, '/').replace(/~0/g, '~'));
      node = Array.isArray(node)
        ? node[Number(part)]
        : entry?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      pointer += '/' + part;
    }
    return {
      slot,
      location,
      ref: resource + '#' + pointerFragment(location.pointer.slice(scopePointer.length)),
    };
  };
  const resourceIds = new Map<string, string>();
  for (const slot of slots) {
    const walk = (node: unknown, base: string, role: ContractRole, dialect: string) => {
      if (Array.isArray(node)) {
        node.forEach((child) => walk(child, base, role, dialect));
        return;
      }
      const entry = object(node);
      if (!entry || role === 'literal') return;
      if (role === 'structure') dialect = contractDialect(entry, dialect);
      const resourceId = role === 'structure' ? contractResourceId(entry, dialect) : undefined;
      if (resourceId !== undefined) {
        base = new URL(resourceId, base).href;
        resourceIds.set(base, 'https://paritydiff.invalid/resource/' + sha256Hex(base));
      }
      for (const [key, child] of Object.entries(entry))
        walk(child, base, contractChildRole(role, key), dialect);
    };
    walk(slot.schema, slot.document, 'structure', slot.dialect);
  }
  const resources = slots.map((slot) => {
    const convert = (node: unknown, base: string, role: ContractRole, dialect: string): unknown => {
      if (Array.isArray(node)) return node.map((child) => convert(child, base, role, dialect));
      const entry = object(node);
      if (!entry || role === 'literal') return structuredClone(node);
      const output: Record<string, unknown> = Object.create(null);
      if (role === 'structure') dialect = contractDialect(entry, dialect);
      const resourceId = role === 'structure' ? contractResourceId(entry, dialect) : undefined;
      if (resourceId !== undefined) base = new URL(resourceId, base).href;
      for (const [key, child] of Object.entries(entry)) {
        if (role === 'structure' && key === '$id') {
          if (resourceId !== undefined) output[key] = resourceIds.get(base);
          continue;
        }
        if (
          role === 'structure' &&
          ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
          typeof child === 'string'
        ) {
          if (key !== '$ref' && child.startsWith('#')) {
            output[key] = child;
            continue;
          }
          const absolute = new URL(child, base).href,
            resolved = target(absolute);
          const uri = new URL(absolute),
            fragment = uri.hash;
          uri.hash = '';
          output[key] =
            key !== '$ref' && fragment && !fragment.startsWith('#/')
              ? (resourceIds.get(uri.href) ?? resolved.slot.id) + fragment
              : resolved.ref;
        } else output[key] = convert(child, base, contractChildRole(role, key), dialect);
      }
      return output;
    };
    const value = convert(slot.schema, slot.document, 'structure', slot.dialect);
    if (typeof value === 'boolean') return { $id: slot.id, $schema: slot.dialect, allOf: [value] };
    const entry = object(value)!;
    if (entry['$id'])
      return {
        $id: slot.id,
        $schema: slot.dialect,
        $ref: String(entry['$id']),
        [legacySchemaDialect(slot.dialect) ? 'definitions' : '$defs']: { captured: entry },
      };
    return {
      ...entry,
      $id: slot.id,
      ...(slot.dialect === 'openapi3.0' ? {} : { $schema: entry['$schema'] ?? slot.dialect }),
    };
  });
  const contexts: ValidationGraph['contexts'] = Object.create(null);
  const at = (location: Location): unknown => {
    let value = documents.get(location.document);
    for (const part of location.pointer ? location.pointer.slice(1).split('/') : [])
      value = Array.isArray(value)
        ? value[Number(part)]
        : object(value)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return value;
  };
  const resolve = (location: Location): Location => {
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const node = object(at(location)),
        ref = node?.['$ref'];
      if (typeof ref !== 'string') return location;
      const identity = JSON.stringify(location);
      if (seen.has(identity)) throw new Error('cyclic operation reference');
      seen.add(identity);
      location = locate(new URL(ref, location.document).href);
    }
    throw new Error('operation reference depth exceeded');
  };
  const child = (parent: Location, key: string) =>
    resolve({ document: parent.document, pointer: parent.pointer + '/' + pointerEscape(key) });
  const paths = child({ document: rootUrl, pointer: '' }, 'paths');
  for (const path of Object.keys(object(at(paths)) ?? {})) {
    const item = child(paths, path);
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const operation = child(item, method);
      if (!object(at(operation))) continue;
      const request = child(operation, 'requestBody');
      const responses = child(operation, 'responses');
      const containers = [
        { location: request, direction: 'request', status: '' },
        ...Object.keys(object(at(responses)) ?? {}).map((status) => ({
          location: child(responses, status),
          direction: 'response',
          status,
        })),
      ];
      for (const { location, direction, status } of containers) {
        const content = child(location, 'content');
        for (const media of Object.keys(object(at(content)) ?? {})) {
          const schemaLocation = {
            document: content.document,
            pointer: content.pointer + '/' + pointerEscape(media) + '/schema',
          };
          if (at(schemaLocation) === undefined) continue;
          const resolved = target(schemaLocation.document + '#' + schemaLocation.pointer);
          contexts[JSON.stringify([path, method, direction, media, status])] = {
            schema: { $ref: resolved.ref },
            dialect: resolved.slot.dialect,
          };
        }
      }
    }
  }
  const rootSlot = slots.find((slot) => slot.document === rootUrl && slot.pointer === '');
  return {
    version: 1,
    resources,
    contexts,
    ...(rootSlot ? { rootSchema: { $ref: rootSlot.id } } : {}),
  };
}
