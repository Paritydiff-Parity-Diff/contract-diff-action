const WSDL = 'http://www.w3.org/ns/wsdl';
const SOAP = 'http://www.w3.org/ns/wsdl/soap';
const patterns = new Map([
  ['http://www.w3.org/ns/wsdl/in-only', { input: 'In' }],
  ['http://www.w3.org/ns/wsdl/robust-in-only', { input: 'In' }],
  ['http://www.w3.org/ns/wsdl/in-out', { input: 'In', output: 'Out' }],
]);
export function wsdl2Bindings(documents, children, qname) {
  const interfaces = new Map(),
    bindings = [],
    bindingIds = new Set();
  for (const { doc } of documents) {
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'description') continue;
    const namespace = root.getAttribute('targetNamespace');
    if (!namespace) throw new Error('wsdl2_target_namespace_required');
    for (const node of children(root, WSDL, 'interface')) {
      const name = '{' + namespace + '}' + node.getAttribute('name');
      if (interfaces.has(name)) throw new Error('duplicate_wsdl2_interface');
      interfaces.set(name, { node, namespace });
    }
  }
  const inherited = (name, seen = new Set()) => {
    if (seen.has(name) || seen.size >= 32) throw new Error('wsdl2_interface_inheritance_invalid');
    const item = interfaces.get(name);
    if (!item) throw new Error('unresolved_wsdl2_interface');
    const operations = new Map(),
      faults = new Map();
    const add = (map, name, node) => {
      if (map.has(name) && map.get(name) !== node)
        throw new Error('ambiguous_wsdl2_interface_member');
      map.set(name, node);
    };
    for (const parent of (item.node.getAttribute('extends') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      const inheritedItems = inherited(qname(item.node, parent), new Set([...seen, name]));
      for (const [name, node] of inheritedItems.operations) add(operations, name, node);
      for (const [name, node] of inheritedItems.faults) add(faults, name, node);
    }
    for (const node of children(item.node, WSDL, 'operation'))
      add(operations, '{' + item.namespace + '}' + node.getAttribute('name'), node);
    for (const node of children(item.node, WSDL, 'fault'))
      add(faults, '{' + item.namespace + '}' + node.getAttribute('name'), node);
    return { operations, faults };
  };
  const boolean = (node, name, fallback = false) => {
    if (!node.hasAttribute(name)) return fallback;
    const value = node.getAttribute(name);
    if (!['true', 'false', '1', '0'].includes(value)) throw new Error('invalid_wsdl2_boolean');
    return ['true', '1'].includes(value);
  };
  const headerModels = (node) =>
    children(node, SOAP, 'header').map((header) => ({
      element: qname(header, header.getAttribute('element')),
      required: boolean(header, 'required'),
      mustUnderstand: boolean(header, 'mustUnderstand'),
    }));
  const requiredModule = (node) =>
    children(node, SOAP, 'module').some((module) => boolean(module, 'required'));
  for (const { doc } of documents) {
    const root = doc.documentElement;
    if (root.namespaceURI !== WSDL || root.localName !== 'description') continue;
    for (const binding of children(root, WSDL, 'binding')) {
      if (binding.getAttribute('type') !== SOAP) continue;
      const components = inherited(qname(binding, binding.getAttribute('interface')));
      const version = binding.getAttributeNS(SOAP, 'version') || '1.2';
      const baseSupported =
        ['1.1', '1.2'].includes(version) &&
        [
          'http://www.w3.org/2003/05/soap/bindings/HTTP/',
          'http://schemas.xmlsoap.org/soap/http',
        ].includes(binding.getAttributeNS(SOAP, 'protocol')) &&
        !requiredModule(binding);
      const envelope =
        version === '1.1'
          ? 'http://schemas.xmlsoap.org/soap/envelope/'
          : 'http://www.w3.org/2003/05/soap-envelope';
      const bindingId =
        '{' + root.getAttribute('targetNamespace') + '}' + binding.getAttribute('name');
      if (bindingIds.has(bindingId)) throw new Error('duplicate_wsdl2_binding');
      bindingIds.add(bindingId);
      const boundOperations = new Set();
      for (const bound of children(binding, WSDL, 'operation')) {
        const reference = qname(bound, bound.getAttribute('ref'));
        if (boundOperations.has(reference)) throw new Error('duplicate_wsdl2_binding_operation');
        boundOperations.add(reference);
        const operation = components.operations.get(reference);
        if (!operation) throw new Error('unresolved_wsdl2_operation');
        const pattern = operation.getAttribute('pattern') || 'http://www.w3.org/ns/wsdl/in-out';
        const labels = patterns.get(pattern);
        const path = '/soap/' + encodeURIComponent(reference);
        for (const direction of ['input', 'output']) {
          const messages = children(operation, WSDL, direction);
          const overrides = children(bound, WSDL, direction);
          if (labels && messages.length !== (labels[direction] ? 1 : 0))
            throw new Error('wsdl2_message_pattern_mismatch');
          const messageLabels = new Map();
          for (const message of messages) {
            const label = message.getAttribute('messageLabel') || labels?.[direction];
            if (!label || messageLabels.has(label))
              throw new Error('ambiguous_wsdl2_message_label');
            if (labels && label !== labels[direction])
              throw new Error('wsdl2_message_label_mismatch');
            messageLabels.set(label, message);
          }
          const boundLabels = new Map();
          for (const override of overrides) {
            const label = override.getAttribute('messageLabel') || labels?.[direction];
            if (!label || !messageLabels.has(label))
              throw new Error('unresolved_wsdl2_message_override');
            if (boundLabels.has(label)) throw new Error('duplicate_wsdl2_message_override');
            boundLabels.set(label, override);
          }
          for (const [label, message] of messageLabels) {
            const override = boundLabels.get(label);
            const element = message.getAttribute('element');
            const contentModel = ['#none', '#any', '#other'].includes(element)
              ? element
              : element
                ? '#element'
                : '#other';
            const models = override ? headerModels(override) : [];
            bindings.push({
              bindingId,
              name: operation.getAttribute('name'),
              path,
              direction,
              messageLabel: label,
              envelope,
              elements: contentModel === '#element' ? [qname(message, element)] : [],
              contentModel,
              headerModels: models,
              headerElements: models.map((header) => header.element),
              action: bound.getAttributeNS(SOAP, 'action') || '',
              supported:
                baseSupported &&
                Boolean(labels) &&
                !requiredModule(bound) &&
                (!override || !requiredModule(override)) &&
                contentModel !== '#other',
              reason: labels ? 'wsdl2_soap_message_binding' : 'wsdl2_message_pattern_unavailable',
            });
          }
        }
        for (const referenceNode of children(operation, WSDL, 'outfault')) {
          const name = qname(referenceNode, referenceNode.getAttribute('ref'));
          const fault = components.faults.get(name);
          const boundFaults = children(binding, WSDL, 'fault').filter(
            (node) => qname(node, node.getAttribute('ref')) === name,
          );
          if (!fault || boundFaults.length !== 1) throw new Error('unresolved_wsdl2_fault');
          const boundFault = boundFaults[0],
            element = fault.getAttribute('element');
          const models = headerModels(boundFault);
          const code = boundFault.getAttributeNS(SOAP, 'code');
          const subcodes = boundFault.getAttributeNS(SOAP, 'subcodes');
          bindings.push({
            bindingId,
            name: operation.getAttribute('name'),
            path,
            direction: 'fault',
            envelope,
            elements: element && !element.startsWith('#') ? [qname(fault, element)] : [],
            headerModels: models,
            headerElements: models.map((header) => header.element),
            faultCode: code && code !== '#any' ? qname(boundFault, code) : undefined,
            faultSubcodes:
              subcodes && subcodes !== '#any'
                ? subcodes
                    .trim()
                    .split(/\s+/)
                    .map((value) => qname(boundFault, value))
                : undefined,
            supported:
              baseSupported &&
              Boolean(labels) &&
              !requiredModule(bound) &&
              !requiredModule(boundFault) &&
              Boolean(element && !element.startsWith('#')),
            reason: 'wsdl2_soap_fault_binding',
          });
        }
      }
    }
  }
  return bindings;
}
