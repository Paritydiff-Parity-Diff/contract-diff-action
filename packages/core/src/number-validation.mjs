function decimalText(text) {
  if (typeof text !== 'string' || text.length > 1000) return undefined;
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!match) return undefined;
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return undefined;
  let numerator = BigInt(match[2] + (match[3] ?? '')) * (match[1] ? -1n : 1n),
    denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  return { numerator, denominator };
}
function decimal(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? decimalText(String(value))
    : undefined;
}
export function parseLosslessJson(text) {
  try {
    const result = JSON.parse(text, (_key, value, context) => {
      if (typeof value === 'number') {
        const a = decimalText(context?.source),
          b = decimal(value);
        if (!a || !b || a.numerator * b.denominator !== b.numerator * a.denominator)
          throw new Error('json_number_precision_unavailable');
      }
      return value;
    });
    const stack = [];
    let nodes = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '{' || character === '[') {
        if (++nodes > 100000 || stack.length >= 100) throw new Error('json_structure_limit');
        stack.push(character === '{' ? { keys: new Set(), expectKey: true } : {});
      } else if (character === '}' || character === ']') stack.pop();
      else if (character === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
      else if (character === '"') {
        const start = index++;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === '\\') index++;
          index++;
        }
        const object = stack.at(-1);
        if (object?.keys && object.expectKey) {
          if (++nodes > 100000) throw new Error('json_structure_limit');
          const key = JSON.parse(text.slice(start, index + 1));
          if (object.keys.has(key)) throw new Error('json_duplicate_property');
          object.keys.add(key);
          object.expectKey = false;
        }
      }
    }
    return result;
  } catch (error) {
    throw new Error(
      [
        'json_number_precision_unavailable',
        'json_duplicate_property',
        'json_structure_limit',
      ].includes(error.message)
        ? error.message
        : 'invalid_json',
    );
  }
}
export function isExactMultipleOf(value, multiple) {
  if (typeof multiple !== 'number' || multiple <= 0) return false;
  const a = decimal(value),
    b = decimal(multiple);
  return Boolean(a && b && (a.numerator * b.denominator) % (a.denominator * b.numerator) === 0n);
}
export function exactCommonMultiple(values) {
  if (!Array.isArray(values) || !values.length || values.length > 1000) return undefined;
  const gcd = (a, b) => {
    while (b) [a, b] = [b, a % b];
    return a;
  };
  let numerator = 1n,
    denominator;
  for (const value of values) {
    const fraction = decimal(value);
    if (!fraction || fraction.numerator <= 0n) return undefined;
    const divisor = gcd(fraction.numerator, fraction.denominator);
    const n = fraction.numerator / divisor,
      d = fraction.denominator / divisor;
    numerator = (numerator / gcd(numerator, n)) * n;
    denominator = denominator === undefined ? d : gcd(denominator, d);
    if (numerator.toString().length > 1200) return undefined;
  }
  let rest = denominator,
    twos = 0,
    fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }
  if (rest !== 1n) return undefined;
  const scale = Math.max(twos, fives);
  const digits = numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  const value = Number(String(digits) + 'e-' + scale),
    represented = decimal(value);
  return value > 0 &&
    represented &&
    represented.numerator * denominator === numerator * represented.denominator
    ? value
    : undefined;
}
export function installExactMultipleOf(validator) {
  validator.removeKeyword('multipleOf');
  validator.addKeyword({
    keyword: 'multipleOf',
    type: 'number',
    schemaType: 'number',
    errors: false,
    metaSchema: { type: 'number', exclusiveMinimum: 0 },
    validate: (schema, value) => isExactMultipleOf(value, schema),
  });
}
