const unavailable = () =>
  Object.assign(new Error('text_encoding_unavailable'), { available: false });
export function textEncoding(value) {
  const name = String(value).trim().toLowerCase();
  const encodings = {
    'utf-8': 'utf-8',
    utf8: 'utf-8',
    'us-ascii': 'ascii',
    ascii: 'ascii',
    'iso-8859-1': 'latin1',
    'iso_8859-1': 'latin1',
    latin1: 'latin1',
    'windows-1252': 'windows-1252',
    cp1252: 'windows-1252',
    'utf-16': 'utf-16',
    utf16: 'utf-16',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
    'utf-32': 'utf-32',
    utf32: 'utf-32',
    'utf-32le': 'utf-32le',
    'utf-32be': 'utf-32be',
  };
  return Object.hasOwn(encodings, name) ? encodings[name] : undefined;
}
export function decodeTextBytes(input, encoding = 'utf-8') {
  const bytes = Buffer.from(input),
    kind = textEncoding(encoding);
  if (!kind) throw unavailable();
  if (bytes.length > 1024 * 1024)
    throw Object.assign(new Error('text_wire_resource_limit'), { available: false });
  if (kind.startsWith('utf-32')) {
    let little = kind === 'utf-32le',
      offset = 0;
    const littleBom = bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])),
      bigBom = bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255]));
    if (kind === 'utf-32') {
      if (!littleBom && !bigBom) throw new Error('text_utf32_bom_required');
      little = littleBom;
    }
    if (littleBom || bigBom) {
      if (little !== littleBom) throw new Error('text_encoding_invalid');
      offset = 4;
    }
    if (bytes.length % 4) throw new Error('text_encoding_invalid');
    const output = [];
    for (; offset < bytes.length; offset += 4) {
      const code = little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new Error('text_encoding_invalid');
      output.push(String.fromCodePoint(code));
    }
    return output.join('');
  }
  if (kind === 'latin1') return bytes.toString('latin1');
  if (kind === 'windows-1252') {
    const controls = [
      0x20ac,
      null,
      0x201a,
      0x0192,
      0x201e,
      0x2026,
      0x2020,
      0x2021,
      0x02c6,
      0x2030,
      0x0160,
      0x2039,
      0x0152,
      null,
      0x017d,
      null,
      null,
      0x2018,
      0x2019,
      0x201c,
      0x201d,
      0x2022,
      0x2013,
      0x2014,
      0x02dc,
      0x2122,
      0x0161,
      0x203a,
      0x0153,
      null,
      0x017e,
      0x0178,
    ];
    const output = [];
    for (const byte of bytes) {
      const code = byte >= 0x80 && byte <= 0x9f ? controls[byte - 0x80] : byte;
      if (code === null) throw new Error('text_encoding_invalid');
      output.push(String.fromCodePoint(code));
    }
    return output.join('');
  }
  if (kind === 'ascii') {
    if (bytes.some((value) => value > 127)) throw new Error('text_encoding_invalid');
    return bytes.toString('ascii');
  }
  if (kind === 'utf-16') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    throw new Error('text_utf16_bom_required');
  }
  return new TextDecoder(kind, { fatal: true }).decode(bytes);
}
