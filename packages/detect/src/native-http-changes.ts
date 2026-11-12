import { contentHash, type OasdiffChange } from '@paritydiff/core';
import { object } from './contract-tree';
type Binding = {
  bindingId: string;
  path: string;
  method: string;
  direction: string;
  location: string;
  addresses: string[];
};
function bindings(document: unknown): Binding[] {
  const root = object(document),
    values = root?.['x-paritydiff-wsdl-http-bindings'];
  if (root?.['x-paritydiff-source-format'] !== 'wsdl' || !Array.isArray(values)) return [];
  return values.filter((value): value is Binding => {
    const binding = object(value);
    return Boolean(
      binding &&
      ['bindingId', 'path', 'method', 'direction', 'location'].every(
        (key) => typeof binding[key] === 'string',
      ) &&
      Array.isArray(binding['addresses']) &&
      binding['addresses'].every((address) => typeof address === 'string'),
    );
  });
}
function targets(binding: Binding): string[] | undefined {
  try {
    return [
      ...new Set(
        binding.addresses.map((address) => {
          const uri = new URL(binding.location, address);
          if (
            !['http:', 'https:'].includes(uri.protocol) ||
            uri.username ||
            uri.password ||
            uri.hash
          )
            throw new Error('native_http_address_unavailable');
          return uri.href.replace(/%([0-9a-f]{2})/gi, (_escape, pair: string) => {
            const character = String.fromCharCode(parseInt(pair, 16));
            return /^[a-z0-9._~-]$/i.test(character) ? character : '%' + pair.toUpperCase();
          });
        }),
      ),
    ].sort();
  } catch {
    return undefined;
  }
}
export function nativeHttpChanges(before: unknown, after: unknown): OasdiffChange[] {
  const output: OasdiffChange[] = [],
    old = bindings(before),
    next = bindings(after);
  const identity = (binding: Binding) =>
    JSON.stringify([binding.bindingId, binding.path, binding.direction]);
  for (const previous of old.filter((binding) => binding.direction === 'input')) {
    const earlier = old.filter((binding) => identity(binding) === identity(previous)),
      candidates = next.filter((binding) => identity(binding) === identity(previous));
    if (earlier.length !== 1 || candidates.length !== 1) continue;
    const current = candidates[0]!;
    const emit = (id: string, field: string, from: unknown, to: unknown) =>
      output.push({
        id,
        path: previous.path,
        operation: 'POST',
        fieldPath: '/native-binding/' + field,
        level: 3,
        text:
          'Declared native HTTP ' +
          field +
          ' changed: ' +
          JSON.stringify(from) +
          ' -> ' +
          JSON.stringify(to),
        fingerprint: contentHash(id, identity(previous), from, to),
      });
    if (previous.method !== current.method)
      emit('native-http-method-changed', 'method', previous.method, current.method);
    const from = targets(previous),
      to = targets(current);
    if (from?.length && to?.length && from.some((target) => !to.includes(target)))
      emit('native-http-location-removed', 'location', from, to);
  }
  return output;
}
