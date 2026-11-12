import { SaxesParser } from 'saxes';
import {
  DOMImplementation,
  DOMParser as LegacyParser,
  XMLSerializer as LegacySerializer,
} from '@xmldom/xmldom';

const documents = new WeakSet();
const limit = () => Object.assign(new Error('xml11_resource_limit'), { available: false });
export function xmlVersion(source) {
  const version =
    /^\uFEFF?<\?xml\s[^?]*?\bversion\s*=\s*(["'])([^"']+)\1/.exec(source)?.[2] ?? '1.0';
  if (!['1.0', '1.1'].includes(version))
    throw Object.assign(new Error('xml_wire_version_unavailable'), { available: false });
  return version;
}
function parseXml(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) throw limit();
  const version = xmlVersion(source);
  const parser = new SaxesParser({ xmlns: true });
  const doc = new DOMImplementation().createDocument(null, null, null);
  const stack = [];
  let root,
    count = 0;
  const append = (node) => (stack.at(-1)?.dom ?? doc).appendChild(node);
  const expanded = (uri, local) => (uri ? '{' + uri + '}' + local : local);
  parser.on('error', () => {
    throw new Error('xml11_invalid');
  });
  parser.on('doctype', () => {
    throw new Error('xml_wire_dtd_rejected');
  });
  parser.on('opentag', (tag) => {
    if (++count >= 100000 || stack.length >= 99) throw limit();
    const dom = doc.createElementNS(tag.uri || null, tag.name);
    const tree = {
      name: expanded(tag.uri, tag.local),
      attributes: [],
      namespaces: [],
      children: [],
    };
    for (const attribute of Object.values(tag.attributes)) {
      dom.setAttributeNS(attribute.uri || null, attribute.name, attribute.value);
      if (attribute.uri === 'http://www.w3.org/2000/xmlns/')
        tree.namespaces.push([attribute.name === 'xmlns' ? '' : attribute.local, attribute.value]);
      else tree.attributes.push([expanded(attribute.uri, attribute.local), attribute.value]);
    }
    append(dom);
    if (stack.length) stack.at(-1).tree.children.push(tree);
    else root = tree;
    stack.push({ dom, tree });
  });
  const text = (value) => {
    if (!stack.length) return;
    append(doc.createTextNode(value));
    const children = stack.at(-1).tree.children;
    if (typeof children.at(-1) === 'string') children[children.length - 1] += value;
    else children.push(value);
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('comment', (value) => append(doc.createComment(value)));
  parser.on('processinginstruction', ({ target, body }) =>
    append(doc.createProcessingInstruction(target, body)),
  );
  parser.on('closetag', () => stack.pop());
  parser.write(source).close();
  if (!root || stack.length) throw new Error('xml11_invalid');
  if (version === '1.1') documents.add(doc);
  return { document: doc, tree: root };
}
export function parseXml11(source) {
  if (xmlVersion(source) !== '1.1') throw new Error('xml11_declaration_required');
  return parseXml(source);
}
export function xml11SchemaSource(source) {
  const parsed = parseXml11(source);
  try {
    const serialized = new XMLSerializer()
      .serializeToString(parsed.document)
      .replace('<?xml version="1.1"?>', '<?xml version="1.0"?>');
    if (JSON.stringify(parseXml(serialized).tree) !== JSON.stringify(parsed.tree))
      throw new Error('changed');
    return serialized;
  } catch {
    throw Object.assign(new Error('xml11_schema_infoset_unavailable'), { available: false });
  }
}
export class DOMParser {
  constructor(options) {
    this.legacy = new LegacyParser(options);
  }
  parseFromString(source, media) {
    return xmlVersion(source) === '1.1'
      ? parseXml11(source).document
      : this.legacy.parseFromString(source, media);
  }
}
export function validateSoapXml(document, source) {
  if (xmlVersion(source) !== '1.1') return;
  if (document.documentElement.namespaceURI === 'http://schemas.xmlsoap.org/soap/envelope/')
    throw new Error('soap11_xml_version_invalid');
  const stack = [document];
  const invalid = (value) =>
    Array.from(value).some(
      (char) => char.codePointAt(0) < 32 && ![9, 10, 13].includes(char.codePointAt(0)),
    );
  while (stack.length) {
    const node = stack.pop();
    if (
      invalid(node.nodeValue ?? '') ||
      Array.from(node.attributes ?? []).some((attribute) => invalid(attribute.value))
    )
      throw new Error('soap_xml10_infoset_required');
    stack.push(...Array.from(node.childNodes ?? []));
  }
}
const escape = (value) =>
  value.replace(/[&<>"\p{Cc}\u2028]/gu, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#x' + char.codePointAt(0).toString(16) + ';';
  });
export class XMLSerializer {
  serializeToString(node) {
    const serializer = new LegacySerializer();
    if (!documents.has(node.nodeType === 9 ? node : node.ownerDocument))
      return serializer.serializeToString(node);
    const source = serializer.serializeToString(node, {
      nodeFilter(value) {
        if ([3, 4].includes(value.nodeType)) return escape(value.data);
        if (value.nodeType === 2) return ' ' + value.name + '="' + escape(value.value) + '"';
        return value;
      },
    });
    return '<?xml version="1.1"?>' + source;
  }
}
