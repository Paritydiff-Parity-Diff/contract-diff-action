import { idnEmail, idnHostname, iriReference } from './international-formats.mjs';

const ascii = (value) => [...value].every((char) => char.codePointAt(0) <= 127);
function date(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return false;
  const [, year, month, day] = parts.map(Number),
    leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function time(value) {
  const parts = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [, hour, minute, second, sign, offsetHour, offsetMinute] = parts,
    h = Number(hour),
    m = Number(minute),
    s = Number(second),
    oh = Number(offsetHour ?? 0),
    om = Number(offsetMinute ?? 0);
  if (h > 23 || m > 59 || s > 60 || oh > 23 || om > 59) return false;
  const offset = (sign === '-' ? -1 : 1) * (oh * 60 + om);
  return s !== 60 || (h * 60 + m - offset + 1440) % 1440 === 1439;
}
const durationTime = 'T(?:[0-9]+H(?:[0-9]+M(?:[0-9]+S)?)?|[0-9]+M(?:[0-9]+S)?|[0-9]+S)';
const duration = new RegExp(
  '^P(?:[0-9]+W|(?:[0-9]+Y(?:[0-9]+M(?:[0-9]+D)?)?|[0-9]+M(?:[0-9]+D)?|[0-9]+D)(?:' +
    durationTime +
    ')?|' +
    durationTime +
    ')$',
);
const varchar = '(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})',
  varspec = new RegExp('^' + varchar + '(?:\\.?' + varchar + ')*(?::[1-9][0-9]{0,3}|\\*)?$');
function template(value) {
  for (let index = 0; index < value.length;) {
    const char = String.fromCodePoint(value.codePointAt(index));
    if (char === '{') {
      const end = value.indexOf('}', index + 1);
      if (end < 0) return false;
      const expression = value.slice(index + 1, end).replace(/^[+#./;?&=,!@|]/, '');
      if (!expression.split(',').every((variable) => varspec.test(variable))) return false;
      index = end + 1;
    } else if (char === '%') {
      if (!/^[A-Fa-f0-9]{2}$/.test(value.slice(index + 1, index + 3))) return false;
      index += 3;
    } else {
      const cp = char.codePointAt(0);
      if (
        cp < 0x80
          ? !/^[!\x23-\x24\x26-\x3b\x3d\x3f-\x5b\x5d\x5f\x61-\x7a\x7e]$/.test(char)
          : !iriReference('?' + char)
      )
        return false;
      index += char.length;
    }
  }
  return true;
}
export function installStandardFormats(ajv) {
  const formats = {
    date,
    time,
    'date-time': (value) => {
      const parts = /^(.{10})[tT](.+)$/.exec(value);
      return Boolean(parts && date(parts[1]) && time(parts[2]));
    },
    duration: (value) => duration.test(value),
    email: (value) => ascii(value) && idnEmail(value),
    hostname: (value) => ascii(value) && idnHostname(value),
    uri: (value) => ascii(value) && iriReference(value, true),
    'uri-reference': (value) => ascii(value) && iriReference(value),
    'uri-template': template,
    uuid: (value) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value),
    regex: (value) => {
      try {
        new RegExp(value, 'u');
        return true;
      } catch {
        return false;
      }
    },
  };
  for (const [name, validate] of Object.entries(formats))
    ajv.addFormat(name, {
      type: 'string',
      validate: (value) => {
        if (value.length > 65536) throw new Error('schema_format_resource_limit');
        return validate(value);
      },
    });
}
