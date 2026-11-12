import { DOMParser, XMLSerializer, validateSoapXml } from './xml11.mjs';
import { createHash } from 'node:crypto';
import { readSoapFault } from './soap-fault.mjs';
import { wsdl2Bindings } from './wsdl2-binding.mjs';
import { decodeSoapEncoded } from './soap-encoded.mjs';
import { xmlQName, xmlNcName } from '../../core/src/xml-names.mjs';
import { resolveWsdlOperation } from './wsdl-operation.mjs';
import { extractWsdlHttpBindings } from './wsdl-http.mjs';
import { extractSoapMimeBindings } from './soap-mime.mjs';
const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const MIME = WSDL + 'mime/';
const mimeExtensions = new Set(
  ['content', 'mimeXml', 'multipartRelated', 'part'].map((name) => MIME + '#' + name),
);
const envelopes = [
  'http://schemas.xmlsoap.org/soap/envelope/',
  'http://www.w3.org/2003/05/soap-envelope',
];
const children = (node, ns, name) =>
  Array.from(node.childNodes ?? []).filter(
    (child) =>
      child.nodeType === 1 && child.namespaceURI === ns && (!name || child.localName === name),
  );
function parse(source) {
  if (typeof source !== 'string' || /<!\s*(DOCTYPE|ENTITY)\b/i.test(source))
    throw new Error('xml_source_rejected');
  return new DOMParser({
    onError() {
      throw new Error('invalid_xml');
    },
  }).parseFromString(source, 'application/xml');
}
function qname(node, text) {
  text = typeof text === 'string' ? text.trim() : text;
  if (!text || !xmlQName.test(text)) throw new Error('invalid_xml_qname');
  const split = text.split(':');
  const namespace = node.lookupNamespaceURI(split.length === 2 ? split[0] : null) ?? '';
  if (split.length === 2 && !namespace) throw new Error('unbound_xml_prefix');
  return '{' + namespace + '}' + split.at(-1);
}
function completeNamespaces(node) {
  const clone = node.cloneNode(true),
    seen = new Set(Array.from(clone.attributes).map((attribute) => attribute.name));
  for (let parent = node.parentNode; parent?.nodeType === 1; parent = parent.parentNode)
    for (const attribute of Array.from(parent.attributes))
      if (
        (attribute.name === 'xmlns' || attribute.prefix === 'xmlns') &&
        !seen.has(attribute.name)
      ) {
        clone.setAttributeNS('http://www.w3.org/2000/xmlns/', attribute.name, attribute.value);
        seen.add(attribute.name);
      }
  return clone;
}
function requiredExtensions(nodes, additional = new Set()) {
  const missing = new Set();
  const inspect = (node) => {
    if (
      node.nodeType !== 1 ||
      (node.namespaceURI === WSDL && node.localName === 'documentation') ||
      (node.namespaceURI === XSD && node.localName === 'schema')
    )
      return;
    if (node.hasAttributeNS(WSDL, 'required')) {
      const value = node.getAttributeNS(WSDL, 'required').trim();
      if (!['true', 'false', '1', '0'].includes(value))
        throw new Error('invalid_wsdl_extension_requirement');
      if (
        ['true', '1'].includes(value) &&
        !(
          ([SOAP11, SOAP12].includes(node.namespaceURI) &&
            ['binding', 'operation', 'body', 'header', 'fault', 'address'].includes(
              node.localName,
            )) ||
          additional.has(node.namespaceURI + '#' + node.localName)
        )
      )
        missing.add('{' + node.namespaceURI + '}' + node.localName);
    }
    for (const child of Array.from(node.childNodes)) inspect(child);
  };
  for (const node of nodes) inspect(node);
  return [...missing];
}
const extensions = (node) =>
  Array.from(node.childNodes).filter(
    (child) => child.nodeType === 1 && child.namespaceURI !== WSDL,
  );
