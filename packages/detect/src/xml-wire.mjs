import { decodeTextBytes, textEncoding } from './text-wire.mjs';
import { parseXml11, xmlVersion } from './xml11.mjs';
const invalid = () => new Error('xml_wire_encoding_invalid');
const unavailable = () =>
  Object.assign(new Error('xml_wire_encoding_unavailable'), { available: false });
const declaration = (text) => {
  if (!/^<\?xml\s/.test(text)) return undefined;
  const close = text.indexOf('?>');
  if (close < 0 || close > 4096) throw unavailable();
  return text.slice(0, close + 2);
};
const declaredEncoding = (text) =>
  /\sencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(declaration(text) ?? '')?.[2];
export function decodeXmlBytes(input, media) {
  const bytes = Buffer.from(input);
  if (bytes.length > 1024 * 1024)
    throw Object.assign(new Error('xml_wire_resource_limit'), { available: false });
  const bom = bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))
    ? 'utf-32be'
    : bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))
      ? 'utf-32le'
      : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? 'utf-8'
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? 'utf-16be'
            : undefined;
  const charset = media?.params.get('charset');
  let encoding;
  if (bom) encoding = bom;
  else if (charset) encoding = charset;
  else {
    const guessed = bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0, 0x3c]))
      ? 'utf-32be'
      : bytes.subarray(0, 4).equals(Buffer.from([0x3c, 0, 0, 0]))
        ? 'utf-32le'
        : bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0
          ? 'utf-16le'
          : bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f
            ? 'utf-16be'
            : undefined;
    const head = guessed
      ? decodeTextBytes(bytes, guessed)
      : bytes.subarray(0, 4096).toString('latin1');
    encoding = declaredEncoding(head) ?? 'utf-8';
    if (guessed && textEncoding(encoding) !== guessed) throw invalid();
  }
  if (!textEncoding(encoding)) throw unavailable();
  const text = decodeTextBytes(bytes, encoding),
    header = declaration(text);
  if (xmlVersion(text) === '1.1') parseXml11(text);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('xml_wire_dtd_rejected');
  return header
    ? header.replace(/\sencoding\s*=\s*(["'])[^"']*\1/, ' encoding="UTF-8"') +
        text.slice(header.length)
    : text;
}
