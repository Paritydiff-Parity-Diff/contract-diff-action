import { XMLSerializer } from './xml11.mjs';
import { soapArrayModel } from './soap-array.mjs';
import { xmlNcName } from '../../core/src/xml-names.mjs';
export function decodeSoapEncoded(body, envelope, binding, completeNamespaces, qname) {
  const encoding =
    envelope === 'http://schemas.xmlsoap.org/soap/envelope/'
      ? 'http://schemas.xmlsoap.org/soap/encoding/'
      : 'http://www.w3.org/2003/05/soap-encoding';
  const elements = (node) => Array.from(node.childNodes).filter((child) => child.nodeType === 1);
  const ids = new Map(),
    used = new Set(),
    typeChecks = [];
  const graphNamespace = 'urn:paritydiff:encoded-graph';
  const cores = new Map(),
    graphEdges = [];
  const failure = (reason, available = true) => {
    const error = new Error(reason);
    error.available = available;
    throw error;
  };
  const reference = (node) =>
    envelope === 'http://schemas.xmlsoap.org/soap/envelope/'
      ? node.getAttribute('href')
      : node.getAttributeNS(encoding, 'ref');
  const identifier = (node) =>
    envelope === 'http://schemas.xmlsoap.org/soap/envelope/'
      ? node.getAttribute('id')
      : node.getAttributeNS(encoding, 'id');
  let visited = 0;
  const scan = (node, depth = 0) => {
    if (++visited > 100000 || depth > 100) failure('soap_encoded_graph_limit', false);
    const id = identifier(node),
      ref = reference(node);
    const modern = envelope !== 'http://schemas.xmlsoap.org/soap/envelope/';
    if ((modern ? node.hasAttributeNS(encoding, 'id') : node.hasAttribute('id')) && !id)
      failure('soap_encoded_identity_invalid');
    if ((modern ? node.hasAttributeNS(encoding, 'ref') : node.hasAttribute('href')) && !ref)
      failure('soap_encoded_reference_invalid');
    if (id && (!xmlNcName.test(id) || ids.has(id) || ref)) failure('soap_encoded_identity_invalid');
    if (id) ids.set(id, node);
    for (const attribute of Array.from(node.attributes)) {
      if (
        attribute.namespaceURI === encoding &&
        !(
          modern
            ? ['id', 'ref', 'nodeType', 'arraySize', 'itemType']
            : ['root', 'arrayType', 'offset', 'position']
        ).includes(attribute.localName)
      )
        failure('soap_encoding_attribute_unavailable', false);
      if (
        attribute.namespaceURI === graphNamespace ||
        (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' &&
          attribute.value === graphNamespace)
      )
        failure('soap_encoded_private_metadata_invalid');
      if (
        attribute.namespaceURI === envelope &&
        attribute.localName === 'encodingStyle' &&
        attribute.value.trim() !== encoding
      )
        failure('soap_encoding_unavailable', false);
    }
    for (const child of elements(node)) scan(child, depth + 1);
  };
  scan(body);
  for (let parent = body; parent?.nodeType === 1; parent = parent.parentNode)
    if (
      parent.hasAttributeNS(envelope, 'encodingStyle') &&
      parent.getAttributeNS(envelope, 'encodingStyle').trim() !== encoding
    )
      failure('soap_encoding_unavailable', false);
  if (binding.encodingStyle !== encoding) failure('soap_encoding_unavailable', false);
  const roots = [];
  for (const name of binding.elements) {
    const matches = elements(body).filter(
      (node) => '{' + (node.namespaceURI ?? '') + '}' + node.localName === name,
    );
    if (matches.length !== 1) failure('soap_encoded_root_ambiguous', false);
    roots.push(matches[0]);
  }
  const metadata = (attribute) =>
    (attribute.namespaceURI === envelope && attribute.localName === 'encodingStyle') ||
    (attribute.namespaceURI === encoding && ['id', 'ref', 'root'].includes(attribute.localName)) ||
    (!attribute.namespaceURI &&
      envelope === 'http://schemas.xmlsoap.org/soap/envelope/' &&
      ['id', 'href'].includes(attribute.localName));
  visited = 0;
  const materialize = (node, seen = new Set(), depth = 0, member = false) => {
    if (++visited > 100000 || depth > 100) failure('soap_encoded_expansion_limit', false);
    if (seen.has(node)) failure('soap_encoded_cycle_needs_graph_validator', false);
    const ref = reference(node);
    let source = node;
    if (ref) {
      const name =
        envelope === 'http://schemas.xmlsoap.org/soap/envelope/'
          ? ref.startsWith('#') && xmlNcName.test(ref.slice(1))
            ? ref.slice(1)
            : undefined
          : xmlNcName.test(ref)
            ? ref
            : undefined;
      if (
        !name ||
        !ids.has(name) ||
        elements(node).length ||
        Array.from(node.childNodes).some(
          (child) => [3, 4].includes(child.nodeType) && child.nodeValue.trim(),
        )
      )
        failure('soap_encoded_reference_invalid');
      source = ids.get(name);
      if (!node.prefix && !node.namespaceURI && (source.lookupNamespaceURI(null) ?? ''))
        failure('soap_encoded_namespace_context_unavailable', false);
      used.add(name);
    }
    const model = soapArrayModel(source, encoding, qname, elements(source), failure, member);
    const snapshot = completeNamespaces(source);
    let edgeName = node.tagName;
    if (
      ref &&
      node.namespaceURI &&
      (source.lookupNamespaceURI(node.prefix || null) ?? '') !== node.namespaceURI
    ) {
      let prefix = '__pd_edge',
        attempts = 0;
      while (source.lookupNamespaceURI(prefix) || node.lookupNamespaceURI(prefix)) {
        if (++attempts > 128) failure('soap_encoded_namespace_limit', false);
        prefix += '_';
      }
      edgeName = prefix + ':' + node.localName;
    }
    const clone = node.ownerDocument.createElementNS(node.namespaceURI, edgeName);
    for (const attribute of Array.from(snapshot.attributes))
      if (
        !metadata(attribute) &&
        !(
          ref &&
          attribute.namespaceURI === encoding &&
          (attribute.localName === 'position' || (!model && attribute.localName === 'offset'))
        )
      )
        clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    if (edgeName !== node.tagName)
      clone.setAttributeNS(
        'http://www.w3.org/2000/xmlns/',
        'xmlns:' + edgeName.split(':')[0],
        node.namespaceURI,
      );
    for (const attribute of Array.from(completeNamespaces(node).attributes))
      if (
        !metadata(attribute) &&
        !clone.hasAttributeNS(attribute.namespaceURI, attribute.localName)
      )
        clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    if (ref) {
      const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
      const accessor = node.getAttributeNS(xsi, 'type'),
        target = source.getAttributeNS(xsi, 'type');
      if (accessor && target && qname(node, accessor) !== qname(source, target)) {
        if (typeChecks.length >= 1000) failure('soap_encoded_type_check_limit', false);
        typeChecks.push({ typeName: qname(node, accessor), actualTypeName: qname(source, target) });
      }
      if (accessor && !target) {
        const resolved = /^\{([^}]*)\}(.*)$/.exec(qname(node, accessor));
        let prefix = '__pd_type';
        while (clone.lookupNamespaceURI(prefix)) prefix += '_';
        if (resolved[1])
          clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:' + prefix, resolved[1]);
        else if (clone.lookupNamespaceURI(null))
          failure('soap_encoded_namespace_context_unavailable', false);
        clone.setAttributeNS(xsi, 'xsi:type', (resolved[1] ? prefix + ':' : '') + resolved[2]);
        clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xsi', xsi);
      }
      const nil = node.getAttributeNS(xsi, 'nil');
      if (
        nil &&
        (!['true', 'false', '1', '0'].includes(nil) ||
          ['true', '1'].includes(nil) !== ['true', '1'].includes(source.getAttributeNS(xsi, 'nil')))
      )
        failure('soap_encoded_nil_reference_invalid');
    }
    if (seen.has(source)) {
      if (graphEdges.length >= 1000) failure('soap_encoded_graph_edge_limit', false);
      const id = 'g' + graphEdges.length;
      graphEdges.push({ id, source, stub: clone });
      let prefix = '__pd_graph';
      while (source.lookupNamespaceURI(prefix) || node.lookupNamespaceURI(prefix)) prefix += '_';
      clone.setAttributeNS(graphNamespace, prefix + ':ref', id);
      clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:' + prefix, graphNamespace);
      return clone;
    }
    if (!cores.has(source)) cores.set(source, clone);
    const ancestors = new Set([...seen, node, source]);
    for (const child of Array.from(source.childNodes))
      clone.appendChild(
        child.nodeType === 1
          ? materialize(child, ancestors, depth + 1, Boolean(model))
          : child.cloneNode(true),
      );
    const checkType = (element, typeName, actualTypeName) => {
      if (typeChecks.length >= 1000) failure('soap_encoded_type_check_limit', false);
      const value = element.cloneNode(true);
      for (const attribute of Array.from(value.attributes))
        if (metadata(attribute)) value.removeAttributeNode(attribute);
      typeChecks.push({
        typeName,
        payload: new XMLSerializer().serializeToString(value),
        ...(actualTypeName ? { actualTypeName } : {}),
      });
    };
    if (model) {
      if (model.typeName) {
        if (typeChecks.length >= 1000) failure('soap_encoded_type_check_limit', false);
        typeChecks.push({ typeName: model.typeName });
      }
      for (const child of elements(clone)) {
        const nil = child.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil');
        if (nil && !['true', 'false', '1', '0'].includes(nil)) failure('soap_encoded_nil_invalid');
        if (['true', '1'].includes(nil)) {
          if (elements(child).length || child.textContent.trim())
            failure('soap_encoded_nil_content_invalid');
          continue;
        }
        if (model.ranks.length) {
          const nested = soapArrayModel(child, encoding, qname, elements(child), failure, true);
          if (
            !nested ||
            nested.dimensions.length !== model.ranks.at(-1) ||
            JSON.stringify(nested.ranks) !== JSON.stringify(model.ranks.slice(0, -1))
          )
            failure('soap_encoded_nested_array_rank_invalid');
          const leaves = (value) => {
            const array = soapArrayModel(value, encoding, qname, elements(value), failure, true);
            if (array?.ranks.length) for (const member of elements(value)) leaves(member);
            else
              for (const member of elements(value))
                checkType(member, model.typeName, array?.typeName);
          };
          leaves(child);
        } else if (model.typeName) {
          const actual = child.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
          checkType(child, model.typeName, actual ? qname(child, actual) : undefined);
        }
      }
    }
    return clone;
  };
  const output = roots.map((root) => materialize(root));
  for (const node of elements(body))
    if (!roots.includes(node) && (!identifier(node) || !used.has(identifier(node))))
      failure('soap_encoded_unbound_body_node');
  if (
    output.reduce(
      (bytes, node) => bytes + Buffer.byteLength(new XMLSerializer().serializeToString(node)),
      0,
    ) >
    1024 * 1024
  )
    failure('soap_encoded_expansion_limit', false);
  const graphReferences = Object.create(null);
  for (const { id, source, stub } of graphEdges) {
    const core = cores.get(source);
    if (!core) failure('soap_encoded_graph_definition_unavailable', false);
    const definition = stub.cloneNode(false);
    definition.removeAttributeNS(graphNamespace, 'ref');
    for (const child of Array.from(core.childNodes)) definition.appendChild(child.cloneNode(true));
    graphReferences[id] = new XMLSerializer().serializeToString(definition);
  }
  if (Buffer.byteLength(JSON.stringify(graphReferences)) > 1024 * 1024)
    failure('soap_encoded_graph_definition_limit', false);
  return { elements: output, typeChecks, graphReferences };
}
