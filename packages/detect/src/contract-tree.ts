export type ContractObject = Record<string, unknown>;
import { legacySchemaDialect } from '@paritydiff/core';
export function contractDialect(
  input: unknown,
  inherited = 'https://json-schema.org/draft/2020-12/schema',
): string {
  const node = object(input);
  return typeof node?.['$schema'] === 'string'
    ? node['$schema']
    : typeof node?.['jsonSchemaDialect'] === 'string'
      ? node['jsonSchemaDialect']
      : String(node?.['openapi']).startsWith('3.0') || node?.['swagger'] === '2.0'
        ? 'openapi3.0'
        : inherited;
}
export function contractResourceId(node: ContractObject, dialect: string): string | undefined {
  return typeof node['$id'] === 'string' &&
    !(
      typeof node['$ref'] === 'string' &&
      (dialect === 'openapi3.0' || legacySchemaDialect(dialect))
    )
    ? node['$id']
    : undefined;
}
export const object = (value: unknown): ContractObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ContractObject)
    : undefined;
const memberMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'schemas',
  'paths',
  'responses',
  'headers',
  'content',
  'examples',
  'requestBodies',
  'securitySchemes',
  'callbacks',
  'links',
  'pathItems',
  'webhooks',
  'dependentSchemas',
  'dependencies',
  'dependentRequired',
  'messages',
  'channels',
  'operations',
  'replies',
]);
const literals = new Set(['example', 'default', 'enum', 'const', 'value']);
export type ContractRole = 'structure' | 'members' | 'literal';
export function contractChildRole(role: ContractRole, key: string): ContractRole {
  if (role === 'literal') return 'literal';
  if (role === 'members') return 'structure';
  if (literals.has(key) || key.startsWith('x-')) return 'literal';
  return memberMaps.has(key) ? 'members' : 'structure';
}

export function visitContract(
  input: unknown,
  visit: (node: ContractObject, pointer: string, resource: unknown) => void,
): void {
  const stack = [
    {
      value: input,
      pointer: '',
      members: false,
      depth: 0,
      resource: input,
      dialect: contractDialect(input),
    },
  ];
  let count = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > 200000 || item.depth > 128) throw new Error('contract_tree_limit');
    if (Array.isArray(item.value)) {
      item.value.forEach((value, index) =>
        stack.push({ ...item, value, pointer: item.pointer + '/' + index, depth: item.depth + 1 }),
      );
      continue;
    }
    const node = object(item.value);
    if (!node) continue;
    const dialect = item.members ? item.dialect : contractDialect(node, item.dialect);
    const resource =
      !item.members && contractResourceId(node, dialect) !== undefined ? node : item.resource;
    if (!item.members) visit(node, item.pointer, resource);
    for (const [key, value] of Object.entries(node)) {
      if (!item.members && (literals.has(key) || key.startsWith('x-'))) continue;
      stack.push({
        value,
        pointer: item.pointer + '/' + pointerEscape(key),
        members: !item.members && memberMaps.has(key),
        depth: item.depth + 1,
        resource,
        dialect,
      });
    }
  }
}
export const pointerEscape = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
export const pointerFragment = (pointer: string): string =>
  pointer.split('/').map(encodeURIComponent).join('/');

export function resolveLocalReference(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (ref.startsWith('#/')) {
    let current = root;
    let decoded: string;
    try {
      decoded = decodeURIComponent(ref.slice(1));
    } catch {
      return undefined;
    }
    for (const encoded of decoded.slice(1).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
      current = (current as ContractObject)[key];
    }
    return current;
  }
  if (!ref.startsWith('#')) return undefined;
  let found: unknown;
  visitContract(root, (node, _pointer, resource) => {
    if (resource === root && '#' + node['$anchor'] === ref) found = node;
  });
  return found;
}
