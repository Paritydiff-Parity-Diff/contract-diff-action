import { MIMEType } from 'node:util';
const invalid = () => new Error('mime_wire_invalid');
export function parseMimeType(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x09\x20-\x7e]/.test(value))
    throw invalid();
  const names = new Set();
  let position = value.indexOf(';');
  while (position >= 0 && position < value.length) {
    position++;
    while (/[ \t]/.test(value[position] ?? '\0')) position++;
    if (position === value.length) break;
    const start = position;
    while (position < value.length && !/[=; \t]/.test(value[position])) position++;
    const name = value.slice(start, position).toLowerCase();
    while (/[ \t]/.test(value[position] ?? '\0')) position++;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || value[position++] !== '=' || names.has(name))
      throw invalid();
    names.add(name);
    while (/[ \t]/.test(value[position] ?? '\0')) position++;
    if (value[position] === '"') {
      let closed = false;
      position++;
      while (position < value.length) {
        if (value[position] === '\\') {
          position += 2;
          continue;
        }
        if (value[position++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw invalid();
      while (/[ \t]/.test(value[position] ?? '\0')) position++;
      if (position < value.length && value[position] !== ';') throw invalid();
    } else {
      const start = position;
      while (position < value.length && value[position] !== ';') position++;
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value.slice(start, position).trim())) throw invalid();
    }
  }
  try {
    return new MIMEType(value);
  } catch {
    throw invalid();
  }
}
export function matchesMimeType(pattern, actual) {
  const declared = parseMimeType(pattern);
  if (declared.type === '*' && declared.subtype !== '*') return false;
  if (
    (declared.type !== '*' && declared.type !== actual.type) ||
    (declared.subtype !== '*' && declared.subtype !== actual.subtype)
  )
    return false;
  for (const [name, value] of declared.params) {
    const found = actual.params.get(name);
    if (
      found === null ||
      (name === 'charset' ? found.toLowerCase() !== value.toLowerCase() : found !== value)
    )
      return false;
  }
  return true;
}
function decodeTransfer(bytes, encoding) {
  if (!encoding || encoding === 'binary' || encoding === '8bit') return bytes;
  if (encoding === '7bit') {
    if (bytes.some((byte) => byte > 127)) throw invalid();
    return bytes;
  }
  if (encoding === 'base64') {
    const text = bytes.toString('ascii');
    if (bytes.some((byte) => byte > 127) || /[^A-Za-z0-9+/=\r\n\t ]/.test(text)) throw invalid();
    const packed = text.replace(/[\r\n\t ]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packed))
      throw invalid();
    const decoded = Buffer.from(packed, 'base64');
    if (decoded.toString('base64') !== packed) throw invalid();
    return decoded;
  }
  if (encoding === 'quoted-printable') {
    const text = bytes.toString('latin1').replace(/[ \t]+(?=\r\n|$)/g, ''),
      output = [];
    if (/\r(?!\n)|(?<!\r)\n/.test(text)) throw invalid();
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '=') {
        if (text.slice(index + 1, index + 3) === '\r\n') {
          index += 2;
          continue;
        }
        const pair = text.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(pair)) throw invalid();
        output.push(parseInt(pair, 16));
        index += 2;
      } else {
        const byte = text.charCodeAt(index);
        if (byte > 126 || (byte < 32 && ![9, 10, 13].includes(byte))) throw invalid();
        output.push(byte);
      }
    }
    return Buffer.from(output);
  }
  throw Object.assign(new Error('mime_transfer_encoding_unavailable'), { available: false });
}
export function decodeMimeParts(input, contentType) {
  const bytes = Buffer.from(input),
    type = parseMimeType(contentType),
    boundary = type.params.get('boundary');
  if (
    type.type !== 'multipart' ||
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9a-z'()+_,./:=? -]+$/i.test(boundary) ||
    boundary.endsWith(' ')
  )
    throw invalid();
  if (bytes.length > 1024 * 1024)
    throw Object.assign(new Error('mime_wire_resource_limit'), { available: false });
  const marker = Buffer.from('--' + boundary),
    parts = [],
    ids = new Set();
  let headerBytes = 0;
  const delimiter = (from) => {
    let at = bytes.indexOf(marker, from);
    while (at >= 0) {
      if (at === 0 || (at >= 2 && bytes[at - 2] === 13 && bytes[at - 1] === 10)) {
        let end = at + marker.length,
          closing = false;
        if (bytes[end] === 45 && bytes[end + 1] === 45) {
          closing = true;
          end += 2;
        }
        while (bytes[end] === 32 || bytes[end] === 9) end++;
        if ((end === bytes.length && closing) || (bytes[end] === 13 && bytes[end + 1] === 10))
          return { at, end: end === bytes.length ? end : end + 2, closing };
      }
      at = bytes.indexOf(marker, at + 1);
    }
    return undefined;
  };
  let current = delimiter(0);
  if (!current) throw invalid();
  while (!current.closing) {
    if (parts.length >= 64)
      throw Object.assign(new Error('mime_wire_resource_limit'), { available: false });
    const emptyHeaders = bytes[current.end] === 13 && bytes[current.end + 1] === 10;
    const headerEnd = emptyHeaders ? current.end : bytes.indexOf('\r\n\r\n', current.end, 'ascii');
    if (
      headerEnd < 0 ||
      headerEnd - current.end > 16384 ||
      (headerBytes += headerEnd - current.end) > 65536
    )
      throw invalid();
    const header = bytes.subarray(current.end, headerEnd).toString('latin1');
    if (/\r(?!\n)|(?<!\r)\n|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(header)) throw invalid();
    const headers = new Map(),
      rawHeaders = [];
    for (const line of header.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
      if (!line) continue;
      const colon = line.indexOf(':'),
        name = line.slice(0, colon).toLowerCase();
      if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw invalid();
      const value = line.slice(colon + 1).trim();
      if (headers.has(name) && name.startsWith('content-')) throw invalid();
      rawHeaders.push([name, value]);
      if (!headers.has(name)) headers.set(name, value);
    }
    const bodyStart = headerEnd + (emptyHeaders ? 2 : 4);
    const next = delimiter(bodyStart);
    if (!next || next.at < bodyStart + 2) throw invalid();
    const raw = bytes.subarray(bodyStart, next.at - 2),
      id = headers.get('content-id');
    if (id !== undefined && !/^<[^<>\s\x00-\x1f\x7f-\xff]+>$/.test(id)) throw invalid();
    if (id) {
      if (ids.has(id)) throw invalid();
      ids.add(id);
    }
    const media = headers.get('content-type') ?? 'text/plain;charset=us-ascii';
    parseMimeType(media);
    parts.push({
      headers,
      rawHeaders,
      contentType: media,
      bytes: decodeTransfer(raw, headers.get('content-transfer-encoding')?.toLowerCase()),
    });
    current = next;
  }
  return parts;
}