export function extractSoapBindings(sources) {
  const documents = Object.entries(sources).map(([id, source]) => ({ id, doc: parse(source) }));
  const schemas = [],
    files = Object.create(null),
    messages = new Map(),
    portTypes = new Map(),
    bindings = [];
  for (const { id, doc } of documents) {
    const roots = Array.from(doc.getElementsByTagNameNS(XSD, 'schema'));
    for (let index = 0; index < roots.length; index++) {
      const node = completeNamespaces(roots[index]),
        filename = doc.documentElement === roots[index] ? id + '.xsd' : id + '-' + index + '.xsd';
      files[filename] = new XMLSerializer().serializeToString(node);
      schemas.push({
        file: filename,
        namespace: node.getAttribute('targetNamespace') || '',
        dialect:
          node.getAttributeNS('http://www.w3.org/2007/XMLSchema-versioning', 'minVersion') === '1.1'
            ? '1.1'
            : undefined,
      });
    }
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'definitions') continue;
    const namespace = root.getAttribute('targetNamespace') || '';
    for (const message of children(root, WSDL, 'message')) {
      const id = '{' + namespace + '}' + message.getAttribute('name');
      if (messages.has(id)) throw new Error('duplicate_wsdl_message');
      const names = new Set();
      for (const part of children(message, WSDL, 'part')) {
        const name = part.getAttribute('name');
        if (
          !name ||
          !xmlNcName.test('_' + name.replace(/:/g, '_')) ||
          names.has(name) ||
          Boolean(part.getAttribute('type')) === Boolean(part.getAttribute('element'))
        )
          throw new Error('invalid_wsdl_message_part');
        names.add(name);
        qname(part, part.getAttribute('type') || part.getAttribute('element'));
      }
      messages.set(id, message);
    }
    for (const port of children(root, WSDL, 'portType')) {
      const id = '{' + namespace + '}' + port.getAttribute('name');
      if (portTypes.has(id)) throw new Error('duplicate_wsdl_port_type');
      portTypes.set(id, port);
    }
  }
  const namespaces = new Map();
  for (const schema of schemas)
    namespaces.set(schema.namespace, [...(namespaces.get(schema.namespace) ?? []), schema]);
  for (const [namespace, members] of namespaces) {
    const doc = parse('<xs:schema xmlns:xs="' + XSD + '"/>');
    if (namespace) doc.documentElement.setAttribute('targetNamespace', namespace);
    for (const member of members) {
      const included = doc.createElementNS(XSD, 'xs:include');
      included.setAttribute('schemaLocation', member.file);
      doc.documentElement.appendChild(included);
      member.member = true;
    }
    const file =
      'namespace-' + createHash('sha256').update(namespace).digest('hex').slice(0, 20) + '.xsd';
    files[file] = new XMLSerializer().serializeToString(doc);
    schemas.push({
      file,
      namespace,
      dialect: members.some((member) => member.dialect === '1.1') ? '1.1' : undefined,
    });
  }
  for (const { doc } of documents) {
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'definitions') continue;
    for (const binding of children(root, WSDL, 'binding')) {
      const soap =
        children(binding, SOAP11, 'binding')[0] ?? children(binding, SOAP12, 'binding')[0];
      if (!soap) continue;
      const port = portTypes.get(qname(binding, binding.getAttribute('type')));
      if (!port) throw new Error('unresolved_wsdl_port_type');
      const bindingId =
        '{' + (root.getAttribute('targetNamespace') || '') + '}' + binding.getAttribute('name');
      const boundOperations = new Set();
      for (const operation of children(binding, WSDL, 'operation')) {
        const name = operation.getAttribute('name');
        const resolved = resolveWsdlOperation(port, operation, children);
        if (boundOperations.has(resolved.node)) throw new Error('duplicate_wsdl_operation_binding');
        boundOperations.add(resolved.node);
        const matches = [resolved.node];
        const unavailableExtensions = requiredExtensions(
          [...extensions(root), ...extensions(binding), ...extensions(port), operation, matches[0]],
          mimeExtensions,
        );
        const transport = soap.getAttribute('transport');
        const transportSupported = transport === 'http://schemas.xmlsoap.org/soap/http';
        const soapOperation = children(operation, soap.namespaceURI, 'operation')[0];
        const style =
          soapOperation?.getAttribute('style') || soap.getAttribute('style') || 'document';
        for (const direction of ['input', 'output']) {
          const io = children(operation, WSDL, direction)[0],
            abstract = children(matches[0], WSDL, direction)[0];
          if (!io && !abstract) continue;
          const multipart = io && children(io, MIME, 'multipartRelated').length > 0;
          const nestedBodies = multipart
            ? Array.from(io.getElementsByTagNameNS(soap.namespaceURI, 'body'))
            : [];
          const body =
            io &&
            (children(io, soap.namespaceURI, 'body')[0] ??
              (nestedBodies.length === 1 ? nestedBodies[0] : undefined));
          const headers = io
            ? [
                ...new Set([
                  ...children(io, soap.namespaceURI, 'header'),
                  ...(multipart && body?.parentNode
                    ? children(body.parentNode, soap.namespaceURI, 'header')
                    : []),
                ]),
              ]
            : [];
          const message =
            abstract && messages.get(qname(abstract, abstract.getAttribute('message')));
          const parts = message && children(message, WSDL, 'part');
          const selection = body?.getAttribute('parts')?.trim().split(/\s+/).filter(Boolean);
          const selected = parts?.filter(
            (part) => !selection || selection.includes(part.getAttribute('name')),
          );
          const elements = selected?.map((part) =>
            part.getAttribute('element') ? qname(part, part.getAttribute('element')) : undefined,
          );
          const headerElements = headers.map((header) => {
            const message = messages.get(qname(header, header.getAttribute('message')));
            const part =
              message &&
              children(message, WSDL, 'part').find(
                (part) => part.getAttribute('name') === header.getAttribute('part'),
              );
            return header.getAttribute('use') === 'literal' && part?.getAttribute('element')
              ? qname(part, part.getAttribute('element'))
              : undefined;
          });
          let rpc;
          if (
            style === 'rpc' &&
            ['literal', 'encoded'].includes(body?.getAttribute('use')) &&
            selected &&
            selected.every((part) => part.getAttribute('type')) &&
            body.getAttribute('namespace')
          ) {
            const namespace = body.getAttribute('namespace');
            const wrapper = name + (direction === 'output' ? 'Response' : '');
            let validationName = '__paritydiff_rpc_' + bindings.length;
            const declaredNames = new Set(
              schemas
                .filter((entry) => !entry.generated && entry.namespace === namespace)
                .flatMap((entry) =>
                  children(parse(files[entry.file]).documentElement, XSD, 'element').map(
                    (element) => element.getAttribute('name'),
                  ),
                ),
            );
            while (declaredNames.has(validationName)) validationName += '_';
            const schema = parse('<xs:schema xmlns:xs="' + XSD + '"/>');
            const root = schema.documentElement;
            root.setAttribute('targetNamespace', namespace);
            root.setAttribute('elementFormDefault', 'unqualified');
            const element = schema.createElementNS(XSD, 'xs:element');
            element.setAttribute('name', validationName);
            const complex = schema.createElementNS(XSD, 'xs:complexType');
            const sequence = schema.createElementNS(XSD, 'xs:sequence');
            root.appendChild(element).appendChild(complex).appendChild(sequence);
            const imports = new Map();
            const usedSchemas = [];
            for (const part of selected) {
              const type = qname(part, part.getAttribute('type'));
              const split = /^\{([^}]*)\}(.*)$/.exec(type);
              if (!split) throw new Error('invalid_rpc_type');
              const prefix = split[1] === XSD ? 'xs' : 't' + imports.size;
              if (split[1] !== XSD && !imports.has(split[1])) {
                const candidates = schemas.filter(
                  (entry) => !entry.generated && !entry.member && entry.namespace === split[1],
                );
                if (candidates.length !== 1) throw new Error('rpc_type_schema_unavailable');
                imports.set(split[1], prefix);
                usedSchemas.push(candidates[0]);
                root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:' + prefix, split[1]);
                const imported = schema.createElementNS(
                  XSD,
                  split[1] === namespace ? 'xs:include' : 'xs:import',
                );
                if (split[1] !== namespace) imported.setAttribute('namespace', split[1]);
                imported.setAttribute('schemaLocation', candidates[0].file);
                root.insertBefore(imported, element);
              }
              const field = schema.createElementNS(XSD, 'xs:element');
              field.setAttribute('name', part.getAttribute('name'));
              field.setAttribute('type', (imports.get(split[1]) ?? prefix) + ':' + split[2]);
              if (body.getAttribute('use') === 'encoded') field.setAttribute('nillable', 'true');
              sequence.appendChild(field);
            }
            if (body.getAttribute('use') === 'encoded')
              for (const captured of schemas.filter((entry) => !entry.generated && !entry.member)) {
                if (imports.has(captured.namespace) || captured.namespace === XSD) continue;
                imports.set(captured.namespace, 't' + imports.size);
                usedSchemas.push(captured);
                const included = schema.createElementNS(
                  XSD,
                  captured.namespace === namespace ? 'xs:include' : 'xs:import',
                );
                if (captured.namespace && captured.namespace !== namespace)
                  included.setAttribute('namespace', captured.namespace);
                included.setAttribute('schemaLocation', captured.file);
                root.insertBefore(included, element);
              }
            const dialect = usedSchemas.some((entry) => entry.dialect === '1.1')
              ? '1.1'
              : undefined;
            if (dialect)
              root.setAttributeNS(
                'http://www.w3.org/2007/XMLSchema-versioning',
                'vc:minVersion',
                dialect,
              );
            const file = 'rpc-' + bindings.length + '.xsd';
            files[file] = new XMLSerializer().serializeToString(schema);
            schemas.push({ file, namespace, generated: true, dialect });
            rpc = { file, element: '{' + namespace + '}' + wrapper, validationName };
          }
          const supported =
            ['literal', 'encoded'].includes(body?.getAttribute('use')) &&
            ((style === 'document' && selected && elements?.every(Boolean)) || rpc) &&
            headerElements.every(Boolean) &&
            (!selection || selection.length === selected.length);
          bindings.push({
            bindingId,
            name,
            path: resolved.path,
            messageLabels: resolved.labels,
            ...(resolved.overloaded ? { overloaded: true } : {}),
            direction,
            envelope: soap.namespaceURI === SOAP12 ? envelopes[1] : envelopes[0],
            action: soapOperation?.getAttribute('soapAction') || '',
            elements: rpc ? [rpc.element] : (elements?.filter(Boolean) ?? []),
            headerElements: headerElements.filter(Boolean),
            wireUse: body?.getAttribute('use'),
            encodingStyle: body?.getAttribute('encodingStyle'),
            transport,
            requiredExtensions: unavailableExtensions,
            ...(multipart ? { multipart: true } : {}),
            ...(!rpc && selected?.length === 0 ? { contentModel: '#none' } : {}),
            ...(rpc ? { rpcSchema: rpc.file, rpcValidationName: rpc.validationName } : {}),
            supported: Boolean(supported && transportSupported && !unavailableExtensions.length),
            reason: unavailableExtensions.length
              ? 'soap_required_extension_unavailable'
              : !transportSupported
                ? 'soap_transport_unavailable'
                : supported
                  ? style + '_' + body.getAttribute('use') + '_bound'
                  : 'soap_binding_needs_adapter',
          });
        }
        for (const fault of children(operation, WSDL, 'fault')) {
          const faultName = fault.getAttribute('name');
          const abstract = children(matches[0], WSDL, 'fault').find(
            (node) => node.getAttribute('name') === faultName,
          );
          const message =
            abstract && messages.get(qname(abstract, abstract.getAttribute('message')));
          const parts = message && children(message, WSDL, 'part');
          const soapFault = children(fault, soap.namespaceURI, 'fault')[0];
          const element =
            parts?.length === 1 && parts[0].getAttribute('element')
              ? qname(parts[0], parts[0].getAttribute('element'))
              : undefined;
          bindings.push({
            bindingId,
            name,
            faultName,
            path: resolved.path,
            messageLabels: resolved.labels,
            ...(resolved.overloaded ? { overloaded: true } : {}),
            direction: 'fault',
            envelope: soap.namespaceURI === SOAP12 ? envelopes[1] : envelopes[0],
            elements: element ? [element] : [],
            headerElements: [],
            supported: Boolean(
              element &&
              soapFault?.getAttribute('use') === 'literal' &&
              transportSupported &&
              !unavailableExtensions.length,
            ),
            reason: unavailableExtensions.length
              ? 'soap_required_extension_unavailable'
              : !transportSupported
                ? 'soap_transport_unavailable'
                : 'declared_literal_fault',
          });
        }
      }
    }
  }
  bindings.push(...wsdl2Bindings(documents, children, qname));
  const httpBindings = extractWsdlHttpBindings({
    documents,
    children,
    qname,
    messages,
    portTypes,
    schemas,
    files,
    requiredExtensions,
    extensions,
  });
  // Namespace-only imports resolve only when one captured schema supplies that namespace.
  for (const [filename, source] of Object.entries(files)) {
    const doc = parse(source);
    for (const node of Array.from(doc.getElementsByTagNameNS(XSD, 'import'))) {
      if (node.getAttribute('schemaLocation')) continue;
      const candidates = schemas.filter(
        (schema) =>
          !schema.member &&
          !schema.generated &&
          schema.namespace === node.getAttribute('namespace') &&
          schema.file !== filename,
      );
      if (candidates.length === 1) node.setAttribute('schemaLocation', candidates[0].file);
    }
    files[filename] = new XMLSerializer().serializeToString(doc);
  }
  const dependencies = new Map();
  for (const [filename, source] of Object.entries(files)) {
    const doc = parse(source),
      targets = [];
    for (const kind of ['import', 'include', 'redefine', 'override'])
      for (const node of Array.from(doc.getElementsByTagNameNS(XSD, kind))) {
        const location = node.getAttribute('schemaLocation');
        if (!location) continue;
        const base = new URL(filename, 'https://captured.invalid/'),
          target = new URL(location, base);
        const name = decodeURIComponent(target.pathname.slice(1));
        if (
          target.origin !== base.origin ||
          target.search ||
          target.hash ||
          !Object.hasOwn(files, name)
        )
          throw new Error('xsd_source_not_captured');
        targets.push(name);
      }
    dependencies.set(filename, targets);
  }
  for (const schema of schemas) {
    const visited = new Set(),
      queue = [schema.file];
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      if (visited.size >= 64) throw new Error('xsd_source_graph_limit');
      visited.add(file);
      queue.push(...dependencies.get(file));
    }
    schema.sources = [...visited];
  }
  const mimeBindings = extractSoapMimeBindings({ documents, children, qname, messages, portTypes });
  return { bindings, httpBindings, mimeBindings, schemas, files };
}
export function bindSoapPayload(
  document,
  payload,
  operationPaths,
  direction = 'input',
  bindingId,
  allowMultipart = false,
) {
  const allBindings = document['x-paritydiff-soap-bindings'] ?? [];
  if (
    bindingId !== undefined &&
    (typeof bindingId !== 'string' ||
      !bindingId ||
      bindingId.length > 1000 ||
      !allBindings.some(
        (binding) => binding.bindingId === bindingId && operationPaths.includes(binding.path),
      ))
  )
    return { available: false, valid: false, reason: 'soap_binding_selector_unavailable' };
  const scopedBindings = allBindings.filter(
    (binding) => bindingId === undefined || binding.bindingId === bindingId,
  );
  if (typeof payload !== 'string')
    return { available: true, valid: false, reason: 'soap_payload_invalid' };
  const doc = parse(payload),
    root = doc.documentElement;
  validateSoapXml(doc, payload);
  if (!envelopes.includes(root.namespaceURI) || root.localName !== 'Envelope')
    return { available: true, valid: false, reason: 'soap_envelope_invalid' };
  const encodedBindings = scopedBindings.filter(
    (binding) =>
      binding.wireUse === 'encoded' &&
      binding.supported &&
      binding.direction === direction &&
      binding.envelope === root.namespaceURI &&
      operationPaths.includes(binding.path),
  );
  if (
    !encodedBindings.length &&
    Array.from(doc.getElementsByTagName('*')).some((element) =>
      element.hasAttributeNS(root.namespaceURI, 'encodingStyle'),
    )
  )
    return { available: false, valid: false, reason: 'soap_encoded_serialization_unavailable' };
  const body = children(root, root.namespaceURI, 'Body'),
    headers = children(root, root.namespaceURI, 'Header');
  if (
    body.length !== 1 ||
    headers.length > 1 ||
    (headers[0] &&
      Array.from(headers[0].childNodes).some(
        (node) => [3, 4].includes(node.nodeType) && node.nodeValue.trim(),
      )) ||
    Array.from(root.childNodes).some(
      (node) =>
        node.nodeType === 1 &&
        (node.namespaceURI !== root.namespaceURI || !['Body', 'Header'].includes(node.localName)),
    )
  )
    return { available: true, valid: false, reason: 'soap_envelope_structure_invalid' };
  const bodyElements = Array.from(body[0].childNodes).filter((node) => node.nodeType === 1);
  if (
    Array.from(body[0].childNodes).some(
      (node) => [3, 4].includes(node.nodeType) && node.nodeValue.trim(),
    )
  )
    return { available: true, valid: false, reason: 'soap_body_invalid' };
  const fault =
    bodyElements.length === 1 &&
    bodyElements[0].localName === 'Fault' &&
    bodyElements[0].namespaceURI === root.namespaceURI;
  if (fault && direction !== 'output')
    return { available: true, valid: false, reason: 'soap_fault_request_invalid' };
  if (
    fault &&
    Array.from(doc.getElementsByTagName('*')).some(
      (element) =>
        element.hasAttributeNS(root.namespaceURI, 'encodingStyle') &&
        (![root, body[0]].includes(element) ||
          element.getAttributeNS(root.namespaceURI, 'encodingStyle').trim() !==
            (root.namespaceURI === envelopes[0]
              ? 'http://schemas.xmlsoap.org/soap/encoding/'
              : 'http://www.w3.org/2003/05/soap-encoding')),
    )
  )
    return { available: false, valid: false, reason: 'soap_fault_encoding_unavailable' };
  let payloadElements = bodyElements;
  let encoded = false;
  let typeChecks = [];
  let graphReferences;
  if (encodedBindings.length && !fault) {
    if (encodedBindings.length !== 1)
      return { available: false, valid: false, reason: 'soap_encoded_binding_ambiguous' };
    try {
      const decoded = decodeSoapEncoded(
        body[0],
        root.namespaceURI,
        encodedBindings[0],
        completeNamespaces,
        qname,
      );
      payloadElements = decoded.elements;
      typeChecks = decoded.typeChecks;
      graphReferences = decoded.graphReferences;
      encoded = true;
    } catch (error) {
      return {
        available: error.available ?? false,
        valid: false,
        reason: String(error.message).slice(0, 100),
      };
    }
  }
  let faultInfo;
  if (fault) {
    try {
      faultInfo = readSoapFault(bodyElements[0], root.namespaceURI, qname);
      payloadElements = faultInfo.elements;
    } catch {
      return { available: true, valid: false, reason: 'soap_fault_structure_invalid' };
    }
    if (!payloadElements.length) {
      const known = scopedBindings.filter(
        (binding) =>
          binding.supported &&
          binding.direction === 'output' &&
          operationPaths.includes(binding.path) &&
          binding.envelope === root.namespaceURI,
      );
      if (
        known.length !== 1 ||
        (headers[0] && Array.from(headers[0].childNodes).some((node) => node.nodeType === 1))
      )
        return { available: false, valid: false, reason: 'soap_fault_binding_unavailable' };
      return {
        available: true,
        valid: true,
        fault: true,
        bindingId: known[0].bindingId,
        reason: 'soap_protocol_fault_validated',
      };
    }
  }
  const names = payloadElements.map(
    (element) => '{' + (element.namespaceURI ?? '') + '}' + element.localName,
  );
  const choices = scopedBindings.filter(
    (binding) =>
      operationPaths.includes(binding.path) &&
      binding.direction === (fault ? 'fault' : direction) &&
      binding.envelope === root.namespaceURI &&
      (!fault ||
        ((!binding.faultCode || binding.faultCode === faultInfo.code) &&
          (!binding.faultSubcodes ||
            JSON.stringify(binding.faultSubcodes) === JSON.stringify(faultInfo.subcodes)))) &&
      (binding.contentModel === '#any'
        ? names.length === 1
        : binding.contentModel === '#none'
          ? !names.length
          : JSON.stringify(binding.elements) === JSON.stringify(names)),
  );
  if (!choices.length)
    return { available: true, valid: false, reason: 'soap_operation_body_mismatch' };
  if (choices.some((binding) => binding.multipart) && !allowMultipart)
    return { available: false, valid: false, reason: 'soap_multipart_required' };
  if (choices.length !== 1 || !choices[0].supported)
    return {
      available: false,
      valid: false,
      reason:
        choices.length === 1 &&
        ['soap_required_extension_unavailable', 'soap_transport_unavailable'].includes(
          choices[0].reason,
        )
          ? choices[0].reason
          : 'soap_binding_ambiguous_or_unavailable',
    };
  const contract = document['x-paritydiff-xml-schema-bundle'];
  const checks = [];
  const add = (element, file, encodedTypes = false) => {
    const schemas = contract?.schemas?.filter(
      (schema) =>
        !schema.generated && !schema.member && schema.namespace === (element.namespaceURI ?? ''),
    );
    if (!file && schemas?.length !== 1) throw new Error('soap_schema_namespace_unavailable');
    const schema = file ? contract.schemas.find((entry) => entry.file === file) : schemas[0];
    checks.push({
      schemaFile: schema.file,
      sources: schema.sources,
      dialect: schema.dialect ?? document['x-paritydiff-xsd-dialect'],
      payload: new XMLSerializer().serializeToString(completeNamespaces(element)),
      ...(encodedTypes && typeChecks.length ? { typeChecks } : {}),
      ...(encodedTypes && graphReferences && Object.keys(graphReferences).length
        ? { graphReferences }
        : {}),
      ...(encodedTypes && encoded ? { soapEncoding: encodedBindings[0].encodingStyle } : {}),
    });
  };
  const headerNames = new Set();
  for (const element of headers[0]
    ? Array.from(headers[0].childNodes).filter((node) => node.nodeType === 1)
    : []) {
    const name = '{' + (element.namespaceURI ?? '') + '}' + element.localName;
    if (headerNames.has(name) || !choices[0].headerElements?.includes(name))
      return { available: false, valid: false, reason: 'soap_header_binding_unavailable' };
    headerNames.add(name);
    const headerModel = choices[0].headerModels?.find((header) => header.element === name);
    const understands = ['true', '1'].includes(
      element.getAttributeNS(root.namespaceURI, 'mustUnderstand'),
    );
    if (headerModel && understands !== headerModel.mustUnderstand)
      return { available: true, valid: false, reason: 'soap_header_understanding_mismatch' };
    const clone = completeNamespaces(element);
    for (const attribute of Array.from(clone.attributes)) {
      if (attribute.namespaceURI !== root.namespaceURI) continue;
      if (
        ![
          'mustUnderstand',
          root.namespaceURI === envelopes[0] ? 'actor' : 'role',
          ...(root.namespaceURI === envelopes[1] ? ['relay'] : []),
        ].includes(attribute.localName) ||
        (['mustUnderstand', 'relay'].includes(attribute.localName) &&
          !(root.namespaceURI === envelopes[0] ? ['0', '1'] : ['0', '1', 'true', 'false']).includes(
            attribute.value,
          ))
      )
        return { available: true, valid: false, reason: 'soap_header_attribute_invalid' };
      clone.removeAttributeNode(attribute);
    }
    add(clone);
  }
  if (
    choices[0].headerModels?.some((header) => header.required && !headerNames.has(header.element))
  )
    return { available: true, valid: false, reason: 'soap_required_header_missing' };
  for (const element of payloadElements) {
    if (choices[0].rpcValidationName) {
      const clone = completeNamespaces(element);
      const surrogate = clone.ownerDocument.createElementNS(
        clone.namespaceURI,
        (clone.prefix ? clone.prefix + ':' : '') + choices[0].rpcValidationName,
      );
      for (const attribute of Array.from(clone.attributes))
        surrogate.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      while (clone.firstChild) surrogate.appendChild(clone.firstChild);
      add(surrogate, choices[0].rpcSchema, true);
    } else if (choices[0].contentModel !== '#any') add(element, undefined, true);
  }
  return {
    available: true,
    valid: true,
    bindingId: choices[0].bindingId,
    ...(encoded ? { encoded: true } : {}),
    ...(fault ? { fault: true } : {}),
    headerElements: [...headerNames],
    checks,
    files: contract.files,
    reason:
      choices[0].contentModel === '#any'
        ? 'wsdl_any_element_bound'
        : choices[0].contentModel === '#none'
          ? 'wsdl_empty_body_bound'
          : 'wsdl_element_bound',
  };
}
