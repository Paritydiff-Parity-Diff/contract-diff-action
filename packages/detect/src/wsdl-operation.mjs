const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
import { xmlNcName } from '../../core/src/xml-names.mjs';
const validName = (name) => Boolean(name && xmlNcName.test('_' + name.replace(/:/g, '_')));
export function operationLabels(operation, children) {
  const io = children(operation, WSDL).filter((node) =>
    ['input', 'output'].includes(node.localName),
  );
  if (!io.length || io.length > 2 || new Set(io.map((node) => node.localName)).size !== io.length)
    throw new Error('invalid_wsdl_operation_messages');
  const name = operation.getAttribute('name');
  if (
    !validName(name) ||
    io.some((node) => node.hasAttribute('name') && !validName(node.getAttribute('name')))
  )
    throw new Error('invalid_wsdl_operation_message_name');
  const pattern = io.map((node) => node.localName).join('_');
  const labels = Object.fromEntries(
    io.map((node, index) => [
      node.localName,
      node.getAttribute('name') ||
        name +
          (io.length === 1
            ? ''
            : index === 1
              ? 'Response'
              : node.localName === 'input'
                ? 'Request'
                : 'Solicit'),
    ]),
  );
  return { pattern, ...labels };
}
export function resolveWsdlOperation(port, binding, children) {
  const name = binding.getAttribute('name');
  const candidates = children(port, WSDL, 'operation').filter(
    (node) => node.getAttribute('name') === name,
  );
  const bound = children(binding, WSDL).filter((node) =>
    ['input', 'output'].includes(node.localName),
  );
  if (bound.length > 2 || new Set(bound.map((node) => node.localName)).size !== bound.length)
    throw new Error('invalid_wsdl_operation_messages');
  const matches = candidates.filter((node) => {
    const labels = operationLabels(node, children);
    return bound.every(
      (io) => !io.hasAttribute('name') || io.getAttribute('name') === labels[io.localName],
    );
  });
  if (!matches.length) throw new Error('unresolved_wsdl_operation');
  if (matches.length !== 1) throw new Error('ambiguous_wsdl_operation');
  const labels = operationLabels(matches[0], children);
  const path =
    '/soap/' +
    encodeURIComponent(name) +
    (candidates.length > 1
      ? '/' + encodeURIComponent(labels.input ?? '') + '/' + encodeURIComponent(labels.output ?? '')
      : '');
  return { node: matches[0], labels, path, overloaded: candidates.length > 1 };
}
