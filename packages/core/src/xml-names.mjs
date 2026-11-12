const start =
  '[A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}]';
const rest =
  '[A-Z_a-z0-9.\\u002d\\u00b7\\u0300-\\u036f\\u203f-\\u2040\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}]';
// XML NameChar includes individual combining code points.
// eslint-disable-next-line no-misleading-character-class
export const xmlNcName = new RegExp('^' + start + rest + '*$', 'u');
// eslint-disable-next-line no-misleading-character-class
export const xmlQName = new RegExp('^' + start + rest + '*(?::' + start + rest + '*)?$', 'u');
