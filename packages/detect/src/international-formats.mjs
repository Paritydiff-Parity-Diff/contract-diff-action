import tr46 from 'tr46';
import { isIP } from 'node:net';

const disallowed = new Set([
  0x0640, 0x07fa, 0x302e, 0x302f, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b,
]);
const greek = /\p{Script=Greek}/u,
  hebrew = /\p{Script=Hebrew}/u;
const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const letterDigit = /^[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]$/u;
const unstable = /\p{Changes_When_NFKC_Casefolded}/u;
const ignorable = /[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Noncharacter_Code_Point}]/u;
const contextualOrException = new Set([
  0x00b7, 0x00df, 0x03c2, 0x0375, 0x05f3, 0x05f4, 0x06fd, 0x06fe, 0x0f0b, 0x200c, 0x200d, 0x3007,
  0x30fb,
]);
function protocolCodePoint(char) {
  const cp = char.codePointAt(0);
  if (disallowed.has(cp)) return false;
  if (contextualOrException.has(cp) || /^[a-z0-9-]$/.test(char)) return true;
  if (
    unstable.test(char) ||
    ignorable.test(char) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0x1d100 && cp <= 0x1d24f) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff)
  )
    return false;
  return letterDigit.test(char);
}
function contextual(label) {
  const chars = [...label];
  if (!chars.length || /^\p{Mark}/u.test(label) || !chars.every(protocolCodePoint)) return false;
  if (label.startsWith('-') || label.endsWith('-') || label.slice(2, 4) === '--') return false;
  if (/[\u0660-\u0669]/u.test(label) && /[\u06f0-\u06f9]/u.test(label)) return false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === '\u00b7' && (chars[index - 1] !== 'l' || chars[index + 1] !== 'l')) return false;
    if (char === '\u0375' && !greek.test(chars[index + 1] ?? '')) return false;
    if (['\u05f3', '\u05f4'].includes(char) && !hebrew.test(chars[index - 1] ?? '')) return false;
    if (char === '\u30fb' && !japanese.test(label.replaceAll('\u30fb', ''))) return false;
  }
  return true;
}
export function idnHostname(value) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const options = {
    checkBidi: true,
    checkHyphens: true,
    checkJoiners: true,
    useSTD3ASCIIRules: true,
    verifyDNSLength: true,
    transitionalProcessing: false,
    ignoreInvalidPunycode: false,
  };
  try {
    const ascii = tr46.toASCII(value, options),
      decoded = tr46.toUnicode(value, options);
    if (!ascii || decoded.error || ascii.startsWith('.') || ascii.endsWith('.')) return false;
    return decoded.domain.split('.').every(contextual);
  } catch {
    return false;
  }
}

const scalar = (value) => {
  const cp = value.codePointAt(0);
  return cp < 0xd800 || cp > 0xdfff;
};
const atom = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/;
export function idnEmail(value) {
  if (typeof value !== 'string' || value.length > 4096 || ![...value].every(scalar)) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  const local = value.slice(0, at),
    domain = value.slice(at + 1);
  if (Buffer.byteLength(local) > 64 || !domain || domain.endsWith('.')) return false;
  if (local.startsWith('"')) {
    if (!local.endsWith('"') || local.length < 2) return false;
    const chars = [...local.slice(1, -1)];
    for (let index = 0; index < chars.length; index++) {
      const cp = chars[index].codePointAt(0);
      if (chars[index] === '\\') {
        const next = chars[++index]?.codePointAt(0);
        if (next === undefined || next < 32 || next > 126) return false;
      } else if (cp < 32 || cp === 34 || cp === 127) return false;
    }
  } else if (
    local
      .split('.')
      .some(
        (part) =>
          !part || ![...part].every((char) => atom.test(char) || char.codePointAt(0) >= 128),
      )
  )
    return false;
  if (domain.startsWith('[') && domain.endsWith(']')) {
    const address = domain.slice(1, -1);
    return /^IPv6:/i.test(address)
      ? isIP(address.slice(5)) === 6
      : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) &&
          address.split('.').every((part) => Number(part) <= 255);
  }
  return idnHostname(domain.normalize('NFC'));
}

const unreserved = /^[A-Za-z0-9._~-]$/,
  subdelimiter = /^[!$&'()*+,;=]$/;
const ucschar = (cp) =>
  (cp >= 0xa0 && cp <= 0xd7ff) ||
  (cp >= 0xf900 && cp <= 0xfdcf) ||
  (cp >= 0xfdf0 && cp <= 0xffef) ||
  (cp >= 0x10000 && cp <= 0xdfffd && (cp & 0xffff) < 0xfffe) ||
  (cp >= 0xe1000 && cp <= 0xefffd);
const privateChar = (cp) =>
  (cp >= 0xe000 && cp <= 0xf8ff) ||
  (cp >= 0xf0000 && cp <= 0xffffd) ||
  (cp >= 0x100000 && cp <= 0x10fffd);
function component(value, extra = '', privateUse = false) {
  const chars = [...value];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === '%') {
      if (!/^[0-9a-f]{2}$/i.test(chars.slice(index + 1, index + 3).join(''))) return false;
      index += 2;
    } else if (
      !unreserved.test(char) &&
      !subdelimiter.test(char) &&
      !extra.includes(char) &&
      !ucschar(char.codePointAt(0)) &&
      !(privateUse && privateChar(char.codePointAt(0)))
    )
      return false;
  }
  return true;
}
export function iriReference(value, absolute = false) {
  if (typeof value !== 'string') return false;
  if (value.length > 65536) throw new Error('schema_format_resource_limit');
  const parts = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?([^?#]*)(?:\?([^#]*))?(?:#([^#]*))?$/.exec(value);
  if (!parts || (absolute && !parts[1])) return false;
  let path = parts[2];
  if (path.startsWith('//')) {
    const end = path.indexOf('/', 2),
      authority = path.slice(2, end < 0 ? undefined : end);
    path = end < 0 ? '' : path.slice(end);
    const at = authority.lastIndexOf('@'),
      userinfo = at < 0 ? '' : authority.slice(0, at),
      hostPort = authority.slice(at + 1);
    if (!component(userinfo, ':')) return false;
    if (hostPort.startsWith('[')) {
      const close = hostPort.indexOf(']');
      if (close < 0 || !/^(?::[0-9]*)?$/.test(hostPort.slice(close + 1))) return false;
      const host = hostPort.slice(1, close);
      if (isIP(host) !== 6 && !/^v[0-9a-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/i.test(host))
        return false;
    } else {
      const split = hostPort.lastIndexOf(':'),
        host = split < 0 ? hostPort : hostPort.slice(0, split);
      if (split >= 0 && !/^[0-9]*$/.test(hostPort.slice(split + 1))) return false;
      if (!component(host)) return false;
    }
  } else if (!parts[1] && path.split('/')[0].includes(':')) return false;
  return (
    component(path, ':@/') &&
    component(parts[3] ?? '', ':@/?', true) &&
    component(parts[4] ?? '', ':@/?')
  );
}
export function installInternationalFormats(ajv) {
  for (const [name, validate] of Object.entries({
    'idn-hostname': idnHostname,
    'idn-email': idnEmail,
    iri: (value) => iriReference(value, true),
    'iri-reference': (value) => iriReference(value),
  }))
    ajv.addFormat(name, { type: 'string', validate });
}
