import { DOMParser, XMLSerializer } from './xml11.mjs';
import { resolveWsdlOperation } from './wsdl-operation.mjs';
import { bindMimeFormats } from './wsdl-http-multipart.mjs';
import { parseMimeType } from './mime-wire.mjs';
import { wsdlTypeRepresentation } from './wsdl-http.mjs';
import { decodeXmlBytes } from './xml-wire.mjs';
import { decodeTextBytes } from './text-wire.mjs';
import { applicationAttachment } from './application-attachments.mjs';
const WSDL = 'http://schemas.xmlsoap.org/wsdl/',
  MIME = WSDL + 'mime/',
  SOAP = [WSDL + 'soap/', WSDL + 'soap12/'],
  XSD = 'http://www.w3.org/2001/XMLSchema';
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = () => new Error('soap_mime_payload_invalid');
const splitName = (value) => {
  const at = value.indexOf('}');
  return { namespace: value.slice(1, at), name: value.slice(at + 1) };
};
const escape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
export function extractSoapMimeBindings({ documents, children, qname, messages, portTypes }) {
  const result = [];
  for (const { doc } of documents) {
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'definitions') continue;
    for (const binding of children(root, WSDL, 'binding')) {
      const soap = SOAP.flatMap((namespace) => children(binding, namespace, 'binding'));
      if (!soap.length) continue;
      const port = portTypes.get(qname(binding, binding.getAttribute('type')));
      if (!port) throw new Error('unresolved_wsdl_port_type');
      for (const operation of children(binding, WSDL, 'operation')) {
        const resolved = resolveWsdlOperation(port, operation, children);
        for (const direction of ['input', 'output']) {
          const io = children(operation, WSDL, direction)[0];
          if (!io || !children(io, MIME, 'multipartRelated').length) continue;
          if (soap.length !== 1) throw new Error('multiple_wsdl_binding_protocols');
          const abstract = children(resolved.node, WSDL, direction)[0],
            messageName = abstract && qname(abstract, abstract.getAttribute('message')),
            message = messages.get(messageName);
          if (!message) throw new Error('unresolved_soap_mime_message');
          const parts = children(message, WSDL, 'part').map((part) => ({
            name: part.getAttribute('name'),
            ...(part.getAttribute('type')
              ? { type: qname(part, part.getAttribute('type')) }
              : { element: qname(part, part.getAttribute('element')) }),
          }));
          const bodyParts = [];
          const headerParts = Array.from(io.getElementsByTagNameNS(soap[0].namespaceURI, 'header'))
            .filter((header) => qname(header, header.getAttribute('message')) === messageName)
            .map((header) => {
              const name = header.getAttribute('part'),
                part = parts.find((part) => part.name === name);
              return { name, element: part?.element };
            });
          let bodyCount = 0;
          const formats = (node, depth = 0) => {
            if (depth > 8) throw new Error('soap_mime_depth_limit');
            return Array.from(node.childNodes)
              .filter((child) => child.nodeType === 1 && child.namespaceURI !== WSDL)
              .flatMap((child) => {
                if (child.namespaceURI === soap[0].namespaceURI && child.localName === 'header')
                  return [];
                if (child.namespaceURI === soap[0].namespaceURI && child.localName === 'body') {
                  bodyCount++;
                  const selected = child.hasAttribute('parts')
                    ? child.getAttribute('parts').trim().split(/\s+/).filter(Boolean)
                    : parts.map((part) => part.name);
                  bodyParts.push(...selected);
                  return {
                    kind: 'soapBody',
                    media: soap[0].namespaceURI === SOAP[0] ? 'text/xml' : 'application/soap+xml',
                    parts: selected,
                  };
                }
                if (child.namespaceURI !== MIME) return { kind: 'unsupported' };
                if (child.localName === 'multipartRelated')
                  return {
                    kind: 'multipartRelated',
                    parts: children(child, MIME, 'part').map((part) => formats(part, depth + 1)),
                  };
                return {
                  kind: child.localName,
                  part: child.getAttribute('part'),
                  media: child.getAttribute('type') || '*/*',
                };
              });
          };
          const model = formats(io);
          result.push({
            bindingId:
              '{' + root.getAttribute('targetNamespace') + '}' + binding.getAttribute('name'),
            path: resolved.path,
            direction,
            parts,
            bodyParts,
            headerParts,
            bodyCount,
            formats: model,
            media: soap[0].namespaceURI === SOAP[0] ? 'text/xml' : 'application/soap+xml',
          });
        }
      }
    }
  }
  return result;
}
export function bindSoapMimePayload(input, soapBinder) {
  try {
    const document = input.native.document,
      models = document['x-paritydiff-soap-mime-bindings'] ?? [];
    const choices = models.filter(
      (model) =>
        input.native.operationPaths?.includes(model.path) &&
        model.direction === (input.direction ?? 'input') &&
        (input.native.bindingId === undefined || model.bindingId === input.native.bindingId),
    );
    if (choices.length !== 1) throw unavailable('soap_mime_binding_ambiguous');
    const model = choices[0],
      bundle = document['x-paritydiff-xml-schema-bundle'];
    if (
      model.bodyCount !== 1 ||
      new Set(model.bodyParts).size !== model.bodyParts.length ||
      model.bodyParts.some((name) => !model.parts.some((part) => part.name === name))
    )
      throw unavailable('soap_mime_body_parts_unavailable');
    if (
      typeof input.bytesBase64 !== 'string' ||
      input.bytesBase64.length > 1398104 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64)
    )
      throw unavailable('soap_mime_bytes_unavailable');
    const bytes = Buffer.from(input.bytesBase64, 'base64'),
      contentType = parseMimeType(input.transport?.contentType);
    if (bytes.length > 1024 * 1024) throw unavailable('soap_mime_resource_limit');
    if (
      contentType.essence !== 'multipart/related' ||
      parseMimeType(contentType.params.get('type')).essence !== model.media
    )
      throw invalid();
    const partIds = input.native.mimePartIds ?? {};
    if (
      !partIds ||
      typeof partIds !== 'object' ||
      Array.isArray(partIds) ||
      Object.keys(partIds).length > 64 ||
      Object.entries(partIds).some(
        ([name, id]) =>
          !model.parts.some((part) => part.name === name) ||
          typeof id !== 'string' ||
          id.length > 1000 ||
          !/^<[^<>\s\x00-\x1f\x7f-\uffff]+>$/.test(id),
      ) ||
      new Set(Object.values(partIds)).size !== Object.keys(partIds).length
    )
      throw unavailable('soap_mime_mapping_invalid');
    const files = { ...bundle.files };
    const schemaFor = (name) => {
      const ns = splitName(name).namespace;
      const schema = bundle.schemas.find(
        (schema) => !schema.generated && !schema.member && (ns === XSD || schema.namespace === ns),
      );
      if (!schema && ns === XSD) {
        let file = 'paritydiff-builtin-types.xsd';
        while (Object.hasOwn(files, file)) file = '_' + file;
        files[file] = '<xs:schema xmlns:xs="' + XSD + '"/>';
        return { schemaFile: file, sources: [file], dialect: '1.0' };
      }
      if (!schema) throw unavailable('soap_mime_schema_unavailable');
      return {
        schemaFile: schema.file,
        sources: schema.sources,
        dialect: schema.dialect ?? document['x-paritydiff-xsd-dialect'],
      };
    };
    const result = bindMimeFormats({
      formats: model.formats,
      bytes,
      contentType,
      partIds,
      leaf: (format, bytes, media) => {
        if (format.kind === 'soapBody') {
          const checked = soapBinder(
            document,
            decodeXmlBytes(bytes, media),
            input.native.operationPaths,
            input.direction,
            model.bindingId,
            true,
          );
          if (!checked.valid || !checked.available)
            throw Object.assign(new Error(checked.reason), { available: checked.available });
          if (checked.fault) throw unavailable('soap_mime_fault_context_unavailable');
          const headers = (model.headerParts ?? []).filter((part) =>
            checked.headerElements?.includes(part.element),
          );
          return {
            names: [...format.parts, ...headers.map((part) => part.name)],
            checks: checked.checks ?? [],
          };
        }
        const part = format.part
          ? model.parts.find((part) => part.name === format.part)
          : model.parts.length === 1
            ? model.parts[0]
            : undefined;
        if (!part) throw unavailable('soap_mime_part_unavailable');
        if (format.kind === 'mimeXml' || part.element) {
          if (
            !['application/xml', 'text/xml'].includes(media.essence) &&
            !media.subtype.endsWith('+xml')
          )
            throw unavailable('soap_mime_xml_media_unavailable');
          const payload = decodeXmlBytes(bytes, media),
            doc = new DOMParser({
              onError() {
                throw invalid();
              },
            }).parseFromString(payload, 'application/xml');
          if (part.element) {
            const name = splitName(part.element);
            if (
              doc.documentElement.namespaceURI !== name.namespace ||
              doc.documentElement.localName !== name.name
            )
              throw invalid();
            return {
              name: part.name,
              check: {
                ...schemaFor(part.element),
                payload: new XMLSerializer().serializeToString(doc),
              },
            };
          }
          return {
            name: part.name,
            check: { ...schemaFor(part.type), typeChecks: [{ typeName: part.type, payload }] },
          };
        }
        const kind = wsdlTypeRepresentation(part.type, bundle);
        if (!kind) throw unavailable('soap_mime_representation_unavailable');
        const value =
          kind === 'base64'
            ? bytes.toString('base64')
            : kind === 'hex'
              ? bytes.toString('hex')
              : decodeTextBytes(
                  bytes,
                  media.essence === 'application/json'
                    ? 'utf-8'
                    : (media.params.get('charset') ?? 'utf-8'),
                );
        return {
          name: part.name,
          check: {
            ...schemaFor(part.type),
            ...(applicationAttachment(bytes, media, part.name)
              ? { applicationAttachment: applicationAttachment(bytes, media, part.name) }
              : {}),
            typeChecks: [{ typeName: part.type, payload: '<Part>' + escape(value) + '</Part>' }],
          },
        };
      },
    });
    if (
      result.names.length !== model.parts.length ||
      model.parts.some((part) => !result.names.includes(part.name))
    )
      throw unavailable('soap_mime_message_unbound');
    return {
      available: true,
      valid: true,
      bindingId: model.bindingId,
      checks: result.checks,
      files,
      packaging: 'soap-mime',
      attachments: model.parts.length - model.bodyParts.length - (model.headerParts?.length ?? 0),
    };
  } catch (error) {
    return {
      available: error.available !== false,
      valid: false,
      reason: error.available === false ? error.message : 'soap_mime_payload_invalid',
    };
  }
}
