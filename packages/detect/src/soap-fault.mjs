const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
export function readSoapFault(fault, namespace, qname) {
  const elements = (node) => Array.from(node.childNodes).filter((child) => child.nodeType === 1);
  const textOnly = (node) => !elements(node).length;
  const fail = () => {
    throw new Error('soap_fault_structure_invalid');
  };
  const nodes = elements(fault),
    names = nodes.map((node) => node.localName);
  if (
    Array.from(fault.childNodes).some(
      (node) => [3, 4].includes(node.nodeType) && node.nodeValue.trim(),
    )
  )
    fail();
  let detail;
  let faultCode;
  const subcodes = [];
  if (namespace === SOAP11) {
    if (
      nodes.some((node) => node.namespaceURI) ||
      names[0] !== 'faultcode' ||
      names[1] !== 'faultstring' ||
      new Set(names).size !== names.length ||
      names.some((name) => !['faultcode', 'faultstring', 'faultactor', 'detail'].includes(name)) ||
      (names.includes('faultactor') && names.indexOf('faultactor') !== 2) ||
      (names.includes('detail') && names.at(-1) !== 'detail') ||
      !textOnly(nodes[0]) ||
      !textOnly(nodes[1])
    )
      fail();
    faultCode = qname(nodes[0], nodes[0].textContent.trim());
    const actor = nodes.find((node) => node.localName === 'faultactor');
    if (actor && (!textOnly(actor) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(actor.textContent.trim())))
      fail();
    detail = nodes.find((node) => node.localName === 'detail');
  } else if (namespace === SOAP12) {
    if (
      nodes.some((node) => node.namespaceURI !== namespace) ||
      names[0] !== 'Code' ||
      names[1] !== 'Reason' ||
      new Set(names).size !== names.length ||
      names.some((name) => !['Code', 'Reason', 'Node', 'Role', 'Detail'].includes(name)) ||
      names.join(',') !==
        ['Code', 'Reason', 'Node', 'Role', 'Detail']
          .filter((name) => names.includes(name))
          .join(',')
    )
      fail();
    let code = nodes[0],
      depth = 0;
    while (code) {
      const content = elements(code);
      if (
        ++depth > 64 ||
        content.length < 1 ||
        content.length > 2 ||
        content[0].localName !== 'Value' ||
        content[0].namespaceURI !== namespace ||
        !textOnly(content[0]) ||
        (content[1] &&
          (content[1].localName !== 'Subcode' || content[1].namespaceURI !== namespace))
      )
        fail();
      const value = qname(content[0], content[0].textContent.trim());
      if (depth === 1) faultCode = value;
      else subcodes.push(value);
      if (
        depth === 1 &&
        !['VersionMismatch', 'MustUnderstand', 'DataEncodingUnknown', 'Sender', 'Receiver'].some(
          (name) => value === '{' + namespace + '}' + name,
        )
      )
        fail();
      code = content[1];
    }
    const reasons = elements(nodes[1]),
      languages = new Set();
    if (!reasons.length) fail();
    for (const reason of reasons) {
      const language = reason.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang');
      if (
        reason.localName !== 'Text' ||
        reason.namespaceURI !== namespace ||
        !textOnly(reason) ||
        !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) ||
        languages.has(language.toLowerCase())
      )
        fail();
      languages.add(language.toLowerCase());
    }
    for (const node of nodes.filter((node) => ['Node', 'Role'].includes(node.localName)))
      if (!textOnly(node) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(node.textContent.trim())) fail();
    detail = nodes.find((node) => node.localName === 'Detail');
  } else fail();
  if (
    detail &&
    Array.from(detail.childNodes).some(
      (node) => [3, 4].includes(node.nodeType) && node.nodeValue.trim(),
    )
  )
    fail();
  return { elements: detail ? elements(detail) : [], code: faultCode, subcodes };
}
