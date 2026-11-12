import { object, resolveLocalReference, visitContract } from './contract-tree';

export function validateOpenApiSemantics(doc: unknown): readonly string[] {
  const root = object(doc);
  if (!root) return ['document must be an object'];
  const errors: string[] = [];
  visitContract(doc, (node, pointer, resource) => {
    const ref = node['$ref'];
    if (
      typeof ref === 'string' &&
      ref.startsWith('#') &&
      resolveLocalReference(resource, ref) === undefined
    )
      errors.push(pointer + ': unresolved local reference');
  });
  const operationIds = new Set<string>();
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query'];
  for (const [path, raw] of Object.entries(object(root['paths']) ?? {})) {
    if (path.startsWith('x-')) continue;
    const item = object(raw);
    if (!item) continue;
    for (const method of methods) {
      const op = object(item[method]);
      if (!op) continue;
      if (typeof op['operationId'] === 'string') {
        if (operationIds.has(op['operationId'])) errors.push(path + ': duplicate operationId');
        operationIds.add(op['operationId']);
      }
      const inherited = Array.isArray(item['parameters']) ? item['parameters'] : [];
      const local = Array.isArray(op['parameters']) ? op['parameters'] : [];
      const parameters = [...inherited, ...local].map((value) => {
        const param = object(value);
        return typeof param?.['$ref'] === 'string'
          ? object(resolveLocalReference(doc, param['$ref']))
          : param;
      });
      const unresolvedExternal = [...inherited, ...local].some((value) => {
        const ref = object(value)?.['$ref'];
        return typeof ref === 'string' && !ref.startsWith('#');
      });
      const duplicate = new Set<string>();
      for (const value of local) {
        const param = object(value);
        if (!param || param['$ref']) continue;
        const key = param['in'] + ':' + param['name'];
        if (duplicate.has(key)) errors.push(path + ': duplicate operation parameter');
        duplicate.add(key);
      }
      for (const name of [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]))
        if (
          !unresolvedExternal &&
          !parameters.some(
            (p) => p?.['in'] === 'path' && p['name'] === name && p['required'] === true,
          )
        )
          errors.push(path + ': missing required path parameter ' + name);
    }
  }
  return errors.slice(0, 25);
}
