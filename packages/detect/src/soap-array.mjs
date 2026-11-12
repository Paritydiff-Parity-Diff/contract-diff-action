export function soapArrayModel(node, encoding, qname, children, fail, member = false) {
  const modern = encoding === 'http://www.w3.org/2003/05/soap-encoding';
  const kind = node.getAttributeNS(encoding, 'nodeType');
  const text = Array.from(node.childNodes).some(
    (child) => [3, 4].includes(child.nodeType) && child.nodeValue.trim(),
  );
  const fields = new Set(
    Array.from(node.attributes)
      .filter((attribute) => attribute.namespaceURI === encoding)
      .map((attribute) => attribute.localName),
  );
  const allowed = modern
    ? ['id', 'ref', 'nodeType', 'arraySize', 'itemType']
    : ['root', 'arrayType', 'offset', 'position'];
  if ([...fields].some((field) => !allowed.includes(field)))
    fail('soap_encoding_attribute_unavailable', false);
  if (fields.has('nodeType') && (!modern || !['simple', 'struct', 'array'].includes(kind)))
    fail('soap_encoded_node_type_invalid');
  const resolveType = (value) => {
    try {
      return qname(node, value);
    } catch {
      fail('soap_encoded_type_name_invalid');
    }
  };
  const array = modern
    ? kind === 'array' || fields.has('arraySize') || fields.has('itemType')
    : fields.has('arrayType');
  if (
    (kind === 'simple' && children.length) ||
    (array && kind && kind !== 'array') ||
    ((array || kind === 'struct') && text)
  )
    fail('soap_encoded_node_shape_invalid');
  if (kind === 'struct') {
    const names = children.map((child) => '{' + (child.namespaceURI ?? '') + '}' + child.localName);
    if (new Set(names).size !== names.length) fail('soap_encoded_struct_edges_invalid');
  }
  if (!array) {
    if (!modern && !member && (fields.has('offset') || fields.has('position')))
      fail('soap_encoded_position_without_array');
    return undefined;
  }
  if (!modern && fields.has('position') && !member) fail('soap_encoded_position_without_array');
  let typeName,
    ranks = [],
    dimensions;
  if (modern) {
    if (fields.has('itemType'))
      typeName = resolveType(node.getAttributeNS(encoding, 'itemType').trim());
    const value = fields.has('arraySize') ? node.getAttributeNS(encoding, 'arraySize').trim() : '*';
    if (!/^(?:\*|[0-9]+)(?:[ \t\r\n]+[0-9]+)*$/.test(value))
      fail('soap_encoded_array_size_invalid');
    dimensions = value.split(/[ \t\r\n]+/);
  } else {
    const value = node.getAttributeNS(encoding, 'arrayType').trim();
    const match = /^([^[]+)((?:\[[, \t\r\n]*\])*)\[([0-9, \t\r\n]*)\]$/.exec(value);
    if (!match) fail('soap_encoded_array_type_invalid');
    typeName = resolveType(match[1].trim());
    ranks = [...match[2].matchAll(/\[([, \t\r\n]*)\]/g)].map(
      (rank) => (rank[1].match(/,/g) ?? []).length + 1,
    );
    const sizes = match[3].trim();
    if (sizes && !/^[0-9]+(?:[ \t\r\n]*,[ \t\r\n]*[0-9]+)*$/.test(sizes))
      fail('soap_encoded_array_size_invalid');
    dimensions = sizes ? sizes.split(',').map((size) => size.trim()) : ['*'];
  }
  if (dimensions.length > 32 || ranks.length > 32 || dimensions.some((value) => value.length > 128))
    fail('soap_encoded_array_dimension_limit', false);
  if (!modern) {
    const extents = dimensions.map((value) => (value === '*' ? undefined : BigInt(value)));
    const point = (value) => {
      if (!/^\[[ \t\r\n]*[0-9]+(?:[ \t\r\n]*,[ \t\r\n]*[0-9]+)*[ \t\r\n]*\]$/.test(value))
        fail('soap_encoded_array_position_invalid');
      const coordinates = value
        .slice(1, -1)
        .split(',')
        .map((coordinate) => coordinate.trim());
      if (
        coordinates.length !== dimensions.length ||
        coordinates.some((coordinate) => coordinate.length > 128)
      )
        fail('soap_encoded_array_position_invalid');
      const values = coordinates.map((coordinate) => BigInt(coordinate));
      if (
        values.some(
          (coordinate, index) => extents[index] !== undefined && coordinate >= extents[index],
        )
      )
        fail('soap_encoded_array_position_outside_shape');
      return values;
    };
    let next = fields.has('offset')
      ? point(node.getAttributeNS(encoding, 'offset'))
      : dimensions.map(() => 0n);
    const seen = new Set();
    let previous;
    for (const child of children) {
      const position =
        child.getAttributeNS(encoding, 'position') ||
        (!child.hasAttributeNS(encoding, 'arrayType')
          ? child.getAttributeNS(encoding, 'offset')
          : undefined);
      const coordinates = position ? point(position) : [...next];
      if (
        coordinates.some(
          (coordinate, index) => extents[index] !== undefined && coordinate >= extents[index],
        )
      )
        fail('soap_encoded_array_position_outside_shape');
      const key = coordinates.join(',');
      if (seen.has(key)) fail('soap_encoded_array_position_duplicate');
      seen.add(key);
      if (previous) {
        const changed = coordinates.findIndex(
          (coordinate, index) => coordinate !== previous[index],
        );
        if (changed >= 0 && coordinates[changed] < previous[changed])
          fail('soap_encoded_array_position_order_invalid');
      }
      previous = coordinates;
      next = [...coordinates];
      for (let index = next.length - 1; index >= 0; index--) {
        next[index]++;
        if (extents[index] === undefined || next[index] < extents[index] || index === 0) break;
        next[index] = 0n;
      }
    }
  }
  return { typeName, ranks, dimensions, modern };
}
