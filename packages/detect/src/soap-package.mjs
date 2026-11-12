import { DOMParser, XMLSerializer, validateSoapXml } from './xml11.mjs';
import { decodeMimeParts, parseMimeType } from './mime-wire.mjs';
import { bindSoapPayload } from './soap-binding.mjs';
import { decodeXmlBytes } from './xml-wire.mjs';
import { bindSoapMimePayload } from './soap-mime.mjs';
const XOP = 'http://www.w3.org/2004/08/xop/include';
const invalid = () => new Error('soap_xop_package_invalid');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
function sameType(a, b) {
  const parameter = (name, value) => (name === 'charset' ? value.toLowerCase() : value);
  return (
    a.essence === b.essence &&
    [...a.params].every(
      ([name, value]) =>
        b.params.get(name) !== null &&
        parameter(name, b.params.get(name)) === parameter(name, value),
    ) &&
    [...b.params].every(
      ([name, value]) =>
        a.params.get(name) !== null &&
        parameter(name, a.params.get(name)) === parameter(name, value),
    )
  );
}
export function decodeSoapPackage(input) {
  if (
    typeof input.bytesBase64 !== 'string' ||
    input.bytesBase64.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64)
  )
    throw unavailable('soap_wire_bytes_unavailable');
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  if (bytes.length > 1024 * 1024) throw unavailable('soap_wire_size_limit');
  const media = parseMimeType(input.transport?.contentType);
  if (['text/xml', 'application/soap+xml'].includes(media.essence)) {
    const payload = decodeXmlBytes(bytes, media);
    const root = new DOMParser({
      onError() {
        throw invalid();
      },
    }).parseFromString(payload, 'application/xml').documentElement;
    validateSoapXml(root.ownerDocument, payload);
    const expected =
      media.essence === 'text/xml'
        ? 'http://schemas.xmlsoap.org/soap/envelope/'
        : 'http://www.w3.org/2003/05/soap-envelope';
    if (root.namespaceURI !== expected || root.localName !== 'Envelope') throw invalid();
    return { payload, packaging: 'xml', attachments: 0, rootType: media.toString() };
  }
  if (media.essence !== 'multipart/related') throw unavailable('soap_package_format_unavailable');
  const parts = decodeMimeParts(bytes, media.toString()),
    rootId = media.params.get('start'),
    root = rootId ? parts.find((part) => part.headers.get('content-id') === rootId) : parts[0];
  if (!root || media.params.get('type')?.toLowerCase() !== 'application/xop+xml') throw invalid();
  const rootType = parseMimeType(root.contentType);
  if (
    rootType.essence !== 'application/xop+xml' ||
    !rootType.params.get('type') ||
    !media.params.get('start-info')
  )
    throw invalid();
  const originalType = parseMimeType(rootType.params.get('type'));
  if (!sameType(originalType, parseMimeType(media.params.get('start-info')))) throw invalid();
  if (!['text/xml', 'application/soap+xml'].includes(originalType.essence))
    throw unavailable('soap_xop_media_unavailable');
  const xml = decodeXmlBytes(root.bytes, rootType);
  const document = new DOMParser({
    onError() {
      throw invalid();
    },
  }).parseFromString(xml, 'application/xml');
  validateSoapXml(document, xml);
  const stack = [{ node: document.documentElement, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++nodes > 20000 || depth > 128) throw unavailable('soap_xop_resource_limit');
    for (const child of Array.from(node.childNodes))
      if (child.nodeType === 1) stack.push({ node: child, depth: depth + 1 });
  }
  const envelope = document.documentElement;
  const expected =
    originalType.essence === 'text/xml'
      ? 'http://schemas.xmlsoap.org/soap/envelope/'
      : 'http://www.w3.org/2003/05/soap-envelope';
  if (envelope.namespaceURI !== expected || envelope.localName !== 'Envelope') throw invalid();
  const attachments = new Map(
    parts
      .filter((part) => part !== root && part.headers.has('content-id'))
      .map((part) => [part.headers.get('content-id'), part]),
  );
  const used = new Set(),
    includes = Array.from(document.getElementsByTagNameNS(XOP, 'Include'));
  let expanded = 0;
  if (includes.length > 1000) throw unavailable('soap_xop_resource_limit');
  for (const include of includes) {
    let ancestor = include;
    while (ancestor.parentNode) ancestor = ancestor.parentNode;
    if (ancestor !== document) continue;
    const parent = include.parentNode;
    if (
      !parent ||
      parent.nodeType !== 1 ||
      parent.childNodes.length !== 1 ||
      !include.hasAttribute('href')
    )
      throw invalid();
    for (const attribute of Array.from(include.attributes)) {
      if (attribute.name === 'href' && !attribute.namespaceURI) continue;
      if (!attribute.namespaceURI || attribute.namespaceURI === XOP) throw invalid();
    }
    for (const child of Array.from(include.childNodes)) {
      if (child.nodeType === 1 && child.namespaceURI && child.namespaceURI !== XOP) continue;
      if ([7, 8].includes(child.nodeType)) continue;
      throw invalid();
    }
    const href = include.getAttribute('href');
    if (!/^cid:/i.test(href) || /[#?\s]/.test(href) || /%(?![0-9a-f]{2})/i.test(href))
      throw invalid();
    let name;
    try {
      name = decodeURIComponent(href.slice(4));
    } catch {
      throw invalid();
    }
    if (!name || /[<>\s\x00-\x1f\x7f-\uffff]/.test(name)) throw invalid();
    const id = '<' + name + '>',
      part = attachments.get(id);
    if (!part) throw invalid();
    const value = Buffer.from(part.bytes).toString('base64');
    if ((expanded += value.length) > 1024 * 1024) throw unavailable('soap_xop_resource_limit');
    parent.replaceChild(document.createTextNode(value), include);
    used.add(part);
  }
  if (parts.some((part) => part !== root && !used.has(part)))
    throw unavailable('soap_attachment_binding_unavailable');
  const payload = new XMLSerializer().serializeToString(document);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw unavailable('soap_xop_resource_limit');
  return { payload, packaging: 'xop', attachments: used.size, rootType: originalType.toString() };
}
export function bindSoapWirePayload(input) {
  try {
    const contentType = parseMimeType(input.transport?.contentType);
    if (
      contentType.essence === 'multipart/related' &&
      contentType.params.get('type')?.toLowerCase() !== 'application/xop+xml'
    )
      return bindSoapMimePayload(input, bindSoapPayload);
    const decoded = decodeSoapPackage(input);
    const result = bindSoapPayload(
      input.native.document,
      decoded.payload,
      input.native.operationPaths,
      input.direction,
      input.native.bindingId,
    );
    return { ...result, packaging: decoded.packaging, attachments: decoded.attachments };
  } catch (error) {
    return {
      available: error.available !== false,
      valid: false,
      reason:
        error.message === 'soap_xop_package_invalid' || error.available === false
          ? error.message
          : 'soap_wire_payload_invalid',
    };
  }
}
