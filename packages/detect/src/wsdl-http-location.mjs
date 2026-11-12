const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
export function replacementValues(binding, transport) {
  const names = [],
    marker = 'PARITYDIFF' + binding.path.length + 'TOKEN';
  if (binding.location.includes(marker))
    throw unavailable('wsdl_http_replacement_context_unavailable');
  const template = binding.location.replace(/\(([^()]*)\)/g, (_match, name) => {
    if (!binding.parts.some((part) => part.name === name))
      throw unavailable('wsdl_http_replacement_part_unbound');
    names.push(name);
    return marker + (names.length - 1) + 'END';
  });
  if (
    /[()]/.test(template) ||
    names.length > 64 ||
    binding.parts.some((part) => !names.includes(part.name))
  )
    throw unavailable('wsdl_http_replacement_context_unavailable');
  const actual = transport.origin + transport.path + transport.search,
    results = new Map();
  let nodes = 0;
  for (const address of binding.addresses) {
    const uri = new URL(template, address).href;
    const pieces = uri.split(new RegExp(marker + '[0-9]+END', 'g'));
    if (pieces.length !== names.length + 1 || !actual.startsWith(pieces[0])) continue;
    const visit = (index, position, values) => {
      if (++nodes > 1024) throw unavailable('wsdl_http_replacement_resource_limit');
      if (index === names.length) {
        if (position === actual.length) {
          const key = JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b)));
          results.set(key, values);
        }
        return;
      }
      const literal = pieces[index + 1];
      const last = index === names.length - 1;
      let end = last
        ? actual.endsWith(literal)
          ? actual.length - literal.length
          : -1
        : literal
          ? actual.indexOf(literal, position)
          : position;
      while (end >= 0 && end <= actual.length) {
        let value;
        try {
          value = decodeURIComponent(actual.slice(position, end));
        } catch {
          value = undefined;
        }
        if (
          value !== undefined &&
          (!values.has(names[index]) || values.get(names[index]) === value)
        ) {
          const next = new Map(values);
          next.set(names[index], value);
          visit(index + 1, end + literal.length, next);
          if (results.size > 1) throw unavailable('wsdl_http_replacement_ambiguous');
        }
        end = last ? -1 : literal ? actual.indexOf(literal, end + 1) : end + 1;
      }
    };
    visit(0, pieces[0].length, new Map());
  }
  if (!results.size) throw new Error('wsdl_http_operation_location_mismatch');
  return results.values().next().value;
}
