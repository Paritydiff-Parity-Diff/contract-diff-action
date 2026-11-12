import { createHash } from 'node:crypto';
import { parseMimeType, matchesMimeType } from './mime-wire.mjs';
import { bindMimeFormats } from './wsdl-http-multipart.mjs';
import { DOMParser, XMLSerializer } from './xml11.mjs';
import { resolveWsdlOperation } from './wsdl-operation.mjs';
import { replacementValues } from './wsdl-http-location.mjs';
import { xmlQName } from '../../core/src/xml-names.mjs';
import { decodeTextBytes } from './text-wire.mjs';
import { decodeXmlBytes } from './xml-wire.mjs';
import { applicationAttachment } from './application-attachments.mjs';
const WSDL = 'http://schemas.xmlsoap.org/wsdl/',
  HTTP = WSDL + 'http/',
  MIME = WSDL + 'mime/',
  XSD = 'http://www.w3.org/2001/XMLSchema';
const allowed = new Set([
  ...['binding', 'operation', 'address', 'urlEncoded', 'urlReplacement'].map(
    (name) => HTTP + '#' + name,
  ),
  ...['content', 'mimeXml', 'multipartRelated', 'part'].map((name) => MIME + '#' + name),
]);
const escape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/"/g, '&quot;');
const fail = (reason, available = true) => ({
  available,
  valid: false,
  reason,
  protocol: 'wsdl-http',
});
const splitName = (value) => {
  const end = value.indexOf('}');
  return { namespace: value.slice(1, end), name: value.slice(end + 1) };
};
export function extractWsdlHttpBindings(context) {
  const {
    documents,
    children,
    qname,
    messages,
    portTypes,
    schemas,
    files,
    requiredExtensions,
    extensions,
  } = context;
  const bindings = [];
  for (const { doc } of documents) {
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'definitions') continue;
    for (const binding of children(root, WSDL, 'binding')) {
      const http = children(binding, HTTP, 'binding');
      if (!http.length) continue;
      if (
        http.length !== 1 ||
        children(binding, 'http://schemas.xmlsoap.org/wsdl/soap/', 'binding').length ||
        children(binding, 'http://schemas.xmlsoap.org/wsdl/soap12/', 'binding').length
      )
        throw new Error('multiple_wsdl_binding_protocols');
      const method = http[0].getAttribute('verb');
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(method))
        throw new Error('invalid_wsdl_http_method');
      const port = portTypes.get(qname(binding, binding.getAttribute('type')));
      if (!port) throw new Error('unresolved_wsdl_port_type');
      const bindingId =
        '{' + root.getAttribute('targetNamespace') + '}' + binding.getAttribute('name');
      const addresses = [],
        addressModels = [];
      for (const { doc: source } of documents)
        for (const service of children(source.documentElement, WSDL, 'service'))
          for (const port of children(service, WSDL, 'port')) {
            if (qname(port, port.getAttribute('binding')) !== bindingId) continue;
            for (const address of children(port, HTTP, 'address')) {
              const uri = new URL(address.getAttribute('location'));
              if (
                !['http:', 'https:'].includes(uri.protocol) ||
                uri.username ||
                uri.password ||
                uri.search ||
                uri.hash ||
                /%(?![0-9a-f]{2})/i.test(uri.href)
              )
                throw new Error('invalid_wsdl_http_address');
              addresses.push(uri.href);
              addressModels.push({
                location: uri.href,
                requiredExtensions: requiredExtensions([...extensions(service), port], allowed),
              });
              if (addressModels.length > 128) throw new Error('wsdl_http_address_limit');
            }
          }
      const seen = new Set();
      for (const operation of children(binding, WSDL, 'operation')) {
        const resolved = resolveWsdlOperation(port, operation, children);
        if (seen.has(resolved.node)) throw new Error('duplicate_wsdl_operation_binding');
        seen.add(resolved.node);
        const locationNodes = children(operation, HTTP, 'operation');
        if (locationNodes.length !== 1) throw new Error('invalid_wsdl_http_location');
        const location = locationNodes[0].getAttribute('location');
        if (
          /^[a-z][a-z0-9+.-]*:/i.test(location) ||
          location.startsWith('//') ||
          location.includes('#') ||
          /[\x00-\x20\\]/.test(location) ||
          /%(?![0-9a-f]{2})/i.test(location)
        )
          throw new Error('invalid_wsdl_http_location');
        const path =
          '/wsdl-http/' +
          encodeURIComponent(bindingId) +
          '/' +
          resolved.path.slice('/soap/'.length);
        for (const direction of ['input', 'output']) {
          const abstract = children(resolved.node, WSDL, direction)[0],
            io = children(operation, WSDL, direction)[0];
          if (!abstract && !io) continue;
          const message =
            abstract && messages.get(qname(abstract, abstract.getAttribute('message')));
          if (!message) throw new Error('unresolved_wsdl_http_message');
          const parts = children(message, WSDL, 'part').map((part) => ({
            name: part.getAttribute('name'),
            ...(part.getAttribute('type')
              ? { type: qname(part, part.getAttribute('type')) }
              : { element: qname(part, part.getAttribute('element')) }),
          }));
          const required = requiredExtensions(
            [
              ...extensions(root),
              ...extensions(binding),
              ...extensions(port),
              operation,
              resolved.node,
            ],
            allowed,
          );
          const mimeFormats = (node, depth = 0) => {
            if (depth > 8) throw new Error('wsdl_http_mime_depth_limit');
            return children(node, MIME).map((child) =>
              child.localName === 'multipartRelated'
                ? {
                    kind: child.localName,
                    parts: children(child, MIME, 'part').map((part) =>
                      mimeFormats(part, depth + 1),
                    ),
                  }
                : {
                    kind: child.localName,
                    part: child.getAttribute('part'),
                    media: child.getAttribute('type') || '*/*',
                  },
            );
          };
          const formats = (
            io ? children(io, HTTP).map((node) => ({ kind: node.localName })) : []
          ).concat(io ? mimeFormats(io) : []);
          let schemaFile, namespace;
          if (!parts.length || parts.some((part) => part.type)) {
            const id = createHash('sha256')
              .update(bindingId + path + direction)
              .digest('hex')
              .slice(0, 24);
            namespace = 'urn:paritydiff:wsdl-http:' + id;
            schemaFile = 'http-' + id + '.xsd';
            const imports = new Map();
            for (const part of parts) {
              if (!part.type) continue;
              const type = splitName(part.type);
              if (type.namespace !== XSD && !imports.has(type.namespace))
                imports.set(
                  type.namespace,
                  schemas.find(
                    (schema) =>
                      !schema.member && !schema.generated && schema.namespace === type.namespace,
                  ),
                );
            }
            const prefixes = new Map([[XSD, 'xs']]);
            let index = 0;
            for (const ns of imports.keys()) prefixes.set(ns, ns ? 't' + index++ : '');
            const names = Array.from(prefixes)
              .filter(([ns]) => ns && ns !== XSD)
              .map(([ns, prefix]) => ' xmlns:' + prefix + '="' + escape(ns) + '"')
              .join('');
            const imported = Array.from(imports)
              .map(
                ([ns, schema]) =>
                  '<xs:import' +
                  (ns ? ' namespace="' + escape(ns) + '"' : '') +
                  (schema ? ' schemaLocation="' + escape(schema.file) + '"' : '') +
                  '/>',
              )
              .join('');
            const elements = parts
              .map((part, index) => {
                if (!part.type) return '';
                const type = splitName(part.type),
                  prefix = prefixes.get(type.namespace);
                return (
                  '<xs:element name="p' +
                  index +
                  '" type="' +
                  (prefix ? prefix + ':' : '') +
                  escape(type.name) +
                  '"/>'
                );
              })
              .join('');
            files[schemaFile] =
              '<xs:schema xmlns:xs="' +
              XSD +
              '" targetNamespace="' +
              namespace +
              '"' +
              names +
              '>' +
              imported +
              '<xs:element name="Args"><xs:complexType><xs:sequence>' +
              elements +
              '</xs:sequence></xs:complexType></xs:element>' +
              parts
                .map((part, index) => {
                  if (!part.type) return '';
                  const type = splitName(part.type),
                    prefix = prefixes.get(type.namespace);
                  return (
                    '<xs:element name="Value' +
                    index +
                    '" type="' +
                    (prefix ? prefix + ':' : '') +
                    escape(type.name) +
                    '"/>'
                  );
                })
                .join('') +
              '</xs:schema>';
            schemas.push({
              file: schemaFile,
              namespace,
              generated: true,
              dialect: schemas.some((schema) => !schema.generated && schema.dialect === '1.1')
                ? '1.1'
                : undefined,
            });
          }
          bindings.push({
            bindingId,
            path,
            name: operation.getAttribute('name'),
            direction,
            method,
            location,
            addresses: [...new Set(addresses)],
            addressModels,
            messageLabels: resolved.labels,
            parts,
            formats,
            schemaFile,
            namespace,
            requiredExtensions: required,
          });
        }
      }
    }
  }
  return bindings;
}
const media = (value) => {
  try {
    return parseMimeType(value);
  } catch {
    return undefined;
  }
};
function text(bytes, contentType) {
  return decodeTextBytes(bytes, contentType?.params.get('charset') ?? 'utf-8');
}
function form(value, charset = 'utf-8') {
  const output = new Map();
  const decode = (part) => {
    const bytes = [];
    for (let index = 0; index < part.length; index++) {
      if (part[index] === '%') {
        const hex = part.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('wsdl_http_form_encoding_invalid');
        bytes.push(parseInt(hex, 16));
        index += 2;
      } else {
        const code = part.charCodeAt(index);
        if (code > 255) throw new Error('wsdl_http_form_encoding_invalid');
        bytes.push(code === 43 ? 32 : code);
      }
    }
    return decodeTextBytes(Buffer.from(bytes), charset);
  };
  for (const pair of value ? value.split('&') : []) {
    if (output.size >= 1000) throw new Error('wsdl_http_parameter_limit');
    const index = pair.indexOf('='),
      rawName = index < 0 ? pair : pair.slice(0, index),
      rawValue = index < 0 ? '' : pair.slice(index + 1);
    const name = decode(rawName),
      item = decode(rawValue);
    if (output.has(name)) throw new Error('wsdl_http_parameter_duplicate');
    output.set(name, item);
  }
  return output;
}
function representation(typeName, bundle, seen = new Set()) {
  if (seen.has(typeName) || seen.size >= 32) return undefined;
  seen.add(typeName);
  const type = splitName(typeName);
  if (type.namespace === XSD)
    return type.name === 'base64Binary'
      ? 'base64'
      : type.name === 'hexBinary'
        ? 'hex'
        : ['anyType', 'NOTATION', 'QName'].includes(type.name)
          ? undefined
          : 'text';
  const definitions = [];
  for (const schema of bundle.schemas.filter(
    (schema) => !schema.generated && schema.namespace === type.namespace,
  )) {
    const doc = new DOMParser({
      onError() {
        throw new Error('wsdl_http_schema_invalid');
      },
    }).parseFromString(bundle.files[schema.file], 'application/xml');
    for (const node of Array.from(doc.documentElement.childNodes))
      if (
        node.nodeType === 1 &&
        node.namespaceURI === XSD &&
        node.localName === 'simpleType' &&
        node.getAttribute('name') === type.name
      )
        definitions.push(node);
  }
  if (definitions.length !== 1) return undefined;
  const named = (node, value) => {
    value = value.trim();
    if (!xmlQName.test(value)) return undefined;
    const name = value.split(':'),
      namespace = node.lookupNamespaceURI(name.length === 2 ? name[0] : null) ?? '';
    if (name.length === 2 && !namespace) return undefined;
    return representation('{' + namespace + '}' + name.at(-1), bundle, new Set(seen));
  };
  const inline = (node, depth = 0) => {
    if (depth > 16) return undefined;
    const children = Array.from(node.childNodes).filter(
      (child) =>
        child.nodeType === 1 && child.namespaceURI === XSD && child.localName !== 'annotation',
    );
    if (children.length !== 1) return undefined;
    const model = children[0],
      simple = Array.from(model.childNodes).filter(
        (child) =>
          child.nodeType === 1 && child.namespaceURI === XSD && child.localName === 'simpleType',
      );
    if (model.localName === 'restriction')
      return model.getAttribute('base')
        ? named(model, model.getAttribute('base'))
        : simple.length === 1
          ? inline(simple[0], depth + 1)
          : undefined;
    if (model.localName === 'list') {
      const item = model.getAttribute('itemType')
        ? named(model, model.getAttribute('itemType'))
        : simple.length === 1
          ? inline(simple[0], depth + 1)
          : undefined;
      return item ? 'text' : undefined;
    }
    if (model.localName === 'union') {
      const names = model.getAttribute('memberTypes')?.trim().split(/\s+/).filter(Boolean) ?? [];
      if ((!names.length && !simple.length) || names.length + simple.length > 64) return undefined;
      const kinds = names
        .map((name) => named(model, name))
        .concat(simple.map((child) => inline(child, depth + 1)));
      return kinds[0] && kinds.every((kind) => kind === kinds[0]) ? kinds[0] : undefined;
    }
    return undefined;
  };
  return inline(definitions[0]);
}
export const wsdlTypeRepresentation = representation;
export function bindWsdlHttpPayload(input) {
  const document = input.native.document,
    paths = input.native.operationPaths ?? [],
    direction = input.direction ?? 'input';
  const choices = (document['x-paritydiff-wsdl-http-bindings'] ?? []).filter(
    (binding) =>
      paths.includes(binding.path) &&
      binding.direction === direction &&
      (input.native.bindingId === undefined || binding.bindingId === input.native.bindingId),
  );
  if (choices.length !== 1) return fail('wsdl_http_binding_ambiguous_or_unavailable', false);
  const binding = choices[0],
    bundle = document['x-paritydiff-xml-schema-bundle'];
  if (binding.requiredExtensions.length)
    return fail('wsdl_http_required_extension_unavailable', false);
  if (
    typeof input.bytesBase64 !== 'string' ||
    input.bytesBase64.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64)
  )
    return fail('wsdl_http_bytes_unavailable', false);
  const bytes = Buffer.from(input.bytesBase64, 'base64'),
    transport = input.transport;
  if (bytes.length > 1024 * 1024) return fail('wsdl_http_byte_limit', false);
  if (!transport || typeof transport.contentType !== 'string')
    return fail('wsdl_http_transport_unavailable', false);
  const contentType = media(transport.contentType);
  const check = (payload, schemaFile) => {
    const schema = bundle.schemas.find((schema) => schema.file === schemaFile);
    if (!schema)
      throw Object.assign(new Error('wsdl_http_schema_unavailable'), { available: false });
    return {
      schemaFile,
      sources: schema.sources,
      dialect: schema.dialect ?? document['x-paritydiff-xsd-dialect'],
      payload,
    };
  };
  const argumentsCheck = (values) => {
    if (!binding.schemaFile || binding.parts.some((part) => !part.type))
      throw Object.assign(new Error('wsdl_http_part_type_unavailable'), { available: false });
    if (binding.parts.some((part) => !values.has(part.name)))
      throw new Error('wsdl_http_parameter_missing');
    if (values.size !== binding.parts.length)
      throw Object.assign(new Error('wsdl_http_parameter_unbound'), { available: false });
    return check(
      '<h:Args xmlns:h="' +
        binding.namespace +
        '">' +
        binding.parts
          .map(
            (part, index) =>
              '<p' + index + '>' + escape(values.get(part.name)) + '</p' + index + '>',
          )
          .join('') +
        '</h:Args>',
      binding.schemaFile,
    );
  };
  const mimeCheck = (format, bytes, contentType) => {
    const part = format.part
      ? binding.parts.find((part) => part.name === format.part)
      : binding.parts.length === 1
        ? binding.parts[0]
        : undefined;
    if (!part)
      throw Object.assign(new Error('wsdl_http_mime_part_unavailable'), { available: false });
    if (part.element || format.kind === 'mimeXml') {
      if (
        !['application/xml', 'text/xml'].includes(contentType.essence) &&
        !contentType.subtype.endsWith('+xml')
      )
        throw Object.assign(new Error('wsdl_http_xml_media_unavailable'), { available: false });
      const payload = decodeXmlBytes(bytes, contentType);
      const xml = new DOMParser({
        onError() {
          throw new Error('wsdl_http_xml_invalid');
        },
      }).parseFromString(payload, 'application/xml');
      if (!part.element) {
        if (!binding.schemaFile)
          throw Object.assign(new Error('wsdl_http_part_type_unavailable'), { available: false });
        return {
          name: part.name,
          check: {
            ...check(undefined, binding.schemaFile),
            typeChecks: [
              { typeName: part.type, payload: new XMLSerializer().serializeToString(xml) },
            ],
          },
        };
      }
      const element = xml.documentElement,
        expected = splitName(part.element);
      if (element.namespaceURI !== expected.namespace || element.localName !== expected.name)
        throw new Error('wsdl_http_element_mismatch');
      const schema = bundle.schemas.find(
        (schema) => !schema.member && !schema.generated && schema.namespace === expected.namespace,
      );
      if (!schema)
        throw Object.assign(new Error('wsdl_http_schema_unavailable'), { available: false });
      return {
        name: part.name,
        check: check(new XMLSerializer().serializeToString(xml), schema.file),
      };
    }
    if (!binding.schemaFile)
      throw Object.assign(new Error('wsdl_http_part_type_unavailable'), { available: false });
    const kind = representation(part.type, bundle);
    if (!kind)
      throw Object.assign(new Error('wsdl_http_representation_unavailable'), { available: false });
    const value =
      kind === 'base64'
        ? bytes.toString('base64')
        : kind === 'hex'
          ? bytes.toString('hex')
          : contentType.essence === 'application/json'
            ? decodeTextBytes(bytes, 'utf-8')
            : text(bytes, contentType);
    const index = binding.parts.indexOf(part);
    return {
      name: part.name,
      check: {
        ...check(
          '<h:Value' +
            index +
            ' xmlns:h="' +
            binding.namespace +
            '">' +
            escape(value) +
            '</h:Value' +
            index +
            '>',
          binding.schemaFile,
        ),
        ...(applicationAttachment(bytes, contentType, part.name)
          ? { applicationAttachment: applicationAttachment(bytes, contentType, part.name) }
          : {}),
      },
    };
  };
  const mimeChecks = () => {
    if (!contentType)
      throw Object.assign(new Error('wsdl_http_content_type_unavailable'), { available: false });
    const partIds = input.native.mimePartIds ?? {};
    if (
      !partIds ||
      typeof partIds !== 'object' ||
      Array.isArray(partIds) ||
      Object.keys(partIds).length > 64 ||
      Object.entries(partIds).some(
        ([name, id]) =>
          !binding.parts.some((part) => part.name === name) ||
          typeof id !== 'string' ||
          id.length > 1000 ||
          !/^<[^<>\s\x00-\x1f\x7f-\uffff]+>$/.test(id),
      ) ||
      new Set(Object.values(partIds)).size !== Object.keys(partIds).length
    )
      throw Object.assign(new Error('wsdl_http_mime_mapping_invalid'), { available: false });
    const result = bindMimeFormats({
      formats: binding.formats,
      bytes,
      contentType,
      partIds,
      leaf: mimeCheck,
    });
    if (
      result.names.length !== binding.parts.length ||
      binding.parts.some((part) => !result.names.includes(part.name))
    )
      throw Object.assign(new Error('wsdl_http_mime_message_unbound'), { available: false });
    return result.checks;
  };
  try {
    const formats = binding.formats;
    let checks;
    if (direction === 'input') {
      if (
        typeof transport.method !== 'string' ||
        typeof transport.origin !== 'string' ||
        typeof transport.path !== 'string' ||
        typeof transport.search !== 'string' ||
        transport.search.length > 16384 ||
        /[#\r\n]/.test(transport.search)
      )
        return fail('wsdl_http_transport_unavailable', false);
      if (transport.method !== binding.method) return fail('wsdl_http_method_mismatch');
      if (!binding.addresses.length) return fail('wsdl_http_address_unavailable', false);
      for (const address of binding.addressModels ?? []) {
        if (!address.requiredExtensions.length) continue;
        if (formats.some((format) => format.kind === 'urlReplacement')) {
          try {
            replacementValues({ ...binding, addresses: [address.location] }, transport);
            return fail('wsdl_http_required_extension_unavailable', false);
          } catch (error) {
            if (error.available === false) throw error;
          }
        } else {
          const target = new URL(binding.location, address.location);
          if (target.origin === transport.origin && target.pathname === transport.path)
            return fail('wsdl_http_required_extension_unavailable', false);
        }
      }
      const forms =
        contentType?.essence === 'application/x-www-form-urlencoded'
          ? formats.filter(
              (format) =>
                format.kind === 'content' &&
                media(format.media)?.essence === 'application/x-www-form-urlencoded' &&
                matchesMimeType(format.media, contentType),
            )
          : [];
      if (
        forms.length &&
        forms.some(
          (format) =>
            format.part && (binding.parts.length !== 1 || binding.parts[0].name !== format.part),
        )
      )
        return fail('wsdl_http_form_part_unbound', false);
      const selected = forms.length
        ? forms[0]
        : formats.length === 1
          ? formats[0]
          : { kind: 'mimeAlternatives' };
      const locations = binding.addresses
        .map((address) => new URL(binding.location, address))
        .filter(
          (target) => target.origin === transport.origin && target.pathname === transport.path,
        );
      if (selected.kind === 'urlReplacement') {
        if (bytes.length) return fail('wsdl_http_replacement_body_unbound', false);
        checks = [argumentsCheck(replacementValues(binding, transport))];
      } else {
        if (!locations.length) return fail('wsdl_http_operation_location_mismatch');
        const location = locations.find(
          (target) =>
            !target.search ||
            transport.search === target.search ||
            transport.search.startsWith(target.search + '&'),
        );
        if (!location) return fail('wsdl_http_operation_query_mismatch');
        const extraSearch = location.search
          ? transport.search.slice(location.search.length).replace(/^&/, '')
          : transport.search.slice(1);
        if (
          selected.kind === 'urlEncoded' ||
          (selected.kind === 'content' &&
            media(selected.media)?.essence === 'application/x-www-form-urlencoded')
        ) {
          if (binding.method === 'GET') {
            if (bytes.length || (transport.search && !transport.search.startsWith('?')))
              return fail('wsdl_http_query_invalid');
            checks = [argumentsCheck(form(extraSearch))];
          } else {
            if (!contentType || contentType.essence !== 'application/x-www-form-urlencoded')
              return fail('wsdl_http_content_type_mismatch');
            if (selected.kind === 'content' && !matchesMimeType(selected.media, contentType))
              return fail('wsdl_http_content_type_mismatch');
            if (transport.search !== location.search) return fail('wsdl_http_query_unbound', false);
            checks = [
              argumentsCheck(
                form(bytes.toString('latin1'), contentType.params.get('charset') ?? 'utf-8'),
              ),
            ];
          }
        } else if (
          ['content', 'mimeXml', 'multipartRelated', 'mimeAlternatives'].includes(selected.kind)
        ) {
          if (transport.search !== location.search) return fail('wsdl_http_query_unbound', false);
          checks = mimeChecks();
        } else return fail('wsdl_http_input_format_unavailable', false);
      }
    } else {
      checks = mimeChecks();
    }
    return {
      available: true,
      valid: true,
      protocol: 'wsdl-http',
      bindingId: binding.bindingId,
      checks,
      files: bundle.files,
      validation: 'wsdl_http_binding_and_xsd',
    };
  } catch (error) {
    return fail(
      error.message === 'wsdl_http_parameter_duplicate' ||
        error.message === 'wsdl_http_parameter_missing'
        ? error.message
        : error.available === false
          ? error.message
          : 'wsdl_http_payload_invalid',
      error.available !== false,
    );
  }
}
